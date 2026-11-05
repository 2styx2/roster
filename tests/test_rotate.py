"""T240 (#469, decision Q204): `roster setup --rotate` replaces this Box's key on its Hosts: a new key beside the old,
on each Host one at a time (the old key logs in, the new line goes in, the new key logs in), the old key's lines off
only once every Host reached has proven the new one, then the old private key deleted (kept as `.old` while a Host is
pending). Against stand-in Hosts (tests/fakes/ssh, FAKE_HOSTS) whose sshd checks the key offered."""

import subprocess
import sys

import pytest

from roster.cli import main

LAB_YML = """\
box_name: ws1
groups:
  lab:
    user: ops
    auth: env:PW
    hosts:
      web-01: 10.0.0.4
      web-02: 10.0.0.5
      db-01: 10.0.0.6
"""


@pytest.fixture
def lab(fakes, isolated, write_config, monkeypatch, request):
    """Three stand-in Hosts whose sshd takes a key only once it's in their authorized_keys (FAKE_HOSTS' `keys`), each
    with a line of the user's own; `roster setup` has put this Box's key on them. Setup's password login is the
    stand-in ssh too (FAKE_SSH_AS_PASSWORD)."""
    from conftest import POSIX_SH, WINDOWS

    from roster import cli, sshops
    if WINDOWS:
        pytest.skip("the stand-in Hosts' key scripts run in a POSIX sh")
    for f in (fakes / "host").iterdir():
        f.chmod(0o755)
    root = isolated["home"].parent / "hosts"
    for name in ("web-01", "web-02", "db-01"):
        (root / name / "home" / ".ssh").mkdir(parents=True)
        (root / name / "home" / ".ssh" / "authorized_keys").write_text("ssh-ed25519 AAAAown own@laptop\n")
        (root / name / "keys").touch()
    monkeypatch.setenv("FAKE_HOSTS", str(root))
    monkeypatch.setenv("FAKE_SH", POSIX_SH)
    monkeypatch.setattr(cli, "record_fingerprints", lambda cfg, hosts: set())
    monkeypatch.setenv("PW", "pw")
    monkeypatch.setattr(sshops, "password_exec", lambda h, command, pw, **k: (
        lambda r: (r.returncode, r.stdout, r.stderr))(subprocess.run(
            [sys.executable, str(fakes / "ssh"), h["name"], command], capture_output=True, text=True,
            env={**__import__("os").environ, "FAKE_SSH_AS_PASSWORD": "1"})))
    ssh = isolated["home"] / ".ssh"

    class Lab:
        hosts = root
        key = ssh / "roster_ed25519"

        def write(self, text=LAB_YML):
            return write_config(text)

        def lines(self, name):
            text = (root / name / "home" / ".ssh" / "authorized_keys").read_text()
            return [ln for ln in text.splitlines() if "roster-managed:" in ln]

        def keys(self, name):
            """The base64 keys of this Box's lines on NAME."""
            return [ln.split()[1] for ln in self.lines(name)]

        def logs_in(self, name, key):
            """Does KEY (a private key file) log in to NAME, offered alone?"""
            conf = isolated["home"].parent / "one-key.conf"
            conf.write_text(f"Host {name}\n    IdentityFile \"{key}\"\n    IdentitiesOnly yes\n")
            return subprocess.run([sys.executable, str(fakes / "ssh"), "-F", str(conf), name, "exit 0"],
                                  capture_output=True).returncode == 0

        def down(self, name, down=True):
            (root / name / "down").touch() if down else (root / name / "down").unlink()
    lab = Lab()
    hk = isolated["home"].parent / "hk"
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(hk)], check=True)
    ssh.mkdir(exist_ok=True)
    (ssh / "roster_known_hosts").write_text("".join(f"10.0.0.{i} ssh-ed25519 {pub_key(hk)}\n" for i in (4, 5, 6)))
    lab.write(getattr(request, "param", LAB_YML))
    assert main(["setup"]) == 0
    return lab


def pub_key(path):
    return path.with_name(path.name + ".pub").read_text().split()[1]


