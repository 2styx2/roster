"""`roster add` (T220, #427, decision Q190): one Host into roster.yml from the command line, through the app's add-Host
writer (edit.added, saved the store.py way): only the new Host's lines, comments and layout kept. Fakes and temp HOMEs
only: a plain file, a git repo, and the stand-in bw for --from-vault."""

import json
import subprocess

import pytest

from roster.cli import main

YML = """\
# the lab, by hand
defaults:
  user: ops   # everyone logs in as ops

groups:
  lab:
    auth: env:LAB_PW
    hosts:
      esx-02: {ip: 10.0.0.5}   # the old one
  office:
    hosts:
      printer: {ip: 10.0.0.9, enroll: false}
"""


def run(capsys, *argv):
    rc = main(["add", *argv])
    out = capsys.readouterr()
    return rc, out.out, out.err


def fails(capsys, *argv):
    with pytest.raises(SystemExit) as e:
        main(["add", *argv])
    return str(e.value.code)


@pytest.fixture
def yml(write_config):
    return write_config(YML)


def test_a_host_goes_in_under_its_group_and_every_other_byte_stays(capsys, yml):
    rc, out, _ = run(capsys, "nas", "--ip", "10.0.0.50", "--group", "lab", "--auth", "env:NAS_PW", "--yes")
    assert rc == 0
    assert yml.read_text() == YML.replace(
        "      esx-02: {ip: 10.0.0.5}   # the old one\n",
        "      esx-02: {ip: 10.0.0.5}   # the old one\n      nas: {ip: 10.0.0.50, auth: env:NAS_PW}\n")
    assert "nas into group 'lab'" in out and str(yml) in out
    assert (yml.parent / "roster.yml.bak").read_text() == YML


def test_a_new_group_is_made_and_said(capsys, yml):
    rc, out, _ = run(capsys, "web-01", "--ip", "10.0.0.20", "--group", "web", "--no-enroll", "--os", "windows",
                     "--title", "The web box", "--type", "iis", "--port", "2222", "--yes")
    assert rc == 0 and "group 'web' (a new group)" in out and "new group    'web'" in out
    assert yml.read_text() == YML + ("  web:\n    hosts:\n      web-01:\n        ip: 10.0.0.20\n        port: 2222\n"
                                     "        enroll: false\n        title: The web box\n        type: iis\n"
                                     "        os: windows\n")


def test_without_group_it_goes_in_the_first_group(capsys, yml):
    assert run(capsys, "nas", "--ip", "10.0.0.50", "--yes")[0] == 0
    assert "      nas: {ip: 10.0.0.50}\n  office:" in yml.read_text()


def test_a_name_already_in_the_file_is_refused_naming_its_group(capsys, yml):
    message = fails(capsys, "printer", "--ip", "10.0.0.77", "--yes")
    assert "[81]" in message and "printer" in message and "group office" in message
    assert yml.read_text() == YML


def test_an_address_already_in_the_file_is_refused_naming_that_host(capsys, yml):
    message = fails(capsys, "nas", "--ip", "10.0.0.9", "--yes")
    assert "[184]" in message and "10.0.0.9 is already printer's address (group office)" in message
    assert yml.read_text() == YML
    assert run(capsys, "nas", "--ip", "10.0.0.9", "--port", "2222", "--yes")[0] == 0     # another port: another sshd


@pytest.mark.parametrize("name, ip, what", [("bad name", "10.0.0.50", "bad host name"),
                                            ("nas", "https://10.0.0.50/", "bad address"),
                                            ("nas", "10.0.0.500", "bad address")])
def test_a_bad_name_or_address_is_refused(capsys, yml, name, ip, what):
    message = fails(capsys, name, "--ip", ip, "--yes")
    assert "[80]" in message and what in message
    assert yml.read_text() == YML


def test_without_a_terminal_a_missing_address_names_its_flag(capsys, yml):
    message = fails(capsys, "nas", "--group", "lab")
    assert "[185]" in message and "--ip" in message
    assert yml.read_text() == YML


def test_without_a_user_anywhere_it_names_user(capsys, write_config):
    p = write_config("groups:\n  lab:\n    auth: prompt\n    hosts:\n      a: {ip: 10.0.0.5, user: x}\n")
    message = fails(capsys, "nas", "--ip", "10.0.0.50", "--yes")
    assert "[185]" in message and "--user" in message
    assert "nas" not in p.read_text()


