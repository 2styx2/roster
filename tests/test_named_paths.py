"""#538 (T267, #533's review): the last places that named a roster.yml in a token-named folder (Q207 (w)): the backup
in serve's edit results, the named Inventories' paths (serve's inventories.list/use, the CLI's `inv add/list/use`)
and changes.py's `git -C TOP` fixes. conftest gives every test its own HOME and cwd; the stand-in CLIs only."""

import json
import subprocess
from pathlib import Path

import pytest

from roster import serve
from roster.cli import main
from roster.errors import Problem

OP_SESSION = "Ex4mple-0nly_n0tAR3al-op_s3ss10nT0k3n-xyzW"       # made up, op session shaped

YML = """\
defaults:
  user: ops

groups:
  lab:
    hosts:
      esx-02: {ip: 10.0.0.5}
      web-01: {ip: 10.0.0.6}
  spare:
    hosts:
      nas: {ip: 10.0.0.7}
"""


def leaks(text):
    return [x for x in (OP_SESSION[i:i + 10] for i in range(0, len(OP_SESSION) - 10, 5)) if x in str(text)]


def said(problem):
    return f"{problem.message} {problem.fix} {problem.data}"


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                          capture_output=True, text=True, check=True).stdout.strip()


def made(tmp_path, monkeypatch, folder, repo):
    cwd = tmp_path / "cwd"
    (cwd / folder).mkdir(parents=True)
    (cwd / folder / "roster.yml").write_text(YML)
    if repo:
        git(cwd / folder, "init", "-q", "-b", "main")
        git(cwd / folder, "add", "roster.yml")
        git(cwd / folder, "commit", "-qm", "inventory")
        subprocess.run(["git", "init", "-q", "--bare", str(tmp_path / "remote.git")], check=True)
        git(cwd / folder, "remote", "add", "origin", str(tmp_path / "remote.git"))
    monkeypatch.chdir(cwd)
    state = serve.State(f"{folder}/roster.yml")
    assert state.error is None
    return state


@pytest.fixture(params=["file", "repo"])
def hidden(request, tmp_path, monkeypatch):
    """serve on `-c TOKEN/roster.yml`: a plain file, or a git repo with a remote (Pending changes)."""
    return made(tmp_path, monkeypatch, OP_SESSION, request.param == "repo")


@pytest.fixture
def shown(tmp_path, monkeypatch):
    return made(tmp_path, monkeypatch, "lab", False)


# ---------------------------------------------------------------- item 1: the backup in edit results

EDITS = {
    "host.update": lambda s: serve.host_update(s, {"host": "esx-02", "changes": {"title": "the esx"}}),
    "host.remove": lambda s: serve.host_remove(s, {"host": "nas"}),
    "host.rename": lambda s: serve.host_rename(s, {"host": "esx-02", "to": "esx-03"}),
    "host.move": lambda s: serve.host_move(s, {"host": "esx-02", "group": "spare"}),
    "group.new": lambda s: serve.group_new(s, {"name": "more"}),
    "group.rename": lambda s: serve.group_rename(s, {"group": "spare", "to": "extra"}),
    "group.delete": lambda s: serve.group_delete(s, {"group": "spare", "to": "lab"}),
}


@pytest.mark.parametrize("method", list(EDITS))
def test_an_edit_result_doesnt_name_a_hidden_roster_yml_s_backup(hidden, method):
    result = EDITS[method](hidden)
    assert result["backup"] == "(not repeated)", result
    assert not leaks(result), result


@pytest.mark.parametrize("method", ["host.update", "group.new"])
def test_an_edit_result_still_names_a_shown_backup(shown, method):
    backup = EDITS[method](shown)["backup"]
    assert backup.endswith("roster.yml.bak") and Path(backup).is_file(), backup


def test_discarding_doesnt_name_a_hidden_repo_s_backup(tmp_path, monkeypatch):
    state = made(tmp_path, monkeypatch, OP_SESSION, True)
    serve.host_update(state, {"host": "esx-02", "changes": {"title": "the esx"}})
    result = serve.changes_discard(state, {})
    assert result["discarded"] and result["backup"] == "(not repeated)" and not leaks(result), result


# ---------------------------------------------------------------- item 2: the named Inventories' paths

def run(capsys, *argv):
    try:
        code = main(list(argv))
    except SystemExit as e:
        code = e.code
    out = capsys.readouterr()
    return code, out.out, out.err


@pytest.fixture
def named_hidden(isolated, capsys):
    """Two named Inventories under HOME: `lab` in a token-named folder an older roster made, `home` in a plain one."""
    paths = {}
    for name, folder in (("lab", OP_SESSION), ("home", "home-inv")):
        d = isolated["home"] / folder
        d.mkdir()
        (d / "roster.yml").write_text(YML)
        paths[name] = d / "roster.yml"
    return paths


def test_inv_add_doesnt_name_a_hidden_roster_yml(named_hidden, capsys):
    code, out, err = run(capsys, "inv", "add", "lab", str(named_hidden["lab"]))
    assert code == 0 and "named lab: the roster.yml at that path (not repeated)" in out, out
    assert "rename the folder" in out + err and not leaks(out + err), out + err


