"""What can go wrong in a password provider: SecretError and its kinds. Each kind carries its stable code (errors.py)
and, where one sentence fits wherever it's reported, its fix, so the CLI, serve and the askpass channel report it
alike (errors.vault_problem, login_problem, sign_in_problem). A kind with no code of its own (SecretError itself,
TimedOut) takes the code of where it happened: 3, a lookup's 35, a sign-in's 59.

Messages are safe to show: they carry item NAMES (and dates, URIs), never a value."""

import json
from collections.abc import Iterable
from typing import Any

from .. import errors


class SecretError(RuntimeError):
    """Raise this from a provider with a message that's safe to show (never the secret itself)."""

    code: int | None = None
    fix: str | None = None
    data: dict[str, Any] | None = None


# Kinds of SecretError a caller (`roster serve`) can tell apart. Providers and plugins raise these where they fit.
class TimedOut(SecretError):
    """A helper command didn't finish in time (it was stopped): what it was doing may or may not have happened."""


class WrongPassword(SecretError):
    """The master password didn't unlock the vault."""

    code = errors.WRONG_PASSWORD
    step: dict[str, Any] | None = None  # vault.login: the step the sign-in carries on at (sign_in_problem), when it does


class NotLoggedIn(SecretError):
    """The vault CLI isn't logged in on this box; the message says what to run."""

    code = errors.NOT_LOGGED_IN


class CliMissing(SecretError):
    """The provider's command isn't installed."""

    code = errors.CLI_MISSING


class Unsupported(SecretError):
    """The provider has no master password to unlock with."""

    code = errors.UNSUPPORTED


class NoItemFields(Unsupported):
    """The provider can't give an item's address and username without its password reaching roster (Q190)."""

    code = errors.NO_ITEM_FIELDS
    fix = "give the address and user yourself (roster add: --ip and --user)"

    def __init__(self, message: str, provider: str) -> None:
        super().__init__(message)
        self.data = {"provider": provider}


class NotSignedIn(SecretError):
    """vault.logout: the CLI isn't signed in to an account, so there's none to sign out of."""

    code = errors.ALREADY_SIGNED_OUT


class SignOutFailed(SecretError):
    """vault.logout: the CLI refused to log out; the message has its words."""

    code = errors.SIGN_OUT_FAILED


class VaultLocked(SecretError):
    """The vault is locked and this process may not unlock it by itself (see MANUAL_UNLOCK), or has nothing to unlock
    it with (no terminal to ask in, no password variable): 14, never 35 (#437)."""

    code = errors.VAULT_LOCKED


class SessionFileRefused(SecretError):
    """A saved vault session's file is one roster won't write over (a link, another user's, not a plain file: the
    rules of common.read_private_bytes, #411). Nothing was written (T241)."""

    code = errors.SESSION_FILE_REFUSED


class SessionFileFailed(SecretError):
    """A saved vault session's file couldn't be written or removed (the system's reason in the message) (T241)."""

    code = errors.SESSION_FILE_FAILED


class NoSession(SecretError):
    """`roster vault unlock` / `vault lock` for a provider that keeps no session roster can save (T241)."""

    code = errors.NO_SESSION


