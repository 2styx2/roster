"""T243 (#476): when the vault or the map changes, every command works in any order and names what's missing.

What's left to do is one module's answer (roster.catchup: local state only, no connection, no vault call), which
sync, setup, vault sync and vault unlock end with as their "next" line. Fakes only: the stand-in ssh and bw."""

import json

import pytest

from roster import catchup
from roster.cli import main
from roster.common import known_hosts_file
from roster.config import load_config

MAP = """\
groups:
  lab:
    hosts:
      web-01: {ip: 10.0.0.5, user: admin, auth: "bw:web-01 ssh"}
      new-01: {ip: 10.0.0.6, user: admin, auth: "bw:new-01 ssh"}
"""
ITEMS = [
    {"id": "aaaa-1", "name": "web-01 ssh", "type": 1, "revisionDate": "2026-10-01T10:00:00.000Z",
     "login": {"username": "admin", "password": "pw-web-SECRET", "uris": [{"uri": "10.0.0.5"}]}},
    {"id": "bbbb-2", "name": "new-01 ssh", "type": 1, "revisionDate": "2026-10-02T10:00:00.000Z",
     "login": {"username": "admin", "password": "pw-new-SECRET", "uris": [{"uri": "10.0.0.6"}]}},
]
SECRETS = ["pw-web-SECRET", "pw-new-SECRET", "pw-other-SECRET", "fake-session-key"]


def run(capsys, *argv):
    rc = main(list(argv))
    out = capsys.readouterr()
    return rc, out.out, out.err


def answered(*addresses):
    """This Box has reached these addresses once: their host keys are in roster's known_hosts (as setup records)."""
    f = known_hosts_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    with f.open("a") as out:
        for a in addresses:
            out.write(f"{a} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTestsOnly{a.replace('.', '')}\n")


@pytest.fixture
def box(fakes, monkeypatch, tmp_path, write_config):
    """A map of two Hosts whose Logins are in a stand-in Bitwarden that's unlocked (BW_SESSION)."""
    path = write_config(MAP)
    f = tmp_path / "items.json"
    f.write_text(json.dumps(ITEMS))
    monkeypatch.setenv("FAKE_BW_ITEMS", str(f))
    monkeypatch.setenv("FAKE_BW_SYNC_FILE", str(tmp_path / "synced"))
    monkeypatch.setenv("BW_SESSION", "fake-session-key")
    return {"path": path, "items": f}


def no_secret(*texts):
    return not any(s in t for s in SECRETS for t in texts)


# ---------------------------------------------------------------- catchup.gaps: what's left, from local state

def test_a_host_this_box_never_reached_needs_setup(box):
    answered("10.0.0.5")
    gaps = catchup.gaps(load_config(box["path"]))
    (gap,) = [g for g in gaps if g.kind == "setup"]
    assert gap.hosts == ("new-01",)
    assert gap.fix == "roster setup --host new-01"


def test_nothing_is_left_once_every_host_answered(box):
    from roster.sshops import write_ssh_config
    cfg = load_config(box["path"])
    write_ssh_config(cfg)
    answered("10.0.0.5", "10.0.0.6")
    assert catchup.gaps(cfg) == []
    assert catchup.next_line([], []) is None


def test_a_host_waiting_for_review_is_said_and_never_sent_to_setup(box, write_config):
    write_config(MAP.replace("auth: \"bw:new-01 ssh\"}", "auth: \"bw:new-01 ssh\", reviewed: false}"))
    answered("10.0.0.5")
    gaps = catchup.gaps(load_config(box["path"]))
    assert [g.kind for g in gaps if g.hosts == ("new-01",)] == ["review"]


def test_a_password_only_host_never_needs_setup(box, write_config):
    write_config(MAP.replace("auth: \"bw:new-01 ssh\"}", "auth: \"bw:new-01 ssh\", enroll: false}"))
    answered("10.0.0.5")
    assert [g for g in catchup.gaps(load_config(box["path"])) if g.kind == "setup"] == []


