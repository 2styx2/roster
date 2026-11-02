"""Why opening a Session to a Host would fail, found before (or instead of) the user's ssh:
- session.prepare and askpass resolve a password Login here (check_login, resolve_password);
- `roster check HOST` and serve's host.check walk every step in order (check_host);
- serve's host.verify_login tests a Host's login as an edit would leave it, before the edit is made (verify_login).
Every failure is an errors.Problem with a stable code, roster's message and the fix. Nothing here ever
returns, prints or logs a password: it is looked up into this process's memory, at most."""

import os
import shutil
import socket
import subprocess
import time
from contextlib import nullcontext

from . import askpass, errors, providers
from .common import not_reviewed, time_left
from .errors import Problem, login_problem, no_user, unknown_provider, vault_problem
from .providers import PROVIDERS
from .sshops import (
    fingerprint,
    host_block,
    in_ssh_config,
    offered_host_key,
    recorded_host_keys,
    start_transport,
    written_host_block,
)

PLACEHOLDER_USERS = ("", "CHANGE-ME")         # discover's placeholder: no SSH user set yet
STEPS = ("inventory", "ssh-config", "provider", "vault-item", "dns", "tcp", "host-key", "auth")
CONNECT_TIMEOUT = 5         # seconds for the TCP step and for the key exchange
LOGIN_TIMEOUT = 10          # ssh's ConnectTimeout for the one login attempt


# ---------------------------------------------------------------- a Host's Login

def password_login(h):
    """The Host's ssh Login, if it's a password one (a vault reference, not agent/key/none)."""
    auth = h["ssh"].get("auth")
    return None if auth in (None, "") or auth in providers.NO_PASSWORD else h["ssh"]


def uses_password(h):
    return not h["enroll"] and password_login(h) is not None


def check_user(h):
    if h["ssh"]["user"] in PLACEHOLDER_USERS:
        raise no_user(h)


def check_provider(h, auth=None, what="ssh"):
    """The password Login's provider exists on this box and can answer now (11 not logged in, 12 no CLI,
    14 locked). Providers without a status (env, prompt, cmd) are left to try. AUTH: another of the Host's
    references than its ssh Login (its sudo: one), named WHAT in errors."""
    auth = str(password_login(h)["auth"] if auth is None else auth)
    name = auth.partition(":")[0].strip()
    if name not in PROVIDERS:
        raise unknown_provider(h, auth, what)
    try:
        status = providers.vault_status(name)
    except providers.SecretError as e:
        raise vault_problem(e) from None
    error = {"locked": providers.VaultLocked, "unauthenticated": providers.NotLoggedIn,
             "missing": providers.CliMissing}.get(status)
    if status == "locked" and not providers.manual_unlock():
        return                  # the command line may unlock by itself (BW_PASSWORD, session file, prompt)
    if error:
        message = providers.status_message(name, status) or f"{name} vault is locked - unlock it first"
        raise login_problem(error(message), h, what)


def resolve_password(h, auth=None, what="ssh"):
    """The Login's password, looked up now (into this process's memory only; never returned to the app).
    Raises a Problem: item not found, several match, no password/field, or the provider's own failure."""
    auth = password_login(h)["auth"] if auth is None else auth
    if str(auth).partition(":")[0].strip() not in PROVIDERS:
        raise unknown_provider(h, auth, what)
    try:
        return providers.get_secret(auth, h["group"])
    except providers.SecretError as e:
        raise login_problem(e, h, what) from None


def check_login(h):
    """Everything about a password Login that can be known without touching the Host (rows 4-10)."""
    check_user(h)
    check_provider(h)
    resolve_password(h)


def askpass_lookup(h):
    """The askpass channel's lookup for Host H's ssh Login: the password, or Refused with the same code and
    wording session.prepare gives. It runs on the channel's threads; get_secret takes the providers' lock."""
    try:
        return resolve_password(h)
    except Problem as e:
        raise askpass.Refused(e.message, e.code) from None


# ---------------------------------------------------------------- host.check / `roster check HOST`

VAULT_STEPS = ("provider", "vault-item", "auth")    # a password Login's: the steps that fetch a secret or mint a token


class Stopped(Exception):
    """VAULT gave up waiting because the check was stopped: this step and the rest are "skipped"."""


