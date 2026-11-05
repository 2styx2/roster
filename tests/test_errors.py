"""Ticket 26: every Inventory- and vault-side way a Session can fail ends in its own stable code and roster's
wording (docs: docs/app/errors.md rows 1-10, 18, 19), from session.prepare, askpass and host.check.
The Inventory and the vault are edited by hand here, as a person would."""

import json
import os
import re
import subprocess
import sys

import pytest
from conftest import ALL_SECRETS, ITEMS, SECRET
from test_serve import run_askpass, synced

INVENTORY = """\
groups:
  lab:
    user: root
    enroll: false
    hosts:
      esx: {ip: 10.0.0.6, auth: "bw:esx ssh"}
      typo: {ip: 10.0.0.8, auth: "bw:esx shh"}
      dup: {ip: 10.0.0.7, auth: "bw:dup ssh"}
      nopw: {ip: 10.0.0.9, auth: "bw:nopw ssh"}
      field: {ip: 10.0.0.6, auth: "bw:esx ssh#enabel"}
      keeper: {ip: 10.0.0.10, auth: "keeper:esx ssh"}
      noone: {ip: 10.0.0.11, user: CHANGE-ME, auth: "bw:esx ssh"}
"""


@pytest.fixture
def pw_serve(serve, write_config, capsys, vault):
    synced(write_config, capsys, INVENTORY)
    s = serve()
    assert s.call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
    yield s
    _, out, err = s.close()
    leaks = "".join(s.responses) + out + err
    assert not [x for x in ALL_SECRETS if x in leaks]


def test_prepare_item_not_found_names_near_matches(pw_serve):
    err = pw_serve.call("session.prepare", {"host": "typo"})["error"]
    assert err["code"] == 32
    assert err["message"].startswith("no vault item named 'esx shh' (ssh Login of typo)")
    assert err["data"]["near"] == ["esx ssh"]
    assert "fix" in err["data"]


def test_prepare_several_items_lists_names_and_uris(pw_serve):
    err = pw_serve.call("session.prepare", {"host": "dup"})["error"]
    assert err["code"] == 33
    assert err["message"].startswith("2 vault items are named 'dup ssh' (ssh Login of dup)")
    assert err["data"]["matches"] == [
        {"name": "dup ssh", "revised": None, "uris": ["ssh://10.0.0.7"]},        # no date: the filter's rows (T229)
        {"name": "dup ssh", "revised": None, "uris": ["https://10.0.0.7"]}]
    assert "'dup ssh' (ssh://10.0.0.7); 'dup ssh' (https://10.0.0.7)" in err["message"]


def test_prepare_item_without_a_password(pw_serve):
    err = pw_serve.call("session.prepare", {"host": "nopw"})["error"]
    assert (err["code"], err["message"]) == (34, "vault item 'nopw ssh' has no password (ssh Login of nopw)")


def test_prepare_item_without_the_field_the_login_names(pw_serve):
    err = pw_serve.call("session.prepare", {"host": "field"})["error"]
    assert (err["code"], err["message"]) == (34, "vault item 'esx ssh' has no field 'enabel' (ssh Login of field)")


def test_prepare_login_with_a_provider_this_box_doesnt_have(pw_serve):
    err = pw_serve.call("session.prepare", {"host": "keeper"})["error"]
    assert err["code"] == 31
    assert err["message"] == "keeper's ssh Login uses 'keeper:', which isn't set up on this box"
    assert "roster vault status" in err["data"]["fix"]


def test_prepare_host_whose_user_is_the_placeholder(pw_serve):
    err = pw_serve.call("session.prepare", {"host": "noone"})["error"]
    assert (err["code"], err["message"]) == (30, "no SSH user for noone (user: CHANGE-ME in roster.yml)")


def test_prepare_a_good_login_still_gets_its_token(pw_serve):
    spec = pw_serve.call("session.prepare", {"host": "esx"})["result"]
    assert spec["auth"] == "password" and run_askpass(spec).stdout == SECRET + "\n"


# ---------------------------------------------------------------- askpass: the reason line carries the code

ASKPASS_LINE = re.compile(r"roster askpass: \[(\d+)\] (.+)")


@pytest.fixture
def in_process(write_config, capsys, vault):
    """serve's State and askpass channel in this process, so a test can change things between prepare and
    ssh's prompt (the vault item renamed, the cache gone) as can happen in a long-lived app."""
    from roster import askpass, providers
    from roster import serve as serve_mod

    synced(write_config, capsys, INVENTORY)
    state = serve_mod.State(None)
    logged = []
    with askpass.Channel(serve_mod.askpass_lookup, log=logged.append) as state.askpass:
        def call(method, params=None):
            return serve_mod.handle(state, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                                                       "params": params or {}}))
        assert call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
        yield call, logged, providers
    assert not [x for x in ALL_SECRETS if x in "".join(logged)]


def test_askpass_says_why_with_the_same_code_and_wording(in_process, vault):
    call, logged, providers = in_process
    spec = call("session.prepare", {"host": "esx"})["result"]
    providers._secrets.clear()
    vault.write_text(json.dumps([dict(ITEMS[0], name="esx root")]))         # renamed in the vault since
    r = run_askpass(spec)
    assert (r.returncode, r.stdout) == (1, "")
    code, message = ASKPASS_LINE.fullmatch(r.stderr.strip()).groups()
    assert code == "32" and message.startswith("no vault item named 'esx ssh' (ssh Login of esx)")
    assert "'esx root'" in message
    assert any("esx: no vault item named 'esx ssh'" in line for line in logged)


def test_askpass_says_when_the_token_is_spent(in_process):
    call, _, _ = in_process
    spec = call("session.prepare", {"host": "esx"})["result"]
    assert run_askpass(spec).returncode == 0
    code, message = ASKPASS_LINE.fullmatch(run_askpass(spec).stderr.strip()).groups()
    assert code == "37" and "open the Session again" in message


def test_askpass_without_serve_says_so(tmp_path):
    env = {**os.environ, "ROSTER_ASKPASS_SOCKET": str(tmp_path / "gone"), "ROSTER_ASKPASS_TOKEN": "t" * 43}
    r = subprocess.run([sys.executable, "-I", "-m", "roster.askpass", "Password: "], env=env,
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 1 and ASKPASS_LINE.fullmatch(r.stderr.strip()).group(1) == "38"
