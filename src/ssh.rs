//! `roster ssh HOST [ARGS...]`: replace roster with `ssh HOST ARGS`, which
//! picks up the Host's block from the ssh config `roster setup` wrote. A
//! Password Host's password goes to a child ssh through askpass instead.

use crate::inventory::Inventory;
use crate::{Fail, askpass, vault};
use std::ffi::OsString;
use std::os::unix::process::CommandExt;

/// Returns only when roster can't hand over to ssh, or (Password Host) with
/// ssh's exit status as the code and no message.
pub fn exec(inv: &Inventory, name: &str, args: Vec<OsString>) -> Fail {
    let fail = |code, msg| Fail { code, msg };
    let Some(host) = inv.hosts.iter().find(|h| h.name == name) else {
        return fail(1, format!("no Host named '{name}' in the Inventory"));
    };
    let mut ssh = crate::remote::command("ssh");
    ssh.arg(name).args(args);
    let secret = if host.enroll {
        None
    } else {
        match vault::resolve(&host.auth, name) {
            Ok(secret) => secret,
            Err(f) => return f,
        }
    };
    let Some(secret) = secret else {
        return fail(126, format!("can't run ssh: {}", ssh.exec()));
    };
    match askpass::run(ssh, &secret) {
        Ok(status) => fail(status.code().map_or(255, |c| c as u8), String::new()),
        Err(e) => fail(126, format!("can't run ssh with askpass: {e}")),
    }
}
