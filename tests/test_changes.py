"""Ticket 10 through `roster serve`, as the app drives it: inventory.pull, host.verify_login, host.update,
changes.diff and changes.discard, against a scratch infra repo (a clone of a bare repo in the test's temp dir).
The Host for test logins is a local paramiko server; the vault is the stand-in bw. No network."""

import logging
import socket
import subprocess
import threading
from pathlib import Path

import paramiko
import pytest
from conftest import ALL_SECRETS, SECRET

logging.getLogger("paramiko").setLevel(logging.CRITICAL)

INVENTORY = """\
# The lab. NO PASSWORDS IN THIS FILE.
groups:
  lab:
    user: root
    enroll: false
    hosts:
      esx:                  # the ESXi box
        ip: 127.0.0.1
        port: {port}
        auth: bw:esx ssh
        title: ESX
      keyed: {{ip: 127.0.0.1, port: {port}, enroll: true}}
      other: 10.0.0.9       # never touched
"""


# ---------------------------------------------------------------- a Host that takes one login

class Sshd:
    """An SSH server on 127.0.0.1 that takes root with SECRET (or the given public key) and counts connections
    and login attempts."""

    def __init__(self, pubkey=None):
        self.key = paramiko.ECDSAKey.generate()
        self.pubkey = pubkey
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.accepts, self.attempts = 0, []
        self.listener.settimeout(0.2)
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        while self.running:
            try:
                conn, _ = self.listener.accept()
            except (TimeoutError, OSError):
                continue
            self.accepts += 1
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        sshd = self

        class Iface(paramiko.ServerInterface):
            def get_allowed_auths(self, username):
                return "password,publickey"

            def check_auth_password(self, username, password):
                sshd.attempts.append(("password", username))
                ok = username == "root" and password == SECRET
                return paramiko.AUTH_SUCCESSFUL if ok else paramiko.AUTH_FAILED

            def check_auth_publickey(self, username, key):
                sshd.attempts.append(("publickey", username))
                ok = sshd.pubkey is not None and key.asbytes() == sshd.pubkey.asbytes() and username == "root"
                return paramiko.AUTH_SUCCESSFUL if ok else paramiko.AUTH_FAILED

        t = paramiko.Transport(conn)
        t.add_server_key(self.key)
        try:
            t.start_server(server=Iface())
            t.join(5)
        except Exception:
            pass
        finally:
            t.close()

    def known_hosts_line(self, port=None):
        return f"[127.0.0.1]:{port or self.port} {self.key.get_name()} {self.key.get_base64()}\n"

    def close(self):
        self.running = False
        self.thread.join()          # an accept() still waiting would take one more connection after close()
        self.listener.close()


# ---------------------------------------------------------------- a scratch infra repo

class Infra(type(Path())):
    """The infra repo's path, with .yml (its roster.yml), .other (a second clone) and .commit(text)."""


def git(cwd, *args):
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@pytest.fixture
def infra(tmp_path, monkeypatch):
    """A bare 'origin' and this box's clone with roster.yml committed and pushed. .other is a second clone,
    where 'someone else' publishes."""
    for k, v in {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
                 "GIT_COMMITTER_EMAIL": "t@x", "GIT_CONFIG_NOSYSTEM": "1"}.items():
        monkeypatch.setenv(k, v)
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    repo = Infra(tmp_path / "infra")
    subprocess.run(["git", "clone", "-q", str(origin), str(repo)], check=True, capture_output=True)
    git(repo, "checkout", "-q", "-b", "main")
    (repo / "README.md").write_text("infra\n")
    repo.other = tmp_path / "other"

    def commit(text, where=repo, msg="inventory"):
        (where / "roster.yml").write_text(text)
        git(where, "add", "-A")
        git(where, "commit", "-q", "-m", msg)
        git(where, "push", "-q", "-u", "origin", "main")

    repo.commit = commit
    repo.yml = repo / "roster.yml"
    return repo


@pytest.fixture
def sshd():
    s = Sshd()
    yield s
    s.close()


@pytest.fixture
def box(infra, sshd, vault, isolated):
    """The infra repo with INVENTORY for the local Host, and its host key recorded."""
    infra.commit(INVENTORY.format(port=sshd.port))
    ssh = isolated["home"] / ".ssh"
    ssh.mkdir(exist_ok=True)
    (ssh / "roster_known_hosts").write_text(sshd.known_hosts_line())
    return infra


