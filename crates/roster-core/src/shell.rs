//! The app's command surface: every command the Tauri shell registers (app/src-tauri/src/lib.rs,
//! [`COMMANDS`]) is a method here, so the shell only adapts Tauri's arguments, channels and events
//! to it, and the end-to-end bridge (`bridge`, the `bridge` feature) runs the same surface without
//! Tauri. Each method blocks: the shell runs the slow ones on a blocking thread.

use crate::backend::{
    Backend, BackendInfo, CheckStarted, CreateCancel, Open, OpenedSession, QuickTarget, Typed, timeout_for,
};
use crate::config::{self, Config, Loader, Report};
use crate::detect::BackendError;
use crate::package::{self, Packages};
use crate::plugin::{self, Permission, PluginHost};
use crate::rpc::{CallError, Notify};
use crate::session::{Hop, SessionError, SessionEvent, SessionId, SessionManager, Size};
use crate::slot::Slot;
use crate::state::StateFile;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[cfg(feature = "bridge")]
pub mod bridge;

/// The commands the shell registers, in `tauri::generate_handler!`'s order. A test reads lib.rs's
/// list and compares (tests/shell.rs), so the two can't drift.
pub const COMMANDS: &[&str] = &[
    "backend_connect",
    "inventory_create",
    "inventory_create_cancel",
    "open_url",
    "serve_call",
    "host_check",
    "host_check_stop",
    "host_key_trust",
    "folders_read",
    "session_open",
    "quick_session_open",
    "session_write",
    "session_fill",
    "session_resize",
    "session_close",
    "state_load",
    "state_save",
    "platform_info",
    "config_load",
    "config_open",
    "config_reload",
    "config_import_preview",
    "config_import_apply",
    "config_types",
    "plugin_manifest",
    "plugin_types",
    "plugin_load",
    "plugin_call",
    "plugin_event",
    "plugin_sessions",
    "plugin_unload",
    "plugin_forget",
    "plugin_demo_start",
    "plugin_demo_stop",
    "plugin_requests",
    "plugin_data",
    "packages_sync",
    "packages_pin",
    "packages_discard",
    "packages_remove",
    "packages_check",
    "packages_apply",
    "packages_clean",
];

/// An event for the frontend (`config-changed`, `config-stale`, `roster-notification`,
/// `plugin-reply`, `plugin-demo-reply`) and its payload. Only fails once nobody is listening.
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// How long the window waits for init.lua before it shows. A slower Config arrives as a
/// `config-changed` event.
pub const CONFIG_STARTUP_WAIT: std::time::Duration = std::time::Duration::from_millis(300);

const NO_CONFIG_DIR: &str = "there's no config folder: the environment names no home";

/// Where the app keeps its things.
pub struct Places {
    /// The config dir (init.lua, roster.lock, folders.yml); None when the environment names no home.
    pub config: Option<PathBuf>,
    /// The app's own data dir (the State, Packages' clones, Plugins' data folders).
    pub data: Option<PathBuf>,
}

impl Places {
    /// The config dir as roster-core finds it, and the data dir `env::data_dir` picks over the
    /// OS's `app_local` one.
    pub fn of_system(app_local: impl FnOnce() -> Option<PathBuf>) -> Places {
        Places {
            config: config::dir(),
            data: crate::env::data_dir(app_local),
        }
    }
}

/// The one `roster serve` for this app launch, once started. Starting happens outside the lock
/// that `get` takes ([`Slot`]), so a command never waits for a start.
#[derive(Default)]
struct BackendSlot(Slot<Backend>);

impl BackendSlot {
    fn get(&self) -> Result<Arc<Backend>, CallError> {
        self.0.get().ok_or(CallError::Io {
            message: "the backend isn't running".into(),
        })
    }
}

/// Plugins reach `roster serve` through the running Backend, for the methods their permissions
/// name (the plugin module checks them; none touches a secret).
struct PluginServe(Arc<BackendSlot>);

