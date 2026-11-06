// The Plugin API's reference (`docs/plugin-api.md`), written from plugin-api.json for `:help
// plugin-api` (T228, #438), so the help chunk carries the API once, as data, rather than as data and
// as the reference's text. It's a port of crates/roster-core/src/plugin/api/ `markdown`, the one
// that writes the committed file (which GitHub shows); pluginApiDoc.test.ts holds the two to the same
// bytes, so the app's page and the docs website stay what they were.
import type { StubsData } from "./luaStubs";

/** What pluginApiDoc reads of plugin-api.json: what the stubs read, and the reference's own text. */
export interface DocData extends Omit<StubsData, "values" | "functions" | "events" | "types"> {
  values: readonly (StubsData["values"][number] & { doc: string; since: number; example: string })[];
  functions: readonly (StubsData["functions"][number] & {
    doc: string;
    errors: readonly (readonly string[])[];
    refused: readonly string[];
    example: string;
  })[];
  events: readonly (StubsData["events"][number] & { needs: readonly string[]; when: string })[];
  types: Readonly<Record<string, StubsData["types"][string] & { doc: string }>>;
  commands: readonly { name: string; doc: string; needs_text: string }[];
  serve_results: readonly { method: string; result: string; link: string }[];
  lua_doc: string;
  errors_doc: string;
}

const COMMAND = "cargo run -p roster-core --example gen_plugin_api";
const STUBS_PATH = "examples/plugins/types/roster.lua";

/** GitHub's anchor for a heading (plugin/api `slug`). */
function slug(title: string): string {
  return [...title.toLowerCase()]
    .filter((c) => /[\p{Alphabetic}\p{N}\s_-]/u.test(c))
    .join("")
    .trim()
    .replace(/\s/gu, "-");
}

/** A type expression's pieces: text, and the names of declared types in it (plugin/api `pieces`). */
function pieces(data: DocData, ty: string): [boolean, string][] {
  const out: [boolean, string][] = [];
  const push = (isType: boolean, s: string) => {
    const last = out[out.length - 1];
    if (last && !last[0] && !isType) last[1] += s;
    else out.push([isType, s]);
  };
  const chars = [...ty];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i] as string;
    if (c === '"') {
      const start = i;
      i += 1;
      while (i < chars.length && chars[i] !== '"') i += 1;
      i += 1;
      push(false, chars.slice(start, Math.min(i, chars.length)).join(""));
    } else if (/[\p{Alphabetic}_]/u.test(c)) {
      const start = i;
      while (i < chars.length && /[\p{Alphabetic}\p{N}_]/u.test(chars[i] as string)) i += 1;
      const word = chars.slice(start, i).join("");
      push(/^\p{Lu}/u.test(word) && Object.hasOwn(data.types, word), word);
    } else {
      push(false, c);
      i += 1;
    }
  }
  return out;
}

/** A type as the docs write it: code, with each type a link to its entry (plugin/api `md_type`). */
function mdType(data: DocData, ty: string): string {
  return pieces(data, ty)
    .map(([t, s]) => (t ? `[\`${s}\`](#${slug(`\`${s}\``)})` : `\`${s}\``))
    .join("")
    .replace(/\|/g, "\\|");
}

const cell = (text: string) => text.replace(/\n/g, " ").replace(/\|/g, "\\|");
const unpipe = (text: string) => text.replace(/\\\|/g, "|");

/** The module a function is in: its parent when that's a module, else `roster` (plugin/api `module_of`). */
function moduleOf(data: DocData, path: string): string {
  const dot = path.lastIndexOf(".");
  const parent = dot < 0 ? "roster" : path.slice(0, dot);
  return data.modules.some((m) => m.name === parent) ? parent : "roster";
}

type Func = DocData["functions"][number];
const signature = (f: Func) => `${f.path}(${f.params.map((p) => p.name).join(", ")})`;

