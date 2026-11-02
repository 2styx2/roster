// A table's model (ticket 76): columns, rows as plain data, sorting, updates in place and which
// rows are on screen. Pure, so DataTable.tsx stays a drawing of it and Plugins' tables (views,
// Host-details sections) and the app's own sort and update the same way.

export type ColumnKind = "text" | "data" | "number";

export interface TableColumn {
  id: string;
  label: string;
  kind: ColumnKind;
  /** In characters; shares the room with the others when left out. */
  width?: number;
}

export type Tone = "muted" | "warn" | "error";

export interface TableRow {
  id: string;
  cells: Readonly<Record<string, string | number>>;
  host?: string;
  tone?: Tone;
}

export interface Sort {
  by: string;
  desc: boolean;
}

/** Numbers inside text compare as numbers: `10.0.0.9` before `10.0.0.10`, `esx-2` before `esx-10`. */
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function compare(a: string | number, b: string | number, kind: ColumnKind): number {
  if (kind === "number") {
    const x = typeof a === "number" ? a : Number(a);
    const y = typeof b === "number" ? b : Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  }
  return collator.compare(String(a), String(b));
}

/** The rows in `sort`'s order (the given order when null). Stable; a missing value sorts last
 * whichever way. */
export function sortRows(rows: readonly TableRow[], columns: readonly TableColumn[], sort: Sort | null): readonly TableRow[] {
  const column = sort && columns.find((c) => c.id === sort.by);
  if (!sort || !column) return rows;
  const sign = sort.desc ? -1 : 1;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((p, q) => {
      const a = p.r.cells[column.id];
      const b = q.r.cells[column.id];
      const missingA = a === undefined || a === "";
      const missingB = b === undefined || b === "";
      if (missingA || missingB) return missingA === missingB ? p.i - q.i : missingA ? 1 : -1;
      return sign * compare(a, b, column.kind) || p.i - q.i;
    })
    .map((x) => x.r);
}

/** `rows` with `upserts` in: a row whose id is there already is replaced where it stands, a new
 * one goes at the end; then the ids in `remove` are taken away. */
export function mergeRows(rows: readonly TableRow[], upserts: readonly TableRow[], remove: readonly string[]): TableRow[] {
  const at = new Map(rows.map((r, i) => [r.id, i]));
  const out = [...rows];
  for (const u of upserts) {
    const i = at.get(u.id);
    if (i === undefined) {
      at.set(u.id, out.length);
      out.push(u);
    } else out[i] = u;
  }
  if (remove.length === 0) return out;
  const gone = new Set(remove);
  return out.filter((r) => !gone.has(r.id));
}

/** `s`: sort by the next column (ascending), and after the last, the given order again. */
export function nextSort(columns: readonly TableColumn[], sort: Sort | null): Sort | null {
  const i = sort ? columns.findIndex((c) => c.id === sort.by) : -1;
  const next = columns[i + 1];
  return next ? { by: next.id, desc: false } : null;
}

/** Whether an action with `when` applies to `row` (ticket 78): every cell it names holds one of
 * its values. A number and its text are the same value; a cell the row lacks matches nothing. */
export function actionApplies(when: Readonly<Record<string, readonly (string | number)[]>> | undefined, row: TableRow): boolean {
  if (!when) return true;
  return Object.entries(when).every(([k, values]) => {
    const v = row.cells[k];
    return v !== undefined && values.some((x) => String(x) === String(v));
  });
}

/** The rows that say every word of `query` somewhere in `columns`' cells, ignoring case (the
 * table's `/`, ticket 78). An empty query keeps them all. */
export function filterRows(rows: readonly TableRow[], columns: readonly TableColumn[], query: string): readonly TableRow[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((r) => {
    const text = columns.map((c) => String(r.cells[c.id] ?? "")).join("\u0000").toLocaleLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Rows drawn when the table can't be measured (hidden, or in tests). */
const UNMEASURED = 40;

/** Which rows to draw: those on screen and `overscan` more each way. */
export function windowOf(o: { count: number; rowHeight: number; scrollTop: number; height: number; overscan: number }): { start: number; end: number } {
  if (o.height <= 0) return { start: 0, end: Math.min(o.count, UNMEASURED + o.overscan) };
  const first = Math.floor(o.scrollTop / o.rowHeight);
  const shown = Math.ceil(o.height / o.rowHeight);
  return { start: Math.max(0, first - o.overscan), end: Math.min(o.count, first + shown + o.overscan) };
}

/** Shortest a column without a width gets before the table scrolls sideways (ticket 91), in ch. */
export const MIN_CH: Record<ColumnKind, number> = { text: 8, data: 10, number: 5 };

/** A data value split for middle truncation (ticket 91): the head gives way with an ellipsis and
 * the tail always shows, so `server-10-19-77-203` and `server-10-19-77-204` still differ when cut.
 * Short values aren't split. */
export function splitMiddle(text: string): [string, string] {
  const chars = [...text];
  if (chars.length <= 12) return [text, ""];
  const tail = Math.min(8, Math.ceil(chars.length / 3));
  return [chars.slice(0, -tail).join(""), chars.slice(-tail).join("")];
}
