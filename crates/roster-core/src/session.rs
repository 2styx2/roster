//! Sessions: the command `session.prepare` hands back, run in a PTY on the Backend's target.
//!
//! [`session_command`] turns a [`Prepared`] into a runnable command line (through `wsl.exe --exec`
//! on WSL, with the env on wsl.exe's process and named in `WSLENV`). [`SessionManager`] owns the running Sessions: it spawns each in a PTY,
//! streams its output to a sink, takes input and resizes, and reports how it ended. Session ids
//! belong to the manager.
//!
//! The env can hold an askpass token (ticket 06), so nothing here prints env values: the Debug
//! impls show variable names only, and no value ever goes in an argv (a process's command line is
//! readable by other processes and logged by process auditing for its whole life).

use crate::detect::Target;
pub use crate::screen::{Drawn, ScreenDiff};
use crate::screen::{Screen, Why};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

/// Forced on every Session: xterm.js is a 256-colour xterm.
pub const TERM: &str = "xterm-256color";
/// Forced on every Session: xterm.js draws 24-bit colour, and vim, bat, delta and friends only
/// use it when this says so.
pub const COLORTERM: &str = "truecolor";

/// `session.prepare`'s result (docs/serve-api.md, "Sessions: `session.prepare`").
#[derive(Clone, Deserialize)]
pub struct Prepared {
    /// What to run, as given; `argv[0]` is an absolute path.
    pub argv: Vec<String>,
    /// Variables to add. May carry a one-time askpass token: never log the values.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub host: String,
    /// "key" or "password".
    pub auth: String,
    /// What the Session connects to (serve API 25): sent back with a prompt fill, so a Host edited
    /// since isn't filled into this Session. Absent from an older serve (then nothing is filled).
    #[serde(default)]
    pub login: Option<LoginAs>,
}

/// The address, port and user a Session connected to, as `session.prepare` said.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct LoginAs {
    pub address: String,
    pub port: u16,
    pub user: String,
}

/// The Inventory Host a Session is to, and what it connected to: all a prompt fill may ask serve
/// about ([`SessionManager::fill`]). Also a nested ssh's Host, as the frontend resolved it
/// (ticket 120), read from `{host, address, port, user}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct FillTarget {
    pub host: String,
    #[serde(flatten)]
    pub login: LoginAs,
}

/// A nested ssh's Host, as the frontend resolved it (ticket 120), and which of the Session's own
/// commands that ssh is: the `run`th its own shell marked as starting, with the Session's token
/// (ticket 162). A fill for it goes only while that's still the last of those marks
/// ([`SessionManager::fill`]). Read from `{host, address, port, user, run}`; serve gets `to` only.
/// No `run` (an app from before ticket 162) is no command to match: the fill is refused.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Hop {
    #[serde(flatten)]
    pub to: FillTarget,
    #[serde(default)]
    pub run: Option<u64>,
}

impl std::fmt::Debug for Prepared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Prepared")
            .field("argv", &self.argv)
            .field("env", &self.env.keys().collect::<Vec<_>>())
            .field("host", &self.host)
            .field("auth", &self.auth)
            .field("login", &self.login)
            .finish()
    }
}

/// A command line ready to start in a PTY.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionCommand {
    /// Never holds an env value.
    pub argv: Vec<String>,
    /// Set on the process itself. On WSL this includes `WSLENV`, which carries the rest into Linux.
    pub env: Vec<(String, String)>,
    /// How the Session logs in, as `session.prepare` said: "key" or "password" (shown on the tab).
    pub auth: String,
    /// The Inventory Host the Session is to and what it connected to, as `session.prepare` said:
    /// the only Host a prompt fill may ask serve about ([`SessionManager::fill`]). None for a
    /// Quick Connect, a stub, or a serve too old to say what it connected to.
    pub fill_as: Option<FillTarget>,
    /// The token on roster's own shell marks in this Session (decision Q131 (a)), as the frontend
    /// made it for the attempt: the core follows the marks that carry it, so a nested ssh's fill
    /// goes only while that ssh runs (ticket 162). Never in a log (its Debug shows only whether
    /// there is one). None: no hop is filled.
    pub marks: Option<String>,
}

impl SessionCommand {
    /// A key-login command with no Host (tests, stub commands).
    pub fn new(argv: Vec<String>, env: Vec<(String, String)>) -> Self {
        SessionCommand {
            argv,
            env,
            auth: "key".into(),
            fill_as: None,
            marks: None,
        }
    }

    /// `text` (an error about this command) with every env value replaced by `…`, so a message
    /// that quotes the command or its environment can't show an askpass token.
    pub fn redact(&self, text: &str) -> String {
        let mut out = text.to_string();
        for (k, v) in &self.env {
            out = out.replace(&format!("{k}={v}"), &format!("{k}=…"));
        }
        for (_, v) in &self.env {
            if v.len() >= 6 {
                out = out.replace(v.as_str(), "…");
            }
        }
        out
    }
}

impl std::fmt::Debug for SessionCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let env: Vec<String> = self.env.iter().map(|(k, _)| format!("{k}=…")).collect();
        f.debug_struct("SessionCommand")
            .field("argv", &self.argv)
            .field("env", &env)
            .field("auth", &self.auth)
            .field("fill_as", &self.fill_as)
            .field("marks", &self.marks.as_ref().map(|_| "…"))
            .finish()
    }
}

/// `WSLENV` that passes `names` from wsl.exe into Linux as they are (`/u`: Windows to WSL only, no
/// `/p`, so `/run/...` paths aren't translated), after the entries already in `existing` (minus any
/// for those names, which ours replace).
pub fn wslenv<'a>(existing: Option<&str>, names: impl IntoIterator<Item = &'a str>) -> String {
    let names: Vec<&str> = names.into_iter().collect();
    let kept = existing.unwrap_or("").split(':').filter(|e| {
        let name = e.split('/').next().unwrap_or("");
        !name.is_empty() && !names.iter().any(|n| n.eq_ignore_ascii_case(name))
    });
    let ours = names.iter().map(|n| format!("{n}/u"));
    kept.map(String::from).chain(ours).collect::<Vec<_>>().join(":")
}

