// The Key bindings panel (`␣ K`; `␣ ?` is help): the resolved keymap, grouped by area, with where each binding
// comes from (builtin, init.lua, or a Plugin), and a filter. Esc in the filter closes it.
import { useMemo, useState } from "react";
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

export function BindingsPanel({ rows, leader, onClose, onHelp }: BindingsPanelProps) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterRows(rows, query), [rows, query]);
  const groups = useMemo(() => {
    const out = new Map<string, BindingRow[]>();
    for (const r of shown) out.set(r.area, [...(out.get(r.area) ?? []), r]);
    return [...out];
  }, [shown]);

  return (
    <aside className="keys-panel" aria-label="Key bindings">
      <header>
        <h2>Key bindings</h2>
        <span className="panel-head-buttons">
          <PanelButton />
          <button type="button" className="icon-button keys-close" aria-label="Close key bindings" onClick={onClose}>
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
      <div className="keys-scroll">
        <table>
          {groups.map(([area, list]) => (
            <tbody key={area}>
              <tr className="group">
                <th colSpan={3} scope="colgroup">
                  {area}
                </th>
              </tr>
              {list.map((r) => (
                <tr key={`${r.label}\0${r.source}`}>
                  <td>
                    {r.label}
                    {/* Its name in init.lua (ticket 32), under the label. */}
                    <code className="keys-option" title="Change it in init.lua">
                      {r.options.join(" ")}
                    </code>
                  </td>
                  <td className="keys-keys">
                    <span className="keys-list">
                      {r.keys.map((k, i) => (
                        <span key={k}>
                          {i > 0 && " "}
                          {/* The bindings themselves, not hints: shown even with ui.hints = false. */}
                          <Keys keys={k} leader={leader} className="binding-keys" />
                        </span>
                      ))}
                    </span>
                  </td>
                  {/* Where it comes from, when it isn't built in (filtering by "builtin" still works),
                      */}
                  <td className={`keys-source${r.source === BUILTIN ? "" : " config"}`}>
                    {r.source !== BUILTIN && <span title={r.source}>{r.source}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
        {shown.length === 0 && <p className="panel-empty">No bindings match “{query}”.</p>}
      </div>
      <p className="panel-foot">
        Change any of these in init.lua: the name is under each one. <code>:config</code> opens it.
      </p>
    </aside>
  );
}
