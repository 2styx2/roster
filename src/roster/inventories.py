"""Naming, using and forgetting an Inventory (ticket 115, #201; `roster inv add/use/remove`, serve's inventories.*): the
list and the index are named.py's. Each named Inventory gets its own files (context.FILES): its generated ssh config
(~/.ssh/roster-inventories/NAME), known_hosts (~/.ssh/roster_known_hosts-NAME), Mesh state (mesh-NAME.json, T182)
and the rest; ROSTER.md is written next to its roster.yml, as always."""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Any, NamedTuple, cast

from . import sshconfig
from .context import FILES, Context
from .errors import BAD_INVENTORY, INVENTORY_TAKEN, InventoryError, Problem
from .named import (
    Inventories,
    Named,
    load,
    name_problem,
    refresh_index,
    same_file,
    same_name,
    save,
    unknown,
    unnamed_source,
)
from .sshconfig import SSH_UNSAFE


class Added(NamedTuple):
    """What `inv add` did besides naming: whether the Inventory became the active one, and where the Mesh state it took
    over went (None when it took none)."""

    first: bool
    mesh_state: Path | None
    mesh_kept: str | None = None    # why the Box's mesh.json stayed with the unnamed Inventory (when it's there)


def check_new(name: str, path: str | Path, exists: bool = True) -> Path:
    """Why NAME can't name the roster.yml at PATH (with EXISTS false, one that isn't there yet): Problem BAD_INVENTORY
    (a bad name or path) or INVENTORY_TAKEN (the name, the file or its folder is another named Inventory's), with
    data.field: name or path. Returns PATH, resolved."""
    why = name_problem(name or "")
    if why:
        raise Problem(BAD_INVENTORY, why, {"field": "name"})
    path = Path(path).expanduser().resolve()
    if SSH_UNSAFE.search(str(path)):
        raise Problem(BAD_INVENTORY, f"{path!r} has a quote or a control character in it - move or rename the file",
                      {"field": "path"})
    if exists and not path.is_file():
        raise Problem(BAD_INVENTORY, f"no file at {path} - give the path of the Inventory's roster.yml",
                      {"field": "path"})
    for x in load().inventories:
        if same_name(x.name, name):
            raise Problem(INVENTORY_TAKEN, f"there's already an Inventory named '{x.name}' ({x.path}) - pick another "
                                           f"name, or `roster inv remove {x.name}` first", {"field": "name"},
                          fix=f"give it another name, or `roster inv remove {x.name}` first")
        if same_file(x.path, path):
            raise Problem(INVENTORY_TAKEN, f"{path} is already the Inventory '{x.name}'", {"field": "path"})
        if same_file(x.path.parent, path.parent):
            raise Problem(INVENTORY_TAKEN, f"{path.parent} already holds the Inventory '{x.name}', and ROSTER.md is "
                                           "written next to each roster.yml: keep each Inventory in its own folder",
                          {"field": "path"})
    return path


def add(name: str, path: str | Path) -> Added:
    """Name the roster.yml at PATH (check_new's Problems). The first one named becomes the active one. Its known_hosts
    starts as the one every roster.yml on this Box shared before named Inventories, so no host key the Box trusted is
    trusted anew; the Box's unnamed Mesh state moves to it when it's this file's (take_mesh_state)."""
    path = check_new(name, path)
    inv = load()

    first = inv.active is None
    inv = Inventories(active=name if first else inv.active, inventories=(*inv.inventories, Named(name=name, path=path)))
    save(inv)
    seed_known_hosts(name)
    moved, kept = take_mesh_state(name, path)
    refresh(inv)
    return Added(first, moved, kept)


def refresh(inv: Inventories) -> None:
    """After the list changed: the index, and each Inventory's ROSTER.md (which Hosts are left out changed)."""
    from .claude import refresh_roster_md
    refresh_index(inv)
    refresh_roster_md(inv)


