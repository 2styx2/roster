//! Running a short command to its end: the core's one way to run a child process and wait for it
//! (finding the Backend, git for Packages). `roster serve` and Sessions are long-lived and have
//! their own (rpc.rs, session.rs); serve still starts through [`no_console_window`].

use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
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
    let reader = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out = reader(child.stdout.take().map(|x| Box::new(x) as Box<dyn Read + Send>));
    let err = reader(child.stderr.take().map(|x| Box::new(x) as Box<dyn Read + Send>));
    let status = match limit {
        None => child.wait()?,
        Some(limit) => {
            let deadline = Instant::now() + limit;
            loop {
                if let Some(status) = child.try_wait()? {
                    break status;
                }
                if Instant::now() >= deadline {
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
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    };
    Ok(Finished {
        status,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
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
