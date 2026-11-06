"""Stable error codes and the Problem they come in: what `roster serve`, the askpass channel, `roster check HOST`
and the CLI's die() report (docs/app/errors.md is the catalog). The app switches on the code; the message is
roster's usual wording, ready to show to a person, and never holds a secret. `fix` says what to do about it, in a
sentence.

Nothing else of roster's is imported here: serve, the CLI, the providers and the askpass helper take their codes from
this module, and a provider's kinds of failure carry their own (providers/problems.py). The app and the Rust core
read them by name from docs/serve-contract.json (scripts/gen-serve-api.py)."""

from typing import Any

# ---- JSON-RPC's own codes, which serve answers with too
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
JSON_RPC = ("PARSE_ERROR", "INVALID_REQUEST", "METHOD_NOT_FOUND", "INVALID_PARAMS", "INTERNAL_ERROR")

# ---- the codes (docs/serve-api.md lists them all)
INVENTORY_ERROR = 1         # roster.yml wasn't found or doesn't load (catalog row 1)
UNKNOWN_HOST = 2            # no Host by that name
ROSTER_ERROR = 3            # any other refusal roster gives on the command line ("error: ...")
BUSY = 4                    # serve: another request held what this one needs (roster.yml, the vault) past its wait;
                            #   nothing was done. data.busy: what, data.method: the request holding it (API 20)
CANCELLED = 5               # serve: $/cancel stopped the request before it did anything (queued, or waiting for a
                            #   lock): nothing was done (API 21)

WRONG_PASSWORD = 10         # vault.*: the master password didn't unlock the vault
NOT_LOGGED_IN = 11          # the vault CLI isn't logged in on this box (row 6)
CLI_MISSING = 12            # the vault CLI isn't installed (row 6)
UNSUPPORTED = 13            # the provider has no master password, or no Host Login uses one
VAULT_LOCKED = 14           # a secret was needed but the vault is locked (row 7)
ALREADY_SIGNED_OUT = 15     # vault.logout: the CLI isn't signed in to an account, so there's none to sign out of
SIGN_OUT_FAILED = 16        # vault.logout: the CLI refused to log out; every secret was forgotten anyway

NOT_REVIEWED = 20           # session.*: the Host has reviewed: false (row 3)
NOT_SET_UP = 21             # this box can't run `ssh NAME` yet: no ssh, or not in roster's ssh config (row 2)
NO_ASKPASS = 22             # a password Session, but this process has no askpass channel (in-process use only)
HOST_KEY_CHANGED_WHILE_ASKED = 23  # host.trust_key: the Host offers another key than the one the user was asked
                            # about before its Session; nothing is recorded

# Logins: what's wrong with a Host's ssh Login or its vault item (rows 4, 5, 8-10, 18)
NO_USER = 30                # the Host's ssh user is discover's placeholder CHANGE-ME (row 4)
NO_PROVIDER = 31            # the Login's provider (the `keeper:` in keeper:ITEM) isn't set up on this box (row 5)
ITEM_NOT_FOUND = 32         # no vault item by that name (row 8); data.near: similar item names
SEVERAL_ITEMS = 33          # several vault items match (row 9); data.matches: [{name, revised, uris}]
NO_FIELD = 34               # the item has no password, or no such #FIELD (row 10)
LOOKUP_FAILED = 35          # the provider failed some other way; the message is the provider's
UNEXPECTED_PROMPT = 36      # askpass: the Host asked something other than the Login password (row 18)
TOKEN_SPENT = 37            # askpass: the one-time token is used, expired or cleared by vault.lock
NO_SERVE = 38               # askpass: the helper couldn't reach `roster serve`
PASSWORD_NEEDED = 39        # session.prepare: the Host's Login is auth: prompt, so the app asks for its password

