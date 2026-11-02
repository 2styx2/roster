"""The askpass channel: how a password Session's ssh gets its password from `roster serve` (ADR 0002).

Server side (Channel, run by serve): a Unix socket in a fresh user-only directory, or on Windows a named pipe only
this user can open (roster/winpipe.py). session.prepare mints a
one-time token for one Host's ssh Login; the token is good once, for TTL seconds, and until vault.lock.
quick.prepare mints one for a password the user typed (Typed, Quick Connect): the token holds it as is, and it goes
with the token (spent, expired and pruned, or vault.lock).
Helper side (main, run by ssh as SSH_ASKPASS with the prompt as argv[1]): answers only a Login password
prompt, by sending the token over the socket and printing the password ssh asked for.
Login reports (ticket 15, "Save to vault"): a Session whose typed password is held for saving runs ssh with
LocalCommand set to the channel's `logged-in` script, which ssh runs only once it has logged in. It reports the
Session's token, and serve counts that as a login with the typed password only if that token's password was the one
handed to ssh.

Wire format, one exchange per connection, then serve closes:
  helper: "TOKEN\\n"                   serve: "ok\\nPASSWORD", or "no CODE\\nREASON"
  helper: "prompt TOKEN PROMPT\\n"     serve: "no 36\\nREASON"   (a prompt the helper won't answer, reported
                                                               so serve can log it; the token isn't spent)
  helper: "login TOKEN\\n"             serve: "ok\\n" or "no\\n"   (the logged-in script: ssh has logged in)
REASON is safe to show in the terminal; CODE is one of errors.py's stable codes. The helper prints it as
the one line "roster askpass: [CODE] REASON" on stderr, which the app's classifier parses.

Stdlib only, and nothing else from roster (but winpipe, on Windows): ssh runs the helper for every prompt, it must
start fast and never load roster.yml.

On Windows ssh can't run a script as SSH_ASKPASS, only a program, so the helpers are the launchers pip and uv install
for roster's entry points roster-askpass and roster-askpass-login (pyproject.toml), found next to the Python serve
runs on.
"""

import os
import re
import secrets
import select
import shlex
import shutil
import socket
import struct
import sys
import sysconfig
import tempfile
import threading
import time

SOCKET_ENV, TOKEN_ENV = "ROSTER_ASKPASS_SOCKET", "ROSTER_ASKPASS_TOKEN"
LOGIN_ENV = "ROSTER_ASKPASS_LOGGED_IN"     # set only by the logged-in script, never by ssh or the app
WINDOWS = os.name == "nt"
TTL = 60.0                  # seconds a token lives; ROSTER_ASKPASS_TTL may shorten it (tests), never lengthen
REPLY_TIMEOUT = 30          # the helper waits this long for serve (a vault lookup can take a few seconds)
PROMPT_LIMIT = 300          # characters of an unexpected prompt that are reported (it comes from the Host)

# Stable codes (errors.py imports these; the rest of its codes arrive here inside Refused)
LOOKUP_FAILED = 35          # the lookup failed some other way
UNEXPECTED_PROMPT = 36      # the Host asked something other than the Login password
TOKEN_SPENT = 37            # the one-time token is used, expired or cleared by vault.lock
NO_SERVE = 38               # the helper couldn't reach `roster serve`

# ---------------------------------------------------------------- which prompts get the password

# Only these shapes, whole (case and runs of spaces ignored):
#   "user@host's password:"              ssh's password authentication
#   "password:", "(user@host) password:" keyboard-interactive (OpenSSH adds the prefix)
#   "password for user@host:"            some PAM stacks
# Everything else is refused - a host-key yes/no, a key passphrase, an OTP code, "(current) UNIX
# password:" or "New password:" from an expired-password change - so ssh fails instead of being
# handed the Login password for something that isn't the login.
PASSWORD_PROMPTS = re.compile(r"(?:\S+@\S+'s password|(?:\(\S+@\S+\) )?password|password for \S+):")


