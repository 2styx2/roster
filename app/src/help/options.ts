// `:help options` (ticket 37): every init.lua option's value in effect, from the Config the core
// sent, and where that value came from (what each option does is the core's shape table, in
// config/reference.ts): the default, init.lua (the core lists what the file set, `Config.set`,
// with its line), or the State (a choice `:theme`, `:hints` or `:messages` keeps when
// init.lua leaves it to them, and `:theme`'s made over init.lua's own, decision Q69).
import type { Config, ConfigLocation } from "../config/types";

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The option's value in `config`, by its Lua name; undefined when the Config has no such name. */
export function optionValue(config: Config, name: string): unknown {
  let v: unknown = config;
  for (const seg of name.split(".")) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
    const o = v as Record<string, unknown>;
    const key = camel(seg);
    if (!(key in o)) return undefined;
    v = o[key];
  }
  return v;
}

/** Every value's Lua path in the Config (a table's values; a list is one value), apart from what
 * the core adds about the file (`lines`, `set`, `deprecated`). */
export function leafPaths(config: Config): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string[]) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) {
      for (const [k, child] of Object.entries(v)) walk(child, [...path, snake(k)]);
    } else out.push(path.join("."));
  };
  for (const [k, v] of Object.entries(config)) if (!["lines", "set", "deprecated"].includes(k)) walk(v, [snake(k)]);
  return out;
}

/** A value as init.lua would write it: `"13pt"`, `true`, `{ "a", "b" }`, `{ side = "left" }`. */
export function luaValue(v: unknown, max = 160): string {
  const write = (x: unknown): string => {
    if (x === null || x === undefined) return "unset";
    if (typeof x === "string") return JSON.stringify(x);
    if (typeof x === "number") return String(Math.round(x * 100) / 100);
    if (typeof x === "boolean") return String(x);
    if (Array.isArray(x)) return x.length ? `{ ${x.map(write).join(", ")} }` : "{}";
    const entries = Object.entries(x as Record<string, unknown>);
    if (!entries.length) return "{}";
    const key = (k: string) => (/^[A-Za-z_]\w*$/.test(k) ? snake(k) : `["${k}"]`);
    return `{ ${entries.map(([k, val]) => `${key(k)} = ${write(val)}`).join(", ")} }`;
  };
  const s = write(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** What the State holds for the options the app also lets you choose (`:theme`, `:hints`, `:messages`). */
export interface StateChoices {
  /** `:theme`'s choice when it's the one in effect: it can be over init.lua's (decision Q69). */
  theme?: string | null;
  hints?: boolean | null;
  messages?: "quiet" | "all" | null;
}

export type OptionSource =
  | { kind: "default" }
  | { kind: "init.lua"; at?: ConfigLocation }
  | { kind: "State"; value: unknown; over?: ConfigLocation };

/** Which option names a State choice stands in for, when init.lua doesn't set them. */
const STATE_KEYS: Record<string, keyof StateChoices> = { theme: "theme", "ui.hints": "hints", "ui.messages": "messages" };

export function optionSource(config: Config, name: string, state: StateChoices = {}): OptionSource {
  const set = config.set ?? [];
  const fromFile = set.some((p) => p === name || p.startsWith(`${name}.`));
  // A `:theme` choice in effect wins over init.lua's line until that value changes (Q69).
  if (name === "theme" && fromFile && typeof state.theme === "string") {
    const at = config.lines.theme;
    return at ? { kind: "State", value: state.theme, over: at } : { kind: "State", value: state.theme };
  }
  if (fromFile) {
    const at = config.lines[name];
    return at ? { kind: "init.lua", at } : { kind: "init.lua" };
  }
  const key = STATE_KEYS[name];
  const stored = key ? state[key] : undefined;
  if (stored !== undefined && stored !== null) return { kind: "State", value: stored };
  return { kind: "default" };
}