impl plugin::Serve for PluginServe {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let backend = self.0.get().map_err(|e| e.to_string())?;
        backend.call(method, params).map_err(|e| e.to_string())
    }
}

/// The host a Plugin command means: demo `on_demo`'s (only while it's the one running), or the app's.
enum PluginTarget {
    App(Arc<PluginHost>),
    Demo(Arc<plugin::DemoHost>),
}

impl std::ops::Deref for PluginTarget {
    type Target = PluginHost;
    fn deref(&self) -> &PluginHost {
        match self {
            PluginTarget::App(h) => h,
            PluginTarget::Demo(h) => h,
        }
    }
}

/// A demo's reply nobody asked for, with the demo's number so an old demo's never reaches a new one.
#[derive(serde::Serialize, Clone)]
struct DemoReply {
    demo: u64,
    reply: plugin::Reply,
}

/// A password typed for a Session, if one was: moved into serve's request, which is wiped once sent.
fn typed(password: Option<String>, save: Option<bool>) -> Option<Typed> {
    password.map(|password| Typed {
        password,
        save: save.unwrap_or(false),
    })
}

fn session_error(e: SessionError) -> CallError {
    CallError::Io { message: e.to_string() }
}

/// `plugin_proxy` from a Config (decision Q116); the Config's check refused a bad one, so a
/// value here parses.
fn plugin_proxy(config: &Config) -> Option<plugin::network::Proxy> {
    config
        .plugin_proxy
        .as_deref()
        .and_then(|p| plugin::network::Proxy::parse(p).ok())
}

fn emit_json(emit: &Emit, event: &str, payload: impl serde::Serialize) {
    emit(event, serde_json::to_value(payload).unwrap_or(Value::Null));
}

/// A reload's Config reaches the running Plugins' proxy setting, then the frontend hears of it.
fn config_changed(plugins: &PluginHost, emit: &Emit, report: &Report) {
    plugins.set_proxy(plugin_proxy(&report.config));
    emit_json(emit, "config-changed", report);
}

/// Everything the commands reach: the Backend, the Config, Plugins (the app's and a tutorial's
/// demo), Packages, Sessions and the State.
pub struct Shell {
    backend: Arc<BackendSlot>,
    config: Option<Arc<Loader>>,
    packages: Option<Arc<Packages>>,
    plugins: Arc<PluginHost>,
    demo: plugin::demo::DemoSlot,
    sessions: Arc<SessionManager>,
    create: CreateCancel,
    data: Option<PathBuf>,
    emit: Emit,
    watcher: Mutex<Option<config::Watcher>>,
}

impl Shell {
    /// The app's surface over `places`, telling the frontend through `emit`. Nothing is read or
    /// started yet: [`Shell::start_config`] reads init.lua and watches it.
    pub fn new(places: Places, emit: Emit) -> Shell {
        let config = places.config.map(|dir| {
            if let Some(line) = crate::migrate::config_at_start(&dir) {
                eprintln!("roster: {line}");
            }
            Arc::new(Loader::new(&dir))
        });
        let backend = Arc::new(BackendSlot::default());
        let plugins = Arc::new(PluginHost::new(
            Arc::new(PluginServe(Arc::clone(&backend))),
            plugin::Limits::default(),
        ));
        // What a Plugin did when one of its requests answered (`roster.http`, the `network`
        // permission, or `roster.serve.request`): nobody asked, so it goes to the frontend.
        let to_frontend = Arc::clone(&emit);
        plugins.set_listener(Arc::new(move |reply: plugin::Reply| {
            emit_json(&to_frontend, "plugin-reply", reply)
        }));
        // Packages' clones and each Plugin's own data folder (plugin-data/NAME, decision Q93) go
        // in the app's own data dir, next to the State; roster.lock goes next to init.lua.
        if let Some(data) = &places.data {
            plugins.set_data(data);
        }
        let packages = match (&places.data, &config) {
            (Some(data), Some(loader)) => Some(Arc::new(Packages::new(data, loader.dir()))),
            _ => None,
        };
        Shell {
            backend,
            config,
            packages,
            plugins,
            demo: Default::default(),
            sessions: Arc::new(SessionManager::new()),
            create: CreateCancel::default(),
            data: places.data,
            emit,
            watcher: Mutex::new(None),
        }
    }

