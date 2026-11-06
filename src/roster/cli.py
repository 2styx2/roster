"""Command-line interface:  roster <command>"""

import concurrent.futures as cf
import os
import sys
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlparse

from . import (
    addhost,
    aliases,
    boxkeys,
    boxsync,
    catchup,
    edit,
    fromvault,
    jsonout,
    keyline,
    mesh,
    meshview,
    providers,
    revoke,
    rotate,
    rotation,
    run,
    sshconfig,
    store,
    vaultcli,
    vaultsync,
)
from .authorized import box_key_re
from .boxsetup import locked, setup, setup_mesh, skip_left_out, warn_os, warn_overlaps
from .claude import write_claude_files
from .cliparser import build_parser, check, command_parser, wants_json
from .common import (
    die,
    find_program,
    never_look_in_the_current_folder,
    plural,
    refuse,
    replace_file,
    say,
    tcp_ok,
    typed_token,
)
from .config import (
    HIDDEN_FILE,
    HIDDEN_PATH,
    access_label,
    find_config,
    load_config,
    matches,
    open_inventory,
    selected,
    shown_path,
)
from .context import Context, current
from .discover import cmd_discover
from .errors import (
    KEY_FILE,
    RENAME_HINT,
    ROTATION_PENDING,
    UNKNOWN_HOST,
    Exit,
    HostRefused,
    InventoryError,
    Problem,
    tagged,
)
from .example import EXAMPLE_CONFIG
from .hosts import NO_PASSWORD, PLACEHOLDER_USER, is_windows, placeholder_user, prompted
from .providers import PROVIDERS, get_secret, setup_providers
from .resources import TYPES, fields, login, summary, wifi_uri
from .sshops import ssh_ok, write_ssh_config
from .web import cmd_web

# ---------------------------------------------------------------- commands

def cmd_init(args, parser):
    """`roster init`: the commented example (the default), or a new Inventory the --inventory way (T212). A file
    that's there already is kept; --name names the new one (`roster inv add`)."""
    from . import newinventory
    if args.config and typed_token(args.config):     # `roster -cTOKEN init`: never a file named after it
        die("that -c PATH looks like a token, not a file name (not repeated), so init made nothing - name the new "
            "roster.yml: roster -c roster.yml init (or -c FOLDER/roster.yml)")
    path = Path(args.config or "roster.yml").expanduser()
    how, value = ("blank", None) if args.blank else (None, None)
    if args.inventory:
        try:
            how, value = newinventory.parse_how(args.inventory)
        except ValueError as e:
            parser.error(f"--inventory: {e}")
    try:
        if how is None:
            if path.exists():
                newinventory.create(path, "blank")           # raises the kept-as-it-is Problem
            replace_file(path, EXAMPLE_CONFIG, 0o644)
            say(f"wrote {shown_path(path) or HIDDEN_PATH} - edit it, then run: roster setup")
        else:
            made = newinventory.create(path, how, value)
            say_made(made, value)
    except Problem as e:
        refuse(e)
    if args.name:
        from . import named
        try:
            newinventory.name_new(path, args.name)
        except Problem as e:
            refuse(e)
        say(f"named {args.name}: {named.path_of(args.name)} (`roster --inv {args.name} setup` sets this Box up "
            f"for it; `roster inv use {args.name}` makes it the active one)")
    return 0


def say_made(made, value):
    from . import newinventory, store
    path = made.path
    shown = shown_path(path) or HIDDEN_PATH         # init's messages name the path the way every other does
    if made.how == "blank":
        say(f"wrote {shown}, a blank Inventory - add Hosts under hosts: (or `roster discover CIDR --write`), then "
            "run: roster setup")
    elif made.how == "file":
        say(f"copied {value} to {shown} - then run: roster setup")
    elif made.how == "repo":
        say(f"cloned {newinventory.shown_url(value)} into {path.parent} - then run: roster setup")
    elif made.hosts:
        say(f"wrote {shown} with {plural(len(made.hosts), 'Host')} from {value or '~/.ssh/config'} (your ssh config "
            "is unchanged) - check them, then run: roster setup")
    else:
        say(f"no Host in {value or '~/.ssh/config'} to import (only wildcards or Match blocks), so {shown} is a blank "
            "Inventory - add Hosts under hosts:, then run: roster setup")
    if made.skipped:
        say(f"skipped      {', '.join(made.skipped)} (patterns and Match blocks aren't single Hosts)")
    if store.at(path, for_show=True).kind == store.FILE and made.how != "repo":
        say(f"optional     `git -C {shown_path(path.parent) or 'ITS-FOLDER'} init` keeps its history; roster works the same without git")


def cmd_setup(cfg, args):
    if args.rotate:
        return cmd_rotate(cfg, args)
    return setup(cfg, only=args.only, host=args.host, dry_run=args.dry_run, key_type=args.key_type,
                 force=args.force)


def cmd_rotate(cfg, args):
    """`roster setup --rotate` (T240, #469, decision Q204): replace the Box key on the Hosts (rotation.py), then
    setup's own Mesh apply with the new key, never rotating a Mesh key (`roster mesh --rotate HOST` does those)."""
    from .errors import ROTATION_PENDING
    if args.only:
        die("setup --rotate is narrowed with --host NAME (a Host or a group), not --only: the Hosts left out stay "
            "pending until a run reaches them")
    scope = rotate.hosts_for(cfg, args.host, args.key_type)
    if args.dry_run:
        rotate.run(cfg, scope, dry_run=True, say=say)
        return 0
    groups = rotate.group(cfg)
    with locked("setup --rotate", [ctx for ctx, _ in groups]):
        r = rotate.run(cfg, scope, say=say)
        failed = dict(r["failed"])
        # setup's own Mesh apply: once the new key is proven on every Host, over it, never --rotate
        if not failed and not r["pending"] and r["done"]:
            failed.update(setup_mesh(cfg, "--host" if scope is not None else None))
        elif r["pending"] and mesh.graph(cfg)["links"]:
            say("mesh         not applied while the Box key rotation is pending (run `roster mesh` to apply it "
                "now: the ssh config offers the pending Hosts both keys)")
    say()
    say(f"done         Box key rotated on {plural(len(r['done']), 'Host')}, {len(r['failed'])} failed, "
        f"{len(r['pending'])} pending")
    for label, note in sorted(r["notes"].items()):
        say(f"  note: {label}: {note}")
    if r["pending"]:
        say(f"warning: [{ROTATION_PENDING}] Box key rotation pending on {plural(len(r['pending']), 'Host')}: the old "
            "Box key stays on them, and in this Box's ssh config for them, until a run reaches them (`roster setup "
            "--rotate` again finishes it):")
        for label, why in r["pending"].items():
            say(f"  {label}: {why}")
    for label, why in sorted(failed.items()):
        if label not in r["pending"]:
            say(f"  {label}: {why}")
    return 1 if failed or r["pending"] else 0


