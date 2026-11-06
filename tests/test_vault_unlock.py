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
from roster.context import WINDOWS, user_config_dir
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
    """A person at a terminal: the master password for each hidden prompt, ANSWER (a line) for the y/N question,
    which is asked on the controlling terminal (providers.open_tty), as getpass asks. SHOWN: what that terminal
    showed. ON_ASK: run when the question is asked (another run doing something meanwhile)."""

    def __init__(self, monkeypatch, answer="\n", on_ask=None, tty=True):
        import contextlib
        import getpass
        import io
        self.passwords = 0
        self.shown = ""
        stdin = io.StringIO("")
        stdin.isatty = lambda: True
        monkeypatch.setattr(sys, "stdin", stdin)
        term = self

        class Tty:
            def write(self, text):
                term.shown += text

            def readline(self):
                if on_ask:
                    on_ask()
                return answer

        @contextlib.contextmanager
        def open_tty():
            yield Tty() if tty else None
        monkeypatch.setattr(providers, "open_tty", open_tty)

        def ask(prompt=""):
            self.passwords += 1
            return "hunter2"
        monkeypatch.setattr(getpass, "getpass", ask)


def next_run():
    """What a new roster process starts with: no secret, no session key, no provider state."""
    providers.reset()


def session_path():
    return user_config_dir() / "bw-session"


def test_no_saved_session_prompts_offers_and_says_this_run_only_on_no(isolated, fakes, monkeypatch, capsys):
    term = Terminal(monkeypatch, "\n")
    assert get_secret("bw:Network gear", "g") == "pw-netops"
    err = capsys.readouterr().err
    assert term.passwords == 1
    assert OFFER in term.shown and OFFER not in err       # on the terminal, as the password prompt (LOW-1)
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
    assert term.shown.count(OFFER) == 1                   # a working saved session: nothing asked


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
    term = Terminal(monkeypatch, "\n")
    get_secret("bw:Network gear", "g")
    providers.lock("bw")                                 # locked again in the same run: asks the password again
    get_secret("bw:Orion servers", "g")
    assert term.passwords == 2
    assert term.shown.count(OFFER) == 1


def test_no_controlling_terminal_never_asks(isolated, fakes, monkeypatch, capsys):
    """LOW-1: stdin is a terminal but there's no controlling one to ask on (open_tty: None): not asked, not saved;
    the note still says why the next run asks."""
    term = Terminal(monkeypatch, "y\n", tty=False)
    assert get_secret("bw:Network gear", "g") == "pw-netops"
    assert OFFER not in term.shown + capsys.readouterr().err
    assert not session_path().exists()


def test_no_terminal_never_asks(isolated, fakes, monkeypatch, capsys):
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    assert get_secret("bw:Network gear", "g") == "pw-netops"
    err = capsys.readouterr().err
    assert OFFER not in err and "note:" not in err
    assert not session_path().exists()


def test_bw_password_in_a_terminal_never_asks(isolated, fakes, monkeypatch, capsys):
    term = Terminal(monkeypatch, "y\n")
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    get_secret("bw:Network gear", "g")
    err = capsys.readouterr().err
    assert OFFER not in term.shown and "note:" not in err
    assert not session_path().exists()


def test_json_output_has_no_note_or_question(isolated, fakes, monkeypatch, capsys):
    term = Terminal(monkeypatch, "y\n")
    providers.set_json_output(True)
    get_secret("bw:Network gear", "g")
    err = capsys.readouterr().err
    assert OFFER not in term.shown and "note:" not in err
    assert not session_path().exists()


def test_serve_never_asks(isolated, fakes, monkeypatch, capsys):
    term = Terminal(monkeypatch, "y\n")
    providers.only_unlock_unlocks()
    providers.unlock("bw", "hunter2")
    get_secret("bw:Network gear", "g")
    assert OFFER not in term.shown
    assert not session_path().exists()


# ---- through the CLI


BW_YML = "groups:\n  lab: {user: ops, auth: 'bw:Network gear', hosts: {esx-02: 10.0.0.5}}\n"


