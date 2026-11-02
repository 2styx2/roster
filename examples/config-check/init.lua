-- Generated from crates/roster-core/src/config/shape by `cargo run -p roster-core --example gen_config_options`: every example in
-- the option reference, for lua-language-server to check against examples/types/roster-config.lua
-- (CI runs `lua-language-server --check examples/config-check --checklevel=Hint`).

-- roster.os
do
  if roster.os == "windows" then
    roster.o.backend = "wsl"
  end
end

-- roster.api_version
do
  if roster.api_version >= 4 then roster.o.vim = false end
end

-- roster.version
do
  if roster.version:match("^0%.2") then roster.o.auto_reload = true end
end

-- roster.config_dir
do
  print("Config in " .. roster.config_dir)
end

-- roster.o
do
  roster.o.terminal.size = "16pt"
  roster.o.terminal.font:prepend("Cascadia Mono")
  if roster.o.vim then roster.o.keys.leader.p = "connect esx-02" end
end

-- roster.o.reset
do
  roster.o.reset("terminal.size")
end

-- roster.set
do
  roster.set("terminal.size", "16pt")
end

-- roster.keymap.set
do
  roster.keymap.set("leader", "p", "connect esx-02")
end

-- roster.keymap.del
do
  roster.keymap.del("leader", "p")
end

-- roster.keymap.get
do
  if not roster.keymap.get("leader", "p") then roster.keymap.set("leader", "p", "close") end
end

-- roster.keymap.list
do
  for keys, action in pairs(roster.keymap.list("leader")) do print(keys, action) end
end

-- roster.themes.define
do
  roster.themes.define("paper", { appearance = "light", colors = { accent = "#b85c00" } })
end

-- roster.themes.update
do
  roster.themes.update("nord", { colors = { accent = "#88c0d0" } })
end

-- roster.themes.remove
do
  roster.themes.remove("paper")
end

-- roster.themes.get
do
  local paper = roster.themes.get("paper")
  if paper then print(paper.label) end
end

-- roster.themes.list
do
  for _, id in ipairs(roster.themes.list()) do print(id) end
end

-- roster.packages.add
do
  roster.packages.add({ "someone/recent-alerts", tag = "v1.2.0" }, "someone/pinned")
end

-- roster.packages.remove
do
  roster.packages.remove("recent-alerts")
end

-- roster.packages.update
do
  roster.packages.update("recent-alerts", { tag = "v1.3.0" })
end

-- roster.packages.get
do
  local alerts = roster.packages.get("recent-alerts")
  if alerts then print(alerts.tag) end
end

-- roster.packages.list
do
  for _, p in ipairs(roster.packages.list()) do print(p.source) end
end

-- roster.packages.has
do
  if not roster.packages.has("pinned") then roster.packages.add("someone/pinned") end
end

-- roster.folders.add
do
  roster.folders.add({ name = "Lab", hosts = { "esx-02", "esx-03" } })
end

-- roster.folders.remove
do
  roster.folders.remove("Lab")
end

-- roster.folders.update
do
  roster.folders.update("Lab", { name = "Lab boxes" })
end

