// Finder sources (GLOSSARY: Plugin lists them among the registries; ADR 0006): what the Finder
// overlay can search. Each source is a registry entry that lists items from what the app knows
// right now; an item is a label and the command line Enter runs, so choosing in a finder is the
// same as typing that command (decision Q36: a mode only changes how commands are shown).
//
// Built-in: `sessions` (␣ b, Telescope's buffer list), `hosts` (the Picker's matcher), `inventory`
// and `tree` (every row the Sidebar's other sections offer, so Focus reaches all of it through
// `␣ e`). Folders registers `folders` from outside, as a Plugin would.
import { searchHosts } from "../picker/match";
import { searchItems } from "./search";
import { BUILTIN, Registry, type Entry } from "../registry";
import type { CommandLine } from "../keymap";
import { connectPhase, isLive, statusText } from "../session/status";
import type { Light } from "../ui/dot";
import type { Dot, SidebarSection } from "../sidebar/model";
import { buildSections, hostDot, type SidebarContext, type SidebarSectionDef } from "../sidebar/sections";

export interface FinderItem {
  id: string;
  label: string;
  /** The label is a name you'd type (a help tag such as `E31` or `theme`): Iosevka even in a
   * prose finder (taste.md's paste rule). */
  dataLabel?: boolean;
  /** Where it sits ("Inventory › subnet-42", a help topic's page): faint, and matched like the label. */
  path?: string;
  /** What it is, after its title and muted ("E31 · Pick Bitwarden cloud…"): a help entry's first
   * line (round 20: it had taken the middle column, which is the page on every other row). */
  note?: string;
  /** What in `note` is code (`roster sync`): Iosevka in a prose finder. */
  noteData?: readonly string[];
  /** Right-aligned and faint (an address, a status); matched too. On a Host's row it's the address,
   * which comes right after the name, as in the Picker. */
  detail?: string;
  /** A Host's type ("switch"), after its group, as in the Picker. */
  type?: string;
  dot?: Dot;
  /** A Session that's connected: the one on screen in the accent, others in the text colour
   * (see SidebarRow.lit). */
  lit?: Light;
  /** `false`: a lit node without its edge stub (nine or more Sessions: only the on-screen Host
   * keeps it, the Sidebar's and the Picker's rule, Q229 a, Q245). */
  stub?: false;
  /** The Session on screen, or the one before it (the session bar's `*` and `-`). */
  mark?: "current" | "previous";
  /** The Host the row stands for (the tree's Host rows). */
  host?: string;
  /** The group it's listed under, as a quiet heading over its first row (help's pages under the
   * index's "Getting started", "Reference"…, round 21). Rows of one group are listed together. */
  group?: string;
  /** What Enter or a click runs. */
  command: CommandLine;
  /** Listed, but Enter only says this (an unreviewed Host). */
  disabled?: string;
}

/** What a source lists from: the Sidebar's context, plus the Sidebar's sections and recent Hosts. */
export interface FinderContext extends SidebarContext {
  /** Host names, most recently used first. */
  recent: readonly string[];
  /** The Sidebar section registry's entries, for sources built from the tree. */
  sidebar: readonly SidebarSectionDef[];
}