@pytest.fixture
def app(serve, box):
    """`roster serve -c infra/roster.yml` with the vault unlocked; checks at the end that no secret leaked."""
    s = serve("-c", str(box.yml))
    assert s.call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
    yield s
    _, out, err = s.close()
    assert not [x for x in ALL_SECRETS if x in "".join(s.responses) + out + err]


def result(r):
    assert "error" not in r, r
    return r["result"]


# ---------------------------------------------------------------- host.update, changes.diff, changes.discard

def test_a_text_edit_needs_no_verify_and_keeps_every_other_byte(app, box):
    before = box.yml.read_text()
    r = result(app.call("host.update", {"host": "esx", "changes": {"title": "ESXi 8", "description": "rack 2"}}))
    assert r["changed"] and r["host"]["title"] == "ESXi 8" and r["host"]["description"] == "rack 2"
    after = box.yml.read_text()
    assert after == before.replace("        title: ESX\n", "        title: ESXi 8\n        description: rack 2\n")
    hosts = {h["name"]: h for h in result(app.call("hosts.list"))["hosts"]}      # serve reloaded it
    assert hosts["esx"]["title"] == "ESXi 8"
    assert (box / ".git" / "roster" / "roster.yml.bak").read_text() == before
    assert r["backup"] == str(box / ".git" / "roster" / "roster.yml.bak")
    assert git(box, "status", "--porcelain") == "M roster.yml"          # the backup isn't in the working tree


def test_the_diff_shows_exactly_the_change(app, box):
    d = result(app.call("changes.diff"))
    last = d.pop("last_commit")
    assert d == {"path": str(box.yml), "repo": str(box), "diff": "", "hosts": [], "groups": [], "count": 0,
                 "message": ""}
    assert last == {"commit": git(box, "rev-parse", "HEAD"), "subject": "inventory", "upstream": "origin/main",
                    "pushed": True}
    result(app.call("host.update", {"host": "esx", "changes": {"title": "ESXi 8"}}))
    d = result(app.call("changes.diff"))
    body = [ln for ln in d["diff"].splitlines() if ln[:1] in "+-" and not ln.startswith(("+++", "---"))]
    assert body == ["-        title: ESX", "+        title: ESXi 8"]
    assert d["hosts"] == [{"host": "esx", "change": "changed", "fields": ["title"]}] and d["count"] == 1
    assert d["message"] == "roster: change esx (title)" and d["groups"] == []


def test_discard_puts_the_file_back_as_it_was(app, box):
    before = box.yml.read_bytes()
    result(app.call("host.update", {"host": "other", "changes": {"type": "switch"}}))
    edited = box.yml.read_text()
    r = result(app.call("changes.discard"))
    assert r["discarded"] and box.yml.read_bytes() == before
    assert (box / ".git" / "roster" / "roster.yml.bak").read_text() == edited       # what was discarded
    assert git(box, "status", "--porcelain") == ""
    assert {h["name"]: h for h in result(app.call("hosts.list"))["hosts"]}["other"]["type"] == ""
    assert result(app.call("changes.discard")) == {"discarded": False, "backup": None}


def test_nothing_to_change_writes_nothing(app, box):
    r = result(app.call("host.update", {"host": "esx", "changes": {"title": "ESX", "user": "root"}}))
    assert r["changed"] is False and git(box, "status", "--porcelain") == ""


def test_an_invalid_result_is_refused_and_nothing_is_written(app, box):
    box.commit(box.yml.read_text().replace("      other: 10.0.0.9", "      other: 10.0.0.9\n      dup: &d {ip: 10.0.0.8}"
                                           "\n      dup2: *d"))
    before = box.yml.read_text()
    err = app.call("host.update", {"host": "dup", "changes": {"title": "x"}})["error"]
    assert err["code"] == 74 and "nothing was written" in err["message"] and err["data"]["fix"]
    assert box.yml.read_text() == before


@pytest.mark.parametrize("changes,why", [({"title": 3}, "string"), ({"name": "x"}, "can't be edited"), ({}, "object"),
                                         ({"port": 70000}, "65535")])
def test_bad_params(app, changes, why):
    err = app.call("host.update", {"host": "esx", "changes": changes})["error"]
    assert err["code"] == -32602 and why in err["message"]


def test_an_unknown_host(app):
    assert app.call("host.update", {"host": "nope", "changes": {"title": "x"}})["error"]["code"] == 2


def test_an_inventory_outside_git_has_no_pending_changes(serve, write_config):
    path = write_config(INVENTORY.format(port=22))
    s = serve("-c", str(path))
    for method, params in (("host.update", {"host": "esx", "changes": {"title": "x"}}), ("changes.diff", {}),
                           ("changes.discard", {}), ("inventory.pull", {})):
        err = s.call(method, params)["error"]
        assert err["code"] == 70 and "isn't in a git repo" in err["message"], method
    assert "title: ESX\n" in path.read_text()


