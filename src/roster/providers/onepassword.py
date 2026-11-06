"""1Password CLI provider:  auth: op:ITEM  /  op:VAULT/ITEM#FIELD  /  op:op://..."""

import json
import os
import re
import time

from . import (
    LOOKUP_FLOOR,
    PROVIDERS,
    ItemExists,
    ItemNotFound,
    SecretError,
    SeveralItems,
    TimedOut,
    UnknownTarget,
    WriteFailed,
    errtext,
    register,
    repeats_secret,
    resolve_target,
    split_field,
    withheld,
)
from .bw_items_filter import no_userinfo

# ---- built-in: 1Password

def _op_base(ctx):
    acct = ctx.settings.get("account")
    return ["op"] + (["--account", str(acct)] if acct else [])


def _op(ctx, args, **kw):
    """Run op with this run's sign-in (OP_SESSION_*) in its own env only: never os.environ, which every other program
    roster starts would inherit. The sign-in lives in the provider's state, which a lock forgets; one inherited from the
    shell (`eval $(op signin)`) is moved there on first use."""
    adopt_inherited_session(ctx.state)
    return ctx.run(args, env=ctx.state.get("env"), **kw)


def adopt_inherited_session(state):
    """Move an OP_SESSION_* this process inherited out of os.environ into the op provider's STATE (its "env"), where
    only op calls get it and a lock forgets it."""
    inherited = {k: os.environ.pop(k, None) for k in [k for k in os.environ if k.startswith("OP_SESSION_")]}
    inherited = {k: v for k, v in inherited.items() if v is not None}
    if inherited:
        state["env"] = {**inherited, **state.get("env", {})}


def _op_ready(ctx):
    if ctx.state.get("ready") or os.environ.get("OP_SERVICE_ACCOUNT_TOKEN"):
        ctx.state["ready"] = True
        return
    if _op(ctx, _op_base(ctx) + ["whoami"]).returncode == 0:
        ctx.state["ready"] = True
        return
    # Not signed in. With the 1Password app integration this pops a biometric/app prompt;
    # otherwise it asks for the account password on the terminal.
    r = _op(ctx, _op_base(ctx) + ["signin"], interactive=ctx.interactive, timeout=180)
    ctx.state["env"] = {**ctx.state.get("env", {}), **dict(re.findall(r'export (OP_SESSION_\w+)="([^"]*)"', r.stdout))}
    if r.returncode != 0 or _op(ctx, _op_base(ctx) + ["whoami"]).returncode != 0:
        raise SecretError("1Password CLI isn't signed in. Turn on the 1Password app integration, set "
                          "OP_SERVICE_ACCOUNT_TOKEN, or run  eval $(op signin)  in the shell you start "
                          "Claude (or roster) from")
    ctx.state["ready"] = True


@register("op", tool="op", help="1Password CLI:  op:ITEM, op:ITEM#FIELD, op:VAULT/ITEM#FIELD, or a full "
          "op://vault/item/field reference. Install: https://developer.1password.com/docs/cli/get-started/")
def _onepassword(spec, ctx):
    spec = spec.strip()
    if not spec:
        raise SecretError("op: needs an item, e.g. op:Orion servers or op://Infra/Orion servers/password")
    _op_ready(ctx)
    if spec.startswith("op://"):
        r = _op(ctx, _op_base(ctx) + ["read", spec])
        if r.returncode != 0:
            raise SecretError(f"1Password couldn't read {spec}: {errtext(r)}")
        return r.stdout.rstrip("\r\n")
    item, field = split_field(spec)
    vault = ctx.settings.get("vault")
    if "/" in item:
        vault, item = item.split("/", 1)
    args = _op_base(ctx) + ["item", "get", item, "--fields", f"label={field}", "--format", "json"]
    if vault:
        args += [f"--vault={vault}"]
    r = _op(ctx, args + ["--reveal"])
    if r.returncode != 0 and "reveal" in errtext(r):      # older op versions have no --reveal
        r = _op(ctx, args)
    if r.returncode != 0:
        raise SecretError(f"1Password: couldn't get '{field}' from item '{item}'"
                          f"{f' in vault {vault}' if vault else ''}: {errtext(r)}")
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        data = None
    if isinstance(data, list):
        data = data[0] if data else {}
    if not isinstance(data, dict):                          # valid JSON of another shape too
        raise SecretError("couldn't read `op item get` output")
    val = data.get("value")
    if not val:
        raise SecretError(f"1Password item '{item}' has no value in field '{field}'")
    return val


