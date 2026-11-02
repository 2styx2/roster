"""`roster serve`'s discover.* methods (ticket 44): a scan of a network that runs in serve, in the background, with its
progress and results to poll, a way to stop it, and the Hosts the user picks added as a Pending change. The app's UI
for it is the first-party Plugin plugins/discover. Nothing here touches a network: nmap is tests/fakes/nmap, which
answers from the stand-in Hosts under FAKE_HOSTS."""

import shutil
import subprocess
import time
from pathlib import Path

import pytest
import yaml
from conftest import WINDOWS

from roster import discover

INVENTORY = """\
groups:
  lab:
    user: ops
    hosts:
      esx-02: {ip: 10.0.0.5}
"""


def git(cwd, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args], cwd=cwd, check=True,
                   capture_output=True)


@pytest.fixture
def net(fakes, isolated, monkeypatch):
    """Stand-in Hosts on 10.0.0.0/24, and the stand-in nmap (never the real one) to find them."""
    found = shutil.which("nmap")                # Windows: the conftest's NAME.cmd shim, in a folder named fakes
    assert found and Path(found).parent.name == "fakes", "the tests must never run the real nmap"
    root = isolated["home"].parent / "hosts"

    def add(name, address, ports, hostname="", title=""):
        d = root / name
        d.mkdir(parents=True)
        (d / "address").write_text(address)
        (d / "ports").write_text("\n".join(ports) + "\n")
        hostname and (d / "hostname").write_text(hostname)
        title and (d / "title").write_text(title)
        return d

    add("esx-02", "10.0.0.5", ["22 ssh OpenSSH 9.6", "443 https VMware ESXi"])
    add("appliance", "10.0.0.7", ["443 https lighttpd"], hostname="appliance.lab", title="Appliance login")
    add("db", "10.0.0.9", ["22 ssh OpenSSH 9.6", "5432 postgresql"])
    add("elsewhere", "10.0.1.4", ["22 ssh OpenSSH 9.6"])
    monkeypatch.setenv("FAKE_HOSTS", str(root))
    monkeypatch.setenv("FAKE_LOG", str(isolated["home"].parent / "log"))
    return root


@pytest.fixture
def inventory(write_config):
    """roster.yml committed in a git repo, so adding to it is a Pending change."""
    path = write_config(INVENTORY)
    git(path.parent, "init", "-q")
    git(path.parent, "add", path.name)
    git(path.parent, "commit", "-qm", "inventory")
    return path


def finished(s, scan, tries=200):
    """discover.status until the scan is over."""
    for _ in range(tries):
        r = s.call("discover.status", {"scan": scan})["result"]
        if r["state"] not in ("running", "stopping"):
            return r
        time.sleep(0.05)
    raise AssertionError("the scan never finished")


def test_plan_says_what_a_scan_would_do_and_changes_nothing(serve, net, inventory, isolated):
    r = serve("-c", str(inventory)).call("discover.plan", {"targets": ["10.0.0.0/24"]})["result"]
    assert r == {"targets": ["10.0.0.0/24"], "addresses": 254, "ports": len(discover.DEFAULT_SCAN_PORTS.split(",")),
                 "scanner": "nmap", "limit": 4096, "max": 65536}
    assert not (isolated["home"].parent / "log").exists()                   # nothing was scanned


def test_bad_targets_and_too_many_addresses_are_refused(serve, net, inventory):
    s = serve("-c", str(inventory))
    for bad in ([], ["10.0.0.0/33"], ["esx-02"], "10.0.0.0/24", [7]):
        assert s.call("discover.plan", {"targets": bad})["error"]["code"] == -32602
    e = s.call("discover.start", {"targets": ["10.0.0.0/19"]})["error"]
    assert e["code"] == 121 and e["data"] == {"addresses": 8190, "limit": 4096, "max": 65536,
                                              "fix": "scan a smaller range, or confirm the larger scan (force)"}
    assert s.call("discover.plan", {"targets": ["10.0.0.0/19"], "force": True})["result"]["addresses"] == 8190
    assert s.call("discover.plan", {"targets": ["10.0.0.0/15"], "force": True})["error"]["code"] == 121
    assert s.call("discover.plan", {"targets": ["10.0.0.0/24"], "ports": "22,abc"})["error"]["code"] == -32602


