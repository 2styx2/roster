"""Ticket 15 ("Save to vault" on Quick Connect) through `roster serve`. With save: true, quick.prepare holds the typed
password in serve's memory, bound to the Quick Connect's id, and the Session's ssh tells serve once it has logged in
with it (LocalCommand, run by ssh only after authentication). quick.save then creates the Vault item `<host> ssh` and
adds the Host as a Pending change (Q43: only after that login, item first, Host second, the item taken back out if
the Host can't be written), and records the key the user confirmed for the Session. The password is never re-sent,
never in a response or the log, and forgotten after one save, by vault.forget_typed, a lock, or after HOLD_FOR.
Against the local paramiko Host and the stand-in bw from test_changes; no network."""
# ruff: noqa: F811 (test_changes' fixtures, imported by name, are the tests' arguments)

import json
import os
import subprocess
import threading
import time

import pytest
from conftest import SECRET
from test_changes import app, box, git, infra, result, sshd  # noqa: F401 (fixtures)
from test_quick import needs_ssh, run_ssh, to

from roster import askpass, edit
from roster import serve as rpc
from roster.sshops import fingerprint

PROMPT = "root@127.0.0.1's password: "


def items(vault):
    return [i["name"] for i in json.loads(vault.read_text())]


def known_hosts(isolated):
    return isolated["home"] / ".ssh" / "roster_known_hosts"


@pytest.fixture
def unknown(isolated, box):
    known_hosts(isolated).write_text("")


def log_in(spec, password=SECRET):
    """The Session's ssh as the app starts it, run by the stand-in ssh: it asks askpass, and once the password is
    the right one it runs the LocalCommand, as OpenSSH does after authentication."""
    env = {**os.environ, **spec["env"], "FAKE_SSH_PROMPT": PROMPT, "FAKE_SSH_PASSWORD": password}
    return subprocess.run(spec["argv"], env=env, capture_output=True, text=True, timeout=30)


def save(app, spec, **params):
    return app.call("quick.save", {"quick": spec["quick"], "name": "nas", "group": "lab", **params})


def nothing_written(box, vault, isolated, known=""):
    assert git(box, "status", "--porcelain") == ""
    assert items(vault) == ["esx ssh", "dup ssh", "dup ssh", "nopw ssh"]
    assert known_hosts(isolated).read_text() == known


# ---------------------------------------------------------------- the save, after the Session logged in

def test_a_logged_in_quick_connect_is_saved_as_a_vault_item_and_a_host(app, box, sshd, vault, unknown, isolated):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET, save=True)))
    assert spec["held"] == spec["quick"]
    opts = [spec["argv"][i + 1] for i, a in enumerate(spec["argv"]) if a == "-o"]
    assert "PermitLocalCommand=yes" in opts and any(o.startswith("LocalCommand=") for o in opts)
    assert log_in(spec).returncode == 0
    r = result(save(app, spec))
    assert app.notes == [{"jsonrpc": "2.0", "method": "session.logged_in", "params": {"held": spec["quick"]}}]
    assert r["added"] is True and r["warnings"] == []
    assert r["sync"] == {"ok": True}                  # T150: this Box's ssh config has it now, no `roster sync`
    assert "Host nas\n" in (isolated["home"] / ".ssh" / "config.d" / "roster").read_text()
    assert r["item"]["name"] == "nas ssh" and r["item"]["provider"] == "bw"
    made = next(i for i in json.loads(vault.read_text()) if i["name"] == "nas ssh")
    assert made["login"]["username"] == "root"
    assert made["login"]["uris"] == [{"uri": f"ssh://127.0.0.1:{sshd.port}", "match": None}]
    h = r["host"]
    assert (h["name"], h["group"], h["ip"], h["reviewed"], h["enroll"]) == ("nas", "lab", "127.0.0.1", True, False)
    assert h["ssh"] == {"user": "root", "port": sshd.port, "auth": "bw:nas ssh"}
    # the key the user confirmed for the Session, recorded for the new Host now (no new scan: one accept, the scan)
    assert known_hosts(isolated).read_text() == sshd.known_hosts_line()
    assert sshd.accepts == 1
    pending = box.yml.read_text() + result(app.call("changes.diff"))["diff"]
    assert SECRET not in pending and "auth: bw:nas ssh" in pending
    assert result(app.call("changes.diff"))["hosts"] == [{"host": "nas", "change": "added", "fields": []}]


