"""`roster add --from-vault` with no NAME (T221, #428, decision Q191): the vault items no Host, service or resource in
roster.yml refers to, new ones marked, and a walk through adding each. Fakes and temp HOMEs only: the stand-in bw
(its items carry fake passwords, TOTP seeds and notes, which must never show up anywhere), op and keepassxc-cli."""

import json
import os
import subprocess
import sys

import pytest

from roster.providers import bw_items_filter

SECRETS = ["pw-nas-SECRET", "totp-SEED-nas", "note-SECRET-nas", "pw-web-SECRET", "pw-old-SECRET", "field-SECRET",
           "pw-mapped-SECRET"]


def filtered(data: bytes, cap=None):
    """The filter as roster runs it: its own Python, isolated, no site; DATA on its stdin."""
    argv = [sys.executable, "-I", "-S", bw_items_filter.__file__] + ([str(cap)] if cap else [])
    return subprocess.run(argv, input=data, capture_output=True)


# ---------------------------------------------------------------- the filter between bw and roster

def test_the_filter_keeps_only_id_name_uris_and_username():
    items = [{"id": "aaaa-1", "name": "nas-01 ssh", "type": 1, "notes": "note-SECRET-nas",
              "fields": [{"name": "x", "value": "field-SECRET"}],
              "login": {"username": "admin", "password": "pw-nas-SECRET", "totp": "totp-SEED-nas",
                        "uris": [{"uri": "ssh://10.0.0.50", "match": None}, {"uri": "https://10.0.0.50"}]}}]
    r = filtered(json.dumps(items).encode())
    assert r.returncode == 0 and r.stderr == b""
    rows = [json.loads(line) for line in r.stdout.decode().splitlines()]
    assert rows == [{"id": "aaaa-1", "name": "nas-01 ssh", "uris": ["ssh://10.0.0.50", "https://10.0.0.50"],
                     "username": "admin", "revised": None}]
    assert not any(s.encode() in r.stdout for s in SECRETS)


def test_the_filter_skips_what_isnt_a_login_and_drops_values_of_the_wrong_type():
    items = [{"id": "n-1", "name": "a note", "type": 2, "notes": "note-SECRET-nas"},
             {"id": "c-1", "name": "a card", "type": 3, "card": {"number": "field-SECRET"}},
             {"id": "l-1", "name": 7, "type": 1, "login": {"username": ["x"], "uris": "ssh://x",
                                                             "password": "pw-old-SECRET"}},
             "not an item"]
    r = filtered(json.dumps(items).encode())
    assert r.returncode == 0
    assert [json.loads(x) for x in r.stdout.decode().splitlines()] == [
        {"id": "l-1", "name": "", "uris": [], "username": None, "revised": None}]
    assert not any(s.encode() in r.stdout + r.stderr for s in SECRETS)


def test_the_filter_passes_the_revision_date_for_vault_sync():
    items = [{"id": "aaaa-1", "name": "nas-01 ssh", "type": 1, "revisionDate": "2026-11-04T08:00:00.000Z",
              "login": {"password": "pw-nas-SECRET"}},
             {"id": "bbbb-2", "name": "web-02 web", "type": 1, "revisionDate": {"pw": "pw-web-SECRET"}}]
    rows = [json.loads(x) for x in filtered(json.dumps(items).encode()).stdout.decode().splitlines()]
    assert [r["revised"] for r in rows] == ["2026-11-04T08:00:00.000Z", None]      # a string or nothing
    assert not any(s in repr(rows) for s in SECRETS)


@pytest.mark.parametrize("data", [b"pw-nas-SECRET is not json", b'{"password": "pw-nas-SECRET"}',
                                  b'[{"id": "x", "login": {"password": "pw-nas-SECRET"}', b"\xff\xfe pw-nas-SECRET"])
def test_malformed_input_is_a_fixed_message_never_an_echo(data):
    r = filtered(data)
    assert r.returncode == 2
    assert r.stdout == b"" and r.stderr == b"not a list of items\n"


def test_input_over_the_cap_is_refused_unread():
    big = json.dumps([{"id": str(i), "name": f"h{i}", "type": 1, "login": {"password": "pw-nas-SECRET"}}
                      for i in range(2000)]).encode()
    r = filtered(big, cap=10_000)
    assert r.returncode == 3
    assert r.stdout == b"" and r.stderr == b"too many items\n"


