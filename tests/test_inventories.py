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


def list_path():
    """roster's list of named Inventories (in %APPDATA%\\roster on Windows)."""
    from roster.inventories import list_file
    return list_file()


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
    work_files = {f: f.read_bytes() for f in (d / "roster-inventories/work", two["work"].parent / "ROSTER.md")}
    assert "Host build-pi" in (d / "roster-inventories/work").read_text()
    assert run(capsys, "--inv", "home", "sync")[0] == 0
    assert "Host pi" in (d / "roster-inventories/home").read_text()
    assert "pi" in (two["home"].parent / "ROSTER.md").read_text()
    assert {f: f.read_bytes() for f in work_files} == work_files            # untouched
    assert not (d / "config.d/roster").exists()                              # no unnamed file was written
    index = (d / "config.d/roster.inventories").read_text().splitlines()
    assert [ln for ln in index if ln.startswith("#roster-from ")] == [
        f"#roster-from {ssh_path(d / 'roster-inventories/work')}", f"#roster-from {ssh_path(d / 'roster-inventories/home')}"]
    assert [ln for ln in index if ln.startswith("Host ")] == ["Host build-pi", "Host esx", "Host pi"]
    main_config = (d / "config").read_text()
    assert inc(d / "config.d/roster.inventories") in main_config and "roster-inventories" not in main_config
    # each Inventory's Hosts check their keys in its own known_hosts
    assert f"UserKnownHostsFile \"{ssh_path(d / 'roster_known_hosts-home')}\"" in (d / "roster-inventories/home").read_text()

    run(capsys, "inv", "use", "home")                     # the active one comes first: it wins a name clash
    index = (d / "config.d/roster.inventories").read_text().splitlines()
    assert [ln for ln in index if ln.startswith("#roster-from ")][0] == f"#roster-from {ssh_path(d / 'roster-inventories/home')}"


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
    assert not (list_path()).exists()


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
    assert messages["E194"] == ("`esx` is a Host in both work and home: `ssh esx` reaches work's (the active "
                                "Inventory); home's `esx` is left out of this Box's ssh config")
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


# ---------------------------------------------------------------- PR #335's review: trust, injection, clashes, cleanup

import os  # noqa: E402
import shutil  # noqa: E402
import stat  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402

REAL_SSH = shutil.which("ssh")
needs_ssh = pytest.mark.skipif(REAL_SSH is None or os.name == "nt", reason="asks the real ssh what it resolves (ssh -G)")
posix_modes = pytest.mark.skipif(os.name == "nt", reason="POSIX file modes")


def resolved(isolated, host):
    """What the real ssh makes of HOST with this Box's ~/.ssh/config: {option: [values]} (ssh -G, no connection)."""
    r = subprocess.run([REAL_SSH, "-F", str(ssh(isolated) / "config"), "-G", host], capture_output=True, text=True,
                       timeout=30, check=True)
    out = {}
    for line in r.stdout.splitlines():
        k, _, v = line.partition(" ")
        out.setdefault(k, []).append(v)
    return out


def test_every_named_inventory_keeps_the_host_keys_the_box_had(two, capsys, isolated):
    """Review 1: before named Inventories every roster.yml shared ~/.ssh/roster_known_hosts, so each new named one starts
    with all of it, whichever file the unnamed ssh config was last written from."""
    run(capsys, "-c", str(two["work"]), "sync")
    run(capsys, "-c", str(two["home"]), "sync")              # the unnamed config now names home's file
    shared = f"10.0.0.5 ssh-ed25519 {KEY_A}\n192.168.1.20 ssh-ed25519 {KEY_B}\n"
    (ssh(isolated) / "roster_known_hosts").write_text(shared)
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    for name in ("work", "home"):
        assert (ssh(isolated) / f"roster_known_hosts-{name}").read_text() == shared


@needs_ssh
def test_after_naming_both_plain_ssh_checks_each_host_against_its_recorded_key(two, capsys, isolated):
    run(capsys, "-c", str(two["work"]), "sync")
    run(capsys, "-c", str(two["home"]), "sync")
    (ssh(isolated) / "roster_known_hosts").write_text(f"10.0.0.5 ssh-ed25519 {KEY_A}\n")
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    run(capsys, "sync")
    run(capsys, "--inv", "home", "sync")
    files = resolved(isolated, "build-pi")["userknownhostsfile"][0].split()
    assert any(f"10.0.0.5 ssh-ed25519 {KEY_A}" in Path(f).read_text() for f in files if Path(f).exists())


