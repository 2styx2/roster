"""`roster add NAME --save-to-vault` (T265, #536, decision Q217): the new Host's vault item made first (its password
asked twice, hidden, on the terminal), then the Host written with `auth:` pointing at it, through the one path the
app's "Save to vault" uses (addhost.save_item, providers.create_item). Stand-in bw, op and keepassxc-cli and temp
HOMEs only: never a real vault."""

import contextlib
import getpass
import json
import sys

import pytest

from roster import providers
from roster.cli import main

PW = "n3w-h0st-s3cret"                  # the new Host's password: never in argv, output, roster.yml or an error

YML = """\
defaults:
  user: ops

groups:
  lab:
    auth: env:LAB_PW
    hosts:
      esx-02: {ip: 10.0.0.5}
"""


class Terminal:
    """A person at the controlling terminal (providers.open_tty), typing ANSWERS at each hidden prompt (getpass) in
    turn, and Enter at a y/N question. ASKED: the hidden prompts. SHOWN: what else the terminal showed (a note, a
    question). TTY=False: there's no terminal."""

    def __init__(self, monkeypatch, *answers, tty=True):
        self.asked = []
        self.shown = ""
        left = list(answers)
        term = self

        class Tty:
            def write(self, text):
                term.shown += text

            def readline(self):
                return "\n"

        @contextlib.contextmanager
        def open_tty():
            yield Tty() if tty else None
        monkeypatch.setattr(providers, "open_tty", open_tty)

        def ask(prompt=""):
            self.asked.append(prompt)
            if not left:
                raise EOFError
            return left.pop(0)
        monkeypatch.setattr(getpass, "getpass", ask)


@pytest.fixture
def yml(write_config):
    return write_config(YML)


@pytest.fixture
def bw(fakes, monkeypatch, tmp_path):
    """The stand-in bw, unlocked (BW_SESSION), with one item; its argv log (FAKE_ARGV_LOG)."""
    items = tmp_path / "items.json"
    items.write_text(json.dumps([{"id": "aaaa-1", "name": "esx-02 ssh",
                                  "login": {"username": "root", "password": "pw-esx"}}]))
    log = tmp_path / "argv.log"
    monkeypatch.setenv("FAKE_BW_ITEMS", str(items))
    monkeypatch.setenv("FAKE_ARGV_LOG", str(log))
    monkeypatch.setenv("BW_SESSION", "fake-session-key")
    return items


def bw_items(items):
    return json.loads(items.read_text())


def logged(tmp_path):
    f = tmp_path / "argv.log"
    return f.read_text() if f.exists() else ""


def run(capsys, *argv):
    rc = main(["add", *argv])
    out = capsys.readouterr()
    return rc, out.out + out.err


def fails(capsys, *argv):
    with pytest.raises(SystemExit) as e:
        main(["add", *argv])
    out = capsys.readouterr()
    return str(e.value.code), out.out + out.err


def test_bw_item_made_with_name_uri_and_user_then_auth_points_at_it(capsys, yml, bw, tmp_path, monkeypatch):
    term = Terminal(monkeypatch, PW, PW)
    rc, out = run(capsys, "nas", "--ip", "10.0.0.50", "--port", "2222", "--user", "admin", "--group", "lab",
                  "--save-to-vault", "--provider", "bw")
    assert rc == 0
    made = [i for i in bw_items(bw) if i["name"] == "nas ssh"]
    assert len(made) == 1
    assert made[0]["login"]["username"] == "admin"
    assert made[0]["login"]["password"] == PW
    assert made[0]["login"]["uris"] == [{"uri": "ssh://10.0.0.50:2222", "match": None}]
    assert made[0]["organizationId"] is None                        # the personal vault: the default save_to
    assert "nas: {ip: 10.0.0.50, user: admin, port: 2222, auth: bw:nas ssh}" in yml.read_text()
    assert len(term.asked) == 2 and all("nas" in a for a in term.asked)
    assert PW not in out + logged(tmp_path) + yml.read_text()
    calls = [json.loads(line)[:2] for line in logged(tmp_path).splitlines()]
    assert calls[-1][:1] == ["sync"] and ["create", "item"] in calls          # synced after the create
    assert "next         roster setup --host nas" in out


ORGS = [{"id": "0rg-team", "name": "My Team", "status": 2, "type": 2, "enabled": True,
         "collections": [{"id": "c0l-infra", "name": "Infra logins"}]}]


