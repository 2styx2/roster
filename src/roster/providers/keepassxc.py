"""KeePassXC provider:  auth: kp:ENTRY  /  kp:ENTRY#FIELD  /  kp:GROUP/ENTRY  (a local .kdbx, through keepassxc-cli)

keepassxc-cli has no session: every call opens the database again with the master password, which it reads as the
first line of its stdin (never an argument). So "unlocked" means this process holds the master password in memory
(the provider's state), checked against the database once; lock forgets it. The database and an optional key file
come from roster.yml:  providers: { kp: { database: ~/roster.kdbx, key_file: ~/roster.key, group: Hosts } }, or from
the app's init.lua (vault = { kp = { database = ..., key_file = ... } }, through serve's vault.configure), which wins:
a local database is this Box's own, not the team's.

Checked against keepassxc-cli 2.8.0: prompts go to stderr ("Enter password to unlock DB: "), a value printed by
`show -a ATTR` is on stdout with a newline, every failure is one line on stderr and exit 1. No -q: it also silences
the unlock errors (a wrong password would be a bare exit 1)."""

import os
from pathlib import Path

from ..common import find_program
from . import (
    PROVIDERS,
    ItemExists,
    ItemNotFound,
    NoField,
    NotLoggedIn,
    SecretError,
    SeveralItems,
    TimedOut,
    UnknownTarget,
    VaultLocked,
    WriteFailed,
    WrongPassword,
    manual_unlock,
    near_names,
    register,
    resolve_target,
    setting_name,
    split_field,
)

TOOL = "keepassxc-cli"
NAME = "KeePassXC"
# KeePass's standard attribute names, by the words a Login's #FIELD uses
FIELDS = {"password": "Password", "username": "UserName", "url": "URL", "notes": "Notes", "title": "Title"}


def _path(ctx, key):
    value = ctx.settings.get(key)
    if not value:
        return None
    p = Path(os.path.expanduser(str(value)))
    return p if p.is_absolute() else (ctx.settings.get("_base") or Path.cwd()) / p


def _database(ctx):
    """The .kdbx to use; NotLoggedIn (this box isn't set up for it) when there's none."""
    db = _path(ctx, "database")
    if db is None:
        raise NotLoggedIn(f"{NAME} has no database set on this box - add  providers: {{kp: {{database: "
                          "~/roster.kdbx}}}}  to roster.yml, or  vault = {{ kp = {{ database = \"~/roster.kdbx\" }} }}  "
                          "to the app's init.lua")
    if not db.is_file():
        raise NotLoggedIn(f"{NAME} database {db} isn't there - create it in KeePassXC, or fix "
                          f"{setting_name(ctx, 'database')}")
    return db


def not_set_up(ctx):
    """What to tell a person about a box with no usable database (vault.status's message)."""
    try:
        _database(ctx)
    except NotLoggedIn as e:
        return str(e)
    return None


def _errtext(r, limit=200):
    """keepassxc-cli's own words: stderr minus its password prompt."""
    lines = [x.strip() for x in r.stderr.splitlines() if x.strip() and not x.startswith("Enter password")]
    return " ".join(lines)[:limit]


def _kp(ctx, command, *options, entry=None, password=None, then="", floor=1):
    """Run `keepassxc-cli COMMAND [-k KEY] OPTIONS... DB [ENTRY]`. The master password (PASSWORD, or the one held
    since unlock) is the first line on stdin and THEN follows it; neither ever goes on the command line.
    Raises the vault's own errors (wrong password, missing database or key file); returns the rest to the caller."""
    db = _database(ctx)
    password = ctx.state.get("password") if password is None else password
    if password is None:
        raise VaultLocked(f"{NAME} database is locked - unlock it first")
    key = _path(ctx, "key_file")
    argv = [TOOL, command, *(["-k", str(key)] if key else []), *options, str(db), *([entry] if entry else [])]
    r = ctx.run(argv, input=f"{password}\n{then}", floor=floor)
    err = _errtext(r)
    if r.returncode != 0 and "Invalid credentials" in err:
        ctx.state.pop("password", None)                  # it no longer opens the database (changed meanwhile?)
        raise WrongPassword(f"{NAME} unlock failed (wrong master password{' or key file' if key else ''}?)")
    if r.returncode != 0 and "Failed to load key file" in err:
        raise NotLoggedIn(f"{NAME} can't read the key file {key} - fix {setting_name(ctx, 'key_file')}")
    if r.returncode != 0 and "Failed to open database file" in err:
        raise NotLoggedIn(f"{NAME} can't open the database {db}: {err}")
    return r


