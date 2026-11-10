//! The Mesh: `mesh: true` groups form the web. `roster setup --dry-run`
//! prints the plan; `roster setup` applies it on fake Hosts
//! (`$FAKE_HOSTS/NAME` is Host NAME's HOME).
mod common;
use common::Sandbox;
use std::path::PathBuf;

const BOX_LINE: &str = "ssh-ed25519 AAAAfake roster-managed:box-a\n";

const INVENTORY: &str = r#"
box_name: box-a
defaults: {user: admin, auth: agent}
groups:
  dev:
    mesh: true
    hosts:
      box-b: 10.0.0.6
      box-c: {ip: 10.0.0.7, port: 2222}
      box-d: {ip: 10.0.0.8, mesh: false}
  ops:
    hosts:
      ops-01: 10.0.0.30
"#;

fn sandbox(name: &str, inventory: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    s.write("roster.yml", inventory);
    let hosts = s.home.join("hosts");
    std::fs::create_dir_all(&hosts).unwrap();
    s.set_env("FAKE_HOSTS", hosts.to_str().unwrap());
    s.write(".ssh/roster_ed25519", "FAKE PRIVATE KEY\n");
    s.write(".ssh/roster_ed25519.pub", BOX_LINE);
    s
}

/// A fake Host that is up, answers at `ip` and already takes the Box key.
fn host(s: &Sandbox, name: &str, ip: &str) -> PathBuf {
    let port = if name == "box-c" { 2222 } else { 22 };
    let at = if port == 22 {
        ip.to_string()
    } else {
        format!("[{ip}]:{port}")
    };
    let known = s.home.join(".ssh/roster_known_hosts");
    let line = format!("{at} ssh-ed25519 AAAAhost-{ip}\n");
    s.write(".ssh/roster_known_hosts", &(read(&known) + &line));
    s.write(&format!("hosts/{name}/ip"), ip);
    let keys = s.write(&format!("hosts/{name}/.ssh/authorized_keys"), BOX_LINE);
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(keys, std::fs::Permissions::from_mode(0o600)).unwrap();
    s.home.join("hosts").join(name)
}

fn read(path: impl AsRef<std::path::Path>) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn hosts_up(s: &Sandbox) -> [PathBuf; 4] {
    [
        host(s, "box-b", "10.0.0.6"),
        host(s, "box-c", "10.0.0.7"),
        host(s, "box-d", "10.0.0.8"),
        host(s, "ops-01", "10.0.0.30"),
    ]
}

#[test]
fn dry_run_shows_who_reaches_whom_and_changes_nothing_on_hosts() {
    let s = sandbox("mesh-dry", INVENTORY);
    let [b, ..] = hosts_up(&s);
    let out = s.roster(&["setup", "--dry-run"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stdout.contains("box-b -> box-c\nbox-c -> box-b\n"),
        "{}",
        out.stdout
    );
    assert!(!out.stdout.contains("box-d ->"), "{}", out.stdout);
    assert!(!out.stdout.contains("-> box-d"), "{}", out.stdout);
    assert!(!b.join(".ssh/roster-mesh").exists());
}

const MARK: &str =
    "# roster-mesh: the Mesh's ssh config (roster mesh adds and removes these two lines)";

fn mode(path: impl AsRef<std::path::Path>) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

/// Every file under `dir`, with its contents, for "nothing changed" checks.
fn snapshot(dir: &std::path::Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            out.extend(snapshot(&p));
        } else {
            out.push((p.clone(), read(&p)));
        }
    }
    out.sort();
    out
}

fn peer_line(src: &str, ip: &str) -> String {
    format!(
        "from=\"{ip}\",no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAAmesh-{src} roster-mesh:{src}@box-a\n"
    )
}

