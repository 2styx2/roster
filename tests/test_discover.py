import datetime
import json

import pytest
import yaml

from roster.config import load_config
from roster.discover import _defaults_user, guess_identity, parse_nmap_xml, scan_entry, write_discovered
from roster.example import EXAMPLE_CONFIG

NMAP_XML = """<?xml version="1.0"?>
<nmaprun>
  <host><status state="up"/>
    <address addr="10.0.0.2" addrtype="ipv4"/><address addr="00:1A:2B:00:00:01" addrtype="mac" vendor="Cisco Systems"/>
    <hostnames><hostname name="core-sw.lab" type="PTR"/></hostnames>
    <ports>
      <port protocol="tcp" portid="22"><state state="open"/><service name="ssh" product="Cisco SSH" version="1.25"/></port>
      <port protocol="tcp" portid="443"><state state="open"/><service name="http" tunnel="ssl" product="Cisco IOS http config"/>
        <script id="http-title" output="Switch Login"/></port>
      <port protocol="tcp" portid="23"><state state="closed"/><service name="telnet"/></port>
    </ports>
  </host>
  <host><status state="up"/><address addr="10.0.1.9" addrtype="ipv4"/>
    <ports>
      <port protocol="tcp" portid="2222"><state state="open"/><service name="ssh" product="OpenSSH" version="9.6" ostype="Linux"/></port>
      <port protocol="tcp" portid="5432"><state state="open"/><service name="postgresql"/></port>
      <port protocol="tcp" portid="80"><state state="open"/><service name="http"/>
        <script id="http-title" output="Site doesn't have a title (text/html)."/></port>
    </ports>
  </host>
  <host><status state="down"/><address addr="10.0.1.10" addrtype="ipv4"/></host>
</nmaprun>"""


def P(port, name, product="", title="", ssl=False):
    return {"port": port, "name": name, "product": product, "title": title, "ssl": ssl}


def rec(ip, ports, hostname="", vendor="", os=""):
    return {"ip": ip, "hostname": hostname, "mac": "", "vendor": vendor, "os": os, "ports": ports}


def test_parse_nmap_xml():
    found = parse_nmap_xml(NMAP_XML)
    assert [r["ip"] for r in found] == ["10.0.0.2", "10.0.1.9"]
    sw, db = found
    assert sw["vendor"] == "Cisco Systems" and sw["hostname"] == "core-sw.lab"
    assert [p["port"] for p in sw["ports"]] == [22, 443]                       # closed port dropped
    assert sw["ports"][1]["ssl"] and sw["ports"][1]["title"] == "Switch Login"
    assert db["os"] == "Linux" and db["ports"][2]["title"] == ""               # "no title" text ignored


@pytest.mark.parametrize("record, kind", [
    (rec("1", [P(22, "ssh", "Cisco SSH"), P(443, "https")], vendor="Cisco Systems"), "network"),
    (rec("2", [P(443, "https", title="iDRAC9"), P(22, "ssh")]), "bmc"),
    (rec("3", [P(3389, "ms-wbt-server", "Microsoft Terminal Services"), P(445, "microsoft-ds")]), "windows"),
    (rec("4", [P(22, "ssh", "OpenSSH"), P(5432, "postgresql")]), "db"),
    (rec("5", [P(22, "ssh", "OpenSSH")]), "server"),
    (rec("6", [P(80, "http", "lighttpd")]), "appliance"),
    (rec("7", [P(23, "telnet")]), "network"),
    (rec("8", [P(9999, "unknown")]), "unknown"),
])
def test_guess_identity(record, kind):
    assert guess_identity(record)[0] == kind


def test_scan_entry_fields_and_unique_names():
    taken = {"core-sw"}
    sw, db = parse_nmap_xml(NMAP_XML)
    name, e = scan_entry(sw, taken, "2026-10-07")
    assert name == "core-sw-2"                               # "core-sw" was taken
    assert e["type"] == "network" and e["enroll"] is False
    assert e["web"] == "https://10.0.0.2" and e["title"] == "Switch Login"
    assert e["mac"] == "00:1A:2B:00:00:01" and "hw: Cisco Systems" in e["description"]
    name, e = scan_entry(db, taken, "2026-10-07")
    assert name == "db-10-0-1-9"
    assert e["port"] == 2222 and e["enroll"] is True
    assert e["services"] == {"postgresql": 5432, "http": 80}
    assert e["web"] == "http://10.0.1.9"