@pytest.mark.parametrize("name", ['x"\nProxyCommand touch pwned\n#', "work\n", "../up", "work.", "a b"])
def test_a_hand_edited_name_in_the_list_is_refused_when_it_loads(two, capsys, isolated, name):
    """Review 2: a name from inventories.json reaches ssh config lines and file names: checked as add checks it."""
    lst = list_path()
    lst.parent.mkdir(parents=True)
    lst.write_text(json.dumps({"active": name, "inventories": [{"name": name, "path": str(two["work"])}]}))
    with pytest.raises(SystemExit, match="inventories.json doesn't load"):
        main(["inv", "list"])
    assert not (ssh(isolated) / "config.d").exists()


def test_a_relative_path_in_the_list_is_refused(two, isolated):
    lst = list_path()
    lst.parent.mkdir(parents=True)
    lst.write_text(json.dumps({"active": None, "inventories": [{"name": "w", "path": "work/roster.yml"}]}))
    with pytest.raises(SystemExit, match="inventories.json doesn't load"):
        main(["inv", "list"])


@pytest.mark.parametrize("name", ["work\n", "work.", "Work"])
def test_inv_add_refuses_a_trailing_newline_or_dot_and_a_name_that_differs_only_in_case(two, capsys, name):
    """Review 3 and 5: `$'work\\n'` broke every ssh on the Box; `Work` and `work.` are `work`'s files on Windows."""
    run(capsys, "inv", "add", "work", str(two["work"]))
    with pytest.raises(SystemExit, match="bad Inventory name|already an Inventory named"):
        main(["inv", "add", name, str(two["home"])])


def test_names_with_a_trailing_newline_are_refused_everywhere():
    """Review 3: the one name rule (Hosts, groups, resources, Inventories) matches the whole name."""
    from roster.common import NAME_RE
    assert NAME_RE.match("pi") and not NAME_RE.match("pi\n") and not NAME_RE.match("pi\nx")


@needs_ssh
def test_on_a_name_clash_ssh_sees_only_the_active_inventorys_host(two, capsys, isolated):
    """Review 4: IdentityFile adds up over every matching block, so the other Inventory's block for the same name must
    not be there at all: the active one's is the only `Host pi` ssh reads."""
    two["work"].write_text(WORK + "      pi: {ip: 10.0.0.9}\n")
    two["home"].write_text("key_path: ~/.ssh/home_key\n" + HOME.replace("auth: agent", "auth: env:HOME_PW"))
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    run(capsys, "sync")
    run(capsys, "--inv", "home", "sync")
    pi = resolved(isolated, "pi")
    assert pi["hostname"] == ["10.0.0.9"]
    assert [Path(f).name for f in pi["identityfile"]] == ["roster_ed25519"]
    run(capsys, "inv", "use", "home")                      # now home's pi, and only home's key
    pi = resolved(isolated, "pi")
    assert pi["hostname"] == ["192.168.1.20"]
    assert [Path(f).name for f in pi["identityfile"]] == ["home_key"]
    assert resolved(isolated, "build-pi")["hostname"] == ["10.0.0.5"]       # no clash: still there


def test_a_left_out_host_isnt_reported_missing_and_the_warning_says_why(two, capsys, isolated):
    two["work"].write_text(WORK + "      pi: {ip: 10.0.0.9}\n")
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    run(capsys, "sync")
    run(capsys, "--inv", "home", "sync")
    main(["--inv", "home", "check", "--box", "--json"])
    checks = json.loads(capsys.readouterr().out)["checks"]
    clash = next(c for c in checks if c.get("topic") == "E194")
    assert clash["message"] == ("`pi` is a Host in both home and work: `ssh pi` reaches work's (the active Inventory); "
                                "home's `pi` is left out of this Box's ssh config")
    assert not [c for c in checks if c["section"] == "ssh" and "not in roster's ssh config" in c["message"]]


@needs_ssh
def test_deleting_the_list_by_hand_means_none_are_named(two, capsys, isolated):
    """Review 6: roster's own fix text says to delete inventories.json; then the next sync is roster's one file again,
    and the stale index can't win."""
    two["work"].write_text(WORK + "      pi: {ip: 10.0.0.9}\n")
    run(capsys, "inv", "add", "h", str(two["home"]))
    run(capsys, "sync")
    (list_path()).unlink()
    run(capsys, "-c", str(two["work"]), "sync")
    assert resolved(isolated, "pi")["hostname"] == ["10.0.0.9"]
    assert not (ssh(isolated) / "config.d/roster.inventories").exists()
    assert (ssh(isolated) / "config").read_text().count("Include") == 1


