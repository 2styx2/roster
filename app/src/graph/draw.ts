// Drawing a graph's scene on a canvas (ticket 77). One canvas, not an SVG element per node: 2,000
// nodes and 10,000 edges are a few batched paths a frame, and a pan or zoom is one redraw. It draws
// only when something changed (no loop at rest), only what's on screen, and labels only where they
// don't overlap (the selected node's and its reach's first), so a big graph stays readable.
//
// Colours are the Theme's tokens, read from CSS: the accent only on what's live (taste.md), the
// second tone only on shapes (this Box's square, an unreviewed node's dashed ring), warn and error
// for marks, and greys for the rest.
import type { Highlight, Scene, SceneEdge, SceneNode } from "./scene";

export interface Camera {
  /** The world point at the canvas's centre, and the zoom (screen pixels per world unit). */
  x: number;
  y: number;
  k: number;
}

export interface Palette {
  bg: string;
  text: string;
  muted: string;
  faint: string;
  line: string;
  lineStrong: string;
  accent: string;
  tone: string;
  warn: string;
  error: string;
  raised: string;
  mono: string;
  ui: string;
  size: number;
}

/** The Theme's tokens as `el` sees them. */
export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const size = parseFloat(v("--text-xs", "13px")) || 13;
  return {
    bg: v("--bg", "#0f1011"),
    text: v("--text", "#e8e8ea"),
    muted: v("--muted", "#9a9ba0"),
    faint: v("--faint", "#55565b"),
    line: v("--line", "#26272b"),
    lineStrong: v("--line-strong", "#3a3b40"),
    accent: v("--accent", "#ff9a70"),
    tone: v("--tone", "#82ccd5"),
    warn: v("--warn", "#e9c944"),
    error: v("--error", "#e25a98"),
    raised: v("--raised", "#1d1e21"),
    mono: v("--font-mono", "monospace"),
    ui: v("--font-ui", "sans-serif"),
    size,
  };
}

export interface Frame {
  scene: Scene;
  camera: Camera;
  width: number;
  height: number;
  palette: Palette;
  selected: string | null;
  /** The selected node's reach, lit up; the rest dims. */
  highlight: Highlight | null;
  /** While searching: the nodes that match (the rest dims). */
  matches: ReadonlySet<string> | null;
  /** Edges being drawn in (index → 0..1). */
  drawing: ReadonlyMap<number, number>;
  /** The selected node is being moved from the keyboard (`m`): its ring is dashed. */
  moving?: boolean;
}

/** How big a node is on screen at zoom `k`. */
export const nodeRadius = (k: number) => Math.max(2.5, Math.min(6, 5 * Math.sqrt(k)));
/** A collapsed cluster's node. */
export const STAND_IN_RADIUS = 12;

export const toScreen = (c: Camera, w: number, h: number, x: number, y: number) => ({ x: (x - c.x) * c.k + w / 2, y: (y - c.y) * c.k + h / 2 });
export const toWorld = (c: Camera, w: number, h: number, sx: number, sy: number) => ({ x: (sx - w / 2) / c.k + c.x, y: (sy - h / 2) / c.k + c.y });

interface End {
  x: number;
  y: number;
  /** How far short of the point the line stops (a node's radius). */
  inset: number;
}

const DASHES: Record<SceneEdge["style"], number[]> = { solid: [], dashed: [5, 4], dotted: [1.5, 3] };

