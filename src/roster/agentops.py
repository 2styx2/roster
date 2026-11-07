"""`roster agent send|read|wait|label`: reach one Agent (ADR 0011). An address is as in the Agent directory, `HOST/tN`
(the Hub's own Agents `HUB/tN`); a bare `tN` is a terminal on this machine.

On the Hub, whose herdr-core has the other machines added, every Agent is reachable through it: its own by `tN`, a
connected machine's by `MACHINE/tN` (herdr routes it). On a remote Host (one whose directory copy names it in `you`):

- its own Agents go to its own herdr-core;
- a Hub Agent goes through herdr's call-back: this core forwards `HUB/tN` to the Hub, which takes only get, send, read
  and wait (herdr-core remote.rs CALLS_BACK), and only on a Hub terminal that started work on this machine;
- an Agent on another remote Host goes over the Mesh: `ssh -F MESH-CONFIG HOST hc ...` with the Mesh's own key, when
  `roster mesh` gave this Host a key Link to it (herdr has no machine-to-machine route).

Before acting, roster checks the address names a live terminal it can reach, so an unknown, ended or unreachable one
is a plain error with what to do, and nothing is typed anywhere else.

Two facts behind this, checked against herdr-core 0.1.18 (2026-11-06):

- A remote core names the Hub by the Hub core's own name (`hc server status` there: the directory's `hub`), as the
  peer that dialed in (remote.rs peer_joined; kept in the state folder's peers.json, with `calls_me`: the machine name
  the Hub gave it, the directory's `you`). Only when that name is taken there (the remote's own name, one of its
  machines or another peer) does it go by the Hub core's id instead. A terminal the Hub's t3 started there has
  `parent` `HUB/t3`.
- `ssh HOST hc ...` reaches the user's running core: sshd's login sets XDG_RUNTIME_DIR (/run/user/UID), and hc falls
  back to /run/user/UID when it isn't set; a core listening elsewhere is hc's own `unavailable` refusal naming both
  paths. hc is looked for on PATH, then in ~/.local/bin, where `hc machine add --install` puts it."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

from .agents import LABEL, TIMEOUT, hc, local_copy, refusal, run_hc
from .common import refuse
from .errors import ROSTER_ERROR, Problem

LIST_THEM = "`roster agents` lists the live ones and their addresses"
CALLS_BACK = ("send", "read", "wait")       # what herdr lets a machine do to the Hub terminal that started its work
MESH_TIMEOUT = 10                           # s: ssh's ConnectTimeout to a Mesh peer, as the Mesh's own config says


def die(msg: str, fix: str) -> NoReturn:
    """Refuse with MSG and what to do (FIX), both on the plain command line (`error: MSG - FIX`)."""
    refuse(Problem(ROSTER_ERROR, msg, fix=fix))


@dataclass(frozen=True)
class Reach:
    """How roster gets to an Agent: WHERE is the terminal as the hc that runs takes it; OVER, the Mesh peer whose hc
    runs it (`ssh -F CONFIG OVER hc ...`), None for this machine's hc; HUB: it's a Hub Agent, by herdr's call-back."""

    where: str
    over: str | None = None
    config: str = ""
    hub: bool = False


def kind(r: subprocess.CompletedProcess[str]) -> str:
    """The kind of hc's JSON refusal (`{"error": {kind, ...}}` on stderr), or ""."""
    try:
        return str(json.loads(r.stderr.strip().splitlines()[-1])["error"]["kind"])
    except (ValueError, KeyError, TypeError, IndexError):
        return ""


def run(reach: Reach, *args: str, timeout: float | None = TIMEOUT) -> subprocess.CompletedProcess[str]:
    """`hc ARGS --json` run where REACH says: this machine's hc, or the Mesh peer's over ssh (exit 255: ssh didn't get
    there). hc there is found on PATH, then in ~/.local/bin (a non-login shell may not have it on PATH)."""
    if reach.over is None:
        return run_hc(*args, timeout=timeout)
    ssh = shutil.which("ssh")
    if ssh is None:
        die("ssh isn't installed here, and the Mesh reaches other Hosts with it", fix="install the OpenSSH client")
    line = shlex.join(["sh", "-c", 'PATH="$PATH:$HOME/.local/bin"; exec hc "$@"', "hc", *args, "--json"])
    argv = [ssh, "-F", reach.config, "-o", "BatchMode=yes", "-o", f"ConnectTimeout={MESH_TIMEOUT}", reach.over, line]
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        die(f"{reach.over} didn't answer `hc {args[0]}` over the Mesh in {timeout} s",
            fix=f"check its herdr-core: `ssh {reach.over} hc server status`")


