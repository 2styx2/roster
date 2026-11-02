"""Editing one Host in roster.yml as text (ticket 10), so comments, order, quoting and every other entry stay
byte-for-byte, the way `discover --write` adds a group. PyYAML's node marks say where each value sits in the
text; only those spans change. A result that doesn't load, that loads to anything but the values asked for, or
that changes any other Host, group or resource is refused, and nothing is written."""

import json
import os
import re
import shutil
import tempfile
from pathlib import Path

import yaml

from .common import NAME_RE, oneline
from .config import GROUP_ONLY, first, load_config_text, resolve_ssh
from .errors import (
    GROUP_NOT_EMPTY,
    HOST_EXISTS,
    INVALID_EDIT,
    INVALID_HOST,
    NAME_TAKEN,
    UNKNOWN_GROUP,
    UNKNOWN_HOST,
    WOULD_CHANGE,
    Problem,
)

TEXT = ("title", "description", "type")
LOGIN_FIELDS = ("ip", "user", "port", "auth")       # an edit to these needs a test login first (decision Q43)
EDITABLE = TEXT + LOGIN_FIELDS
SSH_KEYS = ("user", "port", "auth")                 # can live in the Host's ssh: block


FLAGS = ("enroll", "reviewed")
NEW_FIELDS = ("ip", "user", "port", "auth", *FLAGS, *TEXT)          # what host.add can set


def current(h):
    """The editable fields of a loaded Host, as the edit form shows them, and its flags."""
    return {"title": h["title"], "description": h["description"], "type": h["type"], "ip": h["ip"],
            "user": h["ssh"]["user"], "port": h["ssh"]["port"], "auth": h["ssh"]["auth"],
            "enroll": h["enroll"], "reviewed": h["reviewed"], "mesh": h["mesh"]}


def check_value(field, v):
    """A value from the app for FIELD, or a ValueError saying what's wrong with it."""
    if field not in EDITABLE:
        raise ValueError(f"{field!r} can't be edited here (only {', '.join(EDITABLE)})")
    if field == "port":
        if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 65535:
            raise ValueError("port must be a number from 1 to 65535")
        return v
    if not isinstance(v, str):
        raise ValueError(f"{field} must be a string")
    if "\n" in v or "\r" in v:
        raise ValueError(f"{field} must be one line")
    v = " ".join(v.split())                 # as roster.yml's loader reads text (oneline)
    if field in ("ip", "user") and (not v or re.search(r"\s", v)):
        raise ValueError(f"{field} can't be empty or contain spaces")
    return v


# ---------------------------------------------------------------- rendering a value

def render(v, style=None):
    """V as YAML text: plain when that reads back as the same string, else double-quoted (JSON is valid YAML).
    STYLE is the replaced value's quoting, kept when it can hold V."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if style == "'" and "\n" not in v:
        return "'" + v.replace("'", "''") + "'"
    if style != '"' and v and v == v.strip() and not re.match(r"[-?:,\[\]{}#&*!|>'\"%@`]", v) \
            and ": " not in v and " #" not in v and not v.endswith(":") and reads_back(v):
        return v
    return json.dumps(v, ensure_ascii=False)


def reads_back(text):
    try:
        return yaml.safe_load(f"k: {text}\n") == {"k": text}
    except yaml.YAMLError:
        return False


# ---------------------------------------------------------------- finding the Host in the text

def child(mapping, key):
    """(key node, value node) of KEY in a MappingNode, or (None, None)."""
    for k, v in mapping.value:
        if isinstance(k, yaml.ScalarNode) and k.value == key:
            return k, v
    return None, None


def find_host(text, name):
    """(key node, value node) of Host NAME under groups: -> GROUP -> hosts:."""
    root = yaml.compose(text)
    if not isinstance(root, yaml.MappingNode):
        raise refuse("roster.yml isn't a mapping")
    _, groups = child(root, "groups")
    for _, group in (groups.value if isinstance(groups, yaml.MappingNode) else []):
        if not isinstance(group, yaml.MappingNode):
            continue
        _, hosts = child(group, "hosts")
        if isinstance(hosts, yaml.MappingNode):
            k, v = child(hosts, name)
            if k is not None:
                if v.start_mark.index < k.end_mark.index:      # an alias: the value sits at its anchor
                    raise refuse(f"{name} is a YAML alias (*), so editing it would edit another entry too")
                return k, v
    raise refuse(f"can't find {name} under groups: in roster.yml")


def refuse(why, details=None):
    return Problem(INVALID_EDIT, f"can't make that edit: {why} - nothing was written",
                   fix="edit roster.yml by hand, or undo the hand edit that confused it", details=details)


# ---------------------------------------------------------------- the edits, as spans of text

class Text:
    """The file's text plus edits as (start, end, replacement), applied right to left."""

    def __init__(self, text):
        self.text, self.edits = text, []
        self.nl = "\r\n" if "\r\n" in text else "\n"

    def replace(self, start, end, new):
        self.edits.append((start, end, len(self.edits), new))

    def result(self):
        out = self.text
        for start, end, _, new in sorted(self.edits, reverse=True):     # same place: in the order they came
            out = out[:start] + new + out[end:]
        return out

    def line_start(self, i):
        return self.text.rfind("\n", 0, i) + 1

    def line_end(self, i):
        j = self.text.find("\n", i)
        j = len(self.text) if j < 0 else j
        return j - 1 if j > 0 and self.text[j - 1] == "\r" else j


