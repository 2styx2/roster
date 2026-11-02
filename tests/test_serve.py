"""`roster serve`: JSON-RPC 2.0 over stdin/stdout, driven as the desktop app drives it - a subprocess."""

import json
import os
import shutil
import stat
import subprocess
import time

import paramiko
import pytest
from conftest import EXAMPLES

from roster import __version__
from roster.cli import main
from roster.common import known_hosts_file
from roster.sshops import hk_name


def test_inventory_info(serve, isolated):
    example = isolated["work"] / "roster.yml"
    example.write_text((EXAMPLES / "roster.example.yml").read_text())
    s = serve()
    info = s.call("inventory.info")["result"]
    assert info["path"] == str(example.resolve())
    assert info["box"] and info["host_count"] == 5
    assert {"bw", "op", "env", "prompt"} <= set(info["providers"])
    assert info["roster_version"] == __version__ and info["api_version"] == 26
    assert s.close() == (0, "", "")


INVENTORY = """\
groups:
  lab:
    title: Lab gear
    user: ops
    auth: bw:lab ssh
    hosts:
      box: {ip: 10.0.0.5, title: Lab box, web: "https://10.0.0.5"}
      esx:
        ip: 10.0.0.6
        user: root
        enroll: false
        services:
          admin: {url: "https://10.0.0.6:943", user: webadmin, auth: env:WEB}
  found:
    reviewed: false
    user: CHANGE-ME
    hosts:
      server-10-0-0-9: {ip: 10.0.0.9, port: 2222}
"""


def roster_hosts(capsys, *argv):
    """`roster hosts ...` rows as {name: [columns]}."""
    assert main(["hosts", *argv]) == 0
    rows = [ln.split() for ln in capsys.readouterr().out.splitlines() if ln.strip()]
    return {r[0]: r for r in rows[1:] if not r[0].isdigit()}


def test_hosts_list_agrees_with_roster_hosts(serve, write_config, capsys):
    write_config(INVENTORY)
    listing = serve().call("hosts.list")["result"]
    hosts = {h["name"]: h for h in listing["hosts"]}

    every = roster_hosts(capsys, "--all")
    assert set(hosts) == set(every) == {"box", "esx", "server-10-0-0-9"}
    for name, row in every.items():
        ssh = hosts[name]["ssh"]
        assert row[1] == hosts[name]["ip"] + ("" if ssh["port"] == 22 else f":{ssh['port']}")
    for group in ("lab", "found"):
        assert {n for n, h in hosts.items() if h["group"] == group} == set(roster_hosts(capsys, "--only", group))
    assert {n for n, h in hosts.items() if h["reviewed"]} == set(roster_hosts(capsys)) == {"box", "esx"}

    assert listing["groups"] == {"lab": {"title": "Lab gear", "description": ""},
                                 "found": {"title": "", "description": ""}}


def test_hosts_come_back_as_roster_builds_them(serve, write_config):
    """The resolved ssh login, services, default login and text fields - auth as a reference, never a value."""
    write_config(INVENTORY)
    hosts = {h["name"]: h for h in serve().call("hosts.list")["result"]["hosts"]}
    esx = hosts["esx"]
    assert esx["ssh"] == {"user": "root", "port": 22, "auth": "bw:lab ssh"}
    assert esx["login"] == {"user": "root", "auth": "bw:lab ssh"}
    assert esx["enroll"] is False and esx["title"] == "" and hosts["box"]["title"] == "Lab box"
    assert esx["services"]["admin"]["url"] == "https://10.0.0.6:943"
    assert esx["services"]["admin"]["auth"] == "env:WEB" and esx["services"]["admin"]["user"] == "webadmin"
    assert hosts["box"]["web"] == "https://10.0.0.5"


def test_host_get(serve, write_config):
    write_config(INVENTORY)
    s = serve()
    box = s.call("host.get", {"name": "box"})["result"]
    assert box["name"] == "box" and box["ip"] == "10.0.0.5" and box["group"] == "lab"
    err = s.call("host.get", {"name": "nope"})["error"]
    assert err["code"] == 2 and err["message"] == "unknown host 'nope'"
    assert s.call("host.get", {})["error"]["code"] == -32602
    assert s.call("host.get", {"name": "esx"})["result"]["name"] == "esx"      # still serving
    assert s.close()[0] == 0


