// The docs website and its PDF (ticket 46, ADR 0008): built from the same pages and renderer as
// `:help`. These go through buildSite, the one thing app/scripts/gen-docs-site.ts calls.
import { describe, expect, it } from "vitest";
import { link, p, h } from "../help/doc";
import { topics } from "../help/pages";
import { BUILTIN } from "../registry";
import { contrast } from "../theme/contrast";
import { joinIndex, searchDocs, type SearchIndex, type SearchTopics } from "./search";
import { buildSite, PRINT_SYNTAX, SHARD_TEXT, siteContext, type SiteOptions } from "./site";

const OPTS: SiteOptions = { sha: "0123456789abcdef0123456789abcdef01234567", repo: "example/roster", version: "9.8.7", fileExists: () => true };

const file = (files: { path: string; body: string }[], path: string): string => {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path}`);
  return f.body;
};

const idsOf = (html: string) => [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => decodeHtml(m[1] as string));
const decodeHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("the docs website", () => {
  const site = buildSite(siteContext(), OPTS);

  it("builds with no dead links", () => {
    expect(site.problems).toEqual([]);
  });

  it("has a page per help page, and a URL for every :help topic that lands on its entry", () => {
    const ctx = siteContext();
    const tags = JSON.parse(file(site.files, "tags.json")) as Record<string, string>;
    for (const pg of ctx.pages) expect(site.files.some((f) => f.path === `${pg.id}.html`), pg.id).toBe(true);
    for (const t of topics(ctx)) {
      const url = tags[t.tag];
      expect(url, t.tag).toBeDefined();
      const [page = "", anchor] = (url as string).split("#", 2);
      expect(page, t.tag).toBe(`${t.page}.html`);
      if (t.anchor) expect(idsOf(file(site.files, page)), t.tag).toContain(decodeURIComponent(anchor ?? ""));
    }
    expect(tags["terminal.size"]).toBe("options.html#terminal.size");
    expect(tags["config#the-sandbox"]).toBe("config.html#the-sandbox");
  });

  it("gives a topic a stable address: tag.html?t=… redirects through the same table", () => {
    const tag = file(site.files, "tag.html");
    expect(tag).toContain('"terminal.size":"options.html#terminal.size"');
    expect(tag).toContain("location.replace");
  });

  it("fails on a link that goes nowhere", () => {
    const ctx = siteContext();
    const broken = { id: "broken", source: BUILTIN, order: 99, title: "Broken", summary: "A test page", body: () => [h(1, "Broken", "broken"), p(link("no-such-topic", "a typo"))] };
    const bad = buildSite({ ...ctx, pages: [...ctx.pages, broken] }, OPTS);
    expect(bad.problems).toEqual(["broken: no-such-topic isn't a topic"]);
    const missing = buildSite(ctx, { ...OPTS, fileExists: (path) => path !== "examples/init.lua" });
    expect(missing.problems.some((x) => x.includes("examples/init.lua isn't in the repo"))).toBe(true);
  });

  it("links a guide's repo files to GitHub at the commit it was built from", () => {
    expect(file(site.files, "config.html")).toContain(`href="https://github.com/example/roster/blob/${OPTS.sha}/examples/init.lua"`);
  });

  it("ends every page with where it came from, how to edit it and how to report it", () => {
    const config = file(site.files, "config.html");
    expect(config).toContain(`https://github.com/example/roster/commit/${OPTS.sha}`);
    expect(config).toContain(">0123456<");
    expect(config).toContain('href="https://github.com/example/roster/edit/dev/docs/app/config.md"');
    const report = /href="(https:\/\/github\.com\/example\/roster\/issues\/new\?[^"]*)"/.exec(config)?.[1];
    expect(report).toBeDefined();
    const q = new URL(decodeHtml(report as string)).searchParams;
    expect(q.get("labels")).toBe("needs-triage,documentation");
    expect(q.get("title")).toBe("docs: config (Your init.lua)");
    expect(q.get("body")).toContain(":help config");
    // A generated page has no Markdown to edit: it says what makes it.
    expect(file(site.files, "options.html")).toContain("app/src/help/pages.ts");
  });

  it("shows roster's defaults on generated pages, and says so", () => {
    const options = file(site.files, "options.html");
    expect(options).toContain("roster's defaults");
    expect(options).toContain("Ctrl+Space");
    expect(file(site.files, "config.html")).not.toContain("roster's defaults");
  });

  it("draws the Gap orbit mark on the start page only", () => {
    expect(file(site.files, "index.html")).toContain('class="logo');
    expect(file(site.files, "config.html")).not.toContain('class="logo');
  });

  it("styles pages with the app's own help page, keycap and mark rules, in roster's Theme tokens", () => {
    const css = file(site.files, "site.css");
    expect(css).toContain(".help-doc pre {");
    expect(css).toContain(".keycap {");
    expect(css).toContain(".logo-host {");
    expect(css).toContain("--accent: #ff9a70;");
    expect(css).toContain("--accent: #9b411a;");
    expect(css).toContain('font-family: "Iosevka"');
  });

  it("colours code from the Theme's syntax tokens, dark and light (ticket 71)", () => {
    const css = file(site.files, "site.css");
    expect(css).toContain("--syntax-keyword: #c3a6f6;");
    expect(css).toContain("--syntax-keyword: #6b3fb8;");
    expect(css).toContain(".hl-keyword { color: var(--syntax-keyword); }");
    expect(file(site.files, "config.html")).toMatch(/<pre data-lang="lua"><code>.*<span class="hl-key">/s);
  });

  /** The index as search.js loads it: search-topics.js, then each text shard it names, run as scripts. */
  const searchIndex = (): SearchIndex => {
    const win: { rosterSearchTopics?: SearchTopics; rosterSearchText?: SearchIndex["texts"][] } = {};
    new Function("window", file(site.files, "search-topics.js"))(win);
    expect(win.rosterSearchTopics, "search-topics.js sets window.rosterSearchTopics").toBeDefined();
    const topics = win.rosterSearchTopics as SearchTopics;
    for (const shard of topics.shards) new Function("window", file(site.files, shard))(win);
    expect(win.rosterSearchText?.length, "each shard sets its slot of window.rosterSearchText").toBe(topics.shards.length);
    return joinIndex(topics, win.rosterSearchText);
  };

  it("writes a search index of every topic, at the address tags.json gives it (ticket 65)", () => {
    const tags = JSON.parse(file(site.files, "tags.json")) as Record<string, string>;
    const index = searchIndex();
    expect(Object.fromEntries(index.topics.map(([tag, , , href]) => [tag, href]))).toEqual(tags);
    expect(searchDocs(index, "terminal.size").topics[0]?.href).toBe("options.html#terminal.size");
  });

  it("indexes every page's text as :helpgrep searches it, each place linked to its spot", () => {
    const index = searchIndex();
    const hit = searchDocs(index, "string.dump").texts.find((t) => t.where === "Your init.lua › The sandbox");
    expect(hit?.href).toBe("config.html?hl=string.dump#the-sandbox");
    // A heading is a topic, listed once as one.
    expect(index.texts.some(([, text]) => text === "The sandbox")).toBe(false);
    // The index and `all` only repeat other pages' titles; helpgrep skips them too.
    expect(index.places.some(([href]) => href.startsWith("index.html") || href.startsWith("all.html"))).toBe(false);
    // plugin-types is the Lua stubs: type signatures plugin-api.html already indexes (T213, Q189). Its
    // page is still a topic, and is still built.
    expect(index.places.some(([href]) => href.startsWith("plugin-types.html"))).toBe(false);
    expect(index.topics.some(([tag]) => tag === "plugin-types")).toBe(true);
    for (const [href] of index.places) {
      const [page = "", anchor] = href.split("#", 2);
      if (anchor) expect(idsOf(file(site.files, page)), href).toContain(decodeURIComponent(anchor));
    }
  });

  const gzipped = async (body: string) => (await new Response(new Response(body).body?.pipeThrough(new CompressionStream("gzip"))).arrayBuffer()).byteLength;

  it("shards the text by whole pages, in order, so the shards together are every text once (T260)", () => {
    const shards = (JSON.parse(/= (.*);\n$/s.exec(file(site.files, "search-topics.js"))?.[1] ?? "{}") as SearchTopics).shards;
    expect(shards.length).toBeGreaterThan(1);
    expect(shards).toEqual(shards.map((_, i) => `search-text-${i}.js`));
    expect(site.files.some((f) => f.path === "search-index.js")).toBe(false);
    const index = searchIndex();
    const pageOf = (place: number) => (index.places[place]?.[0] ?? "").split(/[#?]/)[0];
    const win: { rosterSearchText?: SearchIndex["texts"][] } = {};
    for (const shard of shards) new Function("window", file(site.files, shard))(win);
    const pagesIn = (win.rosterSearchText ?? []).map((texts) => new Set(texts.map(([place]) => pageOf(place))));
    // No page is in two shards.
    for (const [i, a] of pagesIn.entries()) for (const b of pagesIn.slice(i + 1)) expect([...a].filter((pg) => b.has(pg))).toEqual([]);
    // A shard over SHARD_TEXT is one page that big on its own.
    for (const [i, texts] of (win.rosterSearchText ?? []).entries()) {
      if (JSON.stringify(texts).length > SHARD_TEXT) expect(pagesIn[i]?.size, shards[i]).toBe(1);
    }
  });

  it("keeps the search index inside its budgets (docs/app/performance.md)", async () => {
    const topics = await gzipped(file(site.files, "search-topics.js"));
    const shards = await Promise.all(site.files.filter((f) => /^search-text-\d+\.js$/.test(f.path)).map(async (f) => [f.path, await gzipped(f.body)] as const));
    // 330 -> 450 KB on 2026-11-04 (T197, #377, decision Q181, owner's call): budgets follow the docs. The first
    // text search still loads every shard, so the whole stays inside it. performance.md has the history.
    expect(topics + shards.reduce((n, [, size]) => n + size, 0)).toBeLessThan(450_000);
    // Sharded on 2026-11-06 at 360 KB (T260, #528, amending Q209): the box loads search-topics.js first, the
    // shards when a query needs the text. Each file has a budget, and each fails at 80 % of it first, so the
    // docs pull request that takes one there splits it (or raises its budget with its reason) before it's reached.
    expect(topics).toBeLessThan(60_000);
    expect(topics, "search-topics.js is past 80 % of its 60 KB budget (docs/app/performance.md)").toBeLessThan(48_000);
    for (const [path, size] of shards) {
      expect(size, path).toBeLessThan(100_000);
      expect(size, `${path} is past 80 % of a shard's 100 KB budget: its page is too big for one shard; split the page, or shard by heading`).toBeLessThan(80_000);
    }
  });

  it("puts the search box on every page, and loads the index only when it's used", () => {
    for (const path of ["index.html", "config.html", "options.html", "search.html"]) {
      const html = file(site.files, path);
      expect(html, path).toContain('<script src="search.js" defer></script>');
      expect(html, path).toContain('id="site-topic"');
      expect(html, path).not.toContain("search-topics.js");
      expect(html, path).not.toContain("search-text-");
    }
  });

  it("has a page of every result, search.html?q=…, in the site's frame", () => {
    const html = file(site.files, "search.html");
    expect(html).toContain('id="site-results"');
    expect(html).toContain('class="site-nav"');
    expect(html).toContain("<noscript>");
  });

  it("offers to search the text when a topic address names no topic", () => {
    expect(file(site.files, "tag.html")).toContain("search.html?q=");
  });

  it("never puts a link inside a link, and gives every link text (axe's link-name)", () => {
    for (const f of site.files.filter((x) => x.path.endsWith(".html"))) {
      let depth = 0;
      for (const m of f.body.matchAll(/<a\s[^>]*>|<\/a>/g)) {
        depth += m[0] === "</a>" ? -1 : 1;
        expect(depth, `${f.path}: a link inside a link at ${m.index}`).toBeLessThanOrEqual(1);
      }
      const empty = [...f.body.matchAll(/<a\s[^>]*>((?:(?!<\/a>).)*)<\/a>/gs)].filter((m) => !(m[1] as string).replace(/<[^>]*>/g, "").trim());
      expect(empty.map((m) => m[0]), f.path).toEqual([]);
    }
  });

  it("never repeats an id on a page", () => {
    for (const f of site.files.filter((x) => x.path.endsWith(".html"))) {
      const ids = idsOf(f.body);
      expect(ids.filter((id, i) => ids.indexOf(id) !== i), f.path).toEqual([]);
    }
  });
});

