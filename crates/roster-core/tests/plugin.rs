//! Plugins (ADR 0006, decisions Q81 and Q82): a folder with `roster-plugin.lua` and `init.lua`,
//! loaded through `PluginHost` with what the user granted. These tests drive the host the Tauri
//! shell uses, with real folders in a temp dir and a fake `roster serve` that records each call.

mod common;

use roster_core::plugin::{Event, Limits, Permission, PluginHost, Serve, Source, read_manifest};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A stand-in `roster serve`: answers the read and write methods, records every call, and can
/// be made slow.
#[derive(Default)]
struct FakeServe {
    calls: Mutex<Vec<(String, Value)>>,
    delay: Option<Duration>,
}

impl Serve for FakeServe {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.calls.lock().unwrap().push((method.to_string(), params.clone()));
        if let Some(d) = self.delay {
            std::thread::sleep(d);
        }
        match method {
            "hosts.list" => Ok(json!({
                "hosts": [{ "name": "esx-02", "ip": "10.0.0.5", "group": "lab",
                            "ssh": { "user": "root", "auth": "bw:esx-02 root" } }],
                "groups": { "lab": {} }
            })),
            "host.get" => Ok(json!({ "name": params["name"], "ip": "10.0.0.5" })),
            "host.update" => Ok(json!({ "host": params["host"], "pending": true })),
            "inventory.info" => Ok(json!({ "api_version": 17 })),
            other => Err(format!("unknown method {other}")),
        }
    }
}

impl FakeServe {
    fn methods(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(|(m, _)| m.clone()).collect()
    }
}

fn plugin_dir(test: &str, manifest: &str, init: &str) -> common::Temp {
    let dir = common::temp(&format!("plugin-{test}"));
    std::fs::write(dir.join("roster-plugin.lua"), manifest).unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    dir
}

fn manifest(name: &str, permissions: &[&str]) -> String {
    let list: Vec<String> = permissions.iter().map(|p| format!("{p:?}")).collect();
    format!(
        "return {{ name = {name:?}, version = \"1.0.0\", description = \"A test\", api = 2, permissions = {{ {} }} }}",
        list.join(", ")
    )
}

fn host_with(serve: Arc<FakeServe>) -> PluginHost {
    PluginHost::new(serve, Limits::default())
}

fn host() -> (PluginHost, Arc<FakeServe>) {
    let serve = Arc::new(FakeServe::default());
    (host_with(Arc::clone(&serve)), serve)
}

fn perms(names: &[&str]) -> Vec<Permission> {
    names.iter().map(|n| Permission::parse(n).unwrap()).collect()
}

fn handler(op: &Value, key: &str) -> u64 {
    op[key]["handler"]
        .as_u64()
        .unwrap_or_else(|| panic!("no handler at {key} in {op}"))
}

#[test]
fn the_manifest_says_who_it_is_and_what_it_asks_for_with_the_risks() {
    let dir = plugin_dir("manifest", &manifest("recent-alerts", &["terminal.read"]), "");
    let m = read_manifest(&dir).unwrap();
    assert_eq!(m.name, "recent-alerts");
    assert_eq!(m.version, "1.0.0");
    assert_eq!(m.permissions, perms(&["terminal.read"]));
    let shown = serde_json::to_value(&m).unwrap();
    assert_eq!(shown["permissions"][0]["name"], "terminal.read");
    assert!(shown["permissions"][0]["risk"].as_str().unwrap().contains("password"));
}

#[test]
fn a_manifest_cant_ask_for_a_secret_or_what_doesnt_exist() {
    for (perm, says) in [
        ("serve:vault.unlock", "never one that reaches a secret"),
        ("serve:session.prepare", "never one that reaches a secret"),
        ("serve:changes.publish", "never one that reaches a secret"),
        ("serve:quick.save", "never one that reaches a secret"),
        ("network", "names the site it may reach"),
        ("vault.read", "isn't a permission"),
    ] {
        let dir = plugin_dir("secret-manifest", &manifest("greedy", &[perm]), "");
        let e = read_manifest(&dir).unwrap_err();
        assert!(e.message.contains(says), "{perm}: {e}");
        assert_eq!(e.file.as_deref(), Some("roster-plugin.lua"));
    }
    let dir = plugin_dir("mesh-manifest", &manifest("mesh", &["serve:mesh.status"]), "");
    assert_eq!(read_manifest(&dir).unwrap().permissions, perms(&["serve:mesh.status"]));
}

