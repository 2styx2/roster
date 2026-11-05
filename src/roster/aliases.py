"""The CLI's old names (T222, #430, decision Q194): every command or flag a regroup renames keeps working, hidden, as
one row of ALIASES. `rewrite(argv)` turns an old command line into its new form before the parser sees it, so the
parser, `--help`, the man page and Tab completion know only the new names, and one table is all a later rename adds.
An alias says its new form once on stderr (`warning`), except one a machine runs (`silent`): `roster completion`, which
the rc line install.sh wrote runs at every shell start. docs/deprecated.md has a row for each."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Alias:
    old: tuple[str, ...]        # the command word, then a flag of that command it replaces (or nothing)
    new: tuple[str, ...]        # the words it becomes, in the command's place
    usage: str                  # the new form as the warning names it
    silent: bool = False        # run by a machine: works without a word


ALIASES: list[Alias] = [
    Alias(("auth-check",), ("check", "--auth"), "roster check --auth"),
    Alias(("info",), ("hosts",), "roster hosts NAME"),
    Alias(("resources",), ("hosts", "--resources"), "roster hosts --resources"),
    Alias(("providers",), ("vault", "status"), "roster vault status"),
    Alias(("reveal",), ("vault", "reveal"), "roster vault reveal NAME"),
    Alias(("bw",), ("vault", "bw"), "roster vault bw -- ARGS"),
    Alias(("man",), ("help", "--man"), "roster help --man"),
    Alias(("completion",), ("help", "--completion"), "roster help --completion SHELL", silent=True),
    Alias(("mesh", "--find-leftovers"), ("mesh", "leftovers"), "roster mesh leftovers"),
    Alias(("mesh", "--remove-leftovers"), ("mesh", "leftovers", "--remove"), "roster mesh leftovers --remove"),
]

ROOT_VALUE = ("--config", "--inv")     # roster's own options that take a value, before the command (and -c)


def takes_value(word: str) -> bool:
    """Is WORD roster's -c, or --config / --inv as argparse takes them: whole or any prefix of one (`--conf`), with
    its value in the next word? (#447 review L2: else `roster --conf info hosts` would rewrite the path.)"""
    return word == "-c" or (len(word) > 2 and "=" not in word and any(o.startswith(word) for o in ROOT_VALUE))


def command_at(argv: list[str]) -> int | None:
    """Where the command word is in ARGV: the first word that isn't one of roster's own options (or its value)."""
    i = 0
    while i < len(argv):
        w = argv[i]
        if w == "--":
            return None
        if takes_value(w):
            i += 2
            continue
        if not w.startswith("-"):
            return i
        i += 1
    return None


def rewrite(argv: list[str]) -> tuple[list[str], Alias | None]:
    """ARGV in its new form, and the alias that changed it (None: nothing to change)."""
    at = command_at(argv)
    if at is None:
        return argv, None
    word, rest = argv[at], argv[at + 1:]
    before = rest[:rest.index("--")] if "--" in rest else rest
    for a in ALIASES:
        if a.old == (word,):
            return [*argv[:at], *a.new, *rest], a
    flags = [a for a in ALIASES if len(a.old) == 2 and a.old[0] == word and a.old[1] in before]
    if not flags:
        return argv, None
    a = flags[-1]                       # both flags: the one that does more (--remove-leftovers)
    gone = {f.old[1] for f in flags}
    kept = [w for w in before if w not in gone] + rest[len(before):]
    return [*argv[:at], *a.new, *kept], a


def warning(alias: Alias) -> str:
    """The one line an alias says on stderr."""
    return (f"warning: `roster {' '.join(alias.old)}` is now `{alias.usage}`; the old name still works for now "
            "(docs/deprecated.md)")
