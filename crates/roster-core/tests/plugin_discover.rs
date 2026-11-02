//! Ticket 44 (#72): `plugins/discover`, the first-party Plugin for scanning a network from the app
//! (decisions Q80, Q94 and Q100). It's installed the way a user installs it, as a Package with
//! `dir = "plugins/discover"` from a git repo made from this checkout (no network), and driven
//! through the Plugin host the Tauri shell uses. roster serve is a stand-in that answers the
//! `discover.*` methods as `tests/test_serve_discover.py` shows the real one does: nothing scans.
//!
//! It also records what the real Lua does in one scripted run (`discover.transcript.json` in
//! `app/src/plugins/`): the frontend's tests replay it against the fake Backend's stand-in for this
//! Plugin, so the UI tests test this Plugin's behaviour. `ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p
//! roster-core --test plugin_discover` rewrites it.

mod common;

use roster_core::config::PackageSpec;
use roster_core::package::Packages;
use roster_core::plugin::{Event, Limits, Permission, PluginHost, Reply, Serve, Source, read_manifest};
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const NAME: &str = "discover";
const ALL: &[&str] = &[
    "serve:discover.plan",
    "serve:discover.start",
    "serve:discover.status",
    "serve:discover.stop",
    "serve:discover.add",
];

fn temp(test: &str) -> common::Temp {
    common::temp(&format!("plugin-discover-{test}"))
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
        ])
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// What the stand-in roster serve found: three Hosts on 10.0.0.0/24, one already in the Inventory.
fn found() -> Vec<Value> {
    let port =
        |port: u64, name: &str, product: &str| json!({ "port": port, "name": name, "product": product, "title": "" });
    vec![
        json!({ "address": "10.0.0.5", "name": null, "type": "server", "hostname": "", "title": "", "web": "https://10.0.0.5",
                "known": "esx-02", "added": null, "vendor": "", "os": "", "mac": "",
                "ports": [port(22, "ssh", "OpenSSH 9.6"), port(443, "https", "VMware ESXi")] }),
        json!({ "address": "10.0.0.7", "name": "appliance", "type": "appliance", "hostname": "appliance.lab", "title": "Appliance login",
                "web": "https://10.0.0.7", "known": null, "added": null, "vendor": "", "os": "", "mac": "",
                "ports": [{ "port": 443, "name": "https", "product": "lighttpd", "title": "Appliance login" }] }),
        json!({ "address": "10.0.0.9", "name": "db-10-0-0-9", "type": "db", "hostname": "", "title": "", "web": null,
                "known": null, "added": null, "vendor": "", "os": "", "mac": "",
                "ports": [port(22, "ssh", "OpenSSH 9.6"), port(5432, "postgresql", "")] }),
    ]
}

/// A roster serve that answers `discover.*` as the real one does, from a script: each
/// `discover.status` moves the scan on by half, and the second one finishes it.
#[derive(Default)]
struct FakeServe {
    calls: Mutex<Vec<(String, Value)>>,
    /// Each call and its answer, for the transcript: `[method, params, result]` or `[…, …, null, error]`.
    answers: Mutex<Vec<Value>>,
    polls: Mutex<usize>,
    /// Held while serve is busy with the app's own call (a Publish): every call waits for it.
    busy: Mutex<()>,
}

impl FakeServe {
    fn calls(&self) -> Vec<(String, Value)> {
        self.calls.lock().unwrap().clone()
    }
    fn methods(&self) -> Vec<String> {
        self.calls().into_iter().map(|(m, _)| m).collect()
    }
}

fn status(scan: &str, state: &str, done: u64, found: &[Value], count: usize) -> Value {
    json!({ "scan": scan, "state": state, "targets": ["10.0.0.0/24"], "scanner": "nmap", "done": done, "total": 254,
            "count": count, "quiet": 0, "found": found, "error": null })
}

impl Serve for FakeServe {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        // serve answers one request at a time.
        let _turn = self.busy.lock().unwrap();
        self.calls.lock().unwrap().push((method.to_string(), params.clone()));
        let answer = self.answer(method, &params);
        self.answers.lock().unwrap().push(match &answer {
            Ok(v) => json!([method, params, v]),
            Err(e) => json!([method, params, null, e]),
        });
        answer
    }
}

