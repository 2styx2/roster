// The docs website and its PDF (ticket 46, ADR 0008), Neovim's gen_help_html.lua for roster: the
// `:help` pages rendered to static HTML by the help panel's own renderer (HelpPanel.tsx's HelpDoc,
// through react-dom/server) with the help page's own stylesheet (help/doc.css), so the website,
// the PDF and `:help` can't drift apart. app/scripts/gen-docs-site.ts writes what buildSite returns.
//
// Public repo: the context is the built-in registries and the Config's defaults only (the core's
// defaults fixture). No init.lua, no State, no Plugins, no Inventory, never a roster.yml.
import { renderToStaticMarkup } from "react-dom/server";
import { Logo } from "../chrome/Logo";
import logoCss from "../chrome/logo.css?raw";
import { defaultConfig } from "../config/fixture";
import { registerHelp, HelpView } from "../help/command";
import { blockLinks, type Block } from "../help/doc";
import helpDocCss from "../help/doc.css?raw";
import { guides, PARTS } from "../help/guides";
import { HelpDoc, type RenderEnv } from "../help/HelpPanel";
import { headingTag, helpContext, linkKind, pageTexts, topicIndex, type HelpContext, type HelpPage, type Topic } from "../help/pages";
import { defaultOptions, keymapOf } from "../keymap";
import { builtinRegistries } from "../registries";
import { rosterDark, rosterLight } from "../theme/themes";
import { themeVariables } from "../theme/theme";
import keysCss from "../ui/keys.css?raw";
import type { SearchIndex } from "./search";

export interface SiteOptions {
  /** The commit it's built from: the footer's "Generated from". */
  sha: string;
  /** `owner/name` on GitHub: edit, report and file links. */
  repo: string;
  /** The release version (`app/package.json`), on the PDF's first page. */
  version: string;
  /** One document for the PDF (print.html) instead of a page per help page. */
  print?: boolean;
  /** Whether a path from the repo's root exists: a link to one that doesn't fails the build. */
  fileExists(path: string): boolean;
}

export interface SiteFile {
  path: string;
  body: string;
}

export interface Site {
  files: SiteFile[];
  /** Dead links and repeated ids; the build fails on any. */
  problems: string[];
}

/** The font files the pages ask for, copied from @fontsource by the script: Inter for prose,
 * Iosevka for anything you could type (taste.md). Latin only; anything else falls back. */
export const FONTS = [
  { family: "Inter", pkg: "inter", weight: 400, style: "normal" },
  { family: "Inter", pkg: "inter", weight: 400, style: "italic" },
  { family: "Inter", pkg: "inter", weight: 500, style: "normal" },
  { family: "Inter", pkg: "inter", weight: 600, style: "normal" },
  { family: "Iosevka", pkg: "iosevka", weight: 400, style: "normal" },
  { family: "Iosevka", pkg: "iosevka", weight: 500, style: "normal" },
  // The PDF's keywords and commands (PRINT below); a page that doesn't use it never loads it.
  { family: "Iosevka", pkg: "iosevka", weight: 600, style: "normal" },
].map((f) => ({ ...f, file: `${f.pkg}-latin-${f.weight}-${f.style}.woff2` }));

/** What every page is generated from on the website: the built-in registries and the Config's
 * defaults, as the app has them with no init.lua (the same context lint.test.ts checks). */
export function siteContext(): HelpContext {
  const r = builtinRegistries();
  registerHelp(r, new HelpView());
  return helpContext(r, {
    keymap: keymapOf(r.keymap.list()),
    options: defaultOptions,
    config: defaultConfig,
    configPath: null,
    state: {},
    activeTheme: null,
    health: { sections: r.health.list(), report: null },
  });
}

/** The pages in the index's order: the index, then each part's pages by their order. */
export function indexOrder(ctx: HelpContext): HelpPage[] {
  const parts: string[] = [...PARTS];
  const rank = (pg: HelpPage) => (pg.id === "index" ? -1 : parts.indexOf(pg.part ?? "") < 0 ? parts.length : parts.indexOf(pg.part ?? ""));
  return [...ctx.pages].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** The element ids of a page's topics, by tag: an entry's is its tag (`terminal.size`, `:connect`,
 * `E13`), a heading's its slug (`config#the-sandbox` → `the-sandbox`, GitHub's anchor), or
 * `section-SLUG` when an entry on the page already has that id (the options page's `folders`
 * heading and its `folders` option). In the print document every page shares one set of ids, so
 * they're `page--id`. */
