"""Generate roster serve's contract from serve itself (ticket 51, decision Q85): docs/serve-api.md's method tables
from its handlers' docstrings, and the facts the app and the Rust core read from roster (docs/serve-contract.json, and
the same as TypeScript in app/src/backend/serveContract.ts) from serve's method registry and errors.py.

One source of truth: each handler's docstring says what its row says, and the doc's tables are rewritten
from them, between markers that name the methods in each table:

    <!-- BEGIN generated:methods host.scan_key host.trust_key -->
    (the table: Method | Params | Result | Errors | Since API)
    <!-- END generated:methods -->

Everything outside the markers is hand-written prose and stays as it is. From a clone:

    uv run python scripts/gen-serve-api.py            # rewrites docs/serve-api.md and the contract files
    uv run python scripts/gen-serve-api.py --check    # exits 1 if a committed one is out of date

tests/test_serve_api_doc.py runs the same comparison, so a stale doc or contract fails the tests (and the Rust core's
tests read docs/serve-contract.json: its codes, API versions and the deadlines its waits must outlast).

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

The contract: the API version, every method (the API that added it, each form's, its deadline), every code by its
errors.py name and JSON-RPC's, and the lists the app switches on (host.check's and host.verify_login's steps, the
fields an edit needs a test login for, vault.status's words, the Logins with no password behind them, the stand-in
for a path roster won't repeat).
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
CONTRACT = ROOT / "docs" / "serve-contract.json"
CONTRACT_TS = ROOT / "app" / "src" / "backend" / "serveContract.ts"
COMMAND = "uv run python scripts/gen-serve-api.py"

BEGIN = re.compile(r"^<!-- BEGIN generated:methods ([^>]*?) -->$", re.M)
END = "<!-- END generated:methods -->"
MODELS_BEGIN = re.compile(r"^<!-- BEGIN generated:models ([^>]*?) -->$", re.M)
MODELS_END = "<!-- END generated:models -->"
FIELD = re.compile(r"^(Params|Result|Errors|Since):\s*(.*)$")
HEAD = "| Method | Params | Result | Errors | Since API |\n|---|---|---|---|---|\n"


class DocError(Exception):
    """Why the doc can't be generated, saying what to change."""


def codes_by_name():
    """errors.py's codes by name: roster's own, then JSON-RPC's ({name: code}, {name: code})."""
    from roster import errors
    every = {k: v for k, v in vars(errors).items() if k.isupper() and type(v) is int}
    rpc = {k: every.pop(k) for k in errors.JSON_RPC}
    return dict(sorted(every.items(), key=lambda kv: kv[1])), rpc


def known_codes():
    roster, rpc = codes_by_name()
    return set(roster.values()) | set(rpc.values())


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
        if info.exclude:                    # kept on the model, never in its JSON (models.Host's mesh_dir, sudo)
            continue
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
    """The doc with every generated region rewritten from `methods` (handlers(): name -> handler) and `models`
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
                               "method: take it out of the marker (or register the method with @method)")
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


def handlers():
    """serve's methods by name: name -> handler (its docstring is its rows)."""
    from roster import serve
    return {name: m.fn for name, m in serve.METHODS.items()}


def contract():
    """What the app and the Rust core read from roster serve, as data (docs/serve-contract.json)."""
    from roster import diagnose, edit, errors, providers, serve
    roster_codes, rpc_codes = codes_by_name()
    methods = {}
    for name, m in sorted(serve.METHODS.items()):
        since = [int(f["Since"].removeprefix("API ")) for f in forms(name, m.fn)]
        methods[name] = {"since": min(since), "forms": since, "deadline": m.deadline}
    return {
        "generated": f"by scripts/gen-serve-api.py from src/roster/serve.py and errors.py: don't edit, run  {COMMAND}",
        "api_version": serve.API_VERSION,
        "after_deadline": serve.AFTER_DEADLINE,
        "methods": methods,
        "codes": roster_codes,
        "json_rpc": rpc_codes,
        "check_steps": list(diagnose.STEPS),
        "verify_steps": list(diagnose.VERIFY_STEPS),
        "login_fields": list(edit.LOGIN_FIELDS),
        "vault_statuses": list(dict.fromkeys(serve.STATUS_WORDS.values())),
        "no_password_auths": list(providers.NO_PASSWORD),
        "path_not_repeated": errors.PATH_NOT_REPEATED,
    }


