//! `roster ssh HOST [ARGS...]`: replace roster with `ssh HOST ARGS`, which
//! picks up the Host's block from the ssh config `roster setup` wrote.

use crate::Fail;
use crate::inventory::Inventory;
use std::ffi::OsString;
use std::os::unix::process::CommandExt;

/// Returns only when roster can't hand over to ssh.
pub fn exec(inv: &Inventory, name: &str, args: Vec<OsString>) -> Fail {
    let fail = |code, msg| Fail { code, msg };
    let Some(host) = inv.hosts.iter().find(|h| h.name == name) else {
        return fail(1, format!("no Host named '{name}' in the Inventory"));
    };
    if !host.enroll {
        let msg = format!("{name} is a Password Host: roster ssh can't log in to one yet");
        return fail(1, msg);
    }
    let e = std::process::Command::new("ssh")
        .arg(name)
        .args(args)
        .exec();
    fail(126, format!("can't run ssh: {e}"))
}
