"""How roster.yml is kept (T212, decision Q182): a plain file, or committed in a team's git repo. The one place that
tells them apart (`at(path)`, per file, every time: nothing is cached) and knows how each one saves.

- **repo**: roster.yml is committed in a git work tree that has a remote. Today's Pending changes, exactly: an edit
  is written as an uncommitted change, its backup kept in the repo's git dir, and pull/diff/discard/publish are
  changes.py's.
- **file**: everything else (git isn't installed, roster.yml isn't in a work tree, isn't committed there, or the repo
  has no remote to publish to). An edit saves straight to the file; there's nothing to pull, diff, discard or
  publish, and nothing nags about git. The backup goes in the git dir when there is one (never into a work tree,
  where `git add -A` would pick it up), else beside the file as roster.yml.bak (as `roster discover --write`'s).

Every caller (serve's edits, `roster discover --write`, `roster add`, the Mesh's cut, `roster check --box`) asks this
module and never branches on git itself. A write through write() is followed by this Box's `roster sync` (boxsync.py),
so no caller has to remember it."""

import subprocess
from pathlib import Path

from . import boxsync, changes
from .common import find_program, replace_file
from .config import HIDDEN_FILE
from .edit import keep_backup
from .errors import NOTHING_TO_PUBLISH, PATH_NOT_REPEATED, ROSTER_ERROR, Problem

REPO, FILE = "repo", "file"


class Store:
    """roster.yml at PATH and how it's kept. KIND is REPO or FILE; NOTE says which, in a sentence (`roster check
    --box`); TOP is the work tree it's in (or None). HIDDEN: PATH is a roster.yml config.shown_path hides (#529), so
    nothing this returns or raises names it, its folder or its work tree."""

    kind = FILE

    def __init__(self, path, note, top=None, git_dir=None, hidden=False):
        self.path = Path(path).resolve()
        self.note = note
        self.top = top
        self.git_dir = git_dir
        self.hidden = hidden

    def shown(self):
        """{path, repo} as a result may name them: PATH_NOT_REPEATED for a hidden one's (repo stays None outside
        one, so the app still tells a plain file from a repo)."""
        top = None if self.top is None else PATH_NOT_REPEATED if self.hidden else str(self.top)
        return {"path": PATH_NOT_REPEATED if self.hidden else str(self.path), "repo": top}

    def shown_backup(self, bak):
        """BAK (a backup's path, or None) as a result may name it: PATH_NOT_REPEATED for a hidden one's (#538), kept
        beside it or in its work tree's git dir."""
        return None if bak is None else PATH_NOT_REPEATED if self.hidden else str(bak)

    def view(self):
        """{kind, note, repo}: for serve's inventory.info and `roster check --box`."""
        return {"kind": self.kind, "note": self.note, "repo": self.shown()["repo"]}

    def backup(self, text):
        """Keep TEXT (what an edit is about to replace) as the backup; returns its path."""
        bak = (self.git_dir / "roster" if self.git_dir is not None else self.path.parent) / (self.path.name + ".bak")
        return keep_backup(bak, text, self.path)

    def _save(self, old_text, new_text):
        """Write an edit of roster.yml: OLD_TEXT (what it held) kept as the backup, then NEW_TEXT all at once (mode
        kept). In a repo that's a Pending change; a plain file is saved. Returns the backup's path."""
        bak = self.backup(old_text)
        replace_file(self.path, new_text, like=self.path, follow=False)
        return bak

    def write(self, old_text, new_text, then=None, sync=None):
        """_save(), THEN(the backup's path) (what the caller says once it's written), then this Box's `roster sync`:
        SYNC() (default: boxsync's, from the file as it is now; serve's: from its loaded Inventory). Returns (the
        backup's path, the sync's `{ok, ...}`); a sync that fails never undoes the write."""
        bak = self._save(old_text, new_text)
        if then is not None:
            then(bak)
        return bak, boxsync.guarded(sync or (lambda: boxsync.sync_file(self.path)))

    def pull(self):
        return {"updated": False, "upstream": None, "commits": 0, "ahead": 0,
                "message": f"{self.path.name} is a plain file: there's nothing to pull"}

    def diff(self):
        return {**self.shown(), "repo": None, "kind": FILE, "diff": "", "hosts": [], "groups": [],
                "count": 0, "message": "", "last_commit": None}

    def discard(self):
        return {"discarded": False, "backup": None}

    def publish(self, message=None):
        raise Problem(NOTHING_TO_PUBLISH, f"{named(self.path, self.hidden)} is a plain file, so every edit is saved "
                                          "to it already and there's nothing to publish", {"path": self.shown()["path"]},
                      fix="nothing to do; to publish from the app, keep it in a git repo with a remote")