# ---------------------------------------------------------------- verified changes (decision Q43)

def test_a_new_user_or_login_needs_a_test_login_first(app, box, sshd):
    err = app.call("host.update", {"host": "esx", "changes": {"auth": "bw:dup ssh"}})["error"]
    assert err["code"] == 75 and err["data"]["fix"]
    assert git(box, "status", "--porcelain") == ""


def test_a_verified_change_goes_through_once(app, box, sshd):
    # The vault item is renamed: the test login with the new reference succeeds, so the edit is allowed.
    changes = {"auth": "bw:esx ssh", "title": "x"}       # same Login: no verify needed
    assert result(app.call("host.update", {"host": "esx", "changes": changes}))["changed"]
    result(app.call("changes.discard"))

    changes = {"user": "root", "auth": "bw:aaaa-1111"}   # the same item by its id
    v = result(app.call("host.verify_login", {"host": "esx", "changes": changes}))
    assert v["ok"], v
    assert [s["step"] for s in v["steps"]] == ["user", "provider", "vault-item", "dns", "tcp", "host-key", "auth"]
    assert sshd.accepts == 1 and sshd.attempts == [("password", "root")]
    r = result(app.call("host.update", {"host": "esx", "changes": changes}))
    assert r["changed"] and r["host"]["ssh"]["auth"] == "bw:aaaa-1111"
    result(app.call("changes.discard"))
    assert app.call("host.update", {"host": "esx", "changes": changes})["error"]["code"] == 75   # used up


def test_a_refused_login_fails_the_auth_step_and_allows_nothing(app, box, sshd):
    changes = {"user": "admin"}
    v = result(app.call("host.verify_login", {"host": "esx", "changes": changes}))
    assert not v["ok"]
    auth = v["steps"][-1]
    assert auth["step"] == "auth" and auth["status"] == "fail" and auth["code"] == 45 and "admin" in auth["message"]
    assert sshd.accepts == 1 and sshd.attempts == [("password", "admin")]          # exactly one attempt
    assert app.call("host.update", {"host": "esx", "changes": changes})["error"]["code"] == 75


def test_a_host_that_moved_port_is_compared_with_the_key_recorded_for_it(app, box, sshd, isolated):
    # Recorded only for the old port: the Host moved, its key didn't.
    old = box.yml.read_text()
    box.commit(old.replace(f"port: {sshd.port}\n        auth", "port: 2222\n        auth"))
    (isolated["home"] / ".ssh" / "roster_known_hosts").write_text(sshd.known_hosts_line(port=2222))
    v = result(app.call("host.verify_login", {"host": "esx", "changes": {"port": sshd.port}}))
    assert v["ok"], v


def test_a_moved_hosts_verified_key_is_pinned_for_its_new_address_once_the_edit_is_written(app, box, sshd,
                                                                                           isolated):
    old = box.yml.read_text()
    box.commit(old.replace(f"port: {sshd.port}\n        auth", "port: 2222\n        auth"))
    known = isolated["home"] / ".ssh" / "roster_known_hosts"
    known.write_text(sshd.known_hosts_line(port=2222))
    v = result(app.call("host.verify_login", {"host": "esx", "changes": {"port": sshd.port}}))
    assert v["ok"], v
    assert known.read_text() == sshd.known_hosts_line(port=2222)            # a test login records nothing
    r = result(app.call("host.update", {"host": "esx", "changes": {"port": sshd.port}}))
    assert r["changed"] and r["warnings"] == []
    assert known.read_text() == sshd.known_hosts_line(port=2222) + sshd.known_hosts_line()


def test_a_moved_hosts_key_isnt_pinned_when_the_edit_isnt_written(app, box, sshd, isolated, monkeypatch):
    old = box.yml.read_text()
    box.commit(old.replace(f"port: {sshd.port}\n        auth", "port: 2222\n        auth"))
    known = isolated["home"] / ".ssh" / "roster_known_hosts"
    known.write_text(sshd.known_hosts_line(port=2222))
    result(app.call("host.verify_login", {"host": "esx", "changes": {"port": sshd.port}}))
    box.yml.write_text(box.yml.read_text() + "  : [\n")                      # roster.yml broken meanwhile
    assert "error" in app.call("host.update", {"host": "esx", "changes": {"port": sshd.port}})
    assert known.read_text() == sshd.known_hosts_line(port=2222)


