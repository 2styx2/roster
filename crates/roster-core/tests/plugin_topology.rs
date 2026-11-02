//! Ticket 40 (#52): `plugins/topology`, the Topology view, a first-party Plugin (decision Q94),
//! end to end. The test installs it the way a user does, as a Package with `dir = "plugins/topology"`
//! from a git repo made from this checkout (a local bare repo, so nothing touches the network), and
//! drives it through the Plugin host the Tauri shell uses, against a stand-in `roster serve` with a
//! made-up Inventory and Mesh: the map it draws, Sessions turning nodes live, Check and Cut from a
//! node, `:topology GROUP`, what it does without its permissions, what it can't reach, and 2,000
//! Hosts in a Mesh of 98,000 Links.
//!
//! It also records what the real Lua does in one scripted run (`topology.transcript.json` in
//! `app/src/plugins/`, with the serve answers it was given): the frontend's tests replay the same
//! steps against the fake Backend's stand-in for this Plugin and check it does the same.
//! `ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p roster-core --test plugin_topology` rewrites the file.

mod common;

use roster_core::config::PackageSpec;
use roster_core::package::Packages;
use roster_core::plugin::{Event, Limits, Permission, PluginHost, Reply, Serve, Source, read_manifest};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const NAME: &str = "topology";
const ALL: &[&str] = &[
    "inventory.read",
    "serve:mesh.status",
    "serve:host.check",
    "serve:mesh.cut",
    "serve:mesh.job",
    "serve:host.check_job",
];

fn plugins_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins")
}

fn temp(test: &str) -> common::Temp {
    common::temp(&format!("topology-{test}"))
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

// ------------------------------------------------------------------- a made-up network

fn host(name: &str, group: &str, ip: &str, extra: Value) -> Value {
    let mut h = json!({
        "name": name, "group": group, "ip": ip,
        "ssh": { "user": "root", "port": 22, "auth": "agent" },
        "login": {}, "services": {}, "problems": [],
        "enroll": true, "reviewed": true, "title": "", "description": "", "type": "linux",
        "product": "", "mac": "", "notes": "", "user": "root", "port": 22, "auth": "agent",
    });
    for (k, v) in extra.as_object().unwrap() {
        h[k] = v.clone();
    }
    h
}

/// `hosts.list`: a meshed lab with a password peer and a Host out of the Mesh, storage it Links to,
/// web with a jump Host, and a group `discover` added that no one has reviewed.
fn inventory() -> Value {
    let password = json!({ "enroll": false, "ssh": { "user": "admin", "port": 22, "auth": "bw:appliance ssh" }, "auth": "bw:appliance ssh", "type": "appliance" });
    json!({
        "hosts": [
            host("esx-01", "lab", "10.0.0.5", json!({ "type": "esxi", "mesh": true })),
            host("esx-02", "lab", "10.0.0.6", json!({ "type": "esxi", "mesh": true })),
            host("appliance", "lab", "10.0.0.7", { let mut p = password.clone(); p["mesh"] = json!(true); p }),
            host("lab-old", "lab", "10.0.0.8", json!({ "mesh": false })),
            host("nas-01", "storage", "10.0.1.5", json!({ "type": "nas" })),
            host("nas-02", "storage", "10.0.1.6", json!({ "type": "nas" })),
            host("web-1", "web", "10.0.2.5", json!({})),
            host("jump-1", "web", "10.0.2.9", json!({})),
            host("new-01", "new", "10.0.3.5", json!({ "reviewed": false })),
        ],
        "groups": {
            "lab": { "title": "", "description": "" },
            "storage": { "title": "", "description": "" },
            "web": { "title": "", "description": "" },
            "new": { "title": "", "description": "" },
        },
        "error": null,
    })
}

fn link(from: &str, to: &str, kind: &str) -> Value {
    json!({ "from": from, "to": to, "kind": kind })
}

/// `mesh.status` for it: lab meshed, `{ from: lab, to: storage }`, `{ from: nas-01, to: web-1,
/// both: true }`, nas-02 to web-1 through jump-1 (with its Link to jump-1), esx-01 to web-1 through
/// jump-1 without one (no-via), a cut of lab-old not finished, and nas-02 pending.
fn mesh_status() -> Value {
    let mut skip_a = link("appliance", "esx-01", "key");
    skip_a["skip"] = json!("password-source");
    let mut skip_b = link("appliance", "esx-02", "key");
    skip_b["skip"] = json!("password-source");
    let mut via_ok = link("nas-02", "web-1", "key");
    via_ok["via"] = json!("jump-1");
    let mut via_bad = link("esx-01", "web-1", "key");
    via_bad["via"] = json!("jump-1");
    json!({
        "links": [
            skip_a, skip_b,
            link("esx-01", "appliance", "password"),
            link("esx-01", "esx-02", "key"),
            link("esx-01", "nas-01", "key"),
            link("esx-01", "nas-02", "key"),
            via_bad,
            link("esx-02", "appliance", "password"),
            link("esx-02", "esx-01", "key"),
            link("esx-02", "nas-01", "key"),
            link("esx-02", "nas-02", "key"),
            link("nas-01", "web-1", "key"),
            link("nas-02", "jump-1", "key"),
            via_ok,
            link("web-1", "nas-01", "key"),
        ],
        "excluded": { "lab-old": "mesh: false" },
        "reach": { "esx-01": 5, "esx-02": 4, "nas-01": 1, "nas-02": 2, "web-1": 1 },
        "members": ["appliance", "esx-01", "esx-02", "jump-1", "nas-01", "nas-02", "web-1"],
        "pending": { "nas-02": "timed out" },
        "cut_pending": { "lab-old": ["esx-01"] },
        "out_of_date": true,
    })
}

/// `mesh.status { grouped = true }` (serve API 19) for the same network: lab's Mesh once, and the
/// Links it doesn't cover.
fn mesh_grouped() -> Value {
    let mut m = mesh_status();
    let lab = ["esx-01", "esx-02", "appliance"];
    let links: Vec<Value> = m["links"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|l| {
            l.get("via").is_some()
                || !(lab.contains(&l["from"].as_str().unwrap()) && lab.contains(&l["to"].as_str().unwrap()))
        })
        .cloned()
        .collect();
    m["links"] = json!(links);
    m["meshed"] = json!({ "lab": lab });
    m
}

fn mesh_cut(name: &str) -> Value {
    json!({ "host": name, "confirmed": ["esx-02", "nas-01"], "pending": { "nas-02": "timed out" }, "change": { "written": true, "backup": "x" } })
}

/// A `roster serve` that answers from the made-up network and records every call.
struct FakeServe {
    calls: Mutex<Vec<(String, Value)>>,
    hosts: Value,
    mesh: Mutex<Value>,
    /// What `mesh.status { grouped = true }` answers; Null: a serve before API 19, which ignores it.
    grouped: Value,
    /// A `host.check_job` it answers 300 ms late, so a later one answers first.
    slow_check: Mutex<Option<String>>,
}

impl FakeServe {
    fn new(hosts: Value, mesh: Value) -> FakeServe {
        FakeServe {
            calls: Mutex::new(Vec::new()),
            hosts,
            mesh: Mutex::new(mesh),
            grouped: Value::Null,
            slow_check: Mutex::new(None),
        }
    }
    fn grouped(mut self, grouped: Value) -> FakeServe {
        self.grouped = grouped;
        self
    }
    fn called(&self, method: &str) -> Vec<Value> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == method)
            .map(|(_, p)| p.clone())
            .collect()
    }
}