def set_scalar(t, node, value):
    if not isinstance(node, yaml.ScalarNode):
        raise refuse(f"its value at line {node.start_mark.line + 1} isn't a single value")
    new = render(value, node.style if node.style in ("'", '"') else None)
    if node.style in ("|", ">"):            # a block scalar's span ends after its last line break
        new += t.nl
    elif node.start_mark.index == node.end_mark.index:      # `key:` with nothing after it
        new = " " + new
    t.replace(node.start_mark.index, node.end_mark.index, new)


def add_key(t, mapping, key, value):
    """Add KEY: VALUE to a mapping node that doesn't have KEY."""
    line = f"{key}: {render(value)}"
    if mapping.flow_style:
        close = mapping.end_mark.index - 1
        if t.text[close] != "}":
            raise refuse(f"unexpected text at line {mapping.end_mark.line + 1}")
        t.replace(close, close, (", " if mapping.value else "") + line)
        return
    if not mapping.value:
        raise refuse(f"an empty mapping at line {mapping.start_mark.line + 1}")
    first = mapping.value[0][0]
    indent = first.start_mark.column
    if t.text[t.line_start(first.start_mark.index):first.start_mark.index].strip():
        raise refuse(f"the mapping at line {first.start_mark.line + 1} doesn't start on its own line")
    # after the last entry that fits on one line, so new keys follow the ones there; else first
    one_line = [(k, v) for k, v in mapping.value if k.start_mark.line == v.end_mark.line
                and not (isinstance(v, yaml.ScalarNode) and v.style in ("|", ">"))]
    if one_line:
        at = t.line_end(one_line[-1][1].end_mark.index)
        t.replace(at, at, t.nl + " " * indent + line)
    else:
        at = t.line_start(first.start_mark.index)
        t.replace(at, at, " " * indent + line + t.nl)


def remove_key(t, mapping, key):
    """Drop KEY's line from a block mapping, when it has one line to itself. False if it can't."""
    k, v = child(mapping, key)
    if k is None or mapping.flow_style or len(mapping.value) < 2 or k.start_mark.line != v.end_mark.line:
        return False
    start, end = t.line_start(k.start_mark.index), t.line_end(v.end_mark.index)
    if t.text[start:k.start_mark.index].strip() or t.text[v.end_mark.index:end].strip():
        return False                        # something else on the line (a comment stays with its value)
    end = t.text.find("\n", end)
    t.replace(start, len(t.text) if end < 0 else end + 1, "")
    return True


def set_key(t, mapping, key, value):
    _, v = child(mapping, key)
    if v is None:
        add_key(t, mapping, key, value)
    else:
        set_scalar(t, v, value)


def expand_short(t, key, node, fields):
    """`NAME: 10.0.0.1` with more than its address to set: becomes a block mapping, comment kept on the key line."""
    step = 2
    indent = key.start_mark.column + step
    start = node.start_mark.index
    while start > 0 and t.text[start - 1] in " \t":
        start -= 1
    after = t.text[node.end_mark.index:t.line_end(node.end_mark.index)]
    lines = [f"{' ' * indent}{k}: {render(v)}" for k, v in fields.items()]
    t.replace(start, t.line_end(node.end_mark.index), (after.rstrip() if after.strip() else "") + t.nl
              + t.nl.join(lines))


def edit_text(text, name, changes, drop_empty=True):
    """roster.yml's TEXT with Host NAME's fields set to CHANGES ({field: value}). DROP_EMPTY removes a text field's
    line instead of writing "" where it can."""
    try:
        key, node = find_host(text, name)
    except yaml.YAMLError as e:
        raise refuse("roster.yml doesn't parse", str(e)) from None
    t = Text(text)
    if isinstance(node, yaml.ScalarNode):
        if node.value == "" and node.style is None:
            raise refuse(f"{name} has no value in roster.yml")
        if set(changes) <= {"ip"}:
            set_scalar(t, node, changes["ip"])
            return t.result()
        fields = {"ip": changes.get("ip", node.value), **{k: v for k, v in changes.items() if k != "ip"}}
        expand_short(t, key, node, fields)
        return t.result()
    if not isinstance(node, yaml.MappingNode):
        raise refuse(f"{name}'s entry isn't a mapping")
    _, ssh = child(node, "ssh")
    for field, value in changes.items():
        # the Host's ssh: block, if it has one, is where its login lives (unless the Host sets it plainly)
        in_ssh = field in SSH_KEYS and isinstance(ssh, yaml.MappingNode) and \
            (child(ssh, field)[0] is not None or child(node, field)[0] is None)
        target = ssh if in_ssh else node
        if drop_empty and field in TEXT and value == "" and remove_key(t, target, field):
            continue
        set_key(t, target, field, value)
    return t.result()