def test_save_to_from_roster_yml_and_save_to_flag_over_it(capsys, write_config, bw, monkeypatch):
    monkeypatch.setenv("FAKE_BW_ORGS", json.dumps(ORGS))
    yml = write_config("providers:\n  bw:\n    save_to: {organization: My Team, collection: Infra logins}\n" + YML)
    Terminal(monkeypatch, PW, PW, PW, PW)
    assert run(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "bw")[0] == 0
    assert [i["collectionIds"] for i in bw_items(bw) if i["name"] == "nas ssh"] == [["c0l-infra"]]
    rc, out = run(capsys, "web-01", "--ip", "10.0.0.51", "--save-to-vault", "--provider", "bw",
                  "--save-to", "personal")
    assert rc == 0 and "Personal vault" in out
    assert [i["organizationId"] for i in bw_items(bw) if i["name"] == "web-01 ssh"] == [None]
    assert "auth: bw:web-01 ssh" in yml.read_text()


def test_the_default_provider_is_the_vault_roster_yml_uses(capsys, write_config, bw, monkeypatch):
    yml = write_config(YML.replace("auth: env:LAB_PW", "auth: bw:lab ssh"))
    Terminal(monkeypatch, PW, PW)
    assert run(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault")[0] == 0
    assert "auth: bw:nas ssh" in yml.read_text()


@pytest.fixture
def kdbx(fakes, isolated, tmp_path, monkeypatch):
    db = tmp_path / "roster.kdbx"
    db.write_text(json.dumps({"password": "c0rrect-h0rse", "key": None, "recycle_bin": "Recycle Bin",
                              "groups": ["Hosts"], "entries": [{"path": "esx-02 ssh", "Password": "pw-esx"}]}))
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    return db


def test_kp_entry_made_in_a_group_then_auth_points_at_it(capsys, write_config, kdbx, tmp_path, monkeypatch):
    yml = write_config(f"providers:\n  kp:\n    database: {kdbx}\n" + YML)
    term = Terminal(monkeypatch, PW, PW, "c0rrect-h0rse")         # the new password twice, then the database's
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)
    rc, out = run(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "kp", "--save-to", "Hosts",
                  "--group", "lab", "-y")         # -y: no group or enroll question; the passwords are still asked
    assert rc == 0, out
    entry = next(e for e in json.loads(kdbx.read_text())["entries"] if e["path"] == "Hosts/nas ssh")
    assert (entry["UserName"], entry["URL"], entry["Password"]) == ("ops", "ssh://10.0.0.50", PW)
    assert "nas: {ip: 10.0.0.50, auth: kp:nas ssh}" in yml.read_text()
    assert len(term.asked) == 3
    assert PW not in out + logged(tmp_path) + yml.read_text()


