"""Command-line interface:  roster <command>"""

import argparse
import concurrent.futures as cf
import os
import shlex
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from . import __version__, jsonout, mesh
from .claude import write_claude_files
from .common import die, not_reviewed, program_argv, run_instead, say, ssh_config_file, tcp_ok
from .config import access_label, find_config, load_config, matches, selected
from .discover import DEFAULT_SCAN_PORTS, cmd_discover
from .errors import ROSTER_ERROR, UNKNOWN_HOST, Problem, inventory_problem
from .example import EXAMPLE_CONFIG
from .providers import NO_PASSWORD, PROVIDERS, get_secret, setup_providers
from .resources import TYPES, fields, login, summary, wifi_uri
from .sshops import (
    enroll,
    ensure_key,
    password_exec,
    public_key_line,
    record_fingerprints,
    remove_key_script,
    ssh_ok,
    sudo_wrap,
    write_ssh_config,
)
from .web import cmd_web, mask

# ---------------------------------------------------------------- commands

def cmd_init(args):
    path = Path(args.config or "roster.yml").expanduser()
    if path.exists():
        die(f"{path} already exists")
    path.write_text(EXAMPLE_CONFIG)
    say(f"wrote {path} - edit it, then run: roster setup")


def cmd_setup(cfg, args):
    hosts = selected(cfg, args.only)
    waiting = [h for h in hosts if not h["reviewed"]]
    hosts = [h for h in hosts if h["reviewed"]]
    if waiting:
        say(f"skipping     {len(waiting)} hosts with reviewed: false (from discover) - review them in "
            "roster.yml, set reviewed: true, then re-run setup")
    if not hosts:
        return 0
    say(f"roster setup box '{cfg['box']}', {len(hosts)} hosts from {cfg['path']}")
    ensure_key(cfg)
    pub = public_key_line(cfg)
    no_answer = record_fingerprints(cfg, hosts)
    write_ssh_config(cfg)

    key_hosts = [h for h in hosts if h["enroll"] and h["name"] not in no_answer]
    pw_hosts = [h for h in hosts if not h["enroll"]]
    with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
        works = dict(zip([h["name"] for h in key_hosts], ex.map(lambda h: ssh_ok(h["name"]), key_hosts), strict=True))
    todo = [h for h in key_hosts if not works[h["name"]]]
    say(f"key login    {len(key_hosts) - len(todo)} already work, {len(todo)} need the key installed")

    failed = {h["name"]: "no answer on SSH port" for h in hosts if h["name"] in no_answer}
    if args.dry_run:
        for h in todo:
            say(f"  would install key on {h['name']} ({h['user']}@{h['ip']}:{h['port']}, auth {h['auth']})")
        return 0

    for ref, group in sorted({(h["auth"], h["group"]) for h in todo}, key=lambda t: (str(t[0]), t[1])):
        try:
            get_secret(ref, group)          # ask for / fetch passwords up front, one per group
        except RuntimeError as e:
            for h in todo:
                if (h["auth"], h["group"]) == (ref, group):
                    failed[h["name"]] = str(e)
    todo = [h for h in todo if h["name"] not in failed]

    installed = 0
    if todo:
        say(f"installing   key on {len(todo)} hosts...")
        with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
            futs = {ex.submit(enroll, h, pub, cfg["tag_re"]): h for h in todo}
            for f in cf.as_completed(futs):
                h = futs[f]
                try:
                    f.result()
                    installed += 1
                    say(f"  ok    {h['name']}")
                except Exception as e:
                    failed[h["name"]] = str(e)
                    say(f"  FAIL  {h['name']}: {e}")

    write_claude_files(cfg)
    if mesh.graph(cfg)["links"]:
        if args.only:
            say("mesh         not applied with --only (it covers the whole Mesh): run `roster mesh`")
        else:
            say("mesh         applying the Mesh for meshed groups and links (one Host at a time)...")
            failed.update({n: f"mesh: {why}" for n, why in mesh_apply(cfg).items()})
    ready = len(key_hosts) - len(todo) + installed
    say()
    say(f"done         {ready} key hosts ready, {len(pw_hosts)} password-only hosts, {len(failed)} failed")
    if failed:
        say("failed hosts (fix, then re-run setup - hosts that already work are skipped):")
        for name, why in sorted(failed.items()):
            say(f"  {name}: {why}")
    return 1 if failed else 0


def cmd_sync(cfg, args):
    write_ssh_config(cfg)
    write_claude_files(cfg)
    say("note: new hosts still need `roster setup` (it only touches hosts that aren't ready)")
    if mesh.status(cfg)["out_of_date"]:
        say("mesh out of date: roster.yml changed the Mesh since its last apply here - run `roster mesh`")
    return 0


# ---------------------------------------------------------------- the Mesh (ticket 39, decision Q63)

LINK_WORDS = {"ok": "ok", "untested": "ok (port not tested: no nc or bash there)", "unreachable": "UNREACHABLE",
              "no-host-key": "NO HOST KEY", "no-via": "NO LINK TO ITS HOP", "pending": "pending", "skipped": "skipped"}
BROKEN_LINKS = ("unreachable", "no-host-key", "no-via")       # make `roster check` fail


def plural(n, word):
    return f"{n} {word}" + ("" if n == 1 else "s")


