# The Config: `init.lua`

The roster app is configured by one Lua file, the way WezTerm and Neovim are (ADR 0004). There's no Settings screen. It's written the way Neovim's `init.lua` is: each line sets one option (`roster.o.terminal.size = "16pt"`), and a big Config splits into modules. [`examples/init.lua`](../../examples/init.lua) has every option with its default value and a comment; copy it and change what you like.

| OS | Where |
|---|---|
| Windows | `%APPDATA%\roster\init.lua` |
| Linux | `$XDG_CONFIG_HOME/roster/init.lua`, else `~/.config/roster/init.lua` (the folder roster itself may also keep a `roster.yml` in) |

## Writing init.lua

Set what you want to change and leave out the rest: everything you leave out keeps its default. A whole Config can be a few lines:

```lua
-- init.lua
roster.o.terminal.size = "16pt"
roster.o.terminal.cursor_style = "bar"
roster.o.vim = false
roster.o.modes.standard.statusbar = { "backend", "hosts", "mode" }

roster.keymap.set("leader", "t", "next")
roster.themes.define("roster-ember", { base = "roster-dark", colors = { accent = "#e0803a" } })
roster.o.theme = "roster-ember"
roster.folders.add({ name = "Lab", hosts = { "esx-02", "esx-03" } })

if roster.os == "windows" then
  roster.o.editor = "wsl"
end
```