#[test]
fn a_manifest_names_a_newer_api_or_a_bad_name() {
    let dir = plugin_dir("newer", r#"return { name = "x", version = "1", api = 99 }"#, "");
    assert!(read_manifest(&dir).unwrap_err().message.contains("update the app"));
    let dir = plugin_dir("badname", r#"return { name = "Bad Name", version = "1", api = 2 }"#, "");
    assert!(read_manifest(&dir).unwrap_err().message.contains("isn't a Plugin name"));
    let dir = plugin_dir("code", r#"os.exit() return {}"#, "");
    assert!(
        read_manifest(&dir).is_err(),
        "the manifest runs in the sandbox, with no os.exit"
    );
}

#[test]
fn a_plugin_adds_commands_keys_sections_status_finders_and_help_as_ops() {
    let dir = plugin_dir(
        "registries",
        &manifest("hello", &[]),
        r##"
        local roster = require("roster")
        roster.commands.add("hello", { desc = "Says hello", run = function(a)
          roster.notify("hello " .. a.args)
          return "done"
        end })
        roster.keymap.set("leader", "h h", "hello")
        roster.sidebar.set("greetings", { title = "Greetings", rows = {
          { id = "one", label = "one", run = function() roster.notify("one") end },
        } })
        roster.status.set("greet", { text = "hi" })
        roster.finders.set("greets", { title = "Greetings", items = function(q) return { { label = "a" .. q.query } } end })
        roster.help.set("hello", { title = "Hello", markdown = "# Hello" })
        roster.badges.set("esx-02", "2 alerts")
        roster.themes.define("hello-dark", { label = "Hello", appearance = "dark", colors = { accent = "#ff8800" } })
        "##,
    );
    let (host, _) = host();
    let (m, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    assert_eq!(m.name, "hello");
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let kinds: Vec<&str> = reply.ops.iter().map(|o| o["op"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        [
            "command", "key", "section", "status", "finder", "help", "badge", "theme"
        ]
    );
    assert_eq!(reply.ops[1]["action"], "hello");
    assert_eq!(reply.ops[7]["theme"]["colors"]["accent"], "#ff8800");

    let run = handler(&reply.ops[0], "run");
    let r = host.call("hello", run, json!({ "args": "world", "words": ["world"] }));
    assert_eq!(r.result, "done");
    assert_eq!(
        r.ops,
        [json!({ "op": "notify", "text": "hello world", "level": "info" })]
    );

    let items = handler(&reply.ops[4]["spec"], "items");
    let r = host.call("hello", items, json!({ "query": "b" }));
    assert_eq!(r.result, json!([{ "label": "ab" }]));
}

#[test]
fn a_function_without_its_permission_isnt_there() {
    let dir = plugin_dir(
        "absent",
        &manifest("nosy", &["terminal.read"]),
        r#"
        local missing = {}
        for _, name in ipairs({ "inventory", "terminal", "serve", "network", "vault", "http", "io" }) do
          if roster[name] ~= nil then table.insert(missing, name) end
        end
        -- Every Plugin may go to a Session (ticket 78); opening one needs sessions.open.
        if roster.sessions.open ~= nil then table.insert(missing, "sessions.open") end
        roster.status.set("found", { text = table.concat(missing, ",") })
        "#,
    );
    let (host, _) = host();
    // Granting more than the manifest asks for changes nothing.
    let (_, reply) = host
        .load(
            &Source::Dir(dir.to_path_buf()),
            &perms(&["terminal.read", "terminal.write", "sessions.open", "inventory.read"]),
        )
        .unwrap();
    assert_eq!(reply.ops[0]["spec"]["text"], "", "{:?}", reply.ops);
}

#[test]
fn granted_functions_reach_only_their_serve_methods_and_writes_stay_pending() {
    let dir = plugin_dir(
        "granted",
        &manifest(
            "reader",
            &["inventory.read", "inventory.write", "sessions.open", "terminal.write"],
        ),
        r#"
        -- An Inventory write is only ever the user's call (decision Q100): a command here.
        roster.commands.add("go", { run = function()
          local hosts = roster.inventory.hosts()
          local one = roster.inventory.host("esx-02")
          local r = roster.inventory.update("esx-02", { description = "lab box" })
          roster.sessions.open(hosts[1].name)
          roster.terminal.send(3, "uptime\n")
          roster.status.set("n", { text = #hosts .. " " .. one.ip .. " " .. tostring(r.pending) })
        end })
        "#,
    );
    let (host, serve) = host();
    let (_, loaded) = host
        .load(
            &Source::Dir(dir.to_path_buf()),
            &perms(&["inventory.read", "inventory.write", "sessions.open", "terminal.write"]),
        )
        .unwrap();
    assert!(loaded.error.is_none(), "{:?}", loaded.error);
    let go = loaded.ops[0]["run"]["handler"].as_u64().unwrap();
    let reply = host.call("reader", go, json!({ "args": "", "words": [] }));
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(serve.methods(), ["hosts.list", "host.get", "host.update"]);
    assert_eq!(reply.ops[0], json!({ "op": "open", "host": "esx-02" }));
    assert_eq!(reply.ops[1], json!({ "op": "send", "session": 3, "text": "uptime\n" }));
    assert_eq!(reply.ops[2]["spec"]["text"], "1 10.0.0.5 true");
}

#[test]
fn serve_call_reaches_only_the_methods_granted_by_name() {
    let dir = plugin_dir(
        "servecall",
        &manifest("info", &["serve:inventory.info"]),
        r#"
        local info = roster.serve.call("inventory.info")
        local ok, err = pcall(roster.serve.call, "vault.unlock", { password = "x" })
        local ok2 = pcall(roster.serve.call, "hosts.list")
        roster.status.set("v", { text = info.api_version .. " " .. tostring(ok) .. " " .. tostring(ok2) .. " " .. err })
        "#,
    );
    let (host, serve) = host();
    let (_, reply) = host
        .load(&Source::Dir(dir.to_path_buf()), &perms(&["serve:inventory.info"]))
        .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let text = reply.ops[0]["spec"]["text"].as_str().unwrap();
    assert!(text.starts_with("17 false false"), "{text}");
    assert!(text.contains("not granted (serve:vault.unlock)"), "{text}");
    assert_eq!(serve.methods(), ["inventory.info"]);
}

/// Every function of the `roster` module, with every permission granted, reaches roster serve
/// only through the methods a Plugin may be granted: nothing that holds or takes a password, a
/// vault session or an askpass token.
#[test]
fn no_api_path_reaches_a_password_vault_session_or_askpass_token() {
    let all = [
        "inventory.read",
        "inventory.write",
        "sessions.open",
        "terminal.read",
        "terminal.write",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain(
        roster_core::plugin::permission::SERVE_METHODS
            .iter()
            .map(|m| format!("serve:{m}")),
    )
    .collect::<Vec<_>>();
    let names: Vec<&str> = all.iter().map(String::as_str).collect();
    let dir = plugin_dir(
        "secrets",
        &manifest("everything", &names),
        r#"
        -- Walk the module: every function, called with plausible arguments; collect every name.
        local names = {}
        local function walk(t, prefix, seen)
          for k, v in pairs(t) do
            local name = prefix .. k
            if type(v) == "table" and not seen[v] then
              seen[v] = true
              walk(v, name .. ".", seen)
            elseif type(v) == "function" then
              table.insert(names, name)
              pcall(v, "esx-02", { password = "hunter2" }, "x")
            end
          end
        end
        walk(roster, "roster.", {})
        for _, m in ipairs({ "vault.unlock", "vault.status", "vault.login", "session.prepare", "quick.save",
                             "host.save_login", "host.add", "vault.create_item", "changes.publish" }) do
          pcall(roster.serve.call, m, { password = "hunter2" })
        end
        table.sort(names)
        roster.status.set("names", { text = table.concat(names, " ") })
        "#,
    );
    let (host, serve) = host();
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &perms(&names)).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let secret_words = [
        "password",
        "vault",
        "askpass",
        "secret",
        "token",
        "master",
        "session_key",
        "unlock",
    ];
    let functions = reply.ops.iter().find(|o| o["id"] == "names").unwrap()["spec"]["text"]
        .as_str()
        .unwrap()
        .to_string();
    for word in secret_words {
        assert!(
            !functions.to_lowercase().contains(word),
            "a function named for {word}: {functions}"
        );
    }
    let allowed = [
        "hosts.list",
        "host.get",
        "inventory.info",
        "host.check",
        "changes.diff",
        "host.update",
        "host.rename",
        "host.move",
        "host.review",
    ];
    for m in serve.methods() {
        assert!(allowed.contains(&m.as_str()), "a Plugin reached {m}");
    }
    assert!(!serve.methods().is_empty());
}

#[test]
fn events_reach_only_plugins_that_may_hear_them() {
    let listener = r#"
        roster.on("lock", function() roster.notify("locked") end)
        if roster.plugin.permissions[1] == "terminal.read" then
          roster.on("terminal_output", function(e) roster.notify(e.host .. ": " .. e.text) end)
        else
          local ok, err = pcall(roster.on, "terminal_output", function() end)
          roster.notify(err)
        end
    "#;
    let reader = plugin_dir("reader-ev", &manifest("reader", &["terminal.read"]), listener);
    let deaf = plugin_dir("deaf-ev", &manifest("deaf", &["terminal.read"]), listener);
    let (host, _) = host();
    host.load(&Source::Dir(reader.to_path_buf()), &perms(&["terminal.read"]))
        .unwrap();
    let (_, deaf_load) = host.load(&Source::Dir(deaf.to_path_buf()), &[]).unwrap();
    assert!(deaf_load.error.is_none(), "{:?}", deaf_load.error);
    assert!(
        deaf_load.ops[0]["text"]
            .as_str()
            .unwrap()
            .contains("needs the terminal.read permission")
    );

    let replies = host.event(Event {
        name: "terminal_output".into(),
        payload: json!({ "session": 1, "host": "esx-02", "text": "ERROR disk full" }),
    });
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].plugin, "reader");
    assert_eq!(replies[0].ops[0]["text"], "esx-02: ERROR disk full");

    let replies = host.event(Event {
        name: "lock".into(),
        payload: json!({}),
    });
    assert_eq!(replies.len(), 2);
}

/// A marked shell's commands (ticket 94, #167): `command_done` is terminal.read's, like the output
/// it summarises; it carries the command line, its output and its exit code, never what's typed.
#[test]
fn command_done_reaches_only_plugins_with_terminal_read() {
    let listener = r#"
        local ok, err = pcall(roster.on, "command_done", function(e)
          roster.notify(e.host .. ": " .. e.command .. " -> " .. tostring(e.code) .. ": " .. e.output)
        end)
        if not ok then roster.notify(err) end
    "#;
    let reader = plugin_dir("reader-done", &manifest("reader", &["terminal.read"]), listener);
    let deaf = plugin_dir("deaf-done", &manifest("deaf", &["terminal.read"]), listener);
    let (host, _) = host();
    host.load(&Source::Dir(reader.to_path_buf()), &perms(&["terminal.read"]))
        .unwrap();
    let (_, deaf_load) = host.load(&Source::Dir(deaf.to_path_buf()), &[]).unwrap();
    assert!(
        deaf_load.ops[0]["text"]
            .as_str()
            .unwrap()
            .contains("the command_done event needs the terminal.read permission")
    );
    let replies = host.event(Event {
        name: "command_done".into(),
        payload: json!({ "session": 1, "host": "esx-02", "command": "df -h", "output": "disk full\n", "code": 1 }),
    });
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].plugin, "reader");
    assert_eq!(replies[0].ops[0]["text"], "esx-02: df -h -> 1: disk full\n");
}

/// serve's job progress (ticket 101, decision Q112f): a Plugin hears a job only of a kind it may
/// already ask about, a Mesh job with `serve:mesh.job`, a scan with `serve:discover.status`.
#[test]
fn job_progress_reaches_only_plugins_that_may_ask_about_that_kind_of_job() {
    let listener = r#"
        local ok, err = pcall(roster.on, "job_progress", function(e)
          roster.notify(e.kind .. " " .. tostring(e.job) .. " " .. e.state .. " " .. e.done .. "/" .. e.total)
        end)
        if not ok then roster.notify(err) end
    "#;
    let meshy = plugin_dir("meshy-ev", &manifest("meshy", &["serve:mesh.job"]), listener);
    let scanny = plugin_dir("scanny-ev", &manifest("scanny", &["serve:discover.status"]), listener);
    let neither = plugin_dir("neither-ev", &manifest("neither", &["serve:mesh.status"]), listener);
    let (host, _) = host();
    host.load(&Source::Dir(meshy.to_path_buf()), &perms(&["serve:mesh.job"]))
        .unwrap();
    host.load(&Source::Dir(scanny.to_path_buf()), &perms(&["serve:discover.status"]))
        .unwrap();
    let (_, deaf) = host
        .load(&Source::Dir(neither.to_path_buf()), &perms(&["serve:mesh.status"]))
        .unwrap();
    assert!(
        deaf.ops[0]["text"]
            .as_str()
            .unwrap()
            .contains("the job_progress event needs the serve:mesh.job or serve:discover.status or serve:host.check_job permission"),
        "{:?}",
        deaf.ops
    );
    let heard = |payload: serde_json::Value| -> Vec<(String, String)> {
        host.event(Event {
            name: "job_progress".into(),
            payload,
        })
        .into_iter()
        .map(|r| (r.plugin, r.ops[0]["text"].as_str().unwrap().to_string()))
        .collect()
    };
    assert_eq!(
        heard(
            json!({ "kind": "mesh", "job": 3, "action": "apply", "state": "running", "done": 1, "total": 4, "at": "orion-2" })
        ),
        vec![("meshy".to_string(), "mesh 3 running 1/4".to_string())]
    );
    assert_eq!(
        heard(
            json!({ "kind": "discover", "job": "scan-1", "action": "scan", "state": "done", "done": 254, "total": 254 })
        ),
        vec![("scanny".to_string(), "discover scan-1 done 254/254".to_string())]
    );
    assert!(
        heard(json!({ "kind": "backup", "job": 1, "action": "x", "state": "running", "done": 0, "total": 1 }))
            .is_empty()
    );
}

/// A Host's check is a job too (serve API 21, ticket 108): a Plugin hears it with
/// `serve:host.check_job`, the read it would ask about that check with. `serve:host.check` alone
/// isn't enough: it's asked only in the user's call, never from an event listener. And no Plugin
/// may ever send serve's `$/cancel`.
#[test]
fn a_check_job_reaches_only_plugins_that_may_read_it() {
    let listener = r#"
        local ok, err = pcall(roster.on, "job_progress", function(e)
          roster.notify(e.kind .. " " .. tostring(e.job) .. " " .. e.state .. " " .. tostring(e.at))
        end)
        if not ok then roster.notify(err) end
    "#;
    let reader = plugin_dir("checky-ev", &manifest("checky", &["serve:host.check_job"]), listener);
    let caller = plugin_dir("calls-ev", &manifest("calls", &["serve:host.check"]), listener);
    let (host, _) = host();
    host.load(&Source::Dir(reader.to_path_buf()), &perms(&["serve:host.check_job"]))
        .unwrap();
    let (_, deaf) = host
        .load(&Source::Dir(caller.to_path_buf()), &perms(&["serve:host.check"]))
        .unwrap();
    assert!(
        deaf.ops[0]["text"]
            .as_str()
            .unwrap()
            .contains("needs the serve:mesh.job"),
        "{:?}",
        deaf.ops
    );
    let heard: Vec<_> = host
        .event(Event {
            name: "job_progress".into(),
            payload: json!({ "kind": "check", "job": "check-1", "action": "check", "state": "running", "done": 3, "total": 8, "at": "dns", "host": "esx-02" }),
        })
        .into_iter()
        .map(|r| (r.plugin, r.ops[0]["text"].as_str().unwrap().to_string()))
        .collect();
    assert_eq!(
        heard,
        vec![("checky".to_string(), "check check-1 running dns".to_string())]
    );
    assert!(roster_core::plugin::Permission::parse("serve:host.check_job").is_ok());
    assert!(roster_core::plugin::Permission::parse("serve:$/cancel").is_err());
}

/// A `job_progress` payload is serve's text, as an answer is: its `cmd:`/`env:` references are
/// cut the same way (decision Q92; iteration 9 review, item 1), a failed job's error message most
/// of all, since serve's messages echo the Login they were given.
#[test]
fn job_progress_is_cut_as_serves_answers_are() {
    let listener = r#"
        roster.on("job_progress", function(e)
          roster.notify(tostring(e.at) .. "|" .. (e.error and e.error.message or "-"))
        end)
    "#;
    let reader = plugin_dir("cut-ev", &manifest("cutty", &["serve:host.check_job"]), listener);
    let (host, _) = host();
    host.load(&Source::Dir(reader.to_path_buf()), &perms(&["serve:host.check_job"]))
        .unwrap();
    let heard: Vec<String> = host
        .event(Event {
            name: "job_progress".into(),
            payload: json!({ "kind": "check", "job": "check-1", "action": "check", "state": "failed",
                             "done": 3, "total": 8, "at": "auth env:LAB_PW", "host": "esx-02",
                             "error": { "code": 5, "message": "cmd:pass show esx-02 --hunter2 failed: exit 1",
                                        "data": { "cmd:pass show x": "env:LAB_PW" } } }),
        })
        .into_iter()
        .map(|r| r.ops[0]["text"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(heard, vec!["auth env:|cmd:".to_string()]);
}

#[test]
fn an_error_while_loading_names_the_plugin_and_line_and_disables_it() {
    let dir = plugin_dir("loaderr", &manifest("broken", &[]), "local x = nil\n\nx.y = 1\n");
    let (host, _) = host();
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    let e = reply.error.unwrap();
    assert_eq!(
        (e.plugin.as_str(), e.file.as_deref(), e.line),
        ("broken", Some("init.lua"), Some(3))
    );
    assert!(reply.disabled.is_some());
    assert!(host.list()[0].disabled.is_some());
    assert!(
        host.call("broken", 1, json!({}))
            .error
            .unwrap()
            .message
            .contains("disabled")
    );
}

#[test]
fn a_hook_that_loops_runs_out_of_time_and_a_repeat_offender_is_disabled() {
    let dir = plugin_dir(
        "loops",
        &manifest("loopy", &[]),
        r#"roster.commands.add("spin", { run = function()
             while true do end
           end })
           roster.commands.add("fine", { run = function() return "ok" end })"#,
    );
    let (host, _) = host();
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    let (spin, fine) = (handler(&reply.ops[0], "run"), handler(&reply.ops[1], "run"));
    let started = Instant::now();
    let r = host.call("loopy", spin, json!({}));
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the budget is a quarter second"
    );
    let e = r.error.unwrap();
    assert!(e.message.contains("took longer than 250 ms"), "{e}");
    assert_eq!(e.line, Some(2));
    assert!(r.disabled.is_none(), "one strike");
    assert_eq!(host.call("loopy", fine, json!({})).result, "ok");
    host.call("loopy", spin, json!({}));
    let third = host.call("loopy", spin, json!({}));
    assert!(third.disabled.unwrap().contains("failed 3 times"));
    assert!(host.call("loopy", fine, json!({})).error.is_some());
}

#[test]
fn a_plugin_that_eats_memory_is_stopped() {
    let dir = plugin_dir(
        "memory",
        &manifest("hungry", &[]),
        r#"local t = {} for i = 1, 1e9 do t[i] = string.rep("x", 1000) .. i end"#,
    );
    let (host, _) = host();
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    let e = reply.error.unwrap();
    assert!(e.message.contains("memory") || e.message.contains("took longer"), "{e}");
}

#[test]
fn a_slow_plugin_is_given_up_on_and_the_others_keep_working() {
    let host = PluginHost::new(
        Arc::new(FakeServe::default()),
        Limits {
            grace: Duration::from_millis(300),
            ..Limits::default()
        },
    );
    // One long C call (a pattern that backtracks): the time budget can't stop it inside.
    let slow = plugin_dir(
        "slow",
        &manifest("slow", &[]),
        r#"roster.commands.add("wait", { run = function()
  return (string.rep("a", 4000)):find("(.-)(.-)(.-)(.-)b") end })"#,
    );
    let quick = plugin_dir(
        "quick",
        &manifest("quick", &[]),
        r#"roster.commands.add("q", { run = function() return 1 end })"#,
    );
    let (_, slow_load) = host.load(&Source::Dir(slow.to_path_buf()), &[]).unwrap();
    let (_, quick_load) = host.load(&Source::Dir(quick.to_path_buf()), &[]).unwrap();
    let started = Instant::now();
    let r = host.call("slow", handler(&slow_load.ops[0], "run"), json!({}));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(r.disabled.unwrap().contains("didn't answer"));
    assert_eq!(
        host.call("quick", handler(&quick_load.ops[0], "run"), json!({})).result,
        1
    );
}

