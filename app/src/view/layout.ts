// View modes (GLOSSARY: Standard and Focus, decision Q36) and their layouts as data (decision
// Q39): per mode, which pieces show around the terminal, where, and in what order. A piece is
// named by id ("titlebar", "sidebar", "sessionbar", "statusbar"); the app draws the ids it knows,
// and the Config (ticket 21) or a Plugin (ticket 23) can place others. A mode changes only how
// roster is shown: every command works in every mode (commands/table.ts).
import type { Options } from "../keymap";
import { quiet, type Quiet } from "../ui/messages";

export type ViewMode = "standard" | "focus";
export const VIEW_MODES: readonly ViewMode[] = ["standard", "focus"];

/** Where a piece goes around the terminal. */
export type Place = "top" | "bottom" | "left" | "right";

export interface Placement {
  id: string;
  at: Place;
  shown: boolean;
}

export interface ModeLayout {
  /** OS fullscreen (the window's own title bar goes too). */
  fullscreen: boolean;
  /** The pieces, in order within each place (top: top to bottom; left: outside in). */
  pieces: readonly Placement[];
  /** The bar `␣ s` shows or hides. */
  bar: string;
  /** A hint on entering, saying how to leave. */
  hint: boolean;
  /** The Sidebar's sections by id, in order; null shows every registered one in its order. */
  sections: readonly string[] | null;
  /** The status bar's segments by id (STATUS_SEGMENTS), in order; null shows them all. */
  segments: readonly string[] | null;
  /** The toolbar's controls by id (the toolbar registry), in order; null: the default set. */
  controls: readonly string[] | null;
}

/** The status bar's segments, in their default order. */
export const STATUS_SEGMENTS = ["backend", "box", "hosts", "path", "changes", "hints", "mode"] as const;

/** One mode's pieces as the Config says them (roster-core config schema.rs ModeLayout). */
export interface ModePieces {
  fullscreen: boolean;
  titlebar: boolean;
  sidebar: { shown: boolean; side: "left" | "right"; sections: readonly string[] | null };
  sessionbar: { shown: boolean; at: "top" | "bottom" };
  statusbar: { shown: boolean; segments: readonly string[] | null };
  toolbar: { shown: boolean; controls: readonly string[] | null };
}

export type Layouts = Record<ViewMode, ModeLayout>;

/** The pieces of the two modes as prototyped, following the options that place pieces. */
export function defaultModePieces(options: Pick<Options, "sidebar" | "statusBar" | "focus">): Record<ViewMode, ModePieces> {
  const sessionbar = options.focus.sessionbar;
  return {
    standard: {
      fullscreen: false,
      titlebar: true,
      sidebar: { shown: options.sidebar.visible, side: options.sidebar.side, sections: null },
      sessionbar: { shown: false, at: "bottom" },
      statusbar: { shown: options.statusBar.visible, segments: null },
      toolbar: { shown: true, controls: null },
    },
    focus: {
      fullscreen: true,
      titlebar: false,
      sidebar: { shown: false, side: "left", sections: null },
      sessionbar: { shown: sessionbar !== false, at: sessionbar || "bottom" },
      statusbar: { shown: false, segments: null },
      toolbar: { shown: false, controls: null },
    },
  };
}

/** A mode's layout from its pieces. `␣ e` shows or hides the Sidebar in every mode (issue #78);
 * the tree finder (`␣ t`) reaches the same tree as an overlay. */
export function modeLayout(mode: ViewMode, p: ModePieces): ModeLayout {
  return {
    fullscreen: p.fullscreen,
    pieces: [
      { id: "titlebar", at: "top", shown: p.titlebar },
      // In the title bar when there is one; else a bar of its own at the top.
      { id: "toolbar", at: "top", shown: p.toolbar.shown },
      { id: "sidebar", at: p.sidebar.side, shown: p.sidebar.shown },
      { id: "sessionbar", at: p.sessionbar.at, shown: p.sessionbar.shown },
      { id: "statusbar", at: "bottom", shown: p.statusbar.shown },
    ],
    bar: mode === "standard" ? "statusbar" : "sessionbar",
    hint: mode === "focus",
    sections: p.sidebar.sections,
    segments: p.statusbar.segments,
    controls: p.toolbar.controls,
  };
}

export function layoutsOf(modes: Record<ViewMode, ModePieces>): Layouts {
  return { standard: modeLayout("standard", modes.standard), focus: modeLayout("focus", modes.focus) };
}

/** The two modes as prototyped, following the options that already place pieces. */
export function defaultLayouts(options: Pick<Options, "sidebar" | "statusBar" | "focus">): Layouts {
  return layoutsOf(defaultModePieces(options));
}

/** `items` ordered and filtered by `ids` (null keeps them all, in their order). */
export function pick<T extends { id: string }>(items: readonly T[], ids: readonly string[] | null): T[] {
  if (ids === null) return [...items];
  return ids.map((id) => items.find((i) => i.id === id)).filter((i): i is T => i !== undefined);
}

/** The ids shown at `at`, in order. */
export function placed(layout: ModeLayout, at: Place): string[] {
  return layout.pieces.filter((p) => p.at === at && p.shown).map((p) => p.id);
}

export function isShown(layout: ModeLayout, id: string): boolean {
  return layout.pieces.some((p) => p.id === id && p.shown);
}

/** Shows or hides a piece; one the layout doesn't place yet is shown at the bottom. */
export function togglePiece(layout: ModeLayout, id: string): ModeLayout {
  const has = layout.pieces.some((p) => p.id === id);
  const pieces = has
    ? layout.pieces.map((p) => (p.id === id ? { ...p, shown: !p.shown } : p))
    : [...layout.pieces, { id, at: "bottom" as const, shown: true }];
  return { ...layout, pieces };
}

/** `mode` with no argument: the other one. */
export function otherMode(mode: ViewMode): ViewMode {
  return mode === "standard" ? "focus" : "standard";
}

const PIECE_NAMES: Record<string, string> = {
  sidebar: "Sidebar",
  statusbar: "Status bar",
  sessionbar: "Session bar",
  toolbar: "Toolbar",
};

/** What to say after `␣ e` / `␣ s` showed or hid a piece: it lasts until the Config changes the
 * modes (or the app restarts), so name the option that keeps it (ticket 32). Quiet: shown with
 * every message on (ticket 111). */
export function pieceToggled(mode: ViewMode, layout: ModeLayout, id: string): Quiet {
  const piece = layout.pieces.find((p) => p.id === id);
  const shown = piece?.shown ?? false;
  const value = !shown ? "false" : id === "sessionbar" ? `"${piece?.at === "top" ? "top" : "bottom"}"` : "true";
  const name = PIECE_NAMES[id] ?? id;
  const said = `${name} ${shown ? "shown" : "hidden"}`;
  return quiet(said, `${said}. To keep it that way: modes.${mode}.${id} = ${value} in init.lua`);
}
