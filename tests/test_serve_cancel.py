"""Cancelling a request (ticket 108, decision Q112 (p)): `$/cancel {id}` stops a request that hasn't done anything
yet (queued behind busy workers, or waiting for a lock) and a running check or waiting Mesh run (their job stops at its
next step); it never stops what writes roster.yml or the vault once it has started, nor vault.lock or vault.logout.
And an unlock is never overtaken by the vault.status asked after it (Q112 (r)). Every interleaving here is forced with
events; nothing sleeps to make it happen."""
import json
import threading
import time

import pytest

from roster import serve as rpc

INVENTORY = """\
defaults:
  user: admin
groups:
  lab:
    hosts:
      esx-02: 10.0.0.12
"""


@pytest.fixture
def state(write_config):
    return rpc.State(str(write_config(INVENTORY)))


class Out(list):
    """What the Server sent, with a way to wait for an answer."""

    def __init__(self):
        super().__init__()
        self.cond = threading.Condition()

    def __call__(self, message):
        with self.cond:
            self.append(message)
            self.cond.notify_all()

    def answer(self, rid, seconds=5):
        with self.cond:
            assert self.cond.wait_for(lambda: any(m.get("id") == rid for m in self), seconds), f"no answer to {rid}"
            return next(m for m in self if m.get("id") == rid)

    def answered(self, rid):
        with self.cond:
            return any(m.get("id") == rid for m in self)


def req(rid, method, params=None):
    return json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


def cancel(server, rid, cid=None):
    """$/cancel as a request (with an id) so the test sees what it did; the core sends it as a notification."""
    server.submit(json.dumps({"jsonrpc": "2.0", "id": cid or f"c{rid}", "method": "$/cancel", "params": {"id": rid}}))


def blocker(monkeypatch, name="test.slow"):
    """A method that runs until the returned Event is set, and says when it has started."""
    started, go = threading.Event(), threading.Event()

    def slow(state, params):
        started.set()
        go.wait(10)
        return {"slow": True}
    monkeypatch.setitem(rpc.METHODS, name, slow)
    return started, go


def test_a_queued_request_cancelled_never_runs(state, monkeypatch):
    started, go = blocker(monkeypatch)
    ran = []
    monkeypatch.setitem(rpc.METHODS, "test.write", lambda st, params: ran.append(1) or {})
    out = Out()
    server = rpc.Server(state, out, workers=1, quick_workers=1)
    server.submit(req(1, "test.slow"))
    started.wait(5)
    server.submit(req(2, "test.write"))                             # queued behind the busy worker
    cancel(server, 2)
    assert out.answer("c2")["result"] == {"id": 2, "cancelled": True, "was": "queued"}   # answered at once
    go.set()
    err = out.answer(2)["error"]
    assert err["code"] == 5 and err["message"] == "test.write was cancelled before it did anything"
    assert server.drain(5)
    assert ran == []


def test_cancel_is_answered_while_every_worker_and_quick_lane_is_busy(state, monkeypatch):
    started, go = blocker(monkeypatch)
    out = Out()
    server = rpc.Server(state, out, workers=1, quick_workers=1)
    server.submit(req(1, "test.slow"))
    started.wait(5)
    cancel(server, 1)
    assert out.answer("c1")["result"] == {"id": 1, "cancelled": False, "was": "running"}
    go.set()
    assert out.answer(1)["result"] == {"slow": True}               # a write that started runs to its end


def test_a_request_waiting_for_a_lock_gives_up_at_once_when_cancelled(state, monkeypatch):
    held = threading.Event()
    release = threading.Event()

    def hold():
        state.lock.acquire(False, None, "changes.publish")
        held.set()
        release.wait(10)
        state.lock.release()
    threading.Thread(target=hold, daemon=True).start()
    held.wait(5)
    before = state.path.read_text()
    out = Out()
    server = rpc.Server(state, out)
    server.submit(req(1, "host.remove", {"host": "esx-02"}))
    end = time.monotonic() + 5
    while state.lock.writers_waiting == 0:                          # it's waiting for roster.yml
        assert time.monotonic() < end
        time.sleep(0.005)
    cancel(server, 1)
    assert out.answer("c1")["result"] == {"id": 1, "cancelled": True, "was": "waiting"}
    assert out.answer(1)["error"]["code"] == 5                      # not at LOCK_WAIT's 50 s
    release.set()
    assert server.drain(5)
    assert state.path.read_text() == before                         # nothing was done


