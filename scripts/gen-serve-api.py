"""Generate docs/serve-api.md's method tables from serve's handlers' docstrings (ticket 51, decision Q85).

One source of truth: each handler's docstring says what its row says, and the doc's tables are rewritten
from them, between markers that name the methods in each table:

    <!-- BEGIN generated:methods host.scan_key host.trust_key -->
    (the table: Method | Params | Result | Errors | Since API)
    <!-- END generated:methods -->

Everything outside the markers is hand-written prose and stays as it is. From a clone:

    uv run python scripts/gen-serve-api.py            # rewrites docs/serve-api.md
    uv run python scripts/gen-serve-api.py --check    # exits 1 if the committed doc is out of date

tests/test_serve_api_doc.py runs the same comparison, so a stale doc fails the tests.

A handler's docstring is prose for whoever reads serve.py, plus these fields, each at the start of a line
(a field's text may run on over indented lines):

    Params: `{host, fingerprint}` (`SHA256:...`, the one the user was shown)
    Result: `{host, address, port, key_type, fingerprint, recorded}`: ...
    Errors: 43, 23, 40-42
    Since: API 11

`Params:` starts a row: a method that takes two shapes of params has two `Params:` lines, each followed by
its own `Result:`, `Errors:` (optional: the codes particular to it) and `Since:` (the API version that added
that form). Text is Markdown, as it shows in the table; a `|` is escaped for you.

The objects the results are made of are documented from their Pydantic models (ticket T174, decision Q113), between
markers that name the models (from src/roster/models.py and servemodels.py):

    <!-- BEGIN generated:models Host SshLogin -->
    (for each: **Name**: its docstring's first paragraph, then Field | Type | What, from each field's description)
    <!-- END generated:models -->

A field with no `description=` is refused, so a field added to a model can't be missing from the doc.
"""

import argparse
import inspect
import json
import re
import sys
import types
import typing
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs" / "serve-api.md"
COMMAND = "uv run python scripts/gen-serve-api.py"

BEGIN = re.compile(r"^<!-- BEGIN generated:methods ([^>]*?) -->$", re.M)
END = "<!-- END generated:methods -->"
MODELS_BEGIN = re.compile(r"^<!-- BEGIN generated:models ([^>]*?) -->$", re.M)
MODELS_END = "<!-- END generated:models -->"
FIELD = re.compile(r"^(Params|Result|Errors|Since):\s*(.*)$")
HEAD = "| Method | Params | Result | Errors | Since API |\n|---|---|---|---|---|\n"


class DocError(Exception):
    """Why the doc can't be generated, saying what to change."""


def known_codes():
    from roster import errors, serve
    codes = {v for k, v in vars(errors).items() if k.isupper() and isinstance(v, int)}
    return codes | {serve.PARSE_ERROR, serve.INVALID_REQUEST, serve.METHOD_NOT_FOUND, serve.INVALID_PARAMS,
                    serve.INTERNAL_ERROR}


def api_version():
    from roster import serve
    return serve.API_VERSION


def forms(name, fn):
    """The rows a handler's docstring gives: [{Params, Result, Errors?, Since}, ...]."""
    where = f"serve method {name!r} ({getattr(fn, '__name__', '?')} in src/roster/serve.py)"
    doc = inspect.getdoc(fn)
    if not doc:
        raise DocError(f"{where} has no docstring: give it Params:, Result:, Since: (see scripts/gen-serve-api.py)")
    rows, field = [], None
    for line in doc.splitlines():
        m = FIELD.match(line)
        if m:
            key, value = m.groups()
            if key == "Params":
                rows.append({})
            elif not rows:
                raise DocError(f"{where}: {key}: comes before any Params: line")
            if key in rows[-1]:
                raise DocError(f"{where}: two {key}: lines for one Params: line")
            rows[-1][key] = value.strip()
            field = key
        elif field and line[:1].isspace() and line.strip():
            rows[-1][field] += " " + line.strip()
        else:
            field = None
    if not rows:
        raise DocError(f"{where}'s docstring has no Params: line (see scripts/gen-serve-api.py for the fields)")
    codes, newest = known_codes(), api_version()
    for row in rows:
        for key in ("Result", "Since"):
            if not row.get(key):
                raise DocError(f"{where}: Params: {row['Params']} has no {key}: line")
        since = re.fullmatch(r"API (\d+)", row["Since"])
        if not since or not 1 <= int(since.group(1)) <= newest:
            raise DocError(f"{where}: Since: {row['Since']!r} isn't `API N` with N from 1 to {newest}")
        for code in error_codes(row.get("Errors", ""), where):
            if code not in codes:
                raise DocError(f"{where}: Errors: {code} isn't a code in src/roster/errors.py or JSON-RPC's")
    return rows


def error_codes(text, where):
    out = []
    for part in filter(None, (p.strip() for p in text.split(","))):
        m = re.fullmatch(r"(-?\d+)(?:-(\d+))?", part)
        if not m:
            raise DocError(f"{where}: Errors: {part!r} isn't a code or a range like 40-42")
        out += [int(m.group(1))] + ([int(m.group(2))] if m.group(2) else [])
    return out


def cell(text):
    return re.sub(r"(?<!\\)\|", r"\\|", text)


def errors_cell(text):
    parts = filter(None, (p.strip() for p in text.split(",")))
    return ", ".join("-".join(f"`{n}`" for n in re.fullmatch(r"(-?\d+)(?:-(\d+))?", p).groups() if n)
                     for p in parts)


