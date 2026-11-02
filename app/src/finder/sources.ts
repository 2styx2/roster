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
import { statusText } from "../session/Sessions";
import type { Dot, SidebarSection } from "../sidebar/Sidebar";
import { buildSections, hostDot, type SidebarContext, type SidebarSectionDef } from "../sidebar/sections";

export interface FinderItem {
  id: string;
  label: string;
  /** Where it sits ("Inventory › subnet-42"): faint, and matched like the label. */
  path?: string;
  /** Right-aligned and faint (an address, a status); matched too. */
  detail?: string;
  dot?: Dot;
  /** The Session on screen, or the one before it (the session bar's `*` and `-`). */
  mark?: "current" | "previous";
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
  /** What an empty list says before anything's typed (default "Nothing here yet."). */
  empty?: string;
  items(ctx: FinderContext): FinderItem[];
  /** The Finder opened on it: a source that fetches its items (a Plugin's function, ticket 79)
   * starts now and registers again with them. */
  open?(): void;
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
  items: ({ sessions, hostByName }) =>
    sessions.tabs.map((tab, i) => {
      const host = hostByName.get(tab.host);
      const ended = tab.status.state === "ended" || tab.status.state === "failed";
      const mark = tab.id === sessions.active ? "current" : tab.id === sessions.previous ? "previous" : undefined;
      return {
        id: `session-${tab.id}`,
        label: tab.label,
        detail: statusText(tab) || host?.ip || "",
        dot: ended ? "ended" : (tab.auth ?? (host ? hostDot(host) : "key")),
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

const notReviewed = (name: string) => `${name} isn't reviewed yet, so it can't be opened. Review it in roster first.`;

export const hostsFinder: FinderSourceDef = {
  id: "hosts",
  source: BUILTIN,
  title: "Find a Host",
  prompt: "Hosts",
  items: (ctx) => hostsFinder.search?.(ctx, "") ?? [],
  search: ({ hosts, recent }, query) =>
    searchHosts(hosts, query, recent).map(({ host }) => ({
      id: `host:${host.name}`,
      label: host.name,
      path: host.group,
      detail: host.ip,
      dot: hostDot(host),
      command: `open ${host.name}`,
      ...(host.reviewed ? {} : { disabled: notReviewed(host.name) }),
    })),
};

/** The Sidebar's sections now, nothing folded (a finder searches the whole tree). */
function unfolded(ctx: FinderContext): SidebarSection[] {
  return buildSections(ctx.sidebar, { ...ctx, folded: new Set() });
}

/** Every row of `sections` that's chosen rather than folded, with its path through the tree. */
function treeItems(sections: readonly SidebarSection[]): FinderItem[] {
  const out: FinderItem[] = [];
  for (const section of sections) {
    const labels = new Map(section.rows.map((r) => [r.id, r.label]));
    for (const row of section.rows) {
      if (row.foldable) continue;
      const path = [section.title];
      const chain: string[] = [];
      for (let p = row.parent; p && labels.has(p); p = section.rows.find((r) => r.id === p)?.parent) {
        chain.unshift(labels.get(p) as string);
      }
      out.push({
        id: row.id,
        label: row.label,
        path: [...path, ...chain].join(" › "),
        ...(row.detail ? { detail: row.detail } : {}),
        ...(row.dot ? { dot: row.dot } : {}),
        command: row.command,
        ...(row.badge === "unreviewed" && row.host ? { disabled: notReviewed(row.host) } : {}),
      });
    }
  }
  return out;
}

/** A finder over one Sidebar section's rows (a Plugin's section gets one the same way). */
export function sectionFinder(sectionId: string, title: string, prompt: string, source = BUILTIN): FinderSourceDef {
  return {
    id: sectionId,
    source,
    title,
    prompt,
    items: (ctx) => treeItems(unfolded(ctx).filter((s) => s.id === sectionId)),
  };
}

/** Sections that have a finder of their own and stay out of the tree finder. */
const OWN_FINDER = new Set(["sessions"]);

export const treeFinder: FinderSourceDef = {
  id: "tree",
  source: BUILTIN,
  title: "Find in the tree",
  prompt: "Tree",
  items: (ctx) => treeItems(unfolded(ctx).filter((s) => !OWN_FINDER.has(s.id))),
};

export function builtinFinderRegistry(): FinderRegistry {
  const registry = new Registry<FinderSourceDef>();
  for (const s of [sessionsFinder, hostsFinder, treeFinder, sectionFinder("inventory", "Find in the Inventory", "Inventory")]) {
    registry.register(s);
  }
  return registry;
}
