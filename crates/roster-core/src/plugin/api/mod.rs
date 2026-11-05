//! The Plugin API, declared once (ticket 70, decision Q89): every `roster.*` function and value,
//! every data type a Plugin hands the app or gets back, and every event, with its parameters,
//! returns, errors, permission and `Since: api N`. Each Lua module has a file of its own here with
//! its functions' declarations and their binding (`binding::bind`, which runtime.rs's `api` calls
//! for each in turn), so a function and what it does change together; the eight UI pieces set by
//! id share `pieces.rs`. The data types are in `types.rs`. From these tables, `generate.rs` writes
//!
//! - `docs/plugin-api.md`, the reference (`:help plugin-api`, `:help roster.inventory.host()`,
//!   `:help roster-Host`);
//! - `examples/plugins/types/roster.lua`, the LuaCATS stubs for lua-language-server;
//! - `crates/roster-core/tests/fixtures/plugin-api.json`, the same as data, which the app's help
//!   (its topics), its tests (ops.ts reads exactly the documented fields) and serve's tests (a
//!   Host has exactly the documented fields) read, with the host's own tables beside it
//!   ([`runtime`]);
//! - `app/src/plugins/core.gen.ts`, those tables for the app and its fake Backend.
//!
//! `cargo run -p roster-core --example gen_plugin_api` writes the four; `tests/plugin_api.rs`
//! fails when they aren't what it writes, and when the runtime exposes a function, value or event
//! these tables lack, or the other way round, for any set of grants.
//!
//! Types are written as LuaCATS (`string?`, `Host[]`, `"info"|"warn"`, `table<string, Group>`);
//! a capitalised name is one of [`TYPES`], made `roster.Host` in the stubs and a link in the docs.

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
        doc: "`nil` unless the Plugin was granted at least one `network:<site>` permission ([Permissions](plugins.md#permissions)). The request runs in roster's core, never in the app's window, and doesn't wait: the function you pass gets the answer later, as a call of its own with a call's budget. Only the sites granted are reached, redirects included; a name that resolves to an address on this computer or a private network is refused unless the manifest lists the address itself, or the name as a private site (`network:private:nas.lan`), which reaches only private addresses. A pinned site (`#sha256:…`) trusts only that certificate. No cookies or credentials of roster's go along, and no proxy but the user's `plugin_proxy`, through which a public name is still looked up here first, refused if it leads inside, and reached only at the address roster checked (the proxy is asked for a tunnel to that address, never the name; a name this computer can't look up isn't sent). At most 4 requests at once, a 256 KB body out, a 1 MB body back, 30 seconds each.",
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

pub(in crate::plugin) mod badges;
pub(in crate::plugin) mod clipboard;
pub(in crate::plugin) mod commands;
pub(in crate::plugin) mod details;
pub(in crate::plugin) mod float;
mod generate;
pub(in crate::plugin) mod http;
pub(in crate::plugin) mod inventory;
pub(in crate::plugin) mod keymap;
pub(in crate::plugin) mod pieces;
pub(in crate::plugin) mod roster;
pub(in crate::plugin) mod serve;
pub(in crate::plugin) mod sessions;
pub(in crate::plugin) mod storage;
pub(in crate::plugin) mod terminal;
pub(in crate::plugin) mod themes;
mod types;
pub(in crate::plugin) mod views;

pub use generate::*;
pub use types::TYPES;

/// Every module's functions, in [`MODULES`]' order.
const BY_MODULE: &[&[Function]] = &[
    roster::FUNCTIONS,
    commands::FUNCTIONS,
    keymap::FUNCTIONS,
    themes::FUNCTIONS,
    pieces::FUNCTIONS,
    badges::FUNCTIONS,
    float::FUNCTIONS,
    views::FUNCTIONS,
    details::FUNCTIONS,
    clipboard::FUNCTIONS,
    storage::FUNCTIONS,
    inventory::FUNCTIONS,
    sessions::FUNCTIONS,
    terminal::FUNCTIONS,
    serve::FUNCTIONS,
    http::FUNCTIONS,
];

/// Every `roster.*` function, in [`MODULES`]' order.
pub fn functions() -> impl Iterator<Item = &'static Function> {
    BY_MODULE.iter().flat_map(|m| m.iter())
}

/// [`functions`] as a list.
pub static FUNCTIONS: std::sync::LazyLock<Vec<&'static Function>> = std::sync::LazyLock::new(|| functions().collect());

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
        for func in functions() {
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
    fn the_event_name_type_names_every_event() {
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
        let def: crate::config::ThemeDef = serde_json::from_value(serde_json::json!({
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
        for func in functions() {
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
