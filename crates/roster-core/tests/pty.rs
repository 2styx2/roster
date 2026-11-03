//! The session manager runs a stub command in a real PTY: output, input, resize, exit status,
//! and closing. Unix only for now: on Windows ConPTY first waits for an answer to `ESC[6n`
//! (docs/app/dev/tauri-pty-wsl.md), which these tests don't send.
#![cfg(unix)]

use roster_core::session::{Exit, SessionCommand, SessionEvent, SessionManager, Size};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

const SIZE: Size = Size { cols: 80, rows: 24 };

fn sh(script: &str) -> SessionCommand {
    SessionCommand::new(
        vec!["sh".into(), "-c".into(), script.into()],
        vec![("TERM".into(), "xterm-256color".into())],
    )
}

/// Opens `cmd` and returns its id plus a receiver of everything the sink got.
fn open(m: &SessionManager, cmd: SessionCommand) -> (u32, Receiver<SessionEvent>) {
    let (tx, rx) = channel();
    let id = m
        .open(&cmd, SIZE, move |e| {
            let _ = tx.send(e);
        })
        .expect("spawn");
    (id, rx)
}

/// How long a broken test waits before it says so (T164): never how long anything is expected to
/// take. A loaded machine pauses a process for seconds.
const CEILING: Duration = Duration::from_secs(60);

/// Collects output until `needle` shows up (or panics after [`CEILING`]).
fn output_until(rx: &Receiver<SessionEvent>, needle: &str) -> String {
    let deadline = Instant::now() + CEILING;
    let mut seen = Vec::new();
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(SessionEvent::Output(b)) => {
                seen.extend_from_slice(&b);
                let s = String::from_utf8_lossy(&seen).into_owned();
                if s.contains(needle) {
                    return s;
                }
            }
            Ok(SessionEvent::Exit(e)) => panic!(
                "exited ({e:?}) before {needle:?}; saw {:?}",
                String::from_utf8_lossy(&seen)
            ),
            Err(_) => {}
        }
    }
    panic!(
        "no {needle:?} within {CEILING:?}; saw {:?}",
        String::from_utf8_lossy(&seen)
    );
}

/// Waits for the Exit event, skipping output; returns it with the output seen on the way.
fn exit_of(rx: &Receiver<SessionEvent>) -> (Exit, String) {
    let mut seen = Vec::new();
    loop {
        match rx.recv_timeout(CEILING).expect("an Exit") {
            SessionEvent::Output(b) => seen.extend_from_slice(&b),
            SessionEvent::Exit(e) => return (e, String::from_utf8_lossy(&seen).into_owned()),
        }
    }
}

#[test]
fn streams_output_then_reports_the_exit_code() {
    let m = SessionManager::new();
    let (_, rx) = open(&m, sh("echo hello from the pty; exit 3"));
    let (exit, out) = exit_of(&rx);
    assert!(out.contains("hello from the pty"), "{out:?}");
    assert_eq!(
        exit,
        Exit {
            code: Some(3),
            closed: false
        }
    );
}

#[test]
fn input_reaches_the_command() {
    let m = SessionManager::new();
    let (id, rx) = open(&m, sh("printf 'ready> '; read line; echo \"got:$line\"; exit 0"));
    output_until(&rx, "ready> ");
    m.write(id, b"hello pty\r").unwrap();
    let (exit, out) = exit_of(&rx);
    assert!(out.contains("got:hello pty"), "{out:?}");
    assert_eq!(exit.code, Some(0));
}

#[test]
fn control_bytes_like_esc_reach_the_command_untouched() {
    let m = SessionManager::new();
    // Raw mode, as vim puts the terminal in: Esc and Ctrl+W arrive as bytes.
    let (id, rx) = open(
        &m,
        sh("stty raw -echo; printf 'raw> '; head -c 2 | od -An -tx1; exit 0"),
    );
    output_until(&rx, "raw> ");
    m.write(id, b"\x1b\x17").unwrap();
    let (_, out) = exit_of(&rx);
    assert!(out.contains("1b 17"), "{out:?}");
}

#[test]
fn resize_changes_the_size_the_command_sees() {
    let m = SessionManager::new();
    let (id, rx) = open(&m, sh("stty size; read _; stty size; exit 0"));
    output_until(&rx, "24 80");
    m.resize(id, Size { cols: 120, rows: 40 }).unwrap();
    m.write(id, b"\r").unwrap();
    let (_, out) = exit_of(&rx);
    assert!(out.contains("40 120"), "{out:?}");
}

#[test]
fn closing_kills_the_command_and_reports_closed() {
    let m = SessionManager::new();
    let (id, rx) = open(&m, sh("echo pid:$$; exec sleep 600"));
    let out = output_until(&rx, "\n");
    let pid: i32 = out.split("pid:").nth(1).unwrap().trim().parse().unwrap();
    m.close(id).unwrap();
    let (exit, _) = exit_of(&rx);
    assert!(exit.closed, "{exit:?}");
    assert!(m.is_empty());
    assert!(
        !std::path::Path::new(&format!("/proc/{pid}")).exists(),
        "sleep {pid} still running"
    );
    m.close(id).unwrap(); // closing again is fine
    assert!(m.write(id, b"x").is_err());
}

#[test]
fn an_ended_session_is_forgotten() {
    let m = SessionManager::new();
    let (id, rx) = open(&m, sh("exit 0"));
    exit_of(&rx);
    assert!(m.is_empty());
    assert!(m.resize(id, SIZE).is_err());
}
