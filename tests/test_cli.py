import os
import re
import subprocess
from pathlib import Path

import pytest
from conftest import posix_shell

import roster.cli as cli
from roster.cli import main
from roster.context import user_config_dir
from roster.sshops import sudo_wrap


def run(capsys, *argv):
    rc = main(list(argv))
    return rc, capsys.readouterr().out


def test_version(capsys):
    with pytest.raises(SystemExit) as e:
        main(["--version"])
    assert e.value.code == 0 and "roster" in capsys.readouterr().out


def test_init_hosts_info(capsys, isolated):
    assert run(capsys, "init")[0] in (0, None)
    assert (isolated["work"] / "roster.yml").exists()
    rc, out = run(capsys, "hosts", "--find", "orion prod")
    assert rc == 0 and "orion-web-01" in out and "orion-dev-01" not in out
    rc, out = run(capsys, "hosts", "core", "switch")
    assert "net-sw-core-01" in out and "Uplinks" in out
    with pytest.raises(SystemExit, match="did you mean"):
        main(["hosts", "orion"])


HOSTS_YML = """\
groups:
  lab:
    user: ops
    auth: env:PW
    hosts:
      box: {ip: 10.0.0.5, title: Lab box, web: "https://10.0.0.5"}
      esx:
        ip: 10.0.0.6
        user: root
        enroll: false
        services:
          https: {url: "https://10.0.0.6"}
          api: {url: "https://10.0.0.6", login: vsphere}
          admin: {url: "https://10.0.0.6:943", user: webadmin, auth: env:WEB}
          rpc: 111
  found:
    reviewed: false
    user: CHANGE-ME
    hosts:
      server-10-0-0-9: {ip: 10.0.0.9, port: 2222}
resources:
  guest: {type: wifi, ssid: Guest, auth: env:WIFI, title: Guest Wi-Fi}
"""


def test_hosts_short_listing(capsys, write_config):
    write_config(HOSTS_YML)
    rc, out = run(capsys, "hosts")
    lines = {ln.split()[0]: ln for ln in out.splitlines() if ln.strip()}
    assert rc == 0 and lines["NAME"].split() == ["NAME", "IP", "USER", "LOGINS", "TITLE"]
    assert "ops" in lines["box"] and "ssh (key), web" in lines["box"] and "Lab box" in lines["box"]
    assert "ssh (password), web, api, admin (webadmin)" in lines["esx"] and "rpc" not in lines["esx"]
    assert "wifi" in lines["guest"] and "Guest Wi-Fi" in lines["guest"]
    assert "server-10-0-0-9" not in lines and "1 unreviewed hosts not shown" in out


def test_hosts_all_find_and_long(capsys, write_config):
    write_config(HOSTS_YML)
    out = run(capsys, "hosts", "--all")[1]
    row = next(ln for ln in out.splitlines() if ln.startswith("server-10-0-0-9"))
    assert "10.0.0.9:2222" in row and "unreviewed" in row and "CHANGE-ME" not in row
    assert "server-10-0-0-9" in run(capsys, "hosts", "--find", "10.0.0.9")[1]
    out = run(capsys, "hosts", "--long")[1]
    assert out.split()[:8] == ["NAME", "TITLE", "TYPE", "PRODUCT", "ADDRESS", "ACCESS", "WEB", "DESCRIPTION"]
    assert "ops@10.0.0.5:22" in out


def test_setup_skips_unreviewed_hosts(capsys, write_config):
    write_config("groups:\n  found:\n    reviewed: false\n    user: u\n    hosts:\n      h1: 10.9.9.9\n")
    rc, out = run(capsys, "setup")
    assert rc == 0 and "skipping     1 hosts with reviewed: false" in out


SAME_NAME_YML = ("groups:\n  nas:\n    user: u\n    enroll: false\n    auth: env:PW\n    hosts:\n"
                 "      nas: 127.0.0.1\n      backup-01: {ip: 127.0.0.2, type: nas}\n")


def test_setup_host_sets_up_exactly_that_host_never_its_group_or_type(capsys, write_config, monkeypatch):
    scanned = []                                                 # #437 (1): --only nas would take backup-01 too
    monkeypatch.setattr("roster.boxsetup.record_fingerprints", lambda cfg, hosts: scanned.extend(h["name"] for h in hosts) or set())
    write_config(SAME_NAME_YML)
    rc, out = run(capsys, "setup", "--host", "nas", "--dry-run")
    assert rc == 0 and scanned == ["nas"] and "1 hosts from" in out


def test_setup_host_names_an_unknown_host(capsys, write_config):
    write_config(SAME_NAME_YML)
    with pytest.raises(SystemExit, match="unknown host 'backup'"):
        main(["setup", "--host", "backup"])


def test_setup_host_and_only_dont_go_together(capsys, write_config):
    write_config(SAME_NAME_YML)
    with pytest.raises(SystemExit) as e:
        main(["setup", "--host", "nas", "--only", "nas"])
    assert e.value.code == 2 and "not allowed with argument" in capsys.readouterr().err


def test_providers_flags_unknown(capsys, write_config):
    write_config("groups:\n  g: {user: u, auth: 'keeper:x', hosts: {h1: 10.0.0.1}}\n")
    rc, out = run(capsys, "vault", "status")
    assert rc == 1 and "UNKNOWN providers used in roster.yml: keeper" in out


