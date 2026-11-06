"""What's left to do on this Box after the vault or the map changed (T243, #476, decision Q210): the one place that
knows it, so `roster sync`, `setup`, `vault sync` and `vault unlock` end with the same "next" line, and the messages
that name a missing step name the same command. What changed (the map's Hosts, a vault sync's items) is said here
too, as that line's first part.

Local state only: roster.yml as loaded, this Box's ssh config, roster's known_hosts, the Box key's record, the
rotation and Mesh records, the vault snapshots. Never a connection, a vault call or the network, and never the run
lock, so any command can ask it at no cost. A Gap names Hosts and the command that fixes it; never a vault value or a
path a token was typed in (Q207)."""

import json
from dataclasses import dataclass
from typing import Any, cast

from . import boxkeys, mesh, providers, rotation, sshconfig, vaultsync
from .common import NotPrivate, plural, read_private, replace_file, ssh_path
from .context import current
from .sshops import hk_name, known_names


@dataclass(frozen=True)
class Gap:
    """One thing left to do: KIND (one of ORDER), the Hosts it's about, what's
    missing (MESSAGE) and the one command that does it (FIX)."""
    kind: str
    hosts: tuple[str, ...]
    message: str
    fix: str


# The order the "next" line names them in: what the others need first
ORDER = ("sync", "unlock", "vault-items", "review", "setup", "rotate", "mesh", "check")


def never_answered(cfg: dict[str, Any]) -> list[str]:
    """The Hosts of CFG this Box has never reached: no host key of theirs in roster's known_hosts (setup records it,
    and so does the first `ssh NAME` through roster's ssh config). With setup_left, the Hosts setup hasn't finished:
    the local stand-in for "no key there yet" (a Host whose key was taken off by hand is check's to find)."""
    have = known_names()
    return sorted(n for n, h in cfg["hosts"].items() if hk_name(h) not in have)


