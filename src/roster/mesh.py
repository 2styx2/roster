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
import re
import subprocess
import threading
from shlex import quote as q
from typing import Any

from . import boxkeys, boxlock, sshconfig
from .claude import MESH_MARK
from .common import (
    NAME_ERE,
    current_deadline,
    deadline_at,
    kill_tree,
    past_deadline,
    program_argv,
    time_left,
    write_private,
)
from .context import current
from .errors import MESH_DIR_UNSAFE, MESH_KEY_PEER, MESH_WINDOWS, NOT_A_SOURCE, Problem
from .hosts import AccountLocks, is_windows
from .sshops import hk_name, not_reached, recorded_host_keys

TAG = "roster-mesh"
OPTIONS = 'from="{ip}",no-agent-forwarding,no-X11-forwarding'
CLAUDE_IMPORT = "@~/ROSTER.md"
# Decision Q176: every Mesh script is sh, which a Windows Host (os: windows) can't run
WINDOWS_LEFT_OUT = (f"[{MESH_WINDOWS}] os: windows: the Mesh's scripts are sh, which a Windows Host can't run, so it's "
                    "left out (a Link or meshed group naming it isn't an error)")


def mesh_key(h):
    """The type of source Host H's Mesh key (decision Q212): H's own key_type, as the Box's key for H is, so a
    FIPS-mode Host (which refuses Ed25519, and may not even make one) makes a key of a type it takes. boxkeys names
    its file (KeyType.mesh_file) and its ssh-keygen arguments."""
    return boxkeys.parse(h.get("key_type") or boxkeys.DEFAULT)


def key_type_warnings(cfg, links):
    """A warning (220) for each key Link from a source whose Mesh key is Ed25519 to a peer (or via: hop) whose key_type
    isn't: a FIPS-mode one refuses that key (the Link is still written: key_type: on a Host that isn't FIPS is a
    choice). Once per source and Host."""
    hosts = cfg["hosts"]
    out = []
    said = set()
    for x in links:
        a = hosts[x["from"]]
        if "skip" in x or mesh_key(a).name != boxkeys.DEFAULT:
            continue
        # the peer (a key Link's), and the via: hop, which the source's key logs in to too (#505's review L1)
        for b in [hosts[x["to"]]] * (x["kind"] == "key") + ([hosts[x["via"]]] if x.get("via") else []):
            if not b["enroll"] or mesh_key(b).name == boxkeys.DEFAULT or (a["name"], b["name"]) in said:
                continue
            said.add((a["name"], b["name"]))
            out.append(
                f"[{MESH_KEY_PEER}] {a['name']}'s Mesh key is Ed25519 (its key_type), and {b['name']}'s key_type is "
                f"{b['key_type']}: if {b['name']} is in FIPS mode it refuses that key, so the Link doesn't log in; "
                f"set key_type: {b['key_type']} on {a['name']} too (an ECDSA or RSA key works on both)")
    return out


MARK = "# roster-mesh: the Mesh's ssh config (roster mesh adds and removes these two lines)"
CONNECT_TIMEOUT = 10
STEP_TIMEOUT = 120          # s: one Host's script, at most
CUT_TIMEOUT = 30            # s: one Host's part of a cut
OUT_OF_TIME = "out of time: not visited (the next roster mesh finishes it)"   # past serve's deadline
STOPPED = "stopped: not visited (the next roster mesh finishes it)"            # mesh.stop, before it got there
CLOSED = "serve closed: stopped part way (the next roster mesh finishes it)"   # close(), mid-step


# ---------------------------------------------------------------- who reaches whom (no connections)

def graph(cfg: dict[str, Any]) -> dict[str, Any]:
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
             # the source's Mesh key type (T245): only when it isn't Ed25519, so a Mesh from before keeps its digest
             + ((t,) if (t := mesh_key(h[x["from"]]).name) != boxkeys.DEFAULT else ())
             for x in g["links"] if "skip" not in x]
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:16]


# ---------------------------------------------------------------- what the Box remembers (unfinished work)

def state_file(ctx=None):
    """The Mesh state of the Inventory CTX (default: this run's): mesh.json, or mesh-NAME.json for a named one."""
    return (ctx or current()).mesh_state