/// Waiting for roster serve is serve's time, not the Plugin's (decision Q103).
#[test]
fn a_plugin_waiting_for_a_slow_serve_isnt_given_up_on_and_the_others_keep_working() {
    let slow_serve = Arc::new(FakeServe {
        delay: Some(Duration::from_millis(1500)),
        ..FakeServe::default()
    });
    let host = Arc::new(PluginHost::new(
        slow_serve,
        Limits {
            grace: Duration::from_millis(300),
            ..Limits::default()
        },
    ));
    let slow = plugin_dir(
        "waits",
        &manifest("waits", &["inventory.read"]),
        r#"roster.commands.add("wait", { run = function() return #roster.inventory.hosts() end })"#,
    );
    let quick = plugin_dir(
        "quick2",
        &manifest("quick2", &[]),
        r#"roster.commands.add("q", { run = function() return 1 end })"#,
    );
    let (_, slow_load) = host
        .load(&Source::Dir(slow.to_path_buf()), &perms(&["inventory.read"]))
        .unwrap();
    let (_, quick_load) = host.load(&Source::Dir(quick.to_path_buf()), &[]).unwrap();
    let waiting = {
        let host = Arc::clone(&host);
        let h = handler(&slow_load.ops[0], "run");
        std::thread::spawn(move || host.call("waits", h, json!({})))
    };
    std::thread::sleep(Duration::from_millis(50));
    let started = Instant::now();
    assert_eq!(
        host.call("quick2", handler(&quick_load.ops[0], "run"), json!({}))
            .result,
        1
    );
    assert!(started.elapsed() < Duration::from_millis(500));
    let r = waiting.join().unwrap();
    assert!(r.disabled.is_none(), "{:?}", r.disabled);
    assert_eq!(r.result, 1);
}

