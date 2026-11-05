"""T241 (#474, decision Q203): a Bitwarden unlock that outlasts one run. `roster vault unlock` saves the session key in
~/.config/roster/bw-session, `roster vault lock` locks and removes it; an interactive unlock says why it's asked every
run and offers to keep it; `vault status` and `check --box` say whether a saved session is there and works."""
import json
import os
import subprocess
import sys

import pytest

from roster import providers
from roster.cli import main
from roster.common import WINDOWS, user_config_dir
from roster.providers import bitwarden, get_secret

FAKE_BW = os.path.join(os.path.dirname(__file__), "fakes", "bw")


def bw_call(*args, session=None):
    """The fake bw itself, as a script would run it: (exit code, stdout)."""
    env = {**os.environ, **({"BW_SESSION": session} if session else {})}
    env.pop("BW_SESSION", None) if session is None else None
    r = subprocess.run([sys.executable, FAKE_BW, *args, "--nointeraction"], env=env, capture_output=True, text=True,
                       input="")
    return r.returncode, r.stdout.strip()


def bw_status(session):
    return json.loads(bw_call("status", session=session)[1])["status"]


@pytest.fixture
def one_unlock(isolated, monkeypatch, tmp_path):
    """The fake bw keeping its one protected key in a data file, as bw's CLI does (FAKE_BW_DATA)."""
    monkeypatch.setenv("FAKE_BW_DATA", str(tmp_path / "bw-data.json"))
    monkeypatch.setenv("PW", "hunter2")


# ---- bw keeps one unlock at a time (bitwarden/clients apps/cli, pinned in the fake)

def test_a_new_unlock_makes_the_earlier_session_key_stop_working(one_unlock):
    """unlock.command.ts setNewSessionKey(): every unlock makes a new BW_SESSION key, and the user key is saved
    encrypted with it under one name (NodeEnvSecureStorageService), so the earlier key decrypts nothing: locked."""
    _, first = bw_call("unlock", "--raw", "--passwordenv", "PW")
    assert bw_status(first) == "unlocked"
    _, second = bw_call("unlock", "--raw", "--passwordenv", "PW")
    assert second != first
    assert bw_status(second) == "unlocked"
    assert bw_status(first) == "locked"
    assert bw_call("list", "items", session=first)[0] != 0


def test_bw_lock_makes_every_session_key_stop_working(one_unlock):
    """lock.command.ts: lockService.lock() clears the user key, so no session key opens the vault after it."""
    _, key = bw_call("unlock", "--raw", "--passwordenv", "PW")
    assert bw_call("lock")[0] == 0
    assert bw_status(key) == "locked"


# ---- an interactive unlock says why it's asked every run, and offers to keep it


OFFER = "Keep the vault unlocked for other roster runs on this Box? [y/N] "


class Terminal:
    """A person at a terminal: the master password for each hidden prompt, ANSWER (a line) for the y/N question."""

    def __init__(self, monkeypatch, answer="\n"):
        import getpass
        import io
        self.passwords = 0
        stdin = io.StringIO(answer)
        stdin.isatty = lambda: True
        monkeypatch.setattr(sys, "stdin", stdin)

        def ask(prompt=""):
            self.passwords += 1
            return "hunter2"
        monkeypatch.setattr(getpass, "getpass", ask)


def next_run():
    """What a new roster process starts with: no secret, no session key, no provider state."""
    providers._secrets.clear()
    providers.PROVIDER_STATE.clear()
    bitwarden.forget_session()
    bitwarden._offered["done"] = False


def session_path():
    return user_config_dir() / "bw-session"


def test_no_saved_session_prompts_offers_and_says_this_run_only_on_no(isolated, fakes, monkeypatch, capsys):
    term = Terminal(monkeypatch, "\n")
    assert get_secret("bw:Network gear", "g") == "pw-netops"
    err = capsys.readouterr().err
    assert term.passwords == 1
    assert OFFER in err
    assert ("note: this unlock lasts for this run only; to stay unlocked on this Box: roster vault unlock"
            in err)
    assert not session_path().exists()