def test_a_json_command_in_a_terminal_has_no_note_or_question(isolated, fakes, write_config, monkeypatch, capsys):
    write_config(BW_YML)
    term = Terminal(monkeypatch, "y\n")
    assert main(["check", "--auth", "--json"]) == 0
    err = capsys.readouterr().err
    assert OFFER not in term.shown and "note:" not in err
    assert not session_path().exists()
    assert providers.json_output() is False              # only for that command


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
    providers.only_unlock_unlocks()                           # the app's serve
    providers.unlock("bw", "hunter2")                         # a new unlock already breaks it...
    providers.lock("bw")                                      # ...and so does the lock
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
    providers.only_unlock_unlocks()
    c = next(c for c in health.vault(cfg) if c["message"].startswith("bw ("))
    assert "saved_session" not in c and "saved session" not in c["message"]
    assert all("BW_SESSION" not in json.loads(x) for x in (tmp_path / "env.log").read_text().splitlines())


def test_vault_unlock_saves_a_working_shell_session_instead_of_unlocking_again(one_unlock, fakes, monkeypatch,
                                                                               capsys):
    """#480 review, LOW-2: a new `bw unlock` would lock the shell's BW_SESSION (and the app: bw keeps one unlock), so
    a working one is saved as it is, with no password asked."""
    _, key = bw_call("unlock", "--raw", "--passwordenv", "PW")
    monkeypatch.setenv("BW_SESSION", key)
    term = Terminal(monkeypatch)
    assert main(["vault", "unlock"]) == 0
    out = capsys.readouterr().out
    assert term.passwords == 0
    assert session_path().read_text() == key + "\n"
    assert bw_status(key) == "unlocked"
    assert "BW_SESSION" in out and key not in out


def test_vault_unlock_with_a_stale_shell_session_unlocks(one_unlock, fakes, monkeypatch, capsys):
    monkeypatch.setenv("BW_SESSION", "stale-key")
    term = Terminal(monkeypatch)
    assert main(["vault", "unlock"]) == 0
    assert term.passwords == 1
    assert session_path().read_text() == "fake-session-key-1\n"


# ---- #480 review, LOW-3: the folder the session file is in is checked too (Linux and macOS: Windows has its ACL)

posix_only = pytest.mark.skipif(WINDOWS, reason="modes and uids; Windows keeps %APPDATA% private with its ACL")


@posix_only
def test_vault_unlock_refuses_a_folder_others_may_write_to(isolated, fakes, monkeypatch, capsys):
    session_path().parent.mkdir(parents=True, exist_ok=True)
    session_path().parent.chmod(0o777)
    term = Terminal(monkeypatch)
    with pytest.raises(SystemExit, match=r"\[202\] .*writable by others") as e:
        main(["vault", "unlock"])
    assert term.passwords == 0 and not session_path().exists()
    assert "fix its permissions: chmod go-w" in str(e.value) and "remove it" not in str(e.value)   # it may hold init.lua


@posix_only
def test_vault_unlock_refuses_a_link_to_a_shared_folder(isolated, fakes, monkeypatch, capsys, tmp_path):
    shared = tmp_path / "shared"
    shared.mkdir()
    shared.chmod(0o777)
    session_path().parent.parent.mkdir(parents=True, exist_ok=True)
    session_path().parent.symlink_to(shared)
    Terminal(monkeypatch)
    with pytest.raises(SystemExit, match=r"\[202\] .*writable by others"):
        main(["vault", "unlock"])
    assert not (shared / "bw-session").exists()


@posix_only
def test_vault_unlock_refuses_a_folder_someone_else_owns(isolated, fakes, monkeypatch, capsys):
    session_path().parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(os, "getuid", lambda: os.stat(session_path().parent).st_uid + 1)
    Terminal(monkeypatch)
    with pytest.raises(SystemExit, match=r"\[202\] .*isn't yours"):
        main(["vault", "unlock"])


