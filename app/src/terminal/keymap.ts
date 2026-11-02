// Ticket 08's keys, as one data block for the keymap (src/keymap.ts merges it in). Kept apart so
// the keyboard model (ticket 07) can take it over as it is, and the Config can override it.

/** Keys caught in a terminal before the shell sees them (Windows Terminal's defaults). */
export type TerminalAction =
  | "terminal.copy"
  /** Copy and clear the selection if there is one; else the key goes on to the shell. */
  | "terminal.copyIfSelected"
  | "terminal.paste"
  /** Paste the clipboard's text if it has some; else the key goes on to the program (Ctrl+V as
   * ^V: an app's own image paste, Vim's block selection). */
  | "terminal.pasteIfText"
  | "terminal.search"
  | "terminal.zoomIn"
  | "terminal.zoomOut"
  | "terminal.zoomReset";

/** Every terminal action, bound by default or not: what `keys.terminal` in init.lua may name. */
export const terminalActions: readonly TerminalAction[] = [
  "terminal.copy",
  "terminal.copyIfSelected",
  "terminal.paste",
  "terminal.pasteIfText",
  "terminal.search",
  "terminal.zoomIn",
  "terminal.zoomOut",
  "terminal.zoomReset",
];

export type TerminalKeysAction = TerminalAction | "session.reconnect" | "picker.chooseHere";

export const terminalKeys = {
  /** In Terminal mode: these chords never reach the shell. */
  terminal: {
    "Ctrl+Shift+c": "terminal.copy",
    // With a selection only, as Windows Terminal: without one, Ctrl+C is the shell's interrupt.
    "Ctrl+c": "terminal.copyIfSelected",
    "Ctrl+Insert": "terminal.copy",
    "Ctrl+Shift+v": "terminal.paste",
    "Shift+Insert": "terminal.paste",
    "Ctrl+Shift+f": "terminal.search",
    "Ctrl+=": "terminal.zoomIn",
    "Ctrl++": "terminal.zoomIn",
    "Ctrl+Shift++": "terminal.zoomIn",
    "Ctrl+-": "terminal.zoomOut",
    "Ctrl+0": "terminal.zoomReset",
  },
  /** In Terminal mode on Windows only, over `terminal` (decision Q138): Ctrl+V pastes text as in
   * Windows Terminal. Elsewhere terminals paste with Ctrl+Shift+V and Ctrl+V stays the
   * program's. */
  terminalWindows: { "Ctrl+v": "terminal.pasteIfText" },
  /** After the Leader: reconnect the current tab when its Session has ended (or was refused). */
  leader: { r: "session.reconnect" },
  /** In the Picker: open the Host in the current tab if its Session has ended. */
  picker: { "Ctrl+Enter": "picker.chooseHere" },
} as const satisfies Record<string, Record<string, TerminalKeysAction>>;
