//! Ticket 50 (#87): `plugins/mesh`, the Mesh controls, a first-party Plugin (decisions Q80, Q81,
//! Q94). It's installed as a Package from roster's repo with `dir = "plugins/mesh"` and driven
//! through the Plugin host the Tauri shell uses, against a stand-in roster serve that answers the
//! Mesh's methods as serve's do (API 17: `background` jobs, `mesh.job`, `mesh.stop`, `brief`).
//! Nothing here connects anywhere.
//!
//! It also records one scripted run (`mesh.transcript.json` in `app/src/plugins/`): every op the
//! real Lua sent and every serve call it made with its answer. The frontend's stand-in for this
//! Plugin (`app/src/backend/fakeMesh.ts`) replays it in `mesh.test.ts`, so the UI tests test this
//! Plugin's behaviour, not a guess at it. `ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p roster-core
//! --test plugin_mesh` rewrites the file.

mod common;

use roster_core::config::PackageSpec;
use roster_core::package::Packages;
use roster_core::plugin::{Event, Limits, Permission, PluginHost, Reply, Serve, Source, read_manifest};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const NAME: &str = "mesh";
const ALL: &[&str] = &[
    "inventory.read",
    "serve:mesh.status",
    "serve:mesh.job",
    "serve:mesh.stop",
    "serve:mesh.plan",
    "serve:mesh.apply",
    "serve:mesh.cut",
];

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/mesh")
}

fn perms(names: &[&str]) -> Vec<Permission> {
    names.iter().map(|n| Permission::parse(n).unwrap()).collect()
}

// ------------------------------------------------------------------- a stand-in roster serve

/// What the stand-in's Mesh is like.
#[derive(Clone)]
struct World {
    /// Hosts in `lab`, a meshed group: every pair is a Link.
    lab: usize,
    /// serve has API 17's jobs.
    jobs: bool,
    out_of_date: bool,
    cut_pending: Value,
    /// Polls of `mesh.job` a job answers "running" before it's done.
    ticks: u64,
}

impl Default for World {
    fn default() -> World {
        World {
            lab: 4,
            jobs: true,
            out_of_date: true,
            cut_pending: json!({}),
            ticks: 1,
        }
    }
}

struct Job {
    number: u64,
    action: String,
    host: Option<String>,
    total: u64,
    left: u64,
    stopped: bool,
}

#[derive(Default)]
struct FakeMesh {
    world: Mutex<Option<World>>,
    job: Mutex<Option<Job>>,
    /// Every call, with its answer: `{ method, params, result }` or `{ …, error }`.
    calls: Mutex<Vec<Value>>,
    /// Held while serve is busy with the app's own call (a Publish): every call waits for it.
    busy: Mutex<()>,
}

