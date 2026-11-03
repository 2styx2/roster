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
from typing import Any, NoReturn

KEY_TAG = "roster-managed"
LEGACY_KEY_TAGS = ("fleet-managed",)       # tags used by earlier versions; still recognized
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
WINDOWS = os.name == "nt"                  # roster running natively on Windows (not in WSL)


def ssh_dir() -> Path:
    return Path.home() / ".ssh"


# The named Inventory this run uses (ticket 115): its own generated ssh config and known_hosts, so syncing one never
# wipes another's. None (no named Inventories, or a roster.yml that isn't one of them): the files roster always wrote.
# config.find_config sets it as it finds roster.yml; one process uses one Inventory (serve restarts to switch).
_inventory: str | None = None
_CURRENT = object()


def use_inventory(name):
    global _inventory
    _inventory = name


def current_inventory() -> str | None:
    return _inventory


def ssh_config_file(name: Any = _CURRENT) -> Path:
    """roster's generated ssh config for the Inventory NAME (default: the one this run uses)."""
    name = _inventory if name is _CURRENT else name
    return ssh_dir() / "config.d" / ("roster" if name is None else f"roster-{name}")


def known_hosts_file(name: Any = _CURRENT) -> Path:
    """roster's known_hosts for the Inventory NAME (default: the one this run uses)."""
    name = _inventory if name is _CURRENT else name
    return ssh_dir() / ("roster_known_hosts" if name is None else f"roster_known_hosts-{name}")


def known_hosts_label():
    """known_hosts_file() as messages name it: ~/.ssh/roster_known_hosts (or -NAME)."""
    return f"~/.ssh/{known_hosts_file().name}"


def ssh_index_file() -> Path:
    """With named Inventories: the file ~/.ssh/config includes, which includes each one's ssh config, the active
    one's first (its name can't be a named Inventory's: those are roster-NAME)."""
    return ssh_dir() / "config.d" / "roster.inventories"


def user_config_dir() -> Path:
    """roster's own folder: ~/.config/roster, or %APPDATA%\\roster on Windows (where the app's init.lua is too)."""
    if WINDOWS:
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "roster"
    return Path.home() / ".config" / "roster"


def ssh_path(path: str | Path) -> str:
    """PATH as ssh reads it in its config and -o values: as is, but with forward slashes on Windows (Windows'
    OpenSSH takes C:/Users/..., and a backslash is an escape character in some of its option values)."""
    return Path(path).as_posix() if WINDOWS else str(path)


# ---------------------------------------------------------------- starting other programs (Windows too)

# What cmd.exe acts on in a command line. A .cmd or .bat program (npm installs bw as bw.cmd) runs through cmd.exe,
# which reads these in its arguments whatever the quoting, so an argument with one could run something else.
CMD_SPECIAL = re.compile(r'["%^&|<>!\r\n]')


def program_argv(argv):
    """ARGV ready for subprocess. On Windows the program is looked up on PATH with its extension (a tool installed as
    bw.cmd is found as bw), and a .cmd or .bat program is refused an argument cmd.exe would act on: roster passes
    item names and paths there, and those come from roster.yml and the vault."""
    if not WINDOWS:
        return list(argv)
    found = shutil.which(argv[0]) or argv[0]
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
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True)
    try:
        p.kill()
    except OSError:
        pass


def run(args, timeout=None, input=None, **kw):
    """subprocess.run with capture_output, but a timeout kills the whole process tree (kill_tree) before it waits for
    the output, so a tool's leftover child can't hold the call past its timeout."""
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
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
    if shutil.which("roster"):
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
