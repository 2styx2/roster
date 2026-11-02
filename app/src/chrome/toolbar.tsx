// The toolbar (issue #78, decision Q65): a visible control for each common command, so nothing
// common is reached only through `:` or a key. Every control is an entry in the toolbar registry
// (ADR 0006) and runs a command line from the command table, like the Sidebar's buttons; the mode's
// layout table (decision Q39, `modes.<mode>.toolbar` in init.lua) picks and orders them. It sits
// in the title bar, or in a thin bar of its own at the top when the mode has no title bar.
import { useContext } from "react";
import type { CommandLine } from "../keymap";
import { BUILTIN, Registry, type Entry } from "../registry";
import { HintsShown } from "../ui/hints";
import { LEADER } from "../ui/Keys";

/** What a control can show from: the app as it is now. */
export interface ToolbarContext {
  pendingCount: number;
  /** The Sidebar is on screen. */
  sidebarShown: boolean;
  /** roster can Quick Connect (API 12, ticket 14). */
  quickConnect: boolean;
  /** The Host details panel is on screen (ticket 18). */
  detailsShown?: boolean;
}

export type ToolbarIcon = "find" | "quick" | "add" | "changes" | "publish" | "cmdline" | "keys" | "help" | "lock" | "mode" | "sidebar" | "details" | "map";

export interface ToolbarControlDef extends Entry {
  /** The accessible name and the tooltip ("Add a Host"). */
  label(ctx: ToolbarContext): string;
  /** A visible word beside the icon; left out, the control is the icon alone. */
  text?: string;
  /** Its icon; left out (a Plugin's control may), the control is its text alone. */
  icon?: ToolbarIcon;
  command: CommandLine;
  /** Where in the bar: right after the mark ("start"), or by the window's buttons ("end"). */
  side: "start" | "end";
  /** In the toolbar when init.lua doesn't pick the controls. */
  byDefault: boolean;
  /** Shown only while this holds (Publish: only with Pending changes). */
  when?(ctx: ToolbarContext): boolean;
  /** A number beside it (the Pending changes), or null. */
  count?(ctx: ToolbarContext): number | null;
  /** A toggle's state (aria-pressed), or undefined for a plain button. */
  pressed?(ctx: ToolbarContext): boolean;
}

export type ToolbarRegistry = Registry<ToolbarControlDef>;

const control = (c: Omit<ToolbarControlDef, "source" | "side" | "byDefault"> & Partial<ToolbarControlDef>): ToolbarControlDef => ({
  source: BUILTIN,
  side: "end",
  byDefault: false,
  ...c,
});

/** The built-in controls, in their default order. The ids are what `modes.<mode>.toolbar` lists. */
export const builtinControls: readonly ToolbarControlDef[] = [
  // Shows or hides the Sidebar (issue #78), by the mark as in an editor; pressed while it shows.
  control({
    id: "sidebar",
    label: (c) => (c.sidebarShown ? "Hide the Sidebar" : "Show the Sidebar"),
    icon: "sidebar",
    command: "sidebar",
    side: "start",
    byDefault: true,
    pressed: (c) => c.sidebarShown,
  }),
  control({ id: "find", label: () => "Find a Host", text: "Find", icon: "find", command: "find", byDefault: true }),
  // Quick Connect (ticket 14): the Picker, ready for user@address[:port].
  control({
    id: "quick",
    label: () => "Quick Connect",
    text: "Connect",
    icon: "quick",
    command: "quick",
    byDefault: true,
    when: (c) => c.quickConnect,
  }),
  control({ id: "add", label: () => "Add a Host", text: "Add Host", icon: "add", command: "host add", byDefault: true }),
  control({
    id: "changes",
    label: (c) => (c.pendingCount > 0 ? `Pending changes: ${c.pendingCount}` : "Pending changes"),
    text: "Changes",
    icon: "changes",
    command: "changes",
    byDefault: true,
    count: (c) => (c.pendingCount > 0 ? c.pendingCount : null),
  }),
  control({
    id: "publish",
    label: () => "Publish",
    text: "Publish",
    icon: "publish",
    command: "publish",
    byDefault: true,
    when: (c) => c.pendingCount > 0,
  }),
  // Host details for the selected Host (ticket 18, Q71): by the window's buttons, as the panel is
  // on the right; pressed while it shows.
  control({
    id: "details",
    label: (c) => (c.detailsShown ? "Hide Host details" : "Show Host details"),
    icon: "details",
    command: "details",
    byDefault: true,
    pressed: (c) => c.detailsShown ?? false,
  }),
  control({ id: "cmdline", label: () => "Command line", icon: "cmdline", command: "cmdline" }),
  control({ id: "keys", label: () => "Key bindings", icon: "keys", command: "keys" }),
  // `:help`'s topic finder (ticket 37).
  control({ id: "help", label: () => "Help", icon: "help", command: "help" }),
  control({ id: "lock", label: () => "Lock", icon: "lock", command: "lock" }),
  control({ id: "mode", label: () => "Focus mode", icon: "mode", command: "mode" }),
];

