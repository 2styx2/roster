"""The Box's health (ticket 49): Neovim's `:checkhealth` for roster. `roster check --box` and serve's box.check run
the same checks, a section at a time, each {section, level: ok|warn|error, message, fix?, topic?}: the fix in a
sentence, the topic a `:help` topic (an error catalog row, E1, or a page). Every check is local: files, PATH, the
vault CLI's own status and the infra repo's git as this Box last saw it. Nothing logs in to a Host, scans one or
fetches; `roster check HOST` is the one that connects. No check returns a secret (Logins are counted, never read)."""

import platform
from datetime import datetime, timezone
from typing import Any, NamedTuple, cast

from . import __version__, boxkeys, changes, named, providers, rotation, store
from .common import find_program
from .config import load_config, shown_file
from .context import Context, current, ssh_index_file
from .errors import (
    BOX_KEY_REMADE,
    INDEX_NOT_WRITTEN,
    KEY_TOO_OLD,
    OTHER_DOESNT_LOAD,
    ROTATION_PENDING,
    SAME_ADDRESS,
    SAME_HOST_NAME,
    SAME_MACHINE,
    SHARED_BOX_NAME,
    InventoryError,
    Problem,
)
from .hosts import NO_PASSWORD, placeholder_user, provider_of
from .providers import PROVIDERS
from .sshops import fingerprint, hk_name, known_names

# The sections, in order, with the name the CLI prints (the app has its own titles, by id).
SECTIONS = {"roster": "roster", "inventory": "Inventory", "ssh": "ssh", "vault": "Vault", "askpass": "askpass",
            "repo": "Infra repo"}
# Names many machines carry out of the box (an OS image's default hostname): a Box named one of them likely shares
# its name with another Box, and Boxes with one name are one owner (#384). Lower case: compared with the name
# lowered (config.py keeps its case).
COMMON_BOX_NAMES = frozenset({
    "localhost", "localdomain", "none", "-none-", "default", "ubuntu", "ubuntu-server", "debian", "raspberrypi",
    "raspberry", "dietpi", "kali", "fedora", "centos", "rocky", "rockylinux", "almalinux", "archlinux", "alpine",
    "nixos", "opensuse", "manjaro", "linuxmint", "mint", "pop-os", "vagrant", "osmc", "orangepi", "libreelec",
    "macbook", "macbook-pro", "macbook-air", "imac", "imac-pro", "mac-mini", "mac-pro", "mac-studio"})
SHOWN = 5                   # names listed before "and N more"


# The error catalog's row (docs/app/errors.md) of each code a check is about: its `:help` topic is E<row>
# (tests/test_health.py checks them against the catalog).
ROWS = {OTHER_DOESNT_LOAD: 192, SAME_MACHINE: 193, SAME_HOST_NAME: 194, SAME_ADDRESS: 195, INDEX_NOT_WRITTEN: 206,
        SHARED_BOX_NAME: 222, ROTATION_PENDING: 268, KEY_TOO_OLD: 269, BOX_KEY_REMADE: 280}


def topic_of(code):
    return f"E{ROWS[code]}"


def check(section, level, message, fix=None, topic=None, **extra):
    return {"section": section, "level": level, "message": message,
            **({"fix": fix} if fix else {}), **({"topic": topic} if topic else {}), **extra}


def coded(section, level, problem):
    """A check that is PROBLEM (a code of its own, which the CLI shows as `[CODE] `), with its fix and topic."""
    return check(section, level, problem.message, problem.fix, topic_of(problem.code), code=problem.code)


def names(items):
    items = sorted(items)
    more = len(items) - SHOWN
    return ", ".join(items[:SHOWN]) + (f" and {more} more" if more > 0 else "")


def count(n, word):
    return f"{n} {word}" + ("" if n == 1 else "s")


