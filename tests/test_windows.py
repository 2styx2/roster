"""roster natively on Windows (ticket 19): finding tools by PATHEXT and refusing a batch file an argument cmd.exe would
act on, paths, the ssh config Windows' OpenSSH reads, and the askpass channel as a named pipe only this user can open.
The first tests pretend to be on Windows (they run everywhere); the rest need Windows itself."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import WINDOWS
from test_serve import INVENTORY, PASSWORD, run_askpass, unlocked_serve

from roster import common, sshops

windows_only = pytest.mark.skipif(not WINDOWS, reason="needs Windows itself")


@pytest.fixture
def as_windows(monkeypatch):
    monkeypatch.setattr(common, "WINDOWS", True)
    monkeypatch.setattr(sshops, "WINDOWS", True)


def test_a_tool_is_found_by_its_extension_and_an_exe_takes_any_argument(as_windows, monkeypatch):
    monkeypatch.setattr(common.shutil, "which", lambda name: rf"C:\tools\{name}.exe")
    assert common.program_argv(["git", "commit", "-m", 'say "hi" & 100%']) == \
        [r"C:\tools\git.exe", "commit", "-m", 'say "hi" & 100%']


def test_the_console_sign_in_stops_reading_once_bw_has_exited_even_if_the_console_never_closes():
    """Ticket 63 review: after bw exits, what the pseudoconsole still shows is read for a bounded time, then roster
    moves on, never spinning on a console whose output doesn't end."""
    import threading

    from roster.providers.bw_login import ConsolePty

    class StuckConsole:                         # bw exited, but the console's output never reaches its end
        reads = 0

        def exitcode(self):
            return 0

        def finish(self, timeout=3):
            pass

        def read(self, timeout):
            StuckConsole.reads += 1
            return "" if StuckConsole.reads > 1 else "You are logged in!\r\n"

    term = ConsolePty.__new__(ConsolePty)
    term.con, term.text, term.out, term.answered, term.code = StuckConsole(), "", b"", set(), None
    got = []
    t = threading.Thread(target=lambda: got.append(term.ended()), daemon=True)
    t.start()
    t.join(5)
    assert got == [0] and "logged in" in term.text and StuckConsole.reads < 100


@pytest.mark.parametrize("arg", ['a"b', "50%", "a^b", "a&b", "a|b", "a<b", "a>b", "a!b", "a\nb"])
def test_a_batch_file_is_never_handed_what_cmd_would_act_on(as_windows, monkeypatch, arg):
    """npm installs bw as bw.cmd, which runs through cmd.exe: an item name from roster.yml or the vault with one of
    these could run something else, so roster refuses it and says why."""
    monkeypatch.setattr(common.shutil, "which", lambda name: rf"C:\npm\{name}.cmd")
    assert common.program_argv(["bw", "get", "item", "esx ssh"]) == [r"C:\npm\bw.cmd", "get", "item", "esx ssh"]
    with pytest.raises(ValueError, match="batch file"):
        common.program_argv(["bw", "get", "item", arg])


def test_a_batch_file_refusal_is_a_provider_error_not_a_crash(as_windows, monkeypatch):
    from roster import providers
    monkeypatch.setattr(common.shutil, "which", lambda name: rf"C:\npm\{name}.cmd")
    with pytest.raises(providers.SecretError, match="batch file"):
        providers.Ctx("bw", "g").run(["bw", "get", "item", "a & b"])


def test_roster_keeps_its_files_in_appdata_on_windows(as_windows, isolated):
    assert common.user_config_dir() == isolated["home"] / "AppData" / "Roaming" / "roster"


def test_the_ssh_config_on_windows_has_forward_slashes_and_no_shared_connections(as_windows, isolated, write_config):
    from roster.config import load_config
    cfg = load_config(write_config(INVENTORY))
    block = "\n".join(sshops.host_block(cfg, "esx", cfg["hosts"]["esx"]))
    assert "Control" not in block                     # Windows' OpenSSH has no Unix sockets to share one on
    assert f'UserKnownHostsFile "{common.known_hosts_file().as_posix()}"' in block
    assert "\\" not in block


# ---------------------------------------------------------------- on Windows itself

@windows_only
def test_the_askpass_pipe_is_the_users_alone_and_goes_away(serve, write_config, capsys, fakes):
    from roster import winpipe
    s = unlocked_serve(serve, write_config, capsys)
    spec = s.call("session.prepare", {"host": "esx"})["result"]
    pipe, helper = spec["env"]["ROSTER_ASKPASS_SOCKET"], spec["env"]["SSH_ASKPASS"]
    assert pipe.startswith("\\\\.\\pipe\\roster-askpass-") and len(pipe) > len("\\\\.\\pipe\\roster-askpass-") + 30
    assert Path(helper).name == "roster-askpass.exe" and Path(helper).is_file()
    # Nobody can take the name over: a second server for it is refused (first-instance flag, the user-only DACL).
    with pytest.raises(OSError):
        winpipe.Server(pipe)
    assert run_askpass(spec).stdout == PASSWORD + "\n"
    assert s.close()[0] == 0
    with pytest.raises(OSError):
        winpipe.connect(pipe, timeout=0.2).close()


