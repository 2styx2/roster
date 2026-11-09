//! `bw:` references and `roster vault unlock|lock`, against a fake bw and a
//! fake keyctl. The session key lives only in the (fake) kernel keyring.
mod common;
use common::Sandbox;

const MASTER: &str = "master-made-up-41c9";
const SESSION: &str = "session-made-up-77e2";
const PASSWORD: &str = "pw-sw01-made-up";
const ITEMS: &str = concat!(
    r#"{"object":"item","name":"sw-01","notes":"rack 4","login":{"username":"netops","password":"pw-sw01-made-up"},"fields":[{"name":"Enable","value":"en-made-up","type":1},{"name":"enable","value":"lower-made-up","type":1},{"name":"Token","value":"tok-made-up","type":1}]}"#,
    "\n",
    r#"{"object":"item","name":"empty","login":{"username":null,"password":null},"fields":[]}"#,
);
const PROMPT: &str = "netops@10.0.0.9's password: ";
const LEGACY: &str = ".config/roster/bw-session";

/// A sandbox with sw-01 as a Password Host using `auth`, and the fake vault.
fn sandbox(name: &str, auth: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    s.write(
        "roster.yml",
        &format!(
            "defaults: {{user: netops}}\ngroups:\n  net:\n    hosts:\n      \
             sw-01: {{ip: 10.0.0.9, enroll: false, auth: {auth:?}}}\n"
        ),
    );
    let run = std::env::temp_dir().join(format!("roster-t-{name}"));
    let _ = std::fs::remove_dir_all(&run);
    std::fs::create_dir_all(&run).unwrap();
    s.set_env("XDG_RUNTIME_DIR", run.to_str().unwrap());
    s.set_env("FAKE_BW_ITEMS", ITEMS);
    s.set_env("FAKE_SSH_ASKPASS", PROMPT);
    s
}

fn read(s: &Sandbox, file: &str) -> String {
    std::fs::read_to_string(s.home.join(file)).unwrap_or_default()
}

