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
    assert "herdr-core didn't answer `hc connect`: the core didn't answer" in str(e.value)
    rc, _, err = agents(capsys, "--json")
    assert rc == 1
    assert "hc server start" in json.loads(err)["error"]["fix"]


def test_an_agent_that_ends_while_the_directory_is_built_doesnt_break_it(hc, capsys):
    """A terminal can end between herdr listing it and roster reading it: `roster agents`, `agents sync` and the
    hook still answer, with the Agents that are there."""
    hc.name("hub-01")
    hc.terminal("t1", app="claude-code", status="working")
    hc.terminal("box-a/t2", app="claude-code", status="idle")
    hc.gone("t1")
    assert "box-a/t2" in [a["address"] for a in directory(capsys)["agents"]]
    rc, _, err = agents(capsys, "sync")
    assert rc == 0, err
    rc, out, err = agents(capsys, "hook")
    assert rc == 0 and err == "" and "box-a/t2" in out


def test_the_directory_only_reads_from_herdr(hc, capsys):
    """One hc run (`hc connect`): the local copy read (doc.get, which on the Hub has no `you`), server.status and
    terminal.list; nothing that starts, sends to or labels a terminal, or writes a document, and no call per Agent."""
    hc.terminal("t1", app="claude-code", status="done")
    hc.terminal("t2", status=None)
    directory(capsys)
    assert hc.calls() == ["hc connect"]
    assert [r["method"] for r in hc.rpc()] == ["doc.get", "server.status", "terminal.list"]


def test_on_the_hub_its_own_copy_is_ignored_and_the_directory_built_live(hc, capsys):
    hc.name("hub-01")
    hc.set_doc(DOC, {"version": 1, "hub": "hub-01", "you": None, "updated": "2020-01-01T00:00:00Z", "machines": [],
                     "agents": []})
    hc.terminal("t1", app="claude-code", status="working")
    rc, out, err = agents(capsys, "--json")
    assert rc == 0 and "stale" not in err
    doc = json.loads(out)
    assert doc["updated"] != "2020-01-01T00:00:00Z" and [a["address"] for a in doc["agents"]] == ["hub-01/t1"]


# ---------------------------------------------------------------- R2 (#554): the directory on every machine

DOC = "roster.agents"


def test_sync_writes_the_directory_to_the_hub_and_each_connected_machine_naming_it_in_you(hc, capsys):
    hc.name("hub-01")
    hc.terminal("t1", app="claude-code", status="working", cwd="/srv/app")
    hc.terminal("box-a/t2", app="claude-code", status="idle", cwd="/srv/web")
    hc.machine("box-b")
    rc, out, err = agents(capsys, "sync")
    assert rc == 0, err
    hub, a, b = hc.doc(DOC), hc.doc(DOC, "box-a"), hc.doc(DOC, "box-b")
    assert hub and a and b
    assert (hub["value"]["you"], a["value"]["you"], b["value"]["you"]) == (None, "box-a", "box-b")
    for copy in (hub, a, b):
        assert copy["version"] == 1
        assert copy["value"]["version"] == 1 and copy["value"]["hub"] == "hub-01"
        assert [x["address"] for x in copy["value"]["agents"]] == ["hub-01/t1", "box-a/t2"]
    assert a["value"]["agents"] == hub["value"]["agents"] and a["value"]["updated"] == hub["value"]["updated"]
    lines = out.splitlines()
    assert "hub-01 (this Hub): written" in lines and "box-a: written" in lines and "box-b: written" in lines


def test_sync_says_which_machine_failed_skips_the_unconnected_and_exits_1(hc, capsys):
    hc.name("hub-01")
    hc.machine("box-a")
    hc.machine_down("box-b")
    hc.machine("box-c", "unavailable")
    rc, out, _ = agents(capsys, "sync")
    assert rc == 1
    lines = out.splitlines()
    assert "box-a: written" in lines
    assert any(line.startswith("box-b: failed: ") for line in lines)
    assert "box-c: skipped (unavailable)" in lines
    assert hc.doc(DOC, "box-b") is None and hc.doc(DOC, "box-c") is None
    assert not any(r["params"].get("on") == "box-c" for r in hc.rpc())


