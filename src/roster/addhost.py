"""Adding one Host to roster.yml (T220, decision Q190): the one implementation behind the app's add-Host form (serve's
host.add) and `roster add`, so a fix in one is a fix in both.

- `add(path, group, name, fields, sync=...)`: every check (edit.added: the name, the group, the address and that no
  other Host has it, the values, and that the result loads to exactly that Host with nothing else changed), then the
  write the store.py way (a team repo's Pending change, or a plain file saved in place, the backup kept), then this
  Box's `roster sync` (boxsync.py). `dry_run` stops before the write and says what the write would be.
- `vault_fields(auth)`: the address, SSH port and user a vault item holds (its URI and username), read without the
  item's password ever reaching roster (providers.login_fields). The CLI's `--from-vault` and serve's
  vault.item_fields."""

import difflib
import re
from urllib.parse import urlsplit

import yaml

from . import boxsync, edit, providers, store
from .config import load_config
from .errors import (
    ADDRESS_TAKEN,
    ITEM_NOT_FOUND,
    LOOKUP_FAILED,
    NO_ITEM_FIELDS,
    NO_PROVIDER,
    SEVERAL_ITEMS,
    Problem,
    vault_problem,
)


def add(path, group, name, fields, sync=None, dry_run=False, new_address=False, on_write=None):
    """Host NAME (FIELDS: edit.NEW_FIELDS, already checked with edit.check_new) added to GROUP of roster.yml at PATH,
    the group made when it's new. Returns `{host, group, new_group, lines, kind, note, backup, sync}`: the Host as
    it loads now, the lines the write changes (`- ` the ones it replaces, `+ ` the ones it writes), how roster.yml is kept (store.py: `repo` or `file`, and its note), the backup and
    SYNC()'s answer (default: boxsync's for PATH; never raises, the Host is written by then). With DRY_RUN nothing is
    written: `backup` and `sync` are None. NEW_ADDRESS (`roster add`): refuse an address and SSH port another Host
    has already (184); the app's form allows it (two Logins on one machine, Q190). Raises Problem: 80 a bad name,
    group, address or value, 81 the name is taken, 184, 74 the result doesn't come out right, or store.py's.
    ON_WRITE(result) runs once the Host is written, before the sync (the CLI says what it wrote there, so the sync's
    own lines come after it, as after `discover --write`; serve marks there that the Host is in, so nothing after it
    takes its new vault item back out)."""
    kept = store.at(path)
    old, new, h = edit.added(kept.path, group, name, fields)
    other = same_address(load_config(kept.path), h) if new_address else None
    if other is not None:
        where = h["ip"] + ("" if h["ssh"]["port"] == 22 else f" port {h['ssh']['port']}")
        raise Problem(ADDRESS_TAKEN, f"{where} is already {other['name']}'s address (group {other['group']}), so "
                                     f"{name} wasn't added", {"host": other["name"], "group": other["group"]},
                      fix=f"use {other['name']}, or give {name} another address or port")
    groups = (yaml.safe_load(old) or {}).get("groups") or {}
    done = {"host": h, "group": group, "new_group": group not in groups, "lines": added_lines(old, new),
            "kind": kept.kind, "note": kept.note, "backup": None, "sync": None}
    if dry_run:
        return done
    done["backup"] = str(kept.save(old, new))
    if on_write is not None:
        on_write(done)
    return {**done, "sync": safely(sync or (lambda: boxsync.sync(lambda: load_config(kept.path))))}


def same_address(cfg, h):
    """The Host in CFG that ssh would reach at H's address and port, or None. IP addresses are compared as addresses
    (`::1` is `0:0::1`, a zone ignored), names without case or a final dot."""
    def key(ip):
        parsed = edit.ip_of(ip)
        return ("ip", parsed.packed) if parsed is not None else ("name", ip.lower().rstrip("."))
    for other in cfg["hosts"].values():
        if key(other["ip"]) == key(h["ip"]) and other["ssh"]["port"] == h["ssh"]["port"]:
            return other
    return None


def safely(sync):
    try:
        return sync()
    except Exception as e:                  # the Host is written: a sync that fails is only said
        return {"ok": False, "error": e.message if isinstance(e, Problem) else type(e).__name__, "fix": boxsync.FIX}
    except SystemExit as e:                 # a die() isn't an Exception (as boxsync.sync)
        return {"ok": False, "error": str(e.code).removeprefix("error: "), "fix": boxsync.FIX}


def added_lines(old, new):
    """What the write changes, as `- ` (a line it replaces, e.g. a group's `hosts: {}`) and `+ ` (a line it writes)."""
    return [line for line in difflib.ndiff(old.splitlines(), new.splitlines()) if line[:2] in ("- ", "+ ")]


# ---------------------------------------------------------------- what a vault item says about its Host