def askpass_state(channel, error=None):
    """(ok, message) for the askpass check, from CHANNEL (an askpass.Channel, None when there's none) or ERROR (why
    it couldn't open). One for the CLI and serve: a channel that opened can still be unable to work (Windows
    without roster-askpass.exe: `problem`)."""
    if error is not None:
        return False, f"the askpass channel can't open here: {error}"
    if channel is None:
        return False, "this roster serve has no askpass channel, so password Sessions can't log in"
    if channel.problem:
        return False, channel.problem
    return True, "the askpass channel is open"


def check_box(cfg, error, askpass, api_version=None):
    """Every check, in SECTIONS order. CFG: the loaded Inventory (serve's last good one even while the file doesn't
    load), or None; ERROR: the InventoryError roster.yml doesn't load with now, or None; ASKPASS: (ok, message) for
    the askpass channel (askpass_state). API_VERSION: serve's, for the roster line."""
    out = [roster_version(api_version)]
    out += inventory(cfg, error)
    out += ssh(cfg)
    out += vault(cfg)
    out.append(check("askpass", "ok" if askpass[0] else "error", askpass[1],
                     None if askpass[0] else "restart `roster serve` (the app's :source does not); if it fails "
                                             "again, its stderr says why"))
    out += repo(cfg["path"] if cfg else None)
    return out


def roster_version(api_version):
    serve = f", serve API {api_version}" if api_version else ""
    return check("roster", "ok", f"roster {__version__}{serve}, Python {platform.python_version()}")


# ---------------------------------------------------------------- Inventory

def inventory(cfg, error):
    out = []
    if error is not None:
        last = "; the app shows the last good one" if cfg else ""
        out.append(check("inventory", "error", f"roster.yml doesn't load: {error.message}{last}", error.fix, "E1"))
    if cfg is None:
        return out
    hosts = list(cfg["hosts"].values())
    if error is None:
        out.append(check("inventory", "ok", f"roster.yml loads: {shown_file(cfg)} ({count(len(hosts), 'Host')}, "
                                            f"{count(len(cfg['groups']), 'group')})"))
    waiting = [h["name"] for h in hosts if not h["reviewed"]]
    if waiting:
        out.append(check("inventory", "warn", f"{count(len(waiting), 'Host')} wait for review: {names(waiting)}",
                         "review each one (`:review` in the app), or set reviewed: true in roster.yml", "E3"))
    no_user = [h["name"] for h in hosts if h["reviewed"] and placeholder_user(h)]
    if no_user:
        out.append(check("inventory", "warn", f"no SSH user for {names(no_user)}",
                         "set user: on the Host or its group in roster.yml", "E4"))
    left_out = [h["name"] for h in hosts if h["problems"]]
    if left_out:
        n = sum(len(h["problems"]) for h in hosts)
        out.append(check("inventory", "warn", f"{count(n, 'service entry')} left out, on {names(left_out)}",
                         "`roster hosts` prints each one with its fix", "E57"))
    out += named_inventories(cfg)
    return out


def named_inventories(cfg):
    """The named Inventories (ticket 115): which one this is, and the same machine in two of them (warnings only)."""
    if not named.list_file().exists():
        return []
    inv = named.load()
    if not inv.inventories:
        return []
    here = current().name
    which = (f"this is the named Inventory {here}" + (" (the active one)" if here == inv.active else "")
             if here else "this roster.yml isn't one of the named Inventories")
    out = [check("inventory", "ok", f"{which}; named: {', '.join(x.name for x in inv.inventories)}")]
    out += [check("inventory", "warn", w["message"], w["fix"], topic_of(w["code"])) for w in overlaps(cfg)]
    for f in named.foreign_legacy_files(inv):
        out.append(check("inventory", "warn", f"{f} has the name roster once used for a named Inventory's ssh config, "
                                              "but roster didn't write it, so it's left as it is",
                         "nothing to do if it's yours; rename it if `Include` picks it up by mistake"))
    if named.stale():
        out.append(check("inventory", "warn", f"{ssh_index_file()} is older than this Box's ssh config "
                                              "files and couldn't be rewritten", "make it writable, then run "
                                              "`roster sync`", topic_of(INDEX_NOT_WRITTEN)))
    return out


