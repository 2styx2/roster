"""This Box's key line on a Host (keyline.py's format): putting it there (`roster setup`), re-tagging it after the
Box was renamed (T217), taking it off (`roster revoke`). On a POSIX Host a sh script does it over ssh; on an
`os: windows` Host winhost's PowerShell does. What this Box's lines are (its tag, its own public keys under any
roster-managed name) is box_key_re's."""

import shlex
import subprocess
from dataclasses import dataclass, field
from typing import Any

from . import boxkeys, keyline, sshops, winhost
from .common import program_argv
from .context import current
from .errors import KEY_FILE
from .hosts import is_windows
from .keyline import key_ere
from .providers import get_secret

# ---------------------------------------------------------------- which lines are this Box's


def box_public_keys(cfg: dict[str, Any]) -> list[list[str]]:
    """[[type, key, comment...]] of each of this Box's public keys that's there and reads as one, and whose private key
    this Box holds (boxkeys.vouched, #471's review LOW-6: every key, not only the leftover ones)."""
    out: list[list[str]] = []
    for key in boxkeys.all_keys(cfg):
        if not boxkeys.vouched(key, cfg["key"]):
            continue
        try:
            parts = key.pub.read_text().split()
        except OSError:
            continue
        if len(parts) >= 2:
            out.append(parts)
    return out


def box_key_re(cfg: dict[str, Any]) -> str:
    """What matches this Box's key lines in authorized_keys: its tag (cfg's tag_re), or one of this Box's own public
    keys (one per key type, T239: boxkeys.all_keys) with a roster-managed tag of any Box name (T217, #412): a Box
    renamed since (box_name:, or the hostname) still finds its lines under the earlier name, and never another Box's,
    whose keys differ. The tag alone without a public key."""
    alts: list[str] = [cfg["tag_re"]] + [key_ere(words[0], words[1]) for words in box_public_keys(cfg)]
    return "|".join(dict.fromkeys(alts))


def key_tag_name(cfg: dict[str, Any]) -> str | None:
    """The Box name in this Box's public keys' comment (ssh-keygen -C, as it was made, or as setup re-tagged it): its
    own key's first, then the other key types' (T239). None when no comment is a roster-managed tag (a key of the
    user's own)."""
    for parts in box_public_keys(cfg):
        if len(parts) == 3 and (name := keyline.tag_box(parts[2])):
            return name
    return None


def key_named(cfg: dict[str, Any]) -> str | None:
    """The Box name this Box's key lines on this Inventory's Hosts carry: what the last `roster setup` that reached
    every key Host tagged them with (the Inventory's key-name file), else the key's own comment (a key made by roster
    names the Box as it was then). None: not known (a key of the user's own, never set up since T217)."""
    try:
        return current().key_name.read_text().strip() or None
    except OSError:
        return key_tag_name(cfg)


# ---------------------------------------------------------------- the POSIX scripts

# Which file sshd reads this account's keys from ($f, and $F as messages name it): ~/.ssh/authorized_keys, or on ESXi
# (uname VMkernel) its own /etc/ssh/keys-USER/authorized_keys, which it keeps across a reboot (its home isn't kept),
# as the Mesh's scripts do. USER is the Login's user ($U), as sshd's %u: one the Host names otherwise
# (`id -un`: another case, a directory account's form) is refused, as the key would go where sshd doesn't look.
AK_FILE = ('if [ "$(uname -s 2>/dev/null)" = VMkernel ]; then ESXI=1; f=/etc/ssh/keys-$U/authorized_keys; F=$f; '
           'L=$(id -un 2>/dev/null) || L=; '
           '[ "$L" = "$U" ] || { echo "this login is ${L:-unknown} on ESXi, not $U (its user: in roster.yml), and '
           'ESXi\'s sshd reads its keys-${L:-LOGIN} folder: nothing was changed (set user: as the Host names it)" '
           '>&2; exit 1; }; '
           'else ESXI=; f=$HOME/.ssh/authorized_keys; F="~/.ssh/authorized_keys"; fi; ')