def vault_fields(auth, interactive=True):
    """`{address?, port?, user?}` for the vault item AUTH (`bw:ITEM`, a provider's reference) names: the address and
    SSH port from its URI (`ssh://10.0.0.5:2222`, `https://nas.example.com/`, `10.0.0.5`), the user from its
    username. A field the item doesn't have is left out, and `note` says why a URI gave no address (another scheme).
    Never reads the password: a provider that can't give these without it (providers.login_fields) is 186.
    INTERACTIVE=False never asks, not even for the master password. Raises Problem: 186, 31 no such provider, 32 no such item, 33 several, 35, or the vault's own (11, 12, 14)."""
    name, _, spec = str(auth or "").partition(":")
    name = name.strip()
    if not spec.strip() or name not in providers.PROVIDERS:
        raise Problem(NO_PROVIDER, f"{auth!r} isn't a vault item reference (bw:ITEM, op:ITEM, ...) of a provider set "
                                   "up on this box", {"provider": name}, fix="see `roster providers`")
    try:
        found = providers.login_fields(name, spec, interactive)
    except providers.Unsupported as e:
        raise Problem(NO_ITEM_FIELDS, str(e), {"provider": name},
                      fix="give the address and user yourself (roster add: --ip and --user)") from None
    except providers.ItemNotFound as e:
        raise Problem(ITEM_NOT_FOUND, f"no vault item matches '{e.item}'", {"near": e.near},
                      fix="check the item's name in the vault, or use its id") from None
    except providers.SeveralItems as e:
        raise Problem(SEVERAL_ITEMS, str(e), {"matches": e.matches},
                      fix="put its id in auth: (bw:ID), or rename the extra items in the vault") from None
    except providers.SecretError as e:
        if type(e) is providers.SecretError:
            raise Problem(LOOKUP_FAILED, str(e), fix="see the message; `roster auth-check` tests every Login") from None
        raise vault_problem(e) from None
    out = {}
    host, port, note = uri_address(found.get("uri") or "")
    if host:
        out["address"] = host
    if port:
        out["port"] = port
    if note:
        out["note"] = note
    if found.get("username"):
        out["user"] = found["username"]
    return out


NETWORK_SCHEMES = ("ssh", "sftp", "http", "https")
SSH_SCHEMES = ("ssh", "sftp")              # their port is the SSH port; http(s)'s isn't


def uri_address(uri):
    """(host, SSH port or None, note or None) from a vault item's URI: a bare IP address (`fe80::1`), a bare
    `HOST[:PORT]`, or an ssh, sftp, http or https URL (the host percent-decoded). Any other scheme (`androidapp://`,
    `mailto:`) gives no address, and the note says so; so does a host that isn't an address."""
    from urllib.parse import unquote
    uri = uri.strip()
    if not uri:
        return None, None, None
    if edit.ip_of(uri) is not None:
        return uri, None, None
    if "://" in uri:
        scheme = uri.split("://", 1)[0].lower()
    elif re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:(?!\d+\Z)", uri):        # `mailto:x`, but not `HOST:PORT`
        scheme = uri.split(":", 1)[0].lower()
    else:
        scheme = ""
    if scheme and scheme not in NETWORK_SCHEMES:
        return None, None, f"its URI isn't a network address ({scheme}:), so it gives no address"
    parts = urlsplit(uri if scheme else f"//{uri}")
    try:
        port = parts.port
    except ValueError:
        port = None
    host = unquote(parts.hostname or "")
    if not edit.good_address(host):
        return None, None, "its URI's host isn't a network address, so it gives no address"
    return host, port if scheme in ("", *SSH_SCHEMES) else None, None


# ---------------------------------------------------------------- `roster add`