# ---------------------------------------------------------------- the Mesh on this Host

def mesh_config() -> Path:
    """The Mesh's ssh config on this Host: the file the Include after roster mesh's mark in ~/.ssh/config names (a
    mesh_dir: of the source's), else roster's own pick, ~/.ssh/roster-mesh/config."""
    from . import mesh, sshconfig
    main = sshconfig.main_config()
    try:
        lines = main.read_text().splitlines()
    except OSError:
        lines = []
    for mark, after in zip(lines, lines[1:], strict=False):
        if mark.strip() == mesh.MARK:
            named = sshconfig.include_targets(after)
            if named:
                return Path(named[0])
    return main.parent / "roster-mesh" / "config"


def mesh_link(host: str) -> tuple[Path, list[str]] | None:
    """(the Mesh's ssh config, HOST's block in it) when `roster mesh` gave this Host a Link to HOST; else None."""
    from . import sshconfig
    config = mesh_config()
    block = sshconfig.written_block(config, host)
    return None if block is None else (config, block)


# ---------------------------------------------------------------- where an address goes

def target(address: str) -> Reach:
    """How to reach ADDRESS's terminal, once it's a live one; else a refusal saying why it can't be reached and what
    to do. `you` (the machine name the Hub gave this one) and `hub` come from the directory copy the Hub wrote here:
    a core's own name may differ from the machine name the Hub knows it by."""
    host, _, terminal = address.rpartition("/")
    if not terminal or "/" in host:
        die(f"{address!r} isn't an Agent address: give HOST/tN, as `roster agents` shows it", fix=LIST_THEM)
    here = str(hc("server", "status")["core"]["name"])
    if not host or host == here:
        return checked(address, Reach(terminal))
    machines = {str(m["name"]): str(m["state"]) for m in hc("ls").get("machines", [])}
    if host in machines:
        if machines[host] != "connected":
            die(f"{address} can't be reached now: herdr says {host} is {machines[host]}",
                fix=f"reconnect it (`hc machine login {host}`), then try again; `roster agents` shows each "
                    "machine's state")
        return checked(address, Reach(address))
    copy = None if machines else local_copy()       # a core with machines added is the Hub: its copy has no `you`
    if machines:
        die(f"{address} can't be reached from {here}: {host} isn't a machine of this herdr-core",
            fix=f"add it on this Hub (`hc machine add {host}`) if it's yours; " + LIST_THEM)
    if copy is None:
        die(f"{address} can't be reached from {here}: {host} isn't a machine of this herdr-core, and no Agent "
            "directory has reached this machine to say which Host it is",
            fix="`roster agents sync` on the Hub writes the directory here; from the Hub (the herdr-core with every "
                "machine added) `roster agent` reaches every Agent")
    you, hub = str(copy["you"]), str(copy["hub"])
    if host == you:
        return checked(address, Reach(terminal))
    if host == hub:
        return checked(address, Reach(address, hub=True), you=you)
    link = mesh_link(host)
    if link is None:
        die(f"{address} can't be reached from {you}: there's no Mesh Link from {you} to {host}, and herdr doesn't "
            "route between machines",
            fix=f"add the Link on the Box: `- {{ from: {you}, to: {host} }}` under `links:` in roster.yml, then "
                f"`roster mesh`; or send it from the Hub {hub}")
    config, block = link
    if any(ln.split()[:2] == ["PubkeyAuthentication", "no"] for ln in block):
        die(f"{address} can't be reached from {you}: the Mesh reaches {host} with a password only, and roster can't "
            "type one here",
            fix=f"let the Mesh enroll a key on {host} (drop `enroll: false` from it in roster.yml, then "
                f"`roster mesh`); or send it from the Hub {hub}")
    return checked(address, Reach(terminal, over=host, config=str(config)), you=you)


