"""What's left to do on this Box after the vault or the map changed (T243, #476, decision Q210): the one place that
knows it, so `roster sync`, `setup`, `vault sync` and `vault unlock` end with the same "next" line, and the messages
that name a missing step name the same command.

Local state only: roster.yml as loaded, this Box's ssh config, roster's known_hosts, the Box key's record, the
rotation and Mesh records. Never a connection, a vault call or the network, and never the run lock, so any command
can ask it at no cost. A Gap names Hosts and the command that fixes it; never a vault value or a path a token was
typed in (Q207)."""

from dataclasses import dataclass
from typing import Any


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
    from .sshops import hk_name, known_names
    have = known_names()
    return sorted(n for n, h in cfg["hosts"].items() if hk_name(h) not in have)


def setup_left(cfg: dict[str, Any]) -> list[str]:
    """The Hosts of CFG the last `roster setup` that reached them didn't finish (setup_left_file)."""
    import json

    from .common import NotPrivate, read_private, setup_left_file
    try:
        data = json.loads(read_private(setup_left_file()))
    except (FileNotFoundError, NotPrivate, ValueError):
        return []
    return sorted(n for n in data if isinstance(data, list) and isinstance(n, str) and n in cfg["hosts"])


def record_setup(cfg: dict[str, Any], done: Any, left: Any) -> None:
    """After a setup: DONE (Host names now ready) come off the record of what it didn't finish, LEFT go on."""
    import json

    from .common import replace_file, setup_left_file
    now = (set(setup_left(cfg)) - set(done)) | set(left)
    f = setup_left_file()
    if now:
        replace_file(f, json.dumps(sorted(now)) + "\n", mode=0o600)
    else:
        f.unlink(missing_ok=True)


def not_in_ssh_config(cfg: dict[str, Any]) -> list[str]:
    """The Hosts a plain `ssh NAME` wouldn't reach through this Inventory's part of roster's ssh config."""
    from .common import ssh_config_file, ssh_path
    from .inventories import index_hosts, unnamed_from_elsewhere
    if unnamed_from_elsewhere() is not None:    # roster's unnamed file is another roster.yml's (sshops.not_reached)
        return sorted(cfg["hosts"])
    f = ssh_config_file()
    written = {line[5:].strip() for line in f.read_text().splitlines() if line.startswith("Host ")} if f.is_file() \
        else set()
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
    out = []
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
    from . import mesh
    if mesh.status(cfg)["out_of_date"]:
        out.append(Gap("mesh", (), "the Mesh changed in roster.yml since its last apply here", "roster mesh"))
    return sorted(out, key=lambda g: ORDER.index(g.kind))


def rotation_gaps(cfg: dict[str, Any], wanted: set[str]) -> list[Gap]:
    """A Box key rotation pending, or a Box key past key_max_age (T240): both finished by `roster setup --rotate`."""
    from . import boxkeys, rotation
    from .health import key_age
    pending = sorted(n for n in rotation.pending(cfg) if n in wanted)
    if pending:
        return [Gap("rotate", tuple(pending), f"the Box key rotation is pending on {names(pending)}",
                    "roster setup --rotate")]
    if key_age(cfg, boxkeys.box_key(cfg), "this Box's key"):
        return [Gap("rotate", (), f"this Box's key is past key_max_age: {cfg.get('key_max_age')}d",
                    "roster setup --rotate")]
    return []


SHOWN = 3                   # Host names a line lists before "and N more"


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


# ---------------------------------------------------------------- a failed login: its cause and its one fix

NO_ANSWER = ("no route to host", "timed out", "network is unreachable", "host is down", "no answer")
LOCKED = ("account has expired", "account is locked", "account locked", "password has expired",
          "password change required", "required to change your password", "account is disabled")
DROPPED = ("kex_exchange_identification", "connection reset by peer")


def has_answered(h: dict[str, Any]) -> bool:
    """Has this Box ever reached H (its host key in roster's known_hosts)?"""
    from .sshops import hk_name, known_names
    return hk_name(h) in known_names()


