"""The Box's health (ticket 49): Neovim's `:checkhealth` for roster. `roster check --box` and serve's box.check run
the same checks, a section at a time, each {section, level: ok|warn|error, message, fix?, topic?}: the fix in a
sentence, the topic a `:help` topic (an error catalog row, E1, or a page). Every check is local: files, PATH, the
vault CLI's own status and the infra repo's git as this Box last saw it. Nothing logs in to a Host, scans one or
fetches; `roster check HOST` is the one that connects. No check returns a secret (Logins are counted, never read)."""

import platform

from . import __version__, changes, providers, store
from .common import find_program, known_hosts_file, ssh_config_file
from .errors import Problem
from .providers import PROVIDERS
from .sshops import hk_name, known_names, ssh_config_hosts

# The sections, in order, with the name the CLI prints (the app has its own titles, by id).
SECTIONS = {"roster": "roster", "inventory": "Inventory", "ssh": "ssh", "vault": "Vault", "askpass": "askpass",
            "repo": "Infra repo"}
PLACEHOLDER_USERS = ("", "CHANGE-ME")
# Names many machines carry out of the box (an OS image's default hostname): a Box named one of them likely shares
# its name with another Box, and Boxes with one name are one owner (#384). Lower case: compared with the name
# lowered (config.py keeps its case).
COMMON_BOX_NAMES = frozenset({
    "localhost", "localdomain", "none", "-none-", "default", "ubuntu", "ubuntu-server", "debian", "raspberrypi",
    "raspberry", "dietpi", "kali", "fedora", "centos", "rocky", "rockylinux", "almalinux", "archlinux", "alpine",
    "nixos", "opensuse", "manjaro", "linuxmint", "mint", "pop-os", "vagrant", "osmc", "orangepi", "libreelec",
    "macbook", "macbook-pro", "macbook-air", "imac", "imac-pro", "mac-mini", "mac-pro", "mac-studio"})
SHOWN = 5                   # names listed before "and N more"


def check(section, level, message, fix=None, topic=None):
    return {"section": section, "level": level, "message": message,
            **({"fix": fix} if fix else {}), **({"topic": topic} if topic else {})}


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


def check_box(path, cfg, error, askpass, api_version=None):
    """Every check, in SECTIONS order. PATH: roster.yml's path (None when none was found); CFG: the loaded Inventory
    (serve's last good one even while the file doesn't load), or None; ERROR: why roster.yml doesn't load now, or
    None; ASKPASS: (ok, message) for the askpass channel (askpass_state). API_VERSION: serve's, for the roster
    line."""
    out = [roster_version(api_version)]
    out += inventory(path, cfg, error)
    out += ssh(cfg)
    out += vault(cfg)
    out.append(check("askpass", "ok" if askpass[0] else "error", askpass[1],
                     None if askpass[0] else "restart `roster serve` (the app's :source does not); if it fails "
                                             "again, its stderr says why"))
    out += repo(path if cfg or error is None else None)
    return out


def roster_version(api_version):
    serve = f", serve API {api_version}" if api_version else ""
    return check("roster", "ok", f"roster {__version__}{serve}, Python {platform.python_version()}")


# ---------------------------------------------------------------- Inventory

def inventory(path, cfg, error):
    out = []
    if error is not None:
        from .errors import inventory_problem
        p = inventory_problem(error, path)
        last = "; the app shows the last good one" if cfg else ""
        out.append(check("inventory", "error", f"roster.yml doesn't load: {error}{last}", p.fix, "E1"))
    if cfg is None:
        return out
    hosts = list(cfg["hosts"].values())
    if error is None:
        out.append(check("inventory", "ok", f"roster.yml loads: {cfg['path']} ({count(len(hosts), 'Host')}, "
                                            f"{count(len(cfg['groups']), 'group')})"))
    waiting = [h["name"] for h in hosts if not h["reviewed"]]
    if waiting:
        out.append(check("inventory", "warn", f"{count(len(waiting), 'Host')} wait for review: {names(waiting)}",
                         "review each one (`:review` in the app), or set reviewed: true in roster.yml", "E3"))
    no_user = [h["name"] for h in hosts if h["reviewed"] and h["ssh"]["user"] in PLACEHOLDER_USERS]
    if no_user:
        out.append(check("inventory", "warn", f"no SSH user for {names(no_user)}",
                         "set user: on the Host or its group in roster.yml", "E4"))
    left_out = [h["name"] for h in hosts if h["problems"]]
    if left_out:
        n = sum(len(h["problems"]) for h in hosts)
        out.append(check("inventory", "warn", f"{count(n, 'service entry')} left out, on {names(left_out)}",
                         "`roster hosts` prints each one with its fix", "E57"))
    out += named(cfg)
    return out


