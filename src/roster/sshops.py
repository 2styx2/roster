"""Keys, fingerprints, ssh config, and running things on hosts."""

import base64
import concurrent.futures as cf
import hashlib
import re
import shlex
import subprocess
import threading
from pathlib import Path
from typing import Any

from .common import (
    KEY_TAG,
    KEY_TRAIL,
    LEGACY_KEY_TAGS,
    SSH_UNSAFE,
    WINDOWS,
    current_inventory,
    die,
    key_name_file,
    known_hosts_file,
    program_argv,
    replace_file,
    say,
    ssh_config_file,
    ssh_dir,
    ssh_path,
)
from .config import is_windows
from .providers import NO_PASSWORD, get_secret

# ---------------------------------------------------------------- keys & known hosts

def ensure_key(key, tag):
    """This Box's KEY (a boxkeys.BoxKey) on disk, made with ssh-keygen and tagged TAG when it isn't there yet. A
    key that's there is kept; one of another type than KEY's (an ECDSA or RSA key's file holding another key) is
    refused (201), as the Hosts that want this type would refuse it. An Ed25519 key's file is taken as it is (as
    before T239: key_path may name a key of the user's own)."""
    if key.key.exists():
        if not key.pub.exists():
            die(f"{key.key} exists but {key.pub} is missing")
        from . import boxkeys
        from .errors import KEY_TYPE_MISMATCH
        # T245 (#478 item 3): key_path written out by an older template names the Ed25519 key's file, which a later
        # top-level key_type: then finds holding another type
        fix = (f"remove key_path from roster.yml (roster then keeps this key at {key.key.with_name(key.type.file_name)}) "
               "or point it at another file" if key.key.name != key.type.file_name else
               "move it away (roster makes the new key there), or point key_path at another file")
        if key.type.name != "ed25519":
            have = (key.pub.read_text().split() or ["nothing"])[0]
            if have != key.type.public_word:
                die(f"[{KEY_TYPE_MISMATCH}] {key.key} is an {have} key, not {key.type.name} "
                    f"({key.type.public_word}), which key_type: in roster.yml asks for: {fix}")
            bits = boxkeys.rsa_bits(key.pub) if key.type.algorithm == "rsa" else None
            if bits is not None and key.type.bits is not None and bits < key.type.bits:     # #471's review LOW-2
                die(f"[{KEY_TYPE_MISMATCH}] {key.key} is a {bits}-bit RSA key, fewer than the {key.type.bits} bits "
                    f"key_type: {key.type.name} asks for: {fix}")
        # #471's review (NIT): a .pub that isn't this key's would go on the Hosts and never log in. Checked only when
        # ssh-keygen can read the key without a passphrase (a key of the user's own may have one, as before)
        have, words = boxkeys.derived(key.key), boxkeys.public_words(key.pub)
        if have is not None and have != words:
            die(f"[{KEY_TYPE_MISMATCH}] {key.pub} isn't the public key of {key.key} (another key's .pub beside it): "
                f"{fix}")
        say(f"key          {key.key} ({key.type.name}, existing)")
        return
    from . import boxkeys
    gone = boxkeys.was_made(key.key)        # T243: roster made it before, and it's gone (deleted)
    key.key.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    subprocess.run(program_argv(["ssh-keygen", "-q", *key.type.keygen_args(), "-N", "", "-C", tag,
                                 "-f", str(key.key)]), check=True)
    boxkeys.stamp(key.key)                  # its age counts from now (key_max_age:, T240)
    say(f"key          {key.key} ({key.type.name}, created)")
    if gone:
        from .errors import BOX_KEY_REMADE
        say(f"warning: [{BOX_KEY_REMADE}] {key.key} was gone, so this is a new key: every Host the old one was on "
            "needs this one (setup puts it on each Host it can log in to with a password; roster check names the "
            "rest)")


def public_key_line(key, tag):
    """KEY's (a boxkeys.BoxKey) public key line as it goes on a Host: its type and key, then TAG."""
    parts = key.pub.read_text().split()
    if len(parts) < 2:
        die(f"{key.pub} doesn't look like a public key")
    return f"{parts[0]} {parts[1]} {tag}"   # tag lets revoke find exactly this box's key


