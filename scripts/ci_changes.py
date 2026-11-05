#!/usr/bin/env python3
"""CI's path filter (T232, decision Q196): which areas of ci.yml a change runs.

    ci_changes.py --event EVENT [--files FILE] [--output FILE]

FILE holds one changed path per line (a pull request's diff against its base). Off a pull request
(a push to main or dev, a tag, the schedule, a run by hand) every area runs, on every Python. On a
pull request each changed path adds the areas that test it, and Python 3.12 alone runs:

    cli       pytest on Linux
    windows   pytest on Windows
    frontend  tsc, ESLint, Vitest, e2e, the bundle budget
    rust      fmt, clippy, cargo test on Linux and roster-core's tests on Windows
    release   the Windows and Linux release builds

An unknown path, ci.yml itself or anything in scripts/ (shared by both halves) runs everything.
The halves read each other's files (tests/ checks app/src and crates/, cargo test reads docs/,
app/src/plugins and tests/vectors, the frontend bundles docs/ and the core's fixtures), so a path
adds every area that reads it, not only its own half's. Writes `area=true|false` and
`python=[...]` lines to --output (GITHUB_OUTPUT) and prints them.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import sys

AREAS = ("cli", "windows", "frontend", "rust", "release")
EVERYTHING = frozenset(AREAS)
PYTHONS_PR = ["3.12"]
PYTHONS_ALL = ["3.10", "3.12", "3.13"]

# First match wins.
RULES: list[tuple[tuple[str, ...], frozenset[str]]] = [
    ((".github/workflows/ci.yml", "scripts/*"), EVERYTHING),
    ((".github/workflows/release.yml",), frozenset({"release"})),
    ((".github/*",), frozenset()),                                  # the other workflows run themselves
    (("tests/vectors/*",), frozenset({"cli", "windows", "frontend", "rust"})),
    (("src/*", "tests/*", "pyproject.toml", "uv.lock", ".python-version"), frozenset({"cli", "windows"})),
    (("app/src-tauri/*",), frozenset({"cli", "rust", "release"})),
    (("app/package.json", "app/package-lock.json"), frozenset({"cli", "frontend", "rust", "release"})),
    (("app/*",), frozenset({"cli", "frontend", "rust"})),
    (("crates/*", "Cargo.toml", "Cargo.lock", "rust-toolchain*"), frozenset({"cli", "frontend", "rust", "release"})),
    (("plugins/*",), frozenset({"frontend", "rust"})),
    (("examples/*", "docs/*", "*.md"), frozenset({"cli", "frontend", "rust"})),
]


def areas(event: str, files: list[str]) -> set[str]:
    """The areas a change runs: everything off a pull request, else what its paths need."""
    if event != "pull_request":
        return set(EVERYTHING)
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
    run = areas(args.event, files)
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
