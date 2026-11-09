//! The Inventory: finds and loads `roster.yml` into resolved Hosts.
//! No I/O beyond reading the file; nothing is fetched from a vault here.

use crate::Fail;
use serde_norway::{Mapping, Value};
use std::path::{Path, PathBuf};

pub struct Inventory {
    /// The file it was loaded from, as found.
    pub path: PathBuf,
    pub hosts: Vec<Host>,
}

/// A Host with the cascade resolved: built-in < `defaults` < group < Host,
/// and at each layer `ssh: {user, port, auth}` beats the plain fields.
pub struct Host {
    pub name: String,
    pub group: String,
    pub ip: String,
    pub user: String,
    pub port: u16,
    /// A vault reference (`bw:ITEM`, `cmd:...`, `prompt`), never resolved here.
    pub auth: String,
    pub title: String,
}

impl Host {
    /// How roster reaches it: `unreviewed`, `key` or `password`.
    pub fn access(&self) -> &'static str {
        "key"
    }
}

impl Inventory {
    /// Load from `-c FILE`, else `$ROSTER_CONFIG`, else `./roster.yml`,
    /// else `~/.config/roster/roster.yml`.
    pub fn open(flag: Option<PathBuf>) -> Result<Inventory, Fail> {
        let path = find(flag)?;
        let text = std::fs::read_to_string(&path).map_err(|e| broken(&path, None, e))?;
        let doc: Value = serde_norway::from_str(&text).map_err(|e| broken(&path, None, e))?;
        let hosts = parse(&doc).map_err(|b| {
            let line = line_of(&text, &b.at);
            broken(&path, line, format!("{}: {}", b.at.join("."), b.why))
        })?;
        Ok(Inventory { path, hosts })
    }
}

fn find(flag: Option<PathBuf>) -> Result<PathBuf, Fail> {
    if let Some(path) = flag.or_else(|| std::env::var_os("ROSTER_CONFIG").map(PathBuf::from)) {
        return Ok(path);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let candidates = [
        PathBuf::from("roster.yml"),
        home.join(".config/roster/roster.yml"),
    ];
    match candidates.iter().find(|p| p.is_file()) {
        Some(path) => Ok(path.clone()),
        None => Err(Fail {
            code: 3,
            msg: format!(
                "no Inventory: tried {} and {} (use -c FILE or $ROSTER_CONFIG)",
                candidates[0].display(),
                candidates[1].display()
            ),
        }),
    }
}

fn broken(path: &Path, line: Option<usize>, e: impl std::fmt::Display) -> Fail {
    let at = line.map(|n| format!(":{n}")).unwrap_or_default();
    Fail {
        code: 3,
        msg: format!("{}{at}: {e}", path.display()),
    }
}

/// What's wrong, and the key path it's at (`groups.dev.hosts.box-a.ip`).
struct Bad {
    at: Vec<String>,
    why: String,
}

fn bad<T>(at: &[&str], why: impl Into<String>) -> Result<T, Bad> {
    Err(Bad {
        at: at.iter().map(|s| s.to_string()).collect(),
        why: why.into(),
    })
}

/// The line (from 1) of the deepest key of AT found in TEXT, by indentation.
fn line_of(text: &str, at: &[String]) -> Option<usize> {
    let lines: Vec<&str> = text.lines().collect();
    let (mut found, mut from, mut parent) = (None, 0, None::<usize>);
    for key in at {
        let hit = (from..lines.len())
            .map(|n| {
                (
                    n,
                    lines[n].trim_start(),
                    lines[n].len() - lines[n].trim_start().len(),
                )
            })
            .filter(|(_, t, _)| !t.is_empty() && !t.starts_with('#'))
            .take_while(|&(_, _, i)| parent.is_none_or(|p| i > p))
            .find(|(_, t, _)| {
                let t = t.trim_start_matches("- ");
                [
                    format!("{key}:"),
                    format!("\"{key}\":"),
                    format!("'{key}':"),
                ]
                .iter()
                .any(|k| t.starts_with(k.as_str()))
            });
        let Some((n, _, i)) = hit else { break };
        (found, from, parent) = (Some(n + 1), n + 1, Some(i));
    }
    found
}

fn as_map<'a>(v: &'a Value, at: &[&str], want: &str) -> Result<Option<&'a Mapping>, Bad> {
    match v {
        Value::Null => Ok(None),
        Value::Mapping(m) => Ok(Some(m)),
        _ => bad(at, format!("must be {want}")),
    }
}