def test_sync_json_reports_each_core(hc, capsys):
    hc.name("hub-01")
    hc.terminal("box-a/t1", app="claude-code", status="working")
    hc.machine_down("box-b")
    rc, out, _ = agents(capsys, "sync", "--json")
    assert rc == 1
    doc = json.loads(out)
    assert doc["version"] == 1 and doc["hub"] == "hub-01" and doc["agents"] == 1
    assert [(m["name"], m["state"], m["written"]) for m in doc["machines"]] == [
        ("hub-01", "hub", True), ("box-a", "connected", True), ("box-b", "connected", False)]
    assert doc["machines"][2]["error"]


def test_sync_replaces_an_older_copy_at_its_version(hc, capsys):
    hc.name("hub-01")
    hc.set_doc(DOC, {"version": 1, "hub": "hub-01", "you": "box-a", "agents": []}, version=7, machine="box-a")
    rc, _, err = agents(capsys, "sync")
    assert rc == 0, err
    assert hc.doc(DOC, "box-a")["version"] == 8
    sets = [r for r in hc.rpc() if r["method"] == "doc.set" and r["params"].get("on") == "box-a"]
    assert [s["params"]["version"] for s in sets] == [7]


def test_what_the_hub_syncs_is_what_a_remote_host_reads(hc, capsys, monkeypatch):
    hc.name("hub-01")
    hc.terminal("t1", app="claude-code", status="working", labels={"roster.label": "fix the login"})
    hc.terminal("box-b/t2", app="claude-code", status="blocked")
    assert agents(capsys, "sync")[0] == 0
    monkeypatch.setenv("FAKE_HC_STATE", str(hc.root / "machines" / "box-b"))
    rc, out, err = agents(capsys)
    assert rc == 0 and not err
    lines = out.splitlines()
    assert lines[0] == "Agent directory from the Hub hub-01, written just now; this is box-b"
    assert lines[lines.index("box-b (connected, you)") + 1].split()[:2] == ["box-b/t2", "blocked"]
    assert lines[lines.index("hub-01 (the Hub)") + 1].split()[:2] == ["hub-01/t1", "working"]


def iso(seconds_ago: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - seconds_ago))


def on_box_b(hc, monkeypatch, updated: str):
    """roster run on box-b, a remote Host: its own core (the stand-in's machines/box-b), holding the copy the Hub
    hub-01 last wrote there."""
    copy = {"version": 1, "hub": "hub-01", "you": "box-b", "updated": updated,
            "machines": [{"name": "box-a", "state": "connected"}, {"name": "box-b", "state": "connected"}],
            "agents": [{"address": "hub-01/t1", "host": "hub-01", "terminal": "t1", "app": "claude-code",
                        "status": "working", "label": "fix the login", "folder": "/srv/app", "parent": None,
                        "started": iso(600)},
                       {"address": "box-b/t3", "host": "box-b", "terminal": "t3", "app": "claude-code",
                        "status": "idle", "label": "", "folder": "/home/dev", "parent": "t1", "started": iso(60)}]}
    hc.set_doc(DOC, copy, version=4, machine="box-b")
    box_b = hc.root / "machines" / "box-b"
    (box_b / "name").write_text("box-b")
    monkeypatch.setenv("FAKE_HC_STATE", str(box_b))
    return copy, box_b


def test_on_a_remote_host_agents_reads_the_local_copy_and_never_lists_terminals(hc, capsys, monkeypatch):
    copy, box_b = on_box_b(hc, monkeypatch, iso(120))
    assert directory(capsys) == copy
    calls = (box_b / "calls").read_text().splitlines()
    assert calls == ["hc connect"]


def test_on_a_remote_host_the_table_shows_the_age_and_marks_you(hc, capsys, monkeypatch):
    on_box_b(hc, monkeypatch, iso(120))
    rc, out, err = agents(capsys)
    assert rc == 0
    lines = out.splitlines()
    assert lines[0] == "Agent directory from the Hub hub-01, written 2 min ago; this is box-b"
    assert "hub-01 (the Hub)" in lines
    assert lines[lines.index("box-b (connected, you)") + 1].split()[:2] == ["box-b/t3", "idle"]
    assert "box-a (connected): no Agents" in lines
    assert "stale" not in err


def test_a_stale_copy_says_so(hc, capsys, monkeypatch):
    on_box_b(hc, monkeypatch, iso(20 * 60))
    rc, out, err = agents(capsys)
    assert rc == 0
    assert "written 20 min ago" in out.splitlines()[0]
    assert "stale" in err and "roster agents sync" in err
    rc, out, err = agents(capsys, "--json")
    assert rc == 0 and json.loads(out)["you"] == "box-b"
    assert "stale" in err
