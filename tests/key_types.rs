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

#[test]
fn a_key_path_naming_another_types_key_is_refused() {
    let s = Sandbox::new("keytypes-clash");
    s.write(
        "roster.yml",
        &format!("key_path: ~/.ssh/roster_ecdsa\n{INVENTORY}"),
    );
    let out = s.roster(&["sync"]);
    assert_eq!(out.code, 3, "{}", out.stderr);
    assert_eq!(
        out.stderr,
        "roster: roster.yml:1: key_path: ~/.ssh/roster_ecdsa is the ecdsa key fips-01 uses; \
         remove key_path or point it at another file\n"
    );
    assert!(!s.home.join(".ssh/config.d/roster").exists());
}

const PASSWORD: &str = "pw-7d02-made-up";

/// A sandbox with INVENTORY, the fake Hosts box-b and fips-01 up and taking
/// PASSWORD, and a short private runtime dir for the askpass socket.
fn with_hosts(name: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    s.write("roster.yml", INVENTORY);
    for (host, ip) in [("box-b", "10.0.0.6"), ("fips-01", "10.0.0.8")] {
        s.write(&format!("hosts/{host}/ip"), ip);
        s.write(&format!("hosts/{host}/password"), PASSWORD);
    }
    let hosts = s.home.join("hosts");
    s.set_env("FAKE_HOSTS", hosts.to_str().unwrap());
    s.set_env("HOST_PW", PASSWORD);
    let run = std::env::temp_dir().join(format!("roster-t-{name}"));
    let _ = std::fs::remove_dir_all(&run);
    std::fs::create_dir_all(&run).unwrap();
    s.set_env("XDG_RUNTIME_DIR", run.to_str().unwrap());
    s
}

#[test]
fn setup_makes_one_key_per_type_and_installs_each_hosts_own() {
    let s = with_hosts("keytypes-setup");
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let ssh = s.home.join(".ssh");
    assert_eq!(
        read(s.home.join("ssh-keygen.log")),
        format!(
            "-q -t ed25519 -N  -C roster-managed:box-a -f {}\n\
             -q -t ecdsa -b 384 -N  -C roster-managed:box-a -f {}\n",
            ssh.join("roster_ed25519").display(),
            ssh.join("roster_ecdsa").display()
        )
    );
    assert_eq!(
        read(s.home.join("hosts/box-b/.ssh/authorized_keys")),
        "ssh-ed25519 AAAAfake roster-managed:box-a\n"
    );
    assert_eq!(
        read(s.home.join("hosts/fips-01/.ssh/authorized_keys")),
        "ecdsa-sha2-nistp384 AAAAfake-ecdsa roster-managed:box-a\n"
    );

    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "", "a rerun changes nothing");
    assert_eq!(read(s.home.join("ssh-keygen.log")).lines().count(), 2);
}

#[test]
fn undo_takes_every_types_line_off_and_keeps_every_key() {
    let s = with_hosts("keytypes-undo");
    assert_eq!(s.roster(&["setup"]).code, 0);
    let fips = s.home.join("hosts/fips-01/.ssh/authorized_keys");
    let hand = "ssh-ed25519 AAAAhand user@laptop\n";
    let old = "ssh-rsa AAAAold roster-managed:box-a\n";
    std::fs::write(&fips, read(&fips) + old + hand).unwrap();
    let out = s.roster(&["setup", "--undo"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(&fips), hand);
    assert_eq!(read(s.home.join("hosts/box-b/.ssh/authorized_keys")), "");
    for key in ["roster_ed25519", "roster_ecdsa"] {
        let key = s.home.join(".ssh").join(key);
        assert!(key.exists(), "{} is kept", key.display());
        let kept = format!("kept the Box key {}; delete it", key.display());
        assert!(out.stdout.contains(&kept), "{}", out.stdout);
    }
}
