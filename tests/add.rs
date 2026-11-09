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
         auth: \"bw:box-c ssh\", enroll: false, reviewed: true}\n",
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

#[test]
fn a_missing_group_is_made_at_the_end_of_groups() {
    let s = Sandbox::new("add-new-group");
    s.write("roster.yml", INVENTORY);
    let out = s.roster(&["add", "box-d", "--ip", "fe80::1%eth0"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let want = INVENTORY.replace(
        "      esx-02: 10.0.0.8\n",
        "      esx-02: 10.0.0.8\n  vault:\n    hosts:\n      box-d: {ip: \"fe80::1%eth0\", reviewed: true}\n",
    );
    assert_eq!(read(&s, "roster.yml"), want);
}

#[test]
fn a_group_without_hosts_gets_a_hosts_block() {
    let s = Sandbox::new("add-no-hosts");
    s.write(
        "roster.yml",
        "groups:\n    lab:\n        user: root\n# end\n",
    );
    let out = s.roster(&["add", "box-e", "--ip", "10.0.0.5", "--group", "lab"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        read(&s, "roster.yml"),
        "groups:\n    lab:\n        user: root\n        hosts:\n            \
         box-e: {ip: \"10.0.0.5\", reviewed: true}\n# end\n"
    );
}

/// `roster ARGS` fails with exit 1 naming `why`, and leaves roster.yml as it was.
fn refused(name: &str, inventory: &str, args: &[&str], why: &str) {
    let s = Sandbox::new(name);
    s.write("roster.yml", inventory);
    let out = s.roster(args);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert!(out.stderr.contains(why), "{}", out.stderr);
    assert_eq!(read(&s, "roster.yml"), inventory);
    assert!(!s.home.join(".ssh/config.d/roster").exists());
}

#[test]
fn a_taken_name_a_flow_style_group_or_a_bad_result_writes_nothing() {
    let add = |name, ip| ["add", name, "--ip", ip, "--group", "dev"];
    refused(
        "add-dup",
        INVENTORY,
        &add("esx-02", "10.0.0.9"),
        "in group prod",
    );
    let flow = "defaults: {user: admin}\ngroups:\n  dev: {hosts: {box-b: 10.0.0.6}}\n";
    refused("add-flow", flow, &add("box-c", "10.0.0.9"), "flow style");
    let flow = "defaults: {user: admin}\ngroups:\n  dev:\n    hosts: {box-b: 10.0.0.6}\n";
    refused(
        "add-flow-hosts",
        flow,
        &add("box-c", "10.0.0.9"),
        "flow style",
    );
    // An address with a space won't load, so nothing is written.
    refused(
        "add-bad",
        INVENTORY,
        &add("box-c", "10.0.0.9 x"),
        "won't load",
    );
}

#[test]
fn a_symlinked_roster_yml_is_written_through_to_its_target() {
    let s = Sandbox::new("add-symlink");
    let target = s.write("repo/roster.yml", INVENTORY);
    std::os::unix::fs::symlink(&target, s.home.join("roster.yml")).unwrap();
    let out = s.roster(&["add", "box-c", "--ip", "10.0.0.9"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(s.home.join("roster.yml").is_symlink());
    assert!(read(&s, "repo/roster.yml").contains("box-c: {ip: \"10.0.0.9\", reviewed: true}"));
}
