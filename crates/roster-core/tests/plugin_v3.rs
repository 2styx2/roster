//! The Plugin API's version 3 (tickets 74 and 60): `inventory.host()` gives `nil` for an unknown
//! name, `inventory.groups()`, Login references that say how a secret is fetched kept from
//! Plugins, errors that name the function, `coroutine`, removals that check their ids, and
//! handlers that hear which thing ran them. Driven through `PluginHost`, as the Tauri shell does.

mod common;

use roster_core::plugin::{Limits, Permission, PluginHost, Serve, Source};
use serde_json::{Value, json};
use std::sync::Arc;

struct FakeServe;

impl Serve for FakeServe {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let esx = json!({
            "name": "esx-02", "ip": "10.0.0.5", "group": "lab",
            "ssh": { "user": "root", "port": 22, "auth": "cmd:pass show lab/esx-02 --hunter2" },
            "auth": "cmd:pass show lab/esx-02 --hunter2",
            "login": { "user": "admin", "auth": "env:ESX_PASSWORD" },
            "services": { "web": { "port": 443, "auth": "bw:esx-02 web" } }
        });
        match method {
            "hosts.list" => Ok(json!({
                "hosts": [esx],
                "groups": { "lab": { "title": "The lab", "description": "" } }
            })),
            "host.get" if params["name"] == "esx-02" => Ok(esx),
            "changes.diff" => Ok(json!({ "diff": DIFF, "count": 1 })),
            "host.check" => Ok(json!({ "host": "esx-02", "ok": false, "steps": [
                { "step": "provider", "status": "ok", "message": "cmd: is ready" },
                { "step": "vault-item", "status": "fail",
                  "message": "cmd:pass show lab/esx-02 --hunter2 failed: exit 1",
                  "details": { "auth": "env:ESX_PASSWORD", "tried": ["CMD:pass --hunter2", "bw:esx-02 web"] } }
            ] })),
            "host.get" => Err(format!(
                "unknown host '{}' (code 2)",
                params["name"].as_str().unwrap_or("")
            )),
            other => Err(format!("unknown method {other} (code -32601)")),
        }
    }
}

/// `roster.yml`'s Pending changes as git shows them: a `cmd:` and an `env:` reference, each
/// quoted and not, in a block and a flow mapping.
const DIFF: &str = "--- a/roster.yml\n+++ b/roster.yml\n@@ -3,2 +3,4 @@\n   esx-02:\n-    auth: \"cmd:pass show lab/esx-02 --hunter2\"\n+    auth: cmd:pass show lab/esx-03 --hunter3  # rotated\n+    login: { user: admin, auth: env:ESX_PASSWORD }\n+    ssh: { auth: 'env:SSH_PW' }\n";

fn plugin_dir(test: &str, permissions: &[&str], init: &str) -> common::Temp {
    let dir = common::temp(&format!("plugin-v3-{test}"));
    let list: Vec<String> = permissions.iter().map(|p| format!("{p:?}")).collect();
    let manifest = format!(
        "return {{ name = \"t\", version = \"1.0.0\", api = 3, permissions = {{ {} }} }}",
        list.join(", ")
    );
    std::fs::write(dir.join("roster-plugin.lua"), manifest).unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    dir
}

/// Loads `init` with `permissions` granted; gives the host and the load's ops.
fn load(test: &str, permissions: &[&str], init: &str) -> (PluginHost, Vec<Value>, Option<String>, common::Temp) {
    let host = PluginHost::new(Arc::new(FakeServe), Limits::default());
    let grants: Vec<Permission> = permissions.iter().map(|p| Permission::parse(p).unwrap()).collect();
    let folder = plugin_dir(test, permissions, init);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &grants).unwrap();
    (host, reply.ops, reply.error.map(|e| e.to_string()), folder)
}

/// The text of the status segment `id` the ops set.
fn said(ops: &[Value], id: &str) -> String {
    ops.iter()
        .find(|o| o["op"] == "status" && o["id"] == id)
        .and_then(|o| o["spec"]["text"].as_str())
        .unwrap_or_else(|| panic!("no status {id} in {ops:?}"))
        .to_string()
}

#[test]
fn the_api_version_is_4() {
    let (_, ops, error, _folder) = load(
        "version",
        &[],
        r#"roster.status.set("v", { text = tostring(roster.api_version) })"#,
    );
    assert_eq!(error, None);
    assert_eq!(said(&ops, "v"), "4");
}

