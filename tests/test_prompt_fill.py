"""Filling a password prompt in a Session from the vault (ticket 119, decision Q129): `session.fill` says which of a
Host's Logins answers the prompt the Session shows, or why none may, and hands the password to the app's core only.
The prompt is text off the Session's screen, so it's the Host's word: it can only narrow what roster fills."""

import json

import pytest

from roster.config import load_config_text
from roster.errors import Problem
from roster.fill import FILL_REFUSED, NOTHING_TO_FILL, login_for

INVENTORY = """\
groups:
  lab:
    user: ops
    auth: bw:Network gear
    hosts:
      esx: {ip: 10.0.0.6, enroll: false}
      box: {ip: 10.0.0.5, sudo: {auth: "bw:Network gear (old)"}}
      keyed: {ip: 10.0.0.7, auth: agent}
      keyed-sudo: {ip: 10.0.0.8, auth: agent, sudo: {auth: "bw:Network gear (old)"}}
      typed: {ip: 10.0.0.9, auth: prompt}
  found:
    reviewed: false
    user: ops
    auth: bw:Network gear
    hosts:
      server-10-0-0-20: {ip: 10.0.0.20}
"""
PASSWORD, SUDO_PASSWORD = "pw-netops", "stale"      # what the fake bw holds for the two items


def fill(name, prompt, text=INVENTORY):
    """login_for Host NAME of TEXT at PROMPT, with its sudo: reference as serve passes it."""
    cfg = load_config_text(text, "/tmp/roster.yml")
    return login_for(cfg["hosts"][name], prompt, cfg["sudo"].get(name))


def test_sudos_prompt_for_the_login_user_takes_the_ssh_login_by_default():
    assert fill("esx", "[sudo] password for ops: ") == ("ssh", "bw:Network gear")


def test_a_sudo_override_answers_sudo():
    assert fill("box", "[sudo] password for ops: ") == ("sudo", "bw:Network gear (old)")


@pytest.mark.parametrize("prompt", ["ops@esx's password: ", "ops@10.0.0.6's password:"])
def test_a_nested_ssh_to_the_hosts_own_name_or_address_and_user_takes_the_ssh_login(prompt):
    assert fill("esx", prompt) == ("ssh", "bw:Network gear")


def test_a_nested_ssh_prompt_names_the_host_as_ssh_prints_it_lowercased():
    """ssh lowercases the host it prints; the Host's name in roster.yml may have capitals (ticket 120)."""
    cfg = load_config_text(INVENTORY.replace("esx: {", "ESX-Lab: {"), "/tmp/roster.yml")
    assert login_for(cfg["hosts"]["ESX-Lab"], "ops@esx-lab's password: ") == ("ssh", "bw:Network gear")


def test_a_nested_ssh_takes_the_ssh_login_even_with_a_sudo_override():
    assert fill("box", "ops@10.0.0.5's password: ") == ("ssh", "bw:Network gear")


@pytest.mark.parametrize("prompt, says", [
    ("Password: ", "doesn't say whose"),               # su (root's), login, telnet, a nested keyboard-interactive
    ("password:", "doesn't say whose"),
    ("Password for ops: ", "doesn't say whose"),
    ("ops@localhost's password: ", "ops@localhost"),   # a tunnel's localhost may be any machine
    ("ops@127.0.0.1's password: ", "ops@127.0.0.1"),
])
def test_a_prompt_that_isnt_provably_this_hosts_is_refused(prompt, says):
    with pytest.raises(Problem) as e:
        fill("box", prompt)
    assert e.value.code == FILL_REFUSED and says in e.value.message


@pytest.mark.parametrize("prompt", ["Enter passphrase for key '/home/ops/.ssh/id_ed25519': ", "Username: ",
                                    "$ ", "password: hunter2", "Verification code: ", ""])
def test_what_isnt_a_password_prompt_is_refused(prompt):
    with pytest.raises(Problem) as e:
        fill("esx", prompt)
    assert e.value.code == FILL_REFUSED and "isn't a password prompt" in e.value.message


def test_only_the_line_at_the_cursor_counts():
    assert fill("esx", "some output\r\n[sudo] password for ops: ") == ("ssh", "bw:Network gear")


@pytest.mark.parametrize("name, says", [("keyed", "auth: agent"), ("typed", "auth: prompt")])
def test_a_login_with_no_saved_password_has_nothing_to_fill(name, says):
    with pytest.raises(Problem) as e:
        fill(name, "[sudo] password for ops: ")
    assert e.value.code == NOTHING_TO_FILL and says in e.value.message and "sudo:" in e.value.fix


def test_a_key_host_with_a_sudo_override_fills_it():
    assert fill("keyed-sudo", "[sudo] password for ops: ") == ("sudo", "bw:Network gear (old)")


