//! A Plugin's folders are its own (tickets 82 and 61, decision Q93): one rule, "it stays inside
//! its folder", for the folder its code is in and the folder it keeps its data in.
//!
//! - [`inside`]: the real path of a file of a Plugin, refused if it resolves outside the
//!   Plugin's folder after symlinks (and, on Windows, junctions). The Plugin host reads the
//!   manifest, `init.lua` and every module through it, for local Plugins and Packages alike.
//! - [`Storage`]: the Plugin's data folder, `<app data>/plugin-data/NAME/`, behind
//!   `roster.storage`. Flat: a file is a plain name, never a path; a link there (a symlink, a
//!   junction, any reparse point) is never followed, read, written or removed through; the folder
//!   itself may not be a link either. Writes are atomic (a temporary file, then a rename), a file
//!   holds at most [`MAX_FILE`] bytes and the folder [`MAX_TOTAL`] in [`MAX_FILES`] files.
//!   [`forget`] removes the folder with the Plugin (`:plugins remove`, `:packages clean`), and
//!   [`Storage::data_use`] says how full it is, for `:plugins` (ticket 98).

use std::path::{Component, Path, PathBuf};

/// The folder under the app's data folder that holds each Plugin's data folder.
pub const DATA_DIR: &str = "plugin-data";
/// The most one file of a Plugin's data may hold.
pub const MAX_FILE: usize = 1024 * 1024;
/// The most a Plugin's data folder may hold in all.
pub const MAX_TOTAL: usize = 10 * 1024 * 1024;
/// The most files a Plugin's data folder may hold.
pub const MAX_FILES: usize = 1000;
/// The longest a file name may be.
pub const MAX_NAME: usize = 100;

/// The real path of `rel` in `root` (a Plugin's folder), if it's really inside it once symlinks
/// and junctions are followed. `rel` is relative; `..` or an absolute path that leads out is
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

/// Whether `name` is a Plugin's name (the manifest's rule): the only names a data folder has.
fn plugin_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Names Windows keeps for devices, with or without an extension (`NUL.txt` too).
const DEVICES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2",
    "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Checks a file name a Plugin gave: letters, digits, `-`, `_` and `.`, not starting with `.`
/// (the temporary files are dot files), at most [`MAX_NAME`], and no device name.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("a file needs a name, like \"folders.json\"".into());
    }
    if name.len() > MAX_NAME {
        return Err(format!("the name is over {MAX_NAME} characters"));
    }
    let plain = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !plain || name.starts_with('.') {
        return Err(format!(
            "{name:?} isn't a file name: letters, digits, - _ and . only, not starting with . (no folders, no paths)"
        ));
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    if DEVICES.contains(&stem.as_str()) {
        return Err(format!("{name:?} is a name Windows keeps for a device"));
    }
    // Belt and braces: a plain name is one normal component.
    let mut parts = Path::new(name).components();
    if !matches!((parts.next(), parts.next()), (Some(Component::Normal(_)), None)) {
        return Err(format!("{name:?} isn't a file name"));
    }
    Ok(())
}

/// How full a Plugin's data folder is, for `:plugins` (ticket 98): what the caps count, never
/// what the files hold.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum DataUse {
    /// No data folder yet (nothing written), or no data folder at all.
    None,
    /// The files in it, and their bytes, as [`MAX_FILES`] and [`MAX_TOTAL`] count them.
    Used { files: usize, bytes: u64 },
    /// It can't be counted: it's a link, or it can't be read.
    Problem { message: String },
}

/// One Plugin's data folder.
#[derive(Debug, Clone)]
pub struct Storage {
    dir: PathBuf,
}

impl Storage {
    /// The data folder of the Plugin `plugin` under `data` (the app's data folder). Nothing is
    /// made until the first write.
    pub fn new(data: &Path, plugin: &str) -> Result<Storage, String> {
        if !plugin_name(plugin) {
            return Err(format!("{plugin:?} isn't a Plugin's name"));
        }
        Ok(Storage {
            dir: data.join(DATA_DIR).join(plugin),
        })
    }

    /// The folder, checked: Ok(None) when there's none yet, an error when it (or `plugin-data`)
    /// is a link or isn't a folder.
    fn folder(&self) -> Result<Option<PathBuf>, String> {
        let parent = self.dir.parent().unwrap_or(Path::new("."));
        for p in [parent, self.dir.as_path()] {
            match std::fs::symlink_metadata(p) {
                Ok(meta) if is_link(&meta) => {
                    return Err(format!(
                        "the Plugin's data folder is a link ({}): roster won't follow it",
                        p.display()
                    ));
                }
                Ok(meta) if !meta.is_dir() => return Err(format!("{} isn't a folder", p.display())),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(format!("{}: {e}", p.display())),
            }
        }
        Ok(Some(self.dir.clone()))
    }

