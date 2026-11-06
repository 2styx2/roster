"""Password providers: registry, plugin loading, and the built-ins."""

import contextlib
import getpass
import os
import re
import shlex
import subprocess
import sys
import threading
from pathlib import Path

from ..common import filter_env, program_argv, run, run_filtered, say, time_left
from ..context import user_config_dir
from ..errors import InventoryError
from ..hosts import NO_PASSWORD, prompted, provider_of
from .problems import (  # noqa: F401 (what a provider or plugin raises: providers.ItemNotFound, ...)
    AlreadyLoggedIn,
    ApiKeyRejected,
    BadServer,
    BrowserLoginFailed,
    CantWrite,
    CliMissing,
    CodeRejected,
    ItemExists,
    ItemNotFound,
    LoginError,
    MethodUnsupported,
    NoField,
    NoItemFields,
    NoSession,
    NotLoggedIn,
    NotSignedIn,
    RateLimited,
    ReadOnlyTarget,
    SecretError,
    ServerUnreachable,
    SessionFileFailed,
    SessionFileRefused,
    SeveralItems,
    SignOutFailed,
    TimedOut,
    UnknownTarget,
    Unsupported,
    VaultLocked,
    WriteFailed,
    WrongLogin,
    WrongPassword,
    repeats_secret,
    withheld,
)

# ---------------------------------------------------------------- password providers
#
# An `auth:` value is NAME:SPEC (or just NAME). NAME picks a provider; SPEC is handed to it.
#   Built in:  prompt, agent, env, cmd, bw (Bitwarden), op (1Password)
#   Add more without editing this file:
#     - a command template in roster.yml under `providers:` (no code), or
#     - a Python plugin in ~/.config/roster/providers/ or a providers/ folder next to roster.yml
#       (see examples/providers/pass_store.py for a complete example).
# Every provider runs lazily, only when a password is actually needed, and values stay in memory.


def near_names(name, names, n=5):
    """Item names that look like NAME (a typo, other case, a word missing), closest first."""
    import difflib
    lowered = {x.lower(): x for x in names}
    close = difflib.get_close_matches(name.lower(), list(lowered), n=n, cutoff=0.6)
    words = [w for w in name.lower().split() if len(w) > 2]
    contains = [low for low in lowered if low not in close and words and all(w in low for w in words[:1])]
    return [lowered[x] for x in (close + sorted(contains))[:n]]


PROVIDERS = {}            # name -> {"get": fn(spec, ctx) -> str, "help": str, "tool": str, "kind": str}
                          #   optional: "unlock": fn(password, ctx), "lock": fn(ctx), "status": fn(ctx) -> str,
                          #             "not_logged_in": what to run when status is "unauthenticated" (or
                          #                              fn(ctx) -> that text)
                          #             "login": fn(ctx) -> a sign-in flow (vault.login; see bw_login.py)
                          #             "login_help": why this provider has no sign-in here, and what to do
                          #             "login_info": fn(ctx, server=ASK) -> vault.status's sign_in for a logged-out
                          #                           CLI (SERVER: the server it's set to, when already known)
                          #             "account": fn(ctx) -> (status, {"email", "server"} | None): the status
                          #                        and the account the CLI is signed in to, in one call
                          #             "logout": fn(ctx), sign the CLI out (vault.logout); NotSignedIn if it isn't
                          #             "forget": fn(ctx), the in-memory part of "lock" (drop a session key)
                          #             "reset": fn(), forget what the provider keeps for this run (reset())
                          #             "logout_help": why this provider has no account to sign out of, and what to do
                          #             "create": fn(item, ctx) -> {"id", "name"}, item = {name, username,
                          #                       password, uri}; refuses a name that exists (ItemExists)
                          #             "delete": fn(id, ctx), the undo of a create (Q43)
