// A Plugin's graph in a view (ticket 77, decision Q99): a map of nodes and edges drawn on one
// canvas (draw.ts) from the pure scene (scene.ts), and the same graph as two tables (lists.ts).
//
// Keyboard first: h j k l (or the arrows) go to the nearest node that way, / searches and n N go
// through the matches, Enter opens a node (or opens and closes a collapsed cluster), o collapses
// or opens the selected node's cluster and O all of them, + - zoom and 0 fits it all, H J K L pan,
// t switches to the nodes' list and the edges' list, f goes to the filter (clusters, kinds or states
// to show, hiding the rest), m moves the selected node with h j k l until Enter keeps it or Esc puts
// it back (T89), and an action's key runs it on the selected node. Selecting a node lights up what it reaches and what reaches it, with the counts. The mouse
// works too: a click selects, a double click opens, a drag on a node moves it (kept in the State),
// a drag elsewhere pans, the wheel zooms.
//
// Motion (the animate skill): moving, selecting, panning, zooming and collapsing are keys or
// pointer actions, so they are instant. The one thing that moves is an edge that turns live (a
// Session connecting), drawn in from its start over --dur-draw (120 ms, strong ease-out), as the
// Sidebar's connect edge is; nothing moves under reduced motion (--dur-draw is 0 there).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Announce } from "../ui/Announce";
import { DataTable } from "../ui/DataTable";
import { countOf, formatCount } from "../ui/format";
import { Keys } from "../ui/Keys";
import type { TableRow } from "../ui/table";
import type { GraphModel } from "../view/views";
import { drawFrame, easeOut, nodeRadius, readPalette, STAND_IN_RADIUS, toScreen, toWorld, type Camera } from "./draw";
import { edgeTable, nodeTable, SHAPE_WORDS, stateWords } from "./lists";
import { FilterMenu } from "./FilterMenu";
import { GraphPlaces, type GraphMemory } from "./memory";
import { filterGraph, filtering, graphIndex, nodeActionApplies, type FilterState, type GraphFilter } from "./model";
import { buildScene, foldsFor, highlightOf, matchesOf, stepFrom, type Direction, type Highlight, type Scene } from "./scene";

export interface GraphViewProps {
  model: GraphModel;
  /** Its accessible name (the view's title). */
  label: string;
  leader: string;
  /** Where positions and folds are kept; none, nothing is kept. */
  memory?: GraphMemory | undefined;
  /** The view's key in the State (`source/id`). */
  memoKey: string;
  autoFocus?: boolean;
  /** The node it opens at (`roster.views.open(id, { select })`, T99): its cluster opens, and it's
   * centred, at no less than full size. An id the graph doesn't have is ignored. */
  select?: string | undefined;
}

type Mode = "graph" | "nodes" | "edges";
const MODES: readonly Mode[] = ["graph", "nodes", "edges"];
const MODE_LABEL: Record<Mode, string> = { graph: "Graph", nodes: "Nodes", edges: "Edges" };

const MIN_ZOOM = 0.04;
const MAX_ZOOM = 4;
/** How far a key moves a node while placing it (`m`), in screen pixels; Shift or H J K L: more. */
const NUDGE = 16;
const NUDGE_BIG = 64;
/** At most this many edges turning live at once are drawn in; more just appear. */
const MAX_DRAWN_IN = 12;

/** The filter's states in words. */
const STATE_WORDS: Record<FilterState, string> = { live: "live", down: "down", warn: "warning", error: "error" };
const ALL_STATES: readonly FilterState[] = ["live", "down", "warn", "error"];

const clampZoom = (k: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k));

/** The camera that shows the whole scene in a w × h canvas. */
function fitted(scene: Scene, w: number, h: number): Camera {
  if (scene.nodes.length === 0 || w <= 0 || h <= 0) return { x: 0, y: 0, k: 1 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of scene.nodes) {
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x);
    y1 = Math.max(y1, n.y);
  }
  for (const c of scene.clusters) {
    x0 = Math.min(x0, c.x - c.r);
    y0 = Math.min(y0, c.y - c.r - 24);
    x1 = Math.max(x1, c.x + c.r);
    y1 = Math.max(y1, c.y + c.r);
  }
  const pad = 48;
  const k = clampZoom(Math.min(1.5, (w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0)));
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, k };
}

