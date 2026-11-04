"""The Mesh (ticket 39, decision Q63): roster.yml's mesh: and links:, and `roster mesh` against stand-in Hosts
(tests/fakes/ssh with FAKE_HOSTS). Nothing here connects anywhere: each Host is a directory."""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import POSIX_SH, WINDOWS, stand_in_hosts

from roster import mesh
from roster.cli import main
from roster.config import load_config

# The stand-in Hosts run their side with sh (tests/fakes/ssh, FAKE_HOSTS; Git for Windows' sh on native Windows, ticket
# 63), and ESXi's datastore is a symlink.
pytestmark = stand_in_hosts

HOSTS = {"orion-2": "10.0.0.2", "orion-3": "10.0.0.3", "esx-02": "10.0.0.12", "sw-1": "10.0.0.20",
         "nas-1": "10.0.0.30", "db-9": "10.0.9.9", "new-1": "10.0.0.40", "jump-1": "10.0.5.1"}

CONFIG = """\
box_name: box
defaults:
  user: admin
groups:
  lab:
    mesh: true
    hosts:
      orion-2: 10.0.0.2
      orion-3: 10.0.0.3
      esx-02: { ip: 10.0.0.12, user: root }
      sw-1: { ip: 10.0.0.20, enroll: false, auth: prompt }
      new-1: { ip: 10.0.0.40, reviewed: false }
  storage:
    hosts:
      nas-1: 10.0.0.30
  far:
    hosts:
      db-9: 10.0.9.9
links:
  - { from: orion-2, to: storage }
  - { from: orion-3, to: db-9, both: true }
"""


@pytest.fixture(scope="module")
def host_key(tmp_path_factory):
    d = tmp_path_factory.mktemp("hk")
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(d / "k")], check=True)
    return (d / "k.pub").read_text().split()[1]


class Net:
    """The stand-in Hosts: one directory each under FAKE_HOSTS."""

    def __init__(self, root, cfg_path):
        self.root, self.cfg_path = root, cfg_path

    def host(self, name):
        return self.root / name

    @staticmethod
    def seen(path):
        """PATH as a stand-in Host's sh names it: as is, or on Windows as Git's sh does (C:\\x\\y is /c/x/y)."""
        if not WINDOWS:
            return str(path)
        p = Path(path).resolve().as_posix()
        return f"/{p[0].lower()}{p[2:]}" if p[1:2] == ":" else p

    def ak(self, name):
        d = self.host(name)
        p = d / "etc/ssh/keys-root/authorized_keys" if (d / "esxi").exists() else d / "home/.ssh/authorized_keys"
        return p.read_text() if p.exists() else ""

    def mesh_lines(self, name):
        return sorted(line for line in self.ak(name).splitlines() if " roster-mesh:" in line)

    def file(self, name, rel):
        """A file on Host NAME. On ESXi, with the paths in it as the Host itself sees them."""
        p = self.host(name) / rel
        if not p.exists():
            return None
        text = p.read_text()
        if (self.host(name) / "esxi").exists():
            for form in {str(self.host(name)), self.host(name).as_posix(), self.seen(self.host(name))}:
                text = text.replace(form, "")
        return text

    def down(self, name, is_down=True):
        f = self.host(name) / "down"
        f.touch() if is_down else f.unlink(missing_ok=True)

    def reboot(self, name):
        """ESXi rebuilds / and /etc from its boot image: only what it keeps (its /etc/ssh/keys-*, datastores) stays."""
        shutil.rmtree(self.host(name) / "home")
        (self.host(name) / "home").mkdir()

    def connections(self):
        f = self.root / "connections"
        return f.read_text().splitlines() if f.exists() else []

    def cfg(self):
        return load_config(self.cfg_path)

    def snapshot(self):
        return {p.relative_to(self.root).as_posix(): p.read_bytes() for p in sorted(self.root.rglob("*"))
                if p.is_file() and p.name != "connections"}


@pytest.fixture
def net(fakes, isolated, write_config, monkeypatch, host_key):
    for f in (fakes / "host").iterdir():
        f.chmod(0o755)
    root = isolated["home"].parent.resolve() / "hosts"        # Windows: its long name (no RUNNER~1), as the Host's sh says it
    for name in HOSTS:
        d = root / name
        (d / "home/.ssh").mkdir(parents=True)
        (d / "home/.ssh/authorized_keys").write_text(
            "ssh-ed25519 AAAAown own@laptop\nssh-ed25519 AAAAbox roster-managed:box\n")
        (d / "home/.ssh/config").write_text("Host *\n    ServerAliveInterval 60\n")
    esx = root / "esx-02"
    (esx / "esxi").touch()
    shutil.rmtree(esx / "home/.ssh")
    (esx / "etc/ssh/keys-root").mkdir(parents=True)
    (esx / "etc/ssh/keys-root/authorized_keys").write_text("ssh-ed25519 AAAAbox roster-managed:box\n")
    (esx / "vmfs/volumes/5f0e-uuid").mkdir(parents=True)
    if WINDOWS:     # a junction: Git's sh reads it as a symlink, and it needs no privilege (a symlink does on Windows)
        import _winapi
        _winapi.CreateJunction(str(esx / "vmfs/volumes/5f0e-uuid"), str(esx / "vmfs/volumes/datastore1"))
    else:
        (esx / "vmfs/volumes/datastore1").symlink_to("5f0e-uuid")
    (root / "orion-2/home/.claude").mkdir()
    (root / "orion-2/home/.claude/CLAUDE.md").write_text("# my notes\n")
    kh = isolated["home"] / ".ssh"
    kh.mkdir()
    (kh / "roster_known_hosts").write_text("".join(f"{ip} ssh-ed25519 {host_key}\n" for ip in HOSTS.values()))
    monkeypatch.setenv("FAKE_HOSTS", str(root))
    monkeypatch.setenv("FAKE_SH", POSIX_SH)
    return Net(root, write_config(CONFIG))


def key_line_of(net, src, dst_ip):
    d = "vmfs/volumes/5f0e-uuid/.roster-mesh" if (net.host(src) / "esxi").exists() else "home/.ssh/roster-mesh"
    pub = (net.host(src) / d / "id_ed25519.pub").read_text().split()
    return f'from="{dst_ip}",no-agent-forwarding,no-X11-forwarding {pub[0]} {pub[1]} roster-mesh:{src}@box'


# ---------------------------------------------------------------- inventory

def test_mesh_cascades_from_defaults_to_group_to_host(write_config):
    cfg = load_config(write_config("""\
defaults: { user: u, mesh: true }
groups:
  a: { hosts: { a1: 10.0.0.1, a2: { ip: 10.0.0.2, mesh: false } } }
  b: { mesh: false, hosts: { b1: 10.0.0.3, b2: { ip: 10.0.0.4, mesh: true } } }
  c: { hosts: { c1: 10.0.0.5, c2: { ip: 10.0.0.6, reviewed: false } } }
"""))
    assert {n: h["mesh"] for n, h in cfg["hosts"].items()} == {
        "a1": True, "a2": False, "b1": False, "b2": True, "c1": True, "c2": True}
    g = mesh.graph(cfg)
    assert [(x["from"], x["to"]) for x in g["links"]] == []          # every group has one meshed Host left
    assert g["excluded"] == {"a2": "mesh: false", "b1": "mesh: false", "c2": "not reviewed (reviewed: false)"}


def test_a_meshed_group_reaches_itself_both_ways_and_links_add_one_way_reach(net):
    g = mesh.graph(net.cfg())
    pairs = {(x["from"], x["to"]): x for x in g["links"]}
    lab = ["esx-02", "orion-2", "orion-3", "sw-1"]
    assert {p for p in pairs if p[0] in lab and p[1] in lab} == {(a, b) for a in lab for b in lab if a != b}
    assert ("orion-2", "nas-1") in pairs and ("nas-1", "orion-2") not in pairs       # one-way
    assert ("orion-3", "db-9") in pairs and ("db-9", "orion-3") in pairs             # both: true
    assert "new-1" not in {p for pair in pairs for p in pair}                        # unreviewed never joins
    assert pairs[("orion-2", "sw-1")]["kind"] == "password"
    assert pairs[("sw-1", "orion-2")]["skip"] == "password-source"
    assert g["sources"] == ["db-9", "esx-02", "orion-2", "orion-3"]
    assert g["visit"] == ["db-9", "esx-02", "nas-1", "orion-2", "orion-3"]
    assert mesh.reach(g)["orion-2"] == 4


@pytest.mark.parametrize("links, message", [
    ("[{from: lab, to: nope}]", "entry 1: to: 'nope' isn't a Host or a group"),
    ("[{from: a1, to: a1}]", "entry 1 links 'a1' to itself"),
    ("[{from: a1}]", "entry 1 must be a mapping with from: and to:"),
    ("[{from: a1, to: lab, hop: x}]", "entry 1 must be a mapping"),
    ("[{from: a1, to: a2, via: nope}]", "entry 1: via: 'nope' isn't a Host in roster.yml"),
    ("[{from: a1, to: a2, via: lab}]", "entry 1: via: 'lab' is a group: a Link goes through one Host"),
    ("[{from: a1, to: a2, via: a2}]", "entry 1: via: 'a2' is an end of the Link itself"),
    ("[{from: a1, to: a3, via: a2}, {from: a1, to: a3, via: a4}]",
     "entries 1 and 2 send a1 -> a3 through different Hosts (a2, a4)"),
    ("[{from: a1, to: lab, both: yes-please}]", "both: must be true or false"),
    ("{from: a1, to: lab}", "links: must be a list"),
])
def test_bad_links_are_refused_with_a_clean_error(write_config, links, message):
    p = write_config("defaults: {user: u}\ngroups:\n  lab: {hosts: {a1: 10.0.0.1, a2: 10.0.0.2, a3: 10.0.0.3, a4: 10.0.0.4}}\n"
                     f"links: {links}\n")
    with pytest.raises(SystemExit) as e:
        load_config(p)
    assert message in str(e.value)


def test_mesh_must_be_true_or_false(write_config):
    with pytest.raises(SystemExit) as e:
        load_config(write_config("groups:\n  lab: {mesh: 1, user: u, hosts: {a1: 10.0.0.1}}\n"))
    assert "mesh: must be true or false" in str(e.value)


# ---------------------------------------------------------------- plan