def check_host(name, inventory, channel=None, progress=None, halted=None, vault=None):
    """Run STEPS for Host NAME in order and stop at the first failure; the rest are "skipped". INVENTORY()
    returns the loaded config or raises Problem(1). CHANNEL is an askpass.Channel for a password login
    (without one, the auth step of a password Host is skipped).
    The local steps come first, so nothing touches the network once one fails; then one TCP connection
    (port, then the host key over it) and one ssh login attempt. Returns {host, ok, steps: [...]}, each step
    {step, status: ok|fail|skipped, message, code?, fix?, details?, data?}.
    serve's check job (ticket 108) passes PROGRESS(done, total, step), called as each step starts, and HALTED (an
    Event): once it's set no further step starts (the rest are "skipped", and ok is false). And VAULT(), a context
    manager that shares the vault, held only for a password Login's VAULT_STEPS: between them a lock or an unlock
    needn't wait for the check (decision Q112 (q)). It raises Stopped when the check was stopped meanwhile."""
    ctx = {"name": name, "inventory": inventory, "channel": channel, "halted": halted}
    steps, failed = [], False
    for i, step in enumerate(STEPS):
        if not failed and halted is not None and halted.is_set():
            failed = "stopped"
        if failed:
            why = "the check was stopped" if failed == "stopped" else "an earlier step failed"
            steps.append({"step": step, "status": "skipped", "message": why})
            continue
        if progress is not None:
            progress(i, len(STEPS), step)
        held = vault() if vault is not None and step in VAULT_STEPS and "h" in ctx and uses_password(ctx["h"]) \
            else nullcontext()
        try:
            with held:
                outcome = STEP_FNS[step](ctx)
        except Stopped:
            failed = "stopped"
            steps.append({"step": step, "status": "skipped", "message": "the check was stopped"})
            continue
        except Problem as e:
            failed = True
            steps.append(problem_step(step, e))
            continue
        status, message = outcome if isinstance(outcome, tuple) else ("ok", outcome)
        steps.append({"step": step, "status": status, "message": message})
    if ctx.get("sock"):
        ctx["sock"].close()
    return {"host": name, "ok": not failed, "steps": steps}


def problem_step(step, e):
    out = {"step": step, "status": "fail", "code": e.code, "message": e.message}
    data = {k: v for k, v in (e.data or {}).items() if k != "fix"}
    if e.fix or (e.data or {}).get("fix"):
        out["fix"] = e.fix or e.data["fix"]
    if e.details:
        out["details"] = e.details
    if data:
        out["data"] = data
    return out


def step_inventory(ctx):
    cfg = ctx["inventory"]()
    h = cfg["hosts"].get(ctx["name"])
    if h is None:
        raise Problem(errors.UNKNOWN_HOST, f"unknown host {ctx['name']!r}",
                      fix="check the name (`roster hosts`), or add the Host to roster.yml")
    if not h["reviewed"]:
        raise Problem(errors.NOT_REVIEWED, not_reviewed(h),
                      fix=f"review {h['name']} in roster.yml, then set reviewed: true")
    check_user(h)
    ctx["cfg"], ctx["h"] = cfg, h
    how = "password" if uses_password(h) else "key" if h["enroll"] else f"auth {h['ssh']['auth'] or 'none'}"
    return f"{h['ssh']['user']}@{h['ip']}:{h['ssh']['port']} ({how} login)"


def step_ssh_config(ctx):
    h = ctx["h"]
    ctx["ssh"] = shutil.which("ssh")
    if ctx["ssh"] is None:
        raise Problem(errors.NOT_SET_UP, "no ssh client on this box's PATH",
                      fix="install OpenSSH (openssh-client)")
    sync = "run `roster sync` (or `roster setup` if this box isn't set up yet)"
    if not in_ssh_config(h["name"]):
        raise Problem(errors.NOT_SET_UP, f"{h['name']} isn't in this box's ssh config yet", fix=sync)
    want, have = host_block(ctx["cfg"], h["name"], h), written_host_block(h["name"])
    if have != want:
        stale = f"{h['name']}'s entry in this box's ssh config is out of date"
        if "    IdentitiesOnly yes" in want and "    IdentitiesOnly yes" not in have:
            stale += (" - it lets ssh offer every key in the agent (no IdentitiesOnly), so the Host can cut "
                      "the connection after too many key attempts")
        changed = [ln.strip() for ln in want if ln not in have]
        raise Problem(errors.NOT_SET_UP, stale, fix=sync, details="roster.yml now says: " + "; ".join(changed))
    return "Host " + h["name"]


