"""Loading and querying roster.yml."""

import ipaddress
import os
import re
import socket
import sys
from pathlib import Path
from typing import Any, Literal, NoReturn, overload
from urllib.parse import urlparse

import yaml

from . import boxkeys, context, keyline
from .common import NAME_RE, die, oneline, typed_token
from .context import user_config_dir
from .errors import PATH_NOT_REPEATED, RENAME_HINT, InventoryError
from .hosts import vault_login
from .resources import load_resources
from .sshconfig import SSH_UNSAFE

HOST_DEFAULTS = {"user": None, "port": 22, "enroll": True, "auth": "prompt",
                 "web": None, "services": {}, "notes": "",
                 "title": "", "description": "", "type": "", "product": "", "reviewed": True, "mac": "", "mesh": None,
                 "os": None}
TEXT_FIELDS = ("title", "description", "type", "product")
GROUP_ONLY = ("hosts", "title", "description")   # describe the group itself, not copied onto hosts
LOGIN = ("user", "auth")
SSH_KEYS = ("port", "user", "auth")
SERVICE_KEYS = ("port", "url", "scheme", "user", "auth", "verify", "login")
WEB_LOGINS = ("basic", "bearer", "vsphere", "unifi", "openvpnas", "hub", "none")          # how `roster web` sends the service's credentials
SERVICE_RE = re.compile(r"^[A-Za-z0-9._-]+$")
IPV6_ZONE = re.compile(r"^[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*%[A-Za-z0-9._-]+\Z")   # fe80::1%eth0
HTTPS_PORTS, HTTP_PORTS = (443, 8443), (80, 8000, 8008, 8080, 8888)


# ---------------------------------------------------------------- config

def bad(message: str) -> NoReturn:
    """Stop loading roster.yml: MESSAGE names the key; parse_inventory adds the file."""
    raise InventoryError(message)


def bad_host(name: str, why: str, sep: str = ": ") -> NoReturn:
    """bad() for Host NAME: `host 'NAME'` SEP WHY, with WHY on its own as the error's `why`."""
    raise InventoryError(f"host {name!r}{sep}{why}", host=name, why=why)



def open_inventory(config: Any = None, inv: str | None = None) -> dict[str, Any]:
    """The roster.yml this run uses (find_config: CONFIG is -c, INV --inv), loaded, its vault providers set up.
    InventoryError when it isn't found or doesn't load; an unknown INV is named.unknown's error."""
    from .providers import setup_providers
    path = find_config(config, inv)
    cfg = load_config(path)
    try:
        setup_providers(cfg)
    except InventoryError as e:
        raise located(e, path) from None
    return cfg


def find_config(arg, inv=None):
    """The roster.yml this run uses: `-c PATH` (ARG), `--inv NAME` (INV), $ROSTER_CONFIG, ./roster.yml, the active named
    Inventory, then ~/.config/roster/roster.yml (ticket 115). It also picks the generated ssh config and known_hosts
    this run reads and writes: the named Inventory's own when the file is one (context.use)."""
    from . import named  # Pydantic: only once a roster.yml is looked for
    path = locate_config(arg, inv)
    context.use(named.canonical(inv) if inv and not arg else named.name_of(path), path)
    named.rebuild_if_stale()
    return path


def locate_config(arg: Any, inv: str | None = None) -> Path:
    """find_config's lookup alone."""
    from . import named
    if arg:
        return Path(arg).expanduser()
    if inv:
        return named.path_of(inv)
    if os.environ.get("ROSTER_CONFIG"):
        return Path(os.environ["ROSTER_CONFIG"]).expanduser()
    here = Path.cwd() / "roster.yml"
    if here.exists():
        return here
    active = named.active_path()
    if active is not None:
        return active
    if (user_config_dir() / "roster.yml").exists():
        return user_config_dir() / "roster.yml"
    bad("no roster.yml found here or in ~/.config/roster/ - make one (`roster init --blank`, or `roster init "
        "--inventory file:PATH|repo:URL|ssh-config`), or pass -c PATH / set ROSTER_CONFIG")


TOP_KEYS = {"bitwarden", "box_name", "claude_inline_limit", "defaults", "groups", "key_max_age", "key_path",
            "key_type", "links",
            "rate_limited",
            "provider_dirs", "providers", "resources", "web_login_names", "workers"}


def blank_shape(raw):
    """No Hosts is a valid Inventory only shaped as `roster init --blank` writes it (T212, #409 C2): `groups:`
    there, each group with a `hosts:` key (empty), and no top-level key roster doesn't know. So an empty file, a
    typo'd `grups:` or `host:`, or another YAML file still doesn't load, and every Box keeps its ssh config."""
    groups = raw.get("groups")
    if not isinstance(groups, dict) or set(raw) - TOP_KEYS:
        return False
    return all(isinstance(g, dict) and "hosts" in g for g in groups.values())