def test_dry_run_shows_the_plan_and_changes_nothing(net, capsys):
    before = net.snapshot()
    assert main(["mesh", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert net.snapshot() == before
    assert "orion-2 -> sw-1" in out and "password" in out
    assert "orion-2: make key" in out
    assert "nas-1: add key from orion-2" in out
    assert "left out: new-1 (not reviewed" in out
    assert "dry run: nothing was changed" in out


def test_dry_run_json_is_mesh_plans_result(net, capsys):
    """`roster mesh --dry-run --json` (T107): mesh.plan's Mesh result with `version`, and nothing else on stdout."""
    before = net.snapshot()
    assert main(["mesh", "--dry-run", "--json"]) == 0
    out, err = capsys.readouterr()
    assert net.snapshot() == before and err == ""
    doc = json.loads(out)
    assert doc["version"] == 1 and doc["applied"] is False
    assert doc == {"version": 1, **mesh.run(net.cfg(), apply=False)}
    rows = {h["host"]: h for h in doc["hosts"]}
    assert rows["orion-2"]["status"] == "would-change" and "make key" in rows["orion-2"]["changes"]
    assert doc["pending"] == {}


def test_dry_run_json_exits_1_with_a_host_pending(net, capsys):
    net.down("nas-1")
    assert main(["mesh", "--dry-run", "--json"]) == 1
    doc = json.loads(capsys.readouterr().out)
    assert list(doc["pending"]) == ["nas-1"]


def test_dry_run_json_refusal_is_the_json_error(net, capsys):
    assert main(["mesh", "--dry-run", "--rotate", "nas-1", "--json"]) == 1
    out, err = capsys.readouterr()
    error = json.loads(err)["error"]
    assert out == "" and error["code"] == 110 and "nas-1" in error["message"] and error["fix"]


def test_mesh_json_needs_status_or_dry_run(net, capsys):
    with pytest.raises(SystemExit) as e:
        main(["mesh", "--json"])
    out, err = capsys.readouterr()
    assert e.value.code == 2 and out == ""
    assert "--dry-run" in json.loads(err)["error"]["message"]


def test_one_connection_at_a_time(net):
    mesh.run(net.cfg(), apply=True)
    log = [x for x in net.connections() if not x.startswith("down")]
    assert log and all(a.split()[0] == "start" and b == "end " + a.split()[1] for a, b in zip(log[::2], log[1::2], strict=True))


# ---------------------------------------------------------------- apply

def test_apply_installs_tagged_keys_and_writes_each_sources_files(net):
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    o2 = net.host("orion-2") / "home/.ssh/roster-mesh"
    assert (o2 / "id_ed25519").exists()                              # made there; roster never reads it
    assert net.mesh_lines("nas-1") == [key_line_of(net, "orion-2", "10.0.0.2")]
    assert key_line_of(net, "orion-3", "10.0.0.3") in net.mesh_lines("orion-2")
    assert "ssh-ed25519 AAAAown own@laptop" in net.ak("orion-2")       # everything else kept
    assert "roster-managed:box" in net.ak("orion-2")
    config = (o2 / "config").read_text()
    assert "Host nas-1\n    HostName 10.0.0.30\n    User admin" in config
    assert "Host esx-02\n    HostName 10.0.0.12\n    User root" in config        # the peer's own user
    assert "Host sw-1" in config and "PubkeyAuthentication no" in config.split("Host sw-1")[1]
    assert "StrictHostKeyChecking yes" in config
    assert (o2 / "known_hosts").read_text().count("ssh-ed25519") == 4
    main_config = net.file("orion-2", "home/.ssh/config")
    assert main_config.splitlines()[:2] == [mesh.MARK, f"Include {net.seen(o2)}/config"]
    assert main_config.endswith("Host *\n    ServerAliveInterval 60\n")
    md = net.file("orion-2", "home/ROSTER.md")
    assert "| sw-1 | admin@10.0.0.20:22 | password |" in md and "ask the user to log in" in md
    assert "db-9" not in md
    assert net.file("orion-2", "home/.claude/CLAUDE.md") == "# my notes\n@~/ROSTER.md\n"
    assert net.file("orion-3", "home/.claude/CLAUDE.md") is None     # no Claude there: nothing to import from
    assert net.mesh_lines("sw-1") == []                              # a password peer gets no key


def test_esxi_keeps_its_key_on_a_datastore_and_takes_keys_in_etc_ssh(net):
    mesh.run(net.cfg(), apply=True)
    esx = net.host("esx-02")
    assert (esx / "vmfs/volumes/5f0e-uuid/.roster-mesh/id_ed25519").exists()
    assert key_line_of(net, "orion-2", "10.0.0.2") in net.mesh_lines("esx-02")
    assert "roster-managed:box" in net.ak("esx-02")
    config = net.file("esx-02", "vmfs/volumes/5f0e-uuid/.roster-mesh/config")
    assert "IdentityFile /vmfs/volumes/5f0e-uuid/.roster-mesh/id_ed25519" in config
    md = net.file("esx-02", "vmfs/volumes/5f0e-uuid/.roster-mesh/ROSTER.md")
    assert net.file("esx-02", "home/.ssh/config").splitlines()[1] == \
        "Include /vmfs/volumes/5f0e-uuid/.roster-mesh/config"
    assert "ssh -F /vmfs/volumes/5f0e-uuid/.roster-mesh/config <name>" in md


@pytest.mark.skipif(WINDOWS, reason="NTFS has no mode bits to keep")
def test_a_new_authorized_keys_on_esxi_gets_the_sticky_bit_so_it_survives_a_reboot(net):
    net.cfg_path.write_text(CONFIG.replace("esx-02: { ip: 10.0.0.12, user: root }", "esx-02: { ip: 10.0.0.12, user: ops }"))
    mesh.run(net.cfg(), apply=True)
    ak = net.host("esx-02") / "etc/ssh/keys-ops/authorized_keys"
    assert "roster-mesh:orion-2" in ak.read_text()
    assert ak.stat().st_mode & 0o7777 == 0o1600                      # as ESXi's own keys file is
    root = net.host("esx-02") / "etc/ssh/keys-root/authorized_keys"
    assert root.stat().st_mode & 0o1000 == 0                         # an existing file keeps its own mode


def test_applying_twice_changes_nothing_and_says_already_in_the_mesh(net, capsys):
    mesh.run(net.cfg(), apply=True)
    before = net.snapshot()
    assert main(["mesh"]) == 0
    assert net.snapshot() == before
    assert "already in the mesh" in capsys.readouterr().out


def test_an_esxi_reboot_is_drift_that_check_reports_and_apply_repairs(net, capsys):
    mesh.run(net.cfg(), apply=True)
    net.reboot("esx-02")
    lines = net.mesh_lines("orion-2")
    assert key_line_of(net, "esx-02", "10.0.0.12").split()[1] in "\n".join(lines)   # its key survived the reboot
    main(["check"])
    out = capsys.readouterr().out
    assert "mesh drift" in out and "esx-02: write Include in ~/.ssh/config" in out
    r = mesh.run(net.cfg(), apply=True)
    assert [h["changes"] for h in r["hosts"] if h["host"] == "esx-02"] == [["write Include in ~/.ssh/config"]]
    assert mesh.run(net.cfg())["already"]


# ---------------------------------------------------------------- mesh_dir: where a source keeps its files (T58)

def with_mesh_dir(net, path, host="esx-02"):
    line = {"esx-02": "esx-02: { ip: 10.0.0.12, user: root }", "orion-2": "orion-2: 10.0.0.2"}[host]
    new = line.replace(" }", f", mesh_dir: {path} }}") if "{" in line else f"{host}: {{ ip: 10.0.0.2, mesh_dir: {path} }}"
    net.cfg_path.write_text(CONFIG.replace(line, new))


def no_datastore(net):
    """esx-02 has no datastore roster would pick: its only volume isn't a named one (no symlink to it)."""
    (net.host("esx-02") / "vmfs/volumes/datastore1").unlink()


def test_an_esxi_without_a_suitable_datastore_is_pending_without_mesh_dir(net):
    no_datastore(net)
    r = mesh.run(net.cfg(), apply=True)
    assert "no datastore" in r["pending"]["esx-02"]


def test_mesh_dir_puts_an_esxi_sources_files_where_it_says(net):
    no_datastore(net)
    with_mesh_dir(net, "/vmfs/volumes/5f0e-uuid/mesh")
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    d = "vmfs/volumes/5f0e-uuid/mesh"
    assert (net.host("esx-02") / d / "id_ed25519").exists()
    assert net.file("esx-02", "home/.ssh/config").splitlines()[1] == f"Include /{d}/config"
    assert f"IdentityFile /{d}/id_ed25519" in net.file("esx-02", f"{d}/config")
    assert f"ssh -F /{d}/config <name>" in net.file("esx-02", f"{d}/ROSTER.md")
    assert any("roster-mesh:esx-02" in x for x in net.mesh_lines("orion-2"))
    assert mesh.run(net.cfg())["already"]


def test_mesh_dir_drift_is_reported_by_check(net, capsys):
    no_datastore(net)
    with_mesh_dir(net, "/vmfs/volumes/5f0e-uuid/mesh")
    mesh.run(net.cfg(), apply=True)
    (net.host("esx-02") / "vmfs/volumes/5f0e-uuid/mesh/config").write_text("edited by hand\n")
    assert main(["check"]) == 1
    assert "esx-02: write config" in capsys.readouterr().out


def test_mesh_dir_works_on_linux_too_and_cascades_from_its_group(net):
    d = net.host("orion-2") / "srv/mesh"
    (net.host("orion-2") / "srv").mkdir()
    net.cfg_path.write_text(CONFIG.replace("    mesh: true\n", f"    mesh: true\n    mesh_dir: {net.seen(d)}\n", 1).replace(
        "esx-02: { ip: 10.0.0.12, user: root }", "esx-02: { ip: 10.0.0.12, user: root, mesh_dir: null }"))
    cfg = net.cfg()
    assert cfg["mesh_dirs"]["orion-2"] == net.seen(d) and "esx-02" not in cfg["mesh_dirs"]
    assert mesh.run(cfg, apply=True)["pending"] == {}
    assert (d / "id_ed25519").exists() and not (net.host("orion-2") / "home/.ssh/roster-mesh").exists()
    assert f"Include {net.seen(d)}/config" in net.file("orion-2", "home/.ssh/config")


@pytest.mark.parametrize("value, message", [
    ("roster-mesh", "mesh_dir: must be an absolute path"),
    ("'/vmfs/volumes/my store/m'", "mesh_dir: must be an absolute path"),
    ("/", "mesh_dir: must be an absolute path"),
    ("/vmfs/volumes/../etc", "mesh_dir: must be an absolute path"),
])
def test_a_bad_mesh_dir_is_refused_when_roster_yml_loads(write_config, value, message):
    with pytest.raises(SystemExit) as e:
        load_config(write_config(f"defaults: {{user: u}}\ngroups:\n  lab:\n    hosts:\n      a1: {{ip: 10.0.0.1, mesh_dir: {value}}}\n"))
    assert message in str(e.value) and "a1" in str(e.value)


def test_an_esxi_mesh_dir_off_a_datastore_is_refused_on_the_host(net):
    with_mesh_dir(net, "/opt/mesh")
    r = mesh.run(net.cfg(), apply=True)
    assert "mesh_dir /opt/mesh isn't on a datastore" in r["pending"]["esx-02"]


def test_a_mesh_dir_whose_parent_is_missing_is_refused_on_the_host(net):
    with_mesh_dir(net, "/vmfs/volumes/nope/mesh")
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"]["esx-02"] == "mesh_dir /vmfs/volumes/nope/mesh: /vmfs/volumes/nope isn't there"


def test_a_mesh_dir_holding_files_that_are_not_rosters_is_refused_and_left_alone(net):
    d = net.host("orion-2") / "home/.ssh"
    with_mesh_dir(net, net.seen(d), host="orion-2")
    (d / "id_ed25519").write_text("my own key\n")
    before = net.snapshot()
    r = mesh.run(net.cfg(), apply=True)
    assert "holds a" in r["pending"]["orion-2"] and "isn't roster's" in r["pending"]["orion-2"]
    assert (d / "id_ed25519").read_text() == "my own key\n"
    assert net.file("orion-2", "home/.ssh/config") == before["orion-2/home/.ssh/config"].decode()
    net.cfg_path.write_text(CONFIG.replace("    mesh: true\n", "").split("links:")[0]
                            .replace("orion-2: 10.0.0.2", f"orion-2: {{ ip: 10.0.0.2, mesh_dir: {net.seen(d)} }}"))
    mesh.cut(net.cfg(), "orion-2")                                    # removing never touches what isn't roster's
    assert (d / "id_ed25519").read_text() == "my own key\n" and (d / "config").exists()


def test_moving_to_a_mesh_dir_warns_about_the_old_one(net):
    mesh.run(net.cfg(), apply=True)
    no_datastore(net)
    (net.host("esx-02") / "vmfs/volumes/data2").mkdir()
    with_mesh_dir(net, "/vmfs/volumes/data2/mesh")
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    assert any(w.startswith("esx-02: /vmfs/volumes/5f0e-uuid/.roster-mesh holds an earlier Mesh key") for w in r["warnings"])


def test_removing_a_mesh_dir_warns_about_it_and_drops_its_include(net):
    d = net.host("orion-2") / "srv/mesh"
    (net.host("orion-2") / "srv").mkdir()
    with_mesh_dir(net, net.seen(d), host="orion-2")
    mesh.run(net.cfg(), apply=True)
    net.cfg_path.write_text(CONFIG)
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    assert [w for w in r["warnings"] if w.startswith("orion-2:")] == [
        f"orion-2: {net.seen(d)} holds an earlier Mesh key that roster no longer uses (mesh_dir: changed), so delete it by hand"]
    config = net.file("orion-2", "home/.ssh/config")
    assert f"Include {net.seen(d)}/config" not in config and config.count("Include ") == 1
    assert (d / "id_ed25519").exists()                      # never removed by roster
    assert mesh.run(net.cfg())["already"]


def test_moving_from_one_mesh_dir_to_another_warns_about_the_first(net):
    a, b = net.host("orion-2") / "srv/a", net.host("orion-2") / "srv/b"
    (net.host("orion-2") / "srv").mkdir()
    with_mesh_dir(net, net.seen(a), host="orion-2")
    mesh.run(net.cfg(), apply=True)
    with_mesh_dir(net, net.seen(b), host="orion-2")
    r = mesh.run(net.cfg(), apply=True)
    assert any(w.startswith(f"orion-2: {net.seen(a)} holds an earlier Mesh key") for w in r["warnings"])
    assert net.file("orion-2", "home/.ssh/config").count("Include ") == 1


def back_to_the_default_directory(net):
    """orion-2's default directory still holds the key from before a mesh_dir: (roster warned about it then);
    roster.yml then drops the mesh_dir:. Returns (the default directory, the mesh_dir:, the old public key)."""
    old = net.host("orion-2") / "home/.ssh/roster-mesh"
    mesh.run(net.cfg(), apply=True)
    first = (old / "id_ed25519.pub").read_text()
    d = net.host("orion-2") / "srv/mesh"
    (net.host("orion-2") / "srv").mkdir()
    with_mesh_dir(net, net.seen(d), host="orion-2")
    mesh.run(net.cfg(), apply=True)
    assert (old / "id_ed25519").exists()                    # warned about, never removed
    net.cfg_path.write_text(CONFIG)
    return old, d, first


OLD_KEY = ("orion-2: {old} still holds an older Mesh key from before mesh_dir: changed, and roster uses it again: "
           "run roster mesh --rotate orion-2 to replace it")


def test_back_to_the_default_directory_roster_warns_about_the_old_key_and_leaves_it(net):
    old, d, first = back_to_the_default_directory(net)
    for _ in range(2):                                      # a plan changes nothing, however often
        plan = mesh.run(net.cfg())
        assert OLD_KEY.format(old=net.seen(old)) in plan["warnings"]
        assert "replace key" not in next(h for h in plan["hosts"] if h["host"] == "orion-2")["changes"]
        assert (old / "id_ed25519.pub").read_text() == first
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    assert OLD_KEY.format(old=net.seen(old)) in r["warnings"]
    assert any(w.startswith(f"orion-2: {net.seen(d)} holds an earlier Mesh key") for w in r["warnings"])
    assert (old / "id_ed25519.pub").read_text() == first    # left alone: the owner's call
    again = mesh.run(net.cfg())                             # the Include names it now: nothing more to say
    assert not any("older Mesh key" in w for w in again["warnings"]) and again["already"]


def test_back_to_the_default_directory_after_deleting_the_old_one_says_nothing_more(net):
    import shutil
    old, d, first = back_to_the_default_directory(net)
    shutil.rmtree(d)                                        # as roster's warning said to
    plan = mesh.run(net.cfg())
    assert not any("older Mesh key" in w for w in plan["warnings"])
    assert "replace key" not in next(h for h in plan["hosts"] if h["host"] == "orion-2")["changes"]
    assert (old / "id_ed25519.pub").read_text() == first


LINES = {"orion-2": "orion-2: 10.0.0.2", "esx-02": "esx-02: { ip: 10.0.0.12, user: root }"}
CUSTOM = {"orion-2": "srv/mesh", "esx-02": "vmfs/volumes/data2/mesh"}      # a mesh_dir: on each, from its root
DEFAULT = {"orion-2": "home/.ssh/roster-mesh", "esx-02": "vmfs/volumes/5f0e-uuid/.roster-mesh"}


def as_the_host_sees_it(net, host, rel):
    return f"/{rel}" if (net.host(host) / "esxi").exists() else net.seen(net.host(host) / rel)


def leaving_the_mesh(net, host, mesh_dir=None):
    """roster.yml with HOST no longer a source (mesh: false, and orion-2's Link gone), with MESH_DIR or none."""
    extra = f", mesh_dir: {mesh_dir}" if mesh_dir else ""
    ip = HOSTS[host]
    line = LINES[host].replace(" }", f", mesh: false{extra} }}") if "{" in LINES[host] else \
        f"{host}: {{ ip: {ip}, mesh: false{extra} }}"
    net.cfg_path.write_text(CONFIG.replace(LINES[host], line).replace("  - { from: orion-2, to: storage }\n", ""))


def ssh_config_before(net, host):
    p = net.host(host) / "home/.ssh/config"
    return p.read_text() if p.exists() else None


@pytest.mark.parametrize("host", ["orion-2", "esx-02"])
def test_a_source_leaving_the_mesh_and_its_mesh_dir_at_once_warns_about_that_dir_and_drops_its_include(net, host):
    (net.host(host) / CUSTOM[host]).parent.mkdir(parents=True, exist_ok=True)
    d = as_the_host_sees_it(net, host, CUSTOM[host])
    config = ssh_config_before(net, host)
    with_mesh_dir(net, d, host=host)
    assert mesh.run(net.cfg(), apply=True)["pending"] == {}
    leaving_the_mesh(net, host)
    plan = mesh.run(net.cfg())
    assert f"{host}: {d} holds an earlier Mesh key" in " ".join(plan["warnings"])
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    assert [w for w in r["warnings"] if w.startswith(f"{host}:")] == [
        f"{host}: {d} holds an earlier Mesh key that roster no longer uses (mesh_dir: changed), so delete it by hand"]
    assert (net.host(host) / CUSTOM[host] / "id_ed25519").exists()          # never removed by roster
    assert ssh_config_before(net, host) == config                         # the Include and roster's mark are gone
    assert not (net.host(host) / DEFAULT[host]).exists()                  # roster's own pick was never in use
    assert mesh.run(net.cfg())["already"]


@pytest.mark.parametrize("host", ["orion-2", "esx-02"])
def test_a_source_leaving_the_mesh_as_it_gains_a_mesh_dir_removes_rosters_own_directory(net, host):
    (net.host(host) / CUSTOM[host]).parent.mkdir(parents=True, exist_ok=True)
    d = as_the_host_sees_it(net, host, CUSTOM[host])
    config = ssh_config_before(net, host)
    assert mesh.run(net.cfg(), apply=True)["pending"] == {}
    assert (net.host(host) / DEFAULT[host] / "id_ed25519").exists()
    leaving_the_mesh(net, host, mesh_dir=d)
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    assert not [w for w in r["warnings"] if w.startswith(f"{host}:")]
    assert not (net.host(host) / DEFAULT[host]).exists()                  # roster's own pick: roster removes it
    assert not (net.host(host) / CUSTOM[host]).exists()
    assert ssh_config_before(net, host) == config
    assert mesh.run(net.cfg())["already"]


def test_unreachable_links_are_reported_and_not_written(net, capsys):
    (net.host("orion-3") / "blocked").write_text("10.0.9.9:22\n")
    r = mesh.run(net.cfg(), apply=True)
    link = next(x for x in r["links"] if (x["from"], x["to"]) == ("orion-3", "db-9"))
    assert link["status"] == "unreachable" and link["why"] == "orion-3 can't reach 10.0.9.9:22"
    assert "Host db-9" not in net.file("orion-3", "home/.ssh/roster-mesh/config")
    assert not any("roster-mesh:orion-3" in x for x in net.mesh_lines("db-9"))
    assert any("roster-mesh:db-9" in x for x in net.mesh_lines("orion-3"))     # the other way works


# ---------------------------------------------------------------- via: a Link through a jump Host (T57)

VIA = CONFIG.replace("      db-9: 10.0.9.9\n", "      db-9: 10.0.9.9\n      jump-1: 10.0.5.1\n").replace(
    "  - { from: orion-3, to: db-9, both: true }\n",
    "  - { from: orion-3, to: jump-1 }\n  - { from: orion-3, to: db-9, via: jump-1 }\n")


def test_a_link_via_a_jump_host_goes_through_it_end_to_end(net, capsys):
    net.cfg_path.write_text(VIA)
    (net.host("orion-3") / "blocked").write_text("10.0.9.9:22\n")       # orion-3 can't reach db-9 itself
    assert main(["mesh", "--dry-run"]) == 0
    assert "orion-3 -> db-9 via jump-1" in capsys.readouterr().out
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    link = next(x for x in r["links"] if (x["from"], x["to"]) == ("orion-3", "db-9"))
    assert link["via"] == "jump-1" and link["status"] == "ok"
    config = net.file("orion-3", "home/.ssh/roster-mesh/config")
    assert "Host db-9\n    HostName 10.0.9.9\n    User admin\n    Port 22\n    ProxyJump jump-1\n" in config
    assert "Host jump-1\n    HostName 10.0.5.1\n" in config and "ProxyJump" not in config.split("Host jump-1")[1]
    assert net.mesh_lines("db-9") == [key_line_of(net, "orion-3", "10.0.5.1")]      # the address db-9 sees
    assert net.mesh_lines("jump-1") == [key_line_of(net, "orion-3", "10.0.0.3")]
    assert "| db-9 | admin@10.0.9.9:22 via jump-1 | key |" in net.file("orion-3", "home/ROSTER.md")
    assert mesh.run(net.cfg())["already"]


def test_seen_as_adds_a_jump_hosts_other_addresses_to_from(net):
    net.cfg_path.write_text(VIA.replace("jump-1: 10.0.5.1", "jump-1: { ip: 10.0.5.1, seen_as: 10.0.9.1 }"))
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    line = key_line_of(net, "orion-3", "10.0.5.1,10.0.9.1")              # db-9 sees jump-1 on its own network
    assert net.mesh_lines("db-9") == [line]
    assert mesh.run(net.cfg())["already"]


def test_seen_as_works_for_a_direct_source_and_takes_a_list(net):
    net.cfg_path.write_text(CONFIG.replace("orion-3: 10.0.0.3", "orion-3: { ip: 10.0.0.3, seen_as: [192.0.2.3, 10.0.8.0/24] }"))
    mesh.run(net.cfg(), apply=True)
    assert key_line_of(net, "orion-3", "10.0.0.3,192.0.2.3,10.0.8.0/24") in net.mesh_lines("db-9")


@pytest.mark.parametrize("entry, message", [
    ("a1: {ip: 10.0.0.1, seen_as: nope}", "host 'a1': seen_as: must be IP addresses"),
    ("a1: {ip: 10.0.0.1, seen_as: ['10.0.0.2,10.0.0.3']}", "host 'a1': seen_as: must be IP addresses"),
])
def test_a_bad_seen_as_is_refused_when_roster_yml_loads(write_config, entry, message):
    with pytest.raises(SystemExit) as e:
        load_config(write_config(f"defaults: {{user: u}}\ngroups:\n  lab:\n    hosts:\n      {entry}\n"))
    assert message in str(e.value)


def test_seen_as_belongs_to_a_host_not_a_group(write_config):
    with pytest.raises(SystemExit) as e:
        load_config(write_config("defaults: {user: u}\ngroups:\n  lab:\n    seen_as: 10.0.0.9\n    hosts:\n      a1: 10.0.0.1\n"))
    assert "seen_as: goes on a Host" in str(e.value)


def test_a_seen_as_change_puts_the_mesh_out_of_date(write_config):
    path = write_config(CONFIG)
    before = mesh.digest(load_config(path))
    path.write_text(CONFIG.replace("orion-2: 10.0.0.2", "orion-2: { ip: 10.0.0.2, seen_as: 10.0.7.2 }"))
    assert mesh.digest(load_config(path)) != before


def test_via_goes_both_ways_and_wins_over_the_same_pair_without_it(net):
    net.cfg_path.write_text(VIA.replace(", via: jump-1 }", ", via: jump-1, both: true }") + "  - { from: orion-2, to: orion-3, via: nas-1 }\n")
    pairs = {(x["from"], x["to"]): x.get("via") for x in mesh.graph(net.cfg())["links"]}
    assert pairs[("orion-3", "db-9")] == pairs[("db-9", "orion-3")] == "jump-1"
    assert pairs[("orion-2", "orion-3")] == "nas-1"                  # lab's mesh: true gave it without a hop
    assert pairs[("orion-3", "orion-2")] is None


def test_the_hop_is_tested_from_the_jump_host(net):
    net.cfg_path.write_text(VIA)
    (net.host("jump-1") / "blocked").write_text("10.0.9.9:22\n")
    r = mesh.run(net.cfg(), apply=True)
    link = next(x for x in r["links"] if (x["from"], x["to"]) == ("orion-3", "db-9"))
    assert link["status"] == "unreachable" and link["why"] == "jump-1 can't reach 10.0.9.9:22 (orion-3's hop to db-9)"
    assert net.mesh_lines("db-9") == []
    assert "Host db-9" not in net.file("orion-3", "home/.ssh/roster-mesh/config")


def test_a_jump_host_the_source_does_not_reach_is_refused(net, capsys):
    net.cfg_path.write_text(VIA.replace("  - { from: orion-3, to: jump-1 }\n", ""))
    r = mesh.run(net.cfg(), apply=True)
    link = next(x for x in r["links"] if (x["from"], x["to"]) == ("orion-3", "db-9"))
    assert link["status"] == "no-via"
    assert link["why"] == "orion-3 has no Link to jump-1, its hop to db-9 (add { from: orion-3, to: jump-1 })"
    assert net.mesh_lines("db-9") == []
    assert main(["check"]) == 1
    assert "link orion-3 -> db-9: orion-3 has no Link to jump-1" in capsys.readouterr().out


def test_a_down_jump_host_leaves_the_link_pending_and_keeps_its_key(net):
    net.cfg_path.write_text(VIA)
    mesh.run(net.cfg(), apply=True)
    before = net.mesh_lines("db-9")
    net.down("jump-1")
    r = mesh.run(net.cfg(), apply=True)
    link = next(x for x in r["links"] if (x["from"], x["to"]) == ("orion-3", "db-9"))
    assert link["status"] == "pending" and "jump-1" in r["pending"]
    assert net.mesh_lines("db-9") == before


def test_removing_or_cutting_a_via_link_cleans_it_up(net):
    net.cfg_path.write_text(VIA)
    mesh.run(net.cfg(), apply=True)
    net.cfg_path.write_text(VIA.replace("  - { from: orion-3, to: db-9, via: jump-1 }\n", ""))
    r = mesh.run(net.cfg(), apply=True)
    assert next(h for h in r["hosts"] if h["host"] == "db-9")["changes"] == ["remove key from orion-3"]
    assert net.mesh_lines("db-9") == [] and "ProxyJump" not in net.file("orion-3", "home/.ssh/roster-mesh/config")
    net.cfg_path.write_text(VIA)
    mesh.run(net.cfg(), apply=True)
    assert mesh.cut(net.cfg(), "orion-3")["pending"] == {}
    assert net.mesh_lines("db-9") == [] and net.mesh_lines("jump-1") == []


def test_moving_a_link_onto_a_jump_host_replaces_the_peers_key_line(net):
    net.cfg_path.write_text(VIA.replace(", via: jump-1", ""))
    mesh.run(net.cfg(), apply=True)
    assert net.mesh_lines("db-9") == [key_line_of(net, "orion-3", "10.0.0.3")]
    net.cfg_path.write_text(VIA)
    assert mesh.status(net.cfg())["out_of_date"]
    r = mesh.run(net.cfg(), apply=True)
    assert next(h for h in r["hosts"] if h["host"] == "db-9")["changes"] == ["replace key from orion-3"]
    assert net.mesh_lines("db-9") == [key_line_of(net, "orion-3", "10.0.5.1")]


def test_a_peer_without_a_recorded_host_key_is_left_out(net, isolated):
    kh = isolated["home"] / ".ssh/roster_known_hosts"
    kh.write_text("".join(x + "\n" for x in kh.read_text().splitlines() if not x.startswith("10.0.0.30 ")))
    r = mesh.run(net.cfg(), apply=True)
    link = next(x for x in r["links"] if x["to"] == "nas-1")
    assert link["status"] == "no-host-key" and "roster setup --only nas-1" in link["why"]
    assert net.mesh_lines("nas-1") == []


def test_a_down_host_is_pending_and_finished_when_it_is_back(net, capsys):
    net.down("nas-1")
    r = mesh.run(net.cfg(), apply=True)
    assert list(r["pending"]) == ["nas-1"]
    assert mesh.status(net.cfg())["pending"] == {"nas-1": r["pending"]["nas-1"]}
    main(["mesh", "status"])
    assert "pending on 1 Host: nas-1" in capsys.readouterr().out
    net.down("nas-1", False)
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {} and net.mesh_lines("nas-1") == [key_line_of(net, "orion-2", "10.0.0.2")]
    assert mesh.status(net.cfg())["pending"] == {}


def test_a_down_source_keeps_its_keys_on_peers(net):
    mesh.run(net.cfg(), apply=True)
    before = net.mesh_lines("nas-1")
    net.down("orion-2")
    r = mesh.run(net.cfg(), apply=True)
    assert "orion-2" in r["pending"]
    assert net.mesh_lines("nas-1") == before


def interrupt(tmp_path, monkeypatch):
    """From now on, every Host's run dies part way through writing a file on the Host (a timeout, a deadline, a dropped link):
    a stand-in `cat` that writes one line to a file under the Host, then kills the shell running roster's script."""
    if not os.path.exists("/proc/self/fd/1"):
        pytest.skip("needs /proc to see where cat writes")
    d = tmp_path / "interrupt"
    d.mkdir()
    (d / "cat").write_text(f"""#!/bin/sh
out=$(readlink /proc/$$/fd/1)
case "$out" in
  "$FAKE_HOST_ROOT"/*) {shutil.which("cat")} "$@" | head -n 1; kill -9 $PPID; exit 1;;
esac
exec {shutil.which("cat")} "$@"
""")
    (d / "cat").chmod(0o755)
    monkeypatch.setenv("PATH", f"{d}{os.pathsep}{os.environ['PATH']}")


@pytest.fixture
def interrupted(tmp_path, monkeypatch):
    interrupt(tmp_path, monkeypatch)


def assert_no_file_was_damaged(net, before):
    """Each file is as it was, or (one roster owns, which a cut removes whole) gone; authorized_keys always there."""
    after = net.snapshot()
    for path, data in before.items():
        if "/roster-mesh/" in path and path not in after:
            continue
        assert after.get(path) == data, f"{path} was damaged by an interrupted run"


def test_an_interrupted_apply_never_leaves_a_file_half_written(net, interrupted):
    before = net.snapshot()
    r = mesh.run(net.cfg(), apply=True)
    assert set(r["pending"]) == set(mesh.graph(net.cfg())["visit"])
    assert_no_file_was_damaged(net, before)                      # the Box's key and the user's keys included


def test_an_interrupted_cut_never_leaves_a_file_half_written(net, monkeypatch, tmp_path):
    mesh.run(net.cfg(), apply=True)
    before = net.snapshot()
    interrupt(tmp_path, monkeypatch)
    r = mesh.cut(net.cfg(), "orion-2")
    assert {"orion-2", "orion-3", "esx-02", "nas-1"} <= set(r["pending"])
    assert_no_file_was_damaged(net, before)


@pytest.mark.skipif(WINDOWS, reason="NTFS has no mode bits to keep")
def test_rewriting_a_file_keeps_its_mode(net):
    ak = net.host("orion-2") / "home/.ssh/authorized_keys"
    ak.chmod(0o640)
    mesh.run(net.cfg(), apply=True)
    assert "roster-mesh:orion-3" in ak.read_text()
    assert ak.stat().st_mode & 0o7777 == 0o640
    assert not list(net.host("orion-2").rglob("*.roster-new"))


def test_every_rewrite_on_a_host_is_relabelled_after_the_move():
    h = {"name": "orion-2", "ssh": {"user": "admin"}}
    script = mesh.write_script(h, "apply", {}, [], set(), "box")
    body = script[script.index("replace() {"):script.index("put() {")]
    mv = body.index('mv -f "$n" "$f"')
    assert body.index('chcon --reference="$f" "$n"') < mv < body.index('restorecon -F "$f"')
    assert "replace" in mesh.cut_script(h, "orion-3", False, "box")


@pytest.mark.parametrize("ok", [True, False])
def test_an_apply_finishes_with_selinux_tools_that_work_or_fail(net, tmp_path, monkeypatch, ok):
    d = tmp_path / "selinux"
    d.mkdir()
    log = tmp_path / "selinux.log"
    for tool in ("chcon", "restorecon"):
        (d / tool).write_text(f'#!/bin/sh\necho "{tool} $*" >> "{log}"\nexit {0 if ok else 1}\n')
        (d / tool).chmod(0o755)
    monkeypatch.setenv("FAKE_HOST_PATH", str(d))                      # before the Host's own (Git's sh has a chcon)
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    assert net.mesh_lines("nas-1") == [key_line_of(net, "orion-2", "10.0.0.2")]
    calls = log.read_text().splitlines()
    assert f"restorecon -F {net.seen(net.host('nas-1'))}/home/.ssh/authorized_keys" in calls
    assert any(c.startswith("chcon --reference=") and "nas-1/home/.ssh/authorized_keys" in c for c in calls)


# ---------------------------------------------------------------- removal, rotation, drift

def test_removing_a_link_removes_exactly_its_tagged_entries(net):
    mesh.run(net.cfg(), apply=True)
    nas_before = net.ak("nas-1")
    net.cfg_path.write_text(CONFIG.replace("  - { from: orion-2, to: storage }\n", ""))
    r = mesh.run(net.cfg(), apply=True)
    nas = next(h for h in r["hosts"] if h["host"] == "nas-1")
    assert nas["changes"] == ["remove key from orion-2"]
    assert net.ak("nas-1") == "".join(x + "\n" for x in nas_before.splitlines() if "roster-mesh:" not in x)
    assert "Host nas-1" not in net.file("orion-2", "home/.ssh/roster-mesh/config")


def test_taking_mesh_away_leaves_the_hosts_exactly_as_before(net):
    before = net.snapshot()
    mesh.run(net.cfg(), apply=True)
    net.cfg_path.write_text(CONFIG.replace("    mesh: true\n", "").split("links:")[0])
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    assert net.snapshot() == before
    assert mesh.load_state()["members"] == []


def test_rotate_replaces_one_hosts_key_everywhere(net, capsys):
    mesh.run(net.cfg(), apply=True)
    old = key_line_of(net, "orion-3", "10.0.0.3")
    plan = mesh.run(net.cfg(), rotate=["orion-3"])
    o3 = next(h for h in plan["hosts"] if h["host"] == "orion-3")
    assert o3["changes"][0] == "replace key"
    assert "replace key from orion-3" in next(h for h in plan["hosts"] if h["host"] == "orion-2")["changes"]
    assert main(["mesh", "--rotate", "orion-3"]) == 0
    new = key_line_of(net, "orion-3", "10.0.0.3")
    assert new != old
    for peer in ("orion-2", "esx-02", "db-9"):
        assert new in net.mesh_lines(peer) and old not in net.mesh_lines(peer)


def test_rotate_refuses_a_host_that_is_not_a_source(net):
    before = net.snapshot()
    with pytest.raises(SystemExit) as e:
        main(["mesh", "--rotate", "nas-1"])
    assert "nas-1 isn't a Mesh source" in str(e.value)
    assert net.connections() == [] and net.snapshot() == before


def test_check_reports_a_hand_removed_key_as_drift(net, capsys):
    mesh.run(net.cfg(), apply=True)
    ak = net.host("nas-1") / "home/.ssh/authorized_keys"
    ak.write_text("".join(x + "\n" for x in ak.read_text().splitlines() if "roster-mesh" not in x))
    assert main(["check"]) == 1
    assert "nas-1: add key from orion-2" in capsys.readouterr().out


def test_a_roster_md_that_is_not_rosters_is_left_alone(net):
    (net.host("orion-3") / "home/ROSTER.md").write_text("my own notes\n")
    r = mesh.run(net.cfg(), apply=True)
    assert net.file("orion-3", "home/ROSTER.md") == "my own notes\n"
    assert any("orion-3" in w and "isn't roster's" in w for w in r["warnings"])


# ---------------------------------------------------------------- cut

def git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


def test_cut_takes_a_host_out_everywhere_and_keeps_the_boxs_access(net, capsys):
    git(net.cfg_path.parent, "init", "-q")
    git(net.cfg_path.parent, "add", "roster.yml")
    git(net.cfg_path.parent, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "x")
    mesh.run(net.cfg(), apply=True)
    assert main(["mesh", "cut", "orion-2", "--yes"]) == 0
    out = capsys.readouterr().out
    for peer in ("orion-3", "esx-02", "nas-1"):
        assert not any("roster-mesh:orion-2" in x for x in net.mesh_lines(peer))
    assert net.mesh_lines("orion-2") == []                           # every peer off orion-2
    assert "roster-managed:box" in net.ak("orion-2")                 # the Box can still investigate
    assert not (net.host("orion-2") / "home/.ssh/roster-mesh").exists()
    assert any("roster-mesh:orion-3" in x for x in net.mesh_lines("esx-02"))   # the rest of the Mesh stays
    cfg = net.cfg()
    assert cfg["hosts"]["orion-2"]["mesh"] is False                  # a Pending change, so the cut survives
    assert "mesh: false" in subprocess.run(["git", "-C", str(net.cfg_path.parent), "diff"], capture_output=True,
                                           text=True).stdout
    assert "cut orion-2: confirmed on" in out
    r = mesh.run(cfg, apply=True)                                    # the next apply tidies the peers' configs
    assert "remove key from orion-2" not in str(r) and "Host orion-2" not in net.file("orion-3", "home/.ssh/roster-mesh/config")
    assert not any("roster-mesh:orion-2" in x for p in HOSTS for x in net.mesh_lines(p))
    assert mesh.run(cfg)["already"]


def test_cut_warns_loudly_about_down_peers_until_they_are_done(net, capsys):
    mesh.run(net.cfg(), apply=True)
    net.down("nas-1")
    assert main(["mesh", "cut", "orion-2", "--yes"]) == 1
    out = capsys.readouterr()
    assert "CUT PENDING ON 1 HOST: nas-1" in out.out + out.err
    assert mesh.status(net.cfg())["cut_pending"] == {"orion-2": ["nas-1"]}
    main(["mesh", "status"])
    assert "cut pending on 1 Host" in capsys.readouterr().out
    net.down("nas-1", False)
    r = mesh.run(net.cfg(), apply=True)
    assert r["cut_pending"] == {} and net.mesh_lines("nas-1") == []


def cutting_after_dropping_a_mesh_dir(net):
    """orion-2 applied with a mesh_dir:, which roster.yml then drops: a cut's own side finds the old one."""
    d = net.host("orion-2") / "srv/mesh"
    (net.host("orion-2") / "srv").mkdir()
    with_mesh_dir(net, net.seen(d), host="orion-2")
    mesh.run(net.cfg(), apply=True)
    net.cfg_path.write_text(CONFIG)
    return d


def test_cut_reports_an_old_mesh_dir_on_the_cut_host_it_leaves_alone(net, capsys):
    d = cutting_after_dropping_a_mesh_dir(net)
    r = mesh.cut(net.cfg(), "orion-2")
    assert r["warnings"] == [
        f"orion-2: {net.seen(d)} holds an earlier Mesh key that roster no longer uses (mesh_dir: changed), so delete it by hand"]
    assert (d / "id_ed25519").exists()                      # never removed by roster
    assert mesh.cut(net.cfg(), "orion-3")["warnings"] == []


def test_the_cli_cut_prints_the_cleanup_warnings(net, capsys):
    d = cutting_after_dropping_a_mesh_dir(net)
    main(["mesh", "cut", "orion-2", "--yes"])
    assert f"warning: orion-2: {net.seen(d)} holds an earlier Mesh key" in capsys.readouterr().out


def test_cut_without_a_git_repo_still_writes_mesh_false(net, capsys):
    assert main(["mesh", "cut", "orion-3", "--yes"]) == 0
    assert net.cfg()["hosts"]["orion-3"]["mesh"] is False
    assert "isn't in a git repo" in capsys.readouterr().out


def test_cut_syncs_this_box_after_writing_mesh_false(net, isolated, capsys):
    """T153: the CLI's cut syncs this Box after it writes mesh: false, as serve's mesh.cut does (T150)."""
    ssh = isolated["home"] / ".ssh" / "config.d" / "roster"
    assert not ssh.exists()
    assert main(["mesh", "cut", "orion-3", "--yes"]) == 0
    assert "Host orion-3" in ssh.read_text()
    assert "roster sync" not in capsys.readouterr().err


def test_a_failed_sync_after_a_cut_keeps_mesh_false_and_says_on_stderr(net, isolated, capsys):
    (isolated["home"] / ".ssh" / "config.d" / "roster").mkdir(parents=True)     # a folder there: writing it fails
    assert main(["mesh", "cut", "orion-3", "--yes"]) == 0
    assert net.cfg()["hosts"]["orion-3"]["mesh"] is False
    err = capsys.readouterr().err
    assert "warning: this Box's ssh config didn't follow roster.yml (" in err
    assert err.rstrip().endswith("run `roster sync` on this box")


def test_cut_keeps_the_peers_that_confirmed_it_in_the_meshs_bookkeeping(net):
    mesh.run(net.cfg(), apply=True)
    r = mesh.cut(net.cfg(), "esx-02")
    assert r["pending"] == {} and "orion-2" in r["confirmed"]
    members = mesh.load_state()["members"]
    assert "esx-02" not in members
    assert {"orion-2", "orion-3", "nas-1", "db-9"} <= set(members)     # they still hold each other's keys
    net.cfg_path.write_text(CONFIG.replace("    mesh: true\n", "").split("links:")[0])
    assert mesh.run(net.cfg(), apply=True)["pending"] == {}           # so taking the Mesh away still visits them
    for h in HOSTS:
        assert net.mesh_lines(h) == [] and not (net.host(h) / "home/.ssh/roster-mesh").exists()
    assert "roster-mesh" not in net.file("orion-2", "home/.ssh/config")
    assert net.file("orion-2", "home/.claude/CLAUDE.md") == "# my notes\n"


# ---------------------------------------------------------------- serve's deadline

def test_apply_stops_at_the_deadline_and_leaves_the_rest_pending_without_connecting(net, monkeypatch):
    from roster import common
    real = mesh.on_host

    def first_one_uses_up_the_time(h, script, timeout=mesh.STEP_TIMEOUT):
        out = real(h, script, timeout)
        common._deadline.at = 0.0                    # the deadline passed during this Host's step
        return out
    monkeypatch.setattr(mesh, "on_host", first_one_uses_up_the_time)
    with common.deadline(240):
        r = mesh.run(net.cfg(), apply=True)
    assert [x for x in net.connections() if x.startswith("start")] == ["start db-9"]
    visit = mesh.graph(net.cfg())["visit"]
    assert set(r["pending"]) == set(visit)
    assert all("out of time" in why for why in r["pending"].values())
    assert mesh.load_state()["pending"] == r["pending"]               # and the next roster mesh finishes them


def test_cut_stops_at_the_deadline_too(net):
    from roster import common
    mesh.run(net.cfg(), apply=True)
    before = len(net.connections())
    with common.deadline(0):
        r = mesh.cut(net.cfg(), "orion-2")
    assert len(net.connections()) == before and r["confirmed"] == []
    assert "orion-2" in r["pending"] and all("out of time" in why for why in r["pending"].values())


# ---------------------------------------------------------------- setup and serve

def test_setup_applies_the_mesh_for_meshed_groups(net, capsys, monkeypatch):
    from roster import cli
    monkeypatch.setattr(cli, "record_fingerprints", lambda cfg, hosts: set())
    monkeypatch.setattr(cli, "ssh_ok", lambda name: True)
    monkeypatch.setattr(cli, "ensure_key", lambda cfg: None)
    monkeypatch.setattr(cli, "public_key_line", lambda cfg: "ssh-ed25519 AAAAbox roster-managed:box")
    main(["setup"])
    assert "mesh" in capsys.readouterr().out
    assert net.mesh_lines("nas-1") == [key_line_of(net, "orion-2", "10.0.0.2")]


def test_serve_plans_applies_cuts_and_reports_status(net, serve, monkeypatch):
    s = serve("-c", str(net.cfg_path))
    st = s.call("mesh.status")["result"]
    assert st["out_of_date"] is True and st["reach"]["orion-2"] == 4
    plan = s.call("mesh.plan")["result"]
    assert plan["applied"] is False and not plan["already"]
    r = s.call("mesh.apply")["result"]
    assert r["applied"] is True and r["pending"] == {}
    assert s.call("mesh.status")["result"]["out_of_date"] is False
    assert s.call("mesh.apply")["result"]["already"] is True
    err = s.call("mesh.plan", {"rotate": ["nas-1"]})["error"]
    assert err["code"] == 110 and err["data"]["hosts"] == ["nas-1"]
    assert s.call("mesh.cut", {"host": "nope"})["error"]["code"] == 2
    cut = s.call("mesh.cut", {"host": "orion-2"})["result"]
    assert cut["pending"] == {} and "nas-1" in cut["confirmed"]
    assert cut["change"]["written"] is True and cut["change"]["sync"] == {"ok": True}     # T150: this Box follows
    assert s.call("hosts.list")["result"]["hosts"][0]["mesh"] is False
    json.dumps(cut)


WAIT = 100      # s: how long a test waits for a Mesh job at most; Windows' CI runner takes many times as long as here


def wait_for(s, job, until=lambda j: j["state"] != "running", seconds=WAIT):
    """Polls mesh.job, as the Mesh controls Plugin does, until UNTIL holds; returns that answer. SECONDS is only how
    long a broken test takes to say so: a Mesh job on Windows' CI runner takes many times as long as here (T151)."""
    import time
    end = time.monotonic() + seconds
    while True:
        j = s.call("mesh.job", {"job": job})["result"]
        if until(j):
            return j
        if time.monotonic() > end:
            pytest.fail(f"mesh job {job} didn't get there in {seconds} s: {j}")
        time.sleep(0.05)


def test_serve_runs_a_mesh_job_in_the_background_and_answers_meanwhile(net, serve):
    s = serve("-c", str(net.cfg_path))
    assert s.call("mesh.job")["result"] is None                         # no job yet
    hold = net.host("orion-2") / "hold"
    hold.write_text("")                                                 # its step waits until we let it go
    started = s.call("mesh.plan", {"background": True})["result"]
    assert started["action"] == "plan" and started["total"] > 0 and isinstance(started["job"], int)
    # serve answers other requests while the job runs, and another Mesh run is refused
    assert s.call("mesh.status")["result"]["out_of_date"] is True
    busy = s.call("mesh.apply", {"background": True})["error"]
    assert busy["code"] == 111 and busy["data"]["job"] == started["job"]
    assert s.call("mesh.apply")["error"]["code"] == 111
    hold.unlink()
    j = wait_for(s, started["job"])
    assert j["state"] == "done" and j["done"] == j["total"] == started["total"]
    assert j["result"]["applied"] is False and not j["result"]["already"]
    assert net.mesh_lines("nas-1") == []                                # a plan changes nothing
    a = s.call("mesh.apply", {"background": True})["result"]
    j = wait_for(s, a["job"])
    assert j["action"] == "apply" and j["state"] == "done" and j["result"]["pending"] == {}
    assert net.mesh_lines("nas-1") == [key_line_of(net, "orion-2", "10.0.0.2")]
    assert s.call("mesh.status")["result"]["out_of_date"] is False
    assert s.call("mesh.job", {"job": a["job"] + 7})["result"] is None   # not the latest job


def test_a_background_job_reports_how_far_it_has_got(net, serve):
    s = serve("-c", str(net.cfg_path))
    hold = net.host("orion-2") / "hold"
    hold.write_text("")
    started = s.call("mesh.apply", {"background": True})["result"]
    j = wait_for(s, started["job"], until=lambda j: j["at"] == "orion-2" or j["state"] != "running")
    assert j["state"] == "running" and 0 <= j["done"] < j["total"] and "result" not in j
    hold.unlink()
    wait_for(s, started["job"])


def test_stopping_a_job_leaves_the_rest_pending_for_the_next_run(net, serve):
    s = serve("-c", str(net.cfg_path))
    hold = net.host("orion-2") / "hold"
    hold.write_text("")
    started = s.call("mesh.apply", {"background": True})["result"]
    wait_for(s, started["job"], until=lambda j: j["at"] == "orion-2")
    assert s.call("mesh.stop", {"job": started["job"]})["result"] == {"job": started["job"], "stopping": True}
    hold.unlink()
    j = wait_for(s, started["job"])
    assert j["state"] == "done" and j["stopped"] is True
    assert j["result"]["pending"] and all("stopped" in why for why in j["result"]["pending"].values())
    assert mesh.load_state()["pending"] == j["result"]["pending"]       # the next roster mesh finishes them
    assert s.call("mesh.stop", {"job": started["job"]})["result"]["stopping"] is False   # over already


def test_a_background_cut_writes_mesh_false_and_says_which_hosts_didnt_confirm(net, serve):
    s = serve("-c", str(net.cfg_path))
    wait_for(s, s.call("mesh.apply", {"background": True})["result"]["job"])
    net.down("nas-1")
    started = s.call("mesh.cut", {"host": "orion-2", "background": True})["result"]
    assert started["action"] == "cut" and started["host"] == "orion-2"
    j = wait_for(s, started["job"])
    assert j["state"] == "done" and j["done"] == j["total"]
    assert set(j["result"]["pending"]) == {"nas-1"} and j["result"]["change"]["written"] is True
    assert s.call("hosts.list")["result"]["hosts"][0]["mesh"] is False


def test_a_background_cut_reports_the_cleanup_warnings(net, serve):
    d = cutting_after_dropping_a_mesh_dir(net)
    s = serve("-c", str(net.cfg_path))
    j = wait_for(s, s.call("mesh.cut", {"host": "orion-2", "background": True})["result"]["job"])
    assert j["result"]["warnings"] == [
        f"orion-2: {net.seen(d)} holds an earlier Mesh key that roster no longer uses (mesh_dir: changed), so delete it by hand"]


def test_a_background_job_refuses_what_it_would_refuse_at_once(net, serve):
    s = serve("-c", str(net.cfg_path))
    assert s.call("mesh.plan", {"rotate": ["nas-1"], "background": True})["error"]["code"] == 110
    assert s.call("mesh.cut", {"host": "nope", "background": True})["error"]["code"] == 2
    assert s.call("mesh.plan", {"background": "yes"})["error"]["code"] == -32602
    assert s.call("mesh.stop", {"job": 99})["result"] == {"job": 99, "stopping": False}
    assert s.call("mesh.job")["result"] is None                         # nothing started


def test_brief_answers_stay_small_for_a_big_mesh_and_keep_what_is_worth_a_look(net, serve):
    net.cfg_path.write_text(VIA.replace("  - { from: orion-3, to: jump-1 }\n", ""))
    s = serve("-c", str(net.cfg_path))
    full = s.call("mesh.status")["result"]
    st = s.call("mesh.status", {"brief": True})["result"]
    assert st["link_count"] == len(full["links"]) and st["links_more"] == 0
    assert st["out_of_date"] is True and st["reach"]["orion-2"] == full["reach"]["orion-2"]
    assert st["reach"]["orion-3"] == full["reach"]["orion-3"] - 1          # its no-via Link doesn't count
    # the hop's Link, and only it: with no Link to jump-1 it's no-via, which needs no connection to know
    assert st["links"] == [{"from": "orion-3", "to": "db-9", "kind": "key", "via": "jump-1", "status": "no-via",
                            "why": "orion-3 has no Link to jump-1, its hop to db-9 (add { from: orion-3, to: jump-1 })"}]
    working = [x for x in full["links"] if "skip" not in x and not x.get("via")]
    assert st["reached"]["nas-1"] == sum(1 for x in working if x["to"] == "nas-1") > 0
    assert sum(st["link_statuses"].values()) == st["link_count"] and st["link_statuses"]["no-via"] == 1
    (net.host("orion-2") / "blocked").write_text("10.0.0.30:22\n")
    j = wait_for(s, s.call("mesh.plan", {"background": True})["result"]["job"])
    full_plan = j["result"]
    j = s.call("mesh.job", {"job": j["job"], "brief": True})["result"]
    assert j["result"]["link_count"] == len(full_plan["links"])
    assert {(x["from"], x["to"], x["status"]) for x in j["result"]["links"]} == {
        ("orion-3", "db-9", "no-via"), ("orion-2", "nas-1", "unreachable")}
    assert j["result"]["hosts"] == full_plan["hosts"]                   # few changes each: kept whole


def test_brief_keeps_at_most_a_thousand_links_and_ten_changes_a_host():
    links = [{"from": f"h{i}", "to": "x", "kind": "key", "status": "unreachable"} for i in range(1500)]
    hosts = [{"host": "x", "status": "would-change", "changes": [f"add key from h{i}" for i in range(1500)]}]
    b = mesh.brief({"links": links, "hosts": hosts, "reach": {}})
    assert len(b["links"]) == 1000 and b["links_more"] == 500 and b["link_statuses"] == {"unreachable": 1500}
    assert b["hosts"][0]["changes"] == [f"add key from h{i}" for i in range(10)] and b["hosts"][0]["more"] == 1490


def test_private_keys_never_leave_their_host_and_no_secret_is_looked_up(net, monkeypatch, isolated, capsys):
    from roster import providers

    def no_secrets(*a, **kw):
        raise AssertionError("the Mesh looked up a password")
    monkeypatch.setattr(providers, "get_secret", no_secrets)
    r = mesh.run(net.cfg(), apply=True)
    main(["mesh", "--dry-run"])
    shown = json.dumps(r) + capsys.readouterr().out
    private = (net.host("orion-2") / "home/.ssh/roster-mesh/id_ed25519").read_text()
    body = "".join(private.splitlines()[1:-1])
    assert body and body not in shown
    box = [p.read_text(errors="replace") for p in isolated["home"].rglob("*") if p.is_file()]
    assert not any(body[-60:-20] in t for t in box)
    for h in HOSTS:                                      # and no other Host holds a copy of it
        for p in net.host(h).rglob("*"):
            if p.is_file() and h != "orion-2":
                assert body[-60:-20] not in p.read_text(errors="replace")


def test_status_grouped_gives_each_meshed_group_once_and_only_the_links_it_doesnt_cover(net):
    """For a map (the Topology Plugin): a meshed group of 50 is 2,450 Links one by one, and one entry grouped."""
    st = mesh.status(net.cfg(), grouped=True)
    assert st["meshed"] == {"lab": ["orion-2", "orion-3", "esx-02", "sw-1"]}
    assert [(x["from"], x["to"]) for x in st["links"]] == [("db-9", "orion-3"), ("orion-2", "nas-1"), ("orion-3", "db-9")]
    full = mesh.status(net.cfg())
    assert "meshed" not in full and len(full["links"]) == 12 + 3
    assert {k: v for k, v in st.items() if k not in ("links", "meshed")} == {k: v for k, v in full.items() if k != "links"}


def test_serve_mesh_status_grouped(net, serve):
    s = serve("-c", str(net.cfg_path))
    assert s.call("mesh.status", {"grouped": True})["result"]["meshed"] == {"lab": ["orion-2", "orion-3", "esx-02", "sw-1"]}
    assert s.call("mesh.status", {"grouped": "yes"})["error"]["code"] == -32602
    assert s.call("mesh.status", {"grouped": True, "brief": True})["error"]["code"] == -32602


def test_a_via_link_whose_jump_host_has_no_recorded_host_key_is_not_written(net, isolated):
    # review 8 #1: orion-3's own Link to jump-1 isn't written (no host key), so a ProxyJump jump-1 would name a Host
    # orion-3's ssh config doesn't have, with no pinned key
    net.cfg_path.write_text(VIA)
    kh = isolated["home"] / ".ssh/roster_known_hosts"
    kh.write_text("".join(x + "\n" for x in kh.read_text().splitlines() if not x.startswith("10.0.5.1 ")))
    r = mesh.run(net.cfg(), apply=True)
    link = next(x for x in r["links"] if (x["from"], x["to"]) == ("orion-3", "db-9"))
    assert link["status"] == "no-host-key"
    assert link["why"] == "no recorded host key for jump-1 (orion-3's hop to db-9) on this Box (roster setup --only jump-1)"
    assert net.mesh_lines("db-9") == []
    assert "ProxyJump" not in net.file("orion-3", "home/.ssh/roster-mesh/config")


STOPPED_PART_WAY = r"""
import sys
from roster import mesh
from roster.config import load_config
at_stop = []
real = mesh.on_host


def on_host(h, script, timeout=mesh.STEP_TIMEOUT):
    if h["name"] == "orion-2" and not at_stop:          # serve closes while its ssh runs: close() ends it
        at_stop.append(set(sys.modules))
        return None, mesh.CLOSED
    return real(h, script, timeout)


mesh.on_host = on_host
mesh.run(load_config(sys.argv[1]), apply=True, stopped=lambda: bool(at_stop))
print(" ".join(sorted(m for m in set(sys.modules) - at_stop[0] if "." not in m)))
"""


def test_a_run_stopped_part_way_loads_nothing_before_it_records(net):
    # T161: serve gives a stopped job CLOSE_WAIT (0.8 s) to record what it didn't do, then exits. The first host-key
    # lookup after the stop imported paramiko (0.13 s on an idle box, past 0.8 s on a busy one or on Windows), so
    # serve could exit before mesh.json said which Hosts were left. A fresh process, so nothing is loaded already.
    r = subprocess.run([sys.executable, "-c", STOPPED_PART_WAY, str(net.cfg_path)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.split() == [], f"loaded after the stop: {r.stdout}"
    assert "orion-2" in mesh.load_state()["pending"]


def connected(net, name, seconds=WAIT):
    """Waits until a connection to stand-in Host NAME has started (the stand-in ssh logs it before it waits on the
    Host's hold file), so its ssh is running. SECONDS is only how long a broken test takes to say so."""
    import time
    end = time.monotonic() + seconds
    while f"start {name}" not in net.connections():
        if time.monotonic() > end:
            pytest.fail(f"no connection to {name} in {seconds} s: {net.connections()}")
        time.sleep(0.02)


def serve_waits_for_the_app_at_most():
    """How long the app gives serve to exit after closing its stdin (EXIT_GRACE in rpc.rs), in seconds."""
    rpc = (Path(__file__).parents[1] / "crates/roster-core/src/rpc.rs").read_text()
    return int(re.search(r"pub const EXIT_GRACE: Duration = Duration::from_secs\((\d+)\);", rpc)[1])


def test_serve_closing_mid_job_stops_it_and_records_what_it_didnt_finish(net, serve):
    # review 8 #4: closing serve (the app closes its stdin, then kills it a second later) stopped a scan but left a
    # Mesh job's daemon thread to die mid-apply, so mesh.json never said which Hosts were left to do
    s = serve("-c", str(net.cfg_path))
    hold = net.host("orion-2") / "hold"
    hold.write_text("")                                                 # its step waits until we let it go: never
    started = s.call("mesh.apply", {"background": True})["result"]
    assert wait_for(s, started["job"], until=lambda j: j["at"] == "orion-2")["state"] == "running"
    connected(net, "orion-2")                                           # its ssh has started
    code, _, _ = s.close()
    assert code == 0
    # T161: serve ended the step's ssh rather than wait for it (the step never ended; nobody let it go)
    assert hold.exists() and "end orion-2" not in net.connections()
    pending = mesh.load_state()["pending"]
    assert "orion-2" in pending and "serve closed" in pending["orion-2"]
    assert set(pending) >= {"orion-3", "nas-1"}                         # not visited: the next run finishes them


def test_serve_closing_mid_foreground_apply_stops_it_and_records_it_too(net, serve):
    # T104 (#182): the waiting form (no background) is a job as well, so quitting the app stops it and mesh.json
    # says what it didn't do, as for a background run
    from roster import serve as rpc
    s = serve("-c", str(net.cfg_path))
    hold = net.host("orion-2") / "hold"
    hold.write_text("")
    s.request("mesh.apply")                                             # waits for its result: never answered here
    while not any(n["params"].get("at") == "orion-2" for n in s.notes if n["method"] == "job.progress"):
        s.notes.append(json.loads(s.p.stdout.readline()))               # pytest-timeout ends it if it never comes
    connected(net, "orion-2")
    code, out, _ = s.close()
    assert code == 0
    assert hold.exists() and "end orion-2" not in net.connections()     # it didn't wait for the step
    # inside the app's EXIT_GRACE, from serve's own waits (T161: not a stopwatch, which a busy runner overran)
    assert rpc.DRAIN_WAIT + rpc.CLOSE_WAIT < serve_waits_for_the_app_at_most()
    pending = mesh.load_state()["pending"]
    assert "orion-2" in pending and "serve closed" in pending["orion-2"]
    assert set(pending) >= {"orion-3", "nas-1"}
    answer = next(json.loads(x) for x in out.splitlines() if '"id": 1' in x)
    pending_links = [x for x in answer["result"]["links"] if x["from"] == "orion-2"]
    assert pending_links and all(x["status"] == "pending" and "serve closed" in x["why"] for x in pending_links)


def test_a_background_run_works_out_the_mesh_once_while_serve_waits(net, monkeypatch):
    # review 8 #10: serve answered nothing while it started a job (one request at a time), and the graph of a big meshed group is
    # every pair in it; starting the job worked it out twice (and the run a third time)
    from roster import serve as rpc
    state = rpc.State(str(net.cfg_path))
    calls = []
    graph = mesh.graph
    monkeypatch.setattr(mesh, "graph", lambda cfg: calls.append(1) or graph(cfg))
    with state.lock:
        r = rpc.handle(state, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "mesh.apply",
                                          "params": {"background": True}}))
        assert len(calls) == 1
    job = state.jobs.latest("mesh")
    assert job.wait(WAIT), f"the job didn't end in {WAIT} s: {job.view()}"      # T161: was 20 s, past on Windows
    assert len(calls) == 1 and job.result["pending"] == {}
    assert r["result"]["total"] == job.total == job.done


# ---------------------------------------------------------------- serve answers concurrently (ticket 101, Q112)

def test_a_quick_read_answers_while_a_waiting_plan_is_on_a_slow_host(net, serve):
    import time
    s = serve("-c", str(net.cfg_path))
    s.call("inventory.info")
    (net.host("orion-2") / "slow").write_text("3")                      # the stand-in slow Host
    plan = s.request("mesh.plan")                                       # the waiting form: no background
    time.sleep(0.5)
    t = time.monotonic()
    assert s.call("mesh.status")["result"]["out_of_date"] is True
    assert s.call("hosts.list")["result"]["hosts"]
    took = time.monotonic() - t
    assert took < 1, f"two quick reads took {took:.2f} s behind a Mesh plan"
    busy = s.call("mesh.apply", {"background": True})["error"]          # the waiting plan is a job too
    assert busy["code"] == 111
    assert s.answer(plan)["result"]["applied"] is False
    assert s.order[-1] == plan


def test_a_mesh_job_pushes_its_progress_and_its_end(net, serve):
    s = serve("-c", str(net.cfg_path))
    (net.host("orion-2") / "slow").write_text("0.5")
    started = s.call("mesh.apply", {"background": True})["result"]
    j = wait_for(s, started["job"])
    assert j["state"] == "done"
    s.call("jobs.list")
    notes = [n["params"] for n in s.notes if n["method"] == "job.progress"]
    assert notes[0] == {"kind": "mesh", "job": started["job"], "action": "apply", "state": "running", "done": 0,
                        "total": started["total"], "at": None}
    assert any(n["at"] == "orion-2" for n in notes)                     # where it was, as it went
    assert notes[-1]["state"] == "done" and notes[-1]["done"] == notes[-1]["total"]
    assert all("result" not in n for n in notes)                        # mesh.job has it
    assert s.call("jobs.list")["result"]["jobs"] == [{**notes[-1]}]


def test_jobs_stop_stops_a_mesh_job_as_mesh_stop_does(net, serve):
    s = serve("-c", str(net.cfg_path))
    hold = net.host("orion-2") / "hold"
    hold.write_text("")
    started = s.call("mesh.apply", {"background": True})["result"]
    wait_for(s, started["job"], until=lambda j: j["at"] == "orion-2")
    assert s.call("jobs.stop", {"kind": "mesh", "job": started["job"]})["result"]["stopping"] is True
    hold.unlink()
    j = wait_for(s, started["job"])
    assert j["state"] == "done" and j["stopped"] is True and j["result"]["pending"]


def test_a_cut_whose_write_waits_too_long_for_roster_yml_says_so_and_still_cut(net, monkeypatch):
    # review 6: a cut's write waited for roster.yml with no limit, so mesh: false landed long after anyone asked
    import threading

    from roster import serve as rpc
    monkeypatch.setattr(rpc, "LOCK_WAIT", 0.2)
    state = rpc.State(str(net.cfg_path))
    held, release = threading.Event(), threading.Event()

    def publish():                                  # the app's Publish takes roster.yml once the cut is done
        state.lock.acquire(False, None, "changes.publish")
        held.set()
        release.wait(10)
        state.lock.release()
    cut = mesh.cut

    def cut_then_publish(*a, **k):
        result = cut(*a, **k)
        threading.Thread(target=publish, daemon=True).start()
        held.wait(5)
        return result
    monkeypatch.setattr(mesh, "cut", cut_then_publish)
    r = rpc.handle(state, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "mesh.cut",
                                      "params": {"host": "orion-2", "background": True}}))
    job = state.jobs.latest("mesh")
    assert job.wait(10), r
    release.set()
    change = job.result["change"]
    assert change["written"] is False and "roster.yml is busy: changes.publish is still running" in change["error"]
    assert "mesh: false" in change["fix"]


