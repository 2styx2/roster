"""T240 (#469, decision Q204): `roster setup --rotate` replaces this Box's key on its Hosts: a new key beside the old,
on each Host one at a time (the old key logs in, the new line goes in, the new key logs in), the old key's lines off
only once every Host reached has proven the new one, then the old private key deleted (kept as `.old` while a Host is
pending). Against stand-in Hosts (tests/fakes/ssh, FAKE_HOSTS) whose sshd checks the key offered."""

import subprocess
import sys

import pytest

from roster.cli import main
from roster.errors import InventoryError

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

    from roster import sshops
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
    monkeypatch.setattr("roster.boxsetup.record_fingerprints", lambda cfg, hosts: set())
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
import os, sys, time
from pathlib import Path
from roster import boxlock
with boxlock.held("setup --rotate"):
    print("held", os.getpid(), flush=True)      # its own pid (on Windows a venv's python.exe is a launcher)
    while not Path(sys.argv[1]).exists():
        time.sleep(0.02)
    if len(sys.argv) > 2:
        os._exit(0)                             # dies holding it, never released: as a killed run
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
    assert p.stdout is not None
    said = p.stdout.readline().split()
    assert said[:1] == ["held"]
    p.holder = int(said[1])                                  # pyright: ignore[reportAttributeAccessIssue]
    yield p
    go.touch()
    p.wait(timeout=10)


def test_one_mutating_run_at_a_time_and_read_only_ones_never_wait(lab, capsys, held_elsewhere):
    """1: setup, setup --rotate, revoke and every Mesh write refuse while another run holds the lock, naming it; check,
    --dry-run and mesh status never take it."""
    before = {n: lab.lines(n) for n in ("web-01", "web-02", "db-01")}
    busy = rf"\[205\] another roster run \(setup --rotate, pid {held_elsewhere.holder}\) is changing Hosts: wait for it"
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
    name_file.write_text("ws1\n")                               # as a setup after a rename leaves it
    mesh_json = (isolated["home"] / ".config" / "roster" / "mesh.json").read_text()
    lab.down("db-01")
    assert main(["setup", "--rotate"]) == 1
    assert (isolated["home"] / ".config" / "roster" / "key-rotation").exists()
    assert (isolated["home"] / ".config" / "roster" / "mesh.json").read_text() == mesh_json      # never in it
    lab.down("db-01", False)
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    assert mesh_state(lab) == before
    assert lab.key.with_name("roster_ed25519.pub").read_text().split()[2] == comment
    assert name_file.read_text() == "ws1\n"                     # never rewritten
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
def test_revoke_mid_rotation_takes_the_old_and_the_new_box_lines_and_leaves_mesh_lines(lab, capsys, tmp_path,
                                                                                         monkeypatch):
    """7: web-02's cleanup failed (it holds the old and the new line), db-01 was down (only the old one)."""
    tools = tmp_path / "host-tools"
    tools.mkdir()
    (tools / "mv").write_text(MV_FAILS)
    (tools / "mv").chmod(0o755)
    monkeypatch.setenv("FAKE_HOST_PATH", str(tools))
    lab.down("db-01")
    (lab.hosts / "web-02" / "cleanup-fails").touch()
    assert main(["setup", "--rotate"]) == 1
    assert len(lab.keys("web-02")) == 2 and len(lab.keys("db-01")) == 1     # really both, really only the old
    (lab.hosts / "web-02" / "cleanup-fails").unlink()          # its key file is writable again for revoke
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
    with pytest.raises(InventoryError, match="key_max_age: .* isn't an age"):
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
    from roster.context import box_file
    f = box_file("key_created")                # %APPDATA%\roster on Windows
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
    assert len(warn) == 1 and warn[0]["code"] == 207 and "400 days old" in warn[0]["message"]
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


# ---------------------------------------------------------------- #482's review (security): state and files

