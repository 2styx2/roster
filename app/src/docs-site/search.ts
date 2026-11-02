// The docs website's search (ticket 65): `:help`'s topic finder and `:helpgrep` in one box, over
// the index the site build writes (search-index.js, from the same pages). Pure, and it imports only
// the finders' scoring and helpgrep's matching, so the page script that ships it stays small.
import { searchItems } from "../finder/search";
import type { FinderItem } from "../finder/sources";
import { grepTerms, grepTexts } from "../help/grep";

/** What search-index.js holds: every topic, every place text sits, and every text. Arrays rather
 * than objects, as it's the biggest file the site has. */
export interface SearchIndex {
  /** tag, label, path (what the topic finder shows faint; "" for none), address. */
  topics: [tag: string, label: string, path: string, href: string][];
  /** address, "Page › Heading". */
  places: [href: string, where: string][];
  /** place (into `places`), text. Not headings: each is a topic already (topicIndex). */
  texts: [place: number, text: string][];
}

export interface TopicResult {
  tag: string;
  label: string;
  path: string;
  href: string;
}

export interface TextResult {
  /** The text around the first word's match. */
  label: string;
  where: string;
  /** The place, with `?hl=WORD` so the page marks the first word (`:helpgrep`'s `/WORD`). */
  href: string;
}

export interface SearchResults {
  topics: TopicResult[];
  texts: TextResult[];
  /** The query's words, lower case: what to mark in a result. */
  terms?: string[];
}

interface Prepared {
  items: FinderItem[];
  topics: Map<string, TopicResult>;
  texts: { tag: string; text: string; place: number }[];
}

const prepared = new WeakMap<SearchIndex, Prepared>();

function prepare(index: SearchIndex): Prepared {
  const have = prepared.get(index);
  if (have) return have;
  // The topic finder's items, as findTopic (help/pages.ts) makes them.
  const items = index.topics.map(([tag, label, path]) => ({ id: tag, label, detail: tag, ...(path ? { path } : {}), command: "" }));
  const topics = new Map(index.topics.map(([tag, label, path, href]) => [tag, { tag, label, path, href }]));
  const texts = index.texts.map(([place, text]) => ({ tag: String(place), text, place }));
  const out = { items, topics, texts };
  prepared.set(index, out);
  return out;
}

/** `page.html#id` with `?hl=word` before the `#`. */
function marked(href: string, word: string): string {
  const [page = "", hash] = href.split("#", 2) as [string, string | undefined];
  return `${page}?hl=${encodeURIComponent(word)}${hash === undefined ? "" : `#${hash}`}`;
}

/** The topics and the text that match `query`, best first. */
export function searchDocs(index: SearchIndex, query: string): SearchResults {
  const terms = grepTerms(query);
  if (terms.length === 0) return { topics: [], texts: [] };
  const p = prepare(index);
  // Each place once: an alias (`sandbox`) and what it names go to the same spot.
  const seen = new Set<string>();
  const topics = searchItems(p.items, query)
    .map((i) => p.topics.get(i.id) as TopicResult)
    .filter((t) => !seen.has(t.href) && Boolean(seen.add(t.href)));
  const texts = grepTexts(p.texts, query).map(({ hit, label }) => {
    const [href, where] = index.places[hit.place] ?? ["index.html", ""];
    return { label, where, href: marked(href, terms[0] as string) };
  });
  return { topics, texts, terms };
}
