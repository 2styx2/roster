"""`roster agent send|read|wait|label`: reach one Agent through this machine's herdr-core (ADR 0011). An address is
as in the Agent directory, `HOST/tN` (the Hub's own Agents `HUB/tN`); a bare `tN` is a terminal on this machine.

On the Hub, whose herdr-core has the other machines added, every Agent is reachable: its own by `tN`, a connected
machine's by `MACHINE/tN` (herdr routes it). Anywhere else only the Agents on the same machine are. Before acting,
roster checks the address names a live terminal, so an unknown or ended one is a plain error with what to do."""

from __future__ import annotations

import json
import os
from typing import Any, NoReturn

from .agents import LABEL, hc, refusal, run_hc
from .common import refuse
from .errors import ROSTER_ERROR, Problem

LIST_THEM = "`roster agents` lists the live ones and their addresses"


def die(msg: str, fix: str) -> NoReturn:
    """Refuse with MSG and what to do (FIX), both on the plain command line (`error: MSG - FIX`)."""
    refuse(Problem(ROSTER_ERROR, msg, fix=fix))


def target(address: str) -> str:
    """The terminal hc takes for ADDRESS (`t2` on this machine, `MACHINE/t2` on a machine this core added), once it's
    a live terminal; else a refusal saying why it can't be reached and what to do."""
    host, _, terminal = address.rpartition("/")
    if not terminal or "/" in host:
        die(f"{address!r} isn't an Agent address: give HOST/tN, as `roster agents` shows it", fix=LIST_THEM)
    here = str(hc("server", "status")["core"]["name"])
    if not host or host == here:
        where = terminal
    else:
        machines = {str(m["name"]): str(m["state"]) for m in hc("ls").get("machines", [])}
        if host not in machines:
            die(f"{address} can't be reached from {here}: {host} isn't a machine of this herdr-core",
                fix="from the Hub (the herdr-core with every machine added) `roster agent` reaches every Agent; "
                    + LIST_THEM)
        if machines[host] != "connected":
            die(f"{address} can't be reached now: herdr says {host} is {machines[host]}",
                fix=f"reconnect it (`hc machine login {host}`), then try again; `roster agents` shows each "
                    "machine's state")
        where = address
    r = run_hc("get", where)
    if r.returncode != 0:
        die(f"no Agent at {address}: {refusal(r)}", fix=LIST_THEM)
    if json.loads(r.stdout).get("state", "live") != "live":
        die(f"{address} has ended: there's no Agent there to reach any more", fix=LIST_THEM)
    return where


def act(address: str, *args: str, timeout: float | None = None) -> Any:
    """hc's document for `hc ARGS` run on ADDRESS's terminal (args[0] is the command, the terminal goes after it)."""
    where = target(address)
    kwargs = {} if timeout is None else {"timeout": timeout}
    r = run_hc(args[0], where, *args[1:], **kwargs)
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
