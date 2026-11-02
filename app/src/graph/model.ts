// A graph as plain data (ticket 77, decision Q99): nodes, edges and clusters a Plugin fills, and
// what can reach what. Pure, so the graph view (GraphView.tsx) is a drawing of it and its tests
// need no canvas.
//
// An edge's end is a node or a cluster: an edge to a cluster reaches every node in it, one from a
// cluster is every node's in it. A meshed cluster's nodes reach each other both ways (the Mesh's
// `mesh: true`, Q63) without n² edges. An end that names nothing (yet) is ignored.

/** How a node is drawn: its shape carries meaning, not only its colour (Q53, taste.md). */
export type NodeShape = "dot" | "ring" | "dashed" | "hollow" | "square";
/** `live` is in the accent (connected now); `down` is drawn quieter and crossed. */
export type NodeState = "live" | "down";
export type Mark = "warn" | "error";
export type EdgeDir = "one" | "both";
export type EdgeStyle = "solid" | "dashed" | "dotted";
export type EdgeTone = "live" | "muted" | "warn" | "error";

export interface GraphNode {
  id: string;
  label: string;
  /** What sort of thing it is ("esxi", "linux"): searched, and a column in the list. */
  kind?: string;
  shape: NodeShape;
  state?: NodeState;
  /** A small mark beside it, warn yellow or error raspberry. */
  mark?: Mark;
  /** A few words about it ("out of date", "cut pending"), beside it when selected and in the list. */
  note?: string;
  /** The cluster it's in. */
  cluster?: string;
  /** The Host it is: actions get it as `e.host`. */
  host?: string;
  /** A second line in the data font (an address). */
  detail?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** `one`: from → to; `both`: each way. */
  dir: EdgeDir;
  style: EdgeStyle;
  tone?: EdgeTone;
  /** Drawn broken in the middle: about to be cut. */
  cut?: true;
  /** A few words, in the list. */
  label?: string;
}

export interface GraphCluster {
  id: string;
  title: string;
  /** Every node in it reaches every other, both ways. */
  mesh?: true;
  /** Starts collapsed to a count (or open); left out, it collapses when the graph is big. */
  collapsed?: boolean;
}

/** How far "reaches" goes: every hop (`all`, a key on a Host reaches what that Host's keys reach)
 * or only one (`direct`). */
export type Reach = "all" | "direct";

/** What a filter keeps: a node in any of the `clusters`, of any of the `kinds` and in any of the
 * `states` (a node's state or mark), every dimension that's given at once. The rest is hidden. */
export interface GraphFilter {
  clusters?: readonly string[];
  kinds?: readonly string[];
  states?: readonly FilterState[];
}
export type FilterState = NodeState | Mark;

/** Whether an action with `when` applies to `node` (T89, as a table's, ticket 78): every field it
 * names holds one of its values. A number and its text are the same value; a field the node
 * lacks matches nothing. */
export function nodeActionApplies(when: Readonly<Record<string, readonly (string | number)[]>> | undefined, node: GraphNode): boolean {
  if (!when) return true;
  return Object.entries(when).every(([k, values]) => {
    const v = (node as unknown as Record<string, unknown>)[k];
    return (typeof v === "string" || typeof v === "number") && values.some((x) => String(x) === String(v));
  });
}

export interface GraphData {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  clusters: readonly GraphCluster[];
}

export interface GraphUpdate {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  clusters: readonly GraphCluster[];
  /** Node or cluster ids to take away: a node's edges go with it; a cluster's nodes stay, loose. */
  remove: readonly string[];
  removeEdges: readonly string[];
}

function upsert<T extends { id: string }>(items: readonly T[], changes: readonly T[]): T[] {
  const at = new Map(items.map((x, i) => [x.id, i]));
  const out = [...items];
  for (const c of changes) {
    const i = at.get(c.id);
    if (i === undefined) {
      at.set(c.id, out.length);
      out.push(c);
    } else out[i] = c;
  }
  return out;
}

/** `graph` with `update` in: what's there already is replaced where it stands, new things go at
 * the end, then the ids in `remove` and `removeEdges` are taken away. */
export function mergeGraph(graph: GraphData, update: GraphUpdate): GraphData {
  let nodes = upsert(graph.nodes, update.nodes);
  let edges = upsert(graph.edges, update.edges);
  let clusters = upsert(graph.clusters, update.clusters);
  if (update.remove.length) {
    const gone = new Set(update.remove);
    nodes = nodes.filter((n) => !gone.has(n.id)).map((n) => (n.cluster !== undefined && gone.has(n.cluster) ? withoutCluster(n) : n));
    clusters = clusters.filter((c) => !gone.has(c.id));
    edges = edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
  }
  if (update.removeEdges.length) {
    const gone = new Set(update.removeEdges);
    edges = edges.filter((e) => !gone.has(e.id));
  }
  return { nodes, edges, clusters };
}

