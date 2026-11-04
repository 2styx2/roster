#!/usr/bin/env bash
# Runs one roster-core test binary many times at once, beside busy loops, to find the tests that
# fail only on a busy machine (docs/app/dev/testing.md, "Tests that pass on a busy machine too").
#
#   scripts/stress.sh [-n RUNS] [-j AT_ONCE] [-b BUSY] [-k] TEST [ARGS...]
#
#   TEST     a roster-core test target (network, config, plugin_topology, ...), built first with
#            `cargo test --no-run`, or the path to a test binary already built
#   ARGS     passed to each run: a test name to run only it, --exact, --test-threads N, ...
#   -n RUNS  how many runs in all (default 100)
#   -j N     how many run at once (default 8)
#   -b N     how many busy loops run beside them (default 8)
#   -k       keep every run's output, not only the failed ones'
#
# Runs and busy loops are all at nice 19, so the machine's other work comes first. The machine may
# be shared: raise -j and -b with care. It prints how many runs failed and the failures' most
# common lines, and leaves the failed runs' output in a temp dir it names. It exits 1 if any failed.
set -euo pipefail

runs=100 at_once=8 busy=8 keep=0
usage() { sed -n '2,/^set /p' "$0" | sed '$d; s/^# \{0,1\}//' >&2; exit 2; }
while getopts n:j:b:kh opt; do
  case $opt in
    n) runs=$OPTARG ;;
    j) at_once=$OPTARG ;;
    b) busy=$OPTARG ;;
    k) keep=1 ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ $# -ge 1 ] || usage
test=$1
shift

crate=$(cd "$(dirname "$0")/../crates/roster-core" && pwd)
if [ -x "$test" ]; then
  bin=$(realpath "$test")
else
  # The binary cargo builds for the target: the last executable it names.
  bin=$(cd "$crate" && cargo test -p roster-core --test "$test" --no-run --message-format=json 2>/dev/null |
    sed -n 's/.*"executable":"\([^"]*\)".*/\1/p' | tail -n 1)
  [ -n "$bin" ] || { echo "stress.sh: couldn't build the test target $test" >&2; exit 2; }
fi

out=$(mktemp -d "${TMPDIR:-/tmp}/roster-stress.XXXXXX")
pids=()
stop() { [ ${#pids[@]} -eq 0 ] || kill "${pids[@]}" 2>/dev/null || true; }
trap stop EXIT
for _ in $(seq "$busy"); do
  nice -n 19 sh -c 'while :; do :; done' &
  pids+=($!)
done

# Cargo runs a test binary in its package's directory; so does this.
cd "$crate"
export STRESS_BIN=$bin STRESS_OUT=$out STRESS_KEEP=$keep
# shellcheck disable=SC2016 # the inner script expands its own variables
seq "$runs" | xargs -P "$at_once" -I{} sh -c '
  run=$1
  shift
  log="$STRESS_OUT/$run.log"
  if nice -n 19 "$STRESS_BIN" "$@" >"$log" 2>&1; then
    [ "$STRESS_KEEP" = 1 ] || rm -f "$log"
  else
    echo "$run" >>"$STRESS_OUT/failed"
  fi
' sh {} "$@"

failed=0
[ ! -f "$out/failed" ] || failed=$(wc -l <"$out/failed")
echo "failed: $failed/$runs ($at_once at once, beside $busy busy loops): $(basename "$bin") $*"
if [ "$failed" -gt 0 ]; then
  echo "output of the failed runs: $out"
  # Each failed test's name, where it panicked and the line after (its message), and the two
  # sides of a failed assert_eq, most common first.
  grep -h -A1 "panicked at" "$out"/*.log | grep -v "^--$" | sed "s/' ([0-9]*) panicked/' panicked/" |
    cat - <(grep -h "^test .* FAILED$\|^  left:\|^ right:" "$out"/*.log) |
    cut -c1-300 | sort | uniq -c | sort -rn | head -20
  exit 1
fi
if [ "$keep" = 1 ]; then echo "output: $out"; else rmdir "$out"; fi
