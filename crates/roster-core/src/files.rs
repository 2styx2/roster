//! The core's file rules, shared by the Config, Plugins, Packages, the State and the
//! Windows Terminal import: a write that's all or nothing, and paths that stay inside a folder
//! however links lead (decision Q93's "it stays inside its folder").

use std::path::{Path, PathBuf};

/// The real path of `rel` in `root` (a Plugin's folder, or the Config's), if it's really inside it
/// once symlinks and junctions are followed. `rel` is relative; `..` or an absolute path that leads out is
/// refused the same way.
pub fn inside(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let top = root.canonicalize().map_err(|e| format!("{}: {e}", root.display()))?;
    let path = root.join(rel);
    let real = path.canonicalize().map_err(|e| format!("{}: {e}", rel.display()))?;
    if real.starts_with(&top) {
        Ok(real)
    } else {
        Err(format!(
            "{} leads outside the Plugin's folder (through a symlink or ..): roster won't read it",
            rel.display()
        ))
    }
}

/// Whether `meta` (from `symlink_metadata`) is a link: a symlink, or on Windows any reparse
/// point (a junction, a mount point, a cloud placeholder), which can lead somewhere else.
pub fn is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

/// Replaces `path` with `text` all at once: a temporary file in the same folder, given the old
/// file's permissions, then renamed over it. A reader (or the Config watcher) sees the old file
/// or the new one, never half of it, and a failed write leaves the old one.
pub fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let written = std::fs::write(&tmp, text).and_then(|()| {
        if let Ok(meta) = std::fs::metadata(path) {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        std::fs::rename(&tmp, path)
    });
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}