#[test]
fn a_read_only_claude_dir_skips_the_import_and_the_mesh_still_forms() {
    // Seen on a real Host: ~/.claude owned by root (from `sudo claude`), so
    // the login user can't write CLAUDE.md there. The import is a nicety;
    // the Mesh must not fail over it.
    use std::os::unix::fs::PermissionsExt;
    let s = sandbox("mesh-claude-ro", INVENTORY);
    let [b, c, _, _] = hosts_up(&s);
    std::fs::create_dir_all(b.join(".claude")).unwrap();
    std::fs::set_permissions(b.join(".claude"), std::fs::Permissions::from_mode(0o555)).unwrap();
    let out = s.roster(&["setup"]);
    std::fs::set_permissions(b.join(".claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(out.code, 0, "{}\n{}", out.stdout, out.stderr);
    assert!(!out.stderr.contains("Mesh: failed"), "{}", out.stderr);
    assert!(!b.join(".claude/CLAUDE.md").exists(), "no import written");
    // box-b is a full member: its key is on its peers, and theirs on it.
    assert!(read(c.join(".ssh/authorized_keys")).contains("roster-mesh:box-b@box-a"));
    assert!(read(b.join(".ssh/authorized_keys")).contains("roster-mesh:box-c@box-a"));
    assert!(read(b.join("ROSTER.md")).contains("box-c"));
}

/// Two Boxes share one Inventory: the Mesh on a Host is the first Box's.
/// The second Box leaves it alone, says so in one line, and isn't failing.
#[test]
fn a_mesh_another_box_made_is_left_alone_and_not_a_failure() {
    let s = sandbox("mesh-foreign", INVENTORY);
    let [b, _, _, _] = hosts_up(&s);
    let theirs = "# Written by roster mesh for box-b (owner box-z) - don't edit\n";
    s.write("hosts/box-b/.ssh/roster-mesh/config", theirs);
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}\n{}", out.stdout, out.stderr);
    assert!(
        out.stderr
            .contains("roster: the Mesh on box-b is another Box's; left alone"),
        "{}",
        out.stderr
    );
    assert!(!out.stderr.contains("not done"), "{}", out.stderr);
    assert_eq!(read(b.join(".ssh/roster-mesh/config")), theirs);
}

#[test]
fn setup_forms_the_web_with_v070_files_and_a_rerun_changes_nothing() {
    let s = sandbox("mesh-apply", INVENTORY);
    let [b, c, d, ops] = hosts_up(&s);
    std::fs::create_dir_all(b.join(".claude")).unwrap();
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}\n{}", out.stdout, out.stderr);

    // Each source made its own key, on the Host, tagged with this Box.
    assert_eq!(
        read(b.join(".ssh/roster-mesh/id_ed25519.pub")),
        "ssh-ed25519 AAAAmesh-box-b roster-mesh:box-b@box-a\n"
    );
    assert!(read(b.join("ssh-keygen.log")).contains("-C roster-mesh:box-b@box-a"));
    assert_eq!(mode(b.join(".ssh/roster-mesh")), 0o700);
    // Each peer takes the other's key, from its address only.
    assert_eq!(
        read(c.join(".ssh/authorized_keys")),
        BOX_LINE.to_string() + &peer_line("box-b", "10.0.0.6")
    );
    assert_eq!(
        read(b.join(".ssh/authorized_keys")),
        BOX_LINE.to_string() + &peer_line("box-c", "10.0.0.7")
    );
    assert_eq!(mode(c.join(".ssh/authorized_keys")), 0o600);
    // The source's ssh config, known_hosts and the Include, as v0.7.0's.
    let dir = format!("{}/.ssh/roster-mesh", b.display());
    assert_eq!(
        read(b.join(".ssh/roster-mesh/config")),
        format!(
            "# Written by roster mesh for box-b (owner box-a) from roster.yml: the Hosts box-b reaches. Don't edit by hand.\n\
             \n\
             Host box-c\n    HostName 10.0.0.7\n    User admin\n    Port 2222\n    \
             UserKnownHostsFile {dir}/known_hosts\n    StrictHostKeyChecking yes\n    \
             ConnectTimeout 10\n    IdentityFile {dir}/id_ed25519\n    IdentitiesOnly yes\n"
        )
    );
    assert_eq!(mode(b.join(".ssh/roster-mesh/config")), 0o600);
    assert_eq!(
        read(b.join(".ssh/roster-mesh/known_hosts")),
        "[10.0.0.7]:2222 ssh-ed25519 AAAAhost-10.0.0.7\n"
    );
    assert_eq!(
        read(b.join(".ssh/config")),
        format!("{MARK}\nInclude {dir}/config\n")
    );
    let md = read(b.join("ROSTER.md"));
    assert!(
        md.starts_with("<!-- roster-mesh: written by roster for box-b (owner box-a); "),
        "{md}"
    );
    assert!(
        md.contains("| box-c | admin@10.0.0.7:2222 | key |\n"),
        "{md}"
    );
    assert_eq!(read(b.join(".claude/CLAUDE.md")), "@~/ROSTER.md\n");
    assert!(!c.join(".claude").exists(), "no ~/.claude, no import");
    // Hosts outside the web are left as they were.
    for h in [&d, &ops] {
        assert_eq!(read(h.join(".ssh/authorized_keys")), BOX_LINE);
        assert!(!h.join(".ssh/roster-mesh").exists());
        assert!(!h.join("ROSTER.md").exists());
    }
    let said = |line: &str| assert!(out.stdout.contains(line), "{line}: {}", out.stdout);
    said("box-b: made the Mesh key ~/.ssh/roster-mesh/id_ed25519\n");
    said("box-b: wrote ~/.ssh/roster-mesh/config\n");
    said("box-c: added box-b's key\n");
    said("box-b: added box-c's key\n");

    let before = snapshot(&s.home.join("hosts"));
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "", "a rerun has nothing to do");
    assert_eq!(snapshot(&s.home.join("hosts")), before);
    let out = s.roster(&["setup", "--dry-run"]);
    assert_eq!(out.stdout, "box-b -> box-c\nbox-c -> box-b\n");
}

