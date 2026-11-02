"""Pending changes (ticket 10): roster.yml's uncommitted diff in the infra repo's git working tree.
inventory.pull fast-forwards the repo before an edit; changes.diff shows the diff and which Hosts it touches;
changes.discard puts roster.yml back as the last commit has it; changes.publish commits roster.yml alone and
pushes it to the upstream (ticket 12, decision Q13), fetching first and never forcing.
Every git run is non-interactive and time-limited. A backup of what an edit or a discard replaced goes in the
repo's git dir (never in the working tree, where Publish would pick it up)."""

import os
import signal
import subprocess
from pathlib import Path

from .common import WINDOWS, kill_tree, time_left
from .edit import load_text, read_text, write_text
from .errors import (
    COMMIT_FAILED,
    DIRTY,
    DIVERGED,
    INVENTORY_ERROR,
    NO_UPSTREAM,
    NOT_A_REPO,
    NOTHING_TO_PUBLISH,
    OTHER_CHANGES,
    PULL_FAILED,
    PUSH_FAILED,
    REMOTE_MOVED,
    ROSTER_ERROR,
    UNPUSHED,
    Problem,
)

GIT_TIMEOUT = 60            # s: a fetch over a slow link; nothing here waits on a person
PUSH_TIMEOUT = 60           # s: the push; past it roster checks whether the push got there anyway
CHECK_TIMEOUT = 15          # s: that check (a fetch), even past serve's deadline
HOST_VIEW = ("group", "ip", "title", "description", "type", "product", "enroll", "reviewed", "mesh", "mac", "web",
             "services")


def git(repo, *args, timeout=GIT_TIMEOUT, floor=1):
    """Run git in REPO, non-interactive. Past TIMEOUT its whole process group is killed (a push's remote side
    and hooks too, which would otherwise hold the output open) and it's a Problem."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C", "GIT_OPTIONAL_LOCKS": "0"}
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
    argv = ["git", "-C", str(repo), *args]
    timeout = round(time_left(timeout, floor), 1)          # held to serve's deadline for the whole request
    try:
        p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                             text=True, env=env, start_new_session=True)
    except FileNotFoundError:
        raise Problem(NOT_A_REPO, "git isn't installed on this box, so roster can't keep Pending changes",
                      fix="install git") from None
    try:
        stdout, stderr = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_group(p)
        raise Problem(PULL_FAILED, f"git {args[0]} didn't finish within {timeout} s",
                      fix="check the network and your access to the infra repo, then try again") from None
    except BaseException:
        kill_group(p)
        raise
    return subprocess.CompletedProcess(argv, p.returncode, stdout, stderr)


def kill_group(p):
    """Kill git and whatever it started (ssh, a credential helper): its process group, which Windows doesn't have."""
    if WINDOWS:                         # no process groups: taskkill the tree
        kill_tree(p)
    else:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            p.kill()
    try:
        p.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def out(repo, *args):
    r = git(repo, *args)
    return r.stdout.strip() if r.returncode == 0 else None


class Repo:
    """The git working tree roster.yml is in, and roster.yml's path inside it."""

    def __init__(self, path):
        self.path = Path(path).resolve()
        top = out(self.path.parent, "rev-parse", "--show-toplevel")
        if top is None:
            raise Problem(NOT_A_REPO, f"{self.path} isn't in a git repo, so it can't have Pending changes",
                          {"path": str(self.path)},
                          fix="keep roster.yml in the infra repo (a git clone), or edit it by hand")
        self.top = Path(top).resolve()
        self.rel = self.path.relative_to(self.top).as_posix()
        self.git_dir = Path(out(self.top, "rev-parse", "--absolute-git-dir"))
        if git(self.top, "ls-files", "--error-unmatch", "--", self.rel).returncode != 0:
            raise Problem(NOT_A_REPO, f"{self.rel} isn't committed in {self.top} yet, so it can't have Pending "
                                      "changes", {"path": str(self.path)},
                          fix=f"commit it once in a terminal: git -C {self.top} add {self.rel} && git commit")

    def head_text(self):
        r = git(self.top, "show", f"HEAD:{self.rel}")
        return r.stdout if r.returncode == 0 else None

    def backup(self, text):
        """Keep TEXT (what's about to be replaced) as roster.yml.bak in the git dir; returns its path."""
        d = self.git_dir / "roster"
        d.mkdir(exist_ok=True)
        bak = d / (self.path.name + ".bak")
        write_text(bak, text)
        return bak

    def diff_text(self):
        r = git(self.top, "diff", "--no-color", "--no-ext-diff", "HEAD", "--", self.rel)
        return r.stdout if r.returncode == 0 else ""


