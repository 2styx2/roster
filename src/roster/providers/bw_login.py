"""Signing the Bitwarden CLI in, one step at a time, for `roster serve`'s vault.login
(docs/app/dev/vault-auth.md has the research behind every choice here).

`bw login` is one-shot and has no flag for the new-device code, so the password and SSO flows run it on a
PTY (a pseudoconsole on native Windows, roster/conpty.py) and answer its own prompts (Email address, Two-step login method, Two-step login code, New device
verification) as the person answers the app. The process lives between calls. Nothing secret goes on a
command line: the master password is in an env var (--passwordenv), the API key in BW_CLIENTID/BW_CLIENTSECRET
(bw's own), and the email and codes are typed at bw's prompts. What bw shows on the PTY is read here only;
an error message is cut from it with the prompts (and their echoed answers) left out, and every value the
person gave is scrubbed from it on top of that.
"""

import os
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

from ..common import WINDOWS
from . import (
    ASK,
    PROVIDERS,
    AlreadyLoggedIn,
    ApiKeyRejected,
    BadServer,
    BrowserLoginFailed,
    CliMissing,
    CodeRejected,
    LoginError,
    MethodUnsupported,
    RateLimited,
    ServerUnreachable,
    WrongLogin,
    WrongPassword,
    errtext,
    not_installed,
)
from .bitwarden import _bw, _bw_status_json, _bw_unlock

if not WINDOWS:                         # a PTY is Linux's and macOS's; native Windows has its pseudoconsole
    import fcntl
    import pty
    import termios

ANSWER_WAIT = 40            # s: bw's answer to a step (a login is a KDF and a few requests)
SSO_URL_WAIT = 15           # s: for bw to start its callback server and hand over the link
SSO_TIMEOUT = 300           # s: for the person to finish SSO in the browser
SSO_PORTS = range(8065, 8071)   # bw's SSO callback server listens on the first free one
SSO_POLL = 20               # s: one vault.login call waits at most this long for the browser

CLOUD = None                                        # bw's default (US cloud): `bw config server bitwarden.com`
SERVERS = {"cloud": CLOUD, "us": CLOUD, "eu": "https://vault.bitwarden.eu"}

# bw's prompts (login.command.ts), in the order they can come
EMAIL, METHOD, CODE, NEW_DEVICE = "email", "method", "code", "new_device"
PROMPTS = {
    EMAIL: "Email address:",
    METHOD: "Two-step login method:",
    CODE: "Two-step login code:",
    NEW_DEVICE: "New device verification required",
}
UNEXPECTED = {"Master password:": "the master password", "client_id:": "an API key", "client_secret:": "an API key"}

# bw's names for the two-step methods it can do (TwoFactorProviderType: Authenticator 0, Email 1, YubiKey 3)
METHOD_KINDS = {"authenticator app": (0, "authenticator"), "email": (1, "email"),
                "yubico otp security key": (3, "yubikey"), "yubikey otp security key": (3, "yubikey")}

ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b[()][0-9A-Za-z]")

UNSUPPORTED_2FA = ("the Bitwarden CLI can't do this account's two-step login: FIDO2 security keys and Duo aren't "
                   "supported by the CLI - sign in with an API key instead, or add an authenticator app, email or "
                   "YubiKey OTP as a second method in the web vault")

SHIM = """#!/bin/sh
# roster serve: the link bw opens for SSO goes to roster (vault.login), which shows it in the app
printf '%s\\n' "$1" > "$ROSTER_SSO_URL_FILE"
[ -n "$ROSTER_NO_BROWSER" ] && exit 0
PATH="$ROSTER_SSO_PATH"
if command -v wslview >/dev/null 2>&1; then exec wslview "$1"
elif [ -n "$WSL_DISTRO_NAME" ] && command -v explorer.exe >/dev/null 2>&1; then exec explorer.exe "$1"
elif command -v xdg-open >/dev/null 2>&1; then exec xdg-open "$1"
fi
"""


def sso_timeout():
    """SSO_TIMEOUT, or shorter with ROSTER_SSO_TIMEOUT (seconds; for tests - it can't lengthen it)."""
    try:
        return max(1, min(SSO_TIMEOUT, int(os.environ.get("ROSTER_SSO_TIMEOUT", SSO_TIMEOUT))))
    except ValueError:
        return SSO_TIMEOUT


