// A cluster's title on the map (T89): whole when there's room, even past a small circle, and cut
// only where it would cover another title.
import { describe, expect, it } from "vitest";
import { drawFrame, fitTitle, toScreen, type Palette } from "./draw";
import { layoutGraph } from "./layout";
import type { Scene } from "./scene";
import { budget } from "../test-budget";

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
  });

  it("where the whole one would cover another, is cut to the room that's free, and isn't drawn over another title (#237)", () => {
    const roomFor = (w: number) => (x: number) => x <= w;
    expect(fitTitle(measure, "subnet-1 · password peers", false, 30, roomFor(20 * 7))).toBe("subnet-1 · password…");
    expect(fitTitle(measure, "subnet-1 · password peers", false, 30, roomFor(0))).toBeNull();
  });

  it("is cut at a long title's end, never past the room a big circle gives", () => {
    const long = "x".repeat(200);
    const got = fitTitle(measure, long, false, 600, free)!;
    expect(measure(got)).toBeLessThanOrEqual(600);
    expect(got.endsWith("…")).toBe(true);
  });
});

/** A canvas that draws nothing and keeps the text it was asked to write, and where (centred). */
function recorder() {
  const texts: string[] = [];
  const boxes: { x: number; y: number; w: number }[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "measureText") return (s: string) => ({ width: measure(s) });
      if (k === "fillText")
        return (s: string, x: number, y: number) => {
          texts.push(s);
          boxes.push({ x: x - measure(s) / 2, y, w: measure(s) });
        };
      if (k in t) return t[k];
      return () => undefined;
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, texts, boxes };
}

/** Pairs of titles drawn over each other. */
function covered(boxes: readonly { x: number; y: number; w: number }[], lh: number): number {
  let n = 0;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (Math.abs(a.y - b.y) < lh - 0.5 && a.x < b.x + b.w && b.x < a.x + a.w) n++;
    }
  return n;
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

  it("zoomed out on dense rows, no title is drawn over another (#237)", () => {
    // 100 clusters of 10, laid out as the graph does, with titles far wider than their circles.
    const g = {
      nodes: Array.from({ length: 1000 }, (_, i) => ({ id: `h${i}`, label: `h${i}`, shape: "dot" as const, cluster: `g${i % 100}` })),
      edges: [],
      clusters: Array.from({ length: 100 }, (_, i) => ({ id: `g${i}`, title: `subnet-${i} · password peers` })),
    };
    const l = layoutGraph(g);
    const scene: Scene = {
      nodes: [],
      byId: new Map(),
      edges: [],
      clusters: g.clusters.map((c) => ({ ...c, ...l.clusters.get(c.id)!, mesh: false, count: 10, collapsed: false })),
      shownAs: new Map(),
    };
    const xs = scene.clusters.flatMap((c) => [c.x - c.r, c.x + c.r]);
    const ys = scene.clusters.flatMap((c) => [c.y - c.r, c.y + c.r]);
    const centre = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    for (const k of [0.27, 0.22, 0.17]) {
      const { ctx, texts, boxes } = recorder();
      drawFrame(ctx, { scene, camera: { ...centre, k }, width: 1400, height: 800, palette: PALETTE, selected: null, highlight: null, matches: null, drawing: new Map() });
      expect(covered(boxes, PALETTE.size * 1.3), `at zoom ${k}`).toBe(0);
      // Most still have a title, and none is cut shorter than its number.
      expect(texts.length, `at zoom ${k}`).toBeGreaterThan(50);
      for (const t of texts) expect(t).toMatch(/^subnet-\d+/);
    }
    // The selected node's cluster always has its title, whatever its neighbours.
    for (const c of scene.clusters) {
      const n = { id: `in-${c.id}`, x: c.x, y: c.y, label: "x", node: { id: `in-${c.id}`, label: "x", shape: "dot" as const, cluster: c.id } };
      const { ctx, texts } = recorder();
      drawFrame(ctx, { scene: { ...scene, byId: new Map([[n.id, n]]) }, camera: { ...centre, k: 0.17 }, width: 1400, height: 800, palette: PALETTE, selected: n.id, highlight: null, matches: null, drawing: new Map() });
      const name = c.title.split(" ")[0]!;
      expect(texts.some((t) => t.startsWith(`${name} `) || t === `${name}…`)).toBe(true);
    }
  });

  it("the selected node's cluster keeps its title even packed between rows above and below", () => {
    const cluster = (id: string, y: number) => ({ id, title: `${id} · password peers`, x: 0, y, r: 100, mesh: false, count: 3, collapsed: false });
    const n = { id: "n", x: 0, y: 0, label: "n", node: { id: "n", label: "n", shape: "dot" as const, cluster: "mid" } };
    const scene: Scene = { nodes: [], byId: new Map([["n", n]]), edges: [], clusters: [cluster("up", -205), cluster("mid", 0), cluster("down", 205)], shownAs: new Map() };
    const frame = (selected: string | null) => {
      const { ctx, texts } = recorder();
      drawFrame(ctx, { scene, camera: { x: 0, y: 0, k: 0.2 }, width: 800, height: 600, palette: PALETTE, selected, highlight: null, matches: null, drawing: new Map() });
      return texts;
    };
    expect(frame(null).some((t) => t.startsWith("mid"))).toBe(false);
    expect(frame("n").some((t) => t.startsWith("mid"))).toBe(true);
  });

  it("places 500 clusters' titles, none over another: those that can't be placed give way (#237)", () => {
    const { ctx, texts, boxes } = recorder();
    drawFrame(ctx, fiveHundred);
    const shown = fiveHundred.scene.clusters.filter((c) => {
      const s = toScreen(fiveHundred.camera, fiveHundred.width, fiveHundred.height, c.x, c.y);
      const pad = 40 + c.r * fiveHundred.camera.k;
      return s.x > -pad && s.y > -pad && s.x < fiveHundred.width + pad && s.y < fiveHundred.height + pad;
    });
    expect(shown.length).toBeGreaterThan(400);
    // 60 px apart on screen, each title 168 px wide: before #237 all 450 were drawn, 101 pairs over each other.
    expect(covered(boxes, PALETTE.size * 1.3)).toBe(0);
    expect(texts.length).toBeGreaterThan(300);
    for (const t of texts) expect(t).toMatch(/^group \d+/);
  });

  budget("places 500 clusters' titles within a frame's budget", () => {
    const { ctx } = recorder();
    drawFrame(ctx, fiveHundred);
    const t = performance.now();
    for (let i = 0; i < 5; i++) drawFrame(ctx, fiveHundred);
    expect((performance.now() - t) / 5).toBeLessThan(16);
  });
});

/** 500 open clusters in a 25 by 20 grid, most of them on screen at this zoom. */
const fiveHundred = {
  scene: {
    nodes: [],
    byId: new Map(),
    edges: [],
    clusters: Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, title: `group ${i} · password peers`, x: (i % 25) * 300, y: Math.floor(i / 25) * 300, r: 120, mesh: i % 3 === 0, count: 4, collapsed: false })),
    shownAs: new Map(),
  } satisfies Scene,
  camera: { x: 3600, y: 2850, k: 0.2 },
  width: 1600,
  height: 1000,
  palette: PALETTE,
  selected: null,
  highlight: null,
  matches: null,
  drawing: new Map(),
};
