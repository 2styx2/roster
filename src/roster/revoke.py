"""`roster revoke`: this Box's key off the Inventory's Hosts (authorized.revoke), or with --all off every Inventory's
on this Box (T183), each reached only by a name `ssh NAME` takes to that Inventory's Host, under the Box-wide lock.
The key files are deleted by hand, and only once every Host has lost the key: roster says which."""

import concurrent.futures as cf
import shlex
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from . import authorized, boxkeys, keyline, rotate, rotation
from .authorized import box_key_re, remove_script
from .boxsetup import LEFT_OUT, locked, skip_left_out, warn_os
from .common import die, program_argv, say
from .config import load_config, selected
from .context import Context, current, ssh_index_file
from .errors import KEY_FILE, KEY_FILE_SHARED, InventoryError, Problem, tagged
from .hosts import AccountLocks, account, is_windows


def revoke_on(h: dict[str, Any], tag_re: str) -> object:
    """Take this Box's key (TAG_RE) off Host H (authorized.revoke): None when it says it's done, else why not. A
    Windows Host's warnings, and the lines it took under another name, are said on stderr: the ok/FAIL lines stay
    one per Host."""
    done = authorized.revoke(h, tag_re)
    for w in done.warnings:
        print(f"warning: [{KEY_FILE}] {h['name']}: {w} ({keyline.tag(keyline.name_in(tag_re))})",
              file=sys.stderr, flush=True)
    if done.why is None:
        other_names(h, tag_re, done.names)
    return done.why


def in_turn(turn: AccountLocks) -> Any:
    """revoke_on, with Host entries that share an account (TURN's locks) taking turns (T258). Once one took TAG_RE's
    lines off that account, the others are done too: nothing of TAG_RE's is left there, and this Box's key no longer
    logs in to try."""
    done: dict[tuple[tuple[str, str], str], str] = {}

    def run(h: dict[str, Any], tag_re: str) -> object:
        with turn(h):
            if first := done.get((account(h), tag_re)):
                print(f"note: {h['name']}: the same account as {first} (its address and user), whose revoke took this "
                      "Box's key lines there", file=sys.stderr, flush=True)
                return None
            why = revoke_on(h, tag_re)
            if why is None:
                done[(account(h), tag_re)] = h["name"]
            return why
    return run


def other_names(h: dict[str, Any], tag_re: str, names: Iterable[str]) -> None:
    """#423's M3: revoke took this Box's key line tagged with NAMES; one that isn't this Inventory's name (another
    Inventory's box_name: for the same key, or this Box's earlier name) is said, on stderr."""
    mine = keyline.name_in(tag_re)
    for n in sorted(set(names) - {mine}):
        print(f"note: {h['name']}: also took this Box's key line tagged {keyline.tag(n)} (the same key: this Box's "
              "earlier name, or another Inventory's box_name:, whose `roster setup` puts it back)",
              file=sys.stderr, flush=True)


def key_files(cfg: dict[str, Any]) -> list[str]:
    """This Box's key files for CFG's Inventory, to delete once revoke is done: its own key's, and every other key
    type's it has (T239)."""
    out = [str(cfg["key"]), str(cfg["pub"])]
    for key in boxkeys.all_keys(cfg):
        if key.key != cfg["key"] and (key.key.exists() or key.pub.exists()):
            out += [str(key.key), str(key.pub)]
    return out


def kept_key_files(cfg: dict[str, Any], files: list[str]) -> list[str]:
    """Take out of FILES (revoke's to delete) each key file another Inventory on this Box uses too, and its .pub: a
    note (221) for each, naming the Inventory. When another Inventory's roster.yml doesn't load, no key file is
    listed: roster can't tell which it uses."""
    notes: list[str] = []
    users = rotate.key_users(cfg)
    broken = [u.label for u in users if u.cfg is None]
    keys = [Path(f) for f in files[::2]]                # key_files: each key, then its .pub
    for key in keys:
        base = Path(str(key).removesuffix(".new").removesuffix(".old"))    # a rotation's: its key's users' too
        who = [u.label for u in users if base in u.shared]
        if not who and not broken:
            continue
        files.remove(str(key))
        files.remove(str(key) + ".pub")
        why = ((f"the Inventory {who[0]} uses" if len(who) == 1 else f"the Inventories {', '.join(who)} use") +
               " it too: revoke there (`roster --inv NAME revoke`, or `roster revoke --all`) before deleting it" if who
               else f"{', '.join(broken)}: its roster.yml doesn't load, so roster can't tell whether it uses it")
        notes.append(f"note: {tagged(Problem(KEY_FILE_SHARED, f'keep {key}: {why}'))}")
    return notes


