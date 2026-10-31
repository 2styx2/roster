//! The Plugin API, declared once (ticket 70, decision Q89): every `roster.*` function and value,
//! every data type a Plugin hands the app or gets back, and every event, with its parameters,
//! returns, errors, permission and `Since: api N`. From this table come
//!
//! - `docs/plugin-api.md`, the reference (`:help plugin-api`, `:help roster.inventory.host()`,
//!   `:help roster-Host`);
//! - `examples/plugins/types/roster.lua`, the LuaCATS stubs for lua-language-server;
//! - `crates/roster-core/tests/fixtures/plugin-api.json`, the same as data, which the app's help
//!   (its topics), its tests (ops.ts reads exactly the documented fields) and serve's tests (a
//!   Host has exactly the documented fields) read.
//!
//! `cargo run -p roster-core --example gen_plugin_api` writes the three; `tests/plugin_api.rs`
//! fails when they aren't what it writes, and when the runtime (runtime.rs) exposes a function,
//! value or event this table lacks, or the other way round, for any set of grants.
//!
//! Types are written as LuaCATS (`string?`, `Host[]`, `"info"|"warn"`, `table<string, Group>`);
//! a capitalised name is one of [`TYPES`], made `roster.Host` in the stubs and a link in the docs.

use serde_json::{Value as Json, json};

/// What a function or value needs to exist in a Plugin's `roster` module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Needs {
    /// Every Plugin has it.
    Nothing,
    /// That permission (`"inventory.read"`).
    Permission(&'static str),
    /// Any `serve:<method>` permission.
    AnyServe,
}

impl Needs {
    pub fn text(self) -> String {
        match self {
            Needs::Nothing => "none".into(),
            Needs::Permission(p) => format!("`{p}`"),
            Needs::AnyServe => "`serve:<method>` (that method)".into(),
        }
    }
}

pub struct Param {
    pub name: &'static str,
    pub ty: &'static str,
    pub optional: bool,
    pub doc: &'static str,
}

pub struct Function {
    /// `roster.inventory.host`.
    pub path: &'static str,
    pub params: &'static [Param],
    pub summary: &'static str,
    /// More, in Markdown (may be empty).
    pub doc: &'static str,
    /// The type it returns (`""`: nothing) and what that is.
    pub returns: (&'static str, &'static str),
    /// Each error it raises: the message (or its start), then when.
    pub errors: &'static [(&'static str, &'static str)],
    /// What the app refuses with a warning notice instead (not a Lua error).
    pub refused: &'static [&'static str],
    pub needs: Needs,
    pub since: u32,
    pub example: &'static str,
}

/// A value in the module that isn't a function (`roster.api_version`).
pub struct Value {
    pub path: &'static str,
    pub ty: &'static str,
    pub summary: &'static str,
    pub doc: &'static str,
    pub since: u32,
    pub example: &'static str,
}

pub struct Field {
    pub name: &'static str,
    pub ty: &'static str,
    pub required: bool,
    pub doc: &'static str,
}

pub struct Type {
    pub name: &'static str,
    pub summary: &'static str,
    pub doc: &'static str,
    /// For an alias (`Level = "info"|"warn"|"error"`): what it stands for; else `""`.
    pub alias: &'static str,
    pub fields: &'static [Field],
    /// Its fields name only some of its keys (a Host carries any other key roster.yml gives it).
    pub open: bool,
}

pub struct Event {
    pub name: &'static str,
    /// Any one of these lets a Plugin hear it; none: every Plugin.
    pub needs: &'static [&'static str],
    pub payload: &'static str,
    pub when: &'static str,
}

/// A module of the API, with its functions in the order the reference shows them.
pub struct Module {
    pub name: &'static str,
    pub summary: &'static str,
    pub doc: &'static str,
}

/// A `roster.serve.call` method and what it returns.
pub struct ServeResult {
    pub method: &'static str,
    pub result: &'static str,
    /// The section of docs/serve-api.md, from docs/.
    pub link: &'static str,
}

const fn p(name: &'static str, ty: &'static str, doc: &'static str) -> Param {
    Param {
        name,
        ty,
        optional: false,
        doc,
    }
}

const fn opt(name: &'static str, ty: &'static str, doc: &'static str) -> Param {
    Param {
        name,
        ty,
        optional: true,
        doc,
    }
}

const fn f(name: &'static str, ty: &'static str, doc: &'static str) -> Field {
    Field {
        name,
        ty,
        required: true,
        doc,
    }
}

const fn o(name: &'static str, ty: &'static str, doc: &'static str) -> Field {
    Field {
        name,
        ty,
        required: false,
        doc,
    }
}

pub const MODULES: &[Module] = &[
    Module {
        name: "roster",
        summary: "The module itself: its version, the OS, the Plugin, notices and events",
        doc: "`require(\"roster\")`, also the global `roster`. Each Plugin has its own, built from what it was granted: a function a permission gives isn't there without it.",
    },
    Module {
        name: "roster.commands",
        summary: "`:` commands",
        doc: "",
    },
    Module {
        name: "roster.keymap",
        summary: "Key bindings",
        doc: "",
    },
    Module {
        name: "roster.themes",
        summary: "Themes",
        doc: "",
    },
    Module {
        name: "roster.sidebar",
        summary: "Sidebar sections",
        doc: "",
    },
    Module {
        name: "roster.status",
        summary: "Status bar segments",
        doc: "",
    },
    Module {
        name: "roster.finders",
        summary: "Finders (`:finder ID`)",
        doc: "",
    },
    Module {
        name: "roster.help",
        summary: "Help pages (`:help TOPIC`)",
        doc: "",
    },
    Module {
        name: "roster.health",
        summary: "Sections of `:check`",
        doc: "",
    },
    Module {
        name: "roster.tutor",
        summary: "Tutorials (`:tutor ID`)",
        doc: "",
    },
    Module {
        name: "roster.badges",
        summary: "Badges on Host rows",
        doc: "",
    },
    Module {
        name: "roster.float",
        summary: "A floating window over the terminal",
        doc: "",
    },
    Module {
        name: "roster.clipboard",
        summary: "The clipboard",
        doc: "",
    },
    Module {
        name: "roster.inventory",
        summary: "Hosts, and Pending changes to them",
        doc: "`nil` unless the Plugin was granted `inventory.read` or `inventory.write`; each function is there only with its own permission. The functions wait for `roster serve`; that time doesn't count against the Plugin's budget.",
    },
    Module {
        name: "roster.sessions",
        summary: "Opening Sessions",
        doc: "`nil` unless the Plugin was granted `sessions.open`.",
    },
    Module {
        name: "roster.terminal",
        summary: "Typing into Sessions",
        doc: "`nil` unless the Plugin was granted `terminal.write`. Reading what Sessions print is the `terminal_output` event (`terminal.read`).",
    },
    Module {
        name: "roster.serve",
        summary: "roster serve's methods, by name",
        doc: "`nil` unless the Plugin was granted at least one `serve:<method>` permission.",
    },
];

pub const VALUES: &[Value] = &[
    Value {
        path: "roster.api_version",
        ty: "integer",
        summary: "The version of the `roster` module this app has",
        doc: "A manifest's `api` above it doesn't install (\"update the app\"). One number for `init.lua`'s module and Plugins'.",
        since: 2,
        example: "if roster.api_version < 3 then\n  roster.notify(\"this needs a newer roster for one feature\", \"warn\")\nend",
    },
    Value {
        path: "roster.os",
        ty: "Os",
        summary: "The OS the app runs on",
        doc: "",
        since: 2,
        example: "local copy_key = roster.os == \"macos\" and \"Cmd+C\" or \"Ctrl+Shift+C\"",
    },
    Value {
        path: "roster.plugin",
        ty: "Plugin",
        summary: "The Plugin itself: its name, version, what it was granted and its settings",
        doc: "",
        since: 2,
        example: "local function granted(p)\n  for _, g in ipairs(roster.plugin.permissions) do\n    if g == p then return true end\n  end\n  return false\nend\nlocal leader = roster.plugin.config.leader or \"w w\"",
    },
];

