//! The Inventory: finds and loads `roster.yml` into resolved Hosts.
//! No I/O beyond reading the file; nothing is fetched from a vault here.

use crate::Fail;
use serde_norway::{Mapping, Value};
use std::path::{Path, PathBuf};

#[allow(dead_code)] // fields read by the commands later tickets add
pub struct Inventory {
    /// The file it was loaded from, as found.
    pub path: PathBuf,
    /// This Box's name in key tags: `box_name`, else the short hostname,
    /// with characters other than letters, digits, `_` and `-` made `-`.
    pub box_name: String,
    /// This Box's key file as written (`~` not expanded): `key_path`, else
    /// `~/.ssh/roster_<key_type>`.
    pub key_path: String,
    /// The canonical key type: `ed25519`, `ecdsa`, `ecdsa-256`, `rsa-4096`, ...
    pub key_type: String,
    pub hosts: Vec<Host>,
    pub links: Vec<Link>,
    /// The groups in file order, with their own `title` and `description`.
    pub groups: Vec<Group>,
}

/// A group as it describes itself; what its Hosts inherit is in each Host.
pub struct Group {
    pub name: String,
    pub title: String,
    pub description: String,
}

/// One `links:` entry. Each end names a Host or a group.
#[allow(dead_code)]
pub struct Link {
    pub from: String,
    pub to: String,
    /// true: two-way.
    pub both: bool,
    /// The Host the source reaches the peer through.
    pub via: Option<String>,
}

/// A Host with the cascade resolved: built-in < `defaults` < group < Host,
/// and at each layer `ssh: {user, port, auth}` beats the plain fields.
#[allow(dead_code)]
pub struct Host {
    pub name: String,
    pub group: String,
    pub ip: String,
    pub user: String,
    pub port: u16,
    /// A vault reference (`bw:ITEM`, `cmd:...`, `prompt`), never resolved here.
    pub auth: String,
    /// false: a Password Host, reached with `auth`.
    pub enroll: bool,
    /// false: found by a scan, not set up yet.
    pub reviewed: bool,
    /// `posix` or `windows`.
    pub os: String,
    /// Canonical, as `Inventory::key_type`; the Inventory's unless set.
    pub key_type: String,
    pub mesh: Option<bool>,
    /// `seen_as` (on the Host) or `mesh_dir`, when set: Mesh settings v1
    /// doesn't follow yet.
    pub mesh_unsupported: Option<&'static str>,
    /// In Inventory order; the entries roster can't use are left out.
    pub services: Vec<Service>,
    /// The web UI: the `web` service's URL, else the first service given one.
    pub web: Option<String>,
    pub title: String,
    /// `description`, else the legacy `notes`.
    pub description: String,
    pub r#type: String,
    pub product: String,
}

#[allow(dead_code)]
pub struct Service {
    pub name: String,
    pub port: u16,
    pub url: Option<String>,
    /// `http`, `https`, another the Inventory names, or None when unknown.
    pub scheme: Option<String>,
    pub user: Option<String>,
    /// A vault reference, as `Host::auth`.
    pub auth: Option<String>,
    pub verify: bool,
    /// `basic`, `bearer` or `none`.
    pub login: String,
}

impl Host {
    /// FILTER is comma-separated words; one equal to the Host's name, group,
    /// `type` or `product` is a match.
    pub fn matches(&self, filter: &str) -> bool {
        let mine = [&self.name, &self.group, &self.r#type, &self.product];
        filter
            .split(',')
            .map(str::trim)
            .any(|w| !w.is_empty() && mine.iter().any(|m| *m == w))
    }

    /// How roster reaches it: `unreviewed`, `key` or `password`.
    pub fn access(&self) -> &'static str {
        match (self.reviewed, self.enroll) {
            (false, _) => "unreviewed",
            (true, true) => "key",
            (true, false) => "password",
        }
    }
}