def ere_literal(text):
    """TEXT as a POSIX ERE (and .NET regex) that matches it literally: grep -E on a Host, -cmatch on Windows."""
    return re.sub(r"([.\[\]()*+?{}|^$\\])", r"\\\1", text)


# KEY_TRAIL for awk, with no bracket class (#442's M2): a space, tab or CR. In the program's own regex literal as
# escapes; in RE (through ENVIRON, where awk may not read escapes) as the characters, which the shell makes ($W)
AWK_TRAIL_LITERAL = "[ \\t\\r]*$"
AWK_TRAIL_SH = "W=$(printf ' \\t\\r'); "
# a roster-managed tag, any Box name
TAGS_ERE = "(" + "|".join((KEY_TAG,) + LEGACY_KEY_TAGS) + "):[A-Za-z0-9_-]+" + KEY_TRAIL


def key_ere(kind, key):
    """An ERE for a Box key line of key KIND KEY under a roster-managed tag of any name, with or without options
    before it (`from="..." ssh-ed25519 KEY roster-managed:BOX`, #423's review M1): it ends in this key and a roster
    tag, so it's this Box's line, whatever its name. A line with no roster tag (a user's own) never matches."""
    return f"(^| ){ere_literal(kind)} {ere_literal(key)} {TAGS_ERE}"


def box_key_re(cfg):
    """What matches this Box's key lines in authorized_keys: its tag (cfg's tag_re), or one of this Box's own public
    keys (one per key type, T239: boxkeys.all_keys) with a roster-managed tag of any Box name (T217, #412): a Box
    renamed since (box_name:, or the hostname) still finds its lines under the earlier name, and never another Box's,
    whose keys differ. The tag alone without a public key."""
    alts = [cfg["tag_re"]]
    for words in box_public_keys(cfg):
        alts.append(key_ere(words[0], words[1]))
    return "|".join(dict.fromkeys(alts))


def box_public_keys(cfg):
    """[[type, key, comment...]] of each of this Box's public keys that's there and reads as one, and whose private key
    this Box holds (boxkeys.vouched, #471's review LOW-6: every key, not only the leftover ones)."""
    from . import boxkeys
    out = []
    for key in boxkeys.all_keys(cfg):
        if not boxkeys.vouched(key, cfg["key"]):
            continue
        try:
            parts = key.pub.read_text().split()
        except OSError:
            continue
        if len(parts) >= 2:
            out.append(parts)
    return out


def key_tag_name(cfg):
    """The Box name in this Box's public keys' comment (ssh-keygen -C, as ensure_key made it, or as setup re-tagged
    it): its own key's first, then the other key types' (T239). None when no comment is a roster-managed tag (a key
    of the user's own)."""
    for parts in box_public_keys(cfg):
        m = re.fullmatch(f"(?:{'|'.join((KEY_TAG,) + LEGACY_KEY_TAGS)}):([A-Za-z0-9_-]+)", parts[2]) \
            if len(parts) == 3 else None
        if m:
            return m.group(1)
    return None


def key_named(cfg):
    """The Box name this Box's key lines on this Inventory's Hosts carry: what the last `roster setup` that reached
    every key Host tagged them with (key_name_file), else the key's own comment (a key made by roster names the Box
    as it was then). None: not known (a key of the user's own, never set up since T217)."""
    try:
        return key_name_file().read_text().strip() or None
    except OSError:
        return key_tag_name(cfg)


def hk_name(h: dict[str, Any]) -> str:
    return h["ip"] if h["ssh"]["port"] == 22 else f"[{h['ip']}]:{h['ssh']['port']}"


def known_names():
    names = set()
    if known_hosts_file().exists():
        for line in known_hosts_file().read_text().splitlines():
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
    if not known_hosts_file().exists():
        return {}
    found = paramiko.HostKeys(str(known_hosts_file())).lookup(hk_name(h))
    return dict(found) if found else {}


RECORDING = threading.Lock()    # serve records keys from several requests at once (decision Q112): one at a time


