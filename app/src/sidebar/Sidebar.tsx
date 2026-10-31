// The Sidebar (GLOSSARY): a pane of sections, each a tree of rows, from the Sidebar section
// registry (sections.ts). The row on screen uses the raised style, and the same Host further down
// is only brighter ("also"); in App mode a cursor row shows where j/k (or the arrows) are, h/l fold
// and unfold, and Enter chooses. Rows, buttons, chevrons and drops only run command lines from the
// command table, so nothing here is a Sidebar-only action (decision Q36). The mouse works on every
// row without taking focus from the terminal.
//
// A row's buttons (rename, ⓘ, remove…) show on the selected row only, never on hover (decision Q88,
// owner): the row last left-clicked, or in App mode the cursor row. Hovering highlights a row and
// nothing more, so its address stays in view, and touch and pen work the same as a mouse. They
// appear without motion: j/k move them as often as a click does (taste.md: motion confirms).
//
// For assistive tech (ticket 29 M4) the rows are an ARIA tree: the scroller is the tree, each
// section a group, each row a treeitem with its level, and the App-mode cursor is the tree's
// aria-activedescendant while App takes focus there. Each row's name says its state in words
// (M3), and App mode shows the cursor row whole below the tree (M6).
//
// 91 Hosts is a few hundred elements: rows are memoized on their object (sections are rebuilt only
// when what they show changes), so moving the cursor re-renders two rows, not the tree.
import { memo, useCallback, useContext, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import type { CommandLine } from "../keymap";
import { formatCount } from "../ui/format";
import { HintsShown } from "../ui/hints";
import { Keys, LEADER, WithKeys } from "../ui/Keys";
import { DOT_WORDS, StateDot, type Dot } from "../ui/StateDot";

export type { Dot } from "../ui/StateDot";

/** A small button on a row or heading (close, rename, delete, new). */
export interface RowAction {
  /** The accessible name, e.g. "Close esxi-02". */
  label: string;
  icon: "close" | "edit" | "add" | "addGroup" | "review" | "unreview" | "info" | "copy";
  command: CommandLine;
  /** Always shown, not only on the selected row (the Inventory's "Add a Host"). */
  pinned?: boolean;
  /** The tooltip, when it should say more than the label (why it can't act). */
  title?: string;
  /** Its keys in keymap notation ("␣ +"), added to the tooltip while the hints are shown. */
  keys?: string;
}

export interface SidebarRow {
  /** Unique across all sections; also the fold key in State for a foldable row. */
  id: string;
  label: string;
  /** The Host the row stands for, if any: the on-screen Host's rows are raised or brighter, and
   * commands such as `folder add` act on the Host under the cursor. */
  host?: string;
  dot?: Dot;
  /** A short status after the label ("connecting…", "ended (code 0)"). */
  note?: string;
  /** The end of the label that must stay in view when the rest is cut off (a Session's " (2)"). */
  tail?: string;
  /** Right-aligned and faint: an address. It shows whole or not at all: the name comes first. */
  detail?: string;
  /** Right-aligned: how many Hosts a Folder or group holds. Formatted, and never cut off. */
  count?: number;
  /** A small badge ("unreviewed"). It gives way to the name: shown raised, selected or under the
   * cursor, and always in the tooltip. */
  badge?: string;
  /** Plugins' badges (`roster.badges.set`): a small chip each, right after the name, never cut
   * away (a long one is cut short); each named with its Plugin ("recent-alerts: 2"). */
  tags?: readonly { source: string; text: string }[];
  /** A glyph before the label: a Folder, an Inventory group. */
  icon?: "folder" | "group";
  /** A tooltip (and accessible description), e.g. "password login". */
  title?: string;
  /** The item on screen (decision Q31: the raised style). Set by the section, or by
   * buildSections for the on-screen Host's first row. */
  raised?: boolean;
  /** The on-screen Host where it appears again: brighter, not raised (set by buildSections). */
  also?: boolean;
  /** The raised row stands for a live Session (connected or connecting, not ended): it gets the
   * accent bar (decision Q53). Set by the Sessions section, or by buildSections. */
  live?: boolean;
  /** Added to roster.yml and not Published yet (ticket 28): dimmed, with a dot. */
  pending?: boolean;
  /** A Session's link to its Host (issue #78): an accent edge is drawn from the node toward the
   * terminal while it connects, fades once it's up, and snaps back when it's down. */
  link?: "connecting" | "up" | "down";
  /** Tree depth within its section; rows after a row with a lower level are its children. */
  level?: number;
  /** It has children that h/l (or its chevron) fold and unfold. */
  foldable?: boolean;
  /** Folded now (set by buildSections from State). */
  folded?: boolean;
  /** The row h goes to: its parent row, or the section heading (set by buildSections). */
  parent?: string;
  /** Whatever a section wants its commands to find on the cursor row (Folders: the Folder). */
  data?: Readonly<Record<string, string>>;
  /** What Enter or a click runs. */
  command: CommandLine;
  /** Buttons shown on the selected row (decision Q88). */
  actions?: readonly RowAction[];
  /** Dragging the row carries this (a Host name). */
  drag?: string;
  /** Run when the dragged row is dropped somewhere in the Sidebar that doesn't take it (out of a
   * Folder: remove it). */
  dragOut?: CommandLine;
  /** This row takes a drop: the command line for the dragged payload, or null to ignore it. */
  drop?(payload: string): CommandLine | null;
}

export interface SidebarSection {
  id: string;
  title: string;
  count?: number;
  rows: readonly SidebarRow[];
  /** Shown when there are no rows. Key sequences in backticks are drawn as keycaps. */
  empty?: string;
  /** Buttons on the heading ("+" for a new Folder). */
  actions?: readonly RowAction[];
  /** The section (heading or empty space) takes a drop. */
  drop?(payload: string): CommandLine | null;
  /** Folded now: the heading shows, the rows don't (set by buildSections from State). */
  folded?: boolean;
}

export interface SidebarProps {
  sections: readonly SidebarSection[];
  side: "left" | "right";
  /** The cursor row, shown in App mode; null hides it. */
  cursor: string | null;
  /** The selected row (or heading), whose buttons show: the one last clicked, or the cursor in
   * App mode (decision Q88). */
  selected?: string | null;
  /** A row or heading was left-clicked: it's the selected one now. */
  onSelect?(id: string): void;
  /** The Leader as written in the keymap, for the hints. */
  leaderHint: string;
  /** The keys that open the Picker ("␣ f"), if the keymap has them. */
  findKeys?: string | null;
  /** Runs a command line: for rows, and the buttons at the top and bottom. */
  run(line: CommandLine): void;
  /** Gets the tree element (App focuses it in App mode). */
  treeRef?(el: HTMLDivElement | null): void;
  /** The tree took focus from outside (Tab, a click): App enters App mode. */
  onTreeFocus?(from: Element | null): void;
  /** Focus left the tree for somewhere outside it. */
  onTreeBlur?(to: Element | null): void;
}

/** A row's DOM id, for aria-activedescendant: any row id, made a valid id. */
export const rowDomId = (id: string) => `sb-${Array.from(id, (c) => (/[\w-]/.test(c) ? c : `_${c.codePointAt(0)}_`)).join("")}`;

const hostsCount = (n: number) => `${formatCount(n)} ${n === 1 ? "Host" : "Hosts"}`;

/** What a row says about itself, beyond its label: its state in words (never only a dot's colour),
 * its note, a badge, its address, its count. */
export function rowFacts(row: SidebarRow): string[] {
  const facts: string[] = [];
  // An ended or connecting Session's note already says it.
  if (row.dot && !((row.dot === "ended" || row.dot === "connecting") && row.note)) facts.push(DOT_WORDS[row.dot]);
  if (row.note) facts.push(row.note);
  // An unreviewed Host's badge is what its dot already said.
  if (row.badge && row.dot !== "off") facts.push(row.badge);
  for (const t of row.tags ?? []) facts.push(tagName(t));
  if (row.detail) facts.push(row.detail);
  if (row.count !== undefined) facts.push(hostsCount(row.count));
  if (row.pending) facts.push("not Published yet");
  return facts;
}

/** A Plugin badge's name, for its tooltip and the row's accessible name: "recent-alerts: 2". */
const tagName = (t: { source: string; text: string }) => `${t.source}: ${t.text}`;

/** The row's accessible name: "esxi-02, password login, 10.19.77.5". */
export const rowName = (row: SidebarRow) => [row.label, ...rowFacts(row)].join(", ");

const SearchIcon = () => (
  <svg className="sb-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" strokeLinecap="round" />
  </svg>
);

/** The id of a section's heading, as a cursor stop and a fold key. */
export const headingId = (section: string) => `section:${section}`;

/** Keeps focus where it is (the terminal) when a row or button is clicked. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();



type Run = (line: CommandLine) => void;
type DropTarget = (payload: string) => CommandLine | null;

interface Drag {
  /** A mousedown on a row: keeps focus where it is, except on a draggable row, whose mousedown
   * must go ahead for the drag; that one gives focus back on the click (`refocus`). */
  press(row: SidebarRow, e: React.MouseEvent): void;
  refocus(): void;
  start(row: SidebarRow, e: DragEvent): void;
  /** Lets a drop happen here (a target, or the open Sidebar for a row that can be dragged out). */
  over(e: DragEvent, target: DropTarget | undefined): void;
  drop(e: DragEvent, target: DropTarget | undefined): void;
}

