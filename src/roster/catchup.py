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

from . import boxkeys, errors, mesh, providers, rotation, sshconfig, vaultsync
from .common import NotPrivate, ago, plural, read_private, replace_file, ssh_path
from .context import current
from .errors import Problem
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
    new_address = sorted(readdressed(before, cfg))
    return counted("Host", [(len(added), f"added ({names(added)})"), (len(gone), f"removed ({names(gone)})"),
                            (len(moved), f"renamed ({pairs})"),
                            (len(new_address), f"with a new address ({names(new_address)})")])


def readdressed(before: dict[str, str | None], cfg: dict[str, Any]) -> dict[str, str]:
    """{name: old address}: a Host of the map whose address isn't the one roster last wrote for it (T243)."""
    return {n: was for n, was in before.items() if n in cfg["hosts"] and was and was != cfg["hosts"][n]["ip"]}


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
        if isinstance(e, vaultsync.NotAsked):   # Ctrl-D at the prompt: in a terminal already, so just the command
            return f"not synced ({e}; {providers.unlock_fix(p).removeprefix('run in a terminal: ')})"
        return f"not synced (locked; {providers.unlock_fix(p)})"
    when = vaultsync.last_synced(p)
    return f"not synced ({e})" + (f"; using it as last synced {ago(when)}" if when else "")


# ---------------------------------------------------------------- a failed login: its cause and its one fix

NO_ANSWER = ("no route to host", "timed out", "network is unreachable", "host is down", "no answer")
LOCKED = ("account has expired", "account is locked", "account locked", "password has expired",
          "password change required", "required to change your password", "account is disabled")
# a connection closed before the server's banner: a rate limiter, or OpenSSH 9.8+'s PerSourcePenalties (T258), which
# looks the same from here; paramiko (setup's password login) says it as "Error reading SSH protocol banner"
DROPPED = ("kex_exchange_identification", "connection reset by peer", "error reading ssh protocol banner")


def has_answered(h: dict[str, Any]) -> bool:
    """Has this Box ever reached H (its host key in roster's known_hosts)? Asked BEFORE a connection: roster's ssh
    config takes a new host key (accept-new), so after one the answer is always yes (#510's review HIGH-1)."""
    return hk_name(h) in known_names()


def keyed(cfg: dict[str, Any], h: dict[str, Any]) -> bool:
    """Did setup put this Box's key on H, by its own record (key_types, T245), and finish there (not in setup_left)?
    A positive record: known_hosts says only that something answered (#510's review HIGH-1)."""
    return h["name"] in boxkeys.installed() and h["name"] not in setup_left(cfg)


def not_set_up(cfg: dict[str, Any], h: dict[str, Any]) -> bool:
    """Should `roster run` watch H's one login (to name the fix if it fails) rather than hand over to ssh? Only for a
    key Host this Box has never reached, or one the last setup didn't finish: one whose login has worked before keeps
    run's exec, record or not (#510's second review LOW-5: a fleet set up before the key-types record)."""
    return bool(h["enroll"]) and (not has_answered(h) or h["name"] in setup_left(cfg))


def vault_item(h: dict[str, Any]) -> str | None:
    """The vault item H's ssh Login names (`bw:ITEM` gives ITEM, without a #FIELD), or None for env:, prompt and the
    like: a name, never a value."""
    auth = str(h["ssh"].get("auth") or "")
    name, _, spec = auth.partition(":")
    known: dict[str, Any] = cast(Any, providers).PROVIDERS
    if name not in known or name in ("env", "cmd", "prompt") or not spec:
        return None
    return str(cast(Any, providers).split_field(spec)[0])


def nist_offered(stderr: str) -> bool:
    """Did ssh -v's lines say the Host negotiated only NIST algorithms (a FIPS Host, T239)?"""
    low = stderr.lower()
    return "kex: algorithm: ecdh-sha2-nistp" in low and "host key algorithm: ssh-ed25519" not in low


