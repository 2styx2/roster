// `:version`'s help page shows THIRD-PARTY-NOTICES as the build had it (T180, src/help/guides.ts). It's
// one file at the repo's root, which server.fs.allow can't name on its own, so it comes in as a module
// of its own: `import notices from "virtual:third-party-notices"`. vite.config.ts (the app, Vitest) and
// vite-run.mjs (the docs website) both use this plugin.
import { readFileSync } from "node:fs";

const ID = "virtual:third-party-notices";

/** The Vite plugin that serves THIRD-PARTY-NOTICES's text as `virtual:third-party-notices`. */
export const thirdPartyNotices = {
  name: "roster:third-party-notices",
  resolveId: (id) => (id === ID ? `\0${ID}` : null),
  load: (id) =>
    id === `\0${ID}` ? `export default ${JSON.stringify(readFileSync(new URL("../../THIRD-PARTY-NOTICES", import.meta.url), "utf8"))};` : null,
};