/// The command that opens `prepared` on `target`, with `TERM` and `COLORTERM` forced to [`TERM`]
/// and [`COLORTERM`]. That is all the app adds (decision Q37: the user's terminal config wins, so
/// no PS1, no sourced files); any other variable is `session.prepare`'s. On WSL the variables are
/// set on wsl.exe and listed in `WSLENV` (appended to the app's own), never put in the argv.
pub fn session_command(target: &Target, prepared: &Prepared) -> SessionCommand {
    let mut env = vec![
        ("TERM".to_string(), TERM.to_string()),
        ("COLORTERM".to_string(), COLORTERM.to_string()),
    ];
    env.extend(prepared.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    let argv = match target {
        Target::Local => prepared.argv.clone(),
        Target::Wsl { .. } => {
            let existing = std::env::var("WSLENV").ok();
            let list = wslenv(existing.as_deref(), env.iter().map(|(k, _)| k.as_str()));
            env.push(("WSLENV".into(), list));
            target.wrap(&prepared.argv)
        }
    };
    SessionCommand {
        argv,
        env,
        auth: prepared.auth.clone(),
        fill_as: prepared.login.clone().map(|login| FillTarget {
            host: prepared.host.clone(),
            login,
        }),
        marks: None,
    }
}

/// The core's own name for a Session.
pub type SessionId = u32;

/// A terminal size in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

impl From<Size> for PtySize {
    fn from(s: Size) -> PtySize {
        PtySize {
            rows: s.rows.max(1),
            cols: s.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

/// How a Session ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Exit {
    /// The exit code; `None` when a signal ended it.
    pub code: Option<u32>,
    /// True when the app closed it ([`SessionManager::close`]): the code is then meaningless
    /// (on Windows, closing gives `0xC000013A`).
    pub closed: bool,
}

/// What a Session's sink receives: output in order, then exactly one Exit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    Output(Vec<u8>),
    Exit(Exit),
}

#[derive(Debug)]
pub enum SessionError {
    /// No open Session has this id (it ended, or never existed).
    NotFound(SessionId),
    /// The PTY or the process failed.
    Io(String),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::NotFound(id) => write!(f, "session {id} isn't open"),
            SessionError::Io(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for SessionError {}

fn io(e: impl std::fmt::Display) -> SessionError {
    SessionError::Io(e.to_string())
}

/// Output is read in chunks of up to this many bytes (each becomes one sink call).
const READ_CHUNK: usize = 16 * 1024;
/// After the process exits, how long to wait for the PTY's last output before reporting Exit
/// anyway (a background child can hold the PTY open).
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
/// How often a reader that's waiting for output checks whether it should stop (Unix).
#[cfg(unix)]
const STOP_POLL: Duration = Duration::from_millis(100);

struct Running {
    /// Dropped (closing the PTY) once the process ends or the Session is closed.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    closed: AtomicBool,
    /// The Inventory Host it's to ([`SessionCommand::fill_as`]).
    fill_as: Option<FillTarget>,
    /// Writes sent: a fill types its secret only if none was sent while it checked the prompt.
    writes: AtomicU64,
    /// Its output as a terminal draws it, and how much of it there has been
    /// ([`SessionManager::fill`], tickets 120, 137 and 154).
    shown: Arc<Mutex<Shown>>,
    /// Its PTY is Windows' ConPTY, or a test says to take it as one (decision Q151).
    conpty: bool,
    /// While a fill checks the prompt: the keys sent meanwhile, held until it ends (the review of
    /// #299, #2). Lock it before `writer`.
    held: Mutex<Option<Vec<u8>>>,
}

/// A fill in progress on a Session: while it lives, [`SessionManager::write`] holds the keys sent;
/// dropped, it ends any mask watch and sends them, in order (the review of #299, #2 and #8).
struct Filling<'a>(&'a Running);

impl<'a> Filling<'a> {
    /// None if another fill is already checking this Session (T155 item 3).
    fn start(running: &'a Running) -> Option<Self> {
        let mut held = running.held.lock().unwrap();
        if held.is_some() {
            return None;
        }
        *held = Some(Vec::new());
        Some(Filling(running))
    }
}

impl Drop for Filling<'_> {
    fn drop(&mut self) {
        self.0.shown.lock().unwrap().screen.stop_mask_watch();
        // Under `held`, so a key sent now waits for these.
        let mut held = self.0.held.lock().unwrap();
        if let Some(keys) = held.take()
            && !keys.is_empty()
            && let Some(w) = self.0.writer.lock().unwrap().as_mut()
        {
            let _ = w.write_all(&keys).and_then(|_| w.flush());
        }
    }
}

/// What a Session has printed, as a fill checks it: the screen a terminal would draw (the
/// cursor's line for the prompt check, tickets 120 and 137; what the probe drew, ticket 154) and
/// how many bytes it has printed, under one lock, so a fill sees the screen as of exactly the
/// bytes it counted.
struct Shown {
    screen: Screen,
    /// Bytes printed so far.
    total: u64,
}

impl Shown {
    fn feed(&mut self, chunk: &[u8]) {
        self.screen.feed(chunk);
        self.total += chunk.len() as u64;
    }
}

impl Running {
    fn release_pty(&self) {
        self.writer.lock().unwrap().take();
        self.master.lock().unwrap().take();
    }
}

/// The one way into a Session's sink, keeping its contract: output in order, then exactly one
/// Exit, and nothing after it. The reader and the waiter both go through here, under one lock,
/// so output a background process writes after the Exit is dropped.
struct Gate<S> {
    exited: Mutex<bool>,
    sink: S,
}

impl<S: Fn(SessionEvent)> Gate<S> {
    fn output(&self, chunk: Vec<u8>) {
        let exited = self.exited.lock().unwrap();
        if !*exited {
            (self.sink)(SessionEvent::Output(chunk));
        }
    }

    fn exit(&self, exit: Exit) {
        let mut exited = self.exited.lock().unwrap();
        if !*exited {
            *exited = true;
            (self.sink)(SessionEvent::Exit(exit));
        }
    }
}

/// Every running Session. Cheap to share: clone the `Arc` it lives in.
pub struct SessionManager {
    next_id: AtomicU32,
    sessions: Arc<Mutex<HashMap<SessionId, Arc<Running>>>>,
    /// Its PTYs are Windows' ConPTY (decision Q151).
    conpty: bool,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::with_conpty_rules(cfg!(windows))
    }
}

impl SessionManager {
    /// Its PTYs' own rules: Windows' ConPTY's on Windows (decision Q151), the others' elsewhere.
    pub fn new() -> Self {
        Self::default()
    }

    /// With ConPTY's fill rules (decision Q151) or not, whatever the platform: the app uses
    /// [`SessionManager::new`]; tests use this to check Windows' rules on a Unix PTY.
    pub fn with_conpty_rules(conpty: bool) -> Self {
        SessionManager {
            next_id: AtomicU32::new(0),
            sessions: Arc::default(),
            conpty,
        }
    }

    /// Starts `cmd` in a new PTY of `size`. `sink` gets the output as it comes, then one Exit,
    /// from the Session's own threads. Both threads end once the Exit is out (the reader within
    /// [`STOP_POLL`] on Unix, even if a background process still holds the PTY; on Windows,
    /// closing the pseudo console ends it).
    pub fn open(
        &self,
        cmd: &SessionCommand,
        size: Size,
        sink: impl Fn(SessionEvent) + Send + Sync + 'static,
    ) -> Result<SessionId, SessionError> {
        let (program, args) = cmd
            .argv
            .split_first()
            .ok_or_else(|| SessionError::Io("empty command".into()))?;
        let pair = native_pty_system().openpty(size.into()).map_err(io)?;
        let mut builder = CommandBuilder::new(program);
        builder.args(args);
        for (k, v) in &cmd.env {
            builder.env(k, v);
        }
        let mut child = pair
            .slave
            .spawn_command(builder)
            .map_err(|e| SessionError::Io(cmd.redact(&e.to_string())))?;
        drop(pair.slave);
        let reader = Reader::new(pair.master.as_ref())?;
        let writer = pair.master.take_writer().map_err(io)?;
        let mut screen = Screen::new(size.rows, size.cols);
        // Only a token like the frontend's (96 random bits in hex): an empty or short one could be
        // guessed, so it's no token (the review of #308, #3).
        if let Some(token) = cmd.marks.as_deref().filter(|t| marks_token(t)) {
            screen.follow_marks(token);
        }
        let running = Arc::new(Running {
            killer: Mutex::new(child.clone_killer()),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            closed: AtomicBool::new(false),
            fill_as: cmd.fill_as.clone(),
            writes: AtomicU64::new(0),
            shown: Arc::new(Mutex::new(Shown { screen, total: 0 })),
            conpty: self.conpty,
            held: Mutex::new(None),
        });
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock().unwrap().insert(id, Arc::clone(&running));

        let gate = Arc::new(Gate {
            exited: Mutex::new(false),
            sink,
        });
        let stop = Arc::new(AtomicBool::new(false));
        let (drained_tx, drained) = mpsc::channel::<()>();
        let out = Arc::clone(&gate);
        let shown = Arc::clone(&running.shown);
        let reader_stop = Arc::clone(&stop);
        std::thread::Builder::new()
            .name(format!("session-{id}-read"))
            .spawn(move || {
                reader.pump(&reader_stop, |chunk| {
                    shown.lock().unwrap().feed(&chunk);
                    out.output(chunk)
                });
                let _ = drained_tx.send(());
            })
            .map_err(io)?;

        let sessions = Arc::clone(&self.sessions);
        std::thread::Builder::new()
            .name(format!("session-{id}-wait"))
            .spawn(move || {
                let status = child.wait();
                // On Windows the reader only ends once the pseudo console is closed.
                running.release_pty();
                let _ = drained.recv_timeout(DRAIN_TIMEOUT);
                stop.store(true, Ordering::SeqCst);
                sessions.lock().unwrap().remove(&id);
                let code = match &status {
                    Ok(s) if s.signal().is_none() => Some(s.exit_code()),
                    _ => None,
                };
                gate.exit(Exit {
                    code,
                    closed: running.closed.load(Ordering::SeqCst),
                });
            })
            .map_err(io)?;
        Ok(id)
    }

    /// Whether its PTYs are Windows' ConPTY, whose fill rules (decision Q151 (i)) the app follows
    /// in what it offers (ticket 162).
    pub fn conpty(&self) -> bool {
        self.conpty
    }

    fn get(&self, id: SessionId) -> Result<Arc<Running>, SessionError> {
        self.sessions
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or(SessionError::NotFound(id))
    }

    /// Sends keystrokes (or pasted text) to the Session.
    pub fn write(&self, id: SessionId, data: &[u8]) -> Result<(), SessionError> {
        let running = self.get(id)?;
        running.writes.fetch_add(1, Ordering::SeqCst);
        // While a fill checks the prompt, keys wait for it to end (the review of #299, #2).
        let mut held = running.held.lock().unwrap();
        if let Some(keys) = held.as_mut() {
            keys.extend_from_slice(data);
            return Ok(());
        }
        let mut w = running.writer.lock().unwrap();
        let w = w.as_mut().ok_or(SessionError::NotFound(id))?;
        w.write_all(data).and_then(|_| w.flush()).map_err(io)
    }

    /// Fills the password prompt the Session shows (tickets 119, 120 and 137; decisions Q129,
    /// Q131 and Q136), when the user pressed the fill key at one. `prompt` is the prompt line the
    /// frontend read off the screen; `hop` is a nested ssh's Host, as the frontend resolved it
    /// (none for the Session's own Host). In order:
    /// - the Session must be to an Inventory Host (else [`FillError::NoHost`], and nothing is
    ///   asked), and no other fill may be checking it ([`FillError::Busy`]);
    /// - under Windows' ConPTY (decision Q151 (i)), the fill must be the Session's own Host's at
    ///   sudo's own prompt for its ssh user, else [`FillError::ConPty`] and nothing is asked or
    ///   typed: ConPTY sends only what changed between its frames, so an echo of the probe can
    ///   vanish there however it's timed, and sudo's own prompt is the one whose not echoing is
    ///   sudo's contract;
    /// - from here until the fill ends, keys sent to the Session ([`SessionManager::write`]) are
    ///   held and sent after it, in order (the review of #299, #2), and refuse it
    ///   ([`FillError::Typed`]);
    /// - the cursor must sit right after `prompt` on its line, as a terminal draws the Session's
    ///   output, with nothing after it there, else [`FillError::NotPrinted`] and nothing is asked
    ///   or typed, so the frontend's word alone never sends a password to a Session that isn't
    ///   asking for it; the whole screen and the cursor are noted then;
    /// - for a `hop`, the last of the Session's own shell's marks (with its token,
    ///   [`SessionCommand::marks`]) must be the `C` that started that ssh, the shell's `hop.run`th,
    ///   else [`FillError::NotInHop`] and nothing is asked or typed (ticket 162): once that ssh has
    ///   ended or another command started, the prompt is another Host's, however it reads;
    /// - `lookup` gets the Host the Session was opened to and what it connected to, and returns
    ///   the secret (serve's `session.fill`, which judges `prompt` and `hop`); a refusal there
    ///   types nothing;
    /// - before the probe, nothing may have been printed since the check (under ConPTY, which
    ///   repaints what it already drew: what was printed must have left the whole screen and the
    ///   cursor exactly as they were, Q151 (b)), and the screen not resized, else
    ///   [`FillError::Changed`] and nothing is typed;
    /// - the probe, [`PROBE`], in two steps (Q151 (h)): Ctrl+U and the letter, `wait`, a check
    ///   with the letter pending, the last Ctrl+U (always sent, so the line ends empty), `wait`
    ///   again. A prompt that doesn't echo, as sudo's, su's and ssh's don't, prints nothing for
    ///   it; one that echoes prints the letter. So if anything was printed from the probe on, the
    ///   screen was resized, or a key was sent, the secret isn't typed ([`FillError::Echoes`],
    ///   [`FillError::Typed`]). The one exception (ticket 154, decision Q144): for the Session's
    ///   own Host, at sudo's own prompt for its ssh user, which is the whole of the cursor's line,
    ///   sudo with `pwfeedback` draws a `*` for the letter and erases it; with the letter pending
    ///   the line may be the prompt and that `*`, and at the end the mask watch must have seen at
    ///   most that `*`, cursor moves, erases within the line and the cursor's hide and show, with
    ///   the cursor and the whole screen exactly as they were ([`Screen::end_mask_watch`]).
    ///
    /// Otherwise the secret and Enter go to the PTY in one write, and the secret is wiped as it's
    /// dropped. Returns the name of the Host whose password it typed: `hop`'s, else the Session's
    /// own. The secret never leaves this call: not in a return value, an error, a log or an event.
    pub fn fill<E>(
        &self,
        id: SessionId,
        wait: Duration,
        prompt: &str,
        hop: Option<&Hop>,
        lookup: impl FnOnce(&FillTarget) -> Result<Secret, E>,
    ) -> Result<String, FillError<E>> {
        let running = self.get(id).map_err(|_| FillError::NotFound(id))?;
        let target = running.fill_as.clone().ok_or(FillError::NoHost)?;
        // sudo with `pwfeedback` draws a `*` for the probe's letter and erases it (ticket 154):
        // allowed only for the Session's own Host, at sudo's own prompt for its ssh user.
        let maskable = hop.is_none() && sudo_prompt_for(prompt, &target.login.user);
        if running.conpty && !maskable {
            return Err(FillError::ConPty);
        }
        // Keys are held from here; the guard sends them, and ends any mask watch, however the
        // fill ends (the review of #299, #2 and #8).
        let _filling = Filling::start(&running).ok_or(FillError::Busy)?;
        // Before the prompt check and the lookup, which may wait on the vault: what's printed or
        // typed from here on counts. The check reads the screen as of exactly the bytes counted.
        let writes = running.writes.load(Ordering::SeqCst);
        let (printed, checked) = {
            let shown = running.shown.lock().unwrap();
            if !shown.screen.cursor_after(prompt) {
                return Err(FillError::NotPrinted);
            }
            // Positively still in the nested ssh the frontend resolved (ticket 162): anything
            // printed after this check refuses the fill below.
            if let Some(hop) = hop
                && (hop.run.is_none() || shown.screen.own_run() != hop.run)
            {
                return Err(FillError::NotInHop);
            }
            (shown.total, shown.screen.snapshot())
        };
        let secret = lookup(&target).map_err(FillError::Lookup)?;
        // Before anything is typed (the review of #299, #3 and #4): nothing printed since the
        // check, or under ConPTY a repaint that left the whole screen and the cursor as they were
        // (ticket 155, #284); never a resize.
        let probed = {
            let mut shown = running.shown.lock().unwrap();
            let same = if running.conpty {
                shown.screen.matches(&checked)
            } else {
                shown.total == printed && !shown.screen.resized_since(&checked)
            };
            if !same {
                return Err(FillError::Changed {
                    before: shown.total - printed,
                    diff: Box::new(shown.screen.diff(&checked)),
                });
            }
            if maskable {
                shown.screen.watch_mask();
            }
            shown.total
        };
        // The probe in two steps (Q151 (h)): Ctrl+U and the letter, then, after a whole wait, the
        // last Ctrl+U. A terminal that sends only what changed between its frames would send
        // nothing for a letter echoed and taken back within one frame; left on the line for the
        // wait, an echoed letter is drawn in a frame and seen here (off ConPTY, it's seen anyway).
        let (first, last) = PROBE.split_at(PROBE_SPLIT);
        {
            let mut w = running.writer.lock().unwrap();
            let w = w.as_mut().ok_or(FillError::NotFound(id))?;
            w.write_all(first).and_then(|_| w.flush()).map_err(fill_io)?;
        }
        std::thread::sleep(wait);
        // With the letter pending: nothing printed at all, or at sudo's own prompt for the own
        // Host, the line is the prompt alone or the prompt and sudo's one `*`, the cursor right
        // after it, every other line as it was, and the mask watch has seen nothing it doesn't
        // allow; never a resize.
        let pending = {
            let mut shown = running.shown.lock().unwrap();
            let ok = !shown.screen.resized_since(&checked)
                && if maskable {
                    let s = &shown.screen;
                    let starred = format!("{} *", prompt.trim_end());
                    s.mask_pending(PROBE_KEYS)
                        && ((s.line_is(prompt) && s.cursor_after(prompt))
                            || (s.line_is(&starred) && s.cursor_after(&starred)))
                } else {
                    shown.total == probed
                };
            if ok {
                None
            } else {
                Some(maskable.then(|| shown.screen.end_mask_watch(PROBE_KEYS)))
            }
        };
        {
            // Always: it takes the letter back, so a refusal leaves the line empty.
            let mut w = running.writer.lock().unwrap();
            let w = w.as_mut().ok_or(FillError::NotFound(id))?;
            w.write_all(last).and_then(|_| w.flush()).map_err(fill_io)?;
        }
        if let Some(watched) = pending {
            return Err(FillError::Echoes(watched.map(|w| {
                let mut drawn = w.drawn;
                drawn.before = probed - printed;
                drawn.why = Why::Pending;
                drawn
            })));
        }
        std::thread::sleep(wait);
        let mut w = running.writer.lock().unwrap();
        let w = w.as_mut().ok_or(FillError::NotFound(id))?;
        {
            let mut shown = running.shown.lock().unwrap();
            let watched = maskable.then(|| shown.screen.end_mask_watch(PROBE_KEYS));
            let masked = watched.as_ref().is_some_and(|w| w.masked);
            let whole_line = shown.screen.line_is(prompt);
            let quiet = shown.total == probed || (masked && whole_line && shown.screen.cursor_after(prompt));
            if !quiet || shown.screen.resized_since(&checked) {
                // What the probe drew and which rule refused, for the log (ticket 155): only where
                // the mask could count.
                return Err(FillError::Echoes(watched.map(|w| {
                    let mut drawn = w.drawn;
                    drawn.before = probed - printed;
                    drawn.why = if masked && !whole_line { Why::Line } else { Why::Probe };
                    drawn
                })));
            }
        }
        if running.writes.load(Ordering::SeqCst) != writes {
            return Err(FillError::Typed);
        }
        let mut line = Secret(Vec::with_capacity(secret.0.len() + 1));
        line.0.extend_from_slice(&secret.0);
        line.0.push(b'\r');
        drop(secret);
        w.write_all(&line.0).and_then(|_| w.flush()).map_err(fill_io)?;
        Ok(hop.map_or(target.host, |h| h.to.host.clone()))
    }

    pub fn resize(&self, id: SessionId, size: Size) -> Result<(), SessionError> {
        let running = self.get(id)?;
        running.shown.lock().unwrap().screen.resize(size.rows, size.cols);
        let m = running.master.lock().unwrap();
        m.as_ref()
            .ok_or(SessionError::NotFound(id))?
            .resize(size.into())
            .map_err(io)
    }

    /// Ends the Session: kills the process (SIGHUP on Unix, TerminateProcess on Windows) and
    /// closes the PTY. Its Exit still arrives, with `closed: true`. Closing a Session that has
    /// already ended does nothing.
    pub fn close(&self, id: SessionId) -> Result<(), SessionError> {
        let Ok(running) = self.get(id) else {
            return Ok(());
        };
        running.closed.store(true, Ordering::SeqCst);
        let _ = running.killer.lock().unwrap().kill();
        running.release_pty();
        Ok(())
    }

    /// Closes every Session (the app is quitting).
    pub fn close_all(&self) {
        let ids: Vec<SessionId> = self.sessions.lock().unwrap().keys().copied().collect();
        for id in ids {
            let _ = self.close(id);
        }
    }

    /// How many Sessions are running.
    pub fn len(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// What a fill types at the prompt before the secret: Ctrl+U, a letter, Ctrl+U. At a prompt that
/// doesn't echo (the terminal's line discipline with echo off, as sudo sets it) the
/// first Ctrl+U silently empties what was typed there, the letter is silently taken, and the
/// last Ctrl+U silently takes it back: nothing is printed and the line is empty. At a prompt that
/// echoes, the letter is printed, which is how roster tells. It goes in two writes, a wait apart
/// (`PROBE_SPLIT`, decision Q151 (h)).
pub const PROBE: &[u8] = b"\x15x\x15";

/// Whether `prompt` is exactly sudo's own prompt for `user` (`[sudo] password for USER:`, read
/// with runs of whitespace as one and none at the ends), the one prompt where sudo's `pwfeedback`
/// mask isn't taken for an echo (ticket 154, decision Q144); the core also checks it's the whole
/// of the cursor's line. The frontend offers, and serve fills, no other sudo prompt.
fn sudo_prompt_for(prompt: &str, user: &str) -> bool {
    let words: Vec<&str> = prompt.split_whitespace().collect();
    !user.is_empty()
        && !user.chars().any(char::is_whitespace)
        && words.len() == 4
        && words[..3] == ["[sudo]", "password", "for"]
        && words[3].strip_suffix(':') == Some(user)
}

/// Whether `token` is one the core follows marks by ([`SessionCommand::marks`]): 8 to 64
/// lowercase hex characters, as the frontend's 24 are.
fn marks_token(token: &str) -> bool {
    (8..=64).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Where [`PROBE`] is split: Ctrl+U and the letter go first, the last Ctrl+U a wait later
/// (ticket 155, decision Q151 (h)).
const PROBE_SPLIT: usize = 2;

/// The printable keys in [`PROBE`]: sudo's `pwfeedback` draws a `*` for each (ticket 154).
const PROBE_KEYS: usize = 1;

/// A secret on its way from serve to a PTY: no Debug value, no Display, no Clone, no Serialize,
/// and its bytes are overwritten when it's dropped (best effort: copies serve's answer passed
/// through on the way here, such as the JSON line it came in, aren't).
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(value: String) -> Self {
        Secret(value.into_bytes())
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        for b in self.0.iter_mut() {
            // SAFETY: a valid, aligned, exclusive pointer into our own buffer.
            unsafe { std::ptr::write_volatile(b, 0) };
        }
        std::sync::atomic::compiler_fence(Ordering::SeqCst);
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(…)")
    }
}

/// Why a fill typed no secret ([`SessionManager::fill`]). None of them holds it.
#[derive(Debug)]
pub enum FillError<E> {
    /// No open Session has this id.
    NotFound(SessionId),
    /// The Session isn't to an Inventory Host (a Quick Connect): there's no Login to fill.
    NoHost,
    /// The lookup refused (serve's error: the prompt, the Login, the vault). Nothing was typed.
    Lookup(E),
    /// The Session printed something while roster checked the prompt: it echoes what's typed, or
    /// it isn't waiting quietly at a prompt (sudo's `pwfeedback` mask at its own prompt aside). Only the probe was typed, and it left the line empty.
    /// At sudo's own prompt for the Session's own Host, where the mask could have counted, it
    /// holds what the probe drew, for the log only ([`FillError::log_line`], ticket 155).
    Echoes(Option<Drawn>),
    /// A key was sent to the Session while roster checked the prompt (it was held, and sent once
    /// the fill ended).
    Typed,
    /// Between the prompt check and the probe, the Session printed something (under ConPTY:
    /// something that changed its screen or cursor) or was resized (the review of #299, #3, #4
    /// and #6): `before` bytes. Nothing was typed. `diff` says what differs on the core's screen,
    /// for the log only ([`FillError::log_line`], ticket 155c): never text.
    Changed { before: u64, diff: Box<ScreenDiff> },
    /// Under Windows' ConPTY, a prompt other than sudo's own for the Session's own Host (decision
    /// Q151 (i)): an echo can't be told there. Nothing was looked up or typed.
    ConPty,
    /// Another fill is checking this Session's prompt.
    Busy,
    /// The Session's output doesn't end with the fill's prompt (tickets 120 and 137). Nothing was
    /// looked up or typed.
    NotPrinted,
    /// A nested ssh's fill, but the Session's own shell's marks don't show that ssh still running:
    /// it ended, another command started, or the Session has no marks of its own (ticket 162).
    /// Nothing was looked up or typed.
    NotInHop,
    /// Writing to the PTY failed.
    Io(String),
}

impl<E: std::fmt::Display> std::fmt::Display for FillError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FillError::NotFound(id) => write!(f, "session {id} isn't open"),
            FillError::NoHost => f.write_str("this Session isn't to a Host of the Inventory, so roster has no Login to fill"),
            FillError::Lookup(e) => write!(f, "{e}"),
            FillError::Echoes(_) => f.write_str(
                "the prompt printed what roster typed to check it (it echoes, or it isn't a password prompt), so roster didn't fill it",
            ),
            FillError::Typed => f.write_str("a key was typed while roster checked the prompt, so roster didn't fill it"),
            FillError::Changed { .. } => f.write_str(
                "the Session's screen changed while roster checked the prompt, so roster didn't fill it",
            ),
            FillError::ConPty => f.write_str(
                "on Windows roster fills only sudo's own prompt for this Session's Host: Windows' console can hide an echo of what roster types to check a prompt, so roster can't tell this one doesn't echo; type it yourself",
            ),
            FillError::Busy => f.write_str("roster is already checking this prompt"),
            FillError::NotPrinted => f.write_str(
                "the Session isn't at that prompt now (its output doesn't end with it), so roster didn't fill it",
            ),
            FillError::NotInHop => f.write_str(
                "the Session's own shell doesn't show the ssh to that Host still running (it ended, or another command started), so roster didn't fill it",
            ),
            FillError::Io(m) => f.write_str(m),
        }
    }
}