def test_yes_saves_a_private_session_the_next_run_uses_without_asking(isolated, fakes, monkeypatch, capsys):
    term = Terminal(monkeypatch, "y\n")
    assert get_secret("bw:Network gear", "g") == "pw-netops"
    err = capsys.readouterr().err
    assert "roster vault lock` undoes this" in err and "this run only" not in err
    assert session_path().read_text() == "fake-session-key\n"
    if not WINDOWS:
        assert session_path().stat().st_mode & 0o777 == 0o600
    assert "fake-session-key" not in err
    next_run()
    assert get_secret("bw:Network gear", "g") == "pw-netops"
    assert term.passwords == 1
    assert OFFER not in capsys.readouterr().err          # a working saved session: nothing asked


def test_expired_saved_session_says_so_after_the_prompt(isolated, fakes, monkeypatch, capsys):
    session_path().parent.mkdir(parents=True, exist_ok=True)
    session_path().write_text("stale-key\n")
    session_path().chmod(0o600)
    Terminal(monkeypatch, "no\n")
    assert get_secret("bw:Network gear", "g") == "pw-netops"
    err = capsys.readouterr().err
    assert (f"note: the saved Bitwarden session in {session_path()} has expired (locked since it was saved, e.g. by "
            "the roster app's lock or a bw lock/unlock); roster vault unlock saves a new one") in err
    assert session_path().read_text() == "stale-key\n"


def test_yes_replaces_an_expired_saved_session(isolated, fakes, monkeypatch, capsys):
    session_path().parent.mkdir(parents=True, exist_ok=True)
    session_path().write_text("stale-key\n")
    session_path().chmod(0o600)
    Terminal(monkeypatch, "y\n")
    get_secret("bw:Network gear", "g")
    assert session_path().read_text() == "fake-session-key\n"


def test_asked_once_a_run(isolated, fakes, monkeypatch, capsys):
    term = Terminal(monkeypatch, "\n\n")
    get_secret("bw:Network gear", "g")
    providers.lock("bw")                                 # locked again in the same run: asks the password again
    get_secret("bw:Orion servers", "g")
    assert term.passwords == 2
    assert capsys.readouterr().err.count(OFFER) == 1


def test_no_terminal_never_asks(isolated, fakes, monkeypatch, capsys):
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    assert get_secret("bw:Network gear", "g") == "pw-netops"
    err = capsys.readouterr().err
    assert OFFER not in err and "note:" not in err
    assert not session_path().exists()


def test_bw_password_in_a_terminal_never_asks(isolated, fakes, monkeypatch, capsys):
    Terminal(monkeypatch, "y\n")
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    get_secret("bw:Network gear", "g")
    err = capsys.readouterr().err
    assert OFFER not in err and "note:" not in err
    assert not session_path().exists()


def test_json_output_has_no_note_or_question(isolated, fakes, monkeypatch, capsys):
    Terminal(monkeypatch, "y\n")
    monkeypatch.setattr(providers, "JSON_OUTPUT", True)
    get_secret("bw:Network gear", "g")
    err = capsys.readouterr().err
    assert OFFER not in err and "note:" not in err
    assert not session_path().exists()


def test_serve_never_asks(isolated, fakes, monkeypatch, capsys):
    Terminal(monkeypatch, "y\n")
    monkeypatch.setattr(providers, "MANUAL_UNLOCK", True)
    providers.unlock("bw", "hunter2")
    get_secret("bw:Network gear", "g")
    assert OFFER not in capsys.readouterr().err
    assert not session_path().exists()


# ---- through the CLI


BW_YML = "groups:\n  lab: {user: ops, auth: 'bw:Network gear', hosts: {esx-02: 10.0.0.5}}\n"


def test_a_json_command_in_a_terminal_has_no_note_or_question(isolated, fakes, write_config, monkeypatch, capsys):
    write_config(BW_YML)
    Terminal(monkeypatch, "y\n")
    assert main(["check", "--auth", "--json"]) == 0
    err = capsys.readouterr().err
    assert OFFER not in err and "note:" not in err
    assert not session_path().exists()
    assert providers.JSON_OUTPUT is False                # only for that command


