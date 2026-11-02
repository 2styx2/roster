//! Plugins (ADR 0006, decisions Q81 and Q82; docs/plugins.md): Lua code in a folder of its own,
//! run in the same sandbox as `init.lua`, that adds to the app's registries through the versioned
//! `roster` module. A Plugin is a folder with `roster-plugin.lua` (the manifest: name, version,
//! permissions) and `init.lua` (the code, which may `require` its own modules).
//!
//! [`PluginHost`] is the whole interface: [`PluginHost::load`] a folder with the permissions the
//! user granted, then [`PluginHost::call`] a function it handed over, or send every Plugin an
//! [`Event`]. Each answer is a [`Reply`]: what the call returned, and the UI changes it asked for
//! (ops: plain data the frontend draws with its own primitives, never HTML).
//!
//! Isolation: every Plugin has its own Lua state on its own thread, a memory limit, and a time
//! budget for each call. An error comes back naming the Plugin, file and line; an error while
//! loading disables the Plugin, and so does the third error after it loaded (repeat offenders).
//! A Plugin stuck in one long C call is abandoned after the wall-clock limit and disabled, so a
//! slow Plugin delays nothing but itself. Time spent waiting for `roster serve` is serve's, not
//! the Plugin's ([`ServeWait`], decision Q103): a call behind the app's Publish, or waiting for
//! its fair share of serve ([`fair`], decision Q112), isn't the Plugin misbehaving.
//!
//! Secrets: the Rust core never holds one, and a Plugin reaches roster only through [`Serve`],
//! for the methods its permissions name ([`permission`]); none of those touches a password, a
//! vault session or an askpass token.
//!
//! Where a folder comes from is the caller's business: a local folder (`:plugins install PATH`),
//! or a Package's clone (ticket 24, [`crate::package`]), which loads through
//! [`PluginHost::load_with`] to get its settings from init.lua.

pub mod api;
pub mod demo;
pub mod fair;
pub mod folder;
pub mod network;
pub mod permission;
mod runtime;

use crate::config::lua;
pub use demo::DemoHost;
pub use permission::Permission;
pub use runtime::EVENTS;
use serde::Serialize;
use serde_json::Value as Json;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The version of the `roster` Lua module (`roster.api_version`), shared with `init.lua`'s.
pub const API_VERSION: u32 = crate::config::API_VERSION;

/// Where a Plugin's code comes from. A Package (ticket 24) is a [`Source::Dir`] too: its clone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A folder on this machine with `roster-plugin.lua` and `init.lua`.
    Dir(PathBuf),
    /// A built-in feature written as a Plugin, by name ([`BUNDLED`]).
    Bundled(String),
}

/// A built-in feature written on the public API, compiled into the app.
pub struct Bundled {
    pub name: &'static str,
    manifest: &'static str,
    init: &'static str,
}

/// The built-in Plugins: the status bar's Host count (decision Q82) and the Sidebar's Folders
/// (decision Q93).
pub const BUNDLED: &[Bundled] = &[
    Bundled {
        name: "hosts",
        manifest: include_str!("../../plugins/hosts/roster-plugin.lua"),
        init: include_str!("../../plugins/hosts/init.lua"),
    },
    Bundled {
        name: "folders",
        manifest: include_str!("../../plugins/folders/roster-plugin.lua"),
        init: include_str!("../../plugins/folders/init.lua"),
    },
];

/// The keys a manifest may have (api.rs's `Manifest` documents each).
pub const MANIFEST_FIELDS: &[&str] = &["name", "version", "description", "author", "api", "permissions"];

/// The manifest's file name, in the Plugin's folder.
pub const MANIFEST: &str = "roster-plugin.lua";
/// The Plugin's code, in its folder.
pub const ENTRY: &str = "init.lua";

/// How a Plugin reaches `roster serve`. The Tauri shell's adapter calls the running Backend;
/// tests use a fake. The host only ever asks for the methods a Plugin was granted.
pub trait Serve: Send + Sync {
    fn call(&self, method: &str, params: Json) -> Result<Json, String>;
}

/// Something that happened in the app, for the Plugins that listen ([`EVENTS`]).
#[derive(Debug, Clone)]
pub struct Event {
    pub name: String,
    pub payload: Json,
}

/// What went wrong in a Plugin: shown as `recent-alerts: init.lua:12: message`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginError {
    pub plugin: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub message: String,
}

impl PluginError {
    pub fn new(plugin: &str, file: Option<String>, line: Option<u32>, message: String) -> Self {
        PluginError {
            plugin: plugin.to_string(),
            file,
            line,
            message,
        }
    }
}

impl std::fmt::Display for PluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: ", self.plugin)?;
        match (&self.file, self.line) {
            (Some(file), Some(line)) => write!(f, "{file}:{line}: ")?,
            (Some(file), None) => write!(f, "{file}: ")?,
            _ => {}
        }
        f.write_str(&self.message)
    }
}

impl std::error::Error for PluginError {}

/// One call's result inside the Plugin's thread.
pub(crate) struct Outcome {
    pub result: Json,
    pub ops: Vec<Json>,
    pub error: Option<PluginError>,
    /// The function called was already replaced: not the Plugin's fault.
    pub stale: bool,
}

