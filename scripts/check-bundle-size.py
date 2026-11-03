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
# JS 2,500 -> 2,550 raw, 730 -> 745 gzipped on 2026-11-03: a Host row's menu (T166, #314: RowMenu.tsx,
# hostMenu.ts, the `menu` command and keyboard.md's new Sidebar section, bundled for :help) took it from
# dev's 2,489.4 raw / 729.7 gzipped (already at the budget) to 2,497.5 / 732.4. The app's own code and
# the text :help reads, not a dependency, so the budgets follow it with room for the next small feature.
# CSS measured 2026-11-03 (T173, #324): 84,467 bytes raw / 15,471 gzipped against 85 / 15.5 KB, so 29
# bytes under the gzipped budget. T173 took two redundant declarations out of the Host row menu's rules
# (T166) to get there from 84,522 / 15,485. Not raised: the next stylesheet change will go over, and its
# pull request says why or makes room.
# CSS measured 2026-11-03 (T178, #340): 83,981 bytes raw / 15,429 gzipped (dev was 84,634 / 15,478 by
# then). T178 took out declarations that every element they match has overridden (a framed panel's
# own width and float placement, which its frame sets; a full view's placement and fill; a Session's
# link edge's base state; the Pending changes diff's padding and tint, which the import diff's rules
# already replaced) and merged rules repeated for one selector, with every element's computed style
# and a screenshot of 44 fixture states unchanged. That's 653 B raw, 49 B gzipped: the stylesheet
# has no dead rules worth 1 KB gzipped, so the gzipped budget stays 71 bytes away. Not raised.
# JS 745 -> 755 gzipped on 2026-11-03 (T182/T183, #346/#347, PR #367): dev was 744.6 gzipped, and the
# CLI reference's Mesh-state and revoke --all text, error 149's rows and the news bullets (all bundled for
# :help) took it to 747.7. Text :help reads, not a dependency or code, so the budget follows it with room
# for the next small feature, as for ticket 166. JS raw stays 2,550 (2,544.8).
# docs/app/performance.md "Bundle size" keeps the same history; change both together.
BUDGETS = {
    "js": {"raw": 2550, "gzip": 755},
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
