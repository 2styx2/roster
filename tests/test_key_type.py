"""T239 (#436): the SSH key type roster uses for a Host (`key_type:`), so a FIPS-mode Host that refuses Ed25519 can
still log in by key. ed25519 stays the default, with its paths unchanged."""

import pytest

from roster.config import load_config

FIPS_YML = """\
box_name: ws1
groups:
  web:
    user: ops
    hosts:
      web-01: 10.0.0.4
  fips-lab:
    user: ops
    key_type: ecdsa
    hosts:
      fips-01: 10.0.0.5
      fips-02: {ip: 10.0.0.6, key_type: rsa}
"""


def test_key_type_cascades_host_over_group_over_top_level_with_one_key_file_per_type(write_config, isolated):
    cfg = load_config(write_config(FIPS_YML))
    ssh = isolated["home"] / ".ssh"
    got = {n: (h["key_type"], h["key_file"]) for n, h in cfg["hosts"].items()}
    assert got == {"web-01": ("ed25519", str(ssh / "roster_ed25519")),
                   "fips-01": ("ecdsa", str(ssh / "roster_ecdsa")),
                   "fips-02": ("rsa", str(ssh / "roster_rsa"))}
    assert cfg["key"] == ssh / "roster_ed25519"           # this Box's key: unchanged


def test_top_level_key_type_is_the_boxs_key(write_config, isolated):
    cfg = load_config(write_config("key_type: ecdsa-521\n" + FIPS_YML))
    ssh = isolated["home"] / ".ssh"
    assert cfg["key_type"] == "ecdsa-521" and cfg["key"] == ssh / "roster_ecdsa-521"
    assert cfg["hosts"]["web-01"]["key_type"] == "ecdsa-521"
    assert cfg["hosts"]["fips-01"]["key_type"] == "ecdsa"


@pytest.mark.parametrize(("written", "canonical"), [
    ("ED25519", "ed25519"), ("ecdsa-384", "ecdsa"), ("ecdsa-256", "ecdsa-256"), ("rsa-3072", "rsa"),
    ("rsa-4096", "rsa-4096")])
def test_key_type_spellings(write_config, written, canonical):
    cfg = load_config(write_config(FIPS_YML.replace("key_type: rsa", f"key_type: {written}")))
    assert cfg["hosts"]["fips-02"]["key_type"] == canonical


@pytest.mark.parametrize("bad", ["dsa", "rsa-2048", "ecdsa-128", "rsa-99999", "true", "[ecdsa]"])
def test_an_unknown_key_type_fails_at_load_naming_the_allowed_values(write_config, bad):
    with pytest.raises(SystemExit, match=r"host 'fips-02': key_type: .* \(ed25519, ecdsa .*rsa"):
        load_config(write_config(FIPS_YML.replace("key_type: rsa", f"key_type: {bad}")))


def test_a_bad_key_type_on_a_group_without_hosts_or_at_the_top_still_fails(write_config):
    with pytest.raises(SystemExit, match="group 'empty': key_type"):
        load_config(write_config(FIPS_YML + "  empty:\n    key_type: dsa\n    hosts: {}\n"))
    with pytest.raises(SystemExit, match="^error: key_type: .dsa."):
        load_config(write_config("key_type: dsa\n" + FIPS_YML))


def test_a_host_listed_in_two_groups_names_both(write_config):
    with pytest.raises(SystemExit, match="listed twice.*'web'.*'fips-lab'"):
        load_config(write_config(FIPS_YML.replace("fips-01: 10.0.0.5", "web-01: 10.0.0.5")))


def test_key_path_names_the_boxs_key_and_the_others_sit_beside_it(write_config, isolated):
    cfg = load_config(write_config("key_path: ~/keys/mine\n" + FIPS_YML))
    assert cfg["hosts"]["web-01"]["key_file"] == str(isolated["home"] / "keys" / "mine")
    assert cfg["hosts"]["fips-01"]["key_file"] == str(isolated["home"] / "keys" / "roster_ecdsa")


def test_key_path_cant_be_another_types_key_file(write_config):
    with pytest.raises(SystemExit, match="key_path.*roster_ecdsa.*ecdsa"):
        load_config(write_config("key_path: ~/.ssh/roster_ecdsa\n" + FIPS_YML))


@pytest.mark.parametrize(("name", "word", "bits"), [
    ("ed25519", "ssh-ed25519", "256"), ("ecdsa", "ecdsa-sha2-nistp384", "384"),
    ("ecdsa-256", "ecdsa-sha2-nistp256", "256"), ("rsa", "ssh-rsa", "3072")])
