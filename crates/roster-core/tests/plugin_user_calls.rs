//! What only the user's call may do, and the runtime's bounds (the iteration 8 review). Every serve
//! method a Plugin may call that changes something on the network or in the Inventory (the ones
//! the install prompt flags) runs only while the user runs one of its actions, commands or finder
//! items (decision Q100); a finder's `items` and a `:check` section's `check` run as the app asks,
//! never as the user's call; serve's errors reach a Plugin cut as its answers do (Q92); a failed
//! call leaves nothing behind in the core; and one call can't keep roster serve busy for ever.

mod common;

use roster_core::plugin::{Event, Limits, Permission, PluginHost, Reply, Serve, Source};
use serde_json::{Value, json};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A stand-in `roster serve` that answers every method, and remembers what it was asked.
#[derive(Default)]
struct Recorded {
    calls: Mutex<Vec<String>>,
    /// How long each call takes.
    slow: Option<Duration>,
}

impl Serve for Recorded {
    fn call(&self, method: &str, _params: Value) -> Result<Value, String> {
        self.calls.lock().unwrap().push(method.to_string());
        if let Some(d) = self.slow {
            std::thread::sleep(d);
        }
        match method {
            "host.get" => Err("no Login for esx-02: cmd:pass show esx-02/root failed (code 5)".into()),
            _ => Ok(json!({ "ok": true, "job": "job-1" })),
        }
    }
}

impl Recorded {
    fn methods(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

fn plugin_dir(test: &str, permissions: &[&str], init: &str) -> common::Temp {
    let dir = common::temp(&format!("plugin-user-calls-{test}"));
    let list: Vec<String> = permissions.iter().map(|p| format!("{p:?}")).collect();
    std::fs::write(
        dir.join("roster-plugin.lua"),
        format!(
            "return {{ name = \"guarded\", version = \"1.0.0\", api = 3, permissions = {{ {} }} }}",
            list.join(", ")
        ),
    )
    .unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    dir
}

fn listening(serve: &Arc<Recorded>, limits: Limits) -> (PluginHost, Receiver<Reply>) {
    let host = PluginHost::new(Arc::clone(serve) as Arc<dyn Serve>, limits);
    // The app tells it its built-in commands before any Plugin loads (issue #184).
    host.set_builtins([]);
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
    ok(&reply);
    (reply, folder)
}

fn ok(r: &Reply) {
    assert!(r.error.is_none(), "{:?}", r.error);
    assert!(r.disabled.is_none(), "{:?}", r.disabled);
}

fn handler(v: &Value) -> u64 {
    v["handler"].as_u64().unwrap_or_else(|| panic!("no handler in {v}"))
}

/// The handler of the command `name` among `ops`.
fn command(ops: &[Value], name: &str) -> u64 {
    let op = ops
        .iter()
        .find(|o| o["op"] == "command" && o["name"] == name)
        .unwrap_or_else(|| panic!("no command {name} in {ops:?}"));
    handler(&op["run"])
}

/// The first op `kind` among `ops`.
fn op<'a>(ops: &'a [Value], kind: &str) -> &'a Value {
    ops.iter()
        .find(|o| o["op"] == kind)
        .unwrap_or_else(|| panic!("no {kind} op in {ops:?}"))
}

fn notices(ops: &[Value]) -> Vec<String> {
    ops.iter()
        .filter(|o| o["op"] == "notify")
        .map(|o| o["text"].as_str().unwrap().to_string())
        .collect()
}

