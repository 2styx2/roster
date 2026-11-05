//! The Tauri shell: window setup and `#[tauri::command]` adapters over roster-core, which holds
//! the logic so it can be tested without Tauri (docs/app/dev/testing.md). A serve method the
//! frontend calls as it is goes through the one `serve_call` (roster-core serve_api.rs); the other
//! commands are where the core adds something (Sessions, the check job, trusting a key, the first
//! run), or reach the Config, Plugins, Packages and the State.

use roster_core::backend::{
    Backend, BackendInfo, CheckStarted, CreateCancel, Open, OpenedSession, QuickTarget, Typed, timeout_for,
};
use roster_core::config::{self, Config, Loader, Report};
use roster_core::detect::BackendError;
use roster_core::package::{self, Packages};
use roster_core::plugin::{self, Permission, PluginHost};
use roster_core::rpc::{CallError, Notify};
use roster_core::session::{Hop, SessionError, SessionEvent, SessionId, SessionManager, Size};
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
            Backend::start(&roster_core::detect::for_config(config)?, Some(notify))
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
        // Only fails once the window is gone, when nobody is left to hear it.
        let _ = app.emit("roster-notification", json!({ "method": method, "params": params }));
    });
    blocking(move || {
        let config = loader.map(|l| l.settled()).unwrap_or_default();
        s.connect(restart, &config, notify)
    })
    .await
}

/// The first-run dialog (T212): with no Inventory, `inventory.create` on a serve started for that
/// one call (roster-core `Backend::create_inventory`). serve writes roster.yml (ADR 0001); the
/// frontend then connects again. The params are the dialog's choice: how, a folder, a path or a
/// URL. Nothing secret is in them.
#[tauri::command]
async fn inventory_create(
    config: tauri::State<'_, ConfigState>,
    cancel: tauri::State<'_, CreateCancel>,
    params: Value,
) -> Result<Value, CallError> {
    let loader = config.0.clone();
    let cancel = cancel.inner().clone();
    blocking(move || {
        let config = loader.map(|l| l.settled()).unwrap_or_default();
        let c = roster_core::detect::for_config(&config).map_err(|e| CallError::Io { message: e.message })?;
        Backend::create_inventory(&c, params, &cancel)
    })
    .await
}