# host.check's network and Host steps (rows 11-17, 19)
NO_DNS = 40                 # the address doesn't resolve (row 15)
REFUSED = 41                # the ssh port refused the connection (row 16)
TIMEOUT = 42                # no answer from the ssh port (row 17; a rate limiter can cause it: rate_limited:)
HOST_KEY_CHANGED = 43       # the Host's key isn't the recorded one (row 13): never accepted automatically
HOST_KEY_UNKNOWN = 44       # no recorded host key for this Host (row 14)
PASSWORD_REFUSED = 45       # the Host refused the Login's password (row 11)
KEY_REFUSED = 46            # the Host refused this box's key (row 12)
TOO_MANY_AUTH = 47          # the Host cut the connection after too many key attempts (row 19)
AUTH_FAILED = 48            # the login failed some other way; details has ssh's own message
NO_CHECK = 49               # host.check_job: no check by that id in this serve (API 21)

# vault.login: signing the vault CLI in on this box (docs/app/dev/vault-auth.md).
# A wrong email or master password is 10, a provider with no sign-in here 13, no CLI 12.
CODE_REJECTED = 50          # the two-step or new-device code was wrong or expired; data.step: type a new one
METHOD_UNSUPPORTED = 51     # the account's two-step method (FIDO2, Duo) or SSO decryption isn't one the CLI can do
RATE_LIMITED = 52           # the server refused: too many attempts
SERVER_UNREACHABLE = 53     # the vault's server didn't answer (network, wrong address, TLS)
ALREADY_LOGGED_IN = 54      # the CLI is already logged in on this box: unlock instead
NO_SIGN_IN = 55             # no sign-in in progress (finished, cancelled, superseded or idle 10 minutes)
SSO_FAILED = 56             # SSO in the browser failed or wasn't finished in time
BAD_SERVER = 57             # the server address isn't one
API_KEY_REJECTED = 58       # the API key wasn't accepted, or it's an organization key
SIGN_IN_FAILED = 59         # the sign-in failed some other way; the message has the CLI's own words

# vault.create_item / vault.undo_create: "Save to vault" (Q43). Locked is 14, no CLI 12, not logged in 11.
ITEM_EXISTS = 60            # a vault item by exactly that name already exists; data.matches: [{name, revised, uris}]
CANT_WRITE = 61             # the provider can only read Logins (bw and kp can create items)
WRITE_FAILED = 62           # the vault CLI refused the create or delete; the message has its words, never a value
NOT_CREATED_HERE = 63       # vault.undo_create: this serve didn't create that item, or it's already undone
UNKNOWN_TARGET = 64         # save_to names an organization, collection or group that isn't there; the
                            #   message names the setting (roster.yml's, init.lua's, or the choice)
READ_ONLY_TARGET = 65       # save_to names a collection the account may only read; nothing was left behind
# "Save to vault" after a Session's own login (Q43): quick.save and host.save_login
LOGIN_NOT_SEEN = 66         # the Session hasn't logged in with the typed password (yet, or it was refused)
NOTHING_HELD = 67           # no typed password held for that Session: never asked for, already saved, or forgotten

# Editing the Inventory: Pending changes. The verify_login steps reuse 30-48.
NOT_A_REPO = 70             # roster.yml isn't tracked in a git repo, so it can't have Pending changes
DIRTY = 71                  # inventory.pull: uncommitted changes (Pending changes, or other files); data.files
DIVERGED = 72               # inventory.pull: this box's branch and its upstream both have new commits
PULL_FAILED = 73            # inventory.pull: the fetch or the fast-forward failed (network, access, a file in the way)
INVALID_EDIT = 74           # host.update: the result wouldn't load, or would change more than asked; nothing written
NOT_VERIFIED = 75           # host.update: address, user or Login changed without a test login that just succeeded

# Adding a Host (Q43). A failed test login answers with its step's own code (40-48, 30-35) and data.steps.
INVALID_HOST = 80           # host.add: a bad name, group, address, user or port, or no user to log in as; data.field
HOST_EXISTS = 81            # host.add: a Host by that name is already in the Inventory; data.group

