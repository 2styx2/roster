"""The KeePassXC provider (ticket 25): auth: kp:ENTRY / kp:ENTRY#FIELD, through keepassxc-cli and a local .kdbx.
The stand-in keepassxc-cli (tests/fakes) keeps its "database" as JSON at the .kdbx path."""

import json
import subprocess

import pytest
from conftest import WINDOWS

from roster import providers
from roster.common import kill_tree
from roster.providers import get_secret, setup_providers

MASTER = "c0rrect-h0rse"                # the database's master password: never in argv, output or an error
NEW_PW = "n3w-kp-s3cret"


def make_db(path, entries, groups=(), key=None):
    path.write_text(json.dumps({"password": MASTER, "key": key, "recycle_bin": "Recycle Bin",
                                "groups": list(groups), "entries": entries}))
    return path


@pytest.fixture
def kdbx(fakes, isolated, tmp_path, monkeypatch):
    """A database with an ssh Login at the top, one in a group, a duplicate title, and one with no password."""
    db = make_db(tmp_path / "roster.kdbx", [
        {"path": "esx ssh", "UserName": "root", "Password": "pw-esx", "URL": "ssh://10.0.0.6",
         "attrs": {"enable": "pw-enable"}},
        {"path": "Lab/nas ssh", "UserName": "admin", "Password": "pw-nas"},
        {"path": "dup ssh", "Password": "pw-dup-1"},
        {"path": "Lab/dup ssh", "Password": "pw-dup-2"},
        {"path": "nopw ssh", "UserName": "x", "Password": ""},
    ], groups=["Lab"])
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    setup_providers({"path": isolated["work"] / "roster.yml", "providers": {"kp": {"database": str(db)}}})
    return db


def argv_log(tmp_path):
    f = tmp_path / "argv.log"
    return f.read_text() if f.exists() else ""


def test_reads_a_login_and_its_fields_after_unlocking(kdbx, tmp_path):
    providers.unlock("kp", MASTER)
    assert get_secret("kp:esx ssh", "g") == "pw-esx"
    assert get_secret("kp:esx ssh#username", "g") == "root"
    assert get_secret("kp:esx ssh#enable", "g") == "pw-enable"
    assert get_secret("kp:nas ssh", "g") == "pw-nas"                 # found in its group by title
    assert get_secret("kp:Lab/dup ssh", "g") == "pw-dup-2"           # a path picks one of two
    assert MASTER not in argv_log(tmp_path)


def test_a_wrong_master_password_says_so_without_echoing_it(kdbx, tmp_path):
    with pytest.raises(providers.WrongPassword, match="wrong master password") as e:
        providers.unlock("kp", "not-it-xyzzy")
    assert "xyzzy" not in str(e.value) and "xyzzy" not in argv_log(tmp_path)
    assert providers.vault_status("kp") == "locked"


def test_a_locked_database_is_never_opened_with_a_guess(kdbx, tmp_path, monkeypatch):
    assert providers.vault_status("kp") == "locked"
    with pytest.raises(providers.VaultLocked, match="no terminal"):   # the CLI with no terminal: 14, not 35 (#437)
        get_secret("kp:esx ssh", "g")
    providers.only_unlock_unlocks()                                     # as under `roster serve`
    with pytest.raises(providers.VaultLocked, match="KeePassXC database is locked"):
        get_secret("kp:esx ssh", "g")
    assert argv_log(tmp_path) == ""                                     # keepassxc-cli never ran


def test_lock_forgets_the_master_password_and_every_value(kdbx):
    providers.unlock("kp", MASTER)
    assert get_secret("kp:esx ssh", "g") == "pw-esx"
    assert providers.vault_status("kp") == "unlocked"
    providers.lock("kp")
    assert providers.vault_status("kp") == "locked"
    providers.only_unlock_unlocks()
    with pytest.raises(providers.VaultLocked):
        get_secret("kp:esx ssh", "g")


def test_what_is_wrong_with_an_entry_names_it(kdbx):
    providers.unlock("kp", MASTER)
    with pytest.raises(providers.ItemNotFound, match="no KeePassXC entry titled 'esx shh'") as e:
        get_secret("kp:esx shh", "g")
    assert e.value.near[0] == "esx ssh"
    with pytest.raises(providers.SeveralItems, match=r"dup ssh, Lab/dup ssh") as e:
        get_secret("kp:dup ssh", "g")
    assert [m["name"] for m in e.value.matches] == ["dup ssh", "Lab/dup ssh"] and e.value.exact
    with pytest.raises(providers.NoField, match="'nopw ssh' has no password"):
        get_secret("kp:nopw ssh", "g")
    with pytest.raises(providers.NoField, match="no field 'missing'"):
        get_secret("kp:esx ssh#missing", "g")
    with pytest.raises(providers.ItemNotFound):
        get_secret("kp:Lab/nothing", "g")


