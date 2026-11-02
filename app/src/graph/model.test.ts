import { describe, expect, it } from "vitest";
import { filterGraph, graphIndex, mergeGraph, reachCounts, reachOf, type GraphData, type GraphEdge, type GraphNode } from "./model";

const node = (id: string, cluster?: string): GraphNode => ({ id, label: id, shape: "dot", ...(cluster ? { cluster } : {}) });
const edge = (from: string, to: string, dir: "one" | "both" = "one"): GraphEdge => ({ id: `${from}>${to}`, from, to, dir, style: "solid" });
const sorted = (s: Set<string>) => [...s].sort();

describe("reach, both ways", () => {
  it("follows edges as far as they go, and back", () => {
    const g: GraphData = { nodes: ["a", "b", "c", "d", "e"].map((n) => node(n)), edges: [edge("a", "b"), edge("b", "c"), edge("d", "a")], clusters: [] };
    const r = reachOf(graphIndex(g), "a");
    expect(sorted(r.out)).toEqual(["b", "c"]);
    expect(sorted(r.in)).toEqual(["d"]);
  });

  it("a two-way edge reaches both ways, and a cycle doesn't count the node itself", () => {
    const g: GraphData = { nodes: ["a", "b", "c"].map((n) => node(n)), edges: [edge("a", "b", "both"), edge("b", "c")], clusters: [] };
    const r = reachOf(graphIndex(g), "a");
    expect(sorted(r.out)).toEqual(["b", "c"]);
    expect(sorted(r.in)).toEqual(["b"]);
  });

  it("an edge to a cluster reaches every node in it; a meshed cluster's nodes reach each other", () => {
    const g: GraphData = {
      nodes: [node("box"), node("x1", "lab"), node("x2", "lab"), node("y1", "web"), node("y2", "web")],
      edges: [edge("box", "lab"), edge("x1", "y1")],
      clusters: [
        { id: "lab", title: "lab", mesh: true },
        { id: "web", title: "web" },
      ],
    };
    const ix = graphIndex(g);
    expect(sorted(reachOf(ix, "box").out)).toEqual(["x1", "x2", "y1"]);
    expect(sorted(reachOf(ix, "x2").out)).toEqual(["x1", "y1"]);
    expect(sorted(reachOf(ix, "y1").in)).toEqual(["box", "x1", "x2"]);
    expect(reachOf(ix, "y2").in.size).toBe(0);
  });

  it("an edge from a cluster is every node's in it; an edge to a missing node is ignored", () => {
    const g: GraphData = { nodes: [node("x1", "lab"), node("x2", "lab"), node("n")], edges: [edge("lab", "n"), edge("n", "gone")], clusters: [{ id: "lab", title: "lab" }] };
    const ix = graphIndex(g);
    expect(sorted(reachOf(ix, "n").in)).toEqual(["x1", "x2"]);
    expect(reachOf(ix, "n").out.size).toBe(0);
  });

  it("stays quick at 5,000 nodes in meshed clusters", () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => node(`h${i}`, `c${i % 50}`));
    const clusters = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, title: `c${i}`, mesh: true as const }));
    const edges = Array.from({ length: 49 }, (_, i) => edge(`c${i}`, `c${i + 1}`));
    const ix = graphIndex({ nodes, edges, clusters });
    const t = performance.now();
    expect(reachOf(ix, "h0").out.size).toBe(4999);
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe("an update in place", () => {
  const base: GraphData = { nodes: [node("a"), node("b"), node("c")], edges: [edge("a", "b"), edge("b", "c")], clusters: [{ id: "k", title: "k" }] };

  it("replaces nodes and edges by id where they stand and adds new ones at the end", () => {
    const next = mergeGraph(base, { nodes: [{ ...node("b"), state: "live" }, node("d")], edges: [edge("c", "d")], clusters: [], remove: [], removeEdges: [] });
    expect(next.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    expect(next.nodes[1]?.state).toBe("live");
    expect(next.edges.map((e) => e.id)).toEqual(["a>b", "b>c", "c>d"]);
  });

  it("taking a node away takes its edges; taking a cluster away leaves its nodes loose", () => {
    const g: GraphData = { ...base, nodes: [node("a", "k"), node("b"), node("c")] };
    const next = mergeGraph(g, { nodes: [], edges: [], clusters: [], remove: ["b", "k"], removeEdges: [] });
    expect(next.nodes.map((n) => [n.id, n.cluster])).toEqual([
      ["a", undefined],
      ["c", undefined],
    ]);
    expect(next.edges).toEqual([]);
    expect(next.clusters).toEqual([]);
  });

  it("takes edges away by id", () => {
    expect(mergeGraph(base, { nodes: [], edges: [], clusters: [], remove: [], removeEdges: ["a>b"] }).edges.map((e) => e.id)).toEqual(["b>c"]);
  });
});

describe("every node's reach counts at once", () => {
  it("agree with walking from each node", () => {
    const nodes = Array.from({ length: 120 }, (_, i) => node(`n${i}`, i % 3 === 0 ? undefined : `c${i % 7}`));
    const clusters = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, title: `c${i}`, ...(i % 2 ? { mesh: true as const } : {}) }));
    const edges = [
      ...Array.from({ length: 90 }, (_, i) => edge(`n${(i * 7) % 120}`, `n${(i * 13 + 5) % 120}`, i % 5 === 0 ? "both" : "one")),
      edge("n0", "c1"),
      edge("c2", "n3"),
      edge("c4", "c5"),
    ];
    const ix = graphIndex({ nodes, edges: edges.filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i && e.from !== e.to), clusters });
    const all = reachCounts(ix);
    for (const n of nodes) {
      const r = reachOf(ix, n.id);
      expect(all.get(n.id), n.id).toEqual({ out: r.out.size, in: r.in.size });
    }
  });

  it("takes well under a second at 5,000 nodes", () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => node(`h${i}`, `c${i % 50}`));
    const clusters = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, title: `c${i}`, ...(i % 2 ? { mesh: true as const } : {}) }));
    const edges = Array.from({ length: 5000 }, (_, i) => edge(`h${i}`, `h${(i * 31 + 7) % 5000}`)).filter((e) => e.from !== e.to);
    const t = performance.now();
    reachCounts(graphIndex({ nodes, edges, clusters }));
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe("direct reach (reach = \"direct\")", () => {
  const g: GraphData = {
    nodes: [node("box"), node("x1", "lab"), node("x2", "lab"), node("y1", "web"), node("y2", "web"), node("z")],
    edges: [edge("box", "lab"), edge("x1", "y1"), edge("y1", "z"), edge("web", "z")],
    clusters: [
      { id: "lab", title: "lab", mesh: true },
      { id: "web", title: "web" },
    ],
  };
  const ix = graphIndex(g);

  it("is one hop: a node's own edges, its cluster's edges and its mesh, and the same backwards", () => {
    expect(sorted(reachOf(ix, "x2", "direct").out)).toEqual(["x1"]);
    expect(sorted(reachOf(ix, "x1", "direct").out)).toEqual(["x2", "y1"]);
    expect(sorted(reachOf(ix, "x1", "all").out)).toEqual(["x2", "y1", "z"]);
    expect(sorted(reachOf(ix, "z", "direct").in)).toEqual(["y1", "y2"]);
    expect(sorted(reachOf(ix, "box", "direct").out)).toEqual(["x1", "x2"]);
  });

  it("a collapsed cluster's direct reach is what its nodes reach in one hop, outside it", () => {
    expect(sorted(reachOf(ix, "web", "direct").out)).toEqual(["z"]);
    expect(sorted(reachOf(ix, "lab", "direct").in)).toEqual(["box"]);
  });

  it("every node's counts agree with one hop from each", () => {
    const all = reachCounts(ix, "direct");
    for (const n of g.nodes) {
      const r = reachOf(ix, n.id, "direct");
      expect(all.get(n.id), n.id).toEqual({ out: r.out.size, in: r.in.size });
    }
  });
});

