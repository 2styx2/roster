//! `folders.yml` next to `init.lua` (decision Q46): the Folders made in the app before they moved
//! into the Folders Plugin (decision Q93). The app only reads it, once at each start, to hand its
//! Folders to the Plugin; it never writes or watches it. The frontend parses it (src/folders/file.ts).

use std::path::{Path, PathBuf};

/// The old Folders file next to `init.lua`.
pub const FOLDERS_FILE: &str = "folders.yml";

/// A Folders file bigger than this is a mistake, not something to read into the window.
pub const MAX_BYTES: usize = 1024 * 1024;

pub fn path(dir: &Path) -> PathBuf {
    dir.join(FOLDERS_FILE)
}

/// The file's text, or None when there's none yet.
pub fn read(dir: &Path) -> std::io::Result<Option<String>> {
    match std::fs::read(path(dir)) {
        Ok(bytes) if bytes.len() > MAX_BYTES => Err(std::io::Error::other(format!(
            "{FOLDERS_FILE} is {} bytes (at most {MAX_BYTES})",
            bytes.len()
        ))),
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| std::io::Error::other(format!("{FOLDERS_FILE} isn't UTF-8 text"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
