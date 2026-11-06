// The Sidebar in the workspace: its sections as the mode's layout picks them, built from the
// Sessions, the Inventory and the State; its cursor and selected row (decision Q88); a Host row's
// menu (T166, Q156); folding (h, l, the chevrons).
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Capabilities } from "../backend/capabilities";
import type { Host, HostList } from "../backend/types";
import type { ChangesState } from "../edit/ChangesPanel";
import type { Options } from "../keymap";
import type { Registries } from "../registries";
import type { TabsSnapshot } from "../session/tabs";
import { currentFoldId, setFolded, type AppState } from "../state/appState";
import type { StateStore } from "../state/store";
import { useLatest } from "../ui/latest";
import { ADD_HOSTS_TOO_OLD, type Message } from "../ui/messages";
import { useMediaMatch } from "../ui/useMediaMatch";
import { isShown, pick, type ModeLayout } from "../view/layout";
import { badgesByHost } from "../view/status";
import {
  allRows,
  firstStop,
  foldStep,
  moveCursor,
  ROW_SLIP_MS,
  type FoldHow,
  type ListMoveTo,
  type OpenMenu,
  type RowSlipData,
  type SidebarRow,
  type SidebarSection,
} from "./model";
import { sectionBuilder } from "./sections";

export interface SidebarModel {
  sections: SidebarSection[];
  rows: SidebarRow[];
  side: "left" | "right";
  shown: boolean;
  cursor: string | null;
  setCursor(id: string | null): void;
  selected: string | null;
  /** A row was clicked: it's the selected one, and where App mode starts next. */
  setSelected(id: string | null): void;
  /** Where App mode starts next (Enter chose it), without selecting it. */
  setLastStop(id: string | null): void;
  /** Moves the cursor to `id`; outside App mode it isn't drawn (round 19), but App mode starts there again. */
  moveTo(id: string | null): void;
  /** Where the cursor goes on entering App mode: where it was left, else the Session on screen, else
   * the first Host, else the top (`firstStop`, Q242 a). */
  enterCursor(): void;
  cursorRow(): SidebarRow | null;
  /** j, k, gg, G: the cursor's next row. */
  move(to: ListMoveTo): void;
  fold(id: string | null, how: FoldHow): void;
  menu: OpenMenu | null;
  setMenu(menu: OpenMenu | null): void;
  /** The Inventory heading's "Add a Host" (and the idle pane's): its keys, or why this roster can't. */
  addHost: { keys: string | null; tooOld: string | null };
  /** What a row's own command said went wrong, said under that row (round 20). */
  slip: RowSlipData | null;
  clearSlip(): void;
  /** A command runs from the Sidebar (a click, a button, a menu item): for the row just clicked
   * (or whose menu is open), else the cursor's. */
  runFromRow(): void;
  /** `row`'s own command runs now (Enter in App mode). */
  ranFrom(row: string): void;
  /** Takes a plain message (an error or an answer) that names the row whose command ran last, for
   * a few seconds, to that row's slip; true when it did (useMessages' divert). */
  divert(m: Message): boolean;
  /** The window is too narrow to dock the Sidebar (styles.css, 720 px): it floats over the terminal. */
  narrow: boolean;
  /** `sidebar` (␣ e) showed it over the Session on screen (or over the idle pane) in a narrow window. */
  peek: boolean;
  /** Shows it over the terminal until the Session changes, or tucks it away again. */
  togglePeek(): void;
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
  // The Inventory heading's "Add a Host" (iteration 3 feedback): its keys, or why it can't, said in
  // the app's words, not serve's API numbers (round 19): what to do instead, in the text colour,
  // since nothing broke. The + controls aren't offered then (toolbar, Inventory heading).
  const addHost = useMemo(() => ({ keys: addKeys, tooOld: caps.has("add") ? null : ADD_HOSTS_TOO_OLD }), [addKeys, caps]);
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
  // The selected row (decision Q88): the one last clicked. Its buttons show; in App mode the cursor
  // row is the selected one. Where j/k left the cursor isn't drawn outside App mode (round 19: kept
  // selected, its name in the text colour read as another live Session); App mode starts there
  // again (`lastStop`, Q242 a).
  const [selected, setSelectedNow] = useState<string | null>(null);
  /** The row last clicked in the Sidebar, at once (the state above updates after the click's run). */
  const picked = useRef<string | null>(null);
  const [lastStop, setLastStop] = useState<string | null>(null);
  const setSelected = (id: string | null) => {
    picked.current = id;
    setSelectedNow(id);
    setLastStop(id);
  };
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const moveTo = (id: string | null) => {
    setCursor(id);
    setSelectedNow(null);
    setLastStop(id);
  };
  const cursorRow = () => rows.find((r) => r.id === cursor) ?? null;
  // Round 20: what a Sidebar row's own command says went wrong ("esx-02 isn't reviewed yet…", a
  // Folder's or a group's change refused) is said under that row, where you were looking, not at the
  // foot of the pane. `rowRun` is the row whose command ran last from the Sidebar (a click, its
  // button or menu, Enter in App mode), for a few seconds; a plain message (an error or an answer)
  // that names the row goes to its slip, and still into `:messages`.
  const rowRun = useRef<{ row: string; at: number } | null>(null);
  const rowsNow = useLatest<readonly SidebarRow[]>(rows);
  const [slip, setSlip] = useState<RowSlipData | null>(null);
  // In a window too narrow to dock it (styles.css, 720 px) the Sidebar floats over the terminal.
  // It then steps aside while a Session is in front and you're in the terminal, and is there in
  // App mode, where you use it; `sidebar` (␣ e) shows it anyway until the Session changes. Hidden,
  // not unmounted, so it keeps its scroll; keyboard-paced, so it doesn't animate.
  const narrow = useMediaMatch("(max-width: 720px)");
  // The Session the Sidebar was shown over: switching Sessions tucks it away again. -1 stands for
  // "no Session": the idle pane can be peeked over too.
  const [peekFor, setPeekFor] = useState<number | null>(null);
  const peek = peekFor !== null && peekFor === (sessions.active ?? -1);
  return {
    sections,
    rows,
    side: at === "right" ? "right" : "left",
    shown: isShown(layout, "sidebar") && sections.length > 0,
    cursor,
    setCursor,
    selected,
    setSelected,
    setLastStop,
    moveTo,
    enterCursor: () => setCursor(firstStop(rows, lastStop)),
    cursorRow,
    move: (to) => moveTo(moveCursor(rows, cursor, to)),
    fold: (given, how) => {
      const step = foldStep(rows, folded, cursor, given === null ? null : currentFoldId(given), how);
      if (step && "fold" in step) store.update((s) => setFolded(s, step.fold, step.folded));
      if (step?.moveTo) moveTo(step.moveTo);
    },
    menu,
    setMenu,
    addHost,
    slip,
    clearSlip: () => setSlip(null),
    runFromRow: () => {
      const row = menu?.row ?? picked.current ?? cursor;
      rowRun.current = row === null ? null : { row, at: Date.now() };
      setSlip(null);
    },
    ranFrom: (row) => {
      rowRun.current = { row, at: Date.now() };
    },
    divert: (m) => {
      const from = rowRun.current;
      if (typeof m !== "string" || !from || Date.now() - from.at >= ROW_SLIP_MS) return false;
      const row = rowsNow.get().find((r) => r.id === from.row);
      const name = row ? [row.host, row.label].find((n) => n !== undefined && m.includes(n)) : undefined;
      if (!row || name === undefined) return false;
      rowRun.current = null;
      setSlip({ row: row.id, text: m, ...(row.host === name ? { name } : {}) });
      return true;
    },
    narrow,
    peek,
    togglePeek: () => setPeekFor(peek ? null : (sessions.active ?? -1)),
  };
}