/** An action's tooltip: its own, else its label, with its keys (the Leader spelled out) unless the
 * hints are hidden (`ui.hints`). */
function actionTitle(a: RowAction, hints: boolean, leader: string): string {
  if (a.title) return a.title;
  if (!hints || !a.keys) return a.label;
  return `${a.label} (${a.keys.replace(LEADER, leader)})`;
}

function Actions({ actions, run, leader = "" }: { actions: readonly RowAction[]; run: Run; leader?: string }) {
  const hints = useContext(HintsShown);
  return actions.map((a) => (
    <button
      key={a.label}
      type="button"
      className={`sb-action${a.pinned ? " pinned" : ""}`}
      aria-label={a.label}
      title={actionTitle(a, hints, leader)}
      tabIndex={-1}
      onMouseDown={keepFocus}
      onClick={(e) => {
        e.stopPropagation();
        run(a.command);
      }}
    >
      <Icon name={a.icon} />
    </button>
  ));
}

const ICONS: Record<RowAction["icon"], string> = {
  close: "M4 4l8 8M12 4l-8 8",
  edit: "M3 13l1-3.5L10.5 3 13 5.5 6.5 12z",
  add: "M8 3v10M3 8h10",
  // A group (two stacked rows, as the group rows' icon) with a + beside it.
  addGroup: "M2 3.5h7v3.5H2zM2 9h7v3.5H2zM13 5.5v5M10.5 8h5",
  review: "M3.5 8.5l3 3 6-7",
  // Take a review back: an arrow turning back over the line (undo).
  unreview: "M5.5 3.5L2.5 6.5l3 3M2.5 6.5h7a3.5 3.5 0 010 7H7",
  // An i in a ring: the Host's details (ticket 18).
  info: "M8 2.25a5.75 5.75 0 110 11.5 5.75 5.75 0 010-11.5zM8 7.25v3.5M8 5.25v.01",
  // Two sheets, one over the other: copy (a Plugin's row, ticket 56).
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
};