#             "targets": fn(ctx) -> [target], where the provider can save: each {id, kind, label, save_to}
#             "resolve": fn(setting, field, ctx) -> the target a save_to setting names (UnknownTarget,
#                        ReadOnlyTarget); field(part) names the setting for messages
#             "login_fields": fn(spec, ctx) -> {"uri", "username"} (each None when the item has none): an
#                             item's address and user, read without its password ever reaching roster (Q190)
#             "items": fn(ctx, mapped) -> [{id, name, keys, uris, username}]: every login item, read without a
#                      password, TOTP seed or note ever reaching roster (Q191); keys: what a Login may name it by
#                      (its id, name, path). MAPPED(item) says it's in roster.yml: its uris and username may be left
#                      out then (one more CLI call each, for op and kp)
#             "sync": fn(ctx) -> {"previous": ISO time or None}: fetch what changed on the server (`bw sync`);
#                     roster add --from-vault, and `roster vault sync` (vaultsync.py)
#             "saved_session": fn(ctx) -> (state, why): a session saved for every run on this Box
#                              (bw-session): "none", "working", "expired", "ignored" or "unknown" (why: the reason); never in serve
#             "manual": fn(ctx), only_unlock_unlocks(): forget what this process inherited that would unlock
#                       it by itself (bw's BW_PASSWORD and BW_SESSION; op's OP_SESSION_*, moved into its state)
#             "save_to": the keys of a save_to that names a target of this provider ({organization, collection},
#                        {group}); "old_save_to": an older setting of its own that means save_to: {it: value}
#             "holds_items": False for a provider with no items to list or sync (prompt, env, cmd)
#             "unlock_hint": what to run so a locked vault can answer: every fix line takes it from here
#                            (unlock_fix: roster add --from-vault, vault sync, sync, setup)
#             "session": a session saved for every run on this Box (`roster vault unlock`/`lock`): {"unlock":
#                        fn(ctx) -> how, "lock": fn(ctx) -> (said, problem), "remove": fn() -> removed, "file": fn(),
#                        "until": how long it lasts, "missing": the CLI isn't installed}; "no_session": why a
#                        provider keeps none
#             "box_paths": settings naming files on this Box (e.g. kp's database); a change to one
#                          from vault.configure locks the provider (what it holds was for the old one)
PROVIDER_SETTINGS = {}    # name -> settings dict from roster.yml `providers:`
BOX_SETTINGS = {}         # name -> this Box's own settings, from the app's init.lua (`roster serve`'s vault.configure):
                          #   paths and choices only, never a secret. They win over roster.yml's.
PROVIDER_STATE = {}       # name -> per-run scratch space (e.g. "already unlocked")
MANUAL_UNLOCK = False     # True (`roster serve`): only unlock() unlocks - no session file, no BW_PASSWORD, no prompt
JSON_OUTPUT = False       # True: the command prints --json, so a provider adds no note or question on stderr
_secrets = {}
_secret_lock = threading.Lock()


def unlock_fix(provider: str) -> str:
    """How to unlock PROVIDER's vault (its unlock_hint), for a fix line."""
    return (PROVIDERS.get(provider) or {}).get("unlock_hint") or f"unlock {provider}'s vault, then run it again"


LOOKUP_FLOOR = 7            # s for each look-up after a create timed out (did it get there?), even past serve's deadline


def bad_name(name):
    """Why NAME can't be a provider's name, or None."""
    if not re.match(r"^[a-z0-9_-]+$", name):
        return f"provider name {name!r} must be lowercase letters, digits, _ or -"
    return None


def register(name, help="", tool="", **facts):
    """Decorator for provider functions:  @register("vault", help="...", tool="vault"); FACTS: more of PROVIDERS'
    optional keys."""
    if why := bad_name(name):
        raise ValueError(why)

    def deco(fn):
        PROVIDERS[name] = {"get": fn, "help": help, "tool": tool,
                           "kind": "built-in" if fn.__module__.startswith("roster.") else "plugin", **facts}
        return fn
    return deco


def check_item_name(name):
    """An item name that starts with '-' would reach the vault CLI as an option (`bw get item --session=KEY` puts a
    key on the command line, Q178 (c)): refused before any CLI runs."""
    if str(name).startswith("-"):
        raise SecretError(f"a vault item's name can't start with '-' ({str(name)[:1]}...): the vault CLI would take it "
                          "as an option - use the item's id")


def split_field(spec, default="password"):
    """'Item name#field' -> ('Item name', 'field');  'Item name' -> ('Item name', default)."""
    item, _, field = spec.partition("#")
    return item.strip(), field.strip() or default


class _Tty:
    """The controlling terminal, open on FD: write() shows text on it, readline() reads what's typed there (a line in
    the terminal's canonical mode; "" at end of input)."""

    def __init__(self, fd):
        self.fd = fd

    def write(self, text):
        os.write(self.fd, text.encode("utf-8", "replace"))

    def readline(self):
        line = b""
        while not line.endswith(b"\n") and (chunk := os.read(self.fd, 1024)):
            line += chunk
        return line.decode("utf-8", "replace")


class _WinTty:
    """Windows' console through stdin and stderr, used only when both are the console."""

    def write(self, text):
        sys.stderr.write(text)
        sys.stderr.flush()

    def readline(self):
        return sys.stdin.readline()


@contextlib.contextmanager
def open_tty():
    """The terminal a question goes to, as getpass's: /dev/tty on Linux and macOS; on Windows the console, when stdin
    and stderr are both it. None when there's none (no controlling terminal, or a Windows stream redirected)."""
    if os.name == "nt":
        yield _WinTty() if sys.stdin.isatty() and sys.stderr.isatty() else None
        return
    try:
        fd = os.open("/dev/tty", os.O_RDWR | getattr(os, "O_NOCTTY", 0))
    except OSError:
        yield None
        return
    try:
        yield _Tty(fd)
    finally:
        os.close(fd)


