//! The system's git, run as a subprocess with no shell in between (ticket 24, decision Q83).
//!
//! Every run gets the same guard rails:
//! - roster hands git no credentials, and git may not ask for any: no terminal prompt, no askpass
//!   program (roster's own included), Git Credential Manager told not to open a window, and stdin
//!   closed. A repo that needs a login the user's own git setup (an ssh agent, say) doesn't
//!   already give fails with git's message.
//! - only the `https`, `ssh` and `file` transports (no `ext::`, which runs a command, and no plain
//!   `http` or `git://`, which anyone on the way could change);
//! - no submodules, and hooks pointed at nowhere;
//! - a time limit, after which git is killed.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// How to run git: which program, and for how long at most.
#[derive(Debug, Clone)]
pub struct Git {
    pub program: PathBuf,
    pub timeout: Duration,
}

impl Default for Git {
    fn default() -> Self {
        Git {
            program: PathBuf::from("git"),
            timeout: Duration::from_secs(120),
        }
    }
}

/// The settings every run starts with (`git -c key=value`).
const SAFE: &[&str] = &[
    "protocol.allow=never",
    "protocol.https.allow=always",
    "protocol.ssh.allow=always",
    "protocol.file.allow=always",
    "submodule.recurse=false",
    "core.askPass=",
    "credential.interactive=never",
    "advice.detachedHead=false",
    "core.fsmonitor=false",
];

/// Env vars that could hand git a credential or a program to ask for one.
const DROPPED: &[&str] = &[
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
];

impl Git {
    /// Runs `git ARGS` in `dir` (or the current folder) and gives back what it printed, or its
    /// error message.
    pub fn run(&self, dir: Option<&Path>, args: &[&str]) -> Result<String, String> {
        let mut cmd = Command::new(&self.program);
        for setting in SAFE {
            cmd.arg("-c").arg(setting);
        }
        cmd.arg("-c").arg(format!("core.hooksPath={}", null_dir()));
        if let Some(dir) = dir {
            cmd.arg("-C").arg(dir);
        }
        cmd.args(args);
        for var in DROPPED {
            cmd.env_remove(var);
        }
        cmd.env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            .env("LC_ALL", "C");
        let done = crate::process::run(cmd, Some(self.timeout)).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "git isn't installed (or isn't on the PATH): Packages need it".to_string(),
            std::io::ErrorKind::TimedOut => format!("git {} took longer than {} s", args[0], self.timeout.as_secs()),
            _ => format!("can't run git: {e}"),
        })?;
        let status = done.status;
        let out = String::from_utf8_lossy(&done.stdout).into_owned();
        let err = String::from_utf8_lossy(&done.stderr).into_owned();
        if status.success() {
            Ok(out)
        } else {
            let message = err
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            Err(if message.is_empty() {
                format!("git {} failed ({status})", args[0])
            } else {
                message
            })
        }
    }
}

/// A hooks folder that doesn't exist, so no hook ever runs.
fn null_dir() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}