def test_a_key_file_goes_with_the_password(fakes, isolated, tmp_path):
    key = tmp_path / "roster.key"
    key.write_text("key-bytes")
    db = make_db(tmp_path / "k.kdbx", [{"path": "esx ssh", "Password": "pw-esx"}], key="key-bytes")
    setup_providers({"path": isolated["work"] / "roster.yml", "providers": {"kp": {"database": str(db)}}})
    with pytest.raises(providers.WrongPassword, match="wrong master password"):   # the key file is missing
        providers.unlock("kp", MASTER)
    setup_providers({"path": tmp_path / "roster.yml",                 # k.kdbx: relative to roster.yml's folder
                     "providers": {"kp": {"database": "k.kdbx", "key_file": str(tmp_path / "nope.key")}}})
    with pytest.raises(providers.NotLoggedIn, match="key file"):
        providers.unlock("kp", MASTER)
    setup_providers({"path": tmp_path / "roster.yml", "providers": {"kp": {"database": "k.kdbx", "key_file": str(key)}}})
    providers.unlock("kp", MASTER)
    assert get_secret("kp:esx ssh", "g") == "pw-esx"


def test_status_tells_a_missing_cli_from_a_box_without_a_database(fakes, isolated, tmp_path, monkeypatch):
    assert providers.vault_status("kp") == "unauthenticated"
    assert "add  providers: {kp: {database:" in providers.status_message("kp", "unauthenticated")
    setup_providers({"path": isolated["work"] / "roster.yml", "providers": {"kp": {"database": "~/gone.kdbx"}}})
    assert providers.vault_status("kp") == "unauthenticated"
    assert f"{isolated['home'] / 'gone.kdbx'} isn't there" in providers.status_message("kp", "unauthenticated")
    with pytest.raises(providers.NotLoggedIn, match="isn't there"):
        providers.unlock("kp", MASTER)
    monkeypatch.setenv("PATH", str(tmp_path))
    assert providers.vault_status("kp") == "missing"
    assert "`keepassxc-cli` is not installed" in providers.status_message("kp", "missing")


# ---- "Save to vault" (ticket 13's create, Q43's undo)

def entries(db):
    return {e["path"]: e for e in json.loads(db.read_text())["entries"]}


def test_creates_a_login_entry_with_the_passwords_off_the_command_line(kdbx, tmp_path):
    providers.unlock("kp", MASTER)
    assert providers.can_write("kp")
    made = providers.create_item("kp", name="box ssh", username="ops", password=NEW_PW, uri="ssh://10.0.0.5")
    assert made == {"id": "box ssh", "name": "box ssh", "target": {"id": "personal", "kind": "personal", "label": "Top level"}}
    e = entries(kdbx)["box ssh"]
    assert (e["UserName"], e["Password"], e["URL"]) == ("ops", NEW_PW, "ssh://10.0.0.5")
    assert get_secret("kp:box ssh", "g") == NEW_PW
    log = argv_log(tmp_path)
    assert NEW_PW not in log and MASTER not in log


def test_creates_in_the_group_set_for_it(kdbx, isolated):
    setup_providers({"path": isolated["work"] / "roster.yml", "providers": {"kp": {"database": str(kdbx), "group": "Lab"}}})
    providers.unlock("kp", MASTER)
    made = providers.create_item("kp", name="box ssh", password=NEW_PW)
    assert made == {"id": "Lab/box ssh", "name": "box ssh", "target": {"id": "group:Lab", "kind": "group", "label": "Lab"}}
    assert entries(kdbx)["Lab/box ssh"]["Password"] == NEW_PW


def test_refuses_a_title_that_is_already_there_in_any_group(kdbx):
    providers.unlock("kp", MASTER)
    before = kdbx.read_text()
    with pytest.raises(providers.ItemExists, match="'nas ssh' already exists") as e:
        providers.create_item("kp", name="nas ssh", password=NEW_PW)  # it's in Lab/: kp:nas ssh would be ambiguous
    assert e.value.matches == [{"name": "Lab/nas ssh", "revised": None, "uris": []}]
    assert kdbx.read_text() == before
    with pytest.raises(providers.WriteFailed, match="can't contain '/'"):
        providers.create_item("kp", name="Lab/box ssh", password=NEW_PW)


