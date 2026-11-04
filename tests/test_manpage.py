"""roster(1): the man page, generated from the parser and docs/cli-reference.md, and `roster man`."""

import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from conftest import no_roster_path, posix_shell, source_copy

from roster import manpage
from roster.cli import build_parser, main

ROOT = Path(__file__).parent.parent
REFERENCE = ROOT / "docs" / "cli-reference.md"


def all_options(parser):
    """(command, what you type) for every subcommand and option, straight from argparse."""
    for a in parser._actions:
        if a.option_strings and a.dest != "help":
            yield "", a.option_strings[-1]
    for name, sub in manpage.subcommands(parser).items():
        yield name, name
        for a in sub._actions:
            if a.option_strings and a.dest != "help":
                yield name, a.option_strings[-1]


# ---------------------------------------------------------------- drift: the committed page is the generator's

def test_committed_page_is_what_the_generator_writes():
    expected = manpage.render(build_parser(), REFERENCE.read_text())
    assert manpage.PAGE.read_text() == expected, \
        "src/roster/roster.1 is out of date: run  uv run python -m roster.manpage"


def test_page_names_every_command_and_option():
    page = manpage.PAGE.read_text().replace("\\-", "-")
    missing = [f"{cmd} {opt}".strip() for cmd, opt in all_options(build_parser()) if opt not in page]
    assert not missing


def test_every_option_says_what_it_does():
    parser = build_parser()
    silent = [f"{name} {a.option_strings or a.dest}" for name, sub in manpage.subcommands(parser).items()
              for a in sub._actions if a.dest != "help" and not a.help]
    assert not silent


def test_cli_reference_lists_exactly_the_parsers_commands():
    table = list(manpage.command_docs(REFERENCE.read_text()))
    assert sorted(table) == sorted(manpage.subcommands(build_parser()))


def test_a_command_missing_from_cli_reference_stops_the_generator():
    reference = REFERENCE.read_text().replace("| `sync` |", "| `not-sync` |")
    with pytest.raises(ValueError, match="no row for: sync"):
        manpage.render(build_parser(), reference)


def test_the_page_has_the_sections_a_man_page_has():
    page = manpage.PAGE.read_text()
    for s in ("NAME", "SYNOPSIS", "DESCRIPTION", "COMMANDS", "FILES", "ENVIRONMENT", "EXIT STATUS",
              "EXAMPLES", "SEE ALSO"):
        assert f"\n.SH {s}\n" in page
    assert page.startswith(".TH ROSTER 1 ")


@pytest.mark.skipif(not shutil.which("groff"), reason="groff not installed")
def test_groff_renders_it_without_warnings():
    r = subprocess.run(["groff", "-man", "-Tutf8", "-ww", "-z", str(manpage.PAGE)], capture_output=True, text=True)
    assert r.returncode == 0 and r.stderr == ""


# ---------------------------------------------------------------- `roster man --install`: next to the roster command

@posix_shell
def test_man_install_puts_the_page_next_to_the_roster_command(tmp_path, monkeypatch, capsys):
    bindir = tmp_path / "prefix" / "bin"
    bindir.mkdir(parents=True)
    (bindir / "roster").write_text("#!/bin/sh\n")
    (bindir / "roster").chmod(0o755)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    assert main(["man", "--install"]) == 0
    page = tmp_path / "prefix" / "share" / "man" / "man1" / "roster.1"
    assert page.read_text() == manpage.PAGE.read_text()
    assert str(page) in capsys.readouterr().out


def test_man_install_into_a_given_prefix(tmp_path):
    assert main(["man", "--install", "--prefix", str(tmp_path / "opt")]) == 0
    assert (tmp_path / "opt" / "share" / "man" / "man1" / "roster.1").is_file()


def test_man_install_without_roster_on_path_uses_the_users_local_prefix(isolated, monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: None)
    assert main(["man", "--install"]) == 0
    assert (isolated["home"] / ".local" / "share" / "man" / "man1" / "roster.1").is_file()


@pytest.mark.skipif(not shutil.which("man"), reason="man not installed")
def test_man_finds_the_installed_page_through_path(tmp_path):
    """No MANPATH: man maps PREFIX/bin on PATH to PREFIX/share/man, as it does for ~/.local/bin."""
    assert main(["man", "--install", "--prefix", str(tmp_path / "p")]) == 0
    (tmp_path / "p" / "bin").mkdir()
    env = {k: v for k, v in os.environ.items() if k != "MANPATH"}
    env["PATH"] = f"{tmp_path / 'p' / 'bin'}{os.pathsep}{env['PATH']}"
    r = subprocess.run(["man", "-w", "roster"], env=env, capture_output=True, text=True)
    assert r.stdout.strip() == str(tmp_path / "p" / "share" / "man" / "man1" / "roster.1")


