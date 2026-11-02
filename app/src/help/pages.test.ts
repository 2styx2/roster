// The help pages (ticket 37): generated from the live registries, plus the guides from docs/app,
// all reachable by topic.
import { describe, expect, it } from "vitest";
import { configWith, defaultConfig } from "../config/fixture";
import { defaultOptions, keymapOf, registerBindings } from "../keymap";
import { builtinRegistries, type Registries } from "../registries";
import { CONFIG } from "../registry";
import { plain, type Block, type Def } from "./doc";
import { findTopic, helpContext, pageBody, topics, type HelpContext } from "./pages";

function ctxOf(r: Registries = builtinRegistries(), more: Partial<HelpContext> = {}): HelpContext {
  return helpContext(r, {
    keymap: keymapOf(r.keymap.list()),
    options: defaultOptions,
    config: defaultConfig,
    configPath: "/home/me/.config/roster/init.lua",
    state: {},
    activeTheme: "roster-dark",
    ...more,
  });
}

const defs = (blocks: Block[]): Def[] => blocks.flatMap((b) => (b.t === "defs" ? b.items : []));
const entry = (ctx: HelpContext, page: string, anchor: string) => defs(pageBody(ctx, page)).find((d) => d.anchor === anchor);

describe("topics", () => {
  it("are the pages, each command, option, error row and guide heading", () => {
    const tags = topics(ctxOf()).map((t) => t.tag);
    for (const tag of ["index", "commands", "keys", "options", "themes", "finders", "errors", "config", "keyboard"]) {
      expect(tags).toContain(tag);
    }
    expect(tags).toContain(":connect");
    expect(tags).toContain("terminal.size");
    expect(tags).toContain("E13");
    expect(tags).toContain("config#the-sandbox");
    expect(new Set(tags).size).toBe(tags.length);
  });

  it(":help TOPIC finds a tag exactly, an alias, or the best fuzzy match", () => {
    const ctx = ctxOf();
    expect(findTopic(ctx, "terminal.size")).toMatchObject({ page: "options", anchor: "terminal.size" });
    expect(findTopic(ctx, "Options")).toMatchObject({ page: "options" });
    expect(findTopic(ctx, "connect")).toMatchObject({ page: "commands", anchor: ":connect" });
    expect(findTopic(ctx, "init.lua")).toMatchObject({ page: "config" });
    expect(findTopic(ctx, "folders.yml")).toMatchObject({ page: "config", anchor: "config#foldersyml" });
    expect(findTopic(ctx, "sandbox")).toMatchObject({ page: "config", anchor: "config#the-sandbox" });
    expect(findTopic(ctx, "zzqxj")).toBeUndefined();
  });
});

