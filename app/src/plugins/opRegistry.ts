// Every op a Plugin sends (docs/plugins.md "Ops"), one entry per kind: how the app checks it
// (`parse`, with ops.ts's field checks) and what it does with it (`apply`, through the manager's
// `OpHost`). The kinds are the core's (`CORE.ops`, from roster-core's plugin::op): a kind the core
// sends without an entry here, or one here the core never sends, doesn't compile.
import type { CommandContext, CommandDef } from "../commands/table";
import { themeBase, themeOf } from "../config/apply";
import type { ThemeDef } from "../config/types";
import { sectionFinder, type FinderItem, type FinderSourceDef } from "../finder/sources";
import { mergeGraph, type GraphModel, type GraphNode } from "../graph/model";
import { HEALTH_LATER_MS, SECTION_WAIT_MS } from "../health/health";
import { parseMarkdown } from "../help/markdown";
import { bindingId, type KeymapContext } from "../keymap";
import type { Registries } from "../registries";
import { hostRow } from "../sidebar/sections";
import type { SidebarRow } from "../sidebar/model";
import { pluginTutorial } from "../tutor/plugin";
import { DEFAULT_TUTORIAL, TUTOR_EVENTS, tutorPage, type StepMatch } from "../tutor/tutor";
import { quiet as quietMessage } from "../ui/messages";
import { mergeRows, type TableRow } from "../ui/table";
import { detailsId, type Content } from "../view/views";
import type { Host, PluginCaller, PluginManifest } from "../backend/types";
import { CORE } from "./core.gen";
import { GraphInvalid, MAX_CLUSTERS, MAX_EDGES, MAX_NODES, parseGraph, parseGraphUpdate, type PluginGraph } from "./graphOps";
import {
  clearOf,
  columnsOf,
  content as parseContent,
  defined,
  facts,
  finderItems,
  headActions,
  healthChecks,
  Invalid,
  isObj,
  list,
  MAX_COPY,
  MAX_HEAD_ACTIONS,
  MAX_HELP,
  MAX_NOTICE_ACTIONS,
  MAX_TABLE_ROWS,
  MAX_TEXT,
  MAX_URL,
  MAX_VIEW_TEXT,
  num,
  optRun,
  optStr,
  parseFinderItems,
  PLUGIN_TOOLBAR_ICONS,
  REMOVABLE,
  row as parseRow,
  run as parseRun,
  str,
  tableActions,
  tableRows,
  webUrl,
  type Obj,
  type PluginConfirm,
  type PluginContent,
  type PluginFinderItem,
  type PluginFloat,
  type PluginFloatAction,
  type PluginLink,
  type PluginOp,
  type PluginProgress,
  type PluginRow,
  type PluginRowAction,
  type PluginToolbarControl,
  type PluginTutorLesson,
  type PluginTutorStep,
  type PluginView,
  type PluginViewUpdate,
  type Run,
} from "./ops";
import type { Shown } from "./shown";

/** What a Plugin's function is told about what ran it (api 3, `HandlerContext`). */
export type HandlerContext = Record<string, string | number | null>;

/** A Plugin running in the app, as the manager keeps it. */
export interface Loaded {
  manifest: PluginManifest;
  path: string;
  granted: string[];
  /** The events it listens for, as the core last said (#223: a reply's `listens`). */
  listens: Set<string>;
  /** What takes each piece it put up away again, by `KIND:ID`. */
  disposers: Map<string, () => void>;
  /** Its views as last set and updated, so an update changes some rows in place. */
  views?: Map<string, PluginView>;
}

/** What applying an op needs of the manager. */
export interface OpHost {
  readonly registries: Registries;
  readonly ui: {
    run(line: string): void;
    send(id: number, text: string): void;
    copy(text: string): Promise<void>;
    closeView?(id: string): void;
    openView?(id: string, select: string): void;
    showSession?(id: number, line: string | null): boolean;
    say?(message: import("../ui/messages").Message): void;
    openCommandLine?(text: string): void;
  };
  readonly shown: Shown;
  notify(plugin: string, level: "info" | "warn" | "error", text: string, actions?: readonly { label: string; command: string }[], asked?: boolean, background?: boolean): void;
  /** The command line that runs `run` for `plugin` (`plugins run …` or `plugins call …`). */
  line(plugin: string, run: Run, context?: HandlerContext): string;
  runFor(plugin: string, run: Run, context?: HandlerContext, user?: PluginCaller): void;
  runLine(plugin: string, line: string): void;
  call(plugin: string, handler: number, args: unknown, what: string | null, user: PluginCaller): Promise<unknown>;
  /** The Plugin running now by that name, if any. */
  current(plugin: string): Loaded | undefined;
  /** A `:check` section's `check`, called for its lines. */
  healthCheck(plugin: string, id: string, handler: number): Promise<{ section: string; level: "ok" | "warn" | "error"; message: string; fix?: string }[]>;
  /** The lines for a `:check` run whose `check` said "later" (decision Q112h). */
  answerCheck(plugin: string, check: number, checks: unknown): void;
  /** Runs Plugin command `name` for `plugin`, as the user's or the one its `roster.cmd` carried. */
  runCommand(plugin: string, name: string, run: (by: PluginCaller) => void): void;
  /** Runs `line` as made by `plugin`'s `roster.cmd`: its own command it names is `by`'s call. */
  runCmdLine(plugin: string, by: PluginCaller, line: string): void;
  /** A Plugin command's completions: the last list, kept to what still matches, while it asks again. */
  complete(plugin: string, command: string, handler: number, arg: string): string[];
  /** What a Plugin's command hears of the Sidebar (api 3). */
  cursor(plugin: string, ctx: CommandContext): HandlerContext;
}

/** One op of one reply being applied. */
export interface OpCall {
  host: OpHost;
  plugin: string;
  loaded: Loaded;
  /** Nothing the user did asked for it: a quiet notice keeps a line that shows (decision Q162). */
  background: boolean;
  /** This reply's clipboard writes so far: a notice after one waits for it (decision Q87). */
  copying: Promise<boolean> | null;
}

type OpKind = (typeof CORE.ops)[number]["op"];
type OpOf<K extends OpKind> = Extract<PluginOp, { op: K }>;