def show_mesh(r, drift=False):
    """A plan or an apply as text: the links, what changes where, what's left out, what's unfinished."""
    links = r["links"]
    if not drift:
        say(f"links        {plural(len(links), 'link')} "
            f"({sum(x['kind'] == 'key' for x in links)} key, {sum(x['kind'] == 'password' for x in links)} password)")
        def pair(x):
            return f"{x['from']} -> {x['to']}" + (f" via {x['via']}" if x.get("via") else "")
        width = max((len(pair(x)) for x in links), default=0)
        for x in links:
            word = LINK_WORDS[x["status"]]
            word = "ok (hop not tested)" if x["status"] == "untested" and x.get("via") else word
            why = f" - {x['why']}" if x.get("why") and (x["status"] != "untested" or x.get("via")) else ""
            note = " (ssh asks the person for the password)" if x["kind"] == "password" and x["status"] == "ok" else ""
            say(f"  {pair(x):<{width}} {x['kind']:<9}{word}{note}{why}")
    else:
        for x in links:
            if x["status"] in BROKEN_LINKS:
                say(f"  link {x['from']} -> {x['to']}: {x['why']}")
    changed = [h for h in r["hosts"] if h["changes"]]
    if changed:
        say("mesh drift (on the Hosts, not what roster wrote):" if drift else
            "changes" if r["applied"] else "would change")
        for h in changed:
            say(f"  {h['host']}: {', '.join(h['changes'])}")
    if r["excluded"] and not drift:
        say("left out: " + ", ".join(f"{n} ({why})" for n, why in r["excluded"].items()))
    for w in r["warnings"]:
        say(f"warning: {w}")
    if r["pending"]:
        say(f"pending on {plural(len(r['pending']), 'Host')} (finished by the next `roster mesh` once they answer):")
        for n, why in r["pending"].items():
            say(f"  {n}: {why}")
    warn_cut(r.get("cut_pending") or {})


def warn_cut(cut):
    for host, peers in cut.items():
        print(f"WARNING: CUT PENDING ON {plural(len(peers), 'HOST').upper()}: {', '.join(peers)} - {host}'s cut isn't "
              "finished there; `roster mesh cut " + host + "` again, or `roster mesh`, once they answer",
              file=sys.stderr, flush=True)
        say(f"cut pending on {plural(len(peers), 'Host')} for {host}: {', '.join(peers)}")


def mesh_apply(cfg):
    r = mesh.run(cfg, apply=True, say=say)
    show_mesh(r)
    return r["pending"]


def cmd_mesh(cfg, args):
    from .errors import Problem
    if args.action == "status":
        st = mesh.status(cfg)
        if args.json:
            jsonout.emit(st)
            return 0
        for n in st["members"]:
            say(f"  {n:<16} can reach {plural(st['reach'].get(n, 0), 'Host')}")
        if st["pending"]:
            say(f"pending on {plural(len(st['pending']), 'Host')}: {', '.join(st['pending'])}")
        warn_cut(st["cut_pending"])
        say("mesh out of date: run `roster mesh`" if st["out_of_date"] else "mesh up to date")
        return 0
    if args.action == "cut":
        if not args.target:
            die("usage: roster mesh cut HOST")
        if args.target not in cfg["hosts"]:
            die(f"unknown host {args.target!r} (see `roster hosts`)")
        if not args.yes:
            ans = input(f"Cut {args.target} out of the Mesh now, on every Host at once? [y/N] ")
            if ans.strip().lower() != "y":
                return 1
        r = mesh.cut(cfg, args.target, cfg["workers"])
        change = mesh.write_cut(cfg, args.target)
        say(f"cut {args.target}: confirmed on {', '.join(r['confirmed']) or 'no Host'}")
        if change.get("written"):
            say(f"roster.yml   mesh: false for {args.target}, a Pending change (publish it so the cut stays)")
        say(f"note: {change['note']}") if change.get("note") else None
        if change.get("error"):
            say(f"warning: mesh: false not written: {change['error']} - {change['fix']}")
        for n, why in r["pending"].items():
            say(f"  not confirmed  {n}: {why}")
        for w in r["warnings"]:
            say(f"warning: {w}")
        warn_cut({args.target: sorted(r["pending"])} if r["pending"] else {})
        return 1 if r["pending"] or change.get("error") else 0
    if args.target:
        die(f"unexpected {args.target!r}: roster mesh [--dry-run] [--rotate HOST], or roster mesh cut HOST")
    if args.json:                       # --dry-run: mesh.plan's result; a Problem is the JSON error (main)
        r = mesh.run(cfg, apply=False, rotate=args.rotate or ())
        jsonout.emit(r)
        return 1 if r["pending"] else 0
    try:
        r = mesh.run(cfg, apply=not args.dry_run, rotate=args.rotate or (), say=say)
    except Problem as e:
        die(e.message)
    show_mesh(r)
    if args.dry_run:
        say("dry run: nothing was changed")
    elif r["already"]:
        say("already in the mesh: nothing to change")
    return 1 if r["pending"] else 0


