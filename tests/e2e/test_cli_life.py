"""The CLI's whole life on one Box against real sshd (docs/development.md, "End-to-end suite"): a new Inventory, Hosts
added by hand and from the vault, setup over ssh, the checks, plain ssh through roster's config, roster run and web,
the Mesh between two Hosts, a key rotation, a scan, sync and revoke. The tests run in file order on one Box and one
set of stand-in Hosts; each one is a step of the same life."""

import json
import re

import pytest

from . import e2e_lab as world

LAB01, LAB02, LAB03 = (world.address(n) for n in ("lab-01", "lab-02", "lab-03"))
PORT = str(world.PORT)
UNLOCKED = {"BW_SESSION": "fake-session-key"}       # the stand-in bw's session key: unlocked

ITEMS = [
    {"id": "e2e-0001", "name": "lab-03 ssh", "revisionDate": "2026-10-01T10:00:00.000Z",
     "login": {"username": "ops", "password": "ops-pass-1", "uris": [{"uri": f"ssh://{LAB03}:{PORT}"}]}},
    {"id": "e2e-0002", "name": "lab ops", "revisionDate": "2026-10-02T10:00:00.000Z",
     "login": {"username": "ops", "password": "ops-pass-1"}},
    {"id": "e2e-0003", "name": "lab-02 spare", "revisionDate": "2026-10-03T10:00:00.000Z",
     "login": {"username": "lab", "password": "lab-pass-1", "uris": [{"uri": f"ssh://{LAB02}:{PORT}"}]}},
]


@pytest.fixture(scope="module")
def life(lab, box):
    (box.root / "bw-items.json").write_text(json.dumps(ITEMS))
    return box


def keys(lab, name, user="lab"):
    """The key lines in a stand-in Host's authorized_keys (no blank lines)."""
    return [x for x in (lab.authorized_keys(name, user) or "").splitlines() if x.strip()]


def snapshot(lab, box, step):
    """Record the files roster wrote, here and on the Hosts, for --compare."""
    files = box.tree()
    for name in world.HOSTS:
        for user in ("lab", "ops"):
            files.update(lab.ssh_files(name, user))
    box.files(step, files)
    return files


def ok(r):
    assert r.code == 0, f"{' '.join(r.argv)} exited {r.code}\nstdout:\n{r.out}\nstderr:\n{r.err}"
    return r


# ---------------------------------------------------------------- a new Inventory, named

def test_init_writes_a_blank_inventory(life):
    r = ok(life.run("init", "init", "--blank"))
    assert "a blank Inventory" in r.out
    text = life.read("work/roster.yml")
    assert text and "groups:" in text
    # a stable Box name for the key tags (blank would be this machine's hostname)
    (life.home / "work" / "roster.yml").write_text("box_name: e2e-box\n" + text)


def test_init_again_refuses_to_overwrite(life):
    r = life.run("init-again", "init", "--blank")
    assert r.code != 0 and "roster.yml" in r.out + r.err


def test_inv_add_and_use_name_the_inventory(life):
    ok(life.run("inv-add", "inv", "add", "lab", str(life.home / "work" / "roster.yml")))
    ok(life.run("inv-use", "inv", "use", "lab"))
    life.cwd = life.home                    # from here on, no ./roster.yml: the named Inventory is the one used
    r = ok(life.run("inv-list", "inv", "list"))
    assert "lab" in r.out and "*" in r.out
    r = ok(life.run("inv-which", "inv", "which"))
    assert r.out.strip().endswith("work/roster.yml")
    r = ok(life.run("inv-list-json", "inv", "list", "--json"))
    assert any(i["name"] == "lab" for i in r.json["inventories"])


# ---------------------------------------------------------------- Hosts added

def test_add_dry_run_writes_nothing(life):
    before = life.read("work/roster.yml")
    r = ok(life.run("add-dry", "add", "lab-01", "--ip", LAB01, "--port", PORT, "--user", "lab", "--auth",
                    "env:LAB_PW", "--group", "lab", "--dry-run", "-y"))
    assert "lab-01" in r.out
    assert life.read("work/roster.yml") == before


def test_add_two_hosts_by_hand(life):
    for name, addr in (("lab-01", LAB01), ("lab-02", LAB02)):
        r = ok(life.run(f"add-{name}", "add", name, "--ip", addr, "--port", PORT, "--user", "lab", "--auth",
                        "env:LAB_PW", "--group", "lab", "--type", "dev", "--title", f"Lab box {name[-1]}", "-y"))
        assert f"wrote        {name} into group 'lab'" in r.out
    assert "Host lab-02" in (life.read(".ssh/roster-inventories/lab") or "")


def test_add_a_taken_name_is_refused(life):
    r = life.run("add-taken", "add", "lab-01", "--ip", LAB01, "--group", "lab", "-y")
    assert r.code != 0 and "lab-01" in r.out + r.err