def test_inv_list_and_use_dont_name_a_hidden_roster_yml(named_hidden, capsys):
    for name in ("lab", "home"):
        assert run(capsys, "inv", "add", name, str(named_hidden[name]))[0] == 0
    code, out, err = run(capsys, "inv", "list")
    assert out.splitlines()[:2] == ["* lab   the roster.yml at that path (not repeated)",
                                    f"  home  {named_hidden['home']}"], out
    assert not leaks(out + err), out + err
    code, out, err = run(capsys, "inv", "list", "--json")
    listed = json.loads(out)["inventories"]
    assert [x["path"] for x in listed] == ["(not repeated)", str(named_hidden["home"])], listed
    assert listed[0]["exists"] and not leaks(out + err), out + err
    code, out, err = run(capsys, "inv", "use", "lab")
    assert code == 0 and "lab is the active Inventory: the roster.yml at that path (not repeated)" in out, out
    assert "rename the folder" in out + err and not leaks(out + err), out + err
    code, out, err = run(capsys, "inv", "use", "home")
    assert f"home is the active Inventory: {named_hidden['home']}" in out, out


def test_inv_use_doesnt_repeat_a_hidden_roster_config(named_hidden, capsys, monkeypatch):
    assert run(capsys, "inv", "add", "home", str(named_hidden["home"]))[0] == 0
    monkeypatch.setenv("ROSTER_CONFIG", str(named_hidden["lab"]))
    code, out, err = run(capsys, "inv", "use", "home")
    assert code == 0 and "ROSTER_CONFIG is set (that path (not repeated))" in out, out
    assert not leaks(out + err), out + err


def test_inv_add_refusals_dont_name_a_hidden_roster_yml(named_hidden, capsys):
    assert run(capsys, "inv", "add", "lab", str(named_hidden["lab"]))[0] == 0
    for argv in (["lab", str(named_hidden["home"])], ["other", str(named_hidden["lab"])],
                 ["other", str(named_hidden["lab"].parent / "second.yml")]):
        (named_hidden["lab"].parent / "second.yml").write_text(YML)
        code, out, err = run(capsys, "inv", "add", *argv)
        said = f"{code} {out} {err}"                    # die()'s message is the exit's code
        assert code != 0 and "already" in said, said
        assert not leaks(said), (argv, said)


def test_serve_doesnt_name_a_hidden_named_inventory(named_hidden, capsys):
    for name in ("lab", "home"):
        assert run(capsys, "inv", "add", name, str(named_hidden[name]))[0] == 0
    state = serve.State(str(named_hidden["home"]))
    listed = serve.inventories_list(state, {})
    assert [x["path"] for x in listed["inventories"]] == ["(not repeated)", str(named_hidden["home"])], listed
    assert listed["inventories"][0]["exists"] and not leaks(listed), listed
    used = serve.inventories_use(state, {"name": "lab"})
    assert used == {"active": "lab", "path": "(not repeated)", "restart": True}, used
    assert serve.inventories_use(state, {"name": "home"})["path"] == str(named_hidden["home"])


# ---------------------------------------------------------------- item 3: changes.py's `git -C TOP` fixes

@pytest.fixture
def hidden_repo(tmp_path, monkeypatch):
    state = made(tmp_path, monkeypatch, OP_SESSION, True)
    folder = Path(OP_SESSION)
    (folder / "notes.txt").write_text("one\n")
    git(folder, "add", "notes.txt")
    git(folder, "commit", "-qm", "notes")
    return state


def test_pull_doesnt_name_a_hidden_repo(hidden_repo):
    Path(OP_SESSION, "notes.txt").write_text("two\n")         # another file's uncommitted change: 71
    with pytest.raises(Problem) as e:
        serve.inventory_pull(hidden_repo, {})
    assert "git status" in e.value.fix and "git -C" not in e.value.fix, said(e.value)
    assert not leaks(said(e.value)), said(e.value)


def test_publish_doesnt_name_a_hidden_repo(hidden_repo):
    serve.host_update(hidden_repo, {"host": "esx-02", "changes": {"title": "the esx"}})
    with pytest.raises(Problem) as e:                           # a remote, but no upstream: 94
        serve.changes_publish(hidden_repo, {})
    assert "git push -u origin main" in e.value.fix and "git -C" not in e.value.fix, said(e.value)
    assert not leaks(said(e.value)), said(e.value)
    Path(OP_SESSION, "notes.txt").write_text("two\n")         # and another file's change: 91
    with pytest.raises(Problem) as e:
        serve.changes_publish(hidden_repo, {})
    assert "git status" in e.value.fix and not leaks(said(e.value)), said(e.value)


def test_publish_still_names_a_shown_repo(tmp_path, monkeypatch):
    state = made(tmp_path, monkeypatch, "lab", True)
    serve.host_update(state, {"host": "esx-02", "changes": {"title": "the esx"}})
    with pytest.raises(Problem) as e:
        serve.changes_publish(state, {})
    assert f"git -C {(tmp_path / 'cwd' / 'lab').resolve()} push -u origin main" in e.value.fix, said(e.value)