HIDDEN_PATH = "that path (not repeated)"
HIDDEN_FILE = f"the roster.yml at {HIDDEN_PATH}"


def shown_path(path: Any) -> str | None:
    """roster.yml's PATH (as given: -c, $ROSTER_CONFIG, a named Inventory's) as roster may print it, resolved; None
    when it mustn't be (#479, #484 M1/L1/L3, #489 M1, #498): never when it's typed_token, whether a file is there or
    not (a token-named folder or file an older roster's init made is still a token), else when the file or its folder
    is there. `roster -cTOKEN hosts` reads an op session token that starts with -c as `-c TOKEN`, and a bw key or an
    op token can be typed after -c by mistake. Every message, fix line and JSON field naming the path goes through
    this: the loader's own errors (CLI and serve), and since #506 the lines of a run that works too (check --box,
    setup, sync's ROSTER.md, add's and discover's backup and wrote, revoke --all, the ssh config's header, the sync
    fix), through shown_file for a loaded Inventory, whose `hidden` load_inventory decides from the path as given.
    Since #529 serve's results that name the file it runs on say PATH_NOT_REPEATED for it too (serve.State.shown,
    store's `hidden`), and since #538 a named Inventory's (inventories.shown/listed), an edit's backup
    (store.Store.shown_backup) and changes.py's git fixes (changes.Repo's `hidden`)."""
    if typed_token(path):
        return None
    full = Path(path).expanduser().resolve()
    if full.exists() or full.parent.is_dir():
        return str(full)
    return None


def located(e: InventoryError, path) -> InventoryError:
    """E, about the roster.yml at PATH as shown_path has it (PATH_NOT_REPEATED when it mustn't be shown; hidden when
    the file is there all the same, in a token-named folder)."""
    shown = shown_path(path)
    return e.at(shown or PATH_NOT_REPEATED, hidden=shown is None and Path(path).expanduser().is_file())


def load_inventory(path):
    """roster.yml at PATH as an Inventory (models.py): what new code reads (decision Q113)."""
    shown = shown_path(path)
    path = Path(path).expanduser().resolve()
    if not path.exists():
        if shown is None:
            raise InventoryError(f"no config file at {HIDDEN_PATH} - check -c PATH (or $ROSTER_CONFIG); make one: "
                                 "roster -c PATH init --blank (or --inventory file:PATH|repo:URL|ssh-config)",
                                 PATH_NOT_REPEATED)
        raise InventoryError(f"{shown} not found - make one: roster -c {shown} init --blank (or --inventory "
                             "file:PATH|repo:URL|ssh-config)", shown)
    if shown is None:                       # it's there, in a token-named folder (or named like one itself)
        try:
            inv = checked_inventory(path.read_text(), path, HIDDEN_FILE)
        except InventoryError as e:
            raise InventoryError(f"{e.message}\n{RENAME_HINT}", PATH_NOT_REPEATED, e.line, e.host, e.why,
                                 hidden=True) from None
        rename_hint(path)
        return inv.model_copy(update={"hidden": True})
    return parse_inventory(path.read_text(), path)


_HINTED: set[Path] = set()


def rename_hint(path: Path) -> None:
    """Say once per run, on stderr, that the roster.yml at PATH (resolved) loads but is hidden (#506): only the error
    paths said it before, so a file that loads never told you to rename its folder. Once renamed, nothing is hidden."""
    if path in _HINTED:
        return
    _HINTED.add(path)
    print(f"note: {HIDDEN_FILE} loads, but its folder (or its own name) looks like a token, so roster names it "
          f"nowhere - {RENAME_HINT}", file=sys.stderr, flush=True)


def shown_file(cfg: dict[str, Any], path: Any = None, what: str = "the roster.yml") -> str:
    """PATH (default: the Inventory CFG's roster.yml; else a file roster keeps beside it: its backup, ROSTER.md) as a
    success message may name it (#506): `WHAT at that path (not repeated)` when CFG's path as given is hidden
    (cfg["hidden"], load_inventory's shown_path), or PATH itself is."""
    path = cfg["path"] if path is None else path
    if cfg.get("hidden"):
        return f"{what} at {HIDDEN_PATH}"
    return shown_path(path) or f"{what} at {HIDDEN_PATH}"


def load_config(path: Any) -> dict[str, Any]:
    """load_inventory's dict view, for the code that still reads dicts (it moves to the models when a ticket
    touches it)."""
    return load_inventory(path).as_config()


