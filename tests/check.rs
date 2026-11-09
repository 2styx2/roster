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
fn with_no_argument_or_a_group_every_host_gets_a_line() {
    let (_open, port, closed) = ports();
    let s = sandbox("check-fleet", &[]);
    s.write(
        "roster.yml",
        &format!(
            "defaults: {{user: admin}}\ngroups:\n  dev:\n    hosts:\n      \
             box-a: {{ip: 127.0.0.1, port: {port}}}\n      \
             box-b: {{ip: 127.0.0.1, port: {closed}}}\n  lab:\n    hosts:\n      \
             box-c: {{ip: 127.0.0.1, port: {port}}}\n"
        ),
    );
    let all = s.roster(&["check"]);
    assert_eq!(all.code, 1, "{}", all.stderr);
    let lines: Vec<_> = all.stdout.lines().collect();
    assert_eq!(lines.len(), 4, "{}", all.stdout);
    assert_eq!(lines[0], "box-a: ok");
    assert!(lines[1].starts_with("box-b: port: "), "{}", all.stdout);
    assert_eq!(lines[2], "box-c: ok");
    assert_eq!(lines[3], "3 Hosts: 2 ok, 1 failed");
    let lab = s.roster(&["check", "lab"]);
    assert_eq!(lab.code, 0, "{}", lab.stderr);
    assert_eq!(lab.stdout, "box-c: ok\n1 Host: 1 ok, 0 failed\n");
}

#[test]
fn json_gives_each_host_its_failed_stage_and_error() {
    let (_open, port, closed) = ports();
    let s = sandbox(
        "check-json",
        &[
            format!("box-a: {{ip: 127.0.0.1, port: {port}}}"),
            format!("box-b: {{ip: 127.0.0.1, port: {closed}}}"),
        ],
    );
    let out = s.roster(&["check", "--json"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    let doc: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(doc["v"], 1);
    let a = &doc["hosts"][0];
    assert_eq!(
        *a,
        serde_json::json!({"host": "box-a", "ok": true, "failed": null, "error": null})
    );
    let b = &doc["hosts"][1];
    assert_eq!(
        (&b["host"], &b["ok"], &b["failed"]),
        (&"box-b".into(), &false.into(), &"port".into())
    );
    assert!(
        b["error"].as_str().unwrap().starts_with("127.0.0.1:"),
        "{b}"
    );
}

#[test]
fn a_failed_login_shows_what_ssh_said() {
    let (_open, port, _) = ports();
    let mut s = sandbox(
        "check-login",
        &[format!("box-a: {{ip: 127.0.0.1, port: {port}}}")],
    );
    s.set_env("FAKE_SSH_DOWN", "box-a");
    let out = s.roster(&["check", "box-a"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert_eq!(
        out.stdout.lines().next().unwrap(),
        "box-a: login: ssh: connect to host box-a port 22: Connection timed out"
    );
}
