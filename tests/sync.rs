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
    // Unquoted, so bash-completion's `ssh <Tab>` follows it to the Hosts.
    assert!(read(&s, ".ssh/config").starts_with("Include ~/.ssh/config.d/roster\n"));
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

#[test]
fn sync_warns_about_hosts_that_are_the_same_login() {
    let s = Sandbox::new("sync-duplicates");
    s.write(
        "roster.yml",
        &INVENTORY.replace(
            "      win-01:",
            "      box-b-old: 10.0.0.6\n      \
             box-b-root: {ip: 10.0.0.6, user: root}\n      win-01:",
        ),
    );
    let out = s.roster(&["sync"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stderr
            .contains("roster: duplicate Hosts: box-b, box-b-old are all 10.0.0.6:22 as admin"),
        "{}",
        out.stderr
    );
    // Another user on the same address is another login: no warning.
    assert!(!out.stderr.contains("box-b-root"), "{}", out.stderr);
}

#[test]
fn sync_lets_claude_ssh_from_the_users_own_settings_and_claude_false_takes_it_out() {
    let mut s = Sandbox::new("sync-claude");
    let yml = s.write("infra/roster.yml", INVENTORY);
    s.set_env("ROSTER_CONFIG", yml.to_str().unwrap());
    // The user's own settings are kept (with keys sorted, as serde_json
    // writes them, so this one comes back byte for byte).
    let own = "{\n  \"autoMode\": {\n    \"allow\": [\n      \"$defaults\",\n      \"Mine\"\n    ]\n  },\n  \"model\": \"x\"\n}\n";
    s.write(".claude/settings.json", own);
    assert_eq!(s.roster(&["sync"]).code, 0);
    let md = format!("@{}/infra/ROSTER.md\n", s.home.display());
    assert_eq!(read(&s, ".claude/CLAUDE.md"), md);
    assert!(read(&s, "infra/ROSTER.md").contains("You have the user's permission"));
    let text = read(&s, ".claude/settings.json");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["autoMode"]["allow"][1], "Mine");
    assert!(
        v["autoMode"]["allow"][2]
            .as_str()
            .unwrap()
            .contains("ROSTER.md")
    );
    assert_eq!(v["permissions"]["allow"][0], "Bash(ssh:*)");
    assert_eq!(v["permissions"]["deny"][0], "Read(~/.ssh/**)");
    // A rerun changes nothing.
    assert_eq!(s.roster(&["sync"]).stdout, "");

    s.write("infra/roster.yml", &format!("claude: false\n{INVENTORY}"));
    assert_eq!(s.roster(&["sync"]).code, 0);
    assert!(!s.home.join(".claude/CLAUDE.md").exists());
    assert_eq!(read(&s, ".claude/settings.json"), own);
    assert!(!read(&s, "infra/ROSTER.md").contains("You have the user's permission"));
    // The deny rules beside roster.yml stay either way.
    assert!(read(&s, "infra/.claude/settings.json").contains("Read(~/.ssh/**)"));
}
