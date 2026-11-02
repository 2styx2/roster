//! The Tauri shell: window setup and thin `#[tauri::command]` wrappers over roster-core (Backend
//! calls, Sessions).
//! All logic lives in roster-core so it can be tested without Tauri (docs/app/dev/testing.md).

use roster_core::backend::{Backend, BackendInfo, QuickTarget};
use roster_core::config::{self, Config, Loader, Report};
use roster_core::detect::{BackendError, ErrorKind, Platform, SystemRunner, detect_choice};
use roster_core::package::{self, Packages};
use roster_core::plugin::{self, Permission, PluginHost};
use roster_core::rpc::{CallError, Notify};
use roster_core::session::{FillError, SessionError, SessionEvent, SessionId, SessionManager, Size};
use roster_core::slot::Slot;
use roster_core::state::StateFile;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};

/// The one `roster serve` for this app launch, once started. Starting happens outside the lock
/// that `get` takes (roster-core's Slot), so commands on the async workers never wait for a start.
#[derive(Default)]
struct BackendState(Slot<Backend>);

impl BackendState {
    /// The running Backend, starting one if there's none (or the last one died). Blocks for the
    /// whole detection and start: run it on a blocking thread.
    /// Which roster runs comes from the Config (`roster_command`, `backend`), with the
    /// development env vars winning; a change takes effect at the next (re)start.
    fn connect(&self, restart: bool, config: &Config, notify: Notify) -> Result<BackendInfo, BackendError> {
        let backend = self.0.connect(restart, Backend::is_alive, || {
            let env_cmd = roster_core::env::roster_override();
            let env_distro = roster_core::env::wsl_distro();
            let plan = config::backend_plan(config, Platform::current(), env_cmd.as_deref(), env_distro.as_deref())
                .map_err(|m| {
                    BackendError::new(
                        ErrorKind::Failed,
                        m,
                        "Fix it in init.lua (docs/app/config.md), then Retry.",
                    )
                })?;
            let candidate = detect_choice(&SystemRunner, Platform::current(), &plan.command, &plan.choice)?;
            Backend::start_with(&candidate, Some(notify))
        })?;
        Ok(backend.info.clone())
    }

    /// The running Backend. Never waits for one that's starting.
    fn get(&self) -> Result<Arc<Backend>, CallError> {
        self.0.get().ok_or(CallError::Io {
            message: "the backend isn't running".into(),
        })
    }
}

async fn blocking<T: Send + 'static, E: Send + 'static>(
    f: impl FnOnce() -> Result<T, E> + Send + 'static,
) -> Result<T, E> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .expect("backend task panicked")
}

/// Find and start the Backend (or return the running one). Errors explain what to fix.
/// It reads the Config on the blocking thread: at startup that waits for init.lua's first load
/// (at most the Lua wall-clock limit) rather than starting the default roster.
#[tauri::command]
async fn backend_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<BackendState>>,
    config: tauri::State<'_, ConfigState>,
    restart: bool,
) -> Result<BackendInfo, BackendError> {
    let s = Arc::clone(&state);
    let loader = config.0.clone();
    // serve's notifications (`inventory.changed`, ticket 28; `job.progress`, API 20) go to the
    // frontend as one event.
    let notify: Notify = Arc::new(move |method: &str, params: Value| {
        use tauri::Emitter;
        let _ = app.emit("roster-notification", json!({ "method": method, "params": params }));
    });
    blocking(move || {
        let config = loader.map(|l| l.settled()).unwrap_or_default();
        s.connect(restart, &config, notify)
    })
    .await
}

/// The Config (`init.lua`, roster-core config/): None when there's no config dir. roster-core's
/// Loader runs Lua outside the locks its readers take, so nothing here waits on Lua except
/// on a blocking thread.
#[derive(Clone)]
struct ConfigState(Option<Arc<Loader>>);

/// The Config as the app starts with it, and the error if init.lua couldn't be used. Waits for
/// the first load if it's still running (on a blocking thread). Later changes arrive as
/// `config-changed` events with the same shape.
#[tauri::command]
async fn config_load(config: tauri::State<'_, ConfigState>) -> Result<Option<Report>, ()> {
    let Some(loader) = config.0.clone() else {
        return Ok(None);
    };
    blocking(move || Ok(loader.settled_report())).await
}

/// A Host's web service in the default browser (ticket 18): only an http or https URL with no user
/// or password in it (roster-core browser.rs checks it again; the frontend checked it first).
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    blocking(move || roster_core::browser::open_url(&url)).await
}

/// What `:config` did: the file's path, and whether it was just made (ticket 32).
#[derive(serde::Serialize)]
struct ConfigOpened {
    path: String,
    created: bool,
}

/// `:config`: makes init.lua from the commented-out example if there's none (never overwriting
/// one), then opens it with the Config's `editor`. `$EDITOR` runs in the Backend's WSL distro.
#[tauri::command]
async fn config_open(
    config: tauri::State<'_, ConfigState>,
    state: tauri::State<'_, Arc<BackendState>>,
) -> Result<ConfigOpened, String> {
    let Some(loader) = config.0.clone() else {
        return Err("there's no config folder: the environment names no home".into());
    };
    let distro = state.get().ok().and_then(|b| match &b.target {
        roster_core::detect::Target::Wsl { distro } => Some(distro.clone()),
        roster_core::detect::Target::Local => None,
    });
    blocking(move || {
        let ensured =
            config::ensure_file(loader.dir()).map_err(|e| format!("can't create {}: {e}", loader.dir().display()))?;
        let how = config::open_with(
            loader.current().editor,
            config::Os::current(),
            &ensured.path,
            distro.as_deref(),
        )?;
        config::open(&how).map_err(|e| format!("can't open {}: {e}", ensured.path.display()))?;
        Ok(ConfigOpened {
            path: ensured.path.display().to_string(),
            created: ensured.created,
        })
    })
    .await
}

/// `:source` (and `:config reload`): reads init.lua again now, and tells every listener.
#[tauri::command]
async fn config_reload(app: tauri::AppHandle, config: tauri::State<'_, ConfigState>) -> Result<Option<Report>, ()> {
    let Some(loader) = config.0.clone() else {
        return Ok(None);
    };
    let report = blocking(move || Ok::<_, ()>(loader.reload())).await?;
    config_changed(&app, &report);
    Ok(Some(report))
}

