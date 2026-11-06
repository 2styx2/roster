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
  /** What must be whole in view (Quick Connect's box row, or the focused control); null when
   * focus went to the pinned title or footer, which are always in view: then the card only
   * settles where no line is cut (round 23). */
  target: Span | null;
  /** Shown too if both fit (the fingerprint above the box); the target wins if they don't. */
  also?: Span | null;
  /** Every line of text, and every field, in the scrolling body: none may straddle an edge. */
  lines: Span[];
  /** How far the card scrolls before the title pins (the map above it in a tall window): a
   * scroll between 0 and this would let the title creep, so it's never chosen. */
  pin: number;
}

const EPS = 0.5;
/** How far a line's glyph box may reach past an edge and still count as whole: none (round 22:
 * round 21 let a glyph box reach 1 px past, and at 480×320 Quick Connect's first sentence opened
 * 1 px under the title's rule, which reviewers read as a cut line; one more pixel of scroll put
 * it wholly under). Whole-pixel scrolls move every line by whole pixels, so the edge and a line
 * keep the same fraction: 0.05 px only absorbs float noise. */
const SLIVER = 0.05;

/** How many lines straddle `edge` (the title's rule or the footer's top) at scroll `s`. */
function straddles(g: RevealGeometry, s: number, edge: number): number {
  const d = s - g.scrollTop;
  let n = 0;
  for (const l of g.lines)
    if (l.top - d < edge - SLIVER && l.bottom - d > edge + SLIVER) n++;
  return n;
}

/** Whether any line reaches past the footer's top edge: text below it, which the footer's fade
 * says is there (round 23: the fade showed over 7 px of padding at 480×320 Quick Connect, so the
 * focused "Save to vault" could only be clear of it at a scroll that cut "Password for root" at
 * the title). */
export function moreBelow(lines: readonly Span[], footerTop: number): boolean {
  return lines.some((l) => l.bottom > footerTop + SLIVER);
}

/** Whether the footer's fade is drawn at scroll `s`: while text lies below it (or, with no lines
 * measured, while the card can scroll further). */
function footFade(g: RevealGeometry, s: number, max: number): boolean {
  if (g.lines.length === 0) return s < max;
  const d = s - g.scrollTop;
  return moreBelow(g.lines, g.footerTop + d);
}

/** Whether `span` sits whole between the two fades at scroll `s`. Each fade shows only while
 * there's text to fade (Q247 c): the title's once the card has scrolled, the footer's while text
 * lies below it. */
function clear(g: RevealGeometry, span: Span, s: number, max: number): boolean {
  const d = s - g.scrollTop;
  return (
    span.top - d >= g.titleBottom + (s > 0 ? g.fade : 0) - EPS &&
    span.bottom - d <= g.footerTop - (footFade(g, s, max) ? g.fade : 0) + EPS
  );
}

/** How many whole pixels of `span` sit between the two fades at scroll `s`. */
function shown(g: RevealGeometry, span: Span | null, s: number, max: number): number {
  if (span === null) return 0;
  const d = s - g.scrollTop;
  const top = Math.max(span.top - d, g.titleBottom + (s > 0 ? g.fade : 0));
  const bottom = Math.min(span.bottom - d, g.footerTop - (footFade(g, s, max) ? g.fade : 0));
  return Math.max(0, Math.floor(bottom - top));
}

/** The scroll (whole pixels) that puts the target whole between the fades, moving as little as
 * it can. Among those, in order: no line cut by the title's rule (a sentence sliced under the
 * title was what round 20's reviewers saw), none cut by the footer's edge, the `also` span's top
 * in view too, then as much of `also` as can show (round 22: with no line allowed past an edge,
 * a blocked Enter from the password field stopped at the nearest clean scroll, the fingerprint
 * under the title, while one from the top showed it; the most of the key wins, so every way in
 * lands on the same scroll). When the target can't fit between the fades at all, its top goes
 * just under the title's fade. */
