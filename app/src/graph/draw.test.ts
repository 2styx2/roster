// A cluster's title on the map (T89): whole when there's room, even past a small circle, and cut
// only where it would cover another title.
import { describe, expect, it } from "vitest";
import { drawFrame, fitTitle, type Palette } from "./draw";
import type { Scene } from "./scene";

// Iosevka is monospaced: 7 px a character at the map's size.
const measure = (s: string) => Array.from(s).length * 7;
const free = () => true;

describe("a cluster's title", () => {
  it("is whole over a small circle when nothing else is there", () => {
    expect(fitTitle(measure, "subnet-1 · password peers", false, 30, free)).toBe("subnet-1 · password peers");
    expect(fitTitle(measure, "lab", true, 30, free)).toBe("lab · mesh");
  });

  it("drops · mesh before cutting the name, where the whole one would cover another title", () => {
    const roomFor = (w: number) => (x: number) => x <= w;
    expect(fitTitle(measure, "subnet-1 · not in the Mesh", true, 30, roomFor(26 * 7))).toBe("subnet-1 · not in the Mesh");
    expect(fitTitle(measure, "subnet-1 · password peers", false, 30, roomFor(0))).toBe("subnet-1 ·…");
  });

  it("is cut at a long title's end, never past the room a big circle gives", () => {
    const long = "x".repeat(200);
    const got = fitTitle(measure, long, false, 600, free);
    expect(measure(got)).toBeLessThanOrEqual(600);
    expect(got.endsWith("…")).toBe(true);
  });
});

/** A canvas that draws nothing and keeps the text it was asked to write. */
function recorder() {
  const texts: string[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "measureText") return (s: string) => ({ width: measure(s) });
      if (k === "fillText") return (s: string) => texts.push(s);
      if (k in t) return t[k];
      return () => undefined;
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, texts };
}

const PALETTE: Palette = { bg: "#fff", text: "#000", muted: "#666", faint: "#999", line: "#ccc", lineStrong: "#888", accent: "#f80", tone: "#0aa", warn: "#a80", error: "#c00", raised: "#eee", mono: "monospace", ui: "sans-serif", size: 13 };

describe("cluster titles on the map", () => {
  it("zoomed right out, three clusters side by side each keep their whole title (T99)", () => {
    // Topology's subnet-1, its password peers and those it reaches outside the Mesh, as laid out.
    const cluster = (id: string, title: string, x: number, r: number, mesh = false) => ({ id, title, x, y: 455, r, mesh, count: 9, collapsed: false });
    const scene: Scene = {
      nodes: [],
      byId: new Map(),
      edges: [],
      clusters: [cluster("a", "subnet-1", 591, 455, true), cluster("b", "subnet-1 · password peers", 1444, 333), cluster("c", "subnet-1 · not in the Mesh", 2087, 245)],
      shownAs: new Map(),
    };
    for (const k of [0.16, 0.12, 0.08]) {
      const { ctx, texts } = recorder();
      drawFrame(ctx, { scene, camera: { x: 1339, y: 455, k }, width: 1200, height: 800, palette: PALETTE, selected: null, highlight: null, matches: null, drawing: new Map() });
      expect(texts.sort(), `at zoom ${k}`).toEqual(["subnet-1 · mesh", "subnet-1 · not in the Mesh", "subnet-1 · password peers"]);
    }
  });

  it("places 500 clusters' titles within a frame's budget", () => {
    const clusters = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, title: `group ${i} · password peers`, x: (i % 25) * 300, y: Math.floor(i / 25) * 300, r: 120, mesh: i % 3 === 0, count: 4, collapsed: false }));
    const scene: Scene = { nodes: [], byId: new Map(), edges: [], clusters, shownAs: new Map() };
    const { ctx } = recorder();
    const frame = { scene, camera: { x: 3600, y: 2850, k: 0.2 }, width: 1600, height: 1000, palette: PALETTE, selected: null, highlight: null, matches: null, drawing: new Map() };
    drawFrame(ctx, frame);
    const t = performance.now();
    for (let i = 0; i < 5; i++) drawFrame(ctx, frame);
    expect((performance.now() - t) / 5).toBeLessThan(16);
  });
});
