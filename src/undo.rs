//! `roster setup --undo`: remove what roster put on the Hosts and the Box,
//! and nothing else. Each Host loses this Box's Mesh, then this Box's key
//! line, last, since that cuts off roster's own way in.

use crate::inventory::{Host, Inventory};
use crate::{Fail, mesh, remote};

const REMOVE_KEY: &str = include_str!("sh/remove-key.sh");
const OPTS: [&str; 4] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

pub fn run(inv: &Inventory, dry: bool) -> Result<(), Fail> {
    remote::scrub(inv.secret_vars());
    let mut undone = 0;
    for (i, h) in inv.hosts.iter().enumerate() {
        let skip = |why: &str| eprintln!("roster: {}: skipped: {why}", h.name);
        if !h.reviewed {
            skip("unreviewed");
        } else if !h.enroll {
            skip("a Password Host (enroll: false)");
        } else if h.os == "windows" {
            skip("os: windows; remove the Box key there by hand");
        } else if let Err(why) = host(inv, i, dry) {
            eprintln!("roster: {}: {why}", h.name);
            undone += 1;
        }
    }
    match undone {
        0 => Ok(()),
        n => Err(Fail {
            code: 1,
            msg: format!(
                "{n} Host{} not done; run `roster setup --undo` again to finish",
                if n == 1 { "" } else { "s" }
            ),
        }),
    }
}

/// Undo Host `i`: its Mesh, then the Box key line. A Host that refuses the
/// Box key has nothing of this Box's that roster can reach, so it's done.
/// When the Mesh step fails, the key line stays, so a rerun can get back in.
fn host(inv: &Inventory, i: usize, dry: bool) -> Result<(), String> {
    let h: &Host = &inv.hosts[i];
    if !mesh::undo(inv, i, dry).map_err(|why| format!("Mesh: {why}"))? {
        return Ok(());
    }
    let vars = [("BOX", inv.box_name.as_str()), ("DRY", if dry { "1" } else { "" })];
    let ran = remote::run(&h.name, &OPTS, &remote::script(&vars, REMOVE_KEY), None)
        .map_err(|e| format!("can't run ssh: {e}"))?;
    match (ran.code, ran.stdout.trim()) {
        (0, "removed") => println!("{}: removed the Box key", h.name),
        (0, "present") => println!("{}: would remove the Box key", h.name),
        (0, _) => {}
        (255, _) if ran.why().contains("Permission denied") => {}
        (255, _) => return Err(format!("down: {}", ran.why())),
        (code, _) => return Err(format!("removing the Box key failed ({code}): {}", ran.why())),
    }
    Ok(())
}