impl Inventory {
    /// Load from `-c FILE`, else `$ROSTER_CONFIG`, else `./roster.yml`,
    /// else `~/.config/roster/roster.yml`.
    pub fn open(flag: Option<PathBuf>) -> Result<Inventory, Fail> {
        let path = find(flag)?;
        let text = std::fs::read_to_string(&path).map_err(|e| broken(&path, None, e))?;
        let doc: Value = serde_norway::from_str(&text).map_err(|e| broken(&path, None, e))?;
        let inventory = parse(&doc).map_err(|b| {
            let line = line_of(&text, &b.at);
            broken(&path, line, format!("{}: {}", b.at.join("."), b.why))
        })?;
        Ok(Inventory { path, ..inventory })
    }

    /// The Box key `h` logs in with (`~` not expanded), the one of its own
    /// `key_type`: `key_path` for the Inventory's type, else `roster_<type>`
    /// beside it, as v0.7.0.
    pub fn key_of(&self, h: &Host) -> String {
        if h.key_type == self.key_type {
            return self.key_path.clone();
        }
        match self.key_path.rsplit_once('/') {
            Some((dir, _)) => format!("{dir}/roster_{}", h.key_type),
            None => format!("roster_{}", h.key_type),
        }
    }

    /// Every variable a secret may come from: each `env:VAR` the Hosts and
    /// services name, and Bitwarden's.
    pub fn secret_vars(&self) -> Vec<String> {
        let mut vars = vec!["BW_PASSWORD".to_string(), "BW_SESSION".to_string()];
        for h in &self.hosts {
            let services = h.services.iter().filter_map(|s| s.auth.as_deref());
            for auth in std::iter::once(h.auth.as_str()).chain(services) {
                if let Some(var) = auth.strip_prefix("env:") {
                    vars.push(var.to_string());
                }
            }
        }
        vars
    }