@pytest.mark.parametrize("method", ["vault.lock", "vault.logout"])
def test_locking_is_never_cancelled(state, monkeypatch, method):
    started, go = blocker(monkeypatch)
    ran = []
    monkeypatch.setitem(rpc.METHODS, method, lambda st, params: ran.append(1) or {"locked": []})
    out = Out()
    server = rpc.Server(state, out, workers=1, quick_workers=1)
    server.submit(req(1, "test.slow"))
    started.wait(5)
    server.submit(req(2, method))
    cancel(server, 2)
    assert out.answer("c2")["result"] == {"id": 2, "cancelled": False, "was": "queued"}
    go.set()
    assert "result" in out.answer(2) and ran == [1]                 # Lock always succeeds (Q112 (k))


def test_cancelling_what_isnt_there_says_so(state):
    out = Out()
    server = rpc.Server(state, out)
    cancel(server, 77)
    assert out.answer("c77")["result"] == {"id": 77, "cancelled": False, "was": None}
    server.submit(json.dumps({"jsonrpc": "2.0", "id": "c", "method": "$/cancel", "params": {}}))
    assert out.answer("c")["error"]["code"] == -32602


def test_cancel_as_a_notification_gets_no_answer(state, monkeypatch):
    started, go = blocker(monkeypatch)
    out = Out()
    server = rpc.Server(state, out, workers=1, quick_workers=1)
    server.submit(req(1, "test.slow"))
    started.wait(5)
    server.submit(req(2, "inventory.reload"))
    server.submit(json.dumps({"jsonrpc": "2.0", "method": "$/cancel", "params": {"id": 2}}))
    go.set()
    assert out.answer(2)["error"]["code"] == 5
    assert server.drain(5)
    assert [m["id"] for m in out] == [1, 2]                          # nothing for the notification


def test_a_running_waiting_mesh_run_stops_its_job_when_cancelled(state, monkeypatch):
    stopped = []
    monkeypatch.setitem(rpc.METHODS, "test.waits", lambda st, params: waits(st))
    started, go = threading.Event(), threading.Event()

    def waits(st):
        rpc.on_cancel(lambda: stopped.append(1) or go.set())
        started.set()
        go.wait(10)
        return {"stopped": bool(stopped)}
    monkeypatch.setattr(rpc, "CANCEL_RUNNING", rpc.CANCEL_RUNNING | {"test.waits"})
    out = Out()
    server = rpc.Server(state, out)
    server.submit(req(1, "test.waits"))
    started.wait(5)
    cancel(server, 1)
    assert out.answer("c1")["result"] == {"id": 1, "cancelled": True, "was": "running"}
    assert out.answer(1)["result"] == {"stopped": True}


def test_the_running_cancellable_methods_are_the_waiting_forms_of_jobs():
    assert rpc.CANCEL_RUNNING == {"host.check", "mesh.plan", "mesh.apply", "mesh.cut"}
    assert not rpc.CANCEL_RUNNING & {m for m, claims in rpc.LOCKS.items() if claims}


# ---------------------------------------------------------------- the unlock and vault.status (Q112 (r))

def test_an_unlock_is_never_queued_behind_busy_workers(state, monkeypatch):
    started, go = blocker(monkeypatch)
    unlocked = threading.Event()
    monkeypatch.setitem(rpc.METHODS, "vault.unlock", lambda st, params: unlocked.set() or {"status": "unlocked"})
    out = Out()
    server = rpc.Server(state, out, workers=1, quick_workers=1)
    server.submit(req(1, "test.slow"))
    started.wait(5)
    server.submit(req(2, "vault.unlock", {"password": "hunter2"}))
    assert out.answer(2)["result"] == {"status": "unlocked"}       # its own lane: not after test.slow
    go.set()
    assert server.drain(5)


