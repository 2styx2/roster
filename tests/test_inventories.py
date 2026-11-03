"""Ticket 115 (#201): several named Inventories on one Box, one active. `roster inv` names them, `roster --inv NAME`
runs one command against another, each Inventory gets its own generated ssh config, known_hosts and ROSTER.md, and
roster warns when the same machine is in two of them."""

import json

import pytest

from roster.cli import main
from roster.common import ssh_path

WORK = """\
groups:
  lab:
    user: ops
    auth: env:LAB
    hosts:
      build-pi: {ip: 10.0.0.5}
      esx: {ip: 10.0.0.6, enroll: false}
"""

HOME = """\
groups:
  house:
    user: pi
    auth: agent
    hosts:
      pi: {ip: 192.168.1.20}
"""


@pytest.fixture
def two(isolated):
    """Two Inventories, each in its own folder (as two repos would be): {name: path}."""
    out = {}
    for name, text in (("work", WORK), ("home", HOME)):
        d = isolated["home"] / name
        d.mkdir()
        (d / "roster.yml").write_text(text)
        out[name] = d / "roster.yml"
    return out


def run(capsys, *argv):
    code = main(list(argv))
    out = capsys.readouterr()
    return code, out.out, out.err


def test_inv_add_list_use_remove(two, capsys):
    assert run(capsys, "inv", "list")[1].strip() == "no named Inventories (roster inv add NAME PATH names one)"
    code, out, _ = run(capsys, "inv", "add", "work", str(two["work"]))
    assert code == 0 and "work is the active Inventory" in out
    assert run(capsys, "inv", "add", "home", str(two["home"]))[0] == 0
    code, out, _ = run(capsys, "inv", "list")
    assert out.splitlines() == [f"* work  {two['work']}", f"  home  {two['home']}"]
    assert run(capsys, "inv", "use", "home")[0] == 0
    code, out, _ = run(capsys, "inv", "list", "--json")
    data = json.loads(out)
    assert data["active"] == "home"
    assert data["inventories"] == [{"name": "work", "path": str(two["work"]), "active": False, "exists": True},
                                   {"name": "home", "path": str(two["home"]), "active": True, "exists": True}]
    assert run(capsys, "inv", "remove", "home")[0] == 0
    assert two["home"].exists()                         # it forgets the name; the file stays
    assert run(capsys, "inv", "list")[1].splitlines() == [f"  work  {two['work']}"]


def test_inv_refuses_unknown_names_taken_names_and_missing_files(two, capsys):
    with pytest.raises(SystemExit, match="no Inventory named 'nope'"):
        main(["inv", "use", "nope"])
    assert run(capsys, "inv", "add", "work", str(two["work"]))[0] == 0
    with pytest.raises(SystemExit, match="already"):
        main(["inv", "add", "work", str(two["home"])])
    with pytest.raises(SystemExit, match="already"):
        main(["inv", "add", "again", str(two["work"])])
    with pytest.raises(SystemExit, match="no file"):
        main(["inv", "add", "gone", str(two["work"].parent / "missing.yml")])
    with pytest.raises(SystemExit, match="bad Inventory name"):
        main(["inv", "add", "bad/name", str(two["home"])])


def ssh(isolated):
    return isolated["home"] / ".ssh"


def inc(path):
    """An Include line as roster writes it (forward slashes on Windows)."""
    return f'Include "{ssh_path(path)}"'


def test_each_inventory_has_its_own_files_and_syncing_one_leaves_the_other_alone(two, capsys, isolated):
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    assert run(capsys, "sync")[0] == 0                    # the active one: work
    d = ssh(isolated)
    work_files = {f: f.read_bytes() for f in (d / "config.d/roster-work", two["work"].parent / "ROSTER.md")}
    assert "Host build-pi" in (d / "config.d/roster-work").read_text()
    assert run(capsys, "--inv", "home", "sync")[0] == 0
    assert "Host pi" in (d / "config.d/roster-home").read_text()
    assert "pi" in (two["home"].parent / "ROSTER.md").read_text()
    assert {f: f.read_bytes() for f in work_files} == work_files            # untouched
    assert not (d / "config.d/roster").exists()                              # no unnamed file was written
    index = (d / "config.d/roster.inventories").read_text().splitlines()
    assert [ln for ln in index if ln.startswith("Include")] == [
        inc(d / "config.d/roster-work"), inc(d / "config.d/roster-home")]
    main_config = (d / "config").read_text()
    assert inc(d / "config.d/roster.inventories") in main_config and "config.d/roster-" not in main_config
    # each Inventory's Hosts check their keys in its own known_hosts
    assert f"UserKnownHostsFile \"{ssh_path(d / 'roster_known_hosts-home')}\"" in (d / "config.d/roster-home").read_text()

    run(capsys, "inv", "use", "home")                     # the active one comes first: it wins a name clash
    index = (d / "config.d/roster.inventories").read_text().splitlines()
    assert [ln for ln in index if ln.startswith("Include")][0] == inc(d / "config.d/roster-home")


