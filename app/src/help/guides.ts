// The hand-written guides, bundled from docs/ at build time. The Markdown in docs/ is the one
// copy: Vite reads it as text (`?raw`) when the app is built, so a guide in the app is always the
// docs of the commit it was built from, and there's nothing to copy by hand. options.ts reads
// config.md's option tables the same way, and options.test.ts fails CI when an option in the
// core's schema isn't in them (or one in them isn't in the schema). lint.test.ts fails CI on a
// link in any of them that goes nowhere.
import config from "../../../docs/app/config.md?raw";
import errors from "../../../docs/app/errors.md?raw";
import extending from "../../../docs/app/extending.md?raw";
import help from "../../../docs/app/help.md?raw";
import keyboard from "../../../docs/app/keyboard.md?raw";
import recipes from "../../../docs/app/recipes.md?raw";
import start from "../../../docs/app/start.md?raw";
import themes from "../../../docs/app/themes.md?raw";
import addingHosts from "../../../docs/adding-hosts.md?raw";
import cli from "../../../docs/cli-reference.md?raw";
import deprecated from "../../../docs/deprecated.md?raw";
import news from "../../../docs/news.md?raw";
import meshGuide from "../../../docs/mesh.md?raw";
import newBox from "../../../docs/new-box.md?raw";
import plugins from "../../../docs/plugins.md?raw";
import pluginApi from "../../../docs/plugin-api.md?raw";
import pluginStubs from "../../../examples/plugins/types/roster.lua?raw";
import pluginApiData from "../../../crates/roster-core/tests/fixtures/plugin-api.json";
import serveApi from "../../../docs/serve-api.md?raw";

/** Where a page sits on the index, in this order (Neovim's help.txt groups its files the same way,
 * and ends with news.txt and deprecated.txt as roster ends with What's new). */
export const PARTS = ["Getting started", "Make it yours", "Reference", "Extending", "What's new"] as const;
export type Part = (typeof PARTS)[number];

export interface Guide {
  /** The help topic, and what `[…](<file>)` links in the other guides go to. */
  id: string;
  /** From the repo's root: `docs/app/config.md`. Relative links resolve against it. */
  path: string;
  title: string;
  /** One line, for the index and the topic finder. */
  summary: string;
  part: Part;
  /** Lower comes first on the index, within its part. */
  order: number;
  /** Other names for it or a place on it (`init.lua` → `config`), as tag → topic. */
  aliases?: Record<string, string>;
  /** Each table row is a topic, `<id>#<slug of its first cell>` (deprecated.md's old names), so
   * an alias can land on the row itself. */
  rowTopics?: boolean;
  markdown: string;
}

