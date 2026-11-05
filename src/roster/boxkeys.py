"""This Box's SSH keys, one per key type (T239, #436, decision Q200): the one place that maps a key type to its file,
its ssh-keygen arguments and the type word its public key starts with, and a Host to the key it logs in with.

`key_type:` in roster.yml (top level: this Box's key; then `defaults:`, a group, a Host, the most specific winning)
picks it: `ed25519` (the default, as before T239), `ecdsa` (P-384; `ecdsa-256`, `ecdsa-384`, `ecdsa-521` pick the
curve) or `rsa` (3072 bits; `rsa-BITS` for more, never fewer). A FIPS-mode Host (RHEL 8-9 with FIPS on, most
STIG-hardened Linux) refuses Ed25519 and takes the other two.

The top-level type's key is at `key_path:` (`~/.ssh/roster_<type>` unless set: `~/.ssh/roster_ed25519` for the
default, as before); every other type's is `roster_<type>` beside it. Every key carries the same tag
(`roster-managed:BOX`), so revoke and re-tag find this Box's lines by the tag whatever their type."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT = "ed25519"
RSA_MIN, RSA_MAX = 3072, 16384
CURVES = (256, 384, 521)
ALLOWED = (f"ed25519, ecdsa (P-384), ecdsa-256, ecdsa-384, ecdsa-521, rsa (3072 bits) or rsa-BITS with BITS "
           f"{RSA_MIN} to {RSA_MAX}")
SPELLING = re.compile(r"(ed25519|ecdsa|rsa)(?:-(\d+))?")


@dataclass(frozen=True)
class KeyType:
    """One key type as roster names it: `name` is its canonical spelling (the default size has none)."""

    name: str
    algorithm: str              # ssh-keygen -t
    bits: int | None            # ssh-keygen -b (None: Ed25519 has one size)

    @property
    def public_word(self) -> str:
        """The type its public key line starts with (and authorized_keys has)."""
        return {"ed25519": "ssh-ed25519", "rsa": "ssh-rsa"}.get(self.algorithm) or f"ecdsa-sha2-nistp{self.bits}"

    def keygen_args(self) -> list[str]:
        return ["-t", self.algorithm] + ([] if self.bits is None else ["-b", str(self.bits)])

    @property
    def file_name(self) -> str:
        return f"roster_{self.name}"


def parse(value: Any) -> KeyType:
    """VALUE as roster.yml has it (any case), or ValueError naming the allowed values."""
    m = SPELLING.fullmatch(value.strip().lower()) if isinstance(value, str) else None
    if m is None or (m[1] == "ed25519" and m[2]):
        raise ValueError(f"{value!r} isn't a key type roster makes ({ALLOWED})")
    algorithm, bits = m[1], int(m[2]) if m[2] else None
    if algorithm == "ed25519":
        return KeyType("ed25519", "ed25519", None)
    if algorithm == "ecdsa":
        bits = bits or 384
        if bits not in CURVES:
            raise ValueError(f"{value!r} isn't a key type roster makes: ECDSA's curves are P-256, P-384 and P-521 "
                             f"({ALLOWED})")
        return KeyType("ecdsa" if bits == 384 else f"ecdsa-{bits}", "ecdsa", bits)
    bits = bits or RSA_MIN
    if not RSA_MIN <= bits <= RSA_MAX:
        raise ValueError(f"{value!r} isn't a key type roster makes: an RSA key has {RSA_MIN} to {RSA_MAX} bits "
                         f"(fewer is too weak) ({ALLOWED})")
    return KeyType("rsa" if bits == RSA_MIN else f"rsa-{bits}", "rsa", bits)


def key_file(box_key: Path, box_type: str, name: str) -> Path:
    """Where key type NAME's key is, with this Box's key (the top-level type BOX_TYPE's) at BOX_KEY."""
    return box_key if name == box_type else box_key.parent / parse(name).file_name


@dataclass(frozen=True)
class BoxKey:
    """One of this Box's keys: its type, and its private and public key files."""

    type: KeyType
    key: Path

    @property
    def pub(self) -> Path:
        return Path(str(self.key) + ".pub")


def for_host(h: dict[str, Any]) -> BoxKey:
    """The key Host H (a Host dict) logs in with."""
    return BoxKey(parse(h["key_type"]), Path(h["key_file"]))


def box_key(cfg: dict[str, Any]) -> BoxKey:
    """This Box's own key: the top-level type's, at key_path."""
    return BoxKey(parse(cfg["key_type"]), cfg["key"])


def in_use(cfg: dict[str, Any], hosts: Any = None) -> list[BoxKey]:
    """The keys HOSTS' key Logins use (every Host's, when None), one per type, the Box's own first when it's one."""
    pool = list(cfg["hosts"].values() if hosts is None else hosts)
    own = box_key(cfg)
    keys: dict[str, BoxKey] = {}
    if any(h["enroll"] and h["key_type"] == own.type.name for h in pool):
        keys[own.type.name] = own
    for h in pool:
        if h["enroll"]:
            keys.setdefault(h["key_type"], for_host(h))
    return list(keys.values())


def all_keys(cfg: dict[str, Any]) -> list[BoxKey]:
    """Every key of this Box: the Box's own, the ones its Hosts use, and any other roster_<type> key beside
    key_path (a type a Host used before roster.yml changed it), so revoke and re-tag find its lines too."""
    keys = {k.type.name: k for k in [box_key(cfg), *in_use(cfg)]}
    folder = cfg["key"].parent
    try:
        found = sorted(folder.glob("roster_*.pub"))
    except OSError:
        found = []
    for pub in found:
        try:
            kt = parse(pub.name.removeprefix("roster_").removesuffix(".pub"))
        except ValueError:
            continue
        # only the canonical names roster itself writes, with the private key there too: this Box holds that key, so
        # its lines are this Box's (a stray .pub alone, another Box's copied here, never widens what revoke takes)
        if kt.file_name + ".pub" == pub.name and pub.with_suffix("").exists():
            keys.setdefault(kt.name, BoxKey(kt, key_file(cfg["key"], cfg["key_type"], kt.name)))
    return list(keys.values())
