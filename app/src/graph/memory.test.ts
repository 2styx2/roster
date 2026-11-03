import { describe, expect, it } from "vitest";
import { GRAPHS_KEY, GraphMemory, GraphPlaces, KEPT_GRAPHS } from "./memory";
import type { GraphData } from "./model";

function fakeStore(init: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = { ...init };
  return { state, get: (k: string) => state[k], set: (k: string, v: unknown) => void (state[k] = v) };
}

describe("a graph's place in the State", () => {
  it("keeps positions and folds per view, and reads them back", () => {
    const store = fakeStore();
    const m = new GraphMemory(store);
    m.save("topology/topology", { layout: { nodes: { a: [1, 2] }, clusters: { "": [0, 0] } }, folds: { lab: true } });
    expect(new GraphMemory(store).load("topology/topology")).toEqual({ layout: { nodes: { a: [1, 2] }, clusters: { "": [0, 0] } }, folds: { lab: true } });
    expect(m.load("other/view")).toEqual({ folds: {} });
  });

  it("keeps the most recent few graphs", () => {
    const store = fakeStore();
    const m = new GraphMemory(store);
    for (let i = 0; i <= KEPT_GRAPHS; i++) m.save(`p/v${i}`, { folds: {} });
    expect((store.state[GRAPHS_KEY] as unknown[]).length).toBe(KEPT_GRAPHS);
    expect(m.load("p/v0")).toEqual({ folds: {} });
    expect(m.load(`p/v${KEPT_GRAPHS}`)).toEqual({ folds: {} });
  });

  it("ignores what it can't read", () => {
    const store = fakeStore({ [GRAPHS_KEY]: [{ key: "p/v", nodes: { a: ["x", 2], b: [3, 4] }, clusters: "no", folds: { lab: "yes", web: false } }, 7] });
    expect(new GraphMemory(store).load("p/v")).toEqual({ layout: { nodes: { b: [3, 4] }, clusters: {} }, folds: { web: false } });
  });

  it("keeps which nodes the user placed, and reads a State saved before that as none (#237)", () => {
    const store = fakeStore({ [GRAPHS_KEY]: [{ key: "old/v", nodes: { a: [1, 2] }, clusters: { "": [0, 0] }, folds: {} }] });
    const m = new GraphMemory(store);
    expect(m.load("old/v")).toEqual({ layout: { nodes: { a: [1, 2] }, clusters: { "": [0, 0] } }, folds: {} });
    m.save("p/v", { layout: { nodes: { a: [1, 2], b: [3, 4] }, clusters: {}, moved: ["b"] }, folds: {} });
    expect(new GraphMemory(store).load("p/v")).toEqual({ layout: { nodes: { a: [1, 2], b: [3, 4] }, clusters: {}, moved: ["b"] }, folds: {} });
  });

  it("ignores a moved list it can't read", () => {
    const store = fakeStore({ [GRAPHS_KEY]: [{ key: "p/v", nodes: { a: [1, 2] }, clusters: {}, moved: ["a", 7, null], folds: {} }, { key: "q/v", nodes: { a: [1, 2] }, clusters: {}, moved: "a", folds: {} }] });
    const m = new GraphMemory(store);
    expect(m.load("p/v").layout?.moved).toEqual(["a"]);
    expect(m.load("q/v").layout?.moved).toBeUndefined();
  });
});

describe("one open graph's places", () => {
  const g: GraphData = { nodes: [{ id: "a", label: "a", shape: "dot", cluster: "web" }, { id: "b", label: "b", shape: "dot", cluster: "web" }], edges: [], clusters: [{ id: "web", title: "web" }] };

  it("a node the user moves is kept as theirs; one put back is as it was", () => {
    const store = fakeStore();
    const places = new GraphPlaces(new GraphMemory(store), "p/v");
    const l = places.layout(g);
    places.move("a", 500, 600);
    const b = l.nodes.get("b")!;
    places.move("b", b.x + 30, b.y);
    places.move("b", b.x, b.y, false);
    places.layout(g);
    places.persist();
    expect(new GraphMemory(store).load("p/v").layout).toMatchObject({ nodes: { a: [500, 600], b: [b.x, b.y] }, moved: ["a"] });
  });

  it("a cluster the user moves takes its nodes along, keeps their shape, and is kept as theirs (#237)", () => {
    const store = fakeStore();
    const places = new GraphPlaces(new GraphMemory(store), "p/v");
    const l = places.layout(g);
    const c = l.clusters.get("web")!;
    const a = l.nodes.get("a")!;
    const b = l.nodes.get("b")!;
    places.moveCluster("web", c.x + 500, c.y - 200);
    const after = places.layout(g);
    expect(after.clusters.get("web")).toMatchObject({ x: c.x + 500, y: c.y - 200 });
    expect(after.nodes.get("a")).toEqual({ x: a.x + 500, y: a.y - 200 });
    expect(after.nodes.get("b")).toEqual({ x: b.x + 500, y: b.y - 200 });
    expect(places.clusterPlacedByUser("web")).toBe(true);
    places.persist();
    const kept = new GraphMemory(store).load("p/v").layout;
    expect(kept).toMatchObject({ clusters: { web: [c.x + 500, c.y - 200] }, movedClusters: ["web"] });
    // A State read back gives the same places.
    const again = new GraphPlaces(new GraphMemory(store), "p/v").layout(g);
    expect(again.nodes.get("a")).toEqual({ x: a.x + 500, y: a.y - 200 });
    // Put back where it was, it's the layout's again.
    places.moveCluster("web", c.x, c.y, false);
    expect(places.layout(g).nodes.get("b")).toEqual(b);
    expect(places.clusterPlacedByUser("web")).toBe(false);
  });

  it("ignores a moved-clusters list it can't read", () => {
    const store = fakeStore({ [GRAPHS_KEY]: [{ key: "p/v", nodes: { a: [1, 2] }, clusters: { web: [0, 0] }, movedClusters: ["web", 3], folds: {} }, { key: "q/v", nodes: { a: [1, 2] }, clusters: {}, movedClusters: "web", folds: {} }] });
    const m = new GraphMemory(store);
    expect(m.load("p/v").layout?.movedClusters).toEqual(["web"]);
    expect(m.load("q/v").layout?.movedClusters).toBeUndefined();
  });
});