# ---------------------------------------------------------------- checking and writing

def read_text(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def write_text(path, text):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def replace_file(path, text):
    """Write TEXT to PATH all at once (a temporary file beside it, then a rename), keeping PATH's mode."""
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".new", dir=path.parent)
    os.close(fd)
    try:
        write_text(tmp, text)
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def load_text(path, text):
    """load_config of TEXT as if it were PATH, in memory (nothing written anywhere). Raises Problem(INVALID_EDIT)."""
    try:
        return load_config_text(text, path)
    except SystemExit as e:
        msg = str(e.code).removeprefix("error: ")
        raise refuse("the result wouldn't load", msg.replace(str(Path(path).resolve()), path.name)) from None


def same_except(before, after, name):
    """Nothing but Host NAME changed between two loaded configs."""
    keep = ("hosts", "groups", "resources", "box", "providers", "links")
    hb = {k: v for k, v in before["hosts"].items() if k != name}
    ha = {k: v for k, v in after["hosts"].items() if k != name}
    return hb == ha and list(before["hosts"]) == list(after["hosts"]) and \
        all(before[k] == after[k] for k in keep if k != "hosts")


def edited(path, name, changes):
    """The new text of PATH with Host NAME edited, checked: it loads, Host NAME has exactly CHANGES, and nothing
    else changed. Returns (old text, new text, the new Host)."""
    text = read_text(path)
    before = load_text(path, text)
    last = None
    for drop_empty in (True, False):
        new_text = edit_text(text, name, changes, drop_empty)
        new = load_text(path, new_text)
        h = new["hosts"].get(name)
        if h is not None and all(current(h)[k] == v for k, v in changes.items()) and same_except(before, new, name):
            return text, new_text, h
        last = h
    got = ", ".join(f"{k} {current(last)[k]!r}" for k in changes if current(last)[k] != changes[k]) if last else ""
    raise refuse(f"the result loads differently than asked ({got or 'other entries changed'})")


def reviewed(path, name, flag):
    """edited() for the review flag. Un-reviewing a Host whose own `reviewed: true` sits over an unreviewed group
    (or defaults) drops that line rather than writing `reviewed: false` beside the group's, so a review made by
    mistake and taken back leaves the text as it was."""
    if not flag:
        text = read_text(path)
        try:
            _, node = find_host(text, name)
        except yaml.YAMLError as e:
            raise refuse("roster.yml doesn't parse", str(e)) from None
        t = Text(text)
        if isinstance(node, yaml.MappingNode) and remove_key(t, node, "reviewed"):
            new_text = t.result()
            try:
                before, new = load_text(path, text), load_text(path, new_text)
            except Problem:
                new = None
            h = new and new["hosts"].get(name)
            if h is not None and current(h)["reviewed"] is False and same_except(before, new, name):
                return text, new_text, h
    return edited(path, name, {"reviewed": flag})


# ---------------------------------------------------------------- adding a Host (ticket 11)

def check_new(field, v):
    """A value from the app for a new Host's FIELD, or a ValueError (check_value's, plus the flags)."""
    if field in FLAGS:
        if not isinstance(v, bool):
            raise ValueError(f"{field} must be true or false")
        return v
    if field not in NEW_FIELDS:
        raise ValueError(f"{field!r} can't be set here (only {', '.join(NEW_FIELDS)})")
    return check_value(field, v)


def invalid(field, message):
    return Problem(INVALID_HOST, message, {"field": field})


def inherited(text, group):
    """What a Host in GROUP gets without setting anything itself: {field: value} for NEW_FIELDS but ip."""
    raw = yaml.safe_load(text) or {}
    g = (raw.get("groups") or {}).get(group) or {}
    layers = [{}, {k: v for k, v in g.items() if k not in GROUP_ONLY}, raw.get("defaults") or {}]
    ssh = resolve_ssh("new", layers)
    out = {k: ssh[k] for k in SSH_KEYS} | {k: bool(first(layers, k, True)) for k in FLAGS}
    return out | {k: oneline(first(layers, k, "")) for k in TEXT} | {k: first(layers, k) for k in ("mesh", "mesh_dir")}