#[test]
fn setting_a_section_again_replaces_its_actions() {
    let dir = plugin_dir(
        "replace",
        &manifest("rows", &[]),
        r#"local n = 0
           roster.commands.add("again", { run = function()
             n = n + 1
             roster.sidebar.set("s", { title = "S", rows = { { id = "r", label = "r", run = function() return n end } } })
           end })"#,
    );
    let (host, _) = host();
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    let again = handler(&reply.ops[0], "run");
    let first = host.call("rows", again, json!({}));
    let old = handler(&first.ops[0]["spec"]["rows"][0], "run");
    let second = host.call("rows", again, json!({}));
    let new = handler(&second.ops[0]["spec"]["rows"][0], "run");
    assert_eq!(host.call("rows", new, json!({})).result, 2);
    let stale = host.call("rows", old, json!({}));
    assert!(stale.error.unwrap().message.contains("gone"));
    assert!(host.list()[0].errors == 0, "a stale action isn't the Plugin's fault");
}

#[test]
fn modules_load_from_the_plugins_own_folder_only() {
    let dir = plugin_dir(
        "modules",
        &manifest("mods", &[]),
        r#"local util = require("mods.util") roster.status.set("u", { text = util.word })
           local ok = pcall(require, "..secret")
           roster.notify(tostring(ok))"#,
    );
    std::fs::create_dir_all(dir.join("lua/mods")).unwrap();
    std::fs::write(dir.join("lua/mods/util.lua"), r#"return { word = "from a module" }"#).unwrap();
    let (host, _) = host();
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    assert_eq!(reply.ops[0]["spec"]["text"], "from a module");
    assert_eq!(reply.ops[1]["text"], "false");
}

#[test]
fn unloading_ends_a_plugin_and_reloading_runs_it_again_with_new_grants() {
    let dir = plugin_dir(
        "reload",
        &manifest("re", &["inventory.read"]),
        r#"roster.status.set("g", { text = tostring(roster.inventory ~= nil) })"#,
    );
    let (host, _) = host();
    let (_, r) = host
        .load(&Source::Dir(dir.to_path_buf()), &perms(&["inventory.read"]))
        .unwrap();
    assert_eq!(r.ops[0]["spec"]["text"], "true");
    // Revoking is loading again without the grant: the function is gone at once.
    let (_, r) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    assert_eq!(r.ops[0]["spec"]["text"], "false");
    assert!(host.unload("re"));
    assert!(host.list().is_empty());
}

#[test]
fn an_install_path_is_home_absolute_or_under_the_config_dir() {
    use roster_core::plugin::resolve_dir;
    let dir = plugin_dir("resolve", &manifest("where", &[]), "");
    let parent = dir.parent().unwrap();
    let name = dir.file_name().unwrap().to_str().unwrap();
    let want = dir.canonicalize().unwrap();
    assert_eq!(resolve_dir(name, Some(parent), None).unwrap(), want);
    assert_eq!(resolve_dir(&format!("~/{name}"), None, Some(parent)).unwrap(), want);
    assert_eq!(resolve_dir(dir.to_str().unwrap(), None, None).unwrap(), want);
    assert!(
        resolve_dir("nowhere-at-all", Some(parent), None)
            .unwrap_err()
            .contains("isn't a folder")
    );
}

#[test]
fn the_host_count_is_a_built_in_plugin_on_the_public_api() {
    let (host, serve) = host();
    let (m, reply) = host
        .load(&Source::Bundled("hosts".into()), &perms(&["inventory.read"]))
        .unwrap();
    assert_eq!(m.permissions, perms(&["inventory.read"]));
    assert_eq!(
        reply.ops,
        [json!({ "op": "status", "id": "hosts", "spec": { "text": "1 Host" } })]
    );
    let replies = host.event(Event {
        name: "inventory_changed".into(),
        payload: json!({}),
    });
    assert_eq!(replies[0].ops[0]["spec"]["text"], "1 Host");
    assert_eq!(serve.methods(), ["hosts.list", "hosts.list"]);
    // Revoked, it can't read the Inventory, and shows nothing.
    let (_, reply) = host.load(&Source::Bundled("hosts".into()), &[]).unwrap();
    assert!(reply.error.is_none() && reply.ops.is_empty());
}

#[test]
fn a_folder_plugin_cant_take_a_built_in_or_reserved_name() {
    let dir = plugin_dir("impostor", &manifest("hosts", &[]), "");
    let (host, _) = host();
    assert!(
        host.load(&Source::Dir(dir.to_path_buf()), &[])
            .unwrap_err()
            .message
            .contains("built into roster")
    );
    let dir = plugin_dir("builtin-name", &manifest("builtin", &[]), "");
    assert!(read_manifest(&dir).unwrap_err().message.contains("kept for roster"));
}

/// examples/plugins/pinned, the example docs/plugins.md walks through, loads and works.
#[test]
fn the_example_plugin_loads_and_pins_a_host() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins/pinned");
    let (host, _) = host();
    let (m, reply) = host.load(&Source::Dir(dir), &perms(&["inventory.read"])).unwrap();
    assert_eq!(m.name, "pinned");
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let pin = reply.ops.iter().find(|o| o["op"] == "command").unwrap();
    let r = host.call(
        "pinned",
        handler(pin, "run"),
        json!({ "args": "esx-02", "words": ["esx-02"] }),
    );
    assert!(r.error.is_none(), "{:?}", r.error);
    let section = r.ops.iter().find(|o| o["op"] == "section").unwrap();
    assert_eq!(section["spec"]["rows"][0]["detail"], "10.0.0.5");
    let status = r.ops.iter().find(|o| o["op"] == "status").unwrap();
    assert_eq!(status["spec"]["text"], "1 pinned");
}

