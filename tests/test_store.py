"""How roster.yml is kept (T212): a plain file or a team's git repo, told apart per file (store.at). A plain file's
edits save straight to it and it has nothing to pull, diff, discard or publish; a repo's are Pending changes."""

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
    backup = s.save(TEXT, TEXT.replace("10.0.0.5", "10.0.0.6"))
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
    assert s.save(TEXT, TEXT + "# more\n") == plain.with_name("roster.yml.bak")


def test_committed_in_a_repo_with_a_remote_is_a_repo(plain, tmp_path):
    committed(plain, tmp_path / "origin.git")
    s = store.at(plain)
    assert s.kind == "repo" and str(plain.parent.resolve()) in s.note
    backup = s.save(TEXT, TEXT + "# more\n")
    assert backup == plain.parent.resolve() / ".git" / "roster" / "roster.yml.bak"
    assert git(plain.parent, "status", "--porcelain", "--untracked-files=no") == "M roster.yml"
    assert s.diff()["kind"] == "repo" and s.diff()["count"] == 1


def test_a_repo_without_a_remote_saves_in_place_with_the_backup_in_its_git_dir(plain):
    committed(plain)
    s = store.at(plain)
    assert s.kind == "file" and "no remote" in s.note
    assert s.save(TEXT, TEXT + "# more\n") == plain.parent.resolve() / ".git" / "roster" / "roster.yml.bak"
    assert s.diff()["count"] == 0


def test_a_file_not_committed_in_a_repo_saves_in_place(plain, tmp_path):
    other = plain.with_name("README.md")
    other.write_text("x\n")
    committed(other, tmp_path / "origin.git")
    s = store.at(plain)
    assert s.kind == "file" and "isn't committed" in s.note
    assert s.view() == {"kind": "file", "note": s.note, "repo": str(plain.parent.resolve())}
