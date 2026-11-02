//! A JSON-RPC 2.0 client over a child process's stdin/stdout, one JSON object per line: the
//! `roster serve` protocol. Calls may be made from several threads; responses are matched to
//! callers by id, so the order the child answers in doesn't matter (serve answers several at
//! once since API 20, decision Q112). A call given up on is cancelled in serve (`$/cancel`, API
//! 21). Whatever the child writes to
//! stderr is kept (the tail of it) so a failed start can be explained.

use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// How much of the child's stderr is kept.
const STDERR_TAIL: usize = 4096;
/// How long one call may take before it's given up on.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
/// How long closing the client waits for serve to exit on its own before killing it: serve stops
/// every running job then and records what it didn't finish (decisions Q101, Q112), up to 0.8 s,
/// and gives the requests still running up to 1 s more to answer: 1.8 s at most.
pub const EXIT_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CallError {
    /// The child answered with a JSON-RPC error object.
    Rpc {
        code: i64,
        message: String,
        data: Option<Value>,
    },
    /// The child exited (or closed stdout) before answering. `stderr` is the tail of what it printed.
    Exited { code: Option<i32>, stderr: String },
    /// No answer within the timeout.
    Timeout,
    /// Writing the request failed, or the answer wasn't JSON-RPC.
    Io { message: String },
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Rpc { code, message, .. } => write!(f, "{message} (code {code})"),
            CallError::Exited { code, stderr } => {
                write!(f, "the backend exited (code {code:?})")?;
                if !stderr.trim().is_empty() {
                    write!(f, ": {}", stderr.trim())?;
                }
                Ok(())
            }
            CallError::Timeout => write!(f, "the backend didn't answer in time"),
            CallError::Io { message } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for CallError {}

type Reply = Result<Value, CallError>;

/// Called with each JSON-RPC notification the child sends (a message with a `method` and no
/// `id`, such as serve's `inventory.changed`), on the reader thread.
pub type Notify = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Default)]
struct Shared {
    pending: HashMap<u64, Sender<Reply>>,
    /// Set once stdout has closed: every later call fails with this at once.
    dead: Option<CallError>,
}

pub struct RpcClient {
    stdin: Mutex<Option<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    shared: Arc<Mutex<Shared>>,
    next_id: AtomicU64,
    stderr_tail: Arc<Mutex<String>>,
    reader: Option<JoinHandle<()>>,
}

impl RpcClient {
    /// Start `cmd` with piped stdio and begin reading its answers.
    pub fn spawn(cmd: Command) -> std::io::Result<Self> {
        Self::spawn_with(cmd, None)
    }

    /// As [`RpcClient::spawn`], handing every notification the child sends to `notify`.
    pub fn spawn_with(mut cmd: Command, notify: Option<Notify>) -> std::io::Result<Self> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        no_console_window(&mut cmd);
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let err_thread = {
            let tail = Arc::clone(&stderr_tail);
            thread::spawn(move || keep_tail(stderr, &tail))
        };

        let child = Arc::new(Mutex::new(child));
        let shared = Arc::new(Mutex::new(Shared::default()));
        let reader = {
            let (shared, child, tail) = (Arc::clone(&shared), Arc::clone(&child), Arc::clone(&stderr_tail));
            thread::spawn(move || {
                read_answers(stdout, &shared, notify.as_ref());
                // stdout closed: the child is gone (or going). Collect its stderr and exit code,
                // then fail everything still waiting.
                let _ = err_thread.join();
                let code = child.lock().unwrap().wait().ok().and_then(|s| s.code());
                let err = CallError::Exited {
                    code,
                    stderr: tail.lock().unwrap().clone(),
                };
                let mut s = shared.lock().unwrap();
                for (_, tx) in s.pending.drain() {
                    let _ = tx.send(Err(err.clone()));
                }
                s.dead = Some(err);
            })
        };

