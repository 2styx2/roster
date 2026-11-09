# bash completion for roster(1). Install: source it from ~/.bashrc, or copy
# it to ~/.local/share/bash-completion/completions/roster.
# Host and group names come from `roster ls` at each Tab, so a Host added to
# roster.yml completes at once; when roster.yml won't load, no names complete.
_roster() {
	local cur=${COMP_WORDS[COMP_CWORD]} cmd='' cfg=() i words
	for ((i = 1; i < COMP_CWORD; i++)); do
		case ${COMP_WORDS[i]} in
		-c) cfg=(-c "${COMP_WORDS[++i]}") ;;
		--) [[ $cmd == run ]] && return ;;
		-*) ;;
		*) [[ -z $cmd ]] && cmd=${COMP_WORDS[i]} ;;
		esac
	done
	[[ ${COMP_WORDS[COMP_CWORD - 1]} == -c ]] && { mapfile -t COMPREPLY < <(compgen -f -- "$cur"); return; }
	case $cmd in
	'') words='-c -h ls setup sync add ssh run check web vault help' ;;
	add) words='--ip --group --user --port --auth --enroll=false --from-vault --name' ;;
	ls) words='--json --long' ;;
	setup) words='--dry-run --undo' ;;
	run | check) words=--json ;;
	web) words='-k -d -H' ;;
	vault) words='unlock lock' ;;
	help) words=plugins ;;
	esac
	case $cmd in '' | ls | ssh | run | check | web)
		[[ $cur == -* ]] || words+=" $(roster "${cfg[@]}" ls 2>/dev/null | awk '{print $1; print $2}' | sort -u)" ;;
	esac
	mapfile -t COMPREPLY < <(compgen -W "$words" -- "$cur")
}
complete -F _roster roster
