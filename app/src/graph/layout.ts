// Where a graph's nodes go (ticket 77, decision Q99): deterministic, O(n), and stable. Each
// cluster's nodes sit on a sunflower spiral (the golden angle), in the order given, so the first
// node is at its centre and each new one goes on the outside; the clusters are packed in rows, in
// order, loose nodes first. Positions are kept (`saved`, in the State): a node or cluster placed
// once stays where it is, and a new one takes a free place without moving the others; only a
// cluster that got new nodes and grew into another moves, whole, to the nearest free place (T99). No force
// simulation: it would move everything when one node arrives, and cost seconds at 2,000 nodes.
import type { GraphData } from "./model";

export interface Point {
  x: number;
  y: number;
}

export interface Circle extends Point {
  r: number;
}

/** Positions to keep, by id: nodes, and clusters' centres ("" is the loose nodes'). */
export interface SavedLayout {
  nodes: Record<string, [number, number]>;
  clusters: Record<string, [number, number]>;
}

export interface Layout {
  nodes: Map<string, Point>;
  /** Each cluster's circle (not the loose nodes'). */
  clusters: Map<string, Circle>;
  /** Everything placed, to keep. */
  saved: SavedLayout;
}

/** The distance between neighbouring nodes, in the graph's units (a pixel at zoom 1). */
export const SPACING = 40;
const C = SPACING * 0.62;
const PAD = SPACING * 0.9;
const GAP = SPACING * 1.6;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

const slot = (i: number): Point => {
  const r = C * Math.sqrt(i);
  const a = i * GOLDEN;
  return { x: Math.round(r * Math.cos(a)), y: Math.round(r * Math.sin(a)) };
};

/** The radius a cluster of `n` nodes needs. */
const radiusFor = (n: number) => C * Math.sqrt(Math.max(0, n - 1)) + PAD;

/** Which places are taken, in cells of SPACING. */
class Taken {
  private readonly cells = new Map<string, Point[]>();
  add(p: Point) {
    const k = `${Math.floor(p.x / SPACING)},${Math.floor(p.y / SPACING)}`;
    const list = this.cells.get(k);
    if (list) list.push(p);
    else this.cells.set(k, [p]);
  }
  near(p: Point, d: number): boolean {
    const cx = Math.floor(p.x / SPACING);
    const cy = Math.floor(p.y / SPACING);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) for (const q of this.cells.get(`${cx + i},${cy + j}`) ?? []) if (Math.hypot(p.x - q.x, p.y - q.y) < d) return true;
    return false;
  }
}

interface Group {
  id: string;
  members: string[];
  r: number;
  centre: Point;
  /** Placed before (its centre is saved). */
  fixed: boolean;
  /** Got members it didn't have before. */
  grew: boolean;
}

const apart = (a: Circle, b: Circle) => Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r + GAP / 2;

/** The free centre nearest `from` for a circle of radius `r`, on rings around it; none within reach: null. */
function nearestFree(from: Point, r: number, others: readonly Circle[]): Point | null {
  const free = (p: Point) => others.every((o) => apart({ ...p, r }, o));
  const reach = 6 * r + 20 * SPACING;
  for (let d = SPACING; d <= reach; d += SPACING) {
    const steps = Math.min(96, Math.max(8, Math.ceil((2 * Math.PI * d) / SPACING)));
    for (let k = 0; k < steps; k++) {
      // From the right, then round: the first free one is the nearest at this distance.
      const a = (k * 2 * Math.PI) / steps;
      const p = { x: Math.round(from.x + d * Math.cos(a)), y: Math.round(from.y + d * Math.sin(a)) };
      if (free(p)) return p;
    }
  }
  return null;
}