def cmd_sync(cfg, args):
    """`roster sync` (T243, #476): the map (this Box's ssh config and Claude files from roster.yml) and, unless
    --no-vault, the vault sync too (as `roster vault sync`, never asking without a terminal). One line ends it: what
    changed in each, then the next command when something is left (catchup), nothing more when all is done."""
    from .named import unnamed_from_elsewhere
    # an unnamed ssh config another roster.yml wrote isn't this map's past: no diff against it
    before = sshconfig.written_hosts(current().ssh_config) if unnamed_from_elsewhere() is None else None
    write_ssh_config(cfg)
    write_claude_files(cfg)
    warn_overlaps(cfg)
    for p in boxkeys.drift(cfg).values():
        say(f"warning: {tagged(p)}")
    changed, unmapped = [], []
    if not args.no_vault:
        parts = []
        for p, r, e in vaultsync.sync_vaults(cfg, interactive=sys.stdin.isatty()):
            if e is not None:
                parts.append(f"{p} {catchup.vault_not_synced(p, e)}")
            elif r is not None:
                unmapped += r["unmapped"]
                if what := catchup.vault_changes(r):
                    parts.append(f"{p}: {what}")
        if parts:
            changed.append("vault: " + "; ".join(parts))
    if before is not None and (what := catchup.map_changes(before, cfg)):
        changed.append(f"map: {what}")
    for name in sorted(set(before or {}) - set(cfg["hosts"]) - catchup.renamed(before or {}, cfg).keys()):
        say(f"note: {name} left roster.yml, so its ssh entry is gone; this Box's key may still be on it: remove its "
            f"{keyline.TAG} line there by hand (next time, `roster revoke --only {name}` before taking a Host out)")
    if line := catchup.next_line(changed, catchup.gaps(cfg, unmapped=unmapped)):
        say(line)
    return 0


# ---------------------------------------------------------------- the Mesh (ticket 39, decision Q63)

def mesh_cut_all(cfg, args):
    """`roster mesh cut --all` (T193): every Mesh entry off every Host, before removing roster from this Box."""
    n = sum(1 for h in cfg["hosts"].values() if h["enroll"] and h["reviewed"])
    if not args.yes:
        ans = input(f"Take this Box's Mesh keys and files off all {plural(n, 'Host')} now, at once, and any an "
                    "older roster left with no Box in their tag (they may be another Box's or Inventory's)? Another "
                    "Box's or Inventory's tagged entries stay. roster.yml isn't changed: the next `roster mesh` puts "
                    "this one's Mesh back. [y/N] ")
        if ans.strip().lower() != "y":
            return 1
    r = mesh.cut_all(cfg, cfg["workers"])
    say(f"cut the Mesh: confirmed on {', '.join(r['confirmed']) or 'no Host'}")
    for host, why in r["pending"].items():
        say(f"  not confirmed  {host}: {why}")
    for w in r["warnings"]:
        say(f"warning: {w}")
    if r["pending"]:
        say(f"not finished on {plural(len(r['pending']), 'Host')}: `roster mesh cut --all` again once they answer, "
            "before removing roster from this Box")
    return 1 if r["pending"] else 0


def mesh_leftovers(cfg, args):
    """`roster mesh leftovers [--remove]` (was --find-leftovers / --remove-leftovers; T193, #372's review B1): Mesh
    entries on the Hosts that this roster.yml doesn't ask for: this Box's own, and an older roster's (no Box in the
    tag, T199), which may be another Box's Mesh. Never automatic."""
    r = mesh.find_leftovers(cfg, say=say)
    older = any(f.get("older") for f in r["hosts"].values())
    if args.remove and older and (others := mesh.others_here()):
        die(f"another Inventory's Mesh state is on this Box ({', '.join(others)}), and an older roster's tag doesn't "
            "say which Inventory a line is from, so mesh leftovers --remove could take that Inventory's Mesh: remove them "
            "by hand, or `roster mesh cut --all` from each Inventory when uninstalling")
    for host, found in r["hosts"].items():
        say(f"{host}: {', '.join(mesh.leftover_words(found))}")
    for host, why in r["pending"].items():
        say(f"  not looked at  {host}: {why}")
    if not r["hosts"]:
        say("no Mesh entries this roster.yml doesn't ask for" + (" on the Hosts that answered" if r["pending"] else ""))
        return 1 if r["pending"] else 0
    say(f"\nMesh entries this roster.yml doesn't ask for, on {plural(len(r['hosts']), 'Host')}. {mesh.leftovers_whose(r)}.")
    if not args.remove:
        say("`roster mesh leftovers --remove` removes them, once you know they're leftovers (it asks first)")
        return 1 if r["pending"] else 0
    if not args.yes:
        ans = input(f"Remove them from {plural(len(r['hosts']), 'Host')}? " + (
            "If another Box or Inventory still uses those with no Box in their tag, its Mesh stops working there. "
            if older else "") + "[y/N] ")
        if ans.strip().lower() != "y":
            return 1
    done = mesh.remove_leftovers(cfg, r)
    say(f"removed on {', '.join(done['removed']) or 'no Host'}")
    for host, why in done["pending"].items():
        say(f"  not removed  {host}: {why}")
    return 1 if done["pending"] or r["pending"] else 0


