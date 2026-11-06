"""Default login per host, with per-service and ssh: overrides."""

import pytest

from roster.claude import write_claude_files
from roster.cli import main
from roster.config import load_config, service_credentials
from roster.errors import InventoryError
from roster.example import EXAMPLE_CONFIG
from roster.sshops import write_ssh_config

ORION3 = """\
defaults: {user: admin, auth: prompt}
groups:
  plant:
    user: plantuser
    auth: env:PLANT_PW
    services:
      modbus: {port: 502, user: mbuser, auth: env:MB_PW}   # every host in the group
    hosts:
      orion3:
        ip: 10.19.1.211
        user: webadmin
        auth: env:ORION3_PW
        ssh: {port: 2222, user: sshuser, auth: env:ORION3_SSH_PW}
        services:
          https: {port: 443, user: guiadmin, auth: env:ORION3_WEB_PW}
          postgres: 5432
      plain:
        ip: 10.19.1.212
        services: {modbus: {auth: env:PLAIN_MB_PW}}
"""


def test_example_config_ssh_login_unchanged(write_config):
    hosts = load_config(write_config(EXAMPLE_CONFIG))["hosts"]
    db = hosts["orion-db-01"]
    assert (db["user"], db["port"], db["auth"]) == ("dbadmin", 2222, "bw:Orion servers#dbadmin")
    assert db["ssh"] == {"port": 2222, "user": "dbadmin", "auth": "bw:Orion servers#dbadmin"}
    dev = hosts["orion-dev-01"]
    assert dev["ssh"] == {"port": 22, "user": "deploy", "auth": "bw:Orion servers"}
    assert dev["web"] == "https://10.0.1.15:8443"
    assert hosts["net-sw-core-01"]["ssh"]["auth"] == "op:Network gear"


def test_builtin_auth_default_still_applies_to_ssh(write_config):
    h = load_config(write_config("groups:\n  a: {user: u, hosts: {h1: 10.0.0.1}}\n"))["hosts"]["h1"]
    assert h["ssh"] == {"port": 22, "user": "u", "auth": "prompt"}


def test_ssh_block_overrides_only_ssh(write_config):
    h = load_config(write_config(ORION3))["hosts"]["orion3"]
    assert h["ssh"] == {"port": 2222, "user": "sshuser", "auth": "env:ORION3_SSH_PW"}
    assert (h["user"], h["port"], h["auth"]) == ("sshuser", 2222, "env:ORION3_SSH_PW")
    assert service_credentials(h, "postgres") == ("webadmin", "env:ORION3_PW")   # host default, not ssh:
    assert service_credentials(h, "ssh") == ("sshuser", "env:ORION3_SSH_PW")


def test_service_override_beats_host_default_beats_group(write_config):
    hosts = load_config(write_config(ORION3))["hosts"]
    o3, plain = hosts["orion3"], hosts["plain"]
    https = o3["services"]["https"]
    assert (https["user"], https["auth"], https["override"]) == ("guiadmin", "env:ORION3_WEB_PW", True)
    assert https["url"] == "https://10.19.1.211" and o3["web"] is None   # derived url isn't the web UI
    assert service_credentials(o3, "modbus") == ("mbuser", "env:MB_PW")    # group service entry
    # host merges into the group's entry field by field: own auth, group's user and port
    assert plain["services"]["modbus"]["port"] == 502
    assert service_credentials(plain, "modbus") == ("mbuser", "env:PLAIN_MB_PW")
    assert service_credentials(plain, "ssh") == ("plantuser", "env:PLANT_PW")   # group plain keys
    with pytest.raises(SystemExit, match="no service 'nope'"):
        service_credentials(o3, "nope")


def test_short_form_inherits_host_default(write_config):
    pg = load_config(write_config(ORION3))["hosts"]["orion3"]["services"]["postgres"]
    assert pg == {"port": 5432, "url": None, "scheme": None, "user": "webadmin", "auth": "env:ORION3_PW",
                  "verify": True, "login": "basic", "override": False}


def test_web_string_becomes_web_service(write_config):
    h = load_config(write_config(
        "groups:\n  a:\n    user: u\n    auth: env:A\n    hosts:\n"
        "      h1: {ip: 10.0.0.1, web: 'https://x.example:8443/ui'}\n"))["hosts"]["h1"]
    web = h["services"]["web"]
    assert (web["port"], web["url"], web["user"], web["auth"], web["override"]) == \
        (8443, "https://x.example:8443/ui", "u", "env:A", False)
    assert h["web"] == "https://x.example:8443/ui"


def test_long_form_url_service_is_the_web_ui(write_config):
    h = load_config(write_config(
        "groups:\n  a:\n    user: u\n    hosts:\n"
        "      h1: {ip: 10.0.0.1, services: {gui: {url: 'http://10.0.0.1:8080', verify: false}}}\n"))["hosts"]["h1"]
    assert h["web"] == "http://10.0.0.1:8080"
    assert h["services"]["gui"]["port"] == 8080 and h["services"]["gui"]["verify"] is False


