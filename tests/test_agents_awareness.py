"""R5 (#557): Agents know the others are there. `roster setup` and `sync` on a machine with herdr-core (`hc`) put a
Claude Code SessionStart hook in the user's Claude settings, whose command (`roster agents hook`) prints a short peer
list from the Agent directory; ROSTER.md gains an Agents section."""

import json
import shutil
import sys
import time
from pathlib import Path

import pytest
from conftest import FAKES, WINDOWS

from roster.cli import main
from roster.example import EXAMPLE_CONFIG

DOC = "roster.agents"


def settings(isolated):
    return isolated["home"] / ".claude" / "settings.json"


def session_start(isolated):
    """The command hooks under SessionStart in the user's Claude settings, as [command, ...]."""
    data = json.loads(settings(isolated).read_text())
    return [h["command"] for g in data.get("hooks", {}).get("SessionStart", []) for h in g["hooks"]]


def ours(isolated):
    return [c for c in session_start(isolated) if c.endswith("agents hook")]


def sync(capsys, *argv):
    rc = main(["sync", "--no-vault", *argv])
    out = capsys.readouterr().out
    assert rc == 0
    return out


# ---------------------------------------------------------------- the hook in Claude's settings

def test_sync_with_herdr_installs_the_session_start_hook_once(isolated, write_config, hc, capsys):
    write_config(EXAMPLE_CONFIG)
    sync(capsys)
    sync(capsys)
    assert len(ours(isolated)) == 1
    data = json.loads(settings(isolated).read_text())
    hook = data["hooks"]["SessionStart"][0]["hooks"][0]
    assert hook["type"] == "command" and 0 < hook["timeout"] <= 10


