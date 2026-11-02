"""`roster serve`: the backend API for the desktop app (the roster app, app/). JSON-RPC 2.0 over stdin/stdout,
one JSON object per line. Only responses go to stdout; anything else roster prints goes to stderr.
The one other channel is askpass (roster/askpass.py): a private Unix socket, open while serve runs, that
hands a password Session's ssh its password.
It answers with the Host, group and resource objects load_config already builds - no new schema.
Logins come back as references (bw:ITEM), never as values. Requests are handled concurrently (API 20, decision Q112):
a pool of workers, two more for the quick reads (QUICK), and a lock per resource each method claims (LOCKS), so
answers can come back in another order than asked. Background work (a Mesh run, a scan) is a job (jobs.py).

Add a method by writing a function (state, params) -> result and listing it in METHODS. Its docstring's
`Params:`, `Result:`, `Errors:` and `Since:` fields are its row in docs/serve-api.md: name it in one of that
doc's `<!-- BEGIN generated:methods ... -->` markers and run `uv run python scripts/gen-serve-api.py`
(scripts/gen-serve-api.py has the format; tests/test_serve_api_doc.py fails until the doc matches).
"""

import hashlib
import json
import os
import queue
import re
import secrets
import shutil
import signal
import sys
import threading
import time
from contextlib import contextmanager

from . import __version__, askpass, changes, diagnose, discover, edit, fill, health, jobs, mesh, providers
from .claude import write_claude_files
from .common import current_deadline, deadline, deadline_at, not_reviewed, ssh_config_file, ssh_path
from .config import find_config, load_config
from .errors import (  # noqa: F401 (the codes are part of serve's API)
    ALREADY_SIGNED_OUT,
    BUSY,
    CANCELLED,
    CANT_ADD,
    CANT_WRITE,
    CLI_MISSING,
    GROUP_NOT_EMPTY,
    HOST_EXISTS,
    HOST_KEY_CHANGED_WHILE_ASKED,
    HOST_KEY_UNKNOWN,
    INVALID_EDIT,
    INVALID_HOST,
    INVENTORY_ERROR,
    ITEM_EXISTS,
    LOGIN_NOT_SEEN,
    MESH_BUSY,
    NAME_TAKEN,
    NO_ASKPASS,
    NO_CHECK,
    NO_SCAN,
    NO_SIGN_IN,
    NOT_A_SOURCE,
    NOT_CREATED_HERE,
    NOT_LOGGED_IN,
    NOT_REVIEWED,
    NOT_SET_UP,
    NOT_VERIFIED,
    NOTHING_HELD,
    PASSWORD_NEEDED,
    READ_ONLY_TARGET,
    ROSTER_ERROR,
    SCAN_RUNNING,
    SIGN_OUT_FAILED,
    TOO_MANY_ADDRESSES,
    UNKNOWN_GROUP,
    UNKNOWN_HOST,
    UNKNOWN_TARGET,
    UNSUPPORTED,
    VAULT_LOCKED,
    WOULD_CHANGE,
    WRITE_FAILED,
    WRONG_PASSWORD,
    Problem,
    inventory_problem,
    sign_in_problem,
    vault_problem,
    write_problem,
)
from .providers import PROVIDERS, setup_providers
from .sshops import fingerprint, in_ssh_config, record_host_key, recorded_host_keys, write_ssh_config

API_VERSION = 26            # bump when a method or result changes in a way the app has to know about

# JSON-RPC's own error codes
PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR = -32700, -32600, -32601, -32602, -32603
# roster's own codes are in errors.py: stable, the app switches on them; the message is ready to show
RpcError = Problem


def busy_error(resource, who, subject=None):
    """Code 4: RESOURCE (a key of NAMES) was held by WHO (a method, or None) past this request's wait, and nothing
    was done. SUBJECT says what was busy, when it's narrower than the resource (a provider's items)."""
    return RpcError(BUSY, f"{subject or NAMES[resource]} is busy" + (f": {who} is still running" if who else "")
                    + " - nothing was done", {"busy": NAMES[resource], "method": who},
                    fix="try again once it has finished")


def closing_error():
    """serve's stdin closed: nothing new starts (code 3)."""
    return RpcError(ROSTER_ERROR, "roster serve is closing")


def die_message(e):
    """The text of a die() (SystemExit("error: ...")), without the prefix."""
    msg = str(e.code) if e.code is not None else "exited"
    return msg.removeprefix("error: ")


class State:
    """What serve holds for its lifetime: the loaded Inventory, or why it didn't load."""

    def __init__(self, config_arg):
        self.cfg, self.path, self.error = None, None, None
        self.digest = None                  # what roster.yml held at the last load (good or not): the watcher's base
        self.noticed = None                 # an outside edit already reported as not applied (auto off)
        self.auto = False                   # inventory.watch: apply outside edits as they're saved
        self.watcher = None                 # the Watcher thread, once inventory.watch started it
        self.notify = None                  # fn(method, params): a JSON-RPC notification to the app (serve() sets it)
        # roster.yml, its repo and the loaded Inventory: every write holds it for its whole request, a reload for
        # itself (LOCKS). Reentrant for its holder, so a write may reload.
        self.lock = Lock("roster.yml")
        self.vault = Lock("the vault")      # unlocking and locking alone; looking up, saving, minting tokens shared
        self.unlocked = set()               # providers vault.unlock opened (vault.lock locks them again)
        self.askpass = None                 # the askpass Channel, while serve() runs
        self.login = None                   # the sign-in in progress (vault.login): SignIn
        self.created = {}                   # item id -> provider, for the items vault.create_item made (undo)
        self.jobs = jobs.Jobs(log=log_line)  # background work: Mesh runs and scans (its notify is serve's)
        self.verified = {}                  # host.verify_login successes: login_key -> (time, host key to pin)
        self.held = {}                      # typed passwords held for "Save to vault", by id: Held (T15, T16)
        # state.held is also changed on the askpass channel's threads (a login report), so it has a lock of its own:
        # never a resource lock, which a long request holds for up to its deadline and would hold up askpass's answers.
        self.held_lock = threading.RLock()
        self.scan = None                    # the latest discover.start's Scan (discover.Scan); its job is in jobs
        self.scans = 0                      # how many discover.start started: the next one's id
        self.scan_lock = threading.Lock()   # held while one starts
        self.watch_lock = threading.Lock()  # held while inventory.watch starts the watcher (it's a quick read)
        self.closing = False                # serve's stdin closed: nothing new starts (a sign-in least of all)
        only_vault_unlock_unlocks()
        try:
            self.path = find_config(config_arg)
        except SystemExit as e:
            self.error = die_message(e)
            return
        self.reload()

    def reload(self):
        """Load roster.yml again (after a pull, an edit, a discard, `:source` or an outside edit, so hosts.list shows
        the file as it is). A file that doesn't load keeps the last good Inventory, with the error beside it."""
        with self.lock:                     # a write holding it may reload; anyone else waits for the write
            self.digest, self.noticed = file_digest(self.path), None
            try:
                cfg = load_config(self.path)
            except SystemExit as e:
                self.error = die_message(e)
                return
            self.cfg, self.path, self.error = cfg, cfg["path"], None
            setup_providers(cfg)

    def problem(self):
        """Why roster.yml doesn't load right now (code 1, with its line), or None."""
        if self.error is None:
            return None
        p = inventory_problem(self.error, self.path)
        p.data |= versions()
        return p

    def fresh(self):
        """roster.yml loaded again, for an edit: refuses (code 1) when the file as it is now doesn't load, even
        though the last good Inventory is still shown. It waits for a write under way at most what's left of the
        request's deadline (LOCK_WAIT without one): then 4, as a write's own claim would be."""
        with claimed(self, [("inventory", False)], "a reload"):
            self.reload()
            p = self.problem()
            if p:
                raise p
            return self.cfg

    def inventory(self):
        if self.cfg is None:
            raise self.problem()
        return self.cfg


def versions():
    return {"roster_version": __version__, "api_version": API_VERSION}


def file_digest(path):
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest() if path else None
    except OSError:
        return None


def broken(state):
    """hosts.list's and inventory.reload's `error`: why roster.yml as it is now doesn't load, while the last good
    Inventory is shown ({message, path, line?}); None when it loads."""
    p = state.problem()
    if p is None:
        return None
    return {"message": p.message, "path": p.data.get("path"), **({"line": p.data["line"]} if "line" in p.data else {}),
            "fix": p.data.get("fix")}


# ---------------------------------------------------------------- methods

def inventory_info(state, params):
    """Which roster.yml, on which box, and which roster and serve API answer: the app's first call.

    Params: none
    Result: `{path, box, host_count, providers: [names], roster_version, api_version}`
    Since: API 1
    """
    cfg = state.inventory()
    return {"path": str(cfg["path"]), "box": cfg["box"], "host_count": len(cfg["hosts"]),
            "providers": sorted(PROVIDERS), **versions()}


def hosts_list(state, params):
    """Every Host and group. While roster.yml doesn't load (an outside edit), the last good ones, and `error`.

    Params: none
    Result: `{hosts: [Host, ...], groups: {name: {title, description}}, error}`, hosts in `roster.yml` order.
        `error` (API 8) is `null`, or why `roster.yml` as it is now doesn't load while these are the last good
        ones
    Since: API 1
    """
    cfg = state.inventory()
    return {"hosts": list(cfg["hosts"].values()), "groups": cfg["groups"], "error": broken(state)}


def host_get(state, params):
    """One Host by its exact name (the app picks from hosts.list; no fuzzy matching here).

    Params: `{name}` (exact Host name)
    Result: one Host
    Errors: 2
    Since: API 1
    Params: `{name, settled: true}`
    Result: the Host once no write to `roster.yml` is under way: it waits for one as another write would (the
        app's check after a `host.add` it stopped waiting for)
    Errors: 2, 4
    Since: API 20
    """
    name = text_param(params, "name")
    settled = params.get("settled", False)
    if not isinstance(settled, bool):
        raise RpcError(INVALID_PARAMS, "params.settled must be true or false")
    if settled:
        with claimed(state, [("inventory", False)], "host.get"):
            h = state.inventory()["hosts"].get(name)
    else:
        h = state.inventory()["hosts"].get(name)
    if h is None:
        raise RpcError(UNKNOWN_HOST, f"unknown host {name!r}")
    return h


def text_param(params, key):
    v = params.get(key)
    if not isinstance(v, str) or not v:
        raise RpcError(INVALID_PARAMS, f"params.{key} must be a non-empty string")
    return v


# ---------------------------------------------------------------- sessions (ticket 05; ADR 0002)

def session_prepare(state, params):
    """What the app runs in a PTY to open a Session: the system ssh, never a secret.
    It uses the ssh-config alias `roster setup`/`sync` writes (Host NAME), so the key, user, port,
    known_hosts and connection sharing all come from the config, as `roster run` does, except that ssh checks the
    host key strictly: a Host with no recorded key is refused with 44 before anything connects, so the app can
    ask (ticket 36: host.scan_key, then host.trust_key).

    Params: `{host}` (exact Host name)
    Result: key-enrolled: `{argv: [/abs/path/ssh, "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes",
        NAME], env: {}, host: NAME, auth: "key", login}`; password-only: `{argv: [/abs/path/ssh, "-o",
        "StrictHostKeyChecking=yes", "-o", "NumberOfPasswordPrompts=1", "-o",
        "PreferredAuthentications=password,keyboard-interactive", NAME], env: {SSH_ASKPASS, SSH_ASKPASS_REQUIRE:
        "force", ROSTER_ASKPASS_SOCKET, ROSTER_ASKPASS_TOKEN}, host: NAME, auth: "password", login}`. `login` (API
        25) is `{address, port, user}`, what the Session connects to, for `session.fill`
    Errors: 2, 20, 21, 22, 30, 11, 12, 14, 31-35, 39, 44
    Since: API 1
    Params: `{host, password, save?}` (an `auth: prompt` Host)
    Result: a password Session whose askpass token holds the typed `password`; with `save: true`, also `held`,
        the logged-in script as `LocalCommand` and `-o ControlPath=none` (below)
    Errors: -32602, 22, 61, 44
    Since: API 13
    """
    name = text_param(params, "host")
    h = state.inventory()["hosts"].get(name)
    if h is None:
        raise RpcError(UNKNOWN_HOST, f"unknown host {name!r}")
    if not h["reviewed"]:
        raise RpcError(NOT_REVIEWED, not_reviewed(h))
    diagnose.check_user(h)
    ssh = shutil.which("ssh")         # absolute: the app spawns it with `wsl.exe --exec`, where PATH is thin
    if ssh is None:
        raise RpcError(NOT_SET_UP, "no ssh client on this box's PATH - install OpenSSH (openssh-client)")
    if not in_ssh_config(h["name"]):
        raise RpcError(NOT_SET_UP, f"{h['name']} isn't in this box's ssh config ({ssh_config_file()}) - "
                                   "run `roster sync`, or `roster setup` if this box isn't set up yet")
    # What the Session connects to (API 25): the core sends it back with a prompt fill, so a Host edited since isn't
    # filled into this Session (session.fill).
    login = {"login": {"address": h["ip"], "port": h["ssh"]["port"], "user": h["ssh"]["user"]}}
    if not h["enroll"] and prompted(h):
        return prompt_session(state, h, ssh, params) | login
    if params.get("password") is not None or params.get("save") is not None:
        raise RpcError(INVALID_PARAMS, f"params.password and params.save are only for a Host whose Login is auth: "
                                       f"prompt; {h['name']}'s password comes from its Login")
    if not h["enroll"] and diagnose.password_login(h):
        return password_session(state, h, ssh) | login
    known_key(h)
    return {"argv": [ssh, *STRICT, "-o", "BatchMode=yes", h["name"]], "env": {},
            "host": h["name"], "auth": "key"} | login


def session_fill(state, params):
    """The password for a prompt a Host Session shows (sudo's, or a nested ssh to the Host itself; ticket 119,
    decision Q129), for the app's core to type into that Session's PTY, and for nothing else: this is the one
    result that holds a secret. The core asks only when the user pressed the fill key at a detected prompt, never
    hands the result on (not to the frontend, a log or a Plugin, whose serve allow-list has no `session.*`), and
    types it only after checking that the prompt doesn't echo. `prompt` is the line at the Session's cursor, as the
    Host printed it: it can narrow what's filled (a prompt for another Host or account is refused, 130) but never
    widen it. Only sudo's prompt for the Host's ssh user, or ssh's for that user at the Host's own name or address, is
    filled; a bare `Password:` (su's, a login's) is refused. The Host must still have the address, port and user its
    Session connected to (130 if it was edited since). Which Login: its ssh Login, or its `sudo: {auth}` reference for
    sudo's prompt. Nothing is logged but the method's name; serve keeps the value only in the providers' cache it
    already had.

    Params: `{host, address, port, user, prompt}` (exact Host name; what its Session connected to, from
        `session.prepare`'s `login`; the cursor's line)
    Result: `{host, login: "ssh"|"sudo", password}`
    Errors: -32602, 1, 2, 20, 30, 130, 131, 11, 12, 14, 31-35
    Since: API 25
    Params: `{host, address, port, user, prompt, hop: {host, address, port, user}}` (a nested ssh in the Session:
        the Inventory Host the app resolved it to, from the command line the shell's marks gave, and the
        address, port and user it resolved; the Session's own Host is still checked as above)
    Result: `{host, login, password}` for the `hop` Host: its ssh Login for its own `USER@HOST's password:`, its
        sudo for sudo's; 130 if that Host isn't reviewed-and-unchanged as the app resolved it
    Errors: -32602, 2, 20, 30, 130, 131
    Since: API 26
    """
    name = text_param(params, "host")
    address, user = text_param(params, "address"), text_param(params, "user")
    port, prompt = params.get("port"), params.get("prompt")
    if isinstance(port, bool) or not isinstance(port, int):
        raise RpcError(INVALID_PARAMS, "params.port must be a number")
    if not isinstance(prompt, str):
        raise RpcError(INVALID_PARAMS, "params.prompt must be a string")
    cfg = state.inventory()
    h = cfg["hosts"].get(name)
    if h is None:
        raise RpcError(UNKNOWN_HOST, f"unknown host {name!r}")
    if not h["reviewed"]:
        raise RpcError(NOT_REVIEWED, not_reviewed(h))
    diagnose.check_user(h)
    fill.same_login(h, address, port, user)
    if params.get("hop") is not None:
        # A nested ssh in the Session (ticket 120, decision Q131): the prompt is that Host's, so its Login answers,
        # and only while it's still the Host the app resolved the ssh to.
        h = nested_host(cfg, params["hop"])
    which, ref = fill.login_for(h, prompt, cfg.get("sudo", {}).get(h["name"]))
    diagnose.check_provider(h, ref, which)
    return {"host": h["name"], "login": which, "password": diagnose.resolve_password(h, ref, which)}


