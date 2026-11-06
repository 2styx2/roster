"""This Box's key line in a Host's authorized_keys: `TYPE KEY roster-managed:BOX`, options before it allowed
(`from="..." ssh-ed25519 KEY roster-managed:BOX`). The one place that knows the tag, the names a Box may have in it,
how a line ends, how roster finds a line (grep -E and awk on a POSIX Host, .NET's regex on a Windows one) and what
roster's key scripts print. setup writes these lines; revoke, re-tag and the Box key rotation find them; the Mesh's
own lines (`roster-mesh:`) are never matched."""

import re
from dataclasses import dataclass, field

TAG = "roster-managed"
LEGACY_TAGS = ("fleet-managed",)       # tags used by earlier versions; still recognized
TAGS = (TAG, *LEGACY_TAGS)
BOX_CHARS = "A-Za-z0-9_-"               # what a Box name in a tag is made of
# the end of a key line's ERE: spaces or a CR may follow the tag (a file edited on Windows), and sshd still reads
# the line. POSIX only: .NET has no [[:space:]], so winhost's script trims each line first (powershell)
TRAIL = "[[:space:]]*$"
# TRAIL for awk, with no bracket class (mawk 1.3.3, Debian 10's and Ubuntu 18.04's awk, has no
# [[:space:]] and reads it as a set of letters): a space, tab or CR. In awk's own regex literal as escapes; through
# ENVIRON (where awk may not read escapes) as the characters, which the shell makes ($W)
AWK_TRAIL_LITERAL = "[ \\t\\r]*$"
AWK_TRAIL_SH = "W=$(printf ' \\t\\r'); "
ANY_TAG = f"({'|'.join(TAGS)}):[{BOX_CHARS}]+"     # a roster-managed tag, any Box name
TAGS_ERE = ANY_TAG + TRAIL
# what remove's sed prints for each line it takes: its tag's name (ROSTER_TAG NAME)
SED_NAMES = f"s/.*:\\([{BOX_CHARS}]*\\)[[:space:]]*$/ROSTER_TAG \\1/p"
# winhost's PowerShell (lines trimmed first): a line's tag, and the Box name in it
PS_TAG_END = f" {ANY_TAG}$"
PS_NAME_END = f":([{BOX_CHARS}]+)$"


def box_name(name: str) -> str:
    """NAME (box_name:, or the hostname) as it goes in the tag: every other character a -."""
    return re.sub(f"[^{BOX_CHARS}]", "-", name)


def tag(box: str) -> str:
    return f"{TAG}:{box}"


def tag_re(box: str) -> str:
    """What matches the Box BOX's key lines: its tag, or an earlier version's, at the line's end."""
    return f" ({'|'.join(TAGS)}):{box}{TRAIL}"


def ere_literal(text: str) -> str:
    """TEXT as a POSIX ERE (and .NET regex) that matches it literally: grep -E on a Host, -cmatch on Windows."""
    return re.sub(r"([.\[\]()*+?{}|^$\\])", r"\\\1", text)


def key_ere(kind: str, key: str) -> str:
    """An ERE for a Box key line of key KIND KEY under a roster-managed tag of any name, with or without options
    before it (#423's review M1): it ends in this key and a roster tag, so it's this Box's line, whatever its name.
    A line with no roster tag (a user's own) never matches."""
    return f"(^| ){ere_literal(kind)} {ere_literal(key)} {TAGS_ERE}"


def tag_box(word: str) -> str | None:
    """The Box name in WORD when it's a roster-managed tag (a public key's comment), else None."""
    m = re.fullmatch(f"(?:{'|'.join(TAGS)}):([{BOX_CHARS}]+)", word)
    return m[1] if m else None


def name_in(ere: str) -> str:
    """The Box name in ERE (a tag_re, or an ERE that starts with one)."""
    m = re.search(f":([{BOX_CHARS}]+)" + re.escape(TRAIL), ere)
    return m[1] if m else "?"


def powershell(ere: str) -> str:
    """ERE as winhost's script matches it, on a line trimmed first: the plain end of line for TRAIL."""
    return ere.replace(TRAIL, "$")


# ---------------------------------------------------------------- what the POSIX key scripts print