impl FakeServe {
    fn answer(&self, method: &str, params: &Value) -> Result<Value, String> {
        let targets: Vec<String> = serde_json::from_value(params["targets"].clone()).unwrap_or_default();
        let force = params["force"] == json!(true);
        match method {
            "discover.plan" if targets == ["10.0.0.0/19"] && !force => {
                Err("that's 8,190 addresses; a scan visits at most 4,096 without force (code 121)".into())
            }
            "discover.plan" if targets == ["10.0.0.0/19"] => Ok(
                json!({ "targets": targets, "addresses": 8190, "ports": 47, "scanner": "nmap", "limit": 4096, "max": 65536 }),
            ),
            "discover.plan" => Ok(
                json!({ "targets": targets, "addresses": 254, "ports": 47, "scanner": "nmap", "limit": 4096, "max": 65536 }),
            ),
            "discover.start" => Ok(status("scan-1", "running", 0, &[], 0)),
            "discover.status" => {
                let mut polls = self.polls.lock().unwrap();
                *polls += 1;
                let all = found();
                let since = params["since"].as_u64().unwrap_or(0) as usize;
                Ok(if *polls == 1 {
                    status("scan-1", "running", 128, &all[since.min(2)..2], 2)
                } else {
                    status("scan-1", "done", 254, &all[since.min(3)..], 3)
                })
            }
            "discover.stop" => Ok(json!({ "scan": "scan-1", "stopping": true })),
            "discover.add" => {
                let added: Vec<Value> = params["addresses"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| {
                        let f = found().into_iter().find(|f| &f["address"] == a).unwrap();
                        json!({ "address": a, "name": f["name"] })
                    })
                    .collect();
                Ok(
                    json!({ "group": "discovered-20261031", "added": added, "backup": "/infra/.git/roster/roster.yml.bak" }),
                )
            }
            other => Err(format!("unknown method '{other}' (code -32601)")),
        }
    }
}

fn perms(names: &[&str]) -> Vec<Permission> {
    names.iter().map(|n| Permission::parse(n).unwrap()).collect()
}

/// discover, installed from roster's repo as a user installs it, in a host with the stand-in serve.
struct World {
    host: PluginHost,
    serve: Arc<FakeServe>,
    dir: PathBuf,
    config: Value,
    /// What the Plugin did when its roster serve requests answered (the Tauri shell's
    /// `plugin-reply`).
    replies: Receiver<Reply>,
    /// The ops of each of those answers since the last step, for the transcript.
    answers: RefCell<Vec<Value>>,
    /// The remote, the clone and the data dir; last, so it's deleted after the host has stopped.
    _root: common::Temp,
}

impl World {
    fn new(test: &str, config: Value) -> World {
        let root = temp(test);
        let (bare, work) = (root.join("remote/roster.git"), root.join("work"));
        std::fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--quiet", "--bare", "--initial-branch=main"]);
        copy_dir(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/discover"),
            &work.join("plugins/discover"),
        );
        git(&work, &["init", "--quiet", "--initial-branch=main"]);
        git(&work, &["add", "."]);
        git(&work, &["commit", "--quiet", "-m", "discover"]);
        git(&work, &["push", "--quiet", bare.to_str().unwrap(), "main"]);
        let specs = vec![PackageSpec {
            source: bare.to_str().unwrap().into(),
            name: None,
            tag: None,
            branch: None,
            commit: None,
            dir: Some("plugins/discover".into()),
            config: config.as_object().cloned().unwrap_or_default(),
        }];
        let packages = Packages::new(&root.join("data"), &root.join("config"));
        for s in packages.sync(&specs) {
            assert_eq!(s.error, None);
        }
        packages.pin(&specs, NAME).unwrap();
        let (dir, _) = packages.loadable(&specs, NAME).unwrap();
        let serve = Arc::new(FakeServe::default());
        let host = PluginHost::new(serve.clone(), Limits::default());
        let (tx, replies) = channel();
        let tx = Mutex::new(tx);
        host.set_listener(Arc::new(move |r: Reply| {
            let _ = tx.lock().unwrap().send(r);
        }));
        World {
            host,
            serve,
            dir,
            config,
            replies,
            answers: RefCell::default(),
            _root: root,
        }
    }

    fn load(&self, grants: &[&str]) -> Reply {
        let (_, reply) = self
            .host
            .load_with(&Source::Dir(self.dir.clone()), &perms(grants), &self.config)
            .unwrap();
        self.settled(reply)
    }

