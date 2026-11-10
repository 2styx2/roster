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
/// The session key's permissions: possessor all; user view, read, search.
const PERM: &str = "0x3f0b0000";
/// Stores the key (stdin) as $1 with permissions $2 and timeout $3, in the
/// new session keyring keyctl runs it in, then moves it into @u. Any failure
/// invalidates the key and exits non-zero.
const STORE: &str = "id=$(keyctl padd user \"$1\" @s) && if keyctl setperm \"$id\" \"$2\" && keyctl timeout \"$id\" \"$3\" && keyctl link \"$id\" @u && keyctl unlink \"$id\" @s; then :; else keyctl invalidate \"$id\"; exit 1; fi";
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

/// The id of the session key in the user keyring (@u), or None. Looked up
/// in @u by name rather than through the session: after `su`, the session
/// keyring doesn't lead to this user's keyring.
fn find() -> std::io::Result<Option<String>> {
    let out = keyctl(&["search", "@u", "user", KEY], b"")?;
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((out.status.success() && !id.is_empty()).then_some(id))
}

/// The session key in the keyring, or None if it's missing or expired.
fn stored() -> std::io::Result<Option<Zeroizing<String>>> {
    let Some(id) = find()? else {
        return Ok(None);
    };
    let out = keyctl(&["pipe", &id], b"")?;
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
    // bw reads an empty --passwordenv as unset and gives a confusing error.
    if master.is_empty() {
        return Err(failed(format!("{what}: no master password given")));
    }
    let args = ["unlock", "--raw", "--passwordenv", MASTER_VAR];
    let out = bw(&args, &[(MASTER_VAR, &master)]).map_err(|e| failed(format!("{what}: {e}")))?;
    let session = Zeroizing::new(String::from_utf8_lossy(&out).trim().to_string());
    match session.is_empty() {
        true => Err(failed(format!("{what}: bw unlock gave no session key"))),
        false => Ok(session),
    }
}

/// The vault item named exactly `item`. bw's own lookup is a search (`box-b
/// ssh` also finds `lab-box-b ssh`, and bw gives up on "More than one
/// result"), so the search's matches are narrowed to the exact name first;
/// with none, `bw get item` decides (an id, say). Several items of the very
/// same name are refused with their ids.
fn item_named(item: &str, session: &str) -> Result<Value, String> {
    let env = [("BW_SESSION", session)];
    let locked = |e: String| format!("{e}; if Bitwarden is locked, run `roster vault unlock`");
    let list = bw(&["list", "items", "--search", item], &env).map_err(locked)?;
    let all: Vec<Value> = serde_json::from_slice(&list).map_err(|_| "bad JSON".to_string())?;
    let mut exact: Vec<Value> = all.into_iter().filter(|i| i["name"] == item).collect();
    match exact.len() {
        1 => Ok(exact.remove(0)),
        0 => {
            let json = bw(&["get", "item", item], &env).map_err(locked)?;
            serde_json::from_slice(&json).map_err(|_| "bad JSON".to_string())
        }
        n => {
            let ids: Vec<&str> = exact.iter().filter_map(|i| i["id"].as_str()).collect();
            Err(format!(
                "{n} vault items are named '{item}' ({}); use auth: bw:ID with one of those ids",
                ids.join(", ")
            ))
        }
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
    let mut doc = item_named(item, &session).map_err(fail)?;
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
        _ => Err(failed(
            "vault unlock: keyctl couldn't store the session key".into(),
        )),
    };
    forget();
    // In a new session keyring: its keys are always possessed, so their
    // permissions can be set. Not so for a key added to @u after `su`, nor
    // to WSL's default user-session keyring. Added there, set up, then moved
    // into the user keyring; the key stays on stdin. Possessor: all. The
    // owner's other processes, such as `roster sync` from cron in its own
    // keyring session: view, read, search, nothing more (no write, link or
    // setattr, so they can't replace the key or extend its life). Group and
    // other users: none.
    store(
        &[
            "session", "-", "sh", "-c", STORE, "store", KEY, PERM, TIMEOUT,
        ],
        session.as_bytes(),
    )?;
    println!("Bitwarden unlocked for 12 h (the session key is in the kernel keyring)");
    Ok(())
}

/// The vault's items and folders as JSON, after a `bw sync`, for the import.
/// Only a session key already in the keyring is used: this never prompts.
pub fn list() -> Result<[Zeroizing<Vec<u8>>; 2], String> {
    let session = match stored() {
        Ok(Some(session)) => session,
        Ok(None) => return Err("Bitwarden is locked (`roster vault unlock`)".into()),
        Err(_) => return Err("keyctl isn't installed, so there's no Bitwarden session".into()),
    };
    let env = [("BW_SESSION", session.as_str())];
    bw(&["sync"], &env)?;
    Ok([
        bw(&["list", "items"], &env)?,
        bw(&["list", "folders"], &env)?,
    ])
}

/// Remove the session key from the user keyring, if it's there.
fn forget() {
    if let Ok(Some(id)) = find() {
        let _ = keyctl(&["invalidate", &id], b"");
    }
}

/// `roster vault lock`: forget the session key and lock bw.
pub fn lock() -> Result<(), Fail> {
    drop_legacy();
    forget();
    bw(&["lock"], &[]).map_err(|e| failed(format!("vault lock: {e}")))?;
    println!("Bitwarden locked");
    Ok(())
}
