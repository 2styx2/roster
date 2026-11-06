//! A running Backend: `roster serve` started from a detected [`Candidate`], checked once at start
//! (`inventory.info` answers and its `api_version` is new enough), then used for calls.

use crate::detect::{Candidate, OVERRIDE_VAR, Target};
use crate::error::{BackendError, ErrorKind};
use crate::rpc::{CallError, Notify, RpcClient};
use crate::session::{
    FILL_WAIT, FillError, FillRule, FillTarget, Hop, LoginAs, Prepared, Secret, SessionCommand, SessionEvent,
    SessionId, SessionManager, Size, session_command,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Why making an Inventory failed (`inventory_create`): which roster to run couldn't be found or
/// started (a [`BackendError`], with its kind and what to do, as `backend_connect` says it), or
/// serve's call failed. On the wire it's either shape as it is.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "InventoryCreateError"))]
pub enum CreateError {
    Start(BackendError),
    Call(CallError),
}

impl From<BackendError> for CreateError {
    fn from(e: BackendError) -> Self {
        CreateError::Start(e)
    }
}

impl From<CallError> for CreateError {
    fn from(e: CallError) -> Self {
        CreateError::Call(e)
    }
}

/// The oldest `roster serve` API this app understands.
pub const REQUIRED_API_VERSION: i64 = 1;

/// roster's own error codes (src/roster/errors.py; by name in docs/serve-contract.json, which the
/// `contract` tests below hold these to).
pub const INVENTORY_ERROR: i64 = 1;
/// `session.prepare` (API 11, ticket 36): roster has no host key recorded for the Host (`data`: its
/// address and port). The app asks the user (`host.scan_key {host}`, then [`Backend::trust_host_key`]).
pub const HOST_KEY_UNKNOWN: i64 = 44;
const METHOD_NOT_FOUND: i64 = -32601;
/// A job's states while it runs (src/roster/jobs.py `RUNNING`; `job_states` in
/// docs/serve-contract.json, which a `contract` test holds this to). Any other is over.
const JOB_RUNNING: &[&str] = &["running", "stopping"];
/// The over state of a job that failed: its `error` says why.
const JOB_FAILED: &str = "failed";

/// Where a Quick Connect goes (ticket 14): `user@address:port`, a box that isn't in the Inventory,
/// and the SHA256 fingerprint of the host key the user was shown (`host.scan_key {address, port}`).
#[derive(Debug, Clone, Deserialize)]
pub struct QuickTarget {
    pub user: String,
    pub address: String,
    pub port: u16,
    pub fingerprint: String,
}

/// A password the user typed for a Session (ticket 16, a Quick Connect's ticket 14), on its way to
/// serve's stdin: moved into the request, which is wiped once sent (rpc.rs), and wiped itself if
/// it's dropped before; never logged, stored or put in an error. It comes back only as an askpass
/// token. `save` ("Save to vault", ticket 15): serve holds
/// it until the Session has logged in, and only its id comes back ([`Ready::held`]).
pub struct Typed {
    pub password: String,
    pub save: bool,
}

impl Drop for Typed {
    fn drop(&mut self) {
        // SAFETY: zeros are valid UTF-8, so the String stays a valid String.
        crate::wipe::wipe_bytes(unsafe { self.password.as_mut_vec() });
    }
}

impl std::fmt::Debug for Typed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Typed")
            .field("save", &self.save)
            .finish_non_exhaustive()
    }
}

/// A Session the app asks for.
#[derive(Debug)]
pub enum Open {
    /// To an Inventory Host (`session.prepare`), with the password typed for an `auth: prompt`
    /// Host. `marks` is the token roster's shell hooks put on this attempt's marks (decision Q131
    /// (a)): the core follows them for a nested ssh's fill (ticket 162).
    Host {
        host: String,
        typed: Option<Typed>,
        marks: Option<String>,
    },
    /// A Quick Connect (`quick.prepare`, ticket 14); without a typed password it logs in with the
    /// Box's keys.
    Quick { to: QuickTarget, typed: Option<Typed> },
}

/// A Session's command, ready to start, with what serve said about it: its id for a Quick Connect
/// (`quick.save` refers to it), and the id it holds a typed password under for "Save to vault".
#[derive(Debug)]
pub struct Ready {
    pub command: SessionCommand,
    pub quick: Option<String>,
    pub held: Option<String>,
}

