//! `roster ssh HOST [ARGS...]`: ssh by name, through the config setup wrote.
mod common;
use common::Sandbox;

const INVENTORY: &str = r#"
defaults: {user: admin}
groups:
  dev:
    hosts:
      box-b: 10.0.0.6
      sw-01: {ip: 10.0.0.9, enroll: false}
"#;

fn log(s: &Sandbox) -> String {
    std::fs::read_to_string(s.home.join("ssh.log")).unwrap_or_default()
}

#[test]
fn ssh_execs_ssh_with_the_host_and_args_unchanged() {
    let mut s = Sandbox::new("ssh-exec");
    s.write("roster.yml", INVENTORY);
    s.set_env("FAKE_SSH_EXIT", "5");
    let out = s.roster(&[
        "ssh",
        "box-b",
        "-L",
        "8080:localhost:80",
        "--",
        "uptime",
        "-p",
    ]);
    assert_eq!(out.code, 5, "ssh's exit status is roster's: {}", out.stderr);
    assert_eq!(log(&s), "box-b -L 8080:localhost:80 -- uptime -p\n");
}

#[test]
fn ssh_to_an_unknown_host_exits_1_without_running_ssh() {
    let s = Sandbox::new("ssh-unknown");
    s.write("roster.yml", INVENTORY);
    let out = s.roster(&["ssh", "nope"]);
    assert_eq!(out.code, 1);
    assert_eq!(
        out.stderr,
        "roster: no Host named 'nope' in the Inventory\n  hint: `roster ls` lists the Hosts\n"
    );
    assert_eq!(log(&s), "");
}

#[test]
fn ssh_to_a_key_host_gets_no_other_hosts_secret_variable() {
    const PASSWORD: &str = "pw-5e1a-made-up";
    let mut s = Sandbox::new("ssh-scrub");
    s.write(
        "roster.yml",
        &INVENTORY.replace("enroll: false}", "enroll: false, auth: \"env:PW\"}"),
    );
    s.set_env("PW", PASSWORD);
    s.set_env("FAKE_SSH_ASKPASS", "unused");
    let out = s.roster(&["ssh", "box-b"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let env = std::fs::read_to_string(s.home.join("ssh.env")).unwrap();
    assert!(env.contains("HOME="), "the fake logged its environment");
    assert!(!env.contains(PASSWORD), "{env}");
}

#[test]
fn ssh_without_a_host_is_a_usage_error() {
    let s = Sandbox::new("ssh-no-host");
    s.write("roster.yml", INVENTORY);
    let out = s.roster(&["ssh"]);
    assert_eq!(out.code, 2, "{}", out.stderr);
    assert_eq!(log(&s), "");
}