function functionEntry(data: DocData, f: Func): string {
  let s = `### \`${signature(f)}\`\n\n${f.summary}.`;
  if (f.doc) s += ` ${f.doc}`;
  s += "\n\n**Parameters**\n\n";
  if (f.params.length === 0) s += "None.\n\n";
  else {
    for (const p of f.params) {
      const ty = mdType(data, `${p.type}${p.optional ? "?" : ""}`);
      s += `- \`${p.name}\` (${unpipe(ty)}${p.optional ? ", optional" : ""}): ${p.doc}\n`;
    }
    s += "\n";
  }
  s += "**Returns**\n\n";
  s += f.returns ? `- ${unpipe(mdType(data, f.returns))}: ${f.returns_doc}\n\n` : "Nothing.\n\n";
  s += "**Errors**\n\n";
  if (f.errors.length === 0) s += "Only [those of every function](#errors).\n\n";
  else {
    for (const [message, when] of f.errors) s += `- \`${message}\`: ${when}.\n`;
    s += "- And [those of every function](#errors).\n\n";
  }
  if (f.refused.length > 0) {
    s += "**Refused by the app** (a warning notice, not an error)\n\n";
    for (const r of f.refused) s += `- ${r}.\n`;
    s += "\n";
  }
  return `${s}**Permission:** ${f.needs_text} · **Since:** api ${f.since}\n\n**Example**\n\n\`\`\`lua\n${f.example}\n\`\`\`\n\n`;
}

function typeEntry(data: DocData, name: string, t: DocData["types"][string]): string {
  let s = `### \`${name}\`\n\n${t.summary}.`;
  if (t.doc) s += `\n\n${t.doc}`;
  s += "\n\n";
  if (t.alias) return `${s}One of: ${mdType(data, t.alias).replace(/\\\|/g, " \\| ")}\n\n`;
  const fields = t.fields ?? [];
  if (fields.length === 0) return `${s}No fields.\n\n`;
  s += "| Field | Type | Required | Description |\n|---|---|---|---|\n";
  for (const fl of fields) s += `| \`${fl.name}\` | ${mdType(data, fl.type)} | ${fl.required ? "yes" : "no"} | ${cell(fl.doc)} |\n`;
  return `${s}\n`;
}

