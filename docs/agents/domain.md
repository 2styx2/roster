# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. roster is **single-context**: one glossary and one ADR folder cover the CLI and the app.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root (one file for the CLI and the app).
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.
- **`docs/app/decisions.md`**: the numbered decision log (`Q56`, `Q62`, …). Settled questions are not re-asked.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Building a Plugin

Before writing or changing a Plugin (the first-party ones of iteration 8 too), read these two; together they're the whole API, generated from the core so they can't be stale:

- **`docs/plugin-api.md`**: every `roster.*` function (parameters, returns, errors, permission, example), every type with all its fields, every event and what each `roster.serve.call` returns.
- **`examples/plugins/types/roster.lua`**: the same as LuaCATS stubs. Annotate the Plugin with them and run `lua-language-server --check` on its folder, as CI does for `examples/plugins/`.

Then `docs/plugins.md` for the narrative (manifest, permissions, limits) and `examples/plugins/recent-alerts` as the worked example. A Plugin needing something the API lacks is a change to `crates/roster-core/src/plugin/api/` and the runtime together (CONTRIBUTING.md, "Docs").

## Changing roster's Lua surface

Before adding to `init.lua`'s `roster` table or the Plugin API, read CONTRIBUTING.md, "Lua API". The owner's rule: every object or collection exposed in Lua (`init.lua`'s `roster.*` and the Plugin API) ships complete: the functions needed to use it fully (add / get / list / has / update / remove or del, plus natural helpers such as a list's `:append` / `:prepend` / `:remove` and `reset`) and the read-only fields it needs. Bad names error at the caller's line (no silent no-ops); reads return copies; and every function, field and object has a generated `:help` entry (summary, type or signature, what it expects, example) with the same text in the editor types, in the same pull request as the code. Actions that touch the network or disk stay commands, not config functions.

`init.lua` is written the way Neovim's is (`roster.o.terminal.size = "16pt"`, `roster.keymap.set`, modules under `lua/`); docs, examples and tests show that style. The returned table still loads, for older Configs (decision Q132).

## File structure

```text
/
├── GLOSSARY.md
├── docs/
│   ├── adr/
│   │   ├── 0001-gui-talks-to-roster-serve.md
│   │   └── …
│   └── app/decisions.md
├── src/roster/        ← the CLI
├── app/               ← the desktop app
└── crates/roster-core/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR or decision, surface it explicitly rather than silently overriding:

> _Contradicts ADR 0001 (the app talks to `roster serve`), but worth reopening because…_
