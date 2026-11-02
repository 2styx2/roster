// A table (ticket 76): what a Plugin's view or Host-details section shows as rows. Keyboard first:
// j/k and the arrows move, g g / G go to the ends, Ctrl+D/U half a page, s sorts by the next column
// and S reverses it, / filters the rows by what they say (Esc clears it, ticket 78), Enter opens
// the row, an action's key runs it on the selected row (one whose `when` the row matches). A click
// selects, a double click opens, a heading's click sorts. The selected row shows its actions as
// buttons (decision Q88: on the selected row, never on hover).
//
// It draws only the rows on screen (table.ts windowOf), so thousands of rows cost a screenful. It
// moves from a key, so nothing animates: rows changed by an update are simply there.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TableModel } from "../view/views";
import { RowActionGlyph } from "../sidebar/Sidebar";
import { countOf } from "./format";
import { Keys } from "./Keys";
import { actionApplies, filterRows, MIN_CH, nextSort, sortRows, splitMiddle, windowOf, type Sort, type TableColumn, type TableRow } from "./table";

export interface DataTableProps {
  model: TableModel;
  /** Its accessible name ("Discover"). */
  label: string;
  /** Takes focus when it first draws (a view's table). */
  autoFocus?: boolean;
  leader: string;
  /** The row selected when it first draws (a graph's list starts on the graph's node). */
  selectedId?: string | undefined;
  /** Told the selected row as it changes. */
  onSelect?(row: TableRow): void;
}

/** Rows drawn beyond the screen each way, so a quick scroll doesn't show blanks. */
const OVERSCAN = 8;
/** A row's height until one is measured. */
const ROW_GUESS = 26;

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

function cellText(row: TableRow, c: TableColumn): string {
  const v = row.cells[c.id];
  if (v === undefined) return "";
  return typeof v === "number" && c.kind === "number" ? v.toLocaleString("en-US") : String(v);
}

/** A cell's text; a data value cut in the middle when it doesn't fit (ticket 91): the head gives
 * way with an ellipsis, the tail stays. */
function CellText({ text, column }: { text: string; column: TableColumn }) {
  if (column.kind !== "data") return text;
  const [head, tail] = splitMiddle(text);
  if (!tail) return text;
  return (
    <span className="dt-mid">
      <span className="dt-mid-head">{head}</span>
      <span className="dt-mid-tail">{tail}</span>
    </span>
  );
}

const ariaSort = (c: TableColumn, sort: Sort | null) => (sort?.by !== c.id ? "none" : sort.desc ? "descending" : "ascending");