def take_mesh_state(name: str, path: Path) -> tuple[Path | None, str | None]:
    """T182 (#346): the Box's one Mesh state (mesh.json, from before Mesh state was per Inventory) moves to the
    Inventory NAME, once, only when everything says it is PATH's (#367's review, F2): roster's unnamed ssh config was
    last written from PATH (the Mesh reaches its Hosts over it), every Host the state names is a Host of PATH, and its
    last complete apply (when it has one) was of PATH's Mesh as it is now. The header alone only says what synced last.
    Otherwise it stays the unnamed Inventory's. A Mesh state NAME has already is never overwritten.
    Returns (where it went, or None; why it stayed, when it's there and didn't move)."""
    shared, mine = Context().mesh_state, Context(name).mesh_state
    if not shared.is_file():
        return None, None
    if mine.exists():
        return None, f"{name} has a Mesh state already ({mine})"
    source = unnamed_source()
    if source is None or not same_file(source, path):
        return None, ("roster's unnamed ssh config wasn't last written from this file, so nothing says the Mesh state "
                      "is this file's")
    from . import mesh
    from .config import load_config
    try:
        cfg = load_config(path)
    except InventoryError:
        return None, "this file doesn't load, so it can't be compared with the Mesh state"
    m = cast("Any", mesh)                       # mesh.py has no types yet
    st = m.read_state(Context())
    if st is None or not m.named_hosts(st) <= set(cfg["hosts"]):
        return None, "it names Hosts this file doesn't have"
    if st.get("applied") is not None and st["applied"] != m.digest(cfg):
        return None, "its last apply was of another Mesh than this file's"
    try:
        os.replace(shared, mine)
    except FileNotFoundError:                   # another roster took it first
        return None, None
    return mine, None


def seed_known_hosts(name: str) -> None:
    """NAME's own known_hosts, started as a copy of the one all of this Box's roster.yml files shared before named
    Inventories (~/.ssh/roster_known_hosts), whichever file it was last written from: the trust the Box had, kept."""
    shared, new = Context().known_hosts, Context(name).known_hosts
    if new.exists() or not shared.is_file():
        return
    shutil.copyfile(shared, new)
    os.chmod(new, 0o600)


def use(name: str) -> None:
    inv = load()
    found = inv.get(name)
    if found is None:
        unknown(name, inv)
    inv = inv.model_copy(update={"active": found.name})
    save(inv)
    refresh(inv)


class Removed(NamedTuple):
    """What `inv remove` did: whether NAME was the active one, and where its known_hosts, Mesh state and pending Box
    key rotation record went (None when it had none)."""

    was_active: bool
    known_hosts: Path | None
    mesh_state: Path | None
    rotation: Path | None = None


def set_aside(f: Path) -> Path | None:
    """Rename F to F.removed-TIME (None when F isn't there)."""
    if not f.exists():
        return None
    kept = f.with_name(f"{f.name}.removed-{time.strftime('%Y%m%d-%H%M%S')}")
    os.replace(f, kept)
    return kept


def remove(name: str) -> Removed:
    """Forget NAME (its roster.yml stays) and every file roster keeps for it (context.FILES): its generated ssh
    config, key-name, key-types and lock go; its known_hosts, Mesh state and Box key rotation record are set aside
    (renamed roster_known_hosts-NAME.removed-TIME, ...), so a new Inventory of that name never inherits another
    file's keys, Mesh or pending rotation."""
    inv = load()
    x = inv.get(name)
    if x is None:
        unknown(name, inv)
    was_active = same_name(inv.active, x.name)
    inv = Inventories(active=None if was_active else inv.active,
                      inventories=tuple(y for y in inv.inventories if y.name != x.name))
    save(inv)
    ctx = Context(x.name)
    kept: dict[str, Path | None] = {}
    for kind, f in ctx.files().items():
        if FILES[kind].on_remove == "set aside":
            kept[kind] = set_aside(f)
        else:
            f.unlink(missing_ok=True)
    legacy = ctx.legacy_ssh_config
    if legacy is not None and sshconfig.generated(legacy):
        legacy.unlink(missing_ok=True)
    refresh(inv)
    return Removed(was_active, kept["known_hosts"], kept["mesh_state"], kept["rotation"])