    fn call(&self, handler: u64, args: Value) -> Reply {
        let r = self.host.call(NAME, handler, args);
        self.settled(r)
    }

    /// `reply`, with the ops of the answers to the requests it made once every one has come back:
    /// what the user sees after a moment.
    fn settled(&self, mut reply: Reply) -> Reply {
        ok(&reply);
        let started = Instant::now();
        while self.host.requests(NAME) > 0 {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "roster serve's answers didn't come"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        while let Ok(r) = self.replies.try_recv() {
            ok(&r);
            self.answers
                .borrow_mut()
                .push(Value::Array(r.ops.iter().map(normal).collect()));
            reply.ops.extend(r.ops);
        }
        reply
    }

    /// serve's `job.progress` for the scan, as the app hands it to the Plugins (API 20): what
    /// the Plugin did, its answers' ops included.
    fn push(&self, state: &str, done: u64) -> Reply {
        let replies = self.host.event(Event {
            name: "job_progress".into(),
            payload: json!({ "kind": "discover", "job": "scan-1", "action": "scan", "state": state, "done": done,
                             "total": 254, "at": null }),
        });
        let mut own = Reply {
            plugin: NAME.into(),
            result: Value::Null,
            ops: Vec::new(),
            error: None,
            disabled: None,
        };
        for r in replies {
            ok(&r);
            own.ops.extend(r.ops);
        }
        self.settled(own)
    }

    fn pushed(&self, state: &str, done: u64) -> Vec<Value> {
        self.push(state, done).ops
    }

    fn command(&self, loaded: &Reply, args: &str) -> Reply {
        let words: Vec<&str> = args.split_whitespace().collect();
        self.call(command(&loaded.ops), json!({ "args": args, "words": words }))
    }
}

fn ok(r: &Reply) {
    assert!(r.error.is_none(), "{:?}", r.error);
    assert!(r.disabled.is_none(), "{:?}", r.disabled);
}

fn handler(v: &Value) -> u64 {
    v["handler"].as_u64().unwrap_or_else(|| panic!("no handler in {v}"))
}

fn op<'a>(ops: &'a [Value], kind: &str) -> &'a Value {
    ops.iter()
        .rev()
        .find(|o| o["op"] == kind)
        .unwrap_or_else(|| panic!("no {kind} in {ops:#?}"))
}

fn has(ops: &[Value], kind: &str) -> bool {
    ops.iter().any(|o| o["op"] == kind)
}

fn command(ops: &[Value]) -> u64 {
    handler(&ops.iter().find(|o| o["op"] == "command" && o["name"] == NAME).unwrap()["run"])
}

/// The rows every `view` and `view_update` op in `ops` sent, by address, the last one winning.
fn rows(ops: &[Value]) -> Map<String, Value> {
    let mut out = Map::new();
    for o in ops {
        let rows = match o["op"].as_str() {
            Some("view") => &o["spec"]["table"]["rows"],
            Some("view_update") => &o["changes"]["rows"],
            _ => continue,
        };
        for r in rows.as_array().into_iter().flatten() {
            out.insert(r["id"].as_str().unwrap().into(), r.clone());
        }
    }
    out
}

