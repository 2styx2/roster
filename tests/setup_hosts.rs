//! `roster setup`, the Host side: record host keys, then install the Box key
//! on each Enrolled Host that doesn't accept it yet. Fake ssh plays the
//! Hosts: `$FAKE_HOSTS/NAME` is Host NAME's HOME.
mod common;
use common::Sandbox;
use std::path::PathBuf;

const PASSWORD: &str = "pw-41c9-made-up";
const BOX_LINE: &str = "ssh-ed25519 AAAAfake roster-managed:box-a\n";

const INVENTORY: &str = r#"
box_name: box-a
defaults: {user: admin, auth: "env:HOST_PW"}
groups:
  dev:
    hosts:
      box-b: 10.0.0.6
      box-c: {ip: 10.0.0.7, port: 2222}
  gear:
    hosts:
      new-01: {ip: 10.0.0.20, reviewed: false}
      win-01: {ip: 10.0.0.21, os: windows}
      sw-01: {ip: 10.0.0.22, enroll: false}
"#;

/// A sandbox with INVENTORY, fake Hosts under `hosts/`, the vault password
/// in $HOST_PW and a short private runtime dir for the askpass socket.
fn sandbox(name: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    s.write("roster.yml", INVENTORY);
    let hosts = s.home.join("hosts");
    std::fs::create_dir_all(&hosts).unwrap();
    s.set_env("FAKE_HOSTS", hosts.to_str().unwrap());
    s.set_env("HOST_PW", PASSWORD);
    let run = std::env::temp_dir().join(format!("roster-t-{name}"));
    let _ = std::fs::remove_dir_all(&run);
    std::fs::create_dir_all(&run).unwrap();
    s.set_env("XDG_RUNTIME_DIR", run.to_str().unwrap());
    s
}

/// A fake Host that is up, answers at `ip` and takes PASSWORD.
fn host(s: &Sandbox, name: &str, ip: &str) -> PathBuf {
    s.write(&format!("hosts/{name}/ip"), ip);
    s.write(&format!("hosts/{name}/password"), PASSWORD);
    s.home.join("hosts").join(name)
}

fn read(path: impl AsRef<std::path::Path>) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn mode(path: impl AsRef<std::path::Path>) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn setup_installs_the_box_key_with_the_vault_password_once() {
    let s = sandbox("hosts-install");
    let b = host(&s, "box-b", "10.0.0.6");
    let c = host(&s, "box-c", "10.0.0.7");
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    for (h, name) in [(&b, "box-b"), (&c, "box-c")] {
        assert_eq!(read(h.join(".ssh/authorized_keys")), BOX_LINE, "{name}");
        assert_eq!(mode(h.join(".ssh")), 0o700, "{name}");
        assert_eq!(mode(h.join(".ssh/authorized_keys")), 0o600, "{name}");
        let said = format!("installed the Box key on {name}\n");
        assert!(out.stdout.contains(&said), "{}", out.stdout);
    }
    assert_eq!(
        read(s.home.join(".ssh/roster_known_hosts")),
        "10.0.0.6 ssh-ed25519 AAAAhost-10.0.0.6\n\
         [10.0.0.7]:2222 ssh-ed25519 AAAAhost-10.0.0.7\n"
    );
    assert_eq!(
        read(s.home.join("ssh-keyscan.log")),
        "-T 5 -p 22 10.0.0.6\n-T 5 -p 2222 10.0.0.7\n"
    );

    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "", "a rerun has nothing to do");
    assert_eq!(read(b.join(".ssh/authorized_keys")), BOX_LINE);
    assert_eq!(read(s.home.join("ssh-keyscan.log")).lines().count(), 2);
}