/// Windows Terminal's settings.json: its path and text (ticket 33). Windows only.
fn wt_settings() -> Result<(String, String), String> {
    if !cfg!(windows) {
        return Err("import-terminal reads Windows Terminal's settings, so it works on Windows only".into());
    }
    let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA isn't set, so Windows Terminal can't be found")?;
    for path in roster_core::wt::settings_paths(std::path::Path::new(&local)) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            return Ok((path.display().to_string(), text));
        }
    }
    Err("no Windows Terminal settings.json found (Store, Preview or unpackaged)".into())
}

fn config_dir(config: &ConfigState) -> Result<std::path::PathBuf, String> {
    config
        .0
        .as_ref()
        .map(|l| l.dir().to_path_buf())
        .ok_or_else(|| "there's no config folder: the environment names no home".into())
}

/// `:config import-terminal`, step 1: what it would write into init.lua, as a diff. Writes nothing.
#[tauri::command]
async fn config_import_preview(config: tauri::State<'_, ConfigState>) -> Result<roster_core::wt::Preview, String> {
    let dir = config_dir(&config)?;
    blocking(move || {
        let (path, text) = wt_settings()?;
        roster_core::wt::preview(&dir, &text, &path, &roster_core::wt::today())
    })
    .await
}

/// Step 2, after the user confirmed the diff: writes exactly the previewed file, or nothing. It
/// refuses if init.lua (`base`) or Windows Terminal's settings (`result`) changed since the
/// preview, asking for the import again. A save then reloads it as any save does.
#[tauri::command]
async fn config_import_apply(
    config: tauri::State<'_, ConfigState>,
    previewed: roster_core::wt::Previewed,
) -> Result<(), String> {
    let dir = config_dir(&config)?;
    blocking(move || {
        let (path, text) = wt_settings()?;
        roster_core::wt::apply(&dir, &text, &path, &previewed)
    })
    .await
}

/// How long the window waits for init.lua before it shows. A slower Config arrives as a
/// `config-changed` event.
const CONFIG_STARTUP_WAIT: std::time::Duration = std::time::Duration::from_millis(300);

/// Reads init.lua (waiting at most CONFIG_STARTUP_WAIT), then watches its dir: after a save it
/// emits `config-changed` (with `auto_reload = true`) or `config-stale`. `config-changed` also
/// comes once the first load is done.
fn start_config(app: &tauri::App, loader: &Arc<Loader>) -> Option<config::Watcher> {
    use tauri::Emitter;
    let handle = app.handle().clone();
    loader.reload_within(CONFIG_STARTUP_WAIT, move |report| {
        if let Some(e) = &report.error {
            eprintln!("roster: {e}");
        }
        config_changed(&handle, &report);
    });
    let handle = app.handle().clone();
    let l = Arc::clone(loader);
    // A save reloads only with `auto_reload = true` (decision Q58); otherwise the frontend
    // hears that the file changed, and `:source` applies it.
    // folders.yml (decision Q46) is only read once now, to move its Folders into the Folders
    // Plugin (ticket 61, decision Q93), and isn't watched.
    match config::watch(loader.dir(), move || match l.on_save() {
        Some(report) => config_changed(&handle, &report),
        None => {
            let _ = handle.emit("config-stale", ());
        }
    }) {
        Ok(w) => Some(w),
        Err(e) => {
            eprintln!("roster: can't watch {} for changes: {e}", loader.dir().display());
            None
        }
    }
}

/// One call to serve, waiting as long as roster-core's `timeout_for` says for that method: longer
/// than serve's own deadline for it, so a slow call is answered rather than abandoned.
async fn call(state: &Arc<BackendState>, method: &'static str, params: Value) -> Result<Value, CallError> {
    let backend = state.get()?;
    blocking(move || backend.call(method, params)).await
}

#[tauri::command]
async fn hosts_list(state: tauri::State<'_, Arc<BackendState>>) -> Result<Value, CallError> {
    call(&state, "hosts.list", json!({})).await
}

/// `host.get`; `settled` (serve API 20) waits for a write to roster.yml under way, for the check
/// after a timed-out `host.add`. Sent only when true, so an older serve gets what it always did.
#[tauri::command]
async fn host_get(
    state: tauri::State<'_, Arc<BackendState>>,
    name: String,
    settled: Option<bool>,
) -> Result<Value, CallError> {
    let params = if settled == Some(true) {
        json!({ "name": name, "settled": true })
    } else {
        json!({ "name": name })
    };
    call(&state, "host.get", params).await
}

#[tauri::command]
async fn vault_status(state: tauri::State<'_, Arc<BackendState>>) -> Result<Value, CallError> {
    call(&state, "vault.status", json!({})).await
}

/// The master password passes through here once, on its way to serve's stdin. It's moved into the
/// request and dropped with it: never logged, stored or put in an error.
#[tauri::command]
async fn vault_unlock(state: tauri::State<'_, Arc<BackendState>>, password: String) -> Result<Value, CallError> {
    call(&state, "vault.unlock", json!({ "password": password })).await
}

/// One step of signing the vault CLI in (`vault.login`, ticket 31): start, answer or cancel.
/// The params can hold a master password, a two-step code or an API secret on their way to
/// serve's stdin. Like `vault_unlock`, they're moved into the request and dropped with it:
/// never logged, stored or put in an error.
#[tauri::command]
async fn vault_login(
    state: tauri::State<'_, Arc<BackendState>>,
    params: serde_json::Map<String, Value>,
) -> Result<Value, CallError> {
    call(&state, "vault.login", Value::Object(params)).await
}

#[tauri::command]
async fn vault_lock(state: tauri::State<'_, Arc<BackendState>>) -> Result<Value, CallError> {
    call(&state, "vault.lock", json!({})).await
}

/// Sign the vault CLI out (`vault.logout`, API 14, ticket 42): serve forgets every secret first,
/// then runs `bw logout`. No params and nothing secret in the answer: the account's email and
/// server, and the ways to sign in again.
#[tauri::command]
async fn vault_logout(state: tauri::State<'_, Arc<BackendState>>) -> Result<Value, CallError> {
    call(&state, "vault.logout", json!({})).await
}