export interface FinderSourceDef extends Entry {
  /** What the finder is for ("Find a Session"): the `finder` command's label and the dialog's name. */
  title: string;
  /** Before the query, as in the prototype ("Sessions ›"). */
  prompt: string;
  /** Its items are prose (help's outline, `:helpgrep`): they read in Inter, not Iosevka. */
  prose?: boolean;
  /** What its items are, for the footer's count before a query ("topic": "1,360 topics"), or a
   * function that names them from the list (the tree's "Host" when every row is one). Without it
   * the count always says "results". */
  noun?: string | ((items: readonly FinderItem[]) => string);
  /** What an empty list says before anything's typed (default "Nothing here yet."). */
  empty?: string;
  items(ctx: FinderContext): FinderItem[];
  /** The Finder opened on it: a source that fetches its items (a Plugin's function, ticket 79)
   * starts now and registers again with them. */
  open?(): void;
  /** Its items or matches changed without it registering again (`:helpgrep` once the guides'
   * text has loaded, T213): the Finder asks again. */
  subscribe?(listener: () => void): () => void;
  /** The matches for `query`, best first; by default searchItems over `items`. */
  search?(ctx: FinderContext, query: string): FinderItem[];
  /** The item selected on opening, in the empty query's list (default the first). */
  initial?(items: readonly FinderItem[]): number;
  /** The selected item changed (a live preview, as the `themes` finder does); undefined when
   * nothing matches. */
  move?(item: FinderItem | undefined): void;
  /** The Finder closed, chosen or not (after Enter's command has run): undo a preview. */
  close?(): void;
  /** A line for the footer while the Finder is open ("set in init.lua"), for the item under
   * the cursor (undefined when nothing matches). */
  note?(item: FinderItem | undefined): string | undefined;
  /** The help topic for an item (F1, `picker.help`): `themes#nord`. Without it, the topic is the
   * command Enter would run (`:session`), or a `help TOPIC` command's topic. */
  help?(item: FinderItem): string | undefined;
}

export type FinderRegistry = Registry<FinderSourceDef>;

export { searchItems };

export interface FinderResults {
  items: FinderItem[];
  /** Index of the item to select. */
  selected: number;
}

export function finderResults(source: FinderSourceDef, ctx: FinderContext, query: string): FinderResults {
  if (query.trim() === "") {
    const items = source.items(ctx);
    return { items, selected: Math.max(0, Math.min(source.initial?.(items) ?? 0, items.length - 1)) };
  }
  const items = source.search ? source.search(ctx, query) : searchItems(source.items(ctx), query);
  return { items, selected: 0 };
}

export const sessionsFinder: FinderSourceDef = {
  id: "sessions",
  source: BUILTIN,
  title: "Find a Session",
  prompt: "Sessions",
  noun: "Session",
  items: ({ sessions, hostByName }) =>
    sessions.tabs.map((tab, i) => {
      const host = hostByName.get(tab.host);
      const ended = !isLive(tab.status);
      const mark = tab.id === sessions.active ? "current" : tab.id === sessions.previous ? "previous" : undefined;
      return {
        id: `session-${tab.id}`,
        label: tab.label,
        detail: statusText(tab) || host?.ip || "",
        dot: ended ? "ended" : connectPhase(tab) ? "connecting" : (tab.auth ?? (host ? hostDot(host) : "key")),
        ...(ended || connectPhase(tab) ? {} : { lit: tab.id === sessions.active ? ("current" as const) : ("live" as const) }),
        ...(mark ? { mark } : {}),
        command: `session ${i + 1}`,
      } satisfies FinderItem;
    }),
  // Telescope's buffer list: Enter on the first row goes back to where you were.
  initial: (items) => {
    const previous = items.findIndex((i) => i.mark === "previous");
    return previous >= 0 ? previous : Math.max(0, items.findIndex((i) => i.mark === "current"));
  },
};

const notReviewed = (name: string) => `${name} isn't reviewed yet, so it can't be opened. Add reviewed: true to it in roster.yml (:help adding-hosts).`;

export const hostsFinder: FinderSourceDef = {
  id: "hosts",
  source: BUILTIN,
  title: "Find a Host",
  prompt: "Hosts",
  noun: "Host",
  items: (ctx) => hostsFinder.search?.(ctx, "") ?? [],
  search: ({ hosts, recent }, query) =>
    searchHosts(hosts, query, recent).map(({ host }) => ({
      id: `host:${host.name}`,
      label: host.name,
      path: host.group,
      detail: host.ip,
      ...(host.type ? { type: host.type } : {}),
      host: host.name,
      dot: hostDot(host),
      command: `open ${host.name}`,
      ...(host.reviewed ? {} : { disabled: notReviewed(host.name) }),
    })),
};

