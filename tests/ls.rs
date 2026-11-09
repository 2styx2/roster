mod common;
use common::Sandbox;

const INVENTORY: &str = r#"
groups:
  dev:
    title: Dev boxes
    hosts:
      box-a:
        ip: 10.0.0.5
        user: admin
        title: Box A
      box-b: {ip: 10.0.0.6, user: ops}
  hypervisors:
    hosts:
      esx-02:
        ip: 198.51.100.12
        user: root
        title: Second hypervisor
"#;

#[test]
fn ls_prints_one_line_per_host() {
    let s = Sandbox::new("ls-lines");
    s.write("roster.yml", INVENTORY);
    let out = s.roster(&["ls"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        out.stdout,
        "\
box-a   dev          10.0.0.5       key  Box A
box-b   dev          10.0.0.6       key
esx-02  hypervisors  198.51.100.12  key  Second hypervisor
"
    );
}

#[test]
fn ls_json_is_one_versioned_document() {
    let s = Sandbox::new("ls-json");
    s.write("roster.yml", INVENTORY);
    let out = s.roster(&["ls", "--json"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let doc: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(doc["v"], 1);
    let hosts = doc["hosts"].as_array().unwrap();
    assert_eq!(hosts.len(), 3);
    assert_eq!(
        hosts[0],
        serde_json::json!({
            "name": "box-a",
            "group": "dev",
            "ip": "10.0.0.5",
            "user": "admin",
            "port": 22,
            "access": "key",
            "title": "Box A",
            "description": "",
            "type": "",
            "product": "",
            "os": "posix",
            "key_type": "ed25519",
            "mesh": null,
            "web": null,
            "services": [],
        })
    );
}

#[test]
fn ls_json_never_contains_a_secret() {
    let s = Sandbox::new("ls-json-secret");
    s.write(
        "roster.yml",
        "groups:\n  dev:\n    hosts:\n      box-a:\n        ip: 10.0.0.5\n        user: admin\n        \
         auth: 'cmd:echo hunter2-not-real'\n        password: hunter2-not-real\n",
    );
    let out = s.roster(&["ls", "--json"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(!out.stdout.contains("hunter2"), "{}", out.stdout);
    assert!(!out.stderr.contains("hunter2"), "{}", out.stderr);
}