def test_a_stray_old_file_is_refused_never_taken_for_a_rotation_or_deleted(lab, capsys):
    """MED-1: a KEY.old no rotation of roster's made (a hand-made backup) never makes a run look finished."""
    stray = lab.key.with_name("roster_ed25519.old")
    stray.write_text("my own backup\n")
    stray.chmod(0o600)
    before, old_pub = lab.key.read_bytes(), pub_key(lab.key)
    with pytest.raises(SystemExit, match=r"roster_ed25519\.old is there, but no Box key rotation of roster's made it"):
        main(["setup", "--rotate"])
    assert stray.read_text() == "my own backup\n" and lab.key.read_bytes() == before
    assert all(lab.keys(n) == [old_pub] for n in ("web-01", "web-02", "db-01"))
    assert main(["check"]) == 1
    assert "roster_ed25519.old" in capsys.readouterr().out


def test_a_stray_new_file_is_refused_never_put_on_the_hosts(lab, capsys):
    """MED-1: a KEY.new roster didn't make never goes on a Host or becomes the Box key."""
    planted = lab.key.with_name("roster_ed25519.new")
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "someone@else", "-f", str(planted)],
                   check=True)
    old_pub = pub_key(lab.key)
    with pytest.raises(SystemExit, match=r"roster_ed25519\.new is there, but no Box key rotation of roster's made it"):
        main(["setup", "--rotate"])
    assert pub_key(lab.key) == old_pub and planted.exists()
    assert all(lab.keys(n) == [old_pub] for n in ("web-01", "web-02", "db-01"))


def test_a_kept_old_key_whose_pub_was_swapped_is_refused(lab, capsys, isolated):
    """LOW-4 (and MED-1): KEY.old.pub replaced (another Box's public key) mid-rotation: the finishing run refuses
    rather than taking that other Box's line and leaving the real old one."""
    other = isolated["home"].parent / "other-box"
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "roster-managed:ws2", "-f", str(other)],
                   check=True)
    other_line = other.with_name("other-box.pub").read_text().strip()
    ak = lab.hosts / "db-01" / "home/.ssh/authorized_keys"
    ak.write_text(ak.read_text() + other_line + "\n")
    old_pub = pub_key(lab.key)
    lab.down("db-01")
    assert main(["setup", "--rotate"]) == 1
    lab.key.with_name("roster_ed25519.old.pub").write_text(other_line + "\n")
    lab.down("db-01", False)
    with pytest.raises(SystemExit, match=r"roster_ed25519\.old"):
        main(["setup", "--rotate"])
    assert other_line in ak.read_text() and old_pub in ak.read_text()


def test_old_lines_come_only_from_checked_keys(lab, isolated):
    """LOW-4: the removal pattern reads no .pub beside the key raw: only the keys all_keys vouches for."""
    from roster import rotate
    from roster.config import load_config, locate_config
    cfg = load_config(locate_config(None))
    stray = lab.key.with_name("roster_ed25519.old.pub")
    stray.write_text("ssh-ed25519 AAAAstray roster-managed:ws2\n")             # no private key beside it
    m = rotate.members([(None, cfg)])[0]
    assert "AAAAstray" not in rotate.old_lines_re(m, [(None, cfg)], ["ssh-ed25519", "AAAAnew"])


