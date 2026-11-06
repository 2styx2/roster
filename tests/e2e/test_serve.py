"""`roster serve` against real sshd (docs/development.md, "End-to-end suite"): the app's main methods over JSON-RPC on
stdio, a check as a background job with its job.progress, edits and Pending changes in an infra repo, a Session's ssh
argv run for real (a key Login and an askpass one), $/cancel, and the error answers: an unknown Host, bad params, a
locked vault."""

import json

import pytest

from . import e2e_lab as world

LAB01, LAB02, LAB03 = (world.address(n) for n in ("lab-01", "lab-02", "lab-03"))
PORT = world.PORT
UNLOCKED = {"BW_SESSION": "fake-session-key"}

INVENTORY = f"""\
# the e2e suite's Inventory: made-up names, stand-in Hosts on this machine
box_name: e2e-box
key_path: ~/.ssh/roster_ed25519
groups:
  lab:
    title: Lab
    mesh: true
    user: lab
    auth: env:LAB_PW
    sudo: {{auth: env:LAB_PW}}
    port: {PORT}
    hosts:
      lab-01: {{ip: {LAB01}, type: dev}}
      lab-02:
        ip: {LAB02}
        title: Lab box 2
  ops:
    enroll: false
    hosts:
      lab-03:
        ip: {LAB03}
        port: {PORT}
        user: ops
        auth: "bw:lab-03 ssh"
"""

ITEMS = [{"id": "e2e-0001", "name": "lab-03 ssh", "revisionDate": "2026-10-01T10:00:00.000Z",
          "login": {"username": "ops", "password": "ops-pass-1", "uris": [{"uri": f"ssh://{LAB03}:{PORT}"}]}}]


def git(box, *args, cwd=None):
    r = box.program("git", ["git", *args], cwd=cwd)
    assert r.code == 0, r.err
    return r.out


@pytest.fixture(scope="module")
def infra(lab, box):
    """~/infra: roster.yml in a git repo with an upstream (a bare repo beside it), set up with the CLI."""
    (box.root / "bw-items.json").write_text(json.dumps(ITEMS))
    box.env.update({"GIT_AUTHOR_NAME": "e2e", "GIT_AUTHOR_EMAIL": "e2e@example.com", "GIT_COMMITTER_NAME": "e2e",
                    "GIT_COMMITTER_EMAIL": "e2e@example.com", "GIT_CONFIG_NOSYSTEM": "1"})
    seed = box.root / "seed"
    seed.mkdir()
    (seed / "roster.yml").write_text(INVENTORY)
    git(box, "init", "-q", "-b", "main", cwd=seed)
    git(box, "add", "roster.yml", cwd=seed)
    git(box, "commit", "-qm", "the lab", cwd=seed)
    git(box, "clone", "-q", "--bare", str(seed), str(box.root / "upstream.git"))
    git(box, "clone", "-q", str(box.root / "upstream.git"), str(box.home / "infra"))
    box.cwd = box.home / "infra"
    r = box.run("serve-setup", "setup", env=UNLOCKED)
    assert r.code == 0, r.out + r.err
    git(box, "status", "--short", cwd=box.cwd)
    return box


@pytest.fixture(scope="module")
def serve(infra):
    s = world.Serve(infra, "serve")
    # serve starts locked whatever the shell has (the app's lock screen unlocks it)
    assert result(s.call("vault.unlock", {"password": "hunter2"}, step="unlock"))["status"] == "unlocked"
    yield s
    s.close()


def result(answer):
    assert "result" in answer, answer
    return answer["result"]


def error(answer, code):
    assert "error" in answer, answer
    assert answer["error"]["code"] == code, answer
    return answer["error"]


def test_inventory_info_and_hosts_list(serve):
    info = result(serve.call("inventory.info"))
    assert info["store"]["kind"] == "repo" and info["host_count"] == 3
    hosts = result(serve.call("hosts.list"))
    assert [h["name"] for h in hosts["hosts"]] == ["lab-01", "lab-02", "lab-03"] and hosts["error"] is None


def test_host_get(serve):
    h = result(serve.call("host.get", {"name": "lab-02"}))
    assert h["name"] == "lab-02" and h["ip"] == LAB02 and h["title"] == "Lab box 2"