def test_undo_moves_the_entry_to_the_recycle_bin(kdbx):
    providers.unlock("kp", MASTER)
    made = providers.create_item("kp", name="box ssh", password=NEW_PW)
    assert get_secret("kp:box ssh", "g") == NEW_PW
    providers.delete_item("kp", made["id"])
    assert "box ssh" not in entries(kdbx) and "Recycle Bin/box ssh" in entries(kdbx)
    with pytest.raises(providers.ItemNotFound):                     # nothing cached from it, and the bin is skipped
        get_secret("kp:box ssh", "g")
    assert providers.create_item("kp", name="box ssh", password=NEW_PW)["id"] == "box ssh"   # free again


def test_a_refused_create_or_delete_never_echoes_a_password(kdbx, monkeypatch):
    providers.unlock("kp", MASTER)
    monkeypatch.setenv("FAKE_KP_WRITE_FAIL", f"Writing the database failed: read-only file system {NEW_PW} {MASTER}")
    with pytest.raises(providers.WriteFailed, match="KeePassXC didn't create 'box ssh': Writing the database") as e:
        providers.create_item("kp", name="box ssh", password=NEW_PW)
    assert NEW_PW not in str(e.value) and MASTER not in str(e.value)
    with pytest.raises(providers.WriteFailed, match="didn't delete"):
        providers.delete_item("kp", "esx ssh")


def stops_answering_at_the_fake_s_word(monkeypatch):
    """`keepassxc-cli add` times out exactly when the stand-in says it has got where it hangs (FAKE_KP_ADD_HANG:
    saved; FAKE_KP_ADD_STALL: nothing saved), never on a clock: a 1 s limit timed out on Windows CI before the
    stand-in had even started (#487 item 6). Every other call runs as roster runs it, with its usual time."""
    real = providers.run

    def run(args, timeout=None, input=None, **kw):
        if "add" not in args:
            return real(args, timeout=timeout, input=input, **kw)
        kw = {k: v for k, v in kw.items() if k not in ("stdin", "stdout")}
        with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              **kw) as p:
            assert p.stdin and p.stdout
            p.stdin.write(input)
            p.stdin.close()
            said = p.stdout.readline()                  # blocks until the stand-in gets there (or exits)
            kill_tree(p)
            p.stdout.close()
            p.wait()
        assert "fake: hanging" in said, said
        raise subprocess.TimeoutExpired(args, timeout)

    monkeypatch.setattr(providers, "run", run)


def test_a_create_that_timed_out_counts_if_the_entry_is_there(kdbx, monkeypatch):
    providers.unlock("kp", MASTER)
    stops_answering_at_the_fake_s_word(monkeypatch)
    monkeypatch.setenv("FAKE_KP_ADD_HANG", "1")                                 # saved, then no answer
    assert providers.create_item("kp", name="box ssh", password=NEW_PW)["id"] == "box ssh"
    assert get_secret("kp:box ssh", "g") == NEW_PW
    monkeypatch.delenv("FAKE_KP_ADD_HANG")
    monkeypatch.setenv("FAKE_KP_ADD_STALL", "1")                                # no answer, nothing saved
    with pytest.raises(providers.WriteFailed, match="nothing was saved"):
        providers.create_item("kp", name="nas2 ssh", password=NEW_PW)
    assert "nas2 ssh" not in entries(kdbx)


# ---- through `roster serve`, as the lock screen and "Save to vault" use it

KP_INVENTORY = """\
providers:
  kp: {database: roster.kdbx}
groups:
  lab:
    user: root
    auth: kp:esx ssh
    hosts:
      esx: {ip: 10.0.0.6, enroll: false}
      nas: {ip: 10.0.0.7, enroll: false, auth: "kp:nas ssh"}
"""


