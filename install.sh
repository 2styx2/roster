#!/usr/bin/env bash
# Install roster on this box, one stage at a time. Every stage asks first and is safe to re-run.
# On a box that's set up (roster, uv and a map in ROSTER_CONFIG) it runs ./update.sh instead, with --yes,
# --dry-run, --prefix, --no-completion and --allow-downgrade; on one that isn't finished, it finishes it.
#
#   ./install.sh               interactive
#   ./install.sh --yes         accept every default (stages that need a person, like `bw login`, are skipped)
#   ./install.sh --dry-run     show what would happen, change nothing
#   ./install.sh --prefix DIR  put the roster command in DIR/bin and its man page in DIR/share/man/man1
#                              (default: uv's tool bin dir, ~/.local/bin, so ~/.local/share/man/man1); or PREFIX=DIR
#   ./install.sh --inventory HOW    how to get an Inventory (roster.yml) when the folder has none, without asking:
#                              blank (a new, short one: the default), file:PATH (a copy of that roster.yml),
#                              repo:URL (a clone of your team's git repo) or ssh-config[:PATH] (Hosts from ~/.ssh/config);
#                              or ROSTER_INVENTORY=HOW
#   ./install.sh --infra-repo URL   the same as --inventory repo:URL; or ROSTER_INFRA_REPO=URL
#   ./install.sh --no-completion    don't turn on Tab completion for roster in your shell (it's on otherwise)
#   ./install.sh --ref REF     install REF (a tag, or a branch of origin such as dev) instead of the newest Release
#   ./install.sh --allow-downgrade  install it even when it's older than the roster this box has (--ref does too)
#   ./install.sh --finish      run every stage on a box that has roster, instead of handing over to ./update.sh
#
# roster comes from the newest Release tag (vX.Y.Z) origin has, whatever branch this checkout is on, unpacked into
# ~/.local/share/roster/source: your checkout is never switched, pulled or changed. Offline, it installs the checkout
# as it is, and says so. An older roster than the one installed is only installed when you say so.
# Stages: prerequisites, uv, roster (with its man page, so `man roster` works), Bitwarden CLI, the Inventory's folder, making roster work from
# any directory, unlocking the vault, `roster setup`, and auto-updates from cron. ./uninstall.sh undoes them.
# "Work from anywhere" also turns on Tab completion for roster in bash, zsh and fish (unless --no-completion).
# Output of each step goes to ~/.cache/roster/install.log; it is shown only when a step fails.
set -uo pipefail

ROSTER_REPO="https://github.com/2styx2/roster.git"   # public: https needs no GitHub key on a new box
INFRA_REPO=${ROSTER_INFRA_REPO:-}
INVENTORY=${ROSTER_INVENTORY:-}
LOG="$HOME/.cache/roster/install.log"
SESSION_FILE="$HOME/.config/roster/bw-session"
MARK="# roster: ROSTER_CONFIG"           # marks the lines we add to shell startup files (uninstall.sh looks for them)
PATH_MARK="# roster: uv tools"
MAN_MARK="# roster: man page"            # only when man doesn't find the page from PATH by itself
# shellcheck disable=SC2034  # read by install-lib.sh's turn_on_completion
COMP_MARK="# roster: completion"         # the Tab completion line (or fish's file), always added (decision Q183)
NEED_MANPATH=0
SRC_STORE="${XDG_DATA_HOME:-$HOME/.local/share}/roster/source"   # the roster install.sh unpacked and installed
CHOICES="$HOME/.config/roster/install-choices"   # answers kept for later runs: no-cron, no-completion

YES=0 DRY=0 COMPLETION=1 PREFIX=${PREFIX:-} REF="" ALLOW_DOWNGRADE=0 FINISH=0 keep=0 older_version=""
while (( $# )); do
    case "$1" in
        -y|--yes) YES=1 ;;
        -n|--dry-run) DRY=1 ;;
        --no-completion) COMPLETION=0 ;;
        --prefix) [[ -n ${2:-} ]] || { echo "--prefix needs a directory" >&2; exit 2; }; PREFIX=$2; shift ;;
        --prefix=*) PREFIX=${1#--prefix=} ;;
        --infra-repo) [[ -n ${2:-} ]] || { echo "--infra-repo needs a git URL" >&2; exit 2; }; INFRA_REPO=$2; shift ;;
        --infra-repo=*) INFRA_REPO=${1#--infra-repo=} ;;
        --inventory) [[ -n ${2:-} ]] || { echo "--inventory needs blank, file:PATH, repo:URL or ssh-config[:PATH]" >&2; exit 2; }
                     INVENTORY=$2; shift ;;
        --inventory=*) INVENTORY=${1#--inventory=} ;;
        --ref) [[ -n ${2:-} ]] || { echo "--ref needs a tag or branch" >&2; exit 2; }; REF=$2; shift ;;
        --ref=*) REF=${1#--ref=} ;;
        --allow-downgrade) ALLOW_DOWNGRADE=1 ;;
        --finish) FINISH=1 ;;
        -h|--help) sed -n '2,/^[^#]/{/^#/p}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
    shift
done
PREFIX=${PREFIX/#\~/$HOME}
[[ -n $INFRA_REPO && -z $INVENTORY ]] && INVENTORY="repo:$INFRA_REPO"
case "$INVENTORY" in
    ""|blank|file:?*|repo:[!-]*|ssh-config|ssh-config:?*) ;;
    *) echo "--inventory $INVENTORY: use blank, file:PATH, repo:URL or ssh-config[:PATH]" >&2; exit 2 ;;
esac

# ---- look

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    B=$'\e[1m' D=$'\e[2m' R=$'\e[31m' G=$'\e[32m' Y=$'\e[33m' C=$'\e[36m' N=$'\e[0m'
else
    B='' D='' R='' G='' Y='' C='' N=''
