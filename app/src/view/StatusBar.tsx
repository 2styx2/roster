// The status bar: its segments as the mode's layout picks and orders them (decision Q39), the
// hints and the mode to the right, and what Plugins are doing.
import { useSyncExternalStore, type ReactNode } from "react";
import type { BackendInfo, Inventories } from "../backend/types";
import { FitBar, NameForms } from "../ui/FitBar";
import { PathText } from "../ui/PathText";
import { keyHint, listKeyFor, type CommandLine as Line, type Keymap } from "../keymap";
import type { Registries } from "../registries";
import { countOf } from "../ui/format";
import type { Dot } from "../ui/dot";
import { Keys } from "../ui/Keys";
import { StateDot } from "../ui/StateDot";
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
  /** The vim list keys are on (`vim = true`): App mode's hints name them. */
  vim: boolean;
  /** The Session on screen, for its segment: its name, its node, and whether it's up (lit). */
  session: { label: string; dot: Dot; lit: boolean } | null;
  /** How many Sessions are open: with none, the empty state offers Find and Esc only leaves App mode. */
  sessionCount: number;
  /** The Sidebar's cursor row has a menu (a Host's) or actions: App mode's hints offer its key. */
  cursorHasMenu: boolean;
}

export function StatusBar(p: StatusBarProps) {
  const { info, keymap, leader, run } = p;
  const statusDefs = useSyncExternalStore(p.registries.status.subscribe, p.registries.status.list);
  const sourceKeys = keyHint(keymap, "source");
  // The status bar teaches the keys that work now (taste.md: keycaps are the onboarding). In
  // Terminal mode: find, help, keys and hiding the bar, after the Leader. In App mode the Leader's
  // keys aren't the ones you need: moving in the list, opening, the row's menu and going back to
  // the terminal, as the keymap binds them (vim keys when they're on). They drop out last first.
  const listKey = (action: string) => (p.vim ? listKeyFor(keymap.listVim, action) : null) ?? listKeyFor(keymap.list, action);
  const moveKeys = [listKey("down"), listKey("up")].filter((k): k is string => k !== null);
  // A hint with a command is also a button for it. With no Session open the empty state already
  // offers Find, so the bar doesn't say it a third time.
  type Hint = [string | string[], string, Line?];
  const offered: [string | string[] | null | undefined, string, Line?][] = p.appMode
    ? [
        [moveKeys, "move"],
        [listKey("choose"), "open"],
        // The menu key people know: Shift+F10 over the Menu key's name ("ContextMenu"). Offered
        // only on a row that has a menu (round 16: a heading's hint led to "no menu").
        [
          p.cursorHasMenu ? (Object.keys(keymap.list).find((k) => keymap.list[k]?.action === "menu" && k.includes("F10")) ?? listKey("menu")) : null,
          "menu",
        ],
        // With no Session there's no terminal to go back to: Esc only leaves App mode (round 18).
        [listKeyFor(keymap.leader, "terminal"), p.sessionCount > 0 ? "terminal" : "leave"],
      ]
    : [
        ...(p.sessionCount > 0 ? [[keyHint(keymap, "find"), "find", "find"] as [string | null, string, Line]] : []),
        [keyHint(keymap, "help"), "help", "help"],
        [keyHint(keymap, "keys"), "keys", "keys"],
        // Hiding the bar is in ␣ K and :help, not a hint every day (Q222).
      ];
  const hints = offered.filter((h): h is Hint => h[0] !== null && h[0] !== undefined && h[0].length > 0);
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
        {/* Cut in its middle as room runs out, then removed (FitBar): its square stays. */}
        <NameForms name={info.inventory.box} />
      </span>
    ),
    // The Session on screen, as tmux names its window: its node (as in the Sidebar) and its
    // name in Iosevka, so you know where you are with the Sidebar hidden or in Focus.
    session: (id) =>
      p.session && (
        <span key={id} className="session-seg" title={`Session ${p.session.label}`}>
          <StateDot dot={p.session.dot} lit={p.session.lit ? "current" : undefined} />
          <span className="visually-hidden">Session </span>
          <NameForms name={p.session.label} />
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
      <span key={id} className="path" title={`${info.inventory.path}\n${info.command.join(" ")}`}>
        {/* Whole folders give way for one "…/", its first folder and file name kept longest
            ("~/…/roster.yml", then "…/roster.yml"; FitBar picks the form, round 20: a folder
            cut inside read "~/ …ventory/roster.yml"). */}
        <PathText path={info.inventory.path} />
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
    // They drop out whole, last first, when the bar runs out of room (FitBar; never cut mid-key).
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
        {hints.map(([k, what, command]) => {
          const caps = (
            <>
              {(Array.isArray(k) ? k : [k]).map((one) => (
                <Keys key={one} keys={one} leader={leader} />
              ))}{" "}
              {what}
            </>
          );
          return command ? (
            <button key={what} type="button" tabIndex={-1} className="hint key-hint" onMouseDown={(e) => e.preventDefault()} onClick={() => run(command)}>
              {caps}
            </button>
          ) : (
            <span key={what} className="hint key-hint">
              {caps}
            </span>
          );
        })}
      </span>
    ),
    mode: (id) =>
      p.appMode && (
        <span key={id} className="mode">
          APP
          {p.pendingKeys.length > 0 && <span className="pending"> {p.pendingKeys.join(" ")}</span>}
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
    <FitBar className="statusbar">
      {segments.filter((id) => !right(id)).map(segment)}
      {p.progress}
      <span className="statusbar-right">{segments.filter(right).map(segment)}</span>
    </FitBar>
  );
}