def load_config_text(text, path, named=None):
    """load_config of TEXT as if it were PATH's (an edit checked before it's written): no file is read or written.
    NAMED: what its messages call the file (PATH)."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    try:                                    # named from PATH as given, as load_inventory does (#506)
        return checked_inventory(text, Path(path).expanduser().resolve(),
                                 named or shown_path(path) or HIDDEN_FILE).as_config()
    except InventoryError as e:
        raise located(e, path) from None


def parse_inventory(text, path, named=None):
    """roster.yml's TEXT (read from PATH, or as it would be there), loaded and checked into an Inventory;
    InventoryError naming the key, the file (as NAMED, else as shown_path has it: never a token typed as a folder)
    and, for bad YAML, the line otherwise."""
    try:
        return checked_inventory(text, path, named or shown_path(path) or HIDDEN_FILE)
    except InventoryError as e:
        raise located(e, path) from None


def yaml_line(e: yaml.YAMLError) -> int | None:
    """The line PyYAML's message for E names first (its context's, when it prints that one), counted from 1."""
    if not isinstance(e, yaml.MarkedYAMLError):
        return None
    context_shown = e.context_mark is not None and (
        e.problem is None or e.problem_mark is None or str(e.context_mark) != str(e.problem_mark))
    mark = e.context_mark if context_shown else e.problem_mark
    return None if mark is None else mark.line + 1


def shown_value(v) -> str:
    """V's YAML shape in words, for a key of the wrong shape: `a number (3)`, `text ('lab')`, `a list`, `nothing`."""
    if v is None:
        return "nothing (null)"
    if isinstance(v, bool):
        return f"{str(v).lower()} (true/false)"
    if isinstance(v, int | float):
        return f"a number ({v})"
    if isinstance(v, str):
        return f"text ({oneline(v)[:40]!r})"
    return "a list" if isinstance(v, list) else "a mapping" if isinstance(v, dict) else type(v).__name__


def key_line(text: str, keys: tuple[Any, ...]) -> int | None:
    """The line (from 1) of the key at KEYS (`groups`, `lab`) in roster.yml's TEXT, or None when it isn't found."""
    try:
        node = yaml.compose(text)
    except yaml.YAMLError:
        return None
    line = None
    for k in keys:
        if not isinstance(node, yaml.MappingNode):
            return line
        hit = next(((kn, vn) for kn, vn in node.value if str(kn.value) == str(k)), None)
        if hit is None:
            return line
        line, node = hit[0].start_mark.line + 1, hit[1]
    return line


def wrong_shape(named: str, text: str, keys: tuple[Any, ...], v: Any, want: str) -> NoReturn:
    """Stop loading: the key at KEYS holds V, where roster.yml wants WANT (what goes there, with an example). The
    message names the file (NAMED: as shown_path has it) and the key's line in TEXT, as a YAML error's does."""
    line = key_line(text, keys)
    raise InventoryError(f"{named}{f' at line {line}' if line else ''}: {'.'.join(map(str, keys))}: must be {want}, "
                         f"not {shown_value(v)}", line=line)


MAPPING_KEYS = {"defaults": "a mapping of settings every Host takes (user: admin, port: 22)",
                "groups": "a mapping of group name: {user:, hosts: {...}}",
                "providers": "a mapping of vault name: {its settings}",
                "bitwarden": "a mapping of settings (sync: true)",
                "resources": "a mapping of name: { type, ... } (guest-wifi: {type: wifi, ssid: Guest, auth: bw:guest})",
                "web_login_names": "a mapping of your own name: one of " + ", ".join(WEB_LOGINS)}
LIST_KEYS = {"provider_dirs": "a list of folders (- providers)",
             "links": "a list of { from: HOST-OR-GROUP, to: HOST-OR-GROUP, both: true|false, via: HOST }",
             "rate_limited": "a list of networks, e.g. [10.0.0.0/8, 192.0.2.7]"}


def check_shapes(raw: dict[Any, Any], text: str, named: str) -> None:
    """The keys the loader walks into (#537): each mapping or list where roster.yml wants one, else an
    InventoryError naming the file (NAMED), the key's path (groups.lab), its line in TEXT and what goes there. A null is an empty
    one, as it always was. A key's own values (a port, a service, links:) are checked where they're read."""
    for key, want in MAPPING_KEYS.items():
        if raw.get(key) is not None and not isinstance(raw[key], dict):
            wrong_shape(named, text, (key,), raw[key], want)
    for key, want in LIST_KEYS.items():
        if raw.get(key) is not None and not isinstance(raw[key], list):
            wrong_shape(named, text, (key,), raw[key], want)
    for name, conf in (raw.get("providers") or {}).items():
        if conf is not None and not isinstance(conf, dict):
            wrong_shape(named, text, ("providers", name), conf, "a mapping of that vault's settings")
    for g, group in (raw.get("groups") or {}).items():
        if group is None:
            continue
        if not isinstance(group, dict):
            wrong_shape(named, text, ("groups", g), group, "a mapping of the group's settings and hosts "
                        "(user: deploy, hosts: {web-01: 10.0.0.5})")
        hosts = group.get("hosts")
        if hosts is not None and not isinstance(hosts, dict):
            wrong_shape(named, text, ("groups", g, "hosts"), hosts, "a mapping of host name: address or {ip: ...} "
                        "(web-01: 10.0.0.5)")
        for h, host in (hosts or {}).items():
            if host is not None and not isinstance(host, dict | str):
                wrong_shape(named, text, ("groups", g, "hosts", h), host, "an address (10.0.0.5) or a mapping of its "
                            "settings ({ip: 10.0.0.5, user: admin})")