def nested_host(cfg, hop):
    """The Inventory Host a nested ssh went to (session.fill's `hop`), if it's reviewed and still has the address,
    port and user the app resolved the ssh to."""
    if not isinstance(hop, dict):
        raise RpcError(INVALID_PARAMS, "params.hop must be an object")
    name, address, user = (text_param(hop, k) for k in ("host", "address", "user"))
    port = hop.get("port")
    if isinstance(port, bool) or not isinstance(port, int):
        raise RpcError(INVALID_PARAMS, "params.hop.port must be a number")
    h = cfg["hosts"].get(name)
    if h is None:
        raise RpcError(UNKNOWN_HOST, f"unknown host {name!r}")
    if not h["reviewed"]:
        raise RpcError(NOT_REVIEWED, not_reviewed(h))
    diagnose.check_user(h)
    fill.same_login(h, address, port, user, nested=True)
    return h


def known_key(h):
    """Refuse (44, with the address to ask about) a Session to a Host roster has recorded no host key for. It comes
    after every other check, so the app only asks about a key when trusting it is all that's left to do."""
    if not recorded_host_keys(h):
        raise RpcError(HOST_KEY_UNKNOWN, f"roster hasn't seen {h['name']}'s host key before",
                       {"address": h["ip"], "port": h["ssh"]["port"]},
                       fix="compare its fingerprint with the Host's console or owner, then trust it when the app "
                           f"asks, or run `roster setup --only {h['name']}`")


# An app Session never trusts a host key on its own (Q60): the key must already be in roster's known hosts, put
# there by `roster setup`, a verified add or edit, or host.trust_key after the app asked. On the command line it
# wins over the `StrictHostKeyChecking accept-new` in the Host block, which `roster ssh`/`run` keep.
STRICT = ["-o", "StrictHostKeyChecking=yes"]


def password_session(state, h, ssh):
    """ssh that asks `roster askpass` for the password: the env carries a one-time token, never the
    password. The Login is resolved now, in this process, so whatever is wrong with it (provider not set up,
    vault locked, item missing, several items, no password: errors.py 11-14, 30-35) is reported before ssh
    starts instead of as a failed login in the terminal. ssh's prompt then gets the value from memory."""
    need_askpass(state)
    diagnose.check_login(h)
    known_key(h)
    token = state.askpass.mint(h, h["name"])
    return {"argv": [ssh, *STRICT, "-o", "NumberOfPasswordPrompts=1",
                     "-o", "PreferredAuthentications=password,keyboard-interactive", h["name"]],
            "env": state.askpass.env(token), "host": h["name"], "auth": "password"}


def need_askpass(state, what="password sessions"):
    """Refuse (22) a password Session this process can't give its password to: no askpass channel (roster used
    in-process), or one whose helper isn't installed (Windows)."""
    if state.askpass is None:
        raise RpcError(NO_ASKPASS, f"the askpass channel isn't open in this process - {what} need `roster serve`")
    if state.askpass.problem:
        raise RpcError(NO_ASKPASS, state.askpass.problem)


def prompted(h):
    """Is the Host's ssh Login `auth: prompt`: a password nobody saved, which the user types (ticket 16)?"""
    login = diagnose.password_login(h)
    return login is not None and str(login["auth"]).partition(":")[0].strip() == "prompt"


def prompt_session(state, h, ssh, params):
    """A Session to an `auth: prompt` Host (ticket 16): roster has no password to look up, so the app asks for it
    (39 until it's sent) and it goes to ssh through an askpass token, like a vault password. With save: true serve
    holds it for "Save to vault" (host.save_login) until that Session has logged in with it; that Session then
    never reuses a shared connection (ControlPath=none), so the login really is made with the typed password."""
    need_askpass(state)
    diagnose.check_user(h)
    known_key(h)
    password = params.get("password")
    if password is None:
        raise RpcError(PASSWORD_NEEDED, f"{h['name']}'s Login is auth: prompt - type its password",
                       {"user": h["ssh"]["user"], "address": h["ip"], "port": h["ssh"]["port"]},
                       fix="type the password when the app asks; tick Save to vault to keep it in the vault "
                           "once it has logged in")
    if not isinstance(password, str) or not password:
        raise RpcError(INVALID_PARAMS, "params.password must be a non-empty string")
    save = save_param(params, password)
    if save:
        saving_provider(state, params)
    typed = askpass.Typed(password)
    del password
    argv = [ssh, *STRICT, "-o", "NumberOfPasswordPrompts=1",
            "-o", "PreferredAuthentications=password,keyboard-interactive"]
    held = {}
    if save:
        held = {"held": hold(state, secrets.token_hex(8), typed, "host", h["name"],
                             {"host": h["name"], "login": login_key(h)})}
        argv += [*state.askpass.login_options(), "-o", "ControlPath=none"]
    token = state.askpass.mint(typed, h["name"])
    return {"argv": [*argv, h["name"]], "env": state.askpass.env(token), "host": h["name"], "auth": "password",
            **held}


askpass_lookup = diagnose.askpass_lookup


def host_check(state, params):
    """`roster check HOST` for the app: the diagnostic steps in order, stopping at the first failure (see
    diagnose.check_host). The password login, if it gets that far, goes through serve's askpass channel. It runs as a
    job (kind `check`, one per Host at a time: a second ask while one runs joins it), which shares the vault only for
    a password Login's steps that fetch a secret or mint a token (API 22), and sends `job.progress` as each step
    starts. The waiting form answers with its result; `background: true` (API 21) answers at once, and
    `host.check_job` has the result once it's over. `vault.lock` stops a running check. Cancelling a waiting form
    stops the check only when no other request waits for it and none asked for it in the background (API 22); when
    the check goes on for them, the cancelled request answers 5 at once.

    Params: `{host, background?}` (exact Host name; `background` since API 21)
    Result: `{host, ok, steps: [{step, status, message, code?, fix?, details?, data?}, ...]}`; with `background: true`
        the job: `{kind: "check", job, action: "check", state, done, total, at, host, joined}`: `joined` (API 22) is
        true when it joined a check already running, which only its starter should stop
    Errors: -32602, 4, 5
    Since: API 2
    """
    name = text_param(params, "host")
    background = background_param(params)
    job, joined = check_job(state, name)
    job.hold(waiting=not background)
    if background:
        return {**job.view(), "joined": joined}
    gone = threading.Event()

    def cancel():
        # a cancel stops the check only if no other request wants it (one may have joined); if it goes on for them,
        # this request answers at once (5) rather than keep its worker until the check ends
        if not job.let_go():
            gone.set()
            job.wake()
    on_cancel(cancel)
    if not job.wait_unless(gone.is_set):
        raise cancelled("host.check")
    job.wait()                      # its thread is done with it
    if job.error is not None:
        raise RpcError(job.error["code"], job.error["message"], job.error.get("data"))
    return job.result


def check_job(state, name):
    """The running check of Host NAME, or a new one: (job, joined)."""
    def work(job):
        @contextmanager
        def vault():
            # shared only for the steps that fetch a secret or mint a token (diagnose.VAULT_STEPS), so a lock or an
            # unlock never waits for the rest; vault.lock stops the check rather than wait (stop_checks)
            at = current_deadline()
            if not state.vault.acquire(True, max(0.0, at - time.monotonic()), "host.check", job.halted):
                if job.halted.is_set():
                    raise diagnose.Stopped
                raise busy_error("vault", state.vault.holder())
            try:
                yield
            finally:
                state.vault.release()
        with deadline(DEADLINES["host.check"]):
            return diagnose.check_host(name, state.inventory, state.askpass, progress=job.progress,
                                       halted=job.halted, vault=vault)
    try:
        return state.jobs.start("check", "check", work, total=len(diagnose.STEPS), host=name, per_host=True,
                                job_prefix="check-", on_stop=state.vault.wake), False
    except jobs.Busy as e:
        return e.job, True
    except jobs.Closed:
        raise closing_error() from None


def stop_checks(state):
    """vault.lock's: stop every running check (at its next step) rather than wait up to its 45 s for it."""
    for job in state.jobs.running("check"):
        job.stop()


def host_check_job(state, params):
    """A Host check's job (`host.check {background: true}`): where it is, and its result once it's over. Never
    connects.

    Params: `{job}` (`check-N`)
    Result: `{kind: "check", job, action, state, done, total, at, host, error?, result?}`: `result` (once `state` is
        `done` or `stopped`) is `host.check`'s; a stopped check's later steps are `skipped` and `ok` is false
    Errors: -32602, 49
    Since: API 21
    """
    jid = text_param(params, "job")
    job = state.jobs.get("check", jid)
    if job is None:
        raise RpcError(NO_CHECK, f"no check {jid} in this roster serve (or a newer check of its Host replaced it)",
                       fix="check the Host again")
    out = job.view()
    if out["state"] in ("done", "stopped"):
        out["result"] = job.result
    return out


def box_check(state, params):
    """`roster check --box` for the app (ticket 49): this Box's health, every check local (health.check_box). It reads
    roster.yml as it is now (without applying it: that's the watcher's or :source's to do), so a file that doesn't
    load is an error even while the app shows the last good Inventory.

    Params: none
    Result: `{checks: [{section, level, message, fix?, topic?}, ...], ok, roster_version, api_version}`
    Since: API 16
    """
    error = state.error
    if state.path is not None and error is None:
        try:
            load_config(state.path)
        except SystemExit as e:
            error = die_message(e)
    checks = health.check_box(state.path, state.cfg, error, health.askpass_state(state.askpass), API_VERSION)
    return {"checks": checks, "ok": not any(c["level"] == "error" for c in checks), **versions()}


METHODS = {
    "inventory.info": inventory_info,
    "box.check": box_check,
    "hosts.list": hosts_list,
    "host.get": host_get,
    "session.prepare": session_prepare,
    "session.fill": session_fill,
    "host.check": host_check,
    "host.check_job": host_check_job,
}


# ---------------------------------------------------------------- editing: Pending changes (ticket 10)

VERIFIED_FOR = 600          # s: how long a successful host.verify_login lets host.update make that change


def inventory_path(state):
    """roster.yml's path, even when it doesn't load (a pull or a discard may be what fixes it)."""
    if state.path is None:
        state.inventory()                   # raises the "no roster.yml" problem
    return state.path


def inventory_pull(state, params):
    """Fast-forward the infra repo before an edit (changes.pull), then load roster.yml again.

    Params: none
    Result: `{updated, upstream, commits, ahead, from?, to?, message?}`: the repo fast-forwarded to its upstream
        (`upstream: null` when the branch has none: nothing to pull). Refuses uncommitted changes (`71`,
        `data.files`) and a diverged branch (`72`, `data.ahead`/`behind`); a failed fetch is `73`. Never merges,
        rebases or stashes
    Errors: 70-73
    Since: API 5
    """
    result = changes.pull(inventory_path(state))
    state.reload()
    return result


def edit_params(params):
    """params.changes, checked: {field: value} for edit.EDITABLE fields only."""
    fields = params.get("changes")
    if not isinstance(fields, dict) or not fields:
        raise RpcError(INVALID_PARAMS, f"params.changes must be an object of {', '.join(edit.EDITABLE)}")
    try:
        return {k: edit.check_value(k, v) for k, v in fields.items()}
    except ValueError as e:
        raise RpcError(INVALID_PARAMS, f"params.changes: {e}") from None


def edited_host(state, params):
    """(the Host now, the Host as params would leave it, the fields that really change). Reads roster.yml afresh."""
    name = text_param(params, "host")
    h = state.fresh()["hosts"].get(name)
    if h is None:
        raise RpcError(UNKNOWN_HOST, f"unknown host {name!r}")
    now = edit.current(h)
    wanted = {k: v for k, v in edit_params(params).items() if now[k] != v}
    after = {**now, **wanted}
    new = {**h, "ip": after["ip"], "ssh": {"user": after["user"], "port": after["port"], "auth": after["auth"]}}
    return h, new, wanted


def login_key(h):
    return (h["name"], h["ip"], h["ssh"]["user"], h["ssh"]["port"], h["ssh"]["auth"], h["enroll"])


def host_verify_login(state, params):
    """A test login to the Host as params.changes would leave it (diagnose.verify_login): exactly one attempt.
    Success lets host.update make exactly that change for the next VERIFIED_FOR seconds.

    Params: `{host, changes}`
    Result: `{host, ok, steps}` like `host.check`, with steps `user`, `provider`, `vault-item`, `dns`, `tcp`,
        `host-key`, `auth`, run against the Host as `changes` would leave it
    Errors: 2
    Since: API 5
    """
    h, new, _ = edited_host(state, params)
    # The vault only now, after the reload: roster.yml before the vault, always (LOCKS' order), or a write holding
    # roster.yml and waiting behind a vault.lock that waits for this request would never end.
    with claimed(state, [("vault", True)], "host.verify_login"):
        result = diagnose.verify_login(new, state.cfg["key"], previous=h)
    if result["ok"]:
        state.verified[login_key(new)] = (time.monotonic(), result.pop("host_key", None))
    return result


def host_update(state, params):
    """Edit one Host in roster.yml, keeping everything else byte for byte (edit.edited), as a Pending change.
    A change to its address, user or Login needs a host.verify_login of exactly those values first.

    Params: `{host, changes}`
    Result: `{changed, host, backup, warnings}`: the edit written into `roster.yml`, `host` as it loads now,
        `backup` the file as it was, `warnings` what failed after the write (recording a moved Host's key)
    Errors: 2, 70, 74, 75
    Since: API 5
    """
    h, new, wanted = edited_host(state, params)
    if not wanted:
        return {"changed": False, "host": h, "backup": None}
    key = login_key(new)
    pin = None
    if set(wanted) & set(edit.LOGIN_FIELDS):
        at, pin = state.verified.get(key, (None, None))
        if at is None or time.monotonic() - at > VERIFIED_FOR:
            raise RpcError(NOT_VERIFIED, f"{h['name']}'s new address, user or Login hasn't passed a test login",
                           fix="test the login (host.verify_login) with these values, then save again")
    repo = changes.Repo(state.path)
    old_text, new_text, _ = edit.edited(repo.path, h["name"], wanted)
    backup = repo.backup(old_text)
    edit.replace_file(repo.path, new_text)
    state.verified.pop(key, None)
    warnings = []
    if pin:                     # it moved: the key it was verified with is now recorded for its new address
        try:
            record_host_key(new, pin["type"], pin["base64"])
        except Exception as e:
            warnings.append(f"{h['name']} was changed, but its host key couldn't be recorded for {new['ip']} "
                            f"({failure_text(e)}) - test the login again before connecting")
    state.reload()
    return {"changed": True, "host": state.inventory()["hosts"][h["name"]], "backup": str(backup),
            "warnings": warnings}


def changes_diff(state, params):
    """The Pending changes: roster.yml's uncommitted diff, by Host and group, and what Publish would commit.

    Params: none
    Result: `{path, repo, diff, hosts: [{host, change: changed|added|removed, fields}], groups: [{group,
        change}], count, message, last_commit}`: git's diff of `roster.yml` against the last commit, the commit
        message `changes.publish` would write, and `last_commit: {commit, subject, upstream, pushed}` (the
        branch's last commit, and whether its upstream has it as this box last fetched)
    Errors: 70
    Since: API 5
    """
    return changes.diff(inventory_path(state))


def changes_discard(state, params):
    """Throw the Pending changes away: roster.yml back as the last commit has it, then load it again.

    Params: none
    Result: `{discarded, backup}`: `roster.yml` back as the last commit has it (index and working tree)
    Errors: 70
    Since: API 5
    """
    result = changes.discard(inventory_path(state))
    state.reload()
    return result


def changes_publish(state, params):
    """Commit and push the Pending changes (changes.publish), then `roster sync`, so this Box's ssh config
    follows what it just published. A failed sync doesn't undo the Publish: it's reported in result.sync.

    Params: `{message?}`
    Result: `{commit, upstream, message, hosts, groups: [{group, change}], pulled, sync: {ok, error?, fix?}}`:
        commits `roster.yml` alone and pushes it to the branch's upstream, then runs `roster sync`
    Errors: 1, 70, 73, 90-96
    Since: API 7
    """
    message = params.get("message")
    if message is not None and not isinstance(message, str):
        raise RpcError(INVALID_PARAMS, "params.message must be a string")
    result = changes.publish(inventory_path(state), message)
    state.reload()
    try:
        cfg = state.inventory()
        write_ssh_config(cfg)
        write_claude_files(cfg)
        result["sync"] = {"ok": True}
    except (Problem, SystemExit, OSError) as e:
        why = e.message if isinstance(e, Problem) else die_message(e) if isinstance(e, SystemExit) else str(e)
        result["sync"] = {"ok": False, "error": why, "fix": "run `roster sync` on this box"}
    return result


# ---------------------------------------------------------------- adding a Host (ticket 11, decision Q43)

ADD_PARAMS = {"address": "ip", "user": "user", "port": "port", "auth": "auth", "enroll": "enroll", "type": "type",
              "title": "title", "description": "description"}