@posix_only
def test_a_session_file_in_a_folder_others_may_write_to_is_ignored(isolated, fakes, capsys):
    session_path().parent.mkdir(parents=True, exist_ok=True)
    session_path().write_text("fake-session-key\n")
    session_path().chmod(0o600)
    session_path().parent.chmod(0o777)
    with pytest.raises(providers.SecretError, match="locked"):
        get_secret("bw:Network gear", "g")
    assert "writable by others" in capsys.readouterr().out
    assert bitwarden.saved_session(providers.Ctx("bw", None))[0] == "ignored"


@posix_only
def test_a_link_you_own_to_your_own_folder_is_fine(isolated, fakes, monkeypatch, capsys, tmp_path):
    mine = tmp_path / "mine"
    mine.mkdir(mode=0o700)
    session_path().parent.parent.mkdir(parents=True, exist_ok=True)
    session_path().parent.symlink_to(mine)
    Terminal(monkeypatch)
    assert main(["vault", "unlock"]) == 0
    assert (mine / "bw-session").read_text() == "fake-session-key\n"


def test_the_offer_saves_nothing_when_another_unlock_replaced_this_one(one_unlock, fakes, monkeypatch, capsys):
    """#480 review, LOW-4: another run unlocked while the question waited (bw keeps one unlock), so this run's key no
    longer works: it isn't saved over the other run's, and the note says why."""
    Terminal(monkeypatch, "y\n", on_ask=lambda: bw_call("unlock", "--raw", "--passwordenv", "PW"))
    with pytest.raises(providers.SecretError, match="locked"):     # this run's key is dead too: bw's one unlock
        get_secret("bw:Network gear", "g")
    assert not session_path().exists()
    assert "note: not saved: this unlock was replaced" in capsys.readouterr().err


# ---- #480 review, NITs

def _saved(text="fake-session-key\n"):
    session_path().parent.mkdir(parents=True, exist_ok=True)
    session_path().write_text(text)
    session_path().chmod(0o600)


@pytest.mark.parametrize("env", [{"FAKE_BW_STATUS_FAIL": "Something broke."}, {"FAKE_BW_STATUS_RAW": "[1, 2]"},
                                 {"FAKE_BW_STATUS_RAW": "not json"}], ids=["fails", "not-an-object", "not-json"])
def test_a_saved_session_bw_cant_report_on_is_unknown_not_expired(isolated, fakes, monkeypatch, env):
    _saved()
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    assert bitwarden.saved_session(providers.Ctx("bw", None)) == ("unknown", "bw status failed")


def test_status_shows_an_unknown_saved_session(isolated, fakes, write_config, monkeypatch, capsys):
    from roster import health
    _saved()
    monkeypatch.setenv("FAKE_BW_STATUS_FAIL", "Something broke.")
    c = health.session_check("bw", "1 Login", "", "locked", *bitwarden.saved_session(providers.Ctx("bw", None)))
    assert c["saved_session"] == "unknown" and c["level"] == "warn"
    assert "saved session: unknown (bw status failed)" in c["message"]


def test_vault_lock_says_bw_locked_even_when_the_file_cant_be_removed(isolated, fakes, capsys):
    session_path().mkdir(parents=True)                   # a folder where the file goes: unlink fails
    with pytest.raises(SystemExit, match=r"\[204\] couldn't remove"):
        main(["vault", "lock"])
    assert "bw lock: locked" in capsys.readouterr().out


def test_vault_lock_removes_the_file_when_bw_lock_fails(isolated, fakes, monkeypatch, capsys):
    _saved()
    monkeypatch.setenv("FAKE_BW_LOCK_FAIL", "Something broke.")
    with pytest.raises(SystemExit, match="bw lock.*failed"):
        main(["vault", "lock"])
    assert not session_path().exists()
    assert f"removed {session_path()}" in capsys.readouterr().out


def test_vault_lock_removes_the_file_when_bw_isnt_installed(isolated, monkeypatch, capsys, tmp_path):
    empty = tmp_path / "no-bw"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))               # no bw at all, the real one neither
    _saved()
    with pytest.raises(SystemExit, match="isn't installed"):
        main(["vault", "lock"])
    assert not session_path().exists()
    assert f"removed {session_path()}" in capsys.readouterr().out


