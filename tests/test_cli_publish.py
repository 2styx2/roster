"""`roster changes`, `changes discard`, `publish` and `pull` (#563): the Pending changes of a team-repo Inventory on
the command line, through the same store.py/changes.py serve's changes.diff/discard/publish and inventory.pull use.
A scratch infra repo (this Box's clone of a bare origin, and a second clone where someone else publishes) and plain
files only; no network, no real inventory."""

import json
import subprocess
from pathlib import Path

import pytest

from roster.cli import main

YML = """\
defaults:
  user: ops
groups:
  lab:
    auth: env:LAB_PW
    hosts:
      esx-02: {ip: 10.0.0.5}
"""


class Infra(type(Path())):
    """roster.yml's path, with .other: a second clone of its origin."""


def git(cwd, *args):
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@pytest.fixture
def infra(write_config, tmp_path, monkeypatch):
    """roster.yml committed in this Box's clone of a bare origin (the folder write_config uses), pushed; .other is a
    second clone where someone else publishes."""
    for k, v in {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t",
                 "GIT_COMMITTER_EMAIL": "t@example.com", "GIT_CONFIG_NOSYSTEM": "1"}.items():
        monkeypatch.setenv(k, v)
    yml = Infra(write_config(YML))
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    git(yml.parent, "init", "-q", "-b", "main")
    git(yml.parent, "add", "roster.yml")
    git(yml.parent, "commit", "-qm", "inventory")
    git(yml.parent, "remote", "add", "origin", str(origin))
    git(yml.parent, "push", "-q", "-u", "origin", "main")
    yml.other = tmp_path / "other"
    subprocess.run(["git", "clone", "-q", str(origin), str(yml.other)], check=True, capture_output=True)
    return yml


def roster(capsys, *argv):
    """(exit code, stdout, stderr) of `roster ARGV`; a refused run's message (its SystemExit's) is on stderr."""
    capsys.readouterr()
    said = ""
    try:
        rc = main(list(argv))
    except SystemExit as e:
        rc, said = (e.code, "") if isinstance(e.code, int) else (1, str(e.code))
    out = capsys.readouterr()
    return rc, out.out, out.err + said


def add_nas(capsys):
    assert roster(capsys, "add", "nas", "--ip", "10.0.0.50", "--yes")[0] == 0


def origin_head(infra, fmt="%s"):
    return git(infra.other.parent / "origin.git", "log", "-1", f"--format={fmt}", "main")


# ---------------------------------------------------------------- roster changes

def test_changes_json_lists_the_pending_changes_by_host(capsys, infra):
    add_nas(capsys)
    rc, out, _ = roster(capsys, "changes", "--json")
    assert rc == 0
    doc = json.loads(out)
    assert doc["version"] == 1 and doc["kind"] == "repo" and doc["count"] == 1
    assert doc["hosts"] == [{"host": "nas", "change": "added", "fields": []}]
    assert "+      nas: {ip: 10.0.0.50}" in doc["diff"]
    assert doc["message"] == "roster: add nas"
    assert doc["last_commit"]["pushed"] is True and doc["last_commit"]["subject"] == "inventory"


def test_changes_says_each_host_and_the_diff(capsys, infra):
    add_nas(capsys)
    rc, out, _ = roster(capsys, "changes")
    assert rc == 0
    assert "add nas" in out and "+      nas: {ip: 10.0.0.50}" in out and "roster publish" in out


def test_no_pending_changes_says_so(capsys, infra):
    rc, out, _ = roster(capsys, "changes")
    assert rc == 0 and "no Pending changes" in out
    assert json.loads(roster(capsys, "changes", "--json")[1])["count"] == 0


def test_discard_puts_roster_yml_back_as_committed(capsys, infra):
    add_nas(capsys)
    rc, out, _ = roster(capsys, "changes", "discard", "--json")
    assert rc == 0
    doc = json.loads(out)
    assert doc["discarded"] is True and doc["sync"] == {"ok": True}
    assert infra.read_text() == YML
    rc, out, _ = roster(capsys, "changes", "discard")
    assert rc == 0 and "nothing to discard" in out


# ---------------------------------------------------------------- roster publish

