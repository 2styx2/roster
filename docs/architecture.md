# Architecture and standards

How the code is laid out, which way each part may depend on another, where each kind of new code goes, and the standards a pull request is held to. Read it before adding a module, a file roster keeps, a serve method, a command, or any value that two modules or two languages both need. Tests enforce the layers (["Checking a pull request"](#checking-a-pull-request)); the rest is reviewed by hand.

The module maps are elsewhere: [development.md](development.md) for `src/roster/` (one line per file) and [app/README.md](../app/README.md) for the app and its Rust core. The processes and how a Session connects are in [app/architecture.md](app/architecture.md); where secrets may go is [app/security.md](app/security.md). The words are [GLOSSARY.md](../GLOSSARY.md)'s.

## The principle

**Pieces that change together live together, and nothing depends on something more volatile than itself.**

Apply it in this order when you place code:

1. **Find the owner.** Every fact has one module that owns it: a format (`keyline.py` owns the authorized_keys line), a file (`context.FILES`), a contract (serve's `@method` registry), a table (the command table). New code that touches the fact goes in, or through, its owner. Two modules that each know half a format is the bug this page exists to prevent.
2. **Point the dependency down.** A module imports only modules that change less often than it does: leaves and helpers under formats, formats under features, features under the front doors (`cli.py`, `serve.py`, `App.tsx`). When two modules both need a piece, move the piece down to where both can import it; never import upward or sideways in a circle.
3. **Generate or check every copy.** A value that crosses a language or a process (an error code, an API version, a list of steps, a Rust type the app reads) is written once and generated into the other side, or checked against it by a test. See ["One source"](#one-source).
4. **Keep the front doors thin.** `cli.py` parses and renders, `serve.py` dispatches and serialises, the Tauri shell adapts, `App.tsx` wires. Logic either door needs lives in a module both can import.

The seam vocabulary (module, interface, depth, seam, adapter) is from the `codebase-design` skill: a module earns its place when deleting it would spread its complexity over its callers; one that only passes calls through doesn't.

## The CLI

`src/roster/` is one package in six layers. A module imports only modules of its own layer or a lower one, and modules never import each other in a circle. Every import counts, including one inside a function: a lazy import still ties the two modules together.

<!-- layers:python -->
| Layer | Modules | What it is |
|---|---|---|
| `leaf` | `roster`, `errors`, `context`, `hosts`, `keyline`, `aliases`, `clihelp`, `example`, `winpipe`, `providers.bw_items_filter` | Imports nothing of roster's: the version (`roster`), the error codes and Problem, the Inventory context and its files, the Host predicates, the authorized_keys line, the CLI's tables. Everything else stands on these. |
| `base` | `common`, `winfile`, `conpty`, `providers.problems` | Shared helpers over the leaves: output, the one atomic writer, private files, running programs; a provider failure's code. |
| `format` | `sshconfig`, `boxkeys`, `boxlock`, `rotation`, `resources`, `named`, `models`, `askpass`, `vaultcli`, `jobs` | One owner per file or format roster keeps (ssh config blocks, this Box's keys, the lock, the rotation record, `inventories.json`, roster.yml's models), and the small services over them. |
| `core` | `config`, `edit`, `changes`, `claude`, `sshops`, `servemodels`, `jsondocs`, `jsonout`, `providers`, `providers.bitwarden`, `providers.builtin`, `providers.bw_login`, `providers.keepassxc`, `providers.onepassword` | roster.yml loaded, searched and edited as text; its git; ROSTER.md; ssh from this Box; the vaults; serve's and `--json`'s documents. |
| `feature` | `boxsync`, `store`, `inventories`, `newinventory`, `mesh`, `diagnose`, `fill`, `health`, `web`, `discover`, `addhost`, `fromvault`, `authorized`, `winhost`, `rotate`, `vaultsync`, `cliparser`, `completion`, `manpage` | What a command or a serve method does. Both front doors call the same function, so neither holds logic the other needs. |
| `top` | `serve`, `cli`, `__main__` | The front doors. Nothing imports them, except `__main__` → `cli` and `cli` → `serve` (the `roster serve` command). |
<!-- /layers:python -->

Rules, as `tests/test_layers.py` checks them:

- **Every module has a layer.** A new module fails the test until its row here and `LAYERS` in the test name it, in the same layer.
- **Imports go down.** An import of a higher layer fails, naming both modules, their layers and the line. Move the shared piece down instead.
- **A leaf imports nothing of roster's.**
- **Nothing imports `cli` or `serve`** but the two edges above.
- **No cycles,** but the known ones. A package and its own modules are one unit here: `providers/__init__.py` imports its providers at the end to register them, and each imports the registry back.

Known cycles, each kept on purpose (`KNOWN_CYCLES` in the test; a new one fails, and so does one listed that's gone):

- `common` ↔ `winfile`: `winfile` is `common.read_private_bytes`'s Windows half (ctypes: the owner and DACL, read through one handle). `common` imports it only inside that function and only on Windows, and it raises `common.NotPrivate`, so a caller catches one exception on every OS.

Process-wide state is in two places, and new code adds none:

- **The Inventory:** one per process, `context.current()`, set once by `config.find_config` through `context.use()`. Code that needs the Inventory's files asks the Context (`current().file("key_name")`, or its properties), never builds a path of its own.
- **The vaults:** `providers/__init__.py` holds the secrets this process unlocked, each provider's settings and state, and serve's and `--json`'s modes; `providers.reset()` forgets them all (a test calls it, never clears a dict).

## The Rust core

`crates/roster-core/` has no Tauri dependency, so WSL builds and tests all of it (`cargo test`). Its modules, bottom up:

| Kind | Modules | Rule |
|---|---|---|
| Neutral | `anchor`, `env`, `error`, `files`, `platform`, `process`, `proxy`, `wipe` | Use nothing of the crate's. Help anchors, the `ROSTER_APP_*` env vars and the data folder, error kinds, atomic writes and paths kept inside a folder, the one `Os`, the one process runner, the Plugins' proxy address, wiped secrets. |
| Parts | `config` (init.lua: schema, shape table, sandboxed Lua, watch), `package` (Packages, system git), `plugin` (the Plugin host, its API, `Op`), `session` (PTYs, fill), `screen`, `rpc` (serve's JSON-RPC client), `detect` (which Backend, the plan from init.lua), `state`, `wt`, `migrate`, `browser`, `slot`, `window` | Each owns its piece. `config` never uses `plugin` (`plugin` reads the Config). |
| Facade | `backend` (start-up and the API check, the check job, opening and filling Sessions, `pass`), `serve_api` (`PASS_THROUGH`: the methods the frontend calls as they are) | What the shell calls. |

- **The Tauri shell is an adapter.** `app/src-tauri/src/lib.rs` turns each Tauri command into one core call and its events; it holds no logic WSL can't test. A serve method the frontend calls as it is goes through the one `serve_call` (allow-listed by `serve_api::PASS_THROUGH`); a command of its own exists only where the core adds something (a secret it holds, a job, a Session).
- **Known cycle:** `config` ↔ `package`. `config::validate` checks init.lua's `packages` entries with `package::check_specs` (a Package's name and source rules, which the installer applies too), and `package` reads `config::PackageSpec`. Moving the spec rules into `config` is the fix when either side next changes.
- `crates/roster-core/tests/layers.rs` checks the neutral modules and that `config/` never uses `crate::plugin`.

## The frontend

`app/src/` is TypeScript (strict), React and xterm.js. Its modules come in four kinds:

- **The Backend client** (`backend/`): `types.ts` is the interface every feature calls, `tauri.ts` the real adapter, `fake*.ts` the fake one (tests, `?fixture=`, `:tutor`'s demo), `serveContract.ts` generated from serve, `capabilities.ts` what this serve can do. Features never call Tauri directly.
- **Feature folders** (`session/`, `inventory/`, `sidebar/`, `view/`, `errors/`, `config/`, `edit/`, `lock/`, `help/`, `graph/`, `panel/`, `plugins/`, …). A feature owns its commands (`commands.ts` or `command.ts`, with its part of `CommandContext` declared beside them), its hooks (`useX.ts`), its pure model and its components.
- **Wiring**: `App.tsx`, `main.tsx`, `app/`, `registries.ts`, `commands/builtins.ts` (`registerBuiltins`, used by the app, the docs site and the help lint), `backend/index.ts` and `backend/fixtureProps.ts` (which Backend `main.tsx` starts), and `docs-site/`. Wiring imports features; no feature imports wiring. `App.tsx` only calls feature hooks and draws the layout: a new feature adds a hook in its folder and one line here.
- **The Plugin API** (`plugins/`): `manager.ts` (installed Plugins, grants, loading, calls, events), `opRegistry.ts` (one `{parse, apply}` per op kind), `ops.ts` (op types and field checks), `core.gen.ts` (the core's tables, generated). A Plugin reaches the app only through ops; a feature reaches a Plugin only through its registry.

### Pure modules and components

A pure module holds data and rules with no component: a test, the docs build or another feature can load it alone. It may use React hooks, never a `.tsx` module. The pure modules are `sidebar/model.ts`, `session/status.ts`, `graph/model.ts`, `ui/table.ts`, `ui/when.ts`, `ui/dot.ts`, `backend/capabilities.ts`, `panel/stack.ts`, `view/segments.ts`, `edit/diff.ts` and `plugins/sessionEvents.ts` (`PURE` in `app/src/architecture.test.ts`). A component file (`.tsx`) draws; when a type or a word list that a component defines is needed elsewhere, move it into a pure module (as `ui/dot.ts` holds `StateDot`'s states and words).

### The docs build runs under Node

`npm run docs` builds the website from the same pages as `:help`, under Node through Vite's module runner (`scripts/vite-run.mjs`), which loads modules differently from Vitest and the app's bundle. The docs site, `help/pages.ts` and `commands/builtins.ts` never load `@xterm/*`, a `terminal/*.tsx` view or `plugins/manager.ts` (which loads xterm through the Sessions' output feed). A command that needs the manager takes the narrow part it uses (`PluginCommands`), and the docs pass an inert one. `app/src/docs-site/build.test.ts` runs the real build into a temp folder, so a break shows in `npm run check`.

### Dependencies between folders

Modules never import each other in a circle, and feature folders depend one way: the test finds every cycle between folders, of any length (the strongly connected folders), not only pairs. The fake Backend counts as an adapter of its own beside `backend/`, and `config/`'s data (`core.gen.ts`, `types.ts`, `defaults.ts`, `ranges.ts`, which `terminal/options.ts` and `panel/layout.ts` read) counts apart from applying it (`apply.ts`, `useConfigActions.ts`). Shared helpers with no feature of their own (`Clock` in `ui/clock.ts`) go in `ui/`. The folder imports that go up today, each listed with its reason in `KNOWN_BACK_EDGES` (the list only shrinks; an entry that no longer closes a cycle fails too):

- `theme` → `terminal`: `terminal/options.ts` holds the ANSI palette a Theme is made of, and the terminal is drawn with the Theme.
- `platform` → `terminal`: the browser and Tauri Platforms probe fonts with `terminal/fonts.ts`; the terminal asks `platform/os.ts`.
- `plugins` → `tutor`: `opRegistry.ts` applies every op kind into its feature, the tutorial's too; `tutor/demo.ts` loads the demo's Plugins.

## Where new code goes

| You're adding | Where it goes | Then |
|---|---|---|
| A serve method | Its handler in `serve.py` under `@method("area.verb", deadline=, locks=, lane=, cancel=, sensitive=)`, its docstring's `Params:`, `Result:`, `Errors:`, `Since: API N`; the logic in a feature module the CLI can share; params and result as models in `servemodels.py` | Name it in a `<!-- BEGIN generated:methods … -->` marker in `docs/serve-api.md`, run `uv run python scripts/gen-serve-api.py`, bump `API_VERSION` if the app must know. The app calls it through `PASS_THROUGH` (`serve_api.rs`) when it passes as it is; otherwise a `Backend` method in `backend.rs` and a Tauri command in `lib.rs` (and `generate_handler!`), `tauri.ts`, `types.ts`'s `Backend` (a method whose params and result are models gets their TypeScript types in `serveContract.ts`; `types.ts` writes the rest by hand), `fake.ts`. A Plugin may call it only once `plugin/permission.rs` lists it. |
| An error code | Its name and number in `errors.py`, raised as `die(msg, code=NAME)` or a `Problem` | Run `gen-serve-api.py` (the app and core read it by name from the contract), a row in `docs/app/errors.md` and in `app/src/errors/catalog.ts`, or the code on `NO_ROW` in `catalog.test.ts`. The code in `docs/serve-api.md` if serve returns it. |
| A CLI command or option | The option in `cliparser.py` (`build_parser`; tag a name-taking argument for completion), its description and examples in `clihelp.py`, `cmd_x` in `cli.py` that calls a feature module and prints | Its section in `docs/cli-reference.md`, `uv run python -m roster.manpage`, an old name in `aliases.py`. |
| A file roster keeps per Inventory | A row in `context.FILES` (folder, unnamed name, named pattern, `delete` or `set aside` on `inv remove`) | Read it as `current().file(kind)`. `inv remove` walks the table. |
| A piece of a format on disk | Its owner: `keyline.py` (authorized_keys lines, markers, the key scripts' output), `sshconfig.py` (Host blocks, roster's header), `claude.py` (ROSTER.md), `boxkeys.py`, `rotation.py`, `named.py`, `edit.py` (roster.yml as text), `models.py` (roster.yml's meaning) | `winhost.py`'s PowerShell regexes come from `keyline.powershell`, never a second copy. Write through `common.replace_file` or `write_private`; roster.yml through `store.write`, which syncs this Box. |
| A Host fact (Windows, password Login, placeholder user) | A predicate in `hosts.py`, or a field on `models.Host` | |
| An `init.lua` option | Its declaration in `crates/roster-core/src/config/shape/table.rs` (type, default, allowed values and bounds, summary, example) and its field in `config/schema.rs` | `cargo run -p roster-core --example gen_config_options`; a row in `docs/app/config.md`. The app reads bounds from `config/ranges.ts`, defaults from `config/defaults.ts`, both generated data. Raise `CONFIG_VERSION` when a name changes meaning (CONTRIBUTING.md, "Lua API"). |
| An app command | The feature's `commands.ts` (a `CommandDef` with `label`, `area`, `doc`), what it needs from the app as that feature's part of `CommandContext`, provided by the feature's hook | Listed in `commands/table.ts`, or registered in `registerBuiltins` when it acts on the app's own registries. Keys in `docs/app/keyboard.md`. |
| A panel | A component in its feature, opened and closed through `panel/stack.ts` (`usePanelState`, a `Layer` with its id; `closeTop` for Esc) | Its default placement in `panel/layout.ts`. Focus identity is the Layer's id (`inLayer`), never a CSS class. |
| A feature that needs a newer serve | A `FEATURES` entry in `backend/capabilities.ts` (`since`: the method's version from `serveContract.ts`'s `SINCE`/`FORMS`, `what`: what the user tried) | Gate with `caps.has(feature)`, refuse with `caps.needsNewer(feature)`; nothing else compares `api_version`. A fake or a test that speaks "just enough" asks `sinceOf(feature)`. |
| A Plugin API function, value or event | Its declaration and binding in `crates/roster-core/src/plugin/api/<module>.rs` | `cargo run -p roster-core --example gen_plugin_api` (reference, stubs, `plugin-api.json`, `app/src/plugins/core.gen.ts`). |
| A Plugin op | A variant of `Op` in `plugin/op.rs`, sent by the binding | Its `{parse, apply}` entry in `app/src/plugins/opRegistry.ts`, field checks in `ops.ts`; a kind without an entry doesn't compile. |
| A Rust type the app reads | `#[cfg_attr(feature = "ts", derive(ts_rs::TS))]` on the type, listed in `crates/roster-core/tests/ts_types.rs` | `ROSTER_WRITE_TS=1 cargo test --test ts_types` writes `app/src/config/core.gen.ts`; `config/types.ts` names it for the app. |
| A stand-in for tests | Python: a program in `tests/fakes/` driven by `FAKE_*` env vars (the `fakes` fixture puts them on PATH). App: the fake Backend in `backend/fake*.ts`. Rust: `crates/roster-core/tests/fake_serve.py` | Share data with the real side rather than port it: a fixture both read (`demo-mesh.json`), a transcript the real core records and the fake replays (`ROSTER_UPDATE_TRANSCRIPT=1 cargo test --test plugin_mesh` writes `app/src/plugins/mesh.transcript.json`). |
| An end-to-end scenario | The e2e suites: `tests/e2e/` for the CLI and `roster serve` against real sshd in containers (`scripts/e2e.sh`, `--compare REF` diffs another ref's behaviour against this one; [development.md, End-to-end suite](development.md#end-to-end-suite)), `app/e2e/` for the frontend in headless Chromium (`npm run e2e`) <!-- e2e: app full-stack suite filled after merge --> | |
| A new module | Python: its layer in this page's table and in `tests/test_layers.py`, a line in `development.md`. App: its folder by owner, a line in `app/README.md` | |

## One source

Never hand-copy a value across languages or modules: generate it from its source, or check the copy with a test. A generated file says so at its top; edit its source and regenerate, never the file.

| Generated | From | Regenerate | Fails when stale |
|---|---|---|---|
| `docs/serve-api.md`'s tables, `docs/serve-contract.json`, `app/src/backend/serveContract.ts` | `serve.py`'s `@method` registry and docstrings, `errors.py`, `models.py` and `servemodels.py` | `uv run python scripts/gen-serve-api.py` | `tests/test_serve_api_doc.py`; `backend.rs`'s `contract` tests read the JSON (codes, API versions, deadlines, `PASS_THROUGH`, the Plugin serve list) |
| `docs/plugin-api.md`, `examples/plugins/types/roster.lua`, `crates/roster-core/tests/fixtures/plugin-api.json`, `app/src/plugins/core.gen.ts` | `crates/roster-core/src/plugin/api/` | `cargo run -p roster-core --example gen_plugin_api` | `crates/roster-core/tests/plugin_api.rs` |
| `docs/app/options.md`, `examples/types/roster-config.lua`, `crates/roster-core/tests/fixtures/config-options.json`, `config-version/N.json` | `crates/roster-core/src/config/shape/` | `cargo run -p roster-core --example gen_config_options` | `tests/config_shape.rs`, `tests/config_version.rs` |
| `app/src/config/core.gen.ts` | the Rust types listed in `tests/ts_types.rs` | `ROSTER_WRITE_TS=1 cargo test --test ts_types` | `tests/ts_types.rs` |
| `crates/roster-core/tests/fixtures/config-defaults.json` | `Config::default()` | `UPDATE_FIXTURES=1 cargo test --test config` | `tests/config.rs` |
| `app/src/plugins/*.transcript.json` | the real Lua of each first-party Plugin, in one scripted run | `ROSTER_UPDATE_TRANSCRIPT=1 cargo test --test plugin_mesh` (or `plugin_discover`, `plugin_topology`, `recent_alerts`) | the same Rust tests; the TS tests replay them against the fakes |
| `src/roster/roster.1` | `cliparser.build_parser` and `docs/cli-reference.md` | `uv run python -m roster.manpage` | `tests/test_manpage.py` |
| `crates/roster-core/tests/fixtures/repaints.json`, `repaint-fuzz.json` | `scripts/gen-repaint-cases.py`, the core's verdicts | the script, then `ROSTER_WRITE_REPAINT_FUZZ=1 cargo test -p roster-core --lib repaint_fuzz` | `screen.rs`'s tests and `app/src/terminal/repaints.test.ts` |

Shared fixtures that two implementations both read: `tests/vectors/redaction.json` (the `cmd:`/`env:` cut, in `jsonout.py` and the core's `runtime.rs`), `crates/roster-core/tests/fixtures/demo-mesh.json` (`:tutor`'s Mesh in `plugin/demo.rs` and `backend/fake.ts`), `web-urls.json` (which URLs open, in `browser.rs` and `details/details.ts`), `plugin-permissions.json` (each permission's words). Add a case to the fixture, not to one side's tests.

## Standards

- **Errors carry their code.** Python: `die(msg, code=NAME)` or raise `errors.Problem`; a provider's failure is a `providers.problems` kind with its code; serve and jobs answer through `errors.problem_of`. Rust: `CallError` and `ErrorKind`. The app switches on the code (`Code.NAME` from `serveContract.ts`). Never parse a message's text to learn what happened.
- **No new process-wide mutable state.** Python has the two above (["The CLI"](#the-cli)), the core the one Backend slot (`slot.rs`). Pass what a function needs; a test sets state up through public functions.
- **No pass-through modules or functions.** A wrapper that only renames a call is deleted and its callers call the owner. The deletion test: if removing a module makes no complexity reappear, it shouldn't exist.
- **No parameter for one caller, no extension point for a second adapter that doesn't exist.** Add the seam when the second caller or adapter arrives.
- **A swallowed error says why in one line** at the `except`/`catch`/`let _`: what fails there and why carrying on is right. Otherwise it propagates.
- **No fixed sleeps,** in code or tests. Wait for the event (a notification, a file, a process exit) with a deadline; tests use fake timers or poll for the condition.
- **Comments state what the code can't:** OpenSSH's, Windows' or a vault CLI's behaviour, a decision (`Q129`), why a rule exists. A comment that restates the code is deleted.
- **Tests check behaviour** through public functions, the stand-ins in `tests/fakes/` and the fake Backend. Not: a test that repeats the implementation (compares a function with its own body), one that can't fail (an assertion that's always true, or none), or one that reaches into private names (`_bw`, a module global, a private field's length).
- **Secrets** go only where [app/security.md](app/security.md) says, with its one exception (Q129: `session.fill`'s password, to the core and straight to the PTY).
- **Python data shapes** are Pydantic models; new modules go on pyright's strict list ([development.md](development.md#languages-and-types)).

## Anti-patterns seen before

Each was in the code until the untangle refactor (#504); do the second half instead.

- **Per-method tables** (serve had eight: deadlines, locks, lanes, cancel, sensitive, …) and `if method == "…"` in dispatch. → One `@method(...)` per handler.
- **Message-text sniffing** (`"[N] "` prefixes inside `die()` text, `removeprefix("error: ")` in eleven places, a regex over winhost's messages). → A coded `die`, a `Problem`, `problem_of`.
- **Module globals** for the Inventory (`common._inventory`, swapped by rotation). → `context.Context` and its `FILES` table.
- **A format known in five places** (the authorized_keys tag alternation, the Host block, roster's ssh config header, `NO_PASSWORD`). → One owner module; the others import it or generate from it.
- **Two writers of one file** (ROSTER.md, four atomic writers). → One writer, in the owner.
- **The CLI as a library** (`addhost` importing `cli` and building a fake argparse `Namespace`). → The logic in a feature module both doors call.
- **Thirty pass-through Tauri commands** with three names each (`lib.rs`, `tauri.ts`, `types.ts`). → One allow-listed `serve_call`.
- **Shell logic in the Tauri crate,** untestable in WSL. → The core, behind a `Backend` method.
- **Hand copies across languages** (21 `*_API_VERSION` constants, error codes as literals in the catalog and `backend.rs`, the check steps, a Rust type rewritten in TS). → Generated contract files and `core.gen.ts`.
- **"Needs a newer roster" in fourteen places,** and the API version compared in thirteen. → `capabilities.ts`.
- **`App.tsx` at 3000 lines.** → Feature hooks and components; `App.tsx` wires them (under 1000 lines).
- **Two 30-case switches** over a Plugin op's kind. → The `Op` enum and one `opRegistry` entry per kind.
- **Fakes as hand ports** of the core (the demo Mesh written twice, the core's tables copied into `fakePlugins.ts`). → A shared fixture, a generated table, or a transcript the real core records and the fake replays. `fakePlugins.ts`, `fakeMesh.ts`, `fakeTopology.ts` and `fakeDiscover.ts` still port the core's behaviour (running the real core under Vitest instead is the owner's call): new behaviour there gets a transcript.
- **A handshake with retries and sleeps,** and a `NOT_YET` string match. → Stateless calls that carry what they need.
- **CSS-class identity for focus** (which panel has the keys, told by its class name), and a close function per panel chained by hand. → The panel stack: a `Layer` id (`inLayer`), `closeTop`.
- **A pure type in a component file** (`Dot` in `StateDot.tsx`), so the model loaded a component. → A pure module.
- **The docs build importing the PluginManager,** which loaded xterm under Node. → A narrow interface (`PluginCommands`); the docs build in `npm run check`.
- **Tests that patch internals** (`bitwarden._bw`, a deadline's private field) or guess at timing (`sleep(0.5)`). → Drive the stand-in (`FAKE_BW_SLOW`, `FAKE_BW_CREATE_HANG`), wait for the condition.

## Checking a pull request

Run the checks CI runs (or `scripts/check-local.sh`, [development.md](development.md#checking-before-you-push)):

```bash
uv run ruff check src tests scripts app/scripts && uv run pyright && uv run pytest -n auto
cd app && npm run check            # tsc, ESLint, Vitest, the docs build
cargo test && cargo clippy -p roster-core --all-targets -- -D warnings && cargo fmt --check
```

The structure tests, each failing with the rule and this page's section:

| Test | Guards |
|---|---|
| `tests/test_layers.py` | Python: every module has a layer, imports go down, leaves import nothing, nothing imports `cli`/`serve`, no new cycle, the table here matches the test's |
| `app/src/architecture.test.ts` | App: the docs site and `:help` load no xterm, terminal view or PluginManager; pure modules load no `.tsx`; only wiring imports wiring; no module cycle; no folder cycle (of any length) but through `KNOWN_BACK_EDGES` |
| `app/src/docs-site/build.test.ts` | `npm run docs` builds under Node |
| `crates/roster-core/tests/layers.rs` | Rust: the neutral modules use nothing of the crate's; `config/` doesn't use `plugin` |
| `crates/roster-core/tests/backend.rs`, `backend.rs`'s `contract` tests | `PASS_THROUGH` holds no method the core keeps (Q129) and only methods serve has |
| The "Fails when stale" column above | Every generated file matches its source |

Then read the diff against this page: each new fact has one owner, each copy is generated or checked, each new module sits in its layer, `cli.py`, `serve.py`, `lib.rs` and `App.tsx` gained wiring, not logic.