def cmd_check(cfg, args):
    hosts = selected(cfg, args.only)
    if not args.json:
        warn_problems(hosts)

    def check(h):
        res = {"ssh": ssh_ok(h["name"]) if h["enroll"] else tcp_ok(h["ip"], h["ssh"]["port"])}
        for name, s in h["services"].items():
            res[name] = tcp_ok(urlparse(s["url"]).hostname if s["url"] else h["ip"], s["port"])
        return h, res

    if args.json:
        with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
            results = [{"name": h["name"], "ok": all(res.values()), "ssh": "login" if h["enroll"] else "port",
                        "checks": res} for h, res in ex.map(check, hosts)]
        drift = mesh.drift(cfg) if not args.only else None
        broken = drift is not None and bool(drift["pending"] or any(h["changes"] for h in drift["hosts"])
                                            or any(x["status"] in BROKEN_LINKS for x in drift["links"]))
        ok = all(r["ok"] for r in results) and not broken
        jsonout.emit({"hosts": results, "mesh": drift, "ok": ok})
        return 0 if ok else 1
    bad = 0
    width = max(len(h["name"]) for h in hosts)
    with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
        for h, res in sorted(ex.map(check, hosts), key=lambda r: r[0]["name"]):
            line = "  ".join(f"{k}:{'ok' if v else 'FAIL'}" for k, v in res.items())
            bad += not all(res.values())
            say(f"{h['name']:<{width}}  {line}")
    say(f"\n{len(hosts) - bad}/{len(hosts)} hosts fully reachable"
        + ("" if all(h["enroll"] for h in hosts) else "  (password-only hosts: ssh = port open)"))
    drift = mesh.drift(cfg) if not args.only else None
    if drift is not None:
        say()
        show_mesh(drift, drift=True)
        bad += bool(drift["pending"] or any(h["changes"] for h in drift["hosts"])
                    or any(x["status"] in BROKEN_LINKS for x in drift["links"]))
        if drift["already"]:
            say("mesh         every Host holds what roster wrote")
    return 1 if bad else 0


def cmd_check_host(args):
    """`roster check HOST`: why a Session to HOST would or wouldn't open, step by step (as host.check).
    It loads roster.yml itself, so a broken one is the first failed step rather than an exit."""
    from . import askpass, diagnose
    from .errors import inventory_problem

    def inventory():
        path = None
        try:
            path = find_config(args.config)
            cfg = load_config(path)
            setup_providers(cfg)
            return cfg
        except SystemExit as e:
            raise inventory_problem(str(e.code).removeprefix("error: "), path) from None

    with askpass.Channel(diagnose.askpass_lookup) as channel:
        result = diagnose.check_host(args.host, inventory, channel)
    if args.json:
        jsonout.emit(result)
        return 0 if result["ok"] else 1
    words = {"ok": "ok", "fail": "FAIL", "skipped": "skip"}
    width = max(len(s["step"]) for s in result["steps"])
    for s in result["steps"]:
        code = f"[{s['code']}] " if "code" in s else ""
        say(f"{words[s['status']]:<4} {s['step']:<{width}}  {code}{s['message']}")
        if s.get("fix"):
            say(f"     {'':<{width}}  fix: {s['fix']}")
        for line in (s.get("details") or "").splitlines():
            say(f"     {'':<{width}}  | {line}")
    return 0 if result["ok"] else 1


def cmd_check_box(args):
    """`roster check --box`: this Box's health, a section at a time (as serve's box.check). Nothing connects."""
    from . import askpass, diagnose, health

    path = cfg = error = None
    try:
        path = find_config(args.config)
        cfg = load_config(path)
        setup_providers(cfg)
    except SystemExit as e:
        error = str(e.code).removeprefix("error: ")
    try:
        with askpass.Channel(diagnose.askpass_lookup) as ch:
            channel = health.askpass_state(ch)
    except OSError as e:
        channel = health.askpass_state(None, e)
    checks = health.check_box(path, cfg, error, channel)
    errors = sum(c["level"] == "error" for c in checks)
    if args.json:
        jsonout.emit({"checks": checks, "ok": not errors})
        return 1 if errors else 0
    section = None
    for c in checks:
        if c["section"] != section:
            say(("" if section is None else "\n") + health.SECTIONS.get(c["section"], c["section"]))
            section = c["section"]
        say(f"  {c['level']:<5}  {c['message']}")
        if c.get("fix"):
            say(f"         fix: {c['fix']}")
        if c.get("topic"):
            say(f"         help: {c['topic']}")
    warnings = sum(c["level"] == "warn" for c in checks)
    words = [f"{warnings} warning{'' if warnings == 1 else 's'}"] if warnings else []
    words.append(f"{errors} error{'' if errors == 1 else 's'}" if errors else "no errors")
    say("\n" + ", ".join(words))
    return 1 if errors else 0


def logins_label(h):
    """What a person can use on a host, short: 'ssh (key), web (admin), api'."""
    if not h["reviewed"]:
        return "unreviewed"
    no_ssh = h["ssh"]["user"] in ("", "CHANGE-ME")    # discover's placeholder: no SSH login set yet
    parts, seen = [] if no_ssh else [f"ssh ({access_label(h)})"], set()
    for name, s in h["services"].items():
        if not s["url"]:
            continue                                   # a bare port: nothing to log in to
        own = s["override"] or s["login"] not in ("basic", "none")
        label = name if own else "web"
        if label in seen or (label == "web" and any(x.startswith("web") for x in seen)):
            continue
        seen.add(label)
        user = s["user"] if s["user"] not in ("", "CHANGE-ME", h["ssh"]["user"]) else ""
        parts.append(f"{label} ({user})" if user else label)
    return ", ".join(parts)


def warn_problems(hosts):
    """Service entries roster left out of the Inventory (bad port, url, login...), on stderr: the rest still works."""
    for h in sorted(hosts, key=lambda h: h["name"]):
        for p in h["problems"]:
            print(f"warning: {h['name']} {p['message']} - left out\n         fix: {p['fix']}", file=sys.stderr,
                  flush=True)


