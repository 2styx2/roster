// The cmd:/env: cut (decision Q92) the core makes to everything a Plugin gets from roster serve
// (crates/roster-core/src/plugin/runtime.rs, redact_text, redact_error, redact), ported so the fake
// Backend's Plugins get what the real ones do and a frontend test can catch a leak. Tested on the
// cases the core and the CLI share: tests/vectors/redaction.json.

/** Rust's is_ascii_whitespace, then the characters a reference may follow. */
const SPACE = " \t\n\f\r";
const BEFORE = `${SPACE}"'=:,({[`;
const KINDS = ["cmd:", "env:"] as const;
type Kind = (typeof KINDS)[number];
/** serve's error code, last in a message. */
const CODE = / \(code -?[0-9]+\)$/;

function kindAt(text: string, i: number): Kind | null {
  if (i > 0 && !BEFORE.includes(text.charAt(i - 1))) return null;
  const word = text.slice(i, i + 4).toLowerCase();
  return KINDS.find((k) => k === word) ?? null;
}

const isNameChar = (c: string) => /^[A-Za-z0-9_]$/.test(c);

/** `text` with each `cmd:`/`env:` reference cut to its kind. A reference starts the text or
 * follows a space, a quote or one of `=:,({[`, in any case. A `cmd:` one runs to the end of its
 * line (a closing quote is put back), an `env:` one is the variable's name. `cmd: is ready` is
 * the kind alone, kept. */
export function redactText(text: string): string {
  const out: string[] = [];
  let copied = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const kind = kindAt(text, i);
    if (!kind) {
      i++;
      continue;
    }
    const start = i + 4;
    let end = start;
    if (kind === "cmd:") {
      if (start < n && !SPACE.includes(text.charAt(start))) {
        const ends = [text.indexOf("\n", start), text.indexOf("\r", start)].filter((p) => p >= 0);
        end = ends.length ? Math.min(...ends) : n;
      }
    } else {
      while (end < n && isNameChar(text.charAt(end))) end++;
    }
    if (end > start || text.slice(i, start) !== kind) {
      out.push(text.slice(copied, i), kind);
      const before = i > 0 ? text.charAt(i - 1) : "";
      if (kind === "cmd:" && end > start && (before === '"' || before === "'")) out.push(before);
      copied = end;
    }
    i = Math.max(end, start);
  }
  return out.length ? out.join("") + text.slice(copied) : text;
}

/** An error message with its references cut, but a trailing ` (code N)` kept even after a `cmd:`
 * reference that runs to the end of the line: a Plugin tells errors apart by it. */
export function redactError(message: string): string {
  const m = CODE.exec(message);
  const at = m ? m.index : message.length;
  return redactText(message.slice(0, at)) + message.slice(at);
}

/** A copy of plain data with every string cut, a key as much as a value. */
export function redact<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redact(v)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactText(k), redact(v)])) as T;
  }
  return value;
}