    /// Reads init.lua (waiting at most [`CONFIG_STARTUP_WAIT`]), then watches its dir: after a
    /// save it emits `config-changed` (with `auto_reload = true`) or `config-stale`.
    /// `config-changed` also comes once the first load is done.
    pub fn start_config(&self) {
        let Some(loader) = &self.config else { return };
        let (plugins, emit) = (Arc::clone(&self.plugins), Arc::clone(&self.emit));
        loader.reload_within(CONFIG_STARTUP_WAIT, move |report| {
            if let Some(e) = &report.error {
                eprintln!("roster: {e}");
            }
            config_changed(&plugins, &emit, &report);
        });
        let (plugins, emit, l) = (Arc::clone(&self.plugins), Arc::clone(&self.emit), Arc::clone(loader));
        // A save reloads only with `auto_reload = true` (decision Q58); otherwise the frontend
        // hears that the file changed, and `:source` applies it.
        // folders.yml (decision Q46) is only read once now, to move its Folders into the Folders
        // Plugin (ticket 61, decision Q93), and isn't watched.
        match config::watch(loader.dir(), move || match l.on_save() {
            Some(report) => config_changed(&plugins, &emit, &report),
            None => emit("config-stale", Value::Null),
        }) {
            Ok(w) => *self.watcher.lock().unwrap() = Some(w),
            Err(e) => eprintln!("roster: can't watch {} for changes: {e}", loader.dir().display()),
        }
    }

    /// The app is closing: every Session ends, and a tutorial still running stops its Plugins
    /// and takes their throwaway files away.
    pub fn exit(&self) {
        self.sessions.close_all();
        drop(self.demo.stop_any());
    }

    fn settled_config(&self) -> Arc<Config> {
        self.config.as_ref().map(|l| l.settled()).unwrap_or_default()
    }

    fn config_dir(&self) -> Result<PathBuf, String> {
        self.config
            .as_ref()
            .map(|l| l.dir().to_path_buf())
            .ok_or_else(|| NO_CONFIG_DIR.into())
    }

    /// Find and start the Backend (or return the running one). Errors explain what to fix. It
    /// reads the Config first: at startup that waits for init.lua's first load (at most the Lua
    /// wall-clock limit) rather than starting the default roster. Which roster runs comes from
    /// the Config (`roster_command`, `backend`), with the development env vars winning; a change
    /// takes effect at the next (re)start.
    pub fn backend_connect(&self, restart: bool) -> Result<BackendInfo, BackendError> {
        let config = self.settled_config();
        // serve's notifications (`inventory.changed`, ticket 28; `job.progress`, API 21) go to the
        // frontend as one event.
        let emit = Arc::clone(&self.emit);
        let notify: Notify = Arc::new(move |method: &str, params: Value| {
            emit("roster-notification", json!({ "method": method, "params": params }))
        });
        let backend = self.backend.0.connect(restart, Backend::is_alive, || {
            Backend::start(&crate::detect::for_config(&config)?, Some(notify))
        })?;
        Ok(backend.info.clone())
    }

    /// The first-run dialog (T212): with no Inventory, `inventory.create` on a serve started for
    /// that one call ([`Backend::create_inventory`]). serve writes roster.yml (ADR 0001); the
    /// frontend then connects again. The params are the dialog's choice: how, a folder, a path or
    /// a URL. Nothing secret is in them.
    pub fn inventory_create(&self, params: Value) -> Result<Value, CallError> {
        let config = self.settled_config();
        let c = crate::detect::for_config(&config).map_err(|e| CallError::Io { message: e.message })?;
        Backend::create_inventory(&c, params, &self.create)
    }