fn text(ops: &[Value]) -> String {
    ops.iter()
        .rev()
        .find_map(|o| match o["op"].as_str() {
            Some("view") => o["spec"]["text"].as_str(),
            Some("view_update") => o["changes"]["text"].as_str(),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no view text in {ops:#?}"))
        .to_string()
}

fn action(loaded: &[Value], label: &str) -> u64 {
    let view = op(loaded, "view");
    let a = view["spec"]["table"]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["label"] == label)
        .unwrap_or_else(|| panic!("no action {label}"));
    handler(&a["run"])
}

/// Scans 10.0.0.0/24 as a user does: `:discover RANGE`, then Scan in the question.
fn scanned(w: &World, loaded: &Reply) -> (Reply, u64) {
    let asked = w.command(loaded, "10.0.0.0/24");
    let confirm = op(&asked.ops, "confirm");
    let started = w.call(handler(&confirm["spec"]["run"]), json!({}));
    let timer = handler(&op(&started.ops, "timer")["run"]);
    (started, timer)
}

#[test]
fn it_installs_from_its_folder_asks_for_the_discover_methods_and_flags_the_scan() {
    let w = World::new("install", json!({}));
    let manifest = read_manifest(&w.dir).unwrap();
    assert_eq!(manifest.name, NAME);
    assert_eq!(manifest.api, 3);
    let asked: Vec<String> = manifest.permissions.iter().map(Permission::to_string).collect();
    assert_eq!(asked, ALL);
    // The install prompt flags the two that act: the scan, and adding to the Inventory.
    let flagged: Vec<String> = manifest
        .permissions
        .iter()
        .filter(|p| p.risk().is_some())
        .map(Permission::to_string)
        .collect();
    assert_eq!(flagged, ["serve:discover.start", "serve:discover.add"]);
    let scan = Permission::parse("serve:discover.start").unwrap();
    assert!(scan.risk().unwrap().contains("scan networks from this computer"));

    let loaded = w.load(ALL);
    let view = op(&loaded.ops, "view");
    assert_eq!(view["id"], NAME);
    assert_eq!(view["spec"]["place"], "full");
    assert!(text(&loaded.ops).contains(":discover 10.0.0.0/24"));
    let toolbar = op(&loaded.ops, "toolbar");
    assert_eq!(toolbar["spec"]["run"], "discover");
    let key = op(&loaded.ops, "key");
    assert_eq!(
        (key["keys"].as_str(), key["action"].as_str()),
        (Some("y d"), Some("discover"))
    );
    assert!(
        op(&loaded.ops, "help")["spec"]["markdown"]
            .as_str()
            .unwrap()
            .contains("unreviewed")
    );
    // Loading asks roster serve nothing: no scan starts on its own.
    assert!(w.serve.calls().is_empty());
}

#[test]
fn it_asks_before_it_scans_and_nothing_starts_until_the_user_says_scan() {
    let w = World::new("asks", json!({}));
    let loaded = w.load(ALL);
    let asked = w.command(&loaded, "10.0.0.0/24");
    assert_eq!(w.serve.methods(), ["discover.plan"]);
    let confirm = &op(&asked.ops, "confirm")["spec"];
    assert_eq!(confirm["title"], "Scan 10.0.0.0/24?");
    assert_eq!(confirm["action"], "Scan");
    assert!(
        confirm["text"]
            .as_str()
            .unwrap()
            .contains("254 addresses on 47 TCP ports")
    );
    assert_eq!(confirm["danger"], false);
    // Cancel is simply never calling `run`: nothing more reached serve.
    assert_eq!(w.serve.methods(), ["discover.plan"]);

    let started = w.call(handler(&confirm["run"]), json!({}));
    assert_eq!(w.serve.methods(), ["discover.plan", "discover.start"]);
    assert_eq!(w.serve.calls()[1].1["targets"], json!(["10.0.0.0/24"]));
    assert!(has(&started.ops, "view_open"));
    let progress = &op(&started.ops, "progress")["spec"];
    assert_eq!(
        (progress["done"].as_u64(), progress["total"].as_u64()),
        (Some(0), Some(254))
    );
    let timer = op(&started.ops, "timer");
    assert_eq!(timer["every"], true);
}

/// serve answers one request at a time, so the app's Publish holds the scan's question behind it:
/// Discover keeps answering, and the question comes once serve does, still part of what the user
/// did (decision Q103).
#[test]
fn behind_a_busy_roster_serve_the_question_comes_when_it_answers() {
    let w = World::new("busy", json!({}));
    let loaded = w.load(ALL);
    let publish = w.serve.busy.lock().unwrap();
    let started = Instant::now();
    let words = json!({ "args": "10.0.0.0/24", "words": ["10.0.0.0/24"] });
    let asked = w.host.call(NAME, command(&loaded.ops), words.clone());
    ok(&asked);
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(!has(&asked.ops, "confirm"));
    let again = w.host.call(NAME, command(&loaded.ops), words);
    ok(&again);
    assert!(
        op(&again.ops, "notify")["text"]
            .as_str()
            .unwrap()
            .contains("Still waiting")
    );
    std::thread::sleep(Duration::from_millis(2600));
    drop(publish);
    let answered = w.settled(asked);
    assert_eq!(op(&answered.ops, "confirm")["spec"]["title"], "Scan 10.0.0.0/24?");
    assert_eq!(w.serve.methods(), ["discover.plan"]);
    assert!(w.host.list()[0].disabled.is_none());
}

#[test]
fn a_range_over_the_limit_asks_in_the_stronger_form_with_the_range_typed() {
    let w = World::new("force", json!({}));
    let loaded = w.load(ALL);
    let asked = w.command(&loaded, "10.0.0.0/19");
    let confirm = &op(&asked.ops, "confirm")["spec"];
    assert_eq!(confirm["danger"], true);
    assert_eq!(confirm["typed"], "10.0.0.0/19");
    w.call(handler(&confirm["run"]), json!({}));
    let (_, start) = w.serve.calls().pop().unwrap();
    assert_eq!(start["force"], true);
}

#[test]
fn results_come_in_as_the_scan_finds_them_and_the_progress_ends_with_it() {
    let w = World::new("poll", json!({}));
    let loaded = w.load(ALL);
    let (_, timer) = scanned(&w, &loaded);
    let first = w.call(timer, json!({}));
    assert_eq!(w.serve.calls().last().unwrap().1["since"], 0);
    let r = rows(&first.ops);
    assert_eq!(r.keys().collect::<Vec<_>>(), ["10.0.0.5", "10.0.0.7"]);
    assert_eq!(r["10.0.0.5"]["tone"], "muted");
    assert_eq!(r["10.0.0.5"]["host"], "esx-02");
    assert_eq!(r["10.0.0.7"]["cells"]["name"], "appliance");
    assert_eq!(r["10.0.0.7"]["cells"]["ports"], "443 https");
    assert_eq!(op(&first.ops, "progress")["spec"]["done"], 128);

    let second = w.call(timer, json!({}));
    assert_eq!(w.serve.calls().last().unwrap().1["since"], 2);
    assert_eq!(rows(&second.ops).keys().collect::<Vec<_>>(), ["10.0.0.9"]);
    assert!(
        second
            .ops
            .iter()
            .any(|o| o["op"] == "remove" && o["kind"] == "progress")
    );
    assert!(second.ops.iter().any(|o| o["op"] == "remove" && o["kind"] == "timer"));
    assert_eq!(op(&second.ops, "notify")["text"], "Scan done: 3 Hosts answered, 2 new");
}

/// serve API 20 pushes the scan's progress (decision Q112f): each push brings a question for the
/// results, the timer goes at the first, and the next scan needs none.
#[test]
fn it_follows_the_scan_by_job_progress_and_stops_polling() {
    let w = World::new("pushed", json!({}));
    let loaded = w.load(ALL);
    let (started, _) = scanned(&w, &loaded);
    assert!(has(&started.ops, "timer"), "no push yet: it polls");
    let before = w.serve.methods().len();
    let first = w.pushed("running", 128);
    assert!(first.iter().any(|o| o["op"] == "remove" && o["kind"] == "timer"));
    assert_eq!(&w.serve.methods()[before..], ["discover.status"]);
    assert_eq!(rows(&first).keys().collect::<Vec<_>>(), ["10.0.0.5", "10.0.0.7"]);
    let end = w.pushed("done", 254);
    assert_eq!(&w.serve.methods()[before..], ["discover.status", "discover.status"]);
    assert_eq!(op(&end, "notify")["text"], "Scan done: 3 Hosts answered, 2 new");
    // Over: another push asks nothing.
    w.pushed("done", 254);
    assert_eq!(w.serve.methods().len(), before + 2);
    // The next scan asks once and sets no timer: serve pushes.
    let asked = w.command(&loaded, "10.0.0.0/24");
    let again = w.call(handler(&op(&asked.ops, "confirm")["spec"]["run"]), json!({}));
    assert!(!has(&again.ops, "timer"));
    assert_eq!(w.serve.methods().last().unwrap(), "discover.status");
}

/// A Mesh job's progress isn't the scan's.
#[test]
fn a_mesh_jobs_progress_isnt_heard() {
    let w = World::new("meshpush", json!({}));
    w.load(ALL);
    let replies = w.host.event(Event {
        name: "job_progress".into(),
        payload: json!({ "kind": "mesh", "job": 1, "action": "apply", "state": "running", "done": 0, "total": 3, "at": null }),
    });
    assert!(replies.is_empty());
}

#[test]
fn stopping_calls_discover_stop() {
    let w = World::new("stop", json!({}));
    let loaded = w.load(ALL);
    let (started, _) = scanned(&w, &loaded);
    let cancel = handler(&op(&started.ops, "progress")["spec"]["cancel"]);
    w.call(cancel, json!({}));
    assert_eq!(w.serve.methods().last().unwrap(), "discover.stop");
}

#[test]
fn kept_hosts_are_added_as_pending_changes_only_after_the_user_confirms() {
    let w = World::new("add", json!({ "group": "found" }));
    let loaded = w.load(ALL);
    let (_, timer) = scanned(&w, &loaded);
    w.call(timer, json!({}));
    w.call(timer, json!({}));
    let keep = action(&loaded.ops, "Keep");
    let kept = w.call(keep, json!({ "row": "10.0.0.9", "view": NAME }));
    assert_eq!(rows(&kept.ops)["10.0.0.9"]["cells"]["pick"], "yes");
    // A Host already in the Inventory can't be kept.
    let none = w.call(keep, json!({ "row": "10.0.0.5", "view": NAME }));
    assert!(rows(&none.ops).is_empty());

    let asked = w.call(
        action(&loaded.ops, "Add the kept Hosts"),
        json!({ "row": "10.0.0.9", "view": NAME }),
    );
    assert!(!w.serve.methods().contains(&"discover.add".to_string()));
    let confirm = &op(&asked.ops, "confirm")["spec"];
    assert_eq!(confirm["title"], "Add 1 Host to the Inventory?");
    let added = w.call(handler(&confirm["run"]), json!({}));
    let (method, params) = w.serve.calls().pop().unwrap();
    assert_eq!(method, "discover.add");
    assert_eq!(
        params,
        json!({ "scan": "scan-1", "addresses": ["10.0.0.9"], "group": "found" })
    );
    let row = &rows(&added.ops)["10.0.0.9"];
    assert_eq!(row["cells"]["status"], "added as db-10-0-0-9");
    assert_eq!(row["host"], "db-10-0-0-9");
    assert!(
        op(&added.ops, "notify")["text"]
            .as_str()
            .unwrap()
            .contains("as Pending changes")
    );
}

#[test]
fn without_its_permissions_it_loads_and_says_what_it_needs() {
    let w = World::new("bare", json!({}));
    let loaded = w.load(&[]);
    assert!(text(&loaded.ops).contains("Allow them in :plugins"));
    let asked = w.command(&loaded, "10.0.0.0/24");
    assert!(
        op(&asked.ops, "notify")["text"]
            .as_str()
            .unwrap()
            .contains("serve:discover.plan")
    );
    assert!(w.serve.calls().is_empty());

    // Scanning without the right to add: the scan works, adding says what's missing.
    let w = World::new("noadd", json!({}));
    let loaded = w.load(&ALL[..4]);
    let (_, timer) = scanned(&w, &loaded);
    w.call(timer, json!({}));
    w.call(action(&loaded.ops, "Keep"), json!({ "row": "10.0.0.7", "view": NAME }));
    let r = w.call(
        action(&loaded.ops, "Add the kept Hosts"),
        json!({ "row": "10.0.0.7", "view": NAME }),
    );
    assert!(
        op(&r.ops, "notify")["text"]
            .as_str()
            .unwrap()
            .contains("serve:discover.add")
    );
}

#[test]
fn bad_settings_are_named_and_the_defaults_used() {
    let w = World::new(
        "settings",
        json!({ "leader": " x", "ranges": "10.0.0.0/24", "ports": "ssh" }),
    );
    let loaded = w.load(ALL);
    let notices: Vec<&str> = loaded
        .ops
        .iter()
        .filter(|o| o["op"] == "notify")
        .map(|o| o["text"].as_str().unwrap())
        .collect();
    assert_eq!(notices.len(), 3, "{notices:?}");
    assert_eq!(op(&loaded.ops, "key")["keys"], "y d");
}

#[test]
fn leader_false_binds_no_key_as_mesh_does() {
    let w = World::new("no-leader", json!({ "leader": false }));
    let loaded = w.load(ALL);
    assert!(!loaded.ops.iter().any(|o| o["op"] == "notify"), "{:?}", loaded.ops);
    assert!(!loaded.ops.iter().any(|o| o["op"] == "key"));
    let help = op(&loaded.ops, "help")["spec"]["markdown"].as_str().unwrap();
    assert!(!help.contains("false"), "{help}");
    assert!(help.contains("the toolbar's **Scan**"), "{help}");
}

#[test]
fn configured_ranges_are_what_discover_alone_offers_to_scan() {
    let w = World::new("ranges", json!({ "ranges": ["10.0.0.0/24"] }));
    let loaded = w.load(ALL);
    let asked = w.command(&loaded, "");
    assert_eq!(op(&asked.ops, "confirm")["spec"]["title"], "Scan 10.0.0.0/24?");
}

#[test]
fn check_says_whether_this_boxs_roster_can_scan_and_connects_nowhere() {
    let w = World::new("health", json!({}));
    let loaded = w.load(&ALL[..4]);
    let check = handler(&op(&loaded.ops, "health")["spec"]["check"]);
    // It answers later (decision Q112h): it never waits for serve on its own thread.
    let r = w.call(check, json!({ "health": NAME, "check": 7 }));
    assert_eq!(r.result, "later");
    let answer = op(&r.ops, "health_answer");
    assert_eq!(answer["check"], 7);
    let lines = &answer["checks"];
    assert_eq!(lines[0]["level"], "ok");
    assert_eq!(lines[0]["message"], "roster serve can scan, with nmap");
    assert_eq!(lines[1]["level"], "warn");
    assert!(lines[1]["message"].as_str().unwrap().contains("serve:discover.add"));
    // discover.plan only: it says how many addresses, and scans nothing.
    assert_eq!(w.serve.methods(), ["discover.plan"]);
}

/// The core keeps the scan and the add to calls the user started, whatever a Plugin tries.
#[test]
fn a_plugin_cant_scan_or_add_on_its_own() {
    let dir = temp("own");
    std::fs::write(
        dir.join("roster-plugin.lua"),
        "return { name = \"sneaky\", version = \"1\", api = 2, permissions = { \"serve:discover.start\", \"serve:discover.add\", \"serve:discover.status\" } }",
    )
    .unwrap();
    std::fs::write(
        dir.join("init.lua"),
        r#"
local ok, err = pcall(roster.serve.call, "discover.start", { targets = { "10.0.0.0/24" } })
assert(not ok and err:find("only while the user runs", 1, true), tostring(err))
ok, err = pcall(roster.serve.call, "discover.add", { scan = "scan-1", addresses = { "10.0.0.7" } })
assert(not ok and err:find("only while the user runs", 1, true), tostring(err))
-- Reading how a scan goes is fine anywhere.
assert(roster.serve.call("discover.status", {}).state == "running")
roster.defer(50, function()
  local ok2 = pcall(roster.serve.call, "discover.start", { targets = { "10.0.0.0/24" } })
  roster.notify(ok2 and "started" or "refused")
end)
roster.commands.add("go", { run = function() roster.serve.call("discover.start", { targets = { "10.0.0.0/24" } }) end })
"#,
    )
    .unwrap();
    let serve = Arc::new(FakeServe::default());
    let host = PluginHost::new(serve.clone(), Limits::default());
    let grants = perms(&["serve:discover.start", "serve:discover.add", "serve:discover.status"]);
    let (_, loaded) = host.load(&Source::Dir(dir.to_path_buf()), &grants).unwrap();
    ok(&loaded);
    assert_eq!(serve.methods(), ["discover.status"]);
    let timer = handler(&op(&loaded.ops, "timer")["run"]);
    let fired = host.call("sneaky", timer, json!({}));
    assert_eq!(op(&fired.ops, "notify")["text"], "refused");
    let go = handler(&loaded.ops.iter().find(|o| o["op"] == "command").unwrap()["run"]);
    ok(&host.call("sneaky", go, json!({ "args": "", "words": [] })));
    assert_eq!(serve.methods(), ["discover.status", "discover.start"]);
}

// ------------------------------------------------------------------- transcript

/// One step of the scripted run the frontend's stand-in replays.
fn steps() -> Value {
    json!([
        { "do": "load", "grants": ALL, "config": { "group": "found" } },
        { "do": "command", "args": "10.0.0.0/24" },
        { "do": "confirm" },
        { "do": "timer" },
        { "do": "timer" },
        { "do": "action", "label": "Details", "row": "10.0.0.7" },
        { "do": "action", "label": "Keep", "row": "10.0.0.9" },
        { "do": "action", "label": "Keep", "row": "10.0.0.7" },
        { "do": "action", "label": "Don't keep", "row": "10.0.0.7" },
        { "do": "command", "args": "keep all" },
        { "do": "action", "label": "Add the kept Hosts", "row": "10.0.0.9" },
        { "do": "confirm" },
        { "do": "command", "args": "10.0.0.0/19" },
        { "do": "command", "args": "stop" },
        { "do": "command", "args": "10.0.0.0/24" },
        { "do": "confirm" },
        { "do": "push", "state": "running", "done": 128 },
        { "do": "push", "state": "done", "done": 254 },
        { "do": "load", "grants": [], "config": {} },
        { "do": "command", "args": "10.0.0.0/24" }
    ])
}

/// Ops as the transcript keeps them: each function as `"fn"`, a timer's id as `"N"`, an empty
/// table as an empty list (Lua can't tell them apart).
fn normal(v: &Value) -> Value {
    match v {
        Value::Object(m) if m.len() == 1 && m.contains_key("handler") => json!("fn"),
        Value::Object(m) if m.is_empty() => json!([]),
        Value::Object(m) => {
            let timer = m.get("op") == Some(&json!("timer"))
                || (m.get("op") == Some(&json!("remove")) && m.get("kind") == Some(&json!("timer")));
            Value::Object(
                m.iter()
                    .map(|(k, v)| (k.clone(), if timer && k == "id" { json!("N") } else { normal(v) }))
                    .collect(),
            )
        }
        Value::Array(a) => Value::Array(a.iter().map(normal).collect()),
        other => other.clone(),
    }
}

#[test]
fn the_transcript_the_frontend_replays_is_what_the_real_lua_does() {
    let mut w = World::new("transcript", json!({}));
    let mut loaded: Option<Reply> = None;
    let mut confirm: Option<u64> = None;
    let mut timer: Option<u64> = None;
    let mut out = Vec::new();
    for step in steps().as_array().unwrap() {
        w.answers.borrow_mut().clear();
        let reply = match step["do"].as_str().unwrap() {
            "load" => {
                let grants: Vec<&str> = step["grants"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|g| g.as_str().unwrap())
                    .collect();
                w.config = step["config"].clone();
                let r = w.load(&grants);
                loaded = Some(r.clone());
                r
            }
            "command" => w.command(loaded.as_ref().unwrap(), step["args"].as_str().unwrap()),
            "confirm" => w.call(confirm.take().expect("a question"), json!({})),
            "timer" => w.call(timer.expect("a timer"), json!({})),
            "push" => w.push(step["state"].as_str().unwrap(), step["done"].as_u64().unwrap()),
            "action" => {
                let h = action(&loaded.as_ref().unwrap().ops, step["label"].as_str().unwrap());
                w.call(h, json!({ "row": step["row"], "view": NAME }))
            }
            other => panic!("no step {other}"),
        };
        for o in &reply.ops {
            match o["op"].as_str().unwrap() {
                "confirm" => confirm = Some(handler(&o["spec"]["run"])),
                "timer" => timer = Some(handler(&o["run"])),
                _ => {}
            }
        }
        // The call's own ops, then each answer's: the stand-in replays both, in order.
        let answers = std::mem::take(&mut *w.answers.borrow_mut());
        let own = reply.ops.len() - answers.iter().map(|a| a.as_array().unwrap().len()).sum::<usize>();
        let mut step = step.clone();
        step["ops"] = Value::Array(reply.ops[..own].iter().map(normal).collect());
        step["answers"] = Value::Array(answers);
        out.push(step);
    }
    let calls = w.serve.answers.lock().unwrap().clone();
    let transcript = serde_json::to_string_pretty(&json!({
        "about": "What plugins/discover does in a scripted run against a stand-in roster serve, recorded by crates/roster-core/tests/plugin_discover.rs (ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p roster-core --test plugin_discover rewrites it). The fake Backend's stand-in replays it (discover.test.ts).",
        "steps": out,
        "serve": calls,
    }))
    .unwrap()
        + "\n";
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/src/plugins/discover.transcript.json");
    if std::env::var_os("ROSTER_UPDATE_TRANSCRIPT").is_some() {
        std::fs::write(&path, &transcript).unwrap();
    }
    let recorded = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        recorded == transcript,
        "{} is out of date: run ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p roster-core --test plugin_discover, and update the fake Backend's stand-in to match",
        path.display()
    );
    let _ = &mut w;
}
