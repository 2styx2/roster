//! `roster setup`, the Host side: record host keys, then install the Box key
//! on each Enrolled Host that doesn't accept it yet. Fake ssh plays the
//! Hosts: `$FAKE_HOSTS/NAME` is Host NAME's HOME.
mod common;
use common::Sandbox;
use std::path::PathBuf;

const PASSWORD: &str = "pw-41c9-made-up";
const BOX_LINE: &str = "ssh-ed25519 AAAAfake roster-managed:box-a\n";

const INVENTORY: &str = r#"
box_name: box-a
defaults: {user: admin, auth: "env:HOST_PW"}
groups:
  dev:
    hosts:
      box-b: 10.0.0.6
      box-c: {ip: 10.0.0.7, port: 2222}
  gear:
    hosts:
      new-01: {ip: 10.0.0.20, reviewed: false}
      win-01: {ip: 10.0.0.21, os: windows}
      sw-01: {ip: 10.0.0.22, enroll: false}
"#;

/// A sandbox with INVENTORY, fake Hosts under `hosts/`, the vault password
/// in $HOST_PW and a short private runtime dir for the askpass socket.
fn sandbox(name: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    s.write("roster.yml", INVENTORY);
    let hosts = s.home.join("hosts");
    std::fs::create_dir_all(&hosts).unwrap();
    s.set_env("FAKE_HOSTS", hosts.to_str().unwrap());
    s.set_env("HOST_PW", PASSWORD);
    let run = std::env::temp_dir().join(format!("roster-t-{name}"));
    let _ = std::fs::remove_dir_all(&run);
    std::fs::create_dir_all(&run).unwrap();
    s.set_env("XDG_RUNTIME_DIR", run.to_str().unwrap());
    s
}

/// A fake Host that is up, answers at `ip` and takes PASSWORD.
fn host(s: &Sandbox, name: &str, ip: &str) -> PathBuf {
    s.write(&format!("hosts/{name}/ip"), ip);
    s.write(&format!("hosts/{name}/password"), PASSWORD);
    s.home.join("hosts").join(name)
}

fn read(path: impl AsRef<std::path::Path>) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn mode(path: impl AsRef<std::path::Path>) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn setup_installs_the_box_key_with_the_vault_password_once() {
    let s = sandbox("hosts-install");
    let b = host(&s, "box-b", "10.0.0.6");
    let c = host(&s, "box-c", "10.0.0.7");
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    for (h, name) in [(&b, "box-b"), (&c, "box-c")] {
        assert_eq!(read(h.join(".ssh/authorized_keys")), BOX_LINE, "{name}");
        assert_eq!(mode(h.join(".ssh")), 0o700, "{name}");
        assert_eq!(mode(h.join(".ssh/authorized_keys")), 0o600, "{name}");
        let said = format!("installed the Box key on {name}\n");
        assert!(out.stdout.contains(&said), "{}", out.stdout);
    }
    assert_eq!(
        read(s.home.join(".ssh/roster_known_hosts")),
        "10.0.0.6 ssh-ed25519 AAAAhost-10.0.0.6\n\
         [10.0.0.7]:2222 ssh-ed25519 AAAAhost-10.0.0.7\n"
    );
    assert_eq!(
        read(s.home.join("ssh-keyscan.log")),
        "-T 5 -p 22 10.0.0.6\n-T 5 -p 2222 10.0.0.7\n"
    );

    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "", "a rerun has nothing to do");
    assert_eq!(read(b.join(".ssh/authorized_keys")), BOX_LINE);
    assert_eq!(read(s.home.join("ssh-keyscan.log")).lines().count(), 2);
}