    /// The first-run dialog's Cancel (#417 L5): the serve making the Inventory stops (a clone
    /// under way is killed, and what it left taken away). False when nothing was under way.
    pub fn inventory_create_cancel(&self) -> bool {
        self.create.cancel()
    }

    /// A Host's web service in the default browser (ticket 18): only an http or https URL with no
    /// user or password in it (browser.rs checks it again; the frontend checked it first).
    pub fn open_url(&self, url: &str) -> Result<(), String> {
        crate::browser::open_url(url)
    }

    /// A serve method the frontend calls as it is (serve_api.rs `PASS_THROUGH`; any other is
    /// refused), waiting as long as [`timeout_for`] says for that method. The params can hold a
    /// typed password or vault secret (`vault.unlock`, `vault.login`, `host.add`) on its way to
    /// serve's stdin: moved into the request and wiped with it, never logged, stored or put in an
    /// error.
    pub fn serve_call(&self, method: &str, params: Value) -> Result<Value, CallError> {
        self.backend.get()?.pass(method, params)
    }

    /// roster's diagnostics for one Host (`host.check`): its steps in order, stopping at the first
    /// failure, at most one connection and one login (safe on a rate-limited network). From serve
    /// API 21 it's a job in serve, followed by [`Backend::check_host`]. `started` hears the
    /// check's job once serve has it under way, and whether it's the app's own to stop
    /// (`host_check_stop`, #221 item 1); an older serve sends none.
    pub fn host_check(&self, host: &str, started: impl FnOnce(&CheckStarted)) -> Result<Value, CallError> {
        self.backend.get()?.check_host(host, timeout_for("host.check"), started)
    }

    /// Stop in the `:check` panel (#221 item 1): stops a check of the app's own at its next step
    /// (serve's `jobs.stop`). Another caller's check isn't stopped.
    pub fn host_check_stop(&self, job: &str) -> Result<Value, CallError> {
        self.backend.get()?.stop_check(job)
    }

    /// Record the host key the user trusted (`host.trust_key`, ticket 36): serve fetches it again
    /// and refuses if it changed since the question.
    pub fn host_key_trust(&self, host: &str, fingerprint: &str) -> Result<Value, CallError> {
        self.backend.get()?.trust_host_key(host, fingerprint)
    }

    /// `folders.yml`'s path and text (null: no file yet), next to init.lua (decision Q46): read at
    /// start, for the Folders Plugin to move its Folders in once (ticket 61). Never written now.
    pub fn folders_read(&self) -> Result<Value, String> {
        let dir = self.config_dir()?;
        let text = config::folders::read(&dir).map_err(|e| e.to_string())?;
        Ok(json!({ "path": config::folders::path(&dir).display().to_string(), "text": text }))
    }

    /// Open a Session to `host` in a PTY of `size` ([`Backend::open_session`]): `session.prepare`
    /// right before the spawn, so every open gets a fresh askpass token. Refusals keep roster's
    /// code (2 unknown, 20 not reviewed, 21 box not set up, 11/12/14 the password Host's vault, 44
    /// no host key). For an `auth: prompt` Host (ticket 16) the app sends the `password` the user
    /// typed, and `save` asks serve to hold it for "Save to vault". `marks` is the token roster's
    /// shell hooks put on this attempt's marks (decision Q131 (a)). Output goes to `sink`.
    pub fn session_open(
        &self,
        host: String,
        password: Option<String>,
        save: Option<bool>,
        marks: Option<String>,
        size: Size,
        sink: impl Fn(SessionEvent) + Send + Sync + 'static,
    ) -> Result<OpenedSession, CallError> {
        let open = Open::Host {
            host,
            typed: typed(password, save),
            marks,
        };
        self.backend.get()?.open_session(&self.sessions, open, size, sink)
    }

