//! What a Plugin may be granted (decision Q81). A Plugin's sandbox only has the functions for the
//! permissions it was granted, and each of those functions checks the grant again when called.
//! None of them reaches a secret: vault passwords, askpass and the master password live only in
//! `roster serve`, and the serve methods that touch them can't be granted at all.

use super::network::Site;
use serde::{Serialize, Serializer};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Permission {
    /// Hosts and Login references through serve's read methods (`hosts.list`, `host.get`), and
    /// the events that name a Host.
    InventoryRead,
    /// Inventory edits through serve's write methods; they land as Pending changes, never Published.
    InventoryWrite,
    /// Opening a Session on a Host, as `:open HOST` does.
    SessionsOpen,
    /// The text open Sessions print (`terminal_output` events).
    TerminalRead,
    /// Typing into an open Session.
    TerminalWrite,
    /// One `roster serve` method by name, from [`SERVE_METHODS`] or under [`SERVE_PREFIXES`].
    Serve(String),
    /// HTTP requests to one site (`network:api.example.com`), through `roster.http` (network.rs).
    Network(Site),
}

/// The serve methods a Plugin may be granted by name: none of them touches a secret.
pub const SERVE_METHODS: &[&str] = &[
    "inventory.info",
    "hosts.list",
    "host.get",
    "host.check",
    "host.check_job",
    "changes.diff",
];
/// The grantable methods that change nothing (read, or stop a Mesh job before its next Host): every
/// other one is flagged in the install prompt.
pub const READS: &[&str] = &[
    "inventory.info",
    "hosts.list",
    "host.get",
    "host.check_job",
    "changes.diff",
    "mesh.status",
    "mesh.plan",
    "mesh.job",
    "mesh.stop",
    "discover.plan",
    "discover.status",
    "discover.stop",
];
/// Whether a Plugin may call `method` only while the user runs one of its actions, commands or
/// finder items (a question's answer included), never at load, on an event, from a timer or as the
/// app asks (a finder's `items`, a `:check` section's `check`): every grantable method the install
/// prompt flags, the ones that act on the network or the Inventory (decision Q100). Derived from
/// the flag, not listed, so a method added under `mesh.` or `discover.` waits for the user unless
/// it's made a read; `inventory.write`'s methods (`host.update`, …) are none of the reads either.
pub fn serve_user_only(method: &str) -> bool {
    !READS.contains(&method)
}
/// Families a Plugin may be granted methods of (the mesh and discover Plugins, decision Q80).
pub const SERVE_PREFIXES: &[&str] = &["mesh.", "discover."];

/// Whether a Plugin may ever call `method` (vault, session, Quick Connect, Publish and the
/// methods that carry a password never are).
pub fn serve_method_allowed(method: &str) -> bool {
    SERVE_METHODS.contains(&method)
        || SERVE_PREFIXES
            .iter()
            .any(|p| method.len() > p.len() && method.starts_with(p) && is_name(&method[p.len()..]))
}

fn is_name(s: &str) -> bool {
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.')
}

impl Permission {
    /// `"inventory.read"`, `"serve:mesh.status"`, … as a manifest writes it.
    pub fn parse(text: &str) -> Result<Permission, String> {
        Ok(match text {
            "inventory.read" => Permission::InventoryRead,
            "inventory.write" => Permission::InventoryWrite,
            "sessions.open" => Permission::SessionsOpen,
            "terminal.read" => Permission::TerminalRead,
            "terminal.write" => Permission::TerminalWrite,
            "network" => {
                return Err(
                    "\"network\" names the site it may reach: \"network:api.example.com\", one for each site".into(),
                );
            }
            _ if text.starts_with("network:") => Permission::Network(Site::parse(&text["network:".len()..])?),
            _ => match text.strip_prefix("serve:") {
                Some(method) if serve_method_allowed(method) => Permission::Serve(method.to_string()),
                Some(method) => {
                    return Err(format!(
                        "\"serve:{method}\" can't be granted: a Plugin may call only {} and the mesh.* and discover.* methods, never one that reaches a secret",
                        SERVE_METHODS.join(", ")
                    ));
                }
                None => {
                    return Err(format!(
                        "{text:?} isn't a permission (there's inventory.read, inventory.write, sessions.open, terminal.read, terminal.write, serve:<method> and network:<site>)"
                    ));
                }
            },
        })
    }

