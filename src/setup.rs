//! `roster setup`: make this Box ready to reach the Hosts.

use crate::inventory::Inventory;
use crate::{Fail, atomic, claude, sshconf};
use std::path::PathBuf;
use std::process::Command;

/// Run every setup step in order; each is idempotent and prints what it changed.
/// A new step (ROSTER.md, the Host side) is one more line here.
pub fn run(inv: &Inventory) -> Result<(), Fail> {
    box_key(inv)?;
    ssh_config(inv)?;
    claude_files(inv)?;
    Ok(())
}

/// `~/...` made absolute with $HOME.
pub fn expand(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(path),
    }
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn failed(what: impl std::fmt::Display) -> Fail {
    Fail {
        code: 1,
        msg: what.to_string(),
    }
}

/// Make the Box key with ssh-keygen unless it exists.
fn box_key(inv: &Inventory) -> Result<(), Fail> {
    let key = expand(&inv.key_path);
    if key.exists() {
        return Ok(());
    }
    if let Some(dir) = key.parent() {
        mkdir_private(dir)?;
    }
    let (alg, bits) = match inv.key_type.split_once('-') {
        Some((alg, bits)) => (alg, Some(bits)),
        None if inv.key_type == "ecdsa" => ("ecdsa", Some("384")),
        None if inv.key_type == "rsa" => ("rsa", Some("3072")),
        None => (inv.key_type.as_str(), None),
    };
    let mut cmd = Command::new("ssh-keygen");
    cmd.args(["-q", "-t", alg]);
    if let Some(bits) = bits {
        cmd.args(["-b", bits]);
    }
    let comment = format!("roster-managed:{}", inv.box_name);
    cmd.args(["-N", "", "-C", &comment, "-f"]).arg(&key);
    match cmd.status() {
        Ok(s) if s.success() => {
            println!("made the Box key {}", key.display());
            Ok(())
        }
        Ok(s) => Err(failed(format!(
            "ssh-keygen failed ({s}) making {}",
            key.display()
        ))),
        Err(e) => Err(failed(format!("can't run ssh-keygen: {e}"))),
    }
}

/// Write `~/.ssh/config.d/roster` and include it from `~/.ssh/config`.
fn ssh_config(inv: &Inventory) -> Result<(), Fail> {
    let dir = home().join(".ssh/config.d");
    mkdir_private(&dir)?;
    let path = dir.join("roster");
    let from = std::fs::canonicalize(&inv.path).unwrap_or(inv.path.clone());
    save(&path, &sshconf::render(inv, &from), 0o600)?;
    let config = home().join(".ssh/config");
    let old = read(&config)?.unwrap_or_default();
    if let Some(new) = sshconf::with_include(&old, &path) {
        save(&config, &new, 0o600)?;
    }
    Ok(())
}

/// ROSTER.md, the CLAUDE.md import and the Claude settings, beside roster.yml.
fn claude_files(inv: &Inventory) -> Result<(), Fail> {
    let yml = std::fs::canonicalize(&inv.path).unwrap_or(inv.path.clone());
    let dir = yml.parent().unwrap_or(std::path::Path::new("."));
    save(&dir.join("ROSTER.md"), &claude::roster_md(inv), 0o644)?;
    let md = dir.join("CLAUDE.md");
    if let Some(text) = claude::with_import(&read(&md)?.unwrap_or_default()) {
        save(&md, &text, 0o644)?;
    }
    let settings = dir.join(".claude/settings.json");
    match claude::with_deny(read(&settings)?.as_deref()) {
        Ok(None) => {}
        Ok(Some(text)) => {
            std::fs::create_dir_all(dir.join(".claude"))
                .map_err(|e| failed(format!("{}: {e}", dir.display())))?;
            save(&settings, &text, 0o644)?;
        }
        Err(()) => eprintln!(
            "roster: warning: {} isn't valid JSON; left it alone",
            settings.display()
        ),
    }
    Ok(())
}

/// A file's text, or None when it's missing.
fn read(path: &std::path::Path) -> Result<Option<String>, Fail> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(failed(format!("{}: {e}", path.display()))),
    }
}

/// Atomically write `path` if its contents differ, and say so.
fn save(path: &std::path::Path, contents: &str, mode: u32) -> Result<(), Fail> {
    match atomic::update(path, contents, mode) {
        Ok(true) => {
            println!("wrote {}", path.display());
            Ok(())
        }
        Ok(false) => Ok(()),
        Err(e) => Err(failed(format!("{}: {e}", path.display()))),
    }
}

/// Create `dir` (and its parents) with mode 0700 if it's missing.
fn mkdir_private(dir: &std::path::Path) -> Result<(), Fail> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| failed(format!("{}: {e}", dir.display())))
}
