//! askpass: hand a password to a child ssh without argv, environment, file
//! or terminal. roster listens on a Unix socket in a private directory and
//! starts ssh with `SSH_ASKPASS` set to roster itself; ssh runs that helper,
//! which connects, reads the password and prints it for ssh.

use crate::vault::Secret;
use std::io::{self, Read, Write};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use zeroize::Zeroizing;

/// Set for the helper: the socket path. Its presence makes roster the helper.
pub const VAR: &str = "ROSTER_ASKPASS";

/// The private directory, removed when dropped (so on every error too).
struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn private_dir() -> io::Result<Dir> {
    let base = ["XDG_RUNTIME_DIR", "TMPDIR"]
        .iter()
        .find_map(|v| std::env::var_os(v).filter(|v| !v.is_empty()))
        .map_or_else(|| PathBuf::from("/tmp"), PathBuf::from);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let path = base.join(format!("roster-{}-{n}-{nanos:x}", std::process::id()));
    // Fails if the path exists, so nothing planted there is reused.
    std::fs::DirBuilder::new().mode(0o700).create(&path)?;
    Ok(Dir(path))
}

/// How long askpass listens for ssh's ask; after that ssh runs on without it.
const TTL: Duration = Duration::from_secs(60);

/// Run `ssh` (a prepared command) as a child that gets `secret` through
/// askpass, and return its exit status. Serves at most one connection, then
/// removes the socket's directory; a second ask from ssh fails, as does a
/// first one after TTL.
pub fn run(ssh: Command, secret: &Secret) -> io::Result<ExitStatus> {
    run_with(ssh, secret, |_| ())
}

/// `run`, calling `started` with the child as soon as it is spawned, so the
/// caller can take its piped output while askpass serves.
pub fn run_with(
    mut ssh: Command,
    secret: &Secret,
    started: impl FnOnce(&mut Child),
) -> io::Result<ExitStatus> {
    let dir = private_dir()?;
    let socket = dir.0.join("s");
    let listener = UnixListener::bind(&socket)?;
    listener.set_nonblocking(true)?;
    if let Some(var) = &secret.from_env {
        ssh.env_remove(var);
    }
    ssh.env("SSH_ASKPASS", std::env::current_exe()?)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env(VAR, &socket);
    let mut child = ssh.spawn()?;
    started(&mut child);
    let until = std::time::Instant::now() + TTL;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false)?;
                // ssh may have given up; its status is what matters.
                let _ = stream.write_all(secret.expose().as_bytes());
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                if let Some(status) = child.try_wait()? {
                    return Ok(status);
                }
                if std::time::Instant::now() >= until {
                    break; // no ask in time: stop listening, just wait
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        }
    }
    drop(listener);
    drop(dir);
    child.wait()
}

/// Helper mode (`$ROSTER_ASKPASS` set): print the password for a password
/// prompt (argv[1]); refuse anything else, such as a host-key question.
pub fn helper(socket: std::ffi::OsString) -> std::process::ExitCode {
    use std::process::ExitCode;
    let prompt = std::env::args_os().nth(1).unwrap_or_default();
    let prompt = prompt.to_string_lossy().to_lowercase();
    if !(prompt.contains("password") || prompt.contains("passphrase")) {
        eprintln!("roster: askpass: not a password prompt; refused");
        return ExitCode::from(1);
    }
    let mut password = Zeroizing::new(Vec::with_capacity(1024));
    let got = std::os::unix::net::UnixStream::connect(socket)
        .and_then(|mut s| s.read_to_end(&mut password));
    match got {
        Ok(_) if !password.is_empty() => {
            // One write ending in a newline goes straight through stdout's
            // line buffer, so no unwiped copy stays behind.
            password.push(b'\n');
            let mut out = io::stdout().lock();
            match out.write_all(&password).and_then(|()| out.flush()) {
                Ok(()) => ExitCode::SUCCESS,
                Err(_) => ExitCode::from(1),
            }
        }
        _ => {
            eprintln!("roster: askpass: no password to give");
            ExitCode::from(1)
        }
    }
}
