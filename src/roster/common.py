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
from contextlib import contextmanager
from pathlib import Path
from typing import IO, Any, NoReturn, cast

KEY_TAG = "roster-managed"
LEGACY_KEY_TAGS = ("fleet-managed",)       # tags used by earlier versions; still recognized
# the end of a Box key line's ERE: spaces or a CR may follow the tag (a file edited on Windows), and sshd still reads
# the line (T226, #435). POSIX only: winhost's script trims each line first, and .NET has no [[:space:]]
KEY_TRAIL = "[[:space:]]*$"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\Z")   # \Z: a trailing newline is not part of a name
WINDOWS = os.name == "nt"                  # roster running natively on Windows (not in WSL)


def ssh_dir() -> Path:
    return Path.home() / ".ssh"


# The named Inventory this run uses (ticket 115): its own generated ssh config and known_hosts, so syncing one never
# wipes another's. None (no named Inventories, or a roster.yml that isn't one of them): the files roster always wrote.
# config.find_config sets it as it finds roster.yml; one process uses one Inventory (serve restarts to switch).
_inventory: str | None = None
_config_path: Path | None = None       # the roster.yml this run uses, set with _inventory (None: not looked up)
_CURRENT = object()
CURRENT = _CURRENT          # "this run's Inventory", for a function that takes an Inventory's name or this default


def use_inventory(name: str | None, path: Path | None = None) -> None:
    global _inventory, _config_path
    _inventory = name
    _config_path = Path(path) if path is not None else None


def current_inventory() -> str | None:
    return _inventory


def current_config_path() -> Path | None:
    """The roster.yml this run uses, as config.find_config found it (None when nothing looked one up)."""
    return _config_path


def ssh_config_file(name: Any = _CURRENT) -> Path:
    """roster's generated ssh config for the Inventory NAME (default: the one this run uses)."""
    name = _inventory if name is _CURRENT else name
    if name is None:
        return ssh_dir() / "config.d" / "roster"
    # Not in config.d: a user's `Include ~/.ssh/config.d/*` would read it beside the index, and a Host the index
    # leaves out (a name clash) would add its IdentityFile again (PR #335's review, N3).
    return ssh_dir() / "roster-inventories" / name


def legacy_ssh_config_file(name: str) -> Path:
    """Where a named Inventory's ssh config was before it moved out of config.d."""
    return ssh_dir() / "config.d" / f"roster-{name}"


def known_hosts_file(name: Any = _CURRENT) -> Path:
    """roster's known_hosts for the Inventory NAME (default: the one this run uses)."""
    name = _inventory if name is _CURRENT else name
    return ssh_dir() / ("roster_known_hosts" if name is None else f"roster_known_hosts-{name}")


def mesh_state_file(name: Any = _CURRENT) -> Path:
    """roster's Mesh state for the Inventory NAME (default: the one this run uses): ~/.config/roster/mesh.json for a
    roster.yml that isn't named, as always, and mesh-NAME.json beside it for a named one (T182, #346), so two
    Inventories never share it."""
    name = _inventory if name is _CURRENT else name
    return user_config_dir() / ("mesh.json" if name is None else f"mesh-{name}.json")


def key_name_file(name: Any = _CURRENT) -> Path:
    """The Box name this Box's key lines on the Inventory NAME's Hosts were last all tagged with (T217, #412), so
    `roster setup` sees box_name: (or the hostname) changed: ~/.config/roster/key-name, or key-name-NAME for a named
    Inventory (each Inventory has its own box_name:)."""
    name = _inventory if name is _CURRENT else name
    return user_config_dir() / ("key-name" if name is None else f"key-name-{name}")


def rotation_file(name: Any = _CURRENT) -> Path:
    """The Box key rotation's pending record for the Inventory NAME (T240, #469): ~/.config/roster/key-rotation, or
    key-rotation-NAME for a named Inventory, beside key-name and never in mesh.json: the Hosts not finished yet."""
    name = _inventory if name is _CURRENT else name
    return user_config_dir() / ("key-rotation" if name is None else f"key-rotation-{name}")


def lock_file(name: Any = _CURRENT) -> Path:
    """The Box-wide lock for the Inventory NAME (T240): ~/.config/roster/run.lock, or run-NAME.lock, held by every run
    that changes this Box's keys or Mesh entries on its Hosts (boxlock)."""
    name = _inventory if name is _CURRENT else name
    return user_config_dir() / ("run.lock" if name is None else f"run-{name}.lock")


def key_created_file() -> Path:
    """When roster made or rotated each of this Box's keys (T240): ~/.config/roster/key-created, a line per key file
    (`ISO-TIME<TAB>PATH`); one key file serves every Inventory that names it, so one record for the Box."""
    return user_config_dir() / "key-created"


def known_hosts_label():
    """known_hosts_file() as messages name it: ~/.ssh/roster_known_hosts (or -NAME)."""
    return f"~/.ssh/{known_hosts_file().name}"


def ssh_index_file() -> Path:
    """With named Inventories: the file ~/.ssh/config includes, which includes each one's ssh config, the active
    one's first (named Inventories' own files are in ~/.ssh/roster-inventories/)."""
    return ssh_dir() / "config.d" / "roster.inventories"


def user_config_dir() -> Path:
    """roster's own folder: ~/.config/roster, or %APPDATA%\\roster on Windows (where the app's init.lua is too)."""
    if WINDOWS:
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "roster"
    return Path.home() / ".config" / "roster"


# What may never go into a value roster writes into an ssh config file: a quote would end the value and a control
# character (a newline above all) the line, so the rest would be read as directives of its own (PR #335's review, P1).
SSH_UNSAFE = re.compile(r'["\x00-\x1f\x7f]')