def step_provider(ctx):
    h = ctx["h"]
    if not uses_password(h):
        return "skipped", "key login: no vault needed" if h["enroll"] else "no password Login"
    check_provider(h)
    return f"{str(h['ssh']['auth']).partition(':')[0]} is ready"


def step_vault_item(ctx):
    h = ctx["h"]
    if not uses_password(h):
        return "skipped", "key login: no vault needed" if h["enroll"] else "no password Login"
    resolve_password(h)                 # not kept: the vault may lock before the auth step (it looks it up again)
    return f"{h['ssh']['auth']} resolves to one item with a value"


def step_dns(ctx):
    h = ctx["h"]
    try:
        socket.getaddrinfo(h["ip"], h["ssh"]["port"], type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as e:
        raise Problem(errors.NO_DNS, f"can't resolve '{h['ip']}' ({h['name']})",
                      fix=f"fix ip: for {h['name']} in roster.yml", details=str(e)) from None
    return f"{h['ip']} resolves"


def unreachable_fix(h):
    fix = "retry later; is the Host up and the network path open?"
    if h["ip"].startswith("10.19."):
        fix += (" On 10.19.x the SSH rate limiter stops answering for about 4 minutes after many "
                "connections: wait a few minutes, don't retry in a loop")
    return fix


def step_tcp(ctx):
    h = ctx["h"]
    where = f"{h['ip']}:{h['ssh']['port']}"
    try:
        ctx["sock"] = socket.create_connection((h["ip"], h["ssh"]["port"]), timeout=CONNECT_TIMEOUT)
    except ConnectionRefusedError as e:
        raise Problem(errors.REFUSED, f"{h['name']} ({where}) refused the connection",
                      fix="check the port in roster.yml; is sshd running on the Host?", details=str(e)) from None
    except OSError as e:
        raise Problem(errors.TIMEOUT, f"{h['name']} ({where}) didn't answer within {CONNECT_TIMEOUT} s",
                      fix=unreachable_fix(h), details=str(e)) from None
    return f"{where} accepts connections"


def step_host_key(ctx):
    import paramiko
    h = ctx["h"]
    recorded = recorded_host_keys(h)
    if not recorded:
        raise Problem(errors.HOST_KEY_UNKNOWN, f"no recorded host key for {h['name']}",
                      fix=f"check the Host's fingerprint (console, or its owner), then run "
                          f"`roster setup --only {h['name']}` to record it")
    sock, ctx["sock"] = ctx["sock"], None
    try:
        key = offered_host_key(sock, list(recorded), timeout=CONNECT_TIMEOUT)
    except (paramiko.SSHException, OSError, EOFError) as e:
        if not isinstance(e, paramiko.SSHException) or "Incompatible" not in str(e):
            raise Problem(errors.TIMEOUT, f"{h['name']} didn't complete the SSH handshake",
                          fix=unreachable_fix(h), details=f"{type(e).__name__}: {e}") from None
        key = None
    finally:
        sock.close()
    old = recorded.get(key.get_name()) if key else None
    if key is None or old is None or old.asbytes() != key.asbytes():
        raise changed_key(h, recorded, key)
    return f"matches the recorded {key.get_name()} key {fingerprint(key)}"


def changed_key(h, recorded, key):
    """Problem 43: H offers KEY (None: none of the recorded types), which isn't one of the RECORDED keys. Never
    accepted automatically (Q44): the fix says how to check it and where its line is."""
    data = {"recorded": [fingerprint(k) for k in recorded.values()], "offered": fingerprint(key) if key else None}
    return Problem(errors.HOST_KEY_CHANGED, f"{h['name']}'s host key changed - not connecting", data,
                   fix="don't accept it blindly: compare the new fingerprint with the Host's console or owner. "
                       "If the change is expected (reinstall), delete its line in ~/.ssh/roster_known_hosts "
                       f"and run `roster setup --only {h['name']}`",
                   details=f"recorded {', '.join(data['recorded'])}; offered {data['offered'] or 'none of those types'}")


def step_auth(ctx):
    h, password = ctx["h"], uses_password(ctx["h"])
    argv = [ctx["ssh"], "-o", "ControlPath=none", "-o", f"ConnectTimeout={LOGIN_TIMEOUT}",
            "-o", "StrictHostKeyChecking=yes"]
    env = {}
    if password:
        if ctx["channel"] is None:
            return "skipped", "no askpass channel in this process"
        argv += ["-o", "NumberOfPasswordPrompts=1", "-o", "PreferredAuthentications=password,keyboard-interactive"]
        env = ctx["channel"].env(ctx["channel"].mint(h, h["name"]))
    else:
        argv += ["-o", "BatchMode=yes"]
    argv += [h["name"], "true"]
    limit = round(time_left(LOGIN_TIMEOUT + 20))
    r = login_attempt(argv, {**os.environ, **env}, limit, ctx.get("halted"))
    if r is None:
        raise Problem(errors.TIMEOUT, f"{h['name']} didn't finish the login within {limit} s",
                      fix=unreachable_fix(h))
    if r.returncode == 0:
        return f"logged in as {h['ssh']['user']}"
    details = r.stderr.strip()
    if password:
        try:
            secret = resolve_password(h)    # this run's cache: the askpass lookup just fetched it
        except Problem:
            secret = None
        if secret:
            details = details.replace(secret, "****")
    raise login_failure(h, password, details)


STOP_POLL = 0.1            # s: how soon a stopped check notices it while its ssh logs in


def login_attempt(argv, env, limit, halted=None):
    """Run the login's ssh ARGV for at most LIMIT s: its CompletedProcess, or None when it ran out of time. Once
    HALTED is set (serve's check was stopped: vault.lock, jobs.stop, its last waiter cancelled) its ssh is ended and
    Stopped raised (it isn't started at all if HALTED is set already), so a lock never waits for a login (decision
    Q119). Ending it is safe: the login runs `true` and nothing else, so nothing on the Host is left half-done, and the
    attempt is already made or never will be: a stopped check never tries again, so the Host's rate limiter sees no
    more attempts than before. On POSIX ssh runs in a process group of its own, so ending it ends what it started too
    (a ProxyJump's ssh)."""
    if halted is not None and halted.is_set():
        raise Stopped
    proc = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, start_new_session=os.name != "nt")
    end = time.monotonic() + limit
    try:
        while True:
            left = end - time.monotonic()
            try:
                out, err = proc.communicate(timeout=max(0.0, min(left, STOP_POLL) if halted is not None else left))
                return subprocess.CompletedProcess(argv, proc.returncode, out, err)
            except subprocess.TimeoutExpired:
                if halted is not None and halted.is_set():
                    raise Stopped from None
                if time.monotonic() >= end:
                    return None
    finally:
        if proc.returncode is None:         # stopped, out of time, or interrupted (Ctrl+C): it doesn't outlive us
            end_process(proc)