def tell(text):
    """TEXT on the controlling terminal (open_tty), as a question is asked there, so a redirected stderr never hides
    what a prompt right after it is about (#503's second review, LOW-5); on stderr when there's no terminal."""
    with open_tty() as tty:
        if tty is not None:
            try:
                tty.write(text + "\n")
                return
            except OSError:
                pass
    print(text, file=sys.stderr, flush=True)


class Ctx:
    """What a provider gets besides its SPEC."""

    def __init__(self, name, group):
        self.provider = name
        self.group = group                                   # roster.yml group asking for the password
        box = BOX_SETTINGS.get(name, {})
        self.settings = {**PROVIDER_SETTINGS.get(name, {}), **box}   # `providers:` in roster.yml, init.lua's over it
        self.from_box = set(box)                             # the settings that came from init.lua
        self.state = PROVIDER_STATE.setdefault(name, {})     # remembered for the rest of this run
        self.interactive = sys.stdin.isatty()

    def ask(self, prompt):
        """Hidden prompt on the terminal; fails cleanly when there is none (e.g. under Claude)."""
        if not self.interactive:
            raise SecretError(f"needs input ({prompt.strip().rstrip(':')}) but there's no terminal to ask in")
        return getpass.getpass(f"  {prompt}")

    def confirm(self, prompt):
        """A yes/no question asked and answered on the controlling terminal (open_tty), as getpass asks the password,
        so a redirected stderr never hides it (#480 review, LOW-1): True only for y or yes (Enter is No; so is a
        terminal error, such as EIO when it hangs up while asking: #486). False, without asking, with no terminal
        (stdin or controlling) or with --json."""
        if not self.interactive or JSON_OUTPUT:
            return False
        with open_tty() as tty:
            if tty is None:
                return False
            try:
                tty.write(f"  {prompt}")
                answer = tty.readline()
            except OSError:
                return False
            return answer.strip().lower() in ("y", "yes")

    def run(self, args, env=None, shell=False, interactive=False, timeout=120, input=None, floor=1, discard=False):
        """Run a helper command, capturing output. A missing tool becomes a friendly error.
        INPUT goes to its stdin (the way to hand a tool a secret: never in args). The timeout is held to serve's
        deadline (common.time_left), but never below FLOOR; past it, TimedOut. DISCARD: its stdout goes to the null
        device, never into roster (only the exit code and stderr come back)."""
        tool = args if isinstance(args, str) else args[0]
        stdin = {} if input is not None else {"stdin": None if interactive else subprocess.DEVNULL}
        try:
            if not shell:
                args = program_argv(args)
            return run(args, shell=shell, text=True, timeout=time_left(timeout, floor), input=input,
                       env={**os.environ, **(env or {})}, stdout=subprocess.DEVNULL if discard else subprocess.PIPE,
                       **stdin)
        except FileNotFoundError:
            raise CliMissing(not_installed(self.provider, tool))
        except subprocess.TimeoutExpired:
            raise TimedOut(f"`{tool}` timed out")
        except ValueError as e:                     # program_argv: a batch file and an argument cmd.exe acts on
            raise SecretError(str(e))

    def run_filtered(self, args, filt, env=None, timeout=120, floor=1):
        """ARGS's stdout straight into FILT's stdin, never into roster (common.run_filtered, Q191): returns (ARGS's
        exit code and stderr, FILT's stdout and stderr). FILT gets next to no environment (common.filter_env), so
        not ENV's session key either. Errors as run()'s."""
        tool = args[0]
        try:
            return run_filtered(program_argv(args), program_argv(filt), timeout=time_left(timeout, floor),
                                env={**os.environ, **(env or {})}, filter_env=filter_env())
        except FileNotFoundError:
            raise CliMissing(not_installed(self.provider, tool))
        except subprocess.TimeoutExpired:
            raise TimedOut(f"`{tool}` timed out")
        except ValueError as e:
            raise SecretError(str(e))


def not_installed(name, tool=None):
    hint = PROVIDERS.get(name, {}).get("help", "")
    tool = tool or PROVIDERS.get(name, {}).get("tool") or name
    return f"`{tool}` is not installed on this box" + (f" ({hint})" if hint else "")


def errtext(r, limit=160, stdout=True):
    """A tool's error output minus noise (node deprecation warnings etc.), shortened. stdout=False leaves its stdout out:
    for a command whose stdout is the secret itself, which it may print and then fail."""
    lines = [line for line in (r.stderr + "\n" + (r.stdout if stdout else "")).splitlines()
             if line.strip() and not line.startswith(("(node", "(Use "))]
    return " ".join(lines)[:limit]