export const guides: readonly Guide[] = [
  {
    id: "start",
    path: "docs/app/start.md",
    title: "Getting started with roster",
    summary: "New to roster? Start here: open a Host, find any command, make it yours",
    part: "Getting started",
    order: 1,
    aliases: { intro: "start", "new-to-roster": "start", "coming-from": "start#coming-from-another-tool" },
    markdown: start,
  },
  {
    id: "help",
    path: "docs/app/help.md",
    title: "Using help",
    summary: "Topics, links, back and forward, the outline, searching one page or all of them",
    part: "Getting started",
    order: 2,
    aliases: { links: "help#links", helpgrep: "help#searching-every-page", outline: "help#the-outline" },
    markdown: help,
  },
  {
    id: "new-box",
    path: "docs/new-box.md",
    title: "Set up a Box",
    summary: "Install roster on a machine, unlock the vault, run setup, and test it",
    part: "Getting started",
    order: 3,
    markdown: newBox,
  },
  {
    id: "adding-hosts",
    path: "docs/adding-hosts.md",
    title: "Add your Hosts",
    summary: "Scan a network, put its logins in the vault, fill in roster.yml, test every login",
    part: "Getting started",
    order: 4,
    markdown: addingHosts,
  },
  {
    id: "config",
    path: "docs/app/config.md",
    title: "Your init.lua",
    summary: "Where the Config lives, :config and :source, errors, the sandbox, the roster table, folders.yml",
    part: "Make it yours",
    order: 20,
    aliases: { "init.lua": "config", "folders.yml": "config#foldersyml", sandbox: "config#the-sandbox", layout: "config#layout" },
    markdown: config,
  },
  {
    id: "recipes",
    path: "docs/app/recipes.md",
    title: "Recipes",
    summary: "Short init.lua snippets to paste: the Leader, keys, Themes, fonts, layout, modules",
    part: "Make it yours",
    order: 21,
    markdown: recipes,
  },
  {
    id: "keyboard",
    path: "docs/app/keyboard.md",
    title: "Keyboard",
    summary: "The Leader, Terminal mode and App mode, the default bindings, copy and paste, completion, view modes",
    part: "Make it yours",
    order: 22,
    aliases: { "two-modes": "keyboard#two-modes" },
    markdown: keyboard,
  },
  {
    id: "themes-guide",
    path: "docs/app/themes.md",
    title: "Themes: the bundled ones and their tokens",
    summary: "The bundled Themes, their colour tokens, and making your own",
    part: "Make it yours",
    order: 23,
    markdown: themes,
  },
  {
    id: "errors-guide",
    path: "docs/app/errors.md",
    title: "Connection errors: every way a Session can fail",
    summary: "Every connection error: what happened, the cause, where it lives, the fix",
    part: "Reference",
    order: 61,
    markdown: errors,
  },
  {
    id: "cli",
    path: "docs/cli-reference.md",
    title: "The roster command",
    summary: "The CLI: roster.yml, resources, password providers, discover, every roster command",
    part: "Reference",
    order: 70,
    aliases: {
      "roster.yml": "cli#rosteryml",
      "roster check": "cli#roster-check-host",
      providers: "cli#password-providers",
      discover: "cli#discover",
      resources: "cli#resources-secrets-with-no-address",
      json: "cli#machine-readable-output",
    },
    markdown: cli,
  },
  {
    id: "mesh",
    path: "docs/mesh.md",
    title: "The Mesh: Hosts that reach each other",
    summary: "mesh: and links: in roster.yml, via: jump Hosts, seen_as: addresses, roster mesh, cut, drift in roster check, ESXi and mesh_dir:, appliances",
    part: "Reference",
    order: 72,
    aliases: {
      "mesh links": "mesh#saying-who-reaches-whom",
      "roster mesh": "mesh#roster-mesh",
      "mesh cut": "mesh#cut",
      "mesh via": "mesh#through-a-jump-host",
      mesh_dir: "mesh#esxi",
      seen_as: "mesh#other-addresses",
    },
    markdown: meshGuide,
  },
  {
    id: "serve-api",
    path: "docs/serve-api.md",
    title: "The roster serve API",
    summary: "The JSON-RPC API the app talks to roster through, and its error codes",
    part: "Reference",
    order: 71,
    aliases: { "roster serve": "serve-api" },
    markdown: serveApi,
  },
  {
    id: "extending",
    path: "docs/app/extending.md",
    title: "How far roster bends",
    summary: "The registries init.lua and Plugins add to",
    part: "Extending",
    order: 80,
    aliases: { registries: "extending#the-registries" },
    markdown: extending,
  },
  {
    id: "plugins",
    path: "docs/plugins.md",
    title: "Writing a Plugin",
    summary: "Plugins: installing and trusting one, Packages from git, permissions, the roster Lua module, events, limits",
    part: "Extending",
    order: 81,
    aliases: {
      permissions: "plugins#permissions",
      "plugin-events": "plugin-api#events",
      ":plugins": "plugins#installing-and-trusting",
      ":packages": "plugins#packages",
      "shell-integration": "plugins#shell-integration",
      "osc-133": "plugins#shell-integration",
      "shell-hooks": "plugins#shell-hooks-roster-sets-it-up",
      "shell_hooks": "plugins#shell-hooks-roster-sets-it-up",
      "osc-7": "plugins#shell-hooks-roster-sets-it-up",
    },
    markdown: plugins,
  },
  {
    id: "plugin-api",
    path: "docs/plugin-api.md",
    title: "The Plugin API",
    summary: "Every roster.* function and value, with parameters, returns, errors and an example; every type and event",
    part: "Extending",
    order: 82,
    // `:help roster.inventory.host()`, `:help roster-Host`: one topic per function, value, module
    // and type, written by the generator with the page (crates/roster-core/src/plugin/api.rs).
    aliases: { "roster-api": "plugin-api", ...pluginApiData.tags },
    markdown: pluginApi,
  },
  {
    id: "plugin-types",
    path: "examples/plugins/types/roster.lua",
    title: "roster.lua: the Plugin API's types",
    summary: "The LuaCATS annotations for lua-language-server: completion and type checks for Plugins",
    part: "Extending",
    order: 83,
    aliases: { "roster.lua": "plugin-types", luals: "plugin-types", "lua-language-server": "plugin-types" },
    markdown: `# roster.lua: the Plugin API's types\n\nThe whole [Plugin API](../../../docs/plugin-api.md) as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations. \`:plugins types PATH\` writes it as \`types/roster.lua\` in your Plugin's folder (or save it there yourself); point lua-language-server at it: [Editor support](../../../docs/plugin-api.md#editor-support). It's the copy this app was built with, so it matches this app's API.\n\n\`\`\`lua\n${pluginStubs}\n\`\`\`\n`,
  },
  {
    id: "news",
    path: "docs/news.md",
    title: "What's new",
    summary: "What changed in each Release: new, changed, removed and deprecated, by area",
    part: "What's new",
    order: 95,
    aliases: { "whats-new": "news", changelog: "news" },
    markdown: news,
  },
  {
    id: "deprecated",
    path: "docs/deprecated.md",
    title: "Deprecated names",
    summary: "Old names that still work, and what replaces each one",
    part: "What's new",
    order: 96,
    rowTopics: true,
    // Every old name lands on its row (CONTRIBUTING.md, "Docs"). The old `␣ ?` for Key bindings
    // is `deprecated#key-bindings`: `␣ ?` itself is help's key now.
    aliases: {
      ROSTER_DESK_ROSTER: "deprecated#roster_desk_roster",
      ROSTER_DESK_WSL_DISTRO: "deprecated#roster_desk_wsl_distro",
    },
    markdown: deprecated,
  },
];

