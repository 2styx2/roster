---@meta roster
-- roster's Plugin API, roster.api_version 2: LuaCATS annotations for lua-language-server.
-- Generated from crates/roster-core/src/plugin/api.rs by `cargo run -p roster-core --example gen_plugin_api`; don't edit.
-- The reference: docs/plugin-api.md (`:help plugin-api`).

--- `roster-plugin.lua`: who the Plugin is and what it asks for
---@class roster.Manifest
---@field name string How it's known everywhere: lower case letters, digits and `-`, starting with a letter, at most 40. Not `builtin`, `init`, `roster` or a built-in Plugin's name.
---@field version string Its version, shown in `:plugins` (`"1.0.0"`).
---@field description? string One line on what it does, for the install prompt.
---@field author? string Who wrote it, for the install prompt (unverified).
---@field api integer The `roster.api_version` it's written for; above the app's, it doesn't install.
---@field permissions? roster.Permission[] What it asks for. Each is shown in the install prompt, the risky ones flagged.

--- A permission's name, as a manifest writes it
---@alias roster.Permission "inventory.read"|"inventory.write"|"sessions.open"|"terminal.read"|"terminal.write"|string

--- `roster.plugin`: the Plugin itself
---@class roster.Plugin
---@field name string Its name, from the manifest.
---@field version string Its version, from the manifest.
---@field permissions roster.Permission[] What it runs with: what it asked for and was granted, sorted (`serve:` ones by method).
---@field config table Its settings from `init.lua` when it's a Package (`{ "owner/repo", config = { … } }`); else `{}`. Anyone can write anything there: check it.

--- `roster.os`
---@alias roster.Os "windows"|"linux"|"macos"

--- A notice's level
---@alias roster.Level "info"|"warn"|"error"

--- What choosing a row, an action, a finder item or a status segment runs
---@alias roster.Run string|fun(args: table): any

--- `roster.commands.add`'s second argument
---@class roster.CommandSpec
---@field desc? string Its description, for `:help commands` and completion. The name if left out.
---@field run string|fun(args: roster.CommandArgs): any A function, called with what followed the command, or a command line to run instead.

--- What a command's function is called with
---@class roster.CommandArgs
---@field args string Everything after the command's name, trimmed (`""` for none).
---@field words string[] `args` split at spaces (`{}` for none).

--- Where a Plugin's key binding works
---@alias roster.KeyContext "leader"|"list"|"list_vim"

