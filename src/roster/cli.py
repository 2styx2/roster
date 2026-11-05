"""Command-line interface:  roster <command>"""

import argparse
import concurrent.futures as cf
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from . import __version__, aliases, boxsync, clihelp, jsonout, mesh
from .addhost import cmd_add
from .claude import write_claude_files
from .common import (
    KEY_TAG,
    KEY_TRAIL,
    die,
    find_program,
    key_name_file,
    never_look_in_the_current_folder,
    not_reviewed,
    program_argv,
    replace_file,
    run_instead,
    say,
    ssh_config_file,
    tcp_ok,
)
from .completion import COMMANDS, DIRS, FILES, GROUPS, HOSTS, INVENTORIES, ONLY, RESOURCES, SHELLS, values
from .config import access_label, find_config, is_windows, load_config, matches, selected
from .discover import DEFAULT_SCAN_PORTS, cmd_discover
from .errors import ROSTER_ERROR, UNKNOWN_HOST, UNKNOWN_INVENTORY, Problem, inventory_problem
from .example import EXAMPLE_CONFIG
from .providers import NO_PASSWORD, PROVIDERS, get_secret, setup_providers
from .resources import TYPES, fields, login, summary, wifi_uri
from .sshops import (
    NameTaken,
    box_key_re,
    enroll,
    ensure_key,
    key_ere,
    key_named,
    password_exec,
    public_key_line,
    record_fingerprints,
    remove_key_script,
    retag_key_script,
    ssh_ok,
    sudo_wrap,
    write_ssh_config,
)
from .web import cmd_web, mask
from .winhost import clean

# ---------------------------------------------------------------- commands

def cmd_init(args):
    """`roster init`: the commented example (the default), or a new Inventory the --inventory way (T212). A file
    that's there already is kept; --name names the new one (`roster inv add`)."""
    from . import newinventory
    path = Path(args.config or "roster.yml").expanduser()
    how, value = ("blank", None) if args.blank else (None, None)
    if args.inventory:
        try:
            how, value = newinventory.parse_how(args.inventory)
        except ValueError as e:
            build_parser().error(f"--inventory {e}")
    try:
        if how is None:
            if path.exists():
                newinventory.create(path, "blank")           # raises the kept-as-it-is Problem
            path.write_text(EXAMPLE_CONFIG)
            say(f"wrote {path} - edit it, then run: roster setup")
        else:
            made = newinventory.create(path, how, value)
            say_made(made, value)
    except Problem as e:
        die(f"{e.message}" + (f" ({e.details})" if e.details else "") + (f" - {e.fix}" if e.fix else ""))
    if args.name:
        from . import inventories
        inventories.add(args.name, path)
        say(f"named {args.name}: {inventories.path_of(args.name)} (`roster --inv {args.name} setup` sets this Box up "
            f"for it; `roster inv use {args.name}` makes it the active one)")
    return 0


def say_made(made, value):
    from . import newinventory, store
    path = made.path
    if made.how == "blank":
        say(f"wrote {path}, a blank Inventory - add Hosts under hosts: (or `roster discover CIDR --write`), then "
            "run: roster setup")
    elif made.how == "file":
        say(f"copied {value} to {path} - then run: roster setup")
    elif made.how == "repo":
        say(f"cloned {newinventory.shown_url(value)} into {path.parent} - then run: roster setup")
    elif made.hosts:
        say(f"wrote {path} with {plural(len(made.hosts), 'Host')} from {value or '~/.ssh/config'} (your ssh config "
            "is unchanged) - check them, then run: roster setup")
    else:
        say(f"no Host in {value or '~/.ssh/config'} to import (only wildcards or Match blocks), so {path} is a blank "
            "Inventory - add Hosts under hosts:, then run: roster setup")
    if made.skipped:
        say(f"skipped      {', '.join(made.skipped)} (patterns and Match blocks aren't single Hosts)")
    if store.at(path, for_show=True).kind == store.FILE and made.how != "repo":
        say(f"optional     `git -C {path.parent} init` keeps its history; roster works the same without git")


LEFT_OUT = ("left out of this Box's ssh config: another named Inventory ahead of this one has a Host by that name, "
            "so `ssh {name}` reaches that one; skipped (`roster inv use` this Inventory to reach it)")


def skip_left_out(hosts, to_stderr=False):
    """HOSTS without the key Hosts a plain `ssh NAME` wouldn't reach (ticket 115): another named Inventory's Host by
    that name is the one in this Box's ssh config, or this Inventory's part of it doesn't have NAME (not synced here),
    so roster must never ssh to it by name. Each skipped one is said."""
    from .sshops import left_out, not_reached, sync_fix
    keep = []
    for h in hosts:
        why = not_reached(h["name"]) if h["enroll"] else None
        if why:
            words = f"{h['name']}: " + LEFT_OUT.format(name=h["name"]) if left_out(h["name"]) else \
                f"{why}; skipped ({sync_fix()})"
            print(f"  {words}", file=sys.stderr if to_stderr else sys.stdout, flush=True)
        else:
            keep.append(h)
    return keep


def refuse_left_out(h):
    """`roster run` (and --sudo) over ssh: never by a name that reaches another Inventory's Host (its sudo password
    would go there), or that this Inventory's part of this Box's ssh config doesn't have."""
    from .sshops import left_out, not_reached, sync_fix
    why = not_reached(h["name"])
    if why:
        fix = ("make this Inventory the active one (`roster inv use`), or rename one of the two in its roster.yml"
               if left_out(h["name"]) else sync_fix())
        die(f"{why} - not running anything: {fix}")


def name_taken(cfg):
    from .errors import BOX_NAME_TAKEN
    return (f"[{BOX_NAME_TAKEN}] another key's line there is tagged {cfg['tag']}: another Box already uses that "
            "name, and this Box's setup and revoke would take that line too (one name, one owner), so nothing was "
            "changed there. Give this Box another box_name:, or run roster setup --force to go ahead")