fn unlock(s: &Sandbox) {
    let mut u = Sandbox {
        home: s.home.clone(),
        env: s.env.clone(),
    };
    u.set_env("BW_PASSWORD", MASTER);
    let out = u.roster(&["vault", "unlock"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
}

#[test]
fn unlock_keeps_the_session_key_in_the_keyring_with_a_timeout() {
    let mut s = sandbox("bw-unlock", "bw:sw-01");
    s.set_env("BW_PASSWORD", MASTER);
    let out = s.roster(&["vault", "unlock"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("unlocked"), "{}", out.stdout);
    assert_eq!(
        read(&s, "bw.log"),
        "unlock --raw --passwordenv ROSTER_BW_MASTER --nointeraction\n"
    );
    assert_eq!(
        read(&s, "keyctl.log"),
        "--version\npadd user roster:bw-session @u\nsetperm 7000 0x3f0b0000\ntimeout 7000 43200\n"
    );
    assert_eq!(read(&s, ".fake-keyring/roster:bw-session"), SESSION);
    // Possessor: all; the owner's other processes (cron): view, read and
    // search only, so `roster sync` from cron can import; group, other: none.
    assert_eq!(read(&s, ".fake-keyring/perm"), "7000 0x3f0b0000\n");
}

#[test]
fn a_bw_reference_gives_the_login_password_through_askpass() {
    let s = sandbox("bw-password", "bw:sw-01");
    unlock(&s);
    let out = s.roster(&["ssh", "sw-01"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(&s, "askpass.got"), format!("{PASSWORD}\n"));
    assert!(
        read(&s, "bw.log").ends_with("get item sw-01 --nointeraction\n"),
        "{}",
        read(&s, "bw.log")
    );
    assert!(read(&s, "keyctl.log").ends_with("pipe %user:roster:bw-session\n"));
}

#[test]
fn a_field_is_the_username_notes_or_a_custom_field_exact_then_any_case() {
    for (name, field, want) in [
        ("bw-f-user", "username", "netops"),
        ("bw-f-notes", "notes", "rack 4"),
        ("bw-f-exact", "enable", "lower-made-up"),
        ("bw-f-exact2", "Enable", "en-made-up"),
        ("bw-f-case", "TOKEN", "tok-made-up"),
    ] {
        let s = sandbox(name, &format!("bw:sw-01#{field}"));
        unlock(&s);
        let out = s.roster(&["ssh", "sw-01"]);
        assert_eq!(out.code, 0, "{field}: {}", out.stderr);
        assert_eq!(read(&s, "askpass.got"), format!("{want}\n"), "{field}");
    }
}

#[test]
fn a_missing_field_or_item_stops_before_ssh() {
    for (name, auth, want) in [
        (
            "bw-no-field",
            "bw:sw-01#pin",
            "roster: sw-01: auth bw:sw-01#pin: item sw-01 has no pin\n",
        ),
        (
            "bw-no-pass",
            "bw:empty",
            "roster: sw-01: auth bw:empty: item empty has no password\n",
        ),
    ] {
        let s = sandbox(name, auth);
        unlock(&s);
        let out = s.roster(&["ssh", "sw-01"]);
        assert_eq!(out.code, 1, "{auth}");
        assert_eq!(out.stderr, want);
        assert_eq!(read(&s, "ssh.log"), "", "{auth}");
    }
    let s = sandbox("bw-no-item", "bw:sw-99");
    unlock(&s);
    let out = s.roster(&["ssh", "sw-01"]);
    assert_eq!(out.code, 1);
    assert!(
        out.stderr.contains("Not found.\n"),
        "bw's own: {}",
        out.stderr
    );
    assert!(
        out.stderr
            .contains("roster: sw-01: auth bw:sw-99: bw get failed"),
        "{}",
        out.stderr
    );
    assert_eq!(read(&s, "ssh.log"), "");
}

#[test]
fn locked_without_a_key_says_to_unlock_and_unlocks_for_this_run_only() {
    let mut s = sandbox("bw-locked", "bw:sw-01");
    s.set_env("BW_PASSWORD", MASTER);
    let out = s.roster(&["ssh", "sw-01"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stderr.contains("roster vault unlock"), "{}", out.stderr);
    assert_eq!(read(&s, "askpass.got"), format!("{PASSWORD}\n"));
    assert_eq!(
        read(&s, "keyctl.log"),
        "pipe %user:roster:bw-session\n",
        "nothing stored"
    );
}

#[test]
fn a_wrong_master_password_fails_and_stores_nothing() {
    let mut s = sandbox("bw-wrong", "bw:sw-01");
    s.set_env("BW_PASSWORD", "not-the-master");
    let out = s.roster(&["vault", "unlock"]);
    assert_eq!(out.code, 1);
    assert!(
        out.stderr.contains("Invalid master password."),
        "{}",
        out.stderr
    );
    assert!(
        out.stderr
            .contains("roster: vault unlock: bw unlock failed"),
        "{}",
        out.stderr
    );
    assert!(!read(&s, "keyctl.log").contains("padd"));
}

#[test]
fn an_empty_master_password_is_refused_before_bw_runs() {
    let mut s = sandbox("bw-empty", "bw:sw-01");
    s.set_env("BW_PASSWORD", "");
    let out = s.roster(&["vault", "unlock"]);
    assert_eq!(out.code, 1);
    assert!(
        out.stderr
            .contains("roster: vault unlock: no master password given"),
        "{}",
        out.stderr
    );
    assert!(!read(&s, "bw.log").contains("unlock"), "bw unlock ran");
    assert!(!read(&s, "keyctl.log").contains("padd"));
}

#[test]
fn lock_purges_the_key_and_locks_bw() {
    let s = sandbox("bw-lock", "bw:sw-01");
    unlock(&s);
    let out = s.roster(&["vault", "lock"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(read(&s, "keyctl.log").ends_with("purge user roster:bw-session\n"));
    assert!(read(&s, "bw.log").ends_with("lock --nointeraction\n"));
    assert!(!s.home.join(".fake-keyring/roster:bw-session").exists());
}

#[test]
fn the_legacy_session_file_is_never_read_and_unlock_and_lock_delete_it() {
    let mut s = sandbox("bw-legacy", "bw:sw-01");
    s.write(LEGACY, SESSION);
    s.set_env("BW_PASSWORD", "not-the-master"); // never ask on a test's tty
    let out = s.roster(&["ssh", "sw-01"]);
    assert_eq!(
        out.code, 1,
        "no key in the keyring, a wrong master password"
    );
    assert!(s.home.join(LEGACY).exists(), "a reference leaves it alone");
    assert_eq!(read(&s, "ssh.log"), "");
    s.set_env("BW_PASSWORD", MASTER);
    for action in ["unlock", "lock"] {
        s.write(LEGACY, SESSION);
        let out = s.roster(&["vault", action]);
        assert_eq!(out.code, 0, "{action}: {}", out.stderr);
        assert!(!s.home.join(LEGACY).exists(), "{action}");
        assert!(out.stdout.contains("deleted "), "{action}: {}", out.stdout);
    }
}

/// A PATH with the fakes and the tools they use, but no keyctl at all.
fn path_without_keyctl(s: &Sandbox) -> String {
    let bin = s.home.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let fakes = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fakes");
    for fake in ["bw", "ssh"] {
        std::os::unix::fs::symlink(fakes.join(fake), bin.join(fake)).unwrap();
    }
    for tool in ["sh", "grep", "env", "stat", "dirname"] {
        let real = ["/usr/bin", "/bin"].map(|d| std::path::Path::new(d).join(tool));
        let real = real.iter().find(|p| p.exists()).unwrap();
        std::os::unix::fs::symlink(real, bin.join(tool)).unwrap();
    }
    bin.display().to_string()
}

#[test]
fn without_keyctl_nothing_is_stored_and_each_run_asks() {
    let mut s = sandbox("bw-nokeyctl", "bw:sw-01");
    let path = path_without_keyctl(&s);
    s.set_env("PATH", &path);
    s.set_env("BW_PASSWORD", MASTER);
    let out = s.roster(&["vault", "unlock"]);
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("install keyutils"), "{}", out.stderr);
    assert_eq!(read(&s, "bw.log"), "", "no point unlocking");
    let out = s.roster(&["ssh", "sw-01"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stderr.contains("install keyutils"), "{}", out.stderr);
    assert_eq!(read(&s, "askpass.got"), format!("{PASSWORD}\n"));
    assert!(!s.home.join(".fake-keyring").exists());
}

#[test]
fn without_a_fake_vault_bw_is_a_tripwire() {
    let mut s = sandbox("bw-tripwire", "bw:sw-01");
    s.env.retain(|(k, _)| k != "FAKE_BW_ITEMS");
    s.set_env("BW_PASSWORD", MASTER);
    let out = s.roster(&["vault", "unlock"]);
    assert_eq!(out.code, 1);
    assert!(
        out.stderr.contains("fake bw: no fake vault configured"),
        "{}",
        out.stderr
    );
}

/// Every file under `dir`, recursively.
fn files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
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
fn hosts_sharing_a_reference_resolve_it_once_per_run() {
    let mut s = sandbox("bw-once", "bw:sw-01");
    let shared = "{ip: 127.0.0.1, port: 1, enroll: false, auth: \"bw:sw-01\"}";
    s.write(
        "roster.yml",
        &format!(
            "defaults: {{user: netops}}\ngroups:\n  net:\n    hosts:\n      \
             sw-01: {shared}\n      sw-02: {shared}\n      sw-03: {shared}\n"
        ),
    );
    s.set_env("BW_PASSWORD", MASTER);
    s.set_env("FAKE_SSH_RUN", "1");
    for args in [&["run", "net", "--", "true"][..], &["check", "net"]] {
        let _ = std::fs::remove_file(s.home.join("bw.log"));
        let out = s.roster(args);
        assert_eq!(
            read(&s, "bw.log"),
            "unlock --raw --passwordenv ROSTER_BW_MASTER --nointeraction\n\
             get item sw-01 --nointeraction\n",
            "{args:?}: {}",
            out.stderr
        );
    }
}

#[test]
fn the_session_key_and_master_password_never_leak() {
    let mut s = sandbox("bw-secrets", "bw:sw-01");
    s.set_env("BW_PASSWORD", MASTER);
    let mut outs = vec![s.roster(&["vault", "unlock"])];
    outs.push(s.roster(&["ssh", "sw-01", "--", "show", "run"]));
    outs.push(s.roster(&["vault", "lock"]));
    outs.push(s.roster(&["ssh", "sw-01"])); // locked: unlocks for this run
    for out in &outs {
        assert_eq!(out.code, 0, "{}", out.stderr);
        for secret in [MASTER, SESSION] {
            assert!(!out.stdout.contains(secret) && !out.stderr.contains(secret));
        }
    }
    assert_eq!(read(&s, "askpass.got"), format!("{PASSWORD}\n"));
    for log in ["bw.log", "keyctl.log", "ssh.log"] {
        assert!(!read(&s, log).is_empty(), "{log} was written");
    }
    for file in files(&s.home) {
        if file.starts_with(s.home.join(".fake-keyring")) {
            continue;
        }
        let bytes = std::fs::read(&file).unwrap();
        for secret in [MASTER, SESSION] {
            let hit = bytes.windows(secret.len()).any(|w| w == secret.as_bytes());
            assert!(!hit, "a secret is in {}", file.display());
        }
    }
}
