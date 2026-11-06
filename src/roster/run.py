"""`roster run HOST -- COMMAND`: one command on a Host, over this Box's key or the Login's password (paramiko);
--sudo hands sudo the Login's password on stdin; a Windows Host's command runs under PowerShell (winhost.run)."""

import re
import subprocess
import sys
import threading

from . import catchup, errors, providers, sshconfig, winhost
from .common import die, not_reviewed, program_argv, run_instead
from .context import current
from .errors import RUN_SUDO_WINDOWS, UNKNOWN_HOST
from .hosts import is_windows
from .providers import get_secret
from .sshops import left_out, not_reached, password_exec, sudo_wrap, sync_fix
from .web import mask
from .winhost import clean


def run(cfg, name, words, sudo):
    """`roster run HOST [--sudo] -- COMMAND`: its exit code."""
    h = cfg["hosts"].get(name)
    if not h:
        die(f"unknown host {name!r} (see `roster hosts`)", code=UNKNOWN_HOST)
    if not words:
        die("nothing to run: roster run HOST -- COMMAND")
    command = " ".join(words)
    if not h["reviewed"]:
        die(not_reviewed(h))
    if is_windows(h):
        return run_windows(h, command, sudo)
    if sudo:
        return run_sudo(h, command)
    if h["enroll"]:
        refuse_left_out(h)
        if catchup.not_set_up(cfg, h):      # T243: setup hasn't put this Box's key there, by roster's record
            return run_explained(cfg, h, command)
        return run_instead(["ssh", "-o", "BatchMode=yes", h["name"], command])
    try:
        rc, out, err = password_exec(h, command, get_secret(h["ssh"]["auth"], h["group"]))
    except RuntimeError as e:
        refuse_secret(e, h)
    sys.stdout.write(out)
    sys.stderr.write(err)
    if words[0] == "sudo" and rc != 0 and ("password is required" in err or "terminal is required" in err):
        print(f"hint: sudo wants a password - use  roster run --sudo {h['name']} -- {' '.join(words[1:])}",
              file=sys.stderr)
    return rc if rc >= 0 else 1


def run_windows(h, command, sudo):
    """`roster run` on an os: windows Host (T196, decision Q176): COMMAND always under PowerShell (winhost.run), the
    same whatever sshd's DefaultShell. --sudo is refused before the vault is asked: Windows has no sudo over ssh."""
    if sudo:
        die(f"{h['name']} is a Windows Host (os: windows), which has no sudo over ssh: nothing "
            "ran. Log in as an account in Administrators (its ssh session is already elevated) and run it without "
            "--sudo", code=RUN_SUDO_WINDOWS)
    try:
        if h["enroll"]:
            refuse_left_out(h)
            return winhost.run(h, command)
        return winhost.run(h, command, get_secret(h["ssh"]["auth"], h["group"]), key=False)
    except ValueError as e:                 # the script with CMD in it is over 1 MB: nothing was sent
        die(f"{h['name']}: {e}: nothing ran")
    except RuntimeError as e:
        refuse_secret(e, h)


def run_sudo(h, command):
    """Run COMMAND as root: sudo gets the host's login password on stdin, never on screen."""
    try:
        secret = get_secret(h["ssh"]["auth"], h["group"])
    except RuntimeError as e:
        refuse_secret(e, h)
    if not secret:
        die(f"{h['name']}: --sudo needs the login's password, but its auth is {h['ssh']['auth']!r} "
            "(set auth: to the vault item that holds the password)")
    wrapped = sudo_wrap(command)
    if h["enroll"]:
        refuse_left_out(h)
        # bytes: text mode on Windows would send "password\r\n", and sudo would take the "\r" as part of it
        r = subprocess.run(program_argv(["ssh", "-o", "BatchMode=yes", h["name"], wrapped]),
                           input=(secret + "\n").encode(), capture_output=True)
        rc, out, err = r.returncode, r.stdout.decode(errors="replace"), r.stderr.decode(errors="replace")
    else:
        try:
            rc, out, err = password_exec(h, wrapped, secret, stdin=secret + "\n")
        except RuntimeError as e:
            die(f"{h['name']}: {clean(mask(str(e), [secret]))}")
    sys.stdout.write(mask(out, [secret]))
    sys.stderr.write(mask(err, [secret]))
    if why := sudo_failure(h, err):
        print(f"{h['name']}: {why}", file=sys.stderr)
    return rc if rc >= 0 else 1