/// The answer to a load, a call or an event, for one Plugin.
#[derive(Debug, Clone, Serialize)]
pub struct Reply {
    pub plugin: String,
    /// What the function returned, as data (a finder's items, say).
    pub result: Json,
    /// The UI changes the Plugin asked for, in order (docs/plugins.md, "Ops").
    pub ops: Vec<Json>,
    pub error: Option<PluginError>,
    /// Set when the Plugin is now disabled, with why: the frontend takes its UI away.
    pub disabled: Option<String>,
}

impl Reply {
    fn failed(plugin: &str, error: PluginError, disabled: Option<String>) -> Self {
        Reply {
            plugin: plugin.to_string(),
            result: Json::Null,
            ops: Vec::new(),
            error: Some(error),
            disabled,
        }
    }
}

/// What a Plugin's manifest says about it: shown in the install prompt before any of its code runs.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Manifest {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Option<String>,
    /// The `roster.api_version` it was written for.
    pub api: u32,
    #[serde(serialize_with = "described")]
    pub permissions: Vec<Permission>,
}

#[derive(Serialize)]
struct Described {
    name: String,
    summary: String,
    risk: Option<String>,
}

fn described<S: serde::Serializer>(ps: &[Permission], s: S) -> Result<S::Ok, S::Error> {
    s.collect_seq(ps.iter().map(|p| Described {
        name: p.to_string(),
        summary: p.summary(),
        risk: p.risk(),
    }))
}

/// How much a Plugin may use.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub memory: usize,
    /// Lua run time for `init.lua`.
    pub load: Duration,
    /// Lua run time for each call or event (a hook's budget).
    pub call: Duration,
    /// How much longer than its budget a call may take in all (a long C call) before the Plugin is
    /// given up on and disabled. Waiting for roster serve doesn't count (decision Q103).
    pub grace: Duration,
    /// Errors after loading that disable it.
    pub strikes: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            memory: 32 * 1024 * 1024,
            load: Duration::from_secs(1),
            call: Duration::from_millis(250),
            grace: Duration::from_secs(2),
            strikes: 3,
        }
    }
}

/// A Plugin as `:plugins` lists it.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub manifest: Manifest,
    pub dir: PathBuf,
    /// What it runs with: what it asked for and was granted.
    pub granted: Vec<Permission>,
    pub errors: u32,
    pub disabled: Option<String>,
    /// Its network requests by site since the app started (decision Q116).
    pub requests: Vec<network::SiteCount>,
}

enum Job {
    Load(String),
    /// A handler, its arguments, and whose call it is.
    Call(u64, Json, runtime::By),
    Event(Event),
    /// A `roster.http` or `roster.serve.request` answer, for the function waiting for it.
    Answer(u64, runtime::Arrival),
}

/// Gets the replies nobody asked for: what a Plugin did when a request answered (the Tauri
/// shell sends them to the frontend as the `plugin-reply` event).
pub type Listener = Arc<dyn Fn(Reply) + Send + Sync>;
type Slots = Mutex<BTreeMap<String, Slot>>;

type Answer = (Outcome, Vec<String>);
/// Where a Plugin's thread takes its work from.
type Jobs = Sender<(Job, Sender<Answer>)>;
/// A Plugin's thread to give work to, with how long it has waited for serve.
type Target = (Jobs, Arc<ServeWait>);

struct Slot {
    manifest: Manifest,
    dir: PathBuf,
    grants: BTreeSet<Permission>,
    jobs: Option<Jobs>,
    listens: Vec<String>,
    errors: u32,
    disabled: Option<String>,
    /// Which load this is: an answer to a request made before a reload is dropped.
    generation: u64,
    /// How long its thread has waited for roster serve.
    serving: Arc<ServeWait>,
    /// Its proxy setting, which its client reads at each request.
    proxy: Arc<network::ProxyCell>,
}

/// Every loaded Plugin. Cheap to share: calls into different Plugins run at the same time.
pub struct PluginHost {
    serve: Arc<dyn Serve>,
    /// The share of roster serve all Plugins together may take at once ([`fair`]).
    all_plugins: Arc<fair::Gate>,
    /// Each Plugin's own share, by name: kept across reloads, so the calls a load left running
    /// still count against the next one.
    plugin_gates: Mutex<BTreeMap<String, Arc<fair::Gate>>>,
    limits: Limits,
    slots: Arc<Slots>,
    listener: Arc<Mutex<Option<Listener>>>,
    generation: AtomicU64,
    /// The app's data folder: each Plugin keeps its data in `plugin-data/NAME` there
    /// ([`folder::Storage`], decision Q93). None: `roster.storage` says there's no data folder.
    data: std::sync::OnceLock<PathBuf>,
    /// Each Plugin's network requests by site, by name: kept across reloads (decision Q116).
    logs: Mutex<BTreeMap<String, Arc<network::Log>>>,
    /// No Plugin of this host reaches the network: `roster.http` is there for a Plugin granted a
    /// site, but every request answers "not sent" (`:tutor`'s demo, [`demo`], decision Q123).
    offline: bool,
    /// The Sessions open now, as the app last listed them ([`PluginHost::set_sessions`]).
    sessions: Arc<OpenSessions>,
    /// The app's built-in commands, as it last said ([`PluginHost::set_builtins`]): shared with
    /// every Plugin's runtime, so none is a Plugin's own to run (issue #184).
    builtins: Builtins,
}

