// What a Plugin asks of the UI (ticket 23, docs/plugins.md "Ops"): plain data from roster-core's
// Plugin host, one op per `roster.*` call. It comes from third-party code, so every op is checked
// here before the app draws anything: a field of the wrong kind drops the op with a reason, and
// text is cut to what the UI can show. A Lua function arrives as `{ handler: N }`.
import type { ThemeDef } from "../config/types";
import type { RowAction } from "../sidebar/Sidebar";
import { TUTOR_EVENTS, type StepMatch } from "../tutor/tutor";
import type { ColumnKind, Sort, TableColumn, TableRow, Tone } from "../ui/table";
import { GRAPH_KEYS, GraphInvalid, parseGraph, parseGraphUpdate, type PluginGraph, type PluginGraphUpdate } from "./graphOps";

/** What choosing something runs: a function the Plugin handed over, or a command line. */
export type Run = { handler: number } | { command: string };

export interface PluginRowAction {
  label: string;
  icon: RowAction["icon"];
  run: Run;
  /** A view's or Host-details section's heading button only (api 4, #176): its key. */
  key?: string;
}

export interface PluginRow {
  id: string;
  label: string;
  detail?: string;
  note?: string;
  host?: string;
  badge?: string;
  count?: number;
  level?: number;
  title?: string;
  run?: Run;
  actions: PluginRowAction[];
  /** api 3 (ticket 61): a glyph, folding, drawn as an Inventory Host, and drag and drop. */
  icon?: "folder" | "group";
  fold?: boolean;
  kind?: "host";
  drop?: Run;
  dragOut?: Run;
}

export interface PluginFinderItem {
  id: string;
  label: string;
  detail?: string;
  path?: string;
  run: Run;
}

/** One line of a Plugin's `:check` section. */
export interface PluginHealthCheck {
  level: "ok" | "warn" | "error";
  message: string;
  fix?: string;
}

/** A Plugin's tutorial (`roster.tutor.set`, ticket 55): Markdown text, and steps that wait for
 * app events (tutor.ts StepMatch). */
export interface PluginTutorStep {
  id: string;
  text: string;
  on: StepMatch[];
}

export interface PluginTutorLesson {
  title: string;
  text: string;
  steps: PluginTutorStep[];
}

/** A button in a floating window (ticket 78). */
export interface PluginFloatAction {
  label: string;
  key?: string;
  run: Run;
}

/** A web page a floating window links to: http or https only, shown with its host. */
export interface PluginLink {
  label: string;
  url: string;
}

export interface PluginFloat {
  title: string;
  lines: string[];
  actions: PluginFloatAction[];
  links: PluginLink[];
}

/** A question the app draws and the user answers (`roster.confirm`, ticket 78). */
export interface PluginConfirm {
  title: string;
  text?: string;
  facts: PluginFact[];
  /** The confirming button's word. */
  action: string;
  /** The stronger form: the danger button, the keys starting on Cancel. */
  danger: boolean;
  /** With danger: what the user types before the button works. */
  typed?: string;
  run: { handler: number };
  cancel?: Run;
}

/** How far something long has got (`roster.progress.set`, ticket 78). */
export interface PluginProgress {
  title: string;
  text?: string;
  /** Both, or neither (it only shows it's going). */
  done?: number;
  total?: number;
  cancel?: Run;
}

/** The icons a Plugin's toolbar control may have. */
export const PLUGIN_TOOLBAR_ICONS = ["find", "add", "details", "help", "map"] as const;
export type PluginToolbarIcon = (typeof PLUGIN_TOOLBAR_ICONS)[number];

/** A toolbar control (`roster.toolbar.set`, ticket 78). */
export interface PluginToolbarControl {
  label: string;
  text?: string;
  icon?: PluginToolbarIcon;
  run: Run;
}

/** A label and its value (a Host's details, a view). `data`: set in the data font. */
export interface PluginFact {
  label: string;
  value: string;
  data?: true;
}

export interface PluginTableAction {
  label: string;
  /** One character that runs it on the selected row. */
  key?: string;
  icon?: RowAction["icon"];
  /** Only on rows whose cells match: each key one of its values (ticket 78). */
  when?: Readonly<Record<string, readonly (string | number)[]>>;
  run: Run;
}

/** A table (ticket 76): rows are plain data; what a row does is the table's, and a function gets
 * the row (`{ row, host, view | section }`). */
export interface PluginTable {
  columns: TableColumn[];
  rows: TableRow[];
  sort: Sort | null;
  empty?: string;
  open?: Run;
  actions: PluginTableAction[];
}

