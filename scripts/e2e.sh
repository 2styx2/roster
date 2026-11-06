#!/usr/bin/env bash
# The end-to-end suite (tests/e2e, docs/development.md, "End-to-end suite"): the real roster CLI and `roster serve`
# against stand-in Hosts that are real sshd in containers (podman or docker), on a sandbox Box with the stand-in vault
# CLIs.
#
#   scripts/e2e.sh                       run the suite against this checkout
#   scripts/e2e.sh -k mesh               pytest's own options go through
#   scripts/e2e.sh --compare REF         run it twice, with REF's roster (git archive REF) and this checkout's, each
#                                        in fresh sandboxes against fresh Hosts, and diff what each did
#                                        (tests/e2e/compare.py); exit 1 when they differ
#
# Linux only (the containers share the host's network: each Host is its own 127.0.0.x). The first run builds the
# image (alpine + openssh, tests/e2e/Containerfile) and needs the network for that.
# ROSTER_E2E_TMP: where the sandboxes go (default /tmp; keep it short: serve's askpass socket lives there).
# ROSTER_E2E_KEEP=1: keep the sandboxes afterwards. ROSTER_E2E_OUT: where --compare writes (default a temp folder).
set -euo pipefail
cd "$(dirname "$0")/.."

compare=""
if [[ ${1:-} == --compare ]]; then
    compare=${2:?--compare needs a git ref}
    shift 2
fi

export ROSTER_E2E=1
run_suite() {     # run_suite RECORD [ROSTER_PROJECT] -- pytest args
    local record=$1 project=$2
    shift 2
    ROSTER_E2E_RECORD=$record ROSTER_E2E_ROSTER=$project \
        uv run --frozen pytest tests/e2e -p no:xdist -p no:cacheprovider -o addopts="" -q -rs "$@"
}

if [[ -z $compare ]]; then
    exec uv run --frozen pytest tests/e2e -p no:xdist -o addopts="" -q -rs "$@"
fi

out=${ROSTER_E2E_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/roster-e2e-compare-XXXXXX")}
mkdir -p "$out"
base="$out/base"
rm -rf "$base" && mkdir -p "$base"
git archive "$compare" | tar -x -C "$base"
(cd "$base" && uv sync -q --frozen)
rm -f "$out/base.jsonl" "$out/head.jsonl"

echo "== $compare's roster ($base)"
run_suite "$out/base.jsonl" "$base" "$@" | tee "$out/base.txt" || true
echo "== this checkout's roster"
run_suite "$out/head.jsonl" "" "$@" | tee "$out/head.txt" || true
echo "== the differences ($out/diff.txt)"
uv run --frozen python tests/e2e/compare.py "$out/base.jsonl" "$out/head.jsonl" --out "$out/diff.txt"