describe("generated pages follow the registries", () => {
  it("commands: a command the Config adds shows, with its keys and source", () => {
    const r = builtinRegistries();
    r.commands.register({ id: "home", source: CONFIG, area: "Hosts", label: () => "Home box", run: () => {} });
    registerBindings(r.keymap, { leader: { h: "home" } }, CONFIG);
    const home = entry(ctxOf(r), "commands", ":home");
    expect(plain(home?.term ?? [])).toBe(":home");
    expect(home?.meta).toEqual(expect.arrayContaining([{ t: "keys", keys: "␣ h" }, { t: "text", text: "init.lua" }]));
    expect(plain(home?.body ?? [])).toBe("Home box");
  });

  it("commands: a command's doc is a paragraph of its own under the label, with its links", () => {
    const r = builtinRegistries();
    r.commands.register({
      id: "home",
      source: CONFIG,
      area: "Hosts",
      label: () => "Home box",
      doc: "Opens the **home** box; see [options](options).",
      run: () => {},
    });
    const home = entry(ctxOf(r), "commands", ":home");
    expect(plain(home?.body ?? [])).toBe("Home box");
    expect(home?.more).toEqual([
      { t: "text", text: "Opens the " },
      { t: "strong", children: [{ t: "text", text: "home" }] },
      { t: "text", text: " box; see " },
      { t: "link", href: "options", children: [{ t: "text", text: "options" }] },
      { t: "text", text: "." },
    ]);
    expect(entry(ctxOf(r), "commands", ":find")?.more).toBeUndefined();
  });

  it(":help :connect shows the command's doc paragraph", () => {
    const connect = entry(ctxOf(), "commands", ":connect");
    expect(plain(connect?.more ?? [])).toMatch(/Quick Connect/);
  });

  it("options: each option's type, default and values, with the value in effect and where it was set", () => {
    const config = configWith({
      terminal: { ...defaultConfig.terminal, size: 18.666666 },
      set: ["terminal.size"],
      lines: { "terminal.size": { file: "init.lua", line: 6 } },
    });
    const size = entry(ctxOf(builtinRegistries(), { config }), "options", "terminal.size");
    expect(plain(size?.meta ?? [])).toMatch(/number\|string.*default"13pt"now"18\.67px".*init\.lua:6/);
    expect(plain(size?.body ?? [])).toMatch(/Takes 6 to 72 px/);
    const leader = entry(ctxOf(), "options", "leader");
    expect(plain(leader?.meta ?? [])).toMatch(/"Ctrl\+Space".*default/);
    const theme = entry(ctxOf(builtinRegistries(), { state: { theme: "nord" } }), "options", "theme");
    expect(plain(theme?.meta ?? [])).toMatch(/"nord".*State/);
    const pinned = configWith({ set: ["theme"], theme: "gruvbox", lines: { theme: { file: "init.lua", line: 12 } } });
    const over = entry(ctxOf(builtinRegistries(), { config: pinned, state: { theme: "nord" } }), "options", "theme");
    expect(plain(over?.meta ?? [])).toMatch(/"nord".*State \(:theme, over init\.lua:12\)/);
  });

  it("themes: every registered Theme, the one in use marked", () => {
    const ctx = ctxOf(builtinRegistries(), { activeTheme: "nord" });
    expect(plain(entry(ctx, "themes", "themes#nord")?.meta ?? [])).toMatch(/in use/);
    expect(plain(entry(ctx, "themes", "themes#gruvbox")?.meta ?? [])).not.toMatch(/in use/);
  });

  it("keys: the resolved keymap as a table of keycaps, even a Config's", () => {
    const r = builtinRegistries();
    registerBindings(r.keymap, { leader: { t: "next" } }, CONFIG);
    const tables = pageBody(ctxOf(r), "keys").filter((b) => b.t === "table");
    const rows = tables.flatMap((t) => (t.t === "table" ? t.rows : []));
    const next = rows.find((row) => plain(row[1] ?? []) === "Next Session" && plain(row[3] ?? []) === "init.lua");
    expect(next?.[0]).toEqual([{ t: "keys", keys: "␣ t" }]);
  });

  it("a Plugin's page is a topic, and the index lists it", () => {
    const r = builtinRegistries();
    r.help.register({
      id: "ping",
      source: "ping-plugin",
      title: "Ping",
      summary: "Ping a Host",
      order: 500,
      body: () => [{ t: "p", text: [{ t: "text", text: "Pings." }] }],
    });
    const ctx = ctxOf(r);
    expect(findTopic(ctx, "ping")).toMatchObject({ page: "ping" });
    const index = JSON.stringify(pageBody(ctx, "index"));
    expect(index).toContain('"href":"ping"');
    expect(index).toContain("ping-plugin");
  });
});

