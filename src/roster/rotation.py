"""Rotating the Box key (T240, #469, decision Q204): `roster setup --rotate` replaces this Box's key on every Host
roster set up, so access is never lost:

1. A new key beside each key file being rotated (`roster_ed25519.new`), of its type, with the same comment.
2. On each Host, one connection at a time (rate limiters): the new key logs in already (a re-run), or the old key
   logs in and appends the new line, then the new key logs in to prove it.
3. Only when every Host reached proved it (one that refused the new key stops here: nothing is removed anywhere):
   the new key moves into the key file (the old one kept as `.old` for now), the ssh config follows, and on each
   proven Host, over the new key, this Box's other key lines (each matched by its public key AND a roster-managed
   tag, sshops.key_ere: never a `roster-mesh:` line, never a line without a roster tag) are taken off.
4. A Host not reached (down, out of `--host`'s scope) or whose cleanup failed stays pending: its name in the
   pending record (common.rotation_file, beside key-name, never mesh.json), and while any is, the old key stays as
   `.old` and the ssh config offers both keys there (new, then old), so `ssh NAME` and the Mesh still log in. Once
   none is, the old private key and its `.pub` are deleted. A re-run (`setup --rotate` again) finishes the pending
   Hosts. `roster check` and `check --box` report them until then (#471's LOW-5: a cleanup that failed never
   looks done).

Every connection here uses a one-Host ssh config of its own (`ssh -F`, the Host's address, user, port and
roster's known_hosts, exactly one key, IdentitiesOnly), so the proof is that key and nothing else, and named
Inventories that share the key file (rotated together, Q204) are reached at their own address."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import boxkeys
from .common import (
    CURRENT,
    KEY_TAG,
    LEGACY_KEY_TAGS,
    current_inventory,
    die,
    known_hosts_file,
    program_argv,
    replace_file,
    rotation_file,
    ssh_path,
)
from .config import is_windows


def new_of(key: Path) -> Path:
    return Path(str(key) + ".new")


def old_of(key: Path) -> Path:
    return Path(str(key) + ".old")


def pub_of(key: Path) -> Path:
    return Path(str(key) + ".pub")


@dataclass(frozen=True)
class Slot:
    """One of this Box's key files (KEY), and where its new and old key are now: before the swap the new one is
    KEY.new and the old one KEY itself; after it, the new one is KEY and the old one KEY.old (while it's kept)."""

    type: boxkeys.KeyType
    key: Path

    @property
    def swapped(self) -> bool:
        return not new_of(self.key).exists()

    @property
    def new(self) -> Path:
        return self.key if self.swapped else new_of(self.key)

    @property
    def old(self) -> Path | None:
        if not self.swapped:
            return self.key
        return old_of(self.key) if old_of(self.key).exists() else None


@dataclass(frozen=True, eq=False)
class Member:
    """A key Host of one of the Inventories rotated together: INV (its name, None: the unnamed one) and its key."""

    inv: str | None
    cfg: dict[str, Any]
    h: dict[str, Any]
    slot: Slot

    @property
    def name(self) -> str:
        return self.h["name"]

    @property
    def label(self) -> str:
        return self.name if self.inv == current_inventory() else f"{self.inv or '(unnamed)'}: {self.name}"


# ---------------------------------------------------------------- the record

class Unreadable(RuntimeError):
    """The record is there but can't be read (#482's review LOW-1): roster can't tell which Hosts still hold the old
    key, so it fails closed (check says so, the ssh config offers every Host both keys, setup --rotate stops)."""


@dataclass
class Record:
    """What the rotation of one Inventory has done (common.rotation_file): PENDING, the Hosts it hasn't finished on
    (name: why); KEYS, each key file it's rotating (its path: {type, old, new}, old and new as `TYPE BASE64`, the
    public keys it started from and made), written before anything else so a KEY.new or KEY.old is known as the
    rotation's own, never just by its name (#482's review MED-1); REFUSED, the Hosts that refused the new key, which
    hold back the swap until each proves it."""

    pending: dict[str, str] = field(default_factory=dict)
    keys: dict[str, dict[str, Any]] = field(default_factory=dict)
    refused: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not (self.pending or self.keys or self.refused)


def read(inv: Any = CURRENT) -> Record:
    """INV's record: an empty one when there's no file; Unreadable when there's one roster can't read."""
    f = rotation_file(inv)
    try:
        text = f.read_text(encoding="utf-8")
    except FileNotFoundError:
        return Record()
    except (OSError, UnicodeDecodeError) as e:
        raise Unreadable(f"{f} can't be read ({e})") from None
    try:
        data = json.loads(text)
        pending, keys, refused = data["pending"], data.get("keys", {}), data.get("refused", [])
        if not (isinstance(pending, dict) and isinstance(keys, dict) and isinstance(refused, list)
                and all(isinstance(v, dict) for v in keys.values())):
            raise ValueError("not roster's shape")
    except (ValueError, TypeError, KeyError) as e:
        raise Unreadable(f"{f} can't be read (it isn't the record roster writes: {e})") from None
    return Record({str(k): str(v) for k, v in pending.items()}, {str(k): dict(v) for k, v in keys.items()},
                  [str(x) for x in refused])


def write(rec: Record, inv: Any = CURRENT) -> None:
    f = rotation_file(inv)
    if rec.empty:
        f.unlink(missing_ok=True)
        return
    replace_file(f, json.dumps({"pending": dict(sorted(rec.pending.items())), "keys": rec.keys,
                                "refused": sorted(set(rec.refused))}, indent=1) + "\n", 0o600)


def load(inv: Any = CURRENT) -> dict[str, str]:
    """The Hosts (name: why) of the Inventory INV the rotation hasn't finished on; empty when none (or unreadable:
    problems() says so)."""
    try:
        return read(inv).pending
    except Unreadable:
        return {}


def pending(cfg: dict[str, Any]) -> dict[str, str]:
    """This run's Inventory's Hosts the rotation is pending on (name: why), those still in roster.yml."""
    return {n: why for n, why in load().items() if n in cfg["hosts"]}


def forget(names, inv: Any = CURRENT, everything: bool = False) -> None:
    """revoke took this Box's key off NAMES (#482's review LOW-3): they hold neither key now. EVERYTHING: every Host
    of the Inventory lost it, so the record goes (the key files are revoke's to name for deletion)."""
    try:
        rec = read(inv)
    except Unreadable:
        if everything:
            rotation_file(inv).unlink(missing_ok=True)
        return
    if everything:
        write(Record(), inv)
        return
    for n in names:
        rec.pending.pop(n, None)
    rec.refused = [n for n in rec.refused if n not in set(names)]
    write(rec, inv)


ALL = object()     # identity_files: every Host (the record can't be read, or a kept old key has no record)


def config_waiting(cfg: dict[str, Any]) -> Any:
    """The Hosts whose ssh config block offers the old key too: the pending ones, or ALL when roster can't tell
    (an unreadable record, or a kept KEY.old with no record of its rotation: fail closed, #482's LOW-1)."""
    try:
        rec = read()
    except Unreadable:
        return ALL
    for key in {Path(h["key_file"]) for h in cfg["hosts"].values() if h["enroll"]}:
        if old_of(key).exists() and str(key) not in rec.keys:
            return ALL
    return set(rec.pending)


def identity_files(h: dict[str, Any], waiting: Any = ()) -> list[str]:
    """The key files the ssh config offers Host H, in order: its key, then (when H is in WAITING, or WAITING is ALL,
    and the old key is kept as .old, this user's with its own .pub) the old one, so a Host not switched yet still
    logs in."""
    key = Path(h["key_file"])
    out = [h["key_file"]]
    old = old_of(key)
    if (waiting is ALL or h["name"] in waiting) and not new_of(key).exists() and old.exists() \
            and boxkeys.owned(old) and boxkeys.matches(old):
        out.append(str(old))
    return out


def problems(cfg: dict[str, Any]) -> list[tuple[str, str]]:
    """What's wrong with this Inventory's rotation state besides pending Hosts, as (message, fix): an unreadable
    record (LOW-1), and a KEY.new or KEY.old with no Host pending or no record of its rotation (LOW-2, MED-1).
    Read-only: check, check --box and setup report them."""
    from .errors import ROTATION_PENDING
    out: list[tuple[str, str]] = []
    try:
        rec = read()
    except Unreadable as e:
        return [(f"[{ROTATION_PENDING}] the Box key rotation's record {e}: roster can't tell which Hosts still hold "
                 "the old Box key, so this Box's ssh config offers every Host both keys",
                 "run `roster setup --rotate`, which says what to do; restore the file if you have it")]
    keys = sorted({Path(h["key_file"]) for h in cfg["hosts"].values() if h["enroll"]} | {cfg["key"]})
    held = [n for n in rec.pending if n in cfg["hosts"]]
    for key in keys:
        for f in (new_of(key), old_of(key)):
            if not (f.exists() or pub_of(f).exists()):
                continue
            if str(key) not in rec.keys:
                out.append((f"[{ROTATION_PENDING}] {f} is there, but no Box key rotation of roster's made it",
                            "move it away: roster never uses or deletes a key file it didn't make"))
            elif not held:
                out.append((f"[{ROTATION_PENDING}] {f} (the Box key rotation's {'new' if f == new_of(key) else 'old'}"
                            " key) is still on this Box with no Host of this Inventory pending",
                            "run `roster setup --rotate`: it finishes the rotation and deletes the old key"))
    return out


# ---------------------------------------------------------------- one connection, one key

class Unreached(RuntimeError):
    """ssh itself failed (no answer, refused the key, no host key): nothing ran there."""


def one_key_config(m: Member, keys: list[Path]) -> str:
    """A one-Host ssh config for M: its address, user and port, roster's known_hosts for its Inventory (its key must
    be recorded), and only KEYS, offered in order."""
    from .sshops import q
    h = m.h
    out = [f"Host {h['name']}",
           f"    HostName {h['ip'].replace('%', '%%')}",
           f"    User {h['ssh']['user']}",
           f"    Port {h['ssh']['port']}",
           f"    UserKnownHostsFile {q(known_hosts_file(m.inv))}",
           "    StrictHostKeyChecking yes",
           "    BatchMode yes",
           "    ConnectTimeout 10",
           "    ControlMaster no",
           "    ControlPath none",
           "    IdentitiesOnly yes"]
    out += [f"    IdentityFile {q(k)}" for k in keys]
    return "\n".join(out) + "\n"


class Connect:
    """ssh to a Member with exactly the keys given, through a config file of its own (removed after)."""

    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix="roster-rotate-"))

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def config(self, m: Member, keys: list[Path]) -> Path:
        f = self.dir / "config"
        f.write_text(one_key_config(m, keys), encoding="utf-8")
        os.chmod(f, 0o600)
        return f

    def run(self, m: Member, keys: list[Path], command: str, timeout: int = 120) -> subprocess.CompletedProcess:
        conf = self.config(m, keys)
        try:
            return subprocess.run(program_argv(["ssh", "-F", ssh_path(conf), m.name, command]),
                                  stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise Unreached(f"no answer within {timeout} s") from None

    def logs_in(self, m: Member, key: Path) -> tuple[bool, str]:
        from .sshops import LOGIN_PROBE
        try:
            r = self.run(m, [key], LOGIN_PROBE, timeout=40)
        except Unreached as e:
            return False, str(e)
        return r.returncode == 0, (r.stderr.strip().splitlines() or [f"exit {r.returncode}"])[-1][:200]

    def script(self, m: Member, keys: list[Path], posix: str, mode: str, tag_re: str, pub: str = ""):
        """Run the key script (POSIX: the sh script POSIX; Windows: winhost's MODE with TAG_RE and PUB) over KEYS:
        the lines it took (remove), or []; Unreached when ssh failed, RuntimeError when the script did."""
        if is_windows(m.h):
            from . import winhost
            try:
                done = winhost.over_key(m.h, mode, tag_re, pub=pub, ssh_opts=["-F", ssh_path(self.config(m, keys))])
            except RuntimeError as e:
                if str(e).startswith(f"ssh {m.name} failed"):
                    raise Unreached(str(e)) from None
                raise
            return done.tags
        r = self.run(m, keys, "sh -c " + shlex.quote(posix))
        if "ROSTER_OK" in r.stdout:
            return [ln.split()[1] for ln in r.stdout.splitlines() if ln.startswith("ROSTER_TAG ") and len(ln.split()) > 1]
        why = (r.stderr or r.stdout).strip()[:200] or f"exit {r.returncode}"
        if r.returncode == 255:
            raise Unreached(why)
        from . import winhost
        raise RuntimeError(winhost.windows_hint(m.name) if winhost.looks_windows(r.stdout + r.stderr) else why)


# ---------------------------------------------------------------- which keys, which Hosts

def words(pub: Path) -> list[str] | None:
    return boxkeys.public_words(pub)


def group(cfg: dict[str, Any]) -> list[tuple[str | None, dict[str, Any]]]:
    """This run's Inventory, then every other named Inventory one of whose key files is one of this one's (Q188 (d):
    they share this Box's key): rotated together (owner, Q204). One that doesn't load stops the run, since its
    Hosts could hold the key."""
    from . import inventories
    from .config import load_config
    here = current_inventory()
    out: list[tuple[str | None, dict[str, Any]]] = [(here, cfg)]
    if not inventories.list_file().exists():
        return out
    named = inventories.load().inventories
    candidates: list[tuple[str | None, Path]] = [(x.name, x.path) for x in named]
    unnamed = inventories.unnamed_source()      # the unnamed roster.yml this Box's ssh config was written from
    if unnamed is not None and not any(inventories.same_file(x.path, unnamed) for x in named if x.path.exists()):
        candidates.append((None, unnamed))
    mine = {Path(h["key_file"]) for h in cfg["hosts"].values() if h["enroll"]} | {cfg["key"]}
    for name, path in candidates:
        if name == here or not path.exists() or inventories.same_file(path, cfg["path"]):
            continue
        label = name or f"unnamed ({path})"
        try:
            other = load_config(path)
        except SystemExit as e:
            die(f"the Inventory {label}'s roster.yml doesn't load ({str(e.code).removeprefix('error: ')}): its "
                "Hosts may hold this Box's key too, and a rotation does every Inventory that shares the key at once. "
                "Fix it, then run roster setup --rotate")
        theirs = {Path(h["key_file"]) for h in other["hosts"].values() if h["enroll"]} | {other["key"]}
        if mine & theirs:
            out.append((name, other))
    return out


def members(groups) -> list[Member]:
    out = []
    for inv, c in groups:
        for h in sorted(c["hosts"].values(), key=lambda h: h["name"]):
            if h["enroll"] and h["reviewed"]:
                out.append(Member(inv, c, h, Slot(boxkeys.parse(h["key_type"]), Path(h["key_file"]))))
    return out


def comment(slot: Slot, cfg: dict[str, Any]) -> str:
    """The new key's comment: the old key's own when it's a roster tag (so the Box's name, key-name and the Mesh's
    owner stay as they are, Q188/Q175), else this Inventory's tag."""
    import re
    w = (pub_of(slot.key).read_text().split() if pub_of(slot.key).exists() else [])
    tags = "|".join((KEY_TAG,) + LEGACY_KEY_TAGS)
    return w[2] if len(w) == 3 and re.fullmatch(f"(?:{tags}):[A-Za-z0-9_-]+", w[2]) else cfg["tag"]


def make_new(slot: Slot, cfg: dict[str, Any], say) -> None:
    """The new key beside SLOT's (KEY.new), of its type, with the old one's comment."""
    target = new_of(slot.key)
    for f in (target, pub_of(target)):
        f.unlink(missing_ok=True)
    try:
        subprocess.run(program_argv(["ssh-keygen", "-q", *slot.type.keygen_args(), "-N", "", "-C",
                                     comment(slot, cfg), "-f", str(target)]), check=True,
                       stdin=subprocess.DEVNULL, capture_output=True)
    except (OSError, subprocess.CalledProcessError) as e:
        for f in (target, pub_of(target)):
            f.unlink(missing_ok=True)
        die(f"couldn't make the new key {target}: {e} - nothing was changed")
    say(f"new key      {target} ({slot.type.name}), beside {slot.key}")


def copy_private(src: Path, dst: Path) -> None:
    """SRC's bytes to DST, this user's alone (0600) from its first byte."""
    dst.unlink(missing_ok=True)
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(src.read_bytes())


def swap(slot: Slot, entry: dict[str, Any], keep_old: bool) -> None:
    """The new key into SLOT's file. KEEP_OLD: the old one stays as KEY.old (a Host still holds only its line), its
    .pub derived from KEY.old itself (#482's review MED-2: never a copy of KEY.pub); else the old private key is gone
    with the rename. A run killed between the two renames is finished by repair()."""
    key = slot.key
    if keep_old:
        copy_private(key, old_of(key))
        old = boxkeys.derived(old_of(key)) or (entry.get("old") or "").split()
        replace_file(pub_of(old_of(key)), " ".join([*old[:2], entry.get("comment") or ""]).strip() + "\n", 0o644)
    os.replace(pub_of(new_of(key)), pub_of(key))
    os.replace(new_of(key), key)
    boxkeys.stamp(key)
    if not keep_old:
        delete_old(slot)


def delete_old(slot: Slot) -> None:
    """The old private key and its .pub, gone (NIST SP 800-57 Pt 1 r5 §5.5.2: keys destroyed once no longer
    needed; a kept retired key defeats a rotation done because of a leak)."""
    for f in (old_of(slot.key), pub_of(old_of(slot.key))):
        f.unlink(missing_ok=True)


def old_lines_re(m: Member, groups, new_words: list[str]) -> str:
    """This Box's key lines on M that aren't its new key's: each of this Box's public keys but the new one, only those
    boxkeys.all_keys vouches for (KEY.old included only when this user's and its .pub is its own: #482's LOW-4), with
    a roster-managed tag of any Box name. Never a roster-mesh: line."""
    from .sshops import key_ere
    found: list[list[str]] = []
    for _, c in groups:
        for key in boxkeys.all_keys(c):
            w = words(key.pub)
            if w:
                found.append(w)
    alts = dict.fromkeys(key_ere(*w[:2]) for w in found if w[:2] != new_words[:2])
    return "|".join(alts)


def old_keys(m: Member, groups) -> list[Path]:
    """The private keys of this Box that M may still let in (the slot's old one first, then every other type's):
    what the old-key login offers, in order. Never the new one."""
    out = [m.slot.old] if m.slot.old is not None else []
    for _, c in groups:
        for key in boxkeys.all_keys(c):
            if key.key.exists() and key.key != m.slot.new and key.key not in out:
                out.append(key.key)
    return out


# ---------------------------------------------------------------- checking the key files against the record

def own_pair(f: Path, want: Any) -> bool:
    """F is this user's alone, its .pub is its own, and (WANT: `TYPE BASE64`) that's the key the record names."""
    if not (f.exists() and boxkeys.owned(f) and boxkeys.matches(f)):
        return False
    return want is None or (words(pub_of(f)) or [])[:2] == str(want).split()[:2]


def repair(key: Path, entry: dict[str, Any] | None, say=None) -> bool:
    """A swap killed between its two renames (#482's review MED-2), finished: KEY.pub is the new key's already and
    KEY.new (the new private key) has no .pub, so KEY.new goes to KEY; or KEY is the new private key already and
    KEY.new.pub is left, so it goes to KEY.pub. Only when the record names that new key. True when it did one."""
    new = (entry or {}).get("new")
    if not new:
        return False
    want = str(new).split()[:2]
    nk = new_of(key)
    if nk.exists() and not pub_of(nk).exists() and (words(pub_of(key)) or [])[:2] == want \
            and (boxkeys.derived(nk) or [])[:2] == want and boxkeys.owned(nk):
        os.replace(nk, key)
    elif pub_of(nk).exists() and not nk.exists() and (boxkeys.derived(key) or [])[:2] == want:
        os.replace(pub_of(nk), pub_of(key))
    else:
        return False
    boxkeys.stamp(key)
    if say:
        say(f"rotation     finished a swap a run was stopped in the middle of: {key} is the new key")
    return True


def check_files(key: Path, entry: dict[str, Any] | None) -> None:
    """Stop (naming the file) unless KEY.new and KEY.old are what the record says this rotation made (#482's review
    MED-1): never take a file just by its name, never use, swap in or delete one roster didn't make."""
    stray = ": move it away (roster never uses or deletes a key file it didn't make), then run roster setup --rotate"
    for f in (new_of(key), old_of(key)):
        there = f.exists() or pub_of(f).exists()
        if there and entry is None:
            die(f"{f} is there, but no Box key rotation of roster's made it (its record has no rotation of {key})"
                + stray)
        if not there:
            continue
        want = (entry or {}).get("new" if f == new_of(key) else "old")
        if not own_pair(f, want):
            die(f"{f} isn't the key the Box key rotation made (not this user's alone, its .pub isn't its own, or it "
                f"isn't the key the rotation's record names)" + stray)


# ---------------------------------------------------------------- the run

def read_all(groups) -> dict[str | None, Record]:
    out = {}
    for inv, _ in groups:
        try:
            out[inv] = read(inv)
        except Unreadable as e:
            die(f"the Box key rotation's record {e}, so roster can't tell which Hosts still hold the old key or which "
                "key files are the rotation's. Restore it if you can; otherwise move it away, and the key files "
                "beside the key ending .new and .old with it, then run roster setup --rotate (a Host that holds only "
                "the old key's line then needs `roster setup --host NAME`, with its Login's password)")
    return out


def repair_all(cfg: dict[str, Any], say=None) -> None:
    """Plain setup's first step (#482's MED-2): finish a swap a rotation was stopped in the middle of."""
    try:
        rec = read()
    except Unreadable:
        return
    for key, entry in rec.keys.items():
        repair(Path(key), entry, say)


def run(cfg: dict[str, Any], scope: set[str] | None = None, dry_run: bool = False, say=print) -> dict[str, Any]:
    """`roster setup --rotate`: see the module's text. Returns {done: [label], pending: {label: why}, failed: {label:
    why}, notes: {label: note}, groups: [(inv, cfg)]}."""
    from .errors import NEW_KEY_REFUSED
    groups = group(cfg)
    recs = read_all(groups)
    everyone = members(groups)
    entries: dict[str, dict[str, Any]] = {}
    for r in recs.values():
        entries.update(r.keys)
    for key in sorted({m.slot.key for m in everyone} | {c["key"] for _, c in groups}):
        if not dry_run:
            repair(key, entries.get(str(key)), say)
        check_files(key, entries.get(str(key)))
    starting = all(r.empty for r in recs.values())
    others = [inv for inv, _ in groups[1:]]
    if others:
        say(f"shared key   the named Inventor{'y' if len(others) == 1 else 'ies'} {', '.join(map(str, others))} use "
            f"this Box's key too: their Hosts are rotated in this run as well, before any old line goes")
    if starting:
        chosen = [m for m in everyone if scope is None or (m.inv == current_inventory() and m.name in scope)]
        slots = {m.slot.key: m.slot for m in chosen}
        todo = [m for m in everyone if m.slot.key in slots]
    else:
        slots = {m.slot.key: m.slot for m in everyone if str(m.slot.key) in entries}
        todo = [m for m in everyone if m.name in recs[m.inv].pending and str(m.slot.key) in entries]
    fresh = {k for k, slot in slots.items() if starting and not slot.key.exists()}
    if fresh and not any(old_keys(m, groups) for m in todo if m.slot.key in fresh):
        die(f"this Box has no key at {', '.join(map(str, sorted(fresh)))} yet, nor any other to log in with, so "
            "there's nothing to rotate: `roster setup` makes it and puts it on the Hosts")
    if not todo:
        if starting:
            say("rotation     no Box key rotation to do: no key Host here")
        elif not dry_run:   # no Host of roster.yml holds the old key now (the pending ones left it): it's done
            say("rotation     no Host the Box key rotation was pending on is in roster.yml now: finishing it")
            for slot in slots.values():
                if not slot.swapped:    # never made the key: the new one (the record's own) goes, the key stays
                    for f in (new_of(slot.key), pub_of(new_of(slot.key))):
                        f.unlink(missing_ok=True)
                delete_old(slot)
            for inv, _ in groups:
                write(Record(), inv)
            sync(groups, say)
        return {"done": [], "pending": {}, "failed": {}, "notes": {}, "groups": groups}
    now = [m for m in todo if scope is None or (m.inv == current_inventory() and m.name in scope)]
    later = [m for m in todo if m not in now]
    word = "start" if starting else "finish"
    say(f"rotation     {word} the Box key rotation: {', '.join(f'{s.key} ({s.type.name})' for s in slots.values())}, "
        f"on {len(now)} Host{'' if len(now) == 1 else 's'} now, one at a time"
        + (f"; {len(later)} more stay pending (not in --host)" if later else ""))
    if dry_run:
        for m in now:
            say(f"  would rotate the Box key on {m.label}")
        say("dry run: nothing was changed")
        return {"done": [], "pending": {}, "failed": {}, "notes": {}, "groups": groups}

    def save_all():
        for inv, _ in groups:
            recs[inv].keys = {k: v for k, v in entries.items() if Path(k) in slots}
            write(recs[inv], inv)

    if starting:
        # the record first (MED-1): which key files this rotation makes .new and .old of, before either exists
        for key, slot in slots.items():
            old = words(pub_of(key)) if key.exists() else None
            entries[str(key)] = {"type": slot.type.name, "old": " ".join(old[:2]) if old else None, "new": None,
                                 "comment": comment(slot, cfg)}
        for m in todo:
            recs[m.inv].pending[m.name] = "the new Box key isn't on it yet"
        for m in later:
            recs[m.inv].pending[m.name] = "not in this run (--host)"
        save_all()
        from .sshops import ensure_key
        for key, slot in slots.items():
            if key in fresh:     # a type its Hosts didn't use yet (key_type: changed): its first key is the new one
                ensure_key(boxkeys.BoxKey(slot.type, key), cfg["tag"])
            else:
                make_new(slot, cfg, say)
            entries[str(key)]["new"] = " ".join((words(pub_of(slot.new)) or [])[:2]) or None
        save_all()
    for key, slot in slots.items():     # a run stopped right after making it: the record learns the new key now
        if not entries[str(key)].get("new") and own_pair(slot.new, None):
            entries[str(key)]["new"] = " ".join((words(pub_of(slot.new)) or [])[:2])
            save_all()

    conn = Connect()
    failed: dict[Member, str] = {}
    proven: list[Member] = []
    try:
        news = {key: str(entries[str(key)]["new"]).split() for key in slots}
        for m in now:                            # pass 1: the new line on, and proven, Host by Host
            new = m.slot.new
            if not starting and conn.logs_in(m, new)[0]:
                proven.append(m)
                continue
            from .sshops import add_key_script, key_ere
            line = f"{news[m.slot.key][0]} {news[m.slot.key][1]} {m.cfg['tag']}"    # its Inventory's own name
            this = key_ere(*line.split()[:2])
            keys = old_keys(m, groups)
            if not keys:
                recs[m.inv].pending[m.name] = ("no old key of this Box's is left to log in with: `roster setup --host "
                                               f"{m.name}` installs the new one with its Login's password")
                continue
            try:
                conn.script(m, keys, add_key_script(line, this, m.h["ssh"]["user"]), "add", this, pub=line)
            except Unreached as e:
                recs[m.inv].pending[m.name] = f"not reached with the old key: {e}"
                say(f"  pending  {m.label}: not reached with the old key: {e}")
                continue
            except RuntimeError as e:
                failed[m] = f"[{NEW_KEY_REFUSED}] couldn't add the new key's line: {e}"
                continue
            ok, why = conn.logs_in(m, new)
            if not ok:
                failed[m] = (f"[{NEW_KEY_REFUSED}] the new key's line went in, but the new key doesn't log in "
                             f"({why}); the old key's line stays there")
                continue
            proven.append(m)
        for m in proven:
            recs[m.inv].refused = [n for n in recs[m.inv].refused if n != m.name]
        for m, why in failed.items():
            recs[m.inv].pending[m.name] = why
            recs[m.inv].refused.append(m.name)
            say(f"  FAIL     {m.label}: {why}")
        # a Host that refused it, this run or an earlier one, and isn't proven now holds the swap back
        unproven = [m for m in todo if m.name in recs[m.inv].refused and m not in proven
                    and not entries[str(m.slot.key)].get("swapped")]
        if failed or unproven:
            names = ", ".join(m.label for m in (list(failed) or unproven))
            say(f"rotation     stopped: {names} refused the new key{'' if failed else ' (an earlier run)'} and "
                "hasn't proven it since, so no old key line was taken off anywhere and the old key stays this Box's "
                "key (fix that, then run roster setup --rotate again)")
            save_all()
            return {"done": [], "pending": labels(recs, groups),
                    "failed": {m.label: w for m, w in failed.items()} or
                              {m.label: recs[m.inv].pending.get(m.name, "refused the new key") for m in unproven},
                    "notes": {}, "groups": groups}

        # every Host reached proved the new key: it becomes the key, the old kept while a Host still needs it
        for key, slot in slots.items():
            if not slot.swapped:
                swap(slot, entries[str(key)], keep_old=True)
            entries[str(key)]["swapped"] = True
        save_all()
        sync(groups, say)
        done, notes = [], {}
        for m in proven:                         # pass 2: the old lines off, over the new key
            from .sshops import remove_key_script
            ere = old_lines_re(m, groups, news[m.slot.key])
            try:
                taken = conn.script(m, [m.slot.key], remove_key_script(ere, m.h["ssh"]["user"]), "remove", ere) \
                    if ere else []
            except (Unreached, RuntimeError) as e:
                recs[m.inv].pending[m.name] = f"the new key works, but the old key's line couldn't be taken off: {e}"
                say(f"  FAIL     {m.label}: {recs[m.inv].pending[m.name]}")
                continue
            recs[m.inv].pending.pop(m.name, None)
            done.append(m)
            say(f"  ok       {m.label}")
            if not taken:
                notes[m.label] = ("the new key works there, and no roster-managed line of the old key was in its key "
                                  "file (a line written by hand, or one roster doesn't manage, such as ESXi's "
                                  "/etc/ssh/keys-root of another account): if the old key still logs in there, "
                                  "remove its line by hand")
                say(f"  note     {m.label}: {notes[m.label]}")
    finally:
        conn.close()
    held = {m.slot.key for m in todo if m.name in recs[m.inv].pending}
    for key, slot in list(slots.items()):       # no Host still needs it: the old private key goes, and its entry
        if key not in held:
            delete_old(slot)
            del slots[key]
    save_all()
    sync(groups, say)
    return {"done": [m.label for m in done], "pending": labels(recs, groups), "failed": {}, "notes": notes,
            "groups": groups}


def labels(recs, groups) -> dict[str, str]:
    here = current_inventory()
    return {(n if inv == here else f"{inv or '(unnamed)'}: {n}"): why for inv, _ in groups
            for n, why in sorted(recs[inv].pending.items())}


def sync(groups, say) -> None:
    """Each Inventory's ssh config, written again: its Hosts' key now, and the old one too where pending."""
    from .common import current_config_path, use_inventory
    from .sshops import write_ssh_config
    here, path = current_inventory(), current_config_path()
    for inv, c in groups:
        if inv == here:
            write_ssh_config(c)
            continue
        use_inventory(inv, c["path"])
        try:
            write_ssh_config(c)
        finally:
            use_inventory(here, path)