def test_ensure_key_makes_each_type_once_with_the_boxs_tag(write_config, isolated, name, word, bits):
    import subprocess

    from roster import boxkeys
    from roster.sshops import ensure_key, public_key_line
    cfg = load_config(write_config(FIPS_YML.replace("key_type: rsa", f"key_type: {name}")))
    key = boxkeys.for_host(cfg["hosts"]["fips-02"])
    ensure_key(key, cfg["tag"])
    assert key.key == isolated["home"] / ".ssh" / f"roster_{name}"
    line = public_key_line(key, cfg["tag"])
    assert line.split()[0] == word and line.endswith(" roster-managed:ws1")
    shown = subprocess.run(["ssh-keygen", "-l", "-f", str(key.pub)], capture_output=True, text=True).stdout
    assert shown.split()[0] == bits
    before = key.key.read_bytes()
    ensure_key(key, cfg["tag"])                                 # there already: kept
    assert key.key.read_bytes() == before
    assert not (isolated["home"] / ".ssh" / "roster_ed25519").exists() or name == "ed25519"


def test_ensure_key_refuses_a_key_of_another_type_at_its_path(write_config, isolated):
    from roster import boxkeys
    from roster.sshops import ensure_key
    cfg = load_config(write_config(FIPS_YML))
    key = boxkeys.for_host(cfg["hosts"]["fips-01"])
    key.key.parent.mkdir(parents=True)
    key.key.write_text("x")
    key.pub.write_text("ssh-ed25519 AAAAC3Nza roster-managed:ws1\n")
    with pytest.raises(SystemExit, match=r"\[201\] .*roster_ecdsa.* is an ssh-ed25519 key, not ecdsa"):
        ensure_key(key, cfg["tag"])


def test_sync_writes_each_hosts_identityfile_for_its_own_key_type(write_config, isolated):
    from roster.sshops import write_ssh_config
    write_ssh_config(load_config(write_config(FIPS_YML)))
    text = (isolated["home"] / ".ssh" / "config.d" / "roster").read_text()
    ssh = isolated["home"] / ".ssh"
    for name, file in (("web-01", "roster_ed25519"), ("fips-01", "roster_ecdsa"), ("fips-02", "roster_rsa")):
        block = text.split(f"Host {name}\n")[1].split("\n\n")[0]
        assert f'    IdentityFile "{ssh / file}"\n    IdentitiesOnly yes' in block, name
        assert block.count("IdentityFile") == 1


# ---------------------------------------------------------------- setup and revoke on stand-in Hosts (tests/fakes/ssh)

LAB_YML = """\
box_name: ws1
groups:
  lab:
    user: ops
    auth: env:PW
    hosts:
      web-01: 10.0.0.4
      fips-01: {{ip: 10.0.0.5{fips}}}
"""


@pytest.fixture
def lab(fakes, isolated, write_config, monkeypatch):
    """Two stand-in Hosts: web-01 (any key type in its authorized_keys) and fips-01, a FIPS-mode Host that refuses Ed25519 and takes a key only
    once it's in its authorized_keys. Setup's password login is the stand-in ssh too (FAKE_SSH_AS_PASSWORD)."""
    import subprocess
    import sys

    from conftest import POSIX_SH, WINDOWS

    from roster import cli, sshops
    if WINDOWS:
        pytest.skip("the stand-in Hosts' key scripts run in a POSIX sh")
    for f in (fakes / "host").iterdir():
        f.chmod(0o755)
    root = isolated["home"].parent / "hosts"
    for name in ("web-01", "fips-01"):
        (root / name / "home" / ".ssh").mkdir(parents=True)
        (root / name / "home" / ".ssh" / "authorized_keys").write_text("ssh-ed25519 AAAAown own@laptop\n")
    (root / "fips-01" / "fips").touch()
    (root / "web-01" / "keys").touch()
    monkeypatch.setenv("FAKE_HOSTS", str(root))
    monkeypatch.setenv("FAKE_SH", POSIX_SH)
    monkeypatch.setattr(cli, "record_fingerprints", lambda cfg, hosts: set())
    monkeypatch.setenv("PW", "pw")                              # auth: env:PW (a stand-in: no Host checks it)
    monkeypatch.setattr(sshops, "password_exec", lambda h, command, pw, **k: (
        lambda r: (r.returncode, r.stdout, r.stderr))(subprocess.run(
            [sys.executable, str(fakes / "ssh"), h["name"], command], capture_output=True, text=True,
            env={**__import__("os").environ, "FAKE_SSH_AS_PASSWORD": "1"})))

    class Lab:
        def write(self, fips=""):
            write_config(LAB_YML.format(fips=fips))

        def lines(self, name):
            text = (root / name / "home" / ".ssh" / "authorized_keys").read_text()
            return [ln for ln in text.splitlines() if "roster-managed:" in ln]

        def kinds(self, name):
            return [ln.split()[0] for ln in self.lines(name)]
    return Lab()