/// Lines and files that aren't this Box's Mesh: they must survive anything.
const HAND_LINE: &str = "ssh-ed25519 AAAAhand user@laptop\n";
const OTHER_BOX: &str = "from=\"10.0.0.6\",no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAAother roster-mesh:box-b@box-z\n";
const OTHER_KEY: &str = "ssh-rsa AAAAother roster-mesh:box-c@box-z\n";

#[test]
fn leaving_the_web_removes_only_this_boxs_lines_and_files() {
    let s = sandbox("mesh-remove", INVENTORY);
    let [b, c, ..] = hosts_up(&s);
    s.write(
        "hosts/box-c/.ssh/config",
        "Host *\n    ServerAliveInterval 5\n",
    );
    assert_eq!(s.roster(&["setup"]).code, 0);
    let keys = c.join(".ssh/authorized_keys");
    std::fs::write(&keys, read(&keys) + HAND_LINE + OTHER_BOX).unwrap();
    s.write(
        "hosts/box-c/.ssh/roster-mesh/roster_mesh_rsa.pub",
        OTHER_KEY,
    );
    s.write(
        "hosts/box-c/.ssh/roster-mesh/roster_mesh_rsa",
        "THEIR KEY\n",
    );

    // box-c opts out: the group's web is box-b alone, so both leave it.
    s.write(
        "roster.yml",
        &INVENTORY.replace(
            "{ip: 10.0.0.7, port: 2222}",
            "{ip: 10.0.0.7, port: 2222, mesh: false}",
        ),
    );
    let out = s.roster(&["setup", "--dry-run"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(!out.stdout.contains("->"), "{}", out.stdout);
    assert!(
        out.stdout.contains("box-c: would remove box-b's key\n"),
        "{}",
        out.stdout
    );
    assert!(
        out.stdout
            .contains("box-b: would remove the Mesh key ~/.ssh/roster-mesh/id_ed25519\n"),
        "{}",
        out.stdout
    );
    assert!(
        b.join(".ssh/roster-mesh/id_ed25519").exists(),
        "a dry run changes nothing"
    );

    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(&keys), BOX_LINE.to_string() + HAND_LINE + OTHER_BOX);
    assert_eq!(read(b.join(".ssh/authorized_keys")), BOX_LINE);
    assert!(!b.join(".ssh/roster-mesh").exists());
    assert!(!b.join("ROSTER.md").exists());
    assert!(
        !b.join(".ssh/config").exists(),
        "only the Mesh's lines were in it"
    );
    assert_eq!(read(b.join(".claude/CLAUDE.md")), "");
    // Another Box's key on box-c stays, and so does the folder holding it.
    let mesh = c.join(".ssh/roster-mesh");
    let mut left: Vec<_> = std::fs::read_dir(&mesh)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    left.sort();
    assert_eq!(left, ["roster_mesh_rsa", "roster_mesh_rsa.pub"]);
    assert_eq!(read(mesh.join("roster_mesh_rsa.pub")), OTHER_KEY);
    assert_eq!(
        read(c.join(".ssh/config")),
        "Host *\n    ServerAliveInterval 5\n"
    );
    assert!(!c.join("ROSTER.md").exists());

    let out = s.roster(&["setup"]);
    assert_eq!((out.code, out.stdout.as_str()), (0, ""), "{}", out.stderr);
}

#[test]
fn a_host_gone_from_the_inventory_loses_its_lines_on_the_next_run() {
    let s = sandbox("mesh-gone", INVENTORY);
    let [b, c, ..] = hosts_up(&s);
    host(&s, "box-e", "10.0.0.9");
    let three = INVENTORY.replace("      box-d:", "      box-e: 10.0.0.9\n      box-d:");
    s.write("roster.yml", &three);
    assert_eq!(s.roster(&["setup"]).code, 0);
    assert!(read(b.join(".ssh/authorized_keys")).contains("roster-mesh:box-e@box-a"));

    s.write("roster.yml", INVENTORY);
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    for h in [&b, &c] {
        assert!(
            !read(h.join(".ssh/authorized_keys")).contains("box-e"),
            "{}",
            h.display()
        );
        assert!(!read(h.join(".ssh/roster-mesh/config")).contains("box-e"));
        assert!(!read(h.join("ROSTER.md")).contains("box-e"));
    }
    assert!(
        out.stdout.contains("box-b: removed box-e's key\n"),
        "{}",
        out.stdout
    );
}

#[test]
fn a_down_host_is_pending_and_the_next_run_finishes_it() {
    let s = sandbox("mesh-down", INVENTORY);
    let [b, c, ..] = hosts_up(&s);
    s.write("hosts/box-c/down", "");
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    let last = "roster: 1 Host not done; run `roster setup` again to finish\n";
    assert!(out.stderr.ends_with(last), "{}", out.stderr);
    assert!(b.join(".ssh/roster-mesh/id_ed25519").exists());
    assert_eq!(read(b.join(".ssh/authorized_keys")), BOX_LINE);

    std::fs::remove_file(c.join("down")).unwrap();
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        read(b.join(".ssh/authorized_keys")),
        BOX_LINE.to_string() + &peer_line("box-c", "10.0.0.7")
    );
    assert_eq!(
        read(c.join(".ssh/authorized_keys")),
        BOX_LINE.to_string() + &peer_line("box-b", "10.0.0.6")
    );
    let out = s.roster(&["setup"]);
    assert_eq!((out.code, out.stdout.as_str()), (0, ""), "{}", out.stderr);
}

