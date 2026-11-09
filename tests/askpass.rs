//! `roster ssh` to a Password Host: the vault reference is resolved and the
//! password reaches ssh only through askpass.
mod common;
use common::Sandbox;
use std::path::PathBuf;

const PASSWORD: &str = "pw-7f3a-made-up";
const PROMPT: &str = "admin@10.0.0.9's password: ";

/// A sandbox with sw-01 as a Password Host using `auth`, and a private
/// runtime dir (short, so the socket path fits).
fn sandbox(name: &str, auth: &str) -> (Sandbox, PathBuf) {
    let mut s = Sandbox::new(name);
    s.write(
        "roster.yml",
        &format!(
            "defaults: {{user: admin}}\ngroups:\n  net:\n    hosts:\n      \
             sw-01: {{ip: 10.0.0.9, enroll: false, auth: {auth:?}}}\n"
        ),
    );
    let run = std::env::temp_dir().join(format!("roster-t-{name}"));
    let _ = std::fs::remove_dir_all(&run);
    std::fs::create_dir_all(&run).unwrap();
    s.set_env("XDG_RUNTIME_DIR", run.to_str().unwrap());
    (s, run)
}

fn read(s: &Sandbox, file: &str) -> String {
    std::fs::read_to_string(s.home.join(file)).unwrap_or_default()
}

fn assert_removed(run: &PathBuf) {
    let left: Vec<_> = std::fs::read_dir(run).unwrap().collect();
    assert!(
        left.is_empty(),
        "the askpass directory is removed: {left:?}"
    );
}

#[test]
fn a_password_host_gets_its_password_through_askpass() {
    let (mut s, run) = sandbox("askpass-env", "env:SW_PASS");
    s.set_env("SW_PASS", PASSWORD);
    s.set_env("FAKE_SSH_ASKPASS", PROMPT);
    s.set_env("FAKE_SSH_EXIT", "4");
    let out = s.roster(&["ssh", "sw-01", "--", "show", "version"]);
    assert_eq!(out.code, 4, "ssh's exit status is roster's: {}", out.stderr);
    assert_eq!(read(&s, "ssh.log"), "sw-01 -- show version\n");
    assert_eq!(read(&s, "askpass.got"), format!("{PASSWORD}\n"));
    assert_eq!(read(&s, "askpass.status"), "0\n");
    assert_eq!(read(&s, "askpass.mode"), "700\n");
    let env = read(&s, "ssh.env");
    let exe = std::fs::canonicalize(env!("CARGO_BIN_EXE_roster")).unwrap();
    assert!(
        env.contains(&format!("SSH_ASKPASS={}\n", exe.display())),
        "{env}"
    );
    assert!(env.contains("SSH_ASKPASS_REQUIRE=force\n"), "{env}");
    assert!(
        env.contains(&format!("ROSTER_ASKPASS={}/", run.display())),
        "{env}"
    );
    assert_removed(&run);
}

/// Every file under `dir`, recursively.
fn files(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut all = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            all.extend(files(&path));
        } else {
            all.push(path);
        }
    }
    all
}

