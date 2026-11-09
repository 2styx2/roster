//! `roster setup`, the Host side: record each Host's host key, then install
//! the Box key on each Enrolled, reviewed, POSIX Host that doesn't take it
//! yet, logging in once with its vault password. Hosts are visited one at a
//! time; one that is down is reported and left for the next run.

use crate::inventory::{Host, Inventory};
use crate::setup::{expand, home};
use crate::{Fail, atomic, remote, vault};

const ADD_KEY: &str = include_str!("sh/add-key.sh");

/// With `dry`, print what would be done: Hosts whose host key is known get
/// the read-only probe; nothing is written here or on a Host. Returns the
/// Hosts that take the Box key and how many Hosts aren't done.
pub fn run(inv: &Inventory, dry: bool) -> Result<(Vec<&Host>, usize), Fail> {
    let mut ready = Vec::new();
    let known_hosts = home().join(".ssh/roster_known_hosts");
    let mut known = std::fs::read_to_string(&known_hosts).unwrap_or_default();
    let (mut undone, mut memo) = (0, vault::Memo::default());
    for h in &inv.hosts {
        let skip = |why: &str| eprintln!("roster: {}: skipped: {why}", h.name);
        if !h.reviewed {
            skip("unreviewed");
            continue;
        }
        if !h.enroll {
            skip("a Password Host (enroll: false)");
            continue;
        }
        if h.os == "windows" {
            skip("os: windows; install the Box key by hand for now");
            continue;
        }
        let at = known_as(h);
        if !is_known(&known, &at) {
            if dry {
                println!(
                    "would record the host key of {} and install the Box key",
                    h.name
                );
                continue;
            }
            let Some(lines) = keyscan(h) else {
                eprintln!("roster: {}: down: no answer to ssh-keyscan at {at}", h.name);
                undone += 1;
                continue;
            };
            known += &lines;
            atomic::update(&known_hosts, &known, 0o600)
                .map_err(|e| failed(format!("{}: {e}", known_hosts.display())))?;
            println!("recorded the host key of {}", h.name);
        }
        if remote::accepts_key(&h.name) {
            ready.push(h);
            continue;
        }
        if dry {
            println!("would install the Box key on {}", h.name);
            continue;
        }
        match install(inv, h, &mut memo) {
            Ok(()) => {
                println!("installed the Box key on {}", h.name);
                ready.push(h);
            }
            Err(msg) => {
                eprintln!("roster: {msg}");
                undone += 1;
            }
        }
    }
    Ok((ready, undone))
}

fn failed(msg: String) -> Fail {
    Fail { code: 1, msg }
}

/// The name a Host's key goes by in known_hosts: `IP`, or `[IP]:PORT`.
pub fn known_as(h: &Host) -> String {
    match h.port {
        22 => h.ip.clone(),
        port => format!("[{}]:{port}", h.ip),
    }
}

fn is_known(known: &str, at: &str) -> bool {
    known.lines().any(|l| {
        let names = l.split_whitespace().next().unwrap_or_default();
        names.split(',').any(|n| n == at)
    })
}

/// `ssh-keyscan -T 5 -p PORT IP`'s key lines, or None when nothing answered.
fn keyscan(h: &Host) -> Option<String> {
    let port = h.port.to_string();
    let out = std::process::Command::new("ssh-keyscan")
        .args(["-T", "5", "-p", &port, &h.ip])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let lines: String = text
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|l| format!("{l}\n"))
        .collect();
    (!lines.is_empty()).then_some(lines)
}

/// Log in with the Host's vault password and append the Box key's line.
/// Err is a one-line message naming the Host.
fn install(inv: &Inventory, h: &Host, memo: &mut vault::Memo) -> Result<(), String> {
    let name = &h.name;
    let line = box_line(inv, h)?;
    let Some(secret) = memo.resolve(&h.auth, name).map_err(|f| f.msg)? else {
        return Err(format!(
            "{name}: doesn't take the Box key, and auth: {} gives no password to install it with",
            h.auth
        ));
    };
    let script = remote::script(&[("LINE", &line)], ADD_KEY);
    let opts = ["-o", "PubkeyAuthentication=no"];
    let ran = remote::run(name, &opts, &script, Some(&secret))
        .map_err(|e| format!("{name}: can't run ssh: {e}"))?;
    match (ran.code, ran.stdout.trim()) {
        (0, "added") => Ok(()),
        (0, "present") => Err(format!(
            "{name}: the Box key is in authorized_keys but isn't taken; \
             check the modes of ~ and ~/.ssh there"
        )),
        (255, _) => Err(format!(
            "{name}: can't log in with the password: {}",
            ran.why()
        )),
        (code, _) => Err(format!(
            "{name}: installing the Box key failed ({code}): {}",
            ran.why()
        )),
    }
}

/// `TYPE KEY roster-managed:BOX`, from the `.pub` of `h`'s Box key.
fn box_line(inv: &Inventory, h: &Host) -> Result<String, String> {
    let path = expand(&format!("{}.pub", inv.key_of(h)));
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut fields = text.split_whitespace();
    match (fields.next(), fields.next()) {
        (Some(alg), Some(key)) => Ok(format!("{alg} {key} roster-managed:{}", inv.box_name)),
        _ => Err(format!("{}: not a public key", path.display())),
    }
}