def sudo_failure(h, err):
    """What sudo's own words on Host H mean (T243): not in sudoers, a command sudoers doesn't allow, a tty it wants,
    or the Login's password refused (a sudo password that differs from it); None when it said none of them. Names the
    vault item, never a value."""
    low, user, auth = err.lower(), h["ssh"]["user"], h["ssh"]["auth"]
    if "not in the sudoers" in low or "may not run sudo" in low:
        return f"{user} isn't allowed to sudo there (not in sudoers): add it there, or log in as an account that is"
    if "is not allowed to execute" in low:          # #510's review NIT-2: sudoers names commands, and not that one
        return (f"{user} may use sudo there, but not for that command (sudoers allows it others): run one it allows, "
                "or ask the Host's admin")
    if "terminal is required" in low or "no tty present" in low or "must have a tty" in low:
        return ("sudo there wants a terminal (requiretty in sudoers), which roster run --sudo doesn't give it: "
                f"turn requiretty off for {user}, or run it in a Session (roster's app, or ssh -t)")
    if "incorrect password" in low or "no password was provided" in low:
        return (f"sudo refused the password from {auth}: is the sudo password there the login's? (another one: "
                f"a sudo: Login in roster.yml gives it; or is {user} allowed to sudo there?)")
    return None


def refuse_secret(e, h):
    """Refuse `roster run` over a Login lookup (or a Windows run) that failed (T243): roster's words with the one fix
    and its code (errors.login_problem: the item by name, never a value), or the error's own words for anything
    else."""
    if not isinstance(e, providers.SecretError):
        die(f"{h['name']}: {clean(str(e))}")
    p = errors.login_problem(e, h)
    # a vault's own message already says what to run (VAULT_CODES: `roster vault unlock` for a locked one)
    fix = f": {p.fix}" if p.fix and p.fix not in p.message and p.code not in errors.VAULT_CODES else ""
    die(f"{h['name']}: {clean(p.message + fix)}", code=p.code)


# ssh's own words for a login that failed, as opposed to a remote command's (#510's review NIT-3)
SSH_SAID = re.compile(r"(^|\n)(\S+@\S+: permission denied \(|ssh: |kex_exchange_identification|host key verification "
                      r"failed|@@@@)", re.IGNORECASE)
VERBOSE = ("debug1:", "debug2:", "debug3:", "OpenSSH_")
KEPT = 400                  # ssh -v's lines up to the login kept for the cause, at most


def run_explained(cfg, h, command):
    """`roster run` on a Host this Box never reached, or one setup didn't finish (catchup.not_set_up): ssh -v as a
    child, not in roster's place, its stderr passed on as it comes, but for -v's own lines up to the login, which are
    kept (bounded: KEPT lines at most) for the cause; after the login everything is passed on as it is. A failed login
    (exit 255, in ssh's own words) gets one more line: its cause and the one fix (`no key on NAME yet: roster setup
    --host NAME`). Still one connection, never a retry."""
    answered = catchup.has_answered(h)      # before the login: accept-new records a new host key (HIGH-1)
    kept = []
    p = subprocess.Popen(program_argv(["ssh", "-v", "-o", "BatchMode=yes", h["name"], command]), stderr=subprocess.PIPE)

    def tee():
        logged_in = False
        for line in iter(p.stderr.readline if p.stderr else (lambda: b""), b""):
            text = line.decode(errors="replace")
            if not logged_in:
                if len(kept) < KEPT:
                    kept.append(line)
                if text.startswith(("debug1: Authenticated to ", "Authenticated to ")):
                    logged_in = True        # the command's own stderr from here on, passed on whole (NIT-8)
                    continue
                if text.startswith(VERBOSE):
                    continue
            if hasattr(sys.stderr, "buffer"):
                sys.stderr.buffer.write(line)
            else:
                sys.stderr.write(text)
            sys.stderr.flush()
    t = threading.Thread(target=tee, daemon=True)
    t.start()
    try:
        rc = p.wait()
    except KeyboardInterrupt:              # Ctrl+C went to ssh as well; its code is what counts
        rc = p.wait()
    t.join()
    said = b"".join(kept).decode(errors="replace")
    if rc == 255 and SSH_SAID.search(said):
        why = catchup.explain(cfg, h, said, answered=answered)
        print(f"roster: {errors.tagged(why)}: {why.fix}", file=sys.stderr, flush=True)
    return rc


def refuse_left_out(h):
    """`roster run` (and --sudo) over ssh: never by a name that reaches another Inventory's Host (its sudo password
    would go there), or that this Inventory's part of this Box's ssh config doesn't have (T243: nor one it has no
    block for yet, a Host added since the last sync)."""
    why = not_reached(h["name"])
    if not why and h["name"] not in (sshconfig.written_hosts(current().ssh_config) or {}):
        why = f"{h['name']} isn't in this Box's ssh config yet (added to roster.yml since the last sync?)"
    if why:
        fix = ("make this Inventory the active one (`roster inv use`), or rename one of the two in its roster.yml"
               if left_out(h["name"]) else sync_fix())
        die(f"{why} - not running anything: {fix}", code=errors.NOT_SET_UP)
