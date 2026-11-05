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
from dataclasses import dataclass
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
from .errors import NEW_KEY_REFUSED


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

    @property
    def under_way(self) -> bool:
        return new_of(self.key).exists() or old_of(self.key).exists()


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


# ---------------------------------------------------------------- the pending record

def load(inv: Any = CURRENT) -> dict[str, str]:
    """The Hosts (name: why) of the Inventory INV the Box key rotation hasn't finished on: empty when none."""
    try:
        data = json.loads(rotation_file(inv).read_text(encoding="utf-8"))
        pending = data.get("pending") if isinstance(data, dict) else None
        return {str(k): str(v) for k, v in pending.items()} if isinstance(pending, dict) else {}
    except (OSError, ValueError):
        return {}


def save(pending: dict[str, str], inv: Any = CURRENT) -> None:
    f = rotation_file(inv)
    if not pending:
        f.unlink(missing_ok=True)
        return
    replace_file(f, json.dumps({"pending": dict(sorted(pending.items()))}, indent=1) + "\n", 0o600)


def pending(cfg: dict[str, Any]) -> dict[str, str]:
    """This run's Inventory's Hosts the rotation is pending on (name: why), those still in roster.yml."""
    return {n: why for n, why in load().items() if n in cfg["hosts"]}


def identity_files(h: dict[str, Any], waiting: Any = ()) -> list[str]:
    """The key files the ssh config offers Host H, in order: its key, then (when H is in WAITING, the pending
    record, and the old key is kept as .old) the old one, so a Host not switched yet still logs in."""
    key = Path(h["key_file"])
    out = [h["key_file"]]
    if h["name"] in waiting and not new_of(key).exists() and old_of(key).exists():
        out.append(str(old_of(key)))
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


def swap(slot: Slot, keep_old: bool) -> None:
    """The new key into SLOT's file. KEEP_OLD: the old one stays as KEY.old (a Host still holds only its line);
    else the old private key is gone with the rename (and any older .old with it)."""
    key = slot.key
    if keep_old:
        copy_private(key, old_of(key))
        shutil.copyfile(pub_of(key), pub_of(old_of(key)))
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
    """This Box's key lines on M that aren't its new key's: each of this Box's public keys (every type's, and each
    slot's .old) but the new one, with a roster-managed tag of any Box name. Never a roster-mesh: line."""
    from .sshops import key_ere
    found: list[list[str]] = []
    for _, c in groups:
        for key in boxkeys.all_keys(c):
            w = words(key.pub)
            if w:
                found.append(w)
    for f in (pub_of(m.slot.key), pub_of(old_of(m.slot.key))):
        w = words(f)
        if w:
            found.append(w)
    alts = dict.fromkeys(key_ere(*w) for w in found if w != new_words)
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


# ---------------------------------------------------------------- the run

def plan(cfg: dict[str, Any], scope: set[str] | None):
    """(groups, members to do, slots to rotate, starting): what a run does. SCOPE: the Host names this run may reach
    (None: every one); the rest stay pending."""
    groups = group(cfg)
    everyone = members(groups)
    waiting = {inv: load(inv) for inv, _ in groups}
    busy = {m.slot.key: m.slot for m in everyone if m.slot.under_way}
    starting = not busy and not any(waiting.values())
    if starting:
        chosen = [m for m in everyone if scope is None or (m.inv == current_inventory() and m.name in scope)]
        slots = {m.slot.key: m.slot for m in chosen}
        todo = [m for m in everyone if m.slot.key in slots]
    else:
        slots = busy
        todo = [m for m in everyone if m.name in waiting.get(m.inv, {})
                or (m.slot.key in busy and not any(waiting.values()))]
        for m in todo:
            slots.setdefault(m.slot.key, m.slot)
    return groups, todo, slots, starting


