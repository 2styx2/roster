//! Writes the Plugin API's reference, stubs and data from `roster_core::plugin::api` (ticket 70,
//! decision Q89), like scripts/gen-serve-api.py does for serve's tables. From the repo's root:
//!
//!     cargo run -p roster-core --example gen_plugin_api            # rewrites the four files
//!     cargo run -p roster-core --example gen_plugin_api -- --check # exits 1 if one is out of date
//!
//! crates/roster-core/tests/plugin_api.rs makes the same comparison, so a stale file fails the tests.

use roster_core::plugin::api;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let check = std::env::args().any(|a| a == "--check");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut stale = false;
    for (path, text) in api::generated() {
        let file = root.join(path);
        if std::fs::read_to_string(&file).ok().as_deref() == Some(text.as_str()) {
            continue;
        }
        if check {
            eprintln!("{path} is out of date: run  {}", api::COMMAND);
            stale = true;
        } else {
            std::fs::write(&file, text).unwrap_or_else(|e| panic!("can't write {path}: {e}"));
            println!("rewrote {path}");
        }
    }
    if stale { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}
