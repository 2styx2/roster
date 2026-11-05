"""Shell completion (T214, decision Q183): `roster help --completion SHELL` (was `roster completion SHELL`) prints a
thin script for bash, zsh, fish or PowerShell, and on every Tab the script runs the hidden helper

    roster __complete SHELL :CURRENT WORD...

WORDs are the command line before the word being completed (the first one is the program's name), CURRENT that word
as typed so far (after a colon, so an empty one survives Windows PowerShell's argument passing). The helper walks
roster's own argparse parser (cli.build_parser), so a new command or option completes without editing the scripts,
and prints one candidate a line: `NAME` for bash, `NAME<TAB>DESCRIPTION` for the others. `:files` or `:dirs` alone
asks the shell for its own file or folder completion.

Values come from what an argument is tagged with (`values(action, KIND)` in build_parser): Host, group, resource and
Inventory names, read from the local roster.yml and the named Inventories' list only. No network, no vault, no
secrets, and nothing written: a missing or broken file completes nothing, and the helper never prints an error."""
# argparse has no public way to walk a parser: its _actions, _option_string_actions and _SubParsersAction it is
# pyright: reportPrivateUsage=false

import argparse
import contextlib
import io
import sys
from typing import cast

from .cliparser import (
    COMMANDS,
    DIRS,
    FILES,
    GROUPS,
    HOSTS,
    INVENTORIES,
    NAME_RE,
    ONLY,
    RESOURCES,
    SHELLS,
    build_parser,
)


def main(argv: list[str]) -> int:
    """`roster __complete SHELL :CURRENT WORD...`: the candidates, or nothing at all on any error."""
    out = io.StringIO()
    try:
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            shell, current, *words = argv
            if shell not in SHELLS or not current.startswith(":"):
                return 0
            lines = candidates(words[1:], current[1:], shell)
        out.write("".join(f"{line}\n" for line in lines))
    except BaseException:       # noqa: BLE001 - a Tab must never print a traceback or exit non-zero
        return 0
    sys.stdout.write(out.getvalue())
    return 0


def candidates(words: list[str], current: str, shell: str) -> list[str]:
    parser = build_parser()
    found = walk(parser, words, current)
    if isinstance(found, str):
        return [found]
    pairs = sorted({(n, d) for n, d in found if n.startswith(current)})
    if shell == "bash":
        return [n for n, _ in pairs]
    return [f"{n}\t{d}" if d else n for n, d in pairs]


def walk(parser: argparse.ArgumentParser, words: list[str], current: str) -> "list[tuple[str, str]] | str":
    """What fits CURRENT after WORDS: (name, description) pairs, or ":files" / ":dirs"."""
    root: dict[str, str | None] = {"config": None, "inv": None}      # -c / --inv before the command, as roster
    level = 0
    positional = 0              # how many words the current parser's positionals took
    taken: list[str] = []       # those words
    pending: argparse.Action | None = None     # an option waiting for its value
    i = 0
    while i < len(words):
        w = words[i]
        i += 1
        if pending is not None:
            if level == 0 and pending.dest in root:
                root[pending.dest] = w
            pending = None
            continue
        if w == "--":
            return []
        if w.startswith("-") and len(w) > 1:
            name, eq, value = w.partition("=")
            action = parser._option_string_actions.get(name)
            if action is not None and action.nargs != 0 and not eq:
                pending = action
            elif action is not None and eq and level == 0 and action.dest in root:
                root[action.dest] = value
            continue
        commands, _ = subcommands(parser)
        if positional == 0 and w in commands:
            parser, level, positional, taken = commands[w], level + 1, 0, []
            continue
        positional += 1
        taken.append(w)
    if pending is not None:
        return names(pending, current, root)
    if current.startswith("-"):
        return options(parser, current, root)
    commands, helps = subcommands(parser)
    if commands and positional == 0:
        return [(n, helps.get(n, "")) for n in commands if not (level == 0 and n in internal())]
    action, first = positional_at(parser, positional)
    if action is None or (not first and action.nargs in ("+", "*")):
        return []               # `hosts NAME...`: the later words are fuzzy search words
    if taken[-1:] and taken[-1] in getattr(action, "new_after", ()):
        return []
    return names(action, current, root)


