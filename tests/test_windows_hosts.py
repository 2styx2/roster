"""Windows Hosts (T195, #375, decision Q174): roster.yml's `os:`, and setup, revoke and check on an `os: windows` Host
through PowerShell scripts sent on stdin. The stand-in Windows Host (tests/fakes/ssh, FAKE_HOSTS with a `windows`
marker) runs the decoded script with pwsh (Linux) or powershell.exe (Windows); nothing here connects anywhere."""
import json
import os
import shutil
import subprocess

import pytest
from conftest import WINDOWS, stand_in_hosts

from roster import sshops
from roster.cli import main
from roster.common import program_argv
from roster.config import load_config

CASCADE = """\
defaults: { user: admin }
groups:
  dcs:
    os: windows
    hosts:
      dc-01: 10.0.0.5
      dc-02: { ip: 10.0.0.6, os: posix }
  lab:
    hosts:
      web-1: 10.0.0.7
      app-1: { ip: 10.0.0.8, os: Windows }
"""


def test_os_cascades_from_defaults_to_group_to_host(write_config):
    hosts = load_config(write_config(CASCADE))["hosts"]
    assert hosts["dc-01"]["os"] == "windows"          # from its group
    assert hosts["dc-02"]["os"] == "posix"            # the Host's own wins
    assert hosts["web-1"]["os"] is None               # unset: a POSIX Host, as every Host was before os:
    assert hosts["app-1"]["os"] == "windows"          # any case, kept as roster's own word


@pytest.mark.parametrize("value", ["linux", "win", "true", "''"])
def test_os_takes_only_windows_or_posix(write_config, value):
    with pytest.raises(SystemExit, match="os: must be windows or posix"):
        load_config(write_config(f"defaults: {{ user: admin }}\ngroups:\n  a:\n    hosts:\n"
                                 f"      h1: {{ ip: 10.0.0.5, os: {value} }}\n"))


TYPED = """\
defaults: { user: admin }
groups:
  dcs:
    type: windows
    hosts:
      dc-01: 10.0.0.5
      dc-02: { ip: 10.0.0.6, os: windows }
      dc-03: { ip: 10.0.0.7, os: posix }
"""


@pytest.mark.parametrize("argv", [["hosts"], ["check", "--only", "dc-01"]])
def test_type_windows_without_os_warns_and_suggests_os_windows(write_config, capsys, fakes, argv):
    write_config(TYPED)
    main(argv)
    err = capsys.readouterr().err
    assert "warning: [154] dc-01 has type: windows but no os:" in err and "set os: windows" in err
    assert "dc-02" not in err and "dc-03" not in err        # an os: of its own, either way, is the person's call
    assert load_config("roster.yml")["hosts"]["dc-01"]["os"] is None       # a warning, never inferred


def test_a_windows_hosts_ssh_config_never_shares_a_connection(isolated, write_config):
    """A Windows Host's sshd refuses a second session on a shared connection ("No existing session"): its block says
    ControlMaster no, with no ControlPath or ControlPersist to reuse one."""
    from roster.common import WINDOWS
    from roster.sshops import write_ssh_config
    write_ssh_config(load_config(write_config(CASCADE)))
    text = (isolated["home"] / ".ssh" / "config.d" / "roster").read_text()
    block = {name: text.split(f"Host {name}\n")[1].split("\n\n")[0] for name in ("dc-01", "web-1")}
    assert "ControlMaster no" in block["dc-01"]
    assert "ControlPath" not in block["dc-01"] and "ControlPersist" not in block["dc-01"]
    if not WINDOWS:                     # roster on Windows shares no connection with any Host
        assert "ControlMaster auto" in block["web-1"]


# ---------------------------------------------------------------- the PowerShell scripts, on stand-in Windows Hosts

def test_the_command_a_windows_host_gets_is_fixed_and_holds_no_value():
    """Whatever shell the Host's sshd runs (cmd.exe, PowerShell) reads the command the same: only base64 after the
    flags, the same bootstrap every time. The key line and the tag go in the script on stdin, never in argv."""
    import base64
    import re

    from roster import winhost
    cmd = winhost.remote_command()
    words = cmd.split()
    assert words[:4] == ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand"] and len(words) == 5
    assert re.fullmatch(r"[A-Za-z0-9+/=]+", words[4])     # nothing cmd.exe or PowerShell reads specially
    assert len(cmd) < 8191                                  # cmd.exe's longest command line
    assert "[Console]::In.ReadToEnd()" in base64.b64decode(words[4]).decode("utf-16-le")
    script = winhost.script("add", " (roster-managed|fleet-managed):box$", "ssh-ed25519 AAAAkey roster-managed:box")
    assert "$Pub = 'ssh-ed25519 AAAAkey roster-managed:box'" in script and "AAAAkey" not in cmd


