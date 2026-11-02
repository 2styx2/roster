"""Keys, fingerprints, ssh config, and running things on hosts."""

import base64
import concurrent.futures as cf
import hashlib
import os
import shlex
import subprocess
import threading

from .common import WINDOWS, die, known_hosts_file, program_argv, say, ssh_config_file, ssh_dir, ssh_path
from .providers import NO_PASSWORD, get_secret

# ---------------------------------------------------------------- keys & known hosts

def ensure_key(cfg):
    if cfg["key"].exists():
        if not cfg["pub"].exists():
            die(f"{cfg['key']} exists but {cfg['pub']} is missing")
        say(f"key          {cfg['key']} (existing)")
        return
    cfg["key"].parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    subprocess.run(program_argv(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", cfg["tag"],
                                 "-f", str(cfg["key"])]), check=True)
    say(f"key          {cfg['key']} (created)")


def public_key_line(cfg):
    parts = cfg["pub"].read_text().split()
    if len(parts) < 2:
        die(f"{cfg['pub']} doesn't look like a public key")
    return f"{parts[0]} {parts[1]} {cfg['tag']}"   # tag lets revoke find exactly this box's key


def hk_name(h):
    return h["ip"] if h["ssh"]["port"] == 22 else f"[{h['ip']}]:{h['ssh']['port']}"


def known_names():
    names = set()
    if known_hosts_file().exists():
        for line in known_hosts_file().read_text().splitlines():
            if line.strip() and not line.startswith(("#", "@")):
                names.update(line.split()[0].split(","))
    return names


def fingerprint(key):
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
    t = start_transport(sock, key_types, timeout)
    try:
        return t.get_remote_server_key()
    finally:
        t.close()


def start_transport(sock, key_types, timeout=10):
    """An SSH transport over SOCK with the key exchange done (preferring host keys of KEY_TYPES) and nobody
    logged in yet: the caller compares t.get_remote_server_key() before it tries a login, and closes it."""
    import paramiko
    wanted = [t for kt in key_types for t in
              (("rsa-sha2-512", "rsa-sha2-256", "ssh-rsa") if kt == "ssh-rsa" else (kt,))]
    t = paramiko.Transport(sock)
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
    """The Hosts a plain `ssh NAME` reaches through roster's ssh config: the names of its Host blocks, or None when
    it isn't written or ~/.ssh/config doesn't include it."""
    ours, main = ssh_config_file(), ssh_dir() / "config"
    if not ours.is_file() or not main.is_file() or ssh_path(ours) not in main.read_text():
        return None
    return {line[5:] for line in ours.read_text().splitlines() if line.startswith("Host ")}


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

def q(path):
    return f'"{ssh_path(path)}"'


def host_block(cfg, name, h):
    """The `Host NAME` block roster writes for one Host, as lines (no comments)."""
    out = [f"Host {name}",
           f"    HostName {h['ip']}",
           f"    User {h['ssh']['user']}",
           f"    Port {h['ssh']['port']}",
           f"    UserKnownHostsFile {q(known_hosts_file())}",
           "    StrictHostKeyChecking accept-new",
           "    ConnectTimeout 10",
           "    ServerAliveInterval 30"]
    if not WINDOWS:                         # Windows' OpenSSH can't share a connection (no Unix sockets)
        out += ["    ControlMaster auto",     # reuse one connection for many commands
                f"    ControlPath {q(ssh_dir() / 'cm-%C')}",
                "    ControlPersist 10m"]
    # Offer only roster's key (key Hosts) or no key at all (password Hosts): an agent holding many keys
    # would otherwise use up the Host's MaxAuthTries before the password ("Too many authentication failures").
    if h["enroll"]:
        out += [f"    IdentityFile {q(cfg['key'])}", "    IdentitiesOnly yes"]
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
    out = [f"# Generated by roster from {cfg['path']}",
           "# Don't edit by hand: change roster.yml and run `roster sync`.", ""]
    for name, h in sorted(cfg["hosts"].items()):
        tags = ", ".join(x for x in (h["type"], h["product"]) if x)
        label = " ".join(x for x in (h["title"], f"[{tags}]" if tags else "") if x)
        if label:
            out.append(f"# {label}")
        if h["description"]:
            out.append(f"# {h['description']}")
        out += host_block(cfg, name, h)
        out.append("")
    ssh_config_file().parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    ssh_config_file().write_text("\n".join(out))
    os.chmod(ssh_config_file(), 0o600)

    main = ssh_dir() / "config"
    text = main.read_text() if main.exists() else ""
    if ssh_path(ssh_config_file()) not in text:
        # Include must sit above any Host block, so prepend it
        main.write_text(f"Include {q(ssh_config_file())}\n\n{text}")
        os.chmod(main, 0o600)
    say(f"ssh config   {ssh_config_file()} ({len(cfg['hosts'])} hosts)")


