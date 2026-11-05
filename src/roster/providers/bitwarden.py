"""Bitwarden CLI provider:  auth: bw:ITEM  /  bw:ITEM#FIELD"""

import base64
import json
import os

from ..common import NotPrivate, find_program, read_private, say, user_config_dir
from . import (
    PROVIDERS,
    ItemExists,
    ItemNotFound,
    NoField,
    NotLoggedIn,
    NotSignedIn,
    ReadOnlyTarget,
    SecretError,
    SeveralItems,
    SignOutFailed,
    TimedOut,
    UnknownTarget,
    VaultLocked,
    WriteFailed,
    WrongPassword,
    check_item_name,
    errtext,
    manual_unlock,
    near_names,
    register,
    resolve_target,
    split_field,
)

# ---- built-in: Bitwarden

def _bw(ctx, *args, env=None, input=None, floor=1, discard=False):
    key = session_key()
    env = {**({"BW_SESSION": key} if key else {}), **(env or {})}
    return ctx.run(["bw", *args, "--nointeraction"], env=env, input=input, floor=floor, discard=discard)


# The unlocked vault's session key. It goes into each `bw` call's env and nowhere else, never os.environ: every other
# program roster starts (ssh and what its config runs, git and its hooks, nmap, another vault's CLI) would inherit it
# from there, and with bw's local data the key opens the whole vault.
_session: dict[str, str | None] = {"key": None}


def session_key():
    """This process's Bitwarden session key, or None. A BW_SESSION inherited from the shell is moved out of os.environ
    on first use, so from then on only bw gets it."""
    inherited = os.environ.pop("BW_SESSION", None)
    if inherited and not _session["key"]:
        _session["key"] = inherited
    return _session["key"]


def set_session(key):
    os.environ.pop("BW_SESSION", None)
    _session["key"] = key or None


def forget_session():
    os.environ.pop("BW_SESSION", None)
    _session["key"] = None


NOT_LOGGED_IN = "Bitwarden CLI isn't logged in on this box - run `bw login` once"


def session_file():
    return user_config_dir() / "bw-session"


def load_session_file():
    """BW_SESSION from ~/.config/roster/bw-session, so sessions without your shell's env (background jobs,
    other terminals) can use an unlocked vault. Ignored, with a warning, unless it's yours alone (common.read_private:
    not a link, owned by you, nobody else can read it; #411)."""
    if session_key():
        return False
    f = session_file()
    try:
        key = read_private(f).strip()
    except FileNotFoundError:
        return False
    except NotPrivate as e:
        say(f"warning      {e} - ignored")
        return False
    if key:
        set_session(key)
    return bool(key)


def _bw_status_json(ctx):
    """`bw status` as a dict: status, and (when it says) userEmail and serverUrl (None for bitwarden.com)."""
    try:
        return json.loads(_bw(ctx, "status").stdout or "{}")
    except json.JSONDecodeError:
        raise SecretError("couldn't read `bw status` output")


def _bw_status(ctx):
    return _bw_status_json(ctx).get("status")


