//! The Plugin runtime's pieces from ticket 79 (#137, decision Q96): timers (`roster.defer`,
//! `roster.every`, `roster.cancel`), `roster.has`, a `pairs` that visits keys in order (so the
//! same state makes the same ops), and a finder whose items come from a function. Driven through
//! `PluginHost`, as the Tauri shell does.

mod common;

use roster_core::plugin::{Limits, Permission, PluginHost, Reply, Serve, Source};
use serde_json::{Value, json};
use std::sync::Arc;

struct NoServe;

impl Serve for NoServe {
    fn call(&self, _method: &str, _params: Value) -> Result<Value, String> {
        Ok(json!({}))
    }
}

fn plugin_dir(test: &str, permissions: &[&str], init: &str) -> common::Temp {
    let dir = common::temp(&format!("plugin-runtime-{test}"));
    let list: Vec<String> = permissions.iter().map(|p| format!("{p:?}")).collect();
    std::fs::write(
        dir.join("roster-plugin.lua"),
        format!(
            "return {{ name = \"t\", version = \"1.0.0\", api = 2, permissions = {{ {} }} }}",
            list.join(", ")
        ),
    )
    .unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    dir
}

fn load(test: &str, permissions: &[&str], init: &str) -> (PluginHost, Reply, common::Temp) {
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    let grants: Vec<Permission> = permissions.iter().map(|p| Permission::parse(p).unwrap()).collect();
    let folder = plugin_dir(test, permissions, init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &grants).unwrap();
    (host, reply, folder)
}

fn ops_of<'a>(reply: &'a Reply, op: &str) -> Vec<&'a Value> {
    reply.ops.iter().filter(|o| o["op"] == op).collect()
}

fn notices(reply: &Reply) -> Vec<String> {
    ops_of(reply, "notify")
        .iter()
        .map(|o| o["text"].as_str().unwrap().to_string())
        .collect()
}

fn timer_id(op: &Value) -> u64 {
    op["id"].as_str().unwrap().parse().unwrap()
}

// ------------------------------------------------------------------------------------ timers

#[test]
fn defer_hands_the_app_a_timer_that_runs_the_function_once_in_the_plugin() {
    let (host, reply, _folder) = load(
        "defer",
        &[],
        r#"
        local n = 0
        local id = roster.defer(1500, function() n = n + 1 roster.notify("ran " .. n) end)
        roster.notify("timer " .. type(id))
        "#,
    );
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(notices(&reply), ["timer number"]);
    let timers = ops_of(&reply, "timer");
    assert_eq!(timers.len(), 1);
    assert_eq!(timers[0]["ms"], 1500);
    assert_eq!(timers[0]["every"], false);
    let id = timer_id(timers[0]);
    assert_eq!(timers[0]["run"]["handler"], id);

    let fired = host.call("t", id, json!({}));
    assert!(fired.error.is_none(), "{:?}", fired.error);
    assert_eq!(notices(&fired), ["ran 1"]);
    // Once: it's gone after it ran, and running it again isn't the Plugin's fault.
    let again = host.call("t", id, json!({}));
    assert!(again.error.unwrap().message.contains("gone"));
    assert!(host.list()[0].disabled.is_none());
}

#[test]
fn every_repeats_until_cancelled_and_cancel_tells_the_app() {
    let (host, reply, _folder) = load(
        "every",
        &[],
        r#"
        local n = 0
        local id
        id = roster.every(60000, function()
          n = n + 1
          roster.notify("tick " .. n)
          if n == 2 then roster.cancel(id) end
        end)
        "#,
    );
    let timers = ops_of(&reply, "timer");
    assert_eq!(timers[0]["every"], true);
    assert_eq!(timers[0]["ms"], 60000);
    let id = timer_id(timers[0]);
    assert_eq!(notices(&host.call("t", id, json!({}))), ["tick 1"]);
    let second = host.call("t", id, json!({}));
    assert_eq!(notices(&second), ["tick 2"]);
    let removed = ops_of(&second, "remove");
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0]["kind"], "timer");
    assert_eq!(removed[0]["id"], id.to_string());
    assert!(host.call("t", id, json!({})).error.is_some());
}

#[test]
fn a_timer_isnt_a_call_the_user_started() {
    let (host, reply, _folder) = load(
        "timer-clipboard",
        &[],
        r#"roster.defer(100, function() roster.clipboard.copy("swapped") end)"#,
    );
    let id = timer_id(ops_of(&reply, "timer")[0]);
    let fired = host.call("t", id, json!({}));
    assert!(fired.error.unwrap().message.contains("only while the user runs"));
}