/** The Sidebar's sections now, nothing folded (a finder searches the whole tree). */
function unfolded(ctx: FinderContext): SidebarSection[] {
  return buildSections(ctx.sidebar, { ...ctx, folded: new Set() });
}

/** Every row of `sections` that's chosen rather than folded, with its path through the tree. The
 * path names its section only when rows come from more than one ("Folders › Lab" beside
 * "Inventory › subnet-42"); with one, "Inventory ›" on every row says nothing (round 18). */
function treeItems(ctx: FinderContext, sections: readonly SidebarSection[]): FinderItem[] {
  // A Host's node as the Sidebar and the Picker draw it (round 20: the on-screen Host was a muted
  // dot here): the rows come lit from buildSections; with nine or more Sessions only the
  // on-screen Host keeps its edge stub.
  const many = ctx.sessions.tabs.length >= 9;
  const typeOf = (host: string | undefined) => (host ? ctx.hostByName.get(host)?.type : undefined);
  const out: FinderItem[] = [];
  const chosen = (s: SidebarSection) => s.rows.some((r) => !r.foldable);
  const named = sections.filter(chosen).length > 1;
  for (const section of sections) {
    const labels = new Map(section.rows.map((r) => [r.id, r.label]));
    for (const row of section.rows) {
      if (row.foldable) continue;
      const path = named ? [section.title] : [];
      const chain: string[] = [];
      for (let p = row.parent; p && labels.has(p); p = section.rows.find((r) => r.id === p)?.parent) {
        chain.unshift(labels.get(p) as string);
      }
      out.push({
        id: row.id,
        label: row.label,
        ...(path.length + chain.length ? { path: [...path, ...chain].join(" › ") } : {}),
        ...(row.detail ? { detail: row.detail } : {}),
        ...(row.dot ? { dot: row.dot } : {}),
        ...(row.dot && row.lit ? { lit: row.lit } : {}),
        ...(row.dot && row.lit === "live" && many ? { stub: false as const } : {}),
        ...(row.host ? { host: row.host } : {}),
        ...(typeOf(row.host) ? { type: typeOf(row.host) as string } : {}),
        command: row.command,
        ...(row.badge === "unreviewed" && row.host ? { disabled: notReviewed(row.host) } : {}),
      });
    }
  }
  return out;
}

/** The tree's rows are Hosts when every one is (round 19: "300 rows" beside the Picker's
 * "300 Hosts"), else rows. */
const rowNoun = (items: readonly FinderItem[]): string => (items.length > 0 && items.every((i) => i.host) ? "Host" : "row");

/** A finder over one Sidebar section's rows (a Plugin's section gets one the same way). */
export function sectionFinder(sectionId: string, title: string, prompt: string, source = BUILTIN, noun: FinderSourceDef["noun"] = rowNoun): FinderSourceDef {
  return {
    id: sectionId,
    source,
    title,
    prompt,
    noun,
    items: (ctx) => treeItems(ctx, unfolded(ctx).filter((s) => s.id === sectionId)),
  };
}

/** Sections that have a finder of their own and stay out of the tree finder. */
const OWN_FINDER = new Set(["sessions"]);

export const treeFinder: FinderSourceDef = {
  id: "tree",
  source: BUILTIN,
  title: "Find in the tree",
  prompt: "Tree",
  noun: rowNoun,
  items: (ctx) => treeItems(ctx, unfolded(ctx).filter((s) => !OWN_FINDER.has(s.id))),
};

export function builtinFinderRegistry(): FinderRegistry {
  const registry = new Registry<FinderSourceDef>();
  for (const s of [sessionsFinder, hostsFinder, treeFinder, sectionFinder("inventory", "Find in the Inventory", "Inventory", BUILTIN, "Host")]) {
    registry.register(s);
  }
  return registry;
}
