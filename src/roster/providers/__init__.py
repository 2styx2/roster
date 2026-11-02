"""Password providers: registry, plugin loading, and the built-ins."""

import getpass
import os
import re
import shlex
import subprocess
import sys
import threading
from pathlib import Path

from ..common import die, program_argv, run, say, time_left, user_config_dir

# ---------------------------------------------------------------- password providers
#
# An `auth:` value is NAME:SPEC (or just NAME). NAME picks a provider; SPEC is handed to it.
#   Built in:  prompt, agent, env, cmd, bw (Bitwarden), op (1Password)
#   Add more without editing this file:
#     - a command template in roster.yml under `providers:` (no code), or
#     - a Python plugin in ~/.config/roster/providers/ or a providers/ folder next to roster.yml
#       (see examples/providers/pass_store.py for a complete example).
# Every provider runs lazily, only when a password is actually needed, and values stay in memory.

class SecretError(RuntimeError):
    """Raise this from a provider with a message that's safe to show (never the secret itself)."""


# Kinds of SecretError a caller (`roster serve`) can tell apart. Providers and plugins raise these where they fit.
class TimedOut(SecretError):
    """A helper command didn't finish in time (it was stopped): what it was doing may or may not have happened."""


class WrongPassword(SecretError):
    """The master password didn't unlock the vault."""


class NotLoggedIn(SecretError):
    """The vault CLI isn't logged in on this box; the message says what to run."""


class CliMissing(SecretError):
    """The provider's command isn't installed."""


class Unsupported(SecretError):
    """The provider has no master password to unlock with."""


class NotSignedIn(SecretError):
    """vault.logout: the CLI isn't signed in to an account, so there's none to sign out of."""


class SignOutFailed(SecretError):
    """vault.logout: the CLI refused to log out; the message has its words."""


class VaultLocked(SecretError):
    """The vault is locked and this process may not unlock it by itself (see MANUAL_UNLOCK)."""


# What can go wrong signing in (`roster serve`'s vault.login). `step`: where the sign-in carries on (the provider
# restarted it, e.g. after a wrong code), or None when it's over. Messages are roster's; never a secret.
class LoginError(SecretError):
    """A sign-in failed some other way; the message has the provider's own words."""

    def __init__(self, message, step=None):
        super().__init__(message)
        self.step = step


class CodeRejected(LoginError):
    """The two-step or new-device code was wrong or expired."""


class MethodUnsupported(LoginError):
    """The account's only two-step methods (or its SSO decryption) are ones the provider's CLI can't do."""


class RateLimited(LoginError):
    """The server refused: too many attempts."""


class ServerUnreachable(LoginError):
    """The vault's server didn't answer (network, wrong address, TLS)."""


class AlreadyLoggedIn(LoginError):
    """The CLI is already logged in on this box: unlock instead."""


class BrowserLoginFailed(LoginError):
    """SSO in the browser failed or didn't finish in time."""


class BadServer(LoginError):
    """The server address given isn't one."""


class ApiKeyRejected(LoginError):
    """The API key (client id / secret) wasn't accepted, or is an organization key."""


class WrongLogin(LoginError):
    """The email or master password wasn't accepted (WrongPassword's sign-in twin)."""


# What can be wrong with the item a Login names. They carry item NAMES (and dates, URIs), never a value.
class ItemNotFound(SecretError):
    """No item by that name. near: names of similar items, closest first."""

    def __init__(self, message, item, near=()):
        super().__init__(message)
        self.item, self.near = item, list(near)


class SeveralItems(SecretError):
    """More than one item matches. matches: [{name, revised, uris}]; exact: they all have that exact name."""

    def __init__(self, message, item, matches, exact):
        super().__init__(message)
        self.item, self.matches, self.exact = item, matches, exact


class NoField(SecretError):
    """The item exists but has no value in the field the Login asks for ("password", or a #FIELD)."""

    def __init__(self, message, item, field):
        super().__init__(message)
        self.item, self.field = item, field


# Writing Vault items (ticket 13: "Save to vault", Q43's verified adds). Names only, never a value.
class CantWrite(SecretError):
    """The provider can only read Logins: it can't create or delete Vault items."""