def test_vault_status_waits_for_an_unlock_asked_before_it(state, monkeypatch):
    entered, go = threading.Event(), threading.Event()
    seen = []

    def unlock(st, params):
        entered.set()
        go.wait(10)
        st.unlocked.add("bw")
        return {"status": "unlocked"}
    monkeypatch.setitem(rpc.METHODS, "vault.unlock", unlock)
    monkeypatch.setitem(rpc.METHODS, "vault.status", lambda st, params: seen.append(set(st.unlocked)) or {})
    # the unlock's lane hasn't picked it up yet: the status check must still see it coming
    lane_go = threading.Event()
    real_run = rpc.Server.run

    def run(self, record):
        if record.method == "vault.unlock":
            lane_go.wait(10)
        return real_run(self, record)
    monkeypatch.setattr(rpc.Server, "run", run)
    out = Out()
    server = rpc.Server(state, out)
    server.submit(req(1, "vault.unlock", {"password": "hunter2"}))
    server.submit(req(2, "vault.status"))
    lane_go.set()
    entered.wait(5)
    assert not out.answered(2)                                      # waiting for the unlock, not before it
    go.set()
    out.answer(1)
    out.answer(2)
    assert seen == [{"bw"}]


def test_vault_status_doesnt_wait_for_a_cancelled_unlock(state, monkeypatch):
    lane_go = threading.Event()
    real_run = rpc.Server.run

    def run(self, record):
        if record.method == "vault.unlock":
            lane_go.wait(10)
        return real_run(self, record)
    monkeypatch.setattr(rpc.Server, "run", run)
    ran = []
    monkeypatch.setitem(rpc.METHODS, "vault.unlock", lambda st, params: ran.append(1) or {})
    monkeypatch.setitem(rpc.METHODS, "vault.status", lambda st, params: {"status": "locked"})
    out = Out()
    server = rpc.Server(state, out)
    server.submit(req(1, "vault.unlock", {"password": "hunter2"}))
    cancel(server, 1)                                               # the app gave up on it
    server.submit(req(2, "vault.status"))
    assert out.answer(2)["result"] == {"status": "locked"}
    lane_go.set()
    assert out.answer(1)["error"]["code"] == 5
    assert ran == []


# ---------------------------------------------------------------- host.check as a job (Q112 (q))

@pytest.fixture
def held_check(monkeypatch):
    """diagnose.check_host stands in: it takes its first step, then a step that shares the vault and waits for `go`
    (or its stop) before the rest."""
    from contextlib import nullcontext

    from roster import diagnose
    calls, stepped, go = [], threading.Event(), threading.Event()

    def check_host(name, inventory, channel=None, progress=None, halted=None, vault=None):
        calls.append(name)
        progress and progress(1, len(diagnose.STEPS), "inventory")
        with vault() if vault else nullcontext():
            stepped.set()
            while not go.is_set() and not (halted and halted.is_set()):
                go.wait(0.01)
        stopped = bool(halted and halted.is_set())
        return {"host": name, "ok": not stopped, "steps": []}
    monkeypatch.setattr(diagnose, "check_host", check_host)
    return type("Held", (), {"calls": calls, "stepped": stepped, "go": go})


def test_a_background_check_frees_its_worker_and_its_job_holds_the_vault_for_a_vault_step(state, held_check):
    out = Out()
    server = rpc.Server(state, out, workers=1, quick_workers=1)
    server.submit(req(1, "host.check", {"host": "esx-02", "background": True}))
    started = out.answer(1)["result"]
    assert started["kind"] == "check" and started["state"] == "running" and started["host"] == "esx-02"
    held_check.stepped.wait(5)
    assert state.vault.readers == 1                                 # the job shares the vault, the worker doesn't
    server.submit(req(2, "inventory.reload"))                       # the one worker is free for it
    assert "result" in out.answer(2)
    held_check.go.set()
    job = state.jobs.get("check", started["job"])
    assert job.wait(5) and state.vault.readers == 0
    r = rpc.respond(state, {"jsonrpc": "2.0", "id": 3, "method": "host.check_job", "params": {"job": job.job}})
    assert r["result"]["state"] == "done" and r["result"]["result"] == {"host": "esx-02", "ok": True, "steps": []}


