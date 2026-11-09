//! `roster check [TARGET]`: for each Host, does its name resolve, does its
//! port answer, and does a login work? One line per Host, or one JSON document.

use crate::Fail;
use crate::inventory::{Host, Inventory};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Seconds ssh waits to connect.
const CONNECT_TIMEOUT: u32 = 10;
/// How long the port gets to answer.
const PORT_TIMEOUT: Duration = Duration::from_secs(5);

/// The first check that failed, and why; None when all passed.
type Failure = Option<(&'static str, String)>;

fn one(host: &Host) -> Failure {
    let addr = match (host.ip.as_str(), host.port).to_socket_addrs() {
        Ok(mut addrs) => addrs.next(),
        Err(e) => return Some(("dns", format!("{}: {e}", host.ip))),
    };
    let Some(addr) = addr else {
        return Some(("dns", format!("{}: no address", host.ip)));
    };
    if let Err(e) = TcpStream::connect_timeout(&addr, PORT_TIMEOUT) {
        return Some(("port", format!("{addr}: {e}")));
    }
    login(host).err().map(|e| ("login", e))
}

/// Log in with no prompt and run `true`; on failure, ssh's own words.
fn login(host: &Host) -> Result<(), String> {
    let out = Command::new("ssh")
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
    let results = crate::run::parallel(&hosts, |h| one(h));
    let failed = results.iter().filter(|r| r.is_some()).count();
    if json {
        let docs = hosts.iter().zip(&results).map(|(h, r)| {
            let (stage, error) = r.as_ref().map(|(s, e)| (s, e)).unzip();
            serde_json::json!({"host": h.name, "ok": r.is_none(), "failed": stage, "error": error})
        });
        let docs: Vec<_> = docs.collect();
        println!("{}", serde_json::json!({"v": 1, "hosts": docs}));
    } else {
        for (h, r) in hosts.iter().zip(&results) {
            match r {
                None => println!("{}: ok", h.name),
                Some((stage, why)) => println!("{}: {stage}: {why}", h.name),
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
