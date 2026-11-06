//! roster-core's layers (docs/architecture.md, "The Rust core"): every module has a row in the
//! page's table, the neutral modules stand on nothing of the crate's, a part never uses a facade,
//! and no module reaches itself through any path. Read from the source: a `crate::` path in code
//! (not in a comment), counted for the top-level module whose file or folder holds it.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const DOC: &str = "docs/architecture.md";
const SECTION: &str = "\"The Rust core\"";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn src() -> PathBuf {
    crate_dir().join("src")
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

/// The top-level modules `lib.rs` declares (`mod x;`, `pub mod x;`).
fn declared() -> BTreeSet<String> {
    fs::read_to_string(src().join("lib.rs"))
        .unwrap()
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let l = l.strip_prefix("pub ").unwrap_or(l);
            l.strip_prefix("mod ")?.strip_suffix(';').map(str::to_string)
        })
        .collect()
}

/// The page's table between `<!-- layers:rust -->` and its end: module → layer.
fn table() -> BTreeMap<String, String> {
    let page = fs::read_to_string(crate_dir().join("../..").join(DOC)).unwrap();
    let start = page.find("<!-- layers:rust -->").expect("the layers:rust marker");
    let end = page.find("<!-- /layers:rust -->").expect("the /layers:rust marker");
    let mut layers = BTreeMap::new();
    for row in page[start..end].lines().filter(|l| l.starts_with("| `")) {
        let cells: Vec<&str> = row.split('|').map(str::trim).collect();
        let layer = cells[1].trim_matches('`').to_string();
        for module in cells[2].split(',') {
            let module = module.trim().trim_matches('`').to_string();
            assert!(
                layers.insert(module.clone(), layer.clone()).is_none(),
                "{DOC}, {SECTION}: `{module}` has two rows"
            );
        }
    }
    layers
}

/// Each top-level module's uses of the others: module → (used module → the first line naming it).
fn graph() -> BTreeMap<String, BTreeMap<String, String>> {
    let modules = declared();
    let mut graph: BTreeMap<String, BTreeMap<String, String>> =
        modules.iter().map(|m| (m.clone(), BTreeMap::new())).collect();
    for file in rust_files(&src()) {
        let rel = file.strip_prefix(src()).unwrap();
        let top = rel.iter().next().unwrap().to_string_lossy();
        let top = top.strip_suffix(".rs").unwrap_or(&top).to_string();
        let Some(uses) = graph.get_mut(&top) else { continue };
        let text = fs::read_to_string(&file).unwrap();
        for (n, line) in text.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for (i, _) in line.match_indices("crate::") {
                let name: String = line[i + 7..]
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if name != top && modules.contains(&name) {
                    uses.entry(name)
                        .or_insert_with(|| format!("{}:{}: {}", rel.display(), n + 1, line.trim()));
                }
            }
        }
    }
    graph
}

#[test]
fn every_module_has_a_row_and_every_row_a_module() {
    let (modules, rows) = (declared(), table());
    let missing: Vec<&String> = modules.iter().filter(|m| !rows.contains_key(*m)).collect();
    let gone: Vec<&String> = rows.keys().filter(|m| !modules.contains(*m)).collect();
    assert!(
        missing.is_empty() && gone.is_empty(),
        "{DOC}, {SECTION}: every module lib.rs declares has one row in the table. No row: {missing:?}; a row but no module: {gone:?}"
    );
    for layer in rows.values() {
        assert!(
            ["neutral", "part", "facade"].contains(&layer.as_str()),
            "{DOC}, {SECTION}: no layer {layer:?}"
        );
    }
}

#[test]
fn neutral_modules_use_nothing_and_parts_use_no_facade() {
    let (rows, graph) = (table(), graph());
    let mut bad = Vec::new();
    for (module, uses) in &graph {
        let Some(layer) = rows.get(module) else { continue };
        for (used, line) in uses {
            let used_layer = rows.get(used).map(String::as_str);
            let wrong = match layer.as_str() {
                "neutral" => true,
                "part" => used_layer == Some("facade"),
                _ => false,
            };
            if wrong {
                bad.push(format!(
                    "{module} ({layer}) uses {used} ({}): {line}",
                    used_layer.unwrap_or("?")
                ));
            }
        }
    }
    assert!(
        bad.is_empty(),
        "{DOC}, {SECTION}: a neutral module uses nothing of the crate's, and a part uses no facade (move what both need down):\n  {}",
        bad.join("\n  ")
    );
}

#[test]
fn no_module_reaches_itself() {
    let graph = graph();
    // Depth-first from each module; a path back to it is a cycle, shown with each step's line.
    fn path_to(
        graph: &BTreeMap<String, BTreeMap<String, String>>,
        from: &str,
        target: &str,
        seen: &mut BTreeSet<String>,
    ) -> Option<Vec<String>> {
        for (next, line) in &graph[from] {
            if next == target {
                return Some(vec![line.clone()]);
            }
            if seen.insert(next.clone())
                && let Some(mut rest) = path_to(graph, next, target, seen)
            {
                rest.insert(0, line.clone());
                return Some(rest);
            }
        }
        None
    }
    let cycles: Vec<String> = graph
        .keys()
        .filter_map(|m| path_to(&graph, m, m, &mut BTreeSet::new()).map(|p| format!("{m}:\n    {}", p.join("\n    "))))
        .collect();
    assert!(
        cycles.is_empty(),
        "{DOC}, {SECTION}: no module reaches itself through others (move the shared piece down):\n  {}",
        cycles.join("\n  ")
    );
}
