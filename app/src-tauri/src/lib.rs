//! The Tauri shell: window setup and `#[tauri::command]` adapters over roster-core's `Shell`
//! (roster-core shell.rs), which holds every command's logic so it can be tested without Tauri
//! (docs/app/dev/testing.md) and run by the end-to-end bridge. Each command here only turns
//! Tauri's arguments, channels and events into the core's, on a blocking thread where it waits.

use roster_core::backend::{BackendInfo, CheckStarted, CreateError, OpenedSession, QuickTarget};
use roster_core::config::{self, Report};
use roster_core::detect::BackendError;
use roster_core::package;
use roster_core::plugin;
use roster_core::rpc::CallError;
use roster_core::session::{Hop, SessionEvent, SessionId, Size};
use roster_core::shell::{Emit, Places, Shell};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};

type Core<'a> = tauri::State<'a, Arc<Shell>>;

/// Runs `f` with the Shell on a blocking thread.
async fn blocking<T: Send + 'static, E: Send + 'static>(
    core: Core<'_>,
    f: impl FnOnce(&Shell) -> Result<T, E> + Send + 'static,
) -> Result<T, E> {
    let shell = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || f(&shell))
        .await
        .expect("backend task panicked")
}

#[tauri::command]
async fn backend_connect(core: Core<'_>, restart: bool) -> Result<BackendInfo, BackendError> {
    blocking(core, move |s| s.backend_connect(restart)).await
}

#[tauri::command]
async fn inventory_create(core: Core<'_>, params: Value) -> Result<Value, CreateError> {
    blocking(core, move |s| s.inventory_create(params)).await
}

#[tauri::command]
async fn inventory_create_cancel(core: Core<'_>) -> Result<bool, ()> {
    blocking(core, |s| Ok(s.inventory_create_cancel())).await
}

#[tauri::command]
async fn open_url(core: Core<'_>, url: String) -> Result<(), String> {
    blocking(core, move |s| s.open_url(&url)).await
}

#[tauri::command]
async fn config_load(core: Core<'_>) -> Result<Option<Report>, ()> {
    blocking(core, |s| Ok(s.config_load())).await
}

#[tauri::command]
async fn config_open(core: Core<'_>) -> Result<config::Opened, String> {
    blocking(core, |s| s.config_open()).await
}

#[tauri::command]
async fn config_reload(core: Core<'_>) -> Result<Option<Report>, ()> {
    blocking(core, |s| Ok(s.config_reload())).await
}

#[tauri::command]
async fn config_import_preview(core: Core<'_>) -> Result<roster_core::wt::Preview, String> {
    blocking(core, |s| s.config_import_preview()).await
}

#[tauri::command]
async fn config_import_apply(core: Core<'_>, previewed: roster_core::wt::Previewed) -> Result<(), String> {
    blocking(core, move |s| s.config_import_apply(&previewed)).await
}

#[tauri::command]
async fn config_types(core: Core<'_>) -> Result<String, String> {
    blocking(core, |s| s.config_types()).await
}

/// The params can hold a typed password or vault secret on its way to serve's stdin: moved into
/// the request and wiped with it, never logged, stored or put in an error.
#[tauri::command]
async fn serve_call(core: Core<'_>, method: String, params: Value) -> Result<Value, CallError> {
    blocking(core, move |s| s.serve_call(&method, params)).await
}

#[tauri::command]
async fn host_check(core: Core<'_>, host: String, started: Channel<CheckStarted>) -> Result<Value, CallError> {
    // A send only fails once the window is gone.
    blocking(core, move |s| {
        s.host_check(&host, |c| {
            let _ = started.send(c.clone());
        })
    })
    .await
}

#[tauri::command]
async fn host_check_stop(core: Core<'_>, job: String) -> Result<Value, CallError> {
    blocking(core, move |s| s.host_check_stop(&job)).await
}

