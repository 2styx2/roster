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
GIT_CREDENTIAL = "https://you:Ex4mpleN0tR3alT0ken0000@git.example.com/lab/fleet.git"   # a clone URL with a token
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
    pytest.param(lambda t: ["init", "--inventory", t], id="as-init-inventory"),
    pytest.param(lambda t: ["help", "vault", t], id="as-a-help-topic"),
]


def windows(token, size=8):
    """Every SIZE-character slice of TOKEN: none may show, so a value cut short by a rewrite can't leak either."""
    return {token[i:i + size] for i in range(len(token) - size + 1)}


def assert_not_shown(token, out):
    shown = out.out + out.err
    assert not [w for w in windows(token) if w in shown], shown


@pytest.mark.parametrize("token", [BW_SESSION, OP_SESSION, GIT_CREDENTIAL], ids=["bw", "op", "git-url"])
@pytest.mark.parametrize("argv", WRONG_PLACES)
def test_a_usage_error_never_repeats_a_value(capsys, argv, token):
    with pytest.raises(SystemExit) as e:
        main(argv(token))
    out = capsys.readouterr()
    assert e.value.code == 2                                        # still a usage error
    assert "error" in out.err
    assert_not_shown(token, out)


SECRET = "Ex4mpl3S3cretW0rd"
ARGPARSE_WORDS = ["it's", 'say "hi"', " (choose from b", " could match y", "invalid choice: x", ": invalid int value: y",
                  "\nignored explicit argument z", "unrecognized arguments: w"]


@pytest.mark.parametrize("value", [SECRET + words for words in ARGPARSE_WORDS])
def test_a_value_with_quotes_or_argparse_words_is_not_repeated_either(capsys, value):
    """argparse's own wording inside a value can't make roster keep the part of it before that wording."""
    for argv in (["mesh", value], ["hosts", f"--long={value}"], ["discover", f"--t={value}"],
                 ["add", "x", "--port", value], [f"--session={value}", "hosts"], ["help", "vault", value]):
        with pytest.raises(SystemExit) as e:
            main(argv)
        assert e.value.code == 2
        out = capsys.readouterr()
        assert value not in out.out + out.err
        assert_not_shown(SECRET, out)


def test_an_invalid_choice_names_the_position_and_the_choices(capsys):
    with pytest.raises(SystemExit):
        main(["vault", OP_SESSION, "op"])
    err = capsys.readouterr().err
    assert "argument ACTION: invalid choice (not repeated) - one of: status, sync, unlock, lock, reveal, bw, op" in err


def test_a_bad_value_names_its_option(capsys):
    with pytest.raises(SystemExit):
        main(["add", "esx-02", "--port", "twenty-two"])
    assert "argument --port: invalid int value (not repeated)" in capsys.readouterr().err


def test_an_ambiguous_option_names_its_matches(capsys):
    with pytest.raises(SystemExit):
        main(["discover", "--t=5"])
    assert "ambiguous option (not repeated): could match --top-ports, --timeout" in capsys.readouterr().err


def test_a_session_in_roster_s_place_says_where_a_session_goes(capsys):
    with pytest.raises(SystemExit):
        main(["--session", OP_SESSION, "hosts"])
    err = capsys.readouterr().err
    assert "--version" not in err
    assert "vault bw and vault op take the vault session from their environment" in err


@pytest.mark.parametrize("provider", ["bw", "op"])
def test_a_session_hint_names_the_provider_typed(capsys, provider):
    with pytest.raises(SystemExit):
        main(["--session", OP_SESSION, "vault", provider, "--", "whoami"])
    err = capsys.readouterr().err
    assert OP_SESSION not in err
    assert f"vault {provider} takes the vault session from its environment" in err
    assert f"(`roster vault {provider} -- ARGS`)" in err


def test_an_unknown_help_topic_names_the_command_that_has_help(capsys):
    with pytest.raises(SystemExit):
        main(["help", "vault", "nope"])
    assert "no help for that (not repeated): `roster help vault` lists its commands" in capsys.readouterr().err


def test_an_unknown_init_inventory_names_the_forms(capsys):
    with pytest.raises(SystemExit) as e:
        main(["init", "--inventory", "nope"])
    assert e.value.code == 2
    assert ("--inventory: not one of its forms (not repeated): use blank, file:PATH, repo:URL or ssh-config[:PATH]"
            in capsys.readouterr().err)


# #479 item 2 (T235 review N2, #484 M1/L1): an op token that starts with `-c`, typed as the first word, reads as
# `-c PATH`, and a bw key or an op service-account token can be typed after -c by mistake: no error, fix line or
# JSON prints one. A path whose folder exists and that isn't token-shaped is still shown: the user typed a path.
BW_KEY = "q2Xv0b9ZtM4n1KpYwLe7Rj3s/N+yA2qXw1oLmK7pRtUvB=="                 # base64, with a / and a +
OPS_TOKEN = "ops_Ex4mpleN0tR3alServiceAcc0untT0k3nZZZZZZZZ"                   # made up, op service-account shaped
HIDDEN_CONFIGS = [pytest.param([f"-c{OP_SESSION}"], OP_SESSION, id="op-token-as-first-word"),
                  pytest.param(["-c", BW_KEY], BW_KEY, id="bw-key"),
                  pytest.param(["--config", OPS_TOKEN], OPS_TOKEN, id="ops-token")]


def _slices(token):
    return [token[i:i + 10] for i in range(0, len(token) - 10, 5)]


def _run(capsys, argv):
    try:
        code = main(argv)
    except SystemExit as e:
        code = e.code
    out = capsys.readouterr()
    return str(code) + out.out + out.err


@pytest.mark.parametrize(("first", "token"), HIDDEN_CONFIGS)
@pytest.mark.parametrize("command", [["hosts"], ["hosts", "--json"], ["mesh", "status", "--json"], ["check", "--box"],
                                     ["inv", "which"], ["inv", "which", "--json"]])
def test_a_token_read_as_a_config_path_is_not_repeated(capsys, tmp_path, monkeypatch, first, token, command):
    monkeypatch.chdir(tmp_path)
    out = _run(capsys, [*first, *command])
    assert not [x for x in _slices(token) if x in out], out
    assert "(not repeated)" in out, out


@pytest.mark.parametrize("typed", ["lab.yml", "inv/roster.yml", "~/x.yml"])
def test_a_missing_config_path_is_shown_when_it_looks_like_one(capsys, tmp_path, monkeypatch, typed):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "inv").mkdir()
    want = tmp_path / typed.removeprefix("~/")
    assert f"{want} not found" in _run(capsys, ["-c", typed, "hosts"])
    assert str(want) in _run(capsys, ["-c", typed, "hosts", "--json"])
    assert str(want) in _run(capsys, ["-c", typed, "inv", "which"])