def cmd_mesh(cfg, args):
    from .errors import Problem
    if args.action == "status":
        st = mesh.status(cfg)
        if args.json:
            from . import jsondocs
            jsonout.emit(jsondocs.MeshStatusDoc.model_validate(st))
            return 0
        for n in st["members"]:
            say(f"  {n:<16} can reach {plural(st['reach'].get(n, 0), 'Host')}")
        if st["excluded"]:
            say("left out: " + ", ".join(f"{n} ({why})" for n, why in st["excluded"].items()))
        if st["pending"]:
            say(f"pending on {plural(len(st['pending']), 'Host')}: {', '.join(st['pending'])}")
        meshview.warn_cut(st["cut_pending"])
        say("mesh out of date: run `roster mesh`" if st["out_of_date"] else "mesh up to date")
        if not mesh.load_state()["known"]:         # new here, or roster removed and installed again
            say("no Mesh record on this Box: the Hosts may hold Mesh entries an earlier roster left here (or another "
                "Box's); `roster mesh leftovers` looks on every Host and changes nothing")
        return 0
    if args.action == "cut" and args.all:
        if args.target:
            die("roster mesh cut --all takes no Host: it cuts every Host")
        return mesh_cut_all(cfg, args)
    if args.all:
        die("--all goes with cut: roster mesh cut --all")
    if args.action == "leftovers":
        if args.target or args.dry_run or args.rotate:
            die("mesh leftovers takes no Host, --dry-run or --rotate: roster mesh leftovers [--remove] [-y]")
        return mesh_leftovers(cfg, args)
    if args.action == "cut":
        if not args.target:
            die("usage: roster mesh cut HOST, or roster mesh cut --all")
        if args.target not in cfg["hosts"]:
            die(f"unknown host {args.target!r} (see `roster hosts`)", code=UNKNOWN_HOST)
        if not args.yes:
            ans = input(f"Cut {args.target} out of the Mesh now, on every Host at once? [y/N] ")
            if ans.strip().lower() != "y":
                return 1
        written = []

        def sync():                                     # what was written is said before this Box's sync's lines
            say(f"cut {args.target}: confirmed on {', '.join(r['confirmed']) or 'no Host'}")
            say(f"roster.yml   mesh: false for {args.target}, a Pending change (publish it so the cut stays)"
                if store.at(cfg["path"], for_show=True).kind == store.REPO else
                f"roster.yml   mesh: false for {args.target}, saved in roster.yml")
            written.append(True)
            return boxsync.warn(boxsync.sync_file(cfg["path"]))
        r = mesh.cut(cfg, args.target, cfg["workers"])
        change = mesh.write_cut(cfg, args.target, sync)
        if not written:
            say(f"cut {args.target}: confirmed on {', '.join(r['confirmed']) or 'no Host'}")
        say(f"note: {change['note']}") if change.get("note") else None
        if change.get("error"):
            say(f"warning: mesh: false not written: {change['error']} - {change['fix']}")
        for n, why in r["pending"].items():
            say(f"  not confirmed  {n}: {why}")
        for w in r["warnings"]:
            say(f"warning: {w}")
        meshview.warn_cut({args.target: sorted(r["pending"])} if r["pending"] else {})
        return 1 if r["pending"] or change.get("error") else 0
    if args.target:
        die(f"unexpected {args.target!r}: roster mesh [--dry-run] [--rotate HOST], or roster mesh cut HOST")
    if args.json:                       # --dry-run: mesh.plan's result; a Problem is the JSON error (main)
        from . import jsondocs
        r = mesh.run(cfg, apply=False, rotate=args.rotate or ())
        jsonout.emit(jsondocs.MeshPlanDoc.model_validate(r))
        return 1 if r["pending"] else 0
    try:
        r = mesh.run(cfg, apply=not args.dry_run, rotate=args.rotate or (), say=say)
    except Problem as e:
        raise Exit(e) from None
    meshview.show_mesh(r)
    if args.dry_run:
        say("dry run: nothing was changed")
    elif r["already"]:
        say("already in the mesh: nothing to change")
    return 1 if r["pending"] else 0


def cmd_check(cfg, args):
    if args.hosts:                          # `--host NAME` again for more: exactly those Hosts
        unknown = [n for n in args.hosts if n not in cfg["hosts"]]
        if unknown:
            group = f": {unknown[0]} is a group (--only {unknown[0]} takes its Hosts)" if unknown[0] in cfg["groups"] \
                else ""
            die(f"unknown host {unknown[0]!r} (see `roster hosts`){group}")
        wanted = [cfg["hosts"][n] for n in dict.fromkeys(args.hosts)]
    else:
        wanted = selected(cfg, args.only)
    narrowed = bool(args.only or args.hosts)       # part of roster.yml: no Mesh drift
    hosts = skip_left_out(wanted, to_stderr=args.json)
    # a Host skipped (ssh NAME doesn't reach it), or nothing checked at all, isn't a pass
    skipped = len(wanted) - len(hosts) or not hosts
    if not args.json:
        warn_problems(hosts)

    def check(h):
        res = {"ssh": ssh_ok(h["name"]) if h["enroll"] else tcp_ok(h["ip"], h["ssh"]["port"])}
        if res["ssh"] and h["enroll"] and is_windows(h):
            check_windows_key(cfg, h)
        for name, s in h["services"].items():
            res[name] = tcp_ok(urlparse(s["url"]).hostname if s["url"] else h["ip"], s["port"])
        return h, res

    if args.json:
        with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
            results = [{"name": h["name"], "ok": all(res.values()), "ssh": "login" if h["enroll"] else "port",
                        "checks": res} for h, res in ex.map(check, hosts)]
        drift = mesh.drift(cfg) if not narrowed else None
        broken = drift is not None and meshview.broken(drift)
        waiting = rotation_waiting(cfg, wanted)
        found = [tagged(p) for p in rotation.problems(cfg)]
        types = {n: tagged(p) for n, p in boxkeys.drift(cfg, wanted).items()}
        ok = all(r["ok"] for r in results) and not broken and not skipped and not waiting and not found and not types
        from . import jsondocs
        jsonout.emit(jsondocs.CheckDoc.model_validate({"hosts": results, "mesh": drift, "rotation_pending": waiting,
                                                       "rotation_problems": found, "key_type_drift": types, "ok": ok}))
        return 0 if ok else 1
    bad = 0
    width = max((len(h["name"]) for h in hosts), default=0)
    with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
        for h, res in sorted(ex.map(check, hosts), key=lambda r: r[0]["name"]):
            line = "  ".join(f"{k}:{'ok' if v else 'FAIL'}" for k, v in res.items())
            bad += not all(res.values())
            say(f"{h['name']:<{width}}  {line}")
    say(f"\n{len(hosts) - bad}/{len(hosts)} hosts fully reachable"
        + ("" if all(h["enroll"] for h in hosts) else "  (password-only hosts: ssh = port open)"))
    drift = mesh.drift(cfg) if not narrowed else None
    if drift is not None:
        say()
        meshview.show_mesh(drift, drift=True)
        bad += meshview.broken(drift)
        if drift["already"]:
            say("mesh         every Host holds what roster wrote")
    if not narrowed:           # a Windows Host in a Link or meshed group is left out, not an error; say why
        windows = {n: why for n, why in mesh.graph(cfg)["excluded"].items() if is_windows(cfg["hosts"][n])}
        if windows:
            say("mesh         left out: " + ", ".join(f"{n} ({why})" for n, why in windows.items()))
    if waiting := rotation_waiting(cfg, wanted):
        say("\nwarning: " + tagged(Problem(ROTATION_PENDING, f"Box key rotation pending on {plural(len(waiting), 'Host')}: "
            f"{', '.join(waiting)} (the old Box key is still on them; `roster setup --rotate` finishes it)")))
        bad += 1
    for p in rotation.problems(cfg):
        say(f"warning: {tagged(p)} ({p.fix})")
        bad += 1
    for p in boxkeys.drift(cfg, wanted).values():       # a key line of another type
        say(f"warning: {tagged(p)}")
        bad += 1
    if skipped:
        say("not every Host was checked: " + ("the ones above were skipped" if hosts else "none was reached"))
    return 1 if bad or skipped else 0


def rotation_waiting(cfg, hosts):
    """The Box key rotation's pending Hosts among HOSTS (T240): {name: why}."""
    names = {h["name"] for h in hosts}
    return {n: why for n, why in sorted(rotation.pending(cfg).items()) if n in names}


def check_windows_key(cfg, h):
    """`roster check` on a Windows Host whose key login works: its key file, read-only (winhost's check script), and
    what sshd could later refuse it for (code 157), as warnings on stderr. Never a failure: the login works."""
    from . import winhost
    try:
        found = winhost.over_key(h, "check", box_key_re(cfg))
        notes = found.warnings
        if found.admins:
            print(f"note: {h['name']}: {found.files[0] if found.files else 'its key file'}: "
                  f"{winhost.admins_note(h['name'])}", file=sys.stderr, flush=True)
    except HostRefused as e:            # the code is the refusal's own
        print(f"warning: {h['name']}: {e}", file=sys.stderr, flush=True)
        return
    except RuntimeError as e:
        notes = [str(e)]
    for note in notes:
        print(f"warning: [{KEY_FILE}] {h['name']}: {note}", file=sys.stderr, flush=True)