def _bw_ready(ctx):
    if ctx.state.get("ready"):
        return
    from_file = False if manual_unlock() else load_session_file()
    status = _bw_status(ctx)
    if status == "unauthenticated":
        if not (os.environ.get("BW_CLIENTID") and os.environ.get("BW_CLIENTSECRET")):
            raise NotLoggedIn(f"{NOT_LOGGED_IN} "
                              "(or set BW_CLIENTID and BW_CLIENTSECRET to use an API key)")
        if _bw(ctx, "login", "--apikey").returncode != 0:
            raise SecretError("`bw login --apikey` failed - check BW_CLIENTID / BW_CLIENTSECRET")
        status = "locked"
    if status == "locked" and from_file:
        forget_session()
        if not (os.environ.get("BW_PASSWORD") or ctx.interactive):
            raise SecretError(f"the Bitwarden session in {session_file()} has expired (vault locked) - refresh it: "
                              f"(umask 077; bw unlock --raw > {session_file()})")
    if status == "locked" and manual_unlock():
        raise VaultLocked("Bitwarden vault is locked - unlock it first")
    if status == "locked":
        if os.environ.get("BW_PASSWORD"):
            r = _bw(ctx, "unlock", "--raw", "--passwordenv", "BW_PASSWORD")
        elif ctx.interactive:
            r = _bw(ctx, "unlock", "--raw", "--passwordenv", "ROSTER_BW_MASTER",
                    env={"ROSTER_BW_MASTER": ctx.ask("Bitwarden master password: ")})
        else:
            raise SecretError("Bitwarden vault is locked and there's no terminal to unlock it. In the shell "
                              "you start Claude (or roster) from, run:  export BW_SESSION=$(bw unlock --raw)  "
                              f"- or, for every session on this box:  (umask 077; bw unlock --raw > {session_file()})")
        if r.returncode != 0 or not r.stdout.strip():
            raise WrongPassword("Bitwarden unlock failed (wrong master password?)")
        set_session(r.stdout.strip())
    if ctx.settings.get("sync", True) and _bw(ctx, "sync").returncode != 0:
        say("warning      `bw sync` failed - using the vault as last synced")
    ctx.state["ready"] = True


def _bw_unlock(password, ctx):
    """Unlock with a master password given as a value (from `roster serve`), via the env-var path. One `bw`
    call (each costs about a second of Node start-up): bw itself says "You are not logged in." when it isn't."""
    r = _bw(ctx, "unlock", "--raw", "--passwordenv", "ROSTER_BW_MASTER", env={"ROSTER_BW_MASTER": password})
    if r.returncode != 0 or not r.stdout.strip():
        if "not logged in" in errtext(r).lower():
            raise NotLoggedIn(NOT_LOGGED_IN)
        raise WrongPassword("Bitwarden unlock failed (wrong master password?)")
    set_session(r.stdout.strip())


def _bw_vault_status(ctx):
    """`bw status` as-is (this process's session key only, never the session file); "missing" if no bw."""
    return _bw_status(ctx) if find_program("bw") else "missing"


def _bw_account(ctx):
    """vault_account for bw: the status and {email, server} (server None: bitwarden.com) from one `bw status`."""
    if not find_program("bw"):
        return "missing", None
    st = _bw_status_json(ctx)
    status = st.get("status")
    if status in ("locked", "unlocked") and st.get("userEmail"):
        return status, {"email": st["userEmail"], "server": st.get("serverUrl")}
    return status, None


def _bw_forget(ctx):
    forget_session()


def _bw_lock(ctx):
    try:
        _bw(ctx, "lock")
    finally:
        _bw_forget(ctx)


def _bw_logout(ctx):
    """`bw logout`: removes the account and the CLI's local copy of the vault (the server setting stays). The session
    key goes first, so it's gone even if bw then fails."""
    _bw_forget(ctx)
    r = _bw(ctx, "logout")
    if r.returncode != 0:
        if "not logged in" in errtext(r).lower():
            raise NotSignedIn("the Bitwarden CLI isn't signed in on this box - there's no account to sign out of")
        raise SignOutFailed(f"`bw logout` failed: {errtext(r) or 'bw exited without saying why'}")


def _bw_list(ctx, *search):
    """The filter's rows for `bw list items [--search SEARCH]` (Q191, T229), or [] when bw can't say (out of time is
    still TimedOut): only for a message's suggestions, which go without."""
    try:
        return _bw_rows(ctx, *(("--search", search[0]) if search else ()))
    except TimedOut:
        raise
    except SecretError:
        return []


def _bw_summary(row):
    """What may be shown about an item: its name and URIs (from the filter's row, Q191). Never a value. The filter
    has no edit date, so `revised` is None."""
    return {"name": row["name"], "revised": None, "uris": row["uris"]}


