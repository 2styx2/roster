"""The Mesh (ticket 39, decision Q63): roster.yml's mesh: and links:, and `roster mesh` against stand-in Hosts
(tests/fakes/ssh with FAKE_HOSTS). Nothing here connects anywhere: each Host is a directory."""
import json
import os
import shutil
import subprocess
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
    return f'from="{dst_ip}",no-agent-forwarding,no-X11-forwarding {pub[0]} {pub[1]} roster-mesh:{src}'


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
    script = mesh.write_script(h, "apply", {}, [], set())
    body = script[script.index("replace() {"):script.index("put() {")]
    mv = body.index('mv -f "$n" "$f"')
    assert body.index('chcon --reference="$f" "$n"') < mv < body.index('restorecon -F "$f"')
    assert "replace" in mesh.cut_script(h, "orion-3", False)


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
    assert cut["change"]["written"] is True
    assert s.call("hosts.list")["result"]["hosts"][0]["mesh"] is False
    json.dumps(cut)


def wait_for(s, job, until=lambda j: j["state"] != "running", seconds=20):
    """Polls mesh.job, as the Mesh controls Plugin does, until UNTIL holds; returns the last answer."""
    import time
    end = time.monotonic() + seconds
    while True:
        j = s.call("mesh.job", {"job": job})["result"]
        if until(j) or time.monotonic() > end:
            return j
        time.sleep(0.05)


def test_serve_runs_a_mesh_job_in_the_background_and_answers_meanwhile(net, serve):
    s = serve("-c", str(net.cfg_path))
    assert s.call("mesh.job")["result"] is None                         # no job yet
    (net.host("orion-2") / "slow").write_text("1")                      # its step takes a second
    started = s.call("mesh.plan", {"background": True})["result"]
    assert started["action"] == "plan" and started["total"] > 0 and isinstance(started["job"], int)
    # serve answers other requests while the job runs, and another Mesh run is refused
    assert s.call("mesh.status")["result"]["out_of_date"] is True
    busy = s.call("mesh.apply", {"background": True})["error"]
    assert busy["code"] == 111 and busy["data"]["job"] == started["job"]
    assert s.call("mesh.apply")["error"]["code"] == 111
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
    (net.host("orion-2") / "slow").write_text("1")
    started = s.call("mesh.apply", {"background": True})["result"]
    j = wait_for(s, started["job"], until=lambda j: j["at"] == "orion-2" or j["state"] != "running")
    assert j["state"] == "running" and 0 <= j["done"] < j["total"] and "result" not in j


def test_stopping_a_job_leaves_the_rest_pending_for_the_next_run(net, serve):
    s = serve("-c", str(net.cfg_path))
    (net.host("orion-2") / "slow").write_text("1")
    started = s.call("mesh.apply", {"background": True})["result"]
    wait_for(s, started["job"], until=lambda j: j["at"] == "orion-2")
    assert s.call("mesh.stop", {"job": started["job"]})["result"] == {"job": started["job"], "stopping": True}
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


def test_serve_closing_mid_job_stops_it_and_records_what_it_didnt_finish(net, serve):
    # review 8 #4: closing serve (the app closes its stdin, then kills it a second later) stopped a scan but left a
    # Mesh job's daemon thread to die mid-apply, so mesh.json never said which Hosts were left to do
    import time
    s = serve("-c", str(net.cfg_path))
    (net.host("orion-2") / "slow").write_text("60")                     # its step would take a minute
    started = s.call("mesh.apply", {"background": True})["result"]
    assert wait_for(s, started["job"], until=lambda j: j["at"] == "orion-2")["state"] == "running"
    time.sleep(0.3)                                                     # its ssh has started
    t = time.monotonic()
    code, _, _ = s.close()
    assert code == 0 and time.monotonic() - t < 5                     # not after the step (a minute)
    pending = mesh.load_state()["pending"]
    assert "orion-2" in pending and "serve closed" in pending["orion-2"]
    assert set(pending) >= {"orion-3", "nas-1"}                         # not visited: the next run finishes them


def test_serve_closing_mid_foreground_apply_stops_it_and_records_it_too(net, serve):
    # T104 (#182): the waiting form (no background) is a job as well, so quitting the app stops it and mesh.json
    # says what it didn't do, as for a background run
    import time
    s = serve("-c", str(net.cfg_path))
    (net.host("orion-2") / "slow").write_text("60")
    s.request("mesh.apply")                                             # waits for its result: never answered here
    end = time.monotonic() + 15
    while not any(n["params"].get("at") == "orion-2" for n in s.notes if n["method"] == "job.progress"):
        assert time.monotonic() < end, "never got to orion-2"
        s.notes.append(json.loads(s.p.stdout.readline()))
    time.sleep(0.3)                                                     # its ssh has started
    t = time.monotonic()
    code, out, _ = s.close()
    assert code == 0 and time.monotonic() - t < 3                     # inside the app's EXIT_GRACE
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
    assert job.wait(20)
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
    (net.host("orion-2") / "slow").write_text("1")
    started = s.call("mesh.apply", {"background": True})["result"]
    wait_for(s, started["job"], until=lambda j: j["at"] == "orion-2")
    assert s.call("jobs.stop", {"kind": "mesh", "job": started["job"]})["result"]["stopping"] is True
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
