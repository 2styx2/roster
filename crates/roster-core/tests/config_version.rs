//! `roster.config_version` (CONFIG_VERSION, decision Q165) rises when an init.lua name is removed
//! or renamed, or keeps its name but takes, gives or does something else; a new name doesn't raise
//! it. The generated shape data (tests/fixtures/config-options.json) is snapshotted per
//! CONFIG_VERSION (tests/fixtures/config-version/N.json), and a name of the snapshot that is gone
//! or changed while CONFIG_VERSION stays the same fails here (ticket 181).

use roster_core::config::CONFIG_VERSION;
use roster_core::config::shape::{self, version};
use serde_json::{Value, json};
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// A shape fixture with one entry of each sort, as gen_config_options writes them.
fn fixture() -> Value {
    json!({
        "sections": [{
            "title": "t",
            "entries": [
                {"tag": "roster.os", "what": "value", "kind": "", "ty": "\"windows\"|\"linux\"",
                 "names": [], "rows": [], "methods": []},
                {"tag": "roster.themes.get", "what": "function", "kind": "", "ty": "roster.config.Theme?",
                 "names": [], "methods": [],
                 "rows": [{"name": "id", "ty": "string", "default": "", "names": []}]},
                {"tag": "roster.packages.add", "what": "function", "kind": "", "ty": "",
                 "names": [], "methods": [],
                 "rows": [{"name": "...", "ty": "string", "default": "", "names": []}]},
                {"tag": "colors", "what": "option", "kind": "object", "ty": "roster.config.UiColors",
                 "names": ["accent", "bg"], "rows": [], "methods": [":get()", ":reset()"]},
                {"tag": "roster.config.Folder", "what": "type", "kind": "object", "ty": "roster.config.Folder",
                 "names": [], "methods": [],
                 "rows": [{"name": "name", "ty": "string", "default": "required", "names": []},
                          {"name": "hosts", "ty": "string[]", "default": "{}", "names": []}]}
            ]
        }]
    })
}

fn entry<'a>(f: &'a mut Value, tag: &str) -> &'a mut Value {
    f["sections"][0]["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["tag"] == tag)
        .unwrap()
}

/// What the snapshot of [`fixture`] records, written out by hand.
#[test]
fn the_snapshot_records_every_name_with_its_type_or_signature() {
    let s = version::snapshot(&fixture());
    let want = [
        ("colors", "option object: roster.config.UiColors"),
        ("colors.accent", "name"),
        ("colors.bg", "name"),
        ("colors:get()", "method"),
        ("colors:reset()", "method"),
        ("roster.config.Folder", "type object: roster.config.Folder"),
        ("roster.config.Folder.hosts", "field: string[]"),
        ("roster.config.Folder.name", "field: string (required)"),
        ("roster.os", "value: \"windows\"|\"linux\""),
        ("roster.packages.add", "function(...string) -> nothing"),
        ("roster.themes.get", "function(string) -> roster.config.Theme?"),
    ];
    let got: Vec<(&str, &str)> = s.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    assert_eq!(got, want);
}

#[test]
fn a_new_name_passes() {
    let old = version::snapshot(&fixture());
    let mut f = fixture();
    entry(&mut f, "colors")["names"]
        .as_array_mut()
        .unwrap()
        .push(json!("tone"));
    entry(&mut f, "roster.config.Folder")["rows"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name": "icon", "ty": "string", "default": "unset", "names": []}));
    assert_eq!(version::breaks(&old, &version::snapshot(&f)), Vec::<String>::new());
}

#[test]
fn a_removed_or_renamed_name_fails() {
    let old = version::snapshot(&fixture());
    let mut f = fixture();
    entry(&mut f, "colors")["names"] = json!(["accent", "background"]);
    entry(&mut f, "roster.themes.get")["tag"] = json!("roster.themes.find");
    assert_eq!(
        version::breaks(&old, &version::snapshot(&f)),
        ["removed: colors.bg", "removed: roster.themes.get"]
    );
}

#[test]
fn a_name_that_takes_or_gives_something_else_fails() {
    let old = version::snapshot(&fixture());
    let mut f = fixture();
    entry(&mut f, "roster.themes.get")["ty"] = json!("boolean");
    entry(&mut f, "roster.os")["ty"] = json!("string");
    entry(&mut f, "roster.config.Folder")["rows"][1]["default"] = json!("required");
    assert_eq!(
        version::breaks(&old, &version::snapshot(&f)),
        [
            "changed: roster.config.Folder.hosts: was `field: string[]`, now `field: string[] (required)`",
            "changed: roster.os: was `value: \"windows\"|\"linux\"`, now `value: string`",
            "changed: roster.themes.get: was `function(string) -> roster.config.Theme?`, now `function(string) -> boolean`",
        ]
    );
}

/// The generator keeps what the committed snapshot says and adds the new names, so a change it
/// can't keep (a removal, a new type) still fails until CONFIG_VERSION is raised.
#[test]
fn refreshing_adds_new_names_and_keeps_the_old_ones() {
    let old = version::snapshot(&fixture());
    let committed = version::snapshot_text(4, &old);
    let mut f = fixture();
    entry(&mut f, "roster.os")["ty"] = json!("string");
    entry(&mut f, "colors")["names"] = json!(["accent", "tone"]);
    let refreshed = version::refreshed(4, Some(&committed), &version::snapshot(&f));
    let names = version::parse(&refreshed).unwrap();
    assert_eq!(names["roster.os"], "value: \"windows\"|\"linux\"");
    assert_eq!(names["colors.bg"], "name");
    assert_eq!(names["colors.tone"], "name");
    // A version with no snapshot yet starts from today's shape.
    let fresh = version::parse(&version::refreshed(5, None, &version::snapshot(&f))).unwrap();
    assert_eq!(fresh, version::snapshot(&f));
}

#[test]
fn the_failure_says_what_to_do() {
    let msg = version::failure(4, &["removed: colors.bg".to_string()]);
    assert!(msg.contains("removed: colors.bg"), "{msg}");
    assert!(msg.contains("raise CONFIG_VERSION"), "{msg}");
    assert!(msg.contains("crates/roster-core/src/config/mod.rs"), "{msg}");
    assert!(msg.contains("docs/news.md"), "{msg}");
    assert!(msg.contains(shape::COMMAND), "{msg}");
}

/// The real check: today's shape against the committed snapshot of today's CONFIG_VERSION.
#[test]
fn no_init_lua_name_changed_without_raising_config_version() {
    let path = version::snapshot_path(CONFIG_VERSION);
    let committed = std::fs::read_to_string(root().join(&path)).unwrap_or_else(|_| {
        panic!(
            "{path} is missing: there is no snapshot of CONFIG_VERSION {CONFIG_VERSION}'s shape. Run  {}",
            shape::COMMAND
        )
    });
    let old = version::parse(&committed).unwrap_or_else(|e| panic!("{path}: {e}"));
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(root().join(shape::JSON_PATH)).unwrap()).unwrap();
    let breaks = version::breaks(&old, &version::snapshot(&fixture));
    assert!(breaks.is_empty(), "{}", version::failure(CONFIG_VERSION, &breaks));
}
