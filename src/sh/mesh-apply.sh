# Run on a Host by `roster setup`, with the plan set above (BOX, NAME, MARK,
# MAKE, KEYGEN, DROPKEYS, PUT, C_config, C_known_hosts, C_md, DROP, INCLUDE,
# IMPORT, ADD, DEL, SETTINGS, C_settings, RIMPORT, RINCLUDE, RSETTINGS,
# C_rsettings, RCONFIG, C_rconfig): make this Host's part of the Mesh so. Root's files (the R*
# steps) are written through sudo -n. Every file is
# written as a copy beside it, then moved into place, so a cut run leaves
# the old file whole. Removals go first, and a file that shows a thing is
# this Box's goes last. Only keys whose .pub carries roster-mesh:*@BOX, and
# only exactly the authorized_keys lines in DEL, are ever deleted.
set -eu
umask 077
cd
# SELinux: a file moved into place keeps the label of where it was made.
relabel() { if command -v restorecon >/dev/null 2>&1; then restorecon -F "$1" 2>/dev/null || true; fi; }
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
	relabel "$f"
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
config_without() { config_strip "$INC" <.ssh/config; }
# config_strip LINE [LINE2]: stdin without roster's mark and these Includes.
config_strip() {
	awk -v m="$MARK" -v i="$1" -v j="${2:-$1}" 'd { d = 0; if (/^Include /) next } $0 == m { d = 1; next } $0 == i || $0 == j { next } { print }'
}
# Root's side. R is root's home, RIMP the import of this user's ROSTER.md.
R=$(getent passwd root | cut -d: -f6)
R=${R:-/root}
RIMP="@$HOME/ROSTER.md"
# ssh refuses a config file another user owns: root includes its own copy
# of the Mesh config (which names this user's key and known_hosts).
RINC="Include $R/.ssh/roster-mesh.config"
rcat() { sudo -n -- cat "$1" 2>/dev/null || true; }
# rput FILE MODE CMD...: as put, for a file of root's.
rput() {
	f=$1 m=$2
	shift 2
	t=$(mktemp)
	"$@" >"$t"
	sudo -n -- sh -c 'set -e; umask 077; f=$1; mkdir -p "${f%/*}"
		if [ -L "$f" ]; then f=$(readlink -f "$f"); fi
		n=$f.roster-$$
		if [ -f "$f" ]; then cp -p "$f" "$n"; else : >"$n" && chmod "$2" "$n"; fi
		cat "$3" >"$n"; mv -f "$n" "$f"
		if command -v restorecon >/dev/null 2>&1; then restorecon -F "$f" 2>/dev/null || true; fi' rput "$f" "$m" "$t"
	rm -f "$t"
	t=
}
rclaude_with() {
	c=$(rcat "$R/.claude/CLAUDE.md")
	if [ -n "$c" ]; then printf '%s\n\n' "$c"; fi
	echo "$RIMP"
}
rclaude_without() { rcat "$R/.claude/CLAUDE.md" | grep -vxF "$RIMP" || [ $? -eq 1 ]; }
rconfig_with() {
	echo "$MARK"
	echo "$RINC"
	rcat "$R/.ssh/config" | config_strip "$RINC" "$INC"
}
rconfig_without() { rcat "$R/.ssh/config" | config_strip "$RINC" "$INC"; }
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
# Claude's settings first, root's removals next: evidence (~/ROSTER.md) last.
case $SETTINGS in
put) mkdir -p .claude && put .claude/settings.json 600 show "$C_settings" ;;
drop) rm -f .claude/settings.json ;;
esac
case $RSETTINGS in
put) rput "$R/.claude/settings.json" 600 show "$C_rsettings" ;;
drop) sudo -n -- rm -f "$R/.claude/settings.json" ;;
esac
if [ "$RIMPORT" = remove ]; then rput "$R/.claude/CLAUDE.md" 644 rclaude_without; fi
if [ "$RINCLUDE" = remove ]; then
	rput "$R/.ssh/config" 600 rconfig_without
	if [ -z "$(rcat "$R/.ssh/config")" ]; then sudo -n -- rm -f "$R/.ssh/config"; fi
fi
if [ "$RCONFIG" = drop ]; then sudo -n -- rm -f "$R/.ssh/roster-mesh.config"; fi
if [ "$IMPORT" = remove ] && [ -f .claude/CLAUDE.md ] && [ -w .claude ]; then
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
	relabel "$P/$MAKE"
	relabel "$P/$MAKE.pub"
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
if [ "$IMPORT" = add ]; then
	mkdir -p .claude
	if [ -w .claude ]; then put .claude/CLAUDE.md 644 claude_with; fi
fi
if [ "$RCONFIG" = put ]; then rput "$R/.ssh/roster-mesh.config" 600 show "$C_rconfig"; fi
if [ "$RINCLUDE" = add ]; then rput "$R/.ssh/config" 600 rconfig_with; fi
if [ "$RIMPORT" = add ]; then rput "$R/.claude/CLAUDE.md" 644 rclaude_with; fi
if [ -n "$ADD$DEL" ]; then
	d=.ssh/authorized_keys.roster-del-$$
	printf '%s\n' "$DEL" >"$d"
	put .ssh/authorized_keys 600 keys
	rm -f "$d"
fi