def test_a_different_host_key_is_never_accepted(app, box, sshd, isolated):
    other = paramiko.ECDSAKey.generate()
    (isolated["home"] / ".ssh" / "roster_known_hosts").write_text(
        f"[127.0.0.1]:{sshd.port} {other.get_name()} {other.get_base64()}\n")
    v = result(app.call("host.verify_login", {"host": "esx", "changes": {"user": "root2"}}))
    key = next(s for s in v["steps"] if s["step"] == "host-key")
    assert key["status"] == "fail" and key["code"] == 43 and v["steps"][-1]["status"] == "skipped"
    assert sshd.attempts == []                                          # no login over an unknown key
    assert (isolated["home"] / ".ssh" / "roster_known_hosts").read_text().count("\n") == 1


def test_no_recorded_key_at_all(app, box, sshd, isolated):
    (isolated["home"] / ".ssh" / "roster_known_hosts").write_text("")
    v = result(app.call("host.verify_login", {"host": "esx", "changes": {"user": "x"}}))
    assert [s.get("code") for s in v["steps"] if s["status"] == "fail"] == [44] and sshd.accepts == 1


def test_a_missing_vault_item_fails_before_the_network(app, box, sshd):
    v = result(app.call("host.verify_login", {"host": "esx", "changes": {"auth": "bw:esx shh"}}))
    fail = next(s for s in v["steps"] if s["status"] == "fail")
    assert fail["step"] == "vault-item" and fail["code"] == 32 and sshd.accepts == 0


def test_an_unreachable_address(app, box, sshd):
    port = socket.create_server(("127.0.0.1", 0))
    closed = port.getsockname()[1]
    port.close()
    v = result(app.call("host.verify_login", {"host": "esx", "changes": {"port": closed}}))
    assert next(s for s in v["steps"] if s["status"] == "fail")["code"] == 41


def test_a_key_host_logs_in_with_this_boxs_key(serve, box, sshd, isolated, monkeypatch):
    key = paramiko.ECDSAKey.generate()
    path = isolated["home"] / "roster_key"
    key.write_private_key_file(str(path))
    sshd.pubkey = key
    box.commit(box.yml.read_text().replace("# The lab.", f"key_path: {path}\n# The lab."))
    s = serve("-c", str(box.yml))
    v = result(s.call("host.verify_login", {"host": "keyed", "changes": {"title": "x", "user": "root"}}))
    assert v["ok"] and sshd.attempts == [("publickey", "root")], v
    v = result(s.call("host.verify_login", {"host": "keyed", "changes": {"user": "nobody"}}))
    assert v["steps"][-1]["code"] == 46


@pytest.fixture
def keyed(serve, box, sshd, isolated):
    """serve (vault unlocked) where the enroll: true Host 'keyed' logs in with this box's key."""
    key = paramiko.ECDSAKey.generate()
    path = isolated["home"] / "roster_key"
    key.write_private_key_file(str(path))
    sshd.pubkey = key
    box.commit(box.yml.read_text().replace("# The lab.", f"key_path: {path}\n# The lab."))
    s = serve("-c", str(box.yml))
    assert s.call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
    return s


def test_a_new_login_on_a_key_host_is_tested_with_its_password_not_the_key(keyed, box, sshd):
    changes = {"auth": "bw:esx ssh"}
    v = result(keyed.call("host.verify_login", {"host": "keyed", "changes": changes}))
    assert v["ok"], v
    steps = {s["step"]: s for s in v["steps"]}
    assert steps["provider"]["status"] == "ok" and steps["vault-item"]["status"] == "ok"
    assert sshd.attempts == [("password", "root")]                       # the Login itself, not the key
    r = result(keyed.call("host.update", {"host": "keyed", "changes": changes}))
    assert r["host"]["ssh"]["auth"] == "bw:esx ssh" and r["host"]["enroll"] is True


@pytest.mark.parametrize("auth,code", [("bw:nopw ssh", 34), ("bw:dup ssh", 33), ("bw:esx shh", 32)])
def test_a_bad_new_login_on_a_key_host_fails_even_though_the_key_works(keyed, box, sshd, auth, code):
    v = result(keyed.call("host.verify_login", {"host": "keyed", "changes": {"auth": auth}}))
    fail = next(s for s in v["steps"] if s["status"] == "fail")
    assert not v["ok"] and fail["step"] == "vault-item" and fail["code"] == code, v
    assert sshd.accepts == 0
    assert keyed.call("host.update", {"host": "keyed", "changes": {"auth": auth}})["error"]["code"] == 75