/// This Box's vault settings from init.lua (`vault.configure`, API 10; tickets 35 and 41): paths
/// and choices only, never a secret. Sent at start and after every `:source`.
#[tauri::command]
async fn vault_configure(
    state: tauri::State<'_, Arc<BackendState>>,
    settings: serde_json::Map<String, Value>,
) -> Result<Value, CallError> {
    call(&state, "vault.configure", Value::Object(settings)).await
}

/// Where "Save to vault" can put an item, and the default (`vault.targets`, API 10; ticket 35).
#[tauri::command]
async fn vault_targets(state: tauri::State<'_, Arc<BackendState>>) -> Result<Value, CallError> {
    call(&state, "vault.targets", json!({})).await
}

/// roster's diagnostics for one Host (`host.check`, api 2): its steps in order, stopping at the
/// first failure. roster makes at most one connection and one login, so this is safe on 10.19.
/// From serve API 21 it's a job in serve, followed by the core (`Backend::check_host`), so no
/// worker of serve waits for it.
#[tauri::command]
async fn host_check(state: tauri::State<'_, Arc<BackendState>>, host: String) -> Result<Value, CallError> {
    let backend = state.get()?;
    blocking(move || backend.check_host(&host)).await
}

/// This Box's health (`box.check`, api 16, ticket 49): roster.yml, ssh, the vault CLIs, askpass and the
/// infra repo, each ok, warn or error with its fix. Every check is local: nothing connects to a Host.
#[tauri::command]
async fn box_check(state: tauri::State<'_, Arc<BackendState>>) -> Result<Value, CallError> {
    call(&state, "box.check", json!({})).await
}

/// Fast-forward the infra repo before an edit (`inventory.pull`, api 4, ticket 10). A fetch can take
/// a while on a slow link: serve holds it to its deadline, and the app waits longer (`timeout_for`).
#[tauri::command]
async fn inventory_pull(state: tauri::State<'_, Arc<BackendState>>) -> Result<Value, CallError> {
    call(&state, "inventory.pull", json!({})).await
}

/// One test login with a Host's new address, user or Login (`host.verify_login`, decision Q43):
/// one connection, one attempt. The password stays in roster.
#[tauri::command]
async fn host_verify_login(
    state: tauri::State<'_, Arc<BackendState>>,
    host: String,
    changes: serde_json::Map<String, Value>,
) -> Result<Value, CallError> {
    call(&state, "host.verify_login", json!({ "host": host, "changes": changes })).await
}

/// The edit, written into roster.yml as a Pending change (`host.update`).
#[tauri::command]
async fn host_update(
    state: tauri::State<'_, Arc<BackendState>>,
    host: String,
    changes: serde_json::Map<String, Value>,
) -> Result<Value, CallError> {
    call(&state, "host.update", json!({ "host": host, "changes": changes })).await
}

/// The Pending changes: roster.yml's uncommitted diff (`changes.diff`).
#[tauri::command]
async fn changes_diff(state: tauri::State<'_, Arc<BackendState>>) -> Result<Value, CallError> {
    call(&state, "changes.diff", json!({})).await
}

/// roster.yml back as the last commit has it (`changes.discard`).
#[tauri::command]
async fn changes_discard(state: tauri::State<'_, Arc<BackendState>>) -> Result<Value, CallError> {
    call(&state, "changes.discard", json!({})).await
}

/// Commit and push the Pending changes, then `roster sync` (`changes.publish`, ticket 12): never
/// forced. `message` is the commit message as the user left it.
#[tauri::command]
async fn changes_publish(state: tauri::State<'_, Arc<BackendState>>, message: String) -> Result<Value, CallError> {
    call(&state, "changes.publish", json!({ "message": message })).await
}

/// The host key an address offers (`host.scan_key`, ticket 11): key exchange only, never a login.
#[tauri::command]
async fn host_scan_key(
    state: tauri::State<'_, Arc<BackendState>>,
    address: String,
    port: u16,
) -> Result<Value, CallError> {
    call(&state, "host.scan_key", json!({ "address": address, "port": port })).await
}

/// The host key a Host offers, for the question a Session asks before its first connection to a
/// Host roster has no key for (`host.scan_key {host}`, ticket 36). Nothing is recorded.
#[tauri::command]
async fn host_key_scan(state: tauri::State<'_, Arc<BackendState>>, host: String) -> Result<Value, CallError> {
    let backend = state.get()?;
    blocking(move || backend.scan_host_key(&host)).await
}

/// Record the host key the user trusted (`host.trust_key`, ticket 36): serve fetches it again and
/// refuses if it changed since the question.
#[tauri::command]
async fn host_key_trust(
    state: tauri::State<'_, Arc<BackendState>>,
    host: String,
    fingerprint: String,
) -> Result<Value, CallError> {
    let backend = state.get()?;
    blocking(move || backend.trust_host_key(&host, &fingerprint)).await
}

/// Add a Host (`host.add`, decision Q43): test login, then the Vault item, then the Pending change.
/// The params can hold a typed password on its way to serve's stdin. Like `vault_unlock`'s, it's
/// moved into the request and dropped with it: never logged, stored or put in an error.
#[tauri::command]
async fn host_add(
    state: tauri::State<'_, Arc<BackendState>>,
    params: serde_json::Map<String, Value>,
) -> Result<Value, CallError> {
    call(&state, "host.add", Value::Object(params)).await
}

/// The Live Inventory (ticket 28): removing, renaming and moving Hosts, groups, `:source` for
/// roster.yml and the watch. Only these methods pass; each is a plain call to serve.
const INVENTORY_METHODS: &[&str] = &[
    "host.remove",
    "host.rename",
    "host.move",
    "group.new",
    "group.rename",
    "group.delete",
    "inventory.reload",
    "inventory.watch",
];

#[tauri::command]
async fn inventory_call(
    state: tauri::State<'_, Arc<BackendState>>,
    method: String,
    params: serde_json::Map<String, Value>,
) -> Result<Value, CallError> {
    let Some(&method) = INVENTORY_METHODS.iter().find(|m| **m == method) else {
        return Err(CallError::Io {
            message: format!("{method} isn't an Inventory method"),
        });
    };
    call(&state, method, Value::Object(params)).await
}

/// "Save to vault" after a Session's own login (tickets 15, 16): saving the typed password serve
/// holds, or forgetting it. They carry only ids and names, never the password (serve has it).
const SAVE_METHODS: &[&str] = &["quick.save", "host.save_login", "vault.forget_typed"];

