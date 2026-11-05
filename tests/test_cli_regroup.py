"""The CLI regroup (T222, #430, decision Q194): 14 top-level commands, and every old name kept as a hidden alias that
says its new form once on stderr (`roster completion`, run by the shell at every start, says nothing). The aliases are
one table (roster.aliases), rewritten before the parser sees the command line."""

import json

import pytest
from conftest import WINDOWS

from roster import aliases, clihelp
from roster.cli import main


@pytest.mark.parametrize(("old", "new"), [
    (["auth-check", "--only", "web"], ["check", "--auth", "--only", "web"]),
    (["info", "esx-02"], ["hosts", "esx-02"]),
    (["resources", "--find", "guest"], ["hosts", "--resources", "--find", "guest"]),
    (["providers", "--json"], ["vault", "status", "--json"]),
    (["reveal", "lab-guest", "--wifi"], ["vault", "reveal", "lab-guest", "--wifi"]),
    (["bw", "--write", "login"], ["vault", "bw", "--write", "login"]),
    (["man", "--install"], ["help", "--man", "--install"]),
    (["completion", "bash"], ["help", "--completion", "bash"]),
    (["mesh", "--find-leftovers"], ["mesh", "leftovers"]),
    (["mesh", "--remove-leftovers", "-y"], ["mesh", "leftovers", "--remove", "-y"]),
    (["-c", "x/roster.yml", "info", "db"], ["-c", "x/roster.yml", "hosts", "db"]),
    (["--inv=home", "providers"], ["--inv=home", "vault", "status"]),
    (["--conf", "x.yml", "info", "web"], ["--conf", "x.yml", "hosts", "web"]),     # argparse's abbreviations (L2)
    (["--in", "home", "providers"], ["--in", "home", "vault", "status"]),
])
def test_an_old_name_becomes_its_new_form(old, new):
    argv, alias = aliases.rewrite(old)
    assert argv == new
    assert alias is not None


@pytest.mark.parametrize("argv", [["hosts", "info"], ["run", "web-01", "--", "man", "ls"], ["sync"], [],
                                  ["-c", "info", "hosts"], ["mesh", "--", "--find-leftovers"],
                                  ["--conf", "info", "hosts"], ["--confi=info", "hosts"]])
def test_a_new_form_or_an_old_word_elsewhere_is_left_alone(argv):
    assert aliases.rewrite(argv) == (argv, None)


def test_every_alias_but_completion_names_its_new_form():
    for a in aliases.ALIASES:
        if a.old == ("completion",):
            assert a.silent
        else:
            assert not a.silent and aliases.warning(a).startswith("warning: `roster ")
            assert f"`{a.usage}`" in aliases.warning(a)


# ---------------------------------------------------------------- the commands, old and new, through main

CONFIG = """\
groups:
  lab:
    hosts:
      esx-02: {ip: 10.0.0.5, user: root, auth: "env:ESX_PW", title: the lab ESXi}
resources:
  lab-guest: {type: wifi, ssid: lab-guest, auth: "env:WIFI_PW"}
"""
TOP = ["init", "add", "discover", "hosts", "check", "setup", "revoke", "sync", "run", "web", "mesh", "inv", "vault",
       "help"]


@pytest.fixture
def config(write_config, monkeypatch):
    monkeypatch.setenv("ESX_PW", "pw-esx-SECRET")
    monkeypatch.setenv("WIFI_PW", "pw-wifi-SECRET")
    return write_config(CONFIG)


def run(capsys, *argv):
    rc = main(list(argv))
    out = capsys.readouterr()
    return rc, out.out, out.err


def test_the_overview_lists_the_fourteen_commands_and_hides_the_internal_ones(capsys):
    assert main([]) == 0
    out = capsys.readouterr().out
    listed = [line.split()[0] for line in out.splitlines() if line.startswith("  ") and not line.startswith("   ")
              and not line.strip().startswith(("roster ", "ssh ", "#", "-"))]
    assert sorted(listed) == sorted(TOP)
    for hidden in ("serve", "askpass", "__complete", "info", "bw", "providers", "auth-check", "man", "completion"):
        assert f"\n  {hidden} " not in out


