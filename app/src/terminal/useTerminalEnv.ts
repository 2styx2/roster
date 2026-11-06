// What every Session's terminal is drawn with: the Config's font and colours, the Theme, the zoom,
// the Windows build (ConPTY), the terminal's own keys, and what sits around it (a change fits it
// again and tells the Session).
import { useCallback, useEffect, useMemo, useState } from "react";
import { actionsOf, type Keymap } from "../keymap";
import type { Platform } from "../platform/types";
import { terminalTheme, type Theme } from "../theme/theme";
import { errorText } from "../ui/format";
import { quiet, type Message } from "../ui/messages";
import { placed, type ModeLayout, type ViewMode } from "../view/layout";
import { zoom, type TerminalOptions, type ZoomAction } from "./options";
import type { RendererInUse } from "./renderer";
import type { TerminalEnv } from "./TerminalView";

export interface TerminalState {
  env: TerminalEnv;
  fontSize: number;
  /** The renderer the visible terminal draws with (ticket 20): WebGL, or DOM and why. */
  renderer: RendererInUse | null;
}

export function useTerminalEnv(opts: {
  options: TerminalOptions;
  theme: Theme;
  keymap: Keymap;
  platform: Platform;
  viewMode: ViewMode;
  layout: ModeLayout;
  say(m: Message): void;
}): TerminalState {
  const { options, theme, keymap, platform, viewMode, layout, say } = opts;
  const [fontSize, setFontSize] = useState(options.fontSize);
  // A new size in the Config is a new zoom reset point, and where the font goes now.
  const [sizeFrom, setSizeFrom] = useState(options.fontSize);
  if (options.fontSize !== sizeFrom) {
    setSizeFrom(options.fontSize);
    setFontSize(options.fontSize);
  }
  const onZoom = useCallback((action: ZoomAction) => setFontSize((size) => zoom(options, size, action)), [options]);
  const [windowsBuild, setWindowsBuild] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    platform.windowsBuild().then(
      (build) => live && setWindowsBuild(build),
      (e: unknown) => live && say(quiet(`Couldn't tell which Windows build this is: ${errorText(e)}`)),
    );
    return () => {
      live = false;
    };
  }, [platform, say]);
  const [renderer, setRenderer] = useState<RendererInUse | null>(null);
  const keys = useMemo(() => actionsOf(keymap.terminal), [keymap]);
  const termTheme = useMemo(() => terminalTheme(theme, options.colors), [theme, options.colors]);
  const layoutKey = [viewMode, ...(["top", "bottom", "left", "right"] as const).map((at) => placed(layout, at).join(","))].join(" ");
  const env = useMemo<TerminalEnv>(
    () => ({
      options,
      theme: termTheme,
      fontSize,
      windowsBuild,
      keys,
      clipboard: platform.clipboard,
      onZoom,
      layout: layoutKey,
      onRenderer: setRenderer,
    }),
    [options, termTheme, fontSize, windowsBuild, keys, platform, onZoom, layoutKey],
  );
  return { env, fontSize, renderer };
}