# Publishing the Pending changes (Q13): commit roster.yml, push it, never force. A failed fetch is 73.
NOTHING_TO_PUBLISH = 90     # changes.publish: roster.yml has no Pending changes
OTHER_CHANGES = 91          # changes.publish: other files in the infra repo are uncommitted too; data.files
REMOTE_MOVED = 92           # changes.publish: the upstream changed roster.yml since this box's copy; nothing published
UNPUSHED = 93               # changes.publish: this box has its own commits that aren't on the upstream; data.ahead
NO_UPSTREAM = 94            # changes.publish: the branch has no upstream to push to
COMMIT_FAILED = 95          # changes.publish: git refused the commit (no identity, a hook); Pending changes kept
PUSH_FAILED = 96            # changes.publish: the push failed or was rejected; the commit is undone, changes kept

# The Live Inventory: removing, renaming and moving Hosts, and groups. A bad name is 80, an unknown Host
# 2, a result that wouldn't load (or would change another entry) 74; a roster.yml that doesn't load right now is 1.
NAME_TAKEN = 100            # host.rename / group.new / group.rename: that name is already a Host's or a group's; data.kind
UNKNOWN_GROUP = 101         # no group by that name in roster.yml; data.group
GROUP_NOT_EMPTY = 102       # group.delete: the group still has Hosts and no `to` says where they go; data.hosts
WOULD_CHANGE = 103          # host.move / group.delete: the Host would come out different in the new group; data.fields

# The Mesh (decision Q63). roster.yml's mesh:/links: that don't load are 1, an unknown Host 2.
NOT_A_SOURCE = 110          # mesh.plan / mesh.apply: rotate names a Host that isn't a Mesh source (has no Mesh key);
                            #   data.hosts
MESH_BUSY = 111             # mesh.plan / mesh.apply / mesh.cut while a Mesh job (background: true) still runs;
                            #   data.job, data.action

# Discover in roster serve: a scan of a network, run in the background. A bad target is -32602.
SCAN_RUNNING = 120          # discover.start: a scan is going already (one at a time); data.scan
TOO_MANY_ADDRESSES = 121    # discover.plan / discover.start: more addresses than allowed; data.addresses, limit, max
NO_SCAN = 122               # discover.status / stop / add: no scan by that id in this serve (or none yet)
CANT_ADD = 123              # discover.add: an address the scan didn't find, or one already in the Inventory or added;
                            #   data.addresses

# Filling a password prompt in a Session (decision Q129): session.fill
FILL_REFUSED = 130          # the prompt isn't provably this Host's own Login's (another Host or account, su's bare
                            #   Password:), or the Host changed since the Session connected; data.prompt: what roster
                            #   read it as (sudo, su, ssh), when it is one
NOTHING_TO_FILL = 131       # the Login that would answer has no saved password (auth: agent, key, none, prompt)

# Named Inventories: `roster inv`, `roster --inv`, serve's inventories.*, and the warnings
# `roster check --box` (box.check), setup and sync give when the same machine is in two Inventories (catalog rows
# 188-195). The warnings are never errors, and compare host-key fingerprints only, never a secret.
UNKNOWN_INVENTORY = 140     # no named Inventory by that name (`--inv`, inv use/remove, inventories.use); data.names
INVENTORY_TAKEN = 141       # inv add: the name, the file or its folder is already a named Inventory's
BAD_INVENTORY = 142         # inv add: a bad name, or no file at the path
INVENTORIES_UNREADABLE = 143  # roster's list of named Inventories (inventories.json) doesn't load
OTHER_DOESNT_LOAD = 144     # warning: another named Inventory's roster.yml isn't there or doesn't load, so it isn't
                            #   compared
SAME_MACHINE = 145          # warning: a Host here and one in another Inventory have the same host key
SAME_HOST_NAME = 146        # warning: the same Host name in two Inventories (`ssh NAME` reaches the active one's)
SAME_ADDRESS = 147          # warning: the same address and port in two Inventories, with different host keys
INDEX_NOT_WRITTEN = 148     # warning: the named Inventories' ssh config index is stale and couldn't be rewritten
                            #   (a read-only ~/.ssh); the command goes on (catalog row 206)
SSH_REFUSES_SCRIPT = 149    # revoke: this Box's ssh is a batch file (a .cmd/.bat shim on Windows), and roster won't
                            #   hand it the key-removal script, which holds characters cmd.exe acts on; nothing is
                            #   revoked (catalog row 207)