def cmd_hosts(cfg, args):
    hosts, rs = selected(cfg, args.only, resources=True)
    if args.json:
        return hosts_json(cfg, args, hosts, rs)
    warn_problems(hosts)
    if args.find:
        hosts = [h for h in hosts if matches(h, args.find)]
        rs = [r for r in rs if resource_matches(r, args.find)]
        if not hosts and not rs:
            say(f"no host matches {args.find!r} (searched name, title, description, type, product, group, ip)")
            return 1
    hosts = sorted(hosts, key=lambda h: (h["group"], h["name"]))
    if args.long:
        rows = [("NAME", "TITLE", "TYPE", "PRODUCT", "ADDRESS", "ACCESS", "WEB", "DESCRIPTION")]
        rows += [(h["name"], h["title"] or "-", h["type"] or "-", h["product"] or "-",
                  f"{h['user']}@{h['ip']}:{h['port']}", access_label(h), h["web"] or "-", h["description"])
                 for h in hosts]
        _table(rows)
        return 0
    hidden = []
    if not (args.all or args.find or args.only):
        hidden = [h for h in hosts if not h["reviewed"]]
        hosts = [h for h in hosts if h["reviewed"]]
    rows = [("NAME", "IP", "USER", "LOGINS", "TITLE")]
    rows += [(h["name"], h["ip"] if h["ssh"]["port"] == 22 else f"{h['ip']}:{h['ssh']['port']}",
              h["ssh"]["user"] if h["ssh"]["user"] not in ("", "CHANGE-ME") else "-",
              logins_label(h) or "-", h["title"] or "-") for h in hosts]
    rows += [(r["name"], "-", r["user"] or "-", r["type"], r["title"] or "-")
             for r in sorted(rs, key=lambda r: (r["type"], r["name"]))]
    _table(rows)
    if hidden:
        say(f"\n{len(hidden)} unreviewed hosts not shown (roster hosts --all). "
            "roster hosts --long shows type, web URL and description.")
    return 0


def hosts_json(cfg, args, hosts, rs):
    """`roster hosts --json`: serve's hosts.list for the same filters. Hosts and resources in roster.yml order;
    each Host's `problems` stand in for the warnings the table prints on stderr."""
    if args.find:
        hosts = [h for h in hosts if matches(h, args.find)]
        rs = [r for r in rs if resource_matches(r, args.find)]
    hidden = [] if args.all or args.find or args.only else [h for h in hosts if not h["reviewed"]]
    jsonout.emit({"hosts": [h for h in hosts if h not in hidden], "resources": rs, "groups": cfg["groups"],
                  "hidden": len(hidden)})
    return 1 if args.find and not hosts and not rs else 0


def _table(rows):
    widths = [max(len(r[i]) for r in rows) for i in range(len(rows[0]) - 1)]
    for r in rows:
        say("  ".join(c.ljust(w) for c, w in zip(r, widths, strict=False)) + "  " + r[-1])


def find_host(cfg, words, resources=False):
    """The host (or, with resources=True, the resource) named by words: exact name, else the one match."""
    name = " ".join(words)
    pool = {**cfg["hosts"], **(cfg["resources"] if resources else {})}
    h = pool.get(name)
    found = [x for x in pool.values() if (matches if "ip" in x else resource_matches)(x, name)]
    if not h and len(found) == 1:
        h = found[0]                       # "info core switch" -> the one host that matches
    if not h:
        found = [x["name"] for x in found]
        what = "host or resource" if resources else "host"
        die(f"unknown {what} {name!r}" + (f" - did you mean: {', '.join(found[:10])}" if found else ""))
    return h


def resource_matches(r, text):
    """Every word appears in one of the resource's fields: 'guest wifi', 'lab'."""
    hay = " ".join(str(v) for _, v in fields(r)).lower()
    words = [w for w in text.lower().replace("_", " ").replace("-", " ").split() if w]
    return bool(words) and all(w in hay for w in words)


def cmd_resources(cfg, args):
    rs = sorted(cfg["resources"].values(), key=lambda r: (r["type"], r["name"]))
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        rs = [r for r in rs if wanted & {r["name"], r["type"], r["group"]}]     # unlike hosts, no match isn't fatal
    if args.find:
        rs = [r for r in rs if resource_matches(r, args.find)]
    if args.json:
        jsonout.emit({"resources": rs})
        return 1 if cfg["resources"] and not rs else 0
    if not rs:
        if cfg["resources"]:
            say("no resource matches")
            return 1
        say("no resources in roster.yml. Types you can add under `resources:`:")
        for kind, spec in TYPES.items():
            say(f"  {kind:<8} {spec['help']}")
        return 0
    rows = [("NAME", "TYPE", "GROUP", "DETAILS", "LOGIN", "TITLE")]
    rows += [(r["name"], r["type"], r["group"] or "-", summary(r) or "-", login(r), r["title"] or r["description"])
             for r in rs]
    widths = [max(len(r[i]) for r in rows) for i in range(len(rows[0]) - 1)]
    for r in rows:
        say("  ".join(c.ljust(w) for c, w in zip(r, widths, strict=False)) + "  " + r[-1])
    return 0


def show_resource(cfg, r):
    for label, v in fields(r):
        if label == "group" and v:
            g = cfg["groups"].get(v, {})
            v += f" ({g['title']})" if g.get("title") else ""
        say(f"{label:<12} {v if v != '' else '-'}")
    say(f"{'secret':<12} " + (f"roster reveal {r['name']}" if r["auth"] else "none"))
    return 0


def cmd_reveal(cfg, args):
    r = cfg["resources"].get(args.name)
    if not r:
        die(f"unknown resource {args.name!r} (see `roster resources`)")
    if args.wifi and r["type"] != "wifi":
        die(f"{r['name']} is a {r['type']}, not wifi")
    secret = ""
    if r["auth"]:
        try:
            secret = get_secret(r["auth"], r["group"] or "resources")
        except RuntimeError as e:
            die(f"{r['name']}: {e}")
    say(wifi_uri(r, secret) if args.wifi else secret)
    return 0


