"""Small shared helpers: output, paths, text, starting other programs."""

import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import IO, Any, NoReturn, cast

from . import context
from .errors import ROSTER_ERROR, Exit, Problem

NAME_ERE = "[A-Za-z0-9][A-Za-z0-9._-]*"                 # a name (a Host's, a group's, ...), as an ERE for scripts
NAME_RE = re.compile(rf"^{NAME_ERE}\Z")                  # \Z: a trailing newline is not part of a name


class NotPrivate(Exception):
    """read_private: the file is there, but it isn't only yours (the message says how)."""


PRIVATE_MAX = 64 * 1024        # read_private: a secret's file is small (a bw session key is about 88 bytes)


def never_look_in_the_current_folder() -> None:
    """Windows: tell Windows itself never to look in the current folder for a program (#424 M1), for roster and all it
    starts. find_program already keeps it out of what roster runs by name; this covers what goes through cmd.exe (a
    `cmd:` provider, a `providers:` command template), what Python 3.12+'s shutil.which would find, and the programs
    roster's programs start (a bw.cmd's node). A no-op elsewhere."""
    if context.WINDOWS:
        os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"


def read_private(path: Path) -> str:
    """PATH's text (UTF-8), as read_private_bytes reads it."""
    return read_private_bytes(path).decode("utf-8", "replace")


def read_private_bytes(path: Path, dir_fd: int | None = None) -> bytes:
    """PATH's bytes, read only if it's yours alone (#411), as a secret's file must be: opened without following a link,
    then checked and read through that one open file, so it can't be swapped between the check and the read. On Linux
    and macOS: a plain file (not a link, FIFO or device), owned by you, with no group or other bits. On Windows
    (roster/winfile.py): a plain file (not a link or other reparse point), owned by you, that no one but you, SYSTEM
    and Administrators may open. Either way it has one name (no hard link elsewhere) and is at most PRIVATE_MAX bytes.
    Only the file itself is checked, not the folders it's in. DIR_FD (Linux and macOS): an open folder to find PATH's
    name in, so the folder can't be swapped for another by name (T248); PATH is then only what messages show.
    FileNotFoundError if there's nothing there; NotPrivate if it isn't yours alone or can't be read (whatever went
    wrong: never a traceback)."""
    if context.WINDOWS:
        from . import winfile
        try:
            return winfile.read_private_bytes(str(path))
        except (FileNotFoundError, NotPrivate):
            raise
        except OSError as e:
            raise NotPrivate(f"{path} can't be read ({e.strerror or type(e).__name__})") from None
    import stat
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOCTTY", 0)
    name = path if dir_fd is None else Path(path).name
    try:
        fd = os.open(name, flags, dir_fd=dir_fd)
    except OSError as e:
        if isinstance(e, FileNotFoundError):
            raise
        try:
            link = stat.S_ISLNK(os.lstat(name, dir_fd=dir_fd).st_mode)
        except OSError:
            link = False
        if link:
            raise NotPrivate(f"{path} is a symlink (roster never follows one here)") from None
        raise NotPrivate(f"{path} can't be read ({e.strerror})") from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise NotPrivate(f"{path} isn't a plain file")
        if st.st_uid != os.getuid():
            raise NotPrivate(f"{path} isn't yours (another user owns it)")
        if st.st_mode & 0o077:
            raise NotPrivate(f"{path} is readable by others (chmod 600 {path})")
        if st.st_nlink != 1:
            raise NotPrivate(f"{path} has other names (hard links), which may be changed from elsewhere")
        chunks, size = [], 0
        while size <= PRIVATE_MAX and (chunk := os.read(fd, 65536)):
            chunks.append(chunk)
            size += len(chunk)
        if size > PRIVATE_MAX:
            raise NotPrivate(f"{path} is too big to be a session (over {PRIVATE_MAX // 1024} KiB)")
        return b"".join(chunks)
    except OSError as e:
        raise NotPrivate(f"{path} can't be read ({e.strerror or type(e).__name__})") from None
    finally:
        os.close(fd)


