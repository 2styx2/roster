"""Ticket 16 ("Save to vault" for `auth: prompt` Hosts) through `roster serve`. A Host whose Login is still
`auth: prompt` has no password roster can look up, so session.prepare refuses with 39 until the app sends one the
user typed; it goes to ssh through askpass like any password. With save: true serve holds it, bound to the Session,
until ssh reports the login (as in ticket 15). host.save_login then creates the Vault item `<host> ssh` and points the
Host's Login at it as a Pending change, keeping every other byte of roster.yml (Q43: only after that login; the item
taken back out if the Host can't be updated). Against the local paramiko Host's recorded key, the stand-in bw and the
stand-in ssh; no network."""
# ruff: noqa: F811 (test_changes' fixtures, imported by name, are the tests' arguments)

import json
import os
import subprocess

import pytest
from conftest import SECRET
from test_changes import INVENTORY, app, box, git, infra, result, sshd  # noqa: F401 (fixtures)

from roster import serve as rpc
from roster import store
from roster.config import load_config
from roster.sshops import write_ssh_config

PROMPT = "root@127.0.0.1's password: "
PROMPTED = INVENTORY + """\
  far:
    user: root
    enroll: false
    auth: prompt            # nobody saved these yet
    hosts:
      pve: {{ip: 127.0.0.1, port: {port}}}   # the hypervisor
"""


@pytest.fixture
def prompted(box, sshd, capsys):
    """The scratch Inventory plus `pve`, whose Login is its group's `auth: prompt`; roster's ssh config written."""
    box.commit(PROMPTED.format(port=sshd.port))
    write_ssh_config(load_config(box.yml))      # what `roster sync` writes for ssh, without the Claude files
    capsys.readouterr()
    return box


def items(vault):
    return [i["name"] for i in json.loads(vault.read_text())]


def log_in(spec, password=SECRET):
    env = {**os.environ, **spec["env"], "FAKE_SSH_PROMPT": PROMPT, "FAKE_SSH_PASSWORD": password}
    return subprocess.run(spec["argv"], env=env, capture_output=True, text=True, timeout=30)


def nothing_written(box, vault):
    assert git(box, "status", "--porcelain") == ""
    assert items(vault) == ["esx ssh", "dup ssh", "dup ssh", "nopw ssh"]


# ---------------------------------------------------------------- session.prepare asks for the typed password

def test_a_prompt_host_needs_a_typed_password(prompted, app, sshd):
    err = app.call("session.prepare", {"host": "pve"})["error"]
    assert err["code"] == 39
    assert err["message"] == "pve's Login is auth: prompt - type its password"
    assert err["data"]["user"] == "root" and err["data"]["address"] == "127.0.0.1" and err["data"]["port"] == sshd.port
    assert sshd.accepts == 0


def test_the_typed_password_goes_to_ssh_through_askpass(prompted, app):
    spec = result(app.call("session.prepare", {"host": "pve", "password": SECRET}))
    assert spec["auth"] == "password" and "held" not in spec
    assert "PermitLocalCommand=yes" not in spec["argv"]
    assert log_in(spec).returncode == 0
    _, out, err = app.close()
    assert SECRET not in "".join(app.responses) + out + err


def test_a_password_for_a_host_with_a_stored_login_is_refused(prompted, app):
    err = app.call("session.prepare", {"host": "esx", "password": SECRET})["error"]
    assert err["code"] == -32602 and "auth: prompt" in err["message"]


# ---------------------------------------------------------------- host.save_login

def test_a_logged_in_prompt_host_gets_its_vault_item_and_login(prompted, app, sshd, vault):
    spec = result(app.call("session.prepare", {"host": "pve", "password": SECRET, "save": True}))
    assert spec["held"]
    assert log_in(spec).returncode == 0
    r = result(app.call("host.save_login", {"held": spec["held"]}))
    assert app.notes == [{"jsonrpc": "2.0", "method": "session.logged_in", "params": {"held": spec["held"]}}]
    assert r["changed"] is True and r["item"]["name"] == "pve ssh"
    assert r["host"]["ssh"]["auth"] == "bw:pve ssh"
    assert r["sync"] == {"ok": True}                  # T150: this Box's ssh config follows its new Login
    made = next(i for i in json.loads(vault.read_text()) if i["name"] == "pve ssh")
    assert made["login"]["username"] == "root"
    assert made["login"]["uris"] == [{"uri": f"ssh://127.0.0.1:{sshd.port}", "match": None}]
    text = prompted.yml.read_text()
    assert "# the hypervisor" in text and "# nobody saved these yet" in text and "bw:pve ssh" in text
    assert SECRET not in text + result(app.call("changes.diff"))["diff"]
    assert result(app.call("changes.diff"))["hosts"] == [{"host": "pve", "change": "changed", "fields": ["auth"]}]
    assert app.call("host.save_login", {"held": spec["held"]})["error"]["code"] == 67      # forgotten once saved


def test_a_failed_login_writes_nothing(prompted, app, vault):
    spec = result(app.call("session.prepare", {"host": "pve", "password": "wrong", "save": True}))
    assert log_in(spec).returncode == 255
    assert app.call("host.save_login", {"held": spec["held"]})["error"]["code"] == 66
    nothing_written(prompted, vault)


def test_a_duplicate_item_is_refused(prompted, app, vault):
    spec = result(app.call("session.prepare", {"host": "pve", "password": SECRET, "save": True}))
    log_in(spec)
    err = app.call("host.save_login", {"held": spec["held"], "item": "esx ssh"})["error"]
    assert err["code"] == 60
    nothing_written(prompted, vault)


def test_a_host_that_changed_since_its_session_isnt_saved(prompted, app, vault):
    spec = result(app.call("session.prepare", {"host": "pve", "password": SECRET, "save": True}))
    log_in(spec)
    prompted.commit(prompted.yml.read_text().replace("pve: {ip: 127.0.0.1", "pve: {ip: 127.0.0.2"))
    err = app.call("host.save_login", {"held": spec["held"]})["error"]
    assert err["code"] == 75 and "changed since" in err["message"]
    nothing_written(prompted, vault)


def test_a_quick_connects_id_isnt_a_hosts(prompted, app, sshd, vault):
    spec = result(app.call("session.prepare", {"host": "pve", "password": SECRET, "save": True}))
    log_in(spec)
    assert app.call("quick.save", {"quick": spec["held"], "name": "x", "group": "lab"})["error"]["code"] == 67


def test_a_failure_updating_the_host_takes_the_new_item_back_out(prompted, sshd, vault, fakes, monkeypatch):
    state = rpc.State(str(prompted.yml))

    def call(method, params):
        return rpc.handle(state, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
    assert "result" in call("vault.unlock", {"password": "hunter2"})
    with __import__("roster").askpass.Channel(rpc.askpass_lookup) as state.askpass:
        spec = call("session.prepare", {"host": "pve", "password": SECRET, "save": True})["result"]
        log_in(spec)
        monkeypatch.setattr(store, "replace_file", lambda *a, **k: (_ for _ in ()).throw(OSError(28, "No space left")))
        r = call("host.save_login", {"held": spec["held"]})
    err = r["error"]
    assert err["message"].startswith("pve's Login wasn't changed: couldn't write ")
    assert "No space left" in err["message"] and "the vault item 'pve ssh' was taken back out" in err["message"]
    nothing_written(prompted, vault)
    assert SECRET not in json.dumps(r)
