//! `roster add`, and writing a new Host into roster.yml as text, so every
//! comment, order and format around it stays. The vault import shares it.

use crate::inventory::{Inventory, is_name};
use crate::{Fail, atomic, import, setup, usage_error};

/// A Host to write: `NAME: {ip: .., port: .., user: .., auth: .., enroll: false}`.
pub struct NewHost {
    pub name: String,
    pub group: String,
    pub ip: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub auth: Option<String>,
    pub enroll: bool,
}

impl NewHost {
    fn line(&self) -> String {
        let mut fields = vec![format!("ip: {}", quote(&self.ip))];
        fields.extend(self.port.map(|p| format!("port: {p}")));
        fields.extend(self.user.as_deref().map(|u| format!("user: {}", quote(u))));
        fields.extend(self.auth.as_deref().map(|a| format!("auth: {}", quote(a))));
        fields.extend((!self.enroll).then(|| "enroll: false".to_string()));
        // Adding a Host (or its login to the vault) is the review: it's set
        // up even under `defaults: reviewed: false`.
        fields.push("reviewed: true".to_string());
        format!("{}: {{{}}}", self.name, fields.join(", "))
    }
}

/// A YAML double-quoted string.
fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' | '"' => out.extend(['\\', c]),
            c if c.is_control() => out += &format!("\\u{:04x}", c as u32),
            c => out.push(c),
        }
    }
    out + "\""
}

/// A mapping line's indent, key, and value (comments dropped); None for a
/// blank or comment line.
fn entry(line: &str) -> Option<(usize, &str, &str)> {
    let body = line.trim_start();
    if body.is_empty() || body.starts_with('#') {
        return None;
    }
    let (key, rest) = body.split_once(':').unwrap_or((body, ""));
    let rest = rest.trim();
    let rest = if rest.starts_with('#') { "" } else { rest };
    Some((
        line.len() - body.len(),
        key.trim().trim_matches(['"', '\'']),
        rest,
    ))
}

/// The lines under line `at`: up to the next entry indented no deeper.
fn block(lines: &[&str], at: usize, indent: usize) -> std::ops::Range<usize> {
    let end = (at + 1..lines.len()).find(|&i| entry(lines[i]).is_some_and(|e| e.0 <= indent));
    at + 1..end.unwrap_or(lines.len())
}

/// The indent of a block's entries, else `deeper`.
fn inner(lines: &[&str], r: std::ops::Range<usize>, deeper: usize) -> usize {
    r.filter_map(|i| entry(lines[i]))
        .next()
        .map_or(deeper, |e| e.0)
}

/// Where to insert: after the block's last entry (its header if none).
fn end_of(lines: &[&str], r: std::ops::Range<usize>) -> usize {
    let start = r.start;
    r.rev()
        .find(|&i| entry(lines[i]).is_some())
        .map_or(start, |i| i + 1)
}

/// Find `key` among the block's entries; error if its value is flow style.
fn child(lines: &[&str], r: std::ops::Range<usize>, key: &str) -> Result<Option<usize>, String> {
    let indent = inner(lines, r.clone(), 0);
    let found = r
        .into_iter()
        .find(|&i| entry(lines[i]).is_some_and(|e| e.0 == indent && e.1 == key));
    match found.map(|i| (i, entry(lines[i]).unwrap_or_default().2)) {
        Some((_, rest)) if !rest.is_empty() => Err(format!(
            "`{key}:` is written in flow style; make it a block to add Hosts"
        )),
        found => Ok(found.map(|(i, _)| i)),
    }
}

