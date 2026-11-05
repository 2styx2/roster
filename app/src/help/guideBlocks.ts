// A guide's Markdown as help blocks, and the topics on any page's blocks. Pure, and free of the
// app's registries, so the build reads it too: scripts/help-plugin.mjs runs it over every guide to
// write the tag table startup finds the guides' topics in before their text loads (T213, Q189).
import { plain, slug, type Block, type Inline } from "./doc";
import { guideLink, type Guide } from "./guides";
import { parseMarkdown, withoutDevNotes } from "./markdown";

export interface Topic {
  /** What `:help` takes: `options`, `terminal.size`, `config#the-sandbox`. */
  tag: string;
  page: string;
  /** The entry or heading on the page; none for the page itself. */
  anchor?: string;
  /** What the topic finder shows. */
  label: string;
  /** The page's title, for an entry on it. */
  path?: string;
  /** What in `path` is code (`roster sync`): set in Iosevka there (round 19, the paste rule). */
  codes?: string[];
  /** A page, a heading on one, an entry (an option, a command, an error…), or another name. */
  kind: "page" | "heading" | "entry" | "alias";
}

/** A topic on a page, without the page: what the tag table holds for each guide. */
export type PageTag = Omit<Topic, "page">;

/** A heading's topic: its anchor, which a page may write whole (`commands#hosts`) or as a slug. */
export const headingTag = (page: string, anchor: string): string => (anchor.includes("#") ? anchor : `${page}#${anchor}`);

/** `s` cut to at most `max` characters, ending with an ellipsis when it was cut. */
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** The topics on a page's blocks, in page order: each heading below the title, and each entry. */
/** The code spans in `inlines`, in order. */
function codesIn(inlines: readonly Inline[]): string[] {
  return inlines.flatMap((i) => (i.t === "code" ? [i.text] : i.t === "strong" || i.t === "em" || i.t === "link" ? codesIn(i.children) : []));
}

/** What the topic finder titles an entry: its tag when that's a name people type (`E31`,
 * `keys.picker`, `:connect`), else what the entry says it is (its term, a table row's first cell),
 * never a page-local slug (`deprecated#a-removal-of-…`, round 19). */
function entryLabel(anchor: string, said: string): string {
  return anchor.includes("#") && said.trim() ? said.replace(/\s+/g, " ").trim() : anchor;
}

export function blockTags(page: string, title: string, blocks: readonly Block[]): PageTag[] {
  const out: PageTag[] = [];
  for (const b of blocks) {
    if (b.t === "h" && b.level > 1) {
      const tag = headingTag(page, b.anchor);
      out.push({ tag, anchor: tag, label: plain(b.text), path: title, kind: "heading" });
    } else if (b.t === "defs") {
      for (const d of b.items) {
        if (!d.anchor) continue;
        const path = clip(plain(d.body), 80);
        const codes = path ? codesIn(d.body) : [];
        out.push({ tag: d.anchor, anchor: d.anchor, label: entryLabel(d.anchor, plain(d.term)), path: path || title, ...(codes.length ? { codes } : {}), kind: "entry" });
      }
    } else if (b.t === "table" && b.anchors) {
      b.anchors.forEach((a, i) => {
        if (a) out.push({ tag: a, anchor: a, label: entryLabel(a, plain(b.rows[i]?.[0] ?? [])), path: title, kind: "entry" });
      });
    }
  }
  return out;
}

/** A guide's inlines with its links made help links (guideLink). */
function fixLinks(guide: Guide, inlines: readonly Inline[]): Inline[] {
  return inlines.map((i): Inline => {
    if (i.t === "link") return { ...i, href: guideLink(guide, i.href), children: fixLinks(guide, i.children) };
    if (i.t === "strong" || i.t === "em") return { ...i, children: fixLinks(guide, i.children) };
    return i;
  });
}

/** A guide's blocks: its notes for developers left out, its anchors made topics
 * (`config#the-sandbox`) and its links help links (guideLink). */
export function guideBlocks(guide: Guide, markdown: string): Block[] {
  const fix = (inlines: Inline[]) => fixLinks(guide, inlines);
  return parseMarkdown(withoutDevNotes(markdown)).map((b): Block => {
    switch (b.t) {
      case "h":
        return { ...b, text: fix(b.text), anchor: `${guide.id}#${b.anchor}` };
      case "p":
      case "quote":
        return { ...b, text: fix(b.text) };
      case "list":
        return { ...b, items: b.items.map(fix) };
      case "table": {
        const anchors = guide.rowTopics ? b.rows.map((r) => (slug(plain(r[0] ?? [])) ? `${guide.id}#${slug(plain(r[0] ?? []))}` : undefined)) : undefined;
        return { ...b, head: b.head.map(fix), rows: b.rows.map((r) => r.map(fix)), ...(anchors ? { anchors } : {}) };
      }
      default:
        return b;
    }
  });
}