impl Serve for FakeServe {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.calls.lock().unwrap().push((method.to_string(), params.clone()));
        match method {
            "hosts.list" => Ok(self.hosts.clone()),
            "mesh.status" if params["grouped"] == true && !self.grouped.is_null() => Ok(self.grouped.clone()),
            "mesh.status" => Ok(self.mesh.lock().unwrap().clone()),
            // A check's result once it's over (serve API 21): nas-01's failed at tcp, the rest passed.
            // check-3 failed nas-01 at tcp, check-5 passed it later; any other passed web-1.
            "host.check_job" => {
                let job = params["job"].as_str().unwrap_or("");
                if self.slow_check.lock().unwrap().as_deref() == Some(job) {
                    std::thread::sleep(Duration::from_millis(300));
                }
                let host = if job == "check-3" || job == "check-5" {
                    "nas-01"
                } else {
                    "web-1"
                };
                let ok = job != "check-3";
                let steps = json!([
                    { "step": "dns", "status": "ok", "message": "resolves" },
                    { "step": "tcp", "status": if ok { "ok" } else { "fail" }, "message": "port 22" },
                    { "step": "auth", "status": if ok { "ok" } else { "skipped" }, "message": "" }
                ]);
                Ok(
                    json!({ "kind": "check", "job": params["job"], "action": "check", "state": "done", "done": 8, "total": 8, "host": host,
                           "result": { "host": host, "ok": ok, "steps": steps } }),
                )
            }
            "mesh.cut" if params["background"] == true => {
                Ok(json!({ "job": 7, "action": "cut", "total": 3, "host": params["host"] }))
            }
            "mesh.cut" => Ok(mesh_cut(params["host"].as_str().unwrap_or(""))),
            "mesh.job" => Ok(
                json!({ "job": 7, "action": "cut", "host": "esx-01", "state": "done", "done": 3, "total": 3, "at": null, "stopped": false, "result": mesh_cut("esx-01") }),
            ),
            _ => Err(format!("unknown method {method}")),
        }
    }
}

/// The app's own limits, unscaled: Lua is built optimised in test builds too (the workspace's
/// `Cargo.toml`), so a test times the interpreter the app runs (2,000 Hosts: its longest call is
/// about half the budget in a test build, a quarter in a release one).
fn limits() -> Limits {
    Limits::default()
}

fn perms(names: &[&str]) -> Vec<Permission> {
    names.iter().map(|n| Permission::parse(n).unwrap()).collect()
}

/// Topology installed as a user installs it, from `dir = "plugins/topology"`.
struct World {
    dir: PathBuf,
    host: PluginHost,
    serve: Arc<FakeServe>,
    /// What the Plugin did when its roster serve requests answered (the Tauri shell's
    /// `plugin-reply`).
    replies: Mutex<Receiver<Reply>>,
    /// The remote, the clone and the data dir; last, so it's deleted after the host has stopped.
    _root: common::Temp,
}

impl World {
    fn with(test: &str, serve: FakeServe) -> World {
        let root = temp(test);
        let (bare, work) = (root.join("remote/roster.git"), root.join("work"));
        std::fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--quiet", "--bare", "--initial-branch=main"]);
        copy_dir(&plugins_dir(), &work.join("plugins"));
        git(&work, &["init", "--quiet", "--initial-branch=main"]);
        git(&work, &["add", "."]);
        git(&work, &["commit", "--quiet", "-m", "first-party Plugins"]);
        git(&work, &["push", "--quiet", bare.to_str().unwrap(), "main"]);
        let specs = vec![PackageSpec {
            source: bare.to_str().unwrap().into(),
            name: None,
            tag: None,
            branch: None,
            commit: None,
            dir: Some("plugins/topology".into()),
            config: Map::new(),
        }];
        let packages = Packages::new(&root.join("data"), &root.join("config"));
        assert_eq!(packages.sync(&specs)[0].error, None);
        packages.pin(&specs, NAME).unwrap();
        let (dir, _) = packages.loadable(&specs, NAME).unwrap();
        let serve = Arc::new(serve);
        let host = PluginHost::new(serve.clone(), limits());
        let (tx, replies) = channel();
        let tx = Mutex::new(tx);
        host.set_listener(Arc::new(move |r: Reply| {
            let _ = tx.lock().unwrap().send(r);
        }));
        World {
            dir,
            host,
            serve,
            replies: Mutex::new(replies),
            _root: root,
        }
    }