def replace_file(path: Path, text: str, mode: int = 0o600, *, follow: bool = True, like: Path | None = None) -> None:
    """Write TEXT to PATH whole or not at all: a new file beside it (a name of its own, so two writers can't take each
    other's), flushed to disk, then renamed over it, with MODE (0600: ~/.ssh/config as roster always left it, since
    OpenSSH refuses one others can write) or LIKE's mode. FOLLOW: a symlink at PATH is followed, so its target is what
    changes (an ~/.ssh/config kept elsewhere); else the link itself is replaced, never written through."""
    import tempfile
    target = Path(os.path.realpath(path)) if follow else Path(path)
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".new", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if like is not None:
            shutil.copymode(like, tmp)
        else:
            os.chmod(tmp, mode)
        os.replace(tmp, target)
    finally:
        Path(tmp).unlink(missing_ok=True)


def write_private(path: Path, text: str) -> None:
    """replace_file for a file of roster's own state (Mesh state, the rotation's record, a vault snapshot, a web
    session): this user's alone (0600), and a symlink planted at PATH is replaced, never written through."""
    replace_file(path, text, 0o600, follow=False)


def ssh_path(path: str | Path) -> str:
    """PATH as ssh reads it in its config and -o values: as is, but with forward slashes on Windows (Windows'
    OpenSSH takes C:/Users/..., and a backslash is an escape character in some of its option values)."""
    return Path(path).as_posix() if context.WINDOWS else str(path)


# ---------------------------------------------------------------- starting other programs (Windows too)

# What cmd.exe acts on in a command line. A .cmd or .bat program (npm installs bw as bw.cmd) runs through cmd.exe,
# which reads these in its arguments whatever the quoting, so an argument with one could run something else.
CMD_SPECIAL = re.compile(r'["%^&|<>!\r\n]')


RUNNABLE = (".com", ".exe", ".bat", ".cmd")      # what Windows' CreateProcess starts (a .cmd or .bat through cmd.exe)


def rooted(folder: str) -> bool:
    """Is FOLDER a fixed place? Absolute, and on Windows with a drive or UNC root as well: before Python 3.13 `\\tools`
    counts as absolute, but it's on whatever drive the current folder is on (#424 L3)."""
    import posixpath
    return bool(folder) and os.path.isabs(folder) and (os.path is posixpath or bool(os.path.splitdrive(folder)[0]))


def find_program(name: str) -> str | None:
    """The program roster runs as NAME, as a path, or None: shutil.which, except on Windows, where it's looked up on
    PATH alone, never in the current folder (#411). Windows' own lookup (CreateProcess, and shutil.which before
    Python 3.12; from 3.12 unless NoDefaultCurrentDirectoryInExePath is set) tries the current folder first, so a bw.exe
    or ssh.cmd left in whatever folder roster was started from would run in its place, with the vault's session in its
    env. A relative PATH entry (empty, ".", or one with no drive) depends on the current folder too, so it's skipped. A
    NAME with a folder in it is taken as named."""
    if not context.WINDOWS or "/" in name or "\\" in name:
        return shutil.which(name)
    # only what CreateProcess can start: PATHEXT also lists .JS, .VBS, .MSC, .PY...
    exts = [e for e in (x.strip() for x in (os.environ.get("PATHEXT") or ".COM;.EXE;.BAT;.CMD").split(";"))
            if e.lower() in RUNNABLE]
    names = [name] if name.lower().endswith(RUNNABLE) else [name + e for e in exts]
    for folder in (os.environ.get("PATH") or "").split(os.pathsep):
        folder = folder.strip().strip('"')
        if not rooted(folder):
            continue
        for n in names:
            path = os.path.join(folder, n)
            if os.path.isfile(path):
                return path
    return None


def git_program() -> str:
    """The git to run: on Windows git.exe wherever it is on PATH, ahead of a git.cmd or git.bat shim earlier on it
    (which can't be handed a quote, a % or a ! in a commit message or URL; #424 L5)."""
    return (find_program("git.exe") or "git") if context.WINDOWS else "git"


def program_argv(argv: Sequence[str]) -> list[str]:
    """ARGV ready for subprocess. On Windows the program is looked up on PATH alone with its extension (find_program: a
    tool installed as bw.cmd is found as bw, one in the current folder never is; FileNotFoundError if it isn't on
    PATH, as subprocess would raise, rather than leave Windows to look in the current folder), and a .cmd or .bat
    program is refused an argument cmd.exe would act on: roster passes item names and paths there, and those come from
    roster.yml and the vault."""
    if not context.WINDOWS:
        return list(argv)
    named = "/" in argv[0] or "\\" in argv[0]
    found = (shutil.which(argv[0]) or argv[0]) if named else find_program(argv[0])
    if found is None:
        raise FileNotFoundError(f"{argv[0]} isn't on PATH")
    if found.lower().endswith((".cmd", ".bat")):
        bad = next((a for a in argv[1:] if CMD_SPECIAL.search(a)), None)
        if bad is not None:
            raise ValueError(f"{Path(found).name} is a batch file, and roster won't pass it an argument with any of "
                             '" % ^ & | < > ! in it (cmd.exe would act on it) - rename what has one, or install the '
                             "tool as an .exe")
    return [found, *argv[1:]]