    /// The grants the app kept (as text) that name a permission, and each one that doesn't any
    /// more with why (`"serve:x.y: …"`): a grant this version refuses runs as not granted.
    pub fn parse_grants(texts: &[String]) -> (Vec<Permission>, Vec<String>) {
        let mut grants = Vec::new();
        let mut refused = Vec::new();
        for text in texts {
            match Permission::parse(text) {
                Ok(p) => grants.push(p),
                Err(why) => refused.push(format!("{text}: {why}")),
            }
        }
        (grants, refused)
    }

    /// Whether the install prompt flags it, and why (shown under it).
    pub fn risk(&self) -> Option<String> {
        if let Permission::Network(site) = self {
            return Some(site.risk());
        }
        match (words(self), self) {
            (Some(w), _) => w.risk.map(String::from),
            (None, Permission::Serve(m)) if !READS.contains(&m.as_str()) => Some(SERVE_RISK.replace("{method}", m)),
            _ => None,
        }
    }

    /// One line on what it allows.
    pub fn summary(&self) -> String {
        if let Permission::Network(site) = self {
            return format!("Send and fetch over the network: {}", site.shown());
        }
        match (words(self), self) {
            (Some(w), _) if !w.summary.is_empty() => w.summary.into(),
            (_, Permission::Serve(m)) => SERVE_SUMMARY.replace("{method}", m),
            _ => self.to_string(),
        }
    }
}

/// What the install prompt says of a permission: one line on what it allows (empty: the serve
/// method's [`SERVE_SUMMARY`]), and why it's flagged, if it is.
#[derive(Debug, Clone, Copy)]
pub struct Words {
    pub name: &'static str,
    pub summary: &'static str,
    pub risk: Option<&'static str>,
}

/// The permissions with words of their own; every other `serve:` method has [`SERVE_SUMMARY`],
/// and [`SERVE_RISK`] unless it's a read.
pub const WORDS: &[Words] = &[
    Words {
        name: "inventory.read",
        summary: "Read your Hosts and their Login references (never a password)",
        risk: None,
    },
    Words {
        name: "inventory.write",
        summary: "Change Hosts, as Pending changes",
        risk: Some("Can change Hosts. The changes stay Pending until you review and Publish them."),
    },
    Words {
        name: "sessions.open",
        summary: "Open Sessions",
        risk: Some("Can open Sessions on your Hosts."),
    },
    Words {
        name: "terminal.read",
        summary: "Read what your Sessions print",
        risk: Some(
            "Sees everything your Sessions print, including anything a server echoes back. A password you type at a prompt that echoes it would be visible too.",
        ),
    },
    Words {
        name: "terminal.write",
        summary: "Type into your Sessions",
        risk: Some("Can type into your open Sessions, as if you typed it: it can run commands on your servers."),
    },
    Words {
        name: "serve:discover.start",
        summary: "Scan a network you name, from this computer",
        risk: Some(
            "Can scan networks from this computer, once you've confirmed it: roster connects to every address in a range, on many ports. A network's security tools may take a scan for an attack, so scan only networks you may.",
        ),
    },
    Words {
        name: "serve:discover.add",
        summary: "Add the Hosts a scan found, as Pending changes",
        risk: Some(
            "Can add the Hosts a scan found to your Inventory, unreviewed, as Pending changes you review and Publish.",
        ),
    },
    Words {
        name: "serve:host.check",
        summary: "",
        risk: Some(
            "Can check your Hosts as :check HOST does: roster connects to the Host and signs in once with its Login, then leaves (the Plugin never sees the password). It changes nothing there or in the Inventory, but a failed sign-in counts like any other.",
        ),
    },
];

