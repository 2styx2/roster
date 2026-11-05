// The Sidebar (GLOSSARY): a pane of sections, each a tree of rows, from the Sidebar section
// registry (sections.ts). The row on screen uses the raised style, and the same Host further down
// is only brighter ("also"); in App mode a cursor row shows where j/k (or the arrows) are, h/l fold
// and unfold, and Enter chooses. Rows, buttons, chevrons and drops only run command lines from the
// command table, so nothing here is a Sidebar-only action (decision Q36). The mouse works on every
// row without taking focus from the terminal.
//
// A row's buttons (a group's rename and delete, a Session's close…) show on the selected row only,
// never on hover (decision Q88, owner): the row last left-clicked, or in App mode the cursor row.
// Hovering highlights a row and nothing more, so its address stays in view, and touch and pen work
// the same as a mouse. They appear without motion: j/k move them as often as a click does
// (taste.md: motion confirms). A Host's row has no buttons: a right-click, or the Menu key or
// Shift+F10 on the cursor, opens its menu (T166, decision Q156: RowMenu.tsx, hostMenu.ts).
//
// For assistive tech (ticket 29 M4) the rows are an ARIA tree: the scroller is the tree, each
// section a group, each row a treeitem with its level, and the App-mode cursor is the tree's
// aria-activedescendant while App takes focus there. Each row's name says its state in words
// (M3), and App mode shows the cursor row whole below the tree (M6).
//
// 91 Hosts is a few hundred elements: rows are memoized on their object (sections are rebuilt only
// when what they show changes), so moving the cursor re-renders two rows, not the tree.
import {
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { hopWords, type Breadcrumb } from "../session/breadcrumb";
import { HopCrumb } from "../session/HopCrumb";
import type { CommandLine } from "../keymap";
import { formatCount } from "../ui/format";
import { HintsShown } from "../ui/hints";
import { Keys, LEADER, WithKeys } from "../ui/Keys";
import { DOT_WORDS, StateDot, type Dot, type Light } from "../ui/StateDot";
import type { MenuEntry } from "./hostMenu";
import { RowMenu } from "./RowMenu";
import { MessageText } from "../ui/MessageText";

export type { Dot } from "../ui/StateDot";

/** A small button on a row or heading (close, rename, delete, new). */
export interface RowAction {
  /** The accessible name, e.g. "Close esxi-02". */
  label: string;
  icon:
    | "close"
    | "edit"
    | "add"
    | "addGroup"
    | "review"
    | "unreview"
    | "info"
    | "copy"
    | "plan"
    | "apply"
    | "cut"
    | "map"
    | "reconnect";
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
  /** Its Host has a Session that's connected or connecting: the node takes the accent. At rest a
   * node is muted, whatever its shape (taste.md: the accent means live, decision Q204). */
  lit?: Light;
  /** A short status after the label ("connecting…", "ended (code 0)"). */
  note?: string;
  /** The end of the label that must stay in view when the rest is cut off (a Session's " (2)"). */
  tail?: string;
  /** Right-aligned and faint: an address. It shows whole or not at all: the name comes first. */
  detail?: string;
  /** A Session's breadcrumb (ticket 120): the Host a nested ssh took it to, after the name. */
  hop?: Breadcrumb;
  /** Right-aligned: how many Hosts a Folder or group holds. Formatted, and never cut off. */
  count?: number;
  /** A Session's number, the one `␣ 1`–`9` jumps to: right-aligned and faint, a key hint (Q215). */
  index?: number;
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
  /** Buttons shown on the selected row (decision Q88); on a `menu` row, items in its menu. */
  actions?: readonly RowAction[];
  /** A Host's row (T166, Q156): no buttons; a right-click or the Menu key opens its menu. */
  menu?: boolean;
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
  /** The open Host row menu (T166, Q156): its row, and the pointer (null: opened by a key). */
  menu?: OpenMenu | null;
  /** Opens (a right-click on a Host's row) or closes the menu. */
  onMenu?(menu: OpenMenu | null): void;
  /** What a Host row's menu offers (hostMenu.ts). */
  rowMenu?(row: SidebarRow): readonly MenuEntry[];
  /** What the row's own command said went wrong, shown under the row until the next key or press. */
  slip?: RowSlipData | null;
  onSlipDone?(): void;
}

/** What a row's own command said went wrong, said under the row (round 20). */
export interface RowSlipData {
  row: string;
  text: string;
  /** The row's name where the text says it: set in Iosevka, as data (taste.md). */
  name?: string;
}

/** How long after a row's command a message it causes is still that row's (a slow refusal from
 * roster serve included). */
export const ROW_SLIP_MS = 8000;

export interface OpenMenu {
  row: string;
  at: { x: number; y: number } | null;
}

/** A row's DOM id, for aria-activedescendant: any row id, made a valid id. */
export const rowDomId = (id: string) =>
  `sb-${Array.from(id, (c) => (/[\w-]/.test(c) ? c : `_${c.codePointAt(0)}_`)).join("")}`;

const hostsCount = (n: number) =>
  `${formatCount(n)} ${n === 1 ? "Host" : "Hosts"}`;

/** What a row says about itself, beyond its label: its state in words (never only a dot's colour),
 * its note, a badge, its address, its count. */
export function rowFacts(row: SidebarRow): string[] {
  const facts: string[] = [];
  // An ended or connecting Session's note already says it.
  if (
    row.dot &&
    !((row.dot === "ended" || row.dot === "connecting") && row.note)
  )
    facts.push(DOT_WORDS[row.dot]);
  if (row.note) facts.push(row.note);
  // An unreviewed Host's badge is what its dot already said.
  if (row.badge && row.dot !== "off") facts.push(row.badge);
  for (const t of row.tags ?? []) facts.push(tagName(t));
  if (row.hop) facts.push(hopWords(row.hop));
  if (row.detail) facts.push(row.detail);
  if (row.count !== undefined) facts.push(hostsCount(row.count));
  if (row.pending) facts.push("not Published yet");
  return facts;
}

/** A Plugin badge's name, for its tooltip and the row's accessible name: "recent-alerts: 2". */
const tagName = (t: { source: string; text: string }) =>
  `${t.source}: ${t.text}`;

/** The row's accessible name: "esxi-02, password login, 10.0.0.5". */
export const rowName = (row: SidebarRow) =>
  [row.label, ...rowFacts(row)].join(", ");

const SearchIcon = () => (
  <svg
    className="sb-icon"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    aria-hidden="true"
  >
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

function Actions({
  actions,
  run,
  leader = "",
}: {
  actions: readonly RowAction[];
  run: Run;
  leader?: string;
}) {
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
      <RowActionGlyph name={a.icon} />
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
  // A dashed arrow: what would change, not changed yet (a Mesh plan, ticket 91).
  plan: "M2 8h2.5M6.5 8H9M11 8h2.5M10.5 5l3 3-3 3",
  // A solid arrow into a bar: carry it out (a Mesh apply).
  apply: "M2 8h9M8 5l3 3-3 3M13.5 3.5v9",
  // An edge broken by a cross, as a cut edge is drawn in a graph (a Mesh cut).
  cut: "M1.5 8h3.5M11 8h3.5M6.5 5.5l3 5M9.5 5.5l-3 5",
  // Three nodes joined, as the toolbar's map: show it on a graph (Topology's section, T99).
  // An arrow coming round to start again: reconnect an ended Session (round 20).
  reconnect: "M12.75 8a4.75 4.75 0 11-1.4-3.36M12.5 2.5v2.75H9.75",
  map: "M3.75 9.75a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5zM12.25 9.75a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5zM8 2.25a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5zM5.5 11.5h5M4.7 10L7.1 5.6M11.3 10L8.9 5.6",
};

/** A row action's icon (a Sidebar row's, a table's action). */
export const RowActionGlyph = ({ name }: { name: RowAction["icon"] }) => (
  <svg
    viewBox="0 0 16 16"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    aria-hidden="true"
  >
    <path d={ICONS[name]} />
  </svg>
);

const Chevron = ({ folded }: { folded: boolean }) => (
  <svg
    className={`sb-chev${folded ? " folded" : ""}`}
    viewBox="0 0 10 10"
    width="10"
    height="10"
    aria-hidden="true"
  >
    <path
      d="M2.5 3.75L5 6.25l2.5-2.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
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
  <svg
    className="sb-icon"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    {ROW_ICONS[name]}
  </svg>
);

type Select = (id: string) => void;
type OpenRowMenu = (row: string, at: { x: number; y: number } | null) => void;

const Row = memo(function Row({
  row,
  cursor,
  selected,
  run,
  select,
  drag,
  openMenu,
}: {
  row: SidebarRow;
  cursor: boolean;
  selected: boolean;
  run: Run;
  select: Select;
  drag: Drag;
  openMenu: OpenRowMenu;
}) {
  const buttons = row.actions && !row.menu;
  const cls = `sb-row${row.raised ? " raised" : ""}${row.raised && row.live ? " live" : ""}${row.also ? " also" : ""}${cursor ? " cursor" : ""}${selected ? " selected" : ""}${buttons ? " has-actions" : ""}${row.pending ? " pending" : ""}${row.link ? ` link-${row.link}` : ""}`;
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
      onDragStart={
        row.drag !== undefined ? (e) => drag.start(row, e) : undefined
      }
      onDragOver={row.drop ? (e) => drag.over(e, row.drop) : undefined}
      onDrop={row.drop ? (e) => drag.drop(e, row.drop) : undefined}
      onContextMenu={
        row.menu || row.actions?.length
          ? (e) => {
              e.preventDefault();
              select(row.id);
              openMenu(row.id, { x: e.clientX, y: e.clientY });
            }
          : undefined
      }
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
        {row.dot && <StateDot dot={row.dot} lit={row.lit} />}
        {/* The name first: what follows it in here drops out whole (to a hidden second line)
            when there's no room, and the name is cut only when it alone is too long. */}
        {/* Hovering the text shows the whole name (it may be cut off), then the row's tooltip. */}
        <span
          className="sb-text"
          title={row.title ? `${row.label}\n${row.title}` : row.label}
        >
          {/* A note ("ended (code 0)") stays beside the name like the " (2)" tail: when the name
              is cut, the label gives way, never the state. */}
          <span className="sb-name">
            <span className="sb-label" dir="auto">
              {cut
                ? row.label.slice(0, -(row.tail as string).length)
                : row.label}
            </span>
            {cut && <span className="sb-tail">{row.tail}</span>}
            {row.note && (
              // Cut first in Sessions (round 16), so it carries itself whole.
              <span className="sb-note" title={row.note}>
                {" "}
                {row.note}
              </span>
            )}
            {row.pending && (
              <span
                className="sb-pending-dot"
                aria-hidden="true"
                title="Not Published yet"
              />
            )}
            {row.tags?.map((t) => (
              <span key={t.source} className="sb-tag" title={tagName(t)}>
                {t.text}
              </span>
            ))}
            {row.hop && <HopCrumb hop={row.hop} />}
          </span>
          {row.badge && <span className="sb-badge"> {row.badge}</span>}
          {row.detail && <span className="sb-detail"> {row.detail}</span>}
        </span>
        {row.count !== undefined && (
          <span className="sb-num">{formatCount(row.count)}</span>
        )}
        {row.index !== undefined && (
          // A key, drawn as one (owner, after round 10: bare digits read as data).
          <span className="sb-index key-hint" aria-hidden="true">
            <Keys keys={String(row.index)} />
          </span>
        )}
      </div>
      {buttons && row.actions && <Actions actions={row.actions} run={run} />}
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
  openMenu,
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
  openMenu: OpenRowMenu;
  leader: string;
}) {
  const id = headingId(section.id);
  const folded = section.folded ?? false;
  const emptyShown =
    !folded && section.rows.length === 0 && section.empty !== undefined;
  return (
    <section
      role="group"
      className="sb-section"
      data-section={section.id}
      aria-label={section.title}
      onDragOver={section.drop ? (e) => drag.over(e, section.drop) : undefined}
      onDrop={section.drop ? (e) => drag.drop(e, section.drop) : undefined}
    >
      <div
        className={`sb-heading${cursor === id ? " cursor" : ""}${selected === id ? " selected" : ""}`}
        data-row={id}
        role="none"
      >
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
          {/* An empty section shows no "0": its sentence, or the pane, says it. */}
          {section.count !== undefined &&
            !(section.count === 0 && section.rows.length === 0) && (
              <span className="sb-count">{formatCount(section.count)}</span>
            )}
        </div>
        {section.actions && (
          <Actions actions={section.actions} run={run} leader={leader} />
        )}
      </div>
      {emptyShown && (
        <p className="sb-empty" id={`${rowDomId(id)}-empty`}>
          <WithKeys text={section.empty ?? ""} leader={leader} />
          {/* Slot 1 has its key like the slots under it (round 16). */}
          {section.id === "sessions" && (
            <span className="sb-slot-key key-hint" aria-hidden="true">
              <Keys keys="1" />
            </span>
          )}
        </p>
      )}
      {!folded && (
        <ul className="sb-rows" role="none">
          {section.rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              cursor={row.id === cursor}
              selected={row.id === selected}
              run={run}
              select={select}
              drag={drag}
              openMenu={openMenu}
            />
          ))}
          {/* Sessions' reserved room (Q224) as faint numbered slots, so it reads as "Sessions go
              here", never as a gap (owner, after round 14). "None open" is the first when empty.
              No node in a slot (round 16: a dashed node means "unreviewed"): a faint well and the
              key ␣ N will go to. */}
          {section.id === "sessions" &&
            Array.from(
              {
                length: Math.max(
                  0,
                  SESSION_ROOM - Math.max(section.rows.length, 1),
                ),
              },
              (_, i) => {
                const n = Math.max(section.rows.length, 1) + i + 1;
                return (
                  <li
                    key={`slot-${n}`}
                    className="sb-slot"
                    aria-hidden="true"
                    role="none"
                  >
                    <span className="sb-slot-key key-hint">
                      <Keys keys={String(n)} />
                    </span>
                  </li>
                );
              },
            )}
        </ul>
      )}
    </section>
  );
});

