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

/// Load INVENTORY expecting exit 3; the message.
fn refused(name: &str, inventory: &str) -> String {
    let s = Sandbox::new(name);
    s.write("roster.yml", inventory);
    let out = s.roster(&["ls"]);
    assert_eq!(out.code, 3, "{}", out.stderr);
    assert_eq!(out.stdout, "");
    out.stderr
}

const HEAD: &str = "defaults: {user: admin}\ngroups:\n  dev:\n    hosts:\n";

#[test]
fn errors_name_the_file_line_and_field() {
    let cases = [
        (
            "bad-name",
            "      box a: 10.0.0.5\n",
            ":5: groups.dev.hosts.box a:",
        ),
        (
            "ip-space",
            "      box-a: {ip: 10.0.0 .5}\n",
            ":5: groups.dev.hosts.box-a.ip:",
        ),
        (
            "ip-quote",
            "      box-a:\n        title: A\n        ip: '10.0.0.5\"'\n",
            ":7: groups.dev.hosts.box-a.ip:",
        ),
        (
            "ip-pct",
            "      box-a: 10.0.0.5%eth0\n",
            ":5: groups.dev.hosts.box-a.ip:",
        ),
        (
            "user-pct",
            "      box-a: {ip: 10.0.0.5, user: a%b}\n",
            ":5: groups.dev.hosts.box-a.user:",
        ),
        (
            "port",
            "      box-a:\n        ip: 10.0.0.5\n        port: 70000\n",
            ":7: groups.dev.hosts.box-a.port:",
        ),
    ];
    for (name, hosts, want) in cases {
        let err = refused(&format!("inv-err-{name}"), &format!("{HEAD}{hosts}"));
        assert!(err.contains(&format!("roster.yml{want}")), "{name}: {err}");
    }
}

#[test]
fn an_ipv6_zone_is_the_one_percent_allowed() {
    let h = hosts("inv-zone", &format!("{HEAD}      box-a: 'fe80::1%eth0'\n"));
    assert_eq!(h["box-a"]["ip"], "fe80::1%eth0");
}

#[test]
fn a_host_without_a_user_anywhere_is_refused() {
    let err = refused(
        "inv-no-user",
        "groups:\n  dev:\n    hosts:\n      box-a: 10.0.0.5\n",
    );
    assert!(err.contains(":4: groups.dev.hosts.box-a.user:"), "{err}");
}

#[test]
fn a_host_in_two_groups_is_refused() {
    let err = refused(
        "inv-dup",
        &format!("{HEAD}      box-a: 10.0.0.5\n  ops:\n    hosts:\n      box-a: 10.0.0.6\n"),
    );
    assert!(err.contains(":8: groups.ops.hosts.box-a:"), "{err}");
    assert!(err.contains("dev"), "{err}");
}
