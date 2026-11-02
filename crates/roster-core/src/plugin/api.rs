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
    /// Any `network:<site>` permission.
    AnyNetwork,
    /// Whatever lets a Plugin hear that event (any one of its [`EVENTS`] `needs`):
    /// `roster.sessions.list` is there for a Plugin that hears `session_open`.
    Hears(&'static str),
}

impl Needs {
    /// The permissions any one of which it needs, for [`Needs::Hears`] (empty otherwise).
    pub fn any_of(self) -> &'static [&'static str] {
        match self {
            Needs::Hears(event) => EVENTS.iter().find(|e| e.name == event).map_or(&[], |e| e.needs),
            _ => &[],
        }
    }

    pub fn text(self) -> String {
        match self {
            Needs::Nothing => "none".into(),
            Needs::Permission(p) => format!("`{p}`"),
            Needs::AnyServe => "`serve:<method>` (that method)".into(),
            Needs::AnyNetwork => "`network:<site>` (that site)".into(),
            Needs::Hears(_) => self
                .any_of()
                .iter()
                .map(|p| format!("`{p}`"))
                .collect::<Vec<_>>()
                .join(" or "),
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

/// A roster command a Plugin's command line may run (`roster.cmd`, and a `Run` that's a line).
pub struct CommandRule {
    /// The command's name (`finder`).
    pub name: &'static str,
    /// What the Plugin needs for it: nothing, or a permission (never [`Needs::AnyServe`]).
    pub needs: Needs,
    /// What it does, for the reference.
    pub doc: &'static str,
}

/// The commands of roster's a Plugin may run: the ones that only show something, and opening a
/// Session with `sessions.open`. Everything else (`:plugins`, `:packages`, `:publish`, `:source`,
/// the editor, the vault) is never a Plugin's to run, nor another Plugin's commands.
pub const COMMANDS: &[CommandRule] = &[
    CommandRule {
        name: "finder",
        needs: Needs::Nothing,
        doc: "Opens a finder: `finder alerts`.",
    },
    CommandRule {
        name: "view",
        needs: Needs::Nothing,
        doc: "Opens a view: `view discover`.",
    },
    CommandRule {
        name: "help",
        needs: Needs::Nothing,
        doc: "Opens a help page: `help recent-alerts`.",
    },
    CommandRule {
        name: "find",
        needs: Needs::Nothing,
        doc: "Opens the Picker.",
    },
    CommandRule {
        name: "info",
        needs: Needs::Nothing,
        doc: "Shows a Host's details: `info esx-02`.",
    },
    CommandRule {
        name: "changes",
        needs: Needs::Nothing,
        doc: "Shows the Pending changes (Publishing them stays the user's).",
    },
    CommandRule {
        name: "session",
        needs: Needs::Nothing,
        doc: "Goes to the Nth Session (`roster.sessions.show` goes by id).",
    },
    CommandRule {
        name: "next",
        needs: Needs::Nothing,
        doc: "Goes to the next Session.",
    },
    CommandRule {
        name: "prev",
        needs: Needs::Nothing,
        doc: "Goes to the previous Session.",
    },
    CommandRule {
        name: "check",
        needs: Needs::Permission("serve:host.check"),
        doc: "Runs roster's diagnostics for a Host and shows them, as `:check HOST` does: `check esx-02`. It connects to the Host, as `host.check` does.",
    },
    CommandRule {
        name: "open",
        needs: Needs::Permission("sessions.open"),
        doc: "Opens a Host: its Session, or a new one.",
    },
    CommandRule {
        name: "connect",
        needs: Needs::Permission("sessions.open"),
        doc: "Opens a Session on a Host.",
    },
];

/// roster's commands that change what it trusts or writes (grants, Packages, Publish, the config,
/// the vault): never a Plugin's own, whatever it named its commands, even before the app has told
/// the core its built-in commands (`PluginHost::set_builtins`, which covers every other one; issue
/// #184). The app refuses a Plugin's command named after any of roster's too and checks every
/// line again (`plugins/cmd.ts`).
pub const ROSTER_ONLY: &[&str] = &["plugins", "packages", "publish", "source", "config", "vault"];

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
        name: "roster.toolbar",
        summary: "Controls in the toolbar",
        doc: "A control in the title bar's toolbar (decision Q65), after roster's own by the window's buttons. It's shown unless `init.lua` picks the controls itself with `modes.<mode>.toolbar`: then it shows where that list names its id. It never takes focus from the terminal.",
    },
    Module {
        name: "roster.progress",
        summary: "Progress of something long",
        doc: "What the Plugin is doing that takes a while (a scan, a long roster serve call), shown in the status bar: how far it has got, or only that it's going, and a way to stop it. `:cancel ID` (or the button) calls its `cancel` function. Setting it any time is fine, from an event too: it changes nothing but itself.",
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
        name: "roster.views",
        summary: "Views: side panels and full views",
        doc: "A view is data the app draws in its own style: a title, text, facts and a table. `place` says where: `\"panel\"` beside the terminal (over it in Focus or a narrow window), or `\"full\"` over the whole window, as Topology is. `:view ID` opens one, and the `views` finder (`:finder views`) lists them all; bind a key to `view ID` with `roster.keymap.set`. `Esc` closes it and puts you back where you were. A table's rows are plain data, so `roster.views.update` changes some in place without sending the rest again. A view can hold a graph instead of a table: nodes, edges and clusters, also plain data, with a list of every node and edge one key away (`t`).",
    },
    Module {
        name: "roster.details",
        summary: "Sections of a Host's details",
        doc: "Your own sections in a Host's details panel (`:info HOST`), after roster's: set per Host, like a badge.",
    },
    Module {
        name: "roster.clipboard",
        summary: "The clipboard",
        doc: "",
    },
    Module {
        name: "roster.storage",
        summary: "The Plugin's own files",
        doc: "Every Plugin has a data folder of its own, in the app's data folder (next to the State; never the config folder, never on the network), and `roster.storage` reads and writes files there by name (decision Q93). No permission: it's the Plugin's own, and nothing else is reachable through it. A name is a plain file name (letters, digits, `-`, `_` and `.`, not starting with `.`; at most 100 characters), never a path, so there's no way out of the folder; a link there (a symlink, or a junction on Windows) is never followed. A write replaces the whole file at once (a temporary file, then a rename), so a crash leaves the old file or the new one, never half of one. A file holds at most 1 MB, the folder 10 MB in at most 1,000 files. The folder goes when the Plugin is removed (`:plugins remove`, or `:packages clean` for a Package), and stays across reloads, updates and revoked permissions. The time the disk takes doesn't count against the Plugin's budget.",
    },
    Module {
        name: "roster.inventory",
        summary: "Hosts, and Pending changes to them",
        doc: "`nil` unless the Plugin was granted `inventory.read` or `inventory.write`; each function is there only with its own permission. The reads but `request` wait for `roster serve`; that time doesn't count against the Plugin's budget, nor toward it being given up on. One call (a load, an event, an action, an answer) reads the Inventory once: `hosts()` and `groups()` in it share one answer of serve's, until a call into serve that can change something (a write, `mesh.cut`, …) in the same call. [`roster.inventory.request`](#rosterinventoryrequestdone) doesn't wait: prefer it where the Plugin would otherwise hold up the user, and for a big Inventory.",
    },
    Module {
        name: "roster.sessions",
        summary: "Going to Sessions, and opening them",
        doc: "Every Plugin may go to a Session the user is shown (`show`), in a call the user started; `list` is there with `inventory.read` or `terminal.read` (the permissions that hear `session_open` and `session_exit`), and `open` only with `sessions.open`.",
    },
    Module {
        name: "roster.terminal",
        summary: "Typing into Sessions",
        doc: "`nil` unless the Plugin was granted `terminal.write`. Reading what Sessions print is the `terminal_output` event (`terminal.read`).",
    },
    Module {
        name: "roster.serve",
        summary: "roster serve's methods, by name",
        doc: "`nil` unless the Plugin was granted at least one `serve:<method>` permission. roster serve answers several requests at once, but a call can still wait: for its turn (2 calls into serve at a time for each Plugin, 4 for all of them) or behind the app's own write (a Publish: a minute or two). [`roster.serve.request`](#rosterserverequestmethod-params-done) doesn't wait: prefer it in anything the user starts. A job's progress comes as the `job_progress` event (serve API 20). [`roster.serve.call`](#rosterservecallmethod-params) waits, and the user's next action in the Plugin waits behind it; the wait never counts against the Plugin.",
    },
    Module {
        name: "roster.http",
        summary: "HTTP requests to the sites the manifest lists",
        doc: "`nil` unless the Plugin was granted at least one `network:<site>` permission ([Permissions](plugins.md#permissions)). The request runs in roster's core, never in the app's window, and doesn't wait: the function you pass gets the answer later, as a call of its own with a call's budget. Only the sites granted are reached, redirects included; a name that resolves to an address on this computer or a private network is refused unless the manifest lists the address itself, or the name as a private site (`network:private:nas.lan`), which reaches only private addresses. A pinned site (`#sha256:…`) trusts only that certificate. No cookies or credentials of roster's go along, and no proxy but the user's `plugin_proxy`, through which a public name is still looked up here first and refused if it leads inside (only a name this computer can't look up at all is left to the proxy). At most 4 requests at once, a 256 KB body out, a 1 MB body back, 30 seconds each.",
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
        example: "roster.notify(roster.plugin.name .. \" \" .. roster.plugin.version)\nlocal leader = roster.plugin.config.leader or \"w w\"",
    },
];

/// What `roster.storage`'s functions raise (decision Q93).
const STORAGE_ERRORS: &[(&str, &str)] = &[
    (
        "roster.storage.FN: \"NAME\" isn't a file name: letters, digits, - _ and . only, …",
        "a path (`a/b`, `../x`, `C:\\x`), a name starting with `.`, or other characters",
    ),
    (
        "roster.storage.FN: NAME is a link: roster won't follow it",
        "the file was made a link (a symlink, a junction): it's never followed",
    ),
    (
        "roster.storage.FN: the Plugin's data folder is a link …",
        "its folder was made a link: it's never followed",
    ),
    (
        "roster.storage.FN: there's no data folder for Plugins here",
        "the app has no data folder (a test, say)",
    ),
];