# ---------------------------------------------------------------- the provider layer: bw's items, through the filter

ITEMS = [
    {"id": "aaaa-1", "name": "nas-01 ssh", "type": 1, "notes": "note-SECRET-nas",
     "fields": [{"name": "enable", "value": "field-SECRET"}],
     "login": {"username": "admin", "password": "pw-nas-SECRET", "totp": "totp-SEED-nas",
               "uris": [{"uri": "ssh://10.0.0.50:2200"}]}},
    {"id": "bbbb-2", "name": "web-02 web", "type": 1,
     "login": {"username": "www", "password": "pw-web-SECRET", "uris": [{"uri": "https://10.0.0.51/"}]}},
    {"id": "cccc-3", "name": "old box", "type": 1, "login": {"password": "pw-old-SECRET"}},
    {"id": "dddd-4", "name": "esx-02 ssh", "type": 1,
     "login": {"username": "root", "password": "pw-mapped-SECRET", "uris": [{"uri": "10.0.0.5"}]}},
    {"id": "eeee-5", "name": "a note", "type": 2, "notes": "note-SECRET-nas"},
]


@pytest.fixture
def bw(fakes, monkeypatch, tmp_path):
    f = tmp_path / "items.json"
    f.write_text(json.dumps(ITEMS))
    monkeypatch.setenv("FAKE_BW_ITEMS", str(f))
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    monkeypatch.setenv("FAKE_BW_ENV_LOG", str(tmp_path / "env.log"))
    monkeypatch.setenv("FAKE_BW_SYNC_FILE", str(tmp_path / "synced"))
    monkeypatch.setenv("BW_SESSION", "fake-session-key")
    return tmp_path