def checked_inventory(text, path, named):

    from pydantic import ValidationError  # only when roster.yml is loaded: it costs more than roster's start

    from .models import Inventory, problem
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise InventoryError(f"{named} is not valid YAML:\n{e}", line=yaml_line(e)) from None
    if raw is not None and not isinstance(raw, dict):
        bad(f"{named} isn't a mapping of settings and groups: at its top level, so it isn't a roster.yml")
    raw = raw or {}
    check_shapes(raw, text, named)
    defaults = {**HOST_DEFAULTS, **(raw.get("defaults") or {})}
    names = web_login_names(raw)
    hosts, groups = {}, {}
    box_type = key_type("key_type", raw.get("key_type")) or boxkeys.DEFAULT
    key_type("defaults: key_type", (raw.get("defaults") or {}).get("key_type"))
    for g, x in (raw.get("groups") or {}).items():
        if isinstance(x, dict):
            key_type(f"group {str(g)!r}: key_type", x.get("key_type"))
    for where, layer in (("defaults", raw.get("defaults") or {}),
                         *((f"group {g!r}", x or {}) for g, x in (raw.get("groups") or {}).items())):
        if isinstance(layer, dict) and "seen_as" in layer:
            bad(f"{where}: seen_as: goes on a Host (the addresses it connects from), not on a group or defaults")
    for gname, group in (raw.get("groups") or {}).items():
        group = group or {}
        gset = {k: v for k, v in group.items() if k not in GROUP_ONLY}
        groups[str(gname)] = {k: oneline(group.get(k)) for k in ("title", "description")}
        for hname, h in (group.get("hosts") or {}).items():
            hname = str(hname)
            h = {"ip": h} if isinstance(h, str) else (h or {})
            if not NAME_RE.match(hname):
                bad(f"bad host name {hname!r} (use letters, digits, . _ -)")
            if hname in hosts:
                bad_host(hname, f"is listed twice (in groups {hosts[hname]['group']!r} and {str(gname)!r}): a Host "
                         "is in one group", " ")
            m = {**defaults, **gset, **h, "name": hname, "group": str(gname)}
            if not m.get("ip"):
                bad_host(hname, "has no ip", " ")
            m["ip"] = str(m["ip"]).strip()
            layers = [h, gset, raw.get("defaults") or {}]        # most specific first
            m["ssh"] = resolve_ssh(hname, layers)
            if not m["ssh"]["user"]:
                bad_host(hname, "has no user (set it on the host, its group, or defaults)", " ")
            if re.search(r"\s", m["ip"] + m["ssh"]["user"]):
                bad_host(hname, "ip/user can't contain spaces")
            for field, value in (("ip", m["ip"]), ("user", m["ssh"]["user"])):
                if SSH_UNSAFE.search(str(value)):   # written into the ssh config: a quote or newline would break it
                    bad_host(hname, f"{field} can't hold a quote or a control character (it goes into this "
                        "Box's ssh config)")
            if "%" in str(m["ssh"]["user"]):     # older OpenSSH (Windows' own) takes a %% in User literally
                bad_host(hname, "user can't hold a % (it goes into this Box's ssh config)")
            if "%" in m["ip"] and not IPV6_ZONE.match(m["ip"]):     # a % is an IPv6 zone's, or none (written %%)
                bad_host(hname, "ip can't hold a % except as an IPv6 address's zone (fe80::1%eth0)")
            # user/port/auth stay as the resolved SSH login, so code that predates ssh: blocks keeps working
            m["user"], m["port"], m["auth"] = m["ssh"]["user"], m["ssh"]["port"], m["ssh"]["auth"]
            m["login"] = {"user": as_user(first(layers, "user")), "auth": as_auth(first(layers, "auth"))}  # for services
            m["services"], m["web"], m["problems"] = resolve_services(hname, m, layers, names)
            m["enroll"] = bool(m["enroll"])
            m["reviewed"] = bool(m["reviewed"])
            m["mesh"] = first(layers, "mesh")
            if m["mesh"] is not None and not isinstance(m["mesh"], bool):
                bad_host(hname, "mesh: must be true or false")
            m["os"] = host_os(hname, first(layers, "os"))
            m["key_type"] = key_type("key_type", first(layers, "key_type"), hname) or box_type
            # The app sends this Host's shell its hook line; roster only checks it.
            if m.get("shell_hooks") is not None and not isinstance(m["shell_hooks"], bool):
                bad_host(hname, "shell_hooks: must be true or false")
            m["mesh_dir"] = mesh_dir(hname, first(layers, "mesh_dir"))
            m["sudo"] = sudo_auth(hname, layers)
            m["seen_as"] = addresses_seen(hname, h.get("seen_as"))
            for k in TEXT_FIELDS:
                m[k] = oneline(m.get(k))
            m["description"] = m["description"] or oneline(m.get("notes"))   # old name for it
            hosts[hname] = m
    if not hosts and not blank_shape(raw):
        bad(f"{named} defines no hosts")
    box = keyline.box_name(str(raw.get("box_name") or socket.gethostname().split(".")[0]))
    key_path = str(raw.get("key_path") or f"~/.ssh/{boxkeys.parse(box_type).file_name}")
    if SSH_UNSAFE.search(key_path):         # it goes into the ssh config: a quote or newline would add directives
        bad(f"{named}: key_path can't hold a quote or a control character (a newline, a tab)")
    key = Path(os.path.expanduser(key_path))
    for m in hosts.values():                # each Host's key file, for its own key type (boxkeys)
        m["key_file"] = str(boxkeys.key_file(key, box_type, m["key_type"]))
        if m["key_type"] != box_type and Path(m["key_file"]) == key:
            bad(f"{named}: key_path ({key_path}) is where roster keeps the {m['key_type']} key that {m['name']} uses "
                f"(key_type: {m['key_type']}): remove key_path (roster then keeps this Box's {box_type} key at "
                f"~/.ssh/{boxkeys.parse(box_type).file_name}) or point it at another file")
    try:                                    # how old this Box's key may get before check --box warns
        max_age = boxkeys.parse_age(raw.get("key_max_age", boxkeys.MAX_AGE))
    except ValueError as e:
        bad(f"{named}: key_max_age: {e}")
    try:
        return Inventory.model_validate(
            {"path": path, "box": box, "tag": keyline.tag(box), "tag_re": keyline.tag_re(box), "key": key,
             "key_type": box_type,
             "pub": Path(str(key) + ".pub"), "workers": raw.get("workers") or 32,
             "inline_limit": raw.get("claude_inline_limit") or 60, "hosts": hosts, "groups": groups,
             "resources": load_resources(raw, groups, hosts), "links": load_links(raw, hosts, groups),
             "providers": providers_conf(raw), "provider_dirs": list(raw.get("provider_dirs") or []),
             "rate_limited": rate_limited(raw.get("rate_limited")), "key_max_age": max_age})
    except ValidationError as e:
        bad(f"{named}: {problem(e)}")