class RepoStore(Store):
    """roster.yml committed in a git repo with a remote: Pending changes (changes.py)."""

    kind = REPO

    def __init__(self, repo, hidden=False):
        where = "its git repo (not repeated)" if hidden else f"the git repo {repo.top}"
        super().__init__(repo.path, f"in {where}: edits are Pending changes until you Publish them", repo.top,
                         repo.git_dir, hidden)
        self.repo = repo

    def backup(self, text):
        return self.repo.backup(text)

    def pull(self):
        return changes.pull(self.path, self.hidden)

    def diff(self):
        return {**changes.diff(self.path), **self.shown(), "kind": REPO}

    def discard(self):
        result = changes.discard(self.path, self.hidden)
        return {**result, "backup": self.shown_backup(result["backup"])}

    def publish(self, message=None):
        return changes.publish(self.path, message, self.hidden)


def named(path, hidden):
    """PATH's file name as a message says it: a hidden one's (it may be the token itself) never (#529)."""
    return HIDDEN_FILE if hidden else path.name


def at(path, for_show=False, hidden=False):
    """How roster.yml at PATH is kept, as the disk and git say now. git that can't answer (it hangs on a slow mount,
    or fails) refuses a write: guessing 'plain' there would put a team repo's backup in its work tree (#409 N1).
    FOR_SHOW (inventory.info, `roster check --box`: nothing is written) says it's a plain file instead, never an
    error (the app asks on every connect). HIDDEN: the Inventory's `hidden` (config.shown_file's), so nothing names
    PATH (#529)."""
    path = Path(path).resolve()
    try:
        return detect(path, hidden)
    except (Problem, OSError, subprocess.SubprocessError) as e:
        if for_show:
            return Store(path, f"{named(path, hidden)} is kept as a plain file for now (git didn't answer): every "
                               "edit saves straight to it", None, work_tree_git_dir(path), hidden)
        why = e.message if isinstance(e, Problem) else type(e).__name__
        look = "`git status` in its folder, in a terminal," if hidden else f"`git -C {path.parent} status` in a terminal"
        raise Problem(ROSTER_ERROR, f"git didn't answer about {named(path, hidden)} ({why}), so roster won't save the "
                                    "edit: it can't tell whether it's in a team repo",
                      {"path": PATH_NOT_REPEATED if hidden else str(path)},
                      fix=f"try again; {look} shows what git is doing") from None


def work_tree_git_dir(path):
    """The .git folder of the work tree PATH is in, found without git (for a backup that must stay out of the work
    tree), or None. A .git file (a worktree, a submodule) isn't followed: then there's none."""
    for d in path.parents:
        g = d / ".git"
        if g.is_dir() and not g.is_symlink():
            return g
        if g.exists():
            return None
    return None


def detect(path, hidden=False):
    name = named(path, hidden)
    if find_program("git") is None:
        return Store(path, f"git isn't installed on this Box, so {name} is a plain file: every edit saves straight "
                           "to it", None, work_tree_git_dir(path), hidden)
    r = changes.git(path.parent, "rev-parse", "--show-toplevel", "--absolute-git-dir")
    lines = r.stdout.splitlines() if r.returncode == 0 else []
    if len(lines) != 2:
        return Store(path, f"{name} isn't in a git repo, so it's a plain file: every edit saves straight to it",
                     hidden=hidden)
    top, git_dir = Path(lines[0]).resolve(), Path(lines[1])
    where = "its git repo (not repeated)" if hidden else str(top)
    try:
        rel = path.relative_to(top).as_posix()
    except ValueError:                                  # git names the top another way (a drive letter's case)
        return Store(path, f"{name} is kept as a plain file: every edit saves straight to it", top, git_dir, hidden)
    if changes.git(top, "ls-files", "--error-unmatch", "--", rel).returncode != 0:
        return Store(path, f"{name if hidden else rel} isn't committed in {where}, so it's kept as a plain file: every "
                           "edit saves straight to it (commit it once for Pending changes and Publish)", top, git_dir,
                     hidden)
    if not changes.out(top, "remote"):
        return Store(path, f"{'Its git repo (not repeated)' if hidden else top} has no remote, so {name} is kept as a "
                           "plain file: every edit saves straight to it (commit when you like; add a remote for "
                           "Pending changes and Publish)", top, git_dir, hidden)
    return RepoStore(changes.Repo(path, hidden), hidden)
