#!/usr/bin/env node
// Runs a TypeScript script that imports the app's own modules (with their `?raw` Markdown and JSON)
// through Vite's module runner, the same transforms `npm run dev` and Vitest use, so scripts need
// no second toolchain (ADR 0008; ADR 0005 keeps extra libraries out). The script exports
// `main(args)`, which returns the exit code.
//   node scripts/vite-run.mjs scripts/gen-docs-site.ts --out ../site
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";
import { helpTags, jsonPick } from "./help-plugin.mjs";
import { thirdPartyNotices } from "./notices-plugin.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error("usage: node scripts/vite-run.mjs SCRIPT.ts [ARGS…]");
  process.exit(2);
}
// A component's own stylesheet (`import "./keys.css"`) means nothing outside a page: an empty
// module. Its text is still there as `./keys.css?raw`.
const noCss = {
  name: "roster:no-css",
  enforce: "pre",
  resolveId: (source) => (/\.css$/.test(source) ? "\0roster-empty-css" : null),
  load: (id) => (id === "\0roster-empty-css" ? "export {}" : null),
};
const { module } = await runnerImport(resolve(process.cwd(), script), { root, logLevel: "warn", plugins: [noCss, thirdPartyNotices, jsonPick, helpTags] });
process.exitCode = await module.main(args);
