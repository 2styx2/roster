"""A new Inventory (T212, decision Q182): `roster init --inventory HOW` and install.sh's choices. Four ways to get a
roster.yml where there's none: a blank one, a copy of a roster.yml you have (checked to load first), a clone of the
team's git repo, or Hosts imported from an ssh config (HostName, User, Port and IdentityFile only; wildcards,
negations and Match blocks skipped; the ssh config is only read, never changed). Every failure is a Problem
(errors 170-173), so the CLI and serve say it the same way."""

import getpass
import json
import os
import re
import shlex
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import yaml

from .common import NAME_RE
from .config import load_config_text
from .errors import CLONE_FAILED, INVENTORY_THERE, NOT_AN_INVENTORY, SSH_CONFIG_UNREADABLE, Problem

HOWS = ("blank", "file", "repo", "ssh-config")
ROSTER_YML_MAX = 10 * 1024 * 1024       # bytes: the largest roster.yml file: imports (#409 L3)
SSH_CONFIG_MAX = 1024 * 1024            # ... and ssh config
GROUP = "servers"                       # the blank one's empty group
IMPORTED = "imported"                   # the group Hosts from an ssh config go in
CLONE_TIMEOUT = 90                      # s: a clone that can ask nothing (serve's)

HEADER = """\
# roster.yml - the map of your network. NO PASSWORDS IN THIS FILE: only where they are (auth: bw:ITEM, ...).
# A Host goes under a group's hosts:, one line each. Or scan for them:  roster discover 10.0.0.0/24 --write
# Every option, with comments:  roster -c example.yml init     Then, for this Box:  roster setup
"""

BLANK = HEADER + f"""
key_path: ~/.ssh/roster_ed25519

groups:
  {GROUP}:
    hosts:
      # web-01: {{ip: 10.0.0.5, user: admin}}
"""


def parse_how(text):
    """`blank`, `file:PATH`, `repo:URL`, `ssh-config[:PATH]` -> (how, value). ValueError says what's wrong."""
    how, sep, value = text.partition(":")
    if how == "blank" and not sep:
        return "blank", None
    if how == "ssh-config":
        return "ssh-config", value or None
    if how in ("file", "repo"):
        if not value:
            raise ValueError(f"{how}: needs a {'path' if how == 'file' else 'git URL'} after it ({how}:...)")
        if how == "repo" and value.startswith("-"):
            raise ValueError("repo: a git URL can't start with '-'")
        return how, value
    raise ValueError(f"{text!r}: use blank, file:PATH, repo:URL or ssh-config[:PATH]")


@dataclass
class Made:
    """What create() made: the roster.yml, how, and for an import, the Hosts and what was skipped."""
    path: Path
    how: str
    hosts: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def create(path, how, value=None, interactive=True):
    """Make the Inventory at PATH (a roster.yml that isn't there yet) the HOW way. INTERACTIVE: a clone may ask for
    a passphrase on this terminal (serve's never does). Returns Made; raises Problem with nothing left half-made,
    except a clone that worked but has no roster.yml (kept, and the Problem says where)."""
    path = Path(path).expanduser()
    if path.exists() or path.is_symlink():          # a link to nothing is there too: never written through
        raise Problem(INVENTORY_THERE, f"{path} already exists, so roster kept it as it is", {"path": str(path)},
                      fix=f"use it; or make a new one beside it as a named Inventory: roster -c OTHER-FOLDER/"
                          f"{path.name} init --inventory ... --name NAME")
    if how == "repo":
        return clone(path, value, interactive)
    if how == "blank":
        text, made = BLANK, Made(path, how)
    elif how == "file":
        text, made = copied(path, value), Made(path, how)
    elif how == "ssh-config":
        text, made = imported(path, value)
    else:
        raise ValueError(how)
    path.parent.mkdir(parents=True, exist_ok=True)
    # O_EXCL: never over a file (or a link) that appeared meanwhile; 0600: the Inventory is private (#409 S2)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return made


def read_source(src, what, limit, code, fix):
    """SRC's text, if it's a regular file of at most LIMIT bytes (never a device, a folder or a huge file)."""
    if not src.is_file():
        raise Problem(code, f"no file at {src}", {"path": str(src)}, fix=fix)
    try:
        size = src.stat().st_size
        if size > limit:
            raise Problem(code, f"{src} is too big for {what} ({size // 1024} KB; at most {limit // 1024} KB)",
                          {"path": str(src)}, fix=fix)
        return src.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        raise Problem(code, f"can't read {src}: {e.strerror or type(e).__name__}", {"path": str(src)},
                      fix=fix) from None


