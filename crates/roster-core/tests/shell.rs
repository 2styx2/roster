//! The Shell's command list, the Tauri shell's and the end-to-end bridge's are one list: a command
//! the shell registers that the bridge can't run (or the other way round) fails here, so the
//! full-stack tests always run the app's surface (app/e2e/fullstack).

use roster_core::shell::bridge::{Channels, Failure, Pages, dispatch};
use roster_core::shell::{COMMANDS, Places, Shell};
use serde_json::json;
use std::sync::Arc;

/// The names in lib.rs's `tauri::generate_handler![...]`, in order.
fn registered() -> Vec<String> {
    let lib = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../app/src-tauri/src/lib.rs"))
        .expect("app/src-tauri/src/lib.rs");
    let start = lib.find("generate_handler![").expect("lib.rs registers its commands") + "generate_handler![".len();
    let end = start + lib[start..].find(']').expect("the list ends");
    lib[start..end]
        .split(',')
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect()
}

#[test]
fn the_tauri_shell_registers_exactly_the_shells_commands() {
    assert_eq!(registered(), COMMANDS);
}

#[test]
fn the_bridge_runs_every_command_and_no_other() {
    let dir = tempfile::tempdir().unwrap();
    let shell = Shell::new(
        Places {
            config: None,
            data: Some(dir.path().to_path_buf()),
        },
        Pages::default().emitter(),
    );
    let channels: Channels = Arc::new(|_, _| {});
    // Arguments of the wrong type everywhere: each command either parses them (and answers with
    // its own result or error) or refuses them, but every one is known.
    let wrong = json!({ "restart": "x", "url": 1, "method": 1, "host": 1, "job": 1, "id": "x", "cols": "x",
        "path": 1, "name": 1, "plugin": 1, "state": 1, "previewed": 1, "hosts": 1, "names": 1, "open": 1,
        "params": "x", "to": 1, "events": 1, "started": 1, "grants": 1, "handler": "x", "commit": 1 });
    for cmd in COMMANDS {
        assert_ne!(dispatch(&shell, cmd, &wrong, &channels), Err(Failure::Unknown), "{cmd}");
    }
    assert_eq!(
        dispatch(&shell, "not_a_command", &json!({}), &channels),
        Err(Failure::Unknown)
    );
}
