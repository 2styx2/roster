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
