"""Stable error codes and the Problem they come in: what `roster serve`, the askpass channel and
`roster check HOST` report when opening a Session can't work (docs/app/errors.md is the catalog).
The app switches on the code; the message is roster's usual wording, ready to show to a person, and never
holds a secret. `fix` says what to do about it, in a sentence."""

import re

from . import providers

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
                            # about before its Session (ticket 36); nothing is recorded

# Logins: what's wrong with a Host's ssh Login or its vault item (rows 4, 5, 8-10, 18)
NO_USER = 30                # the Host's ssh user is discover's placeholder CHANGE-ME (row 4)
NO_PROVIDER = 31            # the Login's provider (the `keeper:` in keeper:ITEM) isn't set up on this box (row 5)
ITEM_NOT_FOUND = 32         # no vault item by that name (row 8); data.near: similar item names
SEVERAL_ITEMS = 33          # several vault items match (row 9); data.matches: [{name, revised, uris}]
NO_FIELD = 34               # the item has no password, or no such #FIELD (row 10)
# 35 LOOKUP_FAILED          the provider failed some other way; the message is the provider's
# 36 UNEXPECTED_PROMPT      askpass: the Host asked something other than the Login password (row 18)
# 37 TOKEN_SPENT            askpass: the one-time token is used, expired or cleared by vault.lock
# 38 NO_SERVE               askpass: the helper couldn't reach `roster serve`
PASSWORD_NEEDED = 39        # session.prepare: the Host's Login is auth: prompt, so the app asks for its password (T16)
from .askpass import LOOKUP_FAILED, NO_SERVE, TOKEN_SPENT, UNEXPECTED_PROMPT  # noqa: E402,F401 (stdlib-only helper)

# host.check's network and Host steps (rows 11-17, 19)
NO_DNS = 40                 # the address doesn't resolve (row 15)
REFUSED = 41                # the ssh port refused the connection (row 16)
TIMEOUT = 42                # no answer from the ssh port (row 17; on 10.19.x often the rate limiter)
HOST_KEY_CHANGED = 43       # the Host's key isn't the recorded one (row 13): never accepted automatically
HOST_KEY_UNKNOWN = 44       # no recorded host key for this Host (row 14)
PASSWORD_REFUSED = 45       # the Host refused the Login's password (row 11)
KEY_REFUSED = 46            # the Host refused this box's key (row 12)
TOO_MANY_AUTH = 47          # the Host cut the connection after too many key attempts (row 19)
AUTH_FAILED = 48            # the login failed some other way; details has ssh's own message
NO_CHECK = 49               # host.check_job: no check by that id in this serve (API 21)

# vault.login: signing the vault CLI in on this box (ticket 31; docs/app/dev/vault-auth.md).
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

# vault.create_item / vault.undo_create: "Save to vault" (ticket 13; Q43). Locked is 14, no CLI 12, not logged in 11.
ITEM_EXISTS = 60            # a vault item by exactly that name already exists; data.matches: [{name, revised, uris}]
CANT_WRITE = 61             # the provider can only read Logins (bw and kp can create items)
WRITE_FAILED = 62           # the vault CLI refused the create or delete; the message has its words, never a value
NOT_CREATED_HERE = 63       # vault.undo_create: this serve didn't create that item, or it's already undone
UNKNOWN_TARGET = 64         # save_to names an organization, collection or group that isn't there (ticket 35); the
                            #   message names the setting (roster.yml's, init.lua's, or the choice)
READ_ONLY_TARGET = 65       # save_to names a collection the account may only read; nothing was left behind
# "Save to vault" after a Session's own login (tickets 15, 16; Q43): quick.save and host.save_login
LOGIN_NOT_SEEN = 66         # the Session hasn't logged in with the typed password (yet, or it was refused)
NOTHING_HELD = 67           # no typed password held for that Session: never asked for, already saved, or forgotten

# Editing the Inventory: Pending changes (ticket 10). The verify_login steps reuse 30-48.
NOT_A_REPO = 70             # roster.yml isn't tracked in a git repo, so it can't have Pending changes
DIRTY = 71                  # inventory.pull: uncommitted changes (Pending changes, or other files); data.files
DIVERGED = 72               # inventory.pull: this box's branch and its upstream both have new commits
PULL_FAILED = 73            # inventory.pull: the fetch or the fast-forward failed (network, access, a file in the way)
INVALID_EDIT = 74           # host.update: the result wouldn't load, or would change more than asked; nothing written
NOT_VERIFIED = 75           # host.update: address, user or Login changed without a test login that just succeeded

# Adding a Host (ticket 11; Q43). A failed test login answers with its step's own code (40-48, 30-35) and data.steps.
INVALID_HOST = 80           # host.add: a bad name, group, address, user or port, or no user to log in as; data.field
HOST_EXISTS = 81            # host.add: a Host by that name is already in the Inventory; data.group

