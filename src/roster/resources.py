"""Resources: things with a login or a secret but no address to connect to (Wi-Fi networks, web
accounts, API keys). They live under `resources:` in roster.yml.

Every resource has the same COMMON fields, plus the fixed fields of its type in TYPES. Nothing else is
allowed. Every view (`roster hosts --resources`, `roster hosts NAME`, ROSTER.md, `roster check --auth`) is built from
`fields()` and `summary()`, so a field is defined once and shows up the same way everywhere.
"""

from .common import NAME_RE, die, oneline
from .errors import InventoryError

WIFI_SECURITY = ("wpa2", "wpa3", "wpa", "wep", "open", "wpa2-enterprise", "wpa3-enterprise")


def _text(where, v):
    return oneline(v)


def _required_text(where, v):
    if not oneline(v):
        raise InventoryError(f"{where}: needs a value")
    return oneline(v)


def _bool(where, v):
    if not isinstance(v, bool):
        raise InventoryError(f"{where}: use true or false")
    return v


def _security(where, v):
    v = str(v).strip().lower()
    if v not in WIFI_SECURITY:
        raise InventoryError(f"{where}: {v!r} - use one of {', '.join(WIFI_SECURITY)}")
    return v


def _url(where, v):
    v = oneline(v)
    if not v.startswith(("http://", "https://")) or " " in v:
        raise InventoryError(f"{where}: {v!r} - expected http(s)://...")
    return v


# (key, label, parse, default). Order here is the order every view shows them in.
COMMON = (
    ("title", "title", _text, ""),
    ("description", "description", _text, ""),
    ("group", "group", _text, ""),          # optional: the roster.yml group it belongs with
    ("user", "user", _text, ""),
    ("auth", "auth", _text, ""),            # where the secret comes from, e.g. bw:ITEM - never the value
)
TYPES = {
    "wifi": {"help": "Wi-Fi network: auth is its password",
             "fields": (("ssid", "SSID", _required_text, None),
                        ("security", "security", _security, "wpa2"),
                        ("hidden", "hidden", _bool, False))},
    "account": {"help": "login to a website, portal or SaaS that isn't a host in this map",
                "fields": (("url", "URL", _url, None),)},
    "secret": {"help": "a lone secret: API key, license key, PSK, recovery code",
               "fields": ()},
}


def load_resources(raw, groups, hosts):
    """The `resources:` section, validated and normalized: every resource has every field of its type."""
    section = raw.get("resources") or {}     # a mapping: config.check_shapes
    out = {}
    for name, r in section.items():
        name, where = str(name), f"resource {name!r}"
        if not NAME_RE.match(name):
            raise InventoryError(f"bad resource name {name!r} (use letters, digits, . _ -)")
        if name in hosts:
            raise InventoryError(f"{where}: a host already has that name")
        if not isinstance(r, dict):
            raise InventoryError(f"{where}: must be a mapping with a type")
        kind = str(r.get("type", ""))
        if kind not in TYPES:
            raise InventoryError(f"{where}: type {kind!r} - use one of {', '.join(TYPES)}")
        spec = COMMON + TYPES[kind]["fields"]
        allowed = {"type"} | {k for k, *_ in spec}
        extra = sorted(set(map(str, r)) - allowed)
        if extra:
            raise InventoryError(f"{where}: unknown field {', '.join(extra)} (a {kind} has: {', '.join(sorted(allowed))})")
        m = {"name": name, "type": kind}
        for key, _, parse, default in spec:
            if key in r and r[key] is not None:
                m[key] = parse(f"{where} {key}", r[key])
            elif default is None:
                raise InventoryError(f"{where}: a {kind} needs {key}")
            else:
                m[key] = default
        if m["group"] and m["group"] not in groups:
            raise InventoryError(f"{where}: group {m['group']!r} isn't in roster.yml (groups: {', '.join(groups)})")
        if not m["auth"] and not (kind == "wifi" and m["security"] == "open"):
            raise InventoryError(f"{where}: needs auth (where its secret comes from, e.g. bw:ITEM)")
        out[name] = m
    return out


def fields(r):
    """[(label, value)] in schema order: name, type, the common fields, then the type's own fields."""
    rows = [("name", r["name"]), ("type", r["type"])]
    for key, label, *_ in COMMON + TYPES[r["type"]]["fields"]:
        v = r[key]
        rows.append((label, ("yes" if v else "no") if isinstance(v, bool) else v))
    return rows


def summary(r):
    """The type's own fields on one line: 'SSID Lab-Guest, security wpa2'."""
    parts = []
    for key, label, *_ in TYPES[r["type"]]["fields"]:
        v = r[key]
        if isinstance(v, bool):
            if v:
                parts.append(label)
        elif v:
            parts.append(f"{label} {v}")
    return ", ".join(parts)


def login(r):
    """Who logs in and where the secret comes from - the reference only, never a value."""
    if not r["auth"]:
        return "no secret"
    return (f"{r['user']}, " if r["user"] else "") + f"auth {r['auth']}"


def wifi_uri(r, secret):
    """WIFI:... string that phone cameras and QR generators understand."""
    if r["security"].endswith("-enterprise"):
        die(f"{r['name']}: no WIFI: string for {r['security']} networks")

    def esc(s):
        return "".join("\\" + c if c in '\\;,:"' else c for c in s)
    kind = {"open": "nopass", "wep": "WEP"}.get(r["security"], "WPA")
    out = f"WIFI:T:{kind};S:{esc(r['ssid'])};"
    if kind != "nopass":
        out += f"P:{esc(secret)};"
    return out + ("H:true;" if r["hidden"] else "") + ";"