/// The app's built-in command names, shared by a host and its Plugins' runtimes: None until the
/// app has said them once.
pub(crate) type Builtins = Arc<std::sync::RwLock<Option<BTreeSet<String>>>>;

impl PluginHost {
    pub fn new(serve: Arc<dyn Serve>, limits: Limits) -> Self {
        PluginHost {
            serve,
            all_plugins: fair::Gate::new(fair::PLUGINS_AT_ONCE),
            plugin_gates: Mutex::default(),
            limits,
            slots: Arc::default(),
            listener: Arc::default(),
            generation: AtomicU64::new(0),
            data: std::sync::OnceLock::new(),
            logs: Mutex::default(),
            offline: false,
            sessions: Arc::default(),
            builtins: Builtins::default(),
        }
    }

    /// The host, with no Plugin reaching the network ([`demo`]): a `roster.http` request is checked
    /// as ever, then never sent, and its function hears why.
    pub fn offline(mut self) -> Self {
        self.offline = true;
        self
    }

    /// The app's built-in commands (every `:` command roster itself registers), at the start and
    /// whenever one registers later: none of them is a Plugin's own to run with `roster.cmd` or a
    /// `run` line, whatever the Plugin named its commands (issue #184). Each replaces the last and
    /// reaches the Plugins running at once. Until the app has said them once, no Plugin's own
    /// command runs that way either (api.rs's
    /// [`api::ROSTER_ONLY`](crate::plugin::api::ROSTER_ONLY) are refused all the same).
    pub fn set_builtins(&self, names: impl IntoIterator<Item = String>) {
        *self.builtins.write().expect("builtin commands") = Some(names.into_iter().collect());
    }

    /// A new proxy setting (`plugin_proxy` in init.lua changed, decision Q116) for every Plugin
    /// running: each one's next request uses it; one already going finishes as it began. A
    /// Plugin loaded later gets the setting it's handed ([`PluginHost::load_with_proxy`]).
    pub fn set_proxy(&self, proxy: Option<network::Proxy>) {
        for slot in self.slots.lock().expect("plugin slots").values() {
            slot.proxy.set(proxy.clone());
        }
    }

    /// The host, with each Plugin's data folder under `data` (the app's data folder, next to the
    /// State; never the config folder): `plugin-data/NAME` (decision Q93).
    pub fn with_data(self, data: &Path) -> Self {
        self.set_data(data);
        self
    }

    /// [`PluginHost::with_data`] for a host already shared (the Tauri shell learns its data
    /// folder once the app is up). Only the first call counts: a Plugin's folder never moves.
    pub fn set_data(&self, data: &Path) {
        let _ = self.data.set(data.to_path_buf());
    }

    /// Removes the Plugin `plugin`'s data folder, with everything in it, when the Plugin is
    /// removed (`:plugins remove`, `:packages clean`): true if there was one. Not for a reload
    /// or a revoked permission, which keep it.
    pub fn forget(&self, plugin: &str) -> Result<bool, String> {
        // A new Plugin by the same name starts its counts at nothing (decision Q116).
        self.logs.lock().expect("plugin logs").remove(plugin);
        match self.data.get() {
            Some(data) => folder::forget(data, plugin),
            None => Ok(false),
        }
    }

    /// Where the replies nobody asked for go ([`Listener`]). Without one they're dropped.
    pub fn set_listener(&self, listener: Listener) {
        *self.listener.lock().expect("plugin listener") = Some(listener);
    }

    /// Loads (or reloads) the Plugin from `source` with what the user granted. It runs with only
    /// the permissions its manifest asks for and `grants` contains. An error in the manifest
    /// loads nothing; an error in its code leaves it listed, disabled.
    pub fn load(&self, source: &Source, grants: &[Permission]) -> Result<(Manifest, Reply), PluginError> {
        self.load_with(source, grants, &Json::Null)
    }

    /// [`PluginHost::load`], handing the Plugin `config` as `roster.plugin.config` (a Package's
    /// settings from init.lua; `null` gives an empty table).
    pub fn load_with(
        &self,
        source: &Source,
        grants: &[Permission],
        config: &Json,
    ) -> Result<(Manifest, Reply), PluginError> {
        self.load_with_proxy(source, grants, config, None)
    }

