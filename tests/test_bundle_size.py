"""scripts/check-bundle-size.py, the app's JS and CSS size budget (ticket 75). CI builds the frontend and runs it;
here it runs on made-up builds, and the budgets in docs/app/performance.md must be the script's own."""
import gzip
import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("check_bundle_size", ROOT / "scripts" / "check-bundle-size.py")
bs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bs)


def build(tmp_path, files):
    assets = tmp_path / "dist" / "assets"
    assets.mkdir(parents=True)
    for name, data in files.items():
        (assets / name).write_bytes(data)
    return tmp_path / "dist"


def sized(*blobs):
    return {"raw": sum(len(b) for b in blobs), "gzip": sum(len(gzip.compress(b, 9, mtime=0)) for b in blobs)}


def test_it_sums_every_js_and_css_file_raw_and_gzipped_and_leaves_fonts_out(tmp_path):
    js1, js2, css = b"let a = 1;\n" * 300, b"export {};\n", b"body{color:red}\n" * 50
    dist = build(tmp_path, {"index-1.js": js1, "tauri-2.js": js2, "index-3.css": css, "inter.woff2": b"\0" * 5000})
    sizes = bs.measure(dist)
    assert sizes["js"] == sized(js1, js2)
    assert sizes["css"] == sized(css)


def test_the_fake_backend_chunk_has_a_budget_of_its_own_not_the_startup_js(tmp_path):
    # It's a dynamic import() for the tutor demo and browser runs, not JS the app parses at start (#377).
    app, fake = b"let a = 1;\n" * 300, b"export const fixtures = [];\n" * 40
    sizes = bs.measure(build(tmp_path, {"index-1.js": app, "fake-Dc3x.js": fake}))
    assert sizes["js"] == sized(app)
    assert sizes["fake"] == sized(fake)


def test_the_help_chunk_has_a_budget_of_its_own_not_the_startup_js(tmp_path):
    # The guides' text, loaded on the first :help (T213, Q189): text, not code the app parses at start.
    app, guides = b"let a = 1;\n" * 300, b'export const guideTexts = {start: "# Getting started"};\n' * 40
    sizes = bs.measure(build(tmp_path, {"index-1.js": app, "guideText-Ab12.js": guides}))
    assert sizes["js"] == sized(app)
    assert sizes["help"] == sized(guides)


MARKER = "Every download carries LICENSE and THIRD-PARTY-NOTICES, side by side"


def test_it_fails_when_the_startup_js_carries_help_text(tmp_path, capsys):
    # A guide's sentence in a startup chunk means the text is bundled at start again (T213).
    dist = build(tmp_path, {"index-1.js": f'const x = "{MARKER}";'.encode(), "guideText-Ab12.js": f'"{MARKER}"'.encode()})
    assert bs.help_problems(dist, [MARKER]) == [f"index-1.js carries help text ({MARKER!r}): the guides belong in the help chunk"]
    assert bs.main([str(dist)], {}, markers=[MARKER]) == 1
    assert "carries help text" in capsys.readouterr().out


def test_it_fails_when_the_help_chunk_is_missing_or_lacks_the_text(tmp_path):
    # So the check above can't pass because the build changed shape.
    assert bs.help_problems(build(tmp_path / "a", {"index-1.js": b"x"}), [MARKER]) == [
        "no help chunk (guideText-*.js) in the build: :help's guides should be a chunk of their own"]
    assert bs.help_problems(build(tmp_path / "b", {"index-1.js": b"x", "guideText-1.js": b"y"}), [MARKER]) == [
        f"the help chunk doesn't carry {MARKER!r}: pick another sentence from a guide"]
    assert bs.help_problems(build(tmp_path / "c", {"index-1.js": b"x", "guideText-1.js": MARKER.encode()}), [MARKER]) == []


def test_its_markers_are_sentences_of_the_guides():
    for marker in bs.MARKERS:
        assert any(marker in f.read_text(encoding="utf-8") for f in [*(ROOT / "docs").rglob("*.md"), ROOT / "app/src/help/guideText.ts"]), marker