def last_value(node):
    """The last scalar (or flow collection) a block node's text ends with."""
    while isinstance(node, (yaml.MappingNode, yaml.SequenceNode)) and not node.flow_style and node.value:
        node = node.value[-1][1] if isinstance(node, yaml.MappingNode) else node.value[-1]
    return node


def append_lines(t, node, lines):
    """Add LINES (already indented) after the last line of NODE's text, comment and all."""
    end = last_value(node)
    if isinstance(end, yaml.ScalarNode) and end.style in ("|", ">"):     # its span ends after its last line break
        t.replace(end.end_mark.index, end.end_mark.index, t.nl.join(lines) + t.nl)
    else:
        at = t.line_end(end.end_mark.index)
        t.replace(at, at, t.nl + t.nl.join(lines))


def block_step(mapping, default=2):
    """How far a block mapping's entries indent their own block values (2 if none does)."""
    for k, v in mapping.value:
        if isinstance(v, yaml.MappingNode) and not v.flow_style and v.value:
            return v.value[0][0].start_mark.column - k.start_mark.column
    return default


def add_text(text, group, name, entry):
    """roster.yml's TEXT with Host NAME: ENTRY ({key: value}, written as given) added at the end of GROUP's hosts,
    or in a new GROUP after the last one."""
    groups = groups_node(text)
    t = Text(text)
    fields = [f"{k}: {render(v)}" for k, v in entry.items()]
    _, gnode = child(groups, group)
    if gnode is None:
        indent, step = groups.value[0][0].start_mark.column, block_step(groups)
        pad = [" " * (indent + step * n) for n in range(4)]
        append_lines(t, groups, [f"{pad[0]}{group}:", f"{pad[1]}hosts:", f"{pad[2]}{name}:",
                                 *(pad[3] + f for f in fields)])
        return t.result()
    _, hosts = child(gnode, "hosts") if isinstance(gnode, yaml.MappingNode) else (None, None)
    if is_empty(gnode) or (isinstance(gnode, yaml.MappingNode) and not gnode.flow_style
                           and (hosts is None or is_empty(hosts))):
        # a group with no Hosts yet (group.new writes `NAME:` with `hosts: {}`)
        insert_host(t, groups, group, [f"{name}:", *("  " + f for f in fields)])
        return t.result()
    if not isinstance(hosts, yaml.MappingNode) or hosts.flow_style or not hosts.value:
        raise refuse(f"group {group}'s hosts: isn't a block of Hosts (line {gnode.start_mark.line + 1})")
    indent = hosts.value[0][0].start_mark.column
    if isinstance(hosts.value[-1][1], yaml.MappingNode) and hosts.value[-1][1].flow_style:
        lines = [f"{' ' * indent}{name}: {{{', '.join(fields)}}}"]          # like the entry before it
    else:
        pad = " " * (indent + block_step(hosts))
        lines = [f"{' ' * indent}{name}:", *(pad + f for f in fields)]
    append_lines(t, hosts, lines)
    return t.result()


def same_plus(before, after, name):
    """AFTER is BEFORE with Host NAME (and maybe its new group) added, and nothing else changed."""
    keep = ("resources", "box", "providers")
    old = {k: v for k, v in after["hosts"].items() if k != name}
    return old == before["hosts"] and list(old) == list(before["hosts"]) and \
        all(after["groups"].get(g) == v for g, v in before["groups"].items()) and \
        all(before[k] == after[k] for k in keep)


def added(path, group, name, fields):
    """The new text of PATH with Host NAME added to GROUP (made if it's new), checked: it loads, the Host has
    exactly FIELDS (anything left out is inherited), and nothing else changed. Only the values it doesn't inherit
    are written. Returns (old text, new text, the new Host). Raises Problem: 80 a bad value, 81 the name is
    taken, 74 the result doesn't come out right."""
    if not NAME_RE.match(name):
        raise invalid("name", f"bad host name {name!r} (use letters, digits, . _ -)")
    if not NAME_RE.match(group):
        raise invalid("group", f"bad group name {group!r} (use letters, digits, . _ -)")
    if not fields.get("ip"):
        raise invalid("ip", f"host {name!r} has no ip")
    text = read_text(path)
    before = load_text(path, text)
    if name in before["hosts"]:
        raise Problem(HOST_EXISTS, f"host {name!r} is already in the Inventory (group {before['hosts'][name]['group']})",
                      {"group": before["hosts"][name]["group"]}, fix="pick another name, or edit that Host")
    base = inherited(text, group)
    if not (fields.get("user") or base["user"]):
        raise invalid("user", f"no user for {name} (set it on the Host, its group, or defaults)")
    entry = {"ip": fields["ip"]} | {k: fields[k] for k in NEW_FIELDS
                                     if k != "ip" and k in fields and fields[k] != base[k]}
    new_text = add_text(text, group, name, entry)
    after = load_text(path, new_text)
    h = after["hosts"].get(name)
    if h is None or h["group"] != group or any(current(h)[k] != v for k, v in fields.items()) \
            or not same_plus(before, after, name):
        raise refuse("the result loads differently than asked")
    return text, new_text, h


