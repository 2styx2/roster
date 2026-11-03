//! Live reload: calls back when a `.lua` file of the Config changes. Editors save in different
//! ways (write in place, or write a temp file and rename it over), so any event that touches a
//! `.lua` path counts, and a burst of them (one save) is one call after a short quiet, or at
//! most [`MAX_WAIT`] after the first event if they keep coming.
//!
//! Dotfile managers (stow, chezmoi) make `init.lua`, its modules or the `lua/` folder symlinks
//! into another folder, where saves happen. So the watcher also watches where each symlink
//! points: a linked file's folder (for that file only), and a linked folder (for its `.lua`
//! files). Symlinks are looked for again after every reload, so a new one is picked up.
//!
//! Tests (the `test-hooks` feature) can run the watcher on a clock they hold ([`watch_held`]),
//! so "one save is one call" and "this is ignored" don't hang on how fast the machine is (T184).

use notify::{RecursiveMode, Watcher as _};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::time::{Duration, Instant};

/// Stops watching when dropped.
pub struct Watcher {
    _inner: Arc<Mutex<notify::RecommendedWatcher>>,
}

/// How long a save's events may keep coming before the reload.
const QUIET: Duration = Duration::from_millis(150);
/// The longest a reload waits after the first event, however long events keep coming.
const MAX_WAIT: Duration = Duration::from_millis(500);

/// What the Config's symlinks point at, outside the config dir.
#[derive(Default)]
struct Targets {
    /// Linked files (canonical): an event on one of them counts.
    files: HashSet<PathBuf>,
    /// Linked folders (canonical): a `.lua` event under one counts.
    dirs: HashSet<PathBuf>,
}

impl Targets {
    fn counts(&self, roots: &[PathBuf], p: &Path) -> bool {
        let lua = p.extension().is_some_and(|e| e == "lua");
        (lua && roots.iter().chain(&self.dirs).any(|d| p.starts_with(d)))
            || self.files.contains(p)
            || canonical_parent(p).is_some_and(|c| self.files.contains(&c))
    }
}

/// `p` with its folder resolved (the file itself may be gone, renamed over).
fn canonical_parent(p: &Path) -> Option<PathBuf> {
    Some(p.parent()?.canonicalize().ok()?.join(p.file_name()?))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Watches `dir` (created if missing, so a first `init.lua` is seen) and calls `on_change` on
/// its own thread after each save of a `.lua` file of the Config.
pub fn watch(dir: &Path, on_change: impl Fn() + Send + 'static) -> notify::Result<Watcher> {
    start(dir, on_change, Clock::Real(Instant::now()), |_| {}).map(|(w, _)| w)
}

/// What the debounce thread is told: an event that counts, or (a test's held clock) time passing.
enum Msg {
    Event,
    /// The held clock moved on by this much; the sender hears once the thread has acted on it.
    #[cfg_attr(not(feature = "test-hooks"), allow(dead_code))]
    Pass(Duration, mpsc::Sender<()>),
}

/// The debounce's time: the real one, or one only a test's [`HeldClock`] moves.
enum Clock {
    /// Since this instant.
    Real(Instant),
    #[cfg_attr(not(feature = "test-hooks"), allow(dead_code))]
    Held(Duration),
}

impl Clock {
    fn now(&self) -> Duration {
        match self {
            Clock::Real(start) => start.elapsed(),
            Clock::Held(at) => *at,
        }
    }

    /// The next message within `left` of real time; a held clock waits for the test's.
    fn next(&self, rx: &mpsc::Receiver<Msg>, left: Duration) -> Option<Msg> {
        match self {
            Clock::Real(_) => rx.recv_timeout(left).ok(),
            Clock::Held(_) => rx.recv().ok(),
        }
    }

    /// A held clock moved on by `by`; the real one moves by itself.
    fn moved(self, by: Duration) -> Clock {
        match self {
            Clock::Held(at) => Clock::Held(at + by),
            real => real,
        }
    }
}

/// [`watch`] on `clock`, telling `seen` the paths of every event it has taken in, counted or
/// not, after any it counts has gone to the debounce thread. Returns a sender to that thread too.
fn start(
    dir: &Path,
    on_change: impl Fn() + Send + 'static,
    mut clock: Clock,
    seen: impl Fn(&[PathBuf]) + Send + 'static,
) -> notify::Result<(Watcher, mpsc::Sender<Msg>)> {
    std::fs::create_dir_all(dir).map_err(notify::Error::io)?;
    let root = dir.canonicalize().map_err(notify::Error::io)?;
    let targets = Arc::new(Mutex::new(Targets::default()));
    let (tx, rx) = mpsc::channel::<Msg>();
    let events = tx.clone();
    let looked = Arc::clone(&targets);
    // Events may name the dir as given or as resolved.
    let roots = vec![root.clone(), dir.to_path_buf()];
    let inner = notify::RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            if event.kind.is_access() {
                return;
            }
            let counts = {
                let t = lock(&looked);
                event.paths.iter().any(|p| t.counts(&roots, p))
            };
            if counts {
                let _ = events.send(Msg::Event);
            }
            seen(&event.paths);
        },
        // Symlinked folders are watched at their targets (below), the same way on every OS.
        notify::Config::default().with_follow_symlinks(false),
    )?;
    let inner = Arc::new(Mutex::new(inner));
    lock(&inner).watch(dir, RecursiveMode::Recursive)?;
    let mut watched = HashSet::new();
    follow_links(&root, &targets, &Arc::downgrade(&inner), &mut watched);

    let weak = Arc::downgrade(&inner);
    std::thread::spawn(move || {
        // Ends once the watcher (and with it the event sender) and any held clock are dropped.
        while let Ok(msg) = rx.recv() {
            if let Msg::Pass(by, done) = msg {
                // Time passing with no save under way: nothing to do.
                clock = clock.moved(by);
                let _ = done.send(());
                continue;
            }
            let (first, mut last) = (clock.now(), clock.now());
            let mut told = Vec::new();
            loop {
                let now = clock.now();
                let left = QUIET
                    .saturating_sub(now - last)
                    .min(MAX_WAIT.saturating_sub(now - first));
                if left.is_zero() {
                    break;
                }
                match clock.next(&rx, left) {
                    Some(Msg::Event) => last = clock.now(),
                    Some(Msg::Pass(by, done)) => {
                        clock = clock.moved(by);
                        told.push(done);
                    }
                    // Quiet for `left`, or the watcher is gone.
                    None => break,
                }
            }
            follow_links(&root, &targets, &weak, &mut watched);
            on_change();
            for done in told {
                let _ = done.send(());
            }
        }
    });
    Ok((Watcher { _inner: inner }, tx))
}