# ---------------------------------------------------------------- one mesh.json per Inventory (T182, #346)

def config_dir():
    from roster.common import user_config_dir
    return user_config_dir()


def test_a_named_inventorys_mesh_state_is_its_own(net, capsys):
    """Two named Inventories share no Mesh state: a Host name in both doesn't collide, and a run on one doesn't see
    the other's Hosts. The unnamed Inventory keeps ~/.config/roster/mesh.json."""
    assert main(["inv", "add", "lab", str(net.cfg_path)]) == 0
    assert main(["mesh"]) == 0
    capsys.readouterr()
    named = json.loads((config_dir() / "mesh-lab.json").read_text())
    assert {"orion-2", "orion-3", "nas-1", "db-9"} <= set(named["members"])
    assert not (config_dir() / "mesh.json").exists()


def test_the_unnamed_inventorys_mesh_state_is_where_it_always_was(net):
    mesh.run(net.cfg(), apply=True)
    assert mesh.state_file() == config_dir() / "mesh.json"
    assert not list(config_dir().glob("mesh-*"))


def unnamed_ssh_config_from(isolated, path):
    """roster's unnamed ssh config, as `roster -c PATH sync` heads it (only its header matters here)."""
    f = isolated["home"] / ".ssh/config.d/roster"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(f"# Generated by roster from {path}\n")


