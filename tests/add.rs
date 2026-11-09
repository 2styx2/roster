//! `roster add`: writes one Host into roster.yml, keeping every other byte,
//! then rewrites the Box files as `roster sync` does.
mod common;
use common::Sandbox;

/// Comments, blank lines, odd spacing and a flow-style Host, all kept.
const INVENTORY: &str = "\
# The lab, made up.
box_name: box-a   # this Box
defaults: {user: admin}

groups:
  # Development Hosts
  dev:
    title: Dev
    hosts:
      box-b: 10.0.0.6   # the build Box
      win-01: {ip: 10.0.0.7,
               os: windows}
      # retired: box-z
  prod:
    hosts:
      esx-02: 10.0.0.8

# links come last
links: []
";

fn read(s: &Sandbox, rel: &str) -> String {
    std::fs::read_to_string(s.home.join(rel)).unwrap_or_default()
}

#[test]
fn add_inserts_after_the_groups_last_host_and_keeps_every_other_byte() {
    let s = Sandbox::new("add-insert");
    s.write("roster.yml", INVENTORY);
    let out = s.roster(&[
        "add",
        "box-c",
        "--ip",
        "10.0.0.9",
        "--group",
        "dev",
        "--user",
        "ops",
        "--port",
        "2222",
        "--auth",
        "bw:box-c ssh",
        "--enroll=false",
    ]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let want = INVENTORY.replace(
        "               os: windows}\n",
        "               os: windows}\n      box-c: {ip: \"10.0.0.9\", port: 2222, user: \"ops\", \
         auth: \"bw:box-c ssh\", enroll: false}\n",
    );
    assert_eq!(read(&s, "roster.yml"), want);
    assert!(out.stdout.contains("added box-c to "), "{}", out.stdout);
    // The Box files follow at once.
    let config = read(&s, ".ssh/config.d/roster");
    assert!(
        config.contains("Host box-c\n    HostName 10.0.0.9\n    User ops\n    Port 2222\n"),
        "{config}"
    );
    assert!(read(&s, "ROSTER.md").contains("box-c"));
    for log in ["ssh.log", "ssh-keyscan.log", "bw.log"] {
        assert!(!s.home.join(log).exists(), "add ran {log}");
    }
}