#[tauri::command]
async fn save_call(
    state: tauri::State<'_, Arc<BackendState>>,
    method: String,
    params: serde_json::Map<String, Value>,
) -> Result<Value, CallError> {
    let Some(&method) = SAVE_METHODS.iter().find(|m| **m == method) else {
        return Err(CallError::Io {
            message: format!("{method} isn't a Save to vault method"),
        });
    };
    call(&state, method, Value::Object(params)).await
}

/// `folders.yml`'s path and text (null: no file yet), next to init.lua (decision Q46): read at
/// start, for the Folders Plugin to move its Folders in once (ticket 61). Never written now.
#[tauri::command]
async fn folders_read(config: tauri::State<'_, ConfigState>) -> Result<Value, String> {
    let dir = config_dir(&config)?;
    blocking(move || {
        let text = config::folders::read(&dir).map_err(|e| e.to_string())?;
        Ok(json!({ "path": config::folders::path(&dir).display().to_string(), "text": text }))
    })
    .await
}

/// Mark a Host reviewed (`host.review`): only that flag changes, as a Pending change. With
/// `reviewed: false` (API 9) it marks the Host unreviewed again; `reviewed` is sent only then, so a
/// review reads exactly as it did for an older roster.
#[tauri::command]
async fn host_review(
    state: tauri::State<'_, Arc<BackendState>>,
    host: String,
    reviewed: Option<bool>,
) -> Result<Value, CallError> {
    let params = if reviewed == Some(false) {
        json!({ "host": host, "reviewed": false })
    } else {
        json!({ "host": host })
    };
    call(&state, "host.review", params).await
}

/// Plugins reach `roster serve` through the running Backend, for the methods their permissions
/// name (roster-core's plugin module checks them; none touches a secret).
struct PluginServe(Arc<BackendState>);

impl plugin::Serve for PluginServe {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let backend = self.0.get().map_err(|e| e.to_string())?;
        backend.call(method, params).map_err(|e| e.to_string())
    }
}

/// `:tutor`'s demo (ticket 66, decision Q123): a Plugin host of its own while a tutorial runs,
/// over the demo Inventory's Hosts, offline, with throwaway data folders ([`plugin::DemoHost`]).
/// Each demo has a number; every demo command and reply names it ([`plugin::demo::DemoSlot`]).
#[derive(Default)]
struct DemoPlugins(plugin::demo::DemoSlot);

/// The host a Plugin command means: demo `demo`'s (only while it's the one running), or the app's.
fn plugin_host(plugins: &Arc<PluginHost>, demo: &DemoPlugins, on_demo: Option<u64>) -> Result<PluginTarget, String> {
    match on_demo {
        Some(id) => demo.0.get(id).map(PluginTarget::Demo),
        None => Ok(PluginTarget::App(Arc::clone(plugins))),
    }
}

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

/// A tutorial starts: a fresh demo Plugin host over `hosts` (`hosts.list`'s answer for the demo
/// Inventory), in place of any older one. Its number is taken before the host is made, so a start
/// that finishes after a newer one is turned away. Its replies nobody asked for go to the
/// frontend as `plugin-demo-reply`, with the number. Gives the number.
#[tauri::command]
async fn plugin_demo_start(
    app: tauri::AppHandle,
    demo: tauri::State<'_, DemoPlugins>,
    hosts: Value,
) -> Result<u64, String> {
    let id = demo.0.reserve();
    let host = blocking(move || plugin::DemoHost::new(hosts, plugin::Limits::default(), &std::env::temp_dir())).await?;
    host.set_listener(Arc::new(move |reply: plugin::Reply| {
        use tauri::Emitter;
        let _ = app.emit("plugin-demo-reply", DemoReply { demo: id, reply });
    }));
    let old = demo.0.install(id, host)?;
    blocking(move || {
        drop(old);
        Ok(id)
    })
    .await
}

/// The tutorial ends: demo `id`'s Plugins stop and their throwaway files go (nothing, if it isn't
/// the one running).
#[tauri::command]
async fn plugin_demo_stop(demo: tauri::State<'_, DemoPlugins>, id: u64) -> Result<(), String> {
    let old = demo.0.stop(id);
    blocking(move || {
        drop(old);
        Ok(())
    })
    .await
}

/// The folder a Plugin path means (decision Q82): `~/…`, absolute, or under the config dir.
fn plugin_dir(config: &ConfigState, path: &str) -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(std::path::PathBuf::from);
    plugin::resolve_dir(path, config_dir(config).ok().as_deref(), home.as_deref())
}

/// Where a Plugin path leads: `builtin:NAME` (built in), `package:NAME` (a Package's clone, with
/// its settings from init.lua; only one init.lua names), or a folder. The path given back is the
/// one the frontend keeps.
fn plugin_source(
    config: &ConfigState,
    packages: &PackagesState,
    path: &str,
) -> Result<(plugin::Source, Value, String), String> {
    if let Some(name) = path.strip_prefix("builtin:") {
        return Ok((plugin::Source::Bundled(name.to_string()), Value::Null, path.to_string()));
    }
    if let Some(name) = path.strip_prefix("package:") {
        let (dir, settings) = packages_of(packages)?.loadable(&package_specs(config), name)?;
        return Ok((plugin::Source::Dir(dir), settings, path.to_string()));
    }
    let dir = plugin_dir(config, path)?;
    let shown = dir.display().to_string();
    Ok((plugin::Source::Dir(dir), Value::Null, shown))
}

/// `:plugins install PATH`, step 1: the manifest, for the permission prompt. Runs none of its code.
#[tauri::command]
async fn plugin_manifest(
    config: tauri::State<'_, ConfigState>,
    packages: tauri::State<'_, PackagesState>,
    path: String,
) -> Result<Value, String> {
    let (config, packages) = (config.inner().clone(), packages.inner().clone());
    blocking(move || {
        let (source, _, shown) = plugin_source(&config, &packages, &path)?;
        let plugin::Source::Dir(dir) = source else {
            return Err(format!("{path} is built into roster"));
        };
        let m = plugin::read_manifest(&dir).map_err(|e| e.to_string())?;
        Ok(json!({ "manifest": m, "dir": shown }))
    })
    .await
}

