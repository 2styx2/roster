//! The user's Plugins inside `:tutor`'s demo (ticket 66, #113, decision Q123). A demo host runs
//! them with the grants they have, but against the demo Inventory the app hands it: roster serve
//! is the demo's stand-in (the Hosts, a made-up `mesh.status`, and a refusal for everything
//! else), the network is never reached, and each Plugin's data folder is a throwaway one, empty
//! at the start and gone with the demo.

mod common;

use roster_core::plugin::{DemoHost, Limits, Permission, Reply, Source};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

fn demo_hosts() -> Value {
    json!({
        "hosts": [
            { "name": "demo-01", "ip": "10.0.0.11", "group": "demo-lab" },
            { "name": "demo-02", "ip": "10.0.0.12", "group": "demo-lab" },
        ],
        "groups": { "demo-lab": { "title": "The demo lab (made up)", "description": "" } },
    })
}

fn plugin_dir(test: &str, permissions: &[&str], init: &str) -> common::Temp {
    let dir = common::temp(&format!("plugin-demo-{test}"));
    let list: Vec<String> = permissions.iter().map(|p| format!("{p:?}")).collect();
    std::fs::write(
        dir.join("roster-plugin.lua"),
        format!(
            "return {{ name = \"teacher\", version = \"1.0.0\", api = 3, permissions = {{ {} }} }}",
            list.join(", ")
        ),
    )
    .unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    dir
}

fn grants(permissions: &[&str]) -> Vec<Permission> {
    permissions.iter().map(|p| Permission::parse(p).unwrap()).collect()
}

fn ok(r: &Reply) {
    assert!(r.error.is_none(), "{:?}", r.error);
    assert!(r.disabled.is_none(), "{:?}", r.disabled);
}

fn notices(ops: &[Value]) -> Vec<String> {
    ops.iter()
        .filter(|op| op["op"] == "notify")
        .map(|op| op["text"].as_str().unwrap().to_string())
        .collect()
}

/// A demo host whose replies nobody asked for come out of the receiver.
fn listening(scratch: &std::path::Path) -> (DemoHost, Receiver<Reply>) {
    let host = DemoHost::new(demo_hosts(), Limits::default(), scratch).unwrap();
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    host.set_listener(std::sync::Arc::new(move |r: Reply| {
        let _ = tx.lock().unwrap().send(r);
    }));
    (host, rx)
}