#[test]
fn a_down_source_keeps_its_lines_on_its_peers() {
    let s = sandbox("mesh-down-source", INVENTORY);
    let [b, c, ..] = hosts_up(&s);
    assert_eq!(s.roster(&["setup"]).code, 0);
    s.write("hosts/box-b/down", "");
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert_eq!(
        read(c.join(".ssh/authorized_keys")),
        BOX_LINE.to_string() + &peer_line("box-b", "10.0.0.6")
    );
    assert!(read(b.join(".ssh/authorized_keys")).contains("roster-mesh:box-c@box-a"));
}

/// Hosts for the table: two groups, each with Hosts that can't take part.
fn table_inventory(defaults: &str, dev: &str, box_c: &str) -> String {
    format!(
        r#"
box_name: box-a
defaults: {{user: admin, auth: agent{defaults}}}
groups:
  dev:{dev}
    hosts:
      box-b: 10.0.0.6
      box-c: {{ip: 10.0.0.7, port: 2222{box_c}}}
      sw-01: {{ip: 10.0.0.22, enroll: false}}
      new-01: {{ip: 10.0.0.20, reviewed: false}}
      win-01: {{ip: 10.0.0.21, os: windows}}
  ops:
    hosts:
      ops-01: 10.0.0.30
      ops-02: 10.0.0.31
"#
    )
}

