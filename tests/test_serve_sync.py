"""T150 (#269): every Inventory change `roster serve` writes syncs this Box (its ssh config and Claude files, as
`roster sync` does), so a Session to a Host just added opens without `roster sync`. A failed sync never undoes the
change: it's reported in the result's `sync: {ok, error?, fix?}`, as changes.publish reports it. Outside edits the
watcher applies sync too, once they load (decision Q137). Scratch infra repos and the stand-in bw only; no network."""
# ruff: noqa: F811 (test_changes' fixtures, imported by name, are the tests' arguments)

import json
import queue

import pytest
from conftest import SECRET
from test_changes import app, box, git, infra, result, sshd  # noqa: F401 (fixtures)
from test_live import live, repo, save  # noqa: F401 (fixtures)

from roster import boxsync
from roster import serve as rpc
from roster.sshops import fingerprint


def ssh_config(isolated):
    f = isolated["home"] / ".ssh" / "config.d" / "roster"
    return f.read_text() if f.is_file() else ""


def roster_md(box):
    return (box / "ROSTER.md").read_text()


def add(app, **params):
    return app.call("host.add", {"group": "lab", "user": "root", "address": "10.0.0.50", **params})


def test_an_added_host_is_in_this_boxs_ssh_config_straight_away(app, box, isolated):
    assert "Host nas" not in ssh_config(isolated)
    r = result(add(app, name="nas"))
    assert r["added"] and r["sync"] == {"ok": True}
    assert "Host nas\n    HostName 10.0.0.50\n" in ssh_config(isolated)
    assert "nas" in roster_md(box)


def test_a_failed_sync_keeps_the_added_host_and_says_so(app, box, isolated):
    blocked = isolated["home"] / ".ssh" / "config.d" / "roster"
    blocked.mkdir(parents=True)                 # a folder where the ssh config goes: writing it fails
    r = result(add(app, name="nas"))
    assert r["added"] and r["host"]["name"] == "nas"
    assert r["sync"]["ok"] is False and r["sync"]["error"] and r["sync"]["fix"] == "run `roster sync` on this box"
    assert "      nas:" in box.yml.read_text()
    assert result(app.call("changes.diff"))["hosts"] == [{"host": "nas", "change": "added", "fields": []}]


def test_a_verified_add_syncs_after_the_vault_item_and_the_host(app, box, sshd, vault, isolated):
    r = result(add(app, name="lab-2", address="127.0.0.1", port=sshd.port, password=SECRET, enroll=False,
                   host_key=fingerprint(sshd.key)))
    assert r["item"] and r["sync"] == {"ok": True}
    assert "Host lab-2\n" in ssh_config(isolated)
    assert "IdentitiesOnly yes\n    PubkeyAuthentication no" in ssh_config(isolated)


def test_an_edited_host_is_synced(app, box, isolated):
    r = result(app.call("host.update", {"host": "esx", "changes": {"title": "ESXi 8"}}))
    assert r["changed"] and r["sync"] == {"ok": True}
    assert "# ESXi 8\nHost esx\n" in ssh_config(isolated)


def test_nothing_changed_syncs_nothing(app, box, isolated):
    r = result(app.call("host.update", {"host": "esx", "changes": {"title": "ESX"}}))
    assert r["changed"] is False and "sync" not in r
    assert ssh_config(isolated) == ""


def test_a_review_is_synced(app, box, isolated):
    result(add(app, name="nas"))
    r = result(app.call("host.review", {"host": "nas"}))
    assert r["changed"] and r["sync"] == {"ok": True}


def test_a_discard_takes_the_host_back_out_of_the_ssh_config(app, box, isolated):
    result(add(app, name="nas"))
    assert "Host nas\n" in ssh_config(isolated)
    r = result(app.call("changes.discard"))
    assert r["discarded"] and r["sync"] == {"ok": True}
    assert "Host nas\n" not in ssh_config(isolated) and "Host esx\n" in ssh_config(isolated)


def test_a_pull_brings_someone_elses_host_into_the_ssh_config(app, box, isolated):
    git(box.parent, "clone", "-q", str(box.parent / "origin.git"), str(box.other))
    box.commit(box.yml.read_text() + "      web-01: 10.0.0.60\n", where=box.other, msg="add web-01")
    r = result(app.call("inventory.pull"))
    assert r["updated"] and r["sync"] == {"ok": True}
    assert "Host web-01\n" in ssh_config(isolated)


# ---------------------------------------------------------------- the Live Inventory's edits (T28) and outside edits

@pytest.fixture
def live_s(live):
    return live()


def test_every_live_inventory_edit_is_synced(live_s, isolated):
    s = live_s
    steps = [("host.remove", {"host": "block"}), ("host.rename", {"host": "flow", "to": "flow-2"}),
             ("host.move", {"host": "sw1", "group": "lab"}), ("group.new", {"name": "dmz"}),
             ("group.rename", {"group": "dmz", "to": "edge"}), ("group.delete", {"group": "edge"})]
    for method, params in steps:
        assert s.ok(method, params)["sync"] == {"ok": True}, method
    config = ssh_config(isolated)
    assert "Host flow-2\n" in config and "Host flow\n" not in config and "Host block\n" not in config
    assert "Host sw1\n" in config


