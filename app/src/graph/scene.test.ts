import { describe, expect, it } from "vitest";
import { layoutGraph } from "./layout";
import { graphIndex, type GraphData, type GraphEdge, type GraphNode } from "./model";
import { buildScene, foldsFor, highlightOf, matchesOf, stepFrom } from "./scene";

const node = (id: string, cluster?: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, label: id, shape: "dot", ...(cluster ? { cluster } : {}), ...extra });
const edge = (from: string, to: string, extra: Partial<GraphEdge> = {}): GraphEdge => ({ id: `${from}>${to}`, from, to, dir: "one", style: "solid", ...extra });

const g: GraphData = {
  nodes: [node("box", undefined, { shape: "square" }), node("x1", "lab", { kind: "esxi" }), node("x2", "lab", { note: "out of date" }), node("y1", "web"), node("y2", "web")],
  edges: [edge("box", "lab"), edge("x1", "y1"), edge("x2", "y1", { tone: "warn" }), edge("x1", "x2")],
  clusters: [
    { id: "lab", title: "Lab" },
    { id: "web", title: "Web" },
  ],
};

const scene = (collapsed: string[] = []) => buildScene(g, layoutGraph(g), new Set(collapsed));

describe("the scene", () => {
  it("draws every node and edge with both clusters open", () => {
    const s = scene();
    expect(s.nodes.map((n) => n.id)).toEqual(["box", "x1", "x2", "y1", "y2"]);
    expect(s.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["box>lab", "x1>y1", "x2>y1", "x1>x2"]);
    expect(s.edges[0]?.toCluster).toBe(true);
    expect(s.clusters.map((c) => [c.id, c.count, c.collapsed])).toEqual([
      ["lab", 2, false],
      ["web", 2, false],
    ]);
  });

  it("a collapsed cluster is one node with its count; its edges go to it, joined, and those inside it go", () => {
    const s = scene(["lab"]);
    expect(s.nodes.map((n) => [n.id, n.count ?? 0])).toEqual([
      ["box", 0],
      ["lab", 2],
      ["y1", 0],
      ["y2", 0],
    ]);
    // Joined, the edge keeps only a tone all of its edges share; one marked edge marks it.
    expect(s.edges.map((e) => [`${e.from}>${e.to}`, e.count, e.tone, e.mark])).toEqual([
      ["box>lab", 1, undefined, undefined],
      ["lab>y1", 2, undefined, "warn"],
    ]);
  });

  it("a collapsed cluster says how many of its nodes are live and the worst mark among them", () => {
    const live: GraphData = { ...g, nodes: g.nodes.map((n) => (n.id === "y1" ? { ...n, state: "live" as const, mark: "error" as const } : n)) };
    const s = buildScene(live, layoutGraph(live), new Set(["web"]));
    expect(s.byId.get("web")).toMatchObject({ count: 2, live: 1, mark: "error" });
  });

  it("clusters start collapsed when the Plugin says, or when the graph is big", () => {
    expect([...foldsFor(g, {})]).toEqual([]);
    expect([...foldsFor({ ...g, clusters: [{ id: "lab", title: "Lab", collapsed: true }, { id: "web", title: "Web" }] }, {})]).toEqual(["lab"]);
    expect([...foldsFor(g, { web: true })]).toEqual(["web"]);
    const big: GraphData = { ...g, nodes: Array.from({ length: 400 }, (_, i) => node(`n${i}`, i % 2 ? "lab" : "web")) };
    expect([...foldsFor(big, {})].sort()).toEqual(["lab", "web"]);
    expect([...foldsFor(big, { lab: false })]).toEqual(["web"]);
  });
});

describe("moving between nodes", () => {
  const pts: GraphData = {
    nodes: [node("c"), node("e"), node("w"), node("n"), node("s"), node("ne")],
    edges: [],
    clusters: [],
  };
  const at: Record<string, [number, number]> = { c: [0, 0], e: [100, 5], w: [-100, 0], n: [0, -100], s: [5, 100], ne: [60, -60] };
  const s = buildScene(pts, { nodes: new Map(Object.entries(at).map(([k, [x, y]]) => [k, { x, y }])), clusters: new Map(), saved: { nodes: {}, clusters: {} } }, new Set());

  it("h j k l go to the nearest node that way", () => {
    expect(stepFrom(s, "c", "left")).toBe("w");
    expect(stepFrom(s, "c", "right")).toBe("e");
    expect(stepFrom(s, "c", "up")).toBe("n");
    expect(stepFrom(s, "c", "down")).toBe("s");
    expect(stepFrom(s, "w", "left")).toBeNull();
  });
});

describe("search", () => {
  it("finds by name, kind, note and cluster, in reading order; a match in a collapsed cluster finds the cluster", () => {
    expect(matchesOf(g, scene(), "x").sort()).toEqual(["box", "x1", "x2"]);
    expect(matchesOf(g, scene(), "esxi")).toEqual(["x1"]);
    expect(matchesOf(g, scene(), "OUT OF")).toEqual(["x2"]);
    expect(matchesOf(g, scene(), "web").sort()).toEqual(["y1", "y2"]);
    expect(matchesOf(g, scene(["lab"]), "esxi")).toEqual(["lab"]);
    expect(matchesOf(g, scene(), "")).toEqual([]);
    // Every word, anywhere, as a table's filter: the cluster's title and the note.
    expect(matchesOf(g, scene(), "lab  date")).toEqual(["x2"]);
    expect(matchesOf(g, scene(), "web date")).toEqual([]);
  });
});

describe("selecting a node", () => {
  it("lights up what it reaches and what reaches it, with the edges between", () => {
    const s = scene();
    const h = highlightOf(s, graphIndex(g), "x1");
    expect(h.out).toBe(2);
    expect(h.in).toBe(1);
    expect([...h.nodes].sort()).toEqual(["box", "x1", "x2", "y1"]);
    expect(h.edges.map((i) => `${s.edges[i]?.from}>${s.edges[i]?.to}`).sort()).toEqual(["box>lab", "x1>x2", "x1>y1", "x2>y1"]);
  });

  it("y2 reaches nothing and nothing reaches it", () => {
    const h = highlightOf(scene(), graphIndex(g), "y2");
    expect([h.out, h.in, [...h.nodes]]).toEqual([0, 0, ["y2"]]);
  });

  it("through a collapsed cluster, the cluster lights up", () => {
    const h = highlightOf(scene(["lab"]), graphIndex(g), "y1");
    expect(h.in).toBe(3);
    expect([...h.nodes].sort()).toEqual(["box", "lab", "y1"]);
  });
});

describe("selecting a collapsed cluster", () => {
  it("lights up what its nodes reach outside it, and what reaches them", () => {
    const s = buildScene(g, layoutGraph(g), new Set(["lab"]));
    const h = highlightOf(s, graphIndex(g), "lab");
    expect([h.out, h.in]).toEqual([1, 1]);
    expect([...h.nodes].sort()).toEqual(["box", "lab", "y1"]);
  });
});