impl<E> FillError<E> {
    /// The line for the app's log (stderr) about this refusal, if it has one: at sudo's own
    /// prompt for the Session's own Host, what the probe drew there that wasn't sudo's
    /// `pwfeedback` mask as roster takes it (ticket 155, #284), so the form a terminal (Windows'
    /// ConPTY) draws can be added. Never the message line, the State, Plugins or serve: the
    /// error's own text doesn't hold it. No printed text but `*` and space is in it ([`Drawn`]).
    /// It names the rule that refused (ticket 155): output before the probe that changed the
    /// screen, a line that isn't only sudo's prompt, or what the probe drew; and how many bytes
    /// were printed before the probe, never what they were.
    pub fn log_line(&self) -> Option<String> {
        if let FillError::Changed { before, diff } = self {
            // A count and what differs, never text (the review of #299, #3; ticket 155c).
            return Some(capped(format!(
                "prompt fill refused before the probe: what was printed after the prompt check ({before} bytes) changed the screen: {diff}"
            )));
        }
        let FillError::Echoes(Some(drawn)) = self else {
            return None;
        };
        let before = drawn.before;
        Some(match drawn.why {
            Why::Pending => format!(
                "prompt fill refused at sudo's prompt: with the probe's letter pending, the screen showed more than sudo's prompt and at most its `*`; the probe drew {drawn}{}",
                repainted(before)
            ),
            Why::Line => format!(
                "prompt fill refused at sudo's prompt: the cursor's line isn't only sudo's prompt; the probe drew {drawn}"
            ),
            Why::Probe => format!(
                "prompt fill refused at sudo's prompt: the probe drew {drawn}, not sudo's pwfeedback mask as roster takes it{}",
                repainted(before)
            ),
        })
    }
}

