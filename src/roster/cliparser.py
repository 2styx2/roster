"""roster's argument parser: every command and option (build_parser), the one the CLI, its man page (manpage.py) and
its shell completion (completion.py) read. Each argument that takes names is tagged with the kind it takes
(values), for completion."""
# argparse has no public way to walk a parser: its _actions and _SubParsersAction it is
# pyright: reportPrivateUsage=false

import argparse
import functools
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, NoReturn, cast

from . import __version__, clihelp, jsonout
from .errors import ROSTER_ERROR

SHELLS = ("bash", "zsh", "fish", "powershell")

# what an argument's values are: the names in roster.yml (and the Inventory list) it takes
HOSTS, GROUPS, RESOURCES, INVENTORIES, FILES, DIRS = "hosts", "groups", "resources", "inventories", "files", "dirs"
ONLY = "only"              # a comma-separated LIST of the other kinds (--only)
COMMANDS = "commands"      # roster's own commands (`help COMMAND`)


def values(action: argparse.Action, *kinds: str, new_after: tuple[str, ...] = ()) -> argparse.Action:
    """Tag ACTION (an add_argument result) with the KINDs of name it takes, for completion; returns it. NEW_AFTER: the
    words (an action, `inv add`) after which it's a new name, so it completes nothing: an existing name would only
    invite a clash (#420)."""
    vars(action)["complete"] = kinds
    vars(action)["new_after"] = new_after
    return action



def wants_json(argv: "Sequence[str]") -> bool:
    """Is --json on the command line ARGV (before a `--`, after which the words are another program's)?"""
    argv = list(argv)
    return "--json" in (argv[:argv.index("--")] if "--" in argv else argv)


@dataclass
class Typed:
    """The command line roster's parsers judge: its WORDS (no usage error repeats one), whether it asks for --json
    (a usage error is JSON then), and ROOT, roster's own parser (the names that may be repeated)."""

    words: list[str] = field(default_factory=list[str])
    json_errors: bool = False
    root: "Parser | None" = None