def test_host_get_has_everything_roster_info_shows(serve, write_config, capsys):
    """The app's Host details (ticket 18) draw `roster info HOST` from host.get alone: every field and every
    service's port, url and Login (the vault reference, never a value) is in the result."""
    write_config(INVENTORY)
    esx = serve().call("host.get", {"name": "esx"})["result"]
    assert main(["info", "esx"]) == 0
    info = capsys.readouterr().out
    assert f"{esx['ssh']['user']}@{esx['ip']}:{esx['ssh']['port']}" in info
    assert f"password: roster run {esx['name']} -- CMD" in info and esx["reviewed"] and not esx["enroll"]
    assert f"{esx['ssh']['user']}, auth {esx['ssh']['auth']}" in info
    assert f"{esx['login']['user']}, auth {esx['login']['auth']} (default for services)" in info
    admin = esx["services"]["admin"]
    assert admin["override"] and f"{admin['url']}  {admin['user']}, auth {admin['auth']} (own login)" in info
    assert str(admin["port"]) in info and esx["group"] in info and esx["type"] in info


def test_bad_requests_get_errors_and_the_server_keeps_going(serve, write_config):
    write_config(INVENTORY)
    s = serve()
    r = s.send("{not json")
    assert r["id"] is None and r["error"]["code"] == -32700
    assert s.send("[1, 2]")["error"]["code"] == -32600
    assert s.send('{"id": 7, "method": "hosts.list"}') == {          # no "jsonrpc": "2.0"
        "jsonrpc": "2.0", "id": 7, "error": {"code": -32600, "message": "expected a JSON-RPC 2.0 request object"}}
    assert s.call("hosts.delete")["error"] == {"code": -32601, "message": "unknown method 'hosts.delete'"}
    assert s.call("host.get", ["box"])["error"]["code"] == -32602
    s.p.stdin.write('{"jsonrpc": "2.0", "method": "hosts.list"}\n\n')   # a notification and a blank line: no reply
    assert s.call("inventory.info")["result"]["host_count"] == 3
    assert s.close() == (0, "", "")


def test_stdout_carries_only_responses(serve, write_config, isolated):
    """roster's own warnings (here: a provider plugin that doesn't load) go to stderr."""
    write_config(INVENTORY)
    (isolated["work"] / "providers").mkdir()
    (isolated["work"] / "providers" / "broken.py").write_text("raise ValueError('boom')\n")
    s = serve()
    assert s.call("inventory.info")["result"]["host_count"] == 3
    code, out, err = s.close()
    assert code == 0 and out == "" and "broken.py didn't load" in err


def test_an_inventory_that_doesnt_load_is_an_error_not_an_exit(serve, write_config):
    path = write_config("groups:\n  lab:\n    hosts:\n      box: {ip: 10.0.0.5}\n")
    s = serve()
    err = s.call("inventory.info")["error"]
    assert err["code"] == 1
    assert err["message"] == "host 'box' has no user (set it on the host, its group, or defaults)"
    assert err["data"] == {"path": str(path), "roster_version": __version__, "api_version": 26,
                           "fix": f"fix {path}, or run `roster init` if there's none yet"}
    assert s.call("hosts.list")["error"]["code"] == 1
    assert s.call("host.get", {"name": "box"})["error"]["code"] == 1
    assert s.close() == (0, "", "")


def test_no_inventory_at_all(serve):
    err = serve().call("inventory.info")["error"]
    assert err["code"] == 1 and "no roster.yml found" in err["message"] and err["data"]["path"] is None


def test_config_path_from_flag_or_environment(serve, write_config, monkeypatch):
    other = write_config(INVENTORY, name="other.yml")
    assert serve("--config", str(other)).call("inventory.info")["result"]["path"] == str(other)
    monkeypatch.setenv("ROSTER_CONFIG", str(other))
    assert serve().call("inventory.info")["result"]["host_count"] == 3


# ---- vault.status / vault.unlock / vault.lock (the lock screen)

def test_vault_status_names_the_inventorys_vault(serve, write_config, fakes):
    """bw is what the Host Logins use; env and prompt (the unreviewed group's default) can't be locked."""
    write_config(INVENTORY)
    assert serve().call("vault.status")["result"] == {
        "provider": "bw", "status": "locked", "can_write": True, "can_sign_out": True,       # vault.logout (T42)
        "save_to": {"setting": "personal", "from": "default"},             # where "Save to vault" goes (ticket 35)
        "providers": [{"provider": "bw", "status": "locked", "can_write": True, "can_sign_out": True},
                      {"provider": "env", "status": "unsupported", "can_write": False, "can_sign_out": False},
                      {"provider": "prompt", "status": "unsupported", "can_write": False, "can_sign_out": False}]}


