# roster: notes for agents

One repo, two halves: the Python CLI at the root (`src/roster/`, `tests/`) and the desktop app, the roster app, in `app/` (frontend `app/src/`, Tauri shell `app/src-tauri/`) with its Rust core in `crates/roster-core/`. Decision Q56 and ADR 0007 explain the layout.

## The CLI

- Module map: `docs/development.md` (one line per file in `src/roster/`). Open only the module it points you to.
- How hosts, logins and vault items are named and added: `docs/adding-hosts.md`; setting up a box: `docs/new-box.md`.
- The live inventory is the infra repo's `roster.yml` (`~/infra`), not this repo; `examples/` holds the template.
- Vault: `roster vault bw -- <bw args>` runs the Bitwarden CLI with this box's session file, e.g. `roster vault bw -- list items --search proxmox`.
- Checks (same as CI): `uv run ruff check src tests scripts app/scripts` and `uv run pytest`. Tests use the stand-in CLIs in `tests/fakes/`.

## The app

- Start at `app/README.md` (module map, the two builds, fixtures). The design rationale is in `docs/app/`, and the decisions are in `docs/app/decisions.md` and `docs/adr/`. Don't re-ask settled questions.
- Vocabulary: `GLOSSARY.md` (one file for the CLI and the app).
- Work comes from GitHub issues (github.com/2styx2/roster): one issue per ticket, titled `TNN: …`, in its iteration's milestone, with "Blocked by" naming other issues. Pick from the frontier of the current iteration's milestone (`gh issue list --milestone "Iteration N — …"`). There's no `tickets/` folder: new tickets are new issues, never files or a pull request. Ticket numbers (TNN) aren't issue numbers.
- The app reaches roster only through `roster serve` (ADR 0001). Never read `roster.yml` or a vault from the app. Secrets must never reach the frontend, and never the Rust core except for one narrow exception (owner's ruling, decision Q129): for `session.fill` only, `roster serve` returns the password to the core, which writes it straight to the Session's PTY and wipes it; never the webview, logs, `:messages` or Plugins (`docs/app/security.md`).
- TypeScript is strict and required. UI tests go through the typed backend client with a fake backend.
- Checks (same as CI): in `app/`, `npm ci` once, then `npm run check`; at the root, `cargo test`, `cargo clippy -p roster-core --all-targets -- -D warnings` and `cargo fmt --check` (WSL can't build `app/src-tauri`: no webkit2gtk; CI can).
- Windows builds from WSL: `app/scripts/app-dev.sh`, `app-build.sh`, `app-stop.sh` (`docs/app/dev/windows-build-loop.md`). Warn the user before opening a window on their desktop.
- **Taste:** `docs/app/design/taste.md` is roster's own design identity: the network-map motif and the Gap orbit mark, the accent (apricot) means live, Iosevka for data and Inter for talk, an honest voice, motion that confirms. Read it before any UI work. It wins over references (except on accessibility).
- **Design rule:** every UI or design change follows the core of the `emil-design-eng` skill (call it first). **Every** animation or transition, new or changed, goes through the `animate` skill. The `interfaces:*` skills are for reviews and focused fixes; when they disagree on motion, `animate` wins.

## Workflow (both halves)

- Branch model: `CONTRIBUTING.md`. Work only on Work branches (`feat/NN-slug` after the ticket, `fix/…`, `docs/…`, `chore/…`) cut from `dev`. Changes land through a GitHub pull request to `dev` (`gh pr create --base dev`); the maintainer reviews and merges. Never push to `dev` or `main` directly.
- Commits and pull requests carry no `Co-Authored-By` trailer and no Claude/AI attribution line.
- **Docs ship with the change, in the same pull request** (CONTRIBUTING.md "Docs"): a command, option, error, serve method, CLI command or concept isn't done until its row or page exists and `:help` can answer a question about it. The model is Neovim's docs (one source for `:help` and, later, the website and PDF).
- **Exceptions to a rule are documented with their full reasoning.** Only the owner makes an exception to a rule here or in `docs/app/security.md` (as with Q129). Each one gets a decision row in `docs/app/decisions.md` that says what the rule was, exactly what the exception allows and what it still forbids, why (the problem it solves and why the rule couldn't hold there), the alternatives considered and why they lost, the threat model or risks, and the limits that keep it narrow. The rule's text everywhere it's stated (this file, security.md, CONTRIBUTING.md) then names the exception and points at that row, in the same pull request. An exception that isn't written down that way doesn't exist.
- **The repo is public.** Never write a real host name, network range, company or product name, email or secret into code, tests, fixtures, docs, commits, issues or PRs. Use made-up examples (`10.0.0.5`, `esx-02`, `appliance`). Every team's `roster.yml` stays private (Q62). The owner's clone has a pre-push check that refuses such pushes; don't work around it.

## Agent skills

### Issue tracker

GitHub issues on `2styx2/roster` via `gh`: tickets titled `TNN: …`, one milestone per iteration, `Blocked by #N`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md`, `docs/adr/` and `docs/app/decisions.md`. See `docs/agents/domain.md`.