def _bw_get(ctx, ref):
    """`bw get item REF`: (the item, "", "") when REF names exactly one, else (None, bw's error shortened, its whole
    stderr). The one item is read whole, its password, TOTP seed, notes and custom fields too: bw has no other way to
    give a custom field, and the Login being resolved needs one of them (Q191 (p))."""
    r = _bw(ctx, "get", "item", ref)
    if r.returncode != 0:
        return None, errtext(r, stdout=False), r.stderr or ""
    try:
        return json.loads(r.stdout), "", ""
    except json.JSONDecodeError:
        raise SecretError("couldn't read `bw get item` output") from None


def _found_ids(stderr):
    """The ids bw's "More than one result" names, one a line after its words (bw 2026.9.1's
    Response.multipleResults), of every item type; [] when it names none."""
    _, sep, rest = stderr.partition("The following objects were found:")
    return [w for w in (line.strip() for line in rest.splitlines()) if w and " " not in w] if sep else []


def _bw_item(ctx, ref):
    """The one item REF names, by `bw get item` (its id or a name). Several or none are looked up in the filter's
    rows (T229, #443): the one with exactly that name is then fetched by its id; near names are names only.
    The rows are login items only, so several matches are decided from them only when every item bw found is one
    of them; otherwise they fail closed (SeveralItems with the total), never picking the one login (#446, M1)."""
    check_item_name(ref)
    item, err, stderr = _bw_get(ctx, ref)
    if item is not None:
        return item
    if "More than one" in err:
        listed = _bw_list(ctx, ref)
        found = _found_ids(stderr)
        rows = {i["id"]: i for i in listed}
        if not found or any(f not in rows for f in found):     # bw found an item that isn't a login row
            shown = [_bw_summary(rows[f]) for f in found if f in rows]
            total = max(len(found), len(shown) + 1)
            raise SeveralItems(f"{total} Bitwarden items match '{ref}', some of them aren't logins - use the item's "
                               "id instead (the Bitwarden app shows it)", ref, shown, exact=False, total=total)
        listed = [rows[f] for f in found]
        exact = [i for i in listed if i["name"] == ref]
        if len(exact) == 1:
            item, err, _ = _bw_get(ctx, exact[0]["id"])
            if item is not None:
                return item
            raise SecretError(f"`bw get item` failed: {err}")
        matches = [_bw_summary(i) for i in (exact or listed)]
        raise SeveralItems(f"several Bitwarden items match '{ref}' - use the item's id instead "
                           "(the Bitwarden app shows it)", ref, matches, exact=bool(exact))
    if "Not found" in err:
        near = near_names(ref, [i["name"] for i in _bw_list(ctx)])
        raise ItemNotFound(f"no Bitwarden item matches '{ref}'", ref, near)
    raise SecretError(f"`bw get item` failed: {err}")


@register("bw", tool="bw", help="Bitwarden CLI:  bw:ITEM (login password), bw:ITEM#FIELD "
          "(custom field, #username, #notes). Install: https://bitwarden.com/help/cli/")
def _bitwarden(spec, ctx):
    name, field = split_field(spec)
    if not name:
        raise SecretError("bw: needs an item name or id, e.g. bw:Orion servers")
    _bw_ready(ctx)
    item = _bw_item(ctx, name)
    login = item.get("login") or {}
    if field == "password":
        val = login.get("password")
    elif field == "username":
        val = login.get("username")
    elif field == "notes":
        val = item.get("notes")
    else:
        fields = item.get("fields") or []
        hit = ([f for f in fields if f.get("name") == field]
               or [f for f in fields if str(f.get("name", "")).lower() == field.lower()])
        val = hit[0].get("value") if hit else None
    if not val:
        what = field if field in ("password", "username", "notes") else f"field '{field}'"
        raise NoField(f"Bitwarden item '{item.get('name', name)}' has no {what} set", item.get("name", name), field)
    return val


# ---- writing: "Save to vault" (ticket 13). `bw create item` takes the item as base64 JSON, the way
# `bw encode` makes it, on stdin when no argument is given (bw 2026.9.1's create.command.ts), so the
# password never goes on a command line. bw prints the new item back, password and all: only its id is kept.

