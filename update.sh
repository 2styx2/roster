#!/usr/bin/env bash
# Update roster on this box: the newest roster, its man page, and the team's map. Safe to run any time.
#
#   ./update.sh               interactive
#   ./update.sh --yes         accept every default
#   ./update.sh --dry-run     show what would happen, change nothing
#   ./update.sh --prefix DIR  roster lives in DIR/bin (as install.sh --prefix DIR put it); or PREFIX=DIR
#   ./update.sh --allow-downgrade   install this checkout even when it's older than the roster this box has
#   ./update.sh --no-completion     leave Tab completion off (kept for later runs, as install.sh --no-completion)
#
# Stages: the roster source (this checkout: fetched, fast-forwarded when it's behind, a warning when it's older
# than the newest Release tag; never another branch, never your uncommitted work), roster itself (uv tool install,
# and its man page), the team's map (git pull where roster.yml is), and `roster sync` (this box's ssh config and
# ROSTER.md from it), and Tab completion for roster (as install.sh turns it on, unless you said no). A host the map
# gained since needs `roster setup` once; this says so. An older roster than this box has is only installed when you
# say so. It ends with the roster it installed and where from. Output goes to ~/.cache/roster/update.log.
set -uo pipefail

LOG="$HOME/.cache/roster/update.log"
MARK="# roster: ROSTER_CONFIG"
COMP_MARK="# roster: completion"
CHOICES="$HOME/.config/roster/install-choices"   # install.sh's kept answers: no-cron, no-completion