/// Waits (up to 10 s) until none of `plugin`'s `roster.serve.request`s is still waiting, so a
/// test that makes many of them stays under the cap on how many may wait at once, however slow the
/// machine running it (a slow Windows runner once hit "8 requests are waiting" mid-test).
fn settled(host: &PluginHost, plugin: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while host.requests(plugin) > 0 {
        assert!(Instant::now() < deadline, "{plugin}'s requests never all answered");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// The notices in the replies the Plugin sends on its own, until `want` of them or 3 s.
fn later(rx: &Receiver<Reply>, want: usize) -> Vec<String> {
    let mut out = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    while out.len() < want {
        let Ok(r) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) else {
            break;
        };
        ok(&r);
        out.extend(notices(&r.ops));
    }
    out
}

const ARGS: fn() -> Value = || json!({ "args": "", "words": [] });

/// Tries `method` through both `roster.serve.call` and `roster.serve.request`, and says how each
/// went: "call ok"/"call refused", "request ok"/"request refused".
const TRY: &str = r#"
local function try(method)
  local said = {}
  local ok, err = pcall(roster.serve.call, method, {})
  said[#said + 1] = ok and "call ok" or (tostring(err):find("only while the user runs", 1, true) and "call refused" or ("call failed: " .. tostring(err)))
  ok, err = pcall(roster.serve.request, method, {}, function() end)
  said[#said + 1] = ok and "request ok" or (tostring(err):find("only while the user runs", 1, true) and "request refused" or ("request failed: " .. tostring(err)))
  return method .. ": " .. table.concat(said, ", ")
end
"#;

#[test]
fn every_flagged_serve_method_waits_for_the_users_call_and_the_reads_dont() {
    let serve = Arc::new(Recorded::default());
    let (host, _rx) = listening(&serve, Limits::default());
    let methods = [
        "mesh.apply",
        "mesh.cut",
        "host.check",
        "discover.start",
        "mesh.status",
        "mesh.job",
    ];
    let permissions: Vec<String> = methods.iter().map(|m| format!("serve:{m}")).collect();
    let mut permissions: Vec<&str> = permissions.iter().map(String::as_str).collect();
    permissions.push("inventory.read");
    let init = format!(
        r#"{TRY}
local methods = {{ "mesh.apply", "mesh.cut", "host.check", "discover.start", "mesh.status", "mesh.job" }}
local function all(where)
  for _, m in ipairs(methods) do roster.notify(where .. " " .. try(m)) end
end
all("load")
roster.on("host_selected", function() all("event") end)
roster.defer(50, function() all("timer") end)
roster.commands.add("go", {{ run = function() all("user") end }})
"#
    );
    let (loaded, _folder) = load(&host, "flagged", &permissions, &init);
    let mut said = notices(&loaded.ops);
    settled(&host, "guarded");
    let timer = handler(&op(&loaded.ops, "timer")["run"]);
    let fired = host.call("guarded", timer, json!({}));
    ok(&fired);
    said.extend(notices(&fired.ops));
    settled(&host, "guarded");
    let heard = host.event(Event {
        name: "host_selected".into(),
        payload: json!({ "host": "esx-02" }),
    });
    said.extend(heard.iter().flat_map(|r| notices(&r.ops)));
    settled(&host, "guarded");
    let user = host.call("guarded", command(&loaded.ops, "go"), ARGS());
    ok(&user);
    said.extend(notices(&user.ops));
    let mut want = Vec::new();
    for when in ["load", "timer", "event"] {
        for m in ["mesh.apply", "mesh.cut", "host.check", "discover.start"] {
            want.push(format!("{when} {m}: call refused, request refused"));
        }
        for m in ["mesh.status", "mesh.job"] {
            want.push(format!("{when} {m}: call ok, request ok"));
        }
    }
    for m in methods {
        want.push(format!("user {m}: call ok, request ok"));
    }
    let order = |s: &String| s.clone();
    let (mut said, mut want) = (said, want);
    said.sort_by_key(order);
    want.sort_by_key(order);
    assert_eq!(said, want);
}

#[test]
fn an_inventory_write_waits_for_the_users_call() {
    let serve = Arc::new(Recorded::default());
    let (host, _rx) = listening(&serve, Limits::default());
    let (loaded, _folder) = load(
        &host,
        "write",
        &["inventory.write"],
        r#"
local ok, err = pcall(roster.inventory.update, "esx-02", { ip = "10.0.0.6" })
roster.notify(ok and "load wrote" or tostring(err))
roster.commands.add("go", { run = function()
  roster.inventory.review("esx-02", true)
  roster.notify("user wrote")
end })
"#,
    );
    assert_eq!(
        notices(&loaded.ops),
        ["roster.inventory.update: only while the user runs one of your actions, commands or finder items"]
    );
    assert!(serve.methods().is_empty(), "{:?}", serve.methods());
    let user = host.call("guarded", command(&loaded.ops, "go"), ARGS());
    ok(&user);
    assert_eq!(notices(&user.ops), ["user wrote"]);
    assert_eq!(serve.methods(), ["host.review"]);
}

/// What only the user's call may do, tried in turn: a copy, a question, a command line, a scan.
const USER_THINGS: &str = r#"
local function tried()
  local said = {}
  local function try(name, f, ...)
    local ok = pcall(f, ...)
    said[#said + 1] = name .. (ok and " ok" or " refused")
  end
  try("copy", roster.clipboard.copy, "10.0.0.5")
  try("confirm", roster.confirm, { title = "Sure?", run = function() end })
  try("cmd", roster.cmd, "finder hosts")
  try("scan", roster.serve.request, "discover.start", {}, function() end)
  return table.concat(said, ", ")
end
"#;

#[test]
fn a_finders_items_and_a_checks_lines_are_never_the_users_call() {
    let serve = Arc::new(Recorded::default());
    let (host, _rx) = listening(&serve, Limits::default());
    let init = format!(
        r#"{USER_THINGS}
roster.finders.set("picks", {{ title = "Picks", items = function()
  return {{ {{ id = "a", label = tried(), run = function() roster.notify("item: " .. tried()) end }} }}
end }})
roster.health.set("lab", {{ title = "Lab", check = function()
  return {{ {{ level = "ok", message = tried() }} }}
end }})
roster.commands.add("go", {{ run = function() roster.notify("command: " .. tried()) end }})
"#
    );
    let (loaded, _folder) = load(&host, "app-calls", &["serve:discover.start"], &init);
    let finder = op(&loaded.ops, "finder");
    let items = host.call("guarded", handler(&finder["spec"]["items"]), json!({}));
    ok(&items);
    let refused = "copy refused, confirm refused, cmd refused, scan refused";
    let allowed = "copy ok, confirm ok, cmd ok, scan ok";
    // Listing the finder's items runs as the finder opens, whoever opened it: not the user's choice.
    assert_eq!(items.result[0]["label"], refused);
    assert!(items.ops.is_empty(), "{:?}", items.ops);
    let check = op(&loaded.ops, "health");
    let lines = host.call("guarded", handler(&check["spec"]["check"]), json!({ "health": "lab" }));
    ok(&lines);
    assert_eq!(lines.result[0]["message"], refused);
    // Choosing an item is the user's call, as a command is.
    let item = host.call(
        "guarded",
        handler(&items.result[0]["run"]),
        json!({ "finder": "picks", "item": "a" }),
    );
    ok(&item);
    assert_eq!(notices(&item.ops), [format!("item: {allowed}")]);
    let go = host.call("guarded", command(&loaded.ops, "go"), ARGS());
    assert_eq!(notices(&go.ops), [format!("command: {allowed}")]);
    // The app calling a handler on its own (another Plugin's question took this one's place, so
    // its `cancel` runs) isn't the user's call either, whatever handler it is.
    let unasked = host.call_by_app("guarded", command(&loaded.ops, "go"), ARGS());
    ok(&unasked);
    assert_eq!(notices(&unasked.ops), [format!("command: {refused}")]);
}

#[test]
fn serves_errors_reach_a_plugin_cut_as_its_answers_do() {
    let serve = Arc::new(Recorded::default());
    let (host, rx) = listening(&serve, Limits::default());
    // host.get fails with a message that echoes a Login reference (Recorded's).
    let (loaded, _folder) = load(
        &host,
        "errors",
        &["serve:host.get"],
        r#"
roster.commands.add("go", { run = function()
  local ok, err = pcall(roster.serve.call, "host.get", { name = "esx-02" })
  roster.notify("call: " .. tostring(err))
  roster.serve.request("host.get", { name = "esx-02" }, function(r, why)
    roster.notify("request: " .. tostring(why))
  end)
end })
"#,
    );
    let go = host.call("guarded", command(&loaded.ops, "go"), ARGS());
    ok(&go);
    let mut said = notices(&go.ops);
    said.extend(later(&rx, 1));
    // The reference is cut to its kind; serve's code stays, so a Plugin can still tell why.
    assert_eq!(
        said,
        [
            "call: roster.serve.call host.get: no Login for esx-02: cmd: (code 5)",
            "request: roster.serve.request host.get: no Login for esx-02: cmd: (code 5)",
        ]
    );
}

/// A failed call's UI changes are dropped, so what it did in the core goes too: the functions it
/// replaced still run, its timers and commands aren't kept.
#[test]
fn a_failed_call_leaves_nothing_behind_in_the_core() {
    let serve = Arc::new(Recorded::default());
    // Errors don't disable here: the point is what each one leaves behind.
    let (host, _rx) = listening(
        &serve,
        Limits {
            strikes: 1000,
            ..Limits::default()
        },
    );
    let (loaded, _folder) = load(
        &host,
        "failed",
        &[],
        r#"
roster.sidebar.set("alerts", { title = "Alerts", rows = {}, actions = { { label = "Clear", run = function() roster.notify("cleared") end } } })
roster.commands.add("redo", { run = function()
  roster.sidebar.set("alerts", { title = "Alerts", rows = {}, actions = { { label = "Clear", run = function() end } } })
  roster.commands.add("ghost", { run = function() end })
  roster.defer(1000, function() end)
  error("half done")
end })
roster.commands.add("later", { run = function()
  roster.defer(1000, function() end)
  local ok, err = pcall(roster.cmd, "ghost")
  roster.notify(ok and "ghost ran" or tostring(err))
end })
"#,
    );
    let section = op(&loaded.ops, "section");
    let clear = handler(&section["spec"]["actions"][0]["run"]);
    let redo = command(&loaded.ops, "redo");
    for _ in 0..100 {
        let r = host.call("guarded", redo, ARGS());
        assert!(r.error.is_some() && r.ops.is_empty(), "{r:?}");
    }
    // The section the app still shows is the one before: its button still runs.
    let cleared = host.call("guarded", clear, json!({ "section": "alerts", "action": 1 }));
    ok(&cleared);
    assert_eq!(notices(&cleared.ops), ["cleared"]);
    // The 100 timers the failed calls asked for never reached the app, so they don't count.
    let next = host.call("guarded", command(&loaded.ops, "later"), ARGS());
    ok(&next);
    assert_eq!(op(&next.ops, "timer")["ms"], 1000);
    // Nor is a command a failed call added the Plugin's own.
    assert_eq!(
        notices(&next.ops),
        [
            "roster.cmd: :ghost isn't one a Plugin may run (its own commands, and finder, view, help, find, info, changes, session, next, prev, check, open, connect)"
        ]
    );
}

/// A Plugin naming one of its commands after roster's (the app refuses it) doesn't make roster's
/// its own: `roster.cmd` still holds it to the permission roster's needs, and never runs
/// `:plugins`.
#[test]
fn a_command_named_after_roster_s_isnt_the_plugins_own() {
    let serve = Arc::new(Recorded::default());
    let (host, _rx) = listening(&serve, Limits::default());
    let (loaded, _folder) = load(
        &host,
        "names",
        &[],
        r#"
for _, name in ipairs({ "open", "check", "plugins", "mine" }) do
  roster.commands.add(name, { run = function() end })
end
roster.commands.add("go", { run = function()
  for _, line in ipairs({ "open esx-02", "check esx-02", "plugins grant guarded terminal.write", "mine" }) do
    local ok, err = pcall(roster.cmd, line)
    roster.notify(ok and (line .. ": ran") or tostring(err))
  end
  local ok, err = pcall(roster.cmdline, "plugins grant guarded terminal.write")
  roster.notify(ok and "cmdline: typed" or tostring(err))
end })
"#,
    );
    let go = host.call("guarded", command(&loaded.ops, "go"), ARGS());
    ok(&go);
    let said = notices(&go.ops);
    assert_eq!(
        said[..3],
        [
            "roster.cmd: :open needs the sessions.open permission",
            "roster.cmd: :check needs the serve:host.check permission",
            "roster.cmd: :plugins isn't one a Plugin may run (its own commands, and finder, view, help, find, info, changes, session, next, prev, check, open, connect)",
        ]
    );
    assert_eq!(said[3], "mine: ran");
    assert!(
        said[4].starts_with("roster.cmdline: \"plugins\" isn't one of your commands"),
        "{}",
        said[4]
    );
}

/// Waiting for roster serve isn't the Plugin's time (decision Q103), but one call can't hold serve
/// for ever by asking it again and again: it gets so many calls into serve, then an error.
#[test]
fn one_call_can_ask_roster_serve_only_so_many_times() {
    let serve = Arc::new(Recorded {
        slow: Some(Duration::from_millis(2)),
        ..Recorded::default()
    });
    let (host, _rx) = listening(&serve, Limits::default());
    let (loaded, _folder) = load(
        &host,
        "loop",
        &["serve:mesh.status"],
        r#"
roster.commands.add("poll", { run = function()
  while true do roster.serve.call("mesh.status") end
end })
roster.commands.add("once", { run = function() return roster.serve.call("mesh.status").ok end })
"#,
    );
    let host = Arc::new(host);
    let (tx, rx) = channel();
    {
        let host = Arc::clone(&host);
        let poll = command(&loaded.ops, "poll");
        std::thread::spawn(move || {
            let _ = tx.send(host.call("guarded", poll, ARGS()));
        });
    }
    let r = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("a call asking serve in a loop should end");
    let e = r.error.expect("it ran out of calls into serve").message;
    assert!(
        e.contains("roster.serve.call mesh.status: more than 100 calls into roster serve in one go"),
        "{e}"
    );
    assert!(r.disabled.is_none());
    assert!(serve.methods().len() <= 100, "{}", serve.methods().len());
    // The next call starts again from none.
    let once = host.call("guarded", command(&loaded.ops, "once"), ARGS());
    ok(&once);
    assert_eq!(once.result, true);
}

/// What only the user's call may do, tried in turn, Mesh Cut among them (issue #183).
const USER_ONLY_THINGS: &str = r#"
local function tried()
  local said = {}
  local function try(name, f, ...)
    local ok = pcall(f, ...)
    said[#said + 1] = name .. (ok and " ok" or " refused")
  end
  try("copy", roster.clipboard.copy, "10.0.0.5")
  try("confirm", roster.confirm, { title = "Sure?", run = function() end })
  try("scan", roster.serve.request, "discover.start", {}, function() end)
  try("cut", roster.serve.request, "mesh.cut", {}, function() end)
  return table.concat(said, ", ")
end
"#;

const ALLOWED: &str = "copy ok, confirm ok, scan ok, cut ok";
const REFUSED: &str = "copy refused, confirm refused, scan refused, cut refused";

/// Runs a `cmd` op's line as the app does: the Plugin's own command it names runs as the user's
/// call carried one hop, or as the app's call when the op says it wasn't made in the user's own
/// call (`"user": false`). None when `ops` run none of the Plugin's commands in `own`.
fn follow(host: &PluginHost, loaded: &[Value], ops: &[Value], own: &[&str]) -> Option<Reply> {
    let cmd = ops
        .iter()
        .find(|o| o["op"] == "cmd" && own.contains(&o["line"].as_str().unwrap_or("")))?;
    let run = command(loaded, cmd["line"].as_str().unwrap());
    Some(if cmd["user"] == false {
        host.call_by_app("guarded", run, ARGS())
    } else {
        host.call_carried("guarded", run, ARGS())
    })
}

/// Issue #183: a command `roster.cmd` ran from the user's call is that call carried one hop
/// (Folders' drop runs `folder add` so and answers with `roster.echo`), but a `roster.cmd` made in
/// it isn't, so a Plugin can't keep the user's call alive by chaining its own commands.
#[test]
fn a_chain_of_a_plugins_own_commands_carries_the_users_call_one_hop() {
    let serve = Arc::new(Recorded::default());
    let (host, _rx) = listening(&serve, Limits::default());
    let init = format!(
        r#"{USER_ONLY_THINGS}
local function link(name, next)
  roster.commands.add(name, {{ run = function()
    roster.notify(name .. ": " .. tried())
    local ok, err = pcall(roster.cmd, next)
    if not ok then roster.notify(name .. ": " .. tostring(err)) end
  end }})
end
link("a", "b")
link("b", "c")
link("c", "a")
"#
    );
    let (loaded, _folder) = load(&host, "chain", &["serve:discover.start", "serve:mesh.cut"], &init);
    let mut said = Vec::new();
    let mut r = host.call("guarded", command(&loaded.ops, "a"), ARGS());
    for _ in 0..5 {
        ok(&r);
        said.extend(notices(&r.ops));
        match follow(&host, &loaded.ops, &r.ops, &["a", "b", "c"]) {
            Some(next) => r = next,
            None => break,
        }
    }
    assert_eq!(
        said,
        [
            format!("a: {ALLOWED}"),
            format!("b: {ALLOWED}"),
            format!("c: {REFUSED}"),
            "c: roster.cmd: only while the user runs one of your actions, commands or finder items".to_string(),
        ]
    );
}

/// The replies the Plugin sends on its own, until `want` of them or 3 s.
fn replies(rx: &Receiver<Reply>, want: usize) -> Vec<Reply> {
    let mut out = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    while out.len() < want {
        let Ok(r) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) else {
            break;
        };
        ok(&r);
        out.push(r);
    }
    out
}

/// One hop in all, whichever way: a request's answer carrying the user's call can run a command
/// line, but the Plugin's own command it names isn't the user's call; and a request made in a
/// command `roster.cmd` ran doesn't carry the call to its answer.
#[test]
fn a_request_and_a_command_line_together_carry_the_users_call_one_hop() {
    let serve = Arc::new(Recorded::default());
    let (host, rx) = listening(&serve, Limits::default());
    let init = format!(
        r#"{USER_ONLY_THINGS}
roster.commands.add("ask", {{ run = function()
  roster.serve.request("mesh.status", {{}}, function()
    roster.notify("answer: " .. tried())
    pcall(roster.cmd, "next")
  end)
end }})
roster.commands.add("next", {{ run = function() roster.notify("next: " .. tried()) end }})
"#
    );
    let (loaded, _folder) = load(
        &host,
        "hops",
        &["serve:mesh.status", "serve:discover.start", "serve:mesh.cut"],
        &init,
    );
    let asked = host.call("guarded", command(&loaded.ops, "ask"), ARGS());
    ok(&asked);
    let answered = replies(&rx, 1);
    assert_eq!(notices(&answered[0].ops), [format!("answer: {ALLOWED}")]);
    assert_eq!(
        op(&answered[0].ops, "cmd"),
        &json!({ "op": "cmd", "line": "next", "user": false })
    );
    let next = follow(&host, &loaded.ops, &answered[0].ops, &["next"]).unwrap();
    ok(&next);
    assert_eq!(notices(&next.ops), [format!("next: {REFUSED}")]);
    // Made in the user's own call, the line carries no mark: its command is the call carried.
    let direct = host.call("guarded", command(&loaded.ops, "next"), ARGS());
    assert_eq!(notices(&direct.ops), [format!("next: {ALLOWED}")]);
    // A command roster.cmd ran is the hop: its request's answer isn't the user's call.
    let carried = host.call_carried("guarded", command(&loaded.ops, "ask"), ARGS());
    ok(&carried);
    let answered = replies(&rx, 1);
    assert_eq!(notices(&answered[0].ops), [format!("answer: {REFUSED}")]);
    assert!(
        answered[0].ops.iter().all(|o| o["op"] != "cmd"),
        "{:?}",
        answered[0].ops
    );
}