# Windows Hosts (decision Q174): `os: windows` in roster.yml, and the PowerShell scripts setup, revoke and
# check run there (catalog rows 212-216)
WINDOWS_TYPE_NO_OS = 154    # warning: a Host has type: windows but no os:, so roster treats it as POSIX (sh scripts)
LOOKS_LIKE_WINDOWS = 155    # a POSIX script failed with Windows' "'sh' is not recognized": the Host wants os: windows
NOT_WINDOWS = 156           # an os: windows Host has no PowerShell, or says it isn't Windows: nothing was changed
KEY_FILE = 157              # a Windows Host's key file roster won't touch (UTF-16, a BOM, an sshd_config it can't
                            #   follow, an ACL it couldn't set), or, as a warning, one whose ACL lets others in
CONNECTION_SHARING = 158    # ssh's shared connection (ControlMaster) was refused ("No existing session"), not a login

# Windows Hosts, part 2 (decision Q176): `roster run` there under PowerShell, and what roster won't do there
# (catalog rows 219-221)
RUN_SUDO_WINDOWS = 159      # `run --sudo` on an os: windows Host: Windows has no sudo over ssh; refused before the vault
MESH_WINDOWS = 160          # a note, not an error: an os: windows Host is left out of the Mesh (its scripts are sh)
NOT_POWERSHELL = 161        # `run` on an os: windows Host: the command doesn't parse as PowerShell, so nothing ran

# Whose it is (catalog row 222): a warning `roster check --box` (box.check) gives
SHARED_BOX_NAME = 162       # warning: this Box's name is an OS image's default hostname, so another Box likely has
                            #   it too; Boxes with one name are one owner (its key's tag and the Mesh's)

# `roster vault bw` (decision Q178): read-only unless --write, and a fail-closed allowlist (catalog rows 224-226).
# None of the three messages repeats what came after bw's command: those arguments may hold a password
BW_NEEDS_WRITE = 164        # a bw command that changes the vault, writes it out, or acts on the account, without --write
BW_NOT_ALLOWED = 165        # a bw command or option before it that roster vault bw doesn't know, or --write among bw's own
BW_REFUSED = 166            # never run: `bw serve` (the vault to every local program) or a session on the command line

# A new Inventory (decision Q182): `roster init --inventory HOW` (catalog rows 230-233, 235)
INVENTORY_THERE = 170       # roster init: a roster.yml is there already, so it's kept as it is; nothing written
NOT_AN_INVENTORY = 171      # roster init: the file to import isn't there or doesn't load, or a clone has no roster.yml
CLONE_FAILED = 172          # roster init: git couldn't clone the repo (or isn't installed, or the folder isn't empty)
SSH_CONFIG_UNREADABLE = 173  # roster init: the ssh config to import Hosts from can't be read; nothing written
FOLDER_NOT_WRITABLE = 174   # roster init / inventory.create: the folder can't be made or written in; nothing written

# Adding one Host (decision Q190): `roster add` and serve's host.add, one implementation (addhost.py)
# (catalog rows 245-247)
ADDRESS_TAKEN = 184         # a Host at that address (and SSH port) is in roster.yml already; data.host, data.group
NEEDS_FLAG = 185            # roster add without a terminal (or with --yes): a value it can't guess; the flag is named
NO_ITEM_FIELDS = 186        # the vault can't give an item's address and user without reading its password

# The vault items roster.yml doesn't name yet (decision Q191): `roster add --from-vault` with no NAME
# (catalog rows 248-249)
LIST_FAILED = 187           # the vault couldn't list its items (bw list items, its filter, op item list, kp ls) or sync
NO_LISTABLE_VAULT = 188     # roster.yml uses no vault that can list its items without roster reading their passwords

# A Box's key (decision Q193; catalog row 251)
BOX_NAME_TAKEN = 190        # setup on a renamed Box: another key's line on that Host has the new name; --force goes on

