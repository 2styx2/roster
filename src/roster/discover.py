"""Network discovery with nmap (or a built-in scanner) feeding roster.yml."""

import concurrent.futures as cf
import contextlib
import datetime
import io
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import yaml

from . import jsonout
from .common import die, oneline, say, tcp_ok
from .config import find_config, load_config

# ---------------------------------------------------------------- discover (network scan)

DEFAULT_SCAN_PORTS = ("21,22,23,25,53,80,111,135,139,389,443,445,515,631,830,873,1433,1521,2049,2222,"
                      "2375,2376,3000,3306,3389,5000,5432,5601,5900,5985,5986,6379,6443,8000,8006,8080,"
                      "8081,8443,8888,9000,9090,9100,9200,9443,10000,11211,27017")
NETWORK_HINTS = ("cisco", "juniper", "junos", "arista", "ubiquiti", "unifi", "edgeos", "mikrotik", "routeros",
                 "aruba", "fortinet", "fortigate", "pfsense", "opnsense", "netgear", "tp-link", "procurve",
                 "extreme networks", "palo alto", "pan-os", "sonicwall", "meraki", "brocade", "dell emc networking",
                 "vyos", "openwrt", "cumulus", "mellanox", "huawei", "zyxel", "draytek", "watchguard")
BMC_HINTS = ("idrac", "ilo ", "integrated lights-out", "supermicro", "ipmi", "megarac", "bmc", "xclarity")
DB_SERVICES = {"postgresql", "mysql", "ms-sql-s", "oracle-tns", "mongodb", "mongod", "redis", "memcache",
               "elasticsearch", "cassandra", "couchdb"}
WEB_ORDER = ((443, "https"), (8443, "https"), (9443, "https"), (80, "http"), (8080, "http"), (8000, "http"),
             (3000, "http"), (5000, "http"), (8006, "https"), (9090, "http"), (10000, "https"))


def nmap_scan(targets, args):
    """nmap over TARGETS: one run per address family (nmap takes IPv6 targets only with -6, and then no IPv4 ones)."""
    v6 = [t for t in targets if ":" in t]
    v4 = [t for t in targets if ":" not in t]
    return (nmap_run(v4, args) if v4 else []) + (nmap_run(v6, args, ["-6"]) if v6 else [])


def nmap_run(targets, args, family=()):
    # no --open, so a Host that answered with none of the ports open is counted (quiet); with -Pn every address
    # counts as up, so there it's left out (--open)
    cmd = [shutil.which("nmap") or "nmap", "-oX", "-", "-T4", "-sV", "--version-light", "--script", "http-title"]
    cmd += ["--top-ports", str(args.top_ports)] if args.top_ports else ["-p", args.ports]
    if args.no_ping:
        cmd += ["-Pn", "--open"]
    if args.os:
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            cmd.append("-O")
        else:
            say("note         --os needs root (sudo); skipping OS detection")
    cmd += [*family, *targets]
    say(f"nmap         {' '.join(['nmap', *cmd[1:]])}")
    say("             (this can take a few minutes on a big network)")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not r.stdout.strip():
        die(f"nmap failed: {(r.stderr or r.stdout).strip()[:400]}")
    return parse_nmap_xml(r.stdout)