interface Entry<K extends OpKind> {
  /** The op, checked: a field of the wrong kind throws Invalid with the reason. `spec` and `id`
   * are the op's own when it has them (`{}` and `""` otherwise). */
  parse(raw: Obj, spec: Obj, id: string): OpOf<K>;
  apply(c: OpCall, op: OpOf<K>): void;
}

const KEY_CONTEXTS: Readonly<Record<(typeof CORE.key_contexts)[number], KeymapContext>> = { leader: "leader", list: "list", list_vim: "listVim" };
const keyContext = (name: string): KeymapContext | undefined => (Object.hasOwn(KEY_CONTEXTS, name) ? KEY_CONTEXTS[name as keyof typeof KEY_CONTEXTS] : undefined);
const LEVELS = ["info", "warn", "error"] as const;

const refuse = (c: OpCall, what: string) => c.host.notify(c.plugin, "warn", `${c.plugin}: ${what}`);

function put(c: OpCall, key: string, dispose: () => void) {
  c.loaded.disposers.get(key)?.();
  c.loaded.disposers.set(key, dispose);
}

function drop(c: OpCall, key: string) {
  c.loaded.disposers.get(key)?.();
  c.loaded.disposers.delete(key);
}

/** An id taken by another source (a built-in, init.lua, another Plugin) stays theirs. */
function taken(registry: { get(id: string): { source: string } | undefined }, id: string, plugin: string) {
  const e = registry.get(id);
  return e !== undefined && e.source !== plugin;
}

/** Up to three key sequences like `keys` (the same keys before its last) that nothing in
 * `context` binds, and that hide no binding nor are hidden by one: what to suggest instead. */
function freeKeys(bindings: readonly { context: string; keys: string; source: string; action: string | null }[], context: string, keys: string, plugin: string): string[] {
  const parts = keys.split(" ");
  const prefix = parts.slice(0, -1).join(" ");
  const bound = bindings.filter((b) => b.context === context && b.source !== plugin && b.action !== null).map((b) => b.keys);
  const clashes = (k: string) => bound.some((b) => b === k || b.startsWith(`${k} `) || k.startsWith(`${b} `));
  return [..."abcdefghijklmnopqrstuvwxyz"]
    .map((ch) => (prefix ? `${prefix} ${ch}` : ch))
    .filter((k) => !clashes(k))
    .slice(0, 3);
}

/** What a graph holds more of than it may, or null. */
function graphOver(g: { nodes: readonly unknown[]; edges: readonly unknown[]; clusters: readonly unknown[] }): string | null {
  if (g.nodes.length > MAX_NODES) return `${MAX_NODES.toLocaleString("en-US")} nodes`;
  if (g.edges.length > MAX_EDGES) return `${MAX_EDGES.toLocaleString("en-US")} edges`;
  if (g.clusters.length > MAX_CLUSTERS) return `${MAX_CLUSTERS.toLocaleString("en-US")} clusters`;
  return null;
}

const rowAction = (c: OpCall, a: PluginRowAction, context: HandlerContext) => ({ label: a.label, icon: a.icon, command: c.host.line(c.plugin, a.run, context) });

function sidebarRow(c: OpCall, section: string, row: PluginRow, hostByName: ReadonlyMap<string, Host>): SidebarRow {
  const { host: h, plugin } = c;
  const id = `${section}:${row.id}`;
  const context = { section, row: row.id };
  const own = row.actions.map((a, i) => rowAction(c, a, { ...context, action: i + 1 }));
  const extra = {
    ...(row.drop ? { drop: (host: string) => h.line(plugin, row.drop as Run, { ...context, dropped: host }) } : {}),
    ...(row.dragOut ? { dragOut: h.line(plugin, row.dragOut, context) } : {}),
    ...(row.host ? { drag: row.host } : {}),
    ...(row.icon ? { icon: row.icon } : {}),
  };
  // Drawn as the Inventory draws the Host (api 3); the row's own actions go in its menu after the
  // Host's (T166, Q156).
  const host = row.kind === "host" && row.host ? hostByName.get(row.host) : undefined;
  if (host) {
    const base = hostRow(host, id, row.level ?? 0);
    return { ...base, ...extra, ...(row.run ? { command: h.line(plugin, row.run, context) } : {}), actions: [...(base.actions ?? []), ...own] };
  }
  // A Host roster doesn't have: its own actions are in its menu too (T166, Q156).
  const dot = row.kind === "host" && row.host ? { dot: "off" as const, menu: true } : {};
  return {
    ...dot,
    ...extra,
    ...(row.fold ? { foldable: true } : {}),
    id,
    label: row.label,
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.note ? { note: row.note } : {}),
    ...(row.host ? { host: row.host } : {}),
    ...(row.badge ? { badge: row.badge } : {}),
    ...(row.count !== undefined ? { count: row.count } : {}),
    ...(row.level !== undefined ? { level: row.level } : {}),
    ...(row.title ? { title: row.title } : {}),
    command: row.run ? h.line(plugin, row.run, context) : row.fold ? `togglefold ${id}` : row.host ? `open ${row.host}` : "",
    actions: own,
  };
}

/** A view's or section's content, with what its table's rows and actions run. A function gets
 * the row: `{ row, host, view | section }`. */
function viewContent(c: OpCall, where: { view?: string; section?: string; host?: string }, content: PluginContent): Content {
  const { host: h, plugin } = c;
  const go = (run: Run) => (row: TableRow) => {
    const host = row.host ?? where.host;
    h.runFor(plugin, run, { row: row.id, ...(host ? { host } : {}), ...(where.view ? { view: where.view } : {}), ...(where.section ? { section: where.section } : {}) });
  };
  const t = content.table;
  // Without its own `open`, a row with a Host opens that Host, as a Sidebar row does.
  const openHost = (row: TableRow) => {
    if (row.host) h.ui.run(`open ${row.host}`);
  };
  // A heading's button gets the view or section (and its Host): `{ view }`, `{ section, host }`.
  const head = content.actions.map((a) => ({ label: a.label, icon: a.icon, ...(a.key ? { key: a.key } : {}), run: () => h.runFor(plugin, a.run, { ...where }) }));
  return {
    ...(head.length ? { actions: head } : {}),
    ...(content.text ? { text: content.text } : {}),
    facts: content.facts,
    ...(t
      ? {
          table: {
            columns: t.columns,
            rows: t.rows,
            sort: t.sort,
            ...(t.empty ? { empty: t.empty } : {}),
            ...(t.open ? { open: go(t.open) } : t.rows.some((row) => row.host) ? { open: openHost } : {}),
            actions: t.actions.map((a) => ({
              label: a.label,
              ...(a.key ? { key: a.key } : {}),
              ...(a.icon ? { icon: a.icon } : {}),
              ...(a.when ? { when: a.when } : {}),
              run: go(a.run),
            })),
          },
        }
      : {}),
  };
}

