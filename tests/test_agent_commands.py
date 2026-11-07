"""R3 (#555): `roster agent send|read|wait|label` reach an Agent through this machine's herdr-core (the stand-in
tests/fakes/hc): from the Hub any Agent on it or on a connected machine, elsewhere the Agents on the same machine."""

import json

import pytest

from roster.cli import main


def agent(capsys, *argv):
    rc = main(["agent", *argv])
    out, err = capsys.readouterr()
    return rc, out, err


def test_send_types_a_message_into_an_agent_on_the_hub(hc, capsys):
    hc.name("hub-01")
    hc.terminal("t1", app="claude-code", status="idle")
    rc, out, _ = agent(capsys, "send", "hub-01/t1", "please rebase on dev")
    assert rc == 0
    assert hc.sent("t1") == ["please rebase on dev"]
    assert "hub-01/t1" in out


def test_from_the_hub_send_reaches_an_agent_on_a_connected_machine(hc, capsys):
    hc.name("hub-01")
    hc.terminal("web-01/t2", app="claude-code", status="working")
    rc, out, _ = agent(capsys, "send", "web-01/t2", "the tests pass now")
    assert rc == 0
    assert hc.sent("web-01/t2") == ["the tests pass now"]
    assert out.strip() == "sent to web-01/t2 (it was working)"
    assert "hc send web-01/t2 the tests pass now --json" in hc.calls()


def test_on_another_machine_send_reaches_an_agent_on_the_same_machine(hc, capsys):
    hc.name("web-01")                                   # this core is web-01's own: no machines added
    hc.terminal("t2", app="claude-code", status="idle")
    rc, out, _ = agent(capsys, "send", "web-01/t2", "hello")
    assert rc == 0
    assert hc.sent("t2") == ["hello"]
    assert "hc send t2 hello --json" in hc.calls()


def test_a_bare_terminal_is_one_on_this_machine(hc, capsys):
    hc.terminal("t3", app="claude-code", status="idle")
    assert agent(capsys, "send", "t3", "hi")[0] == 0
    assert hc.sent("t3") == ["hi"]


def refused(capsys, *argv):
    """The plain error (message and fix) `roster agent ARGV` refuses with."""
    with pytest.raises(SystemExit) as e:
        main(["agent", *argv])
    capsys.readouterr()
    return str(e.value)


def test_an_unknown_address_is_a_plain_error_that_points_at_roster_agents(hc, capsys):
    hc.name("hub-01")
    hc.terminal("t1", app="claude-code", status="idle")
    for argv in (["send", "hub-01/t9", "hi"], ["read", "hub-01/t9"], ["wait", "hub-01/t9"],
                 ["label", "hub-01/t9", "x"]):
        text = refused(capsys, *argv)
        assert "no Agent at hub-01/t9" in text and "roster agents" in text
    assert not any(c.split()[1] in ("send", "read", "wait", "label") for c in hc.calls())


def test_an_ended_agent_is_a_plain_error_and_gets_nothing(hc, capsys):
    hc.name("hub-01")
    hc.terminal("web-01/t2", app="claude-code", status="done", state="finished")
    text = refused(capsys, "send", "web-01/t2", "still there?")
    assert "web-01/t2 has ended" in text and "roster agents" in text
    assert hc.sent("web-01/t2") == []


def test_a_machine_this_core_doesnt_have_is_out_of_reach_with_what_to_do(hc, capsys):
    hc.name("web-01")
    text = refused(capsys, "send", "db-01/t2", "hi")
    assert "db-01/t2 can't be reached from web-01" in text and "from the Hub" in text


def test_a_machine_that_isnt_connected_says_so(hc, capsys):
    hc.name("hub-01")
    hc.machine("db-01", "unavailable")
    text = refused(capsys, "read", "db-01/t2")
    assert "herdr says db-01 is unavailable" in text and "hc machine login db-01" in text


def test_a_malformed_address_says_what_one_looks_like(hc, capsys):
    assert "HOST/tN" in refused(capsys, "send", "a/b/t1", "hi")