def test_rotation_with_every_host_reachable_leaves_only_the_new_keys_lines(lab, capsys, tmp_path):
    old = lab.key.read_bytes()
    old_pub = pub_key(lab.key)
    keep = tmp_path / "old-key"
    keep.write_bytes(old)
    keep.chmod(0o600)
    capsys.readouterr()
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    new_pub = pub_key(lab.key)
    assert new_pub != old_pub
    for name in ("web-01", "web-02", "db-01"):
        assert lab.keys(name) == [new_pub], name
        assert lab.lines(name)[0].endswith(" roster-managed:ws1")
        assert "ssh-ed25519 AAAAown own@laptop" in (lab.hosts / name / "home/.ssh/authorized_keys").read_text()
        assert lab.logs_in(name, lab.key)
        assert not lab.logs_in(name, keep)                      # the old key no longer logs in
    ssh = lab.key.parent
    # the old private key is gone once every Host has lost its line: no .old, no .new left behind
    assert sorted(p.name for p in ssh.glob("roster_ed25519*")) == ["roster_ed25519", "roster_ed25519.pub"]
    assert lab.key.read_text() != old.decode()


def identity_files(isolated, name):
    text = (isolated["home"] / ".ssh" / "config.d" / "roster").read_text()
    block = text.split(f"Host {name}\n")[1].split("\n\n")[0]
    return [ln.split(None, 1)[1].strip('"') for ln in block.splitlines() if ln.strip().startswith("IdentityFile ")]


def test_an_unreachable_host_stays_pending_with_both_keys_and_a_rerun_finishes_it(lab, capsys, isolated):
    old_pub = pub_key(lab.key)
    lab.down("db-01")
    capsys.readouterr()
    assert main(["setup", "--rotate"]) == 1
    out = capsys.readouterr().out
    assert "[206] Box key rotation pending on 1 Host" in out and "db-01: not reached with the old key" in out
    new_pub = pub_key(lab.key)
    assert lab.keys("web-01") == [new_pub] and lab.keys("web-02") == [new_pub]
    old = lab.key.with_name("roster_ed25519.old")
    assert pub_key(old) == old_pub                              # the old key kept while a Host needs it
    assert oct(old.stat().st_mode & 0o777) == "0o600"
    # the ssh config offers db-01 both keys (new, then old), the others only the new one
    assert identity_files(isolated, "db-01") == [str(lab.key), str(old)]
    assert identity_files(isolated, "web-01") == [str(lab.key)]
    assert main(["check"]) == 1
    assert "Box key rotation pending on 1 Host: db-01" in capsys.readouterr().out
    assert main(["setup"]) == 1                                 # LOW-5: plain setup never looks done
    assert "Box key rotation pending on 1 Host (db-01)" in capsys.readouterr().out
    assert main(["check", "--box"]) == 0                        # box.check's: a warning, never an error
    assert "warn   [206] Box key rotation pending on 1 Host: db-01" in capsys.readouterr().out
    lab.down("db-01", False)
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    assert lab.keys("db-01") == [new_pub] and lab.keys("web-01") == [new_pub]
    assert not old.exists() and not old.with_name("roster_ed25519.old.pub").exists()
    assert identity_files(isolated, "db-01") == [str(lab.key)]
    assert not (isolated["home"] / ".config" / "roster" / "key-rotation").exists()
    assert main(["check"]) == 0, capsys.readouterr().out


def test_a_host_that_refuses_the_new_key_stops_every_removal(lab, capsys):
    old_pub = pub_key(lab.key)
    (lab.hosts / "web-02" / "refuse").write_text("*.new\n")
    capsys.readouterr()
    assert main(["setup", "--rotate"]) == 1
    out = capsys.readouterr().out
    assert "FAIL     web-02: [208] the new key's line went in, but the new key doesn't log in" in out
    assert "no old key line was taken off anywhere" in out
    for name in ("web-01", "web-02", "db-01"):                  # every Host keeps the old key's line
        assert old_pub in lab.keys(name), name
    assert pub_key(lab.key) == old_pub                          # and the old key stays the key
    assert lab.logs_in("web-01", lab.key) and lab.logs_in("web-02", lab.key)
    (lab.hosts / "web-02" / "refuse").unlink()
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    new_pub = pub_key(lab.key)
    assert new_pub != old_pub
    assert all(lab.keys(n) == [new_pub] for n in ("web-01", "web-02", "db-01"))