def is_password_prompt(prompt):
    return bool(PASSWORD_PROMPTS.fullmatch(" ".join(prompt.lower().split())))


class Refused(Exception):
    """Raised by a Channel's lookup: its message is safe to show in the terminal (never the secret), and
    code is its stable code (errors.py)."""

    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


def shown_prompt(prompt):
    """An unexpected prompt as one line, shortened: what may be logged and shown (it's the Host's text)."""
    text = " ".join("".join(c if c.isprintable() else " " for c in prompt).split())
    return text if len(text) <= PROMPT_LIMIT else text[:PROMPT_LIMIT] + "..."


def refused_prompt_reason(label, prompt):
    who = label or "the Host"
    return f"{who} asked something roster won't answer: '{shown_prompt(prompt)}' - log in by hand once to deal with it"


# ---------------------------------------------------------------- the helper ssh runs

def main(argv=None):
    """`roster askpass PROMPT`: print the Login password and exit 0, or print nothing and exit 1."""
    argv = sys.argv[1:] if argv is None else argv
    if os.environ.get(LOGIN_ENV) == "1" and not argv:
        return report_login()
    if len(argv) != 1:
        return 1
    prompt, path, token = argv[0], os.environ.get(SOCKET_ENV), os.environ.get(TOKEN_ENV)
    expected = is_password_prompt(prompt)
    if not path or not token:
        return 1 if expected else complain(UNEXPECTED_PROMPT, refused_prompt_reason(None, prompt))
    request = token if expected else f"prompt {token} {shown_prompt(prompt)}"
    try:
        reply = exchange(path, request, REPLY_TIMEOUT)
    except OSError as e:
        if not expected:
            return complain(UNEXPECTED_PROMPT, refused_prompt_reason(None, prompt))
        return complain(NO_SERVE, f"can't reach roster serve ({e.strerror or type(e).__name__})")
    status, _, body = reply.partition(b"\n")
    if status != b"ok" or not body or not expected:
        word, _, code = status.decode(errors="replace").partition(" ")
        reason = body.decode(errors="replace").strip() or "no answer"
        return complain(int(code) if code.isdigit() else UNEXPECTED_PROMPT if not expected else TOKEN_SPENT, reason)
    sys.stdout.buffer.write(body + b"\n")
    sys.stdout.flush()
    return 0


def report_login():
    """The logged-in script, run by ssh as its LocalCommand once it has logged in: tell serve, with the Session's
    token. It prints nothing (the terminal is the Session's) and never fails the Session."""
    path, token = os.environ.get(SOCKET_ENV), os.environ.get(TOKEN_ENV)
    if path and token:
        try:
            exchange(path, f"login {token}", 5)
        except OSError:
            pass
    return 0


def logged_in_main():
    """roster-askpass-login (Windows): the logged-in script as a program of its own, ssh's LocalCommand there."""
    return report_login()


def exchange(address, request, timeout):
    """Send serve one request line over the channel at ADDRESS (a socket path, or a pipe name on Windows) and return
    its whole answer."""
    if WINDOWS:
        from . import winpipe
        conn = winpipe.connect(address, timeout)
    else:
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.settimeout(timeout)
    with conn:
        if not WINDOWS:
            conn.connect(address)
        conn.settimeout(timeout)
        conn.sendall(request.encode() + b"\n")
        reply = b""
        while chunk := conn.recv(4096):
            reply += chunk
    return reply


def complain(code, reason):
    """The one line the terminal shows and the app's classifier reads; nothing goes to stdout, exit 1."""
    print(f"roster askpass: [{code}] {' '.join(reason.split())}", file=sys.stderr)
    return 1


# ---------------------------------------------------------------- serve's side

