"""`roster setup`: this Box's key on the Inventory's Hosts that don't take it yet, their host keys recorded, this
Box's ssh config and Claude files written, a renamed Box's key lines re-tagged, then the Mesh (decision Q63). The
Box-wide lock (boxlock) is held throughout, and the helpers `roster revoke` shares: the Hosts a plain `ssh NAME`
wouldn't reach are skipped, and a Host whose key line another Box's name holds is left (code 190)."""

import concurrent.futures as cf
import sys
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from typing import Any

from . import authorized, boxkeys, boxlock, catchup, keyline, mesh, meshview, providers, rotation
from .authorized import TAKEN, NameTaken, NoLine, box_key_re, box_public_keys, enroll, key_named
from .boxkeys import ensure_key, public_key_line
from .claude import write_claude_files
from .common import die, plural, replace_file, say
from .config import selected
from .context import Context, current
from .errors import KEY_FILE, UNKNOWN_HOST, Exit, Problem, tagged
from .hosts import provider_of
from .keyline import key_ere
from .providers import get_secret
from .sshops import record_fingerprints, ssh_ok, write_ssh_config

LEFT_OUT = ("left out of this Box's ssh config: another named Inventory ahead of this one has a Host by that name, "
            "so `ssh {name}` reaches that one; skipped (`roster inv use` this Inventory to reach it)")


def skip_left_out(hosts: list[dict[str, Any]], to_stderr: bool = False) -> list[dict[str, Any]]:
    """HOSTS without the key Hosts a plain `ssh NAME` wouldn't reach (ticket 115): another named Inventory's Host by
    that name is the one in this Box's ssh config, or this Inventory's part of it doesn't have NAME (not synced here),
    so roster must never ssh to it by name. Each skipped one is said."""
    from .sshops import left_out, not_reached, sync_fix
    keep: list[dict[str, Any]] = []
    for h in hosts:
        why = not_reached(h["name"]) if h["enroll"] else None
        if why:
            words = f"{h['name']}: " + LEFT_OUT.format(name=h["name"]) if left_out(h["name"]) else \
                f"{why}; skipped ({sync_fix()})"
            print(f"  {words}", file=sys.stderr if to_stderr else sys.stdout, flush=True)
        else:
            keep.append(h)
    return keep


def name_taken(cfg: dict[str, Any]) -> str:
    from .errors import BOX_NAME_TAKEN
    return tagged(Problem(BOX_NAME_TAKEN, f"another key's line there is tagged {cfg['tag']}: another Box already uses "
                                          "that name, and this Box's setup and revoke would take that line too (one "
                                          "name, one owner), so nothing was changed there. Give this Box another "
                                          "box_name:, or run roster setup --force to go ahead"))


@contextmanager
def locked(what: str, contexts: list[Context] | None = None) -> Generator[None, None, None]:
    """The Box-wide lock (boxlock, T240) of each of CONTEXTS' Inventories (default: this run's) while the body runs;
    a run that can't get it stops (205) before anything."""
    held = boxlock.held(what, contexts)
    try:
        held.__enter__()
    except Problem as e:
        raise Exit(e) from None
    try:
        yield
    finally:
        held.__exit__(None, None, None)


def setup(cfg: dict[str, Any], only: str | None = None, host: str | None = None, dry_run: bool = False,
          key_type: str | None = None, force: bool = False) -> int:
    """`roster setup`, holding the Box-wide lock unless DRY_RUN (read-only)."""
    if dry_run:
        return setup_run(cfg, only, host, dry_run, key_type, force)
    with locked("setup"):
        return setup_run(cfg, only, host, dry_run, key_type, force)