/** docs/plugin-api.md's text. */
export function pluginApiDoc(data: DocData): string {
  const types = Object.entries(data.types).sort(([, a], [, b]) => a.order - b.order);
  const functionsOf = (module: string) => data.functions.filter((f) => moduleOf(data, f.path) === module);
  let s = "# The Plugin API\n\n";
  s += `<!-- Generated from crates/roster-core/src/plugin/api/ by \`${COMMAND}\`: edit that, then run it. -->\n\n`;
  s += `Every function, value, event and data type of the \`roster\` Lua module a Plugin gets, \`roster.api_version\` ${data.api_version}. How to write, install and trust a Plugin is the guide, [Writing a Plugin](plugins.md); this is the reference. Each entry is a help topic: \`:help roster.inventory.host()\` for a function, \`:help roster-Host\` for a type.\n\n`;
  s += `Types are written as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations write them: \`string?\` may be \`nil\`, \`Host[]\` is a list of Hosts, \`table<string, Group>\` a table of Groups by name, \`"info"|"warn"\` one of those strings. The same declarations are [\`roster.lua\`](../examples/plugins/types/roster.lua), for [your editor](#editor-support).\n\n`;
  s += `## The Lua\n\n${data.lua_doc}\n\n`;
  s += "## Index\n\n| Function | What it does | Permission |\n|---|---|---|\n";
  for (const v of data.values) s += `| [\`${v.path}\`](#${slug(`\`${v.path}\``)}) | ${cell(v.summary)} | none |\n`;
  for (const m of data.modules) {
    for (const f of functionsOf(m.name)) s += `| [\`${signature(f)}\`](#${slug(signature(f))}) | ${cell(f.summary)} | ${f.needs_text} |\n`;
  }
  s += "\n| Type | What it is |\n|---|---|\n";
  for (const [name, t] of types) s += `| ${mdType(data, name)} | ${cell(t.summary)} |\n`;
  s += "\n";
  s += `## Errors\n\n${data.errors_doc}\n\n`;

  for (const m of data.modules) {
    s += `## \`${m.name}\`\n\n${m.summary}.`;
    if (m.doc) s += ` ${m.doc}`;
    s += "\n\n";
    if (m.name === "roster") {
      for (const v of data.values) {
        s += `### \`${v.path}\`\n\n${v.summary}.`;
        if (v.doc) s += ` ${v.doc}`;
        s += `\n\n**Type:** ${mdType(data, v.type)}\n\n**Permission:** none · **Since:** api ${v.since}\n\n**Example**\n\n\`\`\`lua\n${v.example}\n\`\`\`\n\n`;
      }
    }
    for (const f of functionsOf(m.name)) s += functionEntry(data, f);
  }

  s +=
    "## Events\n\n`roster.on(event, function(e) … end)` runs the function with the event's payload. Listening for an event the Plugin may not hear is an error. Each needs any one of the permissions listed.\n\n| Event | When | Payload | Needs |\n|---|---|---|---|\n";
  for (const e of data.events) {
    const needs = e.needs.length === 0 ? "nothing" : e.needs.map((p) => `\`${p}\``).join(" or ");
    s += `| \`${e.name}\` | ${cell(e.when)} | ${mdType(data, e.payload)} | ${needs} |\n`;
  }
  s += "\n";

  s +=
    "## Command lines a Plugin may run\n\n`roster.cmd(line)`, and a `run` that's a command line (a row's, a button's, a finder item's, a toolbar control's), run the Plugin's own commands and only these of roster's, each with what it needs. Anything else is refused: `roster.cmd` raises an error, and a button that would run it says why in a notice instead.\n\n| Command | What it does | Needs |\n|---|---|---|\n";
  for (const c of data.commands) s += `| \`${c.name}\` | ${cell(c.doc)} | ${c.needs_text} |\n`;
  s += "\n";

  s +=
    "## roster serve's results\n\nWhat `roster.serve.call(method)` returns, for the methods a Plugin may be granted. JSON `null` is `nil`.\n\n| Method | Result | In serve-api.md |\n|---|---|---|\n";
  for (const r of data.serve_results) {
    s += `| \`${r.method}\` | ${r.result ? mdType(data, r.result) : "see serve-api.md"} | [${r.method}](${r.link}) |\n`;
  }
  s += "\n";

  s += "## Types\n\n";
  for (const [name, t] of types) s += typeEntry(data, name, t);

  s += `## Editor support\n\n[\`${STUBS_PATH}\`](../${STUBS_PATH}) declares all of the above as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations (\`---@meta\`), so [lua-language-server](https://luals.github.io/) completes \`roster.\` and checks your types, the way Neovim's \`vim\` annotations do. \`:help plugin-types\` shows it in the app. Copy it into your Plugin's folder as \`types/roster.lua\` (or anywhere), and point lua-language-server at it with a \`.luarc.json\` next to \`init.lua\`:\n\n\`\`\`json\n{\n  "runtime.version": "Lua 5.4",\n  "workspace.library": ["types"],\n  "diagnostics.globals": ["roster"]\n}\n\`\`\`\n\nThen annotate what you hand the app, and lua-language-server checks it:\n\n\`\`\`lua\n---@type roster.Row[]\nlocal rows = {}\n\n---@param e roster.TerminalOutputEvent\nroster.on("terminal_output", function(e) … end)\n\`\`\`\n\n\`lua-language-server --check .\` does the same from a terminal or CI; roster's CI checks the example Plugins that way. The file is generated with this page: a copy from an older roster lacks what's new.\n\n`;
  s += "## See also\n\n[Writing a Plugin](plugins.md) · [The roster serve API](serve-api.md) · [Your init.lua](app/config.md) · [How far roster bends](app/extending.md)\n";
  return s;
}
