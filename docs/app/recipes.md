# Recipes

Short `init.lua` snippets for things people often want. Each one works when pasted anywhere in your `init.lua` (or a module it requires), then `:source`. They're one way to do it, not the only one: [Options](options) lists everything, and `:help` on any option says more. Anything a snippet leaves out keeps its default.

## Use Ctrl+b as the Leader

```lua
roster.o.leader = "Ctrl+b"
```

tmux's prefix. The Leader is the one chord the terminal never sees, so pick one your shell doesn't need: Ctrl+b moves the cursor back a character in bash. See [leader](leader) and [Keyboard](keyboard.md).

## Bind a key to a Host you open all day

```lua
roster.keymap.set("leader", "p", "connect esx-02")
```

`␣ p` now opens `esx-02`. An action is any command line, exactly what you'd type after `:`, so `"finder sessions"`, `"theme nord"` or `"mode focus"` work the same way. `false` unbinds a default: `roster.keymap.set("leader", "d d", false)`.

## Paste with Ctrl+V

```lua
roster.keymap.set("terminal", "Ctrl+v", "terminal.paste")
```

Ctrl+V belongs to the shell by default (its quoted insert, and Vim's block selection). See [Copy and paste](keyboard.md#copy-and-paste).

## A light Theme by day, a dark one at night

```lua
roster.o.theme = "auto"
roster.o.dark_theme = "tokyo-night"
roster.o.light_theme = "roster-light"
```

`"auto"` follows the OS's light or dark setting. `:theme` previews every Theme live and keeps the one you choose; `:help themes` lists them.

## Your own Theme, from a bundled one

```lua
roster.themes.define("ember", {
  label = "Ember",
  base = "roster-dark",
  colors = { accent = "#e0803a" },
})
roster.o.theme = "ember"
```

Or leave out the last line and pick it with `:theme ember`. A Theme changes only the tokens it names; the rest come from `base`. `roster.themes.update("nord", { colors = { accent = "#88c0d0" } })` changes a bundled Theme the same way. [Themes](themes.md) lists every token.

## A bigger terminal font

```lua
roster.o.terminal.size = "15pt"
roster.o.terminal.font = { "Cascadia Mono", "Iosevka" }
```

The first font that's installed is used, and the bundled Iosevka is always there. `Ctrl+=` and `Ctrl+-` zoom one Session; `Ctrl+0` comes back to `size`. To keep the default fonts after yours, add it to the list instead: `roster.o.terminal.font:prepend("Cascadia Mono")`.

## The Sidebar on the right, with only Sessions and the Inventory

```lua
roster.o.modes.standard.sidebar = { side = "right", sections = { "sessions", "inventory" } }
```

`sections` picks and orders them. `␣ e` still shows or hides the Sidebar.

## A quieter status bar and toolbar

```lua
roster.o.modes.standard.statusbar = { "box", "hosts", "changes" }
roster.o.modes.standard.toolbar = { "find", "add", "help" }
roster.o.modes.standard.toolbar:append("lock")
```

Each is a list of pieces in order, `false` for none, or `true` for the default set. Once it's a list, its list functions (`:append`, `:remove`, …) change it. The pieces are in [Your init.lua](config.md#layout).

## Start in Focus, with a session bar

```lua
roster.o.default_mode = "focus"
roster.o.modes.focus.sessionbar = "top"
```

Focus is fullscreen with only the terminal; F11 or `␣ m` switches. The session bar is a thin tmux-style line of open Sessions.

## Hide the keycap hints

```lua
roster.o.ui.hints = false
```

Every binding still works, and `␣ K` and `:help` still show the keys. Leave it unset to let `:hints` decide.

## Show every message, as before

```lua
roster.o.ui.messages = "all"
```

The message line is quiet by default, as Neovim's: errors, warnings, answers and results that need attention show, a routine confirmation or a toggle's tip (which `init.lua` line makes it the default) doesn't. `"all"` shows them too; `:messages all` does it without `init.lua`, and the app remembers. `:messages` alone lists the recent ones either way.

## Reload when you save

```lua
roster.o.auto_reload = true
```

Otherwise saving does nothing until `:source` (`␣ S`), as in Neovim, so a half-written file never takes effect.

## Keep your Hosts in a Folder of your own

```lua
roster.folders.add({ name = "Lab", hosts = { "esx-02", "esx-03" } })
roster.folders.add_hosts("Lab", { "esx-04" })
```

Folders in `init.lua` are read-only in the app. Folders you make in the app (`␣ a`) are kept by the built-in Folders Plugin in roster's own data instead (a `folders.yml` from older versions is moved in once: [config.md](config.md#foldersyml)).

## Split init.lua into modules

```lua
-- lua/myconf/keys.lua
roster.keymap.set("leader", "p", "connect esx-02")
```

```lua
-- init.lua
require("myconf.keys")
```

Each module sets what it's about; they run in the order `init.lua` requires them, and a later line wins over an earlier one. An error names the module and its line. [`examples/init-split`](../../examples/init-split) is a whole Config written this way ([Split into modules](config.md#split-into-modules)). `require` loads only files from the config folder. A symlinked `init.lua` or `lua/` folder works, so the Config can live in your dotfiles repo.

## Something different on Windows

```lua
if roster.os == "windows" then
  roster.o.terminal.font = "Cascadia Mono"
end
```

It's plain Lua: `if`, functions and loops all work.

## See also

[Your init.lua](config.md) · [Options](options) · [How far roster bends](extending.md) · [Keyboard](keyboard.md)