/// The first-run dialog's Cancel (#417 L5): the serve making the Inventory stops (a clone under way
/// is killed, and what it left taken away). False when nothing was under way.
#[tauri::command]
async fn inventory_create_cancel(cancel: tauri::State<'_, CreateCancel>) -> Result<bool, ()> {
    let cancel = cancel.inner().clone();
    blocking(move || Ok(cancel.cancel())).await
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
        let (path, text) = roster_core::wt::read_settings()?;
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
        let (path, text) = roster_core::wt::read_settings()?;
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

/// A serve method the frontend calls as it is (roster-core serve_api.rs `PASS_THROUGH`; any other
/// is refused), waiting as long as roster-core's `timeout_for` says for that method: longer than
/// serve's own deadline for it, so a slow call is answered rather than abandoned. The params can
/// hold a typed password or vault secret (`vault.unlock`, `vault.login`, `host.add`) on its way
/// to serve's stdin: moved into the request and wiped with it, never logged, stored or put in an
/// error.
#[tauri::command]
async fn serve_call(
    state: tauri::State<'_, Arc<BackendState>>,
    method: String,
    params: Value,
) -> Result<Value, CallError> {
    let backend = state.get()?;
    blocking(move || backend.pass(&method, params)).await
}

/// roster's diagnostics for one Host (`host.check`, api 2): its steps in order, stopping at the
/// first failure. roster makes at most one connection and one login, so this is safe on a
/// rate-limited network. From serve API 21 it's a job in serve, followed by the core
/// (`Backend::check_host`), so no worker of serve waits for it. `started` hears the check's job once serve has it under way, and
/// whether it's the app's own to stop (`host_check_stop`, #221 item 1); an older serve sends none.
#[tauri::command]
async fn host_check(
    state: tauri::State<'_, Arc<BackendState>>,
    host: String,
    started: Channel<CheckStarted>,
) -> Result<Value, CallError> {
    let backend = state.get()?;
    blocking(move || {
        backend.check_host(&host, timeout_for("host.check"), |s| {
            // Only fails once the window is gone.
            let _ = started.send(s.clone());
        })
    })
    .await
}

/// Stop in the `:check` panel (#221 item 1): stops a check of the app's own at its next step
/// (`Backend::stop_check`, serve's `jobs.stop`). Another caller's check isn't stopped.
#[tauri::command]
async fn host_check_stop(state: tauri::State<'_, Arc<BackendState>>, job: String) -> Result<Value, CallError> {
    let backend = state.get()?;
    blocking(move || backend.stop_check(&job)).await
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

/// The Sessions open now, `{ session, host, cwd }` in the order the app saw them open (a Quick
/// Connect Session's host is null; `cwd` the folder its shell last said, OSC 7, or null): the
/// whole list, replacing the last (`roster.sessions.list()`, decisions Q127 and Q185).
#[tauri::command]
fn plugin_sessions(
    plugins: tauri::State<'_, Arc<PluginHost>>,
    demo: tauri::State<'_, DemoPlugins>,
    open: Vec<plugin::OpenSession>,
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

/// A Session's output as raw bytes on `events`, then one JSON message `{"exit": {code, closed}}`.
fn session_sink(events: Channel<InvokeResponseBody>) -> impl Fn(SessionEvent) + Send + Sync + 'static {
    move |event| {
        let body = match event {
            SessionEvent::Output(bytes) => InvokeResponseBody::Raw(bytes),
            SessionEvent::Exit(exit) => InvokeResponseBody::Json(json!({ "exit": exit }).to_string()),
        };
        // Only fails once the window is gone; the Session is closed at exit anyway.
        let _ = events.send(body);
    }
}

/// A password typed for a Session, if one was: moved into serve's request and dropped with it.
fn typed(password: Option<String>, save: Option<bool>) -> Option<Typed> {
    password.map(|password| Typed {
        password,
        save: save.unwrap_or(false),
    })
}

/// Open a Session to `host` in a PTY of `cols`×`rows` (roster-core `Backend::open_session`):
/// `session.prepare` right before the spawn, so every open gets a fresh askpass token. Refusals
/// keep roster's code (2 unknown, 20 not reviewed, 21 box not set up, 11/12/14 the password Host's
/// vault, 44 no host key). For an `auth: prompt` Host (ticket 16) the app sends the `password` the
/// user typed, and `save` asks serve to hold it for "Save to vault". `marks` is the token roster's
/// shell hooks put on this attempt's marks (decision Q131 (a)).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri fills each argument from the call or its state
async fn session_open(
    state: tauri::State<'_, Arc<BackendState>>,
    sessions: tauri::State<'_, Arc<SessionManager>>,
    host: String,
    password: Option<String>,
    save: Option<bool>,
    marks: Option<String>,
    cols: u16,
    rows: u16,
    events: Channel<InvokeResponseBody>,
) -> Result<OpenedSession, CallError> {
    let backend = state.get()?;
    let sessions = Arc::clone(&sessions);
    blocking(move || {
        let open = Open::Host {
            host,
            typed: typed(password, save),
            marks,
        };
        backend.open_session(&sessions, open, Size { cols, rows }, session_sink(events))
    })
    .await
}

/// Open a Quick Connect Session (ticket 14): `quick.prepare` for `to` (user@address:port and the
/// fingerprint the user was shown), then the command in a PTY, like `session_open`. With `save`
/// ("Save to vault", ticket 15) serve holds the typed password for `quick.save`; only its id
/// comes back.
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
        let open = Open::Quick {
            to,
            typed: typed(password, save),
        };
        backend.open_session(&sessions, open, Size { cols, rows }, session_sink(events))
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

/// Fills the password prompt Session `id` shows (ticket 119, decision Q129; roster-core
/// `Backend::fill_session`): `prompt` is the line the frontend read off the screen, `hop` a nested
/// ssh's Host as it resolved it (ticket 120). Only the Host's name comes back; the password never
/// reaches the frontend, a log or an error. What sudo's prompt drew that the mask check didn't
/// take (ticket 155) goes to stderr with the app's other `roster:` lines, never to the error.
#[tauri::command]
async fn session_fill(
    state: tauri::State<'_, Arc<BackendState>>,
    sessions: tauri::State<'_, Arc<SessionManager>>,
    id: SessionId,
    prompt: String,
    hop: Option<Hop>,
) -> Result<Value, CallError> {
    let backend = state.get()?;
    let sessions = Arc::clone(&sessions);
    blocking(move || {
        backend.fill_session(&sessions, id, &prompt, hop.as_ref(), |line| {
            eprintln!("roster: session {id}: {line}")
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

/// The app's own data folder (roster-core `env::data_dir`): the OS's local app-data dir, unless
/// `ROSTER_APP_STATE_DIR` moves it (a test or perf copy, app/scripts/perf.sh).
fn data_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    roster_core::env::data_dir(|| app.path().app_local_data_dir().ok())
}

/// The State file (GLOSSARY: State) in the app's data folder: per Box, never roamed.
fn state_file(app: &tauri::AppHandle) -> Result<StateFile, String> {
    data_dir(app)
        .map(|dir| StateFile::in_dir(&dir))
        .ok_or_else(|| "there's no app data folder for the State".into())
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
        if let Some(line) = roster_core::migrate::config_at_start(&dir) {
            eprintln!("roster: {line}");
        }
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
        .manage(CreateCancel::default())
        .setup(move |app| {
            let data = data_dir(app.handle());
            // State is only a convenience: a copy that fails is said, and the app starts anyway.
            if let Some(line) = tauri::Manager::path(app)
                .app_local_data_dir()
                .ok()
                .and_then(|dir| roster_core::migrate::state_at_start(&dir))
            {
                eprintln!("roster: {line}");
            }
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
            inventory_create,
            inventory_create_cancel,
            open_url,
            serve_call,
            host_check,
            host_check_stop,
            host_key_trust,
            folders_read,
            session_open,
            quick_session_open,
            session_write,
            session_fill,
            session_resize,
            session_close,
            state_load,
            state_save,
            platform_info,
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