# All three rewrite authorized_keys as a new file next to it, then mv it into place: a run cut short leaves the old
# file whole (rewritten in place, it could be left empty and lock everyone out). cp -p first keeps its mode and owner
# (and ESXi's sticky bit, without which ESXi drops a file under /etc at the next boot).
# The new file is a new inode: on an SELinux-enforcing Host it may lack the old one's label (ssh_home_t) and sshd
# would refuse it. So the old file's context is copied (chcon --reference) before the mv, and restorecon sets the
# policy's after it. Both only where they exist, and never fatal (ESXi's busybox, macOS, Alpine have neither).
REPLACE_AK = ("[ -L \"$f\" ] && f=$(readlink -f \"$f\"); "
              "rm -f \"$f.roster\"; cp -p \"$f\" \"$f.roster\"; ")
KEEP_LABEL = ("{ command -v chcon >/dev/null 2>&1 && chcon --reference=\"$f\" \"$f.roster\" 2>/dev/null; } "
              "|| true; ")
RELABEL = "{ command -v restorecon >/dev/null 2>&1 && restorecon -F \"$f\" 2>/dev/null; } || true; "
# 600, as sshd wants it; on ESXi a file roster makes gets 1600 (its own keys file's mode) and an existing one keeps
# its mode (cp -p), sticky bit and all
KEY_MODE = ("if [ -z \"$ESXI\" ]; then chmod 600 \"$f.roster\"; "
            "elif [ -n \"$NEW\" ]; then chmod 1600 \"$f.roster\"; fi; ")
# ESXi saves /etc to its boot bank hourly: saved now, so a reboot before then keeps the change
BACKUP = "if [ -n \"$ESXI\" ] && [ -x /sbin/auto-backup.sh ]; then /sbin/auto-backup.sh >/dev/null 2>&1 || true; fi; "


def key_script_head(user: str) -> str:
    return f"set -e; U={shlex.quote(user)}; " + AK_FILE


def taken_guard(name_re: str | None, own: str) -> str:
    """T226 (#435, 2): when a line NAME_RE matches holds a key OWN doesn't (another Box's key under the name this Box
    is being renamed to), ROSTER_TAKEN, and the script stops there with nothing changed."""
    if name_re is None:
        return ""
    return (f"if grep -E -- {shlex.quote(name_re)} \"$f\" | grep -q -v -E -- {shlex.quote(own)}; then "
            f"echo {keyline.TAKEN}; exit 0; fi; ")


def add_key_script(pub: str, tag_re: str, user: str, taken: str | None = None, own: str | None = None,
                   others: str | None = None) -> str:
    """Drops the lines TAG_RE matches (this same box's), appends the current one. Safe to re-run. TAKEN (this Box's
    name's tag_re, on a renamed Box): a line it matches with a key OWN (this Box's keys; PUB's when None) doesn't
    match stops it (ROSTER_TAKEN). OTHERS (T239): after the write, ROSTER_OTHERS when a line OTHERS matches (this
    Box's, any key) holds another key than PUB's, which a later step takes once PUB's line is shown to work."""
    this = key_ere(*pub.split()[:2])
    later = (f"if grep -E -- {shlex.quote(others)} \"$f\" | grep -q -v -E -- {shlex.quote(this)}; then "
             f"echo {keyline.OTHERS}; fi; ") if others else ""
    return (key_script_head(user) + "umask 077; d=${f%/*}; mkdir -p \"$d\"; NEW=; [ -f \"$f\" ] || NEW=1; "
            "touch \"$f\"; " + taken_guard(taken, own or this) + REPLACE_AK +
            f"grep -v -E -- {shlex.quote(tag_re)} \"$f\" > \"$f.roster\" || true; "
            f"printf '%s\\n' {shlex.quote(pub)} >> \"$f.roster\"; " + KEY_MODE + KEEP_LABEL +
            "mv -f \"$f.roster\" \"$f\"; " + RELABEL + BACKUP +
            "[ -n \"$ESXI\" ] || chmod 700 \"$d\"; " + later + f"echo {keyline.OK}")