    /// [`PluginHost::load_with`], with the user's proxy for its requests to public names
    /// (`plugin_proxy`, decision Q116). [`PluginHost::set_proxy`] changes it later.
    pub fn load_with_proxy(
        &self,
        source: &Source,
        grants: &[Permission],
        config: &Json,
        proxy: Option<network::Proxy>,
    ) -> Result<(Manifest, Reply), PluginError> {
        let (manifest, dir, code) = match source {
            Source::Dir(dir) => {
                let manifest = read_manifest(dir)?;
                if BUNDLED.iter().any(|b| b.name == manifest.name) {
                    return Err(PluginError::new(
                        &manifest.name,
                        Some(MANIFEST.into()),
                        None,
                        format!(
                            "{:?} is the name of a Plugin built into roster: choose another",
                            manifest.name
                        ),
                    ));
                }
                // Its real path must be in its folder (ticket 82): a symlink out is refused.
                let code = folder::inside(dir, Path::new(ENTRY))
                    .and_then(|p| std::fs::read_to_string(p).map_err(|e| format!("can't read it: {e}")))
                    .map_err(|e| PluginError::new(&manifest.name, Some(ENTRY.into()), None, e))?;
                (manifest, dir.clone(), code)
            }
            Source::Bundled(name) => {
                let b = BUNDLED.iter().find(|b| b.name == name).ok_or_else(|| {
                    PluginError::new(name, None, None, "roster has no built-in Plugin by that name".into())
                })?;
                // No folder: a built-in Plugin is one file, with nothing to `require`.
                (manifest_from(b.manifest, name)?, PathBuf::new(), b.init.to_string())
            }
        };
        let source = code;
        let name = manifest.name.clone();
        self.unload(&name);
        let grants: BTreeSet<Permission> = manifest
            .permissions
            .iter()
            .filter(|p| grants.contains(p))
            .cloned()
            .collect();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let serving = Arc::new(ServeWait::default());
        let proxy = Arc::new(network::ProxyCell::new(proxy));
        let jobs = self.spawn(
            &manifest,
            &dir,
            grants.clone(),
            config.clone(),
            generation,
            &serving,
            &proxy,
        );
        // In the slots before init.lua runs: a request it makes may answer while it still loads.
        self.slots.lock().expect("plugin slots").insert(
            name.clone(),
            Slot {
                manifest: manifest.clone(),
                dir: dir.clone(),
                grants,
                jobs: Some(jobs.clone()),
                listens: Vec::new(),
                errors: 0,
                disabled: None,
                generation,
                serving: Arc::clone(&serving),
                proxy,
            },
        );
        let answer = send(&jobs, Job::Load(source))
            .and_then(|rx| wait(&rx, Instant::now(), self.limits.load + self.limits.grace, &serving));
        drop(jobs);
        let mut slots = self.slots.lock().expect("plugin slots");
        // Unloaded or loaded again meanwhile: this load's slot is gone, and that's fine.
        let mut slot = slots.get_mut(&name).filter(|s| s.generation == generation);
        let reply = match answer {
            Some((outcome, listens)) => {
                if let Some(slot) = slot.as_deref_mut() {
                    slot.listens = listens;
                }
                match outcome.error {
                    Some(error) => {
                        let why = format!("it failed to load: {error}");
                        if let Some(slot) = slot {
                            disable(slot, &why);
                        }
                        Reply::failed(&name, error, Some(why))
                    }
                    None => Reply {
                        plugin: name.clone(),
                        result: Json::Null,
                        ops: outcome.ops,
                        error: None,
                        disabled: None,
                    },
                }
            }
            None => {
                let why = format!("it took longer than {} ms to load", self.limits.load.as_millis());
                if let Some(slot) = slot {
                    disable(slot, &why);
                }
                Reply::failed(
                    &name,
                    PluginError::new(&name, Some(ENTRY.into()), None, why.clone()),
                    Some(why),
                )
            }
        };
        Ok((manifest, reply))
    }

    /// Takes a Plugin out: its thread ends and nothing more reaches it. False if it wasn't loaded.
    pub fn unload(&self, plugin: &str) -> bool {
        self.slots.lock().expect("plugin slots").remove(plugin).is_some()
    }

    /// Calls a function the Plugin handed over (`{ "handler": N }` in its ops) with `args`, as
    /// the user's call: they chose it (a command, a row or button, a finder item, a toolbar
    /// control, a key, a question's answer). A timer's run, a command's `complete`, a finder's
    /// `items` and a `:check` section's `check` are never the user's call, whoever runs them.
    pub fn call(&self, plugin: &str, handler: u64, args: Json) -> Reply {
        self.call_as(plugin, handler, args, runtime::By::User)
    }

    /// [`PluginHost::call`] for a Plugin's own command that its `roster.cmd` ran from the user's
    /// call (a `cmd` op without `"user": false`): the user's call carried one hop (decision Q98,
    /// issue #183). It may copy, ask or echo, but a `roster.cmd` or a `roster.serve.request` made
    /// in it doesn't carry the call further: the line's op says `"user": false`, and the app runs
    /// what it names of the Plugin's with [`PluginHost::call_by_app`].
    pub fn call_carried(&self, plugin: &str, handler: u64, args: Json) -> Reply {
        self.call_as(plugin, handler, args, runtime::By::Carried)
    }

    /// [`PluginHost::call`] for what the app runs on its own, not the user's choice (another
    /// Plugin's question took this one's place and its `cancel` runs): never the user's call, so
    /// it can't copy, ask, run a command line or act on the network or the Inventory.
    pub fn call_by_app(&self, plugin: &str, handler: u64, args: Json) -> Reply {
        self.call_as(plugin, handler, args, runtime::By::App)
    }