def kill_tree(p):
    """Kill P and everything it started. On Windows a tool is often a batch file (npm's bw.cmd) whose real program is
    its child, which would outlive a plain kill and keep the output pipes open."""
    if context.WINDOWS:
        # Windows' own, by its full path: PATH may lack System32
        taskkill = os.path.join(os.environ.get("SystemRoot") or r"C:\Windows", "System32", "taskkill.exe")
        try:
            subprocess.run([taskkill, "/F", "/T", "/PID", str(p.pid)], capture_output=True)
        except OSError:
            pass
    try:
        p.kill()
    except OSError:
        pass


def end_group(p, gentle=False):
    """End P (started with start_new_session=True) and everything it started: on POSIX its process group, SIGTERM first
    when GENTLE (an ssh closes its connection), then SIGKILL, to the group even once P itself has gone; on Windows,
    which has no process groups, its tree (kill_tree). Then P is reaped, our ends of its pipes closed first, so a child
    that still holds them can't keep us waiting."""
    import signal

    def send(sig):
        try:
            os.killpg(p.pid, sig)
        except OSError:
            if sig == signal.SIGKILL:
                try:
                    p.kill()
                except OSError:
                    pass
    if context.WINDOWS:
        kill_tree(p)
    else:
        if gentle:
            send(signal.SIGTERM)
            try:
                p.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        send(signal.SIGKILL)
    for pipe in (p.stdin, p.stdout, p.stderr):
        if pipe is not None:
            try:
                pipe.close()
            except OSError:
                pass
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def run(args, timeout=None, input=None, stdout=subprocess.PIPE, **kw):
    """subprocess.run with capture_output, but a timeout kills the whole process tree (kill_tree) before it waits for
    the output, so a tool's leftover child can't hold the call past its timeout. STDOUT=subprocess.DEVNULL: what the
    tool prints never reaches this process (an item a vault CLI prints, password and all)."""
    with subprocess.Popen(args, stdout=stdout, stderr=subprocess.PIPE,
                          **({"stdin": subprocess.PIPE} if input is not None else {}), **kw) as p:
        try:
            out, err = p.communicate(input, timeout=timeout)
        except subprocess.TimeoutExpired:
            kill_tree(p)
            p.communicate()
            raise
        except BaseException:
            kill_tree(p)
            raise
    return subprocess.CompletedProcess(args, p.returncode, out, err)


STDERR_CAP = 64 * 1024         # bytes of a producer's stderr kept by run_filtered (an error message, never data)


def filter_env():
    """The environment run_filtered's filter gets: next to nothing (none of this process's variables, so no session
    key, token or password a variable holds); on Windows SYSTEMROOT, which Python itself needs to start."""
    return {k: os.environ[k] for k in ("SYSTEMROOT",) if k in os.environ} if context.WINDOWS else {}