def test_a_crash_between_the_swaps_two_renames_is_finished_by_the_next_run(lab, capsys, monkeypatch):
    """MED-2: killed after KEY.new.pub -> KEY.pub and before KEY.new -> KEY: the next run (setup --rotate, or plain
    setup) finishes the swap, and KEY.old.pub is derived from KEY.old itself."""
    import os

    from roster import boxkeys, rotation
    real = os.replace

    def killed(a, b):
        if str(b) == str(lab.key) and str(a).endswith(".new"):
            raise KeyboardInterrupt("killed between the renames")
        return real(a, b)
    lab.down("db-01")
    monkeypatch.setattr(rotation.os, "replace", killed)
    assert main(["setup", "--rotate"]) == 130                    # killed (main's Ctrl-C exit)
    monkeypatch.setattr(rotation.os, "replace", real)
    nk = lab.key.with_name("roster_ed25519.new")
    assert nk.exists() and not nk.with_name(nk.name + ".pub").exists()      # the half-renamed state
    new_pub = pub_key(lab.key)                                  # KEY.pub is the new key's already
    assert main(["setup"]) == 1, capsys.readouterr().out         # never 201: the swap is finished first
    assert pub_key(lab.key) == new_pub and boxkeys.matches(lab.key)
    assert boxkeys.matches(lab.key.with_name("roster_ed25519.old"))
    lab.down("db-01", False)
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    assert all(lab.keys(n) == [new_pub] for n in ("web-01", "web-02", "db-01"))
    assert sorted(p.name for p in lab.key.parent.glob("roster_ed25519*")) == ["roster_ed25519", "roster_ed25519.pub"]


@pytest.mark.parametrize("where", ["sync-after-swap", "prove-on-web-01", "cleanup-on-web-01", "make-new",
                                   "before-ssh-keygen"])
def test_every_other_crash_point_recovers_on_a_rerun(lab, capsys, where, monkeypatch):
    from roster import rotate
    old_pub = pub_key(lab.key)
    real_script, real_logs, real_make = rotate.Connect.script, rotate.Connect.logs_in, rotate.make_new

    def boom(*a, **k):
        raise KeyboardInterrupt(where)
    with monkeypatch.context() as mp:
        if where == "sync-after-swap":
            mp.setattr(rotate, "sync", boom)
        elif where == "prove-on-web-01":
            mp.setattr(rotate.Connect, "logs_in", lambda self, m, key: boom() if m.name == "web-01"
                       else real_logs(self, m, key))
        elif where == "cleanup-on-web-01":
            mp.setattr(rotate.Connect, "script", lambda self, m, keys, posix, mode, tag_re, pub="": boom()
                       if mode == "remove" and m.name == "web-01" else real_script(self, m, keys, posix, mode, tag_re,
                                                                                  pub))
        elif where == "before-ssh-keygen":          # the record's first write done, no KEY.new yet (#482, P1)
            mp.setattr(rotate, "make_new", lambda slot, cfg, say: boom())
        else:
            def make(slot, cfg, say):
                real_make(slot, cfg, say)
                boom()
            mp.setattr(rotate, "make_new", make)
        assert main(["setup", "--rotate"]) == 130          # killed (main's Ctrl-C exit)
    for n in ("web-01", "web-02", "db-01"):           # never locked out: a key the ssh config offers logs in
        assert any(k.exists() and lab.logs_in(n, k) for k in (lab.key, lab.key.with_name("roster_ed25519.old"))), n
    capsys.readouterr()
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    new_pub = pub_key(lab.key)
    assert new_pub != old_pub and all(lab.keys(n) == [new_pub] for n in ("web-01", "web-02", "db-01"))
    assert sorted(p.name for p in lab.key.parent.glob("roster_ed25519*")) == ["roster_ed25519", "roster_ed25519.pub"]


def test_an_unreadable_record_fails_closed(lab, capsys, isolated):
    """LOW-1: a malformed record never silences the report, and sync keeps offering the old key."""
    lab.down("db-01")
    assert main(["setup", "--rotate"]) == 1
    from roster.context import current
    current().rotation.write_text("{not json")
    capsys.readouterr()
    assert main(["check"]) == 1
    assert "can't be read" in capsys.readouterr().out
    assert main(["sync"]) == 0
    old = str(lab.key.with_name("roster_ed25519.old"))
    assert identity_files(isolated, "db-01") == [str(lab.key), old]
    assert identity_files(isolated, "web-01") == [str(lab.key), old]          # every Host of that key: can't tell


