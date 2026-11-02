// Every panel and view docked, at a width the user picks, or full window (ticket 95, #168,
// decision Q106). A panel's place (`"panel"`: docked beside the terminal, `"full"`: over the whole
// window but the title and status bars) and its width (a percent of the window) come from, first
// to last: what the user chose (kept in the State per panel), init.lua's `views.ID`, init.lua's
// `panel.width` (widths only), then the panel's own default (a Plugin view's `place`, a built-in
// panel's width in styles.css). init.lua's are defaults, as the owner asked: `:panel reset`
// forgets the user's choice and they apply again.
//
// It also keeps which panels are on screen and in what order they were last used, so `␣ z` and
// `␣ <` / `␣ >` act on the panel with focus, else the one used last, and a full panel used last
// is drawn on top of another.

/** The State key: panel id → what the user chose. */
export const PANELS_KEY = "panels";
/** How many panels' choices the State keeps (the most recently changed). */
export const KEPT_PANELS = 64;

export type PanelPlace = "panel" | "full";

export interface PanelChoice {
  place?: PanelPlace;
  /** Percent of the window's width. */
  width?: number;
}

/** What init.lua says: `panel.width`, and `views = { ID = { place, width } }`. */
export interface PanelDefaults {
  width: number | null;
  views: Readonly<Record<string, PanelChoice>>;
}

export const NO_DEFAULTS: PanelDefaults = { width: null, views: {} };

/** The widths init.lua and `:panel width` take, in percent of the window. The limits below
 * narrow them further for the window at hand. */
export const MIN_PERCENT = 10;
export const MAX_PERCENT = 95;
/** `␣ <` / `␣ >`, in percent of the window. */
export const STEP_PERCENT = 5;
/** A docked panel is never narrower than this (or the window). */
export const PANEL_MIN_PX = 280;
/** The terminal beside a docked panel keeps at least this much (about 50 columns). */
export const TERMINAL_MIN_PX = 400;
/** A panel floating over the terminal (Focus, a narrow window) leaves this much of it showing. */
export const FLOAT_GAP_PX = 48;

export interface Room {
  /** The window's width under the title bar (the `.body`). */
  body: number;
  /** What else takes width: beside the terminal, the docked Sidebar and the other docked panels;
   * over it, the other floating panels (the limit is shared, #176). */
  others: number;
  /** The panel floats over the terminal instead of beside it. */
  floating: boolean;
}

/** The narrowest and widest a docked panel may be, in px, so the terminal stays usable. */
export function limitsPx(room: Room): { min: number; max: number } {
  const min = Math.min(PANEL_MIN_PX, room.body);
  const max = room.body - room.others - (room.floating ? FLOAT_GAP_PX : TERMINAL_MIN_PX);
  return { min, max: Math.max(min, max) };
}

/** The same limits in percent of the window, one decimal. */
export function limitsPercent(room: Room): { min: number; max: number } {
  const { min, max } = limitsPx(room);
  return { min: percentOf(min, room.body), max: percentOf(max, room.body) };
}

export const percentOf = (px: number, body: number) => (body > 0 ? Math.round((px / body) * 1000) / 10 : 0);

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A choice as the State holds it; what can't be read is left out (the State is untrusted). */
function choiceOf(v: unknown): PanelChoice | null {
  if (!isObj(v)) return null;
  const out: PanelChoice = {};
  if (v.place === "panel" || v.place === "full") out.place = v.place;
  if (typeof v.width === "number" && Number.isFinite(v.width)) out.width = clamp(v.width, MIN_PERCENT, MAX_PERCENT);
  return out.place || out.width !== undefined ? out : null;
}

/** Where a panel's place or width came from, for what `:panel` says. */
export type ChoiceSource = "you" | "init.lua" | "default";

interface Mounted {
  id: string;
  title: string;
  el: HTMLElement;
  /** Its own default place (a Plugin view's `place`; "panel" for the rest). */
  fallback: PanelPlace;
}

type Store = { get(key: string): unknown; set(key: string, value: unknown): void };