const Icon = ({ name }: { name: RowAction["icon"] }) => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d={ICONS[name]} />
  </svg>
);

const Chevron = ({ folded }: { folded: boolean }) => (
  <svg className={`sb-chev${folded ? " folded" : ""}`} viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
    <path d="M2.5 3.75L5 6.25l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ROW_ICONS: Record<NonNullable<SidebarRow["icon"]>, React.ReactNode> = {
  folder: <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />,
  group: (
    <>
      <rect x="2" y="3" width="12" height="4" rx="1" />
      <rect x="2" y="9" width="12" height="4" rx="1" />
    </>
  ),
};

const RowIcon = ({ name }: { name: NonNullable<SidebarRow["icon"]> }) => (
  <svg className="sb-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    {ROW_ICONS[name]}
  </svg>
);


type Select = (id: string) => void;

const Row = memo(function Row({
  row,
  cursor,
  selected,
  run,
  select,
  drag,
}: {
  row: SidebarRow;
  cursor: boolean;
  selected: boolean;
  run: Run;
  select: Select;
  drag: Drag;
}) {
  const cls = `sb-row${row.raised ? " raised" : ""}${row.raised && row.live ? " live" : ""}${row.also ? " also" : ""}${cursor ? " cursor" : ""}${selected ? " selected" : ""}${row.actions ? " has-actions" : ""}${row.pending ? " pending" : ""}${row.link ? ` link-${row.link}` : ""}`;
  const cut = row.tail !== undefined && row.label.endsWith(row.tail);
  return (
    <li
      role="none"
      className={cls}
      data-row={row.id}
      style={row.level ? { paddingLeft: `${row.level * 18}px` } : undefined}
      // Chromium won't start a drag from a <button>, so the row is a div with the button role,
      // not focusable, and the <li> is what's dragged.
      draggable={row.drag !== undefined}
      onDragStart={row.drag !== undefined ? (e) => drag.start(row, e) : undefined}
      onDragOver={row.drop ? (e) => drag.over(e, row.drop) : undefined}
      onDrop={row.drop ? (e) => drag.drop(e, row.drop) : undefined}
    >
      <div
        role="treeitem"
        id={rowDomId(row.id)}
        className="sb-item"
        aria-level={(row.level ?? 0) + 2}
        aria-label={rowName(row)}
        aria-selected={cursor ? true : undefined}
        aria-current={row.raised ? "true" : undefined}
        aria-expanded={row.foldable ? !row.folded : undefined}
        title={row.title}
        onMouseDown={(e) => drag.press(row, e)}
        onClick={() => {
          select(row.id);
          run(row.command);
          drag.refocus();
        }}
      >
        {row.foldable && <Chevron folded={row.folded ?? false} />}
        {row.icon && <RowIcon name={row.icon} />}
        {row.dot && <StateDot dot={row.dot} />}
        {/* The name first: what follows it in here drops out whole (to a hidden second line)
            when there's no room, and the name is cut only when it alone is too long. */}
        {/* Hovering the text shows the whole name (it may be cut off), then the row's tooltip. */}
        <span className="sb-text" title={row.title ? `${row.label}\n${row.title}` : row.label}>
          {/* A note ("ended (code 0)") stays beside the name like the " (2)" tail: when the name
              is cut, the label gives way, never the state. */}
          <span className="sb-name">
            <span className="sb-label" dir="auto">
              {cut ? row.label.slice(0, -(row.tail as string).length) : row.label}
            </span>
            {cut && <span className="sb-tail">{row.tail}</span>}
            {row.note && <span className="sb-note"> {row.note}</span>}
            {row.pending && <span className="sb-pending-dot" aria-hidden="true" title="Not Published yet" />}
            {row.tags?.map((t) => (
              <span key={t.source} className="sb-tag" title={tagName(t)}>
                {t.text}
              </span>
            ))}
          </span>
          {row.badge && <span className="sb-badge"> {row.badge}</span>}
          {row.detail && <span className="sb-detail"> {row.detail}</span>}
        </span>
        {row.count !== undefined && <span className="sb-num">{formatCount(row.count)}</span>}
      </div>
      {row.actions && <Actions actions={row.actions} run={run} />}
    </li>
  );
});

