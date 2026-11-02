"""Check the app's JS and CSS against their size budget (ticket 75, docs/app/performance.md "Bundle size").

CI builds the frontend (`vite build` in app/) and runs this on every pull request. From a clone:

    cd app && npx vite build && cd .. && python3 scripts/check-bundle-size.py      # or give the dist folder

It adds up every .js and every .css file the build wrote under dist/assets, minified as shipped and gzipped
(level 9, as a size anyone can reproduce; the app reads them from disk, so raw is what it parses), and fails
when either total is over its budget. Fonts, icons and other assets aren't counted: they change only when a
font does. A KB here is 1,000 bytes, as Vite prints them. A change that goes over raises the budget below and
in performance.md's table, with the reason in its pull request. Standard library only.
"""

import gzip
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KB = 1000

# KB, minified. Measured 2026-10-31: JS 1,972 raw / 591 gzipped, CSS 75 / 14; about 10 % above that.
# JS measured again 2026-11-01 (ticket 100): 2,195 raw / 654 gzipped, the Plugin API reference and
# its types (both bundled for :help) having grown by the typed serve results; about 10 % above that.
# JS raw 2,410 -> 2,450 on 2026-11-02: the Plugin API's get/has/list (ticket 145) took the bundled
# reference and its types to 2,427.
# JS 2,450 -> 2,500 raw, 720 -> 730 gzipped on 2026-11-02: roster.badges' get/has/list/remove, init.lua's
# keymap/themes has (ticket 149, #262; their reference entries and types are bundled for :help) and the
# fake Backend's Plugin runtime mirroring api 5 took it to 2,456.6 raw / 718.9 gzipped. Text :help
# reads and test scaffolding, not a dependency, so the budgets follow it, as for ticket 145.
# CSS raw 83 -> 85 on 2026-11-02: a nested ssh's breadcrumb (ticket 120) took it to 83.3 when dev's own
# build was already a few hundred bytes under 83 (#232, #243). It's the app's own stylesheets, grown a
# rule at a time with features, not a dependency, so 2 KB of room lets the next small feature through
# while a stylesheet library (tens of KB) still fails. Measured 83.3 raw / 15.2 gzipped on 2026-11-02.
# docs/app/performance.md "Bundle size" keeps the same history; change both together.
BUDGETS = {
    "js": {"raw": 2500, "gzip": 730},
    "css": {"raw": 85, "gzip": 15.5},
}


def measure(dist):
    """{"js": {"raw": bytes, "gzip": bytes}, "css": {...}}: the totals of the build in DIST (its assets folder)."""
    out = {kind: {"raw": 0, "gzip": 0} for kind in BUDGETS}
    for f in sorted((Path(dist) / "assets").rglob("*")):
        kind = f.suffix.lstrip(".")
        if kind in out and f.is_file():
            data = f.read_bytes()
            out[kind]["raw"] += len(data)
            out[kind]["gzip"] += len(gzip.compress(data, 9, mtime=0))
    return out


def main(argv=None, budgets=None):
    argv = sys.argv[1:] if argv is None else argv
    budgets = budgets or BUDGETS
    dist = Path(argv[0]) if argv else ROOT / "app" / "dist"
    if not (dist / "assets").is_dir():
        print(f"no build in {dist}: run `npx vite build` in app/ first", file=sys.stderr)
        return 2
    sizes, over = measure(dist), []
    for kind, budget in budgets.items():
        for how in ("raw", "gzip"):
            got, most = sizes[kind][how] / KB, budget[how]
            line = f"{kind.upper()} {how} {got:,.1f} KB"
            if got > most:
                over.append(f"{line}, over its budget of {most:,} KB")
            print(f"{line} (budget {most:,} KB)")
    for line in over:
        print(f"error: {line}: make it smaller, or raise the budget in scripts/check-bundle-size.py and "
              "docs/app/performance.md and say why in the pull request")
    return 1 if over else 0


if __name__ == "__main__":
    sys.exit(main())