def test_vault_unlock_wrong_then_right_password_never_echoes_either(serve, write_config, fakes):
    write_config(INVENTORY)
    s = serve()
    err = s.call("vault.unlock", {"password": "not-it-xyzzy"})["error"]
    assert err == {"code": 10, "message": "Bitwarden unlock failed (wrong master password?)"}
    assert s.call("vault.status")["result"]["status"] == "locked"
    assert s.call("vault.unlock", {"password": "hunter2"})["result"] == {"provider": "bw", "status": "unlocked",
                                                                         "can_write": True}
    assert s.call("vault.status")["result"]["status"] == "unlocked"
    assert s.call("vault.unlock", {})["error"]["code"] == -32602
    code, out, err = s.close()
    assert code == 0 and out == "" and err == ""
    transcript = json.dumps(s.responses) + out + err
    for secret in ("xyzzy", "hunter2", "fake-session-key"):
        assert secret not in transcript


def test_vault_not_logged_in_or_not_installed_says_what_to_do(serve, write_config, fakes, monkeypatch, tmp_path):
    write_config(INVENTORY)
    monkeypatch.setenv("FAKE_BW_LOGGED_OUT", "1")
    s = serve()
    logged_out = "Bitwarden CLI isn't logged in on this box - run `bw login` once"
    status = s.call("vault.status")["result"]
    assert (status["provider"], status["status"], status["message"]) == ("bw", "not-logged-in", logged_out)
    assert s.call("vault.unlock", {"password": "hunter2"})["error"] == {"code": 11, "message": logged_out}
    s.close()

    monkeypatch.setenv("PATH", str(tmp_path))                    # no bw anywhere
    s = serve()
    status = s.call("vault.status")["result"]
    assert status["status"] == "missing-cli" and status["message"].startswith("`bw` is not installed on this box")
    err = s.call("vault.unlock", {"password": "hunter2"})["error"]
    assert err["code"] == 12 and err["message"] == status["message"]
    assert s.call("vault.lock")["result"] == {"locked": ["bw"]}  # nothing to run, still forgets
    code, out, err = s.close()
    assert code == 0 and "hunter2" not in "".join(s.responses) + out + err


def test_vault_unlock_runs_bw_once(serve, write_config, fakes, monkeypatch, tmp_path):
    """Each `bw` call costs about a second of Node start-up, so unlocking is the one `bw unlock`: no `bw status`
    before it to see if bw is logged in, none after it to build the answer. Not logged in is one call too."""
    write_config(INVENTORY)
    log = tmp_path / "bw.log"
    monkeypatch.setenv("FAKE_LOG", str(log))

    def bw_commands():
        return [line.split()[1] for line in log.read_text().splitlines()]

    s = serve()
    assert s.call("vault.unlock", {"password": "hunter2"})["result"] == {"provider": "bw", "status": "unlocked",
                                                                         "can_write": True}
    assert bw_commands() == ["unlock"]
    log.write_text("")
    assert s.call("vault.unlock", {"password": "not-it"})["error"]["code"] == 10
    assert bw_commands() == ["unlock"]
    s.close()

    monkeypatch.setenv("FAKE_BW_LOGGED_OUT", "1")
    log.write_text("")
    s = serve()
    assert s.call("vault.unlock", {"password": "hunter2"})["error"] == {
        "code": 11, "message": "Bitwarden CLI isn't logged in on this box - run `bw login` once"}
    assert bw_commands() == ["unlock"]
    s.close()


def test_vault_unlock_of_a_provider_without_master_password(serve, write_config, fakes):
    write_config(INVENTORY)
    s = serve()
    err = s.call("vault.unlock", {"password": "x", "provider": "env"})["error"]
    assert err == {"code": 13, "message": "provider 'env' can't be unlocked with a master password"}
    assert s.call("vault.unlock", {"password": "x", "provider": "keeper"})["error"]["code"] == -32602
    write_config("groups:\n  lab:\n    user: ops\n    auth: env:PW\n    hosts:\n      box: {ip: 10.0.0.5}\n")
    s = serve()
    assert s.call("vault.status")["result"] == {"provider": None, "status": "unsupported", "can_write": False,
                                                "can_sign_out": False,
                                                "providers": [{"provider": "env", "status": "unsupported",
                                                               "can_write": False, "can_sign_out": False}]}
    assert s.call("vault.unlock", {"password": "x"})["error"]["code"] == 13