# ---- T248 (#486; #480's second review, LOW-5): every folder above the session file, from $HOME down, is checked
# too, and the file is made, read back and renamed through one open handle on its folder, so a folder swapped after
# the check can't take the key elsewhere (Linux and macOS)

@posix_only
def test_vault_unlock_refuses_a_link_to_your_folder_inside_a_shared_one(isolated, fakes, monkeypatch, capsys,
                                                                        tmp_path):
    """Anyone who may write to the 777 folder could rename `roster` away and put a folder of theirs there."""
    shared = tmp_path / "shared"
    shared.mkdir()
    shared.chmod(0o777)
    (shared / "roster").mkdir(mode=0o700)
    session_path().parent.parent.mkdir(parents=True, exist_ok=True)
    session_path().parent.symlink_to(shared / "roster")
    term = Terminal(monkeypatch)
    with pytest.raises(SystemExit, match=rf"\[202\] {shared} is writable by others"):
        main(["vault", "unlock"])
    assert term.passwords == 0 and not (shared / "roster" / "bw-session").exists()


@posix_only
def test_vault_unlock_refuses_a_dot_config_others_may_write_to(isolated, fakes, monkeypatch, capsys):
    dot_config = session_path().parent.parent
    dot_config.mkdir(parents=True, exist_ok=True)
    dot_config.chmod(0o777)
    term = Terminal(monkeypatch)
    with pytest.raises(SystemExit, match=rf"\[202\] {dot_config} is writable by others - roster won't keep a session "
                                         rf"key in it; fix its permissions: chmod go-w {dot_config}, then run"):
        main(["vault", "unlock"])
    assert term.passwords == 0 and not session_path().exists()


@posix_only
def test_a_session_file_under_a_home_others_may_write_to_is_ignored(isolated, fakes, capsys):
    _saved()
    home = session_path().parent.parent.parent
    home.chmod(0o777)
    try:
        with pytest.raises(providers.SecretError, match="locked"):
            get_secret("bw:Network gear", "g")
        assert f"warning      {home} is writable by others (fix its permissions: chmod go-w {home}) - ignored" in (
            capsys.readouterr().out)
        assert bitwarden.saved_session(providers.Ctx("bw", None))[0] == "ignored"
    finally:
        home.chmod(0o755)


@posix_only
def test_a_link_to_your_folder_in_a_sticky_shared_one_is_fine(isolated, fakes, monkeypatch, capsys, tmp_path):
    """As /tmp: anyone may add to a sticky folder, but only an entry's owner may rename or remove it."""
    shared = tmp_path / "sticky"
    shared.mkdir()
    shared.chmod(0o1777)
    (shared / "roster").mkdir(mode=0o700)
    session_path().parent.parent.mkdir(parents=True, exist_ok=True)
    session_path().parent.symlink_to(shared / "roster")
    Terminal(monkeypatch)
    assert main(["vault", "unlock"]) == 0
    assert (shared / "roster" / "bw-session").read_text() == "fake-session-key\n"


@posix_only
def test_a_folder_swapped_after_it_was_checked_never_gets_the_key(isolated, fakes, monkeypatch, capsys, tmp_path):
    """#480's second review's race: the folder renamed away and a link to a 777 folder put in its place right after
    the check. The key is written through the folder that was checked, so it ends up there, never in the 777 one."""
    d = session_path().parent
    d.mkdir(parents=True, mode=0o700)
    shared = tmp_path / "shared"
    shared.mkdir()
    shared.chmod(0o777)
    real = bitwarden.open_session_dir

    def open_then_swap(create=False):
        fd = real(create)
        if d.is_dir() and not d.is_symlink():                # what a writer to ~/.config could do in the gap
            d.rename(tmp_path / "orig")
            d.symlink_to(shared)
        return fd
    monkeypatch.setattr(bitwarden, "open_session_dir", open_then_swap)
    bitwarden.save_session_file("abc123")
    assert not (shared / "bw-session").exists()
    assert (tmp_path / "orig" / "bw-session").read_text() == "abc123\n"