def calls(bw):
    log = bw / "argv.log"
    return [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []


def test_bw_items_are_listed_through_the_filter_and_never_carry_a_secret(bw):
    from roster import providers
    found = providers.vault_items("bw")
    assert [(i["id"], i["name"], i["uri"], i["username"]) for i in found] == [
        ("aaaa-1", "nas-01 ssh", "ssh://10.0.0.50:2200", "admin"), ("bbbb-2", "web-02 web", "https://10.0.0.51/", "www"),
        ("cccc-3", "old box", None, None), ("dddd-4", "esx-02 ssh", "10.0.0.5", "root")]
    assert not any(s in repr(found) for s in SECRETS)
    assert ["list", "items", "--nointeraction"] in calls(bw)
    assert not any(c[:2] == ["get", "password"] for c in calls(bw))


def test_the_filter_runs_without_the_session_key(tmp_path, monkeypatch):
    from roster import common
    out = tmp_path / "env"
    prod, filt = common.run_filtered(
        [sys.executable, "-c", "print('[]')"],
        [sys.executable, "-c", f"import os, sys; sys.stdin.read(); open({str(out)!r}, 'w').write(' '.join(os.environ))"],
        env={"BW_SESSION": "fake-session-key"}, filter_env=common.filter_env())
    assert prod.returncode == 0 and filt.returncode == 0 and prod.stdout is None
    assert "BW_SESSION" not in out.read_text().split()


def test_a_producer_failure_is_its_stderr_and_the_filter_never_sees_a_secret(tmp_path):
    from roster import common
    prod, filt = common.run_filtered(
        [sys.executable, "-c", "import sys; sys.stderr.write('Vault is locked.'); sys.exit(1)"],
        [sys.executable, "-I", "-S", bw_items_filter.__file__], filter_env=common.filter_env())
    assert prod.returncode == 1 and prod.stderr == "Vault is locked." and prod.stdout is None
    assert filt.returncode == 2


def test_malformed_bw_output_is_a_fixed_error_never_an_echo(bw, monkeypatch):
    from roster import providers
    monkeypatch.setenv("FAKE_BW_LIST_RAW", '{"password": "pw-nas-SECRET"')
    with pytest.raises(providers.SecretError) as e:
        providers.vault_items("bw")
    assert "pw-nas-SECRET" not in str(e.value) and "couldn't read" in str(e.value)


def test_too_many_items_is_refused(bw, monkeypatch):
    from roster import providers
    from roster.providers import bitwarden
    big = [{"id": f"id-{i}", "name": f"h{i}", "type": 1, "login": {"password": "pw-nas-SECRET", "notes": "x" * 200}}
           for i in range(5000)]                       # over a pipe's buffer: bw can't finish writing it
    (bw / "items.json").write_text(json.dumps(big))
    monkeypatch.setattr(bitwarden, "LIST_CAP", 10_000)
    with pytest.raises(providers.SecretError) as e:
        providers.vault_items("bw")
    assert "too many" in str(e.value) and not any(s in str(e.value) for s in SECRETS)


def test_sync_says_when_the_previous_one_was(bw, monkeypatch):
    from roster import providers
    monkeypatch.setenv("FAKE_BW_LAST_SYNC", "2026-11-04T09:00:00.000Z")
    assert providers.sync_vault("bw") == {"provider": "bw", "previous": "2026-11-04T09:00:00.000Z"}
    assert ["sync", "--nointeraction"] in calls(bw)
    assert providers.sync_vault("bw")["previous"] != "2026-11-04T09:00:00.000Z"      # the one just made


def test_sync_that_fails_says_so(bw, monkeypatch):
    from roster import providers
    monkeypatch.setenv("FAKE_BW_SYNC_FAIL", "Sync failed: server unreachable")
    with pytest.raises(providers.SecretError) as e:
        providers.sync_vault("bw")
    assert "server unreachable" in str(e.value)


# ---------------------------------------------------------------- 1Password and KeePassXC list without the password

OP_ITEMS = [
    {"id": "op-1", "title": "nas-01 ssh", "vault": "Infra", "username": "admin", "urls": ["ssh://10.0.0.50"],
     "fields": {"username": "admin", "password": "pw-nas-SECRET"}},
    {"id": "op-2", "title": "esx-02 ssh", "vault": "Infra", "username": "root", "urls": [],
     "fields": {"username": "root", "password": "pw-mapped-SECRET"}},
]


@pytest.fixture
def op(fakes, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_OP_ITEMS", json.dumps(OP_ITEMS))
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    monkeypatch.setenv("OP_SESSION_test", "tok")
    return tmp_path


def test_op_items_come_from_its_overviews_and_the_username_field_alone(op):
    from roster import providers
    found = providers.vault_items("op", mapped=lambda i: i["id"] == "op-2")
    assert [(i["id"], i["name"], i["uri"], i["username"]) for i in found] == [
        ("op-1", "nas-01 ssh", "ssh://10.0.0.50", "admin"), ("op-2", "esx-02 ssh", None, None)]
    assert "Infra/nas-01 ssh" in found[0]["keys"]
    argv = calls(op)
    assert ["op", "item", "list", "--categories", "Login", "--format", "json"] in argv
    gets = [c for c in argv if c[1:3] == ["item", "get"]]
    assert gets == [["op", "item", "get", "op-1", "--fields", "label=username", "--format", "json"]]  # the mapped one: none
    assert not any("--reveal" in c or "label=password" in c for c in argv)
    assert not any(s in repr(found) for s in SECRETS)


@pytest.fixture
def kp(fakes, tmp_path):
    from roster import providers
    db = tmp_path / "lab.kdbx"
    db.write_text(json.dumps({"password": "hunter2", "key": None, "recycle_bin": "Recycle Bin", "groups": ["Lab"],
                              "entries": [{"path": "Lab/nas-01 ssh", "UserName": "admin", "Password": "pw-nas-SECRET",
                                           "URL": "10.0.0.50", "Notes": "note-SECRET-nas"},
                                          {"path": "esx-02 ssh", "UserName": "root", "Password": "pw-mapped-SECRET",
                                           "URL": ""}]}))
    providers.setup_providers({"path": tmp_path / "roster.yml", "providers": {"kp": {"database": str(db)}}})
    (tmp_path / "argv.log").unlink(missing_ok=True)
    return tmp_path


def test_kp_lists_entry_paths_only_and_never_shows_an_entry(kp, monkeypatch):
    # `show -a UserName -a URL` resolves placeholders ({PASSWORD}, {REF:P@I:...}): it could print a password, so
    # roster never runs it here; the walk asks for the address and user instead (review of #439, M2)
    from roster import providers
    monkeypatch.setenv("FAKE_ARGV_LOG", str(kp / "argv.log"))
    providers.unlock("kp", "hunter2")
    found = providers.vault_items("kp")
    assert [(i["id"], i["name"], i["uri"], i["username"]) for i in found] == [
        ("esx-02 ssh", "esx-02 ssh", None, None), ("Lab/nas-01 ssh", "nas-01 ssh", None, None)]
    assert not any(c[0] == "show" for c in calls(kp))
    assert not any(s in repr(found) for s in SECRETS)


def test_a_kp_entry_like_an_option_is_left_out_and_kp_ends_its_options(kp, monkeypatch):
    from roster import providers
    db = kp / "lab.kdbx"
    data = json.loads(db.read_text())
    data["entries"].append({"path": "-s evil", "UserName": "x", "Password": "pw-old-SECRET"})
    db.write_text(json.dumps(data))
    monkeypatch.setenv("FAKE_ARGV_LOG", str(kp / "argv.log"))
    providers.unlock("kp", "hunter2")
    assert "-s evil" not in [i["id"] for i in providers.vault_items("kp")]
    assert all(c[c.index(str(db)) - 1] == "--" for c in calls(kp))


def test_a_locked_kp_database_is_never_opened_by_asking(kp, monkeypatch):
    from roster import providers
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)
    import getpass
    monkeypatch.setattr(getpass, "getpass", lambda *a: pytest.fail("asked for the master password"))
    with pytest.raises(providers.SecretError):
        providers.vault_items("kp")


# ---------------------------------------------------------------- `roster add --from-vault`

YML = """\
groups:
  lab:
    user: ops
    auth: env:LAB_PW
    hosts:
      esx-02: {ip: 10.0.0.5, auth: "bw:esx-02 ssh"}
"""


@pytest.fixture
def yml(write_config):
    return write_config(YML)


def add(capsys, *argv):
    from roster.cli import main
    try:
        rc = main(["add", "--from-vault", *argv])
    except SystemExit as e:
        rc = e.code
    out = capsys.readouterr()
    return rc, out.out, out.err


def seen_files(isolated):
    from roster.context import user_config_dir
    return sorted((user_config_dir() / "vault-seen").glob("*.json"))


def no_secret_anywhere(isolated, *texts):
    blob = "".join(texts) + "".join(f.read_text() for f in seen_files(isolated))
    blob += (isolated["work"] / "roster.yml").read_text()
    assert not any(s in blob for s in SECRETS)


def test_it_lists_the_items_no_login_names_marked_new_after_syncing(capsys, yml, bw, isolated, monkeypatch):
    monkeypatch.setenv("FAKE_BW_LAST_SYNC", "2026-11-04T09:00:00.000Z")
    rc, out, err = add(capsys)
    assert rc == 0
    assert "synced       bw (the previous sync was" in out
    assert "bw:nas-01 ssh" in out and "bw:web-02 web" in out and "bw:old box" in out
    assert "esx-02 ssh" not in out                          # roster.yml's esx-02 uses it
    assert "a note" not in out                              # not a login item
    assert "nas-01  10.0.0.50 port 2200, user admin" in out
    assert "3 vault items aren't in roster.yml (3 new)" in out
    assert [c[0] for c in calls(bw)].index("sync") < [c[:2] for c in calls(bw)].index(["list", "items"])
    no_secret_anywhere(isolated, out, err)
    assert yml.read_text() == YML                           # no terminal: a list, nothing added


def test_no_sync_skips_the_sync(capsys, yml, bw):
    rc, out, _ = add(capsys, "--no-sync")
    assert rc == 0 and "synced" not in out
    assert not any(c[0] == "sync" for c in calls(bw))


def test_json_is_the_list_only(capsys, yml, bw, isolated):
    rc, out, err = add(capsys, "--json", "--no-sync")
    assert rc == 0
    doc = json.loads(out)
    assert doc["version"] == 1 and doc["unmapped"] == 3 and doc["new"] == 3
    assert doc["items"][0] == {"provider": "bw", "id": "aaaa-1", "name": "nas-01 ssh", "auth": "bw:nas-01 ssh",
                               "new": True, "host": "nas-01", "address": "10.0.0.50", "port": 2200, "user": "admin"}
    assert doc["items"][2]["auth"] == "bw:old box" and "address" not in doc["items"][2]
    no_secret_anywhere(isolated, out, err)
    assert yml.read_text() == YML


def test_json_after_a_sync_is_still_the_one_document(capsys, yml, bw, monkeypatch):
    # found by the end-to-end suite: the sync's line came first on stdout, so stdout wasn't JSON
    monkeypatch.setenv("FAKE_BW_LAST_SYNC", "2026-11-04T09:00:00.000Z")
    rc, out, err = add(capsys, "--json")
    assert rc == 0 and json.loads(out)["unmapped"] == 3
    assert "synced       bw (the previous sync was" in err


def test_mark_seen_makes_them_old_and_all_shows_them_again(capsys, yml, bw, isolated):
    assert add(capsys, "--mark-seen", "--no-sync")[0] == 0
    [f] = seen_files(isolated)
    if os.name != "nt":                                     # Windows: the user's own %APPDATA%, no mode bits
        assert oct(f.stat().st_mode & 0o777) == "0o600"
    kept = json.loads(f.read_text())
    assert kept["items"] == {"bw": {"aaaa-1": "nas-01 ssh", "bbbb-2": "web-02 web", "cccc-3": "old box"}}
    rc, out, _ = add(capsys, "--no-sync")
    assert "no new vault items" in out and "3 seen before" in out and "bw:nas-01 ssh" not in out
    doc = json.loads(add(capsys, "--json", "--all", "--no-sync")[1])
    assert [i["new"] for i in doc["items"]] == [False, False, False]


def test_an_item_added_since_is_new(capsys, yml, bw):
    add(capsys, "--mark-seen", "--no-sync")
    items = json.loads((bw / "items.json").read_text())
    items.append({"id": "ffff-6", "name": "nas-02 ssh", "type": 1,
                  "login": {"username": "admin", "password": "pw-nas-SECRET", "uris": [{"uri": "10.0.0.52"}]}})
    (bw / "items.json").write_text(json.dumps(items))
    doc = json.loads(add(capsys, "--json", "--no-sync")[1])
    assert [(i["name"], i["new"]) for i in doc["items"]] == [("nas-02 ssh", True)]


def test_a_locked_vault_says_how_to_unlock_and_never_asks(capsys, yml, bw, monkeypatch):
    import getpass
    monkeypatch.delenv("BW_SESSION")
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)
    monkeypatch.setattr(getpass, "getpass", lambda *a: pytest.fail("asked for the master password"))
    monkeypatch.setattr("builtins.input", lambda *a: pytest.fail("asked something"))
    rc, out, err = add(capsys)
    assert rc != 0
    assert "[14]" in str(rc) + err and "locked" in str(rc) + err and "roster vault bw --write -- unlock" in str(rc) + err
    assert not any(c[0] == "list" for c in calls(bw))