--- A Theme, as `init.lua`'s `themes` takes one
---@class roster.Theme
---@field label? string Shown in the app; the id if left out.
---@field appearance? "dark"|"light" Which OS appearance it suits; the base's if left out.
---@field base? string The Theme it starts from (a bundled one's id); Roster dark or Roster light by `appearance` if left out.
---@field colors? table<string, string> UI tokens it changes (`accent`, `bg`, …), as CSS colours.
---@field terminal? table<string, string> Terminal colours it changes (`background`, `foreground`, `cursor`, …).
---@field ansi? table<string, string>|false The 16 ANSI colours (`red`, `bright_red`, …); `false` keeps the standard palette. The base's if left out.

--- A Sidebar section (`roster.sidebar.set`)
---@class roster.Section
---@field title? string Its heading; the id if left out.
---@field order? number Where it goes: Sessions is 100, the Inventory 300. 400 if left out.
---@field empty? string What it says with no rows.
---@field rows? roster.Row[] Its rows, at most 2,000.

--- A row of a Sidebar section
---@class roster.Row
---@field id? string Unique in the section (at most 100 characters); its place in the list if left out. Keeps the selection on it across `set`s.
---@field label string Its text.
---@field detail? string A second, quieter text after the label.
---@field note? string A short note on the right.
---@field host? string Makes it the Host's row: Enter opens that Host (unless `run` says otherwise) and it lights up while the Host's Session is on screen. Never set it to a Quick Connect Session's `nil` host.
---@field badge? string A badge (at most 40 characters).
---@field count? number A count on the right.
---@field level? number How far it's indented, 0 to 8.
---@field title? string Its tooltip.
---@field run? roster.Run What Enter runs. With `host` and no `run`, it opens the Host; with neither, nothing.
---@field actions? roster.RowAction[] Buttons on the row.

--- A button on a row
---@class roster.RowAction
---@field label string What it does, for its tooltip and screen readers (`"Unpin esx-02"`).
---@field icon? roster.RowIcon Its icon; `info` if left out.
---@field run roster.Run What pressing it runs.

--- A row action's icon
---@alias roster.RowIcon "close"|"edit"|"add"|"addGroup"|"review"|"unreview"|"info"|"copy"

--- A status bar segment (`roster.status.set`)
---@class roster.StatusSegment
---@field text string Its text, at most 80 characters.
---@field title? string Its tooltip.
---@field run? roster.Run What clicking it runs.

--- A finder (`roster.finders.set`)
---@class roster.Finder
---@field title? string Its title and prompt; the id if left out.
---@field items? roster.FinderItem[] What it finds in, at most 2,000.

--- One thing a finder lists
---@class roster.FinderItem
---@field id? string Unique in the finder; its place in the list if left out.
---@field label string What's matched and shown.
---@field detail? string Shown after the label, and matched too.
---@field path? string Where it is, shown quieter (`lab › esx-02`).
---@field run roster.Run What Enter runs.

--- A help page (`roster.help.set`)
---@class roster.HelpPage
---@field title? string Its title; the topic if left out.
---@field summary? string One line for the index and the topic finder; the title if left out.
---@field markdown string The page, as Markdown (at most 200,000 characters): headings, paragraphs, lists, tables, code, links.

--- A section of `:check` (`roster.health.set`)
---@class roster.HealthSection
---@field title? string Its heading; the id if left out.
---@field checks? roster.HealthCheck[] Its lines.

--- One line of a `:check` section
---@class roster.HealthCheck
---@field level "ok"|"warn"|"error" How it went.
---@field message string What it found.
---@field fix? string What to do about it, in a sentence.

--- A tutorial (`roster.tutor.set`)
---@class roster.Tutorial
---@field title? string Its title; the id if left out.
---@field summary? string One line for `:tutor` and the help index; the title if left out.
---@field intro? string Markdown before the first lesson.
---@field lessons roster.Lesson[] At least one.
---@field outro? string Markdown after the last lesson.

--- A lesson of a tutorial
---@class roster.Lesson
---@field title string Its heading (at most 100 characters).
---@field text? string Markdown before its steps.
---@field steps? roster.Step[] What to do, in order.

--- A step of a lesson: done when the app sends a matching event
---@class roster.Step
---@field id string Unique in the tutorial: what the State keeps once it's done.
---@field text string What to do (Markdown).
---@field on roster.StepMatch|roster.StepMatch[] The event that ticks it, or a list of them (any one does).

--- An event a step waits for
---@class roster.StepMatch
---@field event roster.TutorEvent The event's name.
---@field [string] string Any other key is a field the event must have, equal ignoring case; `"*"` means it's there, `""` that it isn't.

--- The events a tutorial's step can wait for
---@alias roster.TutorEvent "command"|"session_open"|"session_exit"|"host_selected"|"help_open"|"help_back"|"help_forward"|"help_search"

--- A floating window (`roster.float.open`)
---@class roster.Float
---@field title? string Its title.
---@field lines? string[] Its text, a line each (at most 2,000, each cut to 500 characters).

--- A Host, as roster serve's `hosts.list` and `host.get` give it
---@class roster.Host
---@field name string Its name in the Inventory, unique.
---@field group string The group it's in.
---@field ip string Its address (an IP or a DNS name).
---@field ssh roster.SshLogin How roster logs in to it over ssh.
---@field login roster.Login The default Login for its services.
---@field services table<string, roster.Service> Its services by name (`web`, `postgres`). `{}` when there are none.
---@field problems roster.ServiceProblem[] Service entries roster left out because it can't use them. `{}` when there are none.
---@field web? string Its web UI's URL: the `web` service's, else the first service given a URL.
---@field enroll boolean Whether `roster setup` puts this Box's key on it (`false`: password Sessions).
---@field reviewed boolean `false` for a Host `discover` added and no one has reviewed: it can't be opened until it is.
---@field mesh? boolean `mesh:` as roster.yml sets it; `nil` if nothing does.
---@field title string One line; `""` if unset.
---@field description string One line; `""` if unset.
---@field type string What it is (`esxi`, `linux`); `""` if unset.
---@field product string Its product; `""` if unset.
---@field mac string Its MAC address; `""` if unset.
---@field notes string The older name for `description`, as roster.yml has it.
---@field user string The same as `ssh.user` (kept for older code).
---@field port integer The same as `ssh.port`.
---@field auth roster.LoginRef The same as `ssh.auth`.
---@field [string] any Any other key roster.yml gives it.

--- A Login reference: where a password is, never the password
---@alias roster.LoginRef string

--- A Host's ssh login
---@class roster.SshLogin
---@field user string The user.
---@field port integer The port (22 unless set).
---@field auth roster.LoginRef Its Login (`prompt` unless set).

--- A Host's default Login for its services (`login:` in roster.yml)
---@class roster.Login
---@field user? string The user; `nil` if unset.
---@field auth? roster.LoginRef The Login; `nil` if unset.

--- One of a Host's services, resolved
---@class roster.Service
---@field port integer Its port.
---@field url? string Its URL, for http and https services.
---@field scheme? string `http`, `https`, or `nil` when roster can't tell.
---@field user? string Its user: its own, else the Host's `login.user`.
---@field auth? roster.LoginRef Its Login: its own, else the Host's `login.auth`.
---@field verify boolean Whether its TLS certificate is checked.
---@field login string How `roster web` signs in: `basic`, `bearer`, `vsphere`, `unifi`, `openvpnas`, `hub` or `none`.
---@field override boolean `true` when it has a Login of its own; `false` when it uses the Host's.

--- A service entry roster left out of a Host
---@class roster.ServiceProblem
---@field service string The service's name.
---@field message string What's wrong, naming the service.
---@field fix string What to change.

--- A group of Hosts, as `hosts.list` gives it
---@class roster.Group
---@field title string One line; `""` if unset.
---@field description string One line; `""` if unset.

--- `roster.inventory.update`'s changes: the fields to change
---@class roster.Change
---@field title? string One line.
---@field description? string One line.
---@field type? string One line.
---@field ip? string No spaces, not empty. Needs a test login first: refused from a Plugin (code 75).
---@field user? string No spaces, not empty. Refused from a Plugin (code 75).
---@field port? integer 1 to 65535. Refused from a Plugin (code 75).
---@field auth? roster.LoginRef Refused from a Plugin (code 75).

--- What `roster.inventory.update` wrote
---@class roster.UpdateResult
---@field changed boolean `false` when the Host already had those values (nothing written).
---@field host roster.Host The Host as it loads now.
---@field backup? string Where `roster.yml` as it was is kept; `nil` when nothing changed.
---@field warnings? string[] What failed after the write; `nil` when nothing changed.

--- What `roster.inventory.rename` wrote
---@class roster.RenameResult
---@field changed boolean `false` when `to` is its name already.
---@field host roster.Host The Host as it loads now.
---@field backup? string Where `roster.yml` as it was is kept; `nil` when nothing changed.

--- What `roster.inventory.move` wrote
---@class roster.MoveResult
---@field changed boolean `false` when it's in that group already.
---@field host roster.Host The Host as it loads now.
---@field pinned string[] The fields written on the Host so it stays the same Host.
---@field backup? string Where `roster.yml` as it was is kept; `nil` when nothing changed.

--- What `roster.inventory.review` wrote
---@class roster.ReviewResult
---@field changed boolean `false` when it already was.
---@field host roster.Host The Host as it loads now.
---@field backup? string Where `roster.yml` as it was is kept; `nil` when nothing changed.

--- `inventory.info`'s result
---@class roster.InventoryInfo
---@field path string `roster.yml`'s full path.
---@field box string This Box's name.
---@field host_count integer How many Hosts.
---@field providers string[] The password providers roster has.
---@field roster_version string roster's version.
---@field api_version integer roster serve's API version (not `roster.api_version`).

--- `hosts.list`'s result
---@class roster.HostList
---@field hosts roster.Host[] Every Host, in `roster.yml` order.
---@field groups table<string, roster.Group> Every group, by name.
---@field error? roster.InventoryError Why `roster.yml` as it is now doesn't load, while these are the last good Hosts; `nil` when it loads.

--- Why `roster.yml` doesn't load right now
---@class roster.InventoryError
---@field message string What's wrong.
---@field path? string The file.
---@field line? integer The line, when roster knows it.
---@field fix? string What to do.

--- `host.check`'s result: the steps of `roster check HOST`
---@class roster.HostCheck
---@field host string The Host.
---@field ok boolean Whether every step passed.
---@field steps roster.CheckStep[] Every step, in order: `inventory`, `ssh-config`, `provider`, `vault-item`, `dns`, `tcp`, `host-key`, `auth`.

--- One step of a `host.check`
---@class roster.CheckStep
---@field step string Its name.
---@field status "ok"|"fail"|"skipped" How it went; every step after a `fail` is `skipped`.
---@field message string What happened.
---@field code? integer A failed step's error code (serve-api.md's tables).
---@field fix? string What to do, in a sentence.
---@field details? string The raw text, when there is one (ssh's stderr).
---@field data? table What the code's row says it carries.

--- `changes.diff`'s result: the Pending changes
---@class roster.ChangesDiff
---@field path string `roster.yml`'s path.
---@field repo string The infra repo's top folder.
---@field diff string git's diff of `roster.yml` against the last commit; `""` for none.
---@field hosts roster.HostChange[] The Hosts it changes.
---@field groups roster.GroupChange[] The groups it changes.
---@field count integer How many Hosts change (1 for a change that touches none, 0 for no change).
---@field message string The commit message Publish would write.
---@field last_commit? roster.LastCommit The branch's last commit; `nil` in a repo with none.

--- A Host in `changes.diff`
---@class roster.HostChange
---@field host string Its name.
---@field change "changed"|"added"|"removed" What happened to it.
---@field fields string[] For `changed`, the fields that did.

--- A group in `changes.diff`
---@class roster.GroupChange
---@field group string Its name.
---@field change "changed"|"added"|"removed" What happened to it.

--- The infra repo's last commit
---@class roster.LastCommit
---@field commit string Its hash.
---@field subject string Its subject line.
---@field upstream? string The branch's upstream (`origin/main`); `nil` without one.
---@field pushed boolean Whether the upstream has it, as this Box last fetched.

--- An event a Plugin can listen for
---@alias roster.EventName "lock"|"unlock"|"host_selected"|"session_open"|"session_exit"|"inventory_changed"|"terminal_output"

--- The payload of `lock`, `unlock` and `inventory_changed`: an empty table
---@class roster.EmptyEvent

--- `host_selected`'s payload
---@class roster.HostSelectedEvent
---@field host string The Host whose Session is on screen now.

--- `session_open`'s payload
---@class roster.SessionOpenEvent
---@field session integer The Session's id: `roster.terminal.send` takes it.
---@field host? string The Host's name; `nil` for a Quick Connect Session (`:quick`), which isn't on a Host: don't badge it or make a row go to it.

--- `session_exit`'s payload
---@class roster.SessionExitEvent
---@field session integer The Session's id.
---@field host? string The Host's name; `nil` for a Quick Connect Session, and for a tab closed while it ran.
---@field code? integer ssh's exit code; `nil` when it failed to start or its tab was closed.

--- `terminal_output`'s payload
---@class roster.TerminalOutputEvent
---@field session integer The Session's id.
---@field host? string The Host's name; `nil` for a Quick Connect Session.
---@field text string What it printed since the last one, as text without colours or escape sequences (at most the last 16 KB); a cursor move to a row is a line break. A line can be split across two batches. Right after the app resizes the Session, the screen it prints again (ConPTY does on Windows, and full-screen programs redraw) isn't sent: for a second, lines it already sent lately are left out, and only new ones come.

---@class roster.module
---@field api_version integer The version of the `roster` module this app has
---@field os roster.Os The OS the app runs on
---@field plugin roster.Plugin The Plugin itself: its name, version, what it was granted and its settings
roster = {}

--- Shows a notice, naming the Plugin.
--- Permission: none. Since: api 2.
---@param text string What to say. It's shown after the Plugin's name (`pinned: …`).
---@param level? roster.Level `"info"` (the default), `"warn"` or `"error"`.
function roster.notify(text, level) end

--- Runs a function on an event.
--- Permission: none. Since: api 2.
---@param event roster.EventName The event's name: `lock`, `unlock`, `host_selected`, `session_open`, `session_exit`, `inventory_changed` or `terminal_output`.
---@param listener fun(e: table) Runs with the event's payload (see Events) each time it happens. Its return value is ignored.
---@overload fun(event: "lock", listener: fun(e: roster.EmptyEvent))
---@overload fun(event: "unlock", listener: fun(e: roster.EmptyEvent))
---@overload fun(event: "host_selected", listener: fun(e: roster.HostSelectedEvent))
---@overload fun(event: "session_open", listener: fun(e: roster.SessionOpenEvent))
---@overload fun(event: "session_exit", listener: fun(e: roster.SessionExitEvent))
---@overload fun(event: "inventory_changed", listener: fun(e: roster.EmptyEvent))
---@overload fun(event: "terminal_output", listener: fun(e: roster.TerminalOutputEvent))
function roster.on(event, listener) end

--- `:` commands. 
roster.commands = {}

--- Adds a `:` command.
--- Permission: none. Since: api 2.
---@param name string The command: `:name ARGS`. Lower case letters, digits, `-`, `_` and `.`, at most 64.
---@param spec roster.CommandSpec Its description and what it runs.
function roster.commands.add(name, spec) end

--- Removes one of the Plugin's commands.
--- Permission: none. Since: api 2.
---@param name string A command this Plugin added.
function roster.commands.remove(name) end

--- Key bindings. 
roster.keymap = {}

--- Binds keys to a command line.
--- Permission: none. Since: api 2.
---@param context roster.KeyContext `"leader"` (a key after the Leader), `"list"` or `"list_vim"` (the Sidebar, and its vim keys).
---@param keys string The keys, space-separated: `"w w"`.
---@param action string|false A command line: one of the Plugin's commands or the app's (`"finder alerts"`). `false` claims the keys with no action.
function roster.keymap.set(context, keys, action) end

--- Themes. 
roster.themes = {}

--- Adds a Theme.
--- Permission: none. Since: api 2.
---@param id string The Theme's id, as `:theme ID` takes it.
---@param theme roster.Theme As `init.lua`'s `themes` takes one.
function roster.themes.define(id, theme) end

--- Sidebar sections. 
roster.sidebar = {}

--- Adds a Sidebar section, or replaces it.
--- Permission: none. Since: api 2.
---@param id string The section's id: a name like `recent-alerts`.
---@param section roster.Section Its title, place, empty text and rows.
function roster.sidebar.set(id, section) end

--- Removes a Sidebar section.
--- Permission: none. Since: api 2.
---@param id string One of the Plugin's sections.
function roster.sidebar.remove(id) end

--- Status bar segments. 
roster.status = {}

--- Adds a status bar segment, or replaces it.
--- Permission: none. Since: api 2.
---@param id string The segment's id.
---@param segment roster.StatusSegment Its text, tooltip and what clicking it runs.
function roster.status.set(id, segment) end

--- Removes a status bar segment.
--- Permission: none. Since: api 2.
---@param id string One of the Plugin's segments.
function roster.status.remove(id) end

--- Finders (`:finder ID`). 
roster.finders = {}

--- Adds a finder, or replaces it.
--- Permission: none. Since: api 2.
---@param id string The finder's id: `:finder ID` opens it.
---@param finder roster.Finder Its title and items.
function roster.finders.set(id, finder) end

--- Removes a finder.
--- Permission: none. Since: api 2.
---@param id string One of the Plugin's finders.
function roster.finders.remove(id) end

--- Help pages (`:help TOPIC`). 
roster.help = {}

--- Adds a help page, or replaces it.
--- Permission: none. Since: api 2.
---@param topic string The page's topic: `:help TOPIC`.
---@param page roster.HelpPage Its title, summary and Markdown.
function roster.help.set(topic, page) end

--- Removes a help page.
--- Permission: none. Since: api 2.
---@param topic string One of the Plugin's pages.
function roster.help.remove(topic) end

--- Sections of `:check`. 
roster.health = {}

--- Adds a section to `:check` (this Box's health), or replaces it.
--- Permission: none. Since: api 2.
---@param id string The section's id.
---@param section roster.HealthSection Its title and checks.
function roster.health.set(id, section) end

--- Removes a `:check` section.
--- Permission: none. Since: api 2.
---@param id string One of the Plugin's sections.
function roster.health.remove(id) end

--- Tutorials (`:tutor ID`). 
roster.tutor = {}

--- Adds a tutorial, or replaces it.
--- Permission: none. Since: api 2.
---@param id string The tutorial's id: `:tutor ID` runs it, `:help tutor-ID` is its page.
---@param tutorial roster.Tutorial Its text and lessons.
function roster.tutor.set(id, tutorial) end

--- Removes a tutorial.
--- Permission: none. Since: api 2.
---@param id string One of the Plugin's tutorials.
function roster.tutor.remove(id) end

--- Badges on Host rows. 
roster.badges = {}

--- Puts a badge on a Host's Inventory row, or takes it off.
--- Permission: none. Since: api 2.
---@param host string The Host's name in the Inventory.
---@param text? string The badge: keep it short, a count (`"2"`) or a word (at most 40 characters); `nil` takes it off.
function roster.badges.set(host, text) end

--- A floating window over the terminal. 
roster.float = {}

--- Opens a floating window over the terminal, or replaces the Plugin's.
--- Permission: none. Since: api 2.
---@param float roster.Float Its title and lines.
function roster.float.open(float) end

--- Closes the Plugin's floating window.
--- Permission: none. Since: api 2.
function roster.float.close() end

--- The clipboard. 
roster.clipboard = {}

--- Puts text on the clipboard.
--- Permission: none. Since: api 2.
---@param text string What to put on the clipboard, at most 64 KB.
function roster.clipboard.copy(text) end

--- Hosts, and Pending changes to them. `nil` unless the Plugin was granted `inventory.read` or `inventory.write`; each function is there only with its own permission. The functions wait for `roster serve`; that time doesn't count against the Plugin's budget.
roster.inventory = {}

--- Every Host, in `roster.yml` order.
--- Permission: inventory.read. Since: api 2.
---@return roster.Host[] # The Hosts, each with its Login references (a vault item's name, never a password).
function roster.inventory.hosts() end

--- One Host, by its exact name.
--- Permission: inventory.read. Since: api 2.
---@param name string The Host's exact name.
---@return roster.Host # The Host.
function roster.inventory.host(name) end

--- Changes a Host's fields, as a Pending change.
--- Permission: inventory.write. Since: api 2.
---@param host string The Host's exact name.
---@param changes roster.Change The fields to change, and their new values.
---@return roster.UpdateResult # What was written.
function roster.inventory.update(host, changes) end

--- Renames a Host, as a Pending change.
--- Permission: inventory.write. Since: api 2.
---@param host string The Host's exact name.
---@param to string Its new name.
---@return roster.RenameResult # What was written.
function roster.inventory.rename(host, to) end

--- Moves a Host to another group, as a Pending change.
--- Permission: inventory.write. Since: api 2.
---@param host string The Host's exact name.
---@param group string The group to move it to (at its end).
---@return roster.MoveResult # What was written, and which fields were pinned on the Host.
function roster.inventory.move(host, group) end

--- Marks a Host reviewed (or not), as a Pending change.
--- Permission: inventory.write. Since: api 2.
---@param host string The Host's exact name.
---@param reviewed? boolean `true` (the default) marks it reviewed; `false` un-reviews it.
---@return roster.ReviewResult # What was written.
function roster.inventory.review(host, reviewed) end

--- Opening Sessions. `nil` unless the Plugin was granted `sessions.open`.
roster.sessions = {}

--- Opens a Session on a Host, as `:connect HOST`.
--- Permission: sessions.open. Since: api 2.
---@param host string The Host's exact name.
function roster.sessions.open(host) end

--- Typing into Sessions. `nil` unless the Plugin was granted `terminal.write`. Reading what Sessions print is the `terminal_output` event (`terminal.read`).
roster.terminal = {}

--- Types into an open Session.
--- Permission: terminal.write. Since: api 2.
---@param session integer The Session's id, from an event (`e.session`).
---@param text string What to type, as if the user typed it: `"uptime\n"` runs `uptime`.
function roster.terminal.send(session, text) end

--- roster serve's methods, by name. `nil` unless the Plugin was granted at least one `serve:<method>` permission.
roster.serve = {}

--- Calls a roster serve method the Plugin was granted.
--- Permission: serve:<method> (that method). Since: api 2.
---@param method string A roster serve method the Plugin was granted, by name (`serve:inventory.info` grants `inventory.info`).
---@param params? table The method's params; `{}` if left out. Data only: no functions.
---@return any # The method's result, as Lua tables (JSON `null` is `nil`).
function roster.serve.call(method, params) end

return roster