def plain(text):
    return ANSI.sub("", text).replace("\r", "\n")


class Terminal:
    """One bw process on a terminal roster drives: its prompts read from what the terminal shows, answers typed.
    Pty (Linux, macOS) and ConsolePty (native Windows) supply the terminal."""

    text = ""                   # what bw showed since the last answer, as plain text
    out = b""                   # its stdout, where it's apart from the terminal (Pty: --raw puts the session key there)

    def prompt(self):
        """The prompt bw is showing now, if it's one not answered yet (an answer re-renders its prompt)."""
        for key, marker in PROMPTS.items():
            if key in self.answered or marker not in self.text:
                continue
            if key == METHOD and "Cancel" not in self.text.split(marker, 1)[1]:
                continue                                # the list isn't drawn completely yet
            return key
        for marker in UNEXPECTED:
            if marker in self.text:
                return marker
        return None

    def wait(self, timeout, until=None):
        """("prompt", key), ("exit", returncode), ("until", value) or ("timeout", None)."""
        deadline = time.monotonic() + timeout
        while True:
            found = self.prompt()
            if found:
                return "prompt", found
            if until and (v := until()):
                return "until", v
            code = self.ended()
            if code is not None:
                return "exit", code
            left = deadline - time.monotonic()
            if left <= 0:
                return "timeout", None
            self._read(min(left, 0.25))

    def answer(self, key, text):
        """Type at prompt KEY; what bw showed before is forgotten."""
        self.answered.add(key)
        self.text = ""
        self._write(text)


class Pty(Terminal):
    """One bw process with its stdin and stderr on a PTY (where its prompts are) and stdout on a pipe
    (where --raw puts the session key)."""

    def __init__(self, args, env):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 240, 0, 0))     # no wrapped prompts
        try:
            self.proc = subprocess.Popen(args, stdin=slave, stdout=subprocess.PIPE, stderr=slave, env=env,
                                         start_new_session=True)
        except FileNotFoundError:
            os.close(master)
            raise CliMissing(not_installed("bw"))
        finally:
            os.close(slave)
        self.fd, self.text, self.out, self.answered = master, "", b"", set()

    def _read(self, timeout):
        fds = [f for f in (self.fd, self.proc.stdout) if f is not None]
        if not fds:
            return
        ready, _, _ = select.select(fds, [], [], max(0.0, timeout))
        for f in ready:
            try:
                chunk = os.read(f if isinstance(f, int) else f.fileno(), 65536)
            except OSError:                             # EIO: the PTY's other side has gone (bw exited)
                chunk = b""
            if f is self.fd:
                if chunk:
                    self.text += plain(chunk.decode("utf-8", "replace"))
                else:
                    os.close(self.fd)
                    self.fd = None
            elif chunk:
                self.out += chunk
            else:
                self.proc.stdout.close()
                self.proc.stdout = None

    def ended(self):
        """bw's exit code once it has exited and everything it showed is read, else None."""
        if self.fd is None and self.proc.stdout is None:
            return self.proc.wait()
        if self.fd is None and self.proc.poll() is not None:      # stdout held open by a grandchild
            return self.proc.returncode
        return None

    def _write(self, text):
        os.write(self.fd, text.encode())

    def close(self):
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=3)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.proc.wait()
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if self.proc.stdout is not None:
            self.proc.stdout.close()
            self.proc.stdout = None


# A pseudoconsole draws a screen: it places text with cursor moves where a PTY has newlines and spaces
CURSOR_TO = re.compile(r"\x1b\[[0-9;]*[HfEFd]")          # to a row (and column): a line break
CURSOR_RIGHT = re.compile(r"\x1b\[([0-9]*)C")


def screen_text(vt):
    """What a pseudoconsole drew, as plain text with its lines and spaces."""
    vt = CURSOR_TO.sub("\n", vt)
    vt = CURSOR_RIGHT.sub(lambda m: " " * min(int(m.group(1) or 1), 240), vt)
    return plain(vt)