#[test]
fn the_password_never_leaks() {
    let (mut s, run) = sandbox("askpass-secrets", "env:SW_PASS");
    s.set_env("SW_PASS", PASSWORD);
    s.set_env("FAKE_SSH_ASKPASS", PROMPT);
    s.set_env("FAKE_SSH_ASKPASS_AGAIN", "1");
    let out = s.roster(&["ssh", "sw-01", "--", "show", "run"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    // The fake's capture proves the password went through askpass...
    assert_eq!(read(&s, "askpass.got"), format!("{PASSWORD}\n"));
    // ...and it is nowhere else: not in argv, ssh's environment, output or files.
    assert!(!out.stdout.contains(PASSWORD) && !out.stderr.contains(PASSWORD));
    assert!(!read(&s, "ssh.log").contains(PASSWORD), "argv");
    assert!(!read(&s, "ssh.env").contains(PASSWORD), "ssh's environment");
    for file in files(&s.home) {
        if file.ends_with("askpass.got") {
            continue;
        }
        let bytes = std::fs::read(&file).unwrap();
        let hit = bytes
            .windows(PASSWORD.len())
            .any(|w| w == PASSWORD.as_bytes());
        assert!(!hit, "the password is in {}", file.display());
    }
    assert_removed(&run);
}

#[test]
fn askpass_refuses_a_host_key_question_and_roster_does_not_hang() {
    let (mut s, run) = sandbox("askpass-yesno", "env:SW_PASS");
    s.set_env("SW_PASS", PASSWORD);
    s.set_env(
        "FAKE_SSH_ASKPASS",
        "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
    );
    let out = s.roster(&["ssh", "sw-01"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(&s, "askpass.got"), "");
    assert_eq!(read(&s, "askpass.status"), "1\n");
    assert_removed(&run);
}

#[test]
fn askpass_serves_exactly_one_connection() {
    let (mut s, run) = sandbox("askpass-once", "env:SW_PASS");
    s.set_env("SW_PASS", PASSWORD);
    s.set_env("FAKE_SSH_ASKPASS", "Password: ");
    s.set_env("FAKE_SSH_ASKPASS_AGAIN", "1");
    let out = s.roster(&["ssh", "sw-01"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(&s, "askpass.got"), format!("{PASSWORD}\n"));
    assert_eq!(
        read(&s, "askpass.again"),
        "1\n",
        "a second ask gets nothing"
    );
    assert_removed(&run);
}

#[test]
fn auth_cmd_uses_the_first_line_the_command_prints() {
    let (mut s, run) = sandbox("vault-cmd", "cmd:printf 'pw-cmd-one\\r\\nsecond\\n'");
    s.set_env("FAKE_SSH_ASKPASS", PROMPT);
    let out = s.roster(&["ssh", "sw-01"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(&s, "askpass.got"), "pw-cmd-one\n");
    assert_removed(&run);
}

#[test]
fn auth_cmd_that_fails_stops_before_ssh() {
    let (s, _run) = sandbox("vault-cmd-fails", "cmd:echo locked >&2; exit 3");
    let out = s.roster(&["ssh", "sw-01"]);
    assert_eq!(out.code, 1);
    assert!(
        out.stderr.contains("locked\n"),
        "the command's stderr shows: {}",
        out.stderr
    );
    assert!(
        out.stderr.contains("roster: sw-01: auth cmd: failed"),
        "{}",
        out.stderr
    );
    assert_eq!(read(&s, "ssh.log"), "");
}

#[test]
fn auth_env_that_is_unset_stops_before_ssh() {
    let (s, _run) = sandbox("vault-env-unset", "env:SW_PASS");
    let out = s.roster(&["ssh", "sw-01"]);
    assert_eq!(out.code, 1);
    assert_eq!(
        out.stderr,
        "roster: sw-01: auth env:SW_PASS: SW_PASS isn't set\n"
    );
    assert_eq!(read(&s, "ssh.log"), "");
}

#[test]
fn an_unsupported_reference_suggests_cmd() {
    for (name, auth) in [("vault-op", "op:net/sw-01"), ("vault-kp", "kp:sw-01")] {
        let (s, _run) = sandbox(name, auth);
        let out = s.roster(&["ssh", "sw-01"]);
        assert_eq!(out.code, 1, "{auth}");
        assert!(out.stderr.contains("use cmd:"), "{auth}: {}", out.stderr);
        assert_eq!(read(&s, "ssh.log"), "", "{auth}");
    }
}

#[test]
fn agent_key_and_none_mean_no_password_and_no_askpass() {
    for (name, auth) in [
        ("vault-agent", "agent"),
        ("vault-key", "key"),
        ("vault-none", "none"),
    ] {
        let (mut s, _run) = sandbox(name, auth);
        s.set_env("FAKE_SSH_ASKPASS", PROMPT);
        s.set_env("FAKE_SSH_EXIT", "3");
        let out = s.roster(&["ssh", "sw-01"]);
        assert_eq!(out.code, 3, "{auth}: {}", out.stderr);
        assert_eq!(read(&s, "ssh.log"), "sw-01\n");
        let env = read(&s, "ssh.env");
        let askpass = env
            .lines()
            .any(|l| l.starts_with("SSH_ASKPASS") || l.starts_with("ROSTER_ASKPASS"));
        assert!(!askpass, "{auth}: {env}");
    }
}

#[test]
fn askpass_removes_its_directory_when_ssh_cannot_start() {
    let (mut s, run) = sandbox("askpass-nossh", "env:SW_PASS");
    s.set_env("SW_PASS", PASSWORD);
    s.set_env("PATH", "/nonexistent");
    let out = s.roster(&["ssh", "sw-01"]);
    assert_eq!(out.code, 126, "{}", out.stderr);
    assert!(out.stderr.contains("can't run ssh"), "{}", out.stderr);
    assert_removed(&run);
}