fn lab_hosts(w: &World) -> Vec<String> {
    let mut names: Vec<String> = ["esx-02", "orion-2", "orion-3", "nas-1"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    for i in names.len()..w.lab {
        names.push(format!("lab-{i:03}"));
    }
    names.truncate(w.lab);
    names.sort();
    names
}

impl FakeMesh {
    fn new(world: World) -> FakeMesh {
        FakeMesh {
            world: Mutex::new(Some(world)),
            ..FakeMesh::default()
        }
    }

    fn world(&self) -> World {
        self.world.lock().unwrap().clone().unwrap()
    }

    fn methods(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| c["method"].as_str().unwrap().to_string())
            .collect()
    }

    fn take(&self) -> Vec<Value> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }

    /// mesh.status, brief: `lab` meshed, a Link to db-9 through jump-1 with no Link to jump-1
    /// (no-via), and sw-1 kept out.
    fn status(&self) -> Value {
        let w = self.world();
        let lab = lab_hosts(&w);
        let n = lab.len() as u64;
        let mut reach = serde_json::Map::new();
        let mut reached = serde_json::Map::new();
        for h in &lab {
            reach.insert(h.clone(), json!(n - 1));
            reached.insert(h.clone(), json!(n - 1));
        }
        let mut members = lab.clone();
        members.push("db-9".into());
        members.sort();
        reach.insert("orion-3".into(), json!(n - 1));
        json!({
            "links": [{ "from": "orion-3", "to": "db-9", "kind": "key", "via": "jump-1", "status": "no-via",
                        "why": "orion-3 has no Link to jump-1, its hop to db-9 (add { from: orion-3, to: jump-1 })" }],
            "links_more": 0,
            "link_count": n * (n - 1) + 1,
            "link_statuses": { "asked": n * (n - 1), "no-via": 1 },
            "excluded": { "sw-1": "mesh: false" },
            "reach": reach,
            "reached": reached,
            "members": members,
            "pending": {},
            "cut_pending": w.cut_pending,
            "out_of_date": w.out_of_date,
        })
    }

    fn result(&self, job: &Job) -> Value {
        let w = self.world();
        let lab = lab_hosts(&w);
        let n = lab.len() as u64;
        match job.action.as_str() {
            "cut" => {
                let host = job.host.clone().unwrap();
                let peers: Vec<&String> = lab.iter().filter(|h| **h != host).collect();
                let confirmed: Vec<&String> = peers.iter().copied().filter(|h| h.as_str() != "nas-1").collect();
                json!({ "host": host, "confirmed": confirmed,
                        "pending": { "nas-1": "no answer: ssh: connect to host nas-1 port 22: Connection timed out" },
                        "warnings": [format!("{host}: /srv/mesh holds an earlier Mesh key that roster no longer uses (mesh_dir: changed), so delete it by hand")],
                        "change": { "written": true, "backup": "/home/you/.config/roster/backup/roster.yml" } })
            }
            action => {
                let apply = action == "apply";
                let hosts: Vec<Value> = lab
                    .iter()
                    .map(|h| {
                        if h == "nas-1" && !job.stopped {
                            json!({ "host": h, "status": "same", "changes": [] })
                        } else if job.stopped && h != "esx-02" {
                            json!({ "host": h, "status": "pending", "changes": [],
                                    "error": "stopped: not visited (the next roster mesh finishes it)" })
                        } else {
                            json!({ "host": h, "status": if apply { "changed" } else { "would-change" },
                                    "changes": ["make key", "write ssh config", format!("add key from {}", lab[0])] })
                        }
                    })
                    .collect();
                let pending: serde_json::Map<String, Value> = hosts
                    .iter()
                    .filter(|h| h["status"] == "pending")
                    .map(|h| (h["host"].as_str().unwrap().to_string(), h["error"].clone()))
                    .collect();
                let mut r = self.status();
                r["applied"] = json!(apply);
                r["hosts"] = json!(hosts);
                r["pending"] = json!(pending);
                r["already"] = json!(false);
                r["warnings"] = json!([
                    "orion-3: ~/ROSTER.md isn't roster's, so roster left it alone (move it away and apply again)"
                ]);
                r["links"] = json!([
                    { "from": "orion-3", "to": "db-9", "kind": "key", "via": "jump-1", "status": "no-via",
                      "why": "orion-3 has no Link to jump-1, its hop to db-9 (add { from: orion-3, to: jump-1 })" },
                    { "from": "orion-2", "to": "nas-1", "kind": "key", "status": "unreachable",
                      "why": "orion-2 can't reach 10.0.0.30:22" },
                ]);
                r["link_statuses"] = json!({ "ok": n * (n - 1) - 1, "unreachable": 1, "no-via": 1 });
                r.as_object_mut().unwrap().remove("members");
                r.as_object_mut().unwrap().remove("out_of_date");
                r
            }
        }
    }

    fn answer(&self, method: &str, params: &Value) -> Result<Value, String> {
        let w = self.world();
        let mut job = self.job.lock().unwrap();
        match method {
            "mesh.job" if !w.jobs => Err("unknown method 'mesh.job' (code -32601)".into()),
            "mesh.job" => {
                let Some(j) = job.as_mut() else { return Ok(Value::Null) };
                if params.get("job").is_some_and(|n| n != j.number) {
                    return Ok(Value::Null);
                }
                let mut v = json!({ "job": j.number, "action": j.action, "state": "running", "total": j.total,
                                    "done": j.total - j.left, "at": "orion-2", "stopped": j.stopped });
                if let Some(h) = &j.host {
                    v["host"] = json!(h);
                }
                if j.left > 0 && !j.stopped {
                    j.left -= 1;
                    return Ok(v);
                }
                let result = self.result(j);
                v["state"] = json!("done");
                v["done"] = json!(j.total);
                v["at"] = Value::Null;
                v["result"] = result;
                let action = j.action.clone();
                drop(job);
                let mut world = self.world.lock().unwrap();
                let world = world.as_mut().unwrap();
                if action == "apply" {
                    world.out_of_date = false;
                } else if action == "cut" {
                    world.cut_pending = json!({ v["host"].as_str().unwrap(): ["nas-1"] });
                }
                Ok(v)
            }
            "mesh.status" => Ok(self.status()),
            "mesh.stop" => {
                let stopping = job
                    .as_ref()
                    .is_some_and(|j| Some(j.number) == params["job"].as_u64() && j.left > 0);
                if stopping {
                    job.as_mut().unwrap().stopped = true;
                }
                Ok(json!({ "job": params["job"], "stopping": stopping }))
            }
            "mesh.plan" | "mesh.apply" | "mesh.cut" => {
                if params["background"] != true {
                    return Err(format!("{method} without background would hold the Plugin (code -1)"));
                }
                if job.as_ref().is_some_and(|j| j.left > 0) {
                    return Err("a Mesh job is still running (code 111)".into());
                }
                let action = method.trim_start_matches("mesh.").to_string();
                let host = params["host"].as_str().map(str::to_string);
                let number = job.as_ref().map_or(1, |j| j.number + 1);
                let total = if action == "cut" {
                    w.lab as u64 - 1
                } else {
                    2 * w.lab as u64
                };
                *job = Some(Job {
                    number,
                    action: action.clone(),
                    host: host.clone(),
                    total,
                    left: w.ticks,
                    stopped: false,
                });
                let mut v = json!({ "job": number, "action": action, "total": total });
                if let Some(h) = host {
                    v["host"] = json!(h);
                }
                Ok(v)
            }
            other => Err(format!("unknown method '{other}' (code -32601)")),
        }
    }
}

impl Serve for FakeMesh {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        // serve answers one request at a time.
        let _turn = self.busy.lock().unwrap();
        let answer = self.answer(method, &params);
        let mut record = json!({ "method": method, "params": params });
        match &answer {
            Ok(v) => record["result"] = v.clone(),
            Err(e) => record["error"] = json!(e),
        }
        self.calls.lock().unwrap().push(record);
        answer
    }
}

