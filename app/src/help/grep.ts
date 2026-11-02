// `:helpgrep`'s matching (help/command.ts), on its own with no imports, so the docs website's
// search (src/docs-site) finds the same text, the same way, as the app does.

/** A place's text, and the topic to open for it (pages.ts's TextHit has these and more). */
export interface GrepText {
  /** The topic (or, on the website, the address) the text is at. */
  tag: string;
  text: string;
  /** A heading's own text: listed first. */
  heading?: boolean;
}

export interface GrepHit<T extends GrepText> {
  hit: T;
  /** The text around the first word's first match: what the finder shows. */
  label: string;
}

/** The words of a query, lower case. */
export const grepTerms = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Up to `width` characters of `text` around its first match of `term`. */
export function snippet(text: string, term: string, width = 80): string {
  if (text.length <= width) return text;
  const at = Math.max(0, text.toLowerCase().indexOf(term.toLowerCase()));
  let from = Math.max(0, Math.min(at - 30, text.length - width));
  // Start at a word, not in one.
  if (from > 0) from = text.indexOf(" ", from) + 1 || from;
  return `${from > 0 ? "…" : ""}${text.slice(from, from + width).trim()}${from + width < text.length ? "…" : ""}`;
}

/** The texts that have all the words of `query`, as typed (not fuzzy: this is text), each place
 * and snippet once; a heading that has them comes first, as it's what the text is about. */
export function grepTexts<T extends GrepText>(texts: readonly T[], query: string): GrepHit<T>[] {
  const terms = grepTerms(query);
  if (terms.length === 0) return [];
  const headings: GrepHit<T>[] = [];
  const rest: GrepHit<T>[] = [];
  const seen = new Set<string>();
  for (const hit of texts) {
    const lower = hit.text.toLowerCase();
    if (!terms.every((t) => lower.includes(t))) continue;
    const label = snippet(hit.text, terms[0] as string);
    const key = `${hit.tag}\n${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (hit.heading ? headings : rest).push({ hit, label });
  }
  return [...headings, ...rest];
}