def internal() -> list[str]:
    """The commands the app or ssh runs (serve, askpass): they work, but a Tab doesn't offer them."""
    from .clihelp import INTERNAL
    return INTERNAL


def subcommands(parser: argparse.ArgumentParser) -> "tuple[dict[str, argparse.ArgumentParser], dict[str, str]]":
    """PARSER's commands (none for a command's own parser), and each one's one-line help."""
    for a in parser._actions:
        if isinstance(a, argparse._SubParsersAction):
            sub = cast("argparse._SubParsersAction[argparse.ArgumentParser]", a)
            return dict(sub.choices), {c.dest: c.help or "" for c in sub._choices_actions}
    return {}, {}


def positional_at(parser: argparse.ArgumentParser, n: int) -> "tuple[argparse.Action | None, bool]":
    """The positional the word after N taken ones fills, and whether it's that positional's first word."""
    for a in parser._actions:
        if a.option_strings or isinstance(a, argparse._SubParsersAction):
            continue
        if a.nargs == argparse.REMAINDER:
            return None, False
        if a.nargs in ("+", "*"):
            return a, n == 0
        if n == 0:
            return a, True
        n -= 1
    return None, False


def options(parser: argparse.ArgumentParser, current: str,
            root: dict[str, str | None]) -> "list[tuple[str, str]] | str":
    name, eq, _ = current.partition("=")
    if eq:                      # --opt=VALUE: the value, written after the option
        action = parser._option_string_actions.get(name)
        if action is None or action.nargs == 0:
            return []
        found = names(action, current[len(name) + 1:], root)
        return found if isinstance(found, str) else [(f"{name}={n}", d) for n, d in found]
    return [(o, a.help or "") for a in parser._actions if a.help != argparse.SUPPRESS for o in a.option_strings]


def names(action: argparse.Action, current: str, root: dict[str, str | None]) -> "list[tuple[str, str]] | str":
    """The values ACTION takes that roster knows here: its choices, or the names its tag says."""
    if action.choices is not None:
        return [(str(c), "") for c in action.choices]
    kinds: tuple[str, ...] = getattr(action, "complete", ())
    if FILES in kinds:
        return ":files"
    if DIRS in kinds:
        return ":dirs"
    if not kinds:
        return []
    if COMMANDS in kinds:
        commands, helps = subcommands(build_parser())
        return [(n, helps.get(n, "")) for n in commands if n not in internal()]
    found: list[tuple[str, str]] = []
    if INVENTORIES in kinds:
        found += [(n, "Inventory") for n in inventory_names()]
    if not set(kinds) - {INVENTORIES}:
        return found
    raw = roster_yml(root)
    if ONLY in kinds:           # a comma-separated list: the last name, after the ones already typed
        head, _, _ = current.rpartition(",")
        typed = set(head.split(","))
        return [(f"{head},{n}" if head else n, d) for n, d in yml_names(raw, kinds) if n not in typed]
    return found + yml_names(raw, kinds)


def mapping(x: object) -> dict[object, object]:
    """X when it's a YAML mapping, else an empty one: a hand-edited roster.yml can hold anything."""
    return cast("dict[object, object]", x) if isinstance(x, dict) else {}


def yml_names(raw: dict[object, object], kinds: tuple[str, ...]) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for g, group in mapping(raw.get("groups")).items():
        if GROUPS in kinds:
            found.append((str(g), "group"))
        if HOSTS in kinds:
            found += [(str(h), "Host") for h in mapping(mapping(group).get("hosts"))]
    if RESOURCES in kinds:
        found += [(str(r), "resource") for r in mapping(raw.get("resources"))]
    return [(n, d) for n, d in found if NAME_RE.match(n)]


