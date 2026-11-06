// The two focus modes (GLOSSARY, docs/app/keyboard.md) as a pure state machine over chords.
// Terminal mode: every key goes to the Session's shell, except the Leader, which enters App mode.
// Global keys (F11) are caught in either mode, with no Leader.
// App mode: the keymap applies (the Leader's table, plus list keys for the Sidebar); keys never
// reach the shell. A key's command line comes back to the caller to run; commands marked
// `staysInAppMode` (moving in a list) keep App mode; any other, and Esc, go back to the terminal.
// Overlays with their own input (the Picker, the command line, the bindings filter) handle their
// own keys; App counts them as App mode too.
import type { CommandLine, KeyTable, Keymap } from "../keymap";

export interface KeyState {
  mode: "terminal" | "app";
  /** The chords of a sequence typed so far ("d" of "d d"). */
  pending: readonly string[];
}

export const terminalMode: KeyState = { mode: "terminal", pending: [] };
const appMode: KeyState = { mode: "app", pending: [] };

export interface PressContext {
  keymap: Keymap;
  leader: string;
  vim: boolean;
  /** Whether App mode goes on after this command line (the command table says). */
  staysInAppMode(line: CommandLine): boolean;
}

export interface PressResult {
  state: KeyState;
  /** The command line the keys are bound to, for the caller to run. */
  action?: CommandLine;
  /** True when the key is the app's: the caller stops it from reaching anything else. */
  consumed: boolean;
}

/** The tables that apply in App mode, first match wins. */
export function appTables(keymap: Keymap, vim: boolean): KeyTable[] {
  return vim ? [keymap.leader, keymap.list, keymap.listVim] : [keymap.leader, keymap.list];
}

export function press(state: KeyState, chord: string, ctx: PressContext): PressResult {
  if (chord === ctx.leader) return { state: appMode, consumed: true };
  const global = state.pending.length === 0 ? ctx.keymap.global[chord] : undefined;
  if (global) {
    const next = state.mode === "app" && ctx.staysInAppMode(global.action) ? appMode : terminalMode;
    return { state: next, action: global.action, consumed: true };
  }
  if (state.mode === "terminal") return { state, consumed: false };

  const seq = [...state.pending, chord].join(" ");
  const tables = appTables(ctx.keymap, ctx.vim);
  for (const table of tables) {
    const binding = table[seq];
    if (binding) {
      const next = ctx.staysInAppMode(binding.action) ? appMode : terminalMode;
      return { state: next, action: binding.action, consumed: true };
    }
  }
  const prefix = `${seq} `;
  if (tables.some((t) => Object.keys(t).some((k) => k.startsWith(prefix)))) {
    return { state: { mode: "app", pending: [...state.pending, chord] }, consumed: true };
  }
  // Tab and Shift+Tab, when nothing binds them, move focus as everywhere else (out of the Sidebar's
  // tree to the next control), so keyboard focus is never trapped in App mode.
  if (chord === "Tab" || chord === "Shift+Tab") return { state: appMode, consumed: false };
  return { state: appMode, consumed: true };
}
