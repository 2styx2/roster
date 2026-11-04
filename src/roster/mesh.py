"""The Mesh (decision Q63, ticket 39): Host-to-Host access that roster sets up from one Box, with nothing
installed on the Hosts. roster.yml says who may reach whom (`mesh: true` per group, `links:`); this module turns
that into what each Host needs, and makes it so over the Box's own ssh, one connection at a time:

- on each source Host: a key made there (the private key never leaves it), the peers' recorded host keys, an ssh
  config so `ssh PEER` works, and a ROSTER.md of its peers for Claude (imported from ~/.claude/CLAUDE.md);
- on each peer: the source's public key in authorized_keys, tagged `roster-mesh:SOURCE@BOX` (owner_of), with
  `from="SOURCE IP"` and no agent or X11 forwarding.

Everything roster writes is tagged with the Box (and Inventory) that wrote it, or lives in files whose header says so,
and only this Box's are ever changed or removed (T199: another Box's Mesh on the same Hosts is left alone). The
interface is small: graph() (who reaches whom, no connections), run() (plan or apply), cut(), status(), and
drift() for `roster check`. Where things live on Linux and ESXi, and why, is in docs/mesh.md."""

import concurrent.futures as cf
import hashlib
import json
import os
import re
import subprocess
import threading
from typing import Any

from .common import (
    current_deadline,
    current_inventory,
    deadline_at,
    kill_tree,
    mesh_state_file,
    past_deadline,
    program_argv,
    time_left,
)
from .config import is_windows
from .errors import MESH_WINDOWS
from .sshops import hk_name, recorded_host_keys

TAG = "roster-mesh"
OPTIONS = 'from="{ip}",no-agent-forwarding,no-X11-forwarding'
CLAUDE_IMPORT = "@~/ROSTER.md"
# T196 (#376, decision Q176): every Mesh script is sh, which a Windows Host (os: windows) can't run
WINDOWS_LEFT_OUT = (f"[{MESH_WINDOWS}] os: windows: the Mesh's scripts are sh, which a Windows Host can't run, so it's "
                    "left out (a Link or meshed group naming it isn't an error)")
MARK = "# roster-mesh: the Mesh's ssh config (roster mesh adds and removes these two lines)"
CONNECT_TIMEOUT = 10
STEP_TIMEOUT = 120          # s: one Host's script, at most
CUT_TIMEOUT = 30            # s: one Host's part of a cut
OUT_OF_TIME = "out of time: not visited (the next roster mesh finishes it)"   # past serve's deadline
STOPPED = "stopped: not visited (the next roster mesh finishes it)"            # mesh.stop, before it got there
CLOSED = "serve closed: stopped part way (the next roster mesh finishes it)"   # close(), mid-step


# ---------------------------------------------------------------- who reaches whom (no connections)

def graph(cfg):
    """The Mesh roster.yml asks for: {links: [{from, to, kind, via?, skip?}], excluded: {host: why}, sources, visit}.
    kind is "key" (the peer takes the source's key) or "password" (ssh asks the person). via: the Host the source
    goes through to reach the peer (a Link's `via:`, which wins over the same pair without one). A link from a
    password Host is kept with skip="password-source": roster can't write files on a Host it reaches only with a
    password.
    visit: the Hosts roster logs in to (sources and key peers), in name order. meshed: {group: [hosts]}, each meshed
    group's Hosts that reach each other (two or more), in roster.yml order."""
    hosts = cfg["hosts"]
    excluded = {}

    def eligible(h):
        if not h["reviewed"]:
            excluded[h["name"]] = "not reviewed (reviewed: false)"
        elif h["mesh"] is False:
            excluded[h["name"]] = "mesh: false"
        elif is_windows(h):
            excluded[h["name"]] = WINDOWS_LEFT_OUT
        else:
            return True
        return False

    pairs = {}                                  # (source, peer): the Host it goes through, or None
    by_group = {}
    for h in hosts.values():
        by_group.setdefault(h["group"], []).append(h)
    groups = {}
    for group, members in by_group.items():
        meshed = [h["name"] for h in members if h["mesh"] is not None and eligible(h) and h["mesh"]]
        pairs.update({(a, b): None for a in meshed for b in meshed if a != b})
        if len(meshed) > 1:
            groups[group] = meshed

    def expand(name):
        return [name] if name in hosts else [h["name"] for h in by_group.get(name, [])]

    for link in cfg.get("links", []):
        for a in expand(link["from"]):
            for b in expand(link["to"]):
                via = link.get("via")
                if via and is_windows(hosts[via]):         # roster can't test a hop it can't run sh on
                    excluded[via] = WINDOWS_LEFT_OUT
                    continue
                if a != b and eligible(hosts[a]) and eligible(hosts[b]):
                    for pair in ((a, b), (b, a)) if link["both"] else ((a, b),):
                        if via and via not in pair:
                            pairs[pair] = via
                        else:
                            pairs.setdefault(pair, None)
    links = []
    for (a, b), via in sorted(pairs.items()):
        link = {"from": a, "to": b, "kind": "key" if hosts[b]["enroll"] else "password", **({"via": via} if via else {})}
        if not hosts[a]["enroll"]:
            link["skip"] = "password-source"
        links.append(link)
    live = [x for x in links if "skip" not in x]
    sources = sorted({x["from"] for x in live})
    visit = sorted(set(sources) | {x["to"] for x in live if x["kind"] == "key"})
    return {"links": links, "excluded": dict(sorted(excluded.items())), "sources": sources, "visit": visit,
            "meshed": groups}


def visitable(h):
    """Can the Mesh log in to Host H and run its sh scripts there: a key Host, reviewed, and not Windows (T196)?"""
    return h["enroll"] and h["reviewed"] and not is_windows(h)


def reach(g):
    """{host: how many Hosts it can reach}, from the plan (no connections)."""
    out = {}
    for x in g["links"]:
        if "skip" not in x:
            out[x["from"]] = out.get(x["from"], 0) + 1
    return out


def digest(cfg, g=None):
    """What the Mesh depends on in roster.yml: when it changes, the Mesh is out of date until the next apply."""
    g = g or graph(cfg)
    h = cfg["hosts"]
    parts = [(x["from"], x["to"], x["kind"], h[x["to"]]["ip"], h[x["to"]]["ssh"]["user"], h[x["to"]]["ssh"]["port"],
              h[x["from"]]["ip"]) + ((x["via"], h[x["via"]]["ip"]) if x.get("via") else ())
             + ((cfg["mesh_dirs"][x["from"]],) if x["from"] in cfg.get("mesh_dirs", {}) else ())
             + tuple(cfg.get("seen_as", {}).get(x.get("via") or x["from"], ()))
             for x in g["links"] if "skip" not in x]
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:16]


# ---------------------------------------------------------------- what the Box remembers (unfinished work)

def state_file():
    """This run's Inventory's Mesh state: mesh.json, or mesh-NAME.json for a named Inventory (common.mesh_state_file)."""
    return mesh_state_file()


def load_state():
    """{members: [hosts roster wrote Mesh entries on], pending: {host: why}, cut: {host: [peers not confirmed]},
    applied: digest of the last complete apply, known: whether this Box has any Mesh record (this Inventory's or
    another's)}. Only bookkeeping: the Mesh itself comes from roster.yml. known is False on a new Box, or one where
    roster was removed and installed again without `roster mesh cut --all` first (T193): the Hosts may hold Mesh
    entries this Box knows nothing of, and `roster mesh --find-leftovers` looks for them."""
    f = state_file()
    try:
        data = json.loads(f.read_text())
    except (OSError, ValueError):
        data = {}
    return {"members": list(data.get("members") or []), "pending": dict(data.get("pending") or {}),
            "cut": dict(data.get("cut") or {}), "applied": data.get("applied"),
            # whose tags this Box's Mesh entries carry (owner_of; T199): None from a roster before that (untagged)
            "owner": data.get("owner") if f.exists() else None, "recorded": f.exists(),
            # another Inventory's Mesh state here: a roster-mesh line roster.yml doesn't name could be that
            # Inventory's (Q172 (b)), so --remove-leftovers refuses (others_here)
            "known": f.exists() or any(f.parent.glob("mesh*.json"))}