class NotPrivate(Exception):
    """read_private: the file is there, but it isn't only yours (the message says how)."""


PRIVATE_MAX = 64 * 1024        # read_private: a secret's file is small (a bw session key is about 88 bytes)


def never_look_in_the_current_folder() -> None:
    """Windows: tell Windows itself never to look in the current folder for a program (#424 M1), for roster and all it
    starts. find_program already keeps it out of what roster runs by name; this covers what goes through cmd.exe (a
    `cmd:` provider, a `providers:` command template), what Python 3.12+'s shutil.which would find, and the programs
    roster's programs start (a bw.cmd's node). A no-op elsewhere."""
    if WINDOWS:
        os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"


def read_private(path: Path) -> str:
    """PATH's text (UTF-8), as read_private_bytes reads it."""
    return read_private_bytes(path).decode("utf-8", "replace")


def read_private_bytes(path: Path) -> bytes:
    """PATH's bytes, read only if it's yours alone (#411), as a secret's file must be: opened without following a link,
    then checked and read through that one open file, so it can't be swapped between the check and the read. On Linux
    and macOS: a plain file (not a link, FIFO or device), owned by you, with no group or other bits. On Windows
    (roster/winfile.py): a plain file (not a link or other reparse point), owned by you, that no one but you, SYSTEM
    and Administrators may open. Either way it has one name (no hard link elsewhere) and is at most PRIVATE_MAX bytes.
    Only the file itself is checked, not the folders it's in. FileNotFoundError if there's nothing there; NotPrivate if
    it isn't yours alone or can't be read (whatever went wrong: never a traceback)."""
    if WINDOWS:
        from . import winfile
        try:
            return winfile.read_private_bytes(str(path))
        except (FileNotFoundError, NotPrivate):
            raise
        except OSError as e:
            raise NotPrivate(f"{path} can't be read ({e.strerror or type(e).__name__})") from None
    import stat
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOCTTY", 0)
    try:
        fd = os.open(path, flags)
    except OSError as e:
        if isinstance(e, FileNotFoundError):
            raise
        if os.path.islink(path):
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


def replace_file(path: Path, text: str, mode: int = 0o600) -> None:
    """Write TEXT to PATH whole or not at all: a new file beside it (a name of its own, so two writers can't take each
    other's), then renamed over it, with MODE (0600: ~/.ssh/config as roster always left it, since OpenSSH refuses one
    others can write). A symlink is followed, so its target is what changes."""
    import tempfile
    target = Path(os.path.realpath(path))
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    keep = mode
    fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".new", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.chmod(tmp, keep)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def ssh_path(path: str | Path) -> str:
    """PATH as ssh reads it in its config and -o values: as is, but with forward slashes on Windows (Windows'
    OpenSSH takes C:/Users/..., and a backslash is an escape character in some of its option values)."""
    return Path(path).as_posix() if WINDOWS else str(path)


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
    if not WINDOWS or "/" in name or "\\" in name:
        return shutil.which(name)
    # only what CreateProcess can start: PATHEXT also lists .JS, .VBS, .MSC, .PY... (#424 L2)
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
    return (find_program("git.exe") or "git") if WINDOWS else "git"


def program_argv(argv):
    """ARGV ready for subprocess. On Windows the program is looked up on PATH alone with its extension (find_program: a
    tool installed as bw.cmd is found as bw, one in the current folder never is; FileNotFoundError if it isn't on
    PATH, as subprocess would raise, rather than leave Windows to look in the current folder), and a .cmd or .bat
    program is refused an argument cmd.exe would act on: roster passes item names and paths there, and those come from
    roster.yml and the vault."""
    if not WINDOWS:
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
    if WINDOWS:
        # Windows' own, by its full path: PATH may lack System32 (#424 L4)
        taskkill = os.path.join(os.environ.get("SystemRoot") or r"C:\Windows", "System32", "taskkill.exe")
        try:
            subprocess.run([taskkill, "/F", "/T", "/PID", str(p.pid)], capture_output=True)
        except OSError:
            pass
    try:
        p.kill()
    except OSError:
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
    return {k: os.environ[k] for k in ("SYSTEMROOT",) if k in os.environ} if WINDOWS else {}


def run_filtered(producer, filt, timeout=None, env=None, filter_env=None):
    """PRODUCER's stdout connected straight to FILT's stdin, an OS pipe between the two child processes: this process
    never reads a byte PRODUCER prints (Q191: `bw list items`, which prints every password). It reads FILT's stdout
    and both programs' stderr (PRODUCER's up to STDERR_CAP). ENV: PRODUCER's environment (default this process's);
    FILTER_ENV: FILT's (default this process's). Returns (PRODUCER's CompletedProcess with stdout None, FILT's).
    A timeout kills both process trees, then raises subprocess.TimeoutExpired."""
    import threading
    import time
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
    if not WINDOWS:
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


def die(msg: str) -> NoReturn:
    sys.exit(f"error: {msg}")


def die_message(e):
    """The text of a die() (SystemExit("error: ...")), without the prefix."""
    msg = str(e.code) if e.code is not None else "exited"
    return msg.removeprefix("error: ")


def failure_text(e):
    """What went wrong, safe to show: an OSError's own words (paths only), else just the exception's type."""
    if isinstance(e, OSError):
        return f"{e.strerror or type(e).__name__}" + (f": {e.filename}" if e.filename else "")
    return type(e).__name__


def not_reviewed(h):
    """Why roster won't log in to a Host discover found (`roster run`, `roster serve` session.prepare)."""
    return f"{h['name']} is not reviewed yet (reviewed: false in roster.yml) - not logging in"


def say(msg=""):
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
