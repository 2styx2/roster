# Run on a Host by `roster setup`, with LINE set above: append LINE
# (TYPE KEY TAG) to ~/.ssh/authorized_keys unless its KEY is there already.
# The file is rewritten as a copy next to it, then moved into place, so a cut
# run leaves the old file whole; the copy keeps the file's mode. Prints
# `added` or `present`.
set -eu
umask 077
cd
[ -d .ssh ] || mkdir -m 700 .ssh
f=.ssh/authorized_keys
if [ -L "$f" ]; then f=$(readlink -f "$f"); fi # a symlink stays one
key=${LINE#* }
key=${key%% *}
# Present: KEY is a field of a line that isn't a comment.
has() { awk -v k="$key" '!/^[[:space:]]*#/ { for (i = 1; i <= NF; i++) if ($i == k) f = 1 } END { exit !f }' "$f"; }
if [ -f "$f" ] && has; then
	echo present
	exit 0
fi
t=$f.roster-$$
trap 'rm -f "$t"' EXIT
if [ -f "$f" ]; then
	cp -p "$f" "$t"
	# A last line without its newline would run into ours.
	if [ -s "$t" ] && [ -n "$(tail -c 1 "$t")" ]; then echo >>"$t"; fi
else
	: >"$t"
	chmod 600 "$t"
fi
printf '%s\n' "$LINE" >>"$t"
mv -f "$t" "$f"
trap - EXIT
echo added