#[test]
fn the_host_can_be_shared_across_the_shells_threads() {
    fn shared<T: Send + Sync>() {}
    shared::<PluginHost>();
    shared::<roster_core::plugin::Reply>();
}

#[test]
fn a_serve_method_that_acts_on_hosts_is_flagged_and_one_that_reads_isnt() {
    assert!(
        Permission::parse("serve:mesh.apply")
            .unwrap()
            .risk()
            .unwrap()
            .contains("mesh.apply")
    );
    assert!(Permission::parse("serve:mesh.cut").unwrap().risk().is_some());
    assert!(Permission::parse("serve:mesh.status").unwrap().risk().is_none());
}

/// Ticket 56: a Plugin may put text on the clipboard only while the user runs one of its actions,
/// commands or finder items, never on its own (at load, on an event).
#[test]
fn the_clipboard_is_written_only_in_a_call_the_user_started() {
    let dir = plugin_dir(
        "clipboard",
        &manifest("copier", &[]),
        r#"
        local roster = require("roster")
        local at_load = pcall(roster.clipboard.copy, "at load")
        roster.status.set("load", { text = tostring(at_load) })
        roster.on("lock", function() roster.clipboard.copy("on an event") end)
        roster.commands.add("copy", { run = function(a) roster.clipboard.copy(a.args) end })
        "#,
    );
    let (host, _) = host();
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(reply.ops[0]["spec"]["text"], "false");
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
            .contains("only while the user runs one of your actions")
    );
    let copy = reply.ops.iter().find(|o| o["op"] == "command").unwrap();
    let r = host.call(
        "copier",
        handler(copy, "run"),
        json!({ "args": "10.0.0.5", "words": ["10.0.0.5"] }),
    );
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(r.ops, [json!({ "op": "copy", "text": "10.0.0.5" })]);
    // And only then: the next event can't.
    let replies = host.event(Event {
        name: "lock".into(),
        payload: json!({}),
    });
    assert!(replies[0].error.is_some());
}