def end_process(proc):
    """End PROC and everything in its process group on POSIX (SIGTERM first, so ssh closes its connection, then
    SIGKILL), and always reap it; our ends of its pipes are closed, so a child of it that still holds them can't keep
    us waiting."""
    import signal

    def send(sig):
        try:
            if os.name == "nt":
                proc.kill() if sig == "kill" else proc.terminate()
            else:
                os.killpg(proc.pid, signal.SIGKILL if sig == "kill" else signal.SIGTERM)
        except OSError:
            pass
    send("term")
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    send("kill")                            # the group too, even once the leader has gone
    for pipe in (proc.stdout, proc.stderr):
        if pipe is not None:
            try:
                pipe.close()
            except OSError:
                pass
    proc.wait()                             # SIGKILL can't be refused: this returns


def login_failure(h, password, stderr):
    """ssh's stderr from the one login attempt as a Problem (the app's classifier does the same for Sessions)."""
    name, user = h["name"], h["ssh"]["user"]
    for line in stderr.splitlines():
        if line.startswith("roster askpass: ["):
            code, _, message = line.removeprefix("roster askpass: [").partition("] ")
            fix = "log in by hand once (Quick Connect) to deal with it" if code == str(errors.UNEXPECTED_PROMPT) else None
            return Problem(int(code) if code.isdigit() else errors.AUTH_FAILED, message, fix=fix, details=stderr)
    low = stderr.lower()
    if "too many authentication failures" in low:
        return Problem(errors.TOO_MANY_AUTH, f"{name} cut the connection after too many key attempts",
                       fix="run `roster sync`: roster's ssh config offers one key, or none, per Host", details=stderr)
    if "host key verification failed" in low or "remote host identification has changed" in low:
        return Problem(errors.HOST_KEY_CHANGED, f"{name}'s host key changed - not connecting",
                       fix="compare the fingerprint with the Host's console or owner before trusting it", details=stderr)
    if "permission denied" in low:
        if password:
            return Problem(errors.PASSWORD_REFUSED, f"{name} refused the password for user {user}",
                           fix="check the vault item: the password may have been changed on the Host, or the user is wrong",
                           details=stderr)
        return Problem(errors.KEY_REFUSED, f"{name} didn't accept this box's key",
                       fix=f"run `roster setup --only {name}`, or set enroll: false", details=stderr)
    if "connection refused" in low:
        return Problem(errors.REFUSED, f"{name} refused the connection",
                       fix="check the port in roster.yml; is sshd running on the Host?", details=stderr)
    if "timed out" in low:
        return Problem(errors.TIMEOUT, f"{name} didn't answer within {LOGIN_TIMEOUT} s", fix=unreachable_fix(h),
                       details=stderr)
    if "could not resolve" in low:
        return Problem(errors.NO_DNS, f"can't resolve '{h['ip']}' ({name})", fix=f"fix ip: for {name} in roster.yml",
                       details=stderr)
    return Problem(errors.AUTH_FAILED, f"logging in to {name} failed", fix="see the details (ssh's own message)",
                   details=stderr or "ssh failed without a message")