def cmd_check_host(args):
    return check_host(args.host, args.config, args.inv, args.json)


def check_host(name, config=None, inv=None, as_json=False):
    """`roster check HOST`: why a Session to HOST would or wouldn't open, step by step (as host.check).
    It loads roster.yml itself (CONFIG: -c, INV: --inv), so a broken one is the first failed step rather than an
    exit."""
    from . import askpass, diagnose

    with askpass.Channel(diagnose.askpass_lookup) as channel:
        result = diagnose.check_host(name, lambda: open_inventory(config, inv), channel)
    if as_json:
        from . import jsondocs
        jsonout.emit(jsondocs.CheckHostDoc.model_validate(result))
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

    cfg = error = None
    try:
        cfg = open_inventory(args.config, args.inv)
    except InventoryError as e:
        error = e
    try:
        with askpass.Channel(diagnose.askpass_lookup) as ch:
            channel = health.askpass_state(ch)
    except OSError as e:
        channel = health.askpass_state(None, e)
    checks = health.check_box(cfg, error, channel)
    errors = sum(c["level"] == "error" for c in checks)
    if args.json:
        from . import jsondocs
        jsonout.emit(jsondocs.BoxCheckDoc.model_validate({"checks": checks, "ok": not errors}))
        return 1 if errors else 0
    section = None
    for c in checks:
        if c["section"] != section:
            say(("" if section is None else "\n") + str(health.SECTIONS.get(c["section"], c["section"])))
            section = c["section"]
        say(f"  {c['level']:<5}  {tagged(Problem(c['code'], c['message'])) if 'code' in c else c['message']}")
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
    no_ssh = placeholder_user(h)
    parts, seen = [] if no_ssh else [f"ssh ({access_label(h)})"], set()
    for name, s in h["services"].items():
        if not s["url"]:
            continue                                   # a bare port: nothing to log in to
        own = s["override"] or s["login"] not in ("basic", "none")
        label = name if own else "web"
        if label in seen or (label == "web" and any(x.startswith("web") for x in seen)):
            continue
        seen.add(label)
        user = s["user"] if s["user"] not in ("", PLACEHOLDER_USER, h["ssh"]["user"]) else ""
        parts.append(f"{label} ({user})" if user else label)
    return ", ".join(parts)


def warn_problems(hosts):
    """Service entries roster left out of the Inventory (bad port, url, login...), on stderr: the rest still works;
    and Hosts typed windows with no os: (warn_os)."""
    warn_os(hosts)
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
              h["ssh"]["user"] if not placeholder_user(h) else "-",
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
    from . import jsondocs
    jsonout.emit(jsondocs.HostsDoc.model_validate({"hosts": [h for h in hosts if h not in hidden], "resources": rs,
                                                   "groups": cfg["groups"], "hidden": len(hidden)}))
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
        die(f"unknown {what} {name!r}" + (f" - did you mean: {', '.join(found[:10])}" if found else ""), code=UNKNOWN_HOST)
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
        from . import jsondocs
        jsonout.emit(jsondocs.ResourcesDoc.model_validate({"resources": rs}))
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
    say(f"{'secret':<12} " + (f"roster vault reveal {r['name']}" if r["auth"] else "none"))
    return 0


def cmd_reveal(cfg, args):
    r = cfg["resources"].get(args.name)
    if not r:
        die(f"unknown resource {args.name!r} (see `roster hosts --resources`)")
    if args.wifi and r["type"] != "wifi":
        die(f"{r['name']} is a {r['type']}, not wifi")
    secret = ""
    if r["auth"]:
        try:
            secret = get_secret(r["auth"], r["group"] or "resources")
        except RuntimeError as e:
            die(f"{r['name']}: {e}")
    say(wifi_uri(r, secret) if args.wifi else secret or "")
    return 0


def cmd_info(cfg, args):
    """`roster hosts NAME` (was `roster info`)."""
    h = find_host(cfg, args.name, resources=True)
    if args.json:
        g = cfg["groups"].get(h["group"], {})
        group = {"name": h["group"], "title": g.get("title", ""), "description": g.get("description", "")} \
            if h["group"] else None
        from . import jsondocs
        doc = jsondocs.HostInfoDoc if "ip" in h else jsondocs.ResourceInfoDoc
        jsonout.emit(doc.model_validate({"host" if "ip" in h else "resource": h, "group": group}))
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
              ("key", f"{h['key_type']} {h['key_file']}" if h["enroll"] else ""),
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
    return run.run(cfg, args.host, args.command[1:] if args.command[:1] == ["--"] else args.command, args.sudo)


def cmd_revoke(cfg, args):
    return revoke.revoke(cfg, args.only, args.yes)


# ---------------------------------------------------------------- `roster add` (addhost.py does the add)

def cmd_add(cfg, args):
    """`roster add NAME --ip ADDR ...`: one reviewed Host into roster.yml (addhost.add), its next steps said or, with
    --setup, run (setup for it alone, then check it)."""
    if args.name is None:                       # --from-vault with no NAME: the vault's items no Host uses
        return cmd_from_vault(cfg, args)
    asking = sys.stdin.isatty() and not args.yes
    got = {"ip": args.ip, "user": args.user, "port": args.port}
    if args.from_vault:
        if not args.auth:
            needs("--auth", "--from-vault reads the item --auth names (--auth bw:ITEM)")
        try:
            found = addhost.vault_fields(args.auth, interactive=asking)
        except Problem as e:
            refuse(e)
        if found.get("note"):
            say(f"from vault   {found['note']} ({args.auth})")
        vault = {"ip": found.get("address"), "user": found.get("user"),
                 "port": found.get("port") if args.ip is None else None}    # the port goes with the vault's address
        for k, v in vault.items():
            if got[k] is None and v is not None:
                got[k] = v
                say(f"from vault   {k} {v} ({args.auth})")
    if not add_host(cfg, args.name, got, args.auth, args.group, args.enroll, asking, os=args.os, title=args.title,
                    type=args.type, dry_run=args.dry_run):
        return 0
    return set_up(args.name, cfg["path"]) if args.setup else next_steps(args.name)


