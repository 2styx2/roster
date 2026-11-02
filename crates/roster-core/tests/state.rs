//! The State file (GLOSSARY: State): what the app remembers on its own between runs, as one JSON
//! object in the app-data dir. Never Config, never secrets.

mod common;

use roster_core::state::StateFile;
use serde_json::json;
use std::path::PathBuf;

/// A directory for one test that doesn't exist yet, and the temp folder it's in (deleted when the
/// test drops it).
fn temp_dir(name: &str) -> (common::Temp, PathBuf) {
    let tmp = common::temp(&format!("state-{name}"));
    let dir = tmp.join("app-data");
    (tmp, dir)
}

#[test]
fn starts_empty_when_there_is_no_file_yet() {
    let (_tmp, dir) = temp_dir("missing");
    let state = StateFile::in_dir(&dir);
    assert_eq!(state.load(), json!({}));
}

#[test]
fn saves_and_loads_back_creating_the_directory() {
    let (_tmp, dir) = temp_dir("roundtrip");
    let dir = dir.join("nested");
    let state = StateFile::in_dir(&dir);
    let value = json!({"version": 1, "recentHosts": ["web-1", "db-2"]});
    state.save(&value).unwrap();
    assert_eq!(StateFile::in_dir(&dir).load(), value);
    assert!(dir.join("state.json").is_file());
}

#[test]
fn a_save_replaces_the_whole_state_and_leaves_no_temp_file() {
    let (_tmp, dir) = temp_dir("replace");
    let state = StateFile::in_dir(&dir);
    state.save(&json!({"a": 1, "b": 2})).unwrap();
    state.save(&json!({"b": 3})).unwrap();
    assert_eq!(state.load(), json!({"b": 3}));
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["state.json"]);
}

#[test]
fn a_corrupt_file_is_kept_aside_and_the_app_starts_empty() {
    let (_tmp, dir) = temp_dir("corrupt");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("state.json"), "{not json").unwrap();
    let state = StateFile::in_dir(&dir);
    assert_eq!(state.load(), json!({}));
    assert_eq!(
        std::fs::read_to_string(dir.join("state.json.bad")).unwrap(),
        "{not json"
    );
}

#[test]
fn only_an_object_of_reasonable_size_is_saved() {
    let (_tmp, dir) = temp_dir("refuse");
    let state = StateFile::in_dir(&dir);
    assert!(state.save(&json!(["not", "an", "object"])).is_err());
    let huge = "x".repeat(2 * 1024 * 1024);
    assert!(state.save(&json!({ "big": huge })).is_err());
    assert_eq!(state.load(), json!({}));
}