# ---------------------------------------------------------------- the Live Inventory (ticket 28)
# Removing, renaming and moving a Host, and adding, renaming and deleting a group, as text like the edits above:
# only the entry's own lines change (an entry's lines are its key's line through its value's last line, comments on
# them included), everything else stays byte for byte, and the result must load to exactly what was asked.

def groups_node(text):
    """The groups: mapping node of roster.yml's TEXT (a block mapping), or a refusal."""
    try:
        root = yaml.compose(text)
    except yaml.YAMLError as e:
        raise refuse("roster.yml doesn't parse", str(e)) from None
    _, groups = child(root, "groups") if isinstance(root, yaml.MappingNode) else (None, None)
    if not isinstance(groups, yaml.MappingNode) or groups.flow_style or not groups.value:
        raise refuse("roster.yml's groups: isn't a block of groups")
    return groups


# ---------------------------------------------------------------- the Mesh's links: naming a Host or group

def link_ends(text, name):
    """[(the links: item, its from:/to: value nodes that are NAME)] for each item of roster.yml's links: naming NAME."""
    root = yaml.compose(text)
    _, links = child(root, "links") if isinstance(root, yaml.MappingNode) else (None, None)
    out = []
    for item in links.value if isinstance(links, yaml.SequenceNode) else []:
        ends = [v for k, v in (item.value if isinstance(item, yaml.MappingNode) else [])
                if isinstance(k, yaml.ScalarNode) and k.value in ("from", "to") and isinstance(v, yaml.ScalarNode)
                and v.value == name]
        if ends:
            out.append((item, ends))
    return out


def rename_in_links(t, text, name, to):
    """Every from:/to: in links: that names NAME now names TO (its text only)."""
    for _, ends in link_ends(text, name):
        for v in ends:
            set_scalar(t, v, to)


def drop_links(t, text, name):
    """The links: items naming NAME taken out, line and all (a Host or group that's gone links nothing; Q63: the
    next `roster mesh` removes what they gave). Refused when an item doesn't have its own `- ` lines."""
    for item, _ in link_ends(text, name):
        start = t.line_start(item.start_mark.index)
        if t.text[start:item.start_mark.index].strip() != "-":
            raise refuse(f"links: names {name} at line {item.start_mark.line + 1}, in a list roster can't take an "
                         "entry out of: take it out of links: by hand first")
        end = t.text.find("\n", t.line_end(last_value(item).end_mark.index))
        t.replace(start, len(t.text) if end < 0 else end + 1, "")


def links_without(links, name):
    return [x for x in links if name not in (x["from"], x["to"])]


def links_renamed(links, name, to):
    return [{**x, "from": to if x["from"] == name else x["from"], "to": to if x["to"] == name else x["to"]}
            for x in links]


def group_entry(groups, group):
    """(key node, value node) of GROUP under groups:, or Problem(UNKNOWN_GROUP)."""
    k, v = child(groups, group)
    if k is None:
        names = ", ".join(str(gk.value) for gk, _ in groups.value)
        raise Problem(UNKNOWN_GROUP, f"no group named {group!r} in roster.yml (groups: {names})", {"group": group},
                      fix="pick one of the groups, or make it first (group.new)")
    return k, v


def host_entry(groups, name):
    """(group name, key node, value node, the group's hosts: node) of Host NAME."""
    for gk, g in groups.value:
        _, hosts = child(g, "hosts") if isinstance(g, yaml.MappingNode) else (None, None)
        if isinstance(hosts, yaml.MappingNode):
            k, v = child(hosts, name)
            if k is not None:
                if hosts.flow_style:
                    raise refuse(f"group {gk.value}'s hosts: is on one line (line {hosts.start_mark.line + 1})")
                if v.start_mark.index < k.end_mark.index:
                    raise refuse(f"{name} is a YAML alias (*), so changing it would change another entry too")
                return str(gk.value), k, v, hosts
    raise refuse(f"can't find {name} under groups: in roster.yml")


