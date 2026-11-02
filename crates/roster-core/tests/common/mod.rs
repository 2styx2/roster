//! What the integration tests share. Each test file that needs it says `mod common;`.

use std::ops::Deref;
use std::path::Path;

/// A fresh, empty folder in the temp dir, named `roster-core-<what>-<random>`, deleted with
/// everything in it when this is dropped: at the end of the test, and when the test panics.
/// Keep it alive for as long as the test uses the folder (`let dir = temp(..)`, not
/// `temp(..).to_path_buf()`).
pub struct Temp(tempfile::TempDir);

/// A fresh, empty folder for one test; `what` says which tests made it, should one be left behind.
pub fn temp(what: &str) -> Temp {
    let dir = tempfile::Builder::new()
        .prefix(&format!("roster-core-{what}-"))
        .tempdir()
        .expect("a temp folder");
    Temp(dir)
}

impl Deref for Temp {
    type Target = Path;
    fn deref(&self) -> &Path {
        self.0.path()
    }
}

impl AsRef<Path> for Temp {
    fn as_ref(&self) -> &Path {
        self.0.path()
    }
}