    fn new(test: &str) -> World {
        World::with(test, FakeServe::new(inventory(), mesh_status()).grouped(mesh_grouped()))
    }

    fn load(&self, grants: &[&str]) -> Reply {
        self.load_with(grants, json!({}))
    }

    /// Loads it and, as the app's clock would 50 ms later, runs its deferred first look: one reply
    /// with the ops of both.
    fn load_with(&self, grants: &[&str], config: Value) -> Reply {
        let before = self.serve.calls.lock().unwrap().len();
        let (_, mut reply) = self
            .host
            .load_with(&Source::Dir(self.dir.clone()), &perms(grants), &config)
            .unwrap();
        ok(&reply);
        let first = reply
            .ops
            .iter()
            .find(|o| o["op"] == "timer" && o["every"] == false)
            .map(|t| handler(&t["run"]))
            .expect("a deferred first look");
        assert!(
            find(&reply.ops, "view").is_empty() && self.serve.calls.lock().unwrap().len() == before,
            "it called serve while it loaded"
        );
        let later = self.call(first, json!({}));
        ok(&later);
        reply.ops.extend(later.ops);
        reply
    }

    /// `reply`, with what the answers to the requests it made did once every one came back: what
    /// the user sees after a moment.
    fn settle(&self, mut reply: Reply) -> Reply {
        let started = Instant::now();
        while self.host.requests(NAME) > 0 {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "roster serve's answers didn't come"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        // An answer's reply can reach the listener just after the count drops: wait a moment.
        while let Ok(r) = self.replies.lock().unwrap().recv_timeout(Duration::from_millis(50)) {
            ok(&r);
            reply.ops.extend(r.ops);
        }
        reply
    }

    fn call(&self, handler: u64, args: Value) -> Reply {
        self.settle(self.host.call(NAME, handler, args))
    }

    /// What the Plugin did with an event, its answers included: a reply of its own when it only
    /// asked serve (a job's end), since the host returns only replies with ops.
    fn event(&self, name: &str, payload: Value) -> Vec<Reply> {
        let mut replies: Vec<Reply> = self
            .host
            .event(Event {
                name: name.into(),
                payload,
            })
            .into_iter()
            .map(|r| self.settle(r))
            .collect();
        if replies.is_empty() {
            let r = self.settle(Reply {
                plugin: NAME.into(),
                result: Value::Null,
                ops: Vec::new(),
                error: None,
                disabled: None,
            });
            if !r.ops.is_empty() {
                replies.push(r);
            }
        }
        replies
    }
}

fn find<'a>(ops: &'a [Value], op: &str) -> Vec<&'a Value> {
    ops.iter().filter(|o| o["op"] == op).collect()
}

fn one<'a>(ops: &'a [Value], op: &str) -> &'a Value {
    let found = find(ops, op);
    assert_eq!(found.len(), 1, "one {op} op in {ops:#?}");
    found[0]
}

fn handler(v: &Value) -> u64 {
    v["handler"].as_u64().unwrap_or_else(|| panic!("no handler in {v}"))
}

fn ok(reply: &Reply) {
    assert!(reply.error.is_none(), "{:?}", reply.error);
}

fn view(reply: &Reply) -> &Value {
    let v = one(&reply.ops, "view");
    assert_eq!(v["id"], "topology");
    &v["spec"]
}

fn by_id<'a>(list: &'a Value, id: &str) -> &'a Value {
    list.as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == id)
        .unwrap_or_else(|| panic!("no {id} in {list:#}"))
}

fn ids(list: &Value) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap().to_string())
        .collect()
}

fn action(spec: &Value, label: &str) -> u64 {
    spec["graph"]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["label"] == label)
        .map(|a| handler(&a["run"]))
        .unwrap_or_else(|| panic!("no action {label}"))
}

fn on(node: &str) -> Value {
    json!({ "view": "topology", "node": node, "host": node })
}

// ------------------------------------------------------------------- install and the map

#[test]
fn it_installs_from_its_folder_asking_for_what_its_readme_explains() {
    let w = World::new("manifest");
    let manifest = read_manifest(&w.dir).unwrap();
    assert_eq!(manifest.name, NAME);
    assert_eq!(manifest.api, 4);
    let asked: Vec<String> = manifest.permissions.iter().map(|p| p.to_string()).collect();
    assert_eq!(asked, ALL);
    let readme = std::fs::read_to_string(plugins_dir().join("topology/README.md")).unwrap();
    for p in ALL {
        assert!(readme.contains(&format!("**`{p}`**")), "README.md doesn't explain {p}");
    }
    assert!(readme.contains("dir = \"plugins/topology\""));
}

