// The Config's way into the app. Values become the app's options (deriveConfig), and keys,
// Themes and Folders go through the registries with source "init.lua" (registerConfig), the
// same registries Plugins get in ticket 23 (ADR 0006): the Config is their first user. A reload
// removes everything the last Config registered and registers the new one, so the built-ins
// come back for whatever the file no longer sets.
//
// What the core's schema can't know (whether a command exists, whether a Theme name is
// registered) is checked here and comes back as warnings with the file and line.
import type { FolderEntry } from "../folders/folders";
import { bindingId, chordOf, defaultBindings, type KeymapContext, type Options } from "../keymap";
import type { Registries } from "../registries";
import { CONFIG } from "../registry";
import { defaultTerminalOptions, standardAnsi, type TerminalOptions } from "../terminal/options";
import { terminalFontStack } from "../terminal/fonts";
import type { AppearanceOptions, Theme } from "../theme/theme";
import { layoutsOf, STATUS_SEGMENTS, type Layouts } from "../view/layout";
import type { Config, ConfigLocation, ThemeDef } from "./types";

export interface Derived {
  options: Options;
  appearance: AppearanceOptions;
  terminalOptions: TerminalOptions;
  layouts: Layouts;
}

const UI_FALLBACK = 'system-ui, "Segoe UI", sans-serif';
const MONO_FALLBACK = '"Cascadia Mono", Consolas, ui-monospace, monospace';
/** Last in the UI's stacks, so a Host named "🦊-lab" draws its fox wherever one is installed. */
const EMOJI = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji"';

/** A CSS font stack from a family name ("Iosevka"), or the stack as given if it has a comma. */
export function fontStack(font: string, fallback: string): string {
  const name = font.trim();
  if (name.includes(",")) return name;
  const rest = fallback
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.replace(/"/g, "").toLowerCase() !== name.toLowerCase());
  return [`"${name.replace(/"/g, "")}"`, ...rest].join(", ");
}

const MODIFIERS: Record<string, "Ctrl" | "Alt" | "Meta" | "Shift"> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  c: "Ctrl",
  alt: "Alt",
  a: "Alt",
  option: "Alt",
  meta: "Meta",
  cmd: "Meta",
  super: "Meta",
  win: "Meta",
  m: "Meta",
  shift: "Shift",
  s: "Shift",
};

const NAMED: Record<string, string> = {
  space: " ",
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

/** One chord as the keymap names it (chordOf), from how people write it: "ctrl+b", "C-b",
 * "Ctrl+Space", "<C-b>". */
export function normalizeChord(chord: string): string {
  const raw = chord.trim().replace(/^<(.+)>$/, "$1");
  if (raw.length <= 1) return raw === " " ? "Space" : raw;
  const parts = raw.split(/[+-](?=.)/);
  const keyPart = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => MODIFIERS[p.toLowerCase()]).filter(Boolean));
  if (parts.some((p) => !MODIFIERS[p.toLowerCase()])) return raw;
  const named = NAMED[keyPart.toLowerCase()];
  const key = named ?? (keyPart.length === 1 ? keyPart : keyPart[0]?.toUpperCase() + keyPart.slice(1));
  return chordOf({
    key,
    ctrlKey: mods.has("Ctrl"),
    altKey: mods.has("Alt"),
    metaKey: mods.has("Meta"),
    shiftKey: mods.has("Shift"),
  });
}

/** A key sequence ("g g", "ctrl+x k") with each chord normalized. */
export const normalizeKeys = (keys: string) => keys.trim().split(/\s+/).map(normalizeChord).join(" ");