function pageIds(page: string, blocks: readonly Block[], print: boolean): Map<string, string> {
  const own = (anchor: string) => (anchor.startsWith(`${page}#`) ? anchor.slice(page.length + 1) : anchor);
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  const add = (tag: string, id: string) => {
    ids.set(tag, print ? `${page}--${id}` : id);
    taken.add(id);
  };
  for (const b of blocks) {
    if (b.t === "defs") for (const d of b.items) if (d.anchor) add(d.anchor, own(d.anchor));
    if (b.t === "table") for (const a of b.anchors ?? []) if (a) add(a, own(a));
  }
  for (const b of blocks) {
    if (b.t !== "h") continue;
    const tag = b.level > 1 ? headingTag(page, b.anchor) : b.anchor;
    const id = own(tag);
    add(tag, taken.has(id) ? `section-${id}` : id);
  }
  return ids;
}

const short = (title: string) => title.split(":")[0] as string;

/** Pages made from the app's code rather than a Markdown file: on the website they show the
 * defaults, and say so. */
const GENERATED_NOTE = new Set(["quickref", "commands", "keys", "options", "themes", "finders", "errors", "health"]);

export function buildSite(ctx: HelpContext, opts: SiteOptions): Site {
  const print = opts.print ?? false;
  const gh = `https://github.com/${opts.repo}`;
  const { topics } = topicIndex(ctx);
  const byTag = new Map(topics.map((t) => [t.tag, t]));
  const tags = new Set(byTag.keys());
  const titleOf = (id: string) => ctx.pages.find((pg) => pg.id === id)?.title ?? id;
  const problems: string[] = [];

  /** Where a topic is: `options.html#terminal.size`, or `#options--terminal.size` in print.html. */
  const urlOf = (tag: string): string => {
    const t = byTag.get(tag);
    if (!t) return "";
    const id = t.anchor ? ids.get(t.page)?.get(t.anchor) ?? t.anchor : undefined;
    if (print) return `#${encodeURIComponent(id ?? `page-${t.page}`)}`;
    return `${t.page}.html${id ? `#${encodeURIComponent(id)}` : ""}`;
  };
  const pages = indexOrder(ctx);
  const bodies = new Map(pages.map((pg) => [pg.id, pg.body(ctx)]));
  const ids = new Map(pages.map((pg) => [pg.id, pageIds(pg.id, bodies.get(pg.id) ?? [], print)]));
  const tagUrls = Object.fromEntries(topics.map((t) => [t.tag, urlOf(t.tag)]));

  const rendered = pages.map((pg) => {
    const blocks = bodies.get(pg.id) ?? [];
    const own = ids.get(pg.id) ?? new Map<string, string>();
    for (const href of blockLinks(blocks)) {
      const kind = linkKind(href);
      if (kind === "topic" && !tags.has(href)) problems.push(`${pg.id}: ${href} isn't a topic`);
      if (kind === "file") {
        const path = href.slice("file:".length).split("#")[0] as string;
        if (!opts.fileExists(path)) problems.push(`${pg.id}: ${path} isn't in the repo`);
      }
    }
    const env: RenderEnv = {
      query: "",
      leader: defaultOptions.leader,
      tags,
      here: pg.id,
      open: () => {},
      href: urlOf,
      id: (anchor) => own.get(anchor) ?? own.get(headingTag(pg.id, anchor)),
      pageOf: (tag) => {
        const to = byTag.get(tag)?.page;
        return print && to && to !== pg.id ? titleOf(to) : undefined;
      },
      outside: (href) => (href.startsWith("file:") ? `${gh}/blob/${opts.sha}/${href.slice("file:".length)}` : href),
    };
    return { pg, html: renderToStaticMarkup(<HelpDoc blocks={blocks} env={env} />) };
  });

  const files: SiteFile[] = [];
  if (print) {
    files.push({ path: "print.html", body: printDocument(rendered, opts) });
  } else {
    for (const { pg, html } of rendered) files.push({ path: `${pg.id}.html`, body: sitePage(pg, html, pages, opts, gh) });
    files.push({ path: "tags.json", body: `${JSON.stringify(tagUrls, null, 1)}\n` });
    files.push({ path: "tag.html", body: tagPage(tagUrls) });
    files.push({ path: "search.html", body: searchPage(pages, opts, gh) });
    files.push({ path: "search-index.js", body: `window.rosterSearchIndex = ${json(searchIndexOf(ctx, topics, urlOf))};\n` });
    files.push({ path: "site.css", body: siteCss() });
  }
  problems.push(...linkProblems(files));
  return { files, problems };
}

