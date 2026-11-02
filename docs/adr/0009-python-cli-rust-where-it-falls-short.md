# The CLI stays Python, with checked types; Rust where Python falls short; a rewrite only once the app has matured

_Owner's decision (2026-11-01), decision Q113; the work is ticket T112 (issue #196)._

The roster CLI and `roster serve` stay in Python. Q112 already kept the Python backend; this records why, and what changes instead.

- **Types are checked.** A type checker runs in CI next to ruff, strict for every module that is new or rewritten. Roster's data (the Inventory's Hosts, Logins and groups, serve's params and results, `--json` documents) becomes Pydantic models, so bad data fails at the edge with a `Problem` (`errors.py`), not deep inside a command. Every new data shape is a model from now on; existing dicts move over when a ticket touches them, not in one sweep.
- **Rust where Python falls short.** When a feature can't be done well in Python (speed, concurrency, packaging, or something the app's core already does), it's written in Rust, in the Cargo workspace next to `crates/roster-core`, not as a second Python copy. The first ticket that does this decides how the CLI reaches it (a PyO3 module built with maturin, which changes the wheel's build, or a helper binary the CLI runs) and records it as a decision.
- **A full rewrite is revisited later**, once the app has matured, not now. Signs that it's time: installing Python is a real obstacle for users (above all on Windows), serve keeps hitting concurrency bugs that Rust's compiler would have refused, the app wants to ship without a Python runtime, or most of the CLI's logic already lives in Rust.

## Why

Python is already memory-safe, so a rewrite wouldn't fix a class of bugs roster has. What it lacks is checked types: today `src/roster/` is plain dicts with no type checker, so a wrong key or a missed `None` shows up at runtime. A type checker and Pydantic close most of that gap in days.

A rewrite would cost months. That's about 12,700 lines of CLI and 10,900 of tests, with feature work stopped while it happens and old bugs coming back. The CLI changes fast right now (serve's API passed 20 in a few days), and Python is the faster language for that.

Rust's real wins for roster are a single binary with no Python to install, one language with the app's core, and data races caught at compile time in serve's workers. The incremental rule above gets those where they matter, and the rewrite stays open for when they matter everywhere.

## Consequences

- `pydantic>=2` becomes a runtime dependency. It adds to the CLI's start-up time; T112 measures it, and models are imported lazily if needed.
- Pydantic models must never put a secret in a `repr` or a validation error (`SecretStr`, `repr=False`; [security.md](../app/security.md)).
- The JSON that serve and `--json` return keeps its shape; models describe it, they don't change it.
- ADR 0001 stands: the app reaches roster only through `roster serve`, whatever language serve's parts are in.

## Considered Options

- **Rewrite the CLI in Rust now:** one language and one binary, but months of porting with features frozen, and the YAML side of Rust is weaker (serde_yaml is unmaintained).
- **Stay Python with no change:** no cost now, but the dict-shaped data keeps producing runtime errors, and they grow as serve gets more methods.
- **Only type hints, no Pydantic:** a type checker sees the code but not `roster.yml` or a request from the app; Pydantic checks the data that comes in at runtime too.