def test_a_kept_old_key_with_no_host_pending_is_reported_and_finished(lab, capsys):
    """LOW-2: the pending Host left roster.yml: check and check --box name the retired key, and setup --rotate
    deletes it."""
    lab.down("db-01")
    assert main(["setup", "--rotate"]) == 1
    lab.write(LAB_YML.replace("      db-01: 10.0.0.6\n", ""))
    capsys.readouterr()
    assert main(["check", "--box"]) == 0
    out = capsys.readouterr().out
    assert "roster_ed25519.old" in out and "roster setup --rotate" in out
    assert main(["check"]) == 1
    assert "roster_ed25519.old" in capsys.readouterr().out
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    assert not lab.key.with_name("roster_ed25519.old").exists()
    assert main(["check"]) == 0


def test_revoke_mid_rotation_with_both_lines_on_each_host_clears_the_record(lab, capsys):
    """LOW-3 and item 7's pre-swap case: after a 208 stop every Host holds the old and the new line; revoke takes
    both, and the record goes with them, so check isn't left saying the old key is on them."""
    from roster.context import current
    (lab.hosts / "web-02" / "refuse").write_text("*.new\n")
    assert main(["setup", "--rotate"]) == 1
    assert all(len(lab.keys(n)) == 2 for n in ("web-01", "db-01"))
    capsys.readouterr()
    assert main(["revoke", "-y"]) == 0, capsys.readouterr().out
    assert "roster_ed25519.new" in capsys.readouterr().out
    assert all(lab.lines(n) == [] for n in ("web-01", "web-02", "db-01"))
    assert not current().rotation.exists()


def test_a_narrowed_rerun_never_swaps_while_a_host_that_refused_is_unproven(lab, capsys):
    """After a 208 stop, `--host web-01` alone doesn't make the new key the Box key: web-02 refused it."""
    (lab.hosts / "web-02" / "refuse").write_text("*.new\n")
    old_pub = pub_key(lab.key)
    assert main(["setup", "--rotate"]) == 1
    capsys.readouterr()
    assert main(["setup", "--rotate", "--host", "web-01"]) == 1
    assert "web-02 refused the new key" in capsys.readouterr().out
    assert pub_key(lab.key) == old_pub and lab.key.with_name("roster_ed25519.new").exists()
    assert old_pub in lab.keys("web-01")


def test_the_lock_holds_across_processes_and_a_dead_ones_is_free(isolated, tmp_path, monkeypatch):
    """LOW-6: the lock itself, on every OS (Windows' msvcrt.locking too): a second process's lock refuses this one
    (205), and once that process is killed (no release), the lock is free at once."""
    import os

    from roster import boxlock
    from roster.errors import Problem
    monkeypatch.setattr(boxlock, "WAIT", 0.3)
    go = tmp_path / "die"
    p = subprocess.Popen([sys.executable, "-c", HOLDER, str(go), "die"], stdout=subprocess.PIPE, text=True,
                         env=dict(os.environ))
    try:
        assert p.stdout is not None
        said = p.stdout.readline().split()
        assert said[:1] == ["held"]
        with pytest.raises(Problem, match=rf"^another roster run \(setup --rotate, pid {said[1]}\)") as e:
            with boxlock.held("setup"):
                pass
        assert e.value.code == 205
    finally:
        go.touch()                                  # it ends holding the lock: the OS lets go of it
        p.wait(timeout=30)
    with boxlock.held("setup"):
        with boxlock.held("mesh"):                      # re-entrant in one thread
            pass


@pytest.mark.parametrize("bad", ["11y", "3651d", "99999999999y"])
def test_key_max_age_is_at_most_ten_years(write_config, bad):
    from roster.config import load_config
    with pytest.raises(InventoryError, match="key_max_age: .*(isn't an age|at most 10y)"):
        load_config(write_config(f"key_max_age: {bad}\n" + LAB_YML))


def test_key_max_age_takes_ascii_digits_only():
    from roster import boxkeys
    with pytest.raises(ValueError, match="isn't an age"):
        boxkeys.parse_age("\u0661\u0662d")                 # Arabic-Indic 12: never twelve days
    assert boxkeys.parse_age("12d") == 12