def cmd_add(cfg, args):
    """`roster add NAME --ip ADDR ...`: one reviewed Host into roster.yml (add()), its next steps said or, with
    --setup, run (setup for it alone, then check it)."""
    import sys

    from .common import die, say
    ask = sys.stdin.isatty() and not args.yes
    path = cfg["path"]
    if args.name is None:                       # --from-vault with no NAME: the vault's items no Host uses (T221)
        from .fromvault import cmd_from_vault
        return cmd_from_vault(cfg, args)
    got = {"ip": args.ip, "user": args.user, "port": args.port}
    if args.from_vault:
        if not args.auth:
            needs("--auth", "--from-vault reads the item --auth names (--auth bw:ITEM)")
        try:
            found = vault_fields(args.auth, interactive=ask)
        except Problem as e:
            die(shown(e))
        if found.get("note"):
            say(f"from vault   {found['note']} ({args.auth})")
        vault = {"ip": found.get("address"), "user": found.get("user"),
                 "port": found.get("port") if args.ip is None else None}    # the port goes with the vault's address
        for k, v in vault.items():
            if got[k] is None and v is not None:
                got[k] = v
                say(f"from vault   {k} {v} ({args.auth})")
    groups = list(cfg["groups"])
    group = args.group
    if group is None:
        default = groups[0] if groups else None
        group = (prompt(f"Group{f' [{default}]' if default else ''}: ") or default) if ask else default
        if not group:
            needs("--group", "roster.yml has no group yet")
    if got["ip"] is None:
        got["ip"] = prompt("Address (IP or DNS name): ") if ask else None
        if not got["ip"]:
            needs("--ip", f"{args.name} needs an address")
    base = edit.inherited(edit.read_text(path), group)
    enroll = args.enroll
    if enroll is None and ask:
        answer = prompt(f"Install this Box's key on {args.name} (enroll)? [{'Y/n' if base['enroll'] else 'y/N'}] ")
        enroll = base["enroll"] if not answer else answer.lower().startswith("y")
    if not (got["user"] or base["user"]):
        needs("--user", f"no user for {args.name}: its group and defaults don't set one")
    if not (args.auth or base["auth"]):
        needs("--auth", f"no Login for {args.name}: its group and defaults don't set auth:")
    wanted = {"ip": got["ip"], "user": got["user"], "port": got["port"], "auth": args.auth, "enroll": enroll,
              "os": args.os, "title": args.title, "type": args.type, "reviewed": True}
    try:
        fields = {k: edit.check_new(k, v) for k, v in wanted.items() if v is not None}
    except ValueError as e:
        die(f"[{edit.INVALID_HOST}] {e}")
    where = f"group '{group}'"
    try:
        r = add(path, group, args.name, fields, dry_run=args.dry_run, new_address=True,
                on_write=lambda done: written(args.name, where, path, group, done))
    except Problem as e:
        die(shown(e))
    if args.dry_run:
        new = " (a new group)" if r["new_group"] else ""
        say(f"would add    {args.name} to {where}{new} in {path} (--dry-run: nothing written):")
        for line in r["lines"]:
            say(f"  {line}")
        return 0
    if not r["sync"]["ok"]:                     # as boxsync.after_edit says it after discover --write
        print(f"warning: this Box's ssh config didn't follow roster.yml ({r['sync']['error']}): {r['sync']['fix']}",
              file=sys.stderr, flush=True)
    return set_up(args, path) if args.setup else next_steps(args.name, path)


def written(name, where, path, group, r):
    """What `roster add` wrote, said as `discover --write` says it, before this Box's sync."""
    from .common import say
    say(f"backup       {r['backup']}")
    say(f"wrote        {name} into {where}" + (" (a new group)" if r["new_group"] else "") + f" in {path}")
    if r["new_group"]:
        say(f"new group    '{group}': roster.yml had no group by that name, so it's made")
    if r["kind"] == store.REPO:
        say(f"note         {r['note']}")


def next_steps(name, path):
    """The two commands that set the new Host up and test it. `setup --only NAME` also selects a Host whose group,
    type or product is NAME: then that's said, with `roster add`'s --setup-alone way round it."""
    from .common import say
    from .config import selected
    more = sorted(h["name"] for h in selected(load_config(path), name) if h["name"] != name)
    if more:
        say(f"next         roster check {name}          (a Session to it would open, step by step)")
        say(f"note         --only {name} also selects {', '.join(more)} (group, type or product {name}), so "
            f"`roster setup --only {name}` would set those up too: run setup without --only, or set {name} up by "
            "hand")
        return 0
    say(f"next         roster setup --only {name}   (host key, and this Box's key on it when enroll is true)")
    say(f"             roster check {name}          (a Session to it would open, step by step)")
    return 0


def set_up(args, path):
    """--setup: setup for Host NAME alone, then `check NAME`, each one's outcome said; non-zero if either failed."""
    import argparse

    from . import cli
    from .common import say
    cfg = load_config(path)
    say(f"\nsetup        roster setup --only {args.name}")
    # exactly this Host (`names`), never what --only NAME would match too (a group, type or product NAME); the
    # whole Inventory stays in cfg, as setup writes the ssh config from all of it
    setup = cli.cmd_setup(cfg, argparse.Namespace(only=args.name, names=[args.name], dry_run=False))
    say(f"\ncheck        roster check {args.name}")
    check = cli.cmd_check_host(argparse.Namespace(host=args.name, config=str(path), inv=None, json=False))
    say()
    say(f"setup        {'ok' if not setup else 'FAILED (see above)'}")
    say(f"check        {'ok' if not check else 'FAILED (see above)'}")
    return 1 if setup or check else 0


def prompt(text):
    try:
        return input(text).strip()
    except EOFError:
        return ""


def needs(flag, why):
    from .common import die
    from .errors import NEEDS_FLAG
    die(f"[{NEEDS_FLAG}] {why}: give {flag}")


def shown(e):
    return f"[{e.code}] {e.message}" + (f" ({e.details})" if e.details else "") + \
        (f" - {e.fix}" if e.fix else "")