#[tauri::command]
async fn host_key_trust(core: Core<'_>, host: String, fingerprint: String) -> Result<Value, CallError> {
    blocking(core, move |s| s.host_key_trust(&host, &fingerprint)).await
}

#[tauri::command]
async fn folders_read(core: Core<'_>) -> Result<Value, String> {
    blocking(core, |s| s.folders_read()).await
}

#[tauri::command]
async fn plugin_demo_start(core: Core<'_>, hosts: Value) -> Result<u64, String> {
    blocking(core, move |s| s.plugin_demo_start(hosts)).await
}

#[tauri::command]
async fn plugin_demo_stop(core: Core<'_>, id: u64) -> Result<(), String> {
    blocking(core, move |s| s.plugin_demo_stop(id)).await
}

#[tauri::command]
async fn plugin_manifest(core: Core<'_>, path: String) -> Result<Value, String> {
    blocking(core, move |s| s.plugin_manifest(&path)).await
}

#[tauri::command]
async fn plugin_types(core: Core<'_>, path: String) -> Result<String, String> {
    blocking(core, move |s| s.plugin_types(&path)).await
}

#[tauri::command]
async fn plugin_load(
    core: Core<'_>,
    path: String,
    grants: Vec<String>,
    settings: Option<Value>,
    builtins: Option<Vec<String>>,
    on_demo: Option<u64>,
) -> Result<Value, String> {
    blocking(core, move |s| {
        s.plugin_load(&path, &grants, settings, builtins, on_demo)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri fills each argument from the call or its state
async fn plugin_call(
    core: Core<'_>,
    plugin: String,
    handler: u64,
    args: Value,
    by: Option<plugin::By>,
    builtins: Option<Vec<String>>,
    on_demo: Option<u64>,
) -> Result<plugin::Reply, String> {
    blocking(core, move |s| {
        s.plugin_call(&plugin, handler, args, by, builtins, on_demo)
    })
    .await
}

#[tauri::command]
async fn plugin_event(
    core: Core<'_>,
    name: String,
    payload: Value,
    builtins: Option<Vec<String>>,
    on_demo: Option<u64>,
) -> Result<Vec<plugin::Reply>, String> {
    blocking(core, move |s| s.plugin_event(name, payload, builtins, on_demo)).await
}

#[tauri::command]
fn plugin_sessions(core: Core<'_>, open: Vec<plugin::OpenSession>, on_demo: Option<u64>) -> Result<(), String> {
    core.plugin_sessions(open, on_demo)
}

#[tauri::command]
fn plugin_unload(core: Core<'_>, plugin: String, on_demo: Option<u64>) -> bool {
    core.plugin_unload(&plugin, on_demo)
}

#[tauri::command]
async fn plugin_forget(core: Core<'_>, plugin: String, on_demo: Option<u64>) -> Result<bool, String> {
    blocking(core, move |s| s.plugin_forget(&plugin, on_demo)).await
}

#[tauri::command]
fn plugin_requests(core: Core<'_>) -> BTreeMap<String, Vec<plugin::network::SiteCount>> {
    core.plugin_requests()
}

#[tauri::command]
async fn plugin_data(core: Core<'_>, names: Vec<String>) -> Result<BTreeMap<String, plugin::folder::DataUse>, String> {
    blocking(core, move |s| s.plugin_data(names)).await
}

#[tauri::command]
async fn packages_sync(core: Core<'_>) -> Result<Vec<package::Status>, String> {
    blocking(core, |s| s.packages_sync()).await
}

#[tauri::command]
async fn packages_pin(core: Core<'_>, name: String) -> Result<package::Status, String> {
    blocking(core, move |s| s.packages_pin(&name)).await
}

#[tauri::command]
async fn packages_discard(core: Core<'_>, name: String) -> Result<(), String> {
    blocking(core, move |s| s.packages_discard(&name)).await
}

#[tauri::command]
async fn packages_remove(core: Core<'_>, name: String) -> Result<(), String> {
    blocking(core, move |s| s.packages_remove(&name)).await
}

#[tauri::command]
async fn packages_check(core: Core<'_>, name: Option<String>) -> Result<Vec<package::Checked>, String> {
    blocking(core, move |s| s.packages_check(name.as_deref())).await
}

#[tauri::command]
async fn packages_apply(core: Core<'_>, name: String, commit: String) -> Result<package::Status, String> {
    blocking(core, move |s| s.packages_apply(&name, &commit)).await
}

#[tauri::command]
async fn packages_clean(core: Core<'_>) -> Result<Vec<String>, String> {
    blocking(core, |s| s.packages_clean()).await
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

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri fills each argument from the call or its state
async fn session_open(
    core: Core<'_>,
    host: String,
    password: Option<String>,
    save: Option<bool>,
    marks: Option<String>,
    cols: u16,
    rows: u16,
    events: Channel<InvokeResponseBody>,
) -> Result<OpenedSession, CallError> {
    let sink = session_sink(events);
    blocking(core, move |s| {
        s.session_open(host, password, save, marks, Size { cols, rows }, sink)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri fills each argument from the call or its state
async fn quick_session_open(
    core: Core<'_>,
    to: QuickTarget,
    password: Option<String>,
    save: Option<bool>,
    cols: u16,
    rows: u16,
    events: Channel<InvokeResponseBody>,
) -> Result<OpenedSession, CallError> {
    let sink = session_sink(events);
    blocking(core, move |s| {
        s.quick_session_open(to, password, save, Size { cols, rows }, sink)
    })
    .await
}

#[tauri::command]
fn session_write(core: Core<'_>, id: SessionId, data: String) -> Result<(), CallError> {
    core.session_write(id, &data)
}

#[tauri::command]
async fn session_fill(core: Core<'_>, id: SessionId, prompt: String, hop: Option<Hop>) -> Result<Value, CallError> {
    blocking(core, move |s| s.session_fill(id, &prompt, hop)).await
}

#[tauri::command]
fn session_resize(core: Core<'_>, id: SessionId, cols: u16, rows: u16) -> Result<(), CallError> {
    core.session_resize(id, Size { cols, rows })
}

#[tauri::command]
fn session_close(core: Core<'_>, id: SessionId) -> Result<(), CallError> {
    core.session_close(id)
}

#[tauri::command]
fn state_load(core: Core<'_>) -> Result<Value, String> {
    core.state_load()
}

#[tauri::command]
fn state_save(core: Core<'_>, state: Value) -> Result<(), String> {
    core.state_save(&state)
}

#[tauri::command]
fn platform_info(core: Core<'_>) -> Value {
    core.platform_info()
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
fn restore_and_show(shell: &Shell, window: &tauri::WebviewWindow) {
    use roster_core::window::{Rect, placement};
    use tauri::{PhysicalPosition, PhysicalSize};
    let state = shell.state_load().unwrap_or(Value::Null);
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
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            use tauri::{Emitter, Manager};
            let app_local = app.path().app_local_data_dir().ok();
            // State is only a convenience: a copy that fails is said, and the app starts anyway.
            if let Some(line) = app_local.as_deref().and_then(roster_core::migrate::state_at_start) {
                eprintln!("roster: {line}");
            }
            let handle = app.handle().clone();
            // Only fails once the window is gone, when nobody is left to hear it.
            let emit: Emit = Arc::new(move |event: &str, payload: Value| {
                let _ = handle.emit(event, payload);
            });
            let shell = Arc::new(Shell::new(Places::of_system(|| app_local), emit));
            shell.start_config();
            if let Some(w) = app.get_webview_window("main") {
                #[cfg(windows)]
                disable_browser_accelerators(&w);
                restore_and_show(&shell, &w);
            }
            app.manage(shell);
            Ok(())
        })
        // The same list as roster-core's `shell::COMMANDS` (tests/shell.rs compares them).
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
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event
                && let Some(shell) = tauri::Manager::try_state::<Arc<Shell>>(app)
            {
                shell.exit();
            }
        });
}
