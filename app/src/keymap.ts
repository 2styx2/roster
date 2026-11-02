// Keys and options as plain data tables, so the Lua Config (ADR 0004, ticket 21) can override
// them later without code changes. Chords are written as chordOf() names them: modifiers in the
// order Ctrl, Alt, Meta, Shift, then the key ("Ctrl+Space", "Ctrl+n", "j", "G", "ArrowDown").
// A sequence is chords separated by spaces ("d d", "g g").
//
// App-mode keys map to a command line from the one command table (commands/table.ts), e.g.
// "session 1" or "close", exactly what you'd type after `:`. The Picker's, the command line's
// and the terminal's own keys map to their local actions (ticket 08's copy, paste, find, zoom). Bindings live in a Registry (ADR 0006), one entry per context and key,
// each with its source; Keymap is the resolved view the app reads.

/** A line for the command table: a command name and maybe its argument ("session 1"). */
export type CommandLine = string;

export type PickerAction =
  | "picker.down"
  | "picker.up"
  | "picker.next"
  | "picker.prev"
  | "picker.choose"
  | "picker.chooseHere"
  | "picker.review"
  | "picker.info"
  | "picker.help"
  | "picker.close";

/** The command line's own keys (ticket 34): cycle through the completions, accept one, run the
 * line, cancel; and help on the command being typed (ticket 52). */
export type CmdlineAction = "cmdline.next" | "cmdline.prev" | "cmdline.accept" | "cmdline.run" | "cmdline.cancel" | "cmdline.help";

/** Anything a key can be bound to: a command line, or a Picker or terminal action. */
export type Action = string;

import { BUILTIN, CONFIG, Registry, type Entry, type Source } from "./registry";
import { terminalKeys, type TerminalAction } from "./terminal/keymap";
import type { ViewMode } from "./view/layout";

export interface Binding<T extends string = CommandLine> {
  action: T;
  source: Source;
}

/** Key (or sequence) → binding. */
export type KeyTable<T extends string = CommandLine> = Record<string, Binding<T>>;

export interface Keymap {
  /** App mode (GLOSSARY): the keys after the Leader, until Esc or a command takes you back. */
  leader: KeyTable;
  /** App mode, moving in a list (the Sidebar), always. */
  list: KeyTable;
  /** App mode, moving in a list, when vim keys are on. */
  listVim: KeyTable;
  /** In the Picker, always. */
  picker: KeyTable<PickerAction>;
  /** In the Picker's result list, when vim keys are on. */
  pickerVim: KeyTable<PickerAction>;
  /** In the command line (`␣ :`), ticket 34. */
  cmdline: KeyTable<CmdlineAction>;
  /** In a terminal, before the shell sees the key (ticket 08). */
  terminal: KeyTable<TerminalAction>;
  /** Everywhere, Terminal mode included, with no Leader (F11 for Focus, ticket 22). Keep it to
   * keys a shell has no use for. */
  global: KeyTable;
}

export type KeymapContext = keyof Keymap;

type Plain<T> = { [C in keyof T]: T[C] extends KeyTable<infer A> ? Record<string, A> : never };

/** Keymap with plain actions, no sources: how defaults are written. */
export type KeymapTables = Plain<Keymap>;

/** What the Config hands over: per context, a key → action, or null to unbind a default. */
export type KeymapOverrides = { [C in keyof KeymapTables]?: Record<string, KeymapTables[C][string] | null> };

export interface Options {
  /** The chord that takes the keyboard back from a terminal (GLOSSARY: Leader). */
  leader: string;
  /** vim keys (j/k in lists) on or off. */
  vim: boolean;
  /** The Sidebar (GLOSSARY): shown at start, and on which side. `␣ e` toggles it. */
  sidebar: { visible: boolean; side: "left" | "right" };
  /** Open Sessions listed in the Sidebar (the default) or in a basic tab strip. */
  sessions: "sidebar" | "tabs";
  /** The status bar, shown at start. `␣ s` toggles it. */
  statusBar: { visible: boolean };
  /** Lock after this many minutes without input (docs/app/security.md). */
  idleLockMinutes: number;
  /** A form pulls the infra repo (in the background) once the last pull is older (decision Q88); 0: every time. */
  pullFreshMinutes: number;
  /** The view mode at start (decision Q36): `default_mode` in init.lua. */
  defaultMode: ViewMode;
  /** Focus mode: the tmux-style session bar, off by default (decision Q36). */
  focus: { sessionbar: "top" | "bottom" | false };
}

export const defaultOptions: Options = {
  leader: "Ctrl+Space",
  vim: true,
  sidebar: { visible: true, side: "left" },
  sessions: "sidebar",
  statusBar: { visible: true },
  idleLockMinutes: 15,
  pullFreshMinutes: 5,
  defaultMode: "standard",
  focus: { sessionbar: false },
};