# Publishing the Pending changes (ticket 12; Q13): commit roster.yml, push it, never force. A failed fetch is 73.
NOTHING_TO_PUBLISH = 90     # changes.publish: roster.yml has no Pending changes
OTHER_CHANGES = 91          # changes.publish: other files in the infra repo are uncommitted too; data.files
REMOTE_MOVED = 92           # changes.publish: the upstream changed roster.yml since this box's copy; nothing published
UNPUSHED = 93               # changes.publish: this box has its own commits that aren't on the upstream; data.ahead
NO_UPSTREAM = 94            # changes.publish: the branch has no upstream to push to
COMMIT_FAILED = 95          # changes.publish: git refused the commit (no identity, a hook); Pending changes kept
PUSH_FAILED = 96            # changes.publish: the push failed or was rejected; the commit is undone, changes kept

# The Live Inventory (ticket 28): removing, renaming and moving Hosts, and groups. A bad name is 80, an unknown Host
# 2, a result that wouldn't load (or would change another entry) 74; a roster.yml that doesn't load right now is 1.
NAME_TAKEN = 100            # host.rename / group.new / group.rename: that name is already a Host's or a group's; data.kind
UNKNOWN_GROUP = 101         # no group by that name in roster.yml; data.group
GROUP_NOT_EMPTY = 102       # group.delete: the group still has Hosts and no `to` says where they go; data.hosts
WOULD_CHANGE = 103          # host.move / group.delete: the Host would come out different in the new group; data.fields

# The Mesh (ticket 39, decision Q63). roster.yml's mesh:/links: that don't load are 1, an unknown Host 2.
NOT_A_SOURCE = 110          # mesh.plan / mesh.apply: rotate names a Host that isn't a Mesh source (has no Mesh key);
                            #   data.hosts
MESH_BUSY = 111             # mesh.plan / mesh.apply / mesh.cut while a Mesh job (background: true) still runs;
                            #   data.job, data.action

# Discover in roster serve (ticket 44): a scan of a network, run in the background. A bad target is -32602.
SCAN_RUNNING = 120          # discover.start: a scan is going already (one at a time); data.scan
TOO_MANY_ADDRESSES = 121    # discover.plan / discover.start: more addresses than allowed; data.addresses, limit, max
NO_SCAN = 122               # discover.status / stop / add: no scan by that id in this serve (or none yet)
CANT_ADD = 123              # discover.add: an address the scan didn't find, or one already in the Inventory or added;
                            #   data.addresses

# Filling a password prompt in a Session (ticket 119, decision Q129): session.fill
FILL_REFUSED = 130          # the prompt isn't provably this Host's own Login's (another Host or account, su's bare
                            #   Password:), or the Host changed since the Session connected; data.prompt: what roster
                            #   read it as (sudo, su, ssh), when it is one
NOTHING_TO_FILL = 131       # the Login that would answer has no saved password (auth: agent, key, none, prompt)


class Problem(Exception):
    """A clean error: a stable code, roster's message, and (optionally) the fix and extra data."""

    def __init__(self, code, message, data=None, fix=None, details=None):
        super().__init__(message)
        self.code, self.message, self.fix, self.details = code, message, fix, details
        self.data = data if fix is None else {**(data or {}), "fix": fix}


VAULT_ERRORS = {providers.WrongPassword: WRONG_PASSWORD, providers.NotLoggedIn: NOT_LOGGED_IN,
                providers.CliMissing: CLI_MISSING, providers.Unsupported: UNSUPPORTED,
                providers.VaultLocked: VAULT_LOCKED, providers.NotSignedIn: ALREADY_SIGNED_OUT,
                providers.SignOutFailed: SIGN_OUT_FAILED}

def vault_problem(e):
    """A provider's SecretError about the vault itself (locked, not logged in, ...) as a Problem. Shared by the CLI
    and serve, so it carries no fix only one of them could act on (serve adds the lock screen's: sign_out_error)."""
    return Problem(VAULT_ERRORS.get(type(e), ROSTER_ERROR), str(e))


def write_problem(e):
    """A failed vault.create_item / vault.undo_create as a Problem, with its fix. Names only, never a value."""
    if isinstance(e, providers.ItemExists):
        return Problem(ITEM_EXISTS, str(e), {"matches": e.matches},
                       fix="point the Login at the existing item, or pick another name (`<host> <what it opens>`)")
    if isinstance(e, providers.CantWrite):
        return Problem(CANT_WRITE, str(e), fix="save to a provider that can write (bw, kp), or make the item by hand")
    if isinstance(e, providers.WriteFailed):
        return Problem(WRITE_FAILED, str(e), fix="see the message; check your rights to the vault or collection")
    if isinstance(e, providers.UnknownTarget):
        return Problem(UNKNOWN_TARGET, str(e), fix="fix the setting the message names, or pick where to save it")
    if isinstance(e, providers.ReadOnlyTarget):
        return Problem(READ_ONLY_TARGET, str(e),
                       fix="save it somewhere you can write to, or ask an organization admin for write access")
    return vault_problem(e)


