"""Ticket 36 (decision Q60) through `roster serve`: a Session to a Host whose host key roster hasn't recorded asks
first. session.prepare refuses with 44 instead of letting ssh trust the key on its own, host.scan_key {host} shows
the key, and host.trust_key records it only if the Host still offers exactly that key. Against the local paramiko
Host from test_changes (stands in for ssh-keyscan's answer): no network."""
# ruff: noqa: F811 (test_changes' fixtures, imported by name, are the tests' arguments)

import shutil
import socket

import paramiko
import pytest
from test_changes import app, box, infra, result, sshd  # noqa: F401 (fixtures)

from roster.cli import main
from roster.sshops import fingerprint, host_block


def known_hosts(isolated):
    return isolated["home"] / ".ssh" / "roster_known_hosts"


@pytest.fixture
def synced(box, capsys):
    """`roster sync` run for the scratch Inventory, so session.prepare finds every Host in this box's ssh config."""
    assert main(["-c", str(box.yml), "sync"]) == 0
    capsys.readouterr()


@pytest.fixture
def unknown(isolated, synced):
    """roster has recorded no host key at all (the Host reached roster.yml by a hand edit or a teammate's Publish)."""
    known_hosts(isolated).write_text("")


STRICT = ["-o", "StrictHostKeyChecking=yes"]


# ---------------------------------------------------------------- session.prepare: never trust a key on its own

def test_a_session_with_a_recorded_key_checks_it_strictly(app, synced):
    key = result(app.call("session.prepare", {"host": "keyed"}))
    assert key["argv"] == [shutil.which("ssh"), *STRICT, "-o", "BatchMode=yes", "keyed"]
    pw = result(app.call("session.prepare", {"host": "esx"}))
    assert pw["argv"] == [shutil.which("ssh"), *STRICT, "-o", "NumberOfPasswordPrompts=1",
                          "-o", "PreferredAuthentications=password,keyboard-interactive", "esx"]


def test_a_session_with_no_recorded_key_asks_first(app, sshd, unknown):
    err = app.call("session.prepare", {"host": "esx"})["error"]
    assert err["code"] == 44
    assert err["message"] == "roster hasn't seen esx's host key before"
    assert err["data"] == {"address": "127.0.0.1", "port": sshd.port,
                           "fix": "compare its fingerprint with the Host's console or owner, then trust it when "
                                  "the app asks, or run `roster setup --host esx`"}
    assert sshd.accepts == 0                     # prepare stays local: the app fetches the key when it asks


def test_the_cli_keeps_its_own_ssh_config(box):
    """`roster ssh`/`run` use the config `roster sync` writes, which still trusts a new Host's first key."""
    from roster.config import load_config
    cfg = load_config(box.yml)
    assert "    StrictHostKeyChecking accept-new" in host_block(cfg, "esx", cfg["hosts"]["esx"])


# ---------------------------------------------------------------- host.scan_key {host}: the key to ask about

def test_scan_key_of_a_host_shows_its_key_and_records_nothing(app, sshd, unknown, isolated):
    r = result(app.call("host.scan_key", {"host": "esx"}))
    assert r == {"host": "esx", "address": "127.0.0.1", "port": sshd.port, "key_type": sshd.key.get_name(),
                 "fingerprint": fingerprint(sshd.key), "recorded": "none"}
    assert known_hosts(isolated).read_text() == "" and sshd.attempts == []


def test_scan_key_of_an_unknown_host(app):
    assert app.call("host.scan_key", {"host": "nope"})["error"]["code"] == 2


# ---------------------------------------------------------------- host.trust_key: record what the user saw