def checked(path, text, what):
    try:
        load_config_text(text, path)
    except SystemExit as e:
        raise Problem(NOT_AN_INVENTORY, f"{what} doesn't load, so nothing was written: "
                                        f"{str(e.code).removeprefix('error: ')}", {"path": str(path)},
                      fix=f"fix {what} first (`roster -c {what} check --box` says why)") from None


def copied(path, source):
    src = Path(source).expanduser()
    text = read_source(src, "a roster.yml", ROSTER_YML_MAX, NOT_AN_INVENTORY,
                       "give the path of an existing roster.yml (file:PATH)")
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError:
        raw = {"groups": {"-": {}}}                 # checked() below says what's wrong with it
    if raw is not None and not isinstance(raw, dict):
        raise Problem(NOT_AN_INVENTORY, f"{src} isn't a roster.yml (its top level isn't a mapping of settings and "
                                        "groups:), so nothing was written", {"path": str(src)},
                      fix="give the path of a roster.yml (file:PATH); for an ssh config: ssh-config:PATH")
    groups = (raw or {}).get("groups")
    if not isinstance(groups, dict) or not groups:   # empty, a typo'd groups:, another YAML file (#409 C2)
        raise Problem(NOT_AN_INVENTORY, f"{src} has no groups: (no Hosts at all), so it isn't a roster.yml to "
                                        "import; nothing was written", {"path": str(src)},
                      fix="check the file, or start a new one: --inventory blank")
    checked(src.resolve(), text, str(src))
    return text


def clone(path, url, interactive):
    folder = path.parent
    if folder.exists() and any(folder.iterdir()):
        raise Problem(CLONE_FAILED, f"{folder} isn't empty, so roster won't clone into it", {"path": str(folder)},
                      fix="pick an empty or new folder (-c FOLDER/roster.yml)")
    if shutil.which("git") is None:
        raise Problem(CLONE_FAILED, "git isn't installed on this Box, so roster can't clone the repo",
                      fix="install git, or copy roster.yml over and use file:PATH")
    from .changes import GIT_LOCATION
    env = {k: v for k, v in os.environ.items() if k not in GIT_LOCATION}
    if not interactive:                             # nobody to answer: a passphrase, a password or a new host key
        env.update({"GIT_TERMINAL_PROMPT": "0", "GIT_SSH_COMMAND": env.get("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")})
    argv = ["git", "clone", "-q", "--", url, str(folder)]
    try:
        # stderr is kept (with the URL's password cut out) even in a terminal: git may echo the URL; ssh's and git's
        # own questions go to the terminal itself
        r = subprocess.run(argv, env=env, text=True, stdin=None if interactive else subprocess.DEVNULL,
                           capture_output=True,
                           timeout=600 if interactive else CLONE_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise Problem(CLONE_FAILED, f"git clone didn't finish within {600 if interactive else CLONE_TIMEOUT} s",
                      fix="check the network; a big repo: `roster init --inventory repo:URL` in a terminal") from None
    if r.returncode != 0:
        said = redacted(url, (r.stderr or "").strip())
        asked = "" if interactive else (" (nothing can be answered here: a repo that needs a passphrase, a password "
                                        "or a host key not seen before fails; `roster init --inventory repo:URL` in "
                                        "a terminal can ask)")
        raise Problem(CLONE_FAILED, f"git couldn't clone {shown_url(url)}", {"url": shown_url(url)},
                      fix="check the URL and your access to the repo (`git clone URL` in a terminal shows the same)"
                          + asked, details=said or None)
    if not path.is_file():
        raise Problem(NOT_AN_INVENTORY, f"the clone has no {path.name} at its top: it's in {folder}",
                      {"path": str(folder)}, fix=f"point roster at the roster.yml in it (-c), or remove {folder}")
    return Made(path, "repo")


# ---------------------------------------------------------------- Hosts from an ssh config

KEYS = {"hostname": "hostname", "user": "user", "port": "port", "identityfile": "identityfile"}
LINE = re.compile(r"^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*?)\s*$")


def ssh_hosts(text):
    """{name: {hostname?, user?, port?, identityfile?}} from an ssh config's text, in order, and the patterns skipped.
    Only Host blocks with plain names count; the first value of each keyword wins, as in ssh. Nothing else is read."""
    hosts, skipped, current = {}, [], []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = LINE.match(line)
        if not m:
            continue
        key, value = m.group(1).lower(), m.group(2)
        if key == "match":
            current = []
            skipped.append(f"Match {value}")
            continue
        if key == "host":
            try:
                names = shlex.split(value)
            except ValueError:
                names = []
            current = []
            for n in names:
                if any(c in n for c in "*?!") or not NAME_RE.match(n):
                    skipped.append(n)
                else:
                    current.append(hosts.setdefault(n, {}))
            continue
        if key in KEYS:
            if len(value) >= 2 and value[0] == value[-1] == '"':
                value = value[1:-1]
            for h in current:
                h.setdefault(KEYS[key], value)
    return hosts, skipped


def shown_url(url):
    """URL with any password in it cut out (https://me:TOKEN@host/... -> https://me:***@host/...), for messages
    and the log (#409 L4)."""
    try:
        u = urlsplit(url)
        if u.password is None:
            return url
        host = (u.hostname or "") + (f":{u.port}" if u.port else "")
    except ValueError:
        return url
    return urlunsplit(u._replace(netloc=f"{u.username}:***@{host}"))


def redacted(url, text):
    """TEXT with URL's password (if it has one) cut out wherever it shows."""
    try:
        secret = urlsplit(url).password
    except ValueError:
        secret = None
    return text.replace(url, shown_url(url)).replace(secret, "***") if secret else text


def scalar(v):
    """V as a YAML scalar that reads back as exactly V: plain when YAML (1.1, as PyYAML reads it) gives back the
    same string, else JSON's double-quoted string, which is valid YAML (#409 C1: yes, null, 010, 1_000 ...)."""
    if isinstance(v, int):
        return str(v)
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._@/~-]*", v):
        try:
            if yaml.safe_load(v) == v:
                return v
        except yaml.YAMLError:
            pass
    return json.dumps(v)