def add_host(cfg, name, got, auth, group, enroll, asking, os=None, title=None, type=None, dry_run=False):
    """Host NAME into roster.yml (addhost.add), asking for what's missing when ASKING: GOT is {ip, user, port} as given,
    AUTH its Login, GROUP and ENROLL as given (None: asked, or the group's). True once it's written; with DRY_RUN
    what it would write is said instead (False). Dies on anything wrong."""
    path = cfg["path"]
    groups = list(cfg["groups"])
    if group is None:
        default = groups[0] if groups else None
        group = (ask(f"Group{f' [{default}]' if default else ''}: ") or default) if asking else default
        if not group:
            needs("--group", "roster.yml has no group yet")
    if got["ip"] is None:
        got["ip"] = ask("Address (IP or DNS name): ") if asking else None
        if not got["ip"]:
            needs("--ip", f"{name} needs an address")
    base = edit.inherited(edit.read_text(path), group)
    if enroll is None and asking:
        answer = ask(f"Install this Box's key on {name} (enroll)? [{'Y/n' if base['enroll'] else 'y/N'}] ")
        enroll = base["enroll"] if not answer else answer.lower().startswith("y")
    if not (got["user"] or base["user"]):
        needs("--user", f"no user for {name}: its group and defaults don't set one")
    if not (auth or base["auth"]):
        needs("--auth", f"no Login for {name}: its group and defaults don't set auth:")
    wanted = {"ip": got["ip"], "user": got["user"], "port": got["port"], "auth": auth, "enroll": enroll,
              "os": os, "title": title, "type": type, "reviewed": True}
    try:
        fields = {k: edit.check_new(k, v) for k, v in wanted.items() if v is not None}
    except ValueError as e:
        die(str(e), code=edit.INVALID_HOST)
    where = f"group '{group}'"
    try:
        r = addhost.add(path, group, name, fields, dry_run=dry_run, new_address=True,
                        on_write=lambda done: written(name, where, path, group, done))
    except Problem as e:
        refuse(e)
    if dry_run:
        new = " (a new group)" if r["new_group"] else ""
        say(f"would add    {name} to {where}{new} in {path} (--dry-run: nothing written):")
        for line in r["lines"]:
            say(f"  {line}")
        return False
    boxsync.warn(r["sync"])                    # as after discover --write
    return True


def written(name, where, path, group, r):
    """What `roster add` wrote, said as `discover --write` says it, before this Box's sync."""
    say(f"backup       {r['backup']}")
    say(f"wrote        {name} into {where}" + (" (a new group)" if r["new_group"] else "") + f" in {path}")
    if r["new_group"]:
        say(f"new group    '{group}': roster.yml had no group by that name, so it's made")
    if r["kind"] == store.REPO:
        say(f"note         {r['note']}")


def next_steps(name):
    """The two commands that set the new Host up and test it: `setup --host NAME` takes that Host alone, even when
    a group, type or product is NAME too (#437)."""
    say(f"next         roster setup --host {name}   (host key, and this Box's key on it when enroll is true)")
    say(f"             roster check {name}          (a Session to it would open, step by step)")
    return 0


def set_up(name, path):
    """--setup: setup for Host NAME alone, then `check NAME`, each one's outcome said; non-zero if either failed."""
    cfg = load_config(path)
    say(f"\nsetup        roster setup --host {name}")
    # exactly this Host, never what --only NAME would match too (a group, type or product NAME); the whole
    # Inventory stays in cfg, as setup writes the ssh config from all of it
    done = setup(cfg, host=name)
    say(f"\ncheck        roster check {name}")
    check = check_host(name, config=str(path))
    say()
    say(f"setup        {'ok' if not done else 'FAILED (see above)'}")
    say(f"check        {'ok' if not check else 'FAILED (see above)'}")
    return 1 if done or check else 0


def needs(flag, why):
    from .errors import NEEDS_FLAG
    die(f"{why}: give {flag}", code=NEEDS_FLAG)


# ---------------------------------------------------------------- `roster add --from-vault` (fromvault.py lists)

def cmd_from_vault(cfg, args):
    """A list of the vault items no Host uses (`--json`, `-y`, no terminal), or in a terminal a walk: each item
    [Y/n/edit/skip], a yes added as `roster add NAME` adds it, then setup for that Host alone if you want it."""
    path = cfg["path"]
    walking = sys.stdin.isatty() and not args.yes and not args.json
    try:
        found = fromvault.listing(path, sync=not args.no_sync)
    except Problem as e:
        refuse(e)                               # with --json, main says it as the JSON error
    # with --json, stdout is the one document: what the sync did goes to stderr
    tell = (lambda line: print(line, file=sys.stderr, flush=True)) if args.json else say
    for s in found["synced"]:
        before = fromvault.ago(s["previous"])
        tell(f"synced       {s['provider']} (the previous sync was {before})" if before else
             f"synced       {s['provider']} (its first sync on this box)")
    for note in found["skipped"]:
        tell(f"not listed   {note}")
    seen, rows = found["seen"], found["items"]
    listed = rows if args.all else [r for r in rows if r["new"]]
    if args.json:
        from . import jsondocs
        jsonout.emit(jsondocs.VaultItemsDoc.model_validate(
            {"items": [{k: v for k, v in r.items()} for r in listed], "unmapped": len(rows),
             "new": sum(r["new"] for r in rows)}))
    elif walking:
        failed = walk_vault(cfg, args, listed, seen)
    else:
        show_vault_list(rows, listed)
    if args.mark_seen:
        for r in rows:
            seen["items"].setdefault(r["provider"], {})[r["id"]] = r["name"]
    seen["new"] = sum(1 for r in rows if r["id"] not in seen["items"].get(r["provider"], {}))
    fromvault.save_seen(path, seen)
    return 1 if walking and failed else 0


def show_vault_list(rows, listed):
    new = sum(r["new"] for r in rows)
    for r in listed:
        say(f"{'new' if r['new'] else 'seen':<12} {r['auth']:<28} -> {fromvault.described(r)}")
        if r.get("note"):
            say(f"             {r['note']}")
    if not listed:
        say("no new vault items" + (f" ({len(rows)} seen before: --all lists them)" if rows else
                                    ": every item is in roster.yml"))
        return
    old = len(rows) - new
    are = " isn't" if len(rows) == 1 else "s aren't"
    say(f"\n{len(rows)} vault item{are} in roster.yml ({new} new"
        + (f", {old} seen before: --all" if old and len(listed) < len(rows) else "") + "): roster add --from-vault "
        "in a terminal adds them")


def ask(text):
    """input(), or None at the end of input (which stops the walk: an empty answer would be a yes)."""
    try:
        return input(text).strip()
    except EOFError:
        return None


