"""Ticket 28: the Live Inventory. Removing, renaming and moving Hosts and adding, renaming and deleting groups, as text
edits of roster.yml (comments kept, every other entry byte for byte), and serve noticing outside edits: applied with
auto_reload (inventory.watch {auto: true}) within a second, else only reported until `:source` (inventory.reload).
A broken edit keeps the last good Inventory and says the line."""

import json
import queue
import subprocess
import sys
import threading
import time

import pytest
from test_edit import INVENTORY, changed_lines

from roster import edit
from roster.errors import (
    GROUP_NOT_EMPTY,
    INVALID_EDIT,
    INVALID_HOST,
    NAME_TAKEN,
    UNKNOWN_GROUP,
    UNKNOWN_HOST,
    WOULD_CHANGE,
    Problem,
)


@pytest.fixture
def inv(write_config):
    return write_config(INVENTORY)


def outside(old, new):
    """The lines of OLD that aren't in NEW's diff: everything an edit must leave byte for byte."""
    return changed_lines(old, new)


# ---------------------------------------------------------------- the text edits

def test_removing_a_host_takes_out_its_lines_and_nothing_else(inv):
    old, new, h = edit.removed(inv, "block")
    assert h["group"] == "lab"
    assert changed_lines(old, new) == ["-      block:", "-        ip: 10.0.0.3     # moved in May",
                                       "-        title: 'Block box'", "-        description: |",
                                       "-          Two lines", "-          of notes.", "-        type: esxi",
                                       "-        services:", "-          web: 443"]
    assert new == INVENTORY.replace(INVENTORY[INVENTORY.index("      block:"):INVENTORY.index("      sshd:")], "")


def test_removing_the_last_host_of_a_group_keeps_the_group(inv):
    old, new, _ = edit.removed(inv, "sw1")
    assert changed_lines(old, new) == ["-      sw1: {ip: 10.0.1.1, user: net}"]
    inv.write_text(new)
    from roster.config import load_config
    assert "other" in load_config(inv)["groups"]


def test_a_short_host_with_a_comment_goes_with_its_comment(inv):
    old, new, _ = edit.removed(inv, "short")
    assert changed_lines(old, new) == ["-      short: 10.0.0.1    # the old switch"]
    assert "# the lab" not in new and "# The lab. NO PASSWORDS IN THIS FILE." in new


def test_renaming_a_host_changes_only_its_key(inv):
    old, new, h = edit.renamed(inv, "flow", "flow-2")
    assert changed_lines(old, new) == ['-      flow: {ip: 10.0.0.2, title: "Flow box"}',
                                       '+      flow-2: {ip: 10.0.0.2, title: "Flow box"}']
    assert h["name"] == "flow-2" and h["title"] == "Flow box"


@pytest.mark.parametrize("to, code", [("plain", NAME_TAKEN), ("sw1", NAME_TAKEN), ("a b", INVALID_HOST)])
def test_a_rename_to_a_taken_or_bad_name_is_refused(inv, to, code):
    with pytest.raises(Problem) as e:
        edit.renamed(inv, "flow", to)
    assert e.value.code == code


def test_moving_a_host_cuts_its_lines_and_adds_them_to_the_other_group_keeping_what_it_inherited(inv):
    old, new, h, pinned = edit.moved(inv, "block", "other")
    lines = changed_lines(old, new)
    assert lines[:9] == ["-      block:", "-        ip: 10.0.0.3     # moved in May", "-        title: 'Block box'",
                         "-        description: |", "-          Two lines", "-          of notes.",
                         "-        type: esxi", "-        services:", "-          web: 443"]
    # the same lines at the end of other's hosts, plus the user it got from lab (other has none)
    assert lines[9:] == ["+      block:", "+        ip: 10.0.0.3     # moved in May", "+        title: 'Block box'",
                         "+        description: |", "+          Two lines", "+          of notes.",
                         "+        type: esxi", "+        user: ops", "+        services:", "+          web: 443"]
    assert pinned == ["user"] and h["group"] == "other" and h["ssh"]["user"] == "ops" and h["type"] == "esxi"
    assert new.endswith("      sw1: {ip: 10.0.1.1, user: net}\n" + "\n".join(x[1:] for x in lines[9:]) + "\n")