def key_type(where, v, host=None):
    """A `key_type:` (T239, decision Q200) as its canonical name (boxkeys), or None when nothing sets it. An unknown
    one stops the load, naming WHERE (of Host HOST) and the allowed values."""
    if v is None:
        return None
    try:
        return boxkeys.parse(v).name
    except ValueError as e:
        if host is not None:
            bad_host(host, f"{where}: {e}")
        bad(f"{where}: {e}")


OS_VALUES = ("windows", "posix")


def host_os(hname, v):
    """A Host's `os:` (T195, decision Q174): `windows` (setup, revoke and check run PowerShell there) or `posix` (sh,
    as for every Host before os:), any case; None when nothing sets it, which is posix."""
    if v is None:
        return None
    if not isinstance(v, str) or v.strip().lower() not in OS_VALUES:
        bad_host(hname, f"os: must be windows or posix (unset is posix), not {oneline(v)!r}")
    return v.strip().lower()


def rate_limited(v):
    """`rate_limited:` (T191, decision Q180): the networks whose SSH rate limiter stops answering after many
    connections, as the team knows them; each a network (`10.0.0.0/8`) or one address, IPv4 or IPv6. Empty (the
    default) when nobody listed any. Returns them as text, one address as a /32 or /128."""
    if v is None:
        return []
    nets = []
    for entry in v:
        text = str(entry).strip()
        try:
            nets.append(str(ipaddress.ip_network(text)))
            continue
        except ValueError:
            pass
        why = f"rate_limited: {oneline(entry)!r} isn't a network or an address (10.0.0.0/8, 192.0.2.7)"
        if isinstance(entry, int) and not isinstance(entry, bool):
            why += "; quote an IPv6 one ('2001:db8::/32'): unquoted, YAML can read it as a number"
        else:
            try:
                net = ipaddress.ip_network(text, strict=False)
                why += f"; a network's address has no host bits set ({net}, not {text})"
            except ValueError:
                pass
        bad(why)
    return nets