def record_host_key(h, key_type, base64_key):
    """Add one confirmed host key for H's address to roster's known_hosts (host.add, after the user compared it)."""
    with RECORDING:                 # read, then append: two at once could both miss the other's line
        ssh_dir().mkdir(mode=0o700, exist_ok=True)
        known_hosts_file().touch(mode=0o600, exist_ok=True)
        line = f"{hk_name(h)} {key_type} {base64_key}"
        text = known_hosts_file().read_text()
        if line not in text.splitlines():
            with known_hosts_file().open("a") as f:
                f.write(("" if not text or text.endswith("\n") else "\n") + line + "\n")


def offered_host_key(sock, key_types, timeout=10):
    """Key exchange only, over an open socket: the host key the server offers, preferring KEY_TYPES (the
    recorded ones, so a Host with several keys shows the one we can compare). Never authenticates, never
    records anything. Raises paramiko.SSHException if the exchange fails."""
    return handshake(sock, key_types, timeout)[0]


def handshake(sock, key_types, timeout=10):
    """offered_host_key, and the key exchange the server agreed to (`ecdh-sha2-nistp256`, `curve25519-sha256`; ""
    when paramiko doesn't name it). roster offers curve25519 first, so a NIST one means the server has no curve25519:
    a FIPS-mode Host's sign (T239)."""
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


def start_transport(sock, key_types, timeout=10, log_channel=None):
    """An SSH transport over SOCK with the key exchange done (preferring host keys of KEY_TYPES) and nobody
    logged in yet: the caller compares t.get_remote_server_key() before it tries a login, and closes it."""
    import paramiko
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


def ssh_config_hosts():
    """The Hosts a plain `ssh NAME` reaches through roster's ssh config: the names of its Host blocks ~/.ssh/config
    includes (with named Inventories, the ones the index took from this run's), or None when it isn't included."""
    from .inventories import reachable_hosts
    return reachable_hosts()


def left_out(name):
    """Why NAME's block isn't in this Box's ssh config though this Inventory has it: another named Inventory, ahead of
    this one, has a Host by that name (ticket 115). None otherwise."""
    from .inventories import left_out_hosts
    if name not in left_out_hosts():
        return None
    return (f"{name} is left out of this Box's ssh config: another named Inventory, ahead of this one, has a Host by "
            "that name, and `ssh " + name + "` reaches that one")


def not_reached(name):
    """Why roster mustn't `ssh NAME` for this run's Host NAME, or None. With named Inventories (~/.ssh/config includes
    their index), `ssh NAME` reaches this Inventory's Host only when NAME is in this Inventory's part of the index:
    one left out (left_out) reaches another Inventory's Host, and one not there at all (this Inventory isn't synced on
    this Box, or the Host is new since) reaches another's or nothing roster wrote (#367's review, as #335's N1).
    Without the index, nothing changes: as before named Inventories."""
    from .inventories import index_hosts, unnamed_from_elsewhere
    other = unnamed_from_elsewhere()
    if other is not None:               # with or without the index: roster's one unnamed file is another roster.yml's
        return (f"{name} is not in this Box's ssh config for this roster.yml: roster's unnamed ssh config was written "
                f"from {other}, so `ssh {name}` would reach that file's {name}")
    by_file = index_hosts()
    if by_file is None or name in by_file.get(ssh_path(ssh_config_file()), set()):
        return None
    return left_out(name) or (f"{name} is not in this Box's ssh config for this Inventory ({ssh_config_file().name} "
                              f"has no Host {name} in it, or this Inventory isn't synced here), so `ssh {name}` "
                              "wouldn't reach it")


def sync_fix():
    """The command that writes this run's ssh config: `roster sync` with what picks this run's roster.yml."""
    from .common import current_config_path
    if current_inventory() is not None:
        return f"`roster --inv {current_inventory()} sync` writes it"
    here = current_config_path()
    return f"`roster -c {shlex.quote(str(here))} sync` writes it" if here is not None else "`roster sync` writes it"


def in_ssh_config(name):
    """Will a plain `ssh NAME` use the Host block roster wrote? (its file has it, and ~/.ssh/config includes it)"""
    return name in (ssh_config_hosts() or ())