def test_vault_unlock_saves_a_private_session_the_next_run_uses(isolated, fakes, write_config, monkeypatch, capsys,
                                                                 tmp_path):
    write_config(BW_YML)
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    term = Terminal(monkeypatch)
    assert main(["vault", "unlock"]) == 0
    out, err = capsys.readouterr()
    assert "unlocked until `roster vault lock`, `bw lock`, or the roster app's lock" in out
    assert "fake-session-key" not in out + err
    assert session_path().read_text() == "fake-session-key\n"
    if not WINDOWS:
        assert session_path().stat().st_mode & 0o777 == 0o600
    assert "hunter2" not in (tmp_path / "argv.log").read_text()
    next_run()
    assert get_secret("bw:Network gear", "g") == "pw-netops"
    assert term.passwords == 1


def test_vault_unlock_needs_no_roster_yml(isolated, fakes, monkeypatch, capsys):
    Terminal(monkeypatch)
    assert main(["vault", "unlock"]) == 0
    assert session_path().exists()


def test_vault_unlock_with_a_wrong_password_saves_nothing(isolated, fakes, monkeypatch, capsys):
    import getpass
    Terminal(monkeypatch)
    monkeypatch.setattr(getpass, "getpass", lambda prompt="": "wrong-xyzzy")
    with pytest.raises(SystemExit, match=r"\[10\] Bitwarden unlock failed") as e:
        main(["vault", "unlock"])
    assert "xyzzy" not in str(e.value)
    assert not session_path().exists()


def test_vault_unlock_needs_a_terminal(isolated, fakes, capsys):
    with pytest.raises(SystemExit, match="needs a terminal"):
        main(["vault", "unlock"])
    assert not session_path().exists()


def test_vault_unlock_with_a_working_session_says_so_without_asking(isolated, fakes, monkeypatch, capsys):
    term = Terminal(monkeypatch)
    main(["vault", "unlock"])
    capsys.readouterr()
    assert main(["vault", "unlock"]) == 0
    assert term.passwords == 1
    assert "already unlocked" in capsys.readouterr().out