def test_the_next_line_says_what_changed_and_the_one_command_left():
    gap = catchup.Gap("setup", ("new-01",), "no key on new-01 yet", "roster setup --host new-01")
    line = catchup.next_line(["map: 1 Host added"], [gap])
    assert line == "map: 1 Host added; next: roster setup --host new-01 (no key on new-01 yet)"
    assert catchup.next_line(["map: 1 Host added"], []) == "map: 1 Host added"


# ---------------------------------------------------------------- roster sync: the map and the vault, one line

def bw_calls(tmp_path):
    f = tmp_path / "argv.log"
    return [json.loads(x) for x in f.read_text().splitlines()] if f.exists() else []


def test_sync_names_the_hosts_that_need_setup_and_only_those(capsys, box):
    answered("10.0.0.5")
    rc, out, err = run(capsys, "sync")
    assert rc == 0
    assert "next: roster setup --host new-01 (no key on new-01 yet)" in out
    assert "web-01" not in out.split("next:")[1]
    assert "new hosts still need" not in out + err


def test_sync_says_no_setup_note_when_no_host_needs_it(capsys, box):
    answered("10.0.0.5", "10.0.0.6")
    rc, out, err = run(capsys, "sync")
    assert rc == 0
    assert "roster setup" not in out + err


def test_sync_reports_the_map_hosts_added_and_removed(capsys, box, write_config):
    answered("10.0.0.5", "10.0.0.6", "10.0.0.7")
    run(capsys, "sync")
    write_config(MAP.replace("      new-01:", "      db-01: {ip: 10.0.0.7, user: admin}\n      new-01:")
                 .replace("      web-01: {ip: 10.0.0.5, user: admin, auth: \"bw:web-01 ssh\"}\n", ""))
    rc, out, _ = run(capsys, "sync")
    assert rc == 0
    assert "map: 1 Host added (db-01), 1 removed (web-01)" in out
    assert "roster revoke" in out                 # the removed Host may still hold this Box's key