    fn call_as(&self, plugin: &str, handler: u64, args: Json, by: runtime::By) -> Reply {
        let wall = self.limits.call + self.limits.grace;
        let Some((sender, serving)) = self.sender(plugin) else {
            let why = self.why_not(plugin);
            return Reply::failed(plugin, PluginError::new(plugin, None, None, why), None);
        };
        let start = Instant::now();
        let answer = send(&sender, Job::Call(handler, args, by)).and_then(|rx| wait(&rx, start, wall, &serving));
        self.settle(plugin, answer)
    }

    /// The Sessions open now, in the order the app saw them open (`roster.sessions.list()`,
    /// decision Q127): the app's whole list, which replaces the last one. The app sends it on
    /// start, whenever it changes, and before the `session_open` or `session_exit` that changed it.
    pub fn set_sessions(&self, open: Vec<(u64, Option<String>)>) {
        *self.sessions.0.lock().expect("open sessions") = open;
    }

    /// Sends `event` to every Plugin that listens and may hear it, all at once; the slow ones
    /// are given up on together. Only Plugins that changed something or failed answer.
    pub fn event(&self, event: Event) -> Vec<Reply> {
        let event = Event {
            payload: runtime::heard_payload(&event.name, event.payload),
            name: event.name,
        };
        let targets: Vec<(String, Target)> = {
            let slots = self.slots.lock().expect("plugin slots");
            slots
                .iter()
                .filter(|(_, s)| s.disabled.is_none() && s.listens.contains(&event.name))
                .filter(|(_, s)| runtime::may_hear_this(&event.name, &event.payload, &s.grants))
                .filter_map(|(n, s)| s.jobs.clone().map(|j| (n.clone(), (j, Arc::clone(&s.serving)))))
                .collect()
        };
        let start = Instant::now();
        let pending: Vec<(String, Option<Receiver<Answer>>, Arc<ServeWait>)> = targets
            .into_iter()
            .map(|(n, (tx, serving))| (n, send(&tx, Job::Event(event.clone())), serving))
            .collect();
        let wall = self.limits.call + self.limits.grace;
        pending
            .into_iter()
            .map(|(n, rx, serving)| {
                let answer = rx.and_then(|rx| wait(&rx, start, wall, &serving));
                self.settle(&n, answer)
            })
            .filter(|r| !r.ops.is_empty() || r.error.is_some())
            .collect()
    }

    /// How many of the Plugin's requests (`roster.serve.request`, `roster.http`) haven't answered
    /// and run yet: 0 when it isn't loaded.
    pub fn requests(&self, plugin: &str) -> usize {
        self.slots
            .lock()
            .expect("plugin slots")
            .get(plugin)
            .map_or(0, |s| s.serving.requests.load(Ordering::SeqCst))
    }

    /// The Plugin's network requests by site since the app started, for `:plugins`: counts and
    /// a time only (decision Q116). Empty for one that made none or isn't there.
    pub fn requests_by_site(&self, plugin: &str) -> Vec<network::SiteCount> {
        self.logs
            .lock()
            .expect("plugin logs")
            .get(plugin)
            .map(|l| l.counts())
            .unwrap_or_default()
    }

    /// How full the Plugin `plugin`'s data folder is, for `:plugins` (ticket 98): loaded or
    /// not, since the folder outlives a stopped Plugin. [`folder::DataUse::None`] when it has
    /// none yet or the host has no data folder.
    pub fn data_use(&self, plugin: &str) -> folder::DataUse {
        let Some(data) = self.data.get() else {
            return folder::DataUse::None;
        };
        match folder::Storage::new(data, plugin) {
            Ok(storage) => storage.data_use(),
            Err(message) => folder::DataUse::Problem { message },
        }
    }

    /// Every Plugin loaded, in name order.
    pub fn list(&self) -> Vec<Status> {
        self.slots
            .lock()
            .expect("plugin slots")
            .values()
            .map(|s| Status {
                requests: self.requests_by_site(&s.manifest.name),
                manifest: s.manifest.clone(),
                dir: s.dir.clone(),
                granted: s.grants.iter().cloned().collect(),
                errors: s.errors,
                disabled: s.disabled.clone(),
            })
            .collect()
    }

    fn sender(&self, plugin: &str) -> Option<Target> {
        let slots = self.slots.lock().expect("plugin slots");
        let slot = slots.get(plugin)?;
        if slot.disabled.is_some() {
            return None;
        }
        Some((slot.jobs.clone()?, Arc::clone(&slot.serving)))
    }

    fn why_not(&self, plugin: &str) -> String {
        match self.slots.lock().expect("plugin slots").get(plugin) {
            Some(Slot {
                disabled: Some(why), ..
            }) => format!("it's disabled: {why}"),
            _ => "it isn't loaded".into(),
        }
    }

    /// Records how a call went: errors count toward disabling, and a call that never came back
    /// disables at once.
    fn settle(&self, plugin: &str, answer: Option<Answer>) -> Reply {
        settle(&self.slots, self.limits, plugin, None, answer)
    }