def test_a_scan_runs_in_the_background_and_its_results_come_in_as_they_are_found(serve, net, inventory):
    s = serve("-c", str(inventory))
    started = s.call("discover.start", {"targets": ["10.0.0.0/24"]})["result"]
    assert started["state"] == "running" and started["total"] == 254 and started["scanner"] == "nmap"
    r = finished(s, started["scan"])
    assert r["state"] == "done" and r["done"] == r["total"] == 254 and r["error"] is None
    assert [f["address"] for f in r["found"]] == ["10.0.0.5", "10.0.0.7", "10.0.0.9"]     # not 10.0.1.4
    esx, app, db = r["found"]
    assert esx["known"] == "esx-02" and esx["name"] is None                 # already in the Inventory
    assert app == {"address": "10.0.0.7", "name": "appliance", "type": "appliance", "hostname": "appliance.lab",
                   "title": "Appliance login", "web": "https://10.0.0.7", "known": None, "added": None,
                   "vendor": "", "os": "", "mac": "",
                   "ports": [{"port": 443, "name": "https", "product": "lighttpd", "title": "Appliance login"}]}
    assert db["name"] == "db-10-0-0-9" and db["type"] == "db"
    assert r["count"] == 3
    # since: only what came after
    again = s.call("discover.status", {"scan": started["scan"], "since": 2})["result"]
    assert [f["address"] for f in again["found"]] == ["10.0.0.9"] and again["count"] == 3


# Killing the stand-in's NAME.cmd shim on Windows leaves its Python running with the pipes open; roster serve runs
# on Linux (WSL on Windows), where nmap is one process.
@pytest.mark.skipif(WINDOWS, reason="stop kills nmap's process; the Windows shim is two")
def test_only_one_scan_at_a_time_and_stop_ends_it(serve, net, inventory, monkeypatch):
    monkeypatch.setenv("FAKE_NMAP_DELAY", "30")
    s = serve("-c", str(inventory))
    scan = s.call("discover.start", {"targets": ["10.0.0.0/24"]})["result"]["scan"]
    e = s.call("discover.start", {"targets": ["10.0.1.0/24"]})["error"]
    assert e["code"] == 120 and e["data"]["scan"] == scan
    t = time.monotonic()
    assert s.call("discover.stop", {"scan": scan})["result"] == {"scan": scan, "stopping": True}
    r = finished(s, scan)
    assert r["state"] == "stopped" and time.monotonic() - t < 10            # nmap was killed, not waited for
    assert s.call("discover.stop", {"scan": scan})["result"] == {"scan": scan, "stopping": False}
    # a new one may start now
    assert s.call("discover.start", {"targets": ["10.0.1.0/24"]})["result"]["scan"] != scan


def test_a_failed_nmap_is_the_scans_state_not_a_hang(serve, net, inventory, monkeypatch):
    monkeypatch.setenv("FAKE_NMAP_FAIL", "nmap: you need root for that")
    s = serve("-c", str(inventory))
    r = finished(s, s.call("discover.start", {"targets": ["10.0.0.0/28"]})["result"]["scan"])
    assert r["state"] == "failed" and "you need root" in r["error"]


def test_unknown_scans(serve, net, inventory):
    s = serve("-c", str(inventory))
    for method in ("discover.status", "discover.stop"):
        assert s.call(method, {})["error"]["code"] == 122              # none yet
    s.call("discover.start", {"targets": ["10.0.0.0/30"]})
    assert s.call("discover.status", {"scan": "nope"})["error"]["code"] == 122
    assert s.call("discover.add", {"scan": "nope", "addresses": ["10.0.0.7"]})["error"]["code"] == 122