def _unlock(password, ctx):
    """Check the master password against the database (one `ls`), then hold it for this process."""
    if "\n" in password or "\r" in password:
        raise WrongPassword(f"{NAME} unlock failed (wrong master password?)")
    r = _kp(ctx, "ls", password=password)
    if r.returncode != 0:
        raise SecretError(f"{NAME} couldn't open the database: {_errtext(r) or f'exit {r.returncode}'}")
    ctx.state["password"] = password


def _ready(ctx):
    """Unlocked, or unlock now: from serve only through vault.unlock, on a terminal by asking."""
    if ctx.state.get("password") is not None:
        return
    _database(ctx)
    if manual_unlock():
        raise VaultLocked(f"{NAME} database is locked - unlock it first")
    if not ctx.interactive:
        raise SecretError(f"{NAME} database is locked and there's no terminal to ask for its master password")
    _unlock(ctx.ask(f"{NAME} master password: "), ctx)


def _status(ctx):
    if not find_program(TOOL):
        return "missing"
    if not_set_up(ctx):
        return "unauthenticated"
    return "unlocked" if ctx.state.get("password") is not None else "locked"


def _lock(ctx):
    ctx.state.pop("password", None)                      # lock() already dropped the state; nothing to run


def _listing(ctx, floor=1):
    """Every group (GROUP/) and entry (GROUP/…/TITLE) path, outside the recycle bin."""
    r = _kp(ctx, "ls", "-R", "-f", floor=floor)
    if r.returncode != 0:
        raise SecretError(f"{NAME} couldn't list the database: {_errtext(r) or f'exit {r.returncode}'}")
    trash = str(ctx.settings.get("recycle_bin", "Recycle Bin")) + "/"
    return [p for p in (x.rstrip("\r") for x in r.stdout.splitlines())
            if p and not p.endswith("[empty]") and not p.startswith(trash)]


def _entries(ctx, floor=1):
    """Every entry's path (GROUP/…/TITLE), outside the recycle bin."""
    return [p for p in _listing(ctx, floor) if not p.endswith("/")]


def _groups(ctx):
    """Every group's path (GROUP/SUB), outside the recycle bin."""
    return [p.rstrip("/") for p in _listing(ctx) if p.endswith("/")]


def _summary(path):
    return {"name": path, "revised": None, "uris": []}


def _find(ctx, ref):
    """The path of the one entry REF names: a path as given (it has a /), else the entry titled exactly REF."""
    if "/" in ref:
        return ref.strip("/")
    paths = _entries(ctx)
    hits = [p for p in paths if p.rsplit("/", 1)[-1] == ref]
    if len(hits) == 1:
        return hits[0]
    if hits:
        raise SeveralItems(f"several {NAME} entries are titled '{ref}' ({', '.join(hits)}) - use its path, "
                           f"e.g. kp:{hits[-1]}", ref, [_summary(p) for p in hits], exact=True)
    raise ItemNotFound(f"no {NAME} entry titled '{ref}'", ref, near_names(ref, [p.rsplit("/", 1)[-1] for p in paths]))


@register("kp", tool=TOOL, help="KeePassXC, a local .kdbx:  kp:ENTRY (its password), kp:GROUP/ENTRY, "
          "kp:ENTRY#FIELD (#username, #url, #notes, or an attribute); set providers: kp: database: in roster.yml. "
          "Install: https://keepassxc.org/download/")
def _keepassxc(spec, ctx):
    ref, field = split_field(spec)
    if not ref:
        raise SecretError("kp: needs an entry title or path, e.g. kp:esx-02 ssh")
    _ready(ctx)
    path = _find(ctx, ref)
    attr = FIELDS.get(field.lower(), field)
    r = _kp(ctx, "show", "-a", attr, entry=path)
    err = _errtext(r)
    if r.returncode != 0 and "Could not find entry" in err:
        raise ItemNotFound(f"no {NAME} entry at '{path}'", ref)
    what = field if field.lower() in FIELDS else f"field '{field}'"
    if r.returncode != 0 and "unknown attribute" in err:
        raise NoField(f"{NAME} entry '{path}' has no {what}", path, field)
    if r.returncode != 0:
        raise SecretError(f"`{TOOL} show` failed: {err or f'exit {r.returncode}'}")
    value = r.stdout[:-1] if r.stdout.endswith("\n") else r.stdout
    if not value:
        raise NoField(f"{NAME} entry '{path}' has no {what} set", path, field)
    return value


# ---- writing: "Save to vault" (ticket 13). `add -p` reads the entry's password as the line after the master
# password, so neither is ever an argument. An entry's id is its path (GROUP/TITLE): KeePassXC's CLI doesn't print
# UUIDs, and the path is what `rm` takes.

