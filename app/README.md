# The roster app

A fast, keyboard-first desktop app that gets you onto any Host in your team's roster Inventory in a few keystrokes, with a shell over your own ssh. [roster](../README.md) (the CLI at the root of this repo) is the only backend: it knows the Hosts and the Logins, and the app reaches it through `roster serve`. The app is the nicest way to reach them.

> Status: **v0.2.0** released; iterations 8 and 9 on `dev` (first-party Plugins, panels docked or full window, a concurrent `roster serve`). See [roadmap.md](../docs/app/roadmap.md) and [news.md](../docs/news.md). The app was a separate repo called roster-desk until it joined this one (decision Q56, ADR 0007); an old roster-desk Config and State are copied over the first time it starts ([config.md](../docs/app/config.md)).

## Where to look

| Path | What's in it |
|---|---|
| [docs/app/vision.md](../docs/app/vision.md) | Why this exists, how it compares with SecureCRT, Termius, Tabby and XPipe, and what makes it different |
| [docs/app/competitors.md](../docs/app/competitors.md) | Sourced competitor analysis (XPipe, Termix, Termius, RDM, Tabby, WezTerm and more): matrix, config and plugins, secrets model, positioning |
| [docs/app/architecture.md](../docs/app/architecture.md) | The processes, the `roster serve` API, how Sessions connect, and the backends |
| [docs/app/security.md](../docs/app/security.md) | Where secrets go and where they never go, and how locking works |
| [docs/app/keyboard.md](../docs/app/keyboard.md) | The leader key, the two focus modes, and the default bindings |
| [docs/README.md](../docs/README.md) | Every doc, grouped as `:help`'s index groups them |
| [docs/app/start.md](../docs/app/start.md), [recipes.md](../docs/app/recipes.md), [extending.md](../docs/app/extending.md) | The start page (`:help start`), `init.lua` recipes, and how far roster bends |
| [docs/app/help.md](../docs/app/help.md) | `:help` inside the app: topics, keys, how the guides stay in sync with these docs |
| [docs/app/config.md](../docs/app/config.md) | The Config (`init.lua`): where it lives, every option, the sandbox |
| [docs/app/themes.md](../docs/app/themes.md) | The bundled Themes and their tokens |
| [docs/app/roadmap.md](../docs/app/roadmap.md) | The iterations and what "done" means for each |
| [docs/app/performance.md](../docs/app/performance.md) | What the app costs (CPU, memory, wake-ups, frames), the budgets, and `app/scripts/perf.sh` to measure them |
| [docs/app/dev/](../docs/app/dev/) | Researched, tested notes: Windows build loop from WSL, Linux and WSLg (linux.md), PTY and wsl.exe, xterm.js setup, test layout, vault sign-in |
| [docs/app/errors.md](../docs/app/errors.md) | Every error, with its message and fix |
| [docs/plugins.md](../docs/plugins.md), [docs/plugin-api.md](../docs/plugin-api.md), [plugins/](../plugins/README.md) | Writing a Plugin, its API, and roster's first-party Plugins |
| [docs/news.md](../docs/news.md) | What's new in each Release, and on `dev` |
| [docs/app/design/taste.md](../docs/app/design/taste.md) | roster's own design identity: what makes it look and feel like ours |
| [docs/app/decisions.md](../docs/app/decisions.md) | Every design question we asked and the answer |
| [docs/adr/](../docs/adr/) | Architecture decisions for the CLI and the app (0001–0002 roster serve and ssh, 0003–0006 the app, 0007 one repo, 0008 the docs website and PDF) |
| [docs/app/spec/](../docs/app/spec/) | Product specs. Start with [0001](../docs/app/spec/0001-roster-app.md) |
| [GitHub issues](https://github.com/2styx2/roster/issues) | Vertical-slice tickets (`TNN: …`) with their blockers, one milestone per iteration |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Branch model: Work branches → pull request to `dev` → `main` |
| [GLOSSARY.md](../GLOSSARY.md) | The words, for the CLI and the app |

## Stack

- Tauri: Rust core, system webview
- React, Vite and TypeScript (strict)
- xterm.js with the WebGL renderer
- roster (Python) as the backend, reached through `roster serve`

## Development

### Two builds

| | Dev build | Release build |
|---|---|---|
| Command | `app/scripts/app-dev.sh` (`--ci` the first time) | `app/scripts/app-build.sh --run` (`--installer` for the setup .exe/.msi) |
| For | working on the app: hot reload, devtools, the worst-case/fixture toggle (only with `?fixture=` or `VITE_ROSTER_APP_FIXTURES=1`) | using it day to day: optimised, no dev code, no fixtures; the fake Backend only as `:tutor`'s demo Inventory, loaded when a tutorial starts |
| Windows copy | `%LOCALAPPDATA%\roster-app-dev` | `%LOCALAPPDATA%\roster-app-release` |
| Stop | `app/scripts/app-stop.sh` | `app/scripts/app-stop.sh --release` (or just close the window) |

Both use the installed `roster` (needs `roster serve`, API 3+; asking about a new Host's host key needs API 11, Q60; Quick Connect needs API 12, ticket 14; its "Save to vault" API 13, ticket 15; signing the vault out to use a different account API 14, ticket 42; roster's sections of `:check` with no Host API 16, ticket 49; the Mesh controls need API 17 (Mesh jobs), Discover 18, Topology 19 (`mesh.status`'s `grouped`); Plugins' `job_progress` and `:check` sections that answer later need 20 (concurrent serve); cancelling and check jobs 21) unless `ROSTER_APP_ROSTER` is set, and both share the same State and `init.lua`. The scripts and the app still read the old `ROSTER_DESK_*` env var names when the new ones aren't set.

Paths below are from the repo root.

```text
Cargo.toml            workspace (repo root); default member is roster-core, so `cargo test` in WSL never builds Tauri
crates/roster-core/   Tauri-free core: Backend detection (detect.rs), `roster serve` JSON-RPC client (rpc.rs: answers matched by id in any order, `$/cancel` when it stops waiting),
                      start-up and API-version check (backend.rs), the one Backend slot (slot.rs), error kinds (error.rs), Sessions:
                      session.prepare → command (wsl --exec …, env via WSLENV) and the PTY manager (session.rs; its `fill` types a prompt's password after a no-echo probe, ticket 119),
                      the State file (state.rs), where the window reopens (window.rs), the Windows build (platform.rs),
                      Windows Terminal's settings.json → an init.lua block, previewed as a diff (wt.rs, ticket 33),
                      the ROSTER_APP_* env vars with their old names (env.rs), the one-time copy from roster-desk (migrate.rs),
                      opening a web service's URL in the default browser, http/https only, no user or password (browser.rs)
app/src-tauri/        thin Tauri shell: the window, and the commands the frontend calls (every one is in
                      `generate_handler!` in src-tauri/src/lib.rs), each a thin wrapper over roster-core
                      (+ `config-changed` events after each save of init.lua);
                      clipboard-manager plugin
app/src/backend/      the one typed Backend client: types.ts (interface), tauri.ts (real), fake.ts (fixtures)
                      fakePlugins.ts (the fake Plugin host), redact.ts (the core's cmd:/env: cut on what its Plugins get, Q92)
app/src/picker/       the Picker: match.ts (fuzzy ranking), Picker.tsx (a user@address query offers Quick Connect first;
                      a row's ⓘ or Ctrl+I shows its Host details), timing.ts (its open time, for `:info`, Q86)
app/src/details/      Host details (ticket 18, decision Q71): details.ts (roster info's fields and services as rows, which
                      URLs may open, what `:open ARG` means), HostDetails.tsx (the side panel opposite the Sidebar)
app/src/quick/        Quick Connect (ticket 14): target.ts (user@address[:port], parsed as roster's quick.prepare checks it);
                      "Save to vault" (ticket 15): hostname.ts (the box's name from its shell's title or prompt),
                      SavePanel.tsx (`:save`: name, group, Save to, then quick.save; for an
                      `auth: prompt` Host (ticket 16), Save to, then host.save_login)
app/src/platform/     State file, clipboard, Windows build: types.ts, tauri.ts, browser.ts, memory.ts (tests)
app/src/state/        appState.ts: the State's shape (recent Hosts), parsed leniently
app/src/session/      Sessions: tabs.ts (store: open/close/select/reconnect/replay/resize, outside React), Sessions.tsx
                      (terminal panes + the basic tab strip for `sessions = "tabs"`), prompt.ts (a password prompt at
                      the cursor, for the fill key's offer, ticket 119; and the Host a nested ssh is on, ticket 120),
                      sshTarget.ts (where a nested `ssh` command line goes, by ssh's rules and the Inventory),
                      HopCrumb.tsx (the breadcrumb: `esx-01 ─ esx-02`)
app/src/terminal/     TerminalView.tsx (xterm.js, WebGL → DOM; copy/paste, find, zoom), SearchBar.tsx,
                      renderer.ts (WebGL, or DOM when its context can't start or is lost; what `:info` says, ticket 20),
                      options.ts (font, colour overrides, standard ANSI palette as data), fonts.ts (which installed font is
                      in use, cells rounded as Windows Terminal does, ticket 33), keymap.ts (ticket 08's keys),
                      keys.ts (Leader filter), StubTerminal (tests)
app/src/errors/       clean connection errors (ticket 26, docs/app/errors.md): classify.ts (classifyExit: ssh's last lines +
                      exit code + askpass line → a Problem), catalog.ts (the rows as a Registry: where, fix, actions,
                      extras), ErrorPanel.tsx (the Session pane's error), CheckPanel.tsx (`:check HOST`; checkProgress.ts follows its steps as they run)
app/src/edit/         editing a Host (ticket 10): form.ts (the draft, what changed, whether it needs a test login),
                      EditPanel.tsx (`:edit`: pull, the form, test login, save), ChangesPanel.tsx (`:changes`: the diff,
                      `:discard`, `:publish`: the message, the commit's hash); adding one (ticket 11): addForm.ts (the draft, checks, Vault item suggestions,
                      host.add's params), AddPanel.tsx (`:host add`: pull, the form, host key, test login, add), SaveTo.tsx (the "Save to" choice, shared)
app/src/lock/         the Lock: useVault.ts (lock state, idle lock), idle.ts (idle timer, injectable Clock), LockScreen.tsx
crates/roster-core/src/config/
                      the Lua Config (ticket 21, docs/app/config.md): schema.rs (every option and default), lua.rs
                      (sandboxed Lua 5.4, `require` in the config dir, the `roster` table), locate.rs (file:line
                      for schema errors), watch.rs (live reload), folders.rs (folders.yml's text, read once to move its Folders in), editor.rs (`:config`: the commented-out
                      starter file, made once, and opening it in the `editor`), mod.rs (load, Loader
                      keeping the last good one)
app/src/config/       the Config in the frontend (ImportPanel.tsx: `:config import-terminal`'s diff): types.ts (the core's object), apply.ts (→ options, and keys,
                      Themes, Folders through the registries as "init.lua"), ConfigToast.tsx (errors, warnings)
examples/init.lua     every option with its default, commented (a Rust test loads it)
crates/roster-core/src/plugin/
                      Plugins (ticket 23, docs/plugins.md): mod.rs (PluginHost: one thread and Lua state per Plugin,
                      load/call/event, time budget, strikes, the manifest), runtime.rs (the `roster` module a
                      Plugin gets, by its grants; ops), permission.rs (what can be granted, the serve allow-list),
                      network.rs (`network:SITE`: the HTTP client, sites, the private-address check; Q97),
                      fair.rs (the Plugins' fair share of serve: 2 calls each, 4 in all, Q112),
                      folder.rs (a Plugin's folders are its own, Q93: `inside` for its code's files, `Storage` for
                      its data folder `plugin-data/NAME` behind `roster.storage`)
crates/roster-core/src/package/
                      Packages (ticket 24, Q83): mod.rs (Packages: clones in the app's data dir, roster.lock next to
                      init.lua; sync/pin/discard/check/apply/clean, only for what init.lua names), git.rs (system git,
                      no shell, no credentials, https/ssh/file only); tests use local bare repos
crates/roster-core/plugins/hosts/
                      the status bar's Host count, a built-in Plugin on the public API (`builtin:hosts`)
crates/roster-core/plugins/folders/
                      the Sidebar's Folders (`builtin:folders`, Q93): section, `:folder`, ␣ a / ␣ A, its Folders in
                      its own data folder; init.lua's handed over as settings, folders.yml's moved in once
app/src/plugins/      Plugins in the frontend: manager.ts (installed + grants in the State, prompts, ops → registries,
                      events, timers, the Sessions' output for terminal.read; Packages as `package:NAME`), committed.ts
                      (a Session's committed lines, from a terminal of its own, for terminal_output; OSC 133 marks for command_done), ops.ts (checks every
                      op), command.ts (`:plugins`, `:packages`), PluginsPanel.tsx (the prompt, an update's diff,
                      `:plugins`, `:packages`, a float, notices); backend/fakePackages.ts is the fake Backend's
app/src/view/status.ts  the status segment and Host-badge registries Plugins add to
app/src/view/views.ts   views and Host-details sections as registries (ticket 76): `:view`, the `views` finder, the open
                      view (ViewHost); ViewContent.tsx draws a view or section (text, facts, a table) and the view panel
app/src/panel/          every panel and view docked, at any width, or full window (ticket 95, Q106): layout.ts (the
                      choice per panel in the State over init.lua's defaults, limits, which panel keys act on),
                      PanelFrame.tsx (the frame, its draggable edge, the header's button), command.ts (`:panel`)
app/src/ui/messages.ts  the message line (Q115): which messages are quiet under `ui.messages`, the `:messages` history
app/src/ui/table.ts     a table's model: sort, updates in place, which rows are on screen; ui/DataTable.tsx draws it
app/src/graph/          a view's graph (ticket 77): model.ts (data, updates, reach), layout.ts (where nodes go), scene.ts
                      (collapsed clusters, keys, search, highlight), memory.ts (places in the State), draw.ts (the
                      canvas), lists.ts (the node and edge tables), FilterMenu.tsx (a filter dimension's checkbox menu), GraphView.tsx; plugins/graphOps.ts checks a Plugin's graph
plugins/mesh, plugins/discover, plugins/topology
                      roster's first-party Plugins (Q80, Q94), installed as Packages with `dir = "plugins/NAME"`;
                      App.mesh/discover/topology tests load them
examples/plugins/pinned the example Plugin docs/plugins.md walks through (a Rust test loads it)
examples/plugins/recent-alerts the worked example in docs/plugins.md, a third-party Plugin end to end (ticket 56): crates/roster-core/tests/recent_alerts.rs
                      installs it from a git repo and records app/src/plugins/recent-alerts.transcript.json, which
                      plugins/recentAlerts.test.ts replays against its stand-in, backend/fakeRecentAlerts.ts
app/src/registry.ts   Registry: entries by id with a source (builtin/init.lua/Plugin), ADR 0006; registries.ts = the app's set
app/src/commands/     table.ts: the ONE command table (`:` names; keys, the command line and buttons all run these)
app/src/keymap.ts     keys → command lines, as a registry of bindings; Options (Leader, vim, layout, idle lock)
app/src/keyboard/     mode.ts (Terminal mode / App mode machine, key sequences), bindings.ts + BindingsPanel (␣ K)
app/src/health/       `:check` with no Host (ticket 49): health.ts (the health section registry, the app's own sections,
                      runHealth; roster's sections come from box.check), shown as the `health` help page
app/src/help/         `:help` (ticket 37, docs/app/help.md): pages.ts (the help page registry, the pages generated from the
                      registries, topics), guides.ts (docs/app's Markdown bundled at build time), markdown.ts (that Markdown
                      → blocks, doc.ts), options.ts (config.md's option tables + each value and where it came from),
                      command.ts (`:help`, the `help` finder, HelpView, `:lookup`), lookup.ts (which topic the lookup
                      keys open: the command typed, the selected result or row, a binding's option, ticket 52), HelpPanel.tsx
app/src/tutor/        `:tutor` (ticket 55, decision Q76): tutor.ts (the tutorial registry, steps as matches on app events,
                      the progress in the State, each tutorial as a help page, roster's own), demo.ts (the demo
                      Inventory: the fake Backend's made-up Hosts, a Platform with a State in memory, and your running
                      Plugins on the core's demo Plugin host, ticket 66), command.ts,
                      plugin.ts (`roster.tutor.set`'s tutorial), DemoBanner.tsx; App.tsx keeps your workspace mounted
                      and hidden behind the demo's
app/src/news/         news.ts: what's new after an upgrade, said once in the status line (`newsSeen` in the State, ticket 47)
app/src/ui/Announce.tsx
                      a live region that speaks a count once it settles (finders, the Picker, help's search; ticket 54)
app/src/sidebar/      Sidebar.tsx (sections of rows, raised row, cursor), sections.ts (section registry, Sessions)
app/src/inventory/    the Live Inventory (ticket 28): commands.ts (`:host add|remove|rename|move`, `:group new|rename|delete`),
                      ConfirmPanel.tsx (removing a Host asks first)
app/src/folders/      Folders (GLOSSARY), now the built-in Plugin's: folders.ts (the Folder model and the `folders` registry
                      init.lua's go into), file.ts (folders.yml parsed for the one-time move, the Plugin's settings);
                      backend/fakeFolders.ts is the same Plugin for the fake Backend
app/src/cmdline/      CommandLine.tsx (␣ :, Tab completion from the command table and Host names)
app/src/theme/        Themes (ticket 09): theme.ts (the colour-token set, AppearanceOptions, terminal colours), themes.ts
                      (Roster dark/light, Gruvbox Dark, Nord, Catppuccin Mocha, Tokyo Night as a registry; docs/app/themes.md),
                      useTheme.ts (tokens → CSS variables, follows the OS), picker.ts (`:theme` and the `themes` finder,
                      ticket 30), contrast.ts (WCAG ratios and OKLab ΔE for the contrast test)
app/src/chrome/       TitleBar.tsx (frameless window's bar: mark, the toolbar, minimize/maximize/close), toolbar.tsx (the toolbar registry:
                      visible controls for common commands, decision Q65), Logo.tsx (the Gap orbit mark in Theme colours)
app/src/ui/           Keys.tsx (keycaps for every key hint), StateDot.tsx (state nodes: shape + words), CloseGlyph.tsx
app/src/styles.css    the whole look, written only against Theme tokens (no colour literals); styles.test.ts lints it
                      (no text in `--faint` or `--tone`, nothing under 11 px, :hover only for a real pointer)
app/assets/           logo-icon.svg (app icon master: Gap orbit, transparent) + the small cut, one per size on its own pixel grid (logo-icon-small-16/20/24.svg, logo-icon-small.svg for 32 px), logo.svg / logo-small.svg (on the Ink tile, for a README or avatar), logo-mark*.svg (Theme colours, no tile), logo-mono*.svg (one colour); `npm run icons` renders src-tauri/icons
docs/app/design/      taste.md, the interface review, Theme screenshots (themes/, made from the fake Backend)
app/src/App.tsx       connect → error screen, Lock gate, Standard layout; routes keys through mode.ts to commands
app/scripts/app-*.sh  Windows build loop from WSL (sync, tauri dev, stop)
app/src/docs-site/    the docs website and PDF (ticket 46, ADR 0008): site.tsx renders every help page with HelpPanel's
                      HelpDoc and help/doc.css, writes tags.json, tag.html, print.html; the build fails on a dead link
                      search.ts + client.ts: the search box (ticket 65), :help's topic ranking and :helpgrep's
                      matching over search-index.js; entry.ts is bundled into the site's search.js
app/scripts/gen-docs-site.ts  `npm run docs` (`-- --out DIR`, `--pdf FILE`): writes it, and bundles search.js; run through vite-run.mjs
                      (Vite's module runner, so the app's `?raw` imports work)
app/scripts/perf.sh   measuring (docs/app/performance.md): `browser`, `windows [--build]`, `serve`;
                      perf/serve.py is a stand-in `roster serve` (made-up Hosts, Sessions that print a busy log;
                      `--latency DIR`: a `latency` Host whose Session, perf/latency.py, measures the terminal path)
app/scripts/linux-run.sh  the Linux build (ticket 20, docs/app/dev/linux.md): `build`, `fetch` (CI's), `run` and
                      `measure` with its own HOME and XDG dirs (opens a window), `report`
app/src/terminal/hold.ts  a hidden terminal holds its Session's output until it's shown (questions go through)
```

**Checks** (run all before a commit):

```bash
cd app && npm ci       # once, in WSL
npm run check          # in app/: tsc --noEmit + eslint + Vitest (UI tests use the fake Backend)
cargo test             # at the root: roster-core only (WSL can't build app/src-tauri: no webkit2gtk)
cargo clippy -p roster-core --all-targets -- -D warnings && cargo fmt --check
```

Separately: `npm run typecheck`, `npm run lint`, `npm test`.

**UI in a plain browser** (fake Backend, no Tauri): in `app/`, `npm run dev -- --port 5179`, then open
`http://localhost:5179/?fixture=many-hosts`. Other fixtures: `few-hosts`, `slow`, `roster-too-old`,
`roster-missing`, `inventory-missing`, `no-wsl`. The app opens locked: the fake master password is
`correct horse`. `&theme=roster-light|gruvbox|nord|catppuccin-mocha|tokyo-night` picks a Theme (default: follow the OS). Vault fixtures: `locked` (the default), `not-logged-in`, `missing-cli`, `no-vault` (no lock screen). Sign-in fixtures (ticket 31; email `you@example.com`, codes `123456`, API key `user.fake-client` / `fake-client-secret`): `sign-in` (new-device code), `sign-in-2fa` (method picker), `sign-in-totp`, `sign-in-fido2` (unsupported), `sign-in-sso`, `sign-in-eu`, `sign-in-rate-limited`. Editing (ticket 10, API 5): `edit`, `edit-pending` (two Pending changes), `edit-diverged` (the pull fails). Adding (ticket 11, API 6): `add` (a new Host's password is `host pass`; anything else is refused). Un-reviewing (API 9): `review`. Connecting (issue #54): `slow-login` (Sessions take 1.2 s to start and 2.5 s to log in). Host keys (ticket 36, API 11): `host-key` (every first Session asks about the Host's key), `host-key-changed` (the key changes before Trust). Quick Connect (ticket 14, API 12): `quick` (any `user@address` takes the password `host pass`, or none; `10.0.0.66` doesn't answer, `10.0.0.43`'s key differs from the recorded one, `10.0.0.23`'s changes before the connect). Save to vault (ticket 15, API 13): `quick-save` (`root@10.0.0.5` with `host pass` and the tick logs in as `nas-01`; a vault item `dup ssh` is already there). `prompt-save` (ticket 16: the first Host's Login is `auth: prompt`; its password is `host pass`). Signing out (ticket 42, API 14): `sign-out` (locked as `you@example.com`; "Use a different account" and `:vault signout` sign it out, and the sign-in form takes the same fake account). Health (ticket 49, API 16): `health` (`:check` with no Host finds a vault CLI that isn't logged in, a Host since the last sync and Pending changes). `:check HOST` live (ticket 110, API 22): `check-live` (each step starts 0.7 s after the last), `check-hang` (the TCP step never ends), `check-stopped` (every check stopped at Host key, as a lock would). Plugins (ticket 79): `recent-alerts` (the example Plugin installed as a Package, no vault, and two Sessions whose logs have alerts: its section, badges, `⚠` count, finder and float, headless). Graphs (ticket 77): `plugin-graph` (a made-up map of this Box and 640 Hosts in 16 clusters, `:view demo-map` or `␣ y m`; `w` on a node turns its edge live and back, so the draw-in can be seen), `plugin-graph-worst` (2,000 Hosts in 40 clusters with long, unbreakable, non-Latin and emoji names).
Host details (ticket 18): every fixture's Hosts have services by type (none on `linux-*`, a web UI on most others, and on `nas-*` a web UI, an `admin` UI with its own Login, and SMB); in `worst-case`, `server-10-19-77-203-…` has 40 services, long names and URLs, and one URL with a password in it that's never drawn or opened.
Worst case (ticket 27): `worst-case` (1,284 Hosts, 50 Sessions, 100 Folders, long, odd and missing values),
`worst-case-empty`, `worst-case-one`, `worst-case-start`, `worst-case-vault`; a dev build shows a
"Demo data / Worst case" toggle at the bottom to switch between them (`&toggle=off` hides it; it works in
`tauri dev` too, and never ships).

**The real app on Windows** (from the WSL checkout; see `docs/app/dev/windows-build-loop.md`):

```bash
app/scripts/app-dev.sh --ci     # sync to %LOCALAPPDATA%\roster-app-dev\src, npm ci in src\app, tauri dev (opens the window)
app/scripts/app-dev.sh      # later runs; edits need only app/scripts/app-sync.sh (Vite HMR / cargo rebuild)
app/scripts/app-stop.sh     # stop node, the tauri CLI and the app (killing the WSL job leaves them running)
```

Parallel worktrees each get their own Windows copy with `ROSTER_APP_WIN_DIR=roster-app-dev-NN` (default
`roster-app-dev`) on all three scripts; only one `tauri dev` can hold port 1420 at a time, so give the others
`ROSTER_APP_WIN_PORT=14NN`. Two app windows at once also need separate WebView2 profiles, or the second fails
with WebView2 error 0x8007139F: `export WEBVIEW2_USER_DATA_FOLDER='C:\Users\you\AppData\Local\roster-app-dev-NN\webview2'
WSLENV=WEBVIEW2_USER_DATA_FOLDER` before `app/scripts/app-dev.sh`.

**Which roster runs.** On Windows the app probes the default WSL distro first, then only distros that are
already Running (`wsl -l -v`); it never starts a stopped non-default distro, because booting one can break WSL
interop for every distro (OracleLinux_9's systemd-binfmt removed `WSLInterop`, see `docs/app/dev/tauri-pty-wsl.md`).
To use a stopped distro, set `ROSTER_APP_WSL_DISTRO=<name>`: only that distro is probed, and started if needed
(`app/scripts/app-dev.sh` passes it through `WSLENV`). Each probe runs `bash -lc` to find
roster's absolute path (`~/.local/bin` added) and a `roster.yml` (`$ROSTER_CONFIG`, `~/roster.yml`,
`~/.config/roster/roster.yml`, `~/infra/roster.yml`), then starts
`wsl.exe -d <distro> --cd ~ --exec /usr/bin/env PATH=<login PATH> <roster> -c <roster.yml> serve` with no console window (the login PATH so roster finds `bw` in `~/.local/bin`). On Linux it starts
roster locally the same way. To use another roster command, set `roster_command` in `init.lua`
(docs/app/config.md), or `ROSTER_APP_ROSTER`, split on spaces, which wins over it (as `ROSTER_APP_WSL_DISTRO`
wins over `backend = "wsl:<distro>"`):

```bash
ROSTER_APP_ROSTER="uv run --project /home/you/work/roster roster" app/scripts/app-dev.sh
```

You need this while your installed roster predates `roster serve`: the app then shows "roster is too old".
`cargo run --example detect` (in WSL, or on Windows via cmd.exe) prints what detection finds without the UI.