def table(names, methods):
    rows = []
    for name in names:
        for f in forms(name, methods[name]):
            since = f["Since"].removeprefix("API ")
            rows.append(f"| `{name}` | {cell(f['Params'])} | {cell(f['Result'])} | "
                        f"{errors_cell(f.get('Errors', ''))} | {since} |\n")
    return HEAD + "".join(rows)


def doc_models():
    """The models serve's results are made of, by name: models.py's and servemodels.py's."""
    from pydantic import BaseModel

    from roster import models, servemodels
    return {name: cls for mod in (models, servemodels) for name, cls in vars(mod).items()
            if isinstance(cls, type) and issubclass(cls, BaseModel) and cls.__module__ == mod.__name__}


def type_text(t):
    """A field's type as JSON has it: `string | null`, `{string: Service}`, `ServiceProblem[]`."""
    origin, args = typing.get_origin(t), typing.get_args(t)
    if origin is typing.Annotated:
        return type_text(args[0])
    if origin in (typing.Union, types.UnionType):
        return " | ".join(type_text(a) for a in args)
    if origin is typing.Literal:
        return " | ".join(json.dumps(a) for a in args)
    if origin in (list, tuple):
        return f"{type_text(args[0])}[]"
    if origin is dict:
        return f"{{{type_text(args[0])}: {type_text(args[1])}}}"
    return JSON_TYPES.get(t, getattr(t, "__name__", str(t)))


JSON_TYPES = {str: "string", int: "integer", float: "number", bool: "boolean", type(None): "null", typing.Any: "any"}


def model_table(name, cls):
    where = f"model {name!r} (src/roster/models.py or servemodels.py)"
    text = cls.__dict__.get("__doc__")
    if not text:
        raise DocError(f"{where} has no docstring: its first paragraph introduces the table")
    intro = " ".join(inspect.cleandoc(text).split("\n\n")[0].split())
    rows = []
    for field, info in cls.model_fields.items():
        if not info.description:
            raise DocError(f"{name}.{field} has no description: give it Field(description=...) in {where}")
        key = info.alias or field
        rows.append(f"| `{key}` | `{cell(type_text(info.annotation))}` | {cell(info.description)} |\n")
    return (f"**{name}**: {intro[:1].lower()}{intro[1:]}\n\n| Field | Type | What |\n|---|---|---|\n"
            + "".join(rows))


def render_models(doc, models):
    out, pos = [], 0
    for m in MODELS_BEGIN.finditer(doc):
        if m.start() < pos:
            continue
        end = doc.find(MODELS_END, m.end())
        if end < 0:
            raise DocError(f"docs/serve-api.md: {m.group(0)} has no {MODELS_END} after it")
        tables = []
        for name in m.group(1).split():
            if name not in models:
                raise DocError(f"docs/serve-api.md lists model {name!r}, but models.py and servemodels.py have none "
                               "by that name")
            tables.append(model_table(name, models[name]))
        out += [doc[pos:m.end()], "\n\n", "\n".join(tables), "\n"]
        pos = end
    out.append(doc[pos:])
    return "".join(out)


def render(doc, methods, models=None):
    """The doc with every generated region rewritten from `methods` (serve.METHODS: name -> handler) and `models`
    (name -> Pydantic model; models.py's and servemodels.py's when not given)."""
    doc = render_models(doc, doc_models() if models is None else models)
    out, pos, placed = [], 0, {}
    for m in BEGIN.finditer(doc):
        if m.start() < pos:
            continue
        end = doc.find(END, m.end())
        if end < 0:
            raise DocError(f"docs/serve-api.md: {m.group(0)} has no {END} after it")
        names = m.group(1).split()
        for name in names:
            if name not in methods:
                raise DocError(f"docs/serve-api.md lists {name!r} in a generated table, but serve has no such "
                               "method: take it out of the marker (or add the method to serve.METHODS)")
            if name in placed:
                raise DocError(f"docs/serve-api.md lists {name!r} in two generated tables: keep one")
            placed[name] = True
        out += [doc[pos:m.end()], "\n\n", table(names, methods), "\n"]
        pos = end
    out.append(doc[pos:])
    missing = [n for n in methods if n not in placed]
    if missing:
        raise DocError(f"serve method(s) {', '.join(missing)} aren't in any table of docs/serve-api.md: add each "
                       "name to the `<!-- BEGIN generated:methods ... -->` marker of the section it belongs in "
                       f"(or a new one, closed by `{END}`), then run  {COMMAND}")
    return "".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Generate docs/serve-api.md's method tables from serve's docstrings.")
    ap.add_argument("--check", action="store_true", help="exit 1 if the committed doc is out of date")
    args = ap.parse_args(argv)
    sys.path.insert(0, str(ROOT / "src"))
    from roster import serve
    text = DOC.read_text(encoding="utf-8")
    try:
        new = render(text, serve.METHODS)
    except DocError as e:
        print(f"gen-serve-api: {e}", file=sys.stderr)
        return 2
    if args.check:
        if new != text:
            print(f"docs/serve-api.md's method tables are out of date: run  {COMMAND}", file=sys.stderr)
            return 1
        return 0
    if new != text:
        DOC.write_text(new, encoding="utf-8")
        print("rewrote docs/serve-api.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