describe("the print version (the PDF)", () => {
  const ctx = siteContext();
  const site = buildSite(ctx, { ...OPTS, print: true });
  const html = file(site.files, "print.html");

  it("is every page in one document, in the index's order, with no dead links", () => {
    expect(site.problems).toEqual([]);
    const order = [...html.matchAll(/<section class="print-page" id="page-([^"]+)"/g)].map((m) => m[1]);
    expect(order[0]).toBe("index");
    expect(order.indexOf("start")).toBeLessThan(order.indexOf("config"));
    expect(order.indexOf("config")).toBeLessThan(order.indexOf("commands"));
    expect(order.indexOf("plugins")).toBeLessThan(order.indexOf("news"));
    expect(new Set(order)).toEqual(new Set(ctx.pages.map((pg) => pg.id)));
  });

  it("links inside itself, and names the page a link goes to", () => {
    expect(html).toContain('href="#options--terminal.size"');
    expect(html).toMatch(/data-page="Your init.lua"/);
    const ids = idsOf(html);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it("prints code in a palette that holds on paper and in greyscale (ticket 71)", () => {
    for (const [token, colour] of Object.entries(PRINT_SYNTAX)) {
      expect(contrast(colour, "#ffffff"), token).toBeGreaterThanOrEqual(7);
      expect(html).toContain(`--${token}: ${colour};`);
    }
    // In greyscale, comments are the light ones and keywords and commands the heavy ones.
    expect(contrast(PRINT_SYNTAX["syntax-comment"], "#ffffff")).toBeLessThan(contrast(PRINT_SYNTAX["syntax-string"], "#ffffff"));
    expect(html).toMatch(/\.hl-keyword, \.hl-command \{ font-weight: 600; \}/);
    expect(html).toContain('<pre data-lang="lua">');
  });

  it("names its version and commit", () => {
    expect(html).toContain("9.8.7");
    expect(html).toContain("0123456");
  });
});