#[test]
fn it_draws_this_box_and_every_host_by_group_with_the_mesh_as_clusters_and_few_edges() {
    let w = World::new("map");
    let reply = w.load(ALL);
    ok(&reply);
    let spec = view(&reply);
    assert_eq!(spec["title"], "Topology");
    assert_eq!(spec["place"], "full");
    let g = &spec["graph"];
    assert_eq!(g["reach"], "all");
    // A group the Mesh touches is split by what its Hosts are in it.
    assert_eq!(
        ids(&g["clusters"]),
        [
            ":group:lab",
            ":group:lab/peers",
            ":group:lab/out",
            ":group:storage",
            ":group:web",
            ":group:new"
        ]
    );
    assert_eq!(by_id(&g["clusters"], ":group:lab")["mesh"], true);
    // A group's title, or its name when it has none.
    assert_eq!(by_id(&g["clusters"], ":group:lab")["title"], "lab");
    assert_eq!(
        by_id(&g["clusters"], ":group:lab/peers")["title"],
        "lab · password peers"
    );
    assert_eq!(
        by_id(&g["clusters"], ":group:lab/out")["title"],
        "lab · not in the Mesh"
    );
    assert_eq!(by_id(&g["clusters"], ":group:storage").get("mesh"), None);

    // Nodes: the Box, then the Hosts in roster.yml's order, with Q53's shapes.
    let nodes = &g["nodes"];
    assert_eq!(
        ids(nodes),
        [
            ":box",
            "esx-01",
            "esx-02",
            "appliance",
            "lab-old",
            "nas-01",
            "nas-02",
            "web-1",
            "jump-1",
            "new-01"
        ]
    );
    assert_eq!(by_id(nodes, ":box")["shape"], "square");
    assert_eq!(by_id(nodes, "esx-01")["shape"], "dot");
    assert_eq!(by_id(nodes, "esx-01")["kind"], "esxi");
    assert_eq!(by_id(nodes, "esx-01")["detail"], "10.0.0.5");
    assert_eq!(by_id(nodes, "esx-01")["cluster"], ":group:lab");
    assert_eq!(by_id(nodes, "appliance")["shape"], "ring");
    assert_eq!(by_id(nodes, "appliance")["cluster"], ":group:lab/peers");
    assert_eq!(by_id(nodes, "new-01")["shape"], "dashed");
    // Marks: a cut not finished, a Host that didn't answer, a source with no Link to its hop.
    assert_eq!(by_id(nodes, "lab-old")["mark"], "error");
    assert_eq!(by_id(nodes, "lab-old")["note"], "cut pending on 1 Host");
    assert_eq!(by_id(nodes, "nas-02")["mark"], "warn");
    assert_eq!(by_id(nodes, "nas-02")["note"], "Mesh pending");
    assert_eq!(by_id(nodes, "esx-01")["note"], "no Link to its hop jump-1");
    assert!(
        nodes.as_array().unwrap().iter().all(|n| n.get("state").is_none()),
        "nothing's live yet"
    );

    // Edges: one per cluster from this Box; lab's whole Mesh is its cluster; lab to storage and lab
    // to its password peers are one edge each; the two-way Link is one edge; the hops say so.
    let edges = &g["edges"];
    let by = |id: &str| by_id(edges, id).clone();
    assert_eq!(by("box>:group:lab")["tone"], "muted");
    assert_eq!(by("mesh::group:lab>:group:lab/peers")["style"], "dashed");
    assert_eq!(by("mesh::group:lab>:group:storage")["style"], "solid");
    assert_eq!(by("mesh:nas-01>web-1")["dir"], "both");
    assert_eq!(by("mesh:nas-02>web-1")["label"], "via jump-1");
    assert_eq!(by("mesh:esx-01>web-1")["tone"], "error");
    assert_eq!(
        by("mesh:esx-01>web-1")["label"],
        "via jump-1, but esx-01 has no Link to it"
    );
    let cut = by("cut:lab-old>esx-01");
    assert_eq!(
        (cut["cut"].clone(), cut["dir"].clone(), cut["style"].clone()),
        (json!(true), json!("both"), json!("dotted"))
    );
    // 6 from the Box, 6 for the Mesh's 13 Links, and the cut.
    assert_eq!(edges.as_array().unwrap().len(), 6 + 6 + 1, "{edges:#}");

    let text = spec["text"].as_str().unwrap();
    assert!(text.starts_with("9 Hosts in 4 groups."), "{text}");
    assert!(text.contains("The Mesh: 7 Hosts, 13 Links."), "{text}");
    assert!(text.contains("The Mesh is out of date"), "{text}");
    assert!(text.contains("Cut pending on 1 Host"), "{text}");

    // Its command, key, help page, health section, and a reach section in each Mesh Host's details.
    assert_eq!(one(&reply.ops, "command")["name"], "topology");
    assert_eq!(one(&reply.ops, "key")["keys"], "T");
    assert_eq!(one(&reply.ops, "help")["id"], "topology");
    assert_eq!(one(&reply.ops, "health")["id"], "topology");
    let details = find(&reply.ops, "details");
    let hosts: Vec<&str> = details.iter().map(|d| d["host"].as_str().unwrap()).collect();
    assert_eq!(hosts.len(), 8, "{hosts:?}");
    assert!(!hosts.contains(&"new-01"));
    let esx = details.iter().find(|d| d["host"] == "esx-01").unwrap();
    assert_eq!(
        esx["spec"]["facts"][1],
        json!({ "label": "Reaches", "value": "5 Hosts directly" })
    );
    let appliance = details.iter().find(|d| d["host"] == "appliance").unwrap();
    assert_eq!(
        appliance["spec"]["facts"][3]["value"],
        "2 Links from it: roster doesn't write on a password Host"
    );
    // Its button opens the map at that Host (api 4, T99).
    let show = &esx["spec"]["actions"][0];
    assert_eq!(
        (show["label"].clone(), show["icon"].clone()),
        (json!("Show esx-01 on the map"), json!("map"))
    );
    let r = w.call(
        handler(&show["run"]),
        json!({ "section": "topology", "host": "esx-01" }),
    );
    ok(&r);
    assert_eq!(
        r.ops,
        [json!({ "op": "view_open", "id": "topology", "select": "esx-01" })]
    );
    // It refreshes the Mesh on a slow timer, and only reads.
    let timers = find(&reply.ops, "timer");
    let every: Vec<&&Value> = timers.iter().filter(|t| t["every"] == true).collect();
    assert_eq!(every.len(), 1);
    assert_eq!(every[0]["ms"], 60_000);
    assert!(w.serve.called("mesh.cut").is_empty() && w.serve.called("host.check").is_empty());
}