def revoke_line(label: str, h: dict[str, Any], why: object) -> None:
    say(f"  {'ok  ' if why is None else 'FAIL'}  {label}{h['name']}" + ("" if why is None else f": {why}"))


def check_ssh_takes(script: str) -> None:
    """Before revoke asks or connects: an ssh roster won't hand SCRIPT (on Windows, a batch file, as cmd.exe would act
    on the script's characters) is a clean error (code 149), not a traceback half way through the Hosts."""
    from .errors import SSH_REFUSES_SCRIPT
    try:
        program_argv(["ssh", "-o", "BatchMode=yes", "host", script])
    except ValueError as e:
        die(f"{e} - nothing was revoked: put OpenSSH's ssh.exe first on PATH", code=SSH_REFUSES_SCRIPT)


def revoke(cfg: dict[str, Any], only: str | None = None, yes: bool = False) -> int:
    """`roster revoke` (ONLY: --only; YES: don't ask), holding the Box-wide lock."""
    with locked("revoke"):
        return revoke_run(cfg, only, yes)


def revoke_run(cfg: dict[str, Any], only: str | None, yes: bool) -> int:
    keyed = [h for h in selected(cfg, only) if h["enroll"]]
    hosts = skip_left_out(keyed)
    warn_os(hosts)
    mine = box_key_re(cfg)                  # its key under an earlier name too
    for user in sorted({h["ssh"]["user"] for h in hosts if not is_windows(h)}):
        check_ssh_takes(remove_script(mine, user))
    if not yes:
        ans = input(f"Remove key '{cfg['tag']}' from {len(hosts)} hosts? This box loses access. [y/N] ")
        if ans.strip().lower() != "y":
            return 1
    bad = 0
    gone: list[str] = []
    with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
        for h, why in zip(hosts, ex.map(in_turn(AccountLocks()), hosts, [mine] * len(hosts)), strict=True):
            bad += why is not None
            revoke_line("", h, why)
            if why is None:
                gone.append(h["name"])
    # a Host without this Box's key holds no old key either; with every one done, no record
    rotation.forget(gone, everything=not bad and len(hosts) == len(keyed) and not only)
    boxkeys.record(dict.fromkeys(gone))     # no line of this Box's there now
    done = f"\nremoved from {len(hosts) - bad}/{len(hosts)} hosts."
    # the files go only once every Host this file names has lost the key; with any skipped, failed or
    # left to --only, deleting the key would leave it on those for good
    every = len(hosts) == len(keyed) and not only
    if bad or not hosts or not every:
        why = ("nothing was revoked" if not hosts else "hosts above were skipped or failed" if bad or len(hosts) <
               len(keyed) else "--only left this file's other hosts with the key")
        say(f"{done} Not finished: {why}. Keep this box's key and ssh config files until every host of this "
            "roster.yml has lost the key (`roster revoke` without --only names them then).")
    else:
        from .named import unnamed_from_elsewhere
        files = key_files(cfg)
        # never a key file another Inventory on this Box uses too (its Hosts still need it)
        for message in kept_key_files(cfg, files):
            say(message)
        # never another roster.yml's config.d/roster: its Hosts still need it
        if unnamed_from_elsewhere() is None:
            files.append(str(current().ssh_config))
        if current().key_name.is_file():    # the name setup recorded the key's lines under
            files.append(str(current().key_name))
        if not files:
            say(done)
        else:
            say(f"{done} To finish, delete " + (f"{', '.join(files[:-1])} and {files[-1]}" if len(files) > 1 else
                                                files[0]) + " on this box.")
    return 1 if bad or len(hosts) < len(keyed) or not hosts else 0


def revoke_targets() -> list[tuple[str, str | None, Path]]:
    """`revoke --all`'s Inventories: [(label, name or None, roster.yml)], every named one in the order they were
    named, then the unnamed one: the roster.yml roster's unnamed ssh config was last written from (the only unnamed
    one whose Hosts `ssh NAME` reaches), unless it's a named one's file."""
    from . import named
    inv = named.load()
    out: list[tuple[str, str | None, Path]] = [(x.name, x.name, x.path) for x in inv.inventories]
    unnamed = named.unnamed_source()
    if unnamed is not None and not any(named.same_file(x.path, unnamed) for x in inv.inventories
                                       if x.path.exists()):
        out.append(("(unnamed)", None, unnamed))     # in brackets: no named Inventory's name can have one
    return out