def test_add_from_vault_lists_the_items_no_login_names(life):
    r = life.run("from-vault-none", "add", "--from-vault", "--json")
    assert r.code == 1 and r.out == "" and json.loads(r.err)["error"]["code"] == 188     # no vault in roster.yml yet


def test_add_from_vault_fills_address_and_user(life):
    r = ok(life.run("add-from-vault", "add", "lab-03", "--from-vault", "--auth", "bw:lab-03 ssh", "--group",
                    "ops", "--no-enroll", "-y", env=UNLOCKED))
    assert f"ip {LAB03}" in r.out and "user ops" in r.out and f"port {PORT}" in r.out
    r = ok(life.run("from-vault-list", "add", "--from-vault", "--json", "--all", env=UNLOCKED))
    names = sorted(i["name"] for i in r.json["items"])
    assert names == ["lab ops", "lab-02 spare"]


def test_add_from_vault_with_a_locked_vault(life):
    r = life.run("from-vault-locked", "add", "lab-09", "--from-vault", "--auth", "bw:lab ops", "--group", "ops",
                 "-y")
    assert r.code != 0


def test_hosts_lists_them(life):
    r = ok(life.run("hosts", "hosts"))
    lines = r.out.splitlines()
    assert lines[0].split()[:3] == ["NAME", "IP", "USER"]
    assert [x.split()[0] for x in lines[1:] if x.strip()] == ["lab-01", "lab-02", "lab-03"]
    r = ok(life.run("hosts-json", "hosts", "--json"))
    hosts = {h["name"]: h for h in r.json["hosts"]}
    assert hosts["lab-03"]["ip"] == LAB03 and hosts["lab-03"]["user"] == "ops"
    r = ok(life.run("hosts-one", "hosts", "lab-02"))
    assert LAB02 in r.out
    r = ok(life.run("hosts-long", "hosts", "--long"))
    r = ok(life.run("hosts-only", "hosts", "--only", "ops", "--json"))
    assert [h["name"] for h in r.json["hosts"]] == ["lab-03"]


# ---------------------------------------------------------------- setup over ssh

def test_check_before_setup_says_what_is_missing(life):
    r = life.run("check-before", "check", "lab-01")
    assert r.code != 0 and "host-key" in r.out


def test_setup_installs_the_key_and_records_host_keys(life, lab):
    r = ok(life.run("setup", "setup", env=UNLOCKED))
    assert "3 new" in r.out and "ok    lab-01" in r.out and "ok    lab-02" in r.out
    for name in ("lab-01", "lab-02"):
        lines = keys(lab, name)
        assert len(lines) == 1 and lines[0].endswith("roster-managed:e2e-box"), lines
    assert keys(lab, "lab-03", "ops") == []                     # enroll: false: password logins only
    known = "".join(t or "" for f, t in life.tree().items() if "known_hosts" in f)
    for addr in (LAB01, LAB02, LAB03):
        assert f"[{addr}]:{PORT}" in known
    assert (life.home / ".ssh" / "roster_ed25519").exists()
    snapshot(lab, life, "after-setup")


def test_setup_again_changes_nothing(life, lab):
    before = keys(lab, "lab-01")
    r = ok(life.run("setup-again", "setup", env=UNLOCKED))
    assert "already work" in r.out
    assert keys(lab, "lab-01") == before


# ---------------------------------------------------------------- the checks

def test_check_reaches_every_host(life):
    r = ok(life.run("check", "check", env=UNLOCKED))
    assert "3/3 hosts fully reachable" in r.out
    r = ok(life.run("check-json", "check", "--json", env=UNLOCKED))
    assert r.json


def test_check_host_walks_every_step(life):
    r = ok(life.run("check-host", "check", "lab-01"))
    steps = [x.split()[1] for x in r.out.splitlines() if x.strip()]
    assert steps[:2] == ["inventory", "ssh-config"] and steps[-1] == "auth"
    assert all(x.split()[0] in ("ok", "skip") for x in r.out.splitlines() if x.strip())
    r = ok(life.run("check-host-password", "check", "lab-03", env=UNLOCKED))
    assert "logged in as ops" in r.out


def test_check_host_with_a_locked_vault_says_so(life):
    r = life.run("check-host-locked", "check", "lab-03")
    assert r.code != 0


def test_check_unknown_host(life):
    r = life.run("check-unknown", "check", "nope-99")
    assert r.code != 0 and "nope-99" in r.out + r.err
    r = life.run("check-unknown-json", "check", "nope-99", "--json")
    assert r.code != 0


def test_check_box(life):
    r = ok(life.run("check-box", "check", "--box"))
    assert "no errors" in r.out
    r = ok(life.run("check-box-json", "check", "--box", "--json"))
    assert r.json