export function layoutGraph(g: GraphData, saved?: SavedLayout): Layout {
  const clusterIds = new Set(g.clusters.map((c) => c.id));
  const group = (id: string): Group => ({ id, members: [], r: 0, centre: { x: 0, y: 0 }, fixed: false, grew: false });
  const groups: Group[] = [group(""), ...g.clusters.map((c) => group(c.id))];
  const byId = new Map(groups.map((x) => [x.id, x]));
  for (const n of g.nodes) byId.get(n.cluster !== undefined && clusterIds.has(n.cluster) ? n.cluster : "")?.members.push(n.id);
  const used = groups.filter((x) => x.id !== "" || x.members.length > 0);

  // Each group's members, relative to its centre: saved ones where they were, new ones on free slots.
  const rel = new Map<string, Point>();
  for (const grp of used) {
    const keep = saved?.clusters[grp.id];
    if (keep) {
      grp.centre = { x: keep[0], y: keep[1] };
      grp.fixed = true;
    }
    const taken = new Taken();
    const fresh: string[] = [];
    let far = 0;
    for (const id of grp.members) {
      const p = grp.fixed ? saved?.nodes[id] : undefined;
      if (p) {
        const o = { x: p[0] - grp.centre.x, y: p[1] - grp.centre.y };
        taken.add(o);
        rel.set(id, o);
        far = Math.max(far, Math.hypot(o.x, o.y));
      } else fresh.push(id);
    }
    grp.grew = grp.fixed && fresh.length > 0;
    let i = 0;
    for (const id of fresh) {
      let s = slot(i++);
      while (taken.near(s, SPACING * 0.8)) s = slot(i++);
      taken.add(s);
      rel.set(id, s);
      far = Math.max(far, Math.hypot(s.x, s.y));
    }
    grp.r = Math.max(radiusFor(grp.members.length), far + PAD);
  }

  // Groups placed before stay where they are, unless one got new nodes and grew into another
  // (Topology fills its clusters as Hosts' details arrive): then it moves, whole, to the nearest free
  // place. Only new nodes count: a cluster the user made bigger by dragging a node out of it stays,
  // and so does everything near it, even overlapping.
  const settled: Circle[] = [];
  const homeless: Group[] = [];
  for (const grp of [...used.filter((x) => x.fixed && !x.grew), ...used.filter((x) => x.grew)]) {
    const c = { ...grp.centre, r: grp.r };
    if (grp.grew && !settled.every((o) => apart(c, o))) {
      const p = nearestFree(grp.centre, grp.r, settled);
      if (!p) {
        grp.fixed = false;
        homeless.push(grp);
        continue;
      }
      grp.centre = p;
    }
    settled.push({ ...grp.centre, r: grp.r });
  }

  // Groups without a place go in rows: from the top left when nothing was placed, else below it all.
  const placed = used.filter((x) => x.fixed);
  const todo = [...homeless, ...used.filter((x) => !x.fixed && !homeless.includes(x))];
  const area = used.reduce((a, x) => a + (2 * x.r + GAP) ** 2, 0);
  let width = Math.max(Math.sqrt(area) * 1.25, ...used.map((x) => 2 * x.r));
  let left = 0;
  let top = 0;
  if (placed.length) {
    left = Math.min(...placed.map((x) => x.centre.x - x.r));
    width = Math.max(width, Math.max(...placed.map((x) => x.centre.x + x.r)) - left);
    top = Math.max(...placed.map((x) => x.centre.y + x.r)) + GAP;
  }
  let row: Group[] = [];
  let x = left;
  const flush = () => {
    const h = Math.max(0, ...row.map((r) => 2 * r.r));
    for (const r of row) r.centre = { x: r.centre.x, y: Math.round(top + h / 2) };
    top += h + GAP;
    row = [];
    x = left;
  };
  for (const grp of todo) {
    if (row.length && x + 2 * grp.r > left + width) flush();
    grp.centre = { x: Math.round(x + grp.r), y: 0 };
    x += 2 * grp.r + GAP;
    row.push(grp);
  }
  if (row.length) flush();

  // Members are relative to their group's centre: move them there.
  const nodes = new Map<string, Point>();
  const clusters = new Map<string, Circle>();
  const out: SavedLayout = { nodes: {}, clusters: {} };
  for (const grp of used) {
    const c = grp.centre;
    out.clusters[grp.id] = [c.x, c.y];
    if (grp.id !== "") clusters.set(grp.id, { x: c.x, y: c.y, r: grp.r });
    for (const id of grp.members) {
      const p = rel.get(id) ?? { x: 0, y: 0 };
      const abs = { x: p.x + c.x, y: p.y + c.y };
      nodes.set(id, abs);
      out.nodes[id] = [abs.x, abs.y];
    }
  }
  return { nodes, clusters, saved: out };
}