def test_a_vault_roster_yml_doesnt_use_isnt_asked(capsys, write_config, bw):
    write_config("groups:\n  lab:\n    auth: env:LAB_PW\n    user: ops\n    hosts:\n      a: {ip: 10.0.0.5}\n")
    rc, out, err = add(capsys, "--no-sync")
    assert "[188]" in str(rc) + err
    assert calls(bw) == []


def walk(monkeypatch, *answers):
    asked = []
    it = iter(answers)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)

    def ask(text):
        asked.append(text)
        try:
            return next(it)
        except StopIteration:
            raise EOFError from None
    monkeypatch.setattr("builtins.input", ask)
    return asked


def test_the_walk_adds_a_yes_through_roster_add_and_remembers_a_no(capsys, yml, bw, monkeypatch, isolated):
    # nas-01: yes, group lab, enroll no, then no setup; web-02 web: no; old box: skip
    asked = walk(monkeypatch, "", "lab", "n", "n", "n", "skip")
    rc, out, err = add(capsys, "--no-sync")
    assert rc == 0
    assert "      nas-01: {ip: 10.0.0.50, user: admin, port: 2200, auth: bw:nas-01 ssh, enroll: false}\n" \
        in yml.read_text()
    assert "web-02" not in yml.read_text() and "old" not in yml.read_text()
    assert any("[Y/n/edit/skip]" in a and "nas-01" in a for a in asked)
    assert any("Set nas-01 up now" in a for a in asked)
    kept = json.loads(seen_files(isolated)[0].read_text())["items"]["bw"]
    assert set(kept) == {"aaaa-1", "bbbb-2"}                 # the skipped one is offered again next time
    no_secret_anywhere(isolated, out, err)


