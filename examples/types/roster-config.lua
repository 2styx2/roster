---@meta
-- Generated from crates/roster-core/src/config/shape by `cargo run -p roster-core --example gen_config_options`.
-- The types of init.lua's options and its `roster` table, for lua-language-server: `:config types`
-- writes this file as types/roster-config.lua in the config folder. `:help options` has the same text.

--- Every option init.lua takes. `---@type roster.config.Options` on the table it returns checks it.
---@class roster.config.Options
---@field theme? string The Theme to use, or "auto" to follow the OS's light or dark setting with dark_theme and light_theme. Default: `"auto"`. Takes a Theme's id, or "auto".
---@field dark_theme? string The Theme "auto" picks while the OS is dark. Default: `"roster-dark"`. Takes a Theme's id.
---@field light_theme? string The Theme "auto" picks while the OS is light. Default: `"roster-light"`. Takes a Theme's id.
---@field themes? table<string, roster.config.Theme>|roster.o.Map New Themes, or changed copies of bundled ones, by id: each a Theme spec.
---@field colors? roster.config.UiColors UI colour tokens set over whichever Theme is in use.
---@field fonts? roster.config.Fonts The UI's fonts.
---@field ui? roster.config.Ui The rest of the UI's look.
---@field terminal? roster.config.Terminal The terminal's font, look and behaviour.
---@field leader? string The chord that takes the keyboard back from a terminal. Default: `"Ctrl+Space"`. Takes a chord: "Ctrl+Space", "ctrl+b", "C-b" or "<C-b>", with Ctrl, Alt or Meta.
---@field vim? boolean j/k/h/l/gg/G in lists and the Picker. Default: `true`.
---@field keys? roster.config.Keys Key bindings, per context: key or sequence → action.
---@field default_mode? "standard"|"focus" The view mode at start (read at start only). Default: `"standard"`.
---@field sessions? "sidebar"|"tabs" Open Sessions in the Sidebar, or in a tab strip. Default: `"sidebar"`.
---@field modes? roster.config.Modes Each view mode's layout.
---@field panel? roster.config.Panel What every panel and view starts with.
---@field views? table<string, roster.config.View>|roster.o.Map Per panel or view id (help, details, a Plugin view's id): where it opens first, and its width.
---@field folders? roster.config.Folder[]|roster.o.List Folders kept in the Config, read-only in the app: each a Folder spec.
---@field vault? roster.config.Vault This Box's own vault settings, over roster.yml's providers. Paths and choices, never a secret.
---@field packages? (string|roster.config.Package)[]|roster.o.List Plugins fetched from git repos and pinned in roster.lock: each a Package spec, or just its source.
---@field plugin_proxy? string The proxy Plugins' requests to public names go through. Unset, they go direct. Takes "http://HOST:PORT", the port written out, with no user or password.
---@field idle_lock_minutes? integer Lock after this many minutes without input. Default: `15`. Takes 1 to 1440 minutes.
---@field pull_fresh_minutes? integer How old the last pull of the infra repo may be before a form pulls again; 0 pulls every time. Default: `5`. Takes 0 to 1440 minutes.
---@field auto_reload? boolean Reload on every save of a .lua file of the Config, and of roster.yml. Off, :source reloads. Default: `false`.
---@field editor? "os"|"wsl" What :config opens init.lua with: the desktop's app for .lua files, or $EDITOR inside WSL. Default: `"os"`.
---@field backend? string Which roster the app runs: detected, this machine's, or WSL's. Default: `"auto"`. Takes "auto", "local", "wsl" or "wsl:<distro>".
---@field roster_command? string|string[]|roster.o.List The command that runs roster, for development: a command line (split on spaces) or a list of words. Unset, roster. Takes roster itself: "roster", a path ending in /roster, or "uv run --project <dir> roster".

--- A Theme spec: a bundled Theme (base) with tokens changed, or a new one.
---@class roster.config.Theme : roster.o.Object
---@field label? string Its name in the app; the id when left out.
---@field appearance? "dark"|"light" Which OS appearance it suits; the base's when left out.
---@field base? string The Theme it starts from: every token it doesn't set comes from there (Roster dark, or Roster light for appearance = "light", when left out). Takes a Theme's id.
---@field colors? roster.config.UiColors UI colour tokens over the base's.
---@field terminal? roster.config.ThemeTerminalColors The terminal's colours, apart from the 16 ANSI ones, over the base's.
---@field ansi? false|roster.config.Ansi The 16 ANSI colours; false keeps the standard palette even when the base has its own; the base's when left out.

--- UI colour tokens over the base's.
---@class roster.config.UiColors : roster.o.Object
---@field accent? string The `accent` colour. Takes a CSS colour, such as "#e8a33d".
---@field accent_text? string The `accent_text` colour. Takes a CSS colour, such as "#e8a33d".
---@field accent_ink? string The `accent_ink` colour. Takes a CSS colour, such as "#e8a33d".
---@field tone? string The `tone` colour. Takes a CSS colour, such as "#e8a33d".
---@field bg? string The `bg` colour. Takes a CSS colour, such as "#e8a33d".
---@field chrome? string The `chrome` colour. Takes a CSS colour, such as "#e8a33d".
---@field sidebar? string The `sidebar` colour. Takes a CSS colour, such as "#e8a33d".
---@field panel? string The `panel` colour. Takes a CSS colour, such as "#e8a33d".
---@field raised? string The `raised` colour. Takes a CSS colour, such as "#e8a33d".
---@field raised_line? string The `raised_line` colour. Takes a CSS colour, such as "#e8a33d".
---@field hover? string The `hover` colour. Takes a CSS colour, such as "#e8a33d".
---@field line? string The `line` colour. Takes a CSS colour, such as "#e8a33d".
---@field line_strong? string The `line_strong` colour. Takes a CSS colour, such as "#e8a33d".
---@field text? string The `text` colour. Takes a CSS colour, such as "#e8a33d".
---@field muted? string The `muted` colour. Takes a CSS colour, such as "#e8a33d".
---@field faint? string The `faint` colour. Takes a CSS colour, such as "#e8a33d".
---@field warn? string The `warn` colour. Takes a CSS colour, such as "#e8a33d".
---@field error? string The `error` colour. Takes a CSS colour, such as "#e8a33d".
---@field danger? string The `danger` colour. Takes a CSS colour, such as "#e8a33d".
---@field danger_text? string The `danger_text` colour. Takes a CSS colour, such as "#e8a33d".
---@field backdrop? string The `backdrop` colour. Takes a CSS colour, such as "#e8a33d".
---@field shadow? string The `shadow` colour. Takes a CSS colour, such as "#e8a33d".
---@field syntax_keyword? string The `syntax_keyword` colour. Takes a CSS colour, such as "#e8a33d".
---@field syntax_string? string The `syntax_string` colour. Takes a CSS colour, such as "#e8a33d".
---@field syntax_number? string The `syntax_number` colour. Takes a CSS colour, such as "#e8a33d".
---@field syntax_comment? string The `syntax_comment` colour. Takes a CSS colour, such as "#e8a33d".
---@field syntax_function? string The `syntax_function` colour. Takes a CSS colour, such as "#e8a33d".
---@field syntax_punctuation? string The `syntax_punctuation` colour. Takes a CSS colour, such as "#e8a33d".
---@field syntax_key? string The `syntax_key` colour. Takes a CSS colour, such as "#e8a33d".
---@field syntax_command? string The `syntax_command` colour. Takes a CSS colour, such as "#e8a33d".

--- The terminal's colours, apart from the 16 ANSI ones, over the base's.
---@class roster.config.ThemeTerminalColors : roster.o.Object
---@field background? string The `background` colour. Takes a CSS colour, such as "#e8a33d".
---@field foreground? string The `foreground` colour. Takes a CSS colour, such as "#e8a33d".
---@field cursor? string The `cursor` colour. Takes a CSS colour, such as "#e8a33d".
---@field cursor_accent? string The `cursor_accent` colour. Takes a CSS colour, such as "#e8a33d".
---@field selection_background? string The `selection_background` colour. Takes a CSS colour, such as "#e8a33d".
---@field search_match? string The `search_match` colour. Takes a CSS colour, such as "#e8a33d".
---@field search_active_match? string The `search_active_match` colour. Takes a CSS colour, such as "#e8a33d".

--- The 16 ANSI colours; false keeps the standard palette even when the base has its own; the base's when left out.
---@class roster.config.Ansi : roster.o.Object
---@field black? string The `black` colour. Takes a CSS colour, such as "#e8a33d".
---@field red? string The `red` colour. Takes a CSS colour, such as "#e8a33d".
---@field green? string The `green` colour. Takes a CSS colour, such as "#e8a33d".
---@field yellow? string The `yellow` colour. Takes a CSS colour, such as "#e8a33d".
---@field blue? string The `blue` colour. Takes a CSS colour, such as "#e8a33d".
---@field magenta? string The `magenta` colour. Takes a CSS colour, such as "#e8a33d".
---@field cyan? string The `cyan` colour. Takes a CSS colour, such as "#e8a33d".
---@field white? string The `white` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_black? string The `bright_black` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_red? string The `bright_red` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_green? string The `bright_green` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_yellow? string The `bright_yellow` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_blue? string The `bright_blue` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_magenta? string The `bright_magenta` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_cyan? string The `bright_cyan` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_white? string The `bright_white` colour. Takes a CSS colour, such as "#e8a33d".

--- The UI's fonts.
---@class roster.config.Fonts : roster.o.Object
---@field ui? string The UI's font. Default: `"Inter"`. Takes a family name, or a CSS font stack (anything with a comma).
---@field mono? string The wordmark's and code-like UI text's font. Default: `"Iosevka"`. Takes a family name, or a CSS font stack.
---@field ui_size? integer The UI's text size; the smaller steps, the row height and the Sidebar's width follow it. Default: `15`. Takes 11 to 20 px.

--- The rest of the UI's look.
---@class roster.config.Ui : roster.o.Object
---@field hints? boolean false hides every keycap hint. Unset, :hints decides and the State keeps its choice; set, it wins.
---@field messages? "quiet"|"all" What the message line shows: errors, warnings and answers only ("quiet"), or routine confirmations too ("all"). Unset, :messages decides.

--- The terminal's font, look and behaviour.
---@class roster.config.Terminal : roster.o.Object
---@field font? string|string[]|roster.o.List Font families, most wanted first: the first one installed is used. Default: `{ "Iosevka Nerd Font", "Iosevka Term", "Iosevka" }`. Takes a font name, a CSS font stack, or a list of names. Each item once.
---@field size? number|string The font size: a number is px, "16pt" is points (as Windows Terminal converts them), "21px" works too. Default: `"13pt"`. Takes 6 to 72 px (4.5 to 54 pt).
---@field weight? integer The font weight; the bundled Iosevka has 400, 500 and 700. Default: `500`. Takes 100 to 900.
---@field bold_weight? integer The weight of bold (SGR 1) text. Default: `700`. Takes 100 to 900.
---@field bold_is_bright? boolean Bold text in the bright ANSI colours too. Default: `true`.
---@field line_height? number A multiple of the font's own line height. Default: `1.0`. Takes 0.5 to 3.
---@field cell_height? number A multiple of the font size, as Windows Terminal's cellHeight; wins over line_height. Takes 0.5 to 3.
---@field renderer? "webgl"|"dom" WebGL (fast) or the DOM (the browser's own text rendering). Default: `"webgl"`.
---@field cursor_style? "block"|"bar"|"underline" The cursor's shape. Default: `"block"`.
---@field scrollback? integer How many lines the terminal keeps above the screen. Default: `10000`. Takes 0 to 1000000 lines.
---@field copy_on_select? boolean Selecting text copies it. Default: `true`.
---@field right_click_paste? boolean Right-click copies the selection, or pastes when there's none; with copy_on_select on, it copies and then pastes. Default: `true`.
---@field osc52? boolean A program in the Session on screen may set the clipboard with OSC 52 (write only, at most 1 MiB), as in Windows Terminal: how Claude Code, vim or tmux copy what you select in them. Default: `true`.
---@field colors? roster.config.TerminalColors Any terminal or ANSI colour, set over the Theme's.
---@field shell_hooks? boolean Send each Session's shell the line that turns on prompt marks (OSC 133) and its folder (OSC 7). Unset, a Host's shell_hooks in roster.yml decides.

--- Any terminal or ANSI colour, set over the Theme's.
---@class roster.config.TerminalColors : roster.o.Object
---@field background? string The `background` colour. Takes a CSS colour, such as "#e8a33d".
---@field foreground? string The `foreground` colour. Takes a CSS colour, such as "#e8a33d".
---@field cursor? string The `cursor` colour. Takes a CSS colour, such as "#e8a33d".
---@field cursor_accent? string The `cursor_accent` colour. Takes a CSS colour, such as "#e8a33d".
---@field selection_background? string The `selection_background` colour. Takes a CSS colour, such as "#e8a33d".
---@field search_match? string The `search_match` colour. Takes a CSS colour, such as "#e8a33d".
---@field search_active_match? string The `search_active_match` colour. Takes a CSS colour, such as "#e8a33d".
---@field black? string The `black` colour. Takes a CSS colour, such as "#e8a33d".
---@field red? string The `red` colour. Takes a CSS colour, such as "#e8a33d".
---@field green? string The `green` colour. Takes a CSS colour, such as "#e8a33d".
---@field yellow? string The `yellow` colour. Takes a CSS colour, such as "#e8a33d".
---@field blue? string The `blue` colour. Takes a CSS colour, such as "#e8a33d".
---@field magenta? string The `magenta` colour. Takes a CSS colour, such as "#e8a33d".
---@field cyan? string The `cyan` colour. Takes a CSS colour, such as "#e8a33d".
---@field white? string The `white` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_black? string The `bright_black` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_red? string The `bright_red` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_green? string The `bright_green` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_yellow? string The `bright_yellow` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_blue? string The `bright_blue` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_magenta? string The `bright_magenta` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_cyan? string The `bright_cyan` colour. Takes a CSS colour, such as "#e8a33d".
---@field bright_white? string The `bright_white` colour. Takes a CSS colour, such as "#e8a33d".

--- Key bindings, per context: key or sequence → action.
---@class roster.config.Keys : roster.o.Object
---@field leader? table<string, roster.config.KeyAction>|roster.o.Map After the Leader: key or sequence (chords separated by spaces: "d d") → key action.
---@field list? table<string, roster.config.KeyAction>|roster.o.Map In a list (the Sidebar): key or sequence (chords separated by spaces: "d d") → key action.
---@field list_vim? table<string, roster.config.KeyAction>|roster.o.Map In a list while vim keys are on: key or sequence (chords separated by spaces: "d d") → key action.
---@field picker? table<string, roster.config.KeyAction>|roster.o.Map In the Picker and every finder: key or sequence (chords separated by spaces: "d d") → key action.
---@field picker_vim? table<string, roster.config.KeyAction>|roster.o.Map In the Picker's list while vim keys are on: key or sequence (chords separated by spaces: "d d") → key action.
---@field cmdline? table<string, roster.config.KeyAction>|roster.o.Map In the : command line: key or sequence (chords separated by spaces: "d d") → key action.
---@field terminal? table<string, roster.config.KeyAction>|roster.o.Map In a terminal, before the shell sees the key: key or sequence (chords separated by spaces: "d d") → key action.
---@field global? table<string, roster.config.KeyAction>|roster.o.Map Everywhere, with no Leader (keep it to keys a shell doesn't use): key or sequence (chords separated by spaces: "d d") → key action.

--- A key action: the command line a key runs, or false to unbind a default.
---@alias roster.config.KeyAction string|false

--- Each view mode's layout.
---@class roster.config.Modes : roster.o.Object
---@field standard? roster.config.Mode The Standard mode's pieces; a piece left out keeps this mode's default.
---@field focus? roster.config.Mode The Focus mode's pieces; a piece left out keeps this mode's default.

--- The Standard mode's pieces; a piece left out keeps this mode's default.
---@class roster.config.Mode : roster.o.Object
---@field titlebar? boolean The title bar. Default: `true`.
---@field sidebar? boolean|roster.config.Sidebar The Sidebar: shown or hidden, the side it's on, and its sections. Default: `{ side = "left" }`. Takes true, false, or a table of the options below (which shows it).
---@field sessionbar? false|"bottom"|"top" The thin tmux-style bar of open Sessions, and its edge. Default: `false`.
---@field statusbar? boolean|string[]|roster.o.List The status bar, and its segments. Default: `true`. Takes true, false, or segments in order: "backend", "box", "session", "inventory", "hosts", "path", "changes", "hints", "mode". Each item once.
---@field fullscreen? boolean OS fullscreen. Default: `false`.
---@field toolbar? boolean|string[]|roster.o.List The controls for common commands, in the title bar (or a bar of their own without one). Default: `true`. Takes true, false, or controls in order: "sidebar", "find", "quick", "add", "changes", "publish", "details", "cmdline", "keys", "help", "lock", "mode", or a Plugin control's id. Each item once.

--- The Sidebar: shown or hidden, the side it's on, and its sections.
---@class roster.config.Sidebar : roster.o.Object
---@field side? "left"|"right" The side of the window it's on. Default: `"left"`.
---@field sections? string[]|roster.o.List Its sections, in order; all of them when left out. Takes section ids in order: "sessions", "folders", "inventory", or a Plugin section's id. Each item once.

--- What every panel and view starts with.
---@class roster.config.Panel : roster.o.Object
---@field width? integer A docked panel's width, for every panel and view views doesn't give one. Unset, each keeps its own. Takes 10 to 95 percent of the window.

--- A view spec: one panel's or view's default place and width.
---@class roster.config.View : roster.o.Object
---@field place? "panel"|"full" Docked beside the terminal, or over the whole window.
---@field width? integer Its docked width. Takes 10 to 95 percent of the window.

--- A Folder spec: a name and the Hosts in it.
---@class roster.config.Folder
---@field name string The Folder's name. Takes unique, ignoring case, with no double quote.
---@field hosts? string[] The Hosts in it, in order. Takes Host names. Each item once.

--- This Box's own vault settings, over roster.yml's providers. Paths and choices, never a secret.
---@class roster.config.Vault : roster.o.Object
---@field save_to? "personal"|{ organization: string, collection: string }|{ group: string } Where Save to vault puts a new password by default. Takes "personal", { organization = …, collection = … } (Bitwarden) or { group = … } (KeePassXC).
---@field kp? roster.config.KeePassXC KeePassXC's files, on the Box roster runs on.

--- KeePassXC's files, on the Box roster runs on.
---@class roster.config.KeePassXC : roster.o.Object
---@field database? string KeePassXC's .kdbx. Takes an absolute path, or one starting with ~.
---@field key_file? string A key file used with the database's master password. Takes an absolute path, or one starting with ~.

--- A Package spec: { SOURCE, tag = …, config = { … } }, or just SOURCE.
---@class roster.config.Package
---@field [1]? string The source, as the spec's first item.
---@field source? string Where the repo is: the spec's first item, or source = …. Takes "owner/repo" (GitHub), or a git URL: "https://…", "ssh://…", "git@host:path", "file://…" or a full path.
---@field name? string Its name (its folder and its line in roster.lock); the repo's (or dir's) name when left out.
---@field tag? string The tag to pin. At most one of tag, branch and commit; none means the default branch.
---@field branch? string The branch to follow.
---@field commit? string The commit to pin. Takes 4 to 40 hex digits.
---@field dir? string The repo's folder that holds the Plugin, when it isn't the top. Takes a folder inside the repo, relative, / between folders, no ...
---@field config? table Settings the Package reads as roster.plugin.config. Takes a table (never a function).

--- An option's dotted name, for roster.o.get, roster.o.reset and roster.set: one of these, or a name under a map's key ("views.files.width", "themes.paper.label").
---@alias roster.config.OptionName
---| "theme"
---| "dark_theme"
---| "light_theme"
---| "themes"
---| "colors"
---| "colors.accent"
---| "colors.accent_text"
---| "colors.accent_ink"
---| "colors.tone"
---| "colors.bg"
---| "colors.chrome"
---| "colors.sidebar"
---| "colors.panel"
---| "colors.raised"
---| "colors.raised_line"
---| "colors.hover"
---| "colors.line"
---| "colors.line_strong"
---| "colors.text"
---| "colors.muted"
---| "colors.faint"
---| "colors.warn"
---| "colors.error"
---| "colors.danger"
---| "colors.danger_text"
---| "colors.backdrop"
---| "colors.shadow"
---| "colors.syntax_keyword"
---| "colors.syntax_string"
---| "colors.syntax_number"
---| "colors.syntax_comment"
---| "colors.syntax_function"
---| "colors.syntax_punctuation"
---| "colors.syntax_key"
---| "colors.syntax_command"
---| "fonts"
---| "fonts.ui"
---| "fonts.mono"
---| "fonts.ui_size"
---| "ui"
---| "ui.hints"
---| "ui.messages"
---| "terminal"
---| "terminal.font"
---| "terminal.size"
---| "terminal.weight"
---| "terminal.bold_weight"
---| "terminal.bold_is_bright"
---| "terminal.line_height"
---| "terminal.cell_height"
---| "terminal.renderer"
---| "terminal.cursor_style"
---| "terminal.scrollback"
---| "terminal.copy_on_select"
---| "terminal.right_click_paste"
---| "terminal.osc52"
---| "terminal.colors"
---| "terminal.colors.background"
---| "terminal.colors.foreground"
---| "terminal.colors.cursor"
---| "terminal.colors.cursor_accent"
---| "terminal.colors.selection_background"
---| "terminal.colors.search_match"
---| "terminal.colors.search_active_match"
---| "terminal.colors.black"
---| "terminal.colors.red"
---| "terminal.colors.green"
---| "terminal.colors.yellow"
---| "terminal.colors.blue"
---| "terminal.colors.magenta"
---| "terminal.colors.cyan"
---| "terminal.colors.white"
---| "terminal.colors.bright_black"
---| "terminal.colors.bright_red"
---| "terminal.colors.bright_green"
---| "terminal.colors.bright_yellow"
---| "terminal.colors.bright_blue"
---| "terminal.colors.bright_magenta"
---| "terminal.colors.bright_cyan"
---| "terminal.colors.bright_white"
---| "terminal.shell_hooks"
---| "leader"
---| "vim"
---| "keys"
---| "keys.leader"
---| "keys.list"
---| "keys.list_vim"
---| "keys.picker"
---| "keys.picker_vim"
---| "keys.cmdline"
---| "keys.terminal"
---| "keys.global"
---| "default_mode"
---| "sessions"
---| "modes"
---| "modes.standard"
---| "modes.standard.titlebar"
---| "modes.standard.sidebar"
---| "modes.standard.sidebar.side"
---| "modes.standard.sidebar.sections"
---| "modes.standard.sessionbar"
---| "modes.standard.statusbar"
---| "modes.standard.fullscreen"
---| "modes.standard.toolbar"
---| "modes.focus"
---| "modes.focus.titlebar"
---| "modes.focus.sidebar"
---| "modes.focus.sidebar.side"
---| "modes.focus.sidebar.sections"
---| "modes.focus.sessionbar"
---| "modes.focus.statusbar"
---| "modes.focus.fullscreen"
---| "modes.focus.toolbar"
---| "panel"
---| "panel.width"
---| "views"
---| "folders"
---| "vault"
---| "vault.save_to"
---| "vault.kp"
---| "vault.kp.database"
---| "vault.kp.key_file"
---| "packages"
---| "plugin_proxy"
---| "idle_lock_minutes"
---| "pull_fresh_minutes"
---| "auto_reload"
---| "editor"
---| "backend"
---| "roster_command"
---| string

--- What roster.o gives for an object (a table of named options): its table, with these methods.
---@class roster.o.Object
local roster_o_Object = {}

--- A copy of what init.lua set in an object (a table of named options), or nil.
--- Defaults aren't in it: only what was set.
---
--- ```lua
--- local t = roster.o.terminal:get()
--- if t then print(t.size) end
--- ```
---@param self any
---@return table?
function roster_o_Object:get() end

--- Puts every option in an object back to its default.
---
--- ```lua
--- roster.o.terminal:reset()
--- ```
---@param self any
function roster_o_Object:reset() end

--- What roster.o gives for a map (a table keyed by names you pick): its table, with these methods.
---@class roster.o.Map
local roster_o_Map = {}

--- A copy of a map (a table keyed by names you pick): key → value, or nil when nothing is set.
--- Read one key with map.KEY; set one with map.KEY = value, remove it with map.KEY = nil.
---
--- ```lua
--- local views = roster.o.views:get() or {}
--- for id in pairs(views) do print(id) end
--- ```
---@param self any
---@return table?
function roster_o_Map:get() end

--- Whether init.lua set this key of a map.
--- A key named like a method (get, has, keys, reset) reads as that key once init.lua has set it, and as the method until then; roster.o.get(name) always reads and roster.o.reset(name) always resets.
---
--- ```lua
--- if not roster.o.views:has("topology") then roster.o.views.topology = { place = "panel" } end
--- ```
---@param self any
---@param key string A key.
---@return boolean
function roster_o_Map:has(key) end

--- The keys init.lua set in a map.
---
--- ```lua
--- for _, id in ipairs(roster.o.themes:keys()) do print(id) end
--- ```
---@param self any
---@return string[]
function roster_o_Map:keys() end

--- Takes away every key init.lua set in a map: it's back to its default.
---
--- ```lua
--- roster.o.views:reset()
--- ```
---@param self any
function roster_o_Map:reset() end

--- What roster.o gives for a list: its table, with these methods.
---@class roster.o.List
local roster_o_List = {}

--- A copy of a list, or nil when init.lua didn't set it.
---
--- ```lua
--- local fonts = roster.o.terminal.font:get()
--- if fonts then print(#fonts) end
--- ```
---@param self any
---@return any[]?
function roster_o_List:get() end

--- Adds items to the end of a list.
--- An unset list starts from its default. A list that takes each item once refuses one it has, at the line.
---
--- ```lua
--- roster.o.terminal.font:append("Fira Code")
--- ```
---@param self any
---@param ... any Items to add.
function roster_o_List:append(...) end

--- Adds items to the start of a list, in the order given.
--- As append.
---
--- ```lua
--- roster.o.terminal.font:prepend("Cascadia Mono")
--- ```
---@param self any
---@param ... any Items to add.
function roster_o_List:prepend(...) end

--- Puts an item at a position of a list.
--- A position outside the list is an error at the line.
---
--- ```lua
--- roster.o.terminal.font:insert(2, "Cascadia Mono")
--- ```
---@param self any
---@param i integer The position, from 1 to the list's length + 1.
---@param value any The item.
function roster_o_List:insert(i, value) end

--- Takes items out of a list.
--- An item it doesn't have is an error at the line.
---
--- ```lua
--- roster.o.terminal.font:remove("Iosevka Term")
--- ```
---@param self any
---@param ... any Items to take out (for folders and packages, a name will do).
function roster_o_List:remove(...) end

--- Whether a list has an item, its default counted while it's unset.
---
--- ```lua
--- if not roster.o.terminal.font:has("Hack") then roster.o.terminal.font:append("Hack") end
--- ```
---@param self any
---@param value any An item (for folders and packages, a name will do).
---@return boolean
function roster_o_List:has(value) end

--- Empties a list.
--- A list that needs an item (terminal.font) refuses to be empty, at the line.
---
--- ```lua
--- roster.o.folders:clear()
--- ```
---@param self any
function roster_o_List:clear() end

--- Puts a list back to its default.
---
--- ```lua
--- roster.o.terminal.font:reset()
--- ```
---@param self any
function roster_o_List:reset() end

--- init.lua's `roster` table. A Plugin's is another one (types/roster.lua).
roster = {}

--- The OS the app runs on.
--- Read-only.
---
--- ```lua
--- if roster.os == "windows" then
---   roster.o.backend = "wsl"
--- end
--- ```
---@type "windows"|"linux"|"macos"
roster.os = nil

--- The Plugin API's version, which init.lua's table shows too.
--- Read-only. It rises when only the Plugin API changes, so it doesn't tell what init.lua has: roster.config_version does.
---
--- ```lua
--- print("Plugin API " .. roster.api_version)
--- ```
---@type integer
roster.api_version = nil

--- init.lua's own version: 4 is v0.3.0's (roster.o and the collections' functions).
--- Read-only. It rises when a name is removed or renamed, or keeps its name but takes, gives or does something else; not for a new name (check that it isn't nil) and not for a Plugin API change. For the rare case a name can't tell. An app from before it (v0.4.0 and older) reads it as nil.
---
--- ```lua
--- if (roster.config_version or 0) >= 4 then
---   roster.o.terminal.size = "16pt"
--- else
---   roster.set("terminal.size", "16pt")
--- end
--- ```
---@type integer
roster.config_version = nil

--- The app's version.
--- Read-only.
---
--- ```lua
--- if roster.version:match("^0%.2") then roster.o.auto_reload = true end
--- ```
---@type string
roster.version = nil

--- The config folder: where init.lua is, as this machine writes the path.
--- Read-only. For messages and comparisons; require already looks there.
---
--- ```lua
--- print("Config in " .. roster.config_dir)
--- ```
---@type string
roster.config_dir = nil

--- Every option, as a table you assign to and read: roster.o.terminal.size = "16pt".
--- Nested objects need no setup. An unknown name is an error at its line, with the name meant; a value of the wrong type too. Reading an option gives the value set so far (a copy), or nil; reading an object, a map or a list gives its table, with the methods its kind has (roster.o.Object, roster.o.Map, roster.o.List). Assigning a whole table replaces that branch; assigning one roster.o table to another option copies what it holds (what init.lua set, else its default), and one that holds neither is an error. The table init.lua returns, if any, wins over what roster.o sets.
---
--- ```lua
--- roster.o.terminal.size = "16pt"
--- roster.o.terminal.font:prepend("Cascadia Mono")
--- if roster.o.vim then roster.o.keys.leader.p = "connect esx-02" end
--- ```
---@class roster.o : roster.config.Options
roster.o = {}

--- Reads any option by its dotted name: a copy of what init.lua set there, or nil.
--- The read that always works: a map's key named like a method (get, has, keys, reset) reads as that key here, set or not. A table comes back as a plain copy, to walk with pairs(). An unknown name is an error at its line. A map's key that holds a dot can't be named with dots ("keys.leader.." is an unknown name): read it with brackets, the key as a string, as the example's last line does.
---
--- ```lua
--- local views = roster.o.get("views") or {}
--- for id in pairs(views) do print(id) end
--- print(roster.o.keys.leader["."]) -- a key that is a dot
--- ```
---@param name roster.config.OptionName An option's dotted name: "terminal.size", "views.get".
---@return any
function roster.o.get(name) end

--- Puts an option back to its default: what init.lua set there is taken away.
--- Any option: a value, an object, a map or a list. An unknown name is an error at its line. A map's key that holds a dot can't be named with dots: take it away with brackets, the key as a string, set to nil, as the example's last line does.
---
--- ```lua
--- roster.o.reset("terminal.size")
--- roster.o.keys.leader["."] = nil -- a key that is a dot
--- ```
---@param name roster.config.OptionName An option's dotted name: "terminal.size".
function roster.o.reset(name) end

--- Sets any option by its dotted name, as roster.o does.
--- The same store as roster.o: the last write wins. The name and the value are checked at the call's line. The returned table wins over a call that sets the same option. A map's key that holds a dot can't be named with dots: set it through roster.o with brackets, the key as a string, as the example's last line does.
---
--- ```lua
--- roster.set("terminal.size", "16pt")
--- roster.o.keys.leader["."] = "connect esx-02" -- a key that is a dot
--- ```
---@param name roster.config.OptionName An option's dotted name: "terminal.size".
---@param value any Its value, as the option takes it; nil resets it.
function roster.set(name, value) end

roster.keymap = {}

--- Binds a key, as keys.<context> does.
--- A later set of the same keys replaces it. An unknown context is an error at its line.
---
--- ```lua
--- roster.keymap.set("leader", "p", "connect esx-02")
--- ```
---@param context "leader"|"list"|"list_vim"|"picker"|"picker_vim"|"cmdline"|"terminal"|"global" The keymap's context.
---@param keys string A chord or a sequence of chords separated by spaces: "Ctrl+n", "d d".
---@param action roster.config.KeyAction A command line, or false to unbind a default.
function roster.keymap.set(context, keys, action) end

--- Takes off a key binding init.lua made.
--- Keys init.lua didn't bind are an error at the line; to unbind one of roster's own, set it to false.
---
--- ```lua
--- roster.keymap.del("leader", "p")
--- ```
---@param context "leader"|"list"|"list_vim"|"picker"|"picker_vim"|"cmdline"|"terminal"|"global" The keymap's context.
---@param keys string The keys, as set took them.
function roster.keymap.del(context, keys) end

--- The action init.lua bound to keys, or nil.
--- Roster's own bindings aren't in it.
---
--- ```lua
--- if not roster.keymap.get("leader", "p") then roster.keymap.set("leader", "p", "close") end
--- ```
---@param context "leader"|"list"|"list_vim"|"picker"|"picker_vim"|"cmdline"|"terminal"|"global" The keymap's context.
---@param keys string The keys, as set took them.
---@return roster.config.KeyAction?
function roster.keymap.get(context, keys) end

--- Whether init.lua bound keys in a context.
--- A binding to false (one of roster's own taken off) counts: del takes it off. Roster's own bindings don't.
---
--- ```lua
--- if not roster.keymap.has("leader", "p") then roster.keymap.set("leader", "p", "close") end
--- ```
---@param context "leader"|"list"|"list_vim"|"picker"|"picker_vim"|"cmdline"|"terminal"|"global" The keymap's context.
---@param keys string The keys, as set took them.
---@return boolean
function roster.keymap.has(context, keys) end

--- A copy of init.lua's bindings in a context: keys → action.
--- An empty table when it binds none there.
---
--- ```lua
--- for keys, action in pairs(roster.keymap.list("leader")) do print(keys, action) end
--- ```
---@param context "leader"|"list"|"list_vim"|"picker"|"picker_vim"|"cmdline"|"terminal"|"global" The keymap's context.
---@return table<string, roster.config.KeyAction>
function roster.keymap.list(context) end

roster.themes = {}

--- Defines a Theme, as themes.<id> does.
--- An id already defined is an error naming both lines (change it with update); a bundled Theme's id too.
---
--- ```lua
--- roster.themes.define("paper", { appearance = "light", colors = { accent = "#b85c00" } })
--- ```
---@param id string The Theme's id: not "auto", not a bundled Theme's.
---@param theme roster.config.Theme A Theme spec.
function roster.themes.define(id, theme) end

--- Changes a Theme: one init.lua defined, or a bundled one (which becomes a changed copy of itself).
--- An id that is neither is an error at its line.
---
--- ```lua
--- roster.themes.update("nord", { colors = { accent = "#88c0d0" } })
--- ```
---@param id string A Theme init.lua defined, or a bundled one.
---@param fields roster.config.Theme What to change: tables (colors, terminal, ansi) merge token by token.
function roster.themes.update(id, fields) end

--- Removes a Theme init.lua defined (or its changes to a bundled one).
--- A bundled Theme init.lua didn't change, or an id it doesn't have, is an error at its line.
---
--- ```lua
--- roster.themes.remove("paper")
--- ```
---@param id string A Theme init.lua defined.
function roster.themes.remove(id) end

--- A copy of init.lua's spec for a Theme, or nil.
--- Nil for a bundled Theme init.lua didn't change.
---
--- ```lua
--- local paper = roster.themes.get("paper")
--- if paper then print(paper.label) end
--- ```
---@param id string A Theme's id.
---@return roster.config.Theme?
function roster.themes.get(id) end

--- Whether there's a Theme by that id: a bundled one or init.lua's.
--- As list names them; get says whether init.lua has a spec of its own for it.
---
--- ```lua
--- if not roster.themes.has("paper") then roster.themes.define("paper", { appearance = "light" }) end
--- ```
---@param id string A Theme's id.
---@return boolean
function roster.themes.has(id) end

--- Every Theme's id: the bundled ones, then init.lua's.
---
--- ```lua
--- for _, id in ipairs(roster.themes.list()) do print(id) end
--- ```
---@return string[]
function roster.themes.list() end

roster.packages = {}

--- Adds Packages, from any file of the Config.
--- Two Packages with the same name are an error naming both lines. Fetching is a command: :packages update.
---
--- ```lua
--- roster.packages.add({ "someone/recent-alerts", tag = "v1.2.0" }, "someone/pinned")
--- ```
---@param ... string|roster.config.Package Package specs: { SOURCE, tag = … } or just SOURCE.
function roster.packages.add(...) end

--- Takes a Package out of the Config.
--- A name it doesn't have is an error at its line. Its folder stays until :packages clean.
---
--- ```lua
--- roster.packages.remove("recent-alerts")
--- ```
---@param name string Its name (letter case aside).
function roster.packages.remove(name) end

--- Changes a Package's spec: pin a tag, change its config.
--- A name it doesn't have, or a field a Package spec doesn't have, is an error at its line.
---
--- ```lua
--- roster.packages.update("recent-alerts", { tag = "v1.3.0" })
--- ```
---@param name string Its name (letter case aside).
---@param fields roster.config.Package Fields to set over the spec's; a tag, branch or commit replaces the other two.
function roster.packages.update(name, fields) end

--- A copy of a Package's spec, or nil.
--- Its source is in source.
---
--- ```lua
--- local alerts = roster.packages.get("recent-alerts")
--- if alerts then print(alerts.tag) end
--- ```
---@param name string Its name (letter case aside).
---@return roster.config.Package?
function roster.packages.get(name) end

--- Copies of every Package's spec, in order.
---
--- ```lua
--- for _, p in ipairs(roster.packages.list()) do print(p.source) end
--- ```
---@return roster.config.Package[]
function roster.packages.list() end

--- Whether the Config has a Package by that name.
---
--- ```lua
--- if not roster.packages.has("pinned") then roster.packages.add("someone/pinned") end
--- ```
---@param name string Its name (letter case aside).
---@return boolean
function roster.packages.has(name) end

roster.folders = {}

--- Adds Folders, from any file of the Config.
--- Two Folders with the same name (letter case aside) are an error naming both lines.
---
--- ```lua
--- roster.folders.add({ name = "Lab", hosts = { "esx-02", "esx-03" } })
--- ```
---@param ... roster.config.Folder Folder specs: { name = …, hosts = { … } }.
function roster.folders.add(...) end

--- Takes a Folder out of the Config.
--- A name it doesn't have is an error at its line.
---
--- ```lua
--- roster.folders.remove("Lab")
--- ```
---@param name string Its name (letter case aside).
function roster.folders.remove(name) end

--- Changes a Folder: rename it, or give it other Hosts.
--- A name it doesn't have is an error at its line; a new name another Folder has names both lines.
---
--- ```lua
--- roster.folders.update("Lab", { name = "Lab boxes" })
--- ```
---@param name string Its name (letter case aside).
---@param fields roster.config.Folder Fields to set over the Folder's: name, hosts.
function roster.folders.update(name, fields) end

--- A copy of a Folder's spec, or nil.
---
--- ```lua
--- local lab = roster.folders.get("Lab")
--- if lab then print(#lab.hosts) end
--- ```
---@param name string Its name (letter case aside).
---@return roster.config.Folder?
function roster.folders.get(name) end

--- Copies of every Folder's spec, in order.
---
--- ```lua
--- for _, f in ipairs(roster.folders.list()) do print(f.name) end
--- ```
---@return roster.config.Folder[]
function roster.folders.list() end

--- Whether the Config has a Folder by that name.
---
--- ```lua
--- if roster.folders.has("Lab") then roster.folders.add_hosts("Lab", "esx-04") end
--- ```
---@param name string Its name (letter case aside).
---@return boolean
function roster.folders.has(name) end

--- Adds Hosts to the end of a Folder.
--- A Host it has already, or a Folder it doesn't have, is an error at its line.
---
--- ```lua
--- roster.folders.add_hosts("Lab", { "esx-04", "esx-05" })
--- ```
---@param name string Its name (letter case aside).
---@param hosts string|string[] A Host's name, or a list of them.
function roster.folders.add_hosts(name, hosts) end

--- Takes Hosts out of a Folder.
--- A Host it doesn't have, or a Folder it doesn't have, is an error at its line.
---
--- ```lua
--- roster.folders.remove_hosts("Lab", "esx-05")
--- ```
---@param name string Its name (letter case aside).
---@param hosts string|string[] A Host's name, or a list of them.
function roster.folders.remove_hosts(name, hosts) end

return roster