/// `text` with `host` added under `groups.GROUP.hosts`; a missing group or
/// `hosts:` is created at the end of its parent.
fn insert(text: &str, group: &str, host: &str) -> Result<String, String> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let at = |i: usize| entry(lines[i]).unwrap_or_default();
    let g = (0..lines.len()).find(|&i| at(i).0 == 0 && at(i).1 == "groups");
    let g = g.ok_or("roster.yml has no `groups:`")?;
    if !at(g).2.is_empty() {
        return Err("`groups:` is written in flow style; make it a block to add Hosts".into());
    }
    let groups = block(&lines, g, 0);
    // The indent of `groups:` entries is the step for new lines too.
    let gi = inner(&lines, groups.clone(), 2);
    let pad = |n: usize, s: &str| format!("{}{s}\n", " ".repeat(n));
    let (pos, new) = match child(&lines, groups.clone(), group)? {
        None => {
            let new = pad(gi, &format!("{group}:")) + &pad(gi * 2, "hosts:") + &pad(gi * 3, host);
            (end_of(&lines, groups), new)
        }
        Some(i) => {
            let body = block(&lines, i, gi);
            let hi = inner(&lines, body.clone(), gi * 2);
            match child(&lines, body.clone(), "hosts")? {
                None => (
                    end_of(&lines, body),
                    pad(hi, "hosts:") + &pad(hi + gi, host),
                ),
                Some(h) => {
                    let hosts = block(&lines, h, hi);
                    (
                        end_of(&lines, hosts.clone()),
                        pad(inner(&lines, hosts, hi + gi), host),
                    )
                }
            }
        }
    };
    let mut out = lines[..pos].concat();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out + &new + &lines[pos..].concat())
}

/// Write `h` into the Inventory's file: refused if the name is taken, or if
/// the result won't load; nothing is written then.
pub fn save(inv: &Inventory, h: &NewHost) -> Result<(), Fail> {
    let fail = |msg: String| Fail {
        code: 1,
        msg: format!("can't add {}: {msg}", h.name),
    };
    if let Some(old) = inv.hosts.iter().find(|o| o.name == h.name) {
        return Err(fail(format!(
            "a Host of that name is in group {}",
            old.group
        )));
    }
    let path = &inv.path;
    let text = std::fs::read_to_string(path)
        .map_err(|e| fail(format!("{}: {}", path.display(), crate::errors::io(&e))))?;
    let text = insert(&text, &h.group, &h.line()).map_err(fail)?;
    let new = Inventory::load(path.clone(), &text)
        .map_err(|e| fail(format!("the result won't load: {}", e.msg)))?;
    // No second Host for one login: the same address, port and user as a
    // Host already there (resolved through defaults and the group). Another
    // user, or another port, is another login and allowed.
    let login = |o: &crate::inventory::Host| (o.ip.to_lowercase(), o.port, o.user.clone());
    if let Some(added) = new.hosts.iter().find(|o| o.name == h.name) {
        if let Some(twin) = new
            .hosts
            .iter()
            .find(|o| o.name != h.name && login(o) == login(added))
        {
            return Err(fail(format!(
                "{} is already {}:{} as {}",
                twin.name, added.ip, added.port, added.user
            )));
        }
    }
    atomic::write(path, text.as_bytes(), 0o600)
        .map_err(|e| fail(format!("{}: {}", path.display(), crate::errors::io(&e))))
}

/// `roster add` flags as given: `(flag, value)`.
#[derive(Default)]
pub struct Args {
    pub name: Option<String>,
    pub flags: Vec<(String, String)>,
}

pub fn run(inv: Inventory, args: Args) -> Result<(), Fail> {
    let flag = |k: &str| {
        args.flags
            .iter()
            .rev()
            .find(|f| f.0 == k)
            .map(|f| f.1.clone())
    };
    let name = flag("name").or(args.name.clone());
    if let Some(bad) = name.as_ref().filter(|n| !is_name(n)) {
        return Err(usage_error(format!(
            "'{bad}' isn't a Host name (letters, digits, . _ -)"
        )));
    }
    let h = match flag("from-vault") {
        Some(item) => import::one(&item, name, flag("group"))?,
        None => NewHost {
            name: name.ok_or_else(|| usage_error("add needs a NAME"))?,
            group: flag("group").unwrap_or_else(|| "vault".into()),
            ip: flag("ip").ok_or_else(|| usage_error("add needs --ip ADDR"))?,
            port: match flag("port").map(|p| p.parse()) {
                Some(Ok(p)) => Some(p),
                Some(Err(_)) => return Err(usage_error("--port needs a number")),
                None => None,
            },
            user: flag("user"),
            auth: flag("auth"),
            enroll: match flag("enroll").as_deref() {
                None | Some("true") => true,
                Some("false") => false,
                Some(_) => return Err(usage_error("--enroll is true or false")),
            },
        },
    };
    save(&inv, &h)?;
    println!(
        "added {} to {} (group {})",
        h.name,
        inv.path.display(),
        h.group
    );
    setup::box_files(&Inventory::open(Some(inv.path))?)
}
