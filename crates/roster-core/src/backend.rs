//! A running Backend: `roster serve` started from a detected [`Candidate`], checked once at start
//! (`inventory.info` answers and its `api_version` is new enough), then used for calls.

use crate::detect::{Candidate, OVERRIDE_VAR, Target};
use crate::error::{BackendError, ErrorKind};
use crate::rpc::{CallError, Notify, RpcClient};
use crate::session::{FillTarget, LoginAs, Prepared, Secret, SessionCommand, session_command};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::process::Command;

/// The oldest `roster serve` API this app understands.
pub const REQUIRED_API_VERSION: i64 = 1;

/// roster's own error codes (roster/src/roster/serve.py).
pub const INVENTORY_ERROR: i64 = 1;
/// `session.prepare` (API 11, ticket 36): roster has no host key recorded for the Host (`data`: its
/// address and port). The app asks the user ([`Backend::scan_host_key`], then [`Backend::trust_host_key`]).
pub const HOST_KEY_UNKNOWN: i64 = 44;
const METHOD_NOT_FOUND: i64 = -32601;

/// Where a Quick Connect goes (ticket 14): `user@address:port`, a box that isn't in the Inventory,
/// and the SHA256 fingerprint of the host key the user was shown (`host.scan_key {address, port}`).
#[derive(Debug, Clone, Deserialize)]
pub struct QuickTarget {
    pub user: String,
    pub address: String,
    pub port: u16,
    pub fingerprint: String,
}

/// A Quick Connect's Session command, serve's id for the Quick Connect, and, when "Save to vault"
/// was ticked (ticket 15), the id serve holds the typed password under (`quick.save` refers to it).
#[derive(Debug)]
pub struct QuickSession {
    pub command: SessionCommand,
    pub quick: String,
    pub held: Option<String>,
}

/// A Session to an `auth: prompt` Host with a typed password (ticket 16): its command, and the id
/// serve holds the password under for "Save to vault", when asked.
#[derive(Debug)]
pub struct HostSession {
    pub command: SessionCommand,
    pub held: Option<String>,
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
/// once that's past (serve.py's `DEADLINES` and `AFTER_DEADLINE`; a roster test checks the two
/// tables agree), so serve always answers before the app gives up, and its answer says what
/// actually happened. `vault.login` has no serve deadline: each bw step is held to 40 s, and a
/// wrong code runs bw once more.
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
];

/// The first serve API with `host.check {background: true}` and `host.check_job` (ticket 108).
pub const CHECK_JOBS_API_VERSION: i64 = 21;
/// The first serve API whose `session.fill` takes `hop` (ticket 120): an older one ignores it and
/// answers for the Session's own Host, so the core never sends it a nested fill.
pub const NESTED_FILL_API_VERSION: i64 = 26;
/// How often [`Backend::check_host`] asks a check job how it's going.
pub const CHECK_POLL: std::time::Duration = std::time::Duration::from_millis(200);

/// How long the app waits for `method` (see [`CALL_SECS`]).
pub fn timeout_for(method: &str) -> std::time::Duration {
    CALL_SECS
        .iter()
        .find(|(m, _)| *m == method)
        .map_or(crate::rpc::DEFAULT_TIMEOUT, |(_, s)| std::time::Duration::from_secs(*s))
}

/// What the UI learns about the Backend once it's up.
#[derive(Debug, Clone, Serialize)]
pub struct BackendInfo {
    /// "Local" or "WSL: <distro>".
    pub backend: String,
    /// The command line that runs serve.
    pub command: Vec<String>,
    /// The `inventory.info` result as roster sent it.
    pub inventory: Value,
}

pub struct Backend {
    client: RpcClient,
    /// Where serve (and so every Session) runs.
    pub target: Target,
    pub info: BackendInfo,
}

impl Backend {
    pub fn start(c: &Candidate) -> Result<Backend, BackendError> {
        Self::start_with(c, None)
    }

