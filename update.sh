#!/usr/bin/env bash
# Update roster on this box: the newest roster, its man page, and the team's map. Safe to run any time.
#
#   ./update.sh               interactive
#   ./update.sh --yes         accept every default
#   ./update.sh --dry-run     show what would happen, change nothing
#   ./update.sh --prefix DIR  roster lives in DIR/bin (as install.sh --prefix DIR put it); or PREFIX=DIR
#
# Stages: the roster source (git pull in this checkout), roster itself (uv tool install, and its man page), the
# team's map (git pull where roster.yml is), and `roster sync` (this box's ssh config and ROSTER.md from it). A
# host the map gained since needs `roster setup` once; this says so. Output goes to ~/.cache/roster/update.log.
set -uo pipefail

LOG="$HOME/.cache/roster/update.log"
MARK="# roster: ROSTER_CONFIG"

YES=0 DRY=0 PREFIX=${PREFIX:-}
while (( $# )); do
    case "$1" in
        -y|--yes) YES=1 ;;
        -n|--dry-run) DRY=1 ;;
        --prefix) [[ -n ${2:-} ]] || { echo "--prefix needs a directory" >&2; exit 2; }; PREFIX=$2; shift ;;
        --prefix=*) PREFIX=${1#--prefix=} ;;
        -h|--help) sed -n '2,/^[^#]/{/^#/p}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
    shift
done
PREFIX=${PREFIX/#\~/$HOME}

# ---- look (as install.sh)

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    B=$'\e[1m' D=$'\e[2m' R=$'\e[31m' G=$'\e[32m' Y=$'\e[33m' C=$'\e[36m' N=$'\e[0m'
else
    B='' D='' R='' G='' Y='' C='' N=''
fi
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8*|*utf8*) FULL="█" EMPTY="░" OK="✔" BAD="✘" SKIP="–" ;;
    *) FULL="#" EMPTY="-" OK="ok" BAD="x" SKIP="-" ;;
esac

STAGES=("roster source" "roster" "Team map" "Sync this box")
TOTAL=${#STAGES[@]}
DONE=() SKIPPED=() FAILED=()

stage() {
    local n=$1 w=30 fill bar="" i
    fill=$(( n * w / TOTAL ))
    for ((i = 0; i < w; i++)); do (( i < fill )) && bar+="$FULL" || bar+="$EMPTY"; done
    printf '\n%s%s%s %s%d/%d%s  %s%s%s\n' "$C" "$bar" "$N" "$D" "$n" "$TOTAL" "$N" "$B" "${STAGES[n-1]}" "$N"
    CUR="${STAGES[n-1]}"
}
ok()   { printf '  %s%s%s %s\n' "$G" "$OK" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
bad()  { printf '  %s%s%s %s\n' "$R" "$BAD" "$N" "$*"; }
info() { printf '  %s%s%s\n' "$D" "$*" "$N"; }
skip() { printf '  %s%s %s%s\n' "$D" "$SKIP" "$*" "$N"; SKIPPED+=("$CUR"); }
done_stage() { DONE+=("$CUR"); }
fail_stage() { FAILED+=("$CUR"); }
listed() { local x=$1 e; shift; for e in "$@"; do [[ $e == "$x" ]] && return 0; done; return 1; }  # listed NAME LIST...

TTY=/dev/tty
( : < "$TTY" ) 2>/dev/null || TTY=/dev/stdin

ask() {                         # ask "Question?" Y|N  -> 0 for yes
    local q=$1 def=${2:-Y} hint reply
    [[ $def == Y ]] && hint="Y/n" || hint="y/N"
    if (( YES )); then
        printf '  %s?%s %s %s[%s]%s %s\n' "$C" "$N" "$q" "$D" "$hint" "$N" "$([[ $def == Y ]] && echo yes || echo no)"
        [[ $def == Y ]]; return
    fi
    while true; do
        printf '  %s?%s %s %s[%s]%s ' "$C" "$N" "$q" "$D" "$hint" "$N"
        read -r reply < "$TTY" || reply=""
        case "${reply:-$def}" in
            [Yy]*) return 0 ;;
            [Nn]*) return 1 ;;
        esac
    done
}

step() {                        # step "what" cmd...  - output to the log, shown when it fails
    local what=$1; shift
    if (( DRY )); then info "would run: $*"; return 0; fi
    printf '\n==== %s: %s\n' "$what" "$*" >> "$LOG"
    if "$@" >> "$LOG" 2>&1; then ok "$what"; return 0; fi
    bad "$what failed - last lines of $LOG:"
    tail -n 8 "$LOG" | sed "s/^/      $D/; s/\$/$N/"
    return 1
}

have() { command -v "$1" >/dev/null 2>&1; }
home() { printf '%s' "${1/#$HOME/\~}"; }
version() { roster --version 2>/dev/null | awk '{print $NF}'; }

