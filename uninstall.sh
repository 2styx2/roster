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
# lines in shell startup files (and fish's Tab completion file), this box's SSH keys and ssh config, the vault session, roster and its man page, and
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

# ---- what install.sh, update.sh and uninstall.sh share: the look, the questions, have and home (install-lib.sh,
# beside this script in a checkout and in the Release's roster-cli tarball)
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)     # before any cd: BASH_SOURCE may be relative
if [[ ! -f $here/install-lib.sh ]]; then
    echo "uninstall.sh needs install-lib.sh beside it: run it in a roster checkout or in the unpacked roster-cli tarball" >&2
    exit 2
fi
# shellcheck source=install-lib.sh
source "$here/install-lib.sh"

STAGES=("Hosts" "Auto-update" "Shell startup" "SSH files" "Vault" "roster" "Config folder")
TOTAL=${#STAGES[@]}
DONE=() SKIPPED=() FAILED=()
gone_keys=()                    # the key files stage 4 removed (a dry run: would remove)

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
# This Box's keys (T256, #508; Q204 (l)): every key roster made here, whatever its type (T239: roster_ecdsa,
# roster_rsa-4096, ... beside key_path:), a rotation's KEY.old and KEY.new (T240), and a key_path: of another name.
# One goes only when it's vouched for, as boxkeys.all_keys does: the private key is this user's alone, ssh-keygen -y of
# it gives its .pub, and that .pub carries this Box's roster-managed: tag. Never a key of the user's own.
KEY_RE='^roster_(ed25519|ecdsa|ecdsa-256|ecdsa-521|rsa|rsa-[0-9]{4,5})(\.old|\.new)?$'   # boxkeys' file names
own_keys=()          # each roster.yml's own key: key_path:, else ~/.ssh/roster_<key_type:>
other_keys=()        # a key_path: of another name: may be a key you use for more than roster, so asked about apart
key_dirs=("$HOME/.ssh")
for y in ${yamls[@]+"${yamls[@]}"}; do
    k=$(sed -n 's/^key_path: *["'\'']\{0,1\}\([^"'\'' #]*\).*/\1/p' "$y" | head -1)
    k=${k/#\~/$HOME}
    if [[ -z $k ]]; then
        t=$(sed -n 's/^key_type: *["'\'']\{0,1\}\([A-Za-z0-9-]*\).*/\1/p' "$y" | head -1 | tr '[:upper:]' '[:lower:]')
        case ${t:-ed25519} in ecdsa-384) t=ecdsa ;; rsa-3072) t=rsa ;; esac
        k=$HOME/.ssh/roster_${t:-ed25519}
    fi
    listed "$k" ${own_keys[@]+"${own_keys[@]}"} || own_keys+=("$k")
    listed "${k%/*}" "${key_dirs[@]}" || key_dirs+=("${k%/*}")
    [[ ${k##*/} =~ $KEY_RE ]] || listed "$k" ${other_keys[@]+"${other_keys[@]}"} || other_keys+=("$k")
done
(( ${#own_keys[@]} )) || own_keys=("$HOME/.ssh/roster_ed25519")

why_not() {                     # why_not KEY: says why this Box doesn't hold KEY (1), or nothing when it does (0):
    local k=$1 m a b c d        # it's this user's alone, and ssh-keygen -y of it gives KEY.pub
    if [[ -L $k || -L $k.pub ]]; then echo "it's a symbolic link"; return 1; fi
    [[ -f $k ]] || { echo "it isn't a file"; return 1; }
    [[ -O $k ]] || { echo "it isn't yours"; return 1; }
    m=$(LC_ALL=C ls -ln -- "$k" 2>/dev/null)
    [[ ${m:4:6} == ------ ]] || { echo "others may read or write it"; return 1; }
    [[ -f $k.pub ]] || { echo "no .pub beside it"; return 1; }
    have ssh-keygen || { echo "no ssh-keygen here to check it"; return 1; }
    read -r a b _ < <(ssh-keygen -y -P '' -f "$k" < /dev/null 2>/dev/null)
    read -r c d _ < "$k.pub" 2>/dev/null
    [[ -n $a && -n $b && $a == "$c" && $b == "$d" ]] && return 0
    echo "its .pub isn't its own public key, or it has a passphrase"; return 1
}
holds() { why_not "$1" > /dev/null; }
tag_of() {                      # tag_of PUB -> its roster-managed:NAME tag (an older roster's fleet-managed:NAME)
    local a b c rest
    read -r a b c rest < "$1" 2>/dev/null || [[ -n ${c:-} ]] || return 1
    [[ -z $rest && $c =~ ^(roster-managed|fleet-managed):[A-Za-z0-9_-]+$ ]] && printf '%s' "$c"
}
# this Box's names: the ones roster recorded its key lines under (key-name, key-name-INVENTORY), each roster.yml's
# box_name: (else this box's hostname, as roster names it), and the tag on each roster.yml's own key this Box holds
box_names=()
for f in "$CONF_DIR"/key-name "$CONF_DIR"/key-name-*; do
    [[ -f $f ]] && read -r v < "$f" && [[ -n $v ]] && box_names+=("$v")
done
for y in ${yamls[@]+"${yamls[@]}"}; do
    v=$(sed -n 's/^box_name: *["'\'']\{0,1\}\([^"'\'' #]*\).*/\1/p' "$y" | head -1)
    if [[ -z $v ]]; then v=$(uname -n 2>/dev/null); v=${v%%.*}; fi
    [[ -n $v ]] && box_names+=("$(printf '%s' "$v" | sed 's/[^A-Za-z0-9_-]/-/g')")
done
have ssh-keygen && for k in "${own_keys[@]}"; do
    holds "$k" && v=$(tag_of "$k.pub") && box_names+=("${v#*:}")
done
roster_key_files=()
box_keys=() box_tags=()         # this Box's roster_* keys, and the tag that vouched for each (shown before deleting)
named_keys=() named_tags=()     # this Box's keys at a key_path: of another name: each asked about apart, default no
not_vouched=() not_why=()       # the rest, and why each isn't this Box's
for d in "${key_dirs[@]}"; do
    for k in "$d"/roster_*; do
        [[ ${k##*/} =~ $KEY_RE ]] && [[ -e $k || -L $k ]] && roster_key_files+=("$k")
    done
done
for k in ${other_keys[@]+"${other_keys[@]}"}; do
    for f in "$k" "$k.old" "$k.new"; do [[ -e $f || -L $f ]] && roster_key_files+=("$f"); done
done
for k in ${roster_key_files[@]+"${roster_key_files[@]}"}; do
    if r=$(why_not "$k"); then
        v=$(tag_of "$k.pub")
        if [[ -z $v ]]; then r="its .pub has no roster-managed: tag"
        elif ! listed "${v#*:}" ${box_names[@]+"${box_names[@]}"}; then r="tagged $v, not a name of this box's"
        fi
    fi
    if [[ -n $r ]]; then not_vouched+=("$k"); not_why+=("$r")
    elif [[ ${k##*/} == roster_* ]]; then box_keys+=("$k"); box_tags+=("$v")
    else named_keys+=("$k"); named_tags+=("$v"); fi
done
tag_for() {                     # tag_for KEY: " (the tag that vouched for it)" when KEY is one of this Box's keys
    local i
    for i in ${box_keys[@]+"${!box_keys[@]}"}; do [[ ${box_keys[i]} == "$1" ]] && printf ' (%s)' "${box_tags[i]}"; done
    for i in ${named_keys[@]+"${!named_keys[@]}"}; do [[ ${named_keys[i]} == "$1" ]] && printf ' (%s)' "${named_tags[i]}"; done
    return 0
}

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

# 4. SSH files: this box's keys, roster's ssh config and known hosts
stage 4
ssh_files=()
for k in ${box_keys[@]+"${box_keys[@]}"}; do ssh_files+=("$k" "$k.pub"); done
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
    if (( KEEP_HOSTS )) && (( ${#box_keys[@]} )); then
        warn "--keep-hosts: this box's keys below still log in to its hosts (their lines stay in authorized_keys there)"
        info "deleting them here doesn't take them off: only roster revoke --all, or editing each host's"
        info "authorized_keys by hand, does"
        go=N
    elif (( ! REVOKED )); then
        warn "this box's key may still be on hosts. Without the key and ssh config you can't revoke it later"
        info "(roster revoke --all), only by editing each host's authorized_keys"
        go=N
    fi
    for p in ${there[@]+"${there[@]}"}; do info "$(home "$p")$(tag_for "$p")"; done
    if ask "Delete these, and the Include line in ~/.ssh/config?" "$go"; then
        remove "this box's roster keys and ssh config" ${there[@]+"${there[@]}"} || fail_stage
        gone_keys=(${box_keys[@]+"${box_keys[@]}"})
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
# A roster_* key file roster can't vouch for (not this user's alone, no .pub of its own, no tag of this Box's) isn't
# roster's to delete: said, with why, and kept
for i in ${not_vouched[@]+"${!not_vouched[@]}"}; do
    k=${not_vouched[i]}
    listed "$k" ${other_keys[@]+"${other_keys[@]}"} && continue                   # asked about below
    info "kept $(home "$k"): not this box's roster key (${not_why[i]})"
done
# A key_path: of another name (~/.ssh/id_ed25519?) may be your own key for other servers too, even when roster made it
# (ssh offers ~/.ssh/id_* keys to every server): asked about apart, never deleted by default
for k in ${other_keys[@]+"${other_keys[@]}"}; do
    [[ -e $k ]] || continue
    if listed "$k" ${named_keys[@]+"${named_keys[@]}"}; then
        warn "roster.yml's key_path: is $(home "$k"), which roster made for this box$(tag_for "$k"); ssh offers"
        info "~/.ssh/id_* keys to every server, so you may use it elsewhere too"
    else
        warn "roster.yml's key_path: is $(home "$k"): if roster made it just for this box, it can go too"
    fi
    if (( REVOKED )) && ask "Delete $(home "$k") and its .pub? (no if you use it for anything else)" N; then
        drop=("$k" "$k.pub")
        for f in "$k.old" "$k.new"; do listed "$f" ${named_keys[@]+"${named_keys[@]}"} && drop+=("$f" "$f.pub"); done
        remove "$(home "$k")" "${drop[@]}"
        gone_keys+=("${drop[@]}")
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
remove "the roster source install.sh unpacked" "${XDG_DATA_HOME:-$HOME/.local/share}/roster/source"
remove "install.sh's kept answers" "$CONF_DIR/install-choices"
(( DRY )) || rmdir "${XDG_DATA_HOME:-$HOME/.local/share}/roster" 2>/dev/null || true
# roster's own folder: what roster wrote goes; what you put there (roster.yml, providers/) is asked about.
# Kept with roster: revoke --all and mesh cut --all need them. Every name roster writes there must be below
# (tests/test_install_scripts.py reads them from roster's source): the Mesh state, the Inventory list and what a
# removed Inventory left, the run lock, the key's name and age, a key rotation's record, the vault snapshots
# (vault-sync/, vault-seen/), and the temp files of a run cut short (bw-session is stage 5's).
# Kept: a Box key rotation's record (key-rotation, key-rotation-NAME) while a KEY.old or KEY.new stage 4 didn't remove
# (it couldn't vouch for it, or you said no) is in ~/.ssh: it's what says those key files are roster's (Q204 (d2), (l));
# without it a later roster won't use or clean them up.
mine=() kept_rotation=()
rotating=0
for k in ${roster_key_files[@]+"${roster_key_files[@]}"}; do
    [[ $k == *.old || $k == *.new ]] && [[ -e $k ]] && ! listed "$k" ${gone_keys[@]+"${gone_keys[@]}"} && rotating=1
done
shopt -s dotglob
for p in "$CONF_DIR"/mesh*.json* "$CONF_DIR"/mesh*.new "$CONF_DIR"/inventories.json* "$CONF_DIR"/*.removed-* \
         "$CONF_DIR"/inventory.create.lock "$CONF_DIR"/run.lock "$CONF_DIR"/run-*.lock "$CONF_DIR"/key-created \
         "$CONF_DIR"/key-name "$CONF_DIR"/key-name-* "$CONF_DIR"/key-types "$CONF_DIR"/key-types-* \
         "$CONF_DIR"/setup-left "$CONF_DIR"/setup-left-* "$CONF_DIR"/vault-sync "$CONF_DIR"/vault-seen \
         "$CONF_DIR"/.*.new "$CONF_DIR"/key-rotation "$CONF_DIR"/key-rotation-*; do
    [[ -e $p ]] || continue
    if (( rotating )) && [[ ${p##*/} == key-rotation* && ${p##*/} != *.new ]]; then kept_rotation+=("$p"); else mine+=("$p"); fi
done
shopt -u dotglob
remove "roster's state in $(home "$CONF_DIR")" ${mine[@]+"${mine[@]}"}
if (( ${#kept_rotation[@]} )); then
    info "kept the Box key rotation's record (${kept_rotation[*]/#$CONF_DIR\//}): a key ending .old or .new is still in"
    info "$(home "$HOME/.ssh"), and the record is what says roster made it (delete both by hand once no host holds that key)"
fi
yours=()
for p in "$CONF_DIR"/*; do
    [[ -e $p ]] && ! listed "$p" ${kept_rotation[@]+"${kept_rotation[@]}"} && yours+=("$p")
done
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
        for f in "$cfg_dir"/* "$cfg_dir"/.[!.]*; do
            [[ -e $f || -L $f ]] || continue
            case ${f##*/} in roster.yml|roster.yml.bak|ROSTER.md|CLAUDE.md|.claude|bin) ;; *) others+="${f##*/}"$'\n' ;; esac
        done
        others=$(head -n 3 <<<"${others%$'\n'}")
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

summary
info "Not touched: your vault, the hosts' own accounts, and this roster source folder ($(home "$here"))."
if have uv && (( PURGE )); then
    info "uv stays (other tools use it). To remove it too: uv cache clean; rm ~/.local/bin/uv ~/.local/bin/uvx"
fi
(( ${#FAILED[@]} )) && { info "Some stages failed - details in $LOG. Re-running this is safe."; exit 1; }
exit 0
