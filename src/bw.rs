//! Bitwarden: `bw:ITEM[#FIELD]` through the bw CLI, and `roster vault
//! unlock|lock`. The session key lives in the kernel keyring (keyctl), never
//! in a file or argv, and reaches bw only as BW_SESSION in bw's environment.

use crate::{Fail, vault};
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

/// The keyring entry: a `user` key in the user keyring `@u`.
const KEY: &str = "roster:bw-session";
/// How long `vault unlock` lasts, in seconds (12 h).
const TIMEOUT: &str = "43200";
/// The variable that carries the master password into `bw unlock` only.
const MASTER_VAR: &str = "ROSTER_BW_MASTER";
/// roster v0.7.0's session file: never read, deleted by unlock and lock.
const LEGACY: &str = ".config/roster/bw-session";
const NO_KEYCTL: &str = "keyctl isn't installed, so the Bitwarden session can't be kept \
     and the master password is asked for on each run; install keyutils \
     (apt install keyutils, dnf install keyutils)";

fn failed(msg: String) -> Fail {
    Fail { code: 1, msg }
}

/// `bw ARGS --nointeraction` with `env` added; its stdout, wiped after use.
fn bw(args: &[&str], env: &[(&str, &str)]) -> Result<Zeroizing<Vec<u8>>, String> {
    let out = Command::new("bw")
        .args(args)
        .arg("--nointeraction")
        .env_remove("BW_SESSION")
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stderr(Stdio::inherit())
        .output()
        .map_err(|e| format!("can't run bw: {e}"))?;
    let stdout = Zeroizing::new(out.stdout);
    match out.status.success() {
        true => Ok(stdout),
        false => Err(format!("bw {} failed ({})", args[0], out.status)),
    }
}

/// `keyctl ARGS`, with `input` on its stdin. An error means keyctl can't run.
fn keyctl(args: &[&str], input: &[u8]) -> std::io::Result<Output> {
    let mut child = Command::new("keyctl")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let written = child.stdin.take().map(|mut i| i.write_all(input));
    let out = child.wait_with_output()?;
    written.transpose()?;
    Ok(out)
}

/// The session key in the keyring, or None if it's missing or expired.
fn stored() -> std::io::Result<Option<Zeroizing<String>>> {
    let out = keyctl(&["pipe", &format!("%user:{KEY}")], b"")?;
    let key = Zeroizing::new(out.stdout);
    let key = Zeroizing::new(String::from_utf8_lossy(&key).trim().to_string());
    Ok((out.status.success() && !key.is_empty()).then_some(key))
}

/// Unlock with the master password from BW_PASSWORD, else asked on /dev/tty.
fn unlock_now(what: &str) -> Result<Zeroizing<String>, Fail> {
    let master = match std::env::var("BW_PASSWORD") {
        Ok(v) => Zeroizing::new(v),
        Err(_) => vault::ask("Bitwarden master password", what)?,
    };
    let args = ["unlock", "--raw", "--passwordenv", MASTER_VAR];
    let out = bw(&args, &[(MASTER_VAR, &master)]).map_err(|e| failed(format!("{what}: {e}")))?;
    let session = Zeroizing::new(String::from_utf8_lossy(&out).trim().to_string());
    match session.is_empty() {
        true => Err(failed(format!("{what}: bw unlock gave no session key"))),
        false => Ok(session),
    }
}

/// Resolve `ITEM[#FIELD]`: the login password, `#username`, `#notes`, or a
/// custom field (exact name, then case-insensitive).
pub fn get(reference: &str, what: &str) -> Result<Zeroizing<String>, Fail> {
    let (item, field) = reference.split_once('#').unwrap_or((reference, "password"));
    // A session unlocked for this run only is unlocked once.
    static RUN: Mutex<Option<Zeroizing<String>>> = Mutex::new(None);
    let mut run = RUN.lock().unwrap_or_else(|e| e.into_inner());
    let session = match (run.clone(), stored()) {
        (Some(session), _) | (None, Ok(Some(session))) => session,
        (None, Ok(None)) => {
            eprintln!(
                "roster: Bitwarden is locked; `roster vault unlock` unlocks it for 12 h. \
                 Unlocking for this run only."
            );
            run.insert(unlock_now(what)?).clone()
        }
        (None, Err(_)) => {
            eprintln!("roster: {NO_KEYCTL}");
            run.insert(unlock_now(what)?).clone()
        }
    };
    drop(run);
    let fail = |e: String| failed(format!("{what}: auth bw:{reference}: {e}"));
    let json = bw(&["get", "item", item], &[("BW_SESSION", &session)]).map_err(|e| {
        fail(format!(
            "{e}; if Bitwarden is locked, run `roster vault unlock`"
        ))
    })?;
    let mut doc: Value = serde_json::from_slice(&json).map_err(|_| fail("bad JSON".into()))?;
    let fields = doc["fields"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let custom = |eq: fn(&str, &str) -> bool| {
        fields
            .iter()
            .find(|f| f["name"].as_str().is_some_and(|n| eq(n, field)))
            .map(|f| &f["value"])
    };
    let value = match field {
        "password" | "username" => &doc["login"][field],
        "notes" => &doc["notes"],
        _ => custom(|a, b| a == b)
            .or_else(|| custom(|a, b| a.eq_ignore_ascii_case(b)))
            .unwrap_or(&Value::Null),
    };
    let value = value.as_str().map(|v| Zeroizing::new(v.to_string()));
    scrub(&mut doc);
    value.ok_or_else(|| fail(format!("item {item} has no {field}")))
}

/// Wipe every string in a parsed item.
fn scrub(v: &mut Value) {
    match v {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(scrub),
        Value::Object(o) => o.values_mut().for_each(scrub),
        _ => {}
    }
}

/// Delete v0.7.0's session file if present, and say so.
fn drop_legacy() {
    let path = crate::setup::home().join(LEGACY);
    if std::fs::remove_file(&path).is_ok() {
        println!(
            "deleted {}: the session is kept in the kernel keyring now",
            path.display()
        );
    }
}

/// `roster vault unlock`: unlock bw and keep the session key in the keyring.
pub fn unlock() -> Result<(), Fail> {
    drop_legacy();
    if keyctl(&["--version"], b"").is_err() {
        return Err(failed(NO_KEYCTL.into()));
    }
    let session = unlock_now("vault unlock")?;
    let store = |args: &[&str], input: &[u8]| match keyctl(args, input) {
        Ok(out) if out.status.success() => Ok(out.stdout),
        _ => Err(failed(format!("vault unlock: keyctl {} failed", args[0]))),
    };
    let id = store(&["padd", "user", KEY, "@u"], session.as_bytes())?;
    let id = String::from_utf8_lossy(&id).trim().to_string();
    if let Err(e) = store(&["timeout", &id, TIMEOUT], b"") {
        let _ = keyctl(&["purge", "user", KEY], b"");
        return Err(e);
    }
    println!("Bitwarden unlocked for 12 h (the session key is in the kernel keyring)");
    Ok(())
}

/// `roster vault lock`: forget the session key and lock bw.
pub fn lock() -> Result<(), Fail> {
    drop_legacy();
    let _ = keyctl(&["purge", "user", KEY], b"");
    bw(&["lock"], &[]).map_err(|e| failed(format!("vault lock: {e}")))?;
    println!("Bitwarden locked");
    Ok(())
}
