#!/usr/bin/env bash
# The checks CI's pull request jobs run, here, for what your branch changes (T237, decision Q196).
#
#   scripts/check-local.sh            what CI runs for the changed areas: ruff and pyright, pytest -n auto
#                                     when the CLI's area changed, npm run check (app/) when the frontend's
#                                     did, cargo fmt, clippy and test when the Rust's did
#   scripts/check-local.sh --quick    ruff, pyright and pytest on the changed areas: for a pre-push hook
#   scripts/check-local.sh --full     every check, whatever changed
#   ... --base REF                    compare with REF (default: origin/dev, else origin/main)
#
# The changed files are your commits since REF plus what isn't committed yet; scripts/ci_changes.py (the
# file CI's `Changes` job runs) turns them into areas. The Windows shards, the install test and the release
# builds can't run here: it says when CI will run them. Exits non-zero when a check fails, after a
# one-line summary. The pre-push hook line is in docs/development.md ("Checking before you push").
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

mode=changed base=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) mode=quick ;;
    --full) mode=full ;;
    --base) [ $# -ge 2 ] || { echo "check-local: --base needs a ref" >&2; exit 2; }; base="$2"; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "check-local: unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
start=$SECONDS passed="" failed="" notes=""
step() {                                    # step NAME [DIR] -- COMMAND...: run it, note how it went
  local name="$1" dir="." ; shift
  if [ "$1" != "--" ]; then dir="$1"; shift; fi
  shift
  say ""; say "==> $name"
  if (cd "$dir" && "$@"); then passed="$passed${passed:+, }$name"; else failed="$failed${failed:+, }$name"; fi
}
note() { notes="$notes$*"$'\n'; }

command -v uv >/dev/null 2>&1 || { echo "check-local: needs uv (https://docs.astral.sh/uv/)" >&2; exit 2; }

# Which areas: everything for --full, else what ci_changes.py says the changed files need.
cli=false windows=false frontend=false rust=false release=false install=false
if [ "$mode" = full ]; then
  cli=true windows=true frontend=true rust=true release=true install=true
  say "check-local: every check (--full)"
else
  if [ -z "$base" ]; then
    for ref in origin/dev origin/main; do
      if git rev-parse --verify -q "$ref" >/dev/null; then base=$ref; break; fi
    done
  fi
  if [ -z "$base" ] || ! git rev-parse --verify -q "$base" >/dev/null; then
    echo "check-local: no ${base:-origin/dev or origin/main} to compare with: git fetch, pass --base REF, or use --full" >&2
    exit 2
  fi
  files=$(mktemp "${TMPDIR:-/tmp}/check-local.XXXXXX") || exit 2
  trap 'rm -f "$files"' EXIT
  { git diff --name-only "$base"...HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } \
    | sort -u > "$files"
  say "check-local: $(wc -l < "$files" | tr -d ' ') changed file(s) against $base"
  areas=$(python3 -I scripts/ci_changes.py --event pull_request --files "$files") || exit 2
  # cli=true / windows=false / ... / python=[...]: set the ones that are true
  for a in $(printf '%s\n' "$areas" | sed -n 's/^\([a-z]*\)=true$/\1/p'); do
    case "$a" in
      cli) cli=true ;; windows) windows=true ;; frontend) frontend=true ;; rust) rust=true ;;
      release) release=true ;; install) install=true ;;
    esac
  done
fi

# CI's Checks job: always.
step ruff -- uv run ruff check src tests scripts app/scripts
step pyright -- uv run pyright

if [ "$cli" = true ]; then
  if ! command -v pwsh >/dev/null 2>&1; then
    note "pwsh isn't on PATH, so pytest skipped the PowerShell-script tests (tests/test_windows_hosts.py, pwsh completion)."
    note "  Install PowerShell to run them: https://learn.microsoft.com/powershell/scripting/install/installing-powershell"
    note "  (macOS: brew install powershell/tap/powershell; Fedora, Ubuntu: Microsoft's package repository, or the snap)."
  fi
  step pytest -- uv run pytest -n auto
fi

if [ "$mode" != quick ]; then
  if [ "$frontend" = true ]; then
    if [ -d app/node_modules ]; then
      step "npm run check" app -- npm run check
    else
      failed="$failed${failed:+, }npm run check"
      note "app/node_modules is missing: run \`npm ci\` in app/ once, then check again."
    fi
  fi
  if [ "$rust" = true ]; then
    step "cargo fmt" -- cargo fmt --all --check
    step "cargo clippy" -- cargo clippy -p roster-core --all-targets -- -D warnings
    step "cargo test" -- cargo test
  fi
else
  if [ "$frontend" = true ] || [ "$rust" = true ]; then
    note "--quick left out the app's checks this change needs (npm run check, cargo): run scripts/check-local.sh for them."
  fi
fi

[ "$windows" = true ] && note "CI runs the Windows pytest shards for this change (Windows-specific code: scripts/ci_changes.py WINDOWS_PATHS)."
[ "$install" = true ] && note "CI runs the install test (scripts/test-install.sh, in containers) for this change."
[ "$release" = true ] && note "CI runs the Windows and Linux release builds for this change."

took=$((SECONDS - start))
say ""
[ -n "$notes" ] && printf '%s' "$notes"
if [ -n "$failed" ]; then
  say "check-local: FAILED: $failed${passed:+ (passed: $passed)} in $((took / 60))m$((took % 60))s"
  exit 1
fi
say "check-local: ok: ${passed:-nothing to check} in $((took / 60))m$((took % 60))s"