def test_the_password_is_forgotten_after_one_save(app, box, sshd, vault, unknown):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET, save=True)))
    log_in(spec)
    result(save(app, spec))
    err = save(app, spec, name="nas2")["error"]
    assert err["code"] == 67 and "nas2" not in box.yml.read_text()


def test_a_failed_login_saves_nothing(app, box, sshd, vault, unknown, isolated):
    spec = result(app.call("quick.prepare", to(sshd, password="wrong", save=True)))
    assert log_in(spec, password=SECRET).returncode == 255          # the box refused it: no LocalCommand
    err = save(app, spec)["error"]
    assert err["code"] == 66 and app.notes == []
    assert "hasn't logged in" in err["message"] and err["data"]["fix"]
    nothing_written(box, vault, isolated)


def test_nothing_is_saved_before_the_login(app, box, sshd, vault, unknown, isolated):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET, save=True)))
    assert save(app, spec)["error"]["code"] == 66
    nothing_written(box, vault, isolated)


def test_without_save_nothing_is_held(app, box, sshd, vault, unknown, isolated):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET)))
    assert "held" not in spec
    assert not any("LocalCommand" in a for a in spec["argv"])
    log_in(spec)
    assert save(app, spec)["error"]["code"] == 67
    nothing_written(box, vault, isolated)


def test_a_duplicate_item_name_leaves_the_vault_and_the_inventory_untouched(app, box, sshd, vault, unknown,
                                                                              isolated):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET, save=True)))
    log_in(spec)
    err = save(app, spec, name="esx2", item="esx ssh")["error"]
    assert err["code"] == 60 and "esx ssh" in err["message"]
    nothing_written(box, vault, isolated)
    # still held: another name works
    assert result(save(app, spec, name="esx2"))["item"]["name"] == "esx2 ssh"


@pytest.mark.parametrize("params, code", [({"name": "esx"}, 81), ({"name": "bad name"}, 80),
                                          ({"group": "a b"}, 80), ({"name": ""}, -32602)])
def test_a_bad_name_or_group_is_refused_before_the_vault(app, box, sshd, vault, unknown, isolated, params, code):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET, save=True)))
    log_in(spec)
    assert save(app, spec, **params)["error"]["code"] == code
    nothing_written(box, vault, isolated)


def test_save_to_is_where_the_item_goes(serve, box, sshd, vault, unknown, monkeypatch):
    from test_save_to import ORGS
    monkeypatch.setenv("FAKE_BW_ORGS", json.dumps(ORGS))
    app = serve("-c", str(box.yml))
    result(app.call("vault.unlock", {"password": "hunter2"}))
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET, save=True)))
    log_in(spec)
    target = result(app.call("vault.targets"))["targets"][1]
    r = result(save(app, spec, save_to=target["save_to"]))
    assert r["item"]["target"]["id"] == target["id"]


# ---------------------------------------------------------------- forgetting

def test_forget_typed_forgets_it(app, box, sshd, vault, unknown):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET, save=True)))
    log_in(spec)
    assert result(app.call("vault.forget_typed", {"held": spec["held"]})) == {"forgotten": True}
    assert result(app.call("vault.forget_typed", {"held": spec["held"]})) == {"forgotten": False}
    assert save(app, spec)["error"]["code"] == 67