/** A view's graph, with what its `open` and actions run. A function gets the node:
 * `{ node, host, view }`. */
function viewGraph(c: OpCall, view: string, g: PluginGraph): GraphModel {
  const { host: h, plugin } = c;
  const go = (run: Run) => (node: GraphNode) => h.runFor(plugin, run, { node: node.id, ...(node.host ? { host: node.host } : {}), view });
  // Without its own `open`, a node with a Host opens that Host, as a table row does.
  const openHost = (node: GraphNode) => {
    if (node.host) h.ui.run(`open ${node.host}`);
  };
  return {
    data: g.data,
    ...(g.reach ? { reach: g.reach } : {}),
    ...(g.filter ? { filter: g.filter } : {}),
    ...(g.open ? { open: go(g.open) } : g.data.nodes.some((n) => n.host) ? { open: openHost } : {}),
    actions: g.actions.map((a) => ({ label: a.label, ...(a.key ? { key: a.key } : {}), ...(a.icon ? { icon: a.icon } : {}), ...(a.when ? { when: a.when } : {}), run: go(a.run) })),
  };
}

function putView(c: OpCall, id: string, view: PluginView) {
  const content = viewContent(c, { view: id }, view);
  if (view.graph) content.graph = viewGraph(c, id, view.graph);
  put(c, `view:${id}`, c.host.registries.views.register({ id, source: c.plugin, title: view.title, place: view.place, content }));
}