def walk_vault(cfg, args, listed, seen):
    """Each item: [Y/n/edit/skip]. A yes (or an edit) is added as `roster add NAME` adds it (add_host); a no is
    remembered as seen; skip leaves it new. Returns how many adds or setups failed."""
    path, failed = cfg["path"], 0
    if not listed:
        say("no new vault items" + (" (--all lists the ones seen before)" if not args.all else ""))
    for r in listed:
        say(f"\n{'new' if r['new'] else 'seen':<12} {r['auth']}")
        if r.get("note"):
            say(f"             {r['note']}")
        while True:
            answer = ask(f"Add it as {fromvault.described(r)}? [Y/n/edit/skip] ")
            if answer is None:
                return failed
            answer = answer.lower()
            if answer in ("", "y", "yes", "n", "no", "skip", "s", "edit", "e"):
                break
            say("             answer y, n, edit or skip")
        if answer in ("skip", "s"):
            continue
        if answer in ("n", "no"):
            seen["items"].setdefault(r["provider"], {})[r["id"]] = r["name"]
            continue
        fields = {"host": r.get("host"), "address": r.get("address"), "user": r.get("user")}
        if answer in ("edit", "e"):
            for key, label in (("host", "Name"), ("address", "Address"), ("user", "User")):
                got = ask(f"{label}{f' [{fields[key]}]' if fields[key] else ''}: ")
                if got is None:
                    return failed
                fields[key] = got or fields[key]
        if not fields["host"]:
            got = ask("Name: ")
            if not got:
                return failed
            fields["host"] = got
        if not fields["user"] and answer not in ("edit", "e"):  # none in the item (kp never says): Enter keeps the group's
            got = ask("User (Enter: its group's): ")
            if got is None:
                return failed
            fields["user"] = got or None
        port = r.get("port") if fields["address"] == r.get("address") else None
        name = fields["host"]
        try:
            # the Inventory as it is now (an add before this one may have made a group)
            if not add_host(load_config(path), name, {"ip": fields["address"] or None, "user": fields["user"] or None,
                                                      "port": port}, r["auth"], args.group, args.enroll, True,
                            dry_run=args.dry_run):
                continue
            next_steps(name)
        except (Problem, Exit) as e:            # said, and the walk goes on to the next item
            failed += 1
            print(str((Exit(e) if isinstance(e, Problem) else e).code), file=sys.stderr, flush=True)
            continue
        seen["items"].setdefault(r["provider"], {})[r["id"]] = r["name"]
        if args.setup or (ask(f"Set {name} up now (setup for it alone, then check)? [y/N] ") or "").lower() \
                .startswith("y"):
            failed += bool(set_up(name, path))
    return failed


AGENT_HELP = "no password: an SSH key you already have (ssh-agent) gets in"


def cmd_vault_status(cfg, args):
    """`roster vault status` (was `roster providers`): the providers here, their tools and which groups use them,
    then each vault's state as `roster check --box`'s Vault section says it (health.vault, the one source) and when
    `roster vault sync` last synced it."""
    from . import health, vaultsync
    checks = health.vault(cfg) if cfg else []
    synced = {name: vaultsync.last_synced(name) for name in sorted(PROVIDERS) if PROVIDERS[name].get("sync")}
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
                 "installed": bool(find_program(PROVIDERS[name]["tool"])) if PROVIDERS[name].get("tool") else None,
                 "used_by": sorted(used.get(name, ()))} for name in sorted(PROVIDERS)]
        rows.append({"name": "agent", "kind": "built-in", "help": AGENT_HELP, "tool": None, "installed": None,
                     "used_by": sorted(used.get("agent", ()))})
        from . import jsondocs
        jsonout.emit(jsondocs.ProvidersDoc.model_validate({"providers": rows, "unknown": unknown, "ok": not unknown,
                                                           "vault": checks, "last_sync": synced}))
        return 1 if unknown else 0
    say("password providers (use as  auth: NAME:SPEC  in roster.yml):\n")
    for name in sorted(PROVIDERS):
        p = PROVIDERS[name]
        tool = p.get("tool") or ""
        installed = "" if not tool else ("  [tool found]" if find_program(tool) else f"  [`{tool}` NOT installed]")
        groups = f"  - used by: {', '.join(sorted(used[name]))}" if name in used else ""
        say(f"  {name:<8} {p['kind']:<10} {p['help']}{installed}{groups}")
    say(f"  {'agent':<8} {'built-in':<10} {AGENT_HELP}")
    if checks:
        say("\nVault (as `roster check --box` says it)")
        for c in checks:
            say(f"  {c['level']:<5}  {tagged(Problem(c['code'], c['message'])) if 'code' in c else c['message']}")
            if c.get("fix"):
                say(f"         fix: {c['fix']}")
    uses = health.provider_uses(cfg) if cfg else {}
    shown = [name for name in synced if name in uses]
    if shown:
        say("\nLast sync (the vault isn't watched: roster sees new or changed items after a sync)")
    for name in shown:
        when = synced[name]
        say(f"  {name}: last synced {vaultsync.ago(when)}; run `roster vault sync` for what changed" if when else
            f"  {name}: never synced by roster; run `roster vault sync`")
    if unknown:
        say(f"\nUNKNOWN providers used in roster.yml: {', '.join(unknown)}")
        return 1
    return 0


def cmd_vault_sync(cfg, args):
    """`roster vault sync`: each vault roster.yml uses that keeps a local copy, synced, and what changed since the last
    sync (vaultsync): names and counts, never a value. Ends with the next command when a new item isn't in roster.yml
    (T243)."""
    results = vaultsync.sync_vaults(cfg, interactive=sys.stdin.isatty())
    if not results:
        say("roster.yml's Logins use no vault: nothing to sync")
        return 0
    bad, unmapped = 0, []
    for p, r, e in results:
        if e is not None:
            bad += 1
            when = None if isinstance(e, providers_locked()) else vaultsync.last_synced(p)
            say(f"  FAIL  {p}: {e}" + (f"; roster uses it as last synced {vaultsync.ago(when)}" if when else ""))
            if isinstance(e, providers.VaultLocked):
                say(f"        fix: {providers.unlock_fix(p)}")
            continue
        if r is None:
            say(f"  ok    {p}: keeps no local copy (it asks its own server or file each time), nothing to sync")
        elif r["count"] is None:
            say(f"  ok    {p}: synced")
        elif r["first"]:
            say(f"  ok    {p}: synced, {plural(r['count'], 'item')}; first sync, so changes are counted from now on")
        elif not (r["added"] or r["changed"] or r["removed"]):
            say(f"  ok    {p}: up to date (no change since the last sync)")
        else:
            unmapped += r["unmapped"]
            parts = [f"{len(r[k])} {k}: {', '.join(r[k])}" for k in ("added", "changed") if r[k]]
            parts += [f"{r['removed']} removed"] if r["removed"] else []
            say(f"  ok    {p}: synced; since the last sync, {'; '.join(parts)}")
    left = [g for g in catchup.gaps(cfg, unmapped=unmapped) if g.kind == "vault-items"]
    if line := catchup.next_line([], left):
        say(line)
    return 1 if bad else 0


# `roster vault unlock` / `vault lock` (decision Q203): an unlock that lasts until it's locked, saved in the session
# file every roster run on this Box reads, for a provider that keeps one (its "session": Bitwarden's bw-session).

def session_provider(args, need_tool=True):
    """The provider `roster vault unlock`/`lock` acts on (bw unless --provider) and its session, or die() with why
    it keeps none (code 203)."""
    from .errors import NO_SESSION
    name = args.provider or "bw"
    p = PROVIDERS.get(name, {})
    if not p.get("session"):
        die(p.get("no_session") or f"'{name}' has no session roster can keep: roster vault {args.vault_cmd} is for "
                                   "Bitwarden (bw)", code=NO_SESSION)
    if need_tool and not find_program(p["tool"] or name):
        die(p["session"]["missing"])
    return name, p["session"]


