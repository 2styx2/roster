# Option reference

<!-- Generated from crates/roster-core/src/config/shape by `cargo run -p roster-core --example gen_config_options`: edit that, then run it. -->

Every option `init.lua` takes, and every name of its `roster` table, one entry each, the way Neovim's `:help 'option'` lists its options: how it's written, its type, its default, the values it can have, what it does and an example. Each entry is a help topic: `:help terminal.size`, `:help roster.keymap.set`, `:help roster.config.Theme`. In the app, `:help options` shows them with the value each option has now and where it was set, and `:options` finds one. [The Config guide](config.md) says how `init.lua` works, and more about each option. `:config types` writes all of this as types for your editor ([Editor support](#editor-support)).

Types are written as [LuaCATS](https://luals.github.io/wiki/annotations/) writes them: `string[]` is a list of strings, `table<string, X>` a table of X by name, `"webgl"|"dom"` one of those strings, `roster.config.Theme` a table described under [Types](#types). An object (a table of named options, such as `terminal`) needs no setup: give only the options you change. A default of unset means nothing is set and the app, or a choice it keeps, decides; required is a field a spec can't leave out.

## The `roster` table

A global in `init.lua` and its modules, and also require(`"roster"`). A Plugin gets a bigger one: [the Plugin API](../plugin-api.md).

### `roster.os`

`"windows"|"linux"|"macos"`

The OS the app runs on. Read-only.

```lua
if roster.os == "windows" then
  roster.o.backend = "wsl"
end
```

### `roster.api_version`

`integer`

The version of this table, raised when it changes. Read-only. The Plugin API's version too: it rises with that.

```lua
if roster.api_version >= 4 then roster.o.vim = false end
```

### `roster.version`

`string`

The app's version. Read-only.

```lua
if roster.version:match("^0%.2") then roster.o.auto_reload = true end
```

### `roster.config_dir`

`string`

The config folder: where init.lua is, as this machine writes the path. Read-only. For messages and comparisons; require already looks there.

```lua
print("Config in " .. roster.config_dir)
```

### `roster.o`

`roster.config.Options`

Every option, as a table you assign to and read: roster.o.terminal.size = `"16pt"`. Nested objects need no setup. An unknown name is an error at its line, with the name meant; a value of the wrong type too. Reading an option gives the value set so far (a copy), or nil; reading an object, a map or a list gives its table, with the methods its kind has (roster.o.Object, roster.o.Map, roster.o.List). Assigning a whole table replaces that branch; assigning one roster.o table to another option copies what it holds (what init.lua set, else its default), and one that holds neither is an error. The table init.lua returns, if any, wins over what roster.o sets.

```lua
roster.o.terminal.size = "16pt"
roster.o.terminal.font:prepend("Cascadia Mono")
if roster.o.vim then roster.o.keys.leader.p = "connect esx-02" end
```

### `roster.o.get(name)`

returns `any`

Reads any option by its dotted name: a copy of what init.lua set there, or nil. The read that always works: a map's key named like a method (get, has, keys, reset) reads as that key here, set or not. A table comes back as a plain copy, to walk with pairs(). An unknown name is an error at its line.

| Parameter | Type | |
|---|---|---|
| `name` | `roster.config.OptionName` | An option's dotted name: `"terminal.size"`, `"views.get"`. |

```lua
local views = roster.o.get("views") or {}
for id in pairs(views) do print(id) end
```

### `roster.o.reset(name)`

Puts an option back to its default: what init.lua set there is taken away. Any option: a value, an object, a map or a list. An unknown name is an error at its line.

| Parameter | Type | |
|---|---|---|
| `name` | `roster.config.OptionName` | An option's dotted name: `"terminal.size"`. |

```lua
roster.o.reset("terminal.size")
```

### `roster.set(name, value)`

Sets any option by its dotted name, as roster.o does. The same store as roster.o: the last write wins. The name and the value are checked at the call's line. The returned table wins over a call that sets the same option.

| Parameter | Type | |
|---|---|---|
| `name` | `roster.config.OptionName` | An option's dotted name: `"terminal.size"`. |
| `value` | `any` | Its value, as the option takes it; nil resets it. |

```lua
roster.set("terminal.size", "16pt")
```

### `roster.keymap.set(context, keys, action)`

Binds a key, as keys.<context> does. A later set of the same keys replaces it. An unknown context is an error at its line.

| Parameter | Type | |
|---|---|---|
| `context` | `"leader"\|"list"\|"list_vim"\|"picker"\|"picker_vim"\|"cmdline"\|"terminal"\|"global"` | The keymap's context. |
| `keys` | `string` | A chord or a sequence of chords separated by spaces: `"Ctrl+n"`, `"d d"`. |
| `action` | `roster.config.KeyAction` | A command line, or false to unbind a default. |

```lua
roster.keymap.set("leader", "p", "connect esx-02")
```

### `roster.keymap.del(context, keys)`

Takes off a key binding init.lua made. Keys init.lua didn't bind are an error at the line; to unbind one of roster's own, set it to false.

| Parameter | Type | |
|---|---|---|
| `context` | `"leader"\|"list"\|"list_vim"\|"picker"\|"picker_vim"\|"cmdline"\|"terminal"\|"global"` | The keymap's context. |
| `keys` | `string` | The keys, as set took them. |

```lua
roster.keymap.del("leader", "p")
```

### `roster.keymap.get(context, keys)`

returns `roster.config.KeyAction?`

The action init.lua bound to keys, or nil. Roster's own bindings aren't in it.

| Parameter | Type | |
|---|---|---|
| `context` | `"leader"\|"list"\|"list_vim"\|"picker"\|"picker_vim"\|"cmdline"\|"terminal"\|"global"` | The keymap's context. |
| `keys` | `string` | The keys, as set took them. |

```lua
if not roster.keymap.get("leader", "p") then roster.keymap.set("leader", "p", "close") end
```

### `roster.keymap.has(context, keys)`

returns `boolean`

Whether init.lua bound keys in a context. A binding to false (one of roster's own taken off) counts: del takes it off. Roster's own bindings don't.

| Parameter | Type | |
|---|---|---|
| `context` | `"leader"\|"list"\|"list_vim"\|"picker"\|"picker_vim"\|"cmdline"\|"terminal"\|"global"` | The keymap's context. |
| `keys` | `string` | The keys, as set took them. |

```lua
if not roster.keymap.has("leader", "p") then roster.keymap.set("leader", "p", "close") end
```

### `roster.keymap.list(context)`

returns `table<string, roster.config.KeyAction>`

A copy of init.lua's bindings in a context: keys → action. An empty table when it binds none there.

| Parameter | Type | |
|---|---|---|
| `context` | `"leader"\|"list"\|"list_vim"\|"picker"\|"picker_vim"\|"cmdline"\|"terminal"\|"global"` | The keymap's context. |

```lua
for keys, action in pairs(roster.keymap.list("leader")) do print(keys, action) end
```

### `roster.themes.define(id, theme)`

Defines a Theme, as themes.<id> does. An id already defined is an error naming both lines (change it with update); a bundled Theme's id too.

| Parameter | Type | |
|---|---|---|
| `id` | `string` | The Theme's id: not `"auto"`, not a bundled Theme's. |
| `theme` | `roster.config.Theme` | A Theme spec. |

```lua
roster.themes.define("paper", { appearance = "light", colors = { accent = "#b85c00" } })
```

### `roster.themes.update(id, fields)`

Changes a Theme: one init.lua defined, or a bundled one (which becomes a changed copy of itself). An id that is neither is an error at its line.

| Parameter | Type | |
|---|---|---|
| `id` | `string` | A Theme init.lua defined, or a bundled one. |
| `fields` | `roster.config.Theme` | What to change: tables (colors, terminal, ansi) merge token by token. |

```lua
roster.themes.update("nord", { colors = { accent = "#88c0d0" } })
```

### `roster.themes.remove(id)`

Removes a Theme init.lua defined (or its changes to a bundled one). A bundled Theme init.lua didn't change, or an id it doesn't have, is an error at its line.

| Parameter | Type | |
|---|---|---|
| `id` | `string` | A Theme init.lua defined. |

```lua
roster.themes.remove("paper")
```

### `roster.themes.get(id)`

returns `roster.config.Theme?`

A copy of init.lua's spec for a Theme, or nil. Nil for a bundled Theme init.lua didn't change.

| Parameter | Type | |
|---|---|---|
| `id` | `string` | A Theme's id. |

```lua
local paper = roster.themes.get("paper")
if paper then print(paper.label) end
```

### `roster.themes.has(id)`

returns `boolean`

Whether there's a Theme by that id: a bundled one or init.lua's. As list names them; get says whether init.lua has a spec of its own for it.

| Parameter | Type | |
|---|---|---|
| `id` | `string` | A Theme's id. |

```lua
if not roster.themes.has("paper") then roster.themes.define("paper", { appearance = "light" }) end
```

### `roster.themes.list()`

returns `string[]`

Every Theme's id: the bundled ones, then init.lua's.

```lua
for _, id in ipairs(roster.themes.list()) do print(id) end
```

### `roster.packages.add(...)`

Adds Packages, from any file of the Config. Two Packages with the same name are an error naming both lines. Fetching is a command: :packages update.

| Parameter | Type | |
|---|---|---|
| `...` | `string\|roster.config.Package` | Package specs: { SOURCE, tag = … } or just SOURCE. |

```lua
roster.packages.add({ "someone/recent-alerts", tag = "v1.2.0" }, "someone/pinned")
```

### `roster.packages.remove(name)`

Takes a Package out of the Config. A name it doesn't have is an error at its line. Its folder stays until :packages clean.

| Parameter | Type | |
|---|---|---|
| `name` | `string` | Its name (letter case aside). |

```lua
roster.packages.remove("recent-alerts")
```

### `roster.packages.update(name, fields)`

Changes a Package's spec: pin a tag, change its config. A name it doesn't have, or a field a Package spec doesn't have, is an error at its line.

| Parameter | Type | |
|---|---|---|
| `name` | `string` | Its name (letter case aside). |
| `fields` | `roster.config.Package` | Fields to set over the spec's; a tag, branch or commit replaces the other two. |

```lua
roster.packages.update("recent-alerts", { tag = "v1.3.0" })
```

### `roster.packages.get(name)`

returns `roster.config.Package?`

A copy of a Package's spec, or nil. Its source is in source.

| Parameter | Type | |
|---|---|---|
| `name` | `string` | Its name (letter case aside). |

```lua
local alerts = roster.packages.get("recent-alerts")
if alerts then print(alerts.tag) end
```

### `roster.packages.list()`

returns `roster.config.Package[]`

Copies of every Package's spec, in order.

```lua
for _, p in ipairs(roster.packages.list()) do print(p.source) end
```

### `roster.packages.has(name)`

returns `boolean`

Whether the Config has a Package by that name.

| Parameter | Type | |
|---|---|---|
| `name` | `string` | Its name (letter case aside). |

```lua
if not roster.packages.has("pinned") then roster.packages.add("someone/pinned") end
```

### `roster.folders.add(...)`

Adds Folders, from any file of the Config. Two Folders with the same name (letter case aside) are an error naming both lines.

| Parameter | Type | |
|---|---|---|
| `...` | `roster.config.Folder` | Folder specs: { name = …, hosts = { … } }. |

```lua
roster.folders.add({ name = "Lab", hosts = { "esx-02", "esx-03" } })
```

### `roster.folders.remove(name)`

Takes a Folder out of the Config. A name it doesn't have is an error at its line.

| Parameter | Type | |
|---|---|---|
| `name` | `string` | Its name (letter case aside). |

```lua
roster.folders.remove("Lab")
```

### `roster.folders.update(name, fields)`

Changes a Folder: rename it, or give it other Hosts. A name it doesn't have is an error at its line; a new name another Folder has names both lines.

| Parameter | Type | |
|---|---|---|
| `name` | `string` | Its name (letter case aside). |
| `fields` | `roster.config.Folder` | Fields to set over the Folder's: name, hosts. |

```lua
roster.folders.update("Lab", { name = "Lab boxes" })
```

### `roster.folders.get(name)`

returns `roster.config.Folder?`

A copy of a Folder's spec, or nil.

| Parameter | Type | |
|---|---|---|
| `name` | `string` | Its name (letter case aside). |

```lua
local lab = roster.folders.get("Lab")
if lab then print(#lab.hosts) end
```

### `roster.folders.list()`

returns `roster.config.Folder[]`

Copies of every Folder's spec, in order.

```lua
for _, f in ipairs(roster.folders.list()) do print(f.name) end
```

### `roster.folders.has(name)`

returns `boolean`

Whether the Config has a Folder by that name.

| Parameter | Type | |
|---|---|---|
| `name` | `string` | Its name (letter case aside). |

```lua
if roster.folders.has("Lab") then roster.folders.add_hosts("Lab", "esx-04") end
```

### `roster.folders.add_hosts(name, hosts)`

Adds Hosts to the end of a Folder. A Host it has already, or a Folder it doesn't have, is an error at its line.

| Parameter | Type | |
|---|---|---|
| `name` | `string` | Its name (letter case aside). |
| `hosts` | `string\|string[]` | A Host's name, or a list of them. |

```lua
roster.folders.add_hosts("Lab", { "esx-04", "esx-05" })
```

### `roster.folders.remove_hosts(name, hosts)`

Takes Hosts out of a Folder. A Host it doesn't have, or a Folder it doesn't have, is an error at its line.

| Parameter | Type | |
|---|---|---|
| `name` | `string` | Its name (letter case aside). |
| `hosts` | `string\|string[]` | A Host's name, or a list of them. |

```lua
roster.folders.remove_hosts("Lab", "esx-05")
```

## The tables of `roster.o`

Reading an object, a map or a list from `roster.o` gives its table, with these methods (call them with a colon: `roster.o.terminal.font:append("Hack")`). Each option's entry lists what its kind takes; a value is read and assigned as it is.

### `roster.o.Object:get()`

returns `table?`

A copy of what init.lua set in an object (a table of named options), or nil. Defaults aren't in it: only what was set.

```lua
local t = roster.o.terminal:get()
if t then print(t.size) end
```

### `roster.o.Object:reset()`

Puts every option in an object back to its default.

```lua
roster.o.terminal:reset()
```

### `roster.o.Map:get()`

returns `table?`

A copy of a map (a table keyed by names you pick): key → value, or nil when nothing is set. Read one key with map.KEY; set one with map.KEY = value, remove it with map.KEY = nil.

```lua
local views = roster.o.views:get() or {}
for id in pairs(views) do print(id) end
```

### `roster.o.Map:has(key)`

returns `boolean`

Whether init.lua set this key of a map. A key named like a method (get, has, keys, reset) reads as that key once init.lua has set it, and as the method until then; roster.o.get(name) always reads and roster.o.reset(name) always resets.

| Parameter | Type | |
|---|---|---|
| `key` | `string` | A key. |

```lua
if not roster.o.views:has("topology") then roster.o.views.topology = { place = "panel" } end
```

### `roster.o.Map:keys()`

returns `string[]`

The keys init.lua set in a map.

```lua
for _, id in ipairs(roster.o.themes:keys()) do print(id) end
```

### `roster.o.Map:reset()`

Takes away every key init.lua set in a map: it's back to its default.

```lua
roster.o.views:reset()
```

### `roster.o.List:get()`

returns `any[]?`

A copy of a list, or nil when init.lua didn't set it.

```lua
local fonts = roster.o.terminal.font:get()
if fonts then print(#fonts) end
```

### `roster.o.List:append(...)`

Adds items to the end of a list. An unset list starts from its default. A list that takes each item once refuses one it has, at the line.

| Parameter | Type | |
|---|---|---|
| `...` | `any` | Items to add. |

```lua
roster.o.terminal.font:append("Fira Code")
```

### `roster.o.List:prepend(...)`

Adds items to the start of a list, in the order given. As append.

| Parameter | Type | |
|---|---|---|
| `...` | `any` | Items to add. |

```lua
roster.o.terminal.font:prepend("Cascadia Mono")
```

### `roster.o.List:insert(i, value)`

Puts an item at a position of a list. A position outside the list is an error at the line.

| Parameter | Type | |
|---|---|---|
| `i` | `integer` | The position, from 1 to the list's length + 1. |
| `value` | `any` | The item. |

```lua
roster.o.terminal.font:insert(2, "Cascadia Mono")
```

### `roster.o.List:remove(...)`

Takes items out of a list. An item it doesn't have is an error at the line.

| Parameter | Type | |
|---|---|---|
| `...` | `any` | Items to take out (for folders and packages, a name will do). |

```lua
roster.o.terminal.font:remove("Iosevka Term")
```

### `roster.o.List:has(value)`

returns `boolean`

Whether a list has an item, its default counted while it's unset.

| Parameter | Type | |
|---|---|---|
| `value` | `any` | An item (for folders and packages, a name will do). |

```lua
if not roster.o.terminal.font:has("Hack") then roster.o.terminal.font:append("Hack") end
```

### `roster.o.List:clear()`

Empties a list. A list that needs an item (terminal.font) refuses to be empty, at the line.

```lua
roster.o.folders:clear()
```

### `roster.o.List:reset()`

Puts a list back to its default.

```lua
roster.o.terminal.font:reset()
```

## Themes and colours

### `theme`

`roster.o.theme` · `string` · default `"auto"`

The Theme to use, or `"auto"` to follow the OS's light or dark setting with dark_theme and light_theme.

Takes a Theme's id, or `"auto"`.

Methods: `roster.o.theme = value` · `roster.o.theme` · `roster.o.reset("theme")`.

```lua
roster.o.theme = "nord"
```

### `dark_theme`

`roster.o.dark_theme` · `string` · default `"roster-dark"`

The Theme `"auto"` picks while the OS is dark.

Takes a Theme's id.

Methods: `roster.o.dark_theme = value` · `roster.o.dark_theme` · `roster.o.reset("dark_theme")`.

```lua
roster.o.dark_theme = "tokyo-night"
```

### `light_theme`

`roster.o.light_theme` · `string` · default `"roster-light"`

The Theme `"auto"` picks while the OS is light.

Takes a Theme's id.

Methods: `roster.o.light_theme = value` · `roster.o.light_theme` · `roster.o.reset("light_theme")`.

```lua
roster.o.light_theme = "paper"
```

### `themes`

`roster.o.themes` · `table<string, roster.config.Theme>` · default `{}`

New Themes, or changed copies of bundled ones, by id: each a Theme spec.

Each value is a [`roster.config.Theme`](#rosterconfigtheme).

Methods: `roster.o.themes.KEY = value` · `.KEY` · `.KEY = nil` · `:get()` · `:has(key)` · `:keys()` · `:reset()`.

```lua
roster.o.themes = { paper = { appearance = "light", colors = { accent = "#b85c00" } } }
```

### `colors`

`roster.o.colors` · `roster.config.UiColors` · default `{}`

UI colour tokens set over whichever Theme is in use.

Names: `accent`, `accent_text`, `accent_ink`, `tone`, `bg`, `chrome`, `sidebar`, `panel`, `raised`, `raised_line`, `hover`, `line`, `line_strong`, `text`, `muted`, `faint`, `warn`, `error`, `danger`, `danger_text`, `backdrop`, `shadow`, `syntax_keyword`, `syntax_string`, `syntax_number`, `syntax_comment`, `syntax_function`, `syntax_punctuation`, `syntax_key`, `syntax_command`.

Methods: `roster.o.colors = { … }` · `roster.o.colors.NAME` · `:get()` · `:reset()`.

```lua
roster.o.colors = { accent = "#e8a33d" }
```

## Fonts and the terminal

### `fonts`

`roster.o.fonts` · `roster.config.Fonts` · default `{}`

The UI's fonts.

Options in it: [`ui`](#fontsui), [`mono`](#fontsmono), [`ui_size`](#fontsui_size).

Methods: `roster.o.fonts = { … }` · `roster.o.fonts.NAME` · `:get()` · `:reset()`.

```lua
roster.o.fonts = { ui = "IBM Plex Sans" }
```

### `fonts.ui`

`roster.o.fonts.ui` · `string` · default `"Inter"`

The UI's font.

Takes a family name, or a CSS font stack (anything with a comma).

Methods: `roster.o.fonts.ui = value` · `roster.o.fonts.ui` · `roster.o.reset("fonts.ui")`.

```lua
roster.o.fonts.ui = "IBM Plex Sans"
```

### `fonts.mono`

`roster.o.fonts.mono` · `string` · default `"Iosevka"`

The wordmark's and code-like UI text's font.

Takes a family name, or a CSS font stack.

Methods: `roster.o.fonts.mono = value` · `roster.o.fonts.mono` · `roster.o.reset("fonts.mono")`.

```lua
roster.o.fonts.mono = "JetBrains Mono"
```

### `fonts.ui_size`

`roster.o.fonts.ui_size` · `integer` · default `15`

The UI's text size; the smaller steps, the row height and the Sidebar's width follow it.

Takes 11 to 20 px.

Methods: `roster.o.fonts.ui_size = value` · `roster.o.fonts.ui_size` · `roster.o.reset("fonts.ui_size")`.

```lua
roster.o.fonts.ui_size = 16
```

### `ui`

`roster.o.ui` · `roster.config.Ui` · default `{}`

The rest of the UI's look.

Options in it: [`hints`](#uihints), [`messages`](#uimessages).

Methods: `roster.o.ui = { … }` · `roster.o.ui.NAME` · `:get()` · `:reset()`.

```lua
roster.o.ui = { hints = false }
```

### `ui.hints`

`roster.o.ui.hints` · `boolean` · default unset

false hides every keycap hint. Unset, :hints decides and the State keeps its choice; set, it wins.

Methods: `roster.o.ui.hints = value` · `roster.o.ui.hints` · `roster.o.reset("ui.hints")`.

```lua
roster.o.ui.hints = false
```

### `ui.messages`

`roster.o.ui.messages` · `"quiet"|"all"` · default unset

What the message line shows: errors, warnings and answers only (`"quiet"`), or routine confirmations too (`"all"`). Unset, :messages decides.

Methods: `roster.o.ui.messages = value` · `roster.o.ui.messages` · `roster.o.reset("ui.messages")`.

```lua
roster.o.ui.messages = "all"
```

### `terminal`

`roster.o.terminal` · `roster.config.Terminal` · default `{}`

The terminal's font, look and behaviour.

Options in it: [`font`](#terminalfont), [`size`](#terminalsize), [`weight`](#terminalweight), [`bold_weight`](#terminalbold_weight), [`bold_is_bright`](#terminalbold_is_bright), [`line_height`](#terminalline_height), [`cell_height`](#terminalcell_height), [`renderer`](#terminalrenderer), [`cursor_style`](#terminalcursor_style), [`scrollback`](#terminalscrollback), [`copy_on_select`](#terminalcopy_on_select), [`right_click_paste`](#terminalright_click_paste), [`colors`](#terminalcolors), [`shell_hooks`](#terminalshell_hooks).

Methods: `roster.o.terminal = { … }` · `roster.o.terminal.NAME` · `:get()` · `:reset()`.

```lua
roster.o.terminal = { font = { "Fira Code", "Iosevka" } }
```

### `terminal.font`

`roster.o.terminal.font` · `string|string[]` · default `{ "Iosevka Nerd Font", "Iosevka Term", "Iosevka" }`

Font families, most wanted first: the first one installed is used.

Takes a font name, a CSS font stack, or a list of names; each item once.

Methods: `roster.o.terminal.font = { … }` · `:get()` · `:append(value, …)` · `:prepend(value, …)` · `:insert(i, value)` · `:remove(value)` · `:has(value)` · `:clear()` · `:reset()`.

```lua
roster.o.terminal.font = { "Fira Code", "Iosevka" }
```

### `terminal.size`

`roster.o.terminal.size` · `number|string` · default `"13pt"`

The font size: a number is px, `"16pt"` is points (as Windows Terminal converts them), `"21px"` works too.

Takes 6 to 72 px (4.5 to 54 pt).

Methods: `roster.o.terminal.size = value` · `roster.o.terminal.size` · `roster.o.reset("terminal.size")`.

```lua
roster.o.terminal.size = "16pt"
```

### `terminal.weight`

`roster.o.terminal.weight` · `integer` · default `500`

The font weight; the bundled Iosevka has 400, 500 and 700.

Takes 100 to 900.

Methods: `roster.o.terminal.weight = value` · `roster.o.terminal.weight` · `roster.o.reset("terminal.weight")`.

```lua
roster.o.terminal.weight = 400
```

### `terminal.bold_weight`

`roster.o.terminal.bold_weight` · `integer` · default `700`

The weight of bold (SGR 1) text.

Takes 100 to 900.

Methods: `roster.o.terminal.bold_weight = value` · `roster.o.terminal.bold_weight` · `roster.o.reset("terminal.bold_weight")`.

```lua
roster.o.terminal.bold_weight = 800
```

### `terminal.bold_is_bright`

`roster.o.terminal.bold_is_bright` · `boolean` · default `true`

Bold text in the bright ANSI colours too.

Methods: `roster.o.terminal.bold_is_bright = value` · `roster.o.terminal.bold_is_bright` · `roster.o.reset("terminal.bold_is_bright")`.

```lua
roster.o.terminal.bold_is_bright = false
```

### `terminal.line_height`

`roster.o.terminal.line_height` · `number` · default `1.0`

A multiple of the font's own line height.

Takes 0.5 to 3.

Methods: `roster.o.terminal.line_height = value` · `roster.o.terminal.line_height` · `roster.o.reset("terminal.line_height")`.

```lua
roster.o.terminal.line_height = 1.2
```

### `terminal.cell_height`

`roster.o.terminal.cell_height` · `number` · default unset

A multiple of the font size, as Windows Terminal's cellHeight; wins over line_height.

Takes 0.5 to 3.

Methods: `roster.o.terminal.cell_height = value` · `roster.o.terminal.cell_height` · `roster.o.reset("terminal.cell_height")`.

```lua
roster.o.terminal.cell_height = 1.1
```

### `terminal.renderer`

`roster.o.terminal.renderer` · `"webgl"|"dom"` · default `"webgl"`

WebGL (fast) or the DOM (the browser's own text rendering).

Methods: `roster.o.terminal.renderer = value` · `roster.o.terminal.renderer` · `roster.o.reset("terminal.renderer")`.

```lua
roster.o.terminal.renderer = "dom"
```

### `terminal.cursor_style`

`roster.o.terminal.cursor_style` · `"block"|"bar"|"underline"` · default `"block"`

The cursor's shape.

Methods: `roster.o.terminal.cursor_style = value` · `roster.o.terminal.cursor_style` · `roster.o.reset("terminal.cursor_style")`.

```lua
roster.o.terminal.cursor_style = "bar"
```

### `terminal.scrollback`

`roster.o.terminal.scrollback` · `integer` · default `10000`

How many lines the terminal keeps above the screen.

Takes 0 to 1000000 lines.

Methods: `roster.o.terminal.scrollback = value` · `roster.o.terminal.scrollback` · `roster.o.reset("terminal.scrollback")`.

```lua
roster.o.terminal.scrollback = 50000
```

### `terminal.copy_on_select`

`roster.o.terminal.copy_on_select` · `boolean` · default `true`

Selecting text copies it.

Methods: `roster.o.terminal.copy_on_select = value` · `roster.o.terminal.copy_on_select` · `roster.o.reset("terminal.copy_on_select")`.

```lua
roster.o.terminal.copy_on_select = false
```

### `terminal.right_click_paste`

`roster.o.terminal.right_click_paste` · `boolean` · default `true`

Right-click copies the selection, or pastes when there's none.

Methods: `roster.o.terminal.right_click_paste = value` · `roster.o.terminal.right_click_paste` · `roster.o.reset("terminal.right_click_paste")`.

```lua
roster.o.terminal.right_click_paste = false
```

### `terminal.colors`

`roster.o.terminal.colors` · `roster.config.TerminalColors` · default `{}`

Any terminal or ANSI colour, set over the Theme's.

Names: `background`, `foreground`, `cursor`, `cursor_accent`, `selection_background`, `search_match`, `search_active_match`, `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `bright_black`, `bright_red`, `bright_green`, `bright_yellow`, `bright_blue`, `bright_magenta`, `bright_cyan`, `bright_white`.

Methods: `roster.o.terminal.colors = { … }` · `roster.o.terminal.colors.NAME` · `:get()` · `:reset()`.

```lua
roster.o.terminal.colors = { background = "#101418", red = "#e06c75" }
```

### `terminal.shell_hooks`

`roster.o.terminal.shell_hooks` · `boolean` · default unset

Send each Session's shell the line that turns on prompt marks (OSC 133) and its folder (OSC 7). Unset, a Host's shell_hooks in roster.yml decides.

Methods: `roster.o.terminal.shell_hooks = value` · `roster.o.terminal.shell_hooks` · `roster.o.reset("terminal.shell_hooks")`.

```lua
roster.o.terminal.shell_hooks = true
```

## Keys

### `leader`

`roster.o.leader` · `string` · default `"Ctrl+Space"`

The chord that takes the keyboard back from a terminal.

Takes a chord: `"Ctrl+Space"`, `"ctrl+b"`, `"C-b"` or `"<C-b>"`, with Ctrl, Alt or Meta.

Methods: `roster.o.leader = value` · `roster.o.leader` · `roster.o.reset("leader")`.

```lua
roster.o.leader = "Ctrl+b"
```

### `vim`

`roster.o.vim` · `boolean` · default `true`

j/k/h/l/gg/G in lists and the Picker.

Methods: `roster.o.vim = value` · `roster.o.vim` · `roster.o.reset("vim")`.

```lua
roster.o.vim = false
```

### `keys`

`roster.o.keys` · `roster.config.Keys` · default `{}`

Key bindings, per context: key or sequence → action.

Options in it: [`leader`](#keysleader), [`list`](#keyslist), [`list_vim`](#keyslist_vim), [`picker`](#keyspicker), [`picker_vim`](#keyspicker_vim), [`cmdline`](#keyscmdline), [`terminal`](#keysterminal), [`global`](#keysglobal).

Methods: `roster.o.keys = { … }` · `roster.o.keys.NAME` · `:get()` · `:reset()`.

```lua
roster.o.keys = { leader = { ["d d"] = "close", ["Ctrl+n"] = false } }
```

### `keys.leader`

`roster.o.keys.leader` · `table<string, roster.config.KeyAction>` · default `{}`

After the Leader: key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

Methods: `roster.o.keys.leader.KEY = value` · `.KEY` · `.KEY = nil` · `:get()` · `:has(key)` · `:keys()` · `:reset()`.

```lua
roster.o.keys.leader = { ["d d"] = "close", ["Ctrl+n"] = false }
```

### `keys.list`

`roster.o.keys.list` · `table<string, roster.config.KeyAction>` · default `{}`

In a list (the Sidebar): key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

Methods: `roster.o.keys.list.KEY = value` · `.KEY` · `.KEY = nil` · `:get()` · `:has(key)` · `:keys()` · `:reset()`.

```lua
roster.o.keys.list = { ["d d"] = "close", ["Ctrl+n"] = false }
```

### `keys.list_vim`

`roster.o.keys.list_vim` · `table<string, roster.config.KeyAction>` · default `{}`

In a list while vim keys are on: key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

Methods: `roster.o.keys.list_vim.KEY = value` · `.KEY` · `.KEY = nil` · `:get()` · `:has(key)` · `:keys()` · `:reset()`.

```lua
roster.o.keys.list_vim = { ["d d"] = "close", ["Ctrl+n"] = false }
```

### `keys.picker`

`roster.o.keys.picker` · `table<string, roster.config.KeyAction>` · default `{}`

In the Picker and every finder: key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

Methods: `roster.o.keys.picker.KEY = value` · `.KEY` · `.KEY = nil` · `:get()` · `:has(key)` · `:keys()` · `:reset()`.

```lua
roster.o.keys.picker = { ["d d"] = "close", ["Ctrl+n"] = false }
```

### `keys.picker_vim`

`roster.o.keys.picker_vim` · `table<string, roster.config.KeyAction>` · default `{}`

In the Picker's list while vim keys are on: key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

Methods: `roster.o.keys.picker_vim.KEY = value` · `.KEY` · `.KEY = nil` · `:get()` · `:has(key)` · `:keys()` · `:reset()`.

```lua
roster.o.keys.picker_vim = { ["d d"] = "close", ["Ctrl+n"] = false }
```

### `keys.cmdline`

`roster.o.keys.cmdline` · `table<string, roster.config.KeyAction>` · default `{}`

In the : command line: key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

Methods: `roster.o.keys.cmdline.KEY = value` · `.KEY` · `.KEY = nil` · `:get()` · `:has(key)` · `:keys()` · `:reset()`.

```lua
roster.o.keys.cmdline = { ["d d"] = "close", ["Ctrl+n"] = false }
```

### `keys.terminal`

`roster.o.keys.terminal` · `table<string, roster.config.KeyAction>` · default `{}`

In a terminal, before the shell sees the key: key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

Methods: `roster.o.keys.terminal.KEY = value` · `.KEY` · `.KEY = nil` · `:get()` · `:has(key)` · `:keys()` · `:reset()`.

```lua
roster.o.keys.terminal = { ["d d"] = "close", ["Ctrl+n"] = false }
```

### `keys.global`

`roster.o.keys.global` · `table<string, roster.config.KeyAction>` · default `{}`

Everywhere, with no Leader (keep it to keys a shell doesn't use): key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

Methods: `roster.o.keys.global.KEY = value` · `.KEY` · `.KEY = nil` · `:get()` · `:has(key)` · `:keys()` · `:reset()`.

```lua
roster.o.keys.global = { ["d d"] = "close", ["Ctrl+n"] = false }
```

## Layout

### `default_mode`

`roster.o.default_mode` · `"standard"|"focus"` · default `"standard"`

The view mode at start (read at start only).

Methods: `roster.o.default_mode = value` · `roster.o.default_mode` · `roster.o.reset("default_mode")`.

```lua
roster.o.default_mode = "focus"
```

### `sessions`

`roster.o.sessions` · `"sidebar"|"tabs"` · default `"sidebar"`

Open Sessions in the Sidebar, or in a tab strip.

Methods: `roster.o.sessions = value` · `roster.o.sessions` · `roster.o.reset("sessions")`.

```lua
roster.o.sessions = "tabs"
```

### `modes`

`roster.o.modes` · `roster.config.Modes` · default `{}`

Each view mode's layout.

Options in it: [`standard`](#modesstandard), [`focus`](#modesfocus).

Methods: `roster.o.modes = { … }` · `roster.o.modes.NAME` · `:get()` · `:reset()`.

```lua
roster.o.modes = { standard = { titlebar = false } }
```

### `modes.standard`

`roster.o.modes.standard` · `roster.config.Mode` · default `{}`

The Standard mode's pieces; a piece left out keeps this mode's default.

Options in it: [`titlebar`](#modesstandardtitlebar), [`sidebar`](#modesstandardsidebar), [`sessionbar`](#modesstandardsessionbar), [`statusbar`](#modesstandardstatusbar), [`fullscreen`](#modesstandardfullscreen), [`toolbar`](#modesstandardtoolbar).

Methods: `roster.o.modes.standard = { … }` · `roster.o.modes.standard.NAME` · `:get()` · `:reset()`.

```lua
roster.o.modes.standard = { titlebar = false }
```

### `modes.standard.titlebar`

`roster.o.modes.standard.titlebar` · `boolean` · default `true`

The title bar.

Methods: `roster.o.modes.standard.titlebar = value` · `roster.o.modes.standard.titlebar` · `roster.o.reset("modes.standard.titlebar")`.

```lua
roster.o.modes.standard.titlebar = false
```

### `modes.standard.sidebar`

`roster.o.modes.standard.sidebar` · `boolean|roster.config.Sidebar` · default `{ side = "left" }`

The Sidebar: shown or hidden, the side it's on, and its sections.

Takes true, false, or a table of the options below (which shows it).

Options in it: [`side`](#modesstandardsidebarside), [`sections`](#modesstandardsidebarsections).

Methods: `roster.o.modes.standard.sidebar = { … }` · `roster.o.modes.standard.sidebar.NAME` · `:get()` · `:reset()`.

```lua
roster.o.modes.standard.sidebar = { side = "right", sections = { "sessions", "inventory" } }
```

### `modes.standard.sidebar.side`

`roster.o.modes.standard.sidebar.side` · `"left"|"right"` · default `"left"`

The side of the window it's on.

Methods: `roster.o.modes.standard.sidebar.side = value` · `roster.o.modes.standard.sidebar.side` · `roster.o.reset("modes.standard.sidebar.side")`.

```lua
roster.o.modes.standard.sidebar.side = "right"
```

### `modes.standard.sidebar.sections`

`roster.o.modes.standard.sidebar.sections` · `string[]` · default unset

Its sections, in order; all of them when left out.

Takes section ids in order: `"sessions"`, `"folders"`, `"inventory"`, or a Plugin section's id; each item once.

Methods: `roster.o.modes.standard.sidebar.sections = { … }` · `:get()` · `:append(value, …)` · `:prepend(value, …)` · `:insert(i, value)` · `:remove(value)` · `:has(value)` · `:clear()` · `:reset()`.

```lua
roster.o.modes.standard.sidebar.sections = { "sessions", "inventory" }
```

### `modes.standard.sessionbar`

`roster.o.modes.standard.sessionbar` · `false|"bottom"|"top"` · default `false`

The thin tmux-style bar of open Sessions, and its edge.

Methods: `roster.o.modes.standard.sessionbar = value` · `roster.o.modes.standard.sessionbar` · `roster.o.reset("modes.standard.sessionbar")`.

```lua
roster.o.modes.standard.sessionbar = "top"
```

### `modes.standard.statusbar`

`roster.o.modes.standard.statusbar` · `boolean|string[]` · default `true`

The status bar, and its segments.

Takes true, false, or segments in order: `"backend"`, `"box"`, `"hosts"`, `"path"`, `"changes"`, `"hints"`, `"mode"`; each item once.

Methods: `roster.o.modes.standard.statusbar = { … }` · `:get()` · `:append(value, …)` · `:prepend(value, …)` · `:insert(i, value)` · `:remove(value)` · `:has(value)` · `:clear()` · `:reset()`.

```lua
roster.o.modes.standard.statusbar = { "backend", "hosts" }
```

### `modes.standard.fullscreen`

`roster.o.modes.standard.fullscreen` · `boolean` · default `false`

OS fullscreen.

Methods: `roster.o.modes.standard.fullscreen = value` · `roster.o.modes.standard.fullscreen` · `roster.o.reset("modes.standard.fullscreen")`.

```lua
roster.o.modes.standard.fullscreen = true
```

### `modes.standard.toolbar`

`roster.o.modes.standard.toolbar` · `boolean|string[]` · default `true`

The controls for common commands, in the title bar (or a bar of their own without one).

Takes true, false, or controls in order: `"sidebar"`, `"find"`, `"quick"`, `"add"`, `"changes"`, `"publish"`, `"details"`, `"cmdline"`, `"keys"`, `"help"`, `"lock"`, `"mode"`, or a Plugin control's id; each item once.

Methods: `roster.o.modes.standard.toolbar = { … }` · `:get()` · `:append(value, …)` · `:prepend(value, …)` · `:insert(i, value)` · `:remove(value)` · `:has(value)` · `:clear()` · `:reset()`.

```lua
roster.o.modes.standard.toolbar = { "add", "find" }
```

### `modes.focus`

`roster.o.modes.focus` · `roster.config.Mode` · default `{}`

The Focus mode's pieces; a piece left out keeps this mode's default.

Options in it: [`titlebar`](#modesfocustitlebar), [`sidebar`](#modesfocussidebar), [`sessionbar`](#modesfocussessionbar), [`statusbar`](#modesfocusstatusbar), [`fullscreen`](#modesfocusfullscreen), [`toolbar`](#modesfocustoolbar).

Methods: `roster.o.modes.focus = { … }` · `roster.o.modes.focus.NAME` · `:get()` · `:reset()`.

```lua
roster.o.modes.focus = { titlebar = true }
```

### `modes.focus.titlebar`

`roster.o.modes.focus.titlebar` · `boolean` · default `false`

The title bar.

Methods: `roster.o.modes.focus.titlebar = value` · `roster.o.modes.focus.titlebar` · `roster.o.reset("modes.focus.titlebar")`.

```lua
roster.o.modes.focus.titlebar = true
```

### `modes.focus.sidebar`

`roster.o.modes.focus.sidebar` · `boolean|roster.config.Sidebar` · default `false`

The Sidebar: shown or hidden, the side it's on, and its sections.

Takes true, false, or a table of the options below (which shows it).

Options in it: [`side`](#modesfocussidebarside), [`sections`](#modesfocussidebarsections).

Methods: `roster.o.modes.focus.sidebar = { … }` · `roster.o.modes.focus.sidebar.NAME` · `:get()` · `:reset()`.

```lua
roster.o.modes.focus.sidebar = { side = "right", sections = { "sessions", "inventory" } }
```

### `modes.focus.sidebar.side`

`roster.o.modes.focus.sidebar.side` · `"left"|"right"` · default `"left"`

The side of the window it's on.

Methods: `roster.o.modes.focus.sidebar.side = value` · `roster.o.modes.focus.sidebar.side` · `roster.o.reset("modes.focus.sidebar.side")`.

```lua
roster.o.modes.focus.sidebar.side = "right"
```

### `modes.focus.sidebar.sections`

`roster.o.modes.focus.sidebar.sections` · `string[]` · default unset

Its sections, in order; all of them when left out.

Takes section ids in order: `"sessions"`, `"folders"`, `"inventory"`, or a Plugin section's id; each item once.

Methods: `roster.o.modes.focus.sidebar.sections = { … }` · `:get()` · `:append(value, …)` · `:prepend(value, …)` · `:insert(i, value)` · `:remove(value)` · `:has(value)` · `:clear()` · `:reset()`.

```lua
roster.o.modes.focus.sidebar.sections = { "sessions", "inventory" }
```

### `modes.focus.sessionbar`

`roster.o.modes.focus.sessionbar` · `false|"bottom"|"top"` · default `false`

The thin tmux-style bar of open Sessions, and its edge.

Methods: `roster.o.modes.focus.sessionbar = value` · `roster.o.modes.focus.sessionbar` · `roster.o.reset("modes.focus.sessionbar")`.

```lua
roster.o.modes.focus.sessionbar = "top"
```

### `modes.focus.statusbar`

`roster.o.modes.focus.statusbar` · `boolean|string[]` · default `false`

The status bar, and its segments.

Takes true, false, or segments in order: `"backend"`, `"box"`, `"hosts"`, `"path"`, `"changes"`, `"hints"`, `"mode"`; each item once.

Methods: `roster.o.modes.focus.statusbar = { … }` · `:get()` · `:append(value, …)` · `:prepend(value, …)` · `:insert(i, value)` · `:remove(value)` · `:has(value)` · `:clear()` · `:reset()`.

```lua
roster.o.modes.focus.statusbar = { "backend", "hosts" }
```

### `modes.focus.fullscreen`

`roster.o.modes.focus.fullscreen` · `boolean` · default `true`

OS fullscreen.

Methods: `roster.o.modes.focus.fullscreen = value` · `roster.o.modes.focus.fullscreen` · `roster.o.reset("modes.focus.fullscreen")`.

```lua
roster.o.modes.focus.fullscreen = false
```

### `modes.focus.toolbar`

`roster.o.modes.focus.toolbar` · `boolean|string[]` · default `false`

The controls for common commands, in the title bar (or a bar of their own without one).

Takes true, false, or controls in order: `"sidebar"`, `"find"`, `"quick"`, `"add"`, `"changes"`, `"publish"`, `"details"`, `"cmdline"`, `"keys"`, `"help"`, `"lock"`, `"mode"`, or a Plugin control's id; each item once.

Methods: `roster.o.modes.focus.toolbar = { … }` · `:get()` · `:append(value, …)` · `:prepend(value, …)` · `:insert(i, value)` · `:remove(value)` · `:has(value)` · `:clear()` · `:reset()`.

```lua
roster.o.modes.focus.toolbar = { "add", "find" }
```

### `panel`

`roster.o.panel` · `roster.config.Panel` · default `{}`

What every panel and view starts with.

Options in it: [`width`](#panelwidth).

Methods: `roster.o.panel = { … }` · `roster.o.panel.NAME` · `:get()` · `:reset()`.

```lua
roster.o.panel = { width = 40 }
```

### `panel.width`

`roster.o.panel.width` · `integer` · default unset

A docked panel's width, for every panel and view views doesn't give one. Unset, each keeps its own.

Takes 10 to 95 percent of the window.

Methods: `roster.o.panel.width = value` · `roster.o.panel.width` · `roster.o.reset("panel.width")`.

```lua
roster.o.panel.width = 40
```

### `views`

`roster.o.views` · `table<string, roster.config.View>` · default `{}`

Per panel or view id (help, details, a Plugin view's id): where it opens first, and its width.

Each value is a [`roster.config.View`](#rosterconfigview).

Methods: `roster.o.views.KEY = value` · `.KEY` · `.KEY = nil` · `:get()` · `:has(key)` · `:keys()` · `:reset()`.

```lua
roster.o.views = { topology = { place = "panel", width = 60 } }
```

## Folders

### `folders`

`roster.o.folders` · `roster.config.Folder[]` · default `{}`

Folders kept in the Config, read-only in the app: each a Folder spec.

Each item is a [`roster.config.Folder`](#rosterconfigfolder).

Methods: `roster.o.folders = { … }` · `:get()` · `:append(value, …)` · `:prepend(value, …)` · `:insert(i, value)` · `:remove(value)` · `:has(value)` · `:clear()` · `:reset()`.

```lua
roster.o.folders = { { name = "Lab", hosts = { "esx-02", "esx-03" } } }
```

## The vault

### `vault`

`roster.o.vault` · `roster.config.Vault` · default `{}`

This Box's own vault settings, over roster.yml's providers. Paths and choices, never a secret.

Options in it: [`save_to`](#vaultsave_to), [`kp`](#vaultkp).

Methods: `roster.o.vault = { … }` · `roster.o.vault.NAME` · `:get()` · `:reset()`.

```lua
roster.o.vault = { save_to = { organization = "My Team", collection = "Infra logins" } }
```

### `vault.save_to`

`roster.o.vault.save_to` · `"personal"|{ organization: string, collection: string }|{ group: string }` · default unset

Where Save to vault puts a new password by default.

Takes `"personal"`, { organization = …, collection = … } (Bitwarden) or { group = … } (KeePassXC).

Methods: `roster.o.vault.save_to = value` · `roster.o.vault.save_to` · `roster.o.reset("vault.save_to")`.

```lua
roster.o.vault.save_to = { organization = "My Team", collection = "Infra logins" }
```

### `vault.kp`

`roster.o.vault.kp` · `roster.config.KeePassXC` · default `{}`

KeePassXC's files, on the Box roster runs on.

Options in it: [`database`](#vaultkpdatabase), [`key_file`](#vaultkpkey_file).

Methods: `roster.o.vault.kp = { … }` · `roster.o.vault.kp.NAME` · `:get()` · `:reset()`.

```lua
roster.o.vault.kp = { database = "~/roster.kdbx" }
```

### `vault.kp.database`

`roster.o.vault.kp.database` · `string` · default unset

KeePassXC's .kdbx.

Takes an absolute path, or one starting with ~.

Methods: `roster.o.vault.kp.database = value` · `roster.o.vault.kp.database` · `roster.o.reset("vault.kp.database")`.

```lua
roster.o.vault.kp.database = "~/roster.kdbx"
```

### `vault.kp.key_file`

`roster.o.vault.kp.key_file` · `string` · default unset

A key file used with the database's master password.

Takes an absolute path, or one starting with ~.

Methods: `roster.o.vault.kp.key_file = value` · `roster.o.vault.kp.key_file` · `roster.o.reset("vault.kp.key_file")`.

```lua
roster.o.vault.kp.key_file = "~/roster.keyx"
```

## Packages

### `packages`

`roster.o.packages` · `(string|roster.config.Package)[]` · default `{}`

Plugins fetched from git repos and pinned in roster.lock: each a Package spec, or just its source.

Each item is a [`roster.config.Package`](#rosterconfigpackage).

Methods: `roster.o.packages = { … }` · `:get()` · `:append(value, …)` · `:prepend(value, …)` · `:insert(i, value)` · `:remove(value)` · `:has(value)` · `:clear()` · `:reset()`.

```lua
roster.o.packages = { { "someone/recent-alerts", tag = "v1.2.0" }, "someone/pinned" }
```

### `plugin_proxy`

`roster.o.plugin_proxy` · `string` · default unset

The proxy Plugins' requests to public names go through. Unset, they go direct.

Takes http://HOST:PORT, the port written out, with no user or password.

Methods: `roster.o.plugin_proxy = value` · `roster.o.plugin_proxy` · `roster.o.reset("plugin_proxy")`.

```lua
roster.o.plugin_proxy = "http://10.0.0.5:3128"
```

## Other

### `idle_lock_minutes`

`roster.o.idle_lock_minutes` · `integer` · default `15`

Lock after this many minutes without input.

Takes 1 to 1440 minutes.

Methods: `roster.o.idle_lock_minutes = value` · `roster.o.idle_lock_minutes` · `roster.o.reset("idle_lock_minutes")`.

```lua
roster.o.idle_lock_minutes = 30
```

### `pull_fresh_minutes`

`roster.o.pull_fresh_minutes` · `integer` · default `5`

How old the last pull of the infra repo may be before a form pulls again; 0 pulls every time.

Takes 0 to 1440 minutes.

Methods: `roster.o.pull_fresh_minutes = value` · `roster.o.pull_fresh_minutes` · `roster.o.reset("pull_fresh_minutes")`.

```lua
roster.o.pull_fresh_minutes = 0
```

### `auto_reload`

`roster.o.auto_reload` · `boolean` · default `false`

Reload on every save of a .lua file of the Config, and of roster.yml. Off, :source reloads.

Methods: `roster.o.auto_reload = value` · `roster.o.auto_reload` · `roster.o.reset("auto_reload")`.

```lua
roster.o.auto_reload = true
```

### `editor`

`roster.o.editor` · `"os"|"wsl"` · default `"os"`

What :config opens init.lua with: the desktop's app for .lua files, or $EDITOR inside WSL.

Methods: `roster.o.editor = value` · `roster.o.editor` · `roster.o.reset("editor")`.

```lua
roster.o.editor = "wsl"
```

### `backend`

`roster.o.backend` · `string` · default `"auto"`

Which roster the app runs: detected, this machine's, or WSL's.

Takes `"auto"`, `"local"`, `"wsl"` or `"wsl:<distro>"`.

Methods: `roster.o.backend = value` · `roster.o.backend` · `roster.o.reset("backend")`.

```lua
roster.o.backend = "wsl:dev"
```

### `roster_command`

`roster.o.roster_command` · `string|string[]` · default unset

The command that runs roster, for development: a command line (split on spaces) or a list of words. Unset, roster.

Takes roster itself: `"roster"`, a path ending in /roster, or `"uv run --project <dir> roster"`.

Methods: `roster.o.roster_command = { … }` · `:get()` · `:append(value, …)` · `:prepend(value, …)` · `:insert(i, value)` · `:remove(value)` · `:has(value)` · `:clear()` · `:reset()`.

```lua
roster.o.roster_command = "uv run --project ~/work/roster roster"
```

## Types

The tables some options hold, by the names `:config types` gives them.

### `roster.config.Theme`

`themes.<id>` · `roster.config.Theme`

A Theme spec: a bundled Theme (base) with tokens changed, or a new one.

Methods: `roster.o.themes.<id> = { … }` · `roster.o.themes.<id>.NAME` · `:get()` · `:reset()`.

| Field | Type | Default | |
|---|---|---|---|
| `label` | `string` | unset | Its name in the app; the id when left out. |
| `appearance` | `"dark"\|"light"` | unset | Which OS appearance it suits; the base's when left out. |
| `base` | `string` | unset | The Theme it starts from: every token it doesn't set comes from there (Roster dark, or Roster light for appearance = `"light"`, when left out). Takes a Theme's id. |
| `colors` | `roster.config.UiColors` | `{}` | UI colour tokens over the base's. Names: `accent`, `accent_text`, `accent_ink`, `tone`, `bg`, `chrome`, `sidebar`, `panel`, `raised`, `raised_line`, `hover`, `line`, `line_strong`, `text`, `muted`, `faint`, `warn`, `error`, `danger`, `danger_text`, `backdrop`, `shadow`, `syntax_keyword`, `syntax_string`, `syntax_number`, `syntax_comment`, `syntax_function`, `syntax_punctuation`, `syntax_key`, `syntax_command`. |
| `terminal` | `roster.config.ThemeTerminalColors` | `{}` | The terminal's colours, apart from the 16 ANSI ones, over the base's. Names: `background`, `foreground`, `cursor`, `cursor_accent`, `selection_background`, `search_match`, `search_active_match`. |
| `ansi` | `false\|roster.config.Ansi` | unset | The 16 ANSI colours; false keeps the standard palette even when the base has its own; the base's when left out. Names: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `bright_black`, `bright_red`, `bright_green`, `bright_yellow`, `bright_blue`, `bright_magenta`, `bright_cyan`, `bright_white`. |

```lua
roster.o.themes = { paper = { appearance = "light", colors = { accent = "#b85c00" } } }
```

### `roster.config.KeyAction`

`keys.leader.<keys>` · `string|false`

A key action: the command line a key runs, or false to unbind a default.

Takes a command line, exactly what you'd type after : (`"close"`, `"session 1"`), or false.

Methods: `roster.o.keys.leader.<keys> = value` · `roster.o.keys.leader.<keys>` · `roster.o.keys.leader.<keys> = nil`.

```lua
roster.o.keys.leader = { ["d d"] = "close", ["Ctrl+n"] = false }
```

### `roster.config.View`

`views.<id>` · `roster.config.View`

A view spec: one panel's or view's default place and width.

Methods: `roster.o.views.<id> = { … }` · `roster.o.views.<id>.NAME` · `:get()` · `:reset()`.

| Field | Type | Default | |
|---|---|---|---|
| `place` | `"panel"\|"full"` | unset | Docked beside the terminal, or over the whole window. |
| `width` | `integer` | unset | Its docked width. Takes 10 to 95 percent of the window. |

```lua
roster.o.views = { topology = { place = "panel", width = 60 } }
```

### `roster.config.Folder`

`folders[n]` · `roster.config.Folder`

A Folder spec: a name and the Hosts in it.

| Field | Type | Default | |
|---|---|---|---|
| `name` | `string` | required | The Folder's name. Takes unique, ignoring case, with no double quote. |
| `hosts` | `string[]` | `{}` | The Hosts in it, in order. Takes Host names; each item once. |

```lua
roster.o.folders = { { name = "Lab", hosts = { "esx-02", "esx-03" } } }
```

### `roster.config.Package`

`packages[n]` · `string|roster.config.Package`

A Package spec: { SOURCE, tag = …, config = { … } }, or just SOURCE.

| Field | Type | Default | |
|---|---|---|---|
| `source` | `string` | required | Where the repo is: the spec's first item, or source = …. Takes `"owner/repo"` (GitHub), or a git URL: https://…, ssh://…, git@host:path, file://… or a full path. |
| `name` | `string` | unset | Its name (its folder and its line in roster.lock); the repo's (or dir's) name when left out. |
| `tag` | `string` | unset | The tag to pin. At most one of tag, branch and commit; none means the default branch. |
| `branch` | `string` | unset | The branch to follow. |
| `commit` | `string` | unset | The commit to pin. Takes 4 to 40 hex digits. |
| `dir` | `string` | unset | The repo's folder that holds the Plugin, when it isn't the top. Takes a folder inside the repo, relative, / between folders, no ... |
| `config` | `table` | `{}` | Settings the Package reads as roster.plugin.config. Takes a table (never a function). |

```lua
roster.o.packages = { { "someone/recent-alerts", tag = "v1.2.0" }, "someone/pinned" }
```

## Editor support

`:config types` writes all of the above as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations into `types/roster-config.lua` in the config folder ([`examples/types/roster-config.lua`](../../examples/types/roster-config.lua) is the same file), so [lua-language-server](https://luals.github.io/) completes option names and shows these descriptions as you type. Point it at the folder with a `.luarc.json` next to `init.lua`:

```json
{
  "runtime.version": "Lua 5.4",
  "workspace.library": ["types"],
  "diagnostics.globals": ["roster"]
}
```

Then `---@type roster.config.Options` on the table `init.lua` returns checks every name and value in it, with one limit: lua-language-server doesn't flag a string outside an option's set (`terminal.cursor_style = "triangle"` passes its check), so the app's own check when it loads the file, at that line, is the one that catches it. The file is the copy this app was built with; run `:config types` again after an update.