@pytest.mark.parametrize(("old", "new"), [
    (["auth-check"], ["check", "--auth"]),
    (["info", "esx-02"], ["hosts", "esx-02"]),
    (["resources"], ["hosts", "--resources"]),
    (["providers"], ["vault", "status"]),
    (["reveal", "lab-guest"], ["vault", "reveal", "lab-guest"]),
])
def test_an_old_name_does_what_the_new_form_does_and_says_it_once(capsys, config, old, new):
    rc_new, out_new, err_new = run(capsys, *new)
    rc_old, out_old, err_old = run(capsys, *old)
    assert (rc_old, out_old) == (rc_new, out_new)
    added = err_old.removesuffix(err_new) if err_old.endswith(err_new) else err_old
    assert added.count("\n") == 1 and added.startswith("warning: `roster ") and "is now `roster " in added
    assert "warning: `roster" not in err_new


def test_completion_under_its_old_name_says_nothing(capsys):
    rc, out, err = run(capsys, "completion", "bash")
    assert rc == 0 and err == ""
    assert out == run(capsys, "help", "--completion", "bash")[1]
    assert "complete -F _roster roster" in out


def test_hosts_name_is_what_info_was(capsys, config):
    rc, out, _ = run(capsys, "hosts", "esx-02")
    assert rc == 0 and "the lab ESXi" in out and "root@10.0.0.5:22" in out
    rc, out, _ = run(capsys, "hosts", "lab", "esxi")                  # fuzzy words, as before
    assert rc == 0 and "esx-02" in out


def test_hosts_name_takes_no_list_flags(capsys, config):
    with pytest.raises(SystemExit) as e:
        main(["hosts", "esx-02", "--long"])
    assert e.value.code == 2
    assert "NAME" in capsys.readouterr().err


def test_hosts_resources_lists_only_resources(capsys, config):
    rc, out, _ = run(capsys, "hosts", "--resources")
    assert rc == 0 and "lab-guest" in out and "esx-02" not in out


def test_check_auth_tests_the_logins_and_prints_nothing_secret(capsys, config):
    rc, out, _ = run(capsys, "check", "--auth")
    assert rc == 0 and "ok" in out and "env:ESX_PW" in out
    assert "pw-esx-SECRET" not in out


def test_check_auth_takes_no_host_or_box(capsys, config):
    for argv in (["check", "--auth", "esx-02"], ["check", "--auth", "--box"]):
        with pytest.raises(SystemExit) as e:
            main(argv)
        assert e.value.code == 2
    assert "--auth" in capsys.readouterr().err


def test_vault_reveal_prints_the_secret_for_a_person(capsys, config):
    assert run(capsys, "vault", "reveal", "lab-guest")[:2] == (0, "pw-wifi-SECRET\n")


def test_vault_status_lists_the_providers_and_the_vault_state(capsys, config):
    rc, out, _ = run(capsys, "vault", "status")
    assert rc == 0
    assert "bw " in out and "op " in out and "env " in out          # the providers, as `roster providers` did
    assert "used by: lab" in out


def test_plain_vault_shows_its_commands(capsys):
    rc, out, _ = run(capsys, "vault")
    assert rc == 0
    for sub in ("status", "sync", "reveal", "bw"):
        assert sub in out


def test_help_is_the_overview_and_help_command_is_its_help(capsys):
    assert run(capsys, "help")[1] == run(capsys)[1]
    rc, out, _ = run(capsys, "help", "hosts")
    assert rc == 0 and out.startswith("usage: roster hosts ")
    rc, out, _ = run(capsys, "help", "vault", "bw")
    assert rc == 0 and out.startswith("usage: roster vault bw ")


def test_help_of_an_unknown_topic_is_a_usage_error(capsys):
    with pytest.raises(SystemExit) as e:
        main(["help", "nope"])
    assert e.value.code == 2
    err = capsys.readouterr().err
    assert "no help for that (not repeated): `roster help` lists the commands" in err and "nope" not in err   # T235


def test_help_man_without_man_says_where_the_page_is(capsys, monkeypatch):
    from roster import manpage
    monkeypatch.setattr(manpage, "find_program", lambda name: None)
    rc, _, err = run(capsys, "help", "--man")
    assert rc == 1 and "roster.1" in err