    /// Open a Quick Connect Session (ticket 14): `quick.prepare` for `to` (user@address:port and
    /// the fingerprint the user was shown), then the command in a PTY, like `session_open`. With
    /// `save` ("Save to vault", ticket 15) serve holds the typed password for `quick.save`; only
    /// its id comes back.
    pub fn quick_session_open(
        &self,
        to: QuickTarget,
        password: Option<String>,
        save: Option<bool>,
        size: Size,
        sink: impl Fn(SessionEvent) + Send + Sync + 'static,
    ) -> Result<OpenedSession, CallError> {
        let open = Open::Quick {
            to,
            typed: typed(password, save),
        };
        self.backend.get()?.open_session(&self.sessions, open, size, sink)
    }

    /// Keystrokes or pasted text for a Session.
    pub fn session_write(&self, id: SessionId, data: &str) -> Result<(), CallError> {
        self.sessions.write(id, data.as_bytes()).map_err(session_error)
    }

    /// Fills the password prompt Session `id` shows (ticket 119, decision Q129;
    /// [`Backend::fill_session`]): `prompt` is the line the frontend read off the screen, `hop` a
    /// nested ssh's Host as it resolved it (ticket 120). Only the Host's name comes back; the
    /// password never reaches the frontend, a log or an error. What sudo's prompt drew that the
    /// mask check didn't take (ticket 155) goes to stderr with the app's other `roster:` lines,
    /// never to the error.
    pub fn session_fill(&self, id: SessionId, prompt: &str, hop: Option<Hop>) -> Result<Value, CallError> {
        self.backend
            .get()?
            .fill_session(&self.sessions, id, prompt, hop.as_ref(), |line| {
                eprintln!("roster: session {id}: {line}")
            })
    }

    pub fn session_resize(&self, id: SessionId, size: Size) -> Result<(), CallError> {
        self.sessions.resize(id, size).map_err(session_error)
    }

    /// Ends a Session (kills ssh); its exit message still arrives, with `closed: true`.
    pub fn session_close(&self, id: SessionId) -> Result<(), CallError> {
        self.sessions.close(id).map_err(session_error)
    }

    /// The State file (GLOSSARY: State) in the app's data folder: per Box, never roamed.
    fn state_file(&self) -> Result<StateFile, String> {
        self.data
            .as_deref()
            .map(StateFile::in_dir)
            .ok_or_else(|| "there's no app data folder for the State".into())
    }

    /// What the app remembered last time (`{}` the first time).
    pub fn state_load(&self) -> Result<Value, String> {
        Ok(self.state_file()?.load())
    }

    /// Replaces the remembered State (a JSON object; the frontend owns its shape).
    pub fn state_save(&self, state: &Value) -> Result<(), String> {
        self.state_file()?.save(state).map_err(|e| e.to_string())
    }

    /// Facts about this machine the terminal needs: the Windows build, for xterm's `windowsPty`.
    pub fn platform_info(&self) -> Value {
        json!({ "windowsBuild": crate::platform::windows_build() })
    }

    /// The Config as the app starts with it, and the error if init.lua couldn't be used. Waits
    /// for the first load if it's still running. Later changes arrive as `config-changed` events
    /// with the same shape.
    pub fn config_load(&self) -> Option<Report> {
        self.config.as_ref().and_then(|l| l.settled_report())
    }

    /// `:config` ([`config::edit`]): makes init.lua from the commented-out example if there's
    /// none, then opens it with the Config's `editor`; `$EDITOR` runs in the Backend's WSL distro.
    pub fn config_open(&self) -> Result<config::Opened, String> {
        let Some(loader) = &self.config else {
            return Err(NO_CONFIG_DIR.into());
        };
        let distro = self.backend.get().ok().and_then(|b| match &b.target {
            crate::detect::Target::Wsl { distro } => Some(distro.clone()),
            crate::detect::Target::Local => None,
        });
        config::edit(loader.dir(), loader.current().editor, distro.as_deref())
    }

    /// `:source` (and `:config reload`): reads init.lua again now, and tells every listener.
    pub fn config_reload(&self) -> Option<Report> {
        let Some(loader) = &self.config else {
            return None;
        };
        let report = loader.reload();
        config_changed(&self.plugins, &self.emit, &report);
        Some(report)
    }