def test_check_auth(life):
    r = life.run("check-auth", "check", "--auth", env=UNLOCKED)
    assert r.code == 0, r.out + r.err


# ---------------------------------------------------------------- using the Hosts

def test_plain_ssh_through_rosters_config(life):
    for name in ("lab-01", "lab-02"):
        r = ok(life.ssh(f"ssh-{name}", name, "hostname"))
        assert r.out.strip() == name
    r = ok(life.ssh("ssh-whoami", "lab-01", "id -un"))
    assert r.out.strip() == "lab"


def test_run_on_a_password_only_host(life):
    r = ok(life.run("run-password", "run", "lab-03", "--", "hostname", env=UNLOCKED))
    assert r.out.strip() == "lab-03"
    r = ok(life.run("run-key", "run", "lab-01", "--", "id", "-un"))
    assert r.out.strip() == "lab"


def test_web_logs_in_with_the_services_credentials(life):
    text = life.read("work/roster.yml")
    url = f"http://{LAB01}:{world.HOSTS['lab-01'][1]}"
    service = (f"        services:\n          http: {{port: {world.HOSTS['lab-01'][1]}, url: \"{url}\", "
               "login: basic, user: web, auth: env:WEB_PW}\n")
    marker = "        title: Lab box 1\n"
    assert marker in text
    (life.home / "work" / "roster.yml").write_text(text.replace(marker, marker + service, 1))
    r = ok(life.run("web", "web", "lab-01", "http", "GET", "/api/status"))
    assert json.loads(r.out) == {"status": "ok"}
    r = life.run("web-no-password", "web", "lab-01", "http", "GET", "/api/status", env={"WEB_PW": None})
    assert r.code != 0 and "WEB_PW" in r.err


def test_vault_views(life):
    r = ok(life.run("vault-status", "vault", "status", env=UNLOCKED))
    assert "bw" in r.out
    r = ok(life.run("vault-list", "vault", "bw", "--", "list", "items", "--search", "lab", env=UNLOCKED))
    assert "lab-03 ssh" in r.out
    r = life.run("vault-write-refused", "vault", "bw", "--", "delete", "item", "e2e-0002", env=UNLOCKED)
    assert r.code != 0
    r = ok(life.run("vault-sync", "vault", "sync", env=UNLOCKED))


def test_vault_unlock_and_lock_on_a_terminal(life):
    session = life.home / ".config" / "roster" / "bw-session"
    session.parent.mkdir(parents=True, exist_ok=True)
    session.symlink_to(life.root / "elsewhere")                 # a link: never written over
    r = world.on_tty(life, "vault-unlock-link", ["vault", "unlock"], ["hunter2"])
    assert r.code != 0 and not (life.root / "elsewhere").exists(), r.out
    session.unlink()
    r = world.on_tty(life, "vault-unlock", ["vault", "unlock"], ["hunter2"])
    assert r.code == 0, r.out
    assert (life.home / ".config" / "roster" / "bw-session").exists()
    r = ok(life.run("check-host-saved-session", "check", "lab-03"))       # no BW_SESSION: the saved one
    r = life.run("vault-lock-fails", "vault", "lock", env={"FAKE_BW_LOCK_FAIL": "the server said no"})
    assert r.code != 0 and "the server said no" in r.out + r.err
    r = ok(life.run("vault-lock", "vault", "lock"))
    assert not (life.home / ".config" / "roster" / "bw-session").exists()


# ---------------------------------------------------------------- the Mesh between lab-01 and lab-02

def test_mesh_plan_apply_status(life, lab):
    text = life.read("work/roster.yml")
    (life.home / "work" / "roster.yml").write_text(text.replace("  lab:\n", "  lab:\n    mesh: true\n", 1))
    r = ok(life.run("mesh-status-before", "mesh", "status"))
    assert "out of date" in r.out
    r = ok(life.run("mesh-dry-run", "mesh", "--dry-run"))
    assert "lab-01 -> lab-02 key" in r.out and "dry run" in r.out
    assert not any("roster-mesh" in x for x in keys(lab, "lab-02"))
    r = ok(life.run("mesh-apply", "mesh", "-y"))
    assert "lab-01 -> lab-02 key      ok" in r.out
    assert any("roster-mesh:lab-01@e2e-box" in x for x in keys(lab, "lab-02"))
    assert any("roster-mesh:lab-02@e2e-box" in x for x in keys(lab, "lab-01"))
    r = ok(life.run("mesh-status", "mesh", "status", "--json"))
    assert r.json["out_of_date"] is False and r.json["members"] == ["lab-01", "lab-02"]
    r = ok(life.run("mesh-again", "mesh", "-y"))
    assert "nothing to change" in r.out
    snapshot(lab, life, "after-mesh")


