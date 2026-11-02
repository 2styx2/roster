//! Plugin interactions (ticket 78, decision Q98): toolbar controls, confirmations the app draws,
//! progress, section and float actions, `roster.cmd(line)`, going to a Session, and the table's
//! per-row conditions and updates of its columns, sort and actions. What changes the screen or
//! runs a command line (a confirmation, `roster.cmd`, going to a Session) works only in a call the
//! user started, as `roster.clipboard.copy` does; `roster.cmd` reaches only what the Plugin's
//! permissions allow.

mod common;

use roster_core::plugin::{Event, Limits, Permission, PluginHost, Serve, Source};
use serde_json::{Value, json};
use std::sync::Arc;

struct NoServe;

impl Serve for NoServe {
    fn call(&self, method: &str, _params: Value) -> Result<Value, String> {
        Err(format!("unknown method {method}"))
    }
}

fn plugin_dir(test: &str, permissions: &str, init: &str) -> common::Temp {
    let dir = common::temp(&format!("plugin-interactions-{test}"));
    std::fs::write(
        dir.join("roster-plugin.lua"),
        format!(
            "return {{ name = \"mesh\", version = \"1.0.0\", description = \"A test\", api = 2, permissions = {{ {permissions} }} }}"
        ),
    )
    .unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    dir
}

/// A host the app has told its built-in commands, as it does before any Plugin loads: none here.
fn host() -> PluginHost {
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    host.set_builtins([]);
    host
}

fn handler(v: &Value) -> u64 {
    v["handler"].as_u64().unwrap_or_else(|| panic!("no handler in {v}"))
}

fn command(ops: &[Value], name: &str) -> u64 {
    let op = ops
        .iter()
        .find(|o| o["op"] == "command" && o["name"] == name)
        .unwrap_or_else(|| panic!("no command {name} in {ops:?}"));
    handler(&op["run"])
}

fn status_text(ops: &[Value], id: &str) -> String {
    ops.iter()
        .find(|o| o["op"] == "status" && o["id"] == id)
        .and_then(|o| o["spec"]["text"].as_str())
        .unwrap_or_else(|| panic!("no status {id} in {ops:?}"))
        .to_string()
}

const ARGS: fn() -> Value = || json!({ "args": "", "words": [] });

