"""The Box key rotation's state on this Box (T240, #469, decision Q204): its record per Inventory (the Hosts it hasn't
finished on, the key files it's rotating), the key files beside each key (KEY.new, KEY.old), and what the ssh config
offers a Host while the rotation is pending there. The run itself (`roster setup --rotate`) is rotate.py's."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import boxkeys
from .common import die, write_private
from .context import Context, current
from .errors import ROTATION_PENDING, Problem


def new_of(key: Path) -> Path:
    return Path(str(key) + ".new")


def old_of(key: Path) -> Path:
    return Path(str(key) + ".old")


def pub_of(key: Path) -> Path:
    return Path(str(key) + ".pub")


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


def read(ctx: Context | None = None) -> Record:
    """The record of the Inventory CTX (default: this run's): an empty one when there's no file; Unreadable when
    there's one roster can't read."""
    f = (ctx or current()).rotation
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


def write(rec: Record, ctx: Context | None = None) -> None:
    f = (ctx or current()).rotation
    if rec.empty:
        f.unlink(missing_ok=True)
        return
    write_private(f, json.dumps({"pending": dict(sorted(rec.pending.items())), "keys": rec.keys,
                                "refused": sorted(set(rec.refused))}, indent=1) + "\n")


def load(ctx: Context | None = None) -> dict[str, str]:
    """The Hosts (name: why) of the Inventory CTX the rotation hasn't finished on; empty when none (or unreadable:
    problems() says so)."""
    try:
        return read(ctx).pending
    except Unreadable:
        return {}


def pending(cfg: dict[str, Any]) -> dict[str, str]:
    """This run's Inventory's Hosts the rotation is pending on (name: why), those still in roster.yml."""
    return {n: why for n, why in load().items() if n in cfg["hosts"]}


def forget(names, ctx: Context | None = None, everything: bool = False) -> None:
    """revoke took this Box's key off NAMES (#482's review LOW-3): they hold neither key now. EVERYTHING: every Host
    of the Inventory lost it, so the record goes (the key files are revoke's to name for deletion)."""
    try:
        rec = read(ctx)
    except Unreadable:
        if everything:
            (ctx or current()).rotation.unlink(missing_ok=True)
        return
    if everything:
        write(Record(), ctx)
        return
    for n in names:
        rec.pending.pop(n, None)
    rec.refused = [n for n in rec.refused if n not in set(names)]
    write(rec, ctx)


ALL = object()     # identity_files: every Host (the record can't be read, or a kept old key has no record)


def config_waiting(cfg: dict[str, Any], ctx: Context | None = None) -> Any:
    """The Hosts of the Inventory CFG (CTX: its context, default this run's) whose ssh config block offers the old key
    too: the pending ones, or ALL when roster can't tell (an unreadable record, or a kept KEY.old with no record of
    its rotation: fail closed, #482's LOW-1)."""
    try:
        rec = read(ctx)
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


def problems(cfg: dict[str, Any]) -> list[Problem]:
    """What's wrong with this Inventory's rotation state besides pending Hosts, each a ROTATION_PENDING Problem with
    its fix: an unreadable record (LOW-1), and a KEY.new or KEY.old with no Host pending or no record of its rotation
    (LOW-2, MED-1). Read-only: check, check --box and setup report them."""
    out: list[Problem] = []
    try:
        rec = read()
    except Unreadable as e:
        return [Problem(ROTATION_PENDING, f"the Box key rotation's record {e}: roster can't tell which Hosts still "
                                          "hold the old Box key, so this Box's ssh config offers every Host both keys",
                        fix="run `roster setup --rotate`, which says what to do; restore the file if you have it")]
    keys = sorted({Path(h["key_file"]) for h in cfg["hosts"].values() if h["enroll"]} | {cfg["key"]})
    held = [n for n in rec.pending if n in cfg["hosts"]]
    for key in keys:
        for f in (new_of(key), old_of(key)):
            if not (f.exists() or pub_of(f).exists()):
                continue
            if str(key) not in rec.keys:
                out.append(Problem(ROTATION_PENDING, f"{f} is there, but no Box key rotation of roster's made it",
                                   fix="move it away: roster never uses or deletes a key file it didn't make"))
            elif not held:
                out.append(Problem(ROTATION_PENDING, f"{f} (the Box key rotation's "
                                   f"{'new' if f == new_of(key) else 'old'} key) is still on this Box with no Host of "
                                   "this Inventory pending",
                                   fix="run `roster setup --rotate`: it finishes the rotation and deletes the old key"))
    return out


def swap_done(key: Path, entry: dict[str, Any]) -> bool:
    """Is the swap of KEY done? The record says so, or (a run stopped between the swap and the record's write) KEY
    itself is the record's new key and KEY.new is gone."""
    if entry.get("swapped"):
        return True
    new = str(entry.get("new") or "").split()[:2]
    return bool(new) and not new_of(key).exists() and (boxkeys.derived(key) or [])[:2] == new


def own_pair(f: Path, want: Any) -> bool:
    """F is this user's alone, its .pub is its own, and (WANT: `TYPE BASE64`) that's the key the record names."""
    if not (f.exists() and boxkeys.owned(f) and boxkeys.matches(f)):
        return False
    return want is None or (boxkeys.public_words(pub_of(f)) or [])[:2] == str(want).split()[:2]


def repair(key: Path, entry: dict[str, Any] | None, say=None) -> bool:
    """A swap killed between its two renames (#482's review MED-2), finished: KEY.pub is the new key's already and
    KEY.new (the new private key) has no .pub, so KEY.new goes to KEY; or KEY is the new private key already and
    KEY.new.pub is left, so it goes to KEY.pub. Only when the record names that new key. True when it did one."""
    new = (entry or {}).get("new")
    if not new:
        return False
    want = str(new).split()[:2]
    nk = new_of(key)
    if nk.exists() and not pub_of(nk).exists() and (boxkeys.public_words(pub_of(key)) or [])[:2] == want \
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


def repair_all(cfg: dict[str, Any], say=None) -> None:
    """Plain setup's first step (#482's MED-2): finish a swap a rotation was stopped in the middle of."""
    try:
        rec = read()
    except Unreadable:
        return
    for key, entry in rec.keys.items():
        repair(Path(key), entry, say)
