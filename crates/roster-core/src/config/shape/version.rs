//! The snapshot that keeps `roster.config_version` honest (CONFIG_VERSION, decision Q165; ticket
//! 181). Every init.lua name of the generated shape data ([`super::JSON_PATH`]) with its type or
//! signature, kept per CONFIG_VERSION in [`SNAPSHOT_DIR`]. tests/config_version.rs fails when a
//! name of the snapshot is gone or changed while CONFIG_VERSION is the same; a new name passes.
//!
//! `gen_config_options` writes the snapshot of today's CONFIG_VERSION with [`refreshed`]: it adds
//! new names and keeps what the committed snapshot says about the others, so regenerating can't
//! paper over a removal or a change. Raising CONFIG_VERSION starts a new snapshot from today's
//! shape; the old ones stay as they were.

use serde_json::Value;
use std::collections::BTreeMap;

/// Where the snapshots live, one `N.json` per CONFIG_VERSION.
pub const SNAPSHOT_DIR: &str = "crates/roster-core/tests/fixtures/config-version";

/// Every name → what it is: its type, or a function's signature.
pub type Names = BTreeMap<String, String>;

pub fn snapshot_path(version: u32) -> String {
    format!("{SNAPSHOT_DIR}/{version}.json")
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn list(v: &Value) -> impl Iterator<Item = &Value> {
    v.as_array().into_iter().flatten()
}

/// The names of the shape data (config-options.json, parsed), each with its type or signature.
/// An option, value or type: its kind and type. A function: its parameters' types in order and
/// what it returns (a parameter's name isn't recorded: Lua passes them by position). A type's
/// field: its type, and whether it's required. A fixed table's keys (`colors.accent`), and the
/// methods and usages an entry lists (`:has(key)`, `roster.o.theme = value`): that they're there.
pub fn snapshot(data: &Value) -> Names {
    let mut names = Names::new();
    for entry in list(&data["sections"]).flat_map(|section| list(&section["entries"])) {
        let tag = s(&entry["tag"]);
        let kind = s(&entry["kind"]);
        let ty = s(&entry["ty"]);
        let what = s(&entry["what"]);
        let rows = || list(&entry["rows"]);
        let described = match what {
            "function" => {
                let params: Vec<String> = rows()
                    .map(|r| {
                        let t = s(&r["ty"]);
                        if s(&r["name"]) == "..." {
                            format!("...{t}")
                        } else {
                            t.to_string()
                        }
                    })
                    .collect();
                let gives = if ty.is_empty() { "nothing" } else { ty };
                format!("function({}) -> {gives}", params.join(", "))
            }
            _ if kind.is_empty() => format!("{what}: {ty}"),
            _ => format!("{what} {kind}: {ty}"),
        };
        names.insert(tag.to_string(), described);
        for n in list(&entry["names"]) {
            names.insert(format!("{tag}.{}", s(n)), "name".into());
        }
        // How it's used, as its help entry lists it: a method (`:has(key)`), a key (`.KEY`) or
        // a whole line (`roster.o.theme = value`).
        for m in list(&entry["methods"]).map(s) {
            let key = if m.starts_with([':', '.']) {
                format!("{tag}{m}")
            } else {
                m.to_string()
            };
            let what = if m.starts_with(':') { "method" } else { "usage" };
            names.insert(key, what.into());
        }
        if what != "function" {
            for r in rows() {
                let field = format!("{tag}.{}", s(&r["name"]));
                let required = if s(&r["default"]) == "required" {
                    " (required)"
                } else {
                    ""
                };
                names.insert(field.clone(), format!("field: {}{required}", s(&r["ty"])));
                for n in list(&r["names"]) {
                    names.insert(format!("{field}.{}", s(n)), "name".into());
                }
            }
        }
    }
    names
}

/// What changed between the committed snapshot and today's, in name order: `removed: NAME` or
/// `changed: NAME: was …, now …`. A name only today has isn't a change.
pub fn breaks(committed: &Names, today: &Names) -> Vec<String> {
    committed
        .iter()
        .filter_map(|(name, was)| match today.get(name) {
            None => Some(format!("removed: {name}")),
            Some(now) if now != was => Some(format!("changed: {name}: was `{was}`, now `{now}`")),
            Some(_) => None,
        })
        .collect()
}

/// A snapshot file's text.
pub fn snapshot_text(version: u32, names: &Names) -> String {
    let doc = serde_json::json!({
        "generated": format!(
            "init.lua's names at CONFIG_VERSION {version}, from {} by `{}`; tests/config_version.rs \
             fails when one is removed or changed without raising CONFIG_VERSION",
            super::JSON_PATH,
            super::COMMAND
        ),
        "configVersion": version,
        "names": names,
    });
    let mut text = serde_json::to_string_pretty(&doc).expect("a snapshot is JSON");
    text.push('\n');
    text
}

/// A snapshot file's names.
pub fn parse(text: &str) -> Result<Names, String> {
    let doc: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    serde_json::from_value(doc["names"].clone()).map_err(|e| format!("names: {e}"))
}

/// The snapshot of `version` the generator writes: the committed one with today's new names
/// added (what it says about the others is kept), or today's names when there's none yet.
pub fn refreshed(version: u32, committed: Option<&str>, today: &Names) -> String {
    let mut names = committed.and_then(|t| parse(t).ok()).unwrap_or_default();
    for (name, what) in today {
        names.entry(name.clone()).or_insert_with(|| what.clone());
    }
    snapshot_text(version, &names)
}

/// The test's failure: what changed, and what to do about it.
pub fn failure(version: u32, breaks: &[String]) -> String {
    format!(
        "init.lua names were removed or changed but roster.config_version is still {version}:\n  {}\n\n\
         A Config written for {version} may stop working. If the change is meant, raise CONFIG_VERSION in \
         crates/roster-core/src/config/mod.rs (to {next}), add a docs/news.md bullet under \
         \"## Unreleased\" that names {next} and what changed, then refresh the snapshot with  {cmd}  \
         (it writes {path}). If it isn't meant, put the name back as it was. A new name doesn't \
         need any of this (decision Q165).",
        breaks.join("\n  "),
        next = version + 1,
        cmd = super::COMMAND,
        path = snapshot_path(version + 1),
    )
}

/// The snapshot of today's CONFIG_VERSION as the generator writes it, given the committed text.
pub fn current_text(committed: Option<&str>) -> String {
    let data: Value = serde_json::from_str(&super::json_text()).expect("the shape data is JSON");
    refreshed(crate::config::CONFIG_VERSION, committed, &snapshot(&data))
}