/// The longest log line a fill's refusal makes (ticket 155c): past it, it's cut and says so.
const LOG_MAX: usize = 1200;

/// `line`, cut to [`LOG_MAX`] bytes (on a character's boundary) with ` …(cut)` when longer.
fn capped(mut line: String) -> String {
    if line.len() > LOG_MAX {
        let mut at = LOG_MAX;
        while !line.is_char_boundary(at) {
            at -= 1;
        }
        line.truncate(at);
        line.push_str(" …(cut)");
    }
    line
}

/// The log's note that output before the probe only repainted the screen, when there was some.
fn repainted(before: u64) -> String {
    if before > 0 {
        format!("; {before} bytes printed before the probe repainted the screen as it was")
    } else {
        String::new()
    }
}

fn fill_io<E>(e: std::io::Error) -> FillError<E> {
    FillError::Io(e.to_string())
}

/// A Session's output side of the PTY.
#[cfg(unix)]
struct Reader(std::fs::File);

#[cfg(unix)]
impl Reader {
    /// Its own descriptor for the master, so it can be polled (and outlive the master's drop).
    fn new(master: &(dyn MasterPty + Send)) -> Result<Self, SessionError> {
        use std::os::fd::FromRawFd;
        let fd = master
            .as_raw_fd()
            .ok_or_else(|| SessionError::Io("the PTY has no descriptor".into()))?;
        // SAFETY: dup returns a new descriptor (or -1) that nothing else owns.
        let dup = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if dup < 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        // SAFETY: `dup` is a valid descriptor owned only by this File.
        Ok(Reader(unsafe { std::fs::File::from_raw_fd(dup) }))
    }