# What can go wrong signing in (`roster serve`'s vault.login). `step`: where the sign-in carries on (the provider
# restarted it, e.g. after a wrong code), or None when it's over.
class LoginError(SecretError):
    """A sign-in failed some other way; the message has the provider's own words."""

    code = errors.SIGN_IN_FAILED

    def __init__(self, message: str, step: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.step = step


class CodeRejected(LoginError):
    """The two-step or new-device code was wrong or expired."""

    code = errors.CODE_REJECTED


class MethodUnsupported(LoginError):
    """The account's only two-step methods (or its SSO decryption) are ones the provider's CLI can't do."""

    code = errors.METHOD_UNSUPPORTED


class RateLimited(LoginError):
    """The server refused: too many attempts."""

    code = errors.RATE_LIMITED


class ServerUnreachable(LoginError):
    """The vault's server didn't answer (network, wrong address, TLS)."""

    code = errors.SERVER_UNREACHABLE


class AlreadyLoggedIn(LoginError):
    """The CLI is already logged in on this box: unlock instead."""

    code = errors.ALREADY_LOGGED_IN


class BrowserLoginFailed(LoginError):
    """SSO in the browser failed or didn't finish in time."""

    code = errors.SSO_FAILED


class BadServer(LoginError):
    """The server address given isn't one."""

    code = errors.BAD_SERVER


class ApiKeyRejected(LoginError):
    """The API key (client id / secret) wasn't accepted, or is an organization key."""

    code = errors.API_KEY_REJECTED


class WrongLogin(LoginError):
    """The email or master password wasn't accepted (WrongPassword's sign-in twin)."""

    code = errors.WRONG_PASSWORD


# What can be wrong with the item a Login names.
class ItemNotFound(SecretError):
    """No item by that name. near: names of similar items, closest first."""

    code = errors.ITEM_NOT_FOUND

    def __init__(self, message: str, item: str, near: Iterable[str] = ()) -> None:
        super().__init__(message)
        self.item, self.near = item, list(near)


class SeveralItems(SecretError):
    """More than one item matches. matches: [{name, revised, uris}]; exact: they all have that exact name. total:
    how many items match when that's more than MATCHES shows (Bitwarden: some of them aren't logins), else None."""

    code = errors.SEVERAL_ITEMS

    def __init__(self, message: str, item: str, matches: list[dict[str, Any]], exact: bool,
                 total: int | None = None) -> None:
        super().__init__(message)
        self.item, self.matches, self.exact, self.total = item, matches, exact, total


class NoField(SecretError):
    """The item exists but has no value in the field the Login asks for ("password", or a #FIELD)."""

    code = errors.NO_FIELD

    def __init__(self, message: str, item: str, field: str) -> None:
        super().__init__(message)
        self.item, self.field = item, field


# Writing Vault items ("Save to vault", Q43's verified adds).
class CantWrite(SecretError):
    """The provider can only read Logins: it can't create or delete Vault items."""

    code = errors.CANT_WRITE
    fix = "save to a provider that can write (bw, kp), or make the item by hand"


class ItemExists(SecretError):
    """An item by exactly that name is already there. matches: [{name, revised, uris}]."""

    code = errors.ITEM_EXISTS
    fix = "point the Login at the existing item, or pick another name (`<host> <what it opens>`)"

    def __init__(self, message: str, item: str, matches: list[dict[str, Any]]) -> None:
        super().__init__(message)
        self.item, self.matches = item, matches
        self.data = {"matches": matches}


class WriteFailed(SecretError):
    """The provider's CLI refused the create or delete; the message has its words (minus any value). FIX: the
    provider's own, where Bitwarden's rights hint doesn't fit (KeePassXC's file)."""

    code = errors.WRITE_FAILED
    fix = "see the message; check your rights to the vault or collection"

    def __init__(self, message: str, fix: str | None = None) -> None:
        super().__init__(message)
        if fix is not None:
            self.fix = fix


def repeats_secret(text: str, secret: str | None) -> bool:
    """Whether a CLI's words TEXT hold SECRET as an error may carry it: as given, JSON-escaped, or with its whitespace
    collapsed, in TEXT as it is or collapsed (#539's review, LOW-1). A caller then withholds TEXT whole: scrubbing
    one form would leave another."""
    if not secret:
        return False
    flat = " ".join(text.split())
    secret_forms = {secret, json.dumps(secret)[1:-1], " ".join(secret.split())} - {""}
    return any(f in text or f in flat for f in secret_forms)


def withheld(tool: str) -> str:
    """What's said instead of TOOL's words when they repeat the password (repeats_secret)."""
    return f"{tool} refused the item (its message was withheld because it repeated the password)"


# Where a Vault item goes: the personal vault, an organization's collection, a KeePassXC group.
class UnknownTarget(SecretError):
    """The place to save to isn't there (or isn't one this provider has); the message names the setting to fix."""

    code = errors.UNKNOWN_TARGET
    fix = "fix the setting the message names, or pick where to save it"


class ReadOnlyTarget(SecretError):
    """The account may only read the collection it was asked to save to."""

    code = errors.READ_ONLY_TARGET
    fix = "save it somewhere you can write to, or ask an organization admin for write access"
