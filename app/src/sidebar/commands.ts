// The Sidebar's commands: show or hide it, move its cursor, fold its rows, open a Host row's menu.
import type { AppContext, CommandDef } from "../commands/table";
import { matching } from "../ui/completion";
import { BUILTIN } from "../registry";
import type { FoldHow, SidebarRow } from "./model";

export type ListMove = "down" | "up" | "top" | "bottom" | "choose";

/** What the Sidebar's commands ask of the app. */
export interface SidebarContext {
  toggleSidebar(): void;
  /** Moves the list cursor (the Sidebar in Standard), or chooses the row under it. */
  list(move: ListMove): void;
  /** Folds or unfolds the Sidebar row (or section heading) `id`, or the one under the cursor. */
  fold(id: string | null, how: FoldHow): void;
  cursorRow(): SidebarRow | null;
  /** Opens the menu of the Host row under the Sidebar's cursor (T166, Q156). */
  rowMenu(): void;
}

type SidebarCommand = CommandDef<SidebarContext & AppContext>;

const fold = (id: string, how: FoldHow, label: string): SidebarCommand => ({
  id,
  source: BUILTIN,
  area: "Sidebar",
  arg: "text",
  optionalArg: how !== "toggle",
  label: (row) => (row ? `${label} ${row}` : label),
  staysInAppMode: true,
  motion: true,
  run: (ctx, row) => ctx.fold(row ?? null, how),
  complete: (row, _hosts, ctx) => matching(ctx?.foldIds ?? [], row),
});

const list = (move: ListMove, label: string): SidebarCommand => ({
  id: move,
  source: BUILTIN,
  area: "Sidebar",
  label: () => label,
  staysInAppMode: move !== "choose",
  motion: true,
  run: (ctx) => ctx.list(move),
});

export const sidebarCommands: readonly SidebarCommand[] = [
  { id: "sidebar", source: BUILTIN, area: "Sidebar", label: () => "Show or hide the Sidebar", run: (ctx) => ctx.toggleSidebar() },
  list("down", "Move down"),
  list("up", "Move up"),
  list("top", "Go to the top"),
  list("bottom", "Go to the bottom"),
  list("choose", "Switch to it"),
  fold("fold", "fold", "Fold, or go to the parent"),
  fold("unfold", "unfold", "Unfold, or go to the first child"),
  fold("togglefold", "toggle", "Fold or unfold"),
  {
    // A Host row's menu (T166, Q156): what a right-click on it opens, from the keyboard.
    id: "menu",
    source: BUILTIN,
    area: "Sidebar",
    label: () => "The menu of the Host under the cursor: open, details, check, edit, rename, move, remove",
    staysInAppMode: true,
    run: (ctx) => ctx.rowMenu(),
  },
];
