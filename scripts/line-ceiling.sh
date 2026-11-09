#!/bin/sh
# Fail when the source passes the line ceiling: non-blank, non-comment lines
# of Rust (*.rs) and embedded shell scripts (*.sh) under DIR (default: src).
# Tests live outside src and don't count. Only the owner raises the ceiling.
set -eu
dir=${1:-src}
ceiling=${LINE_CEILING:-10000}

rs=$(find "$dir" -type f -name '*.rs' -exec cat {} + | grep -cvE '^[[:space:]]*(//|$)' || true)
sh=$(find "$dir" -type f -name '*.sh' -exec cat {} + | grep -cvE '^[[:space:]]*(#|$)' || true)
total=$((${rs:-0} + ${sh:-0}))

echo "line ceiling: $total of $ceiling lines ($rs Rust, $sh shell)"
[ "$total" -le "$ceiling" ]
