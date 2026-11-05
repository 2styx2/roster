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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import UTC_TIME, die, program_argv, replace_file, say, utc_now
from .context import key_created_file

DEFAULT = "ed25519"
# key_max_age:'s default (decision Q204): the strict end of NIST SP 800-57 Part 1 Rev. 5's cryptoperiod for a
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


def derived(key: Path) -> list[str] | None:
    """[type, key] of the public key the private key KEY gives (`ssh-keygen -y`, never asking for a passphrase), or
    None when it gives none (not a key, a passphrase on it, no ssh-keygen). Cached by the file's size and time."""
    try:
        st = key.stat()
    except OSError:
        return None
    stamp = (str(key), st.st_size, st.st_mtime_ns)
    if stamp not in _derived:
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


def rsa_bits(pub: Path) -> int | None:
    """An RSA public key's size in bits (`ssh-keygen -l`), or None when it can't tell."""
    try:
        r = subprocess.run(program_argv(["ssh-keygen", "-l", "-f", str(pub)]), capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=30)
        return int(r.stdout.split()[0]) if r.returncode == 0 else None
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        return None


def generate(kt: KeyType, path: Path, comment: str) -> None:
    """A new key of type KT at PATH (and PATH.pub), with no passphrase and COMMENT as its comment (ssh-keygen -C).
    CalledProcessError or OSError when ssh-keygen fails."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    subprocess.run(program_argv(["ssh-keygen", "-q", *kt.keygen_args(), "-N", "", "-C", comment, "-f", str(path)]),
                   check=True, stdin=subprocess.DEVNULL, capture_output=True)


def ensure_key(key: BoxKey, tag: str) -> None:
    """This Box's KEY on disk, made with ssh-keygen and tagged TAG when it isn't there yet. A key that's there is
    kept; one of another type than KEY's (an ECDSA or RSA key's file holding another key) is refused (201), as the
    Hosts that want this type would refuse it. An Ed25519 key's file is taken as it is (as before T239: key_path may
    name a key of the user's own)."""
    from .errors import KEY_TYPE_MISMATCH
    if key.key.exists():
        if not key.pub.exists():
            die(f"{key.key} exists but {key.pub} is missing")
        fix = "move it away (roster makes the new key there), or point key_path at another file"
        if key.type.name != "ed25519":
            have = (key.pub.read_text().split() or ["nothing"])[0]
            if have != key.type.public_word:
                die(f"{key.key} is an {have} key, not {key.type.name} "
                    f"({key.type.public_word}), which key_type: in roster.yml asks for: {fix}",
                    code=KEY_TYPE_MISMATCH)
            bits = rsa_bits(key.pub) if key.type.algorithm == "rsa" else None
            if bits is not None and key.type.bits is not None and bits < key.type.bits:
                die(f"{key.key} is a {bits}-bit RSA key, fewer than the {key.type.bits} bits "
                    f"key_type: {key.type.name} asks for: {fix}", code=KEY_TYPE_MISMATCH)
        # A .pub that isn't this key's would go on the Hosts and never log in. Checked only when
        # ssh-keygen can read the key without a passphrase (a key of the user's own may have one, as before)
        have_words, words = derived(key.key), public_words(key.pub)
        if have_words is not None and have_words != words:
            die(f"{key.pub} isn't the public key of {key.key} (another key's .pub beside it): "
                f"{fix}", code=KEY_TYPE_MISMATCH)
        say(f"key          {key.key} ({key.type.name}, existing)")
        return
    try:
        generate(key.type, key.key, tag)
    except subprocess.CalledProcessError as e:
        die(f"ssh-keygen couldn't make {key.key}: {(e.stderr or b'').decode(errors='replace').strip() or e}")
    stamp(key.key)                          # its age counts from now (key_max_age:)
    say(f"key          {key.key} ({key.type.name}, created)")


def public_key_line(key: BoxKey, tag: str) -> str:
    """KEY's public key line as it goes on a Host: its type and key, then TAG (which lets revoke find exactly this
    Box's line)."""
    parts = key.pub.read_text().split()
    if len(parts) < 2:
        die(f"{key.pub} doesn't look like a public key")
    return f"{parts[0]} {parts[1]} {tag}"


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
        # no one else's to read) gives that very .pub. A stray .pub (another Box's copied here),
        # an empty or foreign file beside it, never widens what setup and revoke take
        if kt.file_name + ".pub" == pub.name and owned(pub.with_suffix("")) and matches(pub.with_suffix("")):
            keys.setdefault(kt.name, BoxKey(kt, key_file(cfg["key"], cfg["key_type"], kt.name)))
    out = list(keys.values())
    # Mid-rotation, each key's new one (KEY.new) and kept old one (KEY.old) are this Box's too, so revoke takes
    # (and names) both, and a renamed Box finds their lines. The same test as above: this user's, its .pub its own
    for k in list(out):
        for suffix in (".new", ".old"):
            other = Path(str(k.key) + suffix)
            if other.exists() and owned(other) and matches(other):
                out.append(BoxKey(k.type, other))
    return out


# ---------------------------------------------------------------- the key's age (key_max_age:)

def stamp(key: Path) -> None:
    """Record that roster made (or rotated) KEY now (context.key_created_file): its age is counted from this."""
    rows = {p: t for t, p in _created_rows()}
    rows[str(key)] = utc_now()
    replace_file(key_created_file(), "".join(f"{t}\t{p}\n" for p, t in sorted(rows.items())), 0o600)


def _created_rows() -> list[tuple[str, str]]:
    try:
        text = key_created_file().read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    return [(t, p) for t, _, p in (ln.partition("\t") for ln in text.splitlines()) if p]


def created(key: Path):
    """When KEY was made or last rotated (a UTC datetime): roster's record of it, else the file's own time (a key made
    before T240, or by hand). None when there's no such file."""
    for t, p in _created_rows():
        if p == str(key):
            try:
                return datetime.strptime(t, UTC_TIME).replace(tzinfo=timezone.utc)
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
        # ASCII digits only: `\d` takes any script's digits
        m = re.fullmatch(r"([0-9]{1,6})\s*([dwy]?)", value.strip().lower(), re.ASCII) if isinstance(value, str) else None
        if m is None:
            raise ValueError(f"{value!r} isn't an age: write days as 365d (or 52w, 1y), or off")
        days = int(m[1]) * {"": 1, "d": 1, "w": 7, "y": 365}[m[2]]
    if days < 1:
        raise ValueError(f"{value!r} isn't an age: at least 1d (or off)")
    if days > MAX_AGE_LIMIT:    # a huge age would turn the warning off without saying so: that's `off`
        raise ValueError(f"{value!r} is more than roster takes: at most 10y (3650d); write off to turn it off")
    return days
