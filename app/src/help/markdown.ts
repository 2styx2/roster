// The Markdown that docs/app is written in, read into help blocks (doc.ts), so the guides render
// in the app's own type instead of as HTML. Only what those files use: headings, paragraphs,
// lists, tables, fenced code, quotes, and inline code, bold, italics and links (a line that is an
// HTML comment is left out). Anything else stays as its text, never as markup.
import { slug, type Block, type Inline } from "./doc";

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const anchors = new Map<string, number>();
  const anchorFor = (title: string) => {
    const base = slug(title);
    const n = (anchors.get(base) ?? 0) + 1;
    anchors.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
  let i = 0;
  const at = (k: number) => lines[k] ?? "";
  const blank = (s: string) => s.trim() === "";
  const comment = (s: string) => /^\s*<!--.*-->\s*$/.test(s);
  // A table starts at a pipe row only when a separator row (|---|) follows it.
  const tableAt = (k: number) => at(k).trimStart().startsWith("|") && /^\s*\|?\s*:?-+/.test(at(k + 1));

  while (i < lines.length) {
    const line = at(i);
    if (blank(line)) {
      i++;
      continue;
    }
    // An HTML comment on a line of its own (serve-api.md's generated-table markers) isn't shown,
    // as on GitHub.
    if (comment(line)) {
      i++;
      continue;
    }
    const fence = /^(\s*)(```+|~~~+)\s*([\w-]*)/.exec(line);
    if (fence) {
      const close = fence[2] as string;
      const body: string[] = [];
      i++;
      while (i < lines.length && !at(i).trim().startsWith(close)) body.push(at(i++));
      i++;
      blocks.push({ t: "pre", text: body.join("\n"), ...(fence[3] ? { lang: fence[3] } : {}) });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const title = heading[2] as string;
      blocks.push({ t: "h", level: (heading[1] as string).length as 1 | 2 | 3 | 4, text: inline(title), anchor: anchorFor(title) });
      i++;
      continue;
    }
    if (tableAt(i)) {
      const head = cells(line);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && at(i).trimStart().startsWith("|")) rows.push(cells(at(i++)));
      blocks.push({ t: "table", head, rows });
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && at(i).startsWith(">")) body.push(at(i++).replace(/^>\s?/, ""));
      blocks.push({ t: "quote", text: inline(body.join(" ")) });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+/;
    const first = item.exec(line);
    if (first) {
      const ordered = /\d/.test(first[2] as string);
      const items: string[] = [];
      while (i < lines.length) {
        const l = at(i);
        const m = item.exec(l);
        if (m && /\d/.test(m[2] as string) === ordered && (m[1] as string).length <= (first[1] as string).length) {
          items.push(l.slice(m[0].length));
        } else if (!blank(l) && /^\s+/.test(l) && items.length) {
          // A line run on from the item, or a nested item: kept as part of it.
          items[items.length - 1] += ` ${l.trim().replace(item, "")}`;
        } else break;
        i++;
      }
      blocks.push({ t: "list", ordered, items: items.map((s) => inline(s.trim())) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = at(i);
      // The first line always belongs to the paragraph, so the parser always moves on.
      if (para.length && (blank(l) || comment(l) || /^(#{1,4}\s|\s*```|\s*~~~|>)/.test(l) || tableAt(i) || item.test(l))) break;
      para.push(l.trim());
      i++;
    }
    blocks.push({ t: "p", text: inline(para.join(" ")) });
  }
  return blocks;
}

/** A table row's cells, split on pipes that aren't escaped or inside code. */
function cells(row: string): Inline[][] {
  const s = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let cur = "";
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k] as string;
    if (c === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (c === "`") {
      inCode = !inCode;
      cur += c;
    } else if (c === "|" && !inCode) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((c) => inline(c.trim()));
}

