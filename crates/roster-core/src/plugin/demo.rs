//! The user's Plugins inside `:tutor`'s demo (ticket 66, decision Q123): a [`PluginHost`] of its
//! own, beside the real one, so a Plugin's tutorial can teach the Plugin itself. Its Plugins run
//! with the grants they have in the app, but nothing they do reaches the real Inventory, roster
//! serve, the network or their real files:
//!
//! - **roster serve** is [`DemoServe`]: the demo Inventory's Hosts the app hands over answer
//!   `hosts.list` and `host.get` (so `roster.inventory` reads the demo's Hosts), and `mesh.status`
//!   answers a made-up Mesh over them (#233, decision Q202); every other method is refused,
//!   saying it isn't on the demo Inventory.
//! - **The network** is never reached ([`PluginHost::offline`]): a request is checked against the
//!   grants as ever, then answers "not sent".
//! - **Files** are a throwaway folder: each demo gets a fresh, empty data folder under `scratch`
//!   (the temp dir), the user's alone, removed with the demo; one a crash left behind is swept at
//!   the next demo's start. A Plugin's real `plugin-data` is never read or written.

use super::{Limits, PluginHost, Serve};
use serde_json::{Value as Json, json};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// roster serve, as the demo has it: the demo Inventory's Hosts and a made-up Mesh over them, and
/// nothing else.
pub struct DemoServe {
    /// `{hosts: [...], groups: {...}}`, as `hosts.list` answers.
    hosts: Json,
}

impl DemoServe {
    pub fn new(hosts: Json) -> Self {
        DemoServe { hosts }
    }
}

impl Serve for DemoServe {
    fn call(&self, method: &str, params: Json) -> Result<Json, String> {
        match method {
            "hosts.list" => Ok(self.hosts.clone()),
            "host.get" => {
                let name = params["name"].as_str().unwrap_or_default();
                self.hosts["hosts"]
                    .as_array()
                    .and_then(|hs| hs.iter().find(|h| h["name"] == name))
                    .cloned()
                    .ok_or_else(|| format!("No Host named '{name}' on the demo Inventory (code 2)"))
            }
            "mesh.status" => mesh_status(&params),
            other => Err(format!(
                "{other} isn't on the demo Inventory: the tutorial's demo answers only hosts.list, host.get and mesh.status (code 3)"
            )),
        }
    }
}

/// The demo's Mesh, fixed and made up, for `demoHosts()`'s six (app/src/tutor/demo.ts): the lab's
/// `demo-01` to `demo-03` meshed, reaching each other both ways; `demo-01` reaches the office's
/// `demo-05` too, which didn't answer the last apply (pending); the lab's switch `demo-04` is
/// kept out (`mesh: false`), and the printer `demo-06` isn't named. Nothing connects anywhere.
const DEMO_MESHED: [&str; 3] = ["demo-01", "demo-02", "demo-03"];
const DEMO_LINKS: [(&str, &str); 1] = [("demo-01", "demo-05")];

