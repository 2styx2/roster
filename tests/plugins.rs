//! `roster NAME ARGS` runs `roster-NAME` from PATH, git style.
mod common;
use common::Sandbox;

fn log(s: &Sandbox) -> String {
    std::fs::read_to_string(s.home.join("hello.log")).unwrap()
}

#[test]
fn plugin_gets_its_args_and_the_plugin_env() {
    let s = Sandbox::new("plugin-exec");
    let inv = s.write("roster.yml", "groups: {}\n");
    let out = s.roster(&["hello", "box-a", "--json", "-c", "x"]);
    assert_eq!(out.code, 7, "{}", out.stderr);
    assert_eq!(out.stdout, "hello from plugin\n");
    let log = log(&s);
    assert!(log.contains("argv: box-a --json -c x\n"), "{log}");
    let resolved = std::fs::canonicalize(&inv).unwrap();
    assert!(
        log.contains(&format!("ROSTER_CONFIG={}\n", resolved.display())),
        "{log}"
    );
    let bin = std::fs::canonicalize(env!("CARGO_BIN_EXE_roster")).unwrap();
    assert!(
        log.contains(&format!("ROSTER_BIN={}\n", bin.display())),
        "{log}"
    );
}

#[test]
fn dash_c_before_the_name_sets_roster_config() {
    let s = Sandbox::new("plugin-dash-c");
    let inv = s.write("other.yml", "groups: {}\n");
    let out = s.roster(&["-c", "other.yml", "hello"]);
    assert_eq!(out.code, 7, "{}", out.stderr);
    let resolved = std::fs::canonicalize(&inv).unwrap();
    let log = log(&s);
    assert!(
        log.contains(&format!("ROSTER_CONFIG={}\n", resolved.display())),
        "{log}"
    );
}

#[test]
fn no_inventory_leaves_roster_config_unset() {
    let s = Sandbox::new("plugin-no-inventory");
    let out = s.roster(&["hello"]);
    assert_eq!(out.code, 7, "{}", out.stderr);
    let log = log(&s);
    assert!(log.contains("ROSTER_CONFIG=unset\n"), "{log}");
}

#[test]
fn a_name_not_built_in_nor_on_path_is_a_usage_error() {
    let s = Sandbox::new("plugin-missing");
    let out = s.roster(&["nosuch", "arg"]);
    assert_eq!(out.code, 2);
    assert!(out.stderr.contains("roster-nosuch"), "{}", out.stderr);
    assert!(out.stderr.contains("roster -h"), "{}", out.stderr);
    assert_eq!(out.stdout, "");
}

#[test]
fn a_built_in_wins_over_a_shadowing_plugin_with_a_warning() {
    use std::os::unix::fs::PermissionsExt;
    let mut s = Sandbox::new("plugin-shadow");
    s.write(
        "roster.yml",
        "groups:\n  dev:\n    hosts:\n      box-a: 10.0.0.5\n",
    );
    let fake = s.write("bin/roster-ls", "#!/bin/sh\necho shadow\n");
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:/usr/bin:/bin", s.home.join("bin").display());
    s.set_env("PATH", &path);
    let out = s.roster(&["ls"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.starts_with("box-a"), "{}", out.stdout);
    assert!(out.stderr.contains("roster-ls"), "{}", out.stderr);
    assert!(out.stderr.contains("built-in"), "{}", out.stderr);
}
