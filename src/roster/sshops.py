"""ssh from this Box: known_hosts and host keys, whether `ssh NAME` reaches this Inventory's Host, this Box's ssh
config for an Inventory, and running a command on a Host (a key login, or a password one over paramiko)."""

import base64
import concurrent.futures as cf
import hashlib
import shlex
import subprocess
import threading
from pathlib import Path
from typing import Any

from . import context, rotation, sshconfig
from .common import die, program_argv, replace_file, say, ssh_path
from .context import Context, current, ssh_dir
from .errors import NOT_SET_UP, Problem
from .hosts import is_windows, password_login
from .sshconfig import token_path

# ---------------------------------------------------------------- known hosts

def hk_name(h: dict[str, Any]) -> str:
    return h["ip"] if h["ssh"]["port"] == 22 else f"[{h['ip']}]:{h['ssh']['port']}"


def known_names():
    names = set()
    if current().known_hosts.exists():
        for line in current().known_hosts.read_text().splitlines():
            if line.strip() and not line.startswith(("#", "@")):
                names.update(line.split()[0].split(","))
    return names


def fingerprint(key: Any) -> str:
    """A paramiko key as ssh prints it: SHA256:base64."""
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def recorded_host_keys(h):
    """The host keys roster recorded for H, {key type: paramiko key} (empty if none)."""
    import paramiko
    if not current().known_hosts.exists():
        return {}
    found = paramiko.HostKeys(str(current().known_hosts)).lookup(hk_name(h))
    return dict(found) if found else {}


RECORDING = threading.Lock()    # serve records keys from several requests at once (decision Q112): one at a time


def record_host_key(h, key_type, base64_key):
    """Add one confirmed host key for H's address to roster's known_hosts (host.add, after the user compared it)."""
    with RECORDING:                 # read, then append: two at once could both miss the other's line
        ssh_dir().mkdir(mode=0o700, exist_ok=True)
        current().known_hosts.touch(mode=0o600, exist_ok=True)
        line = f"{hk_name(h)} {key_type} {base64_key}"
        text = current().known_hosts.read_text()
        if line not in text.splitlines():
            with current().known_hosts.open("a") as f:
                f.write(("" if not text or text.endswith("\n") else "\n") + line + "\n")


def handshake(sock, key_types, timeout=10):
    """Key exchange only, over an open socket: the host key the server offers, preferring KEY_TYPES (the recorded
    ones, so a Host with several keys shows the one we can compare), and the key exchange it agreed to
    (`ecdh-sha2-nistp256`, `curve25519-sha256`; "" when paramiko doesn't name it). Never authenticates, never records
    anything. Raises paramiko.SSHException if the exchange fails. roster offers curve25519 first, so a NIST one means
    the server has no curve25519: a FIPS-mode Host's sign (T239)."""
    import logging
    agreed = []

    class Kex(logging.Handler):         # paramiko names the agreed kex only in its debug log ("Kex: NAME")
        def emit(self, record):
            msg = record.getMessage()
            if msg.startswith("Kex: "):
                agreed.append(msg[5:].strip())
    channel = f"roster.handshake.{threading.get_ident()}.{id(agreed)}"
    log = logging.getLogger(channel)
    log.setLevel(logging.DEBUG)
    log.propagate = False               # nothing of it reaches roster's or the user's logging
    log.addHandler(logging.NullHandler())     # stays when Kex goes: the transport thread can outlive this
    handler = Kex()
    log.addHandler(handler)
    try:
        t = start_transport(sock, key_types, timeout, log_channel=channel)
        try:
            return t.get_remote_server_key(), (agreed or [""])[0]
        finally:
            t.close()
    finally:
        log.removeHandler(handler)
        logging.Logger.manager.loggerDict.pop(channel, None)


def quiet_paramiko():
    """paramiko's transport thread logs a connection's end (a socket closed under it, a Host that never sent its
    banner) as an error with its traceback, often after roster has its answer; with no handler anywhere, logging's
    last resort would print that on stderr, in the middle of roster's own output or serve's log."""
    import logging
    log = logging.getLogger("paramiko")
    if not any(isinstance(h, logging.NullHandler) for h in log.handlers):
        log.addHandler(logging.NullHandler())


