"""`roster serve` answers requests concurrently (ticket 101, decision Q112): a quick read answers while a slow
Publish runs, writes to roster.yml never interleave, the vault's lock waits for whoever holds a secret, and a lock
not free in time is code 4 with nothing done. The Publish pushes to a bare repo in the test's temp dir whose hook
holds the push until the test lets it go; nothing connects anywhere."""
import json
import subprocess
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
      nas-1: 10.0.0.30
"""
HOOK_LIMIT = 30             # s: the upstream's hook gives up waiting to be let go (a test that failed early)


def git(cwd, *args):
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


class Upstream:
    """The bare 'origin' whose pre-receive hook holds each push: it leaves `pushing` when a push reaches it and waits
    for `release` (HOOK_LIMIT s at most). An sh script: git runs hooks with its own sh, Git for Windows' too, so this
    runs on native Windows as well (ticket 108)."""

    def __init__(self, origin):
        self.origin = origin

    def pushing(self, seconds=10):
        """Wait until a push is held in the hook."""
        end = time.monotonic() + seconds
        while not (self.origin / "pushing").exists():
            assert time.monotonic() < end, "no push reached the upstream"
            time.sleep(0.01)

    def release(self):
        (self.origin / "release").write_text("")


@pytest.fixture
def upstream():
    made = []
    yield made
    for u in made:
        u.release()                     # a hook still waiting ends now, not after HOOK_LIMIT


@pytest.fixture
def infra(tmp_path, monkeypatch, upstream):
    """roster.yml committed in a clone of a bare 'origin' whose pre-receive hook holds a push until the test lets it
    go (infra.upstream), with a Pending change (new-1) waiting to be published."""
    for k, v in {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
                 "GIT_COMMITTER_EMAIL": "t@x", "GIT_CONFIG_NOSYSTEM": "1"}.items():
        monkeypatch.setenv(k, v)
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    repo = tmp_path / "infra"
    subprocess.run(["git", "clone", "-q", str(origin), str(repo)], check=True, capture_output=True)
    git(repo, "checkout", "-q", "-b", "main")
    (repo / "roster.yml").write_text(INVENTORY)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "inventory")
    git(repo, "push", "-q", "-u", "origin", "main")
    hook = origin / "hooks" / "pre-receive"         # run in the bare repo: `pushing` and `release` are beside it
    hook.write_text("#!/bin/sh\ncat >/dev/null\n: >pushing\ni=0\n"
                    f"while [ ! -f release ] && [ $i -lt {HOOK_LIMIT * 20} ]; do sleep 0.05; i=$((i+1)); done\n",
                    newline="\n")
    hook.chmod(0o755)
    (repo / "roster.yml").write_text(INVENTORY + "      new-1: 10.0.0.40\n")
    upstream.append(Upstream(origin))
    return repo


def test_a_quick_read_answers_while_a_slow_publish_runs(serve, infra, upstream):
    s = serve("-c", str(infra / "roster.yml"))
    s.call("inventory.info")
    publish = s.request("changes.publish", {"message": "Add new-1"})
    upstream[0].pushing()                                               # it's pushing now, held there
    hosts = s.call("hosts.list")["result"]["hosts"]
    assert [h["name"] for h in hosts] == ["esx-02", "nas-1", "new-1"]
    assert s.call("mesh.status")["result"]["members"] is not None        # another quick read
    assert publish not in s.answered                                    # both answered while it still pushed
    upstream[0].release()
    r = s.answer(publish)["result"]
    assert r["commit"] and r["sync"]["ok"] is True
    assert s.order.index(publish) > s.order.index(publish + 1)          # answered after the read it came before


def test_a_write_waits_for_the_publish_so_the_commit_holds_exactly_what_was_written(serve, infra, upstream):
    s = serve("-c", str(infra / "roster.yml"))
    publish = s.request("changes.publish", {"message": "Add new-1"})
    upstream[0].pushing()
    rename = s.request("host.rename", {"host": "nas-1", "to": "nas-2"})
    upstream[0].release()
    assert s.answer(rename)["result"]["host"]["name"] == "nas-2"
    assert s.order.index(publish) < s.order.index(rename)               # it waited for roster.yml
    assert "commit" in s.answer(publish)["result"]
    pushed = git(infra, "show", "origin/main:roster.yml")
    assert "new-1" in pushed and "nas-1" in pushed and "nas-2" not in pushed
    diff = s.call("changes.diff")["result"]
    assert sorted((h["host"], h["change"]) for h in diff["hosts"]) == [("nas-1", "removed"), ("nas-2", "added")]


def test_two_writes_at_once_both_land_one_after_the_other(serve, infra):
    s = serve("-c", str(infra / "roster.yml"))
    a = s.request("host.rename", {"host": "nas-1", "to": "nas-2"})
    b = s.request("host.rename", {"host": "esx-02", "to": "esx-03"})
    assert "result" in s.answer(a) and "result" in s.answer(b)
    names = [h["name"] for h in s.call("hosts.list")["result"]["hosts"]]
    assert sorted(names) == ["esx-03", "nas-2", "new-1"]
    assert s.call("inventory.reload")["result"]["error"] is None


# ---------------------------------------------------------------- in process: the locks

@pytest.fixture
def state(write_config):
    return rpc.State(str(write_config(INVENTORY)))


def call(state, method, params=None):
    return rpc.respond(state, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})


def holding(lock, method, seconds, shared=False):
    """Hold LOCK as METHOD would, on a thread of its own, for SECONDS. Returns once it holds it."""
    held = threading.Event()

    def run():
        lock.acquire(shared, None, method)
        held.set()
        time.sleep(seconds)
        lock.release()
    threading.Thread(target=run, daemon=True).start()
    held.wait(5)


def test_a_write_that_cant_get_roster_yml_in_time_is_busy_and_does_nothing(state, monkeypatch, write_config):
    monkeypatch.setattr(rpc, "LOCK_WAIT", 0.3)
    before = state.path.read_text()
    holding(state.lock, "changes.publish", 2)
    err = call(state, "host.remove", {"host": "nas-1"})["error"]
    assert err["code"] == 4 and err["message"] == "roster.yml is busy: changes.publish is still running - nothing was done"
    assert err["data"] == {"busy": "roster.yml", "method": "changes.publish", "fix": "try again once it has finished"}
    assert state.path.read_text() == before


def test_vault_lock_waits_for_whoever_holds_a_secret(state, monkeypatch):
    holding(state.vault, "session.prepare", 0.5, shared=True)
    t = time.monotonic()
    assert "result" in call(state, "vault.lock")
    assert time.monotonic() - t >= 0.3                                  # it waited until the lookup was done


def test_secret_lookups_share_the_vault(state, monkeypatch):
    monkeypatch.setattr(rpc, "LOCK_WAIT", 0.3)
    holding(state.vault, "host.check", 2, shared=True)
    assert state.vault.acquire(True, 0.1, "session.prepare")              # another reader goes ahead
    state.vault.release()


def test_host_get_settled_waits_for_a_write_under_way(state):
    holding(state.lock, "host.add", 0.6)
    t = time.monotonic()
    assert call(state, "host.get", {"name": "nas-1"})["result"]["name"] == "nas-1"
    assert time.monotonic() - t < 0.3                                   # a plain read doesn't wait
    assert call(state, "host.get", {"name": "nas-1", "settled": True})["result"]["name"] == "nas-1"
    assert time.monotonic() - t >= 0.5
    assert call(state, "host.get", {"name": "nas-1", "settled": "yes"})["error"]["code"] == -32602


def test_the_quick_reads_are_the_ones_that_take_no_lock():
    assert not set(rpc.QUICK) & set(rpc.LOCKS)
    assert set(rpc.QUICK) <= set(rpc.METHODS)
    assert set(rpc.LOCKS) <= set(rpc.METHODS)
    assert rpc.quick({"method": "host.get", "params": {"name": "x"}})
    assert not rpc.quick({"method": "host.get", "params": {"name": "x", "settled": True}})


def test_the_server_answers_a_quick_read_while_every_worker_is_busy(state, monkeypatch):
    gate = threading.Event()
    monkeypatch.setitem(rpc.METHODS, "test.slow", lambda state, params: gate.wait(5) and {"slow": True})
    out = []
    server = rpc.Server(state, out.append, workers=2, quick_workers=1)
    for i in range(3):
        server.submit(json.dumps({"jsonrpc": "2.0", "id": i, "method": "test.slow"}))
    server.submit(json.dumps({"jsonrpc": "2.0", "id": 9, "method": "hosts.list"}))
    end = time.monotonic() + 5
    while not out and time.monotonic() < end:
        time.sleep(0.01)
    assert [r["id"] for r in out] == [9]
    gate.set()
    assert server.drain(5)
    assert sorted(r["id"] for r in out) == [0, 1, 2, 9]


def test_serve_exits_well_within_the_apps_grace_with_a_slow_request_under_way(serve, infra, upstream):
    s = serve("-c", str(infra / "roster.yml"))
    s.request("changes.publish", {"message": "Add new-1"})
    upstream[0].pushing()                                               # held there until the test ends
    t = time.monotonic()
    code, _, _ = s.close()
    assert code == 0 and time.monotonic() - t < 2.5                     # the app kills it after 3 s (rpc.rs)


def test_two_requests_recording_the_same_host_key_at_once_record_it_once(isolated):
    from roster import sshops
    h = {"name": "nas-1", "ip": "10.0.0.30", "ssh": {"port": 22}}
    threads = [threading.Thread(target=sshops.record_host_key, args=(h, "ssh-ed25519", "AAAAC3Nza")) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    lines = sshops.known_hosts_file().read_text().splitlines()
    assert lines.count("10.0.0.30 ssh-ed25519 AAAAC3Nza") == 1


# ---------------------------------------------------------------- the review of PR #188 (decision Q112, amended)

def wait_until(cond, seconds=5):
    end = time.monotonic() + seconds
    while not cond():
        assert time.monotonic() < end, "never happened"
        time.sleep(0.005)


def holder(lock, method, shared=False):
    """Hold LOCK as METHOD would, on a thread of its own, until the returned Event is set."""
    held, done = threading.Event(), threading.Event()

    def run():
        lock.acquire(shared, None, method)
        held.set()
        done.wait(10)
        lock.release()
    threading.Thread(target=run, daemon=True).start()
    held.wait(5)
    return done


def test_vault_lock_forgets_at_once_then_waits_for_the_holders_and_never_fails(state, monkeypatch):
    # review 1: vault.lock waited for the vault's lock first, and after LOCK_WAIT answered 4 with every secret still
    # in memory while the app showed its lock screen
    monkeypatch.setattr(rpc, "LOCK_WAIT", 0)                       # any wait at all would have been 4
    forgot = []
    monkeypatch.setattr(rpc, "ON_VAULT_LOCK", [lambda st: forgot.append(time.monotonic())])
    release = holder(state.vault, "session.prepare", shared=True)   # a request holding a secret
    answer = []
    t = threading.Thread(target=lambda: answer.append(call(state, "vault.lock")), daemon=True)
    t.start()
    wait_until(lambda: len(forgot) == 1)                            # forgotten while the holder still holds it
    wait_until(lambda: state.vault.writers_waiting == 1)            # then waiting: new lookups wait behind it
    assert not state.vault.acquire(True, 0.05, "session.prepare")
    release.set()
    t.join(5)
    assert "result" in answer[0], answer
    assert len(forgot) == 2                                         # and again, for what the holder made meanwhile


def test_vault_logout_never_waits_with_a_busy_answer_either(state):
    assert "vault.logout" not in rpc.LOCKS and "vault.lock" not in rpc.LOCKS


def test_a_writer_that_gives_up_lets_the_readers_it_held_back_go(state):
    # review 2: the writer's timeout lowered writers_waiting without waking the readers waiting behind it
    release = holder(state.vault, "host.check", shared=True)
    gave_up = threading.Event()
    threading.Thread(target=lambda: state.vault.acquire(False, 0.3, "vault.unlock") or gave_up.set(),
                     daemon=True).start()
    wait_until(lambda: state.vault.writers_waiting == 1)
    got = []
    reader = threading.Thread(target=lambda: got.append(state.vault.acquire(True, 30, "session.prepare")), daemon=True)
    reader.start()
    gave_up.wait(5)
    reader.join(3)                                                  # not at its own 30 s timeout
    assert got == [True]
    state.vault.release()
    release.set()


def test_host_verify_login_reloads_before_it_shares_the_vault(state, monkeypatch):
    # review 3: verify_login shared the vault, then waited for roster.yml: with host.add holding roster.yml and
    # waiting for the vault behind a vault.lock that waited for verify_login, none of them ever ended
    from roster import diagnose
    monkeypatch.setattr(diagnose, "verify_login", lambda *a, **k: {"host": "nas-1", "ok": False, "steps": []})
    release = holder(state.lock, "host.add")                       # host.add holds roster.yml
    verify = threading.Thread(target=lambda: call(state, "host.verify_login",
                                                  {"host": "nas-1", "changes": {"user": "root"}}), daemon=True)
    verify.start()
    wait_until(lambda: state.lock.writers_waiting == 1)             # verify_login waits for roster.yml...
    assert state.vault.readers == 0                                 # ...holding nothing of the vault
    locked = []
    t = threading.Thread(target=lambda: locked.append(call(state, "vault.lock")), daemon=True)
    t.start()
    t.join(5)
    assert locked and "result" in locked[0]                         # so vault.lock doesn't wait for it
    release.set()
    verify.join(5)


def test_a_reload_for_a_read_waits_only_so_long_for_a_write(state, monkeypatch):
    # review 6: mesh.plan's and mesh.apply's reload waited for roster.yml with no limit, never answering 4
    monkeypatch.setitem(rpc.DEADLINES, "mesh.plan", 0.1)          # what's left of its deadline is its wait
    release = holder(state.lock, "changes.publish")
    answer = []
    t = threading.Thread(target=lambda: answer.append(call(state, "mesh.plan")), daemon=True)
    t.start()
    t.join(3)
    release.set()
    assert answer and answer[0]["error"]["code"] == 4
    assert answer[0]["error"]["data"]["method"] == "changes.publish"


def test_two_inventory_watch_at_once_start_one_watcher(state, monkeypatch):
    # review 7: inventory.watch is a quick read, and checked then set state.watcher with no lock
    made, entered, go = [], threading.Event(), threading.Event()

    class Slow(rpc.Watcher):
        def __init__(self, st):
            made.append(1)
            entered.set()
            go.wait(1)
            super().__init__(st)

        def run(self):
            pass
    monkeypatch.setattr(rpc, "Watcher", Slow)
    state.notify = lambda *a: None
    first = threading.Thread(target=lambda: call(state, "inventory.watch", {"auto": True}), daemon=True)
    first.start()
    entered.wait(5)
    second = threading.Thread(target=lambda: call(state, "inventory.watch", {"auto": True}), daemon=True)
    second.start()
    second.join(0.3)                                                # a second watcher would be made in this time
    go.set()
    first.join(5)
    second.join(5)
    assert made == [1]


def test_two_undos_of_one_item_at_once_delete_it_once(state, monkeypatch):
    # review 8: both undos found the item, both deleted it, and the second's `del` was a KeyError (-32603)
    from roster import providers
    deleting, go, deleted = threading.Event(), threading.Event(), []

    def delete_item(provider, item_id):
        deleted.append(item_id)
        deleting.set()
        go.wait(2)
    monkeypatch.setattr(providers, "delete_item", delete_item)
    state.created["item-1"] = "bw"
    answers = []
    first = threading.Thread(target=lambda: answers.append(call(state, "vault.undo_create", {"id": "item-1"})),
                             daemon=True)
    first.start()
    deleting.wait(5)
    answers.append(call(state, "vault.undo_create", {"id": "item-1"}))
    go.set()
    first.join(5)
    assert answers[0]["error"]["code"] == 63 and "result" in answers[1]
    assert deleted == ["item-1"]


def test_an_undo_the_vault_refused_can_be_tried_again(state, monkeypatch):
    from roster import providers

    def refuse(provider, item_id):
        raise providers.SecretError("bw refused")
    monkeypatch.setattr(providers, "delete_item", refuse)
    state.created["item-1"] = "bw"
    assert call(state, "vault.undo_create", {"id": "item-1"})["error"]["code"] != 63
    assert state.created == {"item-1": "bw"}


def test_a_worker_outlives_a_request_that_raises(state):
    # review 9: an exception out of a request killed its worker for good, and the pool ran dry
    pool = rpc.Pool(1, "test")
    pool.queue.put(lambda: 1 / 0)
    ran = threading.Event()
    pool.queue.put(ran.set)
    assert ran.wait(5)


def test_closing_refuses_whats_queued_before_any_clean_up(state, monkeypatch):
    # review 5: a vault.login queued when stdin closed ran after end_sign_in, and its `bw login` outlived serve
    gate, started, ran, out = threading.Event(), threading.Event(), [], []
    monkeypatch.setitem(rpc.METHODS, "test.slow", lambda st, params: started.set() or gate.wait(5) and {})
    monkeypatch.setitem(rpc.METHODS, "vault.login", lambda st, params: ran.append(1) or {})
    server = rpc.Server(state, out.append, workers=1, quick_workers=1)
    server.submit(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "test.slow"}))
    started.wait(5)
    server.submit(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "vault.login", "params": {}}))
    assert server.close(0.05) is False                              # test.slow still runs
    gate.set()
    assert server.drain(5)
    assert ran == []
    assert {r["id"]: r.get("error", {}).get("message") for r in out}[2] == "roster serve is closing"


def test_a_sign_in_that_starts_while_serve_closes_ends_its_cli(state, monkeypatch):
    from roster import providers

    class Flow:
        closed = False
        touched = 0
        step = {"step": "master_password"}

        def start(self, params):
            state.closing = True                    # stdin closed while `bw login` started
            return {"step": "master_password"}

        def close(self):
            Flow.closed = True
    monkeypatch.setattr(providers, "login", lambda name: Flow())
    monkeypatch.setattr(rpc, "vault_provider", lambda st, params: "bw")
    r = call(state, "vault.login", {"action": "start", "method": "sso"})
    assert r["error"]["message"] == "roster serve is closing"
    assert Flow.closed and state.login is None


# ---------------------------------------------------------------- item creation, one at a time per vault (ticket 108)

def test_two_item_creations_at_once_go_to_the_vault_one_after_the_other(state, monkeypatch):
    # bw keeps its local cache in one data.json, and pass commits each insert to a git repo: neither is known to take
    # two writes at once (and both creations would pass the "no item by that name" check before either made one)
    from roster import providers
    inside, entered, go, made = [], threading.Event(), threading.Event(), []

    def create_item(provider, name, password, save_to=None, **extra):
        inside.append(name)
        assert len(inside) == 1, f"two creations in {provider} at once: {inside}"
        entered.set()
        go.wait(5)
        made.append(name)
        inside.remove(name)
        return {"id": f"id-{name}", "name": name, "target": None}
    monkeypatch.setattr(providers, "create_item", create_item)
    monkeypatch.setattr(rpc, "vault_provider", lambda st, params: "bw")
    answers = {}

    def create(name):
        answers[name] = call(state, "vault.create_item", {"name": name, "password": "pw"})
    first = threading.Thread(target=create, args=("a ssh",), daemon=True)
    first.start()
    entered.wait(5)
    second = threading.Thread(target=create, args=("b ssh",), daemon=True)
    second.start()
    wait_until(lambda: rpc.item_lock("bw").writers_waiting == 1)    # the second waits for the first
    assert made == []
    go.set()
    first.join(5)
    second.join(5)
    assert made == ["a ssh", "b ssh"]
    assert all("result" in a for a in answers.values()), answers


# ---------------------------------------------------------------- the iteration 9 review

def test_an_undo_that_failed_any_other_way_can_be_tried_again(state, monkeypatch):
    # review item 5: only SecretError and RpcError put the item back, so any other failure forgot an item that was
    # never deleted (an orphan in the vault, and the retry answered 63)
    from roster import providers

    def broken(provider, item_id):
        raise ValueError("a provider plugin's bug")
    monkeypatch.setattr(providers, "delete_item", broken)
    state.created["item-1"] = "bw"
    err = call(state, "vault.undo_create", {"id": "item-1"})["error"]
    assert err["code"] == -32603 and err["message"] == "deleting from bw failed: ValueError"
    assert state.created == {"item-1": "bw"}


def test_reloading_while_a_box_setting_locks_a_provider_leaves_both_whole(state, monkeypatch, tmp_path):
    # review item 4: a reload registers providers while vault.configure walks them (dict changed size)
    from roster import providers
    in_lock, go = threading.Event(), threading.Event()

    def lock(ctx):
        in_lock.set()
        go.wait(5)
    monkeypatch.setitem(providers.PROVIDERS, "aaa-test", {"get": lambda spec, ctx: "x", "lock": lock,
                                                          "box_paths": ("db",), "help": "", "tool": "", "kind": "plugin"})
    monkeypatch.setitem(providers.PROVIDER_STATE, "aaa-test", {"ready": True})
    monkeypatch.setattr(providers, "BOX_SETTINGS", {})
    errors = []

    def configure():
        try:
            providers.configure_box({"aaa-test": {"db": str(tmp_path / "other.kdbx")}})
        except Exception as e:
            errors.append(e)
    t = threading.Thread(target=configure, daemon=True)
    t.start()
    in_lock.wait(5)
    added = "zzz-test"
    providers.add_template_provider(added, {"command": "echo x"})   # as a reload's setup_providers does
    try:
        go.set()
        t.join(5)
    finally:
        providers.PROVIDERS.pop(added, None)
    assert errors == []
