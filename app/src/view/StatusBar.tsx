// The status bar: its segments as the mode's layout picks and orders them (decision Q39), the
// hints and the mode to the right, and what Plugins are doing.
import { useSyncExternalStore, type ReactNode } from "react";
import type { BackendInfo, Inventories } from "../backend/types";
import { keyHint, type Keymap } from "../keymap";
import type { Registries } from "../registries";
import { countOf } from "../ui/format";
import { Keys } from "../ui/Keys";
import { STATUS_SEGMENTS, type ModeLayout } from "./layout";

export interface StatusBarProps {
  info: BackendInfo;
  layout: ModeLayout;
  registries: Registries;
  inventories: Inventories | null;
  pendingCount: number;
  /** Files saved and not applied yet (decision Q58). */
  stale: readonly string[];
  keymap: Keymap;
  leader: string;
  /** App mode, and the keys of a sequence typed so far. */
  appMode: boolean;
  pendingKeys: readonly string[];
  /** What Plugins are doing (their progress items). */
  progress: ReactNode;
  run(line: string): void;
}

const RIGHT = new Set(["hints", "mode"]);

export function StatusBar(p: StatusBarProps) {
  const { info, keymap, leader, run } = p;
  const statusDefs = useSyncExternalStore(p.registries.status.subscribe, p.registries.status.list);
  const sourceKeys = keyHint(keymap, "source");
  const hints = [
    [keyHint(keymap, "find"), "find"],
    [keyHint(keymap, "keys"), "keys"],
    [keyHint(keymap, "statusbar"), "hide this bar"],
  ].filter((h): h is [string, string] => h[0] !== null);
  const segment = (id: string) => {
    switch (id) {
      case "backend":
        return (
          <span key={id} className="backend" title={info.backend}>
            <span className="status-dot" aria-hidden="true" />
            <span className="statusbar-cut">{info.backend}</span>
          </span>
        );
      case "box":
        return (
          <span key={id} className="box" title={info.inventory.box}>
            <span className="box-mark" aria-hidden="true" />
            <span className="statusbar-cut">{info.inventory.box}</span>
          </span>
        );
      case "inventory":
        // The named Inventory serve runs on (ticket 115): always in sight while there is one.
        return (
          p.inventories?.name && (
            <span key={id} className="box" title={`Inventory ${p.inventories.name}: ${p.inventories.path ?? ""}`}>
              <span className="statusbar-cut">{p.inventories.name} Inventory</span>
            </span>
          )
        );
      case "path":
        return (
          <span key={id} className="statusbar-cut path" title={`${info.inventory.path}\n${info.command.join(" ")}`}>
            {info.inventory.path}
          </span>
        );
      case "changes":
        // Pending changes (ticket 10): only when there are some; it opens them.
        return (
          p.pendingCount > 0 && (
            <button
              key={id}
              type="button"
              className="statusbar-changes"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run("changes")}
              title="Show the Pending changes"
            >
              <span className="changes-dot" aria-hidden="true" />
              {countOf(p.pendingCount, "Pending change")}
            </button>
          )
        );
      case "hints":
        // They drop out whole, last first, when the bar runs out of room (never cut mid-key).
        return (
          <span key={id} className="statusbar-hints">
            {p.stale.length > 0 && (
              <span className="hint stale" title="Saved, not applied yet: auto_reload is off in init.lua">
                {p.stale.join(", ")} changed{" "}
                {sourceKeys ? (
                  <span className="key-hint">
                    <Keys keys={sourceKeys} leader={leader} /> apply
                  </span>
                ) : (
                  <>
                    <code>:source</code> applies
                  </>
                )}
              </span>
            )}
            {hints.map(([k, what]) => (
              <span key={what} className="hint key-hint">
                <Keys keys={k} leader={leader} /> {what}
              </span>
            ))}
          </span>
        );
      case "mode":
        return (
          p.appMode && (
            <span key={id} className="mode">
              APP{p.pendingKeys.length > 0 && <span className="pending"> {p.pendingKeys.join(" ")}</span>}
            </span>
          )
        );
      default: {
        // A Plugin's segment (the Host count is one: the built-in `hosts` Plugin).
        const def = statusDefs.find((d) => d.id === id);
        if (!def) return null;
        const title = def.title ?? `From ${def.source}`;
        return def.command ? (
          <button
            key={id}
            type="button"
            className="statusbar-plugin"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(def.command ?? "")}
            title={title}
          >
            {def.text}
          </button>
        ) : (
          <span key={id} className={id === "hosts" ? "count" : "statusbar-plugin"} title={title}>
            {def.text}
          </span>
        );
      }
    }
  };
  // Segments Plugins add show after the layout's own, unless the layout lists them itself.
  const segments =
    p.layout.segments ?? [...STATUS_SEGMENTS, ...statusDefs.map((d) => d.id).filter((d) => !(STATUS_SEGMENTS as readonly string[]).includes(d))];
  return (
    <footer className="statusbar">
      {segments.filter((id) => !RIGHT.has(id)).map(segment)}
      {p.progress}
      <span className="statusbar-right">{segments.filter((id) => RIGHT.has(id)).map(segment)}</span>
    </footer>
  );
}