    /// `:config import-terminal`, step 1: what it would write into init.lua, as a diff. Writes nothing.
    pub fn config_import_preview(&self) -> Result<crate::wt::Preview, String> {
        let dir = self.config_dir()?;
        let (path, text) = crate::wt::read_settings()?;
        crate::wt::preview(&dir, &text, &path, &crate::wt::today())
    }

    /// Step 2, after the user confirmed the diff: writes exactly the previewed file, or nothing.
    /// It refuses if init.lua (`base`) or Windows Terminal's settings (`result`) changed since the
    /// preview, asking for the import again. A save then reloads it as any save does.
    pub fn config_import_apply(&self, previewed: &crate::wt::Previewed) -> Result<(), String> {
        let dir = self.config_dir()?;
        let (path, text) = crate::wt::read_settings()?;
        crate::wt::apply(&dir, &text, &path, previewed)
    }

    /// `:config types` (ticket 141): writes init.lua's option types (LuaCATS, generated from the
    /// core's shape table) as `types/roster-config.lua` in the config folder; gives the file's path.
    pub fn config_types(&self) -> Result<String, String> {
        let dir = self.config_dir()?;
        // A first `:config types` before there's an init.lua makes the folder, as `:config` does.
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        config::shape::write_types(&dir).map(|f| f.display().to_string())
    }

    fn plugin_target(&self, on_demo: Option<u64>) -> Result<PluginTarget, String> {
        match on_demo {
            Some(id) => self.demo.get(id).map(PluginTarget::Demo),
            None => Ok(PluginTarget::App(Arc::clone(&self.plugins))),
        }
    }

    /// The host `on_demo` means, told the app's built-in commands when the call carries them.
    fn plugin_host(&self, builtins: Option<Vec<String>>, on_demo: Option<u64>) -> Result<PluginTarget, String> {
        let host = self.plugin_target(on_demo)?;
        if let Some(names) = builtins {
            host.set_builtins(names);
        }
        Ok(host)
    }

    /// The folder a Plugin path means (decision Q82): `~/…`, absolute, or under the config dir.
    fn plugin_dir(&self, path: &str) -> Result<PathBuf, String> {
        plugin::resolve_dir(path, self.config_dir().ok().as_deref(), plugin::home_dir().as_deref())
    }

    fn packages(&self) -> Result<&Packages, String> {
        self.packages
            .as_deref()
            .ok_or_else(|| "Packages need a config folder for roster.lock, and there's none".into())
    }

    /// The Packages init.lua names now (the last good Config). Waits for a reload in progress.
    fn package_specs(&self) -> Vec<config::PackageSpec> {
        self.settled_config().packages.clone()
    }

    /// Where a Plugin path leads, with the settings it's handed (a Package's from init.lua; only
    /// one init.lua names) and the path the frontend keeps.
    fn plugin_source(&self, path: &str) -> Result<(plugin::Source, Value, String), String> {
        match plugin::PluginPath::parse(path) {
            plugin::PluginPath::Builtin(name) => {
                Ok((plugin::Source::Bundled(name.to_string()), Value::Null, path.to_string()))
            }
            plugin::PluginPath::Package(name) => {
                let (dir, settings) = self.packages()?.loadable(&self.package_specs(), name)?;
                Ok((plugin::Source::Dir(dir), settings, path.to_string()))
            }
            plugin::PluginPath::Folder(text) => {
                let dir = self.plugin_dir(text)?;
                let shown = dir.display().to_string();
                Ok((plugin::Source::Dir(dir), Value::Null, shown))
            }
        }
    }

    /// `:plugins install PATH`, step 1: the manifest, for the permission prompt. Runs none of its code.
    pub fn plugin_manifest(&self, path: &str) -> Result<Value, String> {
        let (source, _, shown) = self.plugin_source(path)?;
        let plugin::Source::Dir(dir) = source else {
            return Err(format!("{path} is built into roster"));
        };
        let m = plugin::read_manifest(&dir).map_err(|e| e.to_string())?;
        Ok(json!({ "manifest": m, "dir": shown }))
    }