class ItemExists(SecretError):
    """An item by exactly that name is already there. matches: [{name, revised, uris}]."""

    def __init__(self, message, item, matches):
        super().__init__(message)
        self.item, self.matches = item, matches


class WriteFailed(SecretError):
    """The provider's CLI refused the create or delete; the message has its words (minus any value)."""


# Where a Vault item goes (ticket 35): the personal vault, an organization's collection, a KeePassXC group.
class UnknownTarget(SecretError):
    """The place to save to isn't there (or isn't one this provider has); the message names the setting to fix."""


class ReadOnlyTarget(SecretError):
    """The account may only read the collection it was asked to save to."""


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
                          #             "logout_help": why this provider has no account to sign out of, and what to do
                          #             "create": fn(item, ctx) -> {"id", "name"}, item = {name, username,
                          #                       password, uri}; refuses a name that exists (ItemExists)
                          #             "delete": fn(id, ctx), the undo of a create (Q43)
#             "targets": fn(ctx) -> [target], where the provider can save: each {id, kind, label, save_to}
#             "resolve": fn(setting, field, ctx) -> the target a save_to setting names (UnknownTarget,
#                        ReadOnlyTarget); field(part) names the setting for messages
#             "box_paths": settings naming files on this Box (e.g. kp's database); a change to one
#                          from vault.configure locks the provider (what it holds was for the old one)
PROVIDER_SETTINGS = {}    # name -> settings dict from roster.yml `providers:`
BOX_SETTINGS = {}         # name -> this Box's own settings, from the app's init.lua (`roster serve`'s vault.configure):
                          #   paths and choices only, never a secret. They win over roster.yml's.
PROVIDER_STATE = {}       # name -> per-run scratch space (e.g. "already unlocked")
NO_PASSWORD = ("agent", "key", "none")
MANUAL_UNLOCK = False     # True (`roster serve`): only unlock() unlocks - no session file, no BW_PASSWORD, no prompt
_secrets = {}
_secret_lock = threading.Lock()


def register(name, help="", tool=""):
    """Decorator for provider functions:  @register("vault", help="...", tool="vault")"""
    if not re.match(r"^[a-z0-9_-]+$", name):
        raise ValueError(f"provider name {name!r} must be lowercase letters, digits, _ or -")

    def deco(fn):
        PROVIDERS[name] = {"get": fn, "help": help, "tool": tool,
                           "kind": "built-in" if fn.__module__.startswith("roster.") else "plugin"}
        return fn
    return deco


def split_field(spec, default="password"):
    """'Item name#field' -> ('Item name', 'field');  'Item name' -> ('Item name', default)."""
    item, _, field = spec.partition("#")
    return item.strip(), field.strip() or default


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

    def run(self, args, env=None, shell=False, interactive=False, timeout=120, input=None, floor=1):
        """Run a helper command, capturing output. A missing tool becomes a friendly error.
        INPUT goes to its stdin (the way to hand a tool a secret: never in args). The timeout is held to serve's
        deadline (common.time_left), but never below FLOOR; past it, TimedOut."""
        tool = args if isinstance(args, str) else args[0]
        stdin = {} if input is not None else {"stdin": None if interactive else subprocess.DEVNULL}
        try:
            if not shell:
                args = program_argv(args)
            return run(args, shell=shell, text=True, timeout=time_left(timeout, floor),
                       input=input, env={**os.environ, **(env or {})}, **stdin)
        except FileNotFoundError:
            raise CliMissing(not_installed(self.provider, tool))
        except subprocess.TimeoutExpired:
            raise TimedOut(f"`{tool}` timed out")
        except ValueError as e:                     # program_argv: a batch file and an argument cmd.exe acts on
            raise SecretError(str(e))


def not_installed(name, tool=None):
    hint = PROVIDERS.get(name, {}).get("help", "")
    tool = tool or PROVIDERS.get(name, {}).get("tool") or name
    return f"`{tool}` is not installed on this box" + (f" ({hint})" if hint else "")


def errtext(r, limit=160):
    """A tool's error output minus noise (node deprecation warnings etc.), shortened."""
    lines = [line for line in (r.stderr + "\n" + r.stdout).splitlines()
             if line.strip() and not line.startswith(("(node", "(Use "))]
    return " ".join(lines)[:limit]


