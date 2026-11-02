"""roster(1): the man page, generated from the argument parser and docs/cli-reference.md.

The page ships inside the package (src/roster/roster.1), so a wheel or `uv tool install` has it, and
`roster man` shows it or installs it where `man roster` finds it. To regenerate it after changing the
parser or cli-reference.md, from a clone:

    uv run python -m roster.manpage            # rewrites src/roster/roster.1
    uv run python -m roster.manpage --check    # exits 1 if the committed page is out of date

tests/test_manpage.py runs the same comparison, so a stale page fails the tests.
"""

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

PAGE = Path(__file__).with_name("roster.1")
REFERENCE = Path(__file__).resolve().parents[2] / "docs" / "cli-reference.md"    # in a clone only

# cli-reference.md's sections that become the page's, in order: (heading in the doc, man section)
SECTIONS = [("Machine-readable output", "JSON OUTPUT"), ("Files", "FILES"), ("Environment", "ENVIRONMENT"),
            ("Exit status", "EXIT STATUS"), ("Examples", "EXAMPLES")]


def install_prefix():
    """The prefix the `roster` command was installed into: PREFIX/bin/roster (~/.local/bin/roster for
    `uv tool install`). Not resolved through symlinks: man maps the PATH entry PREFIX/bin to PREFIX/share/man."""
    found = shutil.which("roster")
    return Path(found).parent.parent if found else Path.home() / ".local"


def cmd_man(args):
    if args.install:
        dest = Path(args.prefix or install_prefix()).expanduser() / "share" / "man" / "man1" / "roster.1"
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(PAGE, dest)
        except PermissionError:
            print(f"roster: can't write to {dest.parent}: permission denied.\n"
                  "  Install it where you can write, next to a bin directory on your PATH:"
                  "  roster man --install --prefix ~/.local\n"
                  "  or run it with sudo to install it there.", file=sys.stderr)
            return 1
        print(f"installed {dest}")
        print("try: man roster")
        return 0
    if not shutil.which("man"):
        print(f"man isn't installed; the page is {PAGE}", file=sys.stderr)
        return 1
    return subprocess.run(["man", str(PAGE)]).returncode    # a path with a slash: man reads that file


# ---------------------------------------------------------------- markdown (the little cli-reference uses)

def esc(text):
    """Plain text -> troff: backslashes and hyphens escaped, no line starting a request."""
    text = text.replace("\\", "\\e").replace("-", "\\-")
    return re.sub(r"^([.'])", r"\\&\1", text, flags=re.M)


def inline(md):
    """One line of Markdown -> troff: `code` and **strong** bold, links keep their text."""
    md = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", md)
    out, pos = [], 0
    for m in re.finditer(r"`([^`]+)`|\*\*(.+?)\*\*", md):
        out.append(esc(md[pos:m.start()]))
        out.append("\\fB" + esc(m.group(1) or m.group(2)) + "\\fR")
        pos = m.end()
    out.append(esc(md[pos:]))
    return "".join(out)


def cells(row):
    return [c.strip() for c in row.strip().strip("|").split("|")]


def blocks(md):
    """Markdown body -> troff: paragraphs, bullets, two-column tables (as tagged paragraphs), code blocks."""
    out, lines, i = [], md.splitlines(), 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            j = lines.index("```", i + 1) if "```" in lines[i + 1:] else len(lines)
            out += [".PP", ".nf", ".RS 4", *(esc(x) for x in lines[i + 1:j]), ".RE", ".fi"]
            i = j + 1
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append(cells(lines[i]))
                i += 1
            for key, *rest in rows[2:]:                        # skip the header and the --- row
                out += [".TP", inline(key), inline(" ".join(rest))]
        elif line.startswith("- "):
            out += [".IP \\(bu 2", inline(line[2:])]
            i += 1
        elif line.strip():
            para = []
            while i < len(lines) and lines[i].strip() and not lines[i].startswith(("```", "|", "- ")):
                para.append(lines[i].strip())
                i += 1
            out += [".PP", inline(" ".join(para))]
        else:
            i += 1
    return out