#[test]
fn dry_run_plans_follow_the_inventory() {
    let left_out = "roster: sw-01: left out of the Mesh: a Password Host (enroll: false)\n\
                    roster: new-01: left out of the Mesh: unreviewed\n\
                    roster: win-01: left out of the Mesh: os: windows\n";
    let cases = [
        // `mesh: true` in defaults: each group is its own web.
        (
            table_inventory(", mesh: true", "", ""),
            "box-b -> box-c\nbox-c -> box-b\nops-01 -> ops-02\nops-02 -> ops-01\n",
            left_out,
        ),
        // On a group: only its Hosts.
        (
            table_inventory("", "\n    mesh: true", ""),
            "box-b -> box-c\nbox-c -> box-b\n",
            left_out,
        ),
        // `mesh: false` on a Host opts out, leaving box-b alone: no web.
        (
            table_inventory("", "\n    mesh: true", ", mesh: false"),
            "",
            left_out,
        ),
        // One Host with `mesh: true` has nobody to reach.
        (table_inventory("", "", ", mesh: true"), "", ""),
        // No `mesh:` anywhere: no web, nothing said.
        (table_inventory("", "", ""), "", ""),
    ];
    for (n, (inventory, arrows, stderr)) in cases.iter().enumerate() {
        let s = sandbox(&format!("mesh-table-{n}"), inventory);
        hosts_up(&s);
        host(&s, "ops-02", "10.0.0.31");
        let out = s.roster(&["setup", "--dry-run", "-v"]);
        assert_eq!(out.code, 0, "case {n}: {}", out.stderr);
        let plan: String = out
            .stdout
            .lines()
            .filter(|l| l.contains(" -> "))
            .map(|l| format!("{l}\n"))
            .collect();
        assert_eq!(&plan, arrows, "case {n}");
        assert!(out.stderr.ends_with(stderr), "case {n}: {}", out.stderr);
        if arrows.is_empty() {
            assert!(!out.stdout.contains(": would "), "case {n}: {}", out.stdout);
        }
    }
}

#[test]
fn dry_run_lists_each_hosts_changes() {
    let s = sandbox("mesh-dry-files", INVENTORY);
    hosts_up(&s);
    let out = s.roster(&["setup", "--dry-run"]);
    let mesh: Vec<&str> = out
        .stdout
        .lines()
        .filter(|l| l.starts_with("box-"))
        .collect();
    assert_eq!(
        mesh,
        [
            "box-b -> box-c",
            "box-c -> box-b",
            "box-b: would make the Mesh key ~/.ssh/roster-mesh/id_ed25519",
            "box-b: would write ~/.ssh/roster-mesh/config",
            "box-b: would write ~/.ssh/roster-mesh/known_hosts",
            "box-b: would write ~/ROSTER.md",
            "box-b: would add the Include to ~/.ssh/config",
            "box-b: would add box-c's key once it's made",
            "box-c: would make the Mesh key ~/.ssh/roster-mesh/id_ed25519",
            "box-c: would write ~/.ssh/roster-mesh/config",
            "box-c: would write ~/.ssh/roster-mesh/known_hosts",
            "box-c: would write ~/ROSTER.md",
            "box-c: would add the Include to ~/.ssh/config",
            "box-c: would add box-b's key once it's made",
        ]
    );
}

#[test]
fn a_key_roster_did_not_make_is_never_used_or_replaced() {
    let s = sandbox("mesh-foreign-key", INVENTORY);
    let [b, c, ..] = hosts_up(&s);
    let own = "ssh-ed25519 AAAAown user@laptop\n";
    s.write(
        "hosts/box-b/.ssh/roster-mesh/id_ed25519",
        "THEIR PRIVATE KEY\n",
    );
    s.write("hosts/box-b/.ssh/roster-mesh/id_ed25519.pub", own);
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    let why = "roster: box-b: Mesh: ~/.ssh/roster-mesh/id_ed25519 isn't a Mesh key this Box made; left alone\n";
    assert!(out.stderr.contains(why), "{}", out.stderr);
    assert_eq!(read(b.join(".ssh/roster-mesh/id_ed25519.pub")), own);
    assert_eq!(
        read(b.join(".ssh/roster-mesh/id_ed25519")),
        "THEIR PRIVATE KEY\n"
    );
    assert!(!b.join(".ssh/roster-mesh/config").exists());
    assert_eq!(
        read(c.join(".ssh/authorized_keys")),
        BOX_LINE,
        "box-b's key isn't sent"
    );
    // box-c's part goes ahead.
    assert_eq!(
        read(b.join(".ssh/authorized_keys")),
        BOX_LINE.to_string() + &peer_line("box-c", "10.0.0.7")
    );
}

