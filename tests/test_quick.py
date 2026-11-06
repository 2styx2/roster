"""Ticket 14 (Quick Connect) through `roster serve`: a Session to user@address[:port], a box that isn't in the
Inventory. The app shows the key host.scan_key {address, port} fetched; quick.prepare fetches it again, refuses a
fingerprint the user wasn't shown or a key that differs from one roster recorded, and returns the ssh command. The
confirmed key is trusted for that Session only (a known-hosts file of serve's own), never written to roster's known
hosts, and a typed password goes to ssh through the askpass channel exactly like a vault password. Against the local
paramiko Host from test_changes (and the real ssh, where the test says so): no network."""
# ruff: noqa: F811 (test_changes' fixtures, imported by name, are the tests' arguments)

import json
import os
import shutil
import socket
import subprocess
from pathlib import Path

import paramiko
import pytest
from conftest import REAL_PATH, SECRET
from test_changes import app, box, infra, result, sshd  # noqa: F401 (fixtures)

from roster.sshops import fingerprint

PROMPT = "root@127.0.0.1's password: "


def known_hosts(isolated):
    return isolated["home"] / ".ssh" / "roster_known_hosts"


@pytest.fixture
def unknown(isolated, box):
    """roster has recorded no host key for the box (a box nobody added yet)."""
    known_hosts(isolated).write_text("")


def to(sshd, **extra):
    """quick.prepare's params for the local box, with the fingerprint the user was shown."""
    return {"user": "root", "address": "127.0.0.1", "port": sshd.port, "fingerprint": fingerprint(sshd.key), **extra}


def run_askpass(spec, prompt=PROMPT):
    """SSH_ASKPASS exactly as ssh runs it: the absolute path, the prompt as argv[1], the Session's env."""
    return subprocess.run([spec["env"]["SSH_ASKPASS"], prompt], env={**os.environ, **spec["env"]},
                          capture_output=True, text=True, timeout=30, cwd="/")


def real_ssh():
    """OpenSSH's ssh, not the stand-in in tests/fakes that PATH finds first."""
    path = os.pathsep.join(d for d in REAL_PATH.split(os.pathsep) if not d.rstrip("/\\").endswith("fakes"))
    return shutil.which("ssh", path=path)


def run_ssh(spec, *command):
    """The Session's ssh, as the app starts it (plus a command, so it doesn't wait for a terminal), run by the
    real ssh."""
    return subprocess.run([real_ssh(), *spec["argv"][1:], *command], env={**os.environ, **spec["env"]}, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=30)


needs_ssh = pytest.mark.skipif(real_ssh() is None, reason="needs OpenSSH's ssh")


# ---------------------------------------------------------------- quick.prepare: the key, then the command

def test_it_returns_the_scanned_key_and_a_session_command(app, sshd, unknown, isolated):
    scanned = result(app.call("host.scan_key", {"address": "127.0.0.1", "port": sshd.port}))
    assert scanned["recorded"] == "none"
    r = result(app.call("quick.prepare", to(sshd, password=SECRET)))
    assert (r["host"], r["auth"]) == (f"root@127.0.0.1:{sshd.port}", "password")        # :22 would be left out
    assert (r["user"], r["address"], r["port"]) == ("root", "127.0.0.1", sshd.port)
    assert (r["key_type"], r["fingerprint"]) == (sshd.key.get_name(), scanned["fingerprint"])
    assert isinstance(r["quick"], str) and r["quick"]
    argv = r["argv"]
    assert argv[0] == shutil.which("ssh") and argv[-4:] == ["-l", "root", "--", "127.0.0.1"]
    opts = [argv[i + 1] for i, a in enumerate(argv) if a == "-o"]
    assert "StrictHostKeyChecking=yes" in opts and "NumberOfPasswordPrompts=1" in opts
    assert "PreferredAuthentications=password,keyboard-interactive" in opts
    assert ["-p", str(sshd.port)] == argv[argv.index("-p"):argv.index("-p") + 2]
    assert set(r["env"]) == {"SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "ROSTER_ASKPASS_SOCKET", "ROSTER_ASKPASS_TOKEN"}
    assert known_hosts(isolated).read_text() == ""          # trusted for this Session only
    assert sshd.attempts == []                              # key exchange only, never a login


def test_the_typed_password_goes_to_ssh_once_and_never_into_a_response_or_log(app, sshd, unknown):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET)))
    first = run_askpass(spec)
    assert (first.returncode, first.stdout) == (0, SECRET + "\n")
    again = run_askpass(spec)
    assert (again.returncode, again.stdout) == (1, "") and "[37]" in again.stderr
    _, out, err = app.close()
    assert SECRET not in "".join(app.responses) + out + err
    assert "askpass: root@127.0.0.1:" in err                 # the log names the Session, never the password


def test_a_lock_forgets_the_typed_password(app, sshd, unknown):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET)))
    result(app.call("vault.lock"))
    r = run_askpass(spec)
    assert (r.returncode, r.stdout) == (1, "")