def session_problem(e, also="") -> NoReturn:
    """A SecretError from vault unlock/lock as die(): its code shown first (serve's numbers), ALSO after it."""
    from .errors import vault_problem
    p = vault_problem(e)
    die(p.message + also, code=p.code)


def cmd_vault_unlock(args):
    """`roster vault unlock`: ask the master password (to bw by an env var, never argv), then save the session key in
    the session file (bitwarden.save_session_file: atomic, 0600, never over a link or someone else's file), so
    every roster run on this Box uses it until `roster vault lock`, `bw lock` or the roster app's lock. Never prints
    the key."""
    from .providers import Ctx, SecretError
    name, session = session_provider(args)
    if not sys.stdin.isatty():
        die("roster vault unlock needs a terminal to ask for the master password")
    try:
        how = session["unlock"](Ctx(name, None))
    except SecretError as e:
        session_problem(e)
    until, saved = session["until"], session["file"]()
    if how == "already":
        say(f"already unlocked: the saved session in {saved} works until {until}")
        return unlock_next(args)
    if how == "adopted":
        say(f"saved your shell's working BW_SESSION in {saved} (no new unlock, so the roster app and "
            f"other bw sessions stay unlocked): other roster runs on this Box use it until {until}. Any "
            "program running as you can use it to read the vault until then")
        return unlock_next(args)
    say(f"unlocked until {until}: saved in {saved}, so other roster runs on this Box don't ask. "
        "Any program running as you can use it to read the vault until then. bw keeps one unlock at a time, so this "
        "one locked the roster app and any other bw session on this Box")
    return unlock_next(args)


def unlock_next(args):
    """vault unlock's last line (T243): what's left now the vault is open (a setup it held up, say), from this run's
    roster.yml when there is one; nothing when all is done. 0."""
    try:
        cfg = load_config(find_config(args.config, args.inv))
    except (Problem, Exit):                 # no roster.yml (vault unlock needs none): nothing to name
        return 0
    if line := catchup.next_line([], catchup.gaps(cfg)):
        say(line)
    return 0


def cmd_vault_lock(args):
    """`roster vault lock`: lock the vault everywhere on this Box (`bw lock`: the app's session too), then remove the
    session file, whatever the lock did (even with no bw installed). Each is reported on its own (#480 review)."""
    from .providers import Ctx, SecretError
    name, session = session_provider(args, need_tool=False)
    said, problem = session["lock"](Ctx(name, None))
    if said:
        say(said)
    try:
        removed = session["remove"]()
    except SecretError as e:
        session_problem(e, f"; {problem}" if problem else "")
    say(f"removed {session['file']()}" if removed else "no saved session to remove")
    if problem:
        die(problem)
    return 0


def providers_locked():
    from .providers import NotLoggedIn, VaultLocked
    return (VaultLocked, NotLoggedIn)


def cmd_help(parser, args):
    """`roster help [COMMAND]`, `--man [--install]` (was `roster man`), `--completion SHELL` (was `roster completion`)."""
    if (args.install or args.prefix) and not args.man:
        parser.error("--install and --prefix go with --man: roster help --man --install")
    picked = [f for f, on in (("COMMAND", args.topic), ("--man", args.man), ("--completion", args.completion)) if on]
    if len(picked) > 1:
        parser.error(f"roster help takes one of COMMAND, --man and --completion, not {' and '.join(picked)}")
    if args.completion:
        from .completion import cmd_completion
        return cmd_completion(args.completion)
    if args.man:
        from .manpage import cmd_man
        return cmd_man(args)
    sys.stdout.write(command_parser(parser, args.topic).format_help())
    return 0


def cmd_auth_check(cfg, args):
    """`roster check --auth` (was `roster auth-check`)."""
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
    rows = auth_check_rows(uses)
    if args.json:
        from . import jsondocs
        rows = list(rows)
        ok = all(r["status"] != "fail" for r in rows)
        jsonout.emit(jsondocs.LoginsDoc.model_validate({"logins": rows, "ok": ok}))
        return 0 if ok else 1
    bad = 0
    for row in rows:
        label = (f"{row['group']:<16} {str(row['auth']):<36} users: {', '.join(row['users']) or '-'}  for: "
                 f"{used_for(row['used_for'])}")
        if row["status"] == "ask":
            say(f"  ask   {label}  (asked when setup runs)")
        elif row["status"] == "ok":
            say(f"  ok    {label}")
        else:
            bad += 1
            say(f"  FAIL  {label}\n        {row['error']}")
    say("\nok = a value was found. It is not tested against any host here; `setup` does that.")
    return 1 if bad else 0


def auth_check_rows(uses):
    """`roster check --auth`'s rows, one per (Login reference, group) of USES, each looked up as it comes:
    {group, auth, users, used_for: [{service, hosts}], status: ok|ask|fail, error?}. Never the value it found."""
    for ref, group in sorted(uses, key=lambda t: (t[1], str(t[0]))):
        by_svc = {}
        for svc, host, _ in uses[ref, group]:
            by_svc.setdefault(svc, []).append(host)
        row = {"group": group, "auth": ref, "users": sorted({u for _, _, u in uses[ref, group] if u}),
               "used_for": [{"service": svc, "hosts": hs} for svc, hs in by_svc.items()], "status": "ok"}
        if prompted(ref):
            row["status"] = "ask"
        else:
            try:
                get_secret(ref, group)
            except RuntimeError as e:
                row |= {"status": "fail", "error": str(e)}
        yield row


def used_for(used):
    """'ssh (12 hosts), https (orion3)' - which services on which hosts use one password source (a row's used_for)."""
    return ", ".join(f"{u['service']} ({u['hosts'][0] if len(u['hosts']) == 1 else str(len(u['hosts'])) + ' hosts'})"
                     for u in used)


def cmd_bw(args):
    """`roster vault bw`: the Bitwarden CLI with this box's vault session (~/.config/roster/bw-session), so scripts
    and Claude sessions don't each carry BW_SESSION around (vaultcli.run_bw)."""
    from .providers.bitwarden import load_session_file, session_key
    argv = args.args[1:] if args.args[:1] == ["--"] else list(args.args)
    if not argv:
        die("usage: roster vault bw [--write] -- <bw arguments>   e.g.  roster vault bw -- list items --search web-01")
    vaultcli.bw_command(argv, args.write)
    load_session_file()
    return vaultcli.run_bw(argv, args.write, session_key())


def cmd_op(args):
    """`roster vault op`: the 1Password CLI, read-only unless --write (vaultcli.run_op)."""
    argv = args.args[1:] if args.args[:1] == ["--"] else list(args.args)
    if not argv:
        die("usage: roster vault op [--write] -- <op arguments>   e.g.  roster vault op -- item list --vault Infra")
    return vaultcli.run_op(argv, args.write)