def host_line(name, h):
    ip = h.get("hostname", name).replace("%h", name)
    if "%" in ip:                                   # another token ssh expands: the name is what ssh would reach
        ip = name
    fields = {"ip": ip}
    if h.get("user"):
        fields["user"] = h["user"]
    port = h.get("port", "")
    if port.isdigit() and 0 < int(port) < 65536 and int(port) != 22:
        fields["port"] = int(port)
    if h.get("identityfile"):
        fields["auth"] = "agent"
    line = f"      {scalar(name)}: {{" + ", ".join(f"{k}: {scalar(v)}" for k, v in fields.items()) + "}"
    if h.get("identityfile"):
        line += f"     # IdentityFile {oneline(h['identityfile'])}: auth: agent logs in with it (ssh-agent)"
    return line


def oneline(text):
    """TEXT with every control character (a newline above all) taken out, for a comment."""
    return re.sub(r"[\x00-\x1f\x7f]", "", text)


def local_user():
    try:
        user = getpass.getuser()
    except Exception:                               # no login name to be found (a container): leave it to roster
        return None
    return user if NAME_RE.match(user) else None


def imported(path, source):
    src = Path(source or "~/.ssh/config").expanduser()
    if re.search(r"[\x00-\x1f\x7f]", str(src)):
        raise Problem(SSH_CONFIG_UNREADABLE, "the ssh config's path has a control character (a newline) in it, so "
                                             "roster won't use it", fix="give a plain path (ssh-config:PATH)")
    try:                                            # ~/.ssh/config on every OS (Windows' backslashes too)
        shown = "~/" + src.relative_to(Path.home()).as_posix()
    except ValueError:
        shown = str(src)
    text = read_source(src, "an ssh config", SSH_CONFIG_MAX, SSH_CONFIG_UNREADABLE,
                       "give the path of your ssh config (ssh-config:PATH)")
    hosts, skipped = ssh_hosts(text)
    user = local_user()
    head = [HEADER.rstrip("\n"),
            f"# The Hosts below came from {shown} (each one's HostName, User, Port and IdentityFile; nothing else, and",
            f"# {shown} itself is unchanged). Check them, then:  roster setup", "",
            "key_path: ~/.ssh/roster_ed25519", "", "groups:", f"  {IMPORTED}:", f"    title: {scalar('From ' + shown)}"]
    if user:
        head.append(f"    user: {scalar(user)}                # ssh's own default for a Host with no User: your login name")
    head.append("    hosts:")
    lines, kept = [], []
    for n, h in hosts.items():                      # each Host on its own: one roster can't take is skipped (L2)
        line = host_line(n, h)
        try:
            load_config_text("\n".join([*head, line]) + "\n", path)
        except SystemExit as e:
            why = str(e.code).removeprefix("error: ").replace(f"host {n!r}", "").strip(" :")
            skipped.append(f"{n} ({why})")
            continue
        lines.append(line)
        kept.append(n)
    if not kept:
        return BLANK, Made(path, "ssh-config", [], skipped)
    out = "\n".join([*head, *lines]) + "\n"
    checked(path, out, "the imported roster.yml")
    return out, Made(path, "ssh-config", kept, skipped)
