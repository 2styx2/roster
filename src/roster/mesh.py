"""The Mesh (decision Q63, ticket 39): Host-to-Host access that roster sets up from one Box, with nothing
installed on the Hosts. roster.yml says who may reach whom (`mesh: true` per group, `links:`); this module turns
that into what each Host needs, and makes it so over the Box's own ssh, one connection at a time:

- on each source Host: a key made there (the private key never leaves it), the peers' recorded host keys, an ssh
  config so `ssh PEER` works, and a ROSTER.md of its peers for Claude (imported from ~/.claude/CLAUDE.md);
- on each peer: the source's public key in authorized_keys, tagged `roster-mesh:SOURCE`, with `from="SOURCE IP"`
  and no agent or X11 forwarding.

Everything roster writes is tagged or lives in files roster owns, and only those are ever changed or removed. The
interface is small: graph() (who reaches whom, no connections), run() (plan or apply), cut(), status(), and
drift() for `roster check`. Where things live on Linux and ESXi, and why, is in docs/mesh.md."""

import concurrent.futures as cf
import hashlib
import json
import os
import re
import subprocess
import threading

from .common import current_deadline, deadline_at, kill_tree, past_deadline, program_argv, time_left, user_config_dir
from .sshops import hk_name, recorded_host_keys

TAG = "roster-mesh"
OPTIONS = 'from="{ip}",no-agent-forwarding,no-X11-forwarding'
CLAUDE_IMPORT = "@~/ROSTER.md"
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
                if a != b and eligible(hosts[a]) and eligible(hosts[b]):
                    for pair in ((a, b), (b, a)) if link["both"] else ((a, b),):
                        via = link.get("via")
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
    return user_config_dir() / "mesh.json"


def load_state():
    """{members: [hosts roster wrote Mesh entries on], pending: {host: why}, cut: {host: [peers not confirmed]},
    applied: digest of the last complete apply}. Only bookkeeping: the Mesh itself comes from roster.yml."""
    try:
        data = json.loads(state_file().read_text())
    except (OSError, ValueError):
        data = {}
    return {"members": list(data.get("members") or []), "pending": dict(data.get("pending") or {}),
            "cut": dict(data.get("cut") or {}), "applied": data.get("applied")}


def save_state(st):
    f = state_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".new")
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
if [ "$ROTATE" = 1 ] && [ -f "$K" ]; then
  if [ "$MODE" = apply ]; then rm -f "$K" "$K.pub"; fi
  echo "KEY rotate"
fi
if [ ! -f "$K" ] || [ ! -f "$K.pub" ]; then
  if [ "$MODE" = apply ]; then
    mkdir -p "$P" && rm -f "$K" "$K.pub" && "$KG" -q -t ed25519 -N '' -C "roster-mesh:$NAME" -f "$K" >/dev/null 2>&1 \
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
ours() { [ -f "$1" ] && head -n 1 "$1" | grep -q 'roster-mesh'; }
C=$HOME/.ssh/config; INC="Include $P/config"
"""

SOURCE = r"""
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
if [ -n "$R" ] && [ -f "$R" ] && ! ours "$R"; then echo "CONFLICT $R"; fi
if [ -z "$ESXI" ] && [ -d "$HOME/.claude" ]; then
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
if [ -n "$P" ] && { [ -z "$MD" ] || mine "$P"; }; then clean "$P"; fi
if [ -n "$O" ] && [ -f "$O/id_ed25519" ] && mine "$O"; then
  OWN=
  if [ -n "$ESXI" ]; then
    case "$O" in /vmfs/volumes/*/.roster-mesh) v=${O#/vmfs/volumes/}; case "${v%/.roster-mesh}" in */*) ;; *) OWN=1;; esac;; esac
  elif [ "$O" = "$HOME/.ssh/roster-mesh" ]; then OWN=1; fi
  if [ -n "$OWN" ]; then clean "$O"; else echo "STALE $O"; fi
fi
if grep -qxF -e "$MARK" -e "$INC" "$C" 2>/dev/null; then
  echo "CHANGE remove include"
  if [ "$MODE" = apply ]; then
    t=$(mktemp)
    awk -v m="$MARK" -v i="$INC" 'd { d = 0; if (/^Include /) next } $0 == m { d = 1; next } $0 == i { next } { print }' "$C" > "$t"
    replace "$C" < "$t"; rm -f "$t"; [ -s "$C" ] || rm -f "$C"
  fi