/// A Session that's started, as the frontend hears of it.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct OpenedSession {
    pub id: SessionId,
    /// How it logs in: "key" or "password", as serve said.
    #[cfg_attr(feature = "ts", ts(type = "\"key\" | \"password\""))]
    pub auth: String,
    /// serve's id for a Quick Connect (ticket 14).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub quick: Option<String>,
    /// The id serve holds a typed password under for "Save to vault" (tickets 15, 16), when asked.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub held: Option<String>,
    /// Its PTY is Windows' ConPTY: the app offers only the fills the core makes there (decision
    /// Q151 (i), ticket 162).
    pub conpty: bool,
    /// The ssh user the core fills sudo's prompt for (`session.prepare`'s login), so the app judges
    /// sudo's prompt by the same user (the review of #308, #6). None for a Quick Connect.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub user: Option<String>,
}

/// Is `fingerprint` shaped like `SHA256:<base64>`? Only that is ever sent to be trusted.
fn sha256_shaped(fingerprint: &str) -> bool {
    let b64 = fingerprint.strip_prefix("SHA256:").unwrap_or("");
    !b64.is_empty()
        && b64.len() <= 64
        && b64
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/' || c == b'=')
}

/// How long the app waits for a method's answer, in seconds, where that isn't [`DEFAULT_TIMEOUT`].
/// Each is longer than `roster serve`'s own deadline for the method plus what serve may still run
/// once that's past (each method's `deadline` and the `after_deadline` in docs/serve-contract.json,
/// which a `contract` test below holds this to), so serve always answers before the app gives up,
/// and its answer says what actually happened. `vault.login` has no serve deadline: each bw step is
/// held to 40 s, and a wrong code runs bw once more.
///
/// [`DEFAULT_TIMEOUT`]: crate::rpc::DEFAULT_TIMEOUT
pub const CALL_SECS: &[(&str, u64)] = &[
    ("host.add", 180),
    ("changes.publish", 180),
    ("inventory.pull", 90),
    ("host.check", 90),
    ("box.check", 90),
    ("host.verify_login", 90),
    ("vault.create_item", 90),
    ("quick.save", 90),
    ("host.save_login", 90),
    ("vault.login", 100),
    ("mesh.plan", 300),
    ("mesh.apply", 300),
    ("mesh.cut", 120),
    ("inventory.create", 120),
];

/// The first serve API with `host.check {background: true}` and `host.check_job` (ticket 108).
pub const CHECK_JOBS_API_VERSION: i64 = 21;
/// The first serve API whose `session.fill` takes `hop` (ticket 120): an older one ignores it and
/// answers for the Session's own Host, so the core never sends it a nested fill.
pub const NESTED_FILL_API_VERSION: i64 = 26;
/// serve's "won't fill this prompt" code (errors.md row 143), which the core also gives a fill it
/// refused before typing anything (ticket 137, row 163): the app then offers the prompt again.
pub const FILL_REFUSED: i64 = 130;
/// How long [`Backend::check_host`] waits for serve's word that its check job ended
/// (`job.progress`) before it asks `host.check_job` anyway: serve sends that word, so this only
/// bounds a word lost on the way.
pub const CHECK_RECHECK: Duration = Duration::from_secs(5);

/// How long the app waits for `method` (see [`CALL_SECS`]).
pub fn timeout_for(method: &str) -> Duration {
    CALL_SECS
        .iter()
        .find(|(m, _)| *m == method)
        .map_or(crate::rpc::DEFAULT_TIMEOUT, |(_, s)| Duration::from_secs(*s))
}

/// A poisoned lock still holds a usable map here.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// serve's id for a job, as text (`check-3`; an older serve's are numbers).
fn job_id(job: &Value) -> String {
    job.as_str().map_or_else(|| job.to_string(), str::to_string)
}

/// The check jobs calls wait for, by id: how many calls wait for each, and whether serve has said
/// it ended since a call last looked (`job.progress`, which serve sends as a job ends).
#[derive(Default)]
struct CheckEnds {
    jobs: Mutex<HashMap<String, (usize, bool)>>,
    changed: Condvar,
}

impl CheckEnds {
    /// A notification from serve: a check job's end wakes the calls that wait for it.
    fn heard(&self, method: &str, params: &Value) {
        if method != "job.progress" || params.get("kind").and_then(Value::as_str) != Some("check") {
            return;
        }
        if params
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|s| JOB_RUNNING.contains(&s))
        {
            return;
        }
        let id = job_id(params.get("job").unwrap_or(&Value::Null));
        if let Some((_, ended)) = lock(&self.jobs).get_mut(&id) {
            *ended = true;
            self.changed.notify_all();
        }
    }

    fn watch(&self, id: &str) -> CheckWatch<'_> {
        lock(&self.jobs).entry(id.to_string()).or_default().0 += 1;
        CheckWatch {
            ends: self,
            id: id.to_string(),
        }
    }
}