def record_fingerprints(cfg, hosts):
    """Trust-on-first-use: store each host's SSH host key so later logins can detect impostors."""
    ssh_dir().mkdir(mode=0o700, exist_ok=True)
    known_hosts_file().touch(mode=0o600, exist_ok=True)
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
        with known_hosts_file().open("a") as f:
            f.write("\n".join(new) + "\n")
    say(f"fingerprints {scanned} new, {len(missing)} hosts gave no answer")
    return missing


# ---------------------------------------------------------------- ssh config

def ssh_quote(path: str | Path, tokens: bool = False) -> str:
    """PATH as one quoted value of an ssh config line. A quote or a control character in it is refused (ValueError): it
    could end the value or the line, and what followed would be read as directives. TOKENS: the option expands
    %-tokens (IdentityFile, UserKnownHostsFile, ControlPath), so a % of the path itself is written %%."""
    s = ssh_path(path)
    if SSH_UNSAFE.search(s):
        raise ValueError(f"{s!r} can't go into an ssh config: it holds a quote or a control character")
    return f'"{s.replace("%", "%%") if tokens else s}"'


def q(path):
    """PATH for an option that expands %-tokens (ssh_quote)."""
    return ssh_quote(path, tokens=True)


def comment(text):
    """TEXT on a comment line: no control character can end the line early."""
    return re.sub(r"[\x00-\x1f\x7f]", "?", str(text))


def host_block(cfg, name, h, waiting=()):
    """The `Host NAME` block roster writes for one Host, as lines (no comments). WAITING: the Hosts a Box key rotation
    is pending on (T240), whose block offers the old key too, after the new."""
    out = [f"Host {name}",
           f"    HostName {h['ip'].replace('%', '%%')}",              # ssh expands %-tokens in both
           f"    User {h['ssh']['user']}",
           f"    Port {h['ssh']['port']}",
           f"    UserKnownHostsFile {q(known_hosts_file())}",
           "    StrictHostKeyChecking accept-new",
           "    ConnectTimeout 10",
           "    ServerAliveInterval 30"]
    if is_windows(h):                       # a Windows Host's sshd refuses a second session on a shared connection
        out += ["    ControlMaster no"]       # ("No existing session"), so never share one with it (T195)
    elif not WINDOWS:                       # Windows' OpenSSH can't share a connection (no Unix sockets)
        out += ["    ControlMaster auto",     # reuse one connection for many commands
                f"    ControlPath {q(ssh_dir())[:-1]}/cm-%C\"",
                "    ControlPersist 10m"]
    # Offer only roster's key (key Hosts) or no key at all (password Hosts): an agent holding many keys
    # would otherwise use up the Host's MaxAuthTries before the password ("Too many authentication failures").
    if h["enroll"]:
        from .rotation import identity_files  # its own key type's (T239); then the old one, mid-rotation (T240)
        out += [f"    IdentityFile {q(f)}" for f in identity_files(h, waiting)] + ["    IdentitiesOnly yes"]
    elif h["ssh"]["auth"] not in (None, "", *NO_PASSWORD):
        out += ["    IdentitiesOnly yes", "    PubkeyAuthentication no"]
    return out


def written_host_block(name):
    """The `Host NAME` block in roster's ssh config file as it is now, as lines; None if it isn't there."""
    f = ssh_config_file()
    lines = f.read_text().splitlines() if f.is_file() else []
    if f"Host {name}" not in lines:
        return None
    block = []
    for line in lines[lines.index(f"Host {name}"):]:
        if block and not line.startswith(" "):
            break
        block.append(line)
    return block


def write_ssh_config(cfg):
    try:
        lines = ssh_config_lines(cfg)
    except ValueError as e:
        die(f"this Box's ssh config wasn't written: {e} (key_path: in roster.yml, or this Box's home folder)")
    replace_file(ssh_config_file(), "\n".join(lines), 0o600)
    finish_ssh_config(cfg)


