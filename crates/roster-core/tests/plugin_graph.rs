//! A view's graph (ticket 77, decision Q99): `roster.views.set` hands the app nodes, edges and
//! clusters as plain data, and the graph's `open` and actions as functions that get the node.
//! `roster.views.update` changes nodes and edges in place as plain data only, and setting the view
//! again drops the old graph's functions.

mod common;

use roster_core::plugin::{Limits, PluginHost, Serve, Source};
use serde_json::{Value, json};
use std::sync::Arc;

struct NoServe;

impl Serve for NoServe {
    fn call(&self, method: &str, _params: Value) -> Result<Value, String> {
        Err(format!("unknown method {method}"))
    }
}

fn plugin_dir(test: &str, init: &str) -> common::Temp {
    let dir = common::temp(&format!("plugin-graph-{test}"));
    std::fs::write(
        dir.join("roster-plugin.lua"),
        "return { name = \"map\", version = \"1.0.0\", description = \"A test\", api = 2, permissions = {} }",
    )
    .unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    dir
}

fn handler(v: &Value) -> u64 {
    v["handler"].as_u64().unwrap_or_else(|| panic!("no handler in {v}"))
}

const MAP: &str = r#"
local roster = require("roster")
local function set()
  roster.views.set("map", {
    title = "Map",
    place = "full",
    graph = {
      clusters = { { id = "lab", title = "lab", mesh = true } },
      nodes = {
        { id = "box", label = "devbox", shape = "square" },
        { id = "esx-02", cluster = "lab", host = "esx-02", state = "live" },
      },
      edges = { { from = "box", to = "lab" } },
      open = function(e) return "opened " .. e.node .. " on " .. e.host end,
      actions = { { label = "Check", key = "c", run = function(e) return e.view .. ":" .. e.node end } },
    },
  })
end
set()
roster.views.update("map", { nodes = { { id = "esx-02", cluster = "lab", state = "down" } }, remove_edges = { "box>lab" } })
local ok, err = pcall(roster.views.update, "map", { nodes = { { id = "x", run = function() end } } })
roster.status.set("update", { text = tostring(ok) .. " " .. tostring(err) })
roster.commands.add("again", { run = set })
"#;

#[test]
fn a_graph_is_data_and_its_actions_get_the_node() {
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    let folder = plugin_dir("graph", MAP);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let view = &reply.ops[0];
    assert_eq!(view["op"], "view");
    let graph = &view["spec"]["graph"];
    assert_eq!(graph["nodes"][1]["state"], "live");
    assert_eq!(graph["clusters"][0]["mesh"], true);
    assert_eq!(
        reply.ops[1],
        json!({ "op": "view_update", "id": "map", "changes": {
            "nodes": [{ "id": "esx-02", "cluster": "lab", "state": "down" }],
            "remove_edges": ["box>lab"] } })
    );
    let status = reply.ops.iter().find(|o| o["op"] == "status").unwrap();
    let said = status["spec"]["text"].as_str().unwrap();
    assert!(
        said.starts_with("false") && said.contains("functions go in roster.views.set"),
        "{said}"
    );

    let open = handler(&graph["open"]);
    let event = json!({ "view": "map", "node": "esx-02", "host": "esx-02" });
    assert_eq!(host.call("map", open, event.clone()).result, "opened esx-02 on esx-02");
    let check = handler(&graph["actions"][0]["run"]);
    assert_eq!(host.call("map", check, event.clone()).result, "map:esx-02");

    // Setting it again drops the old graph's functions.
    let again = reply
        .ops
        .iter()
        .find(|o| o["op"] == "command" && o["name"] == "again")
        .unwrap();
    let r = host.call("map", handler(&again["run"]), json!({ "args": "", "words": [] }));
    assert!(r.error.is_none(), "{:?}", r.error);
    let stale = host.call("map", check, event);
    assert!(stale.error.is_some(), "the old action still ran");
}