def test_a_short_host_grows_into_a_block_when_it_has_to_keep_something(inv):
    old, new, h, pinned = edit.moved(inv, "short", "other")
    assert pinned == ["type", "user"]
    assert changed_lines(old, new) == ["-      short: 10.0.0.1    # the old switch", "+      short:    # the old switch",
                                       "+        ip: 10.0.0.1", "+        user: ops", '+        type: ""']
    assert h["type"] == "" and h["ssh"]["user"] == "ops"


def test_moving_to_the_group_it_is_in_changes_nothing(inv):
    old, new, _, pinned = edit.moved(inv, "plain", "lab")
    assert old == new and pinned == []


def test_moving_to_an_unknown_group_is_refused(inv):
    with pytest.raises(Problem) as e:
        edit.moved(inv, "plain", "nope")
    assert e.value.code == UNKNOWN_GROUP and "lab, other" in e.value.message


def test_a_move_that_would_change_what_the_host_inherits_is_refused(write_config):
    path = write_config("groups:\n  a:\n    user: u\n    services:\n      web: 443\n    hosts:\n      h1: 10.0.0.1\n"
                        "  b:\n    user: u\n    hosts:\n      h2: 10.0.0.2\n")
    with pytest.raises(Problem) as e:
        edit.moved(path, "h1", "b")
    assert e.value.code == WOULD_CHANGE and "services" in e.value.data["fields"]


MESHED = ("groups:\n  lab:\n    user: u\n    mesh: true\n    hosts:\n      h1: 10.0.0.1\n      h2: 10.0.0.2\n"
          "  quiet:\n    user: u\n    mesh: false\n    hosts:\n      q1: 10.0.0.5\n"
          "  plain:\n    user: u\n    hosts:\n      p1: 10.0.0.9\n")


def test_moving_a_host_out_of_a_meshed_group_keeps_its_mesh_setting(write_config):
    path = write_config(MESHED)
    _, new, h, pinned = edit.moved(path, "h1", "plain")
    assert pinned == ["mesh"] and h["mesh"] is True and "      h1:\n        ip: 10.0.0.1\n        mesh: true\n" in new
    _, new, h, pinned = edit.moved(path, "q1", "lab")            # an opt-out stays an opt-out
    assert pinned == ["mesh"] and h["mesh"] is False


def test_moving_a_host_keeps_the_mesh_dir_it_inherited(write_config):
    from roster.config import load_config_text
    path = write_config(MESHED.replace("    mesh: true\n", "    mesh: true\n    mesh_dir: /srv/mesh\n"))
    _, new, _, pinned = edit.moved(path, "h1", "plain")
    assert pinned == ["mesh", "mesh_dir"] and "        mesh_dir: /srv/mesh\n" in new
    assert load_config_text(new, path)["mesh_dirs"]["h1"] == "/srv/mesh"
    _, new, moved = edit.group_deleted(path, "lab", "plain")
    assert moved == ["h1", "h2"] and load_config_text(new, path)["mesh_dirs"] == {"h1": "/srv/mesh", "h2": "/srv/mesh"}


def test_a_move_that_would_change_the_mesh_dir_is_caught(write_config):
    path = write_config(MESHED.replace("  plain:\n    user: u\n", "  plain:\n    user: u\n    mesh_dir: /opt/m\n"))
    _, new, _, pinned = edit.moved(path, "h1", "plain")       # h1 has none: it takes plain's, as any new member would
    assert pinned == ["mesh"]
    _, new, _, pinned = edit.moved(path, "p1", "lab")         # p1 had plain's: it keeps it
    assert pinned == ["mesh_dir"] and "        mesh_dir: /opt/m\n" in new


def test_a_host_with_no_mesh_setting_joins_the_mesh_of_the_group_it_moves_to(write_config):
    path = write_config(MESHED)
    _, _, h, pinned = edit.moved(path, "p1", "lab")
    assert pinned == [] and h["mesh"] is True


def test_deleting_a_meshed_group_moves_its_hosts_keeping_their_mesh_setting(write_config):
    path = write_config(MESHED)
    _, new, moved = edit.group_deleted(path, "lab", "plain")
    from roster.config import load_config_text
    cfg = load_config_text(new, path)
    assert moved == ["h1", "h2"] and cfg["hosts"]["h1"]["mesh"] is True and cfg["hosts"]["h2"]["mesh"] is True