def test_ssh_keygen_killed_before_the_pub_is_refused_then_a_fresh_key_is_made(lab, capsys):
    """#482's second pass, P1b: KEY.new without its .pub is refused by name; once moved away, the re-run makes a new
    key, never takes KEY (the old one) for it."""
    from roster import rotate, rotation
    real = rotate.make_new
    old_pub = pub_key(lab.key)

    def half(slot, cfg, say):
        real(slot, cfg, say)
        rotation.pub_of(rotation.new_of(slot.key)).unlink()
        raise KeyboardInterrupt("mid ssh-keygen")
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(rotate, "make_new", half)
        assert main(["setup", "--rotate"]) == 130
    with pytest.raises(SystemExit, match=r"roster_ed25519\.new isn't the key the Box key rotation made"):
        main(["setup", "--rotate"])
    lab.key.with_name("roster_ed25519.new").rename(lab.key.parent.parent / "moved-away")
    capsys.readouterr()
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    new_pub = pub_key(lab.key)
    assert new_pub != old_pub and all(lab.keys(n) == [new_pub] for n in ("web-01", "web-02", "db-01"))


def test_after_the_swap_the_line_added_is_the_keys_own_never_the_records(lab, capsys):
    """#482's second pass, P2: an edited record's new key never goes on a Host: the line comes from KEY itself, and
    a record that names another key stops the run."""
    import json

    from roster.context import current
    lab.down("db-01")
    assert main(["setup", "--rotate"]) == 1
    rec = json.loads(current().rotation.read_text())
    other = lab.hosts.parent / "intruder"
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(other)], check=True)
    intruder = pub_key(other)
    rec["keys"][str(lab.key)]["new"] = f"ssh-ed25519 {intruder}"
    current().rotation.write_text(json.dumps(rec))
    lab.down("db-01", False)
    with pytest.raises(SystemExit, match="isn't the key the Box key rotation's record names"):
        main(["setup", "--rotate"])
    assert intruder not in lab.keys("db-01")


def test_a_lock_file_that_is_a_link_is_refused_on_every_os(isolated, tmp_path):
    """The lock NITs: a symlink (where the OS lets this user make one) and a hard link are refused, their target
    untouched; no lab, so Windows runs it too."""
    import os

    from roster import boxlock
    from roster.context import box_file
    from roster.errors import Problem
    victim = tmp_path / "victim"
    victim.write_text("precious\n")
    box_file("lock").parent.mkdir(parents=True, exist_ok=True)
    os.link(victim, box_file("lock"))                                # a hard link
    with pytest.raises(Problem, match="isn't a plain file"):
        with boxlock.held("setup"):
            pass
    assert victim.read_text() == "precious\n"
    box_file("lock").unlink()
    try:
        box_file("lock").symlink_to(victim)
    except OSError:                                             # Windows without the privilege to make one
        return
    with pytest.raises(Problem, match="isn't a plain file"):
        with boxlock.held("setup"):
            pass
    assert victim.read_text() == "precious\n"


def test_revoke_never_says_to_delete_a_key_file_another_inventory_uses(lab, capsys, isolated):
    """T245 (#478 item 6, #471's review): revoke's "delete these files" list leaves out a key file another named
    Inventory on this Box still uses (a type's roster_<type> too), and says why (221)."""
    work, home = (isolated["home"].parent / d / "roster.yml" for d in ("inv-work", "inv-home"))
    home_yml = LAB_YML.replace("      web-01: 10.0.0.4\n      web-02: 10.0.0.5\n", "").replace("ws1", "ws1-home")
    for f, text in ((work, LAB_YML.replace("      db-01: 10.0.0.6\n", "")), (home, home_yml)):
        f.parent.mkdir()
        f.write_text(text)
    assert main(["inv", "add", "work", str(work)]) == 0
    assert main(["inv", "add", "home", str(home)]) == 0
    assert main(["--inv", "home", "setup"]) == 0, capsys.readouterr().out
    assert main(["--inv", "work", "setup"]) == 0, capsys.readouterr().out
    capsys.readouterr()
    assert main(["--inv", "work", "revoke", "-y"]) == 0
    out = capsys.readouterr().out
    note = next(ln for ln in out.splitlines() if ln.startswith("note: [221]"))
    assert note.startswith(f"note: [221] keep {lab.key}: the Inventories home, ") and "use it too" in note
    assert str(lab.key) not in out.replace(note, "")                          # neither it nor its .pub to delete