def test_help_man_install_copies_the_page(capsys, tmp_path):
    rc, out, _ = run(capsys, "help", "--man", "--install", "--prefix", str(tmp_path / "p"))
    assert rc == 0 and (tmp_path / "p" / "share" / "man" / "man1" / "roster.1").exists()


def test_install_goes_with_man(capsys):
    with pytest.raises(SystemExit) as e:
        main(["help", "--install"])
    assert e.value.code == 2


def test_every_group_lists_only_top_level_commands():
    grouped = [n for _, names in clihelp.GROUPS for n in names]
    assert sorted(grouped) == sorted(TOP)


# ---------------------------------------------------------------- roster vault sync: what changed since the last sync

VAULT_YML = """\
groups:
  lab:
    hosts:
      esx-02: {ip: 10.0.0.5, user: root, auth: "bw:esx-02 ssh"}
"""
ITEMS = [
    {"id": "aaaa-1", "name": "nas-01 ssh", "type": 1, "revisionDate": "2026-10-01T10:00:00.000Z", "notes": "note-SECRET",
     "login": {"username": "admin", "password": "pw-nas-SECRET", "totp": "totp-SEED", "uris": [{"uri": "10.0.0.50"}]}},
    {"id": "bbbb-2", "name": "web-02 web", "type": 1, "revisionDate": "2026-10-02T10:00:00.000Z",
     "login": {"password": "pw-web-SECRET"}},
    {"id": "dddd-4", "name": "esx-02 ssh", "type": 1, "revisionDate": "2026-10-03T10:00:00.000Z",
     "login": {"username": "root", "password": "pw-esx-SECRET"}},
]
SECRETS = ["pw-nas-SECRET", "note-SECRET", "totp-SEED", "pw-web-SECRET", "pw-esx-SECRET", "pw-new-SECRET"]


@pytest.fixture
def bw(fakes, monkeypatch, tmp_path, write_config):
    write_config(VAULT_YML)
    f = tmp_path / "items.json"
    f.write_text(json.dumps(ITEMS))
    monkeypatch.setenv("FAKE_BW_ITEMS", str(f))
    monkeypatch.setenv("FAKE_BW_SYNC_FILE", str(tmp_path / "synced"))
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    monkeypatch.setenv("BW_SESSION", "fake-session-key")
    return f


def snapshot_files():
    from roster.common import user_config_dir
    return sorted((user_config_dir() / "vault-sync").glob("*"))


def test_the_first_vault_sync_syncs_and_counts_the_items(capsys, bw, tmp_path):
    rc, out, err = run(capsys, "vault", "sync")
    assert rc == 0
    assert ["sync", "--nointeraction"] in [json.loads(x) for x in (tmp_path / "argv.log").read_text().splitlines()]
    assert "bw" in out and "3 items" in out and "first sync" in out
    (f,) = snapshot_files()
    assert WINDOWS or f.stat().st_mode & 0o777 == 0o600          # Windows: the folder's ACL, as every private file
    snap = json.loads(f.read_text())
    assert snap["items"] == {"aaaa-1": "2026-10-01T10:00:00.000Z", "bbbb-2": "2026-10-02T10:00:00.000Z",
                             "dddd-4": "2026-10-03T10:00:00.000Z"}       # ids and revision dates, no name
    assert not any(s in out + err + f.read_text() for s in SECRETS)


def test_vault_sync_names_what_was_added_and_changed_and_counts_what_went(capsys, bw):
    assert run(capsys, "vault", "sync")[0] == 0
    items = [ITEMS[0] | {"revisionDate": "2026-11-04T08:00:00.000Z"}, ITEMS[2],
             {"id": "ffff-6", "name": "nas-02 ssh", "type": 1, "revisionDate": "2026-11-04T08:30:00.000Z",
              "login": {"password": "pw-new-SECRET"}}]
    bw.write_text(json.dumps(items))
    rc, out, err = run(capsys, "vault", "sync")
    assert rc == 0
    assert "1 added: nas-02 ssh" in out
    assert "1 changed: nas-01 ssh" in out
    assert "1 removed" in out and "web-02 web" not in out          # removed: a count (the snapshot has no names)
    assert not any(s in out + err for s in SECRETS)
    rc, out, _ = run(capsys, "vault", "sync")
    assert rc == 0 and "no change" in out