STEP_FNS = {"inventory": step_inventory, "ssh-config": step_ssh_config, "provider": step_provider,
            "vault-item": step_vault_item, "dns": step_dns, "tcp": step_tcp, "host-key": step_host_key,
            "auth": step_auth}


# ---------------------------------------------------------------- host.verify_login (ticket 10, decision Q43)

VERIFY_STEPS = ("user", "provider", "vault-item", "dns", "tcp", "host-key", "auth")


def stored_password(h):
    """The Host's password Login, if roster can look it up without asking anyone (so not `prompt`)."""
    login = password_login(h)
    return login if login and str(login["auth"]).partition(":")[0].strip() != "prompt" else None


def verify_login(h, key_path, previous=None, typed=None, host_key=None):
    """One test login to Host H as an edit would leave it (new address, user or Login), or as host.add would add it,
    before anything is written. The same order as check_host, but against H's own values rather than this box's ssh
    config: the local steps, then ONE TCP connection that carries the key exchange and exactly one login attempt.
    The host key must match one roster recorded, for H's address or (a Host that moved) for PREVIOUS, the Host as it
    is now; it's never recorded or accepted here. For a Host that moved, the result's host_key is that key, for the
    caller to record for the new address once the edit is written. A new address with no recorded key needs HOST_KEY, the
    fingerprint the user confirmed (scan_key): the result then has host_key {type, fingerprint, base64} for the
    caller to record once the add is written. TYPED is {password, provider, item} for a password typed into the
    form (not in the vault yet): the provider step checks it can be saved there, and the login uses it. A Host
    with no stored Login (auth: prompt, agent, none) gets everything but the login. A changed Login (auth differs
    from PREVIOUS's) that is a stored password is tested with that password even when H is enroll: true: the key
    login would prove nothing about it. Returns {host, ok, steps} like check_host."""
    ctx = {"h": h, "key_path": key_path, "previous": previous, "typed": typed, "host_key": host_key,
           "login_changed": previous is not None and previous["ssh"]["auth"] != h["ssh"]["auth"]}
    steps, failed = [], False
    for step in VERIFY_STEPS:
        if failed:
            steps.append({"step": step, "status": "skipped", "message": "an earlier step failed"})
            continue
        try:
            outcome = VERIFY_FNS[step](ctx)
        except Problem as e:
            failed = True
            steps.append(problem_step(step, e))
            continue
        status, message = outcome if isinstance(outcome, tuple) else ("ok", outcome)
        steps.append({"step": step, "status": status, "message": message})
    for held in ("transport", "sock"):
        if ctx.get(held):
            ctx[held].close()
    ctx.pop("password", None)
    ctx["typed"] = None
    result = {"host": h["name"], "ok": not failed, "steps": steps}
    if not failed and ctx.get("confirmed"):
        key = ctx["confirmed"]
        result["host_key"] = {"type": key.get_name(), "fingerprint": fingerprint(key), "base64": key.get_base64()}
    return result


