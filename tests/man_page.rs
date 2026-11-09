//! roster.1 is the reference: every command, flag, exit code and JSON field
//! a ticket adds goes in this list and in the man page.
mod common;

const DOCUMENTED: &[&str] = &[
    // commands and flags
    ".B ls",
    "\\-\\-json",
    "\\-c ",
    "\\-h",
    // Inventory lookup
    "ROSTER_CONFIG",
    "~/.config/roster/roster.yml",
    // exit codes
    ".SH EXIT STATUS",
    "Usage error",
    "won't load",
    // ls --json fields
    "\"v\": 1",
    "name",
    "group",
    "ip",
    "user",
    "access",
    "title",
];

#[test]
fn man_page_covers_the_surface() {
    let page = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/roster.1")).unwrap();
    let missing: Vec<_> = DOCUMENTED.iter().filter(|t| !page.contains(*t)).collect();
    assert!(missing.is_empty(), "roster.1 lacks {missing:?}");
}

#[test]
fn usage_points_at_the_man_page() {
    let out = common::Sandbox::new("man-usage").roster(&["-h"]);
    assert!(out.stdout.contains("roster(1)"), "{}", out.stdout);
}