    #[allow(clippy::too_many_arguments)] // each is one fact about this load, from its own place
    fn spawn(
        &self,
        manifest: &Manifest,
        dir: &Path,
        grants: BTreeSet<Permission>,
        config: Json,
        generation: u64,
        serving: &Arc<ServeWait>,
        proxy: &Arc<network::ProxyCell>,
    ) -> Jobs {
        let (tx, rx) = channel::<(Job, Sender<Answer>)>();
        let (name, version, dir) = (manifest.name.clone(), manifest.version.clone(), dir.to_path_buf());
        // Its calls into serve go through its own share and the one all Plugins have (fair.rs).
        let serve: Arc<dyn Serve> = Arc::new(fair::Fair {
            inner: Arc::clone(&self.serve),
            mine: Arc::clone(
                self.plugin_gates
                    .lock()
                    .expect("plugin gates")
                    .entry(manifest.name.clone())
                    .or_insert_with(|| fair::Gate::new(fair::PLUGIN_AT_ONCE)),
            ),
            all: Arc::clone(&self.all_plugins),
        });
        let (limits, serving, offline) = (self.limits, Arc::clone(serving), self.offline);
        let sessions = Arc::clone(&self.sessions);
        let builtins = Arc::clone(&self.builtins);
        let storage = self.data.get().map(|d| folder::Storage::new(d, &name));
        let network = network::Setup {
            proxy: Arc::clone(proxy),
            log: Arc::clone(self.logs.lock().expect("plugin logs").entry(name.clone()).or_default()),
        };
        let asks = |p: &Permission| {
            matches!(
                p,
                Permission::Network(_) | Permission::Serve(_) | Permission::InventoryRead
            )
        };
        let post: Option<runtime::Post> = grants.iter().any(asks).then(|| {
            let (slots, listener, plugin) = (Arc::clone(&self.slots), Arc::clone(&self.listener), name.clone());
            let waits = Arc::clone(&serving);
            Arc::new(move |id: u64, answer: runtime::Arrival| {
                deliver(&slots, &listener, limits, &plugin, generation, Job::Answer(id, answer));
                waits.requests.fetch_sub(1, Ordering::SeqCst);
            }) as runtime::Post
        });
        let spawned = std::thread::Builder::new()
            .name(format!("plugin:{name}"))
            .spawn(move || {
                let runtime = runtime::Runtime::new(
                    &name,
                    &version,
                    &dir,
                    &config,
                    grants,
                    serve,
                    limits.memory,
                    limits.call,
                    post,
                    offline,
                    storage,
                    serving,
                    generation,
                    network,
                    sessions,
                    builtins,
                );
                // Ends when the host drops the Plugin's sender (unload, disable).
                for (job, reply) in rx {
                    let outcome = match &runtime {
                        Err(e) => Outcome {
                            result: Json::Null,
                            ops: Vec::new(),
                            error: Some(e.clone()),
                            stale: false,
                        },
                        Ok(rt) => match job {
                            Job::Load(source) => rt.load(&source, limits.load),
                            Job::Call(handler, args, by) => rt.call(handler, &args, by),
                            Job::Answer(id, answer) => rt.answer(id, answer),
                            Job::Event(event) => {
                                if runtime::may_hear_this(&event.name, &event.payload, rt.grants()) {
                                    rt.event(&event)
                                } else {
                                    Outcome {
                                        result: Json::Null,
                                        ops: Vec::new(),
                                        error: None,
                                        stale: false,
                                    }
                                }
                            }
                        },
                    };
                    let listens = match &runtime {
                        Ok(rt) => EVENTS
                            .iter()
                            .map(|(n, _)| *n)
                            .filter(|n| rt.listens(n))
                            .map(String::from)
                            .collect(),
                        Err(_) => Vec::new(),
                    };
                    let _ = reply.send((outcome, listens));
                }
            });
        if let Err(e) = spawned {
            eprintln!("plugin {}: couldn't start its thread: {e}", manifest.name);
        }
        tx
    }
}

/// Runs `job` (an answer nobody waits for) in the Plugin, if it's still the load that asked,
/// and hands what it did to the listener.
fn deliver(slots: &Slots, listener: &Mutex<Option<Listener>>, limits: Limits, plugin: &str, generation: u64, job: Job) {
    let target = match slots.lock().expect("plugin slots").get(plugin) {
        Some(slot) if slot.generation == generation && slot.disabled.is_none() => {
            slot.jobs.clone().map(|j| (j, Arc::clone(&slot.serving)))
        }
        _ => None,
    };
    let Some((jobs, serving)) = target else { return };
    let start = Instant::now();
    let answer = send(&jobs, job).and_then(|rx| wait(&rx, start, limits.call + limits.grace, &serving));
    let reply = settle(slots, limits, plugin, Some(generation), answer);
    if reply.ops.is_empty() && reply.error.is_none() {
        return;
    }
    let listener = listener.lock().expect("plugin listener").clone();
    if let Some(l) = listener {
        l(reply);
    }
}

