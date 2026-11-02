# The Plugin API

<!-- Generated from crates/roster-core/src/plugin/api.rs by `cargo run -p roster-core --example gen_plugin_api`: edit that, then run it. -->

Every function, value, event and data type of the `roster` Lua module a Plugin gets, `roster.api_version` 4. How to write, install and trust a Plugin is the guide, [Writing a Plugin](plugins.md); this is the reference. Each entry is a help topic: `:help roster.inventory.host()` for a function, `:help roster-Host` for a type.

Types are written as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations write them: `string?` may be `nil`, `Host[]` is a list of Hosts, `table<string, Group>` a table of Groups by name, `"info"|"warn"` one of those strings. The same declarations are [`roster.lua`](../examples/plugins/types/roster.lua), for [your editor](#editor-support).

## The Lua

roster embeds **Lua 5.4** (built into the app, nothing to install), not LuaJIT as Neovim does; [why](adr/0006-lua-plugins-and-packages.md#why-lua-54-not-luajit). Coming from Neovim:

- Integers are real 64-bit integers (`3 // 2` is `1`, `math.type(1)` is `"integer"`), and the bitwise operators are native (`a & b`, `a | b`, `~a`, `a << 2`): there's no `bit` library.
- `goto`, `<const>` and `<close>` locals work; there's no `jit` and no FFI.
- The API is `roster.*`, never `vim.*`: there's no `vim.api`, `vim.fn`, `vim.loop` or `vim.schedule`.
- It runs in the [sandbox](app/config.md#the-sandbox): the base functions, `string`, `table`, `math`, `utf8` and an `os` with only `time`, `clock`, `date` and `difftime`. `coroutine` too (since api 3: a coroutine runs within the same time budget and memory limit). No `io`, no `os.execute`, no `debug`, no `package` and no C modules; `load` takes text only, and `require` loads only from the Plugin's own folder (`name.lua`, `name/init.lua`, or the same under `lua/`).
- `pairs` visits a table's keys in order: numbers, then text, then the rest. So the same state always makes the same changes in the same order, on every machine; `next` is Lua's own.
- An empty table is `{}` to the app, whether you meant a list or a table of fields: the app takes `{}` as an empty list wherever it wants one (`rows = {}`, `items = {}`).
- It runs on a thread of its own with a memory limit and a time budget per call: see [Limits](plugins.md#limits).

## Index

| Function | What it does | Permission |
|---|---|---|
| [`roster.api_version`](#rosterapi_version) | The version of the `roster` module this app has | none |
| [`roster.os`](#rosteros) | The OS the app runs on | none |
| [`roster.plugin`](#rosterplugin) | The Plugin itself: its name, version, what it was granted and its settings | none |
| [`roster.notify(text, level, opts)`](#rosternotifytext-level-opts) | Shows a notice, naming the Plugin | none |
| [`roster.on(event, listener)`](#rosteronevent-listener) | Runs a function on an event | none |
| [`roster.confirm(question)`](#rosterconfirmquestion) | Asks the user to confirm, then runs a function | none |
| [`roster.cmd(line)`](#rostercmdline) | Runs a command line | none |
| [`roster.echo(text, opts)`](#rosterechotext-opts) | Answers on the message line, as roster's own commands do | none |
| [`roster.cmdline(text)`](#rostercmdlinetext) | Opens the command line with text typed in | none |
| [`roster.has(permission)`](#rosterhaspermission) | Whether the Plugin was granted a permission | none |
| [`roster.defer(ms, fn)`](#rosterdeferms-fn) | Runs a function once, later | none |
| [`roster.every(ms, fn)`](#rostereveryms-fn) | Runs a function again and again, until it's cancelled | none |
| [`roster.cancel(timer)`](#rostercanceltimer) | Cancels a timer | none |
| [`roster.commands.add(name, spec)`](#rostercommandsaddname-spec) | Adds a `:` command | none |
| [`roster.commands.remove(name)`](#rostercommandsremovename) | Removes one of the Plugin's commands | none |
| [`roster.keymap.set(context, keys, action)`](#rosterkeymapsetcontext-keys-action) | Binds keys to a command line | none |
| [`roster.keymap.del(context, keys)`](#rosterkeymapdelcontext-keys) | Takes one of the Plugin's key bindings off | none |
| [`roster.themes.define(id, theme)`](#rosterthemesdefineid-theme) | Adds a Theme | none |
| [`roster.themes.remove(id)`](#rosterthemesremoveid) | Removes one of the Plugin's Themes | none |
| [`roster.sidebar.set(id, section)`](#rostersidebarsetid-section) | Adds a Sidebar section, or replaces it | none |
| [`roster.sidebar.remove(id)`](#rostersidebarremoveid) | Removes a Sidebar section | none |
| [`roster.status.set(id, segment)`](#rosterstatussetid-segment) | Adds a status bar segment, or replaces it | none |
| [`roster.status.remove(id)`](#rosterstatusremoveid) | Removes a status bar segment | none |
| [`roster.finders.set(id, finder)`](#rosterfinderssetid-finder) | Adds a finder, or replaces it | none |
| [`roster.finders.remove(id)`](#rosterfindersremoveid) | Removes a finder | none |
| [`roster.help.set(topic, page)`](#rosterhelpsettopic-page) | Adds a help page, or replaces it | none |
| [`roster.help.remove(topic)`](#rosterhelpremovetopic) | Removes a help page | none |
| [`roster.health.set(id, section)`](#rosterhealthsetid-section) | Adds a section to `:check` (this Box's health), or replaces it | none |
| [`roster.health.answer(check, lines)`](#rosterhealthanswercheck-lines) | Answers a `:check` section's check that returned `"later"` | none |
| [`roster.health.remove(id)`](#rosterhealthremoveid) | Removes a `:check` section | none |
| [`roster.tutor.set(id, tutorial)`](#rostertutorsetid-tutorial) | Adds a tutorial, or replaces it | none |
| [`roster.tutor.remove(id)`](#rostertutorremoveid) | Removes a tutorial | none |
| [`roster.toolbar.set(id, control)`](#rostertoolbarsetid-control) | Adds a control to the toolbar, or replaces it | none |
| [`roster.toolbar.remove(id)`](#rostertoolbarremoveid) | Removes a toolbar control | none |
| [`roster.progress.set(id, progress)`](#rosterprogresssetid-progress) | Shows or updates the progress of something long | none |
| [`roster.progress.remove(id)`](#rosterprogressremoveid) | Takes a progress away: it's over | none |
| [`roster.badges.set(host, text)`](#rosterbadgessethost-text) | Puts a badge on a Host's Inventory row, or takes it off | none |
| [`roster.float.open(float)`](#rosterfloatopenfloat) | Opens a floating window over the terminal, or replaces the Plugin's | none |
| [`roster.float.close()`](#rosterfloatclose) | Closes the Plugin's floating window | none |
| [`roster.views.set(id, view)`](#rosterviewssetid-view) | Adds a view, or replaces it | none |
| [`roster.views.update(id, changes)`](#rosterviewsupdateid-changes) | Changes some of a view's rows or nodes in place, or its text or facts | none |
| [`roster.views.open(id, opts)`](#rosterviewsopenid-opts) | Opens a view | none |
| [`roster.views.close(id)`](#rosterviewscloseid) | Closes a view, if it's open | none |
| [`roster.views.remove(id)`](#rosterviewsremoveid) | Removes a view | none |
| [`roster.details.set(id, host, section)`](#rosterdetailssetid-host-section) | Adds a section to a Host's details, or replaces it | none |
| [`roster.details.remove(id)`](#rosterdetailsremoveid) | Removes a section from every Host's details | none |
| [`roster.clipboard.copy(text)`](#rosterclipboardcopytext) | Puts text on the clipboard | none |
| [`roster.storage.read(name)`](#rosterstoragereadname) | Reads one of the Plugin's files | none |
| [`roster.storage.write(name, text)`](#rosterstoragewritename-text) | Writes one of the Plugin's files, whole | none |
| [`roster.storage.list()`](#rosterstoragelist) | The names of the Plugin's files | none |
| [`roster.storage.remove(name)`](#rosterstorageremovename) | Removes one of the Plugin's files | none |
| [`roster.storage.read_json(name)`](#rosterstorageread_jsonname) | Reads one of the Plugin's files as JSON | none |
| [`roster.storage.write_json(name, value)`](#rosterstoragewrite_jsonname-value) | Writes one of the Plugin's files as JSON, whole | none |
| [`roster.inventory.hosts()`](#rosterinventoryhosts) | Every Host, in `roster.yml` order | `inventory.read` |
| [`roster.inventory.host(name)`](#rosterinventoryhostname) | One Host, by its exact name | `inventory.read` |
| [`roster.inventory.groups()`](#rosterinventorygroups) | Every group, by name | `inventory.read` |
| [`roster.inventory.request(done)`](#rosterinventoryrequestdone) | Reads every Host and group without waiting: `done` gets them | `inventory.read` |
| [`roster.inventory.update(host, changes)`](#rosterinventoryupdatehost-changes) | Changes a Host's fields, as a Pending change | `inventory.write` |
| [`roster.inventory.rename(host, to)`](#rosterinventoryrenamehost-to) | Renames a Host, as a Pending change | `inventory.write` |
| [`roster.inventory.move(host, group)`](#rosterinventorymovehost-group) | Moves a Host to another group, as a Pending change | `inventory.write` |
| [`roster.inventory.review(host, reviewed)`](#rosterinventoryreviewhost-reviewed) | Marks a Host reviewed (or not), as a Pending change | `inventory.write` |
| [`roster.sessions.show(session, line)`](#rostersessionsshowsession-line) | Goes to a Session, and to a line in its scrollback | none |
| [`roster.sessions.list()`](#rostersessionslist) | The Sessions open now, in the order they opened | `inventory.read` or `terminal.read` |
| [`roster.sessions.open(host)`](#rostersessionsopenhost) | Opens a Session on a Host, as `:connect HOST` | `sessions.open` |
| [`roster.terminal.send(session, text)`](#rosterterminalsendsession-text) | Types into an open Session | `terminal.write` |
| [`roster.serve.call(method, params)`](#rosterservecallmethod-params) | Calls a roster serve method the Plugin was granted | `serve:<method>` (that method) |
| [`roster.serve.request(method, params, done)`](#rosterserverequestmethod-params-done) | Asks roster serve without waiting: `done` gets the answer | `serve:<method>` (that method) |
| [`roster.http.request(request, done)`](#rosterhttprequestrequest-done) | Sends an HTTP request to a site the Plugin was granted | `network:<site>` (that site) |
| [`roster.http.get(url, done)`](#rosterhttpgeturl-done) | Fetches a URL from a site the Plugin was granted | `network:<site>` (that site) |

| Type | What it is |
|---|---|
| [`Manifest`](#manifest) | `roster-plugin.lua`: who the Plugin is and what it asks for |
| [`Permission`](#permission) | A permission's name, as a manifest writes it |
| [`Plugin`](#plugin) | `roster.plugin`: the Plugin itself |
| [`Os`](#os) | `roster.os` |
| [`Timer`](#timer) | A timer's id, from `roster.defer` or `roster.every` |
| [`Level`](#level) | A notice's level |
| [`Run`](#run) | What choosing a row, an action, a finder item or a status segment runs |
| [`HandlerContext`](#handlercontext) | What a row's, a button's, a finder item's, a status segment's, a toolbar control's, a question's, a progress's or a `:check` section's function is called with |
| [`CommandSpec`](#commandspec) | `roster.commands.add`'s second argument |
| [`CommandArgs`](#commandargs) | What a command's function is called with |
| [`KeyContext`](#keycontext) | Where a Plugin's key binding works |
| [`Theme`](#theme) | A Theme, as `init.lua`'s `themes` takes one |
| [`Section`](#section) | A Sidebar section (`roster.sidebar.set`) |
| [`Row`](#row) | A row of a Sidebar section |
| [`NoticeOptions`](#noticeoptions) | What else a notice has (`roster.notify`, since api 3) |
| [`EchoOptions`](#echooptions) | How a line on the message line is said (`roster.echo`, since api 4) |
| [`ViewOpenOptions`](#viewopenoptions) | Where a view opens (`roster.views.open`, since api 4) |
| [`NoticeAction`](#noticeaction) | A button on a notice |
| [`RowAction`](#rowaction) | A button on a row |
| [`HeadAction`](#headaction) | A button on a view's or a Host-details section's heading |
| [`RowIcon`](#rowicon) | A row action's icon |
| [`RowGlyph`](#rowglyph) | A Sidebar row's glyph (since api 3) |
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
| [`FloatAction`](#floataction) | A button in a floating window |
| [`Link`](#link) | A web page a floating window links to |
| [`Confirm`](#confirm) | A question the user answers (`roster.confirm`) |
| [`Progress`](#progress) | How far something long has got (`roster.progress.set`) |
| [`ToolbarControl`](#toolbarcontrol) | A control in the toolbar (`roster.toolbar.set`) |
| [`ToolbarIcon`](#toolbaricon) | A toolbar control's icon |
| [`View`](#view) | A side panel or a full view (`roster.views.set`) |
| [`ViewPlace`](#viewplace) | Where a view goes |
| [`ViewUpdate`](#viewupdate) | What `roster.views.update` changes |
| [`DetailsSection`](#detailssection) | A section of a Host's details (`roster.details.set`) |
| [`Fact`](#fact) | A label and its value |
| [`Table`](#table) | A table: columns, rows as plain data, and what a row can do |
| [`Column`](#column) | A table's column |
| [`ColumnKind`](#columnkind) | How a column's values read and sort |
| [`TableRow`](#tablerow) | A row of a table: plain data |
| [`RowTone`](#rowtone) | How a table row is marked |
| [`TableAction`](#tableaction) | Something a table's selected row can do |
| [`TableRun`](#tablerun) | What a table's row or action runs |
| [`TableEvent`](#tableevent) | What a table's function gets |
| [`HttpRequest`](#httprequest) | What `roster.http.request` sends |
| [`HttpResponse`](#httpresponse) | What a site answered |
| [`Graph`](#graph) | A graph: nodes, edges and clusters as plain data, and what a node can do |
| [`GraphNode`](#graphnode) | A node of a graph: plain data |
| [`NodeShape`](#nodeshape) | How a node is drawn |
| [`NodeState`](#nodestate) | What a node is doing |
| [`NodeMark`](#nodemark) | A node's mark |
| [`GraphEdge`](#graphedge) | An edge of a graph: plain data |
| [`EdgeDir`](#edgedir) | Which way an edge goes |
| [`EdgeStyle`](#edgestyle) | An edge's line |
| [`EdgeTone`](#edgetone) | How an edge is marked |
| [`GraphCluster`](#graphcluster) | A cluster of a graph's nodes |
| [`GraphReach`](#graphreach) | How far a graph's reach goes |
| [`GraphFilter`](#graphfilter) | What a graph shows: the rest is hidden |
| [`FilterState`](#filterstate) | A state a graph's filter keeps |
| [`NodeAction`](#nodeaction) | Something a graph's selected node can do |
| [`NodeRun`](#noderun) | What a graph's node or action runs |
| [`NodeEvent`](#nodeevent) | What a graph's function gets |
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
| [`CheckJob`](#checkjob) | `host.check_job`'s result: a Host's check, and how it came out |
| [`CheckStep`](#checkstep) | One step of a `host.check` |
| [`ChangesDiff`](#changesdiff) | `changes.diff`'s result: the Pending changes |
| [`HostChange`](#hostchange) | A Host in `changes.diff` |
| [`GroupChange`](#groupchange) | A group in `changes.diff` |
| [`LastCommit`](#lastcommit) | The infra repo's last commit |
| [`MeshResult`](#meshresult) | `mesh.plan`'s and `mesh.apply`'s result |
| [`MeshLink`](#meshlink) | A Link of the Mesh: a source reaching a peer |
| [`MeshHost`](#meshhost) | A Host a Mesh run visited |
| [`MeshStarted`](#meshstarted) | A Mesh run started with `background = true` |
| [`MeshCut`](#meshcut) | `mesh.cut`'s result |
| [`MeshCutChange`](#meshcutchange) | The `mesh: false` a `mesh.cut` writes into `roster.yml` |
| [`MeshStatus`](#meshstatus) | `mesh.status`'s result: the Mesh as `roster.yml` asks for it |
| [`MeshJob`](#meshjob) | `mesh.job`'s result: how far a Mesh run has got |
| [`ServeError`](#serveerror) | An error roster serve answered with |
| [`MeshStop`](#meshstop) | `mesh.stop`'s result |
| [`DiscoverPlan`](#discoverplan) | `discover.plan`'s result: what a scan would visit |
| [`DiscoverStatus`](#discoverstatus) | `discover.status`'s and `discover.start`'s result: how far a scan has got |
| [`DiscoverFound`](#discoverfound) | Something a scan found at an address |
| [`DiscoverPort`](#discoverport) | An open port a scan found |
| [`DiscoverStop`](#discoverstop) | `discover.stop`'s result |
| [`DiscoverAdd`](#discoveradd) | `discover.add`'s result |
| [`DiscoverAdded`](#discoveradded) | A Host `discover.add` added |
| [`EventName`](#eventname) | An event a Plugin can listen for |
| [`EmptyEvent`](#emptyevent) | The payload of `lock`, `unlock` and `inventory_changed`: an empty table |
| [`HostSelectedEvent`](#hostselectedevent) | `host_selected`'s payload |
| [`Session`](#session) | An open Session, as `roster.sessions.list` gives it |
| [`SessionOpenEvent`](#sessionopenevent) | `session_open`'s payload |
| [`SessionExitEvent`](#sessionexitevent) | `session_exit`'s payload |
| [`JobProgressEvent`](#jobprogressevent) | `job_progress`'s payload: serve's `job.progress` notification |
| [`TerminalOutputEvent`](#terminaloutputevent) | `terminal_output`'s payload |
| [`CommandDoneEvent`](#commanddoneevent) | `command_done`'s payload |

## Errors

A function that fails raises a Lua error: `pcall` catches it, with the message as a string. The message starts with the function (`roster.inventory.host: unknown host 'web-9' (code 2)`); a roster serve error ends with its code, from [serve-api.md's tables](serve-api.md). An error you don't catch stops the call: a notice names the Plugin, file and line (`pinned: init.lua:12: …`), the UI changes that call made are dropped, and the third such error after loading stops the Plugin.

Any function can also raise:

- Lua's own `bad argument` error, for an argument of the wrong kind (a number where a table goes);
- `roster.sidebar.set: PATH: a table that mixes a list with named keys (or has gaps): use one or the other`, `roster.float.open: PATH: a thread can't be a Plugin value` and the like, for data that can't be handed over (the function, then `PATH`, where in your table: `rows.3.label`). A function's return value that can't be is `the value it returned: PATH: …`;
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
roster.notify(roster.plugin.name .. " " .. roster.plugin.version)
local leader = roster.plugin.config.leader or "w w"
```

### `roster.notify(text, level, opts)`

Shows a notice, naming the Plugin. Warnings and errors always show. An info notice is quiet by default, as roster's own routine messages are (`ui.messages`, like Neovim's): unless `ui.messages = "all"`, it isn't drawn, a screen reader still hears it and `:messages` keeps it. An info notice with buttons shows, and `quiet` decides either way: mark `quiet = false` on what the user asked for: the result of something they started ("Scan done: 12 Hosts answered, 3 new"), an answer ("No alerts") or a refusal ("Keep a Host first"), and leave it out for a routine confirmation ("Copied the line"). Every notice, shown or quiet, is in `:messages`.

A notice's button runs a command line when the user clicks it, as [`roster.cmd`](#rostercmdline) would: the click is the user's call, so `view ID` opens your view when a job that ran in the background has finished (a Plugin can't open one on its own, from a timer or an answer). It takes a command line, not a function, so a notice never holds on to one.

**Parameters**

- `text` (`string`): What to say. It's shown after the Plugin's name (`pinned: …`).
- `level` ([`Level`](#level)`?`, optional): `"info"` (the default), `"warn"` or `"error"`.
- `opts` ([`NoticeOptions`](#noticeoptions)`?`, optional): Buttons on the notice (since api 3): `{ actions = { { label = "Show the plan", run = "view mesh-plan" } } }`; whether an info notice is quiet (since api 4): `{ quiet = false }`.

**Returns**

Nothing.

**Errors**

- `roster.notify: the level is "info", "warn" or "error"`: `level` is something else.
- `roster.notify: actions… (a notice's action runs a command line, not a function)`: a function in `opts`.
- `roster.notify: quiet is true or false`: `opts.quiet` is something else.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- more than 2 actions, or one whose `run` isn't a command line.

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.notify("Copied esx-02's address") -- quiet unless ui.messages = "all"
roster.notify("leader: not a key sequence, using w w", "warn")
roster.notify("Plan ready: 4 Hosts change", "info", { actions = { { label = "Show the plan", run = "view mesh-plan" } } })
roster.notify("Scan done: 12 Hosts found", "info", { quiet = false })
```

### `roster.on(event, listener)`

Runs a function on an event. Several listeners for one event run in the order they were added. There's no way to stop listening short of `:plugins reload`. Ask [`roster.has`](#rosterhaspermission) first for an event that needs a permission.

**Parameters**

- `event` ([`EventName`](#eventname)): The event's name: `lock`, `unlock`, `host_selected`, `session_open`, `session_exit`, `inventory_changed`, `terminal_output`, `command_done` or `job_progress`.
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

### `roster.confirm(question)`

Asks the user to confirm, then runs a function. The app draws the question in its own style, with your Plugin's name on it, and only the user answers it: `run` is called when they confirm, `cancel` (if any) when they don't (`Esc` or Cancel, or another Plugin's question taking its place, which isn't a call the user started). Nothing a Plugin does can answer it or draw one of its own. Only while the user runs one of your actions, commands or finder items, so a question never comes up on its own. With `danger`, it's the stronger form for what can't be undone easily (a Mesh Cut): the confirming button is the danger colour and the keys start on Cancel, so a stray `Enter` only declines; with `typed` too, the user types that word (a Host's name) before the button works. Asking again replaces the question: the earlier one's `cancel` isn't called (your Plugin asked the new one, so it knows), and its functions are dropped.

**Parameters**

- `question` ([`Confirm`](#confirm)): What to ask, the button that confirms, and what runs when the user does.

**Returns**

Nothing.

**Errors**

- `roster.confirm: only while the user runs one of your actions, commands or finder items`: at load or in an event listener.
- `roster.confirm: `run` must be a function: what happens when the user confirms`: `run` is missing or a command line.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a field of the wrong kind (`roster.confirm: action must be text`): nothing is asked.

**Permission:** none · **Since:** api 3

**Example**

```lua
actions = { { label = "Cut", key = "x", run = function(e)
  roster.confirm({
    title = "Cut " .. e.host .. " from the Mesh?",
    text = "Its key is taken off every Host it can reach.",
    action = "Cut",
    danger = true,
    typed = e.host,
    run = function() roster.serve.call("mesh.cut", { host = e.host }) end,
  })
end } }
```

### `roster.cmd(line)`

Runs a command line. It runs after the call returns, as if the user typed it. Only while the user runs one of your actions, commands or finder items, and only your own commands and the few of roster's in [Command lines a Plugin may run](#command-lines-a-plugin-may-run), each with the permission it needs there: never `:plugins`, `:packages`, `:publish` or anything else that changes what's installed, granted or written. One of your commands it runs is the user's call carried one hop, as a [`roster.serve.request`](#rosterserverequestmethod-params-done)'s answer is: it may copy, ask or answer on the message line, but a `roster.cmd` or a request made in it (or in such an answer) doesn't carry the call further, so the command that line names runs as the app's call and can't.

**Parameters**

- `line` (`string`): A command line, as typed after `:` (`"finder alerts"`).

**Returns**

Nothing.

**Errors**

- `roster.cmd: only while the user runs one of your actions, commands or finder items`: at load or in an event listener.
- `roster.cmd: which command? …`: an empty line.
- `roster.cmd: :NAME isn't one a Plugin may run (its own commands, and …)`: a command not in the list, another Plugin's, or one of yours named after one of roster's.
- `roster.cmd: :NAME can't run yet: the app hasn't told roster its own commands`: one of your commands, in the moment before the app has said which are roster's (it tries again).
- `roster.cmd: :NAME needs the P permission`: `:open` or `:connect` without `sessions.open`.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.commands.add("alerts", { run = function(a)
  if a.words[1] == nil then roster.cmd("finder alerts") end
end })
```

### `roster.echo(text, opts)`

Answers on the message line, as roster's own commands do. For what a command did or found: the line at the bottom of the window that roster's own commands answer on, not a notice to close. Only while the user runs one of your actions, commands or finder items, so it always answers something they did. Use [`roster.notify`](#rosternotifytext-level-opts) for anything else.

It follows `ui.messages` as roster's own messages do (like Neovim's): what went wrong ("No Host named nope-01") and the answer to what was asked ("3 alerts") always show, so a plain `roster.echo` shows. Mark a routine confirmation, when nothing went wrong ("Added esx-02 to Lab"), with `{ quiet = true }`: unless `ui.messages = "all"`, it isn't drawn, a screen reader still hears it and `:messages` keeps it.

**Parameters**

- `text` (`string`): What to say, on one line.
- `opts` ([`EchoOptions`](#echooptions)`?`, optional): `{ quiet = true }` for a routine confirmation (since api 4).

**Returns**

Nothing.

**Errors**

- `roster.echo: only while the user runs one of your actions, commands or finder items`: at load, in an event listener or a timer.
- `roster.echo: quiet is true or false`: `opts.quiet` is something else.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.commands.add("alerts", { run = function(a)
  if a.words[1] == "clear" then alerts = {} roster.echo("Cleared the alerts", { quiet = true })
  elseif a.words[1] == nil then roster.echo(#alerts .. " alerts")
  else roster.echo("alerts takes clear") end
end })
```

### `roster.cmdline(text)`

Opens the command line with text typed in. For a command that needs one more word from the user: it opens the command line with `text` in it and the cursor at its end, and Tab completes the rest with your command's `complete`. Nothing runs until the user presses Enter. Only your own commands, and only while the user runs one of your actions, commands or finder items.

**Parameters**

- `text` (`string`): The start of a line for one of your commands (`"folder new "`); the user finishes it.

**Returns**

Nothing.

**Errors**

- `roster.cmdline: only while the user runs one of your actions, commands or finder items`: at load, in an event listener or a timer.
- `roster.cmdline: "WORD" isn't one of your commands …`: the line starts with anything but one of the Plugin's commands.
- `roster.cmdline: :NAME can't run yet: the app hasn't told roster its own commands`: as `roster.cmd`'s.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.commands.add("note", { run = function(a)
  if a.args == "" then return roster.cmdline("note ") end
  roster.storage.write("note.txt", a.args)
end })
```

### `roster.has(permission)`

Whether the Plugin was granted a permission. Ask before you use what a permission gives: listening for an event the Plugin may not hear is an error, and a module it wasn't granted is `nil`. `roster.has("network:api.example.com")` asks about that one site, and a bare `roster.has("network")` whether any site was granted (whether `roster.http` is there). One that can't be granted here (a serve method roster doesn't allow, a site that isn't one) is `false`, so you can ask about what a newer roster has.

**Parameters**

- `permission` (`string`): A permission's name: `"terminal.read"`, `"serve:mesh.status"`.

**Returns**

- `boolean`: `true` when it's granted (and not revoked in `:plugins`).

**Errors**

- `roster.has: "NAME" isn't a permission (there's …)`: a name that's no permission at all (a typo).
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
if roster.has("terminal.read") then
  roster.on("terminal_output", function(e) end)
else
  roster.notify("allow terminal.read in :plugins to see alerts", "warn")
end
```

### `roster.defer(ms, fn)`

Runs a function once, later. The app keeps the clock and runs `fn` on the Plugin's own thread when it's time, as it runs an action, except that it isn't something the user started (so `roster.clipboard.copy` refuses). An error in it counts toward stopping the Plugin. Timers end with the Plugin: unloading, reloading or disabling it cancels every one. At most 100 timers wait at once.

**Parameters**

- `ms` (`number`): How long to wait, in milliseconds: at least 50 (less waits 50), at most 2,147,483,647.
- `fn` (`fun()`): What to run then, in the Plugin, with the budget of a call.

**Returns**

- [`Timer`](#timer): Its id, for `roster.cancel`.

**Errors**

- `roster.defer: ms must be a number of milliseconds from 0 to …`: a negative, infinite or huge `ms`.
- `roster.defer: more than 100 timers waiting at once …`: too many timers.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.defer(5000, function()
  roster.status.remove("saved")
end)
```

### `roster.every(ms, fn)`

Runs a function again and again, until it's cancelled. The first run is `ms` from now. The next wait starts when a run has finished, so a slow run never piles up behind itself. Everything else is as `roster.defer`: on the Plugin's own thread, cancelled with the Plugin.

**Parameters**

- `ms` (`number`): How long between runs, in milliseconds: at least 1,000.
- `fn` (`fun()`): What to run each time, in the Plugin.

**Returns**

- [`Timer`](#timer): Its id, for `roster.cancel`.

**Errors**

- `roster.every: at least 1000 ms between runs …`: a shorter `ms`.
- `roster.every: ms must be a number of milliseconds from 0 to …`: a negative, infinite or huge `ms`.
- `roster.every: more than 100 timers waiting at once …`: too many timers.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
-- "2 min ago" stays true.
roster.every(30000, show)
```

### `roster.cancel(timer)`

Cancels a timer. A timer that already ran (a deferred one) or was cancelled is nothing to cancel: that's not an error. A repeating timer may cancel itself from its own function.

**Parameters**

- `timer` ([`Timer`](#timer)): What `roster.defer` or `roster.every` returned.

**Returns**

Nothing.

**Errors**

- `roster.cancel: a timer, as roster.defer or roster.every returned it`: something else.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
local t = roster.every(60000, refresh)
roster.commands.add("stop", { run = function() roster.cancel(t) end })
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

- `roster.commands.remove: "NAME" isn't a name like …`: a bad `name` (since api 3).
- And [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.commands.remove("alerts")
```

## `roster.keymap`

Key bindings.

### `roster.keymap.set(context, keys, action)`

Binds keys to a command line. Never in the terminal. A function isn't an action: add a command and bind its name. The key runs its line as `:plugins run NAME LINE` (which `:keys` shows), checked each time as a button's line is: never `:plugins`, `:packages`, `:source` or another Plugin's command, and a command that needs a permission only while it's granted.

**Parameters**

- `context` ([`KeyContext`](#keycontext)): `"leader"` (a key after the Leader), `"list"` or `"list_vim"` (the Sidebar, and its vim keys).
- `keys` (`string`): The keys, space-separated: `"w w"`.
- `action` (`string|false`): A command line: one of the Plugin's commands or one of the app's that [`roster.cmd`](#rostercmdline) may run (`"finder alerts"`). `false` is deprecated: it takes the Plugin's binding off, as [`roster.keymap.del`](#rosterkeymapdelcontext-keys) does.

**Returns**

Nothing.

**Errors**

- `roster.keymap.set: the action is a command line such as "alerts" (add a command for a function)`: `action` isn't a string or `false`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a `context` other than the three (`keys go after the Leader or in the Sidebar …`).
- keys bound already, by roster, `init.lua` or another Plugin (`a` is Folders', `f` the Picker's; `:keys` lists them): the notice names what has them and up to three free ones like them (`␣ f is taken (by builtin: find). Free after the Leader: a, g, h`).
- keys that would hide a binding, or be hidden by one (`"a z"` when `a` is bound).
- when pressed, a line `roster.cmd` couldn't run (`:plugins grant …`, another Plugin's command): a notice says why.

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.keymap.set("leader", roster.plugin.config.leader or "w w", "finder alerts")
```

### `roster.keymap.del(context, keys)`

Takes one of the Plugin's key bindings off. Keys it didn't bind stay as they are: a Plugin can't unbind roster's, `init.lua`'s or another Plugin's.

**Parameters**

- `context` ([`KeyContext`](#keycontext)): Where it was bound.
- `keys` (`string`): The keys, as `set` took them.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.keymap.del("leader", "w w")
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

### `roster.themes.remove(id)`

Removes one of the Plugin's Themes. Removing one it doesn't have does nothing. If it was the Theme in use, the app goes back to `init.lua`'s.

**Parameters**

- `id` (`string`): One of the Plugin's Themes.

**Returns**

Nothing.

**Errors**

- `roster.themes.remove: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.themes.remove("dusk")
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

- `roster.sidebar.remove: "ID" isn't a name like …`: a bad `id` (since api 3).
- And [those of every function](#errors).

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

- `roster.status.remove: "ID" isn't a name like …`: a bad `id` (since api 3).
- And [those of every function](#errors).

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

- `roster.finders.remove: "ID" isn't a name like …`: a bad `id` (since api 3).
- And [those of every function](#errors).

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

- `roster.help.remove: "TOPIC" isn't a name like …`: a bad `topic` (since api 3).
- And [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.help.remove("pinned")
```

## `roster.health`

Sections of `:check`.

### `roster.health.set(id, section)`

Adds a section to `:check` (this Box's health), or replaces it. Like Neovim's `vim.health`: with `check`, each `:check` calls it and shows the lines it returns, under the Plugin's name on `:help health`. It runs with the Plugin's permissions and the time budget of any call (a quarter of a second), but it isn't a call the user started (no clipboard, questions, command lines or flagged serve methods in it); one that fails or doesn't answer in time is an `ERROR` line of its section, and `:check` goes on without it. With `checks` and no `check`, `:check` shows them as the Plugin last set them.

**Parameters**

- `id` (`string`): The section's id.
- `section` ([`HealthSection`](#healthsection)): Its title, and its checks or the function that makes them.

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
  check = function()
    if not granted("terminal.read") then
      return { { level = "warn", message = "terminal.read isn't granted", fix = "Allow it in :plugins" } }
    end
    return { { level = "ok", message = #alerts .. " alerts so far" } }
  end,
})
```

### `roster.health.answer(check, lines)`

Answers a `:check` section's check that returned `"later"`. A `check` that needs roster serve returns `"later"` at once and answers with this from the request's `done`, so it never waits for serve on the Plugin's thread. The app shows the section once it answers, or an `ERROR` line if it hasn't within 30 seconds; an answer for a run that's over (answered, or timed out) is dropped. Any run of the Plugin may answer, not only a call the user started.

**Parameters**

- `check` (`integer`): The `check` field of what the section's `check` was called with.
- `lines` ([`HealthCheck`](#healthcheck)`[]`): The section's lines for that run.

**Returns**

Nothing.

**Errors**

- `roster.health.answer: lines: …`: lines that aren't plain data.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- lines whose `level` isn't `ok`, `warn` or `error`, or without a `message`.

**Permission:** none · **Since:** api 3

**Example**

```lua
check = function(e)
  roster.serve.request("discover.plan", { targets = { "10.0.0.0/30" } }, function(plan, err)
    roster.health.answer(e.check, plan and { { level = "ok", message = "scans with " .. plan.scanner } }
      or { { level = "error", message = err } })
  end)
  return "later"
end
```

### `roster.health.remove(id)`

Removes a `:check` section.

**Parameters**

- `id` (`string`): One of the Plugin's sections.

**Returns**

Nothing.

**Errors**

- `roster.health.remove: "ID" isn't a name like …`: a bad `id` (since api 3).
- And [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.health.remove("recent-alerts")
```

## `roster.tutor`

Tutorials (`:tutor ID`).

### `roster.tutor.set(id, tutorial)`

Adds a tutorial, or replaces it. `:tutor ID` runs it on the demo Inventory, where the Plugin is loaded too, with the permissions the user granted it, so a step can wait for the Plugin's own command and the command works there. On the demo, `roster.inventory` sees the demo's Hosts, roster serve answers only `hosts.list` and `host.get`, `roster.http` requests are never sent (their function hears why), and `roster.storage` is a throwaway folder that starts empty.

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

- `roster.tutor.remove: "ID" isn't a name like …`: a bad `id` (since api 3).
- And [those of every function](#errors).

**Permission:** none · **Since:** api 2

**Example**

```lua
roster.tutor.remove("pinned")
```

## `roster.toolbar`

Controls in the toolbar. A control in the title bar's toolbar (decision Q65), after roster's own by the window's buttons. It's shown unless `init.lua` picks the controls itself with `modes.<mode>.toolbar`: then it shows where that list names its id. It never takes focus from the terminal.

### `roster.toolbar.set(id, control)`

Adds a control to the toolbar, or replaces it.

**Parameters**

- `id` (`string`): The control's id: a name like `scan`, which `modes.<mode>.toolbar` can list.
- `control` ([`ToolbarControl`](#toolbarcontrol)): Its label, icon or word, and what it runs.

**Returns**

Nothing.

**Errors**

- `roster.toolbar.set: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a control with that id from elsewhere (roster's own: `find`, `add`, …).
- a field of the wrong kind.

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.toolbar.set("scan", { label = "Scan a network", text = "Scan", icon = "map", run = "discover" })
```

### `roster.toolbar.remove(id)`

Removes a toolbar control.

**Parameters**

- `id` (`string`): One of the Plugin's controls.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.toolbar.remove("scan")
```

## `roster.progress`

Progress of something long. What the Plugin is doing that takes a while (a scan, a long roster serve call), shown in the status bar: how far it has got, or only that it's going, and a way to stop it. `:cancel ID` (or the button) calls its `cancel` function. Setting it any time is fine, from an event too: it changes nothing but itself.

### `roster.progress.set(id, progress)`

Shows or updates the progress of something long. With `done` and `total` it shows how far it has got; without, only that it's going. Set it again as it moves on, and `roster.progress.remove` it when it's over. With `cancel`, the user can stop it: the app calls the function once and shows "Stopping…" until you set or remove it again.

**Parameters**

- `id` (`string`): A name like `scan`: `:cancel scan` cancels it.
- `progress` ([`Progress`](#progress)): What's going on, how far it has got, and how to stop it.

**Returns**

Nothing.

**Errors**

- `roster.progress.set: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a progress with that id from another Plugin.
- a field of the wrong kind.

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.progress.set("scan", {
  title = "Scanning 10.0.0.0/24",
  done = 40, total = 256,
  cancel = function() roster.serve.call("discover.stop") end,
})
```

### `roster.progress.remove(id)`

Takes a progress away: it's over. Say how it ended with `roster.notify` or in your view.

**Parameters**

- `id` (`string`): One of the Plugin's progresses.

**Returns**

Nothing.

**Errors**

Only [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.progress.remove("scan")
roster.notify("Scan done: 12 Hosts found")
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

Opens a floating window over the terminal, or replaces the Plugin's. It lies over the terminal, on the side away from the Sidebar, so it never resizes a Session. `Esc` closes it. Its actions are buttons at its foot (with a key each, once it has focus), and its links open in the browser, the address shown with them.

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

## `roster.views`

Views: side panels and full views. A view is data the app draws in its own style: a title, text, facts and a table. `place` says where: `"panel"` beside the terminal (over it in Focus or a narrow window), or `"full"` over the whole window, as Topology is. `:view ID` opens one, and the `views` finder (`:finder views`) lists them all; bind a key to `view ID` with `roster.keymap.set`. `Esc` closes it and puts you back where you were. A table's rows are plain data, so `roster.views.update` changes some in place without sending the rest again. A view can hold a graph instead of a table: nodes, edges and clusters, also plain data, with a list of every node and edge one key away (`t`).

### `roster.views.set(id, view)`

Adds a view, or replaces it. Setting it again replaces the whole view and drops the functions its old table held; an open view stays open and keeps its selected row. It doesn't open the view: `:view ID`, a key bound to `view ID`, the `views` finder or `roster.views.open` in one of your actions does.

**Parameters**

- `id` (`string`): The view's id: a name like `discover`. `:view ID` opens it.
- `view` ([`View`](#view)): Where it goes, its title, text, facts, and a table or a graph.

**Returns**

Nothing.

**Errors**

- `roster.views.set: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a view with that id from elsewhere.
- a field of the wrong kind (`roster.views.set discover table row 2: id must be text`): the whole view is dropped.
- an action key the table uses itself (`j`, `k`, `g`, `G`, `s`, `S`, `/`, `?`, `q`) or one used twice.
- a graph's action key the graph uses itself (`h` `j` `k` `l` `H` `J` `K` `L` `g` `G` `n` `N` `o` `O` `t` `f` `m` `s` `S` `/` `?` `q` `+` `-` `=` `0`), a graph action's `when` naming what a node doesn't have (`when.colour: a node has no colour`), a node or cluster id used twice, an edge id used twice, or a table and a graph in one view.

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.views.set("discover", {
  title = "Discover",
  place = "panel",
  text = "Scanning 10.0.0.0/24",
  table = {
    columns = {
      { id = "address", label = "Address", kind = "data" },
      { id = "ports", label = "Ports", kind = "number" },
    },
    rows = {},
    sort = "address",
    empty = "Nothing found yet.",
    actions = {
      { label = "Keep", key = "a", icon = "add", run = function(e) keep(e.row) end },
    },
  },
})
```

### `roster.views.update(id, changes)`

Changes some of a view's rows or nodes in place, or its text or facts. A row whose `id` is in the table already is replaced where it stands; a new one goes at the end (the table's sort still applies). The rest stay as they are, and so does the selection, so a scan can add what it finds as it finds it. Plain data only: the table's functions stay those `roster.views.set` gave. A graph's nodes, edges and clusters work the same way, by `id`: a node that turns live, or an edge that appears, changes where it stands, and every placed node keeps its place.

**Parameters**

- `id` (`string`): One of the Plugin's views.
- `changes` ([`ViewUpdate`](#viewupdate)): What changes: rows to add or replace, rows to take away, and the text or facts.

**Returns**

Nothing.

**Errors**

- `roster.views.update: "ID" isn't a name like …`: a bad `id`.
- `roster.views.update "ID": … (an update is plain data: functions go in roster.views.set)`: a function in `changes`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a view the Plugin hasn't set.
- rows for a view without a table.
- more than 10,000 rows in the table after the update.
- nodes, edges or clusters for a view without a graph.
- more than 5,000 nodes, 10,000 edges or 500 clusters in the graph after the update.

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.views.update("discover", {
  text = "Scanning 10.0.0.0/24: 40%",
  rows = { { id = "10.0.0.7", cells = { address = "10.0.0.7", ports = 2 } } },
  remove = { "10.0.0.9" },
})
```

### `roster.views.open(id, opts)`

Opens a view. Only while the user runs one of the Plugin's actions, commands or finder items, so a Plugin never takes the screen on its own. One view is open at a time: this replaces the one that is.

With `select`, it opens at that node or row: a graph opens the node's cluster if it's collapsed and centres the node, a table scrolls to the row. Asked again while the view is open, it starts afresh at the new one. An id the view doesn't have opens it as without `select`. A Host-details section's action can so open a graph at its Host's node.

**Parameters**

- `id` (`string`): One of the Plugin's views.
- `opts` ([`ViewOpenOptions`](#viewopenoptions)`?`, optional): Where it opens (since api 4): `{ select = "esx-02" }` selects that node of its graph or row of its table.

**Returns**

Nothing.

**Errors**

- `roster.views.open: "ID" isn't a name like …`: a bad `id`.
- `roster.views.open: opts is a table, as { select = ID }`: `opts` isn't a table.
- `roster.views.open: select is the id of a node or row (a string)`: `select` isn't a string.
- `roster.views.open: only while the user runs one of your actions, commands or finder items`: at load or in an event listener.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a view the Plugin hasn't set.

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.commands.add("discover", { desc = "Scan a network", run = function()
  roster.views.open("discover")
end })
-- A Host-details section's button: the map, at that Host.
roster.details.set("reach", "esx-02", { title = "Reach", facts = {}, actions = {
  { label = "Show on the map", icon = "map", run = function(e) roster.views.open("topology", { select = e.host }) end },
} })
```

### `roster.views.close(id)`

Closes a view, if it's open. Focus goes back where it was, as with `Esc`. Another view, or one that isn't open, stays as it is.

**Parameters**

- `id` (`string`): One of the Plugin's views.

**Returns**

Nothing.

**Errors**

- `roster.views.close: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.views.close("discover")
```

### `roster.views.remove(id)`

Removes a view. It closes if it's open, and its functions are dropped.

**Parameters**

- `id` (`string`): One of the Plugin's views.

**Returns**

Nothing.

**Errors**

- `roster.views.remove: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.views.remove("discover")
```

## `roster.details`

Sections of a Host's details. Your own sections in a Host's details panel (`:info HOST`), after roster's: set per Host, like a badge.

### `roster.details.set(id, host, section)`

Adds a section to a Host's details, or replaces it. One section per id per Host; setting it again for the Host replaces it and drops the functions its old table held (other Hosts' stay). A name that isn't a Host shows nowhere. A table's action gets the Host too (`e.host`).

**Parameters**

- `id` (`string`): The section's id: a name like `mesh`.
- `host` (`string`): The Host's name in the Inventory.
- `section` ([`DetailsSection`](#detailssection)`?`, optional): Its title, text, facts and table; `nil` takes this Host's away.

**Returns**

Nothing.

**Errors**

- `roster.details.set: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Refused by the app** (a warning notice, not an error)

- a section with that id from another Plugin.
- a field of the wrong kind: that Host's section is dropped.

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.details.set("mesh", "esx-02", {
  title = "Mesh",
  facts = { { label = "reach", value = "can reach 7 Hosts" } },
})
```

### `roster.details.remove(id)`

Removes a section from every Host's details.

**Parameters**

- `id` (`string`): One of the Plugin's sections.

**Returns**

Nothing.

**Errors**

- `roster.details.remove: "ID" isn't a name like …`: a bad `id`.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.details.remove("mesh")
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

## `roster.storage`

The Plugin's own files. Every Plugin has a data folder of its own, in the app's data folder (next to the State; never the config folder, never on the network), and `roster.storage` reads and writes files there by name (decision Q93). No permission: it's the Plugin's own, and nothing else is reachable through it. A name is a plain file name (letters, digits, `-`, `_` and `.`, not starting with `.`; at most 100 characters), never a path, so there's no way out of the folder; a link there (a symlink, or a junction on Windows) is never followed. A write replaces the whole file at once (a temporary file, then a rename), so a crash leaves the old file or the new one, never half of one. A file holds at most 1 MB, the folder 10 MB in at most 1,000 files. The folder goes when the Plugin is removed (`:plugins remove`, or `:packages clean` for a Package), and stays across reloads, updates and revoked permissions. The time the disk takes doesn't count against the Plugin's budget.

### `roster.storage.read(name)`

Reads one of the Plugin's files.

**Parameters**

- `name` (`string`): The file's name (`"folders.json"`).

**Returns**

- `string?`: What the file holds, or `nil` when there's no such file.

**Errors**

- `roster.storage.FN: "NAME" isn't a file name: letters, digits, - _ and . only, …`: a path (`a/b`, `../x`, `C:\x`), a name starting with `.`, or other characters.
- `roster.storage.FN: NAME is a link: roster won't follow it`: the file was made a link (a symlink, a junction): it's never followed.
- `roster.storage.FN: the Plugin's data folder is a link …`: its folder was made a link: it's never followed.
- `roster.storage.FN: there's no data folder for Plugins here`: the app has no data folder (a test, say).
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
local seen = roster.storage.read("seen.txt") or ""
```

### `roster.storage.write(name, text)`

Writes one of the Plugin's files, whole. Makes the file, or replaces what it held, all at once: a crash leaves the old content or the new, never half.

**Parameters**

- `name` (`string`): The file's name.
- `text` (`string`): What it holds from now on, at most 1 MB (any bytes).

**Returns**

Nothing.

**Errors**

- `roster.storage.write: NAME would be N bytes: a file holds at most 1 MB (1048576 bytes)`: the text is longer.
- `roster.storage.write: the Plugin's data folder holds at most 10 MB …`: the folder would hold more (a file replaced counts only its new size).
- `roster.storage.write: the Plugin's data folder holds at most 1000 files`: a new file past the thousandth.
- `roster.storage.write: "NAME" isn't a file name: …`: as `roster.storage.read`.
- `roster.storage.write: NAME is a link: roster won't follow it`: as `roster.storage.read`.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.storage.write("seen.txt", table.concat(lines, "\n"))
```

### `roster.storage.list()`

The names of the Plugin's files.

**Parameters**

None.

**Returns**

- `string[]`: In name order; `{}` before the first write.

**Errors**

- `roster.storage.list: the Plugin's data folder is a link …`: its folder was made a link: it's never followed.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
for _, name in ipairs(roster.storage.list()) do roster.notify(name) end
```

### `roster.storage.remove(name)`

Removes one of the Plugin's files.

**Parameters**

- `name` (`string`): The file's name.

**Returns**

- `boolean`: `true` if it was there.

**Errors**

- `roster.storage.FN: "NAME" isn't a file name: letters, digits, - _ and . only, …`: a path (`a/b`, `../x`, `C:\x`), a name starting with `.`, or other characters.
- `roster.storage.FN: NAME is a link: roster won't follow it`: the file was made a link (a symlink, a junction): it's never followed.
- `roster.storage.FN: the Plugin's data folder is a link …`: its folder was made a link: it's never followed.
- `roster.storage.FN: there's no data folder for Plugins here`: the app has no data folder (a test, say).
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.storage.remove("cache.json")
```

### `roster.storage.read_json(name)`

Reads one of the Plugin's files as JSON. Objects and arrays become tables, `null` becomes `nil`.

**Parameters**

- `name` (`string`): The file's name.

**Returns**

- `any`: The value, or `nil` when there's no such file.

**Errors**

- `roster.storage.read_json: NAME isn't JSON (…)`: the file holds something else.
- `roster.storage.read_json: …`: as `roster.storage.read`.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
local state = roster.storage.read_json("state.json") or { hosts = {} }
```

### `roster.storage.write_json(name, value)`

Writes one of the Plugin's files as JSON, whole. As `roster.storage.write`, with the value as indented JSON. An empty table is written as `{}` (Lua can't tell an empty list from an empty table).

**Parameters**

- `name` (`string`): The file's name.
- `value` (`any`): Plain data: tables, text, numbers and booleans (no functions).

**Returns**

Nothing.

**Errors**

- `roster.storage.write_json: a Lua function can't go to roster serve`: the value holds a function (or another value that isn't data).
- `roster.storage.write_json: …`: as `roster.storage.write`.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
roster.storage.write_json("state.json", { hosts = { "esx-02" } })
```

## `roster.inventory`

Hosts, and Pending changes to them. `nil` unless the Plugin was granted `inventory.read` or `inventory.write`; each function is there only with its own permission. The reads but `request` wait for `roster serve`; that time doesn't count against the Plugin's budget, nor toward it being given up on. One call (a load, an event, an action, an answer) reads the Inventory once: `hosts()` and `groups()` in it share one answer of serve's, until a call into serve that can change something (a write, `mesh.cut`, …) in the same call. [`roster.inventory.request`](#rosterinventoryrequestdone) doesn't wait: prefer it where the Plugin would otherwise hold up the user, and for a big Inventory.

### `roster.inventory.hosts()`

Every Host, in `roster.yml` order. From serve's [`hosts.list`](serve-api.md): while `roster.yml` doesn't load (an outside edit), the last good Hosts. The groups are [`roster.inventory.groups()`](#rosterinventorygroups), from the same answer when it's called in the same call (since api 4). [`roster.inventory.request`](#rosterinventoryrequestdone) asks without waiting.

**Parameters**

None.

**Returns**

- [`Host`](#host)`[]`: The Hosts, each with its Login references (a vault item's name, never a password; a `cmd:` or `env:` one cut to its kind).

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

One Host, by its exact name. From serve's [`host.get`](serve-api.md). An unknown name is `nil` (since api 3; it was an error in api 2).

**Parameters**

- `name` (`string`): The Host's exact name.

**Returns**

- [`Host`](#host)`?`: The Host, or `nil` when no Host has that name.

**Errors**

- `roster.inventory.host: MESSAGE (code N)`: roster serve failed otherwise.
- And [those of every function](#errors).

**Permission:** `inventory.read` · **Since:** api 2

**Example**

```lua
local h = roster.inventory.host(name)
if h then roster.notify(name .. " is " .. h.ip) end
```

### `roster.inventory.groups()`

Every group, by name. From serve's [`hosts.list`](serve-api.md), as `roster.inventory.hosts()` is: called in the same call as `hosts()`, it uses that answer rather than read the Inventory again (since api 4; a call into serve that can change something in between, a write or `mesh.cut`, reads it again). A Host's `group` names one of them.

**Parameters**

None.

**Returns**

- `table<string, `[`Group`](#group)`>`: The groups, by name.

**Errors**

- `roster.inventory.groups: MESSAGE (code N)`: roster serve failed (see [Errors](#errors)).
- And [those of every function](#errors).

**Permission:** `inventory.read` · **Since:** api 3

**Example**

```lua
local groups = roster.inventory.groups()
for _, h in ipairs(roster.inventory.hosts()) do
  local g = groups[h.group]
  roster.notify(h.name .. " is in " .. (g and g.title ~= "" and g.title or h.group))
end
```

### `roster.inventory.request(done)`

Reads every Host and group without waiting: `done` gets them. Serve's [`hosts.list`](serve-api.md), asked as [`roster.serve.request`](#rosterserverequestmethod-params-done) asks: it returns at once and `done` runs later on the Plugin's thread, as a call of its own, so the Plugin keeps answering the user while roster serve is busy (a Publish holds `roster.yml` for a minute or two). Its answer carries the user's call as a `roster.serve.request`'s does. It counts toward the 8 requests a Plugin may have waiting, and needs no `serve:` permission. A `cmd:` or `env:` Login reference is cut to its kind, as in every read.

**Parameters**

- `done` (`fun(list: `[`HostList`](#hostlist)`?, err: string?)`): Runs once with the answer: every Host and group (`list.hosts`, `list.groups`), or `nil` and why (`roster.inventory.request: MESSAGE (code N)`). Its return value is ignored; an error in it counts like an action's.

**Returns**

Nothing.

**Errors**

- `roster.inventory.request: 8 requests are waiting for roster serve already: wait for one to answer`: 8 `roster.serve.request` and `roster.inventory.request` calls haven't answered yet.
- And [those of every function](#errors).

**Permission:** `inventory.read` · **Since:** api 4

**Example**

```lua
roster.inventory.request(function(list, err)
  if not list then return roster.notify(err, "warn") end
  roster.status.set("hosts", { text = #list.hosts .. " Hosts" })
end)
```

### `roster.inventory.update(host, changes)`

Changes a Host's fields, as a Pending change. serve's [`host.update`](serve-api.md#editing-pending-changes): `roster.yml` is edited as text (comments and every other entry stay) and the change waits for you to review and Publish it. A change to `ip`, `user`, `port` or `auth` needs a test login of exactly those values first (`host.verify_login`), which a Plugin can't make: from a Plugin those fail with code 75. Only `title`, `description` and `type` go through. Only while the user runs one of your actions, commands or finder items (decision Q100).

**Parameters**

- `host` (`string`): The Host's exact name.
- `changes` ([`Change`](#change)): The fields to change, and their new values.

**Returns**

- [`UpdateResult`](#updateresult): What was written.

**Errors**

- `roster.inventory.update: only while the user runs one of your actions, commands or finder items`: at load, in an event listener, a timer, a finder's `items` or a `:check`: it changes the Inventory.
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

Renames a Host, as a Pending change. serve's [`host.rename`](serve-api.md#the-live-inventory-hosts-and-groups-and-outside-edits): only its key in `roster.yml` and its name in `links:` change. Its vault item keeps its name. Only while the user runs one of your actions, commands or finder items (decision Q100).

**Parameters**

- `host` (`string`): The Host's exact name.
- `to` (`string`): Its new name.

**Returns**

- [`RenameResult`](#renameresult): What was written.

**Errors**

- `roster.inventory.rename: only while the user runs one of your actions, commands or finder items`: at load, in an event listener, a timer, a finder's `items` or a `:check`: it changes the Inventory.
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

Moves a Host to another group, as a Pending change. serve's [`host.move`](serve-api.md#the-live-inventory-hosts-and-groups-and-outside-edits): what it inherited from its old group and wouldn't from the new one is written on the Host, so it stays the same Host. Only while the user runs one of your actions, commands or finder items (decision Q100).

**Parameters**

- `host` (`string`): The Host's exact name.
- `group` (`string`): The group to move it to (at its end).

**Returns**

- [`MoveResult`](#moveresult): What was written, and which fields were pinned on the Host.

**Errors**

- `roster.inventory.move: only while the user runs one of your actions, commands or finder items`: at load, in an event listener, a timer, a finder's `items` or a `:check`: it changes the Inventory.
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

Marks a Host reviewed (or not), as a Pending change. serve's [`host.review`](serve-api.md#adding-a-host-hostadd). Only while the user runs one of your actions, commands or finder items (decision Q100).

**Parameters**

- `host` (`string`): The Host's exact name.
- `reviewed` (`boolean?`, optional): `true` (the default) marks it reviewed; `false` un-reviews it.

**Returns**

- [`ReviewResult`](#reviewresult): What was written.

**Errors**

- `roster.inventory.review: only while the user runs one of your actions, commands or finder items`: at load, in an event listener, a timer, a finder's `items` or a `:check`: it changes the Inventory.
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

Going to Sessions, and opening them. Every Plugin may go to a Session the user is shown (`show`), in a call the user started; `list` is there with `inventory.read` or `terminal.read` (the permissions that hear `session_open` and `session_exit`), and `open` only with `sessions.open`.

### `roster.sessions.show(session, line)`

Goes to a Session, and to a line in its scrollback. It happens after the call returns, as if the user picked the Session: with two Sessions to one Host, this is the one the id names. With `line`, the terminal's search opens on it, so `Enter` and `Shift+Enter` go on up and down from there and `Esc` closes it; a line no longer in the scrollback shows "no matches" there. A Session that has ended is said in a notice. Only while the user runs one of your actions, commands or finder items.

**Parameters**

- `session` (`integer`): The Session's id, from an event (`e.session`).
- `line` (`string?`, optional): Text of a line it printed: the app searches its scrollback from the bottom for the latest line with it, and shows it highlighted.

**Returns**

Nothing.

**Errors**

- `roster.sessions.show: only while the user runs one of your actions, commands or finder items`: at load or in an event listener.
- And [those of every function](#errors).

**Permission:** none · **Since:** api 3

**Example**

```lua
-- An alert's row goes to the line in the Session that printed it.
open = function(e) roster.sessions.show(alerts[e.row].session, alerts[e.row].text) end
```

### `roster.sessions.list()`

The Sessions open now, in the order they opened. Every Session that is open, the ones that opened before the Plugin loaded too: the events only tell a Plugin what happens after it loads, so read this at load and follow `session_open` and `session_exit` from there. A Session is open from its `session_open` to its `session_exit`; one that ended but whose tab is still there isn't listed. The app keeps the list in the order it saw each Session open, and a Session that connects again (the same id) opens again, so it goes last. In a listener for either event the list already has (or no longer has) that Session. It reads what the app last said, never roster serve, so it never waits.

**Parameters**

None.

**Returns**

- [`Session`](#session)`[]`: Each open Session's id and Host, oldest open first.

**Errors**

Only [those of every function](#errors).

**Permission:** `inventory.read` or `terminal.read` · **Since:** api 4

**Example**

```lua
local live = {}
for _, s in ipairs(roster.sessions.list()) do
  if s.host then live[s.host] = true end
end
roster.on("session_open", function(e) if e.host then live[e.host] = true end end)
```

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

roster serve's methods, by name. `nil` unless the Plugin was granted at least one `serve:<method>` permission. roster serve answers several requests at once, but a call can still wait: for its turn (2 calls into serve at a time for each Plugin, 4 for all of them) or behind the app's own write (a Publish: a minute or two). [`roster.serve.request`](#rosterserverequestmethod-params-done) doesn't wait: prefer it in anything the user starts. A job's progress comes as the `job_progress` event (serve API 20). [`roster.serve.call`](#rosterservecallmethod-params) waits, and the user's next action in the Plugin waits behind it; the wait never counts against the Plugin.

### `roster.serve.call(method, params)`

Calls a roster serve method the Plugin was granted. Waits for the answer, however long roster serve takes (a call behind the app's Publish waits for it); that time doesn't count against the Plugin's budget, nor toward it being given up on, but the Plugin does nothing else meanwhile. [`roster.serve.request`](#rosterserverequestmethod-params-done) asks without waiting. A Plugin may be granted `inventory.info`, `hosts.list`, `host.get`, `host.check`, `host.check_job`, `changes.diff` and the `mesh.*` and `discover.*` methods; never one that reaches a secret. Every method the install prompt flags, the ones that act on the network or the Inventory (all but `inventory.info`, `hosts.list`, `host.get`, `host.check_job`, `changes.diff`, `mesh.status`, `mesh.plan`, `mesh.job`, `mesh.stop`, `discover.plan`, `discover.status` and `discover.stop`; `mesh.apply`, `mesh.cut`, `host.check`, `discover.start` and `discover.add` among them), only while the user runs one of your actions, commands or finder items, or answers your question: never at load, on an event, from a timer, or in a finder's `items` or a `:check` section's `check`. One call may ask roster serve this way (and through `roster.inventory`) at most 100 times, waiting 300 s in all. What each returns is under [roster serve's results](#roster-serves-results); in it, as in `roster.inventory`'s, a `cmd:` or `env:` Login reference is cut to its kind ([`LoginRef`](#loginref)), in any text of it: a diff's line or a step's message too.

**Parameters**

- `method` (`string`): A roster serve method the Plugin was granted, by name (`serve:inventory.info` grants `inventory.info`).
- `params` (`table?`, optional): The method's params; `{}` if left out. Data only: no functions.

**Returns**

- `any`: The method's result, as Lua tables (JSON `null` is `nil`).

**Errors**

- `roster.serve.call: not granted (serve:METHOD)`: the Plugin wasn't granted that method.
- `roster.serve.call METHOD: only while the user runs one of your actions, commands or finder items`: a flagged method (`mesh.apply`, `host.check`, `discover.start`, …) at load, in an event listener, a timer, a finder's `items` or a `:check`.
- `roster.serve.call METHOD: more than 100 calls into roster serve in one go (roster.serve.request doesn't wait)`: the call asked roster serve 100 times already (or waited 300 s in all: `waited 300 s or more for roster serve in one go`).
- `roster.serve.call METHOD: MESSAGE (code N)`: the method failed (its codes are in [serve-api.md](serve-api.md)).
- And [those of every function](#errors).

**Permission:** `serve:<method>` (that method) · **Since:** api 2

**Example**

```lua
local info = roster.serve.call("inventory.info")
roster.status.set("box", { text = info.box .. ": " .. info.host_count .. " Hosts" })
```

### `roster.serve.request(method, params, done)`

Asks roster serve without waiting: `done` gets the answer. Returns at once; `done` runs later on the Plugin's thread, as a call of its own, so the Plugin keeps answering the user while roster serve is busy (a Publish holds `roster.yml` for a minute or two). The same rules as [`roster.serve.call`](#rosterservecallmethod-params): the method must be granted, a flagged one (`mesh.apply`, `discover.start`, …) only in a call the user started, and a `cmd:` or `env:` Login reference in the result is cut to its kind. **The answer to a request made in a call the user started is part of that call:** `done` may open a view, ask a question, copy or run a command line, as the call could, and may ask for a flagged method. A request made in that `done` doesn't carry it further, and one made at load, on an event or from a timer never has it. An answer for a Plugin unloaded or reloaded since is dropped. At most 8 wait at once.

**Parameters**

- `method` (`string`): A roster serve method the Plugin was granted, as [`roster.serve.call`](#rosterservecallmethod-params)'s.
- `params` (`table?`, optional): The method's params; `nil` or `{}` for none. Data only: no functions.
- `done` (`fun(result: any, err: string?)`): Runs once with the answer: the method's `result` (as `roster.serve.call` returns it), or `nil` and why (`roster.serve.request METHOD: MESSAGE (code N)`). Its return value is ignored; an error in it counts like an action's.

**Returns**

Nothing.

**Errors**

- `roster.serve.request: not granted (serve:METHOD)`: the Plugin wasn't granted that method.
- `roster.serve.request METHOD: only while the user runs one of your actions, commands or finder items`: a flagged method (`mesh.apply`, `host.check`, `discover.start`, …) at load, in an event listener, a timer, a finder's `items` or a `:check`.
- `roster.serve.request METHOD: 8 requests are waiting for roster serve already: wait for one to answer`: 8 haven't answered yet.
- And [those of every function](#errors).

**Permission:** `serve:<method>` (that method) · **Since:** api 3

**Example**

```lua
roster.commands.add("count", { run = function()
  roster.serve.request("hosts.list", {}, function(r, err)
    if not r then return roster.notify(err, "warn") end
    roster.echo(#r.hosts .. " Hosts")
  end)
end })
```

## `roster.http`

HTTP requests to the sites the manifest lists. `nil` unless the Plugin was granted at least one `network:<site>` permission ([Permissions](plugins.md#permissions)). The request runs in roster's core, never in the app's window, and doesn't wait: the function you pass gets the answer later, as a call of its own with a call's budget. Only the sites granted are reached, redirects included; a name that resolves to an address on this computer or a private network is refused unless the manifest lists the address itself, or the name as a private site (`network:private:nas.lan`), which reaches only private addresses. A pinned site (`#sha256:…`) trusts only that certificate. No cookies or credentials of roster's go along, and no proxy but the user's `plugin_proxy`, through which a public name is still looked up here first and refused if it leads inside (only a name this computer can't look up at all is left to the proxy). At most 4 requests at once, a 256 KB body out, a 1 MB body back, 30 seconds each.

### `roster.http.request(request, done)`

Sends an HTTP request to a site the Plugin was granted. Returns at once; `done` runs later. Each request is checked before anything is sent: its site must be one of the Plugin's `network:<site>` grants (https, unless the site was listed with `http://`; the port the site names, or the scheme's own). The same check stops a redirect to anywhere else.

**Parameters**

- `request` ([`HttpRequest`](#httprequest)): What to send: at least its `url`.
- `done` (`fun(response: `[`HttpResponse`](#httpresponse)`?, err: string?)`): Runs once with the answer: `response` for any status the site gave (a 404 too), or `nil` and why there was none (refused, unreachable, timed out, too big). Its return value is ignored; an error in it counts like an action's.

**Returns**

Nothing.

**Errors**

- `roster.http.request: https://elsewhere.example isn't a site this Plugin may reach (it may reach SITES)`: the URL's scheme, host or port isn't granted.
- `roster.http.request: "URL" isn't a URL: …`: `url` doesn't parse.
- `roster.http.request: a URL with a user or password in it isn't sent`: the URL has `user:password@`.
- `roster.http.request: the NAME header is roster's to set`: a header that steers the connection: `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `TE`, `Expect`, `Proxy-…`.
- `roster.http.request: "METHOD" isn't a method (there's GET, HEAD, POST, PUT, PATCH, DELETE)`: another method.
- `roster.http.request: the body is over 262144 bytes`: a longer body.
- `roster.http.request: 4 requests are going already: wait for one to answer`: 4 haven't answered yet.
- `roster.http.request: "KEY" isn't a key of a request (there's url, method, headers, body, timeout)`: another key in `request`.
- And [those of every function](#errors).

**Permission:** `network:<site>` (that site) · **Since:** api 2

**Example**

```lua
roster.http.request({
  url = "https://hooks.example.com/alerts",
  method = "POST",
  headers = { ["Content-Type"] = "application/json", Authorization = "Bearer " .. roster.plugin.config.token },
  body = '{"text": "esx-02 is down"}',
}, function(res, err)
  if not res then return roster.notify("webhook: " .. err, "warn") end
  if res.status >= 300 then roster.notify("webhook said " .. res.status, "warn") end
end)
```

### `roster.http.get(url, done)`

Fetches a URL from a site the Plugin was granted. `roster.http.request({ url = url }, done)`.

**Parameters**

- `url` (`string`): The URL, on a site the Plugin was granted.
- `done` (`fun(response: `[`HttpResponse`](#httpresponse)`?, err: string?)`): As [`roster.http.request`](#rosterhttprequestrequest-done)'s.

**Returns**

Nothing.

**Errors**

- `roster.http.get: …`: as [`roster.http.request`](#rosterhttprequestrequest-done)'s.
- And [those of every function](#errors).

**Permission:** `network:<site>` (that site) · **Since:** api 2

**Example**

```lua
roster.http.get("https://status.example.com/api/v2/status.json", function(res, err)
  roster.status.set("upstream", { text = res and res.status == 200 and "upstream ok" or "upstream ?" })
end)
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
| `command_done` | A command ended in a Session whose shell writes OSC 133 marks (since api 4): after the `terminal_output` with its last lines. A shell without them sends none; [Shell integration](plugins.md#shell-integration) says how to set one up. | [`CommandDoneEvent`](#commanddoneevent) | `terminal.read` |
| `job_progress` | One of roster serve's jobs (a Mesh run, a Discover scan, a Host's check) started, moved on (at most five times a second) or ended (serve API 20; an older serve sends none, so keep a poll until the first one comes; a check is a job from serve API 21). A Plugin hears a Mesh job only with `serve:mesh.job`, a scan only with `serve:discover.status` and a check only with `serve:host.check_job`: what it could ask anyway (`serve:host.check` alone isn't enough: a listener may never call it). The result isn't in it: ask `mesh.job`, `discover.status` or `host.check_job` once it ends. Its text is cut as roster serve's answers are: a `cmd:` or `env:` Login reference in it (a failed check's `error.message`) reaches you as `cmd:` or `env:`. | [`JobProgressEvent`](#jobprogressevent) | `serve:mesh.job` or `serve:discover.status` or `serve:host.check_job` |

## Command lines a Plugin may run

`roster.cmd(line)`, and a `run` that's a command line (a row's, a button's, a finder item's, a toolbar control's), run the Plugin's own commands and only these of roster's, each with what it needs. Anything else is refused: `roster.cmd` raises an error, and a button that would run it says why in a notice instead.

| Command | What it does | Needs |
|---|---|---|
| `finder` | Opens a finder: `finder alerts`. | none |
| `view` | Opens a view: `view discover`. | none |
| `help` | Opens a help page: `help recent-alerts`. | none |
| `find` | Opens the Picker. | none |
| `info` | Shows a Host's details: `info esx-02`. | none |
| `changes` | Shows the Pending changes (Publishing them stays the user's). | none |
| `session` | Goes to the Nth Session (`roster.sessions.show` goes by id). | none |
| `next` | Goes to the next Session. | none |
| `prev` | Goes to the previous Session. | none |
| `check` | Runs roster's diagnostics for a Host and shows them, as `:check HOST` does: `check esx-02`. It connects to the Host, as `host.check` does. | `serve:host.check` |
| `open` | Opens a Host: its Session, or a new one. | `sessions.open` |
| `connect` | Opens a Session on a Host. | `sessions.open` |

## roster serve's results

What `roster.serve.call(method)` returns, for the methods a Plugin may be granted. JSON `null` is `nil`.

| Method | Result | In serve-api.md |
|---|---|---|
| `inventory.info` | [`InventoryInfo`](#inventoryinfo) | [inventory.info](serve-api.md) |
| `hosts.list` | [`HostList`](#hostlist) | [hosts.list](serve-api.md) |
| `host.get` | [`Host`](#host) | [host.get](serve-api.md) |
| `host.check` | [`HostCheck`](#hostcheck) | [host.check](serve-api.md#diagnostics-hostcheck) |
| `host.check_job` | [`CheckJob`](#checkjob) | [host.check_job](serve-api.md#diagnostics-hostcheck) |
| `changes.diff` | [`ChangesDiff`](#changesdiff) | [changes.diff](serve-api.md#editing-pending-changes) |
| `mesh.plan` | [`MeshResult`](#meshresult)`\|`[`MeshStarted`](#meshstarted) | [mesh.plan](serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus) |
| `mesh.apply` | [`MeshResult`](#meshresult)`\|`[`MeshStarted`](#meshstarted) | [mesh.apply](serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus) |
| `mesh.cut` | [`MeshCut`](#meshcut)`\|`[`MeshStarted`](#meshstarted) | [mesh.cut](serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus) |
| `mesh.status` | [`MeshStatus`](#meshstatus) | [mesh.status](serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus) |
| `mesh.job` | [`MeshJob`](#meshjob)`?` | [mesh.job](serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus) |
| `mesh.stop` | [`MeshStop`](#meshstop) | [mesh.stop](serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus) |
| `discover.plan` | [`DiscoverPlan`](#discoverplan) | [discover.plan](serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd) |
| `discover.start` | [`DiscoverStatus`](#discoverstatus) | [discover.start](serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd) |
| `discover.status` | [`DiscoverStatus`](#discoverstatus) | [discover.status](serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd) |
| `discover.stop` | [`DiscoverStop`](#discoverstop) | [discover.stop](serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd) |
| `discover.add` | [`DiscoverAdd`](#discoveradd) | [discover.add](serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd) |

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

What each gives is in [Permissions](plugins.md#permissions). `serve:<method>` names one method and `network:<site>` one site (`network:api.example.com`, `network:*.example.com`, `network:http://10.0.0.5:8080`); a bare `network`, or a serve method that reaches a secret, can't be asked for.

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

### `Timer`

A timer's id, from `roster.defer` or `roster.every`.

One of: `integer`

### `Level`

A notice's level.

One of: `"info" \| "warn" \| "error"`

### `Run`

What choosing a row, an action, a finder item or a status segment runs.

What choosing it runs: a function, called with a [`HandlerContext`](#handlercontext) that says which row, item or segment it was and the Session on screen (its return value is ignored), or a command line (`"open esx-02"`).

One of: `string \| fun(ctx: `[`HandlerContext`](#handlercontext)`): any`

### `HandlerContext`

What a row's, a button's, a finder item's, a status segment's, a toolbar control's, a question's, a progress's or a `:check` section's function is called with.

Since api 3 (api 2 called them with an empty table). Only the fields for what ran it are there: a row button has `section`, `row` and `action`; a finder item `finder` and `item`. A command's function gets [`CommandArgs`](#commandargs), which has `session` and `session_host` too.

| Field | Type | Required | Description |
|---|---|---|---|
| `section` | `string` | no | The Sidebar section's id, for a row or a row's button. |
| `row` | `string` | no | The row's `id` (its place in the list, `"3"`, if it has none). |
| `action` | `integer` | no | Which button was pressed, 1 for the first: of the row's `actions`, the section's (no `row` then) or the float's. |
| `dropped` | `string` | no | For a section's or a row's `drop`: the Host dropped on it (since api 3). |
| `finder` | `string` | no | The finder's id, for a finder item. |
| `item` | `string` | no | The item's `id` (its place, if it has none). |
| `segment` | `string` | no | The status segment's id. |
| `health` | `string` | no | The `:check` section's id, for its `check`. |
| `check` | `integer` | no | This `:check` run of the section, for its `check`: a check that returns `"later"` answers with [`roster.health.answer`](#rosterhealthanswercheck-lines)`(e.check, lines)` (since api 3). |
| `toolbar` | `string` | no | The toolbar control's id. |
| `progress` | `string` | no | The progress's id, for its `cancel`. |
| `confirm` | `"yes"\|"no"` | no | For a question's `run` (`"yes"`) or `cancel` (`"no"`, also when another Plugin's question replaced it). |
| `session` | `integer` | no | The Session on screen; `nil` with none. Only with `inventory.read` or `terminal.read`. |
| `session_host` | `string` | no | The Host of the Session on screen; `nil` with none, for a Quick Connect Session, and without `inventory.read` or `terminal.read`. (A table's function gets the row's Host as `host`: [`TableEvent`](#tableevent).) |

### `CommandSpec`

`roster.commands.add`'s second argument.

| Field | Type | Required | Description |
|---|---|---|---|
| `desc` | `string` | no | Its description, for `:help commands` and completion. The name if left out. |
| `run` | `string\|fun(args: `[`CommandArgs`](#commandargs)`): any` | yes | A function, called with what followed the command, or a command line to run instead. |
| `complete` | `fun(arg: string): string[]` | no | Since api 3: what Tab offers after the command's name. Called with what's typed after it (`"add esx"`) as the user types, it returns whole arguments that start with it (`{ "add esx-02 " }`; end one with a space when another word follows). At most 200; the app shows the last answer until the next comes. It isn't a call the user started: no clipboard, questions or command lines in it. |

### `CommandArgs`

What a command's function is called with.

| Field | Type | Required | Description |
|---|---|---|---|
| `args` | `string` | yes | Everything after the command's name, trimmed (`""` for none). |
| `words` | `string[]` | yes | `args` split at spaces (`{}` for none). |
| `session` | `integer` | no | The Session on screen; `nil` with none. Only with `inventory.read` or `terminal.read` (since api 3). |
| `session_host` | `string` | no | The Host of the Session on screen; `nil` with none, for a Quick Connect Session, and without `inventory.read` or `terminal.read` (since api 3). |
| `host` | `string` | no | The Host under the Sidebar's cursor (else the one on screen), as roster's own commands take it; `nil` with none, and without `inventory.read` (since api 3). |
| `section` | `string` | no | When the Sidebar's cursor is on a row of one of your own sections: that section's id (since api 3). |
| `row` | `string` | no | And that row's `id`, or `nil` on the section's heading (since api 3). |

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
| `actions` | [`RowAction`](#rowaction)`[]` | no | Buttons on its heading (`"Dismiss all"`), at most 4: shown while the heading is selected. |
| `count` | `number` | no | The count on its heading; the number of rows if left out (since api 3). |
| `drop` | [`Run`](#run) | no | Takes a Host dragged onto the heading or the empty section: it runs with `{ section, dropped = HOST }` (since api 3). |

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
| `icon` | [`RowGlyph`](#rowglyph) | no | A glyph before the label, as the app's Folders and groups have (since api 3). |
| `fold` | `boolean` | no | It folds the rows after it with a higher `level`, as a Folder or group does: `h`/`l`, its chevron and a click fold it, the app keeps what's folded, and its id for `:fold` is `SECTION:ID` (since api 3). |
| `kind` | `"host"` | no | With `host`: drawn as the Inventory draws that Host (its state, address, Details and Review buttons, then the row's own `actions`); `label` and `note` are used only while the Host isn't in the Inventory (since api 3). |
| `drop` | [`Run`](#run) | no | Takes a Host dragged onto the row: it runs with `{ section, row, dropped = HOST }` (since api 3). A row with a `host` can always be dragged. |
| `drag_out` | [`Run`](#run) | no | Runs when the row is dragged out of the section onto another part of the Sidebar, as a Host dragged out of a Folder leaves it (since api 3). |

### `NoticeOptions`

What else a notice has (`roster.notify`, since api 3).

| Field | Type | Required | Description |
|---|---|---|---|
| `actions` | [`NoticeAction`](#noticeaction)`[]` | no | Buttons under its text, at most 2. |
| `quiet` | `boolean` | no | An info notice's: whether it follows `ui.messages` (since api 4). Left out, it's quiet unless it has buttons; a warning or an error always shows. |

### `EchoOptions`

How a line on the message line is said (`roster.echo`, since api 4).

| Field | Type | Required | Description |
|---|---|---|---|
| `quiet` | `boolean` | no | A routine confirmation (`true`): shown only with `ui.messages = "all"`, heard by a screen reader and kept by `:messages` either way. Left out or `false`, it shows. |

### `ViewOpenOptions`

Where a view opens (`roster.views.open`, since api 4).

| Field | Type | Required | Description |
|---|---|---|---|
| `select` | `string` | no | The id of the node (a graph) or row (a table) to open at. |

### `NoticeAction`

A button on a notice.

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | `string` | yes | What it says (`"Show the plan"`). |
| `run` | `string` | yes | The command line a click runs, as `roster.cmd` would (`"view mesh-plan"`); then the notice goes. |

### `RowAction`

A button on a row.

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | `string` | yes | What it does, for its tooltip and screen readers (`"Unpin esx-02"`). |
| `icon` | [`RowIcon`](#rowicon) | no | Its icon; `info` if left out. |
| `run` | [`Run`](#run) | yes | What pressing it runs. |

### `HeadAction`

A button on a view's or a Host-details section's heading.

A [`RowAction`](#rowaction) with a key of its own (since api 4, #176): pressed anywhere in its view, or in its section, it runs the button, unless the table or graph there took the key first or a text field (a table's filter) has focus. Its tooltip shows the key.

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | `string` | yes | What it does, for its tooltip and screen readers (`"Plan"`). |
| `icon` | [`RowIcon`](#rowicon) | no | Its icon; `info` if left out. |
| `run` | [`Run`](#run) | yes | What pressing it runs. |
| `key` | `string` | no | One character (`"P"`) that runs it: not one a table or graph uses itself (`h j k l H J K L g G n N o O t f m s S / ? q + - = 0`), nor one of the view's table or graph actions' keys, nor another button's (since api 4). |

### `RowIcon`

A row action's icon.

`plan`, `apply` and `cut` since api 3 (ticket 91): a dashed arrow, an arrow into a bar, and an edge broken by a cross, as a cut edge is drawn in a graph. `map` since api 4: three nodes joined, for showing something on a graph.

One of: `"close" \| "edit" \| "add" \| "addGroup" \| "review" \| "unreview" \| "info" \| "copy" \| "plan" \| "apply" \| "cut" \| "map"`

### `RowGlyph`

A Sidebar row's glyph (since api 3).

One of: `"folder" \| "group"`

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
| `title` | `string` | no | Its title (the `:finder` command's label and the dialog's name); the id if left out. |
| `prompt` | `string` | no | What it shows before the query (`Folders ›`), at most 64 characters; its title if left out (since api 3). |
| `items` | [`FinderItem`](#finderitem)`[]\|fun(): `[`FinderItem`](#finderitem)`[]` | no | What it finds in, at most 2,000; or a function that returns them, run in the Plugin each time the finder opens (not a call the user started, whoever opened it; choosing an item is). Until it first answers the finder says it's loading; after that it shows the last answer while it asks again. |
| `section` | `string` | no | Instead of `items`: one of your own Sidebar sections, whose rows it finds in (with their paths, unfolded), as roster's own `inventory` finder does (since api 3). |

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
| `checks` | [`HealthCheck`](#healthcheck)`[]` | no | Its lines, as they are now. Left out with `check`. |
| `check` | `fun(ctx: `[`HandlerContext`](#handlercontext)`): `[`HealthCheck`](#healthcheck)`[]\|"later"` | no | Called on each `:check` (since api 3): returns the section's lines, or `"later"` and answers with [`roster.health.answer`](#rosterhealthanswercheck-lines) within 30 seconds, from a `roster.serve.request`'s `done` say. Wins over `checks`. |

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
| `actions` | [`FloatAction`](#floataction)`[]` | no | Buttons at its foot (at most 4). |
| `links` | [`Link`](#link)`[]` | no | Web pages to open in the browser (at most 4). |

### `FloatAction`

A button in a floating window.

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | `string` | yes | What it does (`"Go to the line"`). |
| `key` | `string` | no | One character that runs it while the window has focus (not `q`, which closes it). |
| `run` | [`Run`](#run) | yes | What pressing it runs. |

### `Link`

A web page a floating window links to.

The app shows the address's host next to the label, so the user sees where it goes before they click.

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | `string` | yes | Its text (`"Runbook"`). |
| `url` | `string` | yes | An `https://` or `http://` address; anything else is refused. |

### `Confirm`

A question the user answers (`roster.confirm`).

The app draws it with your Plugin's name on it. Text is cut to 500 characters, except `text` (4,000).

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | yes | The question (`"Cut esx-02 from the Mesh?"`). |
| `text` | `string` | no | What will happen, in the app's voice; a blank line starts a paragraph. |
| `facts` | [`Fact`](#fact)`[]` | no | Label and value pairs: exactly what will be done to what. |
| `action` | `string` | no | The confirming button's word (`"Cut"`); `"Confirm"` if left out. |
| `danger` | `boolean` | no | The stronger form, for what can't easily be undone: the button in the danger colour, the keys starting on Cancel. |
| `typed` | `string` | no | With `danger`: a word the user types before the button works (a Host's name), at most 100 characters. |
| `run` | `fun(e: table): any` | yes | Called when the user confirms. |
| `cancel` | `fun(e: table): any` | no | Called when they don't (`Esc` or Cancel), or another Plugin's question takes its place. |

### `Progress`

How far something long has got (`roster.progress.set`).

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | yes | What's going on (`"Scanning 10.0.0.0/24"`), at most 80 characters. |
| `text` | `string` | no | More, for its tooltip (`"12 Hosts found"`). |
| `done` | `number` | no | How much is done, with `total`. |
| `total` | `number` | no | How much there is; with `done`, shown as a share. Without both, it only shows it's going. |
| `cancel` | [`Run`](#run) | no | What stopping it runs: the button and `:cancel ID` call it once. |

### `ToolbarControl`

A control in the toolbar (`roster.toolbar.set`).

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | `string` | yes | What it does, for its tooltip and screen readers (`"Scan a network"`), at most 80 characters. |
| `text` | `string` | no | A word shown beside the icon (at most 20 characters); without an icon, the label is shown. |
| `icon` | [`ToolbarIcon`](#toolbaricon) | no | Its icon. |
| `run` | [`Run`](#run) | yes | What pressing it runs. |

### `ToolbarIcon`

A toolbar control's icon.

`map` is three nodes joined: a network, Topology.

One of: `"find" \| "add" \| "details" \| "help" \| "map"`

### `View`

A side panel or a full view (`roster.views.set`).

Drawn top to bottom: the text, the facts, then the table or the graph (one or the other, not both). Text is cut to 500 characters, except `text` (4,000).

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | no | Its heading; the id if left out. |
| `place` | [`ViewPlace`](#viewplace) | no | Where it opens first: `"panel"` (the default) or `"full"`. The user can move it to the other and widen or narrow it (`␣ z`, `␣ <`, `␣ >`); their choice, and init.lua's `views.ID`, win over it. |
| `actions` | [`HeadAction`](#headaction)`[]` | no | Buttons on its heading, at most 4, for what the whole view does (`Plan`, `Apply`): each runs with `{ view }` (since api 3), and its `key` runs it from anywhere in the view (since api 4). |
| `text` | `string` | no | A few lines above the rest, in the app's voice; a blank line starts a paragraph. |
| `facts` | [`Fact`](#fact)`[]` | no | Label and value pairs, as a Host's details show them. |
| `table` | [`Table`](#table) | no | A table of rows. |
| `graph` | [`Graph`](#graph) | no | A graph of nodes and edges, in place of a table. |

### `ViewPlace`

Where a view goes.

One of: `"panel" \| "full"`

### `ViewUpdate`

What `roster.views.update` changes.

Plain data, but for `actions`. A field left out stays as it is.

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | no | A new heading. |
| `text` | `string` | no | New text; `""` takes it away. |
| `facts` | [`Fact`](#fact)`[]` | no | New facts, all of them. |
| `rows` | [`TableRow`](#tablerow)`[]` | no | Rows to add or replace, by `id` (at most 2,000 at once). |
| `remove` | `string[]` | no | The ids of rows to take away; in a graph, of nodes (their edges go too) and clusters (their nodes stay, loose). |
| `clear` | `boolean` | no | `true` takes every row of the table away first, in one go (a new scan); `rows` then fill it again (since api 3). |
| `nodes` | [`GraphNode`](#graphnode)`[]` | no | A graph's nodes to add or replace, by `id`. |
| `edges` | [`GraphEdge`](#graphedge)`[]` | no | A graph's edges to add or replace, by `id`. |
| `clusters` | [`GraphCluster`](#graphcluster)`[]` | no | A graph's clusters to add or replace, by `id`. |
| `remove_edges` | `string[]` | no | The ids of a graph's edges to take away. |
| `filter` | [`GraphFilter`](#graphfilter) | no | A graph's new filter, in place of the one it has and the user's (`{}` shows everything). |
| `columns` | [`Column`](#column)`[]` | no | New columns, all of them; the rows keep their cells. |
| `sort` | `string` | no | Sort by this column now (the user's sort gives way). |
| `desc` | `boolean` | no | With `sort`: highest first. |
| `actions` | [`TableAction`](#tableaction)`[]` | no | New actions, all of them: their functions replace the old ones' (`open` stays). |

### `DetailsSection`

A section of a Host's details (`roster.details.set`).

Drawn after roster's own sections, with your Plugin's name under its heading: the text, the facts, then the table.

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | no | Its heading; the id if left out. |
| `order` | `number` | no | Where it goes among the Plugins' sections, lowest first; 500 if left out. |
| `actions` | [`HeadAction`](#headaction)`[]` | no | Buttons on its heading, at most 4, for what the section does about this Host (`Cut`): each runs with `{ section, host }` (since api 3), and its `key` runs it from anywhere in the section (since api 4). |
| `text` | `string` | no | A few lines, in the app's voice. |
| `facts` | [`Fact`](#fact)`[]` | no | Label and value pairs. |
| `table` | [`Table`](#table) | no | A table of rows. |

### `Fact`

A label and its value.

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | `string` | yes | What it is (`reach`). |
| `value` | `string` | yes | Its value (`can reach 7 Hosts`). |
| `data` | `boolean` | no | `true` for something you could paste into a shell (an address, a name), set in the data font. |

### `Table`

A table: columns, rows as plain data, and what a row can do.

The app sorts it, keeps the selected row across changes and draws only the rows on screen, so it stays smooth at thousands of rows. Keys, once it has focus: `j`/`k` or the arrows move, `g g`/`G` go to the first and last row, `Ctrl+D`/`Ctrl+U` half a page, `s` sorts by the next column and `S` reverses it, `/` filters the rows by what they say (`Esc` clears it), `Enter` runs `open`, an action's `key` runs it. A click selects a row, a double click opens it, and a click on a heading sorts by it. The selected row shows its actions as buttons.

| Field | Type | Required | Description |
|---|---|---|---|
| `columns` | [`Column`](#column)`[]` | yes | Its columns, left to right (1 to 20). |
| `rows` | [`TableRow`](#tablerow)`[]` | no | Its rows (at most 2,000 here; `roster.views.update` adds more, up to 10,000). |
| `sort` | `string` | no | The column it's sorted by at first; as given if left out. |
| `desc` | `boolean` | no | Sorted highest first. |
| `empty` | `string` | no | What it says with no rows. |
| `open` | [`TableRun`](#tablerun) | no | What `Enter` (or a double click) on a row runs. Without it, a row with a `host` opens that Host; others do nothing. |
| `actions` | [`TableAction`](#tableaction)`[]` | no | What can be done to the selected row (at most 8). |

### `Column`

A table's column.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | The key of its value in each row's `cells`. |
| `label` | `string` | yes | Its heading. |
| `kind` | [`ColumnKind`](#columnkind) | no | How its values read and sort; `"text"` if left out. |
| `width` | `number` | no | How wide, in characters; it shares the room with the others if left out. |

### `ColumnKind`

How a column's values read and sort.

`"text"` is words, in the app's font. `"data"` is something you could paste into a shell (an address, a name), in the data font, sorted with the numbers in it as numbers (`10.0.0.9` before `10.0.0.10`). `"number"` is right-aligned with even digits, sorted as numbers.

One of: `"text" \| "data" \| "number"`

### `TableRow`

A row of a table: plain data.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | Unique in the table (at most 100 characters): updates and the selection follow it. |
| `cells` | `table<string, string\|number>` | no | Its value in each column, by the column's `id`; a column it lacks is blank and sorts last. |
| `host` | `string` | no | The Host it's about: `Enter` opens it when the table has no `open`, and actions get it as `e.host`. |
| `tone` | [`RowTone`](#rowtone) | no | Drawn quieter (`"muted"`: ended, down) or marked (`"warn"`, `"error"`). |

### `RowTone`

How a table row is marked.

One of: `"muted" \| "warn" \| "error"`

### `TableAction`

Something a table's selected row can do.

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | `string` | yes | What it does (`"Keep"`), on its button and in the key hints. |
| `key` | `string` | no | One character that runs it on the selected row, not one the table uses itself. |
| `icon` | [`RowIcon`](#rowicon) | no | Its button's icon; the label alone if left out. |
| `when` | `table<string, string\|number\|(string\|number)[]>` | no | Only on the rows whose cells match: `{ state = "up" }`, or a list of values (`{ state = { "up", "slow" } }`). A cell needn't be a column, so a row can carry what decides it without showing it. |
| `run` | [`TableRun`](#tablerun) | yes | What it runs. |

### `TableRun`

What a table's row or action runs.

A function gets a [TableEvent](#tableevent): which row, in which view or section, and its Host. A command line runs as typed after `:`.

One of: `string \| fun(e: `[`TableEvent`](#tableevent)`): any`

### `TableEvent`

What a table's function gets.

| Field | Type | Required | Description |
|---|---|---|---|
| `row` | `string` | yes | The row's `id`. |
| `host` | `string` | no | The row's `host`, or the Host whose details the section is in. |
| `view` | `string` | no | The view's id, in a view. |
| `section` | `string` | no | The section's id, in a Host's details. |

### `HttpRequest`

What `roster.http.request` sends.

Any other key is an error.

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | `string` | yes | Where: on a site the Plugin was granted (`https://api.example.com/v1/alerts`). |
| `method` | `string` | no | `GET` (the default), `HEAD`, `POST`, `PUT`, `PATCH` or `DELETE`, in any case. |
| `headers` | `table<string, string>` | no | Headers to send, such as a token of the Plugin's own (`Authorization`). Not the ones that steer the connection (`Host`, `Content-Length`, `Proxy-…`). roster adds only `User-Agent: roster/VERSION` and what HTTP needs. |
| `body` | `string` | no | The body, at most 256 KB; bytes as they are. |
| `timeout` | `number` | no | Seconds to wait for the whole answer; at most 30 (the default). 10 seconds to connect. |

### `HttpResponse`

What a site answered.

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | `integer` | yes | The status code (`200`, `404`). |
| `url` | `string` | yes | Where it ended, after redirects. |
| `headers` | `table<string, string>` | yes | By lower-case name; a header sent twice has its values joined with `, `. |
| `body` | `string` | yes | The body, at most 1 MB, as bytes: not decompressed, not decoded. |

### `Graph`

A graph: nodes, edges and clusters as plain data, and what a node can do.

The app lays it out (each cluster's nodes on a spiral, the clusters in rows, loose nodes first), keeps every position in the State so it opens the same way each time, and draws only what's on screen, so 2,000 nodes stay smooth. Clusters collapse to one node with their count: the user's `o`, or by themselves when the graph has more than 300 nodes and the cluster doesn't say. Keys, once it has focus: `h` `j` `k` `l` or the arrows go to the nearest node that way, `/` searches (name, id, kind, note, detail, cluster) and `n`/`N` go through the matches, `Enter` runs `open` (or opens a collapsed cluster), `o` collapses or opens the selected node's cluster and `O` all of them, `+` `-` zoom and `0` shows it all, `H` `J` `K` `L` pan, `t` switches to a table of every node, then of every edge, `f` goes to the filter (the clusters, kinds and states to show, as many of each as the user ticks, hiding the rest; `Esc` clears a search, then the filter, then closes the view), `m` moves the selected node with `h` `j` `k` `l` or the arrows (`Shift` for a bigger step) until `Enter` keeps its place or `Esc` puts it back (on a collapsed cluster it says to open it first), and an action's `key` runs it on the selected node (only where its `when` matches). Selecting a node lights up what it can reach and what can reach it, with the counts: however many hops away, or only one with `reach = "direct"`. Hiding nodes doesn't change what they reach: the counts are the whole graph's. A click selects, a double click opens, a drag moves a node (kept) or pans, the wheel zooms. An edge whose end names nothing is left out until it does.

| Field | Type | Required | Description |
|---|---|---|---|
| `nodes` | [`GraphNode`](#graphnode)`[]` | no | Its nodes, in order: a cluster's first node is at its centre (at most 5,000). |
| `edges` | [`GraphEdge`](#graphedge)`[]` | no | Its edges (at most 10,000). |
| `clusters` | [`GraphCluster`](#graphcluster)`[]` | no | Its clusters, in order (at most 500). |
| `reach` | [`GraphReach`](#graphreach) | no | How far a node's reach goes, for the counts and what selecting it lights up: `"all"` (the default) every hop, `"direct"` one. |
| `filter` | [`GraphFilter`](#graphfilter) | no | What it shows to begin with; the rest is hidden until the user changes it (`f`). |
| `open` | [`NodeRun`](#noderun) | no | What `Enter` (or a double click) on a node runs. Without it, a node with a `host` opens that Host. |
| `actions` | [`NodeAction`](#nodeaction)`[]` | no | What can be done to the selected node (at most 8). |

### `GraphNode`

A node of a graph: plain data.

Its shape says what it is and its state what it's doing, never colour alone: the list says both in words.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | Unique among the graph's nodes and clusters (at most 100 characters): edges, updates and the selection follow it. |
| `label` | `string` | no | Its name on the map; the id if left out. |
| `kind` | `string` | no | What sort of thing it is (`"esxi"`): searched, and a column in the list. |
| `shape` | [`NodeShape`](#nodeshape) | no | How it's drawn; `"dot"` if left out. |
| `state` | [`NodeState`](#nodestate) | no | Live (in the accent) or down. |
| `mark` | [`NodeMark`](#nodemark) | no | A small warn or error mark beside it. |
| `note` | `string` | no | A few words (`"out of date"`), beside it when selected and in the list. |
| `cluster` | `string` | no | The id of the cluster it's in. |
| `host` | `string` | no | The Host it is: `Enter` opens it when the graph has no `open`, and actions get it as `e.host`. |
| `detail` | `string` | no | A second line in the data font (an address), when selected and in the list. |

### `NodeShape`

How a node is drawn.

As roster draws its own (taste.md): `"dot"` filled (a key login), `"ring"` (a password login), `"dashed"` a dashed ring in the second tone (unreviewed), `"hollow"` a thin grey ring (ended), `"square"` in the second tone (this Box).

One of: `"dot" \| "ring" \| "dashed" \| "hollow" \| "square"`

### `NodeState`

What a node is doing.

`"live"` is drawn in the accent, which means connected now; keep it for that. `"down"` is drawn quieter and crossed out.

One of: `"live" \| "down"`

### `NodeMark`

A node's mark.

One of: `"warn" \| "error"`

### `GraphEdge`

An edge of a graph: plain data.

An end is a node or a cluster: an edge to a cluster reaches every node in it, and one from a cluster is every node's in it, so one edge can stand for a group's Links. Edges to the same collapsed cluster are drawn as one, with their count.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | no | Unique among its edges; `"FROM>TO"` if left out. |
| `from` | `string` | yes | The id of the node or cluster it starts at. |
| `to` | `string` | yes | The id of the node or cluster it goes to. |
| `dir` | [`EdgeDir`](#edgedir) | no | `"one"` (the default) is one way, with an arrow at `to`; `"both"` is each way. |
| `style` | [`EdgeStyle`](#edgestyle) | no | Its line; `"solid"` if left out. |
| `tone` | [`EdgeTone`](#edgetone) | no | Live (in the accent), muted, or marked warn or error. |
| `cut` | `boolean` | no | `true` draws it broken in the middle by a cross: about to be cut. |
| `label` | `string` | no | A few words about it, in the list. |

### `EdgeDir`

Which way an edge goes.

One of: `"one" \| "both"`

### `EdgeStyle`

An edge's line.

One of: `"solid" \| "dashed" \| "dotted"`

### `EdgeTone`

How an edge is marked.

`"live"` is the accent: keep it for a connection that's open now. An edge that turns live is drawn in from its start, as a Session's edge is on connect (not under reduced motion).

One of: `"live" \| "muted" \| "warn" \| "error"`

### `GraphCluster`

A cluster of a graph's nodes.

Drawn as a circle around its nodes with its title above, or collapsed to one node with its count.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | Unique among the graph's nodes and clusters: nodes name it as their `cluster`. |
| `title` | `string` | no | Its title; the id if left out. |
| `mesh` | `boolean` | no | `true`: every node in it reaches every other, both ways, without an edge for each pair (the Mesh's `mesh: true`). |
| `collapsed` | `boolean` | no | How it starts: collapsed (`true`) or open (`false`). Left out, it collapses when the graph has more than 300 nodes. The user's own choice is kept and wins. |

### `GraphReach`

How far a graph's reach goes.

`"all"`: however many hops away, as a key on a Host reaches what that Host's own keys reach. `"direct"`: one hop, a node's own edges, its cluster's and its cluster's mesh.

One of: `"all" \| "direct"`

### `GraphFilter`

What a graph shows: the rest is hidden.

A node shows when it's in one of the `clusters`, of one of the `kinds` and in one of the `states`, for each that's given; leave one out (or empty) for all. Edges with a hidden end and clusters with no node left are hidden too. The user picks one cluster, kind or state at a time in the graph's filter (`f`); a filter that names several shows as "N clusters" there.

| Field | Type | Required | Description |
|---|---|---|---|
| `clusters` | `string[]` | no | Cluster ids: only their nodes show (at most 500). |
| `kinds` | `string[]` | no | Kinds (a node's `kind`): only nodes of these show (at most 500). |
| `states` | [`FilterState`](#filterstate)`[]` | no | A node's `state` or `mark`: only nodes live, down, or marked warn or error show. |

### `FilterState`

A state a graph's filter keeps.

A node's `state` (`"live"`, `"down"`) or `mark` (`"warn"`, `"error"`).

One of: `"live" \| "down" \| "warn" \| "error"`

### `NodeAction`

Something a graph's selected node can do.

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | `string` | yes | What it does (`"Check"`), in the key hints. |
| `key` | `string` | no | One character that runs it on the selected node, not one the graph uses itself. |
| `icon` | [`RowIcon`](#rowicon) | no | Its icon in the node list's buttons. |
| `when` | `table<string, string\|number\|(string\|number)[]>` | no | Only on the nodes whose fields match, as a table action's `when` (since api 3): `{ state = "live" }`, or a list of values (`{ kind = { "esxi", "linux" } }`). It names a node's own fields (`id`, `label`, `kind`, `shape`, `state`, `mark`, `note`, `cluster`, `host`, `detail`); a field the node leaves out matches nothing. Elsewhere its key does nothing and its hint isn't shown. |
| `run` | [`NodeRun`](#noderun) | yes | What it runs. |

### `NodeRun`

What a graph's node or action runs.

A function gets a [NodeEvent](#nodeevent): which node, its Host, and the Session on screen. A command line runs as typed after `:`, as the Plugin's (`:plugins run`).

One of: `string \| fun(e: `[`NodeEvent`](#nodeevent)`): any`

### `NodeEvent`

What a graph's function gets.

| Field | Type | Required | Description |
|---|---|---|---|
| `node` | `string` | yes | The node's `id`. |
| `host` | `string` | no | The node's `host`. |
| `view` | `string` | yes | The view's id. |
| `session` | `integer` | no | The Session on screen, as in a [`HandlerContext`](#handlercontext): only with `inventory.read` or `terminal.read`. |
| `session_host` | `string` | no | The Host of the Session on screen, as in a [`HandlerContext`](#handlercontext). |

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

`PROVIDER:ITEM`, a vault item's name (`bw:esx-02 ssh`, `op:Lab/esx-02#password`, `kp:esx-02 ssh`), or `prompt` (asked for), `agent` (an ssh key), `key`, `none`. `env:VAR` and `cmd:COMMAND` are references too, but they say how a secret is fetched (and a secret pasted into a `cmd:` line would show), so a Plugin gets them cut to their kind: `env:` and `cmd:` (since api 3; decision Q92), in raw text such as a diff or a check's message too. The providers are in [Password providers](cli-reference.md#password-providers).

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

### `CheckJob`

`host.check_job`'s result: a Host's check, and how it came out.

Since serve API 21 a check is a job: the `job_progress` event (with `serve:host.check_job`) says when one starts, moves on and ends, the app's `:check` and Check from anywhere alike, and its `job` is what to ask for here once its `state` is `done` or `stopped`. serve keeps a check findable after it ends (the last 32 a newer check replaced too); one it no longer has is code 49.

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | `"check"` | yes | Always `"check"`. |
| `job` | `string` | yes | Its id, `"check-N"`. |
| `action` | `"check"` | yes | Always `"check"`. |
| `state` | `string` | yes | `"running"`, `"stopping"`, or how it ended: `"done"`, `"stopped"`, `"failed"`. |
| `done` | `integer` | yes | Steps started. |
| `total` | `integer` | yes | Steps in all (8). |
| `at` | `string` | no | The step under way (`"dns"`, `"auth"`, ...). |
| `host` | `string` | yes | The Host it checks. |
| `result` | [`HostCheck`](#hostcheck) | no | Once `done` or `stopped`: `host.check`'s result. `ok` is false for a stopped check, its later steps `skipped`. |
| `error` | [`ServeError`](#serveerror) | no | Once `failed`: why. |

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
| `diff` | `string` | yes | git's diff of `roster.yml` against the last commit; `""` for none. A `cmd:` reference in it reaches a Plugin cut to `cmd:` (the rest of its line), an `env:` one to `env:`. |
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

### `MeshResult`

`mesh.plan`'s and `mesh.apply`'s result.

With `brief = true` (on `mesh.job`), `links` keeps only those worth a look and `link_count`, `link_statuses`, `reached` and `links_more` count the rest.

| Field | Type | Required | Description |
|---|---|---|---|
| `applied` | `boolean` | yes | `false` for a plan (nothing changed), `true` for an apply. |
| `links` | [`MeshLink`](#meshlink)`[]` | yes | Every Link, with how it went. |
| `hosts` | [`MeshHost`](#meshhost)`[]` | yes | Every Host visited. |
| `excluded` | `table<string, string>` | yes | Hosts kept out, and why (`not reviewed (reviewed: false)`, `mesh: false`). |
| `reach` | `table<string, integer>` | yes | How many Hosts each source reaches, counting the Links that work. |
| `pending` | `table<string, string>` | yes | Hosts that didn't answer, and why. |
| `already` | `boolean` | yes | Nothing to change and nothing pending: already in the Mesh. |
| `warnings` | `string[]` | yes | Words to show (a `ROSTER.md` that isn't roster's, a Host that left `roster.yml`). |
| `cut_pending` | `table<string, string[]>` | yes | Earlier cuts not finished yet: a Host, and the peers still to do. |
| `link_count` | `integer` | no | Brief: how many Links there are in all. |
| `link_statuses` | `table<string, integer>` | no | Brief: how many Links have each status. |
| `reached` | `table<string, integer>` | no | Brief: how many Hosts reach each Host. |
| `links_more` | `integer` | no | Brief: the Links worth a look that `links` leaves out (it keeps 1,000). |

### `MeshLink`

A Link of the Mesh: a source reaching a peer.

| Field | Type | Required | Description |
|---|---|---|---|
| `from` | `string` | yes | The source Host. |
| `to` | `string` | yes | The peer it reaches. |
| `kind` | `"key"\|"password"` | yes | `password` when the peer asks for one. |
| `status` | `"ok"\|"untested"\|"unreachable"\|"no-host-key"\|"no-via"\|"pending"\|"skipped"` | no | How it went; `mesh.status` gives none (it never connects), except `no-via` with `brief`. `unreachable`, `no-host-key` and `no-via` are left out. |
| `why` | `string` | no | The status in words. |
| `via` | `string` | no | The Host the source goes through to the peer (a Link's `via:`). |
| `skip` | `string` | no | Why roster didn't write it: `"password-source"`. |

### `MeshHost`

A Host a Mesh run visited.

| Field | Type | Required | Description |
|---|---|---|---|
| `host` | `string` | yes | Its name. |
| `status` | `"same"\|"would-change"\|"changed"\|"pending"` | yes | `would-change` from a plan, `changed` from an apply, `pending` when it didn't answer. |
| `changes` | `string[]` | yes | Short phrases: `make key`, `write ssh config`, `add key from orion-2`, … |
| `error` | `string` | no | Why it's pending. |
| `more` | `integer` | no | Brief: the changes left out (it keeps 10). |

### `MeshStarted`

A Mesh run started with `background = true`.

Its result comes in `mesh.job`, and `job_progress` events follow it.

| Field | Type | Required | Description |
|---|---|---|---|
| `job` | `integer` | yes | The job's number, for `mesh.job` and `mesh.stop`. |
| `action` | `"plan"\|"apply"\|"cut"` | yes | What it does. |
| `total` | `integer` | yes | How many Hosts it visits. |
| `host` | `string` | no | A cut's Host. |

### `MeshCut`

`mesh.cut`'s result.

| Field | Type | Required | Description |
|---|---|---|---|
| `host` | `string` | yes | The Host cut from the Mesh. |
| `confirmed` | `string[]` | yes | The peers whose keys it took off, and that took its off. |
| `pending` | `table<string, string>` | yes | The peers that didn't answer, and why: the next cut finishes them. |
| `warnings` | `string[]` | no | What roster left on the cut Host's own side, one sentence each: an earlier `mesh_dir:` that still holds a Mesh key, which roster never removes (serve API 24; absent before). |
| `change` | [`MeshCutChange`](#meshcutchange) | yes | The `mesh: false` written for it as a Pending change. |

### `MeshCutChange`

The `mesh: false` a `mesh.cut` writes into `roster.yml`.

| Field | Type | Required | Description |
|---|---|---|---|
| `written` | `boolean` | yes | Whether it was written now (`false` when it already was, or couldn't be). |
| `backup` | `string` | no | The copy of `roster.yml` from before; `nil` when it isn't in a git repo. |
| `note` | `string` | no | Why nothing was written, or that it went straight to a file outside git. |
| `error` | `string` | no | Why it couldn't be written (the cut still happened). |
| `fix` | `string` | no | What to do then, in a sentence. |

### `MeshStatus`

`mesh.status`'s result: the Mesh as `roster.yml` asks for it.

It never connects. `brief = true` keeps it small as in a brief [`MeshResult`](#meshresult); `grouped = true` says each meshed group once (`meshed`) and leaves the pairs it covers out of `links`.

| Field | Type | Required | Description |
|---|---|---|---|
| `links` | [`MeshLink`](#meshlink)`[]` | yes | The Links, without a `status`. |
| `excluded` | `table<string, string>` | yes | Hosts kept out, and why. |
| `reach` | `table<string, integer>` | yes | How many Hosts each source reaches. |
| `members` | `string[]` | yes | The Hosts roster visits. |
| `pending` | `table<string, string>` | yes | Hosts the last run didn't finish, and why. |
| `cut_pending` | `table<string, string[]>` | yes | Earlier cuts not finished yet. |
| `out_of_date` | `boolean` | yes | `roster.yml` changed the Mesh since the last complete apply on this Box. |
| `meshed` | `table<string, string[]>` | no | Grouped: each meshed group's Hosts that reach each other both ways. |
| `link_count` | `integer` | no | Brief: how many Links there are in all. |
| `link_statuses` | `table<string, integer>` | no | Brief: how many Links have each status (`asked` for untested ones). |
| `reached` | `table<string, integer>` | no | Brief: how many Hosts reach each Host. |
| `links_more` | `integer` | no | Brief: the Links worth a look that `links` leaves out. |

### `MeshJob`

`mesh.job`'s result: how far a Mesh run has got.

`nil` when there's no job, or `job` isn't the latest.

| Field | Type | Required | Description |
|---|---|---|---|
| `job` | `integer` | yes | Its number. |
| `action` | `"plan"\|"apply"\|"cut"` | yes | What it does. |
| `host` | `string` | no | A cut's Host. |
| `state` | `"running"\|"done"\|"failed"` | yes | Where it is. |
| `done` | `integer` | yes | Hosts done so far. |
| `total` | `integer` | yes | Hosts in all. |
| `at` | `string` | no | The Host it's on. |
| `stopped` | `boolean` | yes | `mesh.stop` asked it to stop; the Hosts it hadn't got to are pending. |
| `result` | [`MeshResult`](#meshresult)`\|`[`MeshCut`](#meshcut) | no | Once `done`: what the method itself returns. |
| `error` | [`ServeError`](#serveerror) | no | Once `failed`: why. |

### `ServeError`

An error roster serve answered with.

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `integer` | yes | Its code, in serve-api.md's tables. |
| `message` | `string` | yes | What went wrong. |
| `data` | `table` | no | More about it, as its row says. |

### `MeshStop`

`mesh.stop`'s result.

| Field | Type | Required | Description |
|---|---|---|---|
| `job` | `integer` | yes | The job. |
| `stopping` | `boolean` | yes | `false` when it isn't running (over already, or not the latest). |

### `DiscoverPlan`

`discover.plan`'s result: what a scan would visit.

| Field | Type | Required | Description |
|---|---|---|---|
| `targets` | `string[]` | yes | The targets as written back, without one another covers. |
| `addresses` | `integer` | yes | How many addresses they hold. |
| `ports` | `integer` | yes | How many ports it tries on each. |
| `scanner` | `"nmap"\|"built-in"` | yes | nmap, or roster's own TCP connect scan without it. |
| `limit` | `integer` | yes | The most addresses without `force` (4,096). |
| `max` | `integer` | yes | The most with `force` (65,536). |

### `DiscoverStatus`

`discover.status`'s and `discover.start`'s result: how far a scan has got.

| Field | Type | Required | Description |
|---|---|---|---|
| `scan` | `string` | yes | Its id (`"scan-N"`). |
| `state` | `"running"\|"stopping"\|"done"\|"stopped"\|"failed"` | yes | Where it is. |
| `targets` | `string[]` | yes | What it scans. |
| `scanner` | `"nmap"\|"built-in"` | yes | What it scans with. |
| `done` | `integer` | yes | Addresses visited so far. |
| `total` | `integer` | yes | Addresses in all. |
| `count` | `integer` | yes | How many it found in all: the next `since`. |
| `quiet` | `integer` | yes | How many answered with none of the ports open (nmap only). |
| `found` | [`DiscoverFound`](#discoverfound)`[]` | yes | What it found, after the first `since`. |
| `error` | `string` | no | Why it `failed`. |

### `DiscoverFound`

Something a scan found at an address.

| Field | Type | Required | Description |
|---|---|---|---|
| `address` | `string` | yes | Its address. |
| `name` | `string` | no | The name it would be added as; `nil` when `known` names the Host already there. |
| `type` | `string` | yes | The guessed kind. |
| `hostname` | `string` | yes | Its name in DNS; `""` for none. |
| `title` | `string` | yes | A web page's title; `""` for none. |
| `web` | `string` | no | Its web address, when it serves one. |
| `known` | `string` | no | The Inventory's Host at that address. |
| `added` | `string` | no | The name `discover.add` gave it. |
| `vendor` | `string` | yes | The network card's maker (nmap); `""` when unknown. |
| `os` | `string` | yes | The guessed operating system (nmap); `""` when unknown. |
| `mac` | `string` | yes | Its MAC address (nmap, on the same network); `""` when unknown. |
| `ports` | [`DiscoverPort`](#discoverport)`[]` | yes | Its open ports. |

### `DiscoverPort`

An open port a scan found.

| Field | Type | Required | Description |
|---|---|---|---|
| `port` | `integer` | yes | Its number. |
| `name` | `string` | yes | The service's name (`ssh`). |
| `product` | `string` | yes | What answered (`OpenSSH 9.6`); `""` when unknown. |
| `title` | `string` | yes | A web page's title; `""` for none. |

### `DiscoverStop`

`discover.stop`'s result.

| Field | Type | Required | Description |
|---|---|---|---|
| `scan` | `string` | yes | The scan. |
| `stopping` | `boolean` | yes | `false` when it had ended already; `discover.status` says `stopped` once it has. |

### `DiscoverAdd`

`discover.add`'s result.

| Field | Type | Required | Description |
|---|---|---|---|
| `group` | `string` | yes | The new group they went in. |
| `added` | [`DiscoverAdded`](#discoveradded)`[]` | yes | Each Host added, `reviewed: false`, as a Pending change. |
| `backup` | `string` | no | The copy of `roster.yml` from before. |

### `DiscoverAdded`

A Host `discover.add` added.

| Field | Type | Required | Description |
|---|---|---|---|
| `address` | `string` | yes | Its address. |
| `name` | `string` | yes | Its name in `roster.yml`. |

### `EventName`

An event a Plugin can listen for.

One of: `"lock" \| "unlock" \| "host_selected" \| "session_open" \| "session_exit" \| "inventory_changed" \| "terminal_output" \| "command_done" \| "job_progress"`

### `EmptyEvent`

The payload of `lock`, `unlock` and `inventory_changed`: an empty table.

No fields.

### `HostSelectedEvent`

`host_selected`'s payload.

| Field | Type | Required | Description |
|---|---|---|---|
| `host` | `string` | yes | The Host whose Session is on screen now. |

### `Session`

An open Session, as `roster.sessions.list` gives it.

| Field | Type | Required | Description |
|---|---|---|---|
| `session` | `integer` | yes | The Session's id, as its events name it: `roster.terminal.send` and `roster.sessions.show` take it. |
| `host` | `string` | no | The Host's name; `nil` for a Quick Connect Session (`:quick`), which isn't on a Host. |

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
| `host` | `string` | no | The Host's name; `nil` for a Quick Connect Session. A tab closed while it ran has it too (since api 3). |
| `code` | `integer` | no | ssh's exit code; `nil` when it failed to start or its tab was closed. |

### `JobProgressEvent`

`job_progress`'s payload: serve's `job.progress` notification.

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | `string` | yes | `"mesh"`, `"discover"` or `"check"`. |
| `job` | `integer\|string` | yes | Its id within its kind, as that kind's methods name it: the Mesh's job number (`mesh.job { job = N }`), the scan's `"scan-N"` (`discover.status { scan = ... }`), the check's `"check-N"` (`host.check_job { job = ... }`). |
| `action` | `string` | yes | `"plan"`, `"apply"` or `"cut"` for the Mesh; `"scan"` for Discover; `"check"` for a check. |
| `state` | `string` | yes | `"running"`, `"stopping"`, or how it ended: `"done"`, `"stopped"`, `"failed"`. |
| `done` | `integer` | yes | How far it has got: Hosts visited, addresses scanned, a check's steps started (of 8). |
| `total` | `integer` | yes | Of how many. |
| `at` | `string` | no | The Host it's on, when it's on one; a check's step (`"dns"`, `"auth"`, ...). |
| `host` | `string` | no | A cut's Host; the Host a check checks. |
| `error` | `table` | no | How it failed: `{ code, message, data? }`, as serve's error. |

### `TerminalOutputEvent`

`terminal_output`'s payload.

What you type into a Session is never an event, but the shell echoes it back, so it's here like anything else the Session prints (a shell with OSC 133 marks labels that line `kind = "input"`).

| Field | Type | Required | Description |
|---|---|---|---|
| `session` | `integer` | yes | The Session's id. |
| `host` | `string` | no | The Host's name; `nil` for a Quick Connect Session. |
| `text` | `string` | yes | The lines it finished since the last one, each ending in `\n`, as the terminal shows them: no colours or escape sequences, a line the program rewrote (a progress bar) only as it ended up, a long line that wrapped as one. A line is sent when the Session moves past it, so the one with the cursor (a prompt) waits. A line drawn again with the same text in the same place isn't sent again, so the screen a resized Session prints again (ConPTY does on Windows) doesn't repeat what you had. What a full-screen program (`vim`, `top`, `less`) draws isn't sent. At most the last 16 KB. |
| `kind` | `string` | no | What the Session's shell's OSC 133 marks say these lines are (since api 4): `"prompt"` (a few lines after its prompt starts), `"input"` (the line typed at the prompt: the shell's echo of your command), `"output"` (what a command printed), or `nil` (no marks, or nothing they say). All the lines in `text` are of one kind; a batch of several kinds comes as several events, in order. A hint, not a guarantee: the marks come from the Host and anything it prints can forge them, and an `"output"` line may be an `ssh` or nested shell echoing what you type. Every line is sent whatever its kind. |

### `CommandDoneEvent`

`command_done`'s payload.

Read from the OSC 133 marks the Session's own shell prints (its rc file turns them on, or roster's opt-in shell hooks do). The command line is read off the screen once the shell runs it, so a line given up (Ctrl-C) or erased is never one, and what the screen doesn't show (a password at a prompt that doesn't echo it) can't be. The marks come from the Host, so this is its word: a hint. A command a nested shell with marks took over (`ssh` to a Host with integration) has none, since its end can't be told from the nested shell's; nor does `exit` or `logout`, since a shell that exits sends no end mark for it.

| Field | Type | Required | Description |
|---|---|---|---|
| `session` | `integer` | yes | The Session's id. |
| `host` | `string` | no | The Host's name; `nil` for a Quick Connect Session. |
| `command` | `string` | no | The command line as the shell showed it after its prompt; `nil` when it couldn't be read (the shell sent no `B` mark, or the line scrolled away or was reflowed by a resize before it ran). |
| `output` | `string` | yes | What it printed, each line ending in `\n`, as `terminal_output` sent it (its last line too, if it didn't end in a line feed). At most the last 16 KB. |
| `code` | `integer` | no | Its exit code; `nil` when the shell didn't say. |

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