def login_kind(h):
    if h["enroll"]:
        return "key"
    return "password" if stored_password(h) else None


def kind_of(ctx):
    """How the test login logs in. A changed Login is tested with itself (Q43): its vault item is looked up and its
    password used, even on an enroll: true Host, whose key login says nothing about the new Login."""
    if ctx.get("typed") or (ctx.get("login_changed") and stored_password(ctx["h"])):
        return "password"
    return login_kind(ctx["h"])


def verify_user(ctx):
    h = ctx["h"]
    check_user(h)
    how = {"key": "this box's key", "password": "password"}.get(kind_of(ctx)) or f"auth {h['ssh']['auth'] or 'none'}"
    return f"{h['ssh']['user']}@{h['ip']}:{h['ssh']['port']} ({how})"


def verify_provider(ctx):
    if kind_of(ctx) != "password":
        return "skipped", "no vault needed"
    if ctx.get("typed"):
        return check_save_to(ctx["h"], ctx["typed"])
    check_provider(ctx["h"])
    return f"{str(ctx['h']['ssh']['auth']).partition(':')[0]} is ready"


def check_save_to(h, typed):
    """A typed password's Vault item can be made in its provider now: it can write, and it's unlocked."""
    name = typed["provider"]
    if name not in PROVIDERS:
        raise unknown_provider(h, f"{name}:")
    if not providers.can_write(name):
        raise errors.write_problem(providers.CantWrite(
            f"provider '{name}' can't save to the vault - roster only reads its Logins; create the item in the "
            "password manager itself, then pick it as the Login"))
    check_provider({**h, "ssh": {**h["ssh"], "auth": f"{name}:{typed['item']}"}})
    return f"{name} is ready to save '{typed['item']}' after the test login"


def verify_vault_item(ctx):
    h = ctx["h"]
    if kind_of(ctx) != "password":
        return "skipped", "no vault needed"
    if ctx.get("typed"):
        ctx["password"] = ctx["typed"]["password"]
        return "the typed password, not saved anywhere yet"
    ctx["password"] = resolve_password(h)
    return f"{h['ssh']['auth']} resolves to one item with a value"


def verify_host_key(ctx):
    import paramiko
    h, previous = ctx["h"], ctx["previous"]
    recorded = recorded_host_keys(h)
    moved = not recorded and previous is not None
    if moved:
        recorded = recorded_host_keys(previous)
    if not recorded and ctx.get("host_key"):
        return confirmed_host_key(ctx)
    if not recorded:
        raise Problem(errors.HOST_KEY_UNKNOWN, f"no recorded host key for {h['name']} at {h['ip']}",
                      fix=f"check the Host's fingerprint (console, or its owner) and record it with `roster setup "
                          f"--only {h['name']}` after the change, or make this change by hand in roster.yml")
    sock, ctx["sock"] = ctx["sock"], None
    try:
        t = start_transport(sock, list(recorded), timeout=CONNECT_TIMEOUT)
    except (paramiko.SSHException, OSError, EOFError) as e:
        sock.close()
        raise Problem(errors.TIMEOUT, f"{h['name']} didn't complete the SSH handshake",
                      fix=unreachable_fix(h), details=f"{type(e).__name__}: {e}") from None
    ctx["transport"] = t
    key = t.get_remote_server_key()
    old = recorded.get(key.get_name())
    if old is None or old.asbytes() != key.asbytes():
        data = {"recorded": [fingerprint(k) for k in recorded.values()], "offered": fingerprint(key)}
        raise Problem(errors.HOST_KEY_CHANGED, f"{h['name']}'s host key at {h['ip']} isn't the recorded one - "
                                               "not logging in", data,
                      fix="don't accept it blindly: compare the fingerprint with the Host's console or owner",
                      details=f"recorded {', '.join(data['recorded'])}; offered {data['offered']}")
    if moved:                   # the same key at the new address: pinned there once the edit is written
        ctx["confirmed"] = key
        return f"matches the {key.get_name()} key recorded for its current address, {fingerprint(key)}"
    return f"matches the recorded {key.get_name()} key {fingerprint(key)}"


