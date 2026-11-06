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
   pending record (rotation.py, beside key-name, never mesh.json), and while any is, the old key stays as
   `.old` and the ssh config offers both keys there (new, then old), so `ssh NAME` and the Mesh still log in. Once
   none is, the old private key and its `.pub` are deleted. A re-run (`setup --rotate` again) finishes the pending
   Hosts. `roster check` and `check --box` report them until then (#471's LOW-5: a cleanup that failed never
   looks done).

Every connection here uses a one-Host ssh config of its own (`ssh -F`, the Host's address, user, port and
roster's known_hosts, exactly one key, IdentitiesOnly), so the proof is that key and nothing else, and named
Inventories that share the key file (rotated together, Q204) are reached at their own address."""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import boxkeys, keyline, sshconfig, winhost
from .authorized import add_key_script, key_named, remove_key_script
from .common import die, program_argv, replace_file, ssh_path
from .config import load_config
from .context import WINDOWS, Context, current
from .errors import NEW_KEY_REFUSED, UNKNOWN_HOST, InventoryError, Problem, tagged
from .hosts import account, is_windows
from .keyline import key_ere
from .rotation import (
    Record,
    Unreadable,
    check_files,
    new_of,
    old_of,
    own_pair,
    pub_of,
    read,
    repair,
    swap_done,
    write,
)
from .sshconfig import token_path
from .sshops import LOGIN_PROBE, write_ssh_config


@dataclass(eq=False)
class Slot:
    """One of this Box's key files (KEY), and where its new and old key are now: before the swap the new one is
    KEY.new and the old one KEY itself; after it, the new one is KEY and the old one KEY.old (while it's kept).
    DONE: whether the swap is done, as the rotation's record says (#482's second pass, P1: never guessed from KEY.new
    being absent, which before ssh-keygen ran would make KEY, the old key, the new one); None outside a rotation."""

    type: boxkeys.KeyType
    key: Path
    done: bool | None = None

    @property
    def swapped(self) -> bool:
        return self.done if self.done is not None else not new_of(self.key).exists()

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
    """A key Host of one of the Inventories rotated together: CTX (its Inventory) and its key."""

    ctx: Context
    cfg: dict[str, Any]
    h: dict[str, Any]
    slot: Slot

    @property
    def name(self) -> str:
        return self.h["name"]

    @property
    def label(self) -> str:
        return label(self.ctx, self.name)


# ---------------------------------------------------------------- one connection, one key

class Unreached(RuntimeError):
    """ssh itself failed (no answer, refused the key, no host key): nothing ran there."""


# T253 item 3: the user's own ssh options a Host may need to be reached at all (an old sshd's algorithms, a jump
# host), as `ssh -G NAME` says `ssh NAME` uses them. Never the ones that choose the key, the account, the address or
# the host keys trusted: those stay roster's, so the proof is exactly the key meant.
CARRIED = {"hostkeyalgorithms": "HostKeyAlgorithms", "pubkeyacceptedalgorithms": "PubkeyAcceptedAlgorithms",
           "kexalgorithms": "KexAlgorithms", "ciphers": "Ciphers", "macs": "MACs"}
ALGORITHMS_RE = re.compile(r"[A-Za-z0-9@.,_+^-]+\Z")
JUMP_RE = re.compile(r"[A-Za-z0-9@.,:_\[\]/=-]+\Z")         # [user@]host[:port] or ssh://… hops, comma-separated
PRINTABLE_RE = re.compile(r"[^\x00-\x1f\x7f]+\Z")


def user_options(name: str) -> dict[str, str]:
    """What the user's own ssh config gives NAME (`ssh -G NAME`: {option, lowercase: value}); {} when ssh can't say.
    Nothing connects."""
    try:
        r = subprocess.run(program_argv(["ssh", "-G", name]), stdin=subprocess.DEVNULL, capture_output=True,
                           text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return {}
    out: dict[str, str] = {}
    for line in r.stdout.splitlines() if r.returncode == 0 else []:
        k, _, v = line.partition(" ")
        out.setdefault(k.lower(), v.strip())
    return out


def carried(seen: dict[str, str]) -> list[tuple[str, object]]:
    """The options of SEEN (user_options) the rotation's connection takes on: CARRIED's, when each is an algorithm
    list; the user's ProxyCommand; a ProxyJump as a ProxyCommand that runs ssh with the user's own config (ssh would
    look the jump host up in roster's one-Host file, which knows only the Host)."""
    out: list[tuple[str, object]] = [(kw, seen[k]) for k, kw in CARRIED.items()
                                     if ALGORITHMS_RE.match(seen.get(k, ""))]
    command, jump = seen.get("proxycommand", "none"), seen.get("proxyjump", "none")
    if command.lower() != "none" and PRINTABLE_RE.match(command):
        out.append(("ProxyCommand", command))
    elif jump.lower() != "none" and JUMP_RE.match(jump):
        *via, last = jump.split(",")
        target = "[%h]:%p" if WINDOWS else "'[%h]:%p'"
        out.append(("ProxyCommand", "ssh -o BatchMode=yes" + (f" -J {','.join(via)}" if via else "")
                    + f" -W {target} {last}"))
    return out


def one_key_config(m: Member, keys: list[Path], seen: dict[str, str] | None = None) -> str:
    """A one-Host ssh config for M: its address, user and port, roster's known_hosts for its Inventory (its key must
    be recorded), only KEYS, offered in order, and the user's own options that reach it (carried(); SEEN: what
    user_options says, asked when not given)."""
    h = m.h
    opts: list[tuple[str, object]] = [
        ("HostName", h["ip"]), ("User", h["ssh"]["user"]), ("Port", h["ssh"]["port"]),
        ("UserKnownHostsFile", token_path(m.ctx.known_hosts)), ("StrictHostKeyChecking", "yes"),
        ("BatchMode", "yes"), ("ConnectTimeout", 10), ("ControlMaster", "no"), ("ControlPath", "none"),
        ("IdentitiesOnly", "yes"), *[("IdentityFile", token_path(k)) for k in keys],
        *carried(user_options(m.name) if seen is None else seen)]
    return "\n".join(sshconfig.host_block(h["name"], opts)) + "\n"


class Connect:
    """ssh to a Member with exactly the keys given, through a config file of its own (removed after)."""

    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="roster-rotate-"))
        self.seen: dict[str, dict[str, str]] = {}          # user_options per Host name, asked once a run

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def config(self, m: Member, keys: list[Path]) -> Path:
        f = self.dir / "config"
        if m.name not in self.seen:
            self.seen[m.name] = user_options(m.name)
        f.write_text(one_key_config(m, keys, self.seen[m.name]), encoding="utf-8")
        os.chmod(f, 0o600)
        return f

    def run(self, m: Member, keys: list[Path], command: str, timeout: int = 120) -> subprocess.CompletedProcess[str]:
        conf = self.config(m, keys)
        try:
            return subprocess.run(program_argv(["ssh", "-F", ssh_path(conf), m.name, command]),
                                  stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise Unreached(f"no answer within {timeout} s") from None

    def logs_in(self, m: Member, key: Path) -> tuple[bool, str]:
        try:
            r = self.run(m, [key], LOGIN_PROBE, timeout=40)
        except Unreached as e:
            return False, str(e)
        return r.returncode == 0, (r.stderr.strip().splitlines() or [f"exit {r.returncode}"])[-1][:200]

    def script(self, m: Member, keys: list[Path], posix: str, mode: str, tag_re: str, pub: str = "") -> list[str]:
        """Run the key script (POSIX: the sh script POSIX; Windows: winhost's MODE with TAG_RE and PUB) over KEYS:
        the lines it took (remove), or []; Unreached when ssh failed, RuntimeError when the script did."""
        if is_windows(m.h):
            try:
                done = winhost.over_key(m.h, mode, tag_re, pub=pub, ssh_opts=["-F", ssh_path(self.config(m, keys))])
            except winhost.SshFailed as e:
                raise Unreached(str(e)) from None
            return done.tags
        r = self.run(m, keys, "sh -c " + shlex.quote(posix))
        said = keyline.said(r.stdout)
        if said.ok:
            return said.names
        why = (r.stderr or r.stdout).strip()[:200] or f"exit {r.returncode}"
        if r.returncode == 255:
            raise Unreached(why)
        raise winhost.windows_hint(m.name) if winhost.looks_windows(r.stdout + r.stderr) else RuntimeError(why)


# ---------------------------------------------------------------- which keys, which Hosts

Groups = list[tuple[Context, dict[str, Any]]]


@dataclass
class KeyUser:
    """Another Inventory on this Box: CTX (its name and roster.yml), its LABEL, its CFG (None when its roster.yml
    doesn't load: ERROR says why), and the key files of this Inventory's it uses too (SHARED)."""

    ctx: Context
    label: str
    cfg: dict[str, Any] | None
    shared: set[Path]
    error: str = ""


def key_users(cfg: dict[str, Any]) -> list[KeyUser]:
    """Every other Inventory on this Box (the named ones, and the unnamed one this Box's ssh config was written from):
    who shares this Box's key files (Q188 (d)). A rotation's group, and revoke's list of files to delete (T245)."""
    from . import named  # Pydantic: only once it's used, never at roster's start
    here = current()
    if not named.list_file().exists():
        return []
    mine = {Path(h["key_file"]) for h in cfg["hosts"].values() if h["enroll"]} | {cfg["key"]}
    out: list[KeyUser] = []
    for name, path in named.every_inventory():
        if name == here.name or not path.exists() or named.same_file(path, cfg["path"]):
            continue
        label = name or f"unnamed ({path})"
        try:
            other = load_config(path)
        except InventoryError as e:
            out.append(KeyUser(Context(name, path), label, None, set(), e.message))
            continue
        theirs = {Path(h["key_file"]) for h in other["hosts"].values() if h["enroll"]} | {other["key"]}
        out.append(KeyUser(Context(name, path), label, other, mine & theirs))
    return out


def entries_elsewhere(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """The key Host entries of every other Inventory on this Box that loads (key_users): one may be on an account
    of this Inventory's under another name or key type (T253 item 4, Q200 (c)), and its line there is its own."""
    return [h for u in key_users(cfg) if u.cfg is not None for h in u.cfg["hosts"].values() if h["enroll"]]


def group(cfg: dict[str, Any]) -> list[tuple[Context, dict[str, Any]]]:
    """This run's Inventory, then every other named Inventory one of whose key files is one of this one's (Q188 (d):
    they share this Box's key): rotated together (owner, Q204), each with its context. One that doesn't load stops
    the run, since its Hosts could hold the key."""
    out: list[tuple[Context, dict[str, Any]]] = [(current(), cfg)]
    for u in key_users(cfg):
        if u.cfg is None:
            die(f"the Inventory {u.label}'s roster.yml doesn't load ({u.error}): its "
                "Hosts may hold this Box's key too, and a rotation does every Inventory that shares the key at once. "
                "Fix it, then run roster setup --rotate")
        if u.shared:
            out.append((u.ctx, u.cfg))
    return out


def members(groups: Groups) -> list[Member]:
    """Every key Host of GROUPS, those of one key file sharing its one Slot."""
    out: list[Member] = []
    slots: dict[Path, Slot] = {}
    for ctx, c in groups:
        for h in sorted(c["hosts"].values(), key=lambda h: h["name"]):
            if h["enroll"] and h["reviewed"]:
                key = Path(h["key_file"])
                slot = slots.setdefault(key, Slot(boxkeys.parse(h["key_type"]), key))
                out.append(Member(ctx, c, h, slot))
    return out


def comment(slot: Slot, cfg: dict[str, Any]) -> str:
    """The new key's comment: the old key's own when it's a roster tag (so the Box's name, key-name and the Mesh's
    owner stay as they are, Q188/Q175), else this Inventory's tag."""
    w = (pub_of(slot.key).read_text().split() if pub_of(slot.key).exists() else [])
    return w[2] if len(w) == 3 and keyline.tag_box(w[2]) else cfg["tag"]


def make_new(slot: Slot, cfg: dict[str, Any], say: Callable[[str], None]) -> None:
    """The new key beside SLOT's (KEY.new), of its type, with the old one's comment."""
    target = new_of(slot.key)
    for f in (target, pub_of(target)):
        f.unlink(missing_ok=True)
    try:
        boxkeys.generate(slot.type, target, comment(slot, cfg))
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
        replace_file(pub_of(old_of(key)), " ".join([*old[:2], entry.get("comment") or ""]).strip() + "\n", 0o644,
                     follow=False)
    os.replace(pub_of(new_of(key)), pub_of(key))
    os.replace(new_of(key), key)
    boxkeys.stamp(key)
    if not keep_old:
        delete_old(slot)


def delete_old(slot: Slot) -> None:
    """The old private key and its .pub, gone (NIST SP 800-57 Pt 1 r5 §5.5.2: keys destroyed once no longer
    needed; a kept retired key defeats a rotation done because of a leak)."""
    boxkeys.destroy(old_of(slot.key))


def retire_keys(cfg: dict[str, Any], say: Callable[[str], None]) -> list[Path]:
    """T253 item 5: delete each roster_<type> key of this Box's (boxkeys.all_keys beside key_path:) that nothing needs
    now: no Inventory on this Box makes it its own key (key_path:) or gives a key Host its type, no Host holds its
    line as roster last left them (boxkeys.installed, every Inventory's), and no Box key rotation is under way. Only
    a key this Box vouches for whose comment is a roster tag (a key of the user's own is never deleted), and nothing
    at all while another Inventory doesn't load or a rotation record can't be read: roster can't tell then. The
    keys deleted (said)."""
    users = key_users(cfg)
    if any(u.cfg is None for u in users):
        return []
    inventories = [(current(), cfg), *((u.ctx, u.cfg) for u in users if u.cfg is not None)]
    needed: set[Path] = set()
    for ctx, c in inventories:
        try:
            if not read(ctx).empty:
                return []
        except Unreadable:
            return []
        needed.add(c["key"])
        needed |= {Path(h["key_file"]) for h in c["hosts"].values() if h["enroll"]}
        for types in boxkeys.installed(ctx).values():
            needed |= {boxkeys.key_file(c["key"], c["key_type"], t) for t in types}
    out: list[Path] = []
    for k in boxkeys.all_keys(cfg):
        if k.key in needed or k.key.name.endswith((".new", ".old")) or k.key.name != k.type.file_name \
                or new_of(k.key).exists() or old_of(k.key).exists() or not boxkeys.vouched(k, cfg["key"]):
            continue
        words = pub_of(k.key).read_text(encoding="utf-8", errors="replace").split()
        if len(words) < 3 or not keyline.tag_box(words[2]):
            continue
        boxkeys.destroy(k.key)
        out.append(k.key)
        say(f"retired key  {k.key} ({k.type.name}): no Host of any Inventory on this Box uses or holds it now, so "
            "roster deleted it")
    return out


def old_lines_re(m: Member, groups: Groups, new_words: list[str], abandoned: list[str] | None = None,
                 kept: list[list[str]] | None = None) -> str:
    """This Box's key lines on M that aren't its new key's: each of this Box's public keys but the new one, only those
    boxkeys.all_keys vouches for (KEY.old included only when this user's and its .pub is its own: #482's LOW-4), and
    the rotation's own earlier new keys whose file went away (ABANDONED, `TYPE BASE64` as the record names them: T253
    item 1), with a roster-managed tag of any Box name. Never a roster-mesh: line, nor one of KEPT's keys (the ones
    another Host entry on M's account logs in with: T253 item 4)."""
    found: list[list[str]] = [w for w in (str(a).split()[:2] for a in abandoned or []) if len(w) == 2]
    for _, c in groups:
        for key in boxkeys.all_keys(c):
            w = boxkeys.public_words(key.pub)
            if w:
                found.append(w)
    keep = [new_words[:2], *(w[:2] for w in kept or [])]
    alts = dict.fromkeys(key_ere(*w[:2]) for w in found if w[:2] not in keep)
    return "|".join(alts)


def kept_keys(m: Member, groups: Groups, elsewhere: list[dict[str, Any]], rotated: set[Path]) -> list[list[str]]:
    """The public keys another Host entry on M's account (hosts.account) logs in with, in any Inventory on this Box,
    of the key files this run doesn't rotate (ROTATED): their lines there are theirs (T253 item 4, as T258's)."""
    out: list[list[str]] = []
    for o in [h for _, c in groups for h in c["hosts"].values()] + elsewhere:
        if o is m.h or not o["enroll"] or account(o) != account(m.h) or Path(o["key_file"]) in rotated:
            continue
        w = boxkeys.public_words(pub_of(Path(o["key_file"])))
        if w:
            out.append(w[:2])
    return out


def old_keys(m: Member, groups: Groups) -> list[Path]:
    """The private keys of this Box that M may still let in (the slot's old one first, then every other type's):
    what the old-key login offers, in order. Never the new one."""
    out = [m.slot.old] if m.slot.old is not None else []
    for _, c in groups:
        for key in boxkeys.all_keys(c):
            if key.key.exists() and key.key != m.slot.new and key.key not in out:
                out.append(key.key)
    return out


# ---------------------------------------------------------------- the run

def read_all(groups: Groups) -> dict[Context, Record]:
    out: dict[Context, Record] = {}
    for ctx, _ in groups:
        try:
            out[ctx] = read(ctx)
        except Unreadable as e:
            die(f"the Box key rotation's record {e}, so roster can't tell which Hosts still hold the old key or which "
                "key files are the rotation's. Restore it if you can; otherwise move it away, and the key files "
                "beside the key ending .new and .old with it, then run roster setup --rotate (a Host that holds only "
                "the old key's line then needs `roster setup --host NAME`, with its Login's password)")
    return out


def hosts_for(cfg: dict[str, Any], host: str | None, key_type: str | None) -> set[str] | None:
    """The Hosts `setup --rotate [--host NAME] [--key-type T]` covers (None: every Host), or it stops: an unknown
    NAME, a key type roster.yml doesn't give them, a Box whose key lines carry another name."""
    hosts: set[str] | None = None
    if host is not None:
        if host in cfg["hosts"]:
            hosts = {host}
        elif host in cfg["groups"]:
            hosts = {n for n, h in cfg["hosts"].items() if h["group"] == host}
        else:
            die(f"unknown host or group {host!r} (see `roster hosts`): setup --rotate --host takes a Host or a "
                "group", code=UNKNOWN_HOST)
    if key_type:
        try:
            kt = boxkeys.parse(key_type).name
        except ValueError as e:
            die(f"--key-type: {e}")
        other = sorted(n for n, h in cfg["hosts"].items() if h["enroll"] and h["reviewed"] and (hosts is None or n in
                       hosts) and h["key_type"] != kt)
        if other:
            die(f"--key-type {kt} with --rotate: roster.yml gives {', '.join(other)} another key type. Set key_type: "
                f"{kt} in roster.yml (on them, their group or defaults), then run roster setup --rotate: one pass "
                "makes the new key of that type, proves it, and takes the old type's lines off (a type for this "
                "run only would come back at the next sync and lock them out, Q200 (e))")
    was = key_named(cfg)
    if was not in (None, cfg["box"]):
        die(f"this Box's key lines carry the name {was}, not {cfg['box']} (box_name:, or the hostname, changed): run "
            "`roster setup` first (it re-tags them), then roster setup --rotate. A rotation never renames the Box")
    return hosts


def run(cfg: dict[str, Any], scope: set[str] | None = None, dry_run: bool = False,
        say: Callable[[str], None] = print) -> dict[str, Any]:
    """`roster setup --rotate`: see the module's text. Returns {done: [label], pending: {label: why}, failed: {label:
    why}, notes: {label: note}, groups: [(inv, cfg)]}."""
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
    others = [ctx.name for ctx, _ in groups[1:]]
    if others:
        say(f"shared key   the named Inventor{'y' if len(others) == 1 else 'ies'} {', '.join(map(str, others))} use "
            f"this Box's key too: their Hosts are rotated in this run as well, before any old line goes")
    if starting:
        chosen = [m for m in everyone if scope is None or (m.ctx == current() and m.name in scope)]
        slots = {m.slot.key: m.slot for m in chosen}
        todo = [m for m in everyone if m.slot.key in slots]
    else:
        slots = {m.slot.key: m.slot for m in everyone if str(m.slot.key) in entries}
        todo = [m for m in everyone if m.name in recs[m.ctx].pending and str(m.slot.key) in entries]
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
                if not swap_done(slot.key, entries[str(slot.key)]):    # never swapped: the new one goes, the key stays
                    for f in (new_of(slot.key), pub_of(new_of(slot.key))):
                        f.unlink(missing_ok=True)
                delete_old(slot)
            for ctx, _ in groups:
                write(Record(), ctx)
            sync(groups, say)
        return {"done": [], "pending": {}, "failed": {}, "notes": {}, "groups": groups}
    now = [m for m in todo if scope is None or (m.ctx == current() and m.name in scope)]
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
        for ctx, _ in groups:
            recs[ctx].keys = {k: v for k, v in entries.items() if Path(k) in slots}
            write(recs[ctx], ctx)

    if starting:
        # the record first: which key files this rotation makes .new and .old of, before either exists
        for key, slot in slots.items():
            old = boxkeys.public_words(pub_of(key)) if key.exists() else None
            entries[str(key)] = {"type": slot.type.name, "old": " ".join(old[:2]) if old else None, "new": None,
                                 "comment": comment(slot, cfg)}
        for m in todo:
            recs[m.ctx].pending[m.name] = "the new Box key isn't on it yet"
        for m in later:
            recs[m.ctx].pending[m.name] = "not in this run (--host)"
        save_all()
        for key, slot in slots.items():
            if key in fresh:     # a type its Hosts didn't use yet (key_type: changed): its first key is the new one
                boxkeys.ensure_key(boxkeys.BoxKey(slot.type, key), cfg["tag"])
                entries[str(key)]["swapped"] = True
            else:
                make_new(slot, cfg, say)
            slot.done = key in fresh
            entries[str(key)]["new"] = " ".join((boxkeys.public_words(pub_of(slot.new)) or [])[:2]) or None
        save_all()
    for key, slot in slots.items():
        entry = entries[str(key)]
        slot.done = swap_done(key, entry)
        if not slot.done and not new_of(key).exists():
            # stopped before ssh-keygen wrote it (or it was moved away): make it again, never take KEY for it
            if entry.get("new"):
                # T253 item 1 (#482's C4): it may have been moved aside, not deleted, and its line is on the Hosts
                # it reached: the record keeps it, and its lines go with the old key's
                entry["abandoned"] = sorted({*entry.get("abandoned", []), str(entry["new"])})
                say(f"rotation     the rotation's new key {new_of(key)} isn't there any more: making another. A "
                    "Host it reached may hold its line, which still logs in for whoever kept that file: its line "
                    "is taken off with the old key's")
            make_new(slot, cfg, say)
            entry["new"] = " ".join((boxkeys.public_words(pub_of(new_of(key))) or [])[:2]) or None
            save_all()
        elif not slot.done and not entry.get("new") and own_pair(new_of(key), None):
            entry["new"] = " ".join((boxkeys.public_words(pub_of(new_of(key))) or [])[:2])     # stopped right after making it
            save_all()
        # the line that goes on the Hosts is the key's own (derived from its private key), and it must be the
        # one the record names: a record edited since never puts another key on a Host
        have = (boxkeys.derived(slot.new) or [])[:2]
        if not have or have != str(entry.get("new") or "").split()[:2]:
            die(f"{slot.new} isn't the key the Box key rotation's record names as its new key (the record, or the key "
                f"file, changed since): nothing was changed. Restore whichever changed, then run roster setup --rotate")

    elsewhere = entries_elsewhere(cfg)
    conn = Connect()
    failed: dict[Member, str] = {}
    proven: list[Member] = []
    try:
        news = {key: (boxkeys.derived(slot.new) or [])[:2] for key, slot in slots.items()}
        for m in now:                            # pass 1: the new line on, and proven, Host by Host
            new = m.slot.new
            if not starting and conn.logs_in(m, new)[0]:
                proven.append(m)
                continue
            line = f"{news[m.slot.key][0]} {news[m.slot.key][1]} {m.cfg['tag']}"    # its Inventory's own name
            this = key_ere(*line.split()[:2])
            keys = old_keys(m, groups)
            if not keys:
                recs[m.ctx].pending[m.name] = ("no old key of this Box's is left to log in with: `roster setup --host "
                                               f"{m.name}` installs the new one with its Login's password")
                continue
            try:
                conn.script(m, keys, add_key_script(line, this, m.h["ssh"]["user"]), "add", this, pub=line)
            except Unreached as e:
                recs[m.ctx].pending[m.name] = f"not reached with the old key: {e}"
                say(f"  pending  {m.label}: not reached with the old key: {e}")
                continue
            except RuntimeError as e:
                failed[m] = tagged(Problem(NEW_KEY_REFUSED, f"couldn't add the new key's line: {e}"))
                continue
            ok, why = conn.logs_in(m, new)
            if not ok:
                failed[m] = tagged(Problem(NEW_KEY_REFUSED, f"the new key's line went in, but the new key doesn't "
                                                            f"log in ({why}); the old key's line stays there"))
                continue
            proven.append(m)
        for m in proven:
            recs[m.ctx].refused = [n for n in recs[m.ctx].refused if n != m.name]
        for m, why in failed.items():
            recs[m.ctx].pending[m.name] = why
            recs[m.ctx].refused.append(m.name)
            say(f"  FAIL     {m.label}: {why}")
        # a Host that refused it, this run or an earlier one, and isn't proven now holds the swap back
        unproven = [m for m in todo if m.name in recs[m.ctx].refused and m not in proven
                    and not entries[str(m.slot.key)].get("swapped")]
        if failed or unproven:
            names = ", ".join(m.label for m in (list(failed) or unproven))
            say(f"rotation     stopped: {names} refused the new key{'' if failed else ' (an earlier run)'} and "
                "hasn't proven it since, so no old key line was taken off anywhere and the old key stays this Box's "
                "key (fix that, then run roster setup --rotate again)")
            save_all()
            return {"done": [], "pending": labels(recs, groups),
                    "failed": {m.label: w for m, w in failed.items()} or
                              {m.label: recs[m.ctx].pending.get(m.name, "refused the new key") for m in unproven},
                    "notes": {}, "groups": groups}

        # every Host reached proved the new key: it becomes the key, the old kept while a Host still needs it
        for key, slot in slots.items():
            if not slot.swapped:
                swap(slot, entries[str(key)], keep_old=True)
            entries[str(key)]["swapped"] = slot.done = True
        save_all()
        sync(groups, say)
        done: list[Member] = []
        notes: dict[str, str] = {}
        for m in proven:                         # pass 2: the old lines off, over the new key
            # never a new key's line, whichever key file's (two rotated together can share an account), nor one
            # another entry on the account logs in with; the new keys moved aside, any key file's
            ere = old_lines_re(m, groups, news[m.slot.key],
                               [a for k in slots for a in entries[str(k)].get("abandoned") or []],
                               kept_keys(m, groups, elsewhere, set(slots)) + list(news.values()))
            try:
                taken = conn.script(m, [m.slot.key], remove_key_script(ere, m.h["ssh"]["user"]), "remove", ere) \
                    if ere else []
            except (Unreached, RuntimeError) as e:
                recs[m.ctx].pending[m.name] = f"the new key works, but the old key's line couldn't be taken off: {e}"
                say(f"  FAIL     {m.label}: {recs[m.ctx].pending[m.name]}")
                continue
            recs[m.ctx].pending.pop(m.name, None)
            boxkeys.record({m.name: [m.h["key_type"]]}, m.ctx)     # every other line of this Box's went
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
    held = {m.slot.key for m in todo if m.name in recs[m.ctx].pending}
    for key, slot in list(slots.items()):       # no Host still needs it: the old private key goes, and its entry
        if key not in held:
            delete_old(slot)
            del slots[key]
    save_all()
    sync(groups, say)
    if not held:
        retire_keys(cfg, say)
    return {"done": [m.label for m in done], "pending": labels(recs, groups), "failed": {}, "notes": notes,
            "groups": groups}


def label(ctx: Context, name: str) -> str:
    """A Host as the rotation names it: by its name in this run's Inventory, else with its Inventory's."""
    return name if ctx.name == current().name else f"{ctx.name or '(unnamed)'}: {name}"


def labels(recs: dict[Context, Record], groups: Groups) -> dict[str, str]:
    return {label(ctx, n): why for ctx, _ in groups for n, why in sorted(recs[ctx].pending.items())}


def sync(groups: Groups, say: Callable[[str], None]) -> None:
    """Each Inventory's ssh config, written again: its Hosts' key now, and the old one too where pending."""
    for ctx, c in groups:
        write_ssh_config(c, ctx)