PREFIX = "roster-askpass-"
# A folder serve made: PREFIX, the pid of the serve that owns it, and mkdtemp's 8 random characters. Before ticket 113
# the name had no pid (PREFIX and the 8 characters only).
FOLDER = re.compile(r"roster-askpass-(?:(\d+)-)?[A-Za-z0-9_]{8}")
SERVE_FILES = {"socket", "askpass", "logged-in", "quick_known_hosts"}     # all serve ever puts in one
SOCKET_ROOM = 100           # a Unix socket's path is at most ~107 bytes
MAX_PID = 2**31 - 1         # a pid beyond this (or not above 0) isn't one: such a folder is left alone
SOCKET_SETTLE = 10          # s: a socket younger than this may be between bind() and listen(): never taken for dead
NO_SOCKET_AGE = 600         # s: a folder with no socket goes only once it's this old (a serve between mkdtemp and bind)


def runtime_bases():
    """Where serve may put its folder, in order: $XDG_RUNTIME_DIR, the temp dir, and /tmp when the temp dir's path
    leaves a socket no room."""
    bases = []
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if xdg and os.path.isdir(xdg):
        bases.append(xdg)
    bases.append(tempfile.gettempdir())
    if not WINDOWS and "/tmp" not in bases and os.path.isdir("/tmp"):
        bases.append("/tmp")
    return bases


def runtime_dir():
    """A fresh directory only this user can open (mkdtemp makes it 0700), named for this process, in the first of
    runtime_bases() where its socket's path fits."""
    prefix = f"{PREFIX}{os.getpid()}-"
    for base in runtime_bases():
        d = tempfile.mkdtemp(prefix=prefix, dir=base)
        if WINDOWS or len(os.path.join(d, "socket")) < SOCKET_ROOM:
            return d
        os.rmdir(d)
    raise OSError(f"no folder with room for a socket's path (TMPDIR is {tempfile.gettempdir()!r})")


def sweep(base):
    """Remove from BASE the askpass folders that a serve of this user left behind when it couldn't clean up (killed
    with SIGKILL, the interpreter crashed). A folder goes only if all of this holds: it's a real directory (a link
    is never followed or removed), it's this user's, it holds nothing but what serve puts there (no folder in it), the
    serve its name gives is gone, and its socket doesn't answer: no serve listens on it (a pid from another pid
    namespace, a container sharing /tmp, isn't taken for dead). A socket younger than SOCKET_SETTLE may not be
    listening yet, and a folder with no socket may belong to a serve that hasn't bound it yet, so those go only once
    they're older (SOCKET_SETTLE, NO_SOCKET_AGE). A folder from before ticket 113, with no pid in its name, goes only
    once its socket is dead. Each entry is reached through the folder's own descriptor, opened with
    O_NOFOLLOW, so nothing a link points at is touched. Never raises: what it can't tell, it leaves."""
    if WINDOWS:
        return
    try:
        dfd = os.open(base, os.O_RDONLY | os.O_DIRECTORY)
    except Exception:                       # noqa: BLE001 - never raises: serve starts whatever is here
        return
    try:
        for name in os.listdir(dfd):
            m = FOLDER.fullmatch(name)
            if not m:
                continue
            pid = int(m.group(1)) if m.group(1) else None
            if pid is not None and (pid == os.getpid() or not 0 < pid <= MAX_PID):
                continue                    # ours, or not a pid at all
            try:
                _sweep_one(base, dfd, name, pid)
            except Exception:               # noqa: BLE001 - what it can't tell, it leaves
                pass
    except Exception:                       # noqa: BLE001
        pass
    finally:
        os.close(dfd)


def _sweep_one(base, dfd, name, pid):
    import stat
    st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        return
    if pid is not None and process_alive(pid):
        return
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dfd)
    try:
        now = os.fstat(fd)
        if (now.st_dev, now.st_ino, now.st_uid) != (st.st_dev, st.st_ino, os.getuid()):
            return                          # replaced since: not the folder looked at
        entries = os.listdir(fd)
        if not set(entries) <= SERVE_FILES:
            return
        kinds = {e: os.stat(e, dir_fd=fd, follow_symlinks=False).st_mode for e in entries}
        if any(stat.S_ISDIR(m) for m in kinds.values()):
            return
        if "socket" in kinds:
            sock = os.stat("socket", dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISSOCK(sock.st_mode) or time.time() - sock.st_mtime < SOCKET_SETTLE \
                    or listening(os.path.join(base, name, "socket")):
                return                      # not a socket, maybe not listening yet, or a serve answers on it
        elif pid is None or time.time() - now.st_mtime < NO_SOCKET_AGE:
            return                          # an older serve's with nothing to tell, or one that may not have bound yet
        for e in entries:
            os.unlink(e, dir_fd=fd)         # a link is removed itself, never what it points at
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=dfd)