def confirmed_host_key(ctx):
    """No recorded key for this address: the key offered must be the one the user just confirmed (scan_key)."""
    import paramiko
    h = ctx["h"]
    sock, ctx["sock"] = ctx["sock"], None
    try:
        t = start_transport(sock, [], timeout=CONNECT_TIMEOUT)
    except (paramiko.SSHException, OSError, EOFError) as e:
        sock.close()
        raise Problem(errors.TIMEOUT, f"{h['name']} didn't complete the SSH handshake",
                      fix=unreachable_fix(h), details=f"{type(e).__name__}: {e}") from None
    ctx["transport"] = t
    key = t.get_remote_server_key()
    if fingerprint(key) != ctx["host_key"]:
        data = {"confirmed": ctx["host_key"], "offered": fingerprint(key)}
        raise Problem(errors.HOST_KEY_CHANGED, f"{h['name']}'s host key at {h['ip']} isn't the one you confirmed - "
                                               "not logging in", data,
                      fix="scan the key again and compare it with the Host's console or owner before trusting it",
                      details=f"confirmed {data['confirmed']}; offered {data['offered']}")
    ctx["confirmed"] = key
    return f"the {key.get_name()} key you confirmed, {fingerprint(key)}"


def scan_key(h):
    """The host key H's address offers ({key_type, fingerprint}) and how it compares with the one roster recorded
    (recorded: none, match or changed), for the user to confirm before a first login. One connection, key
    exchange only: never logs in, never records anything. Raises Problem 40-42 when it can't get there."""
    key, state = offered_key(h)
    return {"key_type": key.get_name(), "fingerprint": fingerprint(key), "recorded": state}


def offered_key(h):
    """scan_key's work: (the paramiko key H's address offers, recorded: none|match|changed)."""
    import paramiko
    ctx = {"h": h}
    step_dns(ctx)
    step_tcp(ctx)
    recorded = recorded_host_keys(h)
    try:
        key = offered_host_key(ctx["sock"], list(recorded), timeout=CONNECT_TIMEOUT)
    except (paramiko.SSHException, OSError, EOFError) as e:
        raise Problem(errors.TIMEOUT, f"{h['ip']} didn't complete the SSH handshake",
                      fix=unreachable_fix(h), details=f"{type(e).__name__}: {e}") from None
    finally:
        ctx["sock"].close()
    old = recorded.get(key.get_name())
    state = "none" if not recorded else "match" if old is not None and old.asbytes() == key.asbytes() else "changed"
    return key, state


def verify_auth(ctx):
    import paramiko
    h, t, kind = ctx["h"], ctx["transport"], kind_of(ctx)
    user = h["ssh"]["user"]
    if kind is None:
        return "skipped", f"no stored Login to test (auth {h['ssh']['auth'] or 'none'})"
    t.auth_timeout = LOGIN_TIMEOUT
    try:
        if kind == "password":
            t.auth_password(user, ctx.pop("password"))
        else:
            if not ctx["key_path"].exists():
                raise Problem(errors.NOT_SET_UP, f"this box has no roster key ({ctx['key_path']})",
                              fix="run `roster setup` on this box")
            t.auth_publickey(user, paramiko.PKey.from_path(str(ctx["key_path"])))
    except paramiko.BadAuthenticationType as e:
        raise Problem(errors.AUTH_FAILED, f"{h['name']} doesn't take {kind} logins for user {user}",
                      fix="check the Host's sshd settings, or change the Host's Login",
                      details=f"allowed: {', '.join(e.allowed_types)}") from None
    except paramiko.AuthenticationException:
        if kind == "password":
            raise Problem(errors.PASSWORD_REFUSED, f"{h['name']} refused the password for user {user}",
                          fix="check the user and the vault item: the password may have changed on the Host") from None
        raise Problem(errors.KEY_REFUSED, f"{h['name']} didn't accept this box's key for user {user}",
                      fix=f"check the user, or run `roster setup --only {h['name']}` after the change") from None
    except (paramiko.SSHException, OSError, EOFError) as e:
        raise Problem(errors.AUTH_FAILED, f"logging in to {h['name']} failed", fix="see the details",
                      details=f"{type(e).__name__}: {e}") from None
    if not t.is_authenticated():
        raise Problem(errors.AUTH_FAILED, f"{h['name']} asked for more than one step to log in",
                      fix="log in by hand once to see what it wants")
    return f"logged in as {user}"


VERIFY_FNS = {"user": verify_user, "provider": verify_provider, "vault-item": verify_vault_item, "dns": step_dns,
              "tcp": step_tcp, "host-key": verify_host_key, "auth": verify_auth}
