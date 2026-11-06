"""resources: things with a secret but no address - fixed fields per type, shown the same everywhere."""

import pytest

from roster.claude import write_claude_files
from roster.cli import main
from roster.config import load_config
from roster.errors import InventoryError
from roster.resources import COMMON, TYPES, fields, wifi_uri

SECRET = "guest;pass:word"

HOSTS = "groups:\n  lab:\n    title: Lab\n    user: u\n    hosts:\n      box: {ip: 10.0.0.1}\n"


def cfg_with(write_config, resources):
    return load_config(write_config(HOSTS + "resources:\n" + resources))


@pytest.fixture
def lab(write_config, monkeypatch):
    monkeypatch.setenv("WIFI_PW", SECRET)
    monkeypatch.setenv("API_KEY", "key-123")
    write_config(HOSTS + """\
resources:
  guest-wifi:
    type: wifi
    ssid: Lab-Guest
    auth: env:WIFI_PW
    group: lab
    title: Guest Wi-Fi
  vendor-portal:
    type: account
    url: https://portal.example.com
    user: ops@example.com
    auth: env:API_KEY
  open-wifi:
    type: wifi
    ssid: Lobby
    security: open
""")


def test_every_resource_has_every_field_of_its_type(write_config):
    cfg = cfg_with(write_config, "  w: {type: wifi, ssid: S, auth: env:X}\n  k: {type: secret, auth: env:Y}\n")
    for r in cfg["resources"].values():
        keys = ["name", "type"] + [k for k, *_ in COMMON + TYPES[r["type"]]["fields"]]
        assert list(r) == keys
    assert cfg["resources"]["w"]["security"] == "wpa2" and cfg["resources"]["w"]["hidden"] is False


def test_fields_are_in_schema_order(write_config):
    r = cfg_with(write_config, "  w: {type: wifi, ssid: S, auth: env:X, hidden: true}\n")["resources"]["w"]
    assert [label for label, _ in fields(r)] == ["name", "type", "title", "description", "group", "user", "auth",
                                                 "SSID", "security", "hidden"]
    assert dict(fields(r))["hidden"] == "yes"


@pytest.mark.parametrize("entry, err", [
    ("{type: wifi, ssid: S, auth: env:X, password: hunter2}", r"unknown field password \(a wifi has:"),
    ("{type: wifi, auth: env:X}", "a wifi needs ssid"),
    ("{type: wifi, ssid: S, auth: env:X, security: wpa9}", "'wpa9' - use one of"),
    ("{type: wifi, ssid: S, auth: env:X, hidden: maybe}", "hidden: use true or false"),
    ("{type: wifi, ssid: S}", "needs auth"),
    ("{type: account, auth: env:X}", "an? account needs url"),
    ("{type: account, url: ftp://x, auth: env:X}", "expected http"),
    ("{type: printer, auth: env:X}", "type 'printer' - use one of wifi, account, secret"),
    ("{type: secret, auth: env:X, group: nope}", "group 'nope' isn't in roster.yml"),
    ("{type: secret, auth: env:X, ssid: S}", r"unknown field ssid \(a secret has:"),
])
def test_bad_resources_are_refused(write_config, entry, err):
    with pytest.raises(InventoryError, match=err):
        cfg_with(write_config, f"  r: {entry}\n")


def test_resource_name_cant_shadow_a_host(write_config):
    with pytest.raises(InventoryError, match="a host already has that name"):
        cfg_with(write_config, "  box: {type: secret, auth: env:X}\n")


def test_open_wifi_needs_no_auth(write_config):
    assert cfg_with(write_config, "  w: {type: wifi, ssid: S, security: open}\n")["resources"]["w"]["auth"] == ""


def test_map_without_resources_still_loads(write_config):
    assert load_config(write_config(HOSTS))["resources"] == {}


def test_list_shows_references_never_values(capsys, lab):
    assert main(["resources"]) == 0
    out = capsys.readouterr().out
    assert out.splitlines()[0].split() == ["NAME", "TYPE", "GROUP", "DETAILS", "LOGIN", "TITLE"]
    assert "SSID Lab-Guest, security wpa2" in out and "auth env:WIFI_PW" in out
    assert "ops@example.com, auth env:API_KEY" in out and "no secret" in out
    assert SECRET not in out and "key-123" not in out


def test_list_filters(capsys, lab):
    main(["resources", "--only", "account"])
    assert "vendor-portal" in (out := capsys.readouterr().out) and "guest-wifi" not in out
    main(["resources", "--find", "lab guest"])
    assert "guest-wifi" in (out := capsys.readouterr().out) and "vendor-portal" not in out
    assert main(["resources", "--find", "nothing-like-this"]) == 1


def test_info_shows_every_field(capsys, lab):
    assert main(["hosts", "guest-wifi"]) == 0
    out = capsys.readouterr().out
    for label in ("name", "type", "title", "description", "group", "user", "auth", "SSID", "security", "hidden"):
        assert any(line.startswith(f"{label} ") for line in out.splitlines()), label
    assert "lab (Lab)" in out and "roster vault reveal guest-wifi" in out and SECRET not in out


def test_info_finds_resources_by_words_and_hosts_still_work(capsys, lab):
    assert main(["hosts", "portal"]) == 0 and "vendor-portal" in capsys.readouterr().out
    assert main(["hosts", "box"]) == 0 and "10.0.0.1" in capsys.readouterr().out


def test_reveal(capsys, lab):
    assert main(["vault", "reveal", "guest-wifi"]) == 0
    assert capsys.readouterr().out == SECRET + "\n"
    main(["vault", "reveal", "guest-wifi", "--wifi"])
    assert capsys.readouterr().out == "WIFI:T:WPA;S:Lab-Guest;P:guest\\;pass\\:word;;\n"
    with pytest.raises(SystemExit, match="is a account, not wifi"):
        main(["vault", "reveal", "vendor-portal", "--wifi"])
    with pytest.raises(SystemExit, match="unknown resource 'box'"):
        main(["vault", "reveal", "box"])


def test_wifi_uri_open_and_hidden(write_config):
    r = cfg_with(write_config, "  w: {type: wifi, ssid: 'A;B', security: open, hidden: true}\n")["resources"]["w"]
    assert wifi_uri(r, "") == "WIFI:T:nopass;S:A\\;B;H:true;;"


def test_auth_check_covers_resources(capsys, lab):
    assert main(["auth-check", "--only", "wifi"]) == 0
    out = capsys.readouterr().out
    assert "env:WIFI_PW" in out and "wifi (guest-wifi)" in out and SECRET not in out


def test_roster_md_lists_resources_without_values(isolated, lab):
    write_claude_files(load_config(isolated["work"] / "roster.yml"))
    md = (isolated["work"] / "ROSTER.md").read_text()
    assert "## Resources" in md and "| guest-wifi | wifi | lab | SSID Lab-Guest, security wpa2 |" in md
    assert "Never run `roster vault reveal` (or its old name, `roster reveal`) yourself" in md
    assert SECRET not in md and "key-123" not in md
