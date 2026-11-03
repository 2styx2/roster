// The terminal's look and behaviour as plain data, so the Config (ADR 0004, ticket 21) and
// Themes can override any of it. Its colours come from the Theme (theme/theme.ts terminalTheme),
// with `colors` from the Config over them. Decision Q37: the user's terminal config wins, so the 16 ANSI
// colours are a neutral, standard palette (Windows Terminal's default, Campbell), never tinted
// with the app's accent; remote prompts, LS_COLORS and vim schemes look as they do there.

export interface AnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalTheme extends AnsiPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  /** Scrollback search highlights. */
  searchMatch: string;
  searchActiveMatch: string;
}

export interface TerminalOptions {
  /** The Config's families, most wanted first (fonts.ts says which one is in use). */
  fonts: readonly string[];
  /** A monospace font stack: `fonts`, then fallbacks. */
  fontFamily: string;
  /** CSS px (the Config may give points); zoom moves it between minFontSize and maxFontSize,
   * and resets to this. */
  fontSize: number;
  /** Medium (500) by default; the bundled Iosevka has 400, 500 and 700. */
  fontWeight: number;
  fontWeightBold: number;
  minFontSize: number;
  maxFontSize: number;
  lineHeight: number;
  /** A multiple of the font size, as Windows Terminal's cellHeight; wins over lineHeight. */
  cellHeight: number | null;
  /** xterm's WebGL renderer (fast) or the DOM's (the browser's own text rendering). */
  renderer: "webgl" | "dom";
  cursorStyle: "block" | "bar" | "underline";
  /** Bold text in the bright ANSI colours too (Windows Terminal's intenseTextStyle "bright"). */
  boldIsBright: boolean;
  scrollback: number;
  /** Selecting text copies it. */
  copyOnSelect: boolean;
  /** Right-click copies the selection, or pastes when nothing is selected (as Windows Terminal). */
  rightClickCopyPaste: boolean;
  /** A program may set the clipboard with OSC 52 (write only; osc52.ts, decision Q149). */
  osc52: boolean;
  /** Colours set over the Theme's (the Config's `terminal.colors`). */
  colors?: Partial<TerminalTheme>;
}

/** Windows Terminal's default scheme (Campbell): the neutral standard 16 colours. */
export const standardAnsi: AnsiPalette = {
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

/** As roster-core's defaults (config/schema.rs Terminal): checked by config.test.ts. */
const DEFAULT_FONTS = ["Iosevka Nerd Font", "Iosevka Term", "Iosevka"];

export const defaultTerminalOptions: TerminalOptions = {
  fonts: DEFAULT_FONTS,
  fontFamily: terminalFontStack(DEFAULT_FONTS),
  // 13 pt (decision Q61; Windows Terminal's default is 12): 13 × 96/72.
  fontSize: (13 * 96) / 72,
  fontWeight: 500,
  fontWeightBold: 700,
  minFontSize: 6,
  maxFontSize: 72,
  lineHeight: 1,
  cellHeight: null,
  renderer: "webgl",
  cursorStyle: "block",
  boldIsBright: true,
  scrollback: 10000,
  copyOnSelect: true,
  rightClickCopyPaste: true,
  osc52: true,
};

import { terminalFontStack } from "./fonts";

export type ZoomAction = "terminal.zoomIn" | "terminal.zoomOut" | "terminal.zoomReset";

/** The font size after a zoom key. */
export function zoom(options: TerminalOptions, size: number, action: ZoomAction): number {
  // Whole px steps from wherever it is (16 pt is 21.33 px); reset goes back exactly.
  const next = action === "terminal.zoomIn" ? Math.floor(size) + 1 : action === "terminal.zoomOut" ? Math.ceil(size) - 1 : options.fontSize;
  return Math.min(options.maxFontSize, Math.max(options.minFontSize, next));
}
