import os
import shutil
import subprocess

import pytest
from conftest import posix_shell

from roster.config import load_config
from roster.sshops import (
    add_key_script,
    box_key_re,
    public_key_line,
    remove_key_script,
    retag_key_script,
    write_ssh_config,
)

PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly roster-managed:ws1"
TAG_RE = " (roster-managed|fleet-managed):ws1$"


def run_remote(script, home):
    """Run the script the way a host would: `sh -c ...` with that account's HOME."""
    r = subprocess.run(["sh", "-c", script], env={**os.environ, "HOME": str(home)}, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout


@posix_shell
def test_add_key_is_idempotent_and_replaces_old_keys(tmp_path):
    ak = tmp_path / ".ssh" / "authorized_keys"
    ak.parent.mkdir()
    ak.write_text("ssh-rsa AAAAother someone@laptop\n"
                  "ssh-ed25519 AAAAold fleet-managed:ws1\n"
                  "ssh-ed25519 AAAAkeep roster-managed:ws10")              # different box; no trailing newline
    for _ in range(2):
        assert "ROSTER_OK" in run_remote(add_key_script(PUB, TAG_RE), tmp_path)
    lines = ak.read_text().splitlines()
    assert lines == ["ssh-rsa AAAAother someone@laptop", "ssh-ed25519 AAAAkeep roster-managed:ws10", PUB]
    assert oct(ak.stat().st_mode & 0o777) == "0o600"


@posix_shell
def test_add_key_creates_ssh_dir(tmp_path):
    run_remote(add_key_script(PUB, TAG_RE), tmp_path)
    assert (tmp_path / ".ssh" / "authorized_keys").read_text() == PUB + "\n"
    assert oct((tmp_path / ".ssh").stat().st_mode & 0o777) == "0o700"


@posix_shell
def test_remove_key_only_touches_this_box(tmp_path):
    run_remote(add_key_script(PUB, TAG_RE), tmp_path)
    ak = tmp_path / ".ssh" / "authorized_keys"
    ak.write_text("ssh-rsa AAAAother someone@laptop\n" + ak.read_text())
    assert "ROSTER_OK" in run_remote(remove_key_script(TAG_RE), tmp_path)
    assert ak.read_text() == "ssh-rsa AAAAother someone@laptop\n"
    assert "ROSTER_OK" in run_remote(remove_key_script(TAG_RE), tmp_path / "nobody-home")   # no file: fine


def test_public_key_line_carries_box_tag(write_config):
    cfg = load_config(write_config("box_name: ws1\nkey_path: ~/k\ngroups: {a: {user: u, hosts: {h: 1.2.3.4}}}\n"))
    cfg["pub"].write_text("ssh-ed25519 AAAAxyz someone@else\n")
    assert public_key_line(cfg) == "ssh-ed25519 AAAAxyz roster-managed:ws1"


def test_ssh_config_written_and_included_once(isolated, write_config):
    main_cfg = isolated["home"] / ".ssh" / "config"
    main_cfg.parent.mkdir()
    main_cfg.write_text("Host personal\n    HostName example.org\n")
    cfg = load_config(write_config(
        "groups:\n"
        "  web: {user: deploy, hosts: {web01: {ip: 10.0.1.15, title: Web box}}}\n"
        "  net: {user: netops, enroll: false, hosts: {sw01: {ip: 10.0.0.2, port: 2222}}}\n"))
    write_ssh_config(cfg)
    write_ssh_config(cfg)
    text = main_cfg.read_text()
    assert text.count("Include") == 1 and text.startswith("Include ")
    assert "Host personal" in text
    generated = (isolated["home"] / ".ssh" / "config.d" / "roster").read_text()
    web, sw = generated.split("Host web01")[1], generated.split("Host sw01")[1].split("Host ")[0]
    assert "# Web box" in generated
    assert "IdentityFile" in web and "IdentityFile" not in sw
    assert "Port 2222" in sw


def test_ssh_config_offers_only_rosters_key_or_none(isolated, write_config):
    """Catalog row 19: an ssh agent full of keys mustn't use up the Host's tries before the password.
    Key Hosts offer only roster's key; password Hosts offer none. `auth: agent` Hosts keep the agent."""
    cfg = load_config(write_config(
        "groups:\n"
        "  g:\n"
        "    user: u\n"
        "    hosts:\n"
        "      key: 10.0.0.1\n"
        "      pw: {ip: 10.0.0.2, enroll: false, auth: 'bw:pw ssh'}\n"
        "      agent: {ip: 10.0.0.3, enroll: false, auth: agent}\n"))
    write_ssh_config(cfg)
    text = (isolated["home"] / ".ssh" / "config.d" / "roster").read_text()
    block = {name: text.split(f"Host {name}\n")[1].split("\n\n")[0] for name in ("key", "pw", "agent")}
    assert "IdentitiesOnly yes" in block["key"] and "IdentityFile" in block["key"]
    assert "IdentitiesOnly yes" in block["pw"] and "IdentityFile" not in block["pw"]
    assert "PubkeyAuthentication no" in block["pw"]
    assert "IdentitiesOnly" not in block["agent"]


@posix_shell
def test_an_interrupted_key_change_never_truncates_authorized_keys(tmp_path):
    """A run cut short (a timeout, a dropped link) while it rewrites authorized_keys must leave it as it was: a stand-in
    cat that dies part way would leave a file rewritten in place empty, locking the Box (and the user) out."""
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    (bin_ / "cat").write_text("#!/bin/sh\nexit 1\n")
    (bin_ / "cat").chmod(0o755)
    ak = tmp_path / ".ssh" / "authorized_keys"
    ak.parent.mkdir()
    before = "ssh-rsa AAAAother someone@laptop\nssh-ed25519 AAAAold roster-managed:ws1\n"
    for script in (add_key_script(PUB, TAG_RE), remove_key_script(TAG_RE)):
        ak.write_text(before)
        subprocess.run(["sh", "-c", script], env={**os.environ, "HOME": str(tmp_path),
                                                  "PATH": f"{bin_}:{os.environ['PATH']}"}, capture_output=True)
        assert ak.read_text().startswith("ssh-rsa AAAAother someone@laptop\n")
        assert not list(ak.parent.glob("*.roster"))


@posix_shell
def test_removing_the_key_keeps_the_files_mode(tmp_path):
    run_remote(add_key_script(PUB, TAG_RE), tmp_path)
    ak = tmp_path / ".ssh" / "authorized_keys"
    ak.chmod(0o640)
    run_remote(remove_key_script(TAG_RE), tmp_path)
    assert ak.stat().st_mode & 0o777 == 0o640


def selinux_tools(tmp_path, ok):
    """Stand-in chcon and restorecon that log their arguments and succeed (OK) or fail."""
    d = tmp_path / "selinux"
    d.mkdir()
    log = tmp_path / "selinux.log"
    for tool in ("chcon", "restorecon"):
        (d / tool).write_text(f'#!/bin/sh\necho "{tool} $*" >> "{log}"\nexit {0 if ok else 1}\n')
        (d / tool).chmod(0o755)
    return d, log


def test_the_key_scripts_relabel_authorized_keys_after_the_move():
    for script in (add_key_script(PUB, TAG_RE), remove_key_script(TAG_RE)):
        mv = script.index('mv -f "$f.roster" "$f"')
        assert script.index("chcon --reference=") < mv < script.index('restorecon -F "$f"')


@posix_shell
@pytest.mark.parametrize("tools", ["none", "failing", "working"])
def test_the_key_scripts_finish_with_or_without_selinux_tools(tmp_path, tools):
    path = os.environ["PATH"]
    log = tmp_path / "selinux.log"
    if tools != "none":
        d, log = selinux_tools(tmp_path, tools == "working")
        path = f"{d}:{path}"
    else:
        path = ":".join(p for p in path.split(":") if not any(os.path.exists(os.path.join(p, t))
                                                              for t in ("chcon", "restorecon")))
        path = f"{tmp_path / 'bin'}:{path}"
        (tmp_path / "bin").mkdir()
        for tool in ("sh", "grep", "cp", "mv", "rm", "mkdir", "touch", "chmod", "readlink", "printf"):
            real = shutil.which(tool)
            if real and not os.path.exists(tmp_path / "bin" / tool):
                os.symlink(real, tmp_path / "bin" / tool)
    home = tmp_path / "host-home"
    home.mkdir()
    for script in (add_key_script(PUB, TAG_RE), remove_key_script(TAG_RE)):
        r = subprocess.run(["sh", "-c", script], env={**os.environ, "HOME": str(home), "PATH": path},
                           capture_output=True, text=True)
        assert r.returncode == 0 and "ROSTER_OK" in r.stdout, r.stderr
    ak = str(home / ".ssh" / "authorized_keys")
    if tools == "working":
        assert f"restorecon -F {ak}" in log.read_text().splitlines()
    assert (home / ".ssh" / "authorized_keys").read_text() == ""


def test_a_quiet_command_on_a_password_host_says_it_timed_out_running(monkeypatch, isolated):
    """paramiko's channel gives up after 120 s with no output: that's the command, not the connection."""
    import paramiko

    from roster import sshops

    class Quiet:
        def read(self):
            raise TimeoutError("timed out")

    class Client:
        def __init__(self, fail_connect=False):
            self.fail_connect = fail_connect

        def load_host_keys(self, path):
            pass

        def set_missing_host_key_policy(self, policy):
            pass

        def connect(self, *a, **k):
            if self.fail_connect:
                raise TimeoutError("timed out")

        def exec_command(self, command, timeout=None):
            return None, Quiet(), Quiet()

        def close(self):
            pass

    h = {"name": "dc-01", "ip": "10.0.0.5", "ssh": {"port": 22, "user": "admin"}}
    monkeypatch.setattr(paramiko, "SSHClient", lambda: Client())
    with pytest.raises(RuntimeError, match="printed nothing for 120 s"):
        sshops.password_exec(h, "x", "pw")
    monkeypatch.setattr(paramiko, "SSHClient", lambda: Client(fail_connect=True))
    with pytest.raises(RuntimeError, match="can't connect"):
        sshops.password_exec(h, "x", "pw")


# T217 (#412): a renamed Box (box_name: changed, or the hostname) finds its own key line under the earlier name by its
# public key, never another Box's line, whatever that one's name.
OLD_NAME_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly roster-managed:old-pi"
OTHER_BOX_SAME_OLD_NAME = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherBox+Key/x= roster-managed:old-pi"


def renamed(tmp_path, *extra):
    cfg = {"tag_re": TAG_RE, "pub": tmp_path / "k.pub"}
    cfg["pub"].write_text(OLD_NAME_LINE + "\n")         # ssh-keygen -C wrote the tag the Box had then
    ak = tmp_path / ".ssh" / "authorized_keys"
    ak.parent.mkdir()
    ak.write_text("\n".join(["ssh-rsa AAAAother someone@laptop", OLD_NAME_LINE, OTHER_BOX_SAME_OLD_NAME,
                             "from=\"10.0.0.2\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly mine",
                             *extra]) + "\n")
    return cfg, ak


@posix_shell
def test_remove_key_takes_this_boxs_line_under_an_earlier_name_by_its_key(tmp_path):
    cfg, ak = renamed(tmp_path)
    assert "ROSTER_OK" in run_remote(remove_key_script(box_key_re(cfg)), tmp_path)
    assert ak.read_text().splitlines() == ["ssh-rsa AAAAother someone@laptop", OTHER_BOX_SAME_OLD_NAME,
                                           "from=\"10.0.0.2\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly mine"]


@posix_shell
def test_add_key_retags_this_boxs_line_under_an_earlier_name(tmp_path):
    cfg, ak = renamed(tmp_path, "ssh-ed25519 AAAAkeep roster-managed:ws10")
    for _ in range(2):
        assert "ROSTER_OK" in run_remote(add_key_script(PUB, box_key_re(cfg)), tmp_path)
    lines = ak.read_text().splitlines()
    assert OLD_NAME_LINE not in lines and lines.count(PUB) == 1 and OTHER_BOX_SAME_OLD_NAME in lines


def test_box_key_re_is_the_tag_alone_without_a_public_key(tmp_path):
    assert box_key_re({"tag_re": TAG_RE, "pub": tmp_path / "none.pub"}) == TAG_RE


# #423's review M1: a Box key line someone hardened with options before it is still this Box's line (it ends in this
# Box's key and a roster tag); the re-tag keeps the options, says when there's no line, and a grep error is a failure.
HARDENED = "from=\"10.0.0.0/8\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly roster-managed:old-pi"
OTHER_BOX_NEW_NAME = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherBox+Key/x= roster-managed:ws1"


@posix_shell
def test_remove_key_takes_this_boxs_line_with_options_before_it_and_names_each_tag(tmp_path):
    cfg, ak = renamed(tmp_path, HARDENED)
    out = run_remote(remove_key_script(box_key_re(cfg)), tmp_path)
    assert HARDENED not in ak.read_text() and OLD_NAME_LINE not in ak.read_text()
    assert "ROSTER_TAG old-pi" in out.splitlines()
    assert "from=\"10.0.0.2\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly mine" in ak.read_text()


@posix_shell
def test_retag_rewrites_only_this_boxs_lines_in_place_keeping_their_options(tmp_path):
    cfg, ak = renamed(tmp_path, HARDENED, OTHER_BOX_NEW_NAME)
    before = ak.read_text().splitlines()
    for _ in range(2):
        assert "ROSTER_OK" in run_remote(retag_key_script(PUB), tmp_path)
    after = ak.read_text().splitlines()
    want = [PUB if x == OLD_NAME_LINE else x.replace("roster-managed:old-pi", "roster-managed:ws1") if x == HARDENED
            else x for x in before]
    assert after == want                                    # in place, options kept; another Box's lines as they were
    assert OTHER_BOX_NEW_NAME in after and OTHER_BOX_SAME_OLD_NAME in after


@posix_shell
def test_retag_says_when_there_is_no_line_and_changes_nothing(tmp_path):
    cfg = {"tag_re": TAG_RE, "pub": tmp_path / "k.pub"}
    cfg["pub"].write_text(OLD_NAME_LINE + "\n")
    out = run_remote(retag_key_script(PUB), tmp_path)        # no file at all
    assert "ROSTER_NONE" in out and not (tmp_path / ".ssh").exists()
    ak = tmp_path / ".ssh" / "authorized_keys"
    ak.parent.mkdir()
    ak.write_text(OTHER_BOX_NEW_NAME + "\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly me@laptop\n")
    before = ak.read_text()
    assert "ROSTER_NONE" in run_remote(retag_key_script(PUB), tmp_path)   # L2: not by the name
    assert ak.read_text() == before


@posix_shell
def test_retag_fails_when_grep_fails(tmp_path):
    cfg = {"tag_re": TAG_RE, "pub": tmp_path / "k.pub"}
    cfg["pub"].write_text(OLD_NAME_LINE + "\n")
    ak = tmp_path / ".ssh" / "authorized_keys"
    ak.parent.mkdir()
    ak.write_text(OLD_NAME_LINE + "\n")
    ak.chmod(0)                                              # unreadable: grep exits 2
    try:
        r = subprocess.run(["sh", "-c", retag_key_script(PUB)],
                           env={**os.environ, "HOME": str(tmp_path)}, capture_output=True, text=True)
    finally:
        ak.chmod(0o600)
    if os.geteuid() == 0:
        pytest.skip("root reads any file")
    assert r.returncode != 0 and "ROSTER_OK" not in r.stdout and "ROSTER_NONE" not in r.stdout