def test_one_check_per_host_at_a_time(state, held_check):
    call = lambda rid, params: rpc.respond(state, {"jsonrpc": "2.0", "id": rid, "method": "host.check",  # noqa: E731
                                                   "params": params})
    first = call(1, {"host": "esx-02", "background": True})["result"]
    held_check.stepped.wait(5)
    again = call(2, {"host": "esx-02", "background": True})["result"]
    assert again["job"] == first["job"]                             # the same job, not a second check
    other = call(3, {"host": "nas-1", "background": True})["result"]
    assert other["job"] != first["job"]                             # another Host checks at once
    held_check.go.set()
    for j in (first, other):
        assert state.jobs.get("check", j["job"]).wait(5)
    assert sorted(held_check.calls) == ["esx-02", "nas-1"]


def test_the_waiting_form_cancelled_stops_its_check(state, held_check):
    out = Out()
    server = rpc.Server(state, out)
    server.submit(req(1, "host.check", {"host": "esx-02"}))
    held_check.stepped.wait(5)
    cancel(server, 1)
    assert out.answer("c1")["result"] == {"id": 1, "cancelled": True, "was": "running"}
    assert out.answer(1)["result"]["ok"] is False                   # stopped at its next step


def test_vault_lock_stops_a_running_check_rather_than_wait_for_it(state, held_check):
    rpc.respond(state, {"jsonrpc": "2.0", "id": 1, "method": "host.check", "params": {"host": "esx-02",
                                                                                     "background": True}})
    held_check.stepped.wait(5)
    locked = []
    t = threading.Thread(target=lambda: locked.append(rpc.respond(state, {"jsonrpc": "2.0", "id": 2,
                                                                          "method": "vault.lock"})), daemon=True)
    t.start()
    t.join(5)                                                       # never go.set(): the lock ended it
    assert locked and "result" in locked[0]
    assert state.jobs.latest("check", "esx-02").view()["state"] == "stopped"


# ---------------------------------------------------------------- the iteration 9 review

def wait_until(cond, seconds=5):
    end = time.monotonic() + seconds
    while not cond():
        assert time.monotonic() < end, "never happened"
        time.sleep(0.005)


def running(server, rid):
    with server.table:
        r = server.requests.get(rpc.request_key(rid))
    return r is not None and r.phase == "running"


def test_a_waiter_that_joined_a_check_cancelled_leaves_it_running(state, held_check):
    # review item 2: the joiner's cancel stopped the check the first request was still waiting for
    out = Out()
    server = rpc.Server(state, out)
    server.submit(req(1, "host.check", {"host": "esx-02"}))
    held_check.stepped.wait(5)
    server.submit(req(2, "host.check", {"host": "esx-02"}))         # joins it
    wait_until(lambda: running(server, 2))
    cancel(server, 2)
    out.answer("c2")
    job = state.jobs.latest("check", "esx-02")
    assert job.view()["state"] == "running"
    held_check.go.set()
    assert out.answer(1)["result"]["ok"] is True                    # the first waiter's check ran to its end
    assert held_check.calls == ["esx-02"]


def test_a_cancelled_joiner_answers_at_once_and_frees_its_worker(state, held_check):
    # #198 (a): it kept its worker until the check it joined ended (up to 45 s)
    out = Out()
    server = rpc.Server(state, out, workers=2)
    server.submit(req(1, "host.check", {"host": "esx-02"}))
    held_check.stepped.wait(5)
    server.submit(req(2, "host.check", {"host": "esx-02"}))         # joins it
    wait_until(lambda: running(server, 2))
    cancel(server, 2)
    assert out.answer(2)["error"]["code"] == 5                      # never go.set(): the check still runs
    server.submit(req(3, "inventory.reload"))                       # its worker is free again
    assert "result" in out.answer(3)
    assert state.jobs.latest("check", "esx-02").view()["state"] == "running"
    held_check.go.set()
    assert out.answer(1)["result"]["ok"] is True


