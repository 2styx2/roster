# Contributing to roster

One branch model for the whole repo: the Python CLI at the root and the roster app in `app/` + `crates/roster-core/`. Every change, to either half, reaches `dev` through a GitHub pull request that the maintainer reviews and merges.

## Branches

| Branch | Cut from | Merges into | Who merges | How |
|---|---|---|---|---|
| `feat/*` `fix/*` `chore/*` `docs/*` | `dev` | `dev` | the maintainer (a human), after review | pull request (`gh pr create --base dev`), merged with a merge commit |
| `dev` | — | `main` (Release) | the maintainer | pull request, merge commit, then tag `vMAJOR.MINOR.PATCH` |
| `hotfix/*` | `main` | `main`, then back-merge `main` → `dev` | the maintainer | pull request, merge commit |

- **Nobody commits directly to `main` or `dev`.** All work happens on Work branches and lands through a pull request with CI green. GitHub enforces it: `main` and `dev` take changes only through an approved pull request, can't be force-pushed or deleted, and only the maintainer can bypass that (for an urgent hotfix).
- **Exceptions to a rule are written down with their full reasoning.** Only the maintainer makes an exception to a rule in this file, `.claude/CLAUDE.md` or `docs/app/security.md`. Each one gets a decision row in `docs/app/decisions.md`: the rule, exactly what the exception allows and what it still forbids, why the rule couldn't hold there, the alternatives and why they lost, the risks, and the limits that keep it narrow. Everywhere the rule is stated then names the exception and points at that row, in the same pull request. The first one is Q129: the Rust core may hold a password for `session.fill` only.
- **The repo is public.** Nothing from a real network goes in: no real host names, address ranges, company names, emails or secrets, in code, tests, docs, commits, issues or pull requests. Use made-up examples.
- **One Work branch per ticket**, named `feat/NN-short-slug` after ticket TNN (a GitHub issue), or `fix/…`, `docs/…`, `chore/…`. A ticket that changes both the CLI and the app is one branch and one pull request.
- **A ticket that needs another ticket's unmerged work** is cut from that ticket's branch, so the branches stack; open its pull request against `dev` once the first one is merged (or against the first branch, retargeted later). If it needs two, merge both into the new Work branch. Merging into a Work branch is fine. Merging into `dev` is not.
- **First Release of the app after iteration 4** (decisions Q48, Q70). Iterations 1–4 all build up on `dev`, and each one is tested by hand before the next starts. After iteration 4, `dev` merges into `main` and is tagged `v0.1.0`. After iteration 7, the next Release is tagged `v0.2.0`. How to cut one: [docs/releasing.md](docs/releasing.md).

## Docs

**Docs ship with the change, in the same pull request.** A feature isn't done until `:help` can answer a question about it. roster's docs follow the model of Neovim's: one source for the in-app `:help`, the docs website and the PDF (`npm run docs` in `app/`, ADR 0008), complete, and never stale. For each kind of change:

- **New or changed command** (app `:name`, or `roster NAME`): the command has a `label` and an `area`, so `:help commands` lists it. Default keys go in `docs/app/keyboard.md`'s table. A CLI command gets its section in `docs/cli-reference.md`.
- **New `init.lua` option:** declare it in the Config's shape table (`crates/roster-core/src/config/shape`: its type, default, allowed values, a one-line summary and an example) and run `cargo run -p roster-core --example gen_config_options`, which writes `docs/app/options.md` (`:help options`), the editor types `examples/types/roster-config.lua` and the app's data. Then a row in `docs/app/config.md`'s option tables (Option | what it does, beyond the summary). `crates/roster-core/tests/config_shape.rs` fails until the shape declares it, the generated files are fresh and config.md names it. Examples in docs are written as `init.lua` is: `roster.o.terminal.size = "16pt"`, never a returned table.
- **New failure** (a roster error code, or a new way a Session or edit can fail): a row in `docs/app/errors.md` (what happened, cause, where it lives, message, fix) and its catalog entry. The code goes in `docs/serve-api.md` if serve returns it.
- **New or changed `roster serve` method or result:** its row in `docs/serve-api.md` is generated from the handler's docstring: give it `Params:`, `Result:`, `Errors:` and `Since: API N` lines, put the method's name in the `<!-- BEGIN generated:methods ... -->` marker of the section it belongs in, and run `uv run python scripts/gen-serve-api.py` (the format is at the top of that script). Edit the prose around the tables by hand, never the tables. Bump `API_VERSION` if the app must know. `tests/test_serve_api_doc.py` fails, saying what to run, until the doc matches; after a merge that touched serve's docstrings, run the script again rather than resolving the tables by hand.
- **A command worth more than its label:** a `doc` on its `CommandDef`, one paragraph of Markdown with topic links, shown under it on `:help commands` and `:help :name`.
- **New concept or word:** an entry in `GLOSSARY.md`, with what to avoid. Use that word everywhere.
- **New guide or section:** Markdown under `docs/app/` (or `docs/` for the CLI), bundled into `:help` through `app/src/help/guides.ts` with its part of the index, a title and a one-line summary, and listed in `docs/README.md`. Headings are names, not sentences: each `##`/`###` becomes a topic `page#slug`, so renaming one means keeping the old slug as an alias. Link commands, options and errors by topic (`` [`:connect`](:connect) ``, `` [`terminal.size`](terminal.size) ``, `[E13](E13)`), and other guides by file (`[x](keyboard.md#two-modes)`). The details are in `docs/app/help.md`, "Writing help".
- **User-visible change** (a `feat` or `perf` commit, or a breaking `!`): a bullet under `## Unreleased` in `docs/news.md` (add the heading at the top if it isn't there), in the right section (Breaking, New, Changed, Removed, Deprecated) and area (CLI, App, serve API with its API version), linking its help topic. The `News` check reminds you when it's missing; the `skip-news` label silences it for a change that needs no news.
- **Something deprecated** (an old name that still works): a row in `docs/deprecated.md` under the Release that deprecates it (old → new), and the old name stays a help alias that lands on that row (`deprecated`'s `aliases` in `app/src/help/guides.ts`). A renamed `init.lua` option also goes in the core's `DEPRECATED_OPTIONS` (`crates/roster-core/src/config/schema.rs`), so it still applies and warns. An old name stays at least one minor Release; removing it is a **Removed** bullet in the news.
- **Something users will want to change** (a new option, binding or registry entry): a recipe in `docs/app/recipes.md`, or an update to one, that opens with an `init.lua` snippet that works when pasted. A new registry also gets its row in `docs/app/extending.md` ("How far roster bends").
- **A Plugin-facing registry or API:** say on that registry's page how a Plugin uses it. A `roster.*` function, value, event or data type (or a field, parameter, error or permission of one) is declared in `crates/roster-core/src/plugin/api.rs`, the one source of `docs/plugin-api.md` (`:help plugin-api`), the lua-language-server stubs `examples/plugins/types/roster.lua` and their help topics; run `cargo run -p roster-core --example gen_plugin_api`. Edit api.rs, never the generated files. `crates/roster-core/tests/plugin_api.rs` fails, saying what to run, when the runtime and api.rs disagree or a file is stale; `app/src/plugins/api.test.ts` when `ops.ts` reads a field a type doesn't list; `tests/test_plugin_api.py` when serve's Host does.
- **User pages hold no developer notes.** `:help` leaves out a parenthetical that only names a ticket, a decision, an ADR or an issue (`(decision Q58)`); anywhere else in a sentence, write it in words or leave it to `docs/app/decisions.md`. A test fails on one that would show in help.

Write in the present tense and the active voice, and say exactly what happens. Write keys in keymap notation (`␣ f`, `Ctrl+Shift+c`). Use made-up names only (`esx-02`, `10.0.0.5`): the docs are public. CI checks that every link and anchor resolves (in `:help` and on GitHub), that no two help topics share a name, and that every `roster serve` method and error code is in `docs/serve-api.md` and every `roster` command in `docs/cli-reference.md` (`app/src/help/lint.test.ts`, `tests/test_docs.py`), that serve-api.md's method tables are what the docstrings say (`tests/test_serve_api_doc.py`), and that the Plugin API reference and stubs are what the core declares (`crates/roster-core/tests/plugin_api.rs`, with lua-language-server checking the example Plugins against the stubs). External links are checked once a week instead (`.github/workflows/links.yml`, `scripts/check-links.py`, also runnable from the Actions tab): dead ones go into one standing issue, "Dead links in the docs", never into a failing PR. When a check fails, fix the doc; don't silence the check.

## Lua API

The owner's rule: every object or collection exposed in Lua (`init.lua`'s `roster.*` and the Plugin API) ships complete: the functions needed to use it fully (add / get / list / has / update / remove or del, plus natural helpers such as a list's `:append` / `:prepend` / `:remove` and `reset`) and the read-only fields it needs. Bad names error at the caller's line (no silent no-ops); reads return copies; and every function, field and object has a generated `:help` entry (summary, type or signature, what it expects, example) with the same text in the editor types, in the same pull request as the code. Actions that touch the network or disk stay commands, not config functions.

The sources: `crates/roster-core/src/config/shape` for `init.lua`'s `roster` table ("Docs", above) and `crates/roster-core/src/plugin/api.rs` for the Plugin API. Each has a test that fails when the runtime has a name the source doesn't declare, or a declared name has no help entry or stub.

## Commits

- Messages say what changed and why, scoped by area, and name the ticket: `feat(picker): fuzzy match on name, address, group (ticket 03)`.
- No `Co-Authored-By` trailers and no AI attribution lines in commits or pull request descriptions.
- Every commit passes the checks of the half it touches; CI (`.github/workflows/ci.yml`) runs all of them on every pull request:
  - CLI: `uv run ruff check src tests scripts app/scripts`, `uv run pyright` and `uv run pytest`.
  - App: in `app/`, `npm run check` (tsc, ESLint, Vitest); at the root, `cargo test`, `cargo clippy -p roster-core --all-targets -- -D warnings` and `cargo fmt --check`.
- Tickets are GitHub issues, grouped by iteration milestones; the issue is the ticket and its open or closed state is its status. Filing or changing a ticket needs no pull request. Merges into `dev` don't fire "Closes #N", so the issue is closed when its pull request is merged.

## License of contributions

roster is licensed under the GNU General Public License, version 3 or (at your option) any later version (`GPL-3.0-or-later`, see [LICENSE](LICENSE)).

By opening a pull request you agree that:

- your contribution is your own work (or you have the right to submit it), and it's licensed to everyone under `GPL-3.0-or-later`, like the rest of roster;
- the maintainer may also license your contribution under other terms, including a commercial license, so roster can be offered under a separate license to anyone who can't use the GPL. You keep the copyright in your contribution.