const Section = memo(function Section({
  section,
  cursor,
  selected,
  run,
  select,
  drag,
  leader,
}: {
  section: SidebarSection;
  /** The cursor if it's in this section, else null (so the other sections don't re-render). */
  cursor: string | null;
  /** The selected row if it's in this section, else null. */
  selected: string | null;
  run: Run;
  select: Select;
  drag: Drag;
  leader: string;
}) {
  const id = headingId(section.id);
  const folded = section.folded ?? false;
  const emptyShown = !folded && section.rows.length === 0 && section.empty !== undefined;
  return (
    <section
      role="group"
      className="sb-section"
      aria-label={section.title}
      onDragOver={section.drop ? (e) => drag.over(e, section.drop) : undefined}
      onDrop={section.drop ? (e) => drag.drop(e, section.drop) : undefined}
    >
      <div className={`sb-heading${cursor === id ? " cursor" : ""}${selected === id ? " selected" : ""}`} data-row={id} role="none">
        <div
          role="treeitem"
          id={rowDomId(id)}
          className="sb-heading-button"
          aria-level={1}
          aria-expanded={!folded}
          aria-label={section.title}
          aria-selected={cursor === id ? true : undefined}
          aria-describedby={emptyShown ? `${rowDomId(id)}-empty` : undefined}
          onMouseDown={keepFocus}
          onClick={() => {
            select(id);
            run(`togglefold ${id}`);
          }}
        >
          <Chevron folded={folded} />
          <h2>{section.title}</h2>
          {section.count !== undefined && <span className="sb-count">{formatCount(section.count)}</span>}
        </div>
        {section.actions && <Actions actions={section.actions} run={run} leader={leader} />}
      </div>
      {emptyShown && (
        <p className="sb-empty" id={`${rowDomId(id)}-empty`}>
          <WithKeys text={section.empty ?? ""} leader={leader} />
        </p>
      )}
      {!folded && (
        <ul className="sb-rows" role="none">
          {section.rows.map((row) => (
            <Row key={row.id} row={row} cursor={row.id === cursor} selected={row.id === selected} run={run} select={select} drag={drag} />
          ))}
        </ul>
      )}
    </section>
  );
});

