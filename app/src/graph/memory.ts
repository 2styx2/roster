// A graph's layout in the State (ticket 77): where each node and cluster was placed, and which
// clusters the user collapsed or opened, per view, so the graph opens the same way next time, and
// which nodes and clusters the user placed themselves (`moved` and `movedClusters`, #237; a State
// from before them has none). The
// State is untrusted (another app version may have written it): what can't be read is ignored.
import { layoutGraph, type Layout, type SavedLayout } from "./layout";
import type { GraphData } from "./model";

/** The State's key: a list of graphs, the most recently saved first. */
export const GRAPHS_KEY = "graphs";
/** How many views' graphs are kept. */
export const KEPT_GRAPHS = 8;

export interface GraphMemo {
  layout?: SavedLayout;
  /** Clusters the user collapsed (true) or opened (false). */
  folds: Record<string, boolean>;
}

interface Stored {
  key: string;
  nodes: Record<string, [number, number]>;
  clusters: Record<string, [number, number]>;
  moved: string[];
  movedClusters: string[];
  folds: Record<string, boolean>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function points(v: unknown): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  if (!isObj(v)) return out;
  for (const [k, p] of Object.entries(v))
    if (Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n))) out[k] = [p[0] as number, p[1] as number];
  return out;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function folds(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (isObj(v)) for (const [k, b] of Object.entries(v)) if (typeof b === "boolean") out[k] = b;
  return out;
}

export class GraphMemory {
  constructor(private readonly store: { get(key: string): unknown; set(key: string, value: unknown): void }) {}

  private all(): Stored[] {
    const v = this.store.get(GRAPHS_KEY);
    if (!Array.isArray(v)) return [];
    return v.filter(isObj).flatMap((g) => (typeof g.key === "string" ? [{ key: g.key, nodes: points(g.nodes), clusters: points(g.clusters), moved: ids(g.moved), movedClusters: ids(g.movedClusters), folds: folds(g.folds) }] : []));
  }

  /** View `key`'s graph as last saved (`source/id`). */
  load(key: string): GraphMemo {
    const g = this.all().find((x) => x.key === key);
    if (!g) return { folds: {} };
    const placed = Object.keys(g.nodes).length > 0 || Object.keys(g.clusters).length > 0;
    const layout: SavedLayout = { nodes: g.nodes, clusters: g.clusters, ...(g.moved.length ? { moved: g.moved } : {}), ...(g.movedClusters.length ? { movedClusters: g.movedClusters } : {}) };
    return { ...(placed ? { layout } : {}), folds: g.folds };
  }

  save(key: string, memo: GraphMemo) {
    const g: Stored = { key, nodes: memo.layout?.nodes ?? {}, clusters: memo.layout?.clusters ?? {}, moved: memo.layout?.moved ?? [], movedClusters: memo.layout?.movedClusters ?? [], folds: memo.folds };
    this.store.set(GRAPHS_KEY, [g, ...this.all().filter((x) => x.key !== key)].slice(0, KEPT_GRAPHS));
  }
}

/** One open graph's places: it lays the graph out keeping what was placed before, takes a node the
 * user moved, and writes the State only when something new was placed or moved (`persist`, after
 * a render; never during one). */
export class GraphPlaces {
  private saved: SavedLayout | undefined;
  private folds: Record<string, boolean>;
  private dirty = false;
  /** The graph last laid out: which nodes are in which cluster, for moving one whole. */
  private graph: GraphData | undefined;
  /** The cluster being moved (`hold`): it stays under the user and pushes nothing until let go. */
  private holding: string | undefined;

  constructor(
    private readonly memory: GraphMemory | undefined,
    private readonly key: string,
  ) {
    const memo = memory?.load(key) ?? { folds: {} };
    this.saved = memo.layout;
    this.folds = memo.folds;
  }

  layout(g: GraphData): Layout {
    this.graph = g;
    const l = layoutGraph(g, this.saved, { holding: this.holding });
    if (!this.saved || placedMore(this.saved, l.saved)) this.dirty = true;
    this.saved = l.saved;
    return l;
  }

  /** Puts node `id` at (x, y), kept from now on. `mine`: the user placed it, so it stays there
   * whatever its cluster does; false when it's put back where the layout had it. */
  move(id: string, x: number, y: number, mine = true) {
    if (!this.saved) return;
    const moved = (this.saved.moved ?? []).filter((m) => m !== id);
    if (mine) moved.push(id);
    this.saved = { ...this.saved, nodes: { ...this.saved.nodes, [id]: [Math.round(x), Math.round(y)] } };
    if (moved.length) this.saved.moved = moved;
    else delete this.saved.moved;
    this.dirty = true;
  }

  /** Puts cluster `id`'s centre at (x, y), its nodes with it (each as far as the centre went, those
   * the user placed too), kept from now on. `mine`: the user placed it, so it stays there; false when
   * it's put back where the layout had it. */
  moveCluster(id: string, x: number, y: number, mine = true) {
    const was = this.saved?.clusters[id];
    if (!this.saved || !was) return;
    const dx = Math.round(x) - was[0];
    const dy = Math.round(y) - was[1];
    const nodes = { ...this.saved.nodes };
    for (const n of this.graph?.nodes ?? []) {
      const p = n.cluster === id ? nodes[n.id] : undefined;
      if (p) nodes[n.id] = [p[0] + dx, p[1] + dy];
    }
    const movedClusters = (this.saved.movedClusters ?? []).filter((m) => m !== id);
    if (mine) movedClusters.push(id);
    this.saved = { ...this.saved, nodes, clusters: { ...this.saved.clusters, [id]: [was[0] + dx, was[1] + dy] } };
    if (movedClusters.length) this.saved.movedClusters = movedClusters;
    else delete this.saved.movedClusters;
    this.dirty = true;
  }

  /** Holds cluster `id` while it's being moved (null lets go: then a neighbour it's on makes room). */
  hold(id: string | null) {
    this.holding = id ?? undefined;
  }

  /** Whether the user placed cluster `id` whole. */
  clusterPlacedByUser(id: string): boolean {
    return this.saved?.movedClusters?.includes(id) ?? false;
  }

  /** Whether the user placed node `id`. */
  placedByUser(id: string): boolean {
    return this.saved?.moved?.includes(id) ?? false;
  }

  userFolds(): Record<string, boolean> {
    return this.folds;
  }

  fold(id: string, collapsed: boolean) {
    this.folds = { ...this.folds, [id]: collapsed };
    this.dirty = true;
  }

  persist() {
    if (!this.dirty || !this.memory) return;
    this.dirty = false;
    this.memory.save(this.key, { ...(this.saved ? { layout: this.saved } : {}), folds: this.folds });
  }
}

/** Whether `after` placed something `before` didn't have, or moved a cluster (one that grew into another). */
function placedMore(before: SavedLayout, after: SavedLayout): boolean {
  for (const k of Object.keys(after.nodes)) if (!(k in before.nodes)) return true;
  for (const [k, p] of Object.entries(after.clusters)) {
    const q = before.clusters[k];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) return true;
  }
  return false;
}