-- roster.folders.get
do
  local lab = roster.folders.get("Lab")
  if lab then print(#lab.hosts) end
end

-- roster.folders.list
do
  for _, f in ipairs(roster.folders.list()) do print(f.name) end
end

-- roster.folders.has
do
  if roster.folders.has("Lab") then roster.folders.add_hosts("Lab", "esx-04") end
end

-- roster.folders.add_hosts
do
  roster.folders.add_hosts("Lab", { "esx-04", "esx-05" })
end

-- roster.folders.remove_hosts
do
  roster.folders.remove_hosts("Lab", "esx-05")
end

-- roster.o.Object:get
do
  local t = roster.o.terminal:get()
  if t then print(t.size) end
end

-- roster.o.Object:reset
do
  roster.o.terminal:reset()
end

-- roster.o.Map:get
do
  local views = roster.o.views:get() or {}
  for id in pairs(views) do print(id) end
end

-- roster.o.Map:has
do
  if not roster.o.views:has("topology") then roster.o.views.topology = { place = "panel" } end
end

-- roster.o.Map:keys
do
  for _, id in ipairs(roster.o.themes:keys()) do print(id) end
end

-- roster.o.Map:reset
do
  roster.o.views:reset()
end

-- roster.o.List:get
do
  local fonts = roster.o.terminal.font:get()
  if fonts then print(#fonts) end
end

-- roster.o.List:append
do
  roster.o.terminal.font:append("Fira Code")
end

-- roster.o.List:prepend
do
  roster.o.terminal.font:prepend("Cascadia Mono")
end

-- roster.o.List:insert
do
  roster.o.modes.standard.sidebar.sections:insert(1, "folders")
end

-- roster.o.List:remove
do
  roster.o.terminal.font:remove("Iosevka Term")
end

-- roster.o.List:has
do
  if not roster.o.terminal.font:has("Hack") then roster.o.terminal.font:append("Hack") end
end

-- roster.o.List:clear
do
  roster.o.terminal.font:clear()
end

-- roster.o.List:reset
do
  roster.o.terminal.font:reset()
end

-- theme
do
  roster.o.theme = "nord"
end

-- dark_theme
do
  roster.o.dark_theme = "tokyo-night"
end

-- light_theme
do
  roster.o.light_theme = "paper"
end

-- themes
do
  roster.o.themes = { paper = { appearance = "light", colors = { accent = "#b85c00" } } }
end

-- colors
do
  roster.o.colors = { accent = "#e8a33d" }
end

-- fonts
do
  roster.o.fonts = { ui = "IBM Plex Sans" }
end

-- fonts.ui
do
  roster.o.fonts.ui = "IBM Plex Sans"
end

-- fonts.mono
do
  roster.o.fonts.mono = "JetBrains Mono"
end

-- fonts.ui_size
do
  roster.o.fonts.ui_size = 16
end

-- ui
do
  roster.o.ui = { hints = false }
end

-- ui.hints
do
  roster.o.ui.hints = false
end

-- ui.messages
do
  roster.o.ui.messages = "all"
end

-- terminal
do
  roster.o.terminal = { font = { "Fira Code", "Iosevka" } }
end

-- terminal.font
do
  roster.o.terminal.font = { "Fira Code", "Iosevka" }
end

-- terminal.size
do
  roster.o.terminal.size = "16pt"
end

-- terminal.weight
do
  roster.o.terminal.weight = 400
end

-- terminal.bold_weight
do
  roster.o.terminal.bold_weight = 800
end

-- terminal.bold_is_bright
do
  roster.o.terminal.bold_is_bright = false
end

-- terminal.line_height
do
  roster.o.terminal.line_height = 1.2
end

-- terminal.cell_height
do
  roster.o.terminal.cell_height = 1.1
end

-- terminal.renderer
do
  roster.o.terminal.renderer = "dom"
end

-- terminal.cursor_style
do
  roster.o.terminal.cursor_style = "bar"
end

-- terminal.scrollback
do
  roster.o.terminal.scrollback = 50000
end

-- terminal.copy_on_select
do
  roster.o.terminal.copy_on_select = false
end

-- terminal.right_click_paste
do
  roster.o.terminal.right_click_paste = false
end

-- terminal.colors
do
  roster.o.terminal.colors = { background = "#101418", red = "#e06c75" }
end

-- terminal.shell_hooks
do
  roster.o.terminal.shell_hooks = true
end

-- leader
do
  roster.o.leader = "Ctrl+b"
end

-- vim
do
  roster.o.vim = false
end

-- keys
do
  roster.o.keys = { leader = { ["d d"] = "close", ["Ctrl+n"] = false } }
end

-- keys.leader
do
  roster.o.keys.leader = { ["d d"] = "close", ["Ctrl+n"] = false }
end

-- keys.list
do
  roster.o.keys.list = { ["d d"] = "close", ["Ctrl+n"] = false }
end

-- keys.list_vim
do
  roster.o.keys.list_vim = { ["d d"] = "close", ["Ctrl+n"] = false }
end

-- keys.picker
do
  roster.o.keys.picker = { ["d d"] = "close", ["Ctrl+n"] = false }
end

-- keys.picker_vim
do
  roster.o.keys.picker_vim = { ["d d"] = "close", ["Ctrl+n"] = false }
end

-- keys.cmdline
do
  roster.o.keys.cmdline = { ["d d"] = "close", ["Ctrl+n"] = false }
end

-- keys.terminal
do
  roster.o.keys.terminal = { ["d d"] = "close", ["Ctrl+n"] = false }
end

-- keys.global
do
  roster.o.keys.global = { ["d d"] = "close", ["Ctrl+n"] = false }
end

-- default_mode
do
  roster.o.default_mode = "focus"
end

-- sessions
do
  roster.o.sessions = "tabs"
end

-- modes
do
  roster.o.modes = { standard = { titlebar = false } }
end

-- modes.standard
do
  roster.o.modes.standard = { titlebar = false }
end

-- modes.standard.titlebar
do
  roster.o.modes.standard.titlebar = false
end

-- modes.standard.sidebar
do
  roster.o.modes.standard.sidebar = { side = "right", sections = { "sessions", "inventory" } }
end

-- modes.standard.sidebar.side
do
  roster.o.modes.standard.sidebar.side = "right"
end

-- modes.standard.sidebar.sections
do
  roster.o.modes.standard.sidebar.sections = { "sessions", "inventory" }
end

-- modes.standard.sessionbar
do
  roster.o.modes.standard.sessionbar = "top"
end

-- modes.standard.statusbar
do
  roster.o.modes.standard.statusbar = { "backend", "hosts" }
end

-- modes.standard.fullscreen
do
  roster.o.modes.standard.fullscreen = true
end

-- modes.standard.toolbar
do
  roster.o.modes.standard.toolbar = { "add", "find" }
end

-- modes.focus
do
  roster.o.modes.focus = { titlebar = true }
end

-- modes.focus.titlebar
do
  roster.o.modes.focus.titlebar = true
end

-- modes.focus.sidebar
do
  roster.o.modes.focus.sidebar = { side = "right", sections = { "sessions", "inventory" } }
end

-- modes.focus.sidebar.side
do
  roster.o.modes.focus.sidebar.side = "right"
end

-- modes.focus.sidebar.sections
do
  roster.o.modes.focus.sidebar.sections = { "sessions", "inventory" }
end

-- modes.focus.sessionbar
do
  roster.o.modes.focus.sessionbar = "top"
end

-- modes.focus.statusbar
do
  roster.o.modes.focus.statusbar = { "backend", "hosts" }
end

-- modes.focus.fullscreen
do
  roster.o.modes.focus.fullscreen = false
end

-- modes.focus.toolbar
do
  roster.o.modes.focus.toolbar = { "add", "find" }
end

-- panel
do
  roster.o.panel = { width = 40 }
end

-- panel.width
do
  roster.o.panel.width = 40
end

-- views
do
  roster.o.views = { topology = { place = "panel", width = 60 } }
end

-- folders
do
  roster.o.folders = { { name = "Lab", hosts = { "esx-02", "esx-03" } } }
end

-- vault
do
  roster.o.vault = { save_to = { organization = "My Team", collection = "Infra logins" } }
end

-- vault.save_to
do
  roster.o.vault.save_to = { organization = "My Team", collection = "Infra logins" }
end

-- vault.kp
do
  roster.o.vault.kp = { database = "~/roster.kdbx" }
end

-- vault.kp.database
do
  roster.o.vault.kp.database = "~/roster.kdbx"
end

-- vault.kp.key_file
do
  roster.o.vault.kp.key_file = "~/roster.keyx"
end

-- packages
do
  roster.o.packages = { { "someone/recent-alerts", tag = "v1.2.0" }, "someone/pinned" }
end

-- plugin_proxy
do
  roster.o.plugin_proxy = "http://10.0.0.5:3128"
end

-- idle_lock_minutes
do
  roster.o.idle_lock_minutes = 30
end

-- pull_fresh_minutes
do
  roster.o.pull_fresh_minutes = 0
end

-- auto_reload
do
  roster.o.auto_reload = true
end

-- editor
do
  roster.o.editor = "wsl"
end

-- backend
do
  roster.o.backend = "wsl:dev"
end

-- roster_command
do
  roster.o.roster_command = "uv run --project ~/work/roster roster"
end

-- roster.config.Theme
do
  roster.o.themes = { paper = { appearance = "light", colors = { accent = "#b85c00" } } }
end

-- roster.config.KeyAction
do
  roster.o.keys.leader = { ["d d"] = "close", ["Ctrl+n"] = false }
end

-- roster.config.View
do
  roster.o.views = { topology = { place = "panel", width = 60 } }
end

-- roster.config.Folder
do
  roster.o.folders = { { name = "Lab", hosts = { "esx-02", "esx-03" } } }
end

-- roster.config.Package
do
  roster.o.packages = { { "someone/recent-alerts", tag = "v1.2.0" }, "someone/pinned" }
end