def cmd_setup(cfg, args):
    # `--host NAME` (#437, Q198; `roster add --setup` too): exactly that Host, never what --only NAME would match too
    # (a group, type or product by that name)
    host = getattr(args, "host", None)
    if host is not None and host not in cfg["hosts"]:
        die(f"unknown host {host!r} (see `roster hosts`)")
    hosts = [cfg["hosts"][host]] if host is not None else selected(cfg, args.only)
    narrowed = bool(args.only or host)      # part of roster.yml: no Mesh, no key-name record
    waiting = [h for h in hosts if not h["reviewed"]]
    hosts = [h for h in hosts if h["reviewed"]]
    if waiting:
        say(f"skipping     {len(waiting)} hosts with reviewed: false (from discover) - review them in "
            "roster.yml, set reviewed: true, then re-run setup")
    if not hosts:
        return 0
    warn_os(hosts)
    say(f"roster setup box '{cfg['box']}', {len(hosts)} hosts from {cfg['path']}")
    ensure_key(cfg)
    pub = public_key_line(cfg)
    no_answer = record_fingerprints(cfg, hosts)
    write_ssh_config(cfg)

    key_hosts = skip_left_out([h for h in hosts if h["enroll"] and h["name"] not in no_answer])
    pw_hosts = [h for h in hosts if not h["enroll"]]
    with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
        works = dict(zip([h["name"] for h in key_hosts], ex.map(lambda h: ssh_ok(h["name"]), key_hosts), strict=True))
    todo = [h for h in key_hosts if not works[h["name"]]]
    say(f"key login    {len(key_hosts) - len(todo)} already work, {len(todo)} need the key installed")
    # T217 (#412): box_name: (or the hostname) changed since this Box's key went on its Hosts: the lines there still
    # carry the earlier name, so the Hosts where the key works get it re-tagged (found by this Box's own public key)
    was = key_named(cfg)
    retag = [h for h in key_hosts if works[h["name"]]] if was not in (None, cfg["box"]) else []
    if retag:
        # #423's L1: with no record, only the key's comment says a name (a named Inventory's first setup may never
        # have been renamed: the key was made by another Inventory's)
        why = (f"this Box's key is tagged {KEY_TAG}:{was} on its Hosts (box_name:, or the hostname, changed since)"
               if key_name_file().exists() else
               f"this Box's key was made as {KEY_TAG}:{was}, so its lines may carry that name")
        say(f"key tag      {why}: re-tag it as {cfg['tag']} on {plural(len(retag), 'host')} where it works")

    failed = {h["name"]: "no answer on SSH port" for h in hosts if h["name"] in no_answer}
    if args.dry_run:
        for h in todo:
            say(f"  would install key on {h['name']} ({h['user']}@{h['ip']}:{h['port']}, auth {h['auth']})")
        for h in retag:
            say(f"  would re-tag key on {h['name']}")
        return 0

    # T226 (#435, 2): renamed onto a name another Box's key line has on a Host: the same-name rule (this Box's revoke
    # and install take a name's lines) would take that Box's line, so that Host is left, said, unless --force
    taken = cfg["tag_re"] if was not in (None, cfg["box"]) and not getattr(args, "force", False) else None
    if retag:
        with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
            for h, why in zip(retag, ex.map(lambda h: retag_on(h, pub, taken), retag), strict=True):
                if why is None:
                    say(f"  ok    {h['name']} (re-tagged)")
                elif isinstance(why, NoLine):   # (agent) nothing roster can re-tag there: done, said once
                    say(f"  note  {h['name']}: the key works, but no {KEY_TAG} line for it is in {why.file} (a line "
                        "written by hand): left as is; change or remove that line by hand")
                elif why is TAKEN:
                    failed[h["name"]] = name_taken(cfg)
                    say(f"  FAIL  {h['name']}: {name_taken(cfg)}")
                else:
                    failed[h["name"]] = f"re-tag: {why}"
                    say(f"  FAIL  {h['name']}: re-tag: {why}")

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
            futs = {ex.submit(enroll, h, pub, box_key_re(cfg), taken): h for h in todo}
            for f in cf.as_completed(futs):
                h = futs[f]
                try:
                    notes = f.result()
                    installed += 1
                    say(f"  ok    {h['name']}")
                    for note in notes or ():
                        say(f"        {note}")
                except NameTaken:
                    failed[h["name"]] = name_taken(cfg)
                    say(f"  FAIL  {h['name']}: {name_taken(cfg)}")
                except Exception as e:
                    failed[h["name"]] = str(e)
                    say(f"  FAIL  {h['name']}: {e}")

    # every key Host of this roster.yml now has the key under this name: a later rename is seen against it
    if not narrowed and not failed and len(key_hosts) == sum(h["enroll"] for h in hosts):
        if was != cfg["box"]:
            replace_file(key_name_file(), f"{cfg['box']}\n")
    write_claude_files(cfg)
    warn_overlaps(cfg)
    if mesh.graph(cfg)["links"]:
        if narrowed:
            say(f"mesh         not applied with {'--only' if args.only else '--host'} (it covers the whole Mesh): "
                "run `roster mesh`")
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


def warn_overlaps(cfg):
    """The same machine in two named Inventories (ticket 115): a warning each, never an error."""
    from .inventories import overlaps
    for w in overlaps(cfg):
        say(f"warning: {w['message']} (fix: {w['fix']})")


def cmd_sync(cfg, args):
    write_ssh_config(cfg)
    write_claude_files(cfg)
    warn_overlaps(cfg)
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
        warn_cut(st["cut_pending"])
        say("mesh out of date: run `roster mesh`" if st["out_of_date"] else "mesh up to date")
        if not mesh.load_state()["known"]:         # T193: new here, or roster removed and installed again
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
            die(f"unknown host {args.target!r} (see `roster hosts`)")
        if not args.yes:
            ans = input(f"Cut {args.target} out of the Mesh now, on every Host at once? [y/N] ")
            if ans.strip().lower() != "y":
                return 1
        r = mesh.cut(cfg, args.target, cfg["workers"])
        change = mesh.write_cut(cfg, args.target)
        say(f"cut {args.target}: confirmed on {', '.join(r['confirmed']) or 'no Host'}")
        if change.get("written"):
            say(f"roster.yml   mesh: false for {args.target}, a Pending change (publish it so the cut stays)"
                if change.get("kind") == "repo" else f"roster.yml   mesh: false for {args.target}, saved in roster.yml")
            boxsync.after_edit(cfg["path"])           # T153: this Box follows, as after serve's mesh.cut
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
        from . import jsondocs
        r = mesh.run(cfg, apply=False, rotate=args.rotate or ())
        jsonout.emit(jsondocs.MeshPlanDoc.model_validate(r))
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
    wanted = selected(cfg, args.only)
    hosts = skip_left_out(wanted, to_stderr=args.json)
    # T194 (#371): a Host skipped (ssh NAME doesn't reach it), or nothing checked at all, isn't a pass
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
        drift = mesh.drift(cfg) if not args.only else None
        broken = drift is not None and bool(drift["pending"] or any(h["changes"] for h in drift["hosts"])
                                            or any(x["status"] in BROKEN_LINKS for x in drift["links"]))
        ok = all(r["ok"] for r in results) and not broken and not skipped
        from . import jsondocs
        jsonout.emit(jsondocs.CheckDoc.model_validate({"hosts": results, "mesh": drift, "ok": ok}))
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
    drift = mesh.drift(cfg) if not args.only else None
    if drift is not None:
        say()
        show_mesh(drift, drift=True)
        bad += bool(drift["pending"] or any(h["changes"] for h in drift["hosts"])
                    or any(x["status"] in BROKEN_LINKS for x in drift["links"]))
        if drift["already"]:
            say("mesh         every Host holds what roster wrote")
    if not args.only:          # T196: a Windows Host in a Link or meshed group is left out, not an error; say why
        windows = {n: why for n, why in mesh.graph(cfg)["excluded"].items() if is_windows(cfg["hosts"][n])}
        if windows:
            say("mesh         left out: " + ", ".join(f"{n} ({why})" for n, why in windows.items()))
    if skipped:
        say("not every Host was checked: " + ("the ones above were skipped" if hosts else "none was reached"))
    return 1 if bad or skipped else 0


def check_windows_key(cfg, h):
    """`roster check` on a Windows Host whose key login works: its key file, read-only (winhost's check script), and
    what sshd could later refuse it for (code 157), as warnings on stderr. Never a failure: the login works."""
    from . import winhost
    from .errors import KEY_FILE
    try:
        found = winhost.over_key(h, "check", box_key_re(cfg))
        notes = found.warnings
        if found.admins:
            print(f"note: {h['name']}: {found.files[0] if found.files else 'its key file'}: "
                  f"{winhost.admins_note(h['name'])}", file=sys.stderr, flush=True)
    except RuntimeError as e:
        notes = [str(e)]
    for note in notes:
        print(f"warning: [{KEY_FILE}] {h['name']}: {note}" if not note.startswith("[") else
              f"warning: {h['name']}: {note}", file=sys.stderr, flush=True)


def cmd_check_host(args):
    """`roster check HOST`: why a Session to HOST would or wouldn't open, step by step (as host.check).
    It loads roster.yml itself, so a broken one is the first failed step rather than an exit."""
    from . import askpass, diagnose
    from .errors import inventory_problem

    def inventory():
        path = None
        try:
            path = find_config(args.config, args.inv)
            cfg = load_config(path)
            setup_providers(cfg)
            return cfg
        except SystemExit as e:
            raise inventory_problem(str(e.code).removeprefix("error: "), path) from None

    with askpass.Channel(diagnose.askpass_lookup) as channel:
        result = diagnose.check_host(args.host, inventory, channel)
    if args.json:
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

    path = cfg = error = None
    try:
        path = find_config(args.config, args.inv)
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
        from . import jsondocs
        jsonout.emit(jsondocs.BoxCheckDoc.model_validate({"checks": checks, "ok": not errors}))
        return 1 if errors else 0
    section = None
    for c in checks:
        if c["section"] != section:
            say(("" if section is None else "\n") + str(health.SECTIONS.get(c["section"], c["section"])))
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