def test_error_answers(serve):
    error(serve.call("host.get", {"name": "nope-99"}, step="unknown-host"), 2)
    error(serve.call("host.get", {}, step="no-name"), -32602)
    error(serve.call("host.get", {"name": 5}, step="name-not-text"), -32602)
    error(serve.call("no.such.method", step="unknown-method"), -32601)
    error(serve.raw("{not json", "malformed"), -32700)
    r = result(serve.call("host.check", {"host": "nope-99"}, step="check-unknown"))      # a check, failed
    assert r["ok"] is False and r["steps"][0]["step"] == "inventory" and r["steps"][0]["code"] == 2, r
    error(serve.call("session.prepare", {"host": "nope-99"}, step="prepare-unknown"), 2)


def test_host_check_walks_the_steps(serve):
    r = result(serve.call("host.check", {"host": "lab-01"}, step="check-lab-01"))
    assert r["ok"] is True
    assert [s["step"] for s in r["steps"]][-1] == "auth"
    r = result(serve.call("host.check", {"host": "lab-03"}, step="check-lab-03"))
    assert r["ok"] is True, r


def test_host_check_as_a_job_with_progress(serve):
    job = result(serve.call("host.check", {"host": "lab-02", "background": True}, step="check-job"))
    assert job["kind"] == "check" and job["host"] == "lab-02"
    note = serve.wait_note("job.progress", lambda p: p.get("job") == job["job"] and p.get("state") == "done")
    assert note["params"]["host"] == "lab-02"
    jobs = result(serve.call("jobs.list"))
    assert any(j["job"] == job["job"] and j["state"] == "done" for j in jobs["jobs"])


def test_box_check_and_vault_status(serve):
    r = result(serve.call("box.check"))
    assert r["ok"] is True, r
    v = result(serve.call("vault.status"))
    assert v["provider"]


def test_host_update_then_pending_changes_and_discard(serve, infra):
    r = result(serve.call("host.update", {"host": "lab-02", "changes": {"title": "Lab box two"}}, step="update"))
    assert r["changed"] and r["host"]["title"] == "Lab box two"
    d = result(serve.call("changes.diff", step="diff"))
    assert d["count"] == 1 and d["hosts"] == [{"host": "lab-02", "change": "changed", "fields": ["title"]}]
    r = result(serve.call("changes.discard", step="discard"))
    assert r["discarded"] is True
    assert "Lab box 2" in (infra.home / "infra" / "roster.yml").read_text()
    error(serve.call("host.update", {"host": "lab-02", "changes": {"port": "x"}}, step="update-bad"), -32602)


def test_host_add_then_remove(serve, infra):
    params = {"name": "lab-09", "group": "lab", "address": LAB02, "user": "lab", "auth": "env:LAB_PW",
              "enroll": False}
    r = serve.call("host.add", params, step="add")
    if "error" in r and r["error"]["code"] == 44:            # its host key, as the app asks the person to accept it
        key = result(serve.call("host.scan_key", {"address": LAB02, "port": PORT}, step="scan-key"))
        r = serve.call("host.add", {**params, "host_key": key}, step="add-with-key")
    r = result(r)
    assert r["added"] is True and r["host"]["name"] == "lab-09"
    error(serve.call("host.add", params, step="add-again"), 81)
    r = result(serve.call("host.remove", {"host": "lab-09"}, step="remove"))
    assert r["removed"] == "lab-09" and r["group"] == "lab"
    error(serve.call("host.remove", {"host": "lab-09"}, step="remove-again"), 2)
    result(serve.call("changes.discard", step="discard-after-add"))


def test_host_move_keeps_what_it_inherited(serve, infra):
    try:
        r = result(serve.call("host.move", {"host": "lab-02", "group": "ops"}, step="move"))
        assert r["changed"] and r["host"]["group"] == "ops" and r["host"]["user"] == "lab", r
        moved = result(serve.call("host.get", {"name": "lab-02"}, step="get-moved"))
        assert moved["enroll"] is True and moved["port"] == PORT
        error(serve.call("host.move", {"host": "lab-02", "group": "nope"}, step="move-unknown-group"), 101)
        assert "sudo" in r["pinned"], r               # the sudo: it inherited from lab, written on the Host
    finally:
        result(serve.call("changes.discard", step="discard-after-move"))