def test_the_last_waiter_of_a_check_already_stopping_gets_its_stopped_result(state, monkeypatch):
    # review of #216, 1: let_go() said "didn't stop it" for a check already stopping, so the last waiter answered 5
    # ("did nothing") instead of the stopped result
    from roster import diagnose
    stepped, go = threading.Event(), threading.Event()

    def check_host(name, inventory, channel=None, progress=None, halted=None, vault=None):
        stepped.set()
        go.wait(10)                                                 # a step that only ends when it ends
        return {"host": name, "ok": False, "steps": [{"step": "auth", "status": "skipped",
                                                      "message": "the check was stopped"}]}
    monkeypatch.setattr(diagnose, "check_host", check_host)
    out = Out()
    server = rpc.Server(state, out)
    server.submit(req(1, "host.check", {"host": "esx-02"}))
    stepped.wait(5)
    wait_until(lambda: running(server, 1))
    assert state.jobs.stop("check", state.jobs.latest("check", "esx-02").job)    # stopping, still in its step
    cancel(server, 1)
    out.answer("c1")
    assert not out.answered(1)                                      # it waits for the stopped result
    go.set()
    answer = out.answer(1)
    assert "result" in answer and answer["result"]["steps"][-1]["status"] == "skipped"


def test_the_last_waiter_cancelled_stops_the_check(state, held_check):
    out = Out()
    server = rpc.Server(state, out)
    server.submit(req(1, "host.check", {"host": "esx-02"}))
    held_check.stepped.wait(5)
    server.submit(req(2, "host.check", {"host": "esx-02"}))
    wait_until(lambda: running(server, 2))
    cancel(server, 2)
    out.answer("c2")
    cancel(server, 1)                                               # nobody waits for it now
    assert out.answer(1)["result"]["ok"] is False
    assert state.jobs.latest("check", "esx-02").view()["state"] == "stopped"


def test_a_background_check_isnt_stopped_by_a_waiter_that_joined_it(state, held_check):
    out = Out()
    server = rpc.Server(state, out)
    server.submit(req(1, "host.check", {"host": "esx-02", "background": True}))
    started = out.answer(1)["result"]
    assert started["joined"] is False
    held_check.stepped.wait(5)
    server.submit(req(2, "host.check", {"host": "esx-02"}))
    wait_until(lambda: running(server, 2))
    cancel(server, 2)
    out.answer("c2")
    server.submit(req(3, "host.check", {"host": "esx-02", "background": True}))
    assert out.answer(3)["result"]["joined"] is True                # the core never stops a check it joined
    assert state.jobs.get("check", started["job"]).view()["state"] == "running"
    held_check.go.set()
    assert state.jobs.get("check", started["job"]).wait(5)
    assert state.jobs.get("check", started["job"]).view()["state"] == "done"


def test_a_check_after_one_was_stopped_is_a_new_check(state, monkeypatch):
    # review item 3: the stopping check counted as running, so the new one joined it and answered ok: false
    from roster import diagnose
    in_step, go, calls = threading.Event(), threading.Event(), []

    def check_host(name, inventory, channel=None, progress=None, halted=None, vault=None):
        calls.append(name)
        if len(calls) == 1:
            in_step.set()
            go.wait(10)                                             # a step under way doesn't see the stop
        return {"host": name, "ok": not (halted and halted.is_set()), "steps": []}
    monkeypatch.setattr(diagnose, "check_host", check_host)
    call = lambda rid, params: rpc.respond(state, {"jsonrpc": "2.0", "id": rid, "method": "host.check",  # noqa: E731
                                                   "params": params})
    first = call(1, {"host": "esx-02", "background": True})["result"]
    in_step.wait(5)
    assert state.jobs.stop("check", first["job"])
    assert state.jobs.get("check", first["job"]).view()["state"] == "stopping"
    again = call(2, {"host": "esx-02"})["result"]                   # the waiting form: its own check
    assert again["ok"] is True and calls == ["esx-02", "esx-02"]
    go.set()
    assert state.jobs.get("check", first["job"]).wait(5)