# `roster vault op` (decision Q197): read-only unless --write, a fail-closed allowlist, as bw's (catalog rows
# 258-260). None of the three messages repeats what came after op's command: those arguments may hold a password
OP_NEEDS_WRITE = 196        # an op command that changes the vault or the account, or writes a file here, without --write
OP_NOT_ALLOWED = 197        # an op command or option before it that roster vault op doesn't know, or --write among op's own
OP_REFUSED = 198            # never run: `op run`/`op plugin run` (another program with the sign-in), --session, --config

# The SSH key type (decision Q200; catalog rows 261-263)
KEY_TYPE_FIPS = 199         # check HOST: the Host refused this Box's Ed25519 key and offers only NIST algorithms (FIPS)
MESH_KEY_TYPE = 200         # no longer raised (Q212: the Mesh follows key_type); was: left out of the Mesh
KEY_TYPE_MISMATCH = 201     # setup: the file a key type's key goes in holds a key of another type; nothing was made

# A saved Bitwarden session (decision Q203; catalog rows 264-266): roster vault unlock / vault lock
SESSION_FILE_REFUSED = 202  # the bw-session file is a link, another user's or not a plain file: not written over
NO_SESSION = 203            # vault unlock/lock for a provider with no session roster keeps (KeePassXC; 1Password for now)
SESSION_FILE_FAILED = 204   # the bw-session file couldn't be written or removed (the system's reason)

# Rotating the Box key (decision Q204; catalog rows 267-270)
BOX_BUSY = 205              # another roster run (setup, revoke, a Mesh write) is changing this Inventory's Hosts: refused
ROTATION_PENDING = 206      # a warning: the old Box key is still on some Hosts (setup --rotate finishes it)
KEY_TOO_OLD = 207           # a warning (check --box, box.check): this Box's key is older than key_max_age
NEW_KEY_REFUSED = 208       # setup --rotate: a Host it reached refused the new key, so no old key line went anywhere

# key_type follow-ups (decision Q212; catalog rows 281-283)
KEY_TYPE_DRIFT = 219        # a warning: a Host holds this Box's key lines of other types than roster.yml's
MESH_KEY_PEER = 220         # a warning: a source's Ed25519 Mesh key goes to a peer whose key_type isn't ed25519
KEY_FILE_SHARED = 221       # a note: revoke keeps a key file another Inventory on this Box still uses


# The vault's own state, not an item's: the codes a provider's failure keeps wherever it's reported
VAULT_CODES = (WRONG_PASSWORD, NOT_LOGGED_IN, CLI_MISSING, UNSUPPORTED, VAULT_LOCKED, ALREADY_SIGNED_OUT,
               SIGN_OUT_FAILED)
# The codes the command line prints without their `[CODE] `: the plain refusals, which name no catalog row of their
# own, and those whose message has always stood alone there (the named Inventories', a new Inventory's, the Mesh's
# rotate). Every other code is shown.
UNTAGGED = frozenset({INVENTORY_ERROR, UNKNOWN_HOST, ROSTER_ERROR, NOT_A_SOURCE, UNKNOWN_INVENTORY, INVENTORY_TAKEN,
                      BAD_INVENTORY, INVENTORIES_UNREADABLE, INVENTORY_THERE, NOT_AN_INVENTORY, CLONE_FAILED,
                      SSH_CONFIG_UNREADABLE, FOLDER_NOT_WRITABLE})
# data.path of a roster.yml roster won't repeat (a -c value shaped like a token)
PATH_NOT_REPEATED = "(not repeated)"


class Problem(Exception):
    """A clean error: a stable code, roster's message, and (optionally) the fix and extra data."""

    def __init__(self, code: int, message: str, data: dict[str, Any] | None = None, fix: str | None = None,
                 details: str | None = None) -> None:
        super().__init__(message)
        self.code, self.message, self.fix, self.details = code, message, fix, details
        self.data = data if fix is None else {**(data or {}), "fix": fix}

    def as_error(self):
        """The Problem as a JSON-RPC error object: {code, message, data?}, with the raw `details` (git's or ssh's
        own words, for the app's "Details") in data."""
        err = {"code": self.code, "message": self.message}
        if self.data is not None:
            err["data"] = self.data
        if self.details:
            err["data"] = {**err.get("data", {}), "details": self.details}
        return err