/// What `roster.storage.write` raises.
const STORAGE_WRITE_ERRORS: &[(&str, &str)] = &[
    (
        "roster.storage.write: NAME would be N bytes: a file holds at most 1 MB (1048576 bytes)",
        "the text is longer",
    ),
    (
        "roster.storage.write: the Plugin's data folder holds at most 10 MB …",
        "the folder would hold more (a file replaced counts only its new size)",
    ),
    (
        "roster.storage.write: the Plugin's data folder holds at most 1000 files",
        "a new file past the thousandth",
    ),
    (
        "roster.storage.write: \"NAME\" isn't a file name: …",
        "as `roster.storage.read`",
    ),
    (
        "roster.storage.write: NAME is a link: roster won't follow it",
        "as `roster.storage.read`",
    ),
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
            opt(
                "opts",
                "NoticeOptions",
                "Buttons on the notice (since api 3): `{ actions = { { label = \"Show the plan\", run = \"view mesh-plan\" } } }`; whether an info notice is quiet (since api 4): `{ quiet = false }`.",
            ),
        ],
        summary: "Shows a notice, naming the Plugin",
        doc: "Warnings and errors always show. An info notice is quiet by default, as roster's own routine messages are (`ui.messages`, like Neovim's): unless `ui.messages = \"all\"`, it isn't drawn, a screen reader still hears it and `:messages` keeps it. An info notice with buttons shows, and `quiet` decides either way: mark `quiet = false` on what the user asked for: the result of something they started (\"Scan done: 12 Hosts answered, 3 new\"), an answer (\"No alerts\") or a refusal (\"Keep a Host first\"), and leave it out for a routine confirmation (\"Copied the line\"). Every notice, shown or quiet, is in `:messages`.\n\nA notice's button runs a command line when the user clicks it, as [`roster.cmd`](#rostercmdline) would: the click is the user's call, so `view ID` opens your view when a job that ran in the background has finished (a Plugin can't open one on its own, from a timer or an answer). It takes a command line, not a function, so a notice never holds on to one.",
        returns: ("", ""),
        errors: &[
            (
                "roster.notify: the level is \"info\", \"warn\" or \"error\"",
                "`level` is something else",
            ),
            (
                "roster.notify: actions… (a notice's action runs a command line, not a function)",
                "a function in `opts`",
            ),
            (
                "roster.notify: quiet is true or false",
                "`opts.quiet` is something else",
            ),
        ],
        refused: &["more than 2 actions, or one whose `run` isn't a command line"],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.notify(\"Copied esx-02's address\") -- quiet unless ui.messages = \"all\"\nroster.notify(\"leader: not a key sequence, using w w\", \"warn\")\nroster.notify(\"Plan ready: 4 Hosts change\", \"info\", { actions = { { label = \"Show the plan\", run = \"view mesh-plan\" } } })\nroster.notify(\"Scan done: 12 Hosts found\", \"info\", { quiet = false })",
    },
    Function {
        path: "roster.on",
        params: &[
            p(
                "event",
                "EventName",
                "The event's name: `lock`, `unlock`, `host_selected`, `session_open`, `session_exit`, `inventory_changed`, `terminal_output`, `command_done` or `job_progress`.",
            ),
            p(
                "listener",
                "fun(e: table)",
                "Runs with the event's payload (see [Events](#events)) each time it happens. Its return value is ignored.",
            ),
        ],
        summary: "Runs a function on an event",
        doc: "Several listeners for one event run in the order they were added. There's no way to stop listening short of `:plugins reload`. Ask [`roster.has`](#rosterhaspermission) first for an event that needs a permission.",
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
        path: "roster.confirm",
        params: &[p(
            "question",
            "Confirm",
            "What to ask, the button that confirms, and what runs when the user does.",
        )],
        summary: "Asks the user to confirm, then runs a function",
        doc: "The app draws the question in its own style, with your Plugin's name on it, and only the user answers it: `run` is called when they confirm, `cancel` (if any) when they don't (`Esc` or Cancel, or another Plugin's question taking its place, which isn't a call the user started). Nothing a Plugin does can answer it or draw one of its own. Only while the user runs one of your actions, commands or finder items, so a question never comes up on its own. With `danger`, it's the stronger form for what can't be undone easily (a Mesh Cut): the confirming button is the danger colour and the keys start on Cancel, so a stray `Enter` only declines; with `typed` too, the user types that word (a Host's name) before the button works. Asking again replaces the question: the earlier one's `cancel` isn't called (your Plugin asked the new one, so it knows), and its functions are dropped.",
        returns: ("", ""),
        errors: &[
            (
                "roster.confirm: only while the user runs one of your actions, commands or finder items",
                "at load or in an event listener",
            ),
            (
                "roster.confirm: `run` must be a function: what happens when the user confirms",
                "`run` is missing or a command line",
            ),
        ],
        refused: &["a field of the wrong kind (`roster.confirm: action must be text`): nothing is asked"],
        needs: Needs::Nothing,
        since: 3,
        example: "actions = { { label = \"Cut\", key = \"x\", run = function(e)\n  roster.confirm({\n    title = \"Cut \" .. e.host .. \" from the Mesh?\",\n    text = \"Its key is taken off every Host it can reach.\",\n    action = \"Cut\",\n    danger = true,\n    typed = e.host,\n    run = function() roster.serve.call(\"mesh.cut\", { host = e.host }) end,\n  })\nend } }",
    },
    Function {
        path: "roster.cmd",
        params: &[p(
            "line",
            "string",
            "A command line, as typed after `:` (`\"finder alerts\"`).",
        )],
        summary: "Runs a command line",
        doc: "It runs after the call returns, as if the user typed it. Only while the user runs one of your actions, commands or finder items, and only your own commands and the few of roster's in [Command lines a Plugin may run](#command-lines-a-plugin-may-run), each with the permission it needs there: never `:plugins`, `:packages`, `:publish` or anything else that changes what's installed, granted or written. One of your commands it runs is the user's call carried one hop, as a [`roster.serve.request`](#rosterserverequestmethod-params-done)'s answer is: it may copy, ask or answer on the message line, but a `roster.cmd` or a request made in it (or in such an answer) doesn't carry the call further, so the command that line names runs as the app's call and can't.",
        returns: ("", ""),
        errors: &[
            (
                "roster.cmd: only while the user runs one of your actions, commands or finder items",
                "at load or in an event listener",
            ),
            ("roster.cmd: which command? …", "an empty line"),
            (
                "roster.cmd: :NAME isn't one a Plugin may run (its own commands, and …)",
                "a command not in the list, another Plugin's, or one of yours named after one of roster's",
            ),
            (
                "roster.cmd: :NAME can't run yet: the app hasn't told roster its own commands",
                "one of your commands, in the moment before the app has said which are roster's (it tries again)",
            ),
            (
                "roster.cmd: :NAME needs the P permission",
                "`:open` or `:connect` without `sessions.open`",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.commands.add(\"alerts\", { run = function(a)\n  if a.words[1] == nil then roster.cmd(\"finder alerts\") end\nend })",
    },
    Function {
        path: "roster.echo",
        params: &[
            p("text", "string", "What to say, on one line."),
            opt(
                "opts",
                "EchoOptions",
                "`{ quiet = true }` for a routine confirmation (since api 4).",
            ),
        ],
        summary: "Answers on the message line, as roster's own commands do",
        doc: "For what a command did or found: the line at the bottom of the window that roster's own commands answer on, not a notice to close. Only while the user runs one of your actions, commands or finder items, so it always answers something they did. Use [`roster.notify`](#rosternotifytext-level-opts) for anything else.\n\nIt follows `ui.messages` as roster's own messages do (like Neovim's): what went wrong (\"No Host named nope-01\") and the answer to what was asked (\"3 alerts\") always show, so a plain `roster.echo` shows. Mark a routine confirmation, when nothing went wrong (\"Added esx-02 to Lab\"), with `{ quiet = true }`: unless `ui.messages = \"all\"`, it isn't drawn, a screen reader still hears it and `:messages` keeps it.",
        returns: ("", ""),
        errors: &[
            (
                "roster.echo: only while the user runs one of your actions, commands or finder items",
                "at load, in an event listener or a timer",
            ),
            ("roster.echo: quiet is true or false", "`opts.quiet` is something else"),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.commands.add(\"alerts\", { run = function(a)\n  if a.words[1] == \"clear\" then alerts = {} roster.echo(\"Cleared the alerts\", { quiet = true })\n  elseif a.words[1] == nil then roster.echo(#alerts .. \" alerts\")\n  else roster.echo(\"alerts takes clear\") end\nend })",
    },
    Function {
        path: "roster.cmdline",
        params: &[p(
            "text",
            "string",
            "The start of a line for one of your commands (`\"folder new \"`); the user finishes it.",
        )],
        summary: "Opens the command line with text typed in",
        doc: "For a command that needs one more word from the user: it opens the command line with `text` in it and the cursor at its end, and Tab completes the rest with your command's `complete`. Nothing runs until the user presses Enter. Only your own commands, and only while the user runs one of your actions, commands or finder items.",
        returns: ("", ""),
        errors: &[
            (
                "roster.cmdline: only while the user runs one of your actions, commands or finder items",
                "at load, in an event listener or a timer",
            ),
            (
                "roster.cmdline: \"WORD\" isn't one of your commands …",
                "the line starts with anything but one of the Plugin's commands",
            ),
            (
                "roster.cmdline: :NAME can't run yet: the app hasn't told roster its own commands",
                "as `roster.cmd`'s",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.commands.add(\"note\", { run = function(a)\n  if a.args == \"\" then return roster.cmdline(\"note \") end\n  roster.storage.write(\"note.txt\", a.args)\nend })",
    },
    Function {
        path: "roster.has",
        params: &[p(
            "permission",
            "string",
            "A permission's name: `\"terminal.read\"`, `\"serve:mesh.status\"`.",
        )],
        summary: "Whether the Plugin was granted a permission",
        doc: "Ask before you use what a permission gives: listening for an event the Plugin may not hear is an error, and a module it wasn't granted is `nil`. `roster.has(\"network:api.example.com\")` asks about that one site, and a bare `roster.has(\"network\")` whether any site was granted (whether `roster.http` is there). One that can't be granted here (a serve method roster doesn't allow, a site that isn't one) is `false`, so you can ask about what a newer roster has.",
        returns: ("boolean", "`true` when it's granted (and not revoked in `:plugins`)."),
        errors: &[(
            "roster.has: \"NAME\" isn't a permission (there's …)",
            "a name that's no permission at all (a typo)",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "if roster.has(\"terminal.read\") then\n  roster.on(\"terminal_output\", function(e) end)\nelse\n  roster.notify(\"allow terminal.read in :plugins to see alerts\", \"warn\")\nend",
    },
    Function {
        path: "roster.defer",
        params: &[
            p(
                "ms",
                "number",
                "How long to wait, in milliseconds: at least 50 (less waits 50), at most 2,147,483,647.",
            ),
            p(
                "fn",
                "fun()",
                "What to run then, in the Plugin, with the budget of a call.",
            ),
        ],
        summary: "Runs a function once, later",
        doc: "The app keeps the clock and runs `fn` on the Plugin's own thread when it's time, as it runs an action, except that it isn't something the user started (so `roster.clipboard.copy` refuses). An error in it counts toward stopping the Plugin. Timers end with the Plugin: unloading, reloading or disabling it cancels every one. At most 100 timers wait at once.",
        returns: ("Timer", "Its id, for `roster.cancel`."),
        errors: &[
            (
                "roster.defer: ms must be a number of milliseconds from 0 to …",
                "a negative, infinite or huge `ms`",
            ),
            (
                "roster.defer: more than 100 timers waiting at once …",
                "too many timers",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.defer(5000, function()\n  roster.status.remove(\"saved\")\nend)",
    },
    Function {
        path: "roster.every",
        params: &[
            p(
                "ms",
                "number",
                "How long between runs, in milliseconds: at least 1,000.",
            ),
            p("fn", "fun()", "What to run each time, in the Plugin."),
        ],
        summary: "Runs a function again and again, until it's cancelled",
        doc: "The first run is `ms` from now. The next wait starts when a run has finished, so a slow run never piles up behind itself. Everything else is as `roster.defer`: on the Plugin's own thread, cancelled with the Plugin.",
        returns: ("Timer", "Its id, for `roster.cancel`."),
        errors: &[
            ("roster.every: at least 1000 ms between runs …", "a shorter `ms`"),
            (
                "roster.every: ms must be a number of milliseconds from 0 to …",
                "a negative, infinite or huge `ms`",
            ),
            (
                "roster.every: more than 100 timers waiting at once …",
                "too many timers",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "-- \"2 min ago\" stays true.\nroster.every(30000, show)",
    },
    Function {
        path: "roster.cancel",
        params: &[p("timer", "Timer", "What `roster.defer` or `roster.every` returned.")],
        summary: "Cancels a timer",
        doc: "A timer that already ran (a deferred one) or was cancelled is nothing to cancel: that's not an error. A repeating timer may cancel itself from its own function.",
        returns: ("", ""),
        errors: &[(
            "roster.cancel: a timer, as roster.defer or roster.every returned it",
            "something else",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "local t = roster.every(60000, refresh)\nroster.commands.add(\"stop\", { run = function() roster.cancel(t) end })",
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
        errors: &[(
            "roster.commands.remove: \"NAME\" isn't a name like …",
            "a bad `name` (since api 3)",
        )],
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
                "A command line: one of the Plugin's commands or one of the app's that [`roster.cmd`](#rostercmdline) may run (`\"finder alerts\"`). `false` is deprecated: it takes the Plugin's binding off, as [`roster.keymap.del`](#rosterkeymapdelcontext-keys) does.",
            ),
        ],
        summary: "Binds keys to a command line",
        doc: "Never in the terminal. A function isn't an action: add a command and bind its name. The key runs its line as `:plugins run NAME LINE` (which `:keys` shows), checked each time as a button's line is: never `:plugins`, `:packages`, `:source` or another Plugin's command, and a command that needs a permission only while it's granted.",
        returns: ("", ""),
        errors: &[(
            "roster.keymap.set: the action is a command line such as \"alerts\" (add a command for a function)",
            "`action` isn't a string or `false`",
        )],
        refused: &[
            "a `context` other than the three (`keys go after the Leader or in the Sidebar …`)",
            "keys bound already, by roster, `init.lua` or another Plugin (`a` is Folders', `f` the Picker's; `:keys` lists them): the notice names what has them and up to three free ones like them (`␣ f is taken (by builtin: find). Free after the Leader: a, g, h`)",
            "keys that would hide a binding, or be hidden by one (`\"a z\"` when `a` is bound)",
            "when pressed, a line `roster.cmd` couldn't run (`:plugins grant …`, another Plugin's command): a notice says why",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.keymap.set(\"leader\", roster.plugin.config.leader or \"w w\", \"finder alerts\")",
    },
    Function {
        path: "roster.keymap.del",
        params: &[
            p("context", "KeyContext", "Where it was bound."),
            p("keys", "string", "The keys, as `set` took them."),
        ],
        summary: "Takes one of the Plugin's key bindings off",
        doc: "Keys it didn't bind stay as they are: a Plugin can't unbind roster's, `init.lua`'s or another Plugin's.",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.keymap.del(\"leader\", \"w w\")",
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
        path: "roster.themes.remove",
        params: &[p("id", "string", "One of the Plugin's Themes.")],
        summary: "Removes one of the Plugin's Themes",
        doc: "Removing one it doesn't have does nothing. If it was the Theme in use, the app goes back to `init.lua`'s.",
        returns: ("", ""),
        errors: &[("roster.themes.remove: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.themes.remove(\"dusk\")",
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
        errors: &[(
            "roster.sidebar.remove: \"ID\" isn't a name like …",
            "a bad `id` (since api 3)",
        )],
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
        errors: &[(
            "roster.status.remove: \"ID\" isn't a name like …",
            "a bad `id` (since api 3)",
        )],
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
        errors: &[(
            "roster.finders.remove: \"ID\" isn't a name like …",
            "a bad `id` (since api 3)",
        )],
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
        errors: &[(
            "roster.help.remove: \"TOPIC\" isn't a name like …",
            "a bad `topic` (since api 3)",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.help.remove(\"pinned\")",
    },
    Function {
        path: "roster.health.set",
        params: &[
            p("id", "string", "The section's id."),
            p(
                "section",
                "HealthSection",
                "Its title, and its checks or the function that makes them.",
            ),
        ],
        summary: "Adds a section to `:check` (this Box's health), or replaces it",
        doc: "Like Neovim's `vim.health`: with `check`, each `:check` calls it and shows the lines it returns, under the Plugin's name on `:help health`. It runs with the Plugin's permissions and the time budget of any call (a quarter of a second), but it isn't a call the user started (no clipboard, questions, command lines or flagged serve methods in it); one that fails or doesn't answer in time is an `ERROR` line of its section, and `:check` goes on without it. With `checks` and no `check`, `:check` shows them as the Plugin last set them.",
        returns: ("", ""),
        errors: &[("roster.health.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a section with that id from elsewhere",
            "a check whose `level` isn't `ok`, `warn` or `error`, or without a `message`",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.health.set(\"recent-alerts\", {\n  title = \"Recent alerts\",\n  check = function()\n    if not granted(\"terminal.read\") then\n      return { { level = \"warn\", message = \"terminal.read isn't granted\", fix = \"Allow it in :plugins\" } }\n    end\n    return { { level = \"ok\", message = #alerts .. \" alerts so far\" } }\n  end,\n})",
    },
    Function {
        path: "roster.health.answer",
        params: &[
            p(
                "check",
                "integer",
                "The `check` field of what the section's `check` was called with.",
            ),
            p("lines", "HealthCheck[]", "The section's lines for that run."),
        ],
        summary: "Answers a `:check` section's check that returned `\"later\"`",
        doc: "A `check` that needs roster serve returns `\"later\"` at once and answers with this from the request's `done`, so it never waits for serve on the Plugin's thread. The app shows the section once it answers, or an `ERROR` line if it hasn't within 30 seconds; an answer for a run that's over (answered, or timed out) is dropped. Any run of the Plugin may answer, not only a call the user started.",
        returns: ("", ""),
        errors: &[("roster.health.answer: lines: …", "lines that aren't plain data")],
        refused: &["lines whose `level` isn't `ok`, `warn` or `error`, or without a `message`"],
        needs: Needs::Nothing,
        since: 3,
        example: "check = function(e)\n  roster.serve.request(\"discover.plan\", { targets = { \"10.0.0.0/30\" } }, function(plan, err)\n    roster.health.answer(e.check, plan and { { level = \"ok\", message = \"scans with \" .. plan.scanner } }\n      or { { level = \"error\", message = err } })\n  end)\n  return \"later\"\nend",
    },
    Function {
        path: "roster.health.remove",
        params: &[p("id", "string", "One of the Plugin's sections.")],
        summary: "Removes a `:check` section",
        doc: "",
        returns: ("", ""),
        errors: &[(
            "roster.health.remove: \"ID\" isn't a name like …",
            "a bad `id` (since api 3)",
        )],
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
        doc: "`:tutor ID` runs it on the demo Inventory, where the Plugin is loaded too, with the permissions the user granted it, so a step can wait for the Plugin's own command and the command works there. On the demo, `roster.inventory` sees the demo's Hosts, roster serve answers only `hosts.list` and `host.get`, `roster.http` requests are never sent (their function hears why), and `roster.storage` is a throwaway folder that starts empty.",
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
        errors: &[(
            "roster.tutor.remove: \"ID\" isn't a name like …",
            "a bad `id` (since api 3)",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.tutor.remove(\"pinned\")",
    },
    Function {
        path: "roster.toolbar.set",
        params: &[
            p(
                "id",
                "string",
                "The control's id: a name like `scan`, which `modes.<mode>.toolbar` can list.",
            ),
            p(
                "control",
                "ToolbarControl",
                "Its label, icon or word, and what it runs.",
            ),
        ],
        summary: "Adds a control to the toolbar, or replaces it",
        doc: "",
        returns: ("", ""),
        errors: &[("roster.toolbar.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a control with that id from elsewhere (roster's own: `find`, `add`, …)",
            "a field of the wrong kind",
        ],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.toolbar.set(\"scan\", { label = \"Scan a network\", text = \"Scan\", icon = \"map\", run = \"discover\" })",
    },
    Function {
        path: "roster.toolbar.remove",
        params: &[p("id", "string", "One of the Plugin's controls.")],
        summary: "Removes a toolbar control",
        doc: "",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.toolbar.remove(\"scan\")",
    },
    Function {
        path: "roster.progress.set",
        params: &[
            p("id", "string", "A name like `scan`: `:cancel scan` cancels it."),
            p(
                "progress",
                "Progress",
                "What's going on, how far it has got, and how to stop it.",
            ),
        ],
        summary: "Shows or updates the progress of something long",
        doc: "With `done` and `total` it shows how far it has got; without, only that it's going. Set it again as it moves on, and `roster.progress.remove` it when it's over. With `cancel`, the user can stop it: the app calls the function once and shows \"Stopping…\" until you set or remove it again.",
        returns: ("", ""),
        errors: &[("roster.progress.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a progress with that id from another Plugin",
            "a field of the wrong kind",
        ],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.progress.set(\"scan\", {\n  title = \"Scanning 10.0.0.0/24\",\n  done = 40, total = 256,\n  cancel = function() roster.serve.call(\"discover.stop\") end,\n})",
    },
    Function {
        path: "roster.progress.remove",
        params: &[p("id", "string", "One of the Plugin's progresses.")],
        summary: "Takes a progress away: it's over",
        doc: "Say how it ended with `roster.notify` or in your view.",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.progress.remove(\"scan\")\nroster.notify(\"Scan done: 12 Hosts found\")",
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
        doc: "It lies over the terminal, on the side away from the Sidebar, so it never resizes a Session. `Esc` closes it. Its actions are buttons at its foot (with a key each, once it has focus), and its links open in the browser, the address shown with them.",
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
        path: "roster.views.set",
        params: &[
            p(
                "id",
                "string",
                "The view's id: a name like `discover`. `:view ID` opens it.",
            ),
            p(
                "view",
                "View",
                "Where it goes, its title, text, facts, and a table or a graph.",
            ),
        ],
        summary: "Adds a view, or replaces it",
        doc: "Setting it again replaces the whole view and drops the functions its old table held; an open view stays open and keeps its selected row. It doesn't open the view: `:view ID`, a key bound to `view ID`, the `views` finder or `roster.views.open` in one of your actions does.",
        returns: ("", ""),
        errors: &[("roster.views.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a view with that id from elsewhere",
            "a field of the wrong kind (`roster.views.set discover table row 2: id must be text`): the whole view is dropped",
            "an action key the table uses itself (`j`, `k`, `g`, `G`, `s`, `S`, `/`, `?`, `q`) or one used twice",
            "a graph's action key the graph uses itself (`h` `j` `k` `l` `H` `J` `K` `L` `g` `G` `n` `N` `o` `O` `t` `f` `m` `s` `S` `/` `?` `q` `+` `-` `=` `0`), a graph action's `when` naming what a node doesn't have (`when.colour: a node has no colour`), a node or cluster id used twice, an edge id used twice, or a table and a graph in one view",
        ],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.views.set(\"discover\", {\n  title = \"Discover\",\n  place = \"panel\",\n  text = \"Scanning 10.0.0.0/24\",\n  table = {\n    columns = {\n      { id = \"address\", label = \"Address\", kind = \"data\" },\n      { id = \"ports\", label = \"Ports\", kind = \"number\" },\n    },\n    rows = {},\n    sort = \"address\",\n    empty = \"Nothing found yet.\",\n    actions = {\n      { label = \"Keep\", key = \"a\", icon = \"add\", run = function(e) keep(e.row) end },\n    },\n  },\n})",
    },
    Function {
        path: "roster.views.update",
        params: &[
            p("id", "string", "One of the Plugin's views."),
            p(
                "changes",
                "ViewUpdate",
                "What changes: rows to add or replace, rows to take away, and the text or facts.",
            ),
        ],
        summary: "Changes some of a view's rows or nodes in place, or its text or facts",
        doc: "A row whose `id` is in the table already is replaced where it stands; a new one goes at the end (the table's sort still applies). The rest stay as they are, and so does the selection, so a scan can add what it finds as it finds it. Plain data only: the table's functions stay those `roster.views.set` gave. A graph's nodes, edges and clusters work the same way, by `id`: a node that turns live, or an edge that appears, changes where it stands, and every placed node keeps its place.",
        returns: ("", ""),
        errors: &[
            ("roster.views.update: \"ID\" isn't a name like …", "a bad `id`"),
            (
                "roster.views.update \"ID\": … (an update is plain data: functions go in roster.views.set)",
                "a function in `changes`",
            ),
        ],
        refused: &[
            "a view the Plugin hasn't set",
            "rows for a view without a table",
            "more than 10,000 rows in the table after the update",
            "nodes, edges or clusters for a view without a graph",
            "more than 5,000 nodes, 10,000 edges or 500 clusters in the graph after the update",
        ],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.views.update(\"discover\", {\n  text = \"Scanning 10.0.0.0/24: 40%\",\n  rows = { { id = \"10.0.0.7\", cells = { address = \"10.0.0.7\", ports = 2 } } },\n  remove = { \"10.0.0.9\" },\n})",
    },
    Function {
        path: "roster.views.open",
        params: &[
            p("id", "string", "One of the Plugin's views."),
            opt(
                "opts",
                "ViewOpenOptions",
                "Where it opens (since api 4): `{ select = \"esx-02\" }` selects that node of its graph or row of its table.",
            ),
        ],
        summary: "Opens a view",
        doc: "Only while the user runs one of the Plugin's actions, commands or finder items, so a Plugin never takes the screen on its own. One view is open at a time: this replaces the one that is.\n\nWith `select`, it opens at that node or row: a graph opens the node's cluster if it's collapsed and centres the node, a table scrolls to the row. Asked again while the view is open, it starts afresh at the new one. An id the view doesn't have opens it as without `select`. A Host-details section's action can so open a graph at its Host's node.",
        returns: ("", ""),
        errors: &[
            ("roster.views.open: \"ID\" isn't a name like …", "a bad `id`"),
            (
                "roster.views.open: opts is a table, as { select = ID }",
                "`opts` isn't a table",
            ),
            (
                "roster.views.open: select is the id of a node or row (a string)",
                "`select` isn't a string",
            ),
            (
                "roster.views.open: only while the user runs one of your actions, commands or finder items",
                "at load or in an event listener",
            ),
        ],
        refused: &["a view the Plugin hasn't set"],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.commands.add(\"discover\", { desc = \"Scan a network\", run = function()\n  roster.views.open(\"discover\")\nend })\n-- A Host-details section's button: the map, at that Host.\nroster.details.set(\"reach\", \"esx-02\", { title = \"Reach\", facts = {}, actions = {\n  { label = \"Show on the map\", icon = \"map\", run = function(e) roster.views.open(\"topology\", { select = e.host }) end },\n} })",
    },
    Function {
        path: "roster.views.close",
        params: &[p("id", "string", "One of the Plugin's views.")],
        summary: "Closes a view, if it's open",
        doc: "Focus goes back where it was, as with `Esc`. Another view, or one that isn't open, stays as it is.",
        returns: ("", ""),
        errors: &[("roster.views.close: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.views.close(\"discover\")",
    },
    Function {
        path: "roster.views.remove",
        params: &[p("id", "string", "One of the Plugin's views.")],
        summary: "Removes a view",
        doc: "It closes if it's open, and its functions are dropped.",
        returns: ("", ""),
        errors: &[("roster.views.remove: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.views.remove(\"discover\")",
    },
    Function {
        path: "roster.details.set",
        params: &[
            p("id", "string", "The section's id: a name like `mesh`."),
            p("host", "string", "The Host's name in the Inventory."),
            opt(
                "section",
                "DetailsSection",
                "Its title, text, facts and table; `nil` takes this Host's away.",
            ),
        ],
        summary: "Adds a section to a Host's details, or replaces it",
        doc: "One section per id per Host; setting it again for the Host replaces it and drops the functions its old table held (other Hosts' stay). A name that isn't a Host shows nowhere. A table's action gets the Host too (`e.host`).",
        returns: ("", ""),
        errors: &[("roster.details.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a section with that id from another Plugin",
            "a field of the wrong kind: that Host's section is dropped",
        ],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.details.set(\"mesh\", \"esx-02\", {\n  title = \"Mesh\",\n  facts = { { label = \"reach\", value = \"can reach 7 Hosts\" } },\n})",
    },
    Function {
        path: "roster.details.remove",
        params: &[p("id", "string", "One of the Plugin's sections.")],
        summary: "Removes a section from every Host's details",
        doc: "",
        returns: ("", ""),
        errors: &[("roster.details.remove: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.details.remove(\"mesh\")",
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
        path: "roster.storage.read",
        params: &[p("name", "string", "The file's name (`\"folders.json\"`).")],
        summary: "Reads one of the Plugin's files",
        doc: "",
        returns: ("string?", "What the file holds, or `nil` when there's no such file."),
        errors: STORAGE_ERRORS,
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "local seen = roster.storage.read(\"seen.txt\") or \"\"",
    },
    Function {
        path: "roster.storage.write",
        params: &[
            p("name", "string", "The file's name."),
            p("text", "string", "What it holds from now on, at most 1 MB (any bytes)."),
        ],
        summary: "Writes one of the Plugin's files, whole",
        doc: "Makes the file, or replaces what it held, all at once: a crash leaves the old content or the new, never half.",
        returns: ("", ""),
        errors: STORAGE_WRITE_ERRORS,
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.storage.write(\"seen.txt\", table.concat(lines, \"\\n\"))",
    },
    Function {
        path: "roster.storage.list",
        params: &[],
        summary: "The names of the Plugin's files",
        doc: "",
        returns: ("string[]", "In name order; `{}` before the first write."),
        errors: &[(
            "roster.storage.list: the Plugin's data folder is a link …",
            "its folder was made a link: it's never followed",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "for _, name in ipairs(roster.storage.list()) do roster.notify(name) end",
    },
    Function {
        path: "roster.storage.remove",
        params: &[p("name", "string", "The file's name.")],
        summary: "Removes one of the Plugin's files",
        doc: "",
        returns: ("boolean", "`true` if it was there."),
        errors: STORAGE_ERRORS,
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.storage.remove(\"cache.json\")",
    },
    Function {
        path: "roster.storage.read_json",
        params: &[p("name", "string", "The file's name.")],
        summary: "Reads one of the Plugin's files as JSON",
        doc: "Objects and arrays become tables, `null` becomes `nil`.",
        returns: ("any", "The value, or `nil` when there's no such file."),
        errors: &[
            (
                "roster.storage.read_json: NAME isn't JSON (…)",
                "the file holds something else",
            ),
            ("roster.storage.read_json: …", "as `roster.storage.read`"),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "local state = roster.storage.read_json(\"state.json\") or { hosts = {} }",
    },
    Function {
        path: "roster.storage.write_json",
        params: &[
            p("name", "string", "The file's name."),
            p(
                "value",
                "any",
                "Plain data: tables, text, numbers and booleans (no functions).",
            ),
        ],
        summary: "Writes one of the Plugin's files as JSON, whole",
        doc: "As `roster.storage.write`, with the value as indented JSON. An empty table is written as `{}` (Lua can't tell an empty list from an empty table).",
        returns: ("", ""),
        errors: &[
            (
                "roster.storage.write_json: a Lua function can't go to roster serve",
                "the value holds a function (or another value that isn't data)",
            ),
            ("roster.storage.write_json: …", "as `roster.storage.write`"),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.storage.write_json(\"state.json\", { hosts = { \"esx-02\" } })",
    },
    Function {
        path: "roster.inventory.hosts",
        params: &[],
        summary: "Every Host, in `roster.yml` order",
        doc: "From serve's [`hosts.list`](serve-api.md): while `roster.yml` doesn't load (an outside edit), the last good Hosts. The groups are [`roster.inventory.groups()`](#rosterinventorygroups), from the same answer when it's called in the same call (since api 4). [`roster.inventory.request`](#rosterinventoryrequestdone) asks without waiting.",
        returns: (
            "Host[]",
            "The Hosts, each with its Login references (a vault item's name, never a password; a `cmd:` or `env:` one cut to its kind).",
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
        doc: "From serve's [`host.get`](serve-api.md). An unknown name is `nil` (since api 3; it was an error in api 2).",
        returns: ("Host?", "The Host, or `nil` when no Host has that name."),
        errors: &[(
            "roster.inventory.host: MESSAGE (code N)",
            "roster serve failed otherwise",
        )],
        refused: &[],
        needs: Needs::Permission("inventory.read"),
        since: 2,
        example: "local h = roster.inventory.host(name)\nif h then roster.notify(name .. \" is \" .. h.ip) end",
    },
    Function {
        path: "roster.inventory.groups",
        params: &[],
        summary: "Every group, by name",
        doc: "From serve's [`hosts.list`](serve-api.md), as `roster.inventory.hosts()` is: called in the same call as `hosts()`, it uses that answer rather than read the Inventory again (since api 4; a call into serve that can change something in between, a write or `mesh.cut`, reads it again). A Host's `group` names one of them.",
        returns: ("table<string, Group>", "The groups, by name."),
        errors: &[(
            "roster.inventory.groups: MESSAGE (code N)",
            "roster serve failed (see [Errors](#errors))",
        )],
        refused: &[],
        needs: Needs::Permission("inventory.read"),
        since: 3,
        example: "local groups = roster.inventory.groups()\nfor _, h in ipairs(roster.inventory.hosts()) do\n  local g = groups[h.group]\n  roster.notify(h.name .. \" is in \" .. (g and g.title ~= \"\" and g.title or h.group))\nend",
    },
    Function {
        path: "roster.inventory.request",
        params: &[p(
            "done",
            "fun(list: HostList?, err: string?)",
            "Runs once with the answer: every Host and group (`list.hosts`, `list.groups`), or `nil` and why (`roster.inventory.request: MESSAGE (code N)`). Its return value is ignored; an error in it counts like an action's.",
        )],
        summary: "Reads every Host and group without waiting: `done` gets them",
        doc: "Serve's [`hosts.list`](serve-api.md), asked as [`roster.serve.request`](#rosterserverequestmethod-params-done) asks: it returns at once and `done` runs later on the Plugin's thread, as a call of its own, so the Plugin keeps answering the user while roster serve is busy (a Publish holds `roster.yml` for a minute or two). Its answer carries the user's call as a `roster.serve.request`'s does. It counts toward the 8 requests a Plugin may have waiting, and needs no `serve:` permission. A `cmd:` or `env:` Login reference is cut to its kind, as in every read.",
        returns: ("", ""),
        errors: &[(
            "roster.inventory.request: 8 requests are waiting for roster serve already: wait for one to answer",
            "8 `roster.serve.request` and `roster.inventory.request` calls haven't answered yet",
        )],
        refused: &[],
        needs: Needs::Permission("inventory.read"),
        since: 4,
        example: "roster.inventory.request(function(list, err)\n  if not list then return roster.notify(err, \"warn\") end\n  roster.status.set(\"hosts\", { text = #list.hosts .. \" Hosts\" })\nend)",
    },
    Function {
        path: "roster.inventory.update",
        params: &[
            p("host", "string", "The Host's exact name."),
            p("changes", "Change", "The fields to change, and their new values."),
        ],
        summary: "Changes a Host's fields, as a Pending change",
        doc: "serve's [`host.update`](serve-api.md#editing-pending-changes): `roster.yml` is edited as text (comments and every other entry stay) and the change waits for you to review and Publish it. A change to `ip`, `user`, `port` or `auth` needs a test login of exactly those values first (`host.verify_login`), which a Plugin can't make: from a Plugin those fail with code 75. Only `title`, `description` and `type` go through. Only while the user runs one of your actions, commands or finder items (decision Q100).",
        returns: ("UpdateResult", "What was written."),
        errors: &[
            (
                "roster.inventory.update: only while the user runs one of your actions, commands or finder items",
                "at load, in an event listener, a timer, a finder's `items` or a `:check`: it changes the Inventory",
            ),
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
        doc: "serve's [`host.rename`](serve-api.md#the-live-inventory-hosts-and-groups-and-outside-edits): only its key in `roster.yml` and its name in `links:` change. Its vault item keeps its name. Only while the user runs one of your actions, commands or finder items (decision Q100).",
        returns: ("RenameResult", "What was written."),
        errors: &[
            (
                "roster.inventory.rename: only while the user runs one of your actions, commands or finder items",
                "at load, in an event listener, a timer, a finder's `items` or a `:check`: it changes the Inventory",
            ),
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
        doc: "serve's [`host.move`](serve-api.md#the-live-inventory-hosts-and-groups-and-outside-edits): what it inherited from its old group and wouldn't from the new one is written on the Host, so it stays the same Host. Only while the user runs one of your actions, commands or finder items (decision Q100).",
        returns: (
            "MoveResult",
            "What was written, and which fields were pinned on the Host.",
        ),
        errors: &[
            (
                "roster.inventory.move: only while the user runs one of your actions, commands or finder items",
                "at load, in an event listener, a timer, a finder's `items` or a `:check`: it changes the Inventory",
            ),
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
        doc: "serve's [`host.review`](serve-api.md#adding-a-host-hostadd). Only while the user runs one of your actions, commands or finder items (decision Q100).",
        returns: ("ReviewResult", "What was written."),
        errors: &[
            (
                "roster.inventory.review: only while the user runs one of your actions, commands or finder items",
                "at load, in an event listener, a timer, a finder's `items` or a `:check`: it changes the Inventory",
            ),
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
        path: "roster.sessions.show",
        params: &[
            p("session", "integer", "The Session's id, from an event (`e.session`)."),
            opt(
                "line",
                "string",
                "Text of a line it printed: the app searches its scrollback from the bottom for the latest line with it, and shows it highlighted.",
            ),
        ],
        summary: "Goes to a Session, and to a line in its scrollback",
        doc: "It happens after the call returns, as if the user picked the Session: with two Sessions to one Host, this is the one the id names. With `line`, the terminal's search opens on it, so `Enter` and `Shift+Enter` go on up and down from there and `Esc` closes it; a line no longer in the scrollback shows \"no matches\" there. A Session that has ended is said in a notice. Only while the user runs one of your actions, commands or finder items.",
        returns: ("", ""),
        errors: &[(
            "roster.sessions.show: only while the user runs one of your actions, commands or finder items",
            "at load or in an event listener",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "-- An alert's row goes to the line in the Session that printed it.\nopen = function(e) roster.sessions.show(alerts[e.row].session, alerts[e.row].text) end",
    },
    Function {
        path: "roster.sessions.list",
        params: &[],
        summary: "The Sessions open now, in the order they opened",
        doc: "Every Session that is open, the ones that opened before the Plugin loaded too: the events only tell a Plugin what happens after it loads, so read this at load and follow `session_open` and `session_exit` from there. A Session is open from its `session_open` to its `session_exit`; one that ended but whose tab is still there isn't listed. The app keeps the list in the order it saw each Session open, and a Session that connects again (the same id) opens again, so it goes last. In a listener for either event the list already has (or no longer has) that Session. It reads what the app last said, never roster serve, so it never waits.",
        returns: ("Session[]", "Each open Session's id and Host, oldest open first."),
        errors: &[],
        refused: &[],
        needs: Needs::Hears("session_open"),
        since: 4,
        example: "local live = {}\nfor _, s in ipairs(roster.sessions.list()) do\n  if s.host then live[s.host] = true end\nend\nroster.on(\"session_open\", function(e) if e.host then live[e.host] = true end end)",
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
        doc: "Waits for the answer, however long roster serve takes (a call behind the app's Publish waits for it); that time doesn't count against the Plugin's budget, nor toward it being given up on, but the Plugin does nothing else meanwhile. [`roster.serve.request`](#rosterserverequestmethod-params-done) asks without waiting. A Plugin may be granted `inventory.info`, `hosts.list`, `host.get`, `host.check`, `host.check_job`, `changes.diff` and the `mesh.*` and `discover.*` methods; never one that reaches a secret. Every method the install prompt flags, the ones that act on the network or the Inventory (all but `inventory.info`, `hosts.list`, `host.get`, `host.check_job`, `changes.diff`, `mesh.status`, `mesh.plan`, `mesh.job`, `mesh.stop`, `discover.plan`, `discover.status` and `discover.stop`; `mesh.apply`, `mesh.cut`, `host.check`, `discover.start` and `discover.add` among them), only while the user runs one of your actions, commands or finder items, or answers your question: never at load, on an event, from a timer, or in a finder's `items` or a `:check` section's `check`. One call may ask roster serve this way (and through `roster.inventory`) at most 100 times, waiting 300 s in all. What each returns is under [roster serve's results](#roster-serves-results); in it, as in `roster.inventory`'s, a `cmd:` or `env:` Login reference is cut to its kind ([`LoginRef`](#loginref)), in any text of it: a diff's line or a step's message too.",
        returns: ("any", "The method's result, as Lua tables (JSON `null` is `nil`)."),
        errors: &[
            (
                "roster.serve.call: not granted (serve:METHOD)",
                "the Plugin wasn't granted that method",
            ),
            (
                "roster.serve.call METHOD: only while the user runs one of your actions, commands or finder items",
                "a flagged method (`mesh.apply`, `host.check`, `discover.start`, …) at load, in an event listener, a timer, a finder's `items` or a `:check`",
            ),
            (
                "roster.serve.call METHOD: more than 100 calls into roster serve in one go (roster.serve.request doesn't wait)",
                "the call asked roster serve 100 times already (or waited 300 s in all: `waited 300 s or more for roster serve in one go`)",
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
    Function {
        path: "roster.serve.request",
        params: &[
            p(
                "method",
                "string",
                "A roster serve method the Plugin was granted, as [`roster.serve.call`](#rosterservecallmethod-params)'s.",
            ),
            opt(
                "params",
                "table",
                "The method's params; `nil` or `{}` for none. Data only: no functions.",
            ),
            p(
                "done",
                "fun(result: any, err: string?)",
                "Runs once with the answer: the method's `result` (as `roster.serve.call` returns it), or `nil` and why (`roster.serve.request METHOD: MESSAGE (code N)`). Its return value is ignored; an error in it counts like an action's.",
            ),
        ],
        summary: "Asks roster serve without waiting: `done` gets the answer",
        doc: "Returns at once; `done` runs later on the Plugin's thread, as a call of its own, so the Plugin keeps answering the user while roster serve is busy (a Publish holds `roster.yml` for a minute or two). The same rules as [`roster.serve.call`](#rosterservecallmethod-params): the method must be granted, a flagged one (`mesh.apply`, `discover.start`, …) only in a call the user started, and a `cmd:` or `env:` Login reference in the result is cut to its kind. **The answer to a request made in a call the user started is part of that call:** `done` may open a view, ask a question, copy or run a command line, as the call could, and may ask for a flagged method. A request made in that `done` doesn't carry it further, and one made at load, on an event or from a timer never has it. An answer for a Plugin unloaded or reloaded since is dropped. At most 8 wait at once.",
        returns: ("", ""),
        errors: &[
            (
                "roster.serve.request: not granted (serve:METHOD)",
                "the Plugin wasn't granted that method",
            ),
            (
                "roster.serve.request METHOD: only while the user runs one of your actions, commands or finder items",
                "a flagged method (`mesh.apply`, `host.check`, `discover.start`, …) at load, in an event listener, a timer, a finder's `items` or a `:check`",
            ),
            (
                "roster.serve.request METHOD: 8 requests are waiting for roster serve already: wait for one to answer",
                "8 haven't answered yet",
            ),
        ],
        refused: &[],
        needs: Needs::AnyServe,
        since: 3,
        example: "roster.commands.add(\"count\", { run = function()\n  roster.serve.request(\"hosts.list\", {}, function(r, err)\n    if not r then return roster.notify(err, \"warn\") end\n    roster.echo(#r.hosts .. \" Hosts\")\n  end)\nend })",
    },
    Function {
        path: "roster.http.request",
        params: &[
            p("request", "HttpRequest", "What to send: at least its `url`."),
            p(
                "done",
                "fun(response: HttpResponse?, err: string?)",
                "Runs once with the answer: `response` for any status the site gave (a 404 too), or `nil` and why there was none (refused, unreachable, timed out, too big). Its return value is ignored; an error in it counts like an action's.",
            ),
        ],
        summary: "Sends an HTTP request to a site the Plugin was granted",
        doc: "Returns at once; `done` runs later. Each request is checked before anything is sent: its site must be one of the Plugin's `network:<site>` grants (https, unless the site was listed with `http://`; the port the site names, or the scheme's own). The same check stops a redirect to anywhere else.",
        returns: ("", ""),
        errors: &[
            (
                "roster.http.request: https://elsewhere.example isn't a site this Plugin may reach (it may reach SITES)",
                "the URL's scheme, host or port isn't granted",
            ),
            ("roster.http.request: \"URL\" isn't a URL: …", "`url` doesn't parse"),
            (
                "roster.http.request: a URL with a user or password in it isn't sent",
                "the URL has `user:password@`",
            ),
            (
                "roster.http.request: the NAME header is roster's to set",
                "a header that steers the connection: `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `TE`, `Expect`, `Proxy-…`",
            ),
            (
                "roster.http.request: \"METHOD\" isn't a method (there's GET, HEAD, POST, PUT, PATCH, DELETE)",
                "another method",
            ),
            ("roster.http.request: the body is over 262144 bytes", "a longer body"),
            (
                "roster.http.request: 4 requests are going already: wait for one to answer",
                "4 haven't answered yet",
            ),
            (
                "roster.http.request: \"KEY\" isn't a key of a request (there's url, method, headers, body, timeout)",
                "another key in `request`",
            ),
        ],
        refused: &[],
        needs: Needs::AnyNetwork,
        since: 2,
        example: "roster.http.request({\n  url = \"https://hooks.example.com/alerts\",\n  method = \"POST\",\n  headers = { [\"Content-Type\"] = \"application/json\", Authorization = \"Bearer \" .. roster.plugin.config.token },\n  body = '{\"text\": \"esx-02 is down\"}',\n}, function(res, err)\n  if not res then return roster.notify(\"webhook: \" .. err, \"warn\") end\n  if res.status >= 300 then roster.notify(\"webhook said \" .. res.status, \"warn\") end\nend)",
    },
    Function {
        path: "roster.http.get",
        params: &[
            p("url", "string", "The URL, on a site the Plugin was granted."),
            p(
                "done",
                "fun(response: HttpResponse?, err: string?)",
                "As [`roster.http.request`](#rosterhttprequestrequest-done)'s.",
            ),
        ],
        summary: "Fetches a URL from a site the Plugin was granted",
        doc: "`roster.http.request({ url = url }, done)`.",
        returns: ("", ""),
        errors: &[(
            "roster.http.get: …",
            "as [`roster.http.request`](#rosterhttprequestrequest-done)'s",
        )],
        refused: &[],
        needs: Needs::AnyNetwork,
        since: 2,
        example: "roster.http.get(\"https://status.example.com/api/v2/status.json\", function(res, err)\n  roster.status.set(\"upstream\", { text = res and res.status == 200 and \"upstream ok\" or \"upstream ?\" })\nend)",
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
    Event {
        name: "command_done",
        needs: &["terminal.read"],
        payload: "CommandDoneEvent",
        when: "A command ended in a Session whose shell writes OSC 133 marks (since api 4): after the `terminal_output` with its last lines. A shell without them sends none; [Shell integration](plugins.md#shell-integration) says how to set one up.",
    },
    Event {
        name: "job_progress",
        needs: &["serve:mesh.job", "serve:discover.status", "serve:host.check_job"],
        payload: "JobProgressEvent",
        when: "One of roster serve's jobs (a Mesh run, a Discover scan, a Host's check) started, moved on (at most five times a second) or ended (serve API 20; an older serve sends none, so keep a poll until the first one comes; a check is a job from serve API 21). A Plugin hears a Mesh job only with `serve:mesh.job`, a scan only with `serve:discover.status` and a check only with `serve:host.check_job`: what it could ask anyway (`serve:host.check` alone isn't enough: a listener may never call it). The result isn't in it: ask `mesh.job`, `discover.status` or `host.check_job` once it ends. Its text is cut as roster serve's answers are: a `cmd:` or `env:` Login reference in it (a failed check's `error.message`) reaches you as `cmd:` or `env:`.",
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
        method: "host.check_job",
        result: "CheckJob",
        link: "serve-api.md#diagnostics-hostcheck",
    },
    ServeResult {
        method: "changes.diff",
        result: "ChangesDiff",
        link: "serve-api.md#editing-pending-changes",
    },
    ServeResult {
        method: "mesh.plan",
        result: "MeshResult|MeshStarted",
        link: "serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus",
    },
    ServeResult {
        method: "mesh.apply",
        result: "MeshResult|MeshStarted",
        link: "serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus",
    },
    ServeResult {
        method: "mesh.cut",
        result: "MeshCut|MeshStarted",
        link: "serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus",
    },
    ServeResult {
        method: "mesh.status",
        result: "MeshStatus",
        link: "serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus",
    },
    ServeResult {
        method: "mesh.job",
        result: "MeshJob?",
        link: "serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus",
    },
    ServeResult {
        method: "mesh.stop",
        result: "MeshStop",
        link: "serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus",
    },
    ServeResult {
        method: "discover.plan",
        result: "DiscoverPlan",
        link: "serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd",
    },
    ServeResult {
        method: "discover.start",
        result: "DiscoverStatus",
        link: "serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd",
    },
    ServeResult {
        method: "discover.status",
        result: "DiscoverStatus",
        link: "serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd",
    },
    ServeResult {
        method: "discover.stop",
        result: "DiscoverStop",
        link: "serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd",
    },
    ServeResult {
        method: "discover.add",
        result: "DiscoverAdd",
        link: "serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd",
    },
];

const RUN_DOC: &str = "What choosing it runs: a function, called with a [`HandlerContext`](#handlercontext) that says which row, item or segment it was and the Session on screen (its return value is ignored), or a command line (`\"open esx-02\"`).";

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
        doc: "What each gives is in [Permissions](plugins.md#permissions). `serve:<method>` names one method and `network:<site>` one site (`network:api.example.com`, `network:*.example.com`, `network:http://10.0.0.5:8080`); a bare `network`, or a serve method that reaches a secret, can't be asked for.",
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
        name: "Timer",
        summary: "A timer's id, from `roster.defer` or `roster.every`",
        doc: "",
        alias: "integer",
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
        alias: "string|fun(ctx: HandlerContext): any",
        fields: &[],
        open: false,
    },
    Type {
        name: "HandlerContext",
        summary: "What a row's, a button's, a finder item's, a status segment's, a toolbar control's, a question's, a progress's or a `:check` section's function is called with",
        doc: "Since api 3 (api 2 called them with an empty table). Only the fields for what ran it are there: a row button has `section`, `row` and `action`; a finder item `finder` and `item`. A command's function gets [`CommandArgs`](#commandargs), which has `session` and `session_host` too.",
        alias: "",
        fields: &[
            o(
                "section",
                "string",
                "The Sidebar section's id, for a row or a row's button.",
            ),
            o(
                "row",
                "string",
                "The row's `id` (its place in the list, `\"3\"`, if it has none).",
            ),
            o(
                "action",
                "integer",
                "Which button was pressed, 1 for the first: of the row's `actions`, the section's (no `row` then) or the float's.",
            ),
            o(
                "dropped",
                "string",
                "For a section's or a row's `drop`: the Host dropped on it (since api 3).",
            ),
            o("finder", "string", "The finder's id, for a finder item."),
            o("item", "string", "The item's `id` (its place, if it has none)."),
            o("segment", "string", "The status segment's id."),
            o("health", "string", "The `:check` section's id, for its `check`."),
            o(
                "check",
                "integer",
                "This `:check` run of the section, for its `check`: a check that returns `\"later\"` answers with [`roster.health.answer`](#rosterhealthanswercheck-lines)`(e.check, lines)` (since api 3).",
            ),
            o("toolbar", "string", "The toolbar control's id."),
            o("progress", "string", "The progress's id, for its `cancel`."),
            o(
                "confirm",
                "\"yes\"|\"no\"",
                "For a question's `run` (`\"yes\"`) or `cancel` (`\"no\"`, also when another Plugin's question replaced it).",
            ),
            o(
                "session",
                "integer",
                "The Session on screen; `nil` with none. Only with `inventory.read` or `terminal.read`.",
            ),
            o(
                "session_host",
                "string",
                "The Host of the Session on screen; `nil` with none, for a Quick Connect Session, and without `inventory.read` or `terminal.read`. (A table's function gets the row's Host as `host`: [`TableEvent`](#tableevent).)",
            ),
        ],
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
            o(
                "complete",
                "fun(arg: string): string[]",
                "Since api 3: what Tab offers after the command's name. Called with what's typed after it (`\"add esx\"`) as the user types, it returns whole arguments that start with it (`{ \"add esx-02 \" }`; end one with a space when another word follows). At most 200; the app shows the last answer until the next comes. It isn't a call the user started: no clipboard, questions or command lines in it.",
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
            o(
                "session",
                "integer",
                "The Session on screen; `nil` with none. Only with `inventory.read` or `terminal.read` (since api 3).",
            ),
            o(
                "session_host",
                "string",
                "The Host of the Session on screen; `nil` with none, for a Quick Connect Session, and without `inventory.read` or `terminal.read` (since api 3).",
            ),
            o(
                "host",
                "string",
                "The Host under the Sidebar's cursor (else the one on screen), as roster's own commands take it; `nil` with none, and without `inventory.read` (since api 3).",
            ),
            o(
                "section",
                "string",
                "When the Sidebar's cursor is on a row of one of your own sections: that section's id (since api 3).",
            ),
            o(
                "row",
                "string",
                "And that row's `id`, or `nil` on the section's heading (since api 3).",
            ),
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
            o(
                "actions",
                "RowAction[]",
                "Buttons on its heading (`\"Dismiss all\"`), at most 4: shown while the heading is selected.",
            ),
            o(
                "count",
                "number",
                "The count on its heading; the number of rows if left out (since api 3).",
            ),
            o(
                "drop",
                "Run",
                "Takes a Host dragged onto the heading or the empty section: it runs with `{ section, dropped = HOST }` (since api 3).",
            ),
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
            o(
                "icon",
                "RowGlyph",
                "A glyph before the label, as the app's Folders and groups have (since api 3).",
            ),
            o(
                "fold",
                "boolean",
                "It folds the rows after it with a higher `level`, as a Folder or group does: `h`/`l`, its chevron and a click fold it, the app keeps what's folded, and its id for `:fold` is `SECTION:ID` (since api 3).",
            ),
            o(
                "kind",
                "\"host\"",
                "With `host`: drawn as the Inventory draws that Host (its state, address, Details and Review buttons, then the row's own `actions`); `label` and `note` are used only while the Host isn't in the Inventory (since api 3).",
            ),
            o(
                "drop",
                "Run",
                "Takes a Host dragged onto the row: it runs with `{ section, row, dropped = HOST }` (since api 3). A row with a `host` can always be dragged.",
            ),
            o(
                "drag_out",
                "Run",
                "Runs when the row is dragged out of the section onto another part of the Sidebar, as a Host dragged out of a Folder leaves it (since api 3).",
            ),
        ],
        open: false,
    },
    Type {
        name: "NoticeOptions",
        summary: "What else a notice has (`roster.notify`, since api 3)",
        doc: "",
        alias: "",
        fields: &[
            o("actions", "NoticeAction[]", "Buttons under its text, at most 2."),
            o(
                "quiet",
                "boolean",
                "An info notice's: whether it follows `ui.messages` (since api 4). Left out, it's quiet unless it has buttons; a warning or an error always shows.",
            ),
        ],
        open: false,
    },
    Type {
        name: "EchoOptions",
        summary: "How a line on the message line is said (`roster.echo`, since api 4)",
        doc: "",
        alias: "",
        fields: &[o(
            "quiet",
            "boolean",
            "A routine confirmation (`true`): shown only with `ui.messages = \"all\"`, heard by a screen reader and kept by `:messages` either way. Left out or `false`, it shows.",
        )],
        open: false,
    },
    Type {
        name: "ViewOpenOptions",
        summary: "Where a view opens (`roster.views.open`, since api 4)",
        doc: "",
        alias: "",
        fields: &[o(
            "select",
            "string",
            "The id of the node (a graph) or row (a table) to open at.",
        )],
        open: false,
    },
    Type {
        name: "NoticeAction",
        summary: "A button on a notice",
        doc: "",
        alias: "",
        fields: &[
            f("label", "string", "What it says (`\"Show the plan\"`)."),
            f(
                "run",
                "string",
                "The command line a click runs, as `roster.cmd` would (`\"view mesh-plan\"`); then the notice goes.",
            ),
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
        name: "HeadAction",
        summary: "A button on a view's or a Host-details section's heading",
        doc: "A [`RowAction`](#rowaction) with a key of its own (since api 4, #176): pressed anywhere in its view, or in its section, it runs the button, unless the table or graph there took the key first or a text field (a table's filter) has focus. Its tooltip shows the key.",
        alias: "",
        fields: &[
            f(
                "label",
                "string",
                "What it does, for its tooltip and screen readers (`\"Plan\"`).",
            ),
            o("icon", "RowIcon", "Its icon; `info` if left out."),
            f("run", "Run", "What pressing it runs."),
            o(
                "key",
                "string",
                "One character (`\"P\"`) that runs it: not one a table or graph uses itself (`h j k l H J K L g G n N o O t f m s S / ? q + - = 0`), nor one of the view's table or graph actions' keys, nor another button's (since api 4).",
            ),
        ],
        open: false,
    },
    Type {
        name: "RowIcon",
        summary: "A row action's icon",
        doc: "`plan`, `apply` and `cut` since api 3 (ticket 91): a dashed arrow, an arrow into a bar, and an edge broken by a cross, as a cut edge is drawn in a graph. `map` since api 4: three nodes joined, for showing something on a graph.",
        alias: "\"close\"|\"edit\"|\"add\"|\"addGroup\"|\"review\"|\"unreview\"|\"info\"|\"copy\"|\"plan\"|\"apply\"|\"cut\"|\"map\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "RowGlyph",
        summary: "A Sidebar row's glyph (since api 3)",
        doc: "",
        alias: "\"folder\"|\"group\"",
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
            o(
                "title",
                "string",
                "Its title (the `:finder` command's label and the dialog's name); the id if left out.",
            ),
            o(
                "prompt",
                "string",
                "What it shows before the query (`Folders ›`), at most 64 characters; its title if left out (since api 3).",
            ),
            o(
                "items",
                "FinderItem[]|fun(): FinderItem[]",
                "What it finds in, at most 2,000; or a function that returns them, run in the Plugin each time the finder opens (not a call the user started, whoever opened it; choosing an item is). Until it first answers the finder says it's loading; after that it shows the last answer while it asks again.",
            ),
            o(
                "section",
                "string",
                "Instead of `items`: one of your own Sidebar sections, whose rows it finds in (with their paths, unfolded), as roster's own `inventory` finder does (since api 3).",
            ),
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
            o(
                "checks",
                "HealthCheck[]",
                "Its lines, as they are now. Left out with `check`.",
            ),
            o(
                "check",
                "fun(ctx: HandlerContext): HealthCheck[]|\"later\"",
                "Called on each `:check` (since api 3): returns the section's lines, or `\"later\"` and answers with [`roster.health.answer`](#rosterhealthanswercheck-lines) within 30 seconds, from a `roster.serve.request`'s `done` say. Wins over `checks`.",
            ),
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
            o("actions", "FloatAction[]", "Buttons at its foot (at most 4)."),
            o("links", "Link[]", "Web pages to open in the browser (at most 4)."),
        ],
        open: false,
    },
    Type {
        name: "FloatAction",
        summary: "A button in a floating window",
        doc: "",
        alias: "",
        fields: &[
            f("label", "string", "What it does (`\"Go to the line\"`)."),
            o(
                "key",
                "string",
                "One character that runs it while the window has focus (not `q`, which closes it).",
            ),
            f("run", "Run", "What pressing it runs."),
        ],
        open: false,
    },
    Type {
        name: "Link",
        summary: "A web page a floating window links to",
        doc: "The app shows the address's host next to the label, so the user sees where it goes before they click.",
        alias: "",
        fields: &[
            f("label", "string", "Its text (`\"Runbook\"`)."),
            f(
                "url",
                "string",
                "An `https://` or `http://` address; anything else is refused.",
            ),
        ],
        open: false,
    },
    Type {
        name: "Confirm",
        summary: "A question the user answers (`roster.confirm`)",
        doc: "The app draws it with your Plugin's name on it. Text is cut to 500 characters, except `text` (4,000).",
        alias: "",
        fields: &[
            f("title", "string", "The question (`\"Cut esx-02 from the Mesh?\"`)."),
            o(
                "text",
                "string",
                "What will happen, in the app's voice; a blank line starts a paragraph.",
            ),
            o(
                "facts",
                "Fact[]",
                "Label and value pairs: exactly what will be done to what.",
            ),
            o(
                "action",
                "string",
                "The confirming button's word (`\"Cut\"`); `\"Confirm\"` if left out.",
            ),
            o(
                "danger",
                "boolean",
                "The stronger form, for what can't easily be undone: the button in the danger colour, the keys starting on Cancel.",
            ),
            o(
                "typed",
                "string",
                "With `danger`: a word the user types before the button works (a Host's name), at most 100 characters.",
            ),
            f("run", "fun(e: table): any", "Called when the user confirms."),
            o(
                "cancel",
                "fun(e: table): any",
                "Called when they don't (`Esc` or Cancel), or another Plugin's question takes its place.",
            ),
        ],
        open: false,
    },
    Type {
        name: "Progress",
        summary: "How far something long has got (`roster.progress.set`)",
        doc: "",
        alias: "",
        fields: &[
            f(
                "title",
                "string",
                "What's going on (`\"Scanning 10.0.0.0/24\"`), at most 80 characters.",
            ),
            o("text", "string", "More, for its tooltip (`\"12 Hosts found\"`)."),
            o("done", "number", "How much is done, with `total`."),
            o(
                "total",
                "number",
                "How much there is; with `done`, shown as a share. Without both, it only shows it's going.",
            ),
            o(
                "cancel",
                "Run",
                "What stopping it runs: the button and `:cancel ID` call it once.",
            ),
        ],
        open: false,
    },
    Type {
        name: "ToolbarControl",
        summary: "A control in the toolbar (`roster.toolbar.set`)",
        doc: "",
        alias: "",
        fields: &[
            f(
                "label",
                "string",
                "What it does, for its tooltip and screen readers (`\"Scan a network\"`), at most 80 characters.",
            ),
            o(
                "text",
                "string",
                "A word shown beside the icon (at most 20 characters); without an icon, the label is shown.",
            ),
            o("icon", "ToolbarIcon", "Its icon."),
            f("run", "Run", "What pressing it runs."),
        ],
        open: false,
    },
    Type {
        name: "ToolbarIcon",
        summary: "A toolbar control's icon",
        doc: "`map` is three nodes joined: a network, Topology.",
        alias: "\"find\"|\"add\"|\"details\"|\"help\"|\"map\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "View",
        summary: "A side panel or a full view (`roster.views.set`)",
        doc: "Drawn top to bottom: the text, the facts, then the table or the graph (one or the other, not both). Text is cut to 500 characters, except `text` (4,000).",
        alias: "",
        fields: &[
            o("title", "string", "Its heading; the id if left out."),
            o(
                "place",
                "ViewPlace",
                "Where it opens first: `\"panel\"` (the default) or `\"full\"`. The user can move it to the other and widen or narrow it (`␣ z`, `␣ <`, `␣ >`); their choice, and init.lua's `views.ID`, win over it.",
            ),
            o(
                "actions",
                "HeadAction[]",
                "Buttons on its heading, at most 4, for what the whole view does (`Plan`, `Apply`): each runs with `{ view }` (since api 3), and its `key` runs it from anywhere in the view (since api 4).",
            ),
            o(
                "text",
                "string",
                "A few lines above the rest, in the app's voice; a blank line starts a paragraph.",
            ),
            o(
                "facts",
                "Fact[]",
                "Label and value pairs, as a Host's details show them.",
            ),
            o("table", "Table", "A table of rows."),
            o("graph", "Graph", "A graph of nodes and edges, in place of a table."),
        ],
        open: false,
    },
    Type {
        name: "ViewPlace",
        summary: "Where a view goes",
        doc: "",
        alias: "\"panel\"|\"full\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "ViewUpdate",
        summary: "What `roster.views.update` changes",
        doc: "Plain data, but for `actions`. A field left out stays as it is.",
        alias: "",
        fields: &[
            o("title", "string", "A new heading."),
            o("text", "string", "New text; `\"\"` takes it away."),
            o("facts", "Fact[]", "New facts, all of them."),
            o(
                "rows",
                "TableRow[]",
                "Rows to add or replace, by `id` (at most 2,000 at once).",
            ),
            o(
                "remove",
                "string[]",
                "The ids of rows to take away; in a graph, of nodes (their edges go too) and clusters (their nodes stay, loose).",
            ),
            o(
                "clear",
                "boolean",
                "`true` takes every row of the table away first, in one go (a new scan); `rows` then fill it again (since api 3).",
            ),
            o("nodes", "GraphNode[]", "A graph's nodes to add or replace, by `id`."),
            o("edges", "GraphEdge[]", "A graph's edges to add or replace, by `id`."),
            o(
                "clusters",
                "GraphCluster[]",
                "A graph's clusters to add or replace, by `id`.",
            ),
            o("remove_edges", "string[]", "The ids of a graph's edges to take away."),
            o(
                "filter",
                "GraphFilter",
                "A graph's new filter, in place of the one it has and the user's (`{}` shows everything).",
            ),
            o(
                "columns",
                "Column[]",
                "New columns, all of them; the rows keep their cells.",
            ),
            o("sort", "string", "Sort by this column now (the user's sort gives way)."),
            o("desc", "boolean", "With `sort`: highest first."),
            o(
                "actions",
                "TableAction[]",
                "New actions, all of them: their functions replace the old ones' (`open` stays).",
            ),
        ],
        open: false,
    },
    Type {
        name: "DetailsSection",
        summary: "A section of a Host's details (`roster.details.set`)",
        doc: "Drawn after roster's own sections, with your Plugin's name under its heading: the text, the facts, then the table.",
        alias: "",
        fields: &[
            o("title", "string", "Its heading; the id if left out."),
            o(
                "order",
                "number",
                "Where it goes among the Plugins' sections, lowest first; 500 if left out.",
            ),
            o(
                "actions",
                "HeadAction[]",
                "Buttons on its heading, at most 4, for what the section does about this Host (`Cut`): each runs with `{ section, host }` (since api 3), and its `key` runs it from anywhere in the section (since api 4).",
            ),
            o("text", "string", "A few lines, in the app's voice."),
            o("facts", "Fact[]", "Label and value pairs."),
            o("table", "Table", "A table of rows."),
        ],
        open: false,
    },
    Type {
        name: "Fact",
        summary: "A label and its value",
        doc: "",
        alias: "",
        fields: &[
            f("label", "string", "What it is (`reach`)."),
            f("value", "string", "Its value (`can reach 7 Hosts`)."),
            o(
                "data",
                "boolean",
                "`true` for something you could paste into a shell (an address, a name), set in the data font.",
            ),
        ],
        open: false,
    },
    Type {
        name: "Table",
        summary: "A table: columns, rows as plain data, and what a row can do",
        doc: "The app sorts it, keeps the selected row across changes and draws only the rows on screen, so it stays smooth at thousands of rows. Keys, once it has focus: `j`/`k` or the arrows move, `g g`/`G` go to the first and last row, `Ctrl+D`/`Ctrl+U` half a page, `s` sorts by the next column and `S` reverses it, `/` filters the rows by what they say (`Esc` clears it), `Enter` runs `open`, an action's `key` runs it. A click selects a row, a double click opens it, and a click on a heading sorts by it. The selected row shows its actions as buttons.",
        alias: "",
        fields: &[
            f("columns", "Column[]", "Its columns, left to right (1 to 20)."),
            o(
                "rows",
                "TableRow[]",
                "Its rows (at most 2,000 here; `roster.views.update` adds more, up to 10,000).",
            ),
            o(
                "sort",
                "string",
                "The column it's sorted by at first; as given if left out.",
            ),
            o("desc", "boolean", "Sorted highest first."),
            o("empty", "string", "What it says with no rows."),
            o(
                "open",
                "TableRun",
                "What `Enter` (or a double click) on a row runs. Without it, a row with a `host` opens that Host; others do nothing.",
            ),
            o(
                "actions",
                "TableAction[]",
                "What can be done to the selected row (at most 8).",
            ),
        ],
        open: false,
    },
    Type {
        name: "Column",
        summary: "A table's column",
        doc: "",
        alias: "",
        fields: &[
            f("id", "string", "The key of its value in each row's `cells`."),
            f("label", "string", "Its heading."),
            o(
                "kind",
                "ColumnKind",
                "How its values read and sort; `\"text\"` if left out.",
            ),
            o(
                "width",
                "number",
                "How wide, in characters; it shares the room with the others if left out.",
            ),
        ],
        open: false,
    },
    Type {
        name: "ColumnKind",
        summary: "How a column's values read and sort",
        doc: "`\"text\"` is words, in the app's font. `\"data\"` is something you could paste into a shell (an address, a name), in the data font, sorted with the numbers in it as numbers (`10.0.0.9` before `10.0.0.10`). `\"number\"` is right-aligned with even digits, sorted as numbers.",
        alias: "\"text\"|\"data\"|\"number\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "TableRow",
        summary: "A row of a table: plain data",
        doc: "",
        alias: "",
        fields: &[
            f(
                "id",
                "string",
                "Unique in the table (at most 100 characters): updates and the selection follow it.",
            ),
            o(
                "cells",
                "table<string, string|number>",
                "Its value in each column, by the column's `id`; a column it lacks is blank and sorts last.",
            ),
            o(
                "host",
                "string",
                "The Host it's about: `Enter` opens it when the table has no `open`, and actions get it as `e.host`.",
            ),
            o(
                "tone",
                "RowTone",
                "Drawn quieter (`\"muted\"`: ended, down) or marked (`\"warn\"`, `\"error\"`).",
            ),
        ],
        open: false,
    },
    Type {
        name: "RowTone",
        summary: "How a table row is marked",
        doc: "",
        alias: "\"muted\"|\"warn\"|\"error\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "TableAction",
        summary: "Something a table's selected row can do",
        doc: "",
        alias: "",
        fields: &[
            f(
                "label",
                "string",
                "What it does (`\"Keep\"`), on its button and in the key hints.",
            ),
            o(
                "key",
                "string",
                "One character that runs it on the selected row, not one the table uses itself.",
            ),
            o("icon", "RowIcon", "Its button's icon; the label alone if left out."),
            o(
                "when",
                "table<string, string|number|(string|number)[]>",
                "Only on the rows whose cells match: `{ state = \"up\" }`, or a list of values (`{ state = { \"up\", \"slow\" } }`). A cell needn't be a column, so a row can carry what decides it without showing it.",
            ),
            f("run", "TableRun", "What it runs."),
        ],
        open: false,
    },
    Type {
        name: "TableRun",
        summary: "What a table's row or action runs",
        doc: "A function gets a [TableEvent](#tableevent): which row, in which view or section, and its Host. A command line runs as typed after `:`.",
        alias: "string|fun(e: TableEvent): any",
        fields: &[],
        open: false,
    },
    Type {
        name: "TableEvent",
        summary: "What a table's function gets",
        doc: "",
        alias: "",
        fields: &[
            f("row", "string", "The row's `id`."),
            o(
                "host",
                "string",
                "The row's `host`, or the Host whose details the section is in.",
            ),
            o("view", "string", "The view's id, in a view."),
            o("section", "string", "The section's id, in a Host's details."),
        ],
        open: false,
    },
    // ---------------------------------------------------------------- HTTP
    Type {
        name: "HttpRequest",
        summary: "What `roster.http.request` sends",
        doc: "Any other key is an error.",
        alias: "",
        fields: &[
            f(
                "url",
                "string",
                "Where: on a site the Plugin was granted (`https://api.example.com/v1/alerts`).",
            ),
            o(
                "method",
                "string",
                "`GET` (the default), `HEAD`, `POST`, `PUT`, `PATCH` or `DELETE`, in any case.",
            ),
            o(
                "headers",
                "table<string, string>",
                "Headers to send, such as a token of the Plugin's own (`Authorization`). Not the ones that steer the connection (`Host`, `Content-Length`, `Proxy-…`). roster adds only `User-Agent: roster/VERSION` and what HTTP needs.",
            ),
            o("body", "string", "The body, at most 256 KB; bytes as they are."),
            o(
                "timeout",
                "number",
                "Seconds to wait for the whole answer; at most 30 (the default). 10 seconds to connect.",
            ),
        ],
        open: false,
    },
    Type {
        name: "HttpResponse",
        summary: "What a site answered",
        doc: "",
        alias: "",
        fields: &[
            f("status", "integer", "The status code (`200`, `404`)."),
            f("url", "string", "Where it ended, after redirects."),
            f(
                "headers",
                "table<string, string>",
                "By lower-case name; a header sent twice has its values joined with `, `.",
            ),
            f(
                "body",
                "string",
                "The body, at most 1 MB, as bytes: not decompressed, not decoded.",
            ),
        ],
        open: false,
    },
    Type {
        name: "Graph",
        summary: "A graph: nodes, edges and clusters as plain data, and what a node can do",
        doc: "The app lays it out (each cluster's nodes on a spiral, the clusters in rows, loose nodes first), keeps every position in the State so it opens the same way each time, and draws only what's on screen, so 2,000 nodes stay smooth. Clusters collapse to one node with their count: the user's `o`, or by themselves when the graph has more than 300 nodes and the cluster doesn't say. Keys, once it has focus: `h` `j` `k` `l` or the arrows go to the nearest node that way, `/` searches (name, id, kind, note, detail, cluster) and `n`/`N` go through the matches, `Enter` runs `open` (or opens a collapsed cluster), `o` collapses or opens the selected node's cluster and `O` all of them, `+` `-` zoom and `0` shows it all, `H` `J` `K` `L` pan, `t` switches to a table of every node, then of every edge, `f` goes to the filter (the clusters, kinds and states to show, as many of each as the user ticks, hiding the rest; `Esc` clears a search, then the filter, then closes the view), `m` moves the selected node with `h` `j` `k` `l` or the arrows (`Shift` for a bigger step) until `Enter` keeps its place or `Esc` puts it back (on a collapsed cluster it says to open it first), and an action's `key` runs it on the selected node (only where its `when` matches). Selecting a node lights up what it can reach and what can reach it, with the counts: however many hops away, or only one with `reach = \"direct\"`. Hiding nodes doesn't change what they reach: the counts are the whole graph's. A click selects, a double click opens, a drag moves a node (kept) or pans, the wheel zooms. An edge whose end names nothing is left out until it does.",
        alias: "",
        fields: &[
            o(
                "nodes",
                "GraphNode[]",
                "Its nodes, in order: a cluster's first node is at its centre (at most 5,000).",
            ),
            o("edges", "GraphEdge[]", "Its edges (at most 10,000)."),
            o("clusters", "GraphCluster[]", "Its clusters, in order (at most 500)."),
            o(
                "reach",
                "GraphReach",
                "How far a node's reach goes, for the counts and what selecting it lights up: `\"all\"` (the default) every hop, `\"direct\"` one.",
            ),
            o(
                "filter",
                "GraphFilter",
                "What it shows to begin with; the rest is hidden until the user changes it (`f`).",
            ),
            o(
                "open",
                "NodeRun",
                "What `Enter` (or a double click) on a node runs. Without it, a node with a `host` opens that Host.",
            ),
            o(
                "actions",
                "NodeAction[]",
                "What can be done to the selected node (at most 8).",
            ),
        ],
        open: false,
    },
    Type {
        name: "GraphNode",
        summary: "A node of a graph: plain data",
        doc: "Its shape says what it is and its state what it's doing, never colour alone: the list says both in words.",
        alias: "",
        fields: &[
            f(
                "id",
                "string",
                "Unique among the graph's nodes and clusters (at most 100 characters): edges, updates and the selection follow it.",
            ),
            o("label", "string", "Its name on the map; the id if left out."),
            o(
                "kind",
                "string",
                "What sort of thing it is (`\"esxi\"`): searched, and a column in the list.",
            ),
            o("shape", "NodeShape", "How it's drawn; `\"dot\"` if left out."),
            o("state", "NodeState", "Live (in the accent) or down."),
            o("mark", "NodeMark", "A small warn or error mark beside it."),
            o(
                "note",
                "string",
                "A few words (`\"out of date\"`), beside it when selected and in the list.",
            ),
            o("cluster", "string", "The id of the cluster it's in."),
            o(
                "host",
                "string",
                "The Host it is: `Enter` opens it when the graph has no `open`, and actions get it as `e.host`.",
            ),
            o(
                "detail",
                "string",
                "A second line in the data font (an address), when selected and in the list.",
            ),
        ],
        open: false,
    },
    Type {
        name: "NodeShape",
        summary: "How a node is drawn",
        doc: "As roster draws its own (taste.md): `\"dot\"` filled (a key login), `\"ring\"` (a password login), `\"dashed\"` a dashed ring in the second tone (unreviewed), `\"hollow\"` a thin grey ring (ended), `\"square\"` in the second tone (this Box).",
        alias: "\"dot\"|\"ring\"|\"dashed\"|\"hollow\"|\"square\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "NodeState",
        summary: "What a node is doing",
        doc: "`\"live\"` is drawn in the accent, which means connected now; keep it for that. `\"down\"` is drawn quieter and crossed out.",
        alias: "\"live\"|\"down\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "NodeMark",
        summary: "A node's mark",
        doc: "",
        alias: "\"warn\"|\"error\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "GraphEdge",
        summary: "An edge of a graph: plain data",
        doc: "An end is a node or a cluster: an edge to a cluster reaches every node in it, and one from a cluster is every node's in it, so one edge can stand for a group's Links. Edges to the same collapsed cluster are drawn as one, with their count.",
        alias: "",
        fields: &[
            o("id", "string", "Unique among its edges; `\"FROM>TO\"` if left out."),
            f("from", "string", "The id of the node or cluster it starts at."),
            f("to", "string", "The id of the node or cluster it goes to."),
            o(
                "dir",
                "EdgeDir",
                "`\"one\"` (the default) is one way, with an arrow at `to`; `\"both\"` is each way.",
            ),
            o("style", "EdgeStyle", "Its line; `\"solid\"` if left out."),
            o(
                "tone",
                "EdgeTone",
                "Live (in the accent), muted, or marked warn or error.",
            ),
            o(
                "cut",
                "boolean",
                "`true` draws it broken in the middle by a cross: about to be cut.",
            ),
            o("label", "string", "A few words about it, in the list."),
        ],
        open: false,
    },
    Type {
        name: "EdgeDir",
        summary: "Which way an edge goes",
        doc: "",
        alias: "\"one\"|\"both\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "EdgeStyle",
        summary: "An edge's line",
        doc: "",
        alias: "\"solid\"|\"dashed\"|\"dotted\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "EdgeTone",
        summary: "How an edge is marked",
        doc: "`\"live\"` is the accent: keep it for a connection that's open now. An edge that turns live is drawn in from its start, as a Session's edge is on connect (not under reduced motion).",
        alias: "\"live\"|\"muted\"|\"warn\"|\"error\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "GraphCluster",
        summary: "A cluster of a graph's nodes",
        doc: "Drawn as a circle around its nodes with its title above, or collapsed to one node with its count.",
        alias: "",
        fields: &[
            f(
                "id",
                "string",
                "Unique among the graph's nodes and clusters: nodes name it as their `cluster`.",
            ),
            o("title", "string", "Its title; the id if left out."),
            o(
                "mesh",
                "boolean",
                "`true`: every node in it reaches every other, both ways, without an edge for each pair (the Mesh's `mesh: true`).",
            ),
            o(
                "collapsed",
                "boolean",
                "How it starts: collapsed (`true`) or open (`false`). Left out, it collapses when the graph has more than 300 nodes. The user's own choice is kept and wins.",
            ),
        ],
        open: false,
    },
    Type {
        name: "GraphReach",
        summary: "How far a graph's reach goes",
        doc: "`\"all\"`: however many hops away, as a key on a Host reaches what that Host's own keys reach. `\"direct\"`: one hop, a node's own edges, its cluster's and its cluster's mesh.",
        alias: "\"all\"|\"direct\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "GraphFilter",
        summary: "What a graph shows: the rest is hidden",
        doc: "A node shows when it's in one of the `clusters`, of one of the `kinds` and in one of the `states`, for each that's given; leave one out (or empty) for all. Edges with a hidden end and clusters with no node left are hidden too. The user picks one cluster, kind or state at a time in the graph's filter (`f`); a filter that names several shows as \"N clusters\" there.",
        alias: "",
        fields: &[
            o(
                "clusters",
                "string[]",
                "Cluster ids: only their nodes show (at most 500).",
            ),
            o(
                "kinds",
                "string[]",
                "Kinds (a node's `kind`): only nodes of these show (at most 500).",
            ),
            o(
                "states",
                "FilterState[]",
                "A node's `state` or `mark`: only nodes live, down, or marked warn or error show.",
            ),
        ],
        open: false,
    },
    Type {
        name: "FilterState",
        summary: "A state a graph's filter keeps",
        doc: "A node's `state` (`\"live\"`, `\"down\"`) or `mark` (`\"warn\"`, `\"error\"`).",
        alias: "\"live\"|\"down\"|\"warn\"|\"error\"",
        fields: &[],
        open: false,
    },
    Type {
        name: "NodeAction",
        summary: "Something a graph's selected node can do",
        doc: "",
        alias: "",
        fields: &[
            f("label", "string", "What it does (`\"Check\"`), in the key hints."),
            o(
                "key",
                "string",
                "One character that runs it on the selected node, not one the graph uses itself.",
            ),
            o("icon", "RowIcon", "Its icon in the node list's buttons."),
            o(
                "when",
                "table<string, string|number|(string|number)[]>",
                "Only on the nodes whose fields match, as a table action's `when` (since api 3): `{ state = \"live\" }`, or a list of values (`{ kind = { \"esxi\", \"linux\" } }`). It names a node's own fields (`id`, `label`, `kind`, `shape`, `state`, `mark`, `note`, `cluster`, `host`, `detail`); a field the node leaves out matches nothing. Elsewhere its key does nothing and its hint isn't shown.",
            ),
            f("run", "NodeRun", "What it runs."),
        ],
        open: false,
    },
    Type {
        name: "NodeRun",
        summary: "What a graph's node or action runs",
        doc: "A function gets a [NodeEvent](#nodeevent): which node, its Host, and the Session on screen. A command line runs as typed after `:`, as the Plugin's (`:plugins run`).",
        alias: "string|fun(e: NodeEvent): any",
        fields: &[],
        open: false,
    },
    Type {
        name: "NodeEvent",
        summary: "What a graph's function gets",
        doc: "",
        alias: "",
        fields: &[
            f("node", "string", "The node's `id`."),
            o("host", "string", "The node's `host`."),
            f("view", "string", "The view's id."),
            o(
                "session",
                "integer",
                "The Session on screen, as in a [`HandlerContext`](#handlercontext): only with `inventory.read` or `terminal.read`.",
            ),
            o(
                "session_host",
                "string",
                "The Host of the Session on screen, as in a [`HandlerContext`](#handlercontext).",
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
        doc: "`PROVIDER:ITEM`, a vault item's name (`bw:esx-02 ssh`, `op:Lab/esx-02#password`, `kp:esx-02 ssh`), or `prompt` (asked for), `agent` (an ssh key), `key`, `none`. `env:VAR` and `cmd:COMMAND` are references too, but they say how a secret is fetched (and a secret pasted into a `cmd:` line would show), so a Plugin gets them cut to their kind: `env:` and `cmd:` (since api 3; decision Q92), in raw text such as a diff or a check's message too. The providers are in [Password providers](cli-reference.md#password-providers).",
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
        name: "CheckJob",
        summary: "`host.check_job`'s result: a Host's check, and how it came out",
        doc: "Since serve API 21 a check is a job: the `job_progress` event (with `serve:host.check_job`) says when one starts, moves on and ends, the app's `:check` and Check from anywhere alike, and its `job` is what to ask for here once its `state` is `done` or `stopped`. serve keeps a check findable after it ends (the last 32 a newer check replaced too); one it no longer has is code 49.",
        alias: "",
        fields: &[
            f("kind", "\"check\"", "Always `\"check\"`."),
            f("job", "string", "Its id, `\"check-N\"`."),
            f("action", "\"check\"", "Always `\"check\"`."),
            f(
                "state",
                "string",
                "`\"running\"`, `\"stopping\"`, or how it ended: `\"done\"`, `\"stopped\"`, `\"failed\"`.",
            ),
            f("done", "integer", "Steps started."),
            f("total", "integer", "Steps in all (8)."),
            o("at", "string", "The step under way (`\"dns\"`, `\"auth\"`, ...)."),
            f("host", "string", "The Host it checks."),
            o(
                "result",
                "HostCheck",
                "Once `done` or `stopped`: `host.check`'s result. `ok` is false for a stopped check, its later steps `skipped`.",
            ),
            o("error", "ServeError", "Once `failed`: why."),
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
                "git's diff of `roster.yml` against the last commit; `\"\"` for none. A `cmd:` reference in it reaches a Plugin cut to `cmd:` (the rest of its line), an `env:` one to `env:`.",
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
    // ---------------------------------------------------------------- the Mesh and Discover (#160 f, #176)
    Type {
        name: "MeshResult",
        summary: "`mesh.plan`'s and `mesh.apply`'s result",
        doc: "With `brief = true` (on `mesh.job`), `links` keeps only those worth a look and `link_count`, `link_statuses`, `reached` and `links_more` count the rest.",
        alias: "",
        fields: &[
            f(
                "applied",
                "boolean",
                "`false` for a plan (nothing changed), `true` for an apply.",
            ),
            f("links", "MeshLink[]", "Every Link, with how it went."),
            f("hosts", "MeshHost[]", "Every Host visited."),
            f(
                "excluded",
                "table<string, string>",
                "Hosts kept out, and why (`not reviewed (reviewed: false)`, `mesh: false`).",
            ),
            f(
                "reach",
                "table<string, integer>",
                "How many Hosts each source reaches, counting the Links that work.",
            ),
            f("pending", "table<string, string>", "Hosts that didn't answer, and why."),
            f(
                "already",
                "boolean",
                "Nothing to change and nothing pending: already in the Mesh.",
            ),
            f(
                "warnings",
                "string[]",
                "Words to show (a `ROSTER.md` that isn't roster's, a Host that left `roster.yml`).",
            ),
            f(
                "cut_pending",
                "table<string, string[]>",
                "Earlier cuts not finished yet: a Host, and the peers still to do.",
            ),
            o("link_count", "integer", "Brief: how many Links there are in all."),
            o(
                "link_statuses",
                "table<string, integer>",
                "Brief: how many Links have each status.",
            ),
            o(
                "reached",
                "table<string, integer>",
                "Brief: how many Hosts reach each Host.",
            ),
            o(
                "links_more",
                "integer",
                "Brief: the Links worth a look that `links` leaves out (it keeps 1,000).",
            ),
        ],
        open: false,
    },
    Type {
        name: "MeshLink",
        summary: "A Link of the Mesh: a source reaching a peer",
        doc: "",
        alias: "",
        fields: &[
            f("from", "string", "The source Host."),
            f("to", "string", "The peer it reaches."),
            f("kind", "\"key\"|\"password\"", "`password` when the peer asks for one."),
            o(
                "status",
                "\"ok\"|\"untested\"|\"unreachable\"|\"no-host-key\"|\"no-via\"|\"pending\"|\"skipped\"",
                "How it went; `mesh.status` gives none (it never connects), except `no-via` with `brief`. `unreachable`, `no-host-key` and `no-via` are left out.",
            ),
            o("why", "string", "The status in words."),
            o(
                "via",
                "string",
                "The Host the source goes through to the peer (a Link's `via:`).",
            ),
            o("skip", "string", "Why roster didn't write it: `\"password-source\"`."),
        ],
        open: false,
    },
    Type {
        name: "MeshHost",
        summary: "A Host a Mesh run visited",
        doc: "",
        alias: "",
        fields: &[
            f("host", "string", "Its name."),
            f(
                "status",
                "\"same\"|\"would-change\"|\"changed\"|\"pending\"",
                "`would-change` from a plan, `changed` from an apply, `pending` when it didn't answer.",
            ),
            f(
                "changes",
                "string[]",
                "Short phrases: `make key`, `write ssh config`, `add key from orion-2`, …",
            ),
            o("error", "string", "Why it's pending."),
            o("more", "integer", "Brief: the changes left out (it keeps 10)."),
        ],
        open: false,
    },
    Type {
        name: "MeshStarted",
        summary: "A Mesh run started with `background = true`",
        doc: "Its result comes in `mesh.job`, and `job_progress` events follow it.",
        alias: "",
        fields: &[
            f("job", "integer", "The job's number, for `mesh.job` and `mesh.stop`."),
            f("action", "\"plan\"|\"apply\"|\"cut\"", "What it does."),
            f("total", "integer", "How many Hosts it visits."),
            o("host", "string", "A cut's Host."),
        ],
        open: false,
    },
    Type {
        name: "MeshCut",
        summary: "`mesh.cut`'s result",
        doc: "",
        alias: "",
        fields: &[
            f("host", "string", "The Host cut from the Mesh."),
            f(
                "confirmed",
                "string[]",
                "The peers whose keys it took off, and that took its off.",
            ),
            f(
                "pending",
                "table<string, string>",
                "The peers that didn't answer, and why: the next cut finishes them.",
            ),
            o(
                "warnings",
                "string[]",
                "What roster left on the cut Host's own side, one sentence each: an earlier `mesh_dir:` that still holds a Mesh key, which roster never removes (serve API 24; absent before).",
            ),
            f(
                "change",
                "MeshCutChange",
                "The `mesh: false` written for it as a Pending change.",
            ),
        ],
        open: false,
    },
    Type {
        name: "MeshCutChange",
        summary: "The `mesh: false` a `mesh.cut` writes into `roster.yml`",
        doc: "",
        alias: "",
        fields: &[
            f(
                "written",
                "boolean",
                "Whether it was written now (`false` when it already was, or couldn't be).",
            ),
            o(
                "backup",
                "string",
                "The copy of `roster.yml` from before; `nil` when it isn't in a git repo.",
            ),
            o(
                "note",
                "string",
                "Why nothing was written, or that it went straight to a file outside git.",
            ),
            o(
                "error",
                "string",
                "Why it couldn't be written (the cut still happened).",
            ),
            o("fix", "string", "What to do then, in a sentence."),
        ],
        open: false,
    },
    Type {
        name: "MeshStatus",
        summary: "`mesh.status`'s result: the Mesh as `roster.yml` asks for it",
        doc: "It never connects. `brief = true` keeps it small as in a brief [`MeshResult`](#meshresult); `grouped = true` says each meshed group once (`meshed`) and leaves the pairs it covers out of `links`.",
        alias: "",
        fields: &[
            f("links", "MeshLink[]", "The Links, without a `status`."),
            f("excluded", "table<string, string>", "Hosts kept out, and why."),
            f("reach", "table<string, integer>", "How many Hosts each source reaches."),
            f("members", "string[]", "The Hosts roster visits."),
            f(
                "pending",
                "table<string, string>",
                "Hosts the last run didn't finish, and why.",
            ),
            f(
                "cut_pending",
                "table<string, string[]>",
                "Earlier cuts not finished yet.",
            ),
            f(
                "out_of_date",
                "boolean",
                "`roster.yml` changed the Mesh since the last complete apply on this Box.",
            ),
            o(
                "meshed",
                "table<string, string[]>",
                "Grouped: each meshed group's Hosts that reach each other both ways.",
            ),
            o("link_count", "integer", "Brief: how many Links there are in all."),
            o(
                "link_statuses",
                "table<string, integer>",
                "Brief: how many Links have each status (`asked` for untested ones).",
            ),
            o(
                "reached",
                "table<string, integer>",
                "Brief: how many Hosts reach each Host.",
            ),
            o(
                "links_more",
                "integer",
                "Brief: the Links worth a look that `links` leaves out.",
            ),
        ],
        open: false,
    },
    Type {
        name: "MeshJob",
        summary: "`mesh.job`'s result: how far a Mesh run has got",
        doc: "`nil` when there's no job, or `job` isn't the latest.",
        alias: "",
        fields: &[
            f("job", "integer", "Its number."),
            f("action", "\"plan\"|\"apply\"|\"cut\"", "What it does."),
            o("host", "string", "A cut's Host."),
            f("state", "\"running\"|\"done\"|\"failed\"", "Where it is."),
            f("done", "integer", "Hosts done so far."),
            f("total", "integer", "Hosts in all."),
            o("at", "string", "The Host it's on."),
            f(
                "stopped",
                "boolean",
                "`mesh.stop` asked it to stop; the Hosts it hadn't got to are pending.",
            ),
            o(
                "result",
                "MeshResult|MeshCut",
                "Once `done`: what the method itself returns.",
            ),
            o("error", "ServeError", "Once `failed`: why."),
        ],
        open: false,
    },
    Type {
        name: "ServeError",
        summary: "An error roster serve answered with",
        doc: "",
        alias: "",
        fields: &[
            f("code", "integer", "Its code, in serve-api.md's tables."),
            f("message", "string", "What went wrong."),
            o("data", "table", "More about it, as its row says."),
        ],
        open: false,
    },
    Type {
        name: "MeshStop",
        summary: "`mesh.stop`'s result",
        doc: "",
        alias: "",
        fields: &[
            f("job", "integer", "The job."),
            f(
                "stopping",
                "boolean",
                "`false` when it isn't running (over already, or not the latest).",
            ),
        ],
        open: false,
    },
    Type {
        name: "DiscoverPlan",
        summary: "`discover.plan`'s result: what a scan would visit",
        doc: "",
        alias: "",
        fields: &[
            f(
                "targets",
                "string[]",
                "The targets as written back, without one another covers.",
            ),
            f("addresses", "integer", "How many addresses they hold."),
            f("ports", "integer", "How many ports it tries on each."),
            f(
                "scanner",
                "\"nmap\"|\"built-in\"",
                "nmap, or roster's own TCP connect scan without it.",
            ),
            f("limit", "integer", "The most addresses without `force` (4,096)."),
            f("max", "integer", "The most with `force` (65,536)."),
        ],
        open: false,
    },
    Type {
        name: "DiscoverStatus",
        summary: "`discover.status`'s and `discover.start`'s result: how far a scan has got",
        doc: "",
        alias: "",
        fields: &[
            f("scan", "string", "Its id (`\"scan-N\"`)."),
            f(
                "state",
                "\"running\"|\"stopping\"|\"done\"|\"stopped\"|\"failed\"",
                "Where it is.",
            ),
            f("targets", "string[]", "What it scans."),
            f("scanner", "\"nmap\"|\"built-in\"", "What it scans with."),
            f("done", "integer", "Addresses visited so far."),
            f("total", "integer", "Addresses in all."),
            f("count", "integer", "How many it found in all: the next `since`."),
            f(
                "quiet",
                "integer",
                "How many answered with none of the ports open (nmap only).",
            ),
            f("found", "DiscoverFound[]", "What it found, after the first `since`."),
            o("error", "string", "Why it `failed`."),
        ],
        open: false,
    },
    Type {
        name: "DiscoverFound",
        summary: "Something a scan found at an address",
        doc: "",
        alias: "",
        fields: &[
            f("address", "string", "Its address."),
            o(
                "name",
                "string",
                "The name it would be added as; `nil` when `known` names the Host already there.",
            ),
            f("type", "string", "The guessed kind."),
            f("hostname", "string", "Its name in DNS; `\"\"` for none."),
            f("title", "string", "A web page's title; `\"\"` for none."),
            o("web", "string", "Its web address, when it serves one."),
            o("known", "string", "The Inventory's Host at that address."),
            o("added", "string", "The name `discover.add` gave it."),
            f(
                "vendor",
                "string",
                "The network card's maker (nmap); `\"\"` when unknown.",
            ),
            f(
                "os",
                "string",
                "The guessed operating system (nmap); `\"\"` when unknown.",
            ),
            f(
                "mac",
                "string",
                "Its MAC address (nmap, on the same network); `\"\"` when unknown.",
            ),
            f("ports", "DiscoverPort[]", "Its open ports."),
        ],
        open: false,
    },
    Type {
        name: "DiscoverPort",
        summary: "An open port a scan found",
        doc: "",
        alias: "",
        fields: &[
            f("port", "integer", "Its number."),
            f("name", "string", "The service's name (`ssh`)."),
            f(
                "product",
                "string",
                "What answered (`OpenSSH 9.6`); `\"\"` when unknown.",
            ),
            f("title", "string", "A web page's title; `\"\"` for none."),
        ],
        open: false,
    },
    Type {
        name: "DiscoverStop",
        summary: "`discover.stop`'s result",
        doc: "",
        alias: "",
        fields: &[
            f("scan", "string", "The scan."),
            f(
                "stopping",
                "boolean",
                "`false` when it had ended already; `discover.status` says `stopped` once it has.",
            ),
        ],
        open: false,
    },
    Type {
        name: "DiscoverAdd",
        summary: "`discover.add`'s result",
        doc: "",
        alias: "",
        fields: &[
            f("group", "string", "The new group they went in."),
            f(
                "added",
                "DiscoverAdded[]",
                "Each Host added, `reviewed: false`, as a Pending change.",
            ),
            o("backup", "string", "The copy of `roster.yml` from before."),
        ],
        open: false,
    },
    Type {
        name: "DiscoverAdded",
        summary: "A Host `discover.add` added",
        doc: "",
        alias: "",
        fields: &[
            f("address", "string", "Its address."),
            f("name", "string", "Its name in `roster.yml`."),
        ],
        open: false,
    },
    Type {
        name: "EventName",
        summary: "An event a Plugin can listen for",
        doc: "",
        alias: "\"lock\"|\"unlock\"|\"host_selected\"|\"session_open\"|\"session_exit\"|\"inventory_changed\"|\"terminal_output\"|\"command_done\"|\"job_progress\"",
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
        name: "Session",
        summary: "An open Session, as `roster.sessions.list` gives it",
        doc: "",
        alias: "",
        fields: &[
            f(
                "session",
                "integer",
                "The Session's id, as its events name it: `roster.terminal.send` and `roster.sessions.show` take it.",
            ),
            o(
                "host",
                "string",
                "The Host's name; `nil` for a Quick Connect Session (`:quick`), which isn't on a Host.",
            ),
        ],
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
                "The Host's name; `nil` for a Quick Connect Session. A tab closed while it ran has it too (since api 3).",
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
        name: "JobProgressEvent",
        summary: "`job_progress`'s payload: serve's `job.progress` notification",
        doc: "",
        alias: "",
        fields: &[
            f("kind", "string", "`\"mesh\"`, `\"discover\"` or `\"check\"`."),
            f(
                "job",
                "integer|string",
                "Its id within its kind, as that kind's methods name it: the Mesh's job number (`mesh.job { job = N }`), the scan's `\"scan-N\"` (`discover.status { scan = ... }`), the check's `\"check-N\"` (`host.check_job { job = ... }`).",
            ),
            f(
                "action",
                "string",
                "`\"plan\"`, `\"apply\"` or `\"cut\"` for the Mesh; `\"scan\"` for Discover; `\"check\"` for a check.",
            ),
            f(
                "state",
                "string",
                "`\"running\"`, `\"stopping\"`, or how it ended: `\"done\"`, `\"stopped\"`, `\"failed\"`.",
            ),
            f(
                "done",
                "integer",
                "How far it has got: Hosts visited, addresses scanned, a check's steps started (of 8).",
            ),
            f("total", "integer", "Of how many."),
            o(
                "at",
                "string",
                "The Host it's on, when it's on one; a check's step (`\"dns\"`, `\"auth\"`, ...).",
            ),
            o("host", "string", "A cut's Host; the Host a check checks."),
            o(
                "error",
                "table",
                "How it failed: `{ code, message, data? }`, as serve's error.",
            ),
        ],
        open: false,
    },
    Type {
        name: "TerminalOutputEvent",
        summary: "`terminal_output`'s payload",
        doc: "What you type into a Session is never an event, but the shell echoes it back, so it's here like anything else the Session prints (a shell with OSC 133 marks labels that line `kind = \"input\"`).",
        alias: "",
        fields: &[
            f("session", "integer", "The Session's id."),
            o("host", "string", "The Host's name; `nil` for a Quick Connect Session."),
            f(
                "text",
                "string",
                "The lines it finished since the last one, each ending in `\\n`, as the terminal shows them: no colours or escape sequences, a line the program rewrote (a progress bar) only as it ended up, a long line that wrapped as one. A line is sent when the Session moves past it, so the one with the cursor (a prompt) waits. A line drawn again with the same text in the same place isn't sent again, so the screen a resized Session prints again (ConPTY does on Windows) doesn't repeat what you had. What a full-screen program (`vim`, `top`, `less`) draws isn't sent. At most the last 16 KB.",
            ),
            o(
                "kind",
                "string",
                "What the Session's shell's OSC 133 marks say these lines are (since api 4): `\"prompt\"` (a few lines after its prompt starts), `\"input\"` (the line typed at the prompt: the shell's echo of your command), `\"output\"` (what a command printed), or `nil` (no marks, or nothing they say). All the lines in `text` are of one kind; a batch of several kinds comes as several events, in order. A hint, not a guarantee: the marks come from the Host and anything it prints can forge them, and an `\"output\"` line may be an `ssh` or nested shell echoing what you type. Every line is sent whatever its kind.",
            ),
        ],
        open: false,
    },
    Type {
        name: "CommandDoneEvent",
        summary: "`command_done`'s payload",
        doc: "Read from the OSC 133 marks the Session's own shell prints (its rc file turns them on, or roster's opt-in shell hooks do). The command line is read off the screen once the shell runs it, so a line given up (Ctrl-C) or erased is never one, and what the screen doesn't show (a password at a prompt that doesn't echo it) can't be. The marks come from the Host, so this is its word: a hint. A command a nested shell with marks took over (`ssh` to a Host with integration) has none, since its end can't be told from the nested shell's; nor does `exit` or `logout`, since a shell that exits sends no end mark for it.",
        alias: "",
        fields: &[
            f("session", "integer", "The Session's id."),
            o("host", "string", "The Host's name; `nil` for a Quick Connect Session."),
            o(
                "command",
                "string",
                "The command line as the shell showed it after its prompt; `nil` when it couldn't be read (the shell sent no `B` mark, or the line scrolled away or was reflowed by a resize before it ran).",
            ),
            f(
                "output",
                "string",
                "What it printed, each line ending in `\\n`, as `terminal_output` sent it (its last line too, if it didn't end in a line feed). At most the last 16 KB.",
            ),
            o("code", "integer", "Its exit code; `nil` when the shell didn't say."),
        ],
        open: false,
    },
];

/// Which Lua, for authors coming from Neovim.
const LUA_DOC: &str = "roster embeds **Lua 5.4** (built into the app, nothing to install), not LuaJIT as Neovim does; [why](adr/0006-lua-plugins-and-packages.md#why-lua-54-not-luajit). Coming from Neovim:

- Integers are real 64-bit integers (`3 // 2` is `1`, `math.type(1)` is `\"integer\"`), and the bitwise operators are native (`a & b`, `a | b`, `~a`, `a << 2`): there's no `bit` library.
- `goto`, `<const>` and `<close>` locals work; there's no `jit` and no FFI.
- The API is `roster.*`, never `vim.*`: there's no `vim.api`, `vim.fn`, `vim.loop` or `vim.schedule`.
- It runs in the [sandbox](app/config.md#the-sandbox): the base functions, `string`, `table`, `math`, `utf8` and an `os` with only `time`, `clock`, `date` and `difftime`. `coroutine` too (since api 3: a coroutine runs within the same time budget and memory limit). No `io`, no `os.execute`, no `debug`, no `package` and no C modules; `load` takes text only, and `require` loads only from the Plugin's own folder (`name.lua`, `name/init.lua`, or the same under `lua/`).
- `pairs` visits a table's keys in order: numbers, then text, then the rest. So the same state always makes the same changes in the same order, on every machine; `next` is Lua's own.
- An empty table is `{}` to the app, whether you meant a list or a table of fields: the app takes `{}` as an empty list wherever it wants one (`rows = {}`, `items = {}`).
- It runs on a thread of its own with a memory limit and a time budget per call: see [Limits](plugins.md#limits).";

/// The errors any function can raise, and what a call that fails does.
const ERRORS_DOC: &str = "A function that fails raises a Lua error: `pcall` catches it, with the message as a string. The message starts with the function (`roster.inventory.host: unknown host 'web-9' (code 2)`); a roster serve error ends with its code, from [serve-api.md's tables](serve-api.md). An error you don't catch stops the call: a notice names the Plugin, file and line (`pinned: init.lua:12: …`), the UI changes that call made are dropped, and the third such error after loading stops the Plugin.

Any function can also raise:

- Lua's own `bad argument` error, for an argument of the wrong kind (a number where a table goes);
- `roster.sidebar.set: PATH: a table that mixes a list with named keys (or has gaps): use one or the other`, `roster.float.open: PATH: a thread can't be a Plugin value` and the like, for data that can't be handed over (the function, then `PATH`, where in your table: `rows.3.label`). A function's return value that can't be is `the value it returned: PATH: …`;
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

    s.push_str("## Command lines a Plugin may run\n\n`roster.cmd(line)`, and a `run` that's a command line (a row's, a button's, a finder item's, a toolbar control's), run the Plugin's own commands and only these of roster's, each with what it needs. Anything else is refused: `roster.cmd` raises an error, and a button that would run it says why in a notice instead.\n\n| Command | What it does | Needs |\n|---|---|---|\n");
    for c in COMMANDS {
        s.push_str(&format!("| `{}` | {} | {} |\n", c.name, cell(c.doc), c.needs.text()));
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
/// `:plugins types PATH` (ticket 74): writes [`stubs`] for this app's API as `types/roster.lua` in
/// the Plugin folder `dir`, over an older copy, and gives where. `dir` must exist.
pub fn write_stubs(dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if !dir.is_dir() {
        return Err(format!("{} isn't a folder", dir.display()));
    }
    let types = dir.join("types");
    let file = types.join("roster.lua");
    // Never through a link out of the Plugin's folder (ticket 82): `types` or the file itself.
    for p in [&types, &file] {
        if std::fs::symlink_metadata(p).is_ok_and(|m| super::folder::is_link(&m)) {
            return Err(format!("{} is a link: roster won't write through it", p.display()));
        }
    }
    std::fs::create_dir_all(&types).map_err(|e| format!("{}: {e}", types.display()))?;
    std::fs::write(&file, stubs()).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(file)
}

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
                "permission": match func.needs { Needs::Nothing => Json::Null, Needs::Permission(p) => json!(p), Needs::AnyServe => json!("serve:*"), Needs::AnyNetwork => json!("network:*"), Needs::Hears(_) => json!(func.needs.any_of()) },
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
        "commands": COMMANDS.iter().map(|c| json!({ "name": c.name, "permission": match c.needs { Needs::Permission(p) => json!(p), _ => Json::Null } })).collect::<Vec<_>>(),
        "roster_only": ROSTER_ONLY,
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

    /// A command is one a Plugin may run or one never a Plugin's own, not both (issue #184).
    #[test]
    fn roster_only_and_the_commands_a_plugin_may_run_dont_overlap() {
        let both: Vec<&str> = ROSTER_ONLY
            .iter()
            .copied()
            .filter(|n| COMMANDS.iter().any(|c| c.name == *n))
            .collect();
        assert!(both.is_empty(), "{both:?}");
    }

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
            let named = match func.needs {
                Needs::Permission(p) => vec![p],
                Needs::Hears(_) => func.needs.any_of().to_vec(),
                _ => vec![],
            };
            for p in named {
                assert!(super::super::Permission::parse(p).is_ok(), "{}: {p}", func.path);
            }
        }
    }
}