LINKED = ("groups:\n  lab:\n    user: u\n    hosts:\n      h1: 10.0.0.1\n      h2: 10.0.0.2\n"
          "  far:\n    user: u\n    hosts:\n      f1: 10.0.9.1\n"
          "links:\n"
          "  - { from: h1, to: far }   # h1 backs up to far\n"
          "  - from: lab\n    to: f1\n    both: true\n"
          "  - { from: h2, to: f1 }\n")


def links_of(text, path):
    from roster.config import load_config_text
    return [(x["from"], x["to"], x["both"]) for x in load_config_text(text, path)["links"]]


def test_renaming_a_linked_host_or_group_renames_it_in_links(write_config):
    path = write_config(LINKED)
    old, new, _ = edit.renamed(path, "h1", "web-1")
    assert changed_lines(old, new) == ["-      h1: 10.0.0.1", "+      web-1: 10.0.0.1",
                                       "-  - { from: h1, to: far }   # h1 backs up to far",
                                       "+  - { from: web-1, to: far }   # h1 backs up to far"]
    old, new = edit.group_renamed(path, "far", "dr")
    assert links_of(new, path) == [("h1", "dr", False), ("lab", "f1", True), ("h2", "f1", False)]


def test_removing_a_linked_host_or_group_drops_the_links_that_name_it(write_config):
    path = write_config(LINKED)
    old, new, _ = edit.removed(path, "f1")
    assert links_of(new, path) == [("h1", "far", False)]
    assert changed_lines(old, new) == ["-      f1: 10.0.9.1", "-  - from: lab", "-    to: f1", "-    both: true",
                                       "-  - { from: h2, to: f1 }"]
    old, new, moved = edit.group_deleted(path, "far", "lab")
    assert moved == ["f1"] and links_of(new, path) == [("lab", "f1", True), ("h2", "f1", False)]


def test_removing_every_link_leaves_an_empty_links_key_that_loads(write_config):
    path = write_config(LINKED.replace("from: h1, to: far", "from: h1, to: f1"))
    _, new, _ = edit.removed(path, "f1")
    assert links_of(new, path) == [] and new.endswith("links:\n")


def test_a_link_in_a_one_line_list_is_refused_with_a_clean_error(write_config):
    path = write_config(LINKED.split("links:")[0] + "links: [{ from: h1, to: far }]\n")
    with pytest.raises(Problem) as e:
        edit.removed(path, "h1")
    assert e.value.code == INVALID_EDIT and "links: names h1" in e.value.message
    _, new, _ = edit.renamed(path, "h1", "web-1")                    # a rename only changes the name
    assert links_of(new, path) == [("web-1", "far", False)]


def test_moving_into_an_empty_group(write_config):
    path = write_config("groups:\n  a:\n    user: u\n    hosts:\n      h1: 10.0.0.1\n      h2: 10.0.0.2\n"
                        "  b:\n    user: u\n    hosts: {}\n  c:\n")
    _, new, _, _ = edit.moved(path, "h1", "b")
    assert "  b:\n    user: u\n    hosts:\n      h1: 10.0.0.1\n  c:\n" in new
    path.write_text(new)
    _, new, _, pinned = edit.moved(path, "h2", "c")
    assert new.endswith("  c:\n    hosts:\n      h2:\n        ip: 10.0.0.2\n        user: u\n") and pinned == ["user"]


def test_a_new_group_goes_after_the_last_one(inv):
    old, new = edit.group_added(inv, "dmz", "The DMZ")
    assert changed_lines(old, new) == ["+  dmz:", "+    title: The DMZ", "+    hosts: {}"]
    assert new.startswith(INVENTORY)


def test_a_host_can_be_added_to_a_new_empty_group(inv):
    _, new = edit.group_added(inv, "dmz")
    inv.write_text(new)
    old, new, h = edit.added(inv, "dmz", "web1", {"ip": "10.0.9.1", "user": "www"})
    assert changed_lines(old, new) == ["-    hosts: {}", "+    hosts:", "+      web1:", "+        ip: 10.0.9.1",
                                       "+        user: www"]
    assert h["group"] == "dmz"


