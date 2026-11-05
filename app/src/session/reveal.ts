// Where a key question's card scrolls to when focus moves inside it (round 21). The card has a
// pinned title and a pinned footer, each with a 22 px fade; whatever focus lands on must sit whole
// between the two fades, and no line of text may be cut by the title's rule or the footer's top
// edge. Round 20's version read the pin from the sticky title's `offsetTop`, which a stuck title
// reports as the scroll itself, so a blocked Enter from the password field (scrolled to the
// bottom) never scrolled back up: "I've checked this key" stayed under the title.

/** A vertical span, in viewport pixels at the card's current scroll. */
export interface Span {
  top: number;
  bottom: number;
}

export interface RevealGeometry {
  /** The card's scroll now, and the most it can scroll. */
  scrollTop: number;
  maxScroll: number;
  /** The title's rule (its bottom) and the footer's top edge. */
  titleBottom: number;
  footerTop: number;
  /** The fade under the title and over the footer (FADE_PX). */
  fade: number;
  /** What must be whole in view (Quick Connect's box row, or the focused control). */
  target: Span;
  /** Shown too if both fit (the fingerprint above the box); the target wins if they don't. */
  also?: Span | null;
  /** Every line of text, and every field, in the scrolling body: none may straddle an edge. */
  lines: Span[];
  /** How far the card scrolls before the title pins (the map above it in a tall window): a
   * scroll between 0 and this would let the title creep, so it's never chosen. */
  pin: number;
}

const EPS = 0.5;
/** How far a line's glyph box may reach past an edge and still count as whole: the top and bottom
 * 1.5 px of an Inter or Iosevka glyph box at these sizes is the font's own leading, no ink. The
 * choice keeps 0.5 px in hand, since the card's sub-pixel offset moves lines by up to that much
 * from one scroll to the next. */
const SLIVER = 1;

/** How many lines straddle `edge` (the title's rule or the footer's top) at scroll `s`. */
function straddles(g: RevealGeometry, s: number, edge: number): number {
  const d = s - g.scrollTop;
  let n = 0;
  for (const l of g.lines)
    if (l.top - d < edge - SLIVER && l.bottom - d > edge + SLIVER) n++;
  return n;
}

/** Whether `span` sits whole between the two fades at scroll `s`. Each fade shows only while
 * there's text to fade (Q237 c): the title's once the card has scrolled, the footer's while more
 * lies below. */
function clear(g: RevealGeometry, span: Span, s: number, max: number): boolean {
  const d = s - g.scrollTop;
  return (
    span.top - d >= g.titleBottom + (s > 0 ? g.fade : 0) - EPS &&
    span.bottom - d <= g.footerTop - (s < max ? g.fade : 0) + EPS
  );
}

/** The scroll (whole pixels) that puts the target whole between the fades, moving as little as
 * it can. Among those, in order: no line cut by the title's rule (a sentence sliced under the
 * title was what round 20's reviewers saw), none cut by the footer's edge, the `also` span's top
 * in view too. When the target can't fit between the fades at all, its top goes just under the
 * title's fade. */
export function revealTop(g: RevealGeometry): number {
  const max = Math.max(0, Math.floor(g.maxScroll));
  const now = Math.round(g.scrollTop);
  const alsoTop = g.also ? { top: g.also.top, bottom: g.also.top } : null;
  let best: number | null = null;
  let bestScore: number[] = [];
  for (let s = 0; s <= max; s++) {
    if (s > 0 && s < g.pin) continue;
    if (!clear(g, g.target, s, max)) continue;
    const score = [
      straddles(g, s, g.titleBottom),
      straddles(g, s, g.footerTop),
      alsoTop === null || clear(g, alsoTop, s, max) ? 0 : 1,
      Math.abs(s - now),
    ];
    if (best === null || lexLess(score, bestScore)) {
      best = s;
      bestScore = score;
    }
  }
  if (best !== null) return best;
  const d = g.target.top - (g.titleBottom + g.fade);
  return Math.min(max, Math.max(0, Math.round(now + d)));
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** Reads the card's geometry and scrolls it so `target` (and `also`, when both fit) is in view,
 * clear of the pinned title, footer and their fades, with no line cut at either edge. */
export function revealInCard(
  card: HTMLElement,
  target: Element,
  also: Element | null,
  fade: number,
): void {
  const box = card.getBoundingClientRect();
  const title = card.querySelector<HTMLElement>(".connect-title");
  const footer = card.querySelector<HTMLElement>(".key-actions");
  const pinned = (n: Node) =>
    (title?.contains(n) ?? false) || (footer?.contains(n) ?? false);
  const lines: Span[] = [];
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent?.trim() || pinned(n)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    // jsdom has no layout: no line boxes to keep whole.
    const rects =
      typeof range.getClientRects === "function" ? range.getClientRects() : [];
    for (const r of Array.from(rects))
      if (r.height >= 2) lines.push({ top: r.top, bottom: r.bottom });
  }
  for (const field of Array.from(card.querySelectorAll("input"))) {
    if (pinned(field)) continue;
    const r = field.getBoundingClientRect();
    if (r.height >= 2) lines.push({ top: r.top, bottom: r.bottom });
  }
  // Where the title sits before it pins: under whatever is above it (the map), and the gap.
  const before = title?.previousElementSibling;
  const shown = before ? before.getBoundingClientRect() : null;
  const pin =
    shown && shown.height > 0
      ? Math.max(
          0,
          shown.bottom -
            box.top -
            card.clientTop +
            card.scrollTop +
            (parseFloat(getComputedStyle(card).rowGap) || 0),
        )
      : 0;
  const span = (el: Element): Span => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  };
  const next = revealTop({
    scrollTop: card.scrollTop,
    maxScroll: card.scrollHeight - card.clientHeight,
    titleBottom: title?.getBoundingClientRect().bottom ?? box.top,
    footerTop: footer?.getBoundingClientRect().top ?? box.bottom,
    fade,
    target: span(target),
    also: also ? span(also) : null,
    lines,
    pin,
  });
  if (next !== card.scrollTop) card.scrollTop = next;
}
