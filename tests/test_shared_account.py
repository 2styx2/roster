"""T258 (#521): Hosts that share one account (the same authorized_keys: two names for one machine, or a user several
Host entries share). A parallel `roster setup` once raced there: both key scripts wrote authorized_keys.roster and
renamed it ("mv: cannot move authorized_keys.roster ... No such file"), and one's write could drop the other's line."""

import os
import subprocess
import sys

import pytest
from conftest import POSIX_SH, WINDOWS

SHARED_YML = """\
box_name: ws1
groups:
  lab:
    user: ops
    auth: env:PW
    hosts:
      app-01: {{ip: 10.0.0.4{a}}}
      app-alias: {{ip: 10.0.0.4{b}}}
"""


@pytest.fixture
def shared(fakes, isolated, write_config, monkeypatch):
    """Two Host entries, app-01 and app-alias, that are one stand-in Host (tests/fakes/ssh's FAKE_HOSTS): app-alias's
    folder is app-01's, so both reach the same account's authorized_keys. Each connection takes a moment first, so a
    parallel setup's two key scripts run at the same time."""
    from roster import sshops
    if WINDOWS:
        pytest.skip("the stand-in Hosts' key scripts run in a POSIX sh")
    for f in (fakes / "host").iterdir():
        f.chmod(0o755)
    root = isolated["home"].parent / "hosts"
    ssh = root / "app-01" / "home" / ".ssh"
    ssh.mkdir(parents=True)
    (ssh / "authorized_keys").write_text("ssh-ed25519 AAAAown own@laptop\n")
    (root / "app-01" / "keys").touch()
    (root / "app-01" / "slow").write_text("0.3")
    (root / "app-alias").symlink_to(root / "app-01", target_is_directory=True)
    monkeypatch.setenv("FAKE_HOSTS", str(root))
    monkeypatch.setenv("FAKE_SH", str(POSIX_SH))
    monkeypatch.setattr("roster.boxsetup.record_fingerprints", lambda cfg, hosts: set())
    monkeypatch.setenv("PW", "pw")
    monkeypatch.setattr(sshops, "password_exec", lambda h, command, pw, **k: (
        lambda r: (r.returncode, r.stdout, r.stderr))(subprocess.run(
            [sys.executable, str(fakes / "ssh"), h["name"], command], capture_output=True, text=True,
            env={**os.environ, "FAKE_SSH_AS_PASSWORD": "1"})))

    class Shared:
        def write(self, a: str = "", b: str = "") -> None:
            write_config(SHARED_YML.format(a=a, b=b))

        def lines(self) -> list[str]:
            return [ln for ln in (ssh / "authorized_keys").read_text().splitlines() if "roster-managed:" in ln]

        def leftovers(self) -> list[str]:
            return sorted(p.name for p in ssh.iterdir() if p.name != "authorized_keys")
    return Shared()


def test_two_hosts_sharing_an_account_both_get_the_key_in_a_parallel_setup(shared, capsys):
    from roster.cli import main
    shared.write()
    rc = main(["setup"])
    out = capsys.readouterr().out
    assert rc == 0, out
    assert "FAIL" not in out
    assert [ln.split()[0] for ln in shared.lines()] == ["ssh-ed25519"]
    assert shared.leftovers() == []                 # no temp file left beside authorized_keys


def test_two_hosts_sharing_an_account_with_their_own_key_types_keep_both_lines(shared, capsys):
    """Each Host's key type has its line there; neither Host's setup takes the other's as a leftover (T239's
    cleanup), now or at the next setup."""
    from roster.cli import main
    shared.write(b=", key_type: ecdsa")
    for _ in range(2):
        rc = main(["setup"])
        out = capsys.readouterr().out
        assert rc == 0, out
        assert sorted(ln.split()[0] for ln in shared.lines()) == ["ecdsa-sha2-nistp384", "ssh-ed25519"], out
    assert "2 already work, 0 need the key installed" in out
    assert main(["revoke", "-y"]) == 0              # one takes every line of this Box's; the other is done with it
    assert "the same account as app-" in capsys.readouterr().err
    assert shared.lines() == []