/// A Windows Host labelled only `type: windows` (no `os: windows`) that
/// already takes the key: the probe is `exit`, which PowerShell has, so it
/// counts as done; nothing is installed.
#[test]
fn a_host_whose_shell_lacks_true_but_takes_the_key_is_done() {
    let s = sandbox("hosts-powershell");
    let b = host(&s, "box-b", "10.0.0.6");
    let c = host(&s, "box-c", "10.0.0.7");
    assert_eq!(s.roster(&["setup"]).code, 0, "first run installs");
    s.write("hosts/box-b/powershell", "");
    let out = s.roster(&["setup"]);
    // The key step is done: no install was tried.
    assert!(
        !out.stderr.contains("installing the Box key"),
        "{}",
        out.stderr
    );
    assert!(!out.stdout.contains("box-b"), "{}", out.stdout);
    assert_eq!(read(b.join(".ssh/authorized_keys")), BOX_LINE);
    assert_eq!(read(c.join(".ssh/authorized_keys")), BOX_LINE);
    // The Mesh's sh can't run there: it says why, and what to do.
    assert!(
        out.stderr.contains("box-b: Mesh: failed (1): ")
            && out
                .stderr
                .contains("(a Windows Host? give it `os: windows`)"),
        "{}",
        out.stderr
    );
    // With `os: windows`, setup leaves it out, and the run is clean.
    s.write(
        "roster.yml",
        &INVENTORY.replace("box-b: 10.0.0.6", "box-b: {ip: 10.0.0.6, os: windows}"),
    );
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(!out.stderr.contains("Mesh: failed"), "{}", out.stderr);
}

#[test]
fn unreviewed_windows_and_password_hosts_are_skipped_with_a_reason() {
    let s = sandbox("hosts-skips");
    host(&s, "box-b", "10.0.0.6");
    host(&s, "box-c", "10.0.0.7");
    // By default, routine skips are one summary line.
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        out.stderr,
        "roster: skipped 1 unreviewed, 1 Windows Host, 1 Password Host \
         (--verbose lists them)\n"
    );
    // -v lists each one, with its reason.
    let out = s.roster(&["setup", "-v"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        out.stderr,
        "roster: new-01: skipped: unreviewed\n\
         roster: win-01: skipped: os: windows; install the Box key by hand for now\n\
         roster: sw-01: skipped: a Password Host (enroll: false)\n"
    );
    let contacted = read(s.home.join("ssh.log")) + &read(s.home.join("ssh-keyscan.log"));
    for skipped in ["new-01", "win-01", "sw-01", "10.0.0.2"] {
        assert!(!contacted.contains(skipped), "{skipped}: {contacted}");
    }
}

#[test]
fn a_down_host_does_not_stop_the_run_and_the_next_run_finishes_it() {
    let s = sandbox("hosts-down");
    let b = host(&s, "box-b", "10.0.0.6");
    let c = host(&s, "box-c", "10.0.0.7");
    s.write("hosts/box-b/down", "");
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    let down = "roster: box-b: down: no answer to ssh-keyscan at 10.0.0.6\n";
    assert!(out.stderr.contains(down), "{}", out.stderr);
    let last = "roster: 1 Host not done; run `roster setup` again to finish\n";
    assert!(out.stderr.ends_with(last), "{}", out.stderr);
    assert_eq!(read(c.join(".ssh/authorized_keys")), BOX_LINE);
    assert!(!b.join(".ssh").exists());

    std::fs::remove_file(b.join("down")).unwrap();
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        out.stdout,
        "recorded the host key of box-b\ninstalled the Box key on box-b\n"
    );
    assert_eq!(read(b.join(".ssh/authorized_keys")), BOX_LINE);
}

#[test]
fn a_host_down_after_its_key_was_recorded_is_reported_too() {
    let s = sandbox("hosts-down-known");
    host(&s, "box-b", "10.0.0.6");
    host(&s, "box-c", "10.0.0.7");
    s.write(
        ".ssh/roster_known_hosts",
        "10.0.0.6 ssh-ed25519 AAAAhost-10.0.0.6\n",
    );
    s.write("hosts/box-b/down", "");
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    let msg = "roster: box-b: can't log in with the password: \
               ssh: connect to host box-b port 22: Connection timed out\n";
    assert!(out.stderr.contains(msg), "{}", out.stderr);
}

#[test]
fn the_line_is_appended_keeping_the_other_lines_and_the_mode() {
    use std::os::unix::fs::PermissionsExt;
    let s = sandbox("hosts-append");
    let b = host(&s, "box-b", "10.0.0.6");
    host(&s, "box-c", "10.0.0.7");
    let theirs = "ssh-rsa AAAAother someone@else";
    let ak = s.write("hosts/box-b/.ssh/authorized_keys", theirs);
    std::fs::set_permissions(&ak, std::fs::Permissions::from_mode(0o644)).unwrap();
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(&ak), format!("{theirs}\n{BOX_LINE}"));
    assert_eq!(mode(&ak), 0o644);
    let left: Vec<_> = std::fs::read_dir(b.join(".ssh")).unwrap().collect();
    assert_eq!(left.len(), 1, "no temp file left: {left:?}");
}