def test_a_new_login_on_a_key_host_that_refuses_its_password_fails(keyed, box, sshd):
    v = result(keyed.call("host.verify_login", {"host": "keyed", "changes": {"auth": "bw:esx ssh", "user": "admin"}}))
    assert not v["ok"] and v["steps"][-1]["code"] == 45, v
    assert sshd.attempts == [("password", "admin")]


# ---------------------------------------------------------------- inventory.pull

def test_pull_fast_forwards_and_serve_reloads(app, box):
    subprocess.run(["git", "clone", "-q", str(box.parent / "origin.git"), str(box.other)], check=True)
    box.commit((box.other / "roster.yml").read_text().replace("title: ESX", "title: From elsewhere"), where=box.other)
    r = result(app.call("inventory.pull"))
    assert r["updated"] and r["commits"] == 1 and r["upstream"] == "origin/main" and r["ahead"] == 0
    assert {h["name"]: h for h in result(app.call("hosts.list"))["hosts"]}["esx"]["title"] == "From elsewhere"
    assert result(app.call("inventory.pull"))["updated"] is False


def test_pull_refuses_pending_changes(app, box):
    result(app.call("host.update", {"host": "esx", "changes": {"title": "mine"}}))
    err = app.call("inventory.pull")["error"]
    assert err["code"] == 71 and "Pending changes" in err["message"] and err["data"]["files"] == ["roster.yml"]


def test_pull_refuses_other_uncommitted_files(app, box):
    (box / "README.md").write_text("changed\n")
    err = app.call("inventory.pull")["error"]
    assert err["code"] == 71 and "README.md" in err["message"] and "git -C" in err["data"]["fix"]


def test_pull_refuses_a_diverged_branch(app, box):
    subprocess.run(["git", "clone", "-q", str(box.parent / "origin.git"), str(box.other)], check=True)
    box.commit((box.other / "roster.yml").read_text() + "# theirs\n", where=box.other)
    (box / "README.md").write_text("mine\n")
    git(box, "commit", "-qam", "local")
    err = app.call("inventory.pull")["error"]
    assert err["code"] == 72 and "diverged" in err["message"] and err["data"]["ahead"] == 1
    assert err["data"]["behind"] == 1 and "pull --rebase" in err["data"]["fix"]
    assert git(box, "log", "-1", "--format=%s") == "local"


def test_pull_without_an_upstream_has_nothing_to_do(app, box):
    git(box, "branch", "--unset-upstream")
    assert result(app.call("inventory.pull")) == {"updated": False, "upstream": None, "commits": 0, "ahead": 0,
                                                 "message": "this branch has no upstream, so there's nothing to pull"}


def test_pull_when_the_remote_is_gone(app, box):
    git(box, "remote", "set-url", "origin", str(box.parent / "missing.git"))
    err = app.call("inventory.pull")["error"]
    assert err["code"] == 73 and "couldn't fetch origin/main" in err["message"] and err["data"]["fix"]


# ---------------------------------------------------------------- changes.publish (ticket 12)

def origin_log(box, fmt="%s"):
    return git(box.parent / "origin.git", "log", "-1", f"--format={fmt}", "main")


@pytest.fixture
def owner(serve, box, monkeypatch):
    """serve, with the infra repo's own git identity as the only one (nothing in the environment)."""
    for k in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"):
        monkeypatch.delenv(k)
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(box.parent / "no-global-gitconfig"))
    git(box, "config", "user.name", "Infra Owner")
    git(box, "config", "user.email", "owner@infra")
    s = serve("-c", str(box.yml))
    assert s.call("vault.unlock", {"password": "hunter2"})["result"]["status"] == "unlocked"
    return s


def test_publish_commits_roster_yml_pushes_it_and_syncs(owner, box, isolated):
    app = owner
    result(app.call("host.update", {"host": "esx", "changes": {"title": "ESXi 8"}}))
    r = result(app.call("changes.publish"))
    head = git(box, "rev-parse", "HEAD")
    assert r["commit"] == head and git(box.parent / "origin.git", "rev-parse", "main") == head
    assert r["upstream"] == "origin/main" and r["hosts"] == [{"host": "esx", "change": "changed", "fields": ["title"]}]
    assert git(box, "status", "--porcelain", "--untracked-files=no") == ""      # sync's ROSTER.md is untracked here
    assert git(box, "show", "--name-only", "--format=", "HEAD") == "roster.yml"
    assert origin_log(box, "%an <%ae>") == "Infra Owner <owner@infra>"
    assert origin_log(box) == "roster: change esx (title)"
    assert r["sync"] == {"ok": True}
    assert "Host esx" in (isolated["home"] / ".ssh" / "config.d" / "roster").read_text()
    assert result(app.call("changes.diff"))["count"] == 0