#[test]
fn a_confirmation_is_the_users_call_and_its_answer_runs_the_plugins_function() {
    let init = r#"
    local roster = require("roster")
    local cut = {}
    local function ask()
      roster.confirm({
        title = "Cut esx-02 from the Mesh?",
        text = "Its key is taken off 7 Hosts.",
        facts = { { label = "reach", value = "7 Hosts" } },
        action = "Cut",
        danger = true,
        typed = "esx-02",
        run = function() cut[#cut + 1] = "esx-02"; return "cut" end,
        cancel = function() return "kept" end,
      })
    end
    roster.commands.add("cut", { run = ask })
    local ok, err = pcall(ask)
    roster.status.set("load", { text = tostring(ok) .. " " .. tostring(err) })
    roster.on("lock", ask)
    "#;
    let host = host();
    let folder = plugin_dir("confirm", "", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let load = status_text(&reply.ops, "load");
    assert!(
        load.starts_with("false") && load.contains("roster.confirm: only while the user runs"),
        "{load}"
    );
    let replies = host.event(Event {
        name: "lock".into(),
        payload: json!({}),
    });
    assert!(
        replies[0]
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("only while the user runs")
    );

    let r = host.call("mesh", command(&reply.ops, "cut"), ARGS());
    assert!(r.error.is_none(), "{:?}", r.error);
    let op = &r.ops[0];
    assert_eq!(op["op"], "confirm");
    assert_eq!(op["spec"]["title"], "Cut esx-02 from the Mesh?");
    assert_eq!(op["spec"]["danger"], true);
    assert_eq!(op["spec"]["typed"], "esx-02");
    let yes = handler(&op["spec"]["run"]);
    let no = handler(&op["spec"]["cancel"]);
    assert_eq!(host.call("mesh", yes, json!({})).result, "cut");
    assert_eq!(host.call("mesh", no, json!({})).result, "kept");

    // Asking again replaces the question: the old answer's functions are gone.
    let r = host.call("mesh", command(&reply.ops, "cut"), ARGS());
    assert!(
        host.call("mesh", yes, json!({}))
            .error
            .unwrap()
            .message
            .contains("gone")
    );
    assert_eq!(
        host.call("mesh", handler(&r.ops[0]["spec"]["run"]), json!({})).result,
        "cut"
    );
}

#[test]
fn a_confirmation_needs_a_run_function() {
    let init = r#"
    local roster = require("roster")
    roster.commands.add("bad", { run = function() roster.confirm({ title = "Sure?", run = "publish" }) end })
    "#;
    let host = host();
    let folder = plugin_dir("confirm-bad", "", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    let r = host.call("mesh", command(&reply.ops, "bad"), ARGS());
    let message = r.error.unwrap().message;
    assert!(
        message.contains("roster.confirm: `run` must be a function"),
        "{message}"
    );
}

#[test]
fn progress_is_set_any_time_and_cancel_is_a_function() {
    let init = r#"
    local roster = require("roster")
    roster.progress.set("scan", { title = "Scanning 10.0.0.0/24", done = 40, total = 256, cancel = function() return "stopping" end })
    roster.progress.set("pull", { title = "Waiting for the mesh" })
    roster.progress.remove("pull")
    local ok, err = pcall(roster.progress.set, "Scan", { title = "x" })
    roster.status.set("e", { text = tostring(err) })
    "#;
    let host = host();
    let folder = plugin_dir("progress", "", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(reply.ops[0]["op"], "progress");
    assert_eq!(reply.ops[0]["id"], "scan");
    assert_eq!(reply.ops[0]["spec"]["done"], 40);
    assert_eq!(reply.ops[1]["spec"]["title"], "Waiting for the mesh");
    assert_eq!(
        reply.ops[2],
        json!({ "op": "remove", "kind": "progress", "id": "pull" })
    );
    assert!(status_text(&reply.ops, "e").contains("isn't a name like"));
    let cancel = handler(&reply.ops[0]["spec"]["cancel"]);
    assert_eq!(host.call("mesh", cancel, json!({})).result, "stopping");
}

#[test]
fn a_toolbar_control_runs_a_function_or_a_command_line() {
    let init = r#"
    local roster = require("roster")
    roster.toolbar.set("scan", { label = "Scan a network", text = "Scan", icon = "find", run = function() return "scanning" end })
    roster.toolbar.set("topology", { label = "Topology", run = "view topology" })
    roster.toolbar.remove("topology")
    "#;
    let host = host();
    let folder = plugin_dir("toolbar", "", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(reply.ops[0]["op"], "toolbar");
    assert_eq!(reply.ops[0]["spec"]["text"], "Scan");
    assert_eq!(reply.ops[1]["spec"]["run"], "view topology");
    assert_eq!(
        reply.ops[2],
        json!({ "op": "remove", "kind": "toolbar", "id": "topology" })
    );
    let run = handler(&reply.ops[0]["spec"]["run"]);
    assert_eq!(host.call("mesh", run, json!({})).result, "scanning");
}

#[test]
fn section_and_float_actions_are_functions() {
    let init = r#"
    local roster = require("roster")
    roster.sidebar.set("alerts", { title = "Alerts", rows = {},
      actions = { { label = "Dismiss all", icon = "close", run = function() return "dismissed" end } } })
    roster.float.open({ title = "esx-02", lines = { "ERROR disk full" },
      actions = { { label = "Go to the line", key = "g", run = function() return "went" end } },
      links = { { label = "Runbook", url = "https://wiki.example.com/disk-full" } } })
    "#;
    let host = host();
    let folder = plugin_dir("actions", "", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let dismiss = handler(&reply.ops[0]["spec"]["actions"][0]["run"]);
    assert_eq!(host.call("mesh", dismiss, json!({})).result, "dismissed");
    let float = &reply.ops[1]["spec"];
    assert_eq!(float["links"][0]["url"], "https://wiki.example.com/disk-full");
    assert_eq!(
        host.call("mesh", handler(&float["actions"][0]["run"]), json!({}))
            .result,
        "went"
    );
}

const CMD: &str = r#"
local roster = require("roster")
roster.commands.add("alerts", { run = function() end })
local function try(line)
  local ok, err = pcall(roster.cmd, line)
  return ok and "ok" or tostring(err)
end
roster.commands.add("try", { run = function(a)
  local out = {}
  for _, line in ipairs({ "finder alerts", "alerts clear", "view scan", "help plugins", "open esx-02",
      "connect esx-02", "plugins grant mesh terminal.write", "publish", "packages update", "", "   ",
      "source init.lua", "hosts", "Finder x", "session 2" }) do
    out[#out + 1] = line .. " => " .. try(line)
  end
  return table.concat(out, "\n")
end })
local ok, err = pcall(roster.cmd, "finder alerts")
roster.status.set("load", { text = tostring(err) })
"#;

#[test]
fn roster_cmd_runs_only_in_a_users_call_and_only_what_its_permissions_allow() {
    let host = host();
    let folder = plugin_dir("cmd", "", CMD);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert!(status_text(&reply.ops, "load").contains("roster.cmd: only while the user runs"));
    let r = host.call("mesh", command(&reply.ops, "try"), ARGS());
    assert!(r.error.is_none(), "{:?}", r.error);
    let out = r.result.as_str().unwrap();
    let line = |l: &str| {
        out.lines()
            .find(|x| x.starts_with(&format!("{l} => ")))
            .unwrap_or_else(|| panic!("{l} not in {out}"))
            .to_string()
    };
    assert!(line("finder alerts").ends_with("=> ok"), "{out}");
    assert!(line("alerts clear").ends_with("=> ok"), "its own command: {out}");
    assert!(line("view scan").ends_with("=> ok"), "{out}");
    assert!(line("help plugins").ends_with("=> ok"), "{out}");
    assert!(line("session 2").ends_with("=> ok"), "{out}");
    assert!(
        line("open esx-02").contains("needs the sessions.open permission"),
        "{out}"
    );
    assert!(
        line("connect esx-02").contains("needs the sessions.open permission"),
        "{out}"
    );
    for refused in [
        "plugins grant mesh terminal.write",
        "publish",
        "packages update",
        "source init.lua",
        "hosts",
        "Finder x",
    ] {
        assert!(line(refused).contains("isn't one a Plugin may run"), "{refused}: {out}");
    }
    assert!(line("").contains("which command?"), "{out}");
    // The ops are the lines that passed, in order.
    let lines: Vec<&str> = r
        .ops
        .iter()
        .filter(|o| o["op"] == "cmd")
        .map(|o| o["line"].as_str().unwrap())
        .collect();
    assert_eq!(
        lines,
        [
            "finder alerts",
            "alerts clear",
            "view scan",
            "help plugins",
            "session 2"
        ]
    );
}

#[test]
fn roster_cmd_with_sessions_open_may_open_a_host() {
    let host = host();
    let folder = plugin_dir("cmd-open", "\"sessions.open\"", CMD);
    let (_, reply) = host
        .load(&Source::Dir(folder.to_path_buf()), &[Permission::SessionsOpen])
        .unwrap();
    let r = host.call("mesh", command(&reply.ops, "try"), ARGS());
    let out = r.result.as_str().unwrap();
    assert!(out.contains("open esx-02 => ok"), "{out}");
    assert!(out.contains("connect esx-02 => ok"), "{out}");
}

/// A Plugin that names its commands after roster's own can't run them with `roster.cmd`: the app
/// tells the core its built-in commands (`PluginHost::set_builtins`), and a word is the Plugin's
/// own only if no built-in has it (issue #184). Until the app has said, none of its commands runs
/// (the ones that change trust or writes, api.rs's ROSTER_ONLY, are refused as ever), and a list
/// reaches a Plugin already running.
#[test]
fn a_plugins_command_named_after_one_of_rosters_isnt_its_own() {
    let init = r#"
    local roster = require("roster")
    for _, name in ipairs({ "theme", "tutor", "publish", "alerts" }) do
      roster.commands.add(name, { run = function() end })
    end
    roster.commands.add("go", { run = function(a)
      local ok, err = pcall(roster.cmd, a.args)
      return ok and "ok" or tostring(err)
    end })
    "#;
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    let folder = plugin_dir("cmd-roster-only", "", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let go = |name: &str| {
        let r = host.call(
            "mesh",
            command(&reply.ops, "go"),
            json!({ "args": name, "words": [name] }),
        );
        r.result.as_str().unwrap_or_default().to_string()
    };
    // Before the app has said: the floor refused as ever, and none of its own runs yet.
    assert!(
        go("publish").contains("isn't one a Plugin may run"),
        "{}",
        go("publish")
    );
    for name in ["theme", "alerts"] {
        assert!(
            go(name).contains("can't run yet: the app hasn't told roster its own commands"),
            "{name}: {}",
            go(name)
        );
    }
    host.set_builtins(["theme", "tutor", "publish", "lock"].map(String::from));
    for name in ["theme", "tutor", "publish"] {
        assert!(go(name).contains("isn't one a Plugin may run"), "{name}: {}", go(name));
    }
    assert_eq!(go("alerts"), "ok", "its own command, which no built-in has");
}

#[test]
fn a_removed_command_is_no_longer_the_plugins_own() {
    let init = r#"
    local roster = require("roster")
    roster.commands.add("alerts", { run = function() end })
    roster.commands.remove("alerts")
    roster.commands.add("go", { run = function() roster.cmd("alerts") end })
    "#;
    let host = host();
    let folder = plugin_dir("cmd-removed", "", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    let r = host.call("mesh", command(&reply.ops, "go"), ARGS());
    assert!(r.error.unwrap().message.contains("isn't one a Plugin may run"));
}

#[test]
fn going_to_a_session_and_a_line_is_the_users_call() {
    let init = r#"
    local roster = require("roster")
    roster.commands.add("go", { run = function() roster.sessions.show(3, "ERROR disk full") end })
    roster.commands.add("bare", { run = function() roster.sessions.show(3) end })
    local ok, err = pcall(roster.sessions.show, 3)
    roster.status.set("load", { text = tostring(err) .. " " .. tostring(roster.sessions.open) })
    "#;
    let host = host();
    let folder = plugin_dir("show", "", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let load = status_text(&reply.ops, "load");
    assert!(
        load.contains("roster.sessions.show: only while the user runs"),
        "{load}"
    );
    assert!(load.ends_with(" nil"), "open still needs sessions.open: {load}");
    let r = host.call("mesh", command(&reply.ops, "go"), ARGS());
    assert_eq!(
        r.ops,
        [json!({ "op": "session_show", "session": 3, "line": "ERROR disk full" })]
    );
    let r = host.call("mesh", command(&reply.ops, "bare"), ARGS());
    assert_eq!(r.ops, [json!({ "op": "session_show", "session": 3, "line": null })]);
}

#[test]
fn a_view_update_may_change_columns_sort_and_actions() {
    let init = r#"
    local roster = require("roster")
    roster.views.set("mesh", { table = {
      columns = { { id = "host", label = "Host" } },
      open = function(e) return "open " .. e.row end,
      actions = { { label = "Cut", key = "x", when = { state = "up" }, run = function(e) return "cut " .. e.row end } },
    } })
    roster.views.update("mesh", {
      columns = { { id = "host", label = "Host" }, { id = "state", label = "State" } },
      sort = "state", desc = true,
      actions = { { label = "Check", key = "c", run = function(e) return "check " .. e.row end } },
    })
    local ok, err = pcall(roster.views.update, "mesh", { rows = { { id = "a", cells = { host = function() end } } } })
    roster.status.set("e", { text = tostring(err) })
    "#;
    let host = host();
    let folder = plugin_dir("update", "", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let set = &reply.ops[0]["spec"]["table"];
    assert_eq!(set["actions"][0]["when"], json!({ "state": "up" }));
    let update = &reply.ops[1]["changes"];
    assert_eq!(update["sort"], "state");
    assert_eq!(update["columns"][1]["id"], "state");
    let check = handler(&update["actions"][0]["run"]);
    assert_eq!(host.call("mesh", check, json!({ "row": "a" })).result, "check a");
    // The table's `open` stays the set's.
    assert_eq!(
        host.call("mesh", handler(&set["open"]), json!({ "row": "a" })).result,
        "open a"
    );
    // The set's actions were replaced, so their functions are gone at once (ticket 85), not
    // only when the view is set again or removed.
    let cut = handler(&set["actions"][0]["run"]);
    let r = host.call("mesh", cut, json!({ "row": "a" }));
    assert!(r.error.is_some_and(|e| e.message.contains("gone")), "{:?}", r.result);
    // A function anywhere else is still an error.
    assert!(status_text(&reply.ops, "e").contains("functions go in roster.views.set"));
}

#[test]
fn a_new_update_or_removing_the_view_drops_the_actions_an_update_gave() {
    let init = r#"
    local roster = require("roster")
    roster.views.set("mesh", { table = { columns = { { id = "h", label = "H" } } } })
    roster.views.update("mesh", { actions = { { label = "Check", key = "c", run = function() return "check" end } } })
    roster.commands.add("again", { run = function()
      roster.views.update("mesh", { actions = { { label = "Ping", key = "p", run = function() return "ping" end } } })
    end })
    roster.commands.add("remove", { run = function() roster.views.remove("mesh") end })
    "#;
    let host = host();
    let folder = plugin_dir("update-drop", "", init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &[]).unwrap();
    let check = handler(&reply.ops[1]["changes"]["actions"][0]["run"]);
    assert_eq!(host.call("mesh", check, json!({})).result, "check");
    // A second update's actions replace the first's.
    let r = host.call("mesh", command(&reply.ops, "again"), ARGS());
    let ping = handler(&r.ops[0]["changes"]["actions"][0]["run"]);
    assert!(
        host.call("mesh", check, json!({}))
            .error
            .unwrap()
            .message
            .contains("gone")
    );
    host.call("mesh", command(&reply.ops, "remove"), ARGS());
    assert!(
        host.call("mesh", ping, json!({}))
            .error
            .unwrap()
            .message
            .contains("gone")
    );
}
