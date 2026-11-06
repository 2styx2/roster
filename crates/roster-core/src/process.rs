//! Running a short command to its end: the core's one way to run a child process and wait for it
//! (finding the Backend, git for Packages). `roster serve` and Sessions are long-lived and have
//! their own (rpc.rs, session.rs); serve still starts through [`no_console_window`].

use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// What a finished command printed, and how it ended.
#[derive(Debug)]
pub struct Finished {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Runs `cmd` with stdin closed and waits at most `limit` (None: until it ends): past it the
/// process is killed and the answer is an error of kind `TimedOut`. Its output is read as it
/// comes, so a chatty process can't block on a full pipe. A spawn failure comes back as it is
/// (`NotFound`: no such program).
pub fn run(mut cmd: Command, limit: Option<Duration>) -> std::io::Result<Finished> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_console_window(&mut cmd);
    let mut child = cmd.spawn()?;
    // Each pipe is read to its end on a thread of its own, which says when it's done: both ends
    // closed is the process gone (or closing), so nothing waits on a timer.
    let (closed, ends) = mpsc::channel();
    let reader = |r: Option<Box<dyn Read + Send>>| {
        let closed = closed.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                // A read error ends the output there: what came before is still the answer.
                let _ = r.read_to_end(&mut buf);
            }
            // The receiver is gone only once run has returned, timed out: nobody wants it then.
            let _ = closed.send(());
            buf
        })
    };
    let out = reader(child.stdout.take().map(|x| Box::new(x) as Box<dyn Read + Send>));
    let err = reader(child.stderr.take().map(|x| Box::new(x) as Box<dyn Read + Send>));
    if let Some(limit) = limit {
        let deadline = Instant::now() + limit;
        for _ in 0..2 {
            if ends
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .is_err()
            {
                // Killed and reaped; one that ended meanwhile can't be killed, which is fine.
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!(
                        "{} didn't answer within {} s",
                        cmd.get_program().to_string_lossy(),
                        limit.as_secs()
                    ),
                ));
            }
        }
    }
    let status = child.wait()?;
    Ok(Finished {
        status,
        stdout: out.join().expect("a pipe reader panicked"),
        stderr: err.join().expect("a pipe reader panicked"),
    })
}

/// A GUI-subsystem exe on Windows would open a console window for every console child.
#[cfg(windows)]
pub fn no_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn no_console_window(_cmd: &mut Command) {}