def contract_json(c):
    """C as JSON, one line per method or code, so a diff shows what changed."""
    def value(v):
        if not isinstance(v, dict):
            return json.dumps(v)
        rows = ",\n".join(f"    {json.dumps(k)}: {json.dumps(x)}" for k, x in v.items())
        return "{\n" + rows + "\n  }"
    return "{\n" + ",\n".join(f"  {json.dumps(k)}: {value(v)}" for k, v in c.items()) + "\n}\n"


def ts_value(v):
    return json.dumps(v)


def contract_ts(c):
    """The contract as a TypeScript module: each fact `as const`, so the app's types follow it."""
    def record(name, doc, values, typed=None):
        """An object of VALUES: `as const` (each value its own literal type), or of the type TYPED."""
        rows = "".join(f"  {json.dumps(k) if not k.isidentifier() else k}: {ts_value(v)},\n"
                       for k, v in values.items())
        if typed:
            return f"/** {doc} */\nexport const {name}: {typed} = {{\n{rows}}};\n"
        return f"/** {doc} */\nexport const {name} = {{\n{rows}}} as const;\n"

    def array(name, doc, values):
        return f"/** {doc} */\nexport const {name} = {ts_value(values)} as const;\n"
    since = {k: m["since"] for k, m in c["methods"].items()}
    form_since = {k: m["forms"] for k, m in c["methods"].items()}
    parts = [
        "// Generated by scripts/gen-serve-api.py from roster serve's method registry (src/roster/serve.py) and its codes\n"
        f"// (src/roster/errors.py): don't edit, run `{COMMAND}`. docs/serve-contract.json is the\n"
        "// same data, for the Rust core.\n",
        f"/** The serve API this roster speaks. */\nexport const SERVE_API_VERSION = {c['api_version']};\n",
        record("Code", "roster's error codes by their errors.py name (docs/app/errors.md has their rows).", c["codes"]),
        record("JsonRpcCode", "JSON-RPC's own error codes, which serve answers with too.", c["json_rpc"]),
        "/** Every serve method's name. */\nexport type ServeMethod =\n"
        + "".join(f"  | {json.dumps(k)}\n" for k in since).rstrip("\n") + ";\n",
        record("SINCE", "Every serve method, and the first `api_version` that has it (a number: the app counts down "
               "from it).", since, typed="Readonly<Record<ServeMethod, number>>"),
        record("FORMS", "The `api_version` that added each of a method's forms (its rows in docs/serve-api.md), in "
               "order.", form_since),
        array("CHECK_STEPS", "`host.check`'s steps, in the order roster runs them.", c["check_steps"]),
        array("VERIFY_STEPS", "`host.verify_login`'s steps, in order.", c["verify_steps"]),
        array("LOGIN_FIELDS", "Changing these needs a test login that just succeeded (`host.verify_login`, decision "
              "Q43).", c["login_fields"]),
        array("VAULT_STATUSES", "Where a vault stands, in `vault.status`'s words.", c["vault_statuses"]),
        array("NO_PASSWORD_AUTHS", "Login references with no password behind them (`prompt` has none saved either, "
              "but it's a provider of its own).", c["no_password_auths"]),
        f"/** `data.path` for a roster.yml path roster won't repeat (a -c value shaped like a token). */\n"
        f"export const PATH_NOT_REPEATED = {ts_value(c['path_not_repeated'])};\n",
        "export type CodeName = keyof typeof Code;\n",
    ]
    return "\n".join(parts)


def outputs():
    """Every file this script writes, as it should be: {path: text}."""
    c = contract()
    return {DOC: render(DOC.read_text(encoding="utf-8"), handlers()), CONTRACT: contract_json(c),
            CONTRACT_TS: contract_ts(c)}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Generate roster serve's contract: docs/serve-api.md's method tables, "
                                             "docs/serve-contract.json and app/src/backend/serveContract.ts.")
    ap.add_argument("--check", action="store_true", help="exit 1 if a committed one is out of date")
    args = ap.parse_args(argv)
    sys.path.insert(0, str(ROOT / "src"))
    try:
        files = outputs()
    except DocError as e:
        print(f"gen-serve-api: {e}", file=sys.stderr)
        return 2
    stale = [path for path, text in files.items() if not path.exists() or path.read_text(encoding="utf-8") != text]
    if args.check:
        for path in stale:
            print(f"{path.relative_to(ROOT)} is out of date: run  {COMMAND}", file=sys.stderr)
        return 1 if stale else 0
    for path in stale:
        path.write_text(files[path], encoding="utf-8")
        print(f"rewrote {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