# ---- every Login item, never a field's value (Q191). `op item list` prints overviews only (id, title, vault,
# category, URLs; no field values); a username is one more `op item get ID --fields label=username` each, never with
# --reveal (a concealed field stays concealed), and only for the items roster.yml doesn't name yet.

def _op_items(ctx, mapped):
    _op_ready(ctx)
    vault = ctx.settings.get("vault")
    r = _op(ctx, _op_base(ctx) + ["item", "list", "--categories", "Login", "--format", "json"]
            + ([f"--vault={vault}"] if vault else []))
    if r.returncode != 0:
        raise SecretError(f"`op item list` failed: {errtext(r, stdout=False)}")
    try:
        listed = json.loads(r.stdout or "[]")
        if not isinstance(listed, list):
            raise ValueError
    except ValueError:
        raise SecretError("couldn't read `op item list` output") from None
    out = []
    for i in listed:
        if not isinstance(i, dict) or not isinstance(i.get("id"), str):
            continue
        title = str(i.get("title") or "")
        vault = i.get("vault")
        where = str(vault.get("name") or "") if isinstance(vault, dict) else ""
        item = {"id": i["id"], "name": title, "keys": [i["id"], title] + ([f"{where}/{title}"] if where else []),
                "uris": [], "username": None}
        if not mapped(item):
            item["uris"] = _op_urls(i)
            item["username"] = _op_username(ctx, i["id"])
        out.append(item)
    return out


def _op_username(ctx, item_id):
    r = _op(ctx, _op_base(ctx) + ["item", "get", item_id, "--fields", "label=username", "--format", "json"])
    if r.returncode != 0:
        return None                                         # no username field
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        return None
    data = data[0] if isinstance(data, list) and data else data
    value = data.get("value") if isinstance(data, dict) and data.get("type") != "CONCEALED" else None
    return value if isinstance(value, str) and value else None


def _op_ref_item(spec):
    """What an op: reference names an item by: op://VAULT/ITEM/FIELD's VAULT/ITEM, else VAULT/ITEM or ITEM."""
    if spec.startswith("op://"):
        parts = spec[5:].split("/")
        return "/".join(parts[:2]) if len(parts) >= 2 else spec
    return split_field(spec)[0]


# ---- one item's address and user, never its password (Q197). op has no field-only read of an item's URL
# (`--fields` reads fields; a Login's website is in its overview's `urls`), so: every item's overview from
# `op item list` (id, title, vault, URLs and a subtitle roster ignores; no concealed value, as Q191's listing), the one ITEM names found there (by id, or
# by title in any case; several fail closed, as bw's do), its URL with no user:password@ (no_userinfo), and then its
# username by that id, `op item get ID --fields label=username` without --reveal, so both come from the same item.

SEVERAL = "several 1Password items match '{}' - use the item's id instead (the 1Password app shows it)"


def _op_overviews(ctx, vault):
    r = _op(ctx, _op_base(ctx) + ["item", "list", "--format", "json"] + ([f"--vault={vault}"] if vault else []))
    if r.returncode != 0:
        raise SecretError(f"`op item list` failed: {errtext(r, stdout=False)}")
    try:
        listed = json.loads(r.stdout or "[]")
        if not isinstance(listed, list):
            raise ValueError
    except ValueError:
        raise SecretError("couldn't read `op item list` output") from None
    return [i for i in listed if isinstance(i, dict) and isinstance(i.get("id"), str)]


def _op_urls(item):
    """An overview's URLs, the primary one first (the listing and an item's fields agree, #500), never a URL's
    user:password@ (no_userinfo); none when its urls isn't a list (#492)."""
    urls = item.get("urls")
    urls = [u for u in urls if isinstance(u, dict) and isinstance(u.get("href"), str)] if isinstance(urls, list) else []
    urls.sort(key=lambda u: u.get("primary") is not True)
    return [no_userinfo(u["href"]) for u in urls]


