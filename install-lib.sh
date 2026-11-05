# What install.sh and update.sh share (#414, #444): sourced by them from beside them, never run on its own. It ships
# with them in the Release's roster-cli tarball. The caller sets YES, DRY, MARK (find_map), CHOICES (chose, choose),
# COMP_MARK (turn_on_completion) and, before `stage` or `summary`, STAGES, TOTAL, DONE, SKIPPED and FAILED.
# shellcheck shell=bash
# shellcheck disable=SC2034  # FULL, EMPTY, SPIN and the colours are read by the scripts that source this

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

stage() {                       # stage N: progress bar + title
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

summary() {                     # summary: each stage, done, skipped or failed
    local s
    printf '\n%sSummary%s\n' "$B" "$N"
    for s in "${STAGES[@]}"; do
        if   listed "$s" ${FAILED[@]+"${FAILED[@]}"};   then bad "$s"
        elif listed "$s" ${SKIPPED[@]+"${SKIPPED[@]}"}; then printf '  %s%s %s (skipped)%s\n' "$D" "$SKIP" "$s" "$N"
        elif listed "$s" ${DONE[@]+"${DONE[@]}"};       then ok "$s"
        else printf '  %s%s %s%s\n' "$D" "$SKIP" "$s" "$N"
        fi
    done
    printf '\n'
}

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

have() { command -v "$1" >/dev/null 2>&1; }
home() { printf '%s' "${1/#$HOME/\~}"; }       # home PATH -> PATH with ~ for $HOME

# ---- the roster source

version_in() {                  # version_in DIR [REF] -> the version in pyproject.toml (at REF, else on disk)
    if [[ -n ${2:-} ]]; then git -C "$1" show "$2:pyproject.toml" 2>/dev/null; else cat "$1/pyproject.toml" 2>/dev/null; fi |
        sed -n 's/^version = "\(.*\)"/\1/p' | head -1
}

older() { [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1) == "$1" ]]; }   # older A B: A < B

describe_source() {             # describe_source DIR [REF] -> "branch main, commit abc1234, v0.5.0"; the branch only
    local d=$1 at=${2:-HEAD} branch="" tag      # for HEAD or its upstream (@{u}), not for a tag's commit
    git -C "$d" rev-parse -q --verify "$at" >/dev/null 2>&1 || return 0
    [[ $at == HEAD || $at == '@{u}' ]] && branch=$(git -C "$d" symbolic-ref -q --short HEAD)
    tag=$(git -C "$d" describe --tags "$at" 2>/dev/null)
    printf '%s, commit %s%s' "${branch:+branch $branch}" "$(git -C "$d" rev-parse --short "$at")" "${tag:+, $tag}" |
        sed 's/^, //'
}

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

installed_roster() {            # the roster command this box has: on PATH (PREFIX/bin first), else where uv put it
    local p
    p=$(command -v roster 2>/dev/null) && [[ -n $p ]] && { echo "$p"; return 0; }
    have uv || return 1
    p=$(uv tool list --show-paths 2>/dev/null | sed -n 's/^- roster (\(.*\))$/\1/p' | head -1)
    [[ -n $p && -x $p ]] && echo "$p"
}

# ---- this box

chose() { grep -qx "$1" "$CHOICES" 2>/dev/null; }                       # chose no-cron: an answer kept from earlier
choose() { (( DRY )) || chose "$1" || { mkdir -p "$(dirname "$CHOICES")" && echo "$1" >> "$CHOICES"; }; }

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

# ---- Tab completion


