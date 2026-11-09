//! `roster check [TARGET]`: why a Host can't be reached, or the fleet's health.
mod common;
use common::Sandbox;
use std::net::TcpListener;

/// A port that answers (while the listener lives) and one that doesn't.
fn ports() -> (TcpListener, u16, u16) {
    let open = TcpListener::bind("127.0.0.1:0").unwrap();
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_port = closed.local_addr().unwrap().port();
    drop(closed);
    let open_port = open.local_addr().unwrap().port();
    (open, open_port, closed_port)
}

/// A sandbox whose Hosts are `name: {ip, port}` lines in group `dev`,
/// with fake ssh running `true` for real.
fn sandbox(name: &str, hosts: &[String]) -> Sandbox {
    let mut s = Sandbox::new(name);
    let hosts: String = hosts.iter().map(|h| format!("      {h}\n")).collect();
    s.write(
        "roster.yml",
        &format!("defaults: {{user: admin}}\ngroups:\n  dev:\n    hosts:\n{hosts}"),
    );
    s.set_env("FAKE_SSH_RUN", "1");
    s
}

#[test]
fn a_reachable_host_checks_ok() {
    let (_open, port, _) = ports();
    let s = sandbox(
        "check-ok",
        &[format!("box-a: {{ip: 127.0.0.1, port: {port}}}")],
    );
    let out = s.roster(&["check", "box-a"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "box-a: ok\n1 Host: 1 ok, 0 failed\n");
    let log = std::fs::read_to_string(s.home.join("ssh.log")).unwrap();
    assert_eq!(log, "-o BatchMode=yes -o ConnectTimeout=10 box-a true\n");
}

#[test]
fn a_closed_port_fails_and_ssh_is_not_tried() {
    let (_open, _, closed) = ports();
    let s = sandbox(
        "check-closed",
        &[format!("box-b: {{ip: 127.0.0.1, port: {closed}}}")],
    );
    let out = s.roster(&["check", "box-b"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    let first = out.stdout.lines().next().unwrap();
    let want = format!("box-b: port: 127.0.0.1:{closed}: ");
    assert!(first.starts_with(&want), "{}", out.stdout);
    assert!(first.to_lowercase().contains("refused"), "{first}");
    assert!(
        out.stdout.ends_with("1 Host: 0 ok, 1 failed\n"),
        "{}",
        out.stdout
    );
    assert!(!s.home.join("ssh.log").exists());
}

#[test]
fn a_name_that_does_not_resolve_fails_at_dns() {
    let s = sandbox("check-dns", &["box-z: {ip: box-z.invalid}".into()]);
    let out = s.roster(&["check", "box-z"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    let want = "box-z: dns: box-z.invalid: ";
    assert!(out.stdout.starts_with(want), "{}", out.stdout);
    assert!(!s.home.join("ssh.log").exists());
}

#[test]
fn a_failed_login_shows_what_ssh_said() {
    let (_open, port, _) = ports();
    let mut s = sandbox("check-login", &[format!("box-a: {{ip: 127.0.0.1, port: {port}}}")]);
    s.set_env("FAKE_SSH_DOWN", "box-a");
    let out = s.roster(&["check", "box-a"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert_eq!(
        out.stdout.lines().next().unwrap(),
        "box-a: login: ssh: connect to host box-a port 22: Connection timed out"
    );
}
