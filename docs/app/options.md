# Option reference

<!-- Generated from crates/roster-core/src/config/shape by `cargo run -p roster-core --example gen_config_options`: edit that, then run it. -->

Every option `init.lua` takes, and every name of its `roster` table, one entry each, the way Neovim's `:help 'option'` lists its options: how it's written, its type, its default, the values it can have, what it does and an example. Each entry is a help topic: `:help terminal.size`, `:help roster.keymap.set`, `:help roster.config.Theme`. In the app, `:help options` shows them with the value each option has now and where it was set, and `:options` finds one. [The Config guide](config.md) says how `init.lua` works, and more about each option. `:config types` writes all of this as types for your editor ([Editor support](#editor-support)).

Types are written as [LuaCATS](https://luals.github.io/wiki/annotations/) writes them: `string[]` is a list of strings, `table<string, X>` a table of X by name, `"webgl"|"dom"` one of those strings, `roster.config.Theme` a table described under [Types](#types). An object (a table of named options, such as `terminal`) needs no setup: give only the options you change. A default of unset means nothing is set and the app, or a choice it keeps, decides; required is a field a spec can't leave out.

## The `roster` table

A global in `init.lua` and its modules, and also require(`"roster"`). A Plugin gets a bigger one: [the Plugin API](../plugin-api.md).

### `roster.os`

`"windows"|"linux"|"macos"`

The OS the app runs on.

```lua
if roster.os == "windows" then
  roster.set("backend", "wsl")
end
```

### `roster.api_version`

`integer`

The version of this table, raised when it changes.

```lua
if roster.api_version >= 4 then … end
```

### `roster.set(name, value)`

Sets any option by its dotted name. The name and the value are checked like the returned table's; an error points at the call's line. The returned table wins over a call that sets the same option.

| Parameter | Type | |
|---|---|---|
| `name` | `roster.config.OptionName` | An option's dotted name: `"terminal.size"`. |
| `value` | `any` | Its value, as the option takes it. |

```lua
roster.set("terminal.size", "16pt")
```

### `roster.keymap.set(context, keys, action)`

Binds a key, as `keys.<context>` does.

| Parameter | Type | |
|---|---|---|
| `context` | `"leader"\|"list"\|"list_vim"\|"picker"\|"picker_vim"\|"cmdline"\|"terminal"\|"global"` | The keymap's context. |
| `keys` | `string` | A chord or a sequence of chords separated by spaces: `"Ctrl+n"`, `"d d"`. |
| `action` | `roster.config.KeyAction` | A command line, or false to unbind a default. |

```lua
roster.keymap.set("leader", "p", "connect esx-02")
```

### `roster.themes.define(id, theme)`

Defines a Theme, as `themes.<id>` does.

| Parameter | Type | |
|---|---|---|
| `id` | `string` | The Theme's id (not `"auto"`). |
| `theme` | `roster.config.Theme` | A Theme spec. |

```lua
roster.themes.define("paper", { appearance = "light", colors = { accent = "#b85c00" } })
```

## Themes and colours

### `theme`

`string` · default `"auto"`

The Theme to use, or `"auto"` to follow the OS's light or dark setting with dark_theme and light_theme.

Takes a Theme's id, or `"auto"`.

```lua
roster.set("theme", "nord")
```

### `dark_theme`

`string` · default `"roster-dark"`

The Theme `"auto"` picks while the OS is dark.

Takes a Theme's id.

```lua
roster.set("dark_theme", "tokyo-night")
```

### `light_theme`

`string` · default `"roster-light"`

The Theme `"auto"` picks while the OS is light.

Takes a Theme's id.

```lua
roster.set("light_theme", "paper")
```

### `themes`

`table<string, roster.config.Theme>` · default `{}`

New Themes, or changed copies of bundled ones, by id: each a Theme spec.

Each value is a [`roster.config.Theme`](#rosterconfigtheme).

```lua
roster.set("themes", { paper = { appearance = "light", colors = { accent = "#b85c00" } } })
```

### `colors`

`roster.config.UiColors` · default `{}`

UI colour tokens set over whichever Theme is in use.

Names: `accent`, `accent_text`, `accent_ink`, `tone`, `bg`, `chrome`, `sidebar`, `panel`, `raised`, `raised_line`, `hover`, `line`, `line_strong`, `text`, `muted`, `faint`, `warn`, `error`, `danger`, `danger_text`, `backdrop`, `shadow`, `syntax_keyword`, `syntax_string`, `syntax_number`, `syntax_comment`, `syntax_function`, `syntax_punctuation`, `syntax_key`, `syntax_command`.

```lua
roster.set("colors", { accent = "#e8a33d" })
```

## Fonts and the terminal

### `fonts`

`roster.config.Fonts` · default `{}`

The UI's fonts.

Options in it: [`ui`](#fontsui), [`mono`](#fontsmono), [`ui_size`](#fontsui_size).

```lua
roster.set("fonts", { ui = "IBM Plex Sans" })
```

### `fonts.ui`

`string` · default `"Inter"`

The UI's font.

Takes a family name, or a CSS font stack (anything with a comma).

```lua
roster.set("fonts.ui", "IBM Plex Sans")
```

### `fonts.mono`

`string` · default `"Iosevka"`

The wordmark's and code-like UI text's font.

Takes a family name, or a CSS font stack.

```lua
roster.set("fonts.mono", "JetBrains Mono")
```

### `fonts.ui_size`

`integer` · default `15`

The UI's text size; the smaller steps, the row height and the Sidebar's width follow it.

Takes 11 to 20 px.

```lua
roster.set("fonts.ui_size", 16)
```

### `ui`

`roster.config.Ui` · default `{}`

The rest of the UI's look.

Options in it: [`hints`](#uihints), [`messages`](#uimessages).

```lua
roster.set("ui", { hints = false })
```

### `ui.hints`

`boolean` · default unset

false hides every keycap hint. Unset, :hints decides and the State keeps its choice; set, it wins.

```lua
roster.set("ui.hints", false)
```

### `ui.messages`

`"quiet"|"all"` · default unset

What the message line shows: errors, warnings and answers only (`"quiet"`), or routine confirmations too (`"all"`). Unset, :messages decides.

```lua
roster.set("ui.messages", "all")
```

### `terminal`

`roster.config.Terminal` · default `{}`

The terminal's font, look and behaviour.

Options in it: [`font`](#terminalfont), [`size`](#terminalsize), [`weight`](#terminalweight), [`bold_weight`](#terminalbold_weight), [`bold_is_bright`](#terminalbold_is_bright), [`line_height`](#terminalline_height), [`cell_height`](#terminalcell_height), [`renderer`](#terminalrenderer), [`cursor_style`](#terminalcursor_style), [`scrollback`](#terminalscrollback), [`copy_on_select`](#terminalcopy_on_select), [`right_click_paste`](#terminalright_click_paste), [`colors`](#terminalcolors), [`shell_hooks`](#terminalshell_hooks).

```lua
roster.set("terminal", { font = { "Fira Code", "Iosevka" } })
```

### `terminal.font`

`string|string[]` · default `{ "Iosevka Nerd Font", "Iosevka Term", "Iosevka" }`

Font families, most wanted first: the first one installed is used.

Takes a font name, a CSS font stack, or a list of names.

```lua
roster.set("terminal.font", { "Fira Code", "Iosevka" })
```

### `terminal.size`

`number|string` · default `"13pt"`

The font size: a number is px, `"16pt"` is points (as Windows Terminal converts them), `"21px"` works too.

Takes 6 to 72 px (4.5 to 54 pt).

```lua
roster.set("terminal.size", "16pt")
```

### `terminal.weight`

`integer` · default `500`

The font weight; the bundled Iosevka has 400, 500 and 700.

Takes 100 to 900.

```lua
roster.set("terminal.weight", 400)
```

### `terminal.bold_weight`

`integer` · default `700`

The weight of bold (SGR 1) text.

Takes 100 to 900.

```lua
roster.set("terminal.bold_weight", 800)
```

### `terminal.bold_is_bright`

`boolean` · default `true`

Bold text in the bright ANSI colours too.

```lua
roster.set("terminal.bold_is_bright", false)
```

### `terminal.line_height`

`number` · default `1.0`

A multiple of the font's own line height.

Takes 0.5 to 3.

```lua
roster.set("terminal.line_height", 1.2)
```

### `terminal.cell_height`

`number` · default unset

A multiple of the font size, as Windows Terminal's cellHeight; wins over line_height.

Takes 0.5 to 3.

```lua
roster.set("terminal.cell_height", 1.1)
```

### `terminal.renderer`

`"webgl"|"dom"` · default `"webgl"`

WebGL (fast) or the DOM (the browser's own text rendering).

```lua
roster.set("terminal.renderer", "dom")
```

### `terminal.cursor_style`

`"block"|"bar"|"underline"` · default `"block"`

The cursor's shape.

```lua
roster.set("terminal.cursor_style", "bar")
```

### `terminal.scrollback`

`integer` · default `10000`

How many lines the terminal keeps above the screen.

Takes 0 to 1000000 lines.

```lua
roster.set("terminal.scrollback", 50000)
```

### `terminal.copy_on_select`

`boolean` · default `true`

Selecting text copies it.

```lua
roster.set("terminal.copy_on_select", false)
```

### `terminal.right_click_paste`

`boolean` · default `true`

Right-click copies the selection, or pastes when there's none.

```lua
roster.set("terminal.right_click_paste", false)
```

### `terminal.colors`

`roster.config.TerminalColors` · default `{}`

Any terminal or ANSI colour, set over the Theme's.

Names: `background`, `foreground`, `cursor`, `cursor_accent`, `selection_background`, `search_match`, `search_active_match`, `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `bright_black`, `bright_red`, `bright_green`, `bright_yellow`, `bright_blue`, `bright_magenta`, `bright_cyan`, `bright_white`.

```lua
roster.set("terminal.colors", { background = "#101418", red = "#e06c75" })
```

### `terminal.shell_hooks`

`boolean` · default unset

Send each Session's shell the line that turns on prompt marks (OSC 133) and its folder (OSC 7). Unset, a Host's shell_hooks in roster.yml decides.

```lua
roster.set("terminal.shell_hooks", true)
```

## Keys

### `leader`

`string` · default `"Ctrl+Space"`

The chord that takes the keyboard back from a terminal.

Takes a chord: `"Ctrl+Space"`, `"ctrl+b"`, `"C-b"` or `"<C-b>"`, with Ctrl, Alt or Meta.

```lua
roster.set("leader", "Ctrl+b")
```

### `vim`

`boolean` · default `true`

j/k/h/l/gg/G in lists and the Picker.

```lua
roster.set("vim", false)
```

### `keys`

`roster.config.Keys` · default `{}`

Key bindings, per context: key or sequence → action.

Options in it: [`leader`](#keysleader), [`list`](#keyslist), [`list_vim`](#keyslist_vim), [`picker`](#keyspicker), [`picker_vim`](#keyspicker_vim), [`cmdline`](#keyscmdline), [`terminal`](#keysterminal), [`global`](#keysglobal).

```lua
roster.set("keys", { leader = { ["d d"] = "close", ["Ctrl+n"] = false } })
```

### `keys.leader`

`table<string, roster.config.KeyAction>` · default `{}`

After the Leader: key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

```lua
roster.set("keys.leader", { ["d d"] = "close", ["Ctrl+n"] = false })
```

### `keys.list`

`table<string, roster.config.KeyAction>` · default `{}`

In a list (the Sidebar): key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

```lua
roster.set("keys.list", { ["d d"] = "close", ["Ctrl+n"] = false })
```

### `keys.list_vim`

`table<string, roster.config.KeyAction>` · default `{}`

In a list while vim keys are on: key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

```lua
roster.set("keys.list_vim", { ["d d"] = "close", ["Ctrl+n"] = false })
```

### `keys.picker`

`table<string, roster.config.KeyAction>` · default `{}`

In the Picker and every finder: key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

```lua
roster.set("keys.picker", { ["d d"] = "close", ["Ctrl+n"] = false })
```

### `keys.picker_vim`

`table<string, roster.config.KeyAction>` · default `{}`

In the Picker's list while vim keys are on: key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

```lua
roster.set("keys.picker_vim", { ["d d"] = "close", ["Ctrl+n"] = false })
```

### `keys.cmdline`

`table<string, roster.config.KeyAction>` · default `{}`

In the : command line: key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

```lua
roster.set("keys.cmdline", { ["d d"] = "close", ["Ctrl+n"] = false })
```

### `keys.terminal`

`table<string, roster.config.KeyAction>` · default `{}`

In a terminal, before the shell sees the key: key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

```lua
roster.set("keys.terminal", { ["d d"] = "close", ["Ctrl+n"] = false })
```

### `keys.global`

`table<string, roster.config.KeyAction>` · default `{}`

Everywhere, with no Leader (keep it to keys a shell doesn't use): key or sequence (chords separated by spaces: `"d d"`) → key action.

Each value is a [`roster.config.KeyAction`](#rosterconfigkeyaction).

```lua
roster.set("keys.global", { ["d d"] = "close", ["Ctrl+n"] = false })
```

## Layout

### `default_mode`

`"standard"|"focus"` · default `"standard"`

The view mode at start (read at start only).

```lua
roster.set("default_mode", "focus")
```

### `sessions`

`"sidebar"|"tabs"` · default `"sidebar"`

Open Sessions in the Sidebar, or in a tab strip.

```lua
roster.set("sessions", "tabs")
```

### `modes`

`roster.config.Modes` · default `{}`

Each view mode's layout.

Options in it: [`standard`](#modesstandard), [`focus`](#modesfocus).

```lua
roster.set("modes", { standard = { titlebar = false } })
```

### `modes.standard`

`roster.config.Mode` · default `{}`

The Standard mode's pieces; a piece left out keeps this mode's default.

Options in it: [`titlebar`](#modesstandardtitlebar), [`sidebar`](#modesstandardsidebar), [`sessionbar`](#modesstandardsessionbar), [`statusbar`](#modesstandardstatusbar), [`fullscreen`](#modesstandardfullscreen), [`toolbar`](#modesstandardtoolbar).

```lua
roster.set("modes.standard", { titlebar = false })
```

### `modes.standard.titlebar`

`boolean` · default `true`

The title bar.

```lua
roster.set("modes.standard.titlebar", false)
```

### `modes.standard.sidebar`

`boolean|roster.config.Sidebar` · default `{ side = "left" }`

The Sidebar: shown or hidden, the side it's on, and its sections.

Takes true, false, or a table of the options below (which shows it).

Options in it: [`side`](#modesstandardsidebarside), [`sections`](#modesstandardsidebarsections).

```lua
roster.set("modes.standard.sidebar", { side = "right", sections = { "sessions", "inventory" } })
```

### `modes.standard.sidebar.side`

`"left"|"right"` · default `"left"`

The side of the window it's on.

```lua
roster.set("modes.standard.sidebar.side", "right")
```

### `modes.standard.sidebar.sections`

`string[]` · default unset

Its sections, in order; all of them when left out.

Takes section ids in order: `"sessions"`, `"folders"`, `"inventory"`, or a Plugin section's id.

```lua
roster.set("modes.standard.sidebar.sections", { "sessions", "inventory" })
```

### `modes.standard.sessionbar`

`false|"bottom"|"top"` · default `false`

The thin tmux-style bar of open Sessions, and its edge.

```lua
roster.set("modes.standard.sessionbar", "top")
```

### `modes.standard.statusbar`

`boolean|string[]` · default `true`

The status bar, and its segments.

Takes true, false, or segments in order: `"backend"`, `"box"`, `"hosts"`, `"path"`, `"changes"`, `"hints"`, `"mode"`.

```lua
roster.set("modes.standard.statusbar", { "backend", "hosts" })
```

### `modes.standard.fullscreen`

`boolean` · default `false`

OS fullscreen.

```lua
roster.set("modes.standard.fullscreen", true)
```

### `modes.standard.toolbar`

`boolean|string[]` · default `true`

The controls for common commands, in the title bar (or a bar of their own without one).

Takes true, false, or controls in order: `"sidebar"`, `"find"`, `"quick"`, `"add"`, `"changes"`, `"publish"`, `"details"`, `"cmdline"`, `"keys"`, `"help"`, `"lock"`, `"mode"`, or a Plugin control's id.

```lua
roster.set("modes.standard.toolbar", { "add", "find" })
```

### `modes.focus`

`roster.config.Mode` · default `{}`

The Focus mode's pieces; a piece left out keeps this mode's default.

Options in it: [`titlebar`](#modesfocustitlebar), [`sidebar`](#modesfocussidebar), [`sessionbar`](#modesfocussessionbar), [`statusbar`](#modesfocusstatusbar), [`fullscreen`](#modesfocusfullscreen), [`toolbar`](#modesfocustoolbar).

```lua
roster.set("modes.focus", { titlebar = true })
```

### `modes.focus.titlebar`

`boolean` · default `false`

The title bar.

```lua
roster.set("modes.focus.titlebar", true)
```

### `modes.focus.sidebar`

`boolean|roster.config.Sidebar` · default `false`

The Sidebar: shown or hidden, the side it's on, and its sections.

Takes true, false, or a table of the options below (which shows it).

Options in it: [`side`](#modesfocussidebarside), [`sections`](#modesfocussidebarsections).

```lua
roster.set("modes.focus.sidebar", { side = "right", sections = { "sessions", "inventory" } })
```

### `modes.focus.sidebar.side`

`"left"|"right"` · default `"left"`

The side of the window it's on.

```lua
roster.set("modes.focus.sidebar.side", "right")
```

### `modes.focus.sidebar.sections`

`string[]` · default unset

Its sections, in order; all of them when left out.

Takes section ids in order: `"sessions"`, `"folders"`, `"inventory"`, or a Plugin section's id.

```lua
roster.set("modes.focus.sidebar.sections", { "sessions", "inventory" })
```

### `modes.focus.sessionbar`

`false|"bottom"|"top"` · default `false`

The thin tmux-style bar of open Sessions, and its edge.

```lua
roster.set("modes.focus.sessionbar", "top")
```

### `modes.focus.statusbar`

`boolean|string[]` · default `false`

The status bar, and its segments.

Takes true, false, or segments in order: `"backend"`, `"box"`, `"hosts"`, `"path"`, `"changes"`, `"hints"`, `"mode"`.

```lua
roster.set("modes.focus.statusbar", { "backend", "hosts" })
```

### `modes.focus.fullscreen`

`boolean` · default `true`

OS fullscreen.

```lua
roster.set("modes.focus.fullscreen", false)
```

### `modes.focus.toolbar`

`boolean|string[]` · default `false`

The controls for common commands, in the title bar (or a bar of their own without one).

Takes true, false, or controls in order: `"sidebar"`, `"find"`, `"quick"`, `"add"`, `"changes"`, `"publish"`, `"details"`, `"cmdline"`, `"keys"`, `"help"`, `"lock"`, `"mode"`, or a Plugin control's id.

```lua
roster.set("modes.focus.toolbar", { "add", "find" })
```

### `panel`

`roster.config.Panel` · default `{}`

What every panel and view starts with.

Options in it: [`width`](#panelwidth).

```lua
roster.set("panel", { width = 40 })
```

### `panel.width`

`integer` · default unset

A docked panel's width, for every panel and view views doesn't give one. Unset, each keeps its own.

Takes 10 to 95 percent of the window.

```lua
roster.set("panel.width", 40)
```

### `views`

`table<string, roster.config.View>` · default `{}`

Per panel or view id (help, details, a Plugin view's id): where it opens first, and its width.

Each value is a [`roster.config.View`](#rosterconfigview).

```lua
roster.set("views", { topology = { place = "panel", width = 60 } })
```

## Folders

### `folders`

`roster.config.Folder[]` · default `{}`

Folders kept in the Config, read-only in the app: each a Folder spec.

Each item is a [`roster.config.Folder`](#rosterconfigfolder).

```lua
roster.set("folders", { { name = "Lab", hosts = { "esx-02", "esx-03" } } })
```

## The vault

### `vault`

`roster.config.Vault` · default `{}`

This Box's own vault settings, over roster.yml's providers. Paths and choices, never a secret.

Options in it: [`save_to`](#vaultsave_to), [`kp`](#vaultkp).

```lua
roster.set("vault", { save_to = { organization = "My Team", collection = "Infra logins" } })
```

### `vault.save_to`

`"personal"|{ organization: string, collection: string }|{ group: string }` · default unset

Where Save to vault puts a new password by default.

Takes `"personal"`, { organization = …, collection = … } (Bitwarden) or { group = … } (KeePassXC).

```lua
roster.set("vault.save_to", { organization = "My Team", collection = "Infra logins" })
```

### `vault.kp`

`roster.config.KeePassXC` · default `{}`

KeePassXC's files, on the Box roster runs on.

Options in it: [`database`](#vaultkpdatabase), [`key_file`](#vaultkpkey_file).

```lua
roster.set("vault.kp", { database = "~/roster.kdbx" })
```

### `vault.kp.database`

`string` · default unset

KeePassXC's .kdbx.

Takes an absolute path, or one starting with ~.

```lua
roster.set("vault.kp.database", "~/roster.kdbx")
```

### `vault.kp.key_file`

`string` · default unset

A key file used with the database's master password.

Takes an absolute path, or one starting with ~.

```lua
roster.set("vault.kp.key_file", "~/roster.keyx")
```

## Packages

### `packages`

`(string|roster.config.Package)[]` · default `{}`

Plugins fetched from git repos and pinned in roster.lock: each a Package spec, or just its source.

Each item is a [`roster.config.Package`](#rosterconfigpackage).

```lua
roster.set("packages", { { "someone/recent-alerts", tag = "v1.2.0" }, "someone/pinned" })
```

### `plugin_proxy`

`string` · default unset

The proxy Plugins' requests to public names go through. Unset, they go direct.

Takes http://HOST:PORT, the port written out, with no user or password.

```lua
roster.set("plugin_proxy", "http://10.0.0.5:3128")
```

## Other

### `idle_lock_minutes`

`integer` · default `15`

Lock after this many minutes without input.

Takes 1 to 1440 minutes.

```lua
roster.set("idle_lock_minutes", 30)
```

### `pull_fresh_minutes`

`integer` · default `5`

How old the last pull of the infra repo may be before a form pulls again; 0 pulls every time.

Takes 0 to 1440 minutes.

```lua
roster.set("pull_fresh_minutes", 0)
```

### `auto_reload`

`boolean` · default `false`

Reload on every save of a .lua file of the Config, and of roster.yml. Off, :source reloads.

```lua
roster.set("auto_reload", true)
```

### `editor`

`"os"|"wsl"` · default `"os"`

What :config opens init.lua with: the desktop's app for .lua files, or $EDITOR inside WSL.

```lua
roster.set("editor", "wsl")
```

### `backend`

`string` · default `"auto"`

Which roster the app runs: detected, this machine's, or WSL's.

Takes `"auto"`, `"local"`, `"wsl"` or `"wsl:<distro>"`.

```lua
roster.set("backend", "wsl:dev")
```

### `roster_command`

`string|string[]` · default unset

The command that runs roster, for development: a command line (split on spaces) or a list of words. Unset, roster.

Takes roster itself: `"roster"`, a path ending in /roster, or `"uv run --project <dir> roster"`.

```lua
roster.set("roster_command", "uv run --project ~/work/roster roster")
```

## Types

The tables some options hold, by the names `:config types` gives them.

### `roster.config.Theme`

`themes.<id>` · `roster.config.Theme`

A Theme spec: a bundled Theme (base) with tokens changed, or a new one.

| Field | Type | Default | |
|---|---|---|---|
| `label` | `string` | unset | Its name in the app; the id when left out. |
| `appearance` | `"dark"\|"light"` | unset | Which OS appearance it suits; the base's when left out. |
| `base` | `string` | unset | The Theme it starts from: every token it doesn't set comes from there (Roster dark, or Roster light for appearance = `"light"`, when left out). Takes a Theme's id. |
| `colors` | `roster.config.UiColors` | `{}` | UI colour tokens over the base's. Names: `accent`, `accent_text`, `accent_ink`, `tone`, `bg`, `chrome`, `sidebar`, `panel`, `raised`, `raised_line`, `hover`, `line`, `line_strong`, `text`, `muted`, `faint`, `warn`, `error`, `danger`, `danger_text`, `backdrop`, `shadow`, `syntax_keyword`, `syntax_string`, `syntax_number`, `syntax_comment`, `syntax_function`, `syntax_punctuation`, `syntax_key`, `syntax_command`. |
| `terminal` | `roster.config.ThemeTerminalColors` | `{}` | The terminal's colours, apart from the 16 ANSI ones, over the base's. Names: `background`, `foreground`, `cursor`, `cursor_accent`, `selection_background`, `search_match`, `search_active_match`. |
| `ansi` | `false\|roster.config.Ansi` | unset | The 16 ANSI colours; false keeps the standard palette even when the base has its own; the base's when left out. Names: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `bright_black`, `bright_red`, `bright_green`, `bright_yellow`, `bright_blue`, `bright_magenta`, `bright_cyan`, `bright_white`. |

```lua
roster.set("themes", { paper = { appearance = "light", colors = { accent = "#b85c00" } } })
```

### `roster.config.KeyAction`

`keys.leader.<keys>` · `string|false`

A key action: the command line a key runs, or false to unbind a default.

Takes a command line, exactly what you'd type after : (`"close"`, `"session 1"`), or false.

```lua
roster.set("keys.leader", { ["d d"] = "close", ["Ctrl+n"] = false })
```

### `roster.config.View`

`views.<id>` · `roster.config.View`

A view spec: one panel's or view's default place and width.

| Field | Type | Default | |
|---|---|---|---|
| `place` | `"panel"\|"full"` | unset | Docked beside the terminal, or over the whole window. |
| `width` | `integer` | unset | Its docked width. Takes 10 to 95 percent of the window. |

```lua
roster.set("views", { topology = { place = "panel", width = 60 } })
```

### `roster.config.Folder`

`folders[n]` · `roster.config.Folder`

A Folder spec: a name and the Hosts in it.

| Field | Type | Default | |
|---|---|---|---|
| `name` | `string` | required | The Folder's name. Takes unique, ignoring case, with no double quote. |
| `hosts` | `string[]` | `{}` | The Hosts in it, in order. Takes Host names. |

```lua
roster.set("folders", { { name = "Lab", hosts = { "esx-02", "esx-03" } } })
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
roster.set("packages", { { "someone/recent-alerts", tag = "v1.2.0" }, "someone/pinned" })
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

Then `---@type roster.config.Options` on the table `init.lua` returns checks every name and value in it. The file is the copy this app was built with; run `:config types` again after an update.

