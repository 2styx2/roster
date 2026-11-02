import { describe, expect, it } from "vitest";
import { GRAPHS_KEY, GraphMemory, KEPT_GRAPHS } from "./memory";

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
});
