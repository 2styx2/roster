//! `roster setup --undo`: everything roster put on the Hosts and the Box goes,
//! and nothing else. Fake ssh plays the Hosts: `$FAKE_HOSTS/NAME` is Host
//! NAME's HOME.
mod common;
use common::Sandbox;
use std::path::{Path, PathBuf};

const BOX_LINE: &str = "ssh-ed25519 AAAAfake roster-managed:box-a\n";
const HAND_LINE: &str = "ssh-ed25519 AAAAhand user@laptop\n";
/// Lines that aren't this Box's: they always survive.
const OTHERS: &str = "\
ssh-ed25519 AAAAzzz roster-managed:box-z
ssh-ed25519 AAAAab roster-managed:box-ab
ssh-ed25519 AAAAmid roster-managed:box-a but not last
from=\"10.0.0.6\",no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAAother roster-mesh:box-b@box-z
";
/// This Box's key line under v0.7.0's legacy tag, from an older key.
const LEGACY: &str = "ssh-rsa AAAAold fleet-managed:box-a\n";

const INVENTORY: &str = r#"
box_name: box-a
defaults: {user: admin, auth: agent}
groups:
  dev:
    mesh: true
    hosts:
      box-b: 10.0.0.6
      box-c: {ip: 10.0.0.7, port: 2222}
  ops:
    hosts:
      ops-01: 10.0.0.30
"#;

fn sandbox(name: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    s.write("roster.yml", INVENTORY);
    let hosts = s.home.join("hosts");
    std::fs::create_dir_all(&hosts).unwrap();
    s.set_env("FAKE_HOSTS", hosts.to_str().unwrap());
    s.write(".ssh/roster_ed25519", "FAKE PRIVATE KEY\n");
    s.write(".ssh/roster_ed25519.pub", BOX_LINE);
    s
}

/// A fake Host that is up, answers at `ip` and takes the Box key.
fn host(s: &Sandbox, name: &str, ip: &str) -> PathBuf {
    let port = if name == "box-c" { 2222 } else { 22 };
    let at = if port == 22 {
        ip.to_string()
    } else {
        format!("[{ip}]:{port}")
    };
    let known = s.home.join(".ssh/roster_known_hosts");
    let line = format!("{at} ssh-ed25519 AAAAhost-{ip}\n");
    s.write(".ssh/roster_known_hosts", &(read(&known) + &line));
    s.write(&format!("hosts/{name}/ip"), ip);
    let keys = s.write(&format!("hosts/{name}/.ssh/authorized_keys"), BOX_LINE);
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(keys, std::fs::Permissions::from_mode(0o600)).unwrap();
    s.home.join("hosts").join(name)
}

fn hosts_up(s: &Sandbox) -> [PathBuf; 3] {
    [
        host(s, "box-b", "10.0.0.6"),
        host(s, "box-c", "10.0.0.7"),
        host(s, "ops-01", "10.0.0.30"),
    ]
}

fn read(path: impl AsRef<Path>) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn add(path: impl AsRef<Path>, text: &str) {
    let path = path.as_ref();
    std::fs::write(path, read(path) + text).unwrap();
}

#[test]
fn undo_removes_only_this_boxs_key_lines_from_each_host() {
    let s = sandbox("undo-key-lines");
    let hosts = hosts_up(&s);
    for h in &hosts {
        add(h.join(".ssh/authorized_keys"), &format!("{HAND_LINE}{OTHERS}{LEGACY}"));
    }
    let out = s.roster(&["setup", "--undo"]);
    assert_eq!(out.code, 0, "{}\n{}", out.stdout, out.stderr);
    for h in &hosts {
        let keys = h.join(".ssh/authorized_keys");
        assert_eq!(read(&keys), format!("{HAND_LINE}{OTHERS}"), "{}", h.display());
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&keys).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert!(
        out.stdout.contains("ops-01: removed the Box key\n"),
        "{}",
        out.stdout
    );
}