/// The notices in the replies to come, until `want` of them or 3 s.
fn later_notices(rx: &Receiver<Reply>, want: usize) -> Vec<String> {
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

#[test]
fn inventory_read_sees_the_demo_hosts_and_nothing_else() {
    let perms = ["inventory.read"];
    let dir = plugin_dir(
        "inventory",
        &perms,
        r#"
        local roster = require("roster")
        local names = {}
        for _, h in ipairs(roster.inventory.hosts()) do names[#names + 1] = h.name end
        roster.notify(table.concat(names, ","))
        roster.notify(roster.inventory.host("demo-02").ip)
        roster.notify(tostring(roster.inventory.host("esx-02")))
        roster.notify(roster.inventory.groups()["demo-lab"].title)
        "#,
    );
    let scratch = common::temp("plugin-demo-scratch");
    let host = DemoHost::new(demo_hosts(), Limits::default(), &scratch).unwrap();
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &grants(&perms)).unwrap();
    ok(&reply);
    assert_eq!(
        notices(&reply.ops),
        ["demo-01,demo-02", "10.0.0.12", "nil", "The demo lab (made up)"]
    );
}

#[test]
fn a_serve_method_the_demo_has_no_stand_in_for_is_refused_and_says_why() {
    let perms = ["serve:mesh.job", "serve:hosts.list"];
    let dir = plugin_dir(
        "serve",
        &perms,
        r#"
        local roster = require("roster")
        local ok, err = pcall(roster.serve.call, "mesh.job", {})
        roster.notify(tostring(ok) .. " " .. err)
        roster.notify(#roster.serve.call("hosts.list", {}).hosts .. " Hosts")
        roster.serve.request("mesh.job", {}, function(r, why) roster.notify(tostring(r) .. " " .. why) end)
        "#,
    );
    let scratch = common::temp("plugin-demo-scratch");
    let (host, rx) = listening(&scratch);
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &grants(&perms)).unwrap();
    ok(&reply);
    let said = notices(&reply.ops);
    assert!(said[0].starts_with("false "), "{said:?}");
    assert!(said[0].contains("mesh.job isn't on the demo Inventory"), "{said:?}");
    assert_eq!(said[1], "2 Hosts");
    let later = later_notices(&rx, 1);
    assert_eq!(later.len(), 1, "{later:?}");
    assert!(later[0].starts_with("nil "), "{later:?}");
    assert!(later[0].contains("mesh.job isn't on the demo Inventory"), "{later:?}");
}

#[test]
fn a_network_request_is_never_sent_its_function_hears_why() {
    let perms = ["network:api.example.com"];
    let dir = plugin_dir(
        "network",
        &perms,
        r#"
        local roster = require("roster")
        roster.notify(tostring(roster.has("network:api.example.com")))
        roster.http.get("https://api.example.com/status", function(r, why)
          roster.notify(tostring(r) .. " " .. why)
        end)
        "#,
    );
    let scratch = common::temp("plugin-demo-scratch");
    let (host, rx) = listening(&scratch);
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &grants(&perms)).unwrap();
    ok(&reply);
    // The same permissions: what was granted is still granted.
    assert_eq!(notices(&reply.ops), ["true"]);
    let later = later_notices(&rx, 1);
    assert_eq!(later.len(), 1, "{later:?}");
    assert!(
        later[0].starts_with("nil ") && later[0].contains("the tutorial's demo reaches no network"),
        "{later:?}"
    );
    // Nothing is left waiting (the count drops just after the answer is handed on).
    let deadline = Instant::now() + Duration::from_secs(2);
    while host.requests("teacher") != 0 {
        assert!(
            Instant::now() < deadline,
            "the refused request is still counted as waiting"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn its_files_are_a_throwaway_folder_empty_at_the_start_and_gone_with_the_demo() {
    let dir = plugin_dir(
        "files",
        &[],
        r#"
        local roster = require("roster")
        roster.notify(#roster.storage.list() .. " files")
        roster.storage.write("seen.txt", "demo")
        "#,
    );
    let scratch = common::temp("plugin-demo-scratch");
    let host = DemoHost::new(demo_hosts(), Limits::default(), &scratch).unwrap();
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    ok(&reply);
    assert_eq!(notices(&reply.ops), ["0 files"]);
    let folder = host.data().to_path_buf();
    assert!(folder.starts_with(&*scratch));
    assert_eq!(
        std::fs::read_to_string(folder.join("plugin-data/teacher/seen.txt")).unwrap(),
        "demo"
    );
    // A second demo starts empty again.
    let other = DemoHost::new(demo_hosts(), Limits::default(), &scratch).unwrap();
    assert_ne!(other.data(), folder);
    drop(host);
    assert!(!folder.exists(), "the demo's files outlived it");
}

#[test]
fn an_offline_request_is_checked_as_online_and_the_in_flight_cap_holds() {
    let perms = ["network:api.example.com"];
    let dir = plugin_dir(
        "network-checks",
        &perms,
        r#"
        local roster = require("roster")
        local function try(f) local ok, err = pcall(f); roster.notify(ok and "sent" or err) end
        try(function() roster.http.request({ url = "https://api.example.com/", headers = { Host = "x" } }, function() end) end)
        try(function() roster.http.request({ url = "https://api.example.com/", method = "BREW" }, function() end) end)
        try(function() roster.http.request({ url = "https://api.example.com/", body = string.rep("x", 300000) }, function() end) end)
        try(function() roster.http.request({ url = "https://api.example.com/", timeout = -1 }, function() end) end)
        try(function() roster.http.get("https://you:secret@api.example.com/", function() end) end)
        try(function() roster.http.get("https://elsewhere.example.com/", function() end) end)
        for i = 1, 5 do try(function() roster.http.get("https://api.example.com/" .. i, function() end) end) end
        "#,
    );
    let scratch = common::temp("plugin-demo-scratch");
    let (host, _rx) = listening(&scratch);
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &grants(&perms)).unwrap();
    ok(&reply);
    let said = notices(&reply.ops);
    let want = [
        "the Host header is roster's to set",
        "isn't a method",
        "the body is over",
        "the timeout is a number of seconds above 0",
        "a user or password",
        "isn't a site this Plugin may reach",
        "sent",
        "sent",
        "sent",
        "sent",
        "4 requests are going already",
    ];
    assert_eq!(said.len(), want.len(), "{said:?}");
    for (got, want) in said.iter().zip(want) {
        assert!(got.contains(want), "{got:?} should say {want:?}; all: {said:?}");
    }
}

#[cfg(unix)]
#[test]
fn the_demo_folder_is_the_users_alone() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = common::temp("plugin-demo-scratch");
    let host = DemoHost::new(demo_hosts(), Limits::default(), &scratch).unwrap();
    let mode = std::fs::metadata(host.data()).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);
}

/// A process that has ended: its pid names no one now.
#[cfg(unix)]
fn dead_pid() -> u32 {
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}

#[cfg(unix)]
#[test]
fn a_demo_folder_a_crash_left_behind_is_swept_and_nothing_else() {
    use roster_core::plugin::demo::sweep;
    let scratch = common::temp("plugin-demo-scratch");
    let stale = scratch.join(format!("roster-demo-{}-1-0", dead_pid()));
    std::fs::create_dir_all(stale.join("plugin-data/teacher")).unwrap();
    std::fs::write(stale.join("plugin-data/teacher/seen.txt"), "x").unwrap();
    // A live demo (this process's), a link, and a folder of another name all stay.
    let live = scratch.join(format!("roster-demo-{}-1-0", std::process::id()));
    std::fs::create_dir(&live).unwrap();
    let target = common::temp("plugin-demo-target");
    std::fs::write(target.join("keep.txt"), "x").unwrap();
    let link = scratch.join(format!("roster-demo-{}-2-0", dead_pid()));
    std::os::unix::fs::symlink(&*target, &link).unwrap();
    let other = scratch.join("roster-demo-notes");
    std::fs::create_dir(&other).unwrap();

    sweep(&scratch, Duration::ZERO);

    assert!(!stale.exists(), "the crashed demo's folder stayed");
    assert!(live.exists());
    assert!(link.symlink_metadata().is_ok() && target.join("keep.txt").exists());
    assert!(other.exists());
}

#[cfg(unix)]
#[test]
fn a_young_demo_folder_stays_however_its_pid_looks() {
    use roster_core::plugin::demo::sweep;
    let scratch = common::temp("plugin-demo-scratch");
    let young = scratch.join(format!("roster-demo-{}-1-0", dead_pid()));
    std::fs::create_dir(&young).unwrap();
    sweep(&scratch, Duration::from_secs(600));
    assert!(young.exists());
}

/// The demo slot the Tauri shell keeps: one demo at a time, each with its number.
#[test]
fn a_demo_answers_only_to_its_own_number_and_an_older_start_never_replaces_a_newer_demo() {
    use roster_core::plugin::demo::DemoSlot;
    let scratch = common::temp("plugin-demo-scratch");
    let slot = DemoSlot::default();
    let older = slot.reserve();
    let newer = slot.reserve();
    let new_host = || DemoHost::new(demo_hosts(), Limits::default(), &scratch).unwrap();
    // The newer start finishes first; the older one, finishing after, is turned away.
    slot.install(newer, new_host()).unwrap();
    assert!(slot.install(older, new_host()).is_err());
    assert!(slot.get(newer).is_ok());
    // A call or a stop naming the older demo reaches nothing.
    assert!(slot.get(older).is_err());
    assert!(slot.stop(older).is_none());
    assert!(slot.get(newer).is_ok());
    let gone = slot.stop(newer).unwrap();
    assert!(slot.get(newer).is_err());
    let folder = gone.data().to_path_buf();
    drop(gone);
    assert!(!folder.exists());
}

#[test]
fn a_plugin_in_the_demo_lists_the_demos_sessions() {
    // The demo's manager sends the demo's Session list to the demo's host (issue #239), so a
    // Plugin there reads the demo's Sessions, never the workspace's.
    let perms = ["inventory.read"];
    let dir = plugin_dir(
        "sessions",
        &perms,
        r#"
        local roster = require("roster")
        roster.commands.add("open", { run = function()
          local parts = {}
          for _, s in ipairs(roster.sessions.list()) do parts[#parts + 1] = s.session .. "=" .. (s.host or "quick") end
          roster.notify(#parts == 0 and "none" or table.concat(parts, " "))
        end })
        "#,
    );
    let scratch = common::temp("plugin-demo-scratch");
    let host = DemoHost::new(demo_hosts(), Limits::default(), &scratch).unwrap();
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &grants(&perms)).unwrap();
    ok(&reply);
    let handler = reply
        .ops
        .iter()
        .find(|op| op["op"] == "command")
        .and_then(|op| op["run"]["handler"].as_u64())
        .expect("its command's handler");
    let call = |host: &DemoHost| {
        let r = host.call("teacher", handler, Value::Null);
        ok(&r);
        notices(&r.ops)
    };
    assert_eq!(call(&host), ["none"]);
    host.set_sessions(
        [(1, Some("demo-01".to_string())), (2, None)]
            .into_iter()
            .map(|(session, host)| roster_core::plugin::OpenSession {
                session,
                host,
                cwd: None,
            })
            .collect(),
    );
    assert_eq!(call(&host), ["1=demo-01 2=quick"]);
}

// ------------------------------------------------------------------- mesh.status (#233)

/// The demo's `mesh.status`, as `tests/fixtures/demo-mesh-status.json` says it, worked out by hand
/// from what real serve (`mesh.status` in src/roster/mesh.py) answers for that Mesh.
fn demo_mesh() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/demo-mesh-status.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The keys `mesh.status`'s Result names in docs/serve-api.md (`{links, excluded, ...}`).
fn documented_mesh_status_keys() -> Vec<String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/serve-api.md");
    let docs = std::fs::read_to_string(path).unwrap();
    let row = docs
        .lines()
        .find(|l| l.starts_with("| `mesh.status` |"))
        .expect("mesh.status's row");
    let result = row.split(" | ").nth(2).unwrap();
    let inner = &result[result.find("`{").unwrap() + 2..result.find("}`").unwrap()];
    inner.split(", ").map(str::to_string).collect()
}

fn keys(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    k.sort();
    k
}

#[test]
fn the_demos_mesh_status_answers_in_real_serves_shape_with_one_host_not_answering() {
    use roster_core::plugin::Serve;
    use roster_core::plugin::demo::DemoServe;
    let serve = DemoServe::new(demo_hosts());
    let want = demo_mesh();

    let plain = serve.call("mesh.status", json!({})).unwrap();
    assert_eq!(plain, want["plain"]);
    let mut documented = documented_mesh_status_keys();
    documented.sort();
    assert_eq!(keys(&plain), documented);
    for link in plain["links"].as_array().unwrap() {
        // mesh.status's Links are roster.yml's, untested: no `status`.
        assert_eq!(keys(link), ["from", "kind", "to"]);
    }

    // `grouped: true` (API 19): each meshed group once, and the Links it doesn't cover.
    let grouped = serve.call("mesh.status", json!({ "grouped": true })).unwrap();
    assert_eq!(grouped, want["grouped"]);
    // `brief: true` (API 17): the counts, and only the Links worth a look.
    let brief = serve.call("mesh.status", json!({ "brief": true })).unwrap();
    assert_eq!(brief, want["brief"]);
    assert_eq!(serve.call("mesh.status", Value::Null).unwrap(), want["plain"]);

    // As real serve refuses them.
    for (params, words) in [
        (
            json!({ "grouped": "yes" }),
            "params.grouped must be true or false (code -32602)",
        ),
        (
            json!({ "brief": 1 }),
            "params.brief must be true or false (code -32602)",
        ),
        (
            json!({ "grouped": true, "brief": true }),
            "params.grouped and params.brief don't go together (code -32602)",
        ),
    ] {
        assert_eq!(serve.call("mesh.status", params).unwrap_err().to_string(), words);
    }
    // The rest of the Mesh is still not on the demo.
    let refused = serve.call("mesh.apply", json!({})).unwrap_err().to_string();
    assert_eq!(
        refused,
        "mesh.apply isn't on the demo Inventory: the tutorial's demo answers only hosts.list, host.get and mesh.status (code 3)"
    );
}
