//! `login: unifi`: UniFi OS consoles (UDM, Cloud Key, UniFi OS Server) log in
//! with a session cookie, not a header. roster POSTs the Login to
//! `/api/auth/login`, takes the `TOKEN` cookie and the CSRF token from the
//! reply's headers, and keeps them for a few minutes in a private file, so a
//! loop of calls logs in once rather than tripping the console's login limit
//! (HTTP 429).

use crate::vault::Secret;
use crate::web::{Call, failed, http, option};
use crate::{Fail, atomic};
use serde::{Deserialize, Serialize};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

/// Where the console takes the Login.
pub const LOGIN_PATH: &str = "/api/auth/login";

/// How long a kept session is used: the console may end it sooner, and a
/// 401 then logs in again.
const TTL: u64 = 600;

/// A logged-in session: the `TOKEN=...` cookie and the CSRF token (which
/// may be empty).
#[derive(Serialize, Deserialize)]
pub struct Session {
    origin: String,
    user: String,
    cookie: String,
    csrf: String,
    expires: u64,
}

impl Drop for Session {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.cookie.zeroize();
        self.csrf.zeroize();
    }
}

impl Session {
    /// The session as curl config lines.
    pub fn config(&self) -> Zeroizing<String> {
        let mut config = Zeroizing::new(String::new());
        option(&mut config, "header", &["Cookie: ", &self.cookie]);
        if !self.csrf.is_empty() {
            // UniFi needs it on every request that changes something.
            option(&mut config, "header", &["X-CSRF-Token: ", &self.csrf]);
        }
        config
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// The session file of one Host's service: under `$XDG_RUNTIME_DIR` (gone at
/// logout), else `~/.cache`.
pub fn path(host: &str, service: &str) -> PathBuf {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|v| !v.is_empty())
        .map_or_else(|| crate::setup::home().join(".cache"), PathBuf::from);
    let safe = |s: &str| -> String {
        s.chars()
            .map(|c| match c {
                'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '_' | '-' => c,
                _ => '_',
            })
            .collect()
    };
    base.join("roster/sessions")
        .join(format!("{}-{}.json", safe(host), safe(service)))
}

/// The kept session for `origin` and `user`, if still good. One that has
/// run out, is someone else's to read, or isn't a plain file is removed.
pub fn load(path: &Path, origin: &str, user: &str) -> Option<Session> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    let private = meta.is_file() && meta.permissions().mode() & 0o077 == 0;
    let text = Zeroizing::new(std::fs::read(path).ok().filter(|_| private));
    let session = text
        .as_ref()
        .and_then(|t| serde_json::from_slice::<Session>(t).ok());
    match session {
        Some(s) if s.origin == origin && s.user == user && s.expires > now() => Some(s),
        _ => {
            drop_file(path);
            None
        }
    }
}

pub fn drop_file(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Keep `session` in a new `0600` file in a `0700` folder; without one the
/// next call just logs in again.
fn save(path: &Path, session: &Session) {
    drop_file(path);
    let Some(dir) = path.parent() else { return };
    let made = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir);
    let text = Zeroizing::new(serde_json::to_vec(session).unwrap_or_default());
    if made.is_ok() {
        let _ = atomic::write(path, &text, 0o600);
    }
}

#[derive(Serialize)]
struct Body<'a> {
    username: &'a str,
    password: &'a str,
    #[serde(rename = "rememberMe")]
    remember_me: bool,
}

/// Log in and keep the session at `path`. Its errors hold neither the
/// password nor the cookie.
pub fn login(call: &Call, path: &Path, user: &str, secret: &Secret) -> Result<Session, Fail> {
    let what = format!("{}: unifi login to {LOGIN_PATH}", call.what);
    let body = Body {
        username: user,
        password: secret.expose(),
        remember_me: false,
    };
    let body =
        Zeroizing::new(serde_json::to_vec(&body).map_err(|e| failed(format!("{what}: {e}")))?);
    let mut config = Zeroizing::new(String::new());
    option(
        &mut config,
        "data-raw",
        &[std::str::from_utf8(&body).unwrap_or_default()],
    );
    let url = format!("{}{LOGIN_PATH}", call.base);
    // -D -: the reply's headers come first on stdout, kept with the body.
    let extra = ["-D", "-", "-H", "Content-Type: application/json"];
    let (status, reply) = call.curl(&extra, "POST", &url, &config, Some(secret))?;
    if !(200..300).contains(&status) {
        return Err(failed(format!("{what}: {}", http(status))));
    }
    let (cookie, csrf) = headers(&reply);
    let cookie = cookie.ok_or_else(|| failed(format!("{what}: no TOKEN cookie in the reply")))?;
    let session = Session {
        origin: call.base.to_string(),
        user: user.to_string(),
        cookie: cookie.to_string(),
        csrf: csrf.unwrap_or_default().to_string(),
        expires: now() + TTL,
    };
    save(path, &session);
    Ok(session)
}

/// The `TOKEN=...` cookie and the X-CSRF-Token of the final header block of
/// `reply` (a 1xx block before it is skipped).
fn headers(reply: &[u8]) -> (Option<&str>, Option<&str>) {
    let text = std::str::from_utf8(reply).unwrap_or_default();
    let mut rest = text;
    let mut block = "";
    while let Some(start) = rest.strip_prefix("HTTP/").map(|_| rest) {
        let end = start
            .find("\r\n\r\n")
            .map(|i| (i, 4))
            .or_else(|| start.find("\n\n").map(|i| (i, 2)));
        let Some((i, sep)) = end else {
            block = start;
            break;
        };
        block = &start[..i];
        rest = &start[i + sep..];
        let informational = block
            .split_whitespace()
            .nth(1)
            .is_some_and(|c| c.starts_with('1'));
        if !informational {
            break;
        }
    }
    let (mut cookie, mut csrf) = (None, None);
    for line in block.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("set-cookie") && value.starts_with("TOKEN=") {
            cookie = value.split(';').next().filter(|c| c.len() > "TOKEN=".len());
        } else if name.eq_ignore_ascii_case("x-csrf-token") && !value.is_empty() {
            csrf = Some(value);
        }
    }
    (cookie, csrf)
}
