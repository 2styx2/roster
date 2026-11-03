// Dragging in a Plugin's graph, end to end (T179, #341; the drag is #237's, decision Q160): the
// whole app (index.html) on the fake Backend's `plugin-graph` fixture (640 Hosts in 16 collapsed
// clusters) in headless Chromium, with real pointer events on the real canvas. jsdom has no canvas,
// so the camera is never set there and no drag can be checked; here it is.
//
// What's drawn is read from the canvas's own calls: every frame starts with a fill of the whole
// canvas, a collapsed cluster is a circle of STAND_IN_RADIUS with its title under it, and the
// selected node's ring is the frame's last circle (draw.ts drawFrame). A fixture's State is never
// saved, so a place kept is checked by closing the view and opening it again (the State lives on in
// the app): what was left is drawn in the same place relative to the clusters that didn't move.
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { launch } from "./browser";
// Not imported, as those modules are the browser's: the fake Backend's master password
// (src/backend/fake.ts FAKE_PASSWORD) and a collapsed cluster's radius (src/graph/draw.ts).
const FAKE_PASSWORD = "correct horse";
const STAND_IN_RADIUS = 12;

let browser: Browser;
let context: BrowserContext | null = null;

beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});
afterEach(async () => {
  await context?.close();
  context = null;
});

interface Point {
  x: number;
  y: number;
}
interface Drawn {
  arcs: { x: number; y: number; r: number }[];
  texts: { t: string; x: number; y: number; align: string; w: number }[];
}
type Canvas2D = HTMLCanvasElement & { e2eFrame?: Drawn };

/** Records each canvas's last frame: its circles and its text, in canvas pixels. */
function recordFrames() {
  const P = CanvasRenderingContext2D.prototype;
  const { arc, fillText, fillRect } = P;
  P.fillRect = function (this: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    if (x === 0 && y === 0) (this.canvas as Canvas2D).e2eFrame = { arcs: [], texts: [] };
    fillRect.call(this, x, y, w, h);
  };
  P.arc = function (this: CanvasRenderingContext2D, x: number, y: number, r: number, ...rest: [number, number, boolean?]) {
    (this.canvas as Canvas2D).e2eFrame?.arcs.push({ x, y, r });
    arc.call(this, x, y, r, ...rest);
  };
  P.fillText = function (this: CanvasRenderingContext2D, t: string, x: number, y: number, max?: number) {
    (this.canvas as Canvas2D).e2eFrame?.texts.push({ t, x, y, align: this.textAlign, w: this.measureText(t).width });
    fillText.call(this, t, x, y, max);
  };
}

/** The app unlocked, the demo map open and focused. */
async function openApp(): Promise<Page> {
  context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.addInitScript(recordFrames);
  const page = await context.newPage();
  await page.goto(`${inject("appUrl")}?fixture=plugin-graph&toggle=off`);
  await page.getByLabel(/master password/i).fill(FAKE_PASSWORD);
  await page.keyboard.press("Enter");
  await page.getByRole("group", { name: "Inventory" }).getByRole("treeitem").first().waitFor();
  await openView(page);
  return page;
}

async function openView(page: Page) {
  await page.keyboard.press("Control+Space");
  await page.keyboard.type(":view demo-map");
  await page.keyboard.press("Enter");
  await page.getByRole("application", { name: "Topology" }).waitFor();
  await page.waitForFunction(() => document.querySelector<Canvas2D>('[role="application"] canvas')?.e2eFrame !== undefined);
  await frames(page);
}

/** Closes the view: Esc clears the search, then closes it. */
async function closeView(page: Page) {
  const view = page.getByRole("application", { name: "Topology" });
  await view.focus();
  while (await view.count()) await page.keyboard.press("Escape");
}

/** Lets React render what the last event changed and the canvas draw it (two frames). */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** The graph canvas's last frame, and its size. */
async function drawn(page: Page): Promise<Drawn & { w: number; h: number; left: number; top: number }> {
  return page.evaluate(() => {
    const c = document.querySelector<Canvas2D>('[role="application"] canvas');
    if (!c?.e2eFrame) throw new Error("no graph frame");
    const r = c.getBoundingClientRect();
    return { ...c.e2eFrame, w: r.width, h: r.height, left: r.left, top: r.top };
  });
}

