"""#529 (T261, #523's review): serve's results and error data named a roster.yml in a token-named folder in full,
for the app to show and offer to copy. They say "(not repeated)" now, as the CLI does since #506. conftest gives every
test its own HOME and cwd; the stand-in CLIs only."""

import subprocess
from pathlib import Path

import pytest

from roster import serve
from roster.errors import Problem

OP_SESSION = "Ex4mple-0nly_n0tAR3al-op_s3ss10nT0k3n-xyzW"       # made up, op session shaped

YML = """\
defaults:
  user: ops

groups:
  lab:
    hosts:
      esx-02: {ip: 10.0.0.5}
"""


def leaks(text):
    return [x for x in (OP_SESSION[i:i + 10] for i in range(0, len(OP_SESSION) - 10, 5)) if x in str(text)]


@pytest.fixture
def hidden(tmp_path, monkeypatch):
    """serve on a valid roster.yml in a token-named folder in the cwd: `-c TOKEN/roster.yml`."""
    cwd = tmp_path / "cwd"
    (cwd / OP_SESSION).mkdir(parents=True)
    (cwd / OP_SESSION / "roster.yml").write_text(YML)
    monkeypatch.chdir(cwd)
    state = serve.State(f"{OP_SESSION}/roster.yml")
    assert state.error is None
    return state


@pytest.fixture
def shown(tmp_path, monkeypatch):
    (tmp_path / "lab").mkdir()
    (tmp_path / "lab" / "roster.yml").write_text(YML)
    monkeypatch.chdir(tmp_path)
    return serve.State("lab/roster.yml")


def test_inventory_info_doesnt_name_a_hidden_roster_yml(hidden):
    info = serve.inventory_info(hidden, {})
    assert info["path"] == "(not repeated)", info
    assert not leaks(info), info


def test_inventory_info_still_names_one_that_is_shown(shown, tmp_path):
    assert serve.inventory_info(shown, {})["path"] == str((tmp_path / "lab" / "roster.yml").resolve())


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                          capture_output=True, text=True, check=True).stdout.strip()


@pytest.fixture
def hidden_repo(tmp_path, monkeypatch):
    """serve on `-c TOKEN/roster.yml`, the token-named folder a team's git repo with a remote: Pending changes."""
    cwd = tmp_path / "cwd"
    repo = cwd / OP_SESSION
    repo.mkdir(parents=True)
    (repo / "roster.yml").write_text(YML)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "add", "roster.yml")
    git(repo, "commit", "-qm", "inventory")
    subprocess.run(["git", "init", "-q", "--bare", str(tmp_path / "remote.git")], check=True)
    git(repo, "remote", "add", "origin", str(tmp_path / "remote.git"))
    monkeypatch.chdir(cwd)
    state = serve.State(f"{OP_SESSION}/roster.yml")
    assert state.error is None
    return state


def test_inventory_infos_store_doesnt_name_a_hidden_repo(hidden_repo):
    store = serve.inventory_info(hidden_repo, {})["store"]
    assert store["kind"] == "repo" and store["repo"] == "(not repeated)", store
    assert not leaks(store), store


def test_inventory_infos_store_doesnt_name_a_hidden_plain_file(hidden):
    store = serve.inventory_info(hidden, {})["store"]
    assert store["kind"] == "file" and store["repo"] is None and not leaks(store), store


@pytest.mark.parametrize("edited", [False, True])
def test_changes_diff_doesnt_name_a_hidden_repo(hidden_repo, edited):
    if edited:
        yml = Path(f"{OP_SESSION}/roster.yml")
        yml.write_text(yml.read_text().replace("10.0.0.5", "10.0.0.6"))
    diff = serve.changes_diff(hidden_repo, {})
    assert diff["path"] == "(not repeated)" and diff["repo"] == "(not repeated)", diff
    assert diff["count"] == (1 if edited else 0) and not leaks(diff), diff


def test_changes_diff_doesnt_name_a_hidden_plain_file(hidden):
    diff = serve.changes_diff(hidden, {})
    assert diff["path"] == "(not repeated)" and not leaks(diff), diff


def test_changes_diff_still_names_one_that_is_shown(shown, tmp_path):
    assert serve.changes_diff(shown, {})["path"] == str((tmp_path / "lab" / "roster.yml").resolve())


def test_box_check_doesnt_name_a_hidden_repo(hidden_repo):
    """serve's box.check and `roster check --box` say where the repo is clean, or what to run in it."""
    said = str(serve.box_check(hidden_repo, {}))
    assert "repo" in said and not leaks(said), said


def test_inventories_list_doesnt_name_a_hidden_roster_yml(hidden):
    listed = serve.inventories_list(hidden, {})
    assert listed["path"] == "(not repeated)" and listed["name"] is None and not leaks(listed), listed


def test_inventories_list_still_names_one_that_is_shown(shown, tmp_path):
    assert serve.inventories_list(shown, {})["path"] == str((tmp_path / "lab" / "roster.yml").resolve())


def test_inventory_watch_doesnt_name_a_hidden_roster_yml(hidden):
    hidden.notify = lambda method, params: None
    try:
        watched = serve.inventory_watch(hidden, {"auto": False})
    finally:
        if hidden.watcher is not None:
            hidden.watcher.stop.set()
    assert watched["watching"] and watched["path"] == "(not repeated)" and not leaks(watched), watched


def said(problem):
    return f"{problem.message} {problem.fix} {problem.data}"


def test_inventory_create_on_a_hidden_inventory_doesnt_name_it(hidden, tmp_path):
    with pytest.raises(Problem) as e:
        serve.inventory_create(hidden, {"how": "blank", "folder": str(tmp_path / "new")})
    assert e.value.data["path"] == "(not repeated)" and "(not repeated)" in e.value.message, said(e.value)
    assert not leaks(said(e.value)), said(e.value)


def test_inventory_create_doesnt_name_a_hidden_one_made_meanwhile(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    state = serve.State(None)
    assert state.path is None
    (tmp_path / OP_SESSION).mkdir()
    (tmp_path / OP_SESSION / "roster.yml").write_text(YML)        # made meanwhile, where $ROSTER_CONFIG says
    monkeypatch.setenv("ROSTER_CONFIG", f"{OP_SESSION}/roster.yml")
    with pytest.raises(Problem) as e:
        serve.inventory_create(state, {"how": "blank", "folder": str(tmp_path / "new")})
    assert e.value.data["path"] == "(not repeated)" and "(not repeated)" in e.value.message, said(e.value)
    assert not leaks(said(e.value)), said(e.value)


def test_publishing_a_hidden_plain_file_doesnt_name_it(hidden):
    with pytest.raises(Problem) as e:
        serve.changes_publish(hidden, {})
    assert e.value.data["path"] == "(not repeated)" and not leaks(said(e.value)), said(e.value)


def test_git_that_doesnt_answer_about_a_hidden_roster_yml_doesnt_name_it(hidden, monkeypatch):
    from roster import changes, store
    real = changes.git

    def stuck(repo, *args, **kw):
        if "rev-parse" in args:
            raise Problem(73, "git rev-parse didn't finish within 1 s")
        return real(repo, *args, **kw)
    monkeypatch.setattr(changes, "git", stuck)
    with pytest.raises(Problem) as e:
        store.at(hidden.path, hidden=True)
    assert e.value.data["path"] == "(not repeated)" and "`git status` in its folder" in e.value.fix, said(e.value)
    assert not leaks(said(e.value)), said(e.value)
    kept = store.at(hidden.path, for_show=True, hidden=True)
    assert "git didn't answer" in kept.note and not leaks(kept.note), kept.note
