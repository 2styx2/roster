//! `roster sync`: rewrite the Box files from roster.yml, for cron. It never
//! contacts a Host and never makes a key.
mod common;
use common::Sandbox;

const INVENTORY: &str = "\
box_name: box-a
defaults: {user: admin}
groups:
  dev:
    hosts:
      box-b: 10.0.0.6
      win-01: {ip: 10.0.0.7, os: windows}
";

fn read(s: &Sandbox, rel: &str) -> String {
    std::fs::read_to_string(s.home.join(rel)).unwrap_or_default()
}

#[test]
fn sync_writes_the_box_files_and_runs_no_ssh_tool() {
    let s = Sandbox::new("sync-writes");
    s.write("roster.yml", INVENTORY);
    let out = s.roster(&["sync"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let config = read(&s, ".ssh/config.d/roster");
    assert!(
        config.contains("Host box-b\n    HostName 10.0.0.6\n"),
        "{config}"
    );
    // No Box key yet: the config still names where it will be.
    assert!(
        config.contains("    IdentityFile \"~/.ssh/roster_ed25519\"\n"),
        "{config}"
    );
    assert!(!s.home.join(".ssh/roster_ed25519").exists());
    let include = format!(
        "Include \"{}\"\n",
        s.home.join(".ssh/config.d/roster").display()
    );
    assert!(read(&s, ".ssh/config").starts_with(&include));
    assert!(read(&s, "ROSTER.md").contains("box-b"));
    assert!(read(&s, "CLAUDE.md").contains("@ROSTER.md"));
    assert!(read(&s, ".claude/settings.json").contains("Read(~/.ssh/**)"));
    for log in ["ssh.log", "ssh-keygen.log", "ssh-keyscan.log"] {
        assert!(
            !s.home.join(log).exists(),
            "sync ran {log}: {}",
            read(&s, log)
        );
    }
}

#[test]
fn a_second_sync_changes_nothing_and_says_nothing() {
    let s = Sandbox::new("sync-rerun");
    s.write("roster.yml", INVENTORY);
    assert_eq!(s.roster(&["sync"]).code, 0);
    let before = read(&s, ".ssh/config.d/roster") + &read(&s, "ROSTER.md");
    let out = s.roster(&["sync"]);
    assert_eq!((out.code, out.stdout.as_str()), (0, ""), "{}", out.stderr);
    let after = read(&s, ".ssh/config.d/roster") + &read(&s, "ROSTER.md");
    assert_eq!(before, after);
}

#[test]
fn sync_picks_up_a_host_added_to_roster_yml() {
    let s = Sandbox::new("sync-added");
    s.write("roster.yml", INVENTORY);
    assert_eq!(s.roster(&["sync"]).code, 0);
    s.write(
        "roster.yml",
        &format!("{INVENTORY}      esx-02: 10.0.0.8\n"),
    );
    let out = s.roster(&["sync"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(read(&s, ".ssh/config.d/roster").contains("Host esx-02\n"));
    assert!(out.stdout.contains("wrote "), "{}", out.stdout);
}