/** In the page's coordinates. */
type Frame = Awaited<ReturnType<typeof drawn>>;

/** The selected node's ring: the frame's last circle. */
function ring(f: Frame): Point {
  const a = f.arcs.at(-1);
  if (!a) throw new Error("nothing drawn");
  return { x: f.left + a.x, y: f.top + a.y };
}

/** Collapsed cluster `id`'s centre: the circle its title is under. */
function cluster(f: Frame, id: string): Point | null {
  const t = f.texts.find((x) => x.t === id && x.align === "left");
  if (!t) return null;
  const cx = t.x + t.w / 2;
  const a = f.arcs.find((c) => c.r === STAND_IN_RADIUS && Math.abs(c.x - cx) < 1 && t.y - c.y > STAND_IN_RADIUS && t.y - c.y < 40);
  return a ? { x: f.left + a.x, y: f.top + a.y } : null;
}

/** Every collapsed cluster drawn with its title, by id. */
function clusters(f: Frame): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const t of f.texts) {
    if (!/^subnet-\d+$/.test(t.t)) continue;
    const p = cluster(f, t.t);
    if (p) out.set(t.t, p);
  }
  return out;
}

/** Selects what the search finds first, and waits until the graph says it's selected. */
async function find(page: Page, query: string) {
  await page.getByRole("application", { name: "Topology" }).focus();
  await page.keyboard.press("/");
  await page.getByRole("searchbox", { name: "Search Topology" }).fill(query);
  await page.keyboard.press("Enter");
  await page.waitForFunction((q) => new RegExp(`^${q}[,:]`).test(document.querySelector(".graph-about")?.textContent ?? ""), query);
  await frames(page);
}

/** Pans (H J K L) until the selected node is near the right edge, where a selection by key would
 * bring it in (GraphView's `reveal`). */
async function toRightEdge(page: Page): Promise<Point> {
  for (let i = 0; i < 40; i++) {
    const f = await drawn(page);
    const p = ring(f);
    const x = p.x - f.left;
    const y = p.y - f.top;
    if (x > f.w - 120 && x < f.w - 40 && y > 80 && y < f.h - 80) return p;
    await page.keyboard.press(x <= f.w - 120 ? "H" : x >= f.w - 40 ? "L" : y <= 80 ? "K" : "J");
    await frames(page);
  }
  throw new Error("couldn't pan the selection to the right edge");
}

/** Where point `p` of frame `a` is in frame `b` (the camera moved or zoomed, nothing else): the
 * map that takes two clusters drawn in both, other than `skip`, from `a` to `b`. */
function carried(a: Map<string, Point>, b: Map<string, Point>, skip: string[], p: Point): Point {
  const ids = [...a.keys()].filter((id) => !skip.includes(id) && b.has(id));
  const [u, v] = ids;
  if (u === undefined || v === undefined) throw new Error("fewer than two clusters drawn in both");
  const [ua, va, ub, vb] = [a.get(u), a.get(v), b.get(u), b.get(v)] as Point[] as [Point, Point, Point, Point];
  const s = Math.hypot(ub.x - vb.x, ub.y - vb.y) / Math.hypot(ua.x - va.x, ua.y - va.y);
  return { x: ub.x + (p.x - ua.x) * s, y: ub.y + (p.y - ua.y) * s };
}

const near = (p: Point, q: Point, d = 1.5) => Math.hypot(p.x - q.x, p.y - q.y) <= d;

/** Presses at `from` and checks the view didn't move: what's pressed stays under the pointer, and
 * every other cluster where it was (#341: a press near the edge recentred the camera). */
