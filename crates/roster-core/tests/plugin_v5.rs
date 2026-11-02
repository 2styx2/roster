//! The Plugin API's version 5 (ticket 145, decision Q134): its objects are complete, as init.lua's
//! are. Taking away what the Plugin never added is an error at the caller's line, a key context
//! that isn't one too, and each collection says what the Plugin has (`get`, `has`, `list`), as
//! copies. A Plugin written for api 4 or older keeps the old quiet removals. Driven through
//! `PluginHost`, as the Tauri shell does.

mod common;

use roster_core::plugin::{Limits, PluginHost, Serve, Source};
use serde_json::{Value, json};
use std::sync::Arc;

struct NoServe;

impl Serve for NoServe {
    fn call(&self, method: &str, _params: Value) -> Result<Value, String> {
        Err(format!("unknown method {method} (code -32601)"))
    }
}

/// Loads `init` as a Plugin written for `api`; gives the load's ops and its error.
fn load_api(test: &str, api: u32, init: &str) -> (Vec<Value>, Option<String>) {
    let dir = common::temp(&format!("plugin-v5-{test}"));
    let manifest = format!("return {{ name = \"t\", version = \"1.0.0\", api = {api} }}");
    std::fs::write(dir.join("roster-plugin.lua"), manifest).unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    (
        reply.ops,
        reply.error.map(|e| match (e.file, e.line) {
            (Some(f), Some(l)) => format!("{f}:{l}: {}", e.message),
            _ => e.message,
        }),
    )
}

fn load(test: &str, init: &str) -> (Vec<Value>, Option<String>) {
    load_api(test, 5, init)
}

/// The text of the status segment `id` the ops set.
fn said(ops: &[Value], id: &str) -> String {
    ops.iter()
        .rev()
        .find(|o| o["op"] == "status" && o["id"] == id)
        .and_then(|o| o["spec"]["text"].as_str())
        .unwrap_or_else(|| panic!("no status {id} in {ops:?}"))
        .to_string()
}

#[test]
fn the_api_version_is_5() {
    let (ops, error) = load(
        "version",
        r#"roster.status.set("v", { text = tostring(roster.api_version) })"#,
    );
    assert_eq!(error, None);
    assert_eq!(said(&ops, "v"), "5");
}

#[test]
fn removing_a_theme_the_plugin_never_defined_is_an_error_at_its_line() {
    let (ops, error) = load("theme-missing", "local x = 1\n\nroster.themes.remove(\"dusk\")\n");
    assert_eq!(
        error.as_deref(),
        Some(
            "init.lua:3: roster.themes.remove: the Plugin has no Theme \"dusk\" (roster.themes.list() names its own; roster.themes.define adds one)"
        )
    );
    assert!(ops.is_empty(), "{ops:?}");
}

#[test]
fn deleting_a_binding_the_plugin_never_set_is_an_error_at_its_line() {
    let (_, error) = load("key-missing", "\nroster.keymap.del(\"leader\", \"w w\")\n");
    assert_eq!(
        error.as_deref(),
        Some(
            "init.lua:2: roster.keymap.del: the Plugin binds no \"w w\" in leader (a Plugin takes off only its own bindings)"
        )
    );
    // `set(…, false)`, the old way to say it, is the same.
    let (_, error) = load("key-missing-false", "roster.keymap.set(\"leader\", \"w w\", false)\n");
    assert!(
        error
            .unwrap()
            .contains("roster.keymap.set: the Plugin binds no \"w w\" in leader"),
    );
}

#[test]
fn a_key_context_that_isnt_one_is_an_error_at_its_line() {
    let (_, error) = load("key-context", "roster.keymap.set(\"leadr\", \"w w\", \"alerts\")\n");
    assert_eq!(
        error.as_deref(),
        Some(
            "init.lua:1: roster.keymap.set: \"leadr\" isn't a key context (a Plugin binds keys in leader, list or list_vim)"
        )
    );
}

#[test]
fn what_the_plugin_added_it_can_take_away() {
    let (ops, error) = load(
        "roundtrip",
        r#"
        roster.themes.define("dusk", { appearance = "dark" })
        roster.themes.remove("dusk")
        roster.keymap.set("leader", "w w", "alerts")
        roster.keymap.del("leader", "w w")
        roster.commands.add("alerts", { run = "messages" })
        roster.commands.remove("alerts")
        roster.views.set("v", { title = "V" })
        roster.views.update("v", { title = "W" })
        roster.views.remove("v")
        roster.details.set("d", "esx-02", { title = "D" })
        roster.details.remove("d")
        "#,
    );
    assert_eq!(error, None);
    assert_eq!(ops.len(), 11, "{ops:?}");
}