def ssh_config_lines(cfg):
    """roster's ssh config for the Inventory CFG, as lines. ValueError when a path can't be written safely."""
    from .rotation import config_waiting
    waiting = config_waiting(cfg)       # fail closed: every Host when roster can't tell (#482's review LOW-1)
    out = [f"# Generated by roster from {comment(cfg['path'])}",
           "# Don't edit by hand: change roster.yml and run `roster sync`.", ""]
    for name, h in sorted(cfg["hosts"].items()):
        tags = ", ".join(x for x in (h["type"], h["product"]) if x)
        label = " ".join(x for x in (h["title"], f"[{tags}]" if tags else "") if x)
        if label:
            out.append(f"# {label}")
        if h["description"]:
            out.append(f"# {h['description']}")
        out += host_block(cfg, name, h, waiting)
        out.append("")
    return out


def finish_ssh_config(cfg):
    """After this run's Inventory's ssh config is written: ~/.ssh/config reaches it, through the named Inventories'
    index when there are any (or one is left to clean up), else by including roster's one file."""
    say(f"ssh config   {ssh_config_file()} ({len(cfg['hosts'])} hosts)")
    from . import inventories
    if current_inventory() is not None:
        unnamed = ssh_config_file(None)         # the file this same roster.yml had before it was named: superseded
        if unnamed.is_file() and unnamed.read_text().startswith(f"# Generated by roster from {comment(cfg['path'])}\n"):
            unnamed.unlink()
    if inventories.in_use():
        inventories.refresh_index()
        if inventories.list_file().exists():
            inventories.refresh_roster_md(skip=current_inventory())
        return
    main = ssh_dir() / "config"
    text = main.read_text() if main.exists() else ""
    if not inventories.includes(text, ssh_config_file()):
        # Include must sit above any Host block, so prepend it
        replace_file(main, f"{inventories.include_line(ssh_config_file())}\n\n{text}", 0o600)


# ---------------------------------------------------------------- remote helpers

# What a login test runs: the same in sh, cmd.exe and PowerShell, so a Windows Host's working login isn't a failure
# (`true` is POSIX only: under PowerShell or cmd it isn't a command, and the login looked refused).
LOGIN_PROBE = "exit 0"


def ssh_ok(name, timeout=10):
    return login_probe(name, timeout)[0]


def login_probe(name, timeout=10):
    """One key login to NAME (`ssh NAME exit 0`, BatchMode): (worked, ssh's stderr), the stderr for the cause of a
    failure (catchup.explain). One connection, never a retry."""
    if why := not_reached(name):        # `ssh NAME` would reach another named Inventory's Host, or nothing of ours
        return False, why
    # ControlPath=none: never trust a cached connection, really log in with the key
    try:
        r = subprocess.run(program_argv(["ssh", "-o", "BatchMode=yes", "-o", "ControlPath=none",
                                         "-o", f"ConnectTimeout={timeout}", name, LOGIN_PROBE]),
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout + 20)
        return r.returncode == 0, r.stderr.decode(errors="replace").strip()
    except subprocess.TimeoutExpired:
        return False, f"ssh to {name} timed out"

def sudo_wrap(command):
    """Run COMMAND as root via `sudo -S`, which reads the login password from stdin. The command
    itself gets /dev/null as stdin, so it can never read that password, even if sudo didn't ask for it."""
    return "sudo -S -p '' -- sh -c " + shlex.quote("exec </dev/null; " + command)


def password_exec(h, command, password, timeout=15, stdin=None):
    """Run a command over SSH with a password (or agent key). Host key must already be recorded.
    STDIN, if given, is written to the command's stdin (used to hand sudo its password)."""
    try:
        import paramiko
    except ImportError:
        raise RuntimeError("paramiko is not installed: pip install paramiko")
    c = paramiko.SSHClient()
    c.load_host_keys(str(known_hosts_file()))
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
    except paramiko.BadAuthenticationType as e:     # T243: no password login there at all (only keys)
        raise RuntimeError(f"login refused: the Host takes no password login (allowed: {', '.join(e.allowed_types)})")
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


