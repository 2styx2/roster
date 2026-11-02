//! The user's Plugins inside `:tutor`'s demo (ticket 66, #113, decision Q123). A demo host runs
//! them with the grants they have, but against the demo Inventory the app hands it: roster serve
//! is the demo's stand-in (the Hosts, and a refusal for everything else), the network is never
//! reached, and each Plugin's data folder is a throwaway one, empty at the start and gone with the
//! demo.

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
    let perms = ["serve:mesh.status", "serve:hosts.list"];
    let dir = plugin_dir(
        "serve",
        &perms,
        r#"
        local roster = require("roster")
        local ok, err = pcall(roster.serve.call, "mesh.status", {})
        roster.notify(tostring(ok) .. " " .. err)
        roster.notify(#roster.serve.call("hosts.list", {}).hosts .. " Hosts")
        roster.serve.request("mesh.status", {}, function(r, why) roster.notify(tostring(r) .. " " .. why) end)
        "#,
    );
    let scratch = common::temp("plugin-demo-scratch");
    let (host, rx) = listening(&scratch);
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &grants(&perms)).unwrap();
    ok(&reply);
    let said = notices(&reply.ops);
    assert!(said[0].starts_with("false "), "{said:?}");
    assert!(said[0].contains("mesh.status isn't on the demo Inventory"), "{said:?}");
    assert_eq!(said[1], "2 Hosts");
    let later = later_notices(&rx, 1);
    assert_eq!(later.len(), 1, "{later:?}");
    assert!(later[0].starts_with("nil "), "{later:?}");
    assert!(
        later[0].contains("mesh.status isn't on the demo Inventory"),
        "{later:?}"
    );
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
