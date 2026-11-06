//! The end-to-end bridge (the `bridge` feature, never in the app): the [`Shell`]'s commands over
//! one WebSocket on 127.0.0.1, so the real frontend runs in a headless browser against the real
//! core and `roster serve` (app/e2e/fullstack, docs/app/dev/testing.md). It plays Tauri's part and
//! no more: a command's arguments by their camelCase names as `invoke` sends them, its result or
//! error as Tauri serializes them, a `Channel` argument as `{"__channel": ID}` whose messages come
//! back on the socket, and every event the shell emits sent to every page.
//!
//! The page sends `{"id", "cmd", "args"}`; the bridge answers `{"id", "ok"}` or `{"id", "err"}`,
//! and sends `{"event", "payload"}` and `{"channel", "message"}` (JSON) or `{"channel", "bytes"}`
//! (a Session's raw output) as they come. A connection needs the token the bridge printed.

use super::{Emit, Shell};
use crate::session::{ExitMessage, SessionEvent, Size};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};

/// Why a command didn't answer with its own result or error.
#[derive(Debug, PartialEq)]
pub enum Failure {
    /// No such command (Tauri: "command X not found").
    Unknown,
    /// An argument is missing or of the wrong type (Tauri: "invalid args").
    Args(String),
    /// The command's own error, as Tauri would serialize it.
    Command(Value),
}

fn to_value(v: impl serde::Serialize) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

fn answer<T: serde::Serialize, E: serde::Serialize>(r: Result<T, E>) -> Result<Value, Failure> {
    r.map(to_value).map_err(|e| Failure::Command(to_value(e)))
}

/// Argument `name` (camelCase, as `invoke` names it); a missing one is null, which an `Option`
/// takes as None.
fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, Failure> {
    let v = args.get(name).cloned().unwrap_or(Value::Null);
    serde_json::from_value(v).map_err(|e| Failure::Args(format!("invalid args `{name}`: {e}")))
}

/// A `Channel` argument's id.
fn channel_id(args: &Value, name: &str) -> Result<u64, Failure> {
    args.get(name)
        .and_then(|c| c.get("__channel"))
        .and_then(Value::as_u64)
        .ok_or_else(|| Failure::Args(format!("invalid args `{name}`: not a channel")))
}

/// What a command sends on a `Channel`: JSON, or raw bytes (a Session's output).
pub enum Message {
    Json(Value),
    Bytes(Vec<u8>),
}

/// Where a command's `Channel` messages go: the channel's id and the message.
pub type Channels = Arc<dyn Fn(u64, Message) + Send + Sync>;

