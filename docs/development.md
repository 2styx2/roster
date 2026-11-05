# Development

```bash
uv sync                  # creates .venv with dev tools
uv run pytest            # no network or SSH server needed; temp folders are deleted when each test ends (below)
uv run pytest -n auto    # on every core (pytest-xdist), as CI runs it; every test is safe beside others
uv run pytest --shard 2/3 -n 4   # the 2nd of CI's three Windows shards, balanced by tests/durations-windows.json
uv run ruff check src tests scripts app/scripts   # with flake8-bandit's security rules (S)
uv run pyright           # the type checker: basic over src/roster/, strict for the modules listed in pyproject.toml
uv build                 # wheel + sdist in dist/
```

The tests use stand-in `bw`, `op`, `pass` and `ssh` commands from `tests/fakes/` (the `bw` one also creates and deletes items like `bw create item` / `bw delete item`, and signs in like `bw login`: prompts on its terminal, every two-step method, new-device codes, API key, SSO through `xdg-open`) (the `ssh` one asks `SSH_ASKPASS` for a password as real ssh does), stand-in Hosts for the Mesh (the `ssh` one runs commands in a directory per Host when `FAKE_HOSTS` is set: down Hosts, blocked ports, ESXi's paths, and a slow Host, `DIR/NAME/slow`, for a request that takes a while), and a local paramiko server for `roster check HOST`'s port and host-key steps, and give each test its own temporary HOME, so they never touch your real `~/.ssh` or vaults.

`roster serve` answers requests concurrently (decision Q112), so a test that drives it can send several at once: the `serve` fixture's `request(method, params)` sends one without waiting and `answer(id)` waits for that one, keeping whatever answered first (`order` is the order serve answered in, `notes` its notifications). `tests/test_serve_concurrency.py` has a Publish whose upstream's hook holds the push until the test lets it go (an sh hook, which Git for Windows runs too); `tests/test_serve_cancel.py` forces each `$/cancel` case with events; `tests/test_jobs.py` tests the job manager on its own.

The `cmd:`/`env:` cut (decision Q92) is written twice, in `src/roster/jsonout.py` (the CLI's `--json`) and `crates/roster-core/src/plugin/runtime.rs` (what Plugins get). Its cases are one file, `tests/vectors/redaction.json` (`in`, `out` and a `note` each; `"error": true` for an error message, which keeps its `(code N)`), read by `tests/test_json.py` and runtime.rs's tests: add a case there, not in either test, and change both implementations until both pass.

```text
src/roster/
  cli.py            commands and argument parsing
  jsonout.py        `--json` on the read commands: one document with a version, `cmd:`/`env:` references cut (Q92, Q110)
  jsondocs.py       each `--json` document as a Pydantic model (T176), imported only when one prints
  common.py         small shared helpers: output, paths, text, starting programs
  conpty.py         a program on a Windows pseudoconsole (ConPTY, ctypes), in a job object: native Windows' PTY for bw_login
  config.py         loading/validating roster.yml, search, --only; find_config: which roster.yml (-c, --inv, ...)
  models.py         roster.yml's Inventory as Pydantic models (Host, its Logins and services, group, Link, resource);
                    load_inventory returns them, load_config their dict view (Inventory.as_config)
  inventories.py    named Inventories (`roster inv`, inventories.json, its Pydantic models): the active one, each one's
                    own ssh config and known_hosts, the ssh config index, and the warnings for the same machine in two
  example.py        the `roster init` template
  sshops.py         keys, fingerprints, ssh config, key install/removal, password logins
  resources.py      Wi-Fi networks, accounts and secrets with no address: the field schema per type
  claude.py         ROSTER.md, CLAUDE.md import, .claude/settings.json
  aliases.py        the CLI's old names (T222, Q194): one table, each old command line rewritten to its new form
                    before the parser sees it, with one stderr line naming it (none for `roster completion`)
  boxkeys.py        this Box's SSH keys, one per key type (key_type:): a Host's key file, ssh-keygen args, type word
  boxsync.py        `roster sync` for this Box after roster changed roster.yml: serve's writes and the CLI's (discover --write, mesh cut)
  addhost.py        adding one Host (T220, Q190): the one implementation behind serve's host.add and `roster add`
                    (checks, the write through store.py, this Box's sync), and a vault item's address and user
                    without its password (`--from-vault`, vault.item_fields)
  fromvault.py      `roster add --from-vault` with no NAME (T221, Q191): the vault items no Login in roster.yml names,
                    new ones since the last run (the seen file), and the walk adding each through addhost
  vaultsync.py      `roster vault sync` (T222, Q194): each vault roster.yml uses, synced, and the items added, changed
                    or removed since the last sync, from a snapshot of ids and revision dates (vault-sync/, 0600)
  discover.py       nmap / built-in scanning, type guessing, merging into roster.yml; Scan: serve's discover.* scan
  serve.py          `roster serve`: JSON-RPC API for the desktop app, method table, the roster.yml watcher (inventory.changed);
                    requests answered concurrently on workers, a lock per resource each method claims (LOCKS, decision Q112),
                    `$/cancel` (Request, Server.cancel), the unlock's own lane;
                    each method's docstring is its row in docs/serve-api.md (scripts/gen-serve-api.py)
  servemodels.py    serve's params and results as Pydantic models (T174: hosts.list, host.get so far); with models.py,
                    the object tables in docs/serve-api.md are generated from them
  jobs.py           serve's job manager: background work (a Mesh run, a scan, a Host's check) with ids, state, progress, a stop, and
                    the job.progress notification; serve's exit stops every job and records it
  edit.py           editing one Host in roster.yml as text, adding, removing, renaming or moving one, and groups (comments and other entries kept), checked before it's written
  changes.py        Pending changes: the infra repo's git (pull fast-forward only, roster.yml's diff, discard, the .bak, publish)
  store.py          how roster.yml is kept (T212, Q182): a team repo or a plain file, decided per file; every write saves
                    through it (serve, add, discover --write, mesh cut), and pull/diff/discard/publish ask it
  newinventory.py   a new Inventory (`roster init --inventory`): blank, a copy, a clone, Hosts from an ssh config
  clihelp.py        `roster --help`'s command groups, each command's description and examples (tested to parse),
                    and the nearest name for a mistyped command or option
  completion.py     Tab completion: `roster help --completion SHELL`'s scripts and the hidden `roster __complete` helper that
                    walks the parser and reads names from the local roster.yml (decision Q183)
  manpage.py        roster(1): generated from the parser (cli.build_parser) and docs/cli-reference.md into
                    roster.1 (committed, shipped in the wheel); `roster help --man`. Regenerate: uv run python -m roster.manpage
  errors.py         the stable error codes and Problem (code, message, fix): what serve, askpass and check report
  mesh.py           the Mesh: who reaches whom (mesh:, links:), plan/apply over ssh one Host at a time, cut, status,
                    drift for `roster check`; the sh it runs on Hosts (docs/mesh.md)
  diagnose.py       a Host's Login checked before ssh runs, `roster check HOST` / host.check's steps, host.verify_login, host.scan_key
  fill.py           a prompt fill (session.fill): which of a Host's Logins answers a sudo, su or ssh prompt, or why none may
  health.py         this Box's health: `roster check --box` / box.check's sections (roster.yml, ssh, vault CLIs, askpass,
                    the infra repo), every check local
  askpass.py        the askpass channel: serve's socket (named pipe on Windows) + one-time tokens, the `roster askpass` helper and the logged-in report (stdlib only)
  web.py            roster web: HTTP requests logged in with a service's stored credentials
  winhost.py        Windows Hosts (os: windows): the PowerShell scripts setup, revoke and check send on stdin (the key file, its ACL)
  winpipe.py        Windows named pipes for askpass: a pipe only this user can open (its DACL), the client end (ctypes, stdlib only)
  winfile.py        Windows: read a secret's file only if it's this user's alone (its owner and DACL, through one handle; #411)
  providers/        password providers: registry + plugins + templates, builtin, bitwarden, onepassword,
                    keepassxc (a local .kdbx through keepassxc-cli);
                    bw_login: `bw login` driven a step at a time on a PTY (serve's vault.login); ConPTY on Windows
                    bw_items_filter: the stdlib-only filter `bw list items` is piped into, so roster reads only each
                    item's id, name, URIs, username and revision date (Q191, Q194)
examples/           commented roster.yml and init.lua, provider plugin template, example Plugins and the Plugin API's types
plugins/            the first-party Plugins (mesh, discover, topology), installed as Packages with dir = "plugins/NAME" (Q94)
scripts/            gen-serve-api.py: docs/serve-api.md's method tables from serve's docstrings (Params:, Result:,
                    Errors:, Since:). Regenerate: uv run python scripts/gen-serve-api.py (--check: is it current?);
                    check-links.py: the docs' external links, weekly in .github/workflows/links.yml;
                    bump-version.sh: one version everywhere;
                    news_check.py and news_section.py: the news reminder on pull requests and a Release's notes;
                    check-bundle-size.py: the app's JS/CSS budget
                    check-release-notices.py: every app download (archives, installers, the bundle config) carries
                    LICENSE and THIRD-PARTY-NOTICES (docs/releasing.md)
                    gen-repaint-cases.py: the repaints the core's screen and xterm.js are both checked on
                    (crates/roster-core/tests/fixtures/repaints.json, repaint-fuzz.json; Q151 (l))
                    stress.sh: one roster-core test binary many times at once beside busy loops, to find the
                    tests that fail only under load (docs/app/dev/testing.md)
                    check-local.sh: the checks CI's pull request jobs run, here, for what you changed
                    (--quick for a pre-push hook, --full for all; "Checking before you push");
                    ci_changes.py: which CI jobs a pull request's files need ("What CI runs when")
docs/               team guides: setting up a new box, adding hosts; docs/app/ for the app, docs/adr/ for decisions
tests/              pytest suite + fake password-manager CLIs
app/                the roster app (frontend + app/src-tauri); its Rust core is crates/roster-core (app/README.md)
```

The Plugin API (the `roster` Lua module) is declared once, in `crates/roster-core/src/plugin/api.rs`. `cargo run -p roster-core --example gen_plugin_api` writes `docs/plugin-api.md`, the lua-language-server stubs `examples/plugins/types/roster.lua` and `crates/roster-core/tests/fixtures/plugin-api.json` (the help's topics, and the data `:help plugin-types` writes the stubs from: the app doesn't bundle `roster.lua`) from it; `--check` only says whether they're current, and `cargo test` fails when they aren't or when the runtime and api.rs disagree. To type-check the example and first-party Plugins as CI does, run [lua-language-server](https://luals.github.io/) 3.19.2: `lua-language-server --check examples/plugins --checklevel=Hint` and `lua-language-server --check plugins --checklevel=Hint`.

Tests never leave folders in the temp dir (ticket 109: once 37k of them filled /tmp). A roster-core test takes its folder from `common::temp("what")` (`crates/roster-core/tests/common/mod.rs`, a `tempfile::TempDir` that reads as a `Path`), which deletes it when the test ends, failing or not; a helper that makes one returns that guard (or something holding it), never a bare path, and nothing builds a path under `std::env::temp_dir()` itself (`tests/temp_cleanup.rs` checks both). A pytest test uses `tmp_path`; anything else it, serve or a program it runs makes with `tempfile` or in `$TMPDIR` lands in a folder of the test's own that `conftest.py` deletes afterwards. CI runs `cargo test` in a fresh temp dir and fails if a `roster-core-*` folder is left in it. To try that locally: `mkdir -p ~/scratch-tmp && TMPDIR=~/scratch-tmp cargo test; ls -A ~/scratch-tmp`.

The app's checks are in [app/README.md](../app/README.md#development) (`npm run check` in `app/`, `cargo test` at the root). CI (`.github/workflows/ci.yml`) runs both halves; [CONTRIBUTING.md](../CONTRIBUTING.md) has the branch model. pytest runs on every core (pytest-xdist, `-n auto`), so a test must pass beside others: its own HOME and temp folder (`conftest.py`'s `isolated`), no fixed port, and no tight time limit on how soon something happens that a busy machine misses. Besides Linux, it runs pytest on Windows, in three shards side by side (`--shard K/3`, each on 4 workers): there each stand-in Host command starts Python and Git for Windows' slow-forking `sh`, so the suite takes 47 to 58 minutes of test time. The shards are balanced by time, not count (T233): `conftest.py` deals the tests out longest first, each to the shard with the least so far, by the seconds each took in `tests/durations-windows.json` plus a second each (what a test costs there beyond its own time: without it, the shard of quick tests ran longest); a test the file doesn't know (a new one) counts as the file's average, so adding a test needs no entry, and a name the file has that's gone is ignored. Each Windows shard writes its tests' times (`--store-durations durations.json`, beside its `report.xml` in the `pytest-report-windows-K` artifact), and the nightly run's `Windows shard times` job merges the three into a fresh file (the `windows-durations` artifact, `scripts/shard_durations.py`) and puts each shard's test time in its summary. When the shards drift apart (more than a minute or so of wall time: about 4 minutes of test time on 4 workers), refresh the committed file in a pull request: `gh run download RUN -R 2styx2/roster -n windows-durations -D tests`. A test that hangs fails after 120 s anywhere (pytest-timeout, `pyproject.toml`). It also runs roster-core's `cargo test` on Windows (`Core tests (Windows)`): the core's `cfg(windows)` code, such as the junctions in a Plugin's "stays inside its folder" rule, only runs there. That job tests the core only (the Tauri crate is built by the Windows release build), keeps its own Rust cache, and runs `tests/fake_serve.py` with the Python it installs. It also builds the frontend and checks its JS and CSS against their budget (`scripts/check-bundle-size.py`, [performance.md](app/performance.md#bundle-size)).

### What CI runs when

A push to `main` or `dev`, a tag, the nightly schedule (03:23 UTC, on `main`) and a run by hand run every job, with pytest on Python 3.10, 3.12 and 3.13. A pull request runs a PR-sized set (decision Q196): Python 3.12 only, and only the jobs its changed files need. The `Changes` job works that out (`scripts/ci_changes.py`, tested in `tests/test_ci_changes.py`); the halves read each other's files, so a path runs every job that reads it:

| A pull request that touches | runs |
|---|---|
| `src/`, `tests/` (the CLI) | pytest on Linux |
| Windows-specific code: `src/roster/win*.py`, `conpty.py`, `askpass.py`, `common.py`, `changes.py`, `diagnose.py`, `sshops.py`, `providers/__init__.py`, `providers/bw_login.py`, `tests/test_windows*.py`, `tests/conftest.py`, `tests/fakes/`, `tests/durations-windows.json`, `pyproject.toml`, `uv.lock`, `.python-version`, `install.ps1` | pytest on Linux and on Windows |
| `app/` (the frontend) | the frontend, Rust and pytest on Linux (`tests/` checks `app/src` files) |
| `crates/`, `Cargo.toml`, `Cargo.lock`, `app/src-tauri/`, `app/package*.json` | the frontend, Rust, pytest on Linux, and the Windows and Linux release builds |
| `plugins/` | the frontend and Rust |
| `docs/`, `examples/`, a `*.md` at the root | the frontend, Rust and pytest on Linux (each checks the docs) |
| `tests/vectors/` | pytest on Linux and Windows, the frontend and Rust |
| `install.sh`, `update.sh`, `uninstall.sh`, `install-lib.sh`, `scripts/test-install.sh` | pytest on Linux, and the install test (`scripts/test-install.sh` on Ubuntu and Fedora, in containers) |
| `.github/workflows/release.yml` | the release builds (and release.yml's own dry run, [releasing.md](releasing.md)) |
| `.github/workflows/ci.yml`, `scripts/`, or anything else | everything |

Windows' pytest (three shards, 6 to 8 minutes each) runs on a pull request only when it touches Windows-specific code (`WINDOWS_PATHS` in `scripts/ci_changes.py`, T237); every push to `dev` or `main`, a tag, the nightly run and a run by hand run it. So a Windows-only break in a pull request that touches other files shows on `dev`'s push after the merge, never in a release (a release is tagged from `main`, whose push runs it too): fix it on `dev` before the next release. A module that gains a Windows branch of its own (`if WINDOWS:`, `os.name == "nt"`) goes on that list in the same pull request.

The install test needs the network (apt or dnf, astral.sh, Bitwarden), so off a pull request it runs only on Monday's nightly run and on a run by hand, not on every push or tag (decision Q199). `Checks` (ruff, pyright, one version, the lua-language-server checks and the wheel build) always runs: one job, since each takes seconds, so a run takes fewer of the free plan's 20 parallel jobs (T233). The release builds, `App Windows release build` and `App Linux release build`, run on a pull request only when it touches what they build; every push to `dev` runs them. A pull request's older run is cancelled when a newer push comes; a push to `main` or `dev` runs to the end. The Rust jobs restore the cache `dev`'s last run saved and don't save their own, so pull requests don't push `dev`'s cache out of the 10 GB GitHub keeps. The last job, `CI`, always reports: green when every job that ran passed, red when one failed or was cancelled, so branch protection can require that one name.

### Checking before you push

`scripts/check-local.sh` runs here what CI's pull request jobs run for your changes (the same `scripts/ci_changes.py`, over your commits since `origin/dev` and what isn't committed yet): ruff and pyright always, `pytest -n auto` when the CLI's area changed, `npm run check` in `app/` when the frontend's did, and `cargo fmt`, `clippy` and `cargo test` when the Rust's did. `--quick` keeps to ruff, pyright and pytest, for a pre-push hook; `--full` runs every check whatever changed; `--base REF` compares with another branch. It ends with a one-line summary and exits non-zero when a check fails. It says what only CI can run (the Windows shards, the install test, the release builds), and when `pwsh` isn't on PATH, that pytest skipped the PowerShell-script tests and how to install PowerShell. It runs in bash on Linux, WSL and macOS.

To run it on every push, add this line at the end of your clone's `.git/hooks/pre-push` (create the file with a `#!/usr/bin/env bash` line first if you have none, and `chmod +x` it):

```sh
"$(git rev-parse --show-toplevel)/scripts/check-local.sh" --quick </dev/null || exit 1
```

`git push --no-verify` skips the hook once. roster never installs or changes a hook for you, and never sets `core.hooksPath`: your hook may hold checks of your own.

## Languages and types

The CLI and `roster serve` are Python; the app's core is Rust (decision Q113, [ADR 0009](adr/0009-python-cli-rust-where-it-falls-short.md)). Every new data shape in the CLI or serve (a serve method's params and result, a `roster.yml` key, a `--json` document) is a Pydantic model, and new or rewritten modules pass the type checker in strict mode. Existing dicts move over when a ticket touches them, not in one sweep.

- **The type checker is pyright** (`uv run pyright`, pinned in the dev group; CI's `Checks` job runs it beside ruff). It checks `src/roster/` in basic mode; a module that is new or rewritten goes on the `strict` list in `pyproject.toml`'s `[tool.pyright]` in the same pull request (`models.py` is the first). What it finds is fixed, or silenced on its line with the rule and a reason (`# pyright: ignore[reportAttributeAccessIssue] - Windows only`), never for a whole file.
- **roster.yml loads into models** (`models.py`): `config.load_inventory(path)` returns an `Inventory` of `Host`s (with their `SshLogin`, `Login` and `Service`s), `Group`s, `Link`s and resources (`WifiResource`, `AccountResource`, `SecretResource`), read-only. New code reads those. `load_config(path)` is the same Inventory as the dicts the older code reads (`Inventory.as_config()`), keys unchanged; a module moves to the models when a ticket touches it. serve's params and results are models in `servemodels.py` (`hosts.list` and `host.get` so far: a method moves there when a ticket touches it), and every `--json` document is one in `jsondocs.py` (`jsonout.emit` takes only a model). Each dumps with `exclude_unset` (an optional key that isn't set is left out, as the dicts did) in the field order the dicts had: the output is byte for byte what it was. Their fields' `description=` is what docs/serve-api.md's object tables say (`scripts/gen-serve-api.py`); a field without one fails the generator. A key roster doesn't know stays on its Host (`shell_hooks`, a team's own).
- **A model's error is roster's own:** config.py makes its checks first, with their usual messages; whatever the models still refuse (`workers: lots`) stops with `error: PATH: KEY: what's wrong` (code 1 in serve and `--json`), never a Pydantic traceback, and never the value that failed. No repr shows an `auth:` or a key roster doesn't know: anything that could hold a secret is `Field(repr=False)` (`SecretStr` for a value a vault returns).
- **Pydantic is imported lazily:** only when roster.yml is loaded (inside `config.parse_inventory`), so `roster --help`, `roster --version` and `roster askpass` don't pay for it (`tests/test_models.py` checks `import roster.cli` doesn't load it). Measure a change to that with `python -X importtime -c "import roster.cli"`.
- **ruff's `S` rules** (flake8-bandit) are on: a finding is fixed or carries a `noqa` with its reason. `S603`/`S607` (running a program from PATH without a shell) are off everywhere, since running ssh, git and the vault CLIs as argv lists is roster's job; the tests may assert and use made-up passwords and temp paths. When something can't be done well in Python, write it in Rust in the Cargo workspace instead of a second Python copy. A full rewrite of the CLI is revisited once the app has matured.

## Trying it safely

- `roster setup --dry-run` shows which hosts would get a key without touching them.
- `--only` lets you start with one host or group.
- `roster revoke` undoes `setup`.
- To experiment without real servers, run an SSH server in a container (for example the `linuxserver/openssh-server` image with password auth enabled), point a `roster.yml` at it, and run the full flow.
