//! Run an embedded sh script (`src/sh/*.sh`, through `include_str!`) on a
//! Host: `ssh [OPTS] HOST sh -s`, with the script on stdin, so nothing but
//! `sh -s` is in argv. With a password, it goes to ssh through askpass.

use crate::askpass;
use crate::vault::Secret;
use std::io::{self, Read, Write};
use std::process::Command;

/// What a remote script did. `code` is ssh's exit status: the script's, or
/// 255 when ssh itself failed (down, refused).
pub struct Ran {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Ran {
    /// The last line of stderr, for a one-line report.
    pub fn why(&self) -> &str {
        self.stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("")
    }
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
/// It never starts a ControlMaster: a lingering master would hold stderr
/// open; an existing one is used.
pub fn run(host: &str, opts: &[&str], script: &str, secret: Option<&Secret>) -> io::Result<Ran> {
    let (stdin, mut feed) = io::pipe()?;
    let (out_r, out_w) = io::pipe()?;
    let (err_r, err_w) = io::pipe()?;
    let mut ssh = Command::new("ssh");
    ssh.args(["-o", "ControlMaster=no"])
        .args(opts)
        .args([host, "sh", "-s"])
        .stdin(stdin)
        .stdout(out_w)
        .stderr(err_w);
    let script = script.to_string();
    let writer = std::thread::spawn(move || {
        let _ = feed.write_all(script.as_bytes());
    });
    let drain = |mut r: io::PipeReader| {
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = r.read_to_string(&mut s);
            s
        })
    };
    let (out, err) = (drain(out_r), drain(err_r));
    let status = match secret {
        Some(secret) => askpass::run(ssh, secret),
        None => {
            let status = ssh.status();
            drop(ssh); // close our ends of the pipes, so the readers finish
            status
        }
    }?;
    let _ = writer.join();
    Ok(Ran {
        code: status.code().unwrap_or(255),
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

/// Does `host` take the Box key? `ssh -o BatchMode=yes HOST true`: no
/// password, no question, nothing changed on the Host.
pub fn accepts_key(host: &str) -> bool {
    Command::new("ssh")
        .args(["-o", "BatchMode=yes", "-o", "ControlMaster=no", host, "true"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
