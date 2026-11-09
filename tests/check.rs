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
fn an_empty_target_is_a_usage_error_that_does_not_name_run() {
    let s = sandbox("check-empty-target", &["box-a: 127.0.0.1".into()]);
    let out = s.roster(&["check", ","]);
    assert_eq!(out.code, 2, "{}", out.stderr);
    assert!(
        out.stderr.contains("needs a TARGET: Hosts or groups"),
        "{}",
        out.stderr
    );
    assert!(!out.stderr.contains("run"), "{}", out.stderr);
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
        serde_json::json!({"host": "box-a", "ok": true, "failed": null, "error": null, "note": null})
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

const PASSWORD: &str = "pw-check-4b7d-made-up";

#[test]
fn a_password_host_checks_its_vault_reference_and_never_shows_it() {
    let (_open, port, _) = ports();
    let mut s = sandbox(
        "check-vault",
        &[
            format!("sw-01: {{ip: 127.0.0.1, port: {port}, enroll: false, auth: env:SW_PASS}}"),
            format!("sw-02: {{ip: 127.0.0.1, port: {port}, enroll: false, auth: env:NOT_SET}}"),
            format!("sw-03: {{ip: 127.0.0.1, port: {port}, enroll: false}}"),
        ],
    );
    s.set_env("SW_PASS", PASSWORD);
    let out = s.roster(&["check"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert_eq!(
        out.stdout,
        "sw-01: ok\n\
         sw-02: vault: auth env:NOT_SET: NOT_SET isn't set\n\
         sw-03: ok (auth prompt: not checked here)\n\
         3 Hosts: 2 ok, 1 failed\n"
    );
    assert!(!s.home.join("ssh.log").exists(), "a Password Host ran ssh");
    let json = s.roster(&["check", "--json", "sw-03"]);
    assert!(!json.stdout.contains(PASSWORD) && !json.stderr.contains(PASSWORD));
    let doc: serde_json::Value = serde_json::from_str(&json.stdout).unwrap();
    assert_eq!(doc["hosts"][0]["note"], "auth prompt: not checked here");
    assert!(!out.stdout.contains(PASSWORD) && !out.stderr.contains(PASSWORD));
}

#[test]
fn a_key_hosts_ssh_never_inherits_a_password_variable() {
    let (_open, port, _) = ports();
    let mut s = sandbox(
        "check-scrub",
        &[
            format!("sw-01: {{ip: 127.0.0.1, port: {port}, enroll: false, auth: env:SW_PASS}}"),
            format!("box-a: {{ip: 127.0.0.1, port: {port}}}"),
        ],
    );
    s.set_env("SW_PASS", PASSWORD);
    s.set_env("FAKE_SSH_ASKPASS", "unused"); // fake ssh saves its environment
    let out = s.roster(&["check"]);
    assert_eq!(out.code, 0, "{}{}", out.stdout, out.stderr);
    let env = std::fs::read_to_string(s.home.join("ssh.env")).unwrap();
    assert!(!env.contains(PASSWORD), "ssh got the password variable");
}