#[test]
fn timers_have_floors_and_a_ceiling_so_they_cant_starve_the_plugin() {
    // A deferred function waits at least 50 ms; a repeating one at least a second, said as an
    // error since it would run far less often than asked.
    let (_, reply, _folder) = load("floor", &[], r#"roster.defer(0, function() end)"#);
    assert_eq!(ops_of(&reply, "timer")[0]["ms"], 50);
    for (code, says) in [
        ("roster.every(10, function() end)", "roster.every: at least 1000 ms"),
        ("roster.defer(-1, function() end)", "roster.defer: ms must be"),
        ("roster.defer(1 / 0, function() end)", "roster.defer: ms must be"),
        (
            "for i = 1, 101 do roster.defer(1000, function() end) end",
            "more than 100 timers",
        ),
        ("roster.cancel(\"x\")", "roster.cancel"),
    ] {
        let (_, reply, _folder) = load("ceiling", &[], code);
        let e = reply.error.unwrap_or_else(|| panic!("{code}: no error"));
        assert!(e.message.contains(says), "{code}: {}", e.message);
    }
    // Cancelling makes room again, and cancelling what's gone is nothing.
    let (_, reply, _folder) = load(
        "room",
        &[],
        r#"
        for i = 1, 100 do roster.cancel(roster.defer(1000, function() end)) end
        roster.defer(1000, function() end)
        roster.cancel(12345)
        "#,
    );
    assert!(reply.error.is_none(), "{:?}", reply.error);
}

#[test]
fn a_timer_that_fails_counts_toward_stopping_the_plugin() {
    let (host, reply, _folder) = load(
        "timer-error",
        &[],
        r#"roster.every(1000, function() error("tick failed") end)"#,
    );
    let id = timer_id(ops_of(&reply, "timer")[0]);
    for _ in 0..3 {
        let r = host.call("t", id, json!({}));
        assert!(r.error.unwrap().message.contains("tick failed"));
    }
    assert!(host.list()[0].disabled.is_some());
}

#[test]
fn reloading_drops_the_old_timers() {
    let (host, reply, _folder) = load("reload", &[], r#"roster.defer(1000, function() end)"#);
    let id = timer_id(ops_of(&reply, "timer")[0]);
    let grants: Vec<Permission> = Vec::new();
    let folder = plugin_dir("reload", &[], "");
    host.load(&Source::Dir(folder.to_path_buf()), &grants).unwrap();
    let r = host.call("t", id, json!({}));
    assert!(r.error.unwrap().message.contains("gone"));
    assert!(host.list()[0].errors == 0);
}

/// A handler id is unique to its load (ticket 85): a late timer or a queued click from before a
/// reload can't run a new, unrelated function that happens to have the same number.
#[test]
fn a_handler_id_from_before_a_reload_never_reaches_the_new_load() {
    let (host, reply, _folder) = load(
        "stale-id",
        &[],
        r#"roster.defer(1000, function() roster.notify("old") end)"#,
    );
    let id = timer_id(ops_of(&reply, "timer")[0]);
    let grants: Vec<Permission> = Vec::new();
    let dir = plugin_dir(
        "stale-id",
        &[],
        r#"roster.status.set("s", { text = "x", run = function() roster.notify("new") end })"#,
    );
    let (_, again) = host.load(&Source::Dir(dir.to_path_buf()), &grants).unwrap();
    let fresh = ops_of(&again, "status")[0]["spec"]["run"]["handler"].as_u64().unwrap();
    assert_ne!(fresh, id, "the new load handed over the old load's number");
    let r = host.call("t", id, json!({}));
    assert!(notices(&r).is_empty(), "{:?}", r.ops);
    assert!(r.error.unwrap().message.contains("gone"));
    let r = host.call("t", fresh, json!({}));
    assert_eq!(notices(&r), ["new"]);
}

// ------------------------------------------------------------------------------- roster.has

#[test]
fn has_says_whether_a_permission_was_granted() {
    let (_, reply, _folder) = load(
        "has",
        &["terminal.read", "serve:mesh.status"],
        r#"
        roster.notify(table.concat({
          tostring(roster.has("terminal.read")),
          tostring(roster.has("inventory.read")),
          tostring(roster.has("serve:mesh.status")),
          tostring(roster.has("serve:mesh.plan")),
        }, " "))
        "#,
    );
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(notices(&reply), ["true false true false"]);
    let (_, reply, _folder) = load("has-typo", &[], r#"roster.has("terminal.raed")"#);
    assert!(
        reply
            .error
            .unwrap()
            .message
            .contains("roster.has: \"terminal.raed\" isn't a permission")
    );
}

// ---------------------------------------------------------------------------- the ops' order

#[test]
fn pairs_visits_keys_in_order_so_the_same_state_makes_the_same_ops() {
    let init = r#"
        local hosts = {}
        for _, h in ipairs({ "web-9", "esx-02", "db-1", "app-3", "zz", "a", "lab-7", "m" }) do hosts[h] = #h end
        hosts[3], hosts[1], hosts[2] = "c", "a", "b"
        for host, n in pairs(hosts) do roster.badges.set(tostring(host), tostring(n)) end
        -- Removing what's been visited, during the walk, works as with Lua's own pairs.
        local t = { a = 1, b = 2, c = 3 }
        local seen = {}
        for k in pairs(t) do t[k] = nil seen[#seen + 1] = k end
        roster.notify(table.concat(seen, ","))
        -- A table's own __pairs still wins.
        local proxy = setmetatable({}, { __pairs = function() return function(_, k) if not k then return "only", 1 end end, nil, nil end })
        for k in pairs(proxy) do roster.notify(k) end
    "#;
    let (_, reply, _folder) = load("pairs", &[], init);
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let hosts: Vec<&str> = ops_of(&reply, "badge")
        .iter()
        .map(|o| o["host"].as_str().unwrap())
        .collect();
    assert_eq!(
        hosts,
        [
            "1", "2", "3", "a", "app-3", "db-1", "esx-02", "lab-7", "m", "web-9", "zz"
        ]
    );
    assert_eq!(notices(&reply), ["a,b,c", "only"]);
}

/// `pairs` skips the sort for a sequence and sorts keys of one kind with Lua's own comparison (the
/// iteration 8 review, for speed); every shape still comes out in the same order.
#[test]
fn pairs_keeps_its_order_for_every_shape_of_table() {
    let init = r#"
        local function walk(t)
          local out = {}
          for k, v in pairs(t) do out[#out + 1] = tostring(k) .. "=" .. tostring(v) end
          roster.notify(table.concat(out, " "))
        end
        walk({ "a", "b", "c" })
        local backwards = {}
        for i = 5, 1, -1 do backwards[i * 10] = i end
        walk(backwards)
        walk({ [2.5] = "x", [1] = "y", [-3] = "z", [2] = "w" })
        local holes = { "a", "b", "c" }
        holes[2] = nil
        holes[5] = "e"
        walk(holes)
        walk({ [true] = 1, [false] = 2, [3] = 3, x = 4 })
        walk({ "a", "b", n = 2 })
    "#;
    let (_, reply, _folder) = load("pairs-shapes", &[], init);
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(
        notices(&reply),
        [
            "1=a 2=b 3=c",
            "10=1 20=2 30=3 40=4 50=5",
            "-3=z 1=y 2=w 2.5=x",
            "1=a 3=c 5=e",
            "3=3 x=4 false=2 true=1",
            "1=a 2=b n=2",
        ]
    );
}

// --------------------------------------------------------------------------- lazy finders

#[test]
fn a_finders_items_can_come_from_a_function_run_when_it_opens() {
    let (host, reply, _folder) = load(
        "lazy",
        &[],
        r#"
        local n = 0
        roster.finders.set("lazy", { title = "Lazy", items = function()
          n = n + 1
          return { { label = "item " .. n, run = function() roster.notify("chose " .. n) end } }
        end })
        "#,
    );
    let finder = ops_of(&reply, "finder")[0];
    let items = finder["spec"]["items"]["handler"]
        .as_u64()
        .expect("items as a function");
    let first = host.call("t", items, json!({}));
    assert!(first.error.is_none(), "{:?}", first.error);
    assert_eq!(first.result[0]["label"], "item 1");
    let run = first.result[0]["run"]["handler"].as_u64().unwrap();
    assert_eq!(notices(&host.call("t", run, json!({}))), ["chose 1"]);
    let second = host.call("t", items, json!({}));
    assert_eq!(second.result[0]["label"], "item 2");
}
