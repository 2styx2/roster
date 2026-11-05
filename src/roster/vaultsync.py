"""`roster vault sync` (T222, #430, decision Q194): the vault isn't watched, so roster sees an item added or changed
elsewhere only after a sync. This syncs each vault roster.yml uses that keeps a local copy (Bitwarden: `bw sync`,
providers.sync_vault) and says what changed since the last sync: the items added and changed by name, the removed
ones by count.

What it compares against is a snapshot per provider in roster's config folder (`vault-sync/PROVIDER.json`, 0600):
each login item's id and revision date, and when it was taken. Never a name, password or any other value. The items
come from providers.vault_items, the listing that never reads a password (Bitwarden's through its filter, Q191).
`roster vault status` reads the snapshot's time for "last synced", with no vault call."""

import json
from datetime import datetime, timezone

from . import providers
from .common import UTC_TIME, NotPrivate, plain, read_private, say, utc_now, write_private
from .context import user_config_dir


def snapshot_path(provider):
    return user_config_dir() / "vault-sync" / f"{provider}.json"


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


def last_synced(provider):
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


def sync(provider, interactive=False):
    """Sync PROVIDER and compare its items with the last snapshot: {provider, first, count, added: [name],
    changed: [name], removed: n}, or None for a provider with nothing to sync. The snapshot is replaced only after a
    sync and a listing that worked. Raises SecretError."""
    if providers.sync_vault(provider, interactive) is None:
        return None
    if not providers.can_list(provider):
        save(provider, {})
        return {"provider": provider, "first": True, "count": None, "added": [], "changed": [], "removed": 0}
    items = providers.vault_items(provider, interactive=interactive)
    before = load(provider)
    added, changed, removed = diff((before or {}).get("items") or {}, items)
    save(provider, {i["id"]: i.get("revised") for i in items})
    return {"provider": provider, "first": before is None, "count": len(items),
            "added": [shown(i) for i in added], "changed": [shown(i) for i in changed], "removed": removed}


def shown(item):
    """An item as a line names it: its name, or its id when the name holds a control or format character (a vault
    item can't rewrite the terminal it's shown on)."""
    return item["name"] if plain(item["name"]) else item["id"]


def save(provider, items):
    data = {"synced": utc_now(), "items": items}
    write_private(snapshot_path(provider), json.dumps(data, indent=1, sort_keys=True) + "\n")


def ago(when, now=None):
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