def not_set_up(cfg: dict[str, Any], h: dict[str, Any]) -> bool:
    """Is H a key Host this Box never reached, or one the last setup didn't finish? (`roster run` then watches its one
    login, to name the fix if it fails)"""
    return bool(h["enroll"]) and (not has_answered(h) or h["name"] in setup_left(cfg))


def vault_item(h: dict[str, Any]) -> str | None:
    """The vault item H's ssh Login names (`bw:ITEM` gives ITEM, without a #FIELD), or None for env:, prompt and the
    like: a name, never a value."""
    from . import providers
    auth = str(h["ssh"].get("auth") or "")
    name, _, spec = auth.partition(":")
    if name not in providers.PROVIDERS or name in ("env", "cmd", "prompt") or not spec:
        return None
    return providers.split_field(spec)[0]


def explain(cfg: dict[str, Any], h: dict[str, Any], stderr: str, password: bool = False, nist_only: bool = False) -> Any:
    """What ssh's STDERR from one login to Host H means, as a Problem with its one fix (codes 209-215, else the step's
    own, diagnose.login_failure): a Host that never answered or stopped answering, no key there yet or one that no
    longer logs in, a password the vault item holds that the Host refuses, an account locked or expired, no password
    login, a rate limiter. PASSWORD: the login used the Login's password; NIST_ONLY: the Host offered only NIST
    algorithms (a FIPS Host: login_failure's 199 says key_type: ecdsa). Never a value: the vault item by name."""
    from . import errors
    from .diagnose import login_failure, unreachable_fix
    from .errors import Problem
    name, addr, user, low = h["name"], h["ip"], h["ssh"]["user"], stderr.lower()
    item = vault_item(h)
    if any(w in low for w in LOCKED):
        return Problem(errors.ACCOUNT_LOCKED, f"the account {user} on {name} is locked or its password expired",
                       fix=f"unlock it or set a new password on {name} (its console, or its admin), then put the new "
                           "one in " + (f"vault item '{item}'" if item else "its Login"), details=stderr)
    if any(w in low for w in DROPPED):
        return Problem(errors.SSH_RATE_LIMITED, f"{name} dropped the connection before ssh spoke: a rate limiter "
                       "after quick connections, most likely", fix="wait about 4 minutes before the next try, and "
                       "run one command at a time there (roster stops here rather than try again)", details=stderr)
    if any(w in low for w in NO_ANSWER):
        if not has_answered(h):
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
            return Problem(errors.PASSWORD_REFUSED, f"{what} doesn't log in to {name}: was it changed on one side "
                           "only?", fix=f"log in to {name} by hand with the password you expect, then fix "
                           + (f"vault item '{item}'" if item else "the Login") + " or the Host", details=stderr)
        if h.get("enroll", True) and not (nist_only and h.get("key_type") == "ed25519"):
            if name in setup_left(cfg) or not has_answered(h):
                return Problem(errors.NO_KEY_YET, f"no key on {name} yet", fix=setup_fix([name]), details=stderr)
            return Problem(errors.KEY_GONE, f"this Box's key no longer logs in to {name} (taken off there?)",
                           fix=f"roster setup --host {name} puts it back", details=stderr)
    return login_failure(h, password, stderr, cfg.get("rate_limited") or [], nist_only=nist_only)


# What setup's password login (paramiko, sshops.password_exec) says, as ssh would: explain reads ssh's words
SETUP_WORDS = (("takes no password login", "Permission denied (publickey)."),
               ("login refused", "Permission denied (password)."),
               ("can't connect", ""))


def setup_failure(cfg: dict[str, Any], h: dict[str, Any], text: str) -> str:
    """A setup failure's line for Host H: `[code] message: fix` when explain knows its cause, else TEXT as it was."""
    from . import errors
    low = text.lower()
    said = next((ssh if ssh else text for words, ssh in SETUP_WORDS if words in low), None)
    if said is None:
        return text
    p = explain(cfg, h, said, password=True)
    if p.code in (errors.AUTH_FAILED, errors.LOOKUP_FAILED):
        return text
    return f"[{p.code}] {p.message}: {p.fix}"
