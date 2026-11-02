# Development

```bash
uv sync                  # creates .venv with dev tools
uv run pytest            # no network or SSH server needed; temp folders are deleted when each test ends (below)
uv run ruff check src tests scripts app/scripts
uv build                 # wheel + sdist in dist/
```

The tests use stand-in `bw`, `op`, `pass` and `ssh` commands from `tests/fakes/` (the `bw` one also creates and deletes items like `bw create item` / `bw delete item`, and signs in like `bw login`: prompts on its terminal, every two-step method, new-device codes, API key, SSO through `xdg-open`) (the `ssh` one asks `SSH_ASKPASS` for a password as real ssh does), stand-in Hosts for the Mesh (the `ssh` one runs commands in a directory per Host when `FAKE_HOSTS` is set: down Hosts, blocked ports, ESXi's paths, and a slow Host, `DIR/NAME/slow`, for a request that takes a while), and a local paramiko server for `roster check HOST`'s port and host-key steps, and give each test its own temporary HOME, so they never touch your real `~/.ssh` or vaults.

`roster serve` answers requests concurrently (decision Q112), so a test that drives it can send several at once: the `serve` fixture's `request(method, params)` sends one without waiting and `answer(id)` waits for that one, keeping whatever answered first (`order` is the order serve answered in, `notes` its notifications). `tests/test_serve_concurrency.py` has a Publish whose upstream's hook holds the push until the test lets it go (an sh hook, which Git for Windows runs too); `tests/test_serve_cancel.py` forces each `$/cancel` case with events; `tests/test_jobs.py` tests the job manager on its own.

The `cmd:`/`env:` cut (decision Q92) is written twice, in `src/roster/jsonout.py` (the CLI's `--json`) and `crates/roster-core/src/plugin/runtime.rs` (what Plugins get). Its cases are one file, `tests/vectors/redaction.json` (`in`, `out` and a `note` each; `"error": true` for an error message, which keeps its `(code N)`), read by `tests/test_json.py` and runtime.rs's tests: add a case there, not in either test, and change both implementations until both pass.

```text
src/roster/
  cli.py            commands and argument parsing
  jsonout.py        `--json` on the read commands: one document with a version, `cmd:`/`env:` references cut (Q92, Q110)
  common.py         small shared helpers: output, paths, text, starting programs
  conpty.py         a program on a Windows pseudoconsole (ConPTY, ctypes), in a job object: native Windows' PTY for bw_login
  config.py         loading/validating roster.yml, search, --only
  example.py        the `roster init` template
  sshops.py         keys, fingerprints, ssh config, key install/removal, password logins
  resources.py      Wi-Fi networks, accounts and secrets with no address: the field schema per type
  claude.py         ROSTER.md, CLAUDE.md import, .claude/settings.json
  discover.py       nmap / built-in scanning, type guessing, merging into roster.yml; Scan: serve's discover.* scan
  serve.py          `roster serve`: JSON-RPC API for the desktop app, method table, the roster.yml watcher (inventory.changed);
                    requests answered concurrently on workers, a lock per resource each method claims (LOCKS, decision Q112),
                    `$/cancel` (Request, Server.cancel), the unlock's own lane;
                    each method's docstring is its row in docs/serve-api.md (scripts/gen-serve-api.py)
  jobs.py           serve's job manager: background work (a Mesh run, a scan, a Host's check) with ids, state, progress, a stop, and
                    the job.progress notification; serve's exit stops every job and records it
  edit.py           editing one Host in roster.yml as text, adding, removing, renaming or moving one, and groups (comments and other entries kept), checked before it's written
  changes.py        Pending changes: the infra repo's git (pull fast-forward only, roster.yml's diff, discard, the .bak, publish)
  manpage.py        roster(1): generated from the parser (cli.build_parser) and docs/cli-reference.md into
                    roster.1 (committed, shipped in the wheel); `roster man`. Regenerate: uv run python -m roster.manpage
  errors.py         the stable error codes and Problem (code, message, fix): what serve, askpass and check report
  mesh.py           the Mesh: who reaches whom (mesh:, links:), plan/apply over ssh one Host at a time, cut, status,
                    drift for `roster check`; the sh it runs on Hosts (docs/mesh.md)
  diagnose.py       a Host's Login checked before ssh runs, `roster check HOST` / host.check's steps, host.verify_login, host.scan_key
  fill.py           a prompt fill (session.fill): which of a Host's Logins answers a sudo, su or ssh prompt, or why none may
  health.py         this Box's health: `roster check --box` / box.check's sections (roster.yml, ssh, vault CLIs, askpass,
                    the infra repo), every check local
  askpass.py        the askpass channel: serve's socket (named pipe on Windows) + one-time tokens, the `roster askpass` helper and the logged-in report (stdlib only)
  web.py            roster web: HTTP requests logged in with a service's stored credentials
  winpipe.py        Windows named pipes for askpass: a pipe only this user can open (its DACL), the client end (ctypes, stdlib only)
  providers/        password providers: registry + plugins + templates, builtin, bitwarden, onepassword,
                    keepassxc (a local .kdbx through keepassxc-cli);
                    bw_login: `bw login` driven a step at a time on a PTY (serve's vault.login); ConPTY on Windows
examples/           commented roster.yml and init.lua, provider plugin template, example Plugins and the Plugin API's types
plugins/            the first-party Plugins (mesh, discover, topology), installed as Packages with dir = "plugins/NAME" (Q94)
scripts/            gen-serve-api.py: docs/serve-api.md's method tables from serve's docstrings (Params:, Result:,
                    Errors:, Since:). Regenerate: uv run python scripts/gen-serve-api.py (--check: is it current?);
                    check-links.py: the docs' external links, weekly in .github/workflows/links.yml;
                    bump-version.sh: one version everywhere;
                    news_check.py and news_section.py: the news reminder on pull requests and a Release's notes;
                    check-bundle-size.py: the app's JS/CSS budget
docs/               team guides: setting up a new box, adding hosts; docs/app/ for the app, docs/adr/ for decisions
tests/              pytest suite + fake password-manager CLIs
app/                the roster app (frontend + app/src-tauri); its Rust core is crates/roster-core (app/README.md)
```

The Plugin API (the `roster` Lua module) is declared once, in `crates/roster-core/src/plugin/api.rs`. `cargo run -p roster-core --example gen_plugin_api` writes `docs/plugin-api.md`, the lua-language-server stubs `examples/plugins/types/roster.lua` and `crates/roster-core/tests/fixtures/plugin-api.json` (the help's topics) from it; `--check` only says whether they're current, and `cargo test` fails when they aren't or when the runtime and api.rs disagree. To type-check the example and first-party Plugins as CI does, run [lua-language-server](https://luals.github.io/) 3.19.2: `lua-language-server --check examples/plugins --checklevel=Hint` and `lua-language-server --check plugins --checklevel=Hint`.

Tests never leave folders in the temp dir (ticket 109: once 37k of them filled /tmp). A roster-core test takes its folder from `common::temp("what")` (`crates/roster-core/tests/common/mod.rs`, a `tempfile::TempDir` that reads as a `Path`), which deletes it when the test ends, failing or not; a helper that makes one returns that guard (or something holding it), never a bare path, and nothing builds a path under `std::env::temp_dir()` itself (`tests/temp_cleanup.rs` checks both). A pytest test uses `tmp_path`; anything else it, serve or a program it runs makes with `tempfile` or in `$TMPDIR` lands in a folder of the test's own that `conftest.py` deletes afterwards. CI runs `cargo test` in a fresh temp dir and fails if a `roster-core-*` folder is left in it. To try that locally: `mkdir -p ~/scratch-tmp && TMPDIR=~/scratch-tmp cargo test; ls -A ~/scratch-tmp`.

The app's checks are in [app/README.md](../app/README.md#development) (`npm run check` in `app/`, `cargo test` at the root). CI runs both halves on every pull request (`.github/workflows/ci.yml`); [CONTRIBUTING.md](../CONTRIBUTING.md) has the branch model. Besides Linux, it runs pytest on Windows and roster-core's `cargo test` on Windows (`Core tests (Windows)`): the core's `cfg(windows)` code, such as the junctions in a Plugin's "stays inside its folder" rule, only runs there. That job tests the core only (the Tauri crate is built by the Windows release build), keeps its own Rust cache, and runs `tests/fake_serve.py` with the Python it installs. It also builds the frontend and checks its JS and CSS against their budget (`scripts/check-bundle-size.py`, [performance.md](app/performance.md#bundle-size)).

## Languages and types

The CLI and `roster serve` are Python; the app's core is Rust (decision Q113, [ADR 0009](adr/0009-python-cli-rust-where-it-falls-short.md)). Every new data shape in the CLI or serve (a serve method's params and result, a `roster.yml` key, a `--json` document) is a Pydantic model, and new or rewritten modules pass the type checker in strict mode (ticket T112 adds the checker and its command here). When something can't be done well in Python, write it in Rust in the Cargo workspace instead of a second Python copy. A full rewrite of the CLI is revisited once the app has matured.

## Trying it safely

- `roster setup --dry-run` shows which hosts would get a key without touching them.
- `--only` lets you start with one host or group.
- `roster revoke` undoes `setup`.
- To experiment without real servers, run an SSH server in a container (for example the `linuxserver/openssh-server` image with password auth enabled), point a `roster.yml` at it, and run the full flow.