def warn_os(hosts):
    """A Host with type: windows but no os: (T195, code 154): roster treats it as POSIX and runs sh scripts there, so
    say how to mark it. A warning only: roster never infers os: from type:, a free label."""
    from .errors import WINDOWS_TYPE_NO_OS
    for h in sorted(hosts, key=lambda h: h["name"]):
        if h["type"].strip().lower() == "windows" and h.get("os") is None:
            print(f"warning: [{WINDOWS_TYPE_NO_OS}] {h['name']} has type: windows but no os:, so roster treats it as a "
                  "POSIX Host (sh scripts)\n         fix: set os: windows for it (or its group) in roster.yml",
                  file=sys.stderr, flush=True)


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
    if is_windows(h):
        return run_windows(h, command, args.sudo)
    if args.sudo:
        return run_sudo(h, command)
    if h["enroll"]:
        refuse_left_out(h)
        return run_instead(["ssh", "-o", "BatchMode=yes", h["name"], command])
    try:
        rc, out, err = password_exec(h, command, get_secret(h["ssh"]["auth"], h["group"]))
    except RuntimeError as e:
        die(f"{h['name']}: {clean(str(e))}")
    sys.stdout.write(out)
    sys.stderr.write(err)
    if words[0] == "sudo" and rc != 0 and ("password is required" in err or "terminal is required" in err):
        print(f"hint: sudo wants a password - use  roster run --sudo {h['name']} -- {' '.join(words[1:])}",
              file=sys.stderr)
    return rc if rc >= 0 else 1


def run_windows(h, command, sudo):
    """`roster run` on an os: windows Host (T196, decision Q176): COMMAND always under PowerShell (winhost.run), the
    same whatever sshd's DefaultShell. --sudo is refused before the vault is asked: Windows has no sudo over ssh."""
    from . import winhost
    from .errors import RUN_SUDO_WINDOWS
    if sudo:
        die(f"[{RUN_SUDO_WINDOWS}] {h['name']} is a Windows Host (os: windows), which has no sudo over ssh: nothing "
            "ran. Log in as an account in Administrators (its ssh session is already elevated) and run it without "
            "--sudo")
    try:
        if h["enroll"]:
            refuse_left_out(h)
            return winhost.run(h, command)
        return winhost.run(h, command, get_secret(h["ssh"]["auth"], h["group"]), key=False)
    except ValueError as e:                 # the script with CMD in it is over 1 MB: nothing was sent
        die(f"{h['name']}: {e}: nothing ran")
    except RuntimeError as e:
        die(f"{h['name']}: {clean(str(e))}")


def run_sudo(h, command):
    """Run COMMAND as root: sudo gets the host's login password on stdin, never on screen."""
    try:
        secret = get_secret(h["ssh"]["auth"], h["group"])
    except RuntimeError as e:
        die(f"{h['name']}: {clean(str(e))}")
    if not secret:
        die(f"{h['name']}: --sudo needs the login's password, but its auth is {h['ssh']['auth']!r} "
            "(set auth: to the vault item that holds the password)")
    wrapped = sudo_wrap(command)
    if h["enroll"]:
        refuse_left_out(h)
        # bytes: text mode on Windows would send "password\r\n", and sudo would take the "\r" as part of it
        r = subprocess.run(program_argv(["ssh", "-o", "BatchMode=yes", h["name"], wrapped]),
                           input=(secret + "\n").encode(), capture_output=True)
        rc, out, err = r.returncode, r.stdout.decode(errors="replace"), r.stderr.decode(errors="replace")
    else:
        try:
            rc, out, err = password_exec(h, wrapped, secret, stdin=secret + "\n")
        except RuntimeError as e:
            die(f"{h['name']}: {clean(mask(str(e), [secret]))}")
    sys.stdout.write(mask(out, [secret]))
    sys.stderr.write(mask(err, [secret]))
    if "incorrect password" in err or "no password was provided" in err:
        print(f"{h['name']}: sudo refused the password from {h['ssh']['auth']} - "
              f"is {h['ssh']['user']} allowed to sudo there?", file=sys.stderr)
    return rc if rc >= 0 else 1


def revoke_on(h, tag_re):
    """Take this Box's key (TAG_RE) off Host H by its name (`ssh NAME`, never a shared connection): None when it says
    it's done, else why not. A Windows Host (os: windows) gets the PowerShell script (winhost), on stdin."""
    from . import winhost
    if is_windows(h):
        try:
            done = winhost.over_key(h, "remove", tag_re)
        except RuntimeError as e:
            return str(e)
        from .errors import KEY_FILE
        for w in done.warnings:             # on stderr: the ok/FAIL lines stay one per Host
            print(f"warning: [{KEY_FILE}] {h['name']}: {w} (roster-managed:{tag_name(tag_re)})",
                  file=sys.stderr, flush=True)
        other_names(h, tag_re, done.tags)
        return None
    r = subprocess.run(program_argv(["ssh", "-o", "BatchMode=yes", "-o", "ControlPath=none", h["name"],
                                     remove_script(tag_re, h["ssh"]["user"])]),
                       stdin=subprocess.DEVNULL, capture_output=True, text=True)
    subprocess.run(program_argv(["ssh", "-O", "exit", h["name"]]), capture_output=True)  # drop cached connection
    if "ROSTER_OK" in r.stdout:
        other_names(h, tag_re, [ln.split()[1] for ln in r.stdout.splitlines() if ln.startswith("ROSTER_TAG ")])
        return None
    if winhost.looks_windows(r.stdout + r.stderr):
        return winhost.windows_hint(h["name"])
    return (r.stderr or r.stdout).strip()[:200] or f"no answer (exit {r.returncode})"


def tag_name(tag_re):
    """The Box name in TAG_RE (cfg's tag_re, or box_key_re's, which starts with it)."""
    m = re.search(r":([A-Za-z0-9_-]+)" + re.escape(KEY_TRAIL), tag_re)
    return m[1] if m else "?"


@dataclass(frozen=True)
class NoLine:
    """retag_on: the key works there, but no roster-managed line for it is in FILE (the key file sshd reads there)."""
    file: str


TAKEN = "name taken"        # retag_on: another key's line is under the new name there (T226): nothing changed


