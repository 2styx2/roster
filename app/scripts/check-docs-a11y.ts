// An automated accessibility check of the built docs website (ticket 65's follow-up, #220): axe-core
// over every page in headless Chromium, in the dark scheme (the default) and the light one, and
// over the search box with its list open, since the combobox is built by search.js at run time.
// Fails on any WCAG 2.x A or AA violation axe finds.
//
//   npm run docs -- --out ../site && npm run docs:a11y -- ../site
//
// Chromium is $CHROME, else the first of google-chrome, chromium, chromium-browser on PATH
// (gen-docs-site.ts's rule). playwright-core only drives it; it downloads no browser.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AxeResults, Result } from "axe-core";
import { chromium, type Page } from "playwright-core";
import { chrome } from "./gen-docs-site";

/** WCAG 2.0, 2.1 and 2.2, levels A and AA. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
/** print.html is every page again in one document, for the PDF: checking the pages covers it. */
const SKIP = new Set(["print.html"]);

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** axe over the whole page; `off` names rules left out of this one check. */
async function audit(page: Page, off: readonly string[] = []): Promise<Result[]> {
  await page.addScriptTag({ content: axeSource });
  const results = await page.evaluate(
    async ([tags, rulesOff]) => {
      const axe = (window as unknown as { axe: { run(ctx: unknown, opts: unknown): Promise<AxeResults> } }).axe;
      const rules = Object.fromEntries(rulesOff.map((r) => [r, { enabled: false }]));
      return axe.run(document, { runOnly: { type: "tag", values: tags }, rules, resultTypes: ["violations"] });
    },
    [TAGS, off] as const,
  );
  return results.violations;
}

/** The search box's open list scrolls, but takes no focus on purpose: in the ARIA combobox
 * pattern the focus stays in the box, and the arrow keys move the choice and scroll the list to it
 * (client.ts). Every other rule still runs over the open list, and this one over every page. */
const OPEN_BOX_OFF = ["scrollable-region-focusable"];

function report(where: string, violations: Result[]): number {
  let count = 0;
  for (const v of violations) {
    for (const n of v.nodes) {
      count++;
      console.error(`${where}: ${v.id} (${v.impact ?? "?"}): ${v.help}\n  ${n.target.join(" ")}\n  ${n.html.slice(0, 200)}\n  ${n.failureSummary?.replace(/\n/g, "\n  ") ?? ""}\n  ${v.helpUrl}`);
    }
  }
  return count;
}

export async function main(argv: string[]): Promise<number> {
  const [dir] = argv;
  if (!dir || argv.length > 1) {
    console.error("usage: npm run docs:a11y -- SITE_DIR");
    return 2;
  }
  const root = resolve(dir);
  const pages = readdirSync(root).filter((f) => f.endsWith(".html") && !SKIP.has(f)).sort();
  if (!pages.length) {
    console.error(`No pages in ${root}: build the site first (npm run docs -- --out ${dir}).`);
    return 2;
  }
  const browser = await chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
  let problems = 0;
  let checks = 0;
  try {
    for (const scheme of ["dark", "light"] as const) {
      const page = await browser.newPage({ colorScheme: scheme });
      for (const file of pages) {
        await page.goto(pathToFileURL(join(root, file)).href);
        problems += report(`${file} (${scheme})`, await audit(page));
        checks++;
      }
      // The combobox, open: a query with topics and places in the text, the first option chosen.
      await page.goto(pathToFileURL(join(root, "index.html")).href);
      await page.fill("#site-topic", "connect");
      await page.locator('[role="option"]').first().waitFor();
      await page.keyboard.press("ArrowDown");
      problems += report(`index.html search box open (${scheme})`, await audit(page, OPEN_BOX_OFF));
      checks++;
      // The results page.
      await page.goto(`${pathToFileURL(join(root, "search.html")).href}?q=connect`);
      problems += report(`search.html?q=connect (${scheme})`, await audit(page));
      checks++;
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (problems) {
    console.error(`axe found ${problems} accessibility problem(s) on the docs website.`);
    return 1;
  }
  console.log(`axe: no WCAG A/AA problems in ${checks} checks (${pages.length} pages, dark and light, the search box open, a results page).`);
  return 0;
}