# Which file sshd reads this account's keys from ($f, and $F as messages name it): ~/.ssh/authorized_keys, or on ESXi
# (uname VMkernel) its own /etc/ssh/keys-USER/authorized_keys, which it keeps across a reboot (its home isn't kept),
# as the Mesh's scripts do (T226, #435). USER is the Login's user ($U), as sshd's %u: one the Host names otherwise
# (`id -un`: another case, a directory account's form) is refused, as the key would go where sshd doesn't look
# (#442's review L1).
AK_FILE = ('if [ "$(uname -s 2>/dev/null)" = VMkernel ]; then ESXI=1; f=/etc/ssh/keys-$U/authorized_keys; F=$f; '
           'L=$(id -un 2>/dev/null) || L=; '
           '[ "$L" = "$U" ] || { echo "this login is ${L:-unknown} on ESXi, not $U (its user: in roster.yml), and '
           'ESXi\'s sshd reads its keys-${L:-LOGIN} folder: nothing was changed (set user: as the Host names it)" '
           '>&2; exit 1; }; '
           'else ESXI=; f=$HOME/.ssh/authorized_keys; F="~/.ssh/authorized_keys"; fi; ')
# All three rewrite authorized_keys as a new file next to it, then mv it into place: a run cut short leaves the old
# file whole (rewritten in place, it could be left empty and lock everyone out). cp -p first keeps its mode and owner
# (and ESXi's sticky bit, without which ESXi drops a file under /etc at the next boot).
# The new file is a new inode: on an SELinux-enforcing Host it may lack the old one's label (ssh_home_t) and sshd
# would refuse it. So the old file's context is copied (chcon --reference) before the mv, and restorecon sets the
# policy's after it. Both only where they exist, and never fatal (ESXi's busybox, macOS, Alpine have neither).
REPLACE_AK = ("[ -L \"$f\" ] && f=$(readlink -f \"$f\"); "
              "rm -f \"$f.roster\"; cp -p \"$f\" \"$f.roster\"; ")
KEEP_LABEL = ("{ command -v chcon >/dev/null 2>&1 && chcon --reference=\"$f\" \"$f.roster\" 2>/dev/null; } "
              "|| true; ")
RELABEL = "{ command -v restorecon >/dev/null 2>&1 && restorecon -F \"$f\" 2>/dev/null; } || true; "
# 600, as sshd wants it; on ESXi a file roster makes gets 1600 (its own keys file's mode) and an existing one keeps
# its mode (cp -p), sticky bit and all
KEY_MODE = ("if [ -z \"$ESXI\" ]; then chmod 600 \"$f.roster\"; "
            "elif [ -n \"$NEW\" ]; then chmod 1600 \"$f.roster\"; fi; ")
# ESXi saves /etc to its boot bank hourly: saved now, so a reboot before then keeps the change
BACKUP = "if [ -n \"$ESXI\" ] && [ -x /sbin/auto-backup.sh ]; then /sbin/auto-backup.sh >/dev/null 2>&1 || true; fi; "


def key_script_head(user):
    return f"set -e; U={shlex.quote(user)}; " + AK_FILE


def taken_guard(name_re, own):
    """T226 (#435, 2): when a line NAME_RE matches holds a key OWN doesn't (another Box's key under the name this Box
    is being renamed to), ROSTER_TAKEN, and the script stops there with nothing changed."""
    if name_re is None:
        return ""
    return (f"if grep -E -- {shlex.quote(name_re)} \"$f\" | grep -q -v -E -- {shlex.quote(own)}; then "
            "echo ROSTER_TAKEN; exit 0; fi; ")


def add_key_script(pub, tag_re, user, taken=None, own=None, others=None):
    """Drops the lines TAG_RE matches (this same box's), appends the current one. Safe to re-run. TAKEN (this Box's
    name's tag_re, on a renamed Box): a line it matches with a key OWN (this Box's keys; PUB's when None) doesn't
    match stops it (ROSTER_TAKEN). OTHERS (T239): after the write, ROSTER_OTHERS when a line OTHERS matches (this
    Box's, any key) holds another key than PUB's, which a later step takes once PUB's line is shown to work."""
    this = key_ere(*pub.split()[:2])
    later = (f"if grep -E -- {shlex.quote(others)} \"$f\" | grep -q -v -E -- {shlex.quote(this)}; then "
             "echo ROSTER_OTHERS; fi; ") if others else ""
    return (key_script_head(user) + "umask 077; d=${f%/*}; mkdir -p \"$d\"; NEW=; [ -f \"$f\" ] || NEW=1; "
            "touch \"$f\"; " + taken_guard(taken, own or this) + REPLACE_AK +
            f"grep -v -E -- {shlex.quote(tag_re)} \"$f\" > \"$f.roster\" || true; "
            f"printf '%s\\n' {shlex.quote(pub)} >> \"$f.roster\"; " + KEY_MODE + KEEP_LABEL +
            "mv -f \"$f.roster\" \"$f\"; " + RELABEL + BACKUP +
            "[ -n \"$ESXI\" ] || chmod 700 \"$d\"; " + later + "echo ROSTER_OK")