function withoutCluster(n: GraphNode): GraphNode {
  const rest = { ...n };
  delete rest.cluster;
  return rest;
}

/** What `reachOf` needs, built once per graph. */
export interface GraphIndex {
  nodes: ReadonlyMap<string, GraphNode>;
  /** A cluster's nodes, in order. */
  members: ReadonlyMap<string, readonly string[]>;
  meshed: ReadonlySet<string>;
  /** Each end's next ends (node or cluster ids), forward and backward. */
  next: ReadonlyMap<string, readonly string[]>;
  prev: ReadonlyMap<string, readonly string[]>;
}

export function graphIndex(g: GraphData): GraphIndex {
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const clusterIds = new Set(g.clusters.map((c) => c.id));
  const members = new Map<string, string[]>(g.clusters.map((c) => [c.id, []]));
  for (const n of g.nodes) if (n.cluster !== undefined) members.get(n.cluster)?.push(n.id);
  const meshed = new Set(g.clusters.filter((c) => c.mesh).map((c) => c.id));
  const next = new Map<string, string[]>();
  const prev = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const known = (id: string) => nodes.has(id) || clusterIds.has(id);
  for (const e of g.edges) {
    if (!known(e.from) || !known(e.to) || e.from === e.to) continue;
    add(next, e.from, e.to);
    add(prev, e.to, e.from);
    if (e.dir === "both") {
      add(next, e.to, e.from);
      add(prev, e.from, e.to);
    }
  }
  return { nodes, members, meshed, next, prev };
}

/** Whether `f` hides anything. */
export const filtering = (f: GraphFilter | undefined): f is GraphFilter => !!f && !!(f.clusters?.length || f.kinds?.length || f.states?.length);

/** `g` with only the nodes `f` keeps, the edges between what's left, and the clusters that still
 * have a node. `g` itself when `f` hides nothing. */
export function filterGraph(g: GraphData, f: GraphFilter): GraphData {
  if (!filtering(f)) return g;
  const clusters = f.clusters?.length ? new Set(f.clusters) : null;
  const kinds = f.kinds?.length ? new Set(f.kinds) : null;
  const states = f.states?.length ? new Set<string>(f.states) : null;
  const nodes = g.nodes.filter(
    (n) =>
      (!clusters || (n.cluster !== undefined && clusters.has(n.cluster))) &&
      (!kinds || (n.kind !== undefined && kinds.has(n.kind))) &&
      (!states || (n.state !== undefined && states.has(n.state)) || (n.mark !== undefined && states.has(n.mark))),
  );
  const kept = new Set(nodes.map((n) => n.id));
  const held = new Set(nodes.flatMap((n) => (n.cluster === undefined ? [] : [n.cluster])));
  const shown = g.clusters.filter((c) => held.has(c.id));
  const ends = new Set([...kept, ...shown.map((c) => c.id)]);
  return { nodes, edges: g.edges.filter((e) => ends.has(e.from) && ends.has(e.to)), clusters: shown };
}

function walk(ix: GraphIndex, starts: readonly string[], links: ReadonlyMap<string, readonly string[]>, hops: Reach = "all"): Set<string> {
  const seen = new Set<string>(starts);
  const opened = new Set<string>();
  const queue = [...starts];
  const reach = (id: string) => {
    if (ix.nodes.has(id)) {
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(id);
      }
      return;
    }
    // A cluster: every node in it, once.
    if (opened.has(id)) return;
    opened.add(id);
    for (const m of ix.members.get(id) ?? []) reach(m);
  };
  // One hop: only the starts are walked from.
  const from = hops === "direct" ? new Set(starts) : null;
  while (queue.length) {
    const id = queue.pop() as string;
    if (from && !from.has(id)) continue;
    const cluster = ix.nodes.get(id)?.cluster;
    for (const t of links.get(id) ?? []) reach(t);
    if (cluster !== undefined && ix.members.has(cluster)) {
      for (const t of links.get(cluster) ?? []) reach(t);
      if (ix.meshed.has(cluster)) reach(cluster);
    }
  }
  for (const s of starts) seen.delete(s);
  return seen;
}

/** The nodes `id` can reach, however many hops away, and those that can reach it. For a cluster,
 * what its nodes reach (and what reaches them) outside it. */
