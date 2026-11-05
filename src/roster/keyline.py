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
# the line (T226, #435). POSIX only: .NET has no [[:space:]], so winhost's script trims each line first (powershell)
TRAIL = "[[:space:]]*$"
# TRAIL for awk, with no bracket class (#442's M2: mawk 1.3.3, Debian 10's and Ubuntu 18.04's awk, has no
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
TAKEN = "ROSTER_TAKEN"      # another key's line is under the new name there: nothing changed (T226)
OTHERS = "ROSTER_OTHERS"    # add: this Box's line of another key is there too (T239)


@dataclass
class Said:
    """What a key script printed: OK (it finished), the tag names of the lines remove took, the key file re-tag found
    no line in (None: it found one), and the TAKEN and OTHERS signs."""

    ok: bool = False
    names: list[str] = field(default_factory=list)
    none: str | None = None
    taken: bool = False
    others: bool = False


def said(out: str) -> Said:
    lines = out.splitlines()
    words = out.split()
    none = next((ln.partition(" ")[2].strip() for ln in lines if ln.split()[:1] == [NONE]), None)
    return Said(ok=OK in out, names=[ln.split()[1] for ln in lines if ln.startswith(NAMED + " ") and len(ln.split()) > 1],
                none=none, taken=TAKEN in words, others=OTHERS in words)