def test_the_hook_joins_the_users_own_hooks_and_settings_untouched(isolated, write_config, hc, capsys):
    mine = {"model": "x", "hooks": {
        "SessionStart": [{"matcher": "startup", "hooks": [{"type": "command", "command": "echo hi"}]}],
        "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "check.sh"}]}]}}
    settings(isolated).parent.mkdir()
    settings(isolated).write_text(json.dumps(mine))
    write_config(EXAMPLE_CONFIG)
    sync(capsys)
    data = json.loads(settings(isolated).read_text())
    assert data["model"] == "x" and data["hooks"]["PreToolUse"] == mine["hooks"]["PreToolUse"]
    assert data["hooks"]["SessionStart"][0] == mine["hooks"]["SessionStart"][0]
    assert session_start(isolated)[0] == "echo hi" and len(ours(isolated)) == 1


def test_without_herdr_no_hook_is_installed(isolated, write_config, capsys, monkeypatch):
    monkeypatch.setenv("PATH", str(isolated["home"]))              # no hc anywhere
    write_config(EXAMPLE_CONFIG)
    sync(capsys)
    assert not settings(isolated).exists() or not ours(isolated)


def test_a_sync_where_hc_isnt_on_path_keeps_the_hook(isolated, write_config, hc, capsys, monkeypatch):
    """Whether the hook is wanted is this Box's answer (--no-agents), not what PATH this one run has."""
    write_config(EXAMPLE_CONFIG)
    sync(capsys)
    monkeypatch.setenv("PATH", str(isolated["home"]))              # a cron job's or a non-login shell's PATH
    sync(capsys)
    assert len(ours(isolated)) == 1


def test_sync_installs_the_hook_when_hc_is_only_in_local_bin(isolated, write_config, capsys, monkeypatch):
    local = isolated["home"] / ".local" / "bin"
    local.mkdir(parents=True)
    (local / ("hc.exe" if WINDOWS else "hc")).write_text("")
    monkeypatch.setenv("PATH", str(isolated["home"]))
    write_config(EXAMPLE_CONFIG)
    sync(capsys)
    assert len(ours(isolated)) == 1


def test_no_agents_removes_the_hook_and_later_syncs_leave_it_out(isolated, write_config, hc, capsys):
    write_config(EXAMPLE_CONFIG)
    sync(capsys)
    sync(capsys, "--no-agents")
    assert not ours(isolated)
    sync(capsys)
    assert not ours(isolated)
    sync(capsys, "--agents")
    assert len(ours(isolated)) == 1


def test_no_agents_leaves_the_users_hooks(isolated, write_config, hc, capsys):
    write_config(EXAMPLE_CONFIG)
    sync(capsys)
    data = json.loads(settings(isolated).read_text())
    data["hooks"]["SessionStart"].append({"hooks": [{"type": "command", "command": "echo hi"}]})
    settings(isolated).write_text(json.dumps(data))
    sync(capsys, "--no-agents")
    assert session_start(isolated) == ["echo hi"]


def test_hook_remove_takes_it_out_without_an_inventory(isolated, hc, capsys):
    """What uninstall.sh runs before it removes roster: no roster.yml needed."""
    write = {"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "roster agents hook"}]}]}}
    settings(isolated).parent.mkdir()
    settings(isolated).write_text(json.dumps(write))
    assert main(["agents", "hook", "--remove"]) == 0
    assert json.loads(settings(isolated).read_text()) == {}


def test_invalid_claude_settings_are_left_alone(isolated, write_config, hc, capsys):
    settings(isolated).parent.mkdir()
    settings(isolated).write_text("{ not json")
    write_config(EXAMPLE_CONFIG)
    out = sync(capsys)
    assert settings(isolated).read_text() == "{ not json"
    assert "isn't valid JSON" in out


# ---------------------------------------------------------------- what the hook prints

def iso(seconds_ago: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - seconds_ago))


def agent(address, status="working", label="", folder="/home/dev"):
    host, _, t = address.partition("/")
    return {"address": address, "host": host, "terminal": t, "app": "claude-code", "status": status, "label": label,
            "folder": folder, "parent": None, "started": iso(600)}


def on_box_b(hc, monkeypatch, agents, updated=None):
    copy = {"version": 1, "hub": "hub-01", "you": "box-b", "updated": updated or iso(60),
            "machines": [{"name": "box-a", "state": "connected"}, {"name": "box-b", "state": "connected"}],
            "agents": agents}
    hc.set_doc(DOC, copy, version=2, machine="box-b")
    box_b = hc.root / "machines" / "box-b"
    (box_b / "name").write_text("box-b")
    monkeypatch.setenv("FAKE_HC_STATE", str(box_b))


def hook(capsys):
    rc = main(["agents", "hook"])
    out, err = capsys.readouterr()
    assert rc == 0 and err == ""
    return out.splitlines()


def test_the_hook_lists_the_other_agents_and_not_this_session(hc, capsys, monkeypatch):
    on_box_b(hc, monkeypatch, [agent("hub-01/t1", label="fix the login", folder="/srv/app"),
                               agent("box-a/t2", "blocked"), agent("box-b/t4", "working")])
    monkeypatch.setenv("HC_TERMINAL_ID", "t4")
    lines = hook(capsys)
    text = "\n".join(lines)
    assert "box-b/t4" in lines[0] and "box-b" in lines[0]          # who this session is, where
    rows = [line.split()[:2] for line in lines if line.startswith("  ")]
    assert rows == [["hub-01/t1", "working"], ["box-a/t2", "blocked"]]
    assert "fix the login" in text and "/srv/app" in text
    assert "roster agent send" in text and "optional" in text


def test_the_hook_is_at_most_20_lines(hc, capsys, monkeypatch):
    on_box_b(hc, monkeypatch, [agent(f"box-a/t{i}") for i in range(1, 60)])
    lines = hook(capsys)
    assert len(lines) <= 20
    assert any("more" in line and "roster agents" in line for line in lines)


def test_the_hook_says_when_the_copy_is_stale(hc, capsys, monkeypatch):
    on_box_b(hc, monkeypatch, [agent("box-a/t2")], updated=iso(3600))
    assert "stale" in hook(capsys)[0]


def test_the_hook_is_silent_without_herdr(isolated, capsys, monkeypatch):
    monkeypatch.setenv("PATH", str(isolated["home"]))
    assert hook(capsys) == []


def test_the_hook_is_silent_when_the_core_doesnt_answer(hc, capsys):
    hc.down()
    assert hook(capsys) == []


def test_the_hook_is_silent_with_no_other_agent(hc, capsys, monkeypatch):
    on_box_b(hc, monkeypatch, [agent("box-b/t4")])
    monkeypatch.setenv("HC_TERMINAL_ID", "t4")
    assert hook(capsys) == []


def test_on_the_hub_the_hook_lists_the_live_directory(hc, capsys):
    hc.name("hub-01")
    hc.terminal("t1", app="claude-code", status="idle", cwd="/srv/app")
    hc.terminal("box-a/t2", app="claude-code", status="working")
    rows = [line.split()[:2] for line in hook(capsys) if line.startswith("  ")]
    assert rows == [["hub-01/t1", "idle"], ["box-a/t2", "working"]]


def test_the_hook_runs_hc_once_however_many_agents(hc, capsys):
    """Claude Code waits at most 10 s for the hook: one hc run, never one per Agent."""
    hc.name("hub-01")
    for i in range(1, 6):
        hc.terminal(f"box-a/t{i}", app="claude-code", status="working")
    assert len([line for line in hook(capsys) if line.startswith("  ")]) == 5
    assert hc.calls() == ["hc connect"]


def test_the_hook_gives_up_on_a_core_that_hangs_well_before_claude_does(hc, capsys, monkeypatch):
    from roster import agents
    assert agents.HOOK_TIMEOUT <= 10 / 2                # the real budget: well inside Claude Code's 10 s
    monkeypatch.setattr(agents, "HOOK_TIMEOUT", 1)      # this test's, so it doesn't wait that long
    hc.terminal("t1", app="claude-code", status="working")
    (hc.root / "slow").write_text("30")
    start = time.monotonic()
    assert hook(capsys) == []
    assert time.monotonic() - start < 5


@pytest.mark.skipif(WINDOWS, reason="the stand-in hc runs by its #! line")
def test_the_hook_finds_hc_in_local_bin_when_path_lacks_it(hc, capsys, monkeypatch, isolated):
    """Claude Code may start the hook with a PATH that hasn't ~/.local/bin, where herdr-core installs hc."""
    hc.name("hub-01")
    hc.terminal("t1", app="claude-code", status="idle")
    local = isolated["home"] / ".local" / "bin"
    local.mkdir(parents=True)
    shutil.copy(FAKES / "hc", local / "hc")
    monkeypatch.setenv("PATH", str(Path(sys.executable).parent))     # python3 for its #! line, and no hc
    assert [line.split()[0] for line in hook(capsys) if line.startswith("  ")] == ["hub-01/t1"]


# ---------------------------------------------------------------- ROSTER.md

def test_roster_md_has_an_agents_section(isolated, write_config, fakes, capsys):
    write_config(EXAMPLE_CONFIG)
    sync(capsys)
    md = (isolated["work"] / "ROSTER.md").read_text()
    section = md[md.index("## Agents"):].split("\n## ", 1)[0]
    for words in ("Agent directory", "roster agents", "roster agent send", "roster agent read", "roster agent wait",
                  "roster agent label", "optional"):
        assert words in section, words
