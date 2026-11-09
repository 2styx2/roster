//! `roster` alone: choose Hosts with fzf, then open each with `roster ssh`:
//! in tmux as a new window, a split (ctrl-v), or synchronized panes (several
//! marked with Tab); outside tmux in place.

use crate::Fail;
use crate::inventory::Inventory;
use std::ffi::OsString;
use std::io::Write;
use std::process::{Command, Stdio};

fn fail(code: u8, msg: impl Into<String>) -> Fail {
    let msg = msg.into();
    Fail { code, msg }
}

/// `s` quoted for sh, for the preview command fzf runs.
fn quote(s: &OsString) -> String {
    format!("'{}'", s.to_string_lossy().replace('\'', r"'\''"))
}

pub fn run(inv: &Inventory) -> Result<(), Fail> {
    let exe = std::env::current_exe().map_err(|e| fail(1, format!("can't find roster: {e}")))?;
    let config = std::path::absolute(&inv.path).map_err(|e| fail(1, e.to_string()))?;
    let (exe, config) = (exe.into_os_string(), config.into_os_string());
    let preview = format!("{} -c {} ls --long {{1}}", quote(&exe), quote(&config));
    let mut fzf = Command::new("fzf")
        .args(["--multi", "--expect=ctrl-v", "--prompt=host> "])
        .arg(format!("--preview={preview}"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => fail(
                1,
                "the picker needs fzf: install fzf from your package manager, or use roster ls",
            ),
            _ => fail(1, format!("can't run fzf: {e}")),
        })?;
    let list = crate::ls::text(&inv.hosts);
    // fzf may quit before reading it all; that is not an error.
    let _ = fzf.stdin.take().unwrap().write_all(list.as_bytes());
    let out = fzf
        .wait_with_output()
        .map_err(|e| fail(1, format!("fzf: {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let key = lines.next().unwrap_or("");
    let hosts: Vec<&str> = lines.filter_map(|l| l.split_whitespace().next()).collect();
    let Some(&first) = hosts.first() else {
        return Ok(()); // cancelled
    };
    if std::env::var_os("TMUX").is_none() {
        if hosts.len() > 1 {
            return Err(fail(1, "several Hosts open as panes only inside tmux"));
        }
        return Err(crate::ssh::exec(inv, first, Vec::new()));
    }
    // `roster -c CONFIG ssh HOST`, run by tmux without a shell.
    let ssh = |host: &str| -> Vec<OsString> {
        let args = [&exe, &"-c".into(), &config, &"ssh".into(), &host.into()];
        args.into_iter().cloned().collect()
    };
    if hosts.len() == 1 {
        return match key {
            "ctrl-v" => tmux(&["split-window"], ssh(first)),
            _ => tmux(&["new-window", "-n", first], ssh(first)),
        }
        .map(drop);
    }
    let id = tmux(&["new-window", "-P", "-F", "#{window_id}"], ssh(first))?;
    let id = id.trim();
    for host in &hosts[1..] {
        tmux(&["split-window", "-t", id], ssh(host))?;
        tmux(&["select-layout", "-t", id, "tiled"], vec![])?;
    }
    let sync = ["set-window-option", "-t", id, "synchronize-panes", "on"];
    tmux(&sync, vec![]).map(drop)
}

/// Run `tmux ARGS COMMAND`; returns what it printed.
fn tmux(args: &[&str], command: Vec<OsString>) -> Result<String, Fail> {
    let out = Command::new("tmux")
        .args(args)
        .args(command)
        .stderr(Stdio::inherit())
        .output()
        .map_err(|e| fail(1, format!("can't run tmux: {e}")))?;
    if !out.status.success() {
        return Err(fail(1, format!("tmux {} failed", args[0])));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
