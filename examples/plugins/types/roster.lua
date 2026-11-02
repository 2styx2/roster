---@meta roster
-- roster's Plugin API, roster.api_version 4: LuaCATS annotations for lua-language-server.
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

--- A timer's id, from `roster.defer` or `roster.every`
---@alias roster.Timer integer

--- A notice's level
---@alias roster.Level "info"|"warn"|"error"

--- What choosing a row, an action, a finder item or a status segment runs
---@alias roster.Run string|fun(ctx: roster.HandlerContext): any

--- What a row's, a button's, a finder item's, a status segment's, a toolbar control's, a question's, a progress's or a `:check` section's function is called with
---@class roster.HandlerContext
---@field section? string The Sidebar section's id, for a row or a row's button.
---@field row? string The row's `id` (its place in the list, `"3"`, if it has none).
---@field action? integer Which button was pressed, 1 for the first: of the row's `actions`, the section's (no `row` then) or the float's.
---@field dropped? string For a section's or a row's `drop`: the Host dropped on it (since api 3).
---@field finder? string The finder's id, for a finder item.
---@field item? string The item's `id` (its place, if it has none).
---@field segment? string The status segment's id.
---@field health? string The `:check` section's id, for its `check`.
---@field check? integer This `:check` run of the section, for its `check`: a check that returns `"later"` answers with `roster.health.answer``(e.check, lines)` (since api 3).
---@field toolbar? string The toolbar control's id.
---@field progress? string The progress's id, for its `cancel`.
---@field confirm? "yes"|"no" For a question's `run` (`"yes"`) or `cancel` (`"no"`, also when another Plugin's question replaced it).
---@field session? integer The Session on screen; `nil` with none. Only with `inventory.read` or `terminal.read`.
---@field session_host? string The Host of the Session on screen; `nil` with none, for a Quick Connect Session, and without `inventory.read` or `terminal.read`. (A table's function gets the row's Host as `host`: `TableEvent`.)

--- `roster.commands.add`'s second argument
---@class roster.CommandSpec
---@field desc? string Its description, for `:help commands` and completion. The name if left out.
---@field run string|fun(args: roster.CommandArgs): any A function, called with what followed the command, or a command line to run instead.
---@field complete? fun(arg: string): string[] Since api 3: what Tab offers after the command's name. Called with what's typed after it (`"add esx"`) as the user types, it returns whole arguments that start with it (`{ "add esx-02 " }`; end one with a space when another word follows). At most 200; the app shows the last answer until the next comes. It isn't a call the user started: no clipboard, questions or command lines in it.