def cmd_info(cfg, args):
    h = find_host(cfg, args.host, resources=True)
    if args.json:
        g = cfg["groups"].get(h["group"], {})
        group = {"name": h["group"], "title": g.get("title", ""), "description": g.get("description", "")} \
            if h["group"] else None
        jsonout.emit({"host" if "ip" in h else "resource": h, "group": group})
        return 0
    if "ip" not in h:
        return show_resource(cfg, h)
    g = cfg["groups"].get(h["group"], {})
    fields = [("name", h["name"]), ("title", h["title"]), ("description", h["description"]),
              ("type", h["type"]), ("product", h["product"]),
              ("group", h["group"] + (f" ({g['title']})" if g.get("title") else "")),
              ("address", f"{h['user']}@{h['ip']}:{h['port']}"),
              ("access", "not set up yet (reviewed: false)" if not h["reviewed"] else
               "key: ssh " + h["name"] if h["enroll"] else f"password: roster run {h['name']} -- CMD"),
              ("mac", h["mac"]),
              ("ssh login", login_label(h["ssh"])),
              ("login", login_label(h["login"]) + " (default for services)" if any(h["login"].values()) else ""),
              ("web UI", h["web"])]
    for k, v in fields:
        if v:
            say(f"{k:<12} {v}")
    rows = [(name, str(s["port"]), s["url"] or "-",
             login_label(s) + (" (own login)" if s["override"] else " (host default)" if s["auth"] or s["user"]
                               else "")) for name, s in h["services"].items()]
    widths = [max(len(r[i]) for r in rows) for i in range(3)] if rows else []
    for i, r in enumerate(rows):
        say(f"{'services' if i == 0 else '':<12} " + "  ".join(c.ljust(w) for c, w in zip(r, widths, strict=False))
            + "  " + r[-1])
    for i, p in enumerate(h["problems"]):
        say(f"{'problems' if i == 0 else '':<12} {p['message']} - left out; fix: {p['fix']}")
    return 0


def login_label(s):
    """Who logs in and where the password comes from - the reference only, never a value."""
    if not s.get("user") and not s.get("auth"):
        return "no login"
    return f"{s.get('user') or '(no user)'}, auth {s.get('auth') or 'none'}"


def cmd_run(cfg, args):
    h = cfg["hosts"].get(args.host)
    if not h:
        die(f"unknown host {args.host!r} (see `roster hosts`)")
    words = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not words:
        die("nothing to run: roster run HOST -- COMMAND")
    command = " ".join(words)
    if not h["reviewed"]:
        die(not_reviewed(h))
    if args.sudo:
        return run_sudo(h, command)
    if h["enroll"]:
        return run_instead(["ssh", "-o", "BatchMode=yes", h["name"], command])
    try:
        rc, out, err = password_exec(h, command, get_secret(h["ssh"]["auth"], h["group"]))
    except RuntimeError as e:
        die(f"{h['name']}: {e}")
    sys.stdout.write(out)
    sys.stderr.write(err)
    if words[0] == "sudo" and rc != 0 and ("password is required" in err or "terminal is required" in err):
        print(f"hint: sudo wants a password - use  roster run --sudo {h['name']} -- {' '.join(words[1:])}",
              file=sys.stderr)
    return rc if rc >= 0 else 1


def run_sudo(h, command):
    """Run COMMAND as root: sudo gets the host's login password on stdin, never on screen."""
    try:
        secret = get_secret(h["ssh"]["auth"], h["group"])
    except RuntimeError as e:
        die(f"{h['name']}: {e}")
    if not secret:
        die(f"{h['name']}: --sudo needs the login's password, but its auth is {h['ssh']['auth']!r} "
            "(set auth: to the vault item that holds the password)")
    wrapped = sudo_wrap(command)
    if h["enroll"]:
        # bytes: text mode on Windows would send "password\r\n", and sudo would take the "\r" as part of it
        r = subprocess.run(program_argv(["ssh", "-o", "BatchMode=yes", h["name"], wrapped]),
                           input=(secret + "\n").encode(), capture_output=True)
        rc, out, err = r.returncode, r.stdout.decode(errors="replace"), r.stderr.decode(errors="replace")
    else:
        try:
            rc, out, err = password_exec(h, wrapped, secret, stdin=secret + "\n")
        except RuntimeError as e:
            die(f"{h['name']}: {mask(str(e), [secret])}")
    sys.stdout.write(mask(out, [secret]))
    sys.stderr.write(mask(err, [secret]))
    if "incorrect password" in err or "no password was provided" in err:
        print(f"{h['name']}: sudo refused the password from {h['ssh']['auth']} - "
              f"is {h['ssh']['user']} allowed to sudo there?", file=sys.stderr)
    return rc if rc >= 0 else 1


def cmd_revoke(cfg, args):
    hosts = [h for h in selected(cfg, args.only) if h["enroll"]]
    if not args.yes:
        ans = input(f"Remove key '{cfg['tag']}' from {len(hosts)} hosts? This box loses access. [y/N] ")
        if ans.strip().lower() != "y":
            return 1
    script = "sh -c " + shlex.quote(remove_key_script(cfg["tag_re"]))

    def revoke(h):
        r = subprocess.run(program_argv(["ssh", "-o", "BatchMode=yes", h["name"], script]),
                           stdin=subprocess.DEVNULL, capture_output=True, text=True)
        subprocess.run(program_argv(["ssh", "-O", "exit", h["name"]]), capture_output=True)  # drop cached connection
        return h, "ROSTER_OK" in r.stdout

    bad = 0
    with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
        for h, ok in ex.map(revoke, hosts):
            bad += not ok
            say(f"  {'ok  ' if ok else 'FAIL'}  {h['name']}")
    say(f"\nremoved from {len(hosts) - bad}/{len(hosts)} hosts. "
        f"To finish, delete {cfg['key']}, {cfg['pub']} and {ssh_config_file()} on this box.")
    return 1 if bad else 0