/** The app's options from the Config. */
export function deriveConfig(c: Config): Derived {
  const { standard, focus } = c.modes;
  const options: Options = {
    leader: normalizeChord(c.leader),
    vim: c.vim,
    sidebar: { visible: standard.sidebar.shown, side: standard.sidebar.side },
    sessions: c.sessions,
    statusBar: { visible: standard.statusbar.shown },
    idleLockMinutes: c.idleLockMinutes,
    pullFreshMinutes: c.pullFreshMinutes,
    defaultMode: c.defaultMode,
    focus: { sessionbar: focus.sessionbar.shown ? focus.sessionbar.at : false },
  };
  const appearance: AppearanceOptions = {
    theme: c.theme,
    dark: c.darkTheme,
    light: c.lightTheme,
    fonts: {
      ui: fontStack(c.fonts.ui, `${UI_FALLBACK}, ${EMOJI}`),
      mono: fontStack(c.fonts.mono, `${MONO_FALLBACK}, ${EMOJI}`),
      size: c.fonts.uiSize,
    },
    colors: c.colors,
  };
  const t = c.terminal;
  const terminalOptions: TerminalOptions = {
    ...defaultTerminalOptions,
    fonts: t.font,
    fontFamily: terminalFontStack(t.font),
    fontSize: t.size,
    maxFontSize: Math.max(defaultTerminalOptions.maxFontSize, t.size),
    fontWeight: t.weight,
    fontWeightBold: t.boldWeight,
    lineHeight: t.lineHeight,
    cellHeight: t.cellHeight,
    renderer: t.renderer,
    cursorStyle: t.cursorStyle,
    boldIsBright: t.boldIsBright,
    scrollback: t.scrollback,
    copyOnSelect: t.copyOnSelect,
    rightClickCopyPaste: t.rightClickPaste,
    ...(Object.keys(t.colors).length > 0 ? { colors: t.colors } : {}),
  };
  return { options, appearance, terminalOptions, layouts: layoutsOf(c.modes) };
}