/// Runs command `cmd` with `args` as the shell's `#[tauri::command]` of that name would.
pub fn dispatch(shell: &Shell, cmd: &str, args: &Value, channels: &Channels) -> Result<Value, Failure> {
    let size = || -> Result<Size, Failure> {
        Ok(Size {
            cols: arg(args, "cols")?,
            rows: arg(args, "rows")?,
        })
    };
    let session_sink = |name: &str| -> Result<_, Failure> {
        let (id, channels) = (channel_id(args, name)?, Arc::clone(channels));
        Ok(move |event: SessionEvent| match event {
            SessionEvent::Output(bytes) => channels(id, Message::Bytes(bytes)),
            SessionEvent::Exit(exit) => channels(id, Message::Json(to_value(ExitMessage { exit }))),
        })
    };
    match cmd {
        "backend_connect" => answer(shell.backend_connect(arg(args, "restart")?)),
        // The dialog's params are always an object (tauri.ts), which a test can refuse.
        "inventory_create" => {
            let params: serde_json::Map<String, Value> = arg(args, "params")?;
            answer(shell.inventory_create(Value::Object(params)))
        }
        "inventory_create_cancel" => Ok(Value::Bool(shell.inventory_create_cancel())),
        "open_url" => answer(shell.open_url(&arg::<String>(args, "url")?)),
        "serve_call" => answer(shell.serve_call(&arg::<String>(args, "method")?, arg(args, "params")?)),
        "host_check" => {
            let (id, channels) = (channel_id(args, "started")?, Arc::clone(channels));
            answer(shell.host_check(&arg::<String>(args, "host")?, |s| {
                channels(id, Message::Json(to_value(s)))
            }))
        }
        "host_check_stop" => answer(shell.host_check_stop(&arg::<String>(args, "job")?)),
        "host_key_trust" => {
            answer(shell.host_key_trust(&arg::<String>(args, "host")?, &arg::<String>(args, "fingerprint")?))
        }
        "folders_read" => answer(shell.folders_read()),
        "session_open" => answer(shell.session_open(
            arg(args, "host")?,
            arg(args, "password")?,
            arg(args, "save")?,
            arg(args, "marks")?,
            size()?,
            session_sink("events")?,
        )),
        "quick_session_open" => answer(shell.quick_session_open(
            arg(args, "to")?,
            arg(args, "password")?,
            arg(args, "save")?,
            size()?,
            session_sink("events")?,
        )),
        "session_write" => answer(shell.session_write(arg(args, "id")?, &arg::<String>(args, "data")?)),
        "session_fill" => {
            answer(shell.session_fill(arg(args, "id")?, &arg::<String>(args, "prompt")?, arg(args, "hop")?))
        }
        "session_resize" => answer(shell.session_resize(arg(args, "id")?, size()?)),
        "session_close" => answer(shell.session_close(arg(args, "id")?)),
        "state_load" => answer(shell.state_load()),
        "state_save" => answer(shell.state_save(&arg::<Value>(args, "state")?)),
        "platform_info" => Ok(to_value(shell.platform_info())),
        "config_load" => Ok(to_value(shell.config_load())),
        "config_open" => answer(shell.config_open()),
        "config_reload" => Ok(to_value(shell.config_reload())),
        "config_import_preview" => answer(shell.config_import_preview()),
        "config_import_apply" => answer(shell.config_import_apply(&arg(args, "previewed")?)),
        "config_types" => answer(shell.config_types()),
        "plugin_manifest" => answer(shell.plugin_manifest(&arg::<String>(args, "path")?)),
        "plugin_types" => answer(shell.plugin_types(&arg::<String>(args, "path")?)),
        "plugin_load" => answer(shell.plugin_load(
            &arg::<String>(args, "path")?,
            &arg::<Vec<String>>(args, "grants")?,
            arg(args, "settings")?,
            arg(args, "builtins")?,
            arg(args, "onDemo")?,
        )),
        "plugin_call" => answer(shell.plugin_call(
            &arg::<String>(args, "plugin")?,
            arg(args, "handler")?,
            arg(args, "args")?,
            arg(args, "by")?,
            arg(args, "builtins")?,
            arg(args, "onDemo")?,
        )),
        "plugin_event" => answer(shell.plugin_event(
            arg(args, "name")?,
            arg(args, "payload")?,
            arg(args, "builtins")?,
            arg(args, "onDemo")?,
        )),
        "plugin_sessions" => answer(shell.plugin_sessions(arg(args, "open")?, arg(args, "onDemo")?)),
        "plugin_unload" => Ok(Value::Bool(
            shell.plugin_unload(&arg::<String>(args, "plugin")?, arg(args, "onDemo")?),
        )),
        "plugin_forget" => answer(shell.plugin_forget(&arg::<String>(args, "plugin")?, arg(args, "onDemo")?)),
        "plugin_demo_start" => answer(shell.plugin_demo_start(arg(args, "hosts")?)),
        "plugin_demo_stop" => answer(shell.plugin_demo_stop(arg(args, "id")?)),
        "plugin_requests" => Ok(to_value(shell.plugin_requests())),
        "plugin_data" => answer(shell.plugin_data(arg(args, "names")?)),
        "packages_sync" => answer(shell.packages_sync()),
        "packages_pin" => answer(shell.packages_pin(&arg::<String>(args, "name")?)),
        "packages_discard" => answer(shell.packages_discard(&arg::<String>(args, "name")?)),
        "packages_remove" => answer(shell.packages_remove(&arg::<String>(args, "name")?)),
        "packages_check" => answer(shell.packages_check(arg::<Option<String>>(args, "name")?.as_deref())),
        "packages_apply" => {
            answer(shell.packages_apply(&arg::<String>(args, "name")?, &arg::<String>(args, "commit")?))
        }
        "packages_clean" => answer(shell.packages_clean()),
        _ => Err(Failure::Unknown),
    }
}

/// The pages connected now: each one's outgoing text messages.
#[derive(Clone, Default)]
pub struct Pages(Arc<Mutex<Vec<Sender<String>>>>);

impl Pages {
    /// The Shell's [`Emit`]: an event goes to every page (one that has gone is dropped).
    pub fn emitter(&self) -> Emit {
        let pages = self.clone();
        Arc::new(move |event: &str, payload: Value| {
            pages.send_all(&json!({ "event": event, "payload": payload }).to_string())
        })
    }

    fn send_all(&self, text: &str) {
        self.0.lock().unwrap().retain(|p| p.send(text.to_string()).is_ok());
    }

    fn add(&self, page: Sender<String>) {
        self.0.lock().unwrap().push(page);
    }
}

/// Answers connections on `listener` until the process ends, one thread per page.
pub fn serve(listener: TcpListener, token: String, shell: Arc<Shell>, pages: Pages) {
    for stream in listener.incoming().flatten() {
        let (shell, pages, token) = (Arc::clone(&shell), pages.clone(), token.clone());
        std::thread::spawn(move || {
            if let Err(e) = page(stream, &token, shell, &pages) {
                eprintln!("bridge: {e}");
            }
        });
    }
}

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