def test_vault_lock_locks_and_removes_the_file(isolated, fakes, monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    Terminal(monkeypatch)
    main(["vault", "unlock"])
    assert main(["vault", "lock"]) == 0
    assert not session_path().exists()
    assert ["lock", "--nointeraction"] in [json.loads(x) for x in (tmp_path / "argv.log").read_text().splitlines()]
    assert "locked" in capsys.readouterr().out


def test_vault_lock_with_nothing_saved_still_locks(isolated, fakes, capsys):
    assert main(["vault", "lock"]) == 0
    assert "no saved session" in capsys.readouterr().out


@pytest.mark.skipif(WINDOWS, reason="a symlink needs a privilege there")
def test_vault_unlock_refuses_a_symlink(isolated, fakes, monkeypatch, capsys, tmp_path):
    target = tmp_path / "elsewhere"
    target.write_text("x\n")
    session_path().parent.mkdir(parents=True, exist_ok=True)
    session_path().symlink_to(target)
    Terminal(monkeypatch)
    with pytest.raises(SystemExit, match=r"\[202\] .*symlink"):
        main(["vault", "unlock"])
    assert session_path().is_symlink() and target.read_text() == "x\n"


@pytest.mark.skipif(WINDOWS, reason="a uid; Windows checks the owner SID")
def test_vault_unlock_refuses_a_file_someone_else_owns(isolated, fakes, monkeypatch, capsys):
    session_path().parent.mkdir(parents=True, exist_ok=True)
    session_path().write_text("theirs\n")
    session_path().chmod(0o600)
    monkeypatch.setattr(os, "getuid", lambda: os.stat(session_path()).st_uid + 1)
    term = Terminal(monkeypatch)
    with pytest.raises(SystemExit, match=r"\[202\] .*isn't yours"):
        main(["vault", "unlock"])
    assert session_path().read_text() == "theirs\n"
    assert term.passwords == 0                           # refused before the password is asked


def test_the_offer_refuses_a_symlink_too(isolated, fakes, monkeypatch, capsys, tmp_path):
    if WINDOWS:
        pytest.skip("a symlink needs a privilege there")
    target = tmp_path / "elsewhere"
    target.write_text("x\n")
    session_path().parent.mkdir(parents=True, exist_ok=True)
    session_path().symlink_to(target)
    Terminal(monkeypatch, "y\n")
    assert get_secret("bw:Network gear", "g") == "pw-netops"
    assert "note: not saved:" in capsys.readouterr().err
    assert target.read_text() == "x\n"


@pytest.mark.parametrize("name, why", [("kp", "KeePassXC keeps no session"), ("op", "Bitwarden only for now")])
def test_vault_unlock_and_lock_are_bitwarden_only(isolated, fakes, capsys, name, why):
    for action in ("unlock", "lock"):
        with pytest.raises(SystemExit, match=rf"\[203\] .*{why}"):
            main(["vault", action, name])


def test_the_app_locking_makes_the_saved_session_expired(one_unlock, fakes, write_config, monkeypatch, capsys):
    """The owner's manual check, with the fake: unlock with `vault unlock`, lock in the app (serve's vault.lock runs
    `bw lock`), and the next CLI run says the saved session expired."""
    write_config(BW_YML)
    Terminal(monkeypatch, "\n")
    main(["vault", "unlock"])
    next_run()
    monkeypatch.setattr(providers, "MANUAL_UNLOCK", True)     # the app's serve
    providers.unlock("bw", "hunter2")                         # a new unlock already breaks it...
    providers.lock("bw")                                      # ...and so does the lock
    monkeypatch.setattr(providers, "MANUAL_UNLOCK", False)
    next_run()
    capsys.readouterr()
    assert get_secret("bw:Network gear", "g") == "pw-netops"
    assert "has expired" in capsys.readouterr().err


# ---- vault status and check --box say whether a saved session is there and works

def bw_check(capsys, *argv):
    capsys.readouterr()
    main([*argv, "--json"])
    doc = json.loads(capsys.readouterr().out)
    checks = doc["vault"] if "vault" in doc else doc["checks"]
    return next(c for c in checks if c["message"].startswith("bw ("))


@pytest.mark.parametrize("argv", [("vault", "status"), ("check", "--box")])
def test_status_says_none_working_or_expired(isolated, fakes, write_config, monkeypatch, capsys, argv):
    write_config(BW_YML)
    c = bw_check(capsys, *argv)
    assert c["saved_session"] == "none" and "saved session: none (every run asks)" in c["message"]
    Terminal(monkeypatch)
    main(["vault", "unlock"])
    c = bw_check(capsys, *argv)
    assert c["saved_session"] == "working" and "saved session: saved, working" in c["message"]
    assert c["level"] == "ok"
    session_path().write_text("stale-key\n")
    c = bw_check(capsys, *argv)
    assert c["saved_session"] == "expired" and "saved session: saved, expired" in c["message"]
    assert c["level"] == "warn" and "roster vault unlock" in c["fix"]


def test_status_text_shows_the_saved_session(isolated, fakes, write_config, capsys):
    write_config(BW_YML)
    main(["vault", "status"])
    assert "saved session: none (every run asks)" in capsys.readouterr().out


@pytest.mark.skipif(WINDOWS, reason="a mode; Windows checks the ACL")
def test_status_says_a_saved_session_is_ignored_and_why(isolated, fakes, write_config, capsys):
    write_config(BW_YML)
    session_path().parent.mkdir(parents=True, exist_ok=True)
    session_path().write_text("fake-session-key\n")
    session_path().chmod(0o644)
    c = bw_check(capsys, "vault", "status")
    assert c["saved_session"] == "ignored" and "readable by others" in c["message"] and c["level"] == "warn"


def test_serve_never_reads_the_saved_session(isolated, fakes, write_config, monkeypatch, tmp_path):
    """The app's box.check (serve) says nothing about it: serve never reads the bw-session file (decision Q203)."""
    from roster import health
    from roster.config import load_config
    cfg = load_config(write_config(BW_YML))
    providers.setup_providers(cfg)
    session_path().parent.mkdir(parents=True, exist_ok=True)
    session_path().write_text("fake-session-key\n")
    session_path().chmod(0o600)
    monkeypatch.setenv("FAKE_BW_ENV_LOG", str(tmp_path / "env.log"))
    monkeypatch.setattr(providers, "MANUAL_UNLOCK", True)
    c = next(c for c in health.vault(cfg) if c["message"].startswith("bw ("))
    assert "saved_session" not in c and "saved session" not in c["message"]
    assert all("BW_SESSION" not in json.loads(x) for x in (tmp_path / "env.log").read_text().splitlines())