def process_alive(pid):
    """Is there a process PID (any user's)? POSIX only. True when it can't tell."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except (OSError, OverflowError, ValueError):
        return True                         # another user's (it exists), or not a pid the OS takes
    return True


def listening(path):
    """Does a serve listen on the socket at PATH? True when it can't tell (a path too long to reach, a timeout)."""
    if len(path) >= SOCKET_ROOM + 7:
        return True
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(1)
    try:
        probe.connect(path)
    except (ConnectionRefusedError, FileNotFoundError):
        return False
    except OSError:
        return True
    finally:
        probe.close()
    return True


def installed_helper(name):
    """Windows: the launcher of roster's entry point NAME (NAME.exe), next to the Python serve runs on (a venv's or a
    uv tool's Scripts), in that Python's scripts folders, or on PATH; None if it isn't installed."""
    dirs = [os.path.dirname(sys.executable), sysconfig.get_path("scripts")]
    try:
        dirs.append(sysconfig.get_path("scripts", f"{os.name}_user"))
    except KeyError:
        pass
    for d in dirs:
        exe = os.path.join(d or "", f"{name}.exe")
        if d and os.path.isfile(exe):
            return exe
    return shutil.which(name)


def ttl():
    try:
        return min(TTL, float(os.environ.get("ROSTER_ASKPASS_TTL", TTL)))
    except ValueError:
        return TTL


class Typed:
    """A password the user typed (Quick Connect, ticket 14), as a token's login: the Channel answers with it as is,
    without a lookup. It lives only as long as its token (spent, expired, or forgotten by vault.lock) and never
    shows in a repr, unless serve holds it for "Save to vault" (ticket 15). Then on_login is called (on the channel's
    thread) when the Session reports its login after this password was handed to ssh."""

    __slots__ = ("password", "on_login")

    def __init__(self, password, on_login=None):
        self.password, self.on_login = password, on_login

    def __repr__(self):
        return "Typed(...)"


