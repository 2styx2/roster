mod common;
use common::Sandbox;

#[test]
fn dash_h_prints_usage_and_exits_0() {
    let s = Sandbox::new("usage-h");
    let out = s.roster(&["-h"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.starts_with("usage: roster"), "{}", out.stdout);
    assert!(out.stdout.contains("ls [--json]"), "{}", out.stdout);
}

/// Bare `roster` prints usage, like `-h`; the picker is `roster pick`. No
/// Inventory is needed, and nothing runs.
#[test]
fn bare_roster_prints_usage_and_exits_0() {
    let s = Sandbox::new("usage-bare");
    let out = s.roster(&[]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.starts_with("usage: roster"), "{}", out.stdout);
    assert!(out.stdout.contains("  pick "), "{}", out.stdout);
    assert!(!s.home.join("fzf.log").exists(), "fzf ran");
}

#[test]
fn unknown_flag_is_a_usage_error() {
    let s = Sandbox::new("usage-bad-flag");
    let out = s.roster(&["ls", "--bogus"]);
    assert_eq!(out.code, 2);
    assert!(out.stderr.contains("--bogus"), "{}", out.stderr);
    assert!(out.stderr.contains("roster -h"), "{}", out.stderr);
    assert_eq!(out.stdout, "");
}

#[test]
fn version_prints_the_version_and_exits_0() {
    // The rewrite carries on the Python roster's numbering (v0.7.0).
    let s = Sandbox::new("usage-version");
    for args in [&["--version"][..], &["-V"], &["version"]] {
        let out = s.roster(args);
        assert_eq!(out.code, 0, "{args:?}: {}", out.stderr);
        assert_eq!(out.stdout, "roster 0.7.9\n", "{args:?}");
    }
}

#[test]
fn unknown_command_is_a_usage_error() {
    let s = Sandbox::new("usage-bad-cmd");
    let out = s.roster(&["frobnicate"]);
    assert_eq!(out.code, 2);
    assert!(out.stderr.contains("frobnicate"), "{}", out.stderr);
}