/** Something in the Config the app couldn't use; the rest still applies. */
export interface ConfigWarning {
  file: string;
  line: number | null;
  message: string;
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Actions each non-command context understands: its built-in ones. */
function localActions(context: KeymapContext): Set<string> | null {
  if (context === "picker" || context === "pickerVim") {
    return new Set([...Object.values(defaultBindings.picker), ...Object.values(defaultBindings.pickerVim)]);
  }
  if (context === "cmdline") return new Set(Object.values(defaultBindings.cmdline));
  if (context === "terminal") return new Set(Object.values(defaultBindings.terminal));
  return null;
}

/** A Theme from its definition (init.lua's `themes`, a Plugin's `roster.themes.define`) over `base`. */
export function themeOf(id: string, def: ThemeDef, base: Theme, source: string): Theme {
  const ansi =
    def.ansi === "standard" ? undefined : def.ansi === "inherit" ? base.ansi : { ...(base.ansi ?? standardAnsi), ...def.ansi };
  return {
    id,
    source,
    label: def.label ?? id,
    appearance: def.appearance ?? base.appearance,
    colors: { ...base.colors, ...def.colors },
    terminal: { ...base.terminal, ...def.terminal },
    ...(ansi ? { ansi } : {}),
  };
}

/** Registers the Config's keys, Themes and Folders; returns what undoes it and the warnings. */
export function registerConfig(registries: Registries, c: Config): { dispose: () => void; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const at = (path: string): ConfigLocation | undefined => c.lines[path];
  const warn = (path: string | null, message: string) => {
    const loc = path ? at(path) : undefined;
    warnings.push({ file: loc?.file ?? "init.lua", line: loc?.line ?? null, message });
  };
  const disposers: (() => void)[] = [];

  // A renamed option still works, under its new name; say which and where to read about it.
  for (const d of c.deprecated ?? []) warn(d.old, `${d.old} is deprecated: use ${d.new} (:help ${d.topic})`);

  // Themes first: the Theme options below name them.
  const defs = Object.entries(c.themes);
  const built = new Map<string, Theme>();
  const building = new Set<string>();
  const build = (id: string, def: ThemeDef): Theme => {
    const done = built.get(id);
    if (done) return done;
    building.add(id);
    const baseId = def.base ?? (def.appearance === "light" ? "roster-light" : "roster-dark");
    const ownBase = c.themes[baseId];
    let base: Theme | undefined;
    if (ownBase && baseId !== id && !building.has(baseId)) base = build(baseId, ownBase);
    else base = registries.themes.get(baseId);
    if (!base) {
      warn(`themes.${id}`, `Theme ${id}: no Theme named ${baseId} to start from; using Roster dark`);
      base = registries.themes.get("roster-dark");
    }
    const theme = themeOf(id, def, base as Theme, CONFIG);
    building.delete(id);
    built.set(id, theme);
    return theme;
  };
  for (const [id, def] of defs) disposers.push(registries.themes.register(build(id, def)));
  for (const [option, name] of [
    ["theme", c.theme],
    ["dark_theme", c.darkTheme],
    ["light_theme", c.lightTheme],
  ] as const) {
    if (option === "theme" && name === "auto") continue;
    if (!registries.themes.get(name)) {
      const known = registries.themes.list().map((t) => t.id);
      warnings.push({ file: "init.lua", line: null, message: `${option} = "${name}": no such Theme (there's ${known.join(", ")})` });
    }
  }

  // Keys.
  for (const k of c.keys) {
    const path = `keys.${snake(k.context)}.${k.keys}`;
    const keys = normalizeKeys(k.keys);
    if (k.action !== null) {
      const local = localActions(k.context);
      const known = local
        ? local.has(k.action)
        : registries.commands.get(k.action.split(/\s+/)[0] ?? "") !== undefined;
      if (!known) {
        warn(path, `key ${k.keys} (${snake(k.context)}): no action named "${k.action}"`);
        continue;
      }
    }
    disposers.push(
      registries.keymap.register({ id: bindingId(k.context, keys), source: CONFIG, context: k.context, keys, action: k.action }),
    );
  }
  const leader = normalizeChord(c.leader);
  if (!/^(Ctrl|Alt|Meta)\+|^F\d+$/.test(leader)) {
    warn(null, `leader = "${c.leader}": a Leader without Ctrl, Alt or Meta takes that key from every terminal`);
  }

  // Folders.
  for (const f of c.folders) {
    const entry: FolderEntry = { id: f.name.toLowerCase(), source: CONFIG, name: f.name, hosts: f.hosts };
    disposers.push(registries.folders.register(entry));
  }

  return { dispose: () => disposers.forEach((d) => d()), warnings };
}

/** The `modes` layouts' names the app has nothing for (a typo, most likely). Plugins' sections,
 * segments and controls count, so this waits until they've loaded (ticket 79: Plugins load after
 * the Config, and their names were warned about as unknown). */
export function layoutWarnings(registries: Registries, c: Config): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  const warn = (message: string) => warnings.push({ file: "init.lua", line: null, message });
  // Folders registers its section from App; it counts as known from the start.
  const sections = new Set(["sessions", "folders", "inventory", ...registries.sidebar.list().map((s) => s.id)]);
  const segments = [...new Set([...STATUS_SEGMENTS, ...registries.status.list().map((s) => s.id)])];
  const controls = registries.toolbar.list().map((t) => t.id);
  for (const [mode, m] of Object.entries(c.modes)) {
    for (const id of m.sidebar.sections ?? []) {
      if (!sections.has(id)) warn(`modes.${mode}.sidebar.sections: no section named "${id}" (there's ${[...sections].join(", ")})`);
    }
    for (const id of m.toolbar.controls ?? []) {
      if (!controls.includes(id)) warn(`modes.${mode}.toolbar: no control named "${id}" (there's ${controls.join(", ")})`);
    }
    for (const id of m.statusbar.segments ?? []) {
      if (!segments.includes(id)) warn(`modes.${mode}.statusbar: no segment named "${id}" (there's ${segments.join(", ")})`);
    }
  }
  return warnings;
}

/** `init.lua:12: message`. */
export const describeProblem = (p: { file: string; line: number | null; message: string }) =>
  `${p.file}${p.line === null ? "" : `:${p.line}`}: ${p.message}`;