def entry_span(t, key, node):
    """(start, end) of the lines KEY: NODE take in a block mapping, from the start of the key's line through the line
    break after its value's last line."""
    start = t.line_start(key.start_mark.index)
    if t.text[start:key.start_mark.index].strip():
        raise refuse(f"line {key.start_mark.line + 1} has something before {key.value}")
    end = last_value(node)
    if isinstance(end, yaml.ScalarNode) and end.style in ("|", ">"):
        return start, end.end_mark.index                # its span already ends after its last line break
    j = t.text.find("\n", t.line_end(end.end_mark.index))
    return start, len(t.text) if j < 0 else j + 1


def entry_lines(t, key, node):
    """The entry's lines, without their line breaks, moved left so the key is at column 0."""
    start, end = entry_span(t, key, node)
    col = key.start_mark.column
    lines = [ln.rstrip("\r") for ln in t.text[start:end].split("\n")]
    while lines and not lines[-1].strip():
        lines.pop()
    return [ln[col:] if not ln[:col].strip() else ln.lstrip() for ln in lines]


def indented(lines, n):
    return [" " * n + ln if ln.strip() else "" for ln in lines]


def fill_empty(t, key, node, lines):
    """Give `KEY:` (nothing, null or {}) the block LINES (already indented) as its value."""
    colon = key.end_mark.index
    if t.text[colon:colon + 1] != ":":
        raise refuse(f"unexpected text after {key.value} at line {key.start_mark.line + 1}")
    empty_text = isinstance(node, yaml.ScalarNode) and node.start_mark.index == node.end_mark.index
    if not empty_text:
        t.replace(colon, node.end_mark.index, ":")      # `hosts: {}` or `hosts: null` -> `hosts:`
    at = t.line_end(colon)
    t.replace(at, at, t.nl + t.nl.join(lines))


def is_empty(node):
    if isinstance(node, yaml.ScalarNode):
        return node.tag.endswith(":null")
    return isinstance(node, yaml.MappingNode) and not node.value


def insert_host(t, groups, group, lines):
    """Add a Host entry (LINES with its key at column 0) at the end of GROUP's hosts:."""
    gk, g = group_entry(groups, group)
    step = block_step(groups)
    if is_empty(g):                                     # `lab:` or `lab: {}`
        pad = gk.start_mark.column + step
        fill_empty(t, gk, g, [" " * pad + "hosts:", *indented(lines, pad + step)])
        return
    if not isinstance(g, yaml.MappingNode) or g.flow_style:
        raise refuse(f"group {group} isn't a block mapping (line {gk.start_mark.line + 1})")
    hk, hosts = child(g, "hosts")
    if hk is None:
        pad = g.value[0][0].start_mark.column
        append_lines(t, g, [" " * pad + "hosts:", *indented(lines, pad + step)])
    elif is_empty(hosts):
        fill_empty(t, hk, hosts, indented(lines, hk.start_mark.column + block_step(g, step)))
    elif isinstance(hosts, yaml.MappingNode) and not hosts.flow_style:
        append_lines(t, hosts, indented(lines, hosts.value[0][0].start_mark.column))
    else:
        raise refuse(f"group {group}'s hosts: isn't a block of Hosts (line {hk.start_mark.line + 1})")


def check_name(field, name, what):
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise invalid(field, f"bad {what} name {name!r} (use letters, digits, . _ -)")


def taken(cfg, name, kind):
    """Problem(NAME_TAKEN) if a Host (kind "host") or group is already called NAME."""
    if kind == "host" and name in cfg["hosts"]:
        g = cfg["hosts"][name]["group"]
        return Problem(NAME_TAKEN, f"host {name!r} is already in the Inventory (group {g})", {"kind": kind, "group": g},
                       fix="pick another name")
    if kind == "group" and name in cfg["groups"]:
        return Problem(NAME_TAKEN, f"group {name!r} is already in roster.yml", {"kind": kind, "group": name},
                       fix="pick another name, or use that group")
    return None


def others_same(before, after, *, hosts=True, groups=True):
    keep = ("resources", "box", "providers")
    return all(before[k] == after[k] for k in keep) and (not hosts or before["hosts"] == after["hosts"]) and \
        (not groups or before["groups"] == after["groups"])


def without(d, *names):
    return {k: v for k, v in d.items() if k not in names}


def removed(path, name):
    """The new text of PATH with Host NAME's entry taken out, checked: it loads, the Host is gone, and nothing else
    changed. Its group stays, even when it's left empty. Returns (old text, new text, the Host as it was)."""
    text = read_text(path)
    before = load_text(path, text)
    h = before["hosts"].get(name)
    if h is None:
        raise Problem(UNKNOWN_HOST, f"unknown host {name!r}")
    t = Text(text)
    _, key, node, _ = host_entry(groups_node(text), name)
    start, end = entry_span(t, key, node)
    t.replace(start, end, "")
    drop_links(t, text, name)
    new_text = t.result()
    after = load_text(path, new_text)
    if after["hosts"] != without(before["hosts"], name) or list(after["hosts"]) != [n for n in before["hosts"]
                                                                                    if n != name] \
            or after["links"] != links_without(before["links"], name) or not others_same(before, after, hosts=False):
        raise refuse("the result loads differently than asked")
    return text, new_text, h