const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export const defaultBindings: KeymapTables = {
  leader: {
    f: "find",
    "]": "next",
    "[": "prev",
    ...Object.fromEntries(digits.map((d) => [d, `session ${d}`])),
    "d d": "close",
    e: "sidebar",
    s: "statusbar",
    ":": "cmdline",
    "?": "help",
    K: "keys",
    S: "source",
    L: "lock",
    E: "edit",
    // Host details for the selected Host (ticket 18).
    i: "details",
    // Help on what's selected (ticket 52): Neovim's K, which ␣ K (Key bindings) can't be here.
    F1: "lookup",
    "+": "host add",
    // The Live Inventory (ticket 28): on the Host or group under the cursor, or the Session's Host.
    n: "host add",
    D: "host remove",
    R: "host rename",
    M: "host move",
    N: "group new",
    c: "changes",
    r: "reconnect",
    // Fill the password prompt on screen from the vault (ticket 119): offered only at one.
    p: "fill",
    m: "mode",
    b: "finder sessions",
    // The Sidebar's tree as a finder (in Focus, where the Sidebar is hidden by default).
    t: "finder tree",
    // The panel with focus, else the one used last (ticket 95): full window and back, as tmux's
    // prefix z zooms a pane; narrower and wider, as Vim's Ctrl+W < and >.
    z: "panel",
    "<": "panel narrower",
    ">": "panel wider",
    Escape: "terminal",
  },
  list: {
    ArrowDown: "down",
    ArrowUp: "up",
    ArrowLeft: "fold",
    ArrowRight: "unfold",
    Home: "top",
    End: "bottom",
    Enter: "choose",
  },
  listVim: { j: "down", k: "up", h: "fold", l: "unfold", "g g": "top", G: "bottom" },
  picker: {
    ArrowDown: "picker.down",
    ArrowUp: "picker.up",
    "Ctrl+n": "picker.down",
    "Ctrl+p": "picker.up",
    Tab: "picker.next",
    "Shift+Tab": "picker.prev",
    Enter: "picker.choose",
    "Ctrl+r": "picker.review",
    "Ctrl+i": "picker.info",
    F1: "picker.help",
    Escape: "picker.close",
    ...terminalKeys.picker,
  },
  pickerVim: { j: "picker.down", k: "picker.up" },
  cmdline: {
    Tab: "cmdline.next",
    "Shift+Tab": "cmdline.prev",
    "Ctrl+n": "cmdline.next",
    "Ctrl+p": "cmdline.prev",
    "Ctrl+y": "cmdline.accept",
    Enter: "cmdline.run",
    Escape: "cmdline.cancel",
    // Help on the command being typed (ticket 52), as Ctrl+] follows a tag in Neovim.
    "Ctrl+]": "cmdline.help",
    F1: "cmdline.help",
  },
  terminal: terminalKeys.terminal,
  global: { F11: "focus" },
};

/** One key binding in the keymap registry. `action: null` unbinds the key (shadowing a default). */
export interface KeyBindingEntry extends Entry {
  context: KeymapContext;
  keys: string;
  action: string | null;
}

export const bindingId = (context: KeymapContext, keys: string) => `${context} ${keys}`;

export type KeymapRegistry = Registry<KeyBindingEntry>;

/** Registers a set of bindings from one source; returns a function that removes them all. */
export function registerBindings(registry: KeymapRegistry, tables: KeymapOverrides, source: Source): () => void {
  const disposers: (() => void)[] = [];
  for (const context of Object.keys(tables) as KeymapContext[]) {
    for (const [keys, action] of Object.entries(tables[context] ?? {})) {
      disposers.push(registry.register({ id: bindingId(context, keys), source, context, keys, action }));
    }
  }
  return () => disposers.forEach((d) => d());
}

/** A table's keys and actions without sources (what the terminal reads). */
export function actionsOf<T extends string>(table: KeyTable<T>): Record<string, T> {
  return Object.fromEntries(Object.entries(table).map(([k, b]) => [k, b.action]));
}

/** The resolved keymap from the registry's entries in effect. */
export function keymapOf(entries: readonly KeyBindingEntry[]): Keymap {
  const keymap: Keymap = { leader: {}, list: {}, listVim: {}, picker: {}, pickerVim: {}, cmdline: {}, terminal: {}, global: {} };
  for (const e of entries) {
    if (e.action === null) continue;
    (keymap[e.context] as KeyTable<string>)[e.keys] = { action: e.action, source: e.source };
  }
  return keymap;
}

/** A keymap registry holding the built-in bindings. */
export function builtinKeymap(): KeymapRegistry {
  const registry = new Registry<KeyBindingEntry>();
  registerBindings(registry, defaultBindings, BUILTIN);
  return registry;
}

/** The built-in bindings with the Config's layered over them (a shortcut for tests and ticket 21). */
export function resolveKeymap(overrides: KeymapOverrides = {}): Keymap {
  const registry = builtinKeymap();
  registerBindings(registry, overrides, CONFIG);
  return keymapOf(registry.list());
}

export const defaultKeymap: Keymap = resolveKeymap();

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** Part of an IME composition (IBus, Fcitx, the Windows IME). */
  isComposing?: boolean;
  /** 229 while an IME handles the key; WebKit sends the key that commits a composition after
   * compositionend, so only this says so there. */
  keyCode?: number;
  /** React's key events leave isComposing out; the DOM event under them has it. */
  nativeEvent?: { isComposing?: boolean };
}

/** The keymap name of a key event; "" (no chord, so no binding) for a key the IME is using. */
export function chordOf(e: KeyLike): string {
  if (e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229) return "";
  const key = e.key === " " ? "Space" : e.key;
  const printable = key.length === 1;
  const withMods = e.ctrlKey || e.altKey || e.metaKey;
  const mods = [
    e.ctrlKey && "Ctrl",
    e.altKey && "Alt",
    e.metaKey && "Meta",
    e.shiftKey && (withMods || !printable) && "Shift",
  ].filter(Boolean);
  const name = printable && withMods ? key.toLowerCase() : key;
  return [...mods, name].join("+");
}