def run_filtered(producer, filt, timeout=None, env=None, filter_env=None):
    """PRODUCER's stdout connected straight to FILT's stdin, an OS pipe between the two child processes: this process
    never reads a byte PRODUCER prints (Q191: `bw list items`, which prints every password). It reads FILT's stdout
    and both programs' stderr (PRODUCER's up to STDERR_CAP). ENV: PRODUCER's environment (default this process's);
    FILTER_ENV: FILT's (default this process's). Returns (PRODUCER's CompletedProcess with stdout None, FILT's).
    A timeout kills both process trees, then raises subprocess.TimeoutExpired."""
    p1 = subprocess.Popen(producer, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    try:
        p2 = subprocess.Popen(filt, stdin=p1.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=filter_env)
    except BaseException:
        kill_tree(p1)
        p1.wait()
        raise
    finally:
        cast(IO[bytes], p1.stdout).close()              # the filter holds the read end now: never this process
    err1 = []
    stderr = cast(IO[bytes], p1.stderr)

    def drain():
        kept = b""
        while chunk := stderr.read(65536):
            kept = (kept + chunk)[:STDERR_CAP]
        err1.append(kept)
    t = threading.Thread(target=drain, daemon=True)
    t.start()
    start = time.monotonic()
    try:
        out2, err2 = p2.communicate(timeout=timeout)
        p1.wait(timeout=None if timeout is None else max(0.1, timeout - (time.monotonic() - start)))
    except BaseException:
        kill_tree(p1)
        kill_tree(p2)
        p1.wait()
        p2.wait()
        raise
    finally:
        t.join(timeout=5)
        stderr.close()
    text = (err1[0] if err1 else b"").decode("utf-8", "replace")
    return (subprocess.CompletedProcess(producer, p1.returncode, None, text),
            subprocess.CompletedProcess(filt, p2.returncode, out2.decode("utf-8", "replace"),
                                        err2.decode("utf-8", "replace")))


def run_instead(argv):
    """Run ARGV in this process's place and return its exit code (`roster run` handing over to ssh). On Linux and
    macOS the process becomes it (execvp); Windows has no such thing, so roster waits for it and passes on its code."""
    argv = program_argv(argv)
    if not context.WINDOWS:
        os.execvp(argv[0], argv)        # noqa: S606 - an argv list (no shell): roster's own ssh command line
    try:
        return subprocess.run(argv).returncode
    except KeyboardInterrupt:          # Ctrl+C went to the child as well; its code is what counts
        return 130


def roster_command():
    """How Claude (or anyone) should invoke roster on this box."""
    if find_program("roster"):
        return "roster"
    return f"{shlex.quote(sys.executable)} -m roster"     # e.g. inside a uv venv that isn't on PATH


def die(msg: str, code: int = ROSTER_ERROR, fix: str | None = None, data: dict[str, Any] | None = None) -> NoReturn:
    """Refuse: `error: MSG` on stderr and exit 1 (`error: [CODE] MSG` for a CODE of its own: errors.Exit). serve and
    --json answer with CODE, MSG, FIX and DATA."""
    raise Exit(Problem(code, msg, data, fix=fix))


def refuse(problem: Problem) -> NoReturn:
    """Refuse with a library's PROBLEM: `error: [CODE] MESSAGE (DETAILS) - FIX` on stderr and exit 1; serve and
    --json answer with the Problem as it is."""
    raise Exit(problem, full=True)



# ---------------------------------------------------------------- what looks like a token, not a name

_TOKEN_SHAPED = re.compile(r"[A-Za-z0-9+/=_-]{24,}")          # a whole value: a bw key, with its / and +
_TOKEN_PART = re.compile(r"[A-Za-z0-9+=_.-]{24,}")            # one part of a path: an op token, a JWT (eyJ….….…)
_INVENTORY_SUFFIXES = (".yml", ".yaml", ".yml.example")


def token_shaped(value: str | Path) -> bool:
    """VALUE (a -c PATH, or an Inventory's name) looks like a token, not something a person names a file
    (#479, #484 L1/L3, #489 M1): the whole of it is 24 or more of A-Z a-z 0-9 + / = _ - (a bw key, whose parts
    between its /s are often short), or any one part of it between / or \\ is 24 or more of A-Z a-z 0-9 + = _ . -
    (an op session or service-account token, a JWT such as an op Connect token, also as a folder). A last part
    ending .yml, .yaml or .yml.example is a file name, whatever its length."""
    text = str(value)
    parts = re.split(r"[\\/]", text)
    if parts[-1].lower().endswith(_INVENTORY_SUFFIXES):
        parts = parts[:-1]
    elif _TOKEN_SHAPED.fullmatch(text):
        return True
    return any(_TOKEN_PART.fullmatch(p) for p in parts)


def typed_token(path: str | Path) -> bool:
    """PATH as typed is token_shaped (#489 M1, #494 L3, #498). A relative value is tested whole, every part but . and
    .., whether it exists or not: a token typed as a folder is caught even when an older roster already made that
    folder. In an absolute value (after ~ is expanded) the folders at its start are left out first, so a long real
    folder name (a temp folder, C:/Users/NAME/…) never counts: inside the cwd or $HOME, only up to the deeper of
    them, and all the rest is tested, so `$PWD/TOKEN/…` and `~/TOKEN/…` are caught too; elsewhere, the folders at
    its start that exist."""
    text = os.path.expanduser(str(path))
    if not Path(text).is_absolute():
        return token_shaped(str(path))
    if (rest := _past_cwd_or_home(text)) is not None:
        return token_shaped(rest)
    parts = re.split(r"[\\/]", text)
    for k in range(len(parts) - 1, 0, -1):
        if Path("/".join(parts[:k]) or "/").is_dir():
            return token_shaped("/".join(parts[k:]))
    return token_shaped(text)


def _past_cwd_or_home(text: str) -> str | None:
    """What absolute TEXT has past the deeper of the cwd and $HOME (as given or resolved) that it's inside, or None
    when it's inside neither. A base that is a drive's or the file system's root doesn't count: it isn't a limit."""
    bases = set()
    for where in (Path.cwd, Path.home):
        try:
            base = where()
            both = (base, base.resolve())
        except (OSError, RuntimeError):     # a cwd that was deleted, no home to be found
            continue
        for b in both:
            if b != Path(b.anchor):
                bases.add(os.path.normcase(str(b)).rstrip("\\/"))
    typed = os.path.normcase(text)
    inside = [b for b in bases if typed == b or typed[len(b):len(b) + 1] in ("/", "\\") and typed.startswith(b)]
    if not inside:
        return None
    return text[len(max(inside, key=len)):].lstrip("\\/")


UTC_TIME = "%Y-%m-%dT%H:%M:%SZ"      # how roster writes a time in its own files


def utc_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime(UTC_TIME)


def ago(when: object, now: Any = None) -> str:
    """'just now', '5 min ago', '3 h ago', '2 days ago' for an ISO time (NOW: a datetime, else now)."""
    from datetime import datetime, timezone
    try:
        then = datetime.strptime(str(when)[:19] + "Z", UTC_TIME).replace(tzinfo=timezone.utc)
    except ValueError:
        return str(when)
    s = ((now or datetime.now(timezone.utc)) - then).total_seconds()
    if s < 60:
        return "just now"
    if s < 3600:
        return f"{int(s // 60)} min ago"
    if s < 2 * 86400:
        return f"{int(s // 3600)} h ago"
    return f"{int(s // 86400)} days ago"


def failure_text(e):
    """What went wrong, safe to show: an OSError's own words (paths only), else just the exception's type."""
    if isinstance(e, OSError):
        return f"{e.strerror or type(e).__name__}" + (f": {e.filename}" if e.filename else "")
    return type(e).__name__


def not_reviewed(h):
    """Why roster won't log in to a Host discover found (`roster run`, `roster serve` session.prepare)."""
    return f"{h['name']} is not reviewed yet (reviewed: false in roster.yml) - not logging in"


def plain(text):
    """Is TEXT safe to show on a terminal and to write into an `auth:` reference: no control, escape, bidi or other
    format character (str.isprintable), so a vault item can't rewrite the prompt it's offered in (review of #439)?"""
    return bool(text) and text.isprintable()


def say(msg: object = "") -> None:
    print(msg, flush=True)


def oneline(v):
    return " ".join(str(v or "").split())


def tcp_ok(host, port, timeout=3):
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except (OSError, ValueError):
        return False


# ---------------------------------------------------------------- a request's deadline (roster serve)
# serve gives each long method an overall deadline below the app's timeout for it, so the app never gives up
# on a call that is still going to finish. Every subprocess and network step asks time_left() for its timeout.
# Per thread: the askpass channel's lookups run on their own thread and aren't held to a request's deadline.

_deadline = threading.local()


def deadline(seconds):
    """Hold the steps run inside to SECONDS in all (None: no deadline)."""
    return deadline_at(None if seconds is None else time.monotonic() + seconds)


@contextmanager
def deadline_at(at):
    """Hold the steps run inside to the deadline AT (time.monotonic(); None: none): a worker thread takes its
    request's with deadline_at(current_deadline())."""
    before = getattr(_deadline, "at", None)
    _deadline.at = at
    try:
        yield
    finally:
        _deadline.at = before


def current_deadline():
    return getattr(_deadline, "at", None)


def past_deadline():
    """This thread's deadline has passed: a step that hasn't started shouldn't (time_left's floor is for the few
    that must run anyway)."""
    at = current_deadline()
    return at is not None and time.monotonic() >= at


def time_left(timeout, floor=1):
    """TIMEOUT, cut to what's left of this thread's deadline, but never below FLOOR: a step that has to run
    (an undo, a check of what a timed-out step did) still gets FLOOR seconds."""
    at = getattr(_deadline, "at", None)
    if at is None:
        return timeout
    return max(floor, min(timeout, at - time.monotonic()))


def plural(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")