def setup_run(cfg: dict[str, Any], only: str | None, host: str | None, dry_run: bool, override: str | None,
              force: bool) -> int:
    # `--host NAME` (Q198; `roster add --setup` too): exactly that Host, never what --only NAME would match too
    # (a group, type or product by that name)
    if host is not None and host not in cfg["hosts"]:
        die(f"unknown host {host!r} (see `roster hosts`)", code=UNKNOWN_HOST)
    hosts = [cfg["hosts"][host]] if host is not None else selected(cfg, only)
    narrowed = bool(only or host)           # part of roster.yml: no Mesh, no key-name record
    waiting = [h for h in hosts if not h["reviewed"]]
    hosts = [h for h in hosts if h["reviewed"]]
    if waiting:
        say(f"skipping     {len(waiting)} hosts with reviewed: false (from discover) - review them in "
            "roster.yml, set reviewed: true, then re-run setup")
    if not hosts:
        return 0
    warn_os(hosts)
    yml = cfg                               # roster.yml's own key types, before --key-type's for this run
    if override:
        if host is None:            # a Host at a time, never a group or the whole Inventory
            die("--key-type goes with --host NAME (one Host, to try a key type there): for more Hosts, set "
                "key_type: on them, their group or defaults in roster.yml and run roster setup")
        cfg, hosts = key_type_for_run(cfg, hosts, override)
    say(f"roster setup box '{cfg['box']}', {len(hosts)} hosts from {cfg['path']}")
    if not dry_run:                     # a swap a rotation was stopped in the middle of, finished
        rotation.repair_all(cfg, say)
    # one key per key type the Hosts use (this Box's own when none), each made on first need
    keys = boxkeys.in_use(cfg, hosts) or [boxkeys.box_key(cfg)]
    for key in keys:
        ensure_key(key, cfg["tag"])
    pubs = {key.type.name: public_key_line(key, cfg["tag"]) for key in keys}

    def pub(h: dict[str, Any]) -> str:
        return pubs[h["key_type"]]
    # every key of this Box: a line of any of them under the new name is this Box's own, never "taken"
    own = "|".join(key_ere(*words[:2]) for words in box_public_keys(cfg))
    no_answer = record_fingerprints(cfg, hosts)
    write_ssh_config(cfg)

    key_hosts = skip_left_out([h for h in hosts if h["enroll"] and h["name"] not in no_answer])
    pw_hosts = [h for h in hosts if not h["enroll"]]
    with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
        works = dict(zip([h["name"] for h in key_hosts], ex.map(ssh_ok, [h["name"] for h in key_hosts]), strict=True))
    todo = [h for h in key_hosts if not works[h["name"]]]
    say(f"key login    {len(key_hosts) - len(todo)} already work, {len(todo)} need the key installed")
    # box_name: (or the hostname) changed since this Box's key went on its Hosts: the lines there still
    # carry the earlier name, so the Hosts where the key works get it re-tagged (found by this Box's own public key)
    was = key_named(cfg)
    retag = [h for h in key_hosts if works[h["name"]]] if was not in (None, cfg["box"]) else []
    if retag:
        # with no record, only the key's comment says a name (a named Inventory's first setup may never
        # have been renamed: the key was made by another Inventory's)
        why = (f"this Box's key is tagged {keyline.tag(str(was))} on its Hosts (box_name:, or the hostname, changed "
               "since)" if current().key_name.exists() else
               f"this Box's key was made as {keyline.tag(str(was))}, so its lines may carry that name")
        say(f"key tag      {why}: re-tag it as {cfg['tag']} on {plural(len(retag), 'host')} where it works")

    # the record says which types this Box's lines on each Host are; where the key works, the lines of other types
    # go now (setup --key-type's, a cleanup that failed), over that key login. --key-type's Host keeps roster.yml's
    # type's line too, so its tries never pile up
    held = boxkeys.installed()
    pending_rotation = rotation.pending(cfg)

    def keep(h: dict[str, Any]) -> set[str]:
        return {h["key_type"], yml["hosts"][h["name"]]["key_type"]} if override else {h["key_type"]}

    tidy = {h["name"]: sorted(set(held.get(h["name"], [])) - keep(h)) for h in key_hosts
            if works[h["name"]] and h["name"] not in pending_rotation and set(held.get(h["name"], [])) - keep(h)}
    # the cleanup writes the key's .pub back after taking this Box's lines off, so only where roster can tell that
    # .pub is the key that logged in (a passphrase on it: it can't), never losing the working line (#505's review NIT)
    for h in key_hosts:
        if h["name"] in tidy and not boxkeys.matches(boxkeys.for_host(h).key):
            say(f"  note  {h['name']}: this Box's {' and '.join(tidy.pop(h['name']))} key line is still there, and "
                f"roster can't check that {boxkeys.for_host(h).pub} is the key that logs in (a passphrase on it?), so "
                "it left the lines as they are: remove that line by hand, or roster revoke takes it")

    failed = {h["name"]: "no answer on SSH port" for h in hosts if h["name"] in no_answer}
    if dry_run:
        for h in todo:
            say(f"  would install key on {h['name']} ({h['user']}@{h['ip']}:{h['port']}, auth {h['auth']}, "
                f"{h['key_type']} key)")
        for h in retag:
            say(f"  would re-tag key on {h['name']}")
        hosts_by_name = {h["name"]: h for h in key_hosts}
        for name, types in tidy.items():
            left = cleanup_re(cfg, pub(hosts_by_name[name]), types)[1] if override else []
            if took := [t for t in types if t not in left]:
                say(f"  would take this Box's {' and '.join(took)} key line off {name}")
            if left:
                say(f"  would leave this Box's {' and '.join(left)} key line on {name}: {unmatched_words(left)}")
        return 0

    # renamed onto a name another Box's key line has on a Host: the same-name rule (this Box's revoke
    # and install take a name's lines) would take that Box's line, so that Host is left, said, unless --force
    taken = cfg["tag_re"] if was not in (None, cfg["box"]) and not force else None
    if retag:
        def retag_one(h: dict[str, Any]) -> authorized.Done:
            return authorized.retag(h, pub(h), taken, own)
        with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
            for h, done in zip(retag, ex.map(retag_one, retag), strict=True):
                for w in done.warnings:
                    print(f"warning: [{KEY_FILE}] {h['name']}: {w}", file=sys.stderr, flush=True)
                why = done.why
                if why is None:
                    say(f"  ok    {h['name']} (re-tagged)")
                elif isinstance(why, NoLine):   # nothing roster can re-tag there: done, said once
                    say(f"  note  {h['name']}: the key works, but no {keyline.TAG} line for it is in {why.file} (a "
                        "line written by hand): left as is; change or remove that line by hand")
                elif why is TAKEN:
                    failed[h["name"]] = name_taken(cfg)
                    say(f"  FAIL  {h['name']}: {name_taken(cfg)}")
                else:
                    failed[h["name"]] = f"re-tag: {why}"
                    say(f"  FAIL  {h['name']}: re-tag: {why}")

    if tidy:
        by_name = {h["name"]: h for h in key_hosts}
        unmatched: dict[str, list[str]] = {}    # an earlier try's type with no key of it here (#505's review L2)

        def tidy_on(name: str) -> list[str]:
            h = by_name[name]
            if not override:
                return authorized.drop_others(h, pub(h), box_key_re(cfg), why="the key works")
            drop_re, unmatched[name] = cleanup_re(cfg, pub(h), tidy[name])
            return authorized.drop_others(h, pub(h), drop_re, why="the key works")
        with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
            futs = {ex.submit(tidy_on, n): n for n in tidy if n not in failed}
            for f in cf.as_completed(futs):
                name = futs[f]
                try:
                    notes = f.result()
                    boxkeys.record({name: (set(held.get(name, [])) - set(tidy[name])) | set(unmatched.get(name, ()))})
                    left = unmatched.get(name) or []
                    took = [t for t in tidy[name] if t not in left]
                    # #509 item 3: a type with no key here to match its line by stays (#505's L2), said as left
                    say(f"  ok    {name} (" + "; ".join(
                        ([f"took this Box's {' and '.join(took)} key line off"] if took else [])
                        + ([f"left this Box's {' and '.join(left)} key line: {unmatched_words(left)}"] if left else []))
                        + ")")
                    for note in notes:
                        say(f"        {note}")
                except Exception as e:
                    failed[name] = str(e)
                    say(f"  FAIL  {name}: {e}")
    # a Host where the key works holds at least its type's line
    known = {h["name"]: set(held.get(h["name"], [])) | {h["key_type"]} for h in key_hosts
             if works[h["name"]] and h["name"] not in tidy and h["name"] not in failed
             and set(held.get(h["name"], [])) | {h["key_type"]} != set(held.get(h["name"], []))}
    if known:
        boxkeys.record(known)

    locked_vaults: set[str] = set()         # the providers a Login's lookup found locked (their own fix each)
    for ref, group in sorted({(h["auth"], h["group"]) for h in todo}, key=lambda t: (str(t[0]), t[1])):
        try:
            get_secret(ref, group)          # ask for / fetch passwords up front, one per group
        except RuntimeError as e:
            if isinstance(e, providers.VaultLocked):
                locked_vaults.add(provider_of(ref))
            for h in todo:
                if (h["auth"], h["group"]) == (ref, group):
                    failed[h["name"]] = str(e)
    todo = [h for h in todo if h["name"] not in failed]

    installed: list[str] = []
    if todo:
        say(f"installing   key on {len(todo)} hosts...")
        with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
            mine = box_key_re(cfg)
            # --key-type: this run's line goes in beside roster.yml's type's, which the next sync offers again
            futs = {ex.submit(enroll, h, pub(h), mine, taken, own, bool(override)): h for h in todo}
            for f in cf.as_completed(futs):
                h = futs[f]
                try:
                    notes = f.result()
                    installed.append(h["name"])
                    if override:            # roster.yml's type's line stayed, and any other try's: those go
                        have = set(held.get(h["name"], [])) | keep(h)
                        left: list[str] = []
                        if extra := sorted(have - keep(h)):
                            drop_re, left = cleanup_re(cfg, pub(h), extra)
                            notes = [*(notes or []), *authorized.drop_others(h, pub(h), drop_re)]
                            if left:        # #509 item 3: said as left, as the tidy says it
                                notes.append(f"left this Box's {' and '.join(left)} key line: {unmatched_words(left)}")
                        boxkeys.record({h["name"]: keep(h) | set(left)})      # a line it couldn't match stays
                    else:
                        boxkeys.record({h["name"]: [h["key_type"]]})
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
            replace_file(current().key_name, f"{cfg['box']}\n")
    write_claude_files(cfg)
    warn_overlaps(cfg)
    failed.update(setup_mesh(cfg, "--only" if only else "--host" if narrowed else None))
    # a Host that failed (the vault locked, say) is never counted as ready too; one whose key works but whose Mesh
    # step failed is key-ready (its gap is the Mesh's)
    keyed = [h["name"] for h in key_hosts if h["name"] not in failed or str(failed[h["name"]]).startswith("mesh:")]
    ready = len(keyed)
    catchup.record_setup(cfg, keyed, [n for n, why in failed.items() if not str(why).startswith("mesh:")])
    say()
    say(f"done         {ready} key hosts ready, {len(pw_hosts)} password-only hosts, {len(failed)} failed")
    if failed:
        say("failed hosts (fix, then re-run setup - hosts that already work are skipped):")
        for name, why in sorted(failed.items()):
            say(f"  {name}: {why}")
    rc = 1 if failed else 0
    # a Box key rotation not finished is never a clean setup, whatever logs in
    if waiting := rotation.pending(cfg):
        say(f"Box key rotation pending on {plural(len(waiting), 'Host')} ({', '.join(sorted(waiting))}): the old Box "
            "key is still on them; `roster setup --rotate` finishes it")
        rc = 1
    elif found := rotation.problems(cfg):
        for p in found:
            say(f"warning: {tagged(p)} ({p.fix})")
        rc = 1
    if line := catchup.setup_next_line(sorted(installed), locked_vaults):
        say(line)
    return rc


