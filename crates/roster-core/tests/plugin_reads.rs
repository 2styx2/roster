//! What a Plugin can read without waiting for events (ticket 96, #169, decision Q127): the
//! Sessions open before it loaded (`roster.sessions.list`), the Inventory read once however many
//! of `roster.inventory`'s reads one call makes, and the Inventory asked for without waiting
//! (`roster.inventory.request`). Driven through `PluginHost`, as the Tauri shell does.

mod common;

use roster_core::plugin::{Event, Limits, Permission, PluginHost, Reply, Serve, Source};
use serde_json::{Value, json};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A stand-in `roster serve` that counts what it's asked.
#[derive(Default)]
struct CountingServe {
    calls: Mutex<Vec<String>>,
}

impl Serve for CountingServe {
    fn call(&self, method: &str, _params: Value) -> Result<Value, String> {
        self.calls.lock().unwrap().push(method.to_string());
        match method {
            "hosts.list" => Ok(json!({
                "hosts": [
                    { "name": "esx-02", "ip": "10.0.0.5", "group": "lab", "ssh": { "user": "root", "auth": "cmd:pass show esx-02" } },
                    { "name": "web-1", "ip": "10.0.0.7", "group": "lab" }
                ],
                "groups": { "lab": { "title": "The lab", "description": "" } }
            })),
            "host.update" => Ok(json!({ "host": "esx-02", "changed": true })),
            "mesh.cut" => Ok(json!({ "host": "esx-02", "confirmed": [], "pending": {} })),
            other => Err(format!("unknown method '{other}' (code -32601)")),
        }
    }
}

impl CountingServe {
    fn count(&self, method: &str) -> usize {
        self.calls.lock().unwrap().iter().filter(|m| *m == method).count()
    }
}

fn plugin_dir(test: &str, permissions: &[&str], init: &str) -> common::Temp {
    let dir = common::temp(&format!("plugin-reads-{test}"));
    let list: Vec<String> = permissions.iter().map(|p| format!("{p:?}")).collect();
    std::fs::write(
        dir.join("roster-plugin.lua"),
        format!(
            "return {{ name = \"reader\", version = \"1.0.0\", api = 4, permissions = {{ {} }} }}",
            list.join(", ")
        ),
    )
    .unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    dir
}

/// A host with a listener: the replies the Plugin sends on its own come out of the receiver.
fn host(serve: &Arc<CountingServe>) -> (PluginHost, Receiver<Reply>) {
    let host = PluginHost::new(Arc::clone(serve) as Arc<dyn Serve>, Limits::default());
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    host.set_listener(Arc::new(move |r: Reply| {
        let _ = tx.lock().unwrap().send(r);
    }));
    (host, rx)
}

fn load(host: &PluginHost, test: &str, permissions: &[&str], init: &str) -> (Reply, common::Temp) {
    let grants: Vec<Permission> = permissions.iter().map(|p| Permission::parse(p).unwrap()).collect();
    let folder = plugin_dir(test, permissions, init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &grants).unwrap();
    (reply, folder)
}

fn event(host: &PluginHost, name: &str, payload: Value) -> Vec<Reply> {
    host.event(Event {
        name: name.into(),
        payload,
    })
}

/// The text of the status segment `id` the ops set.
fn said(ops: &[Value], id: &str) -> String {
    ops.iter()
        .find(|o| o["op"] == "status" && o["id"] == id)
        .and_then(|o| o["spec"]["text"].as_str())
        .unwrap_or_else(|| panic!("no status {id} in {ops:?}"))
        .to_string()
}

fn ok(r: &Reply) {
    assert!(r.error.is_none(), "{:?}", r.error);
    assert!(r.disabled.is_none(), "{:?}", r.disabled);
}

/// The next reply the Plugin sends on its own (a request's answer), within 3 s.
fn next(rx: &Receiver<Reply>) -> Reply {
    let deadline = Instant::now() + Duration::from_secs(3);
    rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .expect("an answer within 3 s")
}

