//! Side by side with the Python roster v0.7.0: what one writes on a Host, the
//! other recognises and removes. Both run against the same fake Hosts
//! (`$FAKE_HOSTS/NAME` is Host NAME's HOME) through this repo's fake ssh,
//! first on PATH for both.
//!
//! Ignored by default: it needs Python and the network, to install v0.7.0
//! from its tag into a throwaway venv under the test's temp directory. Run it
//! with `ROSTER_SIDE_BY_SIDE=1 cargo test --test side_by_side -- --ignored`.
//! The Python roster only ever runs with HOME set to the sandbox and
//! ROSTER_CONFIG naming the made-up fixture below.
mod common;
use common::{Out, Sandbox};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

const TAG: &str = "v0.7.0";
const REPO: &str = "https://github.com/2styx2/roster";
const BOX_LINE: &str = "ssh-ed25519 AAAAfake roster-managed:box-a\n";

const INVENTORY: &str = r#"
box_name: box-a
defaults: {user: admin, auth: agent}
groups:
  dev:
    mesh: true
    hosts:
      box-b: 198.51.100.6
      box-c: 198.51.100.7
"#;

const HOSTS: [(&str, &str); 2] = [("box-b", "198.51.100.6"), ("box-c", "198.51.100.7")];

/// The venv's `roster`: v0.7.0, installed afresh once per test run.
fn python_roster() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(install).clone()
}

fn install() -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("side-by-side-venv");
    let _ = std::fs::remove_dir_all(&dir);
    let bin = dir.join("bin/roster");
    let spec = format!("git+{REPO}@{TAG}");
    let ok = if Command::new("uv").arg("--version").output().is_ok() {
        sh("uv", &["venv", "-q", dir.to_str().unwrap()])
            && sh(
                "uv",
                &["pip", "install", "-q", "--python", py(&dir).as_str(), &spec],
            )
    } else {
        sh("python3", &["-m", "venv", dir.to_str().unwrap()])
            && sh(&py(&dir), &["-m", "pip", "install", "-q", &spec])
    };
    assert!(ok && bin.exists(), "couldn't install roster {TAG}");
    bin
}

fn py(venv: &Path) -> String {
    venv.join("bin/python").display().to_string()
}

fn sh(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .status()
        .is_ok_and(|s| s.success())
}

/// None when the side-by-side run wasn't asked for.
fn sandbox(name: &str) -> Option<(Sandbox, PathBuf)> {
    if std::env::var("ROSTER_SIDE_BY_SIDE").as_deref() != Ok("1") {
        eprintln!("skipped: set ROSTER_SIDE_BY_SIDE=1 to run it");
        return None;
    }
    let python = python_roster();
    let mut s = Sandbox::new(name);
    let config = s.write("roster.yml", INVENTORY);
    s.set_env("ROSTER_CONFIG", config.to_str().unwrap());
    let hosts = s.home.join("hosts");
    s.set_env("FAKE_HOSTS", hosts.to_str().unwrap());
    // v0.7.0 reads known_hosts with paramiko, which decodes each key.
    s.set_env("FAKE_KEYSCAN_REAL", "1");
    s.write(".ssh/roster_ed25519", "FAKE PRIVATE KEY\n");
    s.write(".ssh/roster_ed25519.pub", BOX_LINE);
    for (name, ip) in HOSTS {
        s.write(&format!("hosts/{name}/ip"), ip);
        let keys = s.write(&format!("hosts/{name}/.ssh/authorized_keys"), BOX_LINE);
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(keys, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    Some((s, python))
}

fn read(path: impl AsRef<Path>) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn ok(out: &Out, what: &str) {
    assert_eq!(out.code, 0, "{what}\n{}\n{}", out.stdout, out.stderr);
}

/// What box-a has on a Host: its key lines, Mesh lines and Mesh files.
fn traces(s: &Sandbox, name: &str) -> Vec<String> {
    let dir = s.home.join("hosts").join(name);
    let mut found: Vec<String> = read(dir.join(".ssh/authorized_keys"))
        .lines()
        .filter(|l| l.contains("roster-managed:box-a") || l.contains("@box-a"))
        .map(String::from)
        .collect();
    for file in [".ssh/roster-mesh", "ROSTER.md"] {
        if dir.join(file).exists() {
            found.push(file.into());
        }
    }
    if read(dir.join(".ssh/config")).contains("roster-mesh") {
        found.push(".ssh/config".into());
    }
    found
}

/// Every Host holds the Box key line, a peer's Mesh line and the Mesh files.
fn assert_in_mesh(s: &Sandbox) {
    for (name, _) in HOSTS {
        let found = traces(s, name);
        assert!(
            found.contains(&BOX_LINE.trim_end().into()),
            "{name}: {found:?}"
        );
        assert!(
            found.iter().any(|t| t.contains("@box-a")),
            "{name}: {found:?}"
        );
        for file in [".ssh/roster-mesh", ".ssh/config"] {
            assert!(found.contains(&file.into()), "{name}: {found:?}");
        }
    }
}

fn assert_gone(s: &Sandbox) {
    for (name, _) in HOSTS {
        assert_eq!(traces(s, name), Vec::<String>::new(), "{name}");
    }
}

#[test]
#[ignore = "needs Python and the network: ROSTER_SIDE_BY_SIDE=1 ... -- --ignored"]
fn python_mesh_cut_and_revoke_remove_what_roster_rs_wrote() {
    let Some((s, python)) = sandbox("sbs-rust-then-python") else {
        return;
    };
    ok(&s.roster(&["setup"]), "roster-rs setup");
    assert_in_mesh(&s);

    // The Mesh first: once the key line goes, nothing can log in to cut it.
    ok(
        &s.run(&python, &["mesh", "cut", "--all", "--yes"]),
        "mesh cut",
    );
    for (name, _) in HOSTS {
        let found = traces(&s, name);
        assert_eq!(found, [BOX_LINE.trim_end()], "{name}");
    }
    ok(&s.run(&python, &["revoke", "--yes"]), "revoke");
    assert_gone(&s);
}

/// v0.7.0's `setup` installs the key line only over a password login with
/// paramiko, which fake ssh can't stand in for: so the Hosts start with the
/// line it writes (`TYPE KEY roster-managed:BOX`), and its `setup` and `mesh`
/// write the rest over its own ssh calls.
#[test]
#[ignore = "needs Python and the network: ROSTER_SIDE_BY_SIDE=1 ... -- --ignored"]
fn roster_rs_undo_removes_what_python_wrote() {
    let Some((s, python)) = sandbox("sbs-python-then-rust") else {
        return;
    };
    ok(&s.run(&python, &["setup"]), "Python setup");
    ok(&s.run(&python, &["mesh"]), "Python mesh");
    assert_in_mesh(&s);

    ok(&s.roster(&["setup", "--undo"]), "roster-rs setup --undo");
    assert_gone(&s);
}
