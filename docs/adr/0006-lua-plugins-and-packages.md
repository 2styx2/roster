# Lua plugins and packages, Neovim-style, built on the same registries the app uses

_Formerly roster-desk ADR 0004; renumbered when the app joined the roster repo (ADR 0007)._

The roster app can be extended the way Neovim is. A **Plugin** is Lua code, loaded through the same mlua runtime as the Config (ADR 0004), that adds to the app's registries: commands, key bindings, themes, Sidebar sections, Picker and finder sources, status-line segments, and events (`roster.on("session_open", …)`, `session_exit`, `host_selected`, `lock`, …). A **Package** is a Plugin fetched from a git repo. `init.lua` lists the Packages it wants, and each is pinned to a commit in a lock file, the way lazy.nvim works. The built-in features use exactly these registries too, so a Plugin can do anything the app itself does, and the app's own code proves the API is complete.

## Boundaries

- **Never secrets.** Plugins run in the Rust core, which never holds a password (roster ADR 0001). They get Hosts and Login *references* through `roster serve`'s read methods, and can open Sessions through the normal command table. They never see a password, a vault session or an askpass token.
- **Inventory writes only as Pending changes.** A Plugin may call the same write methods as the UI, but changes always land as Pending changes that the user reviews and Publishes. A Plugin can never Publish by itself.
- **Declarative UI in v1.** Plugins add UI through the registries (commands, Sidebar sections, finder sources, status segments, themes). Plugin-supplied HTML/JS panels are not supported in v1; that would give arbitrary code the webview, and is a later decision.
- **Acting waits for the user** (added later). A Plugin may be granted serve methods that change Hosts or scan networks, and named web sites (`network:`), but anything flagged runs only in a call the user started (decisions Q97, Q100, Q103).
- **Explicit trust.** Packages are third-party code. Nothing installs unless it's named in `init.lua`. Every Package is pinned to a commit in `roster.lock`, and updating shows a diff of what changed.

## Why Lua 5.4, not LuaJIT

Neovim embeds LuaJIT; roster embeds Lua 5.4 (mlua's `lua54` feature, vendored: built from source into the app). Plugins are glue between roster's data and its UI, so LuaJIT's speed buys nothing that matters here, and what roster does need it can't promise on LuaJIT:

- **The memory limit.** Each Plugin gets a memory cap (`Lua::set_memory_limit`), which works through the custom allocator mlua gives the Lua state. On Lua 5.4 that allocator is always there. On LuaJIT, a build that won't take a custom allocator (64-bit without GC64) makes mlua fall back to LuaJIT's own, and the limit then fails with `MemoryControlNotAvailable`.
- **The time budget.** A call's deadline is checked by an instruction-count hook. LuaJIT doesn't run count hooks inside JIT-compiled code, so a hot loop in a compiled trace could run past its budget; holding to it would mean turning the JIT off, and then there's nothing left to gain.
- **The sandbox.** LuaJIT's FFI calls C directly, which would go around every permission of decision Q81. mlua refuses to load it in safe mode, but leaving it out removes LuaJIT's main feature for Plugin authors anyway.
- **The language.** Lua 5.4 has real 64-bit integers (a Session id, a port, a byte count stay exact), native bitwise operators, `//`, `goto`, `<const>` and `<close>`. LuaJIT is Lua 5.1 with some 5.2 additions and numbers that are doubles.
- **One build everywhere.** Lua 5.4 is portable C that compiles the same on every target the app ships for; LuaJIT needs its per-architecture backend.

The cost: Neovim authors meet small differences (no `bit` library, no `jit`, no FFI; `roster.*` rather than `vim.*`), which [the Plugin API reference](../plugin-api.md#the-lua) lists.

## Considered Options

- **JavaScript plugins in the webview (VS Code style)**: richer UI, but third-party code would run next to the terminal input and the master password field, and there'd be a second extension language beside the Lua config.
- **WASM components**: strong sandboxing, but far harder to write than a few lines of Lua, which is the whole appeal for people coming from Neovim.
- **No plugins, config only**: simpler, but the user wants the app to be extendable by the people using it.

## Consequences

- Every feature built from now on registers through a registry (commands, keymap, themes, Sidebar sections, finder sources, status segments, events) rather than being wired in directly. Tickets 07, 17, 21 and 22 follow this; Folders and the status bar's Host count are built-in Plugins on the public API (Q93).
- The plugin API is versioned like `roster serve`'s (`roster.api_version`), and it's documented in [docs/plugins.md](../plugins.md) and, function by function, in [docs/plugin-api.md](../plugin-api.md) (decision Q89). Permissions (decision Q81), how ticket 23 built it (Q82) and how ticket 24 built Packages (Q83) refine this ADR. Later decisions refine it too: Q93 (a data folder per Plugin; Folders as a built-in Plugin), Q94 (first-party Plugins in `plugins/`), Q95 to Q99 (views, runtime, network, interactions, graphs), Q103 and Q112 (a busy serve, jobs).
