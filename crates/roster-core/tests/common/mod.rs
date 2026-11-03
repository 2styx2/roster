//! What the integration tests share. Each test file that needs it says `mod common;`.

use roster_core::plugin::{Limits, Manifest, PluginError, read_manifest_within};
use std::ops::Deref;
use std::path::Path;
use std::time::Duration;

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

/// `roster_core::plugin::read_manifest` with a minute to read it, not the default second: a
/// loaded machine pauses a process for longer, and the tests that call it aren't about that
/// limit (T161; `a_manifest_is_read_within_the_hosts_load_limit` in plugin.rs is).
#[allow(dead_code)] // not every test file reads a manifest
pub fn read_manifest(dir: &Path) -> Result<Manifest, PluginError> {
    let unhurried = Limits {
        load: Duration::from_secs(60),
        ..Limits::default()
    };
    read_manifest_within(dir, unhurried)
}