def test_edit_changes_the_name_address_and_user_first(capsys, yml, bw, monkeypatch):
    walk(monkeypatch, "edit", "nas-a", "10.0.0.70", "root", "lab", "n", "n", "skip", "skip")
    assert add(capsys, "--no-sync")[0] == 0
    # another address: the vault's port went with the vault's address, so it's left out (as with --ip, Q190)
    assert "      nas-a: {ip: 10.0.0.70, user: root, auth: bw:nas-01 ssh, enroll: false}\n" in yml.read_text()


def test_a_name_two_items_share_is_written_as_the_items_id(capsys, yml, bw, monkeypatch):
    items = json.loads((bw / "items.json").read_text())
    items.append({"id": "gggg-7", "name": "nas-01 ssh", "type": 1, "login": {"password": "pw-old-SECRET"}})
    (bw / "items.json").write_text(json.dumps(items))
    doc = json.loads(add(capsys, "--json", "--no-sync")[1])
    assert [i["auth"] for i in doc["items"] if i["name"] == "nas-01 ssh"] == ["bw:aaaa-1", "bw:gggg-7"]


def test_yes_lists_and_never_asks(capsys, yml, bw, monkeypatch):
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)
    monkeypatch.setattr("builtins.input", lambda *a: pytest.fail("asked something"))
    rc, out, _ = add(capsys, "-y", "--no-sync")
    assert rc == 0 and "bw:nas-01 ssh" in out and yml.read_text() == YML