# ---------------------------------------------------------------- ssh

def ssh(cfg):
    out = []
    client = find_program("ssh")
    if client:
        out.append(check("ssh", "ok", f"ssh found: {client}"))
    else:
        out.append(check("ssh", "error", "no ssh client on this Box's PATH",
                         "install OpenSSH (the openssh-client package)", "E2"))
    if cfg is None:
        return out
    hosts = [h for h in cfg["hosts"].values() if h["reviewed"]]
    ours, written = current().ssh_config, named.reachable_hosts()
    if written is None:
        out.append(check("ssh", "error", f"roster's ssh config ({ours}) isn't written, or ~/.ssh/config doesn't "
                                         "include it", "run `roster sync` (or `roster setup` on a new Box)", "E2"))
    else:
        shadowed = named.left_out_hosts()     # another named Inventory's Host has the name: warning 146 says so
        missing = [h["name"] for h in hosts if h["name"] not in written and h["name"] not in shadowed]
        if missing:
            out.append(check("ssh", "warn", f"{count(len(missing), 'Host')} not in roster's ssh config yet: "
                                            f"{names(missing)}", "run `roster sync`", "E2"))
        else:
            out.append(check("ssh", "ok", f"roster's ssh config has every Host: {ours}"))
    if str(cfg["box"]).lower() in COMMON_BOX_NAMES:
        out.append(check("ssh", "warn", f"this Box's name, {cfg['box']} (box_name:, or the hostname), is a common "
                                        "default, so another Box may have it too: Boxes with the same name are one "
                                        "owner, so each one's setup and revoke take the other's key, and each one's "
                                        "Mesh the other's entries, off the Hosts they share",
                         "set box_name: in roster.yml to a name no other Box uses, then run `roster setup` (on a Box "
                         "already set up, it re-tags this Box's key under the new name where it works; a same-named "
                         "Box whose key was taken runs `roster setup` again)", topic_of(SHARED_BOX_NAME)))
    for key in boxkeys.in_use(cfg, hosts):          # one per key type its key Hosts use
        what = "this Box's key" if key.type.name == boxkeys.DEFAULT else f"this Box's {key.type.name} key"
        if key.key.exists():
            out.append(check("ssh", "ok", f"{what}: {key.key}"))
            out += key_age(cfg, key, what)
        elif boxkeys.was_made(key.key):             # T243: roster made it, and it's gone since
            out.append(coded("ssh", "error", Problem(
                BOX_KEY_REMADE, f"{what} is gone ({key.key}, deleted?): every Host it was on lost this Box's key login",
                fix="run `roster setup`: it makes a new key and puts it on every Host it can log in to with a password")))
        else:
            kind = "" if key.type.name == boxkeys.DEFAULT else f"{key.type.name} "
            out.append(check("ssh", "warn", f"this Box has no {kind}key yet ({key.key}), so key Logins "
                                            f"{'' if not kind else 'with it '}can't work", "run `roster setup`",
                             "E12"))
    out += rotation_pending(cfg)
    if not current().known_hosts.exists():
        out.append(check("ssh", "warn", f"roster's known hosts ({current().known_hosts}) isn't there yet",
                         "run `roster setup`; until then each Session asks before it trusts a Host's key", "E14"))
    else:
        known = known_names()
        unknown = [h["name"] for h in hosts if hk_name(h) not in known]
        if unknown:
            out.append(check("ssh", "warn", f"no recorded host key for {count(len(unknown), 'Host')}: "
                                            f"{names(unknown)}",
                             "a Session asks before it trusts one; `roster setup` records them all", "E14"))
        else:
            out.append(check("ssh", "ok", f"roster's known hosts has every Host's key: {current().known_hosts}"))
    return out