def test_setup_installs_each_hosts_own_key_type_once_and_revoke_takes_them_all(lab, capsys, isolated):
    from roster.cli import main
    lab.write(", key_type: ecdsa")
    for _ in range(2):                                          # idempotent: no second line
        assert main(["setup"]) == 0, capsys.readouterr().out
        assert lab.kinds("web-01") == ["ssh-ed25519"]
        assert lab.kinds("fips-01") == ["ecdsa-sha2-nistp384"]
    assert "2 already work, 0 need the key installed" in capsys.readouterr().out
    ssh = isolated["home"] / ".ssh"
    assert (ssh / "roster_ed25519").exists() and (ssh / "roster_ecdsa").exists()
    assert main(["revoke", "-y"]) == 0
    out = capsys.readouterr().out
    assert lab.lines("web-01") == [] and lab.lines("fips-01") == []
    assert str(ssh / "roster_ecdsa") in out and str(ssh / "roster_ed25519") in out      # every key file to delete


def test_a_type_change_then_setup_replaces_the_old_key_and_revoke_leaves_none(lab, capsys):
    from roster.cli import main
    lab.write()                                                 # Ed25519 on a FIPS Host: installed, refused
    assert main(["setup"]) == 1
    assert "FAIL  fips-01: key installed but key login still fails" in capsys.readouterr().out
    assert lab.kinds("fips-01") == ["ssh-ed25519"]
    lab.write(", key_type: rsa")
    assert main(["setup"]) == 0
    assert lab.kinds("fips-01") == ["ssh-rsa"]                  # the Ed25519 line went with the install
    lab.write(", key_type: ecdsa-256")
    assert main(["setup"]) == 0
    assert lab.kinds("fips-01") == ["ecdsa-sha2-nistp256"]
    lab.write()                                                 # back to Ed25519 in roster.yml: revoke still finds it
    assert main(["revoke", "-y"]) == 0
    assert lab.lines("fips-01") == [] and lab.lines("web-01") == []


def test_setup_key_type_overrides_roster_yml_for_that_run_and_says_so(lab, capsys, isolated):
    from roster.cli import main
    lab.write()
    assert main(["setup", "--host", "fips-01", "--key-type", "ecdsa"]) == 0
    out = capsys.readouterr().out
    assert "--key-type ecdsa for 1 host whose roster.yml says otherwise (fips-01)" in out
    assert "set key_type: ecdsa on them in roster.yml" in out
    assert lab.kinds("fips-01") == ["ecdsa-sha2-nistp384"] and lab.lines("web-01") == []
    assert not (isolated["home"] / ".ssh" / "roster_ed25519").exists()      # no key it didn't need
    with pytest.raises(SystemExit, match="--key-type: 'rsa-1024' isn't a key type"):
        main(["setup", "--key-type", "rsa-1024"])


def test_setup_on_a_renamed_box_retags_each_key_type(lab, capsys, write_config):
    from roster.cli import main
    lab.write(", key_type: ecdsa")
    assert main(["setup"]) == 0
    write_config(LAB_YML.format(fips=", key_type: ecdsa").replace("box_name: ws1", "box_name: ws2"))
    assert main(["setup"]) == 0
    assert "ok    fips-01 (re-tagged)" in capsys.readouterr().out
    assert [ln.split()[-1] for ln in lab.lines("fips-01")] == ["roster-managed:ws2"]
    assert [ln.split()[-1] for ln in lab.lines("web-01")] == ["roster-managed:ws2"]
    assert main(["revoke", "-y"]) == 0
    assert lab.lines("fips-01") == [] and lab.lines("web-01") == []


def test_hosts_name_shows_the_key_type_and_file_and_json_carries_them(write_config, capsys, isolated):
    import json

    from roster.cli import main
    write_config(FIPS_YML + "      pw-01: {ip: 10.0.0.7, enroll: false, auth: 'env:PW'}\n")
    ssh = isolated["home"] / ".ssh"
    assert main(["hosts", "fips-01"]) == 0
    out = capsys.readouterr().out
    assert f"key          ecdsa {ssh / 'roster_ecdsa'}" in out.splitlines()
    assert main(["hosts", "pw-01"]) == 0
    assert "key " not in capsys.readouterr().out                    # a password Host has none
    assert main(["hosts", "fips-02", "--json"]) == 0
    host = json.loads(capsys.readouterr().out)["host"]
    assert (host["key_type"], host["key_file"]) == ("rsa", str(ssh / "roster_rsa"))


