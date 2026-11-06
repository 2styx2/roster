// Numbers and counts as the UI shows them (ticket 27): grouped for the user's locale ("1,284"),
// and with the noun in the right form for the count ("1 host", "2 hosts").

const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const plurals = new Intl.PluralRules(undefined);

/** A count, grouped: 1284 → "1,284". */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? numbers.format(n) : "?";
}

/** A count and its noun: (1, "Host") → "1 Host"; (1284, "Host") → "1,284 Hosts". `many` is the
 * plural when it isn't `one` + "s". */
export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${plurals.select(n) === "one" ? one : many}`;
}

/** An address cut to at most `max` characters by dropping whole groups from its middle
 * ("fe80::1ff:…:890a%eth0"): never mid-token (DESIGN.md's Never-Cut-Mid-Token Rule). Its first
 * and last groups always stay, even past `max`. */
export function addressCut(ip: string, max: number): string {
  if (ip.length <= max) return ip;
  const sep = ip.includes(":") ? ":" : ".";
  const parts = ip.split(sep);
  if (parts.length < 3) return ip;
  let head = 1;
  let tail = 1;
  const text = (h: number, t: number) => `${parts.slice(0, h).join(sep)}${sep}…${sep}${parts.slice(parts.length - t).join(sep)}`;
  for (;;) {
    const grow = head <= tail ? [head + 1, tail] : [head, tail + 1];
    const [h = head, t = tail] = grow;
    if (h + t >= parts.length || text(h, t).length > max) break;
    head = h;
    tail = t;
  }
  return text(head, tail);
}

/** A name cut in the middle to at most `max` characters, its start and end kept
 * ("server-10-0…7-203"), so names that differ only at the end stay apart. */
export function middleCut(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max || max < 3) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** Where to split a long name so its end stays in view while its start is cut by its column (the
 * Picker's group, round 20): the index the kept end starts at, or null when the name is short
 * enough to show whole. The end is the last whole parts (after a `-`, `_`, `.`, `/` or space) that
 * fit in `most` characters and are at least `least` long; with no such split, the last `most`. */
export function endSplit(text: string, { least = 8, most = 14, short = 20 } = {}): number | null {
  const chars = Array.from(text);
  if (chars.length <= short) return null;
  for (let n = most; n >= least; n--) {
    if (/[-_./\s]/.test(chars[chars.length - n - 1] ?? "")) return text.length - chars.slice(chars.length - n).join("").length;
  }
  return text.length - chars.slice(chars.length - most).join("").length;
}

/** `text` cut in its middle to fit `width` as `measure` measures it: its start, one "…", and its
 * end from `endSplit` kept whole. The start drops its last characters (and any separator left
 * dangling before the "…") until the line fits. A text that fits, or one too short to split, comes
 * back as it is; if even one character of the start doesn't fit, the kept end is cut too, by the
 * cell's own ellipsis. */
export function fitMiddle(text: string, width: number, measure: (s: string) => number): string {
  if (measure(text) <= width) return text;
  const at = endSplit(text);
  if (at === null) return text;
  const head = Array.from(text.slice(0, at));
  const tail = text.slice(at);
  for (let n = head.length - 1; n >= 1; n--) {
    const start = head.slice(0, n).join("").replace(/[-_./\s]+$/, "");
    if (start === "") continue;
    const line = `${start}…${tail}`;
    if (measure(line) <= width) return line;
  }
  return `${head[0] ?? ""}…${tail}`;
}

/** What an error says: its message, or the thing itself as text. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