def test_publish_dry_run_shows_what_it_would_commit_and_commits_nothing(capsys, infra):
    add_nas(capsys)
    rc, out, _ = roster(capsys, "publish", "--dry-run")
    assert rc == 0 and "roster: add nas" in out and "+      nas: {ip: 10.0.0.50}" in out
    assert git(infra.parent, "status", "--porcelain", "--untracked-files=no") == "M roster.yml"
    rc, out, _ = roster(capsys, "publish", "--dry-run", "--json", "-m", "nas is in")
    doc = json.loads(out)
    assert doc["dry_run"] is True and doc["message"] == "nas is in" and doc["upstream"] == "origin/main"
    assert doc["hosts"] == [{"host": "nas", "change": "added", "fields": []}]
    assert origin_head(infra) == "inventory"


def test_publish_commits_roster_yml_alone_and_pushes_it(capsys, infra):
    add_nas(capsys)
    (infra.parent / "notes.txt").write_text("untracked: never published\n")
    rc, out, _ = roster(capsys, "publish", "--json", "-m", "nas is in")
    assert rc == 0
    doc = json.loads(out)
    assert doc["commit"] == git(infra.parent, "rev-parse", "HEAD") and doc["upstream"] == "origin/main"
    assert doc["message"] == "nas is in" and doc["hosts"] == [{"host": "nas", "change": "added", "fields": []}]
    assert doc["sync"] == {"ok": True} and doc["pulled"] == 0
    assert origin_head(infra) == "nas is in"
    assert git(infra.parent, "show", "--name-only", "--format=", "HEAD") == "roster.yml"
    assert json.loads(roster(capsys, "changes", "--json")[1])["count"] == 0


def test_publish_in_words_names_the_commit(capsys, infra):
    add_nas(capsys)
    rc, out, _ = roster(capsys, "publish")
    assert rc == 0 and "published" in out and "roster: add nas" in out and "origin/main" in out
    assert origin_head(infra) == "roster: add nas"


def test_publish_with_nothing_pending_is_a_plain_error(capsys, infra):
    rc, _, err = roster(capsys, "publish")
    assert rc != 0 and "[90]" in err and "nothing to publish" in err
    rc, out, err = roster(capsys, "publish", "--json")
    assert rc == 1 and out == "" and json.loads(err)["error"]["code"] == 90


def test_publish_refuses_when_someone_else_published_roster_yml(capsys, infra):
    (infra.other / "roster.yml").write_text(YML.replace("10.0.0.5}", "10.0.0.6}"))
    git(infra.other, "commit", "-qam", "theirs")
    git(infra.other, "push", "-q")
    add_nas(capsys)
    rc, _, err = roster(capsys, "publish")
    assert rc != 0 and "[92]" in err and "won't publish over it" in err
    assert origin_head(infra) == "theirs"
    assert "nas:" in infra.read_text()                          # the Pending changes are kept


def test_publish_without_a_remote_explains_theres_nowhere_to_push(capsys, infra):
    git(infra.parent, "remote", "remove", "origin")
    add_nas(capsys)
    rc, _, err = roster(capsys, "publish")
    assert rc != 0 and "[90]" in err and "no remote" in err


# ---------------------------------------------------------------- roster pull

def test_pull_brings_the_teams_changes_in(capsys, infra):
    (infra.other / "roster.yml").write_text(YML + "      nas: {ip: 10.0.0.50}\n")
    git(infra.other, "commit", "-qam", "theirs")
    git(infra.other, "push", "-q")
    rc, out, _ = roster(capsys, "pull", "--json")
    assert rc == 0
    doc = json.loads(out)
    assert doc["updated"] is True and doc["commits"] == 1 and doc["upstream"] == "origin/main"
    assert doc["sync"] == {"ok": True}
    assert "nas:" in infra.read_text()
    rc, out, _ = roster(capsys, "pull")
    assert rc == 0 and "up to date" in out


def test_pull_refuses_over_pending_changes(capsys, infra):
    add_nas(capsys)
    rc, _, err = roster(capsys, "pull")
    assert rc != 0 and "[71]" in err and "Pending changes" in err


# ---------------------------------------------------------------- a plain file

def test_a_plain_file_has_nothing_to_publish_and_says_why(capsys, write_config):
    yml = Infra(write_config(YML))
    rc, out, _ = roster(capsys, "changes")
    assert rc == 0 and "plain file" in out and "nothing to publish" in out
    doc = json.loads(roster(capsys, "changes", "--json")[1])
    assert doc["kind"] == "file" and doc["count"] == 0 and doc["repo"] is None
    rc, _, err = roster(capsys, "publish")
    assert rc != 0 and "[90]" in err and "plain file" in err
    rc, out, _ = roster(capsys, "pull")
    assert rc == 0 and "nothing to pull" in out
    assert yml.read_text() == YML