export function revealTop(g: RevealGeometry): number {
  const best = revealScroll(g);
  if (best !== null) return best;
  const now = Math.round(g.scrollTop);
  if (g.target === null) return now;
  const max = Math.max(0, Math.floor(g.maxScroll));
  const d = g.target.top - (g.titleBottom + g.fade);
  return Math.min(max, Math.max(0, Math.round(now + d)));
}

/** revealTop's choice, or null when no scroll puts the target whole between the fades. */
export function revealScroll(g: RevealGeometry): number | null {
  const max = Math.max(0, Math.floor(g.maxScroll));
  const now = Math.round(g.scrollTop);
  const alsoTop = g.also ? { top: g.also.top, bottom: g.also.top } : null;
  let best: number | null = null;
  let bestScore: number[] = [];
  for (let s = 0; s <= max; s++) {
    if (s > 0 && s < g.pin) continue;
    if (g.target !== null && !clear(g, g.target, s, max)) continue;
    const score = [
      straddles(g, s, g.titleBottom),
      straddles(g, s, g.footerTop),
      alsoTop === null || clear(g, alsoTop, s, max) ? 0 : 1,
      -shown(g, g.also ?? null, s, max),
      Math.abs(s - now),
    ];
    if (best === null || lexLess(score, bestScore)) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** Every line of text, and every field, in the card's scrolling body (not its pinned title or
 * footer), in viewport pixels. jsdom has no layout: none there. */
export function cardLines(card: HTMLElement): Span[] {
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
  return lines;
}

/** Whether text lies below the card's pinned footer, so its fade is drawn. */
export function cardMoreBelow(card: HTMLElement): boolean {
  const footer = card.querySelector<HTMLElement>(".key-actions");
  const lines = cardLines(card);
  if (!footer || lines.length === 0)
    return card.scrollTop + card.clientHeight < card.scrollHeight - 1;
  return moreBelow(lines, footer.getBoundingClientRect().top);
}

/** Reads the card's geometry and scrolls it so `target` (and `also`, when both fit) is in view,
 * clear of the pinned title, footer and their fades, with no line cut at either edge. `block`,
 * when given, is tried first: the elements read as one span (a field with its label and the note
 * under it, round 23), revealed whole when they fit. A null target (focus went to the pinned title
 * or footer) only settles the card where no line is cut. */
export function revealInCard(
  card: HTMLElement,
  target: Element | null,
  also: Element | null,
  fade: number,
  block?: readonly Element[],
): void {
  const box = card.getBoundingClientRect();
  const title = card.querySelector<HTMLElement>(".connect-title");
  const footer = card.querySelector<HTMLElement>(".key-actions");
  const lines = cardLines(card);
  // Where the title sits before it pins: under whatever is above it (the map), and the gap.
  const before = title?.previousElementSibling;
  const shownBefore = before ? before.getBoundingClientRect() : null;
  const pin =
    shownBefore && shownBefore.height > 0
      ? Math.max(
          0,
          shownBefore.bottom -
            box.top -
            card.clientTop +
            card.scrollTop +
            (parseFloat(getComputedStyle(card).rowGap) || 0),
        )
      : 0;
  const span = (els: readonly Element[]): Span => {
    const rects = els.map((el) => el.getBoundingClientRect());
    return {
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
  };
  const geometry = (t: readonly Element[] | null): RevealGeometry => ({
    scrollTop: card.scrollTop,
    maxScroll: card.scrollHeight - card.clientHeight,
    titleBottom: title?.getBoundingClientRect().bottom ?? box.top,
    footerTop: footer?.getBoundingClientRect().top ?? box.bottom,
    fade,
    target: t === null ? null : span(t),
    also: also ? span([also]) : null,
    lines,
    pin,
  });
  const whole = block?.length ? revealScroll(geometry(block)) : null;
  const next = whole ?? revealTop(geometry(target ? [target] : null));
  if (next !== card.scrollTop) card.scrollTop = next;
}