/// Decision Q87: text a Plugin hands the UI that isn't UTF-8 (a line cut in the middle of a
/// character, say) is shown with U+FFFD where it breaks, not refused: refusing it failed every
/// redraw, and three of those disabled the Plugin. Names (ids, table keys) are still refused.
#[test]
fn text_that_isnt_utf8_is_shown_with_a_replacement_character_not_an_error() {
    let dir = plugin_dir(
        "utf8",
        &manifest("cutter", &[]),
        r#"
        local roster = require("roster")
        local bad = "\xa9 ERROR here"
        roster.on("lock", function()
          roster.sidebar.set("cut", { title = "Cut", rows = { { id = "1", label = bad } } })
          roster.status.set("cut", { text = bad })
          roster.badges.set("esx-02", bad)
          roster.notify(bad, "warn")
          roster.float.open({ title = "Cut", lines = { bad } })
        end)
        roster.commands.add("copy", { run = function() roster.clipboard.copy(bad) end })
        "#,
    );
    let (host, _) = host();
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let shown = "\u{fffd} ERROR here";
    for _ in 0..4 {
        let replies = host.event(Event {
            name: "lock".into(),
            payload: json!({}),
        });
        assert_eq!(replies.len(), 1);
        let r = &replies[0];
        assert!(r.error.is_none(), "{:?}", r.error);
        assert!(r.disabled.is_none());
        assert_eq!(r.ops[0]["spec"]["rows"][0]["label"], shown);
        assert_eq!(r.ops[1]["spec"]["text"], shown);
        assert_eq!(r.ops[2]["text"], shown);
        assert_eq!(r.ops[3]["text"], shown);
        assert_eq!(r.ops[4]["spec"]["lines"][0], shown);
    }
    let copy = reply.ops.iter().find(|o| o["op"] == "command").unwrap();
    let r = host.call("cutter", handler(copy, "run"), json!({ "args": "", "words": [] }));
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(r.ops, [json!({ "op": "copy", "text": shown })]);
}