def test_the_end_of_input_stops_the_walk_without_adding(capsys, yml, bw, monkeypatch):
    walk(monkeypatch)
    assert add(capsys, "--no-sync")[0] == 0
    assert yml.read_text() == YML


def test_check_box_shows_the_count_from_the_last_run(capsys, yml, bw):
    from roster.cli import main
    add(capsys, "--no-sync")
    main(["check", "--box"])
    assert "3 vault items aren't in roster.yml; roster add --from-vault" in capsys.readouterr().out


def test_name_with_from_vault_still_needs_auth_and_name_without_it_is_refused(capsys, yml, bw):
    rc, _, err = add(capsys, "--all", "nas")
    assert "--all" in str(rc) + err                          # the list's flags go with no NAME only


def test_the_list_flags_complete_after_add():
    from roster.completion import candidates
    found = candidates(["add"], "--", "bash")
    assert {"--from-vault", "--all", "--json", "--mark-seen", "--no-sync"} <= set(found)


def test_a_json_listing_that_fails_is_a_json_error(capsys, yml, bw, monkeypatch):
    monkeypatch.delenv("BW_SESSION")
    rc, out, err = add(capsys, "--json")
    assert rc == 1 and out == ""
    assert json.loads(err)["error"]["code"] == 14


def test_kp_from_the_cli_says_how_to_add_it_by_hand(capsys, write_config, kp):
    write_config(f"providers:\n  kp: {{database: {kp / 'lab.kdbx'}}}\ngroups:\n  lab:\n    user: ops\n    hosts:\n"
                 "      esx-02: {ip: 10.0.0.5, auth: \"kp:esx-02 ssh\"}\n")
    rc, out, err = add(capsys)
    assert "[14]" in str(rc) + err and "--ip ADDR --user USER --auth kp:ENTRY" in str(rc) + err


def test_setup_flag_sets_each_added_host_up_without_asking(capsys, yml, bw, monkeypatch):
    from roster import cli
    done = []
    monkeypatch.setattr(cli, "set_up", lambda name, path: done.append(name) or 0)
    asked = walk(monkeypatch, "", "lab", "n", "n", "n")
    assert add(capsys, "--no-sync", "--setup")[0] == 0
    assert done == ["nas-01"] and not any("up now" in a for a in asked)


# ---------------------------------------------------------------- review of #439: L1, L2, L5

def test_the_filter_drops_a_uris_userinfo():
    items = [{"id": "u-1", "name": "n", "type": 1, "login": {"uris": [
        {"uri": "ssh://admin:pw-nas-SECRET@10.0.0.50:2200/x"}, {"uri": "https://u:pw-web-SECRET@[fe80::1]/a?b#c"},
        {"uri": "admin:pw-old-SECRET@10.0.0.9"}, {"uri": "10.0.0.7"}]}}]
    r = filtered(json.dumps(items).encode())
    assert json.loads(r.stdout)["uris"] == ["ssh://10.0.0.50:2200/x", "https://[fe80::1]/a?b#c", "10.0.0.9",
                                           "10.0.0.7"]
    assert not any(s.encode() in r.stdout for s in SECRETS)


