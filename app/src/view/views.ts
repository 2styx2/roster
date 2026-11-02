// Views and Host-details sections as registries (ticket 76, decisions Q81 and Q95). A view is a
// side panel or a full view of text, facts and a table; a details section is the same content in
// one Host's details. Plugins fill both through `roster.views` and `roster.details`; the app's
// own features can register here too. Neither holds markup: the app draws the content
// (ViewContent.tsx), in its own style.
//
// One view is open at a time (`ViewHost`): `:view ID`, a key bound to it, the `views` finder, or
// a Plugin's own action open it; Esc closes it and focus goes back where it was.
import type { CommandDef } from "../commands/table";
import { matching } from "../commands/table";
import type { FinderSourceDef } from "../finder/sources";
import type { Registries } from "../registries";
import { BUILTIN, Registry, type Entry } from "../registry";
import type { RowAction } from "../sidebar/Sidebar";
import type { Sort, TableColumn, TableRow } from "../ui/table";
import type { GraphData, GraphFilter, GraphNode, Reach } from "../graph/model";

export interface Fact {
  label: string;
  value: string;
  data?: true;
}

/** Something the selected row can do. */
export interface TableActionDef {
  label: string;
  key?: string;
  icon?: RowAction["icon"];
  /** Only on rows whose cells match: each key one of its values (table.ts actionApplies). */
  when?: Readonly<Record<string, readonly (string | number)[]>>;
  run(row: TableRow): void;
}

export interface TableModel {
  columns: readonly TableColumn[];
  rows: readonly TableRow[];
  /** The sort it starts with (the given order when null). */
  sort: Sort | null;
  empty?: string;
  /** Enter or a double click on a row. */
  open?(row: TableRow): void;
  actions: readonly TableActionDef[];
}

/** Something the selected node can do (ticket 77). */
export interface NodeActionDef {
  label: string;
  key?: string;
  icon?: RowAction["icon"];
  /** Only on nodes whose fields match: each key one of its values (model.ts nodeActionApplies). */
  when?: Readonly<Record<string, readonly (string | number)[]>>;
  run(node: GraphNode): void;
}

/** A graph (ticket 77): nodes, edges and clusters as plain data, and what a node does. */
export interface GraphModel {
  data: GraphData;
  /** How far "reaches" goes: every hop (the default) or one. */
  reach?: Reach;
  /** What it shows; the user changes it with `f` (a new one from the Plugin replaces theirs). */
  filter?: GraphFilter;
  /** Enter or a double click on a node. */
  open?(node: GraphNode): void;
  actions: readonly NodeActionDef[];
}

/** A button on a view's or section's heading (ticket 91): what the whole of it can do. */
export interface HeadActionDef {
  label: string;
  icon: RowAction["icon"];
  /** Runs it from anywhere in its view or section (#176). */
  key?: string;
  run(): void;
}

export interface Content {
  /** Buttons on its heading, at most 4. */
  actions?: readonly HeadActionDef[];
  text?: string;
  facts: readonly Fact[];
  table?: TableModel;
  /** A view's graph, in place of a table. */
  graph?: GraphModel;
}

export type ViewPlace = "panel" | "full";

export interface ViewDef extends Entry {
  title: string;
  place: ViewPlace;
  content: Content;
}

export type ViewRegistry = Registry<ViewDef>;

/** One Host's section from one source: its id is `section@host`. */
export interface DetailsSectionDef extends Entry {
  section: string;
  host: string;
  title: string;
  order: number;
  content: Content;
}

export type DetailsRegistry = Registry<DetailsSectionDef>;

export const detailsId = (section: string, host: string) => `${section}@${host}`;

/** The sections of `host`'s details, in order (then by id, so the order is the same each time). */
export function sectionsFor(entries: readonly DetailsSectionDef[], host: string): DetailsSectionDef[] {
  return entries.filter((e) => e.host === host).sort((a, b) => a.order - b.order || a.section.localeCompare(b.section));
}

export interface ViewSnapshot {
  /** The open view's id. */
  at: string | null;
  /** The node or row it opened at (`roster.views.open(id, { select })`), and which opening that
   * was: each such opening counts, so asking again while it's open selects again. */
  select?: { id: string; n: number };
}

/** Which view is open. */
export class ViewHost {
  private snap: ViewSnapshot = { at: null };
  private openings = 0;
  private readonly listeners = new Set<() => void>();

  snapshot = (): ViewSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Opens view `id`; with `select`, at that node or row, even when it's already open. */
  open(id: string, select?: string) {
    if (select === undefined && this.snap.at === id) return;
    this.set(id, select);
  }

  /** Closes the open view; with `id`, only if it's that one. */
  close(id?: string) {
    if (this.snap.at === null || (id !== undefined && this.snap.at !== id)) return;
    this.set(null);
  }

  private set(at: string | null, select?: string) {
    this.snap = select === undefined ? { at } : { at, select: { id: select, n: ++this.openings } };
    for (const l of this.listeners) l();
  }
}

/** `:view ID` opens a view; `:view` alone lists them (the `views` finder). */
export function viewCommand(views: ViewRegistry, host: ViewHost): CommandDef {
  return {
    id: "view",
    source: BUILTIN,
    area: "Views",
    arg: "text",
    optionalArg: true,
    label: (a) => (a ? `Open the view ${views.get(a)?.title ?? a}` : "Open a view (a Plugin's panel or full view)"),
    doc: "Opens a view a Plugin added ([plugins](plugins)): a side panel or a full view. `Esc` closes it and puts you back where you were. With no name, the `views` finder lists them.",
    complete: (arg) => matching(views.list().map((v) => v.id), arg),
    run: (ctx, arg) => {
      const id = (arg ?? "").trim();
      if (!id) return ctx.openFinder("views");
      if (!views.get(id)) return ctx.say(`There's no view ${id}: :view lists them`);
      host.open(id);
    },
  };
}

/** The `views` finder: every view, with where it's from. */
export function viewsFinder(views: ViewRegistry): FinderSourceDef {
  return {
    id: "views",
    source: BUILTIN,
    title: "Open a view",
    prompt: "Views ›",
    empty: "No views yet: Plugins add them.",
    items: () =>
      views
        .list()
        .map((v) => ({ id: v.id, label: v.title, detail: v.source, path: v.place === "full" ? "full view" : "panel", command: `view ${v.id}` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export function registerViews(registries: Registries, host: ViewHost): () => void {
  const disposers = [registries.commands.register(viewCommand(registries.views, host)), registries.finders.register(viewsFinder(registries.views))];
  // A view taken away (removed, its Plugin unloaded) closes.
  disposers.push(
    registries.views.subscribe(() => {
      const at = host.snapshot().at;
      if (at !== null && !registries.views.get(at)) host.close();
    }),
  );
  return () => disposers.forEach((d) => d());
}