def test_in_a_terminal_it_asks_for_the_address_group_and_enroll(capsys, yml, monkeypatch):
    import sys
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)
    answers = iter(["office", "10.0.0.51", "n"])
    asked = []
    monkeypatch.setattr("builtins.input", lambda text: asked.append(text) or next(answers))
    assert run(capsys, "nas")[0] == 0
    assert asked == ["Group [lab]: ", "Address (IP or DNS name): ", "Install this Box's key on nas (enroll)? [Y/n] "]
    assert "      nas: {ip: 10.0.0.51, enroll: false}\n" in yml.read_text()


def test_dry_run_prints_the_lines_and_writes_nothing(capsys, yml):
    rc, out, _ = run(capsys, "nas", "--ip", "10.0.0.50", "--group", "lab", "--dry-run")
    assert rc == 0 and "nothing written" in out and "      nas: {ip: 10.0.0.50}" in out
    assert yml.read_text() == YML and not (yml.parent / "roster.yml.bak").exists()


def test_without_setup_it_prints_the_next_two_commands(capsys, yml):
    out = run(capsys, "nas", "--ip", "10.0.0.50", "--yes")[1]
    assert "roster setup --host nas" in out and "roster check nas" in out


def test_the_write_is_said_before_this_box_syncs(capsys, yml, isolated):
    out = run(capsys, "nas", "--ip", "10.0.0.50", "--yes")[1]
    assert out.index("wrote        nas") < out.index("ssh config") < out.index("next ")
    assert "nas" in (isolated["home"] / ".ssh/config.d/roster").read_text()       # synced: `ssh nas` works now


def test_setup_runs_setup_then_check_for_the_new_host(capsys, yml, monkeypatch, fakes):
    import roster.cli as cli
    monkeypatch.setattr(cli, "record_fingerprints", lambda cfg, hosts: set())     # no network: no host key scan
    monkeypatch.setenv("NAS_PW", "x")
    rc, out, _ = run(capsys, "nas", "--ip", "127.0.0.1", "--port", "1", "--group", "lab", "--auth", "env:NAS_PW",
                     "--no-enroll", "--setup", "--yes")                # port 1 here: nothing answers, nothing leaves
    assert "setup        roster setup --host nas" in out and "check        roster check nas" in out
    assert out.index("roster setup --host nas") < out.index("roster check nas")
    assert "1 password-only hosts" in out and "setup        ok" in out
    assert rc == 1 and "check        FAILED (see above)" in out       # its check found nothing listening


def test_name_is_needed_unless_from_vault(capsys, yml):
    with pytest.raises(SystemExit) as e:
        main(["add", "--ip", "10.0.0.50"])
    assert e.value.code == 2 and "needs NAME" in capsys.readouterr().err
    assert yml.read_text() == YML


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                          capture_output=True, text=True, check=True).stdout


def test_in_a_team_repo_it_is_a_pending_change(capsys, yml, tmp_path):
    git(yml.parent, "init", "-q", "-b", "main")
    git(yml.parent, "add", "roster.yml")
    git(yml.parent, "commit", "-qm", "inventory")
    subprocess.run(["git", "init", "-q", "--bare", str(tmp_path / "origin.git")], check=True)
    git(yml.parent, "remote", "add", "origin", str(tmp_path / "origin.git"))
    rc, out, _ = run(capsys, "nas", "--ip", "10.0.0.50", "--yes")
    assert rc == 0 and "Pending changes until you Publish them" in out
    assert git(yml.parent, "status", "--porcelain", "roster.yml") == " M roster.yml\n"         # uncommitted
    assert not (yml.parent / "roster.yml.bak").exists() and (yml.parent / ".git/roster/roster.yml.bak").exists()
    assert "nas: {ip: 10.0.0.50}" in yml.read_text()


# ---------------------------------------------------------------- --from-vault: the item's URI and username

