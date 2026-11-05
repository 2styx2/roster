// The Sidebar in the workspace: its sections as the mode's layout picks them, built from the
// Sessions, the Inventory and the State; its cursor and selected row (decision Q88); a Host row's
// menu (T166, Q156); folding (h, l, the chevrons).
import { useMemo, useState, useSyncExternalStore } from "react";
import type { Capabilities } from "../backend/capabilities";
import type { Host, HostList } from "../backend/types";
import type { ChangesState } from "../edit/ChangesPanel";
import type { Options } from "../keymap";
import type { Registries } from "../registries";
import type { TabsSnapshot } from "../session/tabs";
import { currentFoldId, setFolded, type AppState } from "../state/appState";
import type { StateStore } from "../state/store";
import { isShown, pick, type ModeLayout } from "../view/layout";
import { badgesByHost } from "../view/status";
import { allRows, foldStep, moveCursor, type FoldHow, type ListMoveTo, type OpenMenu, type SidebarRow, type SidebarSection } from "./model";
import { sectionBuilder } from "./sections";

export interface SidebarModel {
  sections: SidebarSection[];
  rows: SidebarRow[];
  side: "left" | "right";
  shown: boolean;
  cursor: string | null;
  setCursor(id: string | null): void;
  selected: string | null;
  setSelected(id: string | null): void;
  /** Moves the cursor (and the selection) to `id`. */
  moveTo(id: string | null): void;
  /** Where the cursor goes on entering App mode: the selected row, else the raised one, else the top. */
  enterCursor(): void;
  cursorRow(): SidebarRow | null;
  /** j, k, gg, G: the cursor's next row. */
  move(to: ListMoveTo): void;
  fold(id: string | null, how: FoldHow): void;
  menu: OpenMenu | null;
  setMenu(menu: OpenMenu | null): void;
}

export function useSidebarModel(opts: {
  registries: Registries;
  layout: ModeLayout;
  sessions: TabsSnapshot;
  hosts: HostList | null;
  hostByName: ReadonlyMap<string, Host>;
  options: Options;
  appState: AppState;
  store: StateStore;
  caps: Capabilities;
  pending: ChangesState | null;
  addKeys: string | null;
}): SidebarModel {
  const { registries, layout, sessions, hosts, hostByName, options, appState, store, caps, pending, addKeys } = opts;
  const sectionDefs = useSyncExternalStore(registries.sidebar.subscribe, registries.sidebar.list);
  const badgeList = useSyncExternalStore(registries.badges.subscribe, registries.badges.list);
  const hostBadges = useMemo(() => badgesByHost(badgeList), [badgeList]);
  const folded = useMemo(() => new Set(appState.folded), [appState.folded]);
  // The Live Inventory (ticket 28, API 8): what's added and not Published yet shows dimmed.
  const canLive = caps.has("live");
  const canUnreview = caps.has("unreview");
  const live = useMemo(() => {
    if (!canLive) return undefined;
    const changes = pending?.state === "done" ? pending.changes : null;
    return {
      pendingHosts: new Set((changes?.hosts ?? []).filter((c) => c.change === "added").map((c) => c.host)),
      // A review that's still only a Pending change can be taken back from the same ✓ (issue #78).
      pendingReviews: canUnreview
        ? new Set((changes?.hosts ?? []).filter((c) => c.change === "changed" && c.fields.includes("reviewed")).map((c) => c.host))
        : new Set<string>(),
      pendingGroups: new Set((changes?.groups ?? []).filter((c) => c.change === "added").map((c) => c.group)),
    };
  }, [canLive, canUnreview, pending]);
  // The mode's layout may pick and order the Sidebar's sections (decision Q39).
  const shownDefs = useMemo(
    () => (layout.sections ? [...pick(sectionDefs, layout.sections)].map((d, i) => ({ ...d, order: i })) : sectionDefs),
    [sectionDefs, layout.sections],
  );
  // The Inventory heading's "Add a Host" (iteration 3 feedback): its keys, or why it can't.
  const addHost = useMemo(() => ({ keys: addKeys, tooOld: caps.has("add") ? null : caps.needsNewer("add") }), [addKeys, caps]);
  // Kept between renders: a Session's events rebuild only the sections that show Sessions (#62).
  const [build] = useState(sectionBuilder);
  const sections = useMemo(
    () =>
      hosts
        ? build(shownDefs, {
            sessions,
            hosts,
            hostByName,
            sessionsIn: options.sessions,
            state: appState,
            folded,
            ...(live ? { live } : {}),
            addHost,
            badges: hostBadges,
          })
        : [],
    [build, shownDefs, sessions, hosts, hostByName, options.sessions, appState, folded, live, addHost, hostBadges],
  );
  const rows = useMemo(() => allRows(sections), [sections]);
  const at = layout.pieces.find((p) => p.id === "sidebar")?.at;

  const [cursor, setCursor] = useState<string | null>(null);
  // The one last clicked, or where j/k left the cursor. Its buttons show; in App mode the cursor
  // row is the selected one.
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const moveTo = (id: string | null) => {
    setCursor(id);
    setSelected(id);
  };
  const cursorRow = () => rows.find((r) => r.id === cursor) ?? null;
  return {
    sections,
    rows,
    side: at === "right" ? "right" : "left",
    shown: isShown(layout, "sidebar") && sections.length > 0,
    cursor,
    setCursor,
    selected,
    setSelected,
    moveTo,
    enterCursor: () =>
      setCursor((selected !== null && rows.some((row) => row.id === selected) ? selected : null) ?? rows.find((row) => row.raised)?.id ?? rows[0]?.id ?? null),
    cursorRow,
    move: (to) => moveTo(moveCursor(rows, cursor, to)),
    fold: (given, how) => {
      const step = foldStep(rows, folded, cursor, given === null ? null : currentFoldId(given), how);
      if (step && "fold" in step) store.update((s) => setFolded(s, step.fold, step.folded));
      if (step?.moveTo) moveTo(step.moveTo);
    },
    menu,
    setMenu,
  };
}
