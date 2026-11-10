//! `roster web HOST [SERVICE] METHOD PATH`: curl calls a service's API with
//! its stored Login. curl's argv holds nothing secret: the Login goes to it
//! as a config on stdin (`-K -`).

use crate::inventory::{Inventory, Service};
use crate::vault::{self, Secret};
use crate::{Fail, usage_error};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::Stdio;
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
    let insecure = args.insecure || !svc.verify;
    let user = svc.user.as_deref().unwrap_or_default();
    if let Some(secret) = &secret {
        match svc.login.as_str() {
            "token" => {
                let token = login(svc, &base, &what, user, secret, insecure)?;
                let header = &svc.token.token_header;
                let bearer = if header.eq_ignore_ascii_case("authorization") {
                    ": Bearer "
                } else {
                    ": "
                };
                option(&mut config, "header", &[header, bearer, &token]);
            }
            "bearer" => option(
                &mut config,
                "header",
                &["Authorization: Bearer ", secret.expose()],
            ),
            _ => option(&mut config, "user", &[user, ":", secret.expose()]),
        }
    }
    let mut extra = Vec::new();
    for header in &args.headers {
        extra.extend(["-H", header]);
    }
    match args.body.as_deref() {
        Some(file) if file.starts_with('@') => extra.extend(["--data-binary", file]),
        Some(body) => option(&mut config, "data-raw", &[body]),
        None => {}
    }
    let url = format!("{base}{path}");
    let (status, ok, _) = curl(&extra, method, &url, &config, insecure, None)?;
    match status {
        100..400 if ok => Ok(()),
        0 => Err(failed(format!("{what}: no HTTP response"))),
        _ => Err(failed(format!("{what}: HTTP {status}"))),
    }
}

/// A token login: POST the user and password as JSON, and the token from
/// the reply. Its errors hold neither.
fn login(
    svc: &Service,
    base: &str,
    what: &str,
    user: &str,
    secret: &Secret,
    insecure: bool,
) -> Result<Zeroizing<String>, Fail> {
    let t = &svc.token;
    let fields = BTreeMap::from([
        (t.user_field.as_str(), user),
        (t.password_field.as_str(), secret.expose()),
    ]);
    let mut body = Zeroizing::new(Vec::new());
    serde_json::to_writer(&mut *body, &fields).map_err(|e| failed(format!("{what}: {e}")))?;
    let mut config = Zeroizing::new(String::new());
    option(
        &mut config,
        "data-raw",
        &[std::str::from_utf8(&body).unwrap_or_default()],
    );
    let url = format!("{base}{}", t.login_path);
    let json = ["-H", "Content-Type: application/json"];
    let (status, ok, reply) = curl(&json, "POST", &url, &config, insecure, Some(secret))?;
    let what = format!("{what}: token login to {}", t.login_path);
    if !ok || !(200..300).contains(&status) {
        return Err(failed(match status {
            0 => format!("{what}: no HTTP response"),
            _ => format!("{what}: HTTP {status}"),
        }));
    }
    let mut reply: serde_json::Value = serde_json::from_slice(&reply)
        .map_err(|_| failed(format!("{what}: the reply isn't JSON")))?;
    let pointer = format!("/{}", t.token_field.replace('.', "/"));
    match reply.pointer_mut(&pointer).map(serde_json::Value::take) {
        Some(serde_json::Value::String(token)) if !token.is_empty() => Ok(Zeroizing::new(token)),
        _ => Err(failed(format!("{what}: no {} in the reply", t.token_field))),
    }
}

/// Run curl: METHOD URL, with `extra` arguments and `config` on stdin; its
/// HTTP status (0: none), whether it exited 0 and, when `capture` is given, its stdout kept
/// rather than printed, and `capture` masked in curl's errors.
fn curl(
    extra: &[&str],
    method: &str,
    url: &str,
    config: &str,
    insecure: bool,
    capture: Option<&Secret>,
) -> Result<(u16, bool, Zeroizing<Vec<u8>>), Fail> {
    let mut curl = crate::remote::command("curl");
    curl.args(["-q", "-sS", "--proto", "=http,https", "--max-redirs", "0"])
        .args([
            "-w",
            &format!("%{{stderr}}{MARK}%{{http_code}}\\n"),
            "-K",
            "-",
        ]);
    if insecure {
        curl.arg("-k");
    }
    curl.args(extra)
        .args(["-X", method, url])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped());
    if capture.is_some() {
        curl.stdout(Stdio::piped());
    }
    let mut child = curl.spawn().map_err(|e| Fail {
        code: 126,
        msg: format!("can't run curl: {e}"),
    })?;
    let mut stdin = child.stdin.take().expect("piped");
    let _ = stdin.write_all(config.as_bytes());
    drop(stdin);
    let mut out = Zeroizing::new(Vec::new());
    let stdout = child.stdout.take();
    let mut status = 0;
    let keep = &mut out;
    std::thread::scope(|s| {
        if let Some(mut o) = stdout {
            s.spawn(move || o.read_to_end(keep));
        }
        for line in BufReader::new(child.stderr.take().expect("piped")).lines() {
            let line = line.unwrap_or_default();
            match line.strip_prefix(MARK) {
                Some(code) => status = code.parse().unwrap_or(0),
                None => match capture {
                    Some(c) => eprintln!("{}", line.replace(c.expose(), "********")),
                    None => eprintln!("{line}"),
                },
            }
        }
    });
    let exit = child.wait().map_err(|e| failed(format!("curl: {e}")))?;
    Ok((status, exit.success(), out))
}