/// The clock of a watcher from [`watch_held`]: no time passes for it until the test says.
#[cfg(feature = "test-hooks")]
pub struct HeldClock {
    tx: mpsc::Sender<Msg>,
    seen: mpsc::Receiver<std::ffi::OsString>,
}

#[cfg(feature = "test-hooks")]
impl HeldClock {
    /// Waits (at most `ceiling`) until the watcher has taken in an event on a file named
    /// `name`, and so every event before it: inotify keeps one queue in order. False if not.
    pub fn seen(&self, name: &str, ceiling: Duration) -> bool {
        let deadline = Instant::now() + ceiling;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.seen.recv_timeout(left) {
                Ok(n) if n == name => return true,
                Ok(_) => {}
                Err(_) => return false,
            }
        }
    }

    /// Moves the clock on by `by`, and returns once the watcher has acted on it: a save whose
    /// quiet (or longest wait) that ends has been called back for.
    pub fn pass(&self, by: Duration) {
        let (done, wait) = mpsc::channel();
        if self.tx.send(Msg::Pass(by, done)).is_ok() {
            let _ = wait.recv();
        }
    }
}

/// [`watch`] on a clock the test holds ([`HeldClock`]): a save is called back for only once
/// the test moves the clock past its quiet. Only with the `test-hooks` feature, never in the app.
#[cfg(feature = "test-hooks")]
pub fn watch_held(dir: &Path, on_change: impl Fn() + Send + 'static) -> notify::Result<(Watcher, HeldClock)> {
    let (names, seen) = mpsc::channel();
    let (watcher, tx) = start(dir, on_change, Clock::Held(Duration::ZERO), move |paths| {
        for name in paths.iter().filter_map(|p| p.file_name()) {
            let _ = names.send(name.to_os_string());
        }
    })?;
    Ok((watcher, HeldClock { tx, seen }))
}

/// Finds the symlinks in the config dir that point outside it, and watches their targets
/// (`watched`: the folders already added). The targets lock is never held while adding a watch:
/// notify's event thread takes it, and adding a watch waits for that thread.
fn follow_links(
    root: &Path,
    targets: &Mutex<Targets>,
    watcher: &Weak<Mutex<notify::RecommendedWatcher>>,
    watched: &mut HashSet<PathBuf>,
) {
    let mut found = Targets::default();
    let mut visited = HashSet::new();
    scan(root, root, &mut found, &mut visited, 0);
    let dirs: Vec<PathBuf> = found.dirs.iter().cloned().collect();
    let parents: HashSet<PathBuf> = found
        .files
        .iter()
        .filter_map(|f| f.parent().map(Path::to_path_buf))
        .filter(|d| !dirs.iter().any(|r| d.starts_with(r)))
        .collect();
    *lock(targets) = found;
    let Some(watcher) = watcher.upgrade() else { return };
    let mut w = lock(&watcher);
    for (d, mode) in dirs
        .into_iter()
        .map(|d| (d, RecursiveMode::Recursive))
        .chain(parents.into_iter().map(|d| (d, RecursiveMode::NonRecursive)))
    {
        if !watched.contains(&d) && w.watch(&d, mode).is_ok() {
            watched.insert(d);
        }
    }
}

/// Walks `dir` (following links, each real folder once, a few levels deep) for `.lua` files and
/// folders whose real place is outside `root`.
fn scan(root: &Path, dir: &Path, found: &mut Targets, visited: &mut HashSet<PathBuf>, depth: usize) {
    let Ok(real) = dir.canonicalize() else { return };
    if depth > 8 || !visited.insert(real.clone()) {
        return;
    }
    if !real.starts_with(root) {
        found.dirs.insert(real.clone());
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(target) = path.canonicalize() else { continue };
        if target.is_dir() {
            scan(root, &path, found, visited, depth + 1);
        } else if path.extension().is_some_and(|e| e == "lua")
            && !target.starts_with(root)
            && !found.dirs.iter().any(|d| target.starts_with(d))
        {
            found.files.insert(target);
        }
    }
}