    /// As [`Backend::start`], handing serve's notifications (`inventory.changed`) to `notify`.
    pub fn start_with(c: &Candidate, notify: Option<Notify>) -> Result<Backend, BackendError> {
        let shown = c.serve_argv.join(" ");
        let mut cmd = Command::new(&c.serve_argv[0]);
        cmd.args(&c.serve_argv[1..]);
        if c.target == Target::Local && cfg!(windows) {
            // Native Windows roster: Python's UTF-8 mode, so roster.yml, the vault CLI's output and
            // every file roster writes are UTF-8 whatever the Windows code page is.
            cmd.env("PYTHONUTF8", "1");
        }
        let client = RpcClient::spawn_with(cmd, notify).map_err(|e| {
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
            target: c.target.clone(),
            info: BackendInfo {
                backend: c.target.label(),
                command: c.serve_argv.clone(),
                inventory,
            },
        })
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
    /// (ticket 108) the check is a job in serve: it's started in the background and
    /// `host.check_job` (a quick read) is asked every [`CHECK_POLL`] until it's over, so no worker
    /// of serve waits for the check meanwhile. An older serve gets the waiting form. Past
    /// [`timeout_for`] `host.check` this is [`CallError::Timeout`], and the job is stopped if
    /// this call started it ([`Backend::check_host_within`]).
    pub fn check_host(&self, host: &str) -> Result<Value, CallError> {
        self.check_host_within(host, timeout_for("host.check"))
    }

    /// [`Backend::check_host`], giving up after `limit`. Giving up stops the job only when serve
    /// says this call started it (`joined: false`, serve API 22): a check it joined (one per Host
    /// at a time) is another caller's too, which may still be waiting for it.
    pub fn check_host_within(&self, host: &str, limit: std::time::Duration) -> Result<Value, CallError> {
        if self.api_version() < CHECK_JOBS_API_VERSION {
            return self.call("host.check", json!({ "host": host }));
        }
        let started = self.call("host.check", json!({ "host": host, "background": true }))?;
        let job = started.get("job").cloned().ok_or_else(|| CallError::Io {
            message: "host.check answered without a job".into(),
        })?;
        let started_here = started.get("joined").and_then(Value::as_bool) == Some(false);
        let end = std::time::Instant::now() + limit;
        loop {
            let r = self.call("host.check_job", json!({ "job": job }))?;
            match r.get("state").and_then(Value::as_str) {
                Some("running" | "stopping") => {}
                Some("failed") => {
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
            if std::time::Instant::now() >= end {
                if started_here {
                    let _ = self.call("jobs.stop", json!({ "kind": "check", "job": job }));
                }
                return Err(CallError::Timeout);
            }
            std::thread::sleep(CHECK_POLL);
        }
    }

    /// A call, waiting as long as [`timeout_for`] says for that method.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, CallError> {
        self.client.call_timeout(method, params, timeout_for(method))
    }

    /// The command that opens a Session to `host` on this Backend (`session.prepare`). Refusals
    /// keep roster's code and wording: 2 unknown Host, 20 not reviewed, 21 this box isn't set up.
    pub fn session_command(&self, host: &str) -> Result<SessionCommand, CallError> {
        let v = self.call("session.prepare", json!({ "host": host }))?;
        // serde's message quotes the bad value, and `env` holds the askpass token: name the field
        // and the expected shape only.
        let prepared: Prepared = serde_json::from_value(v.clone()).map_err(|_| CallError::Io {
            message: format!(
                "session.prepare answered something unexpected: {}",
                prepare_shape_error(&v)
            ),
        })?;
        Ok(session_command(&self.target, &prepared))
    }

    /// The command for a Session to an `auth: prompt` Host (ticket 16) with the password the user
    /// typed: `session.prepare {host, password, save?}`. Like a Quick Connect's, the password is
    /// moved into the request and dropped with it; it comes back only as an askpass token. With
    /// `save`, serve holds it for "Save to vault" and only its id comes back, as `held`.
    pub fn typed_session_command(&self, host: &str, password: String, save: bool) -> Result<HostSession, CallError> {
        let mut params = json!({ "host": host, "password": password });
        if save {
            params["save"] = Value::Bool(true);
        }
        let v = self.call("session.prepare", params)?;
        let prepared: Prepared = serde_json::from_value(v.clone()).map_err(|_| CallError::Io {
            message: format!(
                "session.prepare answered something unexpected: {}",
                prepare_shape_error(&v)
            ),
        })?;
        Ok(HostSession {
            command: session_command(&self.target, &prepared),
            held: held_id(&v),
        })
    }

    /// The host key a Host offers, to ask the user about before its first Session (`host.scan_key
    /// {host}`): `{host, address, port, key_type, fingerprint, recorded: none|match|changed}`.
    /// One connection, key exchange only; nothing is recorded.
    pub fn scan_host_key(&self, host: &str) -> Result<Value, CallError> {
        self.call("host.scan_key", json!({ "host": host }))
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

    /// The command for a Quick Connect (`quick.prepare`, ticket 14). serve fetches the host key
    /// again and refuses (23) if it isn't the one the user was shown, or (43) if it differs from
    /// one roster recorded. A typed `password` is moved into the request and dropped with it: it
    /// goes to serve's stdin once and comes back only as an askpass token in the env. Never
    /// logged, stored or put in an error. Without one, the Session logs in with the Box's keys.
    /// `save` ("Save to vault", ticket 15): serve holds the password until the Session has logged
    /// in and `quick.save` saves it (or it's forgotten); only its id comes back, as `held`.
    pub fn quick_session_command(
        &self,
        to: &QuickTarget,
        password: Option<String>,
        save: bool,
    ) -> Result<QuickSession, CallError> {
        if !sha256_shaped(&to.fingerprint) {
            return Err(CallError::Io {
                message: "quick.prepare needs the SHA256:... fingerprint the user was shown".into(),
            });
        }
        let mut params = json!({
            "user": to.user,
            "address": to.address,
            "port": to.port,
            "fingerprint": to.fingerprint,
        });
        if let Some(password) = password {
            params["password"] = Value::String(password);
            if save {
                params["save"] = Value::Bool(true);
            }
        }
        let v = self.call("quick.prepare", params)?;
        let prepared: Prepared = serde_json::from_value(v.clone()).map_err(|_| CallError::Io {
            message: format!(
                "quick.prepare answered something unexpected: {}",
                prepare_shape_error(&v)
            ),
        })?;
        let quick = v
            .get("quick")
            .and_then(Value::as_str)
            .ok_or_else(|| CallError::Io {
                message: "quick.prepare answered something unexpected: `quick` isn't a string".into(),
            })?
            .to_owned();
        let mut command = session_command(&self.target, &prepared);
        command.fill_as = None; // not an Inventory Host: no Login a prompt fill could use
        Ok(QuickSession {
            command,
            quick,
            held: held_id(&v),
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

/// The id serve holds a typed password under for "Save to vault" (`held`), if it does.
fn held_id(v: &Value) -> Option<String> {
    v.get("held").and_then(Value::as_str).map(str::to_owned)
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

/// A failure of the first call, as the error the user sees.
fn classify(e: CallError, shown: &str) -> BackendError {
    match e {
        CallError::Exited { stderr, code } => {
            if stderr.contains("invalid choice") && stderr.contains("serve") {
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
            ..
        } => BackendError::new(
            ErrorKind::InventoryNotFound,
            format!("roster couldn't load the Inventory: {message}"),
            "Clone the infra repo to ~/infra (or set ROSTER_CONFIG in ~/.profile), then retry.",
        )
        .with_detail(shown),
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
