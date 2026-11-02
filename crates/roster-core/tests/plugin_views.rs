//! Plugin views and Host-details sections (ticket 76, decision Q95): `roster.views` and
//! `roster.details` hand the app a view (a side panel or a full view) or a section of a Host's
//! details as data: text, facts and a table whose rows are plain data. A table's actions are
//! functions that get the row they ran on. Opening a view is the user's call, never the Plugin's
//! on its own.

mod common;

use roster_core::plugin::{Event, Limits, PluginHost, Serve, Source};
use serde_json::{Value, json};
use std::sync::Arc;

struct NoServe;

impl Serve for NoServe {
    fn call(&self, method: &str, _params: Value) -> Result<Value, String> {
        Err(format!("unknown method {method}"))
    }
}

fn plugin_dir(test: &str, init: &str) -> common::Temp {
    let dir = common::temp(&format!("plugin-views-{test}"));
    std::fs::write(
        dir.join("roster-plugin.lua"),
        "return { name = \"scan\", version = \"1.0.0\", description = \"A test\", api = 2, permissions = {} }",
    )
    .unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    dir
}

fn host() -> PluginHost {
    PluginHost::new(Arc::new(NoServe), Limits::default())
}

fn handler(v: &Value) -> u64 {
    v["handler"].as_u64().unwrap_or_else(|| panic!("no handler in {v}"))
}