def _scrub(text, *values):
    for v in values:
        if v:
            text = text.replace(v, "…")
    return text


# ---- where it goes (ticket 35): the personal vault, or a collection of an organization you're in. bw 2026.9.1's
# `bw create item` takes organizationId and collectionIds in the item and creates it there (its SDK create request
# carries both), so no `bw move` is needed. Its `bw list collections` doesn't say which collections the account may
# only read (the CLI's CollectionResponse has no readOnly), so roster checks the new item: one that isn't in the
# collection asked for was refused it, and is taken back out (ReadOnlyTarget). That collection is then left out of
# the targets until the vault is locked.

PERSONAL_TARGET = {"id": "personal", "kind": "personal", "label": "Personal vault", "save_to": "personal"}
CONFIRMED = 2               # bw's OrganizationUserStatusType: invited 0, accepted 1, confirmed 2 (has the keys)


def _bw_listed(ctx, *what):
    r = _bw(ctx, "list", *what)
    try:
        listed = json.loads(r.stdout) if r.returncode == 0 else None
    except json.JSONDecodeError:
        listed = None
    if not isinstance(listed, list):
        raise SecretError(f"`bw list {what[0]}` failed: {errtext(r) or f'exit {r.returncode}'}")
    return listed


def _bw_orgs(ctx):
    """The organizations whose collections the account can save to: confirmed in, and enabled."""
    return [o for o in _bw_listed(ctx, "organizations") if o.get("status") == CONFIRMED and o.get("enabled", True)]


def _collection_target(org, c):
    return {"id": f"collection:{c['id']}", "kind": "collection", "label": f"{org['name']} / {c['name']}",
            "organization": org["name"], "collection": c["name"],
            "save_to": {"organization": org["id"], "collection": c["id"]}}


def _bw_targets(ctx):
    _bw_ready(ctx)
    orgs = {o["id"]: o for o in _bw_orgs(ctx)}
    refused = ctx.state.get("read_only", set())
    return [PERSONAL_TARGET] + [_collection_target(orgs[c["organizationId"]], c) for c in _bw_listed(ctx, "collections")
                                if c.get("organizationId") in orgs and c.get("id") not in refused]


def _pick(things, ref, what, field, scope=""):
    """The one of THINGS (organizations, collections) whose id or exact name is REF."""
    hits = [t for t in things if t.get("id") == ref] or [t for t in things if t.get("name") == ref]
    if len(hits) == 1:
        return hits[0]
    if hits:
        raise UnknownTarget(f"{len(hits)} Bitwarden {what}s{scope} are named '{ref}' - give its id instead "
                            f"({', '.join(h['id'] for h in hits)}) in {field}")
    yours = ", ".join(t.get("name", "?") for t in things) or "none"
    raise UnknownTarget(f"no Bitwarden {what} '{ref}'{scope} that you can save to (yours: {yours}) - fix {field}")


def _bw_resolve(setting, field, ctx):
    if setting == "personal":
        return PERSONAL_TARGET
    if "group" in setting:
        raise UnknownTarget(f"{field()} names a KeePassXC group ('{setting['group']}'), but Bitwarden saves to the "
                            "personal vault or an organization's collection")
    org = _pick(_bw_orgs(ctx), setting["organization"], "organization", field("organization"))
    collections = [c for c in _bw_listed(ctx, "collections") if c.get("organizationId") == org["id"]]
    c = _pick(collections, setting["collection"], "collection", field("collection"), f" in {org['name']}")
    if c["id"] in ctx.state.get("read_only", ()):
        raise _read_only(_collection_target(org, c))
    return _collection_target(org, c)


def _read_only(target, what=""):
    return ReadOnlyTarget(f"you can only read the Bitwarden collection {target['label']}, so nothing can be saved "
                          f"there{what}")


