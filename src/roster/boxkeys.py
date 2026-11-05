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

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT = "ed25519"
# key_max_age:'s default (T240, decision Q204): the strict end of NIST SP 800-57 Part 1 Rev. 5's cryptoperiod for a
# private authentication key ("no more than one or two years", §5.3.6 item 4; Table 1: 1 to 2 years)
MAX_AGE = "365d"
MAX_AGE_LIMIT = 3650        # days: the most key_max_age: takes (10 years); `off` is how to turn the warning off
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

    @property
    def mesh_file(self) -> str:
        """The name of a Mesh key of this type on a source Host (T245, decision Q212): `id_ed25519` as before T245,
        `id_<name>` for the rest (`id_ecdsa`, `id_rsa-4096`), so a type change is a key of another name."""
        return f"id_{self.name}"


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


# every Mesh key name a source Host may hold (mesh_file), as an sh `case` pattern: what the Mesh's scripts look for
MESH_FILES = "id_ed25519|id_ecdsa|id_ecdsa-256|id_ecdsa-521|id_rsa|id_rsa-[0-9][0-9][0-9][0-9]|id_rsa-[0-9][0-9][0-9][0-9][0-9]"


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


def derived(key: Path) -> list[str] | None:
    """[type, key] of the public key the private key KEY gives (`ssh-keygen -y`, never asking for a passphrase), or
    None when it gives none (not a key, a passphrase on it, no ssh-keygen). Cached by the file's size and time."""
    try:
        st = key.stat()
    except OSError:
        return None
    stamp = (str(key), st.st_size, st.st_mtime_ns)
    if stamp not in _derived:
        from .common import program_argv
        try:
            r = subprocess.run(program_argv(["ssh-keygen", "-y", "-P", "", "-f", str(key)]), capture_output=True,
                               text=True, stdin=subprocess.DEVNULL, timeout=30)
            words = r.stdout.split() if r.returncode == 0 else []
        except (OSError, ValueError, subprocess.TimeoutExpired):
            words = []
        _derived[stamp] = words[:2] if len(words) >= 2 else None
    return _derived[stamp]


_derived: dict[tuple[str, int, int], list[str] | None] = {}


def public_words(pub: Path) -> list[str] | None:
    """[type, key] of the public key file PUB, or None."""
    try:
        words = pub.read_text().split()
    except (OSError, UnicodeDecodeError):
        return None
    return words[:2] if len(words) >= 2 else None


def matches(key: Path) -> bool:
    """Does the private key KEY give the public key in KEY.pub?"""
    have = derived(key)
    return have is not None and have == public_words(Path(str(key) + ".pub"))


def owned(key: Path) -> bool:
    """KEY is this user's and no one else's to read or write (POSIX; on Windows its ACL isn't read: True)."""
    if os.name == "nt":
        return True
    try:
        st = key.stat()
    except OSError:
        return False
    return st.st_uid == os.getuid() and not st.st_mode & 0o077


def vouched(key: BoxKey, own: Path) -> bool:
    """Does this Box hold KEY (T245, #471's review LOW-6)? Its private key is this user's alone (owned) and gives KEY.pub
    (matches): a .pub with no private key beside it, or another's, is never this Box's, whatever roster.yml names.
    OWN (key_path: this Box's own key, which may be the user's own with a passphrase, Q200 (c)) counts when ssh-keygen
    can't read it without one."""
    if not owned(key.key):
        return False
    return matches(key.key) or (key.key == own and derived(key.key) is None and public_words(key.pub) is not None)


def rsa_bits(pub: Path) -> int | None:
    """An RSA public key's size in bits (`ssh-keygen -l`), or None when it can't tell."""
    from .common import program_argv
    try:
        r = subprocess.run(program_argv(["ssh-keygen", "-l", "-f", str(pub)]), capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=30)
        return int(r.stdout.split()[0]) if r.returncode == 0 else None
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        return None


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
        # only the canonical names roster itself writes, and only a key this Box holds: its private key (this user's,
        # no one else's to read) gives that very .pub (#471's review LOW-3). A stray .pub (another Box's copied here),
        # an empty or foreign file beside it, never widens what setup and revoke take
        if kt.file_name + ".pub" == pub.name and owned(pub.with_suffix("")) and matches(pub.with_suffix("")):
            keys.setdefault(kt.name, BoxKey(kt, key_file(cfg["key"], cfg["key_type"], kt.name)))
    out = list(keys.values())
    # T240: mid-rotation, each key's new one (KEY.new) and kept old one (KEY.old) are this Box's too, so revoke takes
    # (and names) both, and a renamed Box finds their lines. The same test as above: this user's, its .pub its own
    for k in list(out):
        for suffix in (".new", ".old"):
            other = Path(str(k.key) + suffix)
            if other.exists() and owned(other) and matches(other):
                out.append(BoxKey(k.type, other))
    return out


# ---------------------------------------------------------------- the types on each Host (T245, #478 items 4 and 7)

_CURRENT: Any = object()