export class PanelLayout {
  private defaults: PanelDefaults = NO_DEFAULTS;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly mounted = new Map<string, Mounted>();
  /** Panel ids, the one used last first. */
  private used: string[] = [];
  /** Where each docked panel goes, arranged together (#176). */
  private spots = new Map<string, Spot>();

  constructor(private readonly store: Store) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes whenever anything here does (for useSyncExternalStore). */
  snapshot = (): number => this.version;

  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  setDefaults(defaults: PanelDefaults) {
    if (defaults === this.defaults) return;
    if (JSON.stringify(defaults) === JSON.stringify(this.defaults)) return;
    this.defaults = defaults;
    this.changed();
  }

  private all(): Record<string, PanelChoice> {
    const v = this.store.get(PANELS_KEY);
    if (!isObj(v)) return {};
    const out: Record<string, PanelChoice> = {};
    for (const [k, c] of Object.entries(v)) {
      const choice = choiceOf(c);
      if (choice) out[k] = choice;
    }
    return out;
  }

  private stored(id: string): PanelChoice {
    return this.all()[id] ?? {};
  }

  /** init.lua's `views` entry for this panel: a view's own id (`view:topology` → `topology`). */
  private configured(id: string): PanelChoice {
    return this.defaults.views[configId(id)] ?? {};
  }

  private save(id: string, choice: PanelChoice | null) {
    const rest = Object.entries(this.all()).filter(([k]) => k !== id);
    const next = choice && (choice.place || choice.width !== undefined) ? [[id, choice] as const, ...rest] : rest;
    this.store.set(PANELS_KEY, Object.fromEntries(next.slice(0, KEPT_PANELS)));
    this.changed();
  }

  place(id: string, fallback: PanelPlace = "panel"): PanelPlace {
    return this.stored(id).place ?? this.configured(id).place ?? fallback;
  }

  /** Percent of the window, or null for the panel's own default width. */
  width(id: string): number | null {
    return this.stored(id).width ?? this.configured(id).width ?? this.defaults.width;
  }

  placeSource(id: string): ChoiceSource {
    return this.stored(id).place ? "you" : this.configured(id).place ? "init.lua" : "default";
  }

  widthSource(id: string): ChoiceSource {
    return this.stored(id).width !== undefined ? "you" : this.configured(id).width !== undefined || this.defaults.width !== null ? "init.lua" : "default";
  }

  /** Remembers the place the user chose. */
  setPlace(id: string, place: PanelPlace) {
    this.save(id, { ...this.stored(id), place });
  }

  /** Remembers the width the user chose, in percent of the window. */
  setWidth(id: string, percent: number) {
    this.save(id, { ...this.stored(id), width: Math.round(clamp(percent, MIN_PERCENT, MAX_PERCENT) * 10) / 10 });
  }

  /** Forgets the user's choice, so init.lua's or the panel's own default applies again. */
  reset(id: string) {
    this.save(id, null);
  }

  /** A panel on screen (PanelFrame calls these). */
  mount(id: string, title: string, el: HTMLElement, fallback: PanelPlace) {
    this.mounted.set(id, { id, title, el, fallback });
    this.use(id);
  }

  unmount(id: string, el: HTMLElement) {
    if (this.mounted.get(id)?.el !== el) return;
    this.mounted.delete(id);
    this.used = this.used.filter((u) => u !== id);
    this.changed();
  }

  /** The user is in this panel (focus, a click): it's the one keys act on, and on top. */
  use(id: string) {
    if (this.used[0] === id) return;
    this.used = [id, ...this.used.filter((u) => u !== id)];
    this.changed();
  }

  /** The panel the keys act on: the one with focus, else the one used last. */
  target(active: Element | null = typeof document === "undefined" ? null : document.activeElement): Mounted | null {
    const list = [...this.mounted.values()];
    const holding = active ? list.find((m) => m.el.contains(active)) : undefined;
    if (holding) return holding;
    for (const id of this.used) {
      const m = this.mounted.get(id);
      if (m) return m;
    }
    return null;
  }