def setup_left(cfg: dict[str, Any]) -> list[str]:
    """The Hosts of CFG the last `roster setup` that reached them didn't finish (the setup_left file)."""
    try:
        data = json.loads(read_private(current().file("setup_left")))
    except (FileNotFoundError, NotPrivate, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return sorted(n for n in cast(list[object], data) if isinstance(n, str) and n in cfg["hosts"])


def record_setup(cfg: dict[str, Any], done: list[str], left: list[str]) -> None:
    """After a setup: DONE (Host names now ready) come off the record of what it didn't finish, LEFT go on."""
    now = (set(setup_left(cfg)) - set(done)) | set(left)
    f = current().file("setup_left")
    if now:
        replace_file(f, json.dumps(sorted(now)) + "\n", mode=0o600)
    else:
        f.unlink(missing_ok=True)


def not_in_ssh_config(cfg: dict[str, Any]) -> list[str]:
    """The Hosts a plain `ssh NAME` wouldn't reach through this Inventory's part of roster's ssh config."""
    from .named import index_hosts, unnamed_from_elsewhere  # Pydantic: only once a roster.yml is loaded
    if unnamed_from_elsewhere() is not None:    # roster's unnamed file is another roster.yml's (sshops.not_reached)
        return sorted(cfg["hosts"])
    f = current().ssh_config
    written = set(sshconfig.written_hosts(f) or {})
    by_file = index_hosts()
    if by_file is not None:                     # named Inventories: this one's part of the index too
        written &= by_file.get(ssh_path(f), set())
    return sorted(n for n in cfg["hosts"] if n not in written)


def setup_fix(names: list[str] | tuple[str, ...]) -> str:
    return f"roster setup --host {names[0]}" if len(names) == 1 else "roster setup"


def gaps(cfg: dict[str, Any], hosts: Any = None, unmapped: Any = ()) -> list[Gap]:
    """What's left to do for CFG's Hosts (HOSTS: only those, by name), in ORDER. UNMAPPED: the new vault items
    roster.yml doesn't name yet, [{name, missing}] as a vault sync just found them (this module never asks the
    vault)."""
    wanted = set(cfg["hosts"] if hosts is None else hosts)
    out: list[Gap] = []
    missing = [n for n in not_in_ssh_config(cfg) if n in wanted]
    if missing:
        out.append(Gap("sync", tuple(missing), f"{names(missing)} not in this Box's ssh config", "roster sync"))
    if unmapped:
        n = len(unmapped)
        lacking = [f"{u['name']} has no {' or '.join(u['missing'])}" for u in unmapped if u["missing"]][:SHOWN]
        out.append(Gap("vault-items", (), f"{n} new vault item{'s' if n != 1 else ''} not in roster.yml"
                       + (f": {'; '.join(lacking)}" if lacking else ""), "roster add --from-vault"))
    waiting = sorted(n for n in wanted if not cfg["hosts"][n]["reviewed"])
    if waiting:
        out.append(Gap("review", tuple(waiting), f"{names(waiting)} waiting for review (reviewed: false)",
                       "review them in roster.yml, then set reviewed: true"))
    new = sorted(n for n in set(never_answered(cfg)) | set(setup_left(cfg))
                 if n in wanted and cfg["hosts"][n]["enroll"] and cfg["hosts"][n]["reviewed"])
    if new:
        out.append(Gap("setup", tuple(new), f"no key on {names(new)} yet", setup_fix(new)))
    out += rotation_gaps(cfg, wanted)
    if mesh.status(cfg)["out_of_date"]:
        out.append(Gap("mesh", (), "the Mesh changed in roster.yml since its last apply here", "roster mesh"))
    return sorted(out, key=lambda g: ORDER.index(g.kind))


def rotation_gaps(cfg: dict[str, Any], wanted: set[str]) -> list[Gap]:
    """A Box key rotation pending, or a Box key past key_max_age (T240): both finished by `roster setup --rotate`."""
    from .health import key_age  # Pydantic: only once a roster.yml is loaded
    pending = sorted(n for n in rotation.pending(cfg) if n in wanted)
    if pending:
        return [Gap("rotate", tuple(pending), f"the Box key rotation is pending on {names(pending)}",
                    "roster setup --rotate")]
    if key_age(cfg, boxkeys.box_key(cfg), "this Box's key"):
        return [Gap("rotate", (), f"this Box's key is past key_max_age: {cfg.get('key_max_age')}d",
                    "roster setup --rotate")]
    return []


SHOWN = 3                   # Host names a line lists before "and N more"
CHECK_HOSTS = 5             # setup's next line names at most this many Hosts as --host flags (#503's review LOW-1)


def names(hosts: list[str] | tuple[str, ...]) -> str:
    hosts = list(hosts)
    more = f" and {len(hosts) - SHOWN} more" if len(hosts) > SHOWN else ""
    return ", ".join(hosts[:SHOWN]) + more


def next_line(changed: list[str], left: list[Gap]) -> str | None:
    """The one line a command ends with: what CHANGED, then, only if something is LEFT, the next command (each
    distinct one once). None when nothing changed and nothing is left."""
    fixes: dict[str, list[str]] = {}
    for g in left:
        fixes.setdefault(g.fix, []).append(g.message)
    nxt = "; ".join(f"{fix} ({'; '.join(why)})" for fix, why in fixes.items())
    parts = list(changed) + ([f"next: {nxt}"] if nxt else [])
    return "; ".join(parts) or None


# ---------------------------------------------------------------- what changed

def setup_next_line(installed: list[str], locked_vaults: Any = ()) -> str | None:
    """setup's last line: the Hosts it put the key on and, to check them, `roster check --host` for exactly those
    (`roster check` past CHECK_HOSTS of them); a locked vault's own fix first (providers.unlock_fix). None when it
    changed nothing and nothing is left."""
    left = [Gap("unlock", (), f"{p} is locked", providers.unlock_fix(p)) for p in sorted(locked_vaults)]
    if installed:
        which = " ".join(f"--host {n}" for n in installed) if len(installed) <= CHECK_HOSTS else ""
        left.append(Gap("check", tuple(installed), "check them", f"roster check {which}".strip()))
    changed = [f"{'key' if len(installed) == 1 else 'keys'} on {plural(len(installed), 'Host')} ({names(installed)})"]
    return next_line(changed if installed else [], left)


def renamed(before: dict[str, str | None], cfg: dict[str, Any]) -> dict[str, str]:
    """{old name: new name}: a Host gone from the map whose address a new Host has (the same machine, renamed)."""
    new = {h["ip"]: n for n, h in cfg["hosts"].items() if n not in before}
    return {old: new[addr] for old, addr in before.items() if old not in cfg["hosts"] and addr in new}


def map_changes(before: dict[str, str | None], cfg: dict[str, Any]) -> str:
    """`1 Host added (db-01), 1 removed (web-01), 1 renamed (old-01 to new-01)`, or "" for none."""
    moved = renamed(before, cfg)
    added = sorted(n for n in cfg["hosts"] if n not in before and n not in moved.values())
    gone = sorted(n for n in before if n not in cfg["hosts"] and n not in moved)
    pairs = ", ".join(f"{a} to {b}" for a, b in sorted(moved.items()))
    return counted("Host", [(len(added), f"added ({names(added)})"), (len(gone), f"removed ({names(gone)})"),
                            (len(moved), f"renamed ({pairs})")])


def counted(noun: str, parts: list[tuple[int, str]]) -> str:
    """`2 Hosts added (a, b), 1 removed (c)`: the first non-zero count says the noun, the others don't."""
    shown = [(n, what) for n, what in parts if n]
    return ", ".join(f"{plural(n, noun) if i == 0 else n} {what}" for i, (n, what) in enumerate(shown))


def vault_changes(r: dict[str, Any]) -> str:
    """A vault sync's result as `1 item added (nas-01 ssh), 1 changed (web-01 ssh) since the last sync`; "" for none
    (and for a first sync, which only starts counting)."""
    if r["first"] or r["count"] is None:
        return ""
    what = counted("item", [(len(r["added"]), f"added ({names(r['added'])})"),
                            (len(r["changed"]), f"changed ({names(r['changed'])})"), (r["removed"], "removed")])
    return f"{what} since the last sync" if what else ""


def vault_not_synced(p: str, e: Exception) -> str:
    """Why provider P's vault wasn't synced, and what roster used instead: never a value (a SecretError's text never
    holds one)."""
    if isinstance(e, providers.NotLoggedIn):
        return f"not synced (not logged in: roster vault {p} --write -- login)" if p in ("bw", "op") else \
            f"not synced ({e})"
    if isinstance(e, providers.VaultLocked):
        return f"not synced ({e if isinstance(e, vaultsync.NotAsked) else 'locked'}; {providers.unlock_fix(p)})"
    when = vaultsync.last_synced(p)
    return f"not synced ({e})" + (f"; using it as last synced {vaultsync.ago(when)}" if when else "")
