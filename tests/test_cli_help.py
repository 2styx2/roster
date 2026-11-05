"""`roster --help`, `roster COMMAND --help` and usage errors (roster.clihelp)."""

import shlex

import pytest

from roster import clihelp
from roster.cli import build_parser, main
from roster.manpage import commands, subcommands

COMMANDS = list(subcommands(build_parser()))


def test_every_command_is_in_exactly_one_group_or_internal():
    grouped = [n for _, names in clihelp.GROUPS for n in names] + clihelp.INTERNAL
    assert sorted(grouped) == sorted(COMMANDS)


@pytest.mark.parametrize("name", list(commands(build_parser())))
def test_every_command_has_examples_or_says_why_not(name):
    assert clihelp.EXAMPLES.get(name) or name in clihelp.NOTES


def test_every_example_is_for_a_command_that_exists():
    assert set(clihelp.EXAMPLES) <= set(commands(build_parser()))


EXAMPLES = [cmd for rows in clihelp.EXAMPLES.values() for cmd, _ in rows] + \
           [cmd for cmd, _ in clihelp.COMMON if cmd.startswith("roster ")]


@pytest.mark.parametrize("example", EXAMPLES)
def test_every_example_parses(example):
    words = shlex.split(example)
    assert words[0] == "roster"
    build_parser().parse_args(words[1:])        # exits 2 (fails the test) on anything the parser doesn't take


def test_plain_roster_shows_the_commands_in_groups(capsys):
    assert main([]) == 0
    out = capsys.readouterr().out
    assert out.startswith("usage: roster [-c PATH | --inv NAME] COMMAND [ARGS]")
    for title, names in clihelp.GROUPS:
        assert f"\n{title}:\n" in out
        assert all(f"\n  {n} " in out for n in names)
    assert out.index("Start here:") < out.index("options:")       # the commands before the options
    assert "roster COMMAND --help" in out


@pytest.mark.parametrize("flag", ["-v", "--version"])
def test_dash_v_is_the_version(flag, capsys):
    from roster import __version__
    with pytest.raises(SystemExit) as e:
        main([flag])
    assert e.value.code == 0
    assert capsys.readouterr().out == f"roster {__version__}\n"


def test_help_is_the_same_as_plain_roster(capsys):
    with pytest.raises(SystemExit) as e:
        main(["--help"])
    assert e.value.code == 0
    assert "Every day:" in capsys.readouterr().out


def test_a_command_help_has_a_description_and_examples(capsys):
    with pytest.raises(SystemExit):
        main(["run", "--help"])
    out = capsys.readouterr().out
    assert out.startswith("usage: roster run ")                 # not built from roster's own usage line
    assert "\nRun a command on a host.\n" in out
    assert "examples:\n  # a password-only host" in out
    assert "  roster run switch-01 -- show version" in out


def test_a_mistyped_command_gets_the_nearest_one(capsys):
    with pytest.raises(SystemExit) as e:
        main(["hots"])
    assert e.value.code == 2
    err = capsys.readouterr().err
    assert "argument COMMAND: invalid choice (not repeated) - did you mean `hosts`?" in err
    assert "choose from" not in err and "(`roster --help` shows how)" in err


def test_a_word_far_from_any_command(capsys):
    with pytest.raises(SystemExit):
        main(["xyzzy"])
    assert "invalid choice (not repeated) - not a roster command" in capsys.readouterr().err


def test_a_mistyped_option_gets_the_nearest_one(capsys):
    with pytest.raises(SystemExit):
        main(["hosts", "--jsn"])
    assert "unrecognized arguments (not repeated) - did you mean `--json`?" in capsys.readouterr().err


@pytest.mark.parametrize("argv", [["--json"], ["hosts", "--sudo"]])
def test_a_real_option_in_the_wrong_place_is_not_suggested_back(capsys, argv):
    with pytest.raises(SystemExit):
        main(argv)
    err = capsys.readouterr().err
    assert "did you mean" not in err
    assert "goes after a command that takes it" in err


def test_a_command_error_points_at_its_own_help(capsys):
    with pytest.raises(SystemExit):
        main(["run"])
    err = capsys.readouterr().err
    assert "roster run: error: the following arguments are required: host" in err
    assert "(`roster run --help` shows how)" in err