def test_serve_locks_unlocks_and_saves_to_keepassxc_like_bitwarden(serve, write_config, fakes, isolated, tmp_path,
                                                                     monkeypatch):
    db = make_db(isolated["work"] / "roster.kdbx", [{"path": "esx ssh", "Password": "pw-esx"}])
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    write_config(KP_INVENTORY)
    s = serve()
    locked = {"provider": "kp", "status": "locked", "can_write": True, "can_sign_out": False}
    assert s.call("vault.status")["result"] == {**locked, "save_to": {"setting": "personal", "from": "default"},
                                               "providers": [locked]}
    assert s.call("vault.create_item", {"name": "box ssh", "password": NEW_PW})["error"]["code"] == 14
    err = s.call("vault.unlock", {"password": "not-it-xyzzy"})["error"]
    assert err == {"code": 10, "message": "KeePassXC unlock failed (wrong master password?)"}
    assert s.call("vault.unlock", {"password": MASTER})["result"] == {"provider": "kp", "status": "unlocked",
                                                                      "can_write": True}
    assert s.call("vault.status")["result"]["status"] == "unlocked"

    params = {"name": "nas ssh", "username": "admin", "password": NEW_PW, "uri": "ssh://10.0.0.7"}
    made = s.call("vault.create_item", params)["result"]
    assert made == {"provider": "kp", "id": "nas ssh", "name": "nas ssh", "target": {"id": "personal", "kind": "personal", "label": "Top level"}}
    assert entries(db)["nas ssh"]["Password"] == NEW_PW
    dup = s.call("vault.create_item", params)["error"]
    assert dup["code"] == 60 and dup["data"]["matches"] == [{"name": "nas ssh", "revised": None, "uris": []}]
    assert s.call("vault.undo_create", {"id": made["id"]})["result"] == {"provider": "kp", "id": "nas ssh"}
    assert "nas ssh" not in entries(db)
    assert s.call("vault.undo_create", {"id": made["id"]})["error"]["code"] == 63

    assert s.call("vault.lock")["result"] == {"locked": ["kp"]}
    assert s.call("vault.status")["result"]["status"] == "locked"
    code, out, err = s.close()
    assert code == 0 and out == ""
    for where in (json.dumps(s.responses), err, argv_log(tmp_path)):
        assert NEW_PW not in where and MASTER not in where and "xyzzy" not in where


def test_serve_says_what_to_set_up_on_a_box_without_the_database(serve, write_config, fakes):
    write_config(KP_INVENTORY)                                          # roster.kdbx isn't there
    s = serve()
    status = s.call("vault.status")["result"]
    assert status["status"] == "not-logged-in" and "roster.kdbx isn't there" in status["message"]
    assert s.call("vault.unlock", {"password": MASTER})["error"]["code"] == 11
    err = s.call("vault.login", {"provider": "kp", "method": "sso"})["error"]   # no sign-in: unlock
    assert err["code"] == 13 and "KeePassXC has no sign-in" in err["message"]


def test_a_password_session_gets_its_password_from_keepassxc(serve, write_config, fakes, isolated, capsys):
    from test_serve import run_askpass, synced
    make_db(isolated["work"] / "roster.kdbx", [{"path": "esx ssh", "Password": "pw-esx"}])
    synced(write_config, capsys, KP_INVENTORY)
    s = serve()
    assert s.call("session.prepare", {"host": "esx"})["error"]["code"] == 14          # locked
    s.call("vault.unlock", {"password": MASTER})
    assert s.call("session.prepare", {"host": "nas"})["error"]["code"] == 32          # no such entry
    spec = s.call("session.prepare", {"host": "esx"})["result"]
    assert spec["auth"] == "password" and run_askpass(spec).stdout == "pw-esx\n"


# ---- the database from the app's init.lua (ticket 41): vault.configure, paths only, wins over roster.yml

KP_NO_DB = KP_INVENTORY.replace("providers:\n  kp: {database: roster.kdbx}\n", "")


def test_the_box_settings_win_over_roster_yml(kdbx, tmp_path):
    other = make_db(tmp_path / "mine.kdbx", [{"path": "esx ssh", "Password": "pw-mine"}])
    providers.configure_box({"kp": {"database": str(other)}})
    providers.unlock("kp", MASTER)
    assert get_secret("kp:esx ssh", "g") == "pw-mine"
    providers.configure_box({})                                         # init.lua leaves it out: roster.yml's again
    assert providers.vault_status("kp") == "locked"                     # its master password went with the database
    providers.unlock("kp", MASTER)
    assert get_secret("kp:esx ssh", "g") == "pw-esx"