AGENT_HELP = "no password: an SSH key you already have (ssh-agent) gets in"


def cmd_providers(cfg, args):
    import shutil
    used = {}
    for h in (cfg or {}).get("hosts", {}).values():
        for ref in {h["ssh"]["auth"], *(s["auth"] for s in h["services"].values())} - {None}:
            used.setdefault(ref.split(":", 1)[0], set()).add(h["group"])
    for r in (cfg or {}).get("resources", {}).values():
        if r["auth"]:
            used.setdefault(r["auth"].split(":", 1)[0], set()).add(r["group"] or "resources")
    unknown = sorted(set(used) - set(PROVIDERS) - set(NO_PASSWORD))
    if args.json:
        rows = [{"name": name, "kind": PROVIDERS[name]["kind"], "help": PROVIDERS[name]["help"],
                 "tool": PROVIDERS[name].get("tool") or None,
                 "installed": bool(shutil.which(PROVIDERS[name]["tool"])) if PROVIDERS[name].get("tool") else None,
                 "used_by": sorted(used.get(name, ()))} for name in sorted(PROVIDERS)]
        rows.append({"name": "agent", "kind": "built-in", "help": AGENT_HELP, "tool": None, "installed": None,
                     "used_by": sorted(used.get("agent", ()))})
        jsonout.emit({"providers": rows, "unknown": unknown, "ok": not unknown})
        return 1 if unknown else 0
    say("password providers (use as  auth: NAME:SPEC  in roster.yml):\n")
    for name in sorted(PROVIDERS):
        p = PROVIDERS[name]
        tool = p.get("tool") or ""
        installed = "" if not tool else ("  [tool found]" if shutil.which(tool) else f"  [`{tool}` NOT installed]")
        groups = f"  - used by: {', '.join(sorted(used[name]))}" if name in used else ""
        say(f"  {name:<8} {p['kind']:<10} {p['help']}{installed}{groups}")
    say(f"  {'agent':<8} {'built-in':<10} {AGENT_HELP}")
    if unknown:
        say(f"\nUNKNOWN providers used in roster.yml: {', '.join(unknown)}")
        return 1
    return 0


def cmd_auth_check(cfg, args):
    uses = {}                                    # (ref, group) -> [(service, host, user)]
    hosts, resources = selected(cfg, args.only, resources=True)
    if not args.json:
        warn_problems(hosts)
    for h in hosts:
        for svc, s in [("ssh", h["ssh"]), *h["services"].items()]:
            if svc == "ssh" or s["auth"] is not None:
                uses.setdefault((s["auth"], h["group"]), []).append((svc, h["name"], s["user"]))
    for r in resources:
        if r["auth"]:
            uses.setdefault((r["auth"], r["group"] or "resources"), []).append((r["type"], r["name"], r["user"]))
    if args.json:
        return auth_check_json(uses)
    bad = 0
    for ref, group in sorted(uses, key=lambda t: (t[1], str(t[0]))):
        users = sorted({u for _, _, u in uses[ref, group] if u})
        label = f"{group:<16} {str(ref):<36} users: {', '.join(users) or '-'}  for: {used_for(uses[ref, group])}"
        if ref == "prompt":
            say(f"  ask   {label}  (asked when setup runs)")
            continue
        try:
            get_secret(ref, group)
            say(f"  ok    {label}")
        except RuntimeError as e:
            bad += 1
            say(f"  FAIL  {label}\n        {e}")
    say("\nok = a value was found. It is not tested against any host here; `setup` does that.")
    return 1 if bad else 0


def auth_check_json(uses):
    """`roster auth-check --json`: one row per (Login reference, group), never the value it found."""
    rows = []
    for ref, group in sorted(uses, key=lambda t: (t[1], str(t[0]))):
        by_svc = {}
        for svc, host, _ in uses[ref, group]:
            by_svc.setdefault(svc, []).append(host)
        row = {"group": group, "auth": ref, "users": sorted({u for _, _, u in uses[ref, group] if u}),
               "used_for": [{"service": svc, "hosts": hs} for svc, hs in by_svc.items()], "status": "ok"}
        if ref == "prompt":
            row["status"] = "ask"
        else:
            try:
                get_secret(ref, group)
            except RuntimeError as e:
                row |= {"status": "fail", "error": str(e)}
        rows.append(row)
    ok = all(r["status"] != "fail" for r in rows)
    jsonout.emit({"logins": rows, "ok": ok})
    return 0 if ok else 1


def used_for(uses):
    """'ssh (12 hosts), https (orion3)' - which services on which hosts use one password source."""
    by_svc = {}
    for svc, host, _ in uses:
        by_svc.setdefault(svc, []).append(host)
    return ", ".join(f"{svc} ({hs[0] if len(hs) == 1 else f'{len(hs)} hosts'})" for svc, hs in by_svc.items())