def test_a_finished_check_is_still_there_after_a_newer_check_of_its_host(state, held_check):
    # review item 7: serve kept only each Host's latest check, so the core's poll of a check that had succeeded
    # got 49 once another check of that Host started
    call = lambda rid, method, params: rpc.respond(state, {"jsonrpc": "2.0", "id": rid,  # noqa: E731
                                                           "method": method, "params": params})
    held_check.go.set()
    first = call(1, "host.check", {"host": "esx-02", "background": True})["result"]
    assert state.jobs.get("check", first["job"]).wait(5)
    second = call(2, "host.check", {"host": "esx-02", "background": True})["result"]
    assert second["job"] != first["job"]
    r = call(3, "host.check_job", {"job": first["job"]})
    assert r["result"]["state"] == "done" and r["result"]["result"]["ok"] is True


PASSWORD_HOST = """\
defaults:
  user: admin
groups:
  lab:
    hosts:
      esx-02: {ip: 10.0.0.12, auth: "bw:esx-02", enroll: false}
"""


@pytest.fixture
def stepped_check(write_config, monkeypatch):
    """The real check_host over stand-in steps: each says whether the check held the vault while it ran, and dns
    waits for `go` (or its stop)."""
    from roster import diagnose
    st = rpc.State(str(write_config(PASSWORD_HOST)))
    held, in_dns, go = {}, threading.Event(), threading.Event()

    def step(name):
        def fn(ctx):
            held[name] = st.vault.readers
            if name == "dns":
                in_dns.set()
                go.wait(10)
            return "ok"
        return fn
    for name in diagnose.STEPS:
        if name != "inventory":
            monkeypatch.setitem(diagnose.STEP_FNS, name, step(name))
    return type("Stepped", (), {"state": st, "held": held, "in_dns": in_dns, "go": go})


def test_a_check_shares_the_vault_only_for_the_steps_that_fetch_a_secret(stepped_check):
    # review item 6: the check held the vault for all its steps (up to 45 s), so vault.unlock waited behind it and
    # the vault.status after it gave up
    st = stepped_check.state
    started = rpc.respond(st, {"jsonrpc": "2.0", "id": 1, "method": "host.check",
                               "params": {"host": "esx-02", "background": True}})["result"]
    stepped_check.in_dns.wait(5)
    assert st.vault.acquire(False, 1, "vault.unlock")              # an unlock goes ahead during dns
    st.vault.release()
    stepped_check.go.set()
    job = st.jobs.get("check", started["job"])
    assert job.wait(5) and job.result["ok"] is True, job.view()
    assert stepped_check.held == {"ssh-config": 0, "provider": 1, "vault-item": 1, "dns": 0, "tcp": 0,
                                  "host-key": 0, "auth": 1}


def test_vault_lock_doesnt_wait_for_a_check_between_its_vault_steps(stepped_check):
    st = stepped_check.state
    started = rpc.respond(st, {"jsonrpc": "2.0", "id": 1, "method": "host.check",
                               "params": {"host": "esx-02", "background": True}})["result"]
    stepped_check.in_dns.wait(5)
    answer = []
    t = threading.Thread(target=lambda: answer.append(rpc.respond(st, {"jsonrpc": "2.0", "id": 2,
                                                                       "method": "vault.lock"})), daemon=True)
    t.start()
    t.join(5)                                                       # never go.set(): dns is still under way
    assert answer and "result" in answer[0]
    stepped_check.go.set()
    job = st.jobs.get("check", started["job"])
    assert job.wait(5) and job.view()["state"] == "stopped"
    assert [s["status"] for s in job.result["steps"]][-3:] == ["skipped"] * 3
    assert "auth" not in stepped_check.held                         # no secret fetched after the lock
