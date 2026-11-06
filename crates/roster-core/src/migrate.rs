//! The one-time move from roster-desk's places to roster's. The app was called roster-desk
//! (identifier `dev.roster.desk`, Config in `roster-desk/`) before it joined the roster repo;
//! it is now the roster app (identifier `dev.roster.app`, Config in `roster/`).
//!
//! At start-up the app copies what it finds in the old places into the new ones, only when the
//! new ones don't have it yet: the Config dir when it holds no Config yet (no `init.lua` and no
//! `folders.yml`), and the State file when there's none. It copies, never moves or overwrites,
//! so the old files stay as a backup and running an old build still works. Once the new places
//! have their files, nothing is copied again.

use crate::state::FILE_NAME as STATE_FILE;
use std::io;
use std::path::{Path, PathBuf};

/// The app's Tauri identifier while it was roster-desk: its app-data dir's name.
pub const LEGACY_IDENTIFIER: &str = "dev.roster.desk";

/// The files that mean a config dir already holds a Config.
const CONFIG_FILES: [&str; 2] = ["init.lua", "folders.yml"];

/// Copies the old Config dir into `new` when `new` holds no Config yet (it may already exist:
/// on Linux `~/.config/roster/` can also hold roster's own `roster.yml`). Every file and
/// subdir of `old` is copied, except ones `new` already has. Returns the files copied (none
/// when there was nothing to do).
pub fn config(old: &Path, new: &Path) -> io::Result<Vec<PathBuf>> {
    if !old.is_dir() || CONFIG_FILES.iter().any(|f| new.join(f).exists()) {
        return Ok(Vec::new());
    }
    let mut copied = Vec::new();
    copy_missing(old, new, &mut copied)?;
    Ok(copied)
}

/// The old app-data dir for the State: `dev.roster.desk` next to `new` (the app-data dir of
/// the current identifier). None when `new` has no parent.
pub fn legacy_state_dir(new: &Path) -> Option<PathBuf> {
    Some(new.parent()?.join(LEGACY_IDENTIFIER))
}

/// Copies the old State file into `new_dir` when `new_dir` has none. Returns whether it did.
pub fn state(old_dir: &Path, new_dir: &Path) -> io::Result<bool> {
    let (old, new) = (old_dir.join(STATE_FILE), new_dir.join(STATE_FILE));
    if new.exists() || !old.is_file() {
        return Ok(false);
    }
    std::fs::create_dir_all(new_dir)?;
    std::fs::copy(&old, &new)?;
    Ok(true)
}

fn copy_missing(from: &Path, to: &Path, copied: &mut Vec<PathBuf>) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_missing(&entry.path(), &target, copied)?;
        } else if kind.is_file() && !target.exists() {
            std::fs::copy(entry.path(), &target)?;
            copied.push(target);
        }
    }
    Ok(())
}

/// At start: the one-time copy of roster-desk's State into `app_data` (the app's local data dir),
/// unless [`crate::env::STATE_DIR_VAR`] moves the State elsewhere. The line for the app's log, if
/// there's anything to say; never an error that stops the app: State is only a convenience.
pub fn state_at_start(app_data: &Path) -> Option<String> {
    if crate::env::state_dir().is_some() {
        return None;
    }
    let old = legacy_state_dir(app_data)?;
    match state(&old, app_data) {
        Ok(true) => Some(format!("copied the State from {}", old.display())),
        Ok(false) => None,
        Err(e) => Some(format!("can't copy the State from {}: {e}", old.display())),
    }
}

/// At start: the one-time copy of roster-desk's Config dir into `dir`, roster's ([`config`]). The
/// line for the app's log, if there's anything to say.
pub fn config_at_start(dir: &Path) -> Option<String> {
    let old = crate::config::legacy_dir()?;
    match config(&old, dir) {
        Ok(copied) if !copied.is_empty() => Some(format!(
            "copied {} file(s) of the Config from {}",
            copied.len(),
            old.display()
        )),
        Ok(_) => None,
        Err(e) => Some(format!("can't copy the Config from {}: {e}", old.display())),
    }
}