@pytest.mark.parametrize("provider", ["op", "env", "prompt"])
def test_a_provider_that_cant_save_is_refused_before_anything_is_asked(capsys, yml, fakes, provider, monkeypatch):
    term = Terminal(monkeypatch, PW, PW)
    code, out = fails(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", provider)
    assert "[61]" in code and "--auth" in code
    assert term.asked == [] and yml.read_text() == YML


def test_no_terminal_is_refused_with_nothing_saved_or_written(capsys, yml, bw, monkeypatch):
    term = Terminal(monkeypatch, PW, PW, tty=False)
    code, _ = fails(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "bw")
    assert "[223]" in code and "terminal" in code
    assert term.asked == [] and yml.read_text() == YML
    assert [i["name"] for i in bw_items(bw)] == ["esx-02 ssh"]


@pytest.mark.parametrize("typed", [(PW, "n3w-h0st-s3creT"), ("", ""), (PW,)])
def test_a_confirmation_that_doesnt_match_or_none_is_refused(capsys, yml, bw, monkeypatch, typed):
    Terminal(monkeypatch, *typed)
    code, out = fails(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "bw")
    assert "[224]" in code
    assert yml.read_text() == YML and [i["name"] for i in bw_items(bw)] == ["esx-02 ssh"]
    assert PW not in code + out


def test_yes_still_asks_the_password(capsys, yml, bw, monkeypatch):
    term = Terminal(monkeypatch, PW, PW)
    assert run(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "bw", "-y")[0] == 0
    assert len(term.asked) == 2


def test_an_item_of_that_name_already_there_is_refused(capsys, write_config, bw, monkeypatch):
    yml = write_config(YML)
    Terminal(monkeypatch, PW, PW)
    bw.write_text(json.dumps(bw_items(bw) + [{"id": "x", "name": "nas ssh", "login": {"password": "old"}}]))
    code, _ = fails(capsys, "nas", "--ip", "10.0.0.51", "--save-to-vault", "--provider", "bw")
    assert "[60]" in code and "--auth bw:nas ssh" in code
    assert "nas" not in yml.read_text()
    assert [i["name"] for i in bw_items(bw)].count("nas ssh") == 1


def test_an_unknown_save_to_is_refused(capsys, yml, bw, monkeypatch):
    monkeypatch.setenv("FAKE_BW_ORGS", json.dumps(ORGS))
    term = Terminal(monkeypatch, PW, PW)
    code, _ = fails(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "bw", "--save-to", "Hosts")
    assert "[64]" in code and term.asked == []                      # not a Bitwarden shape: refused before asking
    Terminal(monkeypatch, PW, PW)
    code, _ = fails(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "bw",
                    "--save-to", "My Team/No such")
    assert "[64]" in code and "No such" in code
    assert yml.read_text() == YML and [i["name"] for i in bw_items(bw)] == ["esx-02 ssh"]


def test_a_failed_roster_yml_write_names_the_item_and_writes_no_host(capsys, yml, bw, monkeypatch):
    from roster import store
    Terminal(monkeypatch, PW, PW)

    def broken(self, *a, **kw):
        raise PermissionError(13, "Permission denied", str(yml))
    monkeypatch.setattr(store.Store, "write", broken)
    code, out = fails(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "bw")
    assert "[225]" in code and "'nas ssh'" in code and "Permission denied" in code
    assert yml.read_text() == YML                                   # no Host points at it, none half-written
    assert [i["name"] for i in bw_items(bw)] == ["esx-02 ssh", "nas ssh"]     # left for the user to delete
    assert PW not in code + out


def test_dry_run_shows_the_item_and_asks_and_saves_nothing(capsys, yml, bw, monkeypatch, tmp_path):
    term = Terminal(monkeypatch, PW, PW)
    rc, out = run(capsys, "nas", "--ip", "10.0.0.50", "--user", "admin", "--save-to-vault", "--provider", "bw",
                  "--dry-run")
    assert rc == 0 and term.asked == []
    assert "vault item 'nas ssh' in bw (personal, from default)" in out
    assert "username admin, URI ssh://10.0.0.50" in out and "auth: bw:nas ssh" in out
    assert yml.read_text() == YML and logged(tmp_path) == ""


@pytest.mark.parametrize("extra, why", [(["--auth", "bw:x"], "--auth"), (["--from-vault", "--auth", "bw:x"],
                                                                         "--from-vault")])
def test_save_to_vault_with_auth_or_from_vault_is_a_usage_error(capsys, yml, extra, why):
    with pytest.raises(SystemExit) as e:
        main(["add", "nas", "--ip", "10.0.0.50", "--save-to-vault", *extra])
    assert e.value.code == 2 and why in capsys.readouterr().err


def test_save_to_without_save_to_vault_is_a_usage_error(capsys, yml):
    with pytest.raises(SystemExit) as e:
        main(["add", "nas", "--ip", "10.0.0.50", "--save-to", "personal"])
    assert e.value.code == 2


def test_the_password_never_reaches_a_child_process_argv_or_environment(capsys, yml, bw, monkeypatch):
    import subprocess
    seen = []
    real = subprocess.Popen

    def watch(args, *a, **kw):
        seen.append(json.dumps([list(args) if not isinstance(args, str) else args,
                                {k: v for k, v in (kw.get("env") or {}).items()}]))
        return real(args, *a, **kw)
    monkeypatch.setattr(subprocess, "Popen", watch)
    Terminal(monkeypatch, PW, PW)
    assert run(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "bw")[0] == 0
    assert seen and not any(PW in s for s in seen)


def test_a_locked_bitwarden_says_what_unlocking_costs_then_asks_once(capsys, yml, bw, monkeypatch, tmp_path):
    monkeypatch.delenv("BW_SESSION")
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)
    term = Terminal(monkeypatch, PW, PW, "hunter2")             # the new password twice, then the master password
    rc, out = run(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "bw", "-y")
    assert rc == 0, out
    assert "locks the roster app" in term.shown                     # T241's note, before any prompt
    assert len(term.asked) == 3 and "master password" in term.asked[2]
    assert "Keep the vault unlocked" in term.shown                  # T241's offer (Enter: No)
    assert [i["name"] for i in bw_items(bw)] == ["esx-02 ssh", "nas ssh"]
    assert PW not in out + logged(tmp_path) and "hunter2" not in logged(tmp_path)