def key_age(cfg: dict[str, Any], key: Any, what: str) -> list[Any]:
    """T240: a warning once KEY (boxkeys.BoxKey) is older than key_max_age: (on by default, 365d; off: none). Only a
    warning: roster never rotates by itself."""
    limit = cfg.get("key_max_age")
    made = boxkeys.created(key.key)
    if limit is None or made is None:
        return []
    days = (datetime.now(timezone.utc) - made).days
    if days <= limit:
        return []
    return [coded("ssh", "warn", Problem(
        KEY_TOO_OLD, f"{what} is {days} days old, past key_max_age: {limit}d ({key.key})",
        fix="rotate it: `roster setup --rotate` puts a new key on every Host, proves it, then removes the old (or set "
            "key_max_age: in roster.yml; off turns this off)"))]


def rotation_pending(cfg):
    """T240: the Box key rotation isn't finished: the old Box key is still on these Hosts (#471's LOW-5)."""
    waiting = rotation.pending(cfg)
    # the record unreadable, an old key kept: said even when no Host waits
    out = [coded("ssh", "warn", p) for p in rotation.problems(cfg)]
    if not waiting:
        return out
    return out + [coded("ssh", "warn", Problem(
        ROTATION_PENDING, f"Box key rotation pending on {count(len(waiting), 'Host')}: {names(waiting)} (the old Box "
                          "key is still on them)",
        fix="run `roster setup --rotate` again once they answer: it finishes them"))]


# ---------------------------------------------------------------- Vault

def provider_uses(cfg):
    """Every provider the Inventory's Host Logins name (ssh, a Host's default, services), with how many use each."""
    counts = {}
    for h in cfg["hosts"].values():
        for login in (h["ssh"], h["login"], *h["services"].values()):
            name = provider_of(login.get("auth"))
            if name and name not in NO_PASSWORD:
                counts[name] = counts.get(name, 0) + 1
    return counts


def referenced_providers(cfg):
    """Providers the Inventory's Host Logins use, most used first, known ones only."""
    counts = {n: c for n, c in provider_uses(cfg).items() if n in PROVIDERS}
    return sorted(counts, key=lambda n: (-counts[n], n))


def vault(cfg):
    if cfg is None:
        return []
    uses = {n: c for n, c in provider_uses(cfg).items() if n != "prompt"}     # prompt: typed, no vault to check
    if not uses:
        return [check("vault", "ok", "no Host Login uses a vault")]
    return [provider_check(name, n) for name, n in sorted(uses.items(), key=lambda kv: (-kv[1], kv[0]))] + \
        not_in_inventory(cfg)


def not_in_inventory(cfg):
    """The vault items no Login in roster.yml names that were new at the last `roster add --from-vault` (T221, Q191):
    that run's count, never a vault call here."""
    from .fromvault import cached_count
    cached = cached_count(cfg["path"])
    if not cached or not cached[0]:
        return []
    n, when = cached
    return [check("vault", "ok", f"{count(n, 'vault item')} {'isn' if n == 1 else 'aren'}'t in roster.yml; roster add --from-vault"
                                 + (f" (as of {str(when)[:16].replace('T', ' ')} UTC)" if when else ""))]


def provider_check(name, n):
    used = f"{count(n, 'Login')}"
    if name not in PROVIDERS:
        return check("vault", "error", f"'{name}:' is used by {used} but isn't a provider on this Box",
                     "see `roster vault status` for the ones there are, then fix auth: in roster.yml", "E5")
    tool = PROVIDERS[name].get("tool") or ""
    try:
        status, account = providers.vault_account(name)
    except providers.SecretError as e:
        return check("vault", "error", f"{name} ({used}): {e}", None, "E6")
    who = f" as {account['email']}" if account and account.get("email") else ""
    if status == "missing" or (status == "unsupported" and tool and not find_program(tool)):
        return check("vault", "error", f"{name} ({used}): {providers.not_installed(name)}",
                     f"install `{tool or name}`", "E6")
    if status == "unauthenticated":
        return check("vault", "error", f"{name} ({used}): {providers.status_message(name, status)}",
                     "sign in from the app's lock screen, or in a terminal", "E6")
    if status in ("locked", "unlocked"):
        state = "locked; it asks for the master password when a Login needs it" if status == "locked" else "unlocked"
        try:
            saved = providers.saved_session(name)
        except providers.SecretError as e:
            return check("vault", "error", f"{name} ({used}): {e}", None, "E6")
        if saved is None:
            return check("vault", "ok", f"{name} ({used}): logged in{who}, {state}")
        return session_check(name, used, who, status, *saved)
    found = f", `{tool}` found" if tool else ""
    return check("vault", "ok", f"{name} ({used}): no lock to check{found}")