/** The cursor row, whole (M6): a cut-off name, its state and address, readable from the keyboard.
 * It repeats what the tree item's name already tells assistive tech, so it's hidden from it. */
/** How many rows of room the Sessions section keeps from the start (Q224). */
const SESSION_ROOM = 3;

/** Holds a full Sessions section (at its row cap) at its height while the pointer is on the tree
 * under it (`on`), so a Session opening there never moves the tree (Q216, Q222). A new Session scrolls into view inside the
 * held list (never fewer than one row: an empty section keeps a row of room, Q218); the section
 * takes its new height when the pointer leaves. */
function holdSessions(section: HTMLElement | null | undefined, on: boolean) {
  if (!section) return;
  if (!on) {
    section.classList.remove("held");
    section.style.removeProperty("--held-h");
    section.style.removeProperty("--held-rows");
    return;
  }
  if (section.classList.contains("held")) return;
  // Held once its reserved three rows are full, so a fourth Session scrolls into view inside them
  // rather than moving the tree (owner, after round 13).
  const list = section.querySelector<HTMLElement>(":scope > .sb-rows");
  if (!list || list.querySelectorAll(":scope > .sb-row").length < 3) return;
  // The room under the heading (a row list, or the one-row "None open"), which the held list keeps.
  const heading = section.querySelector<HTMLElement>(":scope > .sb-heading");
  const room =
    section.getBoundingClientRect().bottom -
    (heading?.getBoundingClientRect().bottom ??
      section.getBoundingClientRect().top);
  section.style.setProperty("--held-h", `${section.offsetHeight}px`);
  section.style.setProperty(
    "--held-rows",
    `${Math.max(0, Math.round(room))}px`,
  );
  section.classList.add("held");
}