/** Whether the user asked for less motion. */
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** --dur-draw in ms (0 under reduced motion). */
function drawDuration(el: Element): number {
  if (reducedMotion()) return 0;
  const v = getComputedStyle(el).getPropertyValue("--dur-draw").trim();
  const ms = v.endsWith("ms") ? parseFloat(v) : v.endsWith("s") ? parseFloat(v) * 1000 : NaN;
  return Number.isFinite(ms) ? ms : 120;
}

/** Draws frames: on request, at most one a frame, and in a loop only while an edge is drawn in. */
class Painter {
  canvas: HTMLCanvasElement | null = null;
  camera: Camera | null = null;
  now: { scene: Scene; highlight: Highlight | null; selected: string | null; matchSet: ReadonlySet<string> | null; size: { w: number; h: number }; moving: boolean } | null = null;
  private frame = 0;
  private readonly drawing = new Map<number, { start: number; ms: number }>();
  private wasLive: Set<string> | null = null;

  attach(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
  }

  setCamera(c: Camera) {
    this.camera = c;
    this.request();
  }

  show(now: NonNullable<Painter["now"]>) {
    this.now = now;
  }

  request() {
    if (this.frame || typeof requestAnimationFrame !== "function") return;
    this.frame = requestAnimationFrame(this.draw);
  }