  /** The docked panels on screen (not full window), in the order they're drawn. */
  docked(): { id: string; el: HTMLElement }[] {
    return [...this.mounted.values()]
      .filter((m) => m.el.isConnected && this.place(m.id, m.fallback) === "panel")
      .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map(({ id, el }) => ({ id, el }));
  }

  /** Where a docked panel goes; undefined until they've been arranged. */
  spot(id: string): Spot | undefined {
    return this.spots.get(id);
  }

  /** Some docked panel sits beside the terminal (not floating over it). */
  anyDocked(): boolean {
    return [...this.mounted.values()].some((m) => this.place(m.id, m.fallback) === "panel" && this.spots.get(m.id)?.float === false);
  }

  /** Some panel on screen is full window. */
  anyFull(): boolean {
    return [...this.mounted.values()].some((m) => this.place(m.id, m.fallback) === "full");
  }

  /** Takes a new arrangement; nothing changes (and nothing redraws) when it's the same. */
  setSpots(spots: Map<string, Spot>) {
    const same = spots.size === this.spots.size && [...spots].every(([id, s]) => JSON.stringify(this.spots.get(id)) === JSON.stringify(s));
    if (same) return;
    this.spots = spots;
    this.changed();
  }

  /** The full panel on top: the one used last. */
  topFull(): string | null {
    for (const id of this.used) {
      const m = this.mounted.get(id);
      if (m && this.place(id, m.fallback) === "full") return id;
    }
    return null;
  }
}

/** The id init.lua's `views` names a panel by: a built-in panel's own (`help`), a view's id. */
export const configId = (id: string) => (id.startsWith("view:") ? id.slice(5) : id);

/** The next width after `␣ >` (+1) or `␣ <` (-1), in percent, within the limits. */
export function stepped(current: number, direction: 1 | -1, limits: { min: number; max: number }): number {
  return clamp(Math.round((current + direction * STEP_PERCENT) * 10) / 10, limits.min, limits.max);
}

/** A docked panel to arrange: which side it docks on, and the width it'd be drawn at alone. */
export interface Slot {
  id: string;
  side: "left" | "right";
  /** px: its own width (the user's, init.lua's or its default), within its own limits. */
  want: number;
}

/** Where a docked panel goes (#176, decision Q125). */
export interface Spot {
  /** Over the terminal instead of beside it. */
  float: boolean;
  /** px, when floats too wide together are narrowed to share the window; null for its own width. */
  width: number | null;
  /** px from its side's edge of the window, so floats sit side by side. */
  at: number;
}

/**
 * Where every docked panel goes, together rather than each alone (#176). Docked beside the
 * terminal while each can keep its minimum and the terminal its 400 px; flexbox then shares the
 * room among them (styles.css: they shrink in proportion, the terminal doesn't). When their
 * minimums don't fit, or the window is narrow or in Focus (`forced`), they float over the terminal,
 * side by side from their edge in the order they'd dock in, never on top of each other; floats too
 * wide together are narrowed in proportion so a 48 px sliver of the terminal still shows.
 * `slots` are in the order they're drawn (the DOM's).
 */
export function arrange(room: { body: number; others: number; forced: boolean }, slots: readonly Slot[]): Map<string, Spot> {
  const out = new Map<string, Spot>();
  const min = Math.min(PANEL_MIN_PX, room.body);
  if (!room.forced && slots.length * min <= room.body - room.others - TERMINAL_MIN_PX) {
    for (const s of slots) out.set(s.id, { float: false, width: null, at: 0 });
    return out;
  }
  const total = slots.reduce((n, s) => n + s.want, 0);
  const share = total > room.body - FLOAT_GAP_PX && total > 0 ? Math.max(0, room.body - FLOAT_GAP_PX) / total : 1;
  const width = (s: Slot) => (share < 1 ? Math.floor(s.want * share) : null);
  // Nearest the edge first: the first on the left, the last on the right, as when docked.
  const lefts = slots.filter((s) => s.side === "left");
  const rights = slots.filter((s) => s.side === "right").reverse();
  for (const side of [lefts, rights]) {
    let at = 0;
    for (const s of side) {
      const w = width(s);
      out.set(s.id, { float: true, width: w, at });
      at += w ?? s.want;
    }
  }
  return out;
}