def parse_nmap_xml(text):
    """nmap -oX output -> [{ip, hostname, mac, vendor, os, ports: [{port, name, product, title, ssl}]}]"""
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(text)
    except ET.ParseError as e:
        die(f"couldn't read nmap's output: {e}")
    found = []
    for host in root.findall("host"):
        status = host.find("status")
        if status is None or status.get("state") != "up":
            continue
        rec = {"ip": "", "hostname": "", "mac": "", "vendor": "", "os": "", "ports": []}
        for a in host.findall("address"):
            if a.get("addrtype") in ("ipv4", "ipv6"):
                rec["ip"] = a.get("addr", "")
            elif a.get("addrtype") == "mac":
                rec["mac"], rec["vendor"] = a.get("addr", ""), a.get("vendor", "")
        hn = host.find("hostnames/hostname")
        rec["hostname"] = hn.get("name", "") if hn is not None else ""
        ostypes = []
        for p in host.findall("ports/port"):
            st = p.find("state")
            if st is None or st.get("state") != "open" or p.get("protocol") != "tcp":
                continue
            sv = p.find("service")
            sv = sv.attrib if sv is not None else {}
            title = ""
            for sc in p.findall("script"):
                out = (sc.get("output") or "").strip()
                if sc.get("id") == "http-title" and not out.startswith(("Site doesn't have a title",
                                                                         "Did not follow redirect")):
                    title = out.splitlines()[0][:80] if out else ""
            if sv.get("ostype"):
                ostypes.append(sv["ostype"])
            product = " ".join(x for x in (sv.get("product"), sv.get("version"),
                                           f"({sv['extrainfo']})" if sv.get("extrainfo") else "") if x)
            rec["ports"].append({"port": int(p.get("portid")), "name": sv.get("name", "") or "unknown",
                                 "product": product, "title": title,
                                 "ssl": sv.get("tunnel") == "ssl" or sv.get("name") in ("https", "ssl")})
        osm = host.find("os/osmatch")
        rec["os"] = osm.get("name", "") if osm is not None else (ostypes[0] if ostypes else "")
        if rec["ip"]:
            found.append(rec)
    return found


def address_order(address):
    """A sort key for addresses of both families (IPv4 ones first): ip_address alone can't compare an IPv4 address
    with an IPv6 one."""
    ip = ipaddress.ip_address(address)
    return ip.version, ip


def addresses_of(targets):
    """The addresses a scan of TARGETS visits: each network's hosts (not its network or broadcast address)."""
    nets = [ipaddress.ip_network(t, strict=False) for t in targets]
    return [str(ip) for n in nets for ip in (n.hosts() if n.num_addresses > 2 else n)]


def open_ports_of(ips, ports, timeout):
    """{ip: [open port, ...]} for a plain TCP connect to each of PORTS on each of IPS."""
    found = {}
    with cf.ThreadPoolExecutor(256) as ex:
        pairs = [(ip, p) for ip in ips for p in ports]
        for (ip, p), ok in zip(pairs, ex.map(lambda t: tcp_ok(t[0], t[1], timeout=timeout), pairs), strict=False):
            if ok:
                found.setdefault(ip, []).append(p)
    return found


def describe(ip, open_ports):
    """A scanned address with OPEN_PORTS, as parse_nmap_xml gives one: reverse DNS, and an SSH port's banner."""
    rec = {"ip": ip, "hostname": "", "mac": "", "vendor": "", "os": "", "ports": []}
    try:
        rec["hostname"] = socket.gethostbyaddr(ip)[0]
    except OSError:
        pass
    for p in sorted(open_ports):
        try:
            name = socket.getservbyport(p, "tcp")
        except OSError:
            name = "unknown"
        product = ""
        if p in (22, 2222) or name == "ssh":
            try:
                with socket.create_connection((ip, p), timeout=2) as s:
                    banner = s.recv(200).decode(errors="replace").strip()
                if banner.startswith("SSH-"):
                    name, product = "ssh", banner.split("-", 2)[-1].replace("_", " ")
            except OSError:
                pass
        rec["ports"].append({"port": p, "name": name, "product": product, "title": "",
                             "ssl": p in (443, 8443, 9443, 8006, 10000)})
    return rec


def builtin_scan(targets, args):
    """No nmap: plain TCP connect scan, plus SSH banners and reverse DNS."""
    ips = addresses_of(targets)
    ports = [int(p) for p in args.ports.split(",") if p.strip()]
    say(f"scanning     {len(ips)} addresses x {len(ports)} ports with the built-in scanner "
        "(install nmap for service versions and web page titles)")
    open_ports = open_ports_of(ips, ports, args.timeout)
    with cf.ThreadPoolExecutor(64) as ex:
        return list(ex.map(lambda ip: describe(ip, open_ports[ip]), sorted(open_ports, key=address_order)))