def test_read_prints_the_agents_screen_with_history_on_request(hc, capsys):
    hc.name("hub-01")
    hc.terminal("web-01/t2", app="claude-code", status="working")
    hc.screen("web-01/t2", "> running the tests\n12 passed\n")
    rc, out, _ = agent(capsys, "read", "web-01/t2", "--lines", "40")
    assert rc == 0
    assert out == "> running the tests\n12 passed\n"
    assert "hc read web-01/t2 --lines 40 --json" in hc.calls()


def test_wait_returns_when_the_agent_stops_working_and_says_how_it_is(hc, capsys):
    hc.name("hub-01")
    hc.terminal("t1", app="claude-code", status="idle")
    rc, out, _ = agent(capsys, "wait", "hub-01/t1")
    assert rc == 0
    assert out.strip() == "hub-01/t1 is idle"


def test_wait_that_times_out_exits_124_and_says_what_to_do(hc, capsys):
    hc.name("hub-01")
    hc.terminal("web-01/t2", app="claude-code", status="working")
    hc.waits("web-01/t2", {"terminal": "web-01/t2", "ended": False, "reason": "timeout", "status": "working",
                           "turn": 3, "children": []})
    rc, out, _ = agent(capsys, "wait", "web-01/t2", "--timeout", "30")
    assert rc == 124
    assert "web-01/t2 is still working after 30 s" in out and "roster agent read web-01/t2" in out
    assert "hc wait web-01/t2 --timeout 30 --json" in hc.calls()


def test_wait_on_an_agent_that_exits_says_so(hc, capsys):
    hc.name("hub-01")
    hc.terminal("t1", app="claude-code", status="working")
    hc.waits("t1", {"terminal": "t1", "ended": True, "reason": "exit", "status": None, "exit_code": 0, "turn": 3,
                    "children": []})
    rc, out, _ = agent(capsys, "wait", "hub-01/t1")
    assert rc == 0
    assert out.strip() == "hub-01/t1 ended (exit 0)"


def test_label_sets_roster_label_on_the_agent(hc, capsys):
    hc.name("hub-01")
    hc.terminal("web-01/t2", app="claude-code", status="working", labels={"herdr.tab": "4"})
    rc, out, _ = agent(capsys, "label", "web-01/t2", "migrate the database")
    assert rc == 0
    assert hc.labels("web-01/t2") == {"herdr.tab": "4", "roster.label": "migrate the database"}
    assert "migrate the database" in out
    assert main(["agents", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["agents"][0]["label"] == "migrate the database"


def test_label_without_an_address_labels_the_calling_agent(hc, capsys, monkeypatch):
    hc.name("web-01")
    hc.terminal("t4", app="claude-code", status="working")
    monkeypatch.setenv("HC_TERMINAL_ID", "t4")
    rc, _, _ = agent(capsys, "label", "review the PR")
    assert rc == 0
    assert hc.labels("t4") == {"roster.label": "review the PR"}


def test_label_without_an_address_outside_herdr_asks_for_one(hc, capsys, monkeypatch):
    monkeypatch.delenv("HC_TERMINAL_ID", raising=False)
    text = refused(capsys, "label", "review the PR")
    assert "not in a herdr terminal" in text and "roster agent label ADDRESS" in text


def test_an_empty_label_removes_it(hc, capsys):
    hc.terminal("t1", app="claude-code", status="idle", labels={"roster.label": "old"})
    assert agent(capsys, "label", "t1", "")[0] == 0
    assert hc.labels("t1") == {}


def test_plain_roster_agent_lists_its_actions(capsys):
    rc, out, _ = agent(capsys)
    assert rc == 0
    assert all(word in out for word in ("send", "read", "wait", "label"))


def test_on_the_hub_a_host_that_isnt_one_of_its_machines_says_how_to_add_it(hc, capsys):
    hc.name("hub-01")
    hc.machine("web-01")
    text = refused(capsys, "send", "db-01/t2", "hi")
    assert "db-01 isn't a machine of this herdr-core" in text and "hc machine add db-01" in text