#[test]
fn an_unknown_host_is_nil_and_a_known_one_a_table() {
    let (_, ops, error, _folder) = load(
        "host-nil",
        &["inventory.read"],
        r#"
        local none = roster.inventory.host("web-9")
        local one = roster.inventory.host("esx-02")
        roster.status.set("v", { text = tostring(none) .. " " .. one.ip })
        "#,
    );
    assert_eq!(error, None);
    assert_eq!(said(&ops, "v"), "nil 10.0.0.5");
}

#[test]
fn a_plugin_with_inventory_read_gets_the_groups() {
    let (_, ops, error, _folder) = load(
        "groups",
        &["inventory.read"],
        r#"
        local groups = roster.inventory.groups()
        roster.status.set("v", { text = groups.lab.title })
        "#,
    );
    assert_eq!(error, None);
    assert_eq!(said(&ops, "v"), "The lab");
}

/// A `cmd:` or `env:` reference says how a secret is fetched (and a secret pasted into a `cmd:`
/// line would show): a Plugin sees only which kind it is (decision Q92).
#[test]
fn cmd_and_env_references_reach_a_plugin_without_their_text() {
    let (_, ops, error, _folder) = load(
        "redact",
        &["inventory.read", "serve:hosts.list"],
        r#"
        local h = roster.inventory.host("esx-02")
        local l = roster.inventory.hosts()[1]
        local s = roster.serve.call("hosts.list").hosts[1]
        roster.status.set("v", { text = table.concat({ h.ssh.auth, h.auth, h.login.auth, h.services.web.auth,
          l.ssh.auth, l.login.auth, s.ssh.auth, s.auth }, "|") })
        "#,
    );
    assert_eq!(error, None);
    assert_eq!(said(&ops, "v"), "cmd:|cmd:|env:|bw:esx-02 web|cmd:|env:|cmd:|cmd:");
}

/// What `pcall(f, …)` said, as the status segment `v`.
fn error_of(test: &str, call: &str) -> String {
    let init = format!(
        "local ok, err = pcall(function() {call} end)\nroster.status.set(\"v\", {{ text = tostring(ok) .. \" \" .. tostring(err) }})"
    );
    let (_, ops, error, _folder) = load(test, &[], &init);
    assert_eq!(error, None);
    said(&ops, "v")
}

#[test]
fn data_that_cant_be_handed_over_names_the_function_and_says_plugin_value() {
    let text = error_of(
        "data-error",
        r#"roster.sidebar.set("x", { rows = { { label = coroutine.create(function() end) } } })"#,
    );
    assert_eq!(
        text,
        "false roster.sidebar.set: rows.1.label: a thread can't be a Plugin value"
    );
    let text = error_of(
        "data-error-float",
        r#"roster.float.open({ title = {}, lines = { true, 1, { 2 } }, x = 1 / 0 })"#,
    );
    assert!(text.starts_with("false roster.float.open: "), "{text}");
}

#[test]
fn removing_checks_the_id_like_setting_does() {
    for (call, what) in [
        ("roster.sidebar.remove(\"Bad Id\")", "roster.sidebar.remove"),
        ("roster.commands.remove(\"no spaces\")", "roster.commands.remove"),
        ("roster.themes.remove(\"\")", "roster.themes.remove"),
    ] {
        let text = error_of("remove-id", call);
        assert!(
            text.starts_with(&format!("false {what}: ")) && text.contains("isn't a name like"),
            "{call}: {text}"
        );
    }
}

#[test]
fn a_plugin_takes_away_its_theme_and_key_binding() {
    let (_, ops, error, _folder) = load(
        "removals",
        &[],
        r#"
        roster.themes.remove("dusk")
        roster.keymap.del("leader", "w w")
        roster.keymap.set("leader", "w x", false)
        "#,
    );
    assert_eq!(error, None);
    assert_eq!(
        ops,
        [
            json!({ "op": "remove", "kind": "theme", "id": "dusk" }),
            json!({ "op": "key", "context": "leader", "keys": "w w", "action": false }),
            json!({ "op": "key", "context": "leader", "keys": "w x", "action": false }),
        ]
    );
}

#[test]
fn coroutines_work_and_cant_outrun_the_budget() {
    let (_, ops, error, _folder) = load(
        "coroutine",
        &[],
        r#"
        local gen = coroutine.wrap(function() for i = 1, 3 do coroutine.yield(i) end end)
        roster.status.set("v", { text = gen() .. gen() .. gen() })
        "#,
    );
    assert_eq!(error, None);
    assert_eq!(said(&ops, "v"), "123");
    // An endless loop inside a coroutine is stopped, and resume can't swallow that.
    let (_, _, error, _folder) = load(
        "coroutine-loop",
        &[],
        r#"
        local co = coroutine.create(function() while true do end end)
        local ok = coroutine.resume(co)
        roster.status.set("v", { text = "carried on" })
        "#,
    );
    let error = error.expect("it ran out of time");
    assert!(error.contains("an endless loop?"), "{error}");
}