const OPS: { [K in OpKind]: Entry<K> } = {
  command: {
    parse(raw) {
      const c = raw.complete;
      if (c !== undefined && c !== null && !(isObj(c) && typeof c.handler === "number" && Number.isInteger(c.handler))) {
        throw new Invalid("roster.commands.add: complete must be a function");
      }
      return defined<OpOf<"command">>({
        op: "command",
        name: str(raw, "name", "roster.commands.add", 64),
        desc: str(raw, "desc", "roster.commands.add"),
        run: parseRun(raw.run, "roster.commands.add"),
        complete: isObj(c) ? { handler: c.handler as number } : undefined,
      });
    },
    apply(c, op) {
      const { host: h, plugin } = c;
      const r = h.registries;
      if (op.name === "plugins" || taken(r.commands, op.name, plugin)) return refuse(c, `:${op.name} is taken (${r.commands.get(op.name)?.source ?? "roster"})`);
      const run = op.run;
      const complete = op.complete;
      const def: CommandDef = {
        id: op.name,
        source: plugin,
        area: plugin,
        arg: "text",
        optionalArg: true,
        label: (a) => (a ? `${op.desc || op.name} ${a}` : op.desc || op.name),
        run: (ctx, arg) => {
          const args = (arg ?? "").trim();
          h.runCommand(plugin, op.name, (by) => h.runFor(plugin, run, { args, words: args ? args.split(/\s+/) : [], ...h.cursor(plugin, ctx) } as unknown as HandlerContext, by));
        },
        ...(complete ? { complete: (arg: string) => h.complete(plugin, op.name, complete.handler, arg) } : {}),
      };
      put(c, `command:${op.name}`, r.commands.register(def));
    },
  },
  key: {
    parse(raw) {
      const action = raw.action === false ? false : str(raw, "action", "roster.keymap.set");
      return { op: "key", context: str(raw, "context", "roster.keymap.set", 40), keys: str(raw, "keys", "roster.keymap.set", 60), action };
    },
    apply(c, op) {
      const { host: h, plugin } = c;
      const r = h.registries;
      const context = keyContext(op.context);
      if (!context) return refuse(c, `keys go after the Leader or in the Sidebar (${CORE.key_contexts.join(", ")}), not ${op.context}`);
      const id = bindingId(context, op.keys);
      if (op.action !== false && taken(r.keymap, id, plugin)) {
        const by = r.keymap.get(id);
        const shown = op.context === "leader" ? `␣ ${op.keys}` : `${op.keys} (${op.context})`;
        const free = freeKeys(r.keymap.list(), context, op.keys, plugin);
        const where = op.context === "leader" ? "after the Leader" : `in ${op.context}`;
        return refuse(
          c,
          `${shown} is taken (by ${by?.source ?? "roster"}${by?.action ? `: ${by.action}` : ""}).` + (free.length ? ` Free ${where}: ${free.join(", ")}.` : "") + " Choose another (:keys lists them all)",
        );
      }
      // Nor may it start with a bound key, or be the start of one: either would hide the other.
      const clash = r.keymap
        .list()
        .find((b) => b.context === context && b.source !== plugin && b.action !== null && (op.keys.startsWith(`${b.keys} `) || b.keys.startsWith(`${op.keys} `)));
      if (clash) return refuse(c, `${op.keys} (${op.context}) would hide ${clash.keys}, bound by ${clash.source}`);
      // `false` (keymap.del, api 3) takes the Plugin's own binding off; it never claims keys.
      if (op.action === false) return drop(c, `key:${id}`);
      // Its line goes through `plugins run`, as a button's does (ticket 88, Q98): `:keys` shows that.
      const action = h.line(plugin, { command: op.action });
      put(c, `key:${id}`, r.keymap.register({ id, source: plugin, context, keys: op.keys, action }));
    },
  },
  theme: {
    parse(raw, _spec, id) {
      if (!isObj(raw.theme)) throw new Invalid("roster.themes.define: the Theme must be a table");
      return { op: "theme", id, theme: raw.theme as unknown as ThemeDef };
    },
    apply(c, op) {
      const r = c.host.registries;
      if (taken(r.themes, op.id, c.plugin)) return refuse(c, `there's a Theme named ${op.id} already`);
      const { base } = themeBase(op.theme, (id) => r.themes.get(id));
      if (!base) return;
      put(c, `theme:${op.id}`, r.themes.register(themeOf(op.id, op.theme, base, c.plugin)));
    },
  },
  section: {
    parse(_raw, spec, id) {
      const what = `roster.sidebar.set ${id}`;
      return defined<OpOf<"section">>({
        op: "section",
        id,
        title: optStr(spec, "title", what) ?? id,
        order: num(spec, "order", what) ?? 400,
        empty: optStr(spec, "empty", what),
        rows: list(spec, "rows", what).map((r, i) => parseRow(r, i, what)),
        actions: headActions(spec, what),
        count: num(spec, "count", what),
        drop: optRun({ run: spec.drop }, `${what} drop`).run,
      });
    },
    apply(c, op) {
      const { host: h, plugin } = c;
      const r = h.registries;
      if (taken(r.sidebar, op.id, plugin)) return refuse(c, `there's a Sidebar section named ${op.id} already`);
      const actions = op.actions.map((a, i) => rowAction(c, a, { section: op.id, action: i + 1 }));
      const dropRun = op.drop;
      const build = ({ hostByName }: { hostByName: ReadonlyMap<string, Host> }) => {
        const rows = op.rows.map((row) => sidebarRow(c, op.id, row, hostByName));
        return {
          id: op.id,
          title: op.title,
          count: op.count ?? rows.length,
          rows,
          ...(op.empty ? { empty: op.empty } : {}),
          ...(actions.length ? { actions } : {}),
          ...(dropRun ? { drop: (host: string) => h.line(plugin, dropRun, { section: op.id, dropped: host }) } : {}),
        };
      };
      put(c, `section:${op.id}`, r.sidebar.register({ id: op.id, source: plugin, order: op.order, build }));
    },
  },
  status: {
    parse(_raw, spec, id) {
      const what = `roster.status.set ${id}`;
      return defined<OpOf<"status">>({ op: "status", id, text: str(spec, "text", what, 80), title: optStr(spec, "title", what), run: optRun(spec, what).run });
    },
    apply(c, op) {
      const r = c.host.registries;
      if (taken(r.status, op.id, c.plugin)) return refuse(c, `there's a status segment named ${op.id} already`);
      put(
        c,
        `status:${op.id}`,
        r.status.register({
          id: op.id,
          source: c.plugin,
          text: op.text,
          ...(op.title ? { title: op.title } : {}),
          ...(op.run ? { command: c.host.line(c.plugin, op.run, { segment: op.id }) } : {}),
        }),
      );
    },
  },
  finder: {
    parse(_raw, spec, id) {
      const what = `roster.finders.set ${id}`;
      const items = spec.items;
      const section = optStr(spec, "section", what, 64);
      const title = optStr(spec, "title", what) ?? id;
      return {
        op: "finder",
        id,
        title,
        prompt: optStr(spec, "prompt", what, 64) ?? title,
        items: section !== undefined ? { section } : isObj(items) && typeof items.handler === "number" && Number.isInteger(items.handler) ? { handler: items.handler } : finderItems(spec, what),
      };
    },
    apply(c, op) {
      const { host: h, plugin, loaded: l } = c;
      const r = h.registries;
      if (taken(r.finders, op.id, plugin)) return refuse(c, `there's a finder named ${op.id} already`);
      const key = `finder:${op.id}`;
      const item = (i: PluginFinderItem): FinderItem => ({
        id: i.id,
        label: i.label,
        ...(i.detail ? { detail: i.detail } : {}),
        ...(i.path ? { path: i.path } : {}),
        command: h.line(plugin, i.run, { finder: op.id, item: i.id }),
      });
      const register = (items: FinderItem[] | null, open?: () => void) => {
        const def: FinderSourceDef = {
          id: op.id,
          source: plugin,
          title: op.title,
          prompt: op.prompt,
          items: () => items ?? [],
          ...(items === null ? { empty: "Loading…" } : {}),
          ...(open ? { open } : {}),
        };
        const dispose = r.finders.register(def);
        put(c, key, dispose);
        return dispose;
      };
      if ("section" in op.items) {
        // One of its own sections' rows (api 3), as roster's own `inventory` finder lists its.
        const own = op.items.section;
        const finder = sectionFinder(own, op.title, op.prompt, plugin);
        const def: FinderSourceDef = { ...finder, items: (ctx) => (r.sidebar.get(own)?.source === plugin ? finder.items(ctx) : []) };
        return put(c, key, r.finders.register(def));
      }
      if (!("handler" in op.items)) return void register(op.items.map(item));
      // Its items come from a function: run each time the finder opens (ticket 79).
      const handler = op.items.handler;
      let current: () => void;
      const open = () => {
        const mine = current;
        void h.call(plugin, handler, {}, `listed ${op.id}`, false).then((result) => {
          // Replaced (or gone) meanwhile: what came back is for a finder that isn't there.
          if (l.disposers.get(key) !== mine || h.current(plugin) !== l) return;
          const items = parseFinderItems(result ?? [], `roster.finders.set ${op.id}`);
          if ("invalid" in items) h.notify(plugin, "warn", `${plugin}: ${items.invalid}`);
          current = register("invalid" in items ? [] : items.map(item), open);
        });
      };
      current = register(null, open);
    },
  },
  help: {
    parse(_raw, spec, id) {
      const what = `roster.help.set ${id}`;
      const title = optStr(spec, "title", what) ?? id;
      return { op: "help", id, title, summary: optStr(spec, "summary", what) ?? title, markdown: str(spec, "markdown", what, MAX_HELP) };
    },
    apply(c, op) {
      const r = c.host.registries;
      if (taken(r.help, op.id, c.plugin)) return refuse(c, `there's a help page named ${op.id} already`);
      const blocks = parseMarkdown(op.markdown);
      put(c, `help:${op.id}`, r.help.register({ id: op.id, source: c.plugin, title: op.title, summary: op.summary, order: 1000, body: () => blocks }));
    },
  },
  health: {
    parse(_raw, spec, id) {
      const what = `roster.health.set ${id}`;
      return defined<OpOf<"health">>({
        op: "health",
        id,
        title: optStr(spec, "title", what) ?? id,
        checks: healthChecks(spec.checks, what),
        check: spec.check === undefined || spec.check === null ? undefined : parseRun(spec.check, `${what}: check`),
      });
    },
    apply(c, op) {
      const { host: h, plugin } = c;
      const r = h.registries;
      if (taken(r.health, op.id, plugin)) return refuse(c, `there's a :check section named ${op.id} already`);
      const checks = op.checks.map((x) => ({ section: op.id, ...x }));
      const check = op.check;
      // With `check` (api 3, like vim.health), each `:check` calls the Plugin for its lines.
      const run =
        check === undefined
          ? () => checks
          : "command" in check
            ? () => [{ section: op.id, level: "error" as const, message: "check must be a function" }]
            : async () => h.healthCheck(plugin, op.id, check.handler);
      // A check may answer later, from a request's answer: :check waits for it that long.
      const wait = check === undefined ? undefined : HEALTH_LATER_MS + SECTION_WAIT_MS;
      put(c, `health:${op.id}`, r.health.register({ id: op.id, source: plugin, title: op.title, order: 500, checks: run, ...(wait ? { wait } : {}) }));
    },
  },
  tutor: {
    parse(_raw, spec, id) {
      const what = `roster.tutor.set ${id}`;
      const title = optStr(spec, "title", what) ?? id;
      const ids = new Set<string>();
      const lessons = list(spec, "lessons", what).map((l, i): PluginTutorLesson => {
        const at = `${what} lesson ${i + 1}`;
        if (!isObj(l)) throw new Invalid(`${at}: must be a table`);
        return {
          title: str(l, "title", at, 100),
          text: optStr(l, "text", at, MAX_HELP) ?? "",
          steps: list(l, "steps", at).map((st, j): PluginTutorStep => {
            const where = `${at} step ${j + 1}`;
            if (!isObj(st)) throw new Invalid(`${where}: must be a table`);
            const stepId = str(st, "id", where, 100);
            if (ids.has(stepId)) throw new Invalid(`${where}: id ${stepId} is used twice`);
            ids.add(stepId);
            const raw = Array.isArray(st.on) ? st.on : [st.on];
            if (raw.length === 0) throw new Invalid(`${where}: on must name an event`);
            const on = raw.map((m): StepMatch => {
              if (!isObj(m)) throw new Invalid(`${where}: on must be a table, { event = "…" }, or a list of them`);
              const event = str(m, "event", where, 40);
              if (!(TUTOR_EVENTS as readonly string[]).includes(event)) throw new Invalid(`${where}: event must be one of ${TUTOR_EVENTS.join(", ")}`);
              const fields = Object.fromEntries(
                Object.keys(m)
                  .filter((k) => k !== "event")
                  .map((k) => [k.slice(0, 40), str(m, k, where, 200)]),
              );
              return { ...fields, event };
            });
            return { id: stepId, text: str(st, "text", where), on };
          }),
        };
      });
      if (lessons.length === 0) throw new Invalid(`${what}: lessons must have at least one lesson`);
      return {
        op: "tutor",
        id,
        title,
        summary: optStr(spec, "summary", what) ?? title,
        intro: optStr(spec, "intro", what, MAX_HELP) ?? "",
        lessons,
        outro: optStr(spec, "outro", what, MAX_HELP) ?? "",
      };
    },
    apply(c, op) {
      const r = c.host.registries;
      const page = tutorPage(op.id);
      if (op.id === DEFAULT_TUTORIAL || taken(r.tutorials, op.id, c.plugin)) return refuse(c, `there's a tutorial named ${op.id} already`);
      if (taken(r.help, page, c.plugin)) return refuse(c, `there's a help page named ${page} already`);
      put(c, `tutor:${op.id}`, r.tutorials.register(pluginTutorial(c.plugin, op)));
    },
  },
  toolbar: {
    parse(_raw, spec, id) {
      const what = `roster.toolbar.set ${id}`;
      const icon = spec.icon === undefined || spec.icon === null ? undefined : PLUGIN_TOOLBAR_ICONS.find((i) => i === spec.icon);
      if (spec.icon !== undefined && spec.icon !== null && !icon) throw new Invalid(`${what}: icon must be one of ${PLUGIN_TOOLBAR_ICONS.join(", ")}`);
      return { op: "toolbar", id, control: defined<PluginToolbarControl>({ label: str(spec, "label", what, 80), text: optStr(spec, "text", what, 20), icon, run: parseRun(spec.run, what) }) };
    },
    apply(c, op) {
      const r = c.host.registries;
      if (taken(r.toolbar, op.id, c.plugin)) return refuse(c, `there's a toolbar control named ${op.id} already`);
      const ctl = op.control;
      put(
        c,
        `toolbar:${op.id}`,
        r.toolbar.register({
          id: op.id,
          source: c.plugin,
          label: () => ctl.label,
          ...(ctl.icon ? { icon: ctl.icon } : {}),
          ...(ctl.text || !ctl.icon ? { text: ctl.text ?? ctl.label } : {}),
          command: c.host.line(c.plugin, ctl.run, { toolbar: op.id }),
          side: "end",
          byDefault: true,
        }),
      );
    },
  },
  progress: {
    parse(_raw, spec, id) {
      const what = `roster.progress.set ${id}`;
      const done = num(spec, "done", what);
      const total = num(spec, "total", what);
      if ((done === undefined) !== (total === undefined)) throw new Invalid(`${what}: done and total go together`);
      if (total !== undefined && total <= 0) throw new Invalid(`${what}: total must be more than 0`);
      return {
        op: "progress",
        id,
        progress: defined<PluginProgress>({
          title: str(spec, "title", what, 80),
          text: optStr(spec, "text", what),
          done: done === undefined || total === undefined ? undefined : Math.max(0, Math.min(total, done)),
          total,
          cancel: optRun({ run: spec.cancel }, `${what} cancel`).run,
        }),
      };
    },
    apply(c, op) {
      const other = c.host.shown.progress.get(op.id);
      if (other && other.plugin !== c.plugin) return refuse(c, `there's a progress named ${op.id} already, from ${other.plugin}`);
      // Setting it again after a cancel says it's still stopping until the Plugin says otherwise.
      c.host.shown.progress.set(op.id, { ...op.progress, plugin: c.plugin, id: op.id, stopping: false });
    },
  },
  health_answer: {
    parse(raw) {
      if (typeof raw.check !== "number" || !Number.isInteger(raw.check)) throw new Invalid("roster.health.answer: check must be the run's e.check");
      return { op: "health_answer", check: raw.check, checks: raw.checks };
    },
    apply(c, op) {
      c.host.answerCheck(c.plugin, op.check, op.checks);
    },
  },
  badge: {
    parse(raw) {
      return { op: "badge", host: str(raw, "host", "roster.badges.set", 200), text: raw.text === null ? null : str(raw, "text", "roster.badges.set", 40) };
    },
    apply(c, op) {
      const id = `${c.plugin}:${op.host}`;
      if (op.text === null) return drop(c, `badge:${id}`);
      put(c, `badge:${id}`, c.host.registries.badges.register({ id, source: c.plugin, host: op.host, text: op.text }));
    },
  },
  float: {
    parse(raw, spec) {
      if (raw.spec === null) return { op: "float", spec: null };
      const what = "roster.float.open";
      const lines = list(spec, "lines", what).map((l) => (typeof l === "string" ? l.slice(0, MAX_TEXT) : String(l)));
      const keys = new Set<string>();
      const actions = list(spec, "actions", what).map((a, i): PluginFloatAction => {
        const at = `${what} action ${i + 1}`;
        if (!isObj(a)) throw new Invalid(`${at}: must be a table`);
        const key = optStr(a, "key", at, 8);
        if (key !== undefined) {
          if ([...key].length !== 1 || key.trim() === "") throw new Invalid(`${at}: key must be one character`);
          if (key === "q") throw new Invalid(`${at}: q closes the window`);
          if (keys.has(key)) throw new Invalid(`${at}: key ${key} is used twice`);
          keys.add(key);
        }
        return defined<PluginFloatAction>({ label: str(a, "label", at, 100), key, run: parseRun(a.run, at) });
      });
      const links = list(spec, "links", what).map((l, i): PluginLink => {
        const at = `${what} link ${i + 1}`;
        if (!isObj(l)) throw new Invalid(`${at}: must be a table`);
        return { label: str(l, "label", at, 100), url: webUrl(str(l, "url", at, MAX_URL + 1), at) };
      });
      if (actions.length > MAX_HEAD_ACTIONS) throw new Invalid(`${what}: actions has more than ${MAX_HEAD_ACTIONS}`);
      if (links.length > MAX_HEAD_ACTIONS) throw new Invalid(`${what}: links has more than ${MAX_HEAD_ACTIONS}`);
      const float: PluginFloat = { title: optStr(spec, "title", what) ?? "", lines, actions, links };
      return { op: "float", spec: float };
    },
    apply(c, op) {
      const shown = c.host.shown;
      shown.float = op.spec ? { ...op.spec, plugin: c.plugin } : shown.float?.plugin === c.plugin ? null : shown.float;
    },
  },
  view: {
    parse(_raw, spec, id) {
      const what = `roster.views.set ${id}`;
      const place = spec.place === undefined || spec.place === null ? "panel" : spec.place;
      if (place !== "panel" && place !== "full") throw new Invalid(`${what}: place must be "panel" or "full"`);
      const graph = spec.graph === undefined || spec.graph === null ? undefined : parseGraph(spec.graph, what);
      if (graph && spec.table !== undefined && spec.table !== null) throw new Invalid(`${what}: a view has a table or a graph, not both`);
      const graphKeys = (graph?.actions ?? []).flatMap((a) => (a.key ? [a.key] : []));
      return { op: "view", id, view: { title: optStr(spec, "title", what) ?? id, place, ...parseContent(spec, what, graphKeys), ...(graph ? { graph } : {}) } };
    },
    apply(c, op) {
      if (taken(c.host.registries.views, op.id, c.plugin)) return refuse(c, `there's a view named ${op.id} already`);
      (c.loaded.views ??= new Map()).set(op.id, op.view);
      putView(c, op.id, op.view);
    },
  },
  view_update: {
    parse(raw, _spec, id) {
      const what = `roster.views.update ${id}`;
      const ch = isObj(raw.changes) ? raw.changes : {};
      const columns = ch.columns === undefined || ch.columns === null ? undefined : columnsOf(ch, what);
      const by = optStr(ch, "sort", what, 64);
      if (by !== undefined && columns && !columns.some((col) => col.id === by)) throw new Invalid(`${what}: sort names no column (${by})`);
      if (ch.desc !== undefined && ch.desc !== null && typeof ch.desc !== "boolean") throw new Invalid(`${what}: desc must be true or false`);
      return {
        op: "view_update",
        id,
        update: defined<PluginViewUpdate>({
          columns,
          sort: by === undefined ? undefined : { by, desc: ch.desc === true },
          actions: ch.actions === undefined || ch.actions === null ? undefined : tableActions(ch, what),
          title: optStr(ch, "title", what),
          text: optStr(ch, "text", what, MAX_VIEW_TEXT),
          facts: ch.facts === undefined || ch.facts === null ? undefined : facts(ch, what),
          rows: tableRows(ch, "rows", what),
          remove: list(ch, "remove", what).map((r, i) => {
            if (typeof r !== "string") throw new Invalid(`${what}: remove ${i + 1} must be a row's id`);
            return r;
          }),
          graph: parseGraphUpdate(ch, what),
          clear: clearOf(ch, what),
        }),
      };
    },
    apply(c, op) {
      const l = c.loaded;
      const view = l.views?.get(op.id);
      if (!view) return refuse(c, `roster.views.update: there's no view ${op.id} (roster.views.set it first)`);
      const u = op.update;
      // `remove` is a graph's nodes and clusters in a graph, else a table's rows.
      const tableChange = u.rows.length > 0 || u.clear === true || (u.remove.length > 0 && !view.graph) || u.columns !== undefined || u.sort !== undefined || u.actions !== undefined;
      if (tableChange && !view.table) return refuse(c, `roster.views.update ${op.id}: the view has no table to change`);
      if (u.graph && !view.graph) return refuse(c, `roster.views.update ${op.id}: the view has no graph for nodes and edges`);
      let graph = view.graph;
      if (graph && (u.graph || u.remove.length)) {
        const g = u.graph ?? { nodes: [], edges: [], clusters: [], removeEdges: [] };
        const data = mergeGraph(graph.data, { ...g, remove: u.remove });
        const over = graphOver(data);
        if (over) return refuse(c, `roster.views.update ${op.id}: more than ${over}`);
        graph = { ...graph, data, ...(g.filter ? { filter: g.filter } : {}) };
      }
      let table = view.table;
      if (table && (u.rows.length || u.remove.length || u.clear)) {
        const rows = mergeRows(u.clear ? [] : table.rows, u.rows, u.remove);
        if (rows.length > MAX_TABLE_ROWS) return refuse(c, `roster.views.update ${op.id}: more than ${MAX_TABLE_ROWS.toLocaleString("en-US")} rows`);
        table = { ...table, rows };
      }
      if (table && (u.columns || u.sort || u.actions)) {
        const columns = u.columns ?? table.columns;
        const sort = u.sort ?? (table.sort && columns.some((col) => col.id === table?.sort?.by) ? table.sort : null);
        if (sort && !columns.some((col) => col.id === sort.by)) return refuse(c, `roster.views.update ${op.id}: sort names no column (${sort.by})`);
        table = { ...table, columns, sort, ...(u.actions ? { actions: u.actions } : {}) };
      }
      const next: PluginView = {
        ...view,
        ...(u.title !== undefined ? { title: u.title } : {}),
        ...(u.facts !== undefined ? { facts: u.facts } : {}),
        ...(table ? { table } : {}),
        ...(graph ? { graph } : {}),
      };
      if (u.text === "") delete next.text;
      else if (u.text !== undefined) next.text = u.text;
      l.views?.set(op.id, next);
      putView(c, op.id, next);
    },
  },
  view_open: {
    parse(raw, _spec, id) {
      const select = optStr(raw, "select", "roster.views.open", 200);
      return { op: "view_open", id, ...(select !== undefined ? { select } : {}) };
    },
    apply(c, op) {
      const h = c.host;
      if (h.registries.views.get(op.id)?.source !== c.plugin) return refuse(c, `roster.views.open: there's no view ${op.id} of yours`);
      if (op.select !== undefined && h.ui.openView) return h.ui.openView(op.id, op.select);
      h.ui.run(`view ${op.id}`);
    },
  },
  view_close: {
    parse(_raw, _spec, id) {
      return { op: "view_close", id };
    },
    apply(c, op) {
      if (c.host.registries.views.get(op.id)?.source !== c.plugin) return refuse(c, `roster.views.close: there's no view ${op.id} of yours`);
      c.host.ui.closeView?.(op.id);
    },
  },
  details: {
    parse(raw, spec, id) {
      const host = str(raw, "host", "roster.details.set", 200);
      if (raw.spec === null || raw.spec === undefined) return { op: "details", id, host, section: null };
      const what = `roster.details.set ${id} ${host}`;
      return { op: "details", id, host, section: { title: optStr(spec, "title", what) ?? id, order: num(spec, "order", what) ?? 500, ...parseContent(spec, what) } };
    },
    apply(c, op) {
      const r = c.host.registries;
      const id = detailsId(op.id, op.host);
      const other = r.details.list().find((e) => e.section === op.id && e.source !== c.plugin);
      if (other) return refuse(c, `there's a Host-details section named ${op.id} already, from ${other.source}`);
      if (op.section === null) return drop(c, `details:${id}`);
      const content = viewContent(c, { section: op.id, host: op.host }, op.section);
      put(c, `details:${id}`, r.details.register({ id, source: c.plugin, section: op.id, host: op.host, title: op.section.title, order: op.section.order, content }));
    },
  },
  copy: {
    parse(raw) {
      return { op: "copy", text: str(raw, "text", "roster.clipboard.copy", MAX_COPY) };
    },
    apply(c, op) {
      const { host: h, plugin } = c;
      const before: Promise<boolean> = c.copying ?? Promise.resolve(true);
      const done = h.ui.copy(op.text).then(
        () => true,
        (e: unknown) => {
          h.notify(plugin, "error", `${plugin}: couldn't copy to the clipboard: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        },
      );
      c.copying = Promise.all([before, done]).then(([a, b]) => a && b);
    },
  },
  confirm: {
    parse(_raw, spec) {
      const what = "roster.confirm";
      const r = parseRun(spec.run, what);
      if (!("handler" in r)) throw new Invalid(`${what}: run must be a function`);
      if (spec.danger !== undefined && spec.danger !== null && typeof spec.danger !== "boolean") throw new Invalid(`${what}: danger must be true or false`);
      const danger = spec.danger === true;
      const typed = optStr(spec, "typed", what, 101);
      if (typed !== undefined && (typed.trim() === "" || typed.length > 100)) throw new Invalid(`${what}: typed must be a word of at most 100 characters`);
      if (typed !== undefined && !danger) throw new Invalid(`${what}: typed goes with danger = true`);
      return {
        op: "confirm",
        confirm: defined<PluginConfirm>({
          title: str(spec, "title", what),
          text: optStr(spec, "text", what, MAX_VIEW_TEXT),
          facts: facts(spec, what),
          action: optStr(spec, "action", what, 40) ?? "Confirm",
          danger,
          typed,
          run: r,
          cancel: optRun({ run: spec.cancel }, `${what} cancel`).run,
        }),
      };
    },
    apply(c, op) {
      // One question at a time: a newer one replaces it (another Plugin's hears its cancel).
      const before = c.host.shown.ask(c.plugin, op.confirm);
      // The app's doing, not the user's answer: never the user's call for that Plugin.
      if (before && before.plugin !== c.plugin && before.cancel) c.host.runFor(before.plugin, before.cancel, { confirm: "no" }, false);
    },
  },
  cmd: {
    parse(raw) {
      return { op: "cmd", line: str(raw, "line", "roster.cmd", MAX_TEXT), ...(raw.user === false ? { user: false as const } : {}) };
    },
    apply(c, op) {
      // One hop (issue #183): made in the user's own call, the Plugin's own command it names is
      // that call carried; made in a carried run (`user: false`), it's the app's call.
      c.host.runCmdLine(c.plugin, op.user === false ? false : "carried", op.line);
    },
  },
  echo: {
    parse(raw) {
      return { op: "echo", text: str(raw, "text", "roster.echo"), ...(raw.quiet === true ? { quiet: true } : {}) };
    },
    apply(c, op) {
      const h = c.host;
      if (h.ui.say) h.ui.say(op.quiet ? quietMessage(op.text) : op.text);
      else h.notify(c.plugin, "info", `${c.plugin}: ${op.text}`);
    },
  },
  cmdline: {
    parse(raw) {
      return { op: "cmdline", text: str(raw, "text", "roster.cmdline", MAX_TEXT) };
    },
    apply(c, op) {
      // Its own commands only (the core checks too): never a line for roster's or another's.
      const word = op.text.trim().split(/\s+/)[0] ?? "";
      if (c.host.registries.commands.get(word)?.source !== c.plugin) return refuse(c, `roster.cmdline: ${word} isn't one of its commands`);
      c.host.ui.openCommandLine?.(op.text);
    },
  },
  notify: {
    parse(raw) {
      const level = LEVELS.find((l) => l === raw.level) ?? "info";
      const actions = list(raw, "actions", "roster.notify").map((a, i) => {
        const at = `roster.notify action ${i + 1}`;
        if (!isObj(a)) throw new Invalid(`${at}: must be a table`);
        if (typeof a.run !== "string") throw new Invalid(`${at}: run must be a command line`);
        return { label: str(a, "label", at, 100), command: str(a, "run", at) };
      });
      if (actions.length > MAX_NOTICE_ACTIONS) throw new Invalid(`roster.notify: actions has more than ${MAX_NOTICE_ACTIONS}`);
      const quiet = typeof raw.quiet === "boolean" ? { quiet: raw.quiet } : {};
      return { op: "notify", text: str(raw, "text", "roster.notify"), level, actions, ...quiet };
    },
    apply(c, op) {
      const { host: h, plugin, background } = c;
      const say = () => h.notify(plugin, op.level, `${plugin}: ${op.text}`, op.actions, op.quiet, background);
      // After a copy, only once it's done: if it failed, "Copied" would be a lie (decision Q87).
      if (c.copying) void c.copying.then((ok) => ok && say());
      else say();
    },
  },
  session_show: {
    parse(raw) {
      const session = num(raw, "session", "roster.sessions.show");
      if (session === undefined || !Number.isInteger(session)) throw new Invalid("roster.sessions.show: which Session?");
      return { op: "session_show", session, line: raw.line === null || raw.line === undefined ? null : str(raw, "line", "roster.sessions.show") };
    },
    apply(c, op) {
      const ui = c.host.ui;
      if (ui.showSession && !ui.showSession(op.session, op.line)) refuse(c, `there's no Session ${op.session} now: it has ended`);
    },
  },
  open: {
    parse(raw) {
      return { op: "open", host: str(raw, "host", "roster.sessions.open", 200) };
    },
    apply(c, op) {
      c.host.ui.run(`connect ${op.host}`);
    },
  },
  send: {
    parse(raw) {
      const session = num(raw, "session", "roster.terminal.send");
      if (session === undefined) throw new Invalid("roster.terminal.send: which Session?");
      return { op: "send", session, text: str(raw, "text", "roster.terminal.send", 64 * 1024) };
    },
    apply(c, op) {
      c.host.ui.send(op.session, op.text);
    },
  },
  timer: {
    parse(raw, _spec, id) {
      const ms = num(raw, "ms", "timer");
      if (ms === undefined || ms < 0) throw new Invalid("timer: ms must be a number");
      const r = parseRun(raw.run, "timer");
      if (!("handler" in r)) throw new Invalid("timer: run must be a function");
      return { op: "timer", id, ms, every: raw.every === true, run: r };
    },
    apply(c, op) {
      // The clock is here; the function runs in the Plugin. A repeating one waits again once
      // a run has answered, so a slow run never piles up behind itself.
      const { host: h, plugin, loaded: l } = c;
      const key = `timer:${op.id}`;
      let handle: ReturnType<typeof setTimeout> | null = null;
      let live = true;
      const fire = async () => {
        handle = null;
        // A deferred one is gone in the core as it runs.
        if (!op.every) l.disposers.delete(key);
        await h.call(plugin, op.run.handler, {}, null, false);
        if (live && op.every && h.current(plugin) === l) handle = setTimeout(() => void fire(), op.ms);
      };
      handle = setTimeout(() => void fire(), op.ms);
      put(c, key, () => {
        live = false;
        if (handle) clearTimeout(handle);
      });
    },
  },
  remove: {
    parse(raw, _spec, id) {
      const kind = REMOVABLE.find((k) => k === raw.kind);
      if (!kind) throw new Invalid("remove: of what?");
      return { op: "remove", kind, id };
    },
    apply(c, op) {
      const l = c.loaded;
      if (op.kind === "view") l.views?.delete(op.id);
      if (op.kind === "progress") {
        if (c.host.shown.progress.get(op.id)?.plugin === c.plugin) c.host.shown.progress.delete(op.id);
        return;
      }
      if (op.kind === "details") {
        for (const key of [...l.disposers.keys()].filter((k) => k.startsWith(`details:${op.id}@`))) drop(c, key);
        return;
      }
      drop(c, `${op.kind}:${op.id}`);
    },
  },
};

const isKind = (k: string): k is OpKind => Object.hasOwn(OPS, k);

/** The op, checked; or why it can't be used. */
export function parseOp(raw: unknown): PluginOp | { invalid: string } {
  try {
    if (!isObj(raw) || typeof raw.op !== "string") throw new Invalid("not an op");
    if (!isKind(raw.op)) throw new Invalid(`there's no op ${raw.op}`);
    const spec = isObj(raw.spec) ? raw.spec : {};
    const id = typeof raw.id === "string" ? raw.id : "";
    return OPS[raw.op].parse(raw, spec, id);
  } catch (e) {
    if (e instanceof Invalid || e instanceof GraphInvalid) return { invalid: e.message };
    throw e;
  }
}

/** Does what `op` asks: puts its piece up (or takes it away) as Plugin `c.plugin`'s. */
export function applyOp(c: OpCall, op: PluginOp): void {
  (OPS[op.op].apply as (c: OpCall, op: PluginOp) => void)(c, op);
}