def run(cfg: dict[str, Any], scope: set[str] | None = None, dry_run: bool = False, say=print) -> dict[str, Any]:
    """`roster setup --rotate`: see the module's text. Returns {done: [label], pending: {label: why}, failed: {label:
    why}, notes: {label: note}, groups: [(inv, cfg)]}."""
    groups, todo, slots, starting = plan(cfg, scope)
    others = [inv for inv, _ in groups[1:]]
    if others:
        say(f"shared key   the named Inventor{'y' if len(others) == 1 else 'ies'} {', '.join(map(str, others))} use "
            f"this Box's key too: their Hosts are rotated in this run as well, before any old line goes")
    fresh = {k for k, slot in slots.items() if starting and not slot.key.exists()}
    if fresh and not any(old_keys(m, groups) for m in todo if m.slot.key in fresh):
        die(f"this Box has no key at {', '.join(map(str, sorted(fresh)))} yet, nor any other to log in with, so "
            "there's nothing to rotate: `roster setup` makes it and puts it on the Hosts")
    if not todo:
        if starting:
            say("rotation     no Box key rotation to do: no key Host here")
        elif not dry_run:   # the Hosts it was pending on left roster.yml: nothing holds the old key for them now
            say("rotation     the Hosts the Box key rotation was pending on aren't in roster.yml now: it's done")
            for inv, _ in groups:
                save({}, inv)
            for slot in slots.values():
                if slot.swapped:
                    delete_old(slot)
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

    waiting = {inv: load(inv) for inv, _ in groups}
    if starting:
        from .sshops import ensure_key
        for key, slot in slots.items():
            if key in fresh:     # a type its Hosts didn't use yet (key_type: changed): its first key is the new one
                ensure_key(boxkeys.BoxKey(slot.type, key), cfg["tag"])
            else:
                make_new(slot, cfg, say)
        for m in todo:
            waiting[m.inv][m.name] = "the new Box key isn't on it yet"
        for m in later:
            waiting[m.inv][m.name] = "not in this run (--host)"
    for inv, _ in groups:
        save(waiting[inv], inv)

    conn = Connect()
    failed: dict[Member, str] = {}
    proven: list[Member] = []
    try:
        news = {key: w for key, s in slots.items() if (w := words(pub_of(s.new)))}
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
                waiting[m.inv][m.name] = ("no old key of this Box's is left to log in with: `roster setup --host "
                                          f"{m.name}` installs the new one with its Login's password")
                continue
            try:
                conn.script(m, keys, add_key_script(line, this, m.h["ssh"]["user"]), "add", this, pub=line)
            except Unreached as e:
                waiting[m.inv][m.name] = f"not reached with the old key: {e}"
                say(f"  pending  {m.label}: not reached with the old key: {e}")
                continue
            except RuntimeError as e:
                failed[m] = f"couldn't add the new key's line: {e}"
                continue
            ok, why = conn.logs_in(m, new)
            if not ok:
                failed[m] = (f"[{NEW_KEY_REFUSED}] the new key's line went in, but the new key doesn't log in "
                             f"({why}); the old key's line stays there")
                continue
            proven.append(m)
        for m, why in failed.items():
            waiting[m.inv][m.name] = why
            say(f"  FAIL     {m.label}: {why}")
        if failed:
            say(f"rotation     stopped: {len(failed)} Host{'' if len(failed) == 1 else 's'} refused the new key, so no "
                "old key line was taken off anywhere and the old key stays this Box's key (fix those, then run "
                "roster setup --rotate again)")
            for inv, _ in groups:
                save(waiting[inv], inv)
            return {"done": [], "pending": labels(waiting, groups), "failed": {m.label: w for m, w in failed.items()},
                    "notes": {}, "groups": groups}

        # every Host reached proved the new key: it becomes the key, the old kept while a Host still needs it
        for slot in slots.values():
            if not slot.swapped:
                swap(slot, keep_old=True)
        sync(groups, say)
        done, notes = [], {}
        for m in proven:                         # pass 2: the old lines off, over the new key
            from .sshops import remove_key_script
            ere = old_lines_re(m, groups, words(pub_of(m.slot.key)) or [])
            try:
                taken = conn.script(m, [m.slot.key], remove_key_script(ere, m.h["ssh"]["user"]), "remove", ere) \
                    if ere else []
            except (Unreached, RuntimeError) as e:
                waiting[m.inv][m.name] = f"the new key works, but the old key's line couldn't be taken off: {e}"
                say(f"  FAIL     {m.label}: {waiting[m.inv][m.name]}")
                continue
            waiting[m.inv].pop(m.name, None)
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
    for inv, _ in groups:
        save(waiting[inv], inv)
    held = {m.slot.key for m in todo if m.name in waiting[m.inv]}
    for slot in slots.values():                 # no Host still needs it: the old private key goes
        if slot.key not in held:
            delete_old(slot)
    sync(groups, say)
    return {"done": [m.label for m in done], "pending": labels(waiting, groups), "failed": {}, "notes": notes,
            "groups": groups}


def labels(waiting, groups) -> dict[str, str]:
    here = current_inventory()
    return {(n if inv == here else f"{inv or '(unnamed)'}: {n}"): why for inv, _ in groups
            for n, why in sorted(waiting[inv].items())}


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