def installed(inv: Any = _CURRENT) -> dict[str, list[str]]:
    """{host: the key types of this Box's lines there}, as roster last left them: written by setup's install, its
    cleanup and a rotation, taken off by revoke (common.key_types_file: `HOST<TAB>TYPE TYPE`). A Host roster hasn't
    installed on since T245 isn't in it: nothing is known there."""
    from .common import key_types_file
    try:
        text = (key_types_file() if inv is _CURRENT else key_types_file(inv)).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return {}
    out = {}
    for line in text.splitlines():
        host, _, types = line.partition("\t")
        if host and types.split():
            out[host] = sorted(set(types.split()))
    return out


def record(changes: dict[str, Any], inv: Any = _CURRENT) -> None:
    """Update the record (installed): {host: its types now (an iterable), or None when this Box has no line there}."""
    from .common import key_types_file, replace_file
    f = key_types_file() if inv is _CURRENT else key_types_file(inv)
    rows = installed(inv)
    for host, types in changes.items():
        if types:
            rows[host] = sorted(set(types))
        else:
            rows.pop(host, None)
    if rows:
        replace_file(f, "".join(f"{h}\t{' '.join(t)}\n" for h, t in sorted(rows.items())), 0o600)
    else:
        f.unlink(missing_ok=True)


def extra(h: dict[str, Any], inv: Any = _CURRENT) -> list[str]:
    """The key types of this Box's lines on Host H other than its own key_type's, by the record (setup --key-type's
    lines, or a cleanup that failed): setup takes them off, check says so (219)."""
    return [t for t in installed(inv).get(h["name"], []) if t != h["key_type"]]


def drift(cfg: dict[str, Any], hosts: Any = None) -> dict[str, str]:
    """{host: what differs} between the record and roster.yml's key_type, for HOSTS' key Hosts (every one's when
    None): a line of another type still there, or none of roster.yml's type (it changed since the last setup)."""
    from .errors import KEY_TYPE_DRIFT
    rec = installed()
    out = {}
    for h in (cfg["hosts"].values() if hosts is None else hosts):
        have = rec.get(h["name"])
        if not h["enroll"] or not have or have == [h["key_type"]]:
            continue
        if h["key_type"] not in have:
            out[h["name"]] = (f"[{KEY_TYPE_DRIFT}] {h['name']} holds this Box's {' and '.join(have)} key, and roster.yml "
                              f"says key_type: {h['key_type']} (changed since its last setup): roster setup --host "
                              f"{h['name']} installs it and takes the other off")
        else:
            others = [t for t in have if t != h["key_type"]]
            out[h["name"]] = (f"[{KEY_TYPE_DRIFT}] {h['name']} still holds this Box's {' and '.join(others)} key line "
                              f"besides its {h['key_type']} one (setup --key-type's, or a cleanup that failed): roster "
                              "setup takes it off")
    return out


# ---------------------------------------------------------------- the key's age (T240, key_max_age:)

def stamp(key: Path) -> None:
    """Record that roster made (or rotated) KEY now (common.key_created_file): its age is counted from this."""
    from datetime import datetime, timezone

    from .common import key_created_file, replace_file
    rows = {p: t for t, p in _created_rows()}
    rows[str(key)] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    replace_file(key_created_file(), "".join(f"{t}\t{p}\n" for p, t in sorted(rows.items())), 0o600)


def _created_rows() -> list[tuple[str, str]]:
    from .common import key_created_file
    try:
        text = key_created_file().read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    return [(t, p) for t, _, p in (ln.partition("\t") for ln in text.splitlines()) if p]


def created(key: Path):
    """When KEY was made or last rotated (a UTC datetime): roster's record of it, else the file's own time (a key made
    before T240, or by hand). None when there's no such file."""
    from datetime import datetime, timezone
    for t, p in _created_rows():
        if p == str(key):
            try:
                return datetime.strptime(t, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            except ValueError:
                break
    try:
        return datetime.fromtimestamp(key.stat().st_mtime, timezone.utc)
    except OSError:
        return None


def parse_age(value: Any) -> int | None:
    """`key_max_age:` as days (None: off). VALUE: N or `Nd` days, `Nw` weeks, `Ny` years (365 days each), or `off`
    (false). ValueError otherwise."""
    if value is False or (isinstance(value, str) and value.strip().lower() == "off"):
        return None
    if isinstance(value, int) and not isinstance(value, bool):
        days = value
    else:
        # ASCII digits only (#482's review: `\d` takes any script's digits)
        m = re.fullmatch(r"([0-9]{1,6})\s*([dwy]?)", value.strip().lower(), re.ASCII) if isinstance(value, str) else None
        if m is None:
            raise ValueError(f"{value!r} isn't an age: write days as 365d (or 52w, 1y), or off")
        days = int(m[1]) * {"": 1, "d": 1, "w": 7, "y": 365}[m[2]]
    if days < 1:
        raise ValueError(f"{value!r} isn't an age: at least 1d (or off)")
    if days > MAX_AGE_LIMIT:    # a huge age would turn the warning off without saying so: that's `off`
        raise ValueError(f"{value!r} is more than roster takes: at most 10y (3650d); write off to turn it off")
    return days