def unmatched_words(types: list[str]) -> str:
    """Why setup --key-type's tidy leaves this Box's lines of TYPES (cleanup_re's second half): #509 item 3."""
    return f"no {' or '.join(types)} key on this Box to match it by; roster revoke takes it"


def cleanup_re(cfg: dict[str, Any], pub: str, types: list[str]) -> tuple[str, list[str]]:
    """What drop_others takes on a Host for `setup --key-type` (#471's NIT-3): PUB's line (written again) and this
    Box's lines of TYPES' keys (the ones this Box holds, boxkeys.vouched), never roster.yml's type's line. Returns
    (that ERE, the TYPES with no such key here: their lines stay, and the record keeps them, #505's review L2)."""
    by_type = {k.type.name: k for k in boxkeys.all_keys(cfg)}
    alts: list[str] = [key_ere(*pub.split()[:2])]
    missing: list[str] = []
    for t in types:
        k = by_type.get(t)
        words = boxkeys.public_words(k.pub) if k is not None and boxkeys.vouched(k, cfg["key"]) else None
        if words:
            alts.append(key_ere(*words))
        else:
            missing.append(t)
    return "|".join(alts), missing


def setup_mesh(cfg: dict[str, Any], narrowed_by: str | None) -> dict[str, str]:
    """Setup's own Mesh apply (Q63), once the Box key works on the Hosts: never with a narrowed run (NARROWED_BY, the
    flag). {host: why} for what it left pending. (The Mesh follows key_type, Q212, so no Host is left out for it.)"""
    if not mesh.graph(cfg)["links"]:
        return {}
    if narrowed_by:
        say(f"mesh         not applied with {narrowed_by} (it covers the whole Mesh): run `roster mesh`")
        return {}
    say("mesh         applying the Mesh for meshed groups and links (one Host at a time)...")
    return {n: f"mesh: {why}" for n, why in meshview.apply(cfg).items()}