/** What a view and a Host-details section hold, drawn top to bottom. */
export interface PluginContent {
  /** Buttons on its heading (ticket 91): what the whole view or section can do, at most 4. */
  actions: PluginRowAction[];
  text?: string;
  facts: PluginFact[];
  table?: PluginTable;
}

export type ViewPlace = "panel" | "full";

export interface PluginView extends PluginContent {
  title: string;
  place: ViewPlace;
  /** A graph instead of a table (ticket 77). */
  graph?: PluginGraph;
}

export interface PluginViewUpdate {
  title?: string;
  /** "" takes the text away. */
  text?: string;
  facts?: PluginFact[];
  rows: TableRow[];
  /** Rows' ids, or in a graph, nodes' and clusters'. */
  remove: string[];
  /** Every row goes first (ticket 91); `rows` then fill the table again. */
  clear?: true;
  /** Nodes, edges and clusters, in a graph (ticket 77). */
  graph?: PluginGraphUpdate;
  /** New columns, all of them (ticket 78). */
  columns?: TableColumn[];
  /** Sort by this now; `desc` with it. */
  sort?: Sort;
  /** New actions, all of them. */
  actions?: PluginTableAction[];
}

export interface PluginDetails extends PluginContent {
  title: string;
  order: number;
}

export type PluginOp =
  /** `complete` (api 3): a function the app calls with what's typed after the name. */
  | { op: "command"; name: string; desc: string; run: Run; complete?: { handler: number } }
  | { op: "key"; context: string; keys: string; action: string | false }
  | { op: "theme"; id: string; theme: ThemeDef }
  | { op: "section"; id: string; title: string; order: number; empty?: string; rows: PluginRow[]; actions: PluginRowAction[]; count?: number; drop?: Run }
  | { op: "status"; id: string; text: string; title?: string; run?: Run }
  /** `items` is a handler when the Plugin hands a function (ticket 79): run as the finder opens. */
  | { op: "finder"; id: string; title: string; prompt: string; items: PluginFinderItem[] | { handler: number } | { section: string } }
  | { op: "help"; id: string; title: string; summary: string; markdown: string }
  | { op: "health"; id: string; title: string; checks: PluginHealthCheck[]; check?: Run }
  /** `roster.health.answer` (decision Q112h): the lines for a `:check` run whose `check` returned
   * "later". Checked when the app takes them, so bad lines are that section's ERROR line. */
  | { op: "health_answer"; check: number; checks: unknown }
  | { op: "tutor"; id: string; title: string; summary: string; intro: string; lessons: PluginTutorLesson[]; outro: string }
  | { op: "badge"; host: string; text: string | null }
  | { op: "float"; spec: PluginFloat | null }
  | { op: "view"; id: string; view: PluginView }
  | { op: "view_update"; id: string; update: PluginViewUpdate }
  | { op: "view_open"; id: string; select?: string }
  | { op: "view_close"; id: string }
  | { op: "details"; id: string; host: string; section: PluginDetails | null }
  /** `actions` (ticket 91): buttons whose click runs a command line, as `roster.cmd` would. */
  | { op: "notify"; text: string; level: "info" | "warn" | "error"; actions: { label: string; command: string }[]; quiet?: boolean }
  | { op: "open"; host: string }
  | { op: "send"; session: number; text: string }
  | { op: "copy"; text: string }
  | { op: "confirm"; confirm: PluginConfirm }
  | { op: "progress"; id: string; progress: PluginProgress }
  | { op: "toolbar"; id: string; control: PluginToolbarControl }
  /** `user: false`: made in a run that carried the user's call already, so the Plugin's own
   * command it names runs as the app's call (issue #183). */
  | { op: "cmd"; line: string; user?: false }
  /** api 3 (ticket 61): a line on the message line, and the command line opened with text. */
  | { op: "echo"; text: string; quiet?: boolean }
  | { op: "cmdline"; text: string }
  | { op: "session_show"; session: number; line: string | null }
  /** A timer (ticket 79): run `run` after `ms`, again every `ms` when `every`. */
  | { op: "timer"; id: string; ms: number; every: boolean; run: { handler: number } }
  | { op: "remove"; kind: RemovableKind; id: string };

export const REMOVABLE = ["command", "theme", "section", "status", "finder", "help", "health", "tutor", "view", "details", "timer", "toolbar", "progress"] as const;
export type RemovableKind = (typeof REMOVABLE)[number];

