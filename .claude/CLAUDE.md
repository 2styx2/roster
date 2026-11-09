# roster (Rust): notes for agents

A rewrite of the Python roster (now archived as 2styx2/roster-archive) as one Rust binary, following the Unix philosophy: each command does one job, prints plain text by default and `--json` for scripts, and composes with fzf, tmux and ssh. No GUI, no plugin system, no long-running server.

## Rules
- Commits and pull requests carry no `Co-Authored-By` trailer and no Claude/AI attribution line.
- **The repo is public.** Never write a real host name, network range, company or product name, email or secret into code, tests, fixtures, docs, commits, issues or PRs. Use made-up examples (`esx-02`, `box-a`, `10.0.0.5`). Never paste the output of a real `roster` run against a real Inventory into fixtures.
- Secrets never reach stdout, logs, `--json`, Claude, or argv. Passwords go from the vault to ssh through askpass only.
- Docs ship with the change: a command, flag, error or JSON field isn't done until `roster.1` covers it (and `tests/man_page.rs` lists it). `-h` prints short usage.
- Work on branches cut from `dev`; land through a PR into `dev`. `main` and releases are the owner's.

## Compatibility
- Reads the same `roster.yml` and vault items as the Python roster, and writes the same ssh config and `ROSTER.md` for Claude, so the two can run side by side until the switch.

## Tests
One seam: the built binary run as a process. `tests/common` gives `Sandbox::new(name)` (a temporary HOME, also the working directory, with `tests/fakes` first on PATH), `.write(rel, text)`, `.set_env(k, v)` and `.roster(args)`, which returns the exit code, stdout and stderr. Fakes are small sh scripts in `tests/fakes`. Fixtures are made up.

### Side by side with the Python roster
`tests/side_by_side.rs` checks that roster-rs and the Python roster v0.7.0 remove each other's key lines and Mesh on the same fake Hosts. It is ignored by default (it needs Python and the network) and runs as its own CI job. Locally: `ROSTER_SIDE_BY_SIDE=1 cargo test --test side_by_side -- --ignored`. It installs v0.7.0 from its tag into a throwaway venv under `target/tmp` and runs it only with HOME set to the sandbox and `ROSTER_CONFIG` naming the made-up fixture. Never run the Python `roster` installed on your machine: it reads a real Inventory.

## Checks (same as CI)
`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --locked`, `sh scripts/line-budget.sh` (non-blank, non-comment lines in `src`, embedded scripts included, against a budget of 10,000). The budget is a guide to how small roster stays, not a hard limit: over it, the script warns and CI still passes. Keep well under it anyway, and say in a PR what a big addition buys. CI also runs `cargo deny check`: only crates listed in `deny.toml` may appear.