def explain(cfg: dict[str, Any], h: dict[str, Any], stderr: str, password: bool = False,
            answered: bool | None = None) -> Problem:
    """What ssh's STDERR from one login to Host H means, as a Problem with its one fix (codes 209-215, else the step's
    own, diagnose.login_failure): a Host that never answered or stopped answering, no key there yet or one that no
    longer logs in, a password the vault item holds that the Host refuses, an account locked or expired, no password
    login, a rate limiter or sshd's PerSourcePenalties (T258), a FIPS Host (199, from ssh -v's kex lines). PASSWORD:
    the login used the Login's password. ANSWERED: has_answered(H) as it was before the login (taken now when None). Never a value: the item by name."""
    from . import diagnose
    login_failure, unreachable_fix = cast(Any, diagnose).login_failure, cast(Any, diagnose).unreachable_fix
    name, addr, user = h["name"], h["ip"], h["ssh"]["user"]
    # ssh's own words, without ssh -v's lines (#510's second review LOW-6: a server's pre-banner text is logged as
    # `debug1: kex_exchange_identification: banner line N`, which isn't a dropped connection)
    low = "\n".join(line for line in stderr.splitlines() if not line.startswith(("debug", "OpenSSH_"))).lower()
    answered = has_answered(h) if answered is None else answered
    nist_only = nist_offered(stderr)
    item = vault_item(h)
    if any(w in low for w in LOCKED):
        return Problem(errors.ACCOUNT_LOCKED, f"the account {user} on {name} is locked or its password expired",
                       fix=f"unlock it or set a new password on {name} (its console, or its admin), then put the new "
                           "one in " + (f"vault item '{item}'" if item else "its Login"), details=stderr)
    if any(w in low for w in DROPPED):
        return Problem(errors.SSH_RATE_LIMITED, f"{name} dropped the connection before ssh spoke: a rate limiter "
                       "after quick connections, or sshd shutting out this Box's address for a while after failed "
                       "logins from it (OpenSSH 9.8+'s PerSourcePenalties)", fix="wait about 4 minutes before the "
                       "next try (sshd's penalty grows with each failed login, up to 10 minutes by default), and run "
                       "one command at a time there (roster stops here rather than try again); if it keeps happening, "
                       f"{name}'s admin can check PerSourcePenalties in its sshd_config", details=stderr)
    if any(w in low for w in NO_ANSWER):
        if not answered:
            return Problem(errors.NEVER_ANSWERED, f"{name} has never answered at {addr}: is it on, and is that its "
                           "address?", fix=f"check {name}'s ip: in roster.yml" + (f" (and vault item '{item}', if "
                           "the address came from it)" if item else "") + "; " + unreachable_fix(
                               h, cfg.get("rate_limited") or []), details=stderr)
        return Problem(errors.STOPPED_ANSWERING, f"{name} stopped answering at {addr}",
                       fix=unreachable_fix(h, cfg.get("rate_limited") or []), details=stderr)
    if "permission denied" in low:
        offered = low.rpartition("permission denied")[2]
        if password and "password" not in offered and "keyboard-interactive" not in offered:
            return Problem(errors.NO_PASSWORD_LOGIN, f"{name} takes no password login (only keys), and this Box's "
                           "key isn't there", fix=f"setup needs a password login once: turn it on for {user} on "
                           f"{name} for the setup, or add this Box's key there by hand (its .pub file)", details=stderr)
        if password:
            what = f"the password in vault item '{item}'" if item else f"{name}'s Login password"
            # #510's review LOW-3: never "try it by hand": a faillock counts every failure
            return Problem(errors.PASSWORD_REFUSED, f"{what} doesn't log in to {name}: was it changed on one side "
                           "only?", fix="check " + (f"vault item '{item}'" if item else "the Login") + f" against "
                           f"{name}'s password (its admin, or its console); if this keeps failing, the account may be "
                           "locked after failed logins (faillock): ask its admin, and don't retry in a loop",
                           details=stderr)
        if h.get("enroll", True) and not (nist_only and h.get("key_type") == "ed25519"):
            if keyed(cfg, h):
                return Problem(errors.KEY_GONE, f"this Box's key no longer logs in to {name} (taken off there?)",
                               fix=f"roster setup --host {name} puts it back", details=stderr)
            if answered and name not in setup_left(cfg):    # reached before, no record: a setup before the record
                return Problem(errors.KEY_GONE, f"this Box's key isn't on {name} by roster's record (never set up "
                               "from this Box, or taken off)", fix=setup_fix([name]), details=stderr)
            return Problem(errors.NO_KEY_YET, f"no key on {name} yet", fix=setup_fix([name]), details=stderr)
    return login_failure(h, password, stderr, cfg.get("rate_limited") or [], nist_only=nist_only)