def add_fields(params):
    """host.add's params as edit.added's fields (checked), leaving out the ones not given."""
    try:
        return {f: edit.check_new(f, params[p]) for p, f in ADD_PARAMS.items() if params.get(p) is not None}
    except ValueError as e:
        raise RpcError(INVALID_PARAMS, f"params: {e}") from None


def save_to_param(params):
    """params.save_to (ticket 35): where to save, chosen at save time, or None for the setting's."""
    value = params.get("save_to")
    if value is None:
        return None
    try:
        return providers.check_save_to(value)
    except ValueError as e:
        raise RpcError(INVALID_PARAMS, f"params.save_to {e}") from None


def typed_login(state, params, name):
    """{password, provider, item, save_to} for a password typed into the form, or None. Checked, never echoed."""
    password = params.get("password")
    if password is None:
        return None
    if not isinstance(password, str) or not password:
        raise RpcError(INVALID_PARAMS, "params.password must be a non-empty string")
    if params.get("auth") is not None:
        raise RpcError(INVALID_PARAMS, "give params.auth (an existing vault item) or params.password (a new one), "
                                       "not both")
    return {"password": password, "provider": vault_provider(state, params), "item": item_param(params, name),
            "save_to": save_to_param(params)}


def host_scan_key(state, params):
    """The host key at an address, to show the user before host.add's first login there (diagnose.scan_key).
    With params.host instead, a Host's (its address and port): the key a Session asks about (ticket 36).

    Params: `{host}` (exact Host name)
    Result: `{host, address, port, key_type, fingerprint, recorded: none|match|changed}`: as the `{address,
        port?}` form, for the Host's address and port
    Errors: 2, 40-42
    Since: API 11
    Params: `{address, port?}`
    Result: `{address, port, key_type, fingerprint, recorded: none|match|changed}`: the host key the address
        offers, and how it compares with the one in `~/.ssh/roster_known_hosts`. One connection, key exchange
        only: never logs in, never records anything
    Errors: 40-42
    Since: API 6
    """
    if "host" in params:
        h = known_host(state, params)
        return {"host": h["name"], "address": h["ip"], "port": h["ssh"]["port"], **diagnose.scan_key(h)}
    fields = add_fields({"address": params.get("address"), "port": params.get("port")})
    if "ip" not in fields:
        raise RpcError(INVALID_PARAMS, "params.address must be a non-empty string")
    port = fields.get("port", 22)
    h = {"name": params.get("name") or fields["ip"], "ip": fields["ip"], "ssh": {"port": port}}
    return {"address": fields["ip"], "port": port, **diagnose.scan_key(h)}


def known_host(state, params):
    """The Host named by params.host (exact name)."""
    name = text_param(params, "host")
    h = state.inventory()["hosts"].get(name)
    if h is None:
        raise RpcError(UNKNOWN_HOST, f"unknown host {name!r}")
    return h


def host_trust_key(state, params):
    """Record the host key the user was shown (host.scan_key {host}) and trusted, so the Session can open (ticket
    36, decision Q60). It fetches the key again first and records it only if the Host still offers exactly that
    fingerprint (else 23); a key that differs from one already recorded is never trusted here (43, Q44).

    Params: `{host, fingerprint}` (`SHA256:...`, the one the user was shown)
    Result: `{host, address, port, key_type, fingerprint, recorded}`: `recorded: true` when it added the key,
        `false` when that key was already recorded. `43` a different key is recorded, `23` the Host offers
        another key now; nothing is recorded on any error
    Errors: 43, 23, 40-42
    Since: API 11
    """
    h = known_host(state, params)
    asked = asked_fingerprint(params)
    key, recorded = diagnose.offered_key(h)
    if recorded == "changed":
        raise diagnose.changed_key(h, recorded_host_keys(h), key)
    offered = still_offered(asked, key, h["name"], "nothing was recorded", "Host", "open the Session again")
    if recorded == "none":
        record_host_key(h, key.get_name(), key.get_base64())
    return {"host": h["name"], "address": h["ip"], "port": h["ssh"]["port"], "key_type": key.get_name(),
            "fingerprint": offered, "recorded": recorded == "none"}


def asked_fingerprint(params):
    """params.fingerprint: the key the user was shown (host.scan_key) and answered about."""
    asked = params.get("fingerprint")
    if not isinstance(asked, str) or not asked.startswith("SHA256:"):
        raise RpcError(INVALID_PARAMS, "params.fingerprint must be the SHA256:... fingerprint the user was shown")
    return asked


def still_offered(asked, key, label, outcome, who, again):
    """KEY's fingerprint, if it's still the one the user was asked about (ASKED); else 23: LABEL's key changed while
    roster was asking, so OUTCOME (nothing recorded or started); the fix names the WHO to ask and how to ask AGAIN."""
    offered = fingerprint(key)
    if offered != asked:
        raise RpcError(HOST_KEY_CHANGED_WHILE_ASKED, f"{label}'s host key changed while roster was asking - {outcome}",
                       {"asked": asked, "offered": offered},
                       fix=f"don't trust it blindly: compare the new fingerprint with the {who}'s console or owner, "
                           f"then {again} to see it",
                       details=f"asked about {asked}; now offered {key.get_name()} {offered}")
    return offered


# ---------------------------------------------------------------- Quick Connect (ticket 14)
# A Session to user@address[:port], a box that isn't in the Inventory. The app shows the key host.scan_key
# {address, port} fetched; quick.prepare fetches it again and goes on only if it's still exactly that one. The key
# is trusted for this Session only: it goes into serve's own known-hosts file (in the askpass channel's private
# directory, gone when serve exits) under an alias of its own, never into roster's known hosts, so a box nobody
# added stays unknown to every Host-to-be at that address (T15's "Save to vault" records it, after the login).
# A typed password goes to ssh through the askpass channel, exactly like a vault password: once, within 60 s,
# and forgotten by vault.lock. Nothing is written to roster.yml.

QUICK_USER = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]*")
QUICK_ADDRESS = re.compile(r"[A-Za-z0-9_.:%][A-Za-z0-9_.:%-]*")     # a name, IPv4 or IPv6 (no brackets, no '-' first)


def quick_target(params):
    """(user, address, port) from quick.prepare's params, checked: nothing ssh could read as an option."""
    user, address, port = params.get("user"), params.get("address"), params.get("port", 22)
    if not isinstance(user, str) or not QUICK_USER.fullmatch(user):
        raise RpcError(INVALID_PARAMS, "params.user must be a user name (letters, digits, '.', '_', '-'; not "
                                       "starting with '-')")
    if not isinstance(address, str) or not QUICK_ADDRESS.fullmatch(address):
        raise RpcError(INVALID_PARAMS, "params.address must be a host name or an IP address")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise RpcError(INVALID_PARAMS, "params.port must be a number from 1 to 65535")
    return user, address, port


