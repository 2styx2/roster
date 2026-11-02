# Configuration is a Lua file, and there's no Settings screen

_Formerly roster-desk ADR 0002; renumbered when the app joined the roster repo (ADR 0007)._

_Amended (decision Q58): the Config reloads on `:source`, or on every save with `auto_reload = true`._

_Amended (decision Q132): the documented style is Neovim-like (`roster.o.terminal.size = "16pt"`, `roster.keymap.set`, `roster.packages.add`, modules under `lua/`); a file that returns a table still loads, and that table wins over the calls._

The roster app is configured by one `init.lua` in the user config directory. It works like WezTerm and Neovim: the file returns a table that the Rust core evaluates with mlua (Lua 5.4 built in), and it reloads on save. There is no Settings screen. The user wants a terminal-first, keyboard-first tool whose setup is code they can keep in dotfiles, and Lua leaves room for logic and, later, hooks without a format migration.

## Considered Options

- **YAML or TOML**: simpler and matches `roster.yml`, but declarative only. Moving to Lua later would force a migration.
- **A Settings screen plus `settings.json`, with Lua layered on top (the VS Code style)**: friendlier to teammates who won't edit Lua, but there would be two sources of truth and much more UI to build. We can revisit this if the app goes to the team.

## Consequences

- **Everything visible is a default the Config can change** (decision Q33): color tokens and themes, fonts, the keymap, and layout pieces such as the sidebar, Sessions as a sidebar or as tabs, the status bar and the title bar contents. Build each of these as data read from the resolved Config, never hard-coded.

- The Lua code runs in the Rust core, which never holds secrets (ADR 0001), so a config can't read a password.
- The frontend never runs Lua. It gets a checked, typed Config object from the core.
- Window size, recent Hosts and similar things are **State**, kept in a separate app-managed file, never in `init.lua`.
- The keymap and options must be data tables from day one so that the Config can override them.