def entries():
    taken = set()
    return [scan_entry(r, taken, "2026-10-07") for r in parse_nmap_xml(NMAP_XML)]


def test_write_new_file(isolated):
    path = isolated["work"] / "roster.yml"
    write_discovered(path, "discovered-20261007", entries(), "found by test", True, "2026-10-07")
    cfg = load_config(path)
    assert set(cfg["hosts"]) == {"core-sw", "db-10-0-1-9"}
    assert all(h["reviewed"] is False and h["user"] == "CHANGE-ME" for h in cfg["hosts"].values())


def test_write_into_existing_file_keeps_comments_and_backs_up(isolated):
    path = isolated["work"] / "roster.yml"
    path.write_text(EXAMPLE_CONFIG)
    write_discovered(path, "discovered-20261007", entries(), "found by test", False, "2026-10-07")
    text = path.read_text()
    assert (isolated["work"] / "roster.yml.bak").read_text() == EXAMPLE_CONFIG
    assert text.count("\n#") == EXAMPLE_CONFIG.count("\n#")                    # every comment survived
    cfg = load_config(path)
    assert len(cfg["hosts"]) == 7 and "discovered-20261007" in cfg["groups"]
    assert yaml.safe_load(text)["groups"]["orion"]["title"] == "Product Orion"


def test_new_group_gets_user_placeholder_when_only_other_groups_have_users(isolated):
    path = isolated["work"] / "roster.yml"
    path.write_text("groups:\n  lab:\n    user: ops\n    hosts:\n      box: { ip: 10.0.9.1 }\n")
    write_discovered(path, "discovered-20261012", entries(), "n", not _defaults_user(path), "2026-10-12")
    cfg = load_config(path)
    assert cfg["hosts"]["core-sw"]["user"] == "CHANGE-ME" and cfg["hosts"]["box"]["user"] == "ops"


def test_inline_groups_are_refused(isolated):
    path = isolated["work"] / "roster.yml"
    path.write_text("groups: {}\n")
    with pytest.raises(SystemExit, match="inline"):
        write_discovered(path, "g", entries(), "n", True, "2026-10-07")


def test_the_cli_scans_each_family_once_per_address_and_counts_quiet_hosts(fakes, isolated, monkeypatch, capsys):
    """`roster discover` with the stand-in nmap (review 8 #2, #5, #6): IPv6 with -6, an address in two targets
    written once, and a Host with none of the ports open counted."""
    from roster.cli import main
    root = isolated["home"].parent / "hosts"
    for name, address, ports in (("db", "10.0.0.9", "22 ssh OpenSSH 9.6"), ("v6", "fd00::7", "22 ssh OpenSSH 9.6"),
                                 ("printer", "10.0.0.11", "9100 jetdirect")):
        (root / name).mkdir(parents=True)
        (root / name / "address").write_text(address)
        (root / name / "ports").write_text(ports + "\n")
    monkeypatch.setenv("FAKE_HOSTS", str(root))
    cfg = isolated["home"].parent / "new.yml"
    assert main(["-c", str(cfg), "discover", "10.0.0.0/28", "10.0.0.9", "fd00::/124", "--ports", "22", "--write"]) == 0
    out = capsys.readouterr().out
    assert "found        2 hosts with open ports: 2 new" in out and "(1 more answered" in out
    hosts = load_config(cfg)["hosts"]
    assert sorted(h["ip"] for h in hosts.values()) == ["10.0.0.9", "fd00::7"]


# ---------------------------------------------------------------- roster discover --json (T107)