def json_output():
    """For providers: does this command print --json (no note line on stderr, no question)?"""
    return JSON_OUTPUT


def manual_unlock():
    """For providers: is unlocking by themselves (session file, password env var, prompt) off in this process?"""
    return MANUAL_UNLOCK


def get_secret(ref: str | None, group: str | None) -> str | None:
    """Resolve an auth reference via its provider. Cached for this run, never written anywhere."""
    if ref in (None, "") or ref in NO_PASSWORD:
        return None
    name, spec = provider_of(ref), str(ref).partition(":")[2]
    if name not in PROVIDERS:
        raise SecretError(f"unknown password source {name!r} in auth {ref!r} - available: "
                          f"{', '.join(sorted(PROVIDERS))} (see `roster vault status`)")
    cache_key = (ref, group) if prompted(ref) else ref
    with _secret_lock:
        if cache_key in _secrets:
            return _secrets[cache_key]
        try:
            val = PROVIDERS[name]["get"](spec, Ctx(name, group))
        except SecretError:
            raise
        except Exception as e:                       # a buggy plugin shouldn't crash the whole run
            raise SecretError(f"provider '{name}' failed: {type(e).__name__}: {e}")
        if not isinstance(val, str) or val == "":
            raise SecretError(f"provider '{name}' returned no value for {ref!r}")
        _secrets[cache_key] = val
        return val


def forget_secrets(provider=None):
    """Forget the secrets get_secret cached (only PROVIDER's, if given): the next look-up asks the vault again. The
    vault stays unlocked."""
    with _secret_lock:
        for ref in [r for r in _secrets if provider is None
                    or str(r[0] if isinstance(r, tuple) else r).startswith(provider + ":")]:
            del _secrets[ref]


# ---- unlock / lock without a terminal (for `roster serve`, which gets the master password from a GUI)

def _vault_op(name, op):
    if name not in PROVIDERS:
        raise SecretError(f"unknown password source {name!r}")
    return PROVIDERS[name].get(op)


def unlock(name, password):
    """Unlock provider NAME with this master password. Never prompts, never touches a session file,
    and the password never goes on a command line or into an error message."""
    fn = _vault_op(name, "unlock")
    if not fn:
        raise Unsupported(f"provider '{name}' can't be unlocked with a master password")
    with _secret_lock:
        PROVIDER_STATE.pop(name, None)                   # re-check readiness on the next lookup
        fn(password, Ctx(name, None))


def vault_status(name):
    """Where provider NAME stands, without prompting: "unlocked", "locked", "unauthenticated" (CLI not
    logged in), "missing" (CLI not installed), or "unsupported" (a provider with no lock to speak of)."""
    fn = _vault_op(name, "status")
    return fn(Ctx(name, None)) if fn else "unsupported"


def status_message(name, status):
    """What to tell a person about a vault_status() that needs fixing on this box, or None."""
    if status == "missing":
        return not_installed(name)
    if status == "unauthenticated":
        p = PROVIDERS.get(name, {})
        hint = p.get("not_logged_in")
        if callable(hint):                               # it depends on this box (e.g. KeePassXC's database path)
            hint = hint(Ctx(name, None))
        return hint or f"`{p.get('tool') or name}` isn't logged in on this box"
    return None


def vault_account(name):
    """(vault_status(name), the account its CLI is signed in to: {"email", "server"} or None), without prompting.
    One CLI call where the provider can say both at once (bw status)."""
    fn = _vault_op(name, "account")
    if fn:
        return fn(Ctx(name, None))
    return vault_status(name), None


def saved_session(name):
    """(state, why) of provider NAME's saved session (T241: "none", "working", "expired", or "ignored" and why), or
    None when it keeps none or this is `roster serve`, which never reads the bw-session file (MANUAL_UNLOCK, Q203)."""
    fn = _vault_op(name, "saved_session")
    if not fn or MANUAL_UNLOCK:
        return None
    return fn(Ctx(name, None))


ASK = object()              # status_result's server: not known yet, so login_info asks the CLI


def can_sign_out(name):
    return bool(PROVIDERS.get(name, {}).get("logout"))


def no_account(name):
    """The Unsupported error for signing out provider NAME, which has no account: in the provider's own words."""
    return Unsupported(PROVIDERS[name].get("logout_help")
                       or f"provider '{name}' has no account to sign out of - its Logins come from this box itself")


def logout(name):
    """Sign provider NAME's CLI out of its account (vault.logout). The caller forgets every cached secret and NAME's
    state first (serve's forget_everything, through lock(name, cli=False)), so nothing outlives the account even if
    the CLI then fails. Unsupported for a provider with no account."""
    fn = _vault_op(name, "logout")
    if not fn:
        raise no_account(name)
    fn(Ctx(name, None))