    /// Copies the output to `emit` in chunks until EOF, an error (EIO once the PTY closes), or
    /// `stop` is set: it waits for output at most [`STOP_POLL`] at a time, so a background
    /// process holding the PTY open can't keep it running.
    fn pump(mut self, stop: &AtomicBool, emit: impl Fn(Vec<u8>)) {
        use std::os::fd::AsRawFd;
        let mut buf = vec![0u8; READ_CHUNK];
        while !stop.load(Ordering::SeqCst) {
            let mut fds = libc::pollfd {
                fd: self.0.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one valid pollfd, for the length given.
            let ready = unsafe { libc::poll(&mut fds, 1, STOP_POLL.as_millis() as libc::c_int) };
            if ready < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return;
            }
            if ready == 0 {
                continue;
            }
            match self.0.read(&mut buf) {
                Ok(0) => return,
                Ok(n) => emit(buf[..n].to_vec()),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return,
            }
        }
    }
}

/// A Session's output side of the PTY. ConPTY's pipe can't be polled, but it ends once the
/// pseudo console is closed, which the waiter does when the process exits.
#[cfg(not(unix))]
struct Reader(Box<dyn Read + Send>);

#[cfg(not(unix))]
impl Reader {
    fn new(master: &(dyn MasterPty + Send)) -> Result<Self, SessionError> {
        master.try_clone_reader().map(Reader).map_err(io)
    }

