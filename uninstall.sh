#!/usr/bin/env bash
# Remove roster from this box: what install.sh and `roster setup` put here, and this box's key on the hosts.
# Every stage asks first and is safe to re-run.
#
#   ./uninstall.sh               interactive
#   ./uninstall.sh --yes         accept every default (keeps what may be shared: bw, the ~/.local/bin PATH line,
#                                your config folder)
#   ./uninstall.sh --purge       also remove those: the defaults for bw, the PATH line and the config folder
#                                become yes (a config folder with changes not pushed still defaults to no)
#   ./uninstall.sh --keep-hosts  don't touch the hosts (no mesh cut, no revoke): this box's key stays on them
#   ./uninstall.sh --dry-run     show what would happen, change nothing
#   ./uninstall.sh --prefix DIR  roster is in DIR/bin (as install.sh --prefix DIR put it); or PREFIX=DIR
#
# Stages: take this box off its hosts (roster mesh cut --all, roster revoke --all), the auto-update cron job, the
# lines in shell startup files (and fish's Tab completion file), this box's SSH key and ssh config, the vault session, roster and its man page, and
# the files `roster setup` wrote next to roster.yml. Output of each step goes to ~/.cache/roster-uninstall.log.
set -uo pipefail

LOG="$HOME/.cache/roster-uninstall.log"
CONF_DIR="$HOME/.config/roster"
SESSION_FILE="$CONF_DIR/bw-session"
MARK="# roster: ROSTER_CONFIG"           # the line install.sh adds to shell startup files
PATH_MARK="# roster: uv tools"           # and the PATH line it adds when ~/.local/bin wasn't there
MAN_MARK="# roster: man page"            # and the MANPATH line, when man didn't find the page by itself
COMP_MARK="# roster: completion"         # and the Tab completion line (fish: the file that starts with it)

YES=0 DRY=0 PURGE=0 KEEP_HOSTS=0 PREFIX=${PREFIX:-}
while (( $# )); do
    case "$1" in
        -y|--yes) YES=1 ;;
        -n|--dry-run) DRY=1 ;;
        --purge) PURGE=1 ;;
        --keep-hosts) KEEP_HOSTS=1 ;;
        --prefix) [[ -n ${2:-} ]] || { echo "--prefix needs a directory" >&2; exit 2; }; PREFIX=$2; shift ;;
        --prefix=*) PREFIX=${1#--prefix=} ;;
        -h|--help) sed -n '2,/^[^#]/{/^#/p}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
    shift
done
EXTRA=N; (( PURGE )) && EXTRA=Y          # the default for things other tools may share

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

STAGES=("Hosts" "Auto-update" "Shell startup" "SSH files" "Vault" "roster" "Config folder")
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

live() {                        # live "what" cmd...  - in the foreground: its output and questions are the user's
    local what=$1; shift
    if (( DRY )); then info "would run: $*"; return 0; fi
    info "$what"
    if "$@" < "$TTY"; then ok "$what"; else bad "$what failed"; return 1; fi
}

