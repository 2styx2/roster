// What the graph view draws (ticket 77): the graph after its collapsed clusters are folded into one
// node each, with its edges joined; and what the keys do with it: move to the nearest node one
// way, search, and light up a selected node's reach. Pure, so it's tested without a canvas.
import type { Circle, Layout } from "./layout";
import { reachOf, type Reach, type EdgeDir, type EdgeStyle, type EdgeTone, type GraphData, type GraphEdge, type GraphIndex, type GraphNode, type Mark } from "./model";

/** A node as drawn: a node, or a collapsed cluster standing for its nodes. */
export interface SceneNode {
  id: string;
  x: number;
  y: number;
  label: string;
  node?: GraphNode;
  /** A collapsed cluster: how many nodes it stands for, how many of them are live, and the
   * worst mark among them. */
  count?: number;
  live?: number;
  mark?: Mark;
}

export interface SceneEdge {
  /** Scene node ids, or an open cluster's id (with `fromCluster`/`toCluster`). */
  from: string;
  to: string;
  fromCluster?: true;
  toCluster?: true;
  dir: EdgeDir;
  style: EdgeStyle;
  tone?: EdgeTone;
  cut?: true;
  /** How many edges it stands for. */
  count: number;
  /** Joined edges: the worst mark among them (the edge itself keeps a tone only all of them share). */
  mark?: Mark;
  edges: GraphEdge[];
}

export interface SceneCluster extends Circle {
  id: string;
  title: string;
  mesh: boolean;
  count: number;
  collapsed: boolean;
}

export interface Scene {
  nodes: SceneNode[];
  byId: Map<string, SceneNode>;
  edges: SceneEdge[];
  /** Open clusters' circles and collapsed ones (drawn as their node). */
  clusters: SceneCluster[];
  /** Where each graph node is drawn: itself or its collapsed cluster. */
  shownAs: Map<string, string>;
}

/** Above this many nodes, clusters the Plugin says nothing about start collapsed. */
export const AUTO_COLLAPSE = 300;

/** The collapsed clusters: the user's choice (`folds`), else the Plugin's, else by size. */
export function foldsFor(g: GraphData, folds: Readonly<Record<string, boolean>>): Set<string> {
  const big = g.nodes.length > AUTO_COLLAPSE;
  return new Set(g.clusters.filter((c) => folds[c.id] ?? c.collapsed ?? big).map((c) => c.id));
}

const worseMark = (a: Mark | undefined, b: Mark | undefined): Mark | undefined => (a === "error" || b === "error" ? "error" : (a ?? b));
const markOf = (t: EdgeTone | undefined): Mark | undefined => (t === "warn" || t === "error" ? t : undefined);

export function buildScene(g: GraphData, layout: Layout, collapsed: ReadonlySet<string>): Scene {
  const clusterOf = new Map(g.clusters.map((c) => [c.id, c]));
  const counts = new Map<string, number>();
  for (const n of g.nodes) if (n.cluster !== undefined && clusterOf.has(n.cluster)) counts.set(n.cluster, (counts.get(n.cluster) ?? 0) + 1);
  const clusters: SceneCluster[] = [];
  for (const c of g.clusters) {
    const circle = layout.clusters.get(c.id);
    if (!circle) continue;
    clusters.push({ ...circle, id: c.id, title: c.title, mesh: c.mesh === true, count: counts.get(c.id) ?? 0, collapsed: collapsed.has(c.id) });
  }
  const nodes: SceneNode[] = [];
  const shownAs = new Map<string, string>();
  const standIns = new Set<string>();
  const inside = new Map<string, { live: number; mark?: Mark }>();
  for (const n of g.nodes) {
    if (n.cluster === undefined || !collapsed.has(n.cluster)) continue;
    const t = inside.get(n.cluster) ?? { live: 0 };
    if (n.state === "live") t.live++;
    const mark = worseMark(t.mark, n.mark);
    if (mark) t.mark = mark;
    inside.set(n.cluster, t);
  }
  for (const n of g.nodes) {
    const p = layout.nodes.get(n.id);
    if (!p) continue;
    const c = n.cluster !== undefined && clusterOf.has(n.cluster) ? n.cluster : undefined;
    if (c !== undefined && collapsed.has(c)) {
      shownAs.set(n.id, c);
      if (!standIns.has(c)) {
        standIns.add(c);
        const circle = layout.clusters.get(c);
        const t = inside.get(c);
        nodes.push({ id: c, x: circle?.x ?? p.x, y: circle?.y ?? p.y, label: clusterOf.get(c)?.title ?? c, count: counts.get(c) ?? 0, ...(t?.live ? { live: t.live } : {}), ...(t?.mark ? { mark: t.mark } : {}) });
      }
      continue;
    }
    shownAs.set(n.id, n.id);
    nodes.push({ id: n.id, x: p.x, y: p.y, label: n.label, node: n });
  }
  // A collapsed cluster with no node in it still shows, as 0.
  for (const c of clusters)
    if (c.collapsed && !standIns.has(c.id)) {
      standIns.add(c.id);
      nodes.push({ id: c.id, x: c.x, y: c.y, label: c.title, count: 0 });
    }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  /** Where an edge's end is drawn. */
  const end = (id: string): { id: string; cluster?: true } | null => {
    const s = shownAs.get(id);
    if (s !== undefined) return { id: s };
    if (!clusterOf.has(id) || !layout.clusters.has(id)) return null;
    return collapsed.has(id) ? { id } : { id, cluster: true };
  };
  const edges: SceneEdge[] = [];
  const joined = new Map<string, SceneEdge>();
  for (const e of g.edges) {
    const a = end(e.from);
    const b = end(e.to);
    if (!a || !b || a.id === b.id) continue;
    // A two-way edge is the same either way round.
    const [p, q] = e.dir === "both" && b.id < a.id ? [b, a] : [a, b];
    const key = `${p.cluster ? "c" : "n"}${p.id}\u0000${q.cluster ? "c" : "n"}${q.id}\u0000${e.dir}`;
    const had = joined.get(key);
    if (had) {
      had.count++;
      had.edges.push(e);
      // A joined edge is live, marked or cut only if every edge in it is; else it says so with a mark.
      if (had.tone !== e.tone) delete had.tone;
      if (had.cut && !e.cut) delete had.cut;
      const mark = worseMark(had.mark, e.cut ? "error" : markOf(e.tone));
      if (mark) had.mark = mark;
      continue;
    }
    const se: SceneEdge = {
      from: p.id,
      to: q.id,
      ...(p.cluster ? { fromCluster: true as const } : {}),
      ...(q.cluster ? { toCluster: true as const } : {}),
      dir: e.dir,
      style: e.style,
      ...(e.tone ? { tone: e.tone } : {}),
      ...(e.cut ? { cut: true as const } : {}),
      count: 1,
      edges: [e],
    };
    joined.set(key, se);
    edges.push(se);
  }
  return { nodes, byId, edges, clusters, shownAs };
}