MV_FAILS = """\
#!/bin/sh
# a Host where the rewrite that takes a line off fails (a read-only key file, say), while one that adds still works
src=$2; dst=$3
if [ -e "$FAKE_HOST_ROOT/cleanup-fails" ] && [ -f "$dst" ] && [ "$(wc -l < "$src")" -lt "$(wc -l < "$dst")" ]; then
    echo "mv: cannot move '$src': Read-only file system" >&2
    exit 1
fi
exec /bin/mv "$@"
"""


def test_a_cleanup_that_fails_once_is_reported_and_a_rerun_finishes_it(lab, capsys, tmp_path, monkeypatch):
    """#471's review LOW-5: the old line left by a failed cleanup must not let the next run report success."""
    tools = tmp_path / "host-tools"
    tools.mkdir()
    (tools / "mv").write_text(MV_FAILS)
    (tools / "mv").chmod(0o755)
    monkeypatch.setenv("FAKE_HOST_PATH", str(tools))
    old_pub = pub_key(lab.key)
    (lab.hosts / "web-01" / "cleanup-fails").touch()
    capsys.readouterr()
    assert main(["setup", "--rotate"]) == 1
    out = capsys.readouterr().out
    assert "web-01: the new key works, but the old key's line couldn't be taken off" in out
    new_pub = pub_key(lab.key)
    assert lab.keys("web-01") == [old_pub, new_pub]             # both: the old one still logs in there
    assert lab.key.with_name("roster_ed25519.old").exists()
    for _ in range(2):                                          # a key login works, yet it's never "done"
        assert main(["check"]) == 1
        assert "Box key rotation pending on 1 Host: web-01" in capsys.readouterr().out
        assert main(["setup"]) == 1
    (lab.hosts / "web-01" / "cleanup-fails").unlink()
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    assert lab.keys("web-01") == [new_pub]
    assert not lab.key.with_name("roster_ed25519.old").exists()


def test_key_type_with_rotate_changes_type_and_key_in_one_pass(lab, capsys, isolated):
    old_pub = pub_key(lab.key)
    yml = LAB_YML.replace("      db-01: 10.0.0.6", "      db-01: {ip: 10.0.0.6, key_type: ecdsa}")
    lab.write(yml)
    with pytest.raises(SystemExit, match="--key-type rsa with --rotate: roster.yml gives db-01 another key type"):
        main(["setup", "--rotate", "--host", "db-01", "--key-type", "rsa"])
    assert main(["setup", "--rotate", "--host", "db-01", "--key-type", "ecdsa"]) == 0, capsys.readouterr().out
    ecdsa = isolated["home"] / ".ssh" / "roster_ecdsa"
    assert [ln.split()[0] for ln in lab.lines("db-01")] == ["ecdsa-sha2-nistp384"]    # the Ed25519 line went
    assert lab.keys("db-01") == [pub_key(ecdsa)]
    assert lab.keys("web-01") == [old_pub]                      # out of scope, another key: untouched


def test_host_narrows_the_run_and_the_rest_stay_pending(lab, capsys):
    capsys.readouterr()
    assert main(["setup", "--rotate", "--host", "web-01"]) == 1
    out = capsys.readouterr().out
    assert "Box key rotation pending on 2 Hosts" in out and "db-01: not in this run (--host)" in out
    new_pub = pub_key(lab.key)
    assert lab.keys("web-01") == [new_pub]
    assert new_pub not in lab.keys("db-01")
    assert lab.logs_in("db-01", lab.key.with_name("roster_ed25519.old"))
    assert main(["setup", "--rotate", "--host", "lab"]) == 0, capsys.readouterr().out      # a group
    assert all(lab.keys(n) == [new_pub] for n in ("web-01", "web-02", "db-01"))


