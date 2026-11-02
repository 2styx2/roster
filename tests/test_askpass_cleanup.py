"""serve's askpass folder (`roster-askpass-PID-*`, which holds the private password socket) goes away on every way
serve can end (ticket 113, #198): closed stdin, closed mid-request, a signal. A serve killed outright (SIGKILL, a
crash of the interpreter) can't clean up, so the next serve removes the folders of this user whose serve is gone,
and never another user's, a live serve's, or anything a link points at."""

import json
import os
import signal
import socket
import subprocess
import sys
import time

import pytest

from roster import askpass

pytestmark = pytest.mark.skipif(os.name == "nt", reason="a named pipe on Windows: no socket folder to leave behind")
INVENTORY = "groups:\n  lab:\n    user: admin\n    hosts:\n      esx-02: 10.0.0.12\n"


def folders(run):
    return sorted(p for p in run.iterdir() if p.name.startswith("roster-askpass-"))


def started(serve, run, *args):
    """A serve whose askpass folder is there (it answers once the channel is open)."""
    s = serve(*args)
    assert "result" in s.call("inventory.info")
    return s


def ended(s, timeout=10):
    s.p.communicate(timeout=timeout)
    return s.p.returncode


def dead_pid():
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def stale(run, pid, files=("socket", "askpass", "logged-in")):
    """A folder as a serve with PID left it: a socket nobody listens on, its helpers."""
    d = run / f"roster-askpass-{pid}-abcd1234"
    d.mkdir(mode=0o700)
    for name in files:
        if name == "socket":
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.bind(str(d / name))
            s.close()                                   # the file stays, with nothing listening
        else:
            (d / name).write_text("#!/bin/sh\n")
    if "socket" in files:
        aged(d / "socket")
    return d


def aged(path, seconds=None):
    """PATH as if made SECONDS ago (a minute past what the sweep waits for a fresh socket)."""
    then = time.time() - (seconds if seconds is not None else askpass.SOCKET_SETTLE + 60)
    os.utime(path, (then, then), follow_symlinks=False)


# ---------------------------------------------------------------- every way serve ends

def test_its_folder_names_the_serve_that_owns_it(runtime_dir):
    d = askpass.runtime_dir()
    try:
        assert d.startswith(str(runtime_dir / f"roster-askpass-{os.getpid()}-"))
        assert len(os.path.join(d, "socket")) < 100
    finally:
        os.rmdir(d)


@pytest.mark.parametrize("sig", ["SIGTERM", "SIGHUP", "SIGINT"])      # names: Windows has no SIGHUP to collect
def test_a_signal_still_removes_the_folder(serve, write_config, runtime_dir, sig):
    write_config(INVENTORY)
    s = started(serve, runtime_dir)
    assert len(folders(runtime_dir)) == 1
    s.p.send_signal(getattr(signal, sig))
    ended(s)
    assert folders(runtime_dir) == []


def test_stdin_closed_mid_request_removes_the_folder(serve, write_config, runtime_dir, vault, monkeypatch):
    write_config(INVENTORY)
    monkeypatch.setenv("FAKE_BW_SLOW", json.dumps({"unlock": 30}))
    s = started(serve, runtime_dir)
    s.request("vault.unlock", {"password": "hunter2"})      # still running when stdin closes
    time.sleep(0.3)
    t = time.monotonic()
    ended(s)
    assert time.monotonic() - t < 5 and folders(runtime_dir) == []


def test_a_killed_serves_folder_goes_when_the_next_serve_starts(serve, write_config, runtime_dir):
    write_config(INVENTORY)
    first = started(serve, runtime_dir)
    [left] = folders(runtime_dir)
    first.p.kill()
    first.p.wait()
    assert left.exists()                                    # SIGKILL: nothing could run
    aged(left / "socket")                                   # it was killed a while ago
    second = started(serve, runtime_dir)
    assert not left.exists() and len(folders(runtime_dir)) == 1
    third = started(serve, runtime_dir)                     # a live serve's folder stays
    assert len(folders(runtime_dir)) == 2
    for s in (second, third):
        assert ended(s) == 0                                # closing stdin
    assert folders(runtime_dir) == []


# ---------------------------------------------------------------- what the sweep may touch

def test_the_sweep_removes_this_users_folders_whose_serve_is_gone(runtime_dir):
    gone = stale(runtime_dir, dead_pid(), files=("socket", "askpass", "logged-in", "quick_known_hosts"))
    live = stale(runtime_dir, os.getpid())
    askpass.sweep(str(runtime_dir))
    assert not gone.exists() and live.exists()


