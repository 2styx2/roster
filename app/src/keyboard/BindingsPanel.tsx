// The Key bindings panel (`␣ K`; `␣ ?` is help): the resolved keymap, grouped by area, with where each binding
// comes from (builtin, init.lua, or a Plugin), and a filter. Esc in the filter closes it.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { BUILTIN } from "../registry";
import { CloseGlyph } from "../ui/CloseGlyph";
import { PanelButton } from "../panel/PanelFrame";
import { Keys } from "../ui/Keys";
import { filterRows, type BindingRow } from "./bindings";

export interface BindingsPanelProps {
  rows: readonly BindingRow[];
  /** The Leader chord, as the ␣ key's tooltip. */
  leader: string;
  onClose(): void;
  /** F1 in the filter: help on the first binding shown's option (ticket 52). */
  onHelp?(option: string): void;
}

export function BindingsPanel({
  rows,
  leader,
  onClose,
  onHelp,
}: BindingsPanelProps) {
  const [query, setQuery] = useState("");
  // The binding the pointer is on: its init.lua name shows in the footer (owner, after round 10).
  const [pointed, setPointed] = useState<BindingRow | null>(null);
  const shown = useMemo(() => filterRows(rows, query), [rows, query]);
  const groups = useMemo(() => {
    const out = new Map<string, BindingRow[]>();
    for (const r of shown) out.set(r.area, [...(out.get(r.area) ?? []), r]);
    return [...out];
  }, [shown]);
  // Pointed at, or else the filter's first match: whose option the footer names.
  const named =
    pointed ?? (query.trim() !== "" ? (groups[0]?.[1][0] ?? null) : null);
  // More rows below: the list's last 24 px fade at the footer's edge, as the tree's do (round 20:
  // the footer sliced the last row in a short window).
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = scrollRef.current;
    if (!list) return;
    const mark = () => {
      if (list.scrollTop + list.clientHeight < list.scrollHeight - 1) list.dataset.more = "below";
      else delete list.dataset.more;
    };
    mark();
    list.addEventListener("scroll", mark, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mark);
    resize?.observe(list);
    return () => {
      list.removeEventListener("scroll", mark);
      resize?.disconnect();
    };
  }, [shown]);

  return (
    <aside className="keys-panel" aria-label="Key bindings">
      <header>
        <h2>Key bindings</h2>
        <span className="panel-head-buttons">
          <PanelButton />
          <button
            type="button"
            className="icon-button keys-close"
            aria-label="Close key bindings"
            onClick={onClose}
          >
            <CloseGlyph />
          </button>
        </span>
      </header>
      <input
        type="search"
        className="keys-filter"
        aria-label="Filter key bindings"
        placeholder="Filter…"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "F1" && onHelp) {
            e.preventDefault();
            const option = shown[0]?.options[0];
            if (option) onHelp(option);
          }
        }}
      />
      <div className="keys-scroll" ref={scrollRef}>
        <table role="table">
          {groups.map(([area, list]) => (
            <tbody key={area} role="rowgroup">
              <tr className="group" role="row">
                <th colSpan={2} scope="colgroup" role="columnheader">
                  {area}
                </th>
              </tr>
              {list.map((r) => (
                <tr
                  key={`${r.label}\0${r.source}`}
                  role="row"
                  className={named === r ? "named" : undefined}
                  onMouseEnter={() => setPointed(r)}
                  onMouseLeave={() => setPointed((p) => (p === r ? null : p))}
                >
                  <td
                    role="cell"
                    title={
                      r.source !== BUILTIN ? `${r.label} ${r.source}` : r.label
                    }
                  >
                    {r.label}
                    {/* Where it comes from, when it isn't built in, on the same line as its name
                        (a column of its own took the width every description needs); not again
                        after a Plugin's command line titled by it ("folders: folder add"). */}
                    {r.source !== BUILTIN && !r.label.startsWith(`${r.source}: `) && " "}
                    {r.source !== BUILTIN && !r.label.startsWith(`${r.source}: `) && (
                      <span className="keys-source config" title={r.source}>
                        {r.source}
                      </span>
                    )}
                  </td>
                  <td className="keys-keys" role="cell">
                    <span className="keys-list">
                      {r.keys.map((k, i) => (
                        <span key={k}>
                          {i > 0 && " "}
                          {/* The bindings themselves, not hints: shown even with ui.hints = false. */}
                          <Keys
                            keys={k}
                            leader={leader}
                            className="binding-keys"
                          />
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
        {shown.length === 0 && (
          <p className="panel-empty">No bindings match <span className="data">{query.trim()}</span>.</p>
        )}
      </div>
      {/* The pointed binding's name in init.lua (ticket 32), or how to find it, the command first
          so a short window's one-line footer cuts the words after it, never `:config` (round 20:
          ":con…" at 480 × 320). Its rows stay one line each, so nothing moves as the pointer goes
          down the list. */}
      <p
        className="panel-foot"
        title={
          named
            ? `In init.lua: ${named.options.join(" ")}${named.source !== BUILTIN ? ` · from ${named.source}` : ""}`
            : ":config opens init.lua. Point at a binding for its name there."
        }
      >
        {named ? (
          <>
            In init.lua:{" "}
            <code className="keys-option">{named.options.join(" ")}</code>
            {named.source !== BUILTIN && <> · from {named.source}</>}
          </>
        ) : (
          <>
            <code>:config</code>{" "}
            <span className="panel-foot-rest">
              opens init.lua. Point at a binding for its name there.
            </span>
          </>
        )}
      </p>
    </aside>
  );
}
