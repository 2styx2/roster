"""T263 (#534): a lock on the Host around each authorized_keys rewrite. Two Boxes (two roster runs) writing one
account at once took turns only inside one roster process (T258's AccountLocks); across Boxes the later rename won and
the other's line was gone until its next setup. Now each rewrite holds an advisory lock on a file beside
authorized_keys (flock, BusyBox's flock; PowerShell's exclusive open on Windows), and a Host with no flock says so."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest
from conftest import POSIX_SH, WINDOWS

pytestmark = pytest.mark.skipif(WINDOWS or POSIX_SH is None, reason="the key scripts run in a POSIX sh")

# what the POSIX key scripts call on a Host, for a PATH that leaves flock (and BusyBox) out
TOOLS = ("uname", "id", "mkdir", "touch", "readlink", "mktemp", "cp", "grep", "sed", "chmod", "mv", "awk", "cat",
         "sleep", "rm", "cmp", "sort", "head", "tail", "cut", "env", "sh")


def bin_without_flock(where: Path, *extra: tuple[str, str]) -> Path:
    """A folder holding links to TOOLS only (no flock, no busybox), plus EXTRA (name, script) of a test's own."""
    where.mkdir()
    for t in TOOLS:
        if found := shutil.which(t):
            (where / t).symlink_to(found)
    for name, text in extra:
        (where / name).write_text(text)
        (where / name).chmod(0o755)
    return where


@pytest.fixture
def account(isolated, tmp_path):
    """One account's ~/.ssh with a line of the user's own, and the environment a key script runs in there. A slow cp
    (0.2 s) widens each script's read-to-rename window, so runs at the same moment overlap there every time."""
    ssh = isolated["home"] / ".ssh"
    ssh.mkdir()
    (ssh / "authorized_keys").write_text("ssh-ed25519 AAAAown own@laptop\n")
    slow = tmp_path / "slow"
    slow.mkdir()
    real_cp = shutil.which("cp")
    (slow / "cp").write_text(f"#!/bin/sh\nsleep 0.2\nexec {real_cp} \"$@\"\n")
    (slow / "cp").chmod(0o755)

    class Account:
        dir = ssh
        file = ssh / "authorized_keys"
        env = {**os.environ, "HOME": str(isolated["home"]), "PATH": f"{slow}{os.pathsep}{os.environ['PATH']}"}

        def run(self, scripts: list[str], path: str | None = None) -> list[subprocess.CompletedProcess[str]]:
            env = {**self.env, **({"PATH": path} if path else {})}
            procs = [subprocess.Popen([str(POSIX_SH), "-c", s], env=env, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True) for s in scripts]
            return [subprocess.CompletedProcess(p.args, p.wait(), *p.communicate()) for p in procs]
    return Account()


def adds(n: int) -> list[str]:
    from roster import authorized
    return [authorized.add_key_script(f"ssh-ed25519 AAAAbox{i} roster-managed:box{i}", f"roster-managed:box{i}$",
                                      "ops") for i in range(n)]


def test_boxes_writing_one_account_at_once_each_keep_their_line(account):
    """Five Boxes' setups on one account at the same moment: each takes its turn on the Host, so every line is
    there after, and the user's own line too."""
    runs = account.run(adds(5))
    assert [r.returncode for r in runs] == [0] * 5, [r.stderr for r in runs]
    text = account.file.read_text()
    assert text.startswith("ssh-ed25519 AAAAown own@laptop\n")
    assert sorted(ln.split()[2] for ln in text.splitlines()[1:]) == [f"roster-managed:box{i}" for i in range(5)]


def test_a_run_that_finds_the_lock_held_too_long_stops_with_nothing_changed(account, monkeypatch):
    """Another run holds the lock past the wait: this one stops before it reads the file, says BUSY and the lock
    file, and the file is as it was."""
    from roster import authorized, keyline
    monkeypatch.setattr(keyline, "HOST_LOCK", keyline.host_lock(1))
    lock = account.dir / ("authorized_keys" + keyline.LOCK_SUFFIX)
    holder = subprocess.Popen([shutil.which("flock"), str(lock), "sleep", "5"])
    try:
        for _ in range(100):                            # until the holder has it
            if subprocess.run([shutil.which("flock"), "-n", str(lock), "true"]).returncode:
                break
            subprocess.run(["sleep", "0.05"])
        r, = account.run([authorized.add_key_script("ssh-ed25519 AAAAbox roster-managed:box", "roster-managed:box$",
                                                    "ops")])
    finally:
        holder.kill()
    assert r.returncode == 1
    assert keyline.said(r.stdout).busy == str(lock)
    assert account.file.read_text() == "ssh-ed25519 AAAAown own@laptop\n"


def test_a_lock_file_left_behind_never_blocks(account):
    """The lock file stays after a run (empty, 0600): the next run takes the lock at once."""
    from roster import authorized, keyline
    script = authorized.add_key_script("ssh-ed25519 AAAAbox roster-managed:box", "roster-managed:box$", "ops")
    for _ in range(2):
        r, = account.run([script])
        assert r.returncode == 0, r.stderr
        assert keyline.said(r.stdout).nolock is None
    lock = account.dir / ("authorized_keys" + keyline.LOCK_SUFFIX)
    assert lock.read_text() == "" and lock.stat().st_mode & 0o777 == 0o600


def test_a_host_with_no_flock_is_said_and_still_written(account, tmp_path):
    from roster import authorized, keyline
    path = bin_without_flock(tmp_path / "bin")
    r, = account.run([authorized.add_key_script("ssh-ed25519 AAAAbox roster-managed:box", "roster-managed:box$",
                                                "ops")], path=str(path))
    assert r.returncode == 0, r.stderr
    assert keyline.said(r.stdout).nolock == "this Host has no flock"
    assert "roster-managed:box" in account.file.read_text()


def test_busybox_flock_is_used_where_flock_isnt_a_command(account, tmp_path):
    """BusyBox (ESXi, Alpine without util-linux): its flock applet, `busybox flock`, takes the lock."""
    from roster import keyline
    log = tmp_path / "busybox.log"
    path = bin_without_flock(tmp_path / "bin", ("busybox", f"""#!/bin/sh
echo "$@" >> {log}
[ "$1" = --list ] && {{ printf 'sh\\nflock\\nmv\\n'; exit 0; }}
[ "$1" = flock ] && {{ shift; exec {shutil.which("flock")} "$@"; }}
exit 127
"""))
    runs = account.run(adds(3), path=f"{tmp_path / 'bin'}")
    assert [r.returncode for r in runs] == [0, 0, 0], [r.stderr for r in runs]
    assert all(keyline.said(r.stdout).nolock is None for r in runs)
    assert "flock -n 9" in log.read_text()
    assert path.is_dir()
    assert len(account.file.read_text().splitlines()) == 4


def test_a_link_at_the_lock_files_name_is_never_followed(account, tmp_path):
    """Something else at the lock file's name (a link planted there) isn't opened: the run goes on unlocked, said."""
    from roster import authorized, keyline
    target = tmp_path / "elsewhere"
    (account.dir / ("authorized_keys" + keyline.LOCK_SUFFIX)).symlink_to(target)
    r, = account.run([authorized.remove_key_script("roster-managed:box$", "ops")])
    assert r.returncode == 0, r.stderr
    assert "isn't a plain file" in (keyline.said(r.stdout).nolock or "")
    assert not target.exists()
