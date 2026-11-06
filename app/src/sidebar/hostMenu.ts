// A Host row's menu (T166, #314, decision Q156): what a right-click on a Host's row in the Sidebar,
// or the Menu key or Shift+F10 on the App-mode cursor (`menu`), offers. Host rows show no buttons
// (they were ⓘ, ✓, ✎, × on the selected row, Q88); the menu has what they ran and the Host's other
// commands. Every item is a command line from the command table, the same one its old button or
// its key runs, so nothing here is a menu-only action (Q36). What this roster can't do (no Live
// Inventory, no `:edit`) and Folders' item without the Folders Plugin are left out, not greyed.
import type { Capabilities } from "../backend/capabilities";
import type { CommandLine } from "../keymap";
import type { SidebarRow } from "./model";

export type MenuEntry =
  | {
      /** Short: the menu is named after the Host. "…" when the command asks for more. Never the
       * row's own names (round 22): those go in `full`. */
      label: string;
      /** The whole label, names and all ("Close esx-02"), for the item's tooltip and description. */
      full?: string;
      command: CommandLine;
      /** Its keys in keymap notation ("␣ R"), drawn as keycaps when the hints are shown. */
      keys?: string | null;
    }
  | { separator: true };

export interface HostMenuOptions {
  /** The Host is in the Inventory, and whether it's reviewed (else the row is a Folder's entry for a
   * Host roster doesn't have). */
  reviewed: boolean | null;
  /** What roster can do: the Live Inventory (rename, move, remove), `:edit`. */
  caps: Pick<Capabilities, "has">;
  /** The `folder` command is there (the Folders Plugin). */
  folders: boolean;
  /** The keys bound to a command line ("host rename"), or null. */
  keys(command: string): string | null;
  /** The Host already has a Session: Open goes to it, so it says so. */
  hasSession?: boolean;
  /** The list's key for Enter on a row ("Enter"), which opens it: shown beside Open. */
  openKeys?: string | null;
}

/** A Host row's menu: open, look, change, then remove, separated; the row's own actions (an
 * unreview, a Plugin's) with the changes. */
export function hostMenu(row: SidebarRow, o: HostMenuOptions): MenuEntry[] {
  const host = row.host;
  const own = (row.actions ?? []).map((a) =>
    a.short && a.short !== a.label
      ? { label: a.short, full: a.label, command: a.command }
      : { label: a.label, command: a.command },
  );
  // A group's (or another row's) menu is its own actions: the buttons its heading shows on hover.
  if (host === undefined) return own;
  if (o.reviewed === null) return own;
  const groups: MenuEntry[][] = [
    o.reviewed
      ? [
          // Open goes to the Host's Session when it has one, so it says that; New Session always
          // opens another. Each names its key where one is bound.
          { label: o.hasSession ? "Go to its Session" : "Open", command: `open ${host}`, keys: o.openKeys ?? null },
          // Another Session only means something once there's one: with none, Open is it.
          ...(o.hasSession ? [{ label: "New Session", command: `connect ${host}`, keys: o.keys(`connect`) }] : []),
        ]
      : [{ label: "Mark reviewed", command: `review ${host}` }],
    [
      { label: "Details", command: `info ${host}`, keys: o.keys("details") },
      { label: "Check", command: `check ${host}` },
      ...(o.caps.has("edit") ? [{ label: "Edit…", command: `edit ${host}`, keys: o.keys("edit") }] : []),
    ],
    [
      ...own,
      ...(o.caps.has("live")
        ? [
            { label: "Rename…", command: `host rename ${host}`, keys: o.keys("host rename") },
            { label: "Move to another group…", command: `host move ${host}`, keys: o.keys("host move") },
          ]
        : []),
      ...(o.folders ? [{ label: "Add to a Folder…", command: `folder add ${host}`, keys: o.keys("folder add") }] : []),
    ],
    o.caps.has("live") ? [{ label: "Remove from the Inventory…", command: `host remove ${host}`, keys: o.keys("host remove") }] : [],
  ];
  return groups.filter((g) => g.length > 0).flatMap((g, i) => (i === 0 ? g : [{ separator: true } as const, ...g]));
}
