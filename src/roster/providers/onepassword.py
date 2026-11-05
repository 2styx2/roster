"""1Password CLI provider:  auth: op:ITEM  /  op:VAULT/ITEM#FIELD  /  op:op://..."""

import json
import os
import re

from . import PROVIDERS, ItemNotFound, SecretError, SeveralItems, errtext, register, split_field
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
        args += ["--vault", str(vault)]
    r = _op(ctx, args + ["--reveal"])
    if r.returncode != 0 and "reveal" in errtext(r):      # older op versions have no --reveal
        r = _op(ctx, args)
    if r.returncode != 0:
        raise SecretError(f"1Password: couldn't get '{field}' from item '{item}'"
                          f"{f' in vault {vault}' if vault else ''}: {errtext(r)}")
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise SecretError("couldn't read `op item get` output")
    if isinstance(data, list):
        data = data[0] if data else {}
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
            + (["--vault", str(vault)] if vault else []))
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
        where = str((i.get("vault") or {}).get("name") or "")
        item = {"id": i["id"], "name": title, "keys": [i["id"], title] + ([f"{where}/{title}"] if where else []),
                "uris": [], "username": None}
        if not mapped(item):
            item["uris"] = [no_userinfo(u["href"]) for u in i.get("urls") or []       # never a URL's user:password@
                            if isinstance(u, dict) and isinstance(u.get("href"), str)]
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


# ---- one item's address and user, never its password (T223, #432, Q197). op has no field-only read of an item's URL
# (`--fields` reads fields; a Login's website is in its overview's `urls`), so: every item's overview from
# `op item list` (id, title, vault, URLs and a subtitle roster ignores; no concealed value, as Q191's listing), the one ITEM names found there (by id, or
# by title in any case; several fail closed, as bw's do), its URL with no user:password@ (no_userinfo), and then its
# username by that id, `op item get ID --fields label=username` without --reveal, so both come from the same item.

SEVERAL = "several 1Password items match '{}' - use the item's id instead (the 1Password app shows it)"


def _op_overviews(ctx, vault):
    r = _op(ctx, _op_base(ctx) + ["item", "list", "--format", "json"] + (["--vault", str(vault)] if vault else []))
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
    urls = [u for u in item.get("urls") or [] if isinstance(u, dict) and isinstance(u.get("href"), str)]
    urls.sort(key=lambda u: u.get("primary") is not True)               # the primary one first
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


PROVIDERS["op"].update(items=_op_items, ref_item=_op_ref_item, login_fields=_op_login_fields)

PROVIDERS["op"]["login_help"] = (
    "1Password signs in through its desktop app, not here: turn on Settings > Developer > \"Integrate with "
    "1Password CLI\" (Windows Hello, Touch ID or your system login then unlock it, and the app handles two-step "
    "sign-in), or set OP_SERVICE_ACCOUNT_TOKEN for a service account")

PROVIDERS["op"]["logout_help"] = (
    "roster doesn't sign 1Password out: the desktop app holds the account. Sign out or switch accounts there")