def cmd_bw(args):
    """The Bitwarden CLI with this box's vault session (~/.config/roster/bw-session), so scripts and
    Claude sessions don't each carry BW_SESSION around. Never prompts: --nointeraction is added."""
    from .providers.bitwarden import load_session_file
    argv = args.args[1:] if args.args[:1] == ["--"] else list(args.args)
    if not argv:
        die("usage: roster bw <bw arguments>   e.g.  roster bw list items --search proxmox")
    load_session_file()
    if "--nointeraction" not in argv:
        argv.append("--nointeraction")
    try:
        return subprocess.run(program_argv(["bw", *argv])).returncode
    except ValueError as e:
        die(str(e))
    except FileNotFoundError:
        die("bw (the Bitwarden CLI) isn't installed")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    words = argv[:argv.index("--")] if "--" in argv else argv
    Parser.json_errors = "--json" in words
    try:
        return _main(argv) or 0
    except Problem as e:                 # inventory() raises one with --json: the error as JSON on stderr
        if not Parser.json_errors:
            raise
        jsonout.fail(e.code, e.message, e.fix)
        return 1
    except SystemExit as e:
        if not (Parser.json_errors and isinstance(e.code, str)):
            raise
        message = e.code.removeprefix("error: ")
        jsonout.fail(UNKNOWN_HOST if message.startswith("unknown host") else ROSTER_ERROR, message)
        return 1
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:              # output piped into head/grep that closed early
        sys.stdout = None
        os._exit(0)
    finally:
        Parser.json_errors = False


class Parser(argparse.ArgumentParser):
    """roster's argument parser: with --json on the command line, a usage error is JSON on stderr (exit 2)."""
    json_errors = False

    def error(self, message):
        if Parser.json_errors:
            jsonout.fail(ROSTER_ERROR, f"{self.prog}: {message}", f"see `{self.prog} --help`")
            sys.exit(2)
        super().error(message)


def build_parser():
    """Every command and option. The man page (roster.manpage) is generated from this too."""
    p = Parser(prog="roster",
               description="Give this box (and Claude) access to the hosts in roster.yml.")
    p.add_argument("--version", action="version", version=f"roster {__version__}")
    p.add_argument("-c", "--config", metavar="PATH", help="path to roster.yml (default: $ROSTER_CONFIG, ./roster.yml, then ~/.config/roster/roster.yml)")
    sub = p.add_subparsers(dest="cmd", required=True)
    only = {"metavar": "LIST", "help": "only these hosts, groups, types or products (comma-separated)"}
    as_json = {"action": "store_true", "help": "print JSON for scripts and tools, never a secret (see "
               "Machine-readable output in docs/cli-reference.md)"}
    sub.add_parser("init", help="write an example roster.yml")
    s = sub.add_parser("setup", help="one-time setup of this box")
    s.add_argument("--only", **only)
    s.add_argument("--dry-run", action="store_true", help="show what would happen, change nothing remote")
    sub.add_parser("sync", help="rewrite ssh config and Claude files from roster.yml")
    s = sub.add_parser("check", help="test reachability; with HOST, why a Session to it would fail, step by step; "
                       "with --box, this Box's health")
    s.add_argument("host", nargs="?", help="diagnose this one Host: inventory, ssh config, vault, DNS, port, "
                   "host key, login (one connection)")
    s.add_argument("--box", action="store_true", help="check this Box instead, without connecting anywhere: "
                   "roster.yml, ssh and its config, vault CLIs, askpass, the infra repo")
    s.add_argument("--only", **only)
    s.add_argument("--json", **as_json)
    s = sub.add_parser("hosts", help="list hosts")
    s.add_argument("--only", **only)
    s.add_argument("--find", metavar="TEXT", help="search name, title, description, type, product, group, ip")
    s.add_argument("--all", action="store_true", help="include unreviewed (scanned) hosts")
    s.add_argument("--long", action="store_true", help="full table: type, product, web URL, description")
    s.add_argument("--json", **as_json)
    s = sub.add_parser("resources", help="list Wi-Fi networks, accounts and secrets that aren't hosts")
    s.add_argument("--only", metavar="LIST", help="resource names, types or groups")
    s.add_argument("--find", metavar="TEXT", help="search every field")
    s.add_argument("--json", **as_json)
    s = sub.add_parser("reveal", help="print a resource's secret (e.g. a Wi-Fi password) - for people, not Claude")
    s.add_argument("name", help="the resource")
    s.add_argument("--wifi", action="store_true", help="print a WIFI:... string for a QR code instead")
    s = sub.add_parser("info", help="show everything about one host or resource")
    s.add_argument("host", nargs="+", metavar="NAME", help="a host or resource; fuzzy words work")
    s.add_argument("--json", **as_json)
    s = sub.add_parser("run", help="run a command on a host")
    s.add_argument("--sudo", action="store_true",
                   help="run it as root with sudo; roster gives sudo the login's password (never shown)")
    s.add_argument("host", help="the host to run it on")
    s.add_argument("command", nargs=argparse.REMAINDER, help="the command, after --")
    s = sub.add_parser("discover", help="scan networks (nmap if installed) and add what's found to roster.yml")
    s.add_argument("targets", nargs="+", metavar="CIDR", help="e.g. 10.0.1.0/24 (several allowed)")
    s.add_argument("--write", action="store_true", help="add new hosts to roster.yml (default: preview only)")
    s.add_argument("--group", metavar="NAME", help="group name for new hosts (default: discovered-YYYYMMDD)")
    s.add_argument("--ports", default=DEFAULT_SCAN_PORTS, help="TCP ports to scan (default: common server, "
                   "web, database, remote-admin and network-gear ports)")
    s.add_argument("--top-ports", type=int, metavar="N", help="nmap only: scan nmap's N most common ports instead")
    s.add_argument("--no-ping", action="store_true", help="nmap only: scan hosts that don't answer ping (slower)")
    s.add_argument("--os", action="store_true", help="nmap only: OS detection (needs sudo)")
    s.add_argument("--builtin", action="store_true", help="use the built-in scanner even if nmap is installed")
    s.add_argument("--timeout", type=float, default=0.5, metavar="SECONDS",
                   help="built-in scanner connect timeout (default: 0.5)")
    s.add_argument("--force", action="store_true", help="allow scanning more than 4096 addresses")
    s.add_argument("--json", **as_json)
    s = sub.add_parser("bw", help="run the Bitwarden CLI with this box's vault session (bw-session file)")
    s.add_argument("args", nargs=argparse.REMAINDER, metavar="BW_ARGS", help="arguments for bw")
    s = sub.add_parser("providers", help="list password providers (built-in, plugins, roster.yml)")
    s.add_argument("--json", **as_json)
    s = sub.add_parser("auth-check", help="test each group's password source, print nothing secret")
    s.add_argument("--only", **only)
    s.add_argument("--json", **as_json)
    s = sub.add_parser("web", help="HTTP request to a host's web service, logged in with its stored credentials")
    s.add_argument("request", nargs="+", metavar="HOST [SERVICE] METHOD PATH",
                   help="e.g. esxi GET /folder  or  orion3 https GET /api/status")
    s.add_argument("-d", "--data", metavar="BODY", help="request body (@FILE reads a file)")
    s.add_argument("-H", "--header", action="append", metavar="HEADER", help="extra header 'Name: value' (repeatable)")
    s.add_argument("-k", "--insecure", action="store_true", help="don't verify the TLS certificate")
    s.add_argument("--timeout", type=float, default=30, metavar="SECONDS",
                   help="how long to wait for the answer (default: 30)")
    s = sub.add_parser("mesh", help="set up Host-to-Host access (mesh: and links: in roster.yml), one Host at a time")
    s.add_argument("action", nargs="?", choices=["cut", "status"],
                   help="cut HOST: take it out of the Mesh now, everywhere; status: who reaches whom (no connections)")
    s.add_argument("target", nargs="?", metavar="HOST", help="with cut: the Host to cut out")
    s.add_argument("--dry-run", action="store_true", help="show the plan; change nothing on any Host")
    s.add_argument("--rotate", action="append", metavar="HOST", help="replace HOST's Mesh key (repeatable)")
    s.add_argument("-y", "--yes", action="store_true", help="with cut: don't ask first")
    s.add_argument("--json", action="store_true", help="with status or --dry-run: print JSON for scripts and "
                   "tools, never a secret (see Machine-readable output in docs/cli-reference.md)")
    s = sub.add_parser("revoke", help="remove this box's key from all hosts")
    s.add_argument("--only", **only)
    s.add_argument("-y", "--yes", action="store_true", help="don't ask first")
    sub.add_parser("serve", help="JSON-RPC API on stdin/stdout for the desktop app (see docs/serve-api.md)")
    s = sub.add_parser("askpass", help="SSH_ASKPASS helper for a `roster serve` password Session (ssh runs it)")
    s.add_argument("prompt", nargs="?", default="", help="the prompt ssh shows")
    s = sub.add_parser("man", help="show the roster(1) man page, or install it where `man roster` finds it")
    s.add_argument("--install", action="store_true",
                   help="copy it to PREFIX/share/man/man1/, next to PREFIX/bin/roster (~/.local for uv tool install)")
    s.add_argument("--prefix", metavar="DIR", help="with --install: install into DIR/share/man/man1/ instead")
    return p