/// `:plugins types PATH`: the stubs for this app's API, as `types/roster.lua` in a Plugin's folder.
#[test]
fn the_stubs_are_written_into_a_plugins_folder() {
    let dir = plugin_dir("types", &[], "");
    let written = roster_core::plugin::api::write_stubs(&dir).unwrap();
    assert_eq!(written, dir.join("types").join("roster.lua"));
    assert_eq!(
        std::fs::read_to_string(&written).unwrap(),
        roster_core::plugin::api::stubs()
    );
    // Again, over the old copy.
    std::fs::write(&written, "old").unwrap();
    roster_core::plugin::api::write_stubs(&dir).unwrap();
    assert_eq!(
        std::fs::read_to_string(&written).unwrap(),
        roster_core::plugin::api::stubs()
    );
    let missing = dir.join("nope");
    assert!(
        roster_core::plugin::api::write_stubs(&missing)
            .unwrap_err()
            .contains("isn't a folder")
    );
}

/// A timer's run (ticket 79) has a call's budget: a loop in it, in a coroutine or not, is stopped
/// by the same global hook, and `roster.has` answers in it.
#[test]
fn a_timer_that_loops_is_stopped_even_inside_a_coroutine() {
    let (host, ops, error, _folder) = load(
        "timer-loop",
        &["inventory.read"],
        r#"
        roster.defer(50, function() while true do end end)
        roster.defer(50, function()
          roster.status.set("has", { text = tostring(roster.has("inventory.read")) .. " " .. tostring(roster.has("terminal.read")) })
          coroutine.wrap(function() while true do end end)()
        end)
        "#,
    );
    assert_eq!(error, None);
    let timers: Vec<u64> = ops
        .iter()
        .filter(|o| o["op"] == "timer")
        .map(|o| o["run"]["handler"].as_u64().unwrap())
        .collect();
    assert_eq!(timers.len(), 2, "{ops:?}");
    for t in timers {
        let r = host.call("t", t, json!({}));
        let e = r.error.expect("it ran out of time").to_string();
        assert!(e.contains("an endless loop?"), "{e}");
        // A failed run's UI changes are dropped, so `has` is checked on its own below.
        assert!(r.ops.is_empty());
    }
    let (_, ops, _, _folder) = load(
        "has",
        &["inventory.read"],
        r#"roster.status.set("has", { text = tostring(roster.has("inventory.read")) .. " " .. tostring(roster.has("terminal.read")) })"#,
    );
    assert_eq!(said(&ops, "has"), "true false");
}

/// Raw text a Plugin gets from serve (`changes.diff`'s `diff`, `host.check`'s step messages) has
/// its `cmd:` and `env:` references cut too, wherever they are in it (ticket 86, decision Q92):
/// a `cmd:` one to the end of its line, an `env:` one its variable's name. The rest stays.
#[test]
fn cmd_and_env_references_in_raw_text_reach_a_plugin_cut() {
    // host.check connects to the Host: only ever the user's call (decision Q100), a command here.
    let (host, loaded, error, _folder) = load(
        "redact-text",
        &["serve:changes.diff", "serve:host.check"],
        r#"
        roster.commands.add("go", { run = function()
          local d = roster.serve.call("changes.diff").diff
          local c = roster.serve.call("host.check", { host = "esx-02" }).steps
          roster.status.set("diff", { text = d })
          roster.status.set("check", { text = table.concat({ c[1].message, c[2].message, c[2].details.auth,
            c[2].details.tried[1], c[2].details.tried[2] }, "|") })
        end })
        "#,
    );
    assert_eq!(error, None);
    let go = loaded[0]["run"]["handler"].as_u64().unwrap();
    let r = host.call("t", go, json!({ "args": "", "words": [] }));
    assert!(r.error.is_none(), "{:?}", r.error);
    let ops = r.ops;
    assert_eq!(
        said(&ops, "diff"),
        "--- a/roster.yml\n+++ b/roster.yml\n@@ -3,2 +3,4 @@\n   esx-02:\n-    auth: \"cmd:\"\n+    auth: cmd:\n+    login: { user: admin, auth: env: }\n+    ssh: { auth: 'env:' }\n"
    );
    assert_eq!(said(&ops, "check"), "cmd: is ready|cmd:|env:|cmd:|bw:esx-02 web");
}