def _bw_create(item, ctx):
    _bw_ready(ctx)
    name, password = item["name"], item["password"]
    target = resolve_target(ctx, *item["save_to"])
    collection = target["save_to"]["collection"] if target["kind"] == "collection" else None
    if _bw(ctx, "sync").returncode != 0:                   # see items made elsewhere since this run's first sync
        say("warning      `bw sync` failed - checking for a duplicate name in the vault as last synced")
    try:
        listed = _bw_rows(ctx, "--search", name)          # through the filter (T229): names and URIs, never a value
    except SecretError as e:
        raise WriteFailed(f"couldn't check the vault for an item named '{name}': {e}") from None
    same = [_bw_summary(i) for i in listed if i["name"] == name]
    if same:
        raise ItemExists(f"a Bitwarden item named '{name}' already exists - Logins look items up by exact name, "
                         "so roster won't make a second one", name, same)
    login = {"username": item["username"] or None, "password": password, "totp": None,
             "uris": [{"uri": item["uri"], "match": None}] if item["uri"] else []}
    where = {"organizationId": target["save_to"]["organization"], "collectionIds": [collection]} if collection \
        else {"organizationId": None}
    encoded = base64.b64encode(json.dumps({
        "type": 1, "name": name, "notes": None, "favorite": False, "fields": [], "reprompt": 0,
        **where, "folderId": None, "login": login}).encode()).decode()
    try:
        r = _bw(ctx, "create", "item", input=encoded)
    except TimedOut:                                       # bw was stopped: the item may be saved all the same
        r, made = None, _created_anyway(ctx, name)
    if r is not None and r.returncode != 0:                # stderr only: stdout would be the item itself
        err = _scrub(" ".join(r.stderr.split()), password, encoded)[:160]
        if collection and any(w in err.lower() for w in ("permission", "not found", "do not have")):
            ctx.state.setdefault("read_only", set()).add(collection)
            raise _read_only(target, f" (Bitwarden: {err})")
        raise WriteFailed(f"Bitwarden didn't create '{name}': {err or f'exit {r.returncode}'}")
    if r is not None:
        try:                                               # the new item as bw prints it: the password is roster's own
            made = json.loads(r.stdout)
        except json.JSONDecodeError:
            made = {}
        made = made if isinstance(made, dict) else {}
    ours = r is not None and bool(made.get("id"))         # bw's own answer named it (not a row found by name)
    if r is not None and not ours:                         # bw's answer didn't parse: find it, so it can be undone
        made = _found_by_name(ctx, name)
    if collection and not _in_collection(ctx, made, collection):
        _refused_collection(ctx, made, target, ours)
    return {"id": made["id"], "name": made.get("name", name), "target": target}


def _found_by_name(ctx, name):
    """bw's create answer didn't parse: the one row named exactly NAME is this item (none was before the create, as
    _created_anyway), else WriteFailed: none, several, or a listing that failed (roster couldn't check)."""
    try:
        found = [i for i in _bw_rows(ctx, "--search", name) if i["name"] == name]
    except TimedOut:
        raise
    except SecretError as e:
        raise WriteFailed(f"Bitwarden's answer to `bw create item` didn't read, and roster couldn't check whether "
                          f"'{name}' was saved ({e}) - look for it in the vault, and delete it if it's not wanted") \
            from None
    if not found:
        raise WriteFailed(f"Bitwarden said it created '{name}' but it isn't in the vault - check it there")
    if len(found) > 1:
        raise WriteFailed(f"Bitwarden's answer to `bw create item` didn't read, and now {len(found)} items are named "
                          f"'{name}' - check them in the vault and delete the extra one")
    return found[0]


def _in_collection(ctx, made, collection):
    """Whether the new item MADE is in COLLECTION: bw's create answer says (collectionIds); a filter row (the answer
    was lost, T229) doesn't, so the collection's items are listed through the filter, by id."""
    if "collectionIds" in made:
        return collection in (made.get("collectionIds") or [])
    try:
        return any(i["id"] == made["id"] for i in _bw_rows(ctx, "--collectionid", collection, floor=LOOKUP_FLOOR))
    except SecretError as e:
        raise WriteFailed(f"Bitwarden saved '{made.get('name', '')}', but roster couldn't check it went into the "
                          f"collection ({e}) - check it in the vault") from None


