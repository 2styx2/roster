//! Hosts from the vault: `roster sync` imports each new login item named
//! `HOST ssh` or `HOST ssh+X`, and `roster add --from-vault` any one item.
//! Only names, ids, folders, URIs and user names are read; the typed parse
//! below has no password field, so a password is never even copied.

use crate::add::{NewHost, save};
use crate::inventory::{Inventory, is_name};
use crate::{Fail, bw};
use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Item {
    #[serde(rename = "type")]
    kind: u8,
    id: String,
    name: String,
    #[serde(rename = "folderId")]
    folder: Option<String>,
    login: Option<Login>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Login {
    username: Option<String>,
    uris: Option<Vec<Uri>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Uri {
    uri: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Folder {
    id: Option<String>,
    name: String,
}

pub struct Vault {
    items: Vec<Item>,
    folders: Vec<Folder>,
}

/// The vault as it is now, or why it can't be read without a prompt.
pub fn open() -> Result<Vault, String> {
    let [items, folders] = bw::list()?;
    let bad = |e: serde_json::Error| format!("bw gave bad JSON: {e}");
    Ok(Vault {
        items: serde_json::from_slice(&items).map_err(bad)?,
        folders: serde_json::from_slice(&folders).map_err(bad)?,
    })
}

/// `HOST ssh` or `HOST ssh+X`, `ssh` in any case: HOST.
fn convention(name: &str) -> Option<&str> {
    let (host, tag) = name.split_once(' ')?;
    let tag = tag.to_ascii_lowercase();
    (is_name(host) && (tag == "ssh" || tag.starts_with("ssh+"))).then_some(host)
}

/// A valid name from free text: `Lab Servers` is `lab-servers`.
fn name_of(text: &str) -> String {
    let lower = text.to_lowercase();
    let words = lower.split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')));
    words
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// A URI's address and port: `ssh://[user@]host[:port]`, `host[:port]`, or
/// another scheme's (http, https) host with port 22.
fn address(uri: &str) -> Option<(String, u16)> {
    let (ssh, rest) = match uri.trim().split_once("://") {
        Some((scheme, rest)) => (scheme.eq_ignore_ascii_case("ssh"), rest),
        None => (true, uri.trim()),
    };
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
    let (host, port) = match authority.strip_prefix('[') {
        Some(v6) => v6.split_once(']').map(|(h, p)| (h, p.strip_prefix(':')))?,
        None if authority.matches(':').count() == 1 => {
            authority.split_once(':').map(|(h, p)| (h, Some(p)))?
        }
        None => (authority, None),
    };
    let port = match (ssh, port) {
        (true, Some(p)) => p.parse().ok().filter(|&p| p > 0)?,
        _ => 22,
    };
    (!host.is_empty()).then(|| (host.to_string(), port))
}

impl Vault {
    /// The Host `item` makes as NAME, in GROUP or its folder's group.
    fn host(&self, item: &Item, name: String, group: Option<String>) -> Result<NewHost, String> {
        let login = item.login.as_ref().ok_or("it isn't a login item")?;
        let uri = login
            .uris
            .iter()
            .flatten()
            .next()
            .and_then(|u| u.uri.as_deref());
        let (ip, port) = uri
            .and_then(address)
            .ok_or("its first URI has no address")?;
        let unique = self.items.iter().filter(|o| o.name == item.name).count() == 1;
        let reference = match unique && !item.name.contains('#') {
            true => &item.name,
            false => &item.id,
        };
        let folder = self
            .folders
            .iter()
            .find(|f| f.id.is_some() && f.id == item.folder);
        let group = group.or_else(|| folder.map(|f| name_of(&f.name)).filter(|g| !g.is_empty()));
        Ok(NewHost {
            name,
            group: group.unwrap_or_else(|| "vault".into()),
            ip,
            port: Some(port),
            user: login.username.clone().filter(|u| !u.is_empty()),
            auth: Some(format!("bw:{reference}")),
            enroll: true,
        })
    }
}

/// Sync's import: each convention item no Host name or `auth:` uses yet
/// becomes a Host. A locked vault is one line on stderr. Returns whether
/// roster.yml changed.
pub fn sync(inv: &Inventory) -> bool {
    let vault = match open() {
        Ok(vault) => vault,
        Err(e) => {
            eprintln!("roster: vault import skipped: {e}");
            return false;
        }
    };
    let mut names: Vec<String> = inv.hosts.iter().map(|h| h.name.clone()).collect();
    let services = inv
        .hosts
        .iter()
        .flat_map(|h| h.services.iter().filter_map(|s| s.auth.as_deref()));
    let auths = inv.hosts.iter().map(|h| h.auth.as_str()).chain(services);
    let used: Vec<&str> = auths
        .filter_map(|a| a.strip_prefix("bw:"))
        .map(|a| a.split('#').next().unwrap_or(a))
        .collect();
    let mut changed = false;
    for item in vault.items.iter().filter(|i| i.kind == 1) {
        let Some(name) = convention(&item.name) else {
            continue;
        };
        if names.iter().any(|n| n == name)
            || used.contains(&item.name.as_str())
            || used.contains(&item.id.as_str())
        {
            continue;
        }
        let saved = vault
            .host(item, name.into(), None)
            .and_then(|h| save(inv, &h).map(|()| h).map_err(|f| f.msg));
        match saved {
            Ok(h) => println!("imported {} from the vault (group {})", h.name, h.group),
            Err(why) => {
                eprintln!("roster: skipped vault item '{}': {why}", item.name);
                continue;
            }
        }
        names.push(name.into());
        changed = true;
    }
    changed
}

/// `roster add --from-vault ITEM`: the Host that item (a name or an id)
/// makes, named NAME or after the item.
pub fn one(reference: &str, name: Option<String>, group: Option<String>) -> Result<NewHost, Fail> {
    let fail = |msg: String| Fail {
        code: 1,
        msg: format!("add --from-vault {reference}: {msg}"),
    };
    let vault = open().map_err(fail)?;
    let found: Vec<&Item> = vault
        .items
        .iter()
        .filter(|i| i.id == reference || i.name == reference)
        .collect();
    let item = match found[..] {
        [item] => item,
        [] => return Err(fail("no vault item has that name or id".into())),
        _ => {
            return Err(fail(
                "several vault items have that name; give the id".into(),
            ));
        }
    };
    let name = name
        .unwrap_or_else(|| convention(&item.name).map_or_else(|| name_of(&item.name), Into::into));
    vault.host(item, name, group).map_err(fail)
}