def revoke_all(yes: bool = False) -> int:
    """T183 (#347): `roster revoke` for every Inventory on this Box at once, with one question and one summary. Each
    Inventory is loaded and reached by its own name (this run's Inventory is never switched), and a Host is reached
    only by a name `ssh NAME` takes to that Inventory's Host: never a left-out one, never one whose Inventory isn't in
    this Box's ssh config."""
    from . import named
    named.rebuild_if_stale()
    targets = revoke_targets()
    if not targets:
        say("no Inventory has written its ssh config on this Box (`roster inv list` names them): nothing to revoke")
        return 1
    plan: list[tuple[str, dict[str, Any], list[dict[str, Any]]]] = []
    problems = 0
    left_alone = 0                          # left-out Hosts: skipped, so not finished (exit 1)
    for label, name, path in targets:
        again = f"roster --inv {name}" if name else f"roster -c {shlex.quote(str(path))}"
        try:
            cfg = load_config(path)
        except InventoryError:              # its words could quote a line of that file: they stay with it
            say(f"  {label}: its roster.yml doesn't load or isn't there ({path}) - not revoked (`{again} check "
                "--box` says why)")
            problems += 1
            continue
        keyed = [h for h in cfg["hosts"].values() if h["enroll"]]
        reach = named.reachable_hosts(Context(name))
        if reach is None:
            if keyed:
                say(f"  {label}: not in this Box's ssh config, so `ssh NAME` doesn't reach its Hosts - its "
                    f"{len(keyed)} hosts not revoked (`{again} sync` writes it, then `{again} revoke`)")
                problems += 1
            continue
        left = named.left_out_hosts(Context(name))
        hosts: list[dict[str, Any]] = []
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
    if not yes:
        tags = ", ".join(sorted({f"'{cfg['tag']}'" for _, cfg, _ in plan})) or "this box's key"
        counts = ", ".join(f"{label} {len(hosts)}" for label, _, hosts in plan)
        ans = input(f"Remove key {tags} from {total} hosts in {len(plan)} Inventories ({counts})? This box loses "
                    "access. [y/N] ")
        if ans.strip().lower() != "y":
            return 1
    jobs = [(label, h, box_key_re(cfg)) for label, cfg, hosts in plan for h in hosts]
    bad = 0
    with locked("revoke --all", [Context(name) for _, name, _ in targets]), \
            cf.ThreadPoolExecutor(max([cfg["workers"] for _, cfg, _ in plan] or [1])) as ex:
        # one account may be in two Inventories: one set of locks for them all
        whys = ex.map(in_turn(AccountLocks()), [h for _, h, _ in jobs], [r for _, _, r in jobs])
        for (label, h, _), why in zip(jobs, whys, strict=True):
            bad += why is not None
            revoke_line(f"{label}: ", h, why)
            if why is None:                 # each Inventory's records
                ctx = Context(next(n for lb, n, _ in targets if lb == label))
                rotation.forget([h["name"]], ctx)
                boxkeys.record({h["name"]: None}, ctx)
    files: list[str] = []
    for _, cfg, _ in plan:
        files += key_files(cfg)
    for kind in ("ssh_config", "key_name"):
        files += [str(f) for _, name, _ in targets if (f := Context(name).file(kind)).is_file()]
    if ssh_index_file().is_file():
        files.append(str(ssh_index_file()))
    files = list(dict.fromkeys(files))
    done = f"\nremoved from {total - bad}/{total} hosts in {len(plan)} Inventories."
    if bad or problems or left_alone:
        # with the key files gone, roster could never take this box's key off what was skipped
        say(f"{done} Not finished: hosts or Inventories above were skipped or failed. Revoke those first (each line "
            "above says how); only then delete this box's key and ssh config files (plain `roster revoke` names "
            "them).")
    elif files:
        say(f"{done} To finish, delete {', '.join(files[:-1])} and {files[-1]} on this box." if len(files) > 1 else
            f"{done} To finish, delete {files[0]} on this box.")
    else:
        say(done)
    return 1 if bad or problems or left_alone or not total else 0