def test_a_missing_database_or_key_file_from_init_lua_says_to_fix_init_lua(fakes, isolated, tmp_path):
    setup_providers({"path": isolated["work"] / "roster.yml", "providers": {"kp": {"database": "roster.kdbx"}}})
    providers.configure_box({"kp": {"database": "~/gone.kdbx"}})
    msg = providers.status_message("kp", providers.vault_status("kp"))
    assert f"{isolated['home'] / 'gone.kdbx'} isn't there" in msg and "vault.kp.database in init.lua" in msg
    db = make_db(tmp_path / "k.kdbx", [{"path": "esx ssh", "Password": "pw-esx"}], key="key-bytes")
    providers.configure_box({"kp": {"database": str(db), "key_file": str(tmp_path / "nope.key")}})
    with pytest.raises(providers.NotLoggedIn, match="vault.kp.key_file in init.lua"):
        providers.unlock("kp", MASTER)


def test_serve_takes_the_database_from_init_lua(serve, write_config, fakes, isolated, tmp_path, monkeypatch):
    db = make_db(tmp_path / "mine.kdbx", [{"path": "esx ssh", "Password": "pw-esx"}])
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    write_config(KP_NO_DB)                                              # roster.yml names no database
    s = serve()
    assert s.call("vault.status")["result"]["status"] == "not-logged-in"
    assert s.call("vault.configure", {"kp": {"database": str(db)}})["result"] == {"configured": True, "locked": [], "refused": []}
    assert s.call("vault.status")["result"]["status"] == "locked"
    s.call("vault.unlock", {"password": MASTER})
    made = s.call("vault.create_item", {"name": "box ssh", "password": NEW_PW})["result"]
    assert made["id"] == "box ssh" and entries(db)["box ssh"]["Password"] == NEW_PW
    assert s.call("inventory.reload")["result"]                        # a reload of roster.yml keeps it
    assert s.call("vault.status")["result"]["status"] == "unlocked"
    # the same settings again change nothing; another database forgets the master password
    assert s.call("vault.configure", {"kp": {"database": str(db)}})["result"]["locked"] == []
    other = make_db(tmp_path / "other.kdbx", [])
    assert s.call("vault.configure", {"kp": {"database": str(other)}})["result"]["locked"] == ["kp"]
    assert s.call("vault.status")["result"]["status"] == "locked"
    assert s.call("vault.configure", {})["result"]["locked"] == []      # back to roster.yml's (none)
    assert s.call("vault.status")["result"]["status"] == "not-logged-in"
    code, out, err = s.close()
    assert code == 0 and out == ""
    for where in (json.dumps(s.responses), err, argv_log(tmp_path)):
        assert NEW_PW not in where and MASTER not in where


@pytest.mark.parametrize("value", ["roster.kdbx", "", 7, pytest.param(
    "C:\\Users\\you\\roster.kdbx", marks=pytest.mark.skipif(WINDOWS, reason="the right kind of path for roster on Windows"))])
def test_serve_refuses_only_the_path_it_cant_use_and_takes_the_rest(serve, write_config, fakes, tmp_path, value):
    """A path that isn't absolute or ~/... (relative to what, on which box?) is left out, as if init.lua didn't set
    it, and named in `refused`; the other settings still apply."""
    db = make_db(tmp_path / "mine.kdbx", [{"path": "esx ssh", "Password": "pw-esx"}])
    write_config(KP_NO_DB)
    s = serve()
    r = s.call("vault.configure", {"save_to": "personal", "kp": {"database": str(db), "key_file": value}})["result"]
    assert r["configured"] is True and r["locked"] == []
    [refused] = r["refused"]
    assert refused["setting"] == "kp.key_file" and "path" in refused["message"]
    status = s.call("vault.status")["result"]
    assert status["status"] == "locked"                                 # the database was taken
    assert status["save_to"] == {"setting": "personal", "from": "init.lua"}
    assert s.call("vault.configure", {"kp": {"database": str(db)}})["result"]["refused"] == []


@pytest.mark.parametrize("params, field", [
    ({"kp": {"password": "x"}}, "kp.password"),                         # paths only: never a secret
    ({"kp": "~/roster.kdbx"}, "kp"),
    ({"bw": {}}, "bw"),
])
def test_serve_refuses_box_settings_it_cant_use(serve, write_config, fakes, params, field):
    write_config(KP_NO_DB)
    s = serve()
    err = s.call("vault.configure", params)["error"]
    assert err["code"] == -32602 and field in err["message"]
    assert s.call("vault.status")["result"]["status"] == "not-logged-in"   # nothing applied
