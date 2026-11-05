// The finders' scoring (the Picker's, picker/match.ts), on its own with no imports beyond the
// matcher, so the docs website's search (src/docs-site) ships the same ranking as `:help`'s topic
// finder without the rest of the app.
import { fieldScore } from "../picker/match";
import type { FinderItem } from "./sources";

/** How much a match counts in each field; a path is prose-like, so it matches only as a substring. */
const FIELDS: readonly [weight: number, scattered: boolean, get: (i: FinderItem) => string | undefined][] = [
  [3, true, (i) => i.label],
  [2, true, (i) => i.detail],
  [1, false, (i) => i.path],
  [1, false, (i) => i.note],
];

/** With two words or more, how the title holds them (round 20: for "host key", "Hosts" on the Key
 * bindings page came before "Trusting a new host key"): 2 when it holds them as one phrase, 1
 * when it holds every word whole somewhere, 0 otherwise. Ranked before the score. */
function titleTier(item: FinderItem, terms: readonly string[]): number {
  if (terms.length < 2) return 0;
  const title = `${item.label} ${item.note ?? ""}`.toLowerCase().replace(/\s+/g, " ");
  if (title.includes(terms.join(" "))) return 2;
  return terms.every((t) => title.includes(t)) ? 1 : 0;
}

/** The items matching `query`, best first (the Picker's scoring): every word must match a field;
 * with two words or more, a title holding them as a phrase comes first, then one holding them
 * all (titleTier); ties keep the source's order. An empty query keeps them all, in order. */
export function searchItems(items: readonly FinderItem[], query: string): FinderItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];
  const out: { item: FinderItem; tier: number; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    let score = 0;
    for (const term of terms) {
      let best = 0;
      for (const [weight, scattered, get] of FIELDS) {
        const value = get(item);
        if (value) best = Math.max(best, fieldScore(term, value, scattered) * weight);
      }
      if (best === 0) return;
      score += best;
    }
    out.push({ item, tier: titleTier(item, terms), score, order });
  });
  out.sort((x, y) => y.tier - x.tier || y.score - x.score || x.order - y.order);
  return out.map((o) => o.item);
}