// ------------------------------------------------------------------- driving it

struct Run {
    host: PluginHost,
    serve: Arc<FakeMesh>,
    /// Every op so far, in order.
    ops: Vec<Value>,
    /// What the Plugin did when its roster serve requests answered (the Tauri shell's
    /// `plugin-reply`).
    replies: Receiver<Reply>,
    /// The ops of each of those answers since the last step, for the transcript.
    answers: Vec<Value>,
    /// The last `job_progress` pushed, for the transcript.
    pushed: Value,
}

impl Run {
    fn new(world: World, grants: &[&str]) -> Run {
        Run::new_with(world, grants, Limits::default())
    }

    fn new_with(world: World, grants: &[&str], limits: Limits) -> Run {
        let mut run = Run::with_limits(Arc::new(FakeMesh::new(world)), limits);
        let (_, reply) = run.host.load(&Source::Dir(plugin()), &perms(grants)).unwrap();
        run.take(reply);
        run
    }

    /// A host with `serve`, nothing loaded yet.
    fn with(serve: Arc<FakeMesh>) -> Run {
        Run::with_limits(serve, Limits::default())
    }

    fn with_limits(serve: Arc<FakeMesh>, limits: Limits) -> Run {
        let host = PluginHost::new(serve.clone(), limits);
        let (tx, replies) = channel();
        let tx = Mutex::new(tx);
        host.set_listener(Arc::new(move |r: Reply| {
            let _ = tx.lock().unwrap().send(r);
        }));
        Run {
            host,
            serve,
            ops: Vec::new(),
            replies,
            answers: Vec::new(),
            pushed: Value::Null,
        }
    }

    /// What `reply` did, and then what the answers to the requests it made did, once every one
    /// of them has come back: what the user sees after a moment.
    fn take(&mut self, reply: Reply) -> Vec<Value> {
        assert!(reply.error.is_none(), "{:?}", reply.error);
        self.ops.extend(reply.ops.iter().cloned());
        let mut ops = reply.ops;
        let started = Instant::now();
        while self.host.requests(NAME) > 0 {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "roster serve's answers didn't come"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        while let Ok(r) = self.replies.try_recv() {
            assert!(r.error.is_none(), "{:?}", r.error);
            self.ops.extend(r.ops.iter().cloned());
            self.answers.push(normal(&Value::Array(r.ops.clone())));
            ops.extend(r.ops);
        }
        ops
    }

    fn call(&mut self, handler: u64, args: Value) -> Vec<Value> {
        let reply = self.host.call(NAME, handler, args);
        self.take(reply)
    }

    /// Sends `name` to the Plugin: what it did, then what its requests' answers did.
    fn event(&mut self, name: &str) -> Vec<Value> {
        self.event_with(name, json!({}))
    }

    /// serve's `job.progress` for its job, as the app hands it to the Plugins (API 20): `state`
    /// running (one more step done), or how it ended (serve has finished it, so `mesh.job` says
    /// so). What the Plugin did, then what its requests' answers did.
    fn push(&mut self, state: &str) -> Vec<Value> {
        let payload = {
            let mut job = self.serve.job.lock().unwrap();
            let j = job.as_mut().expect("a job");
            if state == "running" {
                j.left = j.left.saturating_sub(1).max(1);
            } else {
                j.left = 0;
            }
            let done = if state == "running" { j.total / 2 } else { j.total };
            let mut p = json!({ "kind": "mesh", "job": j.number, "action": j.action, "state": state,
                                "done": done, "total": j.total, "at": if state == "running" { json!("orion-2") } else { Value::Null } });
            if let Some(h) = &j.host {
                p["host"] = json!(h);
            }
            p
        };
        self.pushed = payload.clone();
        self.event_with("job_progress", payload)
    }

    fn event_with(&mut self, name: &str, payload: Value) -> Vec<Value> {
        let replies = self.host.event(Event {
            name: name.into(),
            payload,
        });
        let mut ops: Vec<Value> = replies.into_iter().flat_map(|r| self.take(r)).collect();
        ops.extend(self.take(Reply {
            plugin: NAME.into(),
            result: Value::Null,
            ops: Vec::new(),
            error: None,
            disabled: None,
        }));
        ops
    }

    /// The latest op of a kind (`view` with that id, …) that matches `f`.
    fn last(&self, f: impl Fn(&Value) -> bool) -> Value {
        self.ops
            .iter()
            .rev()
            .find(|o| f(o))
            .cloned()
            .unwrap_or_else(|| panic!("no such op in {:#?}", self.ops))
    }

    fn view(&self, id: &str) -> Value {
        self.last(|o| o["op"] == "view" && o["id"] == id)
    }

    /// The timer the Plugin set last, which hasn't been cancelled: the app's clock fires it.
    fn tick(&mut self) -> Vec<Value> {
        let t = self.last(|o| o["op"] == "timer");
        let removed = self
            .ops
            .iter()
            .any(|o| o["op"] == "remove" && o["kind"] == "timer" && o["id"] == t["id"]);
        assert!(!removed, "the last timer was cancelled");
        self.call(handler(&t["run"]), json!({}))
    }

    fn command(&mut self, args: &str) -> Vec<Value> {
        let c = self.last(|o| o["op"] == "command" && o["name"] == NAME);
        let words: Vec<&str> = args.split_whitespace().collect();
        self.call(handler(&c["run"]), json!({ "args": args, "words": words }))
    }

    /// Runs the action labelled `label` of view `id` on the row with `row`'s id.
    fn action(&mut self, view: &str, label: &str, row: &str) -> Vec<Value> {
        let v = self.view(view);
        let a = v["spec"]["table"]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["label"] == label)
            .unwrap_or_else(|| panic!("no action {label} in {v:#}"))
            .clone();
        let r = v["spec"]["table"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == row)
            .cloned()
            .unwrap_or(json!({}));
        self.call(
            handler(&a["run"]),
            json!({ "row": row, "host": r["host"], "view": view }),
        )
    }