fn chmod(path: impl AsRef<Path>, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
fn the_key_line_stays_until_the_mesh_is_gone_and_a_rerun_finishes() {
    let s = sandbox("undo-order");
    let [b, c, _] = hosts_up(&s);
    assert_eq!(s.roster(&["setup"]).code, 0);
    // box-b's Mesh key can't be deleted: its Mesh cleanup fails.
    let mesh = b.join(".ssh/roster-mesh");
    chmod(&mesh, 0o500);
    let out = s.roster(&["setup", "--undo"]);
    chmod(&mesh, 0o700);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert!(out.stderr.contains("roster: box-b: Mesh: failed"), "{}", out.stderr);
    let last = "roster: 1 Host not done; run `roster setup --undo` again to finish\n";
    assert!(out.stderr.ends_with(last), "{}", out.stderr);
    assert!(read(b.join(".ssh/authorized_keys")).contains("roster-managed:box-a"));
    assert!(!read(c.join(".ssh/authorized_keys")).contains("box-a"));

    let out = s.roster(&["setup", "--undo"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(!mesh.exists());
    assert_eq!(read(b.join(".ssh/authorized_keys")), "");
    assert!(
        out.stdout.contains("box-b: removed the Box key\n"),
        "{}",
        out.stdout
    );
    assert!(!out.stdout.contains("box-c:"), "{}", out.stdout);

    // Done: a rerun reaches no Host and changes nothing.
    let out = s.roster(&["setup", "--undo"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(!out.stdout.contains("remove"), "{}", out.stdout);
}

#[test]
fn a_down_host_is_reported_and_a_rerun_finishes_it() {
    let s = sandbox("undo-down");
    let [b, c, ops] = hosts_up(&s);
    s.write("hosts/box-c/down", "");
    let out = s.roster(&["setup", "--undo"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert!(out.stderr.contains("roster: box-c: Mesh: down: "), "{}", out.stderr);
    assert_eq!(read(c.join(".ssh/authorized_keys")), BOX_LINE);
    assert_eq!(read(b.join(".ssh/authorized_keys")), "");
    assert_eq!(read(ops.join(".ssh/authorized_keys")), "");

    std::fs::remove_file(c.join("down")).unwrap();
    let out = s.roster(&["setup", "--undo"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(c.join(".ssh/authorized_keys")), "");
}

const OTHER_KEY: &str = "ssh-rsa AAAAother roster-mesh:box-c@box-z\n";

#[test]
fn undo_removes_this_boxs_mesh_and_leaves_other_boxes_alone() {
    let s = sandbox("undo-mesh");
    let [b, c, ops] = hosts_up(&s);
    std::fs::create_dir_all(b.join(".claude")).unwrap();
    s.write(
        "hosts/box-c/.ssh/config",
        "Host *\n    ServerAliveInterval 5\n",
    );
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(read(c.join(".ssh/authorized_keys")).contains("roster-mesh:box-b@box-a"));
    for h in [&b, &c, &ops] {
        add(h.join(".ssh/authorized_keys"), &format!("{HAND_LINE}{OTHERS}"));
    }
    s.write("hosts/box-c/.ssh/roster-mesh/roster_mesh_rsa.pub", OTHER_KEY);
    s.write("hosts/box-c/.ssh/roster-mesh/roster_mesh_rsa", "THEIR KEY\n");

    let out = s.roster(&["setup", "--undo"]);
    assert_eq!(out.code, 0, "{}\n{}", out.stdout, out.stderr);
    for h in [&b, &c, &ops] {
        assert_eq!(
            read(h.join(".ssh/authorized_keys")),
            format!("{HAND_LINE}{OTHERS}"),
            "{}",
            h.display()
        );
        assert!(!h.join("ROSTER.md").exists(), "{}", h.display());
    }
    assert!(!b.join(".ssh/roster-mesh").exists());
    assert!(
        !b.join(".ssh/config").exists(),
        "only the Mesh's lines were in it"
    );
    assert_eq!(read(b.join(".claude/CLAUDE.md")), "");
    let mut left: Vec<_> = std::fs::read_dir(c.join(".ssh/roster-mesh"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    left.sort();
    assert_eq!(left, ["roster_mesh_rsa", "roster_mesh_rsa.pub"]);
    assert_eq!(
        read(c.join(".ssh/config")),
        "Host *\n    ServerAliveInterval 5\n"
    );
    assert!(
        out.stdout.contains("box-c: removed box-b's key\n"),
        "{}",
        out.stdout
    );
}