remove() {                      # remove "what" path...  - the ones that exist
    local what=$1 p there=(); shift
    for p in "$@"; do [[ -e $p || -L $p ]] && there+=("$p"); done
    (( ${#there[@]} )) || return 0
    step "remove $what" rm -rf -- "${there[@]}"
}

drop_lines() {                  # drop_lines FILE PATTERN  - delete the lines matching the grep -E PATTERN, keep mode
    local f=$1 re=$2 tmp
    grep -qE "$re" "$f" 2>/dev/null || return 1
    if (( DRY )); then info "would remove from ${f/#$HOME/\~}: $(grep -E "$re" "$f" | head -1)"; return 0; fi
    # rewritten in place (a symlinked dotfile stays a symlink, its mode stays) and only from a complete copy: a failed
    # mktemp or a full disk must never empty ~/.bashrc. The copy is smaller than the file, whose space the rewrite
    # frees first. grep -v exits 1 when no line is left: a complete copy too.
    local rc=0
    tmp=$(mktemp) || { bad "couldn't edit ${f/#$HOME/\~} (no temp file): remove its line marked # roster: yourself"; return 1; }
    grep -vE "$re" "$f" > "$tmp" || rc=$?
    if (( rc > 1 )); then
        rm -f "$tmp"; bad "couldn't edit ${f/#$HOME/\~}: remove its line marked # roster: yourself"; return 1
    fi
    cat "$tmp" > "$f"; rm -f "$tmp"
    ok "removed roster's line from ${f/#$HOME/\~}"
}

have() { command -v "$1" >/dev/null 2>&1; }
home() { printf '%s' "${1/#$HOME/\~}"; }

# ---- what's here

(( DRY )) || mkdir -p "$(dirname "$LOG")"
(( DRY )) || : > "$LOG"
export PATH="$HOME/.local/bin:$PATH"
PREFIX=${PREFIX/#\~/$HOME}
[[ -n $PREFIX ]] && export PATH="$PREFIX/bin:$PATH"     # install.sh --prefix DIR put roster in DIR/bin
rc_files=()
for f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do [[ -f $f ]] && rc_files+=("$f"); done

# The roster.yml: $ROSTER_CONFIG, else the line install.sh wrote, else where install.sh puts it by default
cfg=${ROSTER_CONFIG:-}
if [[ -z $cfg ]]; then
    for f in ${rc_files[@]+"${rc_files[@]}"}; do
        v=$(grep -F "$MARK" "$f" 2>/dev/null | sed -n 's/^export ROSTER_CONFIG="\(.*\)".*/\1/p' | tail -1)
        [[ -n $v ]] && { cfg=${v//\$HOME/$HOME}; break; }
    done
fi
[[ -z $cfg && -f $HOME/infra/roster.yml ]] && cfg=$HOME/infra/roster.yml
[[ -z $cfg && -f $CONF_DIR/roster.yml ]] && cfg=$CONF_DIR/roster.yml
cfg_dir=${cfg:+$(dirname "$cfg")}

# Every roster.yml this box knows (that one and the named Inventories'), for their key_path
yamls=()
[[ -f $cfg ]] && yamls+=("$cfg")
if [[ -f $CONF_DIR/inventories.json ]]; then
    while IFS= read -r p; do [[ -f $p ]] && yamls+=("$p"); done \
        < <(grep -o '"path": *"[^"]*"' "$CONF_DIR/inventories.json" | sed 's/.*: *"\(.*\)"/\1/')
fi
keys=("$HOME/.ssh/roster_ed25519")
other_keys=()        # a key_path: of a roster.yml: may be a key you use for more than roster, so asked about apart
for y in ${yamls[@]+"${yamls[@]}"}; do
    k=$(sed -n 's/^key_path: *["'\'']\{0,1\}\([^"'\'' #]*\).*/\1/p' "$y" | head -1)
    k=${k/#\~/$HOME}
    [[ -n $k && $k != "${keys[0]}" ]] && ! listed "$k" ${other_keys[@]+"${other_keys[@]}"} && other_keys+=("$k")
done
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)       # before any cd: BASH_SOURCE may be relative

printf '\n%sroster uninstaller%s\n' "$B" "$N"
info "Takes this box off its hosts, then removes roster and the files it wrote here. Your vault is not touched."
(( DRY )) && warn "dry run: nothing will be changed"
(( YES )) && info "--yes: taking the default answer everywhere"
(( PURGE )) && info "--purge: bw, the PATH line and the config folder go too (uv stays)"
[[ -n $cfg ]] && info "roster.yml: $(home "$cfg")"

# 1. Hosts: while roster can still log in to them (docs/mesh.md, Uninstalling roster)
stage 1
REVOKED=0
set_up=0
for p in "$HOME/.ssh/config.d/roster" "$HOME/.ssh/roster-inventories" "$CONF_DIR/inventories.json"; do
    [[ -e $p ]] && set_up=1
done
if (( KEEP_HOSTS )); then
    skip "--keep-hosts: this box's key stays on its hosts (roster revoke --all removes it while roster is here)"
elif (( ! set_up )); then
    ok "roster setup never ran on this box: no key on any host"; REVOKED=1; done_stage
elif ! have roster; then
    warn "roster isn't installed any more, so it can't reach the hosts to take this box's key off"
    info "reinstall it (./install.sh) and run this again, or delete the roster-managed:<this box> lines in each"
    info "host's ~/.ssh/authorized_keys by hand"
    fail_stage
elif ask "Take this box off its hosts first (roster mesh cut --all, then roster revoke --all)? They must be reachable" Y; then
    [[ -f $SESSION_FILE ]] && export BW_SESSION="${BW_SESSION:-$(cat "$SESSION_FILE")}"
    [[ -n $cfg ]] && export ROSTER_CONFIG="$cfg"
    cd "${cfg_dir:-$HOME}" 2>/dev/null || cd "$HOME" || exit 1
    mesh_ok=1
    if compgen -G "$CONF_DIR/mesh*.json" >/dev/null; then
        live "roster mesh cut --all (this box's Mesh entries off every host)" roster mesh cut --all -y || mesh_ok=0
    else
        info "no Mesh on this box (no ~/.config/roster/mesh*.json)"
    fi
    if live "roster revoke --all (this box's key off every host)" roster revoke --all -y; then REVOKED=1; fi
    (( DRY )) && REVOKED=1
    if (( REVOKED && mesh_ok )); then done_stage
    else
        warn "not every host was reached: run this again when they are, or finish by hand later"
        fail_stage
    fi
    cd "$HOME" || exit 1
else
    skip "this box's key stays on its hosts"
fi

# 2. Auto-update
stage 2
if ! have crontab; then
    skip "no crontab on this box"
elif crontab -l 2>/dev/null | grep -q '/bin/roster-pull'; then
    if ask "Remove the cron job that pulls map updates (bin/roster-pull)?" Y; then
        if (( DRY )); then info "would remove from crontab: $(crontab -l | grep '/bin/roster-pull')"; done_stage
        elif (crontab -l 2>/dev/null | { grep -v '/bin/roster-pull' || true; }) | crontab -; then ok "cron job removed"; done_stage
        else bad "couldn't write the crontab"; fail_stage; fi
    else skip "kept the cron job"; fi
else
    ok "no roster cron job"; done_stage
fi

# 3. Shell startup
stage 3
for f in ${rc_files[@]+"${rc_files[@]}"}; do
    drop_lines "$f" "$MARK\$" || true; drop_lines "$f" "$MAN_MARK\$" || true; drop_lines "$f" "$COMP_MARK\$" || true
done
fish_file="${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/roster.fish"
if [[ -f $fish_file ]] && head -n 1 "$fish_file" | grep -qF "$COMP_MARK"; then
    remove "fish's Tab completion for roster ($(home "$fish_file"))" "$fish_file"
fi
path_files=()
for f in ${rc_files[@]+"${rc_files[@]}"}; do grep -qF "$PATH_MARK" "$f" && path_files+=("$f"); done
if (( ${#path_files[@]} )); then
    if ask "Remove the ~/.local/bin PATH line install.sh added? (uv and other tools there use it too)" "$EXTRA"; then
        for f in "${path_files[@]}"; do drop_lines "$f" "$PATH_MARK\$"; done
    else info "kept ~/.local/bin on PATH"; fi
fi
for f in ${rc_files[@]+"${rc_files[@]}"}; do
    if grep -q 'ROSTER_CONFIG=' "$f"; then warn "$(home "$f") still sets ROSTER_CONFIG (not install.sh's line): remove it yourself"; fi
done
info "open a new terminal (or: exec \$SHELL) to drop them here"
done_stage

# 4. SSH files: this box's key, roster's ssh config and known hosts
stage 4
ssh_files=()
for k in "${keys[@]}"; do ssh_files+=("$k" "$k.pub"); done
ssh_files+=("$HOME/.ssh/config.d/roster" "$HOME/.ssh/config.d/roster.inventories" "$HOME/.ssh/roster-inventories")
for p in "$HOME/.ssh/config.d/roster-"* "$HOME/.ssh/roster_known_hosts"*; do ssh_files+=("$p"); done
[[ -f $HOME/.ssh/roster-mesh/config ]] && head -n 1 "$HOME/.ssh/roster-mesh/config" | grep -q '^# Written by roster mesh' \
    && ssh_files+=("$HOME/.ssh/roster-mesh")
there=()
for p in "${ssh_files[@]}"; do [[ -e $p ]] && there+=("$p"); done
inc_re='^[[:space:]]*Include[[:space:]]+"?[^"]*/\.ssh/config\.d/roster(\.inventories)?"?[[:space:]]*$'
if (( ! ${#there[@]} )) && ! grep -qiE "$inc_re" "$HOME/.ssh/config" 2>/dev/null; then
    ok "none here"; done_stage
else
    go=Y
    if (( ! REVOKED )); then
        warn "this box's key may still be on hosts. Without the key and ssh config you can't revoke it later"
        info "(roster revoke --all), only by editing each host's authorized_keys"
        go=N
    fi
    for p in ${there[@]+"${there[@]}"}; do info "$(home "$p")"; done
    if ask "Delete these, and the Include line in ~/.ssh/config?" "$go"; then
        remove "this box's roster key and ssh config" ${there[@]+"${there[@]}"} || fail_stage
        if [[ -f $HOME/.ssh/config ]]; then
            # grep -E has no -i with patterns in drop_lines; ssh's keywords are case-insensitive, so match both
            drop_lines "$HOME/.ssh/config" "${inc_re/Include/[Ii][Nn][Cc][Ll][Uu][Dd][Ee]}" || true
            if (( ! DRY )) && ! grep -q '[^[:space:]]' "$HOME/.ssh/config"; then
                rm -f "$HOME/.ssh/config"; ok "removed ~/.ssh/config (roster's Include was all it had)"
            fi
        fi
        rmdir "$HOME/.ssh/config.d" 2>/dev/null || true
        listed "$CUR" ${FAILED[@]+"${FAILED[@]}"} || done_stage
    else
        skip "kept this box's key and ssh config"
    fi
fi
# A key_path: elsewhere (~/.ssh/id_ed25519?) may be your own key for other servers too: never deleted by default
for k in ${other_keys[@]+"${other_keys[@]}"}; do
    [[ -e $k ]] || continue
    warn "roster.yml's key_path: is $(home "$k"): if roster made it just for this box, it can go too"
    if (( REVOKED )) && ask "Delete $(home "$k") and its .pub? (no if you use it for anything else)" N; then
        remove "$(home "$k")" "$k" "$k.pub"
    else info "kept $(home "$k")"; fi
done

# 5. Vault
stage 5
if [[ -f $SESSION_FILE ]]; then remove "the saved vault session ($(home "$SESSION_FILE"))" "$SESSION_FILE"; fi
if have bw; then
    bw_path=$(command -v bw)
    if ask "Log the Bitwarden CLI out on this box (bw logout)?" "$EXTRA"; then
        (( DRY )) && info "would run: bw logout" || { bw logout >> "$LOG" 2>&1 && ok "bw logged out" || info "bw wasn't logged in"; }
    fi
    if ask "Remove the Bitwarden CLI itself ($(home "$bw_path"))?" "$EXTRA"; then
        gone=0
        if [[ $bw_path == "$HOME/.local/bin/bw" ]]; then remove "bw" "$bw_path" && gone=1
        elif have npm && npm ls -g @bitwarden/cli >/dev/null 2>&1; then
            step "npm uninstall -g @bitwarden/cli" npm uninstall -g @bitwarden/cli && gone=1
        else warn "bw at $bw_path wasn't installed by install.sh - remove it with what installed it"; fi
        # its own folder: the login and the encrypted copy of the vault it synced
        (( gone )) && remove "bw's data (~/.config/Bitwarden CLI)" "$HOME/.config/Bitwarden CLI"
    fi
fi
done_stage

# 6. roster
stage 6
keep_roster=0
if have roster && (( ! REVOKED && ! KEEP_HOSTS && set_up )); then
    warn "this box's key may still be on hosts, and roster is what takes it off (roster revoke --all)"
    ask "Remove roster anyway?" N || keep_roster=1
fi
if (( keep_roster )); then
    skip "kept roster: run ./uninstall.sh again once the hosts are reachable"
elif have roster; then
    rbin=$(command -v roster)
    page="$(dirname "$(dirname "$rbin")")/share/man/man1/roster.1"
    if have uv && uv tool list 2>/dev/null | grep -q '^roster '; then
        step "uv tool uninstall roster" uv tool uninstall roster || fail_stage
    else
        warn "roster at $(home "$rbin") wasn't installed with uv tool install - remove it with what installed it"
        fail_stage
    fi
    remove "the man page" "$page"
else
    ok "roster isn't installed"
fi
if (( ! keep_roster )); then
[[ ${page:-} == "$HOME/.local/share/man/man1/roster.1" ]] || remove "the man page" "$HOME/.local/share/man/man1/roster.1"
# roster's own folder: what roster wrote (Mesh state, the Inventory list) goes; what you put there is asked about.
# Kept with roster: revoke --all and mesh cut --all need them.
mine=()
for p in "$CONF_DIR"/mesh*.json* "$CONF_DIR"/inventories.json* "$CONF_DIR"/*.removed-*; do [[ -e $p ]] && mine+=("$p"); done
remove "roster's state in $(home "$CONF_DIR")" ${mine[@]+"${mine[@]}"}
yours=()
for p in "$CONF_DIR"/*; do [[ -e $p ]] && yours+=("$p"); done
if (( ${#yours[@]} )) && [[ ${cfg_dir:-} == "$CONF_DIR" ]]; then
    info "kept $(home "$CONF_DIR"): your roster.yml is there (the next stage asks about it, checking it's saved)"
elif (( ${#yours[@]} )); then
    info "$(home "$CONF_DIR") also has: ${yours[*]/#$CONF_DIR\//}"
    if ask "Delete $(home "$CONF_DIR") with those too (your roster.yml or provider plugins, if they're there)?" "$EXTRA"; then
        remove "$(home "$CONF_DIR")" "$CONF_DIR"
    else info "kept $(home "$CONF_DIR")"; fi
fi
[[ -d $CONF_DIR ]] && (( ! DRY )) && rmdir "$CONF_DIR" 2>/dev/null
remove "roster's logs and cache" "$HOME/.cache/roster" "$HOME/.cache/roster-pull.log"
fi
listed "$CUR" ${FAILED[@]+"${FAILED[@]}"} || done_stage

# 7. Config folder: the team's map stays unless you ask; what `roster setup` wrote next to it goes
stage 7
if [[ -z $cfg_dir || ! -d $cfg_dir ]]; then
    skip "no roster.yml found here"
else
    unsaved=""
    if [[ -d $cfg_dir/.git ]]; then
        # what `roster setup` wrote there isn't yours: it doesn't count
        # a repo with nowhere to push (a local one: install's git init) is the only copy, whatever else it has
        git -C "$cfg_dir" -c core.fsmonitor=false rev-parse '@{u}' >/dev/null 2>&1 || unsaved="no upstream to push to"
        [[ -z $unsaved && -n $(git -C "$cfg_dir" -c core.fsmonitor=false status --porcelain -- . ':!ROSTER.md' ':!CLAUDE.md' ':!.claude' 2>/dev/null) ]] \
            && unsaved="changes not committed"
        [[ -z $unsaved && -n $(git -C "$cfg_dir" -c core.fsmonitor=false log --oneline '@{u}..' 2>/dev/null) ]] && unsaved="commits not pushed"
    else
        unsaved="not a git clone"
    fi
    # Not a git clone: the whole folder is roster's to offer only when it holds nothing but roster's own files (a
    # roster.yml used where it is, in ~/Downloads say, isn't roster's folder)
    others=""
    if [[ ! -d $cfg_dir/.git ]]; then
        others=$(cd "$cfg_dir" && ls -A | grep -vxE 'roster\.yml|roster\.yml\.bak|ROSTER\.md|CLAUDE\.md|\.claude|bin' | head -n 3)
    fi
    if [[ -n $unsaved ]]; then info "$(home "$cfg_dir") has $unsaved: it stays unless you say so"; fi
    def=$EXTRA; [[ -n $unsaved ]] && def=N
    if [[ -n $others ]]; then
        info "kept $(home "$cfg_dir"): it holds other files too ($(tr '\n' ' ' <<<"$others" | sed 's/ $//')), so it isn't roster's to delete"
        del=1
    elif (( YES )) && [[ -n $unsaved ]]; then
        printf '  %s?%s Delete the whole config folder %s? %s[y/N]%s no\n' "$C" "$N" "$(home "$cfg_dir")" "$D" "$N"
        del=1
    elif ask "Delete the whole config folder $(home "$cfg_dir") ($(case $unsaved in "") echo "the team's map; a fresh clone brings it back" ;; "changes not committed"|"commits not pushed") echo "its $unsaved would be lost" ;; *) echo "$unsaved: this is its only copy" ;; esac))?" "$def"; then
        del=0
    else del=1; fi
    if (( del == 0 )); then
        remove "$(home "$cfg_dir")" "$cfg_dir" && done_stage || fail_stage
    else
        tracked() { [[ -d $cfg_dir/.git ]] && git -C "$cfg_dir" -c core.fsmonitor=false ls-files --error-unmatch "$1" >/dev/null 2>&1; }
        md=$cfg_dir/ROSTER.md
        if [[ -f $md ]] && head -n 1 "$md" | grep -q '^<!-- generated by roster' && ! tracked ROSTER.md; then
            remove "$(home "$md") (roster setup wrote it)" "$md"
        fi
        cm=$cfg_dir/CLAUDE.md
        if [[ -f $cm ]] && ! tracked CLAUDE.md; then
            drop_lines "$cm" '^@ROSTER\.md$' || true
            if (( ! DRY )) && ! grep -q '[^[:space:]]' "$cm"; then rm -f "$cm"; ok "removed $(home "$cm") (it only imported ROSTER.md)"; fi
        fi
        info "kept $(home "$cfg_dir/.claude/settings.json") if it's there: its rules keep Claude out of ~/.ssh"
        done_stage
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
info "Not touched: your vault, the hosts' own accounts, and this roster source folder ($(home "$here"))."
if have uv && (( PURGE )); then
    info "uv stays (other tools use it). To remove it too: uv cache clean; rm ~/.local/bin/uv ~/.local/bin/uvx"
fi
(( ${#FAILED[@]} )) && { info "Some stages failed - details in $LOG. Re-running this is safe."; exit 1; }
exit 0
