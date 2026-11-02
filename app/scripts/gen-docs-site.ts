// The docs website and its PDF (ticket 46, ADR 0008), like Neovim's gen_help_html.lua: every
// `:help` page as static HTML, from the same pages and renderer as the app (src/docs-site/site.tsx).
// Fails, writing nothing, on a dead link.
//
//   npm run docs                          the website in app/dist-docs/
//   npm run docs -- --out DIR             somewhere else
//   npm run docs -- --print               print.html too: every page in one document
//   npm run docs -- --pdf FILE            print.html, then headless Chromium prints it to FILE
//
// --sha and --repo default to $GITHUB_SHA (else `git rev-parse HEAD`) and $GITHUB_REPOSITORY
// (else 2styx2/roster). Chromium is $CHROME, else the first of google-chrome, chromium,
// chromium-browser on PATH.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build, type Rolldown } from "vite";
import { buildSite, FONTS, siteContext, type SiteFile } from "../src/docs-site/site";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(APP, "..");

interface Args {
  out: string;
  print: boolean;
  pdf: string | null;
  sha: string;
  repo: string;
}

function parse(argv: string[]): Args {
  const args: Args = {
    out: join(APP, "dist-docs"),
    print: false,
    pdf: null,
    sha: process.env.GITHUB_SHA ?? "",
    repo: process.env.GITHUB_REPOSITORY ?? "2styx2/roster",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--out") args.out = resolve(value());
    else if (a === "--print") args.print = true;
    else if (a === "--pdf") args.pdf = resolve(value());
    else if (a === "--sha") args.sha = value();
    else if (a === "--repo") args.repo = value();
    else throw new Error(`unknown argument ${a ?? ""}`);
  }
  if (!args.sha) args.sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  return args;
}

function chrome(): string {
  const env = process.env.CHROME;
  if (env) return env;
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    try {
      return execFileSync("which", [name], { encoding: "utf8" }).trim();
    } catch {
      // not this one
    }
  }
  throw new Error("no Chromium found: set CHROME to a Chrome or Chromium binary");
}

function write(out: string, files: SiteFile[]): void {
  mkdirSync(join(out, "fonts"), { recursive: true });
  for (const f of files) writeFileSync(join(out, f.path), f.body);
  for (const f of FONTS) copyFileSync(join(APP, "node_modules", "@fontsource", f.pkg, "files", f.file), join(out, "fonts", f.file));
}

/** search.js's budget, minified (docs/app/performance.md): the one script every page loads. */
const SEARCH_JS_BUDGET = 12_000;

/** search.js: the search box (src/docs-site/entry.ts and what it imports), bundled and minified
 * by Vite, the build the app uses, into one classic script (no modules, so file:// works too). */
async function searchScript(): Promise<string> {
  const out = (await build({
    configFile: false,
    root: APP,
    logLevel: "warn",
    build: {
      write: false,
      minify: true,
      target: "es2022",
      lib: { entry: join(APP, "src/docs-site/entry.ts"), formats: ["iife"], name: "rosterSearch", fileName: () => "search.js" },
    },
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output).find((c) => c.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("Vite wrote no search.js");
  return chunk.code;
}

export async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const version = (JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as { version: string }).version;
  const ctx = siteContext();
  const opts = { sha: args.sha, repo: args.repo, version, fileExists: (path: string) => existsSync(join(REPO_ROOT, path)) };
  const site = buildSite(ctx, opts);
  const print = args.print || args.pdf ? buildSite(ctx, { ...opts, print: true }) : null;
  const problems = [...site.problems, ...(print?.problems ?? [])];
  if (problems.length) {
    console.error(`The docs website wasn't built: ${problems.length} problem(s).`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  const search = await searchScript();
  if (search.length > SEARCH_JS_BUDGET) {
    console.error(`search.js is ${search.length} bytes, over its budget of ${SEARCH_JS_BUDGET} (docs/app/performance.md).`);
    return 1;
  }
  write(args.out, [...site.files, { path: "search.js", body: search }, ...(print?.files ?? [])]);
  console.log(`search.js ${(search.length / 1000).toFixed(1)} KB (${(gzipSync(search).length / 1000).toFixed(1)} KB gzipped)`);
  console.log(`Wrote ${site.files.length} files to ${args.out} (roster ${version}, ${args.sha.slice(0, 7)})`);
  if (args.pdf) {
    const html = join(args.out, "print.html");
    rmSync(args.pdf, { force: true });
    mkdirSync(dirname(args.pdf), { recursive: true });
    // Neovim's flags: no header or footer on the sheets, no tagging (it makes the file far bigger).
    execFileSync(
      chrome(),
      ["--headless", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer", "--disable-pdf-tagging", `--print-to-pdf=${args.pdf}`, `file://${html}`],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    if (!existsSync(args.pdf) || statSync(args.pdf).size === 0) {
      console.error(`Chromium wrote no PDF at ${args.pdf}`);
      return 1;
    }
    console.log(`Wrote ${args.pdf} (${Math.round(statSync(args.pdf).size / 1024)} KB)`);
  }
  return 0;
}
