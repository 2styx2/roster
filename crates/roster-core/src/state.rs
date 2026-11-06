//! The State file (GLOSSARY: State): what the app remembers on its own between runs, such as
//! recently used Hosts. One JSON object, `state.json` in the OS app-data dir, shared by every
//! window. The frontend owns its shape; the core only keeps it safe on disk. It is never the
//! Config (ADR 0004) and never holds secrets.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// The file's name inside the app-data dir.
pub const FILE_NAME: &str = "state.json";
/// A State bigger than this is a bug, not something to write.
pub const MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub enum StateError {
    /// Not a JSON object, or too big.
    Invalid(String),
    Io(std::io::Error),
}

impl std::fmt::Display for StateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StateError::Invalid(m) => write!(f, "can't save the State: {m}"),
            StateError::Io(e) => write!(f, "can't save the State: {e}"),
        }
    }
}

impl std::error::Error for StateError {}

impl From<std::io::Error> for StateError {
    fn from(e: std::io::Error) -> Self {
        StateError::Io(e)
    }
}

pub struct StateFile {
    path: PathBuf,
}

impl StateFile {
    /// The State file in `dir` (created on the first save).
    pub fn in_dir(dir: &Path) -> Self {
        StateFile {
            path: dir.join(FILE_NAME),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The saved State: `{}` when there's none yet. A file that isn't a JSON object is moved
    /// aside to `state.json.bad` (State is only a convenience, so the app starts fresh).
    pub fn load(&self) -> Value {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return Value::Object(Map::new());
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(v @ Value::Object(_)) => v,
            _ => {
                // If it can't be moved aside it's read (and refused) again next time: the app
                // still starts fresh, and the next save replaces it.
                let _ = std::fs::rename(&self.path, self.path.with_extension("json.bad"));
                Value::Object(Map::new())
            }
        }
    }

    /// Replaces the State with `state` (a JSON object), atomically: a crash leaves the old file
    /// or the new one, never half of one.
    pub fn save(&self, state: &Value) -> Result<(), StateError> {
        if !state.is_object() {
            return Err(StateError::Invalid("it isn't a JSON object".into()));
        }
        let text = serde_json::to_string_pretty(state).map_err(|e| StateError::Invalid(e.to_string()))?;
        if text.len() > MAX_BYTES {
            return Err(StateError::Invalid(format!(
                "it's {} bytes (at most {MAX_BYTES})",
                text.len()
            )));
        }
        Ok(crate::files::write_atomic(&self.path, &text)?)
    }
}