def test_sync_runs_the_vault_sync_too_and_reports_both(capsys, box, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    answered("10.0.0.5", "10.0.0.6")
    run(capsys, "sync")                                   # the first sync counts from now on
    items = json.loads(box["items"].read_text())
    items[0]["revisionDate"] = "2026-11-05T08:00:00.000Z"
    box["items"].write_text(json.dumps(items))
    rc, out, err = run(capsys, "sync")
    assert rc == 0
    assert any(c[:1] == ["sync"] for c in bw_calls(tmp_path))
    assert "vault: bw: 1 item changed (web-01 ssh) since the last sync" in out
    assert no_secret(out, err)


def test_sync_no_vault_leaves_the_vault_alone(capsys, box, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    rc, out, _ = run(capsys, "sync", "--no-vault")
    assert rc == 0
    assert bw_calls(tmp_path) == []
    assert "vault:" not in out


def test_sync_with_a_locked_vault_and_no_terminal_does_the_map_and_names_vault_unlock(capsys, box, monkeypatch):
    monkeypatch.delenv("BW_SESSION")
    rc, out, err = run(capsys, "sync")
    assert rc == 0
    from roster.common import ssh_config_file
    assert "Host new-01" in ssh_config_file().read_text()
    assert "vault: bw not synced (locked; run in a terminal: roster vault unlock)" in out
    assert "umask" not in out + err


def test_sync_with_the_vault_server_offline_uses_the_vault_as_last_synced(capsys, box, monkeypatch):
    answered("10.0.0.5", "10.0.0.6")
    run(capsys, "sync")
    monkeypatch.setenv("FAKE_BW_SYNC_FAIL", "Sync failed: server unreachable")
    rc, out, _ = run(capsys, "sync")
    assert rc == 0
    assert "vault: bw not synced (`bw sync` failed: Sync failed: server unreachable); using it as last synced just " \
        "now\n" in out


def test_sync_names_a_new_vault_item_not_in_the_map(capsys, box):
    answered("10.0.0.5", "10.0.0.6")
    run(capsys, "sync")
    items = json.loads(box["items"].read_text()) + [
        {"id": "cccc-3", "name": "nas-01 ssh", "type": 1, "revisionDate": "2026-11-05T09:00:00.000Z",
         "login": {"password": "pw-other-SECRET"}}]
    box["items"].write_text(json.dumps(items))
    rc, out, err = run(capsys, "sync")
    assert rc == 0
    assert "vault: bw: 1 item added (nas-01 ssh) since the last sync" in out
    assert "next: roster add --from-vault (1 new vault item not in roster.yml: nas-01 ssh has no address or user)" \
        in out
    assert no_secret(out, err)


# ---------------------------------------------------------------- roster vault sync: the vault alone

def test_vault_sync_with_nothing_changed_is_one_quiet_up_to_date_line(capsys, box):
    run(capsys, "vault", "sync")
    rc, out, _ = run(capsys, "vault", "sync")
    assert rc == 0
    assert [x.strip() for x in out.splitlines() if x.strip()] == ["ok    bw: up to date (no change since the last sync)"]


def test_vault_sync_names_a_new_item_not_in_the_map_and_its_next_command(capsys, box):
    run(capsys, "vault", "sync")
    items = json.loads(box["items"].read_text()) + [
        {"id": "cccc-3", "name": "nas-01 ssh", "type": 1, "revisionDate": "2026-11-05T09:00:00.000Z",
         "login": {"username": "admin", "password": "pw-other-SECRET", "uris": [{"uri": "10.0.0.50"}]}},
        {"id": "dddd-4", "name": "web-01 ssh", "type": 1, "revisionDate": "2026-11-05T09:00:00.000Z",
         "login": {"password": "pw-other-SECRET"}}]          # a second item by a mapped name: named by the map
    box["items"].write_text(json.dumps(items))
    rc, out, err = run(capsys, "vault", "sync")
    assert rc == 0
    assert out.strip().splitlines()[-1] == "next: roster add --from-vault (1 new vault item not in roster.yml)"
    assert no_secret(out, err) and "10.0.0.50" not in out and "admin" not in out


def test_vault_sync_offline_says_when_it_last_synced(capsys, box, monkeypatch):
    run(capsys, "vault", "sync")
    monkeypatch.setenv("FAKE_BW_SYNC_FAIL", "Sync failed: server unreachable")
    rc, out, _ = run(capsys, "vault", "sync")
    assert rc == 1
    assert "FAIL  bw: `bw sync` failed: Sync failed: server unreachable; roster uses it as last synced just now" in out


# ---------------------------------------------------------------- roster setup: its summary and next line

@pytest.fixture
def scans(monkeypatch):
    """setup's host key scan, without the network: each Host answers (its host key recorded), as ssh-keyscan would."""
    from roster import cli
    monkeypatch.setattr(cli, "record_fingerprints", lambda cfg, hosts: answered(*(h["ip"] for h in hosts)) or set())


def test_setup_with_a_locked_vault_counts_a_failed_host_once(capsys, box, scans, monkeypatch):
    """The owner's run: one Host needing its key, the vault locked, no terminal. It failed, so it isn't ready too."""
    monkeypatch.delenv("BW_SESSION")
    rc, out, err = run(capsys, "setup", "--host", "new-01")
    assert rc == 1
    assert "done         0 key hosts ready, 0 password-only hosts, 1 failed" in out
    assert "new-01: Bitwarden vault is locked" in out and "roster vault unlock" in out
    assert "umask" not in out + err
    assert out.strip().splitlines()[-1] == "next: run in a terminal: roster vault unlock (bw is locked)"


def test_setup_that_installed_keys_points_at_check_for_exactly_those_hosts(capsys, box, scans, monkeypatch):
    from roster import cli
    monkeypatch.setattr(cli, "enroll", lambda *a, **k: None)          # the key went on (the stand-in's way)
    rc, out, err = run(capsys, "setup")
    assert rc == 0
    assert "done         2 key hosts ready, 0 password-only hosts, 0 failed" in out
    assert out.strip().splitlines()[-1] == ("keys on 2 Hosts (new-01, web-01); next: roster check --host new-01 "
                                            "--host web-01 (check them)")
    assert no_secret(out, err)


def test_setup_with_nothing_to_do_ends_without_a_next_line(capsys, box, scans, monkeypatch):
    from roster import cli
    monkeypatch.setattr(cli, "ssh_ok", lambda name, timeout=10: True)  # the key works on both already
    rc, out, _ = run(capsys, "setup")
    assert rc == 0
    assert out.strip().splitlines()[-1].startswith("done ")


def test_check_host_checks_exactly_the_hosts_named(capsys, box):
    rc, out, _ = run(capsys, "check", "--host", "new-01", "--host", "web-01")
    names = [x.split()[0] for x in out.splitlines() if x.startswith(("new-01", "web-01", "nas"))]
    assert sorted(names) == ["new-01", "web-01"]


# ---------------------------------------------------------------- roster vault unlock: what the locked vault held up

def test_setup_remembers_a_host_it_didnt_finish_until_a_setup_does(capsys, box, scans, monkeypatch):
    answered("10.0.0.5", "10.0.0.6")             # both answered: only setup's own record says new-01 isn't done
    monkeypatch.delenv("BW_SESSION")
    run(capsys, "setup", "--host", "new-01")
    cfg = load_config(box["path"])
    assert [g.hosts for g in catchup.gaps(cfg) if g.kind == "setup"] == [("new-01",)]
    from roster import cli
    monkeypatch.setattr(cli, "ssh_ok", lambda name, timeout=10: True)
    run(capsys, "setup", "--host", "new-01")
    assert [g for g in catchup.gaps(cfg) if g.kind == "setup"] == []


def test_vault_unlock_ends_naming_the_setup_the_locked_vault_held_up(capsys, box, scans, monkeypatch):
    from test_vault_unlock import Terminal
    answered("10.0.0.5")
    monkeypatch.delenv("BW_SESSION")
    run(capsys, "setup", "--host", "new-01")
    Terminal(monkeypatch)
    rc, out, err = run(capsys, "vault", "unlock")
    assert rc == 0
    assert out.strip().splitlines()[-1] == "next: roster setup --host new-01 (no key on new-01 yet)"
    assert no_secret(out, err)


def test_vault_unlock_with_nothing_left_ends_with_its_own_line(capsys, box, monkeypatch):
    from test_vault_unlock import Terminal

    from roster.sshops import write_ssh_config
    write_ssh_config(load_config(box["path"]))
    answered("10.0.0.5", "10.0.0.6")
    monkeypatch.delenv("BW_SESSION")
    Terminal(monkeypatch)
    rc, out, _ = run(capsys, "vault", "unlock")
    assert rc == 0 and "next:" not in out


def test_sync_says_a_host_renamed_at_the_same_address_is_the_same_machine(capsys, box, write_config):
    answered("10.0.0.5", "10.0.0.6")
    run(capsys, "sync")
    write_config(MAP.replace("      new-01:", "      app-01:"))
    rc, out, _ = run(capsys, "sync")
    assert rc == 0
    assert "map: 1 Host renamed (new-01 to app-01)" in out
    assert "roster revoke" not in out and "roster setup" not in out    # its known_hosts line, by address, still works


# ---------------------------------------------------------------- roster sync in a terminal (#503's review MED-1)

UNLOCK_NOTE = "unlocking here locks the roster app and any other bw session on this Box"


def test_sync_in_a_terminal_says_what_an_unlock_costs_before_it_asks_once_and_offers_to_keep_it(capsys, box,
                                                                                                 monkeypatch):
    from test_vault_unlock import OFFER, Terminal
    monkeypatch.delenv("BW_SESSION")
    term = Terminal(monkeypatch, "\n")
    rc, out, err = run(capsys, "sync")
    assert rc == 0 and term.passwords == 1
    assert UNLOCK_NOTE in err and OFFER in term.shown
    assert no_secret(out, err)


def test_sync_in_a_terminal_with_a_working_session_never_asks(capsys, box, monkeypatch):
    from test_vault_unlock import Terminal
    term = Terminal(monkeypatch, "\n")                     # BW_SESSION works (the box fixture's)
    rc, out, err = run(capsys, "sync")
    assert rc == 0 and term.passwords == 0 and UNLOCK_NOTE not in err


def test_sync_skips_the_vault_cleanly_on_ctrl_d_at_the_prompt(capsys, box, monkeypatch):
    import getpass

    from test_vault_unlock import Terminal
    monkeypatch.delenv("BW_SESSION")
    Terminal(monkeypatch, "\n")

    def eof(prompt=""):
        raise EOFError
    monkeypatch.setattr(getpass, "getpass", eof)
    rc, out, _ = run(capsys, "sync")
    assert rc == 0
    assert "vault: bw not synced (no master password given; run in a terminal: roster vault unlock)" in out
    from roster.common import ssh_config_file
    assert "Host new-01" in ssh_config_file().read_text()


def test_setup_with_a_locked_keepassxc_never_names_vault_unlock(capsys, box, scans, write_config, tmp_path):
    """#503's review MED-3: the fix is the locked Login's provider's own (roster vault unlock is Bitwarden's)."""
    from test_keepassxc import make_db
    db = make_db(tmp_path / "r.kdbx", [{"path": "new-01 ssh", "UserName": "admin", "Password": "pw-new-SECRET"}])
    write_config(f"providers:\n  kp: {{database: '{db}'}}\n" + MAP.replace('auth: "bw:new-01 ssh"', 'auth: "kp:new-01 ssh"'))
    rc, out, _ = run(capsys, "setup", "--host", "new-01")
    assert rc == 1
    assert "roster vault unlock" not in out
    assert out.strip().splitlines()[-1].startswith("next: run it in a terminal: KeePassXC has no session roster keeps")


def test_setup_past_five_hosts_points_at_plain_check():
    from roster.cli import setup_next_line
    hosts = [f"h{i}" for i in range(6)]
    assert setup_next_line(hosts).endswith("next: roster check (check them)")
    assert "--host h4" in setup_next_line(hosts[:5])


def test_syncing_another_unnamed_map_reports_no_removed_hosts(capsys, box, write_config):
    """#503's review MED-2: roster's unnamed ssh config was another roster.yml's, so its Hosts weren't removed."""
    run(capsys, "sync", "--no-vault")
    other = write_config("groups:\n  lab:\n    hosts:\n      other-01: {ip: 10.0.0.9, user: admin}\n", "other.yml")
    rc, out, _ = run(capsys, "-c", str(other), "sync", "--no-vault")
    assert rc == 0
    assert "removed" not in out and "by hand" not in out


def test_a_host_whose_key_went_on_but_whose_mesh_failed_is_not_left_for_setup(capsys, box, scans, monkeypatch):
    """#503's review LOW-3."""
    from roster import cli
    answered("10.0.0.5")
    monkeypatch.delenv("BW_SESSION")
    run(capsys, "setup", "--host", "new-01")                 # the vault locked: left
    monkeypatch.setenv("BW_SESSION", "fake-session-key")
    monkeypatch.setattr(cli, "enroll", lambda *a, **k: None)
    monkeypatch.setattr(cli, "setup_mesh", lambda cfg, by: {"new-01": "mesh: a peer didn't answer"})
    run(capsys, "setup", "--host", "new-01")
    cfg = load_config(box["path"])
    assert [g for g in catchup.gaps(cfg) if g.kind == "setup"] == []


def run_dies(*argv):
    with pytest.raises(SystemExit) as e:
        main(list(argv))
    return str(e.value)


def test_check_host_on_a_group_points_at_only(capsys, box):
    said = run_dies("check", "--host", "lab")
    assert "lab is a group (--only lab takes its Hosts)" in said