# turn_on_completion: Tab completion for roster (`roster ho<Tab>`, `roster run <Tab>` for Host names) in each shell
# this box uses, no question (decision Q183). bash and zsh get a marked line that asks roster for its script when the
# shell starts (so a newer roster's commands complete too), fish a file it loads on the first Tab. Nothing is added
# twice, and a fish file that isn't roster's is kept. The line asks for `roster help --completion SHELL` and falls back
# to the older `roster completion SHELL`, so an older roster (another box sharing the dotfile, a downgrade) still
# completes (T222, #447 review M3). A marked line (or roster's fish file) in an older form is rewritten to it
# (new_completion_form), unless COMP_KEEP is set (update.sh: the new roster didn't install); a line of your own is
# left alone. Uses the caller's COMP_MARK, DRY, ok, info and warn.
comp_line() {                   # SHELL: roster's marked rc line for bash or zsh
    printf '%s' "command -v roster >/dev/null 2>&1 && eval \"\$(roster help --completion $1 2>/dev/null || roster completion $1 2>/dev/null)\"   $COMP_MARK"
}
COMP_FISH='begin; roster help --completion fish 2>/dev/null; or roster completion fish 2>/dev/null; end | source'

new_completion_form() {         # FILE LINE [ALL]: roster's marked lines in FILE (every line but the first with ALL:
    local f=$1 line=$2 all=${3:-} tmp      # fish's file) that run roster's completion in another form become LINE
    awk -v m="$COMP_MARK" -v all="$all" -v line="$line" '
        BEGIN { n = 0 }
        ((all != "" && NR > 1) || (all == "" && index($0, m))) && /roster (help --)?completion / && $0 != line { n++ }
        END { exit n == 0 }' "$f" || return 1
    if [[ -n ${COMP_KEEP:-} ]]; then
        info "Tab completion line in ${f/#$HOME/\~} left as it is: the new roster didn't install"; return 0
    fi
    (( DRY )) && { info "would rewrite roster's Tab completion line in ${f/#$HOME/\~} to the new form"; return 0; }
    if tmp=$(mktemp "$f.XXXXXX" 2>/dev/null) && awk -v m="$COMP_MARK" -v all="$all" -v line="$line" '
            ((all != "" && NR > 1) || (all == "" && index($0, m))) && /roster (help --)?completion / { print line; next }
            { print }' "$f" > "$tmp" && cat "$tmp" 2>/dev/null > "$f"; then
        ok "Tab completion line in ${f/#$HOME/\~} rewritten to the new form (roster help --completion)"
    else
        warn "couldn't rewrite roster's Tab completion line in ${f/#$HOME/\~}: it still works as it is"
    fi
    [[ -n ${tmp:-} ]] && rm -f "$tmp"
    return 0
}

turn_on_completion() {
    local comp_shell=${SHELL##*/} comp_added=0 sh f fish_file
    for sh in bash zsh; do
        f="$HOME/.${sh}rc"
        [[ -f $f || $comp_shell == "$sh" ]] || continue
        comp_added=1
        if grep -qF "$COMP_MARK" "$f" 2>/dev/null; then
            new_completion_form "$f" "$(comp_line "$sh")" || ok "Tab completion already on in ${f/#$HOME/\~}"
        elif (( DRY )); then info "would turn on Tab completion in ${f/#$HOME/\~}"
        else
            printf '\n%s\n' "$(comp_line "$sh")" >> "$f"
            ok "Tab completion for roster in ${f/#$HOME/\~}"
        fi
    done
    fish_file="${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/roster.fish"
    if [[ -d ${XDG_CONFIG_HOME:-$HOME/.config}/fish || $comp_shell == fish ]]; then
        comp_added=1
        if [[ -f $fish_file ]] && head -n 1 "$fish_file" | grep -qF "$COMP_MARK"; then
            new_completion_form "$fish_file" "$COMP_FISH" all || ok "Tab completion already on for fish"
        elif [[ -e $fish_file ]]; then warn "${fish_file/#$HOME/\~} isn't roster's: kept it (roster help --completion fish prints roster's)"
        elif (( DRY )); then info "would turn on Tab completion in ${fish_file/#$HOME/\~}"
        elif mkdir -p "$(dirname "$fish_file")" && printf '%s\n' \
                "$COMP_MARK (install.sh wrote this file; uninstall.sh removes it)" "$COMP_FISH" \
                > "$fish_file"; then
            ok "Tab completion for roster in ${fish_file/#$HOME/\~}"
        else warn "couldn't write ${fish_file/#$HOME/\~}"; fi
    fi
    (( comp_added )) || info "no bash, zsh or fish here: roster help --completion SHELL prints Tab completion for yours"
    return 0
}