fi
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8*|*utf8*) FULL="█" EMPTY="░" OK="✔" BAD="✘" SKIP="–" SPIN=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏) ;;
    *) FULL="#" EMPTY="-" OK="ok" BAD="x" SKIP="-" SPIN=('|' '/' '-' '\') ;;
esac

STAGES=("Prerequisites" "uv" "roster" "Bitwarden CLI" "Inventory" "Work from anywhere"
        "Unlock the vault" "Set up this box" "Auto-update")
TOTAL=${#STAGES[@]}
DONE=() SKIPPED=() FAILED=()

stage() {                       # stage N: progress bar + title
    local n=$1 w=30 fill
    fill=$(( n * w / TOTAL ))
    local bar="" i
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

TTY=/dev/tty                    # prompts read the keyboard even when piped into bash
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

ask_value() {                   # ask_value "Prompt" default -> echoes the answer
    local q=$1 def=$2 reply
    if (( YES )); then printf '  %s?%s %s %s%s\n' "$C" "$N" "$q" "$def" "$N" >&2; echo "$def"; return; fi
    printf '  %s?%s %s %s[%s]%s ' "$C" "$N" "$q" "$D" "$def" "$N" >&2
    read -r reply < "$TTY" || reply=""
    echo "${reply:-$def}"
}

redact() {                      # redact TEXT -> TEXT with a URL's credentials cut out: https://***@host/...
    # http(s)/ssh: the whole userinfo, up to the last @ before the host (a token as the user, an @ in a password);
    # elsewhere a password only. As newinventory.py's shown_url (#409 N2)
    sed -E 's#((https?|ssh|git\+ssh|ftps?)://)[^/[:space:]]*@#\1***@#gI; s#(://[^/:@[:space:]*]*):[^@/[:space:]]*@#\1:***@#g' <<<"$1"
}

safe_path() {                   # safe_path PATH -> 0 when PATH can go inside "..." in a shell startup file
    [[ $1 != *[\"\$\`\\]* && $1 != *$'\n'* ]]
}

step() {                        # step "what" cmd...  - runs with a spinner, output to the log
    local what; what=$(redact "$1"); shift
    if (( DRY )); then info "would run: $(redact "$*")"; return 0; fi
    printf '\n==== %s: %s\n' "$what" "$(redact "$*")" >> "$LOG"
    "$@" >> "$LOG" 2>&1 &
    local pid=$! i=0
    if [[ -t 1 ]]; then
        while kill -0 "$pid" 2>/dev/null; do
            printf '\r  %s%s%s %s' "$C" "${SPIN[i++ % ${#SPIN[@]}]}" "$N" "$what"
            sleep 0.1
        done
        printf '\r\e[K'
    fi
    if wait "$pid"; then ok "$what"; return 0; fi
    bad "$what failed - last lines of $LOG:"
    tail -n 8 "$LOG" | sed "s/^/      $D/; s/\$/$N/"
    return 1
}

live() {                        # live "what" cmd...  - runs in the foreground (it needs the keyboard)
    local what; what=$(redact "$1"); shift
    if (( DRY )); then info "would run: $(redact "$*")"; return 0; fi
    info "$what"
    if "$@" < "$TTY"; then ok "$what"; else bad "$what failed"; return 1; fi
}

have() { command -v "$1" >/dev/null 2>&1; }

SUDO=sudo                       # root (a container, say) often has no sudo, and doesn't need it
(( EUID == 0 )) && SUDO=""

APT_UPDATED=0
pkg_install() {                 # pkg_install name... with the box's package manager
    if [[ -n $SUDO ]] && ! have sudo && ! have brew; then bad "no sudo - install $* as root yourself"; return 1; fi
    if   have apt-get; then
        # a fresh box (or container) has no package lists yet: install would say "Unable to locate package"
        if (( ! APT_UPDATED )); then step "apt update" $SUDO apt-get update -q || return 1; APT_UPDATED=1; fi
        step "apt install $*" $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
    elif have dnf;     then step "dnf install $*" $SUDO dnf install -y "$@"
    elif have yum;     then step "yum install $*" $SUDO yum install -y "$@"
    elif have pacman;  then step "pacman -S $*" $SUDO pacman -S --noconfirm "$@"
    elif have brew;    then step "brew install $*" brew install "$@"
    else bad "no package manager found - install $* yourself"; return 1
    fi
}

cron_pkg() {                    # the package that brings crontab and the cron daemon, empty if we can't tell
    if   have apt-get; then echo cron
    elif have dnf || have yum || have pacman; then echo cronie
    fi
}

start_cron() {                  # make sure the cron daemon runs now and after a restart; 0 when it does
    [[ $(uname -s) == Darwin ]] && return 0             # launchd starts cron on macOS
    local svc wsl=0
    grep -qi microsoft /proc/version 2>/dev/null && wsl=1
    for svc in crond cron cronie; do                    # Fedora/RHEL, Debian/Ubuntu, Arch
        if [[ -d /run/systemd/system ]]; then
            systemctl cat "$svc.service" >/dev/null 2>&1 || continue
            if systemctl is-active --quiet "$svc" && systemctl is-enabled --quiet "$svc" 2>/dev/null; then
                ok "cron daemon ($svc) running"; return 0
            fi
            step "start the cron daemon ($svc), now and at boot" $SUDO systemctl enable --now "$svc"; return
        elif [[ -x /etc/init.d/$svc ]]; then
            if ! service "$svc" status >/dev/null 2>&1; then
                step "start the cron daemon ($svc)" $SUDO service "$svc" start || return 1
            else ok "cron daemon ($svc) running"; fi
            # no systemd: nothing starts cron again when WSL (or the container) restarts
            (( wsl )) && warn "WSL without systemd: cron stops with WSL. Put [boot] systemd=true in /etc/wsl.conf so it starts by itself"
            return 0
        fi
    done
    if (( DRY )); then info "would start the cron daemon"; return 0; fi
    warn "couldn't find the cron service - start it yourself, or the job never runs"; return 1
}

in_checkout() { [[ -f "$1/pyproject.toml" ]] && grep -q '^name = "roster"' "$1/pyproject.toml"; }
home_() { printf '%s' "${1/#$HOME/\~}"; }

describe_source() {             # describe_source DIR [REF] -> "branch main, commit abc1234, v0.5.0" (as update.sh)
    local d=$1 at=${2:-HEAD} branch="" tag
    git -C "$d" rev-parse -q --verify "$at" >/dev/null 2>&1 || return 0
    [[ $at == HEAD ]] && branch=$(git -C "$d" symbolic-ref -q --short HEAD)
    tag=$(git -C "$d" describe --tags "$at" 2>/dev/null)
    printf '%s, commit %s%s' "${branch:+branch $branch}" "$(git -C "$d" rev-parse --short "$at")" "${tag:+, $tag}" |
        sed 's/^, //'
}

version_in() {                  # version_in DIR [COMMIT] -> the version in pyproject.toml (at COMMIT, else on disk)
    if [[ -n ${2:-} ]]; then git -C "$1" show "$2:pyproject.toml" 2>/dev/null; else cat "$1/pyproject.toml" 2>/dev/null; fi |
        sed -n 's/^version = "\(.*\)"/\1/p' | head -1
}

older() { [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1) == "$1" ]]; }   # older A B: A < B

git_net() {                     # git_net DIR ARGS...: git that talks to a remote, and can't hang an install
    # no password or host key question; ssh in BatchMode only when you haven't set your own (GIT_SSH_COMMAND, or
    # core.sshCommand for a deploy key); 30 s at most where the box has timeout
    local d=$1 e=(GIT_TERMINAL_PROMPT=0) t=(); shift
    if [[ -z ${GIT_SSH_COMMAND:-} ]] && ! git -C "$d" config --get core.sshCommand >/dev/null 2>&1; then
        e+=("GIT_SSH_COMMAND=ssh -o BatchMode=yes")
    fi
    have timeout && t=(timeout 30)
    env "${e[@]}" ${t[@]+"${t[@]}"} git -C "$d" "$@"
}

chose() { grep -qx "$1" "$CHOICES" 2>/dev/null; }                       # chose no-cron: an answer kept from earlier
choose() { (( DRY )) || chose "$1" || { mkdir -p "$(dirname "$CHOICES")" && echo "$1" >> "$CHOICES"; }; }

installed_roster() {            # the roster command this box has: on PATH (PREFIX/bin first), else where uv put it
    local p
    p=$(command -v roster 2>/dev/null) && [[ -n $p ]] && { echo "$p"; return 0; }
    have uv || return 1
    p=$(uv tool list --show-paths 2>/dev/null | sed -n 's/^- roster (\(.*\))$/\1/p' | head -1)
    [[ -n $p && -x $p ]] && echo "$p"
}

pick_source() {                 # pick_source DIR: which roster to install from the checkout DIR -> from, from_desc, pick_version
    local d=$1 commit="" def tag="" refs="" spec="" ref="" err name
    from=$d from_desc=$(describe_source "$d") pick_version=$(version_in "$d")
    [[ -d $d ]] || return 0                 # a dry run's clone that didn't happen
    if [[ $(git -C "$d" rev-parse --show-toplevel 2>/dev/null) != "$(cd "$d" && pwd -P)" ]]; then
        info "$(home_ "$d") isn't a git clone (a Release tarball): installing it as it is"
        [[ -n $REF ]] && warn "--ref $REF needs a git clone: ignored"
        return 0
    fi
    has_ref() { awk -v r="$1" '$2 == r { found = 1 } END { exit !found }' <<<"$refs"; }   # a name, not a pattern
    local_ref() { git -C "$d" rev-parse -q --verify "refs/remotes/origin/$REF^{commit}" 2>/dev/null ||
                  git -C "$d" rev-parse -q --verify "$REF^{commit}" 2>/dev/null; }
    if ! git -C "$d" remote get-url origin >/dev/null 2>&1 || ! refs=$(git_net "$d" ls-remote --refs --tags --heads origin 2>/dev/null); then
        # offline, or nowhere to ask: the checkout as it is, or --ref as this clone has it
        if [[ -n $REF ]]; then
            commit=$(local_ref) || { bad "couldn't reach origin, and this clone has no $REF"; fail_stage; exit 1; }
            tag=$REF; warn "couldn't reach origin: installing $REF as this clone has it"
        else
            warn "couldn't reach origin: installing the checkout as it is ($from_desc), which may not be the newest roster"
            return 0
        fi
    else
        # origin answered: the newest Release is the highest vX.Y.Z tag *origin* has (not a tag of yours, or a fork's)
        if [[ -n $REF ]]; then
            tag=$REF
            if has_ref "refs/tags/$REF"; then spec="+refs/tags/$REF:refs/tags/$REF" ref="refs/tags/$REF"
            elif has_ref "refs/heads/$REF"; then
                spec="+refs/heads/$REF:refs/remotes/origin/$REF" ref="refs/remotes/origin/$REF"
            else commit=$(git -C "$d" rev-parse -q --verify "$REF^{commit}" 2>/dev/null) ||
                     { bad "no tag or branch $REF on origin"; fail_stage; exit 1; }
            fi
        else
            tag=$(sed -n 's|.*[[:space:]]refs/tags/||p' <<<"$refs" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
            if [[ -n $tag ]]; then spec="+refs/tags/$tag:refs/tags/$tag" ref="refs/tags/$tag"
            else                                # no Release yet: origin's default branch
                def=$(git_net "$d" ls-remote --symref origin HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\(.*\)[[:space:]]HEAD$|\1|p')
                def=${def:-main} tag="origin/${def:-main}"
                if ! has_ref "refs/heads/$def"; then
                    warn "origin has no Release tag and no $def branch: installing the checkout as it is ($from_desc)"; return 0
                fi
                spec="+refs/heads/$def:refs/remotes/origin/$def" ref="refs/remotes/origin/$def"
            fi
        fi
        if [[ -n $spec ]]; then
            # just that one ref, forced: a tag origin moved updates here instead of failing the fetch. Your branches
            # and the files you work on don't move (a dry run fetches too, for the same reason)
            if ! err=$(git_net "$d" fetch --quiet --no-tags origin "$spec" 2>&1); then
                bad "origin answered, but fetching $tag failed: $(tail -n 1 <<<"$err")"; fail_stage; exit 1
            fi
            commit=$(git -C "$d" rev-parse -q --verify "$ref^{commit}")
        fi
    fi
    from_desc="$tag, commit $(git -C "$d" rev-parse --short "$commit")"
    pick_version=$(version_in "$d" "$commit")
    # unpacked where it stays (uv's record of the install points there, so `uv tool upgrade` finds it); update.sh is
    # the way to update, and the next install prunes the copies before it
    name=${tag//\//-}
    from="$SRC_STORE/$name"
    info "installing roster ${pick_version:-?} ($from_desc) from a clean copy: your checkout stays as it is"
    if (( DRY )); then info "would unpack $tag into $(home_ "$from")"; return 0; fi
    if mkdir -p "$SRC_STORE" && NEW_SRC=$(mktemp -d "$SRC_STORE/.new.XXXXXX") && trap 'rm -rf "$NEW_SRC"' EXIT &&
            git -C "$d" archive --format=tar "$commit" | tar -x -C "$NEW_SRC" && rm -rf "$from" && mv "$NEW_SRC" "$from"; then :
    else bad "couldn't unpack $tag into $(home_ "$SRC_STORE")"; fail_stage; exit 1; fi
}

prune_sources() {               # the copies of earlier installs, once this one is in
    local o
    [[ $from == "$SRC_STORE"/* ]] || return 0
    for o in "$SRC_STORE"/* "$SRC_STORE"/.new.*; do [[ -e $o && $o != "$from" ]] && rm -rf "$o"; done
    return 0
}

find_map() {                    # the Inventory this box uses -> MAP (empty: none) and MAP_FROM; the same in
    # install.sh and update.sh (Q184): $ROSTER_CONFIG, the line install.sh wrote, the active named Inventory,
    # ~/.config/roster/roster.yml (roster finds those by itself), then ~/infra/roster.yml (it doesn't, without
    # ROSTER_CONFIG). Only a file that's there: a team repo's or a plain one, blank included (T212)
    local f v
    MAP="" MAP_FROM=""
    if [[ -n ${ROSTER_CONFIG:-} && -f ${ROSTER_CONFIG:-} ]]; then MAP=$ROSTER_CONFIG MAP_FROM=env; return; fi
    for f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        v=$(grep -F "$MARK" "$f" 2>/dev/null | sed -n 's/^export ROSTER_CONFIG="\(.*\)".*/\1/p' | tail -1)
        v=${v//\$HOME/$HOME}
        if [[ -n $v && -f $v ]]; then MAP=$v MAP_FROM=rc; return; fi
    done
    # the active named Inventory (`roster inv`, T212: a plain file of your own is as much a map as the team's repo)
    # shellcheck disable=SC2016  # Python, not shell, in the single quotes
    v=$(python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); a = d.get("active")
print(next((x["path"] for x in d.get("inventories", []) if x.get("name") == a), ""))' \
        "$HOME/.config/roster/inventories.json" 2>/dev/null)       # roster's own folder (common.user_config_dir)
    if [[ -n $v && -f $v ]]; then MAP=$v MAP_FROM=named; return; fi
    if [[ -f $HOME/.config/roster/roster.yml ]]; then MAP=$HOME/.config/roster/roster.yml MAP_FROM=config; return; fi
    if [[ -f $HOME/infra/roster.yml ]]; then MAP=$HOME/infra/roster.yml MAP_FROM=infra; fi
}

home_of() { [[ $1 == "$HOME"/* ]] && echo "~${1#"$HOME"}" || echo "$1"; }

box_needs() {                   # what this box is missing that update.sh doesn't do -> the list, empty when none
    local pull
    find_map
    if [[ -z $MAP ]]; then echo "an Inventory and ROSTER_CONFIG"; return; fi
    [[ $MAP_FROM == infra ]] && echo "ROSTER_CONFIG"           # roster finds ~/infra/roster.yml only through it
    pull="$(dirname "$MAP")/bin/roster-pull"
    if [[ -x $pull ]] && ! chose no-cron && ! { have crontab && crontab -l 2>/dev/null | grep -qF "$pull"; }; then
        echo "the auto-update cron job"
    fi
}

# ---- start

(( DRY )) || mkdir -p "$(dirname "$LOG")"
(( DRY )) || : > "$LOG"
USER_PATH=$PATH                 # the PATH this shell had, before the lines below add to it for this run
export PATH="$HOME/.local/bin:$PATH"
[[ -n $PREFIX ]] && export PATH="$PREFIX/bin:$PATH"

printf '\n%sroster installer%s\n' "$B" "$N"
info "Give this box (and Claude on it) access to every host in roster.yml. Passwords stay in the vault."
(( DRY )) && warn "dry run: nothing will be changed"
(( YES )) && info "--yes: taking the default answer everywhere"

# Set up already: that's an update, update.sh's job (the same checkout's, with the same flags). Set up means roster
# and uv, a map in ROSTER_CONFIG, and the cron job when the map has bin/roster-pull: update.sh does the rest (and
# turns on Tab completion). A box without them (a first run with no map yet, a stage that failed, one installed
# before install.sh had cron) gets every stage again, each skipping what's done (Q184).
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)
inst_bin=$(installed_roster) || inst_bin=""
inst_version=""
[[ -n $inst_bin ]] && inst_version=$("$inst_bin" --version 2>/dev/null | awk '{print $NF}')
needs=""
[[ -n $inst_bin ]] && needs=$(box_needs)
if [[ -n $inst_bin ]] && have uv && [[ -z $needs ]] && (( ! FINISH )); then
    info "roster $inst_version is already installed on this box: updating it with ./update.sh"
    up=$here
    if ! in_checkout "$up"; then up=$(ask_value "Where is the roster source?" "$HOME/roster"); up=${up/#\~/$HOME}; fi
    if [[ ! -f "$up/update.sh" ]]; then
        bad "no update.sh in $up: run update.sh in your roster checkout (or git clone $ROSTER_REPO there first)"; exit 1
    fi
    [[ -n $INFRA_REPO || -n $INVENTORY ]] && find_map && info "--inventory and --infra-repo are for a first install: this box has an Inventory ($(home_of "$MAP")); a second one beside it: roster -c FOLDER/roster.yml init --inventory HOW --name NAME"
    [[ -n $REF ]] && info "--ref is for a first install: update.sh installs this checkout as it is (or ./install.sh --finish --ref $REF)"
    flags=()
    (( YES )) && flags+=(--yes)
    (( DRY )) && flags+=(--dry-run)
    (( COMPLETION )) || flags+=(--no-completion)
    (( ALLOW_DOWNGRADE )) && flags+=(--allow-downgrade)
    if [[ -n $PREFIX ]]; then flags+=(--prefix "$PREFIX")
    elif ! have roster; then flags+=(--prefix "$(dirname "$(dirname "$inst_bin")")")     # where uv put it, off PATH
    fi
    bash "$up/update.sh" ${flags[@]+"${flags[@]}"} < "$TTY"
    exit $?
fi
if [[ -n $inst_bin ]]; then
    if (( FINISH )); then info "roster $inst_version is installed: --finish runs every stage, skipping what's done"
    else info "roster $inst_version is installed, but this box isn't finished (no ${needs//$'\n'/, no }): finishing the install"; fi
fi

# 1. Prerequisites
stage 1
missing=()
if have python3 && python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
    ok "Python $(python3 -c 'import platform; print(platform.python_version())')"
else
    bad "Python 3.10 or newer"; missing+=(python3)
fi
for t in ssh ssh-keygen ssh-keyscan; do
    if have "$t"; then ok "$t"; else bad "$t (OpenSSH client)"; missing+=(openssh-client); break; fi
done
for t in git curl; do
    if have "$t"; then ok "$t"; else bad "$t"; missing+=("$t"); fi
done
if have jq; then ok "jq"; else warn "jq not installed (optional: the vault listings in the docs use it)"; fi
if have nmap; then ok "nmap"; else warn "nmap not installed (optional: makes roster discover faster and better)"; fi
if (( ${#missing[@]} )); then
    if have dnf || have yum; then missing=("${missing[@]/openssh-client/openssh-clients}"); fi
    if ask "Install ${missing[*]} with your package manager?" Y && pkg_install "${missing[@]}"; then done_stage
    else fail_stage; bad "roster needs these - install them and run this again"; exit 1; fi
else
    done_stage
fi
if ! have man; then warn "man not installed (optional: for man roster; roster help --man shows the page without it)"; fi
if ! have jq || ! have nmap || ! have man; then
    opt=(); have jq || opt+=(jq); have nmap || opt+=(nmap)
    if ! have man && ! have brew; then opt+=(man-db); fi       # macOS has man; man-db is its name elsewhere
    ask "Install the optional tools too (${opt[*]})?" N && pkg_install "${opt[@]}"
fi

# 2. uv
stage 2
if have uv; then ok "uv $(uv --version | awk '{print $2}') already installed"; done_stage
elif ask "uv (Python tool installer) is missing. Install it from astral.sh?" Y; then
    if step "install uv" sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'; then done_stage
    else fail_stage; exit 1; fi
else
    skip "roster is installed with uv - can't continue without it"; exit 1
fi

# 3. roster
stage 3
if in_checkout "$here"; then
    src=$here
    ok "using this checkout: $src"
else
    src=$(ask_value "Where should the roster source live?" "$HOME/roster")
    src=${src/#\~/$HOME}
    if [[ -d "$src/.git" ]]; then ok "already cloned: $src"
    elif ! step "clone roster into $src" git clone -q "$ROSTER_REPO" "$src"; then fail_stage; exit 1; fi
fi
pick_source "$src"                      # the newest Release, not whatever this checkout happens to be on (#408)
bindir=${PREFIX:+$PREFIX/bin}
[[ -z $bindir && -n $inst_bin ]] && bindir=$(dirname "$inst_bin")       # where it is already: not a second copy
bindir=${bindir:-$(uv tool dir --bin 2>/dev/null || echo "$HOME/.local/bin")}
keep=0                                  # never an older roster over a newer one without a yes (#408)
if [[ -n $inst_version && -n $pick_version ]] && older "$pick_version" "$inst_version" && (( ! ALLOW_DOWNGRADE )) &&
        [[ -z $REF ]] && ! ask "Install roster $pick_version over the newer $inst_version this box has?" N; then
    keep=1
fi
if (( keep )); then
    skip "kept roster $inst_version: $pick_version is older (--allow-downgrade installs it anyway)"
    older_version=$pick_version
elif step "install roster (uv tool install) into $bindir" \
        env "UV_TOOL_BIN_DIR=$bindir" uv tool install --force --quiet "$from"; then
    done_stage; (( DRY )) || prune_sources
else
    fail_stage; exit 1
fi
# The man page goes next to the command, PREFIX/share/man/man1 beside PREFIX/bin: man finds it from PATH. Kept or
# reinstalled, so a roster from before the man page gets it too.
page="$(dirname "$bindir")/share/man/man1/roster.1"
mandir=$(dirname "$(dirname "$page")")
if (( keep )) || step "install the man page (man roster)" sh -c 'mkdir -p "$(dirname "$1")" && cp "$2" "$1"' _ \
        "$page" "$from/src/roster/roster.1"; then
    # man finds PREFIX/share/man from PREFIX/bin on PATH (man-db, mandoc); make sure, with the PATH a new terminal has
    # A minimized Ubuntu's man is a stand-in that only says so (the real one, if man-db is there, is man.REAL)
    manbin="man"; minimized=0
    if have man && man -w man 2>&1 | grep -q 'minimized'; then
        minimized=1; [[ -x /usr/bin/man.REAL ]] && manbin=/usr/bin/man.REAL
    fi
    if (( DRY )) || ! have man; then :
    elif [[ $(PATH="$bindir:$USER_PATH" MANPATH="${MANPATH:-}" "$manbin" -w roster 2>/dev/null) == "$page"* ]]; then
        if (( minimized )); then warn "this system is minimized: man shows no page until you run sudo unminimize (roster help --man works now)"
        else ok "man roster finds it"; fi
    elif (( minimized )); then
        warn "this system is minimized: for man roster, install man-db and run sudo unminimize (roster help --man works now)"
    else
        warn "man doesn't look in ${mandir/#$HOME/\~} by itself: stage 6 adds it to MANPATH"; NEED_MANPATH=1
    fi
else
    warn "no man page; roster help --man shows it"
fi
case ":$USER_PATH:" in
    *":$bindir:"*) ;;
    *":${bindir%/}/:"*) ;;
    *) if [[ $bindir == "$HOME/.local/bin" ]]; then warn "add ~/.local/bin to PATH (stage 6 does it)"
       else warn "add $bindir to PATH yourself"; fi ;;
esac

# 4. Bitwarden CLI
stage 4
if have bw; then ok "bw $(bw --version 2>/dev/null) already installed"; done_stage
elif ask "Install the Bitwarden CLI (bw)? roster fetches passwords with it" Y; then
    # On Linux x86_64 the standalone binary, into ~/.local/bin (no root; a system npm's -g needs it). It's a zip:
    # a fresh box may have no unzip, so that comes from the package manager first.
    standalone=0
    if [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]; then
        if have unzip || { ! have npm && pkg_install unzip; }; then standalone=1; fi
    fi
    if (( ! standalone )) && have npm; then
        step "npm install -g @bitwarden/cli" npm install -g @bitwarden/cli && done_stage || fail_stage
    elif (( standalone )); then
        tmp=$(mktemp -d)
        if step "download bw" curl -fsSL -o "$tmp/bw.zip" "https://vault.bitwarden.com/download/?app=cli&platform=linux" \
           && step "unpack bw into ~/.local/bin" sh -c "mkdir -p '$HOME/.local/bin' && unzip -oq '$tmp/bw.zip' -d '$HOME/.local/bin' && chmod +x '$HOME/.local/bin/bw'"
        then done_stage; else fail_stage; fi
        rm -rf "$tmp"
    elif have brew; then pkg_install bitwarden-cli && done_stage || fail_stage
    else bad "install npm or unzip first, or get bw from https://bitwarden.com/help/cli/"; fail_stage
    fi
else
    skip "no Bitwarden CLI - logins that use bw: won't work on this box"
fi

# 5. Inventory: the roster.yml in the folder you pick, kept if it's there; else one of four ways to get one (T212):
# a blank one (the default), a copy of a roster.yml, a clone of the team's repo, or Hosts from ~/.ssh/config
stage 5

choose_how() {                  # choose_how -> echoes blank | file:PATH | repo:URL | ssh-config
    local c p
    info "How do you want to start your Inventory?" >&2
    info "  1  a blank one, to add Hosts to (the default)" >&2
    info "  2  import a roster.yml you have" >&2
    info "  3  clone your team's git repo (the one with roster.yml)" >&2
    info "  4  import the Hosts in ~/.ssh/config (it isn't changed)" >&2
    c=$(ask_value "1, 2, 3 or 4" 1)
    case $c in
        2) p=$(ask_value "Path of the roster.yml to import" ""); [[ -n $p ]] && { echo "file:${p/#\~\//$HOME/}"; return; } ;;
        3) p=$(ask_value "Git URL of your team's repo" ""); [[ -n $p && $p != -* ]] && { echo "repo:$p"; return; } ;;
        4) echo ssh-config; return ;;
    esac
    [[ $c == 1 ]] || warn "nothing to import from: a blank one, then" >&2
    echo blank
}

clone_repo() {                  # clone_repo URL DIR: the team's repo into DIR
    local url=$1 dir=$2
    if [[ -e "$dir" && -n "$(ls -A "$dir" 2>/dev/null)" ]]; then
        bad "$dir exists and isn't empty - pick another folder or empty it"; return 1
    fi
    if (( YES )); then
        # nobody to answer a passphrase question: fail instead of waiting on a hidden prompt. The repo was named
        # on the command line, so a first-seen host key is taken (accept-new: a changed one still fails). Your
        # own GIT_SSH_COMMAND or core.sshCommand (a deploy key, say) is left as it is.
        local git_ssh=()
        if [[ -z ${GIT_SSH_COMMAND:-} ]] && ! git config --get core.sshCommand >/dev/null 2>&1; then
            git_ssh=("GIT_SSH_COMMAND=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new")
        fi
        step "clone $url into $dir" \
            env GIT_TERMINAL_PROMPT=0 ${git_ssh[@]+"${git_ssh[@]}"} git clone -q -- "$url" "$dir" || return 1
    else
        live "clone $url into $dir" git clone -q -- "$url" "$dir" || return 1
    fi
    if (( DRY )) || [[ -f "$dir/roster.yml" ]]; then return 0; fi
    warn "the clone has no roster.yml at its top"; return 1
}

make_inventory() {              # make_inventory CFG HOW [NAME]: CFG made the HOW way (named NAME); sets MADE
    local cfg=$1 how=$2 name=${3:-} dir src
    dir=$(dirname "$cfg"); MADE=$cfg
    local named=(); [[ -n $name ]] && named=(--name "$name")
    case $how in
        repo:*)
            clone_repo "${how#repo:}" "$dir" || return 1
            if [[ -n $name ]]; then step "name it $name (roster inv add)" roster inv add "$name" "$cfg" || return 1; fi
            return 0 ;;
        file:*)
            src=${how#file:}; src=${src/#\~\//$HOME/}
            if ! ask "Copy $src into $dir? (n: use it where it is)" Y; then
                # a full path that's there, and one a shell startup file can hold (ROSTER_CONFIG="...")
                if [[ ! -f $src ]]; then bad "no file at $src"; return 1; fi
                src="$(CDPATH='' cd -- "$(dirname -- "$src")" && pwd)/$(basename -- "$src")"
                if ! safe_path "$src"; then bad "$src can't hold \", \$, \` or a newline: rename it, or copy it"; return 1; fi
                MADE=$src; ok "using $src where it is"
                if [[ -n $name ]]; then step "name it $name (roster inv add)" roster inv add "$name" "$src" || return 1; fi
                return 0
            fi ;;
    esac
    (( DRY )) || mkdir -p "$dir" || return 1
    step "roster init --inventory $how" roster -c "$cfg" init --inventory "$how" ${named[@]+"${named[@]}"} || return 1
    # optional, never required: roster saves a plain file in place, and a repo without a remote the same way
    if ask "Keep its history in git (git init in $dir)? roster works the same without it" N; then
        step "git init" git -C "$dir" init -q || warn "no git history; roster works the same"
    fi
}

cfg_dir=$(ask_value "Folder for your Inventory (roster.yml)" "$HOME/infra")
cfg_dir=${cfg_dir/#\~/$HOME}
CFG="$cfg_dir/roster.yml"
if ! safe_path "$cfg_dir"; then
    # ROSTER_CONFIG="..." goes into the shell startup files (stage 6): a $( or ` there would run at every start
    bad "the folder can't hold \", \$, \` or a newline (it goes into your shell startup files): run this again with another"
    CFG=""; fail_stage
elif [[ -f "$CFG" ]]; then
    ok "found $CFG (as it is: ./update.sh pulls it)"
    # a file that's there is kept (the default); a new one goes beside it, as a named Inventory (roster inv add)
    if [[ -n $INVENTORY ]] || ask "Keep using it? (n: keep it, and add a new one beside it as a named Inventory)" Y; then
        [[ -n $INVENTORY ]] && info "kept it: --inventory is for a folder with no roster.yml yet"
        done_stage
    else
        how=$(choose_how)
        name=$(ask_value "Name for the new Inventory (roster --inv NAME)" "home")
        new_dir=$(ask_value "Folder for the new Inventory" "$HOME/$name")
        new_dir=${new_dir/#\~/$HOME}
        if make_inventory "$new_dir/roster.yml" "$how" "$name"; then
            info "$CFG stays the one roster uses here; roster --inv $name reaches the new one (roster inv use $name switches)"
            done_stage
        else fail_stage; fi
    fi
else
    how=${INVENTORY:-}
    [[ -n $how ]] || how=$( (( YES )) && echo blank || choose_how )
    if make_inventory "$CFG" "$how"; then CFG=$MADE; cfg_dir=$(dirname "$CFG"); done_stage
    else
        case $how in repo:*) warn "no git access? copy roster.yml into $cfg_dir by hand, or run again with --inventory blank" ;; esac
        fail_stage
    fi
fi
[[ -f "$CFG" ]] || (( DRY )) || CFG=""

# 6. Work from anywhere
stage 6
rc_files=()
for f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do [[ -f $f ]] && rc_files+=("$f"); done
(( ${#rc_files[@]} )) || rc_files=("$HOME/.profile")
path_line="export PATH=\"\$HOME/.local/bin:\$PATH\"   $PATH_MARK"
case ":$USER_PATH:" in *":$HOME/.local/bin:"*|*":$HOME/.local/bin/:"*) local_bin_on_path=1 ;; *) local_bin_on_path=0 ;; esac
if (( NEED_MANPATH )) && ask "Add ${mandir/#$HOME/\~} to MANPATH (in ${rc_files[*]/#$HOME/\~}) so man roster works?" Y; then
    # the trailing colon keeps man's own search path after it
    man_line="export MANPATH=\"${mandir/#$HOME/\$HOME}:\${MANPATH:-}\"   $MAN_MARK"
    for f in "${rc_files[@]}"; do
        if (( DRY )); then info "would add MANPATH to $f"
        elif ! grep -qF "$MAN_MARK" "$f"; then printf '\n%s\n' "$man_line" >> "$f"; ok "updated ${f/#$HOME/\~}"; fi
    done
fi
if [[ -z $CFG ]] && (( local_bin_on_path )); then
    skip "no roster.yml to point at"
elif [[ -z $CFG ]]; then
    # no map yet, but roster (and uv, bw) are in ~/.local/bin: without it on PATH a new terminal has no roster
    if ask "Put ~/.local/bin on PATH (in ${rc_files[*]/#$HOME/\~}) so a new terminal finds roster?" Y; then
        for f in "${rc_files[@]}"; do
            if (( DRY )); then info "would add ~/.local/bin to PATH in $f"
            elif ! grep -q '\.local/bin' "$f"; then printf '\n%s\n' "$path_line" >> "$f"; ok "updated ${f/#$HOME/\~}"; fi
        done
    fi
    skip "no roster.yml to point at - once you have one, run this again"
elif ask "Make roster work from any directory (set ROSTER_CONFIG=$CFG in ${rc_files[*]/#$HOME/\~})?" Y; then
    line="export ROSTER_CONFIG=\"${CFG/#$HOME/\$HOME}\"   $MARK"
    for f in "${rc_files[@]}"; do
        if (( DRY )); then info "would add ROSTER_CONFIG to $f"; continue; fi
        # replace a line from an earlier run (or a hand-written one), else append
        if grep -q 'ROSTER_CONFIG=' "$f"; then
            tmp=$(mktemp) && grep -v 'ROSTER_CONFIG=' "$f" > "$tmp" && cat "$tmp" > "$f" && rm -f "$tmp"
        fi
        printf '\n%s\n' "$line" >> "$f"
        grep -q '\.local/bin' "$f" || printf '%s\n' "$path_line" >> "$f"
        ok "updated ${f/#$HOME/\~}"
    done
    export ROSTER_CONFIG="$CFG"
    info "open a new terminal (or: source ~/.bashrc) to pick it up here"
    done_stage
else
    export ROSTER_CONFIG="$CFG"
    skip "run roster from $cfg_dir, or pass -c $CFG"
fi

# Tab completion for roster in each shell this box uses: no question, it's on unless --no-completion (decision
# Q183). The step is install-lib.sh's, shared with update.sh: beside this script, or in the checkout it cloned.
(( COMPLETION )) || choose no-completion          # update.sh leaves it off too
if (( ! COMPLETION )) || chose no-completion; then
    (( COMPLETION )) || info "--no-completion: kept in ${CHOICES/#$HOME/\~} (delete the line to have it turned on)"
    info "no Tab completion (to turn it on: eval \"\$(roster help --completion bash)\" in ~/.bashrc;"
    info "roster help --completion zsh, fish or powershell for those)"
else
    lib=""
    for f in "$here/install-lib.sh" "$src/install-lib.sh"; do [[ -f $f ]] && { lib=$f; break; }; done
    # shellcheck source=install-lib.sh
    if [[ -n $lib ]] && source "$lib"; then turn_on_completion
    else
        warn "no install-lib.sh beside install.sh: Tab completion left off"
        info "to turn it on: eval \"\$(roster help --completion bash)\" in ~/.bashrc (roster help --completion zsh, fish or powershell for those)"
    fi
fi

# 7. Unlock the vault
stage 7
if ! have bw; then
    skip "no Bitwarden CLI"
elif (( DRY )); then
    info "would run: bw login (if needed), bw sync, bw unlock > ${SESSION_FILE/#$HOME/\~}"; done_stage
else
    status=$(bw status --nointeraction 2>/dev/null | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p')
    info "Bitwarden status: ${status:-unknown}"
    if [[ $status == unauthenticated ]]; then
        if (( YES )); then skip "bw login needs you - run: bw login"; status=""
        elif ask "Log in to Bitwarden now?" Y && live "bw login" bw login; then status=locked
        else skip "not logged in"; status=""; fi
    fi
    if [[ -n $status ]]; then
        if [[ -f $SESSION_FILE ]] && BW_SESSION=$(cat "$SESSION_FILE") bw unlock --check --nointeraction >/dev/null 2>&1; then
            ok "vault session in ${SESSION_FILE/#$HOME/\~} still works"
            done_stage
        elif (( YES )); then
            skip "unlocking needs your master password - run: (umask 077; bw unlock --raw > $SESSION_FILE)"
        elif ask "Unlock the vault and save the session for every roster run on this box (${SESSION_FILE/#$HOME/\~}, mode 600)?" Y; then
            mkdir -p "$(dirname "$SESSION_FILE")"
            info "Bitwarden asks for your master password:"
            if key=$(bw unlock --raw < "$TTY") && [[ -n $key ]]; then
                (umask 077; printf '%s' "$key" > "$SESSION_FILE"); unset key
                ok "vault unlocked, session saved"
                BW_SESSION=$(cat "$SESSION_FILE") step "bw sync" bw sync
                done_stage
            else
                bad "unlock failed"; fail_stage
            fi
        else
            skip "vault left locked - roster asks for the master password when it needs it"
        fi
    fi
fi

# 8. Set up this box
stage 8
if [[ -z $CFG ]] || ! have roster; then
    skip "needs roster and a roster.yml"
else
    [[ -f $SESSION_FILE ]] && export BW_SESSION="${BW_SESSION:-$(cat "$SESSION_FILE")}"
    cd "$(dirname "$CFG")" 2>/dev/null || (( DRY )) || exit 1      # a dry run made no folder
    if ask "Check that every vault reference in roster.yml can be found (roster check --auth)?" Y; then
        if (( DRY )); then info "would run: roster check --auth"
        else
            out=$(roster check --auth 2>&1)
            fails=$(grep -c '^  FAIL' <<<"$out")
            oks=$(grep -c '^  ok' <<<"$out")
            reasons=$(grep -A1 '^  FAIL' <<<"$out" | grep -v '^  FAIL\|^--' | sed 's/^ *//' | sort -u)
            if (( ! fails )); then ok "all $oks vault references found"
            elif [[ $(wc -l <<<"$reasons") -eq 1 ]]; then warn "$oks found, $fails missing: $reasons"
            else
                warn "$oks found, $fails missing:"
                grep -A1 '^  FAIL' <<<"$out" | grep -v '^--' | sed 's/^/    /'
            fi
        fi
    fi
    info "setup creates this box's SSH key, records host fingerprints, installs the key on key hosts"
    info "and writes ~/.ssh/config.d/roster and ROSTER.md. It logs in to each host once."
    if ask "Run roster setup now?" Y; then
        if (( DRY )); then step "roster setup --dry-run" roster setup --dry-run; done_stage
        else
            live "roster setup" roster setup && done_stage || fail_stage
        fi
    else
        skip "run it later: roster setup"
    fi
fi

# 9. Auto-update
stage 9
pull="$cfg_dir/bin/roster-pull"
job="*/15 * * * * $pull >> \$HOME/.cache/roster-pull.log 2>&1"
cron_ready=1
if [[ ! -x $pull ]] && (( ! DRY )); then
    skip "no bin/roster-pull in $cfg_dir"; cron_ready=0
elif chose no-cron; then
    skip "no auto-update: you said no before (delete no-cron from ${CHOICES/#$HOME/\~} to be asked again)"; cron_ready=0
elif ! have crontab; then
    # a minimal box or WSL distro (Fedora's, say) ships without cron
    pkg=$(cron_pkg)
    if [[ -z $pkg ]]; then
        skip "no crontab, and no package manager to get it with - run $pull yourself to update"; cron_ready=0
        choose no-cron              # kept, so this box counts as set up (delete it from install-choices to retry)
    elif ! ask "Auto-update runs from cron, which isn't installed. Install $pkg?" Y; then
        skip "no cron - run $pull yourself to update"; cron_ready=0; choose no-cron
    elif ! pkg_install "$pkg" || { (( ! DRY )) && ! have crontab; }; then
        bad "cron didn't install"; fail_stage; cron_ready=0; choose no-cron
    fi
fi
if (( cron_ready )); then
    if ! start_cron; then
        fail_stage
    elif crontab -l 2>/dev/null | grep -qF "$pull"; then
        ok "cron job already there"; done_stage
    elif ask "Pull map updates every 15 minutes (cron job running bin/roster-pull)?" Y; then
        if (( DRY )); then info "would add to crontab: $job"; done_stage
        elif (crontab -l 2>/dev/null; echo "$job") | crontab -; then ok "cron job added"; done_stage
        else bad "couldn't write the crontab"; fail_stage; fi
    else
        skip "update by hand: $pull"; choose no-cron
    fi
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
printf '\n'
info "Next: open a new terminal, then try"
printf '    roster hosts                      %s# every host you can reach%s\n' "$D" "$N"
printf '    ssh <host>                        %s# key hosts%s\n' "$D" "$N"
printf '    roster run <host> -- hostname     %s# password-only hosts%s\n' "$D" "$N"
printf '    roster --help, man roster         %s# every command, with examples; the manual%s\n' "$D" "$N"
printf '\n'
where="${src/#$HOME/\~}${from_desc:+ ($from_desc)}"
if (( keep )); then printf '%sKept roster %s%s (not the older %s from %s)\n' "$B" "$inst_version" "$N" "$older_version" "$where"
elif (( DRY )); then info "dry run: a real run installs roster ${pick_version:+$pick_version }from $where"
elif v=$("$bindir/roster" --version 2>/dev/null | awk '{print $NF}') && [[ -n $v ]]; then
    printf '%sInstalled roster %s%s from %s\n' "$B" "$v" "$N" "$where"
else bad "no roster in $bindir answers --version"; fi
(( ${#FAILED[@]} )) && { info "Some stages failed - details in $LOG. Re-running this is safe."; exit 1; }
exit 0
