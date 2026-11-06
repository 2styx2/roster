// The workspace's Theme (ticket 30, decision Q69) and keycap hints: a preview in the `themes`
// finder, else the choice kept in the State while it wins (init.lua leaves the Theme to it, or
// still names the Theme it was made over), else init.lua's `theme`, else the Config's (`auto`
// follows the OS). The hints (iteration 3 feedback): init.lua's `ui.hints`, else `:hints`'s choice
// in the State, else shown.
import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Config } from "../config/types";
import type { StateStore } from "../state/store";
import { HintsChoice } from "../ui/hints";
import { chosenAppearance, stateChoiceWins, ThemeChoice } from "./picker";
import type { AppearanceOptions, Theme, ThemeRegistry } from "./theme";
import { useTheme } from "./useTheme";

export interface WorkspaceTheme {
  theme: Theme;
  themeChoice: ThemeChoice;
  /** The State's Theme while it's the one in effect, else null (for `:help`). */
  themeInEffect: string | null;
  hintsChoice: HintsChoice;
  hintsShown: boolean;
}

/** `active`: this workspace sets the document's Theme and hints (not while it's behind the demo). */
export function useWorkspaceTheme(themes: ThemeRegistry, store: StateStore, config: Config | null, appearance: AppearanceOptions, active: boolean): WorkspaceTheme {
  const [themeChoice] = useState(() => new ThemeChoice(store, themes));
  const preview = useSyncExternalStore(themeChoice.subscribe, themeChoice.previewing);
  const configTheme = config && config.theme !== "auto" ? config.theme : null;
  const configThemeAt = config?.lines.theme ?? null;
  // The State's choice (a registered Theme's id); the State re-renders the workspace when it changes.
  const stored = themeChoice.stored();
  const storedOver = themeChoice.storedOver();
  const chosen = useMemo(() => chosenAppearance(appearance, { configTheme, stored, storedOver, preview }), [appearance, configTheme, stored, storedOver, preview]);
  const theme = useTheme(themes, chosen, active);
  useLayoutEffect(() => {
    themeChoice.setConfigTheme(configTheme, configThemeAt);
    themeChoice.setActive(theme.id);
  }, [themeChoice, configTheme, configThemeAt, theme.id]);
  const [hintsChoice] = useState(() => new HintsChoice(store));
  hintsChoice.setConfig(config?.ui.hints ?? null);
  const hintsShown = hintsChoice.shown();
  useLayoutEffect(() => {
    if (active) document.documentElement.dataset.hints = hintsShown ? "on" : "off";
  }, [hintsShown, active]);
  return { theme, themeChoice, themeInEffect: stateChoiceWins({ configTheme, stored, storedOver }) ? stored : null, hintsChoice, hintsShown };
}