    /// The Hosts a TARGET names: Host and group names, comma-separated, in
    /// the order given, each Host once. Unreviewed Hosts are included; the
    /// caller skips them. An unknown name exits 1.
    pub fn targets(&self, target: &str) -> Result<Vec<&Host>, Fail> {
        let mut found: Vec<&Host> = Vec::new();
        for word in target.split(',').map(str::trim).filter(|w| !w.is_empty()) {
            let hosts: Vec<_> = self.hosts.iter().filter(|h| h.name == word).collect();
            let hosts = match hosts.is_empty() {
                true => self.hosts.iter().filter(|h| h.group == word).collect(),
                false => hosts,
            };
            if hosts.is_empty() {
                let msg = format!("no Host or group named '{word}' in the Inventory");
                return Err(Fail { code: 1, msg });
            }
            for h in hosts {
                if !found.iter().any(|f| f.name == h.name) {
                    found.push(h);
                }
            }
        }
        match found.is_empty() {
            true => Err(crate::usage_error("needs a TARGET: Hosts or groups")),
            false => Ok(found),
        }
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
/// A number in AT is a list item, counted from 1.
fn line_of(text: &str, at: &[String]) -> Option<usize> {
    let lines: Vec<&str> = text.lines().collect();
    let (mut found, mut from, mut parent) = (None, 0, None::<usize>);
    for key in at {
        let mut block = (from..lines.len())
            .map(|n| {
                let t = lines[n].trim_start();
                (n, t, lines[n].len() - t.len())
            })
            .filter(|(_, t, _)| !t.is_empty() && !t.starts_with('#'))
            .take_while(|&(_, t, i)| {
                parent.is_none_or(|p| i > p || (i == p && t.starts_with("- ")))
            });
        let hit = if let Ok(item) = key.parse::<usize>() {
            let mut items = block.filter(|(_, t, _)| t.starts_with("- "));
            let first = items.next();
            let indent = first.map(|(_, _, i)| i);
            first
                .into_iter()
                .chain(items.filter(|&(_, _, i)| Some(i) == indent))
                .nth(item.wrapping_sub(1))
        } else {
            let keys = [
                format!("{key}:"),
                format!("\"{key}\":"),
                format!("'{key}':"),
            ];
            block.find(|(_, t, _)| {
                keys.iter()
                    .any(|k| t.trim_start_matches("- ").starts_with(k.as_str()))
            })
        };
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

/// Collapse runs of whitespace, newlines included, to one space.
fn oneline(v: Option<&Value>) -> String {
    let s = v.and_then(text).unwrap_or_default();
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A boolean as v0.7.0 reads it: YAML 1.1's true/false, yes/no, on/off and
/// y/n, any case; null is false. None for anything else.
fn flag(v: &Value) -> Option<bool> {
    match v {
        Value::Null => Some(false),
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.to_lowercase().as_str() {
            "true" | "yes" | "on" | "y" => Some(true),
            "false" | "no" | "off" | "n" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

const BOOL: &str = "must be true or false (yes/no and on/off work too)";

fn port_of(v: &Value) -> Option<u16> {
    text(v)?.trim().parse().ok().filter(|&p| p > 0)
}

/// `ed25519`, `ecdsa[-256|-384|-521]` or `rsa[-BITS]` (3072 to 16384 bits),
/// any case, as its canonical name: `ecdsa` is P-384 and `rsa` 3072 bits.
fn key_type(v: &Value) -> Option<String> {
    let s = text(v)?.trim().to_lowercase();
    let (alg, bits) = match s.split_once('-') {
        Some((a, b)) if !b.is_empty() && b.bytes().all(|c| c.is_ascii_digit()) => {
            (a, Some(b.parse::<u32>().ok()?))
        }
        Some(_) => return None,
        None => (s.as_str(), None),
    };
    match (alg, bits) {
        ("ed25519", None) => Some(s.clone()),
        ("ecdsa", None | Some(384)) => Some("ecdsa".into()),
        ("ecdsa", Some(b @ (256 | 521))) => Some(format!("ecdsa-{b}")),
        ("rsa", None | Some(3072)) => Some("rsa".into()),
        ("rsa", Some(b @ 3073..=16384)) => Some(format!("rsa-{b}")),
        _ => None,
    }
}

const KEY_TYPES: &str =
    "must be ed25519, ecdsa, ecdsa-256, ecdsa-521, rsa or rsa-BITS (3072 to 16384)";

/// `box_name` or the short hostname, as it goes into a key's tag:
/// `[A-Za-z0-9_-]+`, or refused.
fn box_name(given: Option<String>) -> Result<String, Bad> {
    let host = || std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default();
    let name = given.unwrap_or_else(|| host().trim().split('.').next().unwrap_or("").into());
    let name: String = name
        .chars()
        .map(|c| match c.is_ascii_alphanumeric() || c == '_' {
            true => c,
            false => '-',
        })
        .collect();
    match name.is_empty() {
        true => bad(&["box_name"], "empty: set box_name to this Box's name"),
        false => Ok(name),
    }
}

fn parse(doc: &Value) -> Result<Inventory, Bad> {
    let empty = Mapping::new();
    let defaults = as_map(&doc["defaults"], &["defaults"], "a mapping")?.unwrap_or(&empty);
    let key_type = match doc.get("key_type") {
        None | Some(Value::Null) => "ed25519".into(),
        Some(v) => self::key_type(v).map_or_else(|| bad(&["key_type"], KEY_TYPES), Ok)?,
    };
    let key_path = text(&doc["key_path"]).unwrap_or(format!("~/.ssh/roster_{key_type}"));
    if key_path.contains('"') || key_path.chars().any(char::is_control) {
        return bad(&["key_path"], "can't hold a quote or a control character");
    }
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
    let mut described = Vec::new();
    for (group, body) in groups {
        let group = text(group).unwrap_or_default();
        let g = &["groups", &group];
        let body = as_map(body, g, "a mapping")?.unwrap_or(&empty);
        described.push(Group {
            name: group.clone(),
            title: oneline(body.get("title")),
            description: oneline(body.get("description")),
        });
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
            if !is_name(&name) {
                return bad(&at, "a Host name is letters, digits, . _ and -");
            }
            if let Some(other) = hosts.iter().find(|h: &&Host| h.name == name) {
                let why = format!("listed twice, in groups {} and {group}", other.group);
                return bad(&at, why + ": a Host is in one group");
            }
            let short; // `NAME: "10.0.0.5"` is `NAME: {ip: 10.0.0.5}`
            let own = match fields {
                Value::String(ip) => {
                    short = Mapping::from_iter([("ip".into(), ip.as_str().into())]);
                    &short
                }
                _ => as_map(fields, &at, "an address or a mapping")?.unwrap_or(&empty),
            };
            hosts.push(host(&at, [own, &inherited, defaults], &key_type)?);
        }
    }
    let groups: Vec<String> = groups.keys().filter_map(text).collect();
    Ok(Inventory {
        path: PathBuf::new(),
        box_name: box_name(text(&doc["box_name"]))?,
        key_path,
        key_type,
        links: links(&doc["links"], &hosts, &groups)?,
        hosts,
        groups: described,
    })
}

/// `links: [{from, to, both, via}]`: each end a Host or a group, `via` a
/// Host that isn't an end, and nothing else in an entry.
fn links(v: &Value, hosts: &[Host], groups: &[String]) -> Result<Vec<Link>, Bad> {
    let entries = match v {
        Value::Null => return Ok(Vec::new()),
        Value::Sequence(s) => s,
        _ => return bad(&["links"], "must be a list of {from, to, both, via}"),
    };
    let is_host = |n: &str| hosts.iter().any(|h| h.name == n);
    let is_group = |n: &str| groups.iter().any(|g| g == n);
    let mut out = Vec::new();
    for (n, entry) in entries.iter().enumerate() {
        let n = (n + 1).to_string();
        let at = |key: &'static str| {
            if key.is_empty() {
                vec!["links", &n]
            } else {
                vec!["links", &n, key]
            }
        };
        let ok = entry.as_mapping().is_some_and(|m| {
            m.contains_key("from")
                && m.contains_key("to")
                && m.keys()
                    .all(|k| matches!(k.as_str(), Some("from" | "to" | "both" | "via")))
        });
        if !ok {
            return bad(
                &at(""),
                "must be {from: HOST-OR-GROUP, to: HOST-OR-GROUP, both: true, via: HOST}, nothing else",
            );
        }
        let mut ends = Vec::new();
        for key in ["from", "to"] {
            let name = text(&entry[key]).unwrap_or_default();
            if is_host(&name) && is_group(&name) {
                return bad(
                    &at(key),
                    format!("{name} is both a Host and a group: rename one"),
                );
            }
            if !is_host(&name) && !is_group(&name) {
                return bad(&at(key), format!("{name:?} isn't a Host or a group"));
            }
            ends.push(name);
        }
        if ends[0] == ends[1] {
            return bad(&at(""), format!("links {} to itself", ends[0]));
        }
        let both = flag(&entry["both"]).map_or_else(|| bad(&at("both"), BOOL), Ok)?;
        let via = text(&entry["via"]);
        if let Some(via) = &via {
            if !is_host(via) || ends.contains(via) {
                return bad(
                    &at("via"),
                    format!("{via:?} must be a Host that isn't an end of the Link"),
                );
            }
        }
        let [from, to] = <[String; 2]>::try_from(ends).unwrap_or_default();
        out.push(Link {
            from,
            to,
            both,
            via,
        });
    }
    Ok(out)
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

/// Host names: letters, digits, `.`, `_` and `-`.
fn is_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `fe80::1%eth0`: the only place a `%` may appear in an address.
fn is_zoned_ipv6(ip: &str) -> bool {
    let Some((addr, zone)) = ip.split_once('%') else {
        return false;
    };
    addr.contains(':')
        && addr
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
        && is_name(zone)
}

/// LAYERS: the Host's own fields, its group's, then `defaults`.
fn host(at: &[&str; 4], layers: [&Mapping; 3], box_key: &str) -> Result<Host, Bad> {
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
    let ip = ip.trim();
    let unsafe_char = |s: &str| {
        s.chars()
            .any(|c| c.is_whitespace() || c == '"' || c.is_control())
    };
    if unsafe_char(ip) {
        return bad(
            &field("ip"),
            "can't hold a space, a quote or a control character",
        );
    }
    if ip.contains('%') && !is_zoned_ipv6(ip) {
        return bad(
            &field("ip"),
            "can't hold a % except as an IPv6 zone (fe80::1%eth0)",
        );
    }
    let user = first(&flat, "user").and_then(text).unwrap_or_default();
    let user = user.trim();
    if user.is_empty() {
        return bad(
            &field("user"),
            "missing: set it on the Host, its group or defaults",
        );
    }
    if unsafe_char(user) || user.contains('%') {
        return bad(
            &field("user"),
            "can't hold a space, a quote, a % or a control character",
        );
    }
    let port = match first(&flat, "port") {
        None => 22,
        Some(v) => port_of(v).map_or_else(
            || bad(&field("port"), "must be a number from 1 to 65535"),
            Ok,
        )?,
    };
    let os = match first(&layers, "os") {
        None | Some(Value::Null) => "posix".into(),
        Some(v) => match text(v).map(|s| s.trim().to_lowercase()) {
            Some(os) if os == "posix" || os == "windows" => os,
            _ => return bad(&field("os"), "must be windows or posix"),
        },
    };
    let key_type = match first(&layers, "key_type") {
        None | Some(Value::Null) => box_key.into(),
        Some(v) => key_type(v).map_or_else(|| bad(&field("key_type"), KEY_TYPES), Ok)?,
    };
    let boolean = |key: &'static str, default: bool| match first(&layers, key) {
        None => Ok(default),
        Some(v) => flag(v).map_or_else(|| bad(&field(key), BOOL), Ok),
    };
    let (enroll, reviewed) = (boolean("enroll", true)?, boolean("reviewed", true)?);
    let mesh = match first(&layers, "mesh") {
        None | Some(Value::Null) => None,
        Some(_) => Some(boolean("mesh", false)?),
    };
    let mut host = Host {
        name: at[3].into(),
        group: at[1].into(),
        ip: ip.into(),
        user: user.into(),
        port,
        auth: first(&flat, "auth")
            .and_then(text)
            .unwrap_or("prompt".into()),
        enroll,
        reviewed,
        os,
        key_type,
        mesh,
        mesh_unsupported: match () {
            _ if layers[0].contains_key("seen_as") => Some("seen_as"),
            _ if first(&layers, "mesh_dir").is_some() => Some("mesh_dir"),
            _ => None,
        },
        services: Vec::new(),
        web: None,
        title: oneline(first(&layers, "title")),
        description: oneline(first(&layers, "description")),
        r#type: oneline(first(&layers, "type")),
        product: oneline(first(&layers, "product")),
    };
    if host.description.is_empty() {
        host.description = oneline(first(&layers, "notes"));
    }
    (host.services, host.web) = services(&host, &field("services"), &layers)?;
    Ok(host)
}

const SERVICE_KEYS: [&str; 7] = ["port", "url", "scheme", "user", "auth", "verify", "login"];

/// Services merge per name, field by field: defaults < group < Host. An
/// entry roster can't use is left out; the rest of the Host still loads.
fn services(
    h: &Host,
    at: &[&str],
    layers: &[&Mapping; 3],
) -> Result<(Vec<Service>, Option<String>), Bad> {
    let mut merged: Vec<(String, Mapping)> = Vec::new();
    let mut broken = Vec::new();
    if let Some(url) = first(layers, "web")
        .and_then(text)
        .filter(|u| !u.is_empty())
    {
        merged.push((
            "web".into(),
            Mapping::from_iter([("url".into(), url.into())]),
        ));
    }
    for layer in layers.iter().rev() {
        let entries = as_map(
            layer.get("services").unwrap_or(&Value::Null),
            at,
            "a mapping of name: port or url",
        )?;
        for (name, v) in entries.into_iter().flatten() {
            let name = text(name).unwrap_or_default();
            let entry = match v {
                Value::Mapping(m) => m.clone(),
                Value::String(s) if s.contains("://") => {
                    Mapping::from_iter([("url".into(), v.clone())])
                }
                _ => Mapping::from_iter([("port".into(), v.clone())]),
            };
            let unknown = entry
                .keys()
                .any(|k| !SERVICE_KEYS.contains(&k.as_str().unwrap_or("")));
            if !is_name(&name) || unknown {
                broken.push(name.clone());
            }
            match merged.iter_mut().find(|(n, _)| *n == name) {
                Some((_, m)) => m.extend(entry),
                None => merged.push((name, entry)),
            }
        }
    }
    let login = (
        first(layers, "user").and_then(text),
        first(layers, "auth").and_then(text),
    );
    let services: Vec<Service> = merged
        .iter()
        .filter(|(name, _)| !broken.contains(name))
        .filter_map(|(name, e)| service(name, e, &h.ip, &login))
        .collect();
    let has_url = |n: &str| merged.iter().any(|(m, e)| m == n && e.contains_key("url"));
    let web = ["web"]
        .into_iter()
        .chain(merged.iter().map(|(n, _)| n.as_str()))
        .find(|n| has_url(n) && services.iter().any(|s| s.name == *n));
    let web = web.and_then(|n| services.iter().find(|s| s.name == n)?.url.clone());
    Ok((services, web))
}

/// One service entry resolved, or None when roster can't use it.
fn service(
    name: &str,
    e: &Mapping,
    ip: &str,
    login: &(Option<String>, Option<String>),
) -> Option<Service> {
    let given_port = e.get("port").filter(|v| !v.is_null());
    let mut scheme = e.get("scheme").and_then(text);
    let (port, url) = match e.get("url").and_then(text).filter(|u| !u.is_empty()) {
        Some(url) => {
            let url = url.trim();
            let url = if url.contains("://") {
                url.to_string()
            } else {
                format!("https://{url}")
            };
            let (s, port) = url_parts(&url)?;
            if given_port.is_some_and(|p| port_of(p) != Some(port)) {
                return None;
            }
            scheme = Some(s);
            (port, Some(url))
        }
        None => {
            let port = port_of(given_port?)?;
            scheme = scheme.or_else(|| match port {
                _ if name.starts_with("https") || [443, 8443].contains(&port) => {
                    Some("https".into())
                }
                _ if name.starts_with("http") || [80, 8000, 8008, 8080, 8888].contains(&port) => {
                    Some("http".into())
                }
                _ => None,
            });
            let url = match scheme.as_deref() {
                Some(s @ ("http" | "https")) if port == if s == "https" { 443 } else { 80 } => {
                    Some(format!("{s}://{ip}"))
                }
                Some(s @ ("http" | "https")) => Some(format!("{s}://{ip}:{port}")),
                _ => None,
            };
            (port, url)
        }
    };
    let login_type = e.get("login").map_or(Some("basic".into()), text)?;
    if !["basic", "bearer", "none"].contains(&login_type.as_str()) {
        return None;
    }
    let or_host = |key: &str, host: &Option<String>| match e.get(key) {
        Some(v) => text(v).map(|s| s.trim().to_string()),
        None => host.clone(),
    };
    let verify = e.get("verify").map_or(Some(true), flag)?;
    Some(Service {
        name: name.into(),
        port,
        url,
        scheme,
        user: or_host("user", &login.0),
        auth: or_host("auth", &login.1),
        verify,
        login: login_type,
    })
}

/// A URL's scheme and port: `http(s)://HOST[:PORT][/PATH]`, no whitespace.
fn url_parts(url: &str) -> Option<(String, u16)> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_lowercase();
    let default = match scheme.as_str() {
        "https" => 443,
        "http" => 80,
        _ => return None,
    };
    if url.chars().any(char::is_whitespace) {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !p.contains(']') => (h, Some(p)),
        _ => (authority, None),
    };
    let port = match port {
        Some(p) => p.parse().ok().filter(|&p| p > 0)?,
        None => default,
    };
    (!host.is_empty()).then_some((scheme, port))
}
