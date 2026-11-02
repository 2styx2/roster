"""Ticket 26: `host.check {host}` (serve) and `roster check HOST` (CLI) run the diagnostics in order and stop
at the first failure. Nothing touches the network once a local step has failed, and a whole check makes at
most one TCP connection (port + host key) and one login attempt - the 10.19 rate limiter must never see more.

The Host is a local paramiko server that offers a host key and counts connections; the login is the stand-in
ssh (tests/fakes/ssh), which logs each run and asks SSH_ASKPASS for the password as real ssh does."""

import json
import logging
import os
import socket
import threading
import time

import paramiko
import pytest
from conftest import ALL_SECRETS, SECRET
from test_serve import synced

from roster.cli import main

STEPS = ["inventory", "ssh-config", "provider", "vault-item", "dns", "tcp", "host-key", "auth"]
logging.getLogger("paramiko").setLevel(logging.CRITICAL)


class Sshd:
    """An SSH server on 127.0.0.1 that only does key exchange: enough for a client to see its host key."""

    def __init__(self):
        self.key = paramiko.ECDSAKey.generate()
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.accepts = 0
        self.listener.settimeout(0.2)
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        while self.running:
            try:
                conn, _ = self.listener.accept()
            except (TimeoutError, OSError):
                continue
            self.accepts += 1
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        t = paramiko.Transport(conn)
        t.add_server_key(self.key)
        try:
            t.start_server(server=paramiko.ServerInterface())
            t.join(5)
        except Exception:
            pass
        finally:
            t.close()

    def known_hosts_line(self, key=None):
        key = key or self.key
        return f"[127.0.0.1]:{self.port} {key.get_name()} {key.get_base64()}\n"

    def close(self):
        self.running = False
        self.thread.join()          # an accept() still waiting would take one more connection after close()
        self.listener.close()


@pytest.fixture
def sshd():
    s = Sshd()
    yield s
    s.close()


def inventory(port):
    return f"""\
groups:
  lab:
    user: root
    enroll: false
    port: {port}
    hosts:
      esx: {{ip: 127.0.0.1, auth: "bw:esx ssh"}}
      typo: {{ip: 127.0.0.1, auth: "bw:esx shh"}}
      dup: {{ip: 127.0.0.1, auth: "bw:dup ssh"}}
      nopw: {{ip: 127.0.0.1, auth: "bw:nopw ssh"}}
      field: {{ip: 127.0.0.1, auth: "bw:esx ssh#enabel"}}
      keeper: {{ip: 127.0.0.1, auth: "keeper:esx ssh"}}
      noone: {{ip: 127.0.0.1, user: CHANGE-ME, auth: "bw:esx ssh"}}
      nodns: {{ip: no-such-host.invalid, auth: "bw:esx ssh"}}
      keyed: {{ip: 127.0.0.1, enroll: true}}
  found:
    reviewed: false
    user: root
    hosts:
      scanned: {{ip: 127.0.0.1, port: {port}}}
"""


@pytest.fixture
def box(write_config, capsys, vault, sshd, isolated, monkeypatch, tmp_path):
    """roster.yml for the local Host, `roster sync` run, its host key recorded, and the stand-in ssh logging."""
    synced(write_config, capsys, inventory(sshd.port))
    (isolated["home"] / ".ssh" / "roster_known_hosts").write_text(sshd.known_hosts_line())
    log = tmp_path / "ssh.log"
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("FAKE_SSH_PROMPT", "root@127.0.0.1's password: ")
    monkeypatch.setenv("FAKE_SSH_PASSWORD", SECRET)
    box = type("Box", (), {})()
    box.sshd, box.write_config = sshd, write_config

    def ssh_runs():
        return [ln for ln in (log.read_text().splitlines() if log.exists() else []) if ln.startswith("ssh ")]
    box.ssh_runs = ssh_runs
    return box


@pytest.fixture
def check(serve, box):
    """host.check through a real `roster serve`, its vault unlocked as the app would have it."""
    started = []

    def _check(host, unlock=True):
        if not started:
            started.append(serve())
            if unlock:
                assert started[0].call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
        return started[0].call("host.check", {"host": host})
    yield _check
    if started:
        _, out, err = started[0].close()
        leaks = "".join(started[0].responses) + out + err
        assert not [x for x in ALL_SECRETS if x in leaks]


def statuses(result):
    return [(s["step"], s["status"], s.get("code")) for s in result["steps"]]


