import { describe, expect, it } from "vitest";
import { layoutGraph, SPACING, type Layout } from "./layout";
import type { GraphData, GraphNode } from "./model";
import { budget } from "../test-budget";

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

  it("every cluster growing at once still ends up apart", () => {
    const first = layoutGraph(bigGraph(40, 40));
    const second = layoutGraph(bigGraph(2000, 40), first.saved);
    expect(overlaps(second)).toEqual([]);
  });

  budget("every cluster growing at once ends up apart quickly", () => {
    const first = layoutGraph(bigGraph(40, 40));
    const t = performance.now();
    layoutGraph(bigGraph(2000, 40), first.saved);
    expect(performance.now() - t).toBeLessThan(150);
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
    saved.moved = [dragged];
    const after = layoutGraph(g, saved);
    for (const c of g.clusters) expect(after.clusters.get(c.id)).toMatchObject({ x: l.clusters.get(c.id)!.x, y: l.clusters.get(c.id)!.y });
    expect(at(after, dragged)).toEqual({ x: b.x, y: b.y });
    expect(after.clusters.get("g0")).toMatchObject({ x: a.x, y: a.y });
  });

  it("a node the user placed stays where they put it when its cluster grows and moves (#237)", () => {
    const small = bigGraph(12, 6);
    const first = layoutGraph(small);
    // One of g2's nodes dragged well clear of every cluster, below them all.
    const dragged = small.nodes.find((n) => n.cluster === "g2")!.id;
    const bottom = Math.round(Math.max(...[...first.clusters.values()].map((c) => c.y + c.r)));
    const saved = structuredClone(first.saved);
    saved.nodes[dragged] = [first.clusters.get("g2")!.x, bottom + 2000];
    saved.moved = [dragged];
    const grown: GraphData = { ...small, nodes: [...small.nodes, ...Array.from({ length: 80 }, (_, i) => node(`late${i}`, "g2"))] };
    const second = layoutGraph(grown, saved);
    expect(second.clusters.get("g2")).not.toMatchObject({ x: first.clusters.get("g2")!.x, y: first.clusters.get("g2")!.y });
    // g2 moved clear of the others (its circle still takes in the far node, as a drag makes it).
    for (const n of grown.nodes.filter((n) => n.cluster === "g2" && n.id !== dragged)) {
      const p = at(second, n.id)!;
      for (const c of small.clusters.filter((c) => c.id !== "g2")) {
        const o = second.clusters.get(c.id)!;
        expect(Math.hypot(p.x - o.x, p.y - o.y)).toBeGreaterThan(o.r);
      }
    }
    expect(at(second, dragged)).toEqual({ x: first.clusters.get("g2")!.x, y: bottom + 2000 });
    // The flag is kept, for the next time.
    expect(second.saved.moved).toEqual([dragged]);
  });

  it("a saved layout whose clusters overlap (saved by an older version) is healed on load (#237)", () => {
    const g = bigGraph(120, 3);
    const l = layoutGraph(g);
    const a = l.clusters.get("g0")!;
    // An older version let g1 grow over g0 and saved it so: no node of it was moved by the user.
    const saved = structuredClone(l.saved);
    const b = l.clusters.get("g1")!;
    const dx = a.x + 10 - b.x;
    saved.clusters["g1"] = [a.x + 10, b.y];
    for (const n of g.nodes.filter((n) => n.cluster === "g1")) saved.nodes[n.id] = [saved.nodes[n.id]![0] + dx, saved.nodes[n.id]![1]];
    const healed = layoutGraph(g, saved);
    expect(overlaps(healed)).toEqual([]);
    // The first one stays; the one on top of it moves, whole.
    expect(healed.clusters.get("g0")).toMatchObject({ x: a.x, y: a.y });
    expect(closest(healed)).toBeGreaterThan(SPACING * 0.75);
  });

  it("a cluster the user placed stays where they put it, and a neighbour it lands on makes room (#237)", () => {
    const g = bigGraph(120, 3);
    const l = layoutGraph(g);
    const a = l.clusters.get("g0")!;
    const b = l.clusters.get("g1")!;
    // g1 moved whole, by the user, right on top of g0: its nodes went with it.
    const saved = structuredClone(l.saved);
    const dx = a.x + 10 - b.x;
    const dy = a.y - b.y;
    saved.clusters["g1"] = [a.x + 10, a.y];
    for (const n of g.nodes.filter((n) => n.cluster === "g1")) saved.nodes[n.id] = [saved.nodes[n.id]![0] + dx, saved.nodes[n.id]![1] + dy];
    saved.movedClusters = ["g1"];
    const after = layoutGraph(g, saved);
    expect(overlaps(after)).toEqual([]);
    expect(after.clusters.get("g1")).toMatchObject({ x: a.x + 10, y: a.y });
    for (const n of g.nodes.filter((n) => n.cluster === "g1")) expect(at(after, n.id)).toEqual({ x: at(l, n.id)!.x + dx, y: at(l, n.id)!.y + dy });
    expect(after.clusters.get("g0")).not.toMatchObject({ x: a.x, y: a.y });
    // The flag is kept, for the next time.
    expect(after.saved.movedClusters).toEqual(["g1"]);
  });

  it("a cluster put on a neighbour moves only that neighbour, to a place no other cluster has (#237)", () => {
    const g = bigGraph(320, 16);
    const l = layoutGraph(g);
    const a = l.clusters.get("g10")!;
    const b = l.clusters.get("g15")!;
    const saved = structuredClone(l.saved);
    saved.clusters["g15"] = [a.x + 5, a.y + 5];
    for (const n of g.nodes.filter((n) => n.cluster === "g15")) saved.nodes[n.id] = [saved.nodes[n.id]![0] + a.x + 5 - b.x, saved.nodes[n.id]![1] + a.y + 5 - b.y];
    saved.movedClusters = ["g15"];
    const after = layoutGraph(g, saved);
    expect(overlaps(after)).toEqual([]);
    const moved = g.clusters.filter((c) => c.id !== "g15" && (after.clusters.get(c.id)!.x !== l.clusters.get(c.id)!.x || after.clusters.get(c.id)!.y !== l.clusters.get(c.id)!.y)).map((c) => c.id);
    expect(moved).toEqual(["g10"]);
  });

  it("of two clusters the user placed on each other, the one placed last stays (#237)", () => {
    const g = bigGraph(120, 3);
    const l = layoutGraph(g);
    const a = l.clusters.get("g0")!;
    const b = l.clusters.get("g1")!;
    const saved = structuredClone(l.saved);
    saved.clusters["g1"] = [a.x + 10, a.y];
    for (const n of g.nodes.filter((n) => n.cluster === "g1")) saved.nodes[n.id] = [saved.nodes[n.id]![0] + a.x + 10 - b.x, saved.nodes[n.id]![1] + a.y - b.y];
    saved.movedClusters = ["g1", "g0"];
    const after = layoutGraph(g, saved);
    expect(overlaps(after)).toEqual([]);
    expect(after.clusters.get("g0")).toMatchObject({ x: a.x, y: a.y });
  });

  it("a cluster held while it's being moved pushes nothing and stays exactly under the user (#237)", () => {
    const g = bigGraph(120, 3);
    const l = layoutGraph(g);
    const a = l.clusters.get("g0")!;
    const saved = structuredClone(l.saved);
    const b = l.clusters.get("g1")!;
    saved.clusters["g1"] = [a.x + 10, a.y];
    for (const n of g.nodes.filter((n) => n.cluster === "g1")) saved.nodes[n.id] = [saved.nodes[n.id]![0] + a.x + 10 - b.x, saved.nodes[n.id]![1] + a.y - b.y];
    saved.movedClusters = ["g1"];
    const held = layoutGraph(g, saved, { holding: "g1" });
    expect(held.clusters.get("g1")).toMatchObject({ x: a.x + 10, y: a.y });
    for (const c of ["g0", "g2"]) expect(held.clusters.get(c)).toMatchObject({ x: l.clusters.get(c)!.x, y: l.clusters.get(c)!.y });
  });

  it("lays out 2,000 nodes in 40 clusters", () => {
    const l = layoutGraph(bigGraph(2000, 40));
    expect(l.nodes.size).toBe(2001);
    expect(overlaps(l)).toEqual([]);
  });

  budget("lays out 2,000 nodes in 40 clusters quickly", () => {
    const g = bigGraph(2000, 40);
    const t = performance.now();
    layoutGraph(g);
    expect(performance.now() - t).toBeLessThan(150);
  });

  it("a node whose cluster is unknown is loose", () => {
    const l = layoutGraph({ nodes: [node("a", "nowhere"), node("b")], edges: [], clusters: [] });
    expect(l.nodes.size).toBe(2);
  });
});
