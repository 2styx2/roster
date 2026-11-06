"""T243 (#476), the Acceptance's table: the commands people reach for when the vault or the map changes work in any
order. For each pair, run in either order on a stand-in Box after (a) a vault item added (and a Host using it) and
(b) a Login's password changed in the vault: neither command fails with an unexplained error (a non-zero exit always
says its code or the next command), and the end state is the same both ways (this Box's ssh config, setup's records,
the vault snapshot). Fakes only: the stand-in bw, and the Hosts' logins answered from setup's own record."""

import itertools
import json
import os
import re
import shutil

import pytest
from test_vault_changes import DENIED, ITEMS, MAP, answered, run

from roster import boxkeys, boxsetup, providers, sshops
from roster.context import current

COMMANDS = {
    "sync": ["sync"],
    "setup": ["setup"],
    "check": ["check"],
    "run": ["run", "new-02", "--", "uptime"],
    "vault sync": ["vault", "sync"],
    "vault unlock": ["vault", "unlock"],
}
PAIRS = list(itertools.combinations(COMMANDS, 2))
NEW_ITEM = {"id": "cccc-3", "name": "new-02 ssh", "type": 1, "revisionDate": "2026-11-06T09:00:00.000Z",
            "login": {"username": "admin", "password": "pw-new2-SECRET", "uris": [{"uri": "10.0.0.7"}]}}
SECRETS = ["pw-web-SECRET", "pw-new-SECRET", "pw-new2-SECRET", "pw-changed-SECRET", "fake-session-key"]
# each Login's password in the vault as the Hosts have it; ON_HOST: a Host whose own password differs (a change made
# in the vault only)
PASSWORDS = {"bw:web-01 ssh": "pw-web-SECRET", "bw:new-01 ssh": "pw-new-SECRET", "bw:new-02 ssh": "pw-new2-SECRET"}
ON_HOST = {}


@pytest.fixture
def stand_in_box(fakes, monkeypatch, tmp_path, write_config, capsys):
    """Two Hosts set up from this Box, its vault synced, Bitwarden unlocked (BW_SESSION). A key login works where
    setup's record says this Box's key went; anywhere else it's refused, as sshd would."""
    path = write_config(MAP)
    items = tmp_path / "items.json"
    items.write_text(json.dumps(ITEMS))
    monkeypatch.setenv("FAKE_BW_ITEMS", str(items))
    monkeypatch.setenv("FAKE_BW_SYNC_FILE", str(tmp_path / "synced"))
    monkeypatch.setenv("BW_SESSION", "fake-session-key")
    monkeypatch.setenv("FAKE_SSH_STDERR", DENIED)
    monkeypatch.setenv("FAKE_SSH_EXIT", "255")
    monkeypatch.setattr(boxsetup, "record_fingerprints",
                        lambda cfg, hosts: answered(*(h["ip"] for h in hosts)) or set())
    def enroll(h, *a, **k):             # the key goes on with the Host's own password, never another
        if providers.get_secret(h["ssh"]["auth"], h["group"]) != ON_HOST.get(h["name"], PASSWORDS[h["ssh"]["auth"]]):
            raise RuntimeError("login refused (wrong user or password?)")
        return []
    monkeypatch.setattr(boxsetup, "enroll", enroll)

    def probe(name, timeout=10):
        return (True, "") if name in boxkeys.installed() else (False, DENIED)
    monkeypatch.setattr(sshops, "login_probe", probe)
    monkeypatch.setattr(boxsetup, "ssh_ok", lambda name, timeout=10: probe(name)[0])
    from roster import run as run_module
    monkeypatch.setattr(run_module, "run_instead", lambda argv: 0)          # a set-up Host: ssh takes over, works
    assert run(capsys, "setup")[0] == 0
    assert run(capsys, "vault", "sync")[0] == 0
    ROSTER_MD[0] = path.parent / "ROSTER.md"
    ON_HOST.clear()
    return {"path": path, "items": items, "write_config": write_config, "tmp": tmp_path, "monkeypatch": monkeypatch}


def change(box, case):
    if case == "item added":            # in the vault, and a Host in roster.yml that uses it
        box["items"].write_text(json.dumps(json.loads(box["items"].read_text()) + [NEW_ITEM]))
        box["write_config"](MAP + '      new-02: {ip: 10.0.0.7, user: admin, auth: "bw:new-02 ssh"}\n')
    else:                               # a Login's password changed in the vault, not on the Host that uses it
        items = json.loads(box["items"].read_text())
        items[1] = {**items[1], "revisionDate": "2026-11-06T09:30:00.000Z",
                    "login": {**items[1]["login"], "password": "pw-changed-SECRET"}}
        box["items"].write_text(json.dumps(items))
        box["write_config"](MAP + '      new-02: {ip: 10.0.0.7, user: admin, auth: "bw:new-01 ssh"}\n')
        ON_HOST["new-02"] = "pw-new-SECRET"          # new-02 still has the old one