/** Marks a scrolling list with whether rows are hidden above or below (data-more). */
function markOverflow(list: HTMLElement) {
  const above = list.scrollTop > 0;
  const below = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
  const more = above && below ? "both" : above ? "above" : below ? "below" : "";
  if (more) list.dataset.more = more;
  else delete list.dataset.more;
  // The Sessions list says on its heading how many are scrolled out of sight above (round 10: a
  // held list showing only the newest read as if the others had closed).
  const count = list.parentElement?.querySelector<HTMLElement>(
    ":scope > .sb-heading .sb-count",
  );
  if (!count || !list.matches('[data-section="sessions"] > .sb-rows')) return;
  const row = list.querySelector<HTMLElement>(".sb-row")?.offsetHeight || 1;
  const hidden = Math.round(list.scrollTop / row);
  if (hidden > 0) count.dataset.above = String(hidden);
  else delete count.dataset.above;
}

/** An IPv4 or IPv6 address, or a range (10.0.0.0/24). */
const DATA_FACT = /^[0-9a-f:.]+(\/\d+)?$/i;

function Details({ row }: { row: SidebarRow }) {
  const facts = rowFacts(row);
  // An unreviewed Host's tooltip says what its node already said ("can't be opened").
  const title =
    row.title && row.dot !== "off" && !facts.includes(row.title)
      ? row.title
      : undefined;
  return (
    <div
      className="sb-details"
      data-testid="sidebar-details"
      aria-hidden="true"
    >
      <p className={`sb-details-name${row.dot ? " data" : ""}`} dir="auto">
        {row.label}
      </p>
      {(facts.length > 0 || title) && (
        <p className="sb-details-facts">
          {[...facts, ...(title ? [title] : [])].map((f, i) => (
            // Each fact keeps its separator: a line never ends on "·" (or breaks inside an address).
            <span key={i} className="sb-fact">
              {i > 0 && "· "}
              {/* An address or a range is data (Iosevka); the rest is the app talking. */}
              {DATA_FACT.test(f) ? <span className="data">{f}</span> : f}
            </span>
          ))}
        </p>
      )}
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
  menu = null,
  onMenu,
  rowMenu,
  slip = null,
  onSlipDone,
}: SidebarProps) {
  // A stable `run` and `select` for the memoized rows; they always call the latest one.
  const runRef = useRef(run);
  const selectRef = useRef(onSelect);
  const menuRef = useRef(onMenu);
  useLayoutEffect(() => {
    runRef.current = run;
    selectRef.current = onSelect;
    menuRef.current = onMenu;
  });
  const stableRun = useCallback(
    (line: CommandLine) => runRef.current(line),
    [],
  );
  const stableSelect = useCallback((id: string) => selectRef.current?.(id), []);
  const openMenu = useCallback<OpenRowMenu>(
    (row, at) => menuRef.current?.({ row, at }),
    [],
  );
  const closeMenu = useCallback(() => menuRef.current?.(null), []);

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
    const el = scrollRef.current?.querySelector(
      `[data-row="${CSS.escape(cursor)}"]`,
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  // The live Session's row stays in view inside the capped Sessions list (its own scroller only:
  // the Sidebar itself doesn't jump to it). Instant, as every keyboard move is.
  const liveRow = allRows(sections).find((r) => r.live)?.id ?? null;
  useLayoutEffect(() => {
    if (liveRow === null) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(
      `[data-row="${CSS.escape(liveRow)}"]`,
    );
    const list = row?.closest<HTMLElement>(".sb-section > .sb-rows");
    if (!row || !list || list.scrollHeight <= list.clientHeight) return;
    const top = row.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = top + row.offsetHeight - list.clientHeight;
  }, [liveRow]);

  const restRef = useRef<HTMLDivElement | null>(null);

  // The capped Sessions list says when more are out of sight: a hairline on that edge (Q213).
  // The tree under them does the same at its top edge, so a scrolled tree reads as scrolled.
  useLayoutEffect(() => {
    const lists = [
      scrollRef.current?.querySelector<HTMLElement>(
        '[data-section="sessions"] > .sb-rows',
      ),
      restRef.current,
    ].filter((el): el is HTMLElement => el != null);
    const marks = lists.map((list) => {
      const mark = () => {
        markOverflow(list);
      };
      mark();
      list.addEventListener("scroll", mark, { passive: true });
      return [list, mark] as const;
    });
    return () =>
      marks.forEach(([list, mark]) => list.removeEventListener("scroll", mark));
  });

  // While the pointer is on the tree, the Sessions above it keep their height (Q216).
  const sessionsSection = () =>
    scrollRef.current?.querySelector<HTMLElement>('[data-section="sessions"]');
  // Whether the pointer is on the tree: a Session opened from it is held as soon as the reserved
  // rows fill, not only when the pointer next enters.
  const pointerOnTree = useRef(false);
  useLayoutEffect(() => {
    if (pointerOnTree.current) holdSessions(sessionsSection(), true);
  });

  // The dragged row lives here; its Host also goes on the dataTransfer as text (WebView2 needs
  // some data for a drag to start).
  const dragged = useRef<SidebarRow | null>(null);
  const focusBefore = useRef<Element | null>(null);
  const pressing = useRef(false);
  const cursorRow =
    cursor === null
      ? null
      : (allRows(sections).find((r) => r.id === cursor) ?? null);
  // The open menu's row on screen, for a menu opened by a key to go under it.
  const menuAt = menu?.row ?? null;
  const menuAnchor = useCallback(
    () =>
      menuAt === null
        ? null
        : (scrollRef.current?.querySelector(
            `[data-row="${CSS.escape(menuAt)}"]`,
          ) ?? null),
    [menuAt],
  );
  // The open menu's row: gone (removed, folded away), the menu goes with it.
  const menuRow =
    menu === null
      ? null
      : (allRows(sections).find(
          (r) => r.id === menu.row && (r.menu || r.actions?.length),
        ) ?? null);
  const menuEntries = menuRow && rowMenu ? rowMenu(menuRow) : [];
  const menuShown = menuRow !== null && menuEntries.length > 0;
  useLayoutEffect(() => {
    if (menu !== null && !menuShown) menuRef.current?.(null);
  }, [menu, menuShown]);

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
      if (
        el instanceof HTMLElement &&
        el.isConnected &&
        (document.activeElement === document.body || !document.activeElement)
      )
        el.focus();
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

  const lifted = sections[0]?.id === "sessions" ? 1 : 0;
  const renderSection = (section: SidebarSection) => (
    <Section
      key={section.id}
      section={section}
      cursor={cursor !== null && cursorIn(section, cursor) ? cursor : null}
      selected={
        selected !== null && cursorIn(section, selected) ? selected : null
      }
      run={stableRun}
      select={stableSelect}
      drag={drag}
      openMenu={openMenu}
      leader={leaderHint}
    />
  );

  // Nine or more Sessions: the tree's other live rows keep their colour but drop the edge stub, so
  // stubs stay a signal, not a texture (owner, after round 9; styles.css).
  const manySessions =
    (sections.find((s) => s.id === "sessions")?.count ?? 0) >= 9;
  return (
    <nav
      className={`sidebar side-${side}`}
      aria-label="Sidebar"
      data-many-sessions={manySessions || undefined}
      // A row menu is open: its focused item is the cursor now (styles.css).
      data-menu={menuShown || undefined}
    >
      <button
        type="button"
        className="sb-find"
        onMouseDown={keepFocus}
        onClick={() => run("find")}
      >
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
          if (
            e.target !== e.currentTarget ||
            e.currentTarget.contains(e.relatedTarget)
          )
            return;
          // A press on a draggable row can't keep focus where it is (that would stop the drag), so the
          // tree takes it. That's a click, not Tab reaching the tree: entering App mode here put the
          // cursor on the top row and scrolled the Sidebar up to it. Focus goes straight back instead.
          const before = focusBefore.current;
          if (pressing.current && before !== null) {
            if (
              before instanceof HTMLElement &&
              before.isConnected &&
              before !== e.currentTarget
            )
              before.focus({ preventScroll: true });
            return;
          }
          onTreeFocus?.(e.relatedTarget);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget))
            onTreeBlur?.(e.relatedTarget);
        }}
        onContextMenu={(e) => {
          // The Menu key or Shift+F10 with the tree focused (App mode): the cursor row's menu. A
          // row's own handler took a right-click on it already.
          if (
            e.target !== e.currentTarget ||
            e.defaultPrevented ||
            e.button === 2
          )
            return;
          e.preventDefault();
          if (
            cursorRow &&
            (cursorRow.menu || cursorRow.actions?.length) &&
            menu?.row !== cursorRow.id
          )
            openMenu(cursorRow.id, null);
        }}
        onDragOver={(e) => drag.over(e, undefined)}
        onDrop={(e) => drag.drop(e, undefined)}
        onDragEnd={() => {
          dragged.current = null;
          drag.refocus();
        }}
      >
        {/* Sessions sit above the rest and never scroll away (its own list scrolls past eight);
            the sections under it scroll, and that scroller keeps the row under the pointer. */}
        {/* Only when Sessions come first (init.lua can order the sections otherwise). */}
        {sections.slice(0, lifted).map(renderSection)}
        <div
          className="sb-rest"
          ref={restRef}
          role="none"
          tabIndex={-1}
          onPointerEnter={() => {
            pointerOnTree.current = true;
            holdSessions(sessionsSection(), true);
          }}
          onPointerLeave={() => {
            pointerOnTree.current = false;
            holdSessions(sessionsSection(), false);
          }}
        >
          {sections.slice(lifted).map(renderSection)}
        </div>
      </div>
      {menuShown && menu && menuRow && (
        <RowMenu
          key={`${menu.row}:${menu.at ? `${menu.at.x},${menu.at.y}` : "keys"}`}
          label={menuRow.label}
          what={menuRow.host !== undefined ? "HOST" : menuRow.id.startsWith("group:") ? "GROUP" : "NAME"}
          entries={menuEntries}
          at={menu.at}
          anchor={menuAnchor}
          leader={leaderHint}
          run={stableRun}
          close={closeMenu}
        />
      )}
      {slip && !(menuShown && menu) && (
        <RowSlip key={`${slip.row}:${slip.text}`} slip={slip} done={onSlipDone} />
      )}
      {/* A heading says nothing the tree doesn't (round 16: a bare "Inventory" strip). */}
      {cursorRow && (cursorRow.dot || rowFacts(cursorRow).length > 0) && (
        <Details row={cursorRow} />
      )}
    </nav>
  );
}