SAVED = {"none": "none (every run asks)", "working": "saved, working", "expired": "saved, expired",
         "ignored": "saved, ignored", "unknown": "unknown"}


def session_check(name, used, who, status, saved, why):
    """provider_check for a vault with a saved session (T241, Q203): its state in the message and as saved_session."""
    from .providers.bitwarden import UNTIL, session_file
    head = f"{name} ({used}): logged in{who}, "
    if saved == "working":
        return check("vault", "ok", f"{head}unlocked for every run by the saved session (saved session: saved, "
                                    f"working) until {UNTIL}", saved_session=saved)
    state = "unlocked" if status == "unlocked" else "locked; it asks for the master password when a Login needs it"
    if saved == "none":
        return check("vault", "ok", f"{head}{state}; saved session: none (every run asks)",
                     "to stay unlocked on this Box: roster vault unlock", saved_session=saved)
    if saved == "expired":
        return check("vault", "warn", f"{head}{state}; saved session: saved, expired ({session_file()} was locked "
                                      "since it was saved, e.g. by the roster app's lock or a bw lock/unlock)",
                     "roster vault unlock saves a new one", saved_session=saved)
    if saved == "unknown":
        return check("vault", "warn", f"{head}{state}; saved session: unknown ({why})",
                     "run `roster vault bw -- status` to see what bw says", saved_session=saved)
    return check("vault", "warn", f"{head}{state}; saved session: saved, ignored ({why})",
                 "remove it, then run roster vault unlock", saved_session=saved)


# ---------------------------------------------------------------- the infra repo

def repo(path):
    """How roster.yml is kept (store.py, T212): a plain file is a note, no warning; in a repo, its git as this Box last
    saw it (no fetch): clean, Pending changes, or other changes."""
    if path is None:
        return []
    kept = store.at(path, for_show=True)
    if kept.kind == store.FILE:
        return [check("repo", "ok", kept.note)]
    try:
        r = changes.Repo(path)
    except Problem as e:
        return [check("repo", "warn", f"{e.message}; edits in the app need it", e.fix, "E38")]
    out = []
    diff = changes.diff(path)
    if diff["count"] and diff["diff"]:
        out.append(check("repo", "warn", f"{count(diff['count'], 'Pending change')} to roster.yml, not "
                                         "published yet", "`:publish` in the app sends them, `:discard` drops them",
                         ":publish"))
    others = [f for f in changes.dirty_files(r) if f != r.rel]
    if others:
        out.append(check("repo", "warn", f"other uncommitted files in {r.top}: {names(others)}",
                         f"commit or discard them in a terminal (git -C {r.top} status); Publish refuses until then",
                         "E47"))
    last = diff["last_commit"]
    if last and last.get("upstream") and last.get("pushed") is False:
        out.append(check("repo", "warn", f"this Box has commits that aren't on {last['upstream']} (as last fetched)",
                         f"push them, or look in a terminal: git -C {r.top} status", "E49"))
    if not out:
        out.append(check("repo", "ok", f"clean: {r.top}"))
    return out


# ---------------------------------------------------------------- the same machine in two Inventories