#[test]
fn every_set_and_remove_collection_errors_on_a_missing_id() {
    for (module, noun) in [
        ("commands", "command"),
        ("sidebar", "Sidebar section"),
        ("status", "status segment"),
        ("finders", "finder"),
        ("help", "help page"),
        ("health", "`:check` section"),
        ("tutor", "tutorial"),
        ("toolbar", "toolbar control"),
        ("progress", "progress"),
        ("views", "view"),
        ("details", "Host-details section"),
    ] {
        let (_, error) = load(
            &format!("missing-{module}"),
            &format!("roster.{module}.remove(\"x\")\n"),
        );
        assert_eq!(
            error.as_deref(),
            Some(
                format!("init.lua:1: roster.{module}.remove: the Plugin has no {noun} \"x\" (roster.{module}.list() names its own)")
                    .as_str()
            ),
        );
    }
    for call in [
        r#"roster.views.update("x", { title = "X" })"#,
        r#"roster.views.close("x")"#,
    ] {
        let (_, error) = load("missing-view", call);
        assert!(error.unwrap().contains("the Plugin has no view \"x\""), "{call}");
    }
}

/// A failed run's additions never reached the app, so the Plugin doesn't have them either.
#[test]
fn a_failed_call_adds_nothing() {
    let dir = common::temp("plugin-v5-undo");
    std::fs::write(
        dir.join("roster-plugin.lua"),
        "return { name = \"t\", version = \"1.0.0\", api = 5 }",
    )
    .unwrap();
    std::fs::write(
        dir.join("init.lua"),
        r#"
        roster.status.set("kept", { text = "x" })
        roster.commands.add("boom", { run = function()
          roster.status.set("gone", { text = "x" })
          roster.status.remove("kept")
          error("no")
        end })
        roster.commands.add("check", { run = function()
          return tostring(roster.status.has("gone")) .. " " .. tostring(roster.status.has("kept"))
        end })
        "#,
    )
    .unwrap();
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    let (manifest, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let handler = |name: &str| {
        reply
            .ops
            .iter()
            .find(|o| o["op"] == "command" && o["name"] == name)
            .and_then(|o| o["run"]["handler"].as_u64())
            .unwrap()
    };
    assert!(host.call(&manifest.name, handler("boom"), json!({})).error.is_some());
    assert_eq!(
        host.call(&manifest.name, handler("check"), json!({})).result,
        "false true"
    );
}

#[test]
fn collections_say_what_the_plugin_has_as_copies() {
    let (ops, error) = load(
        "reads",
        r#"
        local spec = { text = "3 alerts", tooltip = "Recent" }
        roster.status.set("alerts", spec)
        spec.text = "changed after"
        local got = roster.status.get("alerts")
        got.text = "changed the copy"
        roster.sidebar.set("b", { title = "B" })
        roster.sidebar.set("a", { title = "A" })
        roster.themes.define("dusk", { appearance = "dark" })
        roster.keymap.set("leader", "w w", "alerts")
        roster.keymap.set("list", "g a", "alerts")
        roster.commands.add("alerts", { desc = "Alerts", run = function() end })
        roster.views.set("v", { title = "V" })
        roster.details.set("d", "esx-02", { title = "D" })
        roster.details.set("d", "esx-03", { title = "E" })
        local keys = roster.keymap.list("leader")
        keys["w w"] = "changed"
        local out = {
          roster.status.get("alerts").text,
          tostring(roster.status.has("alerts")), tostring(roster.status.has("nope")),
          tostring(roster.status.get("nope")),
          table.concat(roster.sidebar.list(), ","),
          table.concat(roster.themes.list(), ","), roster.themes.get("dusk").appearance,
          tostring(roster.themes.has("dusk")),
          roster.keymap.get("leader", "w w"), tostring(roster.keymap.get("leader", "x")),
          tostring(roster.keymap.has("list", "g a")), roster.keymap.list("leader")["w w"],
          roster.commands.get("alerts").desc, type(roster.commands.get("alerts").run),
          table.concat(roster.commands.list(), ","), tostring(roster.commands.has("alerts")),
          table.concat(roster.views.list(), ","), tostring(roster.views.has("v")),
          table.concat(roster.details.list(), ","), table.concat(roster.details.list("d"), ","),
          roster.details.get("d", "esx-03").title, tostring(roster.details.has("d")),
          tostring(roster.details.has("d", "esx-09")),
        }
        roster.status.set("v", { text = table.concat(out, "|") })
        "#,
    );
    assert_eq!(error, None);
    assert_eq!(
        said(&ops, "v"),
        "3 alerts|true|false|nil|a,b|dusk|dark|true|alerts|nil|true|alerts|Alerts|function|alerts|true|v|true|d|esx-02,esx-03|E|true|false"
    );
}

#[test]
fn a_removed_one_is_gone_from_the_reads() {
    let (ops, error) = load(
        "reads-removed",
        r#"
        roster.help.set("alerts", { title = "Alerts", text = "x" })
        roster.help.remove("alerts")
        roster.details.set("d", "esx-02", { title = "D" })
        roster.details.set("d", "esx-02", nil)
        roster.status.set("v", { text = tostring(roster.help.has("alerts")) .. " " .. #roster.help.list()
          .. " " .. tostring(roster.details.has("d")) })
        "#,
    );
    assert_eq!(error, None);
    assert_eq!(said(&ops, "v"), "false 0 false");
}

#[test]
fn reads_check_the_name_like_setting_does() {
    let (_, error) = load("reads-bad-id", "roster.status.get(\"Bad Id\")\n");
    assert!(
        error
            .unwrap()
            .contains("roster.status.get: \"Bad Id\" isn't a name like"),
    );
    let (_, error) = load("reads-bad-context", "roster.keymap.list(\"leadr\")\n");
    assert!(
        error
            .unwrap()
            .contains("roster.keymap.list: \"leadr\" isn't a key context")
    );
}

/// A Plugin written for api 4 or older keeps the quiet removals it was written against.
#[test]
fn a_plugin_written_for_api_4_keeps_the_quiet_removals() {
    let (ops, error) = load_api(
        "older",
        4,
        r#"
        roster.themes.remove("dusk")
        roster.keymap.del("leader", "w w")
        roster.status.remove("x")
        roster.views.close("x")
        "#,
    );
    assert_eq!(error, None);
    assert_eq!(
        ops,
        [
            json!({ "op": "remove", "kind": "theme", "id": "dusk" }),
            json!({ "op": "key", "context": "leader", "keys": "w w", "action": false }),
            json!({ "op": "remove", "kind": "status", "id": "x" }),
            json!({ "op": "view_close", "id": "x" }),
        ]
    );
}

/// `roster.badges` is complete too (#262): `get`, `has`, `list` and `remove`, and taking off a
/// badge the Plugin never put on is an error, `set(host, nil)` (the old spelling) as `remove`.
#[test]
fn badges_read_back_and_removing_a_missing_one_is_an_error_at_its_line() {
    let (ops, error) = load(
        "badges",
        r#"
        roster.badges.set("esx-03", "2")
        roster.badges.set("esx-02", "pending")
        roster.badges.set("db-9", "1")
        roster.badges.remove("db-9")
        roster.badges.set("esx-03", nil)
        roster.status.set("v", { text = table.concat({
          table.concat(roster.badges.list(), ","), roster.badges.get("esx-02"),
          tostring(roster.badges.get("esx-03")), tostring(roster.badges.has("esx-02")),
          tostring(roster.badges.has("db-9")),
        }, "|") })
        "#,
    );
    assert_eq!(error, None);
    assert_eq!(said(&ops, "v"), "esx-02|pending|nil|true|false");
    assert!(ops.contains(&json!({ "op": "badge", "host": "db-9", "text": null })));
    let (ops, error) = load("badges-missing", "\nroster.badges.remove(\"esx-02\")\n");
    assert_eq!(
        error.as_deref(),
        Some(
            "init.lua:2: roster.badges.remove: the Plugin has no badge on \"esx-02\" (roster.badges.list() names its Hosts)"
        )
    );
    assert!(ops.is_empty(), "{ops:?}");
    let (_, error) = load("badges-missing-nil", "roster.badges.set(\"esx-02\", nil)\n");
    assert_eq!(
        error.as_deref(),
        Some(
            "init.lua:1: roster.badges.set: the Plugin has no badge on \"esx-02\" (roster.badges.list() names its Hosts)"
        )
    );
}

#[test]
fn a_plugin_written_for_api_4_takes_off_a_missing_badge_quietly() {
    let (ops, error) = load_api(
        "badges-older",
        4,
        "roster.badges.remove(\"esx-02\")\nroster.badges.set(\"esx-03\", nil)\n",
    );
    assert_eq!(error, None);
    assert_eq!(
        ops,
        [
            json!({ "op": "badge", "host": "esx-02", "text": null }),
            json!({ "op": "badge", "host": "esx-03", "text": null }),
        ]
    );
}