def _scrub(text, *values):
    for v in values:
        if v:
            text = text.replace(v, "…")
    return text


# ---- where it goes (ticket 35): the top level, or a group. The default is save_to (init.lua's, then roster.yml's),
# else roster.yml's older `group:`.

TOP = {"id": "personal", "kind": "personal", "label": "Top level", "save_to": "personal"}


def _group_target(group):
    return {"id": f"group:{group}", "kind": "group", "label": group, "save_to": {"group": group}}


def _targets(ctx):
    _ready(ctx)
    return [TOP] + [_group_target(g) for g in _groups(ctx)]


def _resolve(setting, field, ctx):
    if setting == "personal":
        return TOP
    if "group" not in setting:
        raise UnknownTarget(f"{field()} names a Bitwarden organization and collection, but {NAME} saves to the top "
                            "level of its database or a group")
    group = setting["group"].strip("/")
    groups = _groups(ctx)
    if group not in groups:
        raise UnknownTarget(f"no {NAME} group '{group}' in the database (groups: {', '.join(groups) or 'none'}) - "
                            f"fix {field('group')}")
    return _group_target(group)


def _create(item, ctx):
    _ready(ctx)
    name, password = item["name"], item["password"]
    target = resolve_target(ctx, *item["save_to"])
    if "/" in name:
        raise WriteFailed(f"{NAME} entry titles can't contain '/' (it separates groups) - '{name}' wasn't created")
    if "\n" in password or "\r" in password:              # stdin is read a line at a time
        raise WriteFailed(f"{NAME} can't take a password that spans lines - '{name}' wasn't created")
    same = [p for p in _entries(ctx) if p.rsplit("/", 1)[-1] == name]
    if same:
        raise ItemExists(f"a {NAME} entry titled '{name}' already exists ({', '.join(same)}) - Logins look entries "
                         "up by exact title, so roster won't make a second one", name, [_summary(p) for p in same])
    group = target["save_to"]["group"] if target["kind"] == "group" else ""
    path = f"{group}/{name}" if group else name
    options = [*(["-u", item["username"]] if item["username"] else []), *(["--url", item["uri"]] if item["uri"] else [])]
    try:
        r = _kp(ctx, "add", *options, "-p", entry=path, then=f"{password}\n")
    except TimedOut:                                     # stopped: the entry may be saved all the same
        return {**_created_anyway(ctx, name, path), "target": target}
    if r.returncode != 0:
        err = _scrub(_errtext(r), password, ctx.state.get("password"))
        raise WriteFailed(f"{NAME} didn't create '{name}': {err or f'exit {r.returncode}'}"
                          + (f" (is there a group '{group}'?)" if group and "Could not create entry" in err else ""))
    return {"id": path, "name": name, "target": target}


LOOKUP_FLOOR = 7            # s for the look-up after a create timed out, even past serve's deadline


def _created_anyway(ctx, name, path):
    """`keepassxc-cli add` timed out. Nothing had that title before (checked just before), so an entry at PATH now
    is this one: it counts as made (and can be undone). None: nothing was saved. Can't tell: says so, naming it."""
    try:
        there = path in _entries(ctx, floor=LOOKUP_FLOOR)
    except SecretError as e:
        raise WriteFailed(f"{NAME} didn't answer `{TOOL} add` in time, and roster couldn't check whether '{name}' "
                          f"was saved ({e}) - look for it in the database, and delete it if it's not wanted")
    if there:
        return {"id": path, "name": name}
    raise WriteFailed(f"{NAME} didn't answer `{TOOL} add` in time, and there's no '{name}' in the database: "
                      "nothing was saved")


def _delete(item_id, ctx):
    """Q43's undo: `rm` moves the entry to the recycle bin (or deletes it, when the database has none)."""
    _ready(ctx)
    r = _kp(ctx, "rm", entry=item_id)
    if r.returncode != 0:
        raise WriteFailed(f"{NAME} didn't delete entry '{item_id}': {_scrub(_errtext(r), ctx.state.get('password'))}")


PROVIDERS["kp"].update(unlock=_unlock, lock=_lock, status=_status, not_logged_in=not_set_up,
                       login_help=f"{NAME} has no sign-in, only a master password: set providers: kp: database: in "
                                  "roster.yml (or vault.kp.database in the app's init.lua), then unlock",
                       logout_help=f"{NAME} has no account to sign out of: it opens a local database file. To use "
                                   "another one, change vault.kp.database in init.lua",
                       create=_create, delete=_delete, targets=_targets, resolve=_resolve,
                       box_paths=("database", "key_file"))