def test_a_users_own_include_of_the_index_isnt_doubled(two, capsys, isolated):
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "sync")
    cfg = ssh(isolated) / "config"
    cfg.write_text("Include ~/.ssh/config.d/roster.inventories\n\nHost *\n    ServerAliveInterval 60\n")
    run(capsys, "sync")
    run(capsys, "inv", "add", "home", str(two["home"]))
    assert cfg.read_text() == "Include ~/.ssh/config.d/roster.inventories\n\nHost *\n    ServerAliveInterval 60\n"


def test_another_inventorys_load_error_isnt_repeated_here(two, capsys, isolated):
    """Review 7: home's broken line could hold anything; work's output only says where to look."""
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    two["home"].write_text("groups: [oops-s3cr3t-token\n")
    main(["check", "--box", "--json"])
    out = capsys.readouterr().out
    bad = next(c for c in json.loads(out)["checks"] if c.get("topic") == "E192")
    assert bad["message"] == "home's roster.yml doesn't load, so it isn't compared with this one"
    assert "roster --inv home check --box" in bad["fix"]
    assert "s3cr3t" not in out
    _, out, err = run(capsys, "sync")
    assert "s3cr3t" not in out + err


@posix_modes
def test_file_modes(two, capsys, isolated):
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "sync")
    d = ssh(isolated)
    mode = lambda p: stat.S_IMODE(p.stat().st_mode)  # noqa: E731
    assert mode(list_path()) == 0o600
    assert mode(d / "config") == 0o600 and mode(d / "config.d/roster.inventories") == 0o600
    assert mode(d / "config.d") == 0o700 and mode(d / "roster-inventories/work") == 0o600
    assert mode(d / "roster-inventories") == 0o700
    run(capsys, "inv", "add", "home", str(two["home"]))
    assert not list(list_path().parent.glob("*.new*"))       # no temp file left behind


def test_removing_the_last_one_says_to_sync(two, capsys, isolated):
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "sync")
    _, out, _ = run(capsys, "inv", "remove", "work")
    assert "run `roster sync`" in out


def test_a_removed_names_host_keys_dont_go_to_a_new_file_of_the_same_name(two, capsys, isolated):
    """Review 10: `inv remove work; inv add work other.yml` must not hand the old file's keys to the new one."""
    run(capsys, "inv", "add", "work", str(two["work"]))
    kh = ssh(isolated) / "roster_known_hosts-work"
    kh.parent.mkdir(exist_ok=True)
    kh.write_text(f"10.0.0.5 ssh-ed25519 {KEY_A}\n")
    _, out, _ = run(capsys, "inv", "remove", "work")
    assert "roster_known_hosts-work" in out                 # says where the old keys went
    run(capsys, "inv", "add", "work", str(two["home"]))
    assert not kh.exists() or KEY_A not in kh.read_text()
    assert list(ssh(isolated).glob("roster_known_hosts-work.removed*"))


@needs_ssh
def test_key_path_cant_inject_ssh_config_lines(write_config, capsys, isolated):
    """P1 (before named Inventories too): a value roster writes into ssh config can't end its line or its quotes."""
    write_config('key_path: "~/.ssh/k\\"\\nMatch all\\nProxyCommand touch pwned\\n#"\n' + WORK)
    with pytest.raises(SystemExit, match="key_path"):
        main(["sync"])
    d = ssh(isolated)
    assert "ProxyCommand" not in "".join(p.read_text() for p in d.rglob("*") if p.is_file()) if d.exists() else True


@pytest.mark.parametrize("value", ['/x/"y', "/x/y\nProxyCommand z", "/x/\ty", "/x/\x7fy"])
def test_the_ssh_config_quoting_refuses_quotes_and_control_characters(value):
    from roster.sshops import ssh_quote
    with pytest.raises(ValueError):
        ssh_quote(value)


def test_the_ssh_config_quoting_escapes_percent_for_token_options():
    from roster.sshops import ssh_quote
    assert ssh_quote("/home/50%/k", tokens=True) == '"/home/50%%/k"'
    assert ssh_quote("/home/50%/k") == '"/home/50%/k"'


