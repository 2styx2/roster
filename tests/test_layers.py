"""src/roster's layers (docs/architecture.md, "The CLI"): every module is in one layer of LAYERS, and imports only
modules of its own layer or one below, with no cycle. Every import counts, a function's own included: a lazy import
still ties the two modules together."""
from __future__ import annotations

import ast
import pathlib

SRC = pathlib.Path(__file__).resolve().parent.parent / "src" / "roster"
DOC = "docs/architecture.md"

# Lowest first. A module imports only its own layer or the ones below it.
LAYERS: dict[str, list[str]] = {
    # Import nothing of roster's: what everything else stands on.
    "leaf": ["roster", "errors", "context", "hosts", "keyline", "aliases", "clihelp", "example", "winpipe",
             "providers.bw_items_filter"],
    # Shared helpers over the leaves.
    "base": ["common", "winfile", "conpty", "providers.problems"],
    # One owner per file or format roster keeps, and serve's job manager.
    "format": ["sshconfig", "boxkeys", "boxlock", "rotation", "resources", "named", "models", "askpass", "vaultcli",
               "jobs"],
    # roster.yml loaded and edited, the vaults, ssh from this Box, the --json and serve documents.
    "core": ["config", "edit", "changes", "claude", "sshops", "servemodels", "jsondocs", "jsonout", "providers",
             "providers.bitwarden", "providers.builtin", "providers.bw_login", "providers.keepassxc",
             "providers.onepassword"],
    # What a command or a serve method does: shared by both, so neither holds logic the other needs.
    "feature": ["boxsync", "store", "inventories", "newinventory", "mesh", "diagnose", "fill", "health", "web",
                "discover", "addhost", "fromvault", "authorized", "winhost", "rotate", "vaultsync", "cliparser",
                "completion", "manpage"],
    # The two front doors. Nothing imports them but the ones listed in TOP_IMPORTS.
    "top": ["serve", "cli", "__main__"],
}

# The only imports of a top module: `python -m roster` runs the CLI, and `roster serve` (a CLI command) runs serve.
TOP_IMPORTS = {("__main__", "cli"), ("cli", "serve")}

# Cycles kept on purpose, each with why. Anything else that imports in a circle fails.
KNOWN_CYCLES = {
    frozenset({"common", "winfile"}):
        "winfile is common.read_private_bytes's Windows half (ctypes, owner and DACL through one handle): common imports"
        " it only inside that function on Windows, and it raises common's NotPrivate, so callers catch one exception",
}

RANK = {m: i for i, layer in enumerate(LAYERS.values()) for m in layer}
LAYER_OF = {m: name for name, layer in LAYERS.items() for m in layer}


def modules() -> dict[str, pathlib.Path]:
    out = {}
    for p in sorted(SRC.rglob("*.py")):
        parts = p.relative_to(SRC.parent).with_suffix("").parts
        name = ".".join(parts[:-1] if parts[-1] == "__init__" else parts)
        out[name.removeprefix("roster.") if name != "roster" else name] = p
    return out


MODULES = modules()


def imports(name: str, path: pathlib.Path) -> dict[str, int]:
    """The roster modules NAME imports, anywhere in it (a function's lazy import too), each with its first line."""
    dotted = (name if name == "roster" else f"roster.{name}").split(".")
    package = dotted if path.name == "__init__.py" else dotted[:-1]
    found: dict[str, int] = {}

    def add(dotted: str, line: int) -> None:
        short = dotted.removeprefix("roster.") if dotted != "roster" else "roster"
        if short in MODULES and short != name:
            found.setdefault(short, line)

    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name == "roster" or a.name.startswith("roster."):
                    add(a.name, node.lineno)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package[: len(package) - node.level + 1]
                mod = ".".join(base + ([node.module] if node.module else []))
            else:
                mod = node.module or ""
            if mod != "roster" and not mod.startswith("roster."):
                continue
            for a in node.names:               # `from . import x` is module x; `from .x import y` is module x
                sub = f"{mod}.{a.name}"
                add(sub if sub.removeprefix("roster.") in MODULES else mod, node.lineno)
    return found