def test_add_writes_the_picked_hosts_as_a_pending_change_unreviewed(serve, net, inventory):
    s = serve("-c", str(inventory))
    scan = s.call("discover.start", {"targets": ["10.0.0.0/24"]})["result"]["scan"]
    finished(s, scan)
    before = inventory.read_text()
    r = s.call("discover.add", {"scan": scan, "addresses": ["10.0.0.9", "10.0.0.7"]})["result"]
    group = r["group"]
    assert group.startswith("discovered-")
    assert r["added"] == [{"address": "10.0.0.7", "name": "appliance"}, {"address": "10.0.0.9", "name": "db-10-0-0-9"}]
    assert r["backup"]
    text = inventory.read_text()
    assert text.startswith(before.rstrip("\n").split("\n")[0])
    raw = yaml.safe_load(text)["groups"]
    assert raw["lab"] == yaml.safe_load(before)["groups"]["lab"]             # nothing else changed
    assert raw[group]["reviewed"] is False
    hosts = {h["name"]: h for h in s.call("hosts.list")["result"]["hosts"]}
    assert hosts["appliance"]["reviewed"] is False and hosts["appliance"]["ip"] == "10.0.0.7"
    assert "appliance" in s.call("changes.diff")["result"]["diff"]          # a Pending change, not committed
    # the scan says what was added; adding them again is refused
    found = {f["address"]: f for f in s.call("discover.status", {"scan": scan})["result"]["found"]}
    assert found["10.0.0.7"]["added"] == "appliance"
    e = s.call("discover.add", {"scan": scan, "addresses": ["10.0.0.7", "10.0.0.5", "10.0.0.99"]})["error"]
    assert e["code"] == 123 and e["data"]["addresses"] == ["10.0.0.7", "10.0.0.5", "10.0.0.99"]


def test_add_into_a_named_group_and_without_a_git_repo(serve, net, inventory):
    s = serve("-c", str(inventory))
    scan = s.call("discover.start", {"targets": ["10.0.0.0/24"]})["result"]["scan"]
    finished(s, scan)
    r = s.call("discover.add", {"scan": scan, "addresses": ["10.0.0.7"], "group": "lab"})
    assert r["error"]["code"] == 100                                           # a group that's there is taken
    r = s.call("discover.add", {"scan": scan, "addresses": ["10.0.0.7"], "group": "found-today"})["result"]
    assert r["group"] == "found-today"
    (inventory.parent / ".git").rename(inventory.parent / "not-git")    # (git's read-only objects: no rmtree on Windows)
    assert s.call("discover.add", {"scan": scan, "addresses": ["10.0.0.9"]})["error"]["code"] == 70


def test_the_builtin_scanner_when_nmap_isnt_installed(monkeypatch):
    """No nmap: roster's own TCP connect scan, in batches, stoppable. tcp_ok is the stand-in here: nothing connects."""
    open_ = {("10.0.0.7", 443), ("10.0.0.9", 22)}
    monkeypatch.setattr(discover, "tcp_ok", lambda ip, port, timeout=None: (ip, port) in open_)
    monkeypatch.setattr(discover.socket, "gethostbyaddr", lambda ip: (_ for _ in ()).throw(OSError()))
    monkeypatch.setattr(discover.socket, "create_connection", lambda *a, **k: (_ for _ in ()).throw(OSError()))
    scan = discover.Scan("s1", ["10.0.0.0/24"], "22,443", "built-in", {}, set())
    scan.run()
    r = scan.status()
    assert r["state"] == "done" and r["done"] == 254
    assert [(f["address"], [p["port"] for p in f["ports"]]) for f in r["found"]] == [("10.0.0.7", [443]),
                                                                                   ("10.0.0.9", [22])]


def no_network(monkeypatch, open_, banner_wait=0):
    """Stand-ins for the built-in scanner (OPEN_: {(address, port)}): nothing connects. Reading a banner takes
    BANNER_WAIT seconds, then fails."""
    import time
    monkeypatch.setattr(discover, "tcp_ok", lambda ip, port, timeout=None: (ip, port) in open_)
    monkeypatch.setattr(discover.socket, "gethostbyaddr", lambda ip: (_ for _ in ()).throw(OSError()))
    monkeypatch.setattr(discover.socket, "create_connection",
                        lambda *a, **k: time.sleep(banner_wait) or (_ for _ in ()).throw(OSError()))