def inventory(args):
    """roster.yml, loaded. With --json, one that isn't found or doesn't load is a Problem (code 1, with its fix)."""
    path = None
    try:
        path = find_config(args.config)
        return load_config(path)
    except SystemExit as e:
        if not getattr(args, "json", False):
            raise
        raise inventory_problem(str(e.code).removeprefix("error: "), path) from None


def _main(argv=None):
    args = build_parser().parse_args(argv)

    if args.cmd == "askpass":
        from .askpass import main as askpass_main
        return askpass_main([args.prompt])

    if args.cmd == "init":
        return cmd_init(args)
    if args.cmd == "man":
        from .manpage import cmd_man
        return cmd_man(args)
    if args.cmd == "discover":
        if args.json and args.write:
            build_parser().error("--json goes with discover's preview, not --write: drop one of them")
        return cmd_discover(args)
    if args.cmd == "bw":
        return cmd_bw(args)
    if args.cmd == "mesh" and args.json and args.action != "status" and not (args.dry_run and not args.action):
        build_parser().error("--json goes with mesh status or mesh --dry-run: it never applies the Mesh")
    if args.cmd == "check" and args.box:
        if args.host or args.only:
            build_parser().error("check --box takes no HOST or --only: it checks this Box, not its Hosts")
        return cmd_check_box(args)
    if args.cmd == "check" and args.host:
        return cmd_check_host(args)
    if args.cmd == "serve":
        from .serve import serve
        return serve(args.config)            # loads roster.yml itself, so a bad one becomes an API error
    if args.cmd == "providers":
        try:
            cfg = load_config(find_config(args.config))
        except SystemExit:
            cfg = None                              # no roster.yml yet: still list what's available
        setup_providers(cfg)
        return cmd_providers(cfg, args)
    cfg = inventory(args)
    setup_providers(cfg)
    return {"setup": cmd_setup, "sync": cmd_sync, "check": cmd_check, "hosts": cmd_hosts, "info": cmd_info,
            "run": cmd_run, "revoke": cmd_revoke, "resources": cmd_resources, "reveal": cmd_reveal, "auth-check": cmd_auth_check, "web": cmd_web,
            "mesh": cmd_mesh}[args.cmd](cfg, args)
