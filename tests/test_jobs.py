"""serve's job manager (jobs.py, ticket 101, decision Q112): one place owns background work. A job has a kind and an
id, a state, progress, a result or an error, and a stop; serve's exit stops every one of them at once."""
import threading
import time

import pytest

from roster import jobs


def collect():
    notes = []
    return notes, lambda method, params: notes.append((method, dict(params)))


def test_a_job_runs_in_the_background_and_ends_done_with_its_result():
    notes, notify = collect()
    m = jobs.Jobs(notify)
    go = threading.Event()

    def work(job):
        job.progress(1, 2, "orion-2")
        go.wait(5)
        return {"answer": 42}
    job = m.start("mesh", "apply", work, total=2)
    assert job.job == 1 and m.latest("mesh") is job and job.view()["state"] == "running"
    go.set()
    assert job.wait(5)
    v = job.view()
    assert v["state"] == "done" and v["done"] == v["total"] == 2 and v["at"] is None
    assert job.result == {"answer": 42} and job.error is None
    states = [p["state"] for method, p in notes if method == "job.progress"]
    assert states[0] == "running" and states[-1] == "done"
    assert all(p["kind"] == "mesh" and p["job"] == 1 and p["action"] == "apply" for _, p in notes)
    assert "result" not in notes[-1][1]                     # a plan can be megabytes: the kind's method has it


def test_one_job_of_a_kind_at_a_time_and_the_ids_go_up():
    m = jobs.Jobs()
    go = threading.Event()
    first = m.start("mesh", "plan", lambda job: go.wait(5))
    with pytest.raises(jobs.Busy) as busy:
        m.start("mesh", "apply", lambda job: None)
    assert busy.value.job is first
    other = m.start("discover", "scan", lambda job: None, job="scan-1")       # another kind goes ahead
    assert other.wait(5) and other.job == "scan-1"
    go.set()
    first.wait(5)
    assert m.start("mesh", "apply", lambda job: None).job == 2


def test_stopping_a_job_asks_its_work_to_stop_and_it_ends_stopped():
    notes, notify = collect()
    m = jobs.Jobs(notify)
    stopped = []
    job = m.start("discover", "scan", lambda job: job.halted.wait(5), job="scan-1", on_stop=lambda: stopped.append(1))
    assert m.stop("discover", "scan-1") is True
    assert job.wait(5) and job.view()["state"] == "stopped" and stopped == [1]
    assert m.stop("discover", "scan-1") is False                   # over already
    assert m.stop("mesh", 7) is False                              # no such job
    assert [p["state"] for _, p in notes][-2:] == ["stopping", "stopped"]


def test_a_job_that_raises_ends_failed_with_the_error():
    m = jobs.Jobs()

    def work(job):
        raise jobs.Failed(3, "it broke", {"why": "x"})
    job = m.start("mesh", "plan", work)
    job.wait(5)
    assert job.view()["state"] == "failed" and job.error == {"code": 3, "message": "it broke", "data": {"why": "x"}}


def test_progress_is_pushed_a_few_times_a_second_not_on_every_step():
    notes, notify = collect()
    m = jobs.Jobs(notify)

    def work(job):
        for i in range(500):
            job.progress(i, 500)
    m.start("mesh", "plan", work).wait(5)
    assert len(notes) < 20 and notes[-1][1]["state"] == "done" and notes[-1][1]["done"] == 500


def test_jobs_list_says_what_runs_and_the_latest_of_each_kind():
    m = jobs.Jobs()
    go = threading.Event()
    m.start("mesh", "apply", lambda job: go.wait(5), host=None)
    m.start("discover", "scan", lambda job: None, job="scan-1").wait(5)
    listed = {v["kind"]: v for v in m.list()}
    assert listed["mesh"]["state"] == "running" and listed["discover"]["state"] == "done"
    go.set()


def test_closing_stops_every_running_job_at_once_and_records_it():
    notes, notify = collect()
    logged = []
    m = jobs.Jobs(notify, log=logged.append)
    a = m.start("mesh", "apply", lambda job: job.halted.wait(30))
    b = m.start("discover", "scan", lambda job: job.halted.wait(30), job="scan-1")
    t = time.monotonic()
    m.close(0.8)
    assert time.monotonic() - t < 2
    assert a.view()["state"] == b.view()["state"] == "stopped"
    assert any("mesh 1" in line and "apply" in line for line in logged)
    assert any("discover scan-1" in line for line in logged)
    with pytest.raises(jobs.Closed):                               # nothing starts once serve is closing
        m.start("mesh", "plan", lambda job: None)


def test_closing_waits_only_so_long_for_a_job_that_wont_stop():
    m = jobs.Jobs()
    m.start("mesh", "apply", lambda job: time.sleep(3))
    t = time.monotonic()
    m.close(0.3)
    assert time.monotonic() - t < 1


def test_closing_while_a_job_is_starting_waits_for_it_and_stops_it():
    # review 4: start() made the job visible and told about it before starting its thread; close() in that window
    # joined a thread not started yet (RuntimeError) and the rest of the clean-up never ran
    told, go = threading.Event(), threading.Event()

    def notify(method, params):
        if params["state"] == "running" and not told.is_set():
            told.set()
            go.wait(2)
    m = jobs.Jobs(notify)
    starting = threading.Thread(target=lambda: m.start("mesh", "apply", lambda job: job.halted.wait(5)), daemon=True)
    starting.start()
    told.wait(5)
    failed = []

    def close():
        try:
            m.close(1)
        except Exception as e:
            failed.append(e)
    closer = threading.Thread(target=close, daemon=True)
    closer.start()
    closer.join(0.2)
    go.set()
    starting.join(5)
    closer.join(5)
    assert failed == [] and m.latest("mesh").view()["state"] == "stopped"