def section(reference, heading):
    """The body of `## heading` in cli-reference.md, up to the next heading of any level."""
    m = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^#{{2,3}} |\Z)", reference, re.M | re.S)
    if not m:
        raise ValueError(f"docs/cli-reference.md has no '## {heading}' section")
    return m.group(1)


def command_docs(reference):
    """The Commands table: {command name: what it does}, in the table's order."""
    docs = {}
    rows = [r for r in section(reference, "Commands").splitlines() if r.startswith("|")]
    for row in rows[2:]:                                       # skip the header and the --- row
        first, what = cells(row)[:2]
        docs[first.strip("`").split()[0]] = what
    return docs


# ---------------------------------------------------------------- the parser

def subcommands(parser):
    """{name: subparser} for every `roster NAME`, in the order the parser adds them."""
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            return dict(action.choices)
    return {}


def options(parser):
    """Every option and positional a parser takes: (what you type, help or '')."""
    for a in parser._actions:
        if isinstance(a, (argparse._HelpAction, argparse._SubParsersAction)):
            continue
        if a.option_strings:
            flags = ", ".join(a.option_strings)
            if a.nargs != 0:
                flags += " " + (a.metavar or a.dest.upper().replace("_", "-"))
        else:
            flags = a.metavar or a.dest.upper()
        yield flags, (a.help or "").replace("%(default)s", str(a.default))


def usage(parser):
    text = parser.format_usage().replace("usage: ", "", 1).replace(" [-h]", "", 1)
    return " ".join(text.split())


def render(parser, reference):
    """The whole page, as troff."""
    docs = command_docs(reference)
    commands = subcommands(parser)
    undocumented = [c for c in commands if c not in docs]
    if undocumented:
        raise ValueError(f"docs/cli-reference.md's Commands table has no row for: {', '.join(undocumented)}")
    summary = parser.description.rstrip(".")
    out = ['.TH ROSTER 1 "" "roster" "User Commands"',
           ".SH NAME", "roster \\- " + esc(summary[:1].lower() + summary[1:]),
           ".SH SYNOPSIS", ".nf"]
    out += [esc(usage(p)) for p in commands.values()]
    out += [".fi", ".SH DESCRIPTION", ".PP", esc(parser.description)]
    out += blocks(section(reference, "Why it exists"))
    out += [".SH OPTIONS"]
    for flags, help_ in options(parser):
        out += [".TP", "\\fB" + esc(flags) + "\\fR", esc(help_) or "."]
    out += [".SH COMMANDS"]
    for name, p in commands.items():
        out += [".SS " + esc(name), ".PP", "\\fB" + esc(usage(p)) + "\\fR", ".PP", inline(docs[name])]
        for flags, help_ in options(p):
            out += [".TP", "\\fB" + esc(flags) + "\\fR"] + ([esc(help_)] if help_ else [".br"])
    for heading, man in SECTIONS:
        out += [".SH " + man] + blocks(section(reference, heading))
    out += [".SH SEE ALSO", ".PP", "\\fBssh\\fR(1), \\fBssh_config\\fR(5), \\fBnmap\\fR(1), \\fBbw\\fR(1)",
            ".PP", "The full reference, with the roster.yml format and the security model: "
            "docs/cli\\-reference.md in roster's source, https://github.com/2styx2/roster"]
    return "\n".join(out) + "\n"


def main(argv=None):
    from .cli import build_parser

    p = argparse.ArgumentParser(prog="python -m roster.manpage", description="Regenerate src/roster/roster.1.")
    p.add_argument("--check", action="store_true", help="exit 1 if the committed page is out of date")
    args = p.parse_args(argv)
    page = render(build_parser(), REFERENCE.read_text())
    if args.check:
        if PAGE.read_text() != page:
            print(f"{PAGE} is out of date: run  uv run python -m roster.manpage", file=sys.stderr)
            return 1
        return 0
    PAGE.write_text(page)
    print(f"wrote {PAGE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
