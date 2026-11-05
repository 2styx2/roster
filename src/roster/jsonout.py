"""`--json` on the CLI's read commands (T102, #180): roster's data for scripts, other tools and Claude, in the
shapes `roster serve` answers with (the Host, group and resource objects load_config builds), one JSON document
on stdout. The CLI is roster's interface for other apps; serve stays the desktop app's backend.

Never a secret: Logins are references (bw:ITEM), and a `cmd:` or `env:` one, which says how a secret is fetched
(a secret pasted into a cmd: line would show), is cut to its kind everywhere in the output, error messages too,
the same rule the app's core applies to what Plugins get (decision Q92; runtime.rs redact_text).

JSON_VERSION goes up when a field is removed, renamed or changes meaning (docs/cli-reference.md, "Machine-readable
output"); a new field doesn't change it."""

import json
import re
import sys
from typing import Any, TextIO, cast

JSON_VERSION = 1

_SPACE = " \t\n\x0c\r"                       # Rust's is_ascii_whitespace
_BEFORE = _SPACE + "\"'=:,({["
_KINDS = ("cmd:", "env:")
_CODE = re.compile(r" \(code -?[0-9]+\)\Z")      # serve's error code, last in a message


def _kind_at(text: str, i: int) -> str | None:
    if i > 0 and text[i - 1] not in _BEFORE:
        return None
    word = text[i:i + 4].lower()
    return word if word in _KINDS else None


def redact_text(text: str) -> str:
    """TEXT with each `cmd:`/`env:` reference cut to its kind. A reference starts the text or follows a space, a
    quote or one of `=:,({[`, in any case. A `cmd:` one runs to the end of its line (a closing quote is put back),
    an `env:` one is the variable's name. `cmd: is ready` is the kind alone, kept."""
    out: list[str] = []
    copied, i, n = 0, 0, len(text)
    while i < n:
        kind = _kind_at(text, i)
        if kind is None:
            i += 1
            continue
        start = i + 4
        if kind == "cmd:":
            if start >= n or text[start] in _SPACE:
                end = start
            else:
                ends = [p for p in (text.find("\n", start), text.find("\r", start)) if p >= 0]
                end = min(ends) if ends else n
        else:
            end = start
            while end < n and text[end].isascii() and (text[end].isalnum() or text[end] == "_"):
                end += 1
        if end > start or text[i:start] != kind:
            out += [text[copied:i], kind]
            if kind == "cmd:" and end > start and i > 0 and text[i - 1] in "\"'":
                out.append(text[i - 1])
            copied = end
        i = max(end, start)
    return "".join(out) + text[copied:] if out else text


def redact_error(message: str) -> str:
    """An error MESSAGE with its references cut, as redact_text, but a trailing ` (code N)` stays even after a
    `cmd:` reference that runs to the end of the line: it tells errors apart (Q92; runtime.rs redact_error)."""
    m = _CODE.search(message)
    at = m.start() if m else len(message)
    return redact_text(message[:at]) + message[at:]


def redact(v: Any) -> Any:
    """A copy of V (plain JSON data: what json.loads gives) with every string cut by redact_text, a key as much as
    a value."""
    if isinstance(v, str):
        return redact_text(v)
    if isinstance(v, dict):
        return {redact_text(k) if isinstance(k, str) else k: redact(x) for k, x in cast(dict[Any, Any], v).items()}
    if isinstance(v, (list, tuple)):
        return [redact(x) for x in cast("list[Any] | tuple[Any, ...]", v)]
    return v


def emit(doc: Any, stream: TextIO | None = None) -> None:
    """DOC (a document model, jsondocs.py) as one JSON document, `version` first, every string cut. It's made plain
    JSON first (a Path or any other object in a free-form field becomes what json.dumps makes of it, a key a
    string), so nothing reaches stdout uncut."""
    from .jsondocs import plain  # Pydantic: only when a --json command prints
    data = json.loads(json.dumps({"version": JSON_VERSION, **plain(doc)}, default=str))
    print(json.dumps(redact(data)), file=stream or sys.stdout, flush=True)


def fail(code: int, message: str, fix: str | None = None) -> None:
    """An error on stderr: {"version", "error": {code, message, fix}}. code is errors.py's (serve's) number."""
    from .jsondocs import Error, ErrorDoc
    emit(ErrorDoc(error=Error(code=code, message=redact_error(message), fix=fix)), sys.stderr)
# T237 probe: a CLI-only change, to time CI (throwaway, never merged)
