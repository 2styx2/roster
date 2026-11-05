"""`roster add --from-vault` with no NAME (T221, #428, decision Q191): the vault items no Host, service or resource in
roster.yml refers to, the ones that are new since the last run marked, and a walk through adding each one through
`roster add` (addhost.py), prefilled from the item.

- `listing(path, sync=True)`: the vaults roster.yml uses, synced first (providers.sync_vault, the one T222's
  `roster vault sync` uses), their login items (providers.vault_items: never a password, TOTP seed or note; Q191),
  less the ones a Login names, each with the Host it suggests and whether it's new.
- The seen file: per Inventory, in roster's config folder (`vault-seen/`), the ids and names of the items a run
  has shown and marked, and how many unmapped ones were new at the last run (`roster check --box` says that count,
  without asking the vault). Never a value.
The CLI (a list, or in a terminal a walk through the items, each one added as `roster add NAME` adds it) is
cli.py's."""

import hashlib
import json
import os
import re
import time
from datetime import datetime

import yaml

from . import addhost, providers
from .common import NAME_RE, NotPrivate, plain, read_private, say, utc_now, write_private
from .context import user_config_dir
from .errors import LIST_FAILED, NO_LISTABLE_VAULT, VAULT_LOCKED, Problem

NOT_VAULTS = ("env", "cmd", "prompt")       # providers that hold no items to list or sync
UNLOCK = {"bw": "roster vault bw --write -- unlock (then export BW_SESSION=... as it says), or put the session in "
                "~/.config/roster/bw-session: (umask 077; bw unlock --raw > ~/.config/roster/bw-session)",
          "kp": "KeePassXC has no session roster can reuse: give the address and user yourself (roster add NAME "
                "--ip ADDR --user USER --auth kp:ENTRY), or unlock it in the app",
          "op": "sign in: turn on the 1Password app's CLI integration, or eval $(op signin)"}


# ---------------------------------------------------------------- what roster.yml refers to

def refs(path):
    """{provider: {item spec}} for every `auth:` value anywhere in roster.yml at PATH (a Host's, a group's, defaults',
    a service's, sudo's, a resource's), read as written."""
    out = {}

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "auth" and isinstance(v, str) and ":" in v:
                    name, _, spec = v.partition(":")
                    out.setdefault(name.strip(), set()).add(spec.strip())
                else:
                    walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    with open(path, encoding="utf-8") as f:
        walk(yaml.safe_load(f) or {})
    return out


def named(provider, specs):
    """MAPPED(item) for providers.vault_items: does a Login of SPECS name the item, by its id, name or path (as the
    provider looks items up: exactly, any case)?"""
    hook = providers.PROVIDERS.get(provider, {}).get("ref_item")
    wanted = {(hook(s) if hook else providers.split_field(s)[0]).casefold() for s in specs}
    return lambda item: any(str(k).casefold() in wanted for k in item.get("keys") or ())


# ---------------------------------------------------------------- the seen file

def seen_path(path):
    key = hashlib.sha256(os.path.realpath(path).encode()).hexdigest()[:16]
    return user_config_dir() / "vault-seen" / f"{key}.json"


def load_seen(path):
    """{inventory, items: {provider: {id: name}}, new, checked} from the seen file, or an empty one (a file that isn't
    yours alone or doesn't parse is said and ignored)."""
    f = seen_path(path)
    try:
        data = json.loads(read_private(f))
        if not isinstance(data, dict) or not isinstance(data.get("items"), dict):
            raise ValueError
        return data
    except FileNotFoundError:
        pass
    except NotPrivate as e:
        say(f"warning      {e} - ignored")
    except ValueError:
        say(f"warning      {f} isn't roster's list of seen vault items - ignored")
    return {"inventory": str(path), "items": {}, "new": 0, "checked": None}


def save_seen(path, seen):
    seen = {**seen, "inventory": str(path), "checked": utc_now()}
    write_private(seen_path(path), json.dumps(seen, indent=1, sort_keys=True) + "\n")


def cached_count(path):
    """(new unmapped items at the last run, when) for `roster check --box`, or None: no run yet. No vault call."""
    try:
        data = json.loads(read_private(seen_path(path)))
    except (FileNotFoundError, NotPrivate, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("new"), int):
        return None
    return data["new"], data.get("checked")


# ---------------------------------------------------------------- the list