# (code, catalog row, fix) for each warning
WARNINGS = {
    "doesnt_load": (OTHER_DOESNT_LOAD, "`roster --inv {other} check --box` says why; fix that file, or `roster inv "
                                       "remove {other}` if you no longer use it"),
    "same_machine": (SAME_MACHINE, "nothing to do if it's one machine you reach from both; if it isn't, one was cloned "
                                   "with the other's host key: give it its own (`ssh-keygen -A` on it, then record it "
                                   "again)"),
    "same_name": (SAME_HOST_NAME, "rename one of them in its roster.yml; until then roster reaches {other}'s `{name}` "
                                  "only once {other} is the active Inventory (`roster inv use {other}`)"),
    "same_address": (SAME_ADDRESS, "nothing to do if the two are on different networks; if it's one machine, its key "
                                   "changed: `roster check {name}` compares it with the recorded one"),
}


def warning(kind: str, message: str, **names: str) -> dict[str, Any]:
    code, fix = WARNINGS[kind]
    return {"code": code, "row": ROWS[code], "message": message, "fix": fix.format(**names)}


class Machine(NamedTuple):
    """A Host as the comparison sees it: its name, address, ssh port and recorded host-key fingerprints."""

    name: str
    ip: str
    port: int
    keys: frozenset[str]


def machines(name: str | None, cfg: dict[str, Any]) -> list[Machine]:
    """The Hosts of the Inventory CFG, with the fingerprints recorded for each in the Inventory NAME's known_hosts."""
    import paramiko
    f = Context(name).known_hosts
    try:
        recorded = paramiko.HostKeys(str(f)) if f.is_file() else None
    except (OSError, ValueError, paramiko.SSHException):
        recorded = None
    out: list[Machine] = []
    hosts = cast("dict[str, dict[str, Any]]", cfg["hosts"])
    for h in hosts.values():
        found = recorded.lookup(hk_name(h)) if recorded is not None else None
        keys = frozenset(fingerprint(k) for k in found.values()) if found else frozenset[str]()
        out.append(Machine(str(h["name"]), str(h["ip"]), int(h["ssh"]["port"]), keys))
    return out


def overlaps(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """The warnings for the Inventory CFG (this run's) against every other named Inventory: the same host key, the
    same Host name, the same address and port with different keys. Never an error; compares fingerprints only."""
    if not named.list_file().exists():
        return []
    inv = named.load()
    here = current().name
    others = [x for x in inv.inventories if x.name != here and not named.same_file(x.path, cfg["path"])]
    if not others:
        return []
    label = here or "this Inventory"
    mine = machines(here, cfg)
    out: list[dict[str, Any]] = []
    for x in others:
        try:
            theirs = machines(x.name, load_config(x.path))
        except InventoryError:              # its words could quote a line of that file: they stay with it
            out.append(warning("doesnt_load", f"{x.name}'s roster.yml doesn't load, so it isn't compared with this one",
                               other=x.name))
            continue
        reported: set[tuple[str, str]] = set()
        for h in mine:
            for o in theirs:
                if h.keys & o.keys:
                    reported.add((h.name, o.name))
                    out.append(warning("same_machine", f"`{h.name}` in {label} and `{o.name}` in {x.name} have "
                                                       "the same host key: the same machine?"))
        names = {o.name for o in theirs}
        for h in mine:
            if h.name in names and (h.name, h.name) not in reported:
                wins = label if here == inv.active else x.name if x.name == inv.active else None
                loser = x.name if wins == label else label
                where = (f"`ssh {h.name}` reaches {wins}'s (the active Inventory); {loser}'s `{h.name}` is left out "
                         "of this Box's ssh config") if wins else \
                    (f"`ssh {h.name}` reaches the one listed first in `roster inv list`; the other is left out of "
                     "this Box's ssh config")
                out.append(warning("same_name", f"`{h.name}` is a Host in both {label} and {x.name}: {where}",
                                   other=loser if wins else x.name, name=h.name))
        for h in mine:
            for o in theirs:
                if (h.ip, h.port) == (o.ip, o.port) and h.keys and o.keys and not h.keys & o.keys:
                    out.append(warning("same_address", f"`{h.name}` in {label} and `{o.name}` in {x.name} are both "
                                                       f"{h.ip}:{h.port}, with different host keys: two networks "
                                                       "with the same addresses?", name=h.name))
    return out
