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


def test_it_sums_every_js_and_css_file_raw_and_gzipped_and_leaves_fonts_out(tmp_path):
    js1, js2, css = b"let a = 1;\n" * 300, b"export {};\n", b"body{color:red}\n" * 50
    dist = build(tmp_path, {"index-1.js": js1, "fake-2.js": js2, "index-3.css": css, "inter.woff2": b"\0" * 5000})
    sizes = bs.measure(dist)
    assert sizes["js"] == {"raw": len(js1) + len(js2),
                           "gzip": len(gzip.compress(js1, 9, mtime=0)) + len(gzip.compress(js2, 9, mtime=0))}
    assert sizes["css"] == {"raw": len(css), "gzip": len(gzip.compress(css, 9, mtime=0))}


def test_it_fails_only_what_is_over_its_budget(tmp_path, capsys):
    dist = build(tmp_path, {"index.js": b"x" * 2000, "index.css": b"y" * 1000})
    budgets = {"js": {"raw": 2, "gzip": 1}, "css": {"raw": 0.5, "gzip": 1}}           # KB
    assert bs.main([str(dist)], budgets) == 1
    out = capsys.readouterr().out
    assert "CSS raw 1.0 KB, over its budget of 0.5 KB" in out and "JS raw 2.0 KB, over" not in out
    budgets["css"]["raw"] = 1
    assert bs.main([str(dist)], budgets) == 0


def test_a_missing_build_says_how_to_make_one(tmp_path, capsys):
    assert bs.main([str(tmp_path / "nope")]) == 2
    assert "vite build" in capsys.readouterr().err


def test_the_budgets_in_performance_md_are_the_scripts():
    text = (ROOT / "docs/app/performance.md").read_text(encoding="utf-8")
    rows = re.findall(r"^\| App (JS|CSS), minified \| ≤ ([\d,.]+) KB raw, ≤ ([\d,.]+) KB gzipped \|", text, re.M)
    assert {k.lower(): {"raw": float(raw.replace(",", "")), "gzip": float(gz.replace(",", ""))}
            for k, raw, gz in rows} == bs.BUDGETS