def test_every_step_passes_for_a_good_password_host(check, box):
    result = check("esx")["result"]
    assert result["host"] == "esx" and result["ok"] is True
    assert statuses(result) == [(step, "ok", None) for step in STEPS]
    assert all(s["message"] for s in result["steps"])
    assert box.sshd.accepts == 1 and len(box.ssh_runs()) == 1          # one TCP + host key, one login
    login = box.ssh_runs()[0]
    assert "StrictHostKeyChecking=yes" in login and "ControlPath=none" in login and "NumberOfPasswordPrompts=1" in login


def test_a_key_host_has_no_vault_steps_and_logs_in_with_batchmode(check, box, monkeypatch):
    monkeypatch.setenv("FAKE_SSH_EXIT", "0")
    monkeypatch.delenv("FAKE_SSH_PROMPT")
    result = check("keyed")["result"]
    assert statuses(result) == [("inventory", "ok", None), ("ssh-config", "ok", None),
                                ("provider", "skipped", None), ("vault-item", "skipped", None),
                                ("dns", "ok", None), ("tcp", "ok", None), ("host-key", "ok", None),
                                ("auth", "ok", None)]
    assert "BatchMode=yes" in box.ssh_runs()[0]


LOCAL_FAILURES = [
    ("typo", "vault-item", 32), ("dup", "vault-item", 33), ("nopw", "vault-item", 34), ("field", "vault-item", 34),
    ("keeper", "provider", 31), ("noone", "inventory", 30), ("scanned", "inventory", 20), ("ghost", "inventory", 2),
]


@pytest.mark.parametrize(("host", "step", "code"), LOCAL_FAILURES)
def test_a_local_failure_stops_the_check_before_any_network(check, box, host, step, code):
    result = check(host)["result"]
    failed = STEPS.index(step)
    assert result["ok"] is False
    assert statuses(result)[failed] == (step, "fail", code)
    assert [s["status"] for s in result["steps"][failed + 1:]] == ["skipped"] * (len(STEPS) - failed - 1)
    assert result["steps"][failed]["message"] and result["steps"][failed]["fix"]
    assert box.sshd.accepts == 0 and box.ssh_runs() == []


def test_a_locked_vault_fails_the_provider_step(check, box):
    result = check("esx", unlock=False)["result"]
    assert statuses(result)[2] == ("provider", "fail", 14)
    assert box.sshd.accepts == 0 and box.ssh_runs() == []


def test_a_host_added_since_the_last_sync(check, box):
    box.write_config(inventory(box.sshd.port).replace("      esx:", "      new: {ip: 127.0.0.1}\n      esx:"))
    result = check("new")["result"]
    assert statuses(result)[1] == ("ssh-config", "fail", 21) and "roster sync" in result["steps"][1]["fix"]
    assert box.sshd.accepts == 0 and box.ssh_runs() == []


def test_an_ssh_config_from_before_identitiesonly_is_out_of_date(check, box, isolated):
    """Row 19: a config that lets the agent offer every key; the fix is `roster sync`, found before connecting."""
    f = isolated["home"] / ".ssh" / "config.d" / "roster"
    f.write_text(f.read_text().replace("    IdentitiesOnly yes\n    PubkeyAuthentication no\n", ""))
    step = check("esx")["result"]["steps"][1]
    assert (step["status"], step["code"]) == ("fail", 21)
    assert "IdentitiesOnly" in step["message"] and "roster sync" in step["fix"]
    assert box.sshd.accepts == 0


def test_a_name_that_doesnt_resolve(check, box):
    result = check("nodns")["result"]
    assert statuses(result)[4] == ("dns", "fail", 40) and "no-such-host.invalid" in result["steps"][4]["message"]
    assert box.sshd.accepts == 0 and box.ssh_runs() == []


def test_a_closed_port(check, box):
    box.sshd.close()
    result = check("esx")["result"]
    assert statuses(result)[5] == ("tcp", "fail", 41)
    assert f"127.0.0.1:{box.sshd.port}" in result["steps"][5]["message"]
    assert box.ssh_runs() == []


def test_a_changed_host_key_is_never_accepted(check, box, isolated):
    other = paramiko.ECDSAKey.generate()
    kh = isolated["home"] / ".ssh" / "roster_known_hosts"
    kh.write_text(box.sshd.known_hosts_line(other))
    result = check("esx")["result"]
    step = result["steps"][6]
    assert (step["step"], step["status"], step["code"]) == ("host-key", "fail", 43)
    assert step["data"]["recorded"] != step["data"]["offered"]
    assert step["data"]["offered"].startswith("SHA256:")
    assert result["steps"][7]["status"] == "skipped" and box.ssh_runs() == []
    assert box.sshd.accepts == 1
    assert kh.read_text() == box.sshd.known_hosts_line(other)            # untouched


