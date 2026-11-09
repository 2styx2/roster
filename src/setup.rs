//! `roster setup`: make this Box ready to reach the Hosts.

use crate::inventory::Inventory;
use crate::{Fail, atomic, claude, hosts, mesh, sshconf, undo};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

/// `--dry-run`: say what would change, change nothing.
static DRY: AtomicBool = AtomicBool::new(false);

pub fn dry() -> bool {
    DRY.load(Ordering::Relaxed)
}

/// Run every setup step in order; each is idempotent and prints what it changed.
/// A new step is one more line here.
/// With `undo`, remove what these steps made instead (`undo::run`).
pub fn run(inv: &Inventory, dry_run: bool, undo: bool) -> Result<(), Fail> {
    DRY.store(dry_run, Ordering::Relaxed);
    if undo {
        return undo::run(inv);
    }
    box_keys(inv)?;
    box_files(inv)?;
    let (ready, undone) = hosts::run(inv, dry_run)?;
    match undone + mesh::run(inv, &ready, dry_run) {
        0 => Ok(()),
        n => Err(failed(format!(
            "{n} Host{} not done; run `roster setup` again to finish",
            if n == 1 { "" } else { "s" }
        ))),
    }
}

/// `roster sync`: the Box files only (ssh config, Include, ROSTER.md and the
/// Claude files). No Host is contacted and no key is made.
pub fn box_files(inv: &Inventory) -> Result<(), Fail> {
    warn_duplicates(inv);
    ssh_config(inv)?;
    claude_files(inv)
}

/// Say so when several Hosts are one login (the same address, port and
/// user), say from a hand edit: `add` and the vault import refuse them, but
/// roster.yml is still the user's file. Another user is another login.
fn warn_duplicates(inv: &Inventory) {
    /// One login: address (lowercase), port, user.
    type Login<'a> = (String, u16, &'a str);
    let mut seen: Vec<(Login, Vec<&str>)> = Vec::new();
    for h in &inv.hosts {
        let login = (h.ip.to_lowercase(), h.port, h.user.as_str());
        match seen.iter_mut().find(|(l, _)| *l == login) {
            Some((_, names)) => names.push(&h.name),
            None => seen.push((login, vec![&h.name])),
        }
    }
    for ((ip, port, user), names) in seen.iter().filter(|(_, n)| n.len() > 1) {
        eprintln!(
            "roster: duplicate Hosts: {} are all {ip}:{port} as {user}; keep one",
            names.join(", ")
        );
    }
}

/// ssh-keygen's `-t TYPE [-b BITS]` for a canonical key type.
pub fn keygen_args(key_type: &str) -> Vec<&str> {
    let (alg, bits) = match key_type.split_once('-') {
        Some((alg, bits)) => (alg, Some(bits)),
        None if key_type == "ecdsa" => ("ecdsa", Some("384")),
        None if key_type == "rsa" => ("rsa", Some("3072")),
        None => (key_type, None),
    };
    let mut args = vec!["-t", alg];
    if let Some(bits) = bits {
        args.extend(["-b", bits]);
    }
    args
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

pub fn failed(what: impl std::fmt::Display) -> Fail {
    Fail {
        code: 1,
        msg: what.to_string(),
    }
}

/// Make the Box key of each key type an Enrolled Host uses, unless it exists.
fn box_keys(inv: &Inventory) -> Result<(), Fail> {
    let mut made = Vec::new();
    for h in inv.hosts.iter().filter(|h| h.enroll) {
        if !made.contains(&&h.key_type) {
            made.push(&h.key_type);
            box_key(&expand(&inv.key_of(h)), &h.key_type, &inv.box_name)?;
        }
    }
    Ok(())
}

/// Make the Box key `key` of type `key_type` with ssh-keygen unless it exists.
fn box_key(key: &std::path::Path, key_type: &str, box_name: &str) -> Result<(), Fail> {
    if key.exists() {
        return Ok(());
    }
    if dry() {
        println!("would make the Box key {}", key.display());
        return Ok(());
    }
    if let Some(dir) = key.parent() {
        mkdir_private(dir)?;
    }
    let mut cmd = Command::new("ssh-keygen");
    cmd.arg("-q").args(keygen_args(key_type));
    let comment = format!("roster-managed:{box_name}");
    cmd.args(["-N", "", "-C", &comment, "-f"]).arg(key);
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
    let dir = &beside_inventory(inv);
    save(&dir.join("ROSTER.md"), &claude::roster_md(inv), 0o644)?;
    let md = dir.join("CLAUDE.md");
    if let Some(text) = claude::with_import(&read(&md)?.unwrap_or_default()) {
        save(&md, &text, 0o644)?;
    }
    let settings = dir.join(".claude/settings.json");
    match claude::with_deny(read(&settings)?.as_deref()) {
        Ok(None) => {}
        Ok(Some(_)) if dry() => println!("would write {}", settings.display()),
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

/// The directory roster.yml is in, where ROSTER.md and the Claude files go.
pub fn beside_inventory(inv: &Inventory) -> PathBuf {
    let yml = std::fs::canonicalize(&inv.path).unwrap_or(inv.path.clone());
    yml.parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf()
}

/// A file's text, or None when it's missing.
pub fn read(path: &std::path::Path) -> Result<Option<String>, Fail> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(failed(format!("{}: {e}", path.display()))),
    }
}

/// Atomically write `path` if its contents differ, and say so.
pub fn save(path: &std::path::Path, contents: &str, mode: u32) -> Result<(), Fail> {
    if dry() {
        if read(path)?.as_deref() != Some(contents) {
            println!("would write {}", path.display());
        }
        return Ok(());
    }
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
    if dry() {
        return Ok(());
    }
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| failed(format!("{}: {e}", dir.display())))
}