(( DRY )) || mkdir -p "$(dirname "$LOG")"
(( DRY )) || : > "$LOG"
export PATH="$HOME/.local/bin:$PATH"
[[ -n $PREFIX ]] && export PATH="$PREFIX/bin:$PATH"

printf '\n%sroster update%s\n' "$B" "$N"
(( DRY )) && warn "dry run: nothing will be changed"
if ! have roster || ! have uv; then
    bad "roster (or uv) isn't installed on this box - run ./install.sh first"; exit 1
fi
before=$(version)
info "roster $before now"

# 1. roster source
stage 1
src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ ! -f $src/pyproject.toml ]] || ! grep -q '^name = "roster"' "$src/pyproject.toml"; then
    bad "run update.sh from the roster source folder (where install.sh is)"; exit 1
elif [[ ! -d $src/.git ]]; then
    skip "$(home "$src") isn't a git clone (a Release tarball): unpack the newest roster-cli tarball and run its update.sh"
elif [[ -n $(git -C "$src" status --porcelain --untracked-files=no 2>/dev/null) ]]; then
    warn "$(home "$src") has changes of yours: not pulling (commit or stash them, then run this again)"
    skip "installing the source as it is"
elif step "git pull in $(home "$src")" git -C "$src" pull --ff-only --quiet; then
    info "now at $(git -C "$src" log -1 --format='%h %s' | cut -c1-70)"
    done_stage
else
    warn "couldn't fast-forward (another branch, or it went its own way): installing the source as it is"
    fail_stage
fi

# 2. roster
stage 2
rbin=$(command -v roster)
bindir=${PREFIX:+$PREFIX/bin}; bindir=${bindir:-$(dirname "$rbin")}
if step "install roster from $(home "$src") (uv tool install) into $(home "$bindir")" \
        env "UV_TOOL_BIN_DIR=$bindir" uv tool install --force --reinstall --quiet "$src"; then
    page="$(dirname "$bindir")/share/man/man1/roster.1"
    step "update the man page" sh -c 'mkdir -p "$(dirname "$1")" && cp "$2" "$1"' _ "$page" "$src/src/roster/roster.1" \
        || warn "no man page; roster man shows it"
    after=$(version)
    if (( DRY )); then :
    elif [[ $after == "$before" ]]; then ok "roster $after (same version, reinstalled)"
    else ok "roster $before -> $after (what's new: docs/news.md)"; fi
    done_stage
else
    fail_stage
fi

# 3. Team map: the roster.yml from $ROSTER_CONFIG, the line install.sh wrote, ~/infra, or ~/.config/roster
cfg=${ROSTER_CONFIG:-}
if [[ -z $cfg ]]; then
    for f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        v=$(grep -F "$MARK" "$f" 2>/dev/null | sed -n 's/^export ROSTER_CONFIG="\(.*\)".*/\1/p' | tail -1)
        [[ -n $v ]] && { cfg=${v//\$HOME/$HOME}; break; }
    done
fi
[[ -z $cfg && -f $HOME/infra/roster.yml ]] && cfg=$HOME/infra/roster.yml
[[ -z $cfg && -f $HOME/.config/roster/roster.yml ]] && cfg=$HOME/.config/roster/roster.yml   # as uninstall.sh
stage 3
if [[ -z $cfg || ! -f $cfg ]]; then
    skip "no roster.yml found (set ROSTER_CONFIG, or run ./install.sh)"; cfg=""
elif [[ ! -d $(dirname "$cfg")/.git ]]; then
    skip "$(home "$(dirname "$cfg")") isn't a git clone: nothing to pull"
elif ask "Pull the latest map into $(home "$(dirname "$cfg")")?" Y; then
    if step "git pull" git -C "$(dirname "$cfg")" pull --ff-only --quiet; then done_stage
    else warn "couldn't fast-forward; using the map as it is"; fail_stage; fi
else
    skip "kept the map as it is"
fi

# 4. Sync this box
stage 4
if [[ -z $cfg ]]; then
    skip "no roster.yml"
else
    export ROSTER_CONFIG="$cfg"
    cd "$(dirname "$cfg")" || exit 1
    if step "roster sync (ssh config and ROSTER.md from the map)" roster sync; then done_stage; else fail_stage; fi
    info "a host the map gained needs this box's key once: roster setup (roster check says which)"
fi

# ---- summary

printf '\n%sSummary%s\n' "$B" "$N"
for s in "${STAGES[@]}"; do
    if   listed "$s" ${FAILED[@]+"${FAILED[@]}"};   then bad "$s"
    elif listed "$s" ${SKIPPED[@]+"${SKIPPED[@]}"}; then printf '  %s%s %s (skipped)%s\n' "$D" "$SKIP" "$s" "$N"
    elif listed "$s" ${DONE[@]+"${DONE[@]}"};       then ok "$s"
    else printf '  %s%s %s%s\n' "$D" "$SKIP" "$s" "$N"
    fi
done
(( ${#FAILED[@]} )) && { info "Some stages failed - details in $LOG. Re-running this is safe."; exit 1; }
exit 0
