import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import pytest

FAKES = Path(__file__).parent / "fakes"
WINDOWS = os.name == "nt"
REAL_PATH = os.environ.get("PATH", "")       # before any test put the stand-ins first (test_quick's real ssh)
# For tests that run a POSIX shell script on this machine (the remote half of a command, a stand-in written in sh):
# native Windows has no sh to run them with.
posix_shell = pytest.mark.skipif(WINDOWS, reason="runs a POSIX shell script; native Windows has no sh")


SHARD_DURATIONS = Path(__file__).parent / "durations-windows.json"
# What a test costs on the Windows runner beyond its recorded setup, call and teardown, fitted to shard wall times
# (T233, PR #455): a shard of 1,376 quick tests took 693 s against 409 s for 369 slow ones of more test time.
SHARD_PER_TEST = 1.0


def pytest_addoption(parser):
    parser.addoption("--shard", metavar="K/N", default=None,
                     help="run the Kth of N shards, balanced by recorded time (CI's Windows jobs, decision Q196)")
    parser.addoption("--shard-durations", metavar="PATH", default=str(SHARD_DURATIONS),
                     help="the seconds each test took, which --shard balances (default: tests/durations-windows.json)")
    parser.addoption("--store-durations", metavar="PATH", default=None,
                     help="write the seconds each test took (setup, call and teardown) to PATH as JSON")


def pytest_collection_modifyitems(config, items):
    """--shard K/N splits the tests so each shard's recorded time (--shard-durations, refreshed from the nightly run)
    comes out about the same: the longest first, each to the shard with the least so far, each test counting its
    time plus SHARD_PER_TEST. A test the file doesn't know counts as its average, so a new one needs no entry. A
    shard keeps collection order: longest first ran slower on the Windows runner (T233). The same in every xdist
    worker: it depends only on the collected tests and the file."""
    shard = config.getoption("--shard")
    if not shard:
        return
    k, n = (int(x) for x in shard.split("/"))
    if not 1 <= k <= n:
        raise pytest.UsageError(f"--shard {shard}: K must be 1 to N")
    try:
        recorded = json.loads(Path(config.getoption("--shard-durations")).read_text(encoding="utf-8"))
    except FileNotFoundError:
        recorded = {}
    known = [recorded[i.nodeid] for i in items if i.nodeid in recorded]
    average = sum(known) / len(known) if known else 1.0
    longest_first = sorted(items, key=lambda i: (-recorded.get(i.nodeid, average), i.nodeid))
    loads = [0.0] * n
    home: dict[str, int] = {}
    for item in longest_first:
        j = loads.index(min(loads))
        loads[j] += recorded.get(item.nodeid, average) + SHARD_PER_TEST
        home[item.nodeid] = j
    config.hook.pytest_deselected(items=[i for i in items if home[i.nodeid] != k - 1])
    items[:] = [i for i in items if home[i.nodeid] == k - 1]


_durations: dict[str, float] = {}


def pytest_runtest_logreport(report):
    _durations[report.nodeid] = _durations.get(report.nodeid, 0.0) + report.duration


def pytest_sessionfinish(session):
    """--store-durations: in the controller only (an xdist worker's reports reach it too)."""
    path = session.config.getoption("--store-durations")
    if path and not hasattr(session.config, "workerinput"):
        times = {nodeid: round(t, 2) for nodeid, t in sorted(_durations.items())}
        Path(path).write_text(json.dumps(times, indent=0) + "\n", encoding="utf-8")


def source_copy(tmp_path):
    """The files install.sh, update.sh and uninstall.sh read, in a folder of their own that isn't a git clone: they
    must never run git (a fetch, a pull) on the checkout running the tests."""
    src = tmp_path / "src-copy"
    (src / "src/roster").mkdir(parents=True, exist_ok=True)
    root = Path(__file__).parent.parent
    for f in ("install.sh", "update.sh", "uninstall.sh", "install-lib.sh", "pyproject.toml", "src/roster/roster.1"):
        (src / f).write_bytes((root / f).read_bytes())
    return src