def test_no_recorded_host_key(check, box, isolated):
    (isolated["home"] / ".ssh" / "roster_known_hosts").write_text("")
    step = check("esx")["result"]["steps"][6]
    assert (step["status"], step["code"]) == ("fail", 44) and "roster setup --only esx" in step["fix"]


def test_the_host_refuses_the_password(check, box, monkeypatch):
    monkeypatch.setenv("FAKE_SSH_PASSWORD", "rotated-on-the-host")
    step = check("esx")["result"]["steps"][7]
    assert (step["status"], step["code"]) == ("fail", 45)
    assert step["message"] == "esx refused the password for user root"
    assert "Permission denied" in step["details"]
    assert len(box.ssh_runs()) == 1


@pytest.mark.parametrize(("stderr", "code"), [
    ("root@127.0.0.1: Permission denied (publickey).", 46),
    ("Received disconnect from 127.0.0.1 port 22:2: Too many authentication failures", 47),
    ("kex_exchange_identification: read: Connection reset by peer", 48),
])
def test_a_key_login_that_fails(check, box, monkeypatch, stderr, code):
    monkeypatch.setenv("FAKE_SSH_STDERR", stderr)
    monkeypatch.delenv("FAKE_SSH_PROMPT")
    step = check("keyed")["result"]["steps"][7]
    assert (step["status"], step["code"], step["details"]) == ("fail", code, stderr)
    assert len(box.ssh_runs()) == 1


def test_an_unexpected_prompt_during_login(check, box, monkeypatch):
    monkeypatch.setenv("FAKE_SSH_PROMPT", "You are required to change your password immediately. New password: ")
    step = check("esx")["result"]["steps"][7]
    assert (step["status"], step["code"]) == ("fail", 36)
    assert "esx asked something roster won't answer: 'You are required" in step["message"]


def test_host_check_without_an_inventory(serve, write_config):
    write_config("groups: [oops\n")
    result = serve().call("host.check", {"host": "esx"})["result"]
    first = result["steps"][0]
    assert (first["step"], first["status"], first["code"]) == ("inventory", "fail", 1)
    assert first["data"]["line"] == 1
    assert [s["status"] for s in result["steps"][1:]] == ["skipped"] * 7


# ---------------------------------------------------------------- the CLI

def test_roster_check_host_prints_each_step(box, capsys, monkeypatch):
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    assert main(["check", "esx"]) == 0
    out = capsys.readouterr().out
    assert [ln.split()[:2] for ln in out.splitlines()[:8]] == [["ok", step] for step in STEPS]
    assert not [x for x in ALL_SECRETS if x in out]
    assert box.sshd.accepts == 1 and len(box.ssh_runs()) == 1


def test_roster_check_host_shows_the_failure_and_its_fix(box, capsys, monkeypatch):
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    assert main(["check", "dup"]) == 1
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert lines[3].startswith("FAIL vault-item") and "[33]" in lines[3]
    assert "fix:" in out and "2026-10-20" in out
    assert [ln.split()[:2] for ln in lines if ln.startswith("skip")] == [["skip", s] for s in STEPS[4:]]
    assert not [x for x in ALL_SECRETS if x in out]
    assert box.sshd.accepts == 0 and box.ssh_runs() == []


def test_roster_check_host_with_a_broken_inventory(write_config, capsys):
    write_config("groups: [oops\n")
    assert main(["check", "esx"]) == 1
    assert capsys.readouterr().out.startswith("FAIL inventory")


def test_roster_check_without_a_host_is_still_the_fleet_check(box, capsys, monkeypatch):
    monkeypatch.setenv("FAKE_SSH_EXIT", "0")
    main(["check", "--only", "keyed"])
    assert "keyed  ssh:ok" in capsys.readouterr().out


def test_the_result_is_json_safe(check):
    json.dumps(check("esx"))


# ---------------------------------------------------------------- host.check as a job (ticket 108, Q112 (q))

