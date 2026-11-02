import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

FAKES = Path(__file__).parent / "fakes"
WINDOWS = os.name == "nt"
REAL_PATH = os.environ.get("PATH", "")       # before any test put the stand-ins first (test_quick's real ssh)
# For tests that run a POSIX shell script on this machine (the remote half of a command, a stand-in written in sh):
# native Windows has no sh to run them with.
posix_shell = pytest.mark.skipif(WINDOWS, reason="runs a POSIX shell script; native Windows has no sh")


def find_posix_sh():
    """A POSIX sh for the stand-in Hosts (tests/fakes/ssh, FAKE_HOSTS): /bin/sh, or on native Windows Git for Windows'
    MSYS sh (Git/usr/bin/sh.exe, which has the awk, sed, mktemp and ssh-keygen a Host's side of `roster mesh` uses
    beside it; not Git/bin/sh.exe, which puts Git's own commands before the PATH it was given). None if there's none."""
    if not WINDOWS:
        return "/bin/sh"
    git = shutil.which("git")
    for sh in ([Path(git).resolve().parent.parent / "usr" / "bin" / "sh.exe"] if git else []) + \
              [Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git" / "usr" / "bin" / "sh.exe"]:
        if sh.is_file():
            return str(sh)
    return None


POSIX_SH = find_posix_sh()
# For the Mesh's stand-in Hosts: they run their side with POSIX_SH, so on Windows they need Git for Windows' sh
stand_in_hosts = pytest.mark.skipif(POSIX_SH is None, reason="the stand-in Hosts need a POSIX sh (Git for Windows')")

EXAMPLES = Path(__file__).parent.parent / "examples"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    """Every test gets its own HOME and working dir, clean provider state, and an untouched environment."""
    from roster import providers

    home = tmp_path / "home"
    home.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    saved_env = dict(os.environ)
    saved_providers = dict(providers.PROVIDERS)
    monkeypatch.setenv("HOME", str(home))
    # Windows finds the home and roster's folders through these, never HOME: a test there must not touch the real ones
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("APPDATA", str(home / "AppData" / "Roaming"))
    monkeypatch.setenv("LOCALAPPDATA", str(home / "AppData" / "Local"))
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    # What a test makes with tempfile, and a program it runs in $TMPDIR (%TEMP% on Windows), such as serve's askpass
    # folder when there's no $XDG_RUNTIME_DIR or a stand-in Host's mktemp, goes into a folder of the test's own, deleted
    # when the test ends (ticket 109). Short, under the real temp dir, so a Unix socket's path still fits in it.
    temp = tempfile.mkdtemp(prefix="roster-test-")
    monkeypatch.setattr(tempfile, "tempdir", temp)
    for var in ("TMPDIR", "TMP", "TEMP"):
        monkeypatch.setenv(var, temp)
    for var in ("BW_SESSION", "BW_PASSWORD", "BW_CLIENTID", "BW_CLIENTSECRET", "OP_SERVICE_ACCOUNT_TOKEN",
                "OP_SESSION_test", "ROSTER_CONFIG", "OLD_OP"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.chdir(work)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False, raising=False)
    monkeypatch.setattr(providers, "MANUAL_UNLOCK", False)         # an in-process serve test sets it
    if WINDOWS:                         # files the tests write read as on Linux: "\n", not CRLF
        write_text = Path.write_text
        monkeypatch.setattr(Path, "write_text", lambda self, data, encoding=None, errors=None, newline="\n":
                            write_text(self, data, encoding=encoding, errors=errors, newline=newline))
    providers._secrets.clear()
    providers.PROVIDER_STATE.clear()
    providers.PROVIDER_SETTINGS.clear()
    providers.BOX_SETTINGS.clear()
    yield {"home": home, "work": work}
    providers.PROVIDERS.clear()
    providers.PROVIDERS.update(saved_providers)
    os.environ.clear()
    os.environ.update(saved_env)
    shutil.rmtree(temp, ignore_errors=True)


@pytest.fixture
def runtime_dir(monkeypatch):
    """$XDG_RUNTIME_DIR as systemd/WSL make it (0700), at a path short enough for a Unix socket in a folder in it
    whatever $TMPDIR is (a socket's path is at most ~107 bytes): straight under /tmp, removed when the test ends."""
    run = Path(tempfile.mkdtemp(prefix="roster-run-", dir=None if WINDOWS else "/tmp"))
    run.chmod(0o700)
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(run))
    yield run
    shutil.rmtree(run, ignore_errors=True)


