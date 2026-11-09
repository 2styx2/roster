//! `roster run TARGET -- CMD`: one command on many Hosts, in parallel.
mod common;
use common::Sandbox;

const INVENTORY: &str = r#"
defaults: {user: admin}
groups:
  dev:
    hosts:
      box-a: 10.0.0.5
      box-b: 10.0.0.6
  lab:
    hosts:
      esx-02: 10.0.0.7
      box-c: {ip: 10.0.0.8, reviewed: false}
"#;

fn sandbox(name: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    s.write("roster.yml", INVENTORY);
    s.set_env("FAKE_SSH_RUN", "1");
    s
}

fn sorted(text: &str) -> Vec<&str> {
    let mut lines: Vec<_> = text.lines().collect();
    lines.sort();
    lines
}

#[test]
fn run_on_a_group_prefixes_each_line_with_its_host() {
    let s = sandbox("run-group");
    let out = s.roster(&["run", "dev", "--", "echo", "up;", "echo", "$FAKE_SSH_HOST"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        sorted(&out.stdout),
        ["box-a: box-a", "box-a: up", "box-b: box-b", "box-b: up"]
    );
    let log = std::fs::read_to_string(s.home.join("ssh.log")).unwrap();
    assert!(
        log.contains("-o BatchMode=yes -o ConnectTimeout=10 box-a -- echo up; echo $FAKE_SSH_HOST\n"),
        "{log}"
    );
}