def limiter_of(cfg: dict[str, Any], h: dict[str, Any]) -> str | None:
    """The network whose SSH rate limiter H is behind, as far as roster can tell: its `rate_limited:` network, else
    its /24 (IPv4). None for a name or an IPv6 address outside rate_limited:."""
    import ipaddress
    try:
        addr = ipaddress.ip_address(str(h["ip"]).partition("%")[0])
    except ValueError:
        return None
    limited: list[str] = cfg.get("rate_limited") or []
    for n in limited:
        if addr in ipaddress.ip_network(n, strict=False):
            return n
    return str(ipaddress.ip_network(f"{addr}/24", strict=False)) if addr.version == 4 else None


def login_checks(cfg: dict[str, Any], hosts: list[dict[str, Any]], workers: int) -> dict[str, tuple[bool, Any]]:
    """One key login to each of HOSTS (in parallel, WORKERS at a time): {name: (worked, Problem or None)}, each
    failure explained. Once a login was dropped by a rate limiter (215), the Hosts behind the same one (limiter_of)
    that haven't started yet aren't tried: they get a 215 that says so (#510's review LOW-2)."""
    import concurrent.futures as cf
    import threading

    from .sshops import login_probe
    stopped: set[str] = set()
    lock = threading.Lock()

    def one(h: dict[str, Any]) -> tuple[str, bool, Any]:
        behind = limiter_of(cfg, h)
        with lock:
            if behind in stopped:
                return h["name"], False, Problem(
                    errors.SSH_RATE_LIMITED, f"{h['name']} not checked: a Host in {behind} dropped the connection (a "
                    "rate limiter), so roster stopped connecting there", fix="wait about 4 minutes, then check again")
        answered = has_answered(h)          # before the login: accept-new records a new host key (HIGH-1)
        ok, stderr = login_probe(h["name"])
        why = None if ok else explain(cfg, h, stderr, answered=answered)
        if why is not None and why.code == errors.SSH_RATE_LIMITED and behind is not None:
            with lock:
                stopped.add(behind)
        return h["name"], ok, why
    with cf.ThreadPoolExecutor(max(1, workers)) as ex:
        return {name: (ok, why) for name, ok, why in ex.map(one, hosts)}


# What setup's password login (paramiko, sshops.password_exec) says, as ssh would: explain reads ssh's words
SETUP_WORDS = (("takes no password login", "Permission denied (publickey)."),
               ("login refused", "Permission denied (password)."),
               ("can't connect", ""),
               ("error reading ssh protocol banner", ""))


def setup_failure(cfg: dict[str, Any], h: dict[str, Any], text: str) -> str:
    """A setup failure's line for Host H: `[code] message: fix` when explain knows its cause, else TEXT as it was."""
    low = text.lower()
    said = text if any(w in low for w in LOCKED) else \
        next((ssh if ssh else text for words, ssh in SETUP_WORDS if words in low), None)
    if said is None:
        return text
    p = explain(cfg, h, said, password=True)
    if p.code in (errors.AUTH_FAILED, errors.LOOKUP_FAILED):
        return text
    return f"{errors.tagged(p)}: {p.fix}"
