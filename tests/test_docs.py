"""The docs lint for what GitHub shows (ticket 43), like Neovim's `make lintdoc` and
`linterrcodes`: every relative link in the Markdown resolves to a file and heading that exist,
and everything a machine can list (serve methods, error codes, CLI commands) is documented.
app/src/help/lint.test.ts checks the same links as `:help` shows them."""
import re
from pathlib import Path

import pytest

from roster import errors, serve
from roster.cli import build_parser

ROOT = Path(__file__).resolve().parent.parent
DOCS = sorted(
    [*ROOT.glob("docs/**/*.md"), ROOT / "README.md", ROOT / "CONTRIBUTING.md", ROOT / "GLOSSARY.md", ROOT / "app/README.md"]
)
LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)\)")
# A file in the repo: it has a slash or a file extension. Anything else (`options`, `:connect`,
# `terminal.size`, `help#links`) is a help topic, which only the app can resolve.
FILE_LIKE = re.compile(r"/|\.(md|lua|ya?ml|json|toml|sh|py|ts|tsx|rs|txt|png|webp|svg)$")


def slug(title: str) -> str:
    """GitHub's anchor for a heading (the app's help uses the same, doc.ts `slug`)."""
    t = re.sub(r"[`*]", "", title.lower())
    t = re.sub(r"[^\w\s-]", "", t)
    return re.sub(r"\s", "-", t.strip())


def anchors(path: Path) -> set[str]:
    text = re.sub(r"```.*?```", "", path.read_text(encoding="utf-8"), flags=re.S)
    seen: dict[str, int] = {}
    out = set()
    for m in re.finditer(r"^#{1,6}\s+(.*?)\s*#*$", text, re.M):
        base = slug(m.group(1))
        n = seen.get(base, 0)
        seen[base] = n + 1
        out.add(base if n == 0 else f"{base}-{n}")
    return out


def links(path: Path):
    text = re.sub(r"```.*?```", "", path.read_text(encoding="utf-8"), flags=re.S)
    text = re.sub(r"`[^`\n]*`", "", text)
    for m in LINK.finditer(text):
        yield m.group(1)


@pytest.mark.parametrize("doc", DOCS, ids=lambda p: str(p.relative_to(ROOT)))
def test_relative_links_resolve(doc):
    broken = []
    for href in links(doc):
        if re.match(r"^[a-z]+:", href, re.I):
            continue  # a web address, or mailto:
        file, _, anchor = href.partition("#")
        if file and not FILE_LIKE.search(file):
            continue  # a help topic
        target = (doc.parent / file).resolve() if file else doc
        if not target.exists():
            broken.append(f"{href}: no such file")
        elif anchor and target.suffix == ".md" and anchor not in anchors(target):
            broken.append(f"{href}: no heading #{anchor} in {target.relative_to(ROOT)}")
    assert broken == []


def test_every_serve_method_is_in_serve_api_md():
    doc = (ROOT / "docs/serve-api.md").read_text(encoding="utf-8")
    assert [m for m in sorted(serve.METHODS) if f"`{m}`" not in doc] == []


def test_every_error_code_is_in_serve_api_md():
    doc = (ROOT / "docs/serve-api.md").read_text(encoding="utf-8")
    codes = {name: value for name, value in vars(errors).items() if name.isupper() and isinstance(value, int)}
    assert codes, "errors.py has no codes?"
    assert [f"{name} = {code}" for name, code in sorted(codes.items()) if f"`{code}`" not in doc] == []


def test_every_cli_command_is_in_cli_reference_md():
    doc = (ROOT / "docs/cli-reference.md").read_text(encoding="utf-8")
    sub = next(a for a in build_parser()._actions if a.dest == "cmd")
    missing = [name for name in sub.choices if not re.search(rf"^\| `{re.escape(name)}\b", doc, re.M)]
    assert missing == []


SYNC = ROOT / "app/scripts/app-sync.sh"
APP_IMPORT = re.compile(r"""from\s+["']((?:\.\./)+[^"'?]+)(?:\?[^"']*)?["']""")


def sync_filters() -> list[str]:
    """The --include/--exclude rules app-sync.sh hands rsync, in order."""
    text = SYNC.read_text(encoding="utf-8")
    return re.findall(r"--((?:in|ex)clude)[ =]('[^']*'|\S+)", text)


@pytest.mark.skipif(not __import__("shutil").which("rsync"), reason="rsync not installed")
def test_windows_sync_copies_every_file_the_app_imports_from_outside_app(tmp_path):
    """The Windows build copies only what app-sync.sh syncs, so a file the frontend imports
    from elsewhere in the repo (a docs/*.md bundled into :help) must be synced, or the
    Windows build fails while CI, which has the whole checkout, passes."""
    import subprocess

    wanted = set()
    for src in (ROOT / "app/src").rglob("*.ts*"):
        for m in APP_IMPORT.finditer(src.read_text(encoding="utf-8")):
            target = (src.parent / m.group(1)).resolve()
            if not target.is_relative_to(ROOT / "app"):
                wanted.add(target.relative_to(ROOT).as_posix())
    assert wanted, "expected the app to bundle some docs from outside app/"
    args = [f"--{kind}={pat.strip(chr(39))}" for kind, pat in sync_filters()]
    out = subprocess.run(
        ["rsync", "-an", "--out-format=%n", *args, f"{ROOT}/", f"{tmp_path}/"],
        capture_output=True, text=True, check=True,
    ).stdout.splitlines()
    missing = sorted(wanted - set(out))
    assert not missing, f"app-sync.sh doesn't sync files the app imports: {missing}"