#[test]
fn a_session_turns_its_node_live_with_its_edge_from_this_box_and_a_failed_one_is_down() {
    let w = World::new("live");
    ok(&w.load(ALL));
    let r = w.event("session_open", json!({ "session": 1, "host": "esx-02" }));
    assert_eq!(r.len(), 1);
    ok(&r[0]);
    let u = one(&r[0].ops, "view_update");
    assert_eq!(u["changes"]["nodes"][0]["id"], "esx-02");
    assert_eq!(u["changes"]["nodes"][0]["state"], "live");
    assert_eq!(
        u["changes"]["edges"],
        json!([{ "id": "live:esx-02", "from": ":box", "to": "esx-02", "tone": "live" }])
    );
    assert!(u["changes"].get("clusters").is_none(), "only what changed: {u:#}");

    // A Quick Connect Session isn't on a Host: nothing changes.
    let r = w.event("session_open", json!({ "session": 2, "host": null }));
    assert!(r.iter().all(|r| find(&r.ops, "view_update").is_empty()));

    // ssh's 255: it never got in.
    w.event("session_open", json!({ "session": 3, "host": "web-1" }));
    let r = w.event("session_exit", json!({ "session": 3, "host": "web-1", "code": 255 }));
    let u = one(&r[0].ops, "view_update");
    let node = &u["changes"]["nodes"][0];
    assert_eq!(
        (node["state"].clone(), node["shape"].clone(), node["note"].clone()),
        (json!("down"), json!("hollow"), json!("ssh failed"))
    );
    assert_eq!(u["changes"]["remove_edges"], json!(["live:web-1"]));
}

#[test]
fn sessions_open_before_it_loaded_are_live_on_the_map() {
    let w = World::new("before");
    // The app listed them before the Plugin loaded: it hears no event for them.
    w.host.set_sessions(vec![(1, Some("esx-02".into()))]);
    let reply = w.load(ALL);
    let nodes = &view(&reply)["graph"]["nodes"];
    assert_eq!(by_id(nodes, "esx-02")["state"], "live");
    assert!(by_id(nodes, "web-1").get("state").is_none(), "its Session ended before");
    let edges = &view(&reply)["graph"]["edges"];
    by_id(edges, "live:esx-02");
}

#[test]
fn a_check_that_fails_marks_its_host_down_and_one_that_passes_clears_it() {
    let w = World::new("checked");
    ok(&w.load(ALL));
    // Running: nothing to say yet.
    let r = w.event("job_progress", json!({ "kind": "check", "job": "check-3", "action": "check", "state": "running", "done": 2, "total": 8, "at": "tcp", "host": "nas-01" }));
    assert!(r.iter().all(|r| find(&r.ops, "view_update").is_empty()));
    assert!(w.serve.called("host.check_job").is_empty());
    // Over: it asks how it came out, once.
    let r = w.event("job_progress", json!({ "kind": "check", "job": "check-3", "action": "check", "state": "done", "done": 8, "total": 8, "host": "nas-01" }));
    assert_eq!(w.serve.called("host.check_job"), [json!({ "job": "check-3" })]);
    let u = one(&r[0].ops, "view_update");
    let node = by_id(&u["changes"]["nodes"], "nas-01");
    assert_eq!(
        (node["state"].clone(), node["note"].clone()),
        (json!("down"), json!("check failed at tcp"))
    );

    // A Session that fails to connect is down too; a check that passes clears it.
    w.event("session_open", json!({ "session": 5, "host": "web-1" }));
    w.event("session_exit", json!({ "session": 5, "host": "web-1", "code": 255 }));
    let r = w.event("job_progress", json!({ "kind": "check", "job": "check-4", "action": "check", "state": "done", "done": 8, "total": 8, "host": "web-1" }));
    let u = one(&r[0].ops, "view_update");
    let node = by_id(&u["changes"]["nodes"], "web-1");
    assert!(node.get("state").is_none() && node.get("note").is_none(), "{node:#}");
}

#[test]
fn only_a_finished_check_is_asked_about_and_an_older_result_never_overrides_a_newer_one() {
    let w = World::new("order");
    ok(&w.load(ALL));
    let end = |job: &str, state: &str| {
        w.event("job_progress", json!({ "kind": "check", "job": job, "action": "check", "state": state, "done": 8, "total": 8, "host": "nas-01" }))
    };
    // Failed (serve's own error) and stopped (the vault locked): no verdict, nothing asked.
    end("check-1", "failed");
    end("check-2", "stopped");
    assert!(w.serve.called("host.check_job").is_empty());
    // check-3 (failed) ended, then check-5 (passed); check-3's answer comes back last and changes
    // nothing: only the latest check of a Host to end counts.
    *w.serve.slow_check.lock().unwrap() = Some("check-3".into());
    w.host.event(Event {
        name: "job_progress".into(),
        payload: json!({ "kind": "check", "job": "check-3", "action": "check", "state": "done", "done": 8, "total": 8, "host": "nas-01" }),
    });
    let r = end("check-5", "done");
    assert_eq!(w.serve.called("host.check_job").len(), 2);
    assert!(
        r.iter().all(|r| find(&r.ops, "view_update").is_empty()),
        "nas-01 isn't marked down: {r:#?}"
    );
}

#[test]
fn check_from_a_node_runs_the_apps_check_of_that_host() {
    let w = World::new("check");
    let reply = w.load(ALL);
    let check = action(view(&reply), "Check");
    let r = w.call(check, on("nas-01"));
    ok(&r);
    // The app's own :check HOST shows each step; it takes seconds, longer than a Plugin's call may.
    assert_eq!(one(&r.ops, "cmd")["line"], "check nas-01");
    assert!(w.serve.called("host.check").is_empty());
    // This Box isn't a Host.
    let r = w.call(check, json!({ "view": "topology", "node": ":box" }));
    assert_eq!(one(&r.ops, "notify")["text"], "That's this Box: pick a Host to check.");
    // Without serve:host.check there's no Check, and :check isn't a command it may run.
    let reply = w.load(&["inventory.read"]);
    let labels: Vec<&str> = view(&reply)["graph"]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["Details"]);
}

