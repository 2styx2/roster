// The option reference (decision Q132): every init.lua option and every name of its `roster`
// table, as the core's shape table declares them (crates/roster-core/src/config/shape, written
// out by `cargo run -p roster-core --example gen_config_options`). `:help options` shows it and
// `:options` finds an option in it, each with the value it has now and where that was set.
import data from "../../../crates/roster-core/tests/fixtures/config-options.json";
import { guides } from "../help/guides";
import { luaValue, optionSource, optionValue, type StateChoices } from "../help/options";
import type { Config } from "./types";

export interface RefRow {
  name: string;
  ty: string;
  /** Empty for a parameter. */
  default: string;
  about: string;
  names: string[];
}

export interface RefEntry {
  /** The help topic: `terminal.size`, `roster.keymap.set`, `roster.config.Theme`. */
  tag: string;
  heading: string;
  what: "option" | "function" | "value" | "type";
  /** An option's kind; empty for the rest. */
  kind: "" | "leaf" | "object" | "map" | "list";
  written: string;
  ty: string;
  default: string;
  about: string;
  takes: string;
  names: string[];
  item: string | null;
  fields: string[];
  rows: RefRow[];
  example: string;
  methods: string[];
  /** `:options` lists it: it holds a value. */
  listed: boolean;
}

export interface RefSection {
  title: string;
  intro: string;
  entries: RefEntry[];
}

export interface Reference {
  generated: string;
  neovimStyle: boolean;
  sections: RefSection[];
  /** Other names → an entry's tag (`roster.keymap.set()` → `roster.keymap.set`). */
  aliases: Record<string, string>;
}

export const reference = data as Reference;

/** The help pages roster makes itself (help/pages.ts), and every guide's name and other names:
 * an entry named like one (`keys`, the Plugin API's `roster.os`) is `'keys'`, as Neovim writes
 * options, so the page keeps its name. */
const RESERVED = new Set(
  ["index", "quickref", "commands", "keys", "options", "themes", "finders", "errors", "health", "all"]
    .concat(guides.flatMap((g) => [g.id, ...Object.keys(g.aliases ?? {})]))
    .map((t) => t.toLowerCase()),
);

/** An entry's help topic: its tag, quoted when another page has that name. */
export const optionTag = (tag: string): string => (RESERVED.has(tag.toLowerCase()) ? `'${tag}'` : tag);

/** The reference's other names (`roster.keymap.set()`) that no other page has, → their topic. */
export const referenceAliases = (): Record<string, string> =>
  Object.fromEntries(Object.entries(reference.aliases).filter(([alias]) => !RESERVED.has(alias.toLowerCase())).map(([alias, tag]) => [alias, optionTag(tag)]));

/** One option as `:options` lists it. */
export interface OptionRow {
  name: string;
  /** The value now, as init.lua writes it. */
  value: string;
  default: string;
  /** `lua/keys.lua:3`, `Config (line unknown)`, `State (:theme)` or `default`. */
  where: string;
  entry: RefEntry;
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** A mode's piece (`{ shown, side, sections }`) as init.lua writes it: `false`, `true`, a list,
 * an edge or a table. */
function piece(v: Record<string, unknown>): unknown {
  if (v.shown === false) return false;
  const rest = Object.entries(v).filter(([k, x]) => k !== "shown" && x !== null && x !== undefined);
  if (rest.length === 0) return true;
  const [only] = rest;
  if (rest.length === 1 && only && (Array.isArray(only[1]) || only[0] === "at")) return only[1];
  return Object.fromEntries(rest);
}

/** The option's value in `config`, as init.lua would write it. */
function valueOf(config: Config, name: string): unknown {
  const keys = /^keys\.(\w+)$/.exec(name);
  if (keys) {
    const context = camel(keys[1] ?? "");
    return Object.fromEntries(config.keys.filter((k) => k.context === context).map((k) => [k.keys, k.action ?? false]));
  }
  const v = optionValue(config, name);
  // The core sends the size in px ("16pt" is 21.33): say the unit, as init.lua may write it.
  if (name === "terminal.size" && typeof v === "number") return `${Math.round(v * 100) / 100}px`;
  if (/^modes\.\w+\.(sidebar|sessionbar|statusbar|toolbar)$/.test(name) && v && typeof v === "object") return piece(v as Record<string, unknown>);
  return v;
}

function whereText(config: Config, name: string, state: StateChoices): string {
  const s = optionSource(config, name, state);
  // No line: the core couldn't find it (built in a loop, a module's table under a key), and it
  // may be in a module, so say only that the Config set it.
  if (s.kind === "init.lua") return s.at ? `${s.at.file}:${s.at.line}` : "Config (line unknown)";
  if (s.kind === "State") {
    if (name === "theme") return s.over ? `State (:theme, over ${s.over.file}:${s.over.line})` : "State (:theme)";
    return name === "ui.messages" ? "State (:messages)" : "State (:hints)";
  }
  return "default";
}

/** Every option that holds a value, in the reference's order, with its value now and where it
 * was set. */
export function optionRows(config: Config, state: StateChoices = {}): OptionRow[] {
  return reference.sections
    .flatMap((s) => s.entries)
    .filter((e) => e.what === "option" && e.listed)
    .map((entry) => {
      const s = optionSource(config, entry.tag, state);
      const value = s.kind === "State" ? s.value : valueOf(config, entry.tag);
      return { name: entry.tag, value: luaValue(value), default: entry.default, where: whereText(config, entry.tag, state), entry };
    });
}
