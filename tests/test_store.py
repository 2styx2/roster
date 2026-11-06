"""How roster.yml is kept (T212): a plain file or a team's git repo, told apart per file (store.at). A plain file's
edits save straight to it and it has nothing to pull, diff, discard or publish; a repo's are Pending changes."""

import os
import stat
import subprocess

import pytest

from roster import store
from roster.errors import NOTHING_TO_PUBLISH, Problem

TEXT = "groups:\n  lab:\n    hosts:\n      esx: 10.0.0.5\n"


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                          capture_output=True, text=True, check=True).stdout.strip()


@pytest.fixture
def plain(isolated):
    p = isolated["work"] / "roster.yml"
    p.write_text(TEXT)
    return p


def committed(path, remote=None):
    git(path.parent, "init", "-q", "-b", "main")
    git(path.parent, "add", path.name)
    git(path.parent, "commit", "-qm", "inventory")
    if remote:
        subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
        git(path.parent, "remote", "add", "origin", str(remote))
    return path


def test_a_file_outside_any_repo_is_a_plain_file(plain):
    s = store.at(plain)
    assert s.kind == "file" and s.path == plain.resolve()
    assert "isn't in a git repo" in s.note and "saves straight to it" in s.note


def test_a_plain_file_saves_in_place_and_keeps_a_backup_beside_it(plain):
    s = store.at(plain)
    backup = s.write(TEXT, TEXT.replace("10.0.0.5", "10.0.0.6"), sync=dict)[0]
    assert plain.read_text() == TEXT.replace("10.0.0.5", "10.0.0.6")
    assert backup == plain.with_name("roster.yml.bak") and backup.read_text() == TEXT


def test_a_plain_file_has_nothing_to_pull_diff_discard_or_publish(plain):
    s = store.at(plain)
    assert s.pull() == {"updated": False, "upstream": None, "commits": 0, "ahead": 0,
                        "message": "roster.yml is a plain file: there's nothing to pull"}
    assert s.diff() == {"path": str(plain.resolve()), "repo": None, "kind": "file", "diff": "", "hosts": [],
                        "groups": [], "count": 0, "message": "", "last_commit": None}
    assert s.discard() == {"discarded": False, "backup": None}
    with pytest.raises(Problem) as e:
        s.publish()
    assert e.value.code == NOTHING_TO_PUBLISH and "saved to it already" in e.value.message


def test_no_git_on_path_is_a_plain_file_even_inside_a_repo(plain, monkeypatch, tmp_path):
    committed(plain, tmp_path / "origin.git")
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    s = store.at(plain)
    assert s.kind == "file" and "git isn't installed" in s.note


def test_committed_in_a_repo_with_a_remote_is_a_repo(plain, tmp_path):
    committed(plain, tmp_path / "origin.git")
    s = store.at(plain)
    assert s.kind == "repo" and str(plain.parent.resolve()) in s.note
    backup = s.write(TEXT, TEXT + "# more\n", sync=dict)[0]
    assert backup == plain.parent.resolve() / ".git" / "roster" / "roster.yml.bak"
    assert git(plain.parent, "status", "--porcelain", "--untracked-files=no") == "M roster.yml"
    assert s.diff()["kind"] == "repo" and s.diff()["count"] == 1


def test_a_repo_without_a_remote_saves_in_place_with_the_backup_in_its_git_dir(plain):
    committed(plain)
    s = store.at(plain)
    assert s.kind == "file" and "no remote" in s.note
    assert s.write(TEXT, TEXT + "# more\n", sync=dict)[0] == plain.parent.resolve() / ".git" / "roster" / "roster.yml.bak"
    assert s.diff()["count"] == 0


def test_a_file_not_committed_in_a_repo_saves_in_place(plain, tmp_path):
    other = plain.with_name("README.md")
    other.write_text("x\n")
    committed(other, tmp_path / "origin.git")
    s = store.at(plain)
    assert s.kind == "file" and "isn't committed" in s.note
    assert s.view() == {"kind": "file", "note": s.note, "repo": str(plain.parent.resolve())}


# ---------------------------------------------------------------- PR #409's review: S1-S3

posix_only = pytest.mark.skipif(os.name == "nt", reason="symlinks and modes as POSIX has them")


@posix_only
def test_a_planted_backup_symlink_is_replaced_never_followed(plain, tmp_path):
    """S1: roster.yml.bak -> another file (a folder someone else made): the backup replaces the link itself."""
    victim = tmp_path / "victim"
    victim.write_text("keep me\n")
    plain.with_name("roster.yml.bak").symlink_to(victim)
    store.at(plain).write(TEXT, TEXT + "# more\n", sync=dict)[0]
    assert victim.read_text() == "keep me\n"
    bak = plain.with_name("roster.yml.bak")
    assert not bak.is_symlink() and bak.read_text() == TEXT