YES=0 DRY=0 PREFIX=${PREFIX:-} ALLOW_DOWNGRADE=0 COMPLETION=1
while (( $# )); do
    case "$1" in
        -y|--yes) YES=1 ;;
        -n|--dry-run) DRY=1 ;;
        --prefix) [[ -n ${2:-} ]] || { echo "--prefix needs a directory" >&2; exit 2; }; PREFIX=$2; shift ;;
        --prefix=*) PREFIX=${1#--prefix=} ;;
        --allow-downgrade) ALLOW_DOWNGRADE=1 ;;
        --no-completion) COMPLETION=0 ;;
        -h|--help) sed -n '2,/^[^#]/{/^#/p}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        # never the whole word: a mistyped flag can carry a URL with a token, and so can a word with no flag (#484 M2);
        # the name ends at its first character that is not a letter, digit or - (=, :, a glued -iURL: #484 L4);
        # longer than any real option (20), it's a glued token, not a name (#489 L1); and it's printed only when it
        # looks like one (--[a-z][a-z-]* or -[a-zA-Z]), so a glued token's start never is (#489 N5)
        -*) opt=${1%%[^A-Za-z0-9-]*}
            if [ ${#opt} -le 20 ] && [[ $opt =~ ^(--[a-z][a-z-]*|-[a-zA-Z])$ ]]; then
                echo "unknown option: $opt (try --help)" >&2
            else echo "unknown option (not repeated) (try --help)" >&2; fi
            exit 2 ;;
        *) echo "unexpected argument (not repeated) (try --help)" >&2; exit 2 ;;
    esac
    shift
done
PREFIX=${PREFIX/#\~/$HOME}

# ---- what install.sh and update.sh share: the look, the questions, find_map and friends (install-lib.sh, beside this
# script in a checkout and in the Release's roster-cli tarball)
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)
if [[ ! -f $here/install-lib.sh ]]; then
    echo "update.sh needs install-lib.sh beside it: run it in a roster checkout or in the unpacked roster-cli tarball" >&2
    exit 2
fi
# shellcheck source=install-lib.sh
source "$here/install-lib.sh"

STAGES=("roster source" "roster" "Team map" "Sync this box" "Tab completion")
TOTAL=${#STAGES[@]}
DONE=() SKIPPED=() FAILED=() target="" keep=0 new=""

version() { "${rbin:-roster}" --version 2>/dev/null | awk '{print $NF}'; }

step() {                        # step "what" cmd...  - output to the log, shown when it fails
    local what=$1; shift
    if (( DRY )); then info "would run: $*"; return 0; fi
    printf '\n==== %s: %s\n' "$what" "$*" >> "$LOG"
    if "$@" >> "$LOG" 2>&1; then ok "$what"; return 0; fi
    bad "$what failed - last lines of $LOG:"
    tail -n 8 "$LOG" | sed "s/^/      $D/; s/\$/$N/"
    return 1
}

# ---- the roster source: is this checkout the roster you mean to install? (#408: a `main` never pulled, at v0.1.0,
# installed 0.1.0 over 0.5.0 without a word)

plural() { (( $1 == 1 )) && echo "$1 $2" || echo "$1 ${2}s"; }

why_no_pull() {                 # why_no_pull DIR: why the map's `git pull --ff-only` failed, said once (T243, #476)
    local d=$1 up                # read-only but for a fetch: never a reset, a stash or a switch
    up=$(git -C "$d" rev-parse --abbrev-ref '@{u}' 2>/dev/null)
    if ! git -C "$d" fetch --quiet --prune 2>/dev/null; then
        echo "couldn't reach the map's server (offline?)"
    elif ! git -C "$d" rev-parse --verify --quiet '@{u}' >/dev/null 2>&1; then
        echo "${up:-its branch} is gone from the server (merged and deleted?): git -C $(home "$d") switch main"
    elif [[ -n $(git -C "$d" status --porcelain --untracked-files=no 2>/dev/null) ]]; then
        echo "uncommitted edits in $(home "$d") block the fast-forward (they're kept)"
    elif [[ $(git -C "$d" rev-list --count '@{u}..HEAD' 2>/dev/null) != 0 ]]; then
        echo "$(home "$d") and $up both have new commits (diverged): merge or rebase it yourself"
    else
        echo "couldn't fast-forward"
    fi
}

check_source() {                # check_source DIR: fetch, offer a fast-forward, warn about an old version
    local src=$1 branch upstream remote behind ahead dirty newest version refs err tags
    target=""                   # the commit a real run installs: @{u} when a dry run would fast-forward
    if [[ $(git -C "$src" rev-parse --show-toplevel 2>/dev/null) != "$(cd "$src" && pwd -P)" ]]; then
        skip "$(home "$src") isn't a git clone (a Release tarball): unpack the newest roster-cli tarball and run its update.sh"
        return 0
    fi
    branch=$(git -C "$src" symbolic-ref -q --short HEAD)
    upstream=$(git -C "$src" rev-parse -q --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)
    remote=$(git -C "$src" config "branch.$branch.remote" 2>/dev/null || true)
    [[ -n $remote ]] || remote=$(git -C "$src" remote | head -1)
    tags=$(git -C "$src" tag --list)        # offline: the tags this clone has
    if [[ -n $remote ]]; then
        # best effort, never a failure offline. Asked first, so a fetch that fails while the remote answers says so
        # instead of reading as offline. The branches' remote-tracking refs move, and the new tags on them (one you
        # have that the remote moved stays as it is, and can't fail it); a dry run fetches too: it changes nothing you
        # work on
        if ! refs=$(git_net "$src" ls-remote --refs --tags "$remote" 2>/dev/null); then
            warn "couldn't reach $remote: checking against what this clone last fetched"
        else
            tags=$(sed -n 's|.*[[:space:]]refs/tags/||p' <<<"$refs")         # the Releases are the remote's tags
            if ! err=$(git_net "$src" fetch --quiet "$remote" 2>&1); then
                warn "$remote answered, but the fetch failed: $(tail -n 1 <<<"$err")"
            fi
        fi
    fi
    if [[ -z $branch ]]; then
        skip "$(home "$src") is on no branch ($(git -C "$src" describe --tags --always 2>/dev/null)): installing it as it is (git switch to a branch to update from it)"
    elif [[ -z $upstream ]]; then
        skip "$branch has no upstream to pull from: installing $(home "$src") as it is"
    else
        behind=$(git -C "$src" rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)
        ahead=$(git -C "$src" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
        dirty=$(git -C "$src" status --porcelain --untracked-files=no 2>/dev/null)
        if (( ! behind )); then
            ok "$branch is up to date with $upstream"; done_stage
        elif (( ahead )); then
            warn "$branch and $upstream have diverged ($ahead and $behind commits): installing $branch as it is, $(plural "$behind" commit) behind"
            skip "an older roster than $upstream's"
        elif [[ -n $dirty ]] && (( YES )); then
            warn "$(home "$src") has uncommitted changes: not fast-forwarding it under --yes (commit or stash them, then run this again)"
            skip "installing $branch as it is: $(plural "$behind" commit) behind $upstream, an older roster"
        elif [[ -n $dirty ]]; then
            warn "$(home "$src") has changes of yours: not pulling (commit or stash them, then run this again)"
            skip "installing $branch as it is: $(plural "$behind" commit) behind $upstream, an older roster"
        else
            info "$branch is $(plural "$behind" commit) behind $upstream"
            if ! ask "Fast-forward it (git pull --ff-only)?" Y; then
                skip "installing $branch as it is: $(plural "$behind" commit) behind $upstream, an older roster"
            elif step "git pull in $(home "$src")" git -C "$src" pull --ff-only --quiet; then
                (( DRY )) && target='@{u}' || info "now at $(git -C "$src" log -1 --format='%h %s' | cut -c1-70)"
                done_stage
            else
                warn "couldn't fast-forward: installing the source as it is"; fail_stage
            fi
        fi
    fi
    # the newest Release tag this clone has seen (vX.Y.Z, not a pre-release)
    newest=$(grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' <<<"$tags" | sort -V | tail -1)
    version=$(version_in "$src" "$target")
    if [[ -n $newest && -n $version ]] && older "$version" "${newest#v}"; then
        warn "this checkout is roster $version, older than the newest Release it can see ($newest): git switch to main and pull, or git checkout $newest"
    fi
    return 0
}

installed() {                   # installed SRC BINDIR: the last word, what roster this box has now and where from
    local from v
    from=$(describe_source "$1" "${target:-HEAD}"); from="$(home "$1")${from:+ ($from)}"
    if (( keep )); then printf '%sKept roster %s%s (not the older %s from %s)\n' "$B" "$before" "$N" "$new" "$from"
    elif (( DRY )); then info "dry run: a real run installs roster $(version_in "$1" "$target") from $from"
    elif v=$("$2/roster" --version 2>/dev/null | awk '{print $NF}') && [[ -n $v ]]; then
        printf '%sInstalled roster %s%s from %s\n' "$B" "$v" "$N" "$from"
    else bad "no roster in $(home "$2") answers --version"; fi
}

(( DRY )) || mkdir -p "$(dirname "$LOG")"
(( DRY )) || : > "$LOG"
export PATH="$HOME/.local/bin:$PATH"
[[ -n $PREFIX ]] && export PATH="$PREFIX/bin:$PATH"

printf '\n%sroster update%s\n' "$B" "$N"
(( DRY )) && warn "dry run: nothing will be changed"
rbin=$(installed_roster) || rbin=""
if [[ -z $rbin ]] || ! have uv; then
    bad "roster (or uv) isn't installed on this box - run ./install.sh first"; exit 1
fi
before=$(version)
info "roster $before now"

# 1. roster source
stage 1
src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ ! -f $src/pyproject.toml ]] || ! grep -q '^name = "roster"' "$src/pyproject.toml"; then
    bad "run update.sh from the roster source folder (where install.sh is)"; exit 1
fi
check_source "$src"

# 2. roster
stage 2
bindir=${PREFIX:+$PREFIX/bin}; bindir=${bindir:-$(dirname "$rbin")}
# never an older roster over a newer one without a yes (#408): a checkout at an old tag, behind and kept as it is
new=$(version_in "$src" "$target")
if [[ -n $new && -n $before ]] && older "$new" "$before" && (( ! ALLOW_DOWNGRADE )) &&
        ! ask "Install roster $new from this checkout over the newer $before this box has?" N; then
    keep=1
    skip "kept roster $before: this checkout is the older $new (--allow-downgrade installs it anyway)"
elif step "install roster from $(home "$src") (uv tool install) into $(home "$bindir")" \
        env "UV_TOOL_BIN_DIR=$bindir" uv tool install --force --reinstall --quiet "$src"; then
    page="$(dirname "$bindir")/share/man/man1/roster.1"
    step "update the man page" sh -c 'mkdir -p "$(dirname "$1")" && cp "$2" "$1"' _ "$page" "$src/src/roster/roster.1" \
        || warn "no man page; roster help --man shows it"
    after=$(version)
    if (( DRY )); then :
    elif [[ $after == "$before" ]]; then ok "roster $after (same version, reinstalled)"
    else ok "roster $before -> $after (what's new: docs/news.md)"; fi
    done_stage
else
    fail_stage
    COMP_KEEP=1             # the old roster stays: stage 5 leaves its rc line as it is (#447 review M3)
fi

# 3. Team map: the one find_map finds (as install.sh looks for it)
find_map
cfg=$MAP
[[ $MAP_FROM == infra ]] && warn "$(home "$cfg") isn't in ROSTER_CONFIG, so roster finds it only from there: ./install.sh sets it"
stage 3
if [[ -z $cfg || ! -f $cfg ]]; then
    skip "no roster.yml found (set ROSTER_CONFIG, or run ./install.sh)"; cfg=""
elif [[ ! -d $(dirname "$cfg")/.git ]]; then
    skip "$(home "$(dirname "$cfg")") isn't a git clone: nothing to pull"
elif ! git -C "$(dirname "$cfg")" -c core.fsmonitor=false rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
    # a local repo (install.sh's optional git init): roster saves edits in place, and there's nowhere to pull from
    skip "$(home "$(dirname "$cfg")") has no upstream to pull from: nothing to pull"
elif ask "Pull the latest map into $(home "$(dirname "$cfg")")?" Y; then
    if step "git pull" git -C "$(dirname "$cfg")" pull --ff-only --quiet; then done_stage
    else warn "$(why_no_pull "$(dirname "$cfg")"); using the map as it is"; fail_stage; fi
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
    # the map only, never reading the terminal (#503's review HIGH-1): a vault unlock mid-update would lock the
    # roster app's session; `roster sync` or `roster vault sync` picks up the vault
    if step "roster sync (ssh config and ROSTER.md from the map)" roster sync --no-vault </dev/null; then
        done_stage
        # T243: end as `roster sync` does: its next command (the last line it printed), only when something is left
        last=$(tail -n 1 "$LOG")
        (( DRY )) || [[ $last != *"next: "* ]] || info "next: ${last#*next: }"
    else fail_stage; fi
fi

# 5. Tab completion: on, as install.sh turns it on, for a box installed before it did (unless you said no)
stage 5
(( COMPLETION )) || choose no-completion
if (( ! COMPLETION )) || chose no-completion; then
    skip "left off (you said no: delete no-completion from $(home "$CHOICES") to have it turned on)"
else
    turn_on_completion          # install-lib.sh's step, shared with install.sh
    done_stage
fi
# The cron job install.sh sets up: it installs cron itself, so a box without the job is install.sh's to finish
if [[ -n $cfg && -x $(dirname "$cfg")/bin/roster-pull ]] && ! chose no-cron &&
        ! { have crontab && crontab -l 2>/dev/null | grep -qF "$(dirname "$cfg")/bin/roster-pull"; }; then
    warn "no auto-update cron job: ./install.sh sets it up (it finishes a box that has none)"
fi

# ---- summary

summary
installed "$src" "$bindir"
(( ${#FAILED[@]} )) && { info "Some stages failed - details in $LOG. Re-running this is safe."; exit 1; }
exit 0
