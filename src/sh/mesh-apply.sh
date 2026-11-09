# Run on a Host by `roster setup`, with the plan set above (BOX, NAME, MARK,
# MAKE, KEYGEN, DROPKEYS, PUT, C_config, C_known_hosts, C_md, DROP, INCLUDE,
# IMPORT, ADD, DEL): make this Host's part of the Mesh so. Every file is
# written as a copy beside it, then moved into place, so a cut run leaves
# the old file whole. Removals go first, and a file that shows a thing is
# this Box's goes last. Only keys whose .pub carries roster-mesh:*@BOX, and
# only exactly the authorized_keys lines in DEL, are ever deleted.
set -eu
umask 077
cd
P=$HOME/.ssh/roster-mesh
INC="Include $P/config"
IMP='@~/ROSTER.md'
t= d=
trap 'rm -rf "$t" "$d"' EXIT

# put FILE MODE CMD...: CMD's output becomes FILE; an existing FILE keeps
# its mode, a new one gets MODE. Nothing moves unless CMD succeeded. A
# symlink stays one: its target is written.
put() {
	f=$1 m=$2
	shift 2
	if [ -L "$f" ]; then f=$(readlink -f "$f"); fi
	t=$f.roster-$$
	if [ -f "$f" ]; then cp -p "$f" "$t"; else : >"$t" && chmod "$m" "$t"; fi
	"$@" >"$t"
	mv -f "$t" "$f"
	t=
}
ours() {
	[ -f "$P/$1.pub" ] && case $(cat "$P/$1.pub") in *" roster-mesh:"*"@$BOX") true ;; *) false ;; esac
}
# BOX is letters, digits, _ and -: nothing special in a regular expression.
ours_config() { head -n 1 "$P/config" 2>/dev/null | grep -q "^# Written by roster mesh for [^ ]* (owner $BOX) "; }
ours_md() { head -n 1 ROSTER.md 2>/dev/null | grep -q "^<!-- roster-mesh: written by roster for [^ ]* (owner $BOX);"; }
show() { printf '%s' "$1"; }
config_with() {
	echo "$MARK"
	echo "$INC"
	if [ -f .ssh/config ]; then config_without; fi
}
config_without() {
	awk -v m="$MARK" -v i="$INC" 'd { d = 0; if (/^Include /) next } $0 == m { d = 1; next } $0 == i { next } { print }' .ssh/config
}
claude_with() {
	if [ -s .claude/CLAUDE.md ]; then
		cat .claude/CLAUDE.md
		if [ -n "$(tail -c 1 .claude/CLAUDE.md)" ]; then echo; fi
	fi
	echo "$IMP"
}
claude_without() { grep -vxF "$IMP" .claude/CLAUDE.md || [ $? -eq 1 ]; }
keys() {
	if [ -f .ssh/authorized_keys ]; then
		if [ -n "$DEL" ]; then
			grep -vxF -f "$d" .ssh/authorized_keys || [ $? -eq 1 ]
		else
			awk 1 .ssh/authorized_keys
		fi
	fi
	if [ -n "$ADD" ]; then printf '%s\n' "$ADD"; fi
}

[ -d .ssh ] || mkdir -m 700 .ssh
if [ "$IMPORT" = remove ] && [ -f .claude/CLAUDE.md ]; then
	put .claude/CLAUDE.md 644 claude_without
fi
if [ "$INCLUDE" = remove ] && [ -f .ssh/config ]; then
	put .ssh/config 600 config_without
	[ -s .ssh/config ] || rm -f .ssh/config
fi
for f in $DROP; do
	case $f in
	ROSTER.md) if ours_md; then rm -f ROSTER.md; fi ;;
	known_hosts) rm -f "$P/known_hosts" ;;
	config) if ours_config; then rm -f "$P/config"; fi ;;
	esac
done
for k in $DROPKEYS; do
	if ours "$k"; then rm -f "$P/$k" "$P/$k.pub"; fi
done
if [ -d "$P" ] && [ -z "$MAKE$PUT" ]; then rmdir "$P" 2>/dev/null || true; fi
if [ -n "$MAKE$PUT" ]; then
	mkdir -p "$P"
	chmod 700 "$P"
fi
if [ -n "$MAKE" ]; then
	if [ -e "$P/$MAKE" ] || [ -e "$P/$MAKE.pub" ]; then
		echo "$P/$MAKE is there already; left alone" >&2
		exit 3
	fi
	t=$(mktemp -d "$P/.roster-XXXXXX")
	# shellcheck disable=SC2086 # KEYGEN is words: -t TYPE [-b BITS]
	ssh-keygen -q $KEYGEN -N '' -C "roster-mesh:$NAME@$BOX" -f "$t/k" </dev/null >/dev/null
	mv -f "$t/k" "$P/$MAKE"
	mv -f "$t/k.pub" "$P/$MAKE.pub"
	rmdir "$t"
	t=
fi
for f in $PUT; do
	case $f in
	config) put "$P/config" 600 show "$C_config" ;;
	known_hosts) put "$P/known_hosts" 600 show "$C_known_hosts" ;;
	ROSTER.md) put ROSTER.md 644 show "$C_md" ;;
	esac
done
if [ "$INCLUDE" = add ]; then put .ssh/config 600 config_with; fi
if [ "$IMPORT" = add ]; then put .claude/CLAUDE.md 644 claude_with; fi
if [ -n "$ADD$DEL" ]; then
	d=.ssh/authorized_keys.roster-del-$$
	printf '%s\n' "$DEL" >"$d"
	put .ssh/authorized_keys 600 keys
	rm -f "$d"
fi