/// One call's wait for a check job's end; forgets the job once no call waits for it.
struct CheckWatch<'a> {
    ends: &'a CheckEnds,
    id: String,
}

impl CheckWatch<'_> {
    /// Waits until serve says the job ended, or `until`; takes that word, so the next wait waits
    /// for another.
    fn wait(&self, until: Instant) {
        let mut jobs = lock(&self.ends.jobs);
        loop {
            let now = Instant::now();
            match jobs.get_mut(&self.id) {
                Some((_, ended)) if *ended => {
                    *ended = false;
                    return;
                }
                _ if now >= until => return,
                _ => {}
            }
            jobs = self
                .ends
                .changed
                .wait_timeout(jobs, until - now)
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0;
        }
    }
}

impl Drop for CheckWatch<'_> {
    fn drop(&mut self) {
        let mut jobs = lock(&self.ends.jobs);
        if let Some((waiting, _)) = jobs.get_mut(&self.id) {
            *waiting -= 1;
            if *waiting == 0 {
                jobs.remove(&self.id);
            }
        }
    }
}

/// One call's wait for a check of the core's own: forgets the job once no call waits for it.
struct OwnCheck<'a> {
    checks: &'a Mutex<HashMap<String, usize>>,
    id: String,
}

impl Drop for OwnCheck<'_> {
    fn drop(&mut self) {
        let mut checks = lock(self.checks);
        if let Some(waiting) = checks.get_mut(&self.id) {
            *waiting -= 1;
            if *waiting == 0 {
                checks.remove(&self.id);
            }
        }
    }
}

/// What the UI learns about the Backend once it's up.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct BackendInfo {
    /// "Local" or "WSL: <distro>": the label the UI shows.
    pub backend: String,
    /// Where serve runs: on this machine, or in a WSL distro.
    pub kind: BackendKind,
    /// The WSL distro serve runs in (`kind: "wsl"`); null on this machine. Empty: WSL's default.
    pub distro: Option<String>,
    /// The command line that runs serve.
    pub command: Vec<String>,
    /// The `inventory.info` result as roster sent it (its shape is serve's, not the core's).
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub inventory: Value,
}

/// Where serve runs ([`Target`]), as the frontend tells them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum BackendKind {
    Local,
    Wsl,
}

/// A check the core has under way (`host.check {background: true}`), as it starts: serve's job id,
/// and whether it's the app's own to stop (#221 item 1): the core started it, or joined a check it
/// had started itself. A check another caller started (a Plugin's `host.check`) isn't: stopping it
/// would cut that caller's answer short.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct CheckStarted {
    pub job: String,
    pub own: bool,
}

pub struct Backend {
    client: RpcClient,
    /// The check jobs this core started and still waits for, each with how many of its calls wait
    /// for it: only these can be stopped through [`Backend::stop_check`].
    own_checks: Mutex<HashMap<String, usize>>,
    /// The check jobs calls wait for, woken by serve's `job.progress`.
    check_ends: Arc<CheckEnds>,
    /// Where serve (and so every Session) runs.
    pub target: Target,
    pub info: BackendInfo,
}

impl Backend {
    /// Starts serve as `c` runs it and checks it answers `inventory.info` with an API this app
    /// understands. serve's notifications (`inventory.changed`, `job.progress`) go to `notify`.
    pub fn start(c: &Candidate, notify: Option<Notify>) -> Result<Backend, BackendError> {
        let shown = c.serve_argv.join(" ");
        let check_ends = Arc::new(CheckEnds::default());
        let heard: Notify = {
            let ends = Arc::clone(&check_ends);
            Arc::new(move |method: &str, params: Value| {
                ends.heard(method, &params);
                if let Some(notify) = &notify {
                    notify(method, params);
                }
            })
        };
        let client = spawn_serve(c, Some(heard)).map_err(|e| {
            BackendError::new(
                ErrorKind::Failed,
                "The backend couldn't be started.",
                "Check that the command exists.",
            )
            .with_detail(format!("{shown}: {e}"))
        })?;
        let inventory = client
            .call("inventory.info", json!({}))
            .map_err(|e| classify(e, &shown))?;
        let api = inventory.get("api_version").and_then(Value::as_i64).unwrap_or(0);
        if api < REQUIRED_API_VERSION {
            return Err(too_old(format!(
                "roster speaks API version {api}; the roster app needs {REQUIRED_API_VERSION} or newer."
            ))
            .with_detail(shown));
        }
        Ok(Backend {
            client,
            own_checks: Default::default(),
            check_ends,
            target: c.target.clone(),
            info: BackendInfo {
                backend: c.target.label(),
                kind: match c.target {
                    Target::Local => BackendKind::Local,
                    Target::Wsl { .. } => BackendKind::Wsl,
                },
                distro: match &c.target {
                    Target::Local => None,
                    Target::Wsl { distro } => Some(distro.clone()),
                },
                command: c.serve_argv.clone(),
                inventory,
            },
        })
    }

