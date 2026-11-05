#!/usr/bin/env python3
"""The Windows pytest shards' timing file (T233, decision Q196): one file from the shards' own.

    shard_durations.py OUT SHARD.json... [--summary FILE]

Each SHARD.json is what one shard's `pytest --store-durations` wrote (test id -> seconds). OUT gets
them all in one file, sorted, to a tenth of a second: tests/durations-windows.json, which
conftest.py's --shard balances the shards by. Only the shards' tests go in, so a removed test drops
out. --summary appends a table of each shard's tests and test time (GITHUB_STEP_SUMMARY), so the
nightly run shows how even the shards ran.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out")
    ap.add_argument("shards", nargs="+")
    ap.add_argument("--summary")
    args = ap.parse_args(argv)
    merged: dict[str, float] = {}
    rows = ["| Shard | Tests | Test time |", "|---|---|---|"]
    for k, path in enumerate(args.shards, 1):
        times: dict[str, float] = json.loads(Path(path).read_text(encoding="utf-8"))
        merged.update(times)
        rows.append(f"| {k} | {len(times)} | {round(sum(times.values()))} s |")
    out = {test: round(t, 1) for test, t in sorted(merged.items())}
    Path(args.out).write_text(json.dumps(out, indent=0) + "\n", encoding="utf-8")
    text = "\n".join(rows) + f"\n\n{len(out)} tests, {round(sum(merged.values()))} s of test time in all.\n"
    sys.stdout.write(text)
    if args.summary:
        with open(args.summary, "a", encoding="utf-8") as f:
            f.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