def key_type_for_run(cfg: dict[str, Any], hosts: list[dict[str, Any]],
                     value: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """`setup --key-type TYPE` (T239): CFG and HOSTS with TYPE for HOSTS' key Logins, this run only (their key file,
    and so the IdentityFile this run's ssh config gives them); a note says roster.yml still says otherwise."""
    try:
        kt = boxkeys.parse(value)
    except ValueError as e:
        die(f"--key-type: {e}")
    file = str(boxkeys.key_file(cfg["key"], cfg["key_type"], kt.name))
    changed = {h["name"]: {**h, "key_type": kt.name, "key_file": file} for h in hosts
               if h["enroll"] and h["key_type"] != kt.name}
    if changed:
        say(f"note: --key-type {kt.name} for {plural(len(changed), 'host')} whose roster.yml says otherwise "
            f"({', '.join(sorted(changed))}): its line goes in beside this Box's line of roster.yml's type, which "
            f"stays, and the next `roster sync` offers roster.yml's type again; set key_type: {kt.name} in "
            "roster.yml to keep it (the other line stays there until roster revoke, which takes both)")
    cfg = {**cfg, "hosts": {**cfg["hosts"], **changed}}
    return cfg, [changed.get(h["name"], h) for h in hosts]


def warn_overlaps(cfg: dict[str, Any]) -> None:
    """The same machine in two named Inventories (ticket 115): a warning each, never an error."""
    from .health import overlaps
    for w in overlaps(cfg):
        say(f"warning: {w['message']} (fix: {w['fix']})")


def warn_os(hosts: Sequence[dict[str, Any]]) -> None:
    """A Host with type: windows but no os: (T195, code 154): roster treats it as POSIX and runs sh scripts there, so
    say how to mark it. A warning only: roster never infers os: from type:, a free label."""
    from .errors import WINDOWS_TYPE_NO_OS
    for h in sorted(hosts, key=lambda h: h["name"]):
        if h["type"].strip().lower() == "windows" and h.get("os") is None:
            print(f"warning: [{WINDOWS_TYPE_NO_OS}] {h['name']} has type: windows but no os:, so roster treats it as a "
                  "POSIX Host (sh scripts)\n         fix: set os: windows for it (or its group) in roster.yml",
                  file=sys.stderr, flush=True)
