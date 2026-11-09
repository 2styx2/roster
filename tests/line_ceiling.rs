//! scripts/line-ceiling.sh: CI fails when the source grows past the ceiling.
use std::path::Path;
use std::process::Command;

fn run(src: &Path, ceiling: &str) -> (i32, String) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/line-ceiling.sh");
    let out = Command::new("sh")
        .arg(script)
        .arg(src)
        .env("LINE_CEILING", ceiling)
        .output()
        .unwrap();
    (
        out.status.code().unwrap(),
        String::from_utf8(out.stdout).unwrap(),
    )
}

fn source_tree(name: &str) -> std::path::PathBuf {
    let src = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&src);
    std::fs::create_dir_all(src.join("sub")).unwrap();
    // 2 counted lines: blank lines and comments don't count.
    std::fs::write(src.join("a.rs"), "// note\n\nfn a() {\n    /// doc\n}\n").unwrap();
    // 2 counted lines in an embedded script; the shebang is a comment.
    std::fs::write(
        src.join("sub/b.sh"),
        "#!/bin/sh\n# note\nset -eu\n\necho hi\n",
    )
    .unwrap();
    std::fs::write(src.join("notes.txt"), "not code\n").unwrap();
    src
}

#[test]
fn counts_non_blank_non_comment_lines_of_rust_and_scripts() {
    let src = source_tree("ceiling-under");
    let (code, stdout) = run(&src, "4");
    assert_eq!(code, 0, "{stdout}");
    assert!(stdout.contains("4 of 4"), "{stdout}");
}

#[test]
fn fails_above_the_ceiling() {
    let src = source_tree("ceiling-over");
    let (code, stdout) = run(&src, "3");
    assert_eq!(code, 1, "{stdout}");
    assert!(stdout.contains("4 of 3"), "{stdout}");
}