export function drawFrame(ctx: CanvasRenderingContext2D, f: Frame) {
  const { scene, camera: cam, width: w, height: h, palette: p } = f;
  ctx.save();
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, w, h);
  const r = nodeRadius(cam.k);
  const lit = f.highlight;
  const litEdges = new Set(lit?.edges ?? []);
  const dimmed = (id: string) => (lit !== null && !lit.nodes.has(id)) || (f.matches !== null && !f.matches.has(id));
  const margin = 40;
  const onScreen = (x: number, y: number, pad = 0) => x > -margin - pad && y > -margin - pad && x < w + margin + pad && y < h + margin + pad;
  const font = (px: number, weight = 500) => `${weight} ${px}px ${p.mono}`;

  // Where text is already drawn: the clusters' titles first, then the nodes' labels avoid them.
  const taken = new Boxes();
  const lh = p.size * 1.3;
  // Open clusters: a hairline circle, firmer when meshed, its title above. The title of the
  // selected node's cluster goes first, then the bigger clusters', so a small one gives way.
  const selCluster = f.selected ? scene.byId.get(f.selected)?.node?.cluster : undefined;
  const clusterOrder = [...scene.clusters].sort((a, b) => (a.id === selCluster ? -1 : b.id === selCluster ? 1 : b.r - a.r));
  const clusterAt = new Map<string, { x: number; y: number; r: number }>();
  // Open circles on screen: a title doesn't climb into the row above nor drop into the row below (a
  // circle whose centre is further up or down than either radius) by more than its own height, as
  // the line just above a circle may at a distance; a neighbour beside it in its own row may sit
  // under its ends.
  // In a grid of screen cells, so each look is a few circles, not all of them (500 clusters).
  const circles = new CircleGrid(w, h, margin);
  for (const c of clusterOrder) {
    if (c.collapsed) continue;
    const s = toScreen(cam, w, h, c.x, c.y);
    const cr = c.r * cam.k;
    if (onScreen(s.x, s.y, cr)) circles.add({ id: c.id, x: s.x, y: s.y, r: cr });
  }
  const overCircle = (own: { id: string; y: number; r: number }, x: number, y: number, bw: number, bh: number) =>
    circles.some(x, y, bw, bh, (o) => o.id !== own.id && Math.abs(o.y - own.y) > Math.max(o.r, own.r) && Math.hypot(o.x - Math.max(x, Math.min(o.x, x + bw)), o.y - Math.max(y, Math.min(o.y, y + bh))) < o.r - bh);
  for (const c of clusterOrder) {
    if (c.collapsed) continue;
    const s = toScreen(cam, w, h, c.x, c.y);
    const cr = c.r * cam.k;
    clusterAt.set(c.id, { x: s.x, y: s.y, r: cr });
    if (!onScreen(s.x, s.y, cr)) continue;
    const quiet = lit !== null && !scene.nodes.some((n) => n.node?.cluster === c.id && lit.nodes.has(n.id));
    ctx.globalAlpha = quiet ? 0.4 : 1;
    ctx.strokeStyle = c.mesh ? p.lineStrong : p.line;
    ctx.lineWidth = c.mesh ? 1.5 : 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, cr, 0, Math.PI * 2);
    ctx.stroke();
    if (cr > 18) {
      ctx.fillStyle = p.muted;
      ctx.font = font(p.size);
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      // Just above the circle; where a neighbour's title is in the way, just above that title (twice
      // at most), else just below the circle; never over another cluster's circle. Zoomed out, small clusters side by side have titles
      // far wider than their circles, and circles of other sizes put their lines at other heights,
      // so a fixed "a line higher" can land half over a bigger neighbour's (T99).
      const me = { id: c.id, y: s.y, r: cr };
      const freeAt = (tw: number): number | undefined => {
        const x = s.x - tw / 2 - 2;
        let top = s.y - cr - 4 - lh;
        for (let i = 0; i < 3; i++) {
          if (overCircle(me, x, top, tw + 4, lh)) break;
          const over = taken.highestHit(x, top, tw + 4, lh);
          if (over === null) return top;
          top = over - lh;
        }
        const below = s.y + cr + 4;
        return taken.highestHit(x, below, tw + 4, lh) === null && !overCircle(me, x, below, tw + 4, lh) ? below : undefined;
      };
      const title = fitTitle((t) => ctx.measureText(t).width, c.title, c.mesh === true, cr * 2, (tw) => freeAt(tw) !== undefined);
      const tw = ctx.measureText(title).width;
      const top = freeAt(tw) ?? s.y - cr - 4 - lh;
      taken.add(s.x - tw / 2 - 2, top, tw + 4, lh);
      ctx.fillText(title, s.x, top + lh);
    }
  }
  ctx.globalAlpha = 1;

  const nodeAt = new Map<string, { x: number; y: number; n: SceneNode }>();
  for (const n of scene.nodes) {
    const s = toScreen(cam, w, h, n.x, n.y);
    nodeAt.set(n.id, { ...s, n });
  }
  const end = (id: string, isCluster: boolean | undefined, toward: { x: number; y: number } | null): End | null => {
    if (isCluster) {
      const c = clusterAt.get(id);
      if (!c) return null;
      if (!toward) return { x: c.x, y: c.y, inset: 0 };
      const d = Math.hypot(toward.x - c.x, toward.y - c.y) || 1;
      return { x: c.x + ((toward.x - c.x) / d) * c.r, y: c.y + ((toward.y - c.y) / d) * c.r, inset: 0 };
    }
    const at = nodeAt.get(id);
    if (!at) return null;
    return { x: at.x, y: at.y, inset: (at.n.count !== undefined ? STAND_IN_RADIUS : r) + 2 };
  };

  // Edges, batched by look: the quiet ones first, the lit ones over them.
  type Seg = { a: End; b: End; e: SceneEdge; i: number };
  const batches = new Map<string, { color: string; width: number; dash: number[]; alpha: number; segs: Seg[] }>();
  const arrows: { seg: Seg; color: string; alpha: number }[] = [];
  const cuts: Seg[] = [];
  const counts: Seg[] = [];
  const marks: Seg[] = [];
  scene.edges.forEach((e, i) => {
    const ca = e.fromCluster ? null : nodeAt.get(e.from);
    const cb = e.toCluster ? null : nodeAt.get(e.to);
    const a0 = end(e.from, e.fromCluster, cb ?? null);
    const b0 = end(e.to, e.toCluster, ca ?? null);
    if (!a0 || !b0) return;
    const a = e.fromCluster ? end(e.from, true, b0) : a0;
    const b = e.toCluster ? end(e.to, true, a0) : b0;
    if (!a || !b) return;
    // Off screen: both ends past the same side.
    if ((a.x < -margin && b.x < -margin) || (a.y < -margin && b.y < -margin) || (a.x > w + margin && b.x > w + margin) || (a.y > h + margin && b.y > h + margin)) return;
    const on = litEdges.has(i);
    const quiet = (lit !== null && !on) || (f.matches !== null && !(f.matches.has(e.from) || f.matches.has(e.to)));
    // The selected node's own edges are the brightest; the rest of its reach a step quieter.
    const own = on && (e.from === f.selected || e.to === f.selected);
    const color = e.tone === "live" ? p.accent : e.tone === "warn" ? p.warn : e.tone === "error" ? p.error : own ? p.text : on ? p.muted : e.tone === "muted" ? p.faint : p.lineStrong;
    const width = own || e.tone === "live" ? 1.5 : 1;
    const alpha = quiet ? 0.18 : e.tone === "muted" ? 0.6 : 1;
    const key = `${color}|${width}|${e.style}|${alpha}|${on ? 1 : 0}`;
    const seg = { a, b, e, i };
    let batch = batches.get(key);
    if (!batch) batches.set(key, (batch = { color, width, dash: DASHES[e.style], alpha, segs: [] }));
    batch.segs.push(seg);
    if (on || cam.k >= 0.45) arrows.push({ seg, color, alpha });
    if (e.cut) cuts.push(seg);
    if ((e.count > 1 || e.mark) && cam.k >= 0.6) counts.push(seg);
    else if (e.mark) marks.push(seg);
  });
  const ordered = [...batches.values()].sort((x, y) => x.alpha - y.alpha || x.width - y.width);
  for (const b of ordered) {
    ctx.strokeStyle = b.color;
    ctx.lineWidth = b.width;
    ctx.globalAlpha = b.alpha;
    ctx.setLineDash(b.dash);
    ctx.beginPath();
    for (const s of b.segs) {
      const [x1, y1, x2, y2] = trimmed(s.a, s.b);
      const t = f.drawing.get(s.i);
      ctx.moveTo(x1, y1);
      ctx.lineTo(t === undefined ? x2 : x1 + (x2 - x1) * t, t === undefined ? y2 : y1 + (y2 - y1) * t);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const { seg, color, alpha } of arrows) {
    if (f.drawing.has(seg.i) && (f.drawing.get(seg.i) ?? 1) < 1) continue;
    const [x1, y1, x2, y2] = trimmed(seg.a, seg.b);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    arrowHead(ctx, x1, y1, x2, y2);
    if (seg.e.dir === "both") arrowHead(ctx, x2, y2, x1, y1);
  }
  // A cut pending: the edge broken in the middle by a small cross in the error colour.
  for (const s of cuts) {
    const [x1, y1, x2, y2] = trimmed(s.a, s.b);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.bg;
    ctx.beginPath();
    ctx.arc(mx, my, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = p.error;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mx - 3, my - 3);
    ctx.lineTo(mx + 3, my + 3);
    ctx.moveTo(mx + 3, my - 3);
    ctx.lineTo(mx - 3, my + 3);
    ctx.stroke();
  }
  // Zoomed out, a joined edge with a marked edge in it is a small node in the mark's colour.
  for (const s of marks) {
    const [x1, y1, x2, y2] = trimmed(s.a, s.b);
    ctx.globalAlpha = 1;
    ctx.fillStyle = s.e.mark === "error" ? p.error : p.warn;
    ctx.beginPath();
    ctx.arc((x1 + x2) / 2, (y1 + y2) / 2, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = font(p.size);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const s of counts) {
    const [x1, y1, x2, y2] = trimmed(s.a, s.b);
    const label = s.e.count > 1 ? `×${s.e.count}` : "•";
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const tw = ctx.measureText(label).width + 6;
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.bg;
    ctx.fillRect(mx - tw / 2, my - p.size * 0.6, tw, p.size * 1.2);
    // A joined edge with a marked one in it: its count in the mark's colour.
    ctx.fillStyle = s.e.mark === "error" ? p.error : s.e.mark === "warn" ? p.warn : p.muted;
    ctx.fillText(label, mx, my);
  }

  // Nodes: the shape says what it is (Q53), the accent that it's live, a slash that it's down.
  for (const { x, y, n } of nodeAt.values()) {
    if (!onScreen(x, y)) continue;
    ctx.globalAlpha = dimmed(n.id) ? 0.25 : 1;
    if (n.count !== undefined) standIn(ctx, x, y, n, p, font);
    else shape(ctx, x, y, r, n, p);
  }
  ctx.globalAlpha = 1;
  const sel = f.selected ? nodeAt.get(f.selected) : undefined;
  if (sel) {
    const rr = (sel.n.count !== undefined ? STAND_IN_RADIUS : r) + 4;
    ctx.strokeStyle = p.text;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(f.moving ? [3, 3] : []);
    ctx.beginPath();
    ctx.arc(sel.x, sel.y, f.moving ? rr + 2 : rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Labels where there's room: the selected node's, then its reach's and the matches, then live
  // nodes, then the rest, each skipped if it would cover one already drawn.
  const order = [...nodeAt.values()].filter((a) => onScreen(a.x, a.y, 0));
  // A collapsed cluster's title is as important as a lit node's: it names a whole group.
  const rank = (a: { n: SceneNode }) =>
    a.n.id === f.selected ? 0 : lit?.nodes.has(a.n.id) || f.matches?.has(a.n.id) || a.n.count !== undefined ? 1 : a.n.node?.state === "live" ? 2 : dimmed(a.n.id) ? 4 : 3;
  order.sort((a, b) => rank(a) - rank(b));
  ctx.font = font(p.size);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  let drawn = 0;
  for (const a of order) {
    if (drawn > 600) break;
    const isSel = a.n.id === f.selected;
    // A collapsed cluster's title names a whole group: it gets the room an open one's does.
    const text = clip(ctx, a.n.label, isSel ? 360 : a.n.count !== undefined ? TITLE_ROOM : 180);
    const tw = ctx.measureText(text).width;
    // A node's label is to its right; a collapsed cluster's under it, centred.
    const under = a.n.count !== undefined;
    const bx = under ? Math.max(2, Math.min(w - tw - 2, a.x - tw / 2)) : a.x + r + 5;
    const by = under ? a.y + STAND_IN_RADIUS + 3 : a.y - lh / 2;
    const ty = under ? by + lh / 2 : a.y;
    const extra = isSel ? [a.n.node?.detail, a.n.node?.note].filter(Boolean).join(" · ") : "";
    const bh = extra ? lh * 2 : lh;
    if (!isSel && taken.hits(bx - 2, by, tw + 4, bh)) continue;
    taken.add(bx - 2, by, tw + 4, bh);
    ctx.globalAlpha = dimmed(a.n.id) ? 0.35 : 1;
    ctx.fillStyle = isSel || lit?.nodes.has(a.n.id) ? p.text : p.muted;
    ctx.fillText(text, bx, ty);
    if (extra) {
      ctx.fillStyle = p.muted;
      ctx.fillText(clip(ctx, extra, 360), bx, ty + lh);
    }
    drawn++;
  }
  ctx.restore();
}

/** A line's ends, each pulled in by its node's radius. */
function trimmed(a: End, b: End): [number, number, number, number] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const ia = Math.min(a.inset, d / 2);
  const ib = Math.min(b.inset, d / 2);
  return [a.x + ux * ia, a.y + uy * ia, b.x - ux * ib, b.y - uy * ib];
}

function arrowHead(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const s = 6;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - s * Math.cos(a - 0.45), y2 - s * Math.sin(a - 0.45));
  ctx.lineTo(x2 - s * Math.cos(a + 0.45), y2 - s * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
}

function shape(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, n: SceneNode, p: Palette) {
  const g = n.node;
  if (!g) return;
  const live = g.state === "live";
  const down = g.state === "down";
  const ink = live ? p.accent : down ? p.faint : p.muted;
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5;
  switch (g.shape) {
    case "square": {
      const s = r * 1.6;
      ctx.fillStyle = down ? p.faint : p.tone;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
      if (live) {
        ctx.strokeStyle = p.accent;
        ctx.strokeRect(x - s / 2 - 2.5, y - s / 2 - 2.5, s + 5, s + 5);
      }
      break;
    }
    case "dot":
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "ring":
    case "hollow":
    case "dashed":
      ctx.fillStyle = p.bg;
      ctx.strokeStyle = g.shape === "dashed" ? (live ? p.accent : p.tone) : g.shape === "hollow" && !live ? p.faint : ink;
      ctx.lineWidth = g.shape === "hollow" ? 1 : 1.5;
      if (g.shape === "dashed") ctx.setLineDash([2.2, 2.2]);
      ctx.beginPath();
      ctx.arc(x, y, r - 0.75, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      break;
  }
  if (down) {
    // Down: crossed by a slash, so it isn't colour alone that says so.
    ctx.strokeStyle = p.muted;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x - r - 2, y + r + 2);
    ctx.lineTo(x + r + 2, y - r - 2);
    ctx.stroke();
  }
  if (g.mark) {
    ctx.fillStyle = g.mark === "warn" ? p.warn : p.error;
    ctx.beginPath();
    ctx.arc(x + r + 1, y - r - 1, 2.75, 0, Math.PI * 2);
    ctx.fill();
  }
}

function standIn(ctx: CanvasRenderingContext2D, x: number, y: number, n: SceneNode, p: Palette, font: (px: number, w?: number) => string) {
  ctx.fillStyle = p.raised;
  ctx.strokeStyle = p.lineStrong;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(x, y, STAND_IN_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = p.text;
  ctx.font = font(p.size - 2 < 11 ? 11 : p.size - 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const count = n.count ?? 0;
  ctx.fillText(count > 999 ? `${Math.floor(count / 1000)}k` : String(count), x, y + 0.5);
  // Live Sessions inside: a small node in the accent; a mark inside: one in its colour.
  const dot = (dx: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + dx, y - STAND_IN_RADIUS + 1, 3, 0, Math.PI * 2);
    ctx.fill();
  };
  if (n.live) dot(-STAND_IN_RADIUS + 2, p.accent);
  if (n.mark) dot(STAND_IN_RADIUS - 2, n.mark === "warn" ? p.warn : p.error);
}

/** `text` cut to `max` pixels with an ellipsis, never inside a character. */
function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  return clipBy((s) => ctx.measureText(s).width, text, max);
}

function clipBy(measure: (s: string) => number, text: string, max: number): string {
  if (measure(text) <= max) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${chars.slice(0, mid).join("")}…`) <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${chars.slice(0, lo).join("")}…`;
}

/** How wide a cluster's title may be past its circle, in screen pixels. */
const TITLE_ROOM = 320;

/**
 * An open cluster's title (T89): whole, with "· mesh" for a meshed one, when it fits in TITLE_ROOM
 * (or the circle, if that's wider) and `free` says it covers no title already drawn, even over a
 * small circle; else without "· mesh"; else cut to that room; else, where even that would cover
 * another, cut to the circle (at least 80 px), as it was before.
 */
export function fitTitle(measure: (s: string) => number, title: string, mesh: boolean, circle: number, free: (width: number) => boolean): string {
  const room = Math.max(circle, TITLE_ROOM);
  const tries = mesh ? [`${title} · mesh`, title] : [title];
  for (const t of tries) {
    const w = measure(t);
    if (w <= room && free(w)) return t;
  }
  const cut = clipBy(measure, title, room);
  if (free(measure(cut))) return cut;
  return clipBy(measure, title, Math.max(80, circle));
}

/** The app's strong ease-out, `cubic-bezier(0.23, 1, 0.32, 1)` (`--ease-out`), at `t` in 0..1. */
export function easeOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const [x1, y1, x2, y2] = [0.23, 1, 0.32, 1];
  const bez = (u: number, a: number, b: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bez(mid, x1, x2) < t) lo = mid;
    else hi = mid;
  }
  return bez((lo + hi) / 2, y1, y2);
}

