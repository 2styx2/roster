# Run on a Host by `roster setup`, with BOX and MARK set above: report the
# Host's Mesh state and change nothing. One fact per line:
#   home DIR          the Host's HOME
#   key NAME          a Mesh private key in ~/.ssh/roster-mesh
#   pub NAME TEXT     its public half
#   include / mark    ~/.ssh/config has the Mesh's Include / roster's mark
#   claude / import   ~/.claude is (or can be) this user's / CLAUDE.md
#                     imports @~/ROSTER.md
#   sudo RHOME        not root, and sudo -n works: root's home follows
#   nosudo            not root, and sudo -n asks for a password
#   rimport / rinclude / rmark   root's CLAUDE.md imports @HOME/ROSTER.md /
#                     root's ~/.ssh/config has the Include / roster's mark
#   file NAME         the Mesh's config, known_hosts, ~/ROSTER.md,
#                     settings.json (~/.claude's), root-settings.json or
#                     root-config (root's ~/.ssh/roster-mesh.config); its
#   |LINE             lines following, each after a |
#   nonl              the file's last line had no newline
#   line TEXT         an authorized_keys line tagged roster-mesh:SRC@BOX
#   end               all of it was said
cd
P=$HOME/.ssh/roster-mesh
echo "home $HOME"
for f in "$P"/id_ed25519 "$P"/id_ed25519.pub "$P"/roster_mesh_*; do
	[ -f "$f" ] || continue
	n=${f##*/}
	case $n in
	*.pub) echo "pub ${n%.pub} $(head -n 1 "$f")" ;;
	*) echo "key $n" ;;
	esac
done
if grep -qxF "Include $P/config" .ssh/config 2>/dev/null; then echo include; fi
if grep -qxF "$MARK" .ssh/config 2>/dev/null; then echo mark; fi
# Only a ~/.claude this user can write, or can make (one owned by root,
# from `sudo claude`, is left alone).
if { [ -d .claude ] && [ -w .claude ]; } || { [ ! -e .claude ] && [ -w . ]; }; then echo claude; fi
if grep -qxF '@~/ROSTER.md' .claude/CLAUDE.md 2>/dev/null; then echo import; fi
# Root, when this login isn't root: its Claude and ssh config, through
# sudo -n (never a password prompt).
if [ "$(id -u)" != 0 ]; then
	if sudo -n -- true 2>/dev/null; then
		R=$(getent passwd root | cut -d: -f6)
		echo "sudo ${R:=/root}"
		if sudo -n -- grep -qxF "@$HOME/ROSTER.md" "$R/.claude/CLAUDE.md" 2>/dev/null; then echo rimport; fi
		if sudo -n -- grep -qxF "Include $R/.ssh/roster-mesh.config" "$R/.ssh/config" 2>/dev/null; then echo rinclude; fi
		if sudo -n -- grep -qxF "$MARK" "$R/.ssh/config" 2>/dev/null; then echo rmark; fi
		# ssh refuses a config file another user owns: root has its own copy.
		for f in .claude/settings.json:root-settings.json .ssh/roster-mesh.config:root-config; do
			if sudo -n -- test -f "$R/${f%%:*}"; then
				echo "file ${f#*:}"
				sudo -n -- sed 's/^/|/' "$R/${f%%:*}"
				if [ -n "$(sudo -n -- tail -c 1 "$R/${f%%:*}")" ]; then printf '\nnonl\n'; fi
			fi
		done
	else
		echo nosudo
	fi
fi
for f in "$P/config" "$P/known_hosts" ROSTER.md .claude/settings.json; do
	if [ -f "$f" ]; then
		echo "file ${f##*/}"
		sed 's/^/|/' "$f"
		if [ -n "$(tail -c 1 "$f")" ]; then printf '\nnonl\n'; fi
	fi
done
if [ -f .ssh/authorized_keys ]; then
	grep -E " roster-mesh:[^ @]+@$BOX\$" .ssh/authorized_keys | sed 's/^/line /'
fi
echo end