/// `:config types` (ticket 141): writes init.lua's option types (LuaCATS, generated from the
/// core's shape table) as `types/roster-config.lua` in the config folder; gives the file's path.
#[tauri::command]
async fn config_types(config: tauri::State<'_, ConfigState>) -> Result<String, String> {
    let dir = config_dir(&config)?;
    blocking(move || {
        // A first `:config types` before there's an init.lua makes the folder, as `:config` does.
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        roster_core::config::shape::write_types(&dir).map(|f| f.display().to_string())
    })
    .await
}

/// `:plugins types PATH` (ticket 74): writes the Plugin API's stubs for this app's version as
/// `types/roster.lua` in the Plugin folder PATH; gives the file's path.
#[tauri::command]
async fn plugin_types(config: tauri::State<'_, ConfigState>, path: String) -> Result<String, String> {
    let config = config.inner().clone();
    blocking(move || {
        let dir = plugin_dir(&config, &path)?;
        plugin::api::write_stubs(&dir).map(|f| f.display().to_string())
    })
    .await
}

/// Loads (or reloads) a Plugin with the permissions the user granted (on demo `onDemo`'s host,
/// ticket 66).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri fills each argument from the call or its state
async fn plugin_load(
    config: tauri::State<'_, ConfigState>,
    packages: tauri::State<'_, PackagesState>,
    plugins: tauri::State<'_, Arc<PluginHost>>,
    demo: tauri::State<'_, DemoPlugins>,
    path: String,
    grants: Vec<String>,
    settings: Option<Value>,
    on_demo: Option<u64>,
) -> Result<Value, String> {
    let grants: Vec<Permission> = grants.iter().filter_map(|g| Permission::parse(g).ok()).collect();
    let host = plugin_host(&plugins, &demo, on_demo)?;
    let (config, packages) = (config.inner().clone(), packages.inner().clone());
    blocking(move || {
        // The user's proxy for its requests to public names, from the Config in effect (decision
        // Q116), handed to this load; a reload that changes it reaches it later (set_proxy).
        let proxy = config.0.as_ref().and_then(|l| plugin_proxy(&l.settled()));
        let (source, mut handed, shown) = plugin_source(&config, &packages, &path)?;
        // A built-in Plugin's settings come from the app (Folders: init.lua's Folders, and
        // folders.yml's to move in once); a Package's from init.lua, and a folder has none.
        if matches!(source, plugin::Source::Bundled(_))
            && let Some(given) = settings
        {
            handed = given;
        }
        let (manifest, reply) = host
            .load_with_proxy(&source, &grants, &handed, proxy)
            .map_err(|e| e.to_string())?;
        Ok(json!({ "manifest": manifest, "dir": shown, "reply": reply }))
    })
    .await
}

/// Packages (ticket 24): the clones in the app's data dir and `roster.lock` next to init.lua.
/// None when there's no config dir.
#[derive(Clone)]
struct PackagesState(Option<Arc<Packages>>);

fn packages_of(state: &PackagesState) -> Result<Arc<Packages>, String> {
    state
        .0
        .clone()
        .ok_or_else(|| "Packages need a config folder for roster.lock, and there's none".into())
}

/// The Packages init.lua names now (the last good Config). Waits for a reload in progress.
fn package_specs(config: &ConfigState) -> Vec<roster_core::config::PackageSpec> {
    config
        .0
        .as_ref()
        .map(|l| l.settled().packages.clone())
        .unwrap_or_default()
}

/// Clones what init.lua names and isn't cloned yet, and checks out what roster.lock pins.
#[tauri::command]
async fn packages_sync(
    config: tauri::State<'_, ConfigState>,
    packages: tauri::State<'_, PackagesState>,
) -> Result<Vec<package::Status>, String> {
    let (config, packages) = (config.inner().clone(), packages_of(&packages)?);
    blocking(move || Ok(packages.sync(&package_specs(&config)))).await
}

/// Pins a Package in roster.lock: the user allowed its install prompt.
#[tauri::command]
async fn packages_pin(
    config: tauri::State<'_, ConfigState>,
    packages: tauri::State<'_, PackagesState>,
    name: String,
) -> Result<package::Status, String> {
    let (config, packages) = (config.inner().clone(), packages_of(&packages)?);
    blocking(move || packages.pin(&package_specs(&config), &name)).await
}

/// Removes a Package's clone: its install prompt was cancelled.
#[tauri::command]
async fn packages_discard(packages: tauri::State<'_, PackagesState>, name: String) -> Result<(), String> {
    let packages = packages_of(&packages)?;
    blocking(move || packages.discard(&name)).await
}

/// Removes a Package's clone and its roster.lock entry (`:plugins remove`).
#[tauri::command]
async fn packages_remove(packages: tauri::State<'_, PackagesState>, name: String) -> Result<(), String> {
    let packages = packages_of(&packages)?;
    blocking(move || packages.remove(&name)).await
}

/// `:packages update [NAME]`, step 1: fetches (every Package, or the one named), and describes
/// each new commit. Changes nothing.
#[tauri::command]
async fn packages_check(
    config: tauri::State<'_, ConfigState>,
    packages: tauri::State<'_, PackagesState>,
    name: Option<String>,
) -> Result<Vec<package::Checked>, String> {
    let (config, packages) = (config.inner().clone(), packages_of(&packages)?);
    blocking(move || {
        let specs = package_specs(&config);
        match name {
            Some(name) => packages.check_named(&specs, &name).map(|c| vec![c]),
            None => Ok(packages.check(&specs)),
        }
    })
    .await
}

/// `:packages update`, step 2: moves a Package to the commit the user saw and allowed.
#[tauri::command]
async fn packages_apply(
    config: tauri::State<'_, ConfigState>,
    packages: tauri::State<'_, PackagesState>,
    name: String,
    commit: String,
) -> Result<package::Status, String> {
    let (config, packages) = (config.inner().clone(), packages_of(&packages)?);
    blocking(move || packages.apply(&package_specs(&config), &name, &commit)).await
}