async function pressStill(page: Page, from: Point) {
  const before = clusters(await drawn(page));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await frames(page);
  const f = await drawn(page);
  expect(ring(f), "the pressed node stays under the pointer").toSatisfy((p: Point) => near(p, from));
  const after = clusters(f);
  for (const [id, p] of before) if (after.has(id)) expect(after.get(id), `${id} stays put`).toSatisfy((q: Point) => near(q, p));
}

/** Moves the pressed pointer to `to` in steps, as a hand does, and lets go. */
async function dragTo(page: Page, to: Point) {
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await frames(page);
  await page.mouse.up();
  await frames(page);
}

describe("dragging in a graph (T179)", () => {
  it("a collapsed cluster pressed near the edge: the view stays, it lands where dropped, the neighbour it covers moves aside, and the place is kept", async () => {
    const page = await openApp();
    const A = "subnet-16";
    await find(page, A);
    const from = await toRightEdge(page);
    const screen0 = clusters(await drawn(page));
    // The neighbour it's dropped on: the nearest one drawn.
    const N = [...screen0.entries()].filter(([id]) => id !== A).sort(([, p], [, q]) => Math.hypot(p.x - from.x, p.y - from.y) - Math.hypot(q.x - from.x, q.y - from.y))[0]?.[0];
    if (N === undefined) throw new Error("no neighbour drawn");
    const to = screen0.get(N) as Point;

    await pressStill(page, from);
    await dragTo(page, to);

    // Where it was dropped, the view where it was, and the neighbour it covered out of its way.
    const f = await drawn(page);
    expect(ring(f), `${A} is under the pointer`).toSatisfy((p: Point) => near(p, to));
    const screen1 = clusters(f);
    for (const [id, p] of screen0) if (id !== A && id !== N && screen1.has(id)) expect(screen1.get(id), `${id} stays put`).toSatisfy((q: Point) => near(q, p));
    const n = screen1.get(N);
    if (!n) throw new Error(`${N} isn't drawn after the drop`);
    expect(Math.hypot(n.x - to.x, n.y - to.y), `${N} moved aside`).toBeGreaterThan(STAND_IN_RADIUS * 2);

    // Closed and opened again (its camera fitted afresh): both drawn where they were left.
    await closeView(page);
    await openView(page);
    const screen2 = clusters(await drawn(page));
    for (const id of [A, N]) {
      const want = carried(screen1, screen2, [A, N], (id === A ? ring(f) : n) as Point);
      expect(screen2.get(id), `${id} is where it was left`).toSatisfy((p: Point | undefined) => p !== undefined && near(p, want, 2));
    }
  });

  it("a node pressed near the edge: the view stays, it lands where dropped, and the place is kept", async () => {
    const page = await openApp();
    // subnet-3 opened (Enter on a collapsed cluster), then one of its nodes selected.
    await find(page, "subnet-3");
    await page.keyboard.press("Enter");
    await frames(page);
    await find(page, "host-3-002");
    const from = await toRightEdge(page);
    const to = { x: from.x - 160, y: from.y + 60 };

    await pressStill(page, from);
    await dragTo(page, to);

    const f = await drawn(page);
    expect(ring(f), "the node is under the pointer").toSatisfy((p: Point) => near(p, to));
    const screen1 = clusters(f);

    await closeView(page);
    await openView(page);
    await find(page, "host-3-002");
    const g = await drawn(page);
    const want = carried(screen1, clusters(g), [], to);
    expect(ring(g), "the node is where it was left").toSatisfy((p: Point) => near(p, want, 2));
  });

  it("a click near the edge, with no drag, brings what it selected in, as a key does", async () => {
    const page = await openApp();
    await find(page, "subnet-16");
    const from = await toRightEdge(page);
    await page.keyboard.press("h");
    await frames(page);
    await page.mouse.click(from.x, from.y);
    await page.waitForFunction(() => /^subnet-16:/.test(document.querySelector(".graph-about")?.textContent ?? ""));
    await frames(page);
    const f = await drawn(page);
    // In from the edge, past the room its label needs (GraphView's `reveal`).
    expect(ring(f).x - f.left).toBeLessThan(f.w - 168);
  });
});