    /// A new Inventory for the app's first run (T212, serve API 28): with none found,
    /// [`Backend::start`] can't start (its `inventory.info` fails), so `inventory.create` goes to a
    /// serve started for this one call, which then stops. serve writes `roster.yml` (ADR 0001);
    /// the app then connects again, and the new serve finds it. An older serve's refusal comes back
    /// as it is (`-32601`, or `1` from one that answers every method so). `cancel` stops it from
    /// another thread while it runs: serve stops a clone under way and takes away what it left
    /// (#417 L5).
    pub fn create_inventory(c: &Candidate, params: Value, cancel: &CreateCancel) -> Result<Value, CreateError> {
        let client = Arc::new(spawn_serve(c, None).map_err(|e| CallError::Io {
            message: format!("the backend couldn't be started: {e}"),
        })?);
        *lock(&cancel.0) = Some(Arc::clone(&client));
        let r = client.call_timeout("inventory.create", params, timeout_for("inventory.create"));
        lock(&cancel.0).take();
        Ok(r?)
    }

    /// The `api_version` serve reported at start.
    pub fn api_version(&self) -> i64 {
        self.info
            .inventory
            .get("api_version")
            .and_then(Value::as_i64)
            .unwrap_or(0)
    }

    /// roster's diagnostics for one Host (`host.check`): `{host, ok, steps}`. From serve API 21
    /// (ticket 108) the check is a job in serve: it's started in the background, and
    /// `host.check_job` (a quick read) is asked for its result once serve says it ended
    /// (`job.progress`), so no worker of serve waits for the check meanwhile. An older serve gets
    /// the waiting form. `on_start` hears the check's job once serve has it under way, so the app
    /// can stop it ([`Backend::stop_check`]); an older serve has no job, and it isn't called.
    ///
    /// Past `limit` this is [`CallError::Timeout`]. Giving up stops the job only when serve says
    /// this call started it (`joined: false`, serve API 22): a check it joined (one per Host at a
    /// time) is another caller's too, which may still be waiting for it.
    pub fn check_host(
        &self,
        host: &str,
        limit: Duration,
        on_start: impl FnOnce(&CheckStarted),
    ) -> Result<Value, CallError> {
        if self.api_version() < CHECK_JOBS_API_VERSION {
            return self.call("host.check", json!({ "host": host }));
        }
        let started = self.call("host.check", json!({ "host": host, "background": true }))?;
        let job = started.get("job").cloned().ok_or_else(|| CallError::Io {
            message: "host.check answered without a job".into(),
        })?;
        let started_here = started.get("joined").and_then(Value::as_bool) == Some(false);
        let id = job_id(&job);
        // Before the first `host.check_job`: an end serve tells of after it is heard.
        let watch = self.check_ends.watch(&id);
        let own = {
            let mut checks = lock(&self.own_checks);
            match checks.get_mut(&id) {
                Some(waiting) => *waiting += 1,
                None if started_here => {
                    checks.insert(id.clone(), 1);
                }
                None => {}
            }
            checks.contains_key(&id)
        };
        let _waiting = own.then(|| OwnCheck {
            checks: &self.own_checks,
            id: id.clone(),
        });
        on_start(&CheckStarted { job: id, own });
        let end = Instant::now() + limit;
        loop {
            let r = self.call("host.check_job", json!({ "job": job }))?;
            match r.get("state").and_then(Value::as_str) {
                Some(s) if JOB_RUNNING.contains(&s) => {}
                Some(JOB_FAILED) => {
                    let e = r.get("error").cloned().unwrap_or(Value::Null);
                    return Err(CallError::Rpc {
                        code: e.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                        message: e.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                        data: e.get("data").cloned(),
                    });
                }
                _ => {
                    return r.get("result").cloned().ok_or_else(|| CallError::Io {
                        message: "host.check_job answered without a result".into(),
                    });
                }
            }
            let now = Instant::now();
            if now >= end {
                if started_here {
                    // The answer is the timeout either way: a stop serve refuses (the check just
                    // ended) leaves nothing for the caller to do.
                    let _ = self.call("jobs.stop", json!({ "kind": "check", "job": job }));
                }
                return Err(CallError::Timeout);
            }
            watch.wait(end.min(now + CHECK_RECHECK));
        }
    }