def test_inv_runs_one_command_against_another_inventory(two, capsys):
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    assert "build-pi" in run(capsys, "hosts")[1]
    out = run(capsys, "--inv", "home", "hosts")[1]
    assert "pi" in out and "build-pi" not in out
    assert run(capsys, "inv", "which")[1].strip() == str(two["work"].resolve())
    assert run(capsys, "--inv", "home", "inv", "which")[1].strip() == str(two["home"].resolve())
    with pytest.raises(SystemExit, match="no Inventory named 'nope'"):
        main(["--inv", "nope", "hosts"])


def test_lookup_order_with_named_inventories(two, capsys, isolated, monkeypatch):
    run(capsys, "inv", "add", "work", str(two["work"]))
    assert run(capsys, "inv", "which")[1].strip() == str(two["work"].resolve())     # the active one
    (isolated["work"] / "roster.yml").write_text(HOME)                               # ./roster.yml comes first
    assert run(capsys, "inv", "which")[1].strip() == str((isolated["work"] / "roster.yml").resolve())
    monkeypatch.setenv("ROSTER_CONFIG", str(two["home"]))                            # and $ROSTER_CONFIG before it
    assert run(capsys, "inv", "which")[1].strip() == str(two["home"].resolve())


def test_without_named_inventories_sync_writes_what_it_always_did(two, capsys, isolated):
    assert run(capsys, "-c", str(two["work"]), "sync")[0] == 0
    d = ssh(isolated)
    assert (d / "config.d/roster").exists() and not (d / "config.d/roster.inventories").exists()
    assert (d / "config").read_text().startswith(inc(d / "config.d/roster") + "\n")
    assert not (isolated["home"] / ".config/roster/inventories.json").exists()


def test_naming_a_synced_inventory_keeps_its_host_keys_and_takes_its_include(two, capsys, isolated):
    run(capsys, "-c", str(two["work"]), "sync")
    d = ssh(isolated)
    (d / "roster_known_hosts").write_text("10.0.0.5 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnlyForTests\n")
    run(capsys, "inv", "add", "work", str(two["work"]))
    assert (d / "roster_known_hosts-work").read_text() == (d / "roster_known_hosts").read_text()
    run(capsys, "sync")
    assert not (d / "config.d/roster").exists()           # written from the same file: the named one replaces it
    main_config = (d / "config").read_text()
    assert main_config.count("Include") == 1 and "roster.inventories" in main_config
    run(capsys, "inv", "remove", "work")                  # none named: back to roster's one file
    assert (d / "config").read_text().count(inc(d / "config.d/roster")) == 1


KEY_A = "AAAAC3NzaC1lZDI1NTE5AAAAIBERERERERERERERERERERERERERERERERERERERERER"   # made up
KEY_B = "AAAAC3NzaC1lZDI1NTE5AAAAICIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi"


def known(isolated, name, *lines):
    d = ssh(isolated)
    d.mkdir(exist_ok=True)
    (d / f"roster_known_hosts-{name}").write_text("".join(f"{ln}\n" for ln in lines))


def box_warnings(capsys, *argv):
    main([*argv, "check", "--box", "--json"])
    return [c for c in json.loads(capsys.readouterr().out)["checks"] if c["section"] == "inventory"]


def test_the_same_host_key_in_two_inventories_is_a_warning(two, capsys, isolated):
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    known(isolated, "work", f"10.0.0.5 ssh-ed25519 {KEY_A}", f"10.0.0.6 ssh-ed25519 {KEY_B}")
    known(isolated, "home", f"192.168.1.20 ssh-ed25519 {KEY_A}")
    checks = box_warnings(capsys)
    same = [c for c in checks if "same host key" in c["message"]]
    assert len(same) == 1 and same[0]["level"] == "warn" and same[0]["topic"] == "E193"
    assert same[0]["message"] == "`build-pi` in work and `pi` in home have the same host key: the same machine?"
    assert same[0]["fix"]
    assert not [c for c in checks if c["level"] == "error"]
    # the other way round from home, and plain text on the command line
    code, out, _ = run(capsys, "--inv", "home", "check", "--box")
    assert "`pi` in home and `build-pi` in work have the same host key: the same machine?" in out
    assert KEY_A not in out                                 # fingerprints only, and those only to compare