def start_transport(sock, key_types, timeout=10, log_channel=None):
    """An SSH transport over SOCK with the key exchange done (preferring host keys of KEY_TYPES) and nobody
    logged in yet: the caller compares t.get_remote_server_key() before it tries a login, and closes it."""
    import paramiko
    quiet_paramiko()
    wanted = [t for kt in key_types for t in
              (("rsa-sha2-512", "rsa-sha2-256", "ssh-rsa") if kt == "ssh-rsa" else (kt,))]
    t = paramiko.Transport(sock)
    if log_channel:
        t.set_log_channel(log_channel)
    try:
        options = t.get_security_options()
        usable = [k for k in wanted if k in options.key_types]
        if usable:
            options.key_types = usable
        t.start_client(timeout=timeout)
    except BaseException:
        t.close()
        raise
    return t


def left_out(name: str) -> str | None:
    """Why NAME's block isn't in this Box's ssh config though this Inventory has it: another named Inventory, ahead of
    this one, has a Host by that name (ticket 115). None otherwise."""
    from . import named  # Pydantic: only once it's used, never at roster's start
    if name not in named.left_out_hosts():
        return None
    return (f"{name} is left out of this Box's ssh config: another named Inventory, ahead of this one, has a Host by "
            "that name, and `ssh " + name + "` reaches that one")


def not_reached(name: str) -> str | None:
    """Why roster mustn't `ssh NAME` for this run's Host NAME, or None. With named Inventories (~/.ssh/config includes
    their index), `ssh NAME` reaches this Inventory's Host only when NAME is in this Inventory's part of the index:
    one left out (left_out) reaches another Inventory's Host, and one not there at all (this Inventory isn't synced on
    this Box, or the Host is new since) reaches another's or nothing roster wrote (#367's review, as #335's N1).
    Without the index, nothing changes: as before named Inventories."""
    from . import named  # Pydantic: only once it's used, never at roster's start
    other = named.unnamed_from_elsewhere()
    if other is not None:               # with or without the index: roster's one unnamed file is another roster.yml's
        return (f"{name} is not in this Box's ssh config for this roster.yml: roster's unnamed ssh config was written "
                f"from {other}, so `ssh {name}` would reach that file's {name}")
    by_file = named.index_hosts()
    if by_file is None or name in by_file.get(ssh_path(current().ssh_config), set()):
        return None
    return left_out(name) or (f"{name} is not in this Box's ssh config for this Inventory ({current().ssh_config.name} "
                              f"has no Host {name} in it, or this Inventory isn't synced here), so `ssh {name}` "
                              "wouldn't reach it")


def sync_fix() -> str:
    """The command that writes this run's ssh config: `roster sync` with what picks this run's roster.yml."""
    here = current()
    if here.name is not None:
        return f"`roster --inv {here.name} sync` writes it"
    return f"`roster -c {shlex.quote(str(here.path))} sync` writes it" if here.path is not None else "`roster sync` writes it"


def not_in_ssh_config(name, missing, fix=None):
    """Why a plain `ssh NAME` won't use the Host block roster wrote for this run's Host NAME (its file lacks it, or
    ~/.ssh/config doesn't include it), as a NOT_SET_UP Problem, or None when it will. MISSING (and FIX) is the
    message when it's simply not there yet."""
    from . import named  # Pydantic: only once it's used, never at roster's start
    if name in (named.reachable_hosts() or ()):
        return None
    why = left_out(name)
    if why:
        return Problem(NOT_SET_UP, why, fix="rename one of the two in its roster.yml, or make this Inventory the "
                                            "active one (`roster inv use`)")
    why = not_reached(name)
    if why:                             # another roster.yml's, or this Inventory isn't synced here
        return Problem(NOT_SET_UP, why, fix=sync_fix())
    return Problem(NOT_SET_UP, missing, fix=fix)


