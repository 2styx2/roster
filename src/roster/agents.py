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

from .common import UTC_TIME, ago, die, utc_now
from .errors import Exit

LABEL = "roster.label"      # the Agent's label, a herdr terminal label (the spec's Agent label)
DOC = "roster.agents"       # the shared document each core holds its copy of the directory in
VERSION = 1                 # the directory document's own version (the spec's shape)
STALE = 5 * 60              # seconds after which a remote Host's copy is called stale
TIMEOUT = 15                # seconds an hc call may take


def run_hc(*args: str, timeout: float | None = TIMEOUT) -> subprocess.CompletedProcess[str]:
    """`hc ARGS --json` run, whatever its exit (its document on stdout, a refusal on stderr), or a refusal saying
    herdr-core isn't installed or didn't answer in TIMEOUT seconds (None: hc's own timeout ends it)."""
    exe = shutil.which("hc")
    if exe is None:
        die("herdr-core isn't installed here: no `hc` on PATH",
            fix="install herdr-core on this machine (`hc --version` then works), or run roster where it is")
    try:
        return subprocess.run([exe, *args, "--json"], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        die(f"herdr-core didn't answer `hc {' '.join(args)}` in {timeout} s", fix="check it with `hc server status`")
    except OSError as e:
        die(f"couldn't run hc: {e.strerror or type(e).__name__}", fix="check herdr-core's install: `hc --version`")


def refusal(r: subprocess.CompletedProcess[str]) -> str:
    """What a failed hc run said: the message of its JSON refusal (`{"error": {message, ...}}`), else its last line."""
    last = (r.stderr.strip().splitlines() or [f"exit {r.returncode}"])[-1]
    try:
        error = json.loads(last)["error"]
        return str(error.get("message") or error.get("kind") or last)
    except (ValueError, KeyError, TypeError, AttributeError):
        return last.removeprefix("error: ")


def hc(*args: str) -> Any:
    """`hc ARGS --json`'s document, or a refusal saying herdr-core isn't installed or didn't answer."""
    r = run_hc(*args)
    why = refusal(r)
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
    Agent (address, status, label, folder, how long it has run), the columns lined up across the blocks. A copy read
    on a remote Host (`you` set) starts with where it came from and how old it is, and marks that Host `you`."""
    hub, you = doc["hub"], doc.get("you")
    hosts = [(hub, "the Hub" if you else "this Hub")]
    hosts += [(m["name"], f"{m['state']}, you" if m["name"] == you else m["state"]) for m in doc["machines"]]
    rows = [[a["address"], a["status"], a["label"] or "-", a["folder"], running(a["started"])] for a in doc["agents"]]
    widths = [max((len(r[i]) for r in rows), default=0) for i in range(4)]
    lines: list[str] = []
    if you:
        lines.append(f"Agent directory from the Hub {hub}, written {ago(doc['updated'])}; this is {you}")
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


def local_copy() -> dict[str, Any] | None:
    """The directory the Hub last wrote into this machine's core (doc.get DOC), when this is a remote Host: a copy
    naming this machine in `you`. None on the Hub (its own copy has `you` null), before the first sync, or when this
    core can't be read (the live directory then says why)."""
    try:
        got = rpc([("doc.get", {"name": DOC})])[0]
    except Exit:
        return None
    value = (got.get("result") or {}).get("value")
    if not (isinstance(value, dict) and value.get("version") == VERSION and value.get("you")):
        return None
    from pydantic import ValidationError

    from .jsondocs import AgentDirectoryDoc, plain
    doc = {k: v for k, v in value.items() if k != "version"}
    try:
        return plain(AgentDirectoryDoc.model_validate(doc))
    except ValidationError:
        return None                         # not a directory this roster reads: build what it can see instead


def stale(doc: dict[str, Any], now: datetime | None = None) -> str | None:
    """Why a copy read on a remote Host (DOC, `you` set) can't be trusted as current, when it's older than STALE;
    else None. The Hub's directory is built live and never stale."""
    if not doc.get("you"):
        return None
    try:
        then = datetime.strptime(str(doc["updated"]), UTC_TIME).replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    if ((now or datetime.now(timezone.utc)) - then).total_seconds() <= STALE:
        return None
    return (f"this Agent directory is stale: the Hub {doc['hub']} wrote it {ago(doc['updated'], now)} and not since. "
            f"It's rewritten while herdr-app runs the roster mod on the Hub; `roster agents sync` there writes it now")


def rpc(calls: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    """Each (METHOD, PARAMS) sent to this machine's herdr-core JSON-RPC over `hc connect` (one message a line; hc
    has no `doc` subcommand), and its reply in the same order: {"result": ...} or {"error": {message, data}}."""
    exe = shutil.which("hc")
    if exe is None:
        die("herdr-core isn't installed here: no `hc` on PATH",
            fix="install herdr-core on this machine (`hc --version` then works)")
    lines = "".join(json.dumps({"jsonrpc": "2.0", "id": i, "method": m, "params": p}) + "\n"
                    for i, (m, p) in enumerate(calls, 1))
    try:
        r = subprocess.run([exe, "connect"], input=lines, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        die(f"herdr-core didn't answer `hc connect` in {TIMEOUT} s", fix="check it with `hc server status`")
    except OSError as e:
        die(f"couldn't run hc: {e.strerror or type(e).__name__}", fix="check herdr-core's install: `hc --version`")
    replies: dict[Any, dict[str, Any]] = {}
    for line in r.stdout.splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if isinstance(msg, dict) and "id" in msg:
            replies[msg["id"]] = msg
    if calls and not replies:
        why = (r.stderr.strip().splitlines() or [f"exit {r.returncode}"])[-1]
        die(f"herdr-core didn't answer `hc connect`: {why}",
            fix="start it with `hc server start`, then `hc server status` should answer")
    lost = {"error": {"message": "no answer from herdr-core", "data": {"kind": "unavailable"}}}
    return [replies.get(i, lost) for i in range(1, len(calls) + 1)]


def _kind(reply: dict[str, Any]) -> str:
    return str(((reply.get("error") or {}).get("data") or {}).get("kind") or "")


def _why(reply: dict[str, Any]) -> str:
    e = reply.get("error") or {}
    return str(e.get("message") or _kind(reply) or "failed")


def write(copies: dict[str | None, dict[str, Any]], tries: int = 3) -> dict[str | None, str | None]:
    """Each copy written as the shared document DOC into its core (key None: this one; else the machine reached
    `on` it), at the version doc.get just gave. A write that lost a race (conflict) reads and tries again, up to
    TRIES rounds. Each core's result: None (written) or herdr's words for why not."""
    pending = list(copies)
    result: dict[str | None, str | None] = {}
    for _ in range(tries):
        if not pending:
            break
        on = [{} if m is None else {"on": m} for m in pending]
        got = rpc([("doc.get", {"name": DOC, **o}) for o in on])
        ready = []
        for m, o, g in zip(pending, on, got, strict=True):
            if "result" in g:
                ready.append((m, o, int((g["result"] or {}).get("version") or 0)))
            else:
                result[m] = _why(g)
        put = rpc([("doc.set", {"name": DOC, "value": copies[m], "version": v, **o}) for m, o, v in ready])
        pending = []
        for (m, _, _), p in zip(ready, put, strict=True):
            result[m] = None if "result" in p else _why(p)
            if _kind(p) == "conflict":
                pending.append(m)
    return result


def sync() -> dict[str, Any]:
    """`roster agents sync`: the directory built live on the Hub, written into the Hub's own core (`you` null) and
    into each connected machine's (`you` its name); a machine that isn't connected is skipped. The report: {hub,
    updated, agents (how many), machines: [{name, state, written, error}]}, the Hub first (state `hub`)."""
    doc = {"version": VERSION, **directory()}
    connected = [m["name"] for m in doc["machines"] if m["state"] == "connected"]
    copies: dict[str | None, dict[str, Any]] = {None: doc, **{m: {**doc, "you": m} for m in connected}}
    result = write(copies)
    rows = [{"name": doc["hub"], "state": "hub", "written": result[None] is None, "error": result[None]}]
    for m in doc["machines"]:
        tried = m["name"] in result
        rows.append({"name": m["name"], "state": m["state"], "written": tried and result[m["name"]] is None,
                     "error": result[m["name"]] if tried else None})
    return {"hub": doc["hub"], "updated": doc["updated"], "agents": len(doc["agents"]), "machines": rows}


def sync_table(report: dict[str, Any]) -> str:
    """A sync's REPORT for a person: a line per core (written, failed with herdr's words, or skipped), then a
    count."""
    lines = []
    for m in report["machines"]:
        name = f"{m['name']} (this Hub)" if m["state"] == "hub" else m["name"]
        if m["written"]:
            lines.append(f"{name}: written")
        elif m["error"]:
            lines.append(f"{name}: failed: {m['error']}")
        else:
            lines.append(f"{name}: skipped ({m['state']})")
    tried = [m for m in report["machines"] if m["state"] in ("hub", "connected")]
    n = report["agents"]
    lines.append(f"Agent directory ({n} Agent{'' if n == 1 else 's'}) written to "
                 f"{sum(m['written'] for m in tried)} of {len(tried)} herdr-cores")
    return "\n".join(lines)