def quick_prepare(state, params):
    """What the app runs in a PTY for a Quick Connect: ssh to user@address:port, checking the host key strictly
    against the one the user was shown (params.fingerprint, from host.scan_key). With params.password the Session
    logs in with it, through an askpass token; without, with this box's own keys (BatchMode). Refuses a key that
    changed since the user was asked (23) or differs from one roster recorded for the address (43), and 40-42 when
    it can't get there; nothing is kept on any error.

    Params: `{user, address, port?: 22, fingerprint, password?, save?}`
    Result: `{argv, env, host, auth, quick, user, address, port, key_type, fingerprint, held?}`: `argv` is
        `[/abs/path/ssh, "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=<serve's own file>", "-o",
        "GlobalKnownHostsFile=/dev/null", "-o", "HostKeyAlias=roster-quick-<quick>", "-o", "UpdateHostKeys=no",
        "-o", "ControlPath=none", "-o", "ConnectTimeout=10", ...auth options, "-p", PORT, "-l", USER, "--",
        ADDRESS]`; with a password, `auth: "password"`, the password options and the askpass `env` of a password
        Session; without, `auth: "key"`, `BatchMode=yes` and `env: {}`. `host` is `user@address` (`:port` when
        it isn't 22). `quick` is serve's id for this Quick Connect. `-32602` bad params (a user or address ssh
        could read as an option, no `SHA256:` fingerprint, an empty password, `save` without a password), `61`
        `save` with a provider that can't save, `43` the key differs from one roster recorded for the address,
        `23` it isn't the one the user was shown
    Errors: -32602, 61, 40-42, 43, 23, 21, 22
    Since: API 12
    """
    user, address, port = quick_target(params)
    asked = asked_fingerprint(params)
    password = params.get("password")
    if password is not None and (not isinstance(password, str) or not password):
        raise RpcError(INVALID_PARAMS, "params.password must be a non-empty string, or left out to log in with "
                                       "this box's keys")
    save = save_param(params, password)
    if save:
        saving_provider(state, params)
    ssh = shutil.which("ssh")
    if ssh is None:
        raise RpcError(NOT_SET_UP, "there's no ssh on this box's PATH - install OpenSSH's client")
    if state.askpass is None:
        raise RpcError(NO_ASKPASS, "the askpass channel isn't open in this process - Quick Connect needs "
                                   "`roster serve`")
    if password is not None:
        need_askpass(state, "Quick Connects with a password")
    label = quick_label(user, address, port)
    h = {"name": label, "ip": address, "ssh": {"port": port, "user": user}}
    key, recorded = diagnose.offered_key(h)
    if recorded == "changed":
        p = diagnose.changed_key(h, recorded_host_keys(h), key)
        p.data["fix"] = ("don't accept it blindly: compare the new fingerprint with the box's console or owner. If "
                         "the change is expected (reinstall), delete its line in ~/.ssh/roster_known_hosts")
        raise p
    offered = still_offered(asked, key, label, "not connecting", "box", "Quick Connect again")
    qid = secrets.token_hex(8)
    alias = f"roster-quick-{qid}"
    known = state.askpass.known_hosts
    fd = os.open(known, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a") as f:
        f.write(f"{alias} {key.get_name()} {key.get_base64()}\n")
    quick = {"user": user, "address": address, "port": port, "key_type": key.get_name(), "fingerprint": offered,
             "base64": key.get_base64()}        # what quick.save needs, kept only with a held password (T15)
    argv = [ssh, *STRICT, "-o", f"UserKnownHostsFile={ssh_value(ssh_path(known))}", "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", f"HostKeyAlias={alias}", "-o", "UpdateHostKeys=no", "-o", "ControlPath=none",
            "-o", "ConnectTimeout=10"]
    held = {}
    if password is None:
        argv += ["-o", "BatchMode=yes"]
        env, auth = {}, "key"
    else:
        argv += ["-o", "NumberOfPasswordPrompts=1", "-o", "PreferredAuthentications=password,keyboard-interactive",
                 "-o", "PubkeyAuthentication=no"]
        typed = askpass.Typed(password)
        del password
        if save:
            held = {"held": hold(state, qid, typed, "quick", label, quick)}
            argv += state.askpass.login_options()
        token = state.askpass.mint(typed, label)
        env, auth = state.askpass.env(token), "password"
    argv += ["-p", str(port), "-l", user, "--", address]
    return {"argv": argv, "env": env, "host": label, "auth": auth, "quick": qid, "user": user, "address": address,
            "port": port, "key_type": key.get_name(), "fingerprint": offered, **held}


# ---------------------------------------------------------------- "Save to vault" after the Session's login (T15, T16)
# Q43 says a password enters the vault only after a login with exactly it succeeded. For a Session that's that
# Session's own login: with save: true, serve keeps the typed password in memory, bound to an id (the Quick Connect's,
# or the Host Session's), and ssh runs askpass's logged-in script as its LocalCommand, which ssh does only once it has
# logged in. The report counts only if that Session's token handed this password to ssh. The save then refers to
# the id; the password is never sent again. It's forgotten after one save, by vault.forget_typed (the Session ended
# without saving), by vault.lock, or HOLD_FOR after it was typed (the askpass channel's tick enforces it).

HOLD_FOR = 600              # s: how long a typed password waits for its "Save to vault"
HELD_LIMIT = 64             # typed passwords held at once; a new one beyond it forgets the oldest


class Held:
    """A typed password held for "Save to vault": what it's for (target: a Quick Connect's box and confirmed key, or a
    Host Session's Host and Login), and whether its Session has logged in with it. Nothing else of the Session is
    kept: it all goes with the Held."""

    __slots__ = ("typed", "kind", "label", "target", "until", "logged_in")

    def __init__(self, typed, kind, label, target):
        self.typed, self.kind, self.label, self.target = typed, kind, label, target
        self.until, self.logged_in = time.monotonic() + HOLD_FOR, False

    def forget(self):
        self.typed.password, self.typed.on_login = None, None


def save_param(params, password):
    save = params.get("save", False)
    if not isinstance(save, bool):
        raise RpcError(INVALID_PARAMS, "params.save must be true or false")
    if save and password is None:
        raise RpcError(INVALID_PARAMS, "params.save needs params.password: only a typed password can be saved")
    return save


def saving_provider(state, params):
    """The provider "Save to vault" will save in (params.provider, else the Inventory's vault), checked before the
    Session starts: it must be one that can save (61)."""
    name = vault_provider(state, params)
    if not providers.can_write(name):
        raise write_problem(providers.CantWrite(
            f"provider '{name}' can't save to the vault - roster only reads its Logins; connect without Save to "
            "vault and create the item in the password manager itself"))
    return name


def hold(state, hid, typed, kind, label, target=None):
    """Hold TYPED under HID until it's saved or forgotten; its Session's login report marks it (and tells the app:
    the session.logged_in notification)."""
    held = Held(typed, kind, label, target)

    def on_login():                             # on the askpass channel's thread
        with state.held_lock:
            if state.held.get(hid) is not held or held.typed.password is None:
                return
            held.logged_in = True
        if state.notify:                        # outside the lock: it writes to the app
            state.notify("session.logged_in", {"held": hid})
    typed.on_login = on_login
    with state.held_lock:
        prune_held(state)
        while len(state.held) >= HELD_LIMIT:
            forget_held(state, next(iter(state.held)))
        state.held[hid] = held
    if state.askpass is not None:
        state.askpass.nudge()                   # its tick forgets this one when HOLD_FOR is up
    return hid


def open_channel(state):
    """serve's askpass channel, which also forgets the held passwords whose HOLD_FOR is up (on its tick), so none
    outlives its time waiting for a request that would prune it."""
    return askpass.Channel(askpass_lookup, log=log_line, tick=lambda: prune_held(state))


def prune_held(state):
    """Forget the held passwords whose time is up; the seconds until the next one's is (None: nothing held)."""
    with state.held_lock:
        now = time.monotonic()
        for hid, held in list(state.held.items()):
            if held.until <= now:
                held.forget()
                del state.held[hid]
        nxt = min((h.until for h in state.held.values()), default=None)
    return None if nxt is None else max(0.0, nxt - now)


def logged_in_with(state, hid, kind):
    """The Held for HID, once its Session logged in with it (66 before, 67 if there's none), and its password (read
    now: the Held may be forgotten on another thread meanwhile)."""
    with state.held_lock:
        prune_held(state)
        held = state.held.get(hid) if isinstance(hid, str) else None
        password = held.typed.password if held is not None else None
    if held is None or held.kind != kind:
        raise RpcError(NOTHING_HELD, "there's no typed password to save for that Session: it was saved already, or "
                                     "forgotten (the Session ended, the vault was locked, or 10 minutes passed)",
                       fix="connect again with Save to vault ticked")
    if not held.logged_in:
        raise RpcError(LOGIN_NOT_SEEN, f"{held.label} hasn't logged in with that password - roster saves it only "
                                       "after the login succeeded",
                       fix="wait until the Session has logged in; if the box refused the password, nothing is saved")
    return held, password


def forget_held(state, hid=None):
    """Forget one held password (HID; whether there was one), or all of them (vault.lock)."""
    found = False
    with state.held_lock:
        for key in [hid] if hid is not None else list(state.held):
            held = state.held.pop(key, None)
            if held is not None:
                held.forget()
                found = True
    return found


def vault_forget_typed(state, params):
    """Forget the typed password held for a Session's "Save to vault" (the Session ended, or the offer was turned
    down). Never fails.

    Params: `{held}`
    Result: `{forgotten}`: `serve` forgets the typed password it held (the Session ended without saving, or the
        offer was turned down). Never fails
    Since: API 13
    """
    hid = text_param(params, "held")
    return {"forgotten": forget_held(state, hid)}


def holding_a_secret(what, method, state, params):
    """Run a method that handles a password: an unexpected exception becomes 'WHAT failed: <its type>', so the
    generic handler never logs text that might hold the password."""
    try:
        return method(state, params)
    except (RpcError, SystemExit):
        raise
    except Exception as e:
        raise RpcError(INTERNAL_ERROR, f"{what} failed: {type(e).__name__}") from None


def save_held(state, repo, hid, password, item, change, what):
    """Q43's order, once a held password's Session logged in with it: the Vault item (ITEM: make_item's other
    arguments), then CHANGE(path) -> (old_text, new_text) written as a Pending change, the item taken back out if that
    fails (WHAT: what then wasn't done); then the password is forgotten. Returns (the item, the backup's path)."""
    made = make_item(password=password, **item)
    try:                                        # until roster.yml is written, any failure takes the item back out
        old_text, new_text = change(repo.path)
        backup = repo.backup(old_text)
        edit.replace_file(repo.path, new_text)
    except BaseException as e:
        raise take_back(made, write_failed(what, repo.path, e)) from None
    forget_held(state, hid)
    return made, backup


# Making or deleting a Vault item, one at a time per provider (ticket 108): bw keeps its local cache in one data.json
# and pass commits each insert to a git repo, so neither is known to take two writes at once, and two creations of one
# name would both pass the "no item by that name" check. Inside the shared vault lock (after roster.yml and the vault in
# Q112's order); it waits at most what's left of the request's deadline (LOCK_WAIT without one), then 4.
ITEM_LOCKS = {}
ITEM_LOCKS_LOCK = threading.Lock()


def item_lock(provider):
    with ITEM_LOCKS_LOCK:
        return ITEM_LOCKS.setdefault(provider, Lock(f"{provider}'s items"))


@contextmanager
def item_writes(provider, floor=0.0):
    """Hold PROVIDER's item lock while a Vault item is made or deleted (FLOOR: an undo waits at least that long)."""
    lock = item_lock(provider)
    at = current_deadline()
    wait = LOCK_WAIT if at is None else max(floor, at - time.monotonic())
    r = current_request()
    if not lock.acquire(False, wait, r.method if r is not None else "a Vault item"):
        raise busy_error("vault", lock.holder(), f"{provider}'s items")
    try:
        yield
    finally:
        lock.release()


def make_item(provider, item, password, user, address, port, save_to):
    """The Vault item for a password that just logged in: the user in its username field, ssh://address[:port] in
    its URI field. Raises the write_problem (60-65, 14) when the vault refuses."""
    uri = f"ssh://{address}" + ("" if port == 22 else f":{port}")
    try:
        with item_writes(provider):
            made = providers.create_item(provider, name=item, password=password, username=user, uri=uri,
                                         save_to=save_to)
    except providers.SecretError as e:
        raise write_problem(e) from None
    return {"provider": provider, **made}


def item_param(params, name):
    item = params.get("item") or f"{name} ssh"
    if not isinstance(item, str) or not item.strip() or "\n" in item or ":" in item:
        raise RpcError(INVALID_PARAMS, "params.item must be one line, without ':' (e.g. 'esx-02 ssh')")
    return " ".join(item.split())


def quick_save(state, params):
    """Save a Quick Connect that logged in (ticket 15, Q43): its typed password as the Vault item `<name> ssh`, then
    the box as the Host NAME in GROUP (reviewed, enroll: false, its Login that item) as a Pending change, then the
    host key the user confirmed for the Session recorded for it. The item is taken back out if the Host can't be
    written. The password is forgotten once it's saved.

    Params: `{quick, name, group, item?, title?, provider?, save_to?}`
    Result: `{added: true, host, backup, item, warnings}`, like `host.add`'s: the Vault item `item` (default
        `<name> ssh`), with the user in its username field and `ssh://address[:port]` in its URI field, then the
        Host `name` in `group` with `ip`, `user`, `port`, `auth: "<provider>:<item>"`, `reviewed: true` and
        `enroll: false`, as a Pending change, then the host key the user confirmed for the Session recorded for
        it in `~/.ssh/roster_known_hosts` (never a fresh scan; a failure there is a `warning`)
    Errors: 80, 81, 74, 60-62, 64, 65, 14, 66, 67
    Since: API 13
    """
    return holding_a_secret("saving the Quick Connect", save_quick, state, params)


def save_quick(state, params):
    hid = text_param(params, "quick")
    name, group = text_param(params, "name"), text_param(params, "group")
    item = item_param(params, name)
    save_to = save_to_param(params)
    held, password = logged_in_with(state, hid, "quick")
    provider = saving_provider(state, params)
    q = held.target
    fields = {"ip": q["address"], "user": q["user"], "port": q["port"], "auth": f"{provider}:{item}",
              "enroll": False, "reviewed": True}
    for f in ("title", "type", "description"):
        if params.get(f):
            fields[f] = params[f]
    try:
        fields = {f: edit.check_new(f, v) if f != "reviewed" else v for f, v in fields.items()}
    except ValueError as e:
        raise RpcError(INVALID_PARAMS, f"params: {e}") from None
    state.fresh()
    repo = changes.Repo(state.path)
    _, _, h = edit.added(repo.path, group, name, fields)      # a dry run: the name and group, before the vault
    made, backup = save_held(state, repo, hid, password,
                             {"provider": provider, "item": item, "user": q["user"], "address": q["address"],
                              "port": q["port"], "save_to": save_to},
                             lambda path: edit.added(path, group, name, fields)[:2], f"{name} wasn't added")
    warnings = []
    try:                                        # the key the user confirmed for this Session, never a fresh scan
        record_host_key(h, q["key_type"], q["base64"])
    except Exception as e:
        warnings.append(f"{name} was added, but its host key couldn't be recorded in ~/.ssh/roster_known_hosts "
                        f"({failure_text(e)}) - the first Session to it will ask about the key")
    state.reload()
    return {"added": True, "host": state.inventory()["hosts"][name], "backup": str(backup), "item": made,
            "warnings": warnings}


def host_save_login(state, params):
    """Save an `auth: prompt` Host's typed password once its Session logged in with it (ticket 16, Q43): the Vault
    item `<host> ssh`, then the Host's Login pointed at it, as a Pending change (comments and every other byte kept).
    The item is taken back out if the Host can't be changed. Refused (75) if the Host's address, user, port or Login
    changed since that Session logged in: it would save a password for a login nobody tested.

    Params: `{held, item?, provider?, save_to?}`
    Result: `{changed: true, host, backup, item, warnings}`: the Vault item `item` (default `<host> ssh`, the
        user and `ssh://address[:port]` in it), then the Host's Login set to `<provider>:<item>` as a Pending
        change, written like `host.update` (comments and every other byte kept; an inherited `auth: prompt` gets
        an `auth:` of the Host's own). The item is taken back out if the Host can't be changed. `75` if the
        Host's address, user, port or Login changed since that Session logged in
    Errors: 75, 66, 67, 60-65, 14
    Since: API 13
    """
    return holding_a_secret("saving the Login", save_login, state, params)


def save_login(state, params):
    hid = text_param(params, "held")
    held, password = logged_in_with(state, hid, "host")
    name = held.target["host"]
    item = item_param(params, name)
    save_to = save_to_param(params)
    provider = saving_provider(state, params)
    h = state.fresh()["hosts"].get(name)
    if h is None or login_key(h) != held.target["login"]:
        raise RpcError(NOT_VERIFIED, f"{name} changed since its Session logged in (its address, user, port or "
                                     "Login) - nothing was saved",
                       fix=f"open a new Session to {name} and save from there")
    wanted = {"auth": f"{provider}:{item}"}
    repo = changes.Repo(state.path)
    edit.edited(repo.path, name, wanted)        # a dry run: the edit must be possible before the vault is touched
    made, backup = save_held(state, repo, hid, password,
                             {"provider": provider, "item": item, "user": h["ssh"]["user"], "address": h["ip"],
                              "port": h["ssh"]["port"], "save_to": save_to},
                             lambda path: edit.edited(path, name, wanted)[:2], f"{name}'s Login wasn't changed")
    state.reload()
    return {"changed": True, "host": state.inventory()["hosts"][name], "backup": str(backup), "item": made,
            "warnings": []}


def quick_label(user, address, port):
    """How a Quick Connect is named in messages and the log, as the app writes it: user@address, with :port when
    it isn't 22 (an IPv6 address then in brackets)."""
    if port == 22:
        return f"{user}@{address}"
    return f"{user}@[{address}]:{port}" if ":" in address else f"{user}@{address}:{port}"


def ssh_value(path):
    """A path as an ssh -o value: quoted when it has a space (ssh splits a known-hosts list on whitespace)."""
    return f'"{path}"' if re.search(r"\s", path) else path


def host_add(state, params):
    """Add a Host to roster.yml as a Pending change (edit.added). With a Login (an existing vault item in auth, or
    a password typed into the form) it's a verified add (Q43): the test login first; then, for a typed password,
    the Vault item; then the Host. Nothing is written when the test login fails, and the item is taken back out
    when writing the Host fails. Without a Login the Host goes in unreviewed, as discover adds them.

    Params: `{name, group, address, user?, port?, type?, title?, description?, enroll?, auth? | password +
        item?, host_key?, provider?, save_to?}`
    Result: `{added: true, host, backup, verify, item, warnings}`: `host` as `roster.yml` has it now, `verify`
        the test login (`{host, ok, steps}`, or `null` without a Login), `item` the Vault item it made
        (`{provider, id, name, target}`, or `null`)
    Errors: 80, 81, 74, 61, 11, 12, 14, 30-35, 40-48, 60, 62, 64, 65
    Since: API 6
    """
    return holding_a_secret("adding the Host", add_host, state, params)


def add_host(state, params):
    name, group = text_param(params, "name"), text_param(params, "group")
    fields = add_fields(params)
    if "ip" not in fields:
        raise RpcError(INVALID_PARAMS, "params.address must be a non-empty string")
    host_key = params.get("host_key")
    if host_key is not None and not isinstance(host_key, str):
        raise RpcError(INVALID_PARAMS, "params.host_key must be a fingerprint (SHA256:...)")
    typed = typed_login(state, params, name)
    if typed:
        fields["auth"] = f"{typed['provider']}:{typed['item']}"
    state.fresh()
    repo = changes.Repo(state.path)
    _, _, h = edit.added(repo.path, group, name, fields)      # a dry run: the name, group and user, before the network
    login = typed is not None or diagnose.stored_password(h) is not None
    fields["reviewed"] = login
    verify = None
    if login:
        # a new Host's key isn't installed yet, so even an enroll: true Host is tested with its password
        verify = diagnose.verify_login({**h, "enroll": False}, state.cfg["key"], typed=typed, host_key=host_key)
        if not verify["ok"]:
            raise verify_failed(name, verify)
    made = None
    if typed:
        password, typed["password"] = typed["password"], None
        port = h["ssh"]["port"]
        uri = f"ssh://{h['ip']}" + ("" if port == 22 else f":{port}")
        try:
            with item_writes(typed["provider"]):
                made = providers.create_item(typed["provider"], name=typed["item"], password=password,
                                             username=h["ssh"]["user"], uri=uri, save_to=typed["save_to"])
        except providers.SecretError as e:
            raise write_problem(e) from None
        finally:
            del password
        made = {"provider": typed["provider"], **made}
    try:                                        # until the Host is written, any failure takes the item back out
        old_text, new_text, _ = edit.added(repo.path, group, name, fields)
        backup = repo.backup(old_text)
        edit.replace_file(repo.path, new_text)
    except BaseException as e:
        raise take_back(made, write_failed(f"{name} wasn't added", repo.path, e)) from None
    warnings = []                               # the Host is in roster.yml now: what follows can't un-add it
    if verify and verify.get("host_key"):
        k = verify["host_key"]
        try:
            record_host_key(h, k["type"], k["base64"])
        except Exception as e:
            warnings.append(f"{name} was added, but its host key couldn't be recorded in ~/.ssh/roster_known_hosts "
                            f"({failure_text(e)}) - run `roster sync`, or test the login again before connecting")
    state.reload()
    return {"added": True, "host": state.inventory()["hosts"][name], "backup": str(backup), "verify": verify,
            "item": made, "warnings": warnings}


def failure_text(e):
    """What went wrong, safe to show: an OSError's own words (paths only), else just the exception's type."""
    if isinstance(e, OSError):
        return f"{e.strerror or type(e).__name__}" + (f": {e.filename}" if e.filename else "")
    return type(e).__name__


def write_failed(what, path, e):
    """Writing roster.yml failed, so WHAT ("nas wasn't added"): as a Problem (a Problem or a die() keeps its own
    words)."""
    if isinstance(e, Problem):
        return e
    if isinstance(e, SystemExit):
        return Problem(ROSTER_ERROR, f"{what}: {die_message(e)}")
    return Problem(ROSTER_ERROR, f"{what}: couldn't write {path} ({failure_text(e)})")


def verify_failed(name, verify):
    """A failed test login as host.add's error: the failed step's own code and message, and every step."""
    fail = next(s for s in verify["steps"] if s["status"] == "fail")
    data = {"step": fail["step"], "steps": verify["steps"], **fail.get("data", {})}
    return Problem(fail["code"], f"{name} wasn't added: {fail['message']} - nothing was saved", data,
                   fix=fail.get("fix"), details=fail.get("details"))


def take_back(made, e):
    """Writing the Host failed after its Vault item was made: delete the item again (Q43), and say so."""
    if made is None:
        return e
    try:
        with deadline(UNDO_TIME), item_writes(made["provider"], UNDO_TIME):
            providers.delete_item(made["provider"], made["id"])
    except Exception as undo:
        what = str(undo) if isinstance(undo, providers.SecretError) else type(undo).__name__
        return Problem(e.code, f"{e.message}; the vault item '{made['name']}' couldn't be taken back out ({what}) "
                               "- delete it in the vault", {**(e.data or {}), "left": made},
                       fix=f"delete '{made['name']}' in the vault, then fix what stopped the add", details=e.details)
    return Problem(e.code, f"{e.message}; the vault item '{made['name']}' was taken back out",
                   {**(e.data or {}), "undone": made}, details=e.details)


def host_review(state, params):
    """Mark a Host reviewed (reviewed: true on the Host itself, nothing else changes), as a Pending change.
    With reviewed: false (API 9), mark it unreviewed again: a review made by mistake has a way back.

    Params: `{host, reviewed?}`
    Result: `{changed, host, backup}`: `reviewed: true` set on that Host and nothing else (`changed: false` if
        it already was). `reviewed: false` (API 9) un-reviews it, for a review made by mistake: where the Host's
        own `reviewed: true` sits over an unreviewed group or defaults, its line is taken out again, so the text
        goes back to what it was
    Errors: 2, 70, 74
    Since: API 6
    """
    name = text_param(params, "host")
    wanted = params.get("reviewed", True)
    if not isinstance(wanted, bool):
        raise RpcError(INVALID_PARAMS, "params.reviewed must be true or false")
    h = state.fresh()["hosts"].get(name)
    if h is None:
        raise RpcError(UNKNOWN_HOST, f"unknown host {name!r}")
    if h["reviewed"] == wanted:
        return {"changed": False, "host": h, "backup": None}
    repo = changes.Repo(state.path)
    old_text, new_text, _ = edit.reviewed(repo.path, name, wanted)
    backup = repo.backup(old_text)
    edit.replace_file(repo.path, new_text)
    state.reload()
    return {"changed": True, "host": state.inventory()["hosts"][name], "backup": str(backup)}


# ---------------------------------------------------------------- the Live Inventory (ticket 28, decision Q45)
# Removing, renaming and moving Hosts, and adding, renaming and deleting groups: each a text edit of roster.yml
# (edit.py) written as a Pending change, like host.update. Removing a Host never touches the vault.

def write_edit(state, old_text, new_text):
    """Write an edit of roster.yml (a Pending change), keeping what it replaced as the backup; load it again."""
    repo = changes.Repo(state.path)
    backup = repo.backup(old_text)
    edit.replace_file(repo.path, new_text)
    state.reload()
    return str(backup)


def name_param(params, key):
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise RpcError(INVALID_PARAMS, f"params.{key} must be a non-empty string")
    return v.strip()


def live_repo(state):
    """roster.yml as it is now, loaded, and in a git repo (Pending changes need one: 70)."""
    state.fresh()
    return changes.Repo(state.path)


def host_remove(state, params):
    """Take a Host out of roster.yml (its entry's lines), as a Pending change. Never touches the vault: its vault
    item, if any, stays where it is.

    Params: `{host}`
    Result: `{removed, group, backup}`: the Host's entry taken out, and every `links:` entry that names it.
        Its group stays, even empty. **Never touches the vault**: its vault item, if any, stays
    Errors: 1, 2, 70, 74
    Since: API 8
    """
    name = name_param(params, "host")
    repo = live_repo(state)
    old_text, new_text, h = edit.removed(repo.path, name)
    backup = write_edit(state, old_text, new_text)
    return {"removed": name, "group": h["group"], "backup": backup}


def host_rename(state, params):
    """Rename a Host (its key in roster.yml, nothing else), as a Pending change. Its vault item keeps its name.

    Params: `{host, to}`
    Result: `{changed, host, backup}`: only its key changes, and its name in `links:`. Its vault item keeps its
        name. `100` if `to` is taken
    Errors: 1, 2, 70, 74, 80, 100
    Since: API 8
    """
    name, to = name_param(params, "host"), name_param(params, "to")
    repo = live_repo(state)
    old_text, new_text, h = edit.renamed(repo.path, name, to)
    if old_text == new_text:
        return {"changed": False, "host": h, "backup": None}
    backup = write_edit(state, old_text, new_text)
    return {"changed": True, "host": state.inventory()["hosts"][to], "backup": backup}


def host_move(state, params):
    """Move a Host to the end of another group, as a Pending change. What it inherited from its old group and
    wouldn't from the new one is written on the Host, so it stays the same Host (`pinned` names those fields).

    Params: `{host, group}`
    Result: `{changed, host, pinned, backup}`: its lines cut and added at the end of `group`'s `hosts:`,
        re-indented. What it inherited from its old group (user, port, Login, `enroll`, `reviewed`, `mesh`,
        `type`, …) and wouldn't from the new one is written on the Host (`pinned` names those fields), so it stays
        the same Host; a Host with no `mesh:` anywhere takes the new group's. `101` no such group, `103` if it
        would still come out different
    Errors: 1, 2, 70, 74, 101, 103
    Since: API 8
    """
    name, group = name_param(params, "host"), name_param(params, "group")
    repo = live_repo(state)
    old_text, new_text, h, pinned = edit.moved(repo.path, name, group)
    if old_text == new_text:
        return {"changed": False, "host": h, "pinned": [], "backup": None}
    backup = write_edit(state, old_text, new_text)
    return {"changed": True, "host": state.inventory()["hosts"][name], "pinned": pinned, "backup": backup}


def group_new(state, params):
    """Add an empty group after the last one (`NAME:` with `hosts: {}`), as a Pending change.

    Params: `{name, title?}`
    Result: `{group, backup}`: `NAME:` with `hosts: {}` (and its `title:`) after the last group. `100` if taken
    Errors: 1, 70, 74, 80, 100
    Since: API 8
    """
    name = name_param(params, "name")
    title = params.get("title") or ""
    if not isinstance(title, str) or "\n" in title:
        raise RpcError(INVALID_PARAMS, "params.title must be one line")
    repo = live_repo(state)
    old_text, new_text = edit.group_added(repo.path, name, title)
    backup = write_edit(state, old_text, new_text)
    return {"group": name, "backup": backup}


def group_rename(state, params):
    """Rename a group (its key in roster.yml); its Hosts go with it. A Pending change.

    Params: `{group, to}`
    Result: `{changed, group, backup}`: only its key changes, and its name in `links:`; its Hosts follow. `100`
        if taken
    Errors: 1, 70, 74, 80, 100, 101
    Since: API 8
    """
    group, to = name_param(params, "group"), name_param(params, "to")
    repo = live_repo(state)
    old_text, new_text = edit.group_renamed(repo.path, group, to)
    if old_text == new_text:
        return {"changed": False, "group": to, "backup": None}
    backup = write_edit(state, old_text, new_text)
    return {"changed": True, "group": to, "backup": backup}


def group_delete(state, params):
    """Delete a group. One that still has Hosts is refused (102, data.hosts) unless `to` names the group they move
    to first (as host.move moves them). A Pending change.

    Params: `{group, to?}`
    Result: `{deleted, moved, to, backup}`: the group's entry taken out, and every `links:` entry that names
        it. A group that still has Hosts is refused
        (`102`, `data.hosts`) unless `to` names the group they move to first (as `host.move` moves them)
    Errors: 1, 70, 74, 101-103
    Since: API 8
    """
    group = name_param(params, "group")
    to = params.get("to")
    if to is not None:
        to = name_param(params, "to")
    repo = live_repo(state)
    old_text, new_text, moved = edit.group_deleted(repo.path, group, to)
    backup = write_edit(state, old_text, new_text)
    return {"deleted": group, "moved": moved, "to": to if moved else None, "backup": backup}


# ---------------------------------------------------------------- reloading: `:source` and auto_reload (Q58)

def inventory_reload(state, params):
    """`:source` for roster.yml: load it again now. A file that doesn't load keeps the last good Inventory, and
    `error` says why ({message, path, line?, fix}); `changed`: the file differs from what was loaded before.

    Params: none
    Result: `{changed, host_count, error}`: `:source` for `roster.yml`, read again now
    Since: API 8
    """
    before = state.digest
    state.reload()
    cfg = state.inventory()
    return {"changed": state.digest != before, "host_count": len(cfg["hosts"]), "error": broken(state)}


WATCH_EVERY = 0.5           # s: how often the watcher looks at roster.yml while it doesn't change
WATCH_SETTLE = 0.2          # s: how soon it looks again once it did (an outside edit shows within a second)


class Watcher(threading.Thread):
    """Looks at roster.yml every WATCH_EVERY s (WATCH_SETTLE s while a change settles): its size, time and inode, so an editor that saves by writing a new
    file and renaming it over is seen too. A change that has settled (the same for one more look) and differs from
    what serve last loaded (its own writes don't count) is either applied (inventory.watch's auto: reload, then
    `inventory.changed {applied: true, error}`) or only reported once (`{applied: false}`: the app's status bar
    hint, applied by `:source`)."""

    def __init__(self, state):
        super().__init__(daemon=True, name="roster-watch")
        self.state, self.stop = state, threading.Event()

    @staticmethod
    def look(path):
        try:
            st = path.stat()
        except OSError:
            return None
        return st.st_mtime_ns, st.st_size, st.st_ino

    def run(self):
        last = settling = self.look(self.state.path)
        wait = WATCH_EVERY
        while not self.stop.wait(wait):
            now = self.look(self.state.path)
            wait = WATCH_EVERY
            if now == last:
                continue
            if now != settling:                     # still being written: look again soon, once it's settled
                settling = now
                wait = WATCH_SETTLE
                continue
            last = now
            self.changed()

    def changed(self):
        state = self.state
        with state.lock:
            digest = file_digest(state.path)
            if digest is None or digest in (state.digest, state.noticed):
                return
            if state.auto:
                state.reload()
                params = {"applied": True, "error": broken(state)}
            else:
                state.noticed = digest
                params = {"applied": False, "error": None}
            notify = state.notify
        if notify:
            notify("inventory.changed", params)


def inventory_watch(state, params):
    """Start watching roster.yml for outside edits (once), and say whether to apply them (auto, the Config's
    auto_reload) or only report them. Without a notification channel (in-process use) it can't watch.

    Params: `{auto}`
    Result: `{watching, auto, path?}`: start noticing outside edits of `roster.yml`; `auto` (the app's
        `auto_reload`) applies them
    Since: API 8
    """
    auto = params.get("auto", False)
    if not isinstance(auto, bool):
        raise RpcError(INVALID_PARAMS, "params.auto must be true or false")
    state.auto = auto
    if state.notify is None or state.path is None:
        return {"watching": False, "auto": auto}
    with state.watch_lock:                  # two at once start one watcher
        if state.watcher is None:
            state.watcher = Watcher(state)
            state.watcher.start()
    return {"watching": True, "auto": auto, "path": str(state.path)}


METHODS["host.remove"] = host_remove
METHODS["host.rename"] = host_rename
METHODS["host.move"] = host_move
METHODS["group.new"] = group_new
METHODS["group.rename"] = group_rename
METHODS["group.delete"] = group_delete
METHODS["inventory.reload"] = inventory_reload
METHODS["inventory.watch"] = inventory_watch
METHODS["host.scan_key"] = host_scan_key
METHODS["host.trust_key"] = host_trust_key
METHODS["quick.prepare"] = quick_prepare
METHODS["quick.save"] = quick_save
METHODS["host.save_login"] = host_save_login
METHODS["vault.forget_typed"] = vault_forget_typed
METHODS["host.add"] = host_add
METHODS["host.review"] = host_review
METHODS["inventory.pull"] = inventory_pull
METHODS["host.verify_login"] = host_verify_login
METHODS["host.update"] = host_update
METHODS["changes.diff"] = changes_diff
METHODS["changes.discard"] = changes_discard
METHODS["changes.publish"] = changes_publish


# ---------------------------------------------------------------- vault: the lock screen

STATUS_WORDS = {"unauthenticated": "not-logged-in", "missing": "missing-cli"}   # providers' word -> the API's


secret_error = vault_problem          # a provider's SecretError as the error to answer with (safe to show)


referenced_providers = health.referenced_providers


def provider_status(name):
    try:
        status, account = providers.vault_account(name)
    except providers.SecretError as e:
        raise secret_error(e) from None
    return status_result(name, status, account)


def status_result(name, status, account, server=providers.ASK):
    """vault.status's answer for provider NAME from what its CLI said. SERVER: the server it's set to, when that's
    already known (vault.logout: a second `bw status` costs a second), else login_info asks."""
    result = {"provider": name, "status": STATUS_WORDS.get(status, status), "can_write": providers.can_write(name),
              "can_sign_out": providers.can_sign_out(name)}
    if account:
        result["account"] = account
    message = providers.status_message(name, status)
    if status == "unauthenticated" and PROVIDERS[name].get("login_info"):
        try:
            result["sign_in"] = PROVIDERS[name]["login_info"](providers.Ctx(name, None), server)
        except providers.SecretError:
            pass
    return result | ({"message": message} if message else {})


def main_vault(names):
    """The vault to unlock: the most used provider that has a master password, or None."""
    return next((n for n in names if PROVIDERS[n].get("unlock")), None)


def vault_status(state, params):
    """The vault to unlock (main_vault) and where every provider the Inventory uses stands.

    Params: none
    Result: `{provider, status, message?, sign_in?, account?, can_sign_out, save_to?, providers: [{provider,
        status, message?, sign_in?, account?, can_sign_out}, ...]}`
    Since: API 1
    """
    names = referenced_providers(state.inventory())
    lockable = main_vault(names)
    main = provider_status(lockable) if lockable else {"provider": None, "status": "unsupported",
                                                       "can_write": False, "can_sign_out": False}
    others = [main if n == main["provider"] else provider_status(n) for n in sorted(names)]
    if main["can_write"]:                       # where "Save to vault" goes by default (ticket 35), as set
        main = {**main, "save_to": providers.default_target(lockable)}
    return {**main, "providers": others}


def only_vault_unlock_unlocks():
    """The app opens locked and only its lock screen unlocks: forget a BW_PASSWORD / BW_SESSION this process
    inherited, and tell providers not to unlock by themselves (no bw-session file, no prompt)."""
    for var in ("BW_PASSWORD", "BW_SESSION"):
        os.environ.pop(var, None)
    providers.MANUAL_UNLOCK = True


def vault_provider(state, params):
    """params.provider, or the Inventory's vault (vault.status's "provider")."""
    name = params.get("provider")
    if name is None:
        name = main_vault(referenced_providers(state.inventory()))     # no status call: that'd be a `bw` run
        if name is None:
            raise RpcError(UNSUPPORTED, "no Host Login uses a vault with a master password")
    if not isinstance(name, str) or name not in PROVIDERS:
        raise RpcError(INVALID_PARAMS, f"params.provider must be one of: {', '.join(sorted(PROVIDERS))}")
    return name


def vault_unlock(state, params):
    """Unlock with the master password. It goes to the provider through an environment variable; the
    session key stays in this process's memory and is never written to the bw-session file.

    Params: `{password, provider?}`
    Result: `{provider, status: "unlocked"}`
    Errors: 10-13
    Since: API 1
    """
    password = text_param(params, "password")
    name = vault_provider(state, params)
    try:
        providers.unlock(name, password)
    except providers.SecretError as e:
        raise secret_error(e) from None
    except Exception as e:                      # never let the generic handler log text that might hold it
        raise RpcError(INTERNAL_ERROR, f"unlocking {name} failed: {type(e).__name__}") from None
    state.unlocked.add(name)
    return {"provider": name, "status": "unlocked", "can_write": providers.can_write(name)}   # no second `bw status`


ON_VAULT_LOCK = []          # fn(state) run by vault.lock: whatever else holds secrets (askpass tokens) forgets them


def forget_askpass_tokens(state):
    if state.askpass is not None:
        state.askpass.forget()


ON_VAULT_LOCK.append(forget_askpass_tokens)
ON_VAULT_LOCK.append(forget_held)
ON_VAULT_LOCK.append(stop_checks)


def vault_lock(state, params):
    """Forget every cached secret and session key, and run each provider's own lock: the ones vault.unlock
    opened and the ones the Inventory uses. Memory is cleared even if a provider's lock fails. It forgets first and
    then waits for the requests holding a secret (forgotten_for_good): never refused, whatever runs.

    Params: none
    Result: `{locked: [names]}`. Never fails
    Since: API 1
    """
    names = forgotten_for_good(state)
    return {"locked": sorted(n for n in names if PROVIDERS[n].get("lock"))}


def forgotten_for_good(state, signing_out=None, then=None):
    """vault.lock's and vault.logout's order (decision Q112): forget everything at once, so a lookup from now on finds
    the vault locked; then wait, with no limit and never refused, for the requests that already hold a secret, a token
    or a typed password (they share the vault's lock; a waiting lock goes before new ones); then forget again what
    they held or made meanwhile, and run THEN() while still holding it (vault.logout's sign-out). Returns the
    providers locked."""
    names = forget_everything(state, signing_out)
    state.vault.acquire(False, None, "vault.logout" if signing_out else "vault.lock")
    try:
        names |= forget_everything(state, signing_out)
        if then is not None:
            then()
        return names
    finally:
        state.vault.release()


def forget_everything(state, signing_out=None):
    """vault.lock's work: end a sign-in, run every ON_VAULT_LOCK hook, and lock every provider (SIGNING_OUT's only
    in memory: its CLI is about to log out). Returns the providers it locked."""
    names = set(state.unlocked) | (set(referenced_providers(state.cfg)) if state.cfg else set())
    end_sign_in(state)
    for forget in ON_VAULT_LOCK:
        forget(state)
    for name in sorted(names | ({signing_out} if signing_out else set())):
        try:
            providers.lock(name, cli=name != signing_out)
        except providers.SecretError as e:
            print(f"serve: warning: locking {name}: {e}", file=sys.stderr, flush=True)
    state.unlocked.clear()
    return names


def vault_logout(state, params):
    """Sign the vault CLI out of its account, so another can sign in (ticket 42). Everything vault.lock forgets is
    forgotten first (askpass tokens, held typed passwords, session keys, a sign-in in progress), then the CLI logs
    out. Answers with where the vault stands now: not-logged-in, with the ways to sign in again.

    Params: `{provider?}`
    Result: `{provider, status: "not-logged-in", message?, sign_in, can_write, can_sign_out, signed_out: {email,
        server} | null}`
    Errors: 13, 15, 16
    Since: API 14
    """
    name = vault_provider(state, params)
    if not providers.can_sign_out(name):
        raise secret_error(providers.no_account(name))
    try:
        _, account = providers.vault_account(name)
    except providers.SecretError as e:
        raise secret_error(e) from None

    def sign_out():
        try:
            providers.logout(name)
        except providers.SecretError as e:
            raise sign_out_error(e) from None
    forgotten_for_good(state, signing_out=name, then=sign_out)
    # Signed out: no second `bw status` to say so (each bw call takes about a second). The server stays set.
    return {**status_result(name, "unauthenticated", None, server=(account or {}).get("server", providers.ASK)),
            "signed_out": account}


SIGN_OUT_FIXES = {ALREADY_SIGNED_OUT: "sign in from the lock screen",
                  SIGN_OUT_FAILED: "see the message; `roster bw logout` in a terminal shows the same"}


def sign_out_error(e):
    """A failed `bw logout` as vault.logout's error, with the app's fix (the CLI's vault_problem has none)."""
    problem = secret_error(e)
    fix = SIGN_OUT_FIXES.get(problem.code)
    return Problem(problem.code, problem.message, problem.data, fix=fix) if fix else problem


METHODS["vault.status"] = vault_status
METHODS["vault.unlock"] = vault_unlock
METHODS["vault.lock"] = vault_lock
METHODS["vault.logout"] = vault_logout


# ---------------------------------------------------------------- vault.configure: this Box's settings (ticket 41)
# The app sends what its init.lua says about the vault at start and after every `:source`. They're this Box's own
# (a local KeePassXC database is personal, not team Inventory) and win over roster.yml's. Paths and choices only:
# a key that isn't one of these is refused, so nothing else (a secret above all) can ride along. A value roster can't
# use (a relative or Windows path, a save_to of the wrong shape) is refused alone: the other settings still apply.

BOX_PATHS = {"kp": ("database", "key_file")}


def box_path(value, field):
    if not isinstance(value, str) or not value.strip():
        raise RpcError(INVALID_PARAMS, f"params.{field} must be a path")
    if not os.path.isabs(os.path.expanduser(value)):
        raise RpcError(INVALID_PARAMS, f"params.{field} must be an absolute path or start with ~ (a path on the "
                                       f"Box roster runs on): {value!r}")
    return value


def box_settings(params):
    """vault.configure's params as providers.configure_box's {provider: {key: value}}, checked, and the settings
    whose value was refused ([{setting, message}]; each is left out, as if init.lua didn't set it). A key roster
    doesn't take refuses the whole call."""
    box, refused = {}, []

    def take(setting, check, *args):
        try:
            return check(*args)
        except RpcError as e:
            refused.append({"setting": setting, "message": e.message})
            return None
    save_to = take("save_to", save_to_param, params)
    if save_to is not None:
        # init.lua has one save_to; it goes to the provider it fits: a collection is Bitwarden's, a group KeePassXC's
        fits = ("bw", "kp") if save_to == providers.PERSONAL else ("kp",) if "group" in save_to else ("bw",)
        for name in fits:
            box.setdefault(name, {})["save_to"] = save_to
    for name, given in params.items():
        if name == "save_to":
            continue
        if name not in BOX_PATHS:
            raise RpcError(INVALID_PARAMS, f"params.{name} isn't a setting roster takes from init.lua (it takes: "
                                           f"save_to, {', '.join(sorted(BOX_PATHS))})")
        if not isinstance(given, dict):
            raise RpcError(INVALID_PARAMS, f"params.{name} must be an object")
        for key, value in given.items():
            if key not in BOX_PATHS[name]:
                raise RpcError(INVALID_PARAMS, f"params.{name}.{key} isn't a setting roster takes from init.lua "
                                               f"(it takes: {', '.join(BOX_PATHS[name])})")
            setting = f"{name}.{key}"
            path = None if value is None else take(setting, box_path, value, setting)
            if path is not None:
                box.setdefault(name, {})[key] = path
    return box, refused


def vault_configure(state, params):
    """This Box's vault settings from the app's init.lua, replacing the last ones (a key left out is roster.yml's
    again). A KeePassXC database or key file that changed forgets the master password held for the old one:
    `locked` names the providers that were unlocked and now aren't; `refused` the settings left out because roster
    can't use their value.

    Params: `{save_to?, kp?: {database?, key_file?}}`
    Result: `{configured: true, locked: [names], refused: [{setting, message}]}`
    Errors: -32602
    Since: API 10
    """
    box, refused = box_settings(params)
    locked = providers.configure_box(box)
    state.unlocked.difference_update(locked)
    return {"configured": True, "locked": locked, "refused": refused}


METHODS["vault.configure"] = vault_configure


# ---------------------------------------------------------------- vault.create_item: "Save to vault" (ticket 13)
# Q43's order is verify, create the Vault item, add the Pending change; if the add fails, vault.undo_create takes
# the item back out. It only deletes items this serve created, so it can't be pointed at anything else.

def vault_create_item(state, params):
    """Create a login Vault item: name, username, password, and the address in its URI field. Refuses a name
    that's already there (code 60). The password goes to the provider on stdin; it's never answered back.

    Params: `{name, password, username?, uri?, provider?, save_to?}`
    Result: `{provider, id, name, target}`
    Errors: 14, 60-62, 64, 65
    Since: API 4
    """
    name, password = text_param(params, "name"), text_param(params, "password")
    extra = {k: params.get(k) or "" for k in ("username", "uri")}
    if not all(isinstance(v, str) for v in extra.values()):
        raise RpcError(INVALID_PARAMS, "params.username and params.uri must be strings")
    provider = vault_provider(state, params)
    save_to = save_to_param(params)
    try:
        with item_writes(provider):
            made = providers.create_item(provider, name=name, password=password, save_to=save_to, **extra)
    except RpcError:
        raise
    except providers.SecretError as e:
        raise write_problem(e) from None
    except Exception as e:                      # never let the generic handler log text that might hold it
        raise RpcError(INTERNAL_ERROR, f"saving to {provider} failed: {type(e).__name__}") from None
    state.created[made["id"]] = provider
    return {"provider": provider, **made}


def vault_undo_create(state, params):
    """Delete an item vault.create_item made in this serve (Q43's undo). Bitwarden moves it to the trash.

    Params: `{id}` (from `vault.create_item`)
    Result: `{provider, id}`
    Errors: 14, 62, 63
    Since: API 4
    """
    item_id = text_param(params, "id")
    provider = state.created.pop(item_id, None)     # taken at once: two undos at once delete it once
    if provider is None:
        raise RpcError(NOT_CREATED_HERE, f"item {item_id} wasn't created by this roster serve (or is already "
                       "undone) - roster only takes back the items it just saved")
    try:
        with item_writes(provider, UNDO_TIME):
            providers.delete_item(provider, item_id)
    except BaseException as e:
        state.created[item_id] = provider       # not known to be deleted: it can be undone again
        if isinstance(e, RpcError):
            raise
        if isinstance(e, providers.SecretError):
            raise write_problem(e) from None
        if not isinstance(e, Exception):
            raise
        # never let the generic handler log text that might hold a secret
        raise RpcError(INTERNAL_ERROR, f"deleting from {provider} failed: {type(e).__name__}") from None
    return {"provider": provider, "id": item_id}


def vault_targets(state, params):
    """Where "Save to vault" can put an item (ticket 35): the personal vault and every collection of the organizations
    you're in (Bitwarden), or the top level and every group (KeePassXC), and the default. A default that doesn't
    resolve doesn't fail the list: `default` is null and `problem` says why (code 64 or 65, its message names the
    setting). Needs the vault unlocked (14).

    Params: `{provider?}`
    Result: `{provider, targets: [{id, kind, label, organization?, collection?, save_to}], default, from,
        problem}`
    Errors: 14
    Since: API 10
    """
    provider = vault_provider(state, params)
    try:
        found = providers.save_targets(provider)
    except providers.SecretError as e:
        raise write_problem(e) from None
    problem = found["problem"] and write_problem(found["problem"])
    return {"provider": provider, **found,
            "problem": problem and {"code": problem.code, "message": problem.message, "fix": problem.data["fix"]}}


METHODS["vault.create_item"] = vault_create_item
METHODS["vault.undo_create"] = vault_undo_create
METHODS["vault.targets"] = vault_targets


# ---------------------------------------------------------------- vault.login: signing in (ticket 31)

SIGN_IN_IDLE = 600          # s: a sign-in nobody answers for this long is ended (and forgets the password it held)
SIGN_IN_METHODS = {"password": ("email", "password"), "apikey": ("client_id", "client_secret"), "sso": ()}
ANSWERS = {"two_factor_code": "code", "new_device_code": "code", "master_password": "password"}


class SignIn:
    def __init__(self, provider, flow):
        self.id, self.provider, self.flow = secrets.token_hex(8), provider, flow


def end_sign_in(state):
    """Stop the sign-in in progress (its CLI process too) and forget what it held."""
    login, state.login = state.login, None
    if login is not None:
        login.flow.close()


def sign_in_step(state, login, fn):
    """Run one step. A failure that says where to carry on keeps the sign-in; any other ends it."""
    try:
        step = fn()
    except providers.SecretError as e:
        if getattr(e, "step", None) is None:
            end_sign_in(state)
        raise sign_in_problem(e, login.id) from None
    except (KeyError, TypeError, ValueError) as e:      # an answer that doesn't fit the step: the step stays
        raise RpcError(INVALID_PARAMS, f"vault.login: {e}" if isinstance(e, ValueError) else
                       "vault.login: params don't fit the step") from None
    except Exception as e:                      # never let the generic handler log text that might hold a secret
        end_sign_in(state)
        raise RpcError(INTERNAL_ERROR, f"signing in to {login.provider} failed: {type(e).__name__}") from None
    if step["step"] == "done":
        state.unlocked.add(login.provider)
        end_sign_in(state)
    return {**step, "login": login.id}


def vault_login(state, params):
    """Sign the vault CLI in on this box, a step at a time (docs/serve-api.md "Signing in: vault.login").
    action "start" (the default) begins a new one, "answer" answers the current step, "cancel" stops it.
    Secrets arrive as values, go to the CLI through env vars or its own prompts, and are never echoed.

    Params: `{action: "start", method: "password", email, password, server?, provider?}`
    Result: the first step
    Errors: 10, 12, 13, 51-54, 57, 59
    Since: API 3
    Params: `{action: "start", method: "apikey", client_id, client_secret, server?}`
    Result: `master_password`
    Errors: 12, 13, 52-54, 57-59
    Since: API 3
    Params: `{action: "start", method: "sso", identifier?, server?}`
    Result: `sso`
    Errors: 12, 13, 51, 53, 54, 56, 57, 59
    Since: API 3
    Params: `{action: "answer", login, ...the step's answer}`
    Result: the next step
    Errors: 10, 50-53, 55, 56, 59
    Since: API 3
    Params: `{action: "cancel"}`
    Result: `{cancelled: true | false}`
    Since: API 3
    """
    action = params.get("action", "start")
    if action == "cancel":
        cancelled = state.login is not None
        end_sign_in(state)
        return {"cancelled": cancelled}
    if action == "answer":
        login = state.login
        if login is None or params.get("login") != login.id:
            raise RpcError(NO_SIGN_IN, "no sign-in in progress (it finished, was cancelled or timed out) - "
                                       "start again", fix="start the sign-in again")
        if time.monotonic() - login.flow.touched > SIGN_IN_IDLE:
            end_sign_in(state)
            raise RpcError(NO_SIGN_IN, f"the sign-in timed out ({SIGN_IN_IDLE // 60} minutes without an answer) "
                                       "- start again", fix="start the sign-in again")
        key = ANSWERS.get(login.flow.step["step"])
        if key:
            text_param(params, key)
        return sign_in_step(state, login, lambda: login.flow.answer(params))
    if action != "start":
        raise RpcError(INVALID_PARAMS, "params.action must be start, answer or cancel")
    method = params.get("method", "password")
    if method not in SIGN_IN_METHODS:
        raise RpcError(INVALID_PARAMS, f"params.method must be one of: {', '.join(SIGN_IN_METHODS)}")
    for key in SIGN_IN_METHODS[method]:
        text_param(params, key)
    for key in ("server", "identifier"):
        if params.get(key) is not None and not isinstance(params[key], str):
            raise RpcError(INVALID_PARAMS, f"params.{key} must be a string")
    end_sign_in(state)
    name = vault_provider(state, params)
    try:
        flow = providers.login(name)
    except providers.SecretError as e:
        raise sign_in_problem(e) from None
    state.login = login = SignIn(name, flow)
    closing(state, login)
    step = sign_in_step(state, login, lambda: flow.start({**params, "method": method}))
    closing(state, login)
    return step


def closing(state, login):
    """A sign-in that started (or took a step) while serve was closing ends now: its `bw login` mustn't outlive serve
    with the credentials in its environment."""
    if state.closing:
        if state.login is login:
            end_sign_in(state)
        else:
            login.flow.close()
        raise closing_error()


METHODS["vault.login"] = vault_login


# ---------------------------------------------------------------- the Mesh (ticket 39, decision Q63)
# Host-to-Host access set up from this Box (mesh.py). The app's controls for it are a first-party Plugin (T50).

def rotate_param(params):
    v = params.get("rotate", [])
    if not isinstance(v, list) or not all(isinstance(x, str) and x for x in v):
        raise RpcError(INVALID_PARAMS, "params.rotate must be a list of Host names")
    return v


def background_param(params):
    v = params.get("background", False)
    if not isinstance(v, bool):
        raise RpcError(INVALID_PARAMS, "params.background must be true or false")
    return v


def brief_param(params):
    v = params.get("brief", False)
    if not isinstance(v, bool):
        raise RpcError(INVALID_PARAMS, "params.brief must be true or false")
    return v


def mesh_view(job, brief=False):
    """mesh.job's answer for JOB (a jobs.Job of kind mesh): as API 17 had it, `state` running, done or failed, and
    `stopped` when it was asked to stop (a stopped job is done, with its Hosts not visited pending)."""
    v = job.view()
    out = {"job": job.job, "action": job.action, "state": "running" if job.running() else
           "failed" if job.error is not None else "done", "done": v["done"], "total": v["total"], "at": v["at"],
           "stopped": job.halted.is_set()}
    if job.host is not None:
        out["host"] = job.host
    if out["state"] == "done":
        result = job.result
        out["result"] = mesh.brief(result) if brief and isinstance(result, dict) and "links" in result else result
    elif out["state"] == "failed":
        out["error"] = job.error
    return out


def busy_mesh(job):
    return RpcError(MESH_BUSY, f"a Mesh {job.action} is still running (job {job.job}): wait for it, or stop it",
                    {"job": job.job, "action": job.action})


def mesh_idle(state):
    """Problem 111 while a Mesh job runs: two runs at once would fight over the Hosts and mesh.json."""
    job = state.jobs.latest("mesh")
    if job is not None and job.running():
        raise busy_mesh(job)


def start_mesh_job(state, action, total, work, host=None, background=True):
    """Runs WORK(job) as a Mesh job. In the background it answers at once: `{job, action, total, host?}`; else it
    waits for the job (under this request's deadline) and answers with its result, or its error."""
    at = None if background else current_deadline()

    def run(job):
        with deadline_at(at):                   # a background job has no deadline (nothing waits for it)
            return work(job)
    try:
        job = state.jobs.start("mesh", action, run, total=total, host=host, on_close=mesh.close)
    except jobs.Busy as e:
        raise busy_mesh(e.job) from None
    except jobs.Closed:
        raise closing_error() from None
    if not background:
        on_cancel(job.stop)                     # $/cancel stops it at its next Host, as mesh.stop would
        job.wait()
        if job.error is not None:
            raise RpcError(job.error["code"], job.error["message"], job.error.get("data"))
        return job.result
    return {"job": job.job, "action": action, "total": total, **({"host": host} if host else {})}


def mesh_run(state, params, apply):
    """mesh.plan and mesh.apply: waiting for the result, or (background: true) answering at once. A job either way."""
    rotate, background = rotate_param(params), background_param(params)
    mesh_idle(state)
    cfg = state.fresh()
    visits = mesh.visits_of(cfg, mesh.with_mesh_dirs(cfg))     # once: a big meshed group's graph is every pair
    g, _, _, _, _, hop_only, hosts = visits
    mesh.check_rotate(g, rotate)                # refused at once, as without background
    return start_mesh_job(state, "apply" if apply else "plan", len(g["sources"]) + len(hop_only) + len(hosts),
                          lambda job: mesh.run(cfg, apply=apply, rotate=rotate, progress=job.progress,
                                               stopped=job.halted.is_set, visits=visits),
                          background=background)


def mesh_plan(state, params):
    """The Mesh roster.yml asks for against what the Hosts hold now: read-only, one connection at a time.

    Params: `{rotate?: [host], background?: bool}` (`background` since API 17)
    Result: a Mesh result with `applied: false`: what `mesh.apply` would do. Changes nothing anywhere. With
        `background: true`, `{job, action, total}` at once, and the result comes in `mesh.job`
    Errors: 1, 110, 111
    Since: API 15
    """
    return mesh_run(state, params, apply=False)


def mesh_apply(state, params):
    """Make the Mesh what roster.yml says, one connection at a time; Hosts that don't answer stay pending.

    Params: `{rotate?: [host], background?: bool}` (`background` since API 17)
    Result: a Mesh result with `applied: true`; `rotate` replaces those sources' keys everywhere. With
        `background: true`, `{job, action, total}` at once, and the result comes in `mesh.job`
    Errors: 1, 110, 111
    Since: API 15
    """
    return mesh_run(state, params, apply=True)


def mesh_cut(state, params):
    """Take a Host out of the Mesh now, on every Host at once (mesh.cut), then write mesh: false for it as a
    Pending change (mesh.write_cut). `pending`: Hosts that didn't confirm, warned about until they're done.

    Params: `{host, background?: bool}` (`background` since API 17)
    Result: `{host, confirmed: [host], pending: {host: why}, warnings: [text], change}`: HOST's key off every peer
        and every peer's off HOST, at once. `warnings` (since API 24): what roster left on HOST's own side, an
        earlier `mesh_dir:` that still holds a Mesh key (roster never removes one), one sentence each. `change` is the `mesh: false` written for HOST as a Pending change: `{written: true,
        backup}` (`backup: null` and a `note` when `roster.yml` isn't in a git repo), `{written: false, note}` when
        it already was, or `{written: false, error, fix}` when it couldn't be written (the cut still happened).
        With `background: true`, `{job, action, total, host}` at once, and the result comes in `mesh.job`
    Errors: 1, 2, 111
    Since: API 15
    """
    name = text_param(params, "host")
    background = background_param(params)
    mesh_idle(state)
    cfg = state.fresh()
    if name not in cfg["hosts"]:
        raise RpcError(UNKNOWN_HOST, f"unknown host {name!r}")

    def work(job):
        result = mesh.cut(cfg, name, cfg["workers"], progress=job.progress, stopped=job.halted.is_set)
        try:                                    # roster.yml's lock, as any other write, waited for only so long
            with claimed(state, [("inventory", False)], "mesh.cut"):
                result["change"] = mesh.write_cut(state.fresh(), name)
                state.reload()
        except RpcError as e:
            if e.code != BUSY:
                raise
            result["change"] = {"written": False, "error": e.message,
                                "fix": f"write mesh: false for {name} in roster.yml, or run the cut again"}
        return result
    return start_mesh_job(state, "cut", len(mesh.cut_hosts(cfg, name)), work, host=name, background=background)


def mesh_job(state, params):
    """How the latest Mesh job is getting on: polled by the Mesh controls Plugin, never connects.

    Params: `{job?, brief?: bool}`
    Result: `{job, action, host?, state, done, total, at, stopped, result?, error?}`, or `null` when there's no job
        (or `job` isn't the latest). `state` is `running`, `done` (with `result`, as the method itself returns it;
        `brief` makes a plan's or apply's as small as `mesh.status`'s brief) or
        `failed` (with `error`: `{code, message, data?}`, as an error response's). `done` of `total` Hosts so far;
        `at` the Host it's on. `stopped`: `mesh.stop` asked it to stop; the Hosts it hadn't got to are pending
    Since: API 17
    """
    job = state.jobs.latest("mesh")
    want = params.get("job")
    if job is None or (want is not None and want != job.job):
        return None
    return mesh_view(job, brief=brief_param(params))


def mesh_stop(state, params):
    """Stop a Mesh job before its next Host: the Hosts not yet visited are pending, and the next run finishes them.

    Params: `{job}`
    Result: `{job, stopping}`: `stopping: false` when that job isn't running (over already, or not the latest)
    Since: API 17
    """
    want = params.get("job")
    if not isinstance(want, int) or isinstance(want, bool):
        raise RpcError(INVALID_PARAMS, "params.job must be a job's number (mesh.job)")
    return {"job": want, "stopping": state.jobs.stop("mesh", want)}


def mesh_status(state, params):
    """No connections: who reaches whom, what's pending, and whether the Mesh is out of date on this Box.

    Params: `{brief?: bool, grouped?: bool}` (`brief` since API 17, `grouped` since API 19)
    Result: `{links, excluded, reach, members, pending, cut_pending, out_of_date}`: the Links as `roster.yml` asks
        for them (no `status`), `members` the Hosts roster visits, `out_of_date: true` when `roster.yml` changed the
        Mesh since the last complete apply on this Box. `brief: true` keeps it small when every pair of hundreds of
        Hosts is a Link: `links` only those worth a look (with a `via`, `no-via` marked), at most 1000
        (`links_more` counts the rest), and `link_count`, `link_statuses` and `reached` for the rest. `grouped: true`
        (for a map, such as the Topology Plugin's, that draws who reaches whom) keeps every Link but says each
        meshed group once: `meshed: {group: [host]}`, the Hosts of each meshed group that reach each other both
        ways (two or more, in `roster.yml` order), and `links` without the pairs those cover, so 2,000 meshed
        Hosts are 2,000 names, not 98,000 Links. Not with `brief`
    Errors: -32602
    Since: API 15
    """
    grouped = (params or {}).get("grouped", False) if isinstance(params, dict) else False
    if not isinstance(grouped, bool):
        raise RpcError(INVALID_PARAMS, "params.grouped must be true or false")
    if grouped and brief_param(params):
        raise RpcError(INVALID_PARAMS, "params.grouped and params.brief don't go together")
    out = mesh.status(state.inventory(), grouped=grouped)
    return mesh.brief(out) if brief_param(params) else out


METHODS["mesh.plan"] = mesh_plan
METHODS["mesh.apply"] = mesh_apply
METHODS["mesh.cut"] = mesh_cut
METHODS["mesh.status"] = mesh_status
METHODS["mesh.job"] = mesh_job
METHODS["mesh.stop"] = mesh_stop


# ---------------------------------------------------------------- Discover (ticket 44, decisions Q80 and Q100)
# `roster discover` for the app: a scan that runs here, on a thread of its own (discover.Scan), never in the app or
# a Plugin. discover.start answers at once; discover.status says how far it has got and what it found, discover.stop
# ends it, and discover.add writes the Hosts the user picked as a Pending change, unreviewed, as `roster discover
# --write` would. The app's UI for it is the first-party Plugin plugins/discover.

def scan_params(params):
    """(targets, how many addresses, ports) from params, checked: -32602 for a bad one, 121 for too many."""
    force = params.get("force", False)
    if not isinstance(force, bool):
        raise RpcError(INVALID_PARAMS, "params.force must be true or false")
    try:
        targets, count = discover.check_targets(params.get("targets"), force)
        ports = discover.check_ports(params.get("ports"))
    except discover.TooMany as e:
        raise RpcError(TOO_MANY_ADDRESSES, f"that's {e.count:,} addresses; a scan visits at most {e.limit:,}"
                       + ("" if force else " without force"),
                       {"addresses": e.count, "limit": discover.LIMIT, "max": discover.MAX},
                       fix="scan a smaller range, or confirm the larger scan (force)") from None
    except ValueError as e:
        raise RpcError(INVALID_PARAMS, f"params: {e}") from None
    return targets, count, ports


def the_scan(state, params):
    """The scan params.scan names (the latest if it names none), or 122."""
    sid = params.get("scan")
    scan = state.scan
    if scan is None or (sid is not None and sid != scan.sid):
        raise RpcError(NO_SCAN, "no scan has started in this roster serve" if scan is None
                       else f"no scan {sid!r} here: the latest is {scan.sid}",
                       fix="start one with discover.start")
    return scan


def discover_plan(state, params):
    """What a scan of `targets` would visit, and with what. Starts nothing, connects nowhere.

    Params: `{targets: [network], ports?, force?}`: networks or addresses (`10.0.0.0/24`); `ports` a list such as
        `"22,80,443"` (`roster discover`'s default list if left out); `force` allows up to `max` addresses
    Result: `{targets, addresses, ports, scanner, limit, max}`: the targets as written back (without one another
        covers: an address is visited once), how many addresses they hold, how many ports, `"nmap"` or
        `"built-in"` (no nmap: roster's own TCP connect scan), and the most addresses without and with `force`
        (4,096 and 65,536)
    Errors: -32602, 121
    Since: API 18
    """
    targets, count, ports = scan_params(params)
    return {"targets": targets, "addresses": count, "ports": len(ports.split(",")), "scanner": discover.scanner(),
            "limit": discover.LIMIT, "max": discover.MAX}


def discover_start(state, params):
    """Start scanning `targets` from this Box, in the background: it answers at once. One scan at a time.

    Params: as `discover.plan`
    Result: the new scan's `discover.status`: `{scan, state: "running", targets, scanner, done: 0, total, ...}`
    Errors: 1, -32602, 120, 121
    Since: API 18
    """
    targets, _, ports = scan_params(params)
    cfg = state.inventory()
    known = {h["ip"]: h["name"] for h in cfg["hosts"].values()}
    with state.scan_lock:                       # one id per scan, and state.scan always the latest's
        scan = discover.Scan(f"scan-{state.scans + 1}", targets, ports, discover.scanner(), known, set(cfg["hosts"]))

        def work(job):
            scan.on_progress = job.progress
            scan.run()
            if scan.error:
                raise jobs.Failed(ROSTER_ERROR, scan.error)
            return {"count": len(scan.found)}
        try:
            state.jobs.start("discover", "scan", work, total=scan.total, job=scan.sid, on_stop=scan.stop)
        except jobs.Busy:
            going = state.scan
            raise RpcError(SCAN_RUNNING, f"a scan of {', '.join(going.targets)} is going already",
                           {"scan": going.sid}, fix="wait for it, or stop it first (discover.stop)") from None
        except jobs.Closed:
            raise closing_error() from None
        state.scans += 1
        state.scan = scan
    return scan.status()


def discover_status(state, params):
    """How far the scan has got, and what it has found.

    Params: `{scan?, since?}`: the scan's id (the latest if left out); `since` skips the first that many found
    Result: `{scan, state, targets, scanner, done, total, count, quiet, found: [Found], error}`. `state` is
        `running`, `stopping`, `done`, `stopped` or `failed` (`error` says why); `done` of `total` addresses
        visited; `count` how many were found in all (pass it as the next `since`); `quiet` how many answered with
        none of the ports open (nmap only: the built-in scanner can't tell a quiet Host from no Host, so it's 0
        there). A Found is `{address, name, type, hostname, title, web, known, added, vendor, os, mac, ports:
        [{port, name, product, title}]}`: `name` the name it would be added as (`null` when `known`
        names the Host already at that address), `type` the guessed kind, `added` the name `discover.add` gave it
    Errors: -32602, 122
    Since: API 18
    """
    since = params.get("since", 0)
    if not isinstance(since, int) or isinstance(since, bool) or since < 0:
        raise RpcError(INVALID_PARAMS, "params.since must be a count (0 or more)")
    return the_scan(state, params).status(since)


def discover_stop(state, params):
    """Stop the scan: what it found so far stays.

    Params: `{scan?}`
    Result: `{scan, stopping}`: `stopping: false` when it had ended already. `discover.status` says `stopped` once
        it has
    Errors: 122
    Since: API 18
    """
    scan = the_scan(state, params)
    return {"scan": scan.sid, "stopping": state.jobs.stop("discover", scan.sid)}


def discover_add(state, params):
    """Add Hosts the scan found to roster.yml in a new group, unreviewed, as a Pending change (as `roster discover
    --write` writes them, with the names `discover.status` showed). Nothing else changes.

    Params: `{scan, addresses: [address], group?}`: `group` is new (`discovered-YYYYMMDD` if left out)
    Result: `{group, added: [{address, name}], backup}`
    Errors: 1, -32602, 70, 74, 100, 122, 123
    Since: API 18
    """
    scan = the_scan(state, {"scan": text_param(params, "scan")})
    addresses = params.get("addresses")
    if not isinstance(addresses, list) or not addresses or not all(isinstance(a, str) and a for a in addresses):
        raise RpcError(INVALID_PARAMS, "params.addresses must be a list of the addresses to add")
    group = params.get("group")
    if group is not None:
        group = name_param(params, "group")
        if not edit.NAME_RE.match(group):
            raise RpcError(INVALID_PARAMS, f"bad group name {group!r} (use letters, digits, . _ -)")
    repo = live_repo(state)
    cfg = state.cfg
    try:
        picked = scan.picked(addresses)
    except ValueError as e:
        bad = e.args[0]
        raise RpcError(CANT_ADD, f"{', '.join(bad)}: not found by this scan, or in the Inventory already",
                       {"addresses": bad}, fix="pick from the scan's new Hosts") from None
    ips = {h["ip"] for h in cfg["hosts"].values()}
    there = [r["address"] for _, r in picked if r["address"] in ips]
    if there:
        raise RpcError(CANT_ADD, f"{', '.join(there)}: in the Inventory already", {"addresses": there},
                       fix="pick from the scan's new Hosts")
    today = scan.today
    if group is None:
        group = discover.unique(f"discovered-{today.replace('-', '')}", set(cfg["groups"]) | set(cfg["hosts"]))
    elif group in cfg["groups"] or group in cfg["hosts"]:
        kind = "group" if group in cfg["groups"] else "Host"
        raise RpcError(NAME_TAKEN, f"{group} is a {kind}'s name already", {"kind": kind},
                       fix="name a new group")
    old_text = edit.read_text(repo.path)
    try:
        new_text, added = discover.added_text(old_text, group, picked, scan.targets, today, set(cfg["hosts"]))
    except SystemExit as e:
        raise RpcError(INVALID_EDIT, die_message(e)) from None
    after = edit.load_text(repo.path, new_text)
    names = [a["name"] for a in added]
    if any(after["hosts"].get(n) != cfg["hosts"].get(n) for n in cfg["hosts"]) or \
            any(n not in after["hosts"] or after["hosts"][n]["group"] != group for n in names):
        raise RpcError(INVALID_EDIT, "the result loads differently than asked: nothing was written")
    backup = write_edit(state, old_text, new_text)
    scan.mark_added({a["address"]: a["name"] for a in added})
    return {"group": group, "added": added, "backup": backup}


METHODS["discover.plan"] = discover_plan
METHODS["discover.start"] = discover_start
METHODS["discover.status"] = discover_status
METHODS["discover.stop"] = discover_stop
METHODS["discover.add"] = discover_add


# ---------------------------------------------------------------- the loop

# Each long method's overall deadline (s). The app waits longer for each (app/src-tauri/src/lib.rs CALL_SECS),
# at least the deadline plus AFTER_DEADLINE: a few steps still run once it's past (a 1 s floor each, up to 15 s
# to check what a step that timed out did: changes.CHECK_TIMEOUT, bitwarden's lookup after a create; and UNDO_TIME
# to take a new Vault item back out). So serve
# always answers before the app gives up, and the answer says what happened. Other methods: the app's 60 s.
DEADLINES = {"host.add": 100, "changes.publish": 110, "inventory.pull": 45, "host.check": 45,
             "host.verify_login": 45, "vault.create_item": 45, "quick.save": 45,
             "host.save_login": 45, "box.check": 45, "mesh.plan": 240, "mesh.apply": 240, "mesh.cut": 60}
AFTER_DEADLINE = 40
UNDO_TIME = 15              # s: taking a new Vault item back out gets this much, even past the deadline


# ---------------------------------------------------------------- jobs (ticket 101, decision Q112)

def jobs_list(state, params):
    """The background jobs: each kind's latest, running or not (a Mesh run, a scan; each Host's latest check). Never connects.

    Params: none
    Result: `{jobs: [{kind, job, action, state, done, total, at, host?, error?}]}`: `kind` is `mesh`,
        `discover` or `check` (API 21), `job` its id there (the Mesh's job number, the scan's `scan-N`, the
        check's `check-N`), `host` the Host a check checks, `state` `running`, `stopping`, `done`, `stopped`
        or `failed`. The same shape as the `job.progress` notification
    Since: API 20
    """
    return {"jobs": state.jobs.list()}


def jobs_stop(state, params):
    """Stop a job, as `mesh.stop` or `discover.stop` would, or a Host's check at its next step.

    Params: `{kind, job}`
    Result: `{kind, job, stopping}`: `stopping: false` when that job isn't running (over, or not the latest)
    Errors: -32602
    Since: API 20
    """
    kind = text_param(params, "kind")
    job = params.get("job")
    if not isinstance(job, (int, str)) or isinstance(job, bool):
        raise RpcError(INVALID_PARAMS, "params.job must be a job's id (jobs.list)")
    return {"kind": kind, "job": job, "stopping": state.jobs.stop(kind, job)}


METHODS["jobs.list"] = jobs_list
METHODS["jobs.stop"] = jobs_stop


# ---------------------------------------------------------------- locks (ticket 101, decision Q112)

class Lock:
    """A resource's lock: held alone (a write), or shared by readers. Reentrant for the thread holding it alone, so a
    write may reload. A waiting writer goes before new readers. It knows which request holds it, to say so."""

    def __init__(self, name):
        self.name = name
        self.cond = threading.Condition()
        self.owner, self.depth, self.readers, self.writers_waiting = None, 0, 0, 0
        self.holders = {}                       # thread -> the method holding it

    def acquire(self, shared=False, timeout=None, who=None, cancel=None):
        """Wait up to TIMEOUT s (None: no limit) for it: False if it wasn't free by then, or CANCEL (an Event) was
        set meanwhile ($/cancel wakes every lock's waiters: wake())."""
        me = threading.get_ident()
        end = None if timeout is None else time.monotonic() + timeout
        with self.cond:
            if self.owner == me:
                self.depth += 1
                return True

            def wait(blocked):
                while blocked():
                    left = None if end is None else end - time.monotonic()
                    if (left is not None and left <= 0) or (cancel is not None and cancel.is_set()):
                        return False
                    self.cond.wait(left)
                return True
            if shared:
                if not wait(lambda: self.owner is not None or self.writers_waiting):
                    return False
                self.readers += 1
            else:
                self.writers_waiting += 1
                try:
                    if not wait(lambda: self.owner is not None or self.readers):
                        return False
                finally:
                    self.writers_waiting -= 1
                    self.cond.notify_all()      # the readers it held back go ahead if it gave up
                self.owner, self.depth = me, 1
            self.holders[me] = who
            return True

    def release(self):
        me = threading.get_ident()
        with self.cond:
            if self.owner == me:
                self.depth -= 1
                if self.depth:
                    return
                self.owner = None
            else:
                self.readers -= 1
            self.holders.pop(me, None)
            self.cond.notify_all()

    def wake(self):
        """Its waiters look again: one whose request was cancelled gives up."""
        with self.cond:
            self.cond.notify_all()

    def holder(self):
        with self.cond:
            return next((m for m in self.holders.values() if m), None)

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()


# What each method claims, in this order (never the other way round, so two requests can't wait for each other):
# "inventory" (roster.yml, its repo, the loaded Inventory: every write, for its whole request) and "vault" (shared:
# it looks a secret up, makes an item, or mints an askpass token; alone: it unlocks, signs in, configures). A method
# not listed claims nothing: it reads what's in memory, or does its own locking (a reload, a job's write,
# host.verify_login's vault after its reload, vault.lock's wait).
LOCKS = {
    **{m: [("inventory", False)] for m in (
        "host.update", "host.remove", "host.rename", "host.move", "host.review", "group.new", "group.rename",
        "group.delete", "discover.add", "changes.diff", "changes.discard", "changes.publish", "inventory.pull",
        "inventory.reload")},
    **{m: [("inventory", False), ("vault", True)] for m in ("host.add", "quick.save", "host.save_login")},
    **{m: [("vault", True)] for m in (
        "session.prepare", "session.fill", "quick.prepare", "vault.status", "vault.targets", "vault.create_item",
        "vault.undo_create")},
    # vault.lock and vault.logout aren't here: they forget first and then wait, never refused (vault_lock); nor is
    # host.check: its job shares the vault (check_job), not the request waiting for it
    **{m: [("vault", False)] for m in ("vault.unlock", "vault.login", "vault.configure")},
}
LOCK_WAIT = 50              # s: the longest a method without a deadline waits for a lock (the app waits 60 s)
NAMES = {"inventory": "roster.yml", "vault": "the vault"}


class claimed:
    """Hold CLAIMS ([(resource, shared)]) for METHOD, each waited for at most what's left of its deadline (LOCK_WAIT
    without one); one that isn't free by then is 4, and nothing was done."""

    def __init__(self, state, claims, method):
        self.state, self.claims, self.method, self.held = state, claims, method, []

    def __enter__(self):
        at = current_deadline()
        cancel = waiting_cancel()
        for resource, shared in self.claims:
            lock = self.state.lock if resource == "inventory" else self.state.vault
            wait = LOCK_WAIT if at is None else max(0.0, at - time.monotonic())
            if not lock.acquire(shared, wait, self.method, cancel):
                self.__exit__()
                if cancel is not None and cancel.is_set():
                    raise cancelled(self.method)
                raise busy_error(resource, lock.holder())
            self.held.append(lock)
        return self

    def __exit__(self, *exc):
        while self.held:
            self.held.pop().release()


# ---------------------------------------------------------------- cancelling a request (ticket 108, decision Q112 (p))
# `$/cancel {id}` (the core sends it when it gives up waiting) stops a request that hasn't done anything yet: still
# queued, or waiting for a lock or for an unlock asked before it. It's answered "cancelled" (5) and nothing was done.
# Once a request runs, only the waiting forms of jobs stop (their job stops at its next step, as jobs.stop would);
# anything else runs to its end, so nothing is half-written, and the app's check after a timeout sees what it did.
# Locking is never cancelled (Q112 (k)).

NEVER_CANCELLED = {"vault.lock", "vault.logout", "$/cancel"}
CANCEL_RUNNING = {"host.check", "mesh.plan", "mesh.apply", "mesh.cut"}     # each registers on_cancel(its job's stop)
UNLOCK_LANE = {"vault.unlock"}  # a worker of its own: never queued behind 8 busy ones (Q112 (r))
_request = threading.local()    # the Request this worker thread is answering
MOVED = threading.Condition()   # notified when a request ends or is cancelled (vault.status waits on it)


class Request:
    """One request serve was sent, from submit until it's answered: where it is (`queued`, `waiting` for its locks,
    `running`) and whether it was cancelled."""

    def __init__(self, req):
        self.req = req
        self.method = req.get("method") if isinstance(req, dict) else None
        self.phase = "queued"
        self.cancelled = threading.Event()  # set while queued or waiting: it gives up, nothing done
        self.finished = threading.Event()   # answered, or cancelled before it started
        self.lock = threading.Lock()
        self.stop = None                    # on_cancel's fn, once a running request registered one
        self.asked = False                  # a cancel came while it ran (and it's in CANCEL_RUNNING)
        self.after = []                     # vault.status: the unlocks asked before it, to wait for


def current_request():
    return getattr(_request, "current", None)


def waiting_cancel():
    """The cancel Event of the request this thread answers while it waits for its locks, or None."""
    r = current_request()
    return r.cancelled if r is not None and r.phase == "waiting" else None


def cancelled(method):
    return RpcError(CANCELLED, f"{method} was cancelled before it did anything")


def on_cancel(fn):
    """A running request in CANCEL_RUNNING says how it stops: FN() (a job's stop). Run at once if a cancel came
    before this."""
    r = current_request()
    if r is None:
        return
    with r.lock:
        r.stop = fn
        asked = r.asked
    if asked:
        fn()


def started_running():
    """The request this thread answers has its locks: from now on a cancel doesn't stop it (unless CANCEL_RUNNING).
    Cancelled while waiting: 5, and nothing was done."""
    r = current_request()
    if r is None:
        return
    with r.lock:
        if r.cancelled.is_set():
            raise cancelled(r.method)
        r.phase = "running"


def after_unlocks(state, method):
    """vault.status waits for the unlocks asked before it, queued or running, so it never answers "locked" with an
    unlock still on its way (the app's check after a timed-out unlock). At most what's left of its deadline
    (LOCK_WAIT): then 4. A cancelled one is over at once."""
    r = current_request()
    if r is None or not r.after:
        return
    at = current_deadline()
    end = time.monotonic() + LOCK_WAIT if at is None else at
    with MOVED:
        while not all(u.finished.is_set() for u in r.after):
            left = end - time.monotonic()
            if r.cancelled.is_set():
                raise cancelled(method)
            if left <= 0:
                raise busy_error("vault", "vault.unlock")
            MOVED.wait(left)


def cancel_request(state, params):
    """Cancel a request sent earlier, by its `id` (ticket 108). Sent as a notification (no `id` of its own), as the
    app's core does when it gives up waiting, it gets no answer. It's answered at once, ahead of every worker. A
    request still queued, or waiting for a lock, never runs: it answers `5` and nothing was done. A running
    `host.check` or a Mesh run waiting for its job stops its job at the next step, as `jobs.stop` would. Anything
    else that runs finishes (nothing is half-written), and `vault.lock` and `vault.logout` are never cancelled.

    Params: `{id}` (the request's own `id`)
    Result: `{id, cancelled, was}`: `was` is where it was (`queued`, `waiting`, `running`), or `null` when serve has no
        such request (answered already, or never sent)
    Errors: -32602
    Since: API 21
    """
    rid = params.get("id")
    if not isinstance(rid, (int, str)) or isinstance(rid, bool):
        raise RpcError(INVALID_PARAMS, "params.id must be the id of a request sent earlier")
    server = getattr(state, "server", None)
    if server is None:
        return {"id": rid, "cancelled": False, "was": None}
    return server.cancel(rid)


METHODS["$/cancel"] = cancel_request


# ---------------------------------------------------------------- the loop

WORKERS = 8                 # requests answered at once (the core lets the Plugins have 4 of them)
QUICK_WORKERS = 2           # and for the quick reads, which never wait for a lock a long request holds
QUICK = {"inventory.info", "hosts.list", "host.get", "mesh.status", "mesh.job", "mesh.stop", "discover.plan",
         "discover.status", "discover.stop", "jobs.list", "jobs.stop", "inventory.watch", "vault.forget_typed",
         "host.check_job"}


def quick(req):
    """Whether REQ is a quick read: it touches only memory and takes no lock a long request holds."""
    params = req.get("params")
    return req.get("method") in QUICK and not (isinstance(params, dict) and params.get("settled") is True)


def handle(state, line):
    """One request line -> the response object, or None for a notification."""
    try:
        req = json.loads(line)
    except ValueError as e:
        return error_response(None, RpcError(PARSE_ERROR, f"not valid JSON: {e}"))
    return respond(state, req)


def respond(state, req):
    """One parsed request -> the response object, or None for a notification."""
    if not isinstance(req, dict) or req.get("jsonrpc") != "2.0" or not isinstance(req.get("method"), str):
        rid = req.get("id") if isinstance(req, dict) else None
        return error_response(rid, RpcError(INVALID_REQUEST, "expected a JSON-RPC 2.0 request object"))
    rid, notification = req.get("id"), "id" not in req
    method = req["method"]
    try:
        fn = METHODS.get(method)
        if fn is None:
            raise RpcError(METHOD_NOT_FOUND, f"unknown method {method!r}")
        params = req.get("params", {})
        if not isinstance(params, dict):
            raise RpcError(INVALID_PARAMS, "params must be an object")
        with deadline(DEADLINES.get(method)):
            if method == "vault.status":
                after_unlocks(state, method)
            with claimed(state, LOCKS.get(method, []), method):
                started_running()
                result = {"jsonrpc": "2.0", "id": rid, "result": fn(state, params)}
    except RpcError as e:
        result = error_response(rid, e)
    except SystemExit as e:                     # a die() inside roster: its message is the answer
        result = error_response(rid, RpcError(ROSTER_ERROR, die_message(e)))
    except Exception as e:
        print(f"serve: {method} failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        result = error_response(rid, RpcError(INTERNAL_ERROR, f"{type(e).__name__}: {e}"))
    return None if notification else result


def error_response(rid, e):
    err = {"code": e.code, "message": e.message}
    if e.data is not None:
        err["data"] = e.data
    if getattr(e, "details", None):         # the raw words (git's, ssh's) for the app's "Details"
        err["data"] = {**err.get("data", {}), "details": e.details}
    return {"jsonrpc": "2.0", "id": rid, "error": err}


def log_line(msg):
    print(f"serve: {msg}", file=sys.stderr, flush=True)


class Pool:
    """N daemon threads answering what's put in: a request still running when serve exits doesn't keep it open."""

    def __init__(self, n, name):
        self.queue = queue.Queue()
        for i in range(n):
            threading.Thread(target=self.work, name=f"{name}-{i}", daemon=True).start()

    def work(self):
        while True:
            job = self.queue.get()
            try:
                job()
            except Exception as e:              # a worker outlives whatever its request raised: never one less
                log_line(f"a worker's request failed: {type(e).__name__}")


def request_key(rid):
    """A request's id as a key: 1 and "1" are different ids."""
    return json.dumps(rid)


class Server:
    """Answers requests concurrently: each goes to a worker (a quick read to one of its own, an unlock to its lane),
    its answer goes out when it's ready, so answers may come in another order than asked (JSON-RPC's id says which is
    which). `$/cancel` is answered on the reading thread, ahead of them all."""

    def __init__(self, state, send, workers=WORKERS, quick_workers=QUICK_WORKERS):
        self.state, self.send = state, send
        self.general, self.quick = Pool(workers, "serve"), Pool(quick_workers, "serve-quick")
        self.unlock_lane = Pool(1, "serve-unlock")
        self.busy = threading.Condition()
        self.running = 0
        self.requests = {}                      # request_key(id) -> its Request, until it's answered
        self.table = threading.Lock()
        state.server = self

    def submit(self, line):
        try:
            req = json.loads(line)
        except ValueError as e:
            self.send(error_response(None, RpcError(PARSE_ERROR, f"not valid JSON: {e}")))
            return
        if isinstance(req, dict) and req.get("method") == "$/cancel":
            response = respond(self.state, req)     # at once: it only looks at what's queued and running
            if response is not None:
                self.send(response)
            return
        record = Request(req)
        with self.table:
            if isinstance(req, dict) and "id" in req:
                self.requests[request_key(req["id"])] = record
            if record.method == "vault.status":     # the unlocks asked before it: it waits for them
                record.after = [r for r in self.requests.values()
                                if r.method in UNLOCK_LANE and not r.finished.is_set()]
        with self.busy:
            self.running += 1
        if record.method in UNLOCK_LANE:
            pool = self.unlock_lane
        elif isinstance(req, dict) and quick(req):
            pool = self.quick
        else:
            pool = self.general
        pool.queue.put(lambda: self.run(record))

    def run(self, record):
        req = record.req
        _request.current = record
        try:
            if self.state.closing:             # queued when stdin closed: refused, never run
                if isinstance(req, dict) and "id" in req:
                    self.send(error_response(req.get("id"), closing_error()))
                return
            with record.lock:
                refused = record.cancelled.is_set()
                if not refused:
                    record.phase = "waiting"
            if refused:                         # cancelled while queued: never runs
                if isinstance(req, dict) and "id" in req:
                    self.send(error_response(req.get("id"), cancelled(record.method)))
                return
            response = respond(self.state, req)
            if response is not None:
                self.send(response)
        finally:
            _request.current = None
            self.ended(record)
            with self.busy:
                self.running -= 1
                self.busy.notify_all()

    def ended(self, record):
        with self.table:
            if isinstance(record.req, dict) and "id" in record.req:
                key = request_key(record.req["id"])
                if self.requests.get(key) is record:
                    del self.requests[key]
        with MOVED:
            record.finished.set()
            MOVED.notify_all()

    def cancel(self, rid):
        """$/cancel's work: see cancel_request."""
        with self.table:
            record = self.requests.get(request_key(rid))
        if record is None:
            return {"id": rid, "cancelled": False, "was": None}
        stop = None
        with record.lock:
            was = record.phase
            if record.method in NEVER_CANCELLED:
                done = False
            elif was in ("queued", "waiting"):
                record.cancelled.set()
                done = True
            else:
                done = record.method in CANCEL_RUNNING
                if done:
                    record.asked, stop = True, record.stop
        if done and was != "running":
            if was == "queued":                 # over for whoever waits for it (vault.status)
                with MOVED:
                    record.finished.set()
            for lock in (self.state.lock, self.state.vault):
                lock.wake()
            with MOVED:
                MOVED.notify_all()
        if stop is not None:
            stop()
        return {"id": rid, "cancelled": done, "was": was}

    def close(self, wait):
        """stdin closed: refuse what's queued (it never runs), and wait up to WAIT s for what's running. Before any
        clean-up, so nothing starts after it (a sign-in's `bw login`, a job)."""
        self.state.closing = True
        return self.drain(wait)

    def drain(self, wait):
        """Wait up to WAIT s for the requests still running: True if none is."""
        end = time.monotonic() + wait
        with self.busy:
            while self.running:
                left = end - time.monotonic()
                if left <= 0:
                    return False
                self.busy.wait(left)
        return True


def serve(config_arg):
    # The app speaks UTF-8 JSON lines, whatever this box's locale (Windows' is often cp1252 for a pipe), and "\n"
    # ends a line on Windows too. A password with an accent comes through as typed.
    sys.stdin.reconfigure(encoding="utf-8", newline="\n")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    out = sys.stdout
    sys.stdout = sys.stderr             # whatever else roster prints (warnings, say()) must not corrupt the stream
    state = State(config_arg)
    out_lock = threading.Lock()

    def send(message):
        line = json.dumps(message, default=str) + "\n"
        with out_lock:                  # one whole line at a time, whichever worker answers
            out.write(line)
            out.flush()

    # the messages serve sends unasked: JSON-RPC notifications (no id): inventory.changed, job.progress, ...
    state.notify = lambda method, params: send({"jsonrpc": "2.0", "method": method, "params": params})
    state.jobs.notify = state.notify
    server = Server(state, send)
    # From here a signal ends serve the way closed stdin does, so the askpass folder is still removed: a signal while
    # the channel opens is undone by the channel itself, and after that by the `with`. The handlers serve found are
    # put back when it returns.
    found = exit_on_signals()
    try:
        with open_channel(state) as state.askpass:
            try:
                for line in sys.stdin:
                    if line.strip():
                        server.submit(line)
            finally:
                exit_on_signals(ignore=True)    # asked to end already: a second signal mustn't cut the clean-up short
                if state.watcher is not None:
                    state.watcher.stop.set()
                server.close(DRAIN_WAIT)        # first: what's queued is refused, what runs gets a moment to answer
                end_sign_in(state)              # a half-done `bw login` doesn't outlive serve
                state.jobs.close(CLOSE_WAIT)    # nor does a job: a Mesh run records what it didn't do, nmap ends
    finally:
        restore_signals(found)
    return 0


def exit_on_signals(ignore=False):
    """SIGTERM, SIGHUP (the terminal went away) and SIGINT end serve the way closed stdin does, so the askpass
    folder (and its socket) is removed and the jobs are stopped and recorded; IGNORE them once that has begun (with a
    handler that does nothing, not SIG_IGN, which a program started meanwhile would inherit). Only
    SIGKILL, or the interpreter dying, can skip it: the next serve removes what that left (askpass.sweep).
    Returns the handlers that were there before, for restore_signals."""
    found = {}
    if threading.current_thread() is not threading.main_thread():
        return found                    # serve() run by a test on a thread of its own: Python sets them in main only
    for name in ("SIGTERM", "SIGHUP", "SIGINT"):
        sig = getattr(signal, name, None)   # Windows has no SIGHUP
        if sig is not None:
            found[sig] = signal.signal(sig, (lambda *_: None) if ignore else lambda *_: sys.exit(0))
    return found


def restore_signals(found):
    for sig, handler in found.items():
        signal.signal(sig, handler if handler is not None else signal.SIG_DFL)


DRAIN_WAIT = 1.0            # s: the requests running when stdin closes get this long to answer
CLOSE_WAIT = 0.8            # s: then the jobs get this long to wind down; the app waits 3 s after closing stdin (rpc.rs)