def renamed(path, name, to):
    """The new text of PATH with Host NAME renamed TO (its key's text, nothing else), checked: it loads, the Host is
    the same but for its name, in the same place, and nothing else changed. Returns (old, new, the renamed Host)."""
    check_name("name", to, "host")
    text = read_text(path)
    before = load_text(path, text)
    if name not in before["hosts"]:
        raise Problem(UNKNOWN_HOST, f"unknown host {name!r}")
    if name == to:
        return text, text, before["hosts"][name]
    p = taken(before, to, "host")
    if p:
        raise p
    t = Text(text)
    _, key, _, _ = host_entry(groups_node(text), name)
    set_scalar(t, key, to)
    rename_in_links(t, text, name, to)
    new_text = t.result()
    after = load_text(path, new_text)
    want = [to if n == name else n for n in before["hosts"]]
    h = after["hosts"].get(to)
    if list(after["hosts"]) != want or h != {**before["hosts"][name], "name": to} or \
            without(after["hosts"], to) != without(before["hosts"], name) or \
            after["links"] != links_renamed(before["links"], name, to) or not others_same(before, after, hosts=False):
        raise refuse("the result loads differently than asked (a resource may name the Host)")
    return text, new_text, h


def move_text(text, name, group):
    """TEXT with Host NAME's entry cut from its group and added at the end of GROUP's hosts:, re-indented."""
    groups = groups_node(text)
    _, key, node, _ = host_entry(groups, name)
    t = Text(text)
    lines = entry_lines(t, key, node)
    start, end = entry_span(t, key, node)
    t.replace(start, end, "")
    insert_host(t, groups, group, lines)
    return t.result()


def own_keys(text, group, name):
    """The keys Host NAME's entry sets itself (its ssh: block's too)."""
    raw = yaml.safe_load(text) or {}
    h = (((raw.get("groups") or {}).get(group) or {}).get("hosts") or {}).get(name)
    if not isinstance(h, dict):
        return {"ip"}
    return set(map(str, h)) | set(map(str, h.get("ssh") or {}) if isinstance(h.get("ssh"), dict) else ())


# What a move writes on the Host to keep it. A Host with no mesh: (or mesh_dir:) anywhere has nothing to keep: it
# takes the Mesh setting of the group it moves to, as any new member would (decision Q77).
PINNED = ("user", "port", "auth", "enroll", "reviewed", "mesh", "mesh_dir", *TEXT)
UNSET_JOINS = ("mesh", "mesh_dir")


def pinned_move(text, was_host, name, group, mesh_dir=None):
    """move_text, then whatever Host NAME (WAS_HOST, as loaded before, and its MESH_DIR, which the loaded config
    keeps beside its Hosts) would now inherit differently (its user, Login, flags, text, Mesh settings) written on
    the Host itself, so it comes out the same but for its group. Text only: nothing is loaded (check_moved checks
    the result). Returns (new text, the fields pinned)."""
    old = current(was_host) | {"mesh_dir": mesh_dir}
    was, will = inherited(text, was_host["group"]), inherited(text, group)
    own = own_keys(text, was_host["group"], name)
    pin = {k: old[k] for k in PINNED if was[k] != will[k] and old[k] != will[k] and k not in own
           and not (k in UNSET_JOINS and old[k] is None)}
    new_text = move_text(text, name, group)
    if pin:
        new_text = edit_text(new_text, name, pin, drop_empty=False)
    return new_text, sorted(pin)


def check_moved(before, after, names, group):
    """Each of Hosts NAMES came out in AFTER as it was in BEFORE but for its group, or Problem(WOULD_CHANGE)."""
    for name in names:
        h = after["hosts"].get(name)
        was = before["hosts"][name]
        dirs = before["mesh_dirs"].get(name), after["mesh_dirs"].get(name)
        differs = sorted([k for k in was if k != "group" and (h or {}).get(k) != was[k]
                          and not (k == "mesh" and was[k] is None)]
                         + (["mesh_dir"] if dirs[0] is not None and dirs[0] != dirs[1] else []))
        if h is None or h["group"] != group or differs:
            raise Problem(WOULD_CHANGE, f"{name} would come out different in group {group} ({', '.join(differs)} it "
                                        "inherits there) - nothing was written", {"host": name, "fields": differs},
                          fix=f"move it by hand in roster.yml, setting {', '.join(differs)} on {name} itself")