# ---------------------------------------------------------------- remote helpers

def ssh_ok(name, timeout=10):
    # ControlPath=none: never trust a cached connection, really log in with the key
    try:
        r = subprocess.run(program_argv(["ssh", "-o", "BatchMode=yes", "-o", "ControlPath=none",
                                         "-o", f"ConnectTimeout={timeout}", name, "true"]),
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout + 20)
        return r.returncode == 0
    except subprocess.TimeoutExpired:
        return False

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
    try:
        c.connect(h["ip"], port=h["ssh"]["port"], username=h["ssh"]["user"], password=password,
                  allow_agent=not use_pw, look_for_keys=not use_pw,
                  timeout=timeout, auth_timeout=timeout, banner_timeout=timeout)
        stdin_f, stdout, stderr = c.exec_command(command, timeout=120)
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
    except OSError as e:
        raise RuntimeError(f"can't connect ({e.strerror or e})")
    finally:
        c.close()


# Both rewrite authorized_keys as a new file next to it, then mv it into place: a run cut short leaves the old file
# whole (rewritten in place, it could be left empty and lock everyone out). cp -p first keeps its mode and owner.
# The new file is a new inode: on an SELinux-enforcing Host it may lack the old one's label (ssh_home_t) and sshd
# would refuse it. So the old file's context is copied (chcon --reference) before the mv, and restorecon sets the
# policy's after it. Both only where they exist, and never fatal (ESXi's busybox, macOS, Alpine have neither).
REPLACE_AK = ("f=~/.ssh/authorized_keys; [ -L \"$f\" ] && f=$(readlink -f \"$f\"); "
              "rm -f \"$f.roster\"; cp -p \"$f\" \"$f.roster\"; ")
KEEP_LABEL = ("{ command -v chcon >/dev/null 2>&1 && chcon --reference=\"$f\" \"$f.roster\" 2>/dev/null; } "
              "|| true; ")
RELABEL = "{ command -v restorecon >/dev/null 2>&1 && restorecon -F \"$f\" 2>/dev/null; } || true; "


def add_key_script(pub, tag_re):
    # Drops any older key from this same box, appends the current one. Safe to re-run.
    return ("set -e; umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; " + REPLACE_AK +
            f"grep -v -E -- {shlex.quote(tag_re)} \"$f\" > \"$f.roster\" || true; "
            f"printf '%s\\n' {shlex.quote(pub)} >> \"$f.roster\"; "
            "chmod 600 \"$f.roster\"; " + KEEP_LABEL + "mv -f \"$f.roster\" \"$f\"; " + RELABEL +
            "chmod 700 ~/.ssh; echo ROSTER_OK")


def remove_key_script(tag_re):
    return ("set -e; [ -f ~/.ssh/authorized_keys ] || { echo ROSTER_OK; exit 0; }; " + REPLACE_AK +
            f"grep -v -E -- {shlex.quote(tag_re)} \"$f\" > \"$f.roster\" || true; " +
            KEEP_LABEL + "mv -f \"$f.roster\" \"$f\"; " + RELABEL + "echo ROSTER_OK")


def enroll(h, pub, tag_re):
    pw = get_secret(h["ssh"]["auth"], h["group"])
    _, out, err = password_exec(h, "sh -c " + shlex.quote(add_key_script(pub, tag_re)), pw)
    if "ROSTER_OK" not in out:
        raise RuntimeError("couldn't write authorized_keys: " + (err or out).strip()[:200])
    if not ssh_ok(h["name"]):
        raise RuntimeError("key installed but key login still fails "
                           "(sshd PubkeyAuthentication off, or bad home-dir permissions?)")
