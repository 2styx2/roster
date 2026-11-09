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

/// What follows `web`: HOST [SERVICE] METHOD PATH, `-d BODY`, `-H HEADER`
/// and `-k`.
#[derive(Default)]
pub struct Args {
    pub words: Vec<String>,
    pub body: Option<String>,
    pub headers: Vec<String>,
    pub insecure: bool,
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
        [h, s, m, p] => (h, Some(s), m, p),
        [h, m, p] => (h, None, m, p),
        _ => return Err(usage_error("web needs HOST [SERVICE] METHOD PATH")),
    };
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(usage_error(format!(
            "METHOD '{method}' isn't like GET or POST"
        )));
    }
    let leaves = path.starts_with("//") || path.contains("://") || path.contains("..");
    if !path.starts_with('/')
        || leaves
        || path.contains(|c: char| c.is_whitespace() || c.is_control() || c == '\\')
    {
        let msg = "PATH must start with / and stay on the service's origin";
        return Err(usage_error(format!("{msg}: no //, ://, .., spaces or \\")));
    }
    if args.body.as_deref() == Some("@-") {
        return Err(usage_error(
            "-d @- can't be used: curl's stdin carries the Login",
        ));
    }
    let host = inv.hosts.iter().find(|h| &h.name == name);
    let host = host.ok_or_else(|| failed(format!("no Host named '{name}' in the Inventory")))?;
    // Without SERVICE: the one `ls` shows as the Host's web UI.
    let svc = host.services.iter().find(|s| match service {
        Some(n) => &s.name == n,
        None => s.url.is_some() && s.url == host.web,
    });
    let svc = svc.ok_or_else(|| match service {
        Some(n) => failed(format!("{name} has no service '{n}'")),
        None => failed(format!("{name} has no web service: name one")),
    })?;
    let what = format!("{name} {}", svc.name);
    let base = svc.url.as_deref().and_then(origin);
    let base = base.ok_or_else(|| failed(format!("{what} has no http(s) URL")))?;
    let mut config = Zeroizing::new(String::new());
    let secret = match &svc.auth {
        Some(auth) if svc.login != "none" => vault::resolve(auth, &what)?,
        _ => None,
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
        ]);
    // curl inherits no variable a Login of this Host's comes from.
    let auths = host.services.iter().filter_map(|s| s.auth.as_deref());
    let vars = auths
        .chain([host.auth.as_str()])
        .filter_map(|a| a.strip_prefix("env:"));
    let from = secret.as_ref().and_then(|s| s.from_env.as_deref());
    for var in vars.chain(from) {
        curl.env_remove(var);
    }
    if args.insecure || !svc.verify {
        curl.arg("-k");
    }
    for header in &args.headers {
        curl.args(["-H", header]);
    }
    match args.body.as_deref() {
        Some(file) if file.starts_with('@') => drop(curl.args(["--data-binary", file])),
        Some(body) => option(&mut config, "data-raw", &[body]),
        None => {}
    }
    curl.args(["-X", method, &format!("{base}{path}")])
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