# ---------------------------------------------------------------- what users install: the wheel and install.sh

@pytest.mark.skipif(not shutil.which("uv"), reason="uv not installed")
def test_the_wheel_carries_the_page_as_package_data_and_for_the_prefix(tmp_path):
    subprocess.run(["uv", "build", "--wheel", "--out-dir", str(tmp_path), str(ROOT)], check=True,
                   capture_output=True)
    (wheel,) = tmp_path.glob("roster-*.whl")
    names = zipfile.ZipFile(wheel).namelist()
    assert "roster/roster.1" in names                                    # `roster man` reads this
    assert any(n.endswith(".data/data/share/man/man1/roster.1") for n in names)    # pip into a prefix


@posix_shell
def test_install_sh_puts_the_page_in_the_prefix_it_installs_roster_into(tmp_path):
    env = {**os.environ, "HOME": str(tmp_path / "home"), "NO_COLOR": "1", "PATH": no_roster_path()}
    r = subprocess.run(["bash", str(source_copy(tmp_path) / "install.sh"), "--dry-run", "--yes", "--prefix",
                        str(tmp_path / "opt")],
                       env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=120)
    assert f"{tmp_path / 'opt'}/share/man/man1/roster.1" in r.stdout
    assert f"UV_TOOL_BIN_DIR={tmp_path / 'opt'}/bin" in r.stdout


def test_regenerate_check_passes_on_the_committed_page():
    r = subprocess.run([sys.executable, "-m", "roster.manpage", "--check"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root can write anywhere")
@posix_shell
def test_man_install_into_a_prefix_it_cant_write_says_what_to_do(tmp_path, capsys):
    prefix = tmp_path / "root-owned"
    prefix.mkdir()
    prefix.chmod(0o555)
    try:
        assert main(["man", "--install", "--prefix", str(prefix)]) != 0
    finally:
        prefix.chmod(0o755)
    err = capsys.readouterr().err
    assert "Traceback" not in err
    assert str(prefix / "share" / "man" / "man1") in err
    assert "--prefix ~/.local" in err and "sudo" in err


def run_install_sh(tmp_path, *args, path=None, answers=None):
    """install.sh --dry-run with a made-up HOME (never the real one). ANSWERS: lines typed at its questions (the
    run has no terminal, so it reads them from stdin); without, --yes takes every default."""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    env = {**os.environ, "HOME": str(home), "NO_COLOR": "1", "PATH": path or no_roster_path()}
    flags = ["--dry-run", *([] if answers is not None else ["--yes"]), *args]
    r = subprocess.run(["bash", str(source_copy(tmp_path) / "install.sh"), *flags], env=env, capture_output=True, text=True, cwd=tmp_path,
                       input=answers or "", timeout=120, start_new_session=True)     # no controlling terminal
    return r.stdout


@posix_shell
@pytest.mark.skipif(not shutil.which("uv"), reason="uv not installed")
def test_install_sh_on_a_box_with_roster_updates_it_and_its_page(tmp_path):
    bindir = tmp_path / "opt" / "bin"
    bindir.mkdir(parents=True)
    (bindir / "roster").write_text("#!/bin/sh\necho roster 0.1.0\n")
    (bindir / "roster").chmod(0o755)
    home = tmp_path / "home"                                  # set up: a map in ROSTER_CONFIG
    (home / "infra").mkdir(parents=True)
    (home / "infra/roster.yml").write_text("groups: {}\n")
    (home / ".bashrc").write_text('export ROSTER_CONFIG="$HOME/infra/roster.yml"   # roster: ROSTER_CONFIG\n')
    out = run_install_sh(tmp_path, "--prefix", str(tmp_path / "opt"), answers="n\n" * 40)
    assert "already installed on this box: updating it with ./update.sh" in out
    assert f"{tmp_path / 'opt'}/share/man/man1/roster.1" in out          # update.sh puts the page beside it


@posix_shell
def test_install_sh_asks_to_add_the_prefix_to_path_only_when_it_isnt(tmp_path):
    prefix = tmp_path / "opt"
    missing = run_install_sh(tmp_path, "--prefix", str(prefix))
    assert f"add {prefix}/bin to PATH yourself" in missing
    there = run_install_sh(tmp_path, "--prefix", str(prefix), path=f"{prefix / 'bin'}{os.pathsep}{os.environ['PATH']}")
    assert "to PATH" not in there
