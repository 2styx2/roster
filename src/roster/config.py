"""Loading and querying roster.yml."""

import ipaddress
import os
import re
import socket
from pathlib import Path
from urllib.parse import urlparse

import yaml

from .common import KEY_TAG, LEGACY_KEY_TAGS, NAME_RE, die, oneline, user_config_dir
from .providers import NO_PASSWORD
from .resources import load_resources

HOST_DEFAULTS = {"user": None, "port": 22, "enroll": True, "auth": "prompt",
                 "web": None, "services": {}, "notes": "",
                 "title": "", "description": "", "type": "", "product": "", "reviewed": True, "mac": "", "mesh": None}
TEXT_FIELDS = ("title", "description", "type", "product")
GROUP_ONLY = ("hosts", "title", "description")   # describe the group itself, not copied onto hosts
LOGIN = ("user", "auth")
SSH_KEYS = ("port", "user", "auth")
SERVICE_KEYS = ("port", "url", "scheme", "user", "auth", "verify", "login")
WEB_LOGINS = ("basic", "bearer", "vsphere", "unifi", "openvpnas", "hub", "none")          # how `roster web` sends the service's credentials
SERVICE_RE = re.compile(r"^[A-Za-z0-9._-]+$")
HTTPS_PORTS, HTTP_PORTS = (443, 8443), (80, 8000, 8008, 8080, 8888)


# ---------------------------------------------------------------- config

def find_config(arg):
    if arg:
        return Path(arg).expanduser()
    if os.environ.get("ROSTER_CONFIG"):
        return Path(os.environ["ROSTER_CONFIG"]).expanduser()
    for p in (Path.cwd() / "roster.yml", user_config_dir() / "roster.yml"):
        if p.exists():
            return p
    die("no roster.yml found here or in ~/.config/roster/ - run `roster init`, "
        "or pass -c PATH / set ROSTER_CONFIG")


def load_config(path):
    path = Path(path).expanduser().resolve()
    if not path.exists():
        die(f"{path} not found - run `roster init` to create one")
    return parse_config(path.read_text(), path)


def load_config_text(text, path):
    """load_config of TEXT as if it were PATH's (an edit checked before it's written): no file is read or written."""
    return parse_config(text.replace("\r\n", "\n").replace("\r", "\n"), Path(path).expanduser().resolve())