def _refused_collection(ctx, made, target, ours=True):
    """Bitwarden saved the item but not into the collection (the account may only read it): take it back out. Only
    one bw's own create answer named (OURS): one found by name may be someone else's, so it's said, never deleted."""
    ctx.state.setdefault("read_only", set()).add(target["save_to"]["collection"])
    name = made.get("name", "")
    if not ours:
        raise _read_only(target, f"; '{name}' ({made['id']}) seems to have been saved outside it, but bw's answer was "
                                 "lost, so roster won't delete it - check it in the vault and delete it if it's yours")
    try:
        _bw_delete(made["id"], ctx)
    except SecretError as e:
        raise _read_only(target, f"; '{name}' was saved outside it and roster couldn't take it back out ({e}) - "
                                 "delete it in the vault (an organization admin may have to)") from None
    raise _read_only(target, f"; '{name}' was taken back out")


LOOKUP_FLOOR = 7            # s for each of the sync and the list after a create timed out, even past serve's deadline


def _bw_lookup(ctx, name):
    """The filter's rows (Q191, T229) for the items named exactly NAME, synced from the server first. Raises
    SecretError if bw can't say."""
    _bw(ctx, "sync", floor=LOOKUP_FLOOR)
    return [i for i in _bw_rows(ctx, "--search", name, floor=LOOKUP_FLOOR) if i["name"] == name]


def _created_anyway(ctx, name):
    """`bw create item` timed out. No item had that exact name before (checked just before), so one that has it now
    is this one: it counts as made (and can be undone). None: nothing was saved. Can't tell: says so, naming it."""
    try:
        found = _bw_lookup(ctx, name)
    except SecretError as e:
        raise WriteFailed(f"Bitwarden didn't answer `bw create item` in time, and roster couldn't check whether "
                          f"'{name}' was saved ({e}) - look for it in the vault, and delete it if it's not wanted")
    if len(found) == 1:
        return found[0]
    if not found:
        raise WriteFailed(f"Bitwarden didn't answer `bw create item` in time, and there's no '{name}' in the vault: "
                          "nothing was saved")
    raise WriteFailed(f"Bitwarden didn't answer `bw create item` in time, and now {len(found)} items are named "
                      f"'{name}' - check them in the vault and delete the extra one")


def _bw_delete(item_id, ctx):
    _bw_ready(ctx)
    r = _bw(ctx, "delete", "item", item_id)
    if r.returncode != 0:
        raise WriteFailed(f"Bitwarden didn't delete item {item_id}: {errtext(r)}")


# ---- an item's address and user, never its password (Q190). `bw get uri` and `bw get username` print just that
# field, but each narrows several matches by its own field (bw's getCipher(id, filter)), so the two could come from two
# items. So first `bw get item ITEM` with its stdout sent to the null device: only its exit code and stderr reach
# roster, and they say whether ITEM names exactly one item. Several are never listed (`bw list items` prints every
# match's password): the message asks for the item's id.

SEVERAL = "several Bitwarden items match '{}' - use the item's id instead (the Bitwarden app shows it)"
NO_FIELD = {"uri": "No uri available", "username": "No username available"}     # bw's words for an empty field


def _bw_one(ctx, name, r):
    err = errtext(r, stdout=False)
    if "More than one" in err:
        raise SeveralItems(SEVERAL.format(name), name, [], exact=False)
    if "Not found" in err:
        raise ItemNotFound(f"no Bitwarden item matches '{name}'", name)
    return err