def guess_identity(rec):
    """Best guess at what a scanned box is. Always reviewed by a human before use."""
    names = {p["name"] for p in rec["ports"]}
    nums = {p["port"] for p in rec["ports"]}
    text = " ".join([rec["vendor"], rec["os"], rec["hostname"]]
                    + [p["product"] + " " + p["title"] for p in rec["ports"]]).lower()
    ssh = next((p for p in rec["ports"] if p["name"] == "ssh" and p["port"] == 22), None) \
        or next((p for p in rec["ports"] if p["name"] == "ssh"), None)
    if any(h in text for h in BMC_HINTS):
        kind = "bmc"
    elif any(h in text for h in NETWORK_HINTS) or ("telnet" in names and not ssh) or 830 in nums:
        kind = "network"
    elif "microsoft" in text or "windows" in text or (nums & {3389, 5985, 5986} and not ssh):
        kind = "windows"
    elif names & DB_SERVICES:
        kind = "db"
    elif ssh:
        kind = "server"
    elif names & {"http", "https", "http-proxy", "https-alt", "http-alt"} or nums & {80, 443, 8080, 8443}:
        kind = "appliance"
    else:
        kind = "unknown"
    return kind, ssh


def scan_entry(rec, taken, today):
    kind, ssh = guess_identity(rec)
    base = re.sub(r"[^a-z0-9-]+", "-", rec["hostname"].split(".")[0].lower()).strip("-")
    base = base or f"{kind}-{rec['ip'].replace('.', '-').replace(':', '-')}"
    name, n = base, 2
    while name in taken:
        name, n = f"{base}-{n}", n + 1
    taken.add(name)

    page_title = next((p["title"] for p in rec["ports"] if p["title"]), "")
    entry = {"ip": rec["ip"], "title": page_title, "type": kind}   # web page title is a good first guess
    if ssh and ssh["port"] != 22:
        entry["port"] = ssh["port"]
    # Only plain servers get a key installed by default; switches, BMCs and Windows log in by password.
    entry["enroll"] = bool(ssh) and kind in ("server", "db")
    ports = {p["port"]: p for p in rec["ports"]}
    web = next((f"{'https' if ports[p]['ssl'] or s == 'https' else 'http'}://{rec['ip']}"
                f"{'' if p in (80, 443) else f':{p}'}" for p, s in WEB_ORDER if p in ports), None)
    if web:
        entry["web"] = web
    services = {}
    for p in rec["ports"]:
        if ssh and p["port"] == ssh["port"]:
            continue
        key = re.sub(r"[^a-z0-9_-]", "-", p["name"].lower()) or "port"
        services[key if key not in services else f"{key}-{p['port']}"] = p["port"]
    if services:
        entry["services"] = services

    seen = [f"scan {today}"]
    if rec["os"]:
        seen.append(rec["os"])
    if rec["vendor"]:
        seen.append(f"hw: {rec['vendor']}")
    for p in rec["ports"]:
        bit = f"{p['port']}/{p['name']}" + (f" {p['product']}" if p["product"] else "") \
              + (f" \"{p['title']}\"" if p["title"] else "")
        seen.append(bit)
    entry["description"] = oneline("; ".join(seen))[:400]
    if rec["mac"]:
        entry["mac"] = rec["mac"]
    return name, entry


