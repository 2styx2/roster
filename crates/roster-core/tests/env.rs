//! The development env vars: ROSTER_APP_* names, with the roster-desk era's ROSTER_DESK_* names
//! still read as fallbacks.

use roster_core::env::var_or_legacy;
use roster_core::env::{DISTRO_VAR, LEGACY_DISTRO_VAR, LEGACY_OVERRIDE_VAR, OVERRIDE_VAR};

fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
    move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
}

#[test]
fn the_names_are_the_roster_app_ones_with_the_old_ones_as_fallbacks() {
    assert_eq!(OVERRIDE_VAR, "ROSTER_APP_ROSTER");
    assert_eq!(DISTRO_VAR, "ROSTER_APP_WSL_DISTRO");
    assert_eq!(LEGACY_OVERRIDE_VAR, "ROSTER_DESK_ROSTER");
    assert_eq!(LEGACY_DISTRO_VAR, "ROSTER_DESK_WSL_DISTRO");
}

#[test]
fn the_new_name_wins_over_the_old_one() {
    let e = env(&[
        ("ROSTER_APP_ROSTER", "roster-new"),
        ("ROSTER_DESK_ROSTER", "roster-old"),
    ]);
    assert_eq!(
        var_or_legacy(OVERRIDE_VAR, LEGACY_OVERRIDE_VAR, e).as_deref(),
        Some("roster-new")
    );
}

#[test]
fn the_old_name_still_works_alone() {
    let e = env(&[("ROSTER_DESK_WSL_DISTRO", "Ubuntu")]);
    assert_eq!(
        var_or_legacy(DISTRO_VAR, LEGACY_DISTRO_VAR, e).as_deref(),
        Some("Ubuntu")
    );
}

#[test]
fn blank_values_do_not_count() {
    let e = env(&[("ROSTER_APP_ROSTER", "  "), ("ROSTER_DESK_ROSTER", "uv run roster")]);
    assert_eq!(
        var_or_legacy(OVERRIDE_VAR, LEGACY_OVERRIDE_VAR, e).as_deref(),
        Some("uv run roster")
    );
    let e = env(&[("ROSTER_APP_ROSTER", ""), ("ROSTER_DESK_ROSTER", "")]);
    assert_eq!(var_or_legacy(OVERRIDE_VAR, LEGACY_OVERRIDE_VAR, e), None);
    assert_eq!(var_or_legacy(OVERRIDE_VAR, LEGACY_OVERRIDE_VAR, env(&[])), None);
}

#[test]
fn the_state_dir_can_be_moved_for_a_test_copy() {
    use roster_core::env::{STATE_DIR_VAR, state_dir_for};
    use std::path::PathBuf;
    assert_eq!(STATE_DIR_VAR, "ROSTER_APP_STATE_DIR");
    let set = env(&[("ROSTER_APP_STATE_DIR", r"C:\perf\state")]);
    assert_eq!(state_dir_for(set), Some(PathBuf::from(r"C:\perf\state")));
    assert_eq!(state_dir_for(env(&[])), None);
    assert_eq!(state_dir_for(env(&[("ROSTER_APP_STATE_DIR", "  ")])), None);
}