export function builtinToolbarRegistry(): ToolbarRegistry {
  const registry = new Registry<ToolbarControlDef>();
  for (const c of builtinControls) registry.register(c);
  return registry;
}

/** The controls to show: init.lua's ids in its order (unknown ones left out), else the default
 * set in registry order; then only those whose `when` holds. */
export function shownControls(
  defs: readonly ToolbarControlDef[],
  ids: readonly string[] | null,
  ctx: ToolbarContext,
): ToolbarControlDef[] {
  const picked =
    ids === null ? defs.filter((d) => d.byDefault) : ids.map((id) => defs.find((d) => d.id === id)).filter((d): d is ToolbarControlDef => !!d);
  return picked.filter((d) => d.when?.(ctx) ?? true);
}

const PATHS: Record<ToolbarIcon, React.ReactNode> = {
  find: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2L13.5 13.5" />
    </>
  ),
  add: <path d="M8 3v10M3 8h10" />,
  // This Box's square, an edge, and a dashed node: a box that isn't on the map (yet).
  quick: (
    <>
      <rect x="1.75" y="6" width="4" height="4" rx="0.8" />
      <path d="M6.5 8h3" />
      <circle cx="12.25" cy="8" r="2.5" strokeDasharray="1.6 1.3" />
    </>
  ),
  // Two lines, the second changed: a diff.
  changes: <path d="M3 5h10M3 8h6M3 11h8M12.5 9.5v3M11 11h3" />,
  // An arrow up out of a line: send it upstream.
  publish: <path d="M8 11V3.5M5 6.5l3-3 3 3M3.5 13h9" />,
  cmdline: <path d="M6 5.5v.01M6 10.5v.01M9 12.5l2.5-9" />,
  keys: (
    <>
      <rect x="2" y="4" width="12" height="8" rx="1.5" />
      <path d="M5 10h6M5 7h.01M8 7h.01M11 7h.01" />
    </>
  ),
  // A question mark in a ring.
  help: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M6.4 6.4a1.7 1.7 0 113.1 1c-.6.5-1.5.8-1.5 1.8M8 11.3v.01" />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.25" />
      <path d="M5.5 7V5.5a2.5 2.5 0 015 0V7" />
    </>
  ),
  mode: <path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" />,
  // A window with its right pane, and lines in it: Host details.
  details: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M10 3v10M11.5 6h1M11.5 8.5h1" />
    </>
  ),
  // Three nodes joined: a network (a Plugin's Topology or scan, ticket 78).
  map: (
    <>
      <circle cx="3.75" cy="11.5" r="1.75" />
      <circle cx="12.25" cy="11.5" r="1.75" />
      <circle cx="8" cy="4" r="1.75" />
      <path d="M5.5 11.5h5M4.7 10L7.1 5.6M11.3 10L8.9 5.6" />
    </>
  ),
  // A window with its left pane: the Sidebar.
  sidebar: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10" />
    </>
  ),
};

export function ToolbarIconSvg({ name }: { name: ToolbarIcon }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

export interface ToolbarProps {
  controls: readonly ToolbarControlDef[];
  ctx: ToolbarContext;
  /** A command's keys in keymap notation ("␣ f"), for the tooltip, or null. */
  keysFor(command: CommandLine): string | null;
  leader: string;
  run(line: CommandLine): void;
  side: "start" | "end";
}

/** The controls of one side. Buttons never take focus from the terminal, like the title bar's. */
export function Toolbar({ controls, ctx, keysFor, leader, run, side }: ToolbarProps) {
  const hints = useContext(HintsShown);
  const mine = controls.filter((c) => c.side === side);
  if (mine.length === 0) return null;
  return (
    <div className={`toolbar toolbar-${side}`} role="toolbar" aria-label={side === "end" ? "Commands" : "View"}>
      {mine.map((c) => {
        const label = c.label(ctx);
        const keys = keysFor(c.command);
        const count = c.count?.(ctx) ?? null;
        const pressed = c.pressed?.(ctx);
        return (
          <button
            key={c.id}
            type="button"
            tabIndex={-1}
            className={`toolbar-button${c.text ? " with-text" : ""}`}
            aria-label={label}
            aria-pressed={pressed}
            title={hints && keys ? `${label} (${keys.replace(LEADER, leader)})` : label}
            data-control={c.id}
            onMouseDown={keepFocus}
            onClick={() => run(c.command)}
          >
            {c.icon && <ToolbarIconSvg name={c.icon} />}
            {c.text && <span className="toolbar-text">{c.text}</span>}
            {count !== null && <span className="toolbar-count">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
