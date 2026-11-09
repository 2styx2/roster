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
        log.contains(
            "-o BatchMode=yes -o ConnectTimeout=10 box-a -- echo up; echo $FAKE_SSH_HOST\n"
        ),
        "{log}"
    );
}

const PASSWORD: &str = "pw-run-9c1e-made-up";

/// Every file under `dir`, recursively.
fn files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut all = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        match path.is_dir() {
            true => all.extend(files(&path)),
            false => all.push(path),
        }
    }
    all
}

#[test]
fn a_password_host_runs_through_askpass_and_the_password_never_leaks() {
    let mut s = Sandbox::new("run-secrets");
    s.write(
        "roster.yml",
        "defaults: {user: admin}\ngroups:\n  net:\n    hosts:\n      \
         sw-01: {ip: 10.0.0.9, enroll: false, auth: env:SW_PASS}\n      \
         box-d: 10.0.0.10\n",
    );
    let runtime = std::env::temp_dir().join("roster-t-run-secrets");
    let _ = std::fs::remove_dir_all(&runtime);
    std::fs::create_dir_all(&runtime).unwrap();
    s.set_env("XDG_RUNTIME_DIR", runtime.to_str().unwrap());
    s.set_env("SW_PASS", PASSWORD);
    s.set_env("FAKE_SSH_RUN", "1");
    s.set_env("FAKE_SSH_ASKPASS", "admin@10.0.0.9's password: ");
    let out = s.roster(&["run", "net", "--", "echo", "$FAKE_SSH_HOST"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(sorted(&out.stdout), ["box-d: box-d", "sw-01: sw-01"]);
    let log = std::fs::read_to_string(s.home.join("ssh.log")).unwrap();
    // BatchMode would stop ssh asking askpass for the password.
    assert!(
        log.contains("\n-o ConnectTimeout=10 sw-01 -- echo $FAKE_SSH_HOST\n")
            || log.starts_with("-o ConnectTimeout=10 sw-01 -- "),
        "{log}"
    );
    let got = std::fs::read_to_string(s.home.join("askpass.got")).unwrap();
    assert_eq!(
        got,
        format!("{PASSWORD}\n"),
        "the password went through askpass"
    );
    assert!(!out.stdout.contains(PASSWORD) && !out.stderr.contains(PASSWORD));
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
    let left: Vec<_> = std::fs::read_dir(&runtime).unwrap().collect();
    assert!(
        left.is_empty(),
        "the askpass directory is removed: {left:?}"
    );
}

fn ran(s: &Sandbox) -> Vec<String> {
    let log = std::fs::read_to_string(s.home.join("ssh.log")).unwrap_or_default();
    let mut hosts: Vec<_> = log
        .lines()
        .filter_map(|l| l.split(" -- ").next()?.rsplit(' ').next())
        .map(String::from)
        .collect();
    hosts.sort();
    hosts
}

#[test]
fn a_mixed_target_runs_each_host_once_and_skips_unreviewed_ones() {
    let s = sandbox("run-mixed");
    let out = s.roster(&["run", "box-a,lab,dev", "--", "true"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stderr, "roster: skipped box-c: unreviewed\n");
    assert_eq!(ran(&s), ["box-a", "box-b", "esx-02"]);
}

#[test]
fn an_unknown_name_in_the_target_exits_1_before_any_ssh() {
    let s = sandbox("run-unknown");
    let out = s.roster(&["run", "dev,nope", "--", "true"]);
    assert_eq!(out.code, 1);
    assert_eq!(
        out.stderr,
        "roster: no Host or group named 'nope' in the Inventory\n"
    );
    assert!(ran(&s).is_empty());
}

#[test]
fn run_without_a_target_or_command_is_a_usage_error() {
    let s = sandbox("run-usage");
    assert_eq!(s.roster(&["run", "dev"]).code, 2);
    assert_eq!(s.roster(&["run", "dev", "--"]).code, 2);
    assert_eq!(s.roster(&["run"]).code, 2);
    assert!(ran(&s).is_empty());
}

#[test]
fn a_down_host_fails_alone_and_run_exits_1() {
    let mut s = sandbox("run-down");
    s.set_env("FAKE_SSH_DOWN", "box-b");
    let out = s.roster(&["run", "dev", "--", "echo", "hi"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "box-a: hi\n");
    assert_eq!(
        out.stderr,
        "box-b: ssh: connect to host box-b port 22: Connection timed out\n\
         roster: failed on box-b\n"
    );
}

#[test]
fn hosts_run_at_the_same_time() {
    let s = sandbox("run-parallel");
    // Each Host waits for all three marks; run one at a time, the first gives up.
    let wait = "touch \"$HOME/$FAKE_SSH_HOST.up\"; i=0; \
                until [ -e \"$HOME/box-a.up\" ] && [ -e \"$HOME/box-b.up\" ] \
                && [ -e \"$HOME/esx-02.up\" ]; \
                do i=$((i+1)); [ $i -gt 200 ] && exit 9; sleep 0.05; done; echo met";
    let out = s.roster(&["run", "dev,lab", "--", wait]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        sorted(&out.stdout),
        ["box-a: met", "box-b: met", "esx-02: met"]
    );
}

#[test]
fn more_hosts_than_workers_all_run() {
    let mut s = Sandbox::new("run-many");
    let hosts: String = (0..40)
        .map(|i| format!("      n-{i:02}: 10.0.1.{i}\n"))
        .collect();
    s.write(
        "roster.yml",
        &format!("defaults: {{user: admin}}\ngroups:\n  big:\n    hosts:\n{hosts}"),
    );
    s.set_env("FAKE_SSH_RUN", "1");
    let out = s.roster(&["run", "big", "--", "echo", "ok"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout.lines().count(), 40);
    assert_eq!(ran(&s).len(), 40);
}

#[test]
fn json_gives_each_hosts_exit_stdout_and_stderr_in_target_order() {
    let mut s = sandbox("run-json");
    s.set_env("FAKE_SSH_DOWN", "esx-02");
    let cmd = ["echo", "out;", "echo", "err", ">&2;", "exit", "3"];
    let args = [&["run", "--json", "box-b,esx-02,box-a", "--"][..], &cmd].concat();
    let out = s.roster(&args);
    assert_eq!(out.code, 1);
    let doc: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
    let down = "ssh: connect to host esx-02 port 22: Connection timed out\n";
    assert_eq!(
        doc,
        serde_json::json!({"v": 1, "hosts": [
            {"host": "box-b", "exit": 3, "stdout": "out\n", "stderr": "err\n"},
            {"host": "esx-02", "exit": 255, "stdout": "", "stderr": down},
            {"host": "box-a", "exit": 3, "stdout": "out\n", "stderr": "err\n"},
        ]})
    );
    assert_eq!(out.stderr, "roster: failed on box-b, esx-02, box-a\n");
}

#[test]
fn a_password_that_wont_resolve_stops_run_before_any_ssh() {
    let mut s = Sandbox::new("run-vault-fail");
    s.write(
        "roster.yml",
        "defaults: {user: admin}\ngroups:\n  net:\n    hosts:\n      \
         box-d: 10.0.0.10\n      sw-01: {ip: 10.0.0.9, enroll: false, auth: env:NOT_SET}\n",
    );
    s.set_env("FAKE_SSH_RUN", "1");
    let out = s.roster(&["run", "net", "--", "true"]);
    assert_eq!(out.code, 1);
    assert_eq!(
        out.stderr,
        "roster: sw-01: auth env:NOT_SET: NOT_SET isn't set\n"
    );
    assert!(ran(&s).is_empty());
}
