import { describe, expect, it } from "vitest";
import { layoutGraph, SPACING, type Layout } from "./layout";
import type { GraphData, GraphNode } from "./model";

const node = (id: string, cluster?: string): GraphNode => ({ id, label: id, shape: "dot", ...(cluster ? { cluster } : {}) });

function bigGraph(n: number, groups: number): GraphData {
  return {
    nodes: [node("box"), ...Array.from({ length: n }, (_, i) => node(`h${i}`, `g${i % groups}`))],
    edges: [],
    clusters: Array.from({ length: groups }, (_, i) => ({ id: `g${i}`, title: `group ${i}` })),
  };
}

const at = (l: Layout, id: string) => l.nodes.get(id);

function closest(l: Layout): number {
  const ps = [...l.nodes.values()];
  let best = Infinity;
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i]!;
      const b = ps[j]!;
      best = Math.min(best, Math.hypot(a.x - b.x, a.y - b.y));
    }
  return best;
}

/** Pairs of clusters whose circles overlap. */
function overlaps(l: Layout): string[] {
  const cs = [...l.clusters.entries()];
  const out: string[] = [];
  for (let i = 0; i < cs.length; i++)
    for (let j = i + 1; j < cs.length; j++) {
      const [a, p] = cs[i]!;
      const [b, q] = cs[j]!;
      if (Math.hypot(p.x - q.x, p.y - q.y) < p.r + q.r) out.push(`${a}/${b}`);
    }
  return out;
}

describe("the graph's layout", () => {
  it("is the same every time for the same graph", () => {
    const g = bigGraph(200, 7);
    expect([...layoutGraph(g).nodes]).toEqual([...layoutGraph(g).nodes]);
  });

  it("keeps nodes apart and each cluster's nodes inside its circle, and clusters apart", () => {
    const g = bigGraph(300, 6);
    const l = layoutGraph(g);
    expect(closest(l)).toBeGreaterThan(SPACING * 0.75);
    for (const n of g.nodes) {
      if (!n.cluster) continue;
      const c = l.clusters.get(n.cluster)!;
      const p = at(l, n.id)!;
      expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThan(c.r);
    }
    const cs = [...l.clusters.values()];
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) expect(Math.hypot(cs[i]!.x - cs[j]!.x, cs[i]!.y - cs[j]!.y)).toBeGreaterThan(cs[i]!.r + cs[j]!.r);
  });

  it("keeps saved positions: a new node and a new cluster move nothing that was placed", () => {
    const g = bigGraph(60, 3);
    const first = layoutGraph(g);
    const saved = first.saved;
    const more: GraphData = {
      ...g,
      nodes: [...g.nodes, node("new-1", "g1"), node("new-2", "g9")],
      clusters: [...g.clusters, { id: "g9", title: "late" }],
    };
    const second = layoutGraph(more, saved);
    for (const n of g.nodes) expect(at(second, n.id)).toEqual(at(first, n.id));
    for (const c of g.clusters) expect(second.clusters.get(c.id)).toMatchObject({ x: first.clusters.get(c.id)!.x, y: first.clusters.get(c.id)!.y });
    expect(closest(second)).toBeGreaterThan(SPACING * 0.5);
    const late = second.clusters.get("g9")!;
    for (const c of g.clusters) {
      const o = second.clusters.get(c.id)!;
      expect(Math.hypot(o.x - late.x, o.y - late.y)).toBeGreaterThan(o.r + late.r);
    }
  });

  it("moves a cluster that grew into its neighbours out of their way, its nodes with it, and nothing else", () => {
    // Topology sends its clusters small and fills them as each Host's details arrive.
    const small = bigGraph(12, 6);
    const first = layoutGraph(small);
    const grown: GraphData = { ...small, nodes: [...small.nodes, ...Array.from({ length: 80 }, (_, i) => node(`late${i}`, "g2"))] };
    const second = layoutGraph(grown, first.saved);
    expect(overlaps(second)).toEqual([]);
    for (const c of small.clusters.filter((c) => c.id !== "g2")) expect(second.clusters.get(c.id)).toMatchObject({ x: first.clusters.get(c.id)!.x, y: first.clusters.get(c.id)!.y });
    // g2's nodes keep their shape: each moved as far as its centre did.
    const from = first.clusters.get("g2")!;
    const to = second.clusters.get("g2")!;
    for (const n of small.nodes.filter((n) => n.cluster === "g2")) expect(at(second, n.id)).toEqual({ x: at(first, n.id)!.x + to.x - from.x, y: at(first, n.id)!.y + to.y - from.y });
    for (const n of grown.nodes.filter((n) => n.cluster === "g2")) {
      const p = at(second, n.id)!;
      expect(Math.hypot(p.x - to.x, p.y - to.y)).toBeLessThan(to.r);
    }
  });

  it("every cluster growing at once still ends up apart, quickly", () => {
    const first = layoutGraph(bigGraph(40, 40));
    const t = performance.now();
    const second = layoutGraph(bigGraph(2000, 40), first.saved);
    expect(performance.now() - t).toBeLessThan(150);
    expect(overlaps(second)).toEqual([]);
  });

  it("a node the user drags out past a neighbour moves nothing else: only clusters that got new nodes move", () => {
    const g = bigGraph(120, 3);
    const l = layoutGraph(g);
    const a = l.clusters.get("g0")!;
    const b = l.clusters.get("g1")!;
    // One of g0's nodes dragged right over g1, so g0's circle now reaches it.
    const dragged = g.nodes.find((n) => n.cluster === "g0")!.id;
    const saved = structuredClone(l.saved);
    saved.nodes[dragged] = [b.x, b.y];
    const after = layoutGraph(g, saved);
    for (const c of g.clusters) expect(after.clusters.get(c.id)).toMatchObject({ x: l.clusters.get(c.id)!.x, y: l.clusters.get(c.id)!.y });
    expect(at(after, dragged)).toEqual({ x: b.x, y: b.y });
    expect(after.clusters.get("g0")).toMatchObject({ x: a.x, y: a.y });
  });

  it("lays out 2,000 nodes in 40 clusters quickly", () => {
    const g = bigGraph(2000, 40);
    const t = performance.now();
    const l = layoutGraph(g);
    expect(performance.now() - t).toBeLessThan(150);
    expect(l.nodes.size).toBe(2001);
  });

  it("a node whose cluster is unknown is loose", () => {
    const l = layoutGraph({ nodes: [node("a", "nowhere"), node("b")], edges: [], clusters: [] });
    expect(l.nodes.size).toBe(2);
  });
});