/** JSON safe inside a <script> (tag.html) or as a script of its own (search-index.js). */
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** What the search box searches (search.ts): every topic, as `:help`'s topic finder lists them,
 * and every page's text, as `:helpgrep` searches it, each with the address of where it is. */
function searchIndexOf(ctx: HelpContext, topics: readonly Topic[], urlOf: (tag: string) => string): SearchIndex {
  const places: SearchIndex["places"] = [];
  const placeOf = new Map<string, number>();
  const texts: SearchIndex["texts"] = [];
  for (const hit of pageTexts(ctx)) {
    // The index and `all` only repeat other pages' titles and summaries (as in :helpgrep), and
    // a heading is a topic already.
    if (hit.page === "index" || hit.page === "all" || hit.heading) continue;
    const href = urlOf(hit.tag) || `${hit.page}.html`;
    const key = `${href}\n${hit.where}`;
    let place = placeOf.get(key);
    if (place === undefined) {
      place = places.push([href, hit.where]) - 1;
      placeOf.set(key, place);
    }
    texts.push([place, hit.text]);
  }
  return { topics: topics.map((t) => [t.tag, t.label, t.path ?? "", urlOf(t.tag)]), places, texts };
}

/** The build's own check of what it wrote: every `x.html#id` link goes to a page that has that
 * id, and no page has an id twice. */
function linkProblems(files: SiteFile[]): string[] {
  const out: string[] = [];
  const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const ids = new Map<string, Set<string>>();
  for (const f of files.filter((x) => x.path.endsWith(".html"))) {
    const list = [...f.body.matchAll(/\sid="([^"]*)"/g)].map((m) => unescape(m[1] as string));
    const set = new Set(list);
    if (set.size !== list.length) out.push(`${f.path}: an id is used twice (${list.filter((x, i) => list.indexOf(x) !== i).join(", ")})`);
    ids.set(f.path, set);
  }
  for (const f of files.filter((x) => x.path.endsWith(".html"))) {
    for (const m of f.body.matchAll(/\shref="([^"]*)"/g)) {
      const href = unescape(m[1] as string);
      if (/^[a-z]+:/i.test(href) || href.endsWith(".css") || href.endsWith(".pdf")) continue;
      const [page = "", anchor] = href.split("#", 2) as [string, string | undefined];
      const target = page === "" ? f.path : page;
      const has = ids.get(target);
      if (!has) out.push(`${f.path}: ${href} goes to a page that isn't built`);
      else if (anchor && !has.has(decodeURIComponent(anchor))) out.push(`${f.path}: ${href} has no #${decodeURIComponent(anchor)}`);
    }
  }
  return out;
}

const logoHtml = (size: number) => renderToStaticMarkup(<Logo size={size} className="site-mark" />);

function footer(pg: HelpPage, opts: SiteOptions, gh: string): string {
  const guide = guides.find((g) => g.id === pg.id);
  const edit = guide
    ? `<a href="${esc(`${gh}/edit/dev/${guide.path}`)}">Edit this page</a>`
    : `Made by the app from <a href="${esc(`${gh}/blob/${opts.sha}/app/src/help/pages.ts`)}"><code>app/src/help/pages.ts</code></a>`;
  const body = [
    `Page: ${pg.title} (\`:help ${pg.id}\`)`,
    `Source: ${guide ? guide.path : "app/src/help/pages.ts"} at ${opts.sha.slice(0, 7)}`,
    "",
    "What's wrong or unclear:",
    "",
  ].join("\n");
  const report = `${gh}/issues/new?${new URLSearchParams({ title: `docs: ${pg.id} (${pg.title})`, labels: "needs-triage,documentation", body }).toString()}`;
  return `<footer class="site-foot">
<p>Generated from <a href="${esc(`${gh}/commit/${opts.sha}`)}"><code>${esc(opts.sha.slice(0, 7))}</code></a> · ${edit} · Wrong or unclear? <a href="${esc(report)}">Report it</a></p>
</footer>`;
}