def test_a_lock_forgets_it(app, box, sshd, vault, unknown):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET, save=True)))
    log_in(spec)
    result(app.call("vault.lock"))
    result(app.call("vault.unlock", {"password": "hunter2"}))
    assert save(app, spec)["error"]["code"] == 67


def test_it_is_forgotten_after_hold_for(box, sshd, vault, unknown, fakes, monkeypatch):
    state = unlocked(box)
    monkeypatch.setattr(rpc, "HOLD_FOR", 0)
    with __import__("roster").askpass.Channel(rpc.askpass_lookup) as state.askpass:
        spec = call(state, "quick.prepare", to(sshd, password=SECRET, save=True))["result"]
        log_in(spec)
        assert call(state, "quick.save", {"quick": spec["quick"], "name": "nas", "group": "lab"})["error"]["code"] == 67


def test_a_login_report_without_the_password_handed_out_counts_for_nothing(app, box, sshd, vault, unknown):
    """The box accepted no password (or none was asked for): the LocalCommand's report doesn't make it a login with
    that password."""
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET, save=True)))
    local = next(a for a in spec["argv"] if a.startswith("LocalCommand="))
    helper = local.split("=", 1)[1].strip("'\"")       # the logged-in script (roster-askpass-login.exe on Windows)
    subprocess.run([helper], env={**os.environ, **spec["env"]}, timeout=30, check=True)
    assert save(app, spec)["error"]["code"] == 66


@pytest.mark.parametrize("params", [{"save": True}, {"save": "yes", "password": SECRET}])
def test_save_needs_a_typed_password(app, sshd, unknown, params):
    err = app.call("quick.prepare", to(sshd, **params))["error"]
    assert err["code"] == -32602 and "save" in err["message"]


# ---------------------------------------------------------------- the item comes back out when the Host can't go in

def unlocked(box):
    state = rpc.State(str(box.yml))
    assert "result" in call(state, "vault.unlock", {"password": "hunter2"})
    return state


def call(state, method, params):
    return rpc.handle(state, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))


def test_a_failure_adding_the_host_takes_the_new_item_back_out(box, sshd, vault, unknown, isolated, fakes,
                                                              monkeypatch):
    state = unlocked(box)
    with __import__("roster").askpass.Channel(rpc.askpass_lookup) as state.askpass:
        spec = call(state, "quick.prepare", to(sshd, password=SECRET, save=True))["result"]
        log_in(spec)
        real, calls = edit.add_text, []

        def second_add_breaks(text, *a):
            calls.append(1)
            return real(text, *a) if len(calls) == 1 else text.replace("groups:", "groups: [", 1)
        monkeypatch.setattr(edit, "add_text", second_add_breaks)
        r = call(state, "quick.save", {"quick": spec["quick"], "name": "nas", "group": "lab"})
    err = r["error"]
    assert err["code"] == 74 and "the vault item 'nas ssh' was taken back out" in err["message"]
    nothing_written(box, vault, isolated)
    assert SECRET not in json.dumps(r)


# ---------------------------------------------------------------- OpenSSH runs the LocalCommand after the login

@needs_ssh
def test_openssh_reports_the_login_and_the_save_goes_through(app, box, sshd, vault, unknown, isolated):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET, save=True)))
    r = run_ssh(spec, "true")
    assert ("password", "root") in sshd.attempts, r.stderr
    assert result(save(app, spec))["host"]["ssh"]["auth"] == "bw:nas ssh"
    assert known_hosts(isolated).read_text() == sshd.known_hosts_line()
    _, out, err = app.close()
    assert SECRET not in "".join(app.responses) + out + err + r.stdout + r.stderr


@needs_ssh
def test_openssh_with_a_wrong_password_reports_nothing(app, box, sshd, vault, unknown, isolated):
    spec = result(app.call("quick.prepare", to(sshd, password="wrong", save=True)))
    run_ssh(spec, "true")
    assert save(app, spec)["error"]["code"] == 66
    nothing_written(box, vault, isolated)