OK = "ROSTER_OK"            # done (the last line)
NAMED = "ROSTER_TAG"        # remove: a line it took, by its tag's name
NONE = "ROSTER_NONE"        # re-tag: no line of this key there (then the key file it looked in)
TAKEN = "ROSTER_TAKEN"      # another key's line is under the new name there: nothing changed
OTHERS = "ROSTER_OTHERS"    # add: this Box's line of another key is there too
BUSY = "ROSTER_BUSY"        # another run held the Host lock (then its lock file): nothing changed
NOLOCK = "ROSTER_NOLOCK"    # the rewrite ran without the Host lock (then why: no flock there)

# ---------------------------------------------------------------- the lock on the Host (T263, #534)

# Two Boxes (or two roster runs) rewriting one account's authorized_keys at once each read it, then renamed their new
# version over it, and the first one's line was gone (T258 made each run's temp file its own; AccountLocks makes Host
# entries take turns only inside one roster process). Every rewrite (setup's, revoke's, re-tag's, the Mesh's) now
# holds an advisory lock on LOCK_SUFFIX beside the file (its link resolved), from before it reads the file until the
# script ends. The lock is a file of its own: authorized_keys itself is replaced by a rename (a new inode), and the
# lock file's absence or a stale one never blocks (flock's lock goes with the process; the file stays, empty).
LOCK_SUFFIX = ".roster-lock"
LOCK_WAIT = 10              # seconds a run waits for another's turn there before it stops, nothing changed
# hostlock FILE (POSIX sh): flock (util-linux's, or BusyBox's applet) on FILE.roster-lock, held on fd 9 until the
# script ends. Prints BUSY LOCKFILE and returns 1 when another run still holds it after LOCK_WAIT seconds; prints
# NOLOCK WHY and goes on unlocked (as before T263) where there's no flock or the lock file can't be opened (a link
# there, a read-only folder), never silently; returns 0 with nothing said when FILE's folder isn't there yet (no file
# to lose a line of). `flock -n` in a loop: BusyBox's flock has no -w.
def host_lock(wait: int = LOCK_WAIT) -> str:
    """HOST_LOCK, waiting WAIT seconds (a test's shorter wait)."""
    return ("hostlock() { "
            'k=$1; [ -L "$k" ] && k=$(readlink -f "$k" 2>/dev/null || echo "$k"); k=$k@SUFFIX@; '
            '[ -d "${k%/*}" ] || return 0; '
            "if command -v flock >/dev/null 2>&1; then KL=flock; "
            "elif command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx flock; "
            'then KL="busybox flock"; '
            'else echo "@NOLOCK@ this Host has no flock"; return 0; fi; '
            'if [ -L "$k" ] || { [ -e "$k" ] && [ ! -f "$k" ]; }; then echo "@NOLOCK@ $k isn\'t a plain file"; '
            "return 0; fi; "
            '( : >> "$k" ) 2>/dev/null || { echo "@NOLOCK@ couldn\'t open $k"; return 0; }; '
            'exec 9>> "$k"; i=0; '
            "until $KL -n 9 2>/dev/null; do "
            'i=$((i + 1)); [ "$i" -lt @WAIT@ ] || { echo "@BUSY@ $k"; return 1; }; sleep 1; '
            "done; }; "
            ).replace("@SUFFIX@", LOCK_SUFFIX).replace("@NOLOCK@", NOLOCK).replace("@BUSY@", BUSY).replace(
                "@WAIT@", str(wait))


HOST_LOCK = host_lock()


@dataclass
class Said:
    """What a key script printed: OK (it finished), the tag names of the lines remove took, the key file re-tag found
    no line in (None: it found one), the TAKEN and OTHERS signs, and the Host lock's BUSY and NOLOCK (T263)."""

    ok: bool = False
    names: list[str] = field(default_factory=list[str])
    none: str | None = None
    taken: bool = False
    others: bool = False
    busy: str | None = None         # the lock file another run held
    nolock: str | None = None       # why the rewrite ran without the lock


def after(lines: list[str], marker: str) -> str | None:
    """What follows MARKER on the first line that starts with it (None: no such line)."""
    return next((ln.partition(" ")[2].strip() for ln in lines if ln.split()[:1] == [marker]), None)


def said(out: str) -> Said:
    lines = out.splitlines()
    words = out.split()
    return Said(ok=OK in out, names=[ln.split()[1] for ln in lines if ln.startswith(NAMED + " ") and len(ln.split()) > 1],
                none=after(lines, NONE), taken=TAKEN in words, others=OTHERS in words, busy=after(lines, BUSY),
                nolock=after(lines, NOLOCK))