/// `mesh.status` as real serve answers it (`status` and `brief` in src/roster/mesh.py), for
/// the demo's Mesh: plain, `grouped: true` (API 19) or `brief: true` (API 17).
fn mesh_status(params: &Json) -> Result<Json, String> {
    let flag = |name: &str| match params.get(name) {
        None | Some(Json::Null) => Ok(false),
        Some(Json::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("params.{name} must be true or false (code -32602)")),
    };
    let (grouped, brief) = (flag("grouped")?, flag("brief")?);
    if grouped && brief {
        return Err("params.grouped and params.brief don't go together (code -32602)".into());
    }
    let link = |from: &str, to: &str| json!({ "from": from, "to": to, "kind": "key" });
    let pairs = DEMO_MESHED
        .iter()
        .flat_map(|a| DEMO_MESHED.iter().filter(move |b| *b != a).map(move |b| (*a, *b)));
    let links: Vec<(&str, &str)> = pairs.chain(DEMO_LINKS).collect();
    let mut reach = serde_json::Map::new();
    for (from, _) in &links {
        let n = reach.get(*from).and_then(Json::as_u64).unwrap_or(0);
        reach.insert((*from).into(), json!(n + 1));
    }
    let mut out = json!({
        "links": links.iter().map(|(f, t)| link(f, t)).collect::<Vec<_>>(),
        "excluded": { "demo-04": "mesh: false" },
        "reach": reach,
        "members": ["demo-01", "demo-02", "demo-03", "demo-05"],
        "pending": { "demo-05": "no answer: ssh: connect to host 10.0.0.15 port 22: Connection timed out" },
        "cut_pending": {},
        "out_of_date": false,
        "warnings": [],
    });
    if grouped {
        // The pairs `meshed` covers go; the rest stay.
        out["links"] = DEMO_LINKS.iter().map(|(f, t)| link(f, t)).collect();
        out["meshed"] = json!({ "demo-lab": DEMO_MESHED });
    }
    if brief {
        // Untested Links all work (`asked`), with no hop: none is worth a look, so only counts.
        let mut reached = serde_json::Map::new();
        for (_, to) in &links {
            let n = reached.get(*to).and_then(Json::as_u64).unwrap_or(0);
            reached.insert((*to).into(), json!(n + 1));
        }
        out["links"] = json!([]);
        out["links_more"] = json!(0);
        out["link_count"] = json!(links.len());
        out["link_statuses"] = json!({ "asked": links.len() });
        out["reached"] = Json::Object(reached);
    }
    Ok(out)
}

/// A Plugin host for `:tutor`'s demo: [`DemoServe`], offline, and a throwaway data folder that
/// goes when this is dropped. Derefs to the [`PluginHost`] it is.
pub struct DemoHost {
    host: PluginHost,
    data: PathBuf,
}

static DEMOS: AtomicU64 = AtomicU64::new(0);

/// A demo folder's name: `roster-demo-PID-NANOS-N`.
const PREFIX: &str = "roster-demo-";

/// How old a demo folder of a process that's gone must be before [`sweep`] takes it: a pid seen
/// from another pid namespace (a container sharing the temp dir) can look dead while it runs.
const STALE_AFTER: Duration = Duration::from_secs(600);

/// Removes from `scratch` the demo folders an app of this user left behind when it couldn't clean
/// up (killed, crashed). One goes only if all of this holds: its name is a demo folder's with a
/// pid that isn't this process, it's a real directory (a link is never followed or removed), it's
/// this user's, the process its name gives is gone, and it's older than `min_age`. Never fails:
/// what it can't tell, it leaves. Not on Windows, whose temp dir is the user's own.
pub fn sweep(scratch: &Path, min_age: Duration) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let Ok(entries) = std::fs::read_dir(scratch) else {
            return;
        };
        // SAFETY: getuid has no preconditions and can't fail.
        let me = unsafe { libc::getuid() };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(pid) = name.to_str().and_then(demo_pid) else {
                continue;
            };
            if pid == std::process::id() {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if !meta.file_type().is_dir() || meta.uid() != me || alive(pid) {
                continue;
            }
            if meta
                .modified()
                .ok()
                .and_then(|m| m.elapsed().ok())
                .is_none_or(|age| age < min_age)
            {
                continue;
            }
            // std's remove_dir_all removes a link inside, never what it points at.
            let _ = std::fs::remove_dir_all(&path);
        }
    }
    #[cfg(not(unix))]
    let _ = (scratch, min_age);
}

