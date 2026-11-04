"""`roster --help` and `roster COMMAND --help`: the commands in groups, a description and examples for each, and a
suggestion for a mistyped command. The options themselves stay in cli.build_parser (the man page is made from it).

Every example here is parsed by tests/test_cli_help.py, so one that no longer parses fails a test. Host names are
made up (the repo is public)."""

import argparse
import difflib
import re
import shutil
import textwrap

USAGE = "roster [-c PATH | --inv NAME] COMMAND [ARGS]"

# Each command once, in the order a new user meets them. tests/test_cli_help.py checks every command is here.
GROUPS: list[tuple[str, list[str]]] = [
    ("Start here", ["init", "setup", "sync", "check", "auth-check"]),
    ("Every day", ["hosts", "info", "run", "web", "resources", "reveal"]),
    ("Inventory and access", ["discover", "inv", "mesh", "revoke"]),
    ("Tools", ["bw", "providers", "man", "completion"]),
    ("Run by the app, not by hand", ["serve", "askpass"]),
]

EXAMPLES: dict[str, list[tuple[str, str]]] = {
    "init": [("roster init", "write a commented example roster.yml here"),
             ("roster -c ~/infra/roster.yml init", "or there")],
    "setup": [("roster setup --dry-run", "what it would do, nothing changed on any host"),
              ("roster setup", "key, fingerprints, key on every key host, ssh config, ROSTER.md"),
              ("roster setup --only switch,router", "just these groups or types")],
    "sync": [("roster sync", "after editing or pulling roster.yml")],
    "check": [("roster check", "can this box reach every host?"),
              ("roster check esx-02", "why a login to one host fails, step by step"),
              ("roster check --box", "this box's own health; connects nowhere"),
              ("roster check --only db --json", "for a script")],
    "auth-check": [("roster auth-check", "every password reference resolves (nothing printed)"),
                   ("roster auth-check --only network", "one group")],
    "hosts": [("roster hosts", "every host you can reach"),
              ("roster hosts --find postgres", "search names, titles, descriptions, addresses"),
              ("roster hosts --only prod --long", "one type, with web URL and description")],
    "info": [("roster info esx-02", "everything about one host"),
             ("roster info orion db", "fuzzy words work")],
    "run": [("roster run switch-01 -- show version", "a password-only host; roster logs in"),
            ("roster run --sudo web-01 -- systemctl restart nginx", "as root; sudo gets the password")],
    "web": [("roster web esx-02 GET /folder", "logged in with the host's stored credentials"),
            ("roster web app-01 https POST /api/login -d @body.json", "a named service, a body from a file")],
    "resources": [("roster resources", "Wi-Fi networks, accounts and secrets"),
                  ("roster resources --find guest", "search them")],
    "reveal": [("roster reveal lab-guest", "print its secret, for you to type in"),
               ("roster reveal lab-guest --wifi", "a WIFI:... string for a QR code")],
    "discover": [("roster discover 10.0.1.0/24", "preview what answers; nothing written"),
                 ("roster discover 10.0.1.0/24 --write --group lab", "add them, unreviewed, to roster.yml")],
    "inv": [("roster inv add work ~/infra/roster.yml", "name an Inventory"),
            ("roster inv use work", "make it the active one"),
            ("roster --inv home hosts", "one command against another"),
            ("roster inv which", "the roster.yml roster uses now")],
    "mesh": [("roster mesh --dry-run", "the plan for mesh: and links: in roster.yml"),
             ("roster mesh", "apply it, one host at a time"),
             ("roster mesh status", "who reaches whom, without connecting"),
             ("roster mesh cut web-01", "take one host out everywhere")],
    "revoke": [("roster revoke", "this box's key off every host of this roster.yml"),
               ("roster revoke --all", "off every Inventory's hosts (before removing roster)")],
    "bw": [("roster bw list items --search proxmox", "bw with this box's saved session"),
           ("roster bw sync", "pull the vault")],
    "providers": [("roster providers", "which password providers work here")],
    "completion": [("roster completion bash", "bash's script: eval \"$(roster completion bash)\" in ~/.bashrc"),
                   ("roster completion fish", "fish's: roster completion fish | source"),
                   ("roster completion powershell", "PowerShell's: ... | Out-String | Invoke-Expression in $PROFILE")],
    "man": [("roster man", "the manual"),
            ("roster man --install", "so `man roster` finds it")],
}

