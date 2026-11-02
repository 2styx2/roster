"""Ticket 49: the Box's health, Neovim's `:checkhealth` for roster. `roster check --box` (CLI) and `box.check`
(serve) run the same local checks, section by section, each ok / warn / error with a fix and a help topic.
Nothing here logs in to a Host or touches the network: the stand-in ssh logs every run, and none may happen."""

import json
import subprocess

import pytest
from conftest import ALL_SECRETS
from test_serve import INVENTORY, synced

from roster.cli import main

SECTIONS = ["roster", "inventory", "ssh", "vault", "askpass", "repo"]


@pytest.fixture
def ssh_log(fakes, monkeypatch, tmp_path):
    log = tmp_path / "ssh.log"
    monkeypatch.setenv("FAKE_LOG", str(log))
    return lambda: [ln for ln in (log.read_text().splitlines() if log.exists() else []) if ln.startswith("ssh ")]


def box_check(capsys, *argv):
    """`roster check --box`: (exit code, output, {section: [(level, message)]})."""
    code = main([*argv, "check", "--box"])
    out = capsys.readouterr().out
    found, section = {}, None
    for ln in out.splitlines():
        if ln and not ln.startswith(" ") and not ln[0].isdigit() and ln != "no errors":
            section = ln.split()[0].lower()
            found[section] = []
        elif ln.strip().split(" ", 1)[0] in ("ok", "warn", "error") and section:
            level, message = ln.strip().split(" ", 1)
            found[section].append((level, message.strip()))
    return code, out, found


def levels(found, section):
    return [lvl for lvl, _ in found[section]]


def test_a_box_set_up_and_synced_is_healthy(write_config, capsys, vault, ssh_log, monkeypatch):
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    synced(write_config, capsys, INVENTORY.replace("    reviewed: false\n    user: CHANGE-ME\n", "    user: ops\n"))
    code, out, found = box_check(capsys)
    assert list(found) == ["roster", "inventory", "ssh", "vault", "askpass", "infra"]
    assert "error" not in out.split("\n\n")[0]
    assert set(levels(found, "vault")) == {"ok"} and "bw" in found["vault"][0][1]
    assert found["askpass"] == [("ok", "the askpass channel is open")]
    assert code == 0 and out.rstrip().endswith("no errors")
    assert ssh_log() == []
    assert not [x for x in ALL_SECRETS if x in out]


def test_a_broken_inventory_is_an_error_and_the_rest_still_runs(write_config, capsys, fakes):
    write_config("groups: [oops\n")
    code, out, found = box_check(capsys)
    assert code == 1
    level, message = found["inventory"][0]
    assert level == "error" and "roster.yml" in message
    assert "fix: fix" in out and "line 1" in out and "help: E1" in out
    assert levels(found, "ssh")[0] == "ok"          # ssh is still looked for
    assert out.rstrip().endswith("1 error")


def test_no_inventory_at_all(capsys, fakes):
    code, out, found = box_check(capsys)
    assert code == 1 and found["inventory"][0][0] == "error" and "roster init" in out


def test_a_vault_cli_that_isnt_logged_in(write_config, capsys, vault, monkeypatch):
    monkeypatch.setenv("FAKE_BW_LOGGED_OUT", "1")
    synced(write_config, capsys, INVENTORY)
    code, out, found = box_check(capsys)
    assert code == 1
    assert found["vault"][0][0] == "error" and "bw" in found["vault"][0][1]
    assert "help: E6" in out


def test_hosts_added_since_the_last_sync_and_hosts_waiting_for_review(write_config, capsys, vault, monkeypatch):
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    synced(write_config, capsys, INVENTORY)
    write_config(INVENTORY.replace("    hosts:\n      box:", "    hosts:\n      nas: {ip: 10.0.0.8}\n      box:"))
    code, out, found = box_check(capsys)
    assert code == 0
    assert any(lvl == "warn" and "nas" in msg and "ssh config" in msg for lvl, msg in found["ssh"])
    assert "fix: run `roster sync`" in out
    assert any(lvl == "warn" and "server-10-0-0-9" in msg for lvl, msg in found["inventory"])
    assert out.rstrip().endswith("warnings, no errors")


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, check=True).stdout


def test_pending_changes_in_the_infra_repo(write_config, capsys, vault, monkeypatch, isolated):
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    synced(write_config, capsys, INVENTORY)
    work = isolated["work"]
    git(work, "init", "-q", "-b", "main")
    git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "roster.yml")
    git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "inventory")
    _, _, found = box_check(capsys)
    assert found["infra"][0][0] == "ok" and "clean" in found["infra"][0][1]
    write_config(INVENTORY.replace("Lab box", "Lab box 2"))
    _, out, found = box_check(capsys)
    assert found["infra"][0][0] == "warn" and "1 Pending change" in found["infra"][0][1]
    assert ":publish" in out


def test_not_in_a_git_repo(write_config, capsys, vault, monkeypatch):
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    synced(write_config, capsys, INVENTORY)
    _, out, found = box_check(capsys)
    assert found["infra"][0][0] == "warn" and "help: E38" in out


def test_box_and_a_host_together_is_refused(capsys):
    with pytest.raises(SystemExit):
        main(["check", "esx", "--box"])


# ---------------------------------------------------------------- serve

def test_box_check_through_serve(serve, write_config, capsys, vault, ssh_log):
    synced(write_config, capsys, INVENTORY)
    s = serve()
    r = s.call("box.check")["result"]
    assert r["api_version"] == 26 and r["roster_version"]
    assert [c["section"] for c in r["checks"]] == sorted((c["section"] for c in r["checks"]), key=SECTIONS.index)
    assert {c["level"] for c in r["checks"]} <= {"ok", "warn", "error"}
    vault_checks = [c for c in r["checks"] if c["section"] == "vault"]
    assert vault_checks[0]["level"] == "ok" and "locked" in vault_checks[0]["message"]
    assert [c["level"] for c in r["checks"] if c["section"] == "askpass"] == ["ok"]
    assert all(set(c) <= {"section", "level", "message", "fix", "topic"} for c in r["checks"])
    json.dumps(r)
    assert r["ok"] is True
    _, out, err = s.close()
    assert ssh_log() == []
    assert not [x for x in ALL_SECRETS if x in "".join(s.responses) + out + err]


def test_box_check_while_roster_yml_doesnt_load(serve, write_config, capsys, fakes):
    synced(write_config, capsys, INVENTORY)
    s = serve()
    write_config("groups: [oops\n")
    r = s.call("box.check")["result"]
    bad = [c for c in r["checks"] if c["level"] == "error"]
    assert r["ok"] is False and bad[0]["section"] == "inventory" and bad[0]["topic"] == "E1"
    assert "line 1" in bad[0]["fix"]


def test_check_box_reports_an_askpass_channel_that_opens_but_cannot_work(write_config, capsys, fakes, monkeypatch):
    """Windows without roster-askpass.exe: the channel opens, but ssh has nothing to ask for a password with. The CLI
    says so, as serve's box.check does."""
    from roster import askpass
    real = askpass.Channel.__init__

    def without_helper(self, *a, **kw):
        real(self, *a, **kw)
        self.problem = "roster-askpass.exe isn't installed next to roster"
    monkeypatch.setattr(askpass.Channel, "__init__", without_helper)
    write_config(INVENTORY)
    code, _, found = box_check(capsys)
    assert found["askpass"] == [("error", "roster-askpass.exe isn't installed next to roster")] and code == 1
