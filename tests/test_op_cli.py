"""`roster vault op` (T223, #432, decision Q197): the 1Password CLI with op's sign-in in its environment only,
read-only unless --write, a fail-closed allowlist of op's commands (as `roster vault bw`, Q178). Never the real op:
the stand-in in tests/fakes/op."""
import json

import pytest

from roster.cli import main

SECRET = "c2VjcmV0LXB3LXh5enp5"  # stands in for a password or a token typed among op's arguments


@pytest.fixture
def op(isolated, fakes, monkeypatch, tmp_path):
    """Signed in (the shell's OP_SESSION_*), every op call's argv logged; returns the calls so far."""
    monkeypatch.setenv("OP_SESSION_test", "tok")
    log = tmp_path / "argv.log"
    monkeypatch.setenv("FAKE_ARGV_LOG", str(log))
    return lambda: [json.loads(x)[1:] for x in log.read_text().splitlines()] if log.exists() else []


def test_a_read_only_command_runs_with_ops_sign_in_and_no_bitwarden_variable(op, monkeypatch, tmp_path):
    env_log = tmp_path / "env.log"
    monkeypatch.setenv("FAKE_OP_ENV_LOG", str(env_log))
    monkeypatch.setenv("BW_SESSION", "bw-session-xyzzy")       # a Bitwarden session never goes to op
    monkeypatch.setenv("bw_clientsecret", "bw-secret-xyzzy")
    assert main(["vault", "op", "--", "whoami"]) == 0
    assert op() == [["whoami"]]
    names = [n.upper() for n in json.loads(env_log.read_text())]          # Windows upper-cases env names
    assert "OP_SESSION_TEST" in names and not any(n.startswith("BW_") for n in names)


def refused(*argv):
    with pytest.raises(SystemExit) as e:
        main(["vault", "op", *argv])
    return str(e.value.code)


@pytest.mark.parametrize("argv", [["item", "create", "--category", "login", f"password={SECRET}"],
                                  ["item", "edit", "esx-02", f"password={SECRET}"], ["item", "delete", "esx-02"],
                                  ["item", "share", "esx-02", "--emails", "you@example.com"],
                                  ["vault", "user", "grant", "--vault", "Infra", "--user", "you@example.com"],
                                  ["document", "create", "notes.txt"], ["update"]])
def test_a_command_that_changes_the_vault_or_writes_a_file_needs_write(op, argv):
    msg = refused(*argv)
    assert "[196]" in msg and "--write" in msg and SECRET not in msg and op() == []


@pytest.mark.parametrize("cmd", [["signin"], ["signout"], ["account", "add"], ["account", "forget"]])
def test_account_commands_need_write_too(op, cmd):
    msg = refused(*cmd, SECRET)
    assert "[196]" in msg and f"op {' '.join(cmd)}" in msg and SECRET not in msg and op() == []


@pytest.mark.parametrize("argv", [["--write", "item", "edit", "esx-02", f"password={SECRET}"],
                                  ["--write", "--", "item", "delete", "esx-02"], ["--write", "signin"]])
def test_write_lets_them_run(op, argv):
    main(["vault", "op", *argv])
    assert op() == [[a for a in argv if a not in ("--write", "--")]]


@pytest.mark.parametrize("argv", [["item", "get", "esx-02", "--vault", "Infra", "--format", "json"],
                                  ["item", "list", "--account", "team", "--categories", "Login"],
                                  ["--no-color", "vault", "list"], ["read", "op://Infra/esx-02/username"],
                                  ["item", "template", "list"], ["--help"], ["item"], ["item", "--help"]])
def test_read_only_commands_and_ops_options_after_them_run_as_given(op, argv):
    main(["vault", "op", "--", *argv])
    assert op() == [argv]


@pytest.mark.parametrize("argv", [[SECRET], ["item", SECRET], ["ITEM", "get", "x"], ["item", "ls"], ["environment"],
                                  ["item", "--vault", "Infra", "delete", "esx-02"],     # op could take `delete`
                                  ["vault", "user", "--user", "x", "grant"], ["item", "template", "--x", "get"]])
def test_an_unknown_command_or_an_option_inside_one_is_refused_and_not_repeated(op, argv):
    msg = refused(*argv)
    assert "[197]" in msg and SECRET not in msg and op() == []


@pytest.mark.parametrize("argv", [["--account", "team", "item", "list"], [f"--password={SECRET}", "whoami"],
                                  ["--format", "json", "whoami"], ["-x", "whoami"]])