# ---------------------------------------------------------------- T253 (#499): the rotation's follow-ups

def test_a_new_key_moved_aside_after_a_stop_has_its_lines_taken_off_too(lab, capsys, tmp_path):
    """T253 item 1 (#482's C4): after a 208 stop the first KEY.new's line is on the Hosts it reached. Moved aside
    (not deleted), the re-run makes another key; the first one's line goes with the old ones, so the moved file no
    longer logs in anywhere, and the run says what happened to it."""
    (lab.hosts / "web-02" / "refuse").write_text("*.new\n")
    assert main(["setup", "--rotate"]) == 1
    first = lab.key.with_name("roster_ed25519.new")
    moved = tmp_path / "moved"
    first.rename(moved)
    first.with_name(first.name + ".pub").rename(tmp_path / "moved.pub")
    abandoned = pub_key(moved)
    assert abandoned in lab.keys("web-01")
    (lab.hosts / "web-02" / "refuse").unlink()
    capsys.readouterr()
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    out = capsys.readouterr().out
    assert "its private key is gone" not in out
    assert "its line is taken off with the old key's" in out
    new_pub = pub_key(lab.key)
    for name in ("web-01", "web-02", "db-01"):
        assert lab.keys(name) == [new_pub], name
        assert not lab.logs_in(name, moved), name


HOLDER_IN = """\
import os, sys, time
from pathlib import Path
from roster import boxlock, context
context.use(sys.argv[2])
with boxlock.held("mesh"):
    print("held", os.getpid(), flush=True)
    while not Path(sys.argv[1]).exists():
        time.sleep(0.02)
"""


def test_the_lock_covers_every_inventory_on_the_box_shared_key_file_or_not(isolated, tmp_path, monkeypatch):
    """T253 item 2: two named Inventories can hold one Host (one account's authorized_keys) under different key
    files. A run in one holds the lock against a run in the other, so neither's rewrite drops the other's line."""
    import os

    from roster import boxlock, context
    from roster.errors import Problem
    monkeypatch.setattr(boxlock, "WAIT", 0.3)
    go = tmp_path / "let-go"
    p = subprocess.Popen([sys.executable, "-c", HOLDER_IN, str(go), "home"], stdout=subprocess.PIPE, text=True,
                         env=dict(os.environ))
    try:
        assert p.stdout is not None
        said = p.stdout.readline().split()
        assert said[:1] == ["held"]
        for name in ("work", None):
            context.use(name)
            with pytest.raises(Problem, match=rf"^another roster run \(mesh, pid {said[1]}\)") as e:
                with boxlock.held("setup"):
                    pass
            assert e.value.code == 205
    finally:
        go.touch()
        p.wait(timeout=30)
        context.use(None)
    context.use("work")
    with boxlock.held("setup"):
        pass
    context.use(None)


def test_the_rotation_carries_the_users_own_ssh_options_for_a_host(lab, capsys, isolated):
    """T253 item 3: an old Host whose sshd needs the user's own `KexAlgorithms` (from ~/.ssh/config) is rotated, not
    left pending for good: the rotation's one-Host config carries the options that let `ssh NAME` reach it."""
    (lab.hosts / "web-02" / "needs").write_text("KexAlgorithms +diffie-hellman-group14-sha1\n")
    with (isolated["home"] / ".ssh" / "config").open("a") as f:
        f.write("\nHost web-02\n    KexAlgorithms +diffie-hellman-group14-sha1\n    IdentityFile ~/.ssh/id_own\n")
    capsys.readouterr()
    assert main(["setup", "--rotate"]) == 0, capsys.readouterr().out
    new_pub = pub_key(lab.key)
    assert all(lab.keys(n) == [new_pub] for n in ("web-01", "web-02", "db-01"))