export function DataTable({ model, label, autoFocus = false, leader, selectedId, onSelect }: DataTableProps) {
  const base = useId();
  const grid = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<Sort | null>(model.sort);
  // A new sort from the Plugin (set again with another) wins over the user's.
  const [given, setGiven] = useState(model.sort);
  if (given !== model.sort && (given?.by !== model.sort?.by || given?.desc !== model.sort?.desc)) {
    setGiven(model.sort);
    setSort(model.sort);
  }
  // The `/` filter: open while its field shows; the query stays after Enter, until Esc clears it.
  const [filter, setFilter] = useState<{ open: boolean; query: string }>({ open: false, query: "" });
  const filterInput = useRef<HTMLInputElement>(null);
  const backToGrid = useRef(false);
  const sorted = useMemo(() => sortRows(model.rows, model.columns, sort), [model.rows, model.columns, sort]);
  const rows = useMemo(() => filterRows(sorted, model.columns, filter.query), [sorted, model.columns, filter.query]);
  // The selected row's id, and where it was: the selection follows its row across updates and
  // sorts, and a row taken away hands it to the one that took its place.
  const [selected, setSelected] = useState<{ id: string; at: number } | null>(() => (selectedId === undefined ? null : { id: selectedId, at: 0 }));
  let index = selected === null ? -1 : rows.findIndex((r) => r.id === selected.id);
  if (index < 0 && rows.length > 0) index = Math.min(selected?.at ?? 0, rows.length - 1);
  const current = rows[index];
  const told = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!current || told.current === current.id) return;
    told.current = current.id;
    onSelect?.(current);
  }, [current, onSelect]);

  const [view, setView] = useState({ scrollTop: 0, height: 0 });
  const [rowH, setRowH] = useState(ROW_GUESS);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const measure = () => {
      const row = el.querySelector<HTMLElement>(".dt-row");
      const h = row?.getBoundingClientRect().height ?? 0;
      if (h > 0) setRowH(h);
      setView((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A table that takes focus does so when its grid first draws, which may be after it mounted
  // (rows that came later: a plan that finished, ticket 91); then only if focus is on the view
  // around it, never taken from elsewhere.
  const hasGrid = rows.length > 0;
  const focusedOnce = useRef(false);
  useEffect(() => {
    const el = grid.current;
    if (!autoFocus || !el) return;
    const at = document.activeElement;
    if (!focusedOnce.current || at === null || at === document.body || (at !== el && at.contains(el))) el.focus();
    focusedOnce.current = true;
  }, [autoFocus, hasGrid]);
  // A row selected from the start is scrolled to, once.
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    if (scrolled.current || selectedId === undefined || index <= 0) return;
    scrolled.current = true;
    const el = grid.current;
    if (el) el.scrollTop = Math.max(0, index * rowH - el.clientHeight / 2);
  }, [selectedId, index, rowH]);
  useEffect(() => {
    if (filter.open) filterInput.current?.focus();
    else if (backToGrid.current) {
      backToGrid.current = false;
      grid.current?.focus();
    }
  }, [filter.open]);
  const closeFilter = (clear: boolean) => {
    backToGrid.current = true;
    setFilter((f) => ({ open: false, query: clear ? "" : f.query }));
  };

  const head = rowH;
  const { start, end } = windowOf({ count: rows.length, rowHeight: rowH, scrollTop: view.scrollTop, height: Math.max(0, view.height - head), overscan: OVERSCAN });

  // The rows on screen, and the selected one wherever it is: it's the grid's active descendant.
  const shown = Array.from({ length: Math.max(0, end - start) }, (_, j) => start + j);
  if (current && (index < start || index >= end)) shown.push(index);

  /** Selects row `i` and scrolls it into view. */
  const select = (i: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!row) return;
    const at = rows.indexOf(row);
    setSelected({ id: row.id, at });
    const el = grid.current;
    if (!el || el.clientHeight === 0) return;
    const top = at * rowH;
    const room = el.clientHeight - head;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + room) el.scrollTop = top + rowH - room;
  };

  const sortBy = (c: TableColumn) => setSort((s) => (s?.by === c.id ? { by: c.id, desc: !s.desc } : { by: c.id, desc: false }));
  const page = () => Math.max(1, Math.floor((view.height - head) / rowH / 2) || 10);
  const pendingG = useRef(false);

  /** What a key does here, or null when it isn't the table's. */
  const keyAction = (e: KeyboardEvent<HTMLDivElement>, g: boolean): (() => void) | null => {
    const k = e.key;
    if (e.altKey || e.metaKey) return null;
    if (e.ctrlKey) {
      if (k === "d") return () => select(index + page());
      if (k === "u") return () => select(index - page());
      return null;
    }
    switch (k) {
      case "j":
      case "ArrowDown":
        return () => select(index + 1);
      case "k":
      case "ArrowUp":
        return () => select(index - 1);
      case "PageDown":
        return () => select(index + page() * 2);
      case "PageUp":
        return () => select(index - page() * 2);
      case "G":
      case "End":
        return () => select(rows.length - 1);
      case "Home":
        return () => select(0);
      case "g":
        return () => {
          if (g) select(0);
          else pendingG.current = true;
        };
      case "s":
        return () => setSort((s) => nextSort(model.columns, s));
      case "S":
        return () => setSort((s) => (s ? { ...s, desc: !s.desc } : s));
      case "/":
        return () => setFilter((f) => ({ ...f, open: true }));
      case "Escape":
        // A filter in place: Esc clears it first; the next one is the view's.
        return filter.query ? () => setFilter({ open: false, query: "" }) : null;
      case "Enter": {
        // A key held from before (the Enter that opened the view) runs nothing.
        if (e.repeat) return () => {};
        const open = model.open;
        return current && open ? () => open(current) : null;
      }
    }
    const action = model.actions.find((a) => a.key === k);
    if (!action || !current || !actionApplies(action.when, current)) return null;
    return e.repeat ? () => {} : () => action.run(current);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const g = pendingG.current;
    pendingG.current = false;
    const act = keyAction(e, g);
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  };

  // The actions' track is as wide on every row as on the selected one, so columns never shift
  // when the buttons show: an icon is a square, a label its length.
  const actionsWidth = model.actions.map((a) => (a.icon ? "calc(var(--ui-size) * 1.35)" : `calc(${a.label.length + 2}ch)`));
  const actionsTrack = actionsWidth.length ? ` calc(${actionsWidth.join(" + ")} + ${(actionsWidth.length - 1) * 4}px)` : "";
  // A column without a width shares the room but keeps a few characters; past that the table
  // scrolls sideways (a narrow panel, ticket 91) instead of cutting columns to nothing.
  const template = model.columns.map((c) => (c.width ? `${c.width}ch` : `minmax(${MIN_CH[c.kind]}ch, 1fr)`)).join(" ") + actionsTrack;
  const minWidth = `calc(${model.columns.reduce((n, c) => n + (c.width ?? MIN_CH[c.kind]), 0)}ch${actionsTrack ? ` +${actionsTrack}` : ""} + ${model.columns.length * 12 + 24}px)`;
  const sortedBy = sort && model.columns.find((c) => c.id === sort.by);
  // What the selected row can do: an action whose `when` it doesn't match isn't offered.
  const usable = current ? model.actions.filter((a) => actionApplies(a.when, current)) : model.actions;
  const keyed = usable.filter((a) => a.key);
  const filtering = filter.open || filter.query !== "";

  return (
    <div className="data-table" style={{ "--dt-min": minWidth } as React.CSSProperties}>
      {filtering && (
        <div className="dt-filter">
          <span className="dt-filter-slash mono" aria-hidden="true">
            /
          </span>
          {filter.open ? (
            <input
              ref={filterInput}
              className="dt-filter-input mono"
              aria-label={`Filter ${label}`}
              spellCheck={false}
              autoComplete="off"
              value={filter.query}
              onChange={(e) => setFilter({ open: true, query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "ArrowDown" || (e.key === "Escape" && filter.query === "")) {
                  e.preventDefault();
                  e.stopPropagation();
                  closeFilter(e.key === "Escape");
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeFilter(true);
                }
              }}
              onBlur={() => setFilter((f) => (f.open ? { ...f, open: false } : f))}
            />
          ) : (
            <button type="button" className="dt-filter-query mono" tabIndex={-1} onMouseDown={keepFocus} onClick={() => setFilter((f) => ({ ...f, open: true }))}>
              {filter.query}
            </button>
          )}
        </div>
      )}
      {rows.length === 0 ? (
        <>
          <div className="dt-head dt-head-alone" aria-hidden="true" style={{ gridTemplateColumns: template }}>
            {model.columns.map((c) => (
              <span key={c.id} className={`dt-th kind-${c.kind}`}>
                {c.label}
              </span>
            ))}
          </div>
          <p className="panel-empty dt-empty">{filter.query && model.rows.length > 0 ? `No rows say “${filter.query}”. Esc clears the filter.` : (model.empty ?? "Nothing here.")}</p>
        </>
      ) : (
        <div
          ref={grid}
          role="grid"
          aria-label={label}
          aria-rowcount={rows.length + 1}
          aria-colcount={model.columns.length}
          aria-activedescendant={current ? `${base}-r${index}` : undefined}
          tabIndex={0}
          className="dt-grid"
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop;
            setView((v) => (v.scrollTop === top ? v : { ...v, scrollTop: top }));
          }}
        >
          <div role="row" aria-rowindex={1} className="dt-head" style={{ gridTemplateColumns: template }}>
            {model.columns.map((c) => (
              <div key={c.id} role="columnheader" aria-sort={ariaSort(c, sort)} className={`dt-th kind-${c.kind}`}>
                <button type="button" className="dt-sort" tabIndex={-1} onMouseDown={keepFocus} onClick={() => sortBy(c)}>
                  {c.label}
                  <span className="dt-arrow" aria-hidden="true">
                    {sort?.by === c.id ? (sort.desc ? "↓" : "↑") : ""}
                  </span>
                </button>
              </div>
            ))}
            {model.actions.length > 0 && <div role="columnheader" className="dt-th dt-th-actions" aria-label="Actions" />}
          </div>
          <div role="rowgroup" className="dt-body" style={{ height: rows.length * rowH }}>
            {shown.map((i) => {
              const row = rows[i] as TableRow;
              const on = i === index;
              return (
                <div
                  key={row.id}
                  id={`${base}-r${i}`}
                  role="row"
                  aria-rowindex={i + 2}
                  aria-selected={on}
                  className={`dt-row${on ? " selected" : ""}${row.tone ? ` tone-${row.tone}` : ""}`}
                  style={{ transform: `translateY(${i * rowH}px)`, gridTemplateColumns: template }}
                  onMouseDown={(e) => {
                    // A click selects and keeps the keys in the table.
                    if (!(e.target as HTMLElement).closest("button")) {
                      e.preventDefault();
                      grid.current?.focus();
                    }
                    setSelected({ id: row.id, at: i });
                  }}
                  onDoubleClick={() => model.open?.(row)}
                >
                  {model.columns.map((c, ci) => (
                    <div key={c.id} role="gridcell" className={`dt-td kind-${c.kind}`} title={cellText(row, c) || undefined} dir={c.kind === "text" ? "auto" : undefined}>
                      {ci === 0 && row.tone && row.tone !== "muted" && <span className="dt-mark" aria-label={row.tone === "warn" ? "warning" : "error"} role="img" />}
                      <CellText text={cellText(row, c)} column={c} />
                    </div>
                  ))}
                  {model.actions.length > 0 && (
                    <div role="gridcell" className="dt-actions">
                      {on &&
                        usable.map((a) => (
                          <button
                            key={a.label}
                            type="button"
                            className={a.icon ? "dt-action icon" : "dt-action"}
                            tabIndex={-1}
                            aria-label={a.label}
                            title={a.key ? `${a.label} (${a.key})` : a.label}
                            onMouseDown={keepFocus}
                            onClick={() => a.run(row)}
                          >
                            {a.icon ? <RowActionGlyph name={a.icon} /> : a.label}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="dt-foot muted key-hint">
        <span className="dt-count">
          {rows.length === model.rows.length ? countOf(rows.length, "row") : `${rows.length.toLocaleString("en-US")} of ${countOf(model.rows.length, "row")}`}
          {sortedBy ? `, by ${sortedBy.label}${sort?.desc ? " (highest first)" : ""}` : ""}
        </span>
        {rows.length > 0 && (
          <span className="dt-keys">
            {model.open && (
              <span>
                <Keys keys="Enter" leader={leader} /> open
              </span>
            )}
            {keyed.map((a) => (
              <span key={a.label}>
                <Keys keys={a.key as string} leader={leader} /> {a.label.toLowerCase()}
              </span>
            ))}
            <span>
              <Keys keys="s" leader={leader} /> sort
            </span>
            <span>
              <Keys keys="/" leader={leader} /> filter
            </span>
          </span>
        )}
      </p>
    </div>
  );
}