@pytest.fixture
def bw_items(fakes, monkeypatch, tmp_path):
    items = tmp_path / "items.json"
    items.write_text(json.dumps([
        {"id": "aaaa-1", "name": "nas ssh", "login": {"username": "admin", "password": "pw-nas-secret",
                                                       "uris": [{"uri": "ssh://10.0.0.60:2200"}]}},
        {"id": "bbbb-2", "name": "bare", "login": {"username": "root", "password": "pw-bare-secret"}},
    ]))
    log = tmp_path / "argv.log"
    monkeypatch.setenv("FAKE_BW_ITEMS", str(items))
    monkeypatch.setenv("FAKE_ARGV_LOG", str(log))
    monkeypatch.setenv("BW_SESSION", "fake-session-key")
    monkeypatch.setenv("FAKE_BW_STDOUT_LOG", str(tmp_path / "stdout.log"))
    return log


def bw_calls(log):
    return [json.loads(line) for line in log.read_text().splitlines()]


def stdout_of(log, what):
    """Where each `bw get WHAT` call's stdout went, as the fake saw it ("devnull" or "pipe")."""
    f = log.with_name("stdout.log")
    return [ln.split()[1] for ln in f.read_text().splitlines() if ln.split()[0] == what] if f.exists() else []


def items(bw_items, *rows):
    bw_items.with_name("items.json").write_text(json.dumps(list(rows)))


def test_from_vault_fills_address_port_and_user_without_reading_the_password(capsys, yml, bw_items):
    rc, out, err = run(capsys, "nas", "--auth", "bw:nas ssh", "--from-vault", "--yes")
    assert rc == 0
    assert "      nas: {ip: 10.0.0.60, user: admin, port: 2200, auth: bw:nas ssh}\n" in yml.read_text()
    assert "pw-nas-secret" not in out + err + yml.read_text()
    gets = [c[:2] for c in bw_calls(bw_items) if c[:1] == ["get"]]
    assert gets == [["get", "item"], ["get", "uri"], ["get", "username"]]       # never `get password`
    assert stdout_of(bw_items, "item") == ["devnull"]               # `get item` checks the name: its output unread
    assert not any(c[:2] == ["list", "items"] for c in bw_calls(bw_items))


def test_from_vault_flags_given_win(capsys, yml, bw_items):
    assert run(capsys, "nas", "--auth", "bw:nas ssh", "--from-vault", "--user", "ops2", "--ip", "10.0.0.61",
               "--yes")[0] == 0
    # the port goes with the address it came with: --ip given, so not the vault's 2200
    assert "      nas: {ip: 10.0.0.61, user: ops2, auth: bw:nas ssh}\n" in yml.read_text()


def test_from_vault_an_item_without_a_uri_still_needs_the_address(capsys, yml, bw_items):
    message = fails(capsys, "nas", "--auth", "bw:bare", "--from-vault", "--yes")
    assert "[185]" in message and "--ip" in message


def test_from_vault_with_a_provider_that_cant_say_without_the_password_is_refused(capsys, yml):
    message = fails(capsys, "nas", "--auth", "env:NAS_PW", "--from-vault", "--yes")
    assert "[186]" in message and "--ip and --user" in message
    assert yml.read_text() == YML


def test_group_completes_group_names(capsys, yml, monkeypatch):
    monkeypatch.setenv("ROSTER_CONFIG", str(yml))
    assert main(["__complete", "bash", ":", "roster", "add", "nas", "--group"]) == 0
    assert capsys.readouterr().out.splitlines() == ["lab", "office"]


# ---------------------------------------------------------------- the same code under serve (the app's add-Host form)

def test_host_add_checks_the_address_as_roster_add_does(serve, yml):
    s = serve()
    err = s.call("host.add", {"name": "nas", "group": "lab", "address": "https://10.0.0.50/"})["error"]
    assert err["code"] == 80 and "bad address" in err["message"]
    assert yml.read_text() == YML
    r = s.call("host.add", {"name": "nas", "group": "office", "address": "10.0.0.9"})
    assert "result" in r, r
    assert r["result"]["added"] is True          # the form allows a second Login on one machine (Q190)