const ICONS: readonly RowAction["icon"][] = ["close", "edit", "add", "addGroup", "review", "unreview", "info", "copy", "plan", "apply", "cut", "map"];
const LEVELS = ["info", "warn", "error"] as const;
const HEALTH_LEVELS = ["ok", "warn", "error"] as const;

/** Most rows a section, items a finder, lines a float may have. */
export const MAX_ROWS = 2000;
/** Most rows a table may hold after updates (ticket 76). */
export const MAX_TABLE_ROWS = 10_000;
const MAX_TEXT = 500;
const MAX_VIEW_TEXT = 4000;
const MAX_COLUMNS = 20;
const MAX_ACTIONS = 8;
const KINDS: readonly ColumnKind[] = ["text", "data", "number"];
const TONES: readonly Tone[] = ["muted", "warn", "error"];
/** Keys a table uses itself (moving, sorting, and kept for a filter and its help). */
export const TABLE_KEYS = ["j", "k", "g", "G", "s", "S", "/", "?", "q"] as const;
const MAX_HELP = 200_000;
/** Most buttons on a section's heading, and actions and links in a float. */
const MAX_HEAD_ACTIONS = 4;
/** Most buttons on a notice. */
const MAX_NOTICE_ACTIONS = 2;
/** Most cells an action's `when` may test. */
const MAX_WHEN = 8;
const MAX_URL = 2000;
const MAX_COPY = 64 * 1024;