def roster_yml(root: dict[str, str | None]) -> dict[object, object]:
    """The roster.yml roster would use (-c, --inv, $ROSTER_CONFIG, ...), as plain YAML: not loaded or checked."""
    import yaml

    from .config import locate_config
    try:
        return mapping(yaml.safe_load(locate_config(root["config"], root["inv"]).read_text(encoding="utf-8")))
    except (SystemExit, Exception):     # noqa: BLE001 - none found, unreadable, not YAML: no names
        return {}


def inventory_names() -> list[str]:
    from . import named
    try:
        return [x.name for x in named.load().inventories]
    except (SystemExit, Exception):     # noqa: BLE001
        return []


# ---- the scripts: each only hands the words to the helper and shows what it prints

BASH = r"""# roster's bash completion (roster help --completion bash). Every Tab asks `roster __complete` what fits.
_roster() {
    local cur=${COMP_WORDS[COMP_CWORD]} IFS=$'\n' out
    [[ $cur == =* || ${COMP_WORDS[COMP_CWORD-1]} == = ]] && return 0     # --opt=VALUE: bash splits it at the =
    out=$(command roster __complete bash ":$cur" "${COMP_WORDS[@]:0:COMP_CWORD}" 2>/dev/null) || return 0
    case $out in
        :files) compopt -o filenames 2>/dev/null; COMPREPLY=($(compgen -f -- "$cur")) ;;
        :dirs) compopt -o filenames 2>/dev/null; COMPREPLY=($(compgen -d -- "$cur")) ;;
        *) COMPREPLY=($out) ;;
    esac
}
complete -F _roster roster
"""

ZSH = r"""#compdef roster
# roster's zsh completion (roster help --completion zsh). Every Tab asks `roster __complete` what fits.
_roster() {
    local out line
    local -a names descs
    out=$(command roster __complete zsh ":$PREFIX" "${(@)words[1,CURRENT-1]}" 2>/dev/null) || return 1
    case $out in
        :files) _files; return ;;
        :dirs) _files -/; return ;;
    esac
    for line in ${(f)out}; do
        names+=("${line%%$'\t'*}")
        if [[ $line == *$'\t'* ]]; then descs+=("${line%%$'\t'*} -- ${line#*$'\t'}"); else descs+=("$line"); fi
    done
    (( ${#names} )) && compadd -l -d descs -Q -- "${names[@]}"
}
if (( $+functions[compdef] )); then
    compdef _roster roster
else
    autoload -Uz compinit && compinit -i && compdef _roster roster
fi
"""

FISH = r"""# roster's fish completion (roster help --completion fish). Every Tab asks `roster __complete` what fits.
function __roster_complete
    set -l out (command roster __complete fish ":"(commandline -ct) (commandline -opc) 2>/dev/null)
    switch "$out"
        case :files
            __fish_complete_path (commandline -ct)
        case :dirs
            __fish_complete_directories (commandline -ct)
        case '*'
            string join \n -- $out
    end
end
complete -c roster -f -a '(__roster_complete)'
"""

POWERSHELL = r"""# roster's PowerShell completion (roster help --completion powershell). Every Tab asks `roster __complete` what fits.
Register-ArgumentCompleter -Native -CommandName roster -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $words = @($commandAst.CommandElements | Where-Object { $_.Extent.EndOffset -lt $cursorPosition } |
        ForEach-Object { $_.Extent.Text })
    $out = @(& roster __complete powershell ":$wordToComplete" @words 2>$null)
    if ($out.Count -eq 1 -and ($out[0] -eq ':files' -or $out[0] -eq ':dirs')) { return }
    foreach ($line in $out) {
        $name, $desc = $line -split "`t", 2
        if (-not $desc) { $desc = $name }
        [System.Management.Automation.CompletionResult]::new($name, $name, 'ParameterValue', $desc)
    }
}
"""

SCRIPTS = {"bash": BASH, "zsh": ZSH, "fish": FISH, "powershell": POWERSHELL}


def cmd_completion(shell: str) -> int:
    """`roster help --completion SHELL` (and its old name, `roster completion SHELL`)."""
    sys.stdout.write(SCRIPTS[shell])
    return 0