def test_trusting_records_the_key_and_the_session_opens(app, sshd, unknown, isolated):
    fp = result(app.call("host.scan_key", {"host": "esx"}))["fingerprint"]
    r = result(app.call("host.trust_key", {"host": "esx", "fingerprint": fp}))
    assert r == {"host": "esx", "address": "127.0.0.1", "port": sshd.port, "key_type": sshd.key.get_name(),
                 "fingerprint": fp, "recorded": True}
    assert known_hosts(isolated).read_text() == sshd.known_hosts_line()
    assert sshd.attempts == []                   # key exchange only, never a login
    assert result(app.call("session.prepare", {"host": "esx"}))["argv"][1:3] == STRICT


def test_a_key_that_changed_since_the_question_is_refused(app, sshd, unknown, isolated):
    asked = result(app.call("host.scan_key", {"host": "esx"}))["fingerprint"]
    sshd.key = paramiko.ECDSAKey.generate()      # the Host (or something in between) now offers another key
    err = app.call("host.trust_key", {"host": "esx", "fingerprint": asked})["error"]
    assert err["code"] == 23
    assert err["message"] == "esx's host key changed while roster was asking - nothing was recorded"
    assert err["data"]["asked"] == asked and err["data"]["offered"] == fingerprint(sshd.key)
    assert err["data"]["fix"] == ("don't trust it blindly: compare the new fingerprint with the Host's console or "
                                  "owner, then open the Session again to see it")
    assert known_hosts(isolated).read_text() == ""


def test_a_changed_recorded_key_is_refused_never_asked(app, sshd, synced, isolated):
    other = paramiko.ECDSAKey.generate()
    line = f"[127.0.0.1]:{sshd.port} {other.get_name()} {other.get_base64()}\n"
    known_hosts(isolated).write_text(line)
    assert result(app.call("session.prepare", {"host": "esx"}))["argv"][1:3] == STRICT   # ssh refuses it (Q44)
    err = app.call("host.trust_key", {"host": "esx", "fingerprint": fingerprint(sshd.key)})["error"]
    assert err["code"] == 43
    assert known_hosts(isolated).read_text() == line


def test_trusting_a_key_already_recorded_adds_nothing(app, sshd, synced, isolated):
    r = result(app.call("host.trust_key", {"host": "esx", "fingerprint": fingerprint(sshd.key)}))
    assert r["recorded"] is False
    assert known_hosts(isolated).read_text() == sshd.known_hosts_line()


def test_trusting_needs_a_fingerprint(app, unknown):
    assert app.call("host.trust_key", {"host": "esx"})["error"]["code"] == -32602
    assert app.call("host.trust_key", {"host": "esx", "fingerprint": "ab:cd"})["error"]["code"] == -32602
    assert app.call("host.trust_key", {"host": "nope", "fingerprint": "SHA256:x"})["error"]["code"] == 2


def test_a_host_that_doesnt_answer_records_nothing(app, box, unknown, isolated):
    s = socket.create_server(("127.0.0.1", 0))
    closed = s.getsockname()[1]
    s.close()
    box.commit(box.yml.read_text().replace("        port: ", f"        port: {closed}  # was ", 1))
    app.call("inventory.reload")
    assert app.call("host.scan_key", {"host": "esx"})["error"]["code"] == 41
    assert app.call("host.trust_key", {"host": "esx", "fingerprint": "SHA256:x"})["error"]["code"] == 41
    assert known_hosts(isolated).read_text() == ""


def test_a_host_that_never_sends_its_banner_leaves_nothing_on_stderr(capfd):
    # found by the end-to-end suite (a cancelled check of a paused Host): the key exchange gives up, and paramiko's
    # own thread, still reading the closed socket, logged its traceback through logging's last resort onto stderr
    import threading

    from roster.sshops import handshake
    server = socket.create_server(("127.0.0.1", 0))
    sock = socket.create_connection(server.getsockname())
    before = set(threading.enumerate())
    try:
        with pytest.raises(paramiko.SSHException):
            handshake(sock, [], timeout=0.5)
        for t in set(threading.enumerate()) - before:
            t.join(timeout=20)
    finally:
        sock.close()
        server.close()
    assert "Exception (client)" not in capfd.readouterr().err
