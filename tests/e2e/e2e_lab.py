"""The end-to-end suite's world (docs/development.md, "End-to-end suite"): stand-in Hosts that are real sshd in
containers, a sandbox Box (its own HOME, the stand-in vault CLIs, never the real ones), the roster under test run as
a program, and a recorder that writes every step for `scripts/e2e.sh --compare`."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).parent
REPO = HERE.parent.parent
FAKES = REPO / "tests" / "fakes"
IMAGE = "roster-e2e-host"
PORT = int(os.environ.get("ROSTER_E2E_PORT", "2222"))
NET = os.environ.get("ROSTER_E2E_NET", "127.0.0")        # each stand-in Host is NET.N on the host's network
VAULT_CLIS = ("bw", "op", "keepassxc-cli")
ENGINE_ENV = dict(os.environ)       # as the suite started, before any test's own HOME
# The Box's PATH: the system's, without a folder that has a roster in it (a venv's bin, ~/.local/bin), so the roster
# under test is only ever the one roster_command() names
SYSTEM_PATH = os.pathsep.join(d for d in ENGINE_ENV.get("PATH", "/usr/bin:/bin").split(os.pathsep)
                              if d and not (Path(d) / "roster").exists())

# The stand-in Hosts: name -> (last octet, web port or None). Made-up names only (the repo is public).
HOSTS = {"lab-01": (11, 8081), "lab-02": (12, None), "lab-03": (13, None)}
PASSWORDS = {"lab": "lab-pass-1", "ops": "ops-pass-1"}


def engine() -> str | None:
    """podman, else docker, from PATH (or ROSTER_E2E_ENGINE)."""
    if os.environ.get("ROSTER_E2E_ENGINE"):
        return os.environ["ROSTER_E2E_ENGINE"]
    for name in ("podman", "docker"):
        found = shutil.which(name) or (f"/usr/sbin/{name}" if Path(f"/usr/sbin/{name}").exists() else None)
        if found:
            return found
    return None


def enabled() -> tuple[bool, str]:
    if os.environ.get("ROSTER_E2E") != "1":
        return False, "the end-to-end suite runs only with ROSTER_E2E=1 (scripts/e2e.sh)"
    if sys.platform != "linux":
        return False, "the end-to-end suite runs on Linux (containers on the host's network)"
    if not engine():
        return False, "the end-to-end suite needs podman or docker"
    if not shutil.which("ssh"):
        return False, "the end-to-end suite needs OpenSSH's ssh"
    return True, ""


def address(name: str) -> str:
    return f"{NET}.{HOSTS[name][0]}"


def banner(addr: str, port: int, timeout: float = 2.0) -> bytes:
    try:
        with socket.create_connection((addr, port), timeout=timeout) as s:
            s.settimeout(timeout)
            return s.recv(64)
    except OSError:
        return b""


class Lab:
    """The stand-in Hosts' containers, started fresh (new host keys, empty authorized_keys) and removed at the end."""

    def __init__(self):
        self.engine = engine()
        self.prefix = f"roster-e2e-{os.getpid()}"
        self.running: list[str] = []
        self.sweep()

    def sweep(self):
        """Remove the stand-in Hosts an earlier run left behind (it was killed): its process is gone."""
        r = self.podman("ps", "-a", "--filter", "label=roster-e2e", "--format", '{{.Names}} {{.Labels}}',
                        check=False)
        for line in r.stdout.splitlines():
            name = line.split()[0]
            pid = name.removeprefix("roster-e2e-").split("-")[0]
            if pid.isdigit() and int(pid) != os.getpid() and not Path(f"/proc/{pid}").exists():
                self.podman("rm", "-f", "-t", "0", name, check=False)

    def podman(self, *args: str, check: bool = True, **kw) -> subprocess.CompletedProcess:
        # in the environment the suite started with: rootless podman finds its containers through HOME and
        # XDG_RUNTIME_DIR, which tests/conftest.py's `isolated` points elsewhere for every test
        return subprocess.run([self.engine, *args], check=check, text=True, capture_output=True, env=ENGINE_ENV,
                              **kw)

    def build(self):
        r = self.podman("build", "-q", "-t", IMAGE, "-f", str(HERE / "Containerfile"), str(HERE), check=False,
                        timeout=900)
        if r.returncode:
            raise RuntimeError(f"building the stand-in Host image failed:\n{r.stdout}\n{r.stderr}")

    def container(self, name: str) -> str:
        return f"{self.prefix}-{name}"

    def start(self, name: str):
        octet, web = HOSTS[name]
        addr = address(name)
        if banner(addr, PORT, 0.5):
            raise RuntimeError(f"something already listens on {addr}:{PORT}: set ROSTER_E2E_PORT or ROSTER_E2E_NET")
        env = ["-e", f"ADDR={addr}", "-e", f"PORT={PORT}"] + (["-e", f"WEB={web}"] if web else [])
        self.podman("run", "-d", "--rm", "--name", self.container(name), "--hostname", name, "--network", "host",
                    "--label", f"roster-e2e={os.getpid()}", *env, IMAGE)
        self.running.append(name)
        for _ in range(100):
            if banner(addr, PORT).startswith(b"SSH-"):
                return
            time.sleep(0.1)
        logs = self.podman("logs", self.container(name), check=False)
        raise RuntimeError(f"{name}'s sshd didn't start on {addr}:{PORT}:\n{logs.stdout}{logs.stderr}")

    def exec(self, name: str, *argv: str) -> subprocess.CompletedProcess:
        return self.podman("exec", self.container(name), *argv, check=False)

    def read(self, name: str, path: str) -> str | None:
        r = self.exec(name, "cat", path)
        return r.stdout if r.returncode == 0 else None

    def authorized_keys(self, name: str, user: str) -> str | None:
        return self.read(name, f"/home/{user}/.ssh/authorized_keys")

    def ssh_files(self, name: str, user: str) -> dict[str, str | None]:
        """Every file in USER's ~/.ssh on Host NAME (authorized_keys, the Mesh's key, config and known_hosts), by
        path and mode, for a --compare snapshot (compare.py takes the key material out)."""
        listing = self.exec(name, "find", f"/home/{user}/.ssh", "-type", "f", "-exec", "stat", "-c", "%a %n", "{}", "+")
        files: dict[str, str | None] = {}
        for line in sorted(listing.stdout.splitlines()):
            mode, path = line.split(" ", 1)
            files[f"{name}:{path} ({int(mode, 8):04o})"] = self.read(name, path)
        return files

    def stop(self, name: str):
        self.podman("rm", "-f", "-t", "0", self.container(name), check=False)
        if name in self.running:
            self.running.remove(name)

    def close(self):
        for name in list(self.running):
            self.stop(name)


