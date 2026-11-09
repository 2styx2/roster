//! Plugins: `roster NAME ARGS` runs `roster-NAME ARGS` from PATH, git style.

use crate::{Fail, usage_error};
use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;

/// The first executable `roster-NAME` on PATH.
pub fn find(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(format!("roster-{name}")))
        .find(|p| {
            p.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

/// Replace roster with the plugin. Returns only when that fails.
pub fn exec(name: &str, config: Option<PathBuf>, args: Vec<OsString>) -> Fail {
    let Some(program) = find(name) else {
        return usage_error(format!(
            "unknown command '{name}': no roster-{name} on PATH"
        ));
    };
    let mut cmd = std::process::Command::new(&program);
    cmd.arg0(format!("roster-{name}")).args(args);
    match crate::inventory::locate(config) {
        Some(p) => cmd.env("ROSTER_CONFIG", std::fs::canonicalize(&p).unwrap_or(p)),
        None => cmd.env_remove("ROSTER_CONFIG"),
    };
    if let Ok(bin) = std::env::current_exe() {
        cmd.env("ROSTER_BIN", bin);
    }
    let e = cmd.exec();
    Fail {
        code: 126,
        msg: format!("{}: {e}", program.display()),
    }
}
