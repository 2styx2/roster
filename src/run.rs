//! `roster run TARGET -- CMD`: run CMD on every Host TARGET names, in
//! parallel, each output line labelled `host: `; or one JSON document.

use crate::inventory::{Host, Inventory};
use crate::vault::{self, Secret};
use crate::{Fail, askpass};
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// At most this many Hosts run at once.
const WORKERS: usize = 32;
/// Seconds ssh waits to connect, so a down Host can't hold up the rest.
const CONNECT_TIMEOUT: u32 = 10;

/// What one Host gave back; stdout and stderr are kept only for `--json`.
struct Outcome {
    exit: Option<i32>,
    stdout: String,
    stderr: String,
}

pub fn run(inv: &Inventory, target: &str, cmd: Vec<OsString>, json: bool) -> Result<(), Fail> {
    if cmd.is_empty() {
        return Err(crate::usage_error("run needs a command after TARGET"));
    }
    let mut hosts = inv.targets(target)?;
    hosts.retain(|h| {
        let keep = h.reviewed;
        if !keep {
            eprintln!("roster: skipped {}: unreviewed", h.name);
        }
        keep
    });
    if hosts.is_empty() {
        let msg = format!("'{target}' left no reviewed Host to run on");
        return Err(Fail { code: 1, msg });
    }
    // Every password first, one prompt at a time, before any thread starts.
    let mut secrets = Vec::with_capacity(hosts.len());
    for h in &hosts {
        secrets.push(match h.enroll {
            true => None,
            false => vault::resolve(&h.auth, &h.name)?,
        });
    }
    let jobs: Vec<_> = hosts.iter().zip(&secrets).collect();
    let results: Vec<Mutex<Option<Outcome>>> = jobs.iter().map(|_| Mutex::new(None)).collect();
    let next = AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..WORKERS.min(jobs.len()) {
            s.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some((host, secret)) = jobs.get(i) else {
                        break;
                    };
                    let outcome = one(host, secret.as_ref(), &cmd, json);
                    *results[i].lock().unwrap() = Some(outcome);
                }
            });
        }
    });
    let outcomes: Vec<Outcome> = results
        .into_iter()
        .map(|m| m.into_inner().unwrap().expect("every job ran"))
        .collect();
    if json {
        let docs = hosts.iter().zip(&outcomes).map(|(h, o)| {
            serde_json::json!({"host": h.name, "exit": o.exit, "stdout": o.stdout, "stderr": o.stderr})
        });
        let docs: Vec<_> = docs.collect();
        println!("{}", serde_json::json!({"v": 1, "hosts": docs}));
    }
    let failed = hosts.iter().zip(&outcomes).filter(|(_, o)| o.exit != Some(0));
    let failed: Vec<_> = failed.map(|(h, _)| h.name.as_str()).collect();
    match failed.is_empty() {
        true => Ok(()),
        false => Err(Fail {
            code: 1,
            msg: format!("failed on {}", failed.join(", ")),
        }),
    }
}

/// Run CMD on one Host, streaming its lines (or collecting them for JSON).
fn one(host: &Host, secret: Option<&Secret>, cmd: &[OsString], json: bool) -> Outcome {
    let mut ssh = Command::new("ssh");
    if secret.is_none() {
        ssh.args(["-o", "BatchMode=yes"]);
    }
    ssh.args(["-o", &format!("ConnectTimeout={CONNECT_TIMEOUT}")])
        .arg(&host.name)
        .arg("--")
        .args(cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let name = host.name.as_str();
    let (mut stdout, mut stderr) = (String::new(), String::new());
    let (keep_out, keep_err) = (&mut stdout, &mut stderr);
    let status = std::thread::scope(|s| {
        let started = move |child: &mut Child| {
            if let Some(o) = child.stdout.take() {
                s.spawn(move || lines(o, name, json, keep_out, &mut io::stdout()));
            }
            if let Some(e) = child.stderr.take() {
                s.spawn(move || lines(e, name, json, keep_err, &mut io::stderr()));
            }
        };
        match secret {
            Some(secret) => askpass::run_with(ssh, secret, started),
            None => ssh.spawn().and_then(|mut child| {
                started(&mut child);
                child.wait()
            }),
        }
    });
    let exit = status.as_ref().ok().and_then(ExitStatus::code);
    if let Err(e) = status {
        let msg = format!("can't run ssh: {e}");
        lines(msg.as_bytes(), name, json, &mut stderr, &mut io::stderr());
    }
    Outcome {
        exit,
        stdout,
        stderr,
    }
}

/// Copy `from` line by line: into `keep` for JSON, else to `to` as
/// `host: line`, a whole line per write so Hosts never interleave mid-line.
fn lines(from: impl Read, host: &str, json: bool, keep: &mut String, to: &mut impl Write) {
    let mut from = BufReader::new(from);
    let mut line = Vec::new();
    while matches!(from.read_until(b'\n', &mut line), Ok(n) if n > 0) {
        let text = String::from_utf8_lossy(&line);
        if json {
            keep.push_str(&text);
        } else {
            let text = text.strip_suffix('\n').unwrap_or(&text);
            let _ = writeln!(to, "{host}: {text}");
        }
        line.clear();
    }
}