def test_setup_rotate_takes_no_host_word_and_a_dry_run_changes_nothing(lab, capsys, isolated):
    before = {n: lab.lines(n) for n in ("web-01", "web-02", "db-01")}
    key = lab.key.read_bytes()
    with pytest.raises(SystemExit):
        main(["setup", "--rotate", "web-01"])                   # never quietly everything
    assert "unrecognized arguments" in capsys.readouterr().err
    with pytest.raises(SystemExit, match="unknown host or group 'nope'"):
        main(["setup", "--rotate", "--host", "nope"])
    assert main(["setup", "--rotate", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "would rotate the Box key on web-01" in out and "dry run: nothing was changed" in out
    assert {n: lab.lines(n) for n in before} == before and lab.key.read_bytes() == key
    assert not lab.key.with_name("roster_ed25519.new").exists()
    assert not (isolated["home"] / ".config" / "roster" / "key-rotation").exists()


# ---------------------------------------------------------------- must not collide with `roster mesh --rotate`

HOLDER = """\
import sys, time
from pathlib import Path
from roster import boxlock
with boxlock.held("setup --rotate"):
    print("held", flush=True)
    while not Path(sys.argv[1]).exists():
        time.sleep(0.02)
"""


@pytest.fixture
def held_elsewhere(isolated, tmp_path, monkeypatch):
    """Another roster process holding this Inventory's Box-wide lock (as `setup --rotate`) until the test ends."""
    import os

    from roster import boxlock
    monkeypatch.setattr(boxlock, "WAIT", 0.3)
    go = tmp_path / "let-go"
    p = subprocess.Popen([sys.executable, "-c", HOLDER, str(go)], stdout=subprocess.PIPE, text=True,
                         env={**os.environ, "HOME": str(isolated["home"])})
    assert p.stdout is not None and p.stdout.readline().strip() == "held"
    yield p
    go.touch()
    p.wait(timeout=10)


def test_one_mutating_run_at_a_time_and_read_only_ones_never_wait(lab, capsys, held_elsewhere):
    """1: setup, setup --rotate, revoke and every Mesh write refuse while another run holds the lock, naming it; check,
    --dry-run and mesh status never take it."""
    before = {n: lab.lines(n) for n in ("web-01", "web-02", "db-01")}
    busy = rf"\[205\] another roster run \(setup --rotate, pid {held_elsewhere.pid}\) is changing Hosts: wait for it"
    for argv in (["setup", "--rotate"], ["setup"], ["revoke", "-y"], ["mesh"], ["mesh", "cut", "web-01", "-y"],
                 ["mesh", "cut", "--all", "-y"]):
        with pytest.raises(SystemExit, match=busy):
            main(argv)
    assert {n: lab.lines(n) for n in before} == before
    assert not lab.key.with_name("roster_ed25519.new").exists()
    assert main(["check"]) == 0
    assert main(["setup", "--rotate", "--dry-run"]) == 0
    assert main(["setup", "--dry-run"]) == 0
    assert main(["mesh", "status"]) == 0
    assert main(["mesh", "--dry-run"]) == 0


def test_a_lock_left_by_a_run_that_died_is_taken_over(lab, capsys, isolated):
    lock = isolated["home"] / ".config" / "roster" / "run.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("999999999\nsetup --rotate\n")              # a dead pid, no process holding it
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    assert lock.read_text().split("\n")[1] == "setup --rotate"


MESH_YML = LAB_YML.replace("    auth: env:PW\n", "    auth: env:PW\n    mesh: true\n")
meshed = pytest.mark.parametrize("lab", [MESH_YML], indirect=True)


def mesh_state(lab):
    """Every Mesh line on the Hosts, and each source's Mesh key files, as bytes."""
    out = {}
    for d in sorted(lab.hosts.iterdir()):
        ak = d / "home/.ssh/authorized_keys"
        if ak.exists():
            out[f"{d.name}:ak"] = [ln for ln in ak.read_text().splitlines() if "roster-mesh:" in ln]
        for f in sorted((d / "home/.ssh/roster-mesh").glob("*")) if (d / "home/.ssh/roster-mesh").is_dir() else []:
            out[f"{d.name}:{f.name}"] = f.read_bytes()
    return out


@meshed
def test_setup_rotate_never_rotates_a_mesh_key_nor_renames_the_box(lab, capsys, isolated):
    """3: Mesh key lines and source key files are byte-identical; 5: the same comment, key-name as it was, and
    `roster mesh --dry-run` has nothing to change after; 8: the pending record is its own file, never mesh.json."""
    before = mesh_state(lab)
    assert any(k.endswith(":ak") and v for k, v in before.items())     # the Mesh is there
    comment = lab.key.with_name("roster_ed25519.pub").read_text().split()[2]
    name_file = isolated["home"] / ".config" / "roster" / "key-name"
    name = name_file.read_text() if name_file.exists() else None
    mesh_json = (isolated["home"] / ".config" / "roster" / "mesh.json").read_text()
    lab.down("db-01")
    assert main(["setup", "--rotate"]) == 1
    assert (isolated["home"] / ".config" / "roster" / "key-rotation").exists()
    assert "db-01" not in (isolated["home"] / ".config" / "roster" / "mesh.json").read_text() or \
        (isolated["home"] / ".config" / "roster" / "mesh.json").read_text() == mesh_json
    assert "rotation" not in (isolated["home"] / ".config" / "roster" / "mesh.json").read_text()
    lab.down("db-01", False)
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    assert mesh_state(lab) == before
    assert lab.key.with_name("roster_ed25519.pub").read_text().split()[2] == comment
    assert (name_file.read_text() if name_file.exists() else None) == name
    capsys.readouterr()
    assert main(["mesh", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "would change" not in out, out


@meshed
def test_the_mesh_still_reaches_a_host_the_rotation_is_pending_on(lab, capsys):
    """2: the ssh config offers both keys to a Host not switched yet, so `roster mesh` logs in there with the old."""
    lab.down("db-01")
    assert main(["setup", "--rotate"]) == 1
    lab.down("db-01", False)
    (lab.hosts / "db-01" / "accepted").unlink(missing_ok=True)
    old_pub = pub_key(lab.key.with_name("roster_ed25519.old"))
    capsys.readouterr()
    assert main(["mesh"]) == 0, capsys.readouterr().out
    assert old_pub in (lab.hosts / "db-01" / "accepted").read_text()      # it got in with the old key


def test_removal_takes_only_box_lines(lab, capsys):
    """4: a roster-mesh: line holding the very key material of the old Box key, or a line of it with no roster tag,
    survives a Box rotation (no Mesh here: nothing else would touch them)."""
    old_pub = pub_key(lab.key)
    ak = lab.hosts / "web-02" / "home/.ssh/authorized_keys"
    twin = f'from="10.0.0.4",no-agent-forwarding ssh-ed25519 {old_pub} roster-mesh:web-01@ws1'
    bare = f"ssh-ed25519 {old_pub} someone@laptop"
    ak.write_text(ak.read_text() + twin + "\n" + bare + "\n")
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    assert twin in ak.read_text().splitlines() and bare in ak.read_text().splitlines()
    assert lab.keys("web-02") == [pub_key(lab.key)]


@meshed
def test_mesh_rotate_leaves_box_lines(lab, capsys):
    """4: `roster mesh --rotate HOST` never touches a roster-managed line."""
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    box_lines = {n: lab.lines(n) for n in ("web-01", "web-02", "db-01")}
    assert main(["mesh", "--rotate", "web-01"]) == 0, capsys.readouterr().out
    assert {n: lab.lines(n) for n in box_lines} == box_lines


@meshed
def test_revoke_mid_rotation_takes_the_old_and_the_new_box_lines_and_leaves_mesh_lines(lab, capsys):
    """7."""
    lab.down("db-01")
    (lab.hosts / "web-02" / "cleanup-fails").touch()
    assert main(["setup", "--rotate"]) == 1
    lab.down("db-01", False)
    mesh_before = mesh_state(lab)
    assert main(["revoke", "-y"]) == 0, capsys.readouterr().out
    out = capsys.readouterr().out
    assert all(lab.lines(n) == [] for n in ("web-01", "web-02", "db-01"))
    assert mesh_state(lab) == mesh_before
    assert "roster_ed25519.old" in out                          # the kept old key is named for deletion too


# ---------------------------------------------------------------- key_max_age: (on by default, 365d)

@pytest.mark.parametrize(("written", "days"), [(None, 365), ("365d", 365), ("90d", 90), ("30", 30), ("52w", 364),
                                               ("2y", 730), ("off", None), ("OFF", None), (False, None)])
def test_key_max_age_is_on_by_default_and_takes_days_weeks_years_or_off(write_config, written, days):
    from roster.config import load_config
    head = "" if written is None else f"key_max_age: {'false' if written is False else written}\n"
    assert load_config(write_config(head + LAB_YML))["key_max_age"] == days


@pytest.mark.parametrize("bad", ["soon", "0d", "-5", "1.5y", "[1]"])
def test_a_bad_key_max_age_stops_the_load(write_config, bad):
    from roster.config import load_config
    with pytest.raises(SystemExit, match="key_max_age: .* isn't an age"):
        load_config(write_config(f"key_max_age: {bad}\n" + LAB_YML))


def age_checks(write_config, isolated, head="", days_old=None, stamped=True):
    """check --box's checks about this Box's key, with a key made DAYS_OLD days ago."""
    import os
    import time

    from roster import boxkeys, health
    from roster.config import load_config
    cfg = load_config(write_config(head + LAB_YML))
    key = cfg["key"]
    key.parent.mkdir(parents=True, exist_ok=True)
    for f in (key, key.with_name(key.name + ".pub")):
        f.unlink(missing_ok=True)
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "roster-managed:ws1", "-f", str(key)],
                   check=True)
    when = time.time() - (days_old or 0) * 86400
    os.utime(key, (when, when))
    f = isolated["home"] / ".config" / "roster" / "key-created"
    f.unlink(missing_ok=True)
    if stamped:                                 # as roster records it when it makes the key
        boxkeys.stamp(key)
        f.write_text(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(when))}\t{key}\n")
        os.utime(key, None)                     # the record wins over the file's time
    return [c for c in health.ssh(cfg) if "key" in c["message"] and "known hosts" not in c["message"]]


def test_check_box_warns_once_the_box_key_is_older_than_key_max_age(write_config, isolated):
    fresh = age_checks(write_config, isolated, days_old=10)
    assert [c["level"] for c in fresh] == ["ok"]
    old = age_checks(write_config, isolated, days_old=400)
    warn = [c for c in old if c["level"] == "warn"]
    assert len(warn) == 1 and "[207]" in warn[0]["message"] and "400 days old" in warn[0]["message"]
    assert "key_max_age: 365d" in warn[0]["message"] and "roster setup --rotate" in warn[0]["fix"]
    assert warn[0]["topic"] == "E269"
    assert [c["level"] for c in age_checks(write_config, isolated, "key_max_age: off\n", days_old=4000)] == ["ok"]
    assert [c["level"] for c in age_checks(write_config, isolated, "key_max_age: 30d\n", days_old=40)] == \
        ["ok", "warn"]


def test_the_age_falls_back_to_the_key_files_own_time(write_config, isolated):
    """A key made before T240 (or by hand) has no record: its file's time is its age."""
    warn = [c for c in age_checks(write_config, isolated, days_old=500, stamped=False) if c["level"] == "warn"]
    assert len(warn) == 1 and "500 days old" in warn[0]["message"]


def test_named_inventories_sharing_the_key_file_rotate_all_together(lab, capsys, write_config, isolated):
    """Owner (Q204): every Inventory that shares this Box's key file gets the new key, before any old line goes."""
    work, home = (isolated["home"].parent / d / "roster.yml" for d in ("inv-work", "inv-home"))
    home_yml = LAB_YML.replace("      web-01: 10.0.0.4\n      web-02: 10.0.0.5\n", "").replace("ws1", "ws1-home")
    for f, text in ((work, LAB_YML.replace("      db-01: 10.0.0.6\n", "")), (home, home_yml)):
        f.parent.mkdir()
        f.write_text(text)
    assert main(["inv", "add", "work", str(work)]) == 0
    assert main(["inv", "add", "home", str(home)]) == 0
    assert main(["--inv", "home", "setup"]) == 0, capsys.readouterr().out
    assert main(["--inv", "work", "setup"]) == 0, capsys.readouterr().out
    lab.down("db-01")
    capsys.readouterr()
    assert main(["--inv", "work", "setup", "--rotate"]) == 1
    out = capsys.readouterr().out
    assert "shared key   the named Inventory home use" in out or "the named Inventories" in out
    assert "home: db-01: not reached with the old key" in out
    new_pub = pub_key(lab.key)
    assert lab.keys("web-01") == [new_pub]
    assert (isolated["home"] / ".config" / "roster" / "key-rotation-home").exists()
    lab.down("db-01", False)
    assert main(["--inv", "home", "setup", "--rotate"]) == 0, capsys.readouterr().out
    assert lab.keys("db-01") == [new_pub]
    assert lab.lines("db-01")[0].endswith(" roster-managed:ws1-home")      # its own Inventory's box_name:
    assert not lab.key.with_name("roster_ed25519.old").exists()
