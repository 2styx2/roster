"""The Box-wide lock (T240, #469, decision Q204): one run at a time changes this Box's keys or Mesh entries on an
Inventory's Hosts. `roster setup` (and `setup --rotate`), `revoke` and every Mesh path that writes (apply, cut,
`cut --all`, `mesh leftovers --remove`) hold it; each rewrites `authorized_keys` on the same Hosts (read, change,
write back), so two at once could each drop the other's new line. Read-only runs (`check`, `--dry-run`,
`mesh status`) never take it.

One lock file for the Box (context.BOX_FILES' lock), whatever the Inventory (T253, #499): two Inventories can hold
the same Host (one account's authorized_keys) under different key files, and nothing short of loading every
Inventory says which, so a run in one waits for a run in another. Locked with the OS's own file lock (flock; on Windows a byte range,
msvcrt.locking). The OS lets go of it when the process holding it ends, however it ends, so a lock whose run died
(a dead pid in the file) is free at once and taken over. The file says who holds it (pid and what, for the message
a second run gives), never a secret. A second run waits WAIT seconds, then refuses with code 205.

Re-entrant in one thread (setup holds it and its own Mesh apply takes it again); another thread of the same process
waits as another process would (serve's jobs)."""

from __future__ import annotations

import functools
import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .context import box_file
from .errors import BOX_BUSY, INVENTORY_THERE, Problem

WAIT = 5.0                  # seconds a second run waits before it refuses
POLL = 0.1
_REGION = 1 << 20           # Windows: the byte locked, past what the file says, so it can still be read
_held: dict[str, tuple[int, int, Any]] = {}     # path -> (thread id, depth, open file)
_table = threading.Lock()


def _try_lock(f) -> bool:
    if os.name == "nt":
        import msvcrt
        f.seek(_REGION)
        try:
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)  # pyright: ignore[reportAttributeAccessIssue]
            return True
        except OSError:
            return False
    import fcntl
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _unlock(f) -> None:
    if os.name == "nt":
        import msvcrt
        f.seek(_REGION)
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)  # pyright: ignore[reportAttributeAccessIssue]
    else:
        import fcntl
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def holder(path: Path) -> str:
    """Who the lock file at PATH says holds it: `WHAT, pid N`, or `pid unknown`."""
    try:
        pid, _, what = path.read_text(encoding="utf-8").partition("\n")
    except (OSError, UnicodeDecodeError):
        return "pid unknown"
    return f"{what.strip() or 'roster'}, pid {pid.strip() or 'unknown'}"


def busy(path: Path) -> Problem:
    return Problem(BOX_BUSY, f"another roster run ({holder(path)}) is changing Hosts: wait for it",
                   fix="wait for that run to finish, then run this again (one run at a time changes this Box's "
                       "keys and Mesh entries on the Hosts)")


@contextmanager
def first_run():
    """serve's inventory.create one at a time on this Box, whichever serve (#417 L3), so two app windows can't both
    make and name one: a lock file in roster's config folder, as the Inventories' own. Refuses at once (170) while
    another holds it."""
    path = box_file("first_run_lock")
    _take(path, "inventory.create", 0, lambda _: Problem(
        INVENTORY_THERE, "another first run is making an Inventory on this Box right now", {"lock": str(path)},
        fix="wait for it, then Retry"))
    try:
        yield
    finally:
        _release(str(path))


@contextmanager
def held(what: str, wait: float | None = None):
    """Hold the Box-wide lock while WHAT (`setup --rotate`, `mesh`) runs, whichever Inventories it changes. Waits
    WAIT seconds, then raises busy's Problem (205)."""
    path = box_file("lock")
    _take(path, what, WAIT if wait is None else wait)
    try:
        yield
    finally:
        _release(str(path))


def locking(what: str, unless=None):
    """A function decorated so it runs holding this run's Inventory's lock, as WHAT (`mesh cut`); UNLESS(*args,
    **kwargs) true: without it (a Mesh plan changes nothing)."""
    def wrap(f):
        @functools.wraps(f)
        def run(*args, **kwargs):
            if unless is not None and unless(*args, **kwargs):
                return f(*args, **kwargs)
            with held(what):
                return f(*args, **kwargs)
        return run
    return wrap


def _take(path: Path, what: str, wait: float, refused=busy) -> None:
    me = threading.get_ident()
    key = str(path)
    deadline = time.monotonic() + wait
    while True:
        with _table:
            mine = _held.get(key)
            if mine and mine[0] == me:
                _held[key] = (me, mine[1] + 1, mine[2])
                return
            if not mine:
                f = _open(path)                 # never truncated before it's ours: it names the holder
                if _try_lock(f):
                    f.seek(0)
                    f.truncate()
                    f.write(f"{os.getpid()}\n{what}\n")
                    f.flush()
                    _held[key] = (me, 1, f)
                    return
                f.close()
        if time.monotonic() >= deadline:
            raise refused(path)

        time.sleep(POLL)


def _open(path: Path):
    """The lock file, opened without following a link (#482's review LOW-5: never truncate what a link points at):
    O_NOFOLLOW on POSIX, a link refused before opening on Windows; anything but a plain file is refused (a Problem)."""
    import stat

    from .errors import ROSTER_ERROR
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    refuse = Problem(ROSTER_ERROR, f"{path}, roster's lock file, isn't a plain file (a link, or another kind): "
                     "nothing was changed", fix=f"remove {path} (roster makes it again)")
    if os.name == "nt" and (path.is_symlink() or (path.exists() and not path.is_file())):
        raise refuse
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
                     | getattr(os, "O_BINARY", 0), 0o600)
    except OSError:
        raise refuse from None
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink > 1:     # a hard link is another file's name too
        os.close(fd)
        raise refuse
    return os.fdopen(fd, "r+", encoding="utf-8", newline="\n")


def _release(key: str) -> None:
    with _table:
        me, depth, f = _held[key]
        if depth > 1:
            _held[key] = (me, depth - 1, f)
            return
        del _held[key]
        try:
            _unlock(f)
        finally:
            f.close()
