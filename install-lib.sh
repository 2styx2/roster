# What install.sh and update.sh share: sourced by them from beside them (or from the roster checkout install.sh
# cloned), never run on its own. It ships with them in the Release's roster-cli tarball.
# shellcheck shell=bash

# turn_on_completion: Tab completion for roster (`roster ho<Tab>`, `roster run <Tab>` for Host names) in each shell
# this box uses, no question (decision Q183). bash and zsh get a marked line that asks roster for its script when the
# shell starts (so a newer roster's commands complete too), fish a file it loads on the first Tab. Nothing is added
# twice, and a fish file that isn't roster's is kept. A marked line (or roster's fish file) from before T222 that runs
# `roster completion SHELL` is rewritten to `roster help --completion SHELL` (new_completion_form); a line of your own is
# left alone. Uses the caller's COMP_MARK, DRY, ok, info and warn.
new_completion_form() {         # FILE [ALL]: rewrite roster's marked lines in FILE (every line with ALL: fish's file)
    local f=$1 all=${2:-} tmp
    awk -v m="$COMP_MARK" -v all="$all" 'BEGIN { n = 0 } (all != "" || index($0, m)) && /roster completion / { n++ } END { exit n == 0 }' "$f" || return 1
    (( DRY )) && { info "would rewrite roster's Tab completion line in ${f/#$HOME/\~} to the new form (roster help --completion)"; return 0; }
    tmp=$(mktemp "$f.XXXXXX") || return 1
    awk -v m="$COMP_MARK" -v all="$all" '(all != "" || index($0, m)) { gsub(/roster completion /, "roster help --completion ") } { print }' "$f" > "$tmp" \
        && cat "$tmp" > "$f"
    rm -f "$tmp"
    ok "Tab completion line in ${f/#$HOME/\~} rewritten to the new form (roster help --completion)"
}

turn_on_completion() {
    local comp_shell=${SHELL##*/} comp_added=0 sh f fish_file
    for sh in bash zsh; do
        f="$HOME/.${sh}rc"
        [[ -f $f || $comp_shell == "$sh" ]] || continue
        comp_added=1
        if grep -qF "$COMP_MARK" "$f" 2>/dev/null; then
            new_completion_form "$f" || ok "Tab completion already on in ${f/#$HOME/\~}"
        elif (( DRY )); then info "would turn on Tab completion in ${f/#$HOME/\~}"
        else
            printf '\n%s\n' "command -v roster >/dev/null 2>&1 && eval \"\$(roster help --completion $sh)\"   $COMP_MARK" >> "$f"
            ok "Tab completion for roster in ${f/#$HOME/\~}"
        fi
    done
    fish_file="${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/roster.fish"
    if [[ -d ${XDG_CONFIG_HOME:-$HOME/.config}/fish || $comp_shell == fish ]]; then
        comp_added=1
        if [[ -f $fish_file ]] && head -n 1 "$fish_file" | grep -qF "$COMP_MARK"; then
            new_completion_form "$fish_file" all || ok "Tab completion already on for fish"
        elif [[ -e $fish_file ]]; then warn "${fish_file/#$HOME/\~} isn't roster's: kept it (roster help --completion fish prints roster's)"
        elif (( DRY )); then info "would turn on Tab completion in ${fish_file/#$HOME/\~}"
        elif mkdir -p "$(dirname "$fish_file")" && printf '%s\n' \
                "$COMP_MARK (install.sh wrote this file; uninstall.sh removes it)" 'roster help --completion fish | source' \
                > "$fish_file"; then
            ok "Tab completion for roster in ${fish_file/#$HOME/\~}"
        else warn "couldn't write ${fish_file/#$HOME/\~}"; fi
    fi
    (( comp_added )) || info "no bash, zsh or fish here: roster help --completion SHELL prints Tab completion for yours"
    return 0
}
