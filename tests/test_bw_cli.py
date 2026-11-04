"""`roster bw`: bw with this Box's session, read-only unless --write, a fail-closed allowlist (T202, #387, Q178)."""
import json

import pytest

from roster.cli import main
from roster.common import user_config_dir

SECRET = "c2VjcmV0LXB3LXh5enp5"  # stands in for a password or an item's base64 JSON in bw's arguments


@pytest.fixture
def bw(isolated, fakes, monkeypatch, tmp_path):
    """The session file in place and every bw call's argv logged; returns the calls so far."""
    f = user_config_dir() / "bw-session"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text("fake-session-key\n")
    f.chmod(0o600)
    log = tmp_path / "argv.log"
    monkeypatch.setenv("FAKE_ARGV_LOG", str(log))
    return lambda: [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []


def refused(*argv):
    with pytest.raises(SystemExit) as e:
        main(["bw", *argv])
    return str(e.value.code)


def test_a_vault_changing_command_needs_write(bw):
    msg = refused("create", "item", SECRET)
    assert "[164]" in msg and "create" in msg and "--write" in msg and SECRET not in msg
    assert bw() == []


def test_a_read_only_command_runs_with_the_session_in_its_env_only(bw, capfd, monkeypatch, tmp_path):
    env_log = tmp_path / "env.log"
    monkeypatch.setenv("FAKE_BW_ENV_LOG", str(env_log))
    monkeypatch.setenv("OP_SESSION_team", "op-session-xyzzy")   # a 1Password sign-in never goes to bw (#388)
    assert main(["bw", "list", "items", "--search", "Orion"]) == 0
    assert "Orion servers" in capfd.readouterr().out             # bw wrote to the terminal itself
    (argv,) = bw()
    assert argv == ["list", "items", "--search", "Orion", "--nointeraction"]
    assert not any("fake-session-key" in a for a in argv)
    names = json.loads(env_log.read_text())
    assert "BW_SESSION" in names and not any(n.upper().startswith("OP_SESSION_") for n in names)


@pytest.mark.parametrize("argv", [["--write", "edit", "item", "11111111-aaaa", SECRET],
                                  ["--write", "--", "delete", "item", "11111111-aaaa"],
                                  ["--write", "export", "--format", "json"]])
def test_write_lets_a_vault_changing_command_run(bw, argv):
    main(["bw", *argv])
    assert bw() == [[a for a in argv if a not in ("--write", "--")] + ["--nointeraction"]]


@pytest.mark.parametrize("cmd", ["login", "logout", "unlock", "lock", "config"])
def test_account_commands_need_write_too(bw, cmd):
    msg = refused(cmd, SECRET)
    assert "[164]" in msg and f"bw {cmd}" in msg and SECRET not in msg and bw() == []


@pytest.mark.parametrize("cmd", ["login", "unlock"])
def test_login_and_unlock_may_ask_for_the_master_password(bw, cmd, monkeypatch):
    monkeypatch.setattr("sys.stdin", open(__file__))   # no terminal: the fake's prompt gets a line and gives up
    main(["bw", "--write", cmd])
    assert bw() == [[cmd]]


def test_lock_runs_non_interactively(bw):
    assert main(["bw", "--write", "lock"]) == 0 and bw() == [["lock", "--nointeraction"]]


def test_an_unknown_command_is_refused_and_not_repeated(bw):
    msg = refused("hunter2-xyzzy", "item")
    assert "[165]" in msg and "hunter2-xyzzy" not in msg and bw() == []


@pytest.mark.parametrize("argv", [["--", "--pretty", "list", "items"], ["--", "--raw", "--quiet", "status"],
                                  ["--", "--help"], ["--", "--version"], ["help", "edit"], ["generate", "-ulns"]])
def test_bw_options_before_a_read_only_command_run(bw, argv):
    main(["bw", *argv])
    assert len(bw()) == 1


@pytest.mark.parametrize("argv", [["--", "--weird", "list"], ["--", "-x", SECRET, "list"], ["--", f"-{SECRET}"]])
def test_an_unknown_option_before_the_command_is_refused_and_not_repeated(bw, argv):
    msg = refused(*argv)
    assert "[165]" in msg and SECRET not in msg and "weird" not in msg and bw() == []


def test_help_before_a_write_command_still_needs_write(bw):
    assert "[164]" in refused("--", "--help", "edit") and bw() == []


@pytest.mark.parametrize("argv", [["--", "--session", SECRET, "list"], ["list", "items", f"--session={SECRET}"],
                                  ["--write", "edit", "item", "x", "--session", SECRET]])
def test_a_session_on_the_command_line_is_refused_and_not_repeated(bw, argv):
    msg = refused(*argv)
    assert "[166]" in msg and SECRET not in msg and bw() == []


def test_bw_serve_is_refused_even_with_write(bw):
    assert "[166]" in refused("--write", "serve", "--port", "8087") and bw() == []


def test_write_after_bws_command_is_refused(bw):
    msg = refused("edit", "item", SECRET, "--write")
    assert "[165]" in msg and "before" in msg and SECRET not in msg and bw() == []


def test_write_alone_still_needs_bw_arguments(bw):
    with pytest.raises(SystemExit, match="usage: roster bw"):
        main(["bw", "--write"])


def test_a_batch_file_bw_is_refused_cmd_specials_without_repeating_them(bw, monkeypatch):
    import roster.common as common
    monkeypatch.setattr(common, "WINDOWS", True)
    monkeypatch.setattr(common.shutil, "which", lambda name: r"C:\npm\bw.cmd")
    msg = refused("get", "password", "a&b" + SECRET)
    assert "bw.cmd is a batch file" in msg and SECRET not in msg and bw() == []