# ---------------------------------------------------------------- the Mesh's links (decision Q63)

MESH_DIR_RE = re.compile(r"^(/[A-Za-z0-9._-]+)+/?$")


def mesh_dir(hname, v):
    """A Host's `mesh_dir:` (T58), where it keeps its Mesh files as a source: an absolute path that can go into
    ssh's config as it is (no spaces or quotes, no `..`), or None for roster's own pick."""
    if v is None:
        return None
    v = str(v).strip()
    if not MESH_DIR_RE.match(v) or "/../" in v + "/" or "/./" in v + "/":
        bad_host(hname, f"mesh_dir: must be an absolute path of letters, digits and . _ - / (it goes into ssh's "
            f"config as it is), not {v!r}")
    return v.rstrip("/")

def addresses_seen(hname, v):
    """A Host's `seen_as:` (T83): the other addresses it connects from (an address or a network, one or a list), which
    a peer's from= takes beside its ip:, as roster.yml has them; [] without one."""
    if v is None:
        return []
    out = []
    for x in v if isinstance(v, list) else [v]:
        try:
            ipaddress.ip_network(str(x).strip(), strict=False)
        except ValueError:
            bad_host(hname, f"seen_as: must be IP addresses or networks (10.0.9.1, 10.0.9.0/24), one or a list, "
                f"not {x!r}")
        out.append(str(x).strip())
    return out


LINK_KEYS = ("from", "to", "both", "via")


def load_links(raw, hosts, groups):
    """roster.yml's top-level `links:`, checked: [{from, to, both, via}], each end a Host or a group by name.
    One-way unless `both: true`. `via: HOST` (T57): the source reaches the peer through that Host (ProxyJump).
    Unknown names, self-links, names that are both a Host and a group, and two entries that send the same pair
    of Hosts through different Hosts stop here."""
    links = raw.get("links")
    if links is None:
        return []
    out, hops = [], {}                         # hops: (source, peer) -> (entry, the Host it goes through)

    def members(name):
        return [name] if name in hosts else [h for h, m in hosts.items() if m["group"] == name]
    for n, link in enumerate(links, 1):
        where = f"links: entry {n}"
        if not isinstance(link, dict) or set(map(str, link)) - set(LINK_KEYS) or not {"from", "to"} <= set(link):
            bad(f"{where} must be a mapping with from: and to: (and both: true for two-way, via: HOST for a hop), "
                "nothing else")
        ends = {}
        for k in ("from", "to"):
            name = str(link[k]) if link[k] is not None else ""
            if name in hosts and name in groups:
                bad(f"{where}: {name!r} is both a Host and a group - rename one of them")
            if name not in hosts and name not in groups:
                near = sorted(x for x in (*hosts, *groups) if name and (name in x or x in name))[:5]
                bad(f"{where}: {k}: {name!r} isn't a Host or a group in roster.yml"
                    + (f" (did you mean: {', '.join(near)})" if near else ""))
            ends[k] = name
        if ends["from"] == ends["to"]:
            bad(f"{where} links {ends['from']!r} to itself - a group's Hosts reach each other with mesh: true")
        both = link.get("both", False)
        if not isinstance(both, bool):
            bad(f"{where}: both: must be true or false")
        via = None if link.get("via") is None else str(link["via"])
        if via is not None:
            if via in groups and via not in hosts:
                bad(f"{where}: via: {via!r} is a group: a Link goes through one Host")
            if via not in hosts:
                bad(f"{where}: via: {via!r} isn't a Host in roster.yml")
            if via in (ends["from"], ends["to"]):
                bad(f"{where}: via: {via!r} is an end of the Link itself")
            for a in members(ends["from"]):
                for b in members(ends["to"]):
                    for pair in {(a, b), (b, a)} if both else {(a, b)}:
                        if via in pair or pair[0] == pair[1]:
                            continue
                        seen = hops.setdefault(pair, (n, via))
                        if seen[1] != via:
                            bad(f"links: entries {seen[0]} and {n} send {pair[0]} -> {pair[1]} through different "
                                f"Hosts ({seen[1]}, {via})")
        out.append({"from": ends["from"], "to": ends["to"], "both": both, "via": via})
    return out


# ---------------------------------------------------------------- ssh and services

def first(layers, key, default=None):
    """The value from the most specific layer that sets key (an explicit null counts)."""
    return next((layer[key] for layer in layers if key in layer), default)


def as_auth(v):
    return None if v is None else str(v)


def as_user(v):
    return None if v is None else str(v).strip()