def read_state(ctx=None):
    """The Mesh state file of the Inventory CTX as it is (a dict), or None when it isn't there or doesn't load."""
    try:
        data = json.loads(state_file(ctx).read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def named_hosts(st):
    """The Host names a Mesh state ST names: its members, pending Hosts, cuts and their peers."""
    hosts = {str(h) for h in st.get("members") or []} | {str(h) for h in st.get("pending") or {}}
    for host, peers in (st.get("cut") or {}).items():
        hosts |= {str(host), *(str(p) for p in peers)}
    return hosts


def load_state(ctx=None):
    """{members: [hosts roster wrote Mesh entries on], pending: {host: why}, cut: {host: [peers not confirmed]},
    applied: digest of the last complete apply, known: whether this Box has any Mesh record (this Inventory's or
    another's)} of the Inventory CTX (default: this run's). Only bookkeeping: the Mesh itself comes from roster.yml.
    known is False on a new Box, or one where roster was removed and installed again without `roster mesh cut --all`
    first (T193): the Hosts may hold Mesh entries this Box knows nothing of, and `roster mesh leftovers` looks for
    them."""
    f = state_file(ctx)
    data = read_state(ctx) or {}
    return {"members": list(data.get("members") or []), "pending": dict(data.get("pending") or {}),
            "cut": dict(data.get("cut") or {}), "applied": data.get("applied"),
            # whose tags this Box's Mesh entries carry (owner_of): None from a roster before that (untagged)
            "owner": data.get("owner") if f.exists() else None, "recorded": f.exists(),
            # another Inventory's Mesh state here: a roster-mesh line roster.yml doesn't name could be that
            # Inventory's (Q172 (b)), so mesh leftovers --remove refuses (others_here)
            "known": f.exists() or any(f.parent.glob("mesh*.json"))}


def save_state(st):
    st = {k: v for k, v in st.items() if k not in ("known", "recorded") and (k != "owner" or v)}
    write_private(state_file(), json.dumps(st, indent=2, sort_keys=True) + "\n")


# ---------------------------------------------------------------- the scripts that run on a Host (POSIX sh)

def ere(name):
    return re.escape(name).replace("\\-", "-")


# Where things live: Linux keeps the Mesh's files in ~/.ssh/roster-mesh; ESXi's home and /etc are rebuilt at every
# boot, so there they go on a datastore (kept), and authorized_keys is ESXi's own /etc/ssh/keys-USER/ (kept).
# USER is the Login's user ($U), as sshd's %u: on a Host that names the login otherwise (`id -un`: another case, a
# directory account's form) every Mesh script stops before it reads or writes anything there, said in its ERROR line
# (that Host is pending), as setup/re-tag/revoke refuse it.
# A Host's mesh_dir: ($MD) overrides where the files go, on either; roster then only touches them there if they're
# its own (mine: a Mesh key's public half, or a config roster wrote).
WHERE = r"""
KG=$(command -v ssh-keygen 2>/dev/null || echo /usr/lib/vmware/openssh/bin/ssh-keygen)
# The Mesh keys in DIR (T245: one of any type; id_ed25519, or roster_mesh_TYPE): their names, either half there,
# space-separated. Only a name roster gives a Mesh key: a file by it is acted on only when it's tagged (below)
mkeys() {
  s=
  for f in "$1"/id_ed25519 "$1"/id_ed25519.pub "$1"/roster_mesh_*; do
    n=${f##*/}; n=${n%.pub}
    case "$n" in @MESH_FILES@) ;; *) continue;; esac
    [ -f "$1/$n" ] || [ -f "$1/$n.pub" ] || continue
    case " $s " in *" $n "*) ;; *) s="$s $n";; esac
  done
  echo $s
}
# keystate DIR K: what the Mesh key K in DIR is (#505's review H1, #509): ours (its .pub's comment is a roster-mesh: tag
# of an owner this run takes, ours_by, and its private key gives that very .pub: ssh-keygen -y, never asking for a
# passphrase), theirs (the same, but another owner's tag), half (a roster-mesh: tag, but no private key that gives it:
# none there, a passphrase on it, or another key), or not (no roster-mesh: tag: a user's own key by that name)
keystate() {
  [ -f "$1/$2.pub" ] && tp=$(cat "$1/$2.pub" 2>/dev/null) || { echo not; return; }
  tc=${tp##* }
  case "$tc" in "$TAG":*@*) to=${tc#*@};; "$TAG":*) to=-;; *) echo not; return;; esac
  ty=; [ -f "$1/$2" ] && ty=$("$KG" -y -P '' -f "$1/$2" </dev/null 2>/dev/null)
  if [ -z "$ty" ] || [ "$(printf '%s\n' "$tp" | cut -d ' ' -f 1,2)" != "$(printf '%s\n' "$ty" | cut -d ' ' -f 1,2)" ]; then
    echo half; return
  fi
  if ours_by "$to"; then echo ours; else echo theirs; fi
}
# tagged DIR K: K is a Mesh key this run may use, replace or remove (ours). Anything else by that name is left where it
# is, and said (left)
tagged() { [ "$(keystate "$1" "$2")" = ours ]; }
# left DIR K STATE: a file by a Mesh key's name that roster leaves (NOTOURS; HALF: a Mesh public key with no private
# key that gives it, #509 item 2)
left() { if [ "$3" = half ]; then echo "HALF $1/$2.pub"; else echo "NOTOURS $1/$2"; fi; }
# place SRC DEST: SRC (this run's own file, made outside the Mesh's folder: mktemp's) becomes DEST there, moved, never
# written through a name in that folder: a datastore others may write (ESXi, Q212 (k)) could hold a link planted at
# DEST or at a temp name, and the Mesh's scripts run as root there (#532's review M1). mv to a fresh random name
# beside DEST (a copy across file systems makes a new file), then a rename over DEST (a link there is replaced, not
# followed), so a run cut short leaves DEST as it was
place() {
  n=$(mktemp -u "${2%/*}/.roster-new.XXXXXX") && [ ! -e "$n" ] && [ ! -L "$n" ] && mv -f "$1" "$n" && mv -f "$n" "$2" \
    && { command -v restorecon >/dev/null 2>&1 && restorecon -F "$2" 2>/dev/null; return 0; }
  [ -n "$n" ] && [ -f "$n" ] && [ ! -L "$n" ] && rm -f "$n"; rm -f "$1"; return 1
}
mine() {
  for k in $(mkeys "$1"); do grep -qs " $TAG:" "$1/$k.pub" && return 0; done
  head -n 1 "$1/config" 2>/dev/null | grep -q '^# Written by roster mesh'
}
# Whose Mesh files are (T199, #379): the owner (BOX, or BOX/INVENTORY) their headers name. whose DIR: its config's
# header, else its key's comment; - when an older roster wrote them (no owner in them); empty with no Mesh files there.
whose() {
  ks=$(mkeys "$1")
  [ -f "$1/config" ] || [ -n "$ks" ] || return 0
  h=$(head -n 1 "$1/config" 2>/dev/null)
  case "$h" in "# Written by roster mesh for "*)
    o=$(printf '%s\n' "$h" | sed -n 's/^# Written by roster mesh for [^ ]* (owner \([^)]*\)).*/\1/p'); echo "${o:--}"; return;; esac
  for k in $ks; do
    c=$(cat "$1/$k.pub" 2>/dev/null); c=${c##* }
    case "$c" in "$TAG":*@*) echo "${c#*@}"; return;; "$TAG":*) echo -; return;; esac
  done
}
mdwhose() {  # mdwhose FILE: the owner the Mesh's ROSTER.md names, or -
  o=$(head -n 1 "$1" 2>/dev/null | sed -n "s/^$MDMARK[^ ;]* (owner \([^)]*\)).*/\1/p"); echo "${o:--}"
}
# ours_by OWNER: this run may change or remove what OWNER wrote: nothing there, this Box's (and Inventory's) own, or
# one of PREV's: what this Box wrote before (an older roster's, -, or under an earlier owner) where its record proves
# it wrote, and an older roster's for mesh leftovers --remove and cut --all (asked first)
ours_by() { [ -z "$1" ] || [ "$1" = "$OWNER" ] || case " $PREV " in *" $1 "*) true;; *) false;; esac; }
whose_words() { if [ "$1" = - ]; then echo "an older roster's (no Box named in them), which this Box has no record of writing"; else echo "another Box's or Inventory's ($1)"; fi; }
if [ "$(uname -s 2>/dev/null)" = VMkernel ]; then
  ESXI=1; AK=/etc/ssh/keys-$U/authorized_keys; R=; P=$MD
  L=$(id -un 2>/dev/null) || L=
  [ "$L" = "$U" ] || { echo "ERROR this login is ${L:-unknown} on ESXi, not $U (its user: in roster.yml), and ESXi's sshd reads its keys-${L:-LOGIN} folder: nothing was changed (set user: as the Host names it)"; echo ROSTER_DONE; exit 0; }
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
K=$P/$KF
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
    for f in $(mkeys "$P"); do
      if [ -e "$P/$f" ]; then bad " holds a $f that isn't roster's: give the Mesh a directory of its own"; fi
      bad " holds a $f.pub that isn't roster's: give the Mesh a directory of its own"
    done
    for f in known_hosts config ROSTER.md; do
      [ -e "$P/$f" ] && bad " holds a $f that isn't roster's: give the Mesh a directory of its own"
    done
  fi
  if [ -n "$ESXI" ]; then
    for v in /vmfs/volumes/*/.roster-mesh; do [ -n "$(mkeys "$v")" ] && stale "$v"; done
  elif [ -n "$(mkeys "$HOME/.ssh/roster-mesh")" ]; then stale "$HOME/.ssh/roster-mesh"; fi
fi
# Who else may write the Mesh's folder (T259, #522 item 1; decision Q212 (k)): another account that may write there could plant a
# whole key pair there, which roster would send to every peer, and a tag can't tell whose a key is (Q212 (j)).
# unsafe: one line per folder at fault, as T248 checks the session file's: the Mesh's folder itself ($P, when it's
# there) is the login's own and nobody else may write in it (sticky or not: anyone may still add a file by a name
# that isn't there yet); each one above it, up to the account's home (to / for a folder outside it), is the login's or
# root's (whoever owns it may make it writable at any time: sshd's StrictModes rule, #532's review L2) and nobody else
# may write in it unless it's sticky (as /tmp: only an entry's owner may rename or remove it). Above the path as it
# resolves and as it's written (#532's review L1: a link to a safe folder, kept in one others may write, could be
# pointed elsewhere between the check and the key's use)
fold() {  # fold DIR LAST: what's wrong with folder DIR (a real path), LAST: it's the Mesh's folder itself
  set -- "$1" "$2" $(ls -ldn "$1" 2>/dev/null)
  case "$3" in ?????w*|????????w*) w=1;; *) w=;; esac
  case "$3" in ?????????[tT]*) st=1;; *) st=;; esac
  if [ -n "$2" ] && [ -n "$5" ] && [ "$5" != "$me" ]; then
    echo "$1 isn't this account's (another user owns it): chown it to this account, or give the Mesh another mesh_dir:"
  elif [ -z "$2" ] && [ -n "$5" ] && [ "$5" != "$me" ] && [ "$5" != 0 ]; then
    echo "$1 isn't this account's or root's (another user owns it): they could make it writable and put a key pair of their own in the Mesh's place: chown it to this account or root, or give the Mesh another mesh_dir:"
  elif [ -n "$w" ] && { [ -n "$2" ] || [ -z "$st" ]; }; then
    echo "$1 is writable by others (its group or everyone$([ -n "$st" ] && echo ', sticky or not')): another account could put a key pair there that roster would send to every peer: chmod go-w $1"
  fi
}
unsafe() {
  me=$(id -u 2>/dev/null); hm=$(cd "$HOME" 2>/dev/null && pwd -P)
  if [ -d "$P" ]; then d=$(cd "$P" && pwd -P) || return 0; last=1; a=$P
  else d=$(cd "${P%/*}" 2>/dev/null && pwd -P) || return 0; last=; a=${P%/*}; fi
  while :; do     # as it resolves
    fold "$d" "$last"; last=
    [ "$d" = "$hm" ] || [ "$d" = / ] && break
    d=${d%/*}; [ -n "$d" ] || d=/
  done
  while [ "$a" != "$HOME" ] && [ "$a" != / ] && [ -n "$a" ]; do     # as it's written: each folder holding the next
    a=${a%/*}; [ -n "$a" ] || a=/
    r=$(cd "$a" 2>/dev/null && pwd -P) || continue
    fold "$r"
    [ "$r" = "$hm" ] && break
  done
}
# refused, so the source is pending and nothing is used or made there; on ESXi said (UNSAFE) and used: a datastore's
# modes are the storage's (an NFS export, vSAN), roster can't set them, and every ESXi sharing it writes there anyway
guard() {
  x=$(unsafe); [ -n "$x" ] || return 0
  if [ -n "$ESXI" ]; then printf '%s\n' "$x" | sed 's/^/UNSAFE /'
  else echo "ERROR [@UNSAFE@] $(printf '%s\n' "$x" | head -n 1)"; echo ROSTER_DONE; exit 0; fi
}
guard
# the directory the Include after roster's mark in ~/.ssh/config names: an earlier mesh_dir: (or roster's own pick)
O=$(awk -v m="$MARK" 'p { print; exit } $0 == m { p = 1 }' "$HOME/.ssh/config" 2>/dev/null)
case "$O" in "Include "/*/config) O=${O#Include }; O=${O%/config}; [ -n "$(mkeys "$O")" ] && mine "$O" && stale "$O";; esac
# a key in $P from before that earlier directory took over: roster stopped using it (and warned then), and uses
# it again now; said (OLDKEY), never replaced unasked (--rotate does). Only while that directory is still there.
case "$O" in /*) r=$(cd "$O" 2>/dev/null && pwd -P) && [ -n "$(mkeys "$P")" ] && [ "$r" != "$(cd "$P" && pwd -P)" ] && [ "$ROTATE" != 1 ] \
  && echo "OLDKEY $P";; esac
WHO=$(whose "$P")
if ! ours_by "$WHO"; then   # another's Mesh key: used as it is (its public half), never replaced or made (T199)
  [ "$ROTATE" = 1 ] && { echo "ERROR its Mesh key in $P is $(whose_words "$WHO"): roster doesn't replace it"; echo ROSTER_DONE; exit 0; }
  # of whatever type it is (T245): its owner's key_type may differ from this roster.yml's; only a whole tagged key
  # (#509: never a user's own by a Mesh key's name)
  whole() { case "$(keystate "$P" "$1")" in ours|theirs) true;; *) false;; esac; }
  if ! whole "$KF"; then
    K=; for k in $(mkeys "$P"); do whole "$k" && { K=$P/$k; break; }; done
  fi
  [ -n "$K" ] || { echo "ERROR $P holds Mesh files that are $(whose_words "$WHO"), and no key"; echo ROSTER_DONE; exit 0; }
else
  # the key of roster.yml's type (#509 item 1): used, or replaced by --rotate, only when it's one roster made: whole,
  # with a roster-mesh: tag (this Box's, or one it had before a rename or an older roster's: the folder is this Box's,
  # whose); anything else by its name is left as it is, and this source has no Mesh key until it's moved: said
  if [ -e "$K" ] || [ -e "$K.pub" ]; then
    case "$(keystate "$P" "$KF")" in
      ours|theirs) ;;
      half) echo "ERROR $K.pub is a Mesh public key with no matching private key (none there, a passphrase on it, or another key), so roster neither uses nor replaces it: delete both halves if they're roster's, or move them out of $P"; echo ROSTER_DONE; exit 0;;
      *) echo "ERROR $K isn't a Mesh key roster made (no $TAG: tag), so roster neither uses nor replaces it: move it (and $K.pub) out of $P"; echo ROSTER_DONE; exit 0;;
    esac
  fi
  # this Box's Mesh key of another type (key_type: changed since, T245): it goes, and one of $KF's type is made, as
  # --rotate replaces a key; its public half is said (OLDPUB), so an older roster's line for it is this Box's to take
  for k in $(mkeys "$P"); do
    [ "$k" = "$KF" ] && continue
    s=$(keystate "$P" "$k"); [ "$s" = ours ] || { left "$P" "$k" "$s"; continue; }   # never touched: a user's own
    [ -f "$P/$k.pub" ] && echo "OLDPUB $(cat "$P/$k.pub")"
    echo "KEY retype $k"
    [ "$MODE" = apply ] && rm -f "$P/$k" "$P/$k.pub"
  done
fi
# the key being replaced: an older roster's untagged line for it on a peer is this Box's to take too (#384)
[ "$ROTATE" = 1 ] && [ -f "$K.pub" ] && echo "OLDPUB $(cat "$K.pub")"
if [ "$ROTATE" = 1 ] && [ -f "$K" ]; then
  if [ "$MODE" = apply ]; then rm -f "$K" "$K.pub"; fi
  echo "KEY rotate"
fi
# this Box's own key under an earlier tag (a renamed Box or Host, or the owner of an earlier apply its record proves:
# ours, #522 item 3): its .pub's comment gets this run's, as Q188 re-tags authorized_keys lines; the key stays. A key
# under another owner's tag is used as it is (Q212 (j)), never re-tagged
if [ "$ROTATE" != 1 ] && [ "$K" = "$P/$KF" ] && [ -f "$K.pub" ] && ours_by "$WHO" && [ "$(keystate "$P" "$KF")" = ours ]; then
  c=$(cat "$K.pub"); case "$c" in *" $TAG:$NAME@$OWNER") ;; *)
    echo "KEY retag"
    if [ "$MODE" = apply ]; then
      t=$(mktemp) && printf '%s %s\n' "$(printf '%s\n' "$c" | cut -d ' ' -f 1,2)" "$TAG:$NAME@$OWNER" > "$t" && place "$t" "$K.pub" \
        || { echo "ERROR couldn't re-tag $K.pub as this Box's"; echo ROSTER_DONE; exit 0; }
    fi;;
  esac
fi
if [ ! -f "$K" ] || [ ! -f "$K.pub" ]; then
  if [ "$MODE" = apply ]; then
    mkdir -p "$P" || { echo "ERROR couldn't make $P"; echo ROSTER_DONE; exit 0; }
    guard           # again: a folder someone else made there since the first check (in a sticky folder) is theirs
    # made in a folder of this run's own (mktemp -d: 0700, outside the Mesh's folder), then moved into place (#532's
    # review M1): ssh-keygen never opens a name in the Mesh's folder, where a link may have been planted
    kd=$(mktemp -d) && "$KG" -q $KT -N '' -C "$TAG:$NAME@$OWNER" -f "$kd/k" </dev/null >/dev/null 2>&1 \
      && rm -f "$K" "$K.pub" && place "$kd/k" "$K" && place "$kd/k.pub" "$K.pub" \
      || { rm -rf "$kd"; echo "ERROR ssh-keygen couldn't make the Mesh's key in $P"; echo ROSTER_DONE; exit 0; }
    rm -rf "$kd"
    echo "KEY made"
  else
    echo "KEY missing"
  fi
fi
echo "KEYFILE ${K##*/}"
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
  # the temp file's name is this run's own (mktemp beside PATH, so the mv is a rename): two runs on one account at once
  # (two Host entries for it, T258) never rename each other's away; no mktemp is said, never a fixed name (#524's F3)
  command -v mktemp >/dev/null 2>&1 || { echo "ERROR this Host has no mktemp: roster needs it to rewrite $1"; return 1; }
  if n=$(mktemp "$f.roster-new.XXXXXX") && { [ ! -f "$f" ] || cp -p "$f" "$n"; } && cat > "$n"; then
    [ -f "$f" ] && command -v chcon >/dev/null 2>&1 && chcon --reference="$f" "$n" 2>/dev/null
    if mv -f "$n" "$f"; then
      command -v restorecon >/dev/null 2>&1 && restorecon -F "$f" 2>/dev/null
      return 0
    fi
  fi
  [ -n "$n" ] && rm -f "$n"; echo "ERROR couldn't rewrite $1"; return 1
}
wrote() {  # wrote RC PATH: did the command that wrote PATH's new version (exit RC) finish? grep's 1 is "no line left";
           # 2 (a read or write error: a full disk) or another command's failure leaves PATH as it was (#524's F1)
  [ "$1" -le 1 ] && return 0; echo "ERROR couldn't write the new $2 (exit $1): nothing was changed"; return 1
}
put() {  # put PATH LABEL < content: write it when it differs; a failed write (a full disk) changes nothing (#524)
  t=$(mktemp) || { echo "ERROR mktemp failed"; exit 1; }
  cat > "$t" || { rm -f "$t"; echo "ERROR couldn't write the new $1: nothing was changed"; return 1; }
  if [ -f "$1" ] && cmp -s "$t" "$1"; then echo "SAME $2"
  else
    echo "CHANGE $2"
    if [ "$MODE" = apply ]; then
      case "$1" in    # the Mesh's own files are placed (never through a planted name: #532's review M1)
        "$P"/*) mkdir -p "$P" && { place "$t" "$1" || echo "ERROR couldn't write $1"; };;
        *) mkdir -p "${1%/*}" && replace "$1" < "$t";;
      esac
    fi
  fi
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
ours() { [ -f "$1" ] && head -n 1 "$1" | grep -q "^$MDMARK"; }
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
    # set -e in the subshell: each command's failure counts, not only the last's
    rc=0; ( set -e; echo "$MARK"; echo "$INC"; [ ! -f "$C" ] || awk -v m="$MARK" 'd { d = 0; if (/^Include /) next } $0 == m { d = 1; next } { print }' "$C" ) > "$t" || rc=2
    wrote $rc "$C" && replace "$C" < "$t"; rm -f "$t"
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
      rc=0; ( set -e; [ ! -f "$CM" ] || cat "$CM"; if [ -s "$CM" ] && [ -n "$(tail -c 1 "$CM")" ]; then echo; fi; echo "$IMPORT" ) > "$t" || rc=2
      wrote $rc "$CM" && replace "$CM" < "$t"; rm -f "$t"
    fi
  fi
fi
"""

# A Host that's no longer a source: its Mesh files go, and its Include. The directory in use until now is the one
# the Include after roster's mark names, which isn't $P when mesh_dir: changed in the same edit: roster's own
# pick goes, as $P would; a mesh_dir: is only warned about (STALE), as after a move.
NOT_SOURCE = r"""
clean() {  # clean DIR: roster's files in it (a key of any type, T245, only one it made: tagged, #505's H1); the public
           # halves go last: until they do, mine knows the rest is roster's
  ks=; for k in $(mkeys "$1"); do s=$(keystate "$1" "$k"); if [ "$s" = ours ]; then ks="$ks $k"; else left "$1" "$k" "$s"; fi; done
  for k in $ks; do drop "$1/$k" "remove $k"; done
  for f in known_hosts config ROSTER.md; do drop "$1/$f" "remove $f"; done
  for k in $ks; do drop "$1/$k.pub" "remove $k.pub"; done
  [ "$MODE" = apply ] && rmdir "$1" 2>/dev/null
}
O=$(awk -v m="$MARK" 'p { print; exit } $0 == m { p = 1 }' "$C" 2>/dev/null)
case "$O" in "Include "/*/config) O=${O#Include }; O=${O%/config};; *) O=;; esac
if [ -n "$O" ] && [ "$(cd "$O" 2>/dev/null && pwd -P)" = "$(cd "$P" 2>/dev/null && pwd -P)" ]; then O=; fi
# only this Box's (and Inventory's) own Mesh files go: another's stay, with its Include, ROSTER.md and import (T199)
if [ -n "$P" ] && { [ -z "$MD" ] || mine "$P"; } && ours_by "$(whose "$P")"; then clean "$P"; fi
if [ -n "$O" ] && [ -n "$(mkeys "$O")" ] && mine "$O" && ours_by "$(whose "$O")"; then
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
    rc=0; awk -v m="$MARK" -v i="$INC" 'd { d = 0; if (/^Include /) next } $0 == m { d = 1; next } $0 == i { next } { print }' "$C" > "$t" || rc=2
    wrote $rc "$C" && replace "$C" < "$t" && { [ -s "$C" ] || rm -f "$C"; }; rm -f "$t"
  fi
fi
[ -z "$ESXI" ] && [ -z "$FMD" ] && ours "$R" && drop "$R" "remove ROSTER.md"
CM=$HOME/.claude/CLAUDE.md
if [ -z "$FMD" ] && grep -qxF "$IMPORT" "$CM" 2>/dev/null; then
  echo "CHANGE remove claude"
  if [ "$MODE" = apply ]; then
    t=$(mktemp); rc=0; grep -vxF "$IMPORT" "$CM" > "$t" || rc=$?
    wrote $rc "$CM" && replace "$CM" < "$t" && { [ -s "$CM" ] || rm -f "$CM"; }; rm -f "$t"
  fi
fi
"""

AUTHORIZED = r"""
# this Box's (and Inventory's) lines only: roster-mesh:SOURCE@OWN (T199); every other line stays as it is
TAGS=" $TAG:$NAME_ERE@$OWNER_RE\$"
H=$(mktemp); grep -E "$TAGS" "$AK" 2>/dev/null > "$H"
[ -n "$KEEP" ] && grep -E " $TAG:($KEEP)@$OWNER_RE\$" "$H" >> "$W"
# on a Host its record says it wrote on, the lines this Box wrote before: every line under an earlier owner of its
# own (RETAG, a whole ERE), and an older roster's (no Box in the tag) only when it is exactly a line this Box writes
# here, but for the tag (ADOPT, whole lines; #384); they go, and its own lines (W) take their place. Any other
# untagged line for a source it writes here may be another older Box's: it stays, and is said (UNTAGGED). A pending
# source's (KEEP) stay as they are.
OL=$(mktemp)
if [ -n "$RETAG" ]; then
  grep -E "$RETAG" "$AK" 2>/dev/null | { if [ -n "$KEEP" ]; then grep -vE " $TAG:($KEEP)(@[^ ]*)?\$"; else cat; fi; } > "$OL"
fi
[ -s "$ADOPT" ] && grep -xFf "$ADOPT" "$AK" 2>/dev/null >> "$OL"
if [ -n "$UNT" ]; then
  # each with its key (the field before the tag) and from=, so the Box can say when it's the key --rotate replaces
  grep -E " $TAG:($UNT)\$" "$AK" 2>/dev/null | { if [ -s "$OL" ]; then grep -vxFf "$OL"; else cat; fi; } \
    | while read -r l; do
      f=$(printf '%s\n' "$l" | sed -n 's/^from="\([^"]*\)".*/\1/p'); k=$(printf '%s\n' "$l" | awk '{ print $(NF-1) }')
      echo "UNTAGGED ${l##*:} $k $f"
    done
fi
grep -vxFf "$W" "$H" | while read -r l; do t=${l##*:}; echo "DROP ${t%%@*}"; done
# each with its key and from=, so the Box can say when its line is for a key the source no longer has (T217); the
# lines this Box wrote before (OL: under an earlier owner, #435) too
{ grep -vxFf "$W" "$H"; cat "$OL"; } | while read -r l; do
  t=${l##*:}; f=$(printf '%s\n' "$l" | sed -n 's/^from="\([^"]*\)".*/\1/p'); k=$(printf '%s\n' "$l" | awk '{ print $(NF-1) }')
  echo "OLDLINE ${t%%@*} $k $f"
done
grep -vxFf "$H" "$W" | while read -r l; do t=${l##*:}; echo "ADD ${t%%@*}"; done
while read -r l; do t=${l##*:}; echo "RETAG ${t%%@*}"; done < "$OL"
S1=$(mktemp); S2=$(mktemp); sort "$H" > "$S1"; sort "$W" > "$S2"
if [ "$MODE" = apply ] && { ! cmp -s "$S1" "$S2" || [ -s "$OL" ]; }; then
  d=${AK%/*}; mkdir -p "$d"; [ -z "$ESXI" ] && chmod 700 "$d"
  NEW=; [ -f "$AK" ] || NEW=1
  t=$(mktemp); u=$(mktemp); rc=0
  # each step's failure counted (#524's F1): a sh pipeline would say only its last command's
  [ ! -f "$AK" ] || grep -vE "$TAGS" "$AK" > "$u" || rc=$?
  if [ "$rc" -le 1 ]; then
    if [ -s "$OL" ]; then grep -vxFf "$OL" "$u" > "$t" || { r=$?; [ $r -le 1 ] || rc=$r; }; else cat "$u" > "$t" || rc=2; fi
  fi
  [ "$rc" -le 1 ] && { cat "$W" >> "$t" || rc=2; }
  wrote $rc "$AK" && replace "$AK" < "$t"; rm -f "$t" "$u"
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
    headers, so one Box's (or Inventory's) apply, cut or mesh leftovers --remove never takes another's."""
    inv = current().name
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
    mesh leftovers --remove and cut --all, asked first."""
    kt = mesh_key(h)                # its Mesh key's file name and ssh-keygen arguments (KT: words, no quotes)
    return (f"TAG={q(TAG)}\nNAME_ERE={q(NAME_ERE)}\nMDMARK={q(MESH_MARK)}\n"
            f"NAME={q(h['name'])}\nU={q(h['ssh']['user'])}\nMODE={mode}\nMARK={q(MARK)}\n"
            f"MD={q(h.get('mesh_dir') or '')}\nOWNER={q(own)}\nOWNER_RE={q(ere(own))}\nPREV={q(' '.join(prev))}\n"
            f"KF={q(kt.mesh_file)}\nKT={q(' '.join(kt.keygen_args()))}\n"
            f"IMPORT={q(CLAUDE_IMPORT)}\n" + WHERE.replace("@MESH_FILES@", boxkeys.MESH_FILES))


def stash(var, text):
    """VAR=$(mktemp) holding TEXT, or the script stops there, said: a temporary file written in part (a full disk)
    is never what a later step puts in place (#524's second pass)."""
    return (f'{var}=$(mktemp)\ncat > "${var}" <<\'ROSTER_MESH_EOF\' || {{ echo "ERROR couldn\'t write a temporary file '
            f'on this Host (a full disk?)"; exit 1; }}\n{text}ROSTER_MESH_EOF\n')


def probe_script(h, peers, mode, rotate, own, prev=()):
    """Phase 1 on a source: its key (made on apply), its public key, and whether it reaches each peer's ssh port."""
    lines = [preamble(h, mode, own, prev), f"ROTATE={1 if rotate else 0}\n",
             PROBE.replace("@UNSAFE@", str(MESH_DIR_UNSAFE)), REACH]
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
            f = stash("FC", text)
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
    s.append(stash("W", "".join(line + "\n" for line in keys)))
    s.append(f"KEEP={q('|'.join(ere(k) for k in sorted(keep)))}\n")
    retag = sorted({k.rsplit(":", 1)[1].split("@", 1)[0] for k in keys} - set(keep))
    old = "-" in prev and bool(retag)
    pattern = [f"( {TAG}:{NAME_ERE}@{ere(p)}$)" for p in prev if p != "-"]
    s.append(f"RETAG={q('|'.join(pattern))}\n")
    s.append(stash("ADOPT", "".join(line + "\n" for line in sorted(adopt)) if old else ""))
    s.append(f"UNT={q('|'.join(ere(k) for k in retag) if old else '')}\n")
    s.append(AUTHORIZED)
    return "".join(s) + "echo ROSTER_DONE\n"


def cut_script(h, host, own, owner, prev=(), everything=False):
    """On a peer: HOST's key out of authorized_keys. On HOST itself (OWN): every Mesh key out, and its own Mesh files.
    Only OWNER's (this Box's and Inventory's) lines and files (T199), and PREV's (this Box's record says it wrote
    on this Host before as them: an older roster's lines, -, or an earlier owner's lines and files); EVERYTHING (cut
    --all, asked first): an older roster's lines and files too. UNTAGGED: an older roster's line for HOST is left."""
    tag = NAME_ERE if own else ere(host)
    prev = sorted({*prev, "-"}) if everything else list(prev)
    s = [preamble(h, "apply", owner, prev if everything else [p for p in prev if p != "-"]), WRITE]
    if own:
        s.append(NOT_SOURCE)
    s.append(f"""T=' {TAG}:{tag}{owners_re([owner, *prev])}$'
if [ -f "$AK" ] && grep -qE "$T" "$AK"; then
  t=$(mktemp); rc=0; grep -vE "$T" "$AK" > "$t" || rc=$?; wrote $rc "$AK" && replace "$AK" < "$t"; rm -f "$t"
  echo "CHANGE cut"
  [ -n "$ESXI" ] && [ -x /sbin/auto-backup.sh ] && /sbin/auto-backup.sh >/dev/null 2>&1
fi
grep -qE ' {TAG}:{tag}$' "$AK" 2>/dev/null && echo "UNTAGGED"
grep -qE "$T" "$AK" 2>/dev/null && echo "ERROR a roster-mesh line is still there" || echo ROSTER_DONE
""")
    return "".join(s)


# ---------------------------------------------------------------- running on a Host from the Box

def on_host(h, script, timeout=STEP_TIMEOUT):
    """Run SCRIPT on H over the Box's ssh (its key, roster's ssh config). Returns (report lines, None) or
    (None, why it didn't finish). The script goes as bytes: text mode on Windows would hand sh "\r\n" line ends."""
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


def ssh_config(cfg, src, peers, d, vias=None, key="id_ed25519"):
    """SRC's Mesh ssh config: KEY is its Mesh key's file name in D (the probe's KEYFILE: its key_type's, T245)."""
    vias = vias or {}
    out = [f"# Written by roster mesh for {src} (owner {owner_of(cfg)}) from {cfg['path'].name}: the Hosts {src} "
           "reaches. Don't edit by hand.",
           ""]
    for p in peers:
        opts = [("HostName", p["ip"]), ("User", p["ssh"]["user"]), ("Port", p["ssh"]["port"])]
        opts += [("ProxyJump", vias[p["name"]])] if p["name"] in vias else []
        opts += [("UserKnownHostsFile", f"{d}/known_hosts"), ("StrictHostKeyChecking", "yes"),
                 ("ConnectTimeout", CONNECT_TIMEOUT)]
        if p["enroll"]:
            opts += [("IdentityFile", f"{d}/{key}"), ("IdentitiesOnly", "yes")]
        else:
            opts += [("PubkeyAuthentication", "no"), ("PreferredAuthentications", "password,keyboard-interactive")]
        out += sshconfig.host_block(p["name"], opts) + [""]
    return "\n".join(out)


def roster_md(src, peers, d, esxi, vias=None, owner=None):
    ssh = f"ssh -F {d}/config" if esxi else "ssh"
    by = f" (owner {owner})" if owner else ""
    md = [f"{MESH_MARK}{src}{by}; roster mesh rewrites it, don't edit by hand -->",
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



@boxlock.locking("mesh", unless=lambda cfg, apply=False, *_, **__: not apply)     # a plan changes nothing
def run(cfg, apply=False, rotate=(), say=None, progress=None, stopped=None, visits=None):
    """The Mesh as roster.yml asks for it, against what the Hosts hold now, one connection at a time.
    Plan (apply=False) changes nothing anywhere; apply makes it so and remembers what it couldn't finish.
    ROTATE: sources whose key is replaced. PROGRESS(done, total, host) is told before each Host's step and once at
    the end; STOPPED() true leaves the Hosts not yet visited pending, as serve's deadline does. VISITS: what
    visits_of(cfg, with_mesh_dirs(cfg)) said just before, so serve works out a big Mesh once for a job.
    Returns the result serve and the CLI show (docs/serve-api.md, mesh.plan)."""
    # The host-key lookups (recorded_host_keys) need paramiko: load it now, not after a stop. serve gives a stopped
    # job CLOSE_WAIT (0.8 s) to record what it didn't do; the import alone took longer on a busy box.
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
        keyfile = report(lines, "KEYFILE ")
        out["probe"][name] = {"dir": report(lines, "DIR ")[0], "esxi": "PLATFORM esxi" in lines, "pub": pub[0] if pub else None,
                              "oldpub": oldpub[0] if oldpub else None, "oldpubs": oldpub,
                              "keyfile": keyfile[0] if keyfile else mesh_key(hosts[name]).mesh_file,
                              "key": report(lines, "KEY "),
                              "reach": dict(x.split(" ", 1) for x in report(lines, "REACH "))}
        stale(out, name, lines)
        not_ours(out, name, lines)
        for x in dict.fromkeys(report(lines, "UNSAFE ")):    # ESXi only: elsewhere the probe refused (222)
            out.setdefault("warnings", []).append(
                f"[{MESH_DIR_UNSAFE}] {name}: {x} (ESXi: roster uses it anyway, as a datastore's permissions are its "
                "storage's)")
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
            x["why"] = f"no recorded host key for {x['to']} on this Box (roster setup --host {x['to']})"
        elif via and (x["from"], via) not in live:
            x["status"] = "no-via"
            x["why"] = (f"{x['from']} has no Link to {via}, its hop to {x['to']} "
                        f"(add {{ from: {x['from']}, to: {via} }})")
        elif via and not recorded_host_keys(hosts[via]):      # its Link to VIA isn't written: no Host VIA to jump through
            x["status"] = "no-host-key"
            x["why"] = (f"no recorded host key for {via} ({x['from']}'s hop to {x['to']}) on this Box "
                        f"(roster setup --host {via})")
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
                     "config": ssh_config(cfg, name, peers, d, vias, p["keyfile"]),
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
                          for k in (src.get("pub"), *src.get("oldpubs", ())) if k]
        say(f"  {'write' if apply else 'check'}  {name}")
        lines, err = on_host(h, write_script(h, mode, files, sorted(keys, key=lambda k: k.rsplit(":", 1)[1]), keep,
                                             own, was if name in proven else (), adopt))
        if err:
            finish(name, [], err)
            continue
        changes = key_changes(out["probe"].get(name), apply, name in rotate, mesh_key(h).name)
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
        not_ours(out, name, lines)
        said = set()
        for x in report(lines, "UNTAGGED "):
            src, key, frm = (x.split(" ", 2) + ["", ""])[:3]
            olds = (out["probe"].get(src) or {}).get("oldpubs") or []
            if key and any(key in old.split()[1:2] for old in olds):    # the key --rotate (or a type change) replaces
                out.setdefault("warnings", []).append(
                    f"{name}: a roster-mesh:{src} line with no Box in its tag still lets the replaced key in "
                    f"(from={frm or '?'}): it isn't the line this Box writes, so roster left it; remove it with "
                    "roster mesh leftovers --remove, or rotate from the Box that wrote it")
            elif src not in said:
                said.add(src)
                out.setdefault("warnings", []).append(
                    f"{name}: a roster-mesh:{src} line with no Box in its tag isn't the one this Box writes (another "
                    "Box's, or other options), so roster left it: roster mesh leftovers lists it")
        if not apply:       # the source's key changed since (another Box rotated or cut it): it still gets in
            for x in report(lines, "OLDLINE "):
                src, key, frm = (x.split(" ", 2) + ["", ""])[:3]
                now = ((out["probe"].get(src) or {}).get("pub") or "").split()[1:2]
                if src in writes and src not in rotate and key and [key] != now and "error" not in out["probe"].get(src, {}):
                    out.setdefault("warnings", []).append(
                        f"{name}: this Box's line for {src}'s Mesh key is for a key {src} no longer has (replaced or "
                        f"removed since, as by the Box whose Mesh files they are), and it still lets that key in "
                        f"(from={frm or '?'}) until this Box's next roster mesh replaces it")
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
    out.setdefault("warnings", []).extend(key_type_warnings(cfg, links))
    result = summary(cfg, g, links, out, apply, gone)
    if apply:
        record(cfg, g, st, result, ex)
    result["cut_pending"] = load_state()["cut"] if apply else st["cut"]
    return result


def whose_words(owner):
    """Whose Mesh entries are, as words (owner: BOX, BOX/INVENTORY, or - for an older roster's)."""
    return ("an older roster's (no Box named in them), which this Box has no record of writing" if owner == "-"
            else f"another Box's or Inventory's ({owner})")


def not_ours(out, name, lines):
    """A warning for each file by a Mesh key's name that NAME's script left because roster didn't make it (#505's H1),
    or because it's a Mesh public key with no private key that gives it (HALF, #509 item 2)."""
    for path in dict.fromkeys(report(lines, "NOTOURS ")):
        out.setdefault("warnings", []).append(
            f"{name}: {path} isn't a Mesh key roster made (no roster-mesh: tag of this Box's), so roster left it there; "
            "move it out of the Mesh's directory")
    for path in dict.fromkeys(report(lines, "HALF ")):
        out.setdefault("warnings", []).append(
            f"{name}: a Mesh public key with no matching private key was left: {path} (its private key isn't there, "
            "has a passphrase, or is another key); delete it, and its private key if that's roster's too")


def stale(out, name, lines):
    """A warning for each earlier Mesh directory NAME's script found (STALE): roster never removes one."""
    for old in report(lines, "STALE "):
        out.setdefault("warnings", []).append(
            f"{name}: {old} holds an earlier Mesh key that roster no longer uses (mesh_dir: changed), so delete it "
            "by hand")


def key_changes(probe, apply, rotate, kind=boxkeys.DEFAULT):
    """What happens to a source's own key: [] / ["make key"] / ["replace key"] / ["re-tag key as this Box's"] (its
    .pub's comment, #522 item 3); a key of another type than KIND (its key_type) is replaced by one of KIND (T245)."""
    if not probe or "key" not in probe:
        return []
    k = probe["key"]
    old = next((x.removeprefix("retype ") for x in k if x.startswith("retype ")), None)
    if old is not None:     # the old key's type, from its file name (id_ed25519, roster_mesh_TYPE)
        was = "ed25519" if old == "id_ed25519" else old.removeprefix("roster_mesh_")
        return [f"replace key ({was} -> {kind}, its key_type)"]
    if "rotate" in k:
        return ["replace key"]
    return ["make key"] if ("made" in k or "missing" in k) else ["re-tag key as this Box's"] if "retag" in k else []


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
        st["owner"] = owner_of(cfg)             # every Host visited carries this owner's tags now
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


def status(cfg: dict[str, Any], grouped: bool = False) -> dict[str, Any]:
    """No connections: who reaches whom as roster.yml says, what's unfinished, and whether roster.yml changed the
    Mesh since the last complete apply on this Box. grouped: each meshed group once, as meshed: {group: [hosts]},
    and links only those it doesn't already cover (a pair in one meshed group without a via: hop), so a map
    of 2,000 meshed Hosts is 2,000 names and not 98,000 Links."""
    g = graph(cfg)
    st = load_state()
    links = g["links"]
    out = {"links": links, "excluded": g["excluded"], "reach": reach(g), "members": g["visit"],
           "pending": st["pending"], "cut_pending": st["cut"],
           "out_of_date": bool(g["links"] or st["members"]) and st["applied"] != digest(cfg, g),
           # 220 from roster.yml alone (#509 item 6), as the plan, apply and check say it
           "warnings": key_type_warnings(cfg, links)}
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



@boxlock.locking("mesh cut")
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

    turn = AccountLocks()                       # Host entries that share an account take turns (T258)

    def one(item):
        n, own = item
        with deadline_at(at), turn(hosts[n]):
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
                not_ours(out, n, lines)
            if lines and "UNTAGGED" in lines:
                out.setdefault("warnings", []).append(
                    f"{n}: a roster-mesh:{'…' if n == name else name} line with no Box in its tag is still there: an "
                    f"older roster's, and this Box has no record of writing on {n} (roster mesh leftovers "
                    "shows it; mesh leftovers --remove takes it off)")
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



@boxlock.locking("mesh cut --all")
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

    turn = AccountLocks()                       # Host entries that share an account take turns (T258)

    def one(n):
        with deadline_at(at), turn(hosts[n]):
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
                not_ours(out, n, lines)
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


# ---------------------------------------------------------------- leftovers

# What the Mesh holds on a Host, and whose: every roster-mesh line with its tag (find_leftovers keeps this
# Box's and an older roster's), and Mesh files, Include and ROSTER.md that are this Box's or an older roster's (OLD=1).
LOOK = r"""
T=" $TAG:$NAME_ERE(@[A-Za-z0-9_/.-]+)?\$"
grep -E "$T" "$AK" 2>/dev/null | while read -r l; do
  f=$(printf '%s\n' "$l" | sed -n 's/^from="\([^"]*\)".*/\1/p'); echo "LINE ${l##*:} $f"
done
seen=; INCD=$(awk -v m="$MARK" 'p { print; exit } $0 == m { p = 1 }' "$HOME/.ssh/config" 2>/dev/null | sed -n 's/^Include \(\/.*\)\/config$/\1/p')
for d in "$P" "$INCD"; do
  [ -n "$d" ] && [ -n "$(mkeys "$d")" ] && mine "$d" && ours_by "$(whose "$d")" || continue
  r=$(cd "$d" && pwd -P); case " $seen " in *" $r "*) continue;; esac; seen="$seen $r"; echo "FILES $(whose "$d") $d"
done
if grep -qxF "$MARK" "$HOME/.ssh/config" 2>/dev/null; then
  w=$(whose "$INCD"); ours_by "$w" && echo "INCLUDE ${w:--}"
fi
[ -z "$ESXI" ] && ours "$R" && ours_by "$(mdwhose "$R")" && echo "MD $(mdwhose "$R") $R"
# a file by a Mesh key's name in a folder the Mesh uses that isn't a key roster made (#509 item 5): a user's own, or a
# public half with no private key that gives it; said (STRAY), never removed
seen=
for d in "$P" "$INCD"; do
  [ -n "$d" ] && [ -d "$d" ] && mine "$d" || continue
  r=$(cd "$d" && pwd -P); case " $seen " in *" $r "*) continue;; esac; seen="$seen $r"
  for k in $(mkeys "$d"); do
    case "$(keystate "$d" "$k")" in half) echo "STRAY $d/$k.pub";; not) echo "STRAY $d/$k";; esac
  done
done
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
    """`roster mesh leftovers`: on every key, reviewed Host of roster.yml, once each, one at a time, the Mesh
    entries this roster.yml doesn't ask for, found by roster's own tag and mark (read-only): this Box's (and
    Inventory's), and an older roster's (no Box in the tag; also for a source asked for, beside this Box's own line:
    #384), never
    another Box's or Inventory's (T199). Returns
    {hosts: {host: {lines: [(source, from, older)], files: [dir], include, md, older}}, pending: {host: why},
    strays: {host: [path]}}: only Hosts holding any; older: some of them are an older roster's. strays (#509 item 5):
    files by a Mesh key's name in a folder the Mesh uses that aren't a key roster made (a .pub: a Mesh public key with
    no private key that gives it), which remove_leftovers never takes: only said."""
    say = say or (lambda msg: None)
    hosts = with_mesh_dirs(cfg)
    g = graph(cfg)
    own = owner_of(cfg)
    wanted = {}
    for x in g["links"]:
        if x["kind"] == "key" and "skip" not in x:
            wanted.setdefault(x["to"], set()).add(x["from"])
    out: dict[str, Any] = {"hosts": {}, "pending": {}, "strays": {}}
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
            # (one the one-time re-tag didn't take: not the line this Box writes)
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
        if strays := report(lines, "STRAY "):
            out["strays"][name] = strays
    return out


def stray_words(path):
    """A file find_leftovers found by a Mesh key's name that isn't roster's (#509 item 5), as words."""
    if path.endswith(".pub"):
        return (f"{path} is a Mesh public key with no matching private key, so mesh leftovers --remove leaves it: "
                "delete it, and its private key if that's roster's too")
    return f"{path} isn't a Mesh key roster made, so mesh leftovers --remove leaves it: move it out of the Mesh's directory"


def leftover_words(found):
    """What mesh leftovers found on one Host, as words."""
    words = [f"key from {src} (from={frm or '?'})" + (", with no Box in its tag" if old else "")
             for src, frm, old in found.get("lines", [])]
    words += [f"Mesh key and files in {d}" for d in found.get("files", [])]
    words += ["the Include in ~/.ssh/config"] if found.get("include") else []
    words += [found["md"]] if found.get("md") else []
    return words



@boxlock.locking("mesh leftovers --remove")
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
            s.append(f"""T=' {TAG}:({'|'.join(tags)})$'
if [ -f "$AK" ] && grep -qE "$T" "$AK"; then
  t=$(mktemp); rc=0; grep -vE "$T" "$AK" > "$t" || rc=$?; wrote $rc "$AK" && replace "$AK" < "$t"; rm -f "$t"
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


def write_cut(cfg, name, sync=None):
    """`mesh: false` for Host NAME in roster.yml (edit.py: every other byte kept), so the cut survives: a Pending
    change in a repo, saved straight to a plain file (store.py, T212), then this Box's sync, SYNC() (store's write;
    default: from the file). {written, backup, kind, sync} or {written: False, note} (already) or {written: False,
    error, fix}."""
    from . import edit, store
    if cfg["hosts"][name]["mesh"] is False:
        return {"written": False, "note": f"{name} already has mesh: false in roster.yml"}
    try:
        kept = store.at(cfg["path"], hidden=bool(cfg.get("hidden")))
        old, new, _ = edit.edited(kept.path, name, {"mesh": False})
        backup, synced = kept.write(old, new, sync=sync)
    except Problem as e:
        return {"written": False, "error": e.message, "fix": f"set mesh: false for {name} in roster.yml by hand"}
    return {"written": True, "backup": str(backup), "kind": kept.kind, "sync": synced}
