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
    assert out.strip().splitlines()[-1] == "next: roster vault unlock (in a terminal: the vault is locked)"


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


# ---------------------------------------------------------------- catchup.explain: a failed login's cause and its fix

NO_ROUTE = "ssh: connect to host 10.0.0.6 port 22: No route to host"
DENIED = "admin@10.0.0.6: Permission denied (publickey,password)."


def explained(box, name, stderr, password=False):
    cfg = load_config(box["path"])
    return catchup.explain(cfg, cfg["hosts"][name], stderr, password)


def test_a_host_that_never_answered_says_so_with_its_address_and_vault_item(box):
    from roster import errors
    p = explained(box, "new-01", NO_ROUTE)
    assert p.code == errors.NEVER_ANSWERED
    assert p.message == "new-01 has never answered at 10.0.0.6: is it on, and is that its address?"
    assert "vault item 'new-01 ssh'" in p.fix and "roster.yml" in p.fix


def test_a_host_that_answered_before_stopped_answering(box):
    from roster import errors
    answered("10.0.0.6")
    p = explained(box, "new-01", NO_ROUTE)
    assert p.code == errors.STOPPED_ANSWERING
    assert p.message == "new-01 stopped answering at 10.0.0.6"


def test_a_key_refused_on_a_host_setup_never_finished_is_no_key_yet(box):
    from roster import errors
    p = explained(box, "new-01", DENIED)
    assert p.code == errors.NO_KEY_YET
    assert p.message == "no key on new-01 yet" and p.fix == "roster setup --host new-01"


def test_a_key_refused_on_a_host_set_up_before_says_it_no_longer_logs_in(box):
    from roster import errors
    answered("10.0.0.6")
    p = explained(box, "new-01", DENIED)
    assert p.code == errors.KEY_GONE
    assert "no longer logs in" in p.message and "roster setup --host new-01" in p.fix


def test_a_refused_password_names_the_vault_item_never_the_password(box):
    from roster import errors
    answered("10.0.0.6")
    p = explained(box, "new-01", DENIED, password=True)
    assert p.code == errors.PASSWORD_REFUSED
    assert p.message == ("the password in vault item 'new-01 ssh' doesn't log in to new-01: was it changed on one side "
                         "only?")


@pytest.mark.parametrize("stderr", ["Your account has expired; please contact your system administrator",
                                    "WARNING: Your password has expired.\nPassword change required but no TTY available.",
                                    "Account locked due to 3 failed logins"])
def test_a_locked_or_expired_account_is_told_apart_from_a_wrong_password(box, stderr):
    from roster import errors
    answered("10.0.0.6")
    p = explained(box, "new-01", stderr, password=True)
    assert p.code == errors.ACCOUNT_LOCKED
    assert p.message == "the account admin on new-01 is locked or its password expired"


def test_a_host_with_no_password_login_and_no_key_says_setup_needs_one(box):
    from roster import errors
    answered("10.0.0.6")
    p = explained(box, "new-01", "admin@10.0.0.6: Permission denied (publickey).", password=True)
    assert p.code == errors.NO_PASSWORD_LOGIN
    assert "password login" in p.message and "by hand" in p.fix


@pytest.mark.parametrize("stderr", ["kex_exchange_identification: read: Connection reset by peer",
                                    "kex_exchange_identification: Connection closed by remote host"])
def test_a_connection_dropped_before_ssh_spoke_is_the_rate_limiter(box, stderr):
    from roster import errors
    answered("10.0.0.6")
    p = explained(box, "new-01", stderr)
    assert p.code == errors.SSH_RATE_LIMITED
    assert "wait about 4 minutes" in p.fix


# ---------------------------------------------------------------- roster check: each FAIL's cause and its one fix

@pytest.fixture
def ssh_says(monkeypatch, tmp_path):
    """The stand-in ssh's one login fails with STDERR (exit 255); FAKE_LOG counts the connections."""
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "ssh.log"))

    def say(stderr):
        monkeypatch.setenv("FAKE_SSH_STDERR", stderr)
        monkeypatch.setenv("FAKE_SSH_EXIT", "255")
    return say


def connections(tmp_path):
    f = tmp_path / "ssh.log"
    return len(f.read_text().splitlines()) if f.exists() else 0


def test_check_before_setup_on_a_new_host_is_a_to_do_naming_setup(capsys, box, ssh_says, tmp_path):
    run(capsys, "sync", "--no-vault")
    answered("10.0.0.5")
    ssh_says(DENIED)
    rc, out, err = run(capsys, "check", "--host", "new-01")
    assert "new-01  ssh:todo" in out
    assert "  new-01: [211] no key on new-01 yet: roster setup --host new-01" in out
    assert connections(tmp_path) == 1                       # one login, never a retry