/// Records how a call went: errors count toward disabling, and a call that never came back
/// disables at once. With `generation`, only for that load of the Plugin.
fn settle(slots: &Slots, limits: Limits, plugin: &str, generation: Option<u64>, answer: Option<Answer>) -> Reply {
    let mut slots = slots.lock().expect("plugin slots");
    let slot = match slots.get_mut(plugin) {
        Some(slot) if generation.is_none_or(|g| g == slot.generation) => slot,
        // Reloaded or removed since: the answer is for a Plugin that isn't there any more.
        _ if generation.is_some() => {
            return Reply {
                plugin: plugin.to_string(),
                result: Json::Null,
                ops: Vec::new(),
                error: None,
                disabled: None,
            };
        }
        _ => {
            return Reply::failed(
                plugin,
                PluginError::new(plugin, None, None, "it isn't loaded".into()),
                None,
            );
        }
    };
    let Some((outcome, listens)) = answer else {
        let why = format!(
            "it didn't answer within {} ms",
            (limits.call + limits.grace).as_millis()
        );
        disable(slot, &why);
        return Reply::failed(plugin, PluginError::new(plugin, None, None, why.clone()), Some(why));
    };
    slot.listens = listens;
    let mut disabled = None;
    if outcome.error.is_some() && !outcome.stale {
        slot.errors += 1;
        if slot.errors >= limits.strikes {
            let why = format!("it failed {} times", slot.errors);
            disable(slot, &why);
            disabled = Some(why);
        }
    }
    Reply {
        plugin: plugin.to_string(),
        result: outcome.result,
        ops: outcome.ops,
        error: outcome.error,
        disabled,
    }
}

fn disable(slot: &mut Slot, why: &str) {
    slot.disabled = Some(why.to_string());
    // Dropping the sender ends the thread once it's done (or, stuck in C, when that call ends).
    slot.jobs = None;
}

fn send(tx: &Jobs, job: Job) -> Option<Receiver<Answer>> {
    let (reply, rx) = channel();
    tx.send((job, reply)).ok()?;
    Some(rx)
}

/// Waits for a Plugin's answer until `wall` after `start`, plus however long its thread spent
/// waiting for roster serve meanwhile (decision Q103): serve's queue isn't the Plugin's fault.
fn wait(rx: &Receiver<Answer>, start: Instant, wall: Duration, serving: &ServeWait) -> Option<Answer> {
    let before = serving.total();
    loop {
        let deadline = start + wall + serving.total().saturating_sub(before);
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return rx.try_recv().ok();
        }
        // While it waits for serve the deadline moves, so look again soon.
        let step = if serving.busy() { left.min(SERVE_LOOK) } else { left };
        match rx.recv_timeout(step) {
            Ok(answer) => return Some(answer),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return None,
        }
    }
}

/// The Sessions open now, each one's id and Host (`None`: a Quick Connect Session), in the order
/// the app saw them open: what `roster.sessions.list()` gives (decision Q127). The app sends the
/// whole list on start and whenever it changes, and each list replaces the last, so nothing here
/// depends on the order its events arrive in, and a reloaded webview's tab ids start clean.
#[derive(Default)]
pub(crate) struct OpenSessions(Mutex<Vec<(u64, Option<String>)>>);

impl OpenSessions {
    /// Every open Session, in the app's order.
    pub(crate) fn list(&self) -> Vec<(u64, Option<String>)> {
        self.0.lock().expect("open sessions").clone()
    }
}

/// How often the host looks again at a Plugin waiting for roster serve.
const SERVE_LOOK: Duration = Duration::from_millis(50);

/// What one Plugin waits for: how long its thread has spent waiting for roster serve
/// (`roster.serve.call`, the `roster.inventory` reads), so the host's wall clock leaves it out
/// (decision Q103), and how many of its requests haven't answered yet.
#[derive(Default)]
pub(crate) struct ServeWait {
    serve: Mutex<(Duration, Option<Instant>)>,
    /// `roster.serve.request` and `roster.http` requests not yet answered and run.
    pub(crate) requests: std::sync::atomic::AtomicUsize,
}

impl ServeWait {
    /// The thread starts waiting for serve.
    pub(crate) fn begin(&self) {
        self.serve.lock().expect("serve wait").1 = Some(Instant::now());
    }

    /// serve answered.
    pub(crate) fn end(&self) {
        let mut w = self.serve.lock().expect("serve wait");
        if let Some(since) = w.1.take() {
            w.0 += since.elapsed();
        }
    }

    /// All the time spent waiting so far, the wait going on included.
    fn total(&self) -> Duration {
        let w = self.serve.lock().expect("serve wait");
        w.0 + w.1.map_or(Duration::ZERO, |since| since.elapsed())
    }

    fn busy(&self) -> bool {
        self.serve.lock().expect("serve wait").1.is_some()
    }
}

/// Reads the manifest in `dir` (`roster-plugin.lua`): a Lua file that returns a table, run in
/// the sandbox with no `roster` module, so reading it can't do anything.
pub fn read_manifest(dir: &Path) -> Result<Manifest, PluginError> {
    let shown = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.display().to_string());
    let fail = |message: String| PluginError::new(&shown, Some(MANIFEST.into()), None, message);
    if std::fs::symlink_metadata(dir.join(MANIFEST)).is_err() {
        return Err(fail(format!(
            "{} has no {MANIFEST}: is it a roster Plugin?",
            dir.display()
        )));
    }
    // Its real path must be in the Plugin's folder (ticket 82), like every file of the Plugin.
    let real = folder::inside(dir, Path::new(MANIFEST)).map_err(fail)?;
    let source = std::fs::read_to_string(real).map_err(|e| fail(format!("can't read it: {e}")))?;
    manifest_from(&source, &shown)
}