def cmd_inv(args):
    """`roster inv`: name Inventories, pick the active one, forget one, and say which roster.yml roster uses."""
    from . import inventories, named
    from .config import locate_config
    act = args.action
    if act == "which":
        path = locate_config(args.config, args.inv)
        name = args.inv or named.name_of(path)
        shown = shown_path(path)            # its purpose is the path, but a token typed as -c PATH isn't
        if args.json:
            from . import jsondocs
            jsonout.emit(jsondocs.WhichDoc(path=shown or "(not repeated)", name=name, exists=path.is_file()))
            return 0 if path.is_file() else 1
        if not path.is_file():
            die(f"roster would use {shown or HIDDEN_PATH}, but it isn't there")
        say(shown or f"{HIDDEN_FILE} - {RENAME_HINT}")      # one in a token-named folder (#498)
        return 0
    if act == "list":
        inv = named.load()
        if args.json:
            from . import jsondocs
            jsonout.emit(jsondocs.InventoriesDoc.model_validate(inv.view()))
            return 0
        if not inv.inventories:
            say("no named Inventories (roster inv add NAME PATH names one)")
        width = max((len(x.name) for x in inv.inventories), default=0)
        for x in inv.inventories:
            missing = "" if x.path.is_file() else "  (not there)"
            say(f"{'*' if x.name == inv.active else ' '} {x.name:<{width}}  {x.path}{missing}")
        return 0
    if act == "add":
        added = inventories.add(args.name, args.path)
        say(f"named {args.name}: {named.path_of(args.name)}"
            + (f"; {args.name} is the active Inventory" if added.first else f" (`roster inv use {args.name}` makes it "
               "the active one)"))
        if added.mesh_state:
            say(f"its Mesh state (from this file's `roster mesh` before it was named) is in {added.mesh_state} now")
        if added.mesh_kept:
            say(f"note: {Context().mesh_state} stays with the unnamed Inventory: {added.mesh_kept} "
                f"(move it to {Context(args.name).mesh_state} by hand if it is)")
        say(f"note: `roster --inv {args.name} sync` writes its ssh config and ROSTER.md here "
            f"(`roster --inv {args.name} setup` on a new Box)")
        return 0
    if act == "use":
        inventories.use(args.name)
        name = named.canonical(args.name)
        say(f"{name} is the active Inventory: {named.path_of(name)}")
        if os.environ.get("ROSTER_CONFIG"):
            say(f"note: ROSTER_CONFIG is set ({os.environ['ROSTER_CONFIG']}), and it comes before the active "
                "Inventory: unset it for roster to use this one")
        return 0
    removed = inventories.remove(args.name)
    say(f"forgot {args.name} (its roster.yml stays where it is)"
        + ("; no Inventory is active now (`roster inv use NAME` picks one)" if removed.was_active else ""))
    if removed.known_hosts:
        say(f"its host keys are in {removed.known_hosts} now, so another Inventory named {args.name} starts without "
            "them")
    if removed.mesh_state:
        say(f"its Mesh state is in {removed.mesh_state} now, so another Inventory named {args.name} starts without "
            "it")
    if removed.rotation:
        say(f"its Box key rotation's record is in {removed.rotation} now, so another Inventory named {args.name} "
            "starts without it (`roster check --box` on that file's Inventory says what it still holds)")
    if not named.load().inventories:
        say("note: no named Inventories are left: run `roster sync` so ~/.ssh/config reaches this Box's Hosts again")
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    never_look_in_the_current_folder()      # Windows: nothing roster starts looks for its program in the cwd
    if argv[:1] == ["__complete"]:       # the shell's Tab (completion.py): never an error, never a usage message
        from . import completion
        return completion.main(argv[1:])
    argv, alias = aliases.rewrite(argv)  # an old name (roster info, roster bw): its new form, said once on stderr
    json_errors = wants_json(argv)
    providers.set_json_output(json_errors)
    if alias and not alias.silent and not json_errors:      # with --json, stderr is a JSON error or nothing
        print(aliases.warning(alias), file=sys.stderr, flush=True)
    try:
        return _main(argv) or 0
    except Problem as e:
        if not json_errors:
            raise Exit(e) from None
        jsonout.fail(e.code, e.message, e.fix)
        return 1
    except Exit as e:
        if not json_errors:
            raise
        jsonout.fail(e.problem.code, e.problem.message, e.problem.fix)
        return 1
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:              # output piped into head/grep that closed early
        sys.stdout = None
        os._exit(0)
    finally:
        providers.set_json_output(False)


def _main(argv=None):
    parser = build_parser(argv or [])
    args, extra = parser.parse_known_args(argv)
    passthrough = args.cmd == "vault" and args.vault_cmd in ("bw", "op")
    if extra and passthrough:                  # options before the tool's command are its own: its allowlist judges them, unrepeated
        args.args = [*extra, *args.args]
    elif extra:
        parser.error(f"unrecognized arguments: {' '.join(extra)}")
    check(parser, args)

    if args.cmd is None:                    # plain `roster`: what it can do, not an argparse error
        sys.stdout.write(parser.format_help())
        return 0
    if args.cmd == "askpass":
        from .askpass import main as askpass_main
        return askpass_main([args.prompt])

    if args.cmd == "init":
        return cmd_init(args, parser)
    if args.cmd == "help":
        return cmd_help(parser, args)
    if args.cmd == "vault" and args.vault_cmd is None:     # plain `roster vault`: its actions
        sys.stdout.write(command_parser(parser, ["vault"]).format_help())
        return 0
    if args.cmd == "vault" and args.vault_cmd in ("unlock", "lock"):     # this Box's vault: no roster.yml needed
        return cmd_vault_unlock(args) if args.vault_cmd == "unlock" else cmd_vault_lock(args)
    if args.cmd == "discover":
        return cmd_discover(args)
    if passthrough:
        return cmd_bw(args) if args.vault_cmd == "bw" else cmd_op(args)
    if args.cmd == "inv":
        return cmd_inv(args)
    if args.cmd == "revoke" and args.all:
        return revoke.revoke_all(args.yes)
    if args.cmd == "check" and args.box:
        return cmd_check_box(args)
    if args.cmd == "check" and args.host:
        return cmd_check_host(args)
    if args.cmd == "serve":
        from .serve import serve
        return serve(args.config, args.inv)  # loads roster.yml itself, so a bad one becomes an API error
    if args.cmd == "vault" and args.vault_cmd == "status":
        try:
            cfg = open_inventory(args.config, args.inv)
        except InventoryError:
            cfg = None                              # no roster.yml yet: still list what's available
            setup_providers(cfg)
        return cmd_vault_status(cfg, args)
    cfg = open_inventory(args.config, args.inv)

    if args.cmd == "vault":
        return {"reveal": cmd_reveal, "sync": cmd_vault_sync}[args.vault_cmd](cfg, args)
    if args.cmd == "check" and args.auth:
        return cmd_auth_check(cfg, args)
    if args.cmd == "hosts" and args.name:
        return cmd_info(cfg, args)
    if args.cmd == "hosts" and args.resources:
        return cmd_resources(cfg, args)
    return {"setup": cmd_setup, "sync": cmd_sync, "check": cmd_check, "hosts": cmd_hosts, "run": cmd_run,
            "revoke": cmd_revoke, "web": cmd_web, "mesh": cmd_mesh, "add": cmd_add}[args.cmd](cfg, args)
