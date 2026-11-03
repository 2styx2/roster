// A Host row's menu (T166, #314, decision Q156): what a right-click on a Host's row in the Sidebar,
// or the Menu key or Shift+F10 on the App-mode cursor (`menu`), offers. Host rows show no buttons
// (they were ⓘ, ✓, ✎, × on the selected row, Q88); the menu has what they ran and the Host's other
// commands. Every item is a command line from the command table, the same one its old button or
// its key runs, so nothing here is a menu-only action (Q36). What this roster can't do (no Live
// Inventory, no `:edit`) and Folders' item without the Folders Plugin are left out, not greyed.
import type { CommandLine } from "../keymap";
import type { SidebarRow } from "./Sidebar";

export type MenuEntry =
  | {
      /** Short: the menu is named after the Host. "…" when the command asks for more. */
      label: string;
      command: CommandLine;
      /** Its keys in keymap notation ("␣ R"), drawn as keycaps when the hints are shown. */
      keys?: string | null;
    }
  | { separator: true };

export interface HostMenuOptions {
  /** The Host is in the Inventory, and whether it's reviewed (else the row is a Folder's entry for a
   * Host roster doesn't have). */
  reviewed: boolean | null;
  /** The Live Inventory (API 8): rename, move, remove. */
  live: boolean;
  /** `:edit` (API 5). */
  edit: boolean;
  /** The `folder` command is there (the Folders Plugin). */
  folders: boolean;
  /** The keys bound to a command line ("host rename"), or null. */
  keys(command: string): string | null;
}

/** A Host row's menu: open, look, change, then remove, separated; the row's own actions (an
 * unreview, a Plugin's) with the changes. */
export function hostMenu(row: SidebarRow, o: HostMenuOptions): MenuEntry[] {
  const host = row.host;
  if (host === undefined) return [];
  const own = (row.actions ?? []).map((a) => ({ label: a.label, command: a.command }));
  if (o.reviewed === null) return own;
  const groups: MenuEntry[][] = [
    o.reviewed
      ? [
          { label: "Open", command: `open ${host}` },
          { label: "New Session", command: `connect ${host}` },
        ]
      : [{ label: "Mark reviewed", command: `review ${host}` }],
    [
      { label: "Details", command: `info ${host}`, keys: o.keys("details") },
      { label: "Check", command: `check ${host}` },
      ...(o.edit ? [{ label: "Edit…", command: `edit ${host}`, keys: o.keys("edit") }] : []),
    ],
    [
      ...own,
      ...(o.live
        ? [
            { label: "Rename…", command: `host rename ${host}`, keys: o.keys("host rename") },
            { label: "Move to another group…", command: `host move ${host}`, keys: o.keys("host move") },
          ]
        : []),
      ...(o.folders ? [{ label: "Add to a Folder…", command: `folder add ${host}`, keys: o.keys("folder add") }] : []),
    ],
    o.live ? [{ label: "Remove from the Inventory…", command: `host remove ${host}`, keys: o.keys("host remove") }] : [],
  ];
  return groups.filter((g) => g.length > 0).flatMap((g, i) => (i === 0 ? g : [{ separator: true } as const, ...g]));
}