def record_fingerprints(cfg: dict[str, Any], hosts: list[dict[str, Any]]) -> set[str]:
    """Trust-on-first-use: store each host's SSH host key so later logins can detect impostors."""
    ssh_dir().mkdir(mode=0o700, exist_ok=True)
    current().known_hosts.touch(mode=0o600, exist_ok=True)
    have = known_names()
    todo = list({hk_name(h): h for h in hosts if hk_name(h) not in have}.values())   # one scan per ip:port
    hosts_by_target = {}
    for h in hosts:
        hosts_by_target.setdefault(hk_name(h), []).append(h["name"])

    def scan(h):
        try:
            r = subprocess.run(program_argv(["ssh-keyscan", "-T", "5", "-p", str(h["ssh"]["port"]), h["ip"]]),
                               capture_output=True, text=True, timeout=30)
            return h, [ln for ln in r.stdout.splitlines() if ln.strip() and not ln.startswith("#")]
        except subprocess.TimeoutExpired:
            return h, []

    new, missing, scanned = [], set(), 0
    with cf.ThreadPoolExecutor(cfg["workers"]) as ex:
        for h, lines in ex.map(scan, todo):
            if lines:
                new += lines
                scanned += 1
            else:
                missing.update(hosts_by_target[hk_name(h)])
    if new:
        with current().known_hosts.open("a") as f:
            f.write("\n".join(new) + "\n")
    say(f"fingerprints {scanned} new, {len(missing)} hosts gave no answer")
    return missing


# ---------------------------------------------------------------- this Box's ssh config for an Inventory

def host_block(cfg, name, h, waiting=(), ctx=None):
    """The `Host NAME` block roster writes for one Host of the Inventory CTX (default: this run's), as lines (no
    comments). WAITING: the Hosts a Box key rotation is pending on (T240), whose block offers the old key too, after
    the new."""
    opts = [("HostName", h["ip"]), ("User", h["ssh"]["user"]), ("Port", h["ssh"]["port"]),
            ("UserKnownHostsFile", token_path((ctx or current()).known_hosts)), ("StrictHostKeyChecking", "accept-new"),
            ("ConnectTimeout", 10), ("ServerAliveInterval", 30)]
    if is_windows(h):                       # a Windows Host's sshd refuses a second session on a shared connection
        opts += [("ControlMaster", "no")]   # ("No existing session"), so never share one with it
    elif not context.WINDOWS:                       # Windows' OpenSSH can't share a connection (no Unix sockets)
        opts += [("ControlMaster", "auto"),     # reuse one connection for many commands
                 ("ControlPath", f"{token_path(ssh_dir())[:-1]}/cm-%C\""), ("ControlPersist", "10m")]
    # Offer only roster's key (key Hosts) or no key at all (password Hosts): an agent holding many keys
    # would otherwise use up the Host's MaxAuthTries before the password ("Too many authentication failures").
    if h["enroll"]:                         # its own key type's; then the old one, mid-rotation
        opts += [("IdentityFile", token_path(f)) for f in rotation.identity_files(h, waiting)]
        opts += [("IdentitiesOnly", "yes")]
    elif password_login(h["ssh"]["auth"]):
        opts += [("IdentitiesOnly", "yes"), ("PubkeyAuthentication", "no")]
    return sshconfig.host_block(name, opts)


def ssh_config_lines(cfg, ctx=None):
    """roster's ssh config for the Inventory CFG (CTX: its context, default this run's), as lines. ValueError when a
    path can't be written safely."""
    ctx = ctx or current()
    waiting = rotation.config_waiting(cfg, ctx)   # fail closed: every Host when roster can't tell
    out = [sshconfig.header(cfg["path"]), "# Don't edit by hand: change roster.yml and run `roster sync`.", ""]
    for name, h in sorted(cfg["hosts"].items()):
        tags = ", ".join(x for x in (h["type"], h["product"]) if x)
        label = " ".join(x for x in (h["title"], f"[{tags}]" if tags else "") if x)
        if label:
            out.append(f"# {label}")
        if h["description"]:
            out.append(f"# {h['description']}")
        out += host_block(cfg, name, h, waiting, ctx)
        out.append("")
    return out