/// `:packages clean`: removes the Packages init.lua no longer names; gives their names.
#[tauri::command]
async fn packages_clean(
    config: tauri::State<'_, ConfigState>,
    packages: tauri::State<'_, PackagesState>,
) -> Result<Vec<String>, String> {
    let (config, packages) = (config.inner().clone(), packages_of(&packages)?);
    blocking(move || packages.clean(&package_specs(&config))).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri fills each argument from the call or its state
async fn plugin_call(
    plugins: tauri::State<'_, Arc<PluginHost>>,
    demo: tauri::State<'_, DemoPlugins>,
    plugin: String,
    handler: u64,
    args: Value,
    user: Option<bool>,
    carried: Option<bool>,
    on_demo: Option<u64>,
) -> Result<plugin::Reply, String> {
    let host = plugin_host(&plugins, &demo, on_demo)?;
    // `user: false`: the app runs it on its own (a finder's items, a `:check`, a timer, a
    // question's cancel because another took its place, a command a carried run's `roster.cmd`
    // named), never the user's call. `carried`: the Plugin's own command its `roster.cmd` ran from
    // the user's call, that call carried one hop (issue #183).
    blocking(move || {
        Ok(if user == Some(false) {
            host.call_by_app(&plugin, handler, args)
        } else if carried == Some(true) {
            host.call_carried(&plugin, handler, args)
        } else {
            host.call(&plugin, handler, args)
        })
    })
    .await
}

#[tauri::command]
async fn plugin_event(
    plugins: tauri::State<'_, Arc<PluginHost>>,
    demo: tauri::State<'_, DemoPlugins>,
    name: String,
    payload: Value,
    on_demo: Option<u64>,
) -> Result<Vec<plugin::Reply>, String> {
    let host = plugin_host(&plugins, &demo, on_demo)?;
    blocking(move || Ok(host.event(plugin::Event { name, payload }))).await
}

/// The Sessions open now, `[id, host]` in the order the app saw them open (a Quick Connect
/// Session's host is null): the whole list, replacing the last (`roster.sessions.list()`,
/// decision Q127).
#[tauri::command]
fn plugin_sessions(
    plugins: tauri::State<'_, Arc<PluginHost>>,
    demo: tauri::State<'_, DemoPlugins>,
    open: Vec<(u64, Option<String>)>,
    on_demo: Option<u64>,
) -> Result<(), String> {
    plugin_host(&plugins, &demo, on_demo)?.set_sessions(open);
    Ok(())
}

#[tauri::command]
fn plugin_unload(
    plugins: tauri::State<'_, Arc<PluginHost>>,
    demo: tauri::State<'_, DemoPlugins>,
    plugin: String,
    on_demo: Option<u64>,
) -> bool {
    plugin_host(&plugins, &demo, on_demo).is_ok_and(|h| h.unload(&plugin))
}

/// The app's built-in commands (issue #184): none is a Plugin's own to run with `roster.cmd`. The
/// app sends them when its Plugin host starts and again when one registers later.
#[tauri::command]
fn plugin_builtins(
    plugins: tauri::State<'_, Arc<PluginHost>>,
    demo: tauri::State<'_, DemoPlugins>,
    names: Vec<String>,
    on_demo: Option<u64>,
) -> Result<(), String> {
    plugin_host(&plugins, &demo, on_demo)?.set_builtins(names);
    Ok(())
}

/// `plugin_proxy` from a Config (decision Q116); the Config's check refused a bad one, so a
/// value here parses.
fn plugin_proxy(config: &roster_core::config::Config) -> Option<plugin::network::Proxy> {
    config
        .plugin_proxy
        .as_deref()
        .and_then(|p| plugin::network::Proxy::parse(p).ok())
}

/// A reload's Config reaches the running Plugins' proxy setting, then the frontend hears of it.
fn config_changed(handle: &tauri::AppHandle, report: &Report) {
    use tauri::{Emitter, Manager};
    if let Some(plugins) = handle.try_state::<Arc<PluginHost>>() {
        plugins.set_proxy(plugin_proxy(&report.config));
    }
    let _ = handle.emit("config-changed", report);
}

/// Each loaded Plugin's network requests by site since the app started, by its name, for
/// `:plugins` (decision Q116): counts and a time, never a path, a query or a body.
#[tauri::command]
fn plugin_requests(
    plugins: tauri::State<'_, Arc<PluginHost>>,
) -> std::collections::BTreeMap<String, Vec<plugin::network::SiteCount>> {
    plugins
        .list()
        .into_iter()
        .map(|s| (s.manifest.name, s.requests))
        .collect()
}

/// How full each named Plugin's data folder is, for `:plugins` (ticket 98): files and bytes as
/// the caps count them, never what they hold. Loaded or not, so a stopped Plugin's shows too.
#[tauri::command]
async fn plugin_data(
    plugins: tauri::State<'_, Arc<PluginHost>>,
    names: Vec<String>,
) -> Result<std::collections::BTreeMap<String, plugin::folder::DataUse>, String> {
    let host = Arc::clone(&plugins);
    blocking(move || {
        let used = names.into_iter().map(|n| {
            let u = host.data_use(&n);
            (n, u)
        });
        Ok(used.collect())
    })
    .await
}

/// Removes a Plugin's data folder with everything in it (decision Q93): `:plugins remove` and
/// `:packages clean` call it once the Plugin is gone. A reload or a revoke never does.
#[tauri::command]
async fn plugin_forget(
    plugins: tauri::State<'_, Arc<PluginHost>>,
    demo: tauri::State<'_, DemoPlugins>,
    plugin: String,
    on_demo: Option<u64>,
) -> Result<bool, String> {
    let host = plugin_host(&plugins, &demo, on_demo)?;
    blocking(move || host.forget(&plugin)).await
}

fn session_error(e: SessionError) -> CallError {
    CallError::Io { message: e.to_string() }
}

/// A Session that's started: its id and how it logs in ("key" or "password").
#[derive(serde::Serialize)]
struct OpenedSession {
    id: SessionId,
    auth: String,
    /// serve's id for a Quick Connect (ticket 14).
    #[serde(skip_serializing_if = "Option::is_none")]
    quick: Option<String>,
    /// The id serve holds a typed password under for "Save to vault" (tickets 15, 16), when asked.
    #[serde(skip_serializing_if = "Option::is_none")]
    held: Option<String>,
}

/// Open a Session to `host`: `session.prepare`, then the command in a PTY of `cols`×`rows`.
/// `events` gets the output as raw bytes, then one JSON message `{"exit": {code, closed}}`.
/// Refusals keep roster's code (2 unknown, 20 not reviewed, 21 box not set up, 11/12/14 the
/// password Host's vault). prepare runs right before the spawn: a password Session's askpass
/// token lives 60 s, so every open (and every reconnect) gets a fresh one. For an `auth: prompt`
/// Host (ticket 16) the app sends the `password` the user typed (moved into serve's request and
/// dropped with it, as `vault_unlock`'s), and `save` asks serve to hold it for "Save to vault".
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri fills each argument from the call or its state
async fn session_open(
    state: tauri::State<'_, Arc<BackendState>>,
    sessions: tauri::State<'_, Arc<SessionManager>>,
    host: String,
    password: Option<String>,
    save: Option<bool>,
    cols: u16,
    rows: u16,
    events: Channel<InvokeResponseBody>,
) -> Result<OpenedSession, CallError> {
    let backend = state.get()?;
    let sessions = Arc::clone(&sessions);
    blocking(move || {
        let (cmd, held) = match password {
            Some(password) => {
                let s = backend.typed_session_command(&host, password, save.unwrap_or(false))?;
                (s.command, s.held)
            }
            None => (backend.session_command(&host)?, None),
        };
        let id = sessions
            .open(&cmd, Size { cols, rows }, move |event| {
                let body = match event {
                    SessionEvent::Output(bytes) => InvokeResponseBody::Raw(bytes),
                    SessionEvent::Exit(exit) => InvokeResponseBody::Json(json!({ "exit": exit }).to_string()),
                };
                let _ = events.send(body);
            })
            .map_err(session_error)?;
        Ok(OpenedSession {
            id,
            auth: cmd.auth,
            quick: None,
            held,
        })
    })
    .await
}

/// Open a Quick Connect Session (ticket 14): `quick.prepare` for `to` (user@address:port and the
/// fingerprint the user was shown), then the command in a PTY, like `session_open`. A typed
/// `password` is moved into serve's request and dropped with it, as `vault_unlock`'s is: never
/// logged, stored or put in an error. What comes back carries only an askpass token. With `save`
/// ("Save to vault", ticket 15) serve holds the password for `quick.save`; only its id comes back.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri fills each argument from the call or its state
async fn quick_session_open(
    state: tauri::State<'_, Arc<BackendState>>,
    sessions: tauri::State<'_, Arc<SessionManager>>,
    to: QuickTarget,
    password: Option<String>,
    save: Option<bool>,
    cols: u16,
    rows: u16,
    events: Channel<InvokeResponseBody>,
) -> Result<OpenedSession, CallError> {
    let backend = state.get()?;
    let sessions = Arc::clone(&sessions);
    blocking(move || {
        let q = backend.quick_session_command(&to, password, save.unwrap_or(false))?;
        let id = sessions
            .open(&q.command, Size { cols, rows }, move |event| {
                let body = match event {
                    SessionEvent::Output(bytes) => InvokeResponseBody::Raw(bytes),
                    SessionEvent::Exit(exit) => InvokeResponseBody::Json(json!({ "exit": exit }).to_string()),
                };
                let _ = events.send(body);
            })
            .map_err(session_error)?;
        Ok(OpenedSession {
            id,
            auth: q.command.auth,
            quick: Some(q.quick),
            held: q.held,
        })
    })
    .await
}

/// Keystrokes or pasted text for a Session.
#[tauri::command]
fn session_write(
    sessions: tauri::State<'_, Arc<SessionManager>>,
    id: SessionId,
    data: String,
) -> Result<(), CallError> {
    sessions.write(id, data.as_bytes()).map_err(session_error)
}

/// How long a prompt fill waits for an echo of its probe before it types the secret (ticket 119,
/// decision Q129). Longer than an ssh round trip to a far Host; a link slower than that could echo
/// after it, which is why the docs say so.
const FILL_WAIT: std::time::Duration = std::time::Duration::from_millis(800);

/// Fills the password prompt Session `id` shows, when the user pressed the fill key at one
/// (ticket 119, decision Q129). The core asks serve (`session.fill`) for the password of the
/// Host the Session was opened to (its own record, never a name from the frontend), with the
/// prompt line the frontend read off the screen, then types it only if the prompt doesn't echo
/// (`SessionManager::fill`). Only the Host's name comes back; the password never reaches the
/// frontend, a log or an error.
#[tauri::command]
async fn session_fill(
    state: tauri::State<'_, Arc<BackendState>>,
    sessions: tauri::State<'_, Arc<SessionManager>>,
    id: SessionId,
    prompt: String,
) -> Result<Value, CallError> {
    let backend = state.get()?;
    let sessions = Arc::clone(&sessions);
    blocking(move || {
        sessions
            .fill(id, FILL_WAIT, |target| backend.fill_secret(target, &prompt))
            .map(|host| json!({ "host": host }))
            .map_err(|e| match e {
                FillError::Lookup(e) => e,
                other => CallError::Io {
                    message: other.to_string(),
                },
            })
    })
    .await
}

#[tauri::command]
fn session_resize(
    sessions: tauri::State<'_, Arc<SessionManager>>,
    id: SessionId,
    cols: u16,
    rows: u16,
) -> Result<(), CallError> {
    sessions.resize(id, Size { cols, rows }).map_err(session_error)
}

/// Ends a Session (kills ssh); its exit message still arrives, with `closed: true`.
#[tauri::command]
fn session_close(sessions: tauri::State<'_, Arc<SessionManager>>, id: SessionId) -> Result<(), CallError> {
    sessions.close(id).map_err(session_error)
}

/// The State file (GLOSSARY: State) in the OS local app-data dir: per Box, never roamed.
/// `ROSTER_APP_STATE_DIR` moves it (a test or perf copy, app/scripts/perf.sh).
fn state_file(app: &tauri::AppHandle) -> Result<StateFile, String> {
    use tauri::Manager;
    if let Some(dir) = roster_core::env::state_dir() {
        return Ok(StateFile::in_dir(&dir));
    }
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(StateFile::in_dir(&dir))
}

/// The one-time copy of roster-desk's State into this identifier's app-data dir (roster-core
/// migrate.rs). Never stops the app: State is only a convenience.
fn migrate_state(app: &tauri::AppHandle) {
    use tauri::Manager;
    if roster_core::env::state_dir().is_some() {
        return;
    }
    let Ok(dir) = app.path().app_local_data_dir() else {
        return;
    };
    let Some(old) = roster_core::migrate::legacy_state_dir(&dir) else {
        return;
    };
    match roster_core::migrate::state(&old, &dir) {
        Ok(true) => eprintln!("roster: copied the State from {}", old.display()),
        Ok(false) => {}
        Err(e) => eprintln!("roster: can't copy the State from {}: {e}", old.display()),
    }
}

/// The one-time copy of roster-desk's Config dir into roster's (roster-core migrate.rs).
fn migrate_config(dir: &std::path::Path) {
    let Some(old) = config::legacy_dir() else {
        return;
    };
    match roster_core::migrate::config(&old, dir) {
        Ok(copied) if !copied.is_empty() => {
            eprintln!(
                "roster: copied {} file(s) of the Config from {}",
                copied.len(),
                old.display()
            )
        }
        Ok(_) => {}
        Err(e) => eprintln!("roster: can't copy the Config from {}: {e}", old.display()),
    }
}

/// What the app remembered last time (`{}` the first time).
#[tauri::command]
fn state_load(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(state_file(&app)?.load())
}

/// Replaces the remembered State (a JSON object; the frontend owns its shape).
#[tauri::command]
fn state_save(app: tauri::AppHandle, state: Value) -> Result<(), String> {
    state_file(&app)?.save(&state).map_err(|e| e.to_string())
}

/// Facts about this machine the terminal needs: the Windows build, for xterm's `windowsPty`.
#[tauri::command]
fn platform_info() -> Value {
    json!({ "windowsBuild": roster_core::platform::windows_build() })
}

/// WebView2's own shortcuts (Ctrl+F find, Ctrl+R reload, Ctrl+P print, F12…) would take keys
/// meant for the shell; tauri doesn't expose wry's switch, so set it on the WebView2 settings.
#[cfg(windows)]
fn disable_browser_accelerators(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|w| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows::core::Interface;
        let Ok(core) = w.controller().CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else { return };
        if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    });
}

