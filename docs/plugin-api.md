# The Plugin API

<!-- Generated from crates/roster-core/src/plugin/api.rs by `cargo run -p roster-core --example gen_plugin_api`: edit that, then run it. -->

Every function, value, event and data type of the `roster` Lua module a Plugin gets, `roster.api_version` 2. How to write, install and trust a Plugin is the guide, [Writing a Plugin](plugins.md); this is the reference. Each entry is a help topic: `:help roster.inventory.host()` for a function, `:help roster-Host` for a type.

Types are written as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations write them: `string?` may be `nil`, `Host[]` is a list of Hosts, `table<string, Group>` a table of Groups by name, `"info"|"warn"` one of those strings. The same declarations are [`roster.lua`](../examples/plugins/types/roster.lua), for [your editor](#editor-support).

## The Lua

roster embeds **Lua 5.4** (built into the app, nothing to install), not LuaJIT as Neovim does; [why](adr/0006-lua-plugins-and-packages.md#why-lua-54-not-luajit). Coming from Neovim:

- Integers are real 64-bit integers (`3 // 2` is `1`, `math.type(1)` is `"integer"`), and the bitwise operators are native (`a & b`, `a | b`, `~a`, `a << 2`): there's no `bit` library.
- `goto`, `<const>` and `<close>` locals work; there's no `jit` and no FFI.
- The API is `roster.*`, never `vim.*`: there's no `vim.api`, `vim.fn`, `vim.loop` or `vim.schedule`.
- It runs in the [sandbox](app/config.md#the-sandbox): the base functions, `string`, `table`, `math`, `utf8` and an `os` with only `time`, `clock`, `date` and `difftime`. No `io`, no `os.execute`, no `debug`, no `coroutine`, no `package` and no C modules; `load` takes text only, and `require` loads only from the Plugin's own folder (`name.lua`, `name/init.lua`, or the same under `lua/`).
- It runs on a thread of its own with a memory limit and a time budget per call: see [Limits](plugins.md#limits).

## Index

| Function | What it does | Permission |
|---|---|---|
| [`roster.api_version`](#rosterapi_version) | The version of the `roster` module this app has | none |
| [`roster.os`](#rosteros) | The OS the app runs on | none |
| [`roster.plugin`](#rosterplugin) | The Plugin itself: its name, version, what it was granted and its settings | none |
| [`roster.notify(text, level)`](#rosternotifytext-level) | Shows a notice, naming the Plugin | none |
| [`roster.on(event, listener)`](#rosteronevent-listener) | Runs a function on an event | none |
| [`roster.commands.add(name, spec)`](#rostercommandsaddname-spec) | Adds a `:` command | none |
| [`roster.commands.remove(name)`](#rostercommandsremovename) | Removes one of the Plugin's commands | none |
| [`roster.keymap.set(context, keys, action)`](#rosterkeymapsetcontext-keys-action) | Binds keys to a command line | none |
| [`roster.themes.define(id, theme)`](#rosterthemesdefineid-theme) | Adds a Theme | none |
| [`roster.sidebar.set(id, section)`](#rostersidebarsetid-section) | Adds a Sidebar section, or replaces it | none |
| [`roster.sidebar.remove(id)`](#rostersidebarremoveid) | Removes a Sidebar section | none |
| [`roster.status.set(id, segment)`](#rosterstatussetid-segment) | Adds a status bar segment, or replaces it | none |
| [`roster.status.remove(id)`](#rosterstatusremoveid) | Removes a status bar segment | none |
| [`roster.finders.set(id, finder)`](#rosterfinderssetid-finder) | Adds a finder, or replaces it | none |
| [`roster.finders.remove(id)`](#rosterfindersremoveid) | Removes a finder | none |
| [`roster.help.set(topic, page)`](#rosterhelpsettopic-page) | Adds a help page, or replaces it | none |
| [`roster.help.remove(topic)`](#rosterhelpremovetopic) | Removes a help page | none |
| [`roster.health.set(id, section)`](#rosterhealthsetid-section) | Adds a section to `:check` (this Box's health), or replaces it | none |
| [`roster.health.remove(id)`](#rosterhealthremoveid) | Removes a `:check` section | none |
| [`roster.tutor.set(id, tutorial)`](#rostertutorsetid-tutorial) | Adds a tutorial, or replaces it | none |
| [`roster.tutor.remove(id)`](#rostertutorremoveid) | Removes a tutorial | none |
| [`roster.badges.set(host, text)`](#rosterbadgessethost-text) | Puts a badge on a Host's Inventory row, or takes it off | none |
| [`roster.float.open(float)`](#rosterfloatopenfloat) | Opens a floating window over the terminal, or replaces the Plugin's | none |
| [`roster.float.close()`](#rosterfloatclose) | Closes the Plugin's floating window | none |
| [`roster.clipboard.copy(text)`](#rosterclipboardcopytext) | Puts text on the clipboard | none |
| [`roster.inventory.hosts()`](#rosterinventoryhosts) | Every Host, in `roster.yml` order | `inventory.read` |
| [`roster.inventory.host(name)`](#rosterinventoryhostname) | One Host, by its exact name | `inventory.read` |
| [`roster.inventory.update(host, changes)`](#rosterinventoryupdatehost-changes) | Changes a Host's fields, as a Pending change | `inventory.write` |
| [`roster.inventory.rename(host, to)`](#rosterinventoryrenamehost-to) | Renames a Host, as a Pending change | `inventory.write` |
| [`roster.inventory.move(host, group)`](#rosterinventorymovehost-group) | Moves a Host to another group, as a Pending change | `inventory.write` |
| [`roster.inventory.review(host, reviewed)`](#rosterinventoryreviewhost-reviewed) | Marks a Host reviewed (or not), as a Pending change | `inventory.write` |
| [`roster.sessions.open(host)`](#rostersessionsopenhost) | Opens a Session on a Host, as `:connect HOST` | `sessions.open` |
| [`roster.terminal.send(session, text)`](#rosterterminalsendsession-text) | Types into an open Session | `terminal.write` |
| [`roster.serve.call(method, params)`](#rosterservecallmethod-params) | Calls a roster serve method the Plugin was granted | `serve:<method>` (that method) |

| Type | What it is |
|---|---|
| [`Manifest`](#manifest) | `roster-plugin.lua`: who the Plugin is and what it asks for |
| [`Permission`](#permission) | A permission's name, as a manifest writes it |
| [`Plugin`](#plugin) | `roster.plugin`: the Plugin itself |
| [`Os`](#os) | `roster.os` |
| [`Level`](#level) | A notice's level |
| [`Run`](#run) | What choosing a row, an action, a finder item or a status segment runs |
| [`CommandSpec`](#commandspec) | `roster.commands.add`'s second argument |
| [`CommandArgs`](#commandargs) | What a command's function is called with |
| [`KeyContext`](#keycontext) | Where a Plugin's key binding works |
| [`Theme`](#theme) | A Theme, as `init.lua`'s `themes` takes one |
| [`Section`](#section) | A Sidebar section (`roster.sidebar.set`) |
| [`Row`](#row) | A row of a Sidebar section |
| [`RowAction`](#rowaction) | A button on a row |
| [`RowIcon`](#rowicon) | A row action's icon |
| [`StatusSegment`](#statussegment) | A status bar segment (`roster.status.set`) |
| [`Finder`](#finder) | A finder (`roster.finders.set`) |
| [`FinderItem`](#finderitem) | One thing a finder lists |
| [`HelpPage`](#helppage) | A help page (`roster.help.set`) |
| [`HealthSection`](#healthsection) | A section of `:check` (`roster.health.set`) |
| [`HealthCheck`](#healthcheck) | One line of a `:check` section |
| [`Tutorial`](#tutorial) | A tutorial (`roster.tutor.set`) |
| [`Lesson`](#lesson) | A lesson of a tutorial |
| [`Step`](#step) | A step of a lesson: done when the app sends a matching event |
| [`StepMatch`](#stepmatch) | An event a step waits for |
| [`TutorEvent`](#tutorevent) | The events a tutorial's step can wait for |
| [`Float`](#float) | A floating window (`roster.float.open`) |
| [`Host`](#host) | A Host, as roster serve's `hosts.list` and `host.get` give it |
| [`LoginRef`](#loginref) | A Login reference: where a password is, never the password |
| [`SshLogin`](#sshlogin) | A Host's ssh login |
| [`Login`](#login) | A Host's default Login for its services (`login:` in roster.yml) |
| [`Service`](#service) | One of a Host's services, resolved |
| [`ServiceProblem`](#serviceproblem) | A service entry roster left out of a Host |
| [`Group`](#group) | A group of Hosts, as `hosts.list` gives it |
| [`Change`](#change) | `roster.inventory.update`'s changes: the fields to change |
| [`UpdateResult`](#updateresult) | What `roster.inventory.update` wrote |
| [`RenameResult`](#renameresult) | What `roster.inventory.rename` wrote |
| [`MoveResult`](#moveresult) | What `roster.inventory.move` wrote |
| [`ReviewResult`](#reviewresult) | What `roster.inventory.review` wrote |
| [`InventoryInfo`](#inventoryinfo) | `inventory.info`'s result |
| [`HostList`](#hostlist) | `hosts.list`'s result |
| [`InventoryError`](#inventoryerror) | Why `roster.yml` doesn't load right now |
| [`HostCheck`](#hostcheck) | `host.check`'s result: the steps of `roster check HOST` |
| [`CheckStep`](#checkstep) | One step of a `host.check` |
| [`ChangesDiff`](#changesdiff) | `changes.diff`'s result: the Pending changes |
| [`HostChange`](#hostchange) | A Host in `changes.diff` |
| [`GroupChange`](#groupchange) | A group in `changes.diff` |
| [`LastCommit`](#lastcommit) | The infra repo's last commit |
| [`EventName`](#eventname) | An event a Plugin can listen for |
| [`EmptyEvent`](#emptyevent) | The payload of `lock`, `unlock` and `inventory_changed`: an empty table |
| [`HostSelectedEvent`](#hostselectedevent) | `host_selected`'s payload |
| [`SessionOpenEvent`](#sessionopenevent) | `session_open`'s payload |
| [`SessionExitEvent`](#sessionexitevent) | `session_exit`'s payload |
| [`TerminalOutputEvent`](#terminaloutputevent) | `terminal_output`'s payload |

## Errors

A function that fails raises a Lua error: `pcall` catches it, with the message as a string. The message starts with the function (`roster.inventory.host: unknown host 'web-9' (code 2)`); a roster serve error ends with its code, from [serve-api.md's tables](serve-api.md). An error you don't catch stops the call: a notice names the Plugin, file and line (`pinned: init.lua:12: …`), the UI changes that call made are dropped, and the third such error after loading stops the Plugin.

Any function can also raise:

- Lua's own `bad argument` error, for an argument of the wrong kind (a number where a table goes);
- `PATH: a table that mixes a list with named keys (or has gaps): use one or the other`, `PATH: a Lua function can't be a Config value`, `PATH: a userdata can't be a Config value` and the like, for data that can't be handed over (`PATH` is where in your table, `rows.3.label`);
- `more than 1000 UI changes in one go`, when one call sets more than that;
- `more than 10000 functions handed to roster at once`.

**Refused by the app** isn't an error: the app shows a warning notice naming the Plugin (`pinned: :pin is taken (builtin)`) and leaves that one change out. The call itself goes on.

## `roster`

The module itself: its version, the OS, the Plugin, notices and events. `require("roster")`, also the global `roster`. Each Plugin has its own, built from what it was granted: a function a permission gives isn't there without it.

### `roster.api_version`

The version of the `roster` module this app has. A manifest's `api` above it doesn't install ("update the app"). One number for `init.lua`'s module and Plugins'.

**Type:** `integer`

**Permission:** none · **Since:** api 2

**Example**

```lua
if roster.api_version < 3 then
  roster.notify("this needs a newer roster for one feature", "warn")
end
```

### `roster.os`

The OS the app runs on.

**Type:** [`Os`](#os)

**Permission:** none · **Since:** api 2

**Example**

```lua
local copy_key = roster.os == "macos" and "Cmd+C" or "Ctrl+Shift+C"
```

### `roster.plugin`

The Plugin itself: its name, version, what it was granted and its settings.

**Type:** [`Plugin`](#plugin)

**Permission:** none · **Since:** api 2

**Example**

```lua
local function granted(p)
  for _, g in ipairs(roster.plugin.permissions) do
    if g == p then return true end
  end
  return false
end
local leader = roster.plugin.config.leader or "w w"
```

### `roster.notify(text, level)`

Shows a notice, naming the Plugin.

**Parameters**

- `text` (`string`): What to say. It's shown after the Plugin's name (`pinned: …`).
- `level` ([`Level`](#level)`?`, optional): `"info"` (the default), `"warn"` or `"error"`.

**Returns**

Nothing.

**Errors**

- `roster.notify: the level is "info", "warn" or "error"`: `level` is something else.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.notify("3 new alerts")
roster.notify("leader: not a key sequence, using w w", "warn")
```

### `roster.on(event, listener)`

Runs a function on an event. Several listeners for one event run in the order they were added. There's no way to stop listening short of `:plugins reload`.

**Parameters**

- `event` ([`EventName`](#eventname)): The event's name: `lock`, `unlock`, `host_selected`, `session_open`, `session_exit`, `inventory_changed` or `terminal_output`.
- `listener` (`fun(e: table)`): Runs with the event's payload (see [Events](#events)) each time it happens. Its return value is ignored.

**Returns**

Nothing.

**Errors**

- `roster.on: there's no event "NAME" (there's lock, unlock, …)`: `event` isn't one of them.
- `roster.on: the EVENT event needs the P permission`: the Plugin may not hear it ("needs the inventory.read or terminal.read permission").
- And [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.on("session_open", function(e)
  if e.host then roster.badges.set(e.host, "open") end
end)
```

## `roster.commands`

`:` commands.

### `roster.commands.add(name, spec)`

Adds a `:` command. Adding it again replaces it (and the function it ran).

**Parameters**

- `name` (`string`): The command: `:name ARGS`. Lower case letters, digits, `-`, `_` and `.`, at most 64.
- `spec` ([`CommandSpec`](#commandspec)): Its description and what it runs.

**Returns**

Nothing.

**Errors**

- `roster.commands.add: "NAME" isn't a name like "recent-alerts" (…)`: a bad `name`.
- `roster.commands.add: `run` must be a function or a command line`: `spec.run` is missing or something else.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- `:NAME` is taken by roster, `init.lua` or another Plugin (`pinned: :pin is taken (other)`), or it's `:plugins`.

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.commands.add("alerts", {
  desc = "Recent alerts",
  run = function(a)
    if a.words[1] == "clear" then clear() end
  end,
})
roster.commands.add("pins", { desc = "Pinned Hosts", run = "finder pinned" })
```

### `roster.commands.remove(name)`

Removes one of the Plugin's commands. Removing one it doesn't have does nothing.

**Parameters**

- `name` (`string`): A command this Plugin added.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.commands.remove("alerts")
```

## `roster.keymap`

Key bindings.

### `roster.keymap.set(context, keys, action)`

Binds keys to a command line. Never in the terminal. A function isn't an action: add a command and bind its name.

**Parameters**

- `context` ([`KeyContext`](#keycontext)): `"leader"` (a key after the Leader), `"list"` or `"list_vim"` (the Sidebar, and its vim keys).
- `keys` (`string`): The keys, space-separated: `"w w"`.
- `action` (`string|false`): A command line: one of the Plugin's commands or the app's (`"finder alerts"`). `false` claims the keys with no action.

**Returns**

Nothing.

**Errors**

- `roster.keymap.set: the action is a command line such as "alerts" (add a command for a function)`: `action` isn't a string or `false`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a `context` other than the three (`keys go after the Leader or in the Sidebar …`).
- keys bound already, by roster, `init.lua` or another Plugin (`a` is Folders', `f` the Picker's; `:keys` lists them).
- keys that would hide a binding, or be hidden by one (`"a z"` when `a` is bound).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.keymap.set("leader", roster.plugin.config.leader or "w w", "finder alerts")
```

## `roster.themes`

Themes.

### `roster.themes.define(id, theme)`

Adds a Theme. Checked as `init.lua`'s `themes` are.

**Parameters**

- `id` (`string`): The Theme's id, as `:theme ID` takes it.
- `theme` ([`Theme`](#theme)): As `init.lua`'s `themes` takes one.

**Returns**

Nothing.

**Errors**

- `roster.themes.define: "ID" isn't a name like …`: a bad `id`.
- `roster.themes.define "ID": …`: the Theme isn't one `init.lua` would take: an unknown field or token, a colour that isn't one.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a Theme with that id exists already.

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.themes.define("dusk", { base = "nord", colors = { accent = "#e0a060" } })
```

## `roster.sidebar`

Sidebar sections.

### `roster.sidebar.set(id, section)`

Adds a Sidebar section, or replaces it. Setting it again replaces the whole section, and drops the functions its old rows held.

**Parameters**

- `id` (`string`): The section's id: a name like `recent-alerts`.
- `section` ([`Section`](#section)): Its title, place, empty text and rows.

**Returns**

Nothing.

**Errors**

- `roster.sidebar.set: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a section with that id from elsewhere.
- a field of the wrong kind (`roster.sidebar.set pinned row 2: label must be text`): the whole section is dropped.

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.sidebar.set("pinned", {
  title = "Pinned",
  order = 150,
  empty = "Nothing pinned. :pin HOST",
  rows = { { id = "esx-02", label = "esx-02", host = "esx-02", detail = "10.0.0.5" } },
})
```

### `roster.sidebar.remove(id)`

Removes a Sidebar section.

**Parameters**

- `id` (`string`): One of the Plugin's sections.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.sidebar.remove("pinned")
```

## `roster.status`

Status bar segments.

### `roster.status.set(id, segment)`

Adds a status bar segment, or replaces it. It comes after the app's own segments; a layout can place it (`modes.standard.statusbar`).

**Parameters**

- `id` (`string`): The segment's id.
- `segment` ([`StatusSegment`](#statussegment)): Its text, tooltip and what clicking it runs.

**Returns**

Nothing.

**Errors**

- `roster.status.set: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a segment with that id from elsewhere.
- no `text`.

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.status.set("alerts", { text = "⚠ " .. #alerts, title = "Recent alerts", run = "finder alerts" })
```

### `roster.status.remove(id)`

Removes a status bar segment.

**Parameters**

- `id` (`string`): One of the Plugin's segments.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.status.remove("alerts")
```

## `roster.finders`

Finders (`:finder ID`).

### `roster.finders.set(id, finder)`

Adds a finder, or replaces it.

**Parameters**

- `id` (`string`): The finder's id: `:finder ID` opens it.
- `finder` ([`Finder`](#finder)): Its title and items.

**Returns**

Nothing.

**Errors**

- `roster.finders.set: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a finder with that id from elsewhere.
- an item without a `label` or a `run`: the whole finder is dropped.

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.finders.set("pinned", {
  title = "Pinned Hosts",
  items = { { label = "esx-02", detail = "10.0.0.5", run = "open esx-02" } },
})
```

### `roster.finders.remove(id)`

Removes a finder.

**Parameters**

- `id` (`string`): One of the Plugin's finders.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.finders.remove("pinned")
```

## `roster.help`

Help pages (`:help TOPIC`).

### `roster.help.set(topic, page)`

Adds a help page, or replaces it. It's listed in the help index under the Plugin's name.

**Parameters**

- `topic` (`string`): The page's topic: `:help TOPIC`.
- `page` ([`HelpPage`](#helppage)): Its title, summary and Markdown.

**Returns**

Nothing.

**Errors**

- `roster.help.set: "TOPIC" isn't a name like …`: a bad `topic`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a page with that topic from elsewhere.
- no `markdown`.

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.help.set("pinned", {
  title = "Pinned Hosts",
  summary = "A Sidebar section of the Hosts you pin",
  markdown = "# Pinned Hosts\n\n`:pin HOST` adds a Host.",
})
```

### `roster.help.remove(topic)`

Removes a help page.

**Parameters**

- `topic` (`string`): One of the Plugin's pages.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.help.remove("pinned")
```

## `roster.health`

Sections of `:check`.

### `roster.health.set(id, section)`

Adds a section to `:check` (this Box's health), or replaces it. `:check` shows the checks as the Plugin last set them: it doesn't call the Plugin.

**Parameters**

- `id` (`string`): The section's id.
- `section` ([`HealthSection`](#healthsection)): Its title and checks.

**Returns**

Nothing.

**Errors**

- `roster.health.set: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a section with that id from elsewhere.
- a check whose `level` isn't `ok`, `warn` or `error`, or without a `message`.

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.health.set("recent-alerts", {
  title = "Recent alerts",
  checks = { { level = "warn", message = "terminal.read isn't granted", fix = "Allow it in :plugins" } },
})
```

### `roster.health.remove(id)`

Removes a `:check` section.

**Parameters**

- `id` (`string`): One of the Plugin's sections.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.health.remove("recent-alerts")
```

## `roster.tutor`

Tutorials (`:tutor ID`).

### `roster.tutor.set(id, tutorial)`

Adds a tutorial, or replaces it. `:tutor ID` runs it on the demo Inventory, where the Plugin itself isn't loaded: a step can wait for the Plugin's command to be run, but the command does nothing there.

**Parameters**

- `id` (`string`): The tutorial's id: `:tutor ID` runs it, `:help tutor-ID` is its page.
- `tutorial` ([`Tutorial`](#tutorial)): Its text and lessons.

**Returns**

Nothing.

**Errors**

- `roster.tutor.set: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a tutorial with that id, or a help page `tutor-ID`, from elsewhere.
- no lessons, a lesson without a `title`, a step without an `id` or `text`, an `id` used twice, or an `on` that names no tutor event.

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.tutor.set("pinned", {
  title = "Pinned Hosts",
  lessons = {
    { title = "Find them", text = "Your pinned Hosts have their own finder.",
      steps = { { id = "open", text = "Open it with `:finder pinned`",
                  on = { event = "command", id = "finder", arg = "pinned" } } } },
  },
})
```

### `roster.tutor.remove(id)`

Removes a tutorial.

**Parameters**

- `id` (`string`): One of the Plugin's tutorials.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.tutor.remove("pinned")
```

## `roster.badges`

Badges on Host rows.

### `roster.badges.set(host, text)`

Puts a badge on a Host's Inventory row, or takes it off. One badge per Host per Plugin; setting it again replaces it. A name that isn't a Host shows nowhere. The app draws it as a small chip right after the Host's name, in the text colour (never the accent, which means live), and cuts it after 12 characters; its tooltip and the row's accessible name have it whole, after your Plugin's name (`recent-alerts: 2`). So say the count, not what's counted: your Plugin's name says that.

**Parameters**

- `host` (`string`): The Host's name in the Inventory.
- `text` (`string?`, optional): The badge: keep it short, a count (`"2"`) or a word (at most 40 characters); `nil` takes it off.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.badges.set("esx-02", tostring(2))
roster.badges.set("esx-02", nil)
```

## `roster.float`

A floating window over the terminal.

### `roster.float.open(float)`

Opens a floating window over the terminal, or replaces the Plugin's. It lies over the terminal, on the side away from the Sidebar, so it never resizes a Session. `Esc` closes it. It has no actions.

**Parameters**

- `float` ([`Float`](#float)): Its title and lines.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.float.open({ title = "esx-02", lines = { "ERROR disk full", "at 10:42" } })
```

### `roster.float.close()`

Closes the Plugin's floating window. Another Plugin's stays.

**Parameters**

None.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.float.close()
```

## `roster.clipboard`

The clipboard.

### `roster.clipboard.copy(text)`

Puts text on the clipboard. Only while the user runs one of the Plugin's actions, commands or finder items, so a Plugin can't change what you copied behind your back. If the clipboard can't be written, the app says so, and the notices the call gave after the copy aren't shown.

**Parameters**

- `text` (`string`): What to put on the clipboard, at most 64 KB.

**Returns**

Nothing.

**Errors**

- `roster.clipboard.copy: only while the user runs one of your actions, commands or finder items`: at load or in an event listener.
- `roster.clipboard.copy: the text is over 65536 bytes`: the text is longer.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
actions = { { label = "Copy", icon = "copy", run = function() roster.clipboard.copy(line) end } }
```

## `roster.inventory`

Hosts, and Pending changes to them. `nil` unless the Plugin was granted `inventory.read` or `inventory.write`; each function is there only with its own permission. The functions wait for `roster serve`; that time doesn't count against the Plugin's budget.

### `roster.inventory.hosts()`

Every Host, in `roster.yml` order. From serve's [`hosts.list`](serve-api.md): while `roster.yml` doesn't load (an outside edit), the last good Hosts. The groups aren't in it: `roster.serve.call("hosts.list")` (with `serve:hosts.list`) has them.

**Parameters**

None.

**Returns**

- [`Host`](#host)`[]`: The Hosts, each with its Login references (a vault item's name, never a password).

**Errors**

- `roster.inventory.hosts: MESSAGE (code N)`: roster serve failed (see [Errors](#errors)).
- And [those of every function](#errors).

**Permission:** `inventory.read` · **Since:** api 2

**Example**

```lua
for _, h in ipairs(roster.inventory.hosts()) do
  if not h.reviewed then roster.badges.set(h.name, "review") end
end
```

### `roster.inventory.host(name)`

One Host, by its exact name. From serve's [`host.get`](serve-api.md). An unknown name is an error, not `nil`: wrap the call in `pcall` when the name came from the user.

**Parameters**

- `name` (`string`): The Host's exact name.

**Returns**

- [`Host`](#host): The Host.

**Errors**

- `roster.inventory.host: unknown host 'NAME' (code 2)`: no Host has that name.
- `roster.inventory.host: MESSAGE (code N)`: roster serve failed otherwise.
- And [those of every function](#errors).

**Permission:** `inventory.read` · **Since:** api 2

**Example**

```lua
local ok, h = pcall(roster.inventory.host, name)
if ok then roster.notify(name .. " is " .. h.ip) end
```

### `roster.inventory.update(host, changes)`

Changes a Host's fields, as a Pending change. serve's [`host.update`](serve-api.md#editing-pending-changes): `roster.yml` is edited as text (comments and every other entry stay) and the change waits for you to review and Publish it. A change to `ip`, `user`, `port` or `auth` needs a test login of exactly those values first (`host.verify_login`), which a Plugin can't make: from a Plugin those fail with code 75. Only `title`, `description` and `type` go through.

**Parameters**

- `host` (`string`): The Host's exact name.
- `changes` ([`Change`](#change)): The fields to change, and their new values.

**Returns**

- [`UpdateResult`](#updateresult): What was written.

**Errors**

- `roster.inventory.update: params.changes: … (code -32602)`: a field that can't be edited here, or a value of the wrong kind.
- `roster.inventory.update: unknown host 'NAME' (code 2)`: no Host has that name.
- `roster.inventory.update: … (code 75)`: a change to `ip`, `user`, `port` or `auth`.
- `roster.inventory.update: … (code 70 or 74)`: no git repo for Pending changes, or the edit wouldn't load as asked (nothing written).
- And [those of every function](#errors).

**Permission:** `inventory.write` · **Since:** api 2

**Example**

```lua
roster.inventory.update("esx-02", { description = "lab box, rack 3" })
```

### `roster.inventory.rename(host, to)`

Renames a Host, as a Pending change. serve's [`host.rename`](serve-api.md#the-live-inventory-hosts-and-groups-and-outside-edits): only its key in `roster.yml` and its name in `links:` change. Its vault item keeps its name.

**Parameters**

- `host` (`string`): The Host's exact name.
- `to` (`string`): Its new name.

**Returns**

- [`RenameResult`](#renameresult): What was written.

**Errors**

- `roster.inventory.rename: … (code 2)`: no Host has that name.
- `roster.inventory.rename: … (code 80 or 100)`: `to` isn't a valid name, or a Host or group has it.
- `roster.inventory.rename: … (code 1, 70 or 74)`: `roster.yml` doesn't load now, no git repo, or the edit wouldn't load as asked.
- And [those of every function](#errors).

**Permission:** `inventory.write` · **Since:** api 2

**Example**

```lua
roster.inventory.rename("esx-02", "esx-02-old")
```

### `roster.inventory.move(host, group)`

Moves a Host to another group, as a Pending change. serve's [`host.move`](serve-api.md#the-live-inventory-hosts-and-groups-and-outside-edits): what it inherited from its old group and wouldn't from the new one is written on the Host, so it stays the same Host.

**Parameters**

- `host` (`string`): The Host's exact name.
- `group` (`string`): The group to move it to (at its end).

**Returns**

- [`MoveResult`](#moveresult): What was written, and which fields were pinned on the Host.

**Errors**

- `roster.inventory.move: … (code 2)`: no Host has that name.
- `roster.inventory.move: … (code 101)`: no such group.
- `roster.inventory.move: … (code 103)`: it would still come out different in the new group.
- `roster.inventory.move: … (code 1, 70 or 74)`: `roster.yml` doesn't load now, no git repo, or the edit wouldn't load as asked.
- And [those of every function](#errors).

**Permission:** `inventory.write` · **Since:** api 2

**Example**

```lua
local r = roster.inventory.move("esx-02", "lab")
if #r.pinned > 0 then roster.notify("kept " .. table.concat(r.pinned, ", ")) end
```

### `roster.inventory.review(host, reviewed)`

Marks a Host reviewed (or not), as a Pending change. serve's [`host.review`](serve-api.md#adding-a-host-hostadd).

**Parameters**

- `host` (`string`): The Host's exact name.
- `reviewed` (`boolean?`, optional): `true` (the default) marks it reviewed; `false` un-reviews it.

**Returns**

- [`ReviewResult`](#reviewresult): What was written.

**Errors**

- `roster.inventory.review: … (code 2)`: no Host has that name.
- `roster.inventory.review: params.reviewed must be true or false (code -32602)`: `reviewed` isn't a boolean.
- `roster.inventory.review: … (code 70 or 74)`: no git repo, or the edit wouldn't load as asked.
- And [those of every function](#errors).

**Permission:** `inventory.write` · **Since:** api 2

**Example**

```lua
roster.inventory.review("esx-02")
```

## `roster.sessions`

Opening Sessions. `nil` unless the Plugin was granted `sessions.open`.

### `roster.sessions.open(host)`

Opens a Session on a Host, as `:connect HOST`. It happens after the call returns, as if the user ran `:connect HOST`: the app's own errors (an unknown or unreviewed Host, a locked vault) show as they would then.

**Parameters**

- `host` (`string`): The Host's exact name.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** `sessions.open` · **Since:** api 2

**Example**

```lua
roster.sessions.open("esx-02")
```

## `roster.terminal`

Typing into Sessions. `nil` unless the Plugin was granted `terminal.write`. Reading what Sessions print is the `terminal_output` event (`terminal.read`).

### `roster.terminal.send(session, text)`

Types into an open Session. A Session that has ended, or an id that's no Session's, takes nothing.

**Parameters**

- `session` (`integer`): The Session's id, from an event (`e.session`).
- `text` (`string`): What to type, as if the user typed it: `"uptime\n"` runs `uptime`.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- `text` over 64 KB is cut.

**Permission:** `terminal.write` · **Since:** api 2

**Example**

```lua
roster.on("session_open", function(e) roster.terminal.send(e.session, "uptime\n") end)
```

## `roster.serve`

roster serve's methods, by name. `nil` unless the Plugin was granted at least one `serve:<method>` permission.

### `roster.serve.call(method, params)`

Calls a roster serve method the Plugin was granted. A Plugin may be granted `inventory.info`, `hosts.list`, `host.get`, `host.check`, `changes.diff` and the `mesh.*` and `discover.*` methods; never one that reaches a secret. What each returns is under [roster serve's results](#roster-serves-results).

**Parameters**

- `method` (`string`): A roster serve method the Plugin was granted, by name (`serve:inventory.info` grants `inventory.info`).
- `params` (`table?`, optional): The method's params; `{}` if left out. Data only: no functions.

**Returns**

- `any`: The method's result, as Lua tables (JSON `null` is `nil`).

**Errors**

- `roster.serve.call: not granted (serve:METHOD)`: the Plugin wasn't granted that method.
- `roster.serve.call METHOD: MESSAGE (code N)`: the method failed (its codes are in [serve-api.md](serve-api.md)).
- And [those of every function](#errors).

**Permission:** `serve:<method>` (that method) · **Since:** api 2

**Example**

```lua
local info = roster.serve.call("inventory.info")
roster.status.set("box", { text = info.box .. ": " .. info.host_count .. " Hosts" })
```

## Events

`roster.on(event, function(e) … end)` runs the function with the event's payload. Listening for an event the Plugin may not hear is an error. Each needs any one of the permissions listed.

| Event | When | Payload | Needs |
|---|---|---|---|
| `lock` | The vault locked (the lock screen came up). | [`EmptyEvent`](#emptyevent) | nothing |
| `unlock` | The vault unlocked. | [`EmptyEvent`](#emptyevent) | nothing |
| `host_selected` | The Session on screen changed to a Host's. | [`HostSelectedEvent`](#hostselectedevent) | `inventory.read` or `terminal.read` |
| `session_open` | A Session started (or started again). | [`SessionOpenEvent`](#sessionopenevent) | `inventory.read` or `terminal.read` |
| `session_exit` | A Session ended, failed, or its tab was closed while it ran. | [`SessionExitEvent`](#sessionexitevent) | `inventory.read` or `terminal.read` |
| `inventory_changed` | The app got a new Host list (an edit, a pull, a Publish, an outside edit of `roster.yml`). | [`EmptyEvent`](#emptyevent) | `inventory.read` |
| `terminal_output` | A Session printed something: a few times a second, in batches. | [`TerminalOutputEvent`](#terminaloutputevent) | `terminal.read` |

## roster serve's results

What `roster.serve.call(method)` returns, for the methods a Plugin may be granted. JSON `null` is `nil`.

| Method | Result | In serve-api.md |
|---|---|---|
| `inventory.info` | [`InventoryInfo`](#inventoryinfo) | [inventory.info](serve-api.md) |
| `hosts.list` | [`HostList`](#hostlist) | [hosts.list](serve-api.md) |
| `host.get` | [`Host`](#host) | [host.get](serve-api.md) |
| `host.check` | [`HostCheck`](#hostcheck) | [host.check](serve-api.md#diagnostics-hostcheck) |
| `changes.diff` | [`ChangesDiff`](#changesdiff) | [changes.diff](serve-api.md#editing-pending-changes) |
| `mesh.*` | see serve-api.md | [mesh.*](serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus) |

## Types

### `Manifest`

`roster-plugin.lua`: who the Plugin is and what it asks for.

The file returns this table. It's read before any of the Plugin's code runs, for the install prompt, in the sandbox with no `roster` module and no `require`. Any other key is an error (`foo: not a manifest field`).

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | How it's known everywhere: lower case letters, digits and `-`, starting with a letter, at most 40. Not `builtin`, `init`, `roster` or a built-in Plugin's name. |
| `version` | `string` | yes | Its version, shown in `:plugins` (`"1.0.0"`). |
| `description` | `string` | no | One line on what it does, for the install prompt. |
| `author` | `string` | no | Who wrote it, for the install prompt (unverified). |
| `api` | `integer` | yes | The `roster.api_version` it's written for; above the app's, it doesn't install. |
| `permissions` | [`Permission`](#permission)`[]` | no | What it asks for. Each is shown in the install prompt, the risky ones flagged. |

### `Permission`

A permission's name, as a manifest writes it.

What each gives is in [Permissions](plugins.md#permissions). `network` isn't available yet; a serve method that reaches a secret can't be asked for.

One of: `"inventory.read" \| "inventory.write" \| "sessions.open" \| "terminal.read" \| "terminal.write" \| string`

### `Plugin`

`roster.plugin`: the Plugin itself.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Its name, from the manifest. |
| `version` | `string` | yes | Its version, from the manifest. |
| `permissions` | [`Permission`](#permission)`[]` | yes | What it runs with: what it asked for and was granted, sorted (`serve:` ones by method). |
| `config` | `table` | yes | Its settings from `init.lua` when it's a Package (`{ "owner/repo", config = { … } }`); else `{}`. Anyone can write anything there: check it. |

### `Os`

`roster.os`.

One of: `"windows" \| "linux" \| "macos"`

### `Level`

A notice's level.

One of: `"info" \| "warn" \| "error"`

### `Run`

What choosing a row, an action, a finder item or a status segment runs.

What choosing it runs: a function (called with an empty table; its return value is ignored) or a command line (`"open esx-02"`).

One of: `string \| fun(args: table): any`

### `CommandSpec`

`roster.commands.add`'s second argument.

| Field | Type | Required | Description |
|---|---|---|---|
| `desc` | `string` | no | Its description, for `:help commands` and completion. The name if left out. |
| `run` | `string\|fun(args: `[`CommandArgs`](#commandargs)`): any` | yes | A function, called with what followed the command, or a command line to run instead. |

### `CommandArgs`

What a command's function is called with.

| Field | Type | Required | Description |
|---|---|---|---|
| `args` | `string` | yes | Everything after the command's name, trimmed (`""` for none). |
| `words` | `string[]` | yes | `args` split at spaces (`{}` for none). |

### `KeyContext`

Where a Plugin's key binding works.

One of: `"leader" \| "list" \| "list_vim"`

### `Theme`

A Theme, as `init.lua`'s `themes` takes one.

The tokens and how a Theme starts from its `base` are in [Themes and colours](app/config.md#themes-and-colours).

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | `string` | no | Shown in the app; the id if left out. |
| `appearance` | `"dark"\|"light"` | no | Which OS appearance it suits; the base's if left out. |
| `base` | `string` | no | The Theme it starts from (a bundled one's id); Roster dark or Roster light by `appearance` if left out. |
| `colors` | `table<string, string>` | no | UI tokens it changes (`accent`, `bg`, …), as CSS colours. |
| `terminal` | `table<string, string>` | no | Terminal colours it changes (`background`, `foreground`, `cursor`, …). |
| `ansi` | `table<string, string>\|false` | no | The 16 ANSI colours (`red`, `bright_red`, …); `false` keeps the standard palette. The base's if left out. |

### `Section`

A Sidebar section (`roster.sidebar.set`).

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | no | Its heading; the id if left out. |
| `order` | `number` | no | Where it goes: Sessions is 100, the Inventory 300. 400 if left out. |
| `empty` | `string` | no | What it says with no rows. |
| `rows` | [`Row`](#row)`[]` | no | Its rows, at most 2,000. |

### `Row`

A row of a Sidebar section.

Text is cut to 500 characters.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | no | Unique in the section (at most 100 characters); its place in the list if left out. Keeps the selection on it across `set`s. |
| `label` | `string` | yes | Its text. |
| `detail` | `string` | no | A second, quieter text after the label. |
| `note` | `string` | no | A short note on the right. |
| `host` | `string` | no | Makes it the Host's row: Enter opens that Host (unless `run` says otherwise) and it lights up while the Host's Session is on screen. Never set it to a Quick Connect Session's `nil` host. |
| `badge` | `string` | no | A badge (at most 40 characters). |
| `count` | `number` | no | A count on the right. |
| `level` | `number` | no | How far it's indented, 0 to 8. |
| `title` | `string` | no | Its tooltip. |
| `run` | [`Run`](#run) | no | What Enter runs. With `host` and no `run`, it opens the Host; with neither, nothing. |
| `actions` | [`RowAction`](#rowaction)`[]` | no | Buttons on the row. |

### `RowAction`

A button on a row.

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | `string` | yes | What it does, for its tooltip and screen readers (`"Unpin esx-02"`). |
| `icon` | [`RowIcon`](#rowicon) | no | Its icon; `info` if left out. |
| `run` | [`Run`](#run) | yes | What pressing it runs. |

### `RowIcon`

A row action's icon.

One of: `"close" \| "edit" \| "add" \| "addGroup" \| "review" \| "unreview" \| "info" \| "copy"`

### `StatusSegment`

A status bar segment (`roster.status.set`).

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | yes | Its text, at most 80 characters. |
| `title` | `string` | no | Its tooltip. |
| `run` | [`Run`](#run) | no | What clicking it runs. |

### `Finder`

A finder (`roster.finders.set`).

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | no | Its title and prompt; the id if left out. |
| `items` | [`FinderItem`](#finderitem)`[]` | no | What it finds in, at most 2,000. |

### `FinderItem`

One thing a finder lists.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | no | Unique in the finder; its place in the list if left out. |
| `label` | `string` | yes | What's matched and shown. |
| `detail` | `string` | no | Shown after the label, and matched too. |
| `path` | `string` | no | Where it is, shown quieter (`lab › esx-02`). |
| `run` | [`Run`](#run) | yes | What Enter runs. |

### `HelpPage`

A help page (`roster.help.set`).

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | no | Its title; the topic if left out. |
| `summary` | `string` | no | One line for the index and the topic finder; the title if left out. |
| `markdown` | `string` | yes | The page, as Markdown (at most 200,000 characters): headings, paragraphs, lists, tables, code, links. |

### `HealthSection`

A section of `:check` (`roster.health.set`).

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | no | Its heading; the id if left out. |
| `checks` | [`HealthCheck`](#healthcheck)`[]` | no | Its lines. |

### `HealthCheck`

One line of a `:check` section.

| Field | Type | Required | Description |
|---|---|---|---|
| `level` | `"ok"\|"warn"\|"error"` | yes | How it went. |
| `message` | `string` | yes | What it found. |
| `fix` | `string` | no | What to do about it, in a sentence. |

### `Tutorial`

A tutorial (`roster.tutor.set`).

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | no | Its title; the id if left out. |
| `summary` | `string` | no | One line for `:tutor` and the help index; the title if left out. |
| `intro` | `string` | no | Markdown before the first lesson. |
| `lessons` | [`Lesson`](#lesson)`[]` | yes | At least one. |
| `outro` | `string` | no | Markdown after the last lesson. |

### `Lesson`

A lesson of a tutorial.

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | yes | Its heading (at most 100 characters). |
| `text` | `string` | no | Markdown before its steps. |
| `steps` | [`Step`](#step)`[]` | no | What to do, in order. |

### `Step`

A step of a lesson: done when the app sends a matching event.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | Unique in the tutorial: what the State keeps once it's done. |
| `text` | `string` | yes | What to do (Markdown). |
| `on` | [`StepMatch`](#stepmatch)`\|`[`StepMatch`](#stepmatch)`[]` | yes | The event that ticks it, or a list of them (any one does). |

### `StepMatch`

An event a step waits for.

These are the app's own events, sent only to the tutorial running, on the demo Inventory; the Plugin's code never sees them.

| `event` | Its fields |
|---|---|
| `command` | `id` (the command, `theme`), `arg` (what followed it, `nord`): every command run, from a key, a button or the command line |
| `session_open`, `session_exit`, `host_selected` | `host` |
| `help_open`, `help_back`, `help_forward` | `page`, `anchor` |
| `help_search` | `page`, `query` |

| Field | Type | Required | Description |
|---|---|---|---|
| `event` | [`TutorEvent`](#tutorevent) | yes | The event's name. |
| `[string]` | `string` | no | Any other key is a field the event must have, equal ignoring case; `"*"` means it's there, `""` that it isn't. |

### `TutorEvent`

The events a tutorial's step can wait for.

One of: `"command" \| "session_open" \| "session_exit" \| "host_selected" \| "help_open" \| "help_back" \| "help_forward" \| "help_search"`

### `Float`

A floating window (`roster.float.open`).

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | no | Its title. |
| `lines` | `string[]` | no | Its text, a line each (at most 2,000, each cut to 500 characters). |

### `Host`

A Host, as roster serve's `hosts.list` and `host.get` give it.

Every value is resolved: what the Host doesn't set comes from its group, then `defaults:`. JSON `null` is `nil` in Lua, so an unset optional field is `nil`. A Host also carries any other key `roster.yml` gives it, its group or `defaults:` (as roster.yml has it): read only the fields below. No field ever holds a password: `auth` is a [LoginRef](#loginref).

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Its name in the Inventory, unique. |
| `group` | `string` | yes | The group it's in. |
| `ip` | `string` | yes | Its address (an IP or a DNS name). |
| `ssh` | [`SshLogin`](#sshlogin) | yes | How roster logs in to it over ssh. |
| `login` | [`Login`](#login) | yes | The default Login for its services. |
| `services` | `table<string, `[`Service`](#service)`>` | yes | Its services by name (`web`, `postgres`). `{}` when there are none. |
| `problems` | [`ServiceProblem`](#serviceproblem)`[]` | yes | Service entries roster left out because it can't use them. `{}` when there are none. |
| `web` | `string` | no | Its web UI's URL: the `web` service's, else the first service given a URL. |
| `enroll` | `boolean` | yes | Whether `roster setup` puts this Box's key on it (`false`: password Sessions). |
| `reviewed` | `boolean` | yes | `false` for a Host `discover` added and no one has reviewed: it can't be opened until it is. |
| `mesh` | `boolean` | no | `mesh:` as roster.yml sets it; `nil` if nothing does. |
| `title` | `string` | yes | One line; `""` if unset. |
| `description` | `string` | yes | One line; `""` if unset. |
| `type` | `string` | yes | What it is (`esxi`, `linux`); `""` if unset. |
| `product` | `string` | yes | Its product; `""` if unset. |
| `mac` | `string` | yes | Its MAC address; `""` if unset. |
| `notes` | `string` | yes | The older name for `description`, as roster.yml has it. |
| `user` | `string` | yes | The same as `ssh.user` (kept for older code). |
| `port` | `integer` | yes | The same as `ssh.port`. |
| `auth` | [`LoginRef`](#loginref) | yes | The same as `ssh.auth`. |

### `LoginRef`

A Login reference: where a password is, never the password.

`PROVIDER:ITEM`, a vault item's name (`bw:esx-02 ssh`, `op:Lab/esx-02#password`, `kp:esx-02 ssh`), or `prompt` (asked for), `agent` (an ssh key), `key`, `none`. `env:VAR` and `cmd:COMMAND` are references too: they name a variable or a command, and a Plugin sees that text. The providers are in [Password providers](cli-reference.md#password-providers).

One of: `string`

### `SshLogin`

A Host's ssh login.

| Field | Type | Required | Description |
|---|---|---|---|
| `user` | `string` | yes | The user. |
| `port` | `integer` | yes | The port (22 unless set). |
| `auth` | [`LoginRef`](#loginref) | yes | Its Login (`prompt` unless set). |

### `Login`

A Host's default Login for its services (`login:` in roster.yml).

| Field | Type | Required | Description |
|---|---|---|---|
| `user` | `string` | no | The user; `nil` if unset. |
| `auth` | [`LoginRef`](#loginref) | no | The Login; `nil` if unset. |

### `Service`

One of a Host's services, resolved.

| Field | Type | Required | Description |
|---|---|---|---|
| `port` | `integer` | yes | Its port. |
| `url` | `string` | no | Its URL, for http and https services. |
| `scheme` | `string` | no | `http`, `https`, or `nil` when roster can't tell. |
| `user` | `string` | no | Its user: its own, else the Host's `login.user`. |
| `auth` | [`LoginRef`](#loginref) | no | Its Login: its own, else the Host's `login.auth`. |
| `verify` | `boolean` | yes | Whether its TLS certificate is checked. |
| `login` | `string` | yes | How `roster web` signs in: `basic`, `bearer`, `vsphere`, `unifi`, `openvpnas`, `hub` or `none`. |
| `override` | `boolean` | yes | `true` when it has a Login of its own; `false` when it uses the Host's. |

### `ServiceProblem`

A service entry roster left out of a Host.

| Field | Type | Required | Description |
|---|---|---|---|
| `service` | `string` | yes | The service's name. |
| `message` | `string` | yes | What's wrong, naming the service. |
| `fix` | `string` | yes | What to change. |

### `Group`

A group of Hosts, as `hosts.list` gives it.

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | yes | One line; `""` if unset. |
| `description` | `string` | yes | One line; `""` if unset. |

### `Change`

`roster.inventory.update`'s changes: the fields to change.

At least one. Text is one line (spaces collapse, as roster.yml's loader reads it).

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | no | One line. |
| `description` | `string` | no | One line. |
| `type` | `string` | no | One line. |
| `ip` | `string` | no | No spaces, not empty. Needs a test login first: refused from a Plugin (code 75). |
| `user` | `string` | no | No spaces, not empty. Refused from a Plugin (code 75). |
| `port` | `integer` | no | 1 to 65535. Refused from a Plugin (code 75). |
| `auth` | [`LoginRef`](#loginref) | no | Refused from a Plugin (code 75). |

### `UpdateResult`

What `roster.inventory.update` wrote.

| Field | Type | Required | Description |
|---|---|---|---|
| `changed` | `boolean` | yes | `false` when the Host already had those values (nothing written). |
| `host` | [`Host`](#host) | yes | The Host as it loads now. |
| `backup` | `string` | no | Where `roster.yml` as it was is kept; `nil` when nothing changed. |
| `warnings` | `string[]` | no | What failed after the write; `nil` when nothing changed. |

### `RenameResult`

What `roster.inventory.rename` wrote.

| Field | Type | Required | Description |
|---|---|---|---|
| `changed` | `boolean` | yes | `false` when `to` is its name already. |
| `host` | [`Host`](#host) | yes | The Host as it loads now. |
| `backup` | `string` | no | Where `roster.yml` as it was is kept; `nil` when nothing changed. |

### `MoveResult`

What `roster.inventory.move` wrote.

| Field | Type | Required | Description |
|---|---|---|---|
| `changed` | `boolean` | yes | `false` when it's in that group already. |
| `host` | [`Host`](#host) | yes | The Host as it loads now. |
| `pinned` | `string[]` | yes | The fields written on the Host so it stays the same Host. |
| `backup` | `string` | no | Where `roster.yml` as it was is kept; `nil` when nothing changed. |

### `ReviewResult`

What `roster.inventory.review` wrote.

| Field | Type | Required | Description |
|---|---|---|---|
| `changed` | `boolean` | yes | `false` when it already was. |
| `host` | [`Host`](#host) | yes | The Host as it loads now. |
| `backup` | `string` | no | Where `roster.yml` as it was is kept; `nil` when nothing changed. |

### `InventoryInfo`

`inventory.info`'s result.

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | yes | `roster.yml`'s full path. |
| `box` | `string` | yes | This Box's name. |
| `host_count` | `integer` | yes | How many Hosts. |
| `providers` | `string[]` | yes | The password providers roster has. |
| `roster_version` | `string` | yes | roster's version. |
| `api_version` | `integer` | yes | roster serve's API version (not `roster.api_version`). |

### `HostList`

`hosts.list`'s result.

| Field | Type | Required | Description |
|---|---|---|---|
| `hosts` | [`Host`](#host)`[]` | yes | Every Host, in `roster.yml` order. |
| `groups` | `table<string, `[`Group`](#group)`>` | yes | Every group, by name. |
| `error` | [`InventoryError`](#inventoryerror) | no | Why `roster.yml` as it is now doesn't load, while these are the last good Hosts; `nil` when it loads. |

### `InventoryError`

Why `roster.yml` doesn't load right now.

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | `string` | yes | What's wrong. |
| `path` | `string` | no | The file. |
| `line` | `integer` | no | The line, when roster knows it. |
| `fix` | `string` | no | What to do. |

### `HostCheck`

`host.check`'s result: the steps of `roster check HOST`.

| Field | Type | Required | Description |
|---|---|---|---|
| `host` | `string` | yes | The Host. |
| `ok` | `boolean` | yes | Whether every step passed. |
| `steps` | [`CheckStep`](#checkstep)`[]` | yes | Every step, in order: `inventory`, `ssh-config`, `provider`, `vault-item`, `dns`, `tcp`, `host-key`, `auth`. |

### `CheckStep`

One step of a `host.check`.

| Field | Type | Required | Description |
|---|---|---|---|
| `step` | `string` | yes | Its name. |
| `status` | `"ok"\|"fail"\|"skipped"` | yes | How it went; every step after a `fail` is `skipped`. |
| `message` | `string` | yes | What happened. |
| `code` | `integer` | no | A failed step's error code (serve-api.md's tables). |
| `fix` | `string` | no | What to do, in a sentence. |
| `details` | `string` | no | The raw text, when there is one (ssh's stderr). |
| `data` | `table` | no | What the code's row says it carries. |

### `ChangesDiff`

`changes.diff`'s result: the Pending changes.

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | yes | `roster.yml`'s path. |
| `repo` | `string` | yes | The infra repo's top folder. |
| `diff` | `string` | yes | git's diff of `roster.yml` against the last commit; `""` for none. |
| `hosts` | [`HostChange`](#hostchange)`[]` | yes | The Hosts it changes. |
| `groups` | [`GroupChange`](#groupchange)`[]` | yes | The groups it changes. |
| `count` | `integer` | yes | How many Hosts change (1 for a change that touches none, 0 for no change). |
| `message` | `string` | yes | The commit message Publish would write. |
| `last_commit` | [`LastCommit`](#lastcommit) | no | The branch's last commit; `nil` in a repo with none. |

### `HostChange`

A Host in `changes.diff`.

| Field | Type | Required | Description |
|---|---|---|---|
| `host` | `string` | yes | Its name. |
| `change` | `"changed"\|"added"\|"removed"` | yes | What happened to it. |
| `fields` | `string[]` | yes | For `changed`, the fields that did. |

### `GroupChange`

A group in `changes.diff`.

| Field | Type | Required | Description |
|---|---|---|---|
| `group` | `string` | yes | Its name. |
| `change` | `"changed"\|"added"\|"removed"` | yes | What happened to it. |

### `LastCommit`

The infra repo's last commit.

| Field | Type | Required | Description |
|---|---|---|---|
| `commit` | `string` | yes | Its hash. |
| `subject` | `string` | yes | Its subject line. |
| `upstream` | `string` | no | The branch's upstream (`origin/main`); `nil` without one. |
| `pushed` | `boolean` | yes | Whether the upstream has it, as this Box last fetched. |

### `EventName`

An event a Plugin can listen for.

One of: `"lock" \| "unlock" \| "host_selected" \| "session_open" \| "session_exit" \| "inventory_changed" \| "terminal_output"`

### `EmptyEvent`

The payload of `lock`, `unlock` and `inventory_changed`: an empty table.

No fields.

### `HostSelectedEvent`

`host_selected`'s payload.

| Field | Type | Required | Description |
|---|---|---|---|
| `host` | `string` | yes | The Host whose Session is on screen now. |

### `SessionOpenEvent`

`session_open`'s payload.

| Field | Type | Required | Description |
|---|---|---|---|
| `session` | `integer` | yes | The Session's id: `roster.terminal.send` takes it. |
| `host` | `string` | no | The Host's name; `nil` for a Quick Connect Session (`:quick`), which isn't on a Host: don't badge it or make a row go to it. |

### `SessionExitEvent`

`session_exit`'s payload.

| Field | Type | Required | Description |
|---|---|---|---|
| `session` | `integer` | yes | The Session's id. |
| `host` | `string` | no | The Host's name; `nil` for a Quick Connect Session, and for a tab closed while it ran. |
| `code` | `integer` | no | ssh's exit code; `nil` when it failed to start or its tab was closed. |

### `TerminalOutputEvent`

`terminal_output`'s payload.

What you type into a Session is never an event, but the shell echoes it back, so it's here like anything else the Session prints.

| Field | Type | Required | Description |
|---|---|---|---|
| `session` | `integer` | yes | The Session's id. |
| `host` | `string` | no | The Host's name; `nil` for a Quick Connect Session. |
| `text` | `string` | yes | What it printed since the last one, as text without colours or escape sequences (at most the last 16 KB); a cursor move to a row is a line break. A line can be split across two batches. Right after the app resizes the Session, the screen it prints again (ConPTY does on Windows, and full-screen programs redraw) isn't sent: for a second, lines it already sent lately are left out, and only new ones come. |

## Editor support

[`examples/plugins/types/roster.lua`](../examples/plugins/types/roster.lua) declares all of the above as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations (`---@meta`), so [lua-language-server](https://luals.github.io/) completes `roster.` and checks your types, the way Neovim's `vim` annotations do. `:help plugin-types` shows it in the app. Copy it into your Plugin's folder as `types/roster.lua` (or anywhere), and point lua-language-server at it with a `.luarc.json` next to `init.lua`:

```json
{
  "runtime.version": "Lua 5.4",
  "workspace.library": ["types"],
  "diagnostics.globals": ["roster"]
}
```

Then annotate what you hand the app, and lua-language-server checks it:

```lua
---@type roster.Row[]
local rows = {}

---@param e roster.TerminalOutputEvent
roster.on("terminal_output", function(e) … end)
```

`lua-language-server --check .` does the same from a terminal or CI; roster's CI checks the example Plugins that way. The file is generated with this page: a copy from an older roster lacks what's new.

## See also

[Writing a Plugin](plugins.md) · [The roster serve API](serve-api.md) · [Your init.lua](app/config.md) · [How far roster bends](app/extending.md)