def parse_config(text, path):
    """roster.yml's TEXT (read from PATH, or as it would be there), loaded and checked."""
    try:
        raw = yaml.safe_load(text) or {}
    except yaml.YAMLError as e:
        die(f"{path} is not valid YAML:\n{e}")
    defaults = {**HOST_DEFAULTS, **(raw.get("defaults") or {})}
    names = web_login_names(raw)
    hosts, groups, mesh_dirs, seen_as, sudo_refs = {}, {}, {}, {}, {}
    for where, layer in (("defaults", raw.get("defaults") or {}),
                         *((f"group {g!r}", x or {}) for g, x in (raw.get("groups") or {}).items())):
        if isinstance(layer, dict) and "seen_as" in layer:
            die(f"{where}: seen_as: goes on a Host (the addresses it connects from), not on a group or defaults")
    for gname, group in (raw.get("groups") or {}).items():
        group = group or {}
        gset = {k: v for k, v in group.items() if k not in GROUP_ONLY}
        groups[str(gname)] = {k: oneline(group.get(k)) for k in ("title", "description")}
        for hname, h in (group.get("hosts") or {}).items():
            hname = str(hname)
            h = {"ip": h} if isinstance(h, str) else (h or {})
            if not NAME_RE.match(hname):
                die(f"bad host name {hname!r} (use letters, digits, . _ -)")
            if hname in hosts:
                die(f"host {hname!r} is listed twice")
            m = {**defaults, **gset, **h, "name": hname, "group": str(gname)}
            if not m.get("ip"):
                die(f"host {hname!r} has no ip")
            m["ip"] = str(m["ip"]).strip()
            layers = [h, gset, raw.get("defaults") or {}]        # most specific first
            m["ssh"] = resolve_ssh(hname, layers)
            if not m["ssh"]["user"]:
                die(f"host {hname!r} has no user (set it on the host, its group, or defaults)")
            if re.search(r"\s", m["ip"] + m["ssh"]["user"]):
                die(f"host {hname!r}: ip/user can't contain spaces")
            # user/port/auth stay as the resolved SSH login, so code that predates ssh: blocks keeps working
            m["user"], m["port"], m["auth"] = m["ssh"]["user"], m["ssh"]["port"], m["ssh"]["auth"]
            m["login"] = {k: first(layers, k) for k in LOGIN}    # default login for the host's services
            m["services"], m["web"], m["problems"] = resolve_services(hname, m, layers, names)
            m["enroll"] = bool(m["enroll"])
            m["reviewed"] = bool(m["reviewed"])
            m["mesh"] = first(layers, "mesh")
            if m["mesh"] is not None and not isinstance(m["mesh"], bool):
                die(f"host {hname!r}: mesh: must be true or false")
            # The app sends this Host's shell its hook line (ticket 121); roster only checks it.
            if m.get("shell_hooks") is not None and not isinstance(m["shell_hooks"], bool):
                die(f"host {hname!r}: shell_hooks: must be true or false")
            md = mesh_dir(hname, first(layers, "mesh_dir"))
            m.pop("mesh_dir", None)          # kept beside the Hosts, so serve's Host (and the Plugin API's) is as it was
            if md:
                mesh_dirs[hname] = md
            m.pop("sudo", None)              # kept beside the Hosts too: a vault reference only the prompt fill reads
            if sudo := sudo_auth(hname, layers):
                sudo_refs[hname] = sudo
            if seen := addresses_seen(hname, m.pop("seen_as", None)):
                seen_as[hname] = seen
            for k in TEXT_FIELDS:
                m[k] = oneline(m.get(k))
            m["description"] = m["description"] or oneline(m.get("notes"))   # old name for it
            hosts[hname] = m
    if not hosts:
        die(f"{path} defines no hosts")
    box = re.sub(r"[^A-Za-z0-9_-]", "-", str(raw.get("box_name") or socket.gethostname().split(".")[0]))
    key = Path(os.path.expanduser(str(raw.get("key_path") or "~/.ssh/roster_ed25519")))
    # matches this box's key line in authorized_keys, including tags from older versions
    tag_re = f" ({'|'.join((KEY_TAG,) + LEGACY_KEY_TAGS)}):{box}$"
    return {"path": path, "box": box, "tag": f"{KEY_TAG}:{box}", "tag_re": tag_re, "key": key,
            "pub": Path(str(key) + ".pub"), "workers": int(raw.get("workers") or 32),
            "inline_limit": int(raw.get("claude_inline_limit") or 60), "hosts": hosts, "groups": groups, "mesh_dirs": mesh_dirs,
            "seen_as": seen_as, "sudo": sudo_refs,
            "resources": load_resources(raw, groups, hosts), "links": load_links(raw, hosts, groups),
            "providers": providers_conf(raw), "provider_dirs": list(raw.get("provider_dirs") or [])}


# ---------------------------------------------------------------- the Mesh's links (decision Q63)

MESH_DIR_RE = re.compile(r"^(/[A-Za-z0-9._-]+)+/?$")