def login(name):
    """A new sign-in flow for provider NAME (an object with start(params), answer(params) and close(), each
    step a dict; see bw_login.py). Unsupported when the provider signs in some other way."""
    fn = _vault_op(name, "login")
    if not fn:
        raise Unsupported(PROVIDERS[name].get("login_help")
                          or f"provider '{name}' has no sign-in roster can drive - set it up on the box itself")
    return fn(Ctx(name, None))


def lock(name, cli=True):
    """Forget every cached secret and NAME's state, then run the provider's own lock (if it has one; with cli=False
    only its in-memory part: "forget" if it has one, for a CLI about to log out anyway). Memory is cleared first,
    so it is forgotten even if the provider's lock then fails."""
    _vault_op(name, "lock")
    with _secret_lock:
        _secrets.clear()
        PROVIDER_STATE.pop(name, None)
        fn = PROVIDERS[name].get("lock" if cli else "forget")
        if fn:
            fn(Ctx(name, None))


def only_unlock_unlocks():
    """`roster serve`: the app opens locked and only its lock screen unlocks (unlock()). Each provider forgets what
    this process inherited that would unlock it by itself (its "manual"), and none unlocks on its own from now on (no
    session file, no environment variable, no prompt)."""
    global MANUAL_UNLOCK
    MANUAL_UNLOCK = True
    for name, p in list(PROVIDERS.items()):
        if p.get("manual"):
            p["manual"](Ctx(name, None))


def set_json_output(on):
    """ON: this command prints --json, so no provider adds a note or a question on stderr (it would break the JSON)."""
    global JSON_OUTPUT
    JSON_OUTPUT = bool(on)


def reset():
    """Forget everything this process holds for its vaults, as if a new run started: cached secrets, each provider's
    state and settings, serve's and --json's modes, and what a provider keeps itself ("reset", e.g. bw's session key).
    No provider's CLI runs."""
    global MANUAL_UNLOCK, JSON_OUTPUT
    with _secret_lock:
        _secrets.clear()
        PROVIDER_STATE.clear()
        PROVIDER_SETTINGS.clear()
        BOX_SETTINGS.clear()
        MANUAL_UNLOCK = JSON_OUTPUT = False
        for p in list(PROVIDERS.values()):
            if p.get("reset"):
                p["reset"]()


# ---- this Box's own settings: from the app's init.lua, through `roster serve`'s vault.configure

def setting_name(ctx, key):
    """Where a person changes setting KEY of CTX's provider: `vault.kp.database in init.lua`, or roster.yml's."""
    if key == "save_to" and key in ctx.from_box:                  # init.lua's is one for every provider
        return "vault.save_to in init.lua"
    if key in ctx.from_box:
        return f"vault.{ctx.provider}.{key} in init.lua"
    return f"providers: {ctx.provider}: {key}: in roster.yml"


def configure_box(settings):
    """Take this Box's settings ({provider: {key: value}}, from init.lua), replacing the last ones: a provider or key
    left out goes back to roster.yml's. A provider whose box_paths changed is locked (memory first, as lock() does).
    Returns the names of the ones that were holding an unlock."""
    locked = []
    with _secret_lock:
        before = {n: dict(v) for n, v in BOX_SETTINGS.items()}
        BOX_SETTINGS.clear()
        BOX_SETTINGS.update({n: dict(v) for n, v in settings.items() if v})
        for name, p in list(PROVIDERS.items()):     # a reload may register a provider meanwhile (setup_providers)
            keys = p.get("box_paths", ())
            if all(before.get(name, {}).get(k) == BOX_SETTINGS.get(name, {}).get(k) for k in keys):
                continue
            state = PROVIDER_STATE.pop(name, None)
            _secrets.clear()
            if state and p.get("lock"):
                p["lock"](Ctx(name, None))
            if state and state.get("password") is not None:
                locked.append(name)
    return locked


# ---- where a Vault item goes: `save_to`, the same shape in roster.yml, init.lua and a save's choice

PERSONAL = "personal"
SAVE_TO_SHAPES = ('"personal", {organization, collection} (Bitwarden, by name or id), {group} (KeePassXC) or {vault} '
                  '(1Password, by name or id)')


def save_to_fits(value):
    """The providers a save_to VALUE (checked) can name a target of: every one with targets for PERSONAL."""
    return [n for n, p in PROVIDERS.items() if p.get("save_to") and (value == PERSONAL or set(value) == p["save_to"])]


def check_save_to(value):
    """VALUE as a save_to setting, or ValueError saying what it may be."""
    if value == PERSONAL:
        return value
    if isinstance(value, dict) and save_to_fits(value) \
            and all(isinstance(v, str) and v.strip() for v in value.values()):
        return {k: v.strip() for k, v in value.items()}
    raise ValueError(f"must be {SAVE_TO_SHAPES}, not {value!r}")