def test_a_terminal_error_while_asking_counts_as_no(isolated, fakes, monkeypatch, capsys):
    """#486 item 3: the terminal hung up while the question waited (EIO): No, never a traceback."""
    def hung_up():
        raise OSError(5, "Input/output error")
    term = Terminal(monkeypatch, "y\n", on_ask=hung_up)
    assert get_secret("bw:Network gear", "g") == "pw-netops"
    assert OFFER in term.shown and not session_path().exists()
    assert "this unlock lasts for this run only" in capsys.readouterr().err


@pytest.mark.parametrize("raw", ["[1]", '"locked"', "null"])
def test_check_box_with_a_bw_status_that_isnt_an_object_says_so(isolated, fakes, write_config, monkeypatch, capsys,
                                                                raw):
    """#486 item 4: valid JSON that isn't a status object gets the error output that isn't JSON at all already got,
    never an AttributeError (a traceback)."""
    write_config(BW_YML)
    monkeypatch.setenv("FAKE_BW_STATUS_RAW", raw)
    c = bw_check(capsys, "check", "--box")
    assert c["level"] == "error" and c["message"].endswith(": couldn't read `bw status` output")


# ---- T250 (#492; #488's review NITs)

@posix_only
def test_vault_unlock_refuses_your_own_link_to_dot_in_a_shared_folder(isolated, fakes, monkeypatch, capsys):
    """NIT-1: `~/.config/roster -> .` makes ~/.config the folder the key goes in, so it's checked as that folder: a
    sticky 1777 ~/.config is fine on the way down, never as the last folder."""
    dot_config = session_path().parent.parent
    dot_config.mkdir(parents=True, exist_ok=True)
    session_path().parent.symlink_to(".")
    dot_config.chmod(0o1777)
    term = Terminal(monkeypatch)
    try:
        with pytest.raises(SystemExit, match=rf"\[202\] {dot_config} is writable by others"):
            main(["vault", "unlock"])
    finally:
        dot_config.chmod(0o755)
    assert term.passwords == 0 and not (dot_config / "bw-session").exists()


@posix_only
def test_your_own_link_to_dot_in_a_private_folder_is_fine(isolated, fakes, monkeypatch, capsys):
    dot_config = session_path().parent.parent
    dot_config.mkdir(parents=True, exist_ok=True)
    dot_config.chmod(0o700)
    session_path().parent.symlink_to(".")
    Terminal(monkeypatch)
    assert main(["vault", "unlock"]) == 0
    assert (dot_config / "bw-session").read_text() == "fake-session-key\n"


@posix_only
def test_vault_lock_removes_the_file_in_the_folder_it_opened(isolated, fakes, monkeypatch, capsys, tmp_path):
    """NIT-2: the file is removed through the open folder handle, as it was saved: a folder swapped after it was
    opened loses nothing of its own."""
    _saved()
    d = session_path().parent
    other = tmp_path / "other"
    other.mkdir(mode=0o700)
    (other / "bw-session").write_text("not yours to remove\n")
    fd = bitwarden.open_session_dir()                    # opened, then swapped before the unlink
    d.rename(tmp_path / "orig")
    d.symlink_to(other)
    monkeypatch.setattr(bitwarden, "open_session_dir", lambda create=False: fd)
    assert bitwarden.remove_session_file() is True
    assert not (tmp_path / "orig" / "bw-session").exists()
    assert (other / "bw-session").read_text() == "not yours to remove\n"


@posix_only
def test_vault_lock_removes_the_file_in_a_folder_it_wont_save_in(isolated, fakes, capsys):
    """A lock still removes the key from a folder roster refuses to keep one in."""
    _saved()
    session_path().parent.chmod(0o777)
    assert main(["vault", "lock"]) == 0
    assert not session_path().exists()