const VIEW: &str = r#"
local roster = require("roster")
local kept = {}
roster.views.set("scan", {
  title = "Scan",
  place = "full",
  text = "10.0.0.0/24",
  facts = { { label = "found", value = "2" } },
  table = {
    columns = { { id = "name", label = "Host", kind = "data" }, { id = "ports", label = "Ports", kind = "number" } },
    rows = { { id = "a", cells = { name = "esx-02", ports = 3 }, host = "esx-02" } },
    sort = "ports", desc = true,
    empty = "Nothing yet.",
    open = function(e) return "opened " .. e.row end,
    actions = { { label = "Keep", key = "k", run = function(e) kept[#kept + 1] = e.row; return e.view .. ":" .. e.row end } },
  },
})
roster.views.update("scan", { rows = { { id = "b", cells = { name = "10.0.0.7", ports = 1 }, tone = "muted" } }, remove = { "a" } })
roster.commands.add("scan", { run = function() roster.views.open("scan") end })
roster.commands.add("done", { run = function() roster.views.close("scan") end })
roster.commands.add("at", { run = function(a) roster.views.open("scan", { select = a.args }) end })
roster.commands.add("bad", { run = function() roster.views.open("scan", { select = 7 }) end })
roster.commands.add("bad2", { run = function() roster.views.open("scan", "b") end })
local opened = pcall(roster.views.open, "scan")
roster.status.set("load", { text = tostring(opened) })
roster.on("lock", function() roster.views.open("scan") end)
"#;

#[test]
fn a_view_is_data_with_a_table_whose_actions_get_the_row() {
    let host = host();
    let folder = plugin_dir("view", VIEW);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let view = &reply.ops[0];
    assert_eq!(view["op"], "view");
    assert_eq!(view["id"], "scan");
    assert_eq!(view["spec"]["place"], "full");
    assert_eq!(view["spec"]["table"]["rows"][0]["cells"]["ports"], 3);
    let update = &reply.ops[1];
    assert_eq!(
        *update,
        json!({ "op": "view_update", "id": "scan", "changes": {
            "rows": [{ "id": "b", "cells": { "name": "10.0.0.7", "ports": 1 }, "tone": "muted" }],
            "remove": ["a"] } })
    );
    let keep = handler(&view["spec"]["table"]["actions"][0]["run"]);
    let r = host.call("scan", keep, json!({ "view": "scan", "row": "b" }));
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(r.result, "scan:b");
    let open = handler(&view["spec"]["table"]["open"]);
    assert_eq!(
        host.call("scan", open, json!({ "view": "scan", "row": "b" })).result,
        "opened b"
    );
}

#[test]
fn only_the_user_opens_a_view_but_the_plugin_may_close_it() {
    let host = host();
    let folder = plugin_dir("open", VIEW);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    let load = reply.ops.iter().find(|o| o["op"] == "status").unwrap();
    assert_eq!(load["spec"]["text"], "false", "opening at load is an error");
    let replies = host.event(Event {
        name: "lock".into(),
        payload: json!({}),
    });
    let message = &replies[0].error.as_ref().unwrap().message;
    assert!(message.contains("only while the user runs"), "{message}");
    let command = |name: &str| {
        let op = reply
            .ops
            .iter()
            .find(|o| o["op"] == "command" && o["name"] == name)
            .unwrap();
        handler(&op["run"])
    };
    let r = host.call("scan", command("scan"), json!({ "args": "", "words": [] }));
    assert_eq!(r.ops, [json!({ "op": "view_open", "id": "scan" })]);
    let r = host.call("scan", command("done"), json!({ "args": "", "words": [] }));
    assert_eq!(r.ops, [json!({ "op": "view_close", "id": "scan" })]);
    // At a row or node (T99, api 4).
    let r = host.call("scan", command("at"), json!({ "args": "b", "words": ["b"] }));
    assert_eq!(r.ops, [json!({ "op": "view_open", "id": "scan", "select": "b" })]);
    let r = host.call("scan", command("bad"), json!({ "args": "", "words": [] }));
    let message = &r.error.as_ref().unwrap().message;
    assert!(
        message.contains("roster.views.open: select is the id of a node or row"),
        "{message}"
    );
    let r = host.call("scan", command("bad2"), json!({ "args": "", "words": [] }));
    let message = &r.error.as_ref().unwrap().message;
    assert!(
        message.contains("roster.views.open: opts is a table, as { select = ID }"),
        "{message}"
    );
}

#[test]
fn an_update_is_plain_data_and_a_bad_id_is_an_error() {
    let host = host();
    let init = r#"
    local roster = require("roster")
    local ok, err = pcall(roster.views.update, "scan", { rows = { { id = "a", cells = { name = function() end } } } })
    local ok2, err2 = pcall(roster.views.set, "Scan View", { title = "x" })
    roster.status.set("e", { text = tostring(err) .. " | " .. tostring(err2) })
    roster.views.remove("scan")
    "#;
    let folder = plugin_dir("plain", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let text = reply.ops[0]["spec"]["text"].as_str().unwrap();
    assert!(text.contains("roster.views.update"), "{text}");
    assert!(text.contains("functions go in roster.views.set"), "{text}");
    assert!(text.contains("isn't a name like"), "{text}");
    assert_eq!(reply.ops[1], json!({ "op": "remove", "kind": "view", "id": "scan" }));
}

#[test]
fn a_details_section_is_set_per_host_and_its_actions_get_the_host() {
    let host = host();
    let init = r#"
    local roster = require("roster")
    for _, name in ipairs({ "esx-02", "pve-1" }) do
      roster.details.set("mesh", name, {
        title = "Mesh",
        order = 10,
        facts = { { label = "reach", value = "can reach 7 Hosts" } },
        table = { columns = { { id = "peer", label = "Peer" } }, rows = { { id = "p", cells = { peer = "web-1" } } },
                  actions = { { label = "Cut", key = "x", run = function(e) return e.host .. "/" .. e.section .. "/" .. e.row end } } },
      })
    end
    roster.details.set("mesh", "pve-1", nil)
    roster.details.remove("mesh")
    "#;
    let folder = plugin_dir("details", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(reply.ops[0]["op"], "details");
    assert_eq!(reply.ops[0]["host"], "esx-02");
    assert_eq!(reply.ops[0]["spec"]["facts"][0]["value"], "can reach 7 Hosts");
    assert_eq!(
        reply.ops[2],
        json!({ "op": "details", "id": "mesh", "host": "pve-1", "spec": null })
    );
    assert_eq!(reply.ops[3], json!({ "op": "remove", "kind": "details", "id": "mesh" }));
    // Removed: its functions are gone with it.
    let cut = handler(&reply.ops[0]["spec"]["table"]["actions"][0]["run"]);
    let r = host.call("scan", cut, json!({ "host": "esx-02", "section": "mesh", "row": "p" }));
    assert!(r.error.unwrap().message.contains("gone"));
}

#[test]
fn a_details_section_keeps_its_actions_until_it_is_set_again_for_that_host() {
    let host = host();
    let init = r#"
    local roster = require("roster")
    local function set(name)
      roster.details.set("mesh", name, { table = { columns = { { id = "p", label = "P" } },
        actions = { { label = "Cut", key = "x", run = function(e) return e.host end } } } })
    end
    set("esx-02")
    set("pve-1")
    "#;
    let folder = plugin_dir("details-keep", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    let first = handler(&reply.ops[0]["spec"]["table"]["actions"][0]["run"]);
    let r = host.call(
        "scan",
        first,
        json!({ "host": "esx-02", "section": "mesh", "row": "p" }),
    );
    assert!(
        r.error.is_none(),
        "setting pve-1's section kept esx-02's: {:?}",
        r.error
    );
    assert_eq!(r.result, "esx-02");
}

/// Ticket 91: a view's heading buttons are functions like a table's actions, and a notice's
/// buttons are command lines only, so a notice holds no function.
#[test]
fn heading_actions_are_functions_and_a_notices_actions_are_command_lines() {
    let host = host();
    let init = r#"
    local roster = require("roster")
    roster.views.set("plan", {
      title = "Plan",
      actions = { { label = "Apply", icon = "apply", run = function(e) return "apply " .. e.view end } },
    })
    roster.notify("Plan ready", "info", { actions = { { label = "Show the plan", run = "view plan" } } })
    roster.notify("plain")
    local ok, err = pcall(roster.notify, "x", "info", { actions = { { label = "Go", run = function() end } } })
    roster.status.set("e", { text = tostring(err) })
    "#;
    let folder = plugin_dir("head", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let view = &reply.ops[0];
    let apply = handler(&view["spec"]["actions"][0]["run"]);
    assert_eq!(host.call("scan", apply, json!({ "view": "plan" })).result, "apply plan");
    assert_eq!(
        reply.ops[1],
        json!({ "op": "notify", "text": "Plan ready", "level": "info",
                "actions": [{ "label": "Show the plan", "run": "view plan" }] })
    );
    assert_eq!(
        reply.ops[2],
        json!({ "op": "notify", "text": "plain", "level": "info" })
    );
    let text = reply.ops[3]["spec"]["text"].as_str().unwrap();
    assert!(text.contains("a command line, not a function"), "{text}");
}
