//! Run an embedded sh script (`src/sh/*.sh`, through `include_str!`) on a
//! Host: `ssh [OPTS] HOST sh -s`, with the script on stdin, so nothing but
//! `sh -s` is in argv. With a password, it goes to ssh through askpass.

use crate::askpass;
use crate::vault::Secret;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::process::Command;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Variables a secret may come from: no ssh or curl roster starts inherits them.
static SCRUB: OnceLock<Vec<String>> = OnceLock::new();

/// Keep `vars` (`Inventory::secret_vars`) from every `command`; set when
/// the Inventory is opened.
pub fn scrub(vars: Vec<String>) {
    let _ = SCRUB.set(vars);
}

/// `program` (ssh, curl) without any variable a secret may come from: the
/// one way roster starts a program that talks to a Host.
pub fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    for var in SCRUB.get().into_iter().flatten() {
        cmd.env_remove(var);
    }
    cmd
}

fn ssh() -> Command {
    command("ssh")
}

/// What a remote script did. `code` is ssh's exit status: the script's, or
/// 255 when ssh itself failed (down, refused).
pub struct Ran {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// `body` with each `NAME=value` set first, single-quoted for sh.
pub fn script(vars: &[(&str, &str)], body: &str) -> String {
    let mut out = String::new();
    for (name, value) in vars {
        out += &format!("{name}='{}'\n", value.replace('\'', r"'\''"));
    }
    out + body
}

/// Run `script` on `host` (an ssh config name) with `opts` before the name.
/// It never starts a ControlMaster, which would linger; an existing one is
/// used. stdin, stdout and stderr are unlinked scratch files, so no pipe
/// can fill up and stall ssh.
pub fn run(host: &str, opts: &[&str], script: &str, secret: Option<&Secret>) -> io::Result<Ran> {
    let mut stdin = scratch()?;
    stdin.write_all(script.as_bytes())?;
    stdin.seek(SeekFrom::Start(0))?;
    let (mut out, mut err) = (scratch()?, scratch()?);
    let mut ssh = ssh();
    ssh.args(["-o", "ControlMaster=no"])
        .args(opts)
        .args([host, "sh", "-s"])
        .stdin(stdin)
        .stdout(out.try_clone()?)
        .stderr(err.try_clone()?);
    let status = match secret {
        Some(secret) => askpass::run(ssh, secret)?,
        None => ssh.status()?,
    };
    let text = |f: &mut File| -> io::Result<String> {
        let mut bytes = Vec::new();
        f.seek(SeekFrom::Start(0))?;
        f.read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    };
    Ok(Ran {
        code: status.code().unwrap_or(255),
        stdout: text(&mut out)?,
        stderr: text(&mut err)?,
    })
}

/// A new file only this user can open, already unlinked.
fn scratch() -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("roster-{}-{n}", std::process::id()));
    let file = File::options()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    std::fs::remove_file(&path)?;
    Ok(file)
}

/// Does `host` take the Box key? `ssh -o BatchMode=yes HOST exit`: no
/// password, no question, nothing changed on the Host.
pub fn accepts_key(host: &str) -> bool {
    ssh()
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ControlMaster=no",
            host,
            // Every shell has `exit`; PowerShell and cmd have no `true`.
            "exit",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
