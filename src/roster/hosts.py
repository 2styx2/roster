"""What roster asks of a Host (its dict view, as config.load_config gives it): the rules for it, in one place.
Kept apart from models.py, whose Pydantic roster's start never imports."""

import ipaddress
import re
import threading
from typing import Any

NO_PASSWORD = ("agent", "key", "none")      # Logins with no password behind them (auth: agent, key, none)

PLACEHOLDER_USER = "CHANGE-ME"      # discover's: no SSH user set yet


def is_windows(h: dict[str, Any]) -> bool:
    """Does roster treat Host H as Windows? Only `os: windows` says so (T195, decision Q174): type: is a free label."""
    return h.get("os") == "windows"


def password_login(ref: str | None) -> bool:
    """Does the Login reference REF log in with a password (asked for, or from a vault), not a key or an agent?"""
    return ref not in (None, "", *NO_PASSWORD)


def provider_of(ref: object) -> str:
    """The provider a Login reference names: `bw` of `bw:ITEM`, `prompt` of `prompt`, `key` of `key`; "" for none."""
    return str(ref or "").partition(":")[0].strip()


def item_of(ref: object) -> str:
    """What a Login reference asks its provider for: `ITEM` of `bw:ITEM` ("" when it names none)."""
    return str(ref or "").partition(":")[2].strip()


def prompted(ref: object) -> bool:
    """Is REF `auth: prompt`: a password nobody saved, which the user types?"""
    return provider_of(ref) == "prompt"


def vault_login(ref: object) -> bool:
    """Is REF a vault reference with a password behind it: not `prompt`, and not one of NO_PASSWORD?"""
    return provider_of(ref) not in ("", "prompt", *NO_PASSWORD)


def placeholder_user(h: dict[str, Any]) -> bool:
    """Has Host H no SSH user yet (discover's placeholder, or none)?"""
    return h["ssh"]["user"] in ("", PLACEHOLDER_USER)


def account(h: dict[str, Any]) -> tuple[str, int, str]:
    """The account Host H logs in to: its address, port and user, as roster.yml writes them. Two Host entries with one
    account share its authorized_keys: two names for one machine, or a user several entries share (T258). Another port
    is another machine (containers port-forwarded on one address, #524's review M1); a user's case is its own except on
    Windows (L1). Not resolved: a name and an IP address of one machine are two accounts here."""
    address = ip_of(h["ip"])
    user = str(h["ssh"]["user"])
    return (str(address) if address is not None else str(h["ip"]).casefold(), int(h["ssh"]["port"]),
            user.casefold() if is_windows(h) else user)


class AccountLocks:
    """One lock per account (account()): threads that edit Hosts' authorized_keys at once take turns on Host entries
    that share one, so neither's rewrite drops the other's line (T258). Hosts with their own accounts never wait."""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locks: dict[tuple[str, int, str], threading.Lock] = {}

    def __call__(self, h: dict[str, Any]) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(account(h), threading.Lock())


ZONE_RE = re.compile(r"^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,31}\Z")


def ip_of(v: Any) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """V as an ipaddress address (an IPv6 zone checked), or None when it isn't an IP address."""
    try:
        ip = ipaddress.ip_address(v)
    except ValueError:
        return None
    zone = getattr(ip, "scope_id", None)
    return ip if zone is None or ZONE_RE.match(zone) else None