    /// `:plugins types PATH` (ticket 74): writes the Plugin API's stubs for this app's version as
    /// `types/roster.lua` in the Plugin folder PATH; gives the file's path.
    pub fn plugin_types(&self, path: &str) -> Result<String, String> {
        let dir = self.plugin_dir(path)?;
        plugin::api::write_stubs(&dir).map(|f| f.display().to_string())
    }

    /// Loads (or reloads) a Plugin with the permissions the user granted (on demo `on_demo`'s
    /// host, ticket 66).
    pub fn plugin_load(
        &self,
        path: &str,
        grants: &[String],
        settings: Option<Value>,
        builtins: Option<Vec<String>>,
        on_demo: Option<u64>,
    ) -> Result<Value, String> {
        let (grants, refused) = Permission::parse_grants(grants);
        let host = self.plugin_host(builtins, on_demo)?;
        // The user's proxy for its requests to public names, from the Config in effect (decision
        // Q116), handed to this load; a reload that changes it reaches it later (set_proxy).
        let proxy = self.config.as_ref().and_then(|l| plugin_proxy(&l.settled()));
        let (source, mut handed, shown) = self.plugin_source(path)?;
        // A built-in Plugin's settings come from the app (Folders: init.lua's Folders, and
        // folders.yml's to move in once); a Package's from init.lua, and a folder has none.
        if matches!(source, plugin::Source::Bundled(_))
            && let Some(given) = settings
        {
            handed = given;
        }
        let (manifest, reply) = host
            .load(&source, plugin::Load::new(&grants).config(handed).proxy(proxy))
            .map_err(|e| e.to_string())?;
        Ok(json!({ "manifest": manifest, "dir": shown, "reply": reply, "refused": refused }))
    }

    /// Runs a Plugin's handler. `user: false`: the app runs it on its own (a finder's items, a
    /// `:check`, a timer, a question's cancel because another took its place, a command a carried
    /// run's `roster.cmd` named), never the user's call. `carried`: the Plugin's own command its
    /// `roster.cmd` ran from the user's call, that call carried one hop (issue #183).
    #[allow(clippy::too_many_arguments)] // one per argument of the command
    pub fn plugin_call(
        &self,
        plugin: &str,
        handler: u64,
        args: Value,
        user: Option<bool>,
        carried: Option<bool>,
        builtins: Option<Vec<String>>,
        on_demo: Option<u64>,
    ) -> Result<plugin::Reply, String> {
        let host = self.plugin_host(builtins, on_demo)?;
        Ok(if user == Some(false) {
            host.call_by_app(plugin, handler, args)
        } else if carried == Some(true) {
            host.call_carried(plugin, handler, args)
        } else {
            host.call(plugin, handler, args)
        })
    }

    pub fn plugin_event(
        &self,
        name: String,
        payload: Value,
        builtins: Option<Vec<String>>,
        on_demo: Option<u64>,
    ) -> Result<Vec<plugin::Reply>, String> {
        let host = self.plugin_host(builtins, on_demo)?;
        Ok(host.event(plugin::Event { name, payload }))
    }

    /// The Sessions open now, `{ session, host, cwd }` in the order the app saw them open (a Quick
    /// Connect Session's host is null; `cwd` the folder its shell last said, OSC 7, or null): the
    /// whole list, replacing the last (`roster.sessions.list()`, decisions Q127 and Q185).
    pub fn plugin_sessions(&self, open: Vec<plugin::OpenSession>, on_demo: Option<u64>) -> Result<(), String> {
        self.plugin_target(on_demo)?.set_sessions(open);
        Ok(())
    }

    pub fn plugin_unload(&self, plugin: &str, on_demo: Option<u64>) -> bool {
        self.plugin_target(on_demo).is_ok_and(|h| h.unload(plugin))
    }

