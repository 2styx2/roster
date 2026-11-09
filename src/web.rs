//! `roster web HOST [SERVICE] METHOD PATH`: curl calls a service's API with
//! its stored Login. curl's argv holds nothing secret: the Login goes to it
//! as a config on stdin (`-K -`).

use crate::inventory::Inventory;
use crate::{Fail, usage_error, vault};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use zeroize::Zeroizing;

/// The line curl's `-w` writes to stderr, which roster takes back.
const MARK: &str = "roster-http-status:";

/// The words after `web`.
#[derive(Default)]
pub struct Args {
    pub words: Vec<String>,
}

fn failed(msg: String) -> Fail {
    Fail { code: 1, msg }
}

/// A `KEY = "VALUE"` line of a curl config, written straight into `config`
/// so no copy of the value is left unwiped.
fn option(config: &mut String, key: &str, parts: &[&str]) {
    config.push_str(key);
    config.push_str(" = \"");
    for c in parts.iter().flat_map(|p| p.chars()) {
        match c {
            '\\' | '"' => config.extend(['\\', c]),
            '\n' => config.push_str("\\n"),
            '\r' => config.push_str("\\r"),
            '\t' => config.push_str("\\t"),
            _ => config.push(c),
        }
    }
    config.push_str("\"\n");
}

/// `scheme://host[:port]` of a service URL; any user info is dropped.
fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
    Some(format!("{scheme}://{authority}"))
}

pub fn run(inv: &Inventory, args: Args) -> Result<(), Fail> {
    let (name, service, method, path) = match &args.words[..] {
        [h, s, m, p] => (h, s, m, p),
        _ => return Err(usage_error("web needs HOST [SERVICE] METHOD PATH")),
    };
    let host = inv.hosts.iter().find(|h| &h.name == name);
    let host = host.ok_or_else(|| failed(format!("no Host named '{name}' in the Inventory")))?;
    let svc = host.services.iter().find(|s| &s.name == service);
    let svc = svc.ok_or_else(|| failed(format!("{name} has no service '{service}'")))?;
    let base = svc.url.as_deref().and_then(origin).unwrap_or_default();
    let what = format!("{name} {service}");
    let mut config = Zeroizing::new(String::new());
    let secret = match &svc.auth {
        Some(auth) => vault::resolve(auth, &what)?,
        None => None,
    };
    if let Some(secret) = &secret {
        let user = svc.user.as_deref().unwrap_or_default();
        let (key, parts) = match svc.login.as_str() {
            "bearer" => ("header", ["Authorization: Bearer ", "", secret.expose()]),
            _ => ("user", [user, ":", secret.expose()]),
        };
        option(&mut config, key, &parts);
    }
    let mut curl = Command::new("curl");
    curl.args(["-q", "-sS", "--proto", "=http,https", "--max-redirs", "0"])
        .args([
            "-w",
            &format!("%{{stderr}}{MARK}%{{http_code}}\\n"),
            "-K",
            "-",
        ])
        .args(["-X", method, &format!("{base}{path}")])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = curl.spawn().map_err(|e| Fail {
        code: 126,
        msg: format!("can't run curl: {e}"),
    })?;
    let mut stdin = child.stdin.take().expect("piped");
    let _ = stdin.write_all(config.as_bytes());
    drop(stdin);
    let mut status = 0;
    for line in BufReader::new(child.stderr.take().expect("piped")).lines() {
        let line = line.unwrap_or_default();
        match line.strip_prefix(MARK) {
            Some(code) => status = code.parse().unwrap_or(0),
            None => eprintln!("{line}"),
        }
    }
    let exit = child.wait().map_err(|e| failed(format!("curl: {e}")))?;
    match status {
        100..400 if exit.success() => Ok(()),
        0 => Err(failed(format!("{what}: no HTTP response"))),
        _ => Err(failed(format!("{what}: HTTP {status}"))),
    }
}