#[test]
fn cut_asks_first_with_the_host_to_type_and_only_the_answer_cuts() {
    let w = World::new("cut");
    let reply = w.load(ALL);
    let cut = action(view(&reply), "Cut");
    let r = w.call(cut, on("esx-01"));
    ok(&r);
    let q = &one(&r.ops, "confirm")["spec"];
    assert_eq!(q["title"], "Cut esx-01 from the Mesh?");
    assert_eq!(
        (q["danger"].clone(), q["typed"].clone(), q["action"].clone()),
        (json!(true), json!("esx-01"), json!("Cut"))
    );
    assert_eq!(q["facts"][0]["value"], "5 Hosts directly");
    assert!(w.serve.called("mesh.cut").is_empty(), "asking cuts nothing");
    let r = w.call(handler(&q["run"]), json!({ "confirm": "yes" }));
    ok(&r);
    // It runs as roster serve's job, and a timer asks how it's going.
    assert_eq!(
        w.serve.called("mesh.cut"),
        [json!({ "host": "esx-01", "background": true })]
    );
    assert_eq!(one(&r.ops, "progress")["spec"]["title"], "Cutting esx-01 from the Mesh");
    let timer = one(&r.ops, "timer");
    assert_eq!(timer["every"], true);
    let r = w.call(handler(&timer["run"]), json!({}));
    ok(&r);
    assert_eq!(w.serve.called("mesh.job"), [json!({ "job": 7 })]);
    assert_eq!(
        one(&r.ops, "notify")["text"],
        "Cut esx-01: cut pending on 1 Host that didn't answer."
    );
    assert!(r.ops.iter().any(|o| o["op"] == "remove" && o["kind"] == "progress"));
    assert!(r.ops.iter().any(|o| o["op"] == "remove" && o["kind"] == "timer"));
    // serve API 20 pushes the cut's progress (decision Q112f): the next cut's first push takes
    // its timer away, and mesh.job is asked once it's over.
    let r = w.call(cut, on("esx-01"));
    let r = w.call(
        handler(&one(&r.ops, "confirm")["spec"]["run"]),
        json!({ "confirm": "yes" }),
    );
    ok(&r);
    assert_eq!(one(&r.ops, "timer")["every"], true, "no push yet: it polls");
    let job = |state: &str, done: u64| {
        json!({ "kind": "mesh", "job": 7, "action": "cut", "state": state, "done": done, "total": 3,
                "at": null, "host": "esx-01" })
    };
    let heard = w.event("job_progress", job("running", 1));
    assert!(heard[0].ops.iter().any(|o| o["op"] == "remove" && o["kind"] == "timer"));
    assert_eq!(one(&heard[0].ops, "progress")["spec"]["done"], 1);
    assert_eq!(w.serve.called("mesh.job").len(), 1, "a push while it runs asks nothing");
    let heard = w.event("job_progress", job("done", 3));
    assert_eq!(w.serve.called("mesh.job").len(), 2);
    assert_eq!(
        one(&heard[0].ops, "notify")["text"],
        "Cut esx-01: cut pending on 1 Host that didn't answer."
    );
    // The next cut asks once and sets no timer.
    let r = w.call(cut, on("esx-01"));
    let r = w.call(
        handler(&one(&r.ops, "confirm")["spec"]["run"]),
        json!({ "confirm": "yes" }),
    );
    assert!(find(&r.ops, "timer").is_empty());
    assert_eq!(w.serve.called("mesh.job").len(), 3);
    // A Host that isn't in the Mesh has nothing to cut, and isn't asked about.
    let r = w.call(cut, on("new-01"));
    assert!(find(&r.ops, "confirm").is_empty());
    assert_eq!(
        one(&r.ops, "notify")["text"],
        "new-01 isn't in the Mesh: there's nothing to cut."
    );
}

#[test]
fn leader_false_binds_no_key_as_mesh_does() {
    let w = World::new("no-leader");
    let reply = w.load_with(ALL, json!({ "leader": false }));
    assert!(find(&reply.ops, "notify").is_empty(), "{:?}", reply.ops);
    assert!(find(&reply.ops, "key").is_empty());
    let help = one(&reply.ops, "help")["spec"]["markdown"].as_str().unwrap();
    assert!(!help.contains("false"), "{help}");
    assert!(help.contains("`:topology` opens it"), "{help}");
}

#[test]
fn topology_group_opens_the_view_filtered_to_that_groups_clusters() {
    let w = World::new("command");
    let reply = w.load(ALL);
    let run = handler(&one(&reply.ops, "command")["run"]);
    let r = w.call(run, json!({ "args": "lab", "words": ["lab"] }));
    ok(&r);
    assert_eq!(
        r.ops[0],
        json!({ "op": "view_update", "id": "topology", "changes": { "filter": { "clusters": [":group:lab", ":group:lab/peers", ":group:lab/out"] } } })
    );
    assert_eq!(r.ops[1], json!({ "op": "view_open", "id": "topology" }));
    // Then :topology alone shows everything again.
    let r = w.call(run, json!({ "args": "", "words": [] }));
    assert_eq!(r.ops[0]["changes"]["filter"], json!({}));
    let r = w.call(run, json!({ "args": "nope", "words": ["nope"] }));
    assert_eq!(one(&r.ops, "notify")["text"], "There's no group nope on the map.");
}

// ------------------------------------------------------------------- without its permissions

#[test]
fn without_its_permissions_it_still_loads_draws_this_box_and_says_what_it_needs() {
    let w = World::new("none");
    let reply = w.load(&[]);
    ok(&reply);
    let spec = view(&reply);
    assert_eq!(ids(&spec["graph"]["nodes"]), [":box"]);
    let text = spec["text"].as_str().unwrap();
    assert!(text.contains("Allow inventory.read in :plugins"), "{text}");
    assert!(text.contains("Allow serve:mesh.status in :plugins"), "{text}");
    // Check and Cut aren't offered; Details is.
    let labels: Vec<&str> = spec["graph"]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["Details"]);
    assert!(
        find(&reply.ops, "timer").iter().all(|t| t["every"] == false),
        "no refresh without the Mesh"
    );
    assert!(
        w.serve.calls.lock().unwrap().is_empty(),
        "it called serve without a grant"
    );
    // Its :check section says what's missing.
    let health = one(&reply.ops, "health");
    let r = w.call(handler(&health["spec"]["check"]), json!({}));
    assert_eq!(r.result[0]["level"], "warn");
    assert_eq!(
        r.result[1]["message"],
        "serve:mesh.status isn't granted, so the map has no Mesh"
    );
}

