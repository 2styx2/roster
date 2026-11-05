"""What `roster vault bw` and `roster vault op` let through to the vault's own CLI: a fail-closed allowlist of its
commands (T202, decision Q178 for bw; T223, decision Q197 for op), read-only unless --write. Each check returns the
command it allows, or die()s saying why not; nothing after the command is ever repeated, as it may hold a password
or a token."""

import re

from .common import die
from .errors import (
    BW_NEEDS_WRITE,
    BW_NOT_ALLOWED,
    BW_REFUSED,
    OP_NEEDS_WRITE,
    OP_NOT_ALLOWED,
    OP_REFUSED,
)

# ---------------------------------------------------------------- bw

# Read-only means no change to the vault and no file written on this Box: `get attachment` and any `--output` write
# one, and `receive` writes what a Send from anyone's URL holds, so they need --write.
BW_READ = frozenset({"list", "get", "status", "sync", "generate", "encode", "help", "completion", "update"})
BW_WRITE = frozenset({"create", "edit", "delete", "restore", "move", "share", "confirm", "import", "send",
                      "device-approval", "export", "receive"})  # change the vault, or write files here
BW_ACCOUNT = frozenset({"login", "logout", "unlock", "lock", "config"})  # need --write too
BW_PROMPTS = frozenset({"login", "unlock"})  # ask for the master password on the terminal: no --nointeraction added
BW_FLAGS = frozenset({"--pretty", "--raw", "--response", "--cleanexit", "--quiet", "--nointeraction",
                      "-h", "--help", "-v", "--version"})  # bw's own options that may come before its command


def bw_command(argv, write):
    """The bw command ARGV runs (None for bw's bare options, `--help` or `--version`), or die() saying why it may not
    run. Nothing after the command is ever repeated: it may hold a password."""
    if any(a == "--session" or a.startswith("--session=") for a in argv):
        die(f"[{BW_REFUSED}] roster vault bw won't put a session key on bw's command line, where other programs can read "
            "it: roster passes this Box's session in bw's environment (drop --session)")
    if "--write" in argv:
        die(f"[{BW_NOT_ALLOWED}] --write is roster's, not bw's: put it before bw's command "
            "(roster vault bw --write -- edit item ...)")
    cmd = next((a for a in argv if not a.startswith("-")), None)
    if any(a not in BW_FLAGS for a in argv[:argv.index(cmd) if cmd else len(argv)]):
        die(f"[{BW_NOT_ALLOWED}] roster vault bw takes only these bw options before the command: "
            f"{', '.join(sorted(BW_FLAGS))}")
    rest = argv[argv.index(cmd) + 1:] if cmd else []
    writes_file = any(a == "--output" or a.startswith("--output=") for a in argv) or \
        (cmd == "get" and any(a.lower() == "attachment" for a in rest))  # bw lowercases it, options may go first
    if (cmd is None or cmd in BW_READ) and not writes_file:
        return cmd
    if cmd == "serve":
        die(f"[{BW_REFUSED}] roster vault bw won't run bw serve: it would hand the unlocked vault to every program on this "
            "Box that can reach its port. Run bw serve yourself if you need it")
    if cmd in BW_WRITE or cmd in BW_ACCOUNT or writes_file:
        if not write:
            what = "acts on the vault's account" if cmd in BW_ACCOUNT else \
                "writes the whole vault out" if cmd == "export" else \
                "writes a file on this Box" if cmd == "receive" or writes_file else "changes the vault"
            die(f"[{BW_NEEDS_WRITE}] bw {cmd} {what}, and roster vault bw is read-only unless you say so: "
                f"roster vault bw --write -- {cmd} ...")
        return cmd
    die(f"[{BW_NOT_ALLOWED}] roster vault bw runs only the bw commands it knows (the first word isn't one of them, and "
        f"isn't repeated here): {', '.join(sorted(BW_READ))}; with --write, {', '.join(sorted(BW_WRITE | BW_ACCOUNT))}")



# ---------------------------------------------------------------- op

# `roster vault op` (T223, #432, decision Q197): the 1Password CLI as `roster vault bw` runs bw (Q178). op's commands are
# a tree (op item get, op vault user grant), checked against 1Password's CLI reference, as a fail-closed allowlist: a
# command in none of these sets (one a newer op adds, an alias, a typo) is refused, never assumed safe. Read-only means
# no change to the vault or the account and no file written on this Box.
OP_READ = frozenset({"account get", "account list", "completion", "connect server get", "connect server list",
                     "connect token list", "document get", "document list", "group get", "group list",
                     "group user list", "help", "inject", "item get", "item list", "item template get",
                     "item template list", "plugin inspect", "plugin list", "read", "service-account ratelimit",
                     "user get", "user list", "vault get", "vault list", "vault group list", "vault user list",
                     "whoami"})