    /// Copies the output to `emit` in chunks until EOF or an error. `stop` isn't needed: the
    /// read fails once the pseudo console is closed.
    fn pump(mut self, _stop: &AtomicBool, emit: impl Fn(Vec<u8>)) {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match self.0.read(&mut buf) {
                Ok(0) => return,
                Ok(n) => emit(buf[..n].to_vec()),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::time::Instant;

    /// Ticket 155c: what a Session prints in strings (an OSC 0 title, an OSC 8 hyperlink, an
    /// OSC 4 palette change, a DCS) and in text never reaches the log line of a refusal before
    /// the probe: only counts, positions, SGR numbers and sequences' names.
    #[test]
    fn a_changed_log_line_never_holds_a_strings_text() {
        let mut screen = Screen::new(24, 80);
        screen.feed(b"$ sudo -v\r\n[sudo] password for ops: ");
        let shot = screen.snapshot();
        screen.feed(
            b"\x1b]0;hunter2 s3cr3t title\x07\x1b]8;id=tok3n;https://vault.example/?token=s3cr3t\x1b\\hunter2 link\x1b]8;;\x1b\\\x1b]4;1;rgb:hu/nt/er\x07\x1bPq;s3cr3t\x1b\\\x1b[3;1Hhunter2\x1b[2;26H",
        );
        let err: FillError<()> = FillError::Changed {
            before: 9,
            diff: Box::new(screen.diff(&shot)),
        };
        let line = err.log_line().unwrap();
        // Its Debug too (the second review of #318, #5).
        let debug = format!("{err:?}");
        for word in [
            "hunter", "s3cr3t", "secret", "title", "vault", "example", "token", "tok3n", "link", "rgb", "id=",
        ] {
            assert!(!line.contains(word), "{word} in {line}");
            assert!(!debug.contains(word), "{word} in {debug}");
        }
        assert_eq!(
            line,
            "prompt fill refused before the probe: what was printed after the prompt check (9 bytes) changed the screen: row 2 characters (columns 26-37); row 3 characters (columns 1-7); unmodelled: palette change"
        );
    }

    /// Ticket 155c: a refusal's log line is at most [`LOG_MAX`] bytes and says when it was cut.
    #[test]
    fn a_long_log_line_is_cut_and_says_so() {
        assert_eq!(capped("short".into()), "short");
        let long = capped("é".repeat(LOG_MAX));
        assert!(long.ends_with(" …(cut)"), "{long}");
        assert!(long.len() <= LOG_MAX + " …(cut)".len(), "{}", long.len());
    }

    /// Ticket 162 (#284 item 4): a fill that finds the PTY's writer gone (the Session closed while
    /// it checked, after the mask watch started) leaves no fill state set: no mask watch, no keys
    /// held, nothing that makes the next fill Busy.
    #[cfg(unix)]
    #[test]
    fn a_fill_whose_writer_is_gone_leaves_no_fill_state() {
        let m = SessionManager::with_conpty_rules(false);
        let mut cmd = SessionCommand::new(
            vec![
                "sh".into(),
                "-c".into(),
                "trap '' HUP; stty -echo; printf '[sudo] password for ops: '; sleep 5".into(),
            ],
            vec![],
        );
        cmd.fill_as = Some(FillTarget {
            host: "esx".into(),
            login: LoginAs {
                address: "10.0.0.6".into(),
                port: 22,
                user: "ops".into(),
            },
        });
        let id = m.open(&cmd, Size { cols: 80, rows: 24 }, |_| {}).unwrap();
        let running = m.get(id).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !running
            .shown
            .lock()
            .unwrap()
            .screen
            .cursor_after("[sudo] password for ops:")
        {
            assert!(std::time::Instant::now() < deadline, "no prompt");
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(100));
        let got = m.fill(id, Duration::from_millis(50), "[sudo] password for ops:", None, |_| {
            m.close(id).unwrap();
            Ok::<_, String>(Secret::new("pw".into()))
        });
        assert!(matches!(got, Err(FillError::NotFound(_))), "{got:?}");
        assert!(running.held.lock().unwrap().is_none(), "keys still held");
        assert!(
            !running.shown.lock().unwrap().screen.watching_mask(),
            "mask watch still on"
        );
        assert!(running.writer.lock().unwrap().is_none());
    }

    #[test]
    fn the_mask_counts_only_at_sudos_own_prompt_for_the_user() {
        for (prompt, user, ok) in [
            ("[sudo] password for ops:", "ops", true),
            ("  [sudo]  password for ops: ", "ops", true),
            ("[sudo] password for root:", "ops", false),
            ("[sudo] password for ops:", "root", false),
            ("[sudo] password for ops", "ops", false),
            ("[sudo] password for ops: x", "ops", false),
            ("x [sudo] password for ops:", "ops", false),
            ("[sudo] Password for ops:", "ops", false),
            ("Password:", "ops", false),
            ("ops@esx-02's password:", "ops", false),
            ("[sudo] password for :", "", false),
            ("[sudo] password for o ps:", "o ps", false),
        ] {
            assert_eq!(sudo_prompt_for(prompt, user), ok, "{prompt:?} for {user:?}");
        }
    }

    /// A Session's PTY writer that passes every write on and notes when it came: the probe's
    /// writes timed where they're made, not where a stand-in Host reads them (T161).
    #[cfg(unix)]
    struct Tap {
        inner: Box<dyn Write + Send>,
        seen: Arc<Mutex<Vec<Written>>>,
    }

    /// One write to the PTY, and when it was made.
    #[cfg(unix)]
    type Written = (Instant, Vec<u8>);

    #[cfg(unix)]
    impl Write for Tap {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.seen.lock().unwrap().push((Instant::now(), buf.to_vec()));
            self.inner.write(buf)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.inner.flush()
        }
    }

    /// The probe goes in two writes a whole wait apart: Ctrl+U and the letter, then the last
    /// Ctrl+U (Q151 (h)). Timed by the writer's own clock: a stand-in Host that reads the
    /// first write late under load sees the two closer together than they were written (T161,
    /// pty_fill.rs's `the_probe_goes_in_two_steps_with_a_wait_between` checks the bytes).
    #[cfg(unix)]
    #[test]
    fn the_probes_two_writes_are_a_whole_wait_apart() {
        use std::sync::mpsc::channel;
        let wait = Duration::from_millis(300);
        let mut cmd = SessionCommand::new(
            vec![
                "sh".into(),
                "-c".into(),
                "stty raw -echo; printf 'Password: '; sleep 30".into(),
            ],
            vec![],
        );
        cmd.fill_as = Some(FillTarget {
            host: "esx".into(),
            login: LoginAs {
                address: "10.0.0.6".into(),
                port: 22,
                user: "ops".into(),
            },
        });
        let m = SessionManager::with_conpty_rules(false);
        let (tx, rx) = channel();
        let id = m
            .open(&cmd, Size { cols: 80, rows: 24 }, move |e| {
                let _ = tx.send(e);
            })
            .expect("spawn");
        let mut printed = Vec::new();
        while !String::from_utf8_lossy(&printed).contains("Password: ") {
            // The ceiling is only how long a broken test takes to say so.
            match rx.recv_timeout(Duration::from_secs(60)).expect("no prompt") {
                SessionEvent::Output(b) => printed.extend_from_slice(&b),
                other => panic!("{other:?} before the prompt"),
            }
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        {
            let running = m.get(id).unwrap();
            let mut w = running.writer.lock().unwrap();
            let inner = w.take().unwrap();
            *w = Some(Box::new(Tap {
                inner,
                seen: Arc::clone(&seen),
            }));
        }
        let typed = m.fill(id, wait, "Password:", None, |_| {
            Ok::<_, String>(Secret::new("s3cret-pw".into()))
        });
        m.close(id).unwrap();
        assert_eq!(typed.ok().as_deref(), Some("esx"));
        let seen = seen.lock().unwrap();
        let (first, last) = PROBE.split_at(PROBE_SPLIT);
        assert_eq!(
            seen[..2].iter().map(|(_, b)| b.as_slice()).collect::<Vec<_>>(),
            [first, last]
        );
        let gap = seen[1].0 - seen[0].0;
        assert!(gap >= wait, "the last Ctrl+U was written {gap:?} after the letter");
    }
}