export function reachOf(ix: GraphIndex, id: string, hops: Reach = "all"): { out: Set<string>; in: Set<string> } {
  const starts = ix.nodes.has(id) ? [id] : (ix.members.get(id) ?? []);
  if (starts.length === 0) return { out: new Set(), in: new Set() };
  return { out: walk(ix, starts, ix.next, hops), in: walk(ix, starts, ix.prev, hops) };
}

/** How many nodes each node reaches and is reached by, for every node at once: the graph's
 * strongly connected parts (Tarjan), then each part's reach as a bitset, sinks first. Linear in
 * the graph plus nodes × parts / 32, where a walk per node would be nodes × graph. */
export function reachCounts(ix: GraphIndex, hops: Reach = "all"): Map<string, { out: number; in: number }> {
  const ids = [...ix.nodes.keys()];
  // One hop is each node's neighbours: no walk to share between them.
  if (hops === "direct")
    return new Map(
      ids.map((id) => {
        const r = reachOf(ix, id, "direct");
        return [id, { out: r.out.size, in: r.in.size }];
      }),
    );
  const n = ids.length;
  const at = new Map(ids.map((id, i) => [id, i]));
  // Each cluster is up to three extra vertices: edges into it, edges out of it, and its mesh.
  let next = n;
  const ports = new Map<string, { in: number; out: number; mesh: number }>();
  for (const c of ix.members.keys()) ports.set(c, { in: next++, out: next++, mesh: ix.meshed.has(c) ? next++ : -1 });
  const fwd: number[][] = Array.from({ length: next }, () => []);
  const back: number[][] = Array.from({ length: next }, () => []);
  const link = (a: number, b: number) => {
    fwd[a]?.push(b);
    back[b]?.push(a);
  };
  for (const [c, p] of ports)
    for (const m of ix.members.get(c) ?? []) {
      const i = at.get(m) as number;
      link(p.in, i);
      link(i, p.out);
      if (p.mesh >= 0) {
        link(i, p.mesh);
        link(p.mesh, i);
      }
    }
  for (const [from, tos] of ix.next) {
    const a = at.get(from) ?? ports.get(from)?.out;
    if (a === undefined) continue;
    for (const to of tos) {
      const b = at.get(to) ?? ports.get(to)?.in;
      if (b !== undefined) link(a, b);
    }
  }
  const out = countAll(fwd, n);
  const inn = countAll(back, n);
  return new Map(ids.map((id, i) => [id, { out: out[i] ?? 0, in: inn[i] ?? 0 }]));
}

/** For each of the first `real` vertices, how many other real vertices it reaches. */
function countAll(adj: number[][], real: number): number[] {
  const V = adj.length;
  const words = Math.ceil(real / 32) || 1;
  const index = new Int32Array(V).fill(-1);
  const low = new Int32Array(V);
  const part = new Int32Array(V).fill(-1);
  const onStack = new Uint8Array(V);
  const stack: number[] = [];
  const bits: Uint32Array[] = [];
  let counter = 0;
  for (let root = 0; root < V; root++) {
    if (index[root] !== -1) continue;
    // An iterative Tarjan: a frame is a vertex and how far through its edges it is.
    const frames: [number, number][] = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (frames.length) {
      const frame = frames[frames.length - 1] as [number, number];
      const v = frame[0];
      const edges = adj[v] as number[];
      if (frame[1] < edges.length) {
        const w = edges[frame[1]++] as number;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          frames.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v] as number, index[w] as number);
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low[parent[0]] = Math.min(low[parent[0]] as number, low[v] as number);
      if (low[v] !== index[v]) continue;
      // A part is complete: its reach is its own real vertices and every later part it points to,
      // which Tarjan has finished already.
      const p = bits.length;
      const set = new Uint32Array(words);
      const members: number[] = [];
      let w: number;
      do {
        w = stack.pop() as number;
        onStack[w] = 0;
        part[w] = p;
        members.push(w);
        if (w < real) set[w >>> 5] = (set[w >>> 5] as number) | (1 << (w & 31));
      } while (w !== v);
      for (const m of members)
        for (const t of adj[m] as number[]) {
          const q = part[t] as number;
          if (q === p || q < 0) continue;
          const other = bits[q] as Uint32Array;
          for (let k = 0; k < words; k++) set[k] = (set[k] as number) | (other[k] as number);
        }
      bits.push(set);
    }
  }
  const counts: number[] = [];
  for (let v = 0; v < real; v++) {
    const set = bits[part[v] as number] as Uint32Array;
    let c = 0;
    for (let k = 0; k < words; k++) {
      let x = set[k] as number;
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      c += (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    }
    counts.push(c - 1);
  }
  return counts;
}
