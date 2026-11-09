//! `roster` alone: pick Hosts with fzf, open them in tmux or in place.
mod common;
use common::Sandbox;

const INVENTORY: &str = r#"
defaults: {user: admin}
groups:
  dev:
    hosts:
      box-a: {ip: 10.0.0.5, title: Build box, description: Runs the nightly builds}
      box-b: 10.0.0.6
      sw-01: {ip: 10.0.0.9, enroll: false}
"#;

fn read(s: &Sandbox, file: &str) -> String {
    std::fs::read_to_string(s.home.join(file)).unwrap_or_default()
}

fn sandbox(name: &str, pick: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    s.write("roster.yml", INVENTORY);
    s.set_env("FAKE_FZF_PICK", pick);
    s
}

#[test]
fn outside_tmux_the_pick_runs_ssh_in_place() {
    let s = sandbox("pick-outside", "box-b");
    let out = s.roster(&[]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(&s, "ssh.log"), "box-b\n");
    assert_eq!(read(&s, "tmux.log"), "");
}

#[test]
fn without_fzf_roster_says_how_to_install_it() {
    let mut s = sandbox("pick-no-fzf", "box-b");
    let empty = s.home.join("empty-path").display().to_string();
    s.set_env("PATH", &empty);
    let out = s.roster(&[]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert!(out.stderr.contains("install fzf"), "{}", out.stderr);
    assert_eq!(read(&s, "ssh.log"), "");
}

#[test]
fn a_cancelled_pick_runs_nothing() {
    let mut s = sandbox("pick-cancel", "");
    s.set_env("FAKE_FZF_EXIT", "130");
    let out = s.roster(&[]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stderr, "");
    assert_eq!(read(&s, "ssh.log"), "");
}