#[test]
fn its_check_section_says_whether_mesh_status_is_available() {
    let w = World::new("health");
    let reply = w.load(ALL);
    let h = handler(&one(&reply.ops, "health")["spec"]["check"]);
    let r = w.call(h, json!({}));
    ok(&r);
    assert_eq!(
        r.result,
        json!([
            { "level": "ok", "message": "Mesh status available: 7 Hosts roster visits" },
            { "level": "warn", "message": "The Mesh is out of date", "fix": "apply it: roster mesh" },
        ])
    );
    // A roster serve without the Mesh: the map still draws, and :check says why there's no Mesh.
    let old = World::with("health-old", FakeServe::new(inventory(), Value::Null));
    *old.serve.mesh.lock().unwrap() = Value::Null;
    let reply = old.load(ALL);
    ok(&reply);
    let r = old
        .host
        .call(NAME, handler(&one(&reply.ops, "health")["spec"]["check"]), json!({}));
    assert_eq!(r.result[0]["level"], "warn");
    assert!(
        r.result[0]["message"]
            .as_str()
            .unwrap()
            .starts_with("Mesh status isn't available")
    );
}

#[test]
fn what_it_wasnt_granted_isnt_in_its_sandbox() {
    let w = World::new("sandbox");
    ok(&w.load(ALL));
    let probe = r#"
        local roster = require("roster")
        local out = {}
        for _, f in ipairs({ "inventory.update", "sessions.open", "terminal.send", "http.get" }) do
          local t, k = f:match("(%w+)%.(%w+)")
          out[#out + 1] = f .. "=" .. tostring(roster[t] ~= nil and roster[t][k] ~= nil)
        end
        local ok, err = pcall(roster.serve.call, "mesh.apply")
        out[#out + 1] = "mesh.apply=" .. tostring(ok) .. ":" .. tostring(err):match("not granted")
        roster.status.set("probe", { text = table.concat(out, " ") })
    "#;
    let dir = temp("probe");
    std::fs::write(
        dir.join("roster-plugin.lua"),
        "return { name = \"probe\", version = \"1.0.0\", description = \"x\", api = 3, permissions = { \"inventory.read\", \"serve:mesh.status\", \"serve:host.check\", \"serve:mesh.cut\" } }",
    )
    .unwrap();
    std::fs::write(dir.join("init.lua"), probe).unwrap();
    let (_, r) = w.host.load(&Source::Dir(dir.to_path_buf()), &perms(ALL)).unwrap();
    ok(&r);
    assert_eq!(
        one(&r.ops, "status")["spec"]["text"],
        "inventory.update=false sessions.open=false terminal.send=false http.get=false mesh.apply=false:not granted"
    );
}

// ------------------------------------------------------------------- 2,000 Hosts

#[test]
fn two_thousand_hosts_in_a_mesh_of_98000_links_load_inside_the_limits_as_40_meshed_clusters() {
    // With mesh.status grouped (serve API 19) it's 2,000 names; the 98,000 Links one by one, from a
    // serve before 19, are more than a quarter of a second of Lua could take in.
    let groups = 40;
    let per = 50;
    let mut hosts = Vec::new();
    let mut links = Vec::new();
    let mut groups_map = Map::new();
    let mut meshed = Map::new();
    for g in 0..groups {
        groups_map.insert(format!("subnet-{g}"), json!({ "title": "", "description": "" }));
        meshed.insert(
            format!("subnet-{g}"),
            json!((0..per).map(|i| format!("h-{g}-{i:02}")).collect::<Vec<_>>()),
        );
        for i in 0..per {
            hosts.push(host(
                &format!("h-{g}-{i:02}"),
                &format!("subnet-{g}"),
                &format!("10.{g}.0.{}", i + 1),
                json!({ "mesh": true }),
            ));
        }
        for a in 0..per {
            for b in 0..per {
                if a != b {
                    links.push(link(&format!("h-{g}-{a:02}"), &format!("h-{g}-{b:02}"), "key"));
                }
            }
        }
    }
    assert_eq!(links.len(), 98_000);
    let mesh = json!({ "links": links, "excluded": {}, "reach": {}, "members": [], "pending": {}, "cut_pending": {}, "out_of_date": false });
    let mut grouped = mesh.clone();
    grouped["links"] = json!([]);
    grouped["meshed"] = Value::Object(meshed);
    let w = World::with(
        "big",
        FakeServe::new(json!({ "hosts": hosts, "groups": groups_map, "error": null }), mesh).grouped(grouped),
    );
    let t = Instant::now();
    let reply = w.load(ALL);
    ok(&reply);
    eprintln!("2,000 Hosts, 98,000 Links: loaded in {:?}", t.elapsed());
    let g = &view(&reply)["graph"];
    assert!(
        view(&reply)["text"]
            .as_str()
            .unwrap()
            .starts_with("2,000 Hosts in 40 groups.")
    );
    assert_eq!(g["nodes"].as_array().unwrap().len(), 2001);
    assert_eq!(
        g["edges"].as_array().unwrap().len(),
        40,
        "only this Box's: each group's Mesh is its cluster"
    );
    assert!(g["clusters"].as_array().unwrap().iter().all(|c| c["mesh"] == true));
    // The reach sections go a few hundred a call, within the host's UI changes per call.
    assert!(find(&reply.ops, "details").len() <= 400);
    let more = find(&reply.ops, "timer").iter().filter(|t| t["every"] == false).count();
    assert_eq!(
        more, 2,
        "the first look, then the rest of the reach sections in a deferred call"
    );
    // A refresh with nothing changed sends nothing to the view.
    let timer = find(&reply.ops, "timer")
        .into_iter()
        .find(|t| t["every"] == true)
        .unwrap();
    let r = w.call(handler(&timer["run"]), json!({}));
    ok(&r);
    assert!(find(&r.ops, "view_update").is_empty());
}

// ------------------------------------------------------------------- transcript

fn steps() -> Value {
    json!([
        { "do": "sessions", "open": [[9, "nas-02"]] },
        { "do": "load", "grants": ALL },
        { "do": "event", "name": "session_open", "payload": { "session": 1, "host": "esx-02" } },
        { "do": "event", "name": "session_open", "payload": { "session": 2, "host": "web-1" } },
        { "do": "event", "name": "session_exit", "payload": { "session": 2, "host": "web-1", "code": 255 } },
        { "do": "action", "label": "Check", "node": "nas-01" },
        { "do": "event", "name": "job_progress", "payload": { "kind": "check", "job": "check-3", "action": "check", "state": "running", "done": 5, "total": 8, "at": "tcp", "host": "nas-01" } },
        { "do": "event", "name": "job_progress", "payload": { "kind": "check", "job": "check-3", "action": "check", "state": "done", "done": 8, "total": 8, "host": "nas-01" } },
        { "do": "action", "label": "Cut", "node": "esx-01" },
        { "do": "confirm" },
        { "do": "cut-timer" },
        { "do": "action", "label": "Cut", "node": "esx-01" },
        { "do": "confirm" },
        { "do": "event", "name": "job_progress", "payload": { "kind": "mesh", "job": 7, "action": "cut", "state": "running", "done": 1, "total": 3, "at": "nas-01", "host": "esx-01" } },
        { "do": "event", "name": "job_progress", "payload": { "kind": "mesh", "job": 7, "action": "cut", "state": "done", "done": 3, "total": 3, "at": null, "host": "esx-01" } },
        { "do": "action", "label": "Details", "node": "esx-01" },
        { "do": "command", "name": "topology", "args": "lab" },
        { "do": "command", "name": "topology", "args": "" },
        { "do": "health" },
        { "do": "timer" },
        { "do": "load", "grants": [] }
    ])
}

/// As recent_alerts.rs keeps ops: each function as `"fn"`, an empty table as an empty list, and a
/// timer's id as `"N"` (it's a handler's number, which the stand-in counts its own way).
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
    let w = World::new("transcript");
    let mut view_spec = Value::Null;
    let mut commands: BTreeMap<String, u64> = BTreeMap::new();
    let mut confirm: Option<u64> = None;
    let mut health: Option<u64> = None;
    let mut timer: Option<u64> = None;
    let mut cut_timer: Option<u64> = None;
    let mut out = Vec::new();
    for step in steps().as_array().unwrap() {
        let replies: Vec<Reply> = match step["do"].as_str().unwrap() {
            "load" => {
                let grants: Vec<&str> = step["grants"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|g| g.as_str().unwrap())
                    .collect();
                vec![w.load(&grants)]
            }
            "event" => w.event(step["name"].as_str().unwrap(), step["payload"].clone()),
            "action" => {
                let node = step["node"].as_str().unwrap();
                vec![w.call(action(&view_spec, step["label"].as_str().unwrap()), on(node))]
            }
            "confirm" => vec![w.call(confirm.take().expect("a question"), json!({ "confirm": "yes" }))],
            "command" => {
                let args = step["args"].as_str().unwrap();
                let words: Vec<&str> = args.split_whitespace().collect();
                vec![w.call(
                    commands[step["name"].as_str().unwrap()],
                    json!({ "args": args, "words": words }),
                )]
            }
            "health" => vec![w.call(health.expect("a :check section"), json!({}))],
            "cut-timer" => vec![w.call(cut_timer.take().expect("a cut's timer"), json!({}))],
            "timer" => vec![w.call(timer.expect("a timer"), json!({}))],
            // The app's list of open Sessions (manager.ts): no Plugin hears it, so no ops.
            "sessions" => {
                let open = step["open"].as_array().unwrap().iter();
                w.host.set_sessions(
                    open.map(|o| (o[0].as_u64().unwrap(), o[1].as_str().map(str::to_string)))
                        .collect(),
                );
                Vec::new()
            }
            other => panic!("no step {other}"),
        };
        let mut ops = Vec::new();
        let mut results = Vec::new();
        for r in &replies {
            ok(r);
            results.push(normal(&r.result));
            for op in &r.ops {
                match op["op"].as_str().unwrap() {
                    "view" => view_spec = op["spec"].clone(),
                    "command" => {
                        commands.insert(op["name"].as_str().unwrap().into(), handler(&op["run"]));
                    }
                    "confirm" => confirm = Some(handler(&op["spec"]["run"])),
                    "health" => health = Some(handler(&op["spec"]["check"])),
                    "timer" if op["every"] == true && timer.is_none() => timer = Some(handler(&op["run"])),
                    "timer" if op["every"] == true => cut_timer = Some(handler(&op["run"])),
                    _ => {}
                }
                ops.push(normal(op));
            }
        }
        let mut step = step.clone();
        step["ops"] = Value::Array(ops);
        if step["do"] == "health" {
            step["result"] = results[0].clone();
        }
        out.push(step);
    }
    let transcript = serde_json::to_string_pretty(&json!({
        "about": "What plugins/topology does in a scripted run, recorded by crates/roster-core/tests/plugin_topology.rs (ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p roster-core --test plugin_topology rewrites it), with the roster serve answers it was given. The fake Backend's stand-in replays it (topology.test.ts).",
        "serve": {
            "hosts.list": inventory(),
            "mesh.status": mesh_grouped(),
            "host.check_job": FakeServe::new(Value::Null, Value::Null).call("host.check_job", json!({ "job": "check-3" })).unwrap(),
            "mesh.cut": { "job": 7, "action": "cut", "total": 3, "host": "esx-01" },
            "mesh.job": { "job": 7, "action": "cut", "host": "esx-01", "state": "done", "done": 3, "total": 3, "at": null, "stopped": false, "result": mesh_cut("esx-01") },
        },
        "steps": out,
    }))
    .unwrap()
        + "\n";
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/src/plugins/topology.transcript.json");
    if std::env::var_os("ROSTER_UPDATE_TRANSCRIPT").is_some() {
        std::fs::write(&path, &transcript).unwrap();
    }
    let recorded = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        recorded == transcript,
        "{} is out of date: run ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p roster-core --test plugin_topology, and update the fake Backend's stand-in to match",
        path.display()
    );
}