def test_vault_sync_says_a_provider_with_no_local_copy_needs_none(capsys, fakes, write_config, monkeypatch):
    write_config(VAULT_YML.replace("bw:esx-02 ssh", "op:Infra/esx-02"))
    monkeypatch.setenv("OP_SESSION_test", "tok")
    rc, out, _ = run(capsys, "vault", "sync")
    assert rc == 0 and "op" in out and "nothing to sync" in out


def test_a_failed_sync_says_so_and_exits_1(capsys, bw, monkeypatch):
    monkeypatch.setenv("FAKE_BW_SYNC_FAIL", "Sync failed: server unreachable")
    rc, out, _ = run(capsys, "vault", "sync")
    assert rc == 1 and "server unreachable" in out
    assert snapshot_files() == []


def test_vault_status_says_when_each_vault_last_synced(capsys, bw):
    rc, out, _ = run(capsys, "vault", "status")
    assert "bw: never synced by roster; run `roster vault sync`" in out
    run(capsys, "vault", "sync")
    rc, out, _ = run(capsys, "vault", "status")
    assert "bw: last synced just now" in out
    assert "logged in" in out                       # the vault's state, as check --box's Vault section says it


def test_vault_status_json_has_the_vault_state_and_last_sync(capsys, bw):
    run(capsys, "vault", "sync")
    rc, out, _ = run(capsys, "vault", "status", "--json")
    doc = json.loads(out)
    assert rc == 0 and {p["name"] for p in doc["providers"]} >= {"bw", "op", "env"}
    assert [c["section"] for c in doc["vault"]] == ["vault"] * len(doc["vault"]) and doc["vault"]
    assert doc["last_sync"]["bw"]


def test_an_old_name_with_json_keeps_stderr_json(capsys, config):
    assert main(["info", "nope", "--json"]) == 1
    err = capsys.readouterr().err
    assert json.loads(err)["error"]["code"] == 2          # one JSON document, no warning line before it


def test_bw_under_its_old_name_runs_bw_and_says_the_new_form(capfd, fakes, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    assert main(["bw", "--write", "lock"]) == 0
    err = capfd.readouterr().err
    assert err.count("warning: `roster bw` is now `roster vault bw -- ARGS`") == 1
    assert json.loads((tmp_path / "argv.log").read_text().splitlines()[-1]) == ["lock", "--nointeraction"]


def test_vault_bw_takes_its_arguments_after_a_double_dash(capfd, fakes, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    assert main(["vault", "bw", "--write", "--", "lock"]) == 0
    assert main(["vault", "bw", "--", "--raw", "status"]) == 0
    calls = [json.loads(x) for x in (tmp_path / "argv.log").read_text().splitlines()]
    assert calls == [["lock", "--nointeraction"], ["--raw", "status", "--nointeraction"]]
    assert "warning" not in capfd.readouterr().err


def test_man_under_its_old_name_installs_the_page_and_says_the_new_form(capsys, tmp_path):
    rc, _, err = run(capsys, "man", "--install", "--prefix", str(tmp_path / "p"))
    assert rc == 0 and (tmp_path / "p" / "share" / "man" / "man1" / "roster.1").exists()
    assert err.count("is now `roster help --man`") == 1


def test_mesh_leftovers_with_a_flag_of_another_action_is_refused(capsys, config):
    with pytest.raises(SystemExit) as e:
        main(["mesh", "status", "--remove"])
    assert e.value.code == 2
    assert "--remove goes with leftovers" in capsys.readouterr().err


@pytest.mark.skipif(WINDOWS, reason="a POSIX mode makes the snapshot shared")
def test_a_snapshot_others_can_read_never_breaks_vault_status_json(capsys, bw):
    run(capsys, "vault", "sync")
    (f,) = snapshot_files()
    f.chmod(0o644)
    for argv in (["vault", "status", "--json"], ["providers", "--json"]):
        rc, out, err = run(capsys, *argv)
        assert json.loads(out)["last_sync"]["bw"] is None          # not used, and not said: stdout is the document
        assert "warning" not in out + err
    rc, out, _ = run(capsys, "vault", "status")
    assert "warning" not in out and "never synced by roster" in out
    rc, out, _ = run(capsys, "vault", "sync")                       # the one that says so, then replaces it
    assert rc == 0 and "ignored" in out
    assert f.stat().st_mode & 0o777 == 0o600
