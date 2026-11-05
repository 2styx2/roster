"""
Example roster password provider: `pass`, the standard Unix password manager
(https://www.passwordstore.org/). Copy this file to add any password manager.

    auth: pass:infra/orion-servers            first line of `pass show infra/orion-servers`
    auth: pass:infra/orion-servers#dbadmin    the "dbadmin: ..." line of that entry

How plugins work
----------------
Any *.py file in one of these folders is loaded automatically:
    ~/.config/roster/providers/          plugins for every roster.yml on this box
    providers/ next to your roster.yml   plugins for that inventory
    anything listed in `provider_dirs:` in roster.yml
(files starting with "_" are skipped). Roster hands every plugin these names - nothing to import:

    register(name, help="", tool="")   decorator; `name` is what goes before ":" in auth:
    SecretError(message)               raise for any failure; the message is shown to the user,
                                       so never put the secret itself in it
    split_field(spec, default)         "Item#field" -> ("Item", "field")
    errtext(completed_process)         a command's error output, trimmed for messages

Your function gets (spec, ctx) and returns the password as a string:
    spec               everything after "name:" in the auth value
    ctx.group          the roster.yml group that needs the password
    ctx.settings       this provider's block under `providers:` in roster.yml (a dict)
    ctx.state          a dict kept for the rest of the run - e.g. remember "already unlocked"
    ctx.interactive    True when there's a terminal (False when Claude runs `roster run`)
    ctx.ask(prompt)    hidden terminal prompt; raises SecretError when there's no terminal
    ctx.run(args, env=None, shell=False, interactive=False, timeout=120)
                       subprocess.run with output captured; a missing tool becomes a SecretError

roster calls it only when a password is actually needed, caches the result in memory for
the run, and never writes it anywhere. Check your plugin with:  roster vault status
and then:  roster check --auth
"""


@register("pass", tool="pass", help="pass (passwordstore.org):  pass:PATH or pass:PATH#FIELD")
def get_from_pass(spec, ctx):
    path, field = split_field(spec, default="")
    if not path:
        raise SecretError("pass: needs an entry path, e.g. pass:infra/orion-servers")

    # Settings from roster.yml, e.g.   providers: { pass: { store_dir: ~/.password-store-work } }
    env = {}
    if ctx.settings.get("store_dir"):
        env["PASSWORD_STORE_DIR"] = str(ctx.settings["store_dir"])

    # interactive=True lets gpg-agent ask for your GPG passphrase if it needs to.
    r = ctx.run(["pass", "show", path], env=env, interactive=ctx.interactive)
    if r.returncode != 0:
        raise SecretError(f"`pass show {path}` failed: {errtext(r)}")
    lines = r.stdout.splitlines()

    if not field:                       # pass convention: the password is the first line
        return lines[0] if lines else ""
    for line in lines[1:]:              # other lines look like "dbadmin: s3cret"
        key, sep, value = line.partition(":")
        if sep and key.strip().lower() == field.lower():
            return value.strip()
    raise SecretError(f"pass entry '{path}' has no '{field}:' line")