ROSTER_MD = [None]


def state():
    """This Box's state the commands change: its ssh config, setup's records, the vault snapshot's items."""
    ctx = current()

    def text(f):
        return f.read_text() if f.exists() else None
    from roster.providers.bitwarden import session_file
    from roster.vaultsync import load
    vault = load("bw") or {}
    return {"ssh config": text(ctx.ssh_config), "setup left": text(ctx.file("setup_left")),
            "keys on": boxkeys.installed(), "known hosts": sorted(text(ctx.known_hosts).splitlines()),
            "roster.md": text(ROSTER_MD[0]), "vault items": vault.get("items"),
            "vault unmapped": vault.get("unmapped"), "saved session": session_file().exists()}


def explained(rc, out, err):
    """A non-zero exit says why in its own output: a code (`[N]`) and the fix for it (a `fix:` or `next:` line, or the
    command after the cause)."""
    text = out + err
    return rc == 0 or bool(re.search(r"\[\d+\] [^\n]+: [^\n]+", text) or (
        re.search(r"\[\d+\]", text) and re.search(r"^ *(next|fix): ", text, re.MULTILINE)))


def roster(capsys, argv):
    """One command as a new roster process runs it: (exit code, stdout, stderr), a refusal's words on stderr."""
    from roster.errors import Exit
    try:
        return run(capsys, *argv)
    except Exit as e:
        out = capsys.readouterr()
        return 1, out.out, out.err + str(e)


def both_orders(box, capsys, first, second):
    home, synced = current().ssh_config.parents[2], box["tmp"] / "synced"
    saved = box["tmp"] / "saved"
    shutil.copytree(home, saved / "home", symlinks=True)
    if synced.exists():
        shutil.copy(synced, saved / "synced")
    ends = []
    if "vault unlock" in (first, second):
        from test_vault_unlock import Terminal
        Terminal(box["monkeypatch"])     # vault unlock asks only in a terminal (the shell's BW_SESSION: no password)
    outputs = []
    for order in ((first, second), (second, first)):
        shutil.rmtree(home)
        shutil.copytree(saved / "home", home, symlinks=True)
        if (saved / "synced").exists():
            shutil.copy(saved / "synced", synced)
        for name in order:
            providers.reset()               # a new roster process each time, from the same shell (BW_SESSION)
            os.environ["BW_SESSION"] = "fake-session-key"
            rc, out, err = roster(capsys, COMMANDS[name])
            outputs.append(out + err)
            assert explained(rc, out, err), f"{' then '.join(order)}: {name} exited {rc} with no code or fix:\n{out}{err}"
            assert not any(s in out + err for s in SECRETS), f"{name} printed a secret"
        ends.append(state())
    return ends, outputs


@pytest.mark.parametrize("case", ["item added", "password changed"])
@pytest.mark.parametrize(("first", "second"), PAIRS, ids=[f"{a}+{b}" for a, b in PAIRS])
def test_each_pair_works_in_either_order_with_the_same_end_state(stand_in_box, capsys, case, first, second):
    change(stand_in_box, case)
    (one_way, other_way), outputs = both_orders(stand_in_box, capsys, first, second)
    assert one_way == other_way
    if case == "password changed" and "setup" in (first, second):
        # the Host refused the vault item's new password: setup left it, naming the item, never the password
        assert one_way["setup left"] and "new-02" in one_way["setup left"] and "new-02" not in one_way["keys on"]
        said = [o for o in outputs if "new-02: [45]" in o]
        assert len(said) == 2 and all("vault item 'new-01 ssh'" in o for o in said)


def test_setup_before_vault_sync_picks_up_a_new_item_itself(stand_in_box, capsys):
    """The issue's Order row: no `roster vault sync` first; setup's own lookup finds the item added in the vault."""
    change(stand_in_box, "item added")
    providers.reset()
    os.environ["BW_SESSION"] = "fake-session-key"
    rc, out, err = run(capsys, "setup", "--host", "new-02")
    assert rc == 0 and "ok    new-02" in out
    assert "new-02" in boxkeys.installed()