def save_state(st):
    f = state_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".new")
    st = {k: v for k, v in st.items() if k not in ("known", "recorded") and (k != "owner" or v)}
    tmp.write_text(json.dumps(st, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, f)


# ---------------------------------------------------------------- the scripts that run on a Host (POSIX sh)

def q(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"


def ere(name):
    return re.escape(name).replace("\\-", "-")


# Where things live: Linux keeps the Mesh's files in ~/.ssh/roster-mesh; ESXi's home and /etc are rebuilt at every
# boot, so there they go on a datastore (kept), and authorized_keys is ESXi's own /etc/ssh/keys-USER/ (kept).
# A Host's mesh_dir: ($MD) overrides where the files go, on either; roster then only touches them there if they're
# its own (mine: a Mesh key's public half, or a config roster wrote).
WHERE = r"""
mine() { grep -qs ' roster-mesh:' "$1/id_ed25519.pub" || head -n 1 "$1/config" 2>/dev/null | grep -q '^# Written by roster mesh'; }
# Whose Mesh files are (T199, #379): the owner (BOX, or BOX/INVENTORY) their headers name. whose DIR: its config's
# header, else its key's comment; - when an older roster wrote them (no owner in them); empty with no Mesh files there.
whose() {
  [ -f "$1/config" ] || [ -f "$1/id_ed25519.pub" ] || return 0
  h=$(head -n 1 "$1/config" 2>/dev/null)
  case "$h" in "# Written by roster mesh for "*)
    o=$(printf '%s\n' "$h" | sed -n 's/^# Written by roster mesh for [^ ]* (owner \([^)]*\)).*/\1/p'); echo "${o:--}"; return;; esac
  c=$(cat "$1/id_ed25519.pub" 2>/dev/null); c=${c##* }
  case "$c" in roster-mesh:*@*) echo "${c#*@}";; roster-mesh:*) echo -;; esac
}
mdwhose() {  # mdwhose FILE: the owner the Mesh's ROSTER.md names, or -
  o=$(head -n 1 "$1" 2>/dev/null | sed -n 's/^<!-- roster-mesh: written by roster for [^ ;]* (owner \([^)]*\)).*/\1/p'); echo "${o:--}"
}
# ours_by OWNER: this run may change or remove what OWNER wrote: nothing there, this Box's (and Inventory's) own, or
# one of PREV's: what this Box wrote before (an older roster's, -, or under an earlier owner) where its record proves
# it wrote, and an older roster's for --remove-leftovers and cut --all (asked first)
ours_by() { [ -z "$1" ] || [ "$1" = "$OWNER" ] || case " $PREV " in *" $1 "*) true;; *) false;; esac; }
whose_words() { if [ "$1" = - ]; then echo "an older roster's (no Box named in them), which this Box has no record of writing"; else echo "another Box's or Inventory's ($1)"; fi; }
if [ "$(uname -s 2>/dev/null)" = VMkernel ]; then
  ESXI=1; AK=/etc/ssh/keys-$U/authorized_keys; R=; P=$MD
  [ -z "$P" ] && for v in /vmfs/volumes/*; do [ -d "$v/.roster-mesh" ] && { P=$(cd "$v" && pwd -P)/.roster-mesh; break; }; done
  if [ -z "$P" ]; then
    for v in /vmfs/volumes/*; do
      [ -L "$v" ] || continue
      case "${v##*/}" in BOOTBANK*|OSDATA*|LOCKER*|SCRATCH*) continue;; esac
      [ -d "$v" ] && [ -w "$v" ] && { P=$(cd "$v" && pwd -P)/.roster-mesh; break; }
    done
  fi
  [ -n "$P" ] && R=$P/ROSTER.md
else
  ESXI=; AK=$HOME/.ssh/authorized_keys; P=${MD:-$HOME/.ssh/roster-mesh}; R=$HOME/ROSTER.md
fi
"""

PROBE = r"""
umask 077
SEEN=$(cd "$P" 2>/dev/null && pwd -P)
stale() {  # stale DIR: an earlier Mesh directory, once per directory, never the one in use
  r=$(cd "$1" 2>/dev/null && pwd -P) || return 0
  case " $SEEN " in *" $r "*) return 0;; esac
  SEEN="$SEEN $r"; echo "STALE $1"
}
echo "DIR $P"
[ -n "$ESXI" ] && echo "PLATFORM esxi"
K=$P/id_ed25519
if [ -z "$P" ]; then
  echo "ERROR no datastore to keep the Mesh's key on (ESXi): name a directory on one with mesh_dir:"; echo ROSTER_DONE; exit 0
fi
if [ -n "$MD" ]; then
  bad() { echo "ERROR mesh_dir $MD$1"; echo ROSTER_DONE; exit 0; }
  if [ -n "$ESXI" ]; then
    case "$P" in /vmfs/volumes/?*/?*) ;; *) bad " isn't on a datastore (/vmfs/volumes/...): ESXi rebuilds the rest at every boot";; esac
  fi
  [ -d "${P%/*}" ] || bad ": ${P%/*} isn't there"
  if [ -d "$P" ]; then [ -w "$P" ] || bad ": roster can't write in it"; else [ -w "${P%/*}" ] || bad ": roster can't make it in ${P%/*}"; fi
  if ! mine "$P"; then
    for f in id_ed25519 id_ed25519.pub known_hosts config ROSTER.md; do
      [ -e "$P/$f" ] && bad " holds a $f that isn't roster's: give the Mesh a directory of its own"
    done
  fi
  if [ -n "$ESXI" ]; then
    for v in /vmfs/volumes/*/.roster-mesh; do [ -f "$v/id_ed25519" ] && stale "$v"; done
  elif [ -f "$HOME/.ssh/roster-mesh/id_ed25519" ]; then stale "$HOME/.ssh/roster-mesh"; fi
fi
# the directory the Include after roster's mark in ~/.ssh/config names: an earlier mesh_dir: (or roster's own pick)
O=$(awk -v m="$MARK" 'p { print; exit } $0 == m { p = 1 }' "$HOME/.ssh/config" 2>/dev/null)
case "$O" in "Include "/*/config) O=${O#Include }; O=${O%/config}; [ -f "$O/id_ed25519" ] && mine "$O" && stale "$O";; esac
# a key in $P from before that earlier directory took over: roster stopped using it (and warned then), and uses
# it again now; said (OLDKEY), never replaced unasked (--rotate does). Only while that directory is still there.
case "$O" in /*) r=$(cd "$O" 2>/dev/null && pwd -P) && [ -f "$K" ] && [ "$r" != "$(cd "$P" && pwd -P)" ] && [ "$ROTATE" != 1 ] \
  && echo "OLDKEY $P";; esac
KG=$(command -v ssh-keygen 2>/dev/null || echo /usr/lib/vmware/openssh/bin/ssh-keygen)
WHO=$(whose "$P")
if ! ours_by "$WHO"; then   # another's Mesh key: used as it is (its public half), never replaced or made (T199)
  [ "$ROTATE" = 1 ] && { echo "ERROR its Mesh key in $P is $(whose_words "$WHO"): roster doesn't replace it"; echo ROSTER_DONE; exit 0; }
  { [ -f "$K" ] && [ -f "$K.pub" ]; } || { echo "ERROR $P holds Mesh files that are $(whose_words "$WHO"), and no key"; echo ROSTER_DONE; exit 0; }
fi
# the key being replaced: an older roster's untagged line for it on a peer is this Box's to take too (#384)
[ "$ROTATE" = 1 ] && [ -f "$K.pub" ] && echo "OLDPUB $(cat "$K.pub")"
if [ "$ROTATE" = 1 ] && [ -f "$K" ]; then
  if [ "$MODE" = apply ]; then rm -f "$K" "$K.pub"; fi
  echo "KEY rotate"
fi
if [ ! -f "$K" ] || [ ! -f "$K.pub" ]; then
  if [ "$MODE" = apply ]; then
    mkdir -p "$P" && rm -f "$K" "$K.pub" && "$KG" -q -t ed25519 -N '' -C "roster-mesh:$NAME@$OWNER" -f "$K" >/dev/null 2>&1 \
      || { echo "ERROR ssh-keygen couldn't make the Mesh's key in $P"; echo ROSTER_DONE; exit 0; }
    echo "KEY made"
  else
    echo "KEY missing"
  fi
fi
[ -f "$K.pub" ] && [ "$MODE" = apply -o "$ROTATE" != 1 ] && echo "PUB $(cat "$K.pub")"
"""

REACH = r"""
reach() {
  if command -v nc >/dev/null 2>&1; then nc -z -w 5 "$2" "$3" >/dev/null 2>&1 && echo "REACH $1 ok" || echo "REACH $1 fail"
  elif command -v timeout >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then
    timeout 5 bash -c "exec 3<>/dev/tcp/$2/$3" >/dev/null 2>&1 && echo "REACH $1 ok" || echo "REACH $1 fail"
  else echo "REACH $1 unknown"; fi
}
"""

WRITE = r"""
umask 077
replace() {  # replace PATH < content: a temp file next to it, then mv, so a run cut short leaves PATH as it was;
             # the temp starts as a copy (cp -p), so PATH keeps its mode and owner (and ESXi's sticky bit); and
             # its SELinux label (a new inode may lack ssh_home_t, and sshd refuses it): chcon --reference before
             # the mv, restorecon after, where they exist (never fatal: busybox, macOS, Alpine have neither)
  f=$1; [ -L "$f" ] && f=$(readlink -f "$f" 2>/dev/null || echo "$f")
  n=$f.roster-new; rm -f "$n"
  if { [ ! -f "$f" ] || cp -p "$f" "$n"; } && cat > "$n"; then
    [ -f "$f" ] && command -v chcon >/dev/null 2>&1 && chcon --reference="$f" "$n" 2>/dev/null
    if mv -f "$n" "$f"; then
      command -v restorecon >/dev/null 2>&1 && restorecon -F "$f" 2>/dev/null
      return 0
    fi
  fi
  rm -f "$n"; echo "ERROR couldn't rewrite $1"; return 1
}
put() {  # put PATH LABEL < content: write it when it differs
  t=$(mktemp) || { echo "ERROR mktemp failed"; exit 1; }; cat > "$t"
  if [ -f "$1" ] && cmp -s "$t" "$1"; then echo "SAME $2"
  else echo "CHANGE $2"; [ "$MODE" = apply ] && { mkdir -p "${1%/*}" && replace "$1" < "$t"; }; fi
  rm -f "$t"
}
drop() {  # drop PATH LABEL: remove it if it's there
  [ -e "$1" ] || return 0
  echo "CHANGE $2"; [ "$MODE" = apply ] && rm -f "$1"
}
same() {  # same PATH LABEL N < content: whether PATH holds it from line N on (line 1 of a header names its owner)
  t=$(mktemp) || { echo "ERROR mktemp failed"; exit 1; }; tail -n +"$3" > "$t"
  if [ -f "$1" ] && tail -n +"$3" "$1" | cmp -s - "$t"; then :; else echo "DIFFERS $2"; fi
  rm -f "$t"
}
ours() { [ -f "$1" ] && head -n 1 "$1" | grep -q '^<!-- roster-mesh: written by roster for '; }
C=$HOME/.ssh/config; INC="Include $P/config"
"""

SOURCE = r"""
# another's Mesh files here (T199): compared, never written (FOREIGN; DIFFERS when they say other peers)
FOREIGN=$(whose "$P"); ours_by "$FOREIGN" && FOREIGN=
[ -n "$FOREIGN" ] && echo "FOREIGN $FOREIGN"
if [ -z "$FOREIGN" ]; then
# the Include the Mesh relies on, naming a config that isn't there (deleted by hand, a datastore gone): said (T193)
grep -qxF "$INC" "$C" 2>/dev/null && [ ! -f "$P/config" ] && echo "DANGLING $P/config"
if grep -qxF "$INC" "$C" 2>/dev/null; then echo "SAME include"
else
  echo "CHANGE include"
  if [ "$MODE" = apply ]; then
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"; t=$(mktemp)
    # the Include after an earlier mark (another directory) goes with it
    { echo "$MARK"; echo "$INC"; awk -v m="$MARK" 'd { d = 0; if (/^Include /) next } $0 == m { d = 1; next } { print }' "$C" 2>/dev/null; } > "$t"
    replace "$C" < "$t"; rm -f "$t"
  fi
fi
fi
if [ -n "$R" ] && [ -f "$R" ] && ! ours "$R"; then
  # the Host's own roster's (a roster Box too, or once was: T193), or the user's
  if head -n 1 "$R" | grep -q '^<!-- generated by roster from '; then echo "OWNMD $R"; else echo "CONFLICT $R"; fi
fi
if [ -z "$FOREIGN" ] && [ -z "$ESXI" ] && [ -d "$HOME/.claude" ]; then
  CM=$HOME/.claude/CLAUDE.md
  if grep -qxF "$IMPORT" "$CM" 2>/dev/null; then echo "SAME claude"
  else
    echo "CHANGE claude"
    if [ "$MODE" = apply ]; then
      t=$(mktemp)
      { cat "$CM" 2>/dev/null; [ -s "$CM" ] && [ -n "$(tail -c 1 "$CM")" ] && echo; echo "$IMPORT"; } > "$t"
      replace "$CM" < "$t"; rm -f "$t"
    fi
  fi
fi
"""

# A Host that's no longer a source: its Mesh files go, and its Include. The directory in use until now is the one
# the Include after roster's mark names, which isn't $P when mesh_dir: changed in the same edit (T97): roster's own
# pick goes, as $P would; a mesh_dir: is only warned about (STALE), as after a move.
NOT_SOURCE = r"""
clean() {  # clean DIR: roster's files in it; the public half goes last: until it does, mine knows the rest is roster's
  for f in id_ed25519 known_hosts config ROSTER.md id_ed25519.pub; do drop "$1/$f" "remove $f"; done
  [ "$MODE" = apply ] && rmdir "$1" 2>/dev/null
}
O=$(awk -v m="$MARK" 'p { print; exit } $0 == m { p = 1 }' "$C" 2>/dev/null)
case "$O" in "Include "/*/config) O=${O#Include }; O=${O%/config};; *) O=;; esac
if [ -n "$O" ] && [ "$(cd "$O" 2>/dev/null && pwd -P)" = "$(cd "$P" 2>/dev/null && pwd -P)" ]; then O=; fi
# only this Box's (and Inventory's) own Mesh files go: another's stay, with its Include, ROSTER.md and import (T199)
if [ -n "$P" ] && { [ -z "$MD" ] || mine "$P"; } && ours_by "$(whose "$P")"; then clean "$P"; fi
if [ -n "$O" ] && [ -f "$O/id_ed25519" ] && mine "$O" && ours_by "$(whose "$O")"; then
  OWN=
  if [ -n "$ESXI" ]; then
    case "$O" in /vmfs/volumes/*/.roster-mesh) v=${O#/vmfs/volumes/}; case "${v%/.roster-mesh}" in */*) ;; *) OWN=1;; esac;; esac
  elif [ "$O" = "$HOME/.ssh/roster-mesh" ]; then OWN=1; fi
  if [ -n "$OWN" ]; then clean "$O"; else echo "STALE $O"; fi
fi
THEIRS=
for d in "$P" "$O"; do [ -n "$d" ] && ! ours_by "$(whose "$d")" && THEIRS=1; done
FMD=; [ -z "$ESXI" ] && ours "$R" && ! ours_by "$(mdwhose "$R")" && FMD=1
if [ -z "$THEIRS" ] && grep -qxF -e "$MARK" -e "$INC" "$C" 2>/dev/null; then
  echo "CHANGE remove include"
  if [ "$MODE" = apply ]; then
    t=$(mktemp)
    awk -v m="$MARK" -v i="$INC" 'd { d = 0; if (/^Include /) next } $0 == m { d = 1; next } $0 == i { next } { print }' "$C" > "$t"
    replace "$C" < "$t"; rm -f "$t"; [ -s "$C" ] || rm -f "$C"
  fi
fi
[ -z "$ESXI" ] && [ -z "$FMD" ] && ours "$R" && drop "$R" "remove ROSTER.md"
CM=$HOME/.claude/CLAUDE.md
if [ -z "$FMD" ] && grep -qxF "$IMPORT" "$CM" 2>/dev/null; then
  echo "CHANGE remove claude"
  if [ "$MODE" = apply ]; then
    t=$(mktemp); grep -vxF "$IMPORT" "$CM" > "$t"; replace "$CM" < "$t"; rm -f "$t"; [ -s "$CM" ] || rm -f "$CM"
  fi
fi
"""

AUTHORIZED = r"""
# this Box's (and Inventory's) lines only: roster-mesh:SOURCE@OWN (T199); every other line stays as it is
TAGS=" roster-mesh:[A-Za-z0-9][A-Za-z0-9._-]*@$OWNER_RE\$"
H=$(mktemp); grep -E "$TAGS" "$AK" 2>/dev/null > "$H"
[ -n "$KEEP" ] && grep -E " roster-mesh:($KEEP)@$OWNER_RE\$" "$H" >> "$W"
# on a Host its record says it wrote on, the lines this Box wrote before: every line under an earlier owner of its
# own (RETAG, a whole ERE), and an older roster's (no Box in the tag) only when it is exactly a line this Box writes
# here, but for the tag (ADOPT, whole lines; #384); they go, and its own lines (W) take their place. Any other
# untagged line for a source it writes here may be another older Box's: it stays, and is said (UNTAGGED). A pending
# source's (KEEP) stay as they are.
OL=$(mktemp)
if [ -n "$RETAG" ]; then
  grep -E "$RETAG" "$AK" 2>/dev/null | { if [ -n "$KEEP" ]; then grep -vE " roster-mesh:($KEEP)(@[^ ]*)?\$"; else cat; fi; } > "$OL"
fi
[ -s "$ADOPT" ] && grep -xFf "$ADOPT" "$AK" 2>/dev/null >> "$OL"
if [ -n "$UNT" ]; then
  # each with its key (the field before the tag) and from=, so the Box can say when it's the key --rotate replaces
  grep -E " roster-mesh:($UNT)\$" "$AK" 2>/dev/null | { if [ -s "$OL" ]; then grep -vxFf "$OL"; else cat; fi; } \
    | while read -r l; do
      f=$(printf '%s\n' "$l" | sed -n 's/^from="\([^"]*\)".*/\1/p'); k=$(printf '%s\n' "$l" | awk '{ print $(NF-1) }')
      echo "UNTAGGED ${l##*:} $k $f"
    done
fi
grep -vxFf "$W" "$H" | while read -r l; do t=${l##*:}; echo "DROP ${t%%@*}"; done
grep -vxFf "$H" "$W" | while read -r l; do t=${l##*:}; echo "ADD ${t%%@*}"; done
while read -r l; do t=${l##*:}; echo "RETAG ${t%%@*}"; done < "$OL"
S1=$(mktemp); S2=$(mktemp); sort "$H" > "$S1"; sort "$W" > "$S2"
if [ "$MODE" = apply ] && { ! cmp -s "$S1" "$S2" || [ -s "$OL" ]; }; then
  d=${AK%/*}; mkdir -p "$d"; [ -z "$ESXI" ] && chmod 700 "$d"
  NEW=; [ -f "$AK" ] || NEW=1
  t=$(mktemp)
  if [ -s "$OL" ]; then grep -vE "$TAGS" "$AK" 2>/dev/null | grep -vxFf "$OL" > "$t"; else grep -vE "$TAGS" "$AK" 2>/dev/null > "$t"; fi
  cat "$W" >> "$t"; replace "$AK" < "$t"; rm -f "$t"
  # ESXi keeps a file under /etc across a reboot only with the sticky bit (its own keys file is 1600); cp -p keeps
  # it on a rewrite, so only a file roster makes needs it
  [ -n "$ESXI" ] && [ -n "$NEW" ] && [ -f "$AK" ] && chmod 1600 "$AK"
  [ -n "$ESXI" ] && [ -x /sbin/auto-backup.sh ] && /sbin/auto-backup.sh >/dev/null 2>&1
fi
rm -f "$H" "$W" "$S1" "$S2" "$OL" "$ADOPT"
"""


def with_mesh_dirs(cfg):
    """cfg's Hosts, each with its mesh_dir (None: roster's own pick) and seen_as (its other addresses), which
    roster.yml keeps beside them."""
    return {n: {**h, "mesh_dir": cfg.get("mesh_dirs", {}).get(n), "seen_as": cfg.get("seen_as", {}).get(n, [])}
            for n, h in cfg["hosts"].items()}


def owner_of(cfg):
    """Whose Mesh a run writes (T199, #379): this Box, as its key's tag names it (roster-managed:BOX), and BOX/NAME
    for a named Inventory. It goes in every authorized_keys line (roster-mesh:SOURCE@OWNER) and the Mesh files'
    headers, so one Box's (or Inventory's) apply, cut or --remove-leftovers never takes another's."""
    inv = current_inventory()
    return f"{cfg['box']}/{inv}" if inv else str(cfg["box"])


def owners_re(owners):
    """An ERE for the end of a roster-mesh tag written by one of OWNERS (- an older roster's: no Box in the tag)."""
    tagged = [f"@{ere(o)}" for o in owners if o != "-"]
    if not tagged:
        return ""
    return f"({'|'.join(tagged)})" + ("?" if "-" in owners else "")


def earlier_owner(cfg, st):
    """The owners this Box's Mesh entries may still carry besides owner_of(cfg), on the Hosts its record (ST's
    members) names: an older roster's (-, no Box in the tag) when the record is from before T199, or the owner of the
    last apply when it changed since (box_name:, or the Inventory named). [] when there's no record."""
    if not st["recorded"]:
        return []
    was = st["owner"] or "-"
    return [] if was == owner_of(cfg) else [was]


def preamble(h, mode, own, prev=()):
    """OWN: whose Mesh this run writes (owner_of). PREV: owners whose Mesh entries count as this run's too: what this
    Box wrote before (earlier_owner) where its record proves it wrote on the Host, or an older roster's (-) for
    --remove-leftovers and cut --all, asked first."""
    return (f"NAME={q(h['name'])}\nU={q(h['ssh']['user'])}\nMODE={mode}\nMARK={q(MARK)}\n"
            f"MD={q(h.get('mesh_dir') or '')}\nOWNER={q(own)}\nOWNER_RE={q(ere(own))}\nPREV={q(' '.join(prev))}\n"
            f"IMPORT={q(CLAUDE_IMPORT)}\n" + WHERE)


def heredoc(text):
    return f"<<'ROSTER_MESH_EOF'\n{text}ROSTER_MESH_EOF\n"


def probe_script(h, peers, mode, rotate, own, prev=()):
    """Phase 1 on a source: its key (made on apply), its public key, and whether it reaches each peer's ssh port."""
    lines = [preamble(h, mode, own, prev), f"ROTATE={1 if rotate else 0}\n", PROBE, REACH]
    lines += [f"reach {q(p['name'])} {q(p['ip'])} {p['ssh']['port']}\n" for p in peers]
    return "".join(lines) + "echo ROSTER_DONE\n"


def hop_script(peers):
    """Phase 1 on a jump Host that isn't a source: whether it reaches the ssh port of each peer it's a hop to."""
    return REACH + "".join(f"reach {q(p['name'])} {q(p['ip'])} {p['ssh']['port']}\n" for p in peers) + "echo ROSTER_DONE\n"


def write_script(h, mode, files, keys, keep, own, prev=(), adopt=()):
    """Phase 2 on any Host roster visits: as a source (FILES, {name: text}, or None to remove its source files),
    and as a peer (KEYS: the authorized_keys lines it should hold; KEEP: sources whose lines stay as they are).
    OWN: whose Mesh this is; PREV: this Box's record says it wrote on this Host before as these owners, so their
    Mesh files and their lines for the sources in KEYS are this Box's, and get its tag. An older roster's (-) line
    is taken only when it's in ADOPT: exactly a line this Box writes there (KEYS, or the line for a key --rotate
    replaces), with no Box in the tag (#384); another older Box's for the same source stays. A Host that isn't a
    source keeps an older roster's Mesh files (-): which Box made it a source isn't on record (#372's L1/L3)."""
    s = [preamble(h, mode, own, prev if files is not None else [p for p in prev if p != "-"]), WRITE]
    if files is not None:
        s.append(SOURCE)
        for name, text in files.items():
            f = f"FC=$(mktemp)\ncat > \"$FC\" {heredoc(text)}"
            if name == "ROSTER.md":
                s.append(f + 'if [ -n "$FOREIGN" ]; then { [ -n "$R" ] && { [ ! -f "$R" ] || ours "$R"; }; } '
                         f'&& same "$R" {q(name)} 2 < "$FC"\n'
                         'elif [ -n "$R" ] && { [ ! -f "$R" ] || { ours "$R" && ours_by "$(mdwhose "$R")"; }; }; '
                         f'then put "$R" {q(name)} < "$FC"; fi\nrm -f "$FC"\n')
            else:
                skip = 2 if name == "config" else 1
                s.append(f + f'if [ -n "$FOREIGN" ]; then same "$P/{name}" {q(name)} {skip} < "$FC"; '
                         f'else put "$P/{name}" {q(name)} < "$FC"; fi\nrm -f "$FC"\n')
    else:
        s.append(NOT_SOURCE)
    s.append("W=$(mktemp)\ncat > \"$W\" " + heredoc("".join(line + "\n" for line in keys)))
    s.append(f"KEEP={q('|'.join(ere(k) for k in sorted(keep)))}\n")
    retag = sorted({k.rsplit(":", 1)[1].split("@", 1)[0] for k in keys} - set(keep))
    old = "-" in prev and bool(retag)
    pattern = [f"( {TAG}:[A-Za-z0-9][A-Za-z0-9._-]*@{ere(p)}$)" for p in prev if p != "-"]
    s.append(f"RETAG={q('|'.join(pattern))}\n")
    s.append("ADOPT=$(mktemp)\ncat > \"$ADOPT\" " + heredoc("".join(line + "\n" for line in sorted(adopt)) if old else ""))
    s.append(f"UNT={q('|'.join(ere(k) for k in retag) if old else '')}\n")
    s.append(AUTHORIZED)
    return "".join(s) + "echo ROSTER_DONE\n"


def cut_script(h, host, own, owner, prev=(), everything=False):
    """On a peer: HOST's key out of authorized_keys. On HOST itself (OWN): every Mesh key out, and its own Mesh files.
    Only OWNER's (this Box's and Inventory's) lines and files (T199), and PREV's (this Box's record says it wrote
    on this Host before as them: an older roster's lines, -, or an earlier owner's lines and files); EVERYTHING (cut
    --all, asked first): an older roster's lines and files too. UNTAGGED: an older roster's line for HOST is left."""
    tag = "[A-Za-z0-9][A-Za-z0-9._-]*" if own else ere(host)
    prev = sorted({*prev, "-"}) if everything else list(prev)
    s = [preamble(h, "apply", owner, prev if everything else [p for p in prev if p != "-"]), WRITE]
    if own:
        s.append(NOT_SOURCE)
    s.append(f"""T=' roster-mesh:{tag}{owners_re([owner, *prev])}$'
if [ -f "$AK" ] && grep -qE "$T" "$AK"; then
  t=$(mktemp); grep -vE "$T" "$AK" > "$t"; replace "$AK" < "$t"; rm -f "$t"; echo "CHANGE cut"
  [ -n "$ESXI" ] && [ -x /sbin/auto-backup.sh ] && /sbin/auto-backup.sh >/dev/null 2>&1
fi
grep -qE ' roster-mesh:{tag}$' "$AK" 2>/dev/null && echo "UNTAGGED"
grep -qE "$T" "$AK" 2>/dev/null && echo "ERROR a roster-mesh line is still there" || echo ROSTER_DONE
""")
    return "".join(s)


# ---------------------------------------------------------------- running on a Host from the Box

def on_host(h, script, timeout=STEP_TIMEOUT):
    """Run SCRIPT on H over the Box's ssh (its key, roster's ssh config). Returns (report lines, None) or
    (None, why it didn't finish). The script goes as bytes: text mode on Windows would hand sh "\r\n" line ends."""
    from .sshops import not_reached
    why = not_reached(h["name"])
    if why:                             # `ssh NAME` would reach another named Inventory's Host, or nothing of ours
        return None, why
    with _ssh["lock"]:
        if _ssh["closed"]:
            return None, CLOSED
        try:
            p = subprocess.Popen(program_argv(["ssh", "-o", "BatchMode=yes", "-o", f"ConnectTimeout={CONNECT_TIMEOUT}",
                                               h["name"], "sh -s"]),
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except FileNotFoundError:
            return None, "ssh isn't installed on this Box"
        _ssh["live"].add(p)
    try:
        raw_out, raw_err = p.communicate(script.encode(), timeout=time_left(timeout))
    except subprocess.TimeoutExpired:
        kill_tree(p)
        p.communicate()
        return None, "didn't answer in time"
    finally:
        with _ssh["lock"]:
            _ssh["live"].discard(p)
    stdout, stderr = raw_out.decode(errors="replace"), raw_err.decode(errors="replace")
    lines = stdout.splitlines()
    if _ssh["closed"] and "ROSTER_DONE" not in lines:
        return None, CLOSED
    err = next((x[6:] for x in lines if x.startswith("ERROR ")), None)
    if err:
        return None, err
    if "ROSTER_DONE" not in lines:
        words = (stderr.strip().splitlines() or [f"exit {p.returncode}"])[-1]
        return None, f"no answer: {words}" if p.returncode == 255 else f"stopped part way: {words}"
    return lines, None


_ssh = {"lock": threading.Lock(), "live": set(), "closed": False}      # on_host's ssh runs now, for close()


def close():
    """serve is closing: end the ssh runs under way now (the Host's step is pending, CLOSED) and start no more.
    Each file a step writes is replaced whole (WRITE's replace), so a run cut short leaves each as before or after."""
    with _ssh["lock"]:
        _ssh["closed"] = True
        for p in _ssh["live"]:
            kill_tree(p)            # Windows: an ssh run through a batch file (ssh.cmd) is cmd.exe and its child


def report(lines, prefix):
    return [x[len(prefix):] for x in lines if x.startswith(prefix)]


# ---------------------------------------------------------------- what each source's files say

def host_key_lines(t):
    return [f"{hk_name(t)} {kt} {k.get_base64()}" for kt, k in sorted(recorded_host_keys(t).items())]


def ssh_config(cfg, src, peers, d, vias=None):
    vias = vias or {}
    out = [f"# Written by roster mesh for {src} (owner {owner_of(cfg)}) from {cfg['path'].name}: the Hosts {src} "
           "reaches. Don't edit by hand.",
           ""]
    for p in peers:
        out += [f"Host {p['name']}", f"    HostName {p['ip']}", f"    User {p['ssh']['user']}",
                f"    Port {p['ssh']['port']}"] + ([f"    ProxyJump {vias[p['name']]}"] if p["name"] in vias else [])
        out += [f"    UserKnownHostsFile {d}/known_hosts",
                "    StrictHostKeyChecking yes", f"    ConnectTimeout {CONNECT_TIMEOUT}"]
        if p["enroll"]:
            out += [f"    IdentityFile {d}/id_ed25519", "    IdentitiesOnly yes"]
        else:
            out += ["    PubkeyAuthentication no", "    PreferredAuthentications password,keyboard-interactive"]
        out.append("")
    return "\n".join(out)


def roster_md(src, peers, d, esxi, vias=None, owner=None):
    ssh = f"ssh -F {d}/config" if esxi else "ssh"
    by = f" (owner {owner})" if owner else ""
    md = [f"<!-- roster-mesh: written by roster for {src}{by}; roster mesh rewrites it, don't edit by hand -->",
          f"# Hosts {src} can reach", "",
          f"From this Host, `{ssh} <name>` logs in to the Hosts below as their own user. No password or vault is "
          "kept on this Host.", "",
          "- **access = key**: `" + ssh + " <name> '<command>'` works without a password.",
          "- **access = password**: ssh asks for the password. Never ask the user for it and never store it: ask the "
          f"user to log in themselves (`{ssh} <name>` in their own terminal).",
          "- Never read, print or copy the Mesh's private key, and ask before changing anything on another Host.", "",
          "| name | address | access |", "|---|---|---|"]
    vias = vias or {}
    md += [f"| {p['name']} | {p['ssh']['user']}@{p['ip']}:{p['ssh']['port']}"
           + (f" via {vias[p['name']]}" if p["name"] in vias else "") + f" | {'key' if p['enroll'] else 'password'} |"
           for p in peers]
    return "\n".join(md) + "\n"


def key_line(src, pub, owner, via=None):
    """The peer's authorized_keys line for SRC: from= the addresses the peer sees, VIA's when it goes through one
    (its ip: and its seen_as:), tagged roster-mesh:SRC@OWNER (T199)."""
    parts = pub.split()
    seen = via or src
    return (f"{OPTIONS.format(ip=','.join([seen['ip'], *seen.get('seen_as', [])]))} {parts[0]} {parts[1]} "
            f"{TAG}:{src['name']}@{owner}")


# ---------------------------------------------------------------- plan and apply

def check_rotate(g, rotate):
    """Problem 110 when ROTATE names a Host that isn't a Mesh source of graph G."""
    unknown = [r for r in rotate if r not in g["sources"]]
    if unknown:
        from .errors import NOT_A_SOURCE, Problem
        raise Problem(NOT_A_SOURCE, f"{', '.join(unknown)} isn't a Mesh source, so it has no Mesh key to replace",
                      {"hosts": unknown}, fix="rotate a Host that reaches peers (roster mesh --dry-run lists them)")


def not_now(stopped):
    """Why a step that hasn't started won't: serve's deadline passed, or the run was stopped (None: go on)."""
    return OUT_OF_TIME if past_deadline() else STOPPED if stopped() else None


def visits_of(cfg, hosts):
    """What a run visits: (graph, mesh.json, Hosts visited only to take away what's no longer asked for, the Links,
    {jump Host: {peer: Host}} for the hops, jump Hosts that aren't sources, every Host of phase 2)."""
    g = graph(cfg)
    st = load_state()
    # Hosts roster wrote on before and still knows how to reach: visited too, so what's no longer asked for goes
    ex = sorted(n for n in set(st["members"]) | set(st["pending"]) if n not in g["visit"] and n in hosts
                and visitable(hosts[n]))
    links = [dict(x) for x in g["links"]]
    live = {(x["from"], x["to"]) for x in links if "skip" not in x}
    hops = {}                                   # jump Host: the peers it's tested against (a hop to them)
    for x in links:
        if x.get("via") and "skip" not in x and (x["from"], x["via"]) in live:
            hops.setdefault(x["via"], {})[x["to"]] = hosts[x["to"]]
    hop_only = [n for n in sorted(set(hops) - set(g["sources"])) if visitable(hosts[n])]
    visits = sorted(set(g["visit"]) | set(ex))
    return g, st, ex, links, hops, hop_only, visits


def run(cfg, apply=False, rotate=(), say=None, progress=None, stopped=None, visits=None):
    """The Mesh as roster.yml asks for it, against what the Hosts hold now, one connection at a time.
    Plan (apply=False) changes nothing anywhere; apply makes it so and remembers what it couldn't finish.
    ROTATE: sources whose key is replaced. PROGRESS(done, total, host) is told before each Host's step and once at
    the end; STOPPED() true leaves the Hosts not yet visited pending, as serve's deadline does. VISITS: what
    visits_of(cfg, with_mesh_dirs(cfg)) said just before, so serve works out a big Mesh once for a job.
    Returns the result serve and the CLI show (docs/serve-api.md, mesh.plan)."""
    # The host-key lookups (recorded_host_keys) need paramiko: load it now, not after a stop. serve gives a stopped
    # job CLOSE_WAIT (0.8 s) to record what it didn't do; the import alone took longer on a busy box (T161).
    import paramiko  # noqa: F401
    say = say or (lambda msg: None)
    progress = progress or (lambda done, total, host: None)
    stopped = stopped or (lambda: False)
    hosts, mode = with_mesh_dirs(cfg), "apply" if apply else "check"
    g, st, ex, links, hops, hop_only, visits = visits or visits_of(cfg, hosts)
    check_rotate(g, rotate)
    gone = sorted(n for n in set(st["members"]) if n not in hosts)
    own, was, proven = owner_of(cfg), earlier_owner(cfg, st), set(st["members"])   # proven: its record says it wrote there
    out: dict[str, Any] = {"host": {}, "probe": {}, "hop": {}}
    live = {(x["from"], x["to"]) for x in links if "skip" not in x}
    steps = {"done": 0, "total": len(g["sources"]) + len(hop_only) + len(visits)}

    def step(name):
        progress(steps["done"], steps["total"], name)
        steps["done"] += 1

    def finish(name, changes, error=None):
        out["host"][name] = {"host": name, "changes": changes,
                             "status": "pending" if error else ("changed" if changes and apply else
                                                                "would-change" if changes else "same"),
                             **({"error": error} if error else {})}

    # phase 1: each source's key, and whether it reaches its peers
    for name in g["sources"]:
        peers = [hosts[x["to"]] for x in links if x["from"] == name and "skip" not in x]
        peers += [p for n, p in sorted(hops.get(name, {}).items()) if p not in peers]
        step(name)
        if why := not_now(stopped):
            out["probe"][name] = {"error": why}
            continue
        say(f"  probe  {name}")
        lines, err = on_host(hosts[name], probe_script(hosts[name], peers, mode, name in rotate, own,
                                                         was if name in proven else ()))
        if err or lines is None:
            out["probe"][name] = {"error": err}
            continue
        pub, oldpub = report(lines, "PUB "), report(lines, "OLDPUB ")
        out["probe"][name] = {"dir": report(lines, "DIR ")[0], "esxi": "PLATFORM esxi" in lines, "pub": pub[0] if pub else None,
                              "oldpub": oldpub[0] if oldpub else None,
                              "key": report(lines, "KEY "),
                              "reach": dict(x.split(" ", 1) for x in report(lines, "REACH "))}
        stale(out, name, lines)
        for d in report(lines, "OLDKEY "):
            out.setdefault("warnings", []).append(
                f"{name}: {d} still holds an older Mesh key from before mesh_dir: changed, and roster uses it again: "
                f"run roster mesh --rotate {name} to replace it")

    # jump Hosts that aren't sources: whether they reach the peers they're a hop to
    for name in hop_only:                       # a password Host isn't one: the Box can't run anything there
        step(name)
        if why := not_now(stopped):
            out["hop"][name] = {"error": why}
            continue
        say(f"  probe  {name} (a hop)")
        lines, err = on_host(hosts[name], hop_script(list(hops[name].values())))
        out["hop"][name] = {"error": err} if err else {"reach": dict(x.split(" ", 1) for x in report(lines, "REACH "))}

    # each link's status, from what the probe found
    for x in links:
        p = out["probe"].get(x["from"], {})
        t = hosts[x["to"]]
        via = x.get("via")
        hop = (out["probe"].get(via) or out["hop"].get(via) or {}) if via else {}
        if "skip" in x:
            x["status"], x["why"] = "skipped", f"{x['from']} is a password Host: roster doesn't write on it"
        elif "error" in p:
            x["status"], x["why"] = "pending", f"{x['from']}: {p['error']}"
        elif not recorded_host_keys(t):
            x["status"] = "no-host-key"
            x["why"] = f"no recorded host key for {x['to']} on this Box (roster setup --only {x['to']})"
        elif via and (x["from"], via) not in live:
            x["status"] = "no-via"
            x["why"] = (f"{x['from']} has no Link to {via}, its hop to {x['to']} "
                        f"(add {{ from: {x['from']}, to: {via} }})")
        elif via and not recorded_host_keys(hosts[via]):      # its Link to VIA isn't written: no Host VIA to jump through
            x["status"] = "no-host-key"
            x["why"] = (f"no recorded host key for {via} ({x['from']}'s hop to {x['to']}) on this Box "
                        f"(roster setup --only {via})")
        elif via and "error" in hop:
            x["status"], x["why"] = "pending", f"{via}: {hop['error']}"
        elif via and p["reach"].get(via) == "fail":
            v = hosts[via]
            x["status"] = "unreachable"
            x["why"] = f"{x['from']} can't reach {v['ip']}:{v['ssh']['port']} (its hop to {x['to']})"
        elif via and hop.get("reach", {}).get(x["to"]) == "fail":
            x["status"] = "unreachable"
            x["why"] = f"{via} can't reach {t['ip']}:{t['ssh']['port']} ({x['from']}'s hop to {x['to']})"
        elif via:
            tested = p["reach"].get(via) == "ok" and hop.get("reach", {}).get(x["to"]) == "ok"
            x["status"] = "ok" if tested else "untested"
            if not tested:
                x["why"] = f"the hop through {via} couldn't be tested (no nc or bash, or a password Host)"
        elif p["reach"].get(x["to"]) == "fail":
            x["status"], x["why"] = "unreachable", f"{x['from']} can't reach {t['ip']}:{t['ssh']['port']}"
        else:
            x["status"] = "ok" if p["reach"].get(x["to"]) == "ok" else "untested"
            if x["status"] == "untested":
                x["why"] = f"{x['from']} has no nc or bash to test the port with"
    written = [x for x in links if x["status"] in ("ok", "untested")]

    # phase 2: every Host roster visits, as a source and as a peer
    for name in visits:
        h = hosts[name]
        p = out["probe"].get(name) or {}
        step(name)
        bad = p.get("error") or out["hop"].get(name, {}).get("error")
        if bad:
            finish(name, [], bad)
            continue
        if why := not_now(stopped):
            finish(name, [], why)
            continue
        files = None
        if name in g["sources"]:
            mine = [x for x in written if x["from"] == name]
            peers = [hosts[x["to"]] for x in mine]
            vias = {x["to"]: x["via"] for x in mine if x.get("via")}
            d = p["dir"]
            files = {"known_hosts": "".join(line + "\n" for t in peers for line in host_key_lines(t)),
                     "config": ssh_config(cfg, name, peers, d, vias),
                     "ROSTER.md": roster_md(name, peers, d, p["esxi"], vias, own)}
        keys, keep, adopt = [], set(), []
        for x in links:
            if x["to"] != name or x["kind"] != "key" or "skip" in x:
                continue
            src = out["probe"].get(x["from"], {})
            if x["status"] == "pending":
                keep.add(x["from"])
            elif x["status"] in ("ok", "untested"):
                via = hosts.get(x.get("via"))
                keys.append(key_line(hosts[x["from"]], src["pub"], own, via) if src.get("pub")
                            else f"new-key {x['from']} {TAG}:{x['from']}@{own}")
                # an older roster's line this Box would write (key and options alike), only the tag without a Box
                adopt += [key_line(hosts[x["from"]], k, own, via).removesuffix(f"@{own}")
                          for k in (src.get("pub"), src.get("oldpub")) if k]
        say(f"  {'write' if apply else 'check'}  {name}")
        lines, err = on_host(h, write_script(h, mode, files, sorted(keys, key=lambda k: k.rsplit(":", 1)[1]), keep,
                                             own, was if name in proven else (), adopt))
        if err:
            finish(name, [], err)
            continue
        changes = key_changes(out["probe"].get(name), apply, name in rotate)
        added, dropped = set(report(lines, "ADD ")), set(report(lines, "DROP "))
        retag = set(report(lines, "RETAG "))
        writes = {k.rsplit(":", 1)[1].split("@", 1)[0] for k in keys}
        changes += [f"write {x}" for x in report(lines, "CHANGE ") if not x.startswith("remove ")]
        changes += [x for x in report(lines, "CHANGE ") if x.startswith("remove ")]
        changes += [f"tag key from {s} as this Box's" for s in sorted(retag & writes)]
        changes += [f"remove key from {s}" for s in sorted(retag - writes - dropped)]
        changes += [f"replace key from {s}" for s in sorted(added & dropped)]
        changes += [f"add key from {s}" for s in sorted(added - dropped - retag)]
        changes += [f"remove key from {s}" for s in sorted(dropped - added)]
        changes = [c.replace("write include", "write Include in ~/.ssh/config")
                   .replace("write claude", "write the import in ~/.claude/CLAUDE.md")
                   .replace("remove include", "remove the Include from ~/.ssh/config")
                   .replace("remove claude", "remove the import from ~/.claude/CLAUDE.md") for c in changes]
        theirs = report(lines, "FOREIGN ")
        differs = report(lines, "DIFFERS ")
        finish(name, changes, (
            f"its Mesh files ({p['dir']}) are {whose_words(theirs[0])}, and say other peers ({', '.join(differs)}): "
            "roster leaves them alone; that Box's (or Inventory's) roster.yml can add these Links")
            if theirs and differs else None)
        stale(out, name, lines)                 # a source that left with its mesh_dir: (NOT_SOURCE)
        said = set()
        for x in report(lines, "UNTAGGED "):
            src, key, frm = (x.split(" ", 2) + ["", ""])[:3]
            old = (out["probe"].get(src) or {}).get("oldpub") or ""
            if key and key in old.split()[1:2]:     # the key --rotate replaces: it still gets in from there
                out.setdefault("warnings", []).append(
                    f"{name}: a roster-mesh:{src} line with no Box in its tag still lets the replaced key in "
                    f"(from={frm or '?'}): it isn't the line this Box writes, so roster left it; remove it with "
                    "roster mesh --remove-leftovers, or rotate from the Box that wrote it")
            elif src not in said:
                said.add(src)
                out.setdefault("warnings", []).append(
                    f"{name}: a roster-mesh:{src} line with no Box in its tag isn't the one this Box writes (another "
                    "Box's, or other options), so roster left it: roster mesh --find-leftovers lists it")
        for path in report(lines, "CONFLICT "):
            out.setdefault("warnings", []).append(
                f"{name}: {path} isn't roster's, so roster left it alone (move it away and apply again)")
        for path in report(lines, "OWNMD "):
            out.setdefault("warnings", []).append(
                f"{name}: {path} is that Host's own roster's (its roster.yml is in its home folder, or was), so the "
                "Mesh left it alone: its peers are in the Mesh's ssh config; move that roster.yml to a folder of its "
                "own (or delete the file if roster is gone from there) and apply again")
        for path in report(lines, "DANGLING "):
            out.setdefault("warnings", []).append(
                f"{name}: ~/.ssh/config includes {path}, which " + ("wasn't there: roster wrote it again" if apply
                else "isn't there, so `ssh PEER` there doesn't reach its peers: roster mesh writes it again"))

    progress(steps["total"], steps["total"], None)
    result = summary(cfg, g, links, out, apply, gone)
    if apply:
        record(cfg, g, st, result, ex)
    result["cut_pending"] = load_state()["cut"] if apply else st["cut"]
    return result


def whose_words(owner):
    """Whose Mesh entries are, as words (owner: BOX, BOX/INVENTORY, or - for an older roster's)."""
    return ("an older roster's (no Box named in them), which this Box has no record of writing" if owner == "-"
            else f"another Box's or Inventory's ({owner})")


def stale(out, name, lines):
    """A warning for each earlier Mesh directory NAME's script found (STALE): roster never removes one."""
    for old in report(lines, "STALE "):
        out.setdefault("warnings", []).append(
            f"{name}: {old} holds an earlier Mesh key that roster no longer uses (mesh_dir: changed), so delete it "
            "by hand")


def key_changes(probe, apply, rotate):
    """What happens to a source's own key: [] / ["make key"] / ["replace key"]."""
    if not probe or "key" not in probe:
        return []
    k = probe["key"]
    return ["replace key"] if "rotate" in k else ["make key"] if ("made" in k or "missing" in k) else []


def summary(cfg, g, links, out, apply, gone):
    rows = [out["host"][n] for n in sorted(out["host"])]
    pending = {r["host"]: r["error"] for r in rows if r["status"] == "pending"}
    changed = any(r["changes"] for r in rows)
    warnings = list(out.get("warnings", []))
    warnings += [f"{n} left roster.yml: roster can't reach it any more, so its own Mesh files stay there"
                 for n in gone]
    return {"applied": apply, "links": links, "hosts": rows, "excluded": g["excluded"],
            "reach": {s: sum(1 for x in links if x["from"] == s and x["status"] in ("ok", "untested"))
                      for s in g["sources"]},
            "pending": pending, "already": not changed and not pending, "warnings": warnings}


def record(cfg, g, st, result, ex):
    done = {r["host"] for r in result["hosts"] if r["status"] != "pending"}
    if not result["pending"]:
        st["owner"] = owner_of(cfg)             # every Host visited carries this owner's tags now (T199)
    st["pending"] = result["pending"]
    st["members"] = sorted((set(g["visit"]) | set(result["pending"])) - (set(ex) & done))
    for host, peers in list(st["cut"].items()):
        if host in g["visit"]:
            del st["cut"][host]                 # back in the Mesh: the apply made it what roster.yml says
            continue
        st["cut"][host] = [p for p in peers if p not in done]
        if not st["cut"][host]:
            del st["cut"][host]
    st["applied"] = digest(cfg, g) if not result["pending"] else st.get("applied")
    save_state(st)


# ---------------------------------------------------------------- status and drift

BRIEF_LINKS = 1000          # Links a brief answer lists at most
BRIEF_CHANGES = 10          # changes per Host a brief answer lists at most
WORKING = (None, "ok", "untested")      # a Link that works (None: mesh.status's, not tested yet)


def no_via(links):
    """Marks the Links whose source has no Link to their `via` Host as `no-via`: that needs no connection."""
    live = {(x["from"], x["to"]) for x in links if "skip" not in x}
    for x in links:
        via = x.get("via")
        if via and "status" not in x and "skip" not in x and (x["from"], via) not in live:
            x["status"] = "no-via"
            x["why"] = f"{x['from']} has no Link to {via}, its hop to {x['to']} (add {{ from: {x['from']}, to: {via} }})"
    return links


def brief(r):
    """A mesh.status or Mesh result (brief: true, API 17) small enough for a Mesh of hundreds of Hosts, where every
    pair is a Link: `links` keeps only those worth a look (a hop, or a status other than working or skipped), at most
    BRIEF_LINKS (`links_more` counts the rest); `link_count`, `link_statuses` ({status: n}) and `reached` ({host: how
    many Hosts reach it}) say the rest, and each Host's `changes` are cut to BRIEF_CHANGES (`more` counts the rest)."""
    links = no_via([dict(x) for x in r["links"]])
    keep = [x for x in links if x.get("via") or x.get("status") not in (*WORKING, "skipped")]
    works = [x for x in links if "skip" not in x and x.get("status") in WORKING]
    out = {**r, "links": keep[:BRIEF_LINKS], "links_more": max(0, len(keep) - BRIEF_LINKS), "link_count": len(links)}
    out["link_statuses"], out["reached"], out["reach"] = {}, {}, {s: 0 for s in r.get("reach", {})}
    for x in links:
        k = x.get("status") or ("skipped" if "skip" in x else "asked")
        out["link_statuses"][k] = out["link_statuses"].get(k, 0) + 1
    for x in works:
        out["reached"][x["to"]] = out["reached"].get(x["to"], 0) + 1
        out["reach"][x["from"]] = out["reach"].get(x["from"], 0) + 1
    if "hosts" in r:
        out["hosts"] = [{**h, "changes": h["changes"][:BRIEF_CHANGES],
                         **({"more": len(h["changes"]) - BRIEF_CHANGES} if len(h["changes"]) > BRIEF_CHANGES else {})}
                        for h in r["hosts"]]
    return out


def status(cfg, grouped=False):
    """No connections: who reaches whom as roster.yml says, what's unfinished, and whether roster.yml changed the
    Mesh since the last complete apply on this Box. grouped: each meshed group once, as meshed: {group: [hosts]},
    and links only those it doesn't already cover (a pair in one meshed group without a via: hop), so a map
    of 2,000 meshed Hosts is 2,000 names and not 98,000 Links."""
    g = graph(cfg)
    st = load_state()
    links = g["links"]
    out = {"links": links, "excluded": g["excluded"], "reach": reach(g), "members": g["visit"],
           "pending": st["pending"], "cut_pending": st["cut"],
           "out_of_date": bool(g["links"] or st["members"]) and st["applied"] != digest(cfg, g)}
    if grouped:
        group_of = {n: grp for grp, names in g["meshed"].items() for n in names}
        out["links"] = [x for x in links if x.get("via") or group_of.get(x["from"]) is None
                        or group_of.get(x["from"]) != group_of.get(x["to"])]
        out["meshed"] = g["meshed"]
    return out


def drift(cfg):
    """`roster check`'s Mesh part: a plan (read-only, so it connects to each Host roster visits), or None when
    there's no Mesh. Every change it would make is drift: something on a Host isn't what roster wrote."""
    if not graph(cfg)["links"] and not load_state()["members"]:
        return None
    return run(cfg)


# ---------------------------------------------------------------- cut

def cut_hosts(cfg, name):
    """The Hosts a cut of NAME visits: its peers, then NAME itself (when roster can log in to it)."""
    hosts = with_mesh_dirs(cfg)
    h = hosts[name]
    g = graph(cfg)
    st = load_state()
    peers = sorted(n for n in (set(g["visit"]) | set(st["members"]) | set(st["cut"].get(name, [])))
                   if n in hosts and n != name and visitable(hosts[n]))
    return [(n, False) for n in peers] + ([(name, True)] if visitable(h) else [])


def cut(cfg, name, workers=16, progress=None, stopped=None):
    """HOST out of the Mesh now, in parallel: its key off every peer, every peer's key off HOST, HOST's own Mesh
    files gone. The Box's own key (roster-managed) is never touched. Returns {host, confirmed, pending: {host: why},
    warnings}: WARNINGS name an earlier mesh_dir: HOST still holds, which roster never removes.
    PROGRESS(done, total, host) is told as each Host answers; STOPPED() true leaves the Hosts not started pending."""
    progress = progress or (lambda done, total, host: None)
    stopped = stopped or (lambda: False)
    hosts = with_mesh_dirs(cfg)
    todo = cut_hosts(cfg, name)
    at = current_deadline()                     # serve's, for the worker threads too
    st = load_state()
    owner, was, proven = owner_of(cfg), earlier_owner(cfg, st), set(st["members"])

    def one(item):
        n, own = item
        with deadline_at(at):
            if why := not_now(stopped):
                return n, None, why
            lines, err = on_host(hosts[n], cut_script(hosts[n], name, own, owner, was if n in proven else ()),
                                 timeout=CUT_TIMEOUT)
        return n, lines, err

    confirmed, pending, out = [], {}, {}
    progress(0, len(todo), None)
    with cf.ThreadPoolExecutor(max(1, min(workers, len(todo)))) as ex:
        for i, (n, lines, err) in enumerate(ex.map(one, todo), 1):
            if err:
                pending[n] = err
            else:
                confirmed.append(n)
            if lines and n == name:
                stale(out, n, lines)            # HOST's own side: an earlier mesh_dir: it leaves alone
            if lines and "UNTAGGED" in lines:
                out.setdefault("warnings", []).append(
                    f"{n}: a roster-mesh:{'…' if n == name else name} line with no Box in its tag is still there: an "
                    f"older roster's, and this Box has no record of writing on {n} (roster mesh --find-leftovers "
                    "shows it; --remove-leftovers takes it off)")
            progress(i, len(todo), n)
    st = load_state()
    if pending:
        st["cut"][name] = sorted(pending)
    else:
        st["cut"].pop(name, None)
    # HOST leaves the Mesh's bookkeeping once its own part is done; its peers stay (they still hold each other's keys)
    st["members"] = sorted((set(st["members"]) - {name}) | set(pending))
    st["applied"] = None
    save_state(st)
    return {"host": name, "confirmed": sorted(confirmed), "pending": pending, "warnings": out.get("warnings", [])}


def cut_all(cfg, workers=16, progress=None, stopped=None):
    """Every Mesh entry off every Host roster.yml has that roster can log in to, at once (T193: before removing roster
    from this Box): each Host's roster-mesh lines in authorized_keys and its own Mesh files, as a cut of that Host
    does on itself. roster.yml isn't changed, so the next `roster mesh` puts the Mesh back. Returns {confirmed,
    pending: {host: why}, warnings}; the pending Hosts stay in the Mesh's bookkeeping."""
    progress = progress or (lambda done, total, host: None)
    stopped = stopped or (lambda: False)
    hosts = with_mesh_dirs(cfg)
    todo = sorted(n for n, h in hosts.items() if visitable(h))
    at = current_deadline()
    owner, was = owner_of(cfg), earlier_owner(cfg, load_state())

    def one(n):
        with deadline_at(at):
            if why := not_now(stopped):
                return n, None, why
            lines, err = on_host(hosts[n], cut_script(hosts[n], n, True, owner, was, everything=True), timeout=CUT_TIMEOUT)
        return n, lines, err

    confirmed, pending, out = [], {}, {}
    progress(0, len(todo), None)
    with cf.ThreadPoolExecutor(max(1, min(workers, len(todo)))) as ex:
        for i, (n, lines, err) in enumerate(ex.map(one, todo), 1):
            if err:
                pending[n] = err
            else:
                confirmed.append(n)
                stale(out, n, lines)
            progress(i, len(todo), n)
    st = load_state()
    done = set(confirmed)
    st["members"] = sorted((set(st["members"]) - done) | set(pending))
    st["pending"] = {n: why for n, why in st["pending"].items() if n not in done}
    for host, peers in list(st["cut"].items()):
        st["cut"][host] = [p for p in peers if p not in done]
        if not st["cut"][host]:
            del st["cut"][host]
    st["applied"] = None
    save_state(st)
    return {"confirmed": confirmed, "pending": pending, "warnings": out.get("warnings", [])}


# ---------------------------------------------------------------- leftovers (T193, #372's review B1)

# What the Mesh holds on a Host, and whose (T199): every roster-mesh line with its tag (find_leftovers keeps this
# Box's and an older roster's), and Mesh files, Include and ROSTER.md that are this Box's or an older roster's (OLD=1).
LOOK = r"""
T=' roster-mesh:[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9_/.-]+)?$'
grep -E "$T" "$AK" 2>/dev/null | while read -r l; do
  f=$(printf '%s\n' "$l" | sed -n 's/^from="\([^"]*\)".*/\1/p'); echo "LINE ${l##*:} $f"
done
seen=; INCD=$(awk -v m="$MARK" 'p { print; exit } $0 == m { p = 1 }' "$HOME/.ssh/config" 2>/dev/null | sed -n 's/^Include \(\/.*\)\/config$/\1/p')
for d in "$P" "$INCD"; do
  [ -n "$d" ] && [ -f "$d/id_ed25519.pub" ] && mine "$d" && ours_by "$(whose "$d")" || continue
  r=$(cd "$d" && pwd -P); case " $seen " in *" $r "*) continue;; esac; seen="$seen $r"; echo "FILES $(whose "$d") $d"
done
if grep -qxF "$MARK" "$HOME/.ssh/config" 2>/dev/null; then
  w=$(whose "$INCD"); ours_by "$w" && echo "INCLUDE ${w:--}"
fi
[ -z "$ESXI" ] && ours "$R" && ours_by "$(mdwhose "$R")" && echo "MD $(mdwhose "$R") $R"
echo ROSTER_DONE
"""


def leftovers_whose(r):
    """Whose the entries find_leftovers found (R) are, as words: this Box's own, and an older roster's, which may be
    another Box's or another Inventory's."""
    if any(f.get("older") for f in r["hosts"].values()):
        return ("Those with no Box in their tag are an older roster's, which didn't say whose they are, so they may "
                "be another Box's or another Inventory's Mesh, still in use; the rest are this Box's own (their tag "
                "names it), from Links this roster.yml no longer has")
    return ("They're this Box's own (their tag names it), from Links this roster.yml no longer has; another Box's or "
            "another Inventory's Mesh entries aren't listed: roster leaves them alone")


def others_here():
    """Another Inventory's Mesh state on this Box (Q172 (b)): an older roster's line (no Box in its tag) this
    roster.yml doesn't name could be that Inventory's."""
    f = state_file()
    return sorted(x.name for x in f.parent.glob("mesh*.json") if x != f)


def find_leftovers(cfg, say=None):
    """`roster mesh --find-leftovers`: on every key, reviewed Host of roster.yml, once each, one at a time, the Mesh
    entries this roster.yml doesn't ask for, found by roster's own tag and mark (read-only): this Box's (and
    Inventory's), and an older roster's (no Box in the tag; also for a source asked for, beside this Box's own line:
    #384), never
    another Box's or Inventory's (T199). Returns
    {hosts: {host: {lines: [(source, from, older)], files: [dir], include, md, older}}, pending: {host: why}}: only
    Hosts holding any; older: some of them are an older roster's."""
    say = say or (lambda msg: None)
    hosts = with_mesh_dirs(cfg)
    g = graph(cfg)
    own = owner_of(cfg)
    wanted = {}
    for x in g["links"]:
        if x["kind"] == "key" and "skip" not in x:
            wanted.setdefault(x["to"], set()).add(x["from"])
    out: dict[str, Any] = {"hosts": {}, "pending": {}}
    for name in sorted(n for n, h in hosts.items() if visitable(h)):
        say(f"  look   {name}")
        lines, err = on_host(hosts[name], preamble(hosts[name], "check", own, ["-"]) + LOOK)
        if err or lines is None:
            out["pending"][name] = err
            continue
        found: dict[str, Any] = {}
        older = False
        seen = [((x.split(" ", 1) + [""])[:2]) for x in report(lines, "LINE ")]
        tagged = {t.partition("@")[0] for t, _ in seen if t.partition("@")[2] == own}
        for tag, frm in seen:
            src, _, by = tag.partition("@")
            # an older roster's line for a source asked for here, too, once this Box's own tagged line is beside it
            # (one the one-time re-tag didn't take: not the line this Box writes, #384)
            if src not in wanted.get(name, set()) and by in ("", own) or not by and src in tagged:
                found.setdefault("lines", []).append((src, frm, not by))
                older = older or not by
        # Mesh files: on a Host that isn't a source here, this Box's or an older roster's; on a source, an older
        # roster's only (this Box's own are what it writes there)
        theirs = ("-",) if name in g["sources"] else ("-", own)
        for by, d in (x.split(" ", 1) for x in report(lines, "FILES ")):
            if by in theirs:
                found.setdefault("files", []).append(d)
                older = older or by == "-"
        if any(by in theirs for by in report(lines, "INCLUDE ")):
            found["include"] = True
            older = older or report(lines, "INCLUDE ") == ["-"]
        for by, path in (x.split(" ", 1) for x in report(lines, "MD ")):
            if by in theirs:
                found["md"] = path
                older = older or by == "-"
        if found:
            out["hosts"][name] = {**found, **({"older": True} if older else {})}
    return out


def leftover_words(found):
    """What --find-leftovers found on one Host, as words."""
    words = [f"key from {src} (from={frm or '?'})" + (", with no Box in its tag" if old else "")
             for src, frm, old in found.get("lines", [])]
    words += [f"Mesh key and files in {d}" for d in found.get("files", [])]
    words += ["the Include in ~/.ssh/config"] if found.get("include") else []
    words += [found["md"]] if found.get("md") else []
    return words


def remove_leftovers(cfg, found):
    """Remove exactly what find_leftovers FOUND, one Host at a time: the roster-mesh lines it named, and a former
    source's Mesh files and Include (as when a Host stops being a source): this Box's and an older roster's only.
    {removed: [hosts], pending: {host: why}}."""
    hosts = with_mesh_dirs(cfg)
    own = owner_of(cfg)
    out: dict[str, Any] = {"removed": [], "pending": {}}
    for name, f in sorted(found["hosts"].items()):
        h = hosts[name]
        s = [preamble(h, "apply", own, ["-"]), WRITE]
        if f.get("files") or f.get("include") or f.get("md"):
            s.append(NOT_SOURCE)
        tags = sorted({ere(src) + ("" if old else "@" + ere(own)) for src, _, old in f.get("lines", [])})
        if tags:
            s.append(f"""T=' roster-mesh:({'|'.join(tags)})$'
if [ -f "$AK" ] && grep -qE "$T" "$AK"; then
  t=$(mktemp); grep -vE "$T" "$AK" > "$t"; replace "$AK" < "$t"; rm -f "$t"
  [ -n "$ESXI" ] && [ -x /sbin/auto-backup.sh ] && /sbin/auto-backup.sh >/dev/null 2>&1
fi
grep -qE "$T" "$AK" 2>/dev/null && {{ echo "ERROR a roster-mesh line is still there"; exit 0; }}
""")
        lines, err = on_host(h, "".join(s) + "echo ROSTER_DONE\n", timeout=CUT_TIMEOUT)
        if err:
            out["pending"][name] = err
        else:
            out["removed"].append(name)
    return out


def write_cut(cfg, name):
    """`mesh: false` for Host NAME in roster.yml (edit.py: every other byte kept), so the cut survives: a Pending
    change in a repo, saved straight to a plain file (store.py, T212). {written, backup, kind} or {written: False,
    note} (already) or {written: False, error, fix}."""
    from . import edit, store
    from .errors import Problem
    if cfg["hosts"][name]["mesh"] is False:
        return {"written": False, "note": f"{name} already has mesh: false in roster.yml"}
    try:
        kept = store.at(cfg["path"])
        old, new, _ = edit.edited(kept.path, name, {"mesh": False})
        backup = kept.save(old, new)
    except Problem as e:
        return {"written": False, "error": e.message, "fix": f"set mesh: false for {name} in roster.yml by hand"}
    return {"written": True, "backup": str(backup), "kind": kept.kind}