def test_a_background_check_answers_at_once_and_reports_each_step(serve, box):
    s = serve()
    assert s.call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
    started = s.call("host.check", {"host": "esx", "background": True})["result"]
    assert started["kind"] == "check" and started["host"] == "esx" and started["total"] == len(STEPS)
    job = started["job"]
    end = time.monotonic() + 30
    while True:                                             # the job's own answer, polled as the app's core does
        r = s.call("host.check_job", {"job": job})["result"]
        if r["state"] not in ("running", "stopping") or time.monotonic() > end:
            break
        time.sleep(0.05)
    assert r["state"] == "done" and r["done"] == len(STEPS)
    assert r["result"]["ok"] is True and statuses(r["result"]) == [(step, "ok", None) for step in STEPS]
    progress = [n["params"] for n in s.notes if n["method"] == "job.progress" and n["params"]["job"] == job]
    assert progress[0]["state"] == "running" and progress[-1]["state"] == "done"
    assert {p["kind"] for p in progress} == {"check"} and {p["host"] for p in progress} == {"esx"}
    assert all("result" not in p and "steps" not in p for p in progress)    # never the steps' messages
    assert s.call("host.check_job", {"job": "check-99"})["error"]["code"] == 49
    assert box.sshd.accepts == 1 and len(box.ssh_runs()) == 1               # one check, one connection
    _, out, err = s.close()
    assert not [x for x in ALL_SECRETS if x in "".join(s.responses) + out + err]


@pytest.mark.skipif(os.name == "nt", reason="the stand-in ssh is a .cmd shim there: ending it leaves its Python")
def test_locking_mid_login_ends_the_checks_ssh_rather_than_wait_for_it(serve, box, monkeypatch, tmp_path):
    # #198 (b): vault.lock waited behind the auth step's ssh (up to ~35 s) while the lock screen hung
    hung = tmp_path / "ssh.pid"
    monkeypatch.setenv("FAKE_SSH_HANG", str(hung))
    s = serve()
    assert s.call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
    job = s.call("host.check", {"host": "esx", "background": True})["result"]["job"]
    end = time.monotonic() + 15
    while not (hung.exists() and hung.read_text()):
        assert time.monotonic() < end, "the check never got to its login"
        time.sleep(0.02)
    pid = int(hung.read_text())
    t = time.monotonic()
    assert s.call("vault.lock")["result"]
    assert time.monotonic() - t < 5                                 # not the ssh's minute
    r = s.call("host.check_job", {"job": job})["result"]
    while r["state"] in ("running", "stopping"):
        time.sleep(0.02)
        r = s.call("host.check_job", {"job": job})["result"]
    assert r["state"] == "stopped" and r["result"]["ok"] is False
    assert statuses(r["result"])[-1] == ("auth", "skipped", None)
    assert r["result"]["steps"][-1]["message"] == "the check was stopped"
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)                                             # its ssh is gone, not left running
    s.close()


def test_a_login_isnt_started_once_the_check_is_stopped(tmp_path):
    # review of #216, 6: the ssh started even when the stop came before it
    import sys
    import threading

    from roster import diagnose
    halted = threading.Event()
    halted.set()
    ran = tmp_path / "ran"
    with pytest.raises(diagnose.Stopped):
        diagnose.login_attempt([sys.executable, "-c", f"open({str(ran)!r}, 'w')"], dict(os.environ), 30, halted)
    assert not ran.exists()


@pytest.mark.skipif(os.name == "nt", reason="a process group: POSIX")
def test_a_stopped_login_ends_what_its_ssh_started_and_reaps_it(tmp_path):
    # review of #216, 6: a ProxyJump child kept the pipes open, so the killed ssh was never waited for (a zombie)
    # and the child ran on
    import threading

    from roster import diagnose
    child = tmp_path / "child"
    halted = threading.Event()
    argv = ["/bin/sh", "-c", f"sleep 60 & echo $! > {child}; wait"]       # ssh and the ProxyJump it started
    timer = threading.Timer(0.5, halted.set)
    timer.start()
    started = time.monotonic()
    procs = []
    real = diagnose.subprocess.Popen

    def popen(*a, **k):
        procs.append(real(*a, **k))
        return procs[-1]
    try:
        diagnose.subprocess.Popen = popen
        with pytest.raises(diagnose.Stopped):
            diagnose.login_attempt(argv, dict(os.environ), 30, halted)
    finally:
        diagnose.subprocess.Popen = real
        timer.cancel()
    assert time.monotonic() - started < 5
    assert procs[0].returncode is not None                          # reaped
    pid = int(child.read_text())
    end = time.monotonic() + 2
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        assert time.monotonic() < end, "the child outlived the stopped login"
        time.sleep(0.02)


def test_the_waiting_form_answers_as_it_always_did(check):
    result = check("typo")["result"]
    assert result["host"] == "typo" and result["ok"] is False
    assert statuses(result)[3] == ("vault-item", "fail", 32)
