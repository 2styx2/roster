// `:help` in the workspace (ticket 37): its pages read the live registries and the Config each time
// they show; a `:help` still loading never opens over what the user went on to; and the command
// line help was opened from comes back as it was when help closes (ticket 52).
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { inLayer } from "../panel/stack";
import type { Config } from "../config/types";
import type { HealthReport } from "../health/health";
import type { Keymap, Options } from "../keymap";
import type { Registries } from "../registries";
import type { TutorEvent } from "../tutor/tutor";
import type { HelpSnapshot, HelpView } from "./command";
import { helpContext, type HelpContext } from "./pages";

export interface HelpState {
  view: HelpView;
  at: HelpSnapshot;
  ctx: HelpContext;
  /** Opens `:help TOPIC` from the command line: the line `line` (caret at `caret`) comes back when
   * help closes. */
  fromLine(line: string, caret: number, open: () => void): void;
}

export function useHelp(opts: {
  view: HelpView;
  registries: Registries;
  keymap: Keymap;
  options: Options;
  config: Config;
  configPath: string | null;
  state: HelpContext["state"];
  activeTheme: string | null;
  health: HealthReport | null;
  tutor: HelpContext["tutor"] | undefined;
  /** An overlay (a finder, the Picker, the command line) is open: a waiting `:help` won't open. */
  overlayOpen: boolean;
  tutorEvent(name: string, data: TutorEvent["data"]): void;
  reopenLine(line: string, caret: number): void;
}): HelpState {
  const { registries } = opts;
  const { view } = opts;
  const at = useSyncExternalStore(view.subscribe, view.snapshot);
  const commandList = useSyncExternalStore(registries.commands.subscribe, registries.commands.list);
  const themeList = useSyncExternalStore(registries.themes.subscribe, registries.themes.list);
  const finderList = useSyncExternalStore(registries.finders.subscribe, registries.finders.list);
  const errorRows = useSyncExternalStore(registries.errors.subscribe, registries.errors.list);
  const helpPages = useSyncExternalStore(registries.help.subscribe, registries.help.list);
  const healthSections = useSyncExternalStore(registries.health.subscribe, registries.health.list);
  const { keymap, options, config, configPath, state, activeTheme, health, tutor } = opts;
  const ctx = useMemo(
    () =>
      helpContext(
        {
          commands: { get: (id) => registries.commands.get(id), list: () => commandList },
          themes: { list: () => themeList },
          finders: { list: () => finderList },
          errors: { list: () => errorRows },
          help: { list: () => helpPages },
        },
        {
          keymap,
          options,
          config,
          configPath,
          state,
          activeTheme,
          health: { sections: healthSections, report: health },
          ...(tutor ? { tutor } : {}),
          text: view.text,
        },
      ),
    [registries, commandList, themeList, finderList, errorRows, helpPages, keymap, options, config, configPath, state, activeTheme, healthSections, health, tutor, view],
  );
  useLayoutEffect(() => view.setContext(() => ctx), [view, ctx]);

  // Nor over a finder, the picker or the command line opened meanwhile.
  const { overlayOpen } = opts;
  useEffect(() => {
    if (overlayOpen) view.cancelPending();
  }, [overlayOpen, view]);
  // Nor over where a click took you with no command or finder, a terminal say (T228, #438): the keys
  // all go through commands, which cancel it in `run`, so a click is the one way left. A click in the
  // help panel itself (its loading line) isn't moving on.
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Element && inLayer("help", e.target))) view.cancelPending();
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [view]);
  // Where help went, for `:tutor`'s steps: a page opened, Ctrl+O back, Ctrl+I forward.
  const { tutorEvent, reopenLine } = opts;
  useEffect(() => {
    const place = at.at;
    if (place && at.moved) tutorEvent(`help_${at.moved}`, { page: place.page, anchor: place.anchor ?? null });
  }, [at, tutorEvent]);

  const backToLine = useRef<{ line: string; caret: number } | null>(null);
  useEffect(
    () =>
      view.subscribe(() => {
        const back = backToLine.current;
        if (view.snapshot().at || !back) return;
        backToLine.current = null;
        // Focus goes back, when the line closes, where it was before the line first opened.
        reopenLine(back.line, back.caret);
      }),
    [view, reopenLine],
  );
  const fromLine = (line: string, caret: number, open: () => void) => {
    backToLine.current = { line, caret };
    open();
    if (!view.snapshot().at) backToLine.current = null;
  };
  return { view, at, ctx, fromLine };
}
