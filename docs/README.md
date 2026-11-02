# roster's docs

Everything about roster, the CLI and the app, in one place. The pages marked **:help** are also inside the app, as the same Markdown: `:help TOPIC` opens one, and `:help start` is where to begin. They're grouped the way `:help`'s index groups them. The same pages are also a website, [2styx2.github.io/roster/](https://2styx2.github.io/roster/), and one [PDF](https://2styx2.github.io/roster/roster-docs.pdf) ([how](app/help.md#on-the-web-and-on-paper)).

## Getting started

| Page | What it's for | :help |
|---|---|---|
| [app/start.md](app/start.md) | New to roster? Open a Host, find any command, coming from SecureCRT, PuTTY, Windows Terminal or Neovim | `start` |
| [app/help.md](app/help.md) | Using `:help`: topics, links and the way back, the outline, searching every page | `help` |
| [new-box.md](new-box.md) | Set up roster on a machine (a laptop, a jump host, a Claude box) | `new-box` |
| [adding-hosts.md](adding-hosts.md) | Add a network or a Host, wire it to vault items, test the logins | `adding-hosts` |

## Make it yours

| Page | What it's for | :help |
|---|---|---|
| [app/config.md](app/config.md) | Your `init.lua`: where it lives, `:config` and `:source`, every option, the sandbox | `config` |
| [app/options.md](app/options.md) | The option reference: every `init.lua` option and `roster` function, its type, default, values and an example, generated from the core | `options` |
| [app/recipes.md](app/recipes.md) | Short `init.lua` snippets to paste: the Leader, keys, Themes, fonts, layout, modules | `recipes` |
| [app/keyboard.md](app/keyboard.md) | The Leader, the two modes, every default binding, copy and paste, completion | `keyboard` |
| [app/themes.md](app/themes.md) | The bundled Themes, their colour tokens, making your own | `themes-guide` |

## Reference

| Page | What it's for | :help |
|---|---|---|
| [cli-reference.md](cli-reference.md) | `roster.yml`, resources, password providers, `discover`, every `roster` command, and `--json` output for scripts | `cli` |
| [app/errors.md](app/errors.md) | Every error: what happened, where it lives, the fix (Sessions, the vault, edits and Publish, the Mesh, Discover, Plugins) | `errors-guide` |
| [mesh.md](mesh.md) | The Mesh: Hosts that reach each other, `roster mesh`, cut, drift, ESXi | `mesh` |
| [serve-api.md](serve-api.md) | `roster serve`: the JSON-RPC API the app uses, and its error codes | `serve-api` |
| (generated in the app) | The quick reference, every command, key, option, Theme, finder and error, with what's in effect now | `quickref`, `commands`, `keys`, `options`, `themes`, `finders`, `errors`, `all` |

## Extending

| Page | What it's for | :help |
|---|---|---|
| [app/extending.md](app/extending.md) | How far roster bends: the registries `init.lua` and Plugins add to | `extending` |
| [plugins.md](plugins.md) | Writing a Plugin: installing and trusting one, permissions, the `roster` Lua module, events, limits | `plugins` |
| [plugin-api.md](plugin-api.md) | The Plugin API: every `roster.*` function and type, generated from the core, and the lua-language-server stubs | `plugin-api` |
| [../plugins/README.md](../plugins/README.md) | roster's own optional Plugins: the Mesh controls, Topology, Discover, and how to install one | |
| [../examples/plugins/recent-alerts/README.md](../examples/plugins/recent-alerts/README.md) | A worked example Plugin, and the template for yours | |
| [adr/0006-lua-plugins-and-packages.md](adr/0006-lua-plugins-and-packages.md) | Plugins and Packages, as decided | |

## What's new

| Page | What it's for | :help |
|---|---|---|
| [news.md](news.md) | What changed in each Release, by area: new, changed, removed, deprecated | `news` |
| [deprecated.md](deprecated.md) | Old names that still work, and what replaces each one | `deprecated` |

## Working on roster

| Page | What it's for |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Branches, pull requests, commits, and what docs a change needs |
| [development.md](development.md) | Working on the CLI: checks, the module map, trying it safely |
| [../app/README.md](../app/README.md) | Working on the app: the module map, the two builds, fixtures |
| [releasing.md](releasing.md) | Cutting a Release |
| [mesh-pilot.md](mesh-pilot.md) | The Mesh's research notes, and the checklist for its first run on real Hosts |
| [../GLOSSARY.md](../GLOSSARY.md) | The words, for the CLI and the app |
| [app/decisions.md](app/decisions.md) | Every design question asked about the app, and its answer |
| [adr/](adr/) | Architecture decisions for the CLI and the app |
| [app/vision.md](app/vision.md), [app/competitors.md](app/competitors.md) | Why the app exists, and how it compares |
| [app/roadmap.md](app/roadmap.md) | The iterations and what "done" means for each |
| [app/architecture.md](app/architecture.md), [app/security.md](app/security.md) | The processes, how Sessions connect; where secrets go and where they never go |
| [app/performance.md](app/performance.md) | What the app costs, and the budgets |
| [app/design/taste.md](app/design/taste.md) | roster's own design identity |
| [app/design/interface-review.md](app/design/interface-review.md) | An earlier interface review, with what it fixed |
| [app/dev/](app/dev/) | Researched notes: the Windows build loop, PTYs and WSL, xterm.js, test layout, vault sign-in |
| [app/dev/linux.md](app/dev/linux.md) | Linux and WSLg: building or fetching the Linux app, running it with its own data, measuring it, what's different on WebKitGTK |
| [app/spec/](app/spec/) | Product specs |
| [agents/](agents/) | How agents use the issue tracker, triage labels and domain docs |