def builtin_scan_of(monkeypatch, targets, open_):
    """A built-in scan of TARGETS that's over."""
    no_network(monkeypatch, open_)
    scan = discover.Scan("s1", discover.check_targets(targets)[0], "22,443", "built-in", {}, set())
    scan.run()
    return scan


def test_a_scan_of_ipv4_and_ipv6_together_sorts_its_addresses(monkeypatch):
    # review 8 #3: IPv4 and IPv6 addresses don't compare, so sorting them together raised TypeError
    scan = builtin_scan_of(monkeypatch, ["10.0.0.0/30", "fd00::/126"], {("10.0.0.2", 22), ("fd00::2", 22)})
    r = scan.status()
    assert r["state"] == "done" and r["error"] is None
    assert [f["address"] for f in r["found"]] == ["10.0.0.2", "fd00::2"]
    assert [rec["ip"] for rec, _ in scan.picked(["fd00::2", "10.0.0.2"])] == ["10.0.0.2", "fd00::2"]


def test_nmap_scans_ipv6_targets_with_minus_6_and_each_family_on_its_own(serve, net, inventory, isolated):
    # review 8 #2: nmap takes an IPv6 target only with -6 (and then no IPv4 one); without it the scan found nothing
    (net / "v6").mkdir()
    (net / "v6/address").write_text("fd00::7")
    (net / "v6/ports").write_text("22 ssh OpenSSH 9.6\n")
    s = serve("-c", str(inventory))
    r = finished(s, s.call("discover.start", {"targets": ["fd00::/124", "10.0.0.0/28"]})["result"]["scan"])
    assert r["state"] == "done" and r["done"] == r["total"] == 15 + 14
    assert [f["address"] for f in r["found"]] == ["10.0.0.5", "10.0.0.7", "10.0.0.9", "fd00::7"]
    runs = (isolated["home"].parent / "log").read_text().splitlines()
    assert all(("-6" in run.split()) == (":" in run.split()[-1]) for run in runs)   # never both families at once


def test_overlapping_targets_visit_each_address_once(serve, net, inventory):
    # review 8 #5: an address in two targets was scanned twice, found twice under two names, and counted twice
    s = serve("-c", str(inventory))
    plan = s.call("discover.plan", {"targets": ["10.0.0.0/28", "10.0.0.0/24", "10.0.0.7", "10.0.0.0/24"]})["result"]
    assert plan["targets"] == ["10.0.0.0/24"] and plan["addresses"] == 254
    r = finished(s, s.call("discover.start", {"targets": ["10.0.0.7", "10.0.0.0/28"]})["result"]["scan"])
    assert r["targets"] == ["10.0.0.0/28"] and r["done"] == r["total"] == 14
    assert [f["address"] for f in r["found"]] == ["10.0.0.5", "10.0.0.7", "10.0.0.9"]


def test_a_network_or_broadcast_address_named_on_its_own_is_kept():
    # a /24 doesn't visit its network and broadcast addresses, so naming one as well isn't a duplicate
    assert discover.check_targets(["10.0.0.0/24", "10.0.0.255", "10.0.0.8/29"]) == (["10.0.0.0/24", "10.0.0.255"], 255)


def test_quiet_counts_the_hosts_that_answered_with_none_of_the_ports_open(serve, net, inventory):
    # review 8 #6: nmap ran with --open, which leaves such a Host out of its output, so quiet was always 0
    (net / "printer").mkdir()
    (net / "printer/address").write_text("10.0.0.11")
    (net / "printer/ports").write_text("9100 jetdirect\n")
    s = serve("-c", str(inventory))
    r = finished(s, s.call("discover.start", {"targets": ["10.0.0.0/28"], "ports": "22,443"})["result"]["scan"])
    assert r["quiet"] == 1 and [f["address"] for f in r["found"]] == ["10.0.0.5", "10.0.0.7", "10.0.0.9"]