def test_providers_lists_keepassxc(capsys, write_config):
    write_config("providers:\n  kp: {database: roster.kdbx}\n"
                 "groups:\n  g: {user: u, auth: 'kp:g ssh', hosts: {h1: 10.0.0.1}}\n")
    rc, out = run(capsys, "vault", "status")
    assert rc == 0 and re.search(r"^  kp +built-in +KeePassXC, a local \.kdbx.*used by: g$", out, re.M)


def test_auth_check(capsys, write_config, monkeypatch):
    monkeypatch.setenv("GOOD_PW", "x")
    write_config("groups:\n"
                 "  a: {user: u, auth: 'env:GOOD_PW', hosts: {h1: 10.0.0.1}}\n"
                 "  b: {user: u, auth: 'env:MISSING_PW', hosts: {h2: 10.0.0.2}}\n")
    rc, out = run(capsys, "check", "--auth")
    assert rc == 1
    assert "ok    a" in out and "FAIL  b" in out and "MISSING_PW is not set" in out


def test_discover_rejects_huge_ranges(capsys):
    with pytest.raises(SystemExit, match="narrow it down"):
        main(["discover", "10.0.0.0/8"])


# ---- roster run --sudo

SUDO_CFG = ("groups:\n  g:\n    user: ops\n    auth: env:ROSTER_TEST_PW\n    hosts:\n"
            "      pw-host: { ip: 10.0.0.5, enroll: false }\n"
            "      key-host: { ip: 10.0.0.6 }\n"
            "      agent-host: { ip: 10.0.0.7, auth: agent }\n"
            "      new-host: { ip: 10.0.0.8, reviewed: false }\n")


@posix_shell
def test_sudo_wrap_keeps_password_away_from_the_command(tmp_path):
    fake = tmp_path / "sudo"        # stand-in sudo that, like a NOPASSWD rule, never reads stdin
    fake.write_text('#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n')
    fake.chmod(0o755)
    env = {**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}"}
    r = subprocess.run(["sh", "-c", sudo_wrap("cat; echo \"it's done\"")], input="s3cret\n",
                       capture_output=True, text=True, env=env)
    assert r.returncode == 0 and r.stdout == "it's done\n"          # cat saw /dev/null, not the password


def test_run_sudo_password_host(capsys, write_config, monkeypatch):
    write_config(SUDO_CFG)
    monkeypatch.setenv("ROSTER_TEST_PW", "s3cret")
    seen = {}

    def fake_exec(h, command, password, timeout=15, stdin=None):
        seen.update(command=command, password=password, stdin=stdin)
        return 0, "uid=0(root) s3cret\n", ""
    monkeypatch.setattr(cli, "password_exec", fake_exec)
    rc = main(["run", "--sudo", "pw-host", "--", "id"])
    out = capsys.readouterr().out
    assert rc == 0 and seen["command"].startswith("sudo -S -p '' -- sh -c ")
    assert seen["stdin"] == "s3cret\n" and seen["password"] == "s3cret"
    assert out == "uid=0(root) ********\n"                         # echoed password is masked


def test_run_sudo_key_host(capsys, write_config, monkeypatch):
    write_config(SUDO_CFG)
    monkeypatch.setenv("ROSTER_TEST_PW", "s3cret")
    seen = {}

    def fake_run(argv, input=None, **kw):
        seen.update(argv=argv, input=input)
        return subprocess.CompletedProcess(argv, 0, b"root\n", b"")
    monkeypatch.setattr(cli.subprocess, "run", fake_run)
    assert main(["run", "--sudo", "key-host", "--", "whoami"]) == 0
    assert Path(seen["argv"][0]).stem == "ssh"          # found on PATH: C:\\Windows\\...\\ssh.exe on Windows
    assert seen["argv"][1:4] == ["-o", "BatchMode=yes", "key-host"] and seen["input"] == b"s3cret\n"
    assert "sudo -S" in seen["argv"][4] and capsys.readouterr().out == "root\n"


def test_run_sudo_needs_a_password(write_config):
    write_config(SUDO_CFG)
    with pytest.raises(SystemExit, match="--sudo needs the login's password"):
        main(["run", "--sudo", "agent-host", "--", "id"])


def test_run_refuses_unreviewed_hosts(write_config):
    write_config(SUDO_CFG)
    with pytest.raises(SystemExit, match="not reviewed"):
        main(["run", "new-host", "--", "id"])


def test_run_hints_at_sudo_flag(capsys, write_config, monkeypatch):
    write_config(SUDO_CFG)
    monkeypatch.setenv("ROSTER_TEST_PW", "s3cret")
    monkeypatch.setattr(cli, "password_exec", lambda *a, **k: (1, "", "sudo: a password is required\n"))
    assert main(["run", "pw-host", "--", "sudo", "id"]) == 1
    assert "roster run --sudo pw-host -- id" in capsys.readouterr().err


def _bw_session_file(isolated, text="fake-session-key\n"):
    f = user_config_dir() / "bw-session"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text)
    f.chmod(0o600)


def test_bw_uses_the_session_file_without_a_roster_yml(capfd, isolated, fakes):
    _bw_session_file(isolated)
    assert main(["vault", "bw", "sync"]) == 0
    assert "Syncing complete." in capfd.readouterr().out


def test_bw_without_a_session_reports_the_locked_vault(capfd, isolated, fakes):
    assert main(["vault", "bw", "sync"]) == 1
    assert "Vault is locked." in capfd.readouterr().err


def test_bw_needs_arguments(isolated):
    with pytest.raises(SystemExit, match="usage: roster vault bw"):
        main(["vault", "bw"])
