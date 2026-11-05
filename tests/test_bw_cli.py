"""`roster vault bw` (was `roster vault bw`): bw with this Box's session, read-only unless --write, a fail-closed allowlist (T202, #387, Q178)."""
import json

import pytest

from roster.cli import main
from roster.common import WINDOWS, user_config_dir

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
        main(["vault", "bw", *argv])
    return str(e.value.code)


def test_a_vault_changing_command_needs_write(bw):
    msg = refused("create", "item", SECRET)
    assert "[164]" in msg and "create" in msg and "--write" in msg and SECRET not in msg
    assert bw() == []


def test_a_read_only_command_runs_with_the_session_in_its_env_only(bw, capfd, monkeypatch, tmp_path):
    env_log = tmp_path / "env.log"
    monkeypatch.setenv("FAKE_BW_ENV_LOG", str(env_log))
    monkeypatch.setenv("OP_SESSION_team", "op-session-xyzzy")   # a 1Password sign-in never goes to bw (#388)
    assert main(["vault", "bw", "list", "items", "--search", "Orion"]) == 0
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
    main(["vault", "bw", *argv])
    assert bw() == [[a for a in argv if a not in ("--write", "--")] + ["--nointeraction"]]


@pytest.mark.parametrize("cmd", ["login", "logout", "unlock", "lock", "config"])
def test_account_commands_need_write_too(bw, cmd):
    msg = refused(cmd, SECRET)
    assert "[164]" in msg and f"bw {cmd}" in msg and SECRET not in msg and bw() == []


@pytest.mark.parametrize("cmd", ["login", "unlock"])
def test_login_and_unlock_may_ask_for_the_master_password(bw, cmd, monkeypatch):
    monkeypatch.setattr("sys.stdin", open(__file__))   # no terminal: the fake's prompt gets a line and gives up
    main(["vault", "bw", "--write", cmd])
    assert bw() == [[cmd]]


def test_lock_runs_non_interactively(bw):
    assert main(["vault", "bw", "--write", "lock"]) == 0 and bw() == [["lock", "--nointeraction"]]


def test_an_unknown_command_is_refused_and_not_repeated(bw):
    msg = refused("hunter2-xyzzy", "item")
    assert "[165]" in msg and "hunter2-xyzzy" not in msg and bw() == []


@pytest.mark.parametrize("argv", [["--", "--pretty", "list", "items"], ["--", "--raw", "--quiet", "status"],
                                  ["--", "--help"], ["--", "--version"], ["help", "edit"], ["generate", "-ulns"]])
def test_bw_options_before_a_read_only_command_run(bw, argv):
    main(["vault", "bw", *argv])
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
    with pytest.raises(SystemExit, match="usage: roster vault bw"):
        main(["vault", "bw", "--write"])


def test_a_batch_file_bw_is_refused_cmd_specials_without_repeating_them(bw, monkeypatch):
    import roster.common as common
    import roster.context as context
    monkeypatch.setattr(context, "WINDOWS", True)
    monkeypatch.setattr(common, "WINDOWS", True)
    monkeypatch.setattr(common, "find_program", lambda name: r"C:\npm\bw.cmd")
    msg = refused("get", "password", "a&b" + SECRET)
    assert "bw.cmd is a batch file" in msg and SECRET not in msg and bw() == []


# security review of #402 (Q178 (i)-(l))

@pytest.mark.parametrize("argv", [["receive", "https://send.example.com/#abc"],
                                  ["receive", "https://send.example.com/#abc", "--output", "/tmp/x"],
                                  ["get", "attachment", "notes.txt", "--itemid", "11111111-aaaa"],
                                  ["get", "item", "11111111-aaaa", "--output", "/tmp/x"],
                                  ["get", "item", "11111111-aaaa", f"--output={SECRET}"],
                                  ["list", "items", "--output", SECRET]])
def test_writing_a_local_file_needs_write(bw, argv):
    msg = refused(*argv)
    assert "[164]" in msg and "--write" in msg and SECRET not in msg and bw() == []


def test_write_lets_receive_and_output_run(bw):
    main(["vault", "bw", "--write", "get", "item", "11111111-aaaa", "--output", "out.json"])
    main(["vault", "bw", "--write", "receive", "https://send.example.com/#abc"])
    assert [a[0] for a in bw()] == ["get", "receive"]


def test_an_unknown_option_before_the_command_is_not_repeated_by_the_parser(bw, capfd):
    with pytest.raises(SystemExit) as e:
        main(["vault", "bw", f"--password={SECRET}", "list", "items"])
    out = capfd.readouterr()
    assert "[165]" in str(e.value.code) and SECRET not in str(e.value.code) + out.out + out.err and bw() == []


def test_bws_options_before_the_command_need_no_double_dash(bw):
    assert main(["vault", "bw", "--raw", "status"]) == 0 and bw() == [["--raw", "status", "--nointeraction"]]


def test_another_command_still_gets_the_parsers_error(isolated, capfd):
    with pytest.raises(SystemExit):
        main(["hosts", "--jsn"])
    assert "unrecognized arguments (not repeated) - did you mean `--json`?" in capfd.readouterr().err


def test_no_1password_variable_reaches_bw(bw, monkeypatch, tmp_path):
    env_log = tmp_path / "env.log"
    monkeypatch.setenv("FAKE_BW_ENV_LOG", str(env_log))
    for name in ("OP_SERVICE_ACCOUNT_TOKEN", "OP_CONNECT_TOKEN", "OP_CONNECT_HOST", "OP_SESSION_team"):
        monkeypatch.setenv(name, "op-credential-xyzzy")
    main(["vault", "bw", "status"])
    assert not any(n.upper().startswith("OP_") for n in json.loads(env_log.read_text()))


@pytest.mark.skipif(WINDOWS, reason="on Windows the session file is in your own %APPDATA% and always used")
def test_no_session_means_no_bw_session_in_bws_env(isolated, fakes, monkeypatch, tmp_path):
    f = user_config_dir() / "bw-session"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text("fake-session-key\n")
    f.chmod(0o644)                                     # others can read it: ignored
    env_log = tmp_path / "env.log"
    monkeypatch.setenv("FAKE_BW_ENV_LOG", str(env_log))
    main(["vault", "bw", "status"])
    assert "BW_SESSION" not in json.loads(env_log.read_text())


def test_nointeraction_goes_before_a_double_dash_in_bws_arguments(bw):
    main(["vault", "bw", "get", "item", "--", "-odd-name"])
    assert bw() == [["get", "item", "--nointeraction", "--", "-odd-name"]]


# second pass of the review (Q178 (m), (n))

@pytest.mark.parametrize("argv", [["get", "ATTACHMENT", "notes.txt", "--itemid", "11111111-aaaa"],
                                  ["get", "Attachment", "notes.txt", "--itemid", "11111111-aaaa"],
                                  ["get", "--itemid", "11111111-aaaa", "attachment", "notes.txt"],
                                  ["get", "--pretty", "attachment", "notes.txt", "--itemid", "11111111-aaaa"]])
def test_get_attachment_needs_write_in_any_case_and_order(bw, argv):
    assert "[164]" in refused(*argv) and bw() == []


@pytest.mark.parametrize("argv", [[f"--write={SECRET}", "list"], [f"-h{SECRET}"]])
def test_a_value_on_roster_bws_own_options_is_not_repeated(bw, capfd, argv):
    with pytest.raises(SystemExit):
        main(["vault", "bw", *argv])
    out = capfd.readouterr()
    assert SECRET not in out.out + out.err and bw() == []
