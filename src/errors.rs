//! Errors in plain words. Another program's stderr never reaches the
//! terminal raw: a known failure becomes roster's own message, anything else
//! its last meaningful line. A message may end in a `  hint:` line.

use crate::inventory::Host;
use std::io;

/// `msg`, then the next step on a line of its own.
pub fn hint(msg: impl std::fmt::Display, hint: &str) -> String {
    format!("{msg}\n  hint: {hint}")
}

/// The last line of `text` with something in it, trimmed, ANSI codes removed.
pub fn last_line(text: &str) -> String {
    let line = text.lines().rev().find(|l| !plain(l).trim().is_empty());
    plain(line.unwrap_or_default()).trim().to_string()
}

/// `s` without ANSI escape sequences (ESC [ ... letter).
fn plain(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => {
                if chars.next() == Some('[') {
                    chars.find(|c| c.is_ascii_alphabetic());
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// An OS error in lower case, without its `(os error N)`.
pub fn io(e: &io::Error) -> String {
    reason(&e.to_string())
}

/// The reason at the end of an error line (`keyctl_add_key: Disk quota
/// exceeded (os error 122)`: `disk quota exceeded`).
pub fn reason(line: &str) -> String {
    let text = line.rsplit(": ").next().unwrap_or_default();
    let text = text.split(" (os error").next().unwrap_or_default();
    let mut chars = text.chars();
    chars
        .next()
        .map_or_else(String::new, |c| c.to_lowercase().chain(chars).collect())
}

/// Why `program` didn't start.
pub fn spawn(program: &str, e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::NotFound => format!("{program} isn't installed"),
        _ => format!("can't run {program}: {}", io(e)),
    }
}

/// Why a connection to `at` (ADDR:PORT) failed, from the OS's or ssh's words.
fn unreachable(at: &str, why: &str) -> Option<String> {
    let has = |s: &str| why.contains(s);
    Some(match () {
        _ if has("timed out") => format!("can't reach {at} (timed out)"),
        _ if has("No route to host") || has("unreachable") => {
            format!("can't reach {at} (no route)")
        }
        _ if has("refused") => format!("ssh isn't listening on {at}"),
        _ => return None,
    })
}

/// A failed TCP connect to `h`'s port, as `roster check` makes it.
pub fn connect(h: &Host, e: &io::Error) -> String {
    let at = format!("{}:{}", h.ip, h.port);
    unreachable(&at, &e.to_string()).unwrap_or_else(|| format!("{at}: {}", io(e)))
}

/// What ssh's stderr says went wrong reaching `h`. `auth` is the password
/// reference ssh was given, if any; else it tried the Box key.
pub fn ssh(h: &Host, auth: Option<&str>, stderr: &str) -> String {
    let at = format!("{}:{}", h.ip, h.port);
    let has = |s: &str| stderr.contains(s);
    let check = format!("`roster check {}` shows each step", h.name);
    if has("REMOTE HOST IDENTIFICATION HAS CHANGED") {
        let known = crate::hosts::known_as(h);
        return hint(
            format!("the host key of {at} has changed since roster recorded it"),
            &format!(
                "if {} was rebuilt, remove the old key with \
                 `ssh-keygen -R '{known}' -f ~/.ssh/roster_known_hosts`, then run `roster setup`",
                h.name
            ),
        );
    }
    if has("Host key verification failed") {
        return hint(
            format!("the host key of {at} isn't known"),
            "`roster setup` records it",
        );
    }
    if has("Could not resolve hostname") {
        return hint(format!("can't resolve {}", h.ip), &check);
    }
    if let Some(msg) = unreachable(&at, stderr) {
        return hint(msg, &check);
    }
    if has("Permission denied") {
        return match auth {
            Some(auth) => hint(
                format!("the password from {auth} isn't accepted for {}", h.user),
                "update that password, or the Host's user: or auth: in roster.yml",
            ),
            None => hint(
                format!("the Box key isn't accepted for {}", h.user),
                "run `roster setup`, or check the Host's user: in roster.yml",
            ),
        };
    }
    match last_line(stderr) {
        why if why.is_empty() => format!("ssh to {at} failed"),
        why => why,
    }
}

/// What bw's stderr says; `item` is the vault item looked up, if any.
pub fn bw(stderr: &str, item: &str) -> String {
    let has = |s: &str| stderr.contains(s);
    let by_id = "use `auth: bw:ID` with the item's id";
    match () {
        _ if has("Invalid master password") || has("decryption operation failed") => {
            "wrong master password".into()
        }
        _ if has("More than one result") => {
            hint(format!("several vault items match \"{item}\""), by_id)
        }
        _ if has("Not found") => hint(
            format!("no vault item named \"{item}\""),
            &format!("check the item's name in Bitwarden, or {by_id}"),
        ),
        _ if has("Vault is locked") => hint("Bitwarden is locked", "run `roster vault unlock`"),
        _ if has("not logged in") => hint("bw isn't logged in", "run `bw login` once"),
        _ => match last_line(stderr) {
            why if why.is_empty() => "bw failed".into(),
            why => format!("bw: {why}"),
        },
    }
}

/// What sudo's stderr says, when it refused to run the command on `h`.
pub fn sudo(h: &Host, stderr: &str) -> Option<String> {
    let from = h.sudo.as_deref().unwrap_or(&h.auth);
    if stderr.contains("incorrect password") || stderr.contains("Sorry, try again") {
        let what = match from.starts_with("bw:") {
            true => "that vault item",
            false => "that password",
        };
        let fix = format!(
            "update {what}, or give {} its own `sudo: {{auth: …}}` in roster.yml",
            h.name
        );
        return Some(hint(
            format!("sudo rejected the password from {from}"),
            &fix,
        ));
    }
    if stderr.contains("a password is required") {
        let fix = format!(
            "give {} one in roster.yml: `sudo: {{auth: bw:ITEM}}`",
            h.name
        );
        return Some(hint("sudo needs a password", &fix));
    }
    stderr
        .contains("not in the sudoers")
        .then(|| format!("{} may not use sudo on {}", h.user, h.name))
}
