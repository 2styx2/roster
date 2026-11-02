// A view's graph as a Plugin sends it (ticket 77, decision Q99), checked: nodes, edges and clusters
// are plain data; `open` and `actions` are the graph's, and a function there gets the node. Kept
// apart from ops.ts, which calls it for `roster.views.set` and `roster.views.update`.
import type { EdgeDir, EdgeStyle, EdgeTone, FilterState, GraphCluster, GraphData, GraphEdge, GraphFilter, GraphNode, Mark, NodeShape, NodeState, Reach } from "../graph/model";
import type { RowAction } from "../sidebar/Sidebar";
import { when, type PluginTableAction, type Run } from "./ops";

/** Most nodes, edges and clusters a graph holds, after updates too. */
export const MAX_NODES = 5000;
export const MAX_EDGES = 10_000;
export const MAX_CLUSTERS = 500;
const MAX_ACTIONS = 8;
const MAX_TEXT = 500;

/** Keys the graph uses itself: moving, panning, zoom, search, its filter, clusters, the list,
 * placing a node (`m`), and kept ones; and `s` `S`, which sort its node list (a table). */
export const GRAPH_KEYS = ["h", "j", "k", "l", "H", "J", "K", "L", "g", "G", "n", "N", "o", "O", "t", "f", "m", "s", "S", "/", "?", "q", "+", "-", "=", "0"] as const;

/** What a graph action's `when` may test: a node's own fields (T89). */
export const NODE_FIELDS = ["id", "label", "kind", "shape", "state", "mark", "note", "cluster", "host", "detail"] as const;

export const SHAPES: readonly NodeShape[] = ["dot", "ring", "dashed", "hollow", "square"];
const STATES: readonly NodeState[] = ["live", "down"];
const MARKS: readonly Mark[] = ["warn", "error"];
const DIRS: readonly EdgeDir[] = ["one", "both"];
const STYLES: readonly EdgeStyle[] = ["solid", "dashed", "dotted"];
const EDGE_TONES: readonly EdgeTone[] = ["live", "muted", "warn", "error"];
const REACHES: readonly Reach[] = ["all", "direct"];
const FILTER_STATES: readonly FilterState[] = ["live", "down", "warn", "error"];
const MAX_FILTER = 500;
const ICONS: readonly RowAction["icon"][] = ["close", "edit", "add", "addGroup", "review", "unreview", "info", "copy"];

export interface PluginGraph {
  data: GraphData;
  /** How far "reaches" goes; `all` if left out. */
  reach?: Reach;
  /** What it shows to begin with; the user changes it with `f`. */
  filter?: GraphFilter;
  /** `Enter` (or a double click) on a node. */
  open?: Run;
  actions: PluginTableAction[];
}

/** The graph part of `roster.views.update`; `remove` (node and cluster ids) is the update's own. */
export interface PluginGraphUpdate {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  removeEdges: string[];
  /** A new filter (`{}` shows everything). */
  filter?: GraphFilter;
}

export class GraphInvalid extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const given = (o: Obj, k: string) => o[k] !== undefined && o[k] !== null;
const fmt = (n: number) => n.toLocaleString("en-US");

function str(o: Obj, key: string, what: string, max = MAX_TEXT): string {
  const v = o[key];
  if (typeof v !== "string") throw new GraphInvalid(`${what}: ${key} must be text`);
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}
const optStr = (o: Obj, key: string, what: string, max = MAX_TEXT) => (given(o, key) ? str(o, key, what, max) : undefined);

function oneOf<T extends string>(o: Obj, key: string, what: string, values: readonly T[]): T | undefined {
  if (!given(o, key)) return undefined;
  const v = values.find((x) => x === o[key]);
  if (!v) throw new GraphInvalid(`${what}: ${key} must be ${values.map((x) => `"${x}"`).join(", ")}`);
  return v;
}

function bool(o: Obj, key: string, what: string): boolean | undefined {
  if (!given(o, key)) return undefined;
  if (typeof o[key] !== "boolean") throw new GraphInvalid(`${what}: ${key} must be true or false`);
  return o[key] as boolean;
}

function list(o: Obj, key: string, what: string, max: number): unknown[] {
  const v = o[key];
  if (v === undefined || v === null || (isObj(v) && Object.keys(v).length === 0)) return [];
  if (!Array.isArray(v)) throw new GraphInvalid(`${what}: ${key} must be a list`);
  if (v.length > max) throw new GraphInvalid(`${what}: ${key} has more than ${fmt(max)}`);
  return v;
}

function run(v: unknown, what: string): Run {
  if (typeof v === "string") return { command: v.slice(0, MAX_TEXT) };
  if (isObj(v) && typeof v.handler === "number" && Number.isInteger(v.handler)) return { handler: v.handler };
  throw new GraphInvalid(`${what}: run must be a function or a command line`);
}

