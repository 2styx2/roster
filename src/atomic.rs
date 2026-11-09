//! Atomic file writes: a temp file in the same directory, fsync, then rename,
//! so a reader sees the old file or the new one, never half of one.

use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

/// Replace `path` with `contents`. An existing file keeps its mode; a new one
/// gets `mode`. The parent directory must exist. A symlink stays one: its
/// target is written.
pub fn write(path: &Path, contents: &[u8], mode: u32) -> std::io::Result<()> {
    let target = match path.is_symlink() {
        true => Some(std::fs::canonicalize(path)?),
        false => None,
    };
    let path = target.as_deref().unwrap_or(path);
    let mode = match std::fs::metadata(path) {
        Ok(m) => m.permissions().mode() & 0o7777,
        Err(_) => mode,
    };
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty());
    let dir = dir.unwrap_or(Path::new("."));
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = dir.join(format!(".{name}.roster-{}", std::process::id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&tmp)?;
        // The umask may have narrowed the mode at create.
        file.set_permissions(std::fs::Permissions::from_mode(mode))?;
        file.write_all(contents)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)?;
        std::fs::File::open(dir)?.sync_all()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// `write` only when the contents differ. Returns whether it wrote.
pub fn update(path: &Path, contents: &str, mode: u32) -> std::io::Result<bool> {
    if std::fs::read(path).is_ok_and(|old| old == contents.as_bytes()) {
        return Ok(false);
    }
    write(path, contents.as_bytes(), mode).map(|()| true)
}