const LIST: &str = r#"
local roster = require("roster")
local parts = {}
for _, s in ipairs(roster.sessions.list()) do
  parts[#parts + 1] = s.session .. "=" .. (s.host or "quick")
end
roster.status.set("open", { text = table.concat(parts, " ") })
"#;

fn open(list: &[(u64, Option<&str>)]) -> Vec<(u64, Option<String>)> {
    list.iter().map(|(id, h)| (*id, h.map(str::to_string))).collect()
}

#[test]
fn a_plugin_loaded_later_lists_the_sessions_the_app_says_are_open_in_its_order() {
    let serve = Arc::new(CountingServe::default());
    let (host, _rx) = host(&serve);
    // The app's order (when it saw each open): session 1 reconnected after 3 opened, so it's last.
    host.set_sessions(open(&[(3, None), (1, Some("esx-02"))]));
    let (reply, _dir) = load(&host, "later", &["inventory.read"], LIST);
    ok(&reply);
    assert_eq!(said(&reply.ops, "open"), "3=quick 1=esx-02");
}

#[test]
fn each_list_from_the_app_replaces_the_last_whole() {
    let serve = Arc::new(CountingServe::default());
    let (host, _rx) = host(&serve);
    host.set_sessions(open(&[(1, Some("esx-02")), (2, Some("web-1"))]));
    // The webview reloaded: its tab ids start again, and the old ones are gone.
    host.set_sessions(open(&[(1, Some("nas-01"))]));
    let (reply, _dir) = load(&host, "replace", &["inventory.read"], LIST);
    ok(&reply);
    assert_eq!(said(&reply.ops, "open"), "1=nas-01");
}

#[test]
fn the_events_alone_change_nothing_in_the_list() {
    let serve = Arc::new(CountingServe::default());
    let (host, _rx) = host(&serve);
    let init = r#"
local roster = require("roster")
roster.on("session_open", function() roster.status.set("n", { text = "open " .. #roster.sessions.list() }) end)
"#;
    let (reply, _dir) = load(&host, "listener", &["terminal.read"], init);
    ok(&reply);
    // The app sends the list first, then the event (manager.ts), so a listener's list agrees.
    host.set_sessions(open(&[(4, Some("esx-02"))]));
    let opened = event(&host, "session_open", json!({ "session": 4, "host": "esx-02" }));
    assert_eq!(said(&opened[0].ops, "n"), "open 1");
    let opened = event(&host, "session_open", json!({ "session": 5, "host": "web-1" }));
    assert_eq!(said(&opened[0].ops, "n"), "open 1", "only the app's list counts");
}

#[test]
fn without_inventory_read_or_terminal_read_there_is_no_sessions_list() {
    let serve = Arc::new(CountingServe::default());
    let (host, _rx) = host(&serve);
    let init = r#"
local roster = require("roster")
roster.status.set("has", { text = tostring(roster.sessions.list ~= nil) })
"#;
    let (reply, _dir) = load(&host, "none", &["sessions.open"], init);
    ok(&reply);
    assert_eq!(said(&reply.ops, "has"), "false");
}

#[test]
fn hosts_and_groups_in_one_call_read_the_inventory_once() {
    let serve = Arc::new(CountingServe::default());
    let (host, _rx) = host(&serve);
    let init = r#"
local roster = require("roster")
local hosts, groups = roster.inventory.hosts(), roster.inventory.groups()
roster.status.set("inv", { text = #hosts .. " in " .. groups.lab.title })
"#;
    let (reply, _dir) = load(&host, "once", &["inventory.read"], init);
    ok(&reply);
    assert_eq!(said(&reply.ops, "inv"), "2 in The lab");
    assert_eq!(serve.count("hosts.list"), 1, "groups() used hosts()'s answer");
}

#[test]
fn each_call_and_each_write_reads_the_inventory_afresh() {
    let serve = Arc::new(CountingServe::default());
    let (host, _rx) = host(&serve);
    let init = r#"
local roster = require("roster")
roster.commands.add("note", { run = function()
  roster.inventory.hosts()
  roster.inventory.update("esx-02", { note = "rack 4" })
  roster.inventory.groups()
end })
roster.on("inventory_changed", function() roster.inventory.hosts() end)
"#;
    let (reply, _dir) = load(&host, "afresh", &["inventory.read", "inventory.write"], init);
    ok(&reply);
    let run = reply
        .ops
        .iter()
        .find(|o| o["op"] == "command" && o["name"] == "note")
        .and_then(|o| o["run"]["handler"].as_u64())
        .unwrap();
    ok(&host.call("reader", run, json!({ "words": [] })));
    assert_eq!(
        serve.count("hosts.list"),
        2,
        "the write's change is read, not the answer before it"
    );
    event(&host, "inventory_changed", json!({}));
    assert_eq!(serve.count("hosts.list"), 3, "a new call asks again");
}

#[test]
fn inventory_request_returns_at_once_and_done_gets_the_hosts_and_groups() {
    let serve = Arc::new(CountingServe::default());
    let (host, rx) = host(&serve);
    let init = r#"
local roster = require("roster")
roster.status.set("asked", { text = "asking" })
roster.inventory.request(function(list, err)
  if not list then return roster.status.set("got", { text = err }) end
  roster.status.set("got", { text = #list.hosts .. " Hosts, " .. list.groups.lab.title .. ", " .. list.hosts[1].ssh.auth })
end)
"#;
    let (reply, _dir) = load(&host, "request", &["inventory.read"], init);
    ok(&reply);
    assert_eq!(said(&reply.ops, "asked"), "asking");
    let answer = next(&rx);
    ok(&answer);
    assert_eq!(
        said(&answer.ops, "got"),
        "2 Hosts, The lab, cmd:",
        "cut as every read is"
    );
    assert_eq!(serve.count("hosts.list"), 1);
}

#[test]
fn an_inventory_request_that_fails_says_why_in_done() {
    struct Down;
    impl Serve for Down {
        fn call(&self, _method: &str, _params: Value) -> Result<Value, String> {
            Err("roster.yml is busy: changes.publish is still running (code 4)".into())
        }
    }
    let host = PluginHost::new(Arc::new(Down), Limits::default());
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    host.set_listener(Arc::new(move |r: Reply| {
        let _ = tx.lock().unwrap().send(r);
    }));
    let init = r#"
local roster = require("roster")
roster.inventory.request(function(list, err) roster.status.set("got", { text = tostring(list) .. " " .. err }) end)
"#;
    let (reply, _dir) = load(&host, "fails", &["inventory.read"], init);
    ok(&reply);
    let answer = next(&rx);
    assert_eq!(
        said(&answer.ops, "got"),
        "nil roster.inventory.request: roster.yml is busy: changes.publish is still running (code 4)"
    );
}

#[test]
fn any_call_into_serve_that_can_change_things_reads_the_inventory_afresh() {
    let serve = Arc::new(CountingServe::default());
    let (host, _rx) = host(&serve);
    let init = r#"
local roster = require("roster")
roster.commands.add("cut", { run = function()
  roster.inventory.hosts()
  roster.serve.call("mesh.cut", { host = "esx-02" }) -- writes mesh: false into roster.yml
  roster.inventory.groups()
end })
"#;
    let (reply, _dir) = load(&host, "cut", &["inventory.read", "serve:mesh.cut"], init);
    ok(&reply);
    let run = reply
        .ops
        .iter()
        .find(|o| o["op"] == "command" && o["name"] == "cut")
        .and_then(|o| o["run"]["handler"].as_u64())
        .unwrap();
    ok(&host.call("reader", run, json!({ "words": [] })));
    assert_eq!(
        serve.count("hosts.list"),
        2,
        "mesh.cut's change is read, not the answer before it"
    );
}