def sync_unnamed(src, root):
    """`roster sync` twice with the roster in SRC, in a temp HOME under ROOT with tests/vectors/sync-unnamed.yml and a
    group-writable ~/.ssh/config: what it printed, the files it wrote and their modes, with HOME as {HOME}."""
    vectors = Path(__file__).parent / "vectors"
    home = Path(root) / "golden"
    (home / "inv").mkdir(parents=True)
    (home / ".ssh").mkdir(mode=0o700)
    (home / ".ssh/config").write_text("Host *\n    ServerAliveInterval 60\n")
    (home / ".ssh/config").chmod(0o664)
    yml = home / "inv/roster.yml"
    yml.write_text((vectors / "sync-unnamed.yml").read_text())
    env = {k: v for k, v in os.environ.items() if k != "ROSTER_CONFIG"}
    env.update(HOME=str(home), PYTHONPATH=str(src))
    outs = [subprocess.run([sys.executable, "-m", "roster", "-c", str(yml), "sync"], env=env, cwd=home,
                           capture_output=True, text=True, check=True).stdout for _ in range(2)]
    sub = lambda s: s.replace(str(home), "{HOME}")  # noqa: E731
    return {"stdout": [sub(o) for o in outs],
            "files": {k: sub((home / k).read_text()) for k in (".ssh/config", ".ssh/config.d/roster")},
            "listing": sorted(str(p.relative_to(home)) for p in home.rglob("*")),
            "modes": {str(p.relative_to(home)): oct(stat.S_IMODE(p.stat().st_mode)) for p in sorted(home.rglob("*"))
                      if ".ssh" in p.parts}}


@pytest.mark.skipif(os.name == "nt", reason="the vector was made on Linux (ControlMaster, paths, modes)")
def test_without_named_inventories_sync_is_byte_for_byte_what_dev_wrote(tmp_path):
    """tests/vectors/sync-unnamed.json: sync_unnamed() run with dev's roster before ticket 115 (`git archive origin/dev
    src`, then `sync_unnamed(that src, a temp dir)`). The output, ~/.ssh/config, roster's ssh config, the files written
    and their modes are the same, byte for byte."""
    want = json.loads((Path(__file__).parent / "vectors/sync-unnamed.json").read_text())
    assert sync_unnamed(Path(__file__).parent.parent / "src", tmp_path) == want


# ---------------------------------------------------------------- PR #335's second review pass

CLASH_WORK = WORK + "      pi: {ip: 10.0.0.9}\n"
CLASH_HOME = HOME.replace("auth: agent", "auth: env:HOMEPW")


def clashing(two, capsys):
    two["work"].write_text(CLASH_WORK)
    two["home"].write_text(CLASH_HOME)
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    run(capsys, "sync")
    run(capsys, "--inv", "home", "sync")


@pytest.fixture
def ssh_log(fakes, monkeypatch, tmp_path):
    log = tmp_path / "ssh.log"
    monkeypatch.setenv("FAKE_LOG", str(log))
    return lambda: [ln for ln in (log.read_text().splitlines() if log.exists() else []) if ln.startswith("ssh ")]


@pytest.mark.parametrize("argv", [["run", "pi", "--", "id"], ["run", "--sudo", "pi", "--", "id"]])
def test_the_cli_never_reaches_another_inventorys_host_by_a_left_out_name(two, capsys, ssh_log, monkeypatch, argv):
    """Second pass N1: `ssh pi` reaches work's pi, so home's run/sudo by that name must not run ssh at all (home's
    sudo password would go to work's machine)."""
    monkeypatch.setenv("HOMEPW", "hunter2")
    clashing(two, capsys)
    with pytest.raises(SystemExit, match="left out of this Box's ssh config"):
        main(["--inv", "home", *argv])
    assert ssh_log() == []


def test_check_setup_and_revoke_skip_a_left_out_host(two, capsys, ssh_log, monkeypatch):
    monkeypatch.setenv("HOMEPW", "hunter2")
    clashing(two, capsys)
    main(["--inv", "home", "check"])
    main(["--inv", "home", "revoke", "-y"])
    out = capsys.readouterr().out
    assert "pi: left out of this Box's ssh config" in out
    assert not [ln for ln in ssh_log() if ln.split()[-1] == "pi" or " pi " in ln]


def test_the_name_clash_warning_doesnt_suggest_inv_run(two, capsys, isolated):
    clashing(two, capsys)
    main(["--inv", "home", "check", "--box", "--json"])
    w = next(c for c in json.loads(capsys.readouterr().out)["checks"] if c.get("topic") == "E194")
    assert "run" not in w["fix"] and "roster inv use home" in w["fix"]