def listing(path, sync=True, interactive=False):
    """{synced: [{provider, previous}], items: [row], skipped: [note], seen} for roster.yml at PATH. A row: {provider,
    id, name, auth, new, host?, address?, port?, user?, note?}, in the vault's order. Raises Problem: 188 no vault
    roster.yml uses can list its items, 14 locked (how to unlock in fix), 187 the listing or sync failed."""
    used = refs(path)
    listable = [p for p in used if p in providers.PROVIDERS and providers.can_list(p)]
    skipped = [f"{p}: can't list its items without roster reading their passwords" for p in sorted(used)
               if p in providers.PROVIDERS and p not in listable and p not in NOT_VAULTS]
    if not listable:
        raise Problem(NO_LISTABLE_VAULT, "roster.yml uses no vault roster can list (bw, op, kp)",
                      fix="add one Host with --auth bw:ITEM (or op:, kp:) first; then roster add --from-vault "
                          "lists the rest")
    seen = load_seen(path)
    synced, rows = [], []
    for p in listable:
        try:
            if sync:
                done = providers.sync_vault(p, interactive)
                if done is not None:
                    synced.append(done)
            found = providers.vault_items(p, named(p, used[p]), interactive)
        except providers.SecretError as e:
            raise problem(p, e) from None
        mapped = named(p, used[p])
        free = [i for i in found if not mapped(i)]
        names = [i["name"].casefold() for i in found]
        for i in free:
            r = row(p, i, names.count(i["name"].casefold()) == 1, i["id"] not in seen["items"].get(p, {}))
            if r is None:
                skipped.append(f"{p}: an item whose name and id both hold a control character or start with '-'")
            else:
                rows.append(r)
    return {"synced": synced, "items": rows, "skipped": skipped, "seen": seen}


def problem(provider, e):
    if isinstance(e, providers.VaultLocked) or providers.vault_status(provider) in ("locked", "unauthenticated"):
        return Problem(VAULT_LOCKED, f"{provider}: the vault is locked, and roster add --from-vault never asks for "
                                     "its master password", fix=UNLOCK.get(provider, "unlock it, then run it again"))
    if isinstance(e, providers.Unsupported):
        return Problem(NO_LISTABLE_VAULT, str(e))
    return Problem(LIST_FAILED, f"{provider}: {e}", fix="see the message; roster check --auth tests the vault")


def row(provider, item, unique, new):
    """What a list shows of ITEM, and the Host it suggests: name, address, SSH port and user; or None when neither
    its name nor its id is fit for an `auth:` reference (a control character, or a leading '-')."""
    name = item["name"]
    safe = unique and plain(name) and not name.startswith("-") and not re.search(r"[#/]", name)
    ref = name if safe else item["id"]
    if not plain(ref) or ref.startswith("-"):
        return None
    out = {"provider": provider, "id": item["id"], "name": name, "auth": f"{provider}:{ref}", "new": new}
    host = host_name(item["name"])
    if host:
        out["host"] = host
    note = None
    for uri in item["uris"]:
        address, port, why = addhost.uri_address(uri)
        if address:
            out["address"] = address
            if port:
                out["port"] = port
            note = None
            break
        note = note or why
    if item["username"] and plain(item["username"]):
        out["user"] = item["username"]
    if note:
        out["note"] = note
    return out


def host_name(item):
    """The Host name an item's name suggests: `<host> ssh` (or `<host> ssh+web`, docs/adding-hosts.md) gives HOST;
    any other name is made a name roster takes (letters, digits, . _ -), or None."""
    m = re.match(r"^(.+?)\s+ssh(\+\S+)?$", item.strip(), re.IGNORECASE)
    name = m.group(1) if m else item.strip()
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-._")
    return name if NAME_RE.match(name) else None


def described(r):
    where = r.get("address") or "no address"
    if r.get("port"):
        where += f" port {r['port']}"
    if r.get("user"):
        where += f", user {r['user']}"
    return f"{r.get('host') or '(no name)'}  {where}"


def ago(iso):
    """'3 hours ago' for an ISO time, or None."""
    if not iso:
        return None
    try:
        then = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    s = max(0, int(time.time() - then.timestamp()))
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if s >= size:
            n = s // size
            return f"{n} {unit}{'' if n == 1 else 's'} ago"
    return "just now"
