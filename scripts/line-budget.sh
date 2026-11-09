#!/bin/sh
# Report the source size against the line budget: non-blank, non-comment
# lines of Rust (*.rs) and embedded shell scripts (*.sh) under DIR (default:
# src). Tests live outside src and don't count. The budget is a guide to how
# small roster stays, not a wall: over it, this warns and still exits 0.
set -eu
dir=${1:-src}
budget=${LINE_BUDGET:-10000}

rs=$(find "$dir" -type f -name '*.rs' -exec cat {} + | grep -cvE '^[[:space:]]*(//|$)' || true)
sh=$(find "$dir" -type f -name '*.sh' -exec cat {} + | grep -cvE '^[[:space:]]*(#|$)' || true)
total=$((${rs:-0} + ${sh:-0}))

echo "line budget: $total of $budget lines ($rs Rust, $sh shell)"
if [ "$total" -gt "$budget" ]; then
	echo "over the line budget by $((total - budget)): look for what can go"
	# An annotation on the run, when it's GitHub Actions.
	[ -z "${GITHUB_ACTIONS:-}" ] || echo "::warning::over the line budget: $total of $budget lines"
fi