def retag_key_script(pub, user, taken=None, own=None):
    """T217: this Box's key lines (PUB's key under any roster-managed name, options and all) get PUB's tag, in place:
    their options stay, every other line stays as it is (never matched by name: #423's review L2), and nothing is
    added; a second copy of one (#423's S2) goes, as the install's rewrite took it. ROSTER_NONE FILE when there's
    no such line (a line written by hand); a grep that fails (2: unreadable) is a failure, never "no line". TAKEN
    (the new name's tag_re): a line it matches with a key OWN (this Box's keys; PUB's when None) doesn't match stops
    it, as ROSTER_TAKEN, before anything changes."""
    kind, key, tag = pub.split()[:3]
    found = key_ere(kind, key)
    # the line with a space before it, so the key matches at its start too; awk's own trail (#442's M2: mawk 1.3.3,
    # Debian 10's and Ubuntu 18.04's awk, has no [[:space:]] and reads it as a set of letters)
    awk_re = " " + found.removeprefix("(^| )").removesuffix(KEY_TRAIL)
    return (key_script_head(user) + "[ -f \"$f\" ] || { echo \"ROSTER_NONE $F\"; exit 0; }; rc=0; NEW=; " +
            # the new name first (#442's M1): a Host where no line of this key is tagged may still hold another
            # Box's line under it, which this Box's revoke would take once the new name is recorded
            taken_guard(taken, own or found) +
            f"grep -q -E -- {shlex.quote(found)} \"$f\" || rc=$?; "
            "[ $rc -eq 1 ] && { echo \"ROSTER_NONE $F\"; exit 0; }; "
            "[ $rc -eq 0 ] || { echo \"grep couldn't read $F (exit $rc)\" >&2; exit 1; }; "
            "umask 077; " + REPLACE_AK +
            # ENVIRON, so awk keeps every \
            AWK_TRAIL_SH + f"RE={shlex.quote(awk_re)}\"[$W]*\\$\" TAG={shlex.quote(tag)} "
            "awk 'BEGIN { re = ENVIRON[\"RE\"]; t = ENVIRON[\"TAG\"] } "
            # the tag is what changes; whatever follows it (a CR, a space: #423's S1) stays
            f"(\" \" $0) ~ re {{ s = $0; sub(/{AWK_TRAIL_LITERAL}/, \"\", s); w = substr($0, length(s) + 1); "
            f"sub(/ {TAGS_ERE.removesuffix(KEY_TRAIL)}$/, \" \" t, s); if (seen[s]++) next; $0 = s w }} {{ print }}' "
            "\"$f\" > \"$f.roster\"; " +
            KEY_MODE + KEEP_LABEL + "mv -f \"$f.roster\" \"$f\"; " + RELABEL + BACKUP + "echo ROSTER_OK")


def remove_key_script(tag_re, user):
    # each line it takes says its tag's name first (ROSTER_TAG NAME), so revoke can say when one had another name
    return (key_script_head(user) + "[ -f \"$f\" ] || { echo ROSTER_OK; exit 0; }; " + REPLACE_AK +
            f"grep -E -- {shlex.quote(tag_re)} \"$f\" "
            "| sed -n 's/.*:\\([A-Za-z0-9_-]*\\)[[:space:]]*$/ROSTER_TAG \\1/p' || true; "
            f"grep -v -E -- {shlex.quote(tag_re)} \"$f\" > \"$f.roster\" || true; " +
            KEEP_LABEL + "mv -f \"$f.roster\" \"$f\"; " + RELABEL + BACKUP + "echo ROSTER_OK")


class NameTaken(RuntimeError):
    """T226 (#435, 2): a Host's key file has another key's line under the name this Box is being renamed to."""