def no_roster_path():
    """PATH without a directory holding a roster: on a box that has one, install.sh would run update.sh instead."""
    return os.pathsep.join(d for d in os.environ["PATH"].split(os.pathsep) if d and not (Path(d) / "roster").exists())


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
    providers.reset()                   # each test is a new run: no secret, session or mode of the last one's
    from roster import context
    context.use(None)                   # the Inventory a run picked
    if WINDOWS:                         # files the tests write read as on Linux: "\n", not CRLF
        write_text = Path.write_text
        monkeypatch.setattr(Path, "write_text", lambda self, data, encoding=None, errors=None, newline="\n":
                            write_text(self, data, encoding=encoding, errors=errors, newline=newline))
    yield {"home": home, "work": work}
    providers.reset()
    providers.PROVIDERS.clear()
    providers.PROVIDERS.update(saved_providers)
    os.environ.clear()
    os.environ.update(saved_env)
    shutil.rmtree(temp, ignore_errors=True)


VAULT_CLIS = ("bw", "op", "keepassxc-cli")
REAL_CLIS = (*VAULT_CLIS, "hc")       # hc: herdr-core, whose real core holds the developer's live terminals


@pytest.fixture(autouse=True)
def no_real_vault_cli(request, tmp_path, monkeypatch):
    """A test never runs the developer's real bw, op, keepassxc-cli or hc (T247: a flaky test was running the real 140 MB
    bw twice). Each name, first on PATH, is a tripwire that runs nothing: it says which test ran it, on stderr, and
    the test fails when it ends, even when it swallowed the tool's failure. The `fakes` fixture puts the stand-ins
    before it; a test's own stand-ins (or a PATH of its own) go before it too. Windows finds a tool by PATHEXT, so
    there each one also gets a NAME.cmd (an extensionless one is for Git for Windows' sh)."""
    guard = tmp_path / "no-real-vault-cli"
    guard.mkdir()
    ran = guard / "ran"
    for tool in REAL_CLIS:
        why = f"{request.node.nodeid} ran a real {tool} from PATH: use the stand-in in tests/fakes (the `fakes` fixture)"
        script = guard / tool
        script.write_text(f'#!/bin/sh\nprintf "%s\\n" {shlex.quote(why)} >&2\n'
                          f'printf "%s\\n" "{tool} $*" >> {shlex.quote(str(ran))}\nexit 1\n')
        script.chmod(0o755)
        if WINDOWS:
            plain = "".join("?" if c in '&|<>^%"' else c for c in why)
            (guard / f"{tool}.cmd").write_text(f'@echo {plain} 1>&2\r\n@echo {tool} %*>>"{ran}"\r\n@exit /b 1\r\n',
                                               newline="")
    monkeypatch.setenv("PATH", f"{guard}{os.pathsep}{os.environ.get('PATH', '')}")
    yield
    if ran.exists():
        calls = ran.read_text(errors="replace").split("\n")
        pytest.fail("\n".join(f"{request.node.nodeid} ran a real {c.split(' ')[0]} from PATH ({c.strip()}): use the "
                              "stand-in in tests/fakes (the `fakes` fixture)" for c in calls if c.strip()), pytrace=False)


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


