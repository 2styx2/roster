import json

from roster.claude import write_claude_files
from roster.config import load_config
from roster.example import EXAMPLE_CONFIG


def test_claude_files(isolated, write_config):
    (isolated["work"] / "CLAUDE.md").write_text("# My project\nBe nice.\n")
    settings = isolated["work"] / ".claude" / "settings.json"
    settings.parent.mkdir()
    settings.write_text(json.dumps({"permissions": {"deny": ["Read(./.env)"]}, "model": "x"}))
    cfg = load_config(write_config(EXAMPLE_CONFIG))
    write_claude_files(cfg)
    write_claude_files(cfg)

    claude_md = (isolated["work"] / "CLAUDE.md").read_text()
    assert claude_md.startswith("# My project") and claude_md.count("@ROSTER.md") == 1
    roster_md = (isolated["work"] / "ROSTER.md").read_text()
    assert "| orion-db-01 | Orion - Postgres primary | db | orion |" in roster_md
    assert "hosts --find" in roster_md and "unreviewed" in roster_md
    data = json.loads(settings.read_text())
    assert data["model"] == "x"
    assert data["permissions"]["deny"] == ["Read(./.env)", "Read(~/.ssh/**)", "Edit(~/.ssh/**)"]


def test_large_inventory_is_summarised(isolated, write_config):
    hosts = "\n".join(f"      h{i}: {{ip: 10.0.0.{i}, type: dev, product: orion}}" for i in range(1, 80))
    cfg = load_config(write_config(f"groups:\n  g:\n    user: u\n    hosts:\n{hosts}\n"))
    write_claude_files(cfg)
    roster_md = (isolated["work"] / "ROSTER.md").read_text()
    assert "| h1 |" not in roster_md
    assert "79 hosts - too many to list" in roster_md and "orion (79)" in roster_md


def test_invalid_settings_json_is_left_alone(isolated, write_config, capsys):
    settings = isolated["work"] / ".claude" / "settings.json"
    settings.parent.mkdir()
    settings.write_text("{ not json")
    write_claude_files(load_config(write_config(EXAMPLE_CONFIG)))
    assert settings.read_text() == "{ not json"
    assert "isn't valid JSON" in capsys.readouterr().out


def test_roster_md_tells_claude_to_read_roster_as_json(isolated, write_config):
    write_claude_files(load_config(write_config(EXAMPLE_CONFIG)))
    roster_md = (isolated["work"] / "ROSTER.md").read_text()
    assert "hosts --json" in roster_md and "info <name> --json" in roster_md and "check <name> --json" in roster_md


def test_roster_md_says_to_diagnose_a_host_with_check_json(isolated, write_config):
    write_claude_files(load_config(write_config(EXAMPLE_CONFIG)))
    roster_md = (isolated["work"] / "ROSTER.md").read_text()
    rule = next(line for line in roster_md.splitlines() if "doesn't respond" in line)
    assert "check <name> --json" in rule