def test_key_scripts_run_at_once_on_one_file_never_lose_their_temp_file_or_leave_one(isolated):
    """Two Boxes' setups (or a setup and a revoke) on one account at the same time: each script's new file has its
    own name, so none renames another's away ("mv: cannot stat authorized_keys.roster"), none is left behind, and
    the file is always whole. (A run may still stop when another replaced the file under it, as cp -p says: nothing
    is changed then, and the next run puts its line in.)"""
    from roster import authorized
    if WINDOWS:
        pytest.skip("POSIX sh scripts")
    ssh = isolated["home"] / ".ssh"
    ssh.mkdir()
    (ssh / "authorized_keys").write_text("ssh-ed25519 AAAAown own@laptop\n")
    scripts = [authorized.add_key_script(f"ssh-ed25519 AAAAbox{i} roster-managed:box{i}", f"roster-managed:box{i}$",
                                         "ops") for i in range(8)]
    scripts.append(authorized.remove_key_script("roster-managed:gone$", "ops"))
    env = {**os.environ, "HOME": str(isolated["home"])}
    procs = [subprocess.Popen([str(POSIX_SH), "-c", s], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True) for s in scripts * 3]
    errors = [p.communicate()[1] for p in procs]
    assert not [e for e in errors if "No such file" in e or "cannot stat" in e]
    assert sum(p.returncode == 0 for p in procs) > 0
    assert sorted(p.name for p in ssh.iterdir()) == ["authorized_keys"]
    text = (ssh / "authorized_keys").read_text()
    assert text.startswith("ssh-ed25519 AAAAown own@laptop\n") and "roster-managed:box" in text


TWO_PORTS_YML = """\
box_name: ws1
groups:
  lab:
    user: root
    auth: env:PW
    hosts:
      ct-01: {ip: 10.0.0.4, port: 2201}
      ct-02: {ip: 10.0.0.4, port: 2202}
"""


def test_two_machines_behind_one_address_on_other_ports_are_two_accounts_and_revoke_takes_both(
        shared, write_config, isolated, capsys):
    """#524's review M1: containers port-forwarded on one address are separate machines (each its own
    authorized_keys): revoke never counts one as done because the other was."""
    from roster import hosts
    from roster.cli import main
    from roster.config import load_config, locate_config
    root = isolated["home"].parent / "hosts"
    for n in ("ct-01", "ct-02"):
        d = root / n / "home" / ".ssh"
        d.mkdir(parents=True)
        (d / "authorized_keys").write_text("ssh-ed25519 AAAAown own@laptop\n")
        (root / n / "keys").touch()
    write_config(TWO_PORTS_YML)
    cfg = load_config(locate_config(None))
    assert hosts.account(cfg["hosts"]["ct-01"]) != hosts.account(cfg["hosts"]["ct-02"])
    assert main(["setup"]) == 0, capsys.readouterr().out
    assert main(["revoke", "-y"]) == 0
    assert "the same account as" not in capsys.readouterr().err
    for n in ("ct-01", "ct-02"):
        assert "roster-managed:ws1" not in (root / n / "home/.ssh/authorized_keys").read_text(), n


@pytest.mark.parametrize(("os_", "same"), [("", False), (", os: windows", True)])
def test_a_user_names_case_is_its_own_account_except_on_windows(write_config, isolated, os_, same):
    """#524's review L1: Admin and admin are two POSIX accounts; Windows reads them as one."""
    from roster import hosts
    from roster.config import load_config, locate_config
    write_config(TWO_PORTS_YML.replace("ct-01: {ip: 10.0.0.4, port: 2201}", f"ct-01: {{ip: 10.0.0.4, user: Admin{os_}}}")
                 .replace("ct-02: {ip: 10.0.0.4, port: 2202}", f"ct-02: {{ip: 10.0.0.4, user: admin{os_}}}"))
    cfg = load_config(locate_config(None))
    assert (hosts.account(cfg["hosts"]["ct-01"]) == hosts.account(cfg["hosts"]["ct-02"])) is same


def test_revoke_tries_every_entry_on_a_shared_account(shared, capsys, isolated):
    """#524's review M1: revoke connects to each entry, even one on an account another entry's revoke just did:
    only a key that no longer logs in there, after that, counts as done."""
    from roster.cli import main
    shared.write()
    assert main(["setup"]) == 0
    log = isolated["home"].parent / "hosts" / "connections"
    log.write_text("")
    assert main(["revoke", "-y"]) == 0
    started = [ln.split()[1] for ln in log.read_text().splitlines() if ln.startswith("start ")]
    assert sorted(set(started)) == ["app-01", "app-alias"]
    assert shared.lines() == []