def retag_key_script(pub: str, user: str, taken: str | None = None, own: str | None = None) -> str:
    """T217: this Box's key lines (PUB's key under any roster-managed name, options and all) get PUB's tag, in place:
    their options stay, every other line stays as it is (never matched by name: #423's review L2), and nothing is
    added; a second copy of one (#423's S2) goes, as the install's rewrite took it. ROSTER_NONE FILE when there's
    no such line (a line written by hand); a grep that fails (2: unreadable) is a failure, never "no line". TAKEN
    (the new name's tag_re): a line it matches with a key OWN (this Box's keys; PUB's when None) doesn't match stops
    it, as ROSTER_TAKEN, before anything changes."""
    kind, key, tag = pub.split()[:3]
    found = key_ere(kind, key)
    # the line with a space before it, so the key matches at its start too; awk's own trail (keyline.AWK_TRAIL_*)
    awk_re = " " + found.removeprefix("(^| )").removesuffix(keyline.TRAIL)
    return (key_script_head(user) + f"[ -f \"$f\" ] || {{ echo \"{keyline.NONE} $F\"; exit 0; }}; rc=0; NEW=; " +
            # the new name first: a Host where no line of this key is tagged may still hold another
            # Box's line under it, which this Box's revoke would take once the new name is recorded
            taken_guard(taken, own or found) +
            f"grep -q -E -- {shlex.quote(found)} \"$f\" || rc=$?; "
            f"[ $rc -eq 1 ] && {{ echo \"{keyline.NONE} $F\"; exit 0; }}; "
            "[ $rc -eq 0 ] || { echo \"grep couldn't read $F (exit $rc)\" >&2; exit 1; }; "
            "umask 077; " + REPLACE_AK +
            # ENVIRON, so awk keeps every \
            keyline.AWK_TRAIL_SH + f"RE={shlex.quote(awk_re)}\"[$W]*\\$\" TAG={shlex.quote(tag)} "
            "awk 'BEGIN { re = ENVIRON[\"RE\"]; t = ENVIRON[\"TAG\"] } "
            # the tag is what changes; whatever follows it (a CR, a space) stays
            f"(\" \" $0) ~ re {{ s = $0; sub(/{keyline.AWK_TRAIL_LITERAL}/, \"\", s); w = substr($0, length(s) + 1); "
            f"sub(/ {keyline.ANY_TAG}$/, \" \" t, s); if (seen[s]++) next; $0 = s w }} {{ print }}' "
            "\"$f\" > \"$f.roster\"; " +
            KEY_MODE + KEEP_LABEL + "mv -f \"$f.roster\" \"$f\"; " + RELABEL + BACKUP + f"echo {keyline.OK}")


def remove_key_script(tag_re: str, user: str) -> str:
    # each line it takes says its tag's name first (ROSTER_TAG NAME), so revoke can say when one had another name
    return (key_script_head(user) + f"[ -f \"$f\" ] || {{ echo {keyline.OK}; exit 0; }}; " + REPLACE_AK +
            f"grep -E -- {shlex.quote(tag_re)} \"$f\" | sed -n '{keyline.SED_NAMES}' || true; "
            f"grep -v -E -- {shlex.quote(tag_re)} \"$f\" > \"$f.roster\" || true; " +
            KEEP_LABEL + "mv -f \"$f.roster\" \"$f\"; " + RELABEL + BACKUP + f"echo {keyline.OK}")


def remove_script(tag_re: str, user: str) -> str:
    """The POSIX key-removal command for the Login's USER: sh with the script as its argument."""
    return "sh -c " + shlex.quote(remove_key_script(tag_re, user))


