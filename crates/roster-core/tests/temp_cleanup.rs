//! Tests leave nothing in the temp dir (ticket 109): on 2026-11-01 about 37k `roster-core-*` folders
//! from earlier runs filled /tmp's inodes. Every test that needs a folder takes one from
//! `common::temp`, a guard that deletes it on drop, panic or not. CI also counts what a whole
//! `cargo test` leaves behind (`.github/workflows/ci.yml`).

mod common;

use std::path::{Path, PathBuf};

/// Points the temp dir at `dir` for this process. This file has a single test, so no other
/// thread reads the environment meanwhile.
fn use_temp_dir(dir: &Path) {
    for var in ["TMPDIR", "TMP", "TEMP"] {
        // SAFETY: the only test in this binary, so nothing else touches the environment.
        unsafe { std::env::set_var(var, dir) };
    }
    assert_eq!(std::env::temp_dir(), dir, "the temp dir follows TMPDIR/TMP/TEMP");
}

fn entries(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect()
}

/// The only test in this file: it changes the process's environment.
#[test]
fn test_folders_are_removed_when_the_test_ends_or_panics() {
    // No test reaches for the temp dir itself: a bare `std::env::temp_dir().join(..)` is never
    // deleted (the bug above).
    let tests = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut offenders = Vec::new();
    for path in entries(&tests) {
        if path.extension().is_some_and(|e| e == "rs") && path.file_name().unwrap() != "temp_cleanup.rs" {
            let text = std::fs::read_to_string(&path).unwrap();
            if text.contains("temp_dir()") {
                offenders.push(path.file_name().unwrap().to_string_lossy().into_owned());
            }
        }
    }
    assert_eq!(offenders, Vec::<String>::new(), "use common::temp instead");

    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("temp-cleanup-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    use_temp_dir(&root);

    // A test that passes: a nested folder with files, a git repo's worth of depth.
    {
        let dir = common::temp("config");
        assert!(dir.starts_with(&root));
        assert!(
            dir.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("roster-core-config-")
        );
        std::fs::create_dir_all(dir.join("plugins/boxed/.git")).unwrap();
        std::fs::write(dir.join("init.lua"), "return {}").unwrap();
        std::fs::write(dir.join("plugins/boxed/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        assert_eq!(entries(&root).len(), 1);
    }
    assert_eq!(
        entries(&root),
        Vec::<PathBuf>::new(),
        "a passing test's folder is left behind"
    );

    // Two at once get different folders.
    let (a, b) = (common::temp("plugin"), common::temp("plugin"));
    assert_ne!(*a, *b);
    drop((a, b));

    // A test that panics halfway.
    let made = std::thread::spawn(|| {
        let dir = common::temp("network");
        std::fs::write(dir.join("roster-plugin.lua"), "return {}").unwrap();
        panic!("a failing assertion");
    })
    .join();
    assert!(made.is_err());
    assert_eq!(
        entries(&root),
        Vec::<PathBuf>::new(),
        "a panicking test's folder is left behind"
    );

    std::fs::remove_dir_all(&root).unwrap();
}
