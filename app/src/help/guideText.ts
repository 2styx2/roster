// The guides' text: the help chunk (T213, decision Q189). Only text.ts imports it, with `import()`,
// so Vite builds it as a chunk of its own (`guideText-*.js`) that the app reads from its own files
// the first time help needs it; the startup chunk never carries it (scripts/check-bundle-size.py
// checks). The Markdown in docs/ is the one copy: Vite reads it as text (`?raw`) when the app is built.
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
import serveApi from "../../../docs/serve-api.md?raw";
// The Plugin API is bundled once, as data (Q189, T228): the reference (docs/plugin-api.md) and the
// stubs (roster.lua) are both written from it here. The commands' part is startup's own pick, shared.
import * as pluginApiData from "../../../crates/roster-core/tests/fixtures/plugin-api.json?pick=api_version,values,modules,functions,events,types,serve_results,lua_doc,errors_doc";
import { commands } from "../../../crates/roster-core/tests/fixtures/plugin-api.json?pick=api_version,commands,roster_only,tags";
import notices from "virtual:third-party-notices";
import { version as APP_VERSION } from "../../package.json";
import { luaStubs } from "./luaStubs";
import { pluginApiDoc } from "./pluginApiDoc";

const pluginTypes = `# roster.lua: the Plugin API's types

The whole [Plugin API](../../../docs/plugin-api.md) as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations. \`:plugins types PATH\` writes it as \`types/roster.lua\` in your Plugin's folder (or save it there yourself); point lua-language-server at it: [Editor support](../../../docs/plugin-api.md#editor-support). It's the copy this app was built with, so it matches this app's API.

\`\`\`lua
${luaStubs(pluginApiData)}
\`\`\`
`;

// `:version` (T180): the licences every copy of the app must carry, and where the installers put them.
const version = `# roster ${APP_VERSION}

roster is open source under the Apache License, version 2.0 (Apache-2.0): \`LICENSE\` has its text. Some of the app's code comes from other projects, under their own licences: \`THIRD-PARTY-NOTICES\`, below, lists each part with its copyright and licence. What changed in this version: [What's new](docs/news.md).

## Where they're installed

Every download carries \`LICENSE\` and \`THIRD-PARTY-NOTICES\`, side by side:

| Download | Where |
|---|---|
| Windows \`-setup.exe\` and \`.msi\` | In the folder the app is installed in, next to \`roster-app.exe\` |
| Linux \`.deb\` | \`/usr/lib/Roster/\` |
| Linux \`.AppImage\` | Inside the image, at \`usr/lib/Roster/\` (\`--appimage-extract\` unpacks it) |
| macOS \`.dmg\` | \`Roster.app/Contents/Resources/\` |
| The \`.zip\` and \`.tar.gz\` | Next to the app |

## Third-party notices

\`\`\`text
${notices.trimEnd()}
\`\`\`
`;

/** Each guide's Markdown, by its id (guides.ts). */
export const guideTexts: Readonly<Record<string, string>> = {
  start,
  help,
  "new-box": newBox,
  "adding-hosts": addingHosts,
  config,
  recipes,
  keyboard,
  "themes-guide": themes,
  "errors-guide": errors,
  cli,
  mesh: meshGuide,
  "serve-api": serveApi,
  extending,
  plugins,
  "plugin-api": pluginApiDoc({ ...pluginApiData, commands }),
  "plugin-types": pluginTypes,
  version,
  news,
  deprecated,
};