def test_naming_the_inventory_the_mesh_state_is_from_moves_it_once(net, isolated, capsys):
    mesh.run(net.cfg(), apply=True)
    before = (config_dir() / "mesh.json").read_bytes()
    unnamed_ssh_config_from(isolated, net.cfg_path)
    assert main(["inv", "add", "lab", str(net.cfg_path)]) == 0
    assert "Mesh state" in capsys.readouterr().out
    assert (config_dir() / "mesh-lab.json").read_bytes() == before
    assert not (config_dir() / "mesh.json").exists()
    main(["sync"])                                  # named: its own ssh config, as after any `inv add`
    capsys.readouterr()
    assert main(["mesh"]) == 0                      # its entries now carry the Inventory too (T199): tagged once
    assert "tag key from orion-2 as this Box's" in capsys.readouterr().out
    assert any(x.endswith("roster-mesh:orion-2@box/lab") for x in net.mesh_lines("nas-1"))
    assert main(["mesh"]) == 0 and "already in the mesh" in capsys.readouterr().out


def test_another_files_mesh_state_stays_with_the_unnamed_inventory(net, isolated, write_config, capsys):
    mesh.run(net.cfg(), apply=True)
    before = (config_dir() / "mesh.json").read_bytes()
    other = isolated["home"] / "other"
    other.mkdir()
    (other / "roster.yml").write_text(CONFIG)
    unnamed_ssh_config_from(isolated, net.cfg_path)
    assert main(["inv", "add", "other", str(other / "roster.yml")]) == 0
    out = capsys.readouterr().out
    assert "Mesh state (from" not in out and "mesh.json stays with the unnamed Inventory" in out
    assert (config_dir() / "mesh.json").read_bytes() == before
    assert not (config_dir() / "mesh-other.json").exists()