#[test]
fn no_ssh_inherits_a_secrets_variable() {
    const PASSWORD: &str = "pw-7d2e-made-up";
    let inventory = INVENTORY.replace("auth: agent", "auth: \"env:HOST_PW\"");
    let mut s = sandbox("mesh-secrets", &inventory);
    s.set_env("HOST_PW", PASSWORD);
    s.set_env("BW_SESSION", "session-made-up");
    hosts_up(&s);
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let env = read(s.home.join("ssh-hosts.env"));
    assert!(
        env.contains("FAKE_HOSTS="),
        "the fake logged its environment"
    );
    assert!(!env.contains(PASSWORD), "{env}");
    assert!(!env.contains("session-made-up"), "{env}");
}

/// The `->` lines of a dry run.
fn arrows(out: &str) -> String {
    out.lines()
        .filter(|l| l.contains(" -> "))
        .map(|l| format!("{l}\n"))
        .collect()
}

fn with_links(links: &str) -> String {
    format!(
        "{}links:\n{links}",
        table_inventory("", "\n    mesh: true", "")
    )
}

#[test]
fn links_add_one_way_or_two_way_reach_across_groups() {
    let cases = [
        // Host to group: one way.
        (
            "  - {from: box-b, to: ops}\n",
            "box-b -> box-c\nbox-b -> ops-01\nbox-b -> ops-02\nbox-c -> box-b\n",
        ),
        // Group to Host, both ways.
        (
            "  - {from: ops, to: box-c, both: true}\n",
            "box-b -> box-c\nbox-c -> box-b\nbox-c -> ops-01\nbox-c -> ops-02\n\
             ops-01 -> box-c\nops-02 -> box-c\n",
        ),
        // Inside a meshed group: no pair twice.
        (
            "  - {from: box-b, to: box-c, both: true}\n  - {from: box-c, to: box-b}\n",
            "box-b -> box-c\nbox-c -> box-b\n",
        ),
        // Host to Host, in a group without `mesh:`.
        (
            "  - {from: ops-02, to: ops-01}\n",
            "box-b -> box-c\nbox-c -> box-b\nops-02 -> ops-01\n",
        ),
    ];
    for (n, (links, want)) in cases.iter().enumerate() {
        let s = sandbox(&format!("mesh-links-{n}"), &with_links(links));
        hosts_up(&s);
        host(&s, "ops-02", "10.0.0.31");
        let out = s.roster(&["setup", "--dry-run"]);
        assert_eq!(out.code, 0, "case {n}: {}", out.stderr);
        assert_eq!(arrows(&out.stdout), *want, "case {n}");
    }
}

#[test]
fn links_v1_cannot_follow_are_skipped_with_a_reason_in_plan_and_apply() {
    let cases = [
        (
            "  - {from: box-b, to: ops-01, via: ops-02}\n",
            "",
            "roster: link box-b -> ops-01 via ops-02: skipped: via isn't supported yet\n",
        ),
        (
            "  - {from: box-b, to: ops-01, both: true, via: ops-02}\n",
            "",
            "roster: link box-b <-> ops-01 via ops-02: skipped: via isn't supported yet\n",
        ),
        (
            "  - {from: box-b, to: ops-01}\n",
            "ops-01: {ip: 10.0.0.30, seen_as: [192.0.2.30]}",
            "roster: ops-01: left out of the Mesh: seen_as isn't supported yet\n",
        ),
        (
            "  - {from: ops-01, to: box-b}\n",
            "ops-01: {ip: 10.0.0.30, mesh_dir: /srv/mesh}",
            "roster: ops-01: left out of the Mesh: mesh_dir isn't supported yet\n",
        ),
        (
            "  - {from: box-b, to: sw-01}\n",
            "",
            "roster: sw-01: left out of the Mesh: a Password Host (enroll: false)\n",
        ),
        (
            "  - {from: win-01, to: ops-01, both: true}\n",
            "",
            "roster: win-01: left out of the Mesh: os: windows\n",
        ),
    ];
    for (n, (links, ops, why)) in cases.iter().enumerate() {
        let mut inventory = with_links(links);
        if !ops.is_empty() {
            inventory = inventory.replace("ops-01: 10.0.0.30", ops);
        }
        let s = sandbox(&format!("mesh-skip-{n}"), &inventory);
        hosts_up(&s);
        host(&s, "ops-02", "10.0.0.31");
        // Only the group's own web: the Link adds nothing.
        let out = s.roster(&["setup", "--dry-run", "-v"]);
        assert_eq!(out.code, 0, "case {n}: {}", out.stderr);
        assert_eq!(
            arrows(&out.stdout),
            "box-b -> box-c\nbox-c -> box-b\n",
            "case {n}"
        );
        assert_eq!(
            out.stderr.matches(why).count(),
            1,
            "case {n}: {}",
            out.stderr
        );
        let out = s.roster(&["setup", "-v"]);
        assert_eq!(out.code, 0, "case {n}: {}", out.stderr);
        assert_eq!(
            out.stderr.matches(why).count(),
            1,
            "case {n}: {}",
            out.stderr
        );
        assert!(!out.stdout.contains("ops-"), "case {n}: {}", out.stdout);
    }
}