/// The manifest `source` gives (a `roster-plugin.lua`'s text, read before any of the Plugin's
/// code runs); errors name the Plugin as `shown` (its folder's name). Packages read a new
/// version's this way, before moving to it.
pub fn manifest_from(source: &str, shown: &str) -> Result<Manifest, PluginError> {
    let fail = |line: Option<u32>, message: String| PluginError::new(shown, Some(MANIFEST.into()), line, message);
    let source = source.to_string();
    let (tx, rx) = channel();
    std::thread::Builder::new()
        .name("plugin manifest".into())
        .spawn(move || {
            let run = || -> Result<Json, crate::config::ConfigError> {
                let internal = |e: mlua::Error| crate::config::ConfigError {
                    file: MANIFEST.into(),
                    line: None,
                    message: format!("couldn't start Lua: {e}"),
                    path: Vec::new(),
                };
                let (l, clock) = lua::sandboxed(4 * 1024 * 1024, None, MANIFEST.into()).map_err(internal)?;
                clock.start(Duration::from_millis(200));
                let value: mlua::Value = l
                    .load(&source)
                    .set_name(format!("@{MANIFEST}"))
                    .set_mode(mlua::chunk::ChunkMode::Text)
                    .call(())
                    .map_err(|e| lua::from_lua_error(&e))?;
                lua::to_json(&value, &std::cell::Cell::new(lua::Budget::default())).map_err(|e| {
                    crate::config::ConfigError {
                        file: MANIFEST.into(),
                        line: None,
                        message: crate::config::located_message(&e.path, &e.message),
                        path: Vec::new(),
                    }
                })
            };
            let _ = tx.send(run());
        })
        .map_err(|e| fail(None, format!("couldn't start Lua: {e}")))?;
    let value = match rx.recv_timeout(Duration::from_secs(1)) {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return Err(fail(e.line, e.message)),
        Err(_) => return Err(fail(None, "took too long to read".into())),
    };
    parse_manifest(&value).map_err(|m| fail(None, m))
}

fn parse_manifest(v: &Json) -> Result<Manifest, String> {
    let Json::Object(m) = v else {
        return Err("it must return a table: { name = …, version = …, permissions = { … } }".into());
    };
    for key in m.keys() {
        if !MANIFEST_FIELDS.contains(&key.as_str()) {
            return Err(format!(
                "{key}: not a manifest field (there's {})",
                MANIFEST_FIELDS.join(", ")
            ));
        }
    }
    let text = |key: &str| m.get(key).and_then(Json::as_str).map(str::to_string);
    let name = text("name").ok_or("name: missing (a name like \"recent-alerts\")")?;
    let valid = !name.is_empty()
        && name.len() <= 40
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ["builtin", "init", "roster"].contains(&name.as_str()) {
        return Err(format!("name: {name:?} is kept for roster's own use"));
    }
    if !valid {
        return Err(format!(
            "name: {name:?} isn't a Plugin name (lower case letters, digits and -, starting with a letter; at most 40)"
        ));
    }
    let version = text("version").ok_or("version: missing (\"1.0.0\")")?;
    let api = m
        .get("api")
        .and_then(Json::as_u64)
        .ok_or("api: missing (the roster.api_version it was written for)")?;
    if api > u64::from(API_VERSION) {
        return Err(format!(
            "api: it needs roster's Plugin API {api}, and this app has {API_VERSION}: update the app"
        ));
    }
    let mut permissions = Vec::new();
    match m.get("permissions") {
        None => {}
        Some(Json::Array(list)) => {
            for p in list {
                let p = p
                    .as_str()
                    .ok_or("permissions: a list of names such as \"inventory.read\"")?;
                let p = Permission::parse(p).map_err(|e| format!("permissions: {e}"))?;
                if !permissions.contains(&p) {
                    permissions.push(p);
                }
            }
        }
        Some(Json::Object(o)) if o.is_empty() => {}
        Some(_) => return Err("permissions: a list of names such as \"inventory.read\"".into()),
    }
    let sites: Vec<network::Site> = permissions
        .iter()
        .filter_map(|p| match p {
            Permission::Network(site) => Some(site.clone()),
            _ => None,
        })
        .collect();
    network::check_together(&sites).map_err(|e| format!("permissions: {e}"))?;
    Ok(Manifest {
        name,
        version,
        description: text("description").unwrap_or_default(),
        author: text("author"),
        api: api as u32,
        permissions,
    })
}

/// The folder `:plugins install PATH` means: `~/…` under `home`, an absolute path as it is, and
/// anything else under the config dir (`plugins/recent-alerts`).
pub fn resolve_dir(text: &str, config_dir: Option<&Path>, home: Option<&Path>) -> Result<PathBuf, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("which folder? :plugins install PATH".into());
    }
    let path = if let Some(rest) = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")) {
        home.ok_or("there's no home folder to put ~ in")?.join(rest)
    } else if Path::new(text).is_absolute() {
        PathBuf::from(text)
    } else {
        config_dir
            .ok_or("there's no config folder: give a full path")?
            .join(text)
    };
    if !path.is_dir() {
        return Err(format!("{} isn't a folder", path.display()));
    }
    path.canonicalize().map_err(|e| format!("{}: {e}", path.display()))
}