def _op_login_fields(name, ctx):
    _op_ready(ctx)
    item, vault = (_op_ref_item(name) if name.startswith("op://") else name), ctx.settings.get("vault")
    if "/" in item:
        vault, item = item.split("/", 1)
    found = [i for i in _op_overviews(ctx, vault)
             if i["id"] == item or str(i.get("title") or "").casefold() == item.casefold()]
    if not found:
        raise ItemNotFound(f"no 1Password item matches '{item}'" + (f" in vault {vault}" if vault else ""), item)
    if len(found) > 1:
        raise SeveralItems(SEVERAL.format(item), item, [{"name": str(i.get("title") or ""), "uris": _op_urls(i),
                                                         "revised": i.get("updated_at")} for i in found], exact=False)
    urls = _op_urls(found[0])
    return {"uri": urls[0] if urls else None, "username": _op_username(ctx, found[0]["id"])}


# ---- writing: "Save to vault" (T269, Q217). `op item create -` reads the item as JSON on stdin (op 2's item
# template: title, category, fields, urls), so the password is never an argument: op's assignment statements
# (`password=...`) would put it in argv, where other processes and the shell's history see it. Nothing else of the
# item goes in argv either (a title starting with '-' can't be read as a flag). op prints the item it made, field
# values and all: roster reads its id and title from that and keeps nothing else. An error's words that repeat the
# password are withheld whole (repeats_secret, #539's review). 1Password allows two items of one title, but a
# Login's op:TITLE would then match both, so roster refuses a title already there, as for bw and kp.

PERSONAL_TARGET = {"id": "personal", "kind": "personal", "label": "Private vault (1Password's default)",
                   "save_to": "personal"}
OP_FIX = "see the message; check that the vault exists and your account may create items in it"


def _failed(message):
    return WriteFailed(message, fix=OP_FIX)


def _vault_target(v):
    return {"id": f"vault:{v['id']}", "kind": "vault", "label": v["name"], "save_to": {"vault": v["id"]}}


def _op_vaults(ctx):
    r = _op(ctx, _op_base(ctx) + ["vault", "list", "--format", "json"])
    if r.returncode != 0:
        raise SecretError(f"`op vault list` failed: {errtext(r, stdout=False)}")
    try:
        listed = json.loads(r.stdout or "[]")
        if not isinstance(listed, list):
            raise ValueError
    except ValueError:
        raise SecretError("couldn't read `op vault list` output") from None
    return [v for v in listed if isinstance(v, dict) and isinstance(v.get("id"), str)
            and isinstance(v.get("name"), str)]


def _read_vault(ctx):
    """The vault roster reads op: Logins from (providers: op: vault:), or None: every vault."""
    vault = ctx.settings.get("vault")
    return str(vault) if vault else None


def _op_targets(ctx):
    """The private vault and every vault the account sees; only the one Logins are read from when `vault:` is set
    (an item elsewhere couldn't be found by its Login)."""
    _op_ready(ctx)
    vaults, read = _op_vaults(ctx), _read_vault(ctx)
    if read:
        return [_vault_target(v) for v in vaults if read in (v["id"], v["name"])]
    return [PERSONAL_TARGET] + [_vault_target(v) for v in vaults]