describe("a filter that hides", () => {
  const g: GraphData = {
    nodes: [
      node("box"),
      { ...node("x1", "lab"), kind: "esxi", state: "live" },
      { ...node("x2", "lab"), kind: "linux", mark: "warn" },
      { ...node("y1", "web"), kind: "esxi", state: "down" },
      { ...node("y2", "web"), kind: "linux", mark: "error" },
    ],
    edges: [edge("box", "lab"), edge("box", "web"), edge("x1", "y1"), edge("x2", "x1")],
    clusters: [
      { id: "lab", title: "lab" },
      { id: "web", title: "web" },
    ],
  };
  const ids = (f: Parameters<typeof filterGraph>[1]) => filterGraph(g, f).nodes.map((n) => n.id);

  it("keeps the nodes in any of the clusters, kinds or states it names, every dimension at once", () => {
    expect(ids({ clusters: ["lab"] })).toEqual(["x1", "x2"]);
    expect(ids({ kinds: ["esxi"] })).toEqual(["x1", "y1"]);
    expect(ids({ states: ["live", "error"] })).toEqual(["x1", "y2"]);
    expect(ids({ kinds: ["esxi"], clusters: ["web"] })).toEqual(["y1"]);
    expect(ids({ states: ["warn"] })).toEqual(["x2"]);
  });

  it("an empty filter hides nothing", () => {
    expect(filterGraph(g, {})).toBe(g);
  });

  it("takes away edges with a hidden end, and clusters with no node left", () => {
    const f = filterGraph(g, { kinds: ["linux"] });
    expect(f.edges).toEqual([]);
    expect(f.clusters.map((c) => c.id)).toEqual(["lab", "web"]);
    const lab = filterGraph(g, { clusters: ["lab"] });
    expect(lab.edges.map((e) => e.id)).toEqual(["x2>x1"]);
    expect(lab.clusters.map((c) => c.id)).toEqual(["lab"]);
  });
});
