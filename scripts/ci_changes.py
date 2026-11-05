#!/usr/bin/env python3
"""CI's path filter (T232, decision Q196): which areas of ci.yml a change runs.

    ci_changes.py --event EVENT [--files FILE] [--output FILE]

FILE holds one changed path per line (a pull request's diff against its base). Off a pull request
(a push to main or dev, a tag, the schedule, a run by hand) every area runs, on every Python. On a
pull request each changed path adds the areas that test it, and Python 3.12 alone runs:

    cli       pytest on Linux
    windows   pytest on Windows: only for Windows-specific code (WINDOWS_PATHS); every push to dev runs it
    frontend  tsc, ESLint, Vitest, e2e, the bundle budget
    rust      fmt, clippy, cargo test on Linux and roster-core's tests on Windows
    release   the Windows and Linux release builds
    install   scripts/test-install.sh on Ubuntu and Fedora, in containers (#444, decision Q199)

The install test needs the network (apt, dnf, astral.sh, Bitwarden), so off a pull request it runs
only on Monday's nightly run and on a run by hand, not on every push or tag.

An unknown path, ci.yml itself or anything in scripts/ (shared by both halves) runs everything.
The halves read each other's files (tests/ checks app/src and crates/, cargo test reads docs/,
app/src/plugins and tests/vectors, the frontend bundles docs/ and the core's fixtures), so a path
adds every area that reads it, not only its own half's. Writes `area=true|false` and
`python=[...]` lines to --output (GITHUB_OUTPUT) and prints them.
"""
from __future__ import annotations

import argparse
import datetime
import fnmatch
import json
import sys

AREAS = ("cli", "windows", "frontend", "rust", "release", "install")
EVERYTHING = frozenset(AREAS)
WEEKLY = 1                      # isoweekday: the nightly run that also runs the install test (Monday, UTC)
PYTHONS_PR = ["3.12"]
PYTHONS_ALL = ["3.10", "3.12", "3.13"]

# What a Windows-only break could hide in (T237, #464): the native-Windows modules (named pipes, ConPTY, ACLs, the
# os: windows Host scripts), the modules with a Windows branch of their own (common.py's program lookup, kill_tree
# and git; askpass's pipe; changes.py's and diagnose.py's process trees; bw_login's pseudoconsole; sshops.py's
# no-ControlMaster branch; providers/__init__.py's batch-file refusal and vault filter process), the stand-in
# CLIs and their .cmd shims (tests/fakes, conftest.py), the Windows tests and shard times, and the environment.
# Modules that only call find_program/program_argv (cli.py, mesh.py, discover.py, ...) stay out: common.py is in.
WINDOWS_PATHS = (
    "src/roster/win*.py", "src/roster/conpty.py", "src/roster/askpass.py", "src/roster/common.py",
    "src/roster/changes.py", "src/roster/diagnose.py", "src/roster/sshops.py", "src/roster/providers/__init__.py",
    "src/roster/providers/bw_login.py",
    "tests/test_windows*.py", "tests/conftest.py", "tests/durations-windows.json", "tests/fakes/*",
    "pyproject.toml", "uv.lock", ".python-version", "install.ps1",   # no install.ps1 yet: when one comes
)

# First match wins.
RULES: list[tuple[tuple[str, ...], frozenset[str]]] = [
    # what test-install.sh runs (pytest's tests/test_install_scripts.py reads them too, and skips on Windows)
    (("install.sh", "update.sh", "uninstall.sh", "install-lib.sh", "scripts/test-install.sh"),
     frozenset({"cli", "install"})),
    ((".github/workflows/ci.yml", "scripts/*"), EVERYTHING),
    ((".github/workflows/release.yml",), frozenset({"release"})),
    ((".github/*",), frozenset()),                                  # the other workflows run themselves
    (("tests/vectors/*",), frozenset({"cli", "windows", "frontend", "rust"})),
    # Windows-specific code (T237, #464): the Windows shards run on a PR only for these, and on every push to dev
    (WINDOWS_PATHS, frozenset({"cli", "windows"})),
    (("src/*", "tests/*"), frozenset({"cli"})),
    (("app/src-tauri/*",), frozenset({"cli", "rust", "release"})),
    (("app/package.json", "app/package-lock.json"), frozenset({"cli", "frontend", "rust", "release"})),
    (("app/*",), frozenset({"cli", "frontend", "rust"})),
    (("crates/*", "Cargo.toml", "Cargo.lock", "rust-toolchain*"), frozenset({"cli", "frontend", "rust", "release"})),
    (("plugins/*",), frozenset({"frontend", "rust"})),
    (("examples/*", "docs/*", "*.md"), frozenset({"cli", "frontend", "rust"})),
]


def areas(event: str, files: list[str], weekday: int | None = None) -> set[str]:
    """The areas a change runs: everything off a pull request (the install test only on WEEKLY's nightly run, WEEKDAY
    being today's isoweekday, and by hand), else what its paths need."""
    if event != "pull_request":
        if event == "workflow_dispatch" or (event == "schedule" and weekday == WEEKLY):
            return set(EVERYTHING)
        return set(EVERYTHING - {"install"})
    out: set[str] = set()
    for path in (f.strip() for f in files):
        if not path:
            continue
        for patterns, needs in RULES:
            if any(fnmatch.fnmatchcase(path, p) for p in patterns):
                out |= needs
                break
        else:
            out |= EVERYTHING
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--event", required=True)
    ap.add_argument("--files")
    ap.add_argument("--output")
    args = ap.parse_args(argv)
    files: list[str] = []
    if args.files:
        with open(args.files, encoding="utf-8") as f:
            files = f.read().splitlines()
    run = areas(args.event, files, datetime.datetime.now(datetime.timezone.utc).isoweekday())
    lines = [f"{a}={'true' if a in run else 'false'}" for a in AREAS]
    lines.append("python=" + json.dumps(PYTHONS_PR if args.event == "pull_request" else PYTHONS_ALL))
    text = "\n".join(lines) + "\n"
    sys.stdout.write(text)
    if args.output:
        with open(args.output, "a", encoding="utf-8") as f:
            f.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