def test_without_an_unnamed_ssh_config_the_state_isnt_moved_and_that_is_said(net, capsys):
    """#367's review, F2: with nothing to say which file the Box's Mesh state is from, it stays the unnamed one's."""
    mesh.run(net.cfg(), apply=True)
    assert main(["inv", "add", "lab", str(net.cfg_path)]) == 0
    assert "mesh.json stays with the unnamed Inventory" in capsys.readouterr().out
    assert (config_dir() / "mesh.json").exists() and not (config_dir() / "mesh-lab.json").exists()


def test_a_state_naming_a_host_the_file_doesnt_have_isnt_moved_though_the_header_matches(net, isolated, capsys):
    """F2's case: mesh.json is another file's Mesh (`hbox` isn't a Host here); the unnamed ssh config being this
    file's only says what synced last."""
    mesh.run(net.cfg(), apply=True)
    st = json.loads((config_dir() / "mesh.json").read_text())
    (config_dir() / "mesh.json").write_text(json.dumps({**st, "members": [*st["members"], "hbox"]}))
    unnamed_ssh_config_from(isolated, net.cfg_path)
    assert main(["inv", "add", "lab", str(net.cfg_path)]) == 0
    assert "mesh.json stays with the unnamed Inventory" in capsys.readouterr().out
    assert (config_dir() / "mesh.json").exists() and not (config_dir() / "mesh-lab.json").exists()