def save_to_text(provider, text):
    """A save_to as the command line writes it (`roster add --save-to`) for PROVIDER: `personal`, else the shape its
    save_to keys take: Bitwarden's `ORGANIZATION/COLLECTION` (split at the first `/`: a collection may nest, an
    organization's name or id has none), KeePassXC's `GROUP`, 1Password's `VAULT`. UnknownTarget when it can't be one
    of PROVIDER's."""
    text = str(text).strip()
    if text == PERSONAL:
        return PERSONAL
    keys = PROVIDERS.get(provider, {}).get("save_to") or frozenset()
    if len(keys) == 1 and text and keys != {"organization", "collection"}:       # kp's group, op's vault
        return check_save_to({next(iter(keys)): text})
    org, _, collection = text.partition("/")
    if keys == {"organization", "collection"} and org.strip() and collection.strip():
        return check_save_to({"organization": org, "collection": collection})
    shapes = {frozenset({"group"}): "personal or GROUP", frozenset({"vault"}): "personal or VAULT",
              frozenset({"organization", "collection"}): "personal or ORGANIZATION/COLLECTION"}
    raise UnknownTarget(f"--save-to {text!r} isn't a place {provider} saves to: give "
                        f"{shapes.get(frozenset(keys), 'personal')}")


def main_vault(names):
    """The vault to unlock and save to among provider NAMES (most used first): the first that has a master password,
    or None. serve's vault.status and "Save to vault", and `roster add --save-to-vault`."""
    return next((n for n in names if PROVIDERS.get(n, {}).get("unlock")), None)


def box_paths():
    """{provider: its settings naming files on this Box}, the ones vault.configure takes from init.lua."""
    return {n: p["box_paths"] for n, p in PROVIDERS.items() if p.get("box_paths")}


def holds_items(name):
    """Does provider NAME keep items of its own (a vault: something to list, sync or unlock), unlike prompt, env, cmd?"""
    return PROVIDERS.get(name, {}).get("holds_items", True)


def save_to_setting(ctx):
    """CTX's default target as (setting, source): init.lua's `vault.save_to`, else roster.yml's `providers: NAME:
    save_to:` (KeePassXC: its older `group:`), else the personal vault. source: "init.lua", "roster.yml" or None."""
    if ctx.settings.get("save_to") is not None:
        return ctx.settings["save_to"], "init.lua" if "save_to" in ctx.from_box else "roster.yml"
    old = PROVIDERS[ctx.provider].get("old_save_to")
    if old and ctx.settings.get(old):
        return {old: str(ctx.settings[old])}, "roster.yml"
    return PERSONAL, None


def save_to_field(ctx, source, part=None):
    """The name of the setting a save_to came from, for messages (PART: organization, collection, group). A SOURCE
    that's a command-line flag (`--save-to`) is named as it."""
    if source and source.startswith("--"):
        return source + (f"'s {part}" if part else "")
    if source == "init.lua":
        return "vault.save_to" + (f".{part}" if part else "") + " in init.lua"
    if source == "roster.yml" and ctx.settings.get("save_to") is None:       # its old_save_to
        return f"providers: {ctx.provider}: {PROVIDERS[ctx.provider]['old_save_to']}: in roster.yml"
    if source == "roster.yml":
        return f"providers: {ctx.provider}: save_to: " + (f"{part}: " if part else "") + "in roster.yml"
    return "save_to" + (f".{part}" if part else "")                          # the choice at save time


def resolve_target(ctx, setting, source):
    """The target SETTING names, checked against what the provider offers (call once it's unlocked)."""
    try:
        setting = check_save_to(setting)
    except ValueError as e:
        raise UnknownTarget(f"{save_to_field(ctx, source)} {e}") from None
    return PROVIDERS[ctx.provider]["resolve"](setting, lambda part=None: save_to_field(ctx, source, part), ctx)


def shown(target):
    """A target as a save's result names it: no save_to, which the app only needs in a list."""
    return {k: v for k, v in target.items() if k != "save_to"}


def target_text(target):
    """A target (a "targets" row) as `roster add --save-to` takes it, by names (save_to_text reads it back):
    `personal`, Bitwarden's `ORGANIZATION/COLLECTION`, KeePassXC's `GROUP`, 1Password's `VAULT`."""
    if target["kind"] == "personal":
        return PERSONAL
    if target["kind"] == "collection":
        return f"{target['organization']}/{target['collection']}"
    return target["label"]