function nav(current: string, pages: HelpPage[]): string {
  const groups = new Map<string, HelpPage[]>();
  for (const pg of pages) {
    if (pg.id === "index") continue;
    const part = pg.part ?? "Reference";
    groups.set(part, [...(groups.get(part) ?? []), pg]);
  }
  // A title's part before the colon, unless another page's is the same (the Themes page and the
  // Themes guide).
  const label = (pg: HelpPage) => (pages.filter((x) => short(x.title) === short(pg.title)).length > 1 ? pg.title : short(pg.title));
  const item = (pg: HelpPage) =>
    `<li><a href="${pg.id}.html"${pg.id === current ? ' aria-current="page"' : ""}>${esc(label(pg))}</a></li>`;
  return `<nav class="site-nav" id="site-pages" aria-label="Pages">
<p class="site-nav-home"><a href="index.html"${current === "index" ? ' aria-current="page"' : ""}>roster help</a></p>
${[...groups].map(([part, list]) => `<h2>${esc(part)}</h2>\n<ul>${list.map(item).join("")}</ul>`).join("\n")}
</nav>`;
}

function head(title: string, description: string, css: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="dark light">
${css}
</head>`;
}

function sitePage(pg: HelpPage, article: string, pages: HelpPage[], opts: SiteOptions, gh: string): string {
  const start = pg.id === "index";
  const note = GENERATED_NOTE.has(pg.id)
    ? `<p class="site-note">On the website this page shows roster's defaults: no <code>init.lua</code>, no Plugins, nothing checked. In the app, <code>:help ${esc(pg.id)}</code> shows what's in effect on your Box.</p>`
    : "";
  const intro = start
    ? `<div class="site-start">${logoHtml(56)}<p>The same pages as <code>:help</code> in the roster app, made from the same source. Also as one <a href="roster-docs.pdf">PDF</a>, and on <a href="${esc(gh)}">GitHub</a>.</p></div>`
    : "";
  return frame(start ? "roster help" : `${pg.title} · roster help`, pg.summary, pg.id, `${intro}${note}${article}\n${footer(pg, opts, gh)}`, pages);
}

/** A page of the website: the top bar with the search box, the pages by part, and `main`. */
function frame(title: string, description: string, current: string, main: string, pages: HelpPage[]): string {
  return `${head(title, description, '<link rel="stylesheet" href="site.css">\n<script src="search.js" defer></script>')}
<body>
<a class="site-skip" href="#main">Skip to the page</a>
<header class="site-top">
<a class="site-name" href="index.html">roster</a>
<form class="site-go" action="search.html" role="search">
<label for="site-topic">:help</label>
<input id="site-topic" name="q" type="search" placeholder="topic or text" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="search">
<kbd class="keycap site-slash" aria-hidden="true">/</kbd>
</form>
<a class="site-pages" href="#site-pages">Pages</a>
<a class="site-pdf" href="roster-docs.pdf">PDF</a>
</header>
<div class="site-body">
${nav(current, pages)}
<main id="main">
${main}
</main>
</div>
</body>
</html>
`;
}

/** `search.html?q=WORDS`: every topic and every place in the text that has the words, for when
 * the search box's short list isn't enough (its last row comes here). search.js fills it. */
function searchPage(pages: HelpPage[], opts: SiteOptions, gh: string): string {
  const main = `<div class="help-doc site-search">
<h1>Search</h1>
<form class="site-search-form" action="search.html" role="search">
<label class="visually-hidden" for="site-q">Search every page</label>
<input id="site-q" name="q" type="search" placeholder="topic or text" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="search">
</form>
<p class="site-search-count" id="site-count" role="status"></p>
<div id="site-results"></div>
<noscript><p>Search needs JavaScript. <a href="all.html">Every topic</a> lists them all, and the <a href="roster-docs.pdf">PDF</a> has every page in one file.</p></noscript>
</div>
<footer class="site-foot"><p>The same topics as <code>:help</code> and the same text as <code>:helpgrep</code> in the app. Generated from <a href="${esc(`${gh}/commit/${opts.sha}`)}"><code>${esc(opts.sha.slice(0, 7))}</code></a>.</p></footer>`;
  return frame("Search · roster help", "Search every roster help page", "search", main, pages);
}

/** `tag.html?t=terminal.size`: a topic's stable address, like Neovim's helptag.html. The table is
 * in the page, so it works without fetching anything. */
function tagPage(urls: Record<string, string>): string {
  return `${head("roster help: topic", "Opens a :help topic", '<link rel="stylesheet" href="site.css">')}
<body>
<main id="main" class="site-tag">
<p id="site-tag-msg">Opening the topic…</p>
<noscript><p>This page needs JavaScript to find a topic. <a href="all.html">Every topic</a> lists them all.</p></noscript>
</main>
<script>
const tags = ${json(urls)};
const lower = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]));
const asked = (new URLSearchParams(location.search).get("t") || "").trim().replace(/^:?help\\s+/, "");
const to = tags[asked] || lower[asked.toLowerCase()] || lower[(":" + asked.replace(/^:/, "")).toLowerCase()];
if (to) location.replace(to);
else {
  const msg = document.getElementById("site-tag-msg");
  msg.textContent = asked ? "No topic named " : "No topic given. ";
  if (asked) { const c = document.createElement("code"); c.textContent = asked; msg.append(c, ". "); }
  if (asked) { const s = document.createElement("a"); s.href = "search.html?q=" + encodeURIComponent(asked); s.textContent = "Search the text for it"; msg.append(s, ", or see "); }
  const a = document.createElement("a"); a.href = "all.html"; a.textContent = asked ? "every topic" : "Every topic"; msg.append(a, asked ? "." : " lists them all.");
}
</script>
</body>
</html>
`;
}

function printDocument(rendered: { pg: HelpPage; html: string }[], opts: SiteOptions): string {
  const sections = rendered
    .map(({ pg, html }) => {
      const cover =
        pg.id === "index"
          ? `<div class="site-start">${logoHtml(64)}<p>roster ${esc(opts.version)} · generated from <code>${esc(opts.sha.slice(0, 7))}</code> · the same pages as <code>:help</code> in the app</p></div>`
          : "";
      return `<section class="print-page" id="page-${esc(pg.id)}">\n${cover}${html}\n</section>`;
    })
    .join("\n");
  return `${head(`roster help ${opts.version}`, "Every roster help page in one document", `<style>\n${baseCss("print")}\n</style>`)}