def test_the_same_host_name_or_address_with_other_keys_is_a_warning(two, capsys, isolated):
    two["home"].write_text(HOME.replace("pi: {ip: 192.168.1.20}", "esx: {ip: 192.168.1.20}\n      nas: {ip: 10.0.0.5}"))
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    known(isolated, "work", f"10.0.0.5 ssh-ed25519 {KEY_A}")
    known(isolated, "home", f"10.0.0.5 ssh-ed25519 {KEY_B}")
    messages = {c["topic"]: c["message"] for c in box_warnings(capsys) if c["level"] == "warn"}
    assert messages["E194"] == "`esx` is a Host in both work and home: `ssh esx` reaches work's (the active Inventory)"
    assert messages["E195"] == ("`build-pi` in work and `nas` in home are both 10.0.0.5:22, with different host "
                                "keys: two networks with the same addresses?")


def test_another_inventory_that_doesnt_load_is_a_warning_not_an_error(two, capsys, isolated):
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    two["home"].write_text("groups: [oops\n")
    checks = box_warnings(capsys)
    bad = [c for c in checks if c.get("topic") == "E192"]
    assert len(bad) == 1 and bad[0]["level"] == "warn" and "home" in bad[0]["message"]


def test_sync_warns_about_the_same_machine_too(two, capsys, isolated):
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    known(isolated, "work", f"10.0.0.5 ssh-ed25519 {KEY_A}")
    known(isolated, "home", f"192.168.1.20 ssh-ed25519 {KEY_A}")
    assert run(capsys, "sync")[0] == 0
    _, out, err = run(capsys, "sync")
    assert "warning: `build-pi` in work and `pi` in home have the same host key: the same machine?" in out + err


def test_serve_lists_the_named_inventories_and_switches_the_active_one(two, capsys, serve):
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    s = serve()
    r = s.call("inventories.list")["result"]
    assert r["active"] == "work" and r["name"] == "work" and r["path"] == str(two["work"].resolve())
    assert [x["name"] for x in r["inventories"]] == ["work", "home"]
    assert s.call("inventories.use", {"name": "home"})["result"] == {"active": "home", "path": str(two["home"]),
                                                                     "restart": True}
    r = s.call("inventories.list")["result"]
    assert r["active"] == "home" and r["name"] == "work"      # this serve still runs on work's: restart to switch
    err = s.call("inventories.use", {"name": "nope"})["error"]
    assert err["code"] == 140 and err["data"]["names"] == ["work", "home"] and err["data"]["fix"]
    assert serve("--inv", "home").call("inventories.list")["result"]["name"] == "home"


def test_serve_without_named_inventories(write_config, serve):
    path = write_config(WORK)
    r = serve().call("inventories.list")["result"]
    assert r == {"inventories": [], "active": None, "name": None, "path": str(path.resolve())}


def test_unknown_inv_with_json_is_code_140(two, capsys):
    assert main(["--inv", "nope", "hosts", "--json"]) == 1
    assert json.loads(capsys.readouterr().err)["error"]["code"] == 140


@pytest.mark.skipif(__import__("os").name == "nt" or not __import__("shutil").which("bash"),
                    reason="runs the app's probe, a bash script")
def test_the_apps_probe_finds_the_file_the_cli_uses(two, capsys, isolated):
    """crates/roster-core/src/detect.rs's PROBE, run for real against this roster: it says the Inventory roster
    itself uses, not ~/infra/roster.yml or ~/roster.yml, which the app used to try first (ticket 115)."""
    import os
    import re
    import subprocess
    import sys
    from pathlib import Path

    rust = (Path(__file__).parent.parent / "crates/roster-core/src/detect.rs").read_text()
    probe = re.search(r'const PROBE: &str = r#"(.*?)"#;', rust, re.S).group(1)
    (isolated["home"] / "infra").mkdir()
    (isolated["home"] / "infra/roster.yml").write_text(WORK)
    (isolated["home"] / "roster.yml").unlink(missing_ok=True)
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    run(capsys, "inv", "use", "home")
    env = {**os.environ, "HOME": str(isolated["home"])}
    env.pop("ROSTER_CONFIG", None)
    out = subprocess.run(["bash", "-c", probe, "probe", sys.executable, "-m", "roster"], env=env,
                         capture_output=True, text=True, timeout=60).stdout
    assert f"inventory={two['home'].resolve()}" in out.splitlines()
