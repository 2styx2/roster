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
    assert "roster setup --only nas" in out and "roster check nas" in out


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
    assert "setup        roster setup --only nas" in out and "check        roster check nas" in out
    assert out.index("roster setup --only nas") < out.index("roster check nas")
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
    return log


def bw_calls(log):
    return [json.loads(line) for line in log.read_text().splitlines()]


def test_from_vault_fills_address_port_and_user_without_reading_the_password(capsys, yml, bw_items):
    rc, out, err = run(capsys, "nas", "--auth", "bw:nas ssh", "--from-vault", "--yes")
    assert rc == 0
    assert "      nas: {ip: 10.0.0.60, user: admin, port: 2200, auth: bw:nas ssh}\n" in yml.read_text()
    assert "pw-nas-secret" not in out + err + yml.read_text()
    gets = [c[:2] for c in bw_calls(bw_items) if c[:1] == ["get"]]
    assert gets == [["get", "uri"], ["get", "username"]]            # never `get item` or `get password`
    assert not any(c[:2] == ["list", "items"] for c in bw_calls(bw_items))


def test_from_vault_flags_given_win(capsys, yml, bw_items):
    assert run(capsys, "nas", "--auth", "bw:nas ssh", "--from-vault", "--user", "ops2", "--ip", "10.0.0.61",
               "--yes")[0] == 0
    assert "      nas: {ip: 10.0.0.61, user: ops2, port: 2200, auth: bw:nas ssh}\n" in yml.read_text()


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
    assert not any(c[:2] in (["get", "item"], ["get", "password"], ["list", "items"]) for c in bw_calls(bw_items))