#[test]
fn a_key_already_there_but_not_taken_is_not_added_twice() {
    let s = sandbox("hosts-present");
    host(&s, "box-b", "10.0.0.6");
    host(&s, "box-c", "10.0.0.7");
    let legacy = "ssh-ed25519 AAAAfake fleet-managed:box-a\n";
    let ak = s.write("hosts/box-b/.ssh/authorized_keys", legacy);
    s.write("hosts/box-b/nokey", "");
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert_eq!(read(&ak), legacy);
    let msg = "roster: box-b: the Box key is in authorized_keys but isn't taken; \
               check the modes of ~ and ~/.ssh there\n";
    assert!(out.stderr.contains(msg), "{}", out.stderr);
}

#[test]
fn a_commented_out_copy_of_the_key_is_not_present() {
    let s = sandbox("hosts-commented");
    host(&s, "box-b", "10.0.0.6");
    host(&s, "box-c", "10.0.0.7");
    let old = "# ssh-ed25519 AAAAfake roster-managed:box-a\n";
    let ak = s.write("hosts/box-b/.ssh/authorized_keys", old);
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(&ak), format!("{old}{BOX_LINE}"));
    assert!(out.stdout.contains("installed the Box key on box-b\n"));
}

#[test]
fn a_wrong_password_is_reported_and_no_password_leaks() {
    let s = sandbox("hosts-wrong-pw");
    let b = host(&s, "box-b", "10.0.0.6");
    host(&s, "box-c", "10.0.0.7");
    s.write("hosts/box-b/password", "pw-something-else");
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    let msg = "roster: box-b: can't log in with the password: \
               admin@box-b: Permission denied (publickey,password).\n";
    assert!(out.stderr.contains(msg), "{}", out.stderr);
    assert!(!b.join(".ssh").exists());
    let ssh_args = read(s.home.join("ssh.log"));
    let shown = out.stdout + &out.stderr + &ssh_args;
    assert!(!shown.contains(PASSWORD), "{shown}");
    assert!(
        ssh_args.contains("-o ControlMaster=no -o PubkeyAuthentication=no box-b sh -s\n"),
        "only `sh -s` goes in argv: {ssh_args}"
    );
}

#[test]
fn an_auth_without_a_password_cannot_install_the_key() {
    let s = sandbox("hosts-auth-key");
    s.write(
        "roster.yml",
        "box_name: box-a\ndefaults: {user: admin, auth: key}\n\
         groups: {dev: {hosts: {box-b: 10.0.0.6}}}\n",
    );
    host(&s, "box-b", "10.0.0.6");
    let out = s.roster(&["setup"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    let msg = "roster: box-b: doesn't take the Box key, and auth: key \
               gives no password to install it with\n";
    assert!(out.stderr.starts_with(msg), "{}", out.stderr);
}

#[test]
fn dry_run_prints_the_plan_and_changes_nothing() {
    let s = sandbox("hosts-dry");
    let b = host(&s, "box-b", "10.0.0.6");
    let c = host(&s, "box-c", "10.0.0.7");
    s.write(
        ".ssh/roster_known_hosts",
        "10.0.0.6 ssh-ed25519 AAAAhost-10.0.0.6\n",
    );
    let out = s.roster(&["setup", "--dry-run"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let key = s.home.join(".ssh/roster_ed25519");
    let config = s.home.join(".ssh/config.d/roster");
    let first = format!(
        "would make the Box key {}\nwould write {}\n",
        key.display(),
        config.display()
    );
    assert!(out.stdout.starts_with(&first), "{}", out.stdout);
    let last = "would install the Box key on box-b\n\
                would record the host key of box-c and install the Box key\n";
    assert!(out.stdout.ends_with(last), "{}", out.stdout);
    assert_eq!(
        read(s.home.join("ssh.log")),
        "-o BatchMode=yes -o ControlMaster=no box-b exit\n",
        "only the read-only probe, and only where the host key is known"
    );
    assert_eq!(read(s.home.join("ssh-keyscan.log")), "");
    assert!(!key.exists() && !config.exists());
    assert!(!s.home.join("ROSTER.md").exists());
    assert!(!b.join(".ssh").exists() && !c.join(".ssh").exists());
}
