"""Windows Hosts (T195, #375, decision Q174): roster.yml's `os:`, and setup, revoke and check on an `os: windows` Host
through PowerShell scripts sent on stdin. The stand-in Windows Host (tests/fakes/ssh, FAKE_HOSTS with a `windows`
marker) runs the decoded script with pwsh (Linux) or powershell.exe (Windows); nothing here connects anywhere."""
import json
import os
import shutil
import subprocess
import sys

import pytest
from conftest import FAKES, WINDOWS, stand_in_hosts

from roster import sshops
from roster.cli import main
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
    assert "OpenStandardInput()" in base64.b64decode(words[4]).decode("utf-16-le")
    script = winhost.script("add", " (roster-managed|fleet-managed):box$", "ssh-ed25519 AAAAkey roster-managed:box")
    assert "$Pub = 'ssh-ed25519 AAAAkey roster-managed:box'" in script and "AAAAkey" not in cmd



@pytest.mark.parametrize("value", ["it's", "roster-managed:box$"])
def test_a_value_in_the_script_is_a_literal_whatever_quotes_it_holds(value):
    from roster.winhost import ps_literal
    lit = ps_literal(value)
    assert lit.startswith("'") and lit.endswith("'") and "'" not in lit[1:-1].replace("''", "")


@pytest.mark.parametrize("value", ["a\nb", "a\x00b", "a\u2019b", "cl\u00e9", "a\x1b[2Jb"])
def test_a_value_that_isnt_printable_ascii_never_goes_into_the_script(value):
    """The Host decodes stdin as UTF-8, but a byte its code page reads as a quote (0x91, 0x92 in CP 1252) could still
    end a literal: only printable ASCII goes in (the key line and tag are ASCII anyway)."""
    from roster.winhost import ps_literal
    with pytest.raises(ValueError):
        ps_literal(value)


def test_the_script_and_its_bootstrap_are_ascii_and_read_stdin_as_utf8():
    import base64

    from roster import winhost
    script = winhost.script("add", " (roster-managed|fleet-managed):box$", "ssh-ed25519 AAAAkey roster-managed:box")
    assert script.isascii()
    boot = base64.b64decode(winhost.remote_command().split()[-1]).decode("utf-16-le")
    assert "UTF8" in boot and "OpenStandardInput" in boot


def test_what_a_host_says_is_printed_without_control_characters():
    """A hostile Host's ERROR line could carry terminal escapes: they never reach this Box's terminal."""
    from roster import winhost
    with pytest.raises(RuntimeError) as e:
        winhost.outcome("dc-01", 0, "ERROR bad\x1b[2J\x07thing\n", "")
    assert "\x1b" not in str(e.value) and "\x07" not in str(e.value) and "bad" in str(e.value)
    r = winhost.outcome("dc-01", 0, "WARN a\x1b]0;title\x07b\nROSTER_OK\n", "")
    assert r.warnings == ["a?]0;title?b"]

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
ADMINS, SYSTEM, USERS, AUTH_USERS = "S-1-5-32-544", "S-1-5-18", "S-1-5-32-545", "S-1-5-11"
OTHER = b"ssh-ed25519 AAAAother other@laptop\r\n"
OLD = b"ssh-ed25519 AAAAold roster-managed:box\r\n"
PLANTED = b"ssh-ed25519 AAAAplanted someone@else\r\n"


def ace(sid, rights="FullControl", inherited=False, kind="Allow"):
    return {"sid": sid, "rights": rights, "inherited": inherited, "type": kind}


# The two shells a Windows Host's sshd hands the command line to: cmd.exe (its DefaultShell unset, Windows' default)
# and PowerShell (DefaultShell set). roster never relies on either: it launches powershell itself.
SHELLS = pytest.mark.parametrize("win", ["cmd", "powershell"], indirect=True)