    /// Stop a check of the app's own ([`CheckStarted::own`]) at its next step (`jobs.stop`): the
    /// call waiting for it then answers with the steps that ran and the rest skipped. `{job,
    /// stopping}`; `stopping: false` without asking serve for a job that isn't the core's own (over,
    /// or another caller's), and from serve for one that's over by now.
    pub fn stop_check(&self, job: &str) -> Result<Value, CallError> {
        if !lock(&self.own_checks).contains_key(job) {
            return Ok(json!({ "kind": "check", "job": job, "stopping": false }));
        }
        self.call("jobs.stop", json!({ "kind": "check", "job": job }))
    }

    /// A call, waiting as long as [`timeout_for`] says for that method.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, CallError> {
        self.client.call_timeout(method, params, timeout_for(method))
    }

    /// A call the frontend makes as it is ([`crate::serve_api::PASS_THROUGH`]); any other method
    /// is refused without asking serve.
    pub fn pass(&self, method: &str, params: Value) -> Result<Value, CallError> {
        let Some(method) = crate::serve_api::passes(method) else {
            let mut params = params;
            crate::wipe::wipe_value(&mut params);
            return Err(CallError::Io {
                message: format!("{method} isn't a roster serve method the app calls"),
            });
        };
        self.call(method, params)
    }

    /// The command for the Session `open` asks for, from serve (`session.prepare` or
    /// `quick.prepare`). Refusals keep roster's code and wording: 2 unknown Host, 20 not reviewed,
    /// 21 this box isn't set up, 44 no host key recorded; for a Quick Connect 23 if the host key
    /// isn't the one the user was shown, or 43 if it differs from one roster recorded.
    pub fn prepare(&self, open: Open) -> Result<Ready, CallError> {
        let (method, mut params, typed, fill) = match open {
            Open::Host { host, typed, marks } => (
                "session.prepare",
                json!({ "host": host }),
                typed,
                FillRule::Host { marks },
            ),
            Open::Quick { to, typed } => {
                if !sha256_shaped(&to.fingerprint) {
                    return Err(CallError::Io {
                        message: "quick.prepare needs the SHA256:... fingerprint the user was shown".into(),
                    });
                }
                let params = json!({
                    "user": to.user,
                    "address": to.address,
                    "port": to.port,
                    "fingerprint": to.fingerprint,
                });
                ("quick.prepare", params, typed, FillRule::Never)
            }
        };
        let quick = method == "quick.prepare";
        if let Some(mut typed) = typed {
            params["password"] = Value::String(std::mem::take(&mut typed.password));
            if typed.save {
                params["save"] = Value::Bool(true);
            }
        }
        let v = self.call(method, params)?;
        // serde's message quotes the bad value, and `env` holds the askpass token: name the field
        // and the expected shape only.
        let prepared: Prepared = serde_json::from_value(v.clone()).map_err(|_| CallError::Io {
            message: format!("{method} answered something unexpected: {}", prepare_shape_error(&v)),
        })?;
        let quick = if quick {
            Some(
                v.get("quick")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CallError::Io {
                        message: "quick.prepare answered something unexpected: `quick` isn't a string".into(),
                    })?
                    .to_owned(),
            )
        } else {
            None
        };
        Ok(Ready {
            command: session_command(&self.target, &prepared, fill),
            quick,
            held: v.get("held").and_then(Value::as_str).map(str::to_owned),
        })
    }

    /// Opens the Session `open` asks for in a PTY of `size` ([`Backend::prepare`], then
    /// [`SessionManager::open`]): `sink` gets its output, then its exit. Prepared right before the
    /// spawn: a password Session's askpass token lives 60 s, so every open (and every reconnect)
    /// gets a fresh one.
    pub fn open_session(
        &self,
        sessions: &SessionManager,
        open: Open,
        size: Size,
        sink: impl Fn(SessionEvent) + Send + Sync + 'static,
    ) -> Result<OpenedSession, CallError> {
        let ready = self.prepare(open)?;
        let user = ready.command.fill_as().map(|t| t.login.user.clone());
        let id = sessions
            .open(&ready.command, size, sink)
            .map_err(|e| CallError::Io { message: e.to_string() })?;
        Ok(OpenedSession {
            id,
            auth: ready.command.auth,
            quick: ready.quick,
            held: ready.held,
            conpty: sessions.conpty(),
            user,
        })
    }

    /// Records the key the user was shown and trusted (`host.trust_key`). serve fetches it again
    /// and refuses (23) if the Host now offers another one. Only a `SHA256:` fingerprint is sent,
    /// never a key or anything else the frontend might pass.
    pub fn trust_host_key(&self, host: &str, fingerprint: &str) -> Result<Value, CallError> {
        if !sha256_shaped(fingerprint) {
            return Err(CallError::Io {
                message: "host.trust_key needs the SHA256:... fingerprint the user was shown".into(),
            });
        }
        self.call("host.trust_key", json!({ "host": host, "fingerprint": fingerprint }))
    }

    /// Fills the password prompt Session `id` shows, when the user pressed the fill key at one
    /// (ticket 119, decision Q129): [`SessionManager::fill`], waiting [`FILL_WAIT`], with the
    /// password from serve for the Host the Session was opened to ([`Backend::fill_secret`]; its
    /// own record, never a name from the frontend) or for `hop`, a nested ssh's Host as the
    /// frontend resolved it (ticket 120). `prompt` is the line the frontend read off the screen.
    /// `{host}` names the Host whose password it typed; the password never leaves the core.
    /// A refusal comes back as [`fill_refusal`] says; one at sudo's own prompt whose mask roster
    /// didn't take hands `log` what the probe drew (ticket 155: no text but `*` and space in it),
    /// for the app's log only.
    pub fn fill_session(
        &self,
        sessions: &SessionManager,
        id: SessionId,
        prompt: &str,
        hop: Option<&Hop>,
        log: impl FnOnce(&str),
    ) -> Result<Value, CallError> {
        let filled = sessions.fill(id, FILL_WAIT, prompt, hop, |target| {
            self.fill_secret(target, prompt, hop.map(|h| &h.to))
        });
        filled.map(|host| json!({ "host": host })).map_err(|e| {
            if let Some(line) = e.log_line() {
                log(&line);
            }
            fill_refusal(e)
        })
    }

    /// The password for the prompt a Host Session shows (`session.fill {host, prompt}`, serve API
    /// 25, ticket 119): for [`crate::session::SessionManager::fill`] to type, and nothing else.
    /// The value is moved out of serve's answer into a [`Secret`] and never copied, logged or put
    /// in an error; serve's refusals (130, 131, the vault's) come back as they are.
    ///
    /// `hop` is a nested ssh's Host, as the frontend resolved it (ticket 120, serve API 26): serve
    /// then answers for that Host, still checking the Session's own.
    pub fn fill_secret(
        &self,
        target: &FillTarget,
        prompt: &str,
        hop: Option<&FillTarget>,
    ) -> Result<Secret, CallError> {
        let LoginAs { address, port, user } = &target.login;
        let mut params =
            json!({ "host": target.host, "address": address, "port": port, "user": user, "prompt": prompt });
        if let Some(hop) = hop {
            let api = self.api_version();
            if api < NESTED_FILL_API_VERSION {
                return Err(CallError::Io {
                    message: format!(
                        "filling a nested ssh's prompt needs roster serve API {NESTED_FILL_API_VERSION}; this one speaks {api}, so roster didn't fill it"
                    ),
                });
            }
            let LoginAs { address, port, user } = &hop.login;
            params["hop"] = json!({ "host": hop.host, "address": address, "port": port, "user": user });
        }
        let v = self.call("session.fill", params)?;
        let Value::Object(mut answer) = v else {
            return Err(fill_shape_error());
        };
        match answer.remove("password") {
            Some(Value::String(password)) if !password.is_empty() => Ok(Secret::new(password)),
            _ => Err(fill_shape_error()),
        }
    }

    /// False once serve has exited; the app then has to start a new one.
    pub fn is_alive(&self) -> bool {
        !self.client.is_dead()
    }
}