GRAPH = {name: imports(name, path) for name, path in MODULES.items()}


def same_package(a: str, b: str) -> bool:
    """A package and its own modules (providers registers its providers, which import its registry): one module's
    insides, not a cycle between layers."""
    return a.split(".")[0] == b.split(".")[0] and "." in a + b


def test_every_module_has_a_layer():
    missing = sorted(set(MODULES) - set(RANK))
    gone = sorted(set(RANK) - set(MODULES))
    assert not missing, f"{missing}: give each new module a layer in LAYERS here and in {DOC} (\"The CLI\")"
    assert not gone, f"{gone} no longer exist: take them out of LAYERS here and in {DOC}"


def test_imports_go_down_the_layers():
    upward = [f"{m} ({LAYER_OF[m]}) imports {d} ({LAYER_OF[d]}) at {MODULES[m].name}:{line}"
              for m, deps in GRAPH.items() for d, line in deps.items()
              if RANK[d] > RANK[m] and not same_package(m, d)]
    assert not upward, (f"{DOC}, \"The CLI\": a module imports only its own layer or below; move the piece both need"
                        f" down instead:\n  " + "\n  ".join(upward))


def test_leaves_import_nothing_of_roster():
    bad = [f"{m} imports {d}" for m in LAYERS["leaf"] for d in GRAPH[m] if not same_package(m, d)]
    assert not bad, f"{DOC}, \"The CLI\": a leaf imports nothing of roster's:\n  " + "\n  ".join(bad)


def test_nothing_imports_cli_or_serve():
    bad = [f"{m} imports {d} at {MODULES[m].name}:{line}" for m, deps in GRAPH.items() for d, line in deps.items()
           if d in LAYERS["top"] and (m, d) not in TOP_IMPORTS]
    assert not bad, (f"{DOC}, \"The CLI\": cli and serve only parse, dispatch and render; logic either needs goes in a"
                     f" feature module both import:\n  " + "\n  ".join(bad))


def test_no_import_cycles():
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    cycles: list[frozenset[str]] = []

    def visit(v: str) -> None:
        index[v] = low[v] = len(index)
        stack.append(v)
        for w in GRAPH[v]:
            if same_package(v, w):
                continue
            if w not in index:
                visit(w)
                low[v] = min(low[v], low[w])
            elif w in stack:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            scc = []
            while True:
                w = stack.pop()
                scc.append(w)
                if w == v:
                    break
            if len(scc) > 1:
                cycles.append(frozenset(scc))

    for v in GRAPH:
        if v not in index:
            visit(v)
    fresh = [", ".join(sorted(c)) for c in cycles if c not in KNOWN_CYCLES]
    assert not fresh, f"{DOC}, \"The CLI\": modules import each other one way:\n  " + "\n  ".join(fresh)
    assert set(KNOWN_CYCLES) <= set(cycles), "a known cycle is gone: take it off KNOWN_CYCLES and the doc's list"


def test_the_table_is_the_docs():
    """docs/architecture.md lists the same layers, in the same order, with the same modules."""
    text = (SRC.parent.parent / DOC).read_text(encoding="utf-8")
    start = text.index("<!-- layers:python -->")
    end = text.index("<!-- /layers:python -->")
    rows = [line for line in text[start:end].splitlines() if line.startswith("| `")]
    doc = {}
    for row in rows:
        cells = [c.strip() for c in row.strip("|").split("|")]
        doc[cells[0].strip("`")] = [m.strip().strip("`") for m in cells[1].split(",")]
    assert list(doc) == list(LAYERS), f"{DOC}'s layer table names {list(doc)}, this test {list(LAYERS)}"
    for name, mods in LAYERS.items():
        assert sorted(doc[name]) == sorted(mods), f"{DOC}'s `{name}` row: {sorted(doc[name])} vs {sorted(mods)}"
