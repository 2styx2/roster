"""Filling a password prompt in a Session (ticket 119, decision Q129): which of a Host's Logins answers the prompt its
Session shows, or why none may. The prompt is the line at the Session's cursor, read off its screen: the Host's text,
so it can lie. It can only narrow what roster fills (a prompt naming another Host or account is refused); it can never
widen it: whatever it says, the password is one of this Host's own Logins, and only for a prompt that says it's that
Login's (sudo's for its user, ssh's for its user at its name or address).

`session.fill` (serve.py) looks the password up; the app's core types it into the Session's PTY after checking that
the prompt doesn't echo (crates/roster-core/src/session.rs, `SessionManager::fill`)."""

import re

from . import providers
from .errors import FILL_REFUSED, NOTHING_TO_FILL, Problem

# Only prompts that say whose password they want, and only when that's provably this Host's own Login (decision Q129:
# refuse whenever in doubt; a refusal is cheap, a leak isn't). sudo's own prompt names the user it runs as; OpenSSH's
# names the user and the machine. A bare "Password:" (su asks for root's, login and telnet for anyone's, a nested
# keyboard-interactive for another machine's) says neither, so it's refused, and so is su's.
SUDO = re.compile(r"\[sudo\] password for (?P<user>[^\s:]+):", re.I)
SSH = re.compile(r"(?P<user>[^\s@']+)@(?P<host>[^\s@']+)'s password:", re.I)
PLAIN = re.compile(r"password(?: for [^\s:]+)?:", re.I)


def cursor_line(prompt):
    """The last line of PROMPT (what's left of the cursor), without the spaces around it."""
    return re.split(r"[\r\n]", prompt)[-1].strip()


def login_for(h, prompt, sudo=None):
    """(which, reference) for Host H at PROMPT: which is "ssh" (its ssh Login) or "sudo" (SUDO, its `sudo:` reference).
    Raises Problem 130 when PROMPT isn't sudo's prompt for H's ssh user or ssh's for that user at H's own name or
    address, 131 when the Login that would answer it has no saved password."""
    line = cursor_line(prompt)
    user = h["ssh"]["user"]
    if m := SSH.fullmatch(line):
        who, where = m["user"], m["host"]
        # Not localhost: through a tunnel or a port forward it may be any machine. ssh prints the host lowercased.
        if who != user or where.lower() not in {h["name"].lower(), h["ip"].lower()}:
            raise refused(h, f"the prompt asks for {who}@{where}'s password, not {user}@{h['name']}'s",
                          "ssh", "roster fills only the Session's own Host; type that password yourself")
        return "ssh", saved(h, h["ssh"]["auth"], "ssh")
    if m := SUDO.fullmatch(line):
        if m["user"] != user:
            raise refused(h, f"the prompt asks for {m['user']}'s password, and roster has {user}'s on {h['name']}",
                          "sudo", "type that password yourself")
        if sudo:
            return "sudo", sudo
        return "ssh", saved(h, h["ssh"]["auth"], "ssh")
    if PLAIN.fullmatch(line):
        raise refused(h, f"{line!r} doesn't say whose password it asks for (su asks for root's, a login for "
                         "anyone's), so roster can't tell it's this Host's", "su",
                      "roster fills sudo's own prompt ([sudo] password for USER:); type this one yourself")
    raise refused(h, f"{line!r} isn't a password prompt roster fills (sudo's or ssh's)", None,
                  "fill only at a password prompt the Session shows")


def saved(h, ref, what):
    """REF, when it's a vault reference with a password to fill; else Problem 131."""
    if not has_password(ref):
        raise Problem(NOTHING_TO_FILL, f"{h['name']}'s {what} Login has no saved password to fill (auth: "
                                       f"{ref or 'none'})",
                      fix=f"add a sudo: {{auth: VAULT-REFERENCE}} to {h['name']} in roster.yml for its own "
                          "sudo password, or type it yourself")
    return ref


def has_password(ref):
    """Whether REF is a vault reference with a password behind it: not `prompt` or one of providers.NO_PASSWORD."""
    name = str(ref or "").partition(":")[0].strip()
    return name not in ("", "prompt", *providers.NO_PASSWORD)


def same_login(h, address, port, user, nested=False):
    """Problem 130 unless Host H still has the address, port and user its Session connected to (session.prepare's
    `login`), or, NESTED, that the app resolved a nested ssh in the Session to (ticket 120): one edited since may be
    another box now."""
    now = (h["ip"], h["ssh"]["port"], h["ssh"]["user"])
    if now != (address, port, user):
        since, fix = (("this ssh started", "run the ssh again, then fill") if nested else
                      ("this Session connected", "reconnect the Session, then fill"))
        raise refused(h, f"{h['name']} changed since {since} ({user}@{address}:{port}, now "
                         f"{now[2]}@{now[0]}:{now[1]})", None, fix)


def refused(h, message, kind, fix):
    return Problem(FILL_REFUSED, f"won't fill on {h['name']}: {message}", {"prompt": kind}, fix=fix)
