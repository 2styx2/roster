// The Vite plugins behind lazy `:help` (T213, decision Q189). vite.config.ts (the app, Vitest) and
// vite-run.mjs (the docs website) both use them.
//
// - `virtual:help-tags`: the tag table, every guide's topics, made at build time by running
//   src/help/tagTable.ts over the guides' text (through Vite's module runner, so `?raw` and the
//   rest work as in the app). Startup reads it, so the guides' text stays in its own chunk.
// - `FILE.json?pick=a,b,c`: only those top-level keys of a JSON file, as named exports. A module is
//   in one chunk, so startup and the help chunk each pick their own part of plugin-api.json, and
//   neither carries the other's.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";
import { thirdPartyNotices } from "./notices-plugin.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAGS = "virtual:help-tags";
const PICK = "\0roster-json-pick:";

/** `FILE.json?pick=a,b`: those keys of FILE as named exports. */
export const jsonPick = {
  name: "roster:json-pick",
  enforce: "pre",
  resolveId(source, importer) {
    const m = /^(.*\.json)\?pick=([\w,]+)$/.exec(source);
    if (!m) return null;
    const file = isAbsolute(m[1]) ? m[1] : resolve(dirname(importer ?? `${APP}/index.html`), m[1]);
    // `|` rather than `?`: an id that ends in `.json` or has `.json?` is Vite's JSON plugin's.
    return `${PICK}${file}|${m[2]}`;
  },
  load(id) {
    if (!id.startsWith(PICK)) return null;
    const [file, keys] = id.slice(PICK.length).split("|");
    this.addWatchFile(file);
    const data = JSON.parse(readFileSync(file, "utf8"));
    return keys
      .split(",")
      .map((k) => {
        if (!(k in data)) throw new Error(`${file} has no key ${k}`);
        return `export const ${k} = ${JSON.stringify(data[k])};`;
      })
      .join("\n");
  },
};

/** `virtual:help-tags`: src/help/tagTable.ts's table, as the build has the guides. */
export const helpTags = {
  name: "roster:help-tags",
  resolveId: (id) => (id === TAGS ? `\0${TAGS}` : null),
  async load(id) {
    if (id !== `\0${TAGS}`) return null;
    const { module, dependencies } = await runnerImport(resolve(APP, "src/help/tagTable.ts"), {
      root: APP,
      configFile: false,
      logLevel: "warn",
      plugins: [jsonPick, thirdPartyNotices],
    });
    for (const dep of dependencies ?? []) if (isAbsolute(dep)) this.addWatchFile(dep);
    return `export default ${JSON.stringify(module.tagTable())};`;
  },
};