def test_vault_item_fields_gives_the_address_port_and_user_never_the_password(serve, yml, bw_items):
    s = serve()
    assert s.call("vault.item_fields", {"provider": "bw", "item": "nas ssh"})["error"]["code"] == 14   # locked
    s.call("vault.unlock", {"provider": "bw", "password": "hunter2"})
    r = s.call("vault.item_fields", {"provider": "bw", "item": "nas ssh"})["result"]
    assert r == {"provider": "bw", "item": "nas ssh", "address": "10.0.0.60", "port": 2200, "user": "admin"}
    assert s.call("vault.item_fields", {"provider": "bw", "item": "bare"})["result"] == \
        {"provider": "bw", "item": "bare", "user": "root"}
    assert s.call("vault.item_fields", {"provider": "bw", "item": "nope"})["error"]["code"] == 32
    assert s.call("vault.item_fields", {"provider": "env", "item": "NAS_PW"})["error"]["code"] == 186
    s.close()
    assert "pw-nas-secret" not in json.dumps(s.responses) and "pw-bare-secret" not in json.dumps(s.responses)
    assert not any(c[:2] in (["get", "password"], ["list", "items"]) for c in bw_calls(bw_items))
    assert set(stdout_of(bw_items, "item")) == {"devnull"}             # `get item` only to check the name, unread


# ---------------------------------------------------------------- review of #429

INV_TYPED = YML.replace("esx-02: {ip: 10.0.0.5}", "esx-02: {ip: 10.0.0.5, type: nas}")


def test_setup_sets_up_only_the_new_host_even_when_its_name_is_another_hosts_type(capsys, write_config,
                                                                                  monkeypatch, fakes):
    import roster.cli as cli
    write_config(INV_TYPED)
    scanned = []
    monkeypatch.setattr(cli, "record_fingerprints", lambda cfg, hosts: scanned.extend(h["name"] for h in hosts) or set())
    monkeypatch.setenv("NAS_PW", "x")
    run(capsys, "nas", "--ip", "127.0.0.1", "--port", "1", "--group", "lab", "--auth", "env:NAS_PW", "--no-enroll",
        "--setup", "--yes")
    assert scanned == ["nas"]                                   # never esx-02 (type nas)


def test_the_next_step_is_setup_host_even_when_only_would_select_more(capsys, write_config):
    write_config(INV_TYPED)                                      # #437 (1): --host is exact, so no note is needed
    out = run(capsys, "nas", "--ip", "10.0.0.50", "--yes")[1]
    assert "next         roster setup --host nas" in out and "roster check nas" in out
    assert "also selects" not in out


@pytest.mark.parametrize("address", ["nas_01", "my_db.lan"])
def test_an_underscore_address_is_one_quick_connect_could_open(capsys, yml, serve, address):
    assert run(capsys, "nas", "--ip", address, "--yes")[0] == 0
    s = serve()
    r = s.call("host.add", {"name": "nas2", "group": "office", "address": address.upper()})
    assert "result" in r, r                                     # the form (and quick.save) too


def test_an_ipv6_zone_is_letters_digits_and_dots_only(capsys, yml):
    assert "[80]" in fails(capsys, "nas", "--ip", "fe80::1%-oProxyCommand=x", "--yes")
    assert run(capsys, "nas", "--ip", "fe80::1%eth0", "--yes")[0] == 0


def test_the_same_address_written_another_way_is_still_taken(capsys, write_config):
    write_config(YML.replace("10.0.0.9", "fe80::1"))
    assert "[184]" in fails(capsys, "nas", "--ip", "FE80:0:0::1", "--yes")


@pytest.mark.parametrize("uri, ip, port", [("fe80::1", "fe80::1", None), ("ssh://[fe80::1%25eth0]", "fe80::1%eth0", None),
                                          ("sftp://10.0.0.70:2201", "10.0.0.70", 2201),
                                          ("https://nas.example.com:8443/", "nas.example.com", None),
                                          ("10.0.0.71:2202", "10.0.0.71", 2202)])
def test_a_uri_gives_its_address_and_only_an_ssh_port(capsys, yml, bw_items, uri, ip, port):
    items(bw_items, {"id": "c-1", "name": "nas ssh", "login": {"username": "admin", "password": "pw",
                                                                "uris": [{"uri": uri}]}})
    out = run(capsys, "nas", "--auth", "bw:nas ssh", "--from-vault", "--dry-run", "--yes")[1]
    assert f"ip: {ip}" in out or f"ip: \"{ip}\"" in out
    assert (f"port: {port}" in out) == (port is not None)