class BadService(Exception):
    """One service entry roster can't use: plain words and the fix. The Host still loads; the service doesn't."""

    def __init__(self, message, fix):
        super().__init__(message)
        self.message, self.fix = message, fix


def port_number(v):
    """V as a port number, or None if it isn't one."""
    if isinstance(v, bool) or not str(v).strip().isdigit() or not 1 <= int(v) <= 65535:
        return None
    return int(v)



def service_port(v):
    if port_number(v) is None:
        raise BadService(f"bad port {v!r}", "use a number from 1 to 65535")
    return int(v)


def ssh_block(hname, layer):
    blk = layer.get("ssh")
    if blk is None:
        return {}
    if not isinstance(blk, dict) or set(blk) - set(SSH_KEYS):
        bad_host(hname, f"ssh: must be a mapping with only {', '.join(SSH_KEYS)}")
    return blk


def resolve_ssh(hname, layers):
    """SSH login. Per layer (host, group, defaults) its ssh: block beats its plain user/auth/port."""
    flat = [x for layer in layers for x in (ssh_block(hname, layer), layer)] + [HOST_DEFAULTS]
    given = first(flat, "port")
    port = port_number(given)
    if port is None:
        bad_host(hname, f"ssh: bad port {given!r} (use a number from 1 to 65535)", " ")
    return {"port": port, "user": as_user(first(flat, "user")), "auth": as_auth(first(flat, "auth"))}


def sudo_auth(hname, layers):
    """The vault reference for a Host's own sudo (and su) password, from its most specific `sudo: {auth: REF}`
    (host, group, defaults), or None: then a prompt fill (ticket 119, decision Q129) uses its ssh Login. A reference
    only, never a value, and never `prompt`, `agent`, `key` or `none`, which have no password to fill."""
    blk = first(layers, "sudo")
    if blk is None:
        return None
    if not isinstance(blk, dict) or set(map(str, blk)) != {"auth"}:
        bad_host(hname, "sudo: must be a mapping with only auth (a vault reference, e.g. "
            "sudo: {auth: \"bw:esx-02 sudo\"})")
    ref = as_auth(blk["auth"]) or ""
    if not vault_login(ref):
        bad_host(hname, f"sudo: auth must be a vault reference (bw:ITEM, op:ITEM, ...), not {ref!r}")
    return ref


def service_entry(v):
    if isinstance(v, dict):
        extra = set(map(str, v)) - set(SERVICE_KEYS)
        if extra:
            raise BadService(f"unknown setting {', '.join(sorted(extra))}",
                             f"use only {', '.join(SERVICE_KEYS)} (check the spelling)")
        return dict(v)
    if isinstance(v, str) and "://" in v:
        return {"url": v}
    return {"port": v}                                    # short form  postgres: 5432


def resolve_services(hname, m, layers, names=None):
    """Service entries merge per name, field by field: defaults <- group <- host. Returns (services, web URL,
    problems): an entry roster can't use is left out of services and listed in problems as
    {service, message, fix} instead, so one bad entry doesn't stop the whole Inventory from loading."""
    merged = {"web": {"url": str(m["web"])}} if m.get("web") else {}   # old style  web: "https://..."
    bad = {}
    for layer in reversed(layers):
        svcs = layer.get("services") or {}
        if not isinstance(svcs, dict):
            bad_host(hname, "services: must be a mapping of name: port or name: {port, url, user, auth}")
        for name, v in svcs.items():
            name = str(name)
            try:
                if not SERVICE_RE.match(name):
                    raise BadService(f"bad service name {name!r}", "use letters, digits, . _ - in the name")
                merged.setdefault(name, {}).update(service_entry(v))
            except BadService as e:
                bad.setdefault(name, e)
    services = {}
    for name, e in merged.items():
        if name in bad:
            continue
        try:
            services[name] = normalize_service(name, e, m, names or {})
        except BadService as err:
            bad[name] = err
    problems = [{"service": name, "message": f"service {name!r}: {e.message}", "fix": e.fix}
                for name, e in bad.items()]
    # the web UI: an explicit web service, else the first service given a url (never a guessed one)
    web = next((services[n]["url"] for n in ("web", *merged) if n in services and "url" in merged[n]), None)
    return services, web, problems


