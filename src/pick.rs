//! `roster` alone: choose Hosts with fzf, then open each with `roster ssh`.

use crate::Fail;
use crate::inventory::Inventory;
use std::io::Write;
use std::process::{Command, Stdio};

pub fn run(inv: &Inventory) -> Result<(), Fail> {
    let fail = |code, msg: String| Fail { code, msg };
    let mut fzf = Command::new("fzf")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => fail(
                1,
                "the picker needs fzf: install fzf from your package manager, \
                 or run roster ls"
                    .into(),
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
    let _key = lines.next().unwrap_or("");
    let hosts: Vec<&str> = lines.filter_map(|l| l.split_whitespace().next()).collect();
    let Some(first) = hosts.first() else {
        return Ok(()); // cancelled
    };
    Err(crate::ssh::exec(inv, first, Vec::new()))
}