SIGN_IN_ERRORS = {providers.CodeRejected: CODE_REJECTED, providers.MethodUnsupported: METHOD_UNSUPPORTED,
                  providers.RateLimited: RATE_LIMITED, providers.ServerUnreachable: SERVER_UNREACHABLE,
                  providers.AlreadyLoggedIn: ALREADY_LOGGED_IN, providers.BrowserLoginFailed: SSO_FAILED,
                  providers.BadServer: BAD_SERVER, providers.ApiKeyRejected: API_KEY_REJECTED,
                  providers.WrongLogin: WRONG_PASSWORD, providers.LoginError: SIGN_IN_FAILED}

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
    if isinstance(e, providers.WrongPassword) or type(e) in VAULT_ERRORS:
        code = VAULT_ERRORS.get(type(e), WRONG_PASSWORD)
    else:
        code = next((c for cls, c in SIGN_IN_ERRORS.items() if isinstance(e, cls)), SIGN_IN_FAILED)
    step = getattr(e, "step", None)
    data = {"step": step, "login": login_id} if step else None
    fix = SIGN_IN_FIXES.get(code) or (str(e) if code in (NOT_LOGGED_IN, CLI_MISSING) else None)
    return Problem(code, str(e), data, fix=fix)


def login_problem(e, h, what="ssh"):
    """A SecretError from looking up Host H's Login as a Problem naming the Host, with its fix.
    Item names, revision dates and URIs may be shown; a value never is (providers never put one in)."""
    where = f"{what} Login of {h['name']}"
    if isinstance(e, providers.ItemNotFound):
        near = f" - did you mean: {', '.join(repr(n) for n in e.near)}" if e.near else ""
        return Problem(ITEM_NOT_FOUND, f"no vault item named '{e.item}' ({where}){near}", {"near": e.near},
                       fix=f"fix the name in {h['name']}'s auth: in roster.yml, or rename the item in the vault")
    if isinstance(e, providers.SeveralItems):
        how = "are named" if e.exact else "match"
        listed = "; ".join(f"'{m['name']}' (edited {m['revised'] or '?'}"
                           + (f", {', '.join(m['uris'])}" if m["uris"] else "") + ")" for m in e.matches)
        return Problem(SEVERAL_ITEMS, f"{len(e.matches)} vault items {how} '{e.item}' ({where}): {listed}",
                       {"matches": e.matches},
                       fix="delete or rename the extra items in the vault, or use the item's id in auth:")
    if isinstance(e, providers.NoField):
        what_ = "password" if e.field == "password" else f"field '{e.field}'"
        return Problem(NO_FIELD, f"vault item '{e.item}' has no {what_} ({where})", {"field": e.field},
                       fix=f"add the {what_} to the item in the vault, or fix the #FIELD in auth:")
    if type(e) in VAULT_ERRORS:                 # the vault, not the item: its message already says what to run
        code = VAULT_ERRORS[type(e)]
        return Problem(code, str(e), fix="unlock the vault" if code == VAULT_LOCKED else str(e))
    return Problem(LOOKUP_FAILED, f"{e} ({where})", fix="see the message; `roster auth-check` tests every Login")


def inventory_problem(message, path=None):
    """roster.yml didn't load (row 1). data: path (or None) and, for a YAML error, the line it's at."""
    m = re.search(r"line (\d+)", message)
    data = {"path": str(path.resolve()) if path else None} | ({"line": int(m.group(1))} if m else {})
    where = f"{path or 'roster.yml'}" + (f" at line {data['line']}" if m else "")
    return Problem(INVENTORY_ERROR, message, data, fix=f"fix {where}, or run `roster init` if there's none yet")


def unknown_provider(h, auth, what="ssh"):
    name = str(auth).partition(":")[0].strip()
    return Problem(NO_PROVIDER, f"{h['name']}'s {what} Login uses '{name}:', which isn't set up on this box",
                   {"provider": name}, fix="see `roster providers` for the ones that are, then fix auth: in "
                                           "roster.yml (or add the provider)")


def no_user(h):
    return Problem(NO_USER, f"no SSH user for {h['name']} (user: {h['ssh']['user']} in roster.yml)",
                   fix=f"set user: for {h['name']} (or its group) in roster.yml")