def mesh_dir(hname, v):
    """A Host's `mesh_dir:` (T58), where it keeps its Mesh files as a source: an absolute path that can go into
    ssh's config as it is (no spaces or quotes, no `..`), or None for roster's own pick."""
    if v is None:
        return None
    v = str(v).strip()
    if not MESH_DIR_RE.match(v) or "/../" in v + "/" or "/./" in v + "/":
        die(f"host {hname!r}: mesh_dir: must be an absolute path of letters, digits and . _ - / (it goes into ssh's "
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
            die(f"host {hname!r}: seen_as: must be IP addresses or networks (10.0.9.1, 10.0.9.0/24), one or a list, "
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
    if not isinstance(links, list):
        die("links: must be a list of { from: HOST-OR-GROUP, to: HOST-OR-GROUP, both: true|false, via: HOST }")
    out, hops = [], {}                         # hops: (source, peer) -> (entry, the Host it goes through)

    def members(name):
        return [name] if name in hosts else [h for h, m in hosts.items() if m["group"] == name]
    for n, link in enumerate(links, 1):
        where = f"links: entry {n}"
        if not isinstance(link, dict) or set(map(str, link)) - set(LINK_KEYS) or not {"from", "to"} <= set(link):
            die(f"{where} must be a mapping with from: and to: (and both: true for two-way, via: HOST for a hop), "
                "nothing else")
        ends = {}
        for k in ("from", "to"):
            name = str(link[k]) if link[k] is not None else ""
            if name in hosts and name in groups:
                die(f"{where}: {name!r} is both a Host and a group - rename one of them")
            if name not in hosts and name not in groups:
                near = sorted(x for x in (*hosts, *groups) if name and (name in x or x in name))[:5]
                die(f"{where}: {k}: {name!r} isn't a Host or a group in roster.yml"
                    + (f" (did you mean: {', '.join(near)})" if near else ""))
            ends[k] = name
        if ends["from"] == ends["to"]:
            die(f"{where} links {ends['from']!r} to itself - a group's Hosts reach each other with mesh: true")
        both = link.get("both", False)
        if not isinstance(both, bool):
            die(f"{where}: both: must be true or false")
        via = None if link.get("via") is None else str(link["via"])
        if via is not None:
            if via in groups and via not in hosts:
                die(f"{where}: via: {via!r} is a group: a Link goes through one Host")
            if via not in hosts:
                die(f"{where}: via: {via!r} isn't a Host in roster.yml")
            if via in (ends["from"], ends["to"]):
                die(f"{where}: via: {via!r} is an end of the Link itself")
            for a in members(ends["from"]):
                for b in members(ends["to"]):
                    for pair in {(a, b), (b, a)} if both else {(a, b)}:
                        if via in pair or pair[0] == pair[1]:
                            continue
                        seen = hops.setdefault(pair, (n, via))
                        if seen[1] != via:
                            die(f"links: entries {seen[0]} and {n} send {pair[0]} -> {pair[1]} through different "
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


def check_port(where, v):
    if port_number(v) is None:
        die(f"{where}: bad port {v!r} (use a number from 1 to 65535)")
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
        die(f"host {hname!r}: ssh: must be a mapping with only {', '.join(SSH_KEYS)}")
    return blk


def resolve_ssh(hname, layers):
    """SSH login. Per layer (host, group, defaults) its ssh: block beats its plain user/auth/port."""
    flat = [x for layer in layers for x in (ssh_block(hname, layer), layer)] + [HOST_DEFAULTS]
    return {"port": check_port(f"host {hname!r} ssh", first(flat, "port")),
            "user": as_user(first(flat, "user")), "auth": as_auth(first(flat, "auth"))}


def sudo_auth(hname, layers):
    """The vault reference for a Host's own sudo (and su) password, from its most specific `sudo: {auth: REF}`
    (host, group, defaults), or None: then a prompt fill (ticket 119, decision Q129) uses its ssh Login. A reference
    only, never a value, and never `prompt`, `agent`, `key` or `none`, which have no password to fill."""
    blk = first(layers, "sudo")
    if blk is None:
        return None
    if not isinstance(blk, dict) or set(map(str, blk)) != {"auth"}:
        die(f"host {hname!r}: sudo: must be a mapping with only auth (a vault reference, e.g. "
            "sudo: {auth: \"bw:esx-02 sudo\"})")
    ref = as_auth(blk["auth"]) or ""
    if ref.partition(":")[0].strip() in ("prompt", "", *NO_PASSWORD):
        die(f"host {hname!r}: sudo: auth must be a vault reference (bw:ITEM, op:ITEM, ...), not {ref!r}")
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
            die(f"host {hname!r}: services: must be a mapping of name: port or name: {{port, url, user, auth}}")
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
    if not isinstance(names, dict):
        die("web_login_names: must be a mapping of your own name: one of " + ", ".join(WEB_LOGINS))
    out = {}
    for k, v in names.items():
        k = str(k)
        if k in WEB_LOGINS:
            die(f"web_login_names: {k!r} is already one of roster's login types - pick another name for it")
        if str(v) not in WEB_LOGINS:
            die(f"web_login_names: {k!r} maps to {v!r}, which isn't a login type - use one of {', '.join(WEB_LOGINS)}")
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


def selected(cfg, only, resources=False):
    """Hosts picked by --only; with resources=True, (hosts, resources), and a match on either is enough."""
    hosts, rs = list(cfg["hosts"].values()), list(cfg["resources"].values()) if resources else []
    if only:
        wanted = {s.strip() for s in only.split(",") if s.strip()}
        hosts = [h for h in hosts if wanted & {h["name"], h["group"], h["type"], h["product"]}]
        rs = [r for r in rs if wanted & {r["name"], r["group"], r["type"]}]
        if not hosts and not rs:
            die(f"--only {only!r} matched no host, group, type or product" + (" or resource" if resources else ""))
    return (hosts, rs) if resources else hosts
