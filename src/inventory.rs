//! The Inventory: finds and loads `roster.yml` into a list of Hosts.
//! No I/O beyond reading the file.

use crate::Fail;
use serde_norway::Value;
use std::path::PathBuf;

pub struct Inventory {
    pub hosts: Vec<Host>,
}

/// A resolved Host. Never holds a secret, so it can be printed whole.
#[derive(serde::Serialize)]
pub struct Host {
    pub name: String,
    pub group: String,
    pub ip: String,
    pub user: Option<String>,
    pub access: &'static str,
    pub title: String,
}

impl Inventory {
    /// Load from `-c FILE`, else `$ROSTER_CONFIG`, else `./roster.yml`,
    /// else `~/.config/roster/roster.yml`.
    pub fn open(flag: Option<PathBuf>) -> Result<Inventory, Fail> {
        let path = find(flag)?;
        let text = std::fs::read_to_string(&path).map_err(|e| broken(&path, e))?;
        let hosts = parse(&text).map_err(|e| broken(&path, e))?;
        Ok(Inventory { hosts })
    }
}

/// The Inventory path by the lookup order, or None when no file is found.
pub fn locate(flag: Option<PathBuf>) -> Option<PathBuf> {
    flag.or_else(|| std::env::var_os("ROSTER_CONFIG").map(PathBuf::from))
        .or_else(|| candidates().into_iter().find(|p| p.is_file()))
}

fn candidates() -> [PathBuf; 2] {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    [
        PathBuf::from("roster.yml"),
        home.join(".config/roster/roster.yml"),
    ]
}

fn find(flag: Option<PathBuf>) -> Result<PathBuf, Fail> {
    let candidates = candidates();
    match locate(flag) {
        Some(path) => Ok(path),
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

fn broken(path: &std::path::Path, e: impl std::fmt::Display) -> Fail {
    Fail {
        code: 3,
        msg: format!("{}: {e}", path.display()),
    }
}

fn parse(text: &str) -> Result<Vec<Host>, String> {
    let doc: Value = serde_norway::from_str(text).map_err(|e| e.to_string())?;
    let groups = doc
        .get("groups")
        .and_then(Value::as_mapping)
        .ok_or("no 'groups' mapping")?;
    let mut hosts = Vec::new();
    for (group, body) in groups {
        let group = group.as_str().ok_or("a group name is not a string")?;
        let Some(members) = body.get("hosts").and_then(Value::as_mapping) else {
            continue;
        };
        for (name, fields) in members {
            let name = name
                .as_str()
                .ok_or(format!("group {group}: a Host name is not a string"))?;
            hosts.push(host(group, name, fields)?);
        }
    }
    Ok(hosts)
}

/// A Host is `NAME: "IP"` or `NAME: {ip, user, title, ...}`.
fn host(group: &str, name: &str, fields: &Value) -> Result<Host, String> {
    let field = |key: &str| fields.get(key).and_then(Value::as_str).map(String::from);
    let ip = fields.as_str().map(String::from).or_else(|| field("ip"));
    Ok(Host {
        name: name.into(),
        group: group.into(),
        ip: ip.ok_or(format!("Host {name}: no ip"))?,
        user: field("user"),
        access: "key", // password and unreviewed come with the full cascade
        title: field("title").unwrap_or_default(),
    })
}