GUIDE_TEXT = r"""(?:\.\./)+(?:docs/[^"'`]*\.md|docs/[^"'`]*\*[^"'`]*|examples/plugins/types/roster\.lua)[^"'`]*"""
# `from "…"`, `import("…")`, a bare `import "…"`, and `import.meta.glob("…")` (or a list of them).
TEXT_IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bimport\.meta\.glob\s*(?:<[^>]*>)?\s*\(\s*\[?\s*)["'`](""" + GUIDE_TEXT + r""")["'`]""")


def guide_text_imports(text):
    return [m.group(1) for m in TEXT_IMPORT.finditer(text)]


def test_the_import_guard_sees_every_way_to_import_a_guide():
    for line in ['import news from "../../../docs/news.md?raw";', 'const t = await import("../../../docs/news.md?raw");',
                 'import "../../../docs/news.md?raw";', 'import.meta.glob("../../../docs/**/*.md", { query: "?raw" });',
                 'import.meta.glob<string>(["../../../docs/app/*.md"]);', "import s from '../../../examples/plugins/types/roster.lua?raw';"]:
        assert guide_text_imports(line), line
    for line in ['import { guides } from "./guides";', 'import x from "../../../crates/roster-core/tests/fixtures/plugin-api.json";',
                 '// see docs/news.md']:
        assert not guide_text_imports(line), line


def test_only_the_help_chunk_imports_the_guides_text():
    # The marker check above samples two guides; this covers every one (#431's review F5): outside the help
    # chunk (app/src/help/guideText.ts), only build-time and website code and tests may import docs/'s Markdown
    # or the stubs, so no guide's text can come back into the startup JS by an import of its own.
    allowed = {"src/help/guideText.ts"}
    found = []
    for f in sorted(p for ext in ("ts", "tsx", "js", "mjs") for p in (ROOT / "app/src").rglob(f"*.{ext}")):
        rel = f.relative_to(ROOT / "app").as_posix()
        if rel in allowed or ".test." in f.name or rel.startswith("src/docs-site/"):
            continue
        found += [f"{rel}: {i}" for i in guide_text_imports(f.read_text(encoding="utf-8"))]
    assert found == []
    assert guide_text_imports((ROOT / "app/src/help/guideText.ts").read_text(encoding="utf-8"))


def test_it_fails_only_what_is_over_its_budget(tmp_path, capsys):
    dist = build(tmp_path, {"index.js": b"x" * 2000, "index.css": b"y" * 1000})
    budgets = {"js": {"raw": 2, "gzip": 1}, "css": {"raw": 0.5, "gzip": 1}}           # KB
    assert bs.main([str(dist)], budgets, markers=[]) == 1
    out = capsys.readouterr().out
    assert "CSS raw 1.0 KB, over its budget of 0.5 KB" in out and "JS raw 2.0 KB, over" not in out
    budgets["css"]["raw"] = 1
    assert bs.main([str(dist)], budgets, markers=[]) == 0


def test_a_missing_build_says_how_to_make_one(tmp_path, capsys):
    assert bs.main([str(tmp_path / "nope")]) == 2
    assert "vite build" in capsys.readouterr().err


def test_the_budgets_in_performance_md_are_the_scripts():
    text = (ROOT / "docs/app/performance.md").read_text(encoding="utf-8")
    rows = re.findall(r"^\| App (JS|CSS|fake Backend|help)\b[^|]*, minified \| ≤ ([\d,.]+) KB raw, ≤ ([\d,.]+) KB gzipped \|",
                      text, re.M)
    kinds = {"JS": "js", "CSS": "css", "fake Backend": "fake", "help": "help"}
    assert {kinds[k]: {"raw": float(raw.replace(",", "")), "gzip": float(gz.replace(",", ""))}
            for k, raw, gz in rows} == bs.BUDGETS