/** What a row's own command said went wrong (round 20, H9): under the row, where you were looking
 * (it had gone to the foot of the pane, the width of the window away), in the message's words,
 * which say what happened and the one next step. It floats over the rows below, so the tree never
 * moves, and is gone at the next key, press or scroll; `:messages` keeps it. No motion: it answers
 * a click or a key at once, as the message line does. */
function RowSlip({ slip, done }: { slip: RowSlipData; done: (() => void) | undefined }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const doneRef = useRef(done);
  useLayoutEffect(() => {
    doneRef.current = done;
  });
  useLayoutEffect(() => {
    const el = ref.current;
    const row = document.querySelector(`.sidebar [data-row="${CSS.escape(slip.row)}"]`);
    if (!el || !row) return;
    const r = row.getBoundingClientRect();
    const h = el.offsetHeight;
    // Under the row's name (past its node), or above the row where the window ends first.
    const below = r.bottom + 2 + h <= window.innerHeight - 4;
    el.style.left = `${Math.round(r.left + 20)}px`;
    el.style.width = `${Math.max(160, Math.round(r.width - 24))}px`;
    el.style.top = `${Math.round(below ? r.bottom + 2 : r.top - 2 - h)}px`;
    el.dataset.side = below ? "below" : "above";
  }, [slip]);
  useEffect(() => {
    const end = (e: Event) => {
      if (e instanceof KeyboardEvent && ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      if (e.type !== "keydown" && e.target instanceof Node && ref.current?.contains(e.target)) return;
      doneRef.current?.();
    };
    // Added after the press or key that ran the row's command has finished.
    const t = window.setTimeout(() => {
      document.addEventListener("keydown", end, true);
      document.addEventListener("pointerdown", end, true);
      document.addEventListener("scroll", end, true);
      window.addEventListener("resize", end);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", end, true);
      document.removeEventListener("pointerdown", end, true);
      document.removeEventListener("scroll", end, true);
      window.removeEventListener("resize", end);
    };
  }, []);
  return (
    <div ref={ref} className="sb-slip" role="alert" data-row-slip={slip.row}>
      {slip.name && slip.text.includes(slip.name)
        ? slip.text.split(slip.name).map((part, i) => (
            <Fragment key={i}>
              {i > 0 && <code className="message-cmd">{slip.name}</code>}
              <MessageText text={part} files />
            </Fragment>
          ))
        : <MessageText text={slip.text} files />}
    </div>
  );
}

function cursorIn(section: SidebarSection, cursor: string): boolean {
  return (
    cursor === headingId(section.id) ||
    section.rows.some((r) => r.id === cursor)
  );
}

/** A section's heading as a cursor stop. */
function headingRow(section: SidebarSection): SidebarRow {
  const id = headingId(section.id);
  return {
    id,
    label: section.title,
    level: -1,
    foldable: true,
    folded: section.folded ?? false,
    command: `togglefold ${id}`,
    // Its buttons (the Inventory's +) are its menu too, so Shift+F10 works on every row with
    // actions (round 18). The heading draws them itself; a heading row is never drawn as a row.
    ...(section.actions?.length ? { actions: section.actions } : {}),
  };
}

/** Every cursor stop, top to bottom (the order j/k walk): each heading, then its shown rows. */
export function allRows(sections: readonly SidebarSection[]): SidebarRow[] {
  return sections.flatMap((s) => [headingRow(s), ...(s.folded ? [] : s.rows)]);
}

/** App mode's first stop: where the cursor was left, else the Session on screen, else the first
 * Host (round 18: it began on a section heading, FOLDERS with no Session open), else the top. */
export function firstStop(
  rows: readonly SidebarRow[],
  selected: string | null,
): string | null {
  return (
    (selected !== null && rows.some((r) => r.id === selected)
      ? selected
      : null) ??
    rows.find((r) => r.raised)?.id ??
    rows.find((r) => r.host !== undefined && r.dot !== undefined)?.id ??
    rows[0]?.id ??
    null
  );
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
    move === "top"
      ? 0
      : move === "bottom"
        ? last
        : i < 0
          ? 0
          : Math.max(0, Math.min(last, i + (move === "down" ? 1 : -1)));
  return rows[next]?.id ?? null;
}
