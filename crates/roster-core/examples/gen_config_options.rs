//! Writes the option reference, the init.lua stubs and their data from
//! `roster_core::config::shape` (decision Q132), as gen_plugin_api does for the Plugin API, and
//! the snapshot of today's CONFIG_VERSION (`shape::version`: new names are added, the others keep
//! what the committed snapshot says). From the repo's root:
//!
//!     cargo run -p roster-core --example gen_config_options            # rewrites the files
//!     cargo run -p roster-core --example gen_config_options -- --check # exits 1 if one is out of date
//!
//! crates/roster-core/tests/config_shape.rs makes the same comparison, so a stale file fails the tests.

use roster_core::config::{CONFIG_VERSION, shape};
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let check = std::env::args().any(|a| a == "--check");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut stale = false;
    let snapshot = shape::version::snapshot_path(CONFIG_VERSION);
    let committed = std::fs::read_to_string(root.join(&snapshot)).ok();
    for (path, text) in [
        (shape::DOC_PATH, shape::markdown()),
        (shape::STUBS_PATH, shape::stubs()),
        (shape::JSON_PATH, shape::json_text()),
        (shape::CHECK_PATH, shape::check_lua()),
        (snapshot.as_str(), shape::version::current_text(committed.as_deref())),
    ] {
        let file = root.join(path);
        if std::fs::read_to_string(&file).ok().as_deref() == Some(text.as_str()) {
            continue;
        }
        if check {
            eprintln!("{path} is out of date: run  {}", shape::COMMAND);
            stale = true;
        } else {
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir).unwrap_or_else(|e| panic!("can't make {}: {e}", dir.display()));
            }
            std::fs::write(&file, text).unwrap_or_else(|e| panic!("can't write {path}: {e}"));
            println!("rewrote {path}");
        }
    }
    if stale { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}