def test_a_state_applied_from_another_version_of_the_mesh_isnt_moved(net, isolated, capsys):
    mesh.run(net.cfg(), apply=True)
    net.cfg_path.write_text(CONFIG.replace("  - { from: orion-3, to: db-9, both: true }\n", ""))
    unnamed_ssh_config_from(isolated, net.cfg_path)
    assert main(["inv", "add", "lab", str(net.cfg_path)]) == 0
    assert "mesh.json stays with the unnamed Inventory" in capsys.readouterr().out
    assert not (config_dir() / "mesh-lab.json").exists()


def test_a_named_inventorys_own_mesh_state_is_never_overwritten_by_the_move(net, isolated, capsys):
    mesh.run(net.cfg(), apply=True)
    (config_dir() / "mesh-lab.json").write_text('{"members": ["orion-2"]}\n')
    unnamed_ssh_config_from(isolated, net.cfg_path)
    assert main(["inv", "add", "lab", str(net.cfg_path)]) == 0
    assert (config_dir() / "mesh-lab.json").read_text() == '{"members": ["orion-2"]}\n'
    assert (config_dir() / "mesh.json").exists()


def test_removing_a_named_inventory_sets_its_mesh_state_aside(net, capsys):
    main(["inv", "add", "lab", str(net.cfg_path)])
    main(["mesh"])
    capsys.readouterr()
    assert main(["inv", "remove", "lab"]) == 0
    out = capsys.readouterr().out
    kept = list(config_dir().glob("mesh-lab.json.removed-*"))
    assert len(kept) == 1 and str(kept[0]) in out
    assert not (config_dir() / "mesh-lab.json").exists()


def test_the_mesh_never_reaches_a_host_of_an_inventory_not_synced_here(net, isolated, capsys):
    """#367's review: with the index in ~/.ssh/config, a name not in this Inventory's part of it reaches another
    Inventory's Host or nothing roster wrote: the Mesh leaves it pending and never runs `ssh NAME`."""
    other = isolated["home"] / "other"
    other.mkdir()
    (other / "roster.yml").write_text("groups:\n  lab:\n    user: ops\n    hosts:\n      orion-2: 10.0.9.2\n")
    main(["inv", "add", "lab", str(net.cfg_path)])
    main(["inv", "add", "other", str(other / "roster.yml")])
    main(["--inv", "other", "sync"])
    capsys.readouterr()
    assert main(["--inv", "lab", "mesh"]) == 1
    assert net.connections() == []
    assert "orion-2 is not in this Box's ssh config for this Inventory" in capsys.readouterr().out


# ---------------------------------------------------------------- roster installed or not (T193, #365)

def reinstall():
    """roster removed from the Box without `roster mesh cut --all` first, then installed again (or another Box, new):
    no Mesh state here."""
    mesh.state_file().unlink()


# Another Box's Mesh on shared Hosts (#372's review, B1): Box L1's roster.yml meshes orion-2 -> nas-1 (CONFIG); a
# second Box, new, has a roster.yml with nas-1 and orion-2 too and other Links, or none.
L2 = "defaults:\n  user: admin\ngroups:\n  storage:\n    hosts:\n      nas-1: 10.0.0.30\n      db-9: 10.0.9.9\n"
L3 = CONFIG.replace("    mesh: true\n", "").split("links:")[0]
DROPPED = CONFIG.replace("  - { from: orion-2, to: storage }\n", "")       # this roster.yml without orion-2 -> nas-1


@pytest.mark.parametrize("other", [L2, L3])
def test_a_new_box_leaves_another_boxs_mesh_on_shared_hosts_alone(net, capsys, other):
    mesh.run(net.cfg(), apply=True)                     # Box L1
    l1 = net.snapshot()
    nas, o2 = net.mesh_lines("nas-1"), net.host("orion-2") / "home/.ssh/roster-mesh"
    reinstall()                                         # Box L2/L3: no Mesh state of its own
    net.cfg_path.write_text(other)
    main(["mesh", "--dry-run"])
    main(["check"])
    main(["mesh"])
    out = capsys.readouterr().out
    assert net.mesh_lines("nas-1") == nas               # L1's orion-2 -> nas-1 still works
    assert "remove key from orion-2" not in out and "earlier roster" not in out
    assert net.snapshot() == l1 and (o2 / "id_ed25519").exists()


def test_find_leftovers_reports_what_this_roster_yml_doesnt_ask_for_and_changes_nothing(net, capsys):
    mesh.run(net.cfg(), apply=True)
    reinstall()
    net.cfg_path.write_text(DROPPED)
    (net.root / "connections").unlink()
    before = net.snapshot()
    assert main(["mesh", "--find-leftovers"]) == 0
    out = capsys.readouterr().out
    assert net.snapshot() == before
    assert "nas-1: key from orion-2 (from=10.0.0.2)" in out
    assert "this Box's own (their tag names it)" in out             # T199: this Box's tag, so this Box's
    logged = [x.split()[1] for x in net.connections() if x.startswith("start")]
    assert len(logged) == len(set(logged))              # once per Host, one at a time


def test_find_leftovers_reports_a_former_sources_files(net, capsys):
    mesh.run(net.cfg(), apply=True)
    net.cfg_path.write_text(L3)
    assert main(["mesh", "--find-leftovers"]) == 0
    out = capsys.readouterr().out
    o2 = next(x for x in out.splitlines() if x.startswith("orion-2: "))
    assert "key from orion-3 (from=10.0.0.3)" in o2 and "Mesh key and files in" in o2 and "the Include in ~/.ssh/config" in o2


