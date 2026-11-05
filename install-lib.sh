# What install.sh and update.sh share: sourced by them from beside them (or from the roster checkout install.sh
# cloned), never run on its own. It ships with them in the Release's roster-cli tarball.
# shellcheck shell=bash

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
