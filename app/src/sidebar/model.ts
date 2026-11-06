// The Sidebar's model, apart from how it's drawn (Sidebar.tsx): its rows and sections, what a row
// says about itself in words, the cursor's stops and moves, and what folding a row does.
import type { CommandLine } from "../keymap";
import { hopWords, type Breadcrumb } from "../session/breadcrumb";
import type { ActionIcon } from "../ui/icons";
import { formatCount } from "../ui/format";
import { DOT_WORDS, type Dot, type Light } from "../ui/dot";

export type { Dot } from "../ui/dot";

/** A small button on a row or heading (close, rename, delete, new). */
export interface RowAction {
  /** The accessible name, e.g. "Close esxi-02". */
  label: string;
  icon: ActionIcon;
  command: CommandLine;
  /** Always shown, not only on the selected row (the Inventory's "Add a Host"). */
  pinned?: boolean;
  /** The tooltip, when it should say more than the label (why it can't act). */
  title?: string;
  /** Its keys in keymap notation ("␣ +"), added to the tooltip while the hints are shown. */
  keys?: string;
  /** What it says in the row's menu, which is named after the row: short, without the row's own
   * names ("Close", "Rename…"); `label` then goes to the item's tooltip (round 22: "Remove esx-02
   * from Lab" was cut to "Remove …"). `label` if left out. */
  short?: string;
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
   * node is muted, whatever its shape (taste.md: the accent means live, decision Q215). */
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
  /** A Session's number, the one `␣ 1`–`9` jumps to: right-aligned and faint, a key hint (Q226). */
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
  if (row.hop) facts.push(hopWords(row.hop));
  if (row.detail) facts.push(row.detail);
  if (row.count !== undefined) facts.push(hostsCount(row.count));
  if (row.pending) facts.push("not Published yet");
  return facts;
}

/** A Plugin badge's name, for its tooltip and the row's accessible name: "recent-alerts: 2". */
export const tagName = (t: { source: string; text: string }) => `${t.source}: ${t.text}`;

/** The row's accessible name: "esxi-02, password login, 10.0.0.5". */
export const rowName = (row: SidebarRow) => [row.label, ...rowFacts(row)].join(", ");

/** The id of a section's heading, as a cursor stop and a fold key. */
export const headingId = (section: string) => `section:${section}`;

export function cursorIn(section: SidebarSection, cursor: string): boolean {
  return cursor === headingId(section.id) || section.rows.some((r) => r.id === cursor);
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
export function firstStop(rows: readonly SidebarRow[], selected: string | null): string | null {
  return (
    (selected !== null && rows.some((r) => r.id === selected) ? selected : null) ??
    rows.find((r) => r.raised)?.id ??
    rows.find((r) => r.host !== undefined && r.dot !== undefined)?.id ??
    rows[0]?.id ??
    null
  );
}

/** Where j, k, gg and G take the cursor. */
export type ListMoveTo = "down" | "up" | "top" | "bottom";

/** The cursor after a list action; it stays put at either end. */
export function moveCursor(rows: readonly SidebarRow[], cursor: string | null, move: ListMoveTo): string | null {
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

/** h folds (or goes to the parent), l unfolds (or goes to the first child), toggle flips. */
export type FoldHow = "fold" | "unfold" | "toggle";

/** What h, l or a chevron does: fold or unfold a row (and where the cursor goes, so it never
 * vanishes into a folded row), or move to its parent or first child. `id` is the row named
 * (null: the cursor's); nothing to do is null. */
export type FoldStep = { fold: string; folded: boolean; moveTo?: string } | { moveTo: string } | null;

export function foldStep(
  rows: readonly SidebarRow[],
  folded: ReadonlySet<string>,
  cursor: string | null,
  id: string | null,
  how: FoldHow,
): FoldStep {
  const find = (x: string | undefined) => rows.find((r) => r.id === x);
  const row = (id === null ? find(cursor ?? undefined) : find(id)) ?? null;
  const target = id ?? row?.id;
  if (!target) return null;
  const isFolded = row ? row.folded === true : folded.has(target);
  const foldable = row ? row.foldable === true : true;
  if (foldable && (how === "toggle" || (how === "fold") !== isFolded)) {
    const next = how === "toggle" ? !isFolded : how === "fold";
    const ancestors: string[] = [];
    for (let r = cursor === null ? undefined : find(cursor); r?.parent; r = find(r.parent)) ancestors.push(r.parent);
    return { fold: target, folded: next, ...(next && ancestors.includes(target) ? { moveTo: target } : {}) };
  }
  if (id !== null || !row) return null;
  if (how === "fold" && row.parent) return { moveTo: row.parent };
  if (how === "unfold" && foldable) {
    const child = rows[rows.indexOf(row) + 1];
    if (child?.parent === row.id) return { moveTo: child.id };
  }
  return null;
}