def save_targets(name):
    """Where provider NAME can save, and its default: {targets, default (an id, or None when the setting doesn't
    resolve), from (where the default is set: init.lua, roster.yml or None), problem (that SecretError, or None)}."""
    fn = _writer(name, "targets")
    ctx = Ctx(name, None)
    targets = fn(ctx)
    setting, source = save_to_setting(ctx)
    try:
        default, problem = resolve_target(ctx, setting, source)["id"], None
    except (UnknownTarget, ReadOnlyTarget) as e:
        default, problem = None, e
    return {"targets": targets, "default": default, "from": source, "problem": problem}


def check_target(provider, save_to=None, flag=None):
    """The target a save to PROVIDER would go to (SAVE_TO, from FLAG on the command line; None: the setting's),
    resolved against the vault now, so a target that isn't there is refused before a password is asked (#539's
    review). Unlocks the vault first when it must, as create_item would (the same one prompt), so a wrong master
    password is said before a new one is typed. Returns it as shown();
    UnknownTarget or ReadOnlyTarget naming FLAG or the setting."""
    _writer(provider, "create")
    ctx = Ctx(provider, None)
    setting, source = save_to_setting(ctx) if save_to is None else (save_to, flag or "choice")
    return shown(resolve_target(ctx, setting, source))


def default_target(name):
    """The save_to provider NAME uses when a save doesn't choose, as set (not resolved: no vault call)."""
    setting, source = save_to_setting(Ctx(name, None))
    return {"setting": setting, "from": source or "default"}


# ---- writing Vault items

def can_write(name):
    """Can provider NAME create Vault items (and undo a create)?"""
    p = PROVIDERS.get(name, {})
    return bool(p.get("create") and p.get("delete"))


def _writer(name, op):
    fn = _vault_op(name, op)
    if not (fn and can_write(name)):
        raise CantWrite(f"provider '{name}' can't save to the vault - roster only reads its Logins; "
                        "create the item in the password manager itself")
    return fn


def create_item(provider, *, name, password, username="", uri="", save_to=None):
    """Create a login Vault item NAME in PROVIDER: username, password, and the address in its URI field
    (docs/adding-hosts.md), in SAVE_TO (ticket 35: "personal", {organization, collection}, {group}; None: the
    setting's). Refuses a NAME that's already there. Returns {id, name, target}, never the password; the password
    never goes on a command line or into an error."""
    fn = _writer(provider, "create")
    if not str(name).strip() or not password:
        raise SecretError("a Vault item needs a name and a password")
    ctx = Ctx(provider, None)
    where = save_to_setting(ctx) if save_to is None else (save_to, "choice")
    made = fn({"name": name, "username": username or "", "password": password, "uri": uri or "", "save_to": where},
              ctx)
    return {"id": made["id"], "name": made["name"], "target": shown(made["target"])}


def delete_item(provider, item_id):
    """Delete the Vault item ITEM_ID from PROVIDER: the undo of create_item (Q43). Bitwarden moves it to the
    trash, where it can still be restored for 30 days."""
    fn = _writer(provider, "delete")
    forget_secrets(provider)                             # a value cached from that item must go too
    fn(item_id, Ctx(provider, None))


def login_fields(provider, spec, interactive=True):
    """{uri, username} of the vault item SPEC in PROVIDER (`roster add --from-vault`, vault.item_fields, Q190), each
    None when the item has none. Only a provider that can read them without the password reaching roster has this
    (bw's `bw get uri` / `bw get username`; op's overview and username field, Q197); any other is NoItemFields.
    INTERACTIVE=False (`roster add -y`): never asks, not even for a master password."""
    fn = _vault_op(provider, "login_fields")
    if not fn:
        raise NoItemFields(f"provider '{provider}' can't give an item's address and username without roster reading "
                           "its password too, so roster doesn't ask it", provider)
    name, _ = split_field(spec)
    if not name:
        raise SecretError(f"{provider}: needs an item name or id")
    check_item_name(name)
    ctx = Ctx(provider, None)
    ctx.interactive = ctx.interactive and interactive
    with _secret_lock:
        found = fn(name, ctx)
    return {"uri": found.get("uri") or None, "username": found.get("username") or None}


def _listing_ctx(provider, interactive):
    """A Ctx for listing or syncing: never asks unless INTERACTIVE, and its unlock doesn't sync by itself (the caller
    syncs, or chose not to)."""
    ctx = Ctx(provider, None)
    ctx.interactive = ctx.interactive and interactive
    ctx.settings = {**ctx.settings, "sync": False}
    return ctx


def can_list(provider):
    """Can PROVIDER list its items without a password reaching roster (an "items" hook)?"""
    return bool(_vault_op(provider, "items"))