def named(cfg):
    """The named Inventories (ticket 115): which one this is, and the same machine in two of them (warnings only)."""
    from . import inventories
    from .common import current_inventory
    if not inventories.list_file().exists():
        return []
    inv = inventories.load()
    if not inv.inventories:
        return []
    here = current_inventory()
    which = (f"this is the named Inventory {here}" + (" (the active one)" if here == inv.active else "")
             if here else "this roster.yml isn't one of the named Inventories")
    out = [check("inventory", "ok", f"{which}; named: {', '.join(x.name for x in inv.inventories)}")]
    out += [check("inventory", "warn", w["message"], w["fix"], f"E{w['row']}") for w in inventories.overlaps(cfg)]
    for f in inventories.foreign_legacy_files(inv):
        out.append(check("inventory", "warn", f"{f} has the name roster once used for a named Inventory's ssh config, "
                                              "but roster didn't write it, so it's left as it is",
                         "nothing to do if it's yours; rename it if `Include` picks it up by mistake"))
    if inventories.stale():
        out.append(check("inventory", "warn", f"{inventories.ssh_index_file()} is older than this Box's ssh config "
                                              "files and couldn't be rewritten", "make it writable, then run "
                                              "`roster sync`", "E206"))
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
    ours, written = ssh_config_file(), ssh_config_hosts()
    if written is None:
        out.append(check("ssh", "error", f"roster's ssh config ({ours}) isn't written, or ~/.ssh/config doesn't "
                                         "include it", "run `roster sync` (or `roster setup` on a new Box)", "E2"))
    else:
        from .inventories import left_out_hosts
        shadowed = left_out_hosts()         # another named Inventory's Host has the name: warning 146 says so
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
                         "Box whose key was taken runs `roster setup` again)", "E222"))
    if any(h["enroll"] for h in hosts):
        if cfg["key"].exists():
            out.append(check("ssh", "ok", f"this Box's key: {cfg['key']}"))
        else:
            out.append(check("ssh", "warn", f"this Box has no key yet ({cfg['key']}), so key Logins can't work",
                             "run `roster setup`", "E12"))
    if not known_hosts_file().exists():
        out.append(check("ssh", "warn", f"roster's known hosts ({known_hosts_file()}) isn't there yet",
                         "run `roster setup`; until then each Session asks before it trusts a Host's key", "E14"))
    else:
        known = known_names()
        unknown = [h["name"] for h in hosts if hk_name(h) not in known]
        if unknown:
            out.append(check("ssh", "warn", f"no recorded host key for {count(len(unknown), 'Host')}: "
                                            f"{names(unknown)}",
                             "a Session asks before it trusts one; `roster setup` records them all", "E14"))
        else:
            out.append(check("ssh", "ok", f"roster's known hosts has every Host's key: {known_hosts_file()}"))
    return out


# ---------------------------------------------------------------- Vault

def provider_uses(cfg):
    """Every provider the Inventory's Host Logins name (ssh, a Host's default, services), with how many use each."""
    counts = {}
    for h in cfg["hosts"].values():
        for login in (h["ssh"], h["login"], *h["services"].values()):
            name = str(login.get("auth") or "").partition(":")[0].strip()
            if name and name not in providers.NO_PASSWORD:
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
                     "see `roster providers` for the ones there are, then fix auth: in roster.yml", "E5")
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
    if status == "locked":
        return check("vault", "ok", f"{name} ({used}): logged in{who}, locked; it asks for the master password "
                                    "when a Login needs it")
    if status == "unlocked":
        return check("vault", "ok", f"{name} ({used}): logged in{who}, unlocked")
    found = f", `{tool}` found" if tool else ""
    return check("vault", "ok", f"{name} ({used}): no lock to check{found}")


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