# what to do about a roster.yml roster found in a token-named folder (or named like a token itself), which it never
# names (#498): its errors and fix say so
RENAME_HINT = "rename the folder (or file) whose name looks like a token, then give roster its new path"


class InventoryError(Problem):
    """roster.yml wasn't found or doesn't load (catalog row 1): roster's MESSAGE, the PATH as roster may show it
    (PATH_NOT_REPEATED when it mustn't be; None when no file is in question yet) and, for a YAML error, the LINE.
    An error in one Host's entry names the HOST, and WHY is the message without it. HIDDEN: the file is there, in a
    token-named folder, so the fix says to rename it first. data: path and line; the fix names the file."""

    def __init__(self, message, path=None, line=None, host=None, why=None, hidden=False):
        where = ("roster.yml" if path is None else f"the roster.yml at that path {PATH_NOT_REPEATED}"
                 if path == PATH_NOT_REPEATED else path) + (f" at line {line}" if line else "")
        fix = (f"{RENAME_HINT}; then fix {where}" if hidden else
               f"fix {where}, or make one if there's none yet: `roster init --blank` (`roster init --help`: the others)")
        super().__init__(INVENTORY_ERROR, message, {"path": path} | ({"line": line} if line else {}), fix=fix)
        self.path, self.line, self.host, self.why, self.hidden = path, line, host, why or message, hidden

    def at(self, path, hidden=False):
        """This error, about the file roster shows as PATH (when it named none yet); HIDDEN as the class has it."""
        if self.path is not None:
            return self
        return InventoryError(self.message, path, self.line, self.host, self.why, hidden)


def tagged(problem: Problem) -> str:
    """PROBLEM's message as the command line shows it: `[CODE] MESSAGE`, or MESSAGE alone for an UNTAGGED code."""
    return problem.message if problem.code in UNTAGGED else f"[{problem.code}] {problem.message}"


class HostRefused(Problem, RuntimeError):
    """A Problem where callers catch a Host's failure as a RuntimeError (a script there refused): its str() is the
    line the command line reports it with, tagged()."""

    def __str__(self):
        return tagged(self)



class Exit(SystemExit):
    """A die(): roster refusing on the command line, as the Problem it is. Python prints its text, `error: ` and the
    message tagged(), with FULL ` (DETAILS) - FIX` after it (for a library's Problem whose message doesn't say them),
    and exits 1; serve and --json answer with the Problem."""

    def __init__(self, problem: Problem, full: bool = False) -> None:
        more = ((f" ({problem.details})" if problem.details else "") + (f" - {problem.fix}" if problem.fix else "")
                if full else "")
        super().__init__(f"error: {tagged(problem)}{more}")
        self.problem = problem


def problem_of(e: BaseException) -> "Problem":
    """Any exception as the Problem to answer with: a Problem as it is, a die() with its code, another exit 3,
    anything else -32603 with its type and words (so never for code that may hold a secret)."""
    if isinstance(e, Problem):
        return e
    if isinstance(e, Exit):
        return e.problem
    if isinstance(e, SystemExit):
        return Problem(ROSTER_ERROR, str(e.code) if e.code is not None else "exited")
    return Problem(INTERNAL_ERROR, f"{type(e).__name__}: {e}")


def vault_problem(e, unknown=ROSTER_ERROR, fix=None):
    """A provider's SecretError as a Problem: its own code, data and fix (providers/problems.py); a kind with no code
    of its own takes UNKNOWN (where it happened: 3, a lookup's 35) and FIX. Shared by the CLI and serve, so the
    vault's state carries no fix only one of them could act on (serve adds the lock screen's: sign_out_error)."""
    code = getattr(e, "code", None)
    return Problem(code or unknown, str(e), getattr(e, "data", None),
                   fix=getattr(e, "fix", None) or (None if code else fix))


