//! `roster check [TARGET]`: for each Host, does its name resolve, does its
//! port answer, and does a login work (for a Password Host: does its vault
//! reference resolve)? One line per Host, or one JSON document.

use crate::inventory::{Host, Inventory};
use crate::{Fail, vault};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Seconds ssh waits to connect.
const CONNECT_TIMEOUT: u32 = 10;
/// How long the port gets to answer.
const PORT_TIMEOUT: Duration = Duration::from_secs(5);
/// Why a `prompt` Password Host passes without its password being checked.
const PROMPT: &str = "auth prompt: not checked here";

/// How a Host's login is checked.
enum Auth {
    /// `ssh -o BatchMode=yes HOST true`.
    Login,
    /// A Password Host's vault reference, already resolved (or not); Ok
    /// holds the variable an `env:` password came from.
    Vault(Result<Option<String>, String>),
    /// A Password Host that would ask on the terminal: not checked.
    Prompt,
}

/// What one Host's check found.
struct Report {
    /// The first stage that failed, and why.
    failed: Option<(&'static str, String)>,
    note: Option<&'static str>,
}

fn auth(host: &Host) -> Auth {
    if host.enroll {
        return Auth::Login;
    }
    if host.auth == "prompt" {
        return Auth::Prompt;
    }
    match vault::resolve(&host.auth, &host.name) {
        Ok(Some(secret)) => Auth::Vault(Ok(secret.from_env.clone())),
        Ok(None) => Auth::Login,
        Err(fail) => {
            let prefix = format!("{}: ", host.name);
            let msg = fail.msg.strip_prefix(&prefix).unwrap_or(&fail.msg);
            Auth::Vault(Err(msg.to_string()))
        }
    }
}

fn one(host: &Host, auth: &Auth, scrub: &[&str]) -> Report {
    let fail = |stage, why| Report {
        failed: Some((stage, why)),
        note: None,
    };
    let addr = match (host.ip.as_str(), host.port).to_socket_addrs() {
        Ok(mut addrs) => addrs.next(),
        Err(e) => return fail("dns", format!("{}: {e}", host.ip)),
    };
    let Some(addr) = addr else {
        return fail("dns", format!("{}: no address", host.ip));
    };
    if let Err(e) = TcpStream::connect_timeout(&addr, PORT_TIMEOUT) {
        return fail("port", format!("{addr}: {e}"));
    }
    let (failed, note) = match auth {
        Auth::Login => (login(host, scrub).err().map(|e| ("login", e)), None),
        Auth::Vault(r) => (r.as_ref().err().map(|e| ("vault", e.clone())), None),
        Auth::Prompt => (None, Some(PROMPT)),
    };
    Report { failed, note }
}

/// Log in with no prompt and run `true`; on failure, ssh's own words. No
/// variable a password came from reaches ssh.
fn login(host: &Host, scrub: &[&str]) -> Result<(), String> {
    let mut ssh = Command::new("ssh");
    for var in scrub {
        ssh.env_remove(var);
    }
    let out = ssh
        .args(["-o", "BatchMode=yes"])
        .args(["-o", &format!("ConnectTimeout={CONNECT_TIMEOUT}")])
        .args([&host.name, "true"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("can't run ssh: {e}"))?;
    match out.status.success() {
        true => Ok(()),
        false => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
}

pub fn run(inv: &Inventory, target: Option<&str>, json: bool) -> Result<(), Fail> {
    let hosts = match target {
        Some(target) => inv.targets(target)?,
        None => inv.hosts.iter().collect(),
    };
    // Vault references one at a time, so a `cmd:` unlock never races another.
    let jobs: Vec<_> = hosts.iter().map(|h| (*h, auth(h))).collect();
    let scrub: Vec<&str> = jobs
        .iter()
        .filter_map(|(_, a)| match a {
            Auth::Vault(Ok(var)) => var.as_deref(),
            _ => None,
        })
        .collect();
    let reports = crate::run::parallel(&jobs, |(h, auth)| one(h, auth, &scrub));
    let failed = reports.iter().filter(|r| r.failed.is_some()).count();
    if json {
        let docs = hosts.iter().zip(&reports).map(|(h, r)| {
            let (stage, error) = r.failed.as_ref().map(|(s, e)| (s, e)).unzip();
            serde_json::json!({"host": h.name, "ok": stage.is_none(), "failed": stage,
                "error": error, "note": r.note})
        });
        let docs: Vec<_> = docs.collect();
        println!("{}", serde_json::json!({"v": 1, "hosts": docs}));
    } else {
        for (h, r) in hosts.iter().zip(&reports) {
            match (&r.failed, r.note) {
                (Some((stage, why)), _) => println!("{}: {stage}: {why}", h.name),
                (None, Some(note)) => println!("{}: ok ({note})", h.name),
                (None, None) => println!("{}: ok", h.name),
            }
        }
        let n = hosts.len();
        let s = if n == 1 { "" } else { "s" };
        println!("{n} Host{s}: {} ok, {failed} failed", n - failed);
    }
    match failed {
        0 => Ok(()),
        _ => Err(Fail {
            code: 1,
            msg: String::new(),
        }),
    }
}