    /// The path of file `name`, checked: a plain name, and not a link if it's there.
    fn file(&self, dir: &Path, name: &str) -> Result<Option<(PathBuf, u64)>, String> {
        check_name(name)?;
        let path = dir.join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if is_link(&meta) => Err(format!("{name} is a link: roster won't follow it")),
            Ok(meta) if !meta.is_file() => Err(format!("{name} isn't a file")),
            Ok(meta) => Ok(Some((path, meta.len()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{name}: {e}")),
        }
    }

    /// File `name`'s bytes, or None when there's no such file.
    pub fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        check_name(name)?;
        let Some(dir) = self.folder()? else { return Ok(None) };
        let Some((path, _)) = self.file(&dir, name)? else {
            return Ok(None);
        };
        std::fs::read(&path).map(Some).map_err(|e| format!("{name}: {e}"))
    }

    /// Replaces (or makes) file `name` with `bytes`, all at once.
    pub fn write(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        check_name(name)?;
        if bytes.len() > MAX_FILE {
            return Err(format!(
                "{name} would be {} bytes: a file holds at most 1 MB ({MAX_FILE} bytes)",
                bytes.len()
            ));
        }
        let dir = match self.folder()? {
            Some(d) => d,
            None => {
                std::fs::create_dir_all(&self.dir).map_err(|e| format!("can't make the data folder: {e}"))?;
                self.folder()?.ok_or("can't make the data folder")?
            }
        };
        let old = self.file(&dir, name)?;
        let (count, total) = self.usage(&dir)?;
        let old_len = old.as_ref().map_or(0, |(_, n)| *n as usize);
        if old.is_none() && count >= MAX_FILES {
            return Err(format!("the Plugin's data folder holds at most {MAX_FILES} files"));
        }
        if total - old_len + bytes.len() > MAX_TOTAL {
            return Err(format!(
                "the Plugin's data folder holds at most 10 MB ({MAX_TOTAL} bytes), and this would make it {}",
                total - old_len + bytes.len()
            ));
        }
        let path = dir.join(name);
        let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let written = (|| {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
            drop(f);
            std::fs::rename(&tmp, &path)
        })();
        if let Err(e) = written {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("can't write {name}: {e}"));
        }
        Ok(())
    }

    /// The names of the files there, in order (links and leftovers left out).
    pub fn list(&self) -> Result<Vec<String>, String> {
        let Some(dir) = self.folder()? else {
            return Ok(Vec::new());
        };
        let mut names = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if check_name(&name).is_err() {
                continue;
            }
            if let Ok(meta) = std::fs::symlink_metadata(entry.path())
                && meta.is_file()
                && !is_link(&meta)
            {
                names.push(name);
            }
        }
        names.sort();
        Ok(names)
    }

    /// Removes file `name`: true if it was there.
    pub fn remove(&self, name: &str) -> Result<bool, String> {
        check_name(name)?;
        let Some(dir) = self.folder()? else { return Ok(false) };
        let Some((path, _)) = self.file(&dir, name)? else {
            return Ok(false);
        };
        std::fs::remove_file(&path).map_err(|e| format!("can't remove {name}: {e}"))?;
        Ok(true)
    }

    /// How full the folder is: one listing of it and each entry's metadata, never a link
    /// followed and never a file opened, so it's cheap for many Plugins.
    pub fn data_use(&self) -> DataUse {
        match self.folder() {
            Ok(None) => DataUse::None,
            Ok(Some(dir)) => match self.usage(&dir) {
                Ok((files, bytes)) => DataUse::Used {
                    files,
                    bytes: bytes as u64,
                },
                Err(message) => DataUse::Problem { message },
            },
            Err(message) => DataUse::Problem { message },
        }
    }

    /// How many files, and how many bytes, the folder holds (temporary files count; links don't).
    fn usage(&self, dir: &Path) -> Result<(usize, usize), String> {
        let (mut count, mut total) = (0, 0);
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if let Ok(meta) = std::fs::symlink_metadata(entry.path())
                && meta.is_file()
                && !is_link(&meta)
            {
                count += 1;
                total += meta.len() as usize;
            }
        }
        Ok((count, total))
    }
}

/// Removes the data folder of the Plugin `plugin` under `data`, with everything in it: true if
/// there was one. A folder that is a link loses only the link, never what it leads to.
pub fn forget(data: &Path, plugin: &str) -> Result<bool, String> {
    if !plugin_name(plugin) {
        return Err(format!("{plugin:?} isn't a Plugin's name"));
    }
    let parent = data.join(DATA_DIR);
    if let Ok(meta) = std::fs::symlink_metadata(&parent)
        && is_link(&meta)
    {
        return Err(format!("{} is a link: roster won't follow it", parent.display()));
    }
    let dir = parent.join(plugin);
    match std::fs::symlink_metadata(&dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{}: {e}", dir.display())),
        Ok(meta) if is_link(&meta) => {
            // A junction is a folder to Windows: remove_dir takes the link away, not its target.
            std::fs::remove_file(&dir)
                .or_else(|_| std::fs::remove_dir(&dir))
                .map_err(|e| format!("can't remove {}: {e}", dir.display()))?;
            Ok(true)
        }
        Ok(_) => {
            // remove_dir_all doesn't follow symlinks inside (it removes the links themselves).
            std::fs::remove_dir_all(&dir).map_err(|e| format!("can't remove {}: {e}", dir.display()))?;
            Ok(true)
        }
    }
}