class FakeHc:
    """The stand-in hc's state folder (tests/fakes/hc, FAKE_HC_STATE): the Hub's core, its machines and their
    terminals, as a test sets them up. A terminal is the record `hc get` prints, in a file of its own."""

    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def name(self, name: str) -> None:
        """The Hub's core's name (`hc server status`)."""
        (self.root / "name").write_text(name)

    def down(self) -> None:
        """The core doesn't answer: every hc command fails."""
        (self.root / "down").write_text("")

    def machine(self, name: str, state: str = "connected") -> Path:
        """A machine added on the Hub (`hc machine add`), in STATE: connected, connecting or unavailable."""
        d = self.root / "machines" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "state").write_text(state)
        return d

    def terminal(self, address: str, *, app: str | None = None, status: str | None = None, cwd: str = "/home/ops",
                 labels: dict[str, str] | None = None, parent: str | None = None, created_ms: int = 1_700_000_000_000,
                 argv: list[str] | None = None, state: str = "live", name: str | None = None) -> None:
        """A terminal at ADDRESS: tN on the Hub, M/tN on machine M (added, connected, if it isn't yet). APP and
        STATUS: the agent status it reports to herdr (OSC 7501), or none (status=None)."""
        machine, _, t = address.rpartition("/")
        if machine and not (self.root / "machines" / machine).is_dir():
            self.machine(machine)
        folder = self.root / "machines" / machine if machine else self.root
        (folder / "terminals").mkdir(parents=True, exist_ok=True)
        record = {"argv": argv or [app or "bash"], "cwd": cwd, "labels": labels or {}, "name": name,
                  "parent": parent, "status": {"app": app, "state": status} if status else None,
                  "reported": bool(status), "turn": 0, "created_ms": created_ms, "finished_ms": None,
                  "exit_code": None, "state": state, "title": ""}
        (folder / "terminals" / f"{t}.json").write_text(json.dumps(record))

    def doc(self, name: str, machine: str | None = None) -> dict[str, Any] | None:
        """The shared document NAME on the Hub's core, or on MACHINE's: {value, version}, None if never written."""
        f = (self.root / "machines" / machine if machine else self.root) / "docs" / f"{name}.json"
        return json.loads(f.read_text()) if f.exists() else None

    def set_doc(self, name: str, value: Any, version: int = 1, machine: str | None = None) -> None:
        """Shared document NAME as a core holds it, at VERSION: on the Hub's core, or on MACHINE's."""
        if machine and not (self.root / "machines" / machine).is_dir():
            self.machine(machine)
        d = (self.root / "machines" / machine if machine else self.root) / "docs"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{name}.json").write_text(json.dumps({"value": value, "version": version}))

    def machine_down(self, name: str) -> None:
        """MACHINE's core stops answering the Hub (listed connected, but a call `on` it fails)."""
        d = self.root / "machines" / name
        if not d.is_dir():
            self.machine(name)
        (d / "down").write_text("")

    def rpc(self) -> list[dict[str, Any]]:
        """Each JSON-RPC request `hc connect` read so far."""
        f = self.root / "rpc"
        return [json.loads(line) for line in f.read_text().splitlines()] if f.exists() else []

    def calls(self) -> list[str]:
        """Each hc run so far, as `hc ARGS`."""
        f = self.root / "calls"
        return f.read_text().splitlines() if f.exists() else []

    # ---- send, read, wait and label (#555): a terminal's own files beside its record

    def _beside(self, address: str, suffix: str) -> Path:
        machine, _, t = address.rpartition("/")
        return (self.root / "machines" / machine if machine else self.root) / "terminals" / f"{t}{suffix}"

    def screen(self, address: str, text: str) -> None:
        """What `hc read ADDRESS` prints."""
        self._beside(address, ".screen").write_text(text)

    def sent(self, address: str) -> list[str]:
        """Each text `hc send` typed into ADDRESS so far."""
        f = self._beside(address, ".sent")
        return f.read_text().splitlines() if f.exists() else []

    def waits(self, address: str, result: dict) -> None:
        """The WaitResult `hc wait ADDRESS` prints (default: it stopped, with its status)."""
        self._beside(address, ".wait").write_text(json.dumps(result))

    def labels(self, address: str) -> dict[str, str]:
        """ADDRESS's herdr labels now."""
        return json.loads(self._beside(address, ".json").read_text())["labels"]

    # ---- a core that dialed in (#556): the Hub, as a remote machine's core sees it

    def peer(self, name: str, *, calls_me: str = "this machine", down: bool = False) -> None:
        """NAME dialed in to this core (the Hub, after `hc machine add` there), calling this machine CALLS_ME; DOWN:
        it isn't connected now."""
        d = self.root / "peers" / name
        (d / "terminals").mkdir(parents=True, exist_ok=True)
        (d / "calls_me").write_text(calls_me)
        if down:
            (d / "down").write_text("")

    def peer_terminal(self, peer: str, terminal: str, *, app: str = "claude-code", status: str = "idle") -> None:
        """PEER's terminal that started work on this machine: the only kind herdr's call-back reaches."""
        record = {"argv": [app], "cwd": "/home/ops", "labels": {}, "name": None, "parent": None,
                  "status": {"app": app, "state": status}, "reported": True, "turn": 0,
                  "created_ms": 1_700_000_000_000, "finished_ms": None, "exit_code": None, "state": "live", "title": ""}
        (self.root / "peers" / peer / "terminals" / f"{terminal}.json").write_text(json.dumps(record))

    def peer_sent(self, peer: str, terminal: str) -> list[str]:
        """Each text `hc send PEER/TERMINAL` typed so far."""
        f = self.root / "peers" / peer / "terminals" / f"{terminal}.sent"
        return f.read_text().splitlines() if f.exists() else []


@pytest.fixture
def hc(fakes, tmp_path, monkeypatch):
    """The stand-in hc first on PATH, with an empty Hub (a FakeHc) for the test to fill."""
    state = FakeHc(tmp_path / "hc")
    monkeypatch.setenv("FAKE_HC_STATE", str(state.root))
    return state