def test_without_a_password_it_logs_in_with_this_boxs_keys(app, sshd, unknown):
    r = result(app.call("quick.prepare", to(sshd)))
    assert (r["auth"], r["env"]) == ("key", {})
    opts = [r["argv"][i + 1] for i, a in enumerate(r["argv"]) if a == "-o"]
    assert "BatchMode=yes" in opts and "StrictHostKeyChecking=yes" in opts


def test_a_box_whose_key_roster_recorded_needs_it_to_match(app, sshd, isolated):
    r = result(app.call("quick.prepare", to(sshd, password=SECRET)))
    assert r["fingerprint"] == fingerprint(sshd.key)
    assert known_hosts(isolated).read_text() == sshd.known_hosts_line()


# ---------------------------------------------------------------- refusals: nothing connects, nothing is kept

def test_a_fingerprint_the_user_wasnt_shown_is_refused(app, sshd, unknown, isolated):
    shown = fingerprint(sshd.key)
    sshd.key = paramiko.ECDSAKey.generate()                 # the box (or something in between) offers another key
    err = app.call("quick.prepare", to(sshd, fingerprint=shown, password=SECRET))["error"]
    assert err["code"] == 23
    assert err["message"] == f"root@127.0.0.1:{sshd.port}'s host key changed while roster was asking - not connecting"
    assert err["data"]["asked"] == shown and err["data"]["offered"] == fingerprint(sshd.key)
    assert err["data"]["fix"] == ("don't trust it blindly: compare the new fingerprint with the box's console or "
                                  "owner, then Quick Connect again to see it")
    assert known_hosts(isolated).read_text() == ""


def test_a_key_that_differs_from_the_recorded_one_is_refused(app, sshd, isolated):
    other = paramiko.ECDSAKey.generate()
    line = f"[127.0.0.1]:{sshd.port} {other.get_name()} {other.get_base64()}\n"
    known_hosts(isolated).write_text(line)
    err = app.call("quick.prepare", to(sshd, password=SECRET))["error"]
    assert err["code"] == 43
    assert err["data"]["recorded"] == [fingerprint(other)] and err["data"]["offered"] == fingerprint(sshd.key)
    assert known_hosts(isolated).read_text() == line


def test_a_box_that_doesnt_answer(app, unknown):
    s = socket.create_server(("127.0.0.1", 0))
    closed = s.getsockname()[1]
    s.close()
    err = app.call("quick.prepare", {"user": "root", "address": "127.0.0.1", "port": closed,
                                     "fingerprint": "SHA256:x", "password": SECRET})["error"]
    assert err["code"] == 41


@pytest.mark.parametrize("params, why", [
    ({"fingerprint": None}, "fingerprint"),
    ({"fingerprint": "ab:cd"}, "fingerprint"),
    ({"user": ""}, "user"),
    ({"user": "-oProxyCommand=x"}, "user"),
    ({"user": "ro ot"}, "user"),
    ({"address": "-oProxyCommand=x"}, "address"),
    ({"address": "10.0.0.1 10.0.0.2"}, "address"),
    ({"address": "root@10.0.0.1"}, "address"),
    ({"port": 0}, "port"),
    ({"port": "22"}, "port"),
    ({"password": 5}, "password"),
    ({"password": ""}, "password"),
])
def test_bad_params(app, sshd, params, why):
    err = app.call("quick.prepare", {**to(sshd), **params})["error"]
    assert err["code"] == -32602 and why in err["message"]
    assert sshd.accepts == 0


# ---------------------------------------------------------------- the real ssh, as the app starts it

@needs_ssh
def test_ssh_logs_in_with_the_typed_password_and_the_confirmed_key(app, sshd, unknown, isolated):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET)))
    r = run_ssh(spec, "true")
    assert ("password", "root") in sshd.attempts, r.stderr
    assert "Host key verification failed" not in r.stderr
    assert known_hosts(isolated).read_text() == ""          # ssh didn't record it either
    assert SECRET not in r.stdout + r.stderr


@needs_ssh
def test_ssh_refuses_a_key_that_changed_after_the_question(app, sshd, unknown):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET)))
    sshd.key = paramiko.ECDSAKey.generate()
    r = run_ssh(spec, "true")
    assert r.returncode == 255 and "Host key verification failed" in r.stderr
    assert sshd.attempts == []


QUICK_VECTORS = json.loads((Path(__file__).parent / "vectors" / "quick-target.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", QUICK_VECTORS["labels"], ids=lambda c: c["label"])
def test_a_quick_connects_label_is_the_apps(case):
    """tests/vectors/quick-target.json, which app/src/quick/target.test.ts reads too: serve names a Quick Connect in
    its messages as the app shows it."""
    from roster import serve as rpc
    assert rpc.quick_label(case["user"], case["address"], case["port"]) == case["label"]


def test_a_quick_connects_user_rule_is_the_apps():
    from roster import serve as rpc
    for user in QUICK_VECTORS["users"]["valid"]:
        assert rpc.QUICK_USER.fullmatch(user), user
    for user in QUICK_VECTORS["users"]["invalid"]:
        assert not rpc.QUICK_USER.fullmatch(user), user