/// session.fill's answer had no password: by name only, never a value.
fn fill_shape_error() -> CallError {
    CallError::Io {
        message: "session.fill answered something unexpected: `password` isn't a non-empty string".into(),
    }
}

/// Which part of a `session.prepare` result has the wrong shape, by name only (never a value).
fn prepare_shape_error(v: &Value) -> String {
    let Some(obj) = v.as_object() else {
        return "the result isn't an object".into();
    };
    let argv_ok = obj
        .get("argv")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().all(Value::is_string));
    if !argv_ok {
        return "`argv` isn't a list of strings".into();
    }
    match obj.get("env") {
        None | Some(Value::Null) => {}
        Some(Value::Object(env)) => {
            if let Some(k) = env.iter().find(|(_, v)| !v.is_string()).map(|(k, _)| k) {
                return format!("`env.{k}` isn't a string");
            }
        }
        Some(_) => return "`env` isn't an object of strings".into(),
    }
    for field in ["host", "auth"] {
        if !obj.get(field).is_some_and(Value::is_string) {
            return format!("`{field}` isn't a string");
        }
    }
    "it doesn't match {argv, env, host, auth}".into()
}

fn too_old(message: String) -> BackendError {
    BackendError::new(
        ErrorKind::RosterTooOld,
        message,
        format!(
            "Upgrade roster (`uv tool install --force --reinstall .` in the roster repo), or point \
             {OVERRIDE_VAR} at a newer one, e.g. `uv run --project /home/you/work/roster roster`."
        ),
    )
}