describe("the guides from docs/app", () => {
  it("render config.md, with its links to other guides as help links", () => {
    const body = JSON.stringify(pageBody(ctxOf(), "config"));
    expect(body).toContain("The sandbox");
    // config.md links to themes.md: in help, that's the themes guide.
    expect(body).toContain('"href":"themes-guide"');
    // A link to a file that isn't a guide keeps where it goes, from the repo's root.
    expect(body).toContain('"href":"file:docs/app/design/terminal-vs-wt/README.md"');
  });

  it("bundle the CLI's docs too, so :help roster.yml and :help roster check find them", () => {
    const ctx = ctxOf();
    for (const id of ["cli", "new-box", "adding-hosts", "serve-api", "start", "recipes", "extending"]) {
      expect(findTopic(ctx, id), id).toMatchObject({ page: id });
    }
    expect(findTopic(ctx, "roster.yml")).toMatchObject({ page: "cli", anchor: "cli#rosteryml" });
    expect(findTopic(ctx, "roster check")).toMatchObject({ page: "cli", anchor: "cli#roster-check-host" });
    // config.md's link to serve-api.md (../serve-api.md#…) is a help link now.
    expect(JSON.stringify(pageBody(ctx, "config"))).toContain('"href":"serve-api#this-boxs-settings-vaultconfigure"');
  });

  it("leave out notes for the people building roster: tickets, decisions, ADRs, issues", () => {
    const ctx = ctxOf();
    const leftovers: string[] = [];
    const devNote = /\b(tickets? \d+|decisions? Q\d+|Q\d{2}\b|ADR \d{4}|issue #\d+)/i;
    for (const pg of ctx.pages) {
      const blocks = pageBody(ctx, pg.id).filter((b) => b.t !== "pre");
      const said = blocks.map((b) => plain(b.t === "h" || b.t === "p" || b.t === "quote" ? b.text : b.t === "list" ? b.items.flat() : b.t === "table" ? b.rows.flat(2) : b.t === "defs" ? b.items.flatMap((d) => [...d.term, ...d.body]) : []));
      leftovers.push(...said.filter((line) => devNote.test(line)).map((line) => `${pg.id}: ${line.match(devNote)?.[0]} in "${line.slice(0, 120)}"`));
    }
    expect(leftovers).toEqual([]);
  });
});

describe("finding your way, as in Neovim's help.txt", () => {
  it("the index starts with where to start and a link to try, then groups the pages", () => {
    const ctx = ctxOf();
    const index = pageBody(ctx, "index");
    const first = JSON.stringify(index[1]);
    expect(first).toContain('"href":"start"');
    expect(first).toContain('"href":"help#links"');
    expect(findTopic(ctx, "help#links")).toMatchObject({ page: "help" });
    const groups = index.filter((b) => b.t === "h" && b.level === 2).map((b) => (b.t === "h" ? plain(b.text) : ""));
    expect(groups.slice(0, 5)).toEqual(["Getting started", "Make it yours", "Reference", "Extending", "What's new"]);
  });

  it("news and deprecated are pages; an old name lands on its deprecated row", () => {
    const ctx = ctxOf();
    expect(findTopic(ctx, "news")).toMatchObject({ page: "news", kind: "page" });
    expect(findTopic(ctx, "deprecated")).toMatchObject({ page: "deprecated", kind: "page" });
    const old = findTopic(ctx, "ROSTER_DESK_ROSTER");
    expect(old).toMatchObject({ page: "deprecated", anchor: "deprecated#roster_desk_roster" });
    const table = pageBody(ctx, "deprecated").find((b) => b.t === "table" && b.anchors?.includes("deprecated#roster_desk_roster"));
    const row = table?.t === "table" ? table.rows[table.anchors?.indexOf("deprecated#roster_desk_roster") ?? -1] : undefined;
    expect(plain(row?.[1] ?? [])).toBe("ROSTER_APP_ROSTER");
    expect(findTopic(ctx, "deprecated#key-bindings")).toMatchObject({ page: "deprecated" });
  });

  it("a Plugin's page is listed under its source", () => {
    const r = builtinRegistries();
    r.help.register({ id: "ping", source: "ping-plugin", title: "Ping", summary: "Ping a Host", order: 500, body: () => [] });
    const groups = pageBody(ctxOf(r), "index").filter((b) => b.t === "h").map((b) => (b.t === "h" ? plain(b.text) : ""));
    expect(groups).toContain("From ping-plugin");
  });

  it("quickref: the common commands with the keys they have now", () => {
    const r = builtinRegistries();
    registerBindings(r.keymap, { leader: { F: "find" } }, CONFIG);
    const rows = pageBody(ctxOf(r), "quickref").flatMap((b) => (b.t === "table" ? b.rows : []));
    const find = rows.find((row) => plain(row[1] ?? []) === ":find");
    expect(find?.[0]).toEqual(expect.arrayContaining([{ t: "keys", keys: "␣ f" }, { t: "keys", keys: "␣ F" }]));
    expect(plain(find?.[2] ?? [])).toBe("Find a Host");
  });

  it("all: every command, option and error, each a link", () => {
    const ctx = ctxOf();
    const body = JSON.stringify(pageBody(ctx, "all"));
    for (const tag of [":connect", ":find", "terminal.size", "leader", "'keys'", "E13", "start", "quickref"]) {
      expect(body, tag).toContain(`"href":"${tag}"`);
    }
    // And every key, from the keymap in effect.
    expect(body).toContain('"keys":"␣ f"');
  });
});