def vault_items(provider, mapped=None, interactive=False):
    """Every login item in PROVIDER's vault as [{id, name, keys, uris, uri, username, revised}] (uri: the first of uris,
    or None; revised: its revision date when the provider says, for `roster vault sync`), never a password, TOTP seed, note or custom field (Q191: Bitwarden's through roster's filter process).
    MAPPED(item) -> True: a Login in roster.yml names it, so its uris and username may stay empty. INTERACTIVE=False
    never asks, not even for the master password. Unsupported for a provider with no "items" hook."""
    fn = _vault_op(provider, "items")
    if not fn:
        raise Unsupported(f"provider '{provider}' can't list its items without roster reading their passwords too, "
                          "so roster doesn't ask it")
    with _secret_lock:
        found = fn(_listing_ctx(provider, interactive), mapped or (lambda item: False))
    return [{"id": i["id"], "name": i["name"], "keys": sorted(set(i.get("keys") or (i["id"], i["name"]))),
             "uris": list(i.get("uris") or []), "uri": (i.get("uris") or [None])[0],
             "username": i.get("username") or None, "revised": i.get("revised") or None} for i in found]


def sync_vault(provider, interactive=False):
    """Fetch what changed in PROVIDER's vault on its server (`bw sync`): {provider, previous} (the sync before this
    one, an ISO time, or None when it never synced or can't say), or None for a provider with nothing to sync (a
    local file, a CLI that always asks the server). The one sync `roster add --from-vault` and `roster vault sync`
    (vaultsync.py) use. Raises SecretError (e.g. the sync failed, or the vault is locked)."""
    fn = _vault_op(provider, "sync")
    if not fn:
        return None
    with _secret_lock:
        done = fn(_listing_ctx(provider, interactive))
    return {"provider": provider, "previous": done.get("previous")}


# ---- extension points

def add_template_provider(name, conf):
    """roster.yml:  providers: { NAME: { command: "tool get {item} --field {field}", ... } }"""
    command = str(conf["command"])
    default_field = str(conf.get("default_field", "password"))

    def get(spec, ctx):
        item, field = split_field(spec, default_field)
        try:
            line = command.format(item=shlex.quote(item), field=shlex.quote(field), ref=shlex.quote(spec))
        except (KeyError, IndexError, ValueError) as e:
            raise SecretError(f"provider '{name}': bad command template ({e}); "
                              "use {item}, {field}, {ref}, and {{ }} for literal braces")
        # S604: the template is the user's own command (roster.yml's providers:); what roster puts in is shlex-quoted
        r = ctx.run(line, shell=True, interactive=bool(conf.get("interactive")))  # noqa: S604
        if r.returncode != 0:
            raise SecretError(f"provider '{name}' failed for '{item}' (exit {r.returncode}): "
                              f"{errtext(r, stdout=False)}")
        out = r.stdout.rstrip("\r\n")
        return out.splitlines()[0] if conf.get("first_line") and out else out

    PROVIDERS[name] = {"get": get, "help": str(conf.get("help") or f"command: {command}"),
                       "tool": command.split()[0] if command.split() else "", "kind": "roster.yml"}


def load_plugins(dirs):
    import importlib.util
    sys.dont_write_bytecode = True               # don't litter providers/ with __pycache__
    seen = set()
    for d in dirs:
        d = Path(d).expanduser().resolve()
        if d in seen or not d.is_dir():
            continue
        seen.add(d)
        for f in sorted(d.glob("*.py")):
            if f.name.startswith("_"):
                continue
            spec = importlib.util.spec_from_file_location(f"roster_provider_{f.stem}", f)
            if spec is None or spec.loader is None:
                say(f"warning      provider plugin {f} didn't load: Python can't import it")
                continue
            mod = importlib.util.module_from_spec(spec)
            # what a plugin can use without importing anything from roster:
            vars(mod).update(register=register, SecretError=SecretError, split_field=split_field, errtext=errtext)
            try:
                spec.loader.exec_module(mod)
            except Exception as e:
                say(f"warning      provider plugin {f} didn't load: {type(e).__name__}: {e}")


def setup_providers(cfg):
    base = cfg["path"].parent if cfg else Path.cwd()
    dirs = [user_config_dir() / "providers", base / "providers"] + [base / Path(os.path.expanduser(str(d)))
                                                      for d in (cfg or {}).get("provider_dirs", [])]
    load_plugins(dirs)
    for name, conf in ((cfg or {}).get("providers") or {}).items():
        conf = conf or {}
        if not isinstance(conf, dict):
            raise InventoryError(f"providers.{name} in roster.yml must be a mapping")
        PROVIDER_SETTINGS[name] = {**conf, "_base": base}     # _base: where relative paths in it start
        if conf.get("command"):
            if why := bad_name(name):
                raise InventoryError(why)
            add_template_provider(name, conf)



# Built-in providers register themselves on import.
from . import bitwarden, builtin, bw_login, keepassxc, onepassword  # noqa: E402,F401