pub const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.notify",
        params: &[
            p(
                "text",
                "string",
                "What to say. It's shown after the Plugin's name (`pinned: …`).",
            ),
            opt("level", "Level", "`\"info\"` (the default), `\"warn\"` or `\"error\"`."),
        ],
        summary: "Shows a notice, naming the Plugin",
        doc: "",
        returns: ("", ""),
        errors: &[(
            "roster.notify: the level is \"info\", \"warn\" or \"error\"",
            "`level` is something else",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.notify(\"3 new alerts\")\nroster.notify(\"leader: not a key sequence, using w w\", \"warn\")",
    },
    Function {
        path: "roster.on",
        params: &[
            p(
                "event",
                "EventName",
                "The event's name: `lock`, `unlock`, `host_selected`, `session_open`, `session_exit`, `inventory_changed` or `terminal_output`.",
            ),
            p(
                "listener",
                "fun(e: table)",
                "Runs with the event's payload (see [Events](#events)) each time it happens. Its return value is ignored.",
            ),
        ],
        summary: "Runs a function on an event",
        doc: "Several listeners for one event run in the order they were added. There's no way to stop listening short of `:plugins reload`.",
        returns: ("", ""),
        errors: &[
            (
                "roster.on: there's no event \"NAME\" (there's lock, unlock, …)",
                "`event` isn't one of them",
            ),
            (
                "roster.on: the EVENT event needs the P permission",
                "the Plugin may not hear it (\"needs the inventory.read or terminal.read permission\")",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.on(\"session_open\", function(e)\n  if e.host then roster.badges.set(e.host, \"open\") end\nend)",
    },
    Function {
        path: "roster.commands.add",
        params: &[
            p(
                "name",
                "string",
                "The command: `:name ARGS`. Lower case letters, digits, `-`, `_` and `.`, at most 64.",
            ),
            p("spec", "CommandSpec", "Its description and what it runs."),
        ],
        summary: "Adds a `:` command",
        doc: "Adding it again replaces it (and the function it ran).",
        returns: ("", ""),
        errors: &[
            (
                "roster.commands.add: \"NAME\" isn't a name like \"recent-alerts\" (…)",
                "a bad `name`",
            ),
            (
                "roster.commands.add: `run` must be a function or a command line",
                "`spec.run` is missing or something else",
            ),
        ],
        refused: &[
            "`:NAME` is taken by roster, `init.lua` or another Plugin (`pinned: :pin is taken (other)`), or it's `:plugins`",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.commands.add(\"alerts\", {\n  desc = \"Recent alerts\",\n  run = function(a)\n    if a.words[1] == \"clear\" then clear() end\n  end,\n})\nroster.commands.add(\"pins\", { desc = \"Pinned Hosts\", run = \"finder pinned\" })",
    },
    Function {
        path: "roster.commands.remove",
        params: &[p("name", "string", "A command this Plugin added.")],
        summary: "Removes one of the Plugin's commands",
        doc: "Removing one it doesn't have does nothing.",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.commands.remove(\"alerts\")",
    },
    Function {
        path: "roster.keymap.set",
        params: &[
            p(
                "context",
                "KeyContext",
                "`\"leader\"` (a key after the Leader), `\"list\"` or `\"list_vim\"` (the Sidebar, and its vim keys).",
            ),
            p("keys", "string", "The keys, space-separated: `\"w w\"`."),
            p(
                "action",
                "string|false",
                "A command line: one of the Plugin's commands or the app's (`\"finder alerts\"`). `false` claims the keys with no action.",
            ),
        ],
        summary: "Binds keys to a command line",
        doc: "Never in the terminal. A function isn't an action: add a command and bind its name.",
        returns: ("", ""),
        errors: &[(
            "roster.keymap.set: the action is a command line such as \"alerts\" (add a command for a function)",
            "`action` isn't a string or `false`",
        )],
        refused: &[
            "a `context` other than the three (`keys go after the Leader or in the Sidebar …`)",
            "keys bound already, by roster, `init.lua` or another Plugin (`a` is Folders', `f` the Picker's; `:keys` lists them)",
            "keys that would hide a binding, or be hidden by one (`\"a z\"` when `a` is bound)",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.keymap.set(\"leader\", roster.plugin.config.leader or \"w w\", \"finder alerts\")",
    },
    Function {
        path: "roster.themes.define",
        params: &[
            p("id", "string", "The Theme's id, as `:theme ID` takes it."),
            p("theme", "Theme", "As `init.lua`'s `themes` takes one."),
        ],
        summary: "Adds a Theme",
        doc: "Checked as `init.lua`'s `themes` are.",
        returns: ("", ""),
        errors: &[
            ("roster.themes.define: \"ID\" isn't a name like …", "a bad `id`"),
            (
                "roster.themes.define \"ID\": …",
                "the Theme isn't one `init.lua` would take: an unknown field or token, a colour that isn't one",
            ),
        ],
        refused: &["a Theme with that id exists already"],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.themes.define(\"dusk\", { base = \"nord\", colors = { accent = \"#e0a060\" } })",
    },
    Function {
        path: "roster.sidebar.set",
        params: &[
            p("id", "string", "The section's id: a name like `recent-alerts`."),
            p("section", "Section", "Its title, place, empty text and rows."),
        ],
        summary: "Adds a Sidebar section, or replaces it",
        doc: "Setting it again replaces the whole section, and drops the functions its old rows held.",
        returns: ("", ""),
        errors: &[("roster.sidebar.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a section with that id from elsewhere",
            "a field of the wrong kind (`roster.sidebar.set pinned row 2: label must be text`): the whole section is dropped",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.sidebar.set(\"pinned\", {\n  title = \"Pinned\",\n  order = 150,\n  empty = \"Nothing pinned. :pin HOST\",\n  rows = { { id = \"esx-02\", label = \"esx-02\", host = \"esx-02\", detail = \"10.0.0.5\" } },\n})",
    },
    Function {
        path: "roster.sidebar.remove",
        params: &[p("id", "string", "One of the Plugin's sections.")],
        summary: "Removes a Sidebar section",
        doc: "",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.sidebar.remove(\"pinned\")",
    },
    Function {
        path: "roster.status.set",
        params: &[
            p("id", "string", "The segment's id."),
            p(
                "segment",
                "StatusSegment",
                "Its text, tooltip and what clicking it runs.",
            ),
        ],
        summary: "Adds a status bar segment, or replaces it",
        doc: "It comes after the app's own segments; a layout can place it (`modes.standard.statusbar`).",
        returns: ("", ""),
        errors: &[("roster.status.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &["a segment with that id from elsewhere", "no `text`"],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.status.set(\"alerts\", { text = \"⚠ \" .. #alerts, title = \"Recent alerts\", run = \"finder alerts\" })",
    },
    Function {
        path: "roster.status.remove",
        params: &[p("id", "string", "One of the Plugin's segments.")],
        summary: "Removes a status bar segment",
        doc: "",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.status.remove(\"alerts\")",
    },
    Function {
        path: "roster.finders.set",
        params: &[
            p("id", "string", "The finder's id: `:finder ID` opens it."),
            p("finder", "Finder", "Its title and items."),
        ],
        summary: "Adds a finder, or replaces it",
        doc: "",
        returns: ("", ""),
        errors: &[("roster.finders.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a finder with that id from elsewhere",
            "an item without a `label` or a `run`: the whole finder is dropped",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.finders.set(\"pinned\", {\n  title = \"Pinned Hosts\",\n  items = { { label = \"esx-02\", detail = \"10.0.0.5\", run = \"open esx-02\" } },\n})",
    },
    Function {
        path: "roster.finders.remove",
        params: &[p("id", "string", "One of the Plugin's finders.")],
        summary: "Removes a finder",
        doc: "",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.finders.remove(\"pinned\")",
    },
    Function {
        path: "roster.help.set",
        params: &[
            p("topic", "string", "The page's topic: `:help TOPIC`."),
            p("page", "HelpPage", "Its title, summary and Markdown."),
        ],
        summary: "Adds a help page, or replaces it",
        doc: "It's listed in the help index under the Plugin's name.",
        returns: ("", ""),
        errors: &[("roster.help.set: \"TOPIC\" isn't a name like …", "a bad `topic`")],
        refused: &["a page with that topic from elsewhere", "no `markdown`"],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.help.set(\"pinned\", {\n  title = \"Pinned Hosts\",\n  summary = \"A Sidebar section of the Hosts you pin\",\n  markdown = \"# Pinned Hosts\\n\\n`:pin HOST` adds a Host.\",\n})",
    },
    Function {
        path: "roster.help.remove",
        params: &[p("topic", "string", "One of the Plugin's pages.")],
        summary: "Removes a help page",
        doc: "",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.help.remove(\"pinned\")",
    },
    Function {
        path: "roster.health.set",
        params: &[
            p("id", "string", "The section's id."),
            p("section", "HealthSection", "Its title and checks."),
        ],
        summary: "Adds a section to `:check` (this Box's health), or replaces it",
        doc: "`:check` shows the checks as the Plugin last set them: it doesn't call the Plugin.",
        returns: ("", ""),
        errors: &[("roster.health.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a section with that id from elsewhere",
            "a check whose `level` isn't `ok`, `warn` or `error`, or without a `message`",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.health.set(\"recent-alerts\", {\n  title = \"Recent alerts\",\n  checks = { { level = \"warn\", message = \"terminal.read isn't granted\", fix = \"Allow it in :plugins\" } },\n})",
    },
    Function {
        path: "roster.health.remove",
        params: &[p("id", "string", "One of the Plugin's sections.")],
        summary: "Removes a `:check` section",
        doc: "",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.health.remove(\"recent-alerts\")",
    },
    Function {
        path: "roster.tutor.set",
        params: &[
            p(
                "id",
                "string",
                "The tutorial's id: `:tutor ID` runs it, `:help tutor-ID` is its page.",
            ),
            p("tutorial", "Tutorial", "Its text and lessons."),
        ],
        summary: "Adds a tutorial, or replaces it",
        doc: "`:tutor ID` runs it on the demo Inventory, where the Plugin itself isn't loaded: a step can wait for the Plugin's command to be run, but the command does nothing there.",
        returns: ("", ""),
        errors: &[("roster.tutor.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a tutorial with that id, or a help page `tutor-ID`, from elsewhere",
            "no lessons, a lesson without a `title`, a step without an `id` or `text`, an `id` used twice, or an `on` that names no tutor event",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.tutor.set(\"pinned\", {\n  title = \"Pinned Hosts\",\n  lessons = {\n    { title = \"Find them\", text = \"Your pinned Hosts have their own finder.\",\n      steps = { { id = \"open\", text = \"Open it with `:finder pinned`\",\n                  on = { event = \"command\", id = \"finder\", arg = \"pinned\" } } } },\n  },\n})",
    },
    Function {
        path: "roster.tutor.remove",
        params: &[p("id", "string", "One of the Plugin's tutorials.")],
        summary: "Removes a tutorial",
        doc: "",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.tutor.remove(\"pinned\")",
    },
    Function {
        path: "roster.badges.set",
        params: &[
            p("host", "string", "The Host's name in the Inventory."),
            opt(
                "text",
                "string",
                "The badge: keep it short, a count (`\"2\"`) or a word (at most 40 characters); `nil` takes it off.",
            ),
        ],
        summary: "Puts a badge on a Host's Inventory row, or takes it off",
        doc: "One badge per Host per Plugin; setting it again replaces it. A name that isn't a Host shows nowhere. The app draws it as a small chip right after the Host's name, in the text colour (never the accent, which means live), and cuts it after 12 characters; its tooltip and the row's accessible name have it whole, after your Plugin's name (`recent-alerts: 2`). So say the count, not what's counted: your Plugin's name says that.",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.badges.set(\"esx-02\", tostring(2))\nroster.badges.set(\"esx-02\", nil)",
    },
    Function {
        path: "roster.float.open",
        params: &[p("float", "Float", "Its title and lines.")],
        summary: "Opens a floating window over the terminal, or replaces the Plugin's",
        doc: "It lies over the terminal, on the side away from the Sidebar, so it never resizes a Session. `Esc` closes it. It has no actions.",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.float.open({ title = \"esx-02\", lines = { \"ERROR disk full\", \"at 10:42\" } })",
    },
    Function {
        path: "roster.float.close",
        params: &[],
        summary: "Closes the Plugin's floating window",
        doc: "Another Plugin's stays.",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.float.close()",
    },
    Function {
        path: "roster.clipboard.copy",
        params: &[p("text", "string", "What to put on the clipboard, at most 64 KB.")],
        summary: "Puts text on the clipboard",
        doc: "Only while the user runs one of the Plugin's actions, commands or finder items, so a Plugin can't change what you copied behind your back. If the clipboard can't be written, the app says so, and the notices the call gave after the copy aren't shown.",
        returns: ("", ""),
        errors: &[
            (
                "roster.clipboard.copy: only while the user runs one of your actions, commands or finder items",
                "at load or in an event listener",
            ),
            (
                "roster.clipboard.copy: the text is over 65536 bytes",
                "the text is longer",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "actions = { { label = \"Copy\", icon = \"copy\", run = function() roster.clipboard.copy(line) end } }",
    },
    Function {
        path: "roster.inventory.hosts",
        params: &[],
        summary: "Every Host, in `roster.yml` order",
        doc: "From serve's [`hosts.list`](serve-api.md): while `roster.yml` doesn't load (an outside edit), the last good Hosts. The groups aren't in it: `roster.serve.call(\"hosts.list\")` (with `serve:hosts.list`) has them.",
        returns: (
            "Host[]",
            "The Hosts, each with its Login references (a vault item's name, never a password).",
        ),
        errors: &[(
            "roster.inventory.hosts: MESSAGE (code N)",
            "roster serve failed (see [Errors](#errors))",
        )],
        refused: &[],
        needs: Needs::Permission("inventory.read"),
        since: 2,
        example: "for _, h in ipairs(roster.inventory.hosts()) do\n  if not h.reviewed then roster.badges.set(h.name, \"review\") end\nend",
    },
    Function {
        path: "roster.inventory.host",
        params: &[p("name", "string", "The Host's exact name.")],
        summary: "One Host, by its exact name",
        doc: "From serve's [`host.get`](serve-api.md). An unknown name is an error, not `nil`: wrap the call in `pcall` when the name came from the user.",
        returns: ("Host", "The Host."),
        errors: &[
            (
                "roster.inventory.host: unknown host 'NAME' (code 2)",
                "no Host has that name",
            ),
            (
                "roster.inventory.host: MESSAGE (code N)",
                "roster serve failed otherwise",
            ),
        ],
        refused: &[],
        needs: Needs::Permission("inventory.read"),
        since: 2,
        example: "local ok, h = pcall(roster.inventory.host, name)\nif ok then roster.notify(name .. \" is \" .. h.ip) end",
    },
    Function {
        path: "roster.inventory.update",
        params: &[
            p("host", "string", "The Host's exact name."),
            p("changes", "Change", "The fields to change, and their new values."),
        ],
        summary: "Changes a Host's fields, as a Pending change",
        doc: "serve's [`host.update`](serve-api.md#editing-pending-changes): `roster.yml` is edited as text (comments and every other entry stay) and the change waits for you to review and Publish it. A change to `ip`, `user`, `port` or `auth` needs a test login of exactly those values first (`host.verify_login`), which a Plugin can't make: from a Plugin those fail with code 75. Only `title`, `description` and `type` go through.",
        returns: ("UpdateResult", "What was written."),
        errors: &[
            (
                "roster.inventory.update: params.changes: … (code -32602)",
                "a field that can't be edited here, or a value of the wrong kind",
            ),
            (
                "roster.inventory.update: unknown host 'NAME' (code 2)",
                "no Host has that name",
            ),
            (
                "roster.inventory.update: … (code 75)",
                "a change to `ip`, `user`, `port` or `auth`",
            ),
            (
                "roster.inventory.update: … (code 70 or 74)",
                "no git repo for Pending changes, or the edit wouldn't load as asked (nothing written)",
            ),
        ],
        refused: &[],
        needs: Needs::Permission("inventory.write"),
        since: 2,
        example: "roster.inventory.update(\"esx-02\", { description = \"lab box, rack 3\" })",
    },
    Function {
        path: "roster.inventory.rename",
        params: &[
            p("host", "string", "The Host's exact name."),
            p("to", "string", "Its new name."),
        ],
        summary: "Renames a Host, as a Pending change",
        doc: "serve's [`host.rename`](serve-api.md#the-live-inventory-hosts-and-groups-and-outside-edits): only its key in `roster.yml` and its name in `links:` change. Its vault item keeps its name.",
        returns: ("RenameResult", "What was written."),
        errors: &[
            ("roster.inventory.rename: … (code 2)", "no Host has that name"),
            (
                "roster.inventory.rename: … (code 80 or 100)",
                "`to` isn't a valid name, or a Host or group has it",
            ),
            (
                "roster.inventory.rename: … (code 1, 70 or 74)",
                "`roster.yml` doesn't load now, no git repo, or the edit wouldn't load as asked",
            ),
        ],
        refused: &[],
        needs: Needs::Permission("inventory.write"),
        since: 2,
        example: "roster.inventory.rename(\"esx-02\", \"esx-02-old\")",
    },
    Function {
        path: "roster.inventory.move",
        params: &[
            p("host", "string", "The Host's exact name."),
            p("group", "string", "The group to move it to (at its end)."),
        ],
        summary: "Moves a Host to another group, as a Pending change",
        doc: "serve's [`host.move`](serve-api.md#the-live-inventory-hosts-and-groups-and-outside-edits): what it inherited from its old group and wouldn't from the new one is written on the Host, so it stays the same Host.",
        returns: (
            "MoveResult",
            "What was written, and which fields were pinned on the Host.",
        ),
        errors: &[
            ("roster.inventory.move: … (code 2)", "no Host has that name"),
            ("roster.inventory.move: … (code 101)", "no such group"),
            (
                "roster.inventory.move: … (code 103)",
                "it would still come out different in the new group",
            ),
            (
                "roster.inventory.move: … (code 1, 70 or 74)",
                "`roster.yml` doesn't load now, no git repo, or the edit wouldn't load as asked",
            ),
        ],
        refused: &[],
        needs: Needs::Permission("inventory.write"),
        since: 2,
        example: "local r = roster.inventory.move(\"esx-02\", \"lab\")\nif #r.pinned > 0 then roster.notify(\"kept \" .. table.concat(r.pinned, \", \")) end",
    },
    Function {
        path: "roster.inventory.review",
        params: &[
            p("host", "string", "The Host's exact name."),
            opt(
                "reviewed",
                "boolean",
                "`true` (the default) marks it reviewed; `false` un-reviews it.",
            ),
        ],
        summary: "Marks a Host reviewed (or not), as a Pending change",
        doc: "serve's [`host.review`](serve-api.md#adding-a-host-hostadd).",
        returns: ("ReviewResult", "What was written."),
        errors: &[
            ("roster.inventory.review: … (code 2)", "no Host has that name"),
            (
                "roster.inventory.review: params.reviewed must be true or false (code -32602)",
                "`reviewed` isn't a boolean",
            ),
            (
                "roster.inventory.review: … (code 70 or 74)",
                "no git repo, or the edit wouldn't load as asked",
            ),
        ],
        refused: &[],
        needs: Needs::Permission("inventory.write"),
        since: 2,
        example: "roster.inventory.review(\"esx-02\")",
    },
    Function {
        path: "roster.sessions.open",
        params: &[p("host", "string", "The Host's exact name.")],
        summary: "Opens a Session on a Host, as `:connect HOST`",
        doc: "It happens after the call returns, as if the user ran `:connect HOST`: the app's own errors (an unknown or unreviewed Host, a locked vault) show as they would then.",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Permission("sessions.open"),
        since: 2,
        example: "roster.sessions.open(\"esx-02\")",
    },
    Function {
        path: "roster.terminal.send",
        params: &[
            p("session", "integer", "The Session's id, from an event (`e.session`)."),
            p(
                "text",
                "string",
                "What to type, as if the user typed it: `\"uptime\\n\"` runs `uptime`.",
            ),
        ],
        summary: "Types into an open Session",
        doc: "A Session that has ended, or an id that's no Session's, takes nothing.",
        returns: ("", ""),
        errors: &[],
        refused: &["`text` over 64 KB is cut"],
        needs: Needs::Permission("terminal.write"),
        since: 2,
        example: "roster.on(\"session_open\", function(e) roster.terminal.send(e.session, \"uptime\\n\") end)",
    },
    Function {
        path: "roster.serve.call",
        params: &[
            p(
                "method",
                "string",
                "A roster serve method the Plugin was granted, by name (`serve:inventory.info` grants `inventory.info`).",
            ),
            opt(
                "params",
                "table",
                "The method's params; `{}` if left out. Data only: no functions.",
            ),
        ],
        summary: "Calls a roster serve method the Plugin was granted",
        doc: "A Plugin may be granted `inventory.info`, `hosts.list`, `host.get`, `host.check`, `changes.diff` and the `mesh.*` and `discover.*` methods; never one that reaches a secret. What each returns is under [roster serve's results](#roster-serves-results).",
        returns: ("any", "The method's result, as Lua tables (JSON `null` is `nil`)."),
        errors: &[
            (
                "roster.serve.call: not granted (serve:METHOD)",
                "the Plugin wasn't granted that method",
            ),
            (
                "roster.serve.call METHOD: MESSAGE (code N)",
                "the method failed (its codes are in [serve-api.md](serve-api.md))",
            ),
        ],
        refused: &[],
        needs: Needs::AnyServe,
        since: 2,
        example: "local info = roster.serve.call(\"inventory.info\")\nroster.status.set(\"box\", { text = info.box .. \": \" .. info.host_count .. \" Hosts\" })",
    },
];

pub const EVENTS: &[Event] = &[
    Event {
        name: "lock",
        needs: &[],
        payload: "EmptyEvent",
        when: "The vault locked (the lock screen came up).",
    },
    Event {
        name: "unlock",
        needs: &[],
        payload: "EmptyEvent",
        when: "The vault unlocked.",
    },
    Event {
        name: "host_selected",
        needs: &["inventory.read", "terminal.read"],
        payload: "HostSelectedEvent",
        when: "The Session on screen changed to a Host's.",
    },
    Event {
        name: "session_open",
        needs: &["inventory.read", "terminal.read"],
        payload: "SessionOpenEvent",
        when: "A Session started (or started again).",
    },
    Event {
        name: "session_exit",
        needs: &["inventory.read", "terminal.read"],
        payload: "SessionExitEvent",
        when: "A Session ended, failed, or its tab was closed while it ran.",
    },
    Event {
        name: "inventory_changed",
        needs: &["inventory.read"],
        payload: "EmptyEvent",
        when: "The app got a new Host list (an edit, a pull, a Publish, an outside edit of `roster.yml`).",
    },
    Event {
        name: "terminal_output",
        needs: &["terminal.read"],
        payload: "TerminalOutputEvent",
        when: "A Session printed something: a few times a second, in batches.",
    },
];

/// What `roster.serve.call` returns, by method.
pub const SERVE_RESULTS: &[ServeResult] = &[
    ServeResult {
        method: "inventory.info",
        result: "InventoryInfo",
        link: "serve-api.md",
    },
    ServeResult {
        method: "hosts.list",
        result: "HostList",
        link: "serve-api.md",
    },
    ServeResult {
        method: "host.get",
        result: "Host",
        link: "serve-api.md",
    },
    ServeResult {
        method: "host.check",
        result: "HostCheck",
        link: "serve-api.md#diagnostics-hostcheck",
    },
    ServeResult {
        method: "changes.diff",
        result: "ChangesDiff",
        link: "serve-api.md#editing-pending-changes",
    },
    ServeResult {
        method: "mesh.*",
        result: "",
        link: "serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus",
    },
];

const RUN_DOC: &str = "What choosing it runs: a function (called with an empty table; its return value is ignored) or a command line (`\"open esx-02\"`).";

pub const TYPES: &[Type] = &[
    // ---------------------------------------------------------------- the Plugin
    Type {
        name: "Manifest",
        summary: "`roster-plugin.lua`: who the Plugin is and what it asks for",
        doc: "The file returns this table. It's read before any of the Plugin's code runs, for the install prompt, in the sandbox with no `roster` module and no `require`. Any other key is an error (`foo: not a manifest field`).",
        alias: "",
        fields: &[
            f(
                "name",
                "string",
                "How it's known everywhere: lower case letters, digits and `-`, starting with a letter, at most 40. Not `builtin`, `init`, `roster` or a built-in Plugin's name.",
            ),
            f("version", "string", "Its version, shown in `:plugins` (`\"1.0.0\"`)."),
            o(
                "description",
                "string",
                "One line on what it does, for the install prompt.",
            ),
            o("author", "string", "Who wrote it, for the install prompt (unverified)."),
            f(
                "api",
                "integer",
                "The `roster.api_version` it's written for; above the app's, it doesn't install.",
            ),
            o(
                "permissions",
                "Permission[]",
                "What it asks for. Each is shown in the install prompt, the risky ones flagged.",
            ),
        ],
        open: false,
    },
    Type {
        name: "Permission",
        summary: "A permission's name, as a manifest writes it",
        doc: "What each gives is in [Permissions](plugins.md#permissions). `network` isn't available yet; a serve method that reaches a secret can't be asked for.",
        alias: "\"inventory.read\"|\"inventory.write\"|\"sessions.open\"|\"terminal.read\"|\"terminal.write\"|string",
        fields: &[],
        open: false,
    },
    Type {
        name: "Plugin",
        summary: "`roster.plugin`: the Plugin itself",
        doc: "",
        alias: "",
        fields: &[
            f("name", "string", "Its name, from the manifest."),
            f("version", "string", "Its version, from the manifest."),
            f(
                "permissions",
                "Permission[]",
                "What it runs with: what it asked for and was granted, sorted (`serve:` ones by method).",
            ),
            f(
                "config",
                "table",
                "Its settings from `init.lua` when it's a Package (`{ \"owner/repo\", config = { … } }`); else `{}`. Anyone can write anything there: check it.",
            ),
        ],
        open: false,
    },
    Type {
        name: "Os",
        summary: "`roster.os`",
        doc: "",
        alias: "\"windows\"|\"linux\"|\"macos\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "Level",
        summary: "A notice's level",
        doc: "",
        alias: "\"info\"|\"warn\"|\"error\"",
        fields: &[],
        open: false,
    },
    // ---------------------------------------------------------------- what a Plugin hands the app
    Type {
        name: "Run",
        summary: "What choosing a row, an action, a finder item or a status segment runs",
        doc: RUN_DOC,
        alias: "string|fun(args: table): any",
        fields: &[],
        open: false,
    },
    Type {
        name: "CommandSpec",
        summary: "`roster.commands.add`'s second argument",
        doc: "",
        alias: "",
        fields: &[
            o(
                "desc",
                "string",
                "Its description, for `:help commands` and completion. The name if left out.",
            ),
            f(
                "run",
                "string|fun(args: CommandArgs): any",
                "A function, called with what followed the command, or a command line to run instead.",
            ),
        ],
        open: false,
    },
    Type {
        name: "CommandArgs",
        summary: "What a command's function is called with",
        doc: "",
        alias: "",
        fields: &[
            f(
                "args",
                "string",
                "Everything after the command's name, trimmed (`\"\"` for none).",
            ),
            f("words", "string[]", "`args` split at spaces (`{}` for none)."),
        ],
        open: false,
    },
    Type {
        name: "KeyContext",
        summary: "Where a Plugin's key binding works",
        doc: "",
        alias: "\"leader\"|\"list\"|\"list_vim\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "Theme",
        summary: "A Theme, as `init.lua`'s `themes` takes one",
        doc: "The tokens and how a Theme starts from its `base` are in [Themes and colours](app/config.md#themes-and-colours).",
        alias: "",
        fields: &[
            o("label", "string", "Shown in the app; the id if left out."),
            o(
                "appearance",
                "\"dark\"|\"light\"",
                "Which OS appearance it suits; the base's if left out.",
            ),
            o(
                "base",
                "string",
                "The Theme it starts from (a bundled one's id); Roster dark or Roster light by `appearance` if left out.",
            ),
            o(
                "colors",
                "table<string, string>",
                "UI tokens it changes (`accent`, `bg`, …), as CSS colours.",
            ),
            o(
                "terminal",
                "table<string, string>",
                "Terminal colours it changes (`background`, `foreground`, `cursor`, …).",
            ),
            o(
                "ansi",
                "table<string, string>|false",
                "The 16 ANSI colours (`red`, `bright_red`, …); `false` keeps the standard palette. The base's if left out.",
            ),
        ],
        open: false,
    },
    Type {
        name: "Section",
        summary: "A Sidebar section (`roster.sidebar.set`)",
        doc: "",
        alias: "",
        fields: &[
            o("title", "string", "Its heading; the id if left out."),
            o(
                "order",
                "number",
                "Where it goes: Sessions is 100, the Inventory 300. 400 if left out.",
            ),
            o("empty", "string", "What it says with no rows."),
            o("rows", "Row[]", "Its rows, at most 2,000."),
        ],
        open: false,
    },
    Type {
        name: "Row",
        summary: "A row of a Sidebar section",
        doc: "Text is cut to 500 characters.",
        alias: "",
        fields: &[
            o(
                "id",
                "string",
                "Unique in the section (at most 100 characters); its place in the list if left out. Keeps the selection on it across `set`s.",
            ),
            f("label", "string", "Its text."),
            o("detail", "string", "A second, quieter text after the label."),
            o("note", "string", "A short note on the right."),
            o(
                "host",
                "string",
                "Makes it the Host's row: Enter opens that Host (unless `run` says otherwise) and it lights up while the Host's Session is on screen. Never set it to a Quick Connect Session's `nil` host.",
            ),
            o("badge", "string", "A badge (at most 40 characters)."),
            o("count", "number", "A count on the right."),
            o("level", "number", "How far it's indented, 0 to 8."),
            o("title", "string", "Its tooltip."),
            o(
                "run",
                "Run",
                "What Enter runs. With `host` and no `run`, it opens the Host; with neither, nothing.",
            ),
            o("actions", "RowAction[]", "Buttons on the row."),
        ],
        open: false,
    },
    Type {
        name: "RowAction",
        summary: "A button on a row",
        doc: "",
        alias: "",
        fields: &[
            f(
                "label",
                "string",
                "What it does, for its tooltip and screen readers (`\"Unpin esx-02\"`).",
            ),
            o("icon", "RowIcon", "Its icon; `info` if left out."),
            f("run", "Run", "What pressing it runs."),
        ],
        open: false,
    },
    Type {
        name: "RowIcon",
        summary: "A row action's icon",
        doc: "",
        alias: "\"close\"|\"edit\"|\"add\"|\"addGroup\"|\"review\"|\"unreview\"|\"info\"|\"copy\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "StatusSegment",
        summary: "A status bar segment (`roster.status.set`)",
        doc: "",
        alias: "",
        fields: &[
            f("text", "string", "Its text, at most 80 characters."),
            o("title", "string", "Its tooltip."),
            o("run", "Run", "What clicking it runs."),
        ],
        open: false,
    },
    Type {
        name: "Finder",
        summary: "A finder (`roster.finders.set`)",
        doc: "",
        alias: "",
        fields: &[
            o("title", "string", "Its title and prompt; the id if left out."),
            o("items", "FinderItem[]", "What it finds in, at most 2,000."),
        ],
        open: false,
    },
    Type {
        name: "FinderItem",
        summary: "One thing a finder lists",
        doc: "",
        alias: "",
        fields: &[
            o(
                "id",
                "string",
                "Unique in the finder; its place in the list if left out.",
            ),
            f("label", "string", "What's matched and shown."),
            o("detail", "string", "Shown after the label, and matched too."),
            o("path", "string", "Where it is, shown quieter (`lab › esx-02`)."),
            f("run", "Run", "What Enter runs."),
        ],
        open: false,
    },
    Type {
        name: "HelpPage",
        summary: "A help page (`roster.help.set`)",
        doc: "",
        alias: "",
        fields: &[
            o("title", "string", "Its title; the topic if left out."),
            o(
                "summary",
                "string",
                "One line for the index and the topic finder; the title if left out.",
            ),
            f(
                "markdown",
                "string",
                "The page, as Markdown (at most 200,000 characters): headings, paragraphs, lists, tables, code, links.",
            ),
        ],
        open: false,
    },
    Type {
        name: "HealthSection",
        summary: "A section of `:check` (`roster.health.set`)",
        doc: "",
        alias: "",
        fields: &[
            o("title", "string", "Its heading; the id if left out."),
            o("checks", "HealthCheck[]", "Its lines."),
        ],
        open: false,
    },
    Type {
        name: "HealthCheck",
        summary: "One line of a `:check` section",
        doc: "",
        alias: "",
        fields: &[
            f("level", "\"ok\"|\"warn\"|\"error\"", "How it went."),
            f("message", "string", "What it found."),
            o("fix", "string", "What to do about it, in a sentence."),
        ],
        open: false,
    },
    Type {
        name: "Tutorial",
        summary: "A tutorial (`roster.tutor.set`)",
        doc: "",
        alias: "",
        fields: &[
            o("title", "string", "Its title; the id if left out."),
            o(
                "summary",
                "string",
                "One line for `:tutor` and the help index; the title if left out.",
            ),
            o("intro", "string", "Markdown before the first lesson."),
            f("lessons", "Lesson[]", "At least one."),
            o("outro", "string", "Markdown after the last lesson."),
        ],
        open: false,
    },
    Type {
        name: "Lesson",
        summary: "A lesson of a tutorial",
        doc: "",
        alias: "",
        fields: &[
            f("title", "string", "Its heading (at most 100 characters)."),
            o("text", "string", "Markdown before its steps."),
            o("steps", "Step[]", "What to do, in order."),
        ],
        open: false,
    },
    Type {
        name: "Step",
        summary: "A step of a lesson: done when the app sends a matching event",
        doc: "",
        alias: "",
        fields: &[
            f(
                "id",
                "string",
                "Unique in the tutorial: what the State keeps once it's done.",
            ),
            f("text", "string", "What to do (Markdown)."),
            f(
                "on",
                "StepMatch|StepMatch[]",
                "The event that ticks it, or a list of them (any one does).",
            ),
        ],
        open: false,
    },
    Type {
        name: "StepMatch",
        summary: "An event a step waits for",
        doc: "These are the app's own events, sent only to the tutorial running, on the demo Inventory; the Plugin's code never sees them.\n\n| `event` | Its fields |\n|---|---|\n| `command` | `id` (the command, `theme`), `arg` (what followed it, `nord`): every command run, from a key, a button or the command line |\n| `session_open`, `session_exit`, `host_selected` | `host` |\n| `help_open`, `help_back`, `help_forward` | `page`, `anchor` |\n| `help_search` | `page`, `query` |",
        alias: "",
        fields: &[
            f("event", "TutorEvent", "The event's name."),
            o(
                "[string]",
                "string",
                "Any other key is a field the event must have, equal ignoring case; `\"*\"` means it's there, `\"\"` that it isn't.",
            ),
        ],
        open: false,
    },
    Type {
        name: "TutorEvent",
        summary: "The events a tutorial's step can wait for",
        doc: "",
        alias: "\"command\"|\"session_open\"|\"session_exit\"|\"host_selected\"|\"help_open\"|\"help_back\"|\"help_forward\"|\"help_search\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "Float",
        summary: "A floating window (`roster.float.open`)",
        doc: "",
        alias: "",
        fields: &[
            o("title", "string", "Its title."),
            o(
                "lines",
                "string[]",
                "Its text, a line each (at most 2,000, each cut to 500 characters).",
            ),
        ],
        open: false,
    },
    // ---------------------------------------------------------------- the Inventory
    Type {
        name: "Host",
        summary: "A Host, as roster serve's `hosts.list` and `host.get` give it",
        doc: "Every value is resolved: what the Host doesn't set comes from its group, then `defaults:`. JSON `null` is `nil` in Lua, so an unset optional field is `nil`. A Host also carries any other key `roster.yml` gives it, its group or `defaults:` (as roster.yml has it): read only the fields below. No field ever holds a password: `auth` is a [LoginRef](#loginref).",
        alias: "",
        fields: &[
            f("name", "string", "Its name in the Inventory, unique."),
            f("group", "string", "The group it's in."),
            f("ip", "string", "Its address (an IP or a DNS name)."),
            f("ssh", "SshLogin", "How roster logs in to it over ssh."),
            f("login", "Login", "The default Login for its services."),
            f(
                "services",
                "table<string, Service>",
                "Its services by name (`web`, `postgres`). `{}` when there are none.",
            ),
            f(
                "problems",
                "ServiceProblem[]",
                "Service entries roster left out because it can't use them. `{}` when there are none.",
            ),
            o(
                "web",
                "string",
                "Its web UI's URL: the `web` service's, else the first service given a URL.",
            ),
            f(
                "enroll",
                "boolean",
                "Whether `roster setup` puts this Box's key on it (`false`: password Sessions).",
            ),
            f(
                "reviewed",
                "boolean",
                "`false` for a Host `discover` added and no one has reviewed: it can't be opened until it is.",
            ),
            o(
                "mesh",
                "boolean",
                "`mesh:` as roster.yml sets it; `nil` if nothing does.",
            ),
            f("title", "string", "One line; `\"\"` if unset."),
            f("description", "string", "One line; `\"\"` if unset."),
            f("type", "string", "What it is (`esxi`, `linux`); `\"\"` if unset."),
            f("product", "string", "Its product; `\"\"` if unset."),
            f("mac", "string", "Its MAC address; `\"\"` if unset."),
            f(
                "notes",
                "string",
                "The older name for `description`, as roster.yml has it.",
            ),
            f("user", "string", "The same as `ssh.user` (kept for older code)."),
            f("port", "integer", "The same as `ssh.port`."),
            f("auth", "LoginRef", "The same as `ssh.auth`."),
        ],
        open: true,
    },
    Type {
        name: "LoginRef",
        summary: "A Login reference: where a password is, never the password",
        doc: "`PROVIDER:ITEM`, a vault item's name (`bw:esx-02 ssh`, `op:Lab/esx-02#password`, `kp:esx-02 ssh`), or `prompt` (asked for), `agent` (an ssh key), `key`, `none`. `env:VAR` and `cmd:COMMAND` are references too: they name a variable or a command, and a Plugin sees that text. The providers are in [Password providers](cli-reference.md#password-providers).",
        alias: "string",
        fields: &[],
        open: false,
    },
    Type {
        name: "SshLogin",
        summary: "A Host's ssh login",
        doc: "",
        alias: "",
        fields: &[
            f("user", "string", "The user."),
            f("port", "integer", "The port (22 unless set)."),
            f("auth", "LoginRef", "Its Login (`prompt` unless set)."),
        ],
        open: false,
    },
    Type {
        name: "Login",
        summary: "A Host's default Login for its services (`login:` in roster.yml)",
        doc: "",
        alias: "",
        fields: &[
            o("user", "string", "The user; `nil` if unset."),
            o("auth", "LoginRef", "The Login; `nil` if unset."),
        ],
        open: false,
    },
    Type {
        name: "Service",
        summary: "One of a Host's services, resolved",
        doc: "",
        alias: "",
        fields: &[
            f("port", "integer", "Its port."),
            o("url", "string", "Its URL, for http and https services."),
            o("scheme", "string", "`http`, `https`, or `nil` when roster can't tell."),
            o("user", "string", "Its user: its own, else the Host's `login.user`."),
            o("auth", "LoginRef", "Its Login: its own, else the Host's `login.auth`."),
            f("verify", "boolean", "Whether its TLS certificate is checked."),
            f(
                "login",
                "string",
                "How `roster web` signs in: `basic`, `bearer`, `vsphere`, `unifi`, `openvpnas`, `hub` or `none`.",
            ),
            f(
                "override",
                "boolean",
                "`true` when it has a Login of its own; `false` when it uses the Host's.",
            ),
        ],
        open: false,
    },
    Type {
        name: "ServiceProblem",
        summary: "A service entry roster left out of a Host",
        doc: "",
        alias: "",
        fields: &[
            f("service", "string", "The service's name."),
            f("message", "string", "What's wrong, naming the service."),
            f("fix", "string", "What to change."),
        ],
        open: false,
    },
    Type {
        name: "Group",
        summary: "A group of Hosts, as `hosts.list` gives it",
        doc: "",
        alias: "",
        fields: &[
            f("title", "string", "One line; `\"\"` if unset."),
            f("description", "string", "One line; `\"\"` if unset."),
        ],
        open: false,
    },
    Type {
        name: "Change",
        summary: "`roster.inventory.update`'s changes: the fields to change",
        doc: "At least one. Text is one line (spaces collapse, as roster.yml's loader reads it).",
        alias: "",
        fields: &[
            o("title", "string", "One line."),
            o("description", "string", "One line."),
            o("type", "string", "One line."),
            o(
                "ip",
                "string",
                "No spaces, not empty. Needs a test login first: refused from a Plugin (code 75).",
            ),
            o(
                "user",
                "string",
                "No spaces, not empty. Refused from a Plugin (code 75).",
            ),
            o("port", "integer", "1 to 65535. Refused from a Plugin (code 75)."),
            o("auth", "LoginRef", "Refused from a Plugin (code 75)."),
        ],
        open: false,
    },
    Type {
        name: "UpdateResult",
        summary: "What `roster.inventory.update` wrote",
        doc: "",
        alias: "",
        fields: &[
            f(
                "changed",
                "boolean",
                "`false` when the Host already had those values (nothing written).",
            ),
            f("host", "Host", "The Host as it loads now."),
            o(
                "backup",
                "string",
                "Where `roster.yml` as it was is kept; `nil` when nothing changed.",
            ),
            o(
                "warnings",
                "string[]",
                "What failed after the write; `nil` when nothing changed.",
            ),
        ],
        open: false,
    },
    Type {
        name: "RenameResult",
        summary: "What `roster.inventory.rename` wrote",
        doc: "",
        alias: "",
        fields: &[
            f("changed", "boolean", "`false` when `to` is its name already."),
            f("host", "Host", "The Host as it loads now."),
            o(
                "backup",
                "string",
                "Where `roster.yml` as it was is kept; `nil` when nothing changed.",
            ),
        ],
        open: false,
    },
    Type {
        name: "MoveResult",
        summary: "What `roster.inventory.move` wrote",
        doc: "",
        alias: "",
        fields: &[
            f("changed", "boolean", "`false` when it's in that group already."),
            f("host", "Host", "The Host as it loads now."),
            f(
                "pinned",
                "string[]",
                "The fields written on the Host so it stays the same Host.",
            ),
            o(
                "backup",
                "string",
                "Where `roster.yml` as it was is kept; `nil` when nothing changed.",
            ),
        ],
        open: false,
    },
    Type {
        name: "ReviewResult",
        summary: "What `roster.inventory.review` wrote",
        doc: "",
        alias: "",
        fields: &[
            f("changed", "boolean", "`false` when it already was."),
            f("host", "Host", "The Host as it loads now."),
            o(
                "backup",
                "string",
                "Where `roster.yml` as it was is kept; `nil` when nothing changed.",
            ),
        ],
        open: false,
    },
    // ---------------------------------------------------------------- serve.call results
    Type {
        name: "InventoryInfo",
        summary: "`inventory.info`'s result",
        doc: "",
        alias: "",
        fields: &[
            f("path", "string", "`roster.yml`'s full path."),
            f("box", "string", "This Box's name."),
            f("host_count", "integer", "How many Hosts."),
            f("providers", "string[]", "The password providers roster has."),
            f("roster_version", "string", "roster's version."),
            f(
                "api_version",
                "integer",
                "roster serve's API version (not `roster.api_version`).",
            ),
        ],
        open: false,
    },
    Type {
        name: "HostList",
        summary: "`hosts.list`'s result",
        doc: "",
        alias: "",
        fields: &[
            f("hosts", "Host[]", "Every Host, in `roster.yml` order."),
            f("groups", "table<string, Group>", "Every group, by name."),
            o(
                "error",
                "InventoryError",
                "Why `roster.yml` as it is now doesn't load, while these are the last good Hosts; `nil` when it loads.",
            ),
        ],
        open: false,
    },
    Type {
        name: "InventoryError",
        summary: "Why `roster.yml` doesn't load right now",
        doc: "",
        alias: "",
        fields: &[
            f("message", "string", "What's wrong."),
            o("path", "string", "The file."),
            o("line", "integer", "The line, when roster knows it."),
            o("fix", "string", "What to do."),
        ],
        open: false,
    },
    Type {
        name: "HostCheck",
        summary: "`host.check`'s result: the steps of `roster check HOST`",
        doc: "",
        alias: "",
        fields: &[
            f("host", "string", "The Host."),
            f("ok", "boolean", "Whether every step passed."),
            f(
                "steps",
                "CheckStep[]",
                "Every step, in order: `inventory`, `ssh-config`, `provider`, `vault-item`, `dns`, `tcp`, `host-key`, `auth`.",
            ),
        ],
        open: false,
    },
    Type {
        name: "CheckStep",
        summary: "One step of a `host.check`",
        doc: "",
        alias: "",
        fields: &[
            f("step", "string", "Its name."),
            f(
                "status",
                "\"ok\"|\"fail\"|\"skipped\"",
                "How it went; every step after a `fail` is `skipped`.",
            ),
            f("message", "string", "What happened."),
            o("code", "integer", "A failed step's error code (serve-api.md's tables)."),
            o("fix", "string", "What to do, in a sentence."),
            o("details", "string", "The raw text, when there is one (ssh's stderr)."),
            o("data", "table", "What the code's row says it carries."),
        ],
        open: false,
    },
    Type {
        name: "ChangesDiff",
        summary: "`changes.diff`'s result: the Pending changes",
        doc: "",
        alias: "",
        fields: &[
            f("path", "string", "`roster.yml`'s path."),
            f("repo", "string", "The infra repo's top folder."),
            f(
                "diff",
                "string",
                "git's diff of `roster.yml` against the last commit; `\"\"` for none.",
            ),
            f("hosts", "HostChange[]", "The Hosts it changes."),
            f("groups", "GroupChange[]", "The groups it changes."),
            f(
                "count",
                "integer",
                "How many Hosts change (1 for a change that touches none, 0 for no change).",
            ),
            f("message", "string", "The commit message Publish would write."),
            o(
                "last_commit",
                "LastCommit",
                "The branch's last commit; `nil` in a repo with none.",
            ),
        ],
        open: false,
    },
    Type {
        name: "HostChange",
        summary: "A Host in `changes.diff`",
        doc: "",
        alias: "",
        fields: &[
            f("host", "string", "Its name."),
            f("change", "\"changed\"|\"added\"|\"removed\"", "What happened to it."),
            f("fields", "string[]", "For `changed`, the fields that did."),
        ],
        open: false,
    },
    Type {
        name: "GroupChange",
        summary: "A group in `changes.diff`",
        doc: "",
        alias: "",
        fields: &[
            f("group", "string", "Its name."),
            f("change", "\"changed\"|\"added\"|\"removed\"", "What happened to it."),
        ],
        open: false,
    },
    Type {
        name: "LastCommit",
        summary: "The infra repo's last commit",
        doc: "",
        alias: "",
        fields: &[
            f("commit", "string", "Its hash."),
            f("subject", "string", "Its subject line."),
            o(
                "upstream",
                "string",
                "The branch's upstream (`origin/main`); `nil` without one.",
            ),
            f(
                "pushed",
                "boolean",
                "Whether the upstream has it, as this Box last fetched.",
            ),
        ],
        open: false,
    },
    // ---------------------------------------------------------------- events
    Type {
        name: "EventName",
        summary: "An event a Plugin can listen for",
        doc: "",
        alias: "\"lock\"|\"unlock\"|\"host_selected\"|\"session_open\"|\"session_exit\"|\"inventory_changed\"|\"terminal_output\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "EmptyEvent",
        summary: "The payload of `lock`, `unlock` and `inventory_changed`: an empty table",
        doc: "",
        alias: "",
        fields: &[],
        open: false,
    },
    Type {
        name: "HostSelectedEvent",
        summary: "`host_selected`'s payload",
        doc: "",
        alias: "",
        fields: &[f("host", "string", "The Host whose Session is on screen now.")],
        open: false,
    },
    Type {
        name: "SessionOpenEvent",
        summary: "`session_open`'s payload",
        doc: "",
        alias: "",
        fields: &[
            f(
                "session",
                "integer",
                "The Session's id: `roster.terminal.send` takes it.",
            ),
            o(
                "host",
                "string",
                "The Host's name; `nil` for a Quick Connect Session (`:quick`), which isn't on a Host: don't badge it or make a row go to it.",
            ),
        ],
        open: false,
    },
    Type {
        name: "SessionExitEvent",
        summary: "`session_exit`'s payload",
        doc: "",
        alias: "",
        fields: &[
            f("session", "integer", "The Session's id."),
            o(
                "host",
                "string",
                "The Host's name; `nil` for a Quick Connect Session, and for a tab closed while it ran.",
            ),
            o(
                "code",
                "integer",
                "ssh's exit code; `nil` when it failed to start or its tab was closed.",
            ),
        ],
        open: false,
    },
    Type {
        name: "TerminalOutputEvent",
        summary: "`terminal_output`'s payload",
        doc: "What you type into a Session is never an event, but the shell echoes it back, so it's here like anything else the Session prints.",
        alias: "",
        fields: &[
            f("session", "integer", "The Session's id."),
            o("host", "string", "The Host's name; `nil` for a Quick Connect Session."),
            f(
                "text",
                "string",
                "What it printed since the last one, as text without colours or escape sequences (at most the last 16 KB); a cursor move to a row is a line break. A line can be split across two batches. Right after the app resizes the Session, the screen it prints again (ConPTY does on Windows, and full-screen programs redraw) isn't sent: for a second, lines it already sent lately are left out, and only new ones come.",
            ),
        ],
        open: false,
    },
];

/// Which Lua, for authors coming from Neovim.
const LUA_DOC: &str = "roster embeds **Lua 5.4** (built into the app, nothing to install), not LuaJIT as Neovim does; [why](adr/0006-lua-plugins-and-packages.md#why-lua-54-not-luajit). Coming from Neovim:

- Integers are real 64-bit integers (`3 // 2` is `1`, `math.type(1)` is `\"integer\"`), and the bitwise operators are native (`a & b`, `a | b`, `~a`, `a << 2`): there's no `bit` library.
- `goto`, `<const>` and `<close>` locals work; there's no `jit` and no FFI.
- The API is `roster.*`, never `vim.*`: there's no `vim.api`, `vim.fn`, `vim.loop` or `vim.schedule`.
- It runs in the [sandbox](app/config.md#the-sandbox): the base functions, `string`, `table`, `math`, `utf8` and an `os` with only `time`, `clock`, `date` and `difftime`. No `io`, no `os.execute`, no `debug`, no `coroutine`, no `package` and no C modules; `load` takes text only, and `require` loads only from the Plugin's own folder (`name.lua`, `name/init.lua`, or the same under `lua/`).
- It runs on a thread of its own with a memory limit and a time budget per call: see [Limits](plugins.md#limits).";

/// The errors any function can raise, and what a call that fails does.
const ERRORS_DOC: &str = "A function that fails raises a Lua error: `pcall` catches it, with the message as a string. The message starts with the function (`roster.inventory.host: unknown host 'web-9' (code 2)`); a roster serve error ends with its code, from [serve-api.md's tables](serve-api.md). An error you don't catch stops the call: a notice names the Plugin, file and line (`pinned: init.lua:12: …`), the UI changes that call made are dropped, and the third such error after loading stops the Plugin.

Any function can also raise:

- Lua's own `bad argument` error, for an argument of the wrong kind (a number where a table goes);
- `PATH: a table that mixes a list with named keys (or has gaps): use one or the other`, `PATH: a Lua function can't be a Config value`, `PATH: a userdata can't be a Config value` and the like, for data that can't be handed over (`PATH` is where in your table, `rows.3.label`);
- `more than 1000 UI changes in one go`, when one call sets more than that;
- `more than 10000 functions handed to roster at once`.

**Refused by the app** isn't an error: the app shows a warning notice naming the Plugin (`pinned: :pin is taken (builtin)`) and leaves that one change out. The call itself goes on.";

// ---------------------------------------------------------------- lookups

pub fn module_of(path: &str) -> &'static str {
    let parent = path.rsplit_once('.').map_or("roster", |(m, _)| m);
    MODULES.iter().find(|m| m.name == parent).map_or("roster", |m| m.name)
}

fn type_named(name: &str) -> Option<&'static Type> {
    TYPES.iter().find(|t| t.name == name)
}

/// `roster.inventory.host(name)`.
pub fn signature(func: &Function) -> String {
    let names: Vec<&str> = func.params.iter().map(|p| p.name).collect();
    format!("{}({})", func.path, names.join(", "))
}

/// GitHub's anchor for a heading (and the help's: app/src/help/doc.ts `slug`).
pub fn slug(title: &str) -> String {
    title
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '_' || *c == '-')
        .collect::<String>()
        .trim()
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .collect()
}

fn func_anchor(func: &Function) -> String {
    slug(&signature(func))
}

/// A type expression's pieces: text, and the names of [`TYPES`] in it.
fn pieces(ty: &str) -> Vec<(bool, String)> {
    let mut out: Vec<(bool, String)> = Vec::new();
    let mut push = |is_type: bool, s: String| match out.last_mut() {
        Some((false, last)) if !is_type => last.push_str(&s),
        _ => out.push((is_type, s)),
    };
    let chars: Vec<char> = ty.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            let start = i;
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                i += 1;
            }
            i += 1;
            push(false, chars[start..i.min(chars.len())].iter().collect());
        } else if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let known = word.starts_with(|c: char| c.is_uppercase()) && type_named(&word).is_some();
            push(known, word);
        } else {
            push(false, c.to_string());
            i += 1;
        }
    }
    out
}

/// A type as the stubs write it: `roster.Host[]`.
pub fn lua_type(ty: &str) -> String {
    pieces(ty)
        .into_iter()
        .map(|(t, s)| if t { format!("roster.{s}") } else { s })
        .collect()
}

/// A type as the docs write it: code, with each type a link to its entry.
fn md_type(ty: &str) -> String {
    pieces(ty)
        .into_iter()
        .map(|(t, s)| {
            if t {
                format!("[`{s}`](#{})", slug(&format!("`{s}`")))
            } else {
                format!("`{s}`")
            }
        })
        .collect::<String>()
        .replace('|', "\\|")
}

fn cell(text: &str) -> String {
    text.replace('\n', " ").replace('|', "\\|")
}

// ---------------------------------------------------------------- the reference

pub const DOC_PATH: &str = "docs/plugin-api.md";
pub const STUBS_PATH: &str = "examples/plugins/types/roster.lua";
pub const JSON_PATH: &str = "crates/roster-core/tests/fixtures/plugin-api.json";
pub const COMMAND: &str = "cargo run -p roster-core --example gen_plugin_api";

fn functions_of(module: &str) -> impl Iterator<Item = &'static Function> + '_ {
    FUNCTIONS.iter().filter(move |f| module_of(f.path) == module)
}

/// docs/plugin-api.md.
pub fn markdown() -> String {
    let mut s = String::new();
    s.push_str("# The Plugin API\n\n");
    s.push_str(&format!(
        "<!-- Generated from crates/roster-core/src/plugin/api.rs by `{COMMAND}`: edit that, then run it. -->\n\n"
    ));
    s.push_str(&format!(
        "Every function, value, event and data type of the `roster` Lua module a Plugin gets, `roster.api_version` {}. How to write, install and trust a Plugin is the guide, [Writing a Plugin](plugins.md); this is the reference. Each entry is a help topic: `:help roster.inventory.host()` for a function, `:help roster-Host` for a type.\n\n",
        super::API_VERSION
    ));
    s.push_str("Types are written as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations write them: `string?` may be `nil`, `Host[]` is a list of Hosts, `table<string, Group>` a table of Groups by name, `\"info\"|\"warn\"` one of those strings. The same declarations are [`roster.lua`](../examples/plugins/types/roster.lua), for [your editor](#editor-support).\n\n");

    s.push_str("## The Lua\n\n");
    s.push_str(LUA_DOC);
    s.push_str("\n\n");
    s.push_str("## Index\n\n| Function | What it does | Permission |\n|---|---|---|\n");
    for v in VALUES {
        s.push_str(&format!(
            "| [`{}`](#{}) | {} | none |\n",
            v.path,
            slug(&format!("`{}`", v.path)),
            cell(v.summary)
        ));
    }
    for m in MODULES {
        for func in functions_of(m.name) {
            s.push_str(&format!(
                "| [`{}`](#{}) | {} | {} |\n",
                signature(func),
                func_anchor(func),
                cell(func.summary),
                func.needs.text()
            ));
        }
    }
    s.push_str("\n| Type | What it is |\n|---|---|\n");
    for t in TYPES {
        s.push_str(&format!("| {} | {} |\n", md_type(t.name), cell(t.summary)));
    }
    s.push('\n');

    s.push_str("## Errors\n\n");
    s.push_str(ERRORS_DOC);
    s.push_str("\n\n");

    for m in MODULES {
        s.push_str(&format!("## `{}`\n\n{}.", m.name, m.summary));
        if !m.doc.is_empty() {
            s.push(' ');
            s.push_str(m.doc);
        }
        s.push_str("\n\n");
        if m.name == "roster" {
            for v in VALUES {
                s.push_str(&format!("### `{}`\n\n{}.", v.path, v.summary));
                if !v.doc.is_empty() {
                    s.push(' ');
                    s.push_str(v.doc);
                }
                s.push_str(&format!(
                    "\n\n**Type:** {}\n\n**Permission:** none · **Since:** api {}\n\n**Example**\n\n```lua\n{}\n```\n\n",
                    md_type(v.ty),
                    v.since,
                    v.example
                ));
            }
        }
        for func in functions_of(m.name) {
            function_entry(&mut s, func);
        }
    }

    s.push_str("## Events\n\n`roster.on(event, function(e) … end)` runs the function with the event's payload. Listening for an event the Plugin may not hear is an error. Each needs any one of the permissions listed.\n\n| Event | When | Payload | Needs |\n|---|---|---|---|\n");
    for e in EVENTS {
        let needs = if e.needs.is_empty() {
            "nothing".to_string()
        } else {
            e.needs
                .iter()
                .map(|p| format!("`{p}`"))
                .collect::<Vec<_>>()
                .join(" or ")
        };
        s.push_str(&format!(
            "| `{}` | {} | {} | {} |\n",
            e.name,
            cell(e.when),
            md_type(e.payload),
            needs
        ));
    }
    s.push('\n');

    s.push_str("## roster serve's results\n\nWhat `roster.serve.call(method)` returns, for the methods a Plugin may be granted. JSON `null` is `nil`.\n\n| Method | Result | In serve-api.md |\n|---|---|---|\n");
    for r in SERVE_RESULTS {
        let result = if r.result.is_empty() {
            "see serve-api.md".to_string()
        } else {
            md_type(r.result)
        };
        s.push_str(&format!(
            "| `{}` | {} | [{}]({}) |\n",
            r.method, result, r.method, r.link
        ));
    }
    s.push('\n');

    s.push_str("## Types\n\n");
    for t in TYPES {
        type_entry(&mut s, t);
    }

    s.push_str("## Editor support\n\n");
    s.push_str(&format!("[`{STUBS_PATH}`](../{STUBS_PATH}) declares all of the above as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations (`---@meta`), so [lua-language-server](https://luals.github.io/) completes `roster.` and checks your types, the way Neovim's `vim` annotations do. `:help plugin-types` shows it in the app. Copy it into your Plugin's folder as `types/roster.lua` (or anywhere), and point lua-language-server at it with a `.luarc.json` next to `init.lua`:\n\n```json\n{{\n  \"runtime.version\": \"Lua 5.4\",\n  \"workspace.library\": [\"types\"],\n  \"diagnostics.globals\": [\"roster\"]\n}}\n```\n\nThen annotate what you hand the app, and lua-language-server checks it:\n\n```lua\n---@type roster.Row[]\nlocal rows = {{}}\n\n---@param e roster.TerminalOutputEvent\nroster.on(\"terminal_output\", function(e) … end)\n```\n\n`lua-language-server --check .` does the same from a terminal or CI; roster's CI checks the example Plugins that way. The file is generated with this page: a copy from an older roster lacks what's new.\n\n"));
    s.push_str("## See also\n\n[Writing a Plugin](plugins.md) · [The roster serve API](serve-api.md) · [Your init.lua](app/config.md) · [How far roster bends](app/extending.md)\n");
    s
}

fn function_entry(s: &mut String, func: &Function) {
    s.push_str(&format!("### `{}`\n\n{}.", signature(func), func.summary));
    if !func.doc.is_empty() {
        s.push(' ');
        s.push_str(func.doc);
    }
    s.push_str("\n\n**Parameters**\n\n");
    if func.params.is_empty() {
        s.push_str("None.\n\n");
    } else {
        for p in func.params {
            let ty = md_type(&format!("{}{}", p.ty, if p.optional { "?" } else { "" }));
            s.push_str(&format!(
                "- `{}` ({}{}): {}\n",
                p.name,
                ty.replace("\\|", "|"),
                if p.optional { ", optional" } else { "" },
                p.doc
            ));
        }
        s.push('\n');
    }
    s.push_str("**Returns**\n\n");
    if func.returns.0.is_empty() {
        s.push_str("Nothing.\n\n");
    } else {
        s.push_str(&format!(
            "- {}: {}\n\n",
            md_type(func.returns.0).replace("\\|", "|"),
            func.returns.1
        ));
    }
    s.push_str("**Errors**\n\n");
    if func.errors.is_empty() {
        s.push_str("Only [those of every function](#errors).\n\n");
    } else {
        for (message, when) in func.errors {
            s.push_str(&format!("- `{message}`: {when}.\n"));
        }
        s.push_str("- And [those of every function](#errors).\n\n");
    }
    if !func.refused.is_empty() {
        s.push_str("**Refused by the app** (a warning notice, not an error)\n\n");
        for r in func.refused {
            s.push_str(&format!("- {r}.\n"));
        }
        s.push('\n');
    }
    s.push_str(&format!(
        "**Permission:** {} · **Since:** api {}\n\n**Example**\n\n```lua\n{}\n```\n\n",
        func.needs.text(),
        func.since,
        func.example
    ));
}

fn type_entry(s: &mut String, t: &Type) {
    s.push_str(&format!("### `{}`\n\n{}.", t.name, t.summary));
    if !t.doc.is_empty() {
        s.push_str("\n\n");
        s.push_str(t.doc);
    }
    s.push_str("\n\n");
    if !t.alias.is_empty() {
        s.push_str(&format!("One of: {}\n\n", md_type(t.alias).replace("\\|", " \\| ")));
        return;
    }
    if t.fields.is_empty() {
        s.push_str("No fields.\n\n");
        return;
    }
    s.push_str("| Field | Type | Required | Description |\n|---|---|---|---|\n");
    for fl in t.fields {
        s.push_str(&format!(
            "| `{}` | {} | {} | {} |\n",
            fl.name,
            md_type(fl.ty),
            if fl.required { "yes" } else { "no" },
            cell(fl.doc)
        ));
    }
    s.push('\n');
}

// ---------------------------------------------------------------- the stubs

fn comment_lines(text: &str) -> String {
    text.lines().map(|l| format!("--- {l}\n")).collect()
}

/// Plain text for a stub's comment: Markdown links reduced to their text.
fn plain(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let Some(mid) = rest[open..].find("](") else { break };
        let Some(close) = rest[open + mid..].find(')') else {
            break;
        };
        out.push_str(&rest[..open]);
        out.push_str(&rest[open + 1..open + mid]);
        rest = &rest[open + mid + close + 1..];
    }
    out.push_str(rest);
    out.replace('\n', " ")
}

/// examples/plugins/types/roster.lua.
pub fn stubs() -> String {
    let mut s = String::new();
    s.push_str("---@meta roster\n");
    s.push_str(&format!(
        "-- roster's Plugin API, roster.api_version {}: LuaCATS annotations for lua-language-server.\n-- Generated from crates/roster-core/src/plugin/api.rs by `{COMMAND}`; don't edit.\n-- The reference: docs/plugin-api.md (`:help plugin-api`).\n\n",
        super::API_VERSION
    ));
    for t in TYPES {
        if !t.alias.is_empty() {
            s.push_str(&comment_lines(&plain(t.summary)));
            s.push_str(&format!("---@alias roster.{} {}\n\n", t.name, lua_type(t.alias)));
            continue;
        }
        s.push_str(&comment_lines(&plain(t.summary)));
        s.push_str(&format!("---@class roster.{}\n", t.name));
        for fl in t.fields {
            let doc = plain(fl.doc);
            if fl.name.starts_with('[') {
                s.push_str(&format!("---@field {} {} {doc}\n", fl.name, lua_type(fl.ty)));
            } else {
                let q = if fl.required { "" } else { "?" };
                s.push_str(&format!("---@field {}{q} {} {doc}\n", fl.name, lua_type(fl.ty)));
            }
        }
        if t.open {
            s.push_str("---@field [string] any Any other key roster.yml gives it.\n");
        }
        s.push('\n');
    }
    s.push_str("---@class roster.module\n");
    for v in VALUES {
        let name = v.path.trim_start_matches("roster.");
        s.push_str(&format!("---@field {name} {} {}\n", lua_type(v.ty), plain(v.summary)));
    }
    s.push_str("roster = {}\n\n");
    for m in MODULES {
        if m.name != "roster" {
            s.push_str(&comment_lines(&plain(&format!("{}. {}", m.summary, m.doc))));
            s.push_str(&format!("{} = {{}}\n\n", m.name));
        }
        for func in functions_of(m.name) {
            s.push_str(&comment_lines(&plain(&format!("{}.", func.summary))));
            s.push_str(&format!(
                "--- Permission: {}. Since: api {}.\n",
                func.needs.text().replace('`', ""),
                func.since
            ));
            for p in func.params {
                let q = if p.optional { "?" } else { "" };
                s.push_str(&format!(
                    "---@param {}{q} {} {}\n",
                    p.name,
                    lua_type(p.ty),
                    plain(p.doc)
                ));
            }
            if !func.returns.0.is_empty() {
                s.push_str(&format!(
                    "---@return {} # {}\n",
                    lua_type(func.returns.0),
                    plain(func.returns.1)
                ));
            }
            if func.path == "roster.on" {
                // Each event's own payload type, for completion inside the listener.
                for e in EVENTS {
                    s.push_str(&format!(
                        "---@overload fun(event: \"{}\", listener: fun(e: {}))\n",
                        e.name,
                        lua_type(e.payload)
                    ));
                }
            }
            let names: Vec<&str> = func.params.iter().map(|p| p.name).collect();
            s.push_str(&format!("function {}({}) end\n\n", func.path, names.join(", ")));
        }
    }
    s.push_str("return roster\n");
    s
}

// ---------------------------------------------------------------- the data

/// crates/roster-core/tests/fixtures/plugin-api.json: the API as data, and the help topics.
pub fn json() -> Json {
    let mut tags = serde_json::Map::new();
    for v in VALUES {
        tags.insert(
            v.path.into(),
            json!(format!("plugin-api#{}", slug(&format!("`{}`", v.path)))),
        );
    }
    for func in FUNCTIONS {
        tags.insert(
            format!("{}()", func.path),
            json!(format!("plugin-api#{}", func_anchor(func))),
        );
    }
    for t in TYPES {
        tags.insert(
            format!("roster-{}", t.name),
            json!(format!("plugin-api#{}", slug(&format!("`{}`", t.name)))),
        );
    }
    for m in MODULES.iter().filter(|m| m.name != "roster") {
        tags.insert(
            m.name.into(),
            json!(format!("plugin-api#{}", slug(&format!("`{}`", m.name)))),
        );
    }
    let functions: Vec<Json> = FUNCTIONS
        .iter()
        .map(|func| {
            json!({
                "path": func.path,
                "params": func.params.iter().map(|p| json!({ "name": p.name, "type": p.ty, "optional": p.optional })).collect::<Vec<_>>(),
                "returns": func.returns.0,
                "permission": match func.needs { Needs::Nothing => Json::Null, Needs::Permission(p) => json!(p), Needs::AnyServe => json!("serve:*") },
                "since": func.since,
            })
        })
        .collect();
    let types: serde_json::Map<String, Json> = TYPES
        .iter()
        .map(|t| {
            let value = if t.alias.is_empty() {
                json!({ "fields": t.fields.iter().map(|fl| json!({ "name": fl.name, "type": fl.ty, "required": fl.required })).collect::<Vec<_>>(), "open": t.open })
            } else {
                json!({ "alias": t.alias })
            };
            (t.name.to_string(), value)
        })
        .collect();
    json!({
        "api_version": super::API_VERSION,
        "values": VALUES.iter().map(|v| json!({ "path": v.path, "type": v.ty })).collect::<Vec<_>>(),
        "functions": functions,
        "events": EVENTS.iter().map(|e| json!({ "name": e.name, "needs": e.needs, "payload": e.payload })).collect::<Vec<_>>(),
        "types": types,
        "tags": tags,
    })
}

/// The JSON file's text, as committed.
pub fn json_text() -> String {
    serde_json::to_string_pretty(&json()).expect("plain data") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_githubs() {
        assert_eq!(slug("`roster.inventory.host(name)`"), "rosterinventoryhostname");
        assert_eq!(slug("`roster.on(event, listener)`"), "rosteronevent-listener");
        assert_eq!(slug("roster serve's results"), "roster-serves-results");
    }

    #[test]
    fn every_type_named_is_declared_and_every_declared_one_is_used() {
        let mut used = std::collections::BTreeSet::new();
        let mut note = |ty: &str| {
            for (is_type, word) in pieces(ty) {
                if is_type {
                    used.insert(word);
                } else {
                    for w in word.split(|c: char| !c.is_alphanumeric()) {
                        assert!(
                            !w.starts_with(|c: char| c.is_uppercase()),
                            "{w} in {ty:?} isn't a declared type"
                        );
                    }
                }
            }
        };
        for v in VALUES {
            note(v.ty);
        }
        for func in FUNCTIONS {
            for p in func.params {
                note(p.ty);
            }
            note(func.returns.0);
        }
        for t in TYPES {
            note(t.alias);
            for fl in t.fields {
                note(fl.ty);
            }
        }
        for e in EVENTS {
            note(e.payload);
        }
        for r in SERVE_RESULTS {
            note(r.result);
        }
        for t in TYPES {
            assert!(
                used.contains(t.name) || ["Manifest", "EventName"].contains(&t.name),
                "{} is declared but nothing uses it",
                t.name
            );
        }
    }

    #[test]
    fn the_events_are_the_runtimes() {
        let ours: Vec<(&str, Vec<String>)> = EVENTS
            .iter()
            .map(|e| (e.name, e.needs.iter().map(|p| p.to_string()).collect()))
            .collect();
        let runtime: Vec<(&str, Vec<String>)> = super::super::EVENTS
            .iter()
            .map(|(n, needs)| (*n, needs.iter().map(|p| p.to_string()).collect()))
            .collect();
        assert_eq!(ours, runtime, "api.rs's EVENTS and runtime.rs's disagree");
        let names: Vec<String> = EVENTS.iter().map(|e| format!("\"{}\"", e.name)).collect();
        assert_eq!(type_named("EventName").unwrap().alias, names.join("|"));
    }

    #[test]
    fn the_manifest_fields_are_the_ones_it_reads() {
        let ours: Vec<&str> = type_named("Manifest")
            .unwrap()
            .fields
            .iter()
            .map(|fl| fl.name)
            .collect();
        assert_eq!(ours, super::super::MANIFEST_FIELDS);
    }

    #[test]
    fn the_theme_fields_are_init_luas() {
        let def: crate::config::ThemeDef = serde_json::from_value(json!({
            "label": "x", "appearance": "dark", "base": "nord", "colors": {}, "terminal": {}, "ansi": false
        }))
        .unwrap();
        let keys: Vec<String> = serde_json::to_value(def)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        let mut ours: Vec<String> = type_named("Theme")
            .unwrap()
            .fields
            .iter()
            .map(|fl| fl.name.to_string())
            .collect();
        ours.sort();
        let mut keys = keys;
        keys.sort();
        assert_eq!(ours, keys);
    }

    #[test]
    fn the_permissions_are_the_runtimes() {
        let ours = type_named("Permission").unwrap().alias;
        for p in [
            super::super::Permission::InventoryRead,
            super::super::Permission::InventoryWrite,
            super::super::Permission::SessionsOpen,
            super::super::Permission::TerminalRead,
            super::super::Permission::TerminalWrite,
        ] {
            assert!(ours.contains(&format!("\"{p}\"")), "{p} isn't in Permission");
        }
        for func in FUNCTIONS {
            if let Needs::Permission(p) = func.needs {
                assert!(super::super::Permission::parse(p).is_ok(), "{}: {p}", func.path);
            }
        }
    }
}