def test_check_names_a_host_that_never_answered_and_the_fix(capsys, box, ssh_says):
    run(capsys, "sync", "--no-vault")
    ssh_says(NO_ROUTE)
    rc, out, _ = run(capsys, "check", "--host", "new-01")
    assert rc == 1 and "new-01  ssh:FAIL" in out
    assert "  new-01: [209] new-01 has never answered at 10.0.0.6: is it on, and is that its address?" in out


def test_check_json_carries_the_cause_and_fix_and_no_next_line(capsys, box, ssh_says):
    run(capsys, "sync", "--no-vault")
    answered("10.0.0.6")
    ssh_says(NO_ROUTE)
    rc, out, _ = run(capsys, "check", "--host", "new-01", "--json")
    (h,) = json.loads(out)["hosts"]
    assert h["problem"]["code"] == 210 and h["problem"]["fix"]
    assert "next:" not in out


# ---------------------------------------------------------------- roster setup: each failed Host's cause

def test_setup_says_a_host_that_never_answered_with_its_address(capsys, box, monkeypatch):
    from roster import cli
    monkeypatch.setattr(cli, "record_fingerprints", lambda cfg, hosts: {h["name"] for h in hosts})   # no answer
    rc, out, _ = run(capsys, "setup", "--host", "new-01")
    assert rc == 1
    assert "  new-01: [209] new-01 has never answered at 10.0.0.6: is it on, and is that its address?" in out


def test_setup_names_the_vault_item_whose_password_the_host_refused(capsys, box, scans, monkeypatch):
    from roster import cli
    def refused(*a, **k):
        raise RuntimeError("login refused (wrong user or password?)")
    monkeypatch.setattr(cli, "enroll", refused)
    rc, out, err = run(capsys, "setup", "--host", "new-01")
    assert rc == 1
    assert ("  new-01: [45] the password in vault item 'new-01 ssh' doesn't log in to new-01: was it changed on one "
            "side only?") in out
    assert no_secret(out, err)


def test_setup_says_a_host_with_no_password_login_needs_the_key_by_hand(capsys, box, scans, monkeypatch):
    from roster import cli
    def no_password(*a, **k):
        raise RuntimeError("login refused: the Host takes no password login (allowed: publickey)")
    monkeypatch.setattr(cli, "enroll", no_password)
    rc, out, _ = run(capsys, "setup", "--host", "new-01")
    assert rc == 1 and "  new-01: [214] new-01 takes no password login" in out


# ---------------------------------------------------------------- roster run: never a bare ssh failure

def test_run_before_sync_on_a_new_host_says_roster_sync(capsys, box, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "ssh.log"))
    with pytest.raises(SystemExit) as e:
        main(["run", "new-01", "--", "uptime"])
    assert "new-01 isn't in this Box's ssh config yet" in str(e.value) and " sync` writes it" in str(e.value)
    assert connections(tmp_path) == 0


def test_run_on_a_host_with_no_key_yet_says_setup_after_its_one_try(capsys, box, ssh_says, tmp_path):
    run(capsys, "sync", "--no-vault")
    ssh_says(DENIED)
    rc, out, err = run(capsys, "run", "new-01", "--", "uptime")
    assert rc == 255
    assert DENIED in err                                     # ssh's own words still shown
    assert "roster: [211] no key on new-01 yet: roster setup --host new-01" in err
    assert connections(tmp_path) == 1


def test_run_on_a_host_that_works_hands_over_to_ssh_as_before(capsys, box, monkeypatch):
    from roster import cli
    run(capsys, "sync", "--no-vault")
    answered("10.0.0.6")
    handed = []
    monkeypatch.setattr(cli, "run_instead", lambda argv: handed.append(argv) or 0)
    assert main(["run", "new-01", "--", "uptime"]) == 0
    assert handed == [["ssh", "-o", "BatchMode=yes", "new-01", "uptime"]]


# ---------------------------------------------------------------- a Login's vault item renamed, deleted, doubled

PW_MAP = MAP.replace('auth: "bw:new-01 ssh"}', 'auth: "bw:new-01 ssh", enroll: false}')


def run_dies(*argv):
    with pytest.raises(SystemExit) as e:
        main(list(argv))
    return str(e.value)