def test_an_option_before_the_command_that_isnt_a_valueless_one_of_ops_is_refused(op, capfd, argv):
    with pytest.raises(SystemExit) as e:
        main(["vault", "op", *argv])
    out = capfd.readouterr()
    assert "[197]" in str(e.value.code) and SECRET not in str(e.value.code) + out.out + out.err and op() == []


@pytest.mark.parametrize("argv", [["whoami", "--session", SECRET], [f"--session={SECRET}", "whoami"],
                                  ["item", "get", "x", f"--session={SECRET}"], ["--write", "item", "get", "x",
                                                                                 "--config", "/tmp/elsewhere"],
                                  ["vault", "list", "--config=/tmp/elsewhere"],
                                  ["--write", "run", "--", "env"], ["--write", "plugin", "run", "--", "gh", "pr"]])
def test_session_config_and_run_are_refused_even_with_write(op, argv):
    msg = refused(*argv)
    assert "[198]" in msg and SECRET not in msg and op() == []


@pytest.mark.parametrize("argv", [["read", "op://Infra/esx-02/password", "--out-file", "/tmp/x"],
                                  ["read", "op://Infra/esx-02/password", "--out-file=/tmp/x"],
                                  ["read", "op://Infra/esx-02/password", "-o", "/tmp/x"],
                                  ["read", "op://Infra/esx-02/password", "-o/tmp/x"],
                                  ["read", "op://Infra/esx-02/password", "-fo", "/tmp/x"],
                                  ["inject", "-i", "tpl", "-o", "out.env"],
                                  ["document", "get", "notes", "--out-file", SECRET],
                                  ["item", "template", "get", "Login", "-o", "login.json"]])
def test_writing_a_local_file_needs_write(op, argv):
    msg = refused(*argv)
    assert "[196]" in msg and "writes a file" in msg and SECRET not in msg and op() == []


def test_write_lets_an_out_file_run(op):
    main(["vault", "op", "--write", "--", "read", "op://Infra/esx-02/username", "-o", "u.txt"])
    assert op() == [["read", "op://Infra/esx-02/username", "-o", "u.txt"]]


def test_write_after_ops_command_is_refused(op):
    msg = refused("item", "edit", "esx-02", SECRET, "--write")
    assert "[197]" in msg and "before" in msg and SECRET not in msg and op() == []


def test_write_alone_still_needs_op_arguments(op):
    with pytest.raises(SystemExit, match="usage: roster vault op"):
        main(["vault", "op", "--write"])


@pytest.mark.parametrize("argv", [[f"--write={SECRET}", "whoami"], [f"-h{SECRET}"]])
def test_a_value_on_roster_ops_own_options_is_not_repeated(op, capfd, argv):
    with pytest.raises(SystemExit):
        main(["vault", "op", *argv])
    out = capfd.readouterr()
    assert SECRET not in out.out + out.err and op() == []


def test_no_op_installed_says_so(isolated, monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(SystemExit, match="1Password CLI"):
        main(["vault", "op", "--", "whoami"])


# security review of #456

@pytest.mark.parametrize("argv", [["item get", "esx-02"], ["item delete", "esx-02"], ["item", "delete x"],
                                  ["item", "get\tx"], ["vault", "user grant"]])
def test_a_command_word_with_a_space_or_other_character_is_refused(op, argv):
    assert "[197]" in refused(*argv) and op() == []


def test_an_argument_with_a_space_after_the_command_is_fine(op):
    main(["vault", "op", "--", "item", "get", "esx-02 ssh", "--vault", "Infra"])
    assert op() == [["item", "get", "esx-02 ssh", "--vault", "Infra"]]


@pytest.mark.parametrize("argv", [["read", "op://Infra/esx-02/password", "-no", "/tmp/x"],
                                  ["read", "op://Infra/esx-02/password", "-oPATH"],
                                  ["document", "get", "notes", "--out-file=/tmp/x"],
                                  ["inject", "-i", "tpl", "--out-file=out.env"],
                                  ["item", "template", "get", "Login", "--out-file=login.json"]])
def test_more_forms_of_writing_a_file_need_write(op, argv):
    assert "[196]" in refused(*argv) and op() == []


def test_help_before_a_write_command_still_needs_write_and_op_help_doesnt(op):
    assert "[196]" in refused("--", "--help", "item", "delete") and op() == []
    main(["vault", "op", "--", "-h", "help", "item", "delete"])
    assert op() == [["-h", "help", "item", "delete"]]
