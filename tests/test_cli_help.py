"""`roster --help`, `roster COMMAND --help` and usage errors (roster.clihelp)."""

import shlex

import pytest

from roster import clihelp
from roster.cli import build_parser, main
from roster.manpage import subcommands

COMMANDS = list(subcommands(build_parser()))


def test_every_command_is_in_exactly_one_group():
    grouped = [n for _, names in clihelp.GROUPS for n in names]
    assert sorted(grouped) == sorted(COMMANDS)


@pytest.mark.parametrize("name", COMMANDS)
def test_every_command_has_examples_or_says_why_not(name):
    assert clihelp.EXAMPLES.get(name) or name in clihelp.NOTES


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
    assert "invalid choice: 'hots' - did you mean `hosts`?" in err
    assert "choose from" not in err and "(`roster --help` shows how)" in err


def test_a_word_far_from_any_command(capsys):
    with pytest.raises(SystemExit):
        main(["xyzzy"])
    assert "invalid choice: 'xyzzy' - not a roster command" in capsys.readouterr().err


def test_a_mistyped_option_gets_the_nearest_one(capsys):
    with pytest.raises(SystemExit):
        main(["hosts", "--jsn"])
    assert "unrecognized arguments: --jsn - did you mean `--json`?" in capsys.readouterr().err


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
    assert '"message": "roster: argument COMMAND: invalid choice: \'hots\' - did you mean `hosts`?"' in err


def test_invalid_choice_serve_stays_word_for_word():
    """The app tells a roster from before `serve` by "invalid choice: 'serve'" on stderr (backend.rs)."""
    msg = clihelp.suggest("argument cmd: invalid choice: 'serve' (choose from init, setup, hosts)")
    assert "invalid choice: 'serve'" in msg
