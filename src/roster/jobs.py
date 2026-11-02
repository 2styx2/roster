"""serve's job manager (ticket 101, decision Q112): the one place that owns background work, a Mesh run, a Discover
scan or a Host's check (ticket 108). Each job has a kind (`mesh`, `discover`, `check`) and an id within it, an action, a
state, progress (`done` of `total`, `at`), a result or an error, and a stop. One job of a kind runs at a time, or one
of a kind per Host for a kind started with `per_host` (a check). Every change of state, and its progress a
few times a second, goes out as the `job.progress` notification (NOTIFY). Closing stops every running job at once and
waits a moment for them all to wind down, so serve's exit records what they did (a Mesh job writes mesh.json).

    m = Jobs(notify)
    job = m.start("mesh", "apply", work, total=12)      # work(job) runs on a thread of its own; Busy if one runs
    job.progress(3, 12, "orion-2")                      # from work
    job.halted.is_set()                                 # work's cue to stop (stop() or close())
    m.start("check", "check", work, job_prefix="check-", host="esx-02", per_host=True)   # one per Host
    m.stop("mesh", job.job); m.close(0.8)
"""

import threading
import time
from collections import deque

PUSH_EVERY = 0.2            # s: progress goes out at most this often per job (a state change always does)
KEPT = 32                   # jobs a newer one of their slot replaced, still found by id (a poll after it ended)
INTERNAL_ERROR = -32603


class Busy(Exception):
    """A job of that kind is running: JOB."""

    def __init__(self, job):
        super().__init__(f"{job.kind} {job.job} is running")
        self.job = job


class Closed(Exception):
    """serve is closing: nothing new starts."""


class Failed(Exception):
    """Raised by a job's work: it failed with CODE and MESSAGE (and DATA), as an error response would say."""

    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


def error_of(e):
    """An exception as an error response's `{code, message, data?}`: a roster Problem or Failed keeps its code."""
    if isinstance(e, SystemExit):
        return {"code": 3, "message": (str(e.code) if e.code is not None else "exited").removeprefix("error: ")}
    code, message = getattr(e, "code", None), getattr(e, "message", None)
    if isinstance(code, int) and isinstance(message, str):
        data = getattr(e, "data", None)
        return {"code": code, "message": message, **({"data": data} if data is not None else {})}
    return {"code": INTERNAL_ERROR, "message": f"{type(e).__name__}: {e}"}


class Job:
    """One piece of background work. Its work reports progress() and watches `halted`."""

    def __init__(self, owner, kind, job, action, total, host, on_stop, on_close=None):
        self.owner, self.kind, self.job, self.action, self.host = owner, kind, job, action, host
        self.done, self.total, self.at = 0, total, None
        self.state = "running"
        self.result, self.error = None, None
        self.halted = threading.Event()
        self.on_stop, self.on_close = on_stop, on_close   # on_close: also run when serve closes (end it now)
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)   # notified when it ends, and by wake()
        self.thread = None
        self.pushed = 0.0
        self.push_lock = threading.Lock()
        self.later = None                       # the Timer that sends progress held back by PUSH_EVERY
        self.waiters = 0                        # requests waiting for it that a cancel may take away (hold)
        self.kept = False                       # asked for in the background: no waiter's cancel stops it

    def hold(self, waiting):
        """A request asks for this job: WAITING for it (it may be cancelled: let_go), or in the background (kept
        until it ends or is stopped by name)."""
        with self.lock:
            if waiting:
                self.waiters += 1
            else:
                self.kept = True

    def let_go(self):
        """A waiting request was cancelled: stop the job if nothing else wants it (no other waiter, never asked
        for in the background). True if nothing else does (it's stopped, or was stopping or over already); False if
        it goes on for another."""
        with self.lock:
            self.waiters -= 1
            last = self.waiters <= 0 and not self.kept
        if last:
            self.stop()
        return last

    def progress(self, done, total=None, at=None):
        """WORK says how far it has got: DONE of TOTAL, at AT (a Host's name, or None)."""
        with self.lock:
            self.done, self.at = done, at
            if total is not None:
                self.total = total
            now = time.monotonic()
            push = now - self.pushed >= PUSH_EVERY
            if push:
                self.pushed = now
            elif self.later is None:            # too soon: the latest goes out once PUSH_EVERY is up
                self.later = threading.Timer(PUSH_EVERY - (now - self.pushed), self.catch_up)
                self.later.daemon = True
                self.later.start()
        if push:
            self.owner.push(self)

    def catch_up(self):
        with self.lock:
            self.later = None
            if not self.running():
                return                          # its end went out already
            self.pushed = time.monotonic()
        self.owner.push(self)

    def running(self):
        return self.state in ("running", "stopping")

    def view(self):
        """What `job.progress` and `jobs.list` say about it: never the result (a Mesh plan can be megabytes)."""
        with self.lock:
            out = {"kind": self.kind, "job": self.job, "action": self.action, "state": self.state,
                   "done": self.done, "total": self.total, "at": self.at}
            if self.host is not None:
                out["host"] = self.host
            if self.error is not None:
                out["error"] = self.error
            return out

    def wait(self, timeout=None):
        """Wait for it to end: True if it has."""
        if self.thread is not None:
            self.thread.join(timeout)
        return not self.running()

    def wait_unless(self, gone):
        """Wait for it to end, or until GONE() is true (checked again at each wake()): True if it has ended."""
        with self.changed:
            while self.running() and not gone():
                self.changed.wait()
            return not self.running()

    def wake(self):
        """Have wait_unless() look at its GONE() again."""
        with self.changed:
            self.changed.notify_all()

    def stop(self):
        """Ask it to stop: True if it was running."""
        with self.lock:
            if self.state != "running":
                return False
            self.state = "stopping"
        self.owner.push(self)                   # before its work can see the stop and end
        self.halted.set()
        if self.on_stop is not None:
            try:
                self.on_stop()
            except Exception as e:              # a stop that fails doesn't stop the others
                self.owner.log(f"stopping {self.kind} {self.job} failed: {type(e).__name__}: {e}")
        return True

    def run(self, work):
        try:
            result = work(self)
        except BaseException as e:              # noqa: BLE001 - a job's failure is its state, never serve's
            with self.lock:
                self.error, self.state, self.at = error_of(e), "failed", None
                self.changed.notify_all()
        else:
            with self.lock:
                self.result, self.at = result, None
                if not self.halted.is_set():
                    self.done = self.total
                self.state = "stopped" if self.halted.is_set() else "done"
                self.changed.notify_all()
        self.owner.push(self)