/** Inline Markdown: `code`, **bold**, *em* / _em_, [text](href), ![alt](src) (as a link). */
export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", text: buf });
    buf = "";
  };
  let k = 0;
  while (k < s.length) {
    const c = s[k] as string;
    if (c === "\\" && k + 1 < s.length && /[\\`*_[\]()#|>-]/.test(s[k + 1] as string)) {
      buf += s[k + 1];
      k += 2;
      continue;
    }
    if (c === "`") {
      const ticks = /^`+/.exec(s.slice(k))?.[0] ?? "`";
      const end = s.indexOf(ticks, k + ticks.length);
      if (end > 0) {
        flush();
        out.push({ t: "code", text: s.slice(k + ticks.length, end).replace(/\\\|/g, "|").trim() || " " });
        k = end + ticks.length;
        continue;
      }
    }
    if (s.startsWith("**", k)) {
      const end = s.indexOf("**", k + 2);
      if (end > k + 2) {
        flush();
        out.push({ t: "strong", children: inline(s.slice(k + 2, end)) });
        k = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && /\S/.test(s[k + 1] ?? " ") && (k === 0 || /[\s(]/.test(s[k - 1] as string))) {
      const end = s.indexOf(c, k + 1);
      if (end > k + 1 && /\S/.test(s[end - 1] as string) && !/\w/.test(s[end + 1] ?? " ")) {
        flush();
        out.push({ t: "em", children: inline(s.slice(k + 1, end)) });
        k = end + 1;
        continue;
      }
    }
    // An image: help and the website show none, so it's a link to it, named by its alt text,
    // else its file's name (an empty name is no link at all to a screen reader).
    if (c === "!" && s[k + 1] === "[") {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(s.slice(k));
      if (m) {
        flush();
        const href = m[2] as string;
        out.push({ t: "link", href, children: inline((m[1] as string).trim() || (href.split("/").pop() as string)) });
        k += m[0].length;
        continue;
      }
    }
    if (c === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(s.slice(k));
      if (m) {
        flush();
        out.push({ t: "link", href: m[2] as string, children: inline(m[1] as string) });
        k += m[0].length;
        continue;
      }
    }
    buf += c;
    k++;
  }
  flush();
  return out;
}

/** One note for the people building roster: a ticket, a decision, an ADR or an issue. */
const DEV_REF =
  /^(?:see |amends |from )?(?:tickets? \d+(?:(?:, | and |-)\d+)*|decisions? Q\d+(?:(?:, | and )Q\d+)*|Q\d+|ADR \d{4}|issues? #\d+|#\d+|T\d+)$/i;

/** The guides without their notes for developers: a parenthetical that only names tickets,
 * decisions (`Q58`), ADRs or issues goes, and one that mixes them with words keeps the words
 * (`(rows 60-63, ticket 36)` → `(rows 60-63)`). Headings, code and fenced code are left alone,
 * so anchors stay GitHub's; docs/app/decisions.md is where the history lives. */
export function withoutDevNotes(source: string): string {
  let fenced = false;
  return source
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced || /^\s*(```|~~~)/.test(line) || /^#{1,4}\s/.test(line)) return line;
      // Code spans are kept whole: split them out, strip the rest, put them back.
      return line
        .split(/(`[^`]*`)/)
        .map((part, k) => (k % 2 ? part : part.replace(/ ?\(([^()]*)\)/g, (whole, inner: string) => dropRefs(whole, inner))))
        .join("");
    })
    .join("\n");
}

function dropRefs(whole: string, inner: string): string {
  const parts = inner.split(/([;,]\s*)/);
  const kept: string[] = [];
  for (let k = 0; k < parts.length; k += 2) {
    const part = (parts[k] as string).trim();
    if (!DEV_REF.test(part)) kept.push(part);
  }
  if (kept.length === parts.length / 2 + 0.5) return whole;
  if (kept.length === 0) return "";
  const sep = parts[1]?.startsWith(";") && kept.length > 1 ? "; " : ", ";
  return `${whole.startsWith(" ") ? " " : ""}(${kept.join(sep)})`;
}