/// The first-run dialog's create under way, if any, for its Cancel (#417 L5). Cloned handles share it.
#[derive(Clone, Default)]
pub struct CreateCancel(Arc<Mutex<Option<Arc<RpcClient>>>>);

impl CreateCancel {
    /// Asks the serve making the Inventory to stop (`$/cancel`): true if a create was under way.
    pub fn cancel(&self) -> bool {
        let client = lock(&self.0).clone();
        match client {
            Some(c) => {
                c.cancel_pending();
                true
            }
            None => false,
        }
    }
}

/// `roster serve` as `c` runs it, its stdout the JSON-RPC client's.
fn spawn_serve(c: &Candidate, notify: Option<Notify>) -> std::io::Result<RpcClient> {
    let mut cmd = Command::new(&c.serve_argv[0]);
    cmd.args(&c.serve_argv[1..]);
    if c.target == Target::Local && cfg!(windows) {
        // Native Windows roster: Python's UTF-8 mode, so roster.yml, the vault CLI's output and
        // every file roster writes are UTF-8 whatever the Windows code page is.
        cmd.env("PYTHONUTF8", "1");
    }
    RpcClient::spawn_with(cmd, notify)
}

/// A failure of the first call, as the error the user sees.
fn classify(e: CallError, shown: &str) -> BackendError {
    match e {
        CallError::Exited { stderr, code } => {
            // argparse's exact words for an unknown command `serve` (#479): any other "invalid choice" is a
            // failure of its own, even in a line that says serve, so the app can run more than `roster serve`
            if stderr.contains("invalid choice: 'serve'") {
                too_old("This roster has no `serve` command (it predates the roster app).".into()).with_detail(stderr)
            } else {
                BackendError::new(
                    ErrorKind::Failed,
                    format!(
                        "roster serve exited before answering (exit code {}).",
                        code.map_or("?".into(), |c| c.to_string())
                    ),
                    "Run the command below in a terminal to see what's wrong.",
                )
                .with_detail(format!("{shown}\n{stderr}"))
            }
        }
        CallError::Rpc {
            code: INVENTORY_ERROR,
            message,
            data,
        } => {
            // serve's data.path is null only when it found no roster.yml at all (T212, #417 M1)
            let found = data.as_ref().and_then(|d| d.get("path")).and_then(Value::as_str);
            match found {
                None => BackendError::new(
                    ErrorKind::InventoryNotFound,
                    format!("roster couldn't load the Inventory: {message}"),
                    "Make one: `roster init --blank` in a terminal (or `roster init --inventory repo:URL` for \
                     your team's repo), or set ROSTER_CONFIG in ~/.profile; then Retry.",
                ),
                Some(path) => BackendError::new(
                    ErrorKind::InventoryInvalid,
                    format!("roster couldn't load the Inventory: {message}"),
                    data.as_ref()
                        .and_then(|d| d.get("fix"))
                        .and_then(Value::as_str)
                        .map_or_else(|| format!("Fix {path}, then Retry."), |f| format!("{f}, then Retry.")),
                ),
            }
            .with_detail(shown)
        }
        CallError::Rpc {
            code: METHOD_NOT_FOUND,
            message,
            ..
        } => too_old(format!("This roster doesn't know inventory.info ({message}).")).with_detail(shown),
        other => BackendError::new(
            ErrorKind::Failed,
            format!("The backend didn't start properly: {other}"),
            "Run the command below in a terminal to see what's wrong.",
        )
        .with_detail(shown),
    }
}