class Jobs:
    """Every job serve runs, the latest of each kind kept once it's over."""

    def __init__(self, notify=None, log=None):
        self.notify, self.log = notify, log or (lambda line: None)
        self.lock = threading.Lock()
        self.latest_of = {}                     # (kind, host or None) -> its latest Job
        self.replaced = deque(maxlen=KEPT)      # the jobs a newer one of their slot replaced: get() finds them
        self.counts = {}                        # kind -> how many started
        self.closing = False

    def push(self, job):
        if self.notify is not None:
            with job.push_lock:                 # what it says and when it's sent in one go: never a stale view last
                self.notify("job.progress", job.view())

    def start(self, kind, action, work, total=0, job=None, host=None, on_stop=None, on_close=None, per_host=False,
              job_prefix=""):
        """Start WORK(job) on a thread of its own and return the Job at once. Busy if a job of KIND runs (of KIND for
        HOST, PER_HOST: one that is only stopping doesn't count, it starts nothing more); Closed once serve is
        closing. JOB is its id (else JOB_PREFIX and the next number of its kind)."""
        slot = (kind, host if per_host else None)
        with self.lock:
            if self.closing:
                raise Closed("roster serve is closing")
            running = self.latest_of.get(slot)
            if running is not None and (running.state == "running" if per_host else running.running()):
                raise Busy(running)
            if running is not None:
                self.replaced.append(running)
            self.counts[kind] = self.counts.get(kind, 0) + 1
            new = Job(self, kind, job if job is not None else f"{job_prefix}{self.counts[kind]}" if job_prefix
                      else self.counts[kind], action, total, host, on_stop, on_close)
            new.thread = threading.Thread(target=new.run, args=(work,), name=f"job-{kind}-{new.job}", daemon=True)
            self.latest_of[slot] = new
            # Started before anyone can see it (close() joins it), and its start told before anything it pushes.
            with new.push_lock:
                first = new.view()              # as it starts: its work may move on before this goes out
                new.thread.start()
                if self.notify is not None:
                    self.notify("job.progress", first)
        return new

    def latest(self, kind, host=None):
        """KIND's latest job (for HOST, of a kind started per_host)."""
        return self.latest_of.get((kind, host))

    def get(self, kind, job):
        """KIND's job JOB: a latest one, or one a newer job of its slot replaced not long ago."""
        with self.lock:
            return next((j for j in (*self.latest_of.values(), *reversed(self.replaced))
                         if j.kind == kind and j.job == job), None)

    def running(self, kind):
        """KIND's jobs still running."""
        with self.lock:
            return [j for (k, _), j in self.latest_of.items() if k == kind and j.running()]

    def list(self):
        with self.lock:
            return [j.view() for _, j in sorted(self.latest_of.items(), key=lambda kv: (kv[0][0], kv[0][1] or ""))]

    def stop(self, kind, job):
        j = self.get(kind, job)
        return j is not None and j.stop()

    def close(self, wait):
        """serve is closing: stop every running job at once, wait up to WAIT s for them all, and log each."""
        with self.lock:
            self.closing = True
            running = [j for j in (*self.latest_of.values(), *self.replaced) if j.running()]
        for j in running:
            j.stop()
            if j.on_close is not None:
                try:
                    j.on_close()
                except Exception as e:
                    self.log(f"closing {j.kind} {j.job} failed: {type(e).__name__}: {e}")
        end = time.monotonic() + wait
        for j in running:
            j.wait(max(0.0, end - time.monotonic()))
            v = j.view()
            self.log(f"closing: {j.kind} {j.job} ({j.action}) {v['state']} at {v['done']} of {v['total']}")