@windows_only
def test_serve_checks_the_pipe_clients_process_is_this_users():
    # T63 (#110) item 3: the client's process token, on top of the DACL
    import threading

    from roster import askpass, winpipe
    name = f"\\\\.\\pipe\\roster-test-client-{os.getpid()}"
    server = winpipe.Server(name)
    seen = []

    def answer():
        with server.accept() as conn:
            seen.append((winpipe.client_sid(conn), askpass.same_user(conn)))
            conn.sendall(b"ok\n")

    t = threading.Thread(target=answer)
    t.start()
    askpass.exchange(name, "hello", 5)
    t.join(5)
    server.close()
    assert seen == [(winpipe.user_sid(), True)]


@windows_only
def test_a_pipe_client_that_cant_be_identified_is_refused(monkeypatch):
    from roster import askpass, winpipe
    monkeypatch.setattr(winpipe, "GetNamedPipeClientProcessId", lambda handle, pid: 0)
    assert askpass.same_user(winpipe.Conn(None)) is False
    monkeypatch.setattr(winpipe, "client_sid", lambda conn: "S-1-5-21-1-2-3-1001")      # another user
    assert askpass.same_user(winpipe.Conn(None)) is False


@windows_only
def test_serves_own_sid_is_read_once(monkeypatch):
    # review of #216, 9: each askpass connection read serve's own token again
    from roster import winpipe
    calls = []
    real = winpipe.process_sid
    monkeypatch.setattr(winpipe, "process_sid", lambda process: calls.append(process) or real(process))
    winpipe.user_sid.cache_clear()
    assert winpipe.user_sid() == winpipe.user_sid() == winpipe.user_sid()
    assert len(calls) == 1


@windows_only
def test_the_pipes_security_names_this_user_and_nobody_else():
    from roster import winpipe
    sid = winpipe.user_sid()
    assert sid.startswith("S-1-5-")
    assert winpipe.only_user_sddl(sid) == f"O:{sid}D:P(A;;GA;;;{sid})"     # protected: nothing inherited


@windows_only
def test_the_pipe_answers_one_exchange_and_times_out_a_silent_client():
    import threading

    from roster import askpass, winpipe
    name = f"\\\\.\\pipe\\roster-test-{os.getpid()}"
    server = winpipe.Server(name)
    seen = []

    def answer():
        with server.accept() as conn:
            conn.settimeout(5)
            seen.append(conn.recv(100))
            conn.sendall(b"ok\nsecret")
        with server.accept() as conn:
            conn.settimeout(0.3)
            try:
                conn.recv(100)
            except TimeoutError:
                seen.append("timed out")

    t = threading.Thread(target=answer)
    t.start()
    assert askpass.exchange(name, "token", 5) == b"ok\nsecret"
    silent = winpipe.connect(name, timeout=5)
    t.join(5)
    silent.close()
    server.close()
    assert seen == [b"token\n", "timed out"]


@windows_only
def test_roster_run_hands_over_to_ssh_and_passes_on_its_code(write_config, fakes, monkeypatch):
    write_config("groups:\n  lab:\n    user: ops\n    hosts:\n      box: {ip: 10.0.0.5, enroll: true}\n")
    monkeypatch.setenv("FAKE_SSH_EXIT", "7")
    r = subprocess.run([sys.executable, "-m", "roster", "run", "box", "--", "true"], capture_output=True, text=True,
                       env=os.environ, timeout=60)
    assert r.returncode == 7 and "not connecting to" in r.stderr


# ---------------------------------------------------------------- what a remote sh reads from a Windows Box

def sent_on_windows(kw):
    """The bytes a child reads on stdin from subprocess.run(**KW) (or Popen's communicate) on Windows, where text mode turns "\n" into "\r\n"
    (a remote sh then sees CRLF: a heredoc's end marker never matches, sudo's password ends in "\r")."""
    data = kw.get("input")
    if isinstance(data, str):
        return data.replace("\n", "\r\n").encode()
    return data


def fake_run_answering(seen, stdout):
    def run(argv, **kw):
        seen.update(argv=argv, **kw)
        text = kw.get("text") or kw.get("universal_newlines")
        return subprocess.CompletedProcess(argv, 0, stdout if text else stdout.encode(), "" if text else b"")
    return run


def fake_popen_answering(seen, stdout):
    """A stand-in subprocess.Popen whose communicate() answers STDOUT (as text, or bytes, as it was opened)."""
    class Popen:
        returncode = 0

        def __init__(self, argv, **kw):
            seen.update(argv=argv, **kw)
            self.text = kw.get("text") or kw.get("universal_newlines")

        def communicate(self, input=None, timeout=None):
            seen["input"] = input
            return (stdout, "") if self.text else (stdout.encode(), b"")

        def kill(self):
            pass
    return Popen