def pending_as_before(box, title="mine"):
    return f"title: {title}" in box.yml.read_text() and git(box, "status", "--porcelain",
                                                             "--untracked-files=no") == "M roster.yml"


def test_publish_with_nothing_pending_is_refused(app, box):
    err = app.call("changes.publish")["error"]
    assert err["code"] == 90 and "nothing to publish" in err["message"]


def test_publish_takes_the_message_given(owner, box):
    result(owner.call("host.update", {"host": "esx", "changes": {"title": "mine"}}))
    r = result(owner.call("changes.publish", {"message": "  Rename the ESX box\n\nPer the rack audit.  "}))
    assert r["message"] == "Rename the ESX box\n\nPer the rack audit."
    assert origin_log(box, "%B").strip() == "Rename the ESX box\n\nPer the rack audit."


def test_publish_refuses_when_someone_else_published_roster_yml(app, box):
    subprocess.run(["git", "clone", "-q", str(box.parent / "origin.git"), str(box.other)], check=True)
    box.commit((box.other / "roster.yml").read_text() + "# theirs\n", where=box.other, msg="theirs")
    result(app.call("host.update", {"host": "esx", "changes": {"title": "mine"}}))
    err = app.call("changes.publish")["error"]
    assert err["code"] == 92 and "since this box pulled" in err["message"] and err["data"]["behind"] == 1
    assert "stash" in err["data"]["fix"]
    assert origin_log(box) == "theirs" and pending_as_before(box)


def test_publish_fast_forwards_over_commits_that_leave_roster_yml_alone(owner, box):
    subprocess.run(["git", "clone", "-q", str(box.parent / "origin.git"), str(box.other)], check=True)
    (box.other / "README.md").write_text("theirs\n")
    git(box.other, "-c", "user.name=them", "-c", "user.email=them@x", "commit", "-qam", "readme")
    git(box.other, "push", "-q", "origin", "main")
    result(owner.call("host.update", {"host": "esx", "changes": {"title": "mine"}}))
    r = result(owner.call("changes.publish"))
    assert r["pulled"] == 1 and git(box, "log", "--format=%s", "-2").splitlines() == ["roster: change esx (title)",
                                                                                      "readme"]
    assert origin_log(box, "%H") == r["commit"]


def test_publish_refuses_other_uncommitted_files(app, box):
    result(app.call("host.update", {"host": "esx", "changes": {"title": "mine"}}))
    (box / "README.md").write_text("half done\n")
    err = app.call("changes.publish")["error"]
    assert err["code"] == 91 and err["data"]["files"] == ["README.md"] and "git -C" in err["data"]["fix"]
    assert origin_log(box) == "inventory"


def test_publish_refuses_local_commits_it_didnt_make(app, box):
    (box / "README.md").write_text("mine\n")
    git(box, "commit", "-qam", "local")
    result(app.call("host.update", {"host": "esx", "changes": {"title": "mine"}}))
    err = app.call("changes.publish")["error"]
    assert err["code"] == 93 and err["data"]["ahead"] == 1 and origin_log(box) == "inventory"


def test_a_rejected_push_undoes_the_commit_and_keeps_the_pending_changes(app, box):
    hook = box.parent / "origin.git" / "hooks" / "pre-receive"
    hook.write_text("#!/bin/sh\necho 'protected branch' >&2\nexit 1\n")
    hook.chmod(0o755)
    before = git(box, "rev-parse", "HEAD")
    result(app.call("host.update", {"host": "esx", "changes": {"title": "mine"}}))
    err = app.call("changes.publish")["error"]
    assert err["code"] == 96 and "nothing was published" in err["message"] and "protected branch" in err["data"]["details"]
    assert git(box, "rev-parse", "HEAD") == before and pending_as_before(box)
    assert result(app.call("changes.diff"))["count"] == 1


def hanging_hook(box, name, accept):
    """A hook on origin that hangs past the push timeout: pre-receive before the ref moves (then refuses),
    post-receive after it moved."""
    hook = box.parent / "origin.git" / "hooks" / name
    hook.write_text(f"#!/bin/sh\nsleep 30\nexit {0 if accept else 1}\n")
    hook.chmod(0o755)


@pytest.fixture
def quick_push(monkeypatch):
    from roster import changes
    monkeypatch.setattr(changes, "PUSH_TIMEOUT", 1)
    return changes