/** The cursor row, whole (M6): a cut-off name, its state and address, readable from the keyboard.
 * It repeats what the tree item's name already tells assistive tech, so it's hidden from it. */
function Details({ row }: { row: SidebarRow }) {
  const facts = rowFacts(row);
  return (
    <div className="sb-details" data-testid="sidebar-details" aria-hidden="true">
      <p className={`sb-details-name${row.dot ? " data" : ""}`} dir="auto">
        {row.label}
      </p>
      {(facts.length > 0 || row.title) && <p className="sb-details-facts">{[...facts, ...(row.title ? [row.title] : [])].join(" · ")}</p>}
    </div>
  );
}

export function Sidebar({
  sections,
  side,
  cursor,
  selected = null,
  onSelect,
  leaderHint,
  findKeys = "␣ f",
  run,
  treeRef,
  onTreeFocus,
  onTreeBlur,
}: SidebarProps) {
  // A stable `run` and `select` for the memoized rows; they always call the latest one.
  const runRef = useRef(run);
  const selectRef = useRef(onSelect);
  useLayoutEffect(() => {
    runRef.current = run;
    selectRef.current = onSelect;
  });
  const stableRun = useCallback((line: CommandLine) => runRef.current(line), []);
  const stableSelect = useCallback((id: string) => selectRef.current?.(id), []);

  // Keep the cursor row in view as j/k walk a long tree.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const setTree = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      treeRef?.(el);
    },
    [treeRef],
  );
  useLayoutEffect(() => {
    if (cursor === null) return;
    const el = scrollRef.current?.querySelector(`[data-row="${CSS.escape(cursor)}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  // The dragged row lives here; its Host also goes on the dataTransfer as text (WebView2 needs
  // some data for a drag to start).
  const dragged = useRef<SidebarRow | null>(null);
  const focusBefore = useRef<Element | null>(null);
  const pressing = useRef(false);
  const cursorRow = cursor === null ? null : (allRows(sections).find((r) => r.id === cursor) ?? null);

  const [drag] = useState<Drag>(() => ({
    press(row, e) {
      if (row.drag === undefined) return e.preventDefault();
      focusBefore.current = document.activeElement;
      // Only the focus this press itself causes (it comes right after, in the same task).
      pressing.current = true;
      setTimeout(() => {
        pressing.current = false;
      }, 0);
    },
    refocus() {
      const el = focusBefore.current;
      focusBefore.current = null;
      if (el instanceof HTMLElement && el.isConnected && (document.activeElement === document.body || !document.activeElement)) el.focus();
    },
    start(row, e) {
      dragged.current = row;
      e.dataTransfer?.setData("text/plain", row.drag ?? "");
    },
    over(e, target) {
      const row = dragged.current;
      if (row && (target || row.dragOut)) e.preventDefault();
    },
    drop(e, target) {
      const row = dragged.current;
      if (!row) return;
      // Handled by the innermost target (a row before its section, a section before the Sidebar).
      e.preventDefault();
      e.stopPropagation();
      dragged.current = null;
      const line = target ? target(row.drag ?? "") : (row.dragOut ?? null);
      if (line) runRef.current(line);
    },
  }));

  return (
    <nav className={`sidebar side-${side}`} aria-label="Sidebar">
      <button type="button" className="sb-find" onMouseDown={keepFocus} onClick={() => run("find")}>
        <SearchIcon />
        <span className="sb-find-label">Find a Host</span>
        {findKeys && (
          <>
            <span className="visually-hidden">,</span>{" "}
            <Keys keys={findKeys} leader={leaderHint} />
          </>
        )}
      </button>
      <div
        className="sb-scroll"
        ref={setTree}
        role="tree"
        aria-label="Sessions and Hosts"
        tabIndex={0}
        aria-activedescendant={cursor !== null ? rowDomId(cursor) : undefined}
        onFocus={(e) => {
          if (e.target !== e.currentTarget || e.currentTarget.contains(e.relatedTarget)) return;
          // A press on a draggable row can't keep focus where it is (that would stop the drag), so the
          // tree takes it. That's a click, not Tab reaching the tree: entering App mode here put the
          // cursor on the top row and scrolled the Sidebar up to it. Focus goes straight back instead.
          const before = focusBefore.current;
          if (pressing.current && before !== null) {
            if (before instanceof HTMLElement && before.isConnected && before !== e.currentTarget) before.focus({ preventScroll: true });
            return;
          }
          onTreeFocus?.(e.relatedTarget);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) onTreeBlur?.(e.relatedTarget);
        }}
        onDragOver={(e) => drag.over(e, undefined)}
        onDrop={(e) => drag.drop(e, undefined)}
        onDragEnd={() => {
          dragged.current = null;
          drag.refocus();
        }}
      >
        {sections.map((section) => (
          <Section
            key={section.id}
            section={section}
            cursor={cursor !== null && cursorIn(section, cursor) ? cursor : null}
            selected={selected !== null && cursorIn(section, selected) ? selected : null}
            run={stableRun}
            select={stableSelect}
            drag={drag}
            leader={leaderHint}
          />
        ))}
      </div>
      {cursorRow && <Details row={cursorRow} />}
      <div className="sb-foot">
        <button type="button" onMouseDown={keepFocus} onClick={() => run("keys")}>
          Keys
        </button>
        <button type="button" onMouseDown={keepFocus} onClick={() => run("lock")}>
          Lock
        </button>
      </div>
    </nav>
  );
}

function cursorIn(section: SidebarSection, cursor: string): boolean {
  return cursor === headingId(section.id) || section.rows.some((r) => r.id === cursor);
}

/** A section's heading as a cursor stop. */
function headingRow(section: SidebarSection): SidebarRow {
  const id = headingId(section.id);
  return { id, label: section.title, level: -1, foldable: true, folded: section.folded ?? false, command: `togglefold ${id}` };
}

/** Every cursor stop, top to bottom (the order j/k walk): each heading, then its shown rows. */
export function allRows(sections: readonly SidebarSection[]): SidebarRow[] {
  return sections.flatMap((s) => [headingRow(s), ...(s.folded ? [] : s.rows)]);
}

/** The cursor after a list action; it stays put at either end. */
export function moveCursor(
  rows: readonly SidebarRow[],
  cursor: string | null,
  move: "down" | "up" | "top" | "bottom",
): string | null {
  if (rows.length === 0) return null;
  const i = rows.findIndex((r) => r.id === cursor);
  const last = rows.length - 1;
  const next =
    move === "top" ? 0
    : move === "bottom" ? last
    : i < 0 ? 0
    : Math.max(0, Math.min(last, i + (move === "down" ? 1 : -1)));
  return rows[next]?.id ?? null;
}