def test_a_key_host_has_nothing_for_a_nested_ssh_even_with_a_sudo_override():
    with pytest.raises(Problem) as e:
        fill("keyed-sudo", "ops@10.0.0.8's password: ")
    assert e.value.code == NOTHING_TO_FILL


# ---------------------------------------------------------------- roster.yml's sudo: block

def test_sudo_cascades_from_the_group_and_stays_off_the_host():
    text = INVENTORY.replace("    auth: bw:Network gear\n    hosts:\n      esx",
                             "    auth: bw:Network gear\n    sudo: {auth: bw:lab sudo}\n    hosts:\n      esx", 1)
    cfg = load_config_text(text, "/tmp/roster.yml")
    assert cfg["sudo"]["esx"] == "bw:lab sudo" and cfg["sudo"]["box"] == "bw:Network gear (old)"
    assert "sudo" not in cfg["hosts"]["esx"]            # host.get and the Plugin API's Host are as they were


@pytest.mark.parametrize("block, says", [
    ("sudo: bw:x", "sudo: must be a mapping"),
    ("sudo: {auth: bw:x, user: root}", "sudo: must be a mapping"),
    ("sudo: {auth: prompt}", "a vault reference"),
    ("sudo: {auth: agent}", "a vault reference"),
])
def test_a_bad_sudo_block_says_how(block, says):
    with pytest.raises(SystemExit) as e:
        load_config_text(INVENTORY.replace("{ip: 10.0.0.6, enroll: false}", f"{{ip: 10.0.0.6, {block}}}"),
                         "/tmp/roster.yml")
    assert says in str(e.value.code)


# ---------------------------------------------------------------- session.fill, as the app's core calls it

SUDO = "[sudo] password for ops: "
# What each Session connected to, as session.prepare's `login` said: the core sends it back with the fill.
AS = {"esx": ("10.0.0.6", 22, "ops"), "box": ("10.0.0.5", 22, "ops"), "keyed": ("10.0.0.7", 22, "ops"),
      "keyed-sudo": ("10.0.0.8", 22, "ops"), "server-10-0-0-20": ("10.0.0.20", 22, "ops")}


def params(host, prompt=SUDO, **over):
    address, port, user = AS.get(host, ("10.0.0.99", 22, "ops"))
    return {"host": host, "address": address, "port": port, "user": user, "prompt": prompt, **over}


def unlocked(serve, write_config, text=INVENTORY):
    write_config(text)
    s = serve()
    assert s.call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
    return s


def test_session_fill_hands_the_core_the_logins_password(serve, write_config, fakes):
    s = unlocked(serve, write_config)
    assert s.call("session.fill", params("esx"))["result"] == {"host": "esx", "login": "ssh", "password": PASSWORD}
    assert s.call("session.fill", params("box"))["result"] == {"host": "box", "login": "sudo", "password": SUDO_PASSWORD}
    # A key Login's Host fills from its sudo: reference (the app's fake does the same).
    assert s.call("session.fill", params("keyed-sudo"))["result"]["password"] == SUDO_PASSWORD
    code, _, err = s.close()
    assert code == 0 and PASSWORD not in err and SUDO_PASSWORD not in err


def test_session_fill_refuses_before_looking_anything_up(serve, write_config, fakes):
    s = unlocked(serve, write_config)
    refused = s.call("session.fill", params("esx", "root@10.0.0.9's password: "))["error"]
    assert refused["code"] == FILL_REFUSED and PASSWORD not in json.dumps(refused)
    assert s.call("session.fill", params("esx", "Password: "))["error"]["code"] == FILL_REFUSED
    assert s.call("session.fill", params("keyed"))["error"]["code"] == NOTHING_TO_FILL
    assert s.call("session.fill", params("nope"))["error"]["code"] == 2
    assert s.call("session.fill", params("server-10-0-0-20"))["error"]["code"] == 20
    for missing in ("prompt", "address", "port", "user"):
        p = params("esx")
        del p[missing]
        assert s.call("session.fill", p)["error"]["code"] == -32602, missing
    assert s.call("session.fill", params("esx", 3))["error"]["code"] == -32602


@pytest.mark.parametrize("change, says", [
    ({"address": "10.0.0.66"}, "10.0.0.66"),
    ({"port": 2222}, "2222"),
    ({"user": "root"}, "root"),
])
def test_session_fill_refuses_a_host_that_changed_since_its_session_connected(serve, write_config, fakes,
                                                                                change, says):
    """The Session connected to what session.prepare said; a Host edited since (a new address, port or user) may be
    another box now, so its password isn't filled into that Session."""
    s = unlocked(serve, write_config)
    err = s.call("session.fill", params("esx", **change))["error"]
    assert err["code"] == FILL_REFUSED and "changed since" in err["message"] and says in err["message"]
    assert PASSWORD not in json.dumps(err)