@pytest.mark.parametrize("value", ["it's", "a\u2019b"])
def test_a_value_in_the_script_is_a_literal_whatever_quotes_it_holds(value):
    from roster.winhost import ps_literal
    lit = ps_literal(value)
    assert lit.startswith("'") and lit.endswith("'") and "'" not in lit[1:-1].replace("''", "")
    with pytest.raises(ValueError):
        ps_literal("a\nb")


POWERSHELL = shutil.which("pwsh") or (shutil.which("powershell.exe") if WINDOWS else None)
needs_powershell = pytest.mark.skipif(POWERSHELL is None,
                                      reason="the stand-in Windows Hosts run their side with PowerShell (pwsh)")

STOCK_SSHD = """\
# This is the sshd server system-wide configuration file.
#PubkeyAuthentication yes
AuthorizedKeysFile\t.ssh/authorized_keys
Subsystem\tsftp\tsftp-server.exe

Match Group administrators
       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
"""

WIN = """\
box_name: box
defaults: { user: admin }
groups:
  dcs:
    os: windows
    auth: env:DCPW
    hosts:
      dc-01: 10.0.0.5
      ws-01: { ip: 10.0.0.6, user: alice }
  lab:
    auth: env:DCPW
    hosts:
      dc-09: 10.0.0.9
      web-1: { ip: 10.0.0.7, os: windows }
"""
ME = "S-1-5-21-1000-1000-1000-1001"
OTHER = b"ssh-ed25519 AAAAother other@laptop\r\n"
OLD = b"ssh-ed25519 AAAAold roster-managed:box\r\n"


# The two shells a Windows Host's sshd hands the command line to: cmd.exe (its DefaultShell unset, Windows' default)
# and PowerShell (DefaultShell set). roster never relies on either: it launches powershell itself.
SHELLS = pytest.mark.parametrize("win", ["cmd", "powershell"], indirect=True)


@pytest.fixture
def win(request, fakes, isolated, write_config, monkeypatch, tmp_path):
    """Stand-in Hosts: dc-01 (Windows, the account in Administrators), ws-01 (Windows, a plain user), dc-09 (Windows,
    but roster.yml has no os: for it), web-1 (os: windows, but a POSIX Host). Their sshd's DefaultShell is the test's
    (SHELLS), PowerShell otherwise. Their host keys are recorded, so setup scans nothing; a password login runs through
    the stand-in ssh, stdin and all, as paramiko's would."""
    shell = getattr(request, "param", "powershell")
    root = isolated["home"].parent.resolve() / "hosts"
    for name in ("dc-01", "ws-01", "dc-09", "web-1"):
        d = root / name
        (d / "programdata" / "ssh").mkdir(parents=True)
        (d / "home").mkdir()
        (d / "programdata" / "ssh" / "sshd_config").write_text(STOCK_SSHD)
        if name != "web-1":
            (d / "windows").write_text(shell)
    (root / "dc-01" / "admin").touch()
    (root / "dc-09" / "admin").touch()
    kh = isolated["home"] / ".ssh"
    kh.mkdir()
    (kh / "roster_known_hosts").write_text("".join(f"10.0.0.{n} ssh-ed25519 AAAAhostkey\n" for n in (5, 6, 7, 9)))
    monkeypatch.setenv("FAKE_HOSTS", str(root))
    monkeypatch.setenv("DCPW", "hunter2")
    log = tmp_path / "ssh.log"
    monkeypatch.setenv("FAKE_LOG", str(log))
    sent = []

    def via_stand_in(h, command, password, timeout=15, stdin=None):
        sent.append((command, stdin or ""))
        assert password == "hunter2"
        r = subprocess.run(program_argv(["ssh", h["name"], command]), input=(stdin or "").encode(),
                           capture_output=True)
        return r.returncode, r.stdout.decode(), r.stderr.decode()
    monkeypatch.setattr(sshops, "password_exec", via_stand_in)
    write_config(WIN)
    w = type("Win", (), {})()
    w.root, w.sent = root, sent
    w.ssh_log = lambda: log.read_text() if log.exists() else ""
    w.admin_file = lambda n: root / n / "programdata" / "ssh" / "administrators_authorized_keys"
    w.user_file = lambda n: root / n / "home" / ".ssh" / "authorized_keys"
    w.icacls = lambda n: (root / n / "icacls.log").read_text().splitlines() if (root / n / "icacls.log").exists() else []

    def acl(n, f):
        state = json.loads((root / n / "acls.json").read_text())
        return state[os.path.normcase(os.path.abspath(f))]
    w.acl = acl
    w.pub = lambda: (isolated["home"] / ".ssh" / "roster_ed25519.pub").read_text().split()
    return w