class Invalid extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(o: Obj, key: string, what: string, max = MAX_TEXT): string {
  const v = o[key];
  if (typeof v !== "string") throw new Invalid(`${what}: ${key} must be text`);
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

function optStr(o: Obj, key: string, what: string, max = MAX_TEXT): string | undefined {
  return o[key] === undefined || o[key] === null ? undefined : str(o, key, what, max);
}

function num(o: Obj, key: string, what: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Invalid(`${what}: ${key} must be a number`);
  return v;
}

function list(o: Obj, key: string, what: string): unknown[] {
  const v = o[key];
  if (v === undefined || v === null || (isObj(v) && Object.keys(v).length === 0)) return [];
  if (!Array.isArray(v)) throw new Invalid(`${what}: ${key} must be a list`);
  if (v.length > MAX_ROWS) throw new Invalid(`${what}: ${key} has more than ${MAX_ROWS} entries`);
  return v;
}

function run(v: unknown, what: string): Run {
  if (typeof v === "string") return { command: v.slice(0, MAX_TEXT) };
  if (isObj(v) && typeof v.handler === "number" && Number.isInteger(v.handler)) return { handler: v.handler };
  throw new Invalid(`${what}: run must be a function or a command line`);
}

const optRun = (o: Obj, what: string): { run?: Run } => (o.run === undefined || o.run === null ? {} : { run: run(o.run, what) });

/** Buttons on a section's heading (ticket 78): row actions, at most 4. */
function headActions(spec: Obj, what: string): PluginRowAction[] {
  const actions = rowActions(spec, what);
  if (actions.length > MAX_HEAD_ACTIONS) throw new Invalid(`${what}: actions has more than ${MAX_HEAD_ACTIONS}`);
  return actions;
}

/** A view's or section's heading buttons with their keys (api 4, #176): one character each, used
 * once, none the table's or graph's own keys (either may come later through an update) and none
 * of its actions' keys (`taken`). */
function keyedHeadActions(spec: Obj, what: string, taken: readonly string[]): PluginRowAction[] {
  const raw = list(spec, "actions", what);
  const seen = new Set(taken);
  return headActions(spec, what).map((a, j) => {
    const where = `${what} action ${j + 1}`;
    const key = optStr(raw[j] as Obj, "key", where, 8);
    if (key === undefined) return a;
    if ([...key].length !== 1 || key.trim() === "") throw new Invalid(`${where}: key must be one character`);
    const reserved = headReserved();
    if (reserved.includes(key)) throw new Invalid(`${where}: the table or graph uses ${key} itself (${reserved.join(" ")})`);
    if (seen.has(key)) throw new Invalid(`${where}: key ${key} is used twice`);
    seen.add(key);
    return { ...a, key };
  });
}

/** What a heading button's key can't be: a table's keys and a graph's. */
const headReserved = (): readonly string[] => [...new Set<string>([...TABLE_KEYS, ...GRAPH_KEYS])];

/** An http or https address, or why it can't be one. */
function webUrl(text: string, what: string): string {
  if (text.length > MAX_URL) throw new Invalid(`${what}: url is over ${MAX_URL} characters`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Invalid(`${what}: url must be an https:// or http:// address`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) {
    throw new Invalid(`${what}: url must be an https:// or http:// address`);
  }
  return url.href;
}

/** Leaves out the keys whose value is undefined (exactOptionalPropertyTypes). */
function defined<T>(o: { [K in keyof T]-?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function rowActions(v: Obj, at: string): PluginRowAction[] {
  return list(v, "actions", at).map((a, j): PluginRowAction => {
    const where = `${at} action ${j + 1}`;
    if (!isObj(a)) throw new Invalid(`${where}: must be a table`);
    const icon = a.icon === undefined ? "info" : a.icon;
    if (!ICONS.includes(icon as RowAction["icon"])) throw new Invalid(`${where}: icon must be one of ${ICONS.join(", ")}`);
    return { label: str(a, "label", where), icon: icon as RowAction["icon"], run: run(a.run, where) };
  });
}

function row(v: unknown, i: number, what: string): PluginRow {
  const at = `${what} row ${i + 1}`;
  if (!isObj(v)) throw new Invalid(`${at}: must be a table`);
  const label = str(v, "label", at);
  const actions = rowActions(v, at);
  const level = num(v, "level", at);
  return defined<PluginRow>({
    id: optStr(v, "id", at, 100) ?? String(i + 1),
    label,
    detail: optStr(v, "detail", at),
    note: optStr(v, "note", at),
    host: optStr(v, "host", at, 200),
    badge: optStr(v, "badge", at, 40),
    count: num(v, "count", at),
    level: level === undefined ? undefined : Math.max(0, Math.min(8, Math.floor(level))),
    title: optStr(v, "title", at),
    run: optRun(v, at).run,
    actions,
    icon: rowGlyph(v, at),
    fold: optBool(v, "fold", at),
    kind: v.kind === undefined || v.kind === null ? undefined : v.kind === "host" ? "host" : bad(`${at}: kind must be "host"`),
    drop: optRun({ run: v.drop }, `${at} drop`).run,
    dragOut: optRun({ run: v.drag_out }, `${at} drag_out`).run,
  });
}

function bad(message: string): never {
  throw new Invalid(message);
}

function optBool(o: Obj, key: string, what: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new Invalid(`${what}: ${key} must be true or false`);
  return v;
}

function rowGlyph(o: Obj, what: string): "folder" | "group" | undefined {
  const v = o.icon;
  if (v === undefined || v === null) return undefined;
  if (v === "folder" || v === "group") return v;
  throw new Invalid(`${what}: icon must be "folder" or "group"`);
}

function healthChecks(v: unknown, what: string): PluginHealthCheck[] {
  return list({ checks: v }, "checks", what).map((c, i): PluginHealthCheck => {
    const at = `${what} check ${i + 1}`;
    if (!isObj(c)) throw new Invalid(`${at}: must be a table`);
    const level = HEALTH_LEVELS.find((l) => l === c.level);
    if (!level) throw new Invalid(`${at}: level must be "ok", "warn" or "error"`);
    return defined<PluginHealthCheck>({ level, message: str(c, "message", at), fix: optStr(c, "fix", at) });
  });
}

/** What a `:check` section's `check` returned (`HealthCheck[]`), checked; or why it can't be used. */
export function parseHealthChecks(v: unknown, what: string): PluginHealthCheck[] | { invalid: string } {
  try {
    return healthChecks(v, what);
  } catch (e) {
    if (e instanceof Invalid) return { invalid: e.message };
    throw e;
  }
}

function finderItems(o: Obj, what: string): PluginFinderItem[] {
  return list(o, "items", what).map((v, i): PluginFinderItem => {
    const at = `${what} item ${i + 1}`;
    if (!isObj(v)) throw new Invalid(`${at}: must be a table`);
    return defined<PluginFinderItem>({
      id: optStr(v, "id", at, 100) ?? String(i + 1),
      label: str(v, "label", at),
      detail: optStr(v, "detail", at),
      path: optStr(v, "path", at),
      run: run(v.run, at),
    });
  });
}

/** What a finder's items function returned (ticket 79), checked as a finder's `items`. */
export function parseFinderItems(result: unknown, what: string): PluginFinderItem[] | { invalid: string } {
  try {
    return finderItems({ items: result }, what);
  } catch (e) {
    if (e instanceof Invalid) return { invalid: e.message };
    throw e;
  }
}

/** A list that may come from Lua as `{}` (an empty table is an object in JSON). */
const isList = (v: unknown): v is unknown[] => Array.isArray(v);

function facts(o: Obj, what: string): PluginFact[] {
  return list(o, "facts", what).map((v, i): PluginFact => {
    const at = `${what} fact ${i + 1}`;
    if (!isObj(v)) throw new Invalid(`${at}: must be a table`);
    if (v.data !== undefined && v.data !== null && typeof v.data !== "boolean") throw new Invalid(`${at}: data must be true or false`);
    return defined<PluginFact>({ label: str(v, "label", at, 100), value: str(v, "value", at), data: v.data === true ? true : undefined });
  });
}

/** A table's row: an id, its cells (text or numbers), its Host and tone. */
function tableRow(v: unknown, i: number, what: string): TableRow {
  const at = `${what} row ${i + 1}`;
  if (!isObj(v)) throw new Invalid(`${at}: must be a table`);
  const raw = v.cells;
  const cells: Record<string, string | number> = {};
  if (isObj(raw)) {
    for (const [k, c] of Object.entries(raw)) {
      if (typeof c === "number" && Number.isFinite(c)) cells[k] = c;
      else if (typeof c === "string") cells[k] = c.length > MAX_TEXT ? `${c.slice(0, MAX_TEXT - 1)}…` : c;
      else throw new Invalid(`${at}: cells.${k} must be text or a number`);
    }
  } else if (!(raw === undefined || raw === null || (isList(raw) && raw.length === 0))) throw new Invalid(`${at}: cells must be a table of column = value`);
  const tone = v.tone === undefined || v.tone === null ? undefined : TONES.find((t) => t === v.tone);
  if (v.tone !== undefined && v.tone !== null && !tone) throw new Invalid(`${at}: tone must be "muted", "warn" or "error"`);
  return defined<TableRow>({ id: str(v, "id", at, 100), cells, host: optStr(v, "host", at, 200), tone });
}

function tableRows(o: Obj, key: string, what: string): TableRow[] {
  const rows = list(o, key, what).map((r, i) => tableRow(r, i, what));
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) throw new Invalid(`${what}: row id ${r.id} is used twice`);
    seen.add(r.id);
  }
  return rows;
}

/** A table's columns: 1 to 20, each id once. */
function columnsOf(v: Obj, at: string): TableColumn[] {
  const ids = new Set<string>();
  const columns = list(v, "columns", at).map((c, i): TableColumn => {
    const where = `${at} column ${i + 1}`;
    if (!isObj(c)) throw new Invalid(`${where}: must be a table`);
    const id = str(c, "id", where, 64);
    if (ids.has(id)) throw new Invalid(`${where}: id ${id} is used twice`);
    ids.add(id);
    const kind = c.kind === undefined || c.kind === null ? "text" : KINDS.find((k) => k === c.kind);
    if (!kind) throw new Invalid(`${where}: kind must be "text", "data" or "number"`);
    const width = num(c, "width", where);
    return defined<TableColumn>({ id, label: str(c, "label", where, 100), kind, width: width === undefined ? undefined : Math.max(2, Math.min(80, Math.round(width))) });
  });
  if (columns.length === 0) throw new Invalid(`${at}: columns must have at least one column`);
  if (columns.length > MAX_COLUMNS) throw new Invalid(`${at}: columns has more than ${MAX_COLUMNS}`);
  return columns;
}

/** An action's `when`: cell = value, or a list of values (a graph's names a node's fields). */
export function when(a: Obj, where: string): PluginTableAction["when"] {
  const v = a.when;
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new Invalid(`${where}: when must be a table of cell = value`);
  const keys = Object.keys(v);
  if (keys.length > MAX_WHEN) throw new Invalid(`${where}: when tests more than ${MAX_WHEN} cells`);
  const out: Record<string, (string | number)[]> = {};
  for (const k of keys) {
    const raw = v[k];
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0 || !values.every((x) => typeof x === "string" || (typeof x === "number" && Number.isFinite(x)))) {
      throw new Invalid(`${where}: when.${k} must be text, a number, or a list of them`);
    }
    out[k.slice(0, 64)] = values as (string | number)[];
  }
  return out;
}

/** A table's actions: at most 8, each key once and none the table's own. */
function tableActions(v: Obj, at: string): PluginTableAction[] {
  const keys = new Set<string>();
  const actions = list(v, "actions", at).map((a, j): PluginTableAction => {
    const where = `${at} action ${j + 1}`;
    if (!isObj(a)) throw new Invalid(`${where}: must be a table`);
    const key = optStr(a, "key", where, 8);
    if (key !== undefined) {
      if ([...key].length !== 1 || key.trim() === "") throw new Invalid(`${where}: key must be one character`);
      if ((TABLE_KEYS as readonly string[]).includes(key)) throw new Invalid(`${where}: the table uses ${key} itself (${TABLE_KEYS.join(" ")})`);
      if (keys.has(key)) throw new Invalid(`${where}: key ${key} is used twice`);
      keys.add(key);
    }
    const icon = a.icon === undefined || a.icon === null ? undefined : ICONS.find((x) => x === a.icon);
    if (a.icon !== undefined && a.icon !== null && !icon) throw new Invalid(`${where}: icon must be one of ${ICONS.join(", ")}`);
    return defined<PluginTableAction>({ label: str(a, "label", where, 100), key, icon, when: when(a, where), run: run(a.run, where) });
  });
  if (actions.length > MAX_ACTIONS) throw new Invalid(`${at}: actions has more than ${MAX_ACTIONS}`);
  return actions;
}

function table(v: unknown, what: string): PluginTable {
  const at = `${what} table`;
  if (!isObj(v)) throw new Invalid(`${at}: must be a table`);
  const columns = columnsOf(v, at);
  const by = optStr(v, "sort", at, 64);
  if (by !== undefined && !columns.some((c) => c.id === by)) throw new Invalid(`${at}: sort names no column (${by})`);
  if (v.desc !== undefined && v.desc !== null && typeof v.desc !== "boolean") throw new Invalid(`${at}: desc must be true or false`);
  return defined<PluginTable>({
    columns,
    rows: tableRows(v, "rows", at),
    sort: by === undefined ? null : { by, desc: v.desc === true },
    empty: optStr(v, "empty", at),
    open: optRun({ run: v.open }, `${at} open`).run,
    actions: tableActions(v, at),
  });
}

/** The text, facts and table a view or a Host-details section holds; `taken`, keys a graph's
 * actions use. */
function content(spec: Obj, what: string, taken: readonly string[] = []): PluginContent {
  const t = spec.table === undefined || spec.table === null ? undefined : table(spec.table, what);
  const actionKeys = [...taken, ...(t?.actions ?? []).flatMap((a) => (a.key ? [a.key] : []))];
  return defined<PluginContent>({
    actions: keyedHeadActions(spec, what, actionKeys),
    text: optStr(spec, "text", what, MAX_VIEW_TEXT),
    facts: facts(spec, what),
    table: t,
  });
}

/** `clear = true` in a view update (ticket 91). */
function clearOf(c: Obj, what: string): true | undefined {
  if (c.clear === undefined || c.clear === null || c.clear === false) return undefined;
  if (c.clear !== true) throw new Invalid(`${what}: clear must be true or false`);
  return true;
}

/** The op, checked; or why it can't be used. */
export function parseOp(raw: unknown): PluginOp | { invalid: string } {
  try {
    return parse(raw);
  } catch (e) {
    if (e instanceof Invalid || e instanceof GraphInvalid) return { invalid: e.message };
    throw e;
  }
}

function parse(raw: unknown): PluginOp {
  if (!isObj(raw) || typeof raw.op !== "string") throw new Invalid("not an op");
  const spec = isObj(raw.spec) ? raw.spec : {};
  const id = typeof raw.id === "string" ? raw.id : "";
  switch (raw.op) {
    case "command": {
      const c = raw.complete;
      if (c !== undefined && c !== null && !(isObj(c) && typeof c.handler === "number" && Number.isInteger(c.handler))) {
        throw new Invalid("roster.commands.add: complete must be a function");
      }
      return defined<Extract<PluginOp, { op: "command" }>>({
        op: "command",
        name: str(raw, "name", "roster.commands.add", 64),
        desc: str(raw, "desc", "roster.commands.add"),
        run: run(raw.run, "roster.commands.add"),
        complete: isObj(c) ? { handler: c.handler as number } : undefined,
      });
    }
    case "key": {
      const action = raw.action === false ? false : str(raw, "action", "roster.keymap.set");
      return { op: "key", context: str(raw, "context", "roster.keymap.set", 40), keys: str(raw, "keys", "roster.keymap.set", 60), action };
    }
    case "theme":
      if (!isObj(raw.theme)) throw new Invalid("roster.themes.define: the Theme must be a table");
      return { op: "theme", id, theme: raw.theme as unknown as ThemeDef };
    case "section": {
      const what = `roster.sidebar.set ${id}`;
      return defined<Extract<PluginOp, { op: "section" }>>({
        op: "section",
        id,
        title: optStr(spec, "title", what) ?? id,
        order: num(spec, "order", what) ?? 400,
        empty: optStr(spec, "empty", what),
        rows: list(spec, "rows", what).map((r, i) => row(r, i, what)),
        actions: headActions(spec, what),
        count: num(spec, "count", what),
        drop: optRun({ run: spec.drop }, `${what} drop`).run,
      });
    }
    case "status": {
      const what = `roster.status.set ${id}`;
      return defined<Extract<PluginOp, { op: "status" }>>({
        op: "status",
        id,
        text: str(spec, "text", what, 80),
        title: optStr(spec, "title", what),
        run: optRun(spec, what).run,
      });
    }
    case "finder": {
      const what = `roster.finders.set ${id}`;
      const items = spec.items;
      const section = optStr(spec, "section", what, 64);
      const title = optStr(spec, "title", what) ?? id;
      return {
        op: "finder",
        id,
        title,
        prompt: optStr(spec, "prompt", what, 64) ?? title,
        items:
          section !== undefined
            ? { section }
            : isObj(items) && typeof items.handler === "number" && Number.isInteger(items.handler)
              ? { handler: items.handler }
              : finderItems(spec, what),
      };
    }
    case "timer": {
      const ms = num(raw, "ms", "timer");
      if (ms === undefined || ms < 0) throw new Invalid("timer: ms must be a number");
      const r = run(raw.run, "timer");
      if (!("handler" in r)) throw new Invalid("timer: run must be a function");
      return { op: "timer", id, ms, every: raw.every === true, run: r };
    }
    case "help": {
      const what = `roster.help.set ${id}`;
      const title = optStr(spec, "title", what) ?? id;
      return { op: "help", id, title, summary: optStr(spec, "summary", what) ?? title, markdown: str(spec, "markdown", what, MAX_HELP) };
    }
    case "health": {
      const what = `roster.health.set ${id}`;
      return defined<Extract<PluginOp, { op: "health" }>>({
        op: "health",
        id,
        title: optStr(spec, "title", what) ?? id,
        checks: healthChecks(spec.checks, what),
        check: spec.check === undefined || spec.check === null ? undefined : run(spec.check, `${what}: check`),
      });
    }
    case "tutor": {
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
              const fields = Object.fromEntries(Object.keys(m).filter((k) => k !== "event").map((k) => [k.slice(0, 40), str(m, k, where, 200)]));
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
    }
    case "health_answer": {
      if (typeof raw.check !== "number" || !Number.isInteger(raw.check)) throw new Invalid("roster.health.answer: check must be the run's e.check");
      return { op: "health_answer", check: raw.check, checks: raw.checks };
    }
    case "badge":
      return { op: "badge", host: str(raw, "host", "roster.badges.set", 200), text: raw.text === null ? null : str(raw, "text", "roster.badges.set", 40) };
    case "float": {
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
        return defined<PluginFloatAction>({ label: str(a, "label", at, 100), key, run: run(a.run, at) });
      });
      const links = list(spec, "links", what).map((l, i): PluginLink => {
        const at = `${what} link ${i + 1}`;
        if (!isObj(l)) throw new Invalid(`${at}: must be a table`);
        return { label: str(l, "label", at, 100), url: webUrl(str(l, "url", at, MAX_URL + 1), at) };
      });
      if (actions.length > MAX_HEAD_ACTIONS) throw new Invalid(`${what}: actions has more than ${MAX_HEAD_ACTIONS}`);
      if (links.length > MAX_HEAD_ACTIONS) throw new Invalid(`${what}: links has more than ${MAX_HEAD_ACTIONS}`);
      return { op: "float", spec: { title: optStr(spec, "title", what) ?? "", lines, actions, links } };
    }
    case "view": {
      const what = `roster.views.set ${id}`;
      const place = spec.place === undefined || spec.place === null ? "panel" : spec.place;
      if (place !== "panel" && place !== "full") throw new Invalid(`${what}: place must be "panel" or "full"`);
      const graph = spec.graph === undefined || spec.graph === null ? undefined : parseGraph(spec.graph, what);
      if (graph && spec.table !== undefined && spec.table !== null) throw new Invalid(`${what}: a view has a table or a graph, not both`);
      const graphKeys = (graph?.actions ?? []).flatMap((a) => (a.key ? [a.key] : []));
      return { op: "view", id, view: { title: optStr(spec, "title", what) ?? id, place, ...content(spec, what, graphKeys), ...(graph ? { graph } : {}) } };
    }
    case "view_update": {
      const what = `roster.views.update ${id}`;
      const c = isObj(raw.changes) ? raw.changes : {};
      const columns = c.columns === undefined || c.columns === null ? undefined : columnsOf(c, what);
      const by = optStr(c, "sort", what, 64);
      if (by !== undefined && columns && !columns.some((col) => col.id === by)) throw new Invalid(`${what}: sort names no column (${by})`);
      if (c.desc !== undefined && c.desc !== null && typeof c.desc !== "boolean") throw new Invalid(`${what}: desc must be true or false`);
      return {
        op: "view_update",
        id,
        update: defined<PluginViewUpdate>({
          columns,
          sort: by === undefined ? undefined : { by, desc: c.desc === true },
          actions: c.actions === undefined || c.actions === null ? undefined : tableActions(c, what),
          title: optStr(c, "title", what),
          text: optStr(c, "text", what, MAX_VIEW_TEXT),
          facts: c.facts === undefined || c.facts === null ? undefined : facts(c, what),
          rows: tableRows(c, "rows", what),
          remove: list(c, "remove", what).map((r, i) => {
            if (typeof r !== "string") throw new Invalid(`${what}: remove ${i + 1} must be a row's id`);
            return r;
          }),
          graph: parseGraphUpdate(c, what),
          clear: clearOf(c, what),
        }),
      };
    }
    case "view_open": {
      const select = optStr(raw, "select", "roster.views.open", 200);
      return { op: "view_open", id, ...(select !== undefined ? { select } : {}) };
    }
    case "view_close":
      return { op: raw.op, id };
    case "details": {
      const host = str(raw, "host", "roster.details.set", 200);
      if (raw.spec === null || raw.spec === undefined) return { op: "details", id, host, section: null };
      const what = `roster.details.set ${id} ${host}`;
      return { op: "details", id, host, section: { title: optStr(spec, "title", what) ?? id, order: num(spec, "order", what) ?? 500, ...content(spec, what) } };
    }
    case "notify": {
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
    }
    case "open":
      return { op: "open", host: str(raw, "host", "roster.sessions.open", 200) };
    case "send": {
      const session = num(raw, "session", "roster.terminal.send");
      if (session === undefined) throw new Invalid("roster.terminal.send: which Session?");
      return { op: "send", session, text: str(raw, "text", "roster.terminal.send", 64 * 1024) };
    }
    case "copy":
      return { op: "copy", text: str(raw, "text", "roster.clipboard.copy", MAX_COPY) };
    case "confirm": {
      const what = "roster.confirm";
      const r = run(spec.run, what);
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
    }
    case "progress": {
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
    }
    case "toolbar": {
      const what = `roster.toolbar.set ${id}`;
      const icon = spec.icon === undefined || spec.icon === null ? undefined : PLUGIN_TOOLBAR_ICONS.find((i) => i === spec.icon);
      if (spec.icon !== undefined && spec.icon !== null && !icon) throw new Invalid(`${what}: icon must be one of ${PLUGIN_TOOLBAR_ICONS.join(", ")}`);
      return {
        op: "toolbar",
        id,
        control: defined<PluginToolbarControl>({ label: str(spec, "label", what, 80), text: optStr(spec, "text", what, 20), icon, run: run(spec.run, what) }),
      };
    }
    case "cmd":
      return { op: "cmd", line: str(raw, "line", "roster.cmd", MAX_TEXT), ...(raw.user === false ? { user: false as const } : {}) };
    case "echo":
      return { op: "echo", text: str(raw, "text", "roster.echo"), ...(raw.quiet === true ? { quiet: true } : {}) };
    case "cmdline":
      return { op: "cmdline", text: str(raw, "text", "roster.cmdline", MAX_TEXT) };
    case "session_show": {
      const session = num(raw, "session", "roster.sessions.show");
      if (session === undefined || !Number.isInteger(session)) throw new Invalid("roster.sessions.show: which Session?");
      return { op: "session_show", session, line: raw.line === null || raw.line === undefined ? null : str(raw, "line", "roster.sessions.show") };
    }
    case "remove": {
      const kind = REMOVABLE.find((k) => k === raw.kind);
      if (!kind) throw new Invalid("remove: of what?");
      return { op: "remove", kind, id };
    }
    default:
      throw new Invalid(`there's no op ${raw.op}`);
  }
}