def test_remove_leftovers_asks_says_whose_they_may_be_and_removes_only_them(net, capsys, monkeypatch):
    mesh.run(net.cfg(), apply=True)
    reinstall()
    net.cfg_path.write_text(DROPPED)
    untag(net)                                          # an older roster's: they may be another Box's
    asked = []
    monkeypatch.setattr("builtins.input", lambda prompt: asked.append(prompt) or "n")
    assert main(["mesh", "--remove-leftovers"]) == 1
    assert "another Box" in asked[0]
    assert any("roster-mesh:orion-2" in x for x in net.mesh_lines("nas-1"))
    assert main(["mesh", "--remove-leftovers", "-y"]) == 0
    assert net.mesh_lines("nas-1") == []
    assert "roster-managed:box" in net.ak("nas-1") and "own@laptop" in net.ak("nas-1")
    assert any("roster-mesh:orion-3" in x for x in net.mesh_lines("orion-2"))     # still asked for: kept
    capsys.readouterr()
    assert main(["mesh", "--find-leftovers"]) == 0
    assert "no Mesh entries" in capsys.readouterr().out


def test_remove_leftovers_takes_a_former_sources_files_too(net):
    mesh.run(net.cfg(), apply=True)
    net.cfg_path.write_text(L3)
    reinstall()
    assert main(["mesh", "--remove-leftovers", "-y"]) == 0
    assert not any(net.mesh_lines(h) for h in HOSTS)
    assert not (net.host("orion-2") / "home/.ssh/roster-mesh").exists()
    assert mesh.MARK not in net.file("orion-2", "home/.ssh/config")


def test_remove_leftovers_is_refused_with_another_inventorys_mesh_on_this_box(net, capsys):
    """With an older roster's lines only (no Box or Inventory in their tag): this Box's own are told apart."""
    mesh.run(net.cfg(), apply=True)
    untag(net)
    reinstall()
    (mesh.state_file().parent / "mesh-work.json").write_text("{}\n")
    net.cfg_path.write_text(DROPPED)
    with pytest.raises(SystemExit, match="another Inventory"):
        main(["mesh", "--remove-leftovers", "-y"])
    assert net.mesh_lines("nas-1")


def test_status_says_when_this_box_has_no_mesh_record(net, capsys):
    mesh.run(net.cfg(), apply=True)
    reinstall()
    assert main(["mesh", "status"]) == 0
    out = capsys.readouterr().out
    assert "no Mesh record on this Box" in out and "roster mesh --find-leftovers" in out
    mesh.run(net.cfg(), apply=True)
    assert main(["mesh", "status"]) == 0
    assert "no Mesh record" not in capsys.readouterr().out


def test_a_users_roster_md_that_mentions_the_mesh_is_never_removed(net):
    """#372's review, F1: only the Mesh's exact header makes a ROSTER.md roster's."""
    mine = "# My notes about roster-mesh and other things\n"
    (net.host("nas-1") / "home/ROSTER.md").write_text(mine)
    mesh.run(net.cfg(), apply=True)
    assert net.file("nas-1", "home/ROSTER.md") == mine


def test_cut_all_takes_every_mesh_entry_off_every_host_and_keeps_roster_yml(net, capsys):
    before = net.snapshot()
    yml = net.cfg_path.read_text()
    mesh.run(net.cfg(), apply=True)
    assert main(["mesh", "cut", "--all", "--yes"]) == 0
    assert net.snapshot() == before
    assert net.cfg_path.read_text() == yml                           # uninstalling: roster.yml is the user's
    assert "cut the Mesh: confirmed on" in capsys.readouterr().out


def test_cut_all_with_a_host_down_says_so_and_fails(net, capsys):
    mesh.run(net.cfg(), apply=True)
    net.down("nas-1")
    assert main(["mesh", "cut", "--all", "--yes"]) == 1
    assert "not confirmed  nas-1" in capsys.readouterr().out
    net.down("nas-1", False)
    assert main(["mesh", "cut", "--all", "--yes"]) == 0
    assert net.mesh_lines("nas-1") == []


def test_cut_all_takes_no_host(net, capsys):
    with pytest.raises(SystemExit):
        main(["mesh", "cut", "--all", "orion-2", "--yes"])


HOSTS_OWN_YML = "groups:\n  home:\n    user: pi\n    hosts:\n      nas-1: 10.0.0.30\n      printer-1: 10.0.0.77\n"


def roster_on(net, name, *argv):
    """The Host NAME's own roster (it's a roster Box too), run there as that Host's user would: HOME is its home."""
    home = net.host(name) / "home"
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home), "APPDATA": str(home / "AppData/Roaming"),
           "LOCALAPPDATA": str(home / "AppData/Local")}
    r = subprocess.run([sys.executable, "-m", "roster", *argv], env=env, capture_output=True, text=True,
                       cwd=str(home))
    assert r.returncode == 0, r.stdout + r.stderr
    return r.stdout


@pytest.mark.parametrize("named", [False, True])
@pytest.mark.parametrize("mesh_first", [False, True])
def test_a_meshed_host_that_runs_roster_itself_keeps_both_writers_lines_once(net, named, mesh_first):
    """T193 (2): the Mesh and the Host's own roster each write ~/.ssh/config; neither overwrites or repeats the
    other's lines, in either order, and both stay idempotent."""
    own = net.host("orion-2") / "home/net"
    own.mkdir()
    (own / "roster.yml").write_text(HOSTS_OWN_YML)
    argv = ["--inv", "net"] if named else ["-c", str(own / "roster.yml")]

    if named:
        roster_on(net, "orion-2", "inv", "add", "net", str(own / "roster.yml"))

    def host_roster():
        roster_on(net, "orion-2", *argv, "sync")

    if not mesh_first:
        host_roster()
    mesh.run(net.cfg(), apply=True)
    host_roster()
    assert mesh.run(net.cfg())["already"]
    host_roster()
    mesh.run(net.cfg(), apply=True)
    config = net.file("orion-2", "home/.ssh/config")
    lines = config.splitlines()
    mesh_inc = f"Include {net.seen(net.host('orion-2') / 'home/.ssh/roster-mesh')}/config"
    own_inc = [x for x in lines if x.startswith("Include ") and ("roster.inventories" in x or "config.d/roster" in x)]
    assert lines.count(mesh.MARK) == 1 and lines.count(mesh_inc) == 1
    assert lines[lines.index(mesh.MARK) + 1] == mesh_inc
    assert len(own_inc) == 1, config
    assert config.endswith("Host *\n    ServerAliveInterval 60\n")
    assert mesh.run(net.cfg())["already"]


def test_a_hosts_own_roster_never_overwrites_the_meshs_roster_md(net):
    """A Host whose roster.yml sits in its home folder: its ROSTER.md and the Mesh's are the same file; each writer
    leaves the other's alone and says so."""
    mesh.run(net.cfg(), apply=True)
    ours = net.file("orion-2", "home/ROSTER.md")
    (net.host("orion-2") / "home/roster.yml").write_text(HOSTS_OWN_YML)
    out = roster_on(net, "orion-2", "-c", str(net.host("orion-2") / "home/roster.yml"), "sync")
    assert net.file("orion-2", "home/ROSTER.md") == ours
    assert "ROSTER.md is the Mesh's" in out


def test_a_meshed_hosts_own_roster_md_is_left_alone_and_said_to_be_its_own(net):
    (net.host("orion-2") / "home/roster.yml").write_text(HOSTS_OWN_YML)
    roster_on(net, "orion-2", "-c", str(net.host("orion-2") / "home/roster.yml"), "sync")
    its_own = net.file("orion-2", "home/ROSTER.md")
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {} and net.file("orion-2", "home/ROSTER.md") == its_own
    assert any(w.startswith("orion-2: ") and "ROSTER.md is that Host's own roster's" in w for w in r["warnings"])


def test_leftovers_of_a_roster_removed_from_a_host_dont_break_the_mesh(net):
    """T193 (3): roster ran on orion-2 once and was removed: ~/.ssh/config still includes its deleted config.d/roster,
    and its ROSTER.md and known_hosts are still there. The Mesh's writes and its test work, and none of those is
    touched (they're the user's now)."""
    home = net.host("orion-2") / "home"
    dangling = f'Include "{net.seen(home)}/.ssh/config.d/roster"'
    (home / ".ssh/config").write_text(f"{dangling}\n\nHost *\n    ServerAliveInterval 60\n")
    (home / "ROSTER.md").write_text("<!-- generated by roster from roster.yml - regenerate with `roster sync` -->\n")
    (home / ".ssh/roster_known_hosts").write_text("10.0.0.30 ssh-ed25519 AAAAstale\n")
    (home / ".ssh/known_hosts").write_text("10.0.0.30 ssh-ed25519 AAAAstale\n")
    keep = {p: (home / p).read_text() for p in ("ROSTER.md", ".ssh/roster_known_hosts", ".ssh/known_hosts")}
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    assert all(x["status"] in ("ok", "skipped") for x in r["links"] if x["from"] == "orion-2")
    assert key_line_of(net, "orion-2", "10.0.0.2") in net.mesh_lines("nas-1")
    assert {p: (home / p).read_text() for p in keep} == keep
    config = net.file("orion-2", "home/.ssh/config")
    assert config.count(dangling) == 1 and mesh.MARK in config
    assert "UserKnownHostsFile" in net.file("orion-2", "home/.ssh/roster-mesh/config")   # its own, never the stale one
    assert mesh.run(net.cfg())["already"]


