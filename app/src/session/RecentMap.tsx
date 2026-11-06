// The idle pane's Recent Hosts as a map (Q218, Q221): with no Session open, the Hosts you opened
// last (or, the first time, the Inventory's first ones), each one click away.
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Host } from "../backend/types";
import type { Dot } from "../ui/dot";
import { StateDot } from "../ui/StateDot";

/** This Box's square, an edge to each Host's node, and the Host as a button (its name in Iosevka,
 * its address). The edges stretch with the list, so they meet each row whatever the UI size; the
 * one to the row under the pointer is drawn in the text colour. Nothing animates: this screen
 * comes back often. */
export function RecentMap({
  box,
  hosts,
  title,
  dotOf,
  open,
}: {
  box: string;
  hosts: readonly Host[];
  title: string;
  dotOf(host: Host): Dot;
  open: (name: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = hosts.length;
  return (
    <section className="recent" aria-labelledby="recent-title">
      <div className="recent-map">
        {/* Over the Hosts it titles, not over the Box. */}
        <h2 id="recent-title" className="recent-title">
          {title}
        </h2>
        <div className="recent-box" title={`This Box: ${box}`}>
          <span className="recent-box-name">{box}</span>
          <span className="box-mark" aria-hidden="true" />
        </div>
        <svg className="recent-edges" viewBox={`0 0 48 ${rows * 10}`} preserveAspectRatio="none" aria-hidden="true">
          {hosts.map((h, i) => {
            const y = i * 10 + 5;
            const mid = (rows * 10) / 2;
            return <path key={h.name} className={hover === i ? "on" : undefined} d={`M0 ${mid} C 24 ${mid}, 24 ${y}, ${EDGE_END} ${y}`} />;
          })}
        </svg>
        {/* Keys as in a list (j k, arrows) and Startify's digits: 1–9 opens that row. */}
        <ul className="recent-list" onKeyDown={(e) => mapKey(e, open, hosts)}>
          {hosts.map((h, i) => (
            <li key={h.name}>
              <button
                type="button"
                className="recent-row"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => open(h.name)}
              >
                <StateDot dot={dotOf(h)} />
                <span className="recent-name">{h.name}</span>
                <span className="recent-ip">{h.ip}</span>
                {i < 9 && (
                  // A plain digit, not a keycap (owner, after round 16): the Sidebar's Session numbers
                  // are keycaps for ␣ N, and the map's bare digit is another key.
                  <span className="recent-key key-hint" aria-hidden="true">
                    {i + 1}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The idle map's keys: j/k and the arrows move between rows, Home/End jump, a digit opens its row. */
function mapKey(e: ReactKeyboardEvent<HTMLUListElement>, open: (name: string) => void, hosts: readonly Host[]) {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".recent-row")];
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const go = (i: number) => {
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
  };
  if (e.key === "j" || e.key === "ArrowDown") go(at + 1);
  else if (e.key === "k" || e.key === "ArrowUp") go(at - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(rows.length - 1);
  else if (/^[1-9]$/.test(e.key)) {
    const host = hosts[Number(e.key) - 1];
    if (!host) return;
    e.preventDefault();
    open(host.name);
  }
}

/** Where the idle map's edges end: past the 48px edge column and the row's 10px padding, at the
 * node's left edge, so each edge meets its node (round 12: they stopped ~14px short). */
const EDGE_END = 48 + 10 + 0.75;