        Ok(RpcClient {
            stdin: Mutex::new(stdin),
            child,
            shared,
            next_id: AtomicU64::new(1),
            stderr_tail,
            reader: Some(reader),
        })
    }

    pub fn call(&self, method: &str, params: Value) -> Reply {
        self.call_timeout(method, params, DEFAULT_TIMEOUT)
    }

    pub fn call_timeout(&self, method: &str, params: Value, timeout: Duration) -> Reply {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        {
            let mut s = self.shared.lock().unwrap();
            if let Some(err) = &s.dead {
                return Err(err.clone());
            }
            s.pending.insert(id, tx);
        }
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string() + "\n";
        let written = match self.stdin.lock().unwrap().as_mut() {
            Some(w) => w.write_all(line.as_bytes()).and_then(|_| w.flush()),
            None => Err(std::io::Error::other("stdin is closed")),
        };
        if let Err(e) = written {
            // A broken pipe usually means the child has exited: prefer that explanation, which
            // the reader thread delivers once it sees stdout close.
            if let Ok(Err(err)) = rx.recv_timeout(Duration::from_secs(2)) {
                return Err(err);
            }
            self.shared.lock().unwrap().pending.remove(&id);
            return Err(CallError::Io {
                message: format!("couldn't send {method}: {e}"),
            });
        }
        match rx.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(_) => {
                self.shared.lock().unwrap().pending.remove(&id);
                self.cancel(id);
                Err(CallError::Timeout)
            }
        }
    }

    /// Tells serve the call `id` was given up on: the notification `$/cancel {id}` (serve API 21,
    /// ticket 108). A request still queued or waiting for a lock never runs, a running check or
    /// Mesh run stops its job, anything else that runs finishes (serve-api.md, "Cancelling"). An
    /// older serve ignores it (a notification gets no answer). Best effort: a closed pipe is fine.
    fn cancel(&self, id: u64) {
        let line = json!({"jsonrpc": "2.0", "method": "$/cancel", "params": {"id": id}}).to_string() + "\n";
        if let Some(w) = self.stdin.lock().unwrap().as_mut() {
            let _ = w.write_all(line.as_bytes()).and_then(|_| w.flush());
        }
    }

    /// What the child has written to stderr so far (the last few KB).
    pub fn stderr(&self) -> String {
        self.stderr_tail.lock().unwrap().clone()
    }

    /// True once the child has closed stdout.
    pub fn is_dead(&self) -> bool {
        self.shared.lock().unwrap().dead.is_some()
    }
}

impl Drop for RpcClient {
    /// Closing stdin is how serve is told to exit. Give it [`EXIT_GRACE`], then make sure.
    fn drop(&mut self) {
        self.stdin.lock().unwrap().take();
        let deadline = std::time::Instant::now() + EXIT_GRACE;
        while !self.is_dead() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        if !self.is_dead() {
            let _ = self.child.lock().unwrap().kill();
        }
        if let Some(r) = self.reader.take() {
            let _ = r.join();
        }
    }
}

fn read_answers(stdout: impl Read, shared: &Mutex<Shared>, notify: Option<&Notify>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = msg.get("id").and_then(Value::as_u64) else {
            if msg.get("id").is_none()
                && let (Some(method), Some(notify)) = (msg.get("method").and_then(Value::as_str), notify)
            {
                notify(method, msg.get("params").cloned().unwrap_or(Value::Null));
            }
            continue;
        };
        let reply = match msg.get("error") {
            Some(e) => Err(CallError::Rpc {
                code: e.get("code").and_then(Value::as_i64).unwrap_or(0),
                message: e.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                data: e.get("data").cloned(),
            }),
            None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
        };
        if let Some(tx) = shared.lock().unwrap().pending.remove(&id) {
            let _ = tx.send(reply);
        }
    }
}

fn keep_tail(stderr: impl Read, tail: &Mutex<String>) {
    let mut r = BufReader::new(stderr);
    let mut buf = Vec::new();
    while let Ok(n) = r.read_until(b'\n', &mut buf) {
        if n == 0 {
            break;
        }
        let mut t = tail.lock().unwrap();
        t.push_str(&String::from_utf8_lossy(&buf));
        if t.len() > STDERR_TAIL {
            let mut cut = t.len() - STDERR_TAIL;
            while !t.is_char_boundary(cut) {
                cut += 1;
            }
            t.drain(..cut);
        }
        buf.clear();
    }
}

/// A GUI-subsystem exe on Windows would open a console window for every console child.
#[cfg(windows)]
pub fn no_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn no_console_window(_cmd: &mut Command) {}