def bw_session_file(isolated, key="fake-session-key"):
    f = isolated["home"] / ".config" / "roster" / "bw-session"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(key + "\n")
    f.chmod(0o600)


def test_only_vault_unlock_unlocks_and_vault_lock_locks(serve, write_config, fakes, isolated, monkeypatch, tmp_path):
    """BW_PASSWORD and a valid bw-session file would unlock the CLI by themselves; serve ignores both."""
    write_config(INVENTORY)
    bw_session_file(isolated)
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    log = tmp_path / "calls.log"
    monkeypatch.setenv("FAKE_LOG", str(log))
    s = serve()
    assert s.call("vault.status")["result"]["status"] == "locked"
    assert s.call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
    assert s.call("vault.lock")["result"] == {"locked": ["bw"]}
    assert "bw lock" in log.read_text().splitlines()
    assert s.call("vault.status")["result"]["status"] == "locked"
    code, out, err = s.close()
    assert code == 0 and out == "" and err == ""
    for secret in ("hunter2", "fake-session-key"):
        assert secret not in "".join(s.responses)


def test_a_lookup_after_vault_lock_reports_locked(write_config, fakes, isolated, monkeypatch):
    """In-process, so a secret lookup (what session.prepare and askpass do) can follow the calls."""
    from roster import providers, serve
    write_config(INVENTORY)
    bw_session_file(isolated)
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    state = serve.State(None)

    def call(method, params=None):
        return serve.handle(state, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}))

    with pytest.raises(providers.VaultLocked, match="locked"):
        providers.get_secret("bw:Network gear", "lab")              # neither BW_PASSWORD nor the file unlocked it
    assert call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
    assert providers.get_secret("bw:Network gear", "lab") == "pw-netops"
    assert call("vault.lock")["result"] == {"locked": ["bw"]}
    with pytest.raises(providers.VaultLocked, match="locked"):
        providers.get_secret("bw:Network gear", "lab")              # the cached value went too


# ---------------------------------------------------------------- session.prepare (ticket 05)

def synced(write_config, capsys, text=INVENTORY):
    """roster.yml written and `roster sync` run, so this box's ssh config has every Host's alias, and a host key
    recorded for each Host, as `roster setup` would (without one, session.prepare asks first: ticket 36)."""
    path = write_config(text)
    assert main(["sync"]) == 0
    capsys.readouterr()
    record_keys(path)


HOST_KEY = paramiko.ECDSAKey.generate()


def record_keys(path):
    """A host key in roster's known hosts for every Host in the roster.yml at PATH (none of them is ever reached)."""
    from roster.config import load_config
    lines = {f"{hk_name(h)} {HOST_KEY.get_name()} {HOST_KEY.get_base64()}\n" for h in load_config(path)["hosts"].values()}
    known_hosts_file().parent.mkdir(mode=0o700, exist_ok=True)
    known_hosts_file().write_text("".join(sorted(lines)))