def _bw_login_fields(name, ctx):
    _bw_ready(ctx)
    r = _bw(ctx, "get", "item", name, discard=True)           # one item? Its output (the password) is never read
    if r.returncode != 0:
        raise SecretError(f"`bw get item` failed: {_bw_one(ctx, name, r)}")
    out = {}
    for field in ("uri", "username"):
        r = _bw(ctx, "get", field, name)
        if r.returncode == 0:
            out[field] = r.stdout.strip() or None
            continue
        err = _bw_one(ctx, name, r)
        if NO_FIELD[field] in err:
            out[field] = None
            continue
        raise SecretError(f"`bw get {field}` failed: {err}")
    return out


# ---- every item's name, URIs and username, never a password (Q191, the owner's ruling of 2026-11-04). bw has no
# listing that leaves secrets out: `bw list items` prints every item whole. So its stdout goes straight into roster's
# filter (bw_items_filter.py, its own Python process: `python -I -S`, an OS pipe between the two), and roster reads
# only the filter's lines: {id, name, uris, username, revised} per login item. bw's stderr is read as for any bw call.

FILTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bw_items_filter.py")
LIST_CAP = 64 * 1024 * 1024            # bytes of `bw list items` the filter reads; more is refused, not cut short
ROW_KEYS = {"id", "name", "uris", "username", "revised"}


def _filter_argv():
    import sys
    if not sys.executable:
        raise SecretError("roster can't list Bitwarden items here: it can't find its own Python to run its filter")
    return [sys.executable, "-I", "-S", FILTER, str(LIST_CAP)]


def _bw_rows(ctx, *search, floor=1):
    """`bw list items` (`--search SEARCH`, `--collectionid ID`, ...) through the filter: {id, name, uris, username,
    revised} per login item, never a value (Q191). The vault must be ready. SecretError if bw or the filter can't say."""
    key = session_key()
    bw, filt = ctx.run_filtered(["bw", "list", "items", *search, "--nointeraction"], _filter_argv(),
                                env={"BW_SESSION": key} if key else None, floor=floor)
    if filt.returncode == 3:                    # first: bw itself then fails writing to a pipe no one reads
        raise SecretError(f"the vault has too many items for roster to list (over {LIST_CAP // (1024 * 1024)} MB "
                          "from `bw list items`)")
    if bw.returncode != 0:
        raise SecretError(f"`bw list items` failed: {errtext(bw, stdout=False) or f'exit {bw.returncode}'}")
    rows = []
    try:
        if filt.returncode != 0:
            raise ValueError
        for line in filt.stdout.splitlines():
            row = json.loads(line)
            if not isinstance(row, dict) or set(row) != ROW_KEYS:
                raise ValueError
            rows.append({"id": str(row["id"]), "name": str(row["name"]), "keys": [str(row["id"]), str(row["name"])],
                         "uris": [str(u) for u in row["uris"]], "username": row["username"],
                         "revised": row["revised"]})
    except (ValueError, TypeError):
        raise SecretError("roster couldn't read the list of Bitwarden items (`bw list items` didn't print a list "
                          "of items)") from None
    return rows


def _bw_items(ctx, mapped):
    _bw_ready(ctx)
    return _bw_rows(ctx)


def _bw_sync(ctx):
    """`bw sync`, after the time of the one before it (`bw status`'s lastSync). Its output is never read."""
    _bw_ready(ctx)
    previous = _bw_status_json(ctx).get("lastSync") or None
    r = _bw(ctx, "sync", discard=True)
    if r.returncode != 0:
        raise SecretError(f"`bw sync` failed: {errtext(r, stdout=False) or f'exit {r.returncode}'}")
    return {"previous": previous}


PROVIDERS["bw"].update(unlock=_bw_unlock, lock=_bw_lock, forget=_bw_forget, status=_bw_vault_status,
                       account=_bw_account, logout=_bw_logout, not_logged_in=NOT_LOGGED_IN,
                       create=_bw_create, delete=_bw_delete, targets=_bw_targets, resolve=_bw_resolve,
                       login_fields=_bw_login_fields, items=_bw_items, sync=_bw_sync)