def test_inventory_pull_fast_forwards(serve, infra):
    other = infra.root / "other"
    git(infra, "clone", "-q", str(infra.root / "upstream.git"), str(other))
    text = (other / "roster.yml").read_text().replace("title: Lab box 2", "title: Lab box 2 (pulled)")
    (other / "roster.yml").write_text(text)
    git(infra, "commit", "-qam", "retitle lab-02", cwd=other)
    git(infra, "push", "-q", cwd=other)
    r = result(serve.call("inventory.pull", step="pull"))
    assert r["updated"] is True and r["commits"] == 1
    h = result(serve.call("host.get", {"name": "lab-02", "settled": True}, step="get-after-pull"))
    assert h["title"] == "Lab box 2 (pulled)"
    r = result(serve.call("inventory.pull", step="pull-again"))
    assert r["updated"] is False


def test_mesh_status(serve):
    r = result(serve.call("mesh.status"))
    assert r["members"] == ["lab-01", "lab-02"] and r["pending"] == {}
    assert {(x["from"], x["to"]) for x in r["links"]} == {("lab-01", "lab-02"), ("lab-02", "lab-01")}


def run_session(infra, prepared, step):
    """The Session's own ssh, as the app runs it, with `hostname` as its command."""
    infra.ssh_guard(prepared["host"])
    return infra.program(step, [*prepared["argv"], "hostname"], env=prepared["env"], timeout=60)


def test_session_prepare_gives_an_ssh_that_logs_in(serve, infra):
    p = result(serve.call("session.prepare", {"host": "lab-01"}, step="prepare-key"))
    assert p["auth"] == "key" and p["login"] == {"address": LAB01, "port": PORT, "user": "lab"}
    r = run_session(infra, p, "session-key")
    assert r.code == 0 and r.out.strip() == "lab-01", r.err
    p = result(serve.call("session.prepare", {"host": "lab-03"}, step="prepare-password"))
    assert p["auth"] == "password" and "SSH_ASKPASS" in p["env"]
    r = run_session(infra, p, "session-password")
    assert r.code == 0 and r.out.strip() == "lab-03", r.err
    # the askpass token is spent: the same argv a second time gets no password
    # (a connection of its own: the first one's ControlMaster would let it in without asking)
    r = run_session(infra, {**p, "argv": [*p["argv"][:-1], "-o", "ControlPath=none", p["argv"][-1]]},
                    "session-spent-token")
    assert r.code != 0


def test_cancel(serve, lab):
    r = result(serve.call("$/cancel", {"id": 9999}, step="cancel-unknown"))
    assert r["cancelled"] is False and r["was"] is None
    error(serve.call("$/cancel", {}, step="cancel-no-id"), -32602)
    paused = lab.podman("pause", lab.container("lab-02"), check=False).returncode == 0
    if not paused:
        pytest.skip("this container engine can't pause a container (cgroups)")
    try:
        rid = serve.request("host.check", {"host": "lab-02"})
        serve.wait_note("job.progress", lambda p: p.get("host") == "lab-02" and p.get("state") == "running")
        c = result(serve.call("$/cancel", {"id": rid}, step="cancel-running"))
        assert c["cancelled"] is True and c["was"] == "running"
        r = result(serve.answer(rid, "cancelled-check"))
        assert r["ok"] is False
    finally:
        lab.podman("unpause", lab.container("lab-02"), check=False)


def test_a_locked_vault(infra):
    s = world.Serve(infra, "serve-locked")
    try:
        v = result(s.call("vault.status", step="status"))
        assert v["status"] == "locked", v
        error(s.call("session.prepare", {"host": "lab-03"}, step="prepare-locked"), 14)
        r = result(s.call("host.check", {"host": "lab-03"}, step="check-locked"))
        assert r["ok"] is False and any(x.get("code") == 14 for x in r["steps"]), r
        error(s.call("vault.unlock", {"password": "wrong"}, step="unlock-wrong"), 10)
        r = s.call("vault.unlock", {"password": "x", "provider": "op"}, step="unlock-op")      # no session to keep
        assert "error" in r, r
        r = result(s.call("vault.unlock", {"password": "hunter2"}, step="unlock"))
        assert r["status"] == "unlocked"
        p = result(s.call("session.prepare", {"host": "lab-03"}, step="prepare-unlocked"))
        assert p["auth"] == "password"
        r = result(s.call("vault.lock", step="lock"))
        error(s.call("session.prepare", {"host": "lab-03"}, step="prepare-relocked"), 14)
    finally:
        code, err = s.close()
    assert code == 0, err