/** Leaves out what's undefined (exactOptionalPropertyTypes). */
function defined<T>(o: { [K in keyof T]-?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function node(v: unknown, i: number, what: string): GraphNode {
  const at = `${what} node ${i + 1}`;
  if (!isObj(v)) throw new GraphInvalid(`${at}: must be a table`);
  const id = str(v, "id", at, 100);
  return defined<GraphNode>({
    id,
    label: optStr(v, "label", at, 200) ?? id,
    kind: optStr(v, "kind", at, 40),
    shape: oneOf(v, "shape", at, SHAPES) ?? "dot",
    state: oneOf(v, "state", at, STATES),
    mark: oneOf(v, "mark", at, MARKS),
    note: optStr(v, "note", at, 100),
    cluster: optStr(v, "cluster", at, 100),
    host: optStr(v, "host", at, 200),
    detail: optStr(v, "detail", at, 200),
  });
}

function edge(v: unknown, i: number, what: string): GraphEdge {
  const at = `${what} edge ${i + 1}`;
  if (!isObj(v)) throw new GraphInvalid(`${at}: must be a table`);
  const from = str(v, "from", at, 100);
  const to = str(v, "to", at, 100);
  return defined<GraphEdge>({
    id: optStr(v, "id", at, 210) ?? `${from}>${to}`,
    from,
    to,
    dir: oneOf(v, "dir", at, DIRS) ?? "one",
    style: oneOf(v, "style", at, STYLES) ?? "solid",
    tone: oneOf(v, "tone", at, EDGE_TONES),
    cut: bool(v, "cut", at) ? true : undefined,
    label: optStr(v, "label", at, 100),
  });
}

function cluster(v: unknown, i: number, what: string): GraphCluster {
  const at = `${what} cluster ${i + 1}`;
  if (!isObj(v)) throw new GraphInvalid(`${at}: must be a table`);
  const id = str(v, "id", at, 100);
  return defined<GraphCluster>({
    id,
    title: optStr(v, "title", at, 200) ?? id,
    mesh: bool(v, "mesh", at) ? true : undefined,
    collapsed: bool(v, "collapsed", at),
  });
}

function filterOf(o: Obj, what: string): GraphFilter | undefined {
  if (!given(o, "filter")) return undefined;
  const at = `${what} filter`;
  // An empty Lua table can come as an empty list: it's an empty filter.
  const v = Array.isArray(o.filter) && o.filter.length === 0 ? {} : o.filter;
  if (!isObj(v)) throw new GraphInvalid(`${at} must be a table`);
  const words = (key: "clusters" | "kinds" | "states") =>
    list(v, key, at, MAX_FILTER).map((x, i) => {
      if (typeof x !== "string") throw new GraphInvalid(`${at} ${key} ${i + 1} must be text`);
      return x;
    });
  const states = words("states").map((x, i) => {
    const s = FILTER_STATES.find((y) => y === x);
    if (!s) throw new GraphInvalid(`${at} states ${i + 1} must be ${FILTER_STATES.map((y) => `"${y}"`).join(", ")}`);
    return s;
  });
  const clusters = words("clusters");
  const kinds = words("kinds");
  return defined<GraphFilter>({ clusters: clusters.length ? clusters : undefined, kinds: kinds.length ? kinds : undefined, states: states.length ? states : undefined });
}

function unique(ids: readonly string[], what: string, noun = "id") {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new GraphInvalid(`${what}: ${noun} ${id} is used twice`);
    seen.add(id);
  }
}

function parts(o: Obj, what: string) {
  const nodes = list(o, "nodes", what, MAX_NODES).map((v, i) => node(v, i, what));
  const edges = list(o, "edges", what, MAX_EDGES).map((v, i) => edge(v, i, what));
  const clusters = list(o, "clusters", what, MAX_CLUSTERS).map((v, i) => cluster(v, i, what));
  // Nodes and clusters share one name space: an edge's end may be either.
  unique([...nodes.map((n) => n.id), ...clusters.map((c) => c.id)], what);
  unique(
    edges.map((e) => e.id),
    what,
    "edge id",
  );
  return { nodes, edges, clusters };
}

/** `spec.graph` of `roster.views.set ID` (`what` names it). */
export function parseGraph(v: unknown, what: string): PluginGraph {
  const at = `${what} graph`;
  if (!isObj(v)) throw new GraphInvalid(`${at}: must be a table`);
  const keys = new Set<string>();
  const actions = list(v, "actions", at, MAX_ACTIONS).map((a, j): PluginTableAction => {
    const where = `${at} action ${j + 1}`;
    if (!isObj(a)) throw new GraphInvalid(`${where}: must be a table`);
    const key = optStr(a, "key", where, 8);
    if (key !== undefined) {
      if ([...key].length !== 1 || key.trim() === "") throw new GraphInvalid(`${where}: key must be one character`);
      if ((GRAPH_KEYS as readonly string[]).includes(key)) throw new GraphInvalid(`${where}: the graph uses ${key} itself (${GRAPH_KEYS.join(" ")})`);
      if (keys.has(key)) throw new GraphInvalid(`${where}: key ${key} is used twice`);
      keys.add(key);
    }
    const only = when(a, where);
    for (const k of Object.keys(only ?? {}))
      if (!(NODE_FIELDS as readonly string[]).includes(k)) throw new GraphInvalid(`${where}: when.${k}: a node has no ${k} (${NODE_FIELDS.join(", ")})`);
    return defined<PluginTableAction>({ label: str(a, "label", where, 100), key, icon: oneOf(a, "icon", where, ICONS), when: only, run: run(a.run, where) });
  });
  return defined<PluginGraph>({
    data: parts(v, at),
    reach: oneOf(v, "reach", at, REACHES),
    filter: filterOf(v, at),
    open: given(v, "open") ? run(v.open, `${at} open`) : undefined,
    actions,
  });
}

/** The graph part of `roster.views.update ID`'s changes, or undefined when it has none. */
export function parseGraphUpdate(c: Obj, what: string): PluginGraphUpdate | undefined {
  if (!["nodes", "edges", "clusters", "remove_edges", "filter"].some((k) => given(c, k))) return undefined;
  const removeEdges = list(c, "remove_edges", what, MAX_EDGES).map((r, i) => {
    if (typeof r !== "string") throw new GraphInvalid(`${what}: remove_edges ${i + 1} must be an edge's id`);
    return r;
  });
  const filter = filterOf(c, what);
  return { ...parts(c, what), removeEdges, ...(filter ? { filter } : {}) };
}