class Parser(argparse.ArgumentParser):
    """roster's argument parser: with --json on the command line, a usage error is JSON on stderr (exit 2). A
    mistyped command gets the nearest name instead of the whole list, and every usage error says where help is.
    roster's own --help lists the commands in groups (clihelp.GROUPS) before its options. Its commands' parsers share
    its TYPED."""
    commands_text = ""

    def __init__(self, *args: Any, typed: Typed | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.typed = typed if typed is not None else Typed()

    def add_subparsers(self, **kwargs: Any) -> "argparse._SubParsersAction[Parser]":
        kwargs.setdefault("parser_class", functools.partial(Parser, typed=self.typed))
        return cast("argparse._SubParsersAction[Parser]", super().add_subparsers(**kwargs))

    def error(self, message: str) -> NoReturn:
        # a value typed in the wrong place (`roster --session TOKEN vault …`, `vault bw --write=VALUE`) may be a
        # password or a session token: no usage error repeats one
        root = self.typed.root or self
        message = clihelp.usage_error(message, self.typed.words, root.names(), self.all_options())
        if self.typed.json_errors:
            jsonout.fail(ROSTER_ERROR, f"{self.prog}: {message}", f"see `{self.prog} --help`")
            sys.exit(2)
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: {message}\n(`{self.prog} --help` shows how)\n")

    def names(self) -> set[str]:
        """Every name roster's parsers know (options, commands, choices): a typed one may be repeated."""
        found: set[str] = set()
        for a in self._actions:
            found.update(a.option_strings)
            if isinstance(a, argparse._SubParsersAction):
                choices = cast("argparse._SubParsersAction[Parser]", a).choices
                found.update(choices)
                for s in choices.values():
                    found |= s.names()
            elif a.choices:
                found.update(str(c) for c in a.choices)
        return found

    def all_options(self) -> list[str]:
        """Every --option of this parser and its commands' (an unknown one is reported by roster's own parser)."""
        found: list[str] = []
        for a in self._actions:
            found += [o for o in a.option_strings if o.startswith("--")]
            if isinstance(a, argparse._SubParsersAction):
                for s in cast("argparse._SubParsersAction[Parser]", a).choices.values():
                    found += s.all_options()
        return sorted(set(found))

    def format_help(self) -> str:
        text = super().format_help()
        if not self.commands_text:
            return text
        head, sep, tail = text.partition("\noptions:\n")
        return f"{head}\n{self.commands_text}\n{sep}{tail}" if sep else f"{text}\n{self.commands_text}\n"


def build_parser(argv: "Sequence[str]" = ()) -> Parser:
    """Every command and option, for the command line ARGV (its usage errors). The man page (roster.manpage) is
    generated from this too."""
    typed = Typed(list(argv), wants_json(argv))
    p = Parser(prog="roster", usage=clihelp.USAGE, formatter_class=clihelp.Formatter,
               description="Give this box (and Claude) access to the hosts in roster.yml.", typed=typed)
    typed.root = p
    p.add_argument("-v", "--version", action="version", version=f"roster {__version__}")
    which = p.add_mutually_exclusive_group()
    values(which.add_argument("-c", "--config", metavar="PATH", help="path to roster.yml (default: $ROSTER_CONFIG, "
                       "./roster.yml, the active named Inventory, then ~/.config/roster/roster.yml)"), FILES)
    values(which.add_argument("--inv", metavar="NAME", help="use the named Inventory NAME for this one command "
                              "(`roster inv list` names them)"), INVENTORIES)
    # no COMMAND: _main shows the overview. The commands are listed by commands_text (in groups), not argparse
    # prog: each command's usage is `roster run ...`, not built from the usage above (the man page's synopsis too)
    sub = p.add_subparsers(dest="cmd", metavar="COMMAND", help=argparse.SUPPRESS, prog="roster")
    only: dict[str, Any] = {"metavar": "LIST", "help": "only these hosts, groups, types or products (comma-separated)"}
    as_json: dict[str, Any] = {"action": "store_true", "help": "print JSON for scripts and tools, never a secret (see "
               "Machine-readable output in docs/cli-reference.md)"}
    s = sub.add_parser("init", help="write a new roster.yml: the commented example, a blank one, a copy, the team's "
                       "repo or the Hosts in ~/.ssh/config. It only makes a new file: to add Hosts to yours, use add or "
                       "discover")
    how = s.add_mutually_exclusive_group()
    how.add_argument("--blank", action="store_true", help="a short roster.yml with an empty group, instead of the "
                     "commented example (same as --inventory blank)")
    how.add_argument("--inventory", metavar="HOW", help="blank, file:PATH (a copy of that roster.yml, once it loads), "
                     "repo:URL (a git clone of the team's repo into roster.yml's folder, which must be empty) or "
                     "ssh-config[:PATH] (Hosts from ~/.ssh/config, or PATH: HostName, User, Port, IdentityFile)")
    s.add_argument("--name", metavar="NAME", help="name the new Inventory too (`roster inv add NAME PATH`), e.g. "
                   "beside one you keep")
    s = sub.add_parser("setup", help="install this Box's key on the Hosts that aren't set up yet and record their host "
                       "keys, then sync; run it again after adding Hosts")
    which = s.add_mutually_exclusive_group()
    values(which.add_argument("--only", **only), ONLY, HOSTS, GROUPS)
    values(which.add_argument("--host", metavar="NAME", help="only the Host by exactly this name, never a group, type "
                              "or product by it (--only would take those too)"), HOSTS)
    s.add_argument("--dry-run", action="store_true", help="show what would happen, change nothing remote")
    s.add_argument("--force", action="store_true", help="on a renamed Box, go ahead on a Host where another Box's "
                   "key line has the new name (its line is then this Box's to replace or revoke)")
    s.add_argument("--key-type", metavar="TYPE", help="with --host: try this SSH key type there, over roster.yml's "
                   "key_type: (ed25519, ecdsa, ecdsa-256, ecdsa-521, rsa, rsa-BITS), for this run only; its line goes "
                   "in beside the one of roster.yml's type, which stays. Set key_type: to keep it. With --rotate: "
                   "the type roster.yml gives the Hosts, checked")
    s.add_argument("--rotate", action="store_true", help="replace the Box key (this Box's own key, not a Mesh key: "
                   "`roster mesh --rotate HOST` does those) on every Host: a new key, proven on each Host before the "
                   "old key's line goes, then the old key deleted. --host NAME (a Host or a group) narrows it; a Host "
                   "not reached stays pending until setup --rotate runs again")
    s = sub.add_parser("sync", help="rewrite this Box's ssh config and Claude files from roster.yml, and sync the "
                       "vault (as roster vault sync); it touches no Host. Ends with what changed and the next command, "
                       "if any")
    s.add_argument("--no-vault", action="store_true", help="the map only: leave the vault as last synced")
    s = sub.add_parser("check", help="check: can this Box reach every Host? check HOST: why a Session to it would "
                       "fail, step by step. check --box: this Box's own health. check --auth: every Login's password "
                       "source answers")
    values(s.add_argument("host", nargs="?", help="diagnose this one Host: inventory, ssh config, vault, DNS, port, "
                   "host key, login (one connection)"), HOSTS)
    s.add_argument("--box", action="store_true", help="check this Box instead, without connecting anywhere: "
                   "roster.yml, ssh and its config, vault CLIs, askpass, the infra repo")
    s.add_argument("--auth", action="store_true", help="test each Login's password source (SSH, services, "
                   "resources) instead, connecting to no Host and printing nothing secret")
    which = s.add_mutually_exclusive_group()
    values(which.add_argument("--only", **only), ONLY, HOSTS, GROUPS)
    values(which.add_argument("--host", dest="hosts", action="append", metavar="NAME", help="check exactly this Host "
                              "(never a group or type by the name); again for more, as setup's last line names them"),
           HOSTS)
    s.add_argument("--json", **as_json)
    s = sub.add_parser("hosts", help="list the Hosts and resources in roster.yml; hosts NAME: everything about one; "
                       "hosts --resources: only the resources")
    values(s.add_argument("name", nargs="*", metavar="NAME", help="show everything about this one Host or resource; "
                          "fuzzy words work"), HOSTS, RESOURCES)
    s.add_argument("--resources", action="store_true", help="list only the resources (Wi-Fi networks, accounts and "
                   "secrets with no address); --only then takes resource names, types or groups, --find every field")
    values(s.add_argument("--only", **only), ONLY, HOSTS, GROUPS, RESOURCES)
    s.add_argument("--find", metavar="TEXT", help="search name, title, description, type, product, group, ip")
    s.add_argument("--all", action="store_true", help="include unreviewed (scanned) hosts")
    s.add_argument("--long", action="store_true", help="full table: type, product, web URL, description")
    s.add_argument("--json", **as_json)
    s = sub.add_parser("run", help="run a command on a host")
    s.add_argument("--sudo", action="store_true",
                   help="run it as root with sudo; roster gives sudo the login's password (never shown)")
    values(s.add_argument("host", help="the host to run it on"), HOSTS)
    s.add_argument("command", nargs=argparse.REMAINDER, help="the command, after --")
    s = sub.add_parser("add", help="add one Host you already know to roster.yml (reviewed), the app's add-Host "
                       "way")
    s.add_argument("name", metavar="NAME", nargs="?", help="the new Host's name: letters, digits, . _ - (needed "
                   "unless --from-vault)")
    s.add_argument("--ip", metavar="ADDR", help="its address: an IPv4 or IPv6 address or a DNS name (asked for in a "
                   "terminal when it's missing)")
    s.add_argument("--user", metavar="USER", help="the SSH user (default: its group's or defaults')")
    s.add_argument("--auth", metavar="REF", help="its Login: a vault item (bw:ITEM, op:...), env:VAR, prompt, key "
                   "... (default: its group's or defaults')")
    values(s.add_argument("--group", metavar="GROUP", help="the group it goes in: an existing one, or a new one "
                          "(default: the first group; asked in a terminal)"), GROUPS)
    on = s.add_mutually_exclusive_group()
    on.add_argument("--enroll", dest="enroll", action="store_true", default=None,
                    help="install this Box's key on it at setup (asked in a terminal; default: its group's)")
    on.add_argument("--no-enroll", dest="enroll", action="store_false", help="password logins only, no key")
    s.add_argument("--os", choices=["windows", "posix"], help="windows for a Windows Host with OpenSSH Server "
                   "(default: posix)")
    s.add_argument("--title", metavar="TEXT", help="a one-line title")
    s.add_argument("--type", metavar="TEXT", help="a free label (nas, switch, esxi, ...)")
    s.add_argument("--port", type=int, metavar="N", help="its SSH port (default: 22)")
    s.add_argument("--from-vault", action="store_true", help="fill --ip (and --port) from the --auth item's URI and "
                   "--user from its username, never reading its password (bw, op); flags given win. With no NAME: list "
                   "the vault items no Login in roster.yml names (new ones since the last run), and in a terminal "
                   "add each one [Y/n/edit/skip]")
    s.add_argument("--save-to-vault", action="store_true", help="save its password as a new vault item `NAME ssh` "
                   "(its address in the URI, --user as the username), then point its auth: at it; the password is "
                   "asked twice on the terminal, hidden, never taken from an argument or the environment")
    s.add_argument("--save-to", metavar="TARGET", help="with --save-to-vault: where the item goes for this run: "
                   "personal, ORGANIZATION/COLLECTION (bw) or GROUP (kp) (default: save_to: in roster.yml or init.lua)")
    s.add_argument("--provider", metavar="PROVIDER", help="with --save-to-vault: the vault to save in, bw or kp "
                   "(default: the vault roster.yml's Logins use most)")
    s.add_argument("--json", action="store_true", help="with --from-vault and no NAME: print the list as JSON, add "
                   "nothing")
    s.add_argument("--all", action="store_true", help="with --from-vault and no NAME: every item roster.yml doesn't "
                   "name, not only the new ones")
    s.add_argument("--mark-seen", action="store_true", help="with --from-vault and no NAME: remember every item "
                   "listed as seen, so it isn't new next time")
    s.add_argument("--no-sync", action="store_true", help="with --from-vault and no NAME: don't sync the vault first "
                   "(bw sync)")
    s.add_argument("--setup", action="store_true", help="then run setup for it alone (its host key, and this Box's "
                   "key on it when enrolled) and check it, and say how each went")
    s.add_argument("--dry-run", action="store_true", help="print the lines it would add; write nothing")
    s.add_argument("-y", "--yes", action="store_true", help="never ask: a missing value it can't default is an "
                   "error naming its flag")
    s = sub.add_parser("discover", help="scan networks (nmap if installed) for Hosts; --write adds the new ones to "
                       "roster.yml, unreviewed")
    s.add_argument("targets", nargs="+", metavar="CIDR", help="e.g. 10.0.1.0/24 (several allowed)")
    s.add_argument("--write", action="store_true", help="add the new Hosts it finds to roster.yml, unreviewed, for you "
                   "to name and review (default: preview only)")
    values(s.add_argument("--group", metavar="NAME", help="group name for new hosts (default: discovered-YYYYMMDD)"),
           GROUPS)
    s.add_argument("--ports", help="TCP ports to scan (default: common server, "
                   "web, database, remote-admin and network-gear ports)")
    s.add_argument("--top-ports", type=int, metavar="N", help="nmap only: scan nmap's N most common ports instead")
    s.add_argument("--no-ping", action="store_true", help="nmap only: scan hosts that don't answer ping (slower)")
    s.add_argument("--os", action="store_true", help="nmap only: OS detection (needs sudo)")
    s.add_argument("--builtin", action="store_true", help="use the built-in scanner even if nmap is installed")
    s.add_argument("--timeout", type=float, default=0.5, metavar="SECONDS",
                   help="built-in scanner connect timeout (default: 0.5)")
    s.add_argument("--force", action="store_true", help="allow scanning more than 4096 addresses")
    s.add_argument("--json", **as_json)
    s = sub.add_parser("web", help="HTTP request to a host's web service, logged in with its stored credentials")
    values(s.add_argument("request", nargs="+", metavar="HOST [SERVICE] METHOD PATH",
                          help="e.g. esxi GET /folder  or  orion3 https GET /api/status"), HOSTS)
    s.add_argument("-d", "--data", metavar="BODY", help="request body (@FILE reads a file)")
    s.add_argument("-H", "--header", action="append", metavar="HEADER", help="extra header 'Name: value' (repeatable)")
    s.add_argument("-k", "--insecure", action="store_true", help="don't verify the TLS certificate")
    s.add_argument("--timeout", type=float, default=30, metavar="SECONDS",
                   help="how long to wait for the answer (default: 30)")
    s = sub.add_parser("mesh", help="set up Host-to-Host access (mesh: and links: in roster.yml), one Host at a time")
    s.add_argument("action", nargs="?", choices=["cut", "status", "leftovers"],
                   help="cut HOST: take it out of the Mesh now, everywhere; status: who reaches whom (no connections); "
                        "leftovers: look on every Host, once, for Mesh entries this roster.yml doesn't ask for (this "
                        "Box's, or an older roster's with no Box in the tag); changes nothing without --remove")
    values(s.add_argument("target", nargs="?", metavar="HOST", help="with cut: the Host to cut out"), HOSTS)
    s.add_argument("--dry-run", action="store_true", help="show the plan; change nothing on any Host")
    values(s.add_argument("--rotate", action="append", metavar="HOST", help="replace HOST's Mesh key (repeatable)"),
           HOSTS)
    s.add_argument("-y", "--yes", action="store_true", help="with cut or leftovers --remove: don't ask first")
    s.add_argument("--all", action="store_true", help="with cut: every Mesh entry off every Host, roster.yml "
                   "unchanged (before removing roster from this Box)")
    s.add_argument("--remove", action="store_true", help="with leftovers: then remove them after a question (-y "
                   "doesn't ask): an older roster's may be another Box's Mesh")
    s.add_argument("--json", action="store_true", help="with status or --dry-run: print JSON for scripts and "
                   "tools, never a secret (see Machine-readable output in docs/cli-reference.md)")
    s = sub.add_parser("revoke", help="remove this box's key from all hosts")
    values(s.add_argument("--only", **only), ONLY, HOSTS, GROUPS)
    s.add_argument("--all", action="store_true", help="every Inventory on this box: each named one and the unnamed "
                   "one, with one question and one summary")
    s.add_argument("-y", "--yes", action="store_true", help="don't ask first")
    s = sub.add_parser("inv", help="named Inventories (work, home): list, add NAME PATH, use NAME, remove NAME, "
                       "or which (the roster.yml roster uses)")
    s.add_argument("action", choices=["list", "add", "use", "remove", "which"],
                   help="list (the active one marked *), add NAME PATH, use NAME (make it the active one), "
                        "remove NAME (forget the name; the file stays), which (print the roster.yml roster uses)")
    values(s.add_argument("name", nargs="?", metavar="NAME", help="the Inventory's name: letters, digits, . _ -"),
           INVENTORIES, new_after=("add",))
    values(s.add_argument("path", nargs="?", metavar="PATH", help="with add: its roster.yml"), FILES)
    s.add_argument("--json", **as_json)
    s = sub.add_parser("vault", help="roster's own views of the vault: status, sync, reveal NAME, and bw -- ARGS "
                       "and op -- ARGS (the Bitwarden and 1Password CLIs themselves)")
    vault = s.add_subparsers(dest="vault_cmd", metavar="ACTION", title="actions", prog="roster vault",
                             help="what to do with the vault (plain `roster vault` lists them)")
    s = vault.add_parser("status", help="the password providers here (built-in, plugins, roster.yml), whether their "
                         "tools are installed, unknown ones in use, each vault's state (logged in, locked) and when it "
                         "last synced")
    s.add_argument("--json", **as_json)
    vault.add_parser("sync", help="sync every vault that keeps a local copy (Bitwarden: bw sync), then say which "
                     "items were added, changed or removed since the last sync: names and counts, never a secret")
    s = vault.add_parser("unlock", help="unlock Bitwarden and keep it unlocked for every roster run on this Box "
                         "(the session is saved in the bw-session file) until roster vault lock, bw lock or the "
                         "roster app's lock; Bitwarden only for now")
    s.add_argument("provider", nargs="?", metavar="PROVIDER", help="bw (the default and, for now, the only one: "
                   "KeePassXC keeps no session, and 1Password's op signin keeps its own)")
    s = vault.add_parser("lock", help="bw lock, then remove the saved session (the bw-session file); every bw session "
                         "on this Box is locked, the roster app's too")
    s.add_argument("provider", nargs="?", metavar="PROVIDER", help="bw (the default and, for now, the only one)")
    s = vault.add_parser("reveal", help="print a resource's secret (e.g. a Wi-Fi password) for a person to type in, "
                         "not for Claude")
    values(s.add_argument("name", help="the resource"), RESOURCES)
    s.add_argument("--wifi", action="store_true", help="print a WIFI:... string for a QR code instead")
    s = vault.add_parser("bw", help="run the Bitwarden CLI itself with this Box's vault session (bw-session file), "
                         "read-only unless --write; roster never reads what it prints")
    s.add_argument("--write", action="store_true",
                   help="allow bw commands that change the vault, write a file here or act on the account "
                        "(create, edit, delete, export, receive, --output, login, logout, unlock, lock, config, ...)")
    s.add_argument("args", nargs=argparse.REMAINDER, metavar="BW_ARGS", help="arguments for bw, after --")
    s = vault.add_parser("op", help="run the 1Password CLI itself with your op sign-in, read-only unless --write; "
                         "roster never reads what it prints")
    s.add_argument("--write", action="store_true",
                   help="allow op commands that change the vault or the account or write a file here (item create, "
                        "item edit, item delete, item share, --out-file, signin, signout, account add, update, ...)")
    s.add_argument("args", nargs=argparse.REMAINDER, metavar="OP_ARGS", help="arguments for op, after --")
    s = sub.add_parser("help", help="this overview; help COMMAND: a command's options and examples; --man: the "
                       "manual; --completion SHELL: Tab completion")
    values(s.add_argument("topic", nargs="*", metavar="COMMAND", help="the command (and its action: vault bw) to show "
                          "the help of"), COMMANDS)
    s.add_argument("--man", action="store_true", help="show the roster(1) man page")
    s.add_argument("--install", action="store_true", help="with --man: copy it to PREFIX/share/man/man1/, next to "
                   "PREFIX/bin/roster (~/.local for uv tool install), where `man roster` finds it")
    values(s.add_argument("--prefix", metavar="DIR", help="with --man --install: install into DIR/share/man/man1/ "
                          "instead"), DIRS)
    s.add_argument("--completion", choices=SHELLS, metavar="SHELL", help="print Tab completion for bash, zsh, fish "
                   "or powershell (install.sh turns it on)")
    # run by the app or by ssh, not by hand: kept out of the overview (clihelp.INTERNAL)
    sub.add_parser("serve", help="JSON-RPC API on stdin/stdout for the desktop app (see docs/serve-api.md)")
    s = sub.add_parser("askpass", help="SSH_ASKPASS helper for a `roster serve` password Session (ssh runs it)")
    s.add_argument("prompt", nargs="?", default="", help="the prompt ssh shows")
    helps = describe(sub)
    p.commands_text = clihelp.overview(helps)
    p.epilog = clihelp.more()
    return p


def describe(sub: "argparse._SubParsersAction[Parser]", prefix: str = "") -> dict[str, str]:
    """Each command's --help opens with its one-line help as a sentence and ends with examples (clihelp), a command
    with actions of its own (vault) too. Returns {name: one-line help}."""
    helps = {a.dest: a.help or "" for a in sub._choices_actions}
    for name, s in sub.choices.items():
        s.description = clihelp.description(helps[name])
        s.epilog = clihelp.examples_text(f"{prefix}{name}") or None
        s.formatter_class = clihelp.Formatter
        for a in s._actions:
            if isinstance(a, argparse._SubParsersAction):
                describe(cast("argparse._SubParsersAction[Parser]", a), f"{prefix}{name} ")
    return helps


def check(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    """Options a command takes but not together (or not without another): a usage error from PARSER."""
    if args.cmd == "discover" and args.json and args.write:
        parser.error("--json goes with discover's preview, not --write: drop one of them")
    if args.cmd == "inv":
        takes = {"list": 0, "which": 0, "use": 1, "remove": 1, "add": 2}[args.action]
        if len([x for x in (args.name, args.path) if x is not None]) != takes:
            parser.error({0: f"inv {args.action} takes no NAME or PATH", 1: f"usage: roster inv {args.action} NAME",
                          2: "usage: roster inv add NAME PATH"}[takes])
        if args.json and args.action not in ("list", "which"):
            parser.error("--json goes with inv list or inv which")
    if args.cmd == "mesh" and args.json and args.action != "status" and not (args.dry_run and not args.action):
        parser.error("--json goes with mesh status or mesh --dry-run: it never applies the Mesh")
    if args.cmd == "mesh" and args.remove and args.action != "leftovers":
        parser.error("--remove goes with leftovers: roster mesh leftovers --remove")
    if args.cmd == "hosts" and args.name:
        listed = [f for f, on in (("--resources", args.resources), ("--find", args.find), ("--all", args.all),
                                  ("--long", args.long), ("--only", args.only)) if on]
        if listed:
            parser.error(f"hosts NAME shows one Host or resource: {', '.join(listed)} go"
                         f"{'es' if len(listed) == 1 else ''} with the list (drop NAME or the flag)")
    if args.cmd == "check" and args.auth and (args.box or args.host):
        parser.error("check --auth tests the Logins' password sources: it takes no HOST or --box (--only narrows it)")
    if args.cmd == "check" and args.box and (args.host or args.only or args.hosts):
        parser.error("check --box takes no HOST, --host or --only: it checks this Box, not its Hosts")
    if args.cmd == "check" and args.host and not args.box and (args.hosts or args.only):
        parser.error("check HOST diagnoses one Host step by step: drop --host and --only")
    if args.cmd == "add" and args.name is None and not args.from_vault:
        parser.error("roster add needs NAME, the new Host's name")
    if args.cmd == "add" and args.name is not None:
        listed = [f for f, on in (("--json", args.json), ("--all", args.all), ("--mark-seen", args.mark_seen),
                                  ("--no-sync", args.no_sync)) if on]
        if listed:
            parser.error(f"{', '.join(listed)} go{'es' if len(listed) == 1 else ''} with --from-vault and no NAME "
                         "(the list of vault items): drop NAME or the flag")
    if args.cmd == "add" and args.save_to_vault:
        clash = [f for f, on in (("--auth", args.auth), ("--from-vault", args.from_vault)) if on]
        if clash:
            parser.error(f"--save-to-vault makes a new vault item for the Login: drop {' and '.join(clash)} (--auth "
                         "points at an item that's already there)")
    if args.cmd == "add" and not args.save_to_vault and (args.save_to or args.provider):
        parser.error("--save-to and --provider go with --save-to-vault")
    if args.cmd == "revoke" and args.all and (args.only or args.inv or args.config):
        parser.error("revoke --all revokes every Inventory's Hosts: drop --only, --inv and -c")


def command_parser(parser: argparse.ArgumentParser, words: Sequence[str]) -> argparse.ArgumentParser:
    """The parser of `roster WORDS...` (`vault bw`), or a usage error naming the word that isn't a command."""
    for i, w in enumerate(words):
        found = next((cast("argparse._SubParsersAction[argparse.ArgumentParser]", a).choices for a in parser._actions
                      if isinstance(a, argparse._SubParsersAction)), dict[str, argparse.ArgumentParser]())
        if w not in found:
            lists = f"`roster help {' '.join(words[:i])}` lists its commands" if i else "`roster help` lists the commands"
            parser.error(f"no help for that {clihelp.HIDDEN}: {lists}")
        parser = found[w]
    return parser