@pytest.fixture
def win(request, fakes, isolated, write_config, monkeypatch, tmp_path):
    """Stand-in Hosts: dc-01 (Windows, the account in Administrators), ws-01 (Windows, a plain user), dc-09 (Windows,
    but roster.yml has no os: for it), web-1 (os: windows, but a POSIX Host). Their sshd's DefaultShell is the test's
    (SHELLS), PowerShell otherwise. Their host keys are recorded, so setup scans nothing; a password login runs through
    the stand-in ssh, stdin and all, as paramiko's would. A file's ACL in the stand-in follows the file (by inode), as
    NTFS's does through a rename."""
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
        # the stand-in ssh itself, not its .cmd shim on Windows: paramiko hands the Host the command as it is, and a
        # POSIX script's quotes would never reach a batch file
        r = subprocess.run([sys.executable, str(FAKES / "ssh"), h["name"], command], input=(stdin or "").encode(),
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

    def key(f):
        st = os.stat(f)
        return f"{st.st_dev}:{st.st_ino}"

    def state(n):
        f = root / n / "acls.json"
        return json.loads(f.read_text()) if f.exists() else {}

    def acl(n, f):
        return state(n)[key(f)]

    def set_acl(n, f, owner, *aces, protected=True):
        s = state(n)
        s[key(f)] = {"protected": protected, "owner": owner, "allow": list(aces)}
        (root / n / "acls.json").write_text(json.dumps(s))
    w.acl, w.set_acl = acl, set_acl
    w.pub = lambda: (isolated["home"] / ".ssh" / "roster_ed25519.pub").read_text().split()
    return w


def key_line(w):
    t, k = w.pub()[:2]
    return f"{t} {k} roster-managed:box\r\n".encode()


def sids(acl, kind="Allow"):
    return sorted(e["sid"] for e in acl["allow"] if e.get("type", "Allow") == kind)


@needs_powershell
@SHELLS
def test_setup_puts_an_admins_key_in_the_admin_file_with_microsofts_acl(win, capsys):
    win.admin_file("dc-01").write_bytes(OTHER + OLD)        # the folder's inherited ACL: Authenticated Users may read
    assert main(["setup", "--only", "dc-01"]) == 0
    out = capsys.readouterr().out
    assert "ok    dc-01" in out and "administrators_authorized_keys" in out
    assert "every administrator on dc-01" in out            # what a key in that file means: Microsoft's design
    # only this Box's line changed: the old one gone, the new one added, every other byte kept; ASCII, no BOM
    assert win.admin_file("dc-01").read_bytes() == OTHER + key_line(win)
    assert not win.user_file("dc-01").exists()
    assert f"/inheritance:r /grant:r *{ADMINS}:F /grant:r *{SYSTEM}:F" in " | ".join(win.icacls("dc-01"))
    acl = win.acl("dc-01", win.admin_file("dc-01"))
    assert acl["protected"] and sids(acl) == [SYSTEM, ADMINS] and acl["owner"] == ADMINS
    # the password was only the login's: never in a command or a script
    assert all("hunter2" not in c + s for c, s in win.sent) and "hunter2" not in win.ssh_log()
    assert not [p for p in win.admin_file("dc-01").parent.iterdir() if ".roster-" in p.name]     # no temp file left
    # again: the key login works now, so nothing is sent
    sent = len(win.sent)
    assert main(["setup", "--only", "dc-01"]) == 0
    assert "1 already work" in capsys.readouterr().out and len(win.sent) == sent


def stand_in(name, command, data, wait="60"):
    """Run COMMAND on stand-in Host NAME with DATA on stdin: (exit code, stdout, stderr)."""
    r = subprocess.run([sys.executable, str(FAKES / "ssh"), name, command], input=data, capture_output=True,
                       env={**os.environ, "FAKE_EOF_WAIT": wait})
    return r.returncode, r.stdout.decode(), r.stderr.decode()


@needs_powershell
def test_a_script_past_4096_bytes_runs_though_the_hosts_sshd_never_sends_eof(win):
    """Win32-OpenSSH never delivers EOF on stdin past 4096 bytes (measured on real Hosts): the bootstrap reads a length
    line, then exactly that many bytes, and never waits for EOF. The stand-in Host has the same limit."""
    from roster import winhost
    script = winhost.script("check", " (roster-managed|fleet-managed):box$")
    assert len(script) > 4096
    rc, out, _ = stand_in("dc-01", winhost.remote_command(), winhost.framed(script).encode())
    assert "ROSTER_OK" in out
    # what waited for EOF hangs on the stand-in, as on the real Host
    old = "$s=[Console]::In.ReadToEnd(); & ([scriptblock]::Create($s))"
    import base64
    cmd = "powershell -NoProfile -NonInteractive -EncodedCommand " + base64.b64encode(old.encode("utf-16-le")).decode()
    rc, out, err = stand_in("dc-01", cmd, script.encode(), wait="3")
    assert rc == 255 and "ROSTER_OK" not in out and "never ended" in err


@needs_powershell
@pytest.mark.parametrize("data", [b"abc\nSay-Nothing", b"100\nshort", b"", b"99999999\n", b"12"])
def test_a_bad_length_line_or_a_short_script_runs_nothing(win, data):
    from roster import winhost
    rc, out, _ = stand_in("dc-01", winhost.remote_command(), data)
    assert rc != 0 and "ERROR" in out and "ROSTER_OK" not in out


def test_the_script_goes_with_its_length_and_the_launch_line_stays_short():
    from roster import winhost
    script = winhost.script("add", " (roster-managed|fleet-managed):box$", "ssh-ed25519 AAAAkey roster-managed:box")
    assert winhost.framed(script) == f"{len(script.encode())}\n{script}"
    assert len(winhost.remote_command()) < 8191 - 200          # cmd.exe's limit, with room for ssh's own words


@needs_powershell
@SHELLS
def test_setup_creates_the_admin_file_when_there_is_none(win, capsys):
    """The usual case on a new Host: no administrators_authorized_keys yet. Its temp file gets Microsoft's ACL and
    Administrators as owner before the key is written into it, then it's moved into place."""
    assert not win.admin_file("dc-01").exists()
    assert main(["setup", "--only", "dc-01"]) == 0
    assert win.admin_file("dc-01").read_bytes() == key_line(win)
    acl = win.acl("dc-01", win.admin_file("dc-01"))
    assert acl["protected"] and sids(acl) == [SYSTEM, ADMINS] and acl["owner"] == ADMINS
    first = win.icacls("dc-01")[0]
    assert ".roster-" in first and first.endswith(f"/setowner *{ADMINS}")      # the temp file, first thing


@needs_powershell
@pytest.mark.parametrize("rights", ["Modify", "Write", "FullControl", "AppendData", "-536805376", "64", "33554432"])
def test_an_admin_file_others_could_write_is_refused_and_left_as_it_was(win, capsys, rights):
    """Review B1: sshd ignores an admin file others can write; narrowing its ACL now would turn on a key someone
    planted there, for every administrator. So it's refused, the file and its ACL untouched."""
    f = win.admin_file("dc-01")
    f.write_bytes(OTHER + PLANTED)
    win.set_acl("dc-01", f, ADMINS, ace(ADMINS), ace(SYSTEM), ace(USERS, rights))
    before = win.acl("dc-01", f)
    assert main(["setup", "--only", "dc-01"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  dc-01: [157]" in out and USERS in out and "nothing was changed" in out
    assert f.read_bytes() == OTHER + PLANTED and win.acl("dc-01", f) == before and win.icacls("dc-01") == []


@needs_powershell
def test_an_admin_file_someone_else_owns_is_refused_and_left_as_it_was(win, capsys):
    f = win.admin_file("dc-01")
    f.write_bytes(OTHER + PLANTED)
    win.set_acl("dc-01", f, "S-1-5-21-1000-1000-1000-1002", ace(ADMINS), ace(SYSTEM))
    assert main(["setup", "--only", "dc-01"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  dc-01: [157]" in out and "owned by S-1-5-21-1000-1000-1000-1002" in out
    assert f.read_bytes() == OTHER + PLANTED and win.icacls("dc-01") == []


@needs_powershell
def test_an_admin_file_others_may_only_read_is_narrowed(win, capsys):
    f = win.admin_file("dc-01")
    f.write_bytes(OTHER)
    win.set_acl("dc-01", f, ADMINS, ace(ADMINS), ace(SYSTEM), ace(AUTH_USERS, "ReadAndExecute, Synchronize", True),
                protected=False)
    assert main(["setup", "--only", "dc-01"]) == 0
    assert sids(win.acl("dc-01", f)) == [SYSTEM, ADMINS]


@needs_powershell
def test_a_key_folder_others_can_write_in_is_refused(win, capsys):
    """Others who can write in %ProgramData%\\ssh could swap or seed the file roster writes: refused, nothing made."""
    d = win.admin_file("dc-01").parent
    win.set_acl("dc-01", d, ADMINS, ace(ADMINS), ace(SYSTEM), ace(USERS, "Modify"))
    assert main(["setup", "--only", "dc-01"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  dc-01: [157]" in out and "write in it" in out
    assert not win.admin_file("dc-01").exists() and win.icacls("dc-01") == []


@needs_powershell
@pytest.mark.parametrize("host, folder", [("dc-01", "programdata/ssh"), ("ws-01", "home/.ssh")])
def test_a_key_folder_someone_else_owns_is_refused(win, capsys, host, folder):
    """Second review S2: the folder's owner can change its permissions whenever they like, so it must be SYSTEM or
    Administrators (or, for the account's own .ssh, the account)."""
    d = win.root / host / folder
    d.mkdir(parents=True, exist_ok=True)
    win.set_acl(host, d, "S-1-5-21-1000-1000-1000-1002", ace(ADMINS), ace(SYSTEM), ace(ME))
    assert main(["setup", "--only", host]) == 1
    out = capsys.readouterr().out
    assert f"FAIL  {host}: [157]" in out and "owned by S-1-5-21-1000-1000-1000-1002" in out
    assert win.icacls(host) == [] and not [p for p in d.iterdir() if "authorized_keys" in p.name]


@needs_powershell
def test_revoke_refuses_an_admin_file_others_could_write(win, capsys):
    """Second review S3: revoke rewrites the admin file too, so the same refusal holds there: nothing changed."""
    f = win.admin_file("dc-01")
    f.write_bytes(OTHER + PLANTED + OLD)
    win.set_acl("dc-01", f, ADMINS, ace(ADMINS), ace(SYSTEM), ace(USERS, "Modify"))
    before = win.acl("dc-01", f)
    assert main(["revoke", "-y", "--only", "dc-01"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  dc-01: [157]" in out and USERS in out
    assert f.read_bytes() == OTHER + PLANTED + OLD and win.acl("dc-01", f) == before and win.icacls("dc-01") == []


@needs_powershell
def test_a_temp_file_someone_left_is_never_reused(win, capsys):
    """The temp file's name is random and made with CreateNew: one someone made beside it is never opened."""
    planted = win.admin_file("dc-01").parent / "administrators_authorized_keys.roster-new"
    planted.write_bytes(PLANTED)
    assert main(["setup", "--only", "dc-01"]) == 0
    assert planted.read_bytes() == PLANTED
    assert win.admin_file("dc-01").read_bytes() == key_line(win)


@needs_powershell
def test_check_reports_an_admin_file_that_denies_system(win, capsys):
    """Review F3: a deny entry for SYSTEM (sshd reads as SYSTEM) isn't Microsoft's ACL, and icacls' grants don't take
    it away: check says so."""
    assert main(["setup", "--only", "dc-01"]) == 0
    f = win.admin_file("dc-01")
    win.set_acl("dc-01", f, ADMINS, ace(ADMINS), ace(SYSTEM), ace(SYSTEM, "Read", kind="Deny"))
    capsys.readouterr()
    assert main(["check", "--only", "dc-01"]) == 0
    assert "denies S-1-5-18" in capsys.readouterr().err


@needs_powershell
def test_setup_gives_a_new_user_file_this_account_system_and_administrators(win, capsys):
    assert main(["setup", "--only", "ws-01"]) == 0
    out = capsys.readouterr().out
    assert win.user_file("ws-01").read_bytes() == key_line(win)
    assert not win.admin_file("ws-01").exists() and "every administrator" not in out
    calls = win.icacls("ws-01")
    assert len(calls) == 1 and ".roster-" in calls[0]          # on the temp file, before the key is in it
    assert calls[0].endswith(f"/inheritance:r /grant:r *{ME}:F /grant:r *{SYSTEM}:F /grant:r *{ADMINS}:F")
    acl = win.acl("ws-01", win.user_file("ws-01"))
    assert acl["protected"] and sids(acl) == [SYSTEM, ME, ADMINS]


@needs_powershell
def test_a_new_user_files_acl_is_read_back(win, capsys):
    """Review F3: icacls saying it worked isn't enough: the ACL is read back by SID before any key goes in."""
    (win.root / "ws-01" / "icacls-noop").touch()            # this stand-in's icacls exits 0 and changes nothing
    assert main(["setup", "--only", "ws-01"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  ws-01: [157]" in out
    assert not win.user_file("ws-01").exists()
    assert not [p for p in (win.root / "ws-01" / "home" / ".ssh").iterdir()]


@needs_powershell
def test_an_existing_user_files_acl_is_never_changed_only_reported(win, capsys):
    f = win.user_file("ws-01")
    f.parent.mkdir()
    f.write_bytes(b"ssh-ed25519 AAAAother other@laptop\n")
    win.set_acl("ws-01", f, ME, ace(ME, inherited=True), ace("S-1-1-0", "Modify", True), protected=False)
    assert main(["setup", "--only", "ws-01"]) == 0
    out = capsys.readouterr().out
    assert "[157]" in out and "S-1-1-0" in out
    assert win.icacls("ws-01") == []
    # its own line ends (LF) kept, and the new line takes the same
    t, k = win.pub()[:2]
    assert f.read_bytes() == b"ssh-ed25519 AAAAother other@laptop\n" + f"{t} {k} roster-managed:box\n".encode()


@needs_powershell
def test_others_reading_a_user_file_isnt_reported(win, capsys):
    """Review F3: sshd minds who can write a key file, not who can read it."""
    f = win.user_file("ws-01")
    f.parent.mkdir()
    f.write_bytes(b"ssh-ed25519 AAAAother other@laptop\n")
    win.set_acl("ws-01", f, ME, ace(ME), ace(USERS, "ReadAndExecute, Synchronize"))
    assert main(["setup", "--only", "ws-01"]) == 0
    assert "[157]" not in capsys.readouterr().out


@needs_powershell
def test_a_non_ascii_comment_in_this_boxs_key_changes_nothing(win, capsys, isolated):
    """Review F1: only the key type, the key and the tag go to the Host; the .pub's own comment never does."""
    assert main(["setup", "--only", "ws-01"]) == 0
    pub = isolated["home"] / ".ssh" / "roster_ed25519.pub"
    t, k = pub.read_text().split()[:2]
    pub.write_text(f"{t} {k} cl\u00e9@bo\u00eete\n", encoding="utf-8")
    win.user_file("ws-01").unlink()
    assert main(["setup", "--only", "ws-01"]) == 0
    assert win.user_file("ws-01").read_bytes() == key_line(win)
    assert all(s.isascii() for _, s in win.sent)


@needs_powershell
@pytest.mark.parametrize("start", [b"\xef\xbb\xbf", b"\xff\xfe"])
def test_a_key_file_sshd_cant_read_is_refused_not_re_encoded(win, capsys, start):
    win.admin_file("dc-01").write_bytes(start + OTHER)
    assert main(["setup", "--only", "dc-01"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  dc-01: [157]" in out and "nothing was changed" in out
    assert win.admin_file("dc-01").read_bytes() == start + OTHER and win.icacls("dc-01") == []


@needs_powershell
@pytest.mark.parametrize("change, said", [
    (("AuthorizedKeysFile\t.ssh/authorized_keys", "AuthorizedKeysFile C:/keys/%u"),
     "sshd_config sets AuthorizedKeysFile C:/keys/%u for every account"),
    (("Subsystem", "Include C:/ProgramData/ssh/sshd_config.d/*.conf\nSubsystem"), "Include"),
    (("__PROGRAMDATA__/ssh/administrators_authorized_keys", "keys/admins"), "relative"),
])
def test_an_sshd_config_roster_cant_follow_is_refused(win, capsys, change, said):
    cfg = win.root / "dc-01" / "programdata" / "ssh" / "sshd_config"
    cfg.write_text(STOCK_SSHD.replace(*change))
    assert main(["setup", "--only", "dc-01"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  dc-01: [157]" in out and said in out
    assert not win.admin_file("dc-01").exists()


@needs_powershell
@SHELLS
def test_revoke_cleans_both_files_an_admins_key_could_be_in(win, capsys):
    win.admin_file("dc-01").write_bytes(OTHER + OLD)
    win.user_file("dc-01").parent.mkdir()
    win.user_file("dc-01").write_bytes(OLD.replace(b"\r\n", b"  \r\n") + OTHER)     # a trailing space someone left
    assert main(["revoke", "-y", "--only", "dc-01"]) == 0
    assert "ok    dc-01" in capsys.readouterr().out
    assert win.admin_file("dc-01").read_bytes() == OTHER and win.user_file("dc-01").read_bytes() == OTHER
    runs = [ln for ln in win.ssh_log().splitlines() if " dc-01 " in ln]
    assert runs and all(ln.split()[-1] != "OLD" and "ControlPath=none" in ln and "-EncodedCommand" in ln for ln in runs)
    assert "ssh -O exit" not in win.ssh_log()                       # no shared connection to drop


@needs_powershell
def test_revoke_from_an_account_no_longer_an_administrator_warns_about_the_admin_file(win, capsys):
    """Review F4: a key the account added while an administrator may still be in the admin file, which this account
    can't open now: revoke says so, and how to take it out."""
    win.user_file("ws-01").parent.mkdir()
    win.user_file("ws-01").write_bytes(OLD)
    assert main(["revoke", "-y", "--only", "ws-01"]) == 0
    captured = capsys.readouterr()
    assert "ok    ws-01" in captured.out and win.user_file("ws-01").read_bytes() == b""
    assert "administrators_authorized_keys" in captured.err and "roster-managed:box" in captured.err


@needs_powershell
def test_check_reports_a_user_file_others_can_write(win, capsys, monkeypatch):
    win.user_file("ws-01").parent.mkdir()
    assert main(["setup", "--only", "ws-01"]) == 0
    win.set_acl("ws-01", win.user_file("ws-01"), ME, ace(ME), ace(USERS, "Write"))
    capsys.readouterr()
    assert main(["check", "--only", "ws-01"]) == 0
    captured = capsys.readouterr()
    assert "ws-01  ssh:ok" in captured.out
    assert "warning: [157] ws-01:" in captured.err and USERS in captured.err


@needs_powershell
def test_check_says_an_admin_file_key_logs_in_as_every_administrator(win, capsys):
    assert main(["setup", "--only", "dc-01"]) == 0
    capsys.readouterr()
    assert main(["check", "--only", "dc-01"]) == 0
    assert "every administrator on dc-01" in capsys.readouterr().err


@SHELLS
def test_a_windows_host_without_os_windows_says_to_set_it(win, capsys):
    """dc-09 is Windows, but roster.yml doesn't say so: setup's sh script fails as PowerShell fails it."""
    assert main(["setup", "--only", "dc-09"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  dc-09: [155] dc-09 looks like a Windows Host" in out and "os: windows" in out


@stand_in_hosts
@pytest.mark.skipif(WINDOWS, reason="a POSIX stand-in Host on Windows would find this machine's own powershell")
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


# ---------------------------------------------------------------- roster run (T196, #376, decision Q176)

def run_on(win, capfd, *words, host="dc-01"):
    """`roster run HOST -- WORDS` on a stand-in Windows Host: (exit code, stdout, stderr), as the terminal got them."""
    main(["sync"])
    capfd.readouterr()
    rc = main(["run", host, "--", *words])
    out, err = capfd.readouterr()
    return rc, out, err


@needs_powershell
@SHELLS
def test_run_on_a_windows_host_runs_powershell_whatever_its_default_shell(win, capfd):
    """The same fixed launch line as setup's (base64 only), whatever sshd's DefaultShell; the command goes in the
    script on stdin, never in argv."""
    rc, out, err = run_on(win, capfd, "Write-Output", "'a & b | c'; $x = 1 + 1; Write-Output \"two=$x\"")
    assert (rc, out.splitlines()) == (0, ["a & b | c", "two=2"]) and "CLIXML" not in err
    ran = [ln for ln in win.ssh_log().splitlines() if " dc-01 " in ln]
    assert ran and all("Write-Output" not in ln and "a & b" not in ln for ln in ran)
    assert ran[-1].endswith(" dc-01 " + __import__("roster.winhost").winhost.remote_command())


@needs_powershell
@SHELLS
@pytest.mark.parametrize("command, code", [
    ("exit 3", 3),                                                   # the command's own exit
    ("& $env:FAKE_PYTHON -c 'import sys; sys.exit(4)'", 4),          # a native command's $LASTEXITCODE
    ("Get-Item -LiteralPath ./no-such-thing", 1),                    # a cmdlet that failed ($? false)
    ("throw 'boom'", 1),                                             # a terminating error
    ("& $env:FAKE_PYTHON -c 'import sys; sys.exit(4)'; Write-Output fine", 0),   # the last statement counts
    ("Write-Output fine", 0),
    ("Write-Error oops", 1),                                         # a cmdlet's error, last
    # a native command, as the owner tried it (cmd.exe where the stand-in's PowerShell is Windows', else sh)
    ("if (Get-Command cmd.exe -ErrorAction SilentlyContinue) { cmd /c exit 3 } else { sh -c 'exit 3' }", 3),
])
def test_run_on_a_windows_host_passes_on_its_exit_code(win, capfd, command, code):
    """The exact code under either DefaultShell: a PowerShell DefaultShell turns any failure into 1 (the stand-in does
    too), so the code comes back marked on stderr, and the marker isn't shown."""
    rc, out, err = run_on(win, capfd, command)
    assert rc == code, (out, err)
    assert "ROSTER_EXIT" not in err


@needs_powershell
@SHELLS
def test_an_exit_marker_in_the_commands_own_output_is_shown_and_ignored(win, capfd):
    """The marker carries a nonce roster makes for each run, which CMD never sees: one CMD writes is its output."""
    forged = "ROSTER_EXIT=" + "0" * 32 + ":0"
    rc, out, err = run_on(win, capfd, f"[Console]::Error.WriteLine('{forged}'); Write-Output '{forged}'; exit 5")
    assert rc == 5 and forged in err and forged in out


def test_a_run_scripts_exit_marker_is_its_own_nonces():
    from roster import winhost
    m = winhost.exit_marker("ab" * 16)
    assert m.fullmatch("ROSTER_EXIT=" + "ab" * 16 + ":3\r\n").group(1) == "3"
    assert not m.fullmatch("ROSTER_EXIT=" + "cd" * 16 + ":0\n")
    assert not m.fullmatch("x ROSTER_EXIT=" + "ab" * 16 + ":0\n")
    script = winhost.run_script("Write-Output hi", "ab" * 16)
    assert script.isascii() and "Write-Output" not in script        # CMD only as base64, two levels down


@needs_powershell
def test_run_on_a_windows_host_shows_errors_as_text(win, capfd):
    """Errors, warnings and a native command's stderr reach stderr as text (no CLIXML); a native command that wrote
    to stderr but exited 0 succeeded."""
    rc, out, err = run_on(win, capfd, "Write-Warning careful; Write-Error oops; "
                                      "& $env:FAKE_PYTHON -c 'import sys; sys.stderr.write(chr(110)+chr(10))'")
    assert rc == 0 and "CLIXML" not in err and "<Objs" not in err
    assert "WARNING: careful" in err and "oops" in err and "\nn" in "\n" + err
    rc, out, err = run_on(win, capfd, "throw 'boom'")
    assert rc == 1 and "boom" in err and "CLIXML" not in err


@needs_powershell
@pytest.mark.parametrize("command, said", [
    ("Write-Output 'it''s $(1+1) `n'", "it's $(1+1) `n"),            # PowerShell's own quoting, as the person wrote it
    # non-ASCII, UTF-8 both ways; a Unicode single quote is just a character inside PowerShell's double quotes
    ("Write-Output \"caf\u00e9 \u2019quoted\u2019 \u2713\"", "caf\u00e9 \u2019quoted\u2019 \u2713"),
    ("Write-Output \"$('x')\"", "x"),
])
def test_the_command_is_data_in_the_script_whatever_it_holds(win, capfd, command, said):
    rc, out, err = run_on(win, capfd, command)
    assert (rc, out.splitlines()) == (0, [said]), err


@needs_powershell
@SHELLS
def test_a_command_past_4096_bytes_runs_though_the_hosts_sshd_never_sends_eof(win, capfd, monkeypatch):
    """Win32-OpenSSH never delivers EOF on stdin past 4096 bytes, and run's script carries the person's command: it
    goes framed (its length first), as setup's does, so a long command runs and ends."""
    from roster import winhost
    monkeypatch.setenv("FAKE_EOF_WAIT", "20")       # a run that waited for EOF fails in 20 s, not 60
    command = "$s = '" + "a" * 6000 + "'; Write-Output $s.Length"
    assert len(winhost.run_script(command, "ab" * 16).encode()) > 4096
    rc, out, err = run_on(win, capfd, command)
    assert (rc, out.splitlines()) == (0, ["6000"]), err


def test_a_command_too_long_for_the_script_is_refused_before_anything_is_sent(win, capsys, monkeypatch):
    from roster import cli
    main(["sync"])
    monkeypatch.setattr(cli.subprocess, "Popen", lambda *a, **k: pytest.fail("something was sent"))
    from roster import winhost
    monkeypatch.setattr(winhost.subprocess, "Popen", lambda *a, **k: pytest.fail("something was sent"))
    with pytest.raises(SystemExit) as e:
        main(["run", "dc-01", "--", "a" * (1 << 20)])
    assert "over 1 MB" in str(e.value) and "nothing ran" in str(e.value)


@needs_powershell
def test_a_command_that_isnt_powershell_runs_nothing(win, capfd):
    rc, out, err = run_on(win, capfd, "Write-Output", "ran;", "echo", "(")
    assert rc == 1 and out == "" and "[161]" in err and "isn't PowerShell" in err


@needs_powershell
def test_run_on_a_windows_password_host_sends_the_same_script(win, capfd, write_config):
    write_config(WIN.replace("      dc-01: 10.0.0.5\n", "      dc-01: { ip: 10.0.0.5, enroll: false }\n"))
    rc, out, err = run_on(win, capfd, "Write-Output hello; exit 7")
    assert (rc, out.splitlines()) == (7, ["hello"])
    from roster import winhost
    assert win.sent and win.sent[-1][0] == winhost.remote_command() and "hello" not in win.sent[-1][0]


@stand_in_hosts
@pytest.mark.skipif(WINDOWS, reason="a POSIX stand-in Host on Windows would find this machine's own powershell")
def test_run_on_a_posix_host_marked_windows_says_to_fix_os(win, capfd, monkeypatch):
    from conftest import POSIX_SH
    monkeypatch.setenv("FAKE_SH", POSIX_SH)
    rc, out, err = run_on(win, capfd, "Write-Output hi", host="web-1")
    assert rc != 0 and "[156]" in err and "os:" in err


@pytest.mark.parametrize("enroll", [True, False])
def test_run_sudo_on_a_windows_host_is_refused_before_the_vault(write_config, monkeypatch, capsys, enroll):
    from roster import cli
    write_config(WIN.replace("      dc-01: 10.0.0.5\n", f"      dc-01: {{ ip: 10.0.0.5, enroll: {str(enroll).lower()} }}\n"))
    monkeypatch.setattr(cli, "get_secret", lambda *a: pytest.fail("the vault was asked"))
    monkeypatch.setattr(cli.subprocess, "run", lambda *a, **k: pytest.fail("something ran"))
    with pytest.raises(SystemExit) as e:
        main(["run", "--sudo", "dc-01", "--", "whoami"])
    assert "[159]" in str(e.value) and "sudo" in str(e.value) and "Administrators" in str(e.value)
