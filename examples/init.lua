-- The roster app's Config: init.lua (ADR 0004, docs/app/config.md).
--
-- Copy this file to
--   Windows: %APPDATA%\roster\init.lua
--   Linux:   $XDG_CONFIG_HOME/roster/init.lua   (~/.config/roster/init.lua)
-- (A Config in the old roster-desk folder is copied there once, the first time the app starts.)
-- and change what you like. It's plain Lua 5.4, written the way Neovim's init.lua is: each line
-- sets one option through `roster.o`, and anything you leave out keeps its default. Every value
-- below IS the default, unless a comment says otherwise, so deleting a line changes nothing.
--
-- :source (Leader S) applies it; saving alone doesn't, unless auto_reload = true below. A mistake
-- (a Lua error, or a name or value the app doesn't know) shows a message with the file and line,
-- and the last good Config stays in use.
--
-- :help options has every option (:help terminal.size for one), :options shows what each is now
-- and which line set it, and :config types gives your editor completion for all of this.
--
-- Big Configs split into modules, as in Neovim: `require("myconf.keys")` loads lua/myconf/keys.lua
-- from this folder (examples/init-split in the roster repo is a whole one). An older Config that
-- returns a table still loads; what that table sets wins over these lines.
--
-- The Lua here runs in a sandbox: no io, no os.execute or os.getenv, no debug, no C modules, and
-- `require` loads only files from this folder. It never sees a password: the app's core holds
-- none (docs/app/security.md).

-- `roster` is the app's Lua table (also `require("roster")`):
--   roster.o.NAME = value                  any option (this file is all roster.o lines)
--   roster.keymap.set(context, keys, action) a key binding
--   roster.themes.define(id, theme)        a Theme; roster.themes.update(id, fields) changes one
--   roster.packages.add(spec, ...)         Packages; roster.folders.add(folder, ...) Folders
--   roster.os, roster.version              "windows", "linux" or "macos"; the app's version
-- Logic is fine: if roster.os == "windows" then roster.o.terminal.font = "Cascadia Mono" end

-- Themes -------------------------------------------------------------------------------------------
-- "auto" follows the OS light/dark setting with dark_theme and light_theme. Or name a Theme: the
-- bundled ones are "roster-dark", "roster-light", "gruvbox", "nord", "catppuccin-mocha" and
-- "tokyo-night", and any you define below.
roster.o.theme = "auto"
roster.o.dark_theme = "roster-dark"
roster.o.light_theme = "roster-light"

-- New Themes (not defaults: examples). Each starts from `base` (default: roster-dark, or
-- roster-light when appearance = "light") and changes only what it sets. Pick one with
-- roster.o.theme = "roster-ember". roster.themes.update("nord", { … }) changes a bundled one.
roster.themes.define("roster-ember", {
  label = "Roster ember",
  base = "roster-dark",
  colors = { accent = "#e0803a", accent_ink = "#f0a060" },
})
roster.themes.define("paper", {
  label = "Paper",
  appearance = "light", -- "dark" or "light": which OS setting it suits under theme = "auto"
  base = "roster-light",
  colors = { accent = "#3a6ee0", bg = "#fbfaf7" }, -- any UI token (`colors` below)
  terminal = { background = "#fbfaf7", foreground = "#202020" }, -- see terminal.colors below
  -- The terminal's 16 colours: a table of them, false for the standard palette, or leave it out
  -- to keep the base's.
  ansi = false,
})

-- Colour tokens set over whichever Theme is in use. Every token:
--   accent, accent_text, accent_ink, tone, bg, chrome, sidebar, panel, raised, raised_line,
--   hover, line, line_strong, text, muted, faint, warn, error, danger, danger_text, backdrop,
--   shadow
-- and code's colours in help and the docs website:
--   syntax_keyword, syntax_string, syntax_number, syntax_comment, syntax_function,
--   syntax_punctuation, syntax_key, syntax_command
-- roster.o.colors.accent = "#e0803a"

-- Fonts --------------------------------------------------------------------------------------------
-- A family name, or a whole CSS font stack (anything with a comma is used as it is).
-- Inter and Iosevka ship with the app.
roster.o.fonts.ui = "Inter"
roster.o.fonts.mono = "Iosevka" -- the wordmark and code-like text in the UI
roster.o.fonts.ui_size = 15 -- px, 11 to 20: the UI's text (Sidebar, Picker, panels)

-- The UI -------------------------------------------------------------------------------------------
-- The keycap hints (status bar, empty states, panels, Picker footers, menus). Unset, `:hints
-- on|off|toggle` decides and the app remembers it; set here, it wins. The keys work either way.
-- roster.o.ui.hints = false
-- The message line, as Neovim's: "quiet" shows errors, warnings and answers; "all" also routine
-- confirmations and tips. Unset, `:messages all|quiet|toggle` decides (quiet until then).
-- roster.o.ui.messages = "all"

-- Panels and views ---------------------------------------------------------------------------------
-- Every panel (help, Host details, the forms, :plugins) and every Plugin view can be docked beside
-- the terminal at any width, or full window: Leader z, Leader < and Leader >, its header's button,
-- or a drag of its edge. What you choose is remembered per panel and wins over these defaults;
-- :panel reset forgets it.
-- roster.o.panel.width = 35 -- a docked panel's width, in percent of the window (10 to 95)
-- Per panel or view id: where it starts ("panel" or "full") and its docked width. Built-in ids:
-- help, details, edit, add, save, changes, plugins, packages, keys, check; a Plugin's view by its
-- id (:view lists them).
-- roster.o.views.topology = { place = "panel", width = 60 }
-- roster.o.views.help = { place = "full" }

-- The terminal -------------------------------------------------------------------------------------
-- Font families, most wanted first: the first one installed is used, and the bundled Iosevka (no
-- Nerd Font icons) is always there. A name, a CSS stack, or a list. A list has list functions:
-- roster.o.terminal.font:prepend("Cascadia Mono") keeps these after it.
roster.o.terminal.font = { "Iosevka Nerd Font", "Iosevka Term", "Iosevka" }
-- A number is px; "16pt" is points, as Windows Terminal counts them (16 pt = 21.33 px at any
-- display scale). 6 to 72 px. Ctrl+= / Ctrl+- zoom, Ctrl+0 comes back here.
roster.o.terminal.size = "13pt"
roster.o.terminal.weight = 500 -- 100 to 900; the bundled Iosevka ships at 400, 500 and 700
roster.o.terminal.bold_weight = 700
roster.o.terminal.bold_is_bright = true -- bold text in the bright ANSI colours too
roster.o.terminal.line_height = 1.0 -- a multiple of the font's own line height, 0.5 to 3
-- roster.o.terminal.cell_height = 1.2 -- or of the font size, as Windows Terminal's (wins)
roster.o.terminal.scrollback = 10000 -- lines, at most 1000000
roster.o.terminal.copy_on_select = true
roster.o.terminal.right_click_paste = true -- copies the selection, or pastes when there's none
roster.o.terminal.osc52 = true -- a program (Claude Code, vim, tmux) may set the clipboard: write only
-- "webgl" (fast) or "dom" (the browser's own text rendering: closer to Windows Terminal's
-- ClearType, slower with a lot of output). docs/app/config.md compares them.
roster.o.terminal.renderer = "webgl"
roster.o.terminal.cursor_style = "block" -- "block", "bar" or "underline"
-- Over the Theme's: background, foreground, cursor, cursor_accent, selection_background,
-- search_match, search_active_match, and the 16 ANSI colours: black, red, green, yellow, blue,
-- magenta, cyan, white, bright_black, bright_red, bright_green, bright_yellow, bright_blue,
-- bright_magenta, bright_cyan, bright_white.
-- roster.o.terminal.colors.background = "#101010"
-- Send each Session's shell one line after login that turns on its prompt marks (OSC 133) and
-- folder (OSC 7) in that shell only, never in its rc files (:help shell-hooks). Unset: a Host's
-- `shell_hooks: true` in roster.yml decides; true: every Session but a Host's
-- `shell_hooks: false`; false: none.
-- roster.o.terminal.shell_hooks = true

-- Keys ---------------------------------------------------------------------------------------------
-- The chord that takes the keyboard back from a terminal (App mode). Written as "Ctrl+Space",
-- "ctrl+b", "C-b" or "<C-b>"; it should have Ctrl, Alt or Meta.
roster.o.leader = "Ctrl+Space"
roster.o.vim = true -- j/k/h/l/gg/G in lists and the Picker

-- Key bindings: roster.keymap.set(context, keys, action). An action is a command line, exactly
-- what you'd type after `:` ("close", "session 1", "finder sessions"); false unbinds a default.
-- Contexts: leader (after the Leader), list and list_vim (the Sidebar), picker and picker_vim,
-- cmdline (the `:` line), terminal (before the shell sees the key), global (everywhere, no
-- Leader; keep it to keys a shell doesn't use). The Key bindings panel (Leader K) lists every
-- binding and where it comes from.
-- roster.keymap.set("leader", "t", "next")       -- Leader t: the next Session
-- roster.keymap.set("leader", "d d", false)      -- unbind Leader d d
-- roster.keymap.set("global", "F12", "keys")

-- Layout -------------------------------------------------------------------------------------------
roster.o.default_mode = "standard" -- the view mode at start: "standard" or "focus" (Leader m, F11)
roster.o.sessions = "sidebar" -- open Sessions in the Sidebar, or "tabs" for a tab strip

-- Each view mode's pieces. Any piece can be turned off in any mode; a piece left out keeps that
-- mode's default.
--   titlebar   true / false
--   sidebar    false, true, or { side = "left" | "right", sections = { "sessions", "folders", "inventory" } }
--              (sections picks and orders them; leave it out for all). Leader e shows or hides it.
--   sessionbar false, "bottom" or "top": the thin tmux-style bar of open Sessions
--   statusbar  false, true (all), or a list of segments in order: "backend", "box",
--              "session", "inventory", "hosts", "path", "changes", "hints", "mode" (the last two sit
--              on the right).
--              Leader s shows or hides it (in Focus, the session bar).
--   toolbar    the title bar's controls: false, true (the default set), or a list in order from
--              "sidebar", "find", "quick", "add", "changes", "publish", "details", "cmdline",
--              "keys", "help", "lock", "mode".
--   fullscreen OS fullscreen
roster.o.modes.standard.fullscreen = false
roster.o.modes.standard.titlebar = true
roster.o.modes.standard.sidebar = { side = "left" }
roster.o.modes.standard.sessionbar = false
roster.o.modes.standard.statusbar = true -- a list instead: { "backend", "hosts", "mode" }
roster.o.modes.standard.toolbar = true

roster.o.modes.focus.fullscreen = true
roster.o.modes.focus.titlebar = false
roster.o.modes.focus.sidebar = false -- Focus reaches the tree with Leader e as a finder instead
roster.o.modes.focus.sessionbar = false -- e.g. "bottom"
roster.o.modes.focus.statusbar = false
roster.o.modes.focus.toolbar = false

-- Folders ------------------------------------------------------------------------------------------
-- Personal groupings of Hosts in the Sidebar. These show first, marked "from init.lua", and can
-- only be changed here; Folders made in the app are kept by the app.
-- roster.folders.add({ name = "Lab ESXi", hosts = { "esx-02", "esx-03" } })

-- The vault ----------------------------------------------------------------------------------------
-- This Box's own vault settings. They win over roster.yml's providers: (the team's), and reach
-- roster when the app starts and on every :source. Paths are on the Box roster runs on (inside WSL
-- for a WSL backend): absolute, or starting with ~. Never a password.
-- Where "Save to vault" (the add-Host form) puts a new password by default: "personal",
-- { organization = "My Team", collection = "Infra logins" } (Bitwarden, names or ids), or
-- { group = "Hosts" } (KeePassXC). The form can still pick another.
-- roster.o.vault.save_to = "personal"
-- roster.o.vault.kp.database = "~/roster.kdbx" -- KeePassXC's .kdbx (wins over providers: kp:)
-- roster.o.vault.kp.key_file = "~/roster.keyx" -- a key file used with its master password

-- Packages -----------------------------------------------------------------------------------------
-- Plugins from git repos, as lazy.nvim does it: fetched into the app's data folder, asked about
-- before they run, and pinned in roster.lock next to this file (keep it with your dotfiles).
-- :packages lists them, :packages update shows what's new first, :packages clean removes the ones
-- taken out of here. config is the settings a Package reads (roster.plugin.config).
-- roster.packages.add({ "someone/recent-alerts", tag = "v1.0.0", config = { patterns = { "ERROR", "panic" } } })
-- roster.packages.add("https://git.example.com/team/roster-extras.git")
-- The proxy Plugins' requests to public names go through, on a network that only leaves by one.
-- roster.o.plugin_proxy = "http://10.0.0.5:3128"

-- Other --------------------------------------------------------------------------------------------
roster.o.idle_lock_minutes = 15 -- lock after this many minutes without input (1 to 1440)
-- A form that writes roster.yml (:edit, :host add, Save to vault) opens at once and pulls the
-- infra repo in the background when the last pull is older than this; 0 pulls every time.
roster.o.pull_fresh_minutes = 5

-- What :config opens this file with: "os" (the app Windows or your desktop opens .lua files with;
-- Notepad if there's none), or "wsl" ($EDITOR inside the Backend's WSL distro, vi if it's unset,
-- in a console window of its own). :config path says where this file is.
roster.o.editor = "os"
-- Reload on every save of this file (or a module it requires). Off, as in Neovim: :source
-- (Leader S) reloads, and the status bar says when a save isn't applied yet.
roster.o.auto_reload = false

-- Which roster runs. Changing it and reloading (:source) starts roster serve again.
-- "auto" detects it: on Windows, roster on Windows itself if it has an Inventory, else the default
-- WSL distro, then running ones. "local" is roster on this machine (on Windows, the one installed
-- on Windows). "wsl" is WSL's; "wsl:<distro>" uses that distro.
-- The ROSTER_APP_WSL_DISTRO env var wins over this.
roster.o.backend = "auto"
-- The command that runs roster, for development: a command line or a list of words. The
-- ROSTER_APP_ROSTER env var wins over this. Leave it out for "roster". It must run roster itself
-- ("roster", a path to it, or "uv run --project <dir> roster"): it gets the master password. For
-- any other wrapper, set ROSTER_APP_ROSTER instead (docs/app/config.md).
-- roster.o.roster_command = "uv run --project /home/you/work/roster roster"
