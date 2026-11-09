//! `contrib/roster.bash`: Tab completion, with Host and group names read from
//! `roster ls` at each Tab. Runs the real binary against a made-up Inventory.
mod common;
use common::Sandbox;
use std::path::Path;

const INVENTORY: &str = "\
defaults: {user: admin}
groups:
  dev:
    hosts:
      box-a: 10.0.0.5
      box-b: 10.0.0.6
  gear:
    hosts:
      esx-02: 10.0.0.8
";

/// A sandbox with the built `roster` first on PATH.
fn sandbox(name: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    std::fs::create_dir_all(s.home.join("bin")).unwrap();
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_roster"), s.home.join("bin/roster")).unwrap();
    let path = format!("{}:/usr/bin:/bin", s.home.join("bin").display());
    s.set_env("PATH", &path);
    s
}

/// COMPREPLY, sorted, after Tab at the end of `line` (a trailing space
/// starts a new, empty word).
fn complete(s: &Sandbox, line: &str) -> Vec<String> {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("contrib/roster.bash");
    let words: Vec<String> = line.split(' ').map(|w| format!("'{w}'")).collect();
    let cmd = format!(
        "source '{}' || exit 9; COMP_WORDS=({}); COMP_CWORD={}; _roster; \
         printf '%s\\n' \"${{COMPREPLY[@]}}\"",
        script.display(),
        words.join(" "),
        words.len() - 1
    );
    let out = s.run(
        Path::new("/bin/bash"),
        &["--norc", "--noprofile", "-c", &cmd],
    );
    assert_eq!((out.code, out.stderr.as_str()), (0, ""), "{line}");
    let mut got: Vec<String> = out
        .stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(Into::into)
        .collect();
    got.sort();
    got
}

#[test]
fn the_first_word_completes_commands_hosts_and_groups() {
    let s = sandbox("complete-first");
    s.write("roster.yml", INVENTORY);
    assert_eq!(complete(&s, "roster s"), ["setup", "ssh", "sync"]);
    assert_eq!(complete(&s, "roster b"), ["box-a", "box-b"]);
    assert_eq!(complete(&s, "roster -"), ["-c", "-h"]);
}

#[test]
fn hosts_and_groups_come_from_roster_ls_at_each_tab() {
    let s = sandbox("complete-names");
    s.write("roster.yml", INVENTORY);
    assert_eq!(
        complete(&s, "roster ssh "),
        ["box-a", "box-b", "dev", "esx-02", "gear"]
    );
    assert_eq!(complete(&s, "roster check g"), ["gear"]);
    s.write(
        "roster.yml",
        &format!("{INVENTORY}      esx-03: 10.0.0.9\n"),
    );
    assert_eq!(complete(&s, "roster run esx"), ["esx-02", "esx-03"]);
}

#[test]
fn flags_are_per_command() {
    let s = sandbox("complete-flags");
    s.write("roster.yml", INVENTORY);
    assert_eq!(complete(&s, "roster ls --"), ["--json", "--long"]);
    assert_eq!(complete(&s, "roster setup --"), ["--dry-run", "--undo"]);
    assert_eq!(complete(&s, "roster web -"), ["-H", "-d", "-k"]);
    assert_eq!(complete(&s, "roster vault "), ["lock", "unlock"]);
}

#[test]
fn dash_c_names_the_inventory_roster_ls_reads() {
    let s = sandbox("complete-dash-c");
    s.write("other/inv.yml", INVENTORY);
    assert_eq!(complete(&s, "roster -c other/inv.yml web e"), ["esx-02"]);
}

#[test]
fn an_inventory_that_will_not_load_completes_no_names_quietly() {
    let s = sandbox("complete-broken");
    s.write("roster.yml", "groups: [");
    assert!(complete(&s, "roster ssh ").is_empty());
}