class Channel:
    """serve's end. lookup(login) -> password, raising with a message safe to show when it can't;
    it runs on the channel's threads, so it must be thread-safe (providers.get_secret is). tick(), if given, runs on
    the accept loop when it wakes without a connection (serve forgets what it holds past its time there) and returns
    the seconds until it's due again, or None; nudge() wakes the loop to ask it again. It must be quick and never
    raise."""

    def __init__(self, lookup, log=None, tick=None):
        self.lookup, self.log, self.tick = lookup, log or (lambda msg: None), tick
        self.tick_due = None                 # time.monotonic() when tick() wants to run again (None: not until nudged)
        self.ttl = ttl()
        self.tokens = {}                     # token -> (login, label, expires at: time.monotonic())
        self.labels = {}                     # token -> (label, until): names a spent token's prompt reports
        self.handed = {}                     # token -> (Typed, label, until): handed to ssh, awaiting its login report
        self.lock = threading.Lock()
        for base in runtime_bases():         # what a serve that was killed outright left behind
            sweep(base)
        self.dir = runtime_dir()
        try:
            self._open()
        except BaseException:               # a failure, or a signal's SystemExit, before it's open: no folder left
            self._abandon()
            raise

    def _abandon(self):
        """Undo a half-done __init__: close what it opened and remove the folder."""
        server = getattr(self, "server", None)
        if server is not None:
            try:
                server.close()
            except OSError:
                pass
        for fd in (getattr(self, "wake_r", None), getattr(self, "wake_w", None)):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
        try:
            for name in os.listdir(self.dir):
                os.unlink(os.path.join(self.dir, name))
            os.rmdir(self.dir)
        except OSError:
            pass

    def _open(self):
        os.chmod(self.dir, 0o700)
        self.known_hosts = os.path.join(self.dir, "quick_known_hosts")   # Quick Connect's keys (serve writes it)
        self.stopping = threading.Event()
        self.problem = None                  # why password Sessions can't work here (Windows: no helper installed)
        if WINDOWS:
            self._open_pipe()
            return
        self.socket_path = os.path.join(self.dir, "socket")
        self.helper = os.path.join(self.dir, "askpass")
        self.login_helper = os.path.join(self.dir, "logged-in")         # ssh's LocalCommand (Save to vault)
        old = os.umask(0o177)                # the socket is created 0600
        try:
            self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.server.bind(self.socket_path)
        finally:
            os.umask(old)
        os.chmod(self.socket_path, 0o600)
        self.server.listen(8)
        # The accept loop sleeps until a connection, the next token's expiry, or a nudge (a new token, close()):
        # no polling, so an idle serve never wakes up for it.
        self.wake_r, self.wake_w = os.pipe()
        self.server.setblocking(False)       # select said ready, but a client may be gone by accept()
        write_helper(self.helper)
        write_helper(self.login_helper, login=True)
        self.thread = threading.Thread(target=self._accept_loop, name="askpass", daemon=True)
        self.thread.start()

    def _open_pipe(self):
        """Windows: a named pipe only this user can open, the installed helpers, and two threads: one accepts, one
        prunes what expires and runs tick() (on Linux the one select() loop does both)."""
        from . import winpipe
        self.socket_path = rf"\\.\pipe\roster-askpass-{secrets.token_hex(16)}"   # the pipe's name: env and logs
        self.helper = installed_helper("roster-askpass")
        self.login_helper = installed_helper("roster-askpass-login")
        if not self.helper or not self.login_helper:
            self.problem = ("roster-askpass.exe isn't installed next to roster, so ssh has no way to ask for a "
                            "password - reinstall roster (`uv tool install --force .` in the roster repo)")
        self.server = winpipe.Server(self.socket_path)
        self.wake = threading.Event()
        self.thread = threading.Thread(target=self._accept_pipe, name="askpass", daemon=True)
        self.thread.start()
        self.housekeeper = threading.Thread(target=self._housekeeping, name="askpass-expiry", daemon=True)
        self.housekeeper.start()

    def _accept_pipe(self):
        while not self.stopping.is_set():
            try:
                conn = self.server.accept()
            except OSError:
                if self.stopping.is_set():
                    return
                time.sleep(0.05)            # a client that came and went; never spin
                continue
            threading.Thread(target=self._answer, args=(conn,), daemon=True).start()

    def _housekeeping(self):
        while not self.stopping.is_set():
            self.wake.wait(self._next_expiry())
            self.wake.clear()
            if self.stopping.is_set():
                return
            self._prune()
            self._run_tick()

    # ---- tokens

    def mint(self, login, label):
        """A one-time token for LOGIN (whatever lookup takes); LABEL names it in serve's log."""
        token = secrets.token_urlsafe(32)
        with self.lock:
            now = time.monotonic()
            self.tokens = {t: v for t, v in self.tokens.items() if v[2] > now}   # drop expired ones
            self.tokens[token] = (login, label, now + self.ttl)
            self.labels = {t: v for t, v in self.labels.items() if v[1] > now}
            self.labels[token] = (label, now + 2 * self.ttl)
        self._nudge()                        # the accept loop may be sleeping with no expiry to wake for
        return token

    def _nudge(self):
        if WINDOWS:
            self.wake.set()
            return
        try:
            os.write(self.wake_w, b"x")
        except OSError:
            pass

    def nudge(self):
        """Something tick() looks after has changed (serve holds a new password): wake the accept loop to ask it."""
        self._nudge()

    def _next_expiry(self):
        """Seconds until something expires or tick() is due again (None: nothing to wake for)."""
        with self.lock:
            ends = [v[2] for v in self.tokens.values()] + [v[1] for v in self.labels.values()]
            ends += [v[2] for v in self.handed.values()]
        if self.tick_due is not None:
            ends.append(self.tick_due)
        return None if not ends else max(0.0, min(ends) - time.monotonic())

    def _run_tick(self):
        if self.tick is None:
            return
        try:
            wait = self.tick()
        except Exception as e:              # never let it stop the channel
            self.log(f"askpass: tick failed: {type(e).__name__}")
            wait = None
        self.tick_due = None if wait is None else time.monotonic() + max(0.0, wait)

    def _prune(self):
        """Drop what has expired: unused tokens, their labels, and typed passwords handed to ssh whose login report
        never came (the box refused the password, or the Session ended first)."""
        with self.lock:
            now = time.monotonic()
            if any(v[2] <= now for v in self.tokens.values()):
                self.tokens = {t: v for t, v in self.tokens.items() if v[2] > now}
            if any(v[1] <= now for v in self.labels.values()):
                self.labels = {t: v for t, v in self.labels.items() if v[1] > now}
            if any(v[2] <= now for v in self.handed.values()):
                self.handed = {t: v for t, v in self.handed.items() if v[2] > now}

    def redeem(self, token):
        """The token's (login, label), once; None if unknown, used, expired or forgotten."""
        with self.lock:
            entry = self.tokens.pop(token, None)
        if entry is None or entry[2] <= time.monotonic():
            return None
        return entry[:2]

    def label(self, token):
        """Which Session a token was minted for, without spending it (also shortly after it was spent:
        an expired-password prompt comes right after the password was accepted)."""
        with self.lock:
            entry = self.labels.get(token)
        return entry[0] if entry and entry[1] > time.monotonic() else None

    def forget(self):
        with self.lock:
            self.tokens.clear()
            self.labels.clear()
            self.handed.clear()

    def env(self, token):
        return {"SSH_ASKPASS": self.helper, "SSH_ASKPASS_REQUIRE": "force",
                SOCKET_ENV: self.socket_path, TOKEN_ENV: token}

    def login_options(self):
        """ssh's options that run the logged-in script once it has logged in (ssh runs LocalCommand with the user's
        shell, after authentication, cmd.exe on Windows; '%' is its escape)."""
        quoted = f'"{self.login_helper}"' if WINDOWS else shlex.quote(self.login_helper)
        return ["-o", "PermitLocalCommand=yes", "-o", f"LocalCommand={quoted.replace('%', '%%')}"]

    def logged_in(self, token):
        """The Session with this token has logged in: tell its Typed (once), if this token handed it to ssh."""
        with self.lock:
            entry = self.handed.pop(token, None)
        if entry is None or entry[2] <= time.monotonic():
            self.log("askpass: a login report for no password roster handed out - ignored")
            return False
        typed, label, _ = entry
        self.log(f"askpass: {label}: logged in")
        try:
            typed.on_login()
        except Exception as e:                  # never let a report break the channel
            self.log(f"askpass: {label}: handling the login failed: {type(e).__name__}")
        return True

    # ---- the socket

    def _accept_loop(self):
        while not self.stopping.is_set():
            try:
                ready, _, _ = select.select([self.server, self.wake_r], [], [], self._next_expiry())
                if self.wake_r in ready:
                    os.read(self.wake_r, 64)
                if self.server not in ready:
                    self._prune()           # an unused token (a typed password above all) goes once it expires
                    self._run_tick()
                    continue
                conn, _ = self.server.accept()
            except BlockingIOError:
                continue
            except OSError:
                return
            threading.Thread(target=self._answer, args=(conn,), daemon=True).start()

    def _answer(self, conn):
        with conn:
            try:
                conn.settimeout(5)
                if not same_user(conn):
                    self.log("askpass: refused a connection from a process that isn't this user's")
                    return
                data = b""
                while b"\n" not in data and len(data) < 1024:
                    chunk = conn.recv(1024)
                    if not chunk:
                        break
                    data += chunk
                conn.sendall(self._reply(data.partition(b"\n")[0].decode(errors="replace")))
            except OSError:
                pass

    def _reply(self, request):
        if request.startswith("login "):
            return b"ok\n" if self.logged_in(request.split(" ", 1)[1]) else b"no\n"
        if request.startswith("prompt "):
            _, token, prompt = (request.split(" ", 2) + [""])[:3]
            label = self.label(token)
            reason = refused_prompt_reason(label, prompt)
            self.log(f"askpass: {label or 'unknown Session'}: refused an unexpected prompt: '{shown_prompt(prompt)}'")
            return f"no {UNEXPECTED_PROMPT}\n{reason}".encode()
        found = self.redeem(request) if request else None
        if found is None:
            self.log("askpass: refused a token that is unknown, used, expired or cleared by vault.lock")
            return (f"no {TOKEN_SPENT}\nthe askpass token is used up, expired or cleared by a lock - "
                    "open the Session again").encode()
        login, label = found
        try:
            password = login.password if isinstance(login, Typed) else self.lookup(login)
            reason = None
        except Refused as e:
            reason, code = str(e), e.code
        except Exception as e:                  # its text might not be safe to show: name it only
            reason, code = f"looking up the password failed: {type(e).__name__}", LOOKUP_FAILED
        if reason is not None:
            self.log(f"askpass: {label}: {reason}")
            return f"no {code}\n{reason}".encode()
        self.log(f"askpass: {label}: password handed to ssh")
        if isinstance(login, Typed) and login.on_login is not None:
            with self.lock:
                self.handed[request] = (login, label, time.monotonic() + 2 * self.ttl)
        return b"ok\n" + password.encode()

    def close(self):
        self.stopping.set()
        self._nudge()
        if WINDOWS:
            self.server.close()             # wakes the accept thread
            self.thread.join(timeout=2)
            self.housekeeper.join(timeout=2)
            self.forget()
            for f in (self.known_hosts,):   # the helpers are roster's installed programs: they stay
                try:
                    os.unlink(f)
                except FileNotFoundError:
                    pass
            try:
                os.rmdir(self.dir)
            except OSError:
                pass
            return
        self.thread.join(timeout=2)
        self.server.close()
        for fd in (self.wake_r, self.wake_w):
            os.close(fd)
        self.forget()
        for f in (self.socket_path, self.helper, self.login_helper, self.known_hosts):
            try:
                os.unlink(f)
            except FileNotFoundError:
                pass
        try:
            os.rmdir(self.dir)
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def same_user(conn):
    """Is the other end this user? The directory's 0700 already says so on Linux, and the pipe's DACL lets nobody else
    open it on Windows; this checks the client itself: its uid (SO_PEERCRED) on Linux, its process's token user on
    Windows (ticket 63). What can't be told is refused."""
    if WINDOWS:
        from . import winpipe
        try:
            return winpipe.client_sid(conn) == winpipe.user_sid()
        except OSError:
            return False
    if not hasattr(socket, "SO_PEERCRED"):
        return True
    _pid, uid, _gid = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED,
                                                          struct.calcsize("3i")))
    return uid == os.getuid()


def write_helper(path, login=False):
    """SSH_ASKPASS must be one absolute executable (ssh runs it without a shell or the login PATH):
    a two-line script that runs this module with the Python serve runs on. -I keeps ssh's working
    directory and PYTHON* variables out of the import path. The logged-in script (login=True) says so in
    an env var, never in an argument: an askpass argument is a prompt, which the Host may choose."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
    with os.fdopen(fd, "w") as f:
        if login:
            f.write(f'#!/bin/sh\nexport {LOGIN_ENV}=1\nexec {shlex.quote(sys.executable)} -I -m roster.askpass\n')
        else:
            f.write(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} -I -m roster.askpass "$@"\n')


if __name__ == "__main__":
    raise SystemExit(main())