    /// Answers the question it asked last.
    fn confirm(&mut self) -> Vec<Value> {
        let q = self.last(|o| o["op"] == "confirm");
        self.call(handler(&q["spec"]["run"]), json!({ "confirm": "yes" }))
    }
}

fn handler(v: &Value) -> u64 {
    v["handler"].as_u64().unwrap_or_else(|| panic!("no handler in {v}"))
}

fn of<'a>(ops: &'a [Value], op: &str) -> Vec<&'a Value> {
    ops.iter().filter(|o| o["op"] == op).collect()
}

fn ops_level(ops: &[Value], i: usize) -> &str {
    of(ops, "notify")[i]["level"].as_str().unwrap()
}

fn texts(ops: &[Value]) -> Vec<String> {
    of(ops, "notify")
        .iter()
        .map(|o| o["text"].as_str().unwrap().to_string())
        .collect()
}

fn cell(view: &Value, row: &str, col: &str) -> Value {
    view["spec"]["table"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == row)
        .unwrap_or_else(|| panic!("no row {row}"))["cells"][col]
        .clone()
}

/// Loads with everything granted and lets the first look (a deferred refresh) happen.
fn started(world: World) -> Run {
    let mut run = Run::new(world, ALL);
    run.tick();
    run
}

/// `started` for a group of hundreds of Hosts, whose test is about how the work is split up (a
/// call may make at most 1,000 UI changes), not how fast it runs. A call's budget is wall-clock time, and a debug build's Lua on a loaded CI
/// runner can take longer than 250 ms over a call that draws 1,000 rows, so the budget (tested in
/// plugin.rs) is lifted here and the test can't fail on the runner's load.
fn started_big(world: World) -> Run {
    let roomy = Limits {
        call: Duration::from_secs(60),
        grace: Duration::from_secs(60),
        ..Limits::default()
    };
    let mut run = Run::new_with(world, ALL, roomy);
    run.tick();
    run
}

// ------------------------------------------------------------------- tests