`roster.o` holds every option, `roster.keymap` the key bindings, `roster.themes` the Themes, and `roster.packages` and `roster.folders` the Packages and Folders ([The `roster` table](#the-roster-table)). `:source` (`␣ S`) applies the file; saving alone doesn't, unless [`auto_reload`](options.md#auto_reload) is on.

### Split into modules

As in Neovim, `init.lua` can do nothing but load modules from a `lua/` folder beside it, one per subject. [`examples/init-split`](../../examples/init-split) is a whole Config written this way:

```text
init.lua                  require("myconf.options") … require("myconf.folders")
lua/myconf/options.lua    roster.o lines
lua/myconf/keys.lua       roster.keymap.set calls
lua/myconf/themes.lua     roster.themes.define, and roster.o.theme
lua/myconf/folders.lua    roster.folders.add
```

`require("myconf.keys")` loads `lua/myconf/keys.lua` (`.` is a folder), only from the config folder ([The sandbox](#the-sandbox)). The modules run in the order `init.lua` requires them, and they all write to [one store](#the-roster-table), so a later module can change what an earlier one set: a shared base, then a module of this machine's overrides.

**Errors and lines point at the module.** A mistake names the file and line that made it, in whichever module: `lua/myconf/options.lua:3: terminal.szie isn't an option (did you mean terminal.size?)`. The last good Config stays in use until you fix it and `:source` again. `:options` names the line too, for every option the Config sets.

### Finding options

- **`:help options`** is the [option reference](options.md): every option and every name of the `roster` table, with its type, default, the values it takes and an example, and in the app the value each has now. `:help terminal.size` opens one, `:help roster.keymap.set` a function.
- **`:options`** finds an option, with its value now, its default and where it was set (`lua/myconf/options.lua:3`, the State, or default). Enter opens its help.
- **`:config types`** writes every option's type and summary as `types/roster-config.lua` in the config folder, so lua-language-server completes names in your editor and shows what each does as you type ([Editor support](options.md#editor-support)). It checks names and types, but lets through a string outside an option's set (`terminal.cursor_style = "triangle"`): roster's own check catches that when the file loads, at its line.

### The returned table

Configs written before `roster.o` return a table, and that still loads:

```lua
return {
  terminal = { size = "16pt" },
  vim = false,
}
```

The two mix: a file may return a table and make `roster.*` calls. **The one rule: calls run in order and the last one wins, and the returned table wins over every call.** So `return { vim = true }` keeps `vim` on whatever a `roster.o.vim = false` line says, and `:options` names the table's line. `:config import-terminal` writes `roster.o` lines, so a value the returned table sets wins over the import, and so does a `roster.o` line below an older import block (running it again replaces the block where it is); its preview says which, and at which line. New Configs don't need the table at all.

### Feature detection

A Config may be read by an older app than the one it was written for (dotfiles on several machines). Check that a newer name is there before using it: names the app doesn't have read as nil.

```lua
if roster.themes.update then
  roster.themes.update("nord", { colors = { accent = "#88c0d0" } })
end
```

For the rare case a name can't tell (a name that stays but takes or does something else), `roster.config_version` is `init.lua`'s own version (decision Q165). It's 4 for v0.3.0's shape (`roster.o` and the collections' functions) and rises when a name is removed or renamed or changes what it takes, gives or does; a new name doesn't raise it (check that the name isn't nil). An app from before it (v0.4.0 and older) reads it as nil. `roster.api_version` is the Plugin API's version: it rises when only that changes, so it's not the way to tell what `init.lua` has.

```lua
if (roster.config_version or 0) >= 4 then
  roster.o.terminal.size = "16pt"
else
  roster.set("terminal.size", "16pt")
end
```

`roster.version` is the app's version (`"0.2.0"`), for a message or a bug report: compare its numbers, not the string.

```lua
local major, minor = roster.version:match("^(%d+)%.(%d+)")
if tonumber(major) > 0 or tonumber(minor) >= 3 then roster.o.ui.messages = "all" end
```

## `:config`

| Command | What it does |
|---|---|
| `:config` | Opens `init.lua` with the `editor` below. If there's no file yet, it first makes one from [`examples/init.lua`](../../examples/init.lua) with every line commented out, so it changes nothing until you uncomment something. A file that's there is never overwritten |
| `:source` (`:so`, `␣ S`) | Reloads the Config now, as Neovim's `:source` does: `init.lua` with its modules, and `roster.yml` (ticket 28). `:source PATH` reloads only the file that owns PATH (`:source lua/keys.lua` is `init.lua` again). Tab completes the files |
| `:config reload` | The same as `:source init.lua` |
| `:config path` | Says where the file is |
| `:config types` | Writes every option's type and description as `types/roster-config.lua` in the config folder, for lua-language-server: your editor completes option names and shows what each does ([Editor support](options.md#editor-support)) |
| `:options` | Finds an option, with its value now, its default and where it was set (the file and line, or default). Enter opens its entry in `:help options` |
| `:config import-terminal` | Copies Windows Terminal's default profile into `init.lua` (ticket 33): font, size, weight, cell height, cursor, how bold text looks, and a Theme made from its colour scheme, which it defines but doesn't set as `theme`: the app chooses it as `:theme` does, so `:theme` can still change it (decision Q69). It reads `settings.json` (Store, Preview or unpackaged), shows the change as a diff, and on Enter writes exactly that diff: if `init.lua` or Windows Terminal's `settings.json` changed since the preview, it writes nothing and asks you to run the import again to see the new diff. It writes `roster.o` lines (`roster.o.terminal.size = "12pt"`) between `-- >>> Windows Terminal >>>` and `-- <<< Windows Terminal <<<` lines: before the file's `return` if it has one, else at the end, so they win over the lines above them. Running the import again replaces the block in place. A value the file's returned table sets wins over the import ([The returned table](#the-returned-table)), and so does a line below the block that sets the same option (the last write wins); the preview names each one, a later line by its `file:line`. Windows only |

Everything configurable says its name where it shows, so you can tell where to change it: each row of the Key bindings panel (`␣ K`) names its option (`keys.leader`, `keys.list_vim`, `leader`) under its label, next to its source (`builtin`, `init.lua`, a Plugin), and the filter finds rows by it; the `:theme` finder says `theme = "<id>"` for the Theme under the cursor; and `␣ e` / `␣ s` say which `modes.<mode>.<piece>` keeps what they just showed or hid.

**Moving from roster-desk.** The app was called roster-desk until it joined the roster repo (decision Q56). The first time the roster app starts, if its config folder has no `init.lua` and no `folders.yml` yet, it copies everything from the old `roster-desk` folder (`%APPDATA%\roster-desk`, `~/.config/roster-desk`) into it, never overwriting a file. The State moves the same way, from the old app-data folder (`dev.roster.desk`) to the new one (`dev.roster.app`), when there's no State there yet. The old folders are left as they are; delete them once you're happy. The development env vars were renamed too (`ROSTER_DESK_*` → `ROSTER_APP_*`); the old names still work when the new ones aren't set.

## How it works

- The Rust core runs the file with Lua 5.4 (mlua, built in), as a block, the way Lua runs any file. It sets everything with `roster.*` calls (in itself or in the modules it `require`s: a one-line `require("me")` that loads `lua/me/init.lua` is a whole Config) and returns nothing, or returns a table as older Configs do ([The returned table](#the-returned-table)). Anything it leaves out keeps the built-in default. A table needs its `return`: a bare `{ … }` is a syntax error at its line. `return require("me")` of a module that returns nothing returns `true`, which isn't a Config: leave out the `return`, or have the module return a table.
- The table is checked against a schema (`crates/roster-core/src/config/schema.rs`, the source of truth) and sent to the frontend as one typed object (`app/src/config/types.ts`). The frontend never runs Lua.
- The frontend applies it **through the registries** (ADR 0006), with source `init.lua`. Plugins use the same registries ([plugins.md](../plugins.md)). Key bindings, Themes and Folders are registry entries. Everything else becomes the app's options (`app/src/config/apply.ts`).
- **Startup doesn't wait on it for long.** The window shows after at most 0.3 s; a Config that takes longer applies when it's done, the same way a `:source` does. Starting the backend waits for it, so `roster_command` and `backend` are always the file's.
- **`:source` reloads it (decision Q58).** Saving doesn't apply it by itself, as in Neovim: a half-written Config never takes effect mid-edit. The status bar says "init.lua changed" until you `:source` (`␣ S`).
- **`auto_reload = true` reloads on every save** instead. The core watches the folder, so editors that save by renaming a temp file over it work too. Any `.lua` file in the folder counts, including the modules it `require`s. If `init.lua`, a module or `lua/` is a symlink (stow, chezmoi), saving the file it points to counts too. Events that keep coming (a sync tool) still reload within half a second. Turning it on takes one `:source`, since the Config in effect decides.
- **Errors.** A Lua error (syntax or runtime), or a name or value the schema doesn't accept, shows a message with the file and line, for example `init.lua:12: terminal.size: 400 is out of range (6 to 72 px, 4.5 to 54 pt)`. The last good Config stays in use. A misspelled name is an error, not silently ignored.
- **Warnings.** Some things only the app can check: an action that isn't a command, a Theme name that isn't registered, a Sidebar section or status segment it doesn't know. These show as a warning, and the rest of the Config still applies.
- **Line numbers** come from Lua for Lua errors and for `roster.*` calls (only a call whose value is the one in use: when the returned table wins, its line is given). For a value in the returned table, the core finds its keys in the source (`size =`, `["d d"] =`), each after its parent's, outside `roster.*` statements (a Theme's `terminal = { … }` isn't the option `terminal`), first in `init.lua` and then in the modules it required, and names that file (`lua/opts.lua:4: terminal.size: …`). When it can't find the whole path (a value built in a loop or under a computed key, or a module's table placed under a key: `terminal = require("term")`) the message says `(line unknown)` instead of naming a wrong line.

## The sandbox

The Lua code runs in the Rust core, which never holds a secret (docs/app/security.md), and it gets less than the core has:

- **Libraries:** the base functions, `string` (without `string.dump`), `table`, `math`, `utf8`, and an `os` with only `time`, `clock`, `date` and `difftime`.
- **Not there:** `io`, `os.execute`, `os.getenv`, `os.remove`, `os.exit`, `debug`, `package` (so no C modules), `dofile`, `loadfile`, `collectgarbage`, `coroutine` (a Plugin has it, since `roster.api_version` 3). `load` takes text only, never bytecode.
- **`require(name)`** loads only `name.lua`, `name/init.lua`, `lua/name.lua` or `lua/name/init.lua` from the config folder (`.` in a name is a `/`). A name with `..` or a slash is refused, and so is a file (or a symlink) that resolves outside the folder. `require("roster")` returns the API table.
- **Limits:** 1 second of run time (an instruction hook checks a deadline, so `while true do end` stops with its line) and 64 MB of memory. Running out of time can't be caught: `pcall` and `xpcall` raise it again, so the run ends. The table it returns (with what it gave the `roster` calls) may hold at most 100,000 values and 16 MB of text, counting a table used in several places once per place.
- **One C call can't be stopped** by the instruction hook (a pattern that backtracks, say), so `string.find`, `match`, `gmatch` and `gsub` take text up to 64 KB and patterns up to 256 bytes, `string.rep` makes at most 1 MB, and a watchdog gives up on the whole run after 2 seconds of wall-clock time ("init.lua: took too long to run"). The last good Config stays in use.
- `print(...)` writes to the core's stderr (the `tauri dev` console).

## The `roster` table

A global, and also `require("roster")`. A Plugin gets another table with more in it: commands, Sidebar sections, finders, status segments, events ([plugins.md](../plugins.md)); none of the names below reaches it. The [option reference](options.md#the-roster-table) has each name with its parameters and an example (`:help roster.o`, `:help roster.folders.add`).

| Name | What |
|---|---|
| `roster.os`, `roster.version`, `roster.config_dir`, `roster.config_version`, `roster.api_version` | Read-only: the OS (`"windows"`, `"linux"` or `"macos"`), the app's version, the config folder, `init.lua`'s own version (`4`, [Feature detection](#feature-detection)), and the Plugin API's version (`5`; it rises with Plugin-only changes) |
| `roster.o` | Every option, Neovim style: `roster.o.terminal.size = "16pt"`. Nested objects need no setup; reading gives the value set so far (a copy) or nil, so `if roster.o.vim then` works; `roster.o.get("terminal.size")` reads one by its dotted name and `roster.o.reset("terminal.size")` puts one back to its default |
| `roster.set(name, value)` | Any option by its dotted name: `roster.set("terminal.size", "16pt")`. The same store as `roster.o`, checked the same way; for a name built at run time, and older Configs. `roster.o` is the usual way |
| `roster.keymap` | `set(context, keys, action)`, `del(context, keys)`, `get(context, keys)`, `list(context)`: key bindings, as in `keys` below. `action` is a command line, or `false` to unbind one of roster's |
| `roster.themes` | `define(id, theme)`, `update(id, fields)` (yours or a bundled one), `remove(id)` (yours), `get(id)`, `list()`: Themes, as in `themes` below |
| `roster.packages` | `add(spec, …)`, `remove(name)`, `update(name, fields)`, `get(name)`, `list()`, `has(name)`: Packages, as in `packages` below. Fetching stays a command (`:packages update`) |
| `roster.folders` | `add(folder, …)`, `remove(name)`, `update(name, fields)`, `get(name)`, `list()`, `has(name)`, `add_hosts(name, hosts)`, `remove_hosts(name, hosts)`: Folders, as in `folders` below |

**What `roster.o` gives back.** An option that holds a value reads as that value. An object (`roster.o.terminal`), a map (`roster.o.views`, `roster.o.keys.leader`) or a list (`roster.o.terminal.font`) reads as its table, with methods for its kind, called with a colon:

- an object: `:get()` (a copy of what's set in it, or nil) and `:reset()`;
- a map: `m.KEY = value`, `m.KEY`, `m.KEY = nil` (takes it away), `:has(key)`, `:keys()`, `:get()`, `:reset()`. A key named like a method (`get`, `has`, `keys`, `reset`) reads as that key once it's set (`roster.o.views.reset` after `roster.o.views.reset = { … }`) and as the method until then; `roster.o.get("views.get")` always reads it and `roster.o.reset("views")` always resets;
- a list: assign the whole list, `:get()`, `:append(v, …)`, `:prepend(v, …)`, `:insert(i, v)`, `:remove(v)`, `:has(v)`, `:clear()`, `:reset()`. An unset list starts from its default (`roster.o.terminal.font:prepend("Cascadia Mono")` keeps the default fonts after it). A list that takes each item once (`terminal.font`, sidebar sections, a Folder's Hosts) refuses a repeat. `statusbar` and `toolbar` are `true` (all of them) until you assign a list.

Each option's entry in the reference lists what its kind takes. A list's items (a Folder, a Package) change through their list's functions (`roster.folders.add_hosts`, `roster.packages.update`, `:remove`), or by assigning the list: `roster.o` doesn't reach inside an item (`roster.o.folders[1].name`). `roster.o.packages:has` and `:remove` take a Package's name or its source. Assigning one `roster.o` table to another option copies what it holds (what init.lua set, else its default); one that holds neither is an error, so copying never wipes anything.

**Walking one.** `roster.o`'s tables aren't plain Lua tables, so `pairs()` doesn't walk them: `roster.o.get(name)` gives a plain copy to walk (`for id in pairs(roster.o.get("views") or {}) do … end`). It reads any option by its dotted name and always works, even for a map that has a key named `get` or `keys`, where `:get()` and `:keys()` would read that key instead. The `roster` table itself walks as usual.

**Checked at the line.** A name the Config doesn't have is an error at the line that wrote it, with the name meant (`lua/opts.lua:3: terminal.szie isn't an option (did you mean terminal.size?)`), and so is a value of the wrong type. A table assigned whole (`roster.o.terminal = { … }`) is checked the same way and replaces that branch. A second Package or Folder with the same name, or a second `roster.themes.define` of an id, is an error naming both lines; removing or changing something that isn't there is an error too, never a silent no-op ([errors](errors.md#initluas-roster-table)). What only the whole Config can tell (a range, a form such as a chord, a Windows path with the WSL backend) is checked once it has run, and still names the line that set it. A write's line is the line its statement starts on (`roster.o.fonts = {` for a table over several lines), and a name inside such a table is reported at its own line. Reads (`roster.packages.get`, `roster.o.terminal:get()`) are copies: changing one changes nothing until you write it back.

**One store.** `roster.o`, `roster.set` and the collections write to the same place, and the last write wins, as in Neovim: a base module and then a module of overrides works, and a later write replaces whatever earlier ones put at its name (`roster.o.terminal = { … }` replaces an earlier `roster.o.terminal.size`, and a later `roster.o.terminal.size` changes just that value). Every write keeps its file and line, so `:options` and errors name it even for a value inside a table (`roster.o.fonts = { ui = … }`) or a module's table (`roster.o.terminal = require("term")`). If init.lua also returns a table and it sets the same option, key or Theme, the returned table wins ([The returned table](#the-returned-table)).

## Options

Names are snake_case in Lua. The frontend's object is camelCase (`bold_weight` → `boldWeight`).

The [option reference](options.md) (`:help options`) has every option below and every name of the `roster` table, one entry each: its type, its default, the values it takes and an example, generated from the core so it can't fall behind. This section says more about what each one does; its defaults are in the reference. In help, each name below opens its entry (`:help terminal.size`).

### Themes and colours

Their types, defaults and values: [Themes and colours](options.md#themes-and-colours) in the reference.

| Option | |
|---|---|
| `theme` | A Theme id, or `"auto"` to follow the OS light/dark setting |
| `dark_theme` / `light_theme` | What `"auto"` picks |
| `themes` | New Themes by id: `{ label, appearance = "dark"\|"light", base, colors = {…}, terminal = {…}, ansi = {…}\|false }`. Each starts from `base` (default: Roster dark, or Roster light for `appearance = "light"`) and changes only what it sets. `ansi = false` uses the standard palette (decision Q37). Leave `ansi` out to keep the base's |
| `colors` | Tokens set over whichever Theme is in use |

The bundled Themes are `roster-dark`, `roster-light`, `gruvbox`, `nord`, `catppuccin-mocha` and `tokyo-night` ([themes.md](themes.md)). `"auto"` leaves the Theme to the `:theme` picker, whose choice is kept in the State. A `theme` that names one is used until `:theme` chooses another: like Neovim's `:colorscheme`, that choice applies at once and stays, at start-up and on `:source`, until the file's `theme` changes to a different value, when the file wins again (decision Q69). Deleting the line unpins it.

UI tokens (`colors`, `themes.*.colors`): `accent`, `accent_text`, `accent_ink`, `tone`, `bg`, `chrome`, `sidebar`, `panel`, `raised`, `raised_line`, `hover`, `line`, `line_strong`, `text`, `muted`, `faint`, `warn`, `error`, `danger`, `danger_text`, `backdrop`, `shadow`, and for code in help and the docs website `syntax_keyword`, `syntax_string`, `syntax_number`, `syntax_comment`, `syntax_function`, `syntax_punctuation`, `syntax_key`, `syntax_command` ([Code's colours](themes.md#codes-colours)). `app/src/theme/theme.ts` says what each one colours.

Terminal colours (`themes.*.terminal`): `background`, `foreground`, `cursor`, `cursor_accent`, `selection_background`, `search_match`, `search_active_match`. ANSI colours (`themes.*.ansi`): `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, and `bright_` versions of each. `terminal.colors` takes both sets.

### Fonts and the terminal

Their types, defaults and values: [Fonts and the terminal](options.md#fonts-and-the-terminal) in the reference.

| Option | |
|---|---|
| `fonts.ui` | A family name, or a CSS font stack (anything with a comma is used as it is). A name gets the usual fallbacks |
| `fonts.mono` | The wordmark and code-like UI text |
| `fonts.ui_size` | The UI's text size in px, 11 to 20: Sidebar rows, the Picker, panels. The smaller steps (headings, addresses, counts, the status bar) and the row height follow it, and so does the Sidebar's width; nothing goes under 11 px. The terminal has its own `terminal.size`. |
| `ui.hints` | `false` hides every keycap hint: the status bar's, empty states', panels' and the Picker's footers, the command line's shortcut column, the Sidebar's Find button. The bindings work as before, and the keys stay in what a screen reader says. Unset, `:hints on\|off\|toggle` decides and the State keeps its choice; set, it wins. The Key bindings panel (`␣ K`) and `:help` always show the keys: they're what they list |
| `ui.messages` | What the message line shows, as Neovim's. `"quiet"`: errors, warnings, the answer to something you asked (`:info`, `:config path`) and results that need attention (a Publish, a save roster warned about, "Wrote Windows Terminal's profile…"). A routine action's confirmation (a Host saved, added, moved or renamed, `:source`'s "Reloaded init.lua") and a toggle's tip ("Sidebar hidden, and kept that way. modes.standard.sidebar = false in init.lua makes it the default", for the Sidebar, the bars, `:hints` and a panel's place or width) don't show; nor do a Plugin's info notices, its confirmations marked quiet (`roster.echo(text, { quiet = true })`, Folders' "Added esx-02 to Lab") and `:cancel`'s "Stopping …". A screen reader still hears what changed ("Sidebar hidden"). `"all"`: those show too. `:messages` lists the recent ones either way. Unset, `:messages all\|quiet\|toggle` decides and the State keeps its choice (quiet until it makes one); set, it wins |
| `terminal.font` | Families, most wanted first: the first one installed is used (installed fonts are matched by name; the CSP's `font-src` doesn't restrict them). The bundled Iosevka (no Nerd Font glyphs) is always there. A name, a CSS stack, or a list. `:info` says which one is in use |
| `terminal.size` | The default, 13 pt, is 17.33 px, a step above Windows Terminal's own 12 pt (decision Q61). A number is px; `"16pt"` is points, converted as Windows Terminal does (× 96/72, so 16 pt is 21.33 px, and the display scale applies to both the same way); `"21px"` works too. 6 to 72 px. Zoom keys move it a px at a time, and Ctrl+0 comes back to it |
| `terminal.weight` | 100 to 900. Iosevka ships at 400, 500 (medium, the default) and 700 |
| `terminal.bold_weight` | The weight of bold (SGR 1) text |
| `terminal.bold_is_bright` | Bold text in the bright ANSI colours too |
| `terminal.line_height` | A multiple of the font's own line height, 0.5 to 3. 1.0 gives the same rows as Windows Terminal's default ([terminal-vs-wt](design/terminal-vs-wt/README.md)) |
| `terminal.cell_height` | A multiple of the font size, as Windows Terminal's `cellHeight`, 0.5 to 3. Wins over `line_height` |
| `terminal.renderer` | `"webgl"` (fast, the default) or `"dom"`: the browser's own text rendering, a little closer to ClearType and slower with a lot of output (measured in [terminal-vs-wt](design/terminal-vs-wt/README.md)) |
| `terminal.cursor_style` | `"block"`, `"bar"` or `"underline"` |
| `terminal.scrollback` | Lines, at most 1,000,000 |
| `terminal.copy_on_select` | Also makes right-click always paste, as Windows Terminal's copy-on-select does: a right-click on a selection copies it, clears it and then pastes it ([Copy and paste](keyboard.md#copy-and-paste)) |
| `terminal.right_click_paste` | Right-click copies the selection, or pastes when there's none; with `copy_on_select` on it copies and then pastes. While a program has mouse reporting on, a right-click is the program's, selection or not ([Copy and paste](keyboard.md#copy-and-paste)) |
| `terminal.osc52` | A program in the Session on screen may set the clipboard with OSC 52, as in Windows Terminal: how Claude Code, vim and tmux copy what you select in them. Write only (a Host never reads the clipboard), text only, at most 1 MiB. `false` turns it off ([security.md](security.md#the-clipboard)) |
| `terminal.colors` | Any terminal or ANSI colour, set over the Theme's |
| `terminal.shell_hooks` | Send each Session's shell one line after login that turns on its prompt marks (OSC 133) and says its folder (OSC 7), in that shell only, never in its rc files ([Shell hooks](../plugins.md#shell-hooks-roster-sets-it-up)). Unset: a Host's `shell_hooks: true` in `roster.yml` decides. `true`: every Session, Quick Connect too, except a Host with `shell_hooks: false`. `false`: none, whatever a Host says. `:integrate` sends the line to the Session on screen whatever this says |

### Keys

Their types, defaults and values: [Keys](options.md#keys) in the reference.

| Option | |
|---|---|
| `leader` | The chord that takes the keyboard back from a terminal. Written `"Ctrl+Space"`, `"ctrl+b"`, `"C-b"` or `"<C-b>"`. Without Ctrl, Alt or Meta it gives a warning, because the key would never reach the shell |
| `vim` | j/k/h/l/gg/G in lists and the Picker |
| `keys` | Per context, `key = action`. The action is a command line, exactly what you'd type after `:` (`"close"`, `"session 1"`, `"finder sessions"`). `false` unbinds a default. Sequences are chords separated by spaces: `["d d"]` |

Contexts: `leader` (after the Leader), `list` and `list_vim` (the Sidebar), `picker` and `picker_vim` (the Picker and every finder; actions `picker.down`, `picker.up`, `picker.next` (Tab: first fills the query with what the matching names share, then the next result, wrapping), `picker.prev` (Shift+Tab), `picker.choose`, `picker.chooseHere`, `picker.review` (Ctrl+R: mark an unreviewed Host reviewed), `picker.info` (Ctrl+I: the Host's details, ticket 18), `picker.help` (F1: help on the selected result, ticket 52), `picker.close`), `cmdline` (the `:` command line: `cmdline.next` (Tab, Ctrl+N), `cmdline.prev` (Shift+Tab, Ctrl+P), `cmdline.accept` (Ctrl+Y), `cmdline.run` (Enter), `cmdline.cancel` (Esc), `cmdline.help` (Ctrl+], F1: help on the command typed, ticket 52)), `terminal` (before the shell sees the key: `terminal.copy`, `terminal.copyIfSelected` (Ctrl+C: copies only while something is selected), `terminal.paste`, `terminal.pasteIfText` (Ctrl+V on Windows, and on Ctrl+V only: pastes text, or goes to the program as ^V when there's none), `terminal.search`, `terminal.zoomIn`, `terminal.zoomOut`, `terminal.zoomReset`, …), and `global` (everywhere with no Leader, like F11; keep it to keys a shell doesn't use). The Key bindings panel (`␣ K`) lists every binding with its source: `builtin` or `init.lua`.

### Layout

Their types, defaults and values: [Layout](options.md#layout) in the reference.

| Option | |
|---|---|
| `default_mode` | The view mode at start: `"standard"` or `"focus"`. Read at start only |
| `sessions` | Open Sessions in the Sidebar, or `"tabs"` for a tab strip |
| `modes.standard`, `modes.focus` | Each mode's pieces. A piece left out keeps that mode's default |
| `panel.width` | A docked panel's width in percent of the window, 10 to 95, for every panel and view that `views` doesn't give one (ticket 95). Unset, each keeps its own (Key bindings 320 px, help up to 600 px, a view up to 640 px). It's a default: a width you pick with `␣ <` / `␣ >` or by dragging a panel's edge is kept in the State per panel and wins, until `:panel reset`. Whatever is set, a docked panel stays between 280 px and what leaves the terminal about 50 columns ([Panels](keyboard.md#panels-docked-or-full-window)) |
| `views` | Per panel or view id, `{ place = "panel"\|"full", width = N }`: where it opens first (docked beside the terminal, or full window) and its docked width in percent, 10 to 95. Ids: `help`, `details`, `edit`, `add`, `save`, `changes`, `plugins`, `packages`, `keys`, `check`, and a Plugin's view by its id (`roster.o.views.topology = { place = "panel", width = 60 }`). A Plugin's own `place` is only where its view opens until this or your choice says otherwise. Defaults, as `panel.width`: `␣ z` and the rest are kept in the State and win, until `:panel reset` (decision Q106) |

The pieces of a mode:

| Piece | Takes | Standard | Focus |
|---|---|---|---|
| `titlebar` | `true` / `false` | `true` | `false` |
| `sidebar` | `false`, `true`, or `{ side = "left"\|"right", sections = { "sessions", "folders", "inventory" } }`. `sections` picks and orders them. Leave it out for all | `{ side = "left" }` | `false` |
| `sessionbar` | `false`, `"bottom"` or `"top"`: the thin tmux-style bar of open Sessions | `false` | `false` |
| `statusbar` | `false`, `true`, or segments in order: `"backend"`, `"box"`, `"session"` (the Session on screen: its node and name), `"inventory"` (the named Inventory roster runs on, shown only when it runs on one), `"hosts"`, `"path"`, `"changes"` (the Pending changes count, shown only when there are some), `"hints"`, `"mode"`. `hints` and `mode` sit on the right | `true` | `false` |
| `fullscreen` | `true` / `false`: OS fullscreen | `false` | `true` |
| `toolbar` | `false`, `true`, or controls in order: `"sidebar"` (the Sidebar's toggle, at the left), `"find"`, `"quick"` (Quick Connect, shown only with a roster that has it, API 12), `"add"` (Add Host), `"changes"` (with the Pending changes count), `"publish"` (shown only while there are Pending changes), `"details"` (Host details for the selected Host, ticket 18, by the window's buttons), and `"cmdline"`, `"keys"`, `"help"` (`:help`'s topic finder), `"lock"`, `"mode"`, which aren't in the default set. A Plugin's controls (`roster.toolbar`) show after these unless the list is given; then name a control's id to show it. In the title bar; a bar of its own when the mode has none (decision Q65) | `true` (sidebar, find, quick, add, changes, publish, details) | `false` |

`␣ e` (or the Sidebar button at the left of the title bar) shows or hides the Sidebar, in Standard and in Focus (over the terminal there), and the State keeps that per mode, unless `init.lua` sets that mode's `sidebar`, which wins at the next start or `:source` (issue #54). `␣ s` shows or hides the mode's bar (the status bar in Standard, the session bar in Focus). `␣ t` finds in the Sidebar's tree. A reload that changes `modes` resets what `␣ s` toggled. A reload that changes anything else keeps it.

The option names in the app are `Options.defaultMode` ← `default_mode`, `Options.focus.sessionbar` ← `modes.focus.sessionbar` (`"top"`, `"bottom"` or `false`), `Options.sidebar` ← `modes.standard.sidebar`, and `Options.statusBar` ← `modes.standard.statusbar`. The earlier `focus.status_line = true` is now `modes.focus.sessionbar = "bottom"`.

### Folders

Their types, defaults and values: [Folders](options.md#folders) in the reference.

| Option | |
|---|---|
| `folders` | Folders kept in the Config, each `{ name = "…", hosts = { "…" } }`: read-only in the app |

```lua
roster.folders.add({ name = "Lab ESXi", hosts = { "esx-02", "esx-03" } })
roster.folders.add_hosts("Lab ESXi", { "esx-04" })
```

They show first in the Folders section, marked "from init.lua", and only `init.lua` can change them: `folder add`, `rename`, `delete` and `remove` say so. A Folder made in the app with the same name is hidden behind it. Names must be unique, ignoring case, and can't contain a double quote. Folders made in the app are kept by the built-in Folders Plugin in its own data folder (below); init.lua's are handed to it as its settings, and a change to them applies on `:source` like the rest of the Config.

### `folders.yml`

Folders made in the app used to be kept in `folders.yml`, next to `init.lua` (decision Q46). Since Folders became a built-in Plugin (decision Q93), they're kept in its own data folder, as `plugin-data/folders/folders.json` next to the State, and `folders.yml` is **moved in once**:

- At start, the app reads `folders.yml` and hands its Folders to the Folders Plugin, which moves them in only while it has none of its own yet: every Folder and every Host, in order, a Host that isn't in the Inventory too. A notice says how many moved. Comments in the file don't move.
- With no `folders.yml`, the Folders an older app kept in the State move in the same way.
- A `folders.yml` that doesn't parse moves nothing: the Folders section says the line (`folders.yml:3 has an error …`), and Folders can't be changed until it's fixed, so nothing is written over them. Fix it and restart (or `:plugins reload folders`).
- After that the app never writes, watches or reloads `folders.yml`; `:check` says it's still there and no longer read. Delete it once your Folders look right.

```yaml
# folders.yml, as older versions wrote it: moved in once, then unused
Lab ESXi:
  - esxi-02
  - esxi-03
Night shift: []
```

To write Folders by hand, put them in `init.lua` ([above](#folders)). Folders never go into `roster.yml` or to `roster serve`.

### The vault

Their types, defaults and values: [The vault](options.md#the-vault) in the reference.

```lua
roster.o.vault.save_to = { organization = "My Team", collection = "Infra logins" }
roster.o.vault.kp.database = "~/roster.kdbx"
roster.o.vault.kp.key_file = "~/roster.keyx"
```

This Box's own vault settings. They win over `roster.yml`'s `providers:` (the team's), so a setting that's personal doesn't have to go into the Inventory. The app sends them to `roster serve` (`vault.configure`, [serve-api.md](../serve-api.md#this-boxs-settings-vaultconfigure)) when it starts, before the lock screen asks where the vault stands, and again on every `:source`. Leave one out and `roster.yml`'s applies. They're paths and choices, never a secret: init.lua can't hold or send a password (docs/app/security.md). Needs roster's API 10; an older roster just uses `roster.yml`.

| Option | |
|---|---|
| `vault.save_to` | Where "Save to vault" puts a new password by default (ticket 35): `"personal"`, `{ organization = …, collection = … }` (Bitwarden, names or ids) or `{ group = … }` (KeePassXC). Wins over `roster.yml`'s `providers: <name>: save_to:` (the team's default). The add form's **Save to** starts on it, says where it's set, and can pick another place for one Host. A name that isn't there shows in the form as roster's message naming `vault.save_to in init.lua` |
| `vault.kp.database` | KeePassXC's `.kdbx` (ticket 41). Wins over `providers: kp: database:`. A path on the Box roster runs on (inside WSL for a WSL Backend): absolute, or starting with `~`. With `backend = "local"` on Windows that's a Windows path (`C:\Users\you\roster.kdbx`); with any other `backend`, a Windows path (`C:\Users\…`, `\\server\…`) is an error that names the WSL path it most likely means (`/mnt/c/Users/…`; a `\\wsl$\<distro>\…` share is that distro's own `/…`). Changing it on `:source` locks the app, since the master password was for the old database |
| `vault.kp.key_file` | A key file used with that database's master password, on the same Box, as `database` (a Windows path only with `backend = "local"`). Wins over `providers: kp: key_file:` |

### Packages

Their types, defaults and values: [Packages](options.md#packages) in the reference.

```lua
roster.packages.add(
  { "someone/recent-alerts", tag = "v1.2.0", config = { patterns = { "ERROR", "panic" } } },
  "someone/pinned",
  { "https://git.example.com/team/roster-extras.git", branch = "main" },
  { "https://git.example.com/team/roster-extras.git", dir = "plugins/alerts" }
)
roster.packages.update("recent-alerts", { tag = "v1.3.0" })
```

Plugins fetched from git repos, the way lazy.nvim fetches Neovim's ([plugins.md](../plugins.md#packages)). The app clones each one into its own data folder, asks before it runs one (the same prompt as `:plugins install`, with the repo shown as an unverified source), and pins the commit in `roster.lock`, next to `init.lua`, so the lock can go into your dotfiles with it. Nothing is fetched that isn't named here. Changing the list, or a Package's `config`, takes effect on `:source`.

| Option | |
|---|---|
| `packages` | Each one `{ SOURCE, tag = …, config = { … } }`, or just `SOURCE`. SOURCE is `"owner/repo"` (on GitHub) or a git URL: `https://…`, `ssh://…`, `git@host:path`, `file://…`, or a full path to a repo on this machine (plain `http://` and `git://` are refused: anyone on the way could change them). At most one of `tag`, `branch` or `commit`; none means the repo's default branch. `name = "…"` names it (its folder and its line in `roster.lock`) when the repo's name won't do. `dir = "plugins/NAME"` loads the Plugin from that folder of the repo instead of its top, and names the Package after the folder; it must be inside the repo (relative, `/` between folders, no `..`, no `.git`, no symlink that leads out), and two Packages from one repo each get a clone of their own (decision Q94). [First-party Plugins](../plugins.md#first-party-plugins) install this way. `config` is a table of settings the Package reads as `roster.plugin.config`; it can't be a function, since a Package runs in a Lua state of its own (decision Q83) |
| `plugin_proxy` | The proxy Plugins' network requests go through, on a network that only leaves through one: `"http://10.0.0.5:3128"`. Only `http://HOST:PORT`, with the port written out: never a user or password (roster sends a proxy no credentials, and a Plugin can't set one either), and https still goes end to end, as a tunnel the proxy can't read. Only requests to public names use it; a `private:` site and a site that's an address go direct, a public address too (`network:45.10.20.30`): the proxy is never used for an address, so such a site reaches the network the way this Box does without one. Through the proxy, roster still looks the name up itself first and refuses it, as without a proxy, if any address is on this computer or a private network, then asks the proxy for a tunnel to that checked address (`CONNECT 45.10.20.30:443`), never the name, so the request reaches only the address roster checked (decision Q161). So this computer must be able to look public names up (a name it can't isn't sent), and the proxy must allow a CONNECT to an address, on port 80 too for an `http://` site; a proxy that refuses fails the request, and roster never hands it the name instead. Unset: requests go direct, and the environment's and the system's proxy settings are always ignored. A change takes effect at each running Plugin's next request once the Config reloads (`:source`); a request already going finishes as it began (decision Q116) |

### Other

Their types, defaults and values: [Other](options.md#other) in the reference.

| Option | |
|---|---|
| `idle_lock_minutes` | Lock after this many minutes without input, 1 to 1440 |
| `pull_fresh_minutes` | How old the last pull of the infra repo may be before a form (`:edit`, `:host add`, Save to vault) pulls again, 0 to 1440; `0` pulls every time. The form opens at once either way and pulls in the background; its Save waits for that pull, and a pull that fails blocks the save, never the form (decision Q88). Not over Pending changes: those were pulled before the first one |
| `auto_reload` | Reload on every save of a `.lua` file of the Config, and of `roster.yml` (roster's watcher; the Sidebar follows within a second). Off: `:source` reloads (decision Q58), and the status bar says which file changed |
| `editor` | What `:config` opens `init.lua` with: `"os"` (the app the desktop opens `.lua` files with; on Windows, the app registered to *edit* `.lua` files, else Notepad, and never the one that *opens* them, which with Lua installed is the interpreter and would run the file), or `"wsl"` (`$EDITOR` inside the Backend's WSL distro, `vi` if it's unset, in a console window of its own; Windows only). It's a choice, not a command line: like `roster_command`, a Config can't name a program of its own to run |
| `backend` | Which roster the app runs. `"local"`: roster on this machine (on Windows, roster installed on Windows itself, with Windows' own OpenSSH). `"wsl"`: roster in WSL, in the first distro that has it; `"wsl:<distro>"`: in that distro. `"auto"`: on Windows, roster on Windows if it finds an Inventory there, else WSL's, else whichever has roster at all; on Linux, roster always runs locally. Changing it and reloading (`:source`) starts `roster serve` again on the new Backend |
| `roster_command` | The command that runs roster, for development: a command line (split on spaces) or a list of words. It must be roster itself: `"roster"`, a path ending in `/roster`, or `"uv run --project <dir> roster"` (`uv run` takes only `--project`, `--directory`, `--frozen`, `--locked`, `--offline`, `--no-sync` and `-q`). Anything else is an error; see below |

**Why `roster_command` is limited.** The program it names gets the master password, two-step codes and the API key's secret on its stdin. A Config is code that may come from dotfiles, and a Package's Plugin runs beside it, so it can't put another program in front of them (docs/app/security.md). For a wrapper (a script that sets something up, then runs roster), set the `ROSTER_APP_ROSTER` env var yourself, outside the Config: it takes any command. `:info` and the status bar's path tooltip show the command in use.

`backend` and `roster_command` are read when the backend starts. A reload (`:source`, or a save with `auto_reload`) that changes either one starts `roster serve` again, with the new one: the vault locks (the new serve has never been unlocked), and open Sessions keep running where they started. On the error screen, Retry does the same. The env vars still win, for development: `ROSTER_APP_ROSTER` over `roster_command`, and `ROSTER_APP_WSL_DISTRO` over `backend = "wsl:<distro>"`.

## Not in v1

- Lua functions as actions or values in `init.lua`. Hooks, custom `:` commands and finder sources are for Plugins ([plugins.md](../plugins.md)).
- A Settings screen (decision Q24).
- Window size, recent Hosts and folded rows. Those are State, which the app keeps by itself.

## See also

[Recipes](recipes.md) · [Options](options) · [Option reference](options.md) · [Keyboard](keyboard.md) · [Themes](themes.md) · [How far roster bends](extending.md)
