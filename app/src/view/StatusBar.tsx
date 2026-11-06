// The status bar: its segments as the mode's layout picks and orders them (decision Q39), the
// hints and the mode to the right, and what Plugins are doing.
import { useSyncExternalStore, type ReactNode } from "react";
import type { BackendInfo, Inventories } from "../backend/types";
import { keyHint, type Keymap } from "../keymap";
import type { Registries } from "../registries";
import { countOf } from "../ui/format";
import { Keys } from "../ui/Keys";
import type { ModeLayout } from "./layout";
import { segmentDef, STATUS_SEGMENTS, type SegmentId } from "./segments";

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

export function StatusBar(p: StatusBarProps) {
  const { info, keymap, leader, run } = p;
  const statusDefs = useSyncExternalStore(p.registries.status.subscribe, p.registries.status.list);
  const sourceKeys = keyHint(keymap, "source");
  const hints = [
    [keyHint(keymap, "find"), "find"],
    [keyHint(keymap, "keys"), "keys"],
    [keyHint(keymap, "statusbar"), "hide this bar"],
  ].filter((h): h is [string, string] => h[0] !== null);
  // roster's own segments, each drawn here; `hosts` is the built-in hosts Plugin's (below).
  const own: Record<Exclude<SegmentId, "hosts">, (id: string) => ReactNode> = {
    backend: (id) => (
      <span key={id} className="backend" title={info.backend}>
        <span className="status-dot" aria-hidden="true" />
        <span className="statusbar-cut">{info.backend}</span>
      </span>
    ),
    box: (id) => (
      <span key={id} className="box" title={info.inventory.box}>
        <span className="box-mark" aria-hidden="true" />
        <span className="statusbar-cut">{info.inventory.box}</span>
      </span>
    ),
    // The named Inventory serve runs on (ticket 115): always in sight while there is one.
    inventory: (id) =>
      p.inventories?.name && (
        <span key={id} className="box" title={`Inventory ${p.inventories.name}: ${p.inventories.path ?? ""}`}>
          <span className="statusbar-cut">{p.inventories.name} Inventory</span>
        </span>
      ),
    path: (id) => (
      <span key={id} className="statusbar-cut path" title={`${info.inventory.path}\n${info.command.join(" ")}`}>
        {info.inventory.path}
      </span>
    ),
    // Pending changes (ticket 10): only when there are some; it opens them.
    changes: (id) =>
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
      ),
    // They drop out whole, last first, when the bar runs out of room (never cut mid-key).
    hints: (id) => (
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
    ),
    mode: (id) =>
      p.appMode && (
        <span key={id} className="mode">
          APP{p.pendingKeys.length > 0 && <span className="pending"> {p.pendingKeys.join(" ")}</span>}
        </span>
      ),
  };
  const segment = (id: string) => {
    if (Object.hasOwn(own, id)) return own[id as keyof typeof own](id);
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
      <span key={id} className={segmentDef(id)?.plugin?.className ?? "statusbar-plugin"} title={title}>
        {def.text}
      </span>
    );
  };
  const right = (id: string) => segmentDef(id)?.right === true;
  // Segments Plugins add show after the layout's own, unless the layout lists them itself.
  const segments =
    p.layout.segments ?? [...STATUS_SEGMENTS, ...statusDefs.map((d) => d.id).filter((d) => !(STATUS_SEGMENTS as readonly string[]).includes(d))];
  return (
    <footer className="statusbar">
      {segments.filter((id) => !right(id)).map(segment)}
      {p.progress}
      <span className="statusbar-right">{segments.filter(right).map(segment)}</span>
    </footer>
  );
}
