"""`roster vault sync` (T222, #430, decision Q194): the vault isn't watched, so roster sees an item added or changed
elsewhere only after a sync. This syncs each vault roster.yml uses that keeps a local copy (Bitwarden: `bw sync`,
providers.sync_vault) and says what changed since the last sync: the items added and changed by name, the removed
ones by count.

What it compares against is a snapshot per provider in roster's config folder (`vault-sync/PROVIDER.json`, 0600):
each login item's id and revision date, and when it was taken. Never a name, password or any other value. The items
come from providers.vault_items, the listing that never reads a password (Bitwarden's through its filter, Q191).
`roster vault status` reads the snapshot's time for "last synced", with no vault call."""

import json
import os
import sys
from datetime import datetime, timezone

from . import fromvault, providers
from .common import UTC_TIME, NotPrivate, find_program, plain, read_private, say, utc_now, write_private
from .context import box_file


def snapshot_path(provider):
    return box_file("vault_sync") / f"{provider}.json"


def load(provider, quiet=False):
    """{synced, items: {id: revision date}} from PROVIDER's snapshot, or None (none yet, or not roster's alone: said
    unless QUIET, as `roster vault status` is, whose --json stdout is the document alone)."""
    f = snapshot_path(provider)
    try:
        data = json.loads(read_private(f))
    except FileNotFoundError:
        return None
    except NotPrivate as e:
        if not quiet:
            say(f"warning      {e} - ignored")
        return None
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("items"), dict):
        return None
    return data


def last_synced(provider: str) -> str | None:
    """When `roster vault sync` last synced PROVIDER (an ISO time), or None. Never says anything: a snapshot that isn't
    the user's alone counts as none, and the next `roster vault sync` says so and replaces it."""
    data = load(provider, quiet=True)
    return data.get("synced") if data else None


def diff(before, items):
    """(added, changed, removed): the items in ITEMS not in BEFORE ({id: revision date}), those whose revision date
    moved, and how many of BEFORE's ids are gone."""
    now = {i["id"] for i in items}
    added = [i for i in items if i["id"] not in before]
    changed = [i for i in items if i["id"] in before and i.get("revised") != before[i["id"]]]
    return added, changed, len(set(before) - now)


def sync(provider, interactive=False, mapped=None, seen=()):
    """Sync PROVIDER and compare its items with the last snapshot: {provider, first, count, added: [name],
    changed: [name], removed: n, unmapped: [{name, missing}]}, or None for a provider with nothing to sync. UNMAPPED
    (T243): the items added since a sync that no Login in roster.yml names yet (MAPPED(item) is False), each with
    what `roster add --from-vault` would miss to make a Host of it (address, user), never their values; they stay
    named at each sync until roster.yml names them or `roster add --from-vault` has listed them (SEEN: its ids, #503's
    review LOW-4). The snapshot is replaced only after a sync and a listing that worked. Raises SecretError."""
    if providers.sync_vault(provider, interactive) is None:
        return None
    if not providers.can_list(provider):
        save(provider, {})
        return {"provider": provider, "first": True, "count": None, "added": [], "changed": [], "removed": 0,
                "unmapped": []}
    mapped = mapped or (lambda item: False)
    items = providers.vault_items(provider, mapped, interactive=interactive)
    before = load(provider)
    added, changed, removed = diff((before or {}).get("items") or {}, items)
    waiting = set((before or {}).get("unmapped") or ()) | ({i["id"] for i in added} if before is not None else set())
    left = [i for i in items if i["id"] in waiting and i["id"] not in set(seen) and not mapped(i)]
    save(provider, {i["id"]: i.get("revised") for i in items}, [i["id"] for i in left])
    unmapped = [{"name": shown(i), "missing": missing(i)} for i in left]
    return {"provider": provider, "first": before is None, "count": len(items),
            "added": [shown(i) for i in added], "changed": [shown(i) for i in changed], "removed": removed,
            "unmapped": unmapped}


def missing(item):
    """What an item lacks for a Host: its address (a URI) and its user, by name."""
    return [what for what, have in (("address", item.get("uris")), ("user", item.get("username"))) if not have]


def shown(item):
    """An item as a line names it: its name, or its id when the name holds a control or format character (a vault
    item can't rewrite the terminal it's shown on)."""
    return item["name"] if plain(item["name"]) else item["id"]


def save(provider, items, unmapped=()):
    """The snapshot: each item's id and revision date, and the ids of the new items roster.yml doesn't name yet."""
    data = {"synced": utc_now(), "items": items, "unmapped": sorted(unmapped)}
    write_private(snapshot_path(provider), json.dumps(data, indent=1, sort_keys=True) + "\n")


def ago(when: object, now: datetime | None = None) -> str:
    """'just now', '5 min ago', '3 h ago', '2 days ago' for an ISO time."""
    try:
        then = datetime.strptime(str(when)[:19] + "Z", UTC_TIME).replace(tzinfo=timezone.utc)
    except ValueError:
        return str(when)
    s = ((now or datetime.now(timezone.utc)) - then).total_seconds()
    if s < 60:
        return "just now"
    if s < 3600:
        return f"{int(s // 60)} min ago"
    if s < 2 * 86400:
        return f"{int(s // 3600)} h ago"
    return f"{int(s // 86400)} days ago"


# ---------------------------------------------------------------- every vault roster.yml uses (roster sync, vault sync)

# what an unlock in a terminal costs: Bitwarden keeps one unlock at a time
UNLOCK_COST = "unlocking here locks the roster app and any other bw session on this Box (bw keeps one unlock at a time)"


class NotAsked(providers.VaultLocked):
    """The vault step was skipped at its prompt (Ctrl-D): left as last synced."""


def sync_vaults(cfg, interactive=False):
    """Each vault roster.yml uses that keeps a local copy, synced (sync), one at a time: [(provider, result, error)],
    result None for a vault with nothing to sync, error what stopped it (a SecretError). Asks for a master password
    only when INTERACTIVE, once a run (T241's offer to keep it unlocked with it), saying first what that costs."""
    refs = fromvault.refs(cfg["path"])
    out = []
    for p in sorted(p for p in refs if p in providers.PROVIDERS and providers.holds_items(p)):
        if interactive and p == "bw" and bw_would_ask():    # #503's review MED-1: say what an unlock here costs
            print(f"note: the vault is locked, so roster asks for its master password once to sync it (Ctrl-D "
                  f"skips the vault). As with roster vault unlock, {UNLOCK_COST}", file=sys.stderr, flush=True)
        try:
            out.append((p, sync(p, interactive=interactive, mapped=fromvault.named(p, refs[p])), None))
        except EOFError:                   # Ctrl-D at the prompt: the vault is left as last synced
            out.append((p, None, NotAsked("no master password given")))
        except RuntimeError as e:          # a SecretError, or a provider's own failure: its words, never a value
            out.append((p, None, e))
    return out


def bw_would_ask():
    """Would a Bitwarden lookup now ask for the master password? Not with a working BW_SESSION or saved session, nor
    BW_PASSWORD; not when bw isn't logged in or installed (its own error says so)."""
    if os.environ.get("BW_PASSWORD") or not find_program("bw"):
        return False
    try:
        if providers.vault_status("bw") != "locked":    # unlocked by BW_SESSION, or not logged in
            return False
        return (providers.saved_session("bw") or ("none", None))[0] != "working"
    except providers.SecretError:
        return False