export const configMarkdown = config;

/** A path from the repo's root, `.` and `..` resolved: `docs/app/../serve-api.md` → `docs/serve-api.md`. */
export function repoPath(from: string, href: string): string {
  const out = from.split("/").slice(0, -1);
  for (const seg of href.split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== "." && seg !== "") out.push(seg);
  }
  return out.join("/");
}

const FILE = /\.(md|lua|ya?ml|json|toml|sh|py|ts|tsx|rs|txt)$/;

/** Where a guide's link goes: another guide's topic (`keyboard`, `keyboard#two-modes`), a file in
 * the repo that isn't bundled (`file:examples/init.lua`), a web address as it is, or, for
 * anything else, the href itself as a help topic (`:connect`, `options`, `terminal.size`). */
export function guideLink(from: Guide, href: string): string {
  if (/^[a-z]+:/i.test(href) && !href.startsWith(":")) return href;
  if (href.startsWith("#")) return `${from.id}${href}`;
  const [file = "", anchor] = href.split("#", 2) as [string, string | undefined];
  if (!file.includes("/") && !FILE.test(file)) return href;
  const path = repoPath(from.path, file);
  // The option reference's Markdown is the `options` page, made from the same data.
  if (path === "docs/app/options.md") return "options";
  const guide = guides.find((g) => g.path === path);
  if (!guide) return `file:${path}${anchor ? `#${anchor}` : ""}`;
  return anchor ? `${guide.id}#${anchor}` : guide.id;
}