@pytest.fixture
def fakes(monkeypatch, tmp_path):
    """Put stand-in bw / op / pass / ssh commands first on PATH. Windows runs no script by its #! line, so there each
    one gets a NAME.cmd next to it that runs it with this Python (roster finds a tool by PATHEXT, as it would find
    npm's bw.cmd), and no real ssh stays on PATH."""
    for f in FAKES.iterdir():
        f.chmod(f.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    if not WINDOWS:
        monkeypatch.setenv("PATH", f"{FAKES}{os.pathsep}{os.environ['PATH']}")
        return FAKES
    shims = tmp_path / "fakes"
    shims.mkdir(exist_ok=True)
    for f in FAKES.iterdir():
        (shims / f"{f.name}.cmd").write_text(f'@"{sys.executable}" "{f}" %*\r\n')
    kept = [d for d in os.environ["PATH"].split(os.pathsep) if d and "openssh" not in d.lower()]
    monkeypatch.setenv("PATH", os.pathsep.join([str(shims), *kept]))
    return FAKES


@pytest.fixture
def write_config(isolated):
    def _write(text, name="roster.yml"):
        p = isolated["work"] / name
        p.write_text(text, newline="\n")           # as written on Linux, on Windows too (no CRLF)
        return p
    return _write


# ---------------------------------------------------------------- `roster serve`, as the desktop app drives it

class Serve:
    def __init__(self, *args):
        self.p = subprocess.Popen([sys.executable, "-m", "roster", *args, "serve"], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.next_id = 0
        self.responses = []             # every line serve wrote to stdout, as read
        self.notes = []                 # the notifications (no id) serve sent before a response, in order
        self.answered = {}              # id -> its response, as read
        self.order = []                 # the ids in the order serve answered them

    def send(self, line):
        self.p.stdin.write(line + "\n")
        self.p.stdin.flush()
        while True:
            self.responses.append(self.p.stdout.readline())
            msg = json.loads(self.responses[-1])
            if "id" in msg or "method" not in msg:
                return msg
            self.notes.append(msg)

    def call(self, method, params=None):
        return self.answer(self.request(method, params))

    def request(self, method, params=None):
        """Send a request without waiting for its answer (serve answers concurrently, API 20): its id."""
        self.next_id += 1
        msg = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            msg["params"] = params
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        return self.next_id

    def answer(self, rid):
        """The answer to request RID, reading (and keeping, in self.answered and its order in self.order) whatever
        answers come before it: serve may answer in another order than it was asked."""
        while rid not in self.answered:
            self.responses.append(self.p.stdout.readline())
            if not self.responses[-1]:
                raise EOFError(f"serve closed stdout before answering {rid}")
            msg = json.loads(self.responses[-1])
            if "id" not in msg and "method" in msg:
                self.notes.append(msg)
                continue
            self.answered[msg["id"]] = msg
            self.order.append(msg["id"])
        r = self.answered[rid]
        assert r["jsonrpc"] == "2.0" and r["id"] == rid
        return r

    def close(self):
        """Close stdin; returns (exit code, anything else written to stdout, stderr)."""
        out, err = self.p.communicate(timeout=10)
        return self.p.returncode, out, err


@pytest.fixture
def serve():
    started = []

    def _start(*args):
        started.append(Serve(*args))
        return started[-1]
    yield _start
    for s in started:
        if s.p.poll() is None:
            s.p.kill()
            s.p.wait()


# ---------------------------------------------------------------- a vault edited by hand (ticket 26)

SECRET = "s3cret-esx-pw"                # the one password in this vault; it must never show up in any output

ITEMS = [
    {"id": "aaaa-1111", "name": "esx ssh", "revisionDate": "2026-10-01T10:00:00.000Z",
     "login": {"username": "root", "password": SECRET, "uris": [{"uri": "ssh://10.0.0.6"}]},
     "fields": [{"name": "enable", "value": "s3cret-enable"}]},
    {"id": "bbbb-2222", "name": "dup ssh", "revisionDate": "2026-09-01T08:00:00.000Z",
     "login": {"password": "s3cret-dup-1", "uris": [{"uri": "ssh://10.0.0.7"}]}},
    {"id": "bbbb-3333", "name": "dup ssh", "revisionDate": "2026-10-20T09:30:00.000Z",
     "login": {"password": "s3cret-dup-2", "uris": [{"uri": "https://10.0.0.7"}]}},
    {"id": "cccc-4444", "name": "nopw ssh", "revisionDate": "2026-08-01T00:00:00.000Z", "login": {"username": "x"}},
]
ALL_SECRETS = [SECRET, "s3cret-enable", "s3cret-dup-1", "s3cret-dup-2"]


@pytest.fixture
def vault(fakes, isolated, monkeypatch):
    """The fake bw serves ITEMS (the test may rewrite the file between calls)."""
    f = isolated["home"].parent / "items.json"
    f.write_text(json.dumps(ITEMS))
    monkeypatch.setenv("FAKE_BW_ITEMS", str(f))
    return f
