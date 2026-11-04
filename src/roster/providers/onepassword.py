"""1Password CLI provider:  auth: op:ITEM  /  op:VAULT/ITEM#FIELD  /  op:op://..."""

import json
import os
import re

from . import PROVIDERS, SecretError, errtext, register, split_field

# ---- built-in: 1Password

def _op_base(ctx):
    acct = ctx.settings.get("account")
    return ["op"] + (["--account", str(acct)] if acct else [])


def _op(ctx, args, **kw):
    """Run op with this run's sign-in (OP_SESSION_*) in its own env only: never os.environ, which every other program
    roster starts would inherit. The sign-in lives in the provider's state, which a lock forgets; one inherited from the
    shell (`eval $(op signin)`) is moved there on first use."""
    inherited = {k: os.environ.pop(k, None) for k in [k for k in os.environ if k.startswith("OP_SESSION_")]}
    inherited = {k: v for k, v in inherited.items() if v is not None}
    if inherited:
        ctx.state["env"] = {**inherited, **ctx.state.get("env", {})}
    return ctx.run(args, env=ctx.state.get("env"), **kw)


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


PROVIDERS["op"]["login_help"] = (
    "1Password signs in through its desktop app, not here: turn on Settings > Developer > \"Integrate with "
    "1Password CLI\" (Windows Hello, Touch ID or your system login then unlock it, and the app handles two-step "
    "sign-in), or set OP_SERVICE_ACCOUNT_TOKEN for a service account")

PROVIDERS["op"]["logout_help"] = (
    "roster doesn't sign 1Password out: the desktop app holds the account. Sign out or switch accounts there")
