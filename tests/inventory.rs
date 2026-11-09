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

/// Made up, and uses every feature a v0.7.0 roster.yml can.
const FULL: &str = r#"
box_name: lab.box-01
key_path: ~/.ssh/lab_key
key_type: ecdsa
key_max_age: 365d
workers: 8
claude_inline_limit: 40
rate_limited: [10.0.0.0/8]
providers: {bw: {}}
provider_dirs: [providers]
bitwarden: {sync: true}
resources:
  guest-wifi: {type: wifi, ssid: Guest, auth: "bw:guest wifi"}
web_login_names: {portal: basic}
defaults:
  user: admin
  enroll: true
  sudo: {auth: "bw:sudo"}
  shell_hooks: false
  mac: ""
  services:
    node-exporter: 9100
groups:
  hypervisors:
    title: Hypervisors
    description: The VM hosts
    ssh: {user: root, auth: "bw:hv root"}
    os: posix
    mesh: true
    hosts:
      hv-01: 198.51.100.11
      hv-02:
        ip: 198.51.100.12
        key_type: rsa-4096
        type: hypervisor
        product: Hyper 8
        title: Second hypervisor
        notes: old-style description
        web: https://198.51.100.12/ui
        mesh_dir: /opt/roster-mesh
        seen_as: [10.9.0.12]
        services:
          node-exporter: {port: 9200}
          api: {url: "https://198.51.100.12:8443/api", user: api, auth: "bw:api", verify: false, login: bearer}
          admin: 8443
          portal: {port: 9443, login: portal}
  windows:
    os: Windows
    key_type: ecdsa-521
    hosts:
      win-01:
        ip: fe80::1%eth0
        ssh: {port: 2222, user: Administrator}
        enroll: false
        description: A Windows box
  scanned:
    reviewed: false
    mesh: null
    hosts:
      found-01: {ip: 10.0.0.9, mesh: false, type: printer}
links:
  - {from: hypervisors, to: win-01}
  - {from: hv-01, to: found-01, both: true, via: hv-02}
"#;

#[test]
fn a_full_v0_7_0_inventory_loads_and_resolves() {
    let h = hosts("inv-full", FULL);
    assert_eq!(
        h["hv-02"],
        serde_json::json!({
            "name": "hv-02", "group": "hypervisors", "ip": "198.51.100.12",
            "user": "root", "port": 22, "access": "key", "title": "Second hypervisor",
            "description": "old-style description", "type": "hypervisor", "product": "Hyper 8",
            "os": "posix", "key_type": "rsa-4096", "mesh": true,
            "web": "https://198.51.100.12/ui",
            "services": [
                {"name": "web", "port": 443, "scheme": "https", "url": "https://198.51.100.12/ui",
                 "user": "admin", "login": "basic", "verify": true},
                {"name": "node-exporter", "port": 9200, "scheme": null, "url": null,
                 "user": "admin", "login": "basic", "verify": true},
                {"name": "api", "port": 8443, "scheme": "https",
                 "url": "https://198.51.100.12:8443/api", "user": "api", "login": "bearer",
                 "verify": false},
                {"name": "admin", "port": 8443, "scheme": "https",
                 "url": "https://198.51.100.12:8443", "user": "admin", "login": "basic",
                 "verify": true},
            ],
        })
    );
    let win = &h["win-01"];
    assert_eq!(win["ip"], "fe80::1%eth0");
    assert_eq!(
        (&win["user"], &win["port"]),
        (&"Administrator".into(), &2222.into())
    );
    assert_eq!(
        (&win["os"], &win["key_type"]),
        (&"windows".into(), &"ecdsa-521".into())
    );
    assert_eq!(
        (&win["access"], &win["mesh"]),
        (&"password".into(), &Value::Null)
    );
    assert_eq!(win["description"], "A Windows box");
    assert_eq!(h["hv-01"]["key_type"], "ecdsa");
    assert_eq!(h["hv-01"]["title"], "");
    assert_eq!(h["hv-01"]["web"], Value::Null);
    let found = &h["found-01"];
    assert_eq!(
        (&found["access"], &found["mesh"]),
        (&"unreviewed".into(), &false.into())
    );
}

#[test]
fn ls_shows_key_password_and_unreviewed_access() {
    let s = Sandbox::new("inv-access");
    s.write("roster.yml", FULL);
    let out = s.roster(&["ls"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let access: Vec<_> = out
        .stdout
        .lines()
        .map(|l| l.split_whitespace().nth(3).unwrap())
        .collect();
    assert_eq!(access, ["key", "key", "password", "unreviewed"]);
}

#[test]
fn bad_settings_are_refused_naming_the_field() {
    let cases = [
        (
            "key-type",
            "      box-a: {ip: 10.0.0.5, key_type: dsa}\n",
            "box-a.key_type:",
        ),
        (
            "rsa-short",
            "      box-a: {ip: 10.0.0.5, key_type: rsa-1024}\n",
            "box-a.key_type:",
        ),
        (
            "os",
            "      box-a: {ip: 10.0.0.5, os: plan9}\n",
            "box-a.os:",
        ),
        (
            "mesh",
            "      box-a: {ip: 10.0.0.5, mesh: sometimes}\n",
            "box-a.mesh:",
        ),
        (
            "ssh-key",
            "      box-a: {ip: 10.0.0.5, ssh: {host: x}}\n",
            "box-a.ssh:",
        ),
    ];
    for (name, hosts, want) in cases {
        let err = refused(&format!("inv-set-{name}"), &format!("{HEAD}{hosts}"));
        assert!(
            err.contains(&format!(":5: groups.dev.hosts.{want}")),
            "{name}: {err}"
        );
    }
    let err = refused(
        "inv-set-top",
        &format!("key_type: dsa\n{HEAD}      box-a: 10.0.0.5\n"),
    );
    assert!(err.contains("roster.yml:1: key_type:"), "{err}");
}

#[test]
fn bad_links_are_refused_naming_the_entry() {
    let two = format!("{HEAD}      box-a: 10.0.0.5\n      box-b: 10.0.0.6\n");
    let cases = [
        ("unknown-end", "{from: box-a, to: box-z}", "links.2.to:"),
        (
            "via-group",
            "{from: box-a, to: box-b, via: dev}",
            "links.2.via:",
        ),
        (
            "via-missing",
            "{from: box-a, to: box-b, via: box-z}",
            "links.2.via:",
        ),
        (
            "extra-key",
            "{from: box-a, to: box-b, over: box-a}",
            "links.2:",
        ),
        ("no-to", "{from: box-a}", "links.2:"),
        (
            "both",
            "{from: box-a, to: box-b, both: maybe}",
            "links.2.both:",
        ),
    ];
    for (name, entry, want) in cases {
        let inv = format!("{two}links:\n  - {{from: box-a, to: dev}}\n  - {entry}\n");
        let err = refused(&format!("inv-link-{name}"), &inv);
        assert!(
            err.contains(&format!("roster.yml:9: {want}")),
            "{name}: {err}"
        );
    }
    let clash = format!(
        "{two}  box-a:\n    hosts: {{box-c: 10.0.0.7}}\nlinks:\n  - {{from: box-a, to: dev}}\n"
    );
    let err = refused("inv-link-clash", &clash);
    assert!(err.contains("roster.yml:10: links.1.from:"), "{err}");
    assert!(err.contains("both a Host and a group"), "{err}");
}
