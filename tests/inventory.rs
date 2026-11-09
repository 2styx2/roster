//! The full Inventory: the settings cascade, the `ssh:` block, validation.
mod common;
use common::Sandbox;
use serde_json::Value;

/// `roster ls --json` on INVENTORY, as Hosts by name.
fn hosts(name: &str, inventory: &str) -> std::collections::BTreeMap<String, Value> {
    let s = Sandbox::new(name);
    s.write("roster.yml", inventory);
    let out = s.roster(&["ls", "--json"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let doc: Value = serde_json::from_str(&out.stdout).unwrap();
    let list = doc["hosts"].as_array().unwrap();
    list.iter()
        .map(|h| (h["name"].as_str().unwrap().to_string(), h.clone()))
        .collect()
}

#[test]
fn host_beats_group_beats_defaults_and_ssh_beats_plain_at_each_layer() {
    let h = hosts(
        "inv-cascade",
        "
defaults: {user: d-user, port: 2200}
groups:
  dev:
    user: g-user
    ssh: {port: 2201}
    hosts:
      plain: 10.0.0.1
      own: {ip: 10.0.0.2, user: h-user, port: 2202}
      blocked: {ip: 10.0.0.3, user: h-user, ssh: {user: s-user}}
  ops:
    ssh: {user: gs-user}
    hosts:
      d: {ip: 10.0.0.4, port: 23}
",
    );
    let login = |n: &str| (h[n]["user"].clone(), h[n]["port"].clone());
    assert_eq!(login("plain"), ("g-user".into(), 2201.into()));
    assert_eq!(login("own"), ("h-user".into(), 2202.into()));
    assert_eq!(login("blocked"), ("s-user".into(), 2201.into()));
    assert_eq!(login("d"), ("gs-user".into(), 23.into()));
}