def test_the_builtin_scanner_reads_its_hosts_banners_at_once_not_one_by_one(monkeypatch):
    # review 8 #8: each Host found took its reverse DNS and up to 2 s for its SSH banner in turn, so a batch of 64
    # took minutes, and a stop waited for it
    import time
    no_network(monkeypatch, {(f"10.0.0.{i}", 22) for i in range(1, 21)}, banner_wait=0.2)
    t = time.monotonic()
    scan = discover.Scan("s2", ["10.0.0.0/27"], "22", "built-in", {}, set())
    scan.run()
    assert scan.status()["count"] == 20 and time.monotonic() - t < 2          # one by one: 20 x 0.2 s = 4 s


def test_a_scan_works_out_each_hosts_entry_once(monkeypatch):
    # review 8 #9: each Host found was guessed at three times (scan_entry twice, guess_identity once more)
    calls = []
    guess = discover.guess_identity
    monkeypatch.setattr(discover, "guess_identity", lambda rec: calls.append(rec["ip"]) or guess(rec))
    scan = builtin_scan_of(monkeypatch, ["10.0.0.0/28"], {("10.0.0.7", 443), ("10.0.0.9", 22)})
    assert scan.status()["count"] == 2 and calls == ["10.0.0.7", "10.0.0.9"]


# ---------------------------------------------------------------- the job manager (ticket 101, decision Q112)

def pushed(s, kind, job, until="done", seconds=10):
    """The job.progress notifications for KIND's JOB, once one says UNTIL (asking jobs.list meanwhile, so serve's
    notifications are read)."""
    end = time.monotonic() + seconds
    while True:
        mine = [n["params"] for n in s.notes if n["method"] == "job.progress" and n["params"]["kind"] == kind
                and n["params"]["job"] == job]
        if any(p["state"] == until for p in mine) or time.monotonic() > end:
            return mine
        s.call("jobs.list")
        time.sleep(0.05)


def test_a_scan_is_a_job_that_pushes_its_progress_and_its_end(serve, net, inventory):
    s = serve("-c", str(inventory))
    scan = s.call("discover.start", {"targets": ["10.0.0.0/24"]})["result"]["scan"]
    notes = pushed(s, "discover", scan)
    assert notes[0] == {"kind": "discover", "job": scan, "action": "scan", "state": "running", "done": 0,
                        "total": 254, "at": None}
    assert notes[-1]["state"] == "done" and notes[-1]["done"] == 254
    listed = s.call("jobs.list")["result"]["jobs"]
    assert [(j["kind"], j["job"], j["state"]) for j in listed] == [("discover", scan, "done")]


@pytest.mark.skipif(WINDOWS, reason="stop kills nmap's process; the Windows shim is two")
def test_serve_closing_mid_scan_stops_it_at_once_and_says_so(serve, net, inventory, monkeypatch):
    monkeypatch.setenv("FAKE_NMAP_DELAY", "30")
    s = serve("-c", str(inventory))
    scan = s.call("discover.start", {"targets": ["10.0.0.0/24"]})["result"]["scan"]
    t = time.monotonic()
    code, _, err = s.close()
    assert code == 0 and time.monotonic() - t < 5
    assert f"serve: closing: discover {scan} (scan) stopped" in err


@pytest.mark.skipif(WINDOWS, reason="stop kills nmap's process; the Windows shim is two")
def test_jobs_stop_stops_a_scan_as_discover_stop_does(serve, net, inventory, monkeypatch):
    monkeypatch.setenv("FAKE_NMAP_DELAY", "30")
    s = serve("-c", str(inventory))
    scan = s.call("discover.start", {"targets": ["10.0.0.0/24"]})["result"]["scan"]
    assert s.call("jobs.stop", {"kind": "discover", "job": scan})["result"] == {"kind": "discover", "job": scan,
                                                                               "stopping": True}
    assert finished(s, scan)["state"] == "stopped"
    assert s.call("jobs.stop", {"kind": "discover", "job": scan})["result"]["stopping"] is False
    assert s.call("jobs.stop", {"kind": "discover", "job": True})["error"]["code"] == -32602