#[test]
fn a_link_reaches_one_way_and_removing_it_removes_its_lines() {
    let linked = format!("{INVENTORY}links:\n  - {{from: box-b, to: ops-01}}\n");
    let s = sandbox("mesh-link-apply", &linked);
    let [b, c, _, ops] = hosts_up(&s);
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}\n{}", out.stdout, out.stderr);
    assert_eq!(
        read(ops.join(".ssh/authorized_keys")),
        BOX_LINE.to_string() + &peer_line("box-b", "10.0.0.6")
    );
    assert!(read(b.join(".ssh/roster-mesh/config")).contains("Host ops-01\n"));
    assert!(read(b.join("ROSTER.md")).contains("| ops-01 |"));
    // One way: ops-01 is no source, and box-c doesn't reach it.
    assert!(!ops.join(".ssh/roster-mesh").exists());
    assert!(!read(c.join(".ssh/roster-mesh/config")).contains("ops-01"));
    let out = s.roster(&["setup"]);
    assert_eq!((out.code, out.stdout.as_str()), (0, ""), "{}", out.stderr);

    s.write("roster.yml", INVENTORY);
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stdout.contains("ops-01: removed box-b's key\n"),
        "{}",
        out.stdout
    );
    assert_eq!(read(ops.join(".ssh/authorized_keys")), BOX_LINE);
    assert!(!read(b.join(".ssh/roster-mesh/config")).contains("ops-01"));
    assert!(!read(b.join("ROSTER.md")).contains("ops-01"));
    assert_eq!(
        read(c.join(".ssh/authorized_keys")),
        BOX_LINE.to_string() + &peer_line("box-b", "10.0.0.6")
    );
}

#[test]
fn a_file_without_a_final_newline_is_read_whole() {
    let s = sandbox("mesh-no-newline", INVENTORY);
    let [b, ..] = hosts_up(&s);
    s.write("hosts/box-b/ROSTER.md", "my own notes");
    let out = s.roster(&["setup"]);
    assert!(!out.stderr.contains("cut short"), "{}", out.stderr);
    let why = "box-b: warning: ~/ROSTER.md isn't the Mesh's; left alone";
    assert!(out.stderr.contains(why), "{}", out.stderr);
    assert_eq!(read(b.join("ROSTER.md")), "my own notes");
    assert!(b.join(".ssh/roster-mesh/config").exists());
}

#[test]
fn a_host_that_says_nothing_is_reported_and_gets_no_lines() {
    let s = sandbox("mesh-mute", INVENTORY);
    let [b, c, ..] = hosts_up(&s);
    s.write("hosts/box-c/mute", "");
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    let why = "roster: box-c: Mesh: its report was cut short\n";
    assert!(out.stderr.contains(why), "{}", out.stderr);
    assert_eq!(read(b.join(".ssh/authorized_keys")), BOX_LINE);
    assert_eq!(read(c.join(".ssh/authorized_keys")), BOX_LINE);
    assert!(!out.stdout.contains("box-c: added"), "{}", out.stdout);
}

#[test]
fn a_symlinked_file_on_a_host_stays_a_link() {
    let s = sandbox("mesh-symlink", INVENTORY);
    let [_, c, ..] = hosts_up(&s);
    let keys = c.join(".ssh/authorized_keys");
    std::fs::rename(&keys, c.join("keys")).unwrap();
    std::os::unix::fs::symlink("../keys", &keys).unwrap();
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(keys.symlink_metadata().unwrap().is_symlink());
    assert_eq!(
        read(c.join("keys")),
        BOX_LINE.to_string() + &peer_line("box-b", "10.0.0.6")
    );
}