def test_a_push_that_times_out_before_reaching_the_remote_undoes_the_commit(box, quick_push):
    import time
    hanging_hook(box, "pre-receive", accept=False)
    before = git(box, "rev-parse", "HEAD")
    box.yml.write_text(box.yml.read_text().replace("title: ESX", "title: mine"))
    start = time.monotonic()
    with pytest.raises(quick_push.Problem) as e:
        quick_push.publish(box.yml)
    assert time.monotonic() - start < 15                    # the hook's sleep doesn't hold it up
    assert e.value.code == 96 and e.value.data["timed_out"] and e.value.data["landed"] is False
    assert "didn't finish in time" in e.value.message and "nothing was published" in e.value.message
    assert git(box, "rev-parse", "HEAD") == before and pending_as_before(box)
    assert origin_log(box) == "inventory"


def test_a_push_that_times_out_after_reaching_the_remote_is_a_publish(box, quick_push):
    hanging_hook(box, "post-receive", accept=True)
    box.yml.write_text(box.yml.read_text().replace("title: ESX", "title: mine"))
    r = quick_push.publish(box.yml)
    head = git(box, "rev-parse", "HEAD")
    assert r["commit"] == head and git(box.parent / "origin.git", "rev-parse", "main") == head
    assert git(box, "status", "--porcelain", "--untracked-files=no") == ""
    assert git(box, "rev-parse", "@{u}") == head                         # this box knows it's published


def test_a_push_whose_outcome_cant_be_checked_undoes_the_commit_and_says_so(box, quick_push, monkeypatch):
    hanging_hook(box, "pre-receive", accept=False)
    real = quick_push.git

    def offline_after_push(repo, *args, **kw):
        if args[0] == "fetch" and offline_after_push.pushed:
            return subprocess.CompletedProcess(args, 128, "", "fatal: unable to access")
        offline_after_push.pushed |= args[0] == "push"
        return real(repo, *args, **kw)
    offline_after_push.pushed = False
    monkeypatch.setattr(quick_push, "git", offline_after_push)
    before = git(box, "rev-parse", "HEAD")
    box.yml.write_text(box.yml.read_text().replace("title: ESX", "title: mine"))
    with pytest.raises(quick_push.Problem) as e:
        quick_push.publish(box.yml)
    assert e.value.code == 96 and e.value.data["timed_out"] and e.value.data["landed"] is None
    assert "couldn't check" in e.value.message
    assert git(box, "rev-parse", "HEAD") == before and pending_as_before(box)


def test_publish_stays_within_its_deadline(box, monkeypatch):
    import json
    import time

    from roster import serve as rpc
    hanging_hook(box, "pre-receive", accept=False)
    monkeypatch.setitem(rpc.DEADLINES, "changes.publish", 2)
    box.yml.write_text(box.yml.read_text().replace("title: ESX", "title: mine"))
    state = rpc.State(str(box.yml))
    start = time.monotonic()
    r = rpc.handle(state, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "changes.publish", "params": {}}))
    assert time.monotonic() - start < 2 + rpc.AFTER_DEADLINE
    assert r["error"]["code"] == 96 and r["error"]["data"]["timed_out"] and pending_as_before(box)


def test_the_diff_says_whether_the_last_commit_is_published(owner, box):
    result(owner.call("host.update", {"host": "esx", "changes": {"title": "mine"}}))
    r = result(owner.call("changes.publish"))
    last = result(owner.call("changes.diff"))["last_commit"]
    assert last == {"commit": r["commit"], "subject": "roster: change esx (title)", "upstream": "origin/main",
                    "pushed": True}
    (box / "README.md").write_text("local\n")
    git(box, "commit", "-qam", "local only")
    last = result(owner.call("changes.diff"))["last_commit"]
    assert last["subject"] == "local only" and last["pushed"] is False


def test_a_refused_commit_publishes_nothing(owner, box):
    git(box, "config", "--unset", "user.name")
    git(box, "config", "user.useConfigOnly", "true")
    result(owner.call("host.update", {"host": "esx", "changes": {"title": "mine"}}))
    err = owner.call("changes.publish")["error"]
    assert err["code"] == 95 and "user.name" in err["data"]["fix"] and pending_as_before(box)
    assert origin_log(box) == "inventory"


def test_publish_without_an_upstream(app, box):
    git(box, "branch", "--unset-upstream")
    result(app.call("host.update", {"host": "esx", "changes": {"title": "mine"}}))
    err = app.call("changes.publish")["error"]
    assert err["code"] == 94 and "push -u origin main" in err["data"]["fix"]