def test_session_prepare_for_an_enrolled_host(serve, write_config, capsys, fakes):
    """The ssh command the app starts in a PTY: the ssh-config alias `roster setup`/`sync` writes, no secret."""
    synced(write_config, capsys)
    spec = serve().call("session.prepare", {"host": "box"})["result"]
    assert spec == {"argv": [shutil.which("ssh"), "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "box"],
                    "env": {},
                    "host": "box", "auth": "key",
                    "login": {"address": "10.0.0.5", "port": 22, "user": "ops"}}
    assert os.path.isabs(spec["argv"][0])


def test_session_prepare_refuses_an_unreviewed_host_as_roster_run_does(serve, write_config, capsys, fakes):
    synced(write_config, capsys)
    with pytest.raises(SystemExit) as run:
        main(["run", "server-10-0-0-9", "--", "uptime"])
    err = serve().call("session.prepare", {"host": "server-10-0-0-9"})["error"]
    assert err == {"code": 20, "message": "server-10-0-0-9 is not reviewed yet (reviewed: false in roster.yml) "
                                          "- not logging in"}
    assert run.value.code == f"error: {err['message']}"


# ---------------------------------------------------------------- password Sessions: the askpass channel (ticket 06)

PW_INVENTORY = INVENTORY.replace("        enroll: false\n", "        enroll: false\n        auth: bw:Network gear\n")
PASSWORD = "pw-netops"                  # what the fake bw holds for "Network gear"


def unlocked_serve(serve, write_config, capsys, *args):
    synced(write_config, capsys, PW_INVENTORY)
    s = serve(*args)
    assert s.call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
    return s


def test_session_prepare_for_a_password_host_hands_out_a_token_not_a_password(serve, write_config, capsys, fakes):
    s = unlocked_serve(serve, write_config, capsys)
    spec = s.call("session.prepare", {"host": "esx"})["result"]
    env = spec["env"]
    assert spec["argv"] == [shutil.which("ssh"), "-o", "StrictHostKeyChecking=yes", "-o", "NumberOfPasswordPrompts=1",
                            "-o", "PreferredAuthentications=password,keyboard-interactive", "esx"]
    assert (spec["host"], spec["auth"]) == ("esx", "password")
    assert set(env) == {"SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "ROSTER_ASKPASS_SOCKET", "ROSTER_ASKPASS_TOKEN"}
    assert env["SSH_ASKPASS_REQUIRE"] == "force"
    assert os.path.isabs(env["SSH_ASKPASS"]) and os.access(env["SSH_ASKPASS"], os.X_OK)
    assert os.path.isabs(env["ROSTER_ASKPASS_SOCKET"]) and len(env["ROSTER_ASKPASS_TOKEN"]) >= 32
    assert PASSWORD not in json.dumps(spec)
    other = s.call("session.prepare", {"host": "esx"})["result"]["env"]["ROSTER_ASKPASS_TOKEN"]
    assert other != env["ROSTER_ASKPASS_TOKEN"]                     # one token per Session


def test_session_prepare_for_a_password_host_while_locked(serve, write_config, capsys, fakes):
    """A token minted now could only fail at ssh's prompt; say "unlock first" instead, as vault.* does."""
    synced(write_config, capsys, PW_INVENTORY)
    s = serve()
    err = s.call("session.prepare", {"host": "esx"})["error"]
    assert (err["code"], err["message"]) == (14, "bw vault is locked - unlock it first")
    assert s.call("session.prepare", {"host": "nope"})["error"] == {"code": 2, "message": "unknown host 'nope'"}
    assert s.call("session.prepare", {})["error"]["code"] == -32602
    assert s.close()[0] == 0


def test_session_prepare_needs_this_boxs_ssh_config(serve, write_config, capsys, isolated, fakes):
    """No falling back to user@ip: without roster's ssh config there's no key, known_hosts or port for ssh."""
    write_config(INVENTORY)                                     # `roster setup` / `sync` never ran here
    err = serve().call("session.prepare", {"host": "box"})["error"]
    assert err["code"] == 21 and "roster sync" in err["message"] and "roster setup" in err["message"]

    synced(write_config, capsys)
    write_config(INVENTORY.replace("      esx:", "      box2: {ip: 10.0.0.7}\n      esx:"))   # added since sync
    s = serve()
    assert s.call("session.prepare", {"host": "box2"})["error"]["code"] == 21
    assert s.call("session.prepare", {"host": "box"})["result"]["argv"][-1] == "box"

    (isolated["home"] / ".ssh" / "config").write_text("Host *\n    ServerAliveInterval 5\n")  # Include removed
    assert serve().call("session.prepare", {"host": "box"})["error"]["code"] == 21


def test_session_prepare_without_an_ssh_client(serve, write_config, capsys, isolated, monkeypatch):
    synced(write_config, capsys)
    monkeypatch.setenv("PATH", str(isolated["work"]))           # serve itself starts from sys.executable
    err = serve().call("session.prepare", {"host": "box"})["error"]
    assert err == {"code": 21, "message": "no ssh client on this box's PATH - install OpenSSH (openssh-client)"}


# ---- the askpass helper, run as ssh runs it

def run_askpass(spec, prompt="root@10.0.0.6's password: ", **extra_env):
    """Run SSH_ASKPASS exactly as ssh does: the absolute path, the prompt as argv[1], the Session's env."""
    env = {**os.environ, **spec["env"], **extra_env}
    return subprocess.run([spec["env"]["SSH_ASKPASS"], prompt], env=env, capture_output=True, text=True,
                          timeout=30, cwd="/")


def test_the_askpass_helper_gets_the_password_once(serve, write_config, capsys, fakes):
    s = unlocked_serve(serve, write_config, capsys)
    spec = s.call("session.prepare", {"host": "esx"})["result"]
    first = run_askpass(spec)
    assert (first.returncode, first.stdout) == (0, PASSWORD + "\n")
    again = run_askpass(spec)
    assert (again.returncode, again.stdout) == (1, "")
    assert "used up, expired or cleared" in again.stderr        # what ssh's terminal shows, no secret


def test_the_helper_answers_the_password_prompts_ssh_and_pam_show(serve, write_config, capsys, fakes):
    s = unlocked_serve(serve, write_config, capsys)
    for prompt in ("root@10.0.0.6's password: ", "Password: ", "(root@10.0.0.6) Password:",
                   "Password for root@esx: ", "PASSWORD:"):
        spec = s.call("session.prepare", {"host": "esx"})["result"]
        assert run_askpass(spec, prompt).stdout == PASSWORD + "\n", prompt


REFUSED_PROMPTS = (
    "The authenticity of host '10.0.0.6 (10.0.0.6)' can't be established.\n"
    "ED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
    "Please type 'yes', 'no' or the fingerprint: ",
    "Enter passphrase for key '/home/u/.ssh/id_ed25519': ",
    "Verification code: ",
    "(current) UNIX password: ",
    "(current) Password: ",
    "Bad passphrase, try again for x's password: ",
    "New password: ",
    "Retype new password: ",
    "Warning: password expires soon. Password:",
    "",
)


def test_the_helper_refuses_every_other_prompt_and_reports_it(serve, write_config, capsys, fakes):
    """A refused prompt gets no password and doesn't spend the token. The helper reports the prompt (never an
    answer) so serve can log it, and prints the one line the app shows: code 36, the Host, the prompt."""
    s = unlocked_serve(serve, write_config, capsys)
    spec = s.call("session.prepare", {"host": "esx"})["result"]
    for prompt in REFUSED_PROMPTS:
        r = run_askpass(spec, prompt)
        assert (r.returncode, r.stdout) == (1, ""), prompt
        assert r.stderr.startswith("roster askpass: [36] esx asked something roster won't answer: '"), prompt
        assert r.stderr.count("\n") == 1
    assert run_askpass(spec).stdout == PASSWORD + "\n"                 # the token is still good
    r = run_askpass(spec, "New password: ")                            # e.g. an expired password, right after
    assert "[36] esx asked something roster won't answer: 'New password:'" in r.stderr
    _, _, err = s.close()
    assert "askpass: esx: refused an unexpected prompt: 'Verification code:'" in err
    assert PASSWORD not in err


def test_the_cli_has_roster_askpass(capsys):
    """`roster askpass PROMPT` is the same helper (the generated SSH_ASKPASS script skips the CLI's imports)."""
    assert main(["askpass", "Are you sure you want to continue connecting (yes/no/[fingerprint])? "]) == 1
    assert capsys.readouterr().out == ""


def test_a_token_expires(serve, write_config, capsys, fakes, monkeypatch):
    monkeypatch.setenv("ROSTER_ASKPASS_TTL", "0.2")              # shortens the 60 s; it can't lengthen it
    s = unlocked_serve(serve, write_config, capsys)
    spec = s.call("session.prepare", {"host": "esx"})["result"]
    time.sleep(0.5)
    r = run_askpass(spec)
    assert (r.returncode, r.stdout) == (1, "")


def test_an_unused_typed_password_leaves_memory_when_its_token_expires(monkeypatch):
    """Nothing connects, yet the password goes at its expiry (the channel sleeps until then, not in 0.2 s steps)."""
    from roster.askpass import Channel, Typed
    monkeypatch.setenv("ROSTER_ASKPASS_TTL", "0.3")
    with Channel(lambda login: "unused") as ch:
        time.sleep(0.5)                                          # the channel idles first: no token, nothing to wake for
        ch.mint(Typed("typed secret"), "quick")
        time.sleep(0.2)
        assert len(ch.tokens) == 1
        time.sleep(0.4)
        assert ch.tokens == {}
        start = time.monotonic()
    assert time.monotonic() - start < 0.5                        # closing doesn't wait for a timeout either


def test_vault_lock_clears_tokens(serve, write_config, capsys, fakes):
    s = unlocked_serve(serve, write_config, capsys)
    spec = s.call("session.prepare", {"host": "esx"})["result"]
    assert s.call("vault.lock")["result"] == {"locked": ["bw"]}
    r = run_askpass(spec)
    assert (r.returncode, r.stdout) == (1, "")
    assert s.call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
    r = run_askpass(spec)                                        # unlocking again doesn't bring it back
    assert (r.returncode, r.stdout) == (1, "")


def test_a_wrong_token_gets_nothing(serve, write_config, capsys, fakes):
    s = unlocked_serve(serve, write_config, capsys)
    spec = s.call("session.prepare", {"host": "esx"})["result"]
    token = spec["env"]["ROSTER_ASKPASS_TOKEN"]
    wrong = ("y" if token[0] == "x" else "x") + token[1:]          # always differs (1 in 64 tokens starts with x)
    r = run_askpass(spec, ROSTER_ASKPASS_TOKEN=wrong)
    assert (r.returncode, r.stdout) == (1, "")
    assert run_askpass(spec).stdout == PASSWORD + "\n"           # a guess doesn't spend the real one


@pytest.mark.skipif(os.name == "nt", reason="a named pipe on Windows: test_windows.py")
def test_the_askpass_socket_is_the_users_alone_and_goes_away(serve, write_config, capsys, fakes, runtime_dir):
    run = runtime_dir                                            # short: pytest's tmp_path under a long $TMPDIR
    s = unlocked_serve(serve, write_config, capsys)
    env = s.call("session.prepare", {"host": "esx"})["result"]["env"]
    sock, helper = env["ROSTER_ASKPASS_SOCKET"], env["SSH_ASKPASS"]
    folder = os.path.dirname(sock)
    assert os.path.dirname(folder) == str(run) and os.path.dirname(helper) == folder
    modes = [os.stat(p).st_mode & 0o777 for p in (folder, sock, helper)]
    assert modes == [0o700, 0o600, 0o700]
    assert stat.S_ISSOCK(os.stat(sock).st_mode)
    assert s.close()[0] == 0
    assert not os.path.exists(folder)


def test_the_password_never_reaches_serves_output(serve, write_config, capsys, fakes):
    s = unlocked_serve(serve, write_config, capsys)
    spec = s.call("session.prepare", {"host": "esx"})["result"]
    assert run_askpass(spec).returncode == 0
    run_askpass(spec)
    s.call("vault.lock")
    code, out, err = s.close()
    assert code == 0 and out == ""
    assert "esx: password handed to ssh" in err                  # it does log that it happened
    assert PASSWORD not in "".join(s.responses) + out + err


# ---- vault.create_item / vault.undo_create: "Save to vault" (ticket 13; Q43's verified adds)

NEW_PW = "n3w-s3cret-pw"


def test_vault_status_says_which_providers_can_write(serve, write_config, fakes):
    write_config(INVENTORY)
    status = serve().call("vault.status")["result"]
    assert status["can_write"] is True
    assert {p["provider"]: p["can_write"] for p in status["providers"]} == {"bw": True, "env": False, "prompt": False}


def test_create_item_then_undo_it(serve, write_config, vault, tmp_path, monkeypatch):
    write_config(INVENTORY)
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    s = serve()
    params = {"name": "box ssh", "username": "ops", "password": NEW_PW, "uri": "ssh://10.0.0.5"}
    assert s.call("vault.create_item", params)["error"]["code"] == 14          # locked: unlock first
    s.call("vault.unlock", {"password": "hunter2"})
    made = s.call("vault.create_item", params)["result"]
    assert made["provider"] == "bw" and made["name"] == "box ssh" and made["id"]
    item = next(i for i in json.loads(vault.read_text()) if i["name"] == "box ssh")
    assert (item["id"], item["login"]["username"], item["login"]["password"]) == (made["id"], "ops", NEW_PW)
    assert item["login"]["uris"] == [{"uri": "ssh://10.0.0.5", "match": None}]

    assert s.call("vault.undo_create", {"id": made["id"]})["result"] == {"provider": "bw", "id": made["id"]}
    assert "box ssh" not in [i["name"] for i in json.loads(vault.read_text())]
    again = s.call("vault.undo_create", {"id": made["id"]})["error"]
    assert again["code"] == 63
    code, out, err = s.close()
    assert code == 0 and out == "" and err == ""
    for where in (json.dumps(s.responses), (tmp_path / "argv.log").read_text()):
        assert NEW_PW not in where


def test_create_item_refuses_an_existing_name(serve, write_config, vault):
    write_config(INVENTORY)
    s = serve()
    s.call("vault.unlock", {"password": "hunter2"})
    before = vault.read_text()
    err = s.call("vault.create_item", {"name": "esx ssh", "password": NEW_PW})["error"]
    assert err["code"] == 60 and "'esx ssh' already exists" in err["message"]
    assert err["data"]["matches"] == [{"name": "esx ssh", "revised": "2026-10-01", "uris": ["ssh://10.0.0.6"]}]
    assert err["data"]["fix"]
    assert vault.read_text() == before
    assert NEW_PW not in json.dumps(s.responses)


def test_undo_only_touches_items_this_serve_created(serve, write_config, vault):
    write_config(INVENTORY)
    s = serve()
    s.call("vault.unlock", {"password": "hunter2"})
    before = vault.read_text()
    err = s.call("vault.undo_create", {"id": "aaaa-1111"})["error"]           # a real item, made elsewhere
    assert err["code"] == 63 and "aaaa-1111" in err["message"]
    assert vault.read_text() == before
    assert s.call("vault.undo_create", {})["error"]["code"] == -32602


def test_create_item_in_a_provider_that_cant_write(serve, write_config, vault, monkeypatch):
    write_config(INVENTORY)
    s = serve()
    err = s.call("vault.create_item", {"name": "box ssh", "password": NEW_PW, "provider": "env"})["error"]
    assert err["code"] == 61 and "provider 'env' can't save to the vault" in err["message"]
    for missing in ({"name": "box ssh"}, {"password": NEW_PW}, {"name": "x", "password": NEW_PW, "uri": 5}):
        bad = s.call("vault.create_item", missing)["error"]
        assert bad["code"] == -32602 and NEW_PW not in json.dumps(bad)


def test_a_refused_create_is_a_clean_error_without_the_password(serve, write_config, vault, monkeypatch):
    write_config(INVENTORY)
    monkeypatch.setenv("FAKE_BW_WRITE_FAIL", f"You do not have permission. {NEW_PW}")
    s = serve()
    s.call("vault.unlock", {"password": "hunter2"})
    err = s.call("vault.create_item", {"name": "box ssh", "password": NEW_PW})["error"]
    assert err["code"] == 62 and "You do not have permission" in err["message"]
    code, out, stderr = s.close()
    assert NEW_PW not in json.dumps(s.responses) + out + stderr


def in_process(write_config, method, params, state=None):
    from roster import serve as rpc
    state = state or rpc.State(str(write_config(INVENTORY)))
    if method != "vault.unlock" and not state.created and not getattr(state, "_unlocked", False):
        rpc.handle(state, json.dumps({"jsonrpc": "2.0", "id": 0, "method": "vault.unlock",
                                      "params": {"password": "hunter2"}}))
        state._unlocked = True
    return state, rpc.handle(state, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))


def test_a_create_that_times_out_after_saving_counts_as_made_and_can_be_undone(write_config, vault, monkeypatch):
    from roster import serve as rpc
    monkeypatch.setitem(rpc.DEADLINES, "vault.create_item", 2)
    monkeypatch.setenv("FAKE_BW_CREATE_HANG", "30")
    state, r = in_process(write_config, "vault.create_item", {"name": "box ssh", "password": NEW_PW})
    made = r["result"]
    item = next(i for i in json.loads(vault.read_text()) if i["name"] == "box ssh")
    assert made == {"provider": "bw", "id": item["id"], "name": "box ssh", "target": {"id": "personal", "kind": "personal", "label": "Personal vault"}}
    monkeypatch.delenv("FAKE_BW_CREATE_HANG")
    _, r = in_process(write_config, "vault.undo_create", {"id": made["id"]}, state)
    assert r["result"]["id"] == made["id"] and "box ssh" not in vault.read_text()


def test_a_create_that_times_out_before_saving_says_nothing_was_saved(write_config, vault, monkeypatch):
    from roster import serve as rpc
    monkeypatch.setitem(rpc.DEADLINES, "vault.create_item", 2)
    monkeypatch.setenv("FAKE_BW_SLOW", json.dumps({"create": 30}))
    _, r = in_process(write_config, "vault.create_item", {"name": "box ssh", "password": NEW_PW})
    err = r["error"]
    assert err["code"] == 62 and "nothing was saved" in err["message"] and "box ssh" not in vault.read_text()
    assert NEW_PW not in json.dumps(r)


def test_a_create_that_times_out_and_cant_be_checked_says_so(write_config, vault, monkeypatch):
    from roster import serve as rpc
    monkeypatch.setitem(rpc.DEADLINES, "vault.create_item", 2)
    monkeypatch.setenv("FAKE_BW_CREATE_HANG", "30")
    from roster.providers import bitwarden

    def list_breaks(ctx, *search):
        raise rpc.providers.SecretError("`bw` timed out")
    monkeypatch.setattr(bitwarden, "_bw_lookup", list_breaks)
    _, r = in_process(write_config, "vault.create_item", {"name": "box ssh", "password": NEW_PW})
    err = r["error"]
    assert err["code"] == 62 and "couldn't check" in err["message"] and "'box ssh'" in err["message"], err