    /// Removes a Plugin's data folder with everything in it (decision Q93): `:plugins remove` and
    /// `:packages clean` call it once the Plugin is gone. A reload or a revoke never does.
    pub fn plugin_forget(&self, plugin: &str, on_demo: Option<u64>) -> Result<bool, String> {
        self.plugin_target(on_demo)?.forget(plugin)
    }

    /// A tutorial starts: a fresh demo Plugin host over `hosts` (`hosts.list`'s answer for the
    /// demo Inventory), in place of any older one. Its number is taken before the host is made,
    /// so a start that finishes after a newer one is turned away. Its replies nobody asked for go
    /// to the frontend as `plugin-demo-reply`, with the number. Gives the number.
    pub fn plugin_demo_start(&self, hosts: Value) -> Result<u64, String> {
        let id = self.demo.reserve();
        let host = plugin::DemoHost::new(hosts, plugin::Limits::default(), &std::env::temp_dir())?;
        let emit = Arc::clone(&self.emit);
        host.set_listener(Arc::new(move |reply: plugin::Reply| {
            emit_json(&emit, "plugin-demo-reply", DemoReply { demo: id, reply })
        }));
        drop(self.demo.install(id, host)?);
        Ok(id)
    }

    /// The tutorial ends: demo `id`'s Plugins stop and their throwaway files go (nothing, if it
    /// isn't the one running).
    pub fn plugin_demo_stop(&self, id: u64) -> Result<(), String> {
        drop(self.demo.stop(id));
        Ok(())
    }

    /// Each loaded Plugin's network requests by site since the app started, by its name, for
    /// `:plugins` (decision Q116): counts and a time, never a path, a query or a body.
    pub fn plugin_requests(&self) -> BTreeMap<String, Vec<plugin::network::SiteCount>> {
        self.plugins
            .list()
            .into_iter()
            .map(|s| (s.manifest.name, s.requests))
            .collect()
    }

    /// How full each named Plugin's data folder is, for `:plugins` (ticket 98): files and bytes
    /// as the caps count them, never what they hold. Loaded or not, so a stopped Plugin's shows too.
    pub fn plugin_data(&self, names: Vec<String>) -> Result<BTreeMap<String, plugin::folder::DataUse>, String> {
        Ok(names
            .into_iter()
            .map(|n| {
                let u = self.plugins.data_use(&n);
                (n, u)
            })
            .collect())
    }

    /// Clones what init.lua names and isn't cloned yet, and checks out what roster.lock pins.
    pub fn packages_sync(&self) -> Result<Vec<package::Status>, String> {
        Ok(self.packages()?.sync(&self.package_specs()))
    }

    /// Pins a Package in roster.lock: the user allowed its install prompt.
    pub fn packages_pin(&self, name: &str) -> Result<package::Status, String> {
        self.packages()?.pin(&self.package_specs(), name)
    }

    /// Removes a Package's clone: its install prompt was cancelled.
    pub fn packages_discard(&self, name: &str) -> Result<(), String> {
        self.packages()?.discard(name)
    }

    /// Removes a Package's clone and its roster.lock entry (`:plugins remove`).
    pub fn packages_remove(&self, name: &str) -> Result<(), String> {
        self.packages()?.remove(name)
    }

    /// `:packages update [NAME]`, step 1: fetches (every Package, or the one named), and describes
    /// each new commit. Changes nothing.
    pub fn packages_check(&self, name: Option<&str>) -> Result<Vec<package::Checked>, String> {
        let (packages, specs) = (self.packages()?, self.package_specs());
        match name {
            Some(name) => packages.check_named(&specs, name).map(|c| vec![c]),
            None => Ok(packages.check(&specs)),
        }
    }

    /// `:packages update`, step 2: moves a Package to the commit the user saw and allowed.
    pub fn packages_apply(&self, name: &str, commit: &str) -> Result<package::Status, String> {
        self.packages()?.apply(&self.package_specs(), name, commit)
    }

    /// `:packages clean`: removes the Packages init.lua no longer names; gives their names.
    pub fn packages_clean(&self) -> Result<Vec<String>, String> {
        self.packages()?.clean(&self.package_specs())
    }
}