OP_WRITE = frozenset({"connect group grant", "connect group revoke", "connect server create", "connect server delete",
                      "connect server edit", "connect token create", "connect token delete", "connect token edit",
                      "connect vault grant", "connect vault revoke", "document create", "document delete",
                      "document edit", "events-api create", "group create", "group delete", "group edit",
                      "group user grant", "group user revoke", "item create", "item delete", "item edit", "item move",
                      "item share", "plugin clear", "plugin init", "service-account create", "update",
                      "user confirm", "user delete", "user edit", "user provision", "user reactivate",
                      "user recovery begin", "user suspend", "vault create", "vault delete", "vault edit",
                      "vault group grant", "vault group revoke", "vault user grant", "vault user revoke"})
OP_ACCOUNT = frozenset({"account add", "account forget", "signin", "signout"})  # need --write too
OP_NEVER = frozenset({"run", "plugin run"})      # start another program with op's sign-in and secrets in its env
OP_COMMANDS = OP_READ | OP_WRITE | OP_ACCOUNT | OP_NEVER
OP_GROUPS = frozenset(" ".join(c.split()[:n]) for c in OP_COMMANDS for n in range(1, len(c.split())))
OP_FLAGS = frozenset({"--debug", "--no-color", "--iso-timestamps", "-h", "--help"})  # op's own options that take no
#                                                                    value and may come before its command


def op_writes_file(a):
    """Does argument A ask op to write a file here: --out-file in any form, or a short-option cluster with o in it
    (-o, -fo PATH, -oPATH; pflag reads -abc as -a -b -c)? Over-strict for an odd positional, which fails closed."""
    return a == "--out-file" or a.startswith("--out-file=") or (a.startswith("-") and not a.startswith("--")
                                                                 and "o" in a.split("=", 1)[0])


def op_command(argv, write):
    """The op command ARGV runs ("item get"; None for op's bare options, `--help`), or die() saying why it may not run.
    The command is the words right after op's own valueless options, and must be one op has (or one of its groups,
    alone, which prints its help): an option among the words could make op take another command than roster checked.
    Nothing past the command is ever repeated: it may hold a password or a token."""
    for a in argv:
        flag = a.split("=", 1)[0]
        if flag == "--session":
            die(f"[{OP_REFUSED}] roster vault op won't put a session token on op's command line, where other programs "
                "can read it: op takes your sign-in from its environment (drop --session)")
        if flag == "--config":
            die(f"[{OP_REFUSED}] roster vault op won't point op at another configuration folder (--config): it holds "
                "op's accounts and sign-ins. Drop --config, or run op yourself")
    if "--write" in argv:
        die(f"[{OP_NOT_ALLOWED}] --write is roster's, not op's: put it before op's command "
            "(roster vault op --write -- item edit ...)")
    start = next((i for i, a in enumerate(argv) if not a.startswith("-")), len(argv))
    if any(a not in OP_FLAGS for a in argv[:start]):
        die(f"[{OP_NOT_ALLOWED}] roster vault op takes only these op options before the command: "
            f"{', '.join(sorted(OP_FLAGS))}; put the others (--account, --format, --vault, ...) after it")
    words = []
    for a in argv[start:]:
        if a.startswith("-"):
            break
        if not re.fullmatch(r"[a-z-]+", a):            # "item get" as one argument: op would take it as one word
            if " ".join(words) in OP_COMMANDS:          # past the command, an argument may hold anything
                break
            die(f"[{OP_NOT_ALLOWED}] roster vault op runs only the op commands it knows, one word per argument "
                "(a word here has a space or another character op's commands don't, and isn't repeated)")
        if " ".join([*words, a]) not in OP_COMMANDS | OP_GROUPS:
            break
        words.append(a)
    cmd = " ".join(words) or None
    rest = argv[start + len(words):]
    if cmd in OP_GROUPS and not all(a in ("-h", "--help") for a in rest):    # alone, a group prints its help
        die(f"[{OP_NOT_ALLOWED}] roster vault op runs only the op commands it knows, written out in full before any "
            f"option (op {' '.join(words)} ... isn't one of them, and isn't repeated here)")
    if cmd is None and start < len(argv):
        die(f"[{OP_NOT_ALLOWED}] roster vault op runs only the op commands it knows (the first word isn't one of "
            f"them, and isn't repeated here): {', '.join(sorted(OP_READ))}; with --write, "
            f"{', '.join(sorted(OP_WRITE | OP_ACCOUNT))}")
    writes_file = any(op_writes_file(a) for a in rest)
    if cmd in OP_NEVER:
        die(f"[{OP_REFUSED}] roster vault op won't run op {cmd}: it starts another program with op's sign-in and your "
            "secrets in its environment. Run op yourself if you need it")
    if (cmd is None or cmd in OP_READ or cmd in OP_GROUPS) and not writes_file:
        return cmd
    if not write:
        what = "acts on the account" if cmd in OP_ACCOUNT else \
            "writes a file on this Box" if writes_file or cmd in ("update", "connect server create") else \
            "changes the vault or the account"
        die(f"[{OP_NEEDS_WRITE}] op {cmd} {what}, and roster vault op is read-only unless you say so: "
            f"roster vault op --write -- {cmd} ...")
    return cmd
