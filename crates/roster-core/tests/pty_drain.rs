//! A Session whose command leaves a background process holding the PTY: the sink still gets
//! exactly one Exit, last, and the Session's reader thread ends instead of pumping forever.
//! Its own test binary, so no other test's `session-1-read` thread is in the process.
#![cfg(target_os = "linux")]

use roster_core::session::{SessionCommand, SessionEvent, SessionManager, Size};
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

mod common;

/// Names of this process's threads (Linux keeps them in /proc/self/task/*/comm).
fn thread_names() -> Vec<String> {
    std::fs::read_dir("/proc/self/task")
        .unwrap()
        .filter_map(|t| std::fs::read_to_string(t.ok()?.path().join("comm")).ok())
        .map(|s| s.trim().to_string())
        .collect()
}

/// How long a broken test waits before it says so (T164): never how long anything is expected to
/// take.
const CEILING: Duration = Duration::from_secs(60);

#[test]
fn a_background_process_holding_the_pty_gets_no_output_past_the_exit_and_no_reader_left() {
    let m = SessionManager::new();
    let dir = common::temp("pty-drain");
    let (go, printed) = (dir.join("go"), dir.join("printed"));
    // The background job ignores the SIGHUP the shell's exit sends (the trap is set before the
    // fork, so it's inherited) and keeps the PTY open. Once the test has the Exit, it prints
    // again, says so, and holds the PTY past the end of the test (T164: on the test's word, not
    // 4 s after the start, which a loaded machine can bring before the drain timeout ends).
    let script = format!(
        "trap '' HUP; (while [ ! -e '{go}' ]; do sleep 0.01; done; echo late-output; : > '{printed}'; exec sleep 30) & echo bg:$!; exit 0",
        go = go.display(),
        printed = printed.display()
    );
    let cmd = SessionCommand::new(vec!["sh".into(), "-c".into(), script], vec![]);
    let (tx, rx) = channel();
    let id = m
        .open(&cmd, Size { cols: 80, rows: 24 }, move |e| {
            let _ = tx.send(e);
        })
        .unwrap();

    let mut events = Vec::new();
    while !matches!(events.last(), Some(SessionEvent::Exit(_))) {
        events.push(rx.recv_timeout(CEILING).expect("an Exit"));
    }
    std::fs::write(&go, "").unwrap();
    let deadline = Instant::now() + CEILING;
    while !printed.exists() {
        assert!(Instant::now() < deadline, "the background job never printed");
        std::thread::sleep(Duration::from_millis(1));
    }
    // The reader ends within its stop poll of the Exit, however busy the machine; once it has,
    // nothing more can come.
    let reader = format!("session-{id}-read");
    let mut threads = thread_names();
    while threads.contains(&reader) {
        assert!(Instant::now() < deadline, "{reader} still running: {threads:?}");
        std::thread::sleep(Duration::from_millis(1));
        threads = thread_names();
    }
    events.extend(rx.try_iter());
    let out: String = events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::Output(b) => Some(String::from_utf8_lossy(b).into_owned()),
            _ => None,
        })
        .collect();
    let bg = out.split("bg:").nth(1).and_then(|r| r.split_whitespace().next());
    if let Some(pid) = bg {
        let _ = std::process::Command::new("kill").arg(pid).status();
    }
    let exits = events.iter().filter(|e| matches!(e, SessionEvent::Exit(_))).count();
    assert_eq!(exits, 1, "{events:?}");
    assert!(matches!(events.last(), Some(SessionEvent::Exit(_))), "{events:?}");
    assert!(!out.contains("late-output"), "{out:?}");
}