def yaml_scalar(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    return json.dumps(str(v))          # a JSON string is a valid YAML double-quoted string


def render_group(group, entries, note, needs_user, indent):
    i1, i2, i3, i4 = (" " * (indent * k) for k in (1, 2, 3, 4))
    out = [f"{i1}{group}:",
           f"{i2}title: {yaml_scalar(note)}",
           f"{i2}reviewed: false        # setup ignores these hosts until this says true",
           f"{i2}auth: prompt"]
    if needs_user:
        out.append(f"{i2}user: CHANGE-ME         # login user for these hosts (or set it per host)")
    out.append(f"{i2}hosts:")
    for name, e in entries:
        out.append(f"{i3}{name}:")
        for k, v in e.items():
            if k == "services":
                v = "{ " + ", ".join(f"{sk}: {sv}" for sk, sv in v.items()) + " }"
                out.append(f"{i4}{k}: {v}")
            else:
                hint = "   # guessed - fix if wrong" if k == "type" else ""
                out.append(f"{i4}{k}: {yaml_scalar(v)}{hint}")
    return out


def cmd_discover(args):
    """`roster discover`: scan, then preview (or --write) the new Hosts as a group. With --json, the preview is one
    JSON document (discover.plan's numbers and discover.status's Found records) and say()'s lines are dropped."""
    from .errors import TOO_MANY_ADDRESSES, Problem, inventory_problem
    nets = []
    for t in args.targets:
        try:
            nets.append(ipaddress.ip_network(t, strict=False))
        except ValueError:
            die(f"{t!r} isn't an IP address or network (e.g. 10.0.1.0/24)")
    nets = distinct(nets)                       # an address in two targets is scanned (and written) once
    targets = [str(n) for n in nets]
    total = sum(address_count(n) for n in nets)
    if total > LIMIT and not args.force:
        if args.json:
            raise Problem(TOO_MANY_ADDRESSES, f"that's {total} addresses; a scan visits at most {LIMIT}",
                          fix="narrow it down, or pass --force to scan them all")
        die(f"that's {total} addresses; narrow it down or pass --force")

    cfg_path, cfg = None, None
    if args.config and not Path(args.config).expanduser().exists():
        cfg_path = Path(args.config).expanduser()          # --write will create it
    else:
        try:
            cfg_path = find_config(args.config)
            cfg = load_config(cfg_path)
        except SystemExit as e:
            # a roster.yml that's there but broken is error 1 under --json, found by -c or not; none at all (nothing
            # found, or ROSTER_CONFIG naming no file) is fine: a scan needs no Inventory
            if args.json and (args.config or (cfg_path is not None and cfg_path.expanduser().exists())):
                raise inventory_problem(str(e.code).removeprefix("error: "), cfg_path) from None
            if args.config:
                raise
    known = {h["ip"]: h["name"] for h in cfg["hosts"].values()} if cfg else {}
    taken = set(cfg["hosts"]) if cfg else set()

    use_nmap = not args.builtin and shutil.which("nmap") is not None
    with contextlib.redirect_stdout(io.StringIO()) if args.json else contextlib.nullcontext():
        if not use_nmap and not args.builtin:
            say("note         nmap isn't installed - using the built-in scanner. For service versions,")
            say("             web page titles and hardware vendors: apt install nmap / brew install nmap")
        found = nmap_scan(targets, args) if use_nmap else builtin_scan(targets, args)

    quiet = [r for r in found if not r["ports"]]
    found = sorted((r for r in found if r["ports"]), key=lambda r: address_order(r["ip"]))
    already = [r for r in found if r["ip"] in known]
    new = [r for r in found if r["ip"] not in known]
    today = datetime.date.today().isoformat()
    group = args.group or f"discovered-{today.replace('-', '')}"
    group = unique(group, set(cfg["groups"]) if cfg else set())
    if args.json:
        jsonout.emit({"targets": [str(n) if n.num_addresses > 1 else str(n.network_address) for n in nets],
                      "addresses": total, "ports": args.top_ports or len([p for p in args.ports.split(",") if p.strip()]),
                      "scanner": "nmap" if use_nmap else "built-in", "count": len(found), "quiet": len(quiet),
                      "found": [found_record(r, known, taken, today) for r in found], "group": group})
        return 0
    entries = [scan_entry(r, taken, today) for r in new]
    say(f"\nfound        {len(found)} hosts with open ports: {len(new)} new, {len(already)} already in roster.yml"
        + (f" ({len(quiet)} more answered but had none of the scanned ports open)" if quiet else ""))
    if not entries:
        return 0
    kinds = {}
    for _, e in entries:
        kinds[e["type"]] = kinds.get(e["type"], 0) + 1
    say("guessed      " + ", ".join(f"{k} {v}" for k, v in sorted(kinds.items())))

    note = f"Found by scanning {', '.join(targets)} on {today} - rename, fill in titles, then set reviewed: true"
    needs_user = not _defaults_user(cfg_path)   # the new group inherits only from defaults

    if not args.write:
        say("\n# preview - nothing written. Re-run with --write to add this to roster.yml:\ngroups:")
        say("\n".join(render_group(group, entries, note, needs_user, 2)))
        return 0
    write_discovered(cfg_path, group, entries, note, needs_user, today)
    return 0


def _defaults_user(cfg_path):
    if not cfg_path or not Path(cfg_path).exists():
        return None
    raw = yaml.safe_load(Path(cfg_path).read_text()) or {}
    return (raw.get("defaults") or {}).get("user")


def with_group(text, group, entries, note, needs_user):
    """roster.yml's TEXT with GROUP and its ENTRIES added first under `groups:` (made if there's none)."""
    m = re.search(r"(?m)^groups:[ \t]*(#.*)?$", text)
    if not m:
        if re.search(r"(?m)^groups:", text):
            die("roster.yml has `groups:` written inline (e.g. groups: {}); switch it to block style first")
        text = text.rstrip("\n") + "\n\ngroups:\n"
        m = re.search(r"(?m)^groups:[ \t]*(#.*)?$", text)
    after = text[m.end():]
    child = re.search(r"(?m)^( +)\S", after)
    indent = len(child.group(1)) if child and not after[:child.start()].strip(" \t\n#") else 2
    block = "\n".join(render_group(group, entries, note, needs_user, indent)) + "\n"
    insert_at = m.end() + 1 if text[m.end():m.end() + 1] == "\n" else m.end()
    return text[:insert_at] + ("" if text[insert_at - 1:insert_at] == "\n" else "\n") + block + text[insert_at:]


def write_discovered(cfg_path, group, entries, note, needs_user, today):
    path = Path(cfg_path or "roster.yml").expanduser()
    if path.exists():
        text = path.read_text()
    else:
        text = (f"# roster.yml - started by `roster discover` on {today}. NO PASSWORDS IN THIS FILE.\n"
                "# Every option, with comments:  roster -c example.yml init\n\n"
                "box_name: \"\"\nkey_path: ~/.ssh/roster_ed25519\n\n"
                "defaults:\n  auth: prompt\n\ngroups:\n")
    new_text = with_group(text, group, entries, note, needs_user)

    tmp = path.with_name(path.name + ".new")
    tmp.write_text(new_text)
    try:
        load_config(tmp)                          # refuse to write a file roster can't read back
    except SystemExit as e:
        tmp.unlink()
        die(f"the merged roster.yml didn't validate, nothing written ({e})")
    if path.exists():
        backup = path.with_name(path.name + ".bak")
        backup.write_text(text)
        say(f"backup       {backup}")
    tmp.replace(path)
    say(f"wrote        {len(entries)} hosts into group '{group}' in {path}")
    say(f"next         open {path.name}: rename hosts (e.g. orion-dev-01), add titles/descriptions,")
    say("             set the login user, move hosts into the right groups if you like,")
    say(f"             then set `reviewed: true` and run:  roster setup --only {group}")


# ---------------------------------------------------------------- a scan in roster serve (ticket 44)
# `discover.*` in serve: the scan runs on a thread of its own, a batch of addresses at a time, so it can say how far
# it has got, hand over what it found as it finds it, and stop between batches (nmap is killed mid-batch). The app's
# UI for it is the first-party Plugin plugins/discover, which polls discover.status.

LIMIT = 4096                # addresses a scan may visit without `force` (as `roster discover` without --force)
MAX = 65536                 # ... and with it: a /16
BATCH = {"nmap": 32, "built-in": 64}


class TooMany(ValueError):
    """More addresses than a scan may visit."""

    def __init__(self, count, limit):
        super().__init__(f"that's {count} addresses; at most {limit}")
        self.count, self.limit = count, limit


def address_count(net):
    """How many addresses addresses_of visits in NET, without listing them."""
    n = net.num_addresses
    if n <= 2:
        return n
    return n - 2 if net.version == 4 else n - 1


def covers(m, n):
    """True when network M visits every address network N does (addresses_of): N inside M, and not one of the
    addresses M skips (its network address, and an IPv4 one's broadcast address) named on its own."""
    if n.version != m.version or not n.subnet_of(m):
        return False
    if m.num_addresses <= 2 or n.num_addresses > 2:
        return True
    skipped = {m.network_address} | ({m.broadcast_address} if m.version == 4 else set())
    return not any(ip in skipped for ip in n)


def distinct(nets):
    """NETS without those another one covers, so an address in two of them is visited (and found) once."""
    kept = []
    for n in nets:
        if not any(covers(k, n) for k in kept):
            kept = [k for k in kept if not covers(n, k)] + [n]
    return kept


def check_targets(targets, force=False):
    """TARGETS (a list of networks or addresses) normalised, without those another one covers, and how many
    addresses they hold. ValueError if one isn't a network; TooMany past LIMIT (MAX with FORCE)."""
    if not isinstance(targets, list) or not targets or not all(isinstance(t, str) and t.strip() for t in targets):
        raise ValueError("targets must be a list of networks or addresses, such as [\"10.0.0.0/24\"]")
    nets = []
    for t in targets:
        try:
            nets.append(ipaddress.ip_network(t.strip(), strict=False))
        except ValueError:
            raise ValueError(f"{t!r} isn't an IP address or network (e.g. 10.0.0.0/24)") from None
    nets = distinct(nets)
    count = sum(address_count(n) for n in nets)
    if count > (MAX if force else LIMIT):
        raise TooMany(count, MAX if force else LIMIT)
    return [str(n) if n.num_addresses > 1 else str(n.network_address) for n in nets], count


def check_ports(ports):
    """A port list such as "22,80,443" (DEFAULT_SCAN_PORTS if None), as text nmap takes; ValueError if it isn't."""
    if ports is None:
        return DEFAULT_SCAN_PORTS
    bits = ports.split(",") if isinstance(ports, str) else []
    if not bits or not all(b.strip().isdigit() and 1 <= int(b) <= 65535 for b in bits):
        raise ValueError("ports must be TCP port numbers separated by commas, such as \"22,80,443\"")
    return ",".join(str(int(b)) for b in bits)


def scanner():
    """"nmap" when it's installed, else roster's own "built-in" TCP connect scanner."""
    return "nmap" if shutil.which("nmap") else "built-in"


def batches(ips, step):
    """IPS STEP at a time, each batch of one family: nmap scans IPv6 addresses only with -6, and then no IPv4 ones."""
    for family in (4, 6):
        some = [ip for ip in ips if (":" in ip) == (family == 6)]
        yield from (some[i:i + step] for i in range(0, len(some), step))


class ScanFailed(Exception):
    pass


def unique(base, taken):
    name, n = base, 2
    while name in taken:
        name, n = f"{base}-{n}", n + 1
    return name


class Scan:
    """One scan of TARGETS for PORTS with SCANNER. KNOWN: {address: the Inventory's Host there}; TAKEN: the names in
    use, so each new Host's suggested name is free. run() scans, on whatever thread calls it (serve's job's)."""

    def __init__(self, sid, targets, ports, kind, known, taken, timeout=1.0):
        self.sid, self.targets, self.ports, self.kind = sid, targets, ports, kind
        self.known, self.taken, self.timeout = dict(known), set(taken), timeout
        self.lock = threading.Lock()
        self.halt = threading.Event()
        self.proc = None
        self.state, self.error, self.done, self.quiet = "running", None, 0, 0
        self.total = sum(address_count(ipaddress.ip_network(t, strict=False)) for t in targets)
        self.found = []                         # [(rec, the result's record)], in address order
        self.today = datetime.date.today().isoformat()
        self.on_progress = None                 # fn(done, total) after each batch (serve's job, its job.progress)

    # -- the scan

    def run(self):
        try:
            step = BATCH[self.kind]
            for batch in batches(addresses_of(self.targets), step):
                if self.halt.is_set():
                    break
                recs = self.nmap(batch) if self.kind == "nmap" else self.builtin(batch)
                if self.halt.is_set():
                    break
                made = [self.record(rec) for rec in sorted(recs, key=lambda r: address_order(r["ip"]))]
                with self.lock:                 # held only to hand them over: discover.status waits on it
                    self.found += [x for x in made if x]
                    self.quiet += made.count(None)
                    self.done += len(batch)
                if self.on_progress is not None:
                    self.on_progress(self.done, self.total)
        except ScanFailed as e:
            self.error = str(e)
        except SystemExit as e:                 # parse_nmap_xml's die()
            self.error = str(e.code).removeprefix("error: ")
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"
        with self.lock:
            self.state = "failed" if self.error else "stopped" if self.halt.is_set() else "done"

    def nmap(self, batch):
        # no --open: it only leaves out of the output the Hosts that answered with none of the ports open (quiet)
        cmd = [shutil.which("nmap") or "nmap", "-oX", "-", "-T4", "-sV", "--version-light", "--script", "http-title",
               "-p", self.ports, *(["-6"] if ":" in batch[0] else []), *batch]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if self.halt.is_set():
            self.proc.kill()
        out, err = self.proc.communicate()
        if self.halt.is_set():
            return []
        if self.proc.returncode != 0 or not out.strip():
            raise ScanFailed(f"nmap failed: {(err or out).strip()[:400]}")
        return parse_nmap_xml(out)

    def builtin(self, batch):
        ports = [int(p) for p in self.ports.split(",")]
        open_ports = open_ports_of(batch, ports, self.timeout)
        with cf.ThreadPoolExecutor(64) as ex:          # each Host's reverse DNS and SSH banner (2 s) at once
            return list(ex.map(lambda ip: describe(ip, open_ports[ip]), sorted(open_ports, key=address_order)))

    def record(self, rec):
        """(rec, the result's record) for a Host found, or None for one with none of the ports open (quiet). Only
        the scan's thread calls it (self.taken)."""
        if not rec["ports"]:
            return None
        return rec, found_record(rec, self.known, self.taken, self.today)

    # -- what serve asks

    def stop(self):
        """Stop it: True if it was going."""
        with self.lock:
            if self.state != "running":
                return False
            self.state = "stopping"
        self.halt.set()
        if self.proc is not None and self.proc.poll() is None:
            self.proc.kill()
        return True

    def status(self, since=0):
        with self.lock:
            return {"scan": self.sid, "state": self.state, "targets": self.targets, "scanner": self.kind,
                    "done": self.done, "total": self.total, "count": len(self.found), "quiet": self.quiet,
                    "found": [dict(r) for _, r in self.found[since:]], "error": self.error}

    def picked(self, addresses):
        """[(rec, record)] for ADDRESSES, in the scan's order; ValueError naming those it can't add."""
        with self.lock:
            by = {r["address"]: (rec, r) for rec, r in self.found}
        bad = [a for a in addresses if a not in by or by[a][1]["known"] or by[a][1]["added"]]
        if bad:
            raise ValueError(bad)
        return [by[a] for a in sorted(set(addresses), key=address_order)]

    def mark_added(self, names):
        """NAMES: {address: the name it was added as}."""
        with self.lock:
            for _, r in self.found:
                if r["address"] in names:
                    r["added"] = names[r["address"]]


def found_record(rec, known, taken, today):
    """discover.status's Found for the scan record REC, as serve and `roster discover --json` give it. KNOWN:
    {address: the Inventory's Host there}; a new Host gets the first name not in TAKEN, which is added to it."""
    host = known.get(rec["ip"])
    base, entry = scan_entry(rec, set(), today)
    name = None
    if host is None:
        name = unique(base, taken)
        taken.add(name)
    return {"address": rec["ip"], "name": name, "type": entry["type"], "hostname": rec["hostname"],
            "title": entry["title"], "web": entry.get("web"), "known": host, "added": None, "vendor": rec["vendor"],
            "os": rec["os"], "mac": rec["mac"],
            "ports": [{"port": p["port"], "name": p["name"], "product": p["product"], "title": p["title"]}
                      for p in rec["ports"]]}


def defaults_user(text):
    raw = yaml.safe_load(text) or {}
    return (raw.get("defaults") or {}).get("user") if isinstance(raw, dict) else None


def added_text(text, group, picked, targets, today, taken):
    """roster.yml's TEXT with the PICKED scan results ([(rec, record)]) in a new GROUP, unreviewed, as `roster
    discover --write` writes them. A name in TAKEN gets -2, -3, ... Returns (new text, [{address, name}])."""
    taken = set(taken)
    entries, added = [], []
    for rec, r in picked:
        base, entry = scan_entry(rec, set(), today)
        name = unique(r["name"] or base, taken)
        taken.add(name)
        entries.append((name, entry))
        added.append({"address": rec["ip"], "name": name})
    note = f"Found by scanning {', '.join(targets)} on {today} - rename them, fill in titles, then review them"
    return with_group(text, group, entries, note, not defaults_user(text)), added
