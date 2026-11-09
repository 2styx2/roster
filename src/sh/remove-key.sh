# Run on a Host by `roster setup --undo`, with BOX and DRY set above: remove
# this Box's key lines from ~/.ssh/authorized_keys, the lines whose last
# field is exactly roster-managed:BOX or v0.7.0's fleet-managed:BOX. No
# other line changes. The file is rewritten as a copy next to it, then moved
# into place; the copy keeps the file's mode. Prints `removed`, or `absent`
# when there's none; with DRY set, `present` or `absent`, changing nothing.
set -eu
umask 077
cd
# SELinux: a file moved into place keeps the label of where it was made.
relabel() { if command -v restorecon >/dev/null 2>&1; then restorecon -F "$1" 2>/dev/null || true; fi; }
f=.ssh/authorized_keys
if [ -L "$f" ]; then f=$(readlink -f "$f"); fi # a symlink stays one
# BOX is letters, digits, _ and -: nothing awk -v would unescape.
pick() { awk -v a="roster-managed:$BOX" -v b="fleet-managed:$BOX" "$1" "$f"; }
if [ ! -f "$f" ] || [ -z "$(pick '$NF == a || $NF == b')" ]; then
	echo absent
	exit 0
fi
if [ -n "$DRY" ]; then
	echo present
	exit 0
fi
t=$f.roster-$$
trap 'rm -f "$t"' EXIT
cp -p "$f" "$t"
pick '$NF != a && $NF != b' >"$t"
mv -f "$t" "$f"
relabel "$f"
trap - EXIT
echo removed