#[test]
fn it_installs_from_roster_s_repo_with_dir_and_asks_for_exactly_its_permissions() {
    let root = common::temp("plugin-mesh");
    let (bare, work) = (root.join("roster.git"), root.join("work"));
    std::fs::create_dir_all(&bare).unwrap();
    std::fs::create_dir_all(work.join("plugins")).unwrap();
    let git = |dir: &Path, args: &[&str]| {
        let out = Command::new("git")
            .args([
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@example.com",
                "-c",
                "commit.gpgsign=false",
                "-C",
            ])
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    };
    git(&bare, &["init", "--quiet", "--bare", "--initial-branch=main"]);
    let copy = Command::new("cp")
        .arg("-r")
        .arg(plugin())
        .arg(work.join("plugins/mesh"))
        .status()
        .unwrap();
    assert!(copy.success());
    git(&work, &["init", "--quiet", "--initial-branch=main"]);
    git(&work, &["add", "."]);
    git(&work, &["commit", "--quiet", "-m", "mesh"]);
    git(&work, &["push", "--quiet", bare.to_str().unwrap(), "main"]);
    let specs = vec![PackageSpec {
        source: bare.to_str().unwrap().into(),
        name: None,
        tag: None,
        branch: None,
        commit: None,
        dir: Some("plugins/mesh".into()),
        config: Default::default(),
    }];
    let packages = Packages::new(&root.join("data"), &root.join("config"));
    assert_eq!(packages.sync(&specs)[0].error, None);
    let (dir, _) = packages.loadable(&specs, NAME).unwrap();
    let m = read_manifest(&dir).unwrap();
    assert_eq!(m.name, NAME);
    assert_eq!(m.api, 4);
    let mut asked: Vec<String> = m.permissions.iter().map(|p| p.to_string()).collect();
    asked.sort();
    let mut want: Vec<String> = ALL.iter().map(|s| s.to_string()).collect();
    want.sort();
    assert_eq!(
        asked, want,
        "no serve method it doesn't call, nothing that reaches a secret"
    );
    // The prompt flags exactly the three that can change something on the Hosts.
    let shown = serde_json::to_value(&m).unwrap();
    let mut flagged: Vec<&str> = shown["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| !p["risk"].is_null())
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    flagged.sort();
    assert_eq!(flagged, ["serve:mesh.apply", "serve:mesh.cut"]);
    let serve = Arc::new(FakeMesh::new(World::default()));
    let host = PluginHost::new(serve.clone(), Limits::default());
    let (_, reply) = host.load(&Source::Dir(dir), &m.permissions).unwrap();
    assert!(reply.error.is_none());
    assert!(
        serve.methods().is_empty(),
        "nothing called while loading: a busy serve can't hold the app's start"
    );
}

#[test]
fn it_shows_each_hosts_reach_out_of_date_and_no_via() {
    let run = started(World::default());
    let calls = run.serve.methods();
    assert_eq!(calls, ["mesh.job", "mesh.status"]);
    let mesh = run.view("mesh");
    assert_eq!(cell(&mesh, "esx-02", "reach"), 3);
    assert_eq!(cell(&mesh, "esx-02", "state"), "in the Mesh");
    assert_eq!(cell(&mesh, "sw-1", "state"), "kept out: mesh: false");
    let text = mesh["spec"]["text"].as_str().unwrap();
    assert!(text.contains("5 Hosts in the Mesh, 13 Links."), "{text}");
    assert!(text.contains("roster.yml changed the Mesh since the last apply"));
    assert!(text.contains("1 Link goes through a jump Host its source has no Link to (no-via)"));
    let seg = run.last(|o| o["op"] == "status");
    assert_eq!(seg["spec"]["text"], "Mesh out of date");
    assert_eq!(seg["spec"]["run"], "mesh plan");
    let links = run.view("mesh-links");
    assert_eq!(cell(&links, "l1", "via"), "jump-1");
    assert_eq!(cell(&links, "l1", "status"), "no Link to its hop");
    // Each Host's details: its reach, as the Mesh shows the risk.
    let d = run.last(|o| o["op"] == "details" && o["host"] == "orion-3");
    assert_eq!(d["spec"]["facts"][0]["value"], "can reach 3 Hosts");
    // Its rows are its Links: the Host itself is the facts and the Cut on the heading (#176),
    // which `x` runs from anywhere in the section.
    assert_eq!(
        d["spec"]["table"]["rows"][0]["cells"]["link"],
        "orion-3 → db-9 via jump-1"
    );
    assert_eq!(d["spec"]["actions"][0]["key"], "x");
    assert!(d["spec"]["table"]["actions"].as_array().is_none_or(|a| a.is_empty()));
    let sw = run.last(|o| o["op"] == "details" && o["host"] == "sw-1");
    assert!(sw["spec"]["table"].is_null(), "a Host kept out has nothing to cut");
    assert!(sw["spec"]["actions"].is_null(), "nor a Cut on its heading");
}

#[test]
fn a_links_details_explain_no_via_and_what_to_do() {
    let mut run = started(World::default());
    let ops = run.action("mesh-links", "Explain", "l1");
    let f = of(&ops, "float")[0];
    let lines: Vec<&str> = f["spec"]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap())
        .collect();
    assert!(
        lines.contains(&"Why     orion-3 has no Link to jump-1, its hop to db-9 (add { from: orion-3, to: jump-1 })")
    );
    assert!(
        lines
            .iter()
            .any(|l| l.contains("Add a Link from the source to the jump Host"))
    );
}

#[test]
fn plan_shows_the_changes_and_apply_comes_only_after_a_question() {
    let mut run = started(World::default());
    run.serve.take();
    let ops = run.command("plan");
    assert_eq!(run.serve.methods(), ["mesh.plan"]);
    assert_eq!(run.serve.take()[0]["params"], json!({ "background": true }));
    assert_eq!(of(&ops, "view_open")[0]["id"], "mesh-plan");
    let p = of(&ops, "progress")[0];
    assert_eq!(p["spec"]["title"], "Planning the Mesh");
    assert_eq!(
        (p["spec"]["done"].clone(), p["spec"]["total"].clone()),
        (json!(0), json!(8))
    );
    // A second run while it plans is refused here, before serve's 111.
    let ops = run.command("apply");
    assert!(
        texts(&ops)[0].starts_with("A Mesh plan is running"),
        "{:?}",
        texts(&ops)
    );
    // The clock: still running, then done.
    let ops = run.tick();
    assert_eq!(of(&ops, "progress")[0]["spec"]["text"], "At orion-2");
    let ops = run.tick();
    assert!(of(&ops, "remove").iter().any(|o| o["kind"] == "timer"));
    assert!(of(&ops, "remove").iter().any(|o| o["kind"] == "progress"));
    assert!(texts(&ops)[0].starts_with("Plan ready: 3 Hosts would change"));
    let plan = run.view("mesh-plan");
    assert_eq!(
        cell(&plan, "esx-02", "changes"),
        "make key; write ssh config; add key from esx-02"
    );
    assert_eq!(cell(&plan, "nas-1", "status"), "same");
    assert!(
        plan["spec"]["text"]
            .as_str()
            .unwrap()
            .contains("ROSTER.md isn't roster's")
    );
    // Apply: a question first, nothing started until it's answered.
    run.serve.take();
    let ops = run.action("mesh-plan", "Apply", "esx-02");
    let q = of(&ops, "confirm")[0];
    assert_eq!(q["spec"]["action"], "Apply");
    assert!(q["spec"]["danger"].is_null());
    assert_eq!(q["spec"]["facts"][0]["value"], "3 of 4");
    assert_eq!(q["spec"]["facts"][2]["value"], "2");
    assert!(run.serve.methods().is_empty());
    run.confirm();
    assert_eq!(run.serve.methods(), ["mesh.apply"]);
    run.tick();
    let ops = run.tick();
    assert!(texts(&ops)[0].starts_with("Applied: 3 Hosts changed."));
    // Not out of date any more: the status segment goes.
    let seg = run.last(|o| o["op"] == "status" || (o["op"] == "remove" && o["kind"] == "status"));
    assert_eq!(seg["op"], "remove");
}