def test_the_sweep_never_follows_a_link(runtime_dir, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep").write_text("mine")
    link = runtime_dir / f"roster-askpass-{dead_pid()}-linkedxx"
    link.symlink_to(outside, target_is_directory=True)      # a folder name that is a link: left alone
    gone = stale(runtime_dir, dead_pid())
    (gone / "quick_known_hosts").symlink_to(outside / "keep")    # a link inside a stale folder: it goes, not its file
    askpass.sweep(str(runtime_dir))
    assert link.is_symlink() and (outside / "keep").read_text() == "mine"
    assert not gone.exists()


def test_the_sweep_leaves_another_users_folders(runtime_dir, monkeypatch):
    theirs = stale(runtime_dir, dead_pid())
    monkeypatch.setattr(os, "getuid", lambda: os.stat(theirs).st_uid + 1)     # as another user sees it
    askpass.sweep(str(runtime_dir))
    assert (theirs / "socket").exists()


def test_the_sweep_leaves_a_folder_with_more_than_serve_puts_there(runtime_dir):
    odd = stale(runtime_dir, dead_pid())
    (odd / "sub").mkdir()
    (odd / "sub" / "file").write_text("x")
    askpass.sweep(str(runtime_dir))
    assert (odd / "sub" / "file").exists()


def test_an_older_serves_folder_goes_only_once_its_socket_is_dead(runtime_dir):
    # before ticket 113 the name had no pid: its socket says whether its serve is alive
    dead = runtime_dir / "roster-askpass-old12345"
    dead.mkdir(mode=0o700)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(str(dead / "socket"))
    s.close()
    aged(dead / "socket")
    alive = runtime_dir / "roster-askpass-old67890"
    alive.mkdir(mode=0o700)
    listening = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listening.bind(str(alive / "socket"))
    listening.listen(1)
    try:
        askpass.sweep(str(runtime_dir))
        assert not dead.exists() and (alive / "socket").exists()
    finally:
        listening.close()


def test_a_pid_from_another_pid_namespace_isnt_taken_for_dead(runtime_dir):
    # /tmp shared with a container: its serve's pid means nothing here, but its socket still answers
    d = runtime_dir / f"roster-askpass-{dead_pid()}-contain1"
    d.mkdir(mode=0o700)
    listening = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listening.bind(str(d / "socket"))
    listening.listen(1)
    try:
        askpass.sweep(str(runtime_dir))
        assert (d / "socket").exists()
    finally:
        listening.close()


# ---------------------------------------------------------------- the review of #216

def test_a_pid_too_big_for_the_os_is_left_and_the_sweep_doesnt_raise(runtime_dir):
    # review 3: os.kill raised OverflowError for it, out of sweep and so out of serve's start
    huge = stale(runtime_dir, "12345678901234567890")
    zero = stale(runtime_dir, 0)
    askpass.sweep(str(runtime_dir))
    assert huge.exists() and zero.exists()


def test_a_folder_with_no_socket_yet_goes_only_once_its_old(runtime_dir):
    # review 4: a serve in another pid namespace, between making its folder and binding its socket, lost its folder
    young = stale(runtime_dir, dead_pid(), files=("askpass", "logged-in"))
    old = stale(runtime_dir, dead_pid(), files=("askpass",))
    long_ago = time.time() - askpass.NO_SOCKET_AGE - 60
    os.utime(old, (long_ago, long_ago))
    askpass.sweep(str(runtime_dir))
    assert young.exists() and not old.exists()


def test_a_socket_just_bound_isnt_taken_for_dead(runtime_dir):
    # between bind() and listen() a socket refuses too: a fresh one is left
    d = stale(runtime_dir, dead_pid())
    os.utime(d / "socket")                                  # just now
    askpass.sweep(str(runtime_dir))
    assert d.exists()


def test_serve_puts_back_the_signal_handlers_it_found(write_config, runtime_dir, monkeypatch):
    # review 7: its handlers (the do-nothing ones above all) stayed installed after serve() returned
    import io

    from roster import serve as rpc
    write_config(INVENTORY)
    mine = lambda *_: None                                  # noqa: E731
    before = {name: signal.signal(getattr(signal, name), mine) for name in ("SIGTERM", "SIGHUP", "SIGINT")}
    try:
        monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(b"")))
        monkeypatch.setattr(sys, "stdout", io.TextIOWrapper(io.BytesIO()))
        assert rpc.serve(None) == 0
        assert all(signal.getsignal(getattr(signal, name)) is mine for name in before)
    finally:
        for name, handler in before.items():
            signal.signal(getattr(signal, name), handler)
    assert folders(runtime_dir) == []


def test_a_channel_that_fails_to_open_leaves_no_folder(runtime_dir, monkeypatch):
    # review 7: a signal (or any failure) after the folder was made but before the channel was open left it
    def fail(*a, **k):
        raise SystemExit(0)                                 # as the SIGTERM handler raises
    monkeypatch.setattr(askpass, "write_helper", fail)
    with pytest.raises(SystemExit):
        askpass.Channel(lambda login: "x")
    assert folders(runtime_dir) == []