def test_mesh_hosts_reach_each_other(life):
    r = ok(life.ssh("mesh-hop", "lab-01", "ssh -o BatchMode=yes lab-02 hostname"))
    assert r.out.strip() == "lab-02"
    r = ok(life.ssh("mesh-hop-back", "lab-02", "ssh -o BatchMode=yes lab-01 hostname"))
    assert r.out.strip() == "lab-01"


def test_mesh_cut_takes_a_host_out(life, lab):
    r = ok(life.run("mesh-cut", "mesh", "cut", "lab-02", "-y"))
    assert "cut lab-02" in r.out
    assert not any("roster-mesh:lab-02" in x for x in keys(lab, "lab-01"))
    r = life.ssh("mesh-hop-after-cut", "lab-02", "ssh -o BatchMode=yes lab-01 hostname")
    assert r.code != 0
    r = ok(life.run("mesh-leftovers", "mesh", "leftovers"))
    snapshot(lab, life, "after-cut")


# ---------------------------------------------------------------- the key's rotation, a scan, sync, revoke

def test_setup_rotate_replaces_the_key_everywhere(life, lab):
    old = (life.home / ".ssh" / "roster_ed25519.pub").read_text().split()[1]
    r = life.run("rotate", "setup", "--rotate", env=UNLOCKED)
    assert "Box key rotated on 2 Hosts, 0 failed, 0 pending" in r.out, r.out + r.err
    new = (life.home / ".ssh" / "roster_ed25519.pub").read_text().split()[1]
    assert new != old
    for name in ("lab-01", "lab-02"):
        box_keys = [x for x in keys(lab, name) if "roster-managed:" in x]
        assert len(box_keys) == 1 and new in box_keys[0] and old not in box_keys[0]
    r = ok(life.ssh("ssh-after-rotate", "lab-01", "true"))
    assert not (life.home / ".ssh" / "roster_ed25519.new").exists()
    snapshot(lab, life, "after-rotate")


def test_discover_scans_the_lab(life):
    net = f"{world.NET}.8/29"
    r = ok(life.run("discover", "discover", net, "--ports", PORT, "--builtin", "--no-ping", "--json"))
    found = {f["address"]: f for f in r.json["found"]}
    assert found[LAB01]["known"] == "lab-01" and found[LAB03]["known"] == "lab-03"
    assert "0 new, 3 already in roster.yml" in life.run("discover-text", "discover", net, "--ports", PORT,
                                                         "--builtin", "--no-ping").out


def test_discover_write_adds_unreviewed_hosts(life):
    # lab-03 taken out of roster.yml by hand, so the scan finds one new Host there
    path = life.home / "work" / "roster.yml"
    text = path.read_text()
    path.write_text(re.sub(r"(?m)^      lab-03:\n(?:        .*\n)*", "", text))
    assert "lab-03" not in path.read_text()
    net = f"{world.NET}.8/29"
    r = ok(life.run("discover-preview", "discover", net, "--ports", PORT, "--builtin", "--no-ping"))
    assert "1 new" in r.out and "nothing written" in r.out
    assert path.read_text() == re.sub(r"(?m)^      lab-03:\n(?:        .*\n)*", "", text)
    r = ok(life.run("discover-write", "discover", net, "--ports", PORT, "--builtin", "--no-ping", "--write",
                    "--group", "found"))
    r = ok(life.run("hosts-after-discover", "hosts", "--all", "--json"))
    found = [h for h in r.json["hosts"] if h["ip"] == LAB03]
    assert len(found) == 1 and found[0]["group"] == "found" and found[0]["reviewed"] is False, found


def test_sync_rewrites_the_ssh_config(life):
    (life.home / ".ssh" / "roster-inventories" / "lab").write_text("# emptied\n")
    r = ok(life.run("sync", "sync"))
    assert "Host lab-01" in (life.read(".ssh/roster-inventories/lab") or "")
    assert "ssh config" in r.out


def test_revoke_takes_the_key_off_every_host(life, lab):
    r = life.run("revoke", "revoke", "-y", env=UNLOCKED)
    assert "removed from" in r.out, r.out + r.err
    for name in ("lab-01", "lab-02"):
        assert not any("roster-managed:" in x for x in keys(lab, name))
    r = life.ssh("ssh-after-revoke", "lab-01", "true")
    assert r.code != 0
    snapshot(lab, life, "after-revoke")


def test_inv_remove_forgets_the_name(life, lab):
    ok(life.run("inv-remove", "inv", "remove", "lab"))
    snapshot(lab, life, "after-inv-remove")
    r = ok(life.run("inv-list-after", "inv", "list", "--json"))
    assert not any(i["name"] == "lab" for i in r.json["inventories"])
    assert (life.home / "work" / "roster.yml").exists()