@pytest.mark.parametrize("name, code", [("lab", NAME_TAKEN), ("a b", INVALID_HOST)])
def test_a_new_group_with_a_taken_or_bad_name_is_refused(inv, name, code):
    with pytest.raises(Problem) as e:
        edit.group_added(inv, name)
    assert e.value.code == code


def test_renaming_a_group_changes_only_its_key_and_its_hosts_follow(inv):
    old, new = edit.group_renamed(inv, "other", "net")
    assert changed_lines(old, new) == ["-  other:", "+  net:"]
    inv.write_text(new)
    from roster.config import load_config
    cfg = load_config(inv)
    assert list(cfg["groups"]) == ["lab", "net"] and cfg["hosts"]["sw1"]["group"] == "net"


def test_deleting_a_group_with_hosts_asks_where_they_go(inv):
    with pytest.raises(Problem) as e:
        edit.group_deleted(inv, "other")
    assert e.value.code == GROUP_NOT_EMPTY and e.value.data["hosts"] == ["sw1"]


def test_deleting_a_group_moves_its_hosts_first_when_told_where(inv):
    old, new, moved = edit.group_deleted(inv, "other", "lab")
    assert moved == ["sw1"]
    assert changed_lines(old, new) == ["+      sw1: {ip: 10.0.1.1, user: net, type: switch}", "-  other:",
                                       "-    type: switch", "-    hosts:", "-      sw1: {ip: 10.0.1.1, user: net}"]
    assert "  # a comment between groups\n" in new


def test_deleting_a_group_of_50_hosts_loads_roster_yml_a_constant_number_of_times_and_writes_no_file(
        write_config, monkeypatch):
    import tempfile

    from roster import config
    hosts = "".join(f"      h{i}: 10.0.2.{i}\n" for i in range(50))
    path = write_config(f"groups:\n  lab:\n    user: root\n    hosts:\n      keep: 10.0.0.1\n"
                        f"  big:\n    user: admin\n    type: switch\n    hosts:\n{hosts}")
    loads, temps = [], []
    real_load, real_mkstemp = config.parse_config, tempfile.mkstemp
    monkeypatch.setattr(config, "parse_config", lambda *a, **k: loads.append(1) or real_load(*a, **k))
    monkeypatch.setattr(tempfile, "mkstemp", lambda *a, **k: temps.append(k.get("dir")) or real_mkstemp(*a, **k))
    old, new, moved = edit.group_deleted(path, "big", "lab")
    assert len(moved) == 50 and len(loads) <= 3, len(loads)
    assert temps == []                                  # the checks write nothing, in the repo or anywhere
    cfg = config.load_config_text(new, path)
    assert all(cfg["hosts"][f"h{i}"]["group"] == "lab" and cfg["hosts"][f"h{i}"]["ssh"]["user"] == "admin"
               and cfg["hosts"][f"h{i}"]["type"] == "switch" for i in range(50))


def test_a_moved_host_that_would_come_out_different_names_itself_when_a_group_is_deleted(write_config):
    path = write_config("groups:\n  lab:\n    user: root\n    services: {web: 443}\n    hosts:\n"
                        "      keep: 10.0.0.1\n  old:\n    user: root\n    hosts:\n      a: 10.0.1.1\n"
                        "      b: 10.0.1.2\n")
    with pytest.raises(Problem) as e:
        edit.group_deleted(path, "old", "lab")
    assert e.value.code == WOULD_CHANGE and e.value.data["host"] == "a" and "services" in e.value.data["fields"]


def test_an_empty_group_is_deleted_whole(inv):
    _, new = edit.group_added(inv, "dmz")
    inv.write_text(new)
    old, new, moved = edit.group_deleted(inv, "dmz")
    assert moved == [] and new == INVENTORY


def test_an_unknown_host_or_group(inv):
    for fn, args, code in [(edit.removed, ("nope",), UNKNOWN_HOST), (edit.renamed, ("nope", "x"), UNKNOWN_HOST),
                           (edit.moved, ("nope", "lab"), UNKNOWN_HOST), (edit.group_renamed, ("nope", "x"), UNKNOWN_GROUP),
                           (edit.group_deleted, ("nope",), UNKNOWN_GROUP)]:
        with pytest.raises(Problem) as e:
            fn(inv, *args)
        assert e.value.code == code, fn.__name__