# ---------------------------------------------------------------- inventory.pull

def dirty_files(repo):
    r = git(repo.top, "status", "--porcelain", "--untracked-files=no")
    return [ln[3:] for ln in r.stdout.splitlines() if ln.strip()]


def pull(path):
    """Fast-forward the infra repo to its upstream. Refuses a working tree with uncommitted changes and a branch
    that has diverged; never merges, rebases or stashes."""
    repo = Repo(path)
    files = dirty_files(repo)
    if files:
        if files == [repo.rel]:
            raise Problem(DIRTY, f"{repo.rel} has Pending changes, so roster won't pull over them",
                          {"files": files}, fix="Publish or discard the Pending changes first")
        raise Problem(DIRTY, f"the infra repo has uncommitted changes ({', '.join(files)}), so roster won't pull",
                      {"files": files}, fix=f"commit, stash or undo them in a terminal (git -C {repo.top} status)")
    upstream = out(repo.top, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    if upstream is None:
        return {"updated": False, "upstream": None, "commits": 0, "ahead": 0,
                "message": "this branch has no upstream, so there's nothing to pull"}
    remote = upstream.split("/", 1)[0]
    r = git(repo.top, "fetch", "--quiet", remote)
    if r.returncode != 0:
        raise Problem(PULL_FAILED, f"couldn't fetch {upstream} for the infra repo", {"upstream": upstream},
                      fix=f"check the network and your access to the repo; `git -C {repo.top} fetch` shows the same",
                      details=r.stderr.strip() or None)
    behind = int(out(repo.top, "rev-list", "--count", "HEAD..@{u}") or 0)
    ahead = int(out(repo.top, "rev-list", "--count", "@{u}..HEAD") or 0)
    if behind and ahead:
        raise Problem(DIVERGED, f"this box's infra repo and {upstream} have diverged ({ahead} local and {behind} "
                                f"new commits there), so roster won't pull", {"upstream": upstream, "ahead": ahead,
                                                                                "behind": behind},
                      fix=f"merge or rebase in a terminal: git -C {repo.top} pull --rebase")
    before = out(repo.top, "rev-parse", "HEAD")
    if behind:
        r = git(repo.top, "merge", "--ff-only", "--quiet", "@{u}")
        if r.returncode != 0:
            raise Problem(PULL_FAILED, f"couldn't fast-forward the infra repo to {upstream}", {"upstream": upstream},
                          fix=f"see the details; `git -C {repo.top} pull --ff-only` shows the same",
                          details=r.stderr.strip() or None)
    return {"updated": bool(behind), "upstream": upstream, "commits": behind, "ahead": ahead,
            "from": before, "to": out(repo.top, "rev-parse", "HEAD")}


# ---------------------------------------------------------------- changes.diff / changes.discard

def host_view(h):
    return {**{k: h.get(k) for k in HOST_VIEW}, "user": h["ssh"]["user"], "port": h["ssh"]["port"],
            "auth": h["ssh"]["auth"]}


def loaded(path, text):
    """load_config of TEXT as if it were PATH, or None if it doesn't load."""
    try:
        return load_text(path, text)
    except Problem:
        return None


def host_changes(path, old_text, new_text):
    """[{host, change: added|removed|changed, fields}] between two versions of roster.yml (empty if either
    doesn't load)."""
    old, new = loaded(path, old_text), loaded(path, new_text)
    if old is None or new is None:
        return []
    out_ = []
    for name, h in new["hosts"].items():
        if name not in old["hosts"]:
            out_.append({"host": name, "change": "added", "fields": []})
            continue
        a, b = host_view(old["hosts"][name]), host_view(h)
        fields = [k for k in b if a[k] != b[k]]
        fields += ["mesh_dir"] if old["mesh_dirs"].get(name) != new["mesh_dirs"].get(name) else []
        fields += ["seen_as"] if old["seen_as"].get(name) != new["seen_as"].get(name) else []
        if fields:
            out_.append({"host": name, "change": "changed", "fields": fields})
    out_ += [{"host": n, "change": "removed", "fields": []} for n in old["hosts"] if n not in new["hosts"]]
    return out_


def diff(path):
    """roster.yml's Pending changes: the unified diff against the last commit, and the Hosts it changes.
    count is the number of changed Hosts (1 for a change that touches no Host, such as a comment); message is the
    commit message changes.publish would write (for the app to show, and edit, before publishing). last_commit is
    the branch's last commit and whether its upstream has it (as this box last saw it, no fetch): after a Publish
    the app gave up waiting for, that's how it tells whether it happened."""
    repo = Repo(path)
    text = repo.diff_text()
    base = {"path": str(repo.path), "repo": str(repo.top), "last_commit": last_commit(repo)}
    if not text:
        return {**base, "diff": "", "hosts": [], "groups": [], "count": 0, "message": ""}
    old_text, new_text = repo.head_text() or "", read_text(repo.path)
    hosts = host_changes(repo.path, old_text, new_text)
    groups = group_changes(repo.path, old_text, new_text)
    links = link_changes(repo.path, old_text, new_text)
    return {**base, "diff": text, "hosts": hosts, "groups": groups, "count": len(hosts) or 1,
            "message": commit_message(hosts, groups, links)}


def last_commit(repo):
    """{commit, subject, upstream, pushed}: HEAD, and whether the upstream (as last fetched) contains it."""
    commit = out(repo.top, "rev-parse", "HEAD")
    if commit is None:
        return None
    upstream = out(repo.top, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    pushed = bool(upstream) and git(repo.top, "merge-base", "--is-ancestor", "HEAD", "@{u}").returncode == 0
    return {"commit": commit, "subject": out(repo.top, "log", "-1", "--format=%s") or "", "upstream": upstream,
            "pushed": pushed}


def discard(path):
    """Put roster.yml back as the last commit has it (index and working tree). What it held is kept as the backup."""
    repo = Repo(path)
    if not repo.diff_text():
        return {"discarded": False, "backup": None}
    bak = repo.backup(read_text(repo.path))
    r = git(repo.top, "checkout", "HEAD", "--", repo.rel)
    if r.returncode != 0:
        raise Problem(ROSTER_ERROR, f"couldn't put {repo.rel} back as committed", fix="see the details",
                      details=r.stderr.strip() or None)
    return {"discarded": True, "backup": str(bak)}


# ---------------------------------------------------------------- changes.publish

SUBJECT_MAX = 72            # a commit subject longer than this names the count, and the body lists every Host


def group_changes(path, old_text, new_text):
    """[{group, change: added|removed|changed}] between two versions of roster.yml: groups that appear,
    disappear, or whose title or description changed (their Hosts are listed on their own)."""
    old, new = loaded(path, old_text), loaded(path, new_text)
    if old is None or new is None:
        return []
    a, b = old["groups"], new["groups"]
    return ([{"group": g, "change": "added"} for g in b if g not in a]
            + [{"group": g, "change": "changed"} for g in b if g in a and a[g] != b[g]]
            + [{"group": g, "change": "removed"} for g in a if g not in b])


def link_changes(path, old_text, new_text):
    """[{link: 'a -> b', change: added|removed|changed, fields}] between two versions of roster.yml's `links:`
    (T67), each Link named by its ends (and its hop when added or removed). Empty if either doesn't load."""
    old, new = loaded(path, old_text), loaded(path, new_text)
    if old is None or new is None:
        return []
    a, b = ({(x["from"], x["to"]): x for x in cfg["links"]} for cfg in (old, new))

    def name(x):
        return f"{x['from']} -> {x['to']}" + (f" via {x['via']}" if x.get("via") else "")
    return ([{"link": name(b[k]), "change": "added", "fields": []} for k in b if k not in a]
            + [{"link": f"{k[0]} -> {k[1]}", "change": "changed",
                "fields": [f for f in ("both", "via") if a[k].get(f) != b[k].get(f)]} for k in b if k in a and a[k] != b[k]]
            + [{"link": name(a[k]), "change": "removed", "fields": []} for k in a if k not in b])


def describe(c):
    """One Host's, group's or Link's change in a few words: 'change esx (title, ip)', 'add web-01',
    'remove group old', 'add link orion-2 -> storage'."""
    name = c["host"] if "host" in c else f"group {c['group']}" if "group" in c else f"link {c['link']}"
    verb = {"added": "add", "removed": "remove", "changed": "change"}[c["change"]]
    fields = f" ({', '.join(c['fields'])})" if c.get("fields") else ""
    return f"{verb} {name}{fields}"


def commit_message(hosts, groups, links=()):
    """The generated message: a subject naming what changed, and a line per change when it doesn't fit."""
    links = list(links)
    items = [describe(c) for c in groups + hosts + links]
    if not items:
        return "roster: edit roster.yml"
    subject = "roster: " + ", ".join(items)
    if len(subject) <= SUBJECT_MAX:
        return subject
    counts = [c for c in (f"{len(hosts)} Host{'s' * (len(hosts) != 1)}" if hosts else "",
                          f"{len(groups)} group{'s' * (len(groups) != 1)}" if groups else "",
                          f"{len(links)} Link{'s' * (len(links) != 1)}" if links else "") if c]
    counted = " and ".join(counts) if len(counts) < 3 else f"{counts[0]}, {counts[1]} and {counts[2]}"
    return f"roster: change {counted}\n\n" + "\n".join(f"- {i}" for i in items)


def undo_commit(repo, commit):
    """Take back publish's own commit (only if it's still HEAD), leaving its change Pending and unstaged."""
    if out(repo.top, "rev-parse", "HEAD") == commit:
        git(repo.top, "reset", "--quiet", "--soft", "HEAD~1")
        git(repo.top, "reset", "--quiet", "--", repo.rel)


def pushed_anyway(repo, remote, commit):
    """After a push that didn't finish: True if the upstream has COMMIT now, False if it hasn't, None if
    roster can't tell (the fetch fails too)."""
    try:
        r = git(repo.top, "fetch", "--quiet", remote, timeout=CHECK_TIMEOUT, floor=CHECK_TIMEOUT)
    except Problem:
        return None
    if r.returncode != 0:
        return None
    return git(repo.top, "merge-base", "--is-ancestor", commit, "@{u}").returncode == 0


def publish(path, message=None):
    """Commit roster.yml's Pending changes (that file only) and push them to the branch's upstream.
    Fetches first. New upstream commits that leave roster.yml alone are fast-forwarded over; anything else
    that moved (roster.yml changed there, local commits, a rejected push) stops it with nothing published,
    the Pending changes as they were, and never a force. The author is the repo's own git identity."""
    repo = Repo(path)
    if not repo.diff_text():
        raise Problem(NOTHING_TO_PUBLISH, f"{repo.rel} has no Pending changes, so there's nothing to publish",
                      fix="edit a Host first")
    others = [f for f in dirty_files(repo) if f != repo.rel]
    if others:
        raise Problem(OTHER_CHANGES, f"the infra repo has other uncommitted changes ({', '.join(others)}), so "
                                     f"roster won't publish", {"files": others},
                      fix=f"commit, stash or undo them in a terminal (git -C {repo.top} status), then publish")
    text = read_text(repo.path)
    try:
        load_text(repo.path, text)
    except Problem as e:
        raise Problem(INVENTORY_ERROR, f"{repo.rel} doesn't load, so roster won't publish it: "
                                       f"{e.details or e.message}", {"path": str(repo.path)},
                      fix=f"fix {repo.rel} (or discard the Pending changes), then publish") from None

    branch = out(repo.top, "symbolic-ref", "--quiet", "--short", "HEAD")
    upstream = out(repo.top, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    remote = branch and out(repo.top, "config", f"branch.{branch}.remote")
    merge = branch and out(repo.top, "config", f"branch.{branch}.merge")
    if not (upstream and remote and merge):
        raise Problem(NO_UPSTREAM, "this branch of the infra repo has no upstream, so there's nowhere to publish to",
                      fix=f"set one in a terminal: git -C {repo.top} push -u origin {branch or 'main'}")
    r = git(repo.top, "fetch", "--quiet", remote)
    if r.returncode != 0:
        raise Problem(PULL_FAILED, f"couldn't fetch {upstream} for the infra repo, so nothing was published",
                      {"upstream": upstream},
                      fix=f"check the network and your access to the repo; `git -C {repo.top} fetch` shows the same",
                      details=r.stderr.strip() or None)
    ahead = int(out(repo.top, "rev-list", "--count", "@{u}..HEAD") or 0)
    behind = int(out(repo.top, "rev-list", "--count", "HEAD..@{u}") or 0)
    if ahead:
        raise Problem(UNPUSHED, f"this box's infra repo has {ahead} commit{'s' * (ahead != 1)} that "
                                f"{'are' if ahead != 1 else 'is'}n't on {upstream}, and roster publishes only its own", {"upstream": upstream,
                                                                                  "ahead": ahead, "behind": behind},
                      fix=f"push or drop them in a terminal (git -C {repo.top} log @{{u}}..), then publish")
    if behind:
        if git(repo.top, "diff", "--quiet", "HEAD", "@{u}", "--", repo.rel).returncode != 0:
            raise Problem(REMOTE_MOVED, f"someone published {repo.rel} to {upstream} since this box pulled "
                                        f"({behind} new commit{'s' * (behind != 1)}), so roster won't publish over "
                                        "it", {"upstream": upstream, "behind": behind},
                          fix="discard your Pending changes, :pull, and make them again; or merge in a terminal: "
                              f"git -C {repo.top} stash && git pull --ff-only && git stash pop")
        r = git(repo.top, "merge", "--ff-only", "--quiet", "@{u}")
        if r.returncode != 0:
            raise Problem(PULL_FAILED, f"couldn't fast-forward the infra repo to {upstream}, so nothing was "
                                       "published", {"upstream": upstream},
                          fix=f"see the details; `git -C {repo.top} pull --ff-only` shows the same",
                          details=r.stderr.strip() or None)

    old_text = repo.head_text() or ""
    hosts = host_changes(repo.path, old_text, text)
    groups = group_changes(repo.path, old_text, text)
    links = link_changes(repo.path, old_text, text)
    msg = message.strip() if message and message.strip() else commit_message(hosts, groups, links)
    r = git(repo.top, "commit", "--quiet", "--only", "-m", msg, "--", repo.rel)
    if r.returncode != 0:
        raise Problem(COMMIT_FAILED, "git didn't make the commit, so nothing was published", {"upstream": upstream},
                      fix=f"see the details (often no git identity: git -C {repo.top} config user.name and "
                          "user.email); the Pending changes are kept", details=(r.stderr or r.stdout).strip() or None)
    commit = out(repo.top, "rev-parse", "HEAD")
    target = merge.removeprefix("refs/heads/")
    try:
        r = git(repo.top, "push", "--quiet", "--porcelain", remote, f"HEAD:{merge}", timeout=PUSH_TIMEOUT)
    except Problem:                     # it didn't finish: it may have got there all the same
        landed = pushed_anyway(repo, remote, commit)
        if not landed:
            undo_commit(repo, commit)
            raise Problem(PUSH_FAILED,
                          f"the push to {upstream} didn't finish in time and "
                          + ("didn't get there; nothing was published" if landed is False else
                             "roster couldn't check whether it got there; the commit is undone here, so the "
                             "changes are Pending again"),
                          {"upstream": upstream, "rejected": False, "timed_out": True, "landed": landed},
                          fix="check the network, then :publish again" if landed is False else
                              f"check `git -C {repo.top} fetch && git -C {repo.top} log -1 {upstream}`: if your "
                              "change is there it was published, so discard the Pending changes; if not, "
                              ":publish again") from None
    except BaseException:
        undo_commit(repo, commit)
        raise
    else:
        if r.returncode != 0:
            undo_commit(repo, commit)
            said = (r.stderr + r.stdout).strip()
            moved = any(w in said for w in ("non-fast-forward", "fetch first"))
            raise Problem(PUSH_FAILED,
                          f"{upstream} moved while roster was publishing, so the push was refused; nothing was "
                          "published" if moved else f"couldn't push to {upstream}; nothing was published",
                          {"upstream": upstream, "rejected": moved},
                          fix=":publish again (it fetches first)" if moved else
                              f"check the network and your rights to push to {remote} {target}; the Pending "
                              "changes are kept", details=said or None)
    return {"commit": commit, "upstream": upstream, "message": msg, "hosts": hosts, "groups": groups,
            "pulled": behind}