def test_the_meshs_script_reaches_the_remote_sh_with_unix_newlines(as_windows, monkeypatch):
    from roster import mesh
    seen = {}
    monkeypatch.setattr(mesh.subprocess, "Popen", fake_popen_answering(seen, "SAME include\nROSTER_DONE\n"))
    h = {"name": "esx-02", "ip": "10.0.0.12", "ssh": {"user": "root", "port": 22}, "enroll": True}
    lines, err = mesh.on_host(h, mesh.write_script(h, "apply", None, [], set()))
    assert err is None and lines == ["SAME include", "ROSTER_DONE"]
    sent = sent_on_windows(seen)
    assert b"ROSTER_MESH_EOF\n" in sent and b"\r" not in sent


def test_sudos_password_reaches_the_remote_sh_without_a_carriage_return(as_windows, monkeypatch, write_config):
    from test_cli import SUDO_CFG

    from roster import cli
    write_config(SUDO_CFG)
    monkeypatch.setenv("ROSTER_TEST_PW", "s3cret")
    seen = {}
    monkeypatch.setattr(cli.subprocess, "run", fake_run_answering(seen, "root\n"))
    assert cli.main(["run", "--sudo", "key-host", "--", "whoami"]) == 0
    assert sent_on_windows(seen) == b"s3cret\n"


# ---------------------------------------------------------------- the pipe's timeouts (winpipe.Conn), anywhere

@pytest.fixture
def winpipe_anywhere(monkeypatch):
    """roster.winpipe with stand-in Win32 calls that log what they're given, so its timeout logic runs anywhere."""
    import ctypes
    import importlib
    import threading

    class Dll:
        def __getattr__(self, name):
            return type("Fn", (), {"__call__": lambda self, *a: 0})()
    if not WINDOWS:
        monkeypatch.setattr(ctypes, "WinDLL", lambda *a, **kw: Dll(), raising=False)
    import roster.winpipe as winpipe
    winpipe = importlib.reload(winpipe) if not WINDOWS else winpipe
    log = []
    monkeypatch.setattr(winpipe, "GetCurrentThreadId", lambda: 1)
    monkeypatch.setattr(winpipe, "OpenThread", lambda *a: 7)
    monkeypatch.setattr(winpipe, "CancelSynchronousIo", lambda h: log.append(("cancel", h)) or True)
    monkeypatch.setattr(winpipe, "CloseHandle", lambda h: log.append(("close", h)) or True)

    class Timer:
        """Fires when the test says: at start() (the call took too long) or as cancel() is called (the race)."""
        when = "cancel"

        def __init__(self, seconds, fn):
            self.fn = fn

        def start(self):
            if Timer.when == "start":
                self.fn()

        def cancel(self):
            if Timer.when == "cancel":
                self.fn()

        def join(self):
            pass
    monkeypatch.setattr(threading, "Timer", Timer)
    yield winpipe, log, Timer
    if not WINDOWS:
        sys.modules.pop("roster.winpipe", None)


def test_a_pipe_timeout_that_fires_as_the_call_returns_cancels_nothing(winpipe_anywhere):
    """The timer can fire after the read returned but before it's cancelled: CancelSynchronousIo would then hit this
    thread's next I/O, or a closed (perhaps reused) thread handle. It must only ever cancel the call in flight."""
    winpipe, log, _ = winpipe_anywhere
    conn = winpipe.Conn(5)
    conn.settimeout(1)
    assert conn._limited(lambda: b"answer") == b"answer"
    assert log == [("close", 7)]


def test_a_pipe_call_that_blocks_past_its_timeout_is_cancelled_and_times_out(winpipe_anywhere):
    winpipe, log, timer = winpipe_anywhere
    timer.when = "start"
    conn = winpipe.Conn(5)
    conn.settimeout(1)

    def blocked_read():
        e = OSError("cancelled")
        e.winerror = winpipe.ERROR_OPERATION_ABORTED
        raise e
    with pytest.raises(TimeoutError):
        conn._limited(blocked_read)
    assert log == [("cancel", 7), ("close", 7)]


@windows_only
def test_bws_sso_listener_is_seen_without_touching_its_port_and_without_ipv6(monkeypatch):
    """Ticket 63 review: roster sees bw's SSO callback server listen by asking Windows' TCP table which process
    listens on 8065-8070 (one in bw's job), never by binding the port itself, which could take it from bw; and a box
    without IPv6 is just that, not every port taken."""
    from roster import conpty
    table = conpty._listen_table
    monkeypatch.setattr(conpty, "_listen_table", lambda family: None if family == conpty.AF_INET6 else table(family))
    import socket
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    con = conpty.ConPty([sys.executable, "-c", f"import socket,time; s=socket.socket(); s.bind(('127.0.0.1', {port})); "
                         "s.listen(); print('up', flush=True); time.sleep(30)"], dict(os.environ))
    try:
        outsider = socket.socket()                                      # this process isn't in bw's job
        outsider.bind(("127.0.0.1", 0))
        outsider.listen()
        other = outsider.getsockname()[1]
        seen = set()
        for _ in range(100):
            seen = con.listening({port, other})
            if seen:
                break
            con.read(0.1)
        assert seen == {port}
        outsider.close()
    finally:
        con.close()