def test_removing_the_last_host_of_all_is_refused_because_it_wouldnt_load(write_config):
    path = write_config("groups:\n  a:\n    user: u\n    hosts:\n      h1: 10.0.0.1\n")
    with pytest.raises(Problem) as e:
        edit.removed(path, "h1")
    assert e.value.code == INVALID_EDIT and "defines no hosts" in e.value.details


def test_crlf_stays_crlf(write_config):
    path = write_config("")
    path.write_bytes(INVENTORY.replace("\n", "\r\n").encode())
    _, new, _, _ = edit.moved(path, "sw1", "lab")
    assert "\r\n" in new and "\n" not in new.replace("\r\n", "")


# ---------------------------------------------------------------- through serve, in a git repo

def git(cwd, *args):
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A scratch infra repo with INVENTORY committed (never the real ~/infra: serve gets -c to this one)."""
    for k, v in {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
                 "GIT_COMMITTER_EMAIL": "t@x", "GIT_CONFIG_NOSYSTEM": "1"}.items():
        monkeypatch.setenv(k, v)
    r = tmp_path / "infra"
    r.mkdir()
    git(r, "init", "-q", "-b", "main")
    (r / "roster.yml").write_text(INVENTORY)
    git(r, "add", "-A")
    git(r, "commit", "-q", "-m", "inventory")
    return r / "roster.yml"


class Live:
    """`roster serve` with a reader thread: responses by id, and notifications (no id) as they come."""

    def __init__(self, *args):
        self.p = subprocess.Popen([sys.executable, "-m", "roster", *args, "serve"], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.responses, self.notes, self.next_id = queue.Queue(), queue.Queue(), 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            msg = json.loads(line)
            (self.responses if "id" in msg else self.notes).put(msg)

    def call(self, method, params=None):
        self.next_id += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.next_id, "method": method,
                                       "params": params or {}}) + "\n")
        self.p.stdin.flush()
        r = self.responses.get(timeout=20)
        assert r["id"] == self.next_id
        return r

    def ok(self, method, params=None):
        r = self.call(method, params)
        assert "error" not in r, r
        return r["result"]

    def note(self, timeout):
        return self.notes.get(timeout=timeout)

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=10)


@pytest.fixture
def live(repo):
    started = []

    def _start():
        started.append(Live("-c", str(repo)))
        return started[-1]
    yield _start
    for s in started:
        if s.p.poll() is None:
            s.p.kill()
            s.p.wait()


def save(path, text):
    """Save as an editor that writes a new file and renames it over does (vim's default)."""
    tmp = path.with_name(path.name + ".swp")
    tmp.write_text(text)
    tmp.replace(path)


def names(s):
    return [h["name"] for h in s.ok("hosts.list")["hosts"]]


def test_inventory_edits_through_serve_are_pending_changes(live, repo):
    s = live()
    r = s.ok("host.remove", {"host": "block"})
    assert r["removed"] == "block" and r["group"] == "lab" and ".git/roster/roster.yml.bak" in r["backup"].replace("\\", "/")
    assert "block" not in names(s)
    assert s.ok("host.rename", {"host": "flow", "to": "flow-2"})["host"]["name"] == "flow-2"
    moved = s.ok("host.move", {"host": "sw1", "group": "lab"})
    assert moved["host"]["group"] == "lab" and moved["pinned"] == ["type"]
    assert s.ok("group.new", {"name": "dmz"})["group"] == "dmz"
    assert s.ok("group.rename", {"group": "dmz", "to": "edge"})["group"] == "edge"
    d = s.ok("changes.diff")
    assert sorted((c["host"], c["change"]) for c in d["hosts"]) == [
        ("block", "removed"), ("flow", "removed"), ("flow-2", "added"), ("sw1", "changed")]
    assert [(g["group"], g["change"]) for g in d["groups"]] == [("edge", "added")] and d["count"] == 4
    assert "# The lab. NO PASSWORDS IN THIS FILE." in repo.read_text()
    assert s.ok("hosts.list")["groups"].keys() == {"lab", "other", "edge"}


def test_group_delete_asks_where_its_hosts_go(live, repo):
    s = live()
    err = s.call("group.delete", {"group": "other"})["error"]
    assert err["code"] == GROUP_NOT_EMPTY and err["data"]["hosts"] == ["sw1"] and "fix" in err["data"]
    assert repo.read_text() == INVENTORY
    r = s.ok("group.delete", {"group": "other", "to": "lab"})
    assert r == {**r, "deleted": "other", "moved": ["sw1"], "to": "lab"}
    assert "other" not in s.ok("hosts.list")["groups"]


@pytest.mark.parametrize("method, params, code", [
    ("host.remove", {"host": "nope"}, UNKNOWN_HOST),
    ("host.rename", {"host": "flow", "to": "plain"}, NAME_TAKEN),
    ("host.move", {"host": "flow", "group": "nope"}, UNKNOWN_GROUP),
    ("group.new", {"name": "bad name"}, INVALID_HOST),
    ("host.rename", {"host": "flow"}, -32602),
])
def test_refusals_write_nothing(live, repo, method, params, code):
    s = live()
    assert s.call(method, params)["error"]["code"] == code
    assert repo.read_text() == INVENTORY


def test_an_edit_while_the_file_is_broken_is_refused_with_its_line(live, repo):
    s = live()
    save(repo, INVENTORY.replace("    hosts:\n      short", "    hosts:\n     short", 1))
    err = s.call("host.remove", {"host": "plain"})["error"]
    assert err["code"] == 1 and err["data"]["line"] > 0


def test_an_outside_edit_is_applied_within_a_second_with_auto_reload(live, repo):
    s = live()
    assert s.ok("inventory.watch", {"auto": True})["watching"] is True
    save(repo, INVENTORY.replace("      plain:", "      plain2:"))
    start = time.monotonic()
    n = s.note(timeout=1.0)
    assert time.monotonic() - start < 1.0
    assert n == {"jsonrpc": "2.0", "method": "inventory.changed", "params": {"applied": True, "error": None}}
    assert "plain2" in names(s) and "plain" not in names(s)


def test_a_broken_edit_keeps_the_last_good_inventory_and_says_the_line_then_recovers(live, repo):
    s = live()
    s.ok("inventory.watch", {"auto": True})
    save(repo, INVENTORY.replace("      flow: {ip: 10.0.0.2", "      flow: {ip: 10.0.0.2,,"))
    n = s.note(timeout=1.0)["params"]
    assert n["applied"] is True and n["error"]["line"] == 11 and n["error"]["path"] == str(repo)
    listed = s.ok("hosts.list")
    assert "flow" in [h["name"] for h in listed["hosts"]] and listed["error"]["line"] == 11
    save(repo, INVENTORY.replace("      plain:", "      fixed:"))
    assert s.note(timeout=1.0)["params"] == {"applied": True, "error": None}
    listed = s.ok("hosts.list")
    assert listed["error"] is None and "fixed" in [h["name"] for h in listed["hosts"]]


def test_without_auto_reload_an_outside_edit_is_only_reported_until_source(live, repo):
    s = live()
    assert s.ok("inventory.watch", {"auto": False}) == {"watching": True, "auto": False, "path": str(repo)}
    save(repo, INVENTORY.replace("      plain:", "      plain2:"))
    assert s.note(timeout=1.0)["params"] == {"applied": False, "error": None}
    assert "plain" in names(s)                   # not applied yet
    with pytest.raises(queue.Empty):
        s.note(timeout=0.6)                      # told once, not again and again
    r = s.ok("inventory.reload")
    assert r["changed"] is True and r["error"] is None and "plain2" in names(s)


def test_source_with_a_broken_file_keeps_the_last_good(live, repo):
    s = live()
    assert len(names(s)) == 6
    repo.write_text("groups: [\n")
    r = s.ok("inventory.reload")
    assert r["error"]["line"] and r["host_count"] == 6 and len(names(s)) == 6


def test_serves_own_writes_are_not_outside_edits(live, repo):
    s = live()
    s.ok("inventory.watch", {"auto": False})
    s.ok("host.remove", {"host": "plain"})
    with pytest.raises(queue.Empty):
        s.note(timeout=0.8)