@pytest.mark.parametrize("hostyml, service, err", [
    ("{ip: 10.0.0.1, services: {pg: 70000}}", "pg", "bad port 70000"),
    ("{ip: 10.0.0.1, services: {pg: true}}", "pg", "bad port True"),
    ("{ip: 10.0.0.1, services: {'bad name': 1}}", "bad name", "bad service name 'bad name'"),
    ("{ip: 10.0.0.1, services: {gui: {url: 'ftp://x'}}}", "gui", "bad url 'ftp://x'"),
    ("{ip: 10.0.0.1, services: {gui: {url: 'https://x:99999'}}}", "gui", "bad url"),
    ("{ip: 10.0.0.1, services: {gui: {url: 'https://x', port: 80}}}", "gui", "doesn't match url"),
    ("{ip: 10.0.0.1, services: {gui: {user: x}}}", "gui", "needs a port or a url"),
    ("{ip: 10.0.0.1, services: {gui: {port: 1, pasword: x}}}", "gui", "unknown setting pasword"),
])
def test_a_bad_service_is_left_out_with_its_problem_and_the_host_stays(write_config, hostyml, service, err):
    hosts = load_config(write_config(f"groups:\n  a:\n    user: u\n    hosts:\n      h1: {hostyml}\n"
                                     "      h2: {ip: 10.0.0.2, services: {pg: 5432}}\n"))["hosts"]
    h1 = hosts["h1"]
    assert service not in h1["services"]
    [p] = h1["problems"]
    assert p["service"] == service and err in p["message"] and p["fix"]
    assert hosts["h2"]["problems"] == [] and hosts["h2"]["services"]["pg"]["port"] == 5432


def test_only_the_bad_service_is_left_out(write_config):
    h = load_config(write_config("groups:\n  a:\n    user: u\n    hosts:\n"
                                 "      h1: {ip: 10.0.0.1, services: {pg: 5432, gui: {url: 'ftp://x'}}}\n"))["hosts"]["h1"]
    assert list(h["services"]) == ["pg"] and [p["service"] for p in h["problems"]] == ["gui"]


@pytest.mark.parametrize("hostyml, err", [
    ("{ip: 10.0.0.1, ssh: {port: 0}}", "bad port 0"),
    ("{ip: 10.0.0.1, ssh: {passwd: x}}", "ssh: must be a mapping"),
    ("{ip: 10.0.0.1, services: [pg]}", "services: must be a mapping"),
    ("{ip: 10.0.0.1, port: abc}", "bad port 'abc'"),
])
def test_host_level_errors_still_fail_the_load(write_config, hostyml, err):
    with pytest.raises(InventoryError, match=err):
        load_config(write_config(f"groups:\n  a:\n    user: u\n    hosts:\n      h1: {hostyml}\n"))


def test_ssh_block_in_defaults_and_group(write_config):
    hosts = load_config(write_config(
        "defaults: {user: admin, ssh: {port: 2200}}\n"
        "groups:\n  a:\n    ssh: {user: root}\n    hosts:\n      h1: 10.0.0.1\n      h2: {ip: 10.0.0.2, port: 22}\n"
    ))["hosts"]
    assert hosts["h1"]["ssh"]["port"] == 2200 and hosts["h1"]["ssh"]["user"] == "root"
    assert hosts["h2"]["ssh"]["port"] == 22                  # legacy host port beats group/defaults ssh:
    assert hosts["h1"]["login"]["user"] == "admin"           # ssh: blocks don't change the default login


def test_write_ssh_config_uses_ssh_block(isolated, write_config):
    write_ssh_config(load_config(write_config(ORION3)))
    gen = (isolated["home"] / ".ssh" / "config.d" / "roster").read_text()
    block = gen.split("Host orion3")[1].split("Host ")[0]
    assert "User sshuser" in block and "Port 2222" in block


def run(capsys, *argv):
    rc = main(list(argv))
    return rc, capsys.readouterr().out


def test_auth_check_lists_service_refs_without_values(capsys, write_config, monkeypatch):
    for var in ("PLANT_PW", "MB_PW", "ORION3_PW", "ORION3_SSH_PW", "ORION3_WEB_PW", "PLAIN_MB_PW"):
        monkeypatch.setenv(var, f"TOPSECRET-{var}")
    write_config(ORION3)
    rc, out = run(capsys, "check", "--auth")
    assert rc == 0
    assert "env:ORION3_WEB_PW" in out and "for: https (orion3)" in out
    assert "env:ORION3_SSH_PW" in out and "for: ssh (orion3)" in out
    assert "for: modbus (orion3)" in out and "env:PLAIN_MB_PW" in out
    assert "TOPSECRET" not in out


def test_info_shows_credential_sources(capsys, write_config, monkeypatch):
    monkeypatch.setenv("ORION3_WEB_PW", "TOPSECRET")
    write_config(ORION3)
    rc, out = run(capsys, "hosts", "orion3")
    assert rc == 0 and "TOPSECRET" not in out
    assert "ssh login    sshuser, auth env:ORION3_SSH_PW" in out
    lines = out.splitlines()
    assert lines[[ln.startswith("services") for ln in lines].index(True)].split()[1] == "modbus"
    assert any("https" in ln and "guiadmin, auth env:ORION3_WEB_PW (own login)" in ln for ln in lines)
    assert any("postgres" in ln and "webadmin, auth env:ORION3_PW (host default)" in ln for ln in lines)


def test_roster_md_marks_logins_never_values(isolated, write_config, monkeypatch):
    monkeypatch.setenv("ORION3_WEB_PW", "TOPSECRET")
    write_claude_files(load_config(write_config(ORION3)))
    md = (isolated["work"] / "ROSTER.md").read_text()
    assert "https:443 (login)" in md and "postgres:5432 (login)" in md
    assert "TOPSECRET" not in md and "ORION3_WEB_PW" not in md