def enroll(h, pub, tag_re, taken=None, own=None, keep_others=False):
    """Put this Box's key line PUB on Host H, logging in with its Login's password: the notes to show under its `ok`
    (on a Windows Host, the file it wrote and any warning). RuntimeError when it can't; NameTaken when TAKEN (this Box's
    name's tag_re, on a renamed Box) is given and another key's line (one OWN, this Box's keys, doesn't match) is under
    that name there.
    T239 (#471's review LOW-1): PUB's line goes in first beside this Box's other lines (TAG_RE: another key type's),
    a key login tests it, and only then do those go, over that key login (drop_others), and only when the install
    said there are any (on Windows too since T245, #471's NIT-1). KEEP_OTHERS (setup --key-type, MED-1): they stay, so
    roster.yml's type still works after; TAG_RE then names only the lines that go (cli.cleanup_re)."""
    from . import winhost
    this = key_ere(*pub.split()[:2])
    pw = get_secret(h["ssh"]["auth"], h["group"])
    if is_windows(h):
        done = winhost.install(h, pub, this, pw, taken or "", (own or this) if taken else "", others=tag_re)
        if done.taken:
            raise NameTaken(pub.split()[2])
        if not ssh_ok(h["name"]):
            raise RuntimeError(f"key written to {', '.join(done.files) or 'its key file'} but key login still fails "
                               "(check that file's permissions and encoding, and whether sshd_config's Match Group "
                               "administrators applies to this account)"
                               + ("; this Box's other key lines there were kept" if done.others else ""))
        from .errors import KEY_FILE
        notes = ([f"key file {f}" for f in done.files] + ([f"note: {winhost.admins_note(h['name'])}"] if done.admins
                 else []) + [f"warning: [{KEY_FILE}] {w}" for w in done.warnings])
        if done.others and not keep_others:
            notes += [n for n in drop_others(h, pub, tag_re) if n not in notes]
        return notes
    _, out, err = password_exec(h, "sh -c " + shlex.quote(add_key_script(pub, this, h["ssh"]["user"], taken, own,
                                                                         others=tag_re)), pw)
    if "ROSTER_TAKEN" in out.split():
        raise NameTaken(pub.split()[2])
    if "ROSTER_OK" not in out:
        if winhost.looks_windows(out + err):
            raise RuntimeError(winhost.windows_hint(h["name"]))
        raise RuntimeError("couldn't write authorized_keys: " + (err or out).strip()[:200])
    if not ssh_ok(h["name"]):
        raise RuntimeError("key installed but key login still fails (sshd PubkeyAuthentication off, bad home-dir "
                           "permissions, or a key type it refuses?)"
                           + ("; this Box's other key lines there were kept" if "ROSTER_OTHERS" in out.split() else ""))
    if "ROSTER_OTHERS" in out.split() and not keep_others:
        drop_others(h, pub, tag_re)
    return []


def drop_others(h, pub, drop_re, why="the new key works"):
    """Over this Box's key login to Host H (PUB's key, whose line stays): this Box's lines DROP_RE matches go, and PUB's
    line is written once (DROP_RE matches it too, or it would be there twice). The notes a Windows Host's script gave
    (its key file's warnings). RuntimeError `WHY, but this Box's other key lines there couldn't be taken off: ...`."""
    from . import winhost
    fail = f"{why}, but this Box's other key lines there couldn't be taken off: "
    if is_windows(h):
        try:
            done = winhost.over_key(h, "add", drop_re, pub=pub)
        except RuntimeError as e:
            raise RuntimeError(fail + str(e)) from None
        from .errors import KEY_FILE
        return [f"warning: [{KEY_FILE}] {w}" for w in done.warnings]
    r = subprocess.run(program_argv(["ssh", "-o", "BatchMode=yes", "-o", "ControlPath=none", h["name"],
                                     "sh -c " + shlex.quote(add_key_script(pub, drop_re, h["ssh"]["user"]))]),
                       stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
    if "ROSTER_OK" not in r.stdout:
        raise RuntimeError(fail + ((r.stderr or r.stdout).strip()[:200] or f"exit {r.returncode}"))
    return []
