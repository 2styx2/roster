//! roster-core's layers (docs/architecture.md, "The Rust core"): the neutral modules stand on
//! nothing of the crate's, and the Config never reaches into the Plugin host, so init.lua's loader
//! builds and tests without it. Read from the source: a `crate::` path in code (not in a comment).

use std::fs;
use std::path::{Path, PathBuf};

const DOC: &str = "docs/architecture.md";

/// Modules that use nothing else of the crate's: anything may use them.
const NEUTRAL: &[&str] = &[
    "anchor.rs",
    "env.rs",
    "error.rs",
    "files.rs",
    "platform.rs",
    "process.rs",
    "proxy.rs",
    "wipe.rs",
];

fn src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(rust_files(&path));
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    out
}

/// Each line of code in FILE that names `crate::WHAT` (`use crate::plugin::…`, `crate::plugin::x()`),
/// as `file:line: text`. Comment lines, doc links among them, don't count.
fn uses(file: &Path, what: &str) -> Vec<String> {
    let needle = format!("crate::{what}");
    let text = fs::read_to_string(file).unwrap();
    text.lines()
        .enumerate()
        .filter(|(_, l)| !l.trim_start().starts_with("//"))
        .filter(|(_, l)| {
            l.match_indices(&needle).any(|(i, _)| {
                let next = l[i + needle.len()..].chars().next();
                what.is_empty() || !next.is_some_and(|c| c.is_alphanumeric() || c == '_')
            })
        })
        .map(|(n, l)| format!("{}:{}: {}", file.display(), n + 1, l.trim()))
        .collect()
}

#[test]
fn the_neutral_modules_use_nothing_of_the_crate() {
    let mut bad = Vec::new();
    for name in NEUTRAL {
        let file = src().join(name);
        assert!(file.exists(), "{name} is gone: update NEUTRAL here and {DOC}");
        bad.extend(uses(&file, ""));
    }
    assert!(
        bad.is_empty(),
        "{DOC}, \"The Rust core\": a neutral module uses nothing of the crate's (move what it needs into it, or it isn't neutral):\n  {}",
        bad.join("\n  ")
    );
}

#[test]
fn the_config_never_uses_the_plugin_host() {
    let bad: Vec<String> = rust_files(&src().join("config"))
        .iter()
        .flat_map(|f| uses(f, "plugin"))
        .collect();
    assert!(
        bad.is_empty(),
        "{DOC}, \"The Rust core\": config/ doesn't use crate::plugin (what both need goes in a neutral module or in config, which plugin uses):\n  {}",
        bad.join("\n  ")
    );
}