def test_a_roster_yml_that_doesnt_load_isnt_published(app, box):
    result(app.call("host.update", {"host": "esx", "changes": {"title": "mine"}}))
    box.yml.write_text(box.yml.read_text() + "  : [\n")
    err = app.call("changes.publish")["error"]
    assert err["code"] == 1 and "won't publish" in err["message"] and origin_log(box) == "inventory"


def test_the_message_names_every_host_and_group_that_changed(owner, box):
    text = box.yml.read_text()
    text = text.replace("      other: 10.0.0.9       # never touched\n", "")
    text += "  rack-b:\n    title: Rack B\n    user: admin\n    hosts:\n      sw-core-01: 10.0.1.2\n      sw-core-02: 10.0.1.3\n"
    text = text.replace("        title: ESX\n", "        title: ESXi\n        description: the big one\n")
    box.yml.write_text(text)
    r = result(owner.call("changes.publish"))
    assert r["groups"] == [{"group": "rack-b", "change": "added"}]
    assert r["message"].split("\n") == [
        "roster: change 4 Hosts and 1 group", "", "- add group rack-b", "- change esx (title, description)",
        "- add sw-core-01", "- add sw-core-02", "- remove other"]


def test_a_mesh_change_names_its_host_in_the_diff_and_the_message(write_config):
    """mesh.cut writes `mesh: false` for the Host as a Pending change: Publish's list and message name it."""
    from roster import changes
    old = "groups:\n  lab:\n    user: u\n    mesh: true\n    hosts:\n      h1: 10.0.0.1\n      h2: 10.0.0.2\n"
    path = write_config(old)
    new = old.replace("h1: 10.0.0.1", "h1: { ip: 10.0.0.1, mesh: false }")
    hosts = changes.host_changes(path, old, new)
    assert hosts == [{"host": "h1", "change": "changed", "fields": ["mesh"]}]
    assert "h1" in changes.commit_message(hosts, [])


def committed(write_config, text):
    path = write_config(text)
    git(path.parent, "init", "-q")
    git(path.parent, "add", path.name)
    git(path.parent, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "inventory")
    return path


LINKED = ("groups:\n  lab:\n    user: u\n    hosts:\n      h1: 10.0.0.1\n      h2: 10.0.0.2\n      j1: 10.0.0.3\n"
          "links:\n  - { from: h1, to: h2 }\n  - { from: h2, to: lab }\n")


def test_a_links_change_names_the_links_in_the_message(write_config):
    """T67: an edit to links: names each Link that changed, as Host changes do, not "edit roster.yml"."""
    from roster import changes
    path = committed(write_config, LINKED)
    path.write_text(LINKED.replace("  - { from: h2, to: lab }\n", "  - { from: h2, to: lab, both: true }\n")
                    + "  - { from: j1, to: h2, via: h1 }\n")
    assert changes.diff(path)["message"] == "roster: add link j1 -> h2 via h1, change link h2 -> lab (both)"
    path.write_text(LINKED.replace("  - { from: h1, to: h2 }\n", ""))
    assert changes.diff(path)["message"] == "roster: remove link h1 -> h2"


def test_links_and_hosts_together_past_the_subject_limit_are_counted_and_listed(write_config):
    from roster import changes
    path = committed(write_config, LINKED)
    path.write_text(LINKED.replace("h1: 10.0.0.1", "h1: { ip: 10.0.0.1, title: the first one }")
                    .replace("  - { from: h1, to: h2 }\n", "  - { from: h1, to: h2, via: j1 }\n")
                    .replace("  - { from: h2, to: lab }\n", "  - { from: lab, to: h2 }\n"))
    assert changes.diff(path)["message"].split("\n") == [
        "roster: change 1 Host and 3 Links", "", "- change h1 (title)", "- add link lab -> h2",
        "- change link h1 -> h2 (via)", "- remove link h2 -> lab"]


def test_a_mesh_dir_change_names_its_host(write_config):
    from roster import changes
    path = committed(write_config, LINKED)
    path.write_text(LINKED.replace("h1: 10.0.0.1", "h1: { ip: 10.0.0.1, mesh_dir: /srv/mesh }"))
    assert changes.diff(path)["message"] == "roster: change h1 (mesh_dir)"


def test_a_seen_as_change_names_its_host(write_config):
    from roster import changes
    path = committed(write_config, LINKED)
    path.write_text(LINKED.replace("h1: 10.0.0.1", "h1: { ip: 10.0.0.1, seen_as: 10.0.9.1 }"))
    assert changes.diff(path)["message"] == "roster: change h1 (seen_as)"
