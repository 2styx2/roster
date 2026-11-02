# The desktop app talks to roster only through `roster serve`

The desktop app (in `app/`; until 2026-10-30 the separate roster-desk repo, see ADR 0007) never reads `roster.yml` or a vault itself. It starts one `roster serve` process per launch and speaks JSON-RPC to it over stdin/stdout. That process holds the unlocked vault for the app's lifetime, answers queries with the same host, group and resource objects `load_config` already builds, and makes every Inventory write. roster stays the one place that understands the Inventory and touches secrets, so the CLI and the app cannot drift apart, and the Rust and UI layers never hold a password.

## Amendment (2026-10-31, decision Q112; amended again 2026-11-01, ticket 108)

`roster serve` no longer answers one request at a time. Since serve API 20 it answers several at once on a pool of workers, with a lock per resource (`roster.yml` and its repo, the vault) where requests must not overlap, and a job manager that owns its background work (Mesh runs, Discover scans and, since API 21, a Host's check) and pushes their progress; a request the app gives up on is cancelled with `$/cancel`. The decision stands: the app still talks to roster only through this one `roster serve` over stdio, the backend stays Python (the owner chose that over a rewrite; [ADR 0009](0009-python-cli-rust-where-it-falls-short.md) says when Rust is used instead and when a rewrite is revisited), and secrets still never leave it. [serve-api.md](../serve-api.md#ordering-locks-and-jobs) has the ordering, the locks and the jobs.

## Considered Options

- **A `roster … --json` subprocess per action**: each call would need to unlock the vault again or leave a session file on disk, and would pay Python's startup time on every click. (The CLI did get `--json` later, decision Q110, as roster's interface for scripts and other tools; the app still uses serve, for the reasons above.)
- **An HTTP API on localhost**: easier to poke with curl, but any local process could call it while the vault is unlocked, so it would need tokens and hardening. With stdio, only the parent app can talk to it. A user-only local socket can be added later if other clients need it.
- **Rewriting the backend in Rust inside the app**: it would fork roster's model into two implementations.
