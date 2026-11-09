//! Each Host logs in with the Box key of its own `key_type`: a FIPS-mode Host
//! with `key_type: ecdsa` gets `~/.ssh/roster_ecdsa`, not the ed25519 key.
mod common;
use common::Sandbox;

const INVENTORY: &str = r#"
box_name: box-a
defaults: {user: admin, auth: "env:HOST_PW"}
groups:
  dev:
    hosts:
      box-b: 10.0.0.6
      fips-01: {ip: 10.0.0.8, key_type: ecdsa}
"#;

fn read(path: impl AsRef<std::path::Path>) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// The IdentityFile line of `host`'s block in the ssh config.
fn identity(s: &Sandbox, host: &str) -> String {
    let config = read(s.home.join(".ssh/config.d/roster"));
    let block = config
        .split("\nHost ")
        .find(|b| b.starts_with(&format!("{host}\n")))
        .unwrap_or_else(|| panic!("no block for {host}:\n{config}"));
    let line = block.lines().find(|l| l.contains("IdentityFile"));
    line.unwrap_or_default().trim().to_string()
}

#[test]
fn sync_names_each_hosts_own_key_and_makes_none() {
    let s = Sandbox::new("keytypes-sync");
    s.write("roster.yml", INVENTORY);
    let out = s.roster(&["sync"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        identity(&s, "box-b"),
        r#"IdentityFile "~/.ssh/roster_ed25519""#
    );
    assert_eq!(
        identity(&s, "fips-01"),
        r#"IdentityFile "~/.ssh/roster_ecdsa""#
    );
    assert_eq!(read(s.home.join("ssh-keygen.log")), "");
}

#[test]
fn key_path_names_the_default_types_key_and_the_others_sit_beside_it() {
    let s = Sandbox::new("keytypes-key-path");
    s.write("roster.yml", &format!("key_path: ~/keys/mine\n{INVENTORY}"));
    let out = s.roster(&["sync"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(identity(&s, "box-b"), r#"IdentityFile "~/keys/mine""#);
    assert_eq!(
        identity(&s, "fips-01"),
        r#"IdentityFile "~/keys/roster_ecdsa""#
    );
}