@pytest.mark.parametrize("uri", ["androidapp://com.example.files", "javascript:alert(1)", "mailto:x@example.com"])
def test_a_uri_that_isnt_a_network_address_gives_none_and_says_so(capsys, yml, bw_items, uri):
    items(bw_items, {"id": "c-1", "name": "nas ssh", "login": {"username": "admin", "password": "pw",
                                                                "uris": [{"uri": uri}]}})
    message = fails(capsys, "nas", "--auth", "bw:nas ssh", "--from-vault", "--yes")
    assert "[185]" in message and "--ip" in message
    assert "isn't a network address" in capsys.readouterr().out


def test_a_name_two_items_match_is_refused_even_when_each_field_narrows_to_one(capsys, yml, bw_items):
    items(bw_items, {"id": "d-1", "name": "nas ssh", "login": {"username": "admin", "password": "pw1"}},
          {"id": "d-2", "name": "nas web", "login": {"password": "pw2", "uris": [{"uri": "https://10.0.0.61"}]}})
    message = fails(capsys, "nas", "--auth", "bw:nas", "--from-vault", "--yes")
    assert "[33]" in message and message.count("item's id") == 1 and "list items" not in message
    assert yml.read_text() == YML


@pytest.mark.parametrize("item", ["--help", "--session=zzz", "-x"])
def test_an_item_that_looks_like_an_option_never_reaches_bw(capsys, yml, bw_items, item):
    assert "can't start with '-'" in fails(capsys, "nas", "--auth", f"bw:{item}", "--from-vault", "--yes")
    assert not any(item in c for c in bw_calls(bw_items)) if bw_items.exists() else True


def test_a_secret_lookup_of_an_item_like_an_option_never_reaches_bw(bw_items):
    from roster import providers
    providers.setup_providers(None)
    with pytest.raises(providers.SecretError, match="can't start with '-'"):
        providers.get_secret("bw:--session=zzz", "lab")
    assert not bw_items.exists() or not any("--session=zzz" in c for c in bw_calls(bw_items))


def test_another_bw_error_with_available_in_it_is_an_error_not_a_missing_field(capsys, yml, bw_items, monkeypatch):
    monkeypatch.setenv("FAKE_BW_FIELD_FAIL", "The server is not available right now.")
    assert "[35]" in fails(capsys, "nas", "--auth", "bw:nas ssh", "--from-vault", "--yes")


def test_yes_never_asks_for_the_master_password(capsys, yml, bw_items, monkeypatch):
    import getpass
    import sys
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)
    monkeypatch.delenv("BW_SESSION")
    monkeypatch.setattr(getpass, "getpass", lambda *a: pytest.fail("asked for the master password"))
    message = fails(capsys, "nas", "--auth", "bw:nas ssh", "--from-vault", "--yes")
    assert "locked" in message and "[14]" in message


def test_a_locked_vault_with_no_terminal_is_14_not_35(capsys, yml, bw_items, monkeypatch):
    monkeypatch.delenv("BW_SESSION")                        # #437 (6): it was LOOKUP_FAILED, 35
    message = fails(capsys, "nas", "--auth", "bw:nas ssh", "--from-vault")
    assert "[14]" in message and "no terminal to unlock it" in message and "[35]" not in message
    assert yml.read_text() == YML


def test_dry_run_shows_the_line_it_replaces(capsys, write_config):
    p = write_config("groups:\n  lab:\n    user: ops\n    hosts: {}\n")
    out = run(capsys, "nas", "--ip", "10.0.0.50", "--dry-run")[1]
    assert "-     hosts: {}" in out and "+     hosts:" in out and "+       nas: {ip: 10.0.0.50}" in out or \
        ("-     hosts: {}" in out and "+       nas:" in out)
    assert p.read_text() == "groups:\n  lab:\n    user: ops\n    hosts: {}\n"


def test_a_sync_that_exits_after_the_write_is_only_said(write_config):
    from roster import addhost, edit
    p = write_config(YML)

    def dies():
        raise SystemExit("error: providers didn't load")
    r = addhost.add(p, "lab", "nas", {"ip": edit.check_new("ip", "10.0.0.50")}, sync=dies)
    assert r["sync"]["ok"] is False and "nas" in p.read_text()


@pytest.mark.parametrize("item", ["nas ssh#username", "-x"])
def test_vault_item_fields_refuses_a_field_or_an_option(serve, yml, bw_items, item):
    s = serve()
    s.call("vault.unlock", {"provider": "bw", "password": "hunter2"})
    assert s.call("vault.item_fields", {"provider": "bw", "item": item})["error"]["code"] == -32602