def moved(path, name, group):
    """The new text of PATH with Host NAME moved to the end of GROUP, checked: it loads, the Host is the same but for
    its group (what it inherited from the old group and wouldn't from the new one is written on it), and nothing
    else changed. Returns (old text, new text, the Host, the fields pinned)."""
    text = read_text(path)
    before = load_text(path, text)
    h = before["hosts"].get(name)
    if h is None:
        raise Problem(UNKNOWN_HOST, f"unknown host {name!r}")
    group_entry(groups_node(text), group)
    if h["group"] == group:
        return text, text, h, []
    new_text, pinned = pinned_move(text, h, name, group, before["mesh_dirs"].get(name))
    after = load_text(path, new_text)
    check_moved(before, after, [name], group)
    if without(after["hosts"], name) != without(before["hosts"], name) or not others_same(before, after, hosts=False):
        raise refuse("the result loads differently than asked")
    return text, new_text, after["hosts"][name], pinned


def group_added(path, name, title=""):
    """The new text of PATH with an empty group NAME after the last one (`NAME:` with `hosts: {}`, and its title if
    given), checked. Returns (old text, new text)."""
    check_name("group", name, "group")
    text = read_text(path)
    before = load_text(path, text)
    p = taken(before, name, "group")
    if p:
        raise p
    groups = groups_node(text)
    t = Text(text)
    indent, step = groups.value[0][0].start_mark.column, block_step(groups)
    lines = [f"{' ' * indent}{name}:", *([f"{' ' * (indent + step)}title: {render(title)}"] if title else []),
             f"{' ' * (indent + step)}hosts: {{}}"]
    append_lines(t, groups, lines)
    new_text = t.result()
    after = load_text(path, new_text)
    if after["groups"] != {**before["groups"], name: {"title": oneline(title), "description": ""}} or \
            not others_same(before, after, groups=False):
        raise refuse("the result loads differently than asked")
    return text, new_text


def group_renamed(path, group, to):
    """The new text of PATH with group GROUP renamed TO (its key's text), checked: its Hosts are the same but for
    their group, the group keeps its place, and nothing else changed. Returns (old text, new text)."""
    check_name("group", to, "group")
    text = read_text(path)
    before = load_text(path, text)
    gk, _ = group_entry(groups_node(text), group)
    if group == to:
        return text, text
    p = taken(before, to, "group")
    if p:
        raise p
    t = Text(text)
    set_scalar(t, gk, to)
    rename_in_links(t, text, group, to)
    new_text = t.result()
    after = load_text(path, new_text)
    hosts = {n: {**h, "group": to} if h["group"] == group else h for n, h in before["hosts"].items()}
    groups = {to if g == group else g: v for g, v in before["groups"].items()}
    if after["hosts"] != hosts or after["groups"] != groups or list(after["groups"]) != list(groups) or \
            after["links"] != links_renamed(before["links"], group, to) or \
            not others_same(before, after, hosts=False, groups=False):
        raise refuse("the result loads differently than asked (a resource may name the group)")
    return text, new_text


def group_deleted(path, group, to=None):
    """The new text of PATH with group GROUP's entry taken out, checked. A group that still has Hosts is refused
    (GROUP_NOT_EMPTY), unless TO names the group they move to first (as host.move moves them). Returns (old text,
    new text, the Hosts moved)."""
    text = read_text(path)
    before = load_text(path, text)
    group_entry(groups_node(text), group)
    members = [n for n, h in before["hosts"].items() if h["group"] == group]
    if members and to is None:
        raise Problem(GROUP_NOT_EMPTY, f"group {group} still has {len(members)} Host{'s' if len(members) > 1 else ''} "
                                       f"({', '.join(members)}) - say which group they go to, or move them first",
                      {"group": group, "hosts": members}, fix="pick the group its Hosts move to")
    if to is not None and members:
        if to == group:
            raise invalid("to", f"the Hosts of {group} can't move to {group} itself")
        group_entry(groups_node(text), to)
    new_text = text
    for name in members:                                # as text only; the result is loaded once, below
        new_text, _ = pinned_move(new_text, before["hosts"][name], name, to, before["mesh_dirs"].get(name))
    groups = groups_node(new_text)
    gk, g = group_entry(groups, group)
    t = Text(new_text)
    start, end = entry_span(t, gk, g)
    t.replace(start, end, "")
    drop_links(t, new_text, group)
    new_text = t.result()
    after = load_text(path, new_text)
    check_moved(before, after, members, to)
    hosts = {n: {**h, "group": to} if h["group"] == group else h for n, h in before["hosts"].items()}
    if after["hosts"] != hosts or after["groups"] != without(before["groups"], group) or \
            after["links"] != links_without(before["links"], group) or \
            not others_same(before, after, hosts=False, groups=False):
        raise refuse("the result loads differently than asked")
    return text, new_text, members