/// A fill's refusal as the app hears it (tickets 119, 120, 137). One that typed nothing at all
/// ([`FillError::retry_fix`]) carries [`FILL_REFUSED`], as serve's own refusals do, so the app
/// offers the prompt again; serve's come back as they are; one that typed the probe has no code,
/// so the prompt stays spent. None of them holds the secret.
pub fn fill_refusal(e: FillError<CallError>) -> CallError {
    if let FillError::Lookup(e) = e {
        return e;
    }
    match e.retry_fix() {
        Some(fix) => CallError::Rpc {
            code: FILL_REFUSED,
            message: e.to_string(),
            data: Some(json!({ "fix": fix })),
        },
        None => CallError::Io { message: e.to_string() },
    }
}

/// The constants above are roster's facts: each is checked against `docs/serve-contract.json`,
/// which `scripts/gen-serve-api.py` writes from serve's method registry and `errors.py`.
#[cfg(test)]
mod contract {
    use super::*;
    use crate::plugin::permission::SERVE_METHODS;

    fn contract() -> Value {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/serve-contract.json"
        )))
        .expect("docs/serve-contract.json is JSON")
    }

    #[test]
    fn the_codes_are_rosters() {
        let c = contract();
        assert_eq!(c["codes"]["INVENTORY_ERROR"], INVENTORY_ERROR);
        assert_eq!(c["codes"]["HOST_KEY_UNKNOWN"], HOST_KEY_UNKNOWN);
        assert_eq!(c["codes"]["FILL_REFUSED"], FILL_REFUSED);
        assert_eq!(c["json_rpc"]["METHOD_NOT_FOUND"], METHOD_NOT_FOUND);
        assert_eq!(c["codes"]["UNKNOWN_HOST"], crate::plugin::code::UNKNOWN_HOST);
        assert_eq!(c["codes"]["ROSTER_ERROR"], crate::plugin::code::ROSTER_ERROR);
        assert_eq!(c["json_rpc"]["INVALID_PARAMS"], crate::plugin::code::INVALID_PARAMS);
    }

    #[test]
    fn the_job_states_are_rosters() {
        let c = contract();
        assert_eq!(c["job_states"]["running"], json!(JOB_RUNNING));
        assert!(c["job_states"]["over"].as_array().unwrap().contains(&json!(JOB_FAILED)));
    }

    #[test]
    fn the_api_versions_are_where_serve_added_each() {
        let c = contract();
        assert_eq!(c["methods"]["host.check_job"]["since"], CHECK_JOBS_API_VERSION);
        assert_eq!(c["methods"]["session.fill"]["forms"][1], NESTED_FILL_API_VERSION);
        assert!(c["api_version"].as_i64().is_some_and(|v| v >= REQUIRED_API_VERSION));
    }

    #[test]
    fn the_app_waits_longer_than_every_deadline_plus_what_runs_after_it() {
        let c = contract();
        let after = c["after_deadline"].as_f64().expect("after_deadline");
        let methods = c["methods"].as_object().expect("methods");
        for (method, _) in CALL_SECS {
            assert!(
                methods.contains_key(*method),
                "CALL_SECS names {method}, which serve doesn't have"
            );
        }
        for (method, m) in methods {
            if let Some(deadline) = m["deadline"].as_f64() {
                let wait = timeout_for(method).as_secs_f64();
                assert!(
                    deadline + after < wait,
                    "{method}: serve's {deadline} s + {after} s isn't under the app's {wait} s"
                );
            }
        }
    }

    #[test]
    fn a_plugin_is_granted_only_methods_serve_has() {
        let c = contract();
        for method in SERVE_METHODS {
            assert!(c["methods"].get(*method).is_some(), "{method} isn't a serve method");
        }
    }

    #[test]
    fn the_shell_passes_through_only_methods_serve_has() {
        let c = contract();
        for method in crate::serve_api::PASS_THROUGH {
            assert!(c["methods"].get(*method).is_some(), "{method} isn't a serve method");
        }
    }
}