@pytest.mark.parametrize("uri, kept", [
    ("ssh://admin:ab#cd@host", "ssh://host"), ("admin:ab/cd@host", "host"), ("https://admin:ab?cd@host", "https://host"),
    ("//u:pw@h", "//h"), ("ssh:/u:pw@h", "ssh:/h"), ("u:pw@h", "h"), ("user@host", "host"),
    ("ssh://u:pw@[fe80::1]:22", "ssh://[fe80::1]:22"), ("ssh://u:p%40ss@h", "ssh://h"), ("ssh://u:p@ss@h/x", "ssh://h/x"),
    ("ssh://u:a%2Fb@h", "ssh://h"), ("10.0.0.7:2222", "10.0.0.7:2222"), ("https://h/a?b#c", "https://h/a?b#c")])
def test_no_password_in_a_uri_gets_past_the_filter(uri, kept):
    assert bw_items_filter.no_userinfo(uri) == kept


def test_op_urls_lose_their_userinfo_too(op, monkeypatch):
    from roster import providers
    monkeypatch.setenv("FAKE_OP_ITEMS", json.dumps([{**OP_ITEMS[0], "urls": ["sftp://admin:pw-nas-SECRET@10.0.0.50"]}]))
    [item] = providers.vault_items("op")
    assert item["uris"] == ["sftp://10.0.0.50"] and "pw-nas-SECRET" not in repr(item)


def test_control_characters_never_reach_the_terminal_or_the_login(capsys, yml, bw):
    items = json.loads((bw / "items.json").read_text())
    items.append({"id": "ffff-6", "name": "nas-03 ssh\x1b[2K\rAdd it as esx-02", "type": 1,
                  "login": {"username": "ad\u202emin", "uris": [{"uri": "10.0.0.53"}]}})
    (bw / "items.json").write_text(json.dumps(items))
    rc, out, err = add(capsys, "--no-sync")
    assert "\x1b" not in out + err and "\u202e" not in out + err and "\r" not in out
    assert "bw:ffff-6" in out                               # the Login names it by id, not by that name
    doc = json.loads(add(capsys, "--json", "--no-sync")[1])
    [row] = [i for i in doc["items"] if i["id"] == "ffff-6"]
    assert row["auth"] == "bw:ffff-6" and "user" not in row


def test_the_walk_asks_for_a_user_when_the_item_has_none(capsys, yml, bw, monkeypatch):
    # old box: no URI, no username: asked for its address (roster add) and its user (the walk)
    asked = walk(monkeypatch, "n", "n", "", "root", "lab", "10.0.0.80", "n", "n")
    add(capsys, "--no-sync", "--all")
    assert any(a.startswith("User") for a in asked)
    assert "old-box: {ip: 10.0.0.80, user: root, auth: bw:old box, enroll: false}" in yml.read_text()


def test_a_filter_that_takes_too_long_stops_both_programs(tmp_path):
    from roster import common
    with pytest.raises(subprocess.TimeoutExpired):
        common.run_filtered([sys.executable, "-c", "import time; time.sleep(30)"],
                            [sys.executable, "-c", "import sys; sys.stdin.read()"], timeout=1,
                            filter_env=common.filter_env())


def test_roster_never_reads_the_producers_output(monkeypatch):
    """The producer's stdout is handed to the filter and closed: nothing in roster reads from it."""
    from roster import common
    real = subprocess.Popen
    made = []

    class Unreadable:
        def __init__(self, f):
            self.f = f

        def fileno(self):
            return self.f.fileno()

        def close(self):
            self.f.close()

        @property
        def closed(self):
            return self.f.closed

        def __getattr__(self, name):
            raise AssertionError(f"roster touched the producer's stdout ({name})")

    def spy(*a, **kw):
        p = real(*a, **kw)
        if not made:
            p.stdout = Unreadable(p.stdout)
        made.append(p)
        return p
    monkeypatch.setattr(subprocess, "Popen", spy)
    prod, filt = common.run_filtered([sys.executable, "-c", "print('pw-nas-SECRET')"],
                                     [sys.executable, "-c", "import sys; sys.stdin.read(); print('ok')"],
                                     filter_env=common.filter_env())
    assert made[0].stdout.closed and prod.stdout is None and filt.stdout.strip() == "ok"
    assert "pw-nas-SECRET" not in prod.stderr + filt.stdout + filt.stderr