def _op_resolve(setting, field, ctx):
    _op_ready(ctx)
    read = _read_vault(ctx)
    if setting == "personal":
        if read:
            raise UnknownTarget(f"{field()} is the private vault, but 1Password Logins here are read from vault "
                                f"'{read}' (providers: op: vault:), so an item saved elsewhere couldn't be found - "
                                f"save it in '{read}'")
        return PERSONAL_TARGET
    if "vault" not in setting:
        raise UnknownTarget(f"{field()} names a {'KeePassXC group' if 'group' in setting else 'Bitwarden collection'}"
                            ", but 1Password saves to the private vault or another vault")
    ref, vaults = setting["vault"], _op_vaults(ctx)
    hits = [v for v in vaults if v["id"] == ref] or [v for v in vaults if v["name"] == ref]
    if len(hits) > 1:
        raise UnknownTarget(f"{len(hits)} 1Password vaults are named '{ref}' - give its id instead "
                            f"({', '.join(v['id'] for v in hits)}) in {field('vault')}")
    if not hits:
        yours = ", ".join(v["name"] for v in vaults) or "none"
        raise UnknownTarget(f"no 1Password vault '{ref}' (yours: {yours}) - fix {field('vault')}")
    v = hits[0]
    if read and read not in (v["id"], v["name"]):
        raise UnknownTarget(f"{field('vault')} is vault '{v['name']}', but 1Password Logins here are read from vault "
                            f"'{read}' (providers: op: vault:), so an item saved there couldn't be found - save it in "
                            f"'{read}'")
    return _vault_target(v)


def _op_overviews_in(ctx, vault, floor=1):
    """Every item's overview in VAULT (a name or id; None: every vault), never a value."""
    r = _op(ctx, _op_base(ctx) + ["item", "list", "--format", "json"] + ([f"--vault={vault}"] if vault else []),
            floor=floor)
    if r.returncode != 0:
        raise SecretError(f"`op item list` failed: {errtext(r, stdout=False)}")
    try:
        listed = json.loads(r.stdout or "[]")
        if not isinstance(listed, list):
            raise ValueError
    except ValueError:
        raise SecretError("couldn't read `op item list` output") from None
    return [i for i in listed if isinstance(i, dict) and isinstance(i.get("id"), str)]


def _op_same_title(ctx, name):
    """The overviews titled NAME in any case where a Login looks it up (the read vault, else every vault): the
    duplicate check before a create."""
    return [i for i in _op_overviews_in(ctx, _read_vault(ctx))
            if str(i.get("title") or "").casefold() == name.casefold()]


def _summary(i):
    return {"name": str(i.get("title") or ""), "uris": _op_urls(i), "revised": i.get("updated_at")}


# op's answer to `op item create` is the new item. roster takes only its id from it, and only one shaped as op's ids
# are (26 lowercase letters and digits): never its title (the name is roster's own) or another field. An answer that
# doesn't read, or none in time, is "lost" (#545's review, MED-1): the item may be saved all the same, so roster looks
# for it, but only for exactly its title, in the vault it was saved to, made since this create started; one found
# that way is FOUND, not made by this run for sure: never taken back (Q43), and said.

OP_ID = re.compile(r"[a-z0-9]{26}")
SKEW = 120          # s: op's created_at is the server's clock, roster's start is this Box's


def _answered_id(stdout):
    try:
        answer = json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        return None
    got = answer.get("id") if isinstance(answer, dict) else None
    return got if isinstance(got, str) and OP_ID.fullmatch(got) else None


def _op_create(item, ctx):
    _op_ready(ctx)
    name, password = item["name"], item["password"]
    target = resolve_target(ctx, *item["save_to"])
    try:
        same = _op_same_title(ctx, name)
    except SecretError as e:
        raise _failed(f"couldn't check 1Password for an item titled '{name}': {e}") from None
    if same:
        raise ItemExists(f"a 1Password item titled '{name}' already exists - Logins look items up by title, so "
                         "roster won't make a second one", name, [_summary(i) for i in same])
    fields = [{"id": "username", "type": "STRING", "purpose": "USERNAME", "label": "username",
               "value": item["username"]},
              {"id": "password", "type": "CONCEALED", "purpose": "PASSWORD", "label": "password", "value": password}]
    template = json.dumps({"title": name, "category": "LOGIN", "fields": fields,
                           "urls": [{"label": "website", "primary": True, "href": item["uri"]}] if item["uri"] else []})
    vault = [f"--vault={target['save_to']['vault']}"] if target["kind"] == "vault" else []
    started = time.time()
    try:
        r = _op(ctx, _op_base(ctx) + ["item", "create", *vault, "--format", "json", "-"], input=template)
    except TimedOut:                                     # stopped: the item may be saved all the same
        return {**_found(ctx, name, target, started, "didn't answer `op item create` in time"), "target": target}
    finally:
        del template
    if r.returncode != 0:                                # stderr only: stdout would be the item itself
        if repeats_secret(r.stderr, password):
            raise _failed(f"{withheld('1Password')}: '{name}' wasn't created")
        raise _failed(f"1Password didn't create '{name}': {errtext(r, stdout=False) or f'exit {r.returncode}'}")
    got = _answered_id(r.stdout)
    del r                                                # op's answer holds the password: only its id is kept
    if got is None:
        return {**_found(ctx, name, target, started, "gave an answer to `op item create` that didn't read"),
                "target": target}
    return {"id": got, "name": name, "target": target}