def test_a_renamed_or_deleted_item_names_the_host_the_item_and_the_fix(capsys, box, write_config):
    write_config(PW_MAP)
    items = [i for i in json.loads(box["items"].read_text()) if i["name"] != "new-01 ssh"]   # renamed away, or gone
    box["items"].write_text(json.dumps(items))
    said = run_dies("run", "new-01", "--", "uptime")
    assert "[32] no vault item named 'new-01 ssh' (ssh Login of new-01)" in said
    assert "renamed, deleted, or moved where this account can't read it" in said
    assert "roster add --from-vault" in said and "auth:" in said
    assert no_secret(said)


def test_two_items_by_the_login_s_name_are_both_named_never_their_contents(capsys, box, write_config):
    write_config(PW_MAP)
    items = json.loads(box["items"].read_text()) + [
        {"id": "eeee-5", "name": "new-01 ssh", "type": 1, "revisionDate": "2026-11-05T09:00:00.000Z",
         "login": {"username": "admin", "password": "pw-other-SECRET"}}]
    box["items"].write_text(json.dumps(items))
    said = run_dies("run", "new-01", "--", "uptime")
    assert "[33] 2 vault items are named 'new-01 ssh'" in said
    assert no_secret(said)


def test_a_locked_vault_with_no_terminal_says_14_and_vault_unlock(capsys, box, write_config, monkeypatch):
    write_config(PW_MAP)
    monkeypatch.delenv("BW_SESSION")
    said = run_dies("run", "new-01", "--", "uptime")
    assert said.startswith("error: new-01: [14] ") and "roster vault unlock" in said and "umask" not in said


# ---------------------------------------------------------------- run --sudo: sudo's refusals told apart

@pytest.mark.parametrize(("sudo_says", "told"), [
    ("admin is not in the sudoers file.  This incident will be reported.",
     "admin isn't allowed to sudo there (not in sudoers)"),
    ("sudo: a terminal is required to read the password", "sudo there wants a terminal (requiretty in sudoers)"),
    ("sudo: 1 incorrect password attempt", "sudo refused the password from bw:new-01 ssh: is the sudo password there "
                                           "the login's?"),
])
def test_run_sudo_tells_sudo_s_refusals_apart(capsys, box, monkeypatch, sudo_says, told):
    run(capsys, "sync", "--no-vault")
    answered("10.0.0.6")
    monkeypatch.setenv("FAKE_SSH_STDERR", sudo_says)
    monkeypatch.setenv("FAKE_SSH_EXIT", "1")
    rc, out, err = run(capsys, "run", "--sudo", "new-01", "--", "id")
    assert rc == 1 and f"new-01: {told}" in err
    assert no_secret(out, err)


def test_setup_says_the_vault_was_locked_part_way_and_asks_nothing_more(capsys, box, scans, write_config, monkeypatch):
    """The roster app locked the vault between two lookups: setup says so, stops asking, and its ssh config is whole."""
    write_config(MAP.replace("      new-01:", "  more:\n    hosts:\n      new-01:"))
    from roster import cli, providers
    asked = []

    def get_secret(ref, group):
        asked.append(ref)
        if len(asked) > 1:
            raise providers.VaultLocked("Bitwarden vault is locked and there's no terminal to unlock it")
        return "pw-web-SECRET"
    monkeypatch.setattr(cli, "get_secret", get_secret)
    monkeypatch.setattr(cli, "enroll", lambda *a, **k: None)
    rc, out, err = run(capsys, "setup")
    assert rc == 1 and len(asked) == 2
    assert "[216] the vault was locked during this run" in out
    from roster.common import ssh_config_file
    assert "Host new-01" in ssh_config_file().read_text() and "Host web-01" in ssh_config_file().read_text()
    assert no_secret(out, err)


# ---------------------------------------------------------------- this Box's key deleted

def test_a_deleted_box_key_is_made_again_and_said(capsys, box, scans, monkeypatch):
    from roster import cli
    monkeypatch.setattr(cli, "ssh_ok", lambda name, timeout=10: True)
    run(capsys, "setup")
    cfg = load_config(box["path"])
    from pathlib import Path
    key = Path(cfg["key"])
    rc, out, _ = run(capsys, "check", "--box")
    assert "key" in out
    key.unlink()
    Path(str(key) + ".pub").unlink()
    rc, out, _ = run(capsys, "check", "--box")
    assert rc == 1 and str(key) in out                     # check --box flags it before setup runs
    rc, out, _ = run(capsys, "setup")
    assert f"warning: [218] {key} was gone, so this is a new key: every Host the old one was on needs this one" in out
