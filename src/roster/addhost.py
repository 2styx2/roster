"""Adding one Host to roster.yml (T220, decision Q190): the one implementation behind the app's add-Host form (serve's
host.add) and `roster add`, so a fix in one is a fix in both.

- `add(path, group, name, fields, sync=...)`: every check (edit.added: the name, the group, the address and that no
  other Host has it, the values, and that the result loads to exactly that Host with nothing else changed), then the
  write the store.py way (a team repo's Pending change, or a plain file saved in place, the backup kept, then this
  Box's `roster sync`). `dry_run` stops before the write and says what the write would be. The CLI's `roster add` is
  cli.py's.
- `vault_fields(auth)`: the address, SSH port and user a vault item holds (its URI and username), read without the
  item's password ever reaching roster (providers.login_fields). The CLI's `--from-vault` and serve's
  vault.item_fields."""

import difflib
import re
from urllib.parse import urlsplit

import yaml

from . import edit, providers, store
from .config import load_config
from .errors import (
    ADDRESS_TAKEN,
    ITEM_NOT_FOUND,
    LOOKUP_FAILED,
    NO_PROVIDER,
    SEVERAL_ITEMS,
    Problem,
    vault_problem,
)
from .hosts import ip_of, item_of, provider_of


def add(path, group, name, fields, sync=None, dry_run=False, new_address=False, on_write=None, hidden=False):
    """Host NAME (FIELDS: edit.NEW_FIELDS, already checked with edit.check_new) added to GROUP of roster.yml at PATH,
    the group made when it's new. Returns `{host, group, new_group, lines, kind, note, backup, sync}`: the Host as
    it loads now, the lines the write changes (`- ` the ones it replaces, `+ ` the ones it writes), how roster.yml is kept (store.py: `repo` or `file`, and its note), the backup and
    SYNC()'s answer (store's write: default boxsync's for PATH; never raises, the Host is written by then). With
    DRY_RUN nothing is
    written: `backup` and `sync` are None. NEW_ADDRESS (`roster add`): refuse an address and SSH port another Host
    has already (184); the app's form allows it (two Logins on one machine, Q190). Raises Problem: 80 a bad name,
    group, address or value, 81 the name is taken, 184, 74 the result doesn't come out right, or store.py's.
    ON_WRITE(result) runs once the Host is written, before the sync (the CLI says what it wrote there, so the sync's
    own lines come after it, as after `discover --write`; serve marks there that the Host is in, so nothing after it
    takes its new vault item back out)."""
    kept = store.at(path, hidden=hidden)       # HIDDEN: the Inventory's, so store's errors don't name it (#529)
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

    def written(backup):
        done["backup"] = str(backup)
        if on_write is not None:
            on_write(done)
    _, done["sync"] = kept.write(old, new, then=written, sync=sync)
    return done


def same_address(cfg, h):
    """The Host in CFG that ssh would reach at H's address and port, or None. IP addresses are compared as addresses
    (`::1` is `0:0::1`, a zone ignored), names without case or a final dot."""
    def key(ip):
        parsed = ip_of(ip)
        return ("ip", parsed.packed) if parsed is not None else ("name", ip.lower().rstrip("."))
    for other in cfg["hosts"].values():
        if key(other["ip"]) == key(h["ip"]) and other["ssh"]["port"] == h["ssh"]["port"]:
            return other
    return None


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
    name, spec = provider_of(auth), item_of(auth)
    if not spec or name not in providers.PROVIDERS:
        raise Problem(NO_PROVIDER, f"{auth!r} isn't a vault item reference (bw:ITEM, op:ITEM, ...) of a provider set "
                                   "up on this box", {"provider": name}, fix="see `roster vault status`")
    try:
        found = providers.login_fields(name, spec, interactive)
    except providers.ItemNotFound as e:
        raise Problem(ITEM_NOT_FOUND, f"no vault item matches '{e.item}'", {"near": e.near},
                      fix="check the item's name in the vault, or use its id") from None
    except providers.SeveralItems as e:
        raise Problem(SEVERAL_ITEMS, str(e), {"matches": e.matches},
                      fix="put its id in auth: (bw:ID, op:ID), or rename the extra items in the vault") from None
    except providers.SecretError as e:
        raise vault_problem(e, LOOKUP_FAILED, fix="see the message; `roster check --auth` tests every Login") from None
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
    if ip_of(uri) is not None:
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