/// A `serve:` method's summary, `{method}` its name.
pub const SERVE_SUMMARY: &str = "Call roster's {method}";
/// A `serve:` method's flag when it isn't a read, `{method}` its name.
pub const SERVE_RISK: &str = "Can run roster's {method}, which can change things on your Hosts or in the Inventory.";

fn words(p: &Permission) -> Option<&'static Words> {
    let name = p.to_string();
    WORDS.iter().find(|w| w.name == name)
}

impl fmt::Display for Permission {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Permission::InventoryRead => f.write_str("inventory.read"),
            Permission::InventoryWrite => f.write_str("inventory.write"),
            Permission::SessionsOpen => f.write_str("sessions.open"),
            Permission::TerminalRead => f.write_str("terminal.read"),
            Permission::TerminalWrite => f.write_str("terminal.write"),
            Permission::Serve(m) => write!(f, "serve:{m}"),
            Permission::Network(site) => write!(f, "network:{site}"),
        }
    }
}

impl Serialize for Permission {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table the fake Backend reads and is tested on too (app/src/backend/fakePlugins.ts).
    fn table() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/plugin-permissions.json")).unwrap()
    }

    fn list(t: &serde_json::Value, key: &str) -> Vec<String> {
        serde_json::from_value(t[key].clone()).unwrap()
    }

    #[test]
    fn the_tables_are_the_shared_ones() {
        let t = table();
        assert_eq!(list(&t, "serve_methods"), SERVE_METHODS);
        assert_eq!(list(&t, "serve_prefixes"), SERVE_PREFIXES);
        assert_eq!(list(&t, "serve_reads"), READS);
        let names: Vec<String> = [
            Permission::InventoryRead,
            Permission::InventoryWrite,
            Permission::SessionsOpen,
            Permission::TerminalRead,
            Permission::TerminalWrite,
        ]
        .iter()
        .map(Permission::to_string)
        .collect();
        assert_eq!(list(&t, "permissions"), names);
    }

    #[test]
    fn a_serve_method_is_summed_up_and_flagged_as_the_fake_backend_says() {
        let t = table();
        for (p, want) in t["serve"].as_object().unwrap() {
            let parsed = Permission::parse(p).unwrap();
            assert_eq!(parsed.summary(), want["summary"].as_str().unwrap(), "{p}");
            assert_eq!(parsed.risk().as_deref(), want["risk"].as_str(), "{p}");
        }
    }

    #[test]
    fn a_network_site_is_summed_up_and_flagged_as_the_fake_backend_says() {
        let t = table();
        for (p, want) in t["network"].as_object().unwrap() {
            let parsed = Permission::parse(p).unwrap();
            assert_eq!(parsed.summary(), want["summary"].as_str().unwrap(), "{p}");
            assert_eq!(parsed.risk().as_deref(), want["risk"].as_str(), "{p}");
        }
    }

    fn sites(list: &serde_json::Value) -> Vec<Site> {
        let names: Vec<String> = serde_json::from_value(list.clone()).unwrap();
        names
            .iter()
            .map(|p| match Permission::parse(p).unwrap() {
                Permission::Network(site) => site,
                other => panic!("{other} isn't a site"),
            })
            .collect()
    }

    #[test]
    fn sites_together_are_refused_and_granted_as_the_fake_backend_says() {
        let t = table();
        for set in t["refuse_together"].as_array().unwrap() {
            assert!(super::super::network::check_together(&sites(set)).is_err(), "{set}");
        }
        for set in t["grant_together"].as_array().unwrap() {
            assert!(super::super::network::check_together(&sites(set)).is_ok(), "{set}");
        }
    }

    #[test]
    fn agrees_with_the_fake_backend() {
        let t = table();
        for p in list(&t, "grant") {
            let parsed = Permission::parse(&p).unwrap_or_else(|e| panic!("{p:?} should be granted: {e}"));
            assert_eq!(parsed.to_string(), p);
        }
        for p in list(&t, "refuse") {
            assert!(Permission::parse(&p).is_err(), "{p:?} should be refused");
        }
    }
}