@pytest.mark.parametrize("field,value", [("ip", '10.0.0.5"'), ("ip", "%h.evil"), ("user", 'ops"'), ("user", "%d"),
                                         ("user", "ops\x7f")])
def test_values_written_raw_into_ssh_config_are_refused_at_load(write_config, field, value):
    """Second pass N2: HostName and User go into the ssh config as they are: a quote broke every ssh on the Box, a %
    expands as a token."""
    host = {"ip": "10.0.0.5", "user": "ops", field: value}
    write_config("groups:\n  lab:\n    hosts:\n      box: " + json.dumps(host) + "\n")
    with pytest.raises(SystemExit, match=f"{field}"):
        main(["hosts"])


@needs_ssh
def test_a_glob_include_of_config_d_doesnt_read_each_inventorys_own_file(two, capsys, isolated):
    """Second pass N3: `Include ~/.ssh/config.d/*` is common; the per-Inventory files must not be where it reads them,
    or the left-out block's IdentityFile adds up again."""
    two["work"].write_text(CLASH_WORK)
    two["home"].write_text("key_path: ~/.ssh/home_key\n" + CLASH_HOME)
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    run(capsys, "sync")
    run(capsys, "--inv", "home", "sync")
    cfg = ssh(isolated) / "config"
    cfg.write_text(cfg.read_text() + f"\nInclude {ssh(isolated)}/config.d/*\n")
    pi = resolved(isolated, "pi")
    assert [Path(f).name for f in pi["identityfile"]] == ["roster_ed25519"]
    assert not list((ssh(isolated) / "config.d").glob("roster-*"))


def test_files_from_before_move_to_their_new_place(two, capsys, isolated):
    run(capsys, "inv", "add", "work", str(two["work"]))
    old = ssh(isolated) / "config.d/roster-work"
    old.parent.mkdir(parents=True, exist_ok=True)
    old.write_text("# Generated by roster from x\n")
    run(capsys, "sync")
    assert not old.exists()
    assert (ssh(isolated) / "roster-inventories/work").is_file()


@posix_modes
def test_ssh_config_is_0600_after_roster_writes_it_as_dev_did(two, capsys, isolated):
    """Second pass N4: a group-writable ~/.ssh/config makes OpenSSH refuse it; roster tightens it when it writes it."""
    cfg = ssh(isolated) / "config"
    cfg.parent.mkdir(mode=0o700)
    cfg.write_text("Host *\n    ServerAliveInterval 60\n")
    cfg.chmod(0o664)
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "sync")
    assert stat.S_IMODE(cfg.stat().st_mode) == 0o600


def test_a_description_starting_with_from_doesnt_confuse_the_index(two, capsys, isolated):
    """Second pass N5: a Host's comment line `# from the rack…` isn't a section of the index."""
    two["work"].write_text(WORK.replace("build-pi: {ip: 10.0.0.5}",
                                        "build-pi: {ip: 10.0.0.5, description: from the rack in room 2}"))
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    run(capsys, "sync")
    run(capsys, "--inv", "home", "sync")
    from roster.sshops import in_ssh_config
    main(["hosts"])                                        # this process now uses work's files
    capsys.readouterr()
    assert in_ssh_config("esx") and in_ssh_config("build-pi")
    main(["--inv", "home", "hosts"])
    capsys.readouterr()
    assert in_ssh_config("pi")


def test_a_stale_index_is_rebuilt(two, capsys, isolated):
    """Second pass N7: an older roster syncing the unnamed file doesn't rebuild the index; the next roster run does."""
    import time
    run(capsys, "inv", "add", "work", str(two["work"]))
    run(capsys, "sync")
    own = ssh(isolated) / "roster-inventories/work"
    time.sleep(0.05)
    own.write_text(own.read_text().replace("Host esx", "Host esx-renamed"))
    os.utime(own, None)
    run(capsys, "hosts")
    assert "Host esx-renamed" in (ssh(isolated) / "config.d/roster.inventories").read_text()


def test_inv_use_names_it_as_it_was_named(two, capsys):
    run(capsys, "inv", "add", "Work", str(two["work"]))
    run(capsys, "inv", "add", "home", str(two["home"]))
    assert run(capsys, "inv", "use", "WORK")[1].startswith("Work is the active Inventory")