/** Screen boxes already taken by labels, in cells of 64 px. */
interface ScreenCircle {
  id: string;
  x: number;
  y: number;
  r: number;
}

/** Circles on screen, by the 128 px cells their bounds cover (clipped to the screen and a margin). */
class CircleGrid {
  private readonly cells = new Map<number, ScreenCircle[]>();
  private static readonly CELL = 128;
  constructor(
    private readonly w: number,
    private readonly h: number,
    private readonly margin: number,
  ) {}
  private range(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    const C = CircleGrid.CELL;
    const m = this.margin;
    const cl = (v: number, hi: number) => Math.floor(Math.max(-m, Math.min(hi + m, v)) / C);
    return [cl(x0, this.w), cl(y0, this.h), cl(x1, this.w), cl(y1, this.h)];
  }
  add(c: ScreenCircle) {
    const [i0, j0, i1, j1] = this.range(c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = i * 100_003 + j;
        const list = this.cells.get(k);
        if (list) list.push(c);
        else this.cells.set(k, [c]);
      }
  }
  /** Whether a circle whose cells meet the box passes `test`. */
  some(x: number, y: number, w: number, h: number, test: (c: ScreenCircle) => boolean): boolean {
    const [i0, j0, i1, j1] = this.range(x, y, x + w, y + h);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const c of this.cells.get(i * 100_003 + j) ?? []) if (test(c)) return true;
    return false;
  }
}

class Boxes {
  private readonly cells = new Map<number, [number, number, number, number][]>();
  private keys(x: number, y: number, w: number, h: number): number[] {
    const out: number[] = [];
    for (let i = Math.floor(x / 64); i <= Math.floor((x + w) / 64); i++) for (let j = Math.floor(y / 64); j <= Math.floor((y + h) / 64); j++) out.push(i * 100_003 + j);
    return out;
  }
  hits(x: number, y: number, w: number, h: number): boolean {
    return this.highestHit(x, y, w, h) !== null;
  }
  /** The top of the highest box this one would cover, or null when it covers none. */
  highestHit(x: number, y: number, w: number, h: number): number | null {
    let top: number | null = null;
    for (const k of this.keys(x, y, w, h))
      for (const [bx, by, bw, bh] of this.cells.get(k) ?? []) if (x < bx + bw && bx < x + w && y < by + bh && by < y + h && (top === null || by < top)) top = by;
    return top;
  }
  add(x: number, y: number, w: number, h: number) {
    for (const k of this.keys(x, y, w, h)) {
      const list = this.cells.get(k);
      if (list) list.push([x, y, w, h]);
      else this.cells.set(k, [[x, y, w, h]]);
    }
  }
}
