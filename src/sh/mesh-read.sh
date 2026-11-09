# Run on a Host by `roster setup`, with BOX and MARK set above: report the
# Host's Mesh state and change nothing. One fact per line:
#   home DIR          the Host's HOME
#   key NAME          a Mesh private key in ~/.ssh/roster-mesh
#   pub NAME TEXT     its public half
#   include / mark    ~/.ssh/config has the Mesh's Include / roster's mark
#   claude / import   ~/.claude is there / CLAUDE.md imports @~/ROSTER.md
#   file NAME         the Mesh's config, known_hosts or ~/ROSTER.md, its
#   |LINE             lines following, each after a |
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
if [ -d .claude ]; then echo claude; fi
if grep -qxF '@~/ROSTER.md' .claude/CLAUDE.md 2>/dev/null; then echo import; fi
for f in "$P/config" "$P/known_hosts" ROSTER.md; do
	if [ -f "$f" ]; then
		echo "file ${f##*/}"
		sed 's/^/|/' "$f"
	fi
done
if [ -f .ssh/authorized_keys ]; then
	grep -E " roster-mesh:[^ @]+@$BOX\$" .ssh/authorized_keys | sed 's/^/line /'
fi
echo end