def _found(ctx, name, target, started, what):
    """op's answer to the create of NAME was lost (WHAT happened): the one item titled exactly NAME in TARGET's vault,
    made since STARTED, as {id, name, found: True}; else WriteFailed saying roster couldn't confirm it was made. op's
    default vault (personal) has no id to look in, so it can't be confirmed there."""
    check = f"check 1Password for '{name}' and delete it if it's not wanted"
    if target["kind"] != "vault":
        raise _failed(f"1Password {what}, and roster couldn't confirm the item was made (it can't tell which vault "
                      f"is op's default) - {check}")
    try:
        listed = _op_overviews_in(ctx, target["save_to"]["vault"], floor=LOOKUP_FLOOR)
    except SecretError as e:
        raise _failed(f"1Password {what}, and roster couldn't confirm the item was made ({e}) - {check}") from None
    found = [i for i in listed if i.get("title") == name and _made_since(i.get("created_at"), started)]
    if len(found) != 1:
        raise _failed(f"1Password {what}, and roster couldn't confirm the item was made "
                      f"({len(found) or 'no'} new item{'' if len(found) == 1 else 's'} titled '{name}' in "
                      f"{target['label']}) - "
                      f"{check}")
    if not OP_ID.fullmatch(found[0]["id"]):
        raise _failed(f"1Password {what}, and roster couldn't confirm the item was made - {check}")
    return {"id": found[0]["id"], "name": name, "found": True}


def _made_since(created, started):
    """Whether op's CREATED (an ISO time) is at or after STARTED (this Box's clock, less SKEW)."""
    import datetime
    if not isinstance(created, str):
        return False
    try:
        when = datetime.datetime.fromisoformat(created.replace("Z", "+00:00"))
    except ValueError:
        return False
    if when.tzinfo is None:
        return False
    return when.timestamp() >= started - SKEW


def _op_delete(item_id, ctx):
    """Q43's undo, by the id op's create answered: 1Password keeps a deleted item in Recently Deleted for 30 days."""
    _op_ready(ctx)
    if not item_id or item_id.startswith("-"):
        raise _failed(f"'{item_id}' isn't a 1Password item id")
    r = _op(ctx, _op_base(ctx) + ["item", "delete", item_id])          # an id op answered, never a flag
    if r.returncode != 0:
        raise _failed(f"1Password didn't delete item {item_id}: {errtext(r, stdout=False) or f'exit {r.returncode}'}")


PROVIDERS["op"].update(create=_op_create, delete=_op_delete, targets=_op_targets, resolve=_op_resolve,
                       save_to=frozenset({"vault"}), old_save_to="vault")

PROVIDERS["op"].update(items=_op_items, ref_item=_op_ref_item, login_fields=_op_login_fields,
                       manual=lambda ctx: adopt_inherited_session(ctx.state),
                       unlock_hint="sign in: turn on the 1Password app's CLI integration, or eval $(op signin)",
                       no_session="roster vault unlock and lock are Bitwarden only for now: 1Password's `op signin` "
                                  "keeps its own session (roster vault op --write -- signin)")

PROVIDERS["op"]["login_help"] = (
    "1Password signs in through its desktop app, not here: turn on Settings > Developer > \"Integrate with "
    "1Password CLI\" (Windows Hello, Touch ID or your system login then unlock it, and the app handles two-step "
    "sign-in), or set OP_SERVICE_ACCOUNT_TOKEN for a service account")

PROVIDERS["op"]["logout_help"] = (
    "roster doesn't sign 1Password out: the desktop app holds the account. Sign out or switch accounts there")