@pytest.fixture
def scanned(fakes, isolated, monkeypatch):
    """Stand-in Hosts for the stand-in nmap, and a roster.yml that already has the one at 10.0.0.9."""
    root = isolated["home"].parent / "hosts"
    for name, address, ports, title in (("db", "10.0.0.9", "22 ssh OpenSSH 9.6", ""),
                                        ("web", "10.0.0.10", "22 ssh OpenSSH 9.6\n443 https nginx", "Lab page"),
                                        ("printer", "10.0.0.11", "9100 jetdirect", "")):
        (root / name).mkdir(parents=True)
        (root / name / "address").write_text(address)
        (root / name / "ports").write_text(ports + "\n")
        if title:
            (root / name / "title").write_text(title)
    monkeypatch.setenv("FAKE_HOSTS", str(root))
    cfg = isolated["work"] / "roster.yml"
    cfg.write_text("groups:\n  lab:\n    user: ops\n    hosts:\n      old-db: 10.0.0.9\n")
    return cfg


def test_discover_json_is_the_plan_and_what_it_found(scanned, capsys):
    from roster.cli import main
    before = scanned.read_text()
    assert main(["-c", str(scanned), "discover", "10.0.0.0/28", "10.0.0.9", "--ports", "22,443", "--json"]) == 0
    out, err = capsys.readouterr()
    assert err == "" and scanned.read_text() == before                 # a preview: nothing written
    doc = json.loads(out)
    today = datetime.date.today().strftime("%Y%m%d")
    assert {k: v for k, v in doc.items() if k != "found"} == {
        "version": 1, "targets": ["10.0.0.0/28"], "addresses": 14, "ports": 2, "scanner": "nmap",
        "count": 2, "quiet": 1, "group": f"discovered-{today}"}
    known, new = doc["found"]
    assert known["address"] == "10.0.0.9" and known["known"] == "old-db" and known["name"] is None
    assert new == {"address": "10.0.0.10", "name": "server-10-0-0-10", "type": "server", "hostname": "",
                   "title": "Lab page", "web": "https://10.0.0.10", "known": None, "added": None, "vendor": "",
                   "os": "", "mac": "", "ports": [{"port": 22, "name": "ssh", "product": "OpenSSH 9.6", "title": ""},
                                                  {"port": 443, "name": "https", "product": "nginx",
                                                   "title": "Lab page"}]}


def test_discover_json_with_a_broken_roster_yml_found_without_c_is_error_1(scanned, capsys):
    # T104 (#182, from T107): without -c a broken roster.yml was ignored silently, --json too
    from roster.cli import main
    scanned.write_text("groups: [unclosed\n")
    assert main(["discover", "10.0.0.0/28", "--json"]) == 1
    out, err = capsys.readouterr()
    error = json.loads(err)["error"]
    assert out == "" and error["code"] == 1 and "roster.yml" in error["fix"]
    scanned.unlink()                                                # none at all: a scan needs no inventory
    assert main(["discover", "10.0.0.0/28", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["count"] == 3


def test_discover_json_with_roster_config_naming_no_file_scans_as_before(scanned, capsys, monkeypatch, tmp_path):
    # review of #216, 2: a ROSTER_CONFIG that names no file is no Inventory, not a broken one
    from roster.cli import main
    monkeypatch.setenv("ROSTER_CONFIG", str(tmp_path / "nowhere" / "roster.yml"))
    assert main(["discover", "10.0.0.0/28", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["count"] == 3


def test_discover_json_errors(scanned, capsys):
    from roster.cli import main
    assert main(["discover", "10.0.0.0/8", "--json"]) == 1
    out, err = capsys.readouterr()
    error = json.loads(err)["error"]
    assert out == "" and error["code"] == 121 and "16777214" in error["message"] and "--force" in error["fix"]
    assert main(["discover", "not-a-net", "--json"]) == 1
    out, err = capsys.readouterr()
    assert out == "" and json.loads(err)["error"]["code"] == 3
    with pytest.raises(SystemExit) as e:
        main(["discover", "10.0.0.0/28", "--write", "--json"])
    out, err = capsys.readouterr()
    assert e.value.code == 2 and out == "" and "--write" in json.loads(err)["error"]["message"]