/// Puts the window where the State says it was (roster-core window.rs), then shows it. The window
/// starts hidden (tauri.conf.json `visible: false`) so it never jumps; it's shown whatever happens.
fn restore_and_show(app: &tauri::App, window: &tauri::WebviewWindow) {
    use roster_core::window::{Rect, placement};
    use tauri::{PhysicalPosition, PhysicalSize};
    let state = state_file(app.handle()).map(|f| f.load()).unwrap_or(Value::Null);
    let monitors: Vec<Rect> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Rect {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        })
        .collect();
    if let Some(p) = placement(&state, &monitors) {
        let _ = window.set_size(PhysicalSize::new(p.rect.width, p.rect.height));
        let _ = window.set_position(PhysicalPosition::new(p.rect.x, p.rect.y));
        if p.maximized {
            let _ = window.maximize();
        }
    }
    let _ = window.show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sessions = Arc::new(SessionManager::new());
    let loader = config::dir().map(|dir| {
        migrate_config(&dir);
        Arc::new(Loader::new(&dir))
    });
    let setup_loader = loader.clone();
    let backend = Arc::new(BackendState::default());
    let plugins = Arc::new(PluginHost::new(
        Arc::new(PluginServe(Arc::clone(&backend))),
        plugin::Limits::default(),
    ));
    let setup_plugins = Arc::clone(&plugins);
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(backend)
        .manage(plugins)
        .manage(DemoPlugins::default())
        .manage(Arc::clone(&sessions))
        .manage(ConfigState(loader))
        .setup(move |app| {
            migrate_state(app.handle());
            // What a Plugin did when one of its requests answered (`roster.http`, the
            // `network` permission, or `roster.serve.request`): nobody asked, so it goes to the
            // frontend as an event.
            let handle = app.handle().clone();
            setup_plugins.set_listener(Arc::new(move |reply: plugin::Reply| {
                use tauri::Emitter;
                let _ = handle.emit("plugin-reply", reply);
            }));
            // Packages' clones go in the app's own data dir (next to the State), the lock next
            // to init.lua.
            let data = roster_core::env::state_dir().or_else(|| tauri::Manager::path(app).app_local_data_dir().ok());
            // Each Plugin's own data folder goes there too, as plugin-data/NAME (decision Q93).
            if let Some(data) = &data {
                setup_plugins.set_data(data);
            }
            let packages = match (data, setup_loader.as_ref()) {
                (Some(data), Some(loader)) => Some(Arc::new(Packages::new(&data, loader.dir()))),
                _ => None,
            };
            tauri::Manager::manage(app, PackagesState(packages));
            // The watcher lives as long as the app.
            if let Some(w) = setup_loader.as_ref().and_then(|l| start_config(app, l)) {
                tauri::Manager::manage(app, Mutex::new(w));
            }
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                #[cfg(windows)]
                disable_browser_accelerators(&w);
                restore_and_show(app, &w);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_connect,
            open_url,
            hosts_list,
            host_get,
            host_check,
            box_check,
            inventory_pull,
            host_verify_login,
            host_update,
            host_scan_key,
            host_key_scan,
            host_key_trust,
            host_add,
            host_review,
            inventory_call,
            save_call,
            folders_read,
            changes_diff,
            changes_discard,
            changes_publish,
            session_open,
            quick_session_open,
            session_write,
            session_fill,
            session_resize,
            session_close,
            state_load,
            state_save,
            platform_info,
            vault_status,
            vault_unlock,
            vault_login,
            vault_lock,
            vault_logout,
            vault_configure,
            vault_targets,
            config_load,
            config_open,
            config_reload,
            config_import_preview,
            config_import_apply,
            config_types,
            plugin_manifest,
            plugin_types,
            plugin_load,
            plugin_call,
            plugin_event,
            plugin_sessions,
            plugin_unload,
            plugin_forget,
            plugin_builtins,
            plugin_demo_start,
            plugin_demo_stop,
            plugin_requests,
            plugin_data,
            packages_sync,
            packages_pin,
            packages_discard,
            packages_remove,
            packages_check,
            packages_apply,
            packages_clean
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app, event| {
            if let tauri::RunEvent::Exit = event {
                sessions.close_all();
                // A tutorial still running: its Plugins stop and their throwaway files go.
                drop(tauri::Manager::state::<DemoPlugins>(app).0.stop_any());
            }
        });
}