  stop() {
    if (this.frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** Notes the scene's live edges; those that weren't live before are drawn in. */
  liveEdges(scene: Scene) {
    const live = new Set<string>();
    const fresh: number[] = [];
    scene.edges.forEach((e, i) => {
      if (e.tone !== "live") return;
      const key = `${e.from}\u0000${e.to}`;
      live.add(key);
      if (this.wasLive && !this.wasLive.has(key)) fresh.push(i);
    });
    this.wasLive = live;
    this.drawing.clear();
    const el = this.canvas;
    if (!el || fresh.length === 0 || fresh.length > MAX_DRAWN_IN) return;
    const ms = drawDuration(el);
    const start = performance.now();
    if (ms > 0) for (const i of fresh) this.drawing.set(i, { start, ms });
    this.request();
  }

  private readonly draw = () => {
    this.frame = 0;
    const el = this.canvas;
    const ctx = el?.getContext?.("2d");
    const now = this.now;
    if (!el || !ctx || !now || now.size.w === 0 || now.size.h === 0) return;
    const cam = (this.camera ??= fitted(now.scene, now.size.w, now.size.h));
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = performance.now();
    const progress = new Map<number, number>();
    for (const [i, a] of this.drawing) {
      const p = (t - a.start) / a.ms;
      if (p >= 1) this.drawing.delete(i);
      else progress.set(i, easeOut(p));
    }
    drawFrame(ctx, {
      scene: now.scene,
      camera: cam,
      width: now.size.w,
      height: now.size.h,
      palette: readPalette(el),
      selected: now.selected,
      highlight: now.highlight,
      matches: now.matchSet,
      drawing: progress,
      moving: now.moving,
    });
    // Only while an edge is being drawn in: then nothing until the next change.
    if (this.drawing.size) this.request();
  };
}

export function GraphView({ model, label, leader, memory, memoKey, autoFocus = false, select: openAt }: GraphViewProps) {
  const base = useId();
  const data = model.data;
  const [places] = useState(() => new GraphPlaces(memory, memoKey));
  const [folds, setFolds] = useState(() => {
    // Opened at a node in a collapsed cluster: that cluster opens, as going to it from the list does.
    const at = openAt === undefined ? undefined : data.nodes.find((n) => n.id === openAt);
    if (at?.cluster !== undefined && foldsFor(data, places.userFolds()).has(at.cluster)) places.fold(at.cluster, false);
    return places.userFolds();
  });
  const [moved, setMoved] = useState(0);
  // `moved` makes a node the user dragged take its new place.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => places.layout(data), [places, data, moved]);
  const collapsed = useMemo(() => foldsFor(data, folds), [data, folds]);
  // The filter: the Plugin's, until the user changes it; one the Plugin sends again (a new object,
  // even the same as before) replaces theirs.
  const [filter, setFilter] = useState<GraphFilter>(model.filter ?? {});
  const [filterFrom, setFilterFrom] = useState(model.filter);
  if (filterFrom !== model.filter) {
    setFilterFrom(model.filter);
    setFilter(model.filter ?? {});
  }
  const hiding = filtering(filter);
  // What's shown is laid out with the whole graph, so nothing moves when the filter changes; reach
  // is counted on the whole graph too: hiding a node doesn't change what it reaches.
  const shown = useMemo(() => filterGraph(data, filter), [data, filter]);
  const scene = useMemo(() => buildScene(shown, layout, collapsed), [shown, layout, collapsed]);
  const ix = useMemo(() => graphIndex(data), [data]);
  const hops = model.reach ?? "all";
  useEffect(() => places.persist(), [places, layout, folds]);

  const [mode, setMode] = useState<Mode>("graph");
  const [chosen, setChosen] = useState<string | null>(openAt ?? null);
  // Placing a node from the keyboard (`m`, T89): which, and where it was, for Esc.
  const [moving, setMoving] = useState<{ id: string; from: { x: number; y: number } } | null>(null);
  const [moveSays, setMoveSays] = useState("");
  // Why a key did nothing (m on a collapsed cluster, T99): shown under the graph until the next key.
  const [notice, setNotice] = useState("");
  // The selection follows its node: into its cluster when that collapses, back out when it opens.
  const selected = useMemo(() => {
    if (chosen !== null && scene.byId.has(chosen)) return chosen;
    if (chosen !== null) {
      const at = scene.shownAs.get(chosen);
      if (at !== undefined) return at;
    }
    return scene.nodes[0]?.id ?? null;
  }, [chosen, scene]);
  const highlight = useMemo(() => (selected === null ? null : highlightOf(scene, ix, selected, hops)), [scene, ix, selected, hops]);
  // The node it was opened at, until it's on the map or the user picks another: one that comes later
  // in a collapsed cluster opens that cluster.
  const [awaited, setAwaited] = useState(openAt);
  if (awaited !== undefined) {
    const c = ix.nodes.get(awaited)?.cluster;
    if (scene.byId.has(awaited)) setAwaited(undefined);
    else if (c !== undefined && collapsed.has(c)) {
      places.fold(c, false);
      setFolds(places.userFolds());
    }
  }

  const [query, setQuery] = useState("");
  const matches = useMemo(() => matchesOf(shown, scene, query), [shown, scene, query]);
  const matchSet = useMemo(() => (query.trim() ? new Set(matches) : null), [matches, query]);

  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const firstFilter = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [painter] = useState(() => new Painter());

  // What a frame draws: the latest of everything, read when it's drawn.
  useLayoutEffect(() => {
    painter.attach(canvas.current);
    painter.show({ scene, highlight, selected, matchSet, size, moving: moving !== null });
  });
  useEffect(() => () => painter.stop(), [painter]);
  const redraw = useCallback(() => painter.request(), [painter]);

  // Edges that turn live are drawn in (the connect edge, taste.md); the first drawing isn't.
  useEffect(() => painter.liveEdges(scene), [painter, scene]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || mode !== "graph") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || size.w === 0) return;
    painter.attach(el);
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(size.w * dpr);
    el.height = Math.round(size.h * dpr);
    redraw();
  }, [size, redraw, painter]);
  useEffect(redraw, [scene, highlight, selected, matchSet, moving, redraw]);

  // Opened at a node: centred on it once the canvas has a size and the node is there (an update may
  // bring it later), close enough to read its name; given up once the user selects something.
  const aimed = useRef(false);
  useLayoutEffect(() => {
    if (aimed.current || openAt === undefined || size.w === 0) return;
    const n = scene.byId.get(openAt);
    if (!n) return;
    aimed.current = true;
    painter.setCamera({ x: n.x, y: n.y, k: Math.max(fitted(scene, size.w, size.h).k, 1) });
    redraw();
  }, [openAt, size, scene, painter, redraw]);

  // A Theme change redraws (its tokens are on :root).
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(redraw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] });
    return () => mo.disconnect();
  }, [redraw]);

  useEffect(() => {
    if (autoFocus && mode === "graph") box.current?.focus();
  }, [autoFocus, mode]);

  const pan = (dx: number, dy: number) => {
    const c = painter.camera;
    if (!c) return;
    painter.setCamera({ ...c, x: c.x + dx / c.k, y: c.y + dy / c.k });
    redraw();
  };
  const zoomBy = (f: number, at?: { x: number; y: number }) => {
    const c = painter.camera;
    if (!c) return;
    const k = clampZoom(c.k * f);
    // From a key, around the selected node when it's on screen; else the middle.
    const sel = selected === null ? undefined : scene.byId.get(selected);
    const on = sel ? toScreen(c, size.w, size.h, sel.x, sel.y) : null;
    const p = at ?? (on && on.x >= 0 && on.y >= 0 && on.x <= size.w && on.y <= size.h ? on : { x: size.w / 2, y: size.h / 2 });
    const w0 = toWorld(c, size.w, size.h, p.x, p.y);
    // Keep the point under the pointer where it is.
    painter.setCamera({ k, x: w0.x - (p.x - size.w / 2) / k, y: w0.y - (p.y - size.h / 2) / k });
    redraw();
  };
  const fit = () => {
    painter.setCamera(fitted(scene, size.w, size.h));
    redraw();
  };

  /** Brings world point (x, y) on screen if it's off. */
  const reveal = (x: number, y: number) => {
    const c = painter.camera;
    if (!c || size.w === 0) return;
    const s = toScreen(c, size.w, size.h, x, y);
    const m = 56;
    if (s.x < m || s.y < m || s.x > size.w - m * 3 || s.y > size.h - m) painter.setCamera({ ...c, x, y });
  };

  /** Selects scene node `id` and brings it on screen if it's off. */
  const select = (id: string | null) => {
    if (id === null) return;
    aimed.current = true;
    setAwaited(undefined);
    setChosen(id);
    setMoveSays("");
    const n = scene.byId.get(id);
    if (n) reveal(n.x, n.y);
  };

  /** Puts the node being placed at (x, y): kept in the State, as a drag is. */
  const place = (id: string, x: number, y: number) => {
    places.move(id, x, y);
    setMoved((m) => m + 1);
    reveal(x, y);
  };
  const startMoving = () => {
    if (current?.count !== undefined) return setNotice(`${current.label} is collapsed: o opens it, then m moves one of its nodes`);
    const n = currentNode && layout.nodes.get(currentNode.id);
    if (!currentNode || !n) return;
    setMoving({ id: currentNode.id, from: { x: n.x, y: n.y } });
    setMoveSays(`Moving ${currentNode.label}: h, j, k and l or the arrow keys move it, with Shift further; Enter keeps the place, Esc puts it back`);
  };
  const stopMoving = (keep: boolean) => {
    if (!moving) return;
    const name = ix.nodes.get(moving.id)?.label ?? moving.id;
    if (!keep) place(moving.id, moving.from.x, moving.from.y);
    setMoving(null);
    setMoveSays(keep ? `${name} placed` : `${name} put back`);
  };
  /** While placing: the key's move, Enter, Esc, zoom; every other key does nothing. */
  const movingKey = (e: KeyboardEvent<HTMLDivElement>, m: NonNullable<typeof moving>): (() => void) | null => {
    const at = layout.nodes.get(m.id);
    if (!at) return () => setMoving(null);
    const ways: Record<string, [number, number]> = { h: [-1, 0], l: [1, 0], k: [0, -1], j: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const way = ways[e.key] ?? ways[e.key.toLowerCase()];
    if (way) {
      const big = e.shiftKey || /^[HJKL]$/.test(e.key);
      const step = (big ? NUDGE_BIG : NUDGE) / (painter.camera?.k ?? 1);
      return () => place(m.id, at.x + way[0] * step, at.y + way[1] * step);
    }
    if (e.key === "Enter" || e.key === "m") return e.repeat ? () => {} : () => stopMoving(true);
    if (e.key === "Escape") return () => stopMoving(false);
    if (["+", "=", "-", "0"].includes(e.key)) return null;
    return () => {};
  };

  const toggle = (cluster: string, open?: boolean) => {
    const now = collapsed.has(cluster);
    const next = open === undefined ? !now : !open;
    if (next === now) return;
    places.fold(cluster, next);
    setFolds(places.userFolds());
    redraw();
  };
  const toggleAll = () => {
    const anyOpen = data.clusters.some((c) => !collapsed.has(c.id));
    for (const c of data.clusters) places.fold(c.id, anyOpen);
    setFolds(places.userFolds());
  };

  const current = selected === null ? undefined : scene.byId.get(selected);
  const currentNode = current?.node;

  const open = () => {
    if (!current) return;
    if (current.count !== undefined) return toggle(current.id, true);
    if (currentNode) model.open?.(currentNode);
  };

  /** Goes to node `id` (a graph node or a cluster), opening its cluster if it's collapsed. */
  const goTo = (id: string) => {
    const n = ix.nodes.get(id);
    if (n?.cluster !== undefined && collapsed.has(n.cluster)) toggle(n.cluster, true);
    setChosen(id);
    setMode("graph");
  };

  const nextMatch = (back: boolean) => {
    if (matches.length === 0) return;
    const i = selected === null ? -1 : matches.indexOf(selected);
    const j = i < 0 ? (back ? matches.length - 1 : 0) : (i + (back ? -1 : 1) + matches.length) % matches.length;
    select(matches[j] ?? null);
  };

  const keyAction = (e: KeyboardEvent<HTMLDivElement>): (() => void) | null => {
    const k = e.key;
    if (e.altKey || e.metaKey || e.ctrlKey) return null;
    if (moving) {
      const act = movingKey(e, moving);
      if (act) return act;
    }
    const step = (d: Direction) => () => select(selected === null ? (scene.nodes[0]?.id ?? null) : stepFrom(scene, selected, d) ?? selected);
    const by = 80;
    switch (k) {
      case "h":
        return step("left");
      case "l":
        return step("right");
      case "k":
        return step("up");
      case "j":
        return step("down");
      case "ArrowLeft":
        return e.shiftKey ? () => pan(-by, 0) : step("left");
      case "ArrowRight":
        return e.shiftKey ? () => pan(by, 0) : step("right");
      case "ArrowUp":
        return e.shiftKey ? () => pan(0, -by) : step("up");
      case "ArrowDown":
        return e.shiftKey ? () => pan(0, by) : step("down");
      case "H":
        return () => pan(-by, 0);
      case "L":
        return () => pan(by, 0);
      case "K":
        return () => pan(0, -by);
      case "J":
        return () => pan(0, by);
      case "+":
      case "=":
        return () => zoomBy(1.25);
      case "-":
        return () => zoomBy(0.8);
      case "0":
        return fit;
      case "/":
        return () => search.current?.focus();
      case "n":
        return () => nextMatch(false);
      case "N":
        return () => nextMatch(true);
      case "o": {
        const cluster = current?.count !== undefined ? current.id : currentNode?.cluster;
        return cluster !== undefined && data.clusters.some((c) => c.id === cluster) ? () => toggle(cluster) : () => {};
      }
      case "O":
        return toggleAll;
      case "t":
        return () => setMode("nodes");
      case "f":
        return () => firstFilter.current?.focus();
      case "m":
        return e.repeat ? () => {} : startMoving;
      case "Enter":
        return e.repeat ? () => {} : open;
      case "Escape":
        // Esc clears a search first, then the filter; then it's the view's (it closes).
        return query ? () => setQuery("") : hiding ? () => setFilter({}) : null;
    }
    const action = model.actions.find((a) => a.key === k);
    if (!action || !currentNode || !nodeActionApplies(action.when, currentNode)) return null;
    return e.repeat ? () => {} : () => action.run(currentNode);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) setNotice("");
    const act = keyAction(e);
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  };

  // The pointer: a click selects, a drag on a node moves it, a drag elsewhere pans.
  const drag = useRef<{ id: string | null; x: number; y: number; moved: boolean; pointer: number } | null>(null);
  const hit = (sx: number, sy: number): string | null => {
    const c = painter.camera;
    if (!c) return null;
    let best: string | null = null;
    let bestD = Infinity;
    const r = nodeRadius(c.k);
    for (const n of scene.nodes) {
      const s = toScreen(c, size.w, size.h, n.x, n.y);
      const d = Math.hypot(s.x - sx, s.y - sy);
      const reach = (n.count !== undefined ? STAND_IN_RADIUS : r) + 6;
      if (d < reach && d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = painter.canvas?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    setNotice("");
    if (e.button !== 0 || drag.current) return;
    box.current?.focus();
    // A click while placing from the keyboard keeps the place.
    if (moving) stopMoving(true);
    const p = local(e);
    const id = hit(p.x, p.y);
    if (id !== null) select(id);
    drag.current = { id, x: p.x, y: p.y, moved: false, pointer: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const p = local(e);
    if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) < 4) return;
    const c = painter.camera;
    if (!c) return;
    if (d.id !== null && scene.byId.get(d.id)?.node) {
      const w = toWorld(c, size.w, size.h, p.x, p.y);
      places.move(d.id, w.x, w.y);
      setMoved((m) => m + 1);
    } else {
      painter.setCamera({ ...c, x: c.x - (p.x - d.x) / c.k, y: c.y - (p.y - d.y) / c.k });
      redraw();
    }
    drag.current = { ...d, x: p.x, y: p.y, moved: true };
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  };
  // The wheel zooms where the pointer is; it's not passive, so the page doesn't scroll.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const c = painter.camera;
      if (!c) return;
      const k = clampZoom(c.k * Math.exp(-e.deltaY * 0.0015));
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      const w0 = toWorld(c, r.width, r.height, p.x, p.y);
      painter.setCamera({ k, x: w0.x - (p.x - r.width / 2) / k, y: w0.y - (p.y - r.height / 2) / k });
      redraw();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [mode, redraw, painter]);

  // The lists, built only when shown (each node's reach counts are a walk of the graph).
  const nodesModel = useMemo(() => (mode === "nodes" ? nodeTable(model, ix, shown.nodes) : null), [mode, model, ix, shown]);
  const edgesModel = useMemo(() => (mode === "edges" ? edgeTable(shown, ix, goTo) : null), [mode, shown, ix]); // eslint-disable-line react-hooks/exhaustive-deps
  const onListSelect = useCallback((row: TableRow) => setChosen(row.id), []);
  // An empty list has no grid to hold the focus (T89): the list itself takes it, so t goes on.
  const listBox = useRef<HTMLDivElement>(null);
  const listEmpty = mode === "nodes" ? nodesModel?.rows.length === 0 : mode === "edges" ? edgesModel?.rows.length === 0 : false;
  useEffect(() => {
    if (listEmpty) listBox.current?.focus();
  }, [listEmpty, mode]);

  const listKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "t" || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length] as Mode;
    setMode(next);
  };

  // What the selected node is, in words: shown under the graph and said to a screen reader.
  const about = (() => {
    if (!current) return "";
    const reach = !highlight
      ? ""
      : hops === "direct"
        ? `. Reaches ${countOf(highlight.out, "node")} directly; reached directly by ${formatCount(highlight.in)}`
        : `. Reaches ${countOf(highlight.out, "node")}; reached by ${formatCount(highlight.in)}`;
    if (current.count !== undefined) {
      const inside = [current.live ? `${formatCount(current.live)} live` : "", current.mark === "error" ? "an error" : current.mark === "warn" ? "a warning" : ""].filter(Boolean);
      return `${current.label}: ${countOf(current.count, "node")}${inside.length ? ` (${inside.join(", ")})` : ""}, collapsed${reach}`;
    }
    const n = currentNode;
    if (!n) return current.label;
    const words = [n.label, n.kind, SHAPE_WORDS[n.shape], stateWords(n), n.detail].filter(Boolean).join(", ");
    return `${words}${reach}`;
  })();
  const searchSays = query.trim() ? (matches.length ? `${countOf(matches.length, "match", "matches")} for ${query.trim()}` : `Nothing matches ${query.trim()}`) : "";
  // An action with `when` is offered only on the nodes it names (T89).
  const keyed = model.actions.filter((a) => a.key && currentNode !== undefined && nodeActionApplies(a.when, currentNode));

  // The filter's choices: the clusters, the kinds and the states the graph has.
  const kinds = useMemo(() => [...new Set(data.nodes.flatMap((n) => (n.kind ? [n.kind] : [])))].sort(), [data]);
  const states = useMemo(() => ALL_STATES.filter((st) => data.nodes.some((n) => n.state === st || n.mark === st)), [data]);
  const choices: { key: "clusters" | "kinds" | "states"; label: string; every: string; options: { value: string; label: string }[] }[] = [
    { key: "clusters", label: "cluster", every: "Every cluster", options: data.clusters.map((c) => ({ value: c.id, label: c.title })) },
    { key: "kinds", label: "kind", every: "Every kind", options: kinds.map((k) => ({ value: k, label: k })) },
    { key: "states", label: "state", every: "Every state", options: states.map((st) => ({ value: st, label: STATE_WORDS[st] })) },
  ].filter((c) => c.options.length > 0 || (filter[c.key as keyof GraphFilter]?.length ?? 0) > 0) as typeof choices;
  const choose = (key: keyof GraphFilter, values: string[]) => {
    const rest = Object.fromEntries(Object.entries(filter).filter(([k]) => k !== key)) as GraphFilter;
    setFilter(values.length === 0 ? rest : { ...rest, [key]: values });
  };
  const showing = hiding ? `Showing ${formatCount(shown.nodes.length)} of ${countOf(data.nodes.length, "node")}` : "";
  const helpId = `${base}-help`;

  return (
    <div className="graph-view">
      <div className="graph-bar">
        <div className="graph-modes" role="group" aria-label="Show as">
          {MODES.map((m) => (
            <button key={m} type="button" className="graph-mode" aria-pressed={mode === m} onMouseDown={(e) => e.preventDefault()} onClick={() => setMode(m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        {choices.length > 0 && (
          <div className="graph-filter" role="group" aria-label="Filter">
            {choices.map((c, i) => (
              <FilterMenu
                key={c.key}
                ref={i === 0 ? firstFilter : undefined}
                noun={c.label}
                nouns={c.label === "kind" ? "kinds" : `${c.label}s`}
                options={c.options}
                chosen={filter[c.key] ?? []}
                onChange={(values) => choose(c.key, values)}
                onLeave={() => mode === "graph" && box.current?.focus()}
              />
            ))}
            {showing && <span className="graph-found muted">{showing}</span>}
          </div>
        )}
        {mode === "graph" && (
          <>
            <input
              ref={search}
              className="graph-search"
              type="search"
              placeholder="Search"
              aria-label={`Search ${label}`}
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // As a table's filter: Enter (or ↓) goes to the next match and back to the graph.
                if (e.key === "Enter" || e.key === "ArrowDown") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (matches[0] !== undefined) select(matches.find((m) => m !== selected && matches.indexOf(m) > matches.indexOf(selected ?? "")) ?? matches[0]);
                  box.current?.focus();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (query) setQuery("");
                  else box.current?.focus();
                }
              }}
            />
            {searchSays && <span className="graph-found muted">{searchSays}</span>}
            <span className="grow" />
            <div className="graph-zoom" role="group" aria-label="Zoom">
              <button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out (-)" onMouseDown={(e) => e.preventDefault()} onClick={() => zoomBy(0.8)}>
                −
              </button>
              <button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in (+)" onMouseDown={(e) => e.preventDefault()} onClick={() => zoomBy(1.25)}>
                +
              </button>
              <button type="button" className="graph-fit" title="Show it all (0)" onMouseDown={(e) => e.preventDefault()} onClick={fit}>
                Fit
              </button>
            </div>
          </>
        )}
      </div>
      {mode === "graph" ? (
        <div
          ref={box}
          className="graph-canvas"
          role="application"
          aria-roledescription="graph"
          aria-label={label}
          aria-describedby={helpId}
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          <canvas ref={canvas} aria-hidden="true" style={{ width: size.w, height: size.h }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={open} />
          {data.nodes.length === 0 ? <p className="graph-empty muted">No nodes yet.</p> : shown.nodes.length === 0 && <p className="graph-empty muted">Nothing here shows with this filter. Esc shows everything.</p>}
          <p id={helpId} className="visually-hidden">
            h, j, k and l or the arrow keys move between nodes; slash searches; f filters; m moves the selected node; Enter opens; t lists every node and edge.
          </p>
        </div>
      ) : (
        <div
          ref={listBox}
          className="graph-list"
          onKeyDown={listKeys}
          {...(listEmpty ? { role: "group", "aria-label": `${label}: ${mode}`, tabIndex: -1 } : {})}
        >
          {mode === "nodes" && nodesModel && <DataTable key="nodes" model={nodesModel} label={`${label}: nodes`} leader={leader} autoFocus selectedId={currentNode?.id} onSelect={onListSelect} />}
          {mode === "edges" && edgesModel && <DataTable key="edges" model={edgesModel} label={`${label}: edges`} leader={leader} autoFocus />}
        </div>
      )}
      <Announce text={mode === "graph" ? (moving ? moveSays : notice || [moveSays, about, searchSays].filter(Boolean).join(". ")) : ""} delay={150} />
      <p className="dt-foot muted key-hint graph-foot">
        <span className="graph-about" aria-hidden="true">
          {mode !== "graph" ? "" : notice ? notice : current ? about : `${countOf(data.nodes.length, "node")}, ${countOf(data.edges.length, "edge")}${data.clusters.length ? `, ${countOf(data.clusters.length, "cluster")}` : ""}`}
        </span>
        <span className="dt-keys">
          {mode === "graph" && moving && (
            <>
              <span>
                <Keys keys="h j k l" leader={leader} /> move it
              </span>
              <span>
                <Keys keys="Enter" leader={leader} /> keep
              </span>
              <span>
                <Keys keys="Esc" leader={leader} /> put back
              </span>
            </>
          )}
          {mode === "graph" && !moving && (
            <>
              <span>
                <Keys keys="h j k l" leader={leader} /> move
              </span>
              {model.open && (
                <span>
                  <Keys keys="Enter" leader={leader} /> open
                </span>
              )}
              {keyed.map((a) => (
                <span key={a.label}>
                  <Keys keys={a.key as string} leader={leader} /> {a.label.toLowerCase()}
                </span>
              ))}
              <span>
                <Keys keys="/" leader={leader} /> search
              </span>
              {choices.length > 0 && (
                <span>
                  <Keys keys="f" leader={leader} /> filter
                </span>
              )}
              {data.clusters.length > 0 && (
                <span>
                  <Keys keys="o" leader={leader} /> collapse
                </span>
              )}
              {currentNode && (
                <span>
                  <Keys keys="m" leader={leader} /> place
                </span>
              )}
            </>
          )}
          {!moving && <span>
            <Keys keys="t" leader={leader} /> {mode === "edges" ? "graph" : mode === "graph" ? "list" : "edges"}
          </span>}
        </span>
      </p>
    </div>
  );
}