/// serve answers one request at a time, so the app's Publish holds every Mesh question behind it
/// for a minute or two: the controls keep answering meanwhile (decision Q103).
#[test]
fn the_controls_answer_while_roster_serve_is_busy_and_catch_up_after() {
    let mut run = started(World::default());
    run.serve.take();
    let publish = run.serve.busy.lock().unwrap();
    let c = run.last(|o| o["op"] == "command" && o["name"] == NAME);
    let started = Instant::now();
    let reply = run
        .host
        .call(NAME, handler(&c["run"]), json!({ "args": "plan", "words": ["plan"] }));
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(reply.error.is_none() && reply.disabled.is_none(), "{reply:?}");
    assert_eq!(of(&reply.ops, "view_open")[0]["id"], "mesh-plan");
    // Asked again before serve answers: it says it's starting, and asks nothing more.
    let again = run
        .host
        .call(NAME, handler(&c["run"]), json!({ "args": "plan", "words": ["plan"] }));
    assert!(texts(&again.ops)[0].contains("is starting"));
    std::thread::sleep(Duration::from_millis(2600));
    assert!(run.host.list()[0].disabled.is_none());
    drop(publish);
    let ops = run.take(reply);
    assert_eq!(of(&ops, "progress")[0]["spec"]["title"], "Planning the Mesh");
    assert_eq!(run.serve.methods(), ["mesh.plan"]);
}

#[test]
fn apply_without_a_plan_plans_first() {
    let mut run = started(World::default());
    run.serve.take();
    let ops = run.command("apply");
    assert!(texts(&ops)[0].starts_with("Plan first"));
    assert!(of(&ops, "confirm").is_empty());
    assert_eq!(run.serve.methods(), ["mesh.plan"]);
}

#[test]
fn cut_asks_for_the_hosts_name_and_warns_about_each_host_that_was_down() {
    let mut run = started(World::default());
    run.serve.take();
    let ops = run.action("mesh", "Cut", "orion-2");
    let q = &of(&ops, "confirm")[0]["spec"];
    assert_eq!(q["title"], "Cut orion-2 from the Mesh?");
    assert_eq!(
        (q["danger"].clone(), q["typed"].clone()),
        (json!(true), json!("orion-2"))
    );
    assert_eq!(q["facts"][1]["value"], "can reach 3 Hosts");
    assert!(
        run.serve.methods().is_empty(),
        "nothing cut before the question is answered"
    );
    run.confirm();
    let call = &run.serve.take()[0];
    assert_eq!(call["method"], "mesh.cut");
    assert_eq!(call["params"], json!({ "host": "orion-2", "background": true }));
    run.tick();
    let ops = run.tick();
    let said = texts(&ops);
    assert_eq!(said[0], "orion-2 is cut from the Mesh on 2 Hosts.");
    assert!(said[1].starts_with("CUT PENDING on nas-1: no answer"), "{said:?}");
    // What roster left on the cut Host's own side (serve API 24).
    assert_eq!(
        (said[2].as_str(), ops_level(&ops, 2)),
        (
            "orion-2: /srv/mesh holds an earlier Mesh key that roster no longer uses (mesh_dir: changed), so delete it by hand",
            "warn"
        )
    );
    let badge = run.last(|o| o["op"] == "badge" && o["host"] == "nas-1");
    assert_eq!(badge["text"], "cut pending");
    assert_eq!(run.last(|o| o["op"] == "status")["spec"]["text"], "Cut pending");
    // Cut on a Host that isn't in the Mesh isn't asked about at all.
    let ops = run.command("cut sw-1");
    assert!(of(&ops, "confirm").is_empty());
    assert_eq!(texts(&ops)[0], "sw-1 isn't in the Mesh: there's nothing to cut.");
}

/// serve API 20 pushes the job's progress (decision Q112f): the first push takes the timer away,
/// the progress comes from the pushes, `mesh.job` is asked once the job is over, and the next job
/// needs no timer.
#[test]
fn it_follows_a_job_by_job_progress_and_stops_polling() {
    let mut run = started(World {
        ticks: 5,
        ..World::default()
    });
    let started_ops = run.command("plan");
    assert!(!of(&started_ops, "timer").is_empty(), "no push yet: it polls");
    run.serve.take();
    let first = run.push("running");
    assert!(first.iter().any(|o| o["op"] == "remove" && o["kind"] == "timer"));
    let p = of(&first, "progress");
    assert_eq!(p.last().unwrap()["spec"]["text"], "At orion-2");
    assert!(run.serve.take().is_empty(), "a push while it runs asks serve nothing");
    let end = run.push("done");
    let asked: Vec<Value> = run.serve.take().iter().map(|c| c["method"].clone()).collect();
    assert_eq!(asked[0], "mesh.job");
    assert!(
        texts(&end).iter().any(|t| t.starts_with("Plan ready")),
        "{:?}",
        texts(&end)
    );
    // The next job asks once and sets no timer: serve pushes.
    let apply = run.command("plan");
    assert!(of(&apply, "timer").is_empty());
    assert_eq!(run.serve.take().iter().filter(|c| c["method"] == "mesh.job").count(), 1);
}