def test_a_dangling_include_the_mesh_relies_on_is_reported_and_written_again(net, capsys):
    mesh.run(net.cfg(), apply=True)
    (net.host("orion-2") / "home/.ssh/roster-mesh/config").unlink()
    assert main(["mesh", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "orion-2: ~/.ssh/config includes" in out and "which isn't there" in out
    r = mesh.run(net.cfg(), apply=True)
    assert any("which wasn't there" in w for w in r["warnings"])
    assert (net.host("orion-2") / "home/.ssh/roster-mesh/config").exists()
    assert mesh.run(net.cfg())["already"]



def test_a_reinstalled_box_with_the_same_roster_yml_takes_the_mesh_as_it_is(net):
    mesh.run(net.cfg(), apply=True)
    reinstall()
    before = net.snapshot()
    assert mesh.run(net.cfg())["already"]                # the same keys and lines: nothing to change
    mesh.run(net.cfg(), apply=True)
    assert net.snapshot() == before


# ---------------------------------------------------------------- whose Mesh it is (T199, #379)
# Each Box (and named Inventory) tags what it writes with itself: roster-mesh:SOURCE@BOX (BOX/INVENTORY for a named
# Inventory) in authorized_keys, and the same owner in the Mesh files' headers, so one Box's apply, cut or
# --remove-leftovers never takes another's.

# Box L3 (#372's review, second pass): orion-2 only as a peer (L1 meshes it as a source), nas-1 as a source
L3_BOX = """\
box_name: l3
defaults:
  user: admin
groups:
  home:
    hosts:
      orion-2: 10.0.0.2
      nas-1: 10.0.0.30
links:
  - { from: nas-1, to: orion-2 }
"""


class Box:
    """Another Box on the same Hosts: its own roster.yml and its own Mesh state (~/.config/roster/mesh.json)."""

    def __init__(self, net, yml):
        self.net, self.yml, self.state = net, yml, None

    def __enter__(self):
        f = mesh.state_file()
        self.mine, self.cfg = (f.read_bytes() if f.exists() else None), self.net.cfg_path.read_text()
        f.unlink(missing_ok=True)
        if self.state is not None:
            f.write_bytes(self.state)
        self.net.cfg_path.write_text(self.yml)
        return self

    def __exit__(self, *exc):
        f = mesh.state_file()
        self.state = f.read_bytes() if f.exists() else None
        f.unlink(missing_ok=True)
        if self.mine is not None:
            f.write_bytes(self.mine)
        self.net.cfg_path.write_text(self.cfg)


def mesh_files(net, host):
    """Everything the Mesh keeps on HOST as a source, and the lines it adds to ~/.ssh/config and CLAUDE.md."""
    d = net.host(host) / "home/.ssh/roster-mesh"
    files = {p.name: p.read_text() for p in sorted(d.iterdir())} if d.exists() else {}
    return files, net.file(host, "home/ROSTER.md"), net.file(host, "home/.ssh/config")


def test_another_boxs_apply_leaves_this_boxs_mesh_on_a_shared_host_alone(net):
    """#379: L1 meshes orion-2 -> nas-1; L3 lists orion-2 only as a peer (nas-1 -> orion-2). L3's apply used to remove
    orion-2's Mesh key, config, known_hosts, Include and ROSTER.md, which L1 wrote."""
    mesh.run(net.cfg(), apply=True)                                  # Box L1 (box)
    l1_files, l1_nas = mesh_files(net, "orion-2"), net.mesh_lines("nas-1")
    assert l1_files[0] and l1_files[1] and all(x.endswith("roster-mesh:orion-2@box") for x in l1_nas)
    l3 = Box(net, L3_BOX)
    with l3:
        r = mesh.run(net.cfg(), apply=True)
        assert r["pending"] == {}
        assert not any(c.startswith("remove") for h in r["hosts"] for c in h["changes"])
        assert mesh.run(net.cfg())["already"]
    assert mesh_files(net, "orion-2") == l1_files                    # L1's Mesh on orion-2 intact
    assert [x for x in net.mesh_lines("nas-1") if "@box" in x] == l1_nas
    assert any(x.endswith("roster-mesh:nas-1@l3") for x in net.mesh_lines("orion-2"))
    l3_nas = mesh_files(net, "nas-1")
    assert "(owner l3)" in l3_nas[0]["config"]
    r = mesh.run(net.cfg(), apply=True)                              # L1 again: L3's Mesh stays
    assert not any(c.startswith("remove") for h in r["hosts"] for c in h["changes"]), r["hosts"]
    assert mesh_files(net, "nas-1") == l3_nas
    assert any(x.endswith("roster-mesh:nas-1@l3") for x in net.mesh_lines("orion-2"))
    assert mesh.run(net.cfg())["already"]
    with l3:
        assert mesh.run(net.cfg())["already"]


def test_two_inventories_on_one_box_never_remove_each_others_mesh(net, isolated, capsys):
    """#379: two named Inventories on this Box that mesh the same machines: each one's apply, and dropping its Link,
    leaves the other's lines and files alone."""
    work = isolated["home"] / "work-inv"
    work.mkdir()
    (work / "roster.yml").write_text(L3_BOX.replace("box_name: l3\n", "box_name: box\n"))
    assert main(["inv", "add", "lab", str(net.cfg_path)]) == 0
    assert main(["inv", "add", "work", str(work / "roster.yml")]) == 0
    assert main(["--inv", "lab", "mesh"]) == 0
    lab_o2, lab_nas = mesh_files(net, "orion-2"), net.mesh_lines("nas-1")
    assert all(x.endswith("roster-mesh:orion-2@box/lab") for x in lab_nas)
    assert main(["--inv", "work", "mesh"]) == 0
    assert any(x.endswith("roster-mesh:nas-1@box/work") for x in net.mesh_lines("orion-2"))
    assert mesh_files(net, "orion-2") == lab_o2 and [x for x in net.mesh_lines("nas-1") if "/lab" in x] == lab_nas
    work_nas = mesh_files(net, "nas-1")
    capsys.readouterr()
    assert main(["--inv", "lab", "mesh"]) == 0
    assert "already in the mesh" in capsys.readouterr().out
    (work / "roster.yml").write_text(L3_BOX.replace("box_name: l3\n", "box_name: box\n").split("links:")[0])
    assert main(["--inv", "work", "mesh"]) == 0                      # work's Link gone: only work's entries go
    assert not any("@box/work" in x for x in net.mesh_lines("orion-2"))
    assert mesh_files(net, "nas-1") != work_nas and not (net.host("nas-1") / "home/.ssh/roster-mesh").exists()
    assert mesh_files(net, "orion-2") == lab_o2 and net.mesh_lines("nas-1") == lab_nas


def untag(net):
    """The Hosts as a roster before #379 left them: no Box in the tag, the key's comment or the files' headers."""
    for p in net.root.rglob("*"):
        if p.is_file() and p.name in ("authorized_keys", "id_ed25519.pub", "config", "ROSTER.md"):
            t = p.read_text()
            t = re.sub(r"(roster-mesh:[A-Za-z0-9._-]+)@[A-Za-z0-9_/.-]+$", r"\1", t, flags=re.M)
            t = re.sub(r"^(# Written by roster mesh for \S+) \(owner [^)]*\)", r"\1", t, flags=re.M)
            t = re.sub(r"^(<!-- roster-mesh: written by roster for \S+) \(owner [^)]*\)", r"\1", t, flags=re.M)
            p.write_text(t)
    f = mesh.state_file()
    if f.exists():                                      # and its Mesh record, which said no owner
        st = json.loads(f.read_text())
        st.pop("owner", None)
        f.write_text(json.dumps(st))


def test_an_older_rosters_entries_this_box_wrote_are_tagged_on_its_next_apply(net, capsys):
    mesh.run(net.cfg(), apply=True)
    tagged = net.snapshot()
    untag(net)
    assert not any("@box" in x for h in HOSTS for x in net.mesh_lines(h))
    r = mesh.run(net.cfg())                                          # the plan says so
    assert "tag key from orion-2 as this Box's" in next(h for h in r["hosts"] if h["host"] == "nas-1")["changes"]
    mesh.run(net.cfg(), apply=True)
    assert net.snapshot() == {k: v for k, v in tagged.items()
                              if not k.endswith("id_ed25519.pub")} | {k: v for k, v in net.snapshot().items()
                                                                      if k.endswith("id_ed25519.pub")}
    assert mesh.run(net.cfg())["already"]


def add_line(net, host, line):
    p = net.host(host) / "home/.ssh/authorized_keys"
    p.write_text(p.read_text() + line + "\n")


def test_the_one_time_retag_takes_only_a_line_identical_to_this_boxs_own(net, capsys):
    """#384 (1): another older Box's untagged line for the same source (here another from=) isn't this Box's to take:
    only the line this Box would write, with no Box in its tag, is re-tagged; the other stays as it was, and is said."""
    mesh.run(net.cfg(), apply=True)
    untag(net)
    ours = key_line_of(net, "orion-2", "10.0.0.2").removesuffix("@box")
    theirs = ours.replace('from="10.0.0.2"', 'from="10.0.0.99"')
    add_line(net, "nas-1", theirs)
    r = mesh.run(net.cfg())
    nas = next(h for h in r["hosts"] if h["host"] == "nas-1")
    assert "tag key from orion-2 as this Box's" in nas["changes"]
    r = mesh.run(net.cfg(), apply=True)
    lines = net.mesh_lines("nas-1")
    assert theirs in lines and ours not in lines
    assert key_line_of(net, "orion-2", "10.0.0.2") in lines
    assert any("nas-1" in w and "orion-2" in w and "no Box in its tag" in w for w in r.get("warnings", [])), r
    assert mesh.run(net.cfg())["already"]
    assert theirs in net.mesh_lines("nas-1")
    capsys.readouterr()
    assert main(["mesh", "--find-leftovers"]) == 0
    assert "nas-1: key from orion-2 (from=10.0.0.99), with no Box in its tag" in capsys.readouterr().out


def test_the_one_time_retag_leaves_an_untagged_line_with_other_options(net):
    mesh.run(net.cfg(), apply=True)
    untag(net)
    ours = key_line_of(net, "orion-2", "10.0.0.2").removesuffix("@box")
    other = ours.replace(",no-X11-forwarding", "")      # same key, other options: not the line this Box writes
    p = net.host("nas-1") / "home/.ssh/authorized_keys"
    p.write_text(p.read_text().replace(ours + "\n", other + "\n"))
    mesh.run(net.cfg(), apply=True)
    lines = net.mesh_lines("nas-1")
    assert other in lines and key_line_of(net, "orion-2", "10.0.0.2") in lines


def test_rotating_on_the_upgrade_takes_this_boxs_untagged_line_for_the_old_key(net):
    """--rotate on the first apply after upgrading: the untagged line for the key being replaced was this Box's
    (identical but for the tag), so it goes; the replaced key keeps no way in."""
    mesh.run(net.cfg(), apply=True)
    untag(net)
    old = key_line_of(net, "orion-2", "10.0.0.2").removesuffix("@box")
    r = mesh.run(net.cfg(), rotate=["orion-2"])
    assert "tag key from orion-2 as this Box's" in next(h for h in r["hosts"] if h["host"] == "nas-1")["changes"]
    mesh.run(net.cfg(), apply=True, rotate=["orion-2"])
    lines = net.mesh_lines("nas-1")
    assert old not in lines and old.split()[2] not in "".join(lines)
    assert key_line_of(net, "orion-2", "10.0.0.2") in lines


def test_an_older_rosters_entries_this_box_has_no_record_of_are_kept_and_found_as_leftovers(net, capsys, monkeypatch):
    mesh.run(net.cfg(), apply=True)
    untag(net)
    reinstall()                                         # no record: nothing proves they're this Box's
    old = {h: net.mesh_lines(h) for h in HOSTS}
    o2 = mesh_files(net, "orion-2")
    net.cfg_path.write_text(DROPPED)                    # orion-2 -> nas-1 no longer asked for
    mesh.run(net.cfg(), apply=True)
    assert all(x in net.mesh_lines(h) for h in HOSTS for x in old[h])          # unknown owner: kept
    assert mesh_files(net, "orion-2")[0] == o2[0]
    capsys.readouterr()
    assert main(["mesh", "--find-leftovers"]) == 0
    out = capsys.readouterr().out
    assert "nas-1: key from orion-2 (from=10.0.0.2), with no Box in its tag" in out
    assert "may be another Box's or another Inventory's Mesh" in out
    assert main(["mesh", "--remove-leftovers", "-y"]) == 0
    assert not any(x.endswith("roster-mesh:orion-2") for x in net.mesh_lines("nas-1"))


def test_a_new_box_with_the_same_roster_yml_adds_its_own_lines_and_takes_none(net):
    mesh.run(net.cfg(), apply=True)
    box = net.snapshot()
    other = Box(net, CONFIG.replace("box_name: box\n", "box_name: l2\n"))
    with other:
        r = mesh.run(net.cfg(), apply=True)
        assert r["pending"] == {}                       # the sources' files are box's, with the same peers: fine
        assert mesh.run(net.cfg())["already"]
    assert any(x.endswith("roster-mesh:orion-2@l2") for x in net.mesh_lines("nas-1"))
    assert all(x in net.ak(h) for h in HOSTS for x in net.mesh_lines(h) if "@box" in x)
    assert mesh_files(net, "orion-2")[0]["config"] == box["orion-2/home/.ssh/roster-mesh/config"].decode()
    with other:                                         # l2 drops its Link: only its own line goes
        net.cfg_path.write_text(DROPPED.replace("box_name: box\n", "box_name: l2\n"))
        mesh.run(net.cfg(), apply=True)
    assert [x for x in net.mesh_lines("nas-1") if "@" in x] == [key_line_of(net, "orion-2", "10.0.0.2")]


def test_a_source_whose_files_are_another_boxs_with_other_peers_is_pending_and_left_alone(net):
    mesh.run(net.cfg(), apply=True)
    o2 = mesh_files(net, "orion-2")
    with Box(net, L3_BOX.replace("from: nas-1, to: orion-2", "from: orion-2, to: nas-1")):
        r = mesh.run(net.cfg(), apply=True)
        assert "orion-2" in r["pending"] and "another Box's or Inventory's (box)" in r["pending"]["orion-2"]
        r = mesh.run(net.cfg(), apply=True, rotate=["orion-2"])         # nor is box's key replaced
        assert "is another Box's or Inventory's (box): roster doesn't replace it" in r["pending"]["orion-2"]
    assert mesh_files(net, "orion-2") == o2


def test_a_cut_says_when_an_older_rosters_line_it_cant_prove_is_still_there(net, capsys):
    mesh.run(net.cfg(), apply=True)
    untag(net)
    reinstall()                                         # no record: the older lines may be another Box's
    assert main(["mesh", "cut", "orion-3", "--yes"]) == 0
    out = capsys.readouterr().out
    assert "orion-2: a roster-mesh:orion-3 line with no Box in its tag is still there" in out
    assert any(x.endswith("roster-mesh:orion-3") for x in net.mesh_lines("orion-2"))


def test_cut_takes_this_boxs_lines_and_proven_older_ones_and_leaves_another_boxs(net, capsys):
    mesh.run(net.cfg(), apply=True)
    untag(net)                                          # this Box's, from before #379: its record proves it
    with Box(net, L3_BOX):
        mesh.run(net.cfg(), apply=True)
    assert main(["mesh", "cut", "orion-2", "--yes"]) == 0
    assert not any("roster-mesh:orion-2" in x for h in HOSTS for x in net.mesh_lines(h))
    assert any(x.endswith("roster-mesh:nas-1@l3") for x in net.mesh_lines("orion-2"))   # l3's: kept
    assert main(["mesh", "cut", "--all", "--yes"]) == 0
    assert [x for h in HOSTS for x in net.mesh_lines(h)] == [x for x in net.mesh_lines("orion-2") if "@l3" in x]
    assert (net.host("nas-1") / "home/.ssh/roster-mesh/config").exists()           # l3's files: kept


def test_a_renamed_box_takes_its_entries_under_the_earlier_name_with_it(net):
    """box_name: changed (or the Inventory named): its record says which owner its entries carry, so they're its own."""
    mesh.run(net.cfg(), apply=True)
    net.cfg_path.write_text(DROPPED.replace("box_name: box\n", "box_name: box2\n"))
    r = mesh.run(net.cfg(), apply=True)
    assert r["pending"] == {}
    assert not any("@box" in x and "@box2" not in x for h in HOSTS for x in net.mesh_lines(h))
    assert not any("roster-mesh:orion-2" in x for x in net.mesh_lines("nas-1"))      # its dropped Link's line too
    assert "(owner box2)" in net.file("orion-2", "home/.ssh/roster-mesh/config")
    assert mesh.run(net.cfg())["already"]


# ---------------------------------------------------------------- Windows Hosts (T196, #376, decision Q176)

WIN_MESH = CONFIG.replace("      new-1: { ip: 10.0.0.40, reviewed: false }\n",
                          "      new-1: { ip: 10.0.0.40, reviewed: false }\n"
                          "      win-1: { ip: 10.0.0.50, os: windows }\n") + \
    "  - { from: win-1, to: storage }\n  - { from: orion-3, to: nas-1, via: win-1 }\n"


@pytest.fixture
def win_net(net):
    """net, with win-1 (os: windows) in the meshed group, in a Link of its own and as another Link's hop: a stand-in
    Windows Host that would refuse any sh script the Mesh sent it."""
    (net.host("win-1") / "home").mkdir(parents=True)
    (net.host("win-1") / "windows").write_text("cmd")
    net.cfg_path.write_text(WIN_MESH)
    return net


def test_a_windows_host_is_left_out_of_the_mesh_with_its_reason(win_net):
    g = mesh.graph(win_net.cfg())
    assert g["excluded"]["win-1"].startswith("[160] os: windows")
    assert not any("win-1" in (x["from"], x["to"], x.get("via")) for x in g["links"])
    assert ("orion-2", "orion-3") in {(x["from"], x["to"]) for x in g["links"]}      # the rest of the group: as before
    assert "win-1" not in g["visit"]


def test_mesh_dry_run_and_apply_never_visit_a_windows_host_and_say_why(win_net, capsys):
    assert main(["mesh", "--dry-run"]) == 0
    assert "win-1 ([160] os: windows" in capsys.readouterr().out
    assert main(["mesh"]) == 0                       # a Link or meshed group naming it isn't an error
    assert "win-1 ([160] os: windows" in capsys.readouterr().out
    assert main(["mesh", "cut", "--all", "--yes"]) == 0
    assert not any(c.endswith(" win-1") for c in win_net.connections())


def test_mesh_status_and_check_say_why_a_windows_host_is_left_out(win_net, capsys):
    main(["mesh", "status"])
    assert "left out: " in (out := capsys.readouterr().out) and "win-1 ([160] os: windows" in out
    main(["check"])
    assert "mesh         left out: win-1 ([160] os: windows" in capsys.readouterr().out


def test_a_windows_host_once_in_the_mesh_is_never_visited_to_take_it_back(win_net):
    """A Host given os: windows after an apply (its Mesh never worked there: sh): the next run leaves it alone."""
    win_net.cfg_path.write_text(CONFIG)
    mesh.run(win_net.cfg(), apply=True)
    st = mesh.load_state()
    st["members"] = sorted({*st["members"], "win-1"})
    mesh.save_state(st)
    win_net.cfg_path.write_text(WIN_MESH)
    r = mesh.run(win_net.cfg(), apply=True)
    assert "win-1" not in r["pending"]
    assert not any(c.endswith(" win-1") for c in win_net.connections())


@pytest.mark.parametrize("argv", [["mesh", "cut", "win-1", "--yes"], ["mesh", "--find-leftovers"],
                                  ["mesh", "--remove-leftovers", "--yes"]])
def test_cut_and_leftovers_never_log_in_to_a_windows_host(win_net, argv):
    mesh.run(win_net.cfg(), apply=True)
    main(argv)
    assert not any(c.endswith(" win-1") for c in win_net.connections())
