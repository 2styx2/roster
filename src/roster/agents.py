"""`roster agents`: every Agent across the Hub's herdr machines (ADR 0011). An Agent is a terminal that reports an
agent status to herdr (OSC 7501; Claude Code does so itself). On the Hub the Agent directory is built live from
herdr-core: `hc ls --json` (which merges every connected machine's terminals, `status` only on those that report
one), `hc get` for each Agent (its app, labels and start), and `hc server status` for the Hub's own name.

The directory holds no secret and no screen text: addresses, Hosts, folders, status words and labels."""

from __future__ import annotations

import json
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Any

from .common import UTC_TIME, die, utc_now

LABEL = "roster.label"      # the Agent's label, a herdr terminal label (the spec's Agent label)
TIMEOUT = 15                # seconds an hc call may take


def hc(*args: str) -> Any:
    """`hc ARGS --json`'s document, or a refusal saying herdr-core isn't installed or didn't answer."""
    exe = shutil.which("hc")
    if exe is None:
        die("herdr-core isn't installed here: no `hc` on PATH",
            fix="install herdr-core on this Hub (`hc --version` then works), or run roster agents where it is")
    try:
        r = subprocess.run([exe, *args, "--json"], capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        die(f"herdr-core didn't answer `hc {' '.join(args)}` in {TIMEOUT} s", fix="check it with `hc server status`")
    except OSError as e:
        die(f"couldn't run hc: {e.strerror or type(e).__name__}", fix="check herdr-core's install: `hc --version`")
    why = (r.stderr.strip().splitlines() or [f"exit {r.returncode}"])[-1]
    if r.returncode != 0:
        die(f"herdr-core didn't answer `hc {' '.join(args)}`: {why}",
            fix="start it with `hc server start`, then `hc server status` should answer")
    try:
        return json.loads(r.stdout)
    except ValueError:
        die(f"`hc {' '.join(args)}` printed something that isn't JSON",
            fix="update herdr-core (`hc update`): roster reads hc's --json")


def _iso(ms: object) -> str:
    if not isinstance(ms, (int, float)):
        return ""
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime(UTC_TIME)


def running(started: str, now: datetime | None = None) -> str:
    """How long since STARTED (an ISO time): '30 s', '5 min', '3 h', '2 days'."""
    try:
        then = datetime.strptime(started, UTC_TIME).replace(tzinfo=timezone.utc)
    except ValueError:
        return "?"
    s = max(0, int(((now or datetime.now(timezone.utc)) - then).total_seconds()))
    if s < 60:
        return f"{s} s"
    if s < 3600:
        return f"{s // 60} min"
    if s < 2 * 86400:
        return f"{s // 3600} h"
    return f"{s // 86400} days"


def table(doc: dict[str, Any]) -> str:
    """DOC (the directory) for a person: one block per Host, the Hub first, then each machine by name; a row per
    Agent (address, status, label, folder, how long it has run), the columns lined up across the blocks."""
    hub = doc["hub"]
    hosts = [(hub, "this Hub")] + [(m["name"], m["state"]) for m in doc["machines"]]
    rows = [[a["address"], a["status"], a["label"] or "-", a["folder"], running(a["started"])] for a in doc["agents"]]
    widths = [max((len(r[i]) for r in rows), default=0) for i in range(4)]
    lines: list[str] = []
    for host, word in hosts:
        mine = [r for a, r in zip(doc["agents"], rows, strict=True) if a["host"] == host]
        if not mine:
            lines.append(f"{host} ({word}): no Agents")
            continue
        lines.append(f"{host} ({word})")
        lines += ["  " + "  ".join(c.ljust(w) for c, w in zip(r[:4], widths, strict=True)) + "  " + r[4] for r in mine]
    return "\n".join(lines)


def directory() -> dict[str, Any]:
    """The Agent directory document (version 1, without `version`), built live on the Hub."""
    hub = str(hc("server", "status")["core"]["name"])
    listed = hc("ls")
    agents: list[dict[str, Any]] = []
    for row in listed.get("terminals", []):
        if not row.get("status"):
            continue                                    # not an Agent: it reports no agent status
        t = hc("get", str(row["address"]))
        status = t.get("status") or {}
        if not status.get("state"):
            continue
        machine, _, terminal = str(t["address"]).rpartition("/")
        host = machine or hub
        parent = t.get("parent")
        agents.append({"address": f"{host}/{terminal}", "host": host, "terminal": terminal,
                       "app": str(status.get("app") or ""), "status": str(status["state"]),
                       "label": str((t.get("labels") or {}).get(LABEL, "")), "folder": str(t.get("cwd") or ""),
                       "parent": None if parent is None else str(parent), "started": _iso(t.get("created_ms"))})
    machines = [{"name": str(m["name"]), "state": str(m["state"])} for m in listed.get("machines", [])]
    return {"hub": hub, "you": None, "updated": utc_now(), "machines": machines, "agents": agents}