/// Another kind's job, or another Plugin's Mesh job, isn't followed.
#[test]
fn a_scans_progress_isnt_heard() {
    let mut run = started(World::default());
    let ops = run.event_with(
        "job_progress",
        json!({ "kind": "discover", "job": "scan-1", "action": "scan", "state": "running", "done": 1, "total": 254, "at": null }),
    );
    assert!(ops.is_empty());
}

#[test]
fn stopping_calls_mesh_stop_and_says_what_was_left_pending() {
    let mut run = started(World {
        ticks: 3,
        ..World::default()
    });
    run.command("plan");
    let p = run.last(|o| o["op"] == "progress");
    run.serve.take();
    run.call(handler(&p["spec"]["cancel"]), json!({ "progress": "mesh" }));
    assert_eq!(run.serve.take()[0]["method"], "mesh.stop");
    let ops = run.tick();
    assert!(
        texts(&ops)[0].contains("stopped: 3 Hosts left pending"),
        "{:?}",
        texts(&ops)
    );
}

#[test]
fn without_its_serve_permissions_it_loads_and_says_what_it_is_missing() {
    let mut run = Run::new(World::default(), &["inventory.read"]);
    run.tick();
    assert!(run.serve.methods().is_empty());
    let mesh = run.view("mesh");
    assert_eq!(
        mesh["spec"]["text"],
        "Allow serve:mesh.status and serve:mesh.job in :plugins to see the Mesh."
    );
    let ops = run.command("plan");
    assert!(texts(&ops)[0].contains("Allow serve:mesh.status"));
    // Reading but not changing: plan and apply say what's missing, nothing is started.
    let mut run = Run::new(World::default(), &["serve:mesh.status", "serve:mesh.job"]);
    run.tick();
    let ops = run.command("plan");
    assert_eq!(
        texts(&ops)[0],
        "Allow serve:mesh.plan in :plugins to plan the Mesh from here."
    );
    assert_eq!(run.serve.methods(), ["mesh.job", "mesh.status"]);
}

#[test]
fn an_older_roster_serve_without_jobs_is_never_asked_to_run_the_mesh() {
    let mut run = started(World {
        jobs: false,
        ..World::default()
    });
    assert_eq!(
        run.serve.methods(),
        ["mesh.job"],
        "and no full mesh.status, which could be huge"
    );
    assert!(run.view("mesh")["spec"]["text"].as_str().unwrap().contains("API 17"));
    run.command("plan");
    assert!(!run.serve.methods().contains(&"mesh.plan".to_string()));
}

#[test]
fn it_refreshes_after_a_publish() {
    let mut run = started(World::default());
    run.serve.take();
    let ops = run.event("inventory_changed");
    assert!(!of(&ops, "view").is_empty());
    assert_eq!(run.serve.methods(), ["mesh.status"]);
}

#[test]
fn five_hundred_hosts_in_a_meshed_group_stay_inside_the_limits() {
    let mut run = started_big(World {
        lab: 500,
        ..World::default()
    });
    let mesh = run.view("mesh");
    assert_eq!(mesh["spec"]["table"]["rows"].as_array().unwrap().len(), 502);
    assert!(
        mesh["spec"]["text"]
            .as_str()
            .unwrap()
            .contains("501 Hosts in the Mesh, 249,501 Links.")
    );
    // The details come a few hundred at a time: the rest in a deferred call.
    let first = of(&run.ops, "details").len();
    assert_eq!(first, 300);
    run.tick();
    assert_eq!(of(&run.ops, "details").len(), 502);
}

#[test]
fn a_thousand_hosts_get_their_details_in_batches_until_every_one_has_its_section() {
    let mut run = started_big(World {
        lab: 1000,
        ..World::default()
    });
    // The budget is lifted (started_big), so the work each call does is checked here instead, by
    // count: at most 300 Host-details sections per call, inside the 1,000 UI changes a call may
    // make, and every section set within four calls (300 + 300 + 300 + 102).
    assert_eq!(of(&run.ops, "details").len(), 300, "the first call");
    let mut calls = 1;
    while of(&run.ops, "details").len() < 1002 {
        let ops = run.tick();
        calls += 1;
        assert!(
            of(&ops, "details").len() <= 300,
            "{} sections in one call",
            of(&ops, "details").len()
        );
        assert!(ops.len() <= 1000, "{} UI changes in one call", ops.len());
        assert!(calls <= 4, "still not done after {calls} calls");
    }
    let hosts: std::collections::BTreeSet<&str> = of(&run.ops, "details")
        .iter()
        .map(|d| d["host"].as_str().unwrap())
        .collect();
    assert_eq!(hosts.len(), 1002);
}

#[test]
fn revoking_a_permission_reloads_it_without_and_its_controls_say_so() {
    let mut run = started(World::default());
    let (_, reply) = run
        .host
        .load(&Source::Dir(plugin()), &perms(&["serve:mesh.status", "serve:mesh.job"]))
        .unwrap();
    run.take(reply);
    run.tick();
    let ops = run.action("mesh", "Cut", "orion-2");
    assert!(of(&ops, "confirm").is_empty(), "it doesn't ask what it can't do");
    assert_eq!(
        texts(&ops)[0],
        "Allow serve:mesh.cut in :plugins to cut the Mesh from here."
    );
    let ops = run.action("mesh", "Apply", "orion-2");
    assert!(of(&ops, "confirm").is_empty());
    assert!(!run.serve.methods().iter().any(|m| m == "mesh.cut" || m == "mesh.apply"));
}