# ---------------------------------------------------------------- the recorder

class Recorder:
    """One JSON line per step in ROSTER_E2E_RECORD's file, for scripts/e2e.sh --compare (tests/e2e/compare.py)."""

    def __init__(self, path: str | None):
        self.path = Path(path) if path else None

    def write(self, kind: str, step: str, **data):
        if self.path:
            with self.path.open("a") as f:
                f.write(json.dumps({"kind": kind, "step": step, **data}, sort_keys=True) + "\n")


RECORDER = Recorder(os.environ.get("ROSTER_E2E_RECORD"))


# ---------------------------------------------------------------- the sandbox Box

@dataclass
class Result:
    argv: list[str]
    code: int
    out: str
    err: str

    @property
    def json(self):
        return json.loads(self.out)


def roster_command() -> list[str]:
    """The roster under test: ROSTER_E2E_ROSTER (a project folder, run with its own .venv), else this checkout's."""
    project = os.environ.get("ROSTER_E2E_ROSTER")
    if project:
        python = Path(project) / ".venv" / "bin" / "python"
        if not python.exists():
            raise RuntimeError(f"{python} is missing: run `uv sync --project {project}` first")
        return [str(python), "-m", "roster"]
    return [sys.executable, "-m", "roster"]


@dataclass
class Box:
    """A sandbox Box: its own HOME and temp folders under ROOT, the stand-in bw/op/keepassxc-cli first on PATH (and
    nothing else of tests/fakes: ssh, nmap and the rest are the real ones), no ssh-agent, no ROSTER_CONFIG."""

    root: Path
    env: dict[str, str] = field(default_factory=dict)
    cwd: Path | None = None

    @classmethod
    def make(cls, root: Path, extra_env: dict[str, str] | None = None) -> Box:
        home, run, tmp, bin_ = (root / "home", root / "run", root / "tmp", root / "bin")
        # ssh's ControlPath in roster's config, HOME/.ssh/cm-HASH (40) plus the 17 characters ssh adds while it
        # binds it, must fit a Unix socket's path (107 bytes)
        assert len(f"{home}/.ssh/cm-") + 40 + 17 <= 107, f"{root} is too long a path: set ROSTER_E2E_TMP shorter"
        for d in (home, run, tmp, bin_):
            d.mkdir(parents=True, exist_ok=True)
        run.chmod(0o700)
        for tool in (*VAULT_CLIS, "pass"):
            (FAKES / tool).chmod(0o755)
            (bin_ / tool).symlink_to(FAKES / tool)
        ssh_wrapper(root, home, bin_)
        work = home / "work"
        work.mkdir()
        env = {
            "HOME": str(home), "USER": os.environ.get("USER", "e2e"), "LOGNAME": os.environ.get("USER", "e2e"),
            "PATH": f"{bin_}{os.pathsep}{SYSTEM_PATH}",
            "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TERM": "dumb", "COLUMNS": "100", "NO_COLOR": "1",
            "XDG_RUNTIME_DIR": str(run), "TMPDIR": str(tmp),
            "FAKE_BW_ITEMS": str(root / "bw-items.json"), "FAKE_BW_STATE": str(root / "bw-state.json"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        env.update(extra_env or {})
        box = cls(root=root, env=env, cwd=work)
        box.guard()
        return box

    @property
    def home(self) -> Path:
        return Path(self.env["HOME"])

    def guard(self):
        """The sandbox guard: HOME is this sandbox's, the vault CLIs are the stand-ins, nothing points elsewhere."""
        import pwd  # (Linux only, as the suite is: not at the top, so Windows collects it)
        real_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
        home = self.home.resolve()
        assert home.is_relative_to(self.root.resolve()) and home != real_home, f"HOME isn't the sandbox's: {home}"
        for tool in VAULT_CLIS:
            found = shutil.which(tool, path=self.env["PATH"])
            assert found and Path(found).resolve() == (FAKES / tool).resolve(), f"{tool} isn't the stand-in: {found}"
        ssh = shutil.which("ssh", path=self.env["PATH"])
        assert ssh and Path(ssh).parent == self.root / "bin", f"ssh isn't the sandbox's own: {ssh}"
        for var in ("ROSTER_CONFIG", "SSH_AUTH_SOCK", "BW_PASSWORD", "OP_SERVICE_ACCOUNT_TOKEN"):
            assert var not in self.env, f"{var} is set in the sandbox"

    def run(self, step: str, *args: str, env: dict[str, str] | None = None, input: str | None = None,
            timeout: float = 180, cwd: Path | None = None) -> Result:
        """`roster ARGS` on this Box, recorded as STEP."""
        return self.program(step, [*roster_command(), *args], env=env, input=input, timeout=timeout, cwd=cwd,
                            shown=["roster", *args])

    def program(self, step: str, argv: list[str], env: dict[str, str] | None = None, input: str | None = None,
                timeout: float = 180, cwd: Path | None = None, shown: list[str] | None = None) -> Result:
        self.guard()
        full = {**self.env, **(env or {})}
        full = {k: v for k, v in full.items() if v is not None}
        # Files, not pipes: an ssh that starts a ControlMaster (roster's config: ControlPersist) leaves it running
        # with the pipes still open, so reading them to their end would wait the ControlPersist out
        with tempfile.TemporaryFile("w+") as out, tempfile.TemporaryFile("w+") as err:
            p = subprocess.run(argv, env=full, cwd=cwd or self.cwd, input=input, text=True, stdout=out, stderr=err,
                               timeout=timeout, stdin=None if input is not None else subprocess.DEVNULL)
            out.seek(0)
            err.seek(0)
            stdout, stderr = out.read(), err.read()
        shown = shown or argv
        RECORDER.write("run", step, argv=shown, code=p.returncode, out=stdout, err=stderr)
        return Result(shown, p.returncode, stdout, stderr)

    def close(self):
        """Stop the ssh ControlMasters this Box's ssh left running (ControlPersist)."""
        for sock in (self.home / ".ssh").glob("cm-*"):
            subprocess.run(["ssh", "-o", f"ControlPath={sock}", "-O", "exit", "e2e"], env=self.env,
                           capture_output=True, timeout=10, check=False)

    def files(self, step: str, files: dict[str, str | None]):
        """Record the text of files (a Host's authorized_keys, this Box's ssh config) as they are at STEP."""
        RECORDER.write("files", step, files=files)

    def tree(self) -> dict[str, str | None]:
        """Every file roster keeps in this Box's HOME (private keys only by name), for a --compare snapshot."""
        files: dict[str, str | None] = {}
        for p in sorted(self.home.rglob("*")):
            if p.is_file() and not p.is_symlink():
                rel = p.relative_to(self.home).as_posix()
                text = p.read_text(errors="replace")
                mode = p.stat().st_mode & 0o777
                files[f"box:{rel} ({mode:04o})"] = "<private key>" if "PRIVATE KEY" in text else text
        return files

    def read(self, rel: str) -> str | None:
        p = self.home / rel
        return p.read_text() if p.is_file() else None

    def ssh(self, step: str, host: str, *command: str, timeout: float = 60) -> Result:
        """Plain `ssh HOST COMMAND` through the ssh config roster wrote, as a person would type it."""
        self.ssh_guard(host)
        return self.program(step, ["ssh", "-o", "BatchMode=yes", host, *command], timeout=timeout)

    def ssh_guard(self, host: str):
        """Before a plain ssh: the config it reads is this sandbox's, and so are its known_hosts and keys."""
        g = subprocess.run(["ssh", "-G", host], env=self.env, capture_output=True, text=True, timeout=10)
        root = str(self.root.resolve())
        for key in ("userknownhostsfile", "identityfile", "controlpath"):
            values = [x.split(" ", 1)[1] for x in g.stdout.splitlines() if x.startswith(f"{key} ")]
            paths = [p.strip('"') for v in values for p in v.split()]
            assert all(p.startswith(root) or p == "none" for p in paths), f"ssh {host}'s {key} is outside: {paths}"


def ssh_wrapper(root: Path, home: Path, bin_: Path):
    """ssh as it is on a Box whose HOME is its home. OpenSSH reads ~/.ssh/config, and expands ~ in its defaults,
    from the password database's home, not $HOME, so in a sandbox it would read the real ~/.ssh/config (and write
    the real known_hosts). The sandbox's ssh is the real one with -F: this HOME's ~/.ssh/config, then the system's,
    then defaults that keep known_hosts and the identities in this HOME."""
    real = shutil.which("ssh", path=SYSTEM_PATH)
    if not real:
        return
    ssh = home / ".ssh"
    (root / "ssh_config").write_text(
        f'Include "{ssh}/config"\nInclude /etc/ssh/ssh_config\n'
        f'Host *\n    UserKnownHostsFile "{ssh}/known_hosts"\n    IdentityFile "{ssh}/id_ed25519"\n')
    wrapper = bin_ / "ssh"
    wrapper.write_text(f'#!/bin/sh\nexec {shlex.quote(real)} -F {shlex.quote(str(root / "ssh_config"))} "$@"\n')
    wrapper.chmod(0o755)


def sandbox_root(name: str) -> Path:
    """A fresh folder for one Box, under ROSTER_E2E_TMP or /tmp: short, so serve's askpass socket fits."""
    base = os.environ.get("ROSTER_E2E_TMP") or "/tmp"
    return Path(tempfile.mkdtemp(prefix=f"e2e-{name}-", dir=base))


# ---------------------------------------------------------------- `roster serve` over stdio

class Serve:
    """`roster serve` on a Box, driven as the app drives it: one JSON-RPC request a line on stdin."""

    def __init__(self, box: Box, step: str, *args: str, env: dict[str, str] | None = None):
        box.guard()
        full = {**box.env, **(env or {})}
        self.step = step
        self.p = subprocess.Popen([*roster_command(), *args, "serve"], env=full, cwd=box.cwd, text=True,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.next_id = 0
        self.answered: dict[int, dict] = {}
        self.notes: list[dict] = []

    def request(self, method: str, params: dict | None = None) -> int:
        self.next_id += 1
        msg = {"jsonrpc": "2.0", "id": self.next_id, "method": method, **({"params": params} if params else {})}
        assert self.p.stdin
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        return self.next_id

    def answer(self, rid: int, step: str = "", timeout: float = 120) -> dict:
        deadline = time.monotonic() + timeout
        assert self.p.stdout
        while rid not in self.answered:
            if time.monotonic() > deadline:
                raise TimeoutError(f"serve didn't answer request {rid}")
            line = self.p.stdout.readline()
            if not line:
                err = self.p.stderr.read() if self.p.stderr else ''
                raise EOFError(f"serve closed stdout before answering {rid}: {err}")
            msg = json.loads(line)
            if "id" not in msg and "method" in msg:
                self.notes.append(msg)
                RECORDER.write("note", f"{self.step}", note=msg)
                continue
            self.answered[msg["id"]] = msg
        r = self.answered[rid]
        RECORDER.write("serve", f"{self.step}/{step}", answer={k: v for k, v in r.items() if k != "id"})
        return r

    def call(self, method: str, params: dict | None = None, step: str = "", timeout: float = 120) -> dict:
        return self.answer(self.request(method, params), step or method, timeout)

    def raw(self, line: str, step: str) -> dict:
        """Send LINE as it is (a malformed request) and read the one answer."""
        assert self.p.stdin and self.p.stdout
        self.p.stdin.write(line + "\n")
        self.p.stdin.flush()
        while True:
            msg = json.loads(self.p.stdout.readline())
            if "id" in msg or "method" not in msg:
                RECORDER.write("serve", f"{self.step}/{step}", answer=msg)
                return msg
            self.notes.append(msg)

    def wait_note(self, method: str, until, timeout: float = 120) -> dict:
        """The first notification METHOD for which UNTIL(params) is true, read while nothing else is pending."""
        deadline = time.monotonic() + timeout
        for n in self.notes:
            if n["method"] == method and until(n.get("params", {})):
                return n
        assert self.p.stdout
        while time.monotonic() < deadline:
            line = self.p.stdout.readline()
            if not line:
                break
            msg = json.loads(line)
            if "id" in msg:
                self.answered[msg["id"]] = msg
                continue
            self.notes.append(msg)
            if msg["method"] == method and until(msg.get("params", {})):
                return msg
        raise TimeoutError(f"no {method} notification came")

    def close(self) -> tuple[int, str]:
        try:
            _, err = self.p.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            self.p.kill()
            _, err = self.p.communicate()
        RECORDER.write("run", f"{self.step}/exit", argv=["roster", "serve"], code=self.p.returncode, out="",
                       err=err)
        return self.p.returncode, err


def on_tty(box: Box, step: str, args: list[str], answers: list[str], timeout: float = 60) -> Result:
    """`roster ARGS` with a terminal of its own (a pty, its controlling one), typing each of ANSWERS when it next
    waits for input: a master password, a yes."""
    import fcntl
    import pty
    import select
    import termios

    box.guard()
    master, slave = pty.openpty()

    def controlling():
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    p = subprocess.Popen([*roster_command(), *args], env=box.env, cwd=box.cwd, stdin=slave, stdout=slave,
                         stderr=slave, start_new_session=True, preexec_fn=controlling)  # noqa: PLW1509
    os.close(slave)
    out = b""
    todo = list(answers)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.5)
        if ready:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        elif todo and p.poll() is None:
            os.write(master, (todo.pop(0) + "\n").encode())
        elif p.poll() is not None:
            break
    p.wait(timeout=10)
    os.close(master)
    text = out.decode(errors="replace").replace("\r\n", "\n")
    RECORDER.write("run", step, argv=["roster", *args], code=p.returncode, out=text, err="")
    return Result(["roster", *args], p.returncode, text, "")