def normalize_service(name, e, m, names):
    port, url, scheme = e.get("port"), e.get("url"), e.get("scheme")
    if url:
        url = str(url).strip()
        url = url if "://" in url else "https://" + url
        u = urlparse(url)
        good_url = "write it as http(s)://host[:port][/path]"
        try:
            url_port = u.port
        except ValueError:
            raise BadService(f"bad url {url!r}", good_url) from None
        if u.scheme not in ("http", "https") or not u.hostname or re.search(r"\s", url):
            raise BadService(f"bad url {url!r} (expected http(s)://host[:port][/path])", good_url)
        scheme, url_port = u.scheme, url_port or (443 if u.scheme == "https" else 80)
        if port is not None and service_port(port) != url_port:
            raise BadService(f"port {port} doesn't match url {url!r}", "drop port:, or make it the url's port")
        port = url_port
    elif port is None:
        raise BadService("needs a port or a url", "add port: or url: to the service")
    else:
        port = service_port(port)
        scheme = scheme or ("https" if name.startswith("https") or port in HTTPS_PORTS else
                            "http" if name.startswith("http") or port in HTTP_PORTS else None)
        if scheme in ("http", "https"):
            url = f"{scheme}://{m['ip']}" + ("" if port == (443 if scheme == "https" else 80) else f":{port}")
    return {"port": port, "url": url, "scheme": scheme,
            "user": as_user(e.get("user", m["login"]["user"])),
            "auth": as_auth(e["auth"] if "auth" in e else m["login"]["auth"]),
            "verify": bool(e.get("verify", True)), "login": web_login(e.get("login", "basic"), names),
            "override": any(k in e for k in LOGIN)}       # False = inherits the host's default login


def web_login(v, names):
    """The login type a service's `login:` means: one of WEB_LOGINS, or the team's own name for one
    (web_login_names:)."""
    v = names.get(str(v), str(v))
    if v not in WEB_LOGINS:
        raise BadService(f"login: {v!r} isn't a login type roster knows",
                         f"set login: to one of {', '.join(WEB_LOGINS)}; if {v!r} is your own name for one of them, "
                         f"map it in roster.yml: web_login_names: {{{v}: TYPE}}")
    return v


def service_problem(h, name):
    """Why Host H's service NAME was left out of the Inventory, or None."""
    return next((p for p in h.get("problems", ()) if p["service"] == name), None)


def refuse_broken(h, name):
    """Stop with the problem of Host H's service NAME, if NAME is one roster left out."""
    p = service_problem(h, name)
    if p:
        die(f"{h['name']} {p['message']} (in roster.yml; fix: {p['fix']})")


def web_login_names(raw):
    """roster.yml's `web_login_names:`, a team's own names for roster's login types: {own name: type}."""
    names = raw.get("web_login_names") or {}
    out = {}
    for k, v in names.items():
        k = str(k)
        if k in WEB_LOGINS:
            bad(f"web_login_names: {k!r} is already one of roster's login types - pick another name for it")
        if str(v) not in WEB_LOGINS:
            bad(f"web_login_names: {k!r} maps to {v!r}, which isn't a login type - use one of {', '.join(WEB_LOGINS)}")
        out[k] = str(v)
    return out


def service_credentials(h, name):
    """(user, auth reference) for one of the host's services, or for "ssh"."""
    s = h["ssh"] if name == "ssh" else h["services"].get(name)
    if s is None:
        refuse_broken(h, name)
        die(f"host {h['name']!r} has no service {name!r} (has: {', '.join(['ssh', *h['services']])})")
    return s["user"], s["auth"]


def providers_conf(raw):
    conf = dict(raw.get("providers") or {})
    if raw.get("bitwarden"):                      # older roster.yml: `bitwarden: { sync: ... }`
        conf["bw"] = {**(raw["bitwarden"] or {}), **(conf.get("bw") or {})}
    return conf


def access_label(h):
    if not h["reviewed"]:
        return "unreviewed"
    return "key" if h["enroll"] else "password"

def matches(h, text):
    """Every word in text appears somewhere in the host's identity: 'orion dev', 'core-switch'."""
    hay = " ".join(str(h[k]) for k in ("name", "group", "ip", *TEXT_FIELDS)).lower()
    words = [w for w in re.split(r"[\s_-]+", text.lower()) if w]
    return bool(words) and all(w in hay for w in words)


@overload
def selected(cfg: dict[str, Any], only: str | None, resources: Literal[False] = False) -> list[dict[str, Any]]: ...
@overload
def selected(cfg: dict[str, Any], only: str | None,
             resources: Literal[True]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]: ...
def selected(cfg: dict[str, Any], only: str | None, resources: bool = False) -> Any:
    """Hosts picked by --only; with resources=True, (hosts, resources), and a match on either is enough."""
    hosts, rs = list(cfg["hosts"].values()), list(cfg["resources"].values()) if resources else []
    if only:
        wanted = {s.strip() for s in only.split(",") if s.strip()}
        hosts = [h for h in hosts if wanted & {h["name"], h["group"], h["type"], h["product"]}]
        rs = [r for r in rs if wanted & {r["name"], r["group"], r["type"]}]
        if not hosts and not rs:
            die(f"--only {only!r} matched no host, group, type or product" + (" or resource" if resources else ""))
    return (hosts, rs) if resources else hosts
