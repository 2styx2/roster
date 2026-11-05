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

/** What an error says: its message, or the thing itself as text. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