def manual_unlock():
    """For providers: is unlocking by themselves (session file, password env var, prompt) off in this process?"""
    return MANUAL_UNLOCK


def get_secret(ref, group):
    """Resolve an auth reference via its provider. Cached for this run, never written anywhere."""
    if ref in (None, "") or ref in NO_PASSWORD:
        return None
    name, _, spec = str(ref).partition(":")
    name = name.strip()
    if name not in PROVIDERS:
        raise SecretError(f"unknown password source {name!r} in auth {ref!r} - available: "
                          f"{', '.join(sorted(PROVIDERS))} (see `roster providers`)")
    cache_key = (ref, group) if name == "prompt" else ref
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


# ---- this Box's own settings (ticket 41): from the app's init.lua, through `roster serve`'s vault.configure

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


# ---- where a Vault item goes (ticket 35): `save_to`, the same shape in roster.yml, init.lua and a save's choice

PERSONAL = "personal"
SAVE_TO_SHAPES = '"personal", {organization, collection} (Bitwarden, by name or id) or {group} (KeePassXC)'


def check_save_to(value):
    """VALUE as a save_to setting, or ValueError saying what it may be."""
    if value == PERSONAL:
        return value
    if isinstance(value, dict) and set(value) in ({"organization", "collection"}, {"group"}) \
            and all(isinstance(v, str) and v.strip() for v in value.values()):
        return {k: v.strip() for k, v in value.items()}
    raise ValueError(f"must be {SAVE_TO_SHAPES}, not {value!r}")


def save_to_setting(ctx):
    """CTX's default target as (setting, source): init.lua's `vault.save_to`, else roster.yml's `providers: NAME:
    save_to:` (KeePassXC: its older `group:`), else the personal vault. source: "init.lua", "roster.yml" or None."""
    if ctx.settings.get("save_to") is not None:
        return ctx.settings["save_to"], "init.lua" if "save_to" in ctx.from_box else "roster.yml"
    if ctx.provider == "kp" and ctx.settings.get("group"):         # kp's group: came before save_to
        return {"group": str(ctx.settings["group"])}, "roster.yml"
    return PERSONAL, None


def save_to_field(ctx, source, part=None):
    """The name of the setting a save_to came from, for messages (PART: organization, collection, group)."""
    if source == "init.lua":
        return "vault.save_to" + (f".{part}" if part else "") + " in init.lua"
    if source == "roster.yml" and ctx.settings.get("save_to") is None:       # kp's group:
        return f"providers: {ctx.provider}: group: in roster.yml"
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


def default_target(name):
    """The save_to provider NAME uses when a save doesn't choose, as set (not resolved: no vault call)."""
    setting, source = save_to_setting(Ctx(name, None))
    return {"setting": setting, "from": source or "default"}


# ---- writing Vault items (ticket 13)

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
    with _secret_lock:                                   # a value cached from that item must go too
        for ref in [r for r in _secrets if str(r[0] if isinstance(r, tuple) else r).startswith(provider + ":")]:
            del _secrets[ref]
    fn(item_id, Ctx(provider, None))


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
        r = ctx.run(line, shell=True, interactive=bool(conf.get("interactive")))
        if r.returncode != 0:
            raise SecretError(f"provider '{name}' failed for '{item}' (exit {r.returncode}): {errtext(r)}")
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
            mod = importlib.util.module_from_spec(spec)
            # what a plugin can use without importing anything from roster:
            mod.register, mod.SecretError, mod.split_field, mod.errtext = register, SecretError, split_field, errtext
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
            die(f"providers.{name} in roster.yml must be a mapping")
        PROVIDER_SETTINGS[name] = {**conf, "_base": base}     # _base: where relative paths in it start
        if conf.get("command"):
            if not re.match(r"^[a-z0-9_-]+$", name):
                die(f"provider name {name!r} must be lowercase letters, digits, _ or -")
            add_template_provider(name, conf)



# Built-in providers register themselves on import.
from . import bitwarden, builtin, bw_login, keepassxc, onepassword  # noqa: E402,F401
