"""`roster run HOST -- COMMAND`: one command on a Host, over this Box's key or the Login's password (paramiko);
--sudo hands sudo the Login's password on stdin; a Windows Host's command runs under PowerShell (winhost.run)."""

import subprocess
import sys

from . import winhost
from .common import die, not_reviewed, program_argv, run_instead
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
        return run_instead(["ssh", "-o", "BatchMode=yes", h["name"], command])
    try:
        rc, out, err = password_exec(h, command, get_secret(h["ssh"]["auth"], h["group"]))
    except RuntimeError as e:
        die(f"{h['name']}: {clean(str(e))}")
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
        die(f"{h['name']}: {clean(str(e))}")


def run_sudo(h, command):
    """Run COMMAND as root: sudo gets the host's login password on stdin, never on screen."""
    try:
        secret = get_secret(h["ssh"]["auth"], h["group"])
    except RuntimeError as e:
        die(f"{h['name']}: {clean(str(e))}")
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
    if "incorrect password" in err or "no password was provided" in err:
        print(f"{h['name']}: sudo refused the password from {h['ssh']['auth']} - "
              f"is {h['ssh']['user']} allowed to sudo there?", file=sys.stderr)
    return rc if rc >= 0 else 1


def refuse_left_out(h):
    """`roster run` (and --sudo) over ssh: never by a name that reaches another Inventory's Host (its sudo password
    would go there), or that this Inventory's part of this Box's ssh config doesn't have."""
    why = not_reached(h["name"])
    if why:
        fix = ("make this Inventory the active one (`roster inv use`), or rename one of the two in its roster.yml"
               if left_out(h["name"]) else sync_fix())
        die(f"{why} - not running anything: {fix}")