def write_ssh_config(cfg: dict[str, Any], ctx: Context | None = None) -> None:
    """Write this Box's ssh config for the Inventory CFG (CTX: its context, default this run's), and make
    ~/.ssh/config reach it: through the named Inventories' index when there are any (or one is left to clean up),
    else by including roster's one file."""
    from . import named  # Pydantic: only once it's used, never at roster's start
    ctx = ctx or current()
    try:
        lines = ssh_config_lines(cfg, ctx)
    except ValueError as e:
        die(f"this Box's ssh config wasn't written: {e} (key_path: in roster.yml, or this Box's home folder)")
    replace_file(ctx.ssh_config, "\n".join(lines), 0o600)
    say(f"ssh config   {ctx.ssh_config} ({len(cfg['hosts'])} hosts)")
    if ctx.name is not None:
        unnamed = Context().ssh_config          # the file this same roster.yml had before it was named: superseded
        if sshconfig.source_of(unnamed) == Path(sshconfig.comment(cfg["path"])):
            unnamed.unlink()
    if named.in_use():
        named.refresh_index()
        return
    main = sshconfig.main_config()
    text = main.read_text() if main.exists() else ""
    if not sshconfig.includes(text, ctx.ssh_config):
        # Include must sit above any Host block, so prepend it
        replace_file(main, f"{sshconfig.include_line(ctx.ssh_config)}\n\n{text}", 0o600)


# ---------------------------------------------------------------- remote helpers

# What a login test runs: the same in sh, cmd.exe and PowerShell, so a Windows Host's working login isn't a failure
# (`true` is POSIX only: under PowerShell or cmd it isn't a command, and the login looked refused).
LOGIN_PROBE = "exit 0"


def ssh_ok(name: str, timeout: int = 10) -> bool:
    if not_reached(name):               # `ssh NAME` would reach another named Inventory's Host, or nothing of ours
        return False
    # ControlPath=none: never trust a cached connection, really log in with the key
    try:
        r = subprocess.run(program_argv(["ssh", "-o", "BatchMode=yes", "-o", "ControlPath=none",
                                         "-o", f"ConnectTimeout={timeout}", name, LOGIN_PROBE]),
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout + 20)
        return r.returncode == 0
    except subprocess.TimeoutExpired:
        return False

def sudo_wrap(command):
    """Run COMMAND as root via `sudo -S`, which reads the login password from stdin. The command
    itself gets /dev/null as stdin, so it can never read that password, even if sudo didn't ask for it."""
    return "sudo -S -p '' -- sh -c " + shlex.quote("exec </dev/null; " + command)


def password_exec(h: dict[str, Any], command: str, password: str | None, timeout: float = 15,
                  stdin: str | bytes | None = None) -> tuple[int, str, str]:
    """Run a command over SSH with a password (or agent key). Host key must already be recorded.
    STDIN, if given, is written to the command's stdin (used to hand sudo its password)."""
    try:
        import paramiko
    except ImportError:
        raise RuntimeError("paramiko is not installed: pip install paramiko")
    quiet_paramiko()
    c = paramiko.SSHClient()
    c.load_host_keys(str(current().known_hosts))
    c.set_missing_host_key_policy(paramiko.RejectPolicy())
    use_pw = password is not None
    running = False
    try:
        c.connect(h["ip"], port=h["ssh"]["port"], username=h["ssh"]["user"], password=password,
                  allow_agent=not use_pw, look_for_keys=not use_pw,
                  timeout=timeout, auth_timeout=timeout, banner_timeout=timeout)
        stdin_f, stdout, stderr = c.exec_command(command, timeout=120)
        running = True
        if stdin is not None:
            stdin_f.write(stdin)
            stdin_f.channel.shutdown_write()
        out = stdout.read().decode(errors="replace")
        err = stderr.read().decode(errors="replace")
        return stdout.channel.recv_exit_status(), out, err
    except paramiko.AuthenticationException:
        raise RuntimeError("login refused (wrong user or password?)")
    except paramiko.SSHException as e:
        if "known_hosts" in str(e):
            raise RuntimeError("host key not recorded - is the host reachable on its SSH port?")
        raise RuntimeError(str(e))
    except TimeoutError:
        if running:     # the channel's own 120 s: logged in, but the command was quiet that long
            raise RuntimeError("the command printed nothing for 120 s, so roster stopped waiting (it may still be "
                               "running there)") from None
        raise RuntimeError("can't connect (timed out)") from None
    except OSError as e:
        raise RuntimeError(f"can't connect ({e.strerror or e})")
    finally:
        c.close()


