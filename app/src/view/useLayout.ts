// The view mode and its layout (decision Q39): the per-mode table from init.lua (or the options),
// the Sidebar shown or hidden as the user last chose (kept in the State, issue #78, unless init.lua
// sets it), the toggles, the window's fullscreen and the hint on entering a mode.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Config } from "../config/types";
import type { Options } from "../keymap";
import { realClock, type Clock } from "../ui/clock";
import type { Platform } from "../platform/types";
import type { StateStore } from "../state/store";
import { errorText } from "../ui/format";
import { quiet, type Message } from "../ui/messages";
import { defaultLayouts, isShown, pieceToggled, togglePiece, type Layouts, type ModeLayout, type ViewMode } from "./layout";

/** How long the hint on entering a mode stays. */
const HINT_MS = 2000;

/** The State's key for the Sidebar shown or hidden, per view mode (issue #78). */
const SIDEBAR_KEY = "sidebar";

/** What the State holds for the Sidebar, per mode (untrusted: only booleans count). */
function sidebarChoices(state: Readonly<Record<string, unknown>>): Partial<Record<ViewMode, boolean>> {
  const v = state[SIDEBAR_KEY];
  if (typeof v !== "object" || v === null) return {};
  const out: Partial<Record<ViewMode, boolean>> = {};
  for (const [mode, shown] of Object.entries(v)) if (typeof shown === "boolean") out[mode as ViewMode] = shown;
  return out;
}

export interface LayoutState {
  viewMode: ViewMode;
  setViewMode(mode: ViewMode): void;
  layout: ModeLayout;
  /** Shows or hides a piece of the mode's layout (the Sidebar, the status bar), and says how to keep it. */
  toggle(id: string): void;
  /** The mode's hint is showing (HINT_MS after entering a mode that has one). */
  hint: boolean;
}

export function useLayout(opts: {
  options: Options;
  config: Config | null;
  /** init.lua's layouts, when there's a Config. */
  configLayouts: Layouts | null;
  store: StateStore;
  appState: Readonly<Record<string, unknown>>;
  platform: Platform;
  clock: Clock | undefined;
  say(m: Message): void;
}): LayoutState {
  const { options, config, configLayouts, store, appState, say } = opts;
  const [viewMode, setViewMode] = useState<ViewMode>(options.defaultMode);
  const [layouts, setLayouts] = useState<Layouts>(() => configLayouts ?? defaultLayouts(options));
  // A Config whose layouts differ replaces them (and what `␣ e` / `␣ s` toggled); one that only
  // changed a colour keeps them.
  const modesKey = config ? JSON.stringify(config.modes) : null;
  const [layoutsFrom, setLayoutsFrom] = useState(modesKey);
  if (modesKey !== layoutsFrom) {
    setLayoutsFrom(modesKey);
    if (configLayouts) setLayouts(configLayouts);
  }
  const configSetsSidebar = config?.modes[viewMode].set?.includes("sidebar") ?? false;
  const storedSidebar = sidebarChoices(appState)[viewMode] ?? null;
  const layout = useMemo(() => {
    const base = layouts[viewMode];
    if (configSetsSidebar || storedSidebar === null || isShown(base, "sidebar") === storedSidebar) return base;
    return togglePiece(base, "sidebar");
  }, [layouts, viewMode, configSetsSidebar, storedSidebar]);

  const toggle = (id: string) => {
    const next = togglePiece(layout, id);
    if (id !== "sidebar") {
      setLayouts((l) => ({ ...l, [viewMode]: togglePiece(l[viewMode], id) }));
      return say(pieceToggled(viewMode, next, id));
    }
    const shown = isShown(next, "sidebar");
    const name = `modes.${viewMode}.sidebar`;
    const said = `Sidebar ${shown ? "shown" : "hidden"}`;
    if (configSetsSidebar) {
      // init.lua sets it: this lasts until the Config is loaded again (or the app restarts).
      setLayouts((l) => ({ ...l, [viewMode]: togglePiece(l[viewMode], "sidebar") }));
      return say(quiet(said, `${said} for now: init.lua sets ${name} = ${String(!shown)}, which comes back on :source or a restart`));
    }
    store.set(SIDEBAR_KEY, { ...sidebarChoices(appState), [viewMode]: shown });
    say(quiet(said, `${said}, and kept that way. ${name} = ${String(shown)} in init.lua makes it the default`));
  };

  // The window follows the mode: OS fullscreen, or not (only when that changes).
  const { platform } = opts;
  const fullscreen = useRef(false);
  useEffect(() => {
    if (fullscreen.current === layout.fullscreen) return;
    fullscreen.current = layout.fullscreen;
    platform.setFullscreen(layout.fullscreen).catch((e: unknown) => say(quiet(`The window didn't go ${layout.fullscreen ? "fullscreen" : "back from fullscreen"}: ${errorText(e)}`)));
  }, [layout.fullscreen, platform, say]);

  const [hint, setHint] = useState(false);
  const clock = opts.clock ?? realClock;
  const showsHint = layout.hint;
  useEffect(() => {
    if (!showsHint) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- showing it is the effect
    setHint(true);
    const timer = clock.setTimeout(() => setHint(false), HINT_MS);
    return () => {
      clock.clearTimeout(timer);
      setHint(false);
    };
  }, [viewMode, showsHint, clock]);

  return { viewMode, setViewMode, layout, toggle, hint };
}
