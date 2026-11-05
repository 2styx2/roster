"""What roster asks of a Host (its dict view, as config.load_config gives it): the rules for it, in one place.
Kept apart from models.py, whose Pydantic roster's start never imports."""

import ipaddress
import re
from typing import Any

from .providers import NO_PASSWORD

PLACEHOLDER_USER = "CHANGE-ME"      # discover's: no SSH user set yet


def is_windows(h: dict[str, Any]) -> bool:
    """Does roster treat Host H as Windows? Only `os: windows` says so (T195, decision Q174): type: is a free label."""
    return h.get("os") == "windows"


def password_login(ref: str | None) -> bool:
    """Does the Login reference REF log in with a password (asked for, or from a vault), not a key or an agent?"""
    return ref not in (None, "", *NO_PASSWORD)


def vault_login(ref: str | None) -> bool:
    """Is REF a vault reference with a password behind it: not `prompt`, and not one of NO_PASSWORD?"""
    return (ref or "").partition(":")[0].strip() not in ("", "prompt", *NO_PASSWORD)


def placeholder_user(h: dict[str, Any]) -> bool:
    """Has Host H no SSH user yet (discover's placeholder, or none)?"""
    return h["ssh"]["user"] in ("", PLACEHOLDER_USER)


ZONE_RE = re.compile(r"^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,31}\Z")


def ip_of(v):
    """V as an ipaddress address (an IPv6 zone checked), or None when it isn't an IP address."""
    try:
        ip = ipaddress.ip_address(v)
    except ValueError:
        return None
    zone = getattr(ip, "scope_id", None)
    return ip if zone is None or ZONE_RE.match(zone) else None