fi
[ -z "$ESXI" ] && ours "$R" && drop "$R" "remove ROSTER.md"
CM=$HOME/.claude/CLAUDE.md
if grep -qxF "$IMPORT" "$CM" 2>/dev/null; then
  echo "CHANGE remove claude"
  if [ "$MODE" = apply ]; then
    t=$(mktemp); grep -vxF "$IMPORT" "$CM" > "$t"; replace "$CM" < "$t"; rm -f "$t"; [ -s "$CM" ] || rm -f "$CM"
  fi
fi
"""

AUTHORIZED = r"""
TAGS=' roster-mesh:[A-Za-z0-9][A-Za-z0-9._-]*$'
H=$(mktemp); grep -E "$TAGS" "$AK" 2>/dev/null > "$H"
[ -n "$KEEP" ] && grep -E " roster-mesh:($KEEP)\$" "$H" >> "$W"
grep -vxFf "$W" "$H" | while read -r l; do echo "DROP ${l##*:}"; done
grep -vxFf "$H" "$W" | while read -r l; do echo "ADD ${l##*:}"; done
S1=$(mktemp); S2=$(mktemp); sort "$H" > "$S1"; sort "$W" > "$S2"
if [ "$MODE" = apply ] && ! cmp -s "$S1" "$S2"; then
  d=${AK%/*}; mkdir -p "$d"; [ -z "$ESXI" ] && chmod 700 "$d"
  NEW=; [ -f "$AK" ] || NEW=1
  t=$(mktemp); grep -vE "$TAGS" "$AK" 2>/dev/null > "$t"; cat "$W" >> "$t"; replace "$AK" < "$t"; rm -f "$t"
  # ESXi keeps a file under /etc across a reboot only with the sticky bit (its own keys file is 1600); cp -p keeps
  # it on a rewrite, so only a file roster makes needs it
  [ -n "$ESXI" ] && [ -n "$NEW" ] && [ -f "$AK" ] && chmod 1600 "$AK"
  [ -n "$ESXI" ] && [ -x /sbin/auto-backup.sh ] && /sbin/auto-backup.sh >/dev/null 2>&1
fi
rm -f "$H" "$W" "$S1" "$S2"
"""


def with_mesh_dirs(cfg):
    """cfg's Hosts, each with its mesh_dir (None: roster's own pick) and seen_as (its other addresses), which
    roster.yml keeps beside them."""
    return {n: {**h, "mesh_dir": cfg.get("mesh_dirs", {}).get(n), "seen_as": cfg.get("seen_as", {}).get(n, [])}
            for n, h in cfg["hosts"].items()}


def preamble(h, mode):
    return (f"NAME={q(h['name'])}\nU={q(h['ssh']['user'])}\nMODE={mode}\nMARK={q(MARK)}\n"
            f"MD={q(h.get('mesh_dir') or '')}\n"
            f"IMPORT={q(CLAUDE_IMPORT)}\n" + WHERE)


def heredoc(text):
    return f"<<'ROSTER_MESH_EOF'\n{text}ROSTER_MESH_EOF\n"


def probe_script(h, peers, mode, rotate):
    """Phase 1 on a source: its key (made on apply), its public key, and whether it reaches each peer's ssh port."""
    lines = [preamble(h, mode), f"ROTATE={1 if rotate else 0}\n", PROBE, REACH]
    lines += [f"reach {q(p['name'])} {q(p['ip'])} {p['ssh']['port']}\n" for p in peers]
    return "".join(lines) + "echo ROSTER_DONE\n"


def hop_script(peers):
    """Phase 1 on a jump Host that isn't a source: whether it reaches the ssh port of each peer it's a hop to."""
    return REACH + "".join(f"reach {q(p['name'])} {q(p['ip'])} {p['ssh']['port']}\n" for p in peers) + "echo ROSTER_DONE\n"


def write_script(h, mode, files, keys, keep):
    """Phase 2 on any Host roster visits: as a source (FILES, {name: text}, or None to remove its source files),
    and as a peer (KEYS: the authorized_keys lines it should hold; KEEP: sources whose lines stay as they are)."""
    s = [preamble(h, mode), WRITE]
    if files is not None:
        s.append(SOURCE)
        for name, text in files.items():
            path = '"$R"' if name == "ROSTER.md" else f'"$P/{name}"'
            guard = 'if [ -n "$R" ] && { [ ! -f "$R" ] || ours "$R"; }; then ' if name == "ROSTER.md" else ""
            s.append(f"{guard}put {path} {q(name)} {heredoc(text)}" + ("fi\n" if guard else ""))
    else:
        s.append(NOT_SOURCE)
    s.append("W=$(mktemp)\ncat > \"$W\" " + heredoc("".join(line + "\n" for line in keys)))
    s.append(f"KEEP={q('|'.join(ere(k) for k in sorted(keep)))}\n")
    s.append(AUTHORIZED)
    return "".join(s) + "echo ROSTER_DONE\n"


def cut_script(h, host, own):
    """On a peer: HOST's key out of authorized_keys. On HOST itself (OWN): every Mesh key out, and its own Mesh files."""
    tag = "[A-Za-z0-9][A-Za-z0-9._-]*" if own else ere(host)
    s = [preamble(h, "apply"), WRITE]
    if own:
        s.append(NOT_SOURCE)
    s.append(f"""T=' roster-mesh:{tag}$'
if [ -f "$AK" ] && grep -qE "$T" "$AK"; then
  t=$(mktemp); grep -vE "$T" "$AK" > "$t"; replace "$AK" < "$t"; rm -f "$t"; echo "CHANGE cut"
  [ -n "$ESXI" ] && [ -x /sbin/auto-backup.sh ] && /sbin/auto-backup.sh >/dev/null 2>&1
fi
grep -qE "$T" "$AK" 2>/dev/null && echo "ERROR a roster-mesh line is still there" || echo ROSTER_DONE
""")
    return "".join(s)


# ---------------------------------------------------------------- running on a Host from the Box

def on_host(h, script, timeout=STEP_TIMEOUT):
    """Run SCRIPT on H over the Box's ssh (its key, roster's ssh config). Returns (report lines, None) or
    (None, why it didn't finish). The script goes as bytes: text mode on Windows would hand sh "\r\n" line ends."""
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
    out = [f"# Written by roster mesh for {src} from {cfg['path'].name}: the Hosts {src} reaches. Don't edit by hand.",
           ""]
    for p in peers:
        out += [f"Host {p['name']}", f"    HostName {p['ip']}", f"    User {p['ssh']['user']}",
                f"    Port {p['ssh']['port']}"] + ([f"    ProxyJump {vias[p['name']]}"] if p["name"] in (vias or {}) else [])
        out += [f"    UserKnownHostsFile {d}/known_hosts",
                "    StrictHostKeyChecking yes", f"    ConnectTimeout {CONNECT_TIMEOUT}"]
        if p["enroll"]:
            out += [f"    IdentityFile {d}/id_ed25519", "    IdentitiesOnly yes"]
        else:
            out += ["    PubkeyAuthentication no", "    PreferredAuthentications password,keyboard-interactive"]
        out.append("")
    return "\n".join(out)


def roster_md(src, peers, d, esxi, vias=None):
    ssh = f"ssh -F {d}/config" if esxi else "ssh"
    md = [f"<!-- roster-mesh: written by roster for {src}; roster mesh rewrites it, don't edit by hand -->",
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


def key_line(src, pub, via=None):
    """The peer's authorized_keys line for SRC: from= the addresses the peer sees, VIA's when it goes through one
    (its ip: and its seen_as:)."""
    parts = pub.split()
    seen = via or src
    return f"{OPTIONS.format(ip=','.join([seen['ip'], *seen.get('seen_as', [])]))} {parts[0]} {parts[1]} {TAG}:{src['name']}"


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
                and hosts[n]["enroll"] and hosts[n]["reviewed"])
    links = [dict(x) for x in g["links"]]
    live = {(x["from"], x["to"]) for x in links if "skip" not in x}
    hops = {}                                   # jump Host: the peers it's tested against (a hop to them)
    for x in links:
        if x.get("via") and "skip" not in x and (x["from"], x["via"]) in live:
            hops.setdefault(x["via"], {})[x["to"]] = hosts[x["to"]]
    hop_only = [n for n in sorted(set(hops) - set(g["sources"])) if hosts[n]["enroll"]]
    visits = sorted(set(g["visit"]) | set(ex))
    return g, st, ex, links, hops, hop_only, visits


def run(cfg, apply=False, rotate=(), say=None, progress=None, stopped=None, visits=None):
    """The Mesh as roster.yml asks for it, against what the Hosts hold now, one connection at a time.
    Plan (apply=False) changes nothing anywhere; apply makes it so and remembers what it couldn't finish.
    ROTATE: sources whose key is replaced. PROGRESS(done, total, host) is told before each Host's step and once at
    the end; STOPPED() true leaves the Hosts not yet visited pending, as serve's deadline does. VISITS: what
    visits_of(cfg, with_mesh_dirs(cfg)) said just before, so serve works out a big Mesh once for a job.
    Returns the result serve and the CLI show (docs/serve-api.md, mesh.plan)."""
    say = say or (lambda msg: None)
    progress = progress or (lambda done, total, host: None)
    stopped = stopped or (lambda: False)
    hosts, mode = with_mesh_dirs(cfg), "apply" if apply else "check"
    g, st, ex, links, hops, hop_only, visits = visits or visits_of(cfg, hosts)
    check_rotate(g, rotate)
    gone = sorted(n for n in set(st["members"]) if n not in hosts)
    out = {"host": {}, "probe": {}, "hop": {}}
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
        lines, err = on_host(hosts[name], probe_script(hosts[name], peers, mode, name in rotate))
        if err:
            out["probe"][name] = {"error": err}
            continue
        pub = report(lines, "PUB ")
        out["probe"][name] = {"dir": report(lines, "DIR ")[0], "esxi": "PLATFORM esxi" in lines, "pub": pub[0] if pub else None,
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
        p = out["probe"].get(name)
        step(name)
        bad = (p or {}).get("error") or out["hop"].get(name, {}).get("error")
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
                     "ROSTER.md": roster_md(name, peers, d, p["esxi"], vias)}
        keys, keep = [], set()
        for x in links:
            if x["to"] != name or x["kind"] != "key" or "skip" in x:
                continue
            src = out["probe"].get(x["from"], {})
            if x["status"] == "pending":
                keep.add(x["from"])
            elif x["status"] in ("ok", "untested"):
                keys.append(key_line(hosts[x["from"]], src["pub"], hosts.get(x.get("via"))) if src.get("pub")
                            else f"new-key {x['from']} {TAG}:{x['from']}")
        say(f"  {'write' if apply else 'check'}  {name}")
        lines, err = on_host(h, write_script(h, mode, files, sorted(keys, key=lambda k: k.rsplit(":", 1)[1]), keep))
        if err:
            finish(name, [], err)
            continue
        changes = key_changes(out["probe"].get(name), apply, name in rotate)
        added, dropped = set(report(lines, "ADD ")), set(report(lines, "DROP "))
        changes += [f"write {x}" for x in report(lines, "CHANGE ") if not x.startswith("remove ")]
        changes += [x for x in report(lines, "CHANGE ") if x.startswith("remove ")]
        changes += [f"replace key from {s}" for s in sorted(added & dropped)]
        changes += [f"add key from {s}" for s in sorted(added - dropped)]
        changes += [f"remove key from {s}" for s in sorted(dropped - added)]
        changes = [c.replace("write include", "write Include in ~/.ssh/config")
                   .replace("write claude", "write the import in ~/.claude/CLAUDE.md")
                   .replace("remove include", "remove the Include from ~/.ssh/config")
                   .replace("remove claude", "remove the import from ~/.claude/CLAUDE.md") for c in changes]
        finish(name, changes)
        stale(out, name, lines)                 # a source that left with its mesh_dir: (NOT_SOURCE)
        for path in report(lines, "CONFLICT "):
            out.setdefault("warnings", []).append(
                f"{name}: {path} isn't roster's, so roster left it alone (move it away and apply again)")

    progress(steps["total"], steps["total"], None)
    result = summary(cfg, g, links, out, apply, gone)
    if apply:
        record(cfg, g, st, result, ex)
    result["cut_pending"] = load_state()["cut"] if apply else st["cut"]
    return result


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
                   if n in hosts and n != name and hosts[n]["enroll"] and hosts[n]["reviewed"])
    return [(n, False) for n in peers] + ([(name, True)] if h["enroll"] and h["reviewed"] else [])


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

    def one(item):
        n, own = item
        with deadline_at(at):
            if why := not_now(stopped):
                return n, None, why
            lines, err = on_host(hosts[n], cut_script(hosts[n], name, own), timeout=CUT_TIMEOUT)
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


def write_cut(cfg, name):
    """`mesh: false` for Host NAME in roster.yml, as a Pending change (edit.py: every other byte kept), so the cut
    survives the next Publish. {written, backup?, note?} or {written: False, error, fix}."""
    from . import changes, edit
    from .errors import NOT_A_REPO, Problem
    if cfg["hosts"][name]["mesh"] is False:
        return {"written": False, "note": f"{name} already has mesh: false in roster.yml"}
    try:
        try:
            repo = changes.Repo(cfg["path"])
        except Problem as e:
            if e.code != NOT_A_REPO:
                raise
            repo = None
        old, new, _ = edit.edited(cfg["path"], name, {"mesh": False})
        backup = repo.backup(old) if repo else None
        edit.replace_file(cfg["path"], new)
    except Problem as e:
        return {"written": False, "error": e.message, "fix": f"set mesh: false for {name} in roster.yml by hand"}
    if repo is None:
        return {"written": True, "backup": None,
                "note": f"{cfg['path']} isn't in a git repo: mesh: false was written straight to it"}
    return {"written": True, "backup": str(backup)}