/// A scalar as text; None for null, a list or a mapping.
fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// The value from the most specific layer that sets KEY (an explicit null counts).
fn first<'a>(layers: &[&'a Mapping], key: &str) -> Option<&'a Value> {
    layers.iter().find_map(|l| l.get(key))
}

fn parse(doc: &Value) -> Result<Vec<Host>, Bad> {
    let empty = Mapping::new();
    let defaults = as_map(&doc["defaults"], &["defaults"], "a mapping")?.unwrap_or(&empty);
    let groups = match doc.get("groups") {
        Some(Value::Mapping(m)) => m,
        _ => {
            return bad(
                &["groups"],
                "must be a mapping of group name: {hosts: {...}}",
            );
        }
    };
    let mut hosts = Vec::new();
    for (group, body) in groups {
        let group = text(group).unwrap_or_default();
        let g = &["groups", &group];
        let body = as_map(body, g, "a mapping")?.unwrap_or(&empty);
        let members = as_map(&body["hosts"], &["groups", &group, "hosts"], "a mapping")?;
        // `hosts`, `title` and `description` describe the group; the rest is inherited.
        let inherited: Mapping = body
            .iter()
            .filter(|(k, _)| !matches!(k.as_str(), Some("hosts" | "title" | "description")))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (name, fields) in members.into_iter().flatten() {
            let name = text(name).unwrap_or_default();
            let at = ["groups", &group, "hosts", &name];
            let short; // `NAME: "10.0.0.5"` is `NAME: {ip: 10.0.0.5}`
            let own = match fields {
                Value::String(ip) => {
                    short = Mapping::from_iter([("ip".into(), ip.as_str().into())]);
                    &short
                }
                _ => as_map(fields, &at, "an address or a mapping")?.unwrap_or(&empty),
            };
            hosts.push(host(&at, [own, &inherited, defaults])?);
        }
    }
    Ok(hosts)
}

fn ssh_block<'a>(layer: &'a Mapping, at: &[&str]) -> Result<Option<&'a Mapping>, Bad> {
    let Some(v) = layer.get("ssh") else {
        return Ok(None);
    };
    let at = [at, &["ssh"]].concat();
    let block = as_map(v, &at, "a mapping with only port, user and auth")?;
    if let Some(k) = block
        .into_iter()
        .flatten()
        .map(|(k, _)| k)
        .find(|k| !matches!(k.as_str(), Some("port" | "user" | "auth")))
    {
        return bad(
            &at,
            format!(
                "unknown key {}: only port, user and auth",
                text(k).unwrap_or_default()
            ),
        );
    }
    Ok(block)
}

/// LAYERS: the Host's own fields, its group's, then `defaults`.
fn host(at: &[&str; 4], layers: [&Mapping; 3]) -> Result<Host, Bad> {
    let mut flat = Vec::new();
    for layer in layers {
        flat.extend(ssh_block(layer, at)?);
        flat.push(layer);
    }
    let field = |key: &'static str| [&at[..], &[key]].concat();
    let ip = first(&layers, "ip").and_then(text).unwrap_or_default();
    if ip.trim().is_empty() {
        return bad(&field("ip"), "missing: every Host needs an address");
    }
    let user = first(&flat, "user").and_then(text).unwrap_or_default();
    let port = match first(&flat, "port") {
        None => 22,
        Some(v) => match text(v).and_then(|p| p.parse().ok()) {
            Some(p) if p > 0 => p,
            _ => return bad(&field("port"), "must be a number from 1 to 65535"),
        },
    };
    Ok(Host {
        name: at[3].into(),
        group: at[1].into(),
        ip: ip.trim().into(),
        user: user.trim().into(),
        port,
        auth: first(&flat, "auth")
            .and_then(text)
            .unwrap_or("prompt".into()),
        title: first(&layers, "title").and_then(text).unwrap_or_default(),
    })
}