NOTES = {
    "serve": "The desktop app starts this itself; there's nothing to run by hand. See docs/serve-api.md.",
    "askpass": "ssh runs this for a `roster serve` password Session; there's nothing to run by hand.",
    "run": "Key hosts don't need roster: `ssh NAME` works once `roster setup` has run.",
}

COMMON = [("roster setup", "set up this box (once)"),
          ("roster hosts", "list the hosts"),
          ("ssh esx-02", "key hosts: plain ssh, by name"),
          ("roster run switch-01 -- show version", "password-only hosts"),
          ("roster check esx-02", "a login that doesn't work, explained")]

MORE = ("`roster COMMAND --help` shows a command's options and examples, `man roster` (or `roster man`) the "
        "manual, and https://2styx2.github.io/roster/ every page of the docs.")


def more() -> str:
    """The last lines of `roster --help`: where to read more."""
    return textwrap.fill(MORE, width())


def width() -> int:
    return max(60, min(100, shutil.get_terminal_size((80, 24)).columns) - 2)


def _rows(rows: list[tuple[str, str]], col: int) -> list[str]:
    """`  left   right` rows, the right side wrapped under itself."""
    out = []
    for left, right in rows:
        pad = col - len(left) - 2
        if pad < 2:                              # too long for the column: the words go on the next line
            out.append(f"  {left}")
            left, pad = "", col - 2
        cont = "# " if right.startswith("# ") else ""        # a wrapped comment stays a comment
        wrapped = textwrap.wrap(right, max(20, width() - col), subsequent_indent=cont) or [""]
        out.append(f"  {left}{' ' * pad}{wrapped[0]}")
        out += [" " * col + w for w in wrapped[1:]]
    return out


def examples_text(name: str) -> str:
    rows = EXAMPLES.get(name, [])
    note = NOTES.get(name)
    parts = []
    if rows:                                     # what it does above, the command below: long commands fit
        parts.append("examples:\n" + "\n\n".join(
            "\n".join(textwrap.wrap(what, width() - 4, initial_indent="  # ", subsequent_indent="  # ")) + f"\n  {cmd}"
            for cmd, what in rows))
    if note:
        parts.append(textwrap.fill(note, width()))
    return "\n\n".join(parts)


def description(help_: str) -> str:
    """A command's one-line help as the opening sentence of its --help."""
    text = help_[:1].upper() + help_[1:]
    return textwrap.fill(text if text.endswith(".") else text + ".", width())


def overview(helps: dict[str, str]) -> str:
    """The commands in their groups, then the common things to type and where to read more."""
    col = max(len(n) for n in helps) + 5
    out = []
    for title, names in GROUPS:
        out.append(f"{title}:")
        out += _rows([(n, helps[n]) for n in names], col)
        out.append("")
    out.append("common:")
    out += _rows([(c, "# " + w) for c, w in COMMON], 42)
    return "\n".join(out)


class Formatter(argparse.RawDescriptionHelpFormatter):
    """The description and examples as written (they're wrapped here), options wrapped as usual."""


def suggest(message: str, options: list[str] | None = None) -> str:
    """argparse's "invalid choice: 'hots' (choose from …)" with the long list replaced by the nearest name. The
    "invalid choice: 'X'" part stays word for word: the app tells a roster from before `serve` by it. With OPTIONS
    (every --option roster has), "unrecognized arguments: --jsn" gets the nearest one too."""
    if message.startswith("unrecognized arguments: ") and options:
        for word in message.removeprefix("unrecognized arguments: ").split():
            if word in options:                 # a real option, in the wrong place: `roster --json`, `hosts --sudo`
                return f"{message} - {word} goes after a command that takes it (`roster COMMAND --help` lists them)"
            near = difflib.get_close_matches(word, options, n=1, cutoff=0.7) if word.startswith("-") else []
            if near:
                return f"{message} - did you mean `{near[0]}`?"
        return message
    m = re.match(r"(argument \S+: invalid choice: '([^']*)') \(choose from (.*)\)$", message)
    if not m:
        return message
    head, word, listed = m.groups()
    choices = [c.strip().strip("'\"") for c in listed.split(",")]
    near = difflib.get_close_matches(word, choices, n=1, cutoff=0.6)
    if near:
        hint = f"did you mean `{near[0]}`?"
    elif len(choices) <= 6:
        hint = f"one of: {', '.join(choices)}"
    else:
        hint = "not a roster command"
    return f"{head} - {hint}"