SIGN_IN_FIXES = {
    WRONG_PASSWORD: "check the email, the master password and the server, then try again",
    CODE_REJECTED: "type the current code (an authenticator's changes every 30 s; an emailed one is the newest)",
    METHOD_UNSUPPORTED: "sign in with an API key, or add a second method the CLI can do in the web vault",
    RATE_LIMITED: "wait a few minutes before trying again",
    SERVER_UNREACHABLE: "check the server address and this box's network, then try again",
    ALREADY_LOGGED_IN: "unlock with the master password instead",
    NO_SIGN_IN: "start the sign-in again",
    SSO_FAILED: "start the SSO sign-in again and finish it in the browser",
    BAD_SERVER: "use cloud, eu, or your server's https:// address",
    API_KEY_REJECTED: "copy client_id and client_secret again from the web vault (Account settings > Security > Keys)",
    SIGN_IN_FAILED: "see the message; `bw login` in a terminal shows the same",
}


def sign_in_problem(e, login_id=None):
    """A failed vault.login step as a Problem. data.step (with data.login) is where the sign-in carries on, when
    it does; without it the sign-in is over. Never holds a value the person typed (the provider scrubs them)."""
    code = getattr(e, "code", None) or SIGN_IN_FAILED
    step = getattr(e, "step", None)
    data = {"step": step, "login": login_id} if step else None
    fix = SIGN_IN_FIXES.get(code) or (str(e) if code in (NOT_LOGGED_IN, CLI_MISSING) else None)
    return Problem(code, str(e), data, fix=fix)


def login_problem(e, h, what="ssh"):
    """A SecretError from looking up Host H's Login as a Problem naming the Host, with its fix.
    Item names, revision dates and URIs may be shown; a value never is (providers never put one in)."""
    where = f"{what} Login of {h['name']}"
    code = getattr(e, "code", None)
    if code == ITEM_NOT_FOUND:
        near = f" - did you mean: {', '.join(repr(n) for n in e.near)}" if e.near else ""
        return Problem(ITEM_NOT_FOUND, f"no vault item named '{e.item}' ({where}){near}", {"near": e.near},
                       fix=f"fix the name in {h['name']}'s auth: in roster.yml, or rename the item in the vault")
    if code == SEVERAL_ITEMS:
        how = "are named" if e.exact else "match"
        listed = "; ".join(f"'{m['name']}'" + (f" ({about})" if (about := ", ".join(
            ([f"edited {m['revised']}"] if m.get("revised") else []) + list(m["uris"]))) else "")
            for m in e.matches)
        if e.total:                             # bw found more than its login rows show (Q191 (p))
            head = f"{e.total} vault items match '{e.item}' ({where}), some of them aren't logins"
            text = head + (f": {listed}" if listed else "")
        else:
            text = f"{len(e.matches)} vault items {how} '{e.item}' ({where}): {listed}"
        return Problem(SEVERAL_ITEMS, text,
                       {"matches": e.matches},
                       fix="delete or rename the extra items in the vault, or use the item's id in auth:")
    if code == NO_FIELD:
        what_ = "password" if e.field == "password" else f"field '{e.field}'"
        return Problem(NO_FIELD, f"vault item '{e.item}' has no {what_} ({where})", {"field": e.field},
                       fix=f"add the {what_} to the item in the vault, or fix the #FIELD in auth:")
    if code in VAULT_CODES:                     # the vault, not the item: its message already says what to run
        return Problem(code, str(e), fix="unlock the vault" if code == VAULT_LOCKED else str(e))
    return Problem(LOOKUP_FAILED, f"{e} ({where})", fix="see the message; `roster check --auth` tests every Login")


def unknown_provider(h, auth, what="ssh"):
    name = str(auth).partition(":")[0].strip()      # hosts.provider_of (errors imports nothing of roster's)
    return Problem(NO_PROVIDER, f"{h['name']}'s {what} Login uses '{name}:', which isn't set up on this box",
                   {"provider": name}, fix="see `roster vault status` for the ones that are, then fix auth: in "
                                           "roster.yml (or add the provider)")


def no_user(h):
    return Problem(NO_USER, f"no SSH user for {h['name']} (user: {h['ssh']['user']} in roster.yml)",
                   fix=f"set user: for {h['name']} (or its group) in roster.yml")