def retag_on(h, pub, taken=None):
    """Re-tag this Box's key lines on key Host H with PUB's tag (T217), in place, found by its public key under any
    roster-managed name, over `ssh NAME` with the key itself: None when done, a NoLine when there's none to re-tag,
    TAKEN when TAKEN (the new name's tag_re) matches another key's line there, else why not. A Windows Host's
    warnings go to stderr, as revoke's do."""
    from . import winhost
    kind, key = pub.split()[:2]
    try:
        if is_windows(h):
            done = winhost.over_key(h, "retag", key_ere(kind, key), pub=pub, taken=taken or "",
                                    own=key_ere(kind, key) if taken else "")
            from .errors import KEY_FILE
            for w in done.warnings:
                print(f"warning: [{KEY_FILE}] {h['name']}: {w}", file=sys.stderr, flush=True)
            if done.taken:
                return TAKEN
            return NoLine(done.files[0] if done.files else "its key file") if done.noline else None
        r = subprocess.run(program_argv(["ssh", "-o", "BatchMode=yes", "-o", "ControlPath=none", h["name"],
                                         "sh -c " + shlex.quote(retag_key_script(pub, h["ssh"]["user"], taken))]),
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as e:     # ValueError: an ssh that won't take it
        return str(e)
    if "ROSTER_TAKEN" in r.stdout.split():
        return TAKEN
    none = [ln for ln in r.stdout.splitlines() if ln.split()[:1] == ["ROSTER_NONE"]]
    if none:
        return NoLine(none[0].partition(" ")[2].strip() or "~/.ssh/authorized_keys")
    if "ROSTER_OK" in r.stdout:
        return None
    return (r.stderr or r.stdout).strip()[:200] or f"no answer (exit {r.returncode})"


def other_names(h, tag_re, names):
    """#423's M3: revoke took this Box's key line tagged with NAMES; one that isn't this Inventory's name (another
    Inventory's box_name: for the same key, or this Box's earlier name) is said, on stderr."""
    mine = tag_name(tag_re)
    for n in sorted(set(names) - {mine}):
        print(f"note: {h['name']}: also took this Box's key line tagged {KEY_TAG}:{n} (the same key: this Box's "
              "earlier name, or another Inventory's box_name:, whose `roster setup` puts it back)",
              file=sys.stderr, flush=True)


def remove_script(tag_re, user):
    """The POSIX key-removal command for the Login's USER: sh with the script as its argument."""
    return "sh -c " + shlex.quote(remove_key_script(tag_re, user))


def revoke_line(label, h, why):
    say(f"  {'ok  ' if why is None else 'FAIL'}  {label}{h['name']}" + ("" if why is None else f": {why}"))


def check_ssh_takes(script):
    """Before revoke asks or connects: an ssh roster won't hand SCRIPT (on Windows, a batch file, as cmd.exe would act
    on the script's characters) is a clean error (code 149), not a traceback half way through the Hosts."""
    from .errors import SSH_REFUSES_SCRIPT
    try:
        program_argv(["ssh", "-o", "BatchMode=yes", "host", script])
    except ValueError as e:
        die(f"[{SSH_REFUSES_SCRIPT}] {e} - nothing was revoked: put OpenSSH's ssh.exe first on PATH")


def cmd_revoke(cfg, args):
    keyed = [h for h in selected(cfg, args.only) if h["enroll"]]
    hosts = skip_left_out(keyed)
    warn_os(hosts)
    mine = box_key_re(cfg)                  # T217: its key under an earlier name too
    for user in sorted({h["ssh"]["user"] for h in hosts if not is_windows(h)}):
        check_ssh_takes(remove_script(mine, user))
    if not args.yes:
        ans = input(f"Remove key '{cfg['tag']}' from {len(hosts)} hosts? This box loses access. [y/N] ")
        if ans.strip().lower() != "y":
            return 1
    bad = 0
    with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
        for h, why in zip(hosts, ex.map(lambda h: revoke_on(h, mine), hosts), strict=True):
            bad += why is not None
            revoke_line("", h, why)
    done = f"\nremoved from {len(hosts) - bad}/{len(hosts)} hosts."
    # T194 (#371): the files go only once every Host this file names has lost the key; with any skipped, failed or
    # left to --only, deleting the key would leave it on those for good
    every = len(hosts) == len(keyed) and not args.only
    if bad or not hosts or not every:
        why = ("nothing was revoked" if not hosts else "hosts above were skipped or failed" if bad or len(hosts) <
               len(keyed) else "--only left this file's other hosts with the key")
        say(f"{done} Not finished: {why}. Keep this box's key and ssh config files until every host of this "
            "roster.yml has lost the key (`roster revoke` without --only names them then).")
    else:
        from .inventories import unnamed_from_elsewhere
        files = [str(cfg["key"]), str(cfg["pub"])]
        # never another roster.yml's config.d/roster (#371): its Hosts still need it
        if unnamed_from_elsewhere() is None:
            files.append(str(ssh_config_file()))
        if key_name_file().is_file():       # the name setup recorded the key's lines under (T226, #435)
            files.append(str(key_name_file()))
        say(f"{done} To finish, delete {', '.join(files[:-1])} and {files[-1]} on this box.")
    return 1 if bad or len(hosts) < len(keyed) or not hosts else 0


def revoke_targets():
    """`revoke --all`'s Inventories: [(label, name or None, roster.yml)], every named one in the order they were
    named, then the unnamed one: the roster.yml roster's unnamed ssh config was last written from (the only unnamed
    one whose Hosts `ssh NAME` reaches), unless it's a named one's file."""
    from . import inventories
    inv = inventories.load()
    out: list[tuple[str, str | None, Path]] = [(x.name, x.name, x.path) for x in inv.inventories]
    unnamed = inventories.unnamed_source()
    if unnamed is not None and not any(inventories.same_file(x.path, unnamed) for x in inv.inventories
                                       if x.path.exists()):
        out.append(("(unnamed)", None, unnamed))     # in brackets: no named Inventory's name can have one
    return out


def cmd_revoke_all(args):
    """T183 (#347): `roster revoke` for every Inventory on this Box at once, with one question and one summary. Each
    Inventory is loaded and reached by its own name (this run's Inventory is never switched), and a Host is reached
    only by a name `ssh NAME` takes to that Inventory's Host: never a left-out one, never one whose Inventory isn't in
    this Box's ssh config."""
    from . import inventories
    inventories.rebuild_if_stale()
    targets = revoke_targets()
    if not targets:
        say("no Inventory has written its ssh config on this Box (`roster inv list` names them): nothing to revoke")
        return 1
    plan: list[tuple[str, dict[str, Any], list[dict[str, Any]]]] = []
    problems = 0
    left_alone = 0                          # left-out Hosts: skipped, so not finished (exit 1, T194)
    for label, name, path in targets:
        again = f"roster --inv {name}" if name else f"roster -c {shlex.quote(str(path))}"
        try:
            cfg = load_config(path)
        except SystemExit:                  # its words could quote a line of that file: they stay with it
            say(f"  {label}: its roster.yml doesn't load or isn't there ({path}) - not revoked (`{again} check "
                "--box` says why)")
            problems += 1
            continue
        keyed = [h for h in cfg["hosts"].values() if h["enroll"]]
        reach = inventories.reachable_hosts(name)
        if reach is None:
            if keyed:
                say(f"  {label}: not in this Box's ssh config, so `ssh NAME` doesn't reach its Hosts - its "
                    f"{len(keyed)} hosts not revoked (`{again} sync` writes it, then `{again} revoke`)")
                problems += 1
            continue
        left = inventories.left_out_hosts(name)
        hosts = []
        for h in keyed:
            if h["name"] in reach:
                hosts.append(h)
            elif h["name"] in left:
                say(f"  {label}: {h['name']}: " + LEFT_OUT.format(name=h["name"]))
                left_alone += 1
            else:
                say(f"  {label}: {h['name']}: not in this Box's ssh config yet - not revoked (`{again} sync`, then "
                    f"`{again} revoke`)")
                problems += 1
        plan.append((label, cfg, hosts))
    total = sum(len(hosts) for _, _, hosts in plan)
    for _, cfg, hosts in plan:
        for user in sorted({h["ssh"]["user"] for h in hosts if not is_windows(h)}):
            check_ssh_takes(remove_script(box_key_re(cfg), user))
    if not args.yes:
        tags = ", ".join(sorted({f"'{cfg['tag']}'" for _, cfg, _ in plan})) or "this box's key"
        counts = ", ".join(f"{label} {len(hosts)}" for label, _, hosts in plan)
        ans = input(f"Remove key {tags} from {total} hosts in {len(plan)} Inventories ({counts})? This box loses "
                    "access. [y/N] ")
        if ans.strip().lower() != "y":
            return 1
    jobs = [(label, h, box_key_re(cfg)) for label, cfg, hosts in plan for h in hosts]
    bad = 0
    with cf.ThreadPoolExecutor(max([cfg["workers"] for _, cfg, _ in plan] or [1])) as ex:
        for (label, h, _), why in zip(jobs, ex.map(lambda j: revoke_on(j[1], j[2]), jobs), strict=True):
            bad += why is not None
            revoke_line(f"{label}: ", h, why)
    files = []
    for _, cfg, _ in plan:
        files += [str(cfg["key"]), str(cfg["pub"])]
    files += [str(ssh_config_file(name)) for _, name, _ in targets if ssh_config_file(name).is_file()]
    files += [str(key_name_file(name)) for _, name, _ in targets if key_name_file(name).is_file()]
    from .common import ssh_index_file
    if ssh_index_file().is_file():
        files.append(str(ssh_index_file()))
    files = list(dict.fromkeys(files))
    done = f"\nremoved from {total - bad}/{total} hosts in {len(plan)} Inventories."
    if bad or problems or left_alone:
        # #367's review, F3: with the key files gone, roster could never take this box's key off what was skipped
        say(f"{done} Not finished: hosts or Inventories above were skipped or failed. Revoke those first (each line "
            "above says how); only then delete this box's key and ssh config files (plain `roster revoke` names "
            "them).")
    elif files:
        say(f"{done} To finish, delete {', '.join(files[:-1])} and {files[-1]} on this box." if len(files) > 1 else
            f"{done} To finish, delete {files[0]} on this box.")
    else:
        say(done)
    return 1 if bad or problems or left_alone or not total else 0


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
            say(f"  {c['level']:<5}  {c['message']}")
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
    sync (vaultsync): names and counts, never a value."""
    from . import fromvault, vaultsync
    used = sorted(p for p in fromvault.refs(cfg["path"]) if p in PROVIDERS and p not in ("env", "cmd", "prompt"))
    if not used:
        say("roster.yml's Logins use no vault: nothing to sync")
        return 0
    bad = 0
    for p in used:
        try:
            r = vaultsync.sync(p, interactive=sys.stdin.isatty())
        except RuntimeError as e:
            bad += 1
            say(f"  FAIL  {p}: {e}")
            if p in fromvault.UNLOCK and isinstance(e, providers_locked()):
                say(f"        fix: {fromvault.UNLOCK[p]}")
            continue
        if r is None:
            say(f"  ok    {p}: keeps no local copy (it asks its own server or file each time), nothing to sync")
        elif r["count"] is None:
            say(f"  ok    {p}: synced")
        elif r["first"]:
            say(f"  ok    {p}: synced, {plural(r['count'], 'item')}; first sync, so changes are counted from now on")
        elif not (r["added"] or r["changed"] or r["removed"]):
            say(f"  ok    {p}: synced, no change since the last sync")
        else:
            parts = [f"{len(r[k])} {k}: {', '.join(r[k])}" for k in ("added", "changed") if r[k]]
            parts += [f"{r['removed']} removed"] if r["removed"] else []
            say(f"  ok    {p}: synced; since the last sync, {'; '.join(parts)}")
    return 1 if bad else 0


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
    """`roster check --auth --json`: one row per (Login reference, group), never the value it found."""
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
    from . import jsondocs
    jsonout.emit(jsondocs.LoginsDoc.model_validate({"logins": rows, "ok": ok}))
    return 0 if ok else 1


def used_for(uses):
    """'ssh (12 hosts), https (orion3)' - which services on which hosts use one password source."""
    by_svc = {}
    for svc, host, _ in uses:
        by_svc.setdefault(svc, []).append(host)
    return ", ".join(f"{svc} ({hs[0] if len(hs) == 1 else f'{len(hs)} hosts'})" for svc, hs in by_svc.items())


# `roster vault bw` (T202, decision Q178): which bw commands run, as a fail-closed allowlist. A command in none of these sets
# (one a newer bw adds, a typo) is refused, never assumed safe.
# Read-only means no change to the vault and no file written on this Box: `get attachment` and any `--output` write
# one, and `receive` writes what a Send from anyone's URL holds, so they need --write.
BW_READ = frozenset({"list", "get", "status", "sync", "generate", "encode", "help", "completion", "update"})
BW_WRITE = frozenset({"create", "edit", "delete", "restore", "move", "share", "confirm", "import", "send",
                      "device-approval", "export", "receive"})  # change the vault, or write files here
BW_ACCOUNT = frozenset({"login", "logout", "unlock", "lock", "config"})  # need --write too
BW_PROMPTS = frozenset({"login", "unlock"})  # ask for the master password on the terminal: no --nointeraction added
BW_FLAGS = frozenset({"--pretty", "--raw", "--response", "--cleanexit", "--quiet", "--nointeraction",
                      "-h", "--help", "-v", "--version"})  # bw's own options that may come before its command


def bw_command(argv, write):
    """The bw command ARGV runs (None for bw's bare options, `--help` or `--version`), or die() saying why it may not
    run. Nothing after the command is ever repeated: it may hold a password."""
    from .errors import BW_NEEDS_WRITE, BW_NOT_ALLOWED, BW_REFUSED
    if any(a == "--session" or a.startswith("--session=") for a in argv):
        die(f"[{BW_REFUSED}] roster vault bw won't put a session key on bw's command line, where other programs can read "
            "it: roster passes this Box's session in bw's environment (drop --session)")
    if "--write" in argv:
        die(f"[{BW_NOT_ALLOWED}] --write is roster's, not bw's: put it before bw's command "
            "(roster vault bw --write -- edit item ...)")
    cmd = next((a for a in argv if not a.startswith("-")), None)
    if any(a not in BW_FLAGS for a in argv[:argv.index(cmd) if cmd else len(argv)]):
        die(f"[{BW_NOT_ALLOWED}] roster vault bw takes only these bw options before the command: "
            f"{', '.join(sorted(BW_FLAGS))}")
    rest = argv[argv.index(cmd) + 1:] if cmd else []
    writes_file = any(a == "--output" or a.startswith("--output=") for a in argv) or \
        (cmd == "get" and any(a.lower() == "attachment" for a in rest))  # bw lowercases it, options may go first
    if (cmd is None or cmd in BW_READ) and not writes_file:
        return cmd
    if cmd == "serve":
        die(f"[{BW_REFUSED}] roster vault bw won't run bw serve: it would hand the unlocked vault to every program on this "
            "Box that can reach its port. Run bw serve yourself if you need it")
    if cmd in BW_WRITE or cmd in BW_ACCOUNT or writes_file:
        if not write:
            what = "acts on the vault's account" if cmd in BW_ACCOUNT else \
                "writes the whole vault out" if cmd == "export" else \
                "writes a file on this Box" if cmd == "receive" or writes_file else "changes the vault"
            die(f"[{BW_NEEDS_WRITE}] bw {cmd} {what}, and roster vault bw is read-only unless you say so: "
                f"roster vault bw --write -- {cmd} ...")
        return cmd
    die(f"[{BW_NOT_ALLOWED}] roster vault bw runs only the bw commands it knows (the first word isn't one of them, and "
        f"isn't repeated here): {', '.join(sorted(BW_READ))}; with --write, {', '.join(sorted(BW_WRITE | BW_ACCOUNT))}")


def cmd_bw(args):
    """The Bitwarden CLI with this box's vault session (~/.config/roster/bw-session), so scripts and
    Claude sessions don't each carry BW_SESSION around. Read-only unless --write (bw_command); never prompts
    (--nointeraction is added) except `login` and `unlock`. bw's output goes straight to the terminal: roster never
    reads it."""
    from .providers.bitwarden import load_session_file, session_key
    argv = args.args[1:] if args.args[:1] == ["--"] else list(args.args)
    if not argv:
        die("usage: roster vault bw [--write] -- <bw arguments>   e.g.  roster vault bw -- list items --search web-01")
    cmd = bw_command(argv, args.write)
    load_session_file()
    if "--nointeraction" not in argv and cmd not in BW_PROMPTS:  # before a `--`, after which it'd be an argument
        argv.insert(argv.index("--") if "--" in argv else len(argv), "--nointeraction")
    key = session_key()
    # only bw's session: no 1Password variable (OP_SESSION_*, OP_SERVICE_ACCOUNT_TOKEN, OP_CONNECT_TOKEN, ...) goes to
    # bw (#388). Windows upper-cases env names
    env = {**{k: v for k, v in os.environ.items() if not k.upper().startswith("OP_")},
           **({"BW_SESSION": key} if key else {})}
    try:
        return subprocess.run(program_argv(["bw", *argv]), env=env).returncode
    except ValueError as e:
        die(str(e))
    except FileNotFoundError:
        die("bw (the Bitwarden CLI) isn't installed")


def cmd_inv(args):
    """`roster inv`: name Inventories, pick the active one, forget one, and say which roster.yml roster uses."""
    from . import inventories
    from .config import locate_config
    act = args.action
    takes = {"list": 0, "which": 0, "use": 1, "remove": 1, "add": 2}[act]
    given = [x for x in (args.name, args.path) if x is not None]
    if len(given) != takes:
        build_parser().error({0: f"inv {act} takes no NAME or PATH", 1: f"usage: roster inv {act} NAME",
                              2: "usage: roster inv add NAME PATH"}[takes])
    if args.json and act not in ("list", "which"):
        build_parser().error("--json goes with inv list or inv which")
    if act == "which":
        path = locate_config(args.config, args.inv)
        name = args.inv or inventories.name_of(path)
        if args.json:
            from . import jsondocs
            jsonout.emit(jsondocs.WhichDoc(path=str(path.expanduser().resolve()), name=name, exists=path.is_file()))
            return 0 if path.is_file() else 1
        if not path.is_file():
            die(f"roster would use {path}, but it isn't there")
        say(str(path.expanduser().resolve()))
        return 0
    if act == "list":
        inv = inventories.load()
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
        say(f"named {args.name}: {inventories.path_of(args.name)}"
            + (f"; {args.name} is the active Inventory" if added.first else f" (`roster inv use {args.name}` makes it "
               "the active one)"))
        if added.mesh_state:
            say(f"its Mesh state (from this file's `roster mesh` before it was named) is in {added.mesh_state} now")
        if added.mesh_kept:
            say(f"note: {inventories.mesh_state_file(None)} stays with the unnamed Inventory: {added.mesh_kept} "
                f"(move it to {inventories.mesh_state_file(args.name)} by hand if it is)")
        say(f"note: `roster --inv {args.name} sync` writes its ssh config and ROSTER.md here "
            f"(`roster --inv {args.name} setup` on a new Box)")
        return 0
    if act == "use":
        inventories.use(args.name)
        name = inventories.canonical(args.name)
        say(f"{name} is the active Inventory: {inventories.path_of(name)}")
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
    if not inventories.load().inventories:
        say("note: no named Inventories are left: run `roster sync` so ~/.ssh/config reaches this Box's Hosts again")
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    never_look_in_the_current_folder()      # Windows: nothing roster starts looks for its program in the cwd (#424)
    if argv[:1] == ["__complete"]:       # the shell's Tab (completion.py): never an error, never a usage message
        from . import completion
        return completion.main(argv[1:])
    argv, alias = aliases.rewrite(argv)  # an old name (roster info, roster bw): its new form, said once on stderr
    words = argv[:argv.index("--")] if "--" in argv else argv
    Parser.json_errors = "--json" in words
    if alias and not alias.silent and not Parser.json_errors:      # with --json, stderr is a JSON error or nothing
        print(aliases.warning(alias), file=sys.stderr, flush=True)
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
    """roster's argument parser: with --json on the command line, a usage error is JSON on stderr (exit 2). A
    mistyped command gets the nearest name instead of the whole list, and every usage error says where help is.
    roster's own --help lists the commands in groups (clihelp.GROUPS) before its options."""
    json_errors = False
    commands_text = ""

    def error(self, message):
        # a value typed onto a flag that takes none (`roster vault bw --write=VALUE`) may be a password: never repeat it
        message = re.sub(r"ignored explicit argument '.*'", "ignored explicit argument (not repeated)", message)
        message = clihelp.suggest(message, self.all_options())
        if Parser.json_errors:
            jsonout.fail(ROSTER_ERROR, f"{self.prog}: {message}", f"see `{self.prog} --help`")
            sys.exit(2)
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: {message}\n(`{self.prog} --help` shows how)\n")

    def all_options(self):
        """Every --option of this parser and its commands' (an unknown one is reported by roster's own parser)."""
        found = []
        for a in self._actions:
            found += [o for o in a.option_strings if o.startswith("--")]
            if isinstance(a, argparse._SubParsersAction):
                for s in a.choices.values():
                    found += s.all_options()
        return sorted(set(found))

    def format_help(self):
        text = super().format_help()
        if not self.commands_text:
            return text
        head, sep, tail = text.partition("\noptions:\n")
        return f"{head}\n{self.commands_text}\n{sep}{tail}" if sep else f"{text}\n{self.commands_text}\n"


def build_parser():
    """Every command and option. The man page (roster.manpage) is generated from this too."""
    p = Parser(prog="roster", usage=clihelp.USAGE, formatter_class=clihelp.Formatter,
               description="Give this box (and Claude) access to the hosts in roster.yml.")
    p.add_argument("-v", "--version", action="version", version=f"roster {__version__}")
    which = p.add_mutually_exclusive_group()
    values(which.add_argument("-c", "--config", metavar="PATH", help="path to roster.yml (default: $ROSTER_CONFIG, "
                       "./roster.yml, the active named Inventory, then ~/.config/roster/roster.yml)"), FILES)
    values(which.add_argument("--inv", metavar="NAME", help="use the named Inventory NAME for this one command "
                              "(`roster inv list` names them)"), INVENTORIES)
    # no COMMAND: _main shows the overview. The commands are listed by commands_text (in groups), not argparse
    # prog: each command's usage is `roster run ...`, not built from the usage above (the man page's synopsis too)
    sub = p.add_subparsers(dest="cmd", metavar="COMMAND", help=argparse.SUPPRESS, prog="roster")
    only: dict[str, Any] = {"metavar": "LIST", "help": "only these hosts, groups, types or products (comma-separated)"}
    as_json: dict[str, Any] = {"action": "store_true", "help": "print JSON for scripts and tools, never a secret (see "
               "Machine-readable output in docs/cli-reference.md)"}
    s = sub.add_parser("init", help="write a new roster.yml: the commented example, a blank one, a copy, the team's "
                       "repo or the Hosts in ~/.ssh/config. It only makes a new file: to add Hosts to yours, use add or "
                       "discover")
    how = s.add_mutually_exclusive_group()
    how.add_argument("--blank", action="store_true", help="a short roster.yml with an empty group, instead of the "
                     "commented example (same as --inventory blank)")
    how.add_argument("--inventory", metavar="HOW", help="blank, file:PATH (a copy of that roster.yml, once it loads), "
                     "repo:URL (a git clone of the team's repo into roster.yml's folder, which must be empty) or "
                     "ssh-config[:PATH] (Hosts from ~/.ssh/config, or PATH: HostName, User, Port, IdentityFile)")
    s.add_argument("--name", metavar="NAME", help="name the new Inventory too (`roster inv add NAME PATH`), e.g. "
                   "beside one you keep")
    s = sub.add_parser("setup", help="install this Box's key on the Hosts that aren't set up yet and record their host "
                       "keys, then sync; run it again after adding Hosts")
    which = s.add_mutually_exclusive_group()
    values(which.add_argument("--only", **only), ONLY, HOSTS, GROUPS)
    values(which.add_argument("--host", metavar="NAME", help="only the Host by exactly this name, never a group, type "
                              "or product by it (--only would take those too)"), HOSTS)
    s.add_argument("--dry-run", action="store_true", help="show what would happen, change nothing remote")
    s.add_argument("--force", action="store_true", help="on a renamed Box, go ahead on a Host where another Box's "
                   "key line has the new name (its line is then this Box's to replace or revoke)")
    sub.add_parser("sync", help="rewrite this Box's ssh config and Claude files from roster.yml; it touches no Host")
    s = sub.add_parser("check", help="check: can this Box reach every Host? check HOST: why a Session to it would "
                       "fail, step by step. check --box: this Box's own health. check --auth: every Login's password "
                       "source answers")
    values(s.add_argument("host", nargs="?", help="diagnose this one Host: inventory, ssh config, vault, DNS, port, "
                   "host key, login (one connection)"), HOSTS)
    s.add_argument("--box", action="store_true", help="check this Box instead, without connecting anywhere: "
                   "roster.yml, ssh and its config, vault CLIs, askpass, the infra repo")
    s.add_argument("--auth", action="store_true", help="test each Login's password source (SSH, services, "
                   "resources) instead, connecting to no Host and printing nothing secret")
    values(s.add_argument("--only", **only), ONLY, HOSTS, GROUPS)
    s.add_argument("--json", **as_json)
    s = sub.add_parser("hosts", help="list the Hosts and resources in roster.yml; hosts NAME: everything about one; "
                       "hosts --resources: only the resources")
    values(s.add_argument("name", nargs="*", metavar="NAME", help="show everything about this one Host or resource; "
                          "fuzzy words work"), HOSTS, RESOURCES)
    s.add_argument("--resources", action="store_true", help="list only the resources (Wi-Fi networks, accounts and "
                   "secrets with no address); --only then takes resource names, types or groups, --find every field")
    values(s.add_argument("--only", **only), ONLY, HOSTS, GROUPS, RESOURCES)
    s.add_argument("--find", metavar="TEXT", help="search name, title, description, type, product, group, ip")
    s.add_argument("--all", action="store_true", help="include unreviewed (scanned) hosts")
    s.add_argument("--long", action="store_true", help="full table: type, product, web URL, description")
    s.add_argument("--json", **as_json)
    s = sub.add_parser("run", help="run a command on a host")
    s.add_argument("--sudo", action="store_true",
                   help="run it as root with sudo; roster gives sudo the login's password (never shown)")
    values(s.add_argument("host", help="the host to run it on"), HOSTS)
    s.add_argument("command", nargs=argparse.REMAINDER, help="the command, after --")
    s = sub.add_parser("add", help="add one Host you already know to roster.yml (reviewed), the app's add-Host "
                       "way")
    s.add_argument("name", metavar="NAME", nargs="?", help="the new Host's name: letters, digits, . _ - (needed "
                   "unless --from-vault)")
    s.add_argument("--ip", metavar="ADDR", help="its address: an IPv4 or IPv6 address or a DNS name (asked for in a "
                   "terminal when it's missing)")
    s.add_argument("--user", metavar="USER", help="the SSH user (default: its group's or defaults')")
    s.add_argument("--auth", metavar="REF", help="its Login: a vault item (bw:ITEM, op:...), env:VAR, prompt, key "
                   "... (default: its group's or defaults')")
    values(s.add_argument("--group", metavar="GROUP", help="the group it goes in: an existing one, or a new one "
                          "(default: the first group; asked in a terminal)"), GROUPS)
    on = s.add_mutually_exclusive_group()
    on.add_argument("--enroll", dest="enroll", action="store_true", default=None,
                    help="install this Box's key on it at setup (asked in a terminal; default: its group's)")
    on.add_argument("--no-enroll", dest="enroll", action="store_false", help="password logins only, no key")
    s.add_argument("--os", choices=["windows", "posix"], help="windows for a Windows Host with OpenSSH Server "
                   "(default: posix)")
    s.add_argument("--title", metavar="TEXT", help="a one-line title")
    s.add_argument("--type", metavar="TEXT", help="a free label (nas, switch, esxi, ...)")
    s.add_argument("--port", type=int, metavar="N", help="its SSH port (default: 22)")
    s.add_argument("--from-vault", action="store_true", help="fill --ip (and --port) from the --auth item's URI and "
                   "--user from its username, never reading its password (bw); flags given win. With no NAME: list "
                   "the vault items no Login in roster.yml names (new ones since the last run), and in a terminal "
                   "add each one [Y/n/edit/skip]")
    s.add_argument("--json", action="store_true", help="with --from-vault and no NAME: print the list as JSON, add "
                   "nothing")
    s.add_argument("--all", action="store_true", help="with --from-vault and no NAME: every item roster.yml doesn't "
                   "name, not only the new ones")
    s.add_argument("--mark-seen", action="store_true", help="with --from-vault and no NAME: remember every item "
                   "listed as seen, so it isn't new next time")
    s.add_argument("--no-sync", action="store_true", help="with --from-vault and no NAME: don't sync the vault first "
                   "(bw sync)")
    s.add_argument("--setup", action="store_true", help="then run setup for it alone (its host key, and this Box's "
                   "key on it when enrolled) and check it, and say how each went")
    s.add_argument("--dry-run", action="store_true", help="print the lines it would add; write nothing")
    s.add_argument("-y", "--yes", action="store_true", help="never ask: a missing value it can't default is an "
                   "error naming its flag")
    s = sub.add_parser("discover", help="scan networks (nmap if installed) for Hosts; --write adds the new ones to "
                       "roster.yml, unreviewed")
    s.add_argument("targets", nargs="+", metavar="CIDR", help="e.g. 10.0.1.0/24 (several allowed)")
    s.add_argument("--write", action="store_true", help="add the new Hosts it finds to roster.yml, unreviewed, for you "
                   "to name and review (default: preview only)")
    values(s.add_argument("--group", metavar="NAME", help="group name for new hosts (default: discovered-YYYYMMDD)"),
           GROUPS)
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
    s = sub.add_parser("web", help="HTTP request to a host's web service, logged in with its stored credentials")
    values(s.add_argument("request", nargs="+", metavar="HOST [SERVICE] METHOD PATH",
                          help="e.g. esxi GET /folder  or  orion3 https GET /api/status"), HOSTS)
    s.add_argument("-d", "--data", metavar="BODY", help="request body (@FILE reads a file)")
    s.add_argument("-H", "--header", action="append", metavar="HEADER", help="extra header 'Name: value' (repeatable)")
    s.add_argument("-k", "--insecure", action="store_true", help="don't verify the TLS certificate")
    s.add_argument("--timeout", type=float, default=30, metavar="SECONDS",
                   help="how long to wait for the answer (default: 30)")
    s = sub.add_parser("mesh", help="set up Host-to-Host access (mesh: and links: in roster.yml), one Host at a time")
    s.add_argument("action", nargs="?", choices=["cut", "status", "leftovers"],
                   help="cut HOST: take it out of the Mesh now, everywhere; status: who reaches whom (no connections); "
                        "leftovers: look on every Host, once, for Mesh entries this roster.yml doesn't ask for (this "
                        "Box's, or an older roster's with no Box in the tag); changes nothing without --remove")
    values(s.add_argument("target", nargs="?", metavar="HOST", help="with cut: the Host to cut out"), HOSTS)
    s.add_argument("--dry-run", action="store_true", help="show the plan; change nothing on any Host")
    values(s.add_argument("--rotate", action="append", metavar="HOST", help="replace HOST's Mesh key (repeatable)"),
           HOSTS)
    s.add_argument("-y", "--yes", action="store_true", help="with cut or leftovers --remove: don't ask first")
    s.add_argument("--all", action="store_true", help="with cut: every Mesh entry off every Host, roster.yml "
                   "unchanged (before removing roster from this Box)")
    s.add_argument("--remove", action="store_true", help="with leftovers: then remove them after a question (-y "
                   "doesn't ask): an older roster's may be another Box's Mesh")
    s.add_argument("--json", action="store_true", help="with status or --dry-run: print JSON for scripts and "
                   "tools, never a secret (see Machine-readable output in docs/cli-reference.md)")
    s = sub.add_parser("revoke", help="remove this box's key from all hosts")
    values(s.add_argument("--only", **only), ONLY, HOSTS, GROUPS)
    s.add_argument("--all", action="store_true", help="every Inventory on this box: each named one and the unnamed "
                   "one, with one question and one summary")
    s.add_argument("-y", "--yes", action="store_true", help="don't ask first")
    s = sub.add_parser("inv", help="named Inventories (work, home): list, add NAME PATH, use NAME, remove NAME, "
                       "or which (the roster.yml roster uses)")
    s.add_argument("action", choices=["list", "add", "use", "remove", "which"],
                   help="list (the active one marked *), add NAME PATH, use NAME (make it the active one), "
                        "remove NAME (forget the name; the file stays), which (print the roster.yml roster uses)")
    values(s.add_argument("name", nargs="?", metavar="NAME", help="the Inventory's name: letters, digits, . _ -"),
           INVENTORIES, new_after=("add",))
    values(s.add_argument("path", nargs="?", metavar="PATH", help="with add: its roster.yml"), FILES)
    s.add_argument("--json", **as_json)
    s = sub.add_parser("vault", help="roster's own views of the vault: status, sync, reveal NAME, and bw -- ARGS (the "
                       "Bitwarden CLI itself)")
    vault = s.add_subparsers(dest="vault_cmd", metavar="ACTION", title="actions", prog="roster vault",
                             help="what to do with the vault (plain `roster vault` lists them)")
    s = vault.add_parser("status", help="the password providers here (built-in, plugins, roster.yml), whether their "
                         "tools are installed, unknown ones in use, each vault's state (logged in, locked) and when it "
                         "last synced")
    s.add_argument("--json", **as_json)
    vault.add_parser("sync", help="sync every vault that keeps a local copy (Bitwarden: bw sync), then say which "
                     "items were added, changed or removed since the last sync: names and counts, never a secret")
    s = vault.add_parser("reveal", help="print a resource's secret (e.g. a Wi-Fi password) for a person to type in, "
                         "not for Claude")
    values(s.add_argument("name", help="the resource"), RESOURCES)
    s.add_argument("--wifi", action="store_true", help="print a WIFI:... string for a QR code instead")
    s = vault.add_parser("bw", help="run the Bitwarden CLI itself with this Box's vault session (bw-session file), "
                         "read-only unless --write; roster never reads what it prints")
    s.add_argument("--write", action="store_true",
                   help="allow bw commands that change the vault, write a file here or act on the account "
                        "(create, edit, delete, export, receive, --output, login, logout, unlock, lock, config, ...)")
    s.add_argument("args", nargs=argparse.REMAINDER, metavar="BW_ARGS", help="arguments for bw, after --")
    s = sub.add_parser("help", help="this overview; help COMMAND: a command's options and examples; --man: the "
                       "manual; --completion SHELL: Tab completion")
    values(s.add_argument("topic", nargs="*", metavar="COMMAND", help="the command (and its action: vault bw) to show "
                          "the help of"), COMMANDS)
    s.add_argument("--man", action="store_true", help="show the roster(1) man page")
    s.add_argument("--install", action="store_true", help="with --man: copy it to PREFIX/share/man/man1/, next to "
                   "PREFIX/bin/roster (~/.local for uv tool install), where `man roster` finds it")
    values(s.add_argument("--prefix", metavar="DIR", help="with --man --install: install into DIR/share/man/man1/ "
                          "instead"), DIRS)
    s.add_argument("--completion", choices=SHELLS, metavar="SHELL", help="print Tab completion for bash, zsh, fish "
                   "or powershell (install.sh turns it on)")
    # run by the app or by ssh, not by hand: kept out of the overview (clihelp.INTERNAL)
    sub.add_parser("serve", help="JSON-RPC API on stdin/stdout for the desktop app (see docs/serve-api.md)")
    s = sub.add_parser("askpass", help="SSH_ASKPASS helper for a `roster serve` password Session (ssh runs it)")
    s.add_argument("prompt", nargs="?", default="", help="the prompt ssh shows")
    helps = describe(sub)
    p.commands_text = clihelp.overview(helps)
    p.epilog = clihelp.more()
    return p


def describe(sub, prefix=""):
    """Each command's --help opens with its one-line help as a sentence and ends with examples (clihelp), a command
    with actions of its own (vault) too. Returns {name: one-line help}."""
    helps = {a.dest: a.help or "" for a in sub._choices_actions}
    for name, s in sub.choices.items():
        s.description = clihelp.description(helps[name])
        s.epilog = clihelp.examples_text(f"{prefix}{name}") or None
        s.formatter_class = clihelp.Formatter
        for a in s._actions:
            if isinstance(a, argparse._SubParsersAction):
                describe(a, f"{prefix}{name} ")
    return helps


def command_parser(parser, words):
    """The parser of `roster WORDS...` (`vault bw`), or a usage error naming the word that isn't a command."""
    for i, w in enumerate(words):
        found = next((a.choices for a in parser._actions if isinstance(a, argparse._SubParsersAction)), {})
        if w not in found:
            parser.error(f"no help for {' '.join(words[:i + 1])!r}: `roster help` lists the commands")
        parser = found[w]
    return parser


def inventory(args):
    """roster.yml, loaded. With --json, one that isn't found or doesn't load is a Problem (code 1, with its fix)."""
    path = None
    try:
        path = find_config(args.config, args.inv)
        return load_config(path)
    except SystemExit as e:
        if not getattr(args, "json", False):
            raise
        message = str(e.code).removeprefix("error: ")
        if message.startswith("no Inventory named "):
            raise Problem(UNKNOWN_INVENTORY, message, fix="`roster inv list` lists them") from None
        raise inventory_problem(str(e.code).removeprefix("error: "), path) from None


def _main(argv=None):
    parser = build_parser()
    args, extra = parser.parse_known_args(argv)
    is_bw = args.cmd == "vault" and args.vault_cmd == "bw"
    if extra and is_bw:                  # options before bw's command are bw's: its allowlist judges them, unrepeated
        args.args = [*extra, *args.args]
    elif extra:
        parser.error(f"unrecognized arguments: {' '.join(extra)}")

    if args.cmd is None:                    # plain `roster`: what it can do, not an argparse error
        sys.stdout.write(parser.format_help())
        return 0
    if args.cmd == "askpass":
        from .askpass import main as askpass_main
        return askpass_main([args.prompt])

    if args.cmd == "init":
        return cmd_init(args)
    if args.cmd == "help":
        return cmd_help(parser, args)
    if args.cmd == "vault" and args.vault_cmd is None:     # plain `roster vault`: its actions
        sys.stdout.write(command_parser(parser, ["vault"]).format_help())
        return 0
    if args.cmd == "discover":
        if args.json and args.write:
            build_parser().error("--json goes with discover's preview, not --write: drop one of them")
        return cmd_discover(args)
    if is_bw:
        return cmd_bw(args)
    if args.cmd == "inv":
        return cmd_inv(args)
    if args.cmd == "mesh" and args.json and args.action != "status" and not (args.dry_run and not args.action):
        build_parser().error("--json goes with mesh status or mesh --dry-run: it never applies the Mesh")
    if args.cmd == "mesh" and args.remove and args.action != "leftovers":
        build_parser().error("--remove goes with leftovers: roster mesh leftovers --remove")
    if args.cmd == "hosts" and args.name:
        listed = [f for f, on in (("--resources", args.resources), ("--find", args.find), ("--all", args.all),
                                  ("--long", args.long), ("--only", args.only)) if on]
        if listed:
            build_parser().error(f"hosts NAME shows one Host or resource: {', '.join(listed)} go{'es' if len(listed) == 1 else ''} "
                                 "with the list (drop NAME or the flag)")
    if args.cmd == "check" and args.auth and (args.box or args.host):
        build_parser().error("check --auth tests the Logins' password sources: it takes no HOST or --box (--only "
                             "narrows it)")
    if args.cmd == "add" and args.name is None and not args.from_vault:
        build_parser().error("roster add needs NAME, the new Host's name")
    if args.cmd == "add" and args.name is not None:
        listed = [f for f, on in (("--json", args.json), ("--all", args.all), ("--mark-seen", args.mark_seen),
                                  ("--no-sync", args.no_sync)) if on]
        if listed:
            build_parser().error(f"{', '.join(listed)} go{'es' if len(listed) == 1 else ''} with --from-vault and no "
                                 "NAME (the list of vault items): drop NAME or the flag")
    if args.cmd == "revoke" and args.all:
        if args.only or args.inv or args.config:
            build_parser().error("revoke --all revokes every Inventory's Hosts: drop --only, --inv and -c")
        return cmd_revoke_all(args)
    if args.cmd == "check" and args.box:
        if args.host or args.only:
            build_parser().error("check --box takes no HOST or --only: it checks this Box, not its Hosts")
        return cmd_check_box(args)
    if args.cmd == "check" and args.host:
        return cmd_check_host(args)
    if args.cmd == "serve":
        from .serve import serve
        return serve(args.config, args.inv)  # loads roster.yml itself, so a bad one becomes an API error
    if args.cmd == "vault" and args.vault_cmd == "status":
        try:
            cfg = load_config(find_config(args.config, args.inv))
        except SystemExit:
            cfg = None                              # no roster.yml yet: still list what's available
        setup_providers(cfg)
        return cmd_vault_status(cfg, args)
    cfg = inventory(args)
    setup_providers(cfg)
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