def test_an_edit_that_changes_nothing_syncs_nothing(live_s, isolated):
    r = live_s.ok("host.rename", {"host": "flow", "to": "flow"})
    assert r["changed"] is False and "sync" not in r and ssh_config(isolated) == ""


def test_an_outside_edit_applied_by_the_watcher_is_synced(live_s, repo, isolated):
    s = live_s
    s.ok("inventory.watch", {"auto": True})
    save(repo, repo.read_text().replace("      plain:", "      plain2:"))
    assert s.note()["params"] == {"applied": True, "error": None, "sync": {"ok": True}}
    assert "Host plain2\n" in ssh_config(isolated) and "Host plain\n" not in ssh_config(isolated)


def test_a_broken_outside_edit_syncs_nothing_until_it_loads(live_s, repo, isolated):
    s = live_s
    s.ok("inventory.watch", {"auto": True})
    good = repo.read_text()
    save(repo, good.replace("      flow: {ip: 10.0.0.2", "      flow: {ip: 10.0.0.2,,"))
    n = s.note()["params"]
    assert n["error"]["line"] and "sync" not in n and ssh_config(isolated) == ""
    save(repo, good.replace("      plain:", "      fixed:"))
    assert s.note()["params"]["sync"] == {"ok": True}
    assert "Host fixed\n" in ssh_config(isolated)


def test_an_outside_edit_not_applied_syncs_nothing_until_source_applies_it(live_s, repo, isolated):
    s = live_s
    s.ok("inventory.watch", {"auto": False})
    save(repo, repo.read_text().replace("      plain:", "      plain2:"))
    assert s.note()["params"] == {"applied": False, "error": None}
    assert ssh_config(isolated) == ""
    r = s.ok("inventory.reload")
    assert r["changed"] is True and r["sync"] == {"ok": True} and "Host plain2\n" in ssh_config(isolated)
    assert "sync" not in s.ok("inventory.reload")             # nothing changed since: nothing to sync


def test_source_with_a_broken_file_syncs_nothing(live_s, repo, isolated):
    live_s.ok("hosts.list")                                 # loaded while it was good
    repo.write_text("groups: [\n")
    r = live_s.ok("inventory.reload")
    assert r["error"]["line"] and "sync" not in r and ssh_config(isolated) == ""


# ---------------------------------------------------------------- anything a sync raises is a failed sync, never more

class Odd(Exception):
    """Not an OSError, a Problem or a die(): what a bug in the sync would raise."""


def broken_sync(*a, **k):
    raise Odd("hunter2")                        # its words never reach the result: they could be anything


def handle(state, method, params):
    return rpc.handle(state, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))


@pytest.mark.parametrize("method, params", [
    ("host.add", {"name": "nas", "group": "lab", "address": "10.0.0.50", "user": "root"}),
    ("host.update", {"host": "esx", "changes": {"title": "ESXi 8"}}),
    ("host.rename", {"host": "other", "to": "other-2"}),
])
def test_any_error_from_the_sync_is_a_failed_sync_and_the_change_stands(box, monkeypatch, method, params):
    monkeypatch.setattr(boxsync, "write_ssh_config", broken_sync)
    state = rpc.State(str(box.yml))
    r = handle(state, method, params)
    assert "error" not in r, r
    sync = r["result"]["sync"]
    assert sync["ok"] is False and sync["error"] and sync["fix"] == "run `roster sync` on this box"
    assert "hunter2" not in json.dumps(r)
    assert git(box, "status", "--porcelain", "--untracked-files=no") == "M roster.yml"


def test_the_watcher_still_notifies_and_keeps_watching_when_the_sync_raises(repo, monkeypatch):
    monkeypatch.setattr(boxsync, "write_ssh_config", broken_sync)
    monkeypatch.setattr(rpc, "WATCH_EVERY", 0.05)
    monkeypatch.setattr(rpc, "WATCH_SETTLE", 0.05)
    notes = queue.Queue()
    state = rpc.State(str(repo))
    state.notify = lambda method, params: notes.put(params)
    state.auto = True
    watcher = rpc.Watcher(state)
    watcher.start()
    try:
        save(repo, repo.read_text().replace("      plain:", "      plain2:"))
        first = notes.get(timeout=3)
        assert first["applied"] is True and first["sync"]["ok"] is False and "hunter2" not in json.dumps(first)
        save(repo, repo.read_text().replace("      plain2:", "      plain3:"))
        assert notes.get(timeout=3)["applied"] is True          # still watching
        assert watcher.is_alive()
    finally:
        watcher.stop.set()
        watcher.join()