def key_line(w):
    t, k = w.pub()[:2]
    return f"{t} {k} roster-managed:box\r\n".encode()


@needs_powershell
@SHELLS
def test_setup_puts_an_admins_key_in_the_admin_file_with_microsofts_acl(win, capsys):
    win.admin_file("dc-01").write_bytes(OTHER + OLD)
    assert main(["setup", "--only", "dc-01"]) == 0
    out = capsys.readouterr().out
    assert "ok    dc-01" in out and "administrators_authorized_keys" in out
    # only this Box's line changed: the old one gone, the new one added, every other byte kept; ASCII, no BOM
    assert win.admin_file("dc-01").read_bytes() == OTHER + key_line(win)
    assert not win.user_file("dc-01").exists()
    assert win.icacls("dc-01")[0].endswith("/inheritance:r /grant:r *S-1-5-32-544:F /grant:r *S-1-5-18:F")
    acl = win.acl("dc-01", win.admin_file("dc-01"))
    assert acl["protected"] and sorted(e["sid"] for e in acl["allow"]) == ["S-1-5-18", "S-1-5-32-544"]
    # the password was only the login's: never in a command or a script
    assert all("hunter2" not in c + s for c, s in win.sent) and "hunter2" not in win.ssh_log()
    # again: the key login works now, so nothing is sent
    sent = len(win.sent)
    assert main(["setup", "--only", "dc-01"]) == 0
    assert "1 already work" in capsys.readouterr().out and len(win.sent) == sent


@needs_powershell
@SHELLS
def test_setup_creates_the_admin_file_when_there_is_none(win, capsys):
    """The usual case on a new Host: no administrators_authorized_keys yet. It's made with Microsoft's ACL, and the
    key login works only once that's set (sshd ignores the file until then)."""
    assert not win.admin_file("dc-01").exists()
    assert main(["setup", "--only", "dc-01"]) == 0
    assert win.admin_file("dc-01").read_bytes() == key_line(win)
    acl = win.acl("dc-01", win.admin_file("dc-01"))
    assert acl["protected"] and sorted(e["sid"] for e in acl["allow"]) == ["S-1-5-18", "S-1-5-32-544"]
    assert not list(win.admin_file("dc-01").parent.glob("*.roster-new"))


@needs_powershell
def test_setup_takes_an_admin_files_other_principals_out_of_its_acl(win, capsys):
    win.admin_file("dc-01").write_bytes(OTHER)
    (win.root / "dc-01" / "acls.json").write_text(json.dumps({os.path.normcase(os.path.abspath(win.admin_file("dc-01"))): {
        "protected": True, "owner": "S-1-5-32-544",
        "allow": [{"sid": "S-1-5-32-544", "rights": "FullControl", "inherited": False},
                  {"sid": "S-1-5-11", "rights": "Modify", "inherited": False}]}}))
    assert main(["setup", "--only", "dc-01"]) == 0
    assert "/remove:g *S-1-5-11" in win.icacls("dc-01")
    assert sorted(e["sid"] for e in win.acl("dc-01", win.admin_file("dc-01"))["allow"]) == ["S-1-5-18", "S-1-5-32-544"]


@needs_powershell
def test_setup_gives_a_new_user_file_this_account_system_and_administrators(win, capsys):
    assert main(["setup", "--only", "ws-01"]) == 0
    assert win.user_file("ws-01").read_bytes() == key_line(win)
    assert not win.admin_file("ws-01").exists()
    assert win.icacls("ws-01") == [f"/inheritance:r /grant:r *{ME}:F /grant:r *S-1-5-18:F /grant:r *S-1-5-32-544:F"]


@needs_powershell
def test_an_existing_user_files_acl_is_never_changed_only_reported(win, capsys):
    win.user_file("ws-01").parent.mkdir()
    win.user_file("ws-01").write_bytes(b"ssh-ed25519 AAAAother other@laptop\n")
    (win.root / "ws-01" / "acls.json").write_text(json.dumps({os.path.normcase(os.path.abspath(win.user_file("ws-01"))): {
        "protected": False, "owner": ME,
        "allow": [{"sid": ME, "rights": "FullControl", "inherited": True},
                  {"sid": "S-1-1-0", "rights": "ReadAndExecute", "inherited": True}]}}))
    assert main(["setup", "--only", "ws-01"]) == 0
    out = capsys.readouterr().out
    assert "[157]" in out and "S-1-1-0" in out
    assert win.icacls("ws-01") == []
    # its own line ends (LF) kept, and the new line takes the same
    t, k = win.pub()[:2]
    assert win.user_file("ws-01").read_bytes() == b"ssh-ed25519 AAAAother other@laptop\n" + f"{t} {k} roster-managed:box\n".encode()