class ConsolePty(Terminal):
    """Native Windows' counterpart of Pty: one bw process on a pseudoconsole (ConPTY, roster/conpty.py). Its
    stdout is on the console too, so once bw has exited, `out` is the last line it showed: what --raw printed."""

    def __init__(self, args, env):
        from ..conpty import ConPty
        try:
            self.con = ConPty(args, env)
        except FileNotFoundError:
            raise CliMissing(not_installed("bw"))
        except ValueError as e:                         # a batch-file bw and an argument cmd.exe would act on
            raise LoginError(str(e))
        self.text, self.out, self.answered, self.code = "", b"", set(), None

    def _read(self, timeout):
        got = self.con.read(timeout)
        if got:
            self.text += screen_text(got)

    def ended(self):
        if self.code is None and (code := self.con.exitcode()) is not None:
            self.con.finish()                   # closes the console: it draws what's left, then its output ends
            got = self.con.read(0)              # all of it, or what came within finish()'s wait: never more waiting
            if got:
                self.text += screen_text(got)
            self.out = self.last_line().encode()
            self.code = code
        return self.code

    def last_line(self):
        """What bw printed last: with --raw, after a sign-in, the session key (its stdout is this console too)."""
        lines = [line.strip() for line in self.text.split("\n") if line.strip()]
        return lines[-1] if lines else ""

    def listening(self, ports):
        """Which of PORTS bw (or what it started) listens on."""
        return self.con.listening(ports)

    def _write(self, text):
        self.con.write(text)

    def close(self):
        self.con.close()


def terminal(args, env):
    """bw running on the terminal this system has."""
    return ConsolePty(args, env) if WINDOWS else Pty(args, env)


def parse_methods(text):
    """The two-step methods in bw's list prompt, in its order (inquirer: a pointer on the current one, then a
    separator line and Cancel)."""
    after = text.split(PROMPTS[METHOD], 1)[1]
    methods = []
    for line in after.split("\n"):
        name = line.replace("(Use arrow keys)", "").strip().lstrip("❯>›*").strip()
        if not name:
            continue
        if set(name) <= set("─-") or name == "Cancel":
            break
        known = METHOD_KINDS.get(name.lower())
        methods.append({"index": len(methods), "id": known[0] if known else None,
                        "kind": known[1] if known else "other", "name": name})
    return methods


def server_url(value):
    """vault.login's `server`: "cloud" (US), "eu", or a self-hosted https:// URL -> what `bw config server`
    takes (None for the US cloud)."""
    if value.lower() in SERVERS:
        return SERVERS[value.lower()]
    u = urlparse(value.strip())
    if u.scheme not in ("https", "http") or not u.hostname or any(c.isspace() for c in value.strip()):
        raise BadServer(f"'{value}' isn't a server address - use cloud, eu, or your server's https:// URL, "
                        "e.g. https://vault.example.com")
    return value.strip().rstrip("/")


def same_server(a, b):
    norm = {None: None, "https://bitwarden.com": None, "https://vault.bitwarden.com": None}
    a, b = (x.rstrip("/") if x else None for x in (a, b))
    return norm.get(a, a) == norm.get(b, b)


def server_name(url):
    return urlparse(url).hostname if url else "bitwarden.com"


