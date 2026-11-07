"""`roster ssh HOST`: an interactive ssh session to a Host (R6, #558; ADR 0002, ADR 0011).

It runs the system ssh by the alias `roster sync` writes, so the key, user, port, roster's known hosts and whatever
else the ssh config says for the Host (a ProxyJump through a jump Host among it) apply as they would to `ssh HOST`.
A password-only Host's Login password goes to ssh through the askpass channel (askpass.py), as an app Session's does
(serve's session.prepare): a channel of this process's own, a one-time token in ssh's environment, the password looked
up in this process and handed to the helper ssh runs, never on a command line, stdout or stderr.

What roster can tell before connecting (unknown Host, not synced, vault locked, item missing) is refused with its code
and fix, exit 1, nothing started. ssh's stderr is passed on as it comes; when ssh fails to connect or log in (exit 255,
in its own words) one more line follows with roster's cause and fix (catchup.explain), as `roster run` does."""

import os
import subprocess
import sys
import threading
from typing import Any, NoReturn, cast

from . import askpass, catchup, common, diagnose, errors, hosts, run
from .common import die, program_argv, refuse
from .errors import Problem

# the modules this one leans on aren't typed yet (pyright strict here): their functions as Any
_askpass, _common, _diagnose, _run = cast(Any, askpass), cast(Any, common), cast(Any, diagnose), cast(Any, run)

KEPT = 64 * 1024        # bytes of ssh's stderr kept for the cause of a failed login (the login's words come first)


def session(cfg: dict[str, Any], name: str) -> int:
    """`roster ssh HOST`: ssh's exit code (the remote shell's, or 255 when ssh failed), 1 when roster refused first."""
    h: dict[str, Any] | None = cfg["hosts"].get(name)
    if h is None:
        die(f"unknown host {name!r} (see `roster hosts`)", code=errors.UNKNOWN_HOST)
    if not h["reviewed"]:
        die(_common.not_reviewed(h), code=errors.NOT_REVIEWED)
    checked(_diagnose.check_user, h)
    _run.refuse_left_out(h)
    if _diagnose.uses_password(h) and not hosts.prompted(h["ssh"]["auth"]):
        return password_session(cfg, h)
    return explained(cfg, h, ["ssh", h["name"]], {}, password=False)


def checked(check: Any, h: dict[str, Any]) -> None:
    try:
        check(h)
    except Problem as e:
        failed(e)


def failed(p: Problem) -> NoReturn:
    """Refuse with P's code, words and fix, `error: [CODE] MESSAGE - FIX` (never its details: a vault's own output).
    A vault's own message already says what to run (`roster vault unlock` for a locked one), as `roster run` has it."""
    shown = p.fix if p.fix and p.fix not in p.message and p.code not in errors.VAULT_CODES else None
    q: Any = p
    refuse(Problem(q.code, q.message, q.data, fix=shown))


PASSWORD_OPTIONS = ["-o", "NumberOfPasswordPrompts=1", "-o", "PreferredAuthentications=password,keyboard-interactive"]


def password_session(cfg: dict[str, Any], h: dict[str, Any]) -> int:
    """ssh that asks this process's askpass channel for the Login's password. The Login is resolved first, so a locked
    vault or a missing item is refused before ssh starts; the channel's lookup then answers from this run's cache."""
    checked(_diagnose.check_login, h)
    try:
        channel: Any = askpass.Channel(_diagnose.askpass_lookup)
    except OSError as e:
        die(f"can't open the askpass channel ssh would get {h['name']}'s password from: {e.strerror or e}",
            code=errors.NO_ASKPASS)
    with channel:
        if channel.problem:
            die(channel.problem, code=errors.NO_ASKPASS)
        env = channel.env(channel.mint(h, h["name"]), login_for=f"{h['ssh']['user']}@{h['ip']}")
        return explained(cfg, h, ["ssh", *PASSWORD_OPTIONS, h["name"]], env, password=True)


def explained(cfg: dict[str, Any], h: dict[str, Any], argv: list[str], env: dict[str, str], password: bool) -> int:
    """Run ARGV (ssh) as a child, stdin and stdout the terminal's, its stderr passed on as it comes (the first KEPT
    bytes kept). A failed connection or login (255, in ssh's own words) gets one more line: roster's cause and fix."""
    answered = catchup.has_answered(h)          # before the login: accept-new records a new host key
    try:
        p = subprocess.Popen(program_argv(argv), env={**os.environ, **env}, stderr=subprocess.PIPE)
    except (OSError, ValueError) as e:
        die(f"can't run ssh: {e}", code=errors.NOT_SET_UP, fix="install OpenSSH (openssh-client)")
    kept = bytearray()

    def tee() -> None:
        if p.stderr is None:
            return
        fd = p.stderr.fileno()
        out = getattr(sys.stderr, "buffer", None)
        while chunk := os.read(fd, 4096):
            if len(kept) < KEPT:
                kept.extend(chunk[:KEPT - len(kept)])
            if out is not None:
                out.write(chunk)
            else:
                sys.stderr.write(chunk.decode(errors="replace"))
            sys.stderr.flush()
    t = threading.Thread(target=tee, daemon=True)
    t.start()
    rc = wait(p)
    t.join()
    said = kept.decode(errors="replace")
    # the askpass helper's own line (`roster askpass: [CODE] REASON`) already says why
    if rc == 255 and _run.SSH_SAID.search(said) and not any(_askpass.complaint(ln) for ln in said.splitlines()):
        why = catchup.explain(cfg, h, said, password=password, answered=answered)
        print(f"roster: {errors.tagged(why)}" + (f": {why.fix}" if why.fix else ""), file=sys.stderr, flush=True)
    return rc


def wait(p: "subprocess.Popen[bytes]") -> int:
    """P's exit code. A Ctrl+C that reaches roster reached ssh as well (one process group): ssh's code is what counts."""
    while True:
        try:
            return p.wait()
        except KeyboardInterrupt:
            continue