def test_session_prepare_says_what_the_session_connects_to(serve, write_config, capsys, fakes):
    from test_serve import synced
    synced(write_config, capsys, INVENTORY)
    s = serve()
    s.call("vault.unlock", {"password": "hunter2"})
    for host in ("esx", "keyed"):
        login = s.call("session.prepare", {"host": host})["result"]["login"]
        address, port, user = AS[host]
        assert login == {"address": address, "port": port, "user": user}


def test_session_fill_while_locked_says_unlock_first(serve, write_config, fakes):
    write_config(INVENTORY)
    err = serve().call("session.fill", params("esx"))["error"]
    assert (err["code"], err["message"]) == (14, "bw vault is locked - unlock it first")


def test_session_fill_names_the_sudo_login_when_its_item_is_missing(serve, write_config, fakes):
    s = unlocked(serve, write_config, INVENTORY.replace("bw:Network gear (old)", "bw:no such item"))
    err = s.call("session.fill", params("box"))["error"]
    assert err["code"] == 32 and "sudo Login of box" in err["message"]


def test_the_apps_list_of_logins_without_a_password_is_roster_s():
    """app/src/backend/types.ts keeps providers.NO_PASSWORD as NO_PASSWORD_AUTHS: one list, checked here."""
    import re
    from pathlib import Path

    from roster import providers
    ts = (Path(__file__).parents[1] / "app" / "src" / "backend" / "types.ts").read_text(encoding="utf-8")
    m = re.search(r"export const NO_PASSWORD_AUTHS = \[([^\]]*)\]", ts)
    assert m and tuple(re.findall(r'"([^"]+)"', m[1])) == providers.NO_PASSWORD


# ---------------------------------------------------------------- a nested ssh's Host (ticket 120, decision Q131)

def hop(name, **over):
    """session.fill's `hop`: the Inventory Host a nested ssh in the Session went to, as the app resolved it."""
    address, port, user = AS[name]
    return {"host": name, "address": address, "port": port, "user": user, **over}


def test_session_fill_answers_a_nested_ssh_with_the_host_it_went_to(serve, write_config, fakes):
    s = unlocked(serve, write_config)
    got = s.call("session.fill", params("esx", "ops@box's password: ", hop=hop("box")))["result"]
    assert got == {"host": "box", "login": "ssh", "password": PASSWORD}
    got = s.call("session.fill", params("esx", "ops@10.0.0.5's password: ", hop=hop("box")))["result"]
    assert got["host"] == "box"
    # That Host's sudo, from its own sudo: reference.
    assert s.call("session.fill", params("esx", SUDO, hop=hop("box")))["result"] == {
        "host": "box", "login": "sudo", "password": SUDO_PASSWORD}


@pytest.mark.parametrize("prompt, says", [
    ("ops@esx's password: ", "ops@esx"),               # the Session's own Host, not the one the ssh went to
    ("root@box's password: ", "root@box"),
    ("ops@localhost's password: ", "localhost"),
    ("Password: ", "doesn't say whose"),
])
def test_session_fill_refuses_a_nested_prompt_that_isnt_that_hosts_own(serve, write_config, fakes, prompt, says):
    s = unlocked(serve, write_config)
    err = s.call("session.fill", params("esx", prompt, hop=hop("box")))["error"]
    assert err["code"] == FILL_REFUSED and says in err["message"] and PASSWORD not in json.dumps(err)


@pytest.mark.parametrize("change, says", [
    ({"address": "10.0.0.66"}, "10.0.0.66"),
    ({"port": 2222}, "2222"),
    ({"user": "root"}, "root"),
])
def test_session_fill_refuses_a_nested_host_that_isnt_what_the_app_resolved(serve, write_config, fakes, change, says):
    """The app resolved the ssh's target from the Inventory it had; one edited since may be another box."""
    s = unlocked(serve, write_config)
    err = s.call("session.fill", params("esx", "ops@box's password: ", hop=hop("box", **change)))["error"]
    assert err["code"] == FILL_REFUSED and "since this ssh started" in err["message"] and says in err["message"]


def test_session_fill_checks_the_sessions_own_host_and_the_nested_one(serve, write_config, fakes):
    s = unlocked(serve, write_config)
    moved = params("esx", "ops@box's password: ", address="10.0.0.66", hop=hop("box"))
    assert "since this Session connected" in s.call("session.fill", moved)["error"]["message"]
    assert s.call("session.fill", params("esx", "ops@keyed's password: ", hop=hop("keyed")))["error"]["code"] == \
        NOTHING_TO_FILL
    assert s.call("session.fill", params("esx", SUDO, hop=hop("server-10-0-0-20")))["error"]["code"] == 20
    assert s.call("session.fill", params("esx", SUDO, hop={**hop("box"), "host": "nope"}))["error"]["code"] == 2
    for bad in ("box", {"host": "box"}, {**hop("box"), "port": "22"}, {**hop("box"), "user": ""}):
        assert s.call("session.fill", params("esx", SUDO, hop=bad))["error"]["code"] == -32602, bad