class BwLogin:
    """One sign-in. start() and answer() return the next step as a dict; a failure is a LoginError (with
    .step when the sign-in carries on). close() ends it and forgets everything it held."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.flow = None                    # "password", "apikey" or "sso"
        self.bw = None                      # the Pty while bw is running
        self.email = self.password = None   # held only for the sign-in's life, to restart after a wrong code
        self.method = None                  # the chosen method's index in bw's list, once picked
        self.methods = []
        self.step = None                    # the step the person is on
        self.server = CLOUD
        self.secrets = []                   # every value the person gave, scrubbed from anything shown
        self.shim = None
        self.sso_url = None
        self.sso_deadline = 0.0
        self.touched = time.monotonic()

    # ---- the steps

    def start(self, params):
        """params: method ("password", "apikey" or "sso"), server (optional; else as configured), and the
        method's own: email + password, client_id + client_secret, or identifier (SSO org, optional)."""
        status = _bw_status_json(self.ctx)
        if status.get("status") != "unauthenticated":
            who = f" as {status['userEmail']}" if status.get("userEmail") else ""
            raise AlreadyLoggedIn(f"the Bitwarden CLI is already logged in on this box{who} - unlock it instead "
                                  "(to sign in as someone else, sign out first: 'Use a different account' in the app, or `roster bw logout`)")
        self.server = status.get("serverUrl") or CLOUD
        if params.get("server"):
            self.set_server(server_url(params["server"]))
        self.flow = params.get("method") or "password"
        if self.flow == "password":
            self.email, self.password = params["email"], params["password"]
            self.secrets += [self.password]
            return self.run_password_login()
        if self.flow == "apikey":
            return self.apikey_login(params["client_id"], params["client_secret"])
        if self.flow == "sso":
            return self.sso_login(params.get("identifier"))
        raise ValueError(f"unknown sign-in method {self.flow!r}")

    def set_server(self, url):
        """`bw config server`, only when it changes something (bw refuses while logged in; we're logged out)."""
        if same_server(url, self.server):
            return
        r = _bw(self.ctx, "config", "server", url or "bitwarden.com")
        if r.returncode != 0:
            raise LoginError(f"`bw config server` failed: {errtext(r)}")
        self.server = url

    def answer(self, params):
        self.touched = time.monotonic()
        kind = self.step["step"]
        if kind == "two_factor_method":
            index = params["method"]
            if not isinstance(index, int) or not 0 <= index < len(self.methods):
                raise ValueError(f"params.method must be one of the listed methods' index (0-{len(self.methods) - 1})")
            self.method = index
            self.bw.answer(METHOD, "\x1b[B" * index + "\r")              # arrow down to it, Enter
            return self.next_step(METHOD)
        if kind in ("two_factor_code", "new_device_code"):
            code = params["code"].strip()
            self.secrets.append(code)
            prompt = CODE if kind == "two_factor_code" else NEW_DEVICE
            self.bw.answer(prompt, code + "\r")
            return self.next_step(prompt)
        if kind == "sso":
            return self.sso_wait()
        if kind == "master_password":
            password = params["password"]
            self.secrets.append(password)
            try:
                _bw_unlock(password, self.ctx)
            except WrongPassword as e:
                e.step = self.step                  # still logged in: the person tries the password again
                raise
            return self.finish()
        raise ValueError(f"nothing to answer at step {kind!r}")

    def close(self):
        if self.bw:
            self.bw.close()
            self.bw = None
        if self.shim:
            shutil.rmtree(self.shim, ignore_errors=True)
            self.shim = None
        self.email = self.password = None
        self.secrets = []

    # ---- password (and what bw asks after it)

    def env(self, extra=None):
        env = {**os.environ, "FORCE_COLOR": "0", "TERM": "xterm"}
        for var in ("BW_NOINTERACTION", "BW_SESSION", "BW_PASSWORD", "BW_CLIENTID", "BW_CLIENTSECRET"):
            env.pop(var, None)
        return {**env, **(extra or {})}

    def run_password_login(self):
        """`bw login` on a PTY: the email typed at its prompt, the password from an env var."""
        self.close_bw()
        self.bw = terminal(["bw", "login", "--raw", "--passwordenv", "ROSTER_BW_MASTER"],
                      self.env({"ROSTER_BW_MASTER": self.password}))
        how, what = self.bw.wait(ANSWER_WAIT)
        if (how, what) != ("prompt", EMAIL):
            return self.outcome(how, what, None)
        self.bw.answer(EMAIL, self.email + "\r")
        return self.next_step(EMAIL)

    def next_step(self, after):
        how, what = self.bw.wait(ANSWER_WAIT)
        if how == "prompt" and what == METHOD and self.method is not None and after == EMAIL and self.methods:
            self.bw.answer(METHOD, "\x1b[B" * self.method + "\r")      # a restart: the same method again
            how, what = self.bw.wait(ANSWER_WAIT)
            after = METHOD
        try:
            return self.outcome(how, what, after)
        except CodeRejected as e:
            raise self.restarted(e) from None

    def outcome(self, how, what, after):
        if how == "prompt":
            if what == METHOD:
                self.methods = parse_methods(self.bw.text)
                if not self.methods:
                    raise self.fail(LoginError("couldn't read the list of two-step methods bw offered"))
                return self.at({"step": "two_factor_method", "methods": self.methods})
            if what == CODE:
                m = self.methods[self.method] if self.method is not None and self.methods else None
                return self.at({"step": "two_factor_code", "method": m, "sent": bool(m and m["kind"] == "email")})
            if what == NEW_DEVICE:
                return self.at({"step": "new_device_code", "email": self.email})
            raise self.fail(LoginError(f"bw asked for {UNEXPECTED.get(what, what)} unexpectedly - sign in with "
                                       "`bw login` in a terminal once"))
        if how == "timeout":
            raise self.fail(ServerUnreachable(f"no answer from {server_name(self.server)} within {ANSWER_WAIT} s"))
        if what == 0:
            key = self.session_key()
            if key:
                os.environ["BW_SESSION"] = key                          # this process only
                return self.finish()
            return self.at({"step": "master_password", "email": self.email})
        e = self.failure(after)
        raise e if isinstance(e, CodeRejected) else self.fail(e)       # a wrong code: restarted() decides

    def restarted(self, e):
        """After a wrong code bw has exited: run the sign-in again with the password still held, so the person
        only types a code again (Email and new-device send a fresh one)."""
        if self.flow != "password" or not self.password:
            return self.fail(e)
        resent = self.step and (self.step.get("sent") or self.step["step"] == "new_device_code")
        try:
            step = self.run_password_login()
        except LoginError as again:
            return again
        e.step = step
        if resent:
            e.args = (f"{e.args[0]} - a new code is on its way to your email",)
        return e

    def session_key(self):
        out = self.bw.out.decode("utf-8", "replace").strip() if self.bw else ""
        m = re.search(r'BW_SESSION="([^"]+)"', out)
        if m:
            return m.group(1)
        if out in self.secrets or out == self.email:        # Windows: a typed answer was the last thing shown
            return None
        return out if out and not any(c.isspace() for c in out) else None

    # ---- API key, SSO

    def apikey_login(self, client_id, client_secret):
        self.secrets += [client_secret]
        r = _bw(self.ctx, "login", "--apikey", env={"BW_CLIENTID": client_id, "BW_CLIENTSECRET": client_secret})
        if r.returncode != 0:
            raise self.fail(self.failure(None, text=errtext(r, 400)))
        return self.at({"step": "master_password", "email": None})

    def sso_login(self, identifier):
        if WINDOWS:
            return self.sso_login_windows(identifier)
        self.shim = Path(tempfile.mkdtemp(prefix="roster-sso-"))       # 0700
        (self.shim / "xdg-open").write_text(SHIM)
        (self.shim / "xdg-open").chmod(0o700)
        url_file = self.shim / "url"
        path = os.environ.get("PATH", "")
        self.bw = terminal(["bw", "login", "--sso", *([identifier] if identifier else [])],
                      self.env({"PATH": f"{self.shim}{os.pathsep}{path}", "ROSTER_SSO_PATH": path,
                                "ROSTER_SSO_URL_FILE": str(url_file)}))
        how, what = self.bw.wait(SSO_URL_WAIT, until=lambda: url_file.is_file() and url_file.read_text().strip())
        if how != "until":
            if how == "timeout":
                raise self.fail(BrowserLoginFailed("bw didn't start the SSO sign-in (no link to open)"))
            return self.outcome(how, what, None)
        self.sso_url = what
        self.sso_deadline = time.monotonic() + sso_timeout()
        return self.at({"step": "sso", "url": self.sso_url, "expires_in": sso_timeout()})

    def sso_login_windows(self, identifier):
        """On Windows bw opens the page itself, with PowerShell's Start by its full path, which no PATH entry can
        stand in for: so there's no link to hand over (`url` null), and bw having opened it is known by its
        callback server listening (it opens the page as that server starts), as Windows' TCP table shows it."""
        self.bw = terminal(["bw", "login", "--sso", *([identifier] if identifier else [])], self.env())
        how, what = self.bw.wait(SSO_URL_WAIT, until=lambda: self.bw.listening(SSO_PORTS))
        if how != "until":
            if how == "timeout":
                raise self.fail(BrowserLoginFailed("bw didn't start the SSO sign-in (its sign-in page didn't open)"))
            return self.outcome(how, what, None)
        self.sso_deadline = time.monotonic() + sso_timeout()
        return self.at({"step": "sso", "url": None, "expires_in": sso_timeout()})

    def sso_wait(self):
        left = self.sso_deadline - time.monotonic()
        how, what = self.bw.wait(max(0.0, min(SSO_POLL, left)))
        if how == "timeout":
            if time.monotonic() >= self.sso_deadline:
                raise self.fail(BrowserLoginFailed("the SSO sign-in wasn't finished in the browser within "
                                                   f"{max(1, sso_timeout() // 60)} minutes"))
            return self.at({"step": "sso", "url": self.sso_url,
                            "expires_in": int(self.sso_deadline - time.monotonic())})
        return self.outcome(how, what, None)

    # ---- endings

    def at(self, step):
        self.step = step
        return step

    def finish(self):
        self.close()
        return self.at({"step": "done", "provider": "bw", "status": "unlocked"})

    def close_bw(self):
        if self.bw:
            self.bw.close()
            self.bw = None

    def fail(self, e):
        """End the sign-in with E (unless it says where to carry on)."""
        if e.step is None:
            self.close()
        return e

    def scrub(self, text):
        for s in self.secrets + ([self.email] if self.email else []):
            if s:
                text = text.replace(s, "…")
        return text

    def error_text(self):
        """bw's own error: its last lines on the PTY, minus prompts and noise, scrubbed."""
        lines = [line.strip() for line in (self.bw.text if self.bw else "").split("\n")]
        keep = [line for line in lines if line and not line.startswith(("?", "(node", "(Use "))
                and not any(p in line for p in [*PROMPTS.values(), *UNEXPECTED])]
        return self.scrub(" ".join(keep[-2:]))[:300]

    def failure(self, after, text=None):
        """What a failed `bw login` means, from its error text and what was answered last."""
        text = self.scrub(text if text is not None else self.error_text())
        low = text.lower()
        where = server_name(self.server)
        if any(k in low for k in ("too many", "slow down", "429", "temporarily")):
            return RateLimited(f"{where} refused: too many sign-in attempts - wait a few minutes, then try again")
        if any(k in low for k in ("enotfound", "econnrefused", "etimedout", "eai_again", "econnreset", "ehostunreach",
                                  "enetunreach", "certificate", "self signed", "self-signed", "unable to verify",
                                  "fetch failed", "socket hang up", "request to ")):
            return ServerUnreachable(f"can't reach the Bitwarden server {where} ({text or 'no answer'}) - check "
                                     "the address and this box's network")
        if "no providers available" in low:
            return MethodUnsupported(UNSUPPORTED_2FA)
        if "does not support sso" in low or "to set your master password" in low:
            return MethodUnsupported(text)
        if "organization api key" in low:
            return ApiKeyRejected("that's an organization API key - the CLI signs in only with a personal API key "
                                  "(web vault: Account settings > Security > Keys)")
        if "client_id or client_secret" in low or "invalid_client" in low:
            return ApiKeyRejected("Bitwarden didn't accept that API key (client_id or client_secret)")
        if "already logged in" in low:
            return AlreadyLoggedIn("the Bitwarden CLI is already logged in on this box - unlock it instead "
                                   "(to sign in as someone else, sign out first: 'Use a different account' in the app, or `roster bw logout`)")
        if after in (CODE, NEW_DEVICE):
            return CodeRejected("Bitwarden didn't accept that code (wrong or expired)")
        if "invalid master password" in low or "username or password is incorrect" in low:
            return WrongLogin(f"Bitwarden didn't accept that email and master password (on {where})")
        if self.flow == "sso" and "something went wrong" in low:
            return BrowserLoginFailed("the SSO sign-in failed in the browser - try again")
        return LoginError(f"Bitwarden sign-in failed: {text or 'bw exited without saying why'}")




def login_info(ctx, server=ASK):
    """vault.status's `sign_in` for a logged-out bw: the ways in, and the server it's set to (None: bitwarden.com).
    SERVER, when the caller knows it already (vault.logout, from the `bw status` before it), saves asking bw again."""
    if server is ASK:
        server = _bw_status_json(ctx).get("serverUrl")
    return {"methods": ["password", "apikey", "sso"], "server": server}


PROVIDERS["bw"].update(login=BwLogin, login_info=login_info)
