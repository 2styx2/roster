"""Built-in providers: prompt, env, cmd."""

import os

from . import SecretError, register

# ---- built-in: simple sources

@register("prompt", help="ask once per group when setup runs:  auth: prompt")
def _prompt(spec, ctx):
    return ctx.ask(f"password for group '{ctx.group}': ")


@register("env", help="an environment variable:  env:VAR_NAME")
def _env(spec, ctx):
    val = os.environ.get(spec.strip())
    if val is None:
        raise SecretError(f"environment variable {spec.strip()} is not set")
    return val


@register("cmd", help="any command that prints the password:  cmd:COMMAND")
def _cmd(spec, ctx):
    r = ctx.run(spec, shell=True)       # noqa: S604 - cmd:COMMAND is the user's own command, by definition
    if r.returncode != 0:
        raise SecretError(f"password command failed (exit {r.returncode})")
    return r.stdout.rstrip("\r\n")
