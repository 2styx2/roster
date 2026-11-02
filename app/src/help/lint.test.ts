// The docs lint (ticket 43), like Neovim's `make lintdoc`: every link in every help page goes
// somewhere, and no two topics share a name. A typo in `[x](keyboard.md#tow-modes)` fails here
// instead of shipping as plain text. tests/test_docs.py checks the Markdown in docs/ the same way
// for what GitHub shows.
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../config/fixture";
import { defaultOptions, keymapOf } from "../keymap";
import { builtinRegistries } from "../registries";
import { HelpView, registerHelp } from "./command";
import { blockLinks, slug } from "./doc";
import pluginApi from "../../../crates/roster-core/tests/fixtures/plugin-api.json";
import { findTopic, linkKind, pageBody, topicIndex, type HelpContext, helpContext } from "./pages";

/** The files a guide may link to, from the repo's root, and the Markdown among them. */
const UP = "../../../";
const FILES = new Set([
  ...Object.keys(import.meta.glob(["../../../docs/**/*", "../../../examples/**/*", "../../../plugins/**/*", "../../../*.md"])).map((k) => k.slice(UP.length)),
  // app/ itself comes back as ../../, not ../../../app/.
  ...Object.keys(import.meta.glob("../../*.md")).map((k) => `app/${k.slice("../../".length)}`),
]);
const MARKDOWN = import.meta.glob<string>(["../../../docs/**/*.md", "../../../plugins/**/*.md"], { query: "?raw", import: "default", eager: true });
const exists = (path: string) => FILES.has(path) || [...FILES].some((f) => f.startsWith(`${path}/`));

function ctxOf(): HelpContext {
  const r = builtinRegistries();
  registerHelp(r, new HelpView());
  return helpContext(r, {
    keymap: keymapOf(r.keymap.list()),
    options: defaultOptions,
    config: defaultConfig,
    configPath: null,
    state: {},
    activeTheme: "roster-dark",
  });
}

/** The anchors GitHub makes for a Markdown file's headings. */
function anchorsOf(path: string): Set<string> {
  const text = (MARKDOWN[UP + path] ?? "").replace(/```[\s\S]*?```/g, "");
  return new Set([...text.matchAll(/^#{1,6}\s+(.*?)\s*#*$/gm)].map((m) => slug(m[1] as string)));
}

describe("the docs lint", () => {
  const ctx = ctxOf();
  const { topics, clashes } = topicIndex(ctx);
  const tags = new Set(topics.map((t) => t.tag));

  it("no two topics share a name, and every alias goes to one", () => {
    expect(clashes.map((t) => `${t.tag} (on ${t.page}): ${t.label}`)).toEqual([]);
  });

  it("every link in every page goes to a topic, or to a file (and heading) that exists", () => {
    const broken: string[] = [];
    for (const pg of ctx.pages) {
      for (const href of blockLinks(pageBody(ctx, pg.id))) {
        const kind = linkKind(href);
        if (kind === "web") continue;
        if (kind === "topic") {
          if (!tags.has(href)) broken.push(`${pg.id}: ${href} isn't a topic`);
          continue;
        }
        const [file = "", anchor] = href.slice("file:".length).split("#", 2);
        if (!exists(file)) broken.push(`${pg.id}: ${file} isn't in the repo`);
        else if (anchor && file.endsWith(".md") && !anchorsOf(file).has(anchor)) broken.push(`${pg.id}: ${file} has no heading #${anchor}`);
      }
    }
    expect(broken).toEqual([]);
  });

  // Ticket 71: a block's language is what colours it (highlight.ts), so every fenced block in
  // docs/ names one: `lua`, `sh`, `yaml`, `json`, `toml`, … or `text` for output and trees.
  it("every fenced code block in docs/ names its language (or `text`)", () => {
    const untagged: string[] = [];
    for (const [key, source] of Object.entries(MARKDOWN)) {
      let open: string | null = null;
      source.split("\n").forEach((line, n) => {
        const fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
        if (!fence) return;
        if (open === null) {
          open = fence[1] as string;
          if (!fence[2]) untagged.push(`${key.slice(UP.length)}:${n + 1}`);
        } else if ((fence[1] as string).startsWith(open) && !fence[2]) open = null;
      });
    }
    expect(untagged).toEqual([]);
  });

  it("every Plugin API function, value and type is a topic of its own (ticket 70)", () => {
    const open = (tag: string) => findTopic(ctx, tag);
    expect(open("roster.inventory.host()")).toMatchObject({ page: "plugin-api", anchor: "plugin-api#rosterinventoryhostname" });
    expect(open("roster-Host")).toMatchObject({ page: "plugin-api", anchor: "plugin-api#host" });
    expect(open("roster.plugin")).toMatchObject({ page: "plugin-api", anchor: "plugin-api#rosterplugin" });
    expect(open("roster.lua")).toMatchObject({ page: "plugin-types" });
    for (const tag of Object.keys(pluginApi.tags)) expect(tags.has(tag), tag).toBe(true);
  });

  it("every page has a title and a one-line summary for the index", () => {
    for (const pg of ctx.pages) {
      expect(pg.title, pg.id).not.toBe("");
      expect(pg.summary, pg.id).not.toBe("");
    }
  });
});
