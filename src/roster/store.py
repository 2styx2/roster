"""How roster.yml is kept (T212, decision Q182): a plain file, or committed in a team's git repo. The one place that
tells them apart (`at(path)`, per file, every time: nothing is cached) and knows how each one saves.

- **repo**: roster.yml is committed in a git work tree that has a remote. Today's Pending changes, exactly: an edit
  is written as an uncommitted change, its backup kept in the repo's git dir, and pull/diff/discard/publish are
  changes.py's.
- **file**: everything else (git isn't installed, roster.yml isn't in a work tree, isn't committed there, or the repo
  has no remote to publish to). An edit saves straight to the file; there's nothing to pull, diff, discard or
  publish, and nothing nags about git. The backup goes in the git dir when there is one (never into a work tree,
  where `git add -A` would pick it up), else beside the file as roster.yml.bak (as `roster discover --write`'s).

Every caller (serve's edits, `roster discover --write`, the Mesh's cut, `roster check --box`) asks this module and
never branches on git itself."""

import shutil
import subprocess
from pathlib import Path

from . import changes, edit
from .errors import NOTHING_TO_PUBLISH, Problem

REPO, FILE = "repo", "file"


class Store:
    """roster.yml at PATH and how it's kept. KIND is REPO or FILE; NOTE says which, in a sentence (`roster check
    --box`); TOP is the work tree it's in (or None)."""

    kind = FILE

    def __init__(self, path, note, top=None, git_dir=None):
        self.path = Path(path).resolve()
        self.note = note
        self.top = top
        self.git_dir = git_dir

    def view(self):
        """{kind, note, repo}: for serve's inventory.info and `roster check --box`."""
        return {"kind": self.kind, "note": self.note, "repo": str(self.top) if self.top else None}

    def backup(self, text):
        """Keep TEXT (what an edit is about to replace) as the backup; returns its path."""
        if self.git_dir is not None:
            d = self.git_dir / "roster"
            d.mkdir(exist_ok=True)
            bak = d / (self.path.name + ".bak")
        else:
            bak = self.path.with_name(self.path.name + ".bak")
        edit.write_text(bak, text)
        return bak

    def save(self, old_text, new_text):
        """Write an edit of roster.yml: OLD_TEXT (what it held) kept as the backup, then NEW_TEXT all at once (mode
        kept). In a repo that's a Pending change; a plain file is saved. Returns the backup's path."""
        bak = self.backup(old_text)
        edit.replace_file(self.path, new_text)    # edit's, looked up now (a test stands in for it)
        return bak

    def pull(self):
        return {"updated": False, "upstream": None, "commits": 0, "ahead": 0,
                "message": f"{self.path.name} is a plain file: there's nothing to pull"}

    def diff(self):
        return {"path": str(self.path), "repo": None, "kind": FILE, "diff": "", "hosts": [], "groups": [],
                "count": 0, "message": "", "last_commit": None}

    def discard(self):
        return {"discarded": False, "backup": None}

    def publish(self, message=None):
        raise Problem(NOTHING_TO_PUBLISH, f"{self.path.name} is a plain file, so every edit is saved to it already "
                                          "and there's nothing to publish", {"path": str(self.path)},
                      fix="nothing to do; to publish from the app, keep it in a git repo with a remote")


class RepoStore(Store):
    """roster.yml committed in a git repo with a remote: Pending changes (changes.py)."""

    kind = REPO

    def __init__(self, repo):
        super().__init__(repo.path, f"in the git repo {repo.top}: edits are Pending changes until you Publish them",
                         repo.top, repo.git_dir)
        self.repo = repo

    def backup(self, text):
        return self.repo.backup(text)

    def pull(self):
        return changes.pull(self.path)

    def diff(self):
        return {**changes.diff(self.path), "kind": REPO}

    def discard(self):
        return changes.discard(self.path)

    def publish(self, message=None):
        return changes.publish(self.path, message)


def at(path):
    """How roster.yml at PATH is kept, as the disk and git say now."""
    path = Path(path).resolve()
    name = path.name
    if shutil.which("git") is None:
        return Store(path, f"git isn't installed on this Box, so {name} is a plain file: every edit saves straight "
                           "to it")
    top = changes.out(path.parent, "rev-parse", "--show-toplevel")
    if top is None:
        return Store(path, f"{name} isn't in a git repo, so it's a plain file: every edit saves straight to it")
    top = Path(top).resolve()
    git_dir = Path(changes.out(top, "rev-parse", "--absolute-git-dir") or top / ".git")
    try:
        rel = path.relative_to(top).as_posix()
    except ValueError:                                  # git names the top another way (a drive letter's case)
        return Store(path, f"{name} is kept as a plain file: every edit saves straight to it", top, git_dir)
    if changes.git(top, "ls-files", "--error-unmatch", "--", rel).returncode != 0:
        return Store(path, f"{rel} isn't committed in {top}, so it's kept as a plain file: every edit saves straight "
                           "to it (commit it once for Pending changes and Publish)", top, git_dir)
    if not changes.out(top, "remote"):
        return Store(path, f"{top} has no remote, so {name} is kept as a plain file: every edit saves straight to it "
                           "(commit when you like; add a remote for Pending changes and Publish)", top, git_dir)
    try:
        return RepoStore(changes.Repo(path))
    except (Problem, subprocess.SubprocessError):       # it moved under us: a plain file is the safe answer
        return Store(path, f"{name} is kept as a plain file: every edit saves straight to it", top, git_dir)