def test_the_one_host_config_pins_one_key_and_turns_a_proxyjump_into_its_own_ssh(lab, monkeypatch):
    """T253 item 3: the user's algorithms and jump host go in; their IdentityFile, User, HostName and known_hosts
    never do (the proof is exactly the key meant, at the Host's own address). A ProxyJump becomes a ProxyCommand
    running ssh with the user's own config, since ssh would look the jump host up in roster's one-Host file."""
    from roster import rotate
    from roster.config import load_config
    from roster.context import current
    cfg = load_config(current().path)
    seen = {"proxyjump": "ops@jump-01:2222,bastion", "hostkeyalgorithms": "+ssh-rsa",
            "pubkeyacceptedalgorithms": "+ssh-rsa", "kexalgorithms": "+diffie-hellman-group14-sha1",
            "identityfile": "~/.ssh/id_own", "user": "root", "hostname": "10.9.9.9",
            "userknownhostsfile": "~/.ssh/known_hosts", "ciphers": "aes128-ctr\nHost *"}
    monkeypatch.setattr(rotate, "user_options", lambda name: dict(seen))
    m = rotate.Member(current(), cfg, cfg["hosts"]["web-01"], rotate.Slot(rotate.boxkeys.parse("ed25519"), lab.key))
    text = rotate.one_key_config(m, [lab.key])
    lines = [ln.strip() for ln in text.splitlines()]
    assert "HostKeyAlgorithms +ssh-rsa" in lines and "PubkeyAcceptedAlgorithms +ssh-rsa" in lines
    assert "KexAlgorithms +diffie-hellman-group14-sha1" in lines
    assert "ProxyCommand ssh -o BatchMode=yes -J ops@jump-01:2222 -W '[%h]:%p' bastion" in lines
    assert not any(ln.startswith(("ProxyJump", "Ciphers")) for ln in lines)       # a value with a line break: not taken
    assert [ln for ln in lines if ln.startswith("IdentityFile")] == [f'IdentityFile "{lab.key}"']
    assert "HostName 10.0.0.4" in lines and "User ops" in lines and "id_own" not in text and "root" not in text


@pytest.mark.parametrize("argv", [["setup", "--rotate"], ["setup"]])
def test_an_old_types_key_file_goes_once_no_host_holds_or_uses_it(lab, capsys, argv):
    """T253 item 5: roster.yml's key_type: goes ed25519 -> ecdsa. While a Host still holds the Ed25519 line (down
    for this run), roster_ed25519 stays; once every Host is on ECDSA, roster deletes it, and says so."""
    ecdsa = lab.key.with_name("roster_ecdsa")
    lab.write("key_type: ecdsa\n" + LAB_YML)
    lab.down("db-01")
    capsys.readouterr()
    assert main(argv) == 1
    assert lab.key.exists() and lab.key.with_name("roster_ed25519.pub").exists()
    assert "retired" not in capsys.readouterr().out
    lab.down("db-01", False)
    assert main(argv) == 0, capsys.readouterr().out
    assert all([ln.split()[0] for ln in lab.lines(n)] == ["ecdsa-sha2-nistp384"] for n in ("web-01", "web-02", "db-01"))
    assert all(lab.keys(n) == [pub_key(ecdsa)] for n in ("web-01", "web-02", "db-01"))
    assert not lab.key.exists() and not lab.key.with_name("roster_ed25519.pub").exists()
    assert f"retired key  {lab.key} (ed25519): no Host of any Inventory on this Box uses or holds it now" \
        in capsys.readouterr().out
