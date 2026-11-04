// The Plugin API's LuaCATS stubs (`examples/plugins/types/roster.lua`), written from plugin-api.json
// for `:help plugin-types` (T213, decision Q189), so the help text carries the API as data once
// rather than as data and as roster.lua. It's a port of crates/roster-core/src/plugin/api.rs
// `stubs`, the one that writes the committed file and `:plugins types`; luaStubs.test.ts holds the
// two to the same bytes.

/** What luaStubs reads of plugin-api.json. */
export interface StubsData {
  api_version: number;
  values: readonly { path: string; type: string; summary: string }[];
  modules: readonly { name: string; summary: string; doc: string }[];
  functions: readonly {
    path: string;
    params: readonly { name: string; type: string; optional: boolean; doc: string }[];
    returns: string;
    returns_doc: string;
    summary: string;
    needs_text: string;
    since: number;
  }[];
  events: readonly { name: string; payload: string }[];
  types: Readonly<
    Record<
      string,
      { summary: string; order: number; alias?: string; open?: boolean; fields?: readonly { name: string; type: string; required: boolean; doc: string }[] }
    >
  >;
}

const COMMAND = "cargo run -p roster-core --example gen_plugin_api";

/** Markdown links reduced to their text, on one line (api.rs `plain`). */
function plain(text: string): string {
  let out = "";
  let rest = text;
  for (;;) {
    const open = rest.indexOf("[");
    if (open < 0) break;
    const mid = rest.indexOf("](", open);
    if (mid < 0) break;
    const close = rest.indexOf(")", mid);
    if (close < 0) break;
    out += rest.slice(0, open) + rest.slice(open + 1, mid);
    rest = rest.slice(close + 1);
  }
  return (out + rest).replace(/\n/g, " ");
}

const commentLines = (text: string): string =>
  text
    .split("\n")
    .filter((l, i, all) => !(i === all.length - 1 && l === ""))
    .map((l) => `--- ${l.replace(/\r$/, "")}\n`)
    .join("");

/** The module a function is in: its parent when that's a module, else `roster` (api.rs `module_of`). */
function moduleOf(data: StubsData, path: string): string {
  const dot = path.lastIndexOf(".");
  const parent = dot < 0 ? "roster" : path.slice(0, dot);
  return data.modules.some((m) => m.name === parent) ? parent : "roster";
}

/** A type as the stubs write it, each declared type's name as `roster.Name` (api.rs `lua_type`). */
function luaType(data: StubsData, ty: string): string {
  return ty.replace(/"[^"]*"?|[\p{L}_][\p{L}\p{N}_]*/gu, (word) =>
    /^\p{Lu}/u.test(word) && Object.hasOwn(data.types, word) ? `roster.${word}` : word,
  );
}

/** examples/plugins/types/roster.lua's text. */
export function luaStubs(data: StubsData): string {
  let s = "---@meta roster\n";
  s += `-- roster's Plugin API, roster.api_version ${data.api_version}: LuaCATS annotations for lua-language-server.\n-- Generated from crates/roster-core/src/plugin/api.rs by \`${COMMAND}\`; don't edit.\n-- The reference: docs/plugin-api.md (\`:help plugin-api\`).\n\n`;
  const types = Object.entries(data.types).sort(([, a], [, b]) => a.order - b.order);
  for (const [name, t] of types) {
    s += commentLines(plain(t.summary));
    if (t.alias) {
      s += `---@alias roster.${name} ${luaType(data, t.alias)}\n\n`;
      continue;
    }
    s += `---@class roster.${name}\n`;
    for (const fl of t.fields ?? []) {
      const q = fl.name.startsWith("[") || fl.required ? "" : "?";
      s += `---@field ${fl.name}${q} ${luaType(data, fl.type)} ${plain(fl.doc)}\n`;
    }
    if (t.open) s += "---@field [string] any Any other key roster.yml gives it.\n";
    s += "\n";
  }
  s += "---@class roster.module\n";
  for (const v of data.values) s += `---@field ${v.path.replace(/^roster\./, "")} ${luaType(data, v.type)} ${plain(v.summary)}\n`;
  s += "roster = {}\n\n";
  for (const m of data.modules) {
    if (m.name !== "roster") {
      s += commentLines(plain(`${m.summary}. ${m.doc}`));
      s += `${m.name} = {}\n\n`;
    }
    for (const f of data.functions.filter((fn) => moduleOf(data, fn.path) === m.name)) {
      s += commentLines(plain(`${f.summary}.`));
      s += `--- Permission: ${f.needs_text.replace(/`/g, "")}. Since: api ${f.since}.\n`;
      for (const p of f.params) s += `---@param ${p.name}${p.optional ? "?" : ""} ${luaType(data, p.type)} ${plain(p.doc)}\n`;
      if (f.returns) s += `---@return ${luaType(data, f.returns)} # ${plain(f.returns_doc)}\n`;
      // Each event's own payload type, for completion inside the listener.
      if (f.path === "roster.on") for (const e of data.events) s += `---@overload fun(event: "${e.name}", listener: fun(e: ${luaType(data, e.payload)}))\n`;
      s += `function ${f.path}(${f.params.map((p) => p.name).join(", ")}) end\n\n`;
    }
  }
  return `${s}return roster\n`;
}