def checked(address: str, reach: Reach, you: str = "") -> Reach:
    """REACH once `hc get` there finds a live terminal at ADDRESS; else why not, and what to do."""
    host = address.rpartition("/")[0]
    r = run(reach, "get", reach.where)
    if r.returncode != 0:
        why = refusal(r)
        if reach.over and r.returncode == 255:
            die(f"{reach.over} didn't answer over the Mesh: {why}",
                fix=f"check that it's up and that `ssh {reach.over}` works from {you}; `roster agents` shows each "
                    "machine's state as the Hub last saw it")
        if reach.over and (r.returncode == 127 or "not found" in why):
            die(f"herdr-core isn't installed on {reach.over}: no `hc` there",
                fix=f"make {reach.over} a herdr machine from the Hub (`hc machine add {reach.over} --install`)")
        if reach.hub and kind(r) == "denied":
            die(f"{address} can't be reached from {you}: herdr lets a machine reach only the Hub terminals that "
                f"started work on it ({why})",
                fix=f"send it from a Hub terminal on the Hub {host}, or answer the Hub Agent that started yours: "
                    "`hc get $HC_TERMINAL_ID` shows it as `parent`")
        if reach.hub and kind(r) == "unavailable":
            die(f"{address} can't be reached now: {host} isn't connected to {you} now ({why})",
                fix=f"try again once the Hub {host} is back (herdr reconnects it by itself)")
        if reach.hub and kind(r) == "machine_unknown":
            die(f"{address} can't be reached from {you}: this herdr-core doesn't know the Hub as {host} ({why})",
                fix="answer the Hub Agent that started yours by the address `hc get $HC_TERMINAL_ID` shows as "
                    "`parent`; " + LIST_THEM)
        die(f"no Agent at {address}: {why}", fix=LIST_THEM)
    if json.loads(r.stdout).get("state", "live") != "live":
        die(f"{address} has ended: there's no Agent there to reach any more", fix=LIST_THEM)
    return reach


def act(address: str, *args: str, timeout: float | None = TIMEOUT) -> Any:
    """hc's document for `hc ARGS` run on ADDRESS's terminal (args[0] is the command, the terminal goes after it),
    given TIMEOUT seconds (None: as long as hc takes)."""
    reach = target(address)
    if reach.hub and args[0] not in CALLS_BACK:
        die(f"herdr lets this machine only send, read and wait on the Hub's Agents, so it can't {args[0]} {address}",
            fix=f"`roster agent {args[0]}` it on the Hub, or ask that Agent to")
    r = run(reach, args[0], reach.where, *args[1:], timeout=timeout)
    if r.returncode != 0:
        die(f"herdr-core refused `hc {args[0]}` on {address}: {refusal(r)}", fix=LIST_THEM)
    return json.loads(r.stdout or "{}")


def send(address: str, text: str) -> str:
    """Type TEXT into ADDRESS's Agent and press Enter; what to tell the person."""
    done = act(address, "send", text)
    status = done.get("status")
    return f"sent to {address}" + (f" (it was {status})" if status else "")


def read(address: str, lines: int = 0) -> str:
    """ADDRESS's screen, with LINES of history above it."""
    return str(act(address, "read", "--lines", str(lines)).get("text") or "")


TIMED_OUT = 124             # wait's exit when it gave up, as hc's and timeout(1)'s


def wait(address: str, timeout: float | None = None) -> tuple[str, int]:
    """Wait until ADDRESS's Agent stops working: what to tell the person, and the exit (124: it gave up after
    TIMEOUT seconds; None: herdr-core's own wait_timeout)."""
    more = () if timeout is None else ("--timeout", f"{timeout:g}")
    done = act(address, "wait", *more, timeout=None if timeout is None else timeout + 30)
    status = done.get("status") or "working"
    reason = done.get("reason")
    if reason == "timeout" or done.get("ended") is False:
        after = "" if timeout is None else f" after {timeout:g} s"
        return (f"{address} is still {status}{after}: `roster agent wait {address}` again, or see what it's doing "
                f"with `roster agent read {address}`", TIMED_OUT)
    if reason == "exit":
        code = done.get("exit_code")
        return f"{address} ended" + (f" (exit {code})" if code is not None else ""), 0
    if reason == "message":
        sender = done.get("from")
        return "a message came in for you" + (f" from {sender}" if sender else "") + " while waiting", 0
    return f"{address} is {status}", 0


def label(address: str | None, text: str) -> str:
    """Set ADDRESS's label (its `roster.label`; TEXT "" removes it), the calling Agent's when ADDRESS is None."""
    if address is None:
        address = os.environ.get("HC_TERMINAL_ID", "")
        if not address:
            die("not in a herdr terminal (no HC_TERMINAL_ID), so there's no Agent of yours to label",
                fix="name the Agent: `roster agent label ADDRESS TEXT`; " + LIST_THEM)
    act(address, "label", f"{LABEL}={text}")
    return f"{address} is labelled: {text}" if text else f"{address}'s label is removed"
