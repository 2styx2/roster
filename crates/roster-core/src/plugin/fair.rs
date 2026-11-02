//! Fair shares of `roster serve` for Plugins (ticket 101, decision Q112g). serve answers several
//! requests at once (API 20) but can't tell a Plugin's from the app's, so the core holds each
//! Plugin to [`PLUGIN_AT_ONCE`] calls into serve at a time and all Plugins together to
//! [`PLUGINS_AT_ONCE`]: one Plugin looping calls can't take every one of serve's workers, and
//! the app always has some. A call waiting here is waiting for serve (the caller's `ServeWait`
//! counts it), so no Plugin is given up on or disabled while it's queued.

use super::Serve;
use serde_json::Value as Json;
use std::sync::{Arc, Condvar, Mutex};

/// How many calls into roster serve one Plugin may have running at once.
pub const PLUGIN_AT_ONCE: usize = 2;
/// How many all Plugins together may: serve has 8 workers (and 2 more for quick reads), so the
/// app keeps at least 4.
pub const PLUGINS_AT_ONCE: usize = 4;

/// A counting semaphore that lets callers in in the order they came (a ticket each), so a
/// Plugin's call can't be passed over again and again by later ones: at most `max` inside at once.
pub(crate) struct Gate {
    line: Mutex<Line>,
    freed: Condvar,
    max: usize,
}

#[derive(Default)]
struct Line {
    /// Inside now.
    held: usize,
    /// The next ticket to hand out, and the next one to let in.
    next: u64,
    serving: u64,
}

impl Gate {
    pub(crate) fn new(max: usize) -> Arc<Gate> {
        Arc::new(Gate {
            line: Mutex::new(Line::default()),
            freed: Condvar::new(),
            max,
        })
    }

    fn enter(&self) -> Pass<'_> {
        let mut line = self.line.lock().expect("gate");
        let ticket = line.next;
        line.next += 1;
        while ticket != line.serving || line.held >= self.max {
            line = self.freed.wait(line).expect("gate");
        }
        line.held += 1;
        line.serving += 1;
        // The next ticket may fit too.
        self.freed.notify_all();
        Pass(self)
    }

    /// How many are waiting to get in (tests).
    #[cfg(test)]
    fn waiting(&self) -> u64 {
        let line = self.line.lock().expect("gate");
        line.next - line.serving
    }
}

struct Pass<'a>(&'a Gate);

impl Drop for Pass<'_> {
    fn drop(&mut self) {
        self.0.line.lock().expect("gate").held -= 1;
        self.0.freed.notify_all();
    }
}

/// One Plugin's way into serve: its own gate first, then the one all Plugins share, so a
/// Plugin waiting for its own turn never holds a shared place.
pub(crate) struct Fair {
    pub(crate) inner: Arc<dyn Serve>,
    pub(crate) mine: Arc<Gate>,
    pub(crate) all: Arc<Gate>,
}

impl Serve for Fair {
    fn call(&self, method: &str, params: Json) -> Result<Json, String> {
        let _mine = self.mine.enter();
        let _all = self.all.enter();
        self.inner.call(method, params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Callers get in in the order they came, whatever order the OS wakes them in.
    #[test]
    fn callers_get_in_in_the_order_they_came() {
        let gate = Gate::new(1);
        let order = Arc::new(Mutex::new(Vec::new()));
        let first = gate.enter();
        let mut threads = Vec::new();
        for n in 0..6u64 {
            let (g, order) = (Arc::clone(&gate), Arc::clone(&order));
            threads.push(std::thread::spawn(move || {
                let _pass = g.enter();
                order.lock().unwrap().push(n);
            }));
            // It has its ticket before the next one comes.
            while gate.waiting() != n + 1 {
                std::thread::yield_now();
            }
        }
        drop(first);
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(*order.lock().unwrap(), (0..6).collect::<Vec<_>>());
    }
}