#[test]
fn reloaded_while_a_job_runs_it_follows_that_job() {
    let mut run = started(World {
        ticks: 3,
        ..World::default()
    });
    run.command("plan");
    let (_, reply) = run.host.load(&Source::Dir(plugin()), &perms(ALL)).unwrap();
    run.take(reply);
    let ops = run.tick();
    assert!(of(&ops, "timer").iter().any(|t| t["every"] == true), "polling again");
    let ops = run.tick();
    assert_eq!(of(&ops, "progress")[0]["spec"]["title"], "Planning the Mesh");
}

// ------------------------------------------------------------------- transcript

fn steps() -> Value {
    json!([
        { "do": "load", "grants": ALL },
        { "do": "timer" },
        { "do": "command", "args": "" },
        { "do": "action", "view": "mesh-links", "label": "Explain", "row": "l1" },
        { "do": "command", "args": "plan" },
        { "do": "timer" },
        { "do": "timer" },
        { "do": "action", "view": "mesh-plan", "label": "Apply", "row": "esx-02" },
        { "do": "confirm" },
        { "do": "timer" },
        { "do": "timer" },
        { "do": "action", "view": "mesh", "label": "Cut", "row": "orion-2" },
        { "do": "confirm" },
        { "do": "timer" },
        { "do": "timer" },
        { "do": "event", "name": "inventory_changed" },
        { "do": "command", "args": "cut sw-1" },
        { "do": "command", "args": "nonsense" },
        { "do": "command", "args": "plan" },
        { "do": "push", "state": "running" },
        { "do": "push", "state": "done" },
        { "do": "load", "grants": ["serve:mesh.status", "serve:mesh.job"] },
        { "do": "timer" },
        { "do": "command", "args": "plan" }
    ])
}

/// Ops as the transcript keeps them: each function as `"fn"`, a timer's id as `"N"`, each time
/// as `HH:MM:SS`, and an empty table as an empty list (Lua can't tell them apart).
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
        Value::String(s) => Value::String(times(s)),
        other => other.clone(),
    }
}

fn times(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    let digits = |at: usize| at + 2 <= b.len() && b[at..at + 2].iter().all(u8::is_ascii_digit);
    while i < b.len() {
        if digits(i) && b.get(i + 2) == Some(&b':') && digits(i + 3) && b.get(i + 5) == Some(&b':') && digits(i + 6) {
            out.push_str("HH:MM:SS");
            i += 8;
        } else {
            let c = s[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

#[test]
fn the_transcript_the_frontend_replays_is_what_the_real_lua_does() {
    let mut run = Run::with(Arc::new(FakeMesh::new(World::default())));
    let mut out = Vec::new();
    for step in steps().as_array().unwrap() {
        run.answers.clear();
        let ops = match step["do"].as_str().unwrap() {
            "load" => {
                let grants: Vec<&str> = step["grants"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|g| g.as_str().unwrap())
                    .collect();
                let (_, reply) = run.host.load(&Source::Dir(plugin()), &perms(&grants)).unwrap();
                run.take(reply)
            }
            "timer" => run.tick(),
            "command" => run.command(step["args"].as_str().unwrap()),
            "action" => run.action(
                step["view"].as_str().unwrap(),
                step["label"].as_str().unwrap(),
                step["row"].as_str().unwrap(),
            ),
            "confirm" => run.confirm(),
            "event" => run.event(step["name"].as_str().unwrap()),
            "push" => run.push(step["state"].as_str().unwrap()),
            other => panic!("no step {other}"),
        };
        // The call's own ops, then each answer's: the stand-in replays both, in order.
        let answers = Value::Array(std::mem::take(&mut run.answers));
        let own = ops.len()
            - answers
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_array().unwrap().len())
                .sum::<usize>();
        let mut step = step.clone();
        if step["do"] == "push" {
            step["payload"] = run.pushed.clone();
        }
        step["ops"] = normal(&Value::Array(ops[..own].to_vec()));
        step["answers"] = answers;
        step["serve"] = Value::Array(run.serve.take());
        out.push(step);
    }
    let transcript = serde_json::to_string_pretty(&json!({
        "about": "What plugins/mesh does in a scripted run, with every roster serve call it made and the answer, recorded by crates/roster-core/tests/plugin_mesh.rs (ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p roster-core --test plugin_mesh rewrites it). The fake Backend's stand-in replays it (mesh.test.ts).",
        "steps": out,
    }))
    .unwrap()
        + "\n";
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/src/plugins/mesh.transcript.json");
    if std::env::var_os("ROSTER_UPDATE_TRANSCRIPT").is_some() {
        std::fs::write(&path, &transcript).unwrap();
    }
    let recorded = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        recorded == transcript,
        "{} is out of date: run ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p roster-core --test plugin_mesh, and update the fake Backend's stand-in (app/src/backend/fakeMesh.ts) to match",
        path.display()
    );
}
