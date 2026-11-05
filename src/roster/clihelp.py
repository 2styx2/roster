"""`roster --help` and `roster COMMAND --help`: the commands in groups, a description and examples for each, and a
suggestion for a mistyped command. The options themselves stay in cli.build_parser (the man page is made from it).

Every example here is parsed by tests/test_cli_help.py, so one that no longer parses fails a test. Host names are
made up (the repo is public)."""

import argparse
import ast
import difflib
import re
import shutil
import textwrap

USAGE = "roster [-c PATH | --inv NAME] COMMAND [ARGS]"

# Each command once, in the order a new user meets them: the 14 a person types (T222, decision Q194). The ones the
# app or ssh runs are INTERNAL: they work, but the overview leaves them out. The old names (roster.aliases) are in
# neither. tests/test_cli_help.py checks every command is in one of the two.
GROUPS: list[tuple[str, list[str]]] = [
    ("Start here", ["init", "setup", "sync", "check"]),
    ("Every day", ["hosts", "run", "web"]),
    ("Inventory and access", ["add", "discover", "inv", "mesh", "revoke"]),
    ("Vault and help", ["vault", "help"]),
]
INTERNAL = ["serve", "askpass"]

EXAMPLES: dict[str, list[tuple[str, str]]] = {
    "init": [("roster init", "write a commented example roster.yml here"),
             ("roster -c ~/infra/roster.yml init --blank", "a short, empty one there instead"),
             ("roster init --inventory ssh-config", "the Hosts in ~/.ssh/config (it isn't changed)"),
             ("roster -c ~/infra/roster.yml init --inventory repo:git@example.com:team/infra.git", "the team's repo"),
             ("roster -c ~/home-net/roster.yml init --blank --name home", "a second one, named (roster inv)")],
    "setup": [("roster setup --dry-run", "what it would do, nothing changed on any host"),
              ("roster setup", "key, fingerprints, key on every key host, ssh config, ROSTER.md"),
              ("roster setup --only switch,router", "just these groups or types")],
    "sync": [("roster sync", "after editing or pulling roster.yml")],
    "check": [("roster check", "can this box reach every host?"),
              ("roster check esx-02", "why a login to one host fails, step by step"),
              ("roster check --box", "this box's own health; connects nowhere"),
              ("roster check --auth", "every Login's password source answers (nothing secret printed)"),
              ("roster check --only db --json", "for a script")],
    "hosts": [("roster hosts", "every host and resource you can use"),
              ("roster hosts esx-02", "everything about one host"),
              ("roster hosts orion db", "fuzzy words work"),
              ("roster hosts --find postgres", "search names, titles, descriptions, addresses"),
              ("roster hosts --only prod --long", "one type, with web URL and description"),
              ("roster hosts --resources --find guest", "only the Wi-Fi networks, accounts and secrets")],
    "run": [("roster run switch-01 -- show version", "a password-only host; roster logs in"),
            ("roster run --sudo web-01 -- systemctl restart nginx", "as root; sudo gets the password")],
    "web": [("roster web esx-02 GET /folder", "logged in with the host's stored credentials"),
            ("roster web app-01 https POST /api/login -d @body.json", "a named service, a body from a file")],
    "add": [("roster add nas-01 --ip 10.0.0.50 --group lab --auth bw:nas-01 --no-enroll", "one Host you know"),
            ("roster add nas-01 --auth bw:nas-01 --from-vault --setup", "address and user from the vault item, then "
             "setup and check for it"),
            ("roster add web-01 --ip 10.0.0.20 --dry-run", "the lines it would add; nothing written")],
    "discover": [("roster discover 10.0.1.0/24", "preview what answers; nothing written"),
                 ("roster discover 10.0.1.0/24 --write --group lab", "add them, unreviewed, to roster.yml")],
    "inv": [("roster inv add work ~/infra/roster.yml", "name an Inventory"),
            ("roster inv use work", "make it the active one"),
            ("roster --inv home hosts", "one command against another"),
            ("roster inv which", "the roster.yml roster uses now")],
    "mesh": [("roster mesh --dry-run", "the plan for mesh: and links: in roster.yml"),
             ("roster mesh", "apply it, one host at a time"),
             ("roster mesh status", "who reaches whom, without connecting"),
             ("roster mesh cut web-01", "take one host out everywhere"),
             ("roster mesh leftovers", "Mesh entries on the hosts this roster.yml doesn't ask for; changes nothing")],
    "revoke": [("roster revoke", "this box's key off every host of this roster.yml"),
               ("roster revoke --all", "off every Inventory's hosts (before removing roster)")],
    "vault": [("roster vault status", "which vaults work here, their state and last sync"),
              ("roster vault sync", "pull the vaults, then what was added, changed or removed"),
              ("roster vault unlock", "unlock Bitwarden for every run on this box, until roster vault lock"),
              ("roster vault reveal lab-guest", "a resource's secret, for you to type in"),
              ("roster vault bw -- list items --search web-01", "the Bitwarden CLI itself, read-only"),
              ("roster vault op -- item list --vault Infra", "the 1Password CLI itself, read-only")],
    "vault status": [("roster vault status", "providers, tools, each vault's state and last sync"),
                     ("roster vault status --json", "for a script")],
    "vault sync": [("roster vault sync", "bw sync, then the items added, changed or removed since the last one")],
    "vault unlock": [("roster vault unlock", "ask the master password once; runs on this box stop asking until locked")],
    "vault lock": [("roster vault lock", "bw lock, and remove the saved session")],
    "vault reveal": [("roster vault reveal lab-guest", "print its secret, for you to type in"),
                     ("roster vault reveal lab-guest --wifi", "a WIFI:... string for a QR code")],
    "vault bw": [("roster vault bw -- list items --search web-01", "bw with this box's saved session (read-only)"),
                 ("roster vault bw -- sync", "bw's own sync (roster vault sync also says what changed)"),
                 ("roster vault bw --write -- login", "sign in (vault-changing, file-writing and account commands "
                  "need --write)")],
    "vault op": [("roster vault op -- whoami", "which account op is signed in to"),
                 ("roster vault op -- item get \"esx-02 ssh\" --fields label=username", "one field (read-only)"),
                 ("roster vault op --write -- item edit \"esx-02 ssh\" --title \"esx-02 ssh (old)\"",
                  "vault-changing, account and file-writing commands need --write")],
    "help": [("roster help", "this overview"),
             ("roster help vault bw", "one command's options and examples"),
             ("roster help --man", "the manual"),
             ("roster help --man --install", "so `man roster` finds it"),
             ("roster help --completion bash", "bash's script: eval \"$(roster help --completion bash)\" in "
              "~/.bashrc"),
             ("roster help --completion fish", "fish's: roster help --completion fish | source"),
             ("roster help --completion powershell", "PowerShell's: ... | Out-String | Invoke-Expression in "
              "$PROFILE")],
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

MORE = ("`roster help COMMAND` (or `roster COMMAND --help`) shows a command's options and examples, `man roster` "
        "(or `roster help --man`) the "
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


HIDDEN = "(not repeated)"
_CUT = "\0"                     # where a typed word was, until the end (argv can't hold a NUL, so no word matches it)
_ARG = r"(argument [^:]+: )?"   # argparse's "argument --port: " ahead of an action's error

# options people type at roster that belong to a tool roster runs: what to say instead of a near roster option
NOT_ROSTERS = {"--session": "vault bw and vault op take the vault session from their environment, never the command "
                            "line (`roster vault bw -- ARGS`)"}


def usage_error(message: str, typed: list[str], known: set[str], options: list[str]) -> str:
    """argparse's (or roster's) usage error MESSAGE as roster says it: no word the user TYPED repeated (T235, #460;
    #402 N3), since a value may be a password, a vault session token or a credential in a URL typed in the wrong
    place. Every TYPED word that isn't one of roster's own names (KNOWN), and its quoted form, is taken out whatever
    the wording around it, so a new argparse message can't repeat one either. Then the wording is tidied, keeping the
    position or option, and a hint added: the nearest name, or the choices (OPTIONS: every --option roster has)."""
    hint = _hint(message, typed, options)
    return _tidy(_cut(message, typed, known)).replace(_CUT, HIDDEN) + (f" - {hint}" if hint else "")


def _cut(message: str, typed: list[str], known: set[str]) -> str:
    """MESSAGE with each TYPED word, the value in its `--opt=VALUE` or `-oVALUE`, and their repr() taken out."""
    forms = set()
    for word in typed:
        if word in known:
            continue
        forms.add(word)
        if word.startswith("-") and "=" in word:
            forms.add(word.partition("=")[2])
        if word.startswith("-") and not word.startswith("--") and len(word) > 2:
            forms.add(word[2:])
    forms.discard("")
    longest = sorted(forms, key=len, reverse=True)
    for form in longest:                                    # argparse's %r first: the whole quoted value goes
        message = message.replace(repr(form), _CUT)
    for form in longest:                                    # then as typed, a whole word (not inside another)
        message = re.sub(rf"(?<!\w){re.escape(form)}(?!\w)", _CUT, message)
    return message


def _tidy(message: str) -> str:
    """argparse's wording, without the (already cut) value: the option or position and what it takes stay."""
    rules = [
        (rf"^{_ARG}invalid choice: .*", lambda m: f"{m[1] or ''}invalid choice {HIDDEN}"),
        (r"^unrecognized arguments: .*", lambda m: f"unrecognized arguments {HIDDEN}"),
        (r"^ambiguous option: .* could match (.*)$", lambda m: f"ambiguous option {HIDDEN}: could match {m[1]}"),
        (rf"^{_ARG}invalid (\w+) value: .*", lambda m: f"{m[1] or ''}invalid {m[2]} value {HIDDEN}"),
        (rf"^{_ARG}ignored explicit argument .*", lambda m: f"{m[1] or ''}ignored explicit argument {HIDDEN}"),
        (rf"^{_ARG}unknown parser .* \(choices: (.*)$", lambda m: f"{m[1] or ''}unknown parser {HIDDEN} (choices: {m[2]}"),
    ]
    for pattern, say in rules:
        m = re.match(pattern, message, re.S)
        if m:
            return say(m)
    return message


def _hint(message: str, typed: list[str], options: list[str]) -> str:
    """What to type instead, worked out from argparse's message before anything is cut: never the word typed."""
    unrecognized = message.startswith("unrecognized arguments: ")
    if unrecognized or re.match(rf"^{_ARG}invalid choice: ", message):
        before = typed[:typed.index("--")] if "--" in typed else typed
        for word in before:                 # `roster --session TOKEN vault …`: where a session goes, not --version
            option = word.partition("=")[0]
            if option == "--session" and (provider := _vault_typed(before)):
                return (f"vault {provider} takes the vault session from its environment, never the command line "
                        f"(`roster vault {provider} -- ARGS`)")
            if option in NOT_ROSTERS:
                return NOT_ROSTERS[option]
    if unrecognized:
        for word in message.removeprefix("unrecognized arguments: ").split():
            if word in options:                 # a real option, in the wrong place: `roster --json`, `hosts --sudo`
                return f"{word} goes after a command that takes it (`roster COMMAND --help` lists them)"
            near = difflib.get_close_matches(word, options, n=1, cutoff=0.7) if word.startswith("-") else []
            if near:
                return f"did you mean `{near[0]}`?"
        return ""
    m = re.match(rf"^{_ARG}invalid choice: (.*) \(choose from (.*)\)$", message, re.S)
    if not m:
        return ""
    choices = [c.strip().strip("'\"") for c in m[3].split(",")]
    near = difflib.get_close_matches(_unquote(m[2]), choices, n=1, cutoff=0.6)
    if near:
        return f"did you mean `{near[0]}`?"
    # an action's few choices are listed (vault has 7, T241); roster's many commands are not
    return f"one of: {', '.join(choices)}" if len(choices) <= 8 else "not a roster command"


def _vault_typed(words: list[str]) -> str:
    """The vault provider named after `vault` on the command line (`bw` or `op`), or '' (never a typed value: only
    one of those two names is returned)."""
    if "vault" in words:
        for word in words[words.index("vault") + 1:]:
            if word in ("bw", "op"):
                return word
    return ""


def _unquote(typed: str) -> str:
    """The word argparse quoted with %r (its repr), back as typed ('' when it isn't one)."""
    try:
        word = ast.literal_eval(typed)
    except (ValueError, SyntaxError):
        return ""
    return word if isinstance(word, str) else ""
