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