def test_the_log_names_the_login_never_the_password(app, box, sshd, vault, unknown):
    spec = result(app.call("quick.prepare", to(sshd, password=SECRET, save=True)))
    log_in(spec)
    result(save(app, spec))
    _, out, err = app.close()
    assert f"askpass: root@127.0.0.1:{sshd.port}: logged in" in err
    assert SECRET not in "".join(app.responses) + out + err
    assert fingerprint(sshd.key) in "".join(app.responses)


# ---------------------------------------------------------------- the held passwords across serve's threads

def test_a_login_report_waits_while_the_held_passwords_change(box):
    """ssh's login report arrives on the askpass channel's thread: it marks the Held under the same lock as every
    change to the held passwords, so a password being forgotten is never reported as logged in."""
    state = rpc.State(str(box.yml))
    notes = []
    state.notify = lambda method, params: notes.append((method, params))
    typed = askpass.Typed(SECRET)
    hid = rpc.hold(state, "q1", typed, "quick", "root@box")
    with state.held_lock:
        report = threading.Thread(target=typed.on_login)
        report.start()
        report.join(0.2)
        assert report.is_alive()                # it waits for the lock
        assert rpc.forget_held(state, hid)
    report.join(2)
    assert notes == [] and state.held == {} and typed.password is None


def eventually(check, timeout=3.0):
    end = time.monotonic() + timeout
    while not check() and time.monotonic() < end:
        time.sleep(0.05)
    return check()


def test_a_held_password_goes_once_hold_for_is_up_without_another_call(box, sshd, vault, unknown, fakes,
                                                                       monkeypatch):
    """HOLD_FOR is enforced by serve itself (the askpass channel's tick), not only when the next save comes."""
    state = unlocked(box)
    monkeypatch.setattr(rpc, "HOLD_FOR", 0.5)
    with rpc.open_channel(state) as state.askpass:
        spec = call(state, "quick.prepare", to(sshd, password=SECRET, save=True))["result"]
        typed = state.held[spec["held"]].typed
        assert eventually(lambda: state.held == {})
        assert typed.password is None


def test_a_password_handed_to_ssh_goes_once_its_login_report_is_overdue(box, sshd, vault, unknown, fakes,
                                                                        monkeypatch):
    """The box refused the password, so no login report ever comes: the channel drops what it kept for one."""
    monkeypatch.setenv("ROSTER_ASKPASS_TTL", "0.2")
    state = unlocked(box)
    with rpc.open_channel(state) as state.askpass:
        spec = call(state, "quick.prepare", to(sshd, password=SECRET, save=True))["result"]
        log_in(spec, password="wrong")
        assert eventually(lambda: state.askpass.handed == {})


def test_nothing_is_left_of_a_quick_connect_once_its_password_is_saved_or_was_never_held(box, sshd, vault, unknown,
                                                                                        fakes):
    state = unlocked(box)
    with rpc.open_channel(state) as state.askpass:
        for _ in range(3):
            call(state, "quick.prepare", to(sshd))
        spec = call(state, "quick.prepare", to(sshd, password=SECRET, save=True))["result"]
        log_in(spec)
        assert "result" in call(state, "quick.save", {"quick": spec["quick"], "name": "nas", "group": "lab"})
        assert state.held == {} and not getattr(state, "quick", {})


def test_serve_holds_at_most_held_limit_passwords(box, monkeypatch):
    """The oldest goes first: a box that types passwords faster than it saves them can't grow serve's memory."""
    state = rpc.State(str(box.yml))
    monkeypatch.setattr(rpc, "HELD_LIMIT", 2)
    typed = [askpass.Typed(f"pw{i}") for i in range(3)]
    for i, t in enumerate(typed):
        rpc.hold(state, f"q{i}", t, "quick", "root@box")
    assert list(state.held) == ["q1", "q2"]
    assert typed[0].password is None