def over_ssh(h: dict[str, Any], script: str, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    """Run SCRIPT on key Host H over `ssh NAME` with this Box's key, never a shared connection."""
    return subprocess.run(program_argv(["ssh", "-o", "BatchMode=yes", "-o", "ControlPath=none", h["name"], script]),
                          stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)


def failure(h: dict[str, Any], r: subprocess.CompletedProcess[str]) -> str:
    """Why a key script R didn't finish on H."""
    if winhost.looks_windows(r.stdout + r.stderr):
        return str(winhost.windows_hint(h["name"]))
    return (r.stderr or r.stdout).strip()[:200] or f"no answer (exit {r.returncode})"


# ---------------------------------------------------------------- setup: the line on, re-tagged

class NameTaken(RuntimeError):
    """T226 (#435, 2): a Host's key file has another key's line under the name this Box is being renamed to."""


def enroll(h: dict[str, Any], pub: str, tag_re: str, taken: str | None = None, own: str | None = None,
           keep_others: bool = False) -> list[str]:
    """Put this Box's key line PUB on Host H, logging in with its Login's password: the notes to show under its `ok`
    (on a Windows Host, the file it wrote and any warning). RuntimeError when it can't; NameTaken when TAKEN (this Box's
    name's tag_re, on a renamed Box) is given and another key's line (one OWN, this Box's keys, doesn't match) is under
    that name there.
    T239 (#471's review LOW-1): PUB's line goes in first beside this Box's other lines (TAG_RE: another key type's),
    a key login tests it, and only then do those go, over that key login (drop_others), and only when the install
    said there are any (on Windows too, #471's NIT-1). KEEP_OTHERS (setup --key-type, MED-1): they stay, so
    roster.yml's type still works after; TAG_RE then names only the lines that go (boxsetup.cleanup_re)."""
    this = key_ere(*pub.split()[:2])
    pw = get_secret(h["ssh"]["auth"], h["group"])
    if is_windows(h):
        done = winhost.install(h, pub, this, pw, taken or "", (own or this) if taken else "", others=tag_re)
        if done.taken:
            raise NameTaken(pub.split()[2])
        if not sshops.ssh_ok(h["name"]):
            raise RuntimeError(f"key written to {', '.join(done.files) or 'its key file'} but key login still fails "
                               "(check that file's permissions and encoding, and whether sshd_config's Match Group "
                               "administrators applies to this account)"
                               + ("; this Box's other key lines there were kept" if done.others else ""))
        notes = ([f"key file {f}" for f in done.files] + ([f"note: {winhost.admins_note(h['name'])}"] if done.admins
                 else []) + [f"warning: [{KEY_FILE}] {w}" for w in done.warnings])
        if done.others and not keep_others:
            notes += [n for n in drop_others(h, pub, tag_re) if n not in notes]
        return notes
    _, out, err = sshops.password_exec(h, "sh -c " + shlex.quote(add_key_script(pub, this, h["ssh"]["user"], taken, own,
                                                                         others=tag_re)), pw)
    said = keyline.said(out)
    if said.taken:
        raise NameTaken(pub.split()[2])
    if not said.ok:
        if winhost.looks_windows(out + err):
            raise winhost.windows_hint(h["name"])

        raise RuntimeError("couldn't write authorized_keys: " + (err or out).strip()[:200])
    if not sshops.ssh_ok(h["name"]):
        raise RuntimeError("key installed but key login still fails (sshd PubkeyAuthentication off, bad home-dir "
                           "permissions, or a key type it refuses?)"
                           + ("; this Box's other key lines there were kept" if said.others else ""))
    if said.others and not keep_others:
        drop_others(h, pub, tag_re)
    return []


def drop_others(h: dict[str, Any], pub: str, drop_re: str, why: str = "the new key works") -> list[str]:
    """Over this Box's key login to Host H (PUB's key, whose line stays): this Box's lines DROP_RE matches go, and PUB's
    line is written once (DROP_RE matches it too, or it would be there twice). The notes a Windows Host's script gave
    (its key file's warnings). RuntimeError `WHY, but this Box's other key lines there couldn't be taken off: ...`."""
    fail = f"{why}, but this Box's other key lines there couldn't be taken off: "
    if is_windows(h):
        try:
            done = winhost.over_key(h, "add", drop_re, pub=pub, sweep=True)     # both files (#509 item 4)
        except RuntimeError as e:
            raise RuntimeError(fail + str(e)) from None
        return [f"warning: [{KEY_FILE}] {w}" for w in done.warnings]
    r = over_ssh(h, "sh -c " + shlex.quote(add_key_script(pub, drop_re, h["ssh"]["user"])), timeout=120)
    if not keyline.said(r.stdout).ok:
        raise RuntimeError(fail + ((r.stderr or r.stdout).strip()[:200] or f"exit {r.returncode}"))
    return []


@dataclass(frozen=True)
class NoLine:
    """retag: the key works there, but no roster-managed line for it is in FILE (the key file sshd reads there)."""
    file: str


TAKEN = "name taken"        # retag: another key's line is under the new name there: nothing changed


@dataclass
class Done:
    """What a re-tag or revoke on one Host came to: WHY (None: done; else why not, or for re-tag a NoLine or TAKEN),
    the warnings a Windows Host's script gave (KEY_FILE), and for revoke the tag names of the lines it took."""

    why: object = None
    warnings: list[str] = field(default_factory=list[str])
    names: list[str] = field(default_factory=list[str])


def retag(h: dict[str, Any], pub: str, taken: str | None = None, own: str | None = None) -> Done:
    """Re-tag this Box's key lines on key Host H with PUB's tag (T217), in place, found by its public key under any
    roster-managed name, over `ssh NAME` with the key itself. TAKEN: the new name's tag_re, which matches another
    key's line there when the name is another Box's."""
    kind, key = pub.split()[:2]
    try:
        if is_windows(h):
            done = winhost.over_key(h, "retag", key_ere(kind, key), pub=pub, taken=taken or "",
                                    own=(own or key_ere(kind, key)) if taken else "")
            why = TAKEN if done.taken else NoLine(done.files[0] if done.files else "its key file") if done.noline \
                else None
            return Done(why, done.warnings)
        r = over_ssh(h, "sh -c " + shlex.quote(retag_key_script(pub, h["ssh"]["user"], taken, own)), timeout=120)
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as e:     # ValueError: an ssh that won't take it
        return Done(str(e))
    said = keyline.said(r.stdout)
    if said.taken:
        return Done(TAKEN)
    if said.none is not None:
        return Done(NoLine(said.none or "~/.ssh/authorized_keys"))
    if said.ok:
        return Done()
    return Done((r.stderr or r.stdout).strip()[:200] or f"no answer (exit {r.returncode})")


# ---------------------------------------------------------------- revoke: the line off

def revoke(h: dict[str, Any], tag_re: str) -> Done:
    """Take this Box's key (TAG_RE) off Host H by its name (`ssh NAME`, never a shared connection). A Windows Host
    (os: windows) gets the PowerShell script (winhost), on stdin."""
    if is_windows(h):
        try:
            done = winhost.over_key(h, "remove", tag_re)
        except RuntimeError as e:
            return Done(str(e))
        return Done(None, done.warnings, done.tags)
    r = over_ssh(h, remove_script(tag_re, h["ssh"]["user"]))
    subprocess.run(program_argv(["ssh", "-O", "exit", h["name"]]), capture_output=True)  # drop cached connection
    said = keyline.said(r.stdout)
    if said.ok:
        return Done(None, names=said.names)
    return Done(failure(h, r))
