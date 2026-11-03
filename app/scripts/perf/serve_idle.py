"""How often the real `roster serve` wakes up while idle (app/scripts/perf.sh serve; docs/app/performance.md).

Starts the checkout's roster on a copy of examples/roster.example.yml (made-up Hosts, no vault calls), asks
inventory.info, then counts the context switches of all its threads over SECONDS, without and with
inventory.watch (the app always starts it).

    python3 serve_idle.py REPO [SECONDS]
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

repo = Path(sys.argv[1]).resolve()
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 10


def switches(pid):
    """Context switches of all the process's threads, and its CPU ticks (100 a second)."""
    total = 0
    for status in glob.glob(f"/proc/{pid}/task/*/status"):
        for line in Path(status).read_text().splitlines():
            if line.startswith(("voluntary_ctxt_switches", "nonvoluntary_ctxt_switches")):
                total += int(line.split()[1])
    stat = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return total, int(stat[11]) + int(stat[12])


def measure(watch):
    with tempfile.TemporaryDirectory(prefix="roster-perf-") as d:
        inventory = Path(d) / "roster.yml"
        shutil.copy(repo / "examples" / "roster.example.yml", inventory)
        venv_python = Path(os.environ.get("PERF_PYTHON", repo / ".venv" / "bin" / "python"))
        python = str(venv_python) if venv_python.exists() else sys.executable
        env = {**os.environ, "PYTHONPATH": str(repo / "src")}       # this checkout's roster, whichever venv runs it
        p = subprocess.Popen([python, "-m", "roster", "-c", str(inventory), "serve"], cwd=d, env=env, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            def call(i, method, params=None):
                p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}) + "\n")
                p.stdin.flush()
                return json.loads(p.stdout.readline())
            if "result" not in call(1, "inventory.info"):
                raise SystemExit("serve didn't start")
            if watch:
                call(2, "inventory.watch", {"auto": False})
            time.sleep(1)
            s0, c0 = switches(p.pid)
            time.sleep(seconds)
            s1, c1 = switches(p.pid)
            return (s1 - s0) / seconds, (c1 - c0) / seconds
        finally:
            p.kill()
            p.wait()


for watch in (False, True):
    wakeups, cpu = measure(watch)
    print(f"roster serve idle{' + inventory.watch' if watch else ''}: {wakeups:.1f} wake-ups/s, CPU {cpu:.2f} % of a core")
