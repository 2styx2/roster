//! The vault: an `auth:` reference resolved to a password, only when needed.
//! `cmd:`, `env:` and `prompt` are built in; anything else points at `cmd:`.

use crate::Fail;
use std::fs::File;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use zeroize::Zeroizing;

/// A password. Wiped from memory when dropped, never displayed, and `***`
/// when debug-printed.
pub struct Secret {
    value: Zeroizing<String>,
    /// The environment variable it came from (`env:VAR`), which askpass
    /// keeps out of ssh's environment.
    pub from_env: Option<String>,
}

impl Secret {
    pub fn expose(&self) -> &str {
        &self.value
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("***")
    }
}

fn failed(msg: String) -> Fail {
    Fail { code: 1, msg }
}

/// Resolve `reference` for `what` (a Host or service name, for the prompt
/// and errors). `agent`, `key` and `none` mean there is no password.
pub fn resolve(reference: &str, what: &str) -> Result<Option<Secret>, Fail> {
    let secret = |value: Zeroizing<String>, from_env| {
        if value.is_empty() {
            return Err(failed(format!(
                "{what}: auth {reference} gave an empty password"
            )));
        }
        Ok(Some(Secret { value, from_env }))
    };
    match reference.split_once(':') {
        _ if matches!(reference, "agent" | "key" | "none") => Ok(None),
        _ if reference == "prompt" => secret(prompt(what)?, None),
        Some(("cmd", command)) => secret(command_line(command, what)?, None),
        Some(("env", var)) => match std::env::var(var) {
            Ok(v) => secret(Zeroizing::new(v), Some(var.to_string())),
            Err(_) => Err(failed(format!("{what}: auth env:{var}: {var} isn't set"))),
        },
        // Bitwarden (ticket #11) goes here.
        Some(("bw", _)) => Err(failed(format!(
            "{what}: auth bw: isn't built yet; use cmd: with the bw CLI meanwhile"
        ))),
        _ => Err(failed(format!(
            "{what}: auth '{reference}' isn't supported: use cmd:COMMAND with your \
             password manager's CLI, or env:VAR or prompt"
        ))),
    }
}

/// The first line `sh -c COMMAND` prints. Its stdin and stderr are the
/// terminal's, so a password manager can ask for its own unlock.
fn command_line(command: &str, what: &str) -> Result<Zeroizing<String>, Fail> {
    let out = Command::new("sh")
        .args(["-c", command])
        .stdin(Stdio::inherit())
        .stderr(Stdio::inherit())
        .output()
        .map_err(|e| failed(format!("{what}: auth cmd: can't run sh: {e}")))?;
    let stdout = Zeroizing::new(out.stdout);
    if !out.status.success() {
        return Err(failed(format!("{what}: auth cmd: failed ({})", out.status)));
    }
    let line = stdout.split(|&b| b == b'\n').next().unwrap_or_default();
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    match std::str::from_utf8(line) {
        Ok(s) => Ok(Zeroizing::new(s.to_string())),
        Err(_) => Err(failed(format!("{what}: auth cmd: printed non-UTF-8"))),
    }
}

/// Ask on /dev/tty with echo off.
fn prompt(what: &str) -> Result<Zeroizing<String>, Fail> {
    let tty_err = |e: std::io::Error| failed(format!("{what}: auth prompt: /dev/tty: {e}"));
    let mut tty = File::options()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(tty_err)?;
    let input = tty.try_clone().map_err(tty_err)?;
    let stty = |arg: &str| -> std::io::Result<()> {
        Command::new("stty")
            .arg(arg)
            .stdin(input.try_clone()?)
            .status()
            .map(drop)
    };
    write!(tty, "password for {what}: ").map_err(tty_err)?;
    stty("-echo").map_err(tty_err)?;
    // Byte by byte, so no unwiped read buffer holds the password.
    let mut line = Zeroizing::new(Vec::with_capacity(256));
    let mut byte = [0u8];
    let read = loop {
        match tty.read(&mut byte) {
            Ok(1) if byte[0] != b'\n' => line.push(byte[0]),
            Ok(_) => break Ok(()),
            Err(e) => break Err(e),
        }
    };
    let _ = stty("echo");
    let _ = writeln!(tty);
    read.map_err(tty_err)?;
    match std::str::from_utf8(&line) {
        Ok(s) => Ok(Zeroizing::new(s.to_string())),
        Err(_) => Err(failed(format!("{what}: auth prompt: not UTF-8"))),
    }
}