<body class="print">
${sections}
</body>
</html>
`;
}

const vars = (v: Record<string, string>) =>
  Object.entries(v)
    .map(([k, x]) => `  ${k}: ${x};`)
    .join("\n");

/** The site's stylesheet: the roster Themes' tokens (dark, or light when the OS is), the fonts,
 * then the app's own keycap, mark and help page rules, then the frame around them. */
function baseCss(mode: "screen" | "print"): string {
  const fonts = FONTS.map(
    (f) => `@font-face { font-family: "${f.family}"; font-style: ${f.style}; font-weight: ${f.weight}; font-display: swap; src: url("fonts/${f.file}") format("woff2"); }`,
  ).join("\n");
  const tokens =
    mode === "print"
      ? `:root {\n${vars(themeVariables(rosterLight))}\n}`
      : `:root {\n${vars(themeVariables(rosterDark))}\n}\n@media (prefers-color-scheme: light) {\n  :root {\n${vars(themeVariables(rosterLight))}\n  }\n}\n@media print {\n  :root {\n${vars(themeVariables(rosterLight))}\n${vars(printSyntax())}\n  }\n  .hl-keyword, .hl-command { font-weight: 600; }\n}`;
  return [fonts, tokens, FRAME, keysCss, logoCss, helpDocCss, PAGE, mode === "print" ? PRINT : SCREEN].join("\n\n");
}

const siteCss = () => `/* roster help on the web (ticket 46): generated by app/scripts/gen-docs-site.ts. */\n${baseCss("screen")}`;

/** What every page shares: the type scale styles.css's :root has, at a reading size. */
const FRAME = `:root {
  --font-ui: "Inter", system-ui, sans-serif;
  --font-mono: "Iosevka", ui-monospace, monospace;
  --ui-size: 16px;
  --text-xs: calc(var(--ui-size) - 2px);
  --text-sm: calc(var(--ui-size) - 1px);
  --text-md: var(--ui-size);
  --text-lg: calc(var(--ui-size) + 6px);
  --radius-sm: 4px;
  --radius: 6px;
  font-family: var(--font-ui);
  font-size: var(--text-md);
  line-height: 1.5;
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-feature-settings: "cv11", "calt";
  accent-color: var(--accent);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
::selection { background: color-mix(in srgb, var(--accent) 35%, transparent); }
code { font-family: var(--font-mono); font-size: 0.95em; }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.site-start { margin: 0 0 20px; }
.site-start .logo { margin: 0 0 14px; }
.site-start p { margin: 0; color: var(--muted); max-width: 60ch; }`;

/** After help/doc.css: the page fills its column on the web, where the panel pads it. */
const PAGE = `.help-doc { padding: 0; }`;

/** The website around the page: a top bar, the pages by part on the left, the page, its footer.
 * Nothing moves: a docs page has nothing to confirm (taste.md, "motion confirms"). */
const SCREEN = `.site-skip { position: absolute; left: 8px; top: -40px; padding: 6px 10px; background: var(--panel); color: var(--text); border: 1px solid var(--line-strong); border-radius: var(--radius); }
.site-skip:focus { top: 8px; }
.site-top {
  position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 16px;
  height: 48px; padding: 0 20px; background: var(--chrome); border-bottom: 1px solid var(--line);
}
.site-name { font: 500 var(--text-md) var(--font-mono); color: var(--text); text-decoration: none; }
.site-go { position: relative; display: flex; align-items: center; gap: 6px; margin-left: auto; font: var(--text-sm) var(--font-mono); color: var(--muted); }
.site-go input {
  width: 24ch; padding-right: 28px; height: 30px; padding: 0 8px; font: var(--text-sm) var(--font-mono); color: var(--text);
  background: var(--bg); border: 1px solid var(--line-strong); border-radius: var(--radius-sm);
}
.site-go input::placeholder { color: var(--muted); }
.site-go input:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.site-go input::-webkit-search-cancel-button { display: none; }
/* The / that focuses the box, as a keycap in it (taste.md: keycaps sit next to what they do). */
.site-slash { position: absolute; right: 7px; pointer-events: none; }
.site-go:focus-within .site-slash { visibility: hidden; }
@media (hover: none) { .site-slash { display: none; } .site-go input { padding-right: 8px; } }
/* The search box's list (src/docs-site/client.ts). It appears and goes at once: it's opened and
   walked from the keyboard, many times a visit (taste.md, "motion confirms"). */
.site-pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 3; width: min(36rem, calc(100vw - 32px));
  max-height: min(70vh, 34rem); overflow: auto; overscroll-behavior: contain; padding: 4px;
  font: var(--text-sm) var(--font-ui); color: var(--text);
  background: var(--panel); border: 1px solid var(--line-strong); border-radius: var(--radius); box-shadow: 0 8px 24px var(--shadow);
}
.site-pop-msg { margin: 0; padding: 8px 10px; color: var(--muted); }
.site-hits-head { padding: 8px 10px 4px; font-size: var(--text-xs); font-weight: 600; color: var(--muted); }
.site-hits-head:empty { display: none; }
.site-hits-group + .site-hits-group:last-child { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--line); }
.site-hit { display: grid; gap: 1px; padding: 6px 10px; border-radius: var(--radius-sm); cursor: pointer; }
.site-hit[aria-selected="true"] { background: var(--raised); box-shadow: inset 0 0 0 1px var(--raised-line); }
.site-hit-name, .site-hit-where { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site-hit-tag { font-family: var(--font-mono); }
.site-hit-where { font-size: var(--text-xs); color: var(--muted); }
.site-hit-all .site-hit-name { color: var(--muted); }
.site-hit mark, .site-result mark { background: none; color: inherit; font-weight: 600; }
/* search.html */
.site-search-form input {
  width: 100%; max-width: 40rem; height: 40px; padding: 0 12px; font: var(--text-md) var(--font-mono); color: var(--text);
  background: var(--bg); border: 1px solid var(--line-strong); border-radius: var(--radius);
}
.site-search-form input:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.site-search-count { color: var(--muted); font-size: var(--text-sm); }
.site-search .site-results { margin: 0 0 12px; padding: 0; list-style: none; }
.site-result { display: grid; gap: 1px; padding: 6px 8px; margin: 0 -8px; border-radius: var(--radius-sm); text-decoration: none; }
.site-result .site-hit-name { white-space: normal; }
@media (hover: hover) and (pointer: fine) { .site-result:hover { background: var(--hover); } }
.site-search-more { color: var(--muted); font-size: var(--text-sm); }
.site-pdf, .site-pages { font-size: var(--text-sm); color: var(--muted); }
.site-pages { display: none; }
.site-body { display: grid; grid-template-columns: 240px minmax(0, 1fr); max-width: 1180px; margin: 0 auto; }
.site-nav {
  position: sticky; top: 48px; align-self: start; max-height: calc(100vh - 48px); overflow: auto;
  padding: 20px 16px 32px 20px; font-size: var(--text-sm); scrollbar-width: thin;
}
.site-nav h2 { margin: 18px 0 6px; font-size: var(--text-xs); font-weight: 600; color: var(--muted); }
.site-nav ul { margin: 0; padding: 0; list-style: none; }
.site-nav li a, .site-nav-home a {
  display: block; padding: 3px 8px; margin: 0 -8px; border-radius: var(--radius-sm); color: var(--text); text-decoration: none;
}
.site-nav-home { margin: 0; font-weight: 600; }
.site-nav a[aria-current="page"] { background: var(--raised); box-shadow: inset 0 0 0 1px var(--raised-line); }
@media (hover: hover) and (pointer: fine) {
  .site-nav a:hover { background: var(--hover); }
  .site-nav a[aria-current="page"]:hover { background: var(--raised); }
}
main { min-width: 0; padding: 28px 32px 40px; }
main .help-doc { max-width: 76ch; }
a { color: inherit; }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
.site-note {
  max-width: 76ch; margin: 0 0 18px; padding: 8px 12px; font-size: var(--text-sm); color: var(--muted);
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
}
.site-foot { max-width: 76ch; margin-top: 40px; padding-top: 14px; border-top: 1px solid var(--line); font-size: var(--text-xs); color: var(--muted); }
.site-foot p { margin: 0; }
.site-tag { padding: 40px 24px; }
@media (max-width: 760px) {
  .site-top { padding: 0 16px; gap: 10px; }
  .site-go label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .site-go input { width: 15ch; }
  .site-pop { position: fixed; top: 54px; left: 8px; right: 8px; width: auto; max-height: calc(100vh - 70px); }
  .site-pages { display: inline; }
  /* The page first; the pages list after it, a tap away ("Pages"). */
  .site-body { display: flex; flex-direction: column-reverse; }
  .site-nav { position: static; max-height: none; padding: 12px 16px 24px; border-top: 1px solid var(--line); }
  .site-nav ul { display: flex; flex-wrap: wrap; gap: 2px 14px; }
  .site-nav li a { margin: 0; padding: 3px 0; }
  .site-nav h2 { margin-top: 12px; }
  main { padding: 20px 16px 32px; }
}`;

/** Code's colours on paper (ticket 71, decision Q90): Roster light's hues taken darker, each at
 * least 7:1 on white, so they hold on a greyscale printer. There the comments are the light grey
 * and keywords and commands the bold ones; strings and keys stay near black, as text. */
export const PRINT_SYNTAX = {
  "syntax-keyword": "#3b1f78",
  "syntax-string": "#14522a",
  "syntax-number": "#5e1a5a",
  "syntax-comment": "#545557",
  "syntax-function": "#123f78",
  "syntax-punctuation": "#3d3e40",
  "syntax-key": "#26405f",
  "syntax-command": "#111213",
};

/** The PDF: light, each page on a new sheet, and a link names the page it goes to. */
const printSyntax = () => Object.fromEntries(Object.entries(PRINT_SYNTAX).map(([k, v]) => [`--${k}`, v]));

const PRINT = `:root {
${vars(printSyntax())}
}
.hl-keyword, .hl-command { font-weight: 600; }
.help-doc pre { background: #fff; border-color: var(--line-strong); }
@page { size: A4; margin: 18mm 16mm; }
body.print { background: #fff; }
.print-page { break-before: page; }
.print-page:first-child { break-before: auto; }
.help-doc { max-width: none; font-size: 10.5pt; }
.help-doc pre, .help-def, .help-table tr { break-inside: avoid; }
.help-doc h1, .help-doc h2, .help-doc h3 { break-after: avoid; }
.help-link { text-decoration: none; }
a.help-link[data-page]::after { content: " → " attr(data-page); font-family: var(--font-ui); font-weight: 400; color: var(--muted); font-size: 0.9em; }`;