export type Direction = "left" | "right" | "up" | "down";

/** The nearest node from `id` in direction `dir` (within 45° of it), or null at the edge. */
export function stepFrom(s: Scene, id: string, dir: Direction): string | null {
  const from = s.byId.get(id);
  if (!from) return s.nodes[0]?.id ?? null;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const n of s.nodes) {
    if (n.id === id) continue;
    const dx = n.x - from.x;
    const dy = n.y - from.y;
    const along = dir === "right" ? dx : dir === "left" ? -dx : dir === "down" ? dy : -dy;
    const across = Math.abs(dir === "left" || dir === "right" ? dy : dx);
    if (along <= 0 || across > along) continue;
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = n.id;
    }
  }
  return best;
}

/** Reading order: top to bottom, then left to right. */
const reading = (a: SceneNode, b: SceneNode) => a.y - b.y || a.x - b.x;

/** The drawn nodes that say every word of `query` (in their name, id, kind, note, detail or
 * cluster, any case), as a table's `/` filter keeps rows; in reading order. A match inside a
 * collapsed cluster finds the cluster. */
export function matchesOf(g: GraphData, s: Scene, query: string): string[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const says = (text: string) => words.every((w) => text.includes(w));
  const titles = new Map(g.clusters.map((c) => [c.id, c.title]));
  const hit = new Set<string>();
  for (const n of g.nodes) {
    const where = s.shownAs.get(n.id);
    if (where === undefined || hit.has(where)) continue;
    const text = [n.label, n.id, n.kind, n.note, n.detail, n.cluster !== undefined ? titles.get(n.cluster) : undefined].filter(Boolean).join("\u0000").toLocaleLowerCase();
    if (says(text)) hit.add(where);
  }
  for (const n of s.nodes) if (n.count !== undefined && says(n.label.toLocaleLowerCase())) hit.add(n.id);
  return s.nodes
    .filter((n) => hit.has(n.id))
    .sort(reading)
    .map((n) => n.id);
}

export interface Highlight {
  /** Scene node ids lit up: the selected one and its reach both ways. */
  nodes: Set<string>;
  /** Indexes into the scene's edges. */
  edges: number[];
  /** How many nodes it reaches, and how many reach it. */
  out: number;
  in: number;
}

/** What selecting `id` lights up. A collapsed cluster stands for its nodes: what they reach
 * outside it, and what reaches them. */
export function highlightOf(s: Scene, ix: GraphIndex, id: string, hops: Reach = "all"): Highlight {
  const own = ix.nodes.has(id) ? [id] : (ix.members.get(id) ?? []);
  if (own.length === 0) return { nodes: new Set(s.byId.has(id) ? [id] : []), edges: [], out: 0, in: 0 };
  const r = reachOf(ix, id, hops);
  const fwd = new Set([...r.out, ...own]);
  const back = new Set([...r.in, ...own]);
  const nodes = new Set<string>();
  for (const n of [...fwd, ...back]) {
    const at = s.shownAs.get(n);
    if (at !== undefined) nodes.add(at);
  }
  const ends = (x: string) => (ix.nodes.has(x) ? [x] : (ix.members.get(x) ?? []));
  const touches = (x: string, set: Set<string>) => ends(x).some((n) => set.has(n));
  const edges: number[] = [];
  s.edges.forEach((se, i) => {
    const on = se.edges.some(
      (e) => touches(e.from, fwd) || touches(e.to, back) || (e.dir === "both" && (touches(e.to, fwd) || touches(e.from, back))),
    );
    if (on) edges.push(i);
  });
  return { nodes, edges, out: r.out.size, in: r.in.size };
}
