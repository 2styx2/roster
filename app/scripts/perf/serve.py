"""A stand-in `roster serve` for measuring the app (app/scripts/perf.sh, docs/app/performance.md).

JSON-RPC 2.0, one object per line, like roster's. It serves made-up Hosts only (no roster.yml, no vault, no
ssh): HOSTS Hosts in groups of 50 at addresses in 198.18.0.0/15 (RFC 2544's benchmarking range), no vault
(no lock screen), and a Session that is this same file run with `--stream`: a fake log that prints RATE
lines a second until it is closed, so the PTY, wsl.exe, the IPC channel and xterm all do real work.

    python3 serve.py [--hosts N] [--rate LINES_PER_S] [--latency DIR] [anything roster's argv adds: -c PATH serve]
    python3 serve.py --stream RATE        (what a Session runs)

--latency DIR adds a Host named `latency` (group `perf`) whose Session is latency.py: it measures the terminal
path from inside the Session and saves its results in DIR (app/scripts/linux-run.sh, ticket 20).
"""
import json
import os
import sys
import time

PROGRESS = "/tmp/roster-perf"         # noqa: S108 - a dev script's progress file, nothing secret


def stream(rate):
    """A busy log: RATE coloured lines a second (0: a quiet prompt), in bursts every 50 ms, as a build or a
    `journalctl -f` would print them."""
    out = sys.stdout.buffer
    out.write(b"perf stream: %d lines/s\r\n$ " % rate)
    out.flush()
    if rate <= 0:
        while True:
            time.sleep(3600)
    n, tick = 0, 0.05
    per_tick = max(1, round(rate * tick))
    nxt = time.monotonic()
    # How many lines the terminal has taken so far, once a second (perf.sh: does the app keep up?).
    os.makedirs(PROGRESS, exist_ok=True)
    progress = os.path.join(PROGRESS, str(os.getpid()))
    ticks = 0
    while True:
        lines = []
        for _ in range(per_tick):
            n += 1
            lines.append(b"\x1b[2m%08d\x1b[0m \x1b[32mINFO\x1b[0m worker-%02d handled request %d in %d ms "
                         b"path=/api/v1/items/%d status=200 bytes=%d\r\n" % (n, n % 16, n, n % 97, n % 5000, n * 7 % 65536))
        out.write(b"".join(lines))
        out.flush()
        ticks += 1
        if ticks % 20 == 0:
            with open(progress, "w") as f:
                f.write(str(n))
        nxt += tick
        time.sleep(max(0.0, nxt - time.monotonic()))


def arg(name, default):
    return int(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


if "--stream" in sys.argv:
    import signal
    for sig in (signal.SIGHUP, signal.SIGTERM):      # the Session closed: tidy up the progress file
        signal.signal(sig, lambda *_: sys.exit(0))
    try:
        stream(arg("--stream", 100))
    except (KeyboardInterrupt, OSError):
        pass
    finally:
        try:
            os.remove(os.path.join(PROGRESS, str(os.getpid())))
        except OSError:
            pass
    sys.exit(0)

HOSTS = arg("--hosts", 1284)
RATE = arg("--rate", 100)
KINDS = ["linux", "linux", "linux", "esxi", "switch", "windows"]


def host(i):
    group = f"rack-{i // 50 + 1:02d}"
    kind = KINDS[i % len(KINDS)]
    password = kind in ("esxi", "switch")
    return {"name": f"{kind}-{i + 1:04d}", "group": group, "ip": f"198.18.{i // 250}.{i % 250 + 1}",
            "type": kind, "product": "", "title": f"Perf host {i + 1}" if i % 3 == 0 else "", "description": "",
            "reviewed": i % 40 != 0, "enroll": True,
            "ssh": {"user": "root", "port": 22, "auth": "password" if password else "key"}, "web": None}


hosts = [host(i) for i in range(HOSTS)]
LATENCY = sys.argv[sys.argv.index("--latency") + 1] if "--latency" in sys.argv else None
if LATENCY:
    hosts.insert(0, {**host(0), "name": "latency", "group": "perf", "ip": "198.18.255.1", "title": "Latency check",
                     "reviewed": True, "ssh": {"user": "root", "port": 22, "auth": "key"}})
by_name = {h["name"]: h for h in hosts}
groups = {h["group"]: {"title": h["group"].replace("-", " ").title(), "description": ""} for h in hosts}
me = os.path.abspath(__file__)


def answer(m, p):
    if m == "inventory.info":
        return {"path": "/perf/roster.yml", "box": "perf-box", "host_count": len(hosts), "providers": [],
                "roster_version": "0.0.0-perf", "api_version": 13}
    if m == "hosts.list":
        return {"hosts": hosts, "groups": groups, "error": None}
    if m == "host.get":
        if p.get("name") in by_name:
            return by_name[p["name"]]
        raise LookupError(2, f"unknown host {p.get('name')!r}")
    if m == "vault.status":
        return {"provider": None, "status": "unsupported", "providers": []}
    if m == "inventory.watch":
        return {"watching": False, "auto": bool(p.get("auto", False))}
    if m == "session.prepare":
        h = by_name.get(p.get("host"))
        if h is None:
            raise LookupError(2, f"unknown host {p.get('host')!r}")
        if h["name"] == "latency" and LATENCY:
            argv = [sys.executable, os.path.join(os.path.dirname(me), "latency.py"), LATENCY]
        else:
            argv = [sys.executable, me, "--stream", str(RATE)]
        return {"argv": argv, "env": {}, "host": h["name"], "auth": "key"}
    raise LookupError(-32601, f"unknown method {m!r}")


for line in sys.stdin:
    req = json.loads(line)
    if "id" not in req:
        continue
    try:
        body = {"result": answer(req["method"], req.get("params") or {})}
    except LookupError as e:
        body = {"error": {"code": e.args[0], "message": e.args[1]}}
    print(json.dumps({"jsonrpc": "2.0", "id": req["id"], **body}), flush=True)