fn page(stream: TcpStream, token: &str, shell: Arc<Shell>, pages: &Pages) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut head = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" || head.len() > 64 {
            break;
        }
        head.push(line.trim_end().to_string());
    }
    let mut out = stream;
    let target = head.first().and_then(|l| l.split(' ').nth(1)).unwrap_or("");
    let given = target
        .split_once("token=")
        .map(|(_, t)| t.split('&').next().unwrap_or(""));
    let key = head.iter().find_map(|h| {
        let (name, value) = h.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("sec-websocket-key")
            .then(|| value.trim().to_string())
    });
    let (Some(key), Some(given)) = (key, given) else {
        return out.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
    };
    if given != token {
        return out.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    }
    let digest = ring::digest::digest(
        &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
        format!("{key}{WS_GUID}").as_bytes(),
    );
    write!(
        out,
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Accept: {}\r\n\r\n",
        base64(digest.as_ref())
    )?;
    let (tx, rx) = channel::<String>();
    pages.add(tx.clone());
    std::thread::spawn(move || {
        for text in rx {
            if write_frame(&mut out, 0x1, text.as_bytes()).is_err() {
                break;
            }
        }
    });
    let channels: Channels = {
        let tx = tx.clone();
        Arc::new(move |id, message| {
            let text = match message {
                Message::Json(m) => json!({ "channel": id, "message": m }),
                Message::Bytes(b) => json!({ "channel": id, "bytes": b }),
            };
            let _ = tx.send(text.to_string());
        })
    };
    let mut message = Vec::new();
    loop {
        let (fin, opcode, payload) = read_frame(&mut reader)?;
        match opcode {
            0x8 => return Ok(()),
            0x0..=0x2 => message.extend_from_slice(&payload),
            _ => continue,
        }
        if !fin {
            continue;
        }
        let request: Value = serde_json::from_slice(&std::mem::take(&mut message)).unwrap_or(Value::Null);
        let (shell, tx, channels) = (Arc::clone(&shell), tx.clone(), Arc::clone(&channels));
        std::thread::spawn(move || {
            let id = request.get("id").cloned().unwrap_or(Value::Null);
            let cmd = request.get("cmd").and_then(Value::as_str).unwrap_or("");
            let args = request.get("args").cloned().unwrap_or(json!({}));
            let reply = match dispatch(&shell, cmd, &args, &channels) {
                Ok(v) => json!({ "id": id, "ok": v }),
                Err(Failure::Command(e)) => json!({ "id": id, "err": e }),
                Err(Failure::Args(m)) => json!({ "id": id, "err": format!("command {cmd}: {m}") }),
                Err(Failure::Unknown) => json!({ "id": id, "err": format!("command {cmd} not found") }),
            };
            let _ = tx.send(reply.to_string());
        });
    }
}

fn read_frame(r: &mut impl Read) -> std::io::Result<(bool, u8, Vec<u8>)> {
    let mut h = [0u8; 2];
    r.read_exact(&mut h)?;
    let (fin, opcode, masked) = (h[0] & 0x80 != 0, h[0] & 0x0f, h[1] & 0x80 != 0);
    let len = match h[1] & 0x7f {
        126 => {
            let mut b = [0u8; 2];
            r.read_exact(&mut b)?;
            u16::from_be_bytes(b) as u64
        }
        127 => {
            let mut b = [0u8; 8];
            r.read_exact(&mut b)?;
            u64::from_be_bytes(b)
        }
        n => n as u64,
    };
    let mut mask = [0u8; 4];
    if masked {
        r.read_exact(&mut mask)?;
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload)?;
    if masked {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
    }
    Ok((fin, opcode, payload))
}

fn write_frame(w: &mut impl Write, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut frame = vec![0x80 | opcode];
    match payload.len() {
        n if n < 126 => frame.push(n as u8),
        n if n <= u16::MAX as usize => {
            frame.push(126);
            frame.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            frame.push(127);
            frame.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    frame.extend_from_slice(payload);
    w.write_all(&frame)
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            s.push(if i <= chunk.len() {
                ABC[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    s
}

/// A fresh random token, hex.
pub fn token() -> String {
    let mut b = [0u8; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut b).expect("the OS's random numbers");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_rfc_6455s_example() {
        let d = ring::digest::digest(
            &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
            format!("dGhlIHNhbXBsZSBub25jZQ=={}", super::WS_GUID).as_bytes(),
        );
        assert_eq!(super::base64(d.as_ref()), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        assert_eq!(super::base64(b"ab"), "YWI=");
        assert_eq!(super::base64(b"a"), "YQ==");
    }
}