@posix_only
def test_a_planted_symlink_for_the_git_dirs_backup_folder_is_refused(plain, tmp_path):
    committed(plain, tmp_path / "origin.git")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (plain.parent / ".git" / "roster").symlink_to(elsewhere)
    with pytest.raises(Problem):
        store.at(plain).write(TEXT, TEXT + "# more\n", sync=dict)[0]
    assert list(elsewhere.iterdir()) == [] and plain.read_text() == TEXT       # nothing written anywhere


@posix_only
def test_the_backup_keeps_roster_yml_private(plain, tmp_path):
    """S2: a 0600 roster.yml's backup is 0600 too (in the git dir as well), whatever the umask."""
    plain.chmod(0o600)
    old = os.umask(0o022)
    try:
        bak = store.at(plain).write(TEXT, TEXT + "# more\n", sync=dict)[0]
        assert stat.S_IMODE(bak.stat().st_mode) == 0o600 and stat.S_IMODE(plain.stat().st_mode) == 0o600
        committed(plain, tmp_path / "origin.git")
        bak = store.at(plain).write(TEXT + "# more\n", TEXT, sync=dict)[0]
        assert stat.S_IMODE(bak.stat().st_mode) == 0o600
    finally:
        os.umask(old)


@posix_only
def test_detection_never_runs_the_repos_fsmonitor(plain, tmp_path):
    """S3: a folder's own .git/config can't make roster run a program (core.fsmonitor runs on reading the index)."""
    committed(plain, tmp_path / "origin.git")
    ran = tmp_path / "ran"
    git(plain.parent, "config", "core.fsmonitor", f"touch {ran}")
    assert store.at(plain).kind == "repo"
    store.at(plain).write(TEXT, TEXT + "# more\n", sync=dict)[0]
    store.at(plain).diff()
    assert not ran.exists()


def test_an_inherited_git_dir_never_decides(plain, tmp_path, monkeypatch):
    """S3: GIT_DIR from a dotfiles setup would make any file 'committed' in that repo: roster ignores it."""
    other = tmp_path / "dotfiles"
    other.mkdir()
    (other / "x").write_text("x\n")
    committed(other / "x", tmp_path / "dot-origin.git")
    monkeypatch.setenv("GIT_DIR", str(other / ".git"))
    monkeypatch.setenv("GIT_WORK_TREE", str(plain.parent))
    assert store.at(plain).kind == "file"


def test_git_that_hangs_or_fails_means_a_plain_file(plain, monkeypatch):
    """S3: detection that can't get an answer from git is a plain file, never an error on inventory.info."""
    from roster import changes

    def stuck(*a, **k):
        raise Problem(73, "git rev-parse didn't finish within 1 s")
    monkeypatch.setattr(changes, "git", stuck)
    assert store.at(plain, for_show=True).kind == "file"


# ---------------------------------------------------------------- #409's second pass: N1

def test_git_that_fails_refuses_a_save_rather_than_guess(plain, tmp_path, monkeypatch):
    """N1: in a team repo, git that can't answer must not make a write think it's a plain file (its backup would
    land in the work tree). Only what's read for show (inventory.info, check --box) falls back to plain."""
    from roster import changes
    committed(plain, tmp_path / "origin.git")
    real = changes.git

    def stuck(repo, *args, **kw):
        if "ls-files" in args:
            raise Problem(73, "git ls-files didn't finish within 1 s")
        return real(repo, *args, **kw)
    monkeypatch.setattr(changes, "git", stuck)
    with pytest.raises(Problem) as e:
        store.at(plain).write(TEXT, TEXT + "# more\n", sync=dict)[0]
    assert "won't save" in e.value.message and e.value.data["fix"]
    assert not plain.with_name("roster.yml.bak").exists() and plain.read_text() == TEXT
    shown = store.at(plain, for_show=True)
    assert shown.kind == "file" and "git didn't answer" in shown.note


def test_without_git_a_backup_still_goes_in_the_git_dir_of_a_work_tree(plain, tmp_path, monkeypatch):
    """N1: no git on PATH, but roster.yml sits in a work tree: the backup goes in its .git, never beside it."""
    committed(plain, tmp_path / "origin.git")
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    bak = store.at(plain).write(TEXT, TEXT + "# more\n", sync=dict)[0]
    assert bak == plain.parent.resolve() / ".git" / "roster" / "roster.yml.bak"
    assert not plain.with_name("roster.yml.bak").exists()
