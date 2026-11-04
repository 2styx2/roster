"""Check the app's JS and CSS against their size budget (ticket 75, docs/app/performance.md "Bundle size").

CI builds the frontend (`vite build` in app/) and runs this on every pull request. From a clone:

    cd app && npx vite build && cd .. && python3 scripts/check-bundle-size.py      # or give the dist folder

It adds up every .js and every .css file the build wrote under dist/assets, minified as shipped and gzipped
(level 9, as a size anyone can reproduce; the app reads them from disk, so raw is what it parses), and fails
when a total is over its budget. Two dynamic import() chunks are budgeted on their own rather than as JS the
app parses at start: the fake Backend's (fake-*.js, for the tutor demo and browser runs) and the help chunk
(guideText-*.js, :help's guides, loaded on the first :help: T213, decision Q189). It also fails when a startup
chunk carries a guide's sentence (MARKERS), which would mean the guides are bundled at start again. Fonts,
icons and other assets aren't counted: they change only when a font does. A KB here is 1,000 bytes, as Vite prints them. A change that goes over raises the budget below and
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
# JS 2,550 -> 2,600 raw, 745 -> 760 gzipped on 2026-11-03: serve-api.md's Host, Login, service and group tables,
# now generated from the models (T174, #332) and bundled for :help, took dev's 744.6 gzipped to 745.9 (2,544.5
# raw). Text :help reads, not a dependency, so the budgets follow it with room for the next small feature.
# JS 2,600 -> 2,650 raw, 760 -> 775 gzipped on 2026-11-03: Windows Hosts (T195, #375: adding-hosts.md's section,
# error rows 212-216, serve's error codes and the Host's os field, all bundled for :help) took dev's 2,580.4 raw /
# 758.9 gzipped to 2,591.5 / 762.8. Text :help reads, not a dependency, so the budgets follow it, as above.
# CSS 85 -> 90 raw, 15.5 -> 16.5 gzipped on 2026-11-04 (T192, #364, owner's call): dev's build was 83,981 bytes raw /
# 15,429 gzipped, 71 bytes under the gzipped budget, after T178 found no dead rules left to take out, so the next
# stylesheet change would fail. The app's own stylesheets, grown a rule at a time with features, not a dependency;
# 1 KB gzipped lets the next few small features through while a stylesheet library (tens of KB) still fails.
# JS 2,650 -> 3,000 raw, 775 -> 880 gzipped on 2026-11-04 (T197, #377, decision Q181, owner's call: thorough docs,
# budgets follow comparable products): ~38 % of the startup JS is bundled :help text (978 KB raw / 287 gzipped);
# comparables are bigger (Neovim's help 1.6 MB gzipped). Raised once so docs PRs stop moving it; lazy :help (T213, #405)
# then splits it. The same day the fake Backend's chunk (fake-*.js, a dynamic import(), 172.8 raw / 58.2 gzipped)
# stopped counting toward it and got a budget of its own, its size then + 15 %. Startup JS without it: 2,433.7 raw
# / 710.0 gzipped.
# JS split into startup and the help chunk on 2026-11-04 (T213, #405, decision Q189): :help's guides load on the first
# :help (their text a chunk of its own, the Plugin API bundled once, as data), so the startup JS is the app's code and
# its dependencies again. Measured that day: startup 1,552.1 raw / 439.3 gzipped (was 2,488.5 / 727.8), the help chunk
# 1,003.1 / 304.4. Startup JS 3,000 -> 1,700 raw, 880 -> 480 gzipped, about 10 % above, so it catches a dependency or
# code growth again; the help chunk 1,100 / 335, about 10 % above too (#431's review F6), so code or a dependency pulled
# into its imports shows; it's text loaded on the first :help (Neovim ships 5.4 MB of help, read a page at a time), so a
# docs PR that takes it over raises it with its reason, as the search index's is.
# docs/app/performance.md "Bundle size" keeps the same history; change both together.
BUDGETS = {
    "js": {"raw": 1700, "gzip": 480},
    "help": {"raw": 1100, "gzip": 335},
    "css": {"raw": 90, "gzip": 16.5},
    "fake": {"raw": 199, "gzip": 67},
}
LABELS = {"js": "Startup JS", "help": "Help chunk JS", "css": "CSS", "fake": "Fake Backend JS"}

# Sentences of the guides (docs/), none of which the app's own code says: a startup chunk that carries one carries
# the guides' text. Each must be in the help chunk too, so the check can't pass because the build changed shape.
MARKERS = [
    "Commands, keys, Themes, finders, Sidebar sections, the toolbar and these help pages are all registries",
    "Every function, value, event and data type of the",
]


def kind_of(f):
    """Which budget file F counts toward: "js" (startup), "help" (the help chunk), "fake" (the fake Backend's
    chunk), "css", or another suffix (not counted)."""
    kind = f.suffix.lstrip(".")
    if kind == "js" and f.name.startswith("fake-"):
        return "fake"
    if kind == "js" and f.name.startswith("guideText-"):
        return "help"
    return kind


def help_problems(dist, markers=None):
    """What's wrong with where the guides' text is: a startup chunk carrying a marker, or no help chunk with them."""
    markers = MARKERS if markers is None else markers
    files = sorted(f for f in (Path(dist) / "assets").rglob("*.js") if f.is_file())
    helps = [f for f in files if kind_of(f) == "help"]
    if not helps:
        return ["no help chunk (guideText-*.js) in the build: :help's guides should be a chunk of their own"]
    out = []
    for marker in markers:
        if not any(marker in f.read_text("utf-8", "replace") for f in helps):
            out.append(f"the help chunk doesn't carry {marker!r}: pick another sentence from a guide")
        for f in files:
            if kind_of(f) == "js" and marker in f.read_text("utf-8", "replace"):
                out.append(f"{f.name} carries help text ({marker!r}): the guides belong in the help chunk")
    return out


def measure(dist):
    """{"js": {"raw": bytes, "gzip": bytes}, "css": {...}}: the totals of the build in DIST (its assets folder)."""
    out = {kind: {"raw": 0, "gzip": 0} for kind in BUDGETS}
    for f in sorted((Path(dist) / "assets").rglob("*")):
        kind = kind_of(f)
        if kind in out and f.is_file():
            data = f.read_bytes()
            out[kind]["raw"] += len(data)
            out[kind]["gzip"] += len(gzip.compress(data, 9, mtime=0))
    return out


def main(argv=None, budgets=None, markers=None):
    argv = sys.argv[1:] if argv is None else argv
    budgets = BUDGETS if budgets is None else budgets
    dist = Path(argv[0]) if argv else ROOT / "app" / "dist"
    if not (dist / "assets").is_dir():
        print(f"no build in {dist}: run `npx vite build` in app/ first", file=sys.stderr)
        return 2
    sizes, over = measure(dist), []
    for kind, budget in budgets.items():
        for how in ("raw", "gzip"):
            got, most = sizes[kind][how] / KB, budget[how]
            line = f"{LABELS.get(kind, kind.upper())} {how} {got:,.1f} KB"
            if got > most:
                over.append(f"{line}, over its budget of {most:,} KB")
            print(f"{line} (budget {most:,} KB)")
    for line in over:
        print(f"error: {line}: make it smaller, or raise the budget in scripts/check-bundle-size.py and "
              "docs/app/performance.md and say why in the pull request")
    misplaced = help_problems(dist, markers) if markers != [] else []
    for line in misplaced:
        print(f"error: {line}")
    return 1 if over or misplaced else 0


if __name__ == "__main__":
    sys.exit(main())
