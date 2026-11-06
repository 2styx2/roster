"""`roster sync` for this Box after roster changed roster.yml (T150, T153): its ssh config and Claude files follow the
Inventory as it loads now. Every write through store.py runs it, serve's and the CLI's, so both report a failure the
same way and neither undoes the change over it."""

import sys

from .claude import write_claude_files
from .common import failure_text
from .config import load_config
from .errors import Exit, Problem, problem_of
from .sshops import write_ssh_config

FIX = "run `roster sync` on this box"


def sync(load):
    """Load the Inventory with LOAD() and write this Box's ssh config and Claude files from it: `{ok: true}`, or
    `{ok: false, error, fix}` for anything that went wrong (a Problem or a die() keeps its own words, an OSError its
    own (paths only), anything else just its type). Never raises: the change is written already."""
    def run():
        cfg = load()
        write_ssh_config(cfg)
        write_claude_files(cfg)
        return {"ok": True}
    return guarded(run)


def guarded(sync):
    """SYNC()'s answer, or `{ok: false, error, fix}` for anything it raised (a Problem or a die() keeps its own words,
    an OSError its own (paths only), anything else just its type)."""
    try:
        return sync()
    except (Problem, Exit) as e:        # a die() isn't an Exception
        return {"ok": False, "error": problem_of(e).message, "fix": FIX}
    except Exception as e:              # anything at all: the change is written already (and serve's watcher must live)
        return {"ok": False, "error": failure_text(e), "fix": FIX}


def sync_file(path):
    """sync() from roster.yml at PATH as it is now."""
    return sync(lambda: load_config(path))


def warn(r):
    """The CLI after a write: a sync R that failed is said on stderr, with the fix (the edit stays as it is, and the
    command's exit code is the edit's)."""
    if not r["ok"]:
        print(f"warning: this Box's ssh config didn't follow roster.yml ({r['error']}): {r['fix']}",
              file=sys.stderr, flush=True)
    return r