@needs_powershell
@pytest.mark.parametrize("start", [b"\xef\xbb\xbf", b"\xff\xfe"])
def test_a_key_file_sshd_cant_read_is_refused_not_re_encoded(win, capsys, start):
    win.admin_file("dc-01").write_bytes(start + OTHER)
    assert main(["setup", "--only", "dc-01"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  dc-01: [157]" in out and "nothing was changed" in out
    assert win.admin_file("dc-01").read_bytes() == start + OTHER and win.icacls("dc-01") == []


@needs_powershell
def test_an_sshd_config_roster_cant_follow_is_refused(win, capsys):
    cfg = win.root / "dc-01" / "programdata" / "ssh" / "sshd_config"
    cfg.write_text(STOCK_SSHD.replace("AuthorizedKeysFile\t.ssh/authorized_keys", "AuthorizedKeysFile C:/keys/%u"))
    assert main(["setup", "--only", "dc-01"]) == 1
    assert "[157] sshd_config sets AuthorizedKeysFile C:/keys/%u for every account" in capsys.readouterr().out
    assert not win.admin_file("dc-01").exists()


@needs_powershell
@SHELLS
def test_revoke_cleans_both_files_an_admins_key_could_be_in(win, capsys):
    win.admin_file("dc-01").write_bytes(OTHER + OLD)
    win.user_file("dc-01").parent.mkdir()
    win.user_file("dc-01").write_bytes(OLD + OTHER)
    assert main(["revoke", "-y", "--only", "dc-01"]) == 0
    assert "ok    dc-01" in capsys.readouterr().out
    assert win.admin_file("dc-01").read_bytes() == OTHER and win.user_file("dc-01").read_bytes() == OTHER
    runs = [ln for ln in win.ssh_log().splitlines() if " dc-01 " in ln]
    assert runs and all(ln.split()[-1] != "OLD" and "ControlPath=none" in ln and "-EncodedCommand" in ln for ln in runs)
    assert "ssh -O exit" not in win.ssh_log()                       # no shared connection to drop


@needs_powershell
def test_check_reports_a_user_file_others_can_use(win, capsys, monkeypatch):
    win.user_file("ws-01").parent.mkdir()
    assert main(["setup", "--only", "ws-01"]) == 0
    state = {os.path.normcase(os.path.abspath(win.user_file("ws-01"))): {
        "protected": True, "owner": ME, "allow": [{"sid": ME, "rights": "FullControl", "inherited": False},
                                                   {"sid": "S-1-5-32-545", "rights": "Read", "inherited": False}]}}
    (win.root / "ws-01" / "acls.json").write_text(json.dumps(state))
    capsys.readouterr()
    assert main(["check", "--only", "ws-01"]) == 0
    captured = capsys.readouterr()
    assert "ws-01  ssh:ok" in captured.out
    assert "warning: [157] ws-01:" in captured.err and "S-1-5-32-545" in captured.err


@SHELLS
def test_a_windows_host_without_os_windows_says_to_set_it(win, capsys):
    """dc-09 is Windows, but roster.yml doesn't say so: setup's sh script fails as PowerShell fails it."""
    assert main(["setup", "--only", "dc-09"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  dc-09: [155] dc-09 looks like a Windows Host" in out and "os: windows" in out


@stand_in_hosts
def test_os_windows_on_a_host_without_powershell_changes_nothing(win, capsys, monkeypatch):
    from conftest import POSIX_SH
    monkeypatch.setenv("FAKE_SH", POSIX_SH)
    assert main(["revoke", "-y", "--only", "web-1"]) == 1
    assert "FAIL  web-1: [156] web-1 has os: windows, but it has no PowerShell" in capsys.readouterr().out
    assert not (win.root / "web-1" / "home" / ".ssh").exists()


def test_a_refused_key_on_a_windows_host_points_at_its_key_file(write_config):
    from roster.diagnose import login_failure
    hosts = load_config(write_config(CASCADE))["hosts"]
    p = login_failure(hosts["dc-01"], False, "admin@10.0.0.5: Permission denied (publickey).")
    assert p.code == 46 and "permissions" in p.fix and "administrators_authorized_keys" in p.fix
    assert "administrators_authorized_keys" not in login_failure(hosts["web-1"], False, "Permission denied").fix