# ---------------------------------------------------------------- roster check HOST on a FIPS-mode Host

def nist_only_sshd(fips):
    """test_check's stand-in sshd (key exchange only, an ECDSA P-256 host key); FIPS: it offers only NIST kex, as a
    FIPS-mode sshd does (no curve25519)."""
    from test_check import Sshd

    class Fips(Sshd):
        def _serve(self, conn):
            import paramiko
            t = paramiko.Transport(conn)
            t.get_security_options().kex = ("ecdh-sha2-nistp256", "ecdh-sha2-nistp384")
            t.add_server_key(self.key)
            try:
                t.start_server(server=paramiko.ServerInterface())
                t.join(5)
            except Exception:  # noqa: S110 - a stand-in server thread
                pass
            finally:
                t.close()
    return Fips() if fips else Sshd()


@pytest.mark.parametrize("fips", [True, False])
def test_check_on_a_host_that_refuses_ed25519_and_offers_only_nist_suggests_key_type_ecdsa(
        fips, fakes, isolated, write_config, capsys, monkeypatch):
    from test_serve import synced

    from roster.cli import main
    sshd = nist_only_sshd(fips)
    try:
        root = isolated["home"].parent / "hosts"
        (root / "fips-01" / "home" / ".ssh").mkdir(parents=True)
        (root / "fips-01" / "home" / ".ssh" / "authorized_keys").write_text("")
        (root / "fips-01" / ("fips" if fips else "keys")).touch()
        monkeypatch.setenv("FAKE_HOSTS", str(root))
        synced(write_config, capsys, f"groups:\n  lab:\n    user: ops\n    port: {sshd.port}\n"
                                     "    hosts:\n      fips-01: 127.0.0.1\n")
        (isolated["home"] / ".ssh" / "roster_known_hosts").write_text(sshd.known_hosts_line())
        assert main(["check", "fips-01"]) == 1
        out = capsys.readouterr().out
    finally:
        sshd.close()
    auth = next(ln for ln in out.splitlines() if " auth " in ln)
    if fips:
        assert "[199] fips-01 refused this Box's Ed25519 key and offers only NIST algorithms" in auth, out
        assert "key_type: ecdsa" in out and "roster setup --host fips-01" in out
    else:                                                       # curve25519 offered: not FIPS, the usual fix
        assert "[46] fips-01 didn't accept this box's key" in auth, out
        assert "key_type" not in out


# ---------------------------------------------------------------- the Mesh: Ed25519 only for now (decision Q200)

MESH_YML = """\
groups:
  lab:
    user: ops
    mesh: true
    hosts:
      a-01: 10.0.0.1
      a-02: 10.0.0.2
      fips-01: {ip: 10.0.0.5, key_type: ecdsa}
  far:
    user: ops
    hosts:
      b-01: 10.0.0.9
links:
  - {from: b-01, to: a-01, via: fips-01}
  - {from: b-01, to: fips-01}
"""


def test_the_mesh_leaves_a_host_whose_key_type_isnt_ed25519_out_and_says_why(write_config):
    from roster import mesh
    g = mesh.graph(load_config(write_config(MESH_YML)))
    assert g["excluded"]["fips-01"].startswith("[200] key_type: ecdsa: the Mesh's keys are Ed25519")
    assert not any("fips-01" in (x["from"], x["to"], x.get("via")) for x in g["links"])
    assert {(x["from"], x["to"]) for x in g["links"]} == {("a-01", "a-02"), ("a-02", "a-01")}


def test_moving_a_host_out_of_its_key_type_group_keeps_its_key_type(write_config):
    from roster import edit
    path = write_config(FIPS_YML)
    _, text, h, pinned = edit.moved(path, "fips-01", "web")
    assert h["key_type"] == "ecdsa" and "key_type" in pinned and "key_type: ecdsa" in text
    _, text, h, pinned = edit.moved(path, "web-01", "fips-lab")             # into it: ed25519 written on it
    assert h["key_type"] == "ed25519" and "key_type" in pinned


def test_a_stray_public_key_without_its_private_key_never_widens_what_revoke_matches(write_config, isolated):
    from roster.sshops import box_key_re
    cfg = load_config(write_config(FIPS_YML))
    ssh = isolated["home"] / ".ssh"
    ssh.mkdir()
    (ssh / "roster_rsa-4096.pub").write_text("ssh-rsa AAAAothersbox roster-managed:ws9\n")
    assert "AAAAothersbox" not in box_key_re(cfg)
    (ssh / "roster_rsa-4096").write_text("private")            # this Box's own leftover key of a type no Host uses now
    assert "AAAAothersbox" in box_key_re(cfg)