--- What a command's function is called with
---@class roster.CommandArgs
---@field args string Everything after the command's name, trimmed (`""` for none).
---@field words string[] `args` split at spaces (`{}` for none).
---@field session? integer The Session on screen; `nil` with none. Only with `inventory.read` or `terminal.read` (since api 3).
---@field session_host? string The Host of the Session on screen; `nil` with none, for a Quick Connect Session, and without `inventory.read` or `terminal.read` (since api 3).
---@field host? string The Host under the Sidebar's cursor (else the one on screen), as roster's own commands take it; `nil` with none, and without `inventory.read` (since api 3).
---@field section? string When the Sidebar's cursor is on a row of one of your own sections: that section's id (since api 3).
---@field row? string And that row's `id`, or `nil` on the section's heading (since api 3).

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
---@field actions? roster.RowAction[] Buttons on its heading (`"Dismiss all"`), at most 4: shown while the heading is selected.
---@field count? number The count on its heading; the number of rows if left out (since api 3).
---@field drop? roster.Run Takes a Host dragged onto the heading or the empty section: it runs with `{ section, dropped = HOST }` (since api 3).

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
---@field icon? roster.RowGlyph A glyph before the label, as the app's Folders and groups have (since api 3).
---@field fold? boolean It folds the rows after it with a higher `level`, as a Folder or group does: `h`/`l`, its chevron and a click fold it, the app keeps what's folded, and its id for `:fold` is `SECTION:ID` (since api 3).
---@field kind? "host" With `host`: drawn as the Inventory draws that Host (its state, address, Details and Review buttons, then the row's own `actions`); `label` and `note` are used only while the Host isn't in the Inventory (since api 3).
---@field drop? roster.Run Takes a Host dragged onto the row: it runs with `{ section, row, dropped = HOST }` (since api 3). A row with a `host` can always be dragged.
---@field drag_out? roster.Run Runs when the row is dragged out of the section onto another part of the Sidebar, as a Host dragged out of a Folder leaves it (since api 3).

--- What else a notice has (`roster.notify`, since api 3)
---@class roster.NoticeOptions
---@field actions? roster.NoticeAction[] Buttons under its text, at most 2.
---@field quiet? boolean An info notice's: whether it follows `ui.messages` (since api 4). Left out, it's quiet unless it has buttons; a warning or an error always shows.

--- How a line on the message line is said (`roster.echo`, since api 4)
---@class roster.EchoOptions
---@field quiet? boolean A routine confirmation (`true`): shown only with `ui.messages = "all"`, heard by a screen reader and kept by `:messages` either way. Left out or `false`, it shows.

--- Where a view opens (`roster.views.open`, since api 4)
---@class roster.ViewOpenOptions
---@field select? string The id of the node (a graph) or row (a table) to open at.

--- A button on a notice
---@class roster.NoticeAction
---@field label string What it says (`"Show the plan"`).
---@field run string The command line a click runs, as `roster.cmd` would (`"view mesh-plan"`); then the notice goes.

--- A button on a row
---@class roster.RowAction
---@field label string What it does, for its tooltip and screen readers (`"Unpin esx-02"`).
---@field icon? roster.RowIcon Its icon; `info` if left out.
---@field run roster.Run What pressing it runs.

--- A button on a view's or a Host-details section's heading
---@class roster.HeadAction
---@field label string What it does, for its tooltip and screen readers (`"Plan"`).
---@field icon? roster.RowIcon Its icon; `info` if left out.
---@field run roster.Run What pressing it runs.
---@field key? string One character (`"P"`) that runs it: not one a table or graph uses itself (`h j k l H J K L g G n N o O t f m s S / ? q + - = 0`), nor one of the view's table or graph actions' keys, nor another button's (since api 4).

--- A row action's icon
---@alias roster.RowIcon "close"|"edit"|"add"|"addGroup"|"review"|"unreview"|"info"|"copy"|"plan"|"apply"|"cut"|"map"

--- A Sidebar row's glyph (since api 3)
---@alias roster.RowGlyph "folder"|"group"

--- A status bar segment (`roster.status.set`)
---@class roster.StatusSegment
---@field text string Its text, at most 80 characters.
---@field title? string Its tooltip.
---@field run? roster.Run What clicking it runs.

--- A finder (`roster.finders.set`)
---@class roster.Finder
---@field title? string Its title (the `:finder` command's label and the dialog's name); the id if left out.
---@field prompt? string What it shows before the query (`Folders ›`), at most 64 characters; its title if left out (since api 3).
---@field items? roster.FinderItem[]|fun(): roster.FinderItem[] What it finds in, at most 2,000; or a function that returns them, run in the Plugin each time the finder opens (not a call the user started, whoever opened it; choosing an item is). Until it first answers the finder says it's loading; after that it shows the last answer while it asks again.
---@field section? string Instead of `items`: one of your own Sidebar sections, whose rows it finds in (with their paths, unfolded), as roster's own `inventory` finder does (since api 3).

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
---@field checks? roster.HealthCheck[] Its lines, as they are now. Left out with `check`.
---@field check? fun(ctx: roster.HandlerContext): roster.HealthCheck[]|"later" Called on each `:check` (since api 3): returns the section's lines, or `"later"` and answers with `roster.health.answer` within 30 seconds, from a `roster.serve.request`'s `done` say. Wins over `checks`.

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
---@field actions? roster.FloatAction[] Buttons at its foot (at most 4).
---@field links? roster.Link[] Web pages to open in the browser (at most 4).

--- A button in a floating window
---@class roster.FloatAction
---@field label string What it does (`"Go to the line"`).
---@field key? string One character that runs it while the window has focus (not `q`, which closes it).
---@field run roster.Run What pressing it runs.

--- A web page a floating window links to
---@class roster.Link
---@field label string Its text (`"Runbook"`).
---@field url string An `https://` or `http://` address; anything else is refused.

--- A question the user answers (`roster.confirm`)
---@class roster.Confirm
---@field title string The question (`"Cut esx-02 from the Mesh?"`).
---@field text? string What will happen, in the app's voice; a blank line starts a paragraph.
---@field facts? roster.Fact[] Label and value pairs: exactly what will be done to what.
---@field action? string The confirming button's word (`"Cut"`); `"Confirm"` if left out.
---@field danger? boolean The stronger form, for what can't easily be undone: the button in the danger colour, the keys starting on Cancel.
---@field typed? string With `danger`: a word the user types before the button works (a Host's name), at most 100 characters.
---@field run fun(e: table): any Called when the user confirms.
---@field cancel? fun(e: table): any Called when they don't (`Esc` or Cancel), or another Plugin's question takes its place.

--- How far something long has got (`roster.progress.set`)
---@class roster.Progress
---@field title string What's going on (`"Scanning 10.0.0.0/24"`), at most 80 characters.
---@field text? string More, for its tooltip (`"12 Hosts found"`).
---@field done? number How much is done, with `total`.
---@field total? number How much there is; with `done`, shown as a share. Without both, it only shows it's going.
---@field cancel? roster.Run What stopping it runs: the button and `:cancel ID` call it once.

--- A control in the toolbar (`roster.toolbar.set`)
---@class roster.ToolbarControl
---@field label string What it does, for its tooltip and screen readers (`"Scan a network"`), at most 80 characters.
---@field text? string A word shown beside the icon (at most 20 characters); without an icon, the label is shown.
---@field icon? roster.ToolbarIcon Its icon.
---@field run roster.Run What pressing it runs.

--- A toolbar control's icon
---@alias roster.ToolbarIcon "find"|"add"|"details"|"help"|"map"

--- A side panel or a full view (`roster.views.set`)
---@class roster.View
---@field title? string Its heading; the id if left out.
---@field place? roster.ViewPlace Where it opens first: `"panel"` (the default) or `"full"`. The user can move it to the other and widen or narrow it (`␣ z`, `␣ <`, `␣ >`); their choice, and init.lua's `views.ID`, win over it.
---@field actions? roster.HeadAction[] Buttons on its heading, at most 4, for what the whole view does (`Plan`, `Apply`): each runs with `{ view }` (since api 3), and its `key` runs it from anywhere in the view (since api 4).
---@field text? string A few lines above the rest, in the app's voice; a blank line starts a paragraph.
---@field facts? roster.Fact[] Label and value pairs, as a Host's details show them.
---@field table? roster.Table A table of rows.
---@field graph? roster.Graph A graph of nodes and edges, in place of a table.

--- Where a view goes
---@alias roster.ViewPlace "panel"|"full"

--- What `roster.views.update` changes
---@class roster.ViewUpdate
---@field title? string A new heading.
---@field text? string New text; `""` takes it away.
---@field facts? roster.Fact[] New facts, all of them.
---@field rows? roster.TableRow[] Rows to add or replace, by `id` (at most 2,000 at once).
---@field remove? string[] The ids of rows to take away; in a graph, of nodes (their edges go too) and clusters (their nodes stay, loose).
---@field clear? boolean `true` takes every row of the table away first, in one go (a new scan); `rows` then fill it again (since api 3).
---@field nodes? roster.GraphNode[] A graph's nodes to add or replace, by `id`.
---@field edges? roster.GraphEdge[] A graph's edges to add or replace, by `id`.
---@field clusters? roster.GraphCluster[] A graph's clusters to add or replace, by `id`.
---@field remove_edges? string[] The ids of a graph's edges to take away.
---@field filter? roster.GraphFilter A graph's new filter, in place of the one it has and the user's (`{}` shows everything).
---@field columns? roster.Column[] New columns, all of them; the rows keep their cells.
---@field sort? string Sort by this column now (the user's sort gives way).
---@field desc? boolean With `sort`: highest first.
---@field actions? roster.TableAction[] New actions, all of them: their functions replace the old ones' (`open` stays).

--- A section of a Host's details (`roster.details.set`)
---@class roster.DetailsSection
---@field title? string Its heading; the id if left out.
---@field order? number Where it goes among the Plugins' sections, lowest first; 500 if left out.
---@field actions? roster.HeadAction[] Buttons on its heading, at most 4, for what the section does about this Host (`Cut`): each runs with `{ section, host }` (since api 3), and its `key` runs it from anywhere in the section (since api 4).
---@field text? string A few lines, in the app's voice.
---@field facts? roster.Fact[] Label and value pairs.
---@field table? roster.Table A table of rows.

--- A label and its value
---@class roster.Fact
---@field label string What it is (`reach`).
---@field value string Its value (`can reach 7 Hosts`).
---@field data? boolean `true` for something you could paste into a shell (an address, a name), set in the data font.

--- A table: columns, rows as plain data, and what a row can do
---@class roster.Table
---@field columns roster.Column[] Its columns, left to right (1 to 20).
---@field rows? roster.TableRow[] Its rows (at most 2,000 here; `roster.views.update` adds more, up to 10,000).
---@field sort? string The column it's sorted by at first; as given if left out.
---@field desc? boolean Sorted highest first.
---@field empty? string What it says with no rows.
---@field open? roster.TableRun What `Enter` (or a double click) on a row runs. Without it, a row with a `host` opens that Host; others do nothing.
---@field actions? roster.TableAction[] What can be done to the selected row (at most 8).

--- A table's column
---@class roster.Column
---@field id string The key of its value in each row's `cells`.
---@field label string Its heading.
---@field kind? roster.ColumnKind How its values read and sort; `"text"` if left out.
---@field width? number How wide, in characters; it shares the room with the others if left out.

--- How a column's values read and sort
---@alias roster.ColumnKind "text"|"data"|"number"

--- A row of a table: plain data
---@class roster.TableRow
---@field id string Unique in the table (at most 100 characters): updates and the selection follow it.
---@field cells? table<string, string|number> Its value in each column, by the column's `id`; a column it lacks is blank and sorts last.
---@field host? string The Host it's about: `Enter` opens it when the table has no `open`, and actions get it as `e.host`.
---@field tone? roster.RowTone Drawn quieter (`"muted"`: ended, down) or marked (`"warn"`, `"error"`).

--- How a table row is marked
---@alias roster.RowTone "muted"|"warn"|"error"

--- Something a table's selected row can do
---@class roster.TableAction
---@field label string What it does (`"Keep"`), on its button and in the key hints.
---@field key? string One character that runs it on the selected row, not one the table uses itself.
---@field icon? roster.RowIcon Its button's icon; the label alone if left out.
---@field when? table<string, string|number|(string|number)[]> Only on the rows whose cells match: `{ state = "up" }`, or a list of values (`{ state = { "up", "slow" } }`). A cell needn't be a column, so a row can carry what decides it without showing it.
---@field run roster.TableRun What it runs.

--- What a table's row or action runs
---@alias roster.TableRun string|fun(e: roster.TableEvent): any

--- What a table's function gets
---@class roster.TableEvent
---@field row string The row's `id`.
---@field host? string The row's `host`, or the Host whose details the section is in.
---@field view? string The view's id, in a view.
---@field section? string The section's id, in a Host's details.

--- What `roster.http.request` sends
---@class roster.HttpRequest
---@field url string Where: on a site the Plugin was granted (`https://api.example.com/v1/alerts`).
---@field method? string `GET` (the default), `HEAD`, `POST`, `PUT`, `PATCH` or `DELETE`, in any case.
---@field headers? table<string, string> Headers to send, such as a token of the Plugin's own (`Authorization`). Not the ones that steer the connection (`Host`, `Content-Length`, `Proxy-…`). roster adds only `User-Agent: roster/VERSION` and what HTTP needs.
---@field body? string The body, at most 256 KB; bytes as they are.
---@field timeout? number Seconds to wait for the whole answer; at most 30 (the default). 10 seconds to connect.

--- What a site answered
---@class roster.HttpResponse
---@field status integer The status code (`200`, `404`).
---@field url string Where it ended, after redirects.
---@field headers table<string, string> By lower-case name; a header sent twice has its values joined with `, `.
---@field body string The body, at most 1 MB, as bytes: not decompressed, not decoded.

--- A graph: nodes, edges and clusters as plain data, and what a node can do
---@class roster.Graph
---@field nodes? roster.GraphNode[] Its nodes, in order: a cluster's first node is at its centre (at most 5,000).
---@field edges? roster.GraphEdge[] Its edges (at most 10,000).
---@field clusters? roster.GraphCluster[] Its clusters, in order (at most 500).
---@field reach? roster.GraphReach How far a node's reach goes, for the counts and what selecting it lights up: `"all"` (the default) every hop, `"direct"` one.
---@field filter? roster.GraphFilter What it shows to begin with; the rest is hidden until the user changes it (`f`).
---@field open? roster.NodeRun What `Enter` (or a double click) on a node runs. Without it, a node with a `host` opens that Host.
---@field actions? roster.NodeAction[] What can be done to the selected node (at most 8).

--- A node of a graph: plain data
---@class roster.GraphNode
---@field id string Unique among the graph's nodes and clusters (at most 100 characters): edges, updates and the selection follow it.
---@field label? string Its name on the map; the id if left out.
---@field kind? string What sort of thing it is (`"esxi"`): searched, and a column in the list.
---@field shape? roster.NodeShape How it's drawn; `"dot"` if left out.
---@field state? roster.NodeState Live (in the accent) or down.
---@field mark? roster.NodeMark A small warn or error mark beside it.
---@field note? string A few words (`"out of date"`), beside it when selected and in the list.
---@field cluster? string The id of the cluster it's in.
---@field host? string The Host it is: `Enter` opens it when the graph has no `open`, and actions get it as `e.host`.
---@field detail? string A second line in the data font (an address), when selected and in the list.

--- How a node is drawn
---@alias roster.NodeShape "dot"|"ring"|"dashed"|"hollow"|"square"

--- What a node is doing
---@alias roster.NodeState "live"|"down"

--- A node's mark
---@alias roster.NodeMark "warn"|"error"

--- An edge of a graph: plain data
---@class roster.GraphEdge
---@field id? string Unique among its edges; `"FROM>TO"` if left out.
---@field from string The id of the node or cluster it starts at.
---@field to string The id of the node or cluster it goes to.
---@field dir? roster.EdgeDir `"one"` (the default) is one way, with an arrow at `to`; `"both"` is each way.
---@field style? roster.EdgeStyle Its line; `"solid"` if left out.
---@field tone? roster.EdgeTone Live (in the accent), muted, or marked warn or error.
---@field cut? boolean `true` draws it broken in the middle by a cross: about to be cut.
---@field label? string A few words about it, in the list.

--- Which way an edge goes
---@alias roster.EdgeDir "one"|"both"

--- An edge's line
---@alias roster.EdgeStyle "solid"|"dashed"|"dotted"

--- How an edge is marked
---@alias roster.EdgeTone "live"|"muted"|"warn"|"error"

--- A cluster of a graph's nodes
---@class roster.GraphCluster
---@field id string Unique among the graph's nodes and clusters: nodes name it as their `cluster`.
---@field title? string Its title; the id if left out.
---@field mesh? boolean `true`: every node in it reaches every other, both ways, without an edge for each pair (the Mesh's `mesh: true`).
---@field collapsed? boolean How it starts: collapsed (`true`) or open (`false`). Left out, it collapses when the graph has more than 300 nodes. The user's own choice is kept and wins.

--- How far a graph's reach goes
---@alias roster.GraphReach "all"|"direct"

--- What a graph shows: the rest is hidden
---@class roster.GraphFilter
---@field clusters? string[] Cluster ids: only their nodes show (at most 500).
---@field kinds? string[] Kinds (a node's `kind`): only nodes of these show (at most 500).
---@field states? roster.FilterState[] A node's `state` or `mark`: only nodes live, down, or marked warn or error show.

--- A state a graph's filter keeps
---@alias roster.FilterState "live"|"down"|"warn"|"error"

--- Something a graph's selected node can do
---@class roster.NodeAction
---@field label string What it does (`"Check"`), in the key hints.
---@field key? string One character that runs it on the selected node, not one the graph uses itself.
---@field icon? roster.RowIcon Its icon in the node list's buttons.
---@field when? table<string, string|number|(string|number)[]> Only on the nodes whose fields match, as a table action's `when` (since api 3): `{ state = "live" }`, or a list of values (`{ kind = { "esxi", "linux" } }`). It names a node's own fields (`id`, `label`, `kind`, `shape`, `state`, `mark`, `note`, `cluster`, `host`, `detail`); a field the node leaves out matches nothing. Elsewhere its key does nothing and its hint isn't shown.
---@field run roster.NodeRun What it runs.

--- What a graph's node or action runs
---@alias roster.NodeRun string|fun(e: roster.NodeEvent): any

--- What a graph's function gets
---@class roster.NodeEvent
---@field node string The node's `id`.
---@field host? string The node's `host`.
---@field view string The view's id.
---@field session? integer The Session on screen, as in a `HandlerContext`: only with `inventory.read` or `terminal.read`.
---@field session_host? string The Host of the Session on screen, as in a `HandlerContext`.

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

--- `host.check_job`'s result: a Host's check, and how it came out
---@class roster.CheckJob
---@field kind "check" Always `"check"`.
---@field job string Its id, `"check-N"`.
---@field action "check" Always `"check"`.
---@field state string `"running"`, `"stopping"`, or how it ended: `"done"`, `"stopped"`, `"failed"`.
---@field done integer Steps started.
---@field total integer Steps in all (8).
---@field at? string The step under way (`"dns"`, `"auth"`, ...).
---@field host string The Host it checks.
---@field result? roster.HostCheck Once `done` or `stopped`: `host.check`'s result. `ok` is false for a stopped check, its later steps `skipped`.
---@field error? roster.ServeError Once `failed`: why.

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
---@field diff string git's diff of `roster.yml` against the last commit; `""` for none. A `cmd:` reference in it reaches a Plugin cut to `cmd:` (the rest of its line), an `env:` one to `env:`.
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

--- `mesh.plan`'s and `mesh.apply`'s result
---@class roster.MeshResult
---@field applied boolean `false` for a plan (nothing changed), `true` for an apply.
---@field links roster.MeshLink[] Every Link, with how it went.
---@field hosts roster.MeshHost[] Every Host visited.
---@field excluded table<string, string> Hosts kept out, and why (`not reviewed (reviewed: false)`, `mesh: false`).
---@field reach table<string, integer> How many Hosts each source reaches, counting the Links that work.
---@field pending table<string, string> Hosts that didn't answer, and why.
---@field already boolean Nothing to change and nothing pending: already in the Mesh.
---@field warnings string[] Words to show (a `ROSTER.md` that isn't roster's, a Host that left `roster.yml`).
---@field cut_pending table<string, string[]> Earlier cuts not finished yet: a Host, and the peers still to do.
---@field link_count? integer Brief: how many Links there are in all.
---@field link_statuses? table<string, integer> Brief: how many Links have each status.
---@field reached? table<string, integer> Brief: how many Hosts reach each Host.
---@field links_more? integer Brief: the Links worth a look that `links` leaves out (it keeps 1,000).

--- A Link of the Mesh: a source reaching a peer
---@class roster.MeshLink
---@field from string The source Host.
---@field to string The peer it reaches.
---@field kind "key"|"password" `password` when the peer asks for one.
---@field status? "ok"|"untested"|"unreachable"|"no-host-key"|"no-via"|"pending"|"skipped" How it went; `mesh.status` gives none (it never connects), except `no-via` with `brief`. `unreachable`, `no-host-key` and `no-via` are left out.
---@field why? string The status in words.
---@field via? string The Host the source goes through to the peer (a Link's `via:`).
---@field skip? string Why roster didn't write it: `"password-source"`.

--- A Host a Mesh run visited
---@class roster.MeshHost
---@field host string Its name.
---@field status "same"|"would-change"|"changed"|"pending" `would-change` from a plan, `changed` from an apply, `pending` when it didn't answer.
---@field changes string[] Short phrases: `make key`, `write ssh config`, `add key from orion-2`, …
---@field error? string Why it's pending.
---@field more? integer Brief: the changes left out (it keeps 10).

--- A Mesh run started with `background = true`
---@class roster.MeshStarted
---@field job integer The job's number, for `mesh.job` and `mesh.stop`.
---@field action "plan"|"apply"|"cut" What it does.
---@field total integer How many Hosts it visits.
---@field host? string A cut's Host.

--- `mesh.cut`'s result
---@class roster.MeshCut
---@field host string The Host cut from the Mesh.
---@field confirmed string[] The peers whose keys it took off, and that took its off.
---@field pending table<string, string> The peers that didn't answer, and why: the next cut finishes them.
---@field warnings? string[] What roster left on the cut Host's own side, one sentence each: an earlier `mesh_dir:` that still holds a Mesh key, which roster never removes (serve API 24; absent before).
---@field change roster.MeshCutChange The `mesh: false` written for it as a Pending change.

--- The `mesh: false` a `mesh.cut` writes into `roster.yml`
---@class roster.MeshCutChange
---@field written boolean Whether it was written now (`false` when it already was, or couldn't be).
---@field backup? string The copy of `roster.yml` from before; `nil` when it isn't in a git repo.
---@field note? string Why nothing was written, or that it went straight to a file outside git.
---@field error? string Why it couldn't be written (the cut still happened).
---@field fix? string What to do then, in a sentence.

--- `mesh.status`'s result: the Mesh as `roster.yml` asks for it
---@class roster.MeshStatus
---@field links roster.MeshLink[] The Links, without a `status`.
---@field excluded table<string, string> Hosts kept out, and why.
---@field reach table<string, integer> How many Hosts each source reaches.
---@field members string[] The Hosts roster visits.
---@field pending table<string, string> Hosts the last run didn't finish, and why.
---@field cut_pending table<string, string[]> Earlier cuts not finished yet.
---@field out_of_date boolean `roster.yml` changed the Mesh since the last complete apply on this Box.
---@field meshed? table<string, string[]> Grouped: each meshed group's Hosts that reach each other both ways.
---@field link_count? integer Brief: how many Links there are in all.
---@field link_statuses? table<string, integer> Brief: how many Links have each status (`asked` for untested ones).
---@field reached? table<string, integer> Brief: how many Hosts reach each Host.
---@field links_more? integer Brief: the Links worth a look that `links` leaves out.

--- `mesh.job`'s result: how far a Mesh run has got
---@class roster.MeshJob
---@field job integer Its number.
---@field action "plan"|"apply"|"cut" What it does.
---@field host? string A cut's Host.
---@field state "running"|"done"|"failed" Where it is.
---@field done integer Hosts done so far.
---@field total integer Hosts in all.
---@field at? string The Host it's on.
---@field stopped boolean `mesh.stop` asked it to stop; the Hosts it hadn't got to are pending.
---@field result? roster.MeshResult|roster.MeshCut Once `done`: what the method itself returns.
---@field error? roster.ServeError Once `failed`: why.

--- An error roster serve answered with
---@class roster.ServeError
---@field code integer Its code, in serve-api.md's tables.
---@field message string What went wrong.
---@field data? table More about it, as its row says.

--- `mesh.stop`'s result
---@class roster.MeshStop
---@field job integer The job.
---@field stopping boolean `false` when it isn't running (over already, or not the latest).

--- `discover.plan`'s result: what a scan would visit
---@class roster.DiscoverPlan
---@field targets string[] The targets as written back, without one another covers.
---@field addresses integer How many addresses they hold.
---@field ports integer How many ports it tries on each.
---@field scanner "nmap"|"built-in" nmap, or roster's own TCP connect scan without it.
---@field limit integer The most addresses without `force` (4,096).
---@field max integer The most with `force` (65,536).

--- `discover.status`'s and `discover.start`'s result: how far a scan has got
---@class roster.DiscoverStatus
---@field scan string Its id (`"scan-N"`).
---@field state "running"|"stopping"|"done"|"stopped"|"failed" Where it is.
---@field targets string[] What it scans.
---@field scanner "nmap"|"built-in" What it scans with.
---@field done integer Addresses visited so far.
---@field total integer Addresses in all.
---@field count integer How many it found in all: the next `since`.
---@field quiet integer How many answered with none of the ports open (nmap only).
---@field found roster.DiscoverFound[] What it found, after the first `since`.
---@field error? string Why it `failed`.

--- Something a scan found at an address
---@class roster.DiscoverFound
---@field address string Its address.
---@field name? string The name it would be added as; `nil` when `known` names the Host already there.
---@field type string The guessed kind.
---@field hostname string Its name in DNS; `""` for none.
---@field title string A web page's title; `""` for none.
---@field web? string Its web address, when it serves one.
---@field known? string The Inventory's Host at that address.
---@field added? string The name `discover.add` gave it.
---@field vendor string The network card's maker (nmap); `""` when unknown.
---@field os string The guessed operating system (nmap); `""` when unknown.
---@field mac string Its MAC address (nmap, on the same network); `""` when unknown.
---@field ports roster.DiscoverPort[] Its open ports.

--- An open port a scan found
---@class roster.DiscoverPort
---@field port integer Its number.
---@field name string The service's name (`ssh`).
---@field product string What answered (`OpenSSH 9.6`); `""` when unknown.
---@field title string A web page's title; `""` for none.

--- `discover.stop`'s result
---@class roster.DiscoverStop
---@field scan string The scan.
---@field stopping boolean `false` when it had ended already; `discover.status` says `stopped` once it has.

--- `discover.add`'s result
---@class roster.DiscoverAdd
---@field group string The new group they went in.
---@field added roster.DiscoverAdded[] Each Host added, `reviewed: false`, as a Pending change.
---@field backup? string The copy of `roster.yml` from before.

--- A Host `discover.add` added
---@class roster.DiscoverAdded
---@field address string Its address.
---@field name string Its name in `roster.yml`.

--- An event a Plugin can listen for
---@alias roster.EventName "lock"|"unlock"|"host_selected"|"session_open"|"session_exit"|"inventory_changed"|"terminal_output"|"command_done"|"job_progress"

--- The payload of `lock`, `unlock` and `inventory_changed`: an empty table
---@class roster.EmptyEvent

--- `host_selected`'s payload
---@class roster.HostSelectedEvent
---@field host string The Host whose Session is on screen now.

--- An open Session, as `roster.sessions.list` gives it
---@class roster.Session
---@field session integer The Session's id, as its events name it: `roster.terminal.send` and `roster.sessions.show` take it.
---@field host? string The Host's name; `nil` for a Quick Connect Session (`:quick`), which isn't on a Host.

--- `session_open`'s payload
---@class roster.SessionOpenEvent
---@field session integer The Session's id: `roster.terminal.send` takes it.
---@field host? string The Host's name; `nil` for a Quick Connect Session (`:quick`), which isn't on a Host: don't badge it or make a row go to it.

--- `session_exit`'s payload
---@class roster.SessionExitEvent
---@field session integer The Session's id.
---@field host? string The Host's name; `nil` for a Quick Connect Session. A tab closed while it ran has it too (since api 3).
---@field code? integer ssh's exit code; `nil` when it failed to start or its tab was closed.

--- `job_progress`'s payload: serve's `job.progress` notification
---@class roster.JobProgressEvent
---@field kind string `"mesh"`, `"discover"` or `"check"`.
---@field job integer|string Its id within its kind, as that kind's methods name it: the Mesh's job number (`mesh.job { job = N }`), the scan's `"scan-N"` (`discover.status { scan = ... }`), the check's `"check-N"` (`host.check_job { job = ... }`).
---@field action string `"plan"`, `"apply"` or `"cut"` for the Mesh; `"scan"` for Discover; `"check"` for a check.
---@field state string `"running"`, `"stopping"`, or how it ended: `"done"`, `"stopped"`, `"failed"`.
---@field done integer How far it has got: Hosts visited, addresses scanned, a check's steps started (of 8).
---@field total integer Of how many.
---@field at? string The Host it's on, when it's on one; a check's step (`"dns"`, `"auth"`, ...).
---@field host? string A cut's Host; the Host a check checks.
---@field error? table How it failed: `{ code, message, data? }`, as serve's error.

--- `terminal_output`'s payload
---@class roster.TerminalOutputEvent
---@field session integer The Session's id.
---@field host? string The Host's name; `nil` for a Quick Connect Session.
---@field text string The lines it finished since the last one, each ending in `\n`, as the terminal shows them: no colours or escape sequences, a line the program rewrote (a progress bar) only as it ended up, a long line that wrapped as one. A line is sent when the Session moves past it, so the one with the cursor (a prompt) waits. A line drawn again with the same text in the same place isn't sent again, so the screen a resized Session prints again (ConPTY does on Windows) doesn't repeat what you had. What a full-screen program (`vim`, `top`, `less`) draws isn't sent. At most the last 16 KB.
---@field kind? string What the Session's shell's OSC 133 marks say these lines are (since api 4): `"prompt"` (a few lines after its prompt starts), `"input"` (the line typed at the prompt: the shell's echo of your command), `"output"` (what a command printed), or `nil` (no marks, or nothing they say). All the lines in `text` are of one kind; a batch of several kinds comes as several events, in order. A hint, not a guarantee: the marks come from the Host and anything it prints can forge them, and an `"output"` line may be an `ssh` or nested shell echoing what you type. Every line is sent whatever its kind.

--- `command_done`'s payload
---@class roster.CommandDoneEvent
---@field session integer The Session's id.
---@field host? string The Host's name; `nil` for a Quick Connect Session.
---@field command? string The command line as the shell showed it after its prompt; `nil` when it couldn't be read (the shell sent no `B` mark, or the line scrolled away or was reflowed by a resize before it ran).
---@field output string What it printed, each line ending in `\n`, as `terminal_output` sent it (its last line too, if it didn't end in a line feed). At most the last 16 KB.
---@field code? integer Its exit code; `nil` when the shell didn't say.

---@class roster.module
---@field api_version integer The version of the `roster` module this app has
---@field os roster.Os The OS the app runs on
---@field plugin roster.Plugin The Plugin itself: its name, version, what it was granted and its settings
roster = {}

--- Shows a notice, naming the Plugin.
--- Permission: none. Since: api 2.
---@param text string What to say. It's shown after the Plugin's name (`pinned: …`).
---@param level? roster.Level `"info"` (the default), `"warn"` or `"error"`.
---@param opts? roster.NoticeOptions Buttons on the notice (since api 3): `{ actions = { { label = "Show the plan", run = "view mesh-plan" } } }`; whether an info notice is quiet (since api 4): `{ quiet = false }`.
function roster.notify(text, level, opts) end

--- Runs a function on an event.
--- Permission: none. Since: api 2.
---@param event roster.EventName The event's name: `lock`, `unlock`, `host_selected`, `session_open`, `session_exit`, `inventory_changed`, `terminal_output`, `command_done` or `job_progress`.
---@param listener fun(e: table) Runs with the event's payload (see Events) each time it happens. Its return value is ignored.
---@overload fun(event: "lock", listener: fun(e: roster.EmptyEvent))
---@overload fun(event: "unlock", listener: fun(e: roster.EmptyEvent))
---@overload fun(event: "host_selected", listener: fun(e: roster.HostSelectedEvent))
---@overload fun(event: "session_open", listener: fun(e: roster.SessionOpenEvent))
---@overload fun(event: "session_exit", listener: fun(e: roster.SessionExitEvent))
---@overload fun(event: "inventory_changed", listener: fun(e: roster.EmptyEvent))
---@overload fun(event: "terminal_output", listener: fun(e: roster.TerminalOutputEvent))
---@overload fun(event: "command_done", listener: fun(e: roster.CommandDoneEvent))
---@overload fun(event: "job_progress", listener: fun(e: roster.JobProgressEvent))
function roster.on(event, listener) end

--- Asks the user to confirm, then runs a function.
--- Permission: none. Since: api 3.
---@param question roster.Confirm What to ask, the button that confirms, and what runs when the user does.
function roster.confirm(question) end

--- Runs a command line.
--- Permission: none. Since: api 3.
---@param line string A command line, as typed after `:` (`"finder alerts"`).
function roster.cmd(line) end

--- Answers on the message line, as roster's own commands do.
--- Permission: none. Since: api 3.
---@param text string What to say, on one line.
---@param opts? roster.EchoOptions `{ quiet = true }` for a routine confirmation (since api 4).
function roster.echo(text, opts) end

--- Opens the command line with text typed in.
--- Permission: none. Since: api 3.
---@param text string The start of a line for one of your commands (`"folder new "`); the user finishes it.
function roster.cmdline(text) end

--- Whether the Plugin was granted a permission.
--- Permission: none. Since: api 3.
---@param permission string A permission's name: `"terminal.read"`, `"serve:mesh.status"`.
---@return boolean # `true` when it's granted (and not revoked in `:plugins`).
function roster.has(permission) end

--- Runs a function once, later.
--- Permission: none. Since: api 3.
---@param ms number How long to wait, in milliseconds: at least 50 (less waits 50), at most 2,147,483,647.
---@param fn fun() What to run then, in the Plugin, with the budget of a call.
---@return roster.Timer # Its id, for `roster.cancel`.
function roster.defer(ms, fn) end

--- Runs a function again and again, until it's cancelled.
--- Permission: none. Since: api 3.
---@param ms number How long between runs, in milliseconds: at least 1,000.
---@param fn fun() What to run each time, in the Plugin.
---@return roster.Timer # Its id, for `roster.cancel`.
function roster.every(ms, fn) end

--- Cancels a timer.
--- Permission: none. Since: api 3.
---@param timer roster.Timer What `roster.defer` or `roster.every` returned.
function roster.cancel(timer) end

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
---@param action string|false A command line: one of the Plugin's commands or one of the app's that `roster.cmd` may run (`"finder alerts"`). `false` is deprecated: it takes the Plugin's binding off, as `roster.keymap.del` does.
function roster.keymap.set(context, keys, action) end

--- Takes one of the Plugin's key bindings off.
--- Permission: none. Since: api 3.
---@param context roster.KeyContext Where it was bound.
---@param keys string The keys, as `set` took them.
function roster.keymap.del(context, keys) end

--- Themes. 
roster.themes = {}

--- Adds a Theme.
--- Permission: none. Since: api 2.
---@param id string The Theme's id, as `:theme ID` takes it.
---@param theme roster.Theme As `init.lua`'s `themes` takes one.
function roster.themes.define(id, theme) end

--- Removes one of the Plugin's Themes.
--- Permission: none. Since: api 3.
---@param id string One of the Plugin's Themes.
function roster.themes.remove(id) end

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
---@param section roster.HealthSection Its title, and its checks or the function that makes them.
function roster.health.set(id, section) end

--- Answers a `:check` section's check that returned `"later"`.
--- Permission: none. Since: api 3.
---@param check integer The `check` field of what the section's `check` was called with.
---@param lines roster.HealthCheck[] The section's lines for that run.
function roster.health.answer(check, lines) end

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

--- Controls in the toolbar. A control in the title bar's toolbar (decision Q65), after roster's own by the window's buttons. It's shown unless `init.lua` picks the controls itself with `modes.<mode>.toolbar`: then it shows where that list names its id. It never takes focus from the terminal.
roster.toolbar = {}

--- Adds a control to the toolbar, or replaces it.
--- Permission: none. Since: api 3.
---@param id string The control's id: a name like `scan`, which `modes.<mode>.toolbar` can list.
---@param control roster.ToolbarControl Its label, icon or word, and what it runs.
function roster.toolbar.set(id, control) end

--- Removes a toolbar control.
--- Permission: none. Since: api 3.
---@param id string One of the Plugin's controls.
function roster.toolbar.remove(id) end

--- Progress of something long. What the Plugin is doing that takes a while (a scan, a long roster serve call), shown in the status bar: how far it has got, or only that it's going, and a way to stop it. `:cancel ID` (or the button) calls its `cancel` function. Setting it any time is fine, from an event too: it changes nothing but itself.
roster.progress = {}

--- Shows or updates the progress of something long.
--- Permission: none. Since: api 3.
---@param id string A name like `scan`: `:cancel scan` cancels it.
---@param progress roster.Progress What's going on, how far it has got, and how to stop it.
function roster.progress.set(id, progress) end

--- Takes a progress away: it's over.
--- Permission: none. Since: api 3.
---@param id string One of the Plugin's progresses.
function roster.progress.remove(id) end

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

--- Views: side panels and full views. A view is data the app draws in its own style: a title, text, facts and a table. `place` says where: `"panel"` beside the terminal (over it in Focus or a narrow window), or `"full"` over the whole window, as Topology is. `:view ID` opens one, and the `views` finder (`:finder views`) lists them all; bind a key to `view ID` with `roster.keymap.set`. `Esc` closes it and puts you back where you were. A table's rows are plain data, so `roster.views.update` changes some in place without sending the rest again. A view can hold a graph instead of a table: nodes, edges and clusters, also plain data, with a list of every node and edge one key away (`t`).
roster.views = {}

--- Adds a view, or replaces it.
--- Permission: none. Since: api 3.
---@param id string The view's id: a name like `discover`. `:view ID` opens it.
---@param view roster.View Where it goes, its title, text, facts, and a table or a graph.
function roster.views.set(id, view) end

--- Changes some of a view's rows or nodes in place, or its text or facts.
--- Permission: none. Since: api 3.
---@param id string One of the Plugin's views.
---@param changes roster.ViewUpdate What changes: rows to add or replace, rows to take away, and the text or facts.
function roster.views.update(id, changes) end

--- Opens a view.
--- Permission: none. Since: api 3.
---@param id string One of the Plugin's views.
---@param opts? roster.ViewOpenOptions Where it opens (since api 4): `{ select = "esx-02" }` selects that node of its graph or row of its table.
function roster.views.open(id, opts) end

--- Closes a view, if it's open.
--- Permission: none. Since: api 3.
---@param id string One of the Plugin's views.
function roster.views.close(id) end

--- Removes a view.
--- Permission: none. Since: api 3.
---@param id string One of the Plugin's views.
function roster.views.remove(id) end

--- Sections of a Host's details. Your own sections in a Host's details panel (`:info HOST`), after roster's: set per Host, like a badge.
roster.details = {}

--- Adds a section to a Host's details, or replaces it.
--- Permission: none. Since: api 3.
---@param id string The section's id: a name like `mesh`.
---@param host string The Host's name in the Inventory.
---@param section? roster.DetailsSection Its title, text, facts and table; `nil` takes this Host's away.
function roster.details.set(id, host, section) end

--- Removes a section from every Host's details.
--- Permission: none. Since: api 3.
---@param id string One of the Plugin's sections.
function roster.details.remove(id) end

--- The clipboard. 
roster.clipboard = {}

--- Puts text on the clipboard.
--- Permission: none. Since: api 2.
---@param text string What to put on the clipboard, at most 64 KB.
function roster.clipboard.copy(text) end

--- The Plugin's own files. Every Plugin has a data folder of its own, in the app's data folder (next to the State; never the config folder, never on the network), and `roster.storage` reads and writes files there by name (decision Q93). No permission: it's the Plugin's own, and nothing else is reachable through it. A name is a plain file name (letters, digits, `-`, `_` and `.`, not starting with `.`; at most 100 characters), never a path, so there's no way out of the folder; a link there (a symlink, or a junction on Windows) is never followed. A write replaces the whole file at once (a temporary file, then a rename), so a crash leaves the old file or the new one, never half of one. A file holds at most 1 MB, the folder 10 MB in at most 1,000 files. The folder goes when the Plugin is removed (`:plugins remove`, or `:packages clean` for a Package), and stays across reloads, updates and revoked permissions. The time the disk takes doesn't count against the Plugin's budget.
roster.storage = {}

--- Reads one of the Plugin's files.
--- Permission: none. Since: api 3.
---@param name string The file's name (`"folders.json"`).
---@return string? # What the file holds, or `nil` when there's no such file.
function roster.storage.read(name) end

--- Writes one of the Plugin's files, whole.
--- Permission: none. Since: api 3.
---@param name string The file's name.
---@param text string What it holds from now on, at most 1 MB (any bytes).
function roster.storage.write(name, text) end

--- The names of the Plugin's files.
--- Permission: none. Since: api 3.
---@return string[] # In name order; `{}` before the first write.
function roster.storage.list() end

--- Removes one of the Plugin's files.
--- Permission: none. Since: api 3.
---@param name string The file's name.
---@return boolean # `true` if it was there.
function roster.storage.remove(name) end

--- Reads one of the Plugin's files as JSON.
--- Permission: none. Since: api 3.
---@param name string The file's name.
---@return any # The value, or `nil` when there's no such file.
function roster.storage.read_json(name) end

--- Writes one of the Plugin's files as JSON, whole.
--- Permission: none. Since: api 3.
---@param name string The file's name.
---@param value any Plain data: tables, text, numbers and booleans (no functions).
function roster.storage.write_json(name, value) end

--- Hosts, and Pending changes to them. `nil` unless the Plugin was granted `inventory.read` or `inventory.write`; each function is there only with its own permission. The reads but `request` wait for `roster serve`; that time doesn't count against the Plugin's budget, nor toward it being given up on. One call (a load, an event, an action, an answer) reads the Inventory once: `hosts()` and `groups()` in it share one answer of serve's, until a call into serve that can change something (a write, `mesh.cut`, …) in the same call. `roster.inventory.request` doesn't wait: prefer it where the Plugin would otherwise hold up the user, and for a big Inventory.
roster.inventory = {}

--- Every Host, in `roster.yml` order.
--- Permission: inventory.read. Since: api 2.
---@return roster.Host[] # The Hosts, each with its Login references (a vault item's name, never a password; a `cmd:` or `env:` one cut to its kind).
function roster.inventory.hosts() end

--- One Host, by its exact name.
--- Permission: inventory.read. Since: api 2.
---@param name string The Host's exact name.
---@return roster.Host? # The Host, or `nil` when no Host has that name.
function roster.inventory.host(name) end

--- Every group, by name.
--- Permission: inventory.read. Since: api 3.
---@return table<string, roster.Group> # The groups, by name.
function roster.inventory.groups() end

--- Reads every Host and group without waiting: `done` gets them.
--- Permission: inventory.read. Since: api 4.
---@param done fun(list: roster.HostList?, err: string?) Runs once with the answer: every Host and group (`list.hosts`, `list.groups`), or `nil` and why (`roster.inventory.request: MESSAGE (code N)`). Its return value is ignored; an error in it counts like an action's.
function roster.inventory.request(done) end

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

--- Going to Sessions, and opening them. Every Plugin may go to a Session the user is shown (`show`), in a call the user started; `list` is there with `inventory.read` or `terminal.read` (the permissions that hear `session_open` and `session_exit`), and `open` only with `sessions.open`.
roster.sessions = {}

--- Goes to a Session, and to a line in its scrollback.
--- Permission: none. Since: api 3.
---@param session integer The Session's id, from an event (`e.session`).
---@param line? string Text of a line it printed: the app searches its scrollback from the bottom for the latest line with it, and shows it highlighted.
function roster.sessions.show(session, line) end

--- The Sessions open now, in the order they opened.
--- Permission: inventory.read or terminal.read. Since: api 4.
---@return roster.Session[] # Each open Session's id and Host, oldest open first.
function roster.sessions.list() end

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

--- roster serve's methods, by name. `nil` unless the Plugin was granted at least one `serve:<method>` permission. roster serve answers several requests at once, but a call can still wait: for its turn (2 calls into serve at a time for each Plugin, 4 for all of them) or behind the app's own write (a Publish: a minute or two). `roster.serve.request` doesn't wait: prefer it in anything the user starts. A job's progress comes as the `job_progress` event (serve API 20). `roster.serve.call` waits, and the user's next action in the Plugin waits behind it; the wait never counts against the Plugin.
roster.serve = {}

--- Calls a roster serve method the Plugin was granted.
--- Permission: serve:<method> (that method). Since: api 2.
---@param method string A roster serve method the Plugin was granted, by name (`serve:inventory.info` grants `inventory.info`).
---@param params? table The method's params; `{}` if left out. Data only: no functions.
---@return any # The method's result, as Lua tables (JSON `null` is `nil`).
function roster.serve.call(method, params) end

--- Asks roster serve without waiting: `done` gets the answer.
--- Permission: serve:<method> (that method). Since: api 3.
---@param method string A roster serve method the Plugin was granted, as `roster.serve.call`'s.
---@param params? table The method's params; `nil` or `{}` for none. Data only: no functions.
---@param done fun(result: any, err: string?) Runs once with the answer: the method's `result` (as `roster.serve.call` returns it), or `nil` and why (`roster.serve.request METHOD: MESSAGE (code N)`). Its return value is ignored; an error in it counts like an action's.
function roster.serve.request(method, params, done) end

--- HTTP requests to the sites the manifest lists. `nil` unless the Plugin was granted at least one `network:<site>` permission (Permissions). The request runs in roster's core, never in the app's window, and doesn't wait: the function you pass gets the answer later, as a call of its own with a call's budget. Only the sites granted are reached, redirects included; a name that resolves to an address on this computer or a private network is refused unless the manifest lists the address itself, or the name as a private site (`network:private:nas.lan`), which reaches only private addresses. A pinned site (`#sha256:…`) trusts only that certificate. No cookies or credentials of roster's go along, and no proxy but the user's `plugin_proxy`, through which a public name is still looked up here first and refused if it leads inside (only a name this computer can't look up at all is left to the proxy). At most 4 requests at once, a 256 KB body out, a 1 MB body back, 30 seconds each.
roster.http = {}

--- Sends an HTTP request to a site the Plugin was granted.
--- Permission: network:<site> (that site). Since: api 2.
---@param request roster.HttpRequest What to send: at least its `url`.
---@param done fun(response: roster.HttpResponse?, err: string?) Runs once with the answer: `response` for any status the site gave (a 404 too), or `nil` and why there was none (refused, unreachable, timed out, too big). Its return value is ignored; an error in it counts like an action's.
function roster.http.request(request, done) end

--- Fetches a URL from a site the Plugin was granted.
--- Permission: network:<site> (that site). Since: api 2.
---@param url string The URL, on a site the Plugin was granted.
---@param done fun(response: roster.HttpResponse?, err: string?) As `roster.http.request`'s.
function roster.http.get(url, done) end

return roster
