//! The one-time copy from roster-desk's places (Config dir `roster-desk/`, app-data dir
//! `dev.roster.desk/`) to roster's, made at start-up only when the new place is empty.

mod common;

use roster_core::migrate;
use std::fs;
use std::path::{Path, PathBuf};

/// A fresh, empty directory for one test.
fn temp_dir(name: &str) -> common::Temp {
    common::temp(&format!("migrate-{name}"))
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

#[test]
fn the_old_config_dir_is_copied_with_its_modules() {
    let base = temp_dir("config-copy");
    let (old, new) = (base.join("roster-desk"), base.join("roster"));
    write(&old.join("init.lua"), "return { theme = 'nord' }");
    write(&old.join("folders.yml"), "Lab: [esxi-01]\n");
    write(&old.join("lua/keys.lua"), "return {}");

    let copied = migrate::config(&old, &new).unwrap();

    assert_eq!(copied.len(), 3, "{copied:?}");
    assert_eq!(read(&new.join("init.lua")), "return { theme = 'nord' }");
    assert_eq!(read(&new.join("folders.yml")), "Lab: [esxi-01]\n");
    assert_eq!(read(&new.join("lua/keys.lua")), "return {}");
    // Copied, not moved: the old dir stays as a backup.
    assert!(old.join("init.lua").is_file());
}

#[test]
fn a_new_config_dir_that_only_has_rosters_inventory_still_gets_the_copy() {
    // ~/.config/roster/ can hold roster's own roster.yml; that isn't a Config.
    let base = temp_dir("config-shared-dir");
    let (old, new) = (base.join("roster-desk"), base.join("roster"));
    write(&old.join("init.lua"), "return {}");
    write(&new.join("roster.yml"), "hosts: {}\n");

    let copied = migrate::config(&old, &new).unwrap();

    assert_eq!(copied, vec![new.join("init.lua")]);
    assert_eq!(read(&new.join("roster.yml")), "hosts: {}\n");
}

#[test]
fn an_existing_config_is_never_touched() {
    let base = temp_dir("config-exists");
    let (old, new) = (base.join("roster-desk"), base.join("roster"));
    write(&old.join("init.lua"), "return { theme = 'old' }");
    write(&old.join("extra.lua"), "return {}");
    write(&new.join("init.lua"), "return { theme = 'new' }");

    assert!(migrate::config(&old, &new).unwrap().is_empty());
    assert_eq!(read(&new.join("init.lua")), "return { theme = 'new' }");
    assert!(!new.join("extra.lua").exists());

    // folders.yml alone also counts as a Config.
    let other = base.join("other");
    write(&other.join("folders.yml"), "{}\n");
    assert!(migrate::config(&old, &other).unwrap().is_empty());
    assert!(!other.join("init.lua").exists());
}

#[test]
fn no_old_config_dir_means_nothing_to_do() {
    let base = temp_dir("config-none");
    let new = base.join("roster");
    assert!(migrate::config(&base.join("roster-desk"), &new).unwrap().is_empty());
    assert!(!new.exists(), "the new dir isn't created for nothing");
}

#[test]
fn the_config_copy_happens_once() {
    let base = temp_dir("config-once");
    let (old, new) = (base.join("roster-desk"), base.join("roster"));
    write(&old.join("init.lua"), "return {}");
    assert_eq!(migrate::config(&old, &new).unwrap().len(), 1);
    write(&old.join("later.lua"), "return {}");
    assert!(migrate::config(&old, &new).unwrap().is_empty());
    assert!(!new.join("later.lua").exists());
}

#[test]
fn the_old_state_dir_sits_next_to_the_new_one() {
    let new = Path::new("/home/me/.local/share/dev.roster.app");
    assert_eq!(
        migrate::legacy_state_dir(new),
        Some(PathBuf::from("/home/me/.local/share/dev.roster.desk"))
    );
    assert_eq!(migrate::legacy_state_dir(Path::new("/")), None);
}

#[test]
fn the_old_state_is_copied_when_there_is_none() {
    let base = temp_dir("state-copy");
    let (old, new) = (base.join("dev.roster.desk"), base.join("dev.roster.app"));
    write(&old.join("state.json"), r#"{"recentHosts":["esxi-02"]}"#);

    assert!(migrate::state(&old, &new).unwrap());
    assert_eq!(read(&new.join("state.json")), r#"{"recentHosts":["esxi-02"]}"#);
    assert!(old.join("state.json").is_file());
    // Once there's a State, it's never replaced.
    write(&old.join("state.json"), "{}");
    assert!(!migrate::state(&old, &new).unwrap());
    assert_eq!(read(&new.join("state.json")), r#"{"recentHosts":["esxi-02"]}"#);
}

#[test]
fn an_existing_or_missing_state_is_left_alone() {
    let base = temp_dir("state-exists");
    let (old, new) = (base.join("dev.roster.desk"), base.join("dev.roster.app"));
    assert!(!migrate::state(&old, &new).unwrap());
    assert!(!new.exists());
    write(&old.join("state.json"), r#"{"a":1}"#);
    write(&new.join("state.json"), r#"{"b":2}"#);
    assert!(!migrate::state(&old, &new).unwrap());
    assert_eq!(read(&new.join("state.json")), r#"{"b":2}"#);
}