/// The pid in a demo folder's name, if it is one.
#[cfg(unix)]
fn demo_pid(name: &str) -> Option<u32> {
    let mut parts = name.strip_prefix(PREFIX)?.split('-');
    let pid = parts
        .next()?
        .parse::<u32>()
        .ok()
        .filter(|p| *p > 0 && *p <= i32::MAX as u32)?;
    let rest: Vec<&str> = parts.collect();
    (rest.len() == 2
        && rest
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
    .then_some(pid)
}

/// Whether process `pid` runs (or can't be told: EPERM means it does, as someone else's).
#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists; nothing is sent.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

impl DemoHost {
    /// A demo over `hosts` (`hosts.list`'s answer), with its data folder made fresh in `scratch`:
    /// a new name, created (never an existing folder or a link), the user's alone (0700). Demo
    /// folders a crash left behind in `scratch` go first ([`sweep`]).
    pub fn new(hosts: Json, limits: Limits, scratch: &Path) -> Result<Self, String> {
        sweep(scratch, STALE_AFTER);
        let n = DEMOS.fetch_add(1, Ordering::SeqCst);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let data = scratch.join(format!("{PREFIX}{}-{stamp}-{n}", std::process::id()));
        // 0700 on unix; on Windows the temp dir is the user's own, and nothing is set (no `mut`
        // there, so its build has no unused_mut warning: issue #243).
        #[cfg(unix)]
        let make = {
            use std::os::unix::fs::DirBuilderExt;
            let mut make = std::fs::DirBuilder::new();
            make.mode(0o700);
            make
        };
        #[cfg(not(unix))]
        let make = std::fs::DirBuilder::new();
        make.create(&data)
            .map_err(|e| format!("couldn't make the demo's folder {}: {e}", data.display()))?;
        let host = PluginHost::new(Arc::new(DemoServe::new(hosts)), limits)
            .offline()
            .with_data(&data);
        Ok(DemoHost { host, data })
    }

    /// The demo's throwaway data folder (each Plugin's files are in `plugin-data/NAME` there).
    pub fn data(&self) -> &Path {
        &self.data
    }
}

impl Deref for DemoHost {
    type Target = PluginHost;
    fn deref(&self) -> &PluginHost {
        &self.host
    }
}

impl Drop for DemoHost {
    fn drop(&mut self) {
        // Each Plugin's thread ends with its slot, so none outlives the demo.
        for status in self.host.list() {
            self.host.unload(&status.manifest.name);
        }
        let _ = std::fs::remove_dir_all(&self.data);
    }
}

/// The one demo running, as the Tauri shell keeps it: each start [`DemoSlot::reserve`]s a number
/// before its host is made, every call names it, and a call, a stop or a late start naming any
/// other number reaches nothing. So a start that finishes after a newer one never takes its place,
/// and an old demo's calls never reach a new demo's Plugins of the same name.
#[derive(Default)]
pub struct DemoSlot {
    held: std::sync::Mutex<Option<(u64, Arc<DemoHost>)>>,
    next: AtomicU64,
}

impl DemoSlot {
    /// A number for a demo about to start: higher than every earlier one.
    pub fn reserve(&self) -> u64 {
        self.next.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Puts demo `id` in place of an older one (given back, to be dropped off the lock). Refused,
    /// with `host` dropped, when a newer demo is in place already.
    pub fn install(&self, id: u64, host: DemoHost) -> Result<Option<Arc<DemoHost>>, String> {
        let mut held = self.held.lock().map_err(|_| "the demo's Plugins broke".to_string())?;
        if held.as_ref().is_some_and(|(at, _)| *at > id) {
            return Err("a newer tutorial's demo started meanwhile".into());
        }
        Ok(held.replace((id, Arc::new(host))).map(|(_, h)| h))
    }

    /// Demo `id`, if it's the one running.
    pub fn get(&self, id: u64) -> Result<Arc<DemoHost>, String> {
        let held = self.held.lock().map_err(|_| "the demo's Plugins broke".to_string())?;
        match held.as_ref() {
            Some((at, h)) if *at == id => Ok(Arc::clone(h)),
            _ => Err("that tutorial's demo is over".into()),
        }
    }

    /// Takes demo `id` out, if it's the one running: drop it to stop its Plugins and remove its
    /// folder.
    pub fn stop(&self, id: u64) -> Option<Arc<DemoHost>> {
        let mut held = self.held.lock().ok()?;
        if held.as_ref().is_some_and(|(at, _)| *at == id) {
            held.take().map(|(_, h)| h)
        } else {
            None
        }
    }

    /// Takes whatever demo runs out (the app quits).
    pub fn stop_any(&self) -> Option<Arc<DemoHost>> {
        self.held.lock().ok()?.take().map(|(_, h)| h)
    }
}
