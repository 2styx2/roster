//! Where the Inventory comes from, and what happens when it won't load.
mod common;
use common::Sandbox;

/// An Inventory with one Host, named so the test can tell which file was read.
fn one_host(name: &str) -> String {
    format!("defaults: {{user: admin}}\ngroups:\n  dev:\n    hosts:\n      {name}: 10.0.0.5\n")
}

fn listed(s: &Sandbox, args: &[&str]) -> String {
    let out = s.roster(args);
    assert_eq!(out.code, 0, "{}", out.stderr);
    out.stdout
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}

#[test]
fn dash_c_beats_env_beats_cwd_beats_home() {
    let mut s = Sandbox::new("lookup-order");
    s.write(".config/roster/roster.yml", &one_host("from-home"));
    assert_eq!(listed(&s, &["ls"]), "from-home");

    s.write("roster.yml", &one_host("from-cwd"));
    assert_eq!(listed(&s, &["ls"]), "from-cwd");

    let env = s.write("env/roster.yml", &one_host("from-env"));
    s.set_env("ROSTER_CONFIG", env.to_str().unwrap());
    assert_eq!(listed(&s, &["ls"]), "from-env");

    s.write("flag.yml", &one_host("from-flag"));
    assert_eq!(listed(&s, &["-c", "flag.yml", "ls"]), "from-flag");
    assert_eq!(listed(&s, &["ls", "-c", "flag.yml"]), "from-flag");
}

#[test]
fn no_inventory_exits_3_naming_the_files_tried() {
    let s = Sandbox::new("lookup-none");
    let out = s.roster(&["ls"]);
    assert_eq!(out.code, 3);
    assert_eq!(
        out.stderr,
        format!(
            "roster: no Inventory: there's no ./roster.yml or {}/.config/roster/roster.yml\n  \
             hint: write one there, or name one with -c FILE or ROSTER_CONFIG=FILE\n",
            s.home.display()
        )
    );
}

#[test]
fn missing_dash_c_file_exits_3_naming_it() {
    let s = Sandbox::new("lookup-missing");
    let out = s.roster(&["-c", "nope.yml", "ls"]);
    assert_eq!(out.code, 3);
    assert_eq!(
        out.stderr,
        "roster: nope.yml: no such file or directory\n  hint: -c FILE or \
         ROSTER_CONFIG=FILE names the Inventory; without them, roster reads ./roster.yml, \
         else ~/.config/roster/roster.yml\n"
    );
}

#[test]
fn broken_yaml_exits_3_naming_the_file_and_line() {
    let s = Sandbox::new("lookup-broken");
    s.write("roster.yml", "groups:\n  dev:\n    hosts: [unclosed\n");
    let out = s.roster(&["ls"]);
    assert_eq!(out.code, 3);
    assert_eq!(
        out.stderr,
        "roster: roster.yml:4: not valid YAML: did not find expected ',' or ']', \
         while parsing a flow sequence\n"
    );
    assert_eq!(out.stdout, "");
}

#[test]
fn host_without_ip_exits_3() {
    let s = Sandbox::new("lookup-no-ip");
    s.write(
        "roster.yml",
        "groups:\n  dev:\n    hosts:\n      box-a: {user: admin}\n",
    );
    let out = s.roster(&["ls"]);
    assert_eq!(out.code, 3);
    assert!(out.stderr.contains("box-a"), "{}", out.stderr);
}
