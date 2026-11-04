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
