"""`roster sync` for this Box after roster changed roster.yml (T150, T153): its ssh config and Claude files follow the
Inventory as it loads now. Shared by serve's writes and the CLI's (`roster discover --write`, `roster mesh cut`), so
both report a failure the same way and neither undoes the change over it."""

import sys

from .claude import write_claude_files
from .common import die_message, failure_text
from .config import load_config
from .errors import Problem
from .sshops import write_ssh_config

FIX = "run `roster sync` on this box"


def sync(load):
    """Load the Inventory with LOAD() and write this Box's ssh config and Claude files from it: `{ok: true}`, or
    `{ok: false, error, fix}` for anything that went wrong (a Problem or a die() keeps its own words, an OSError its
    own (paths only), anything else just its type). Never raises: the change is written already."""
    try:
        cfg = load()
        write_ssh_config(cfg)
        write_claude_files(cfg)
        return {"ok": True}
    except Exception as e:              # anything at all: the change is written already (and serve's watcher must live)
        why = e.message if isinstance(e, Problem) else failure_text(e)
        return {"ok": False, "error": why, "fix": FIX}
    except SystemExit as e:             # a die() isn't an Exception
        return {"ok": False, "error": die_message(e), "fix": FIX}


def after_edit(path):
    """The CLI after it wrote roster.yml at PATH: sync this Box from the file as it is now. A failure leaves the edit
    as it is and says so on stderr, with the fix; the command's exit code is the edit's."""
    r = sync(lambda: load_config(path))
    if not r["ok"]:
        print(f"warning: this Box's ssh config didn't follow roster.yml ({r['error']}): {r['fix']}",
              file=sys.stderr, flush=True)
    return r
