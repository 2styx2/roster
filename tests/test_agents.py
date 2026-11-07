"""R1 (#553): `roster agents` lists every Agent (a terminal that reports an agent status to herdr) across the Hub's
herdr machines, built live from herdr-core (the stand-in tests/fakes/hc); `--json` prints the Agent directory
document, version 1."""

import json
import time

import pytest

from roster.cli import main


def agents(capsys, *argv):
    rc = main(["agents", *argv])
    out, err = capsys.readouterr()
    return rc, out, err


def directory(capsys):
    rc, out, err = agents(capsys, "--json")
    assert rc == 0, err
    return json.loads(out)


def test_an_agent_on_the_hub_is_in_the_directory(hc, capsys):
    hc.name("hub-01")
    hc.terminal("t1", app="claude-code", status="working", cwd="/srv/app", labels={"roster.label": "fix the login"},
                created_ms=1_700_000_000_000)
    doc = directory(capsys)
    assert doc["version"] == 1
    assert doc["hub"] == "hub-01"
    assert doc["you"] is None
    assert doc["agents"] == [{"address": "hub-01/t1", "host": "hub-01", "terminal": "t1", "app": "claude-code",
                              "status": "working", "label": "fix the login", "folder": "/srv/app", "parent": None,
                              "started": "2023-11-14T22:13:20Z"}]


def test_agents_on_connected_machines_are_listed_and_plain_terminals_left_out(hc, capsys):
    hc.name("hub-01")
    hc.terminal("t1", status=None)                                          # a shell: reports no agent status
    hc.terminal("web-01/t2", app="claude-code", status="idle", cwd="/srv/web", parent="t5")
    hc.terminal("web-01/t3", status=None, argv=["vim"])
    hc.machine("db-01", "unavailable")
    doc = directory(capsys)
    assert [a["address"] for a in doc["agents"]] == ["web-01/t2"]
    assert doc["agents"][0] | {"started": "?"} == {
        "address": "web-01/t2", "host": "web-01", "terminal": "t2", "app": "claude-code", "status": "idle",
        "label": "", "folder": "/srv/web", "parent": "t5", "started": "?"}
    assert doc["machines"] == [{"name": "db-01", "state": "unavailable"}, {"name": "web-01", "state": "connected"}]


def test_the_table_groups_agents_by_host_with_status_label_folder_and_running_time(hc, capsys):
    hc.name("hub-01")
    two_hours_ago = int((time.time() - 2 * 3600 - 60) * 1000)
    hc.terminal("t1", app="claude-code", status="working", cwd="/srv/app", labels={"roster.label": "fix the login"},
                created_ms=two_hours_ago)
    hc.terminal("web-01/t2", app="claude-code", status="blocked", cwd="/srv/web",
                created_ms=int((time.time() - 300) * 1000))
    hc.machine("web-02")
    hc.machine("db-01", "unavailable")
    rc, out, _ = agents(capsys)
    assert rc == 0
    lines = out.splitlines()
    hub = lines.index("hub-01 (this Hub)")
    assert lines[hub + 1].split() == ["hub-01/t1", "working", "fix", "the", "login", "/srv/app", "2", "h"]
    web = lines.index("web-01 (connected)")
    assert lines[web + 1].split() == ["web-01/t2", "blocked", "-", "/srv/web", "5", "min"]
    assert "web-02 (connected): no Agents" in lines
    assert "db-01 (unavailable): no Agents" in lines
    assert hub < web


def test_no_agents_anywhere_says_so(hc, capsys):
    hc.name("hub-01")
    hc.terminal("t1", status=None)
    rc, out, _ = agents(capsys)
    assert rc == 0
    assert "hub-01 (this Hub): no Agents" in out.splitlines()


def test_no_hc_says_herdr_core_isnt_installed(tmp_path, monkeypatch, capsys):
    empty = tmp_path / "empty-path"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    with pytest.raises(SystemExit) as e:
        main(["agents"])
    assert "herdr-core isn't installed here" in str(e.value)
    rc, out, err = agents(capsys, "--json")
    assert (rc, out) == (1, "")
    error = json.loads(err)["error"]
    assert "herdr-core isn't installed" in error["message"] and "install herdr-core" in error["fix"]


def test_a_core_that_doesnt_answer_says_how_to_start_it(hc, capsys):
    hc.down()
    with pytest.raises(SystemExit) as e:
        main(["agents"])
    assert "herdr-core didn't answer `hc server status`" in str(e.value)
    rc, _, err = agents(capsys, "--json")
    assert rc == 1
    assert "hc server start" in json.loads(err)["error"]["fix"]


def test_the_directory_only_reads_from_herdr(hc, capsys):
    """hc ls, server status and a get per Agent: nothing that starts, sends to or labels a terminal."""
    hc.terminal("t1", app="claude-code", status="done")
    hc.terminal("t2", status=None)
    directory(capsys)
    assert sorted(hc.calls()) == ["hc get t1 --json", "hc ls --json", "hc server status --json"]