def test_the_suggestion_reaches_json_errors(capsys):
    with pytest.raises(SystemExit) as e:
        main(["hots", "--json"])
    assert e.value.code == 2
    err = capsys.readouterr().err
    assert '"message": "roster: argument COMMAND: invalid choice (not repeated) - did you mean `hosts`?"' in err


def test_serve_is_a_command_so_the_app_never_takes_this_roster_for_an_old_one():
    """The app tells a roster from before `serve` by argparse's "invalid choice: 'serve'" (backend.rs). That roster
    still prints it; this one has serve, and its own invalid-choice errors no longer repeat the word (T235)."""
    assert "serve" in COMMANDS


# A usage error never repeats a value the user typed (T235, #460): a vault session token typed in the wrong place
# (`roster --session TOKEN vault op -- whoami`) would be echoed to stderr, a terminal's scrollback or a CI log.
# Made-up tokens: one shaped like `bw unlock --raw`'s base64 session key, one like op's base64url session token.
BW_SESSION = "q2Xv0b9ZtM4n1KpYwLe7Rj3sUaGh5CdF8iNoTzBx6QEyWrVmJlPcSgIuHkDf0aZ9e+N/yA2qXw1oLmK7pRtUvB=="
OP_SESSION = "Ex4mple-0nly_n0tAR3al-op_s3ss10nT0k3n-xyzW"
WRONG_PLACES = [
    pytest.param(lambda t: ["--session", t, "vault", "op", "--", "whoami"], id="before-the-command"),
    pytest.param(lambda t: ["--session", t, "vault", "bw", "--", "list", "items"], id="before-the-command-bw"),
    pytest.param(lambda t: ["--session", t, "bw", "--", "list", "items"], id="before-an-old-name"),
    pytest.param(lambda t: [t], id="as-the-command"),
    pytest.param(lambda t: ["vault", "--session", t, "op", "--", "whoami"], id="after-the-command"),
    pytest.param(lambda t: ["mesh", t], id="as-a-command-action"),
    pytest.param(lambda t: ["help", "--completion", t], id="as-an-option-choice"),
    pytest.param(lambda t: ["add", "esx-02", "--port", t], id="as-a-number"),
    pytest.param(lambda t: ["discover", f"--t={t}"], id="on-an-ambiguous-option"),
    pytest.param(lambda t: ["hosts", f"--long={t}"], id="on-a-flag"),
    pytest.param(lambda t: [f"--session={t}", "hosts"], id="extra-before-the-command"),
    pytest.param(lambda t: ["vault", "status", "--session", t], id="extra-after-the-command"),
    pytest.param(lambda t: ["--session", t, "hosts", "--json"], id="json-before-the-command"),
    pytest.param(lambda t: ["hosts", "--json", f"--session={t}"], id="json-extra"),
]


@pytest.mark.parametrize("token", [BW_SESSION, OP_SESSION], ids=["bw", "op"])
@pytest.mark.parametrize("argv", WRONG_PLACES)
def test_a_usage_error_never_repeats_a_value(capsys, argv, token):
    with pytest.raises(SystemExit) as e:
        main(argv(token))
    out = capsys.readouterr()
    assert e.value.code == 2                                        # still a usage error
    assert "error" in out.err
    for shown in (out.out, out.err):
        assert token not in shown and token[:12] not in shown


@pytest.mark.parametrize("value", ["it's", 'say "hi"', "a (choose from b)", "x could match y"])
def test_a_value_with_quotes_or_argparse_words_is_not_repeated_either(capsys, value):
    for argv in (["mesh", value], ["hosts", f"--long={value}"], ["discover", f"--t={value}"], ["add", "x", "--port", value]):
        with pytest.raises(SystemExit):
            main(argv)
        assert value not in capsys.readouterr().err


def test_an_invalid_choice_names_the_position_and_the_choices(capsys):
    with pytest.raises(SystemExit):
        main(["vault", "--session", OP_SESSION, "op"])
    err = capsys.readouterr().err
    assert "argument ACTION: invalid choice (not repeated) - one of: status, sync, reveal, bw, op" in err


def test_a_bad_value_names_its_option(capsys):
    with pytest.raises(SystemExit):
        main(["add", "esx-02", "--port", "twenty-two"])
    assert "argument --port: invalid int value (not repeated)" in capsys.readouterr().err


def test_an_ambiguous_option_names_its_matches(capsys):
    with pytest.raises(SystemExit):
        main(["discover", "--t=5"])
    assert "ambiguous option (not repeated): could match --top-ports, --timeout" in capsys.readouterr().err
