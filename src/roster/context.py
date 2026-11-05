"""The Inventory a run uses (ticket 115) and the files roster keeps for each Inventory.

One process uses one Inventory (serve restarts to switch): config.find_config picks it as it finds roster.yml and
calls use(). A named Inventory has files of its own (its ssh config, known_hosts, Mesh state, key-name, rotation
record, lock), so syncing one never wipes another's; the unnamed one (no named Inventories, or a roster.yml that
isn't one of them) has the files roster always wrote. FILES is the one table of them: every path comes from it, and
`roster inv remove` walks it.

Imports nothing of roster's: it is what everything else stands on."""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple

WINDOWS = os.name == "nt"


def ssh_dir() -> Path:
    return Path.home() / ".ssh"


def user_config_dir() -> Path:
    """roster's own folder: ~/.config/roster, or %APPDATA%\\roster on Windows (where the app's init.lua is too)."""
    if WINDOWS:
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "roster"
    return Path.home() / ".config" / "roster"


class File(NamedTuple):
    """One per-Inventory file: the folder it's in, its name for the unnamed Inventory, its name for a named one
    ({} is the name), and what `inv remove` does with a named one's: delete it, or set it aside (renamed
    NAME.removed-TIME) so a new Inventory of that name never inherits it."""

    folder: Callable[[], Path]
    unnamed: str
    named: str
    on_remove: str      # "delete" or "set aside"


FILES = {
    # Not in config.d: a user's `Include ~/.ssh/config.d/*` would read it beside the index, and a Host the index
    # leaves out (a name clash) would add its IdentityFile again (PR #335's review, N3).
    "ssh_config": File(ssh_dir, "config.d/roster", "roster-inventories/{}", "delete"),
    "known_hosts": File(ssh_dir, "roster_known_hosts", "roster_known_hosts-{}", "set aside"),
    "mesh_state": File(user_config_dir, "mesh.json", "mesh-{}.json", "set aside"),          # T182
    # the Box name this Box's key lines on the Inventory's Hosts were last all tagged with (T217)
    "key_name": File(user_config_dir, "key-name", "key-name-{}", "delete"),
    # the Box key rotation's pending record (T240): the Hosts not finished yet
    "rotation": File(user_config_dir, "key-rotation", "key-rotation-{}", "set aside"),
    # the Box-wide lock (boxlock, T240)
    "lock": File(user_config_dir, "run.lock", "run-{}.lock", "delete"),
}


@dataclass(frozen=True)
class Context:
    """An Inventory: NAME among the named Inventories (None: unnamed) and the roster.yml at PATH (None: not looked
    up), with its files."""

    name: str | None = None
    path: Path | None = None

    def file(self, kind: str) -> Path:
        f = FILES[kind]
        return f.folder() / (f.unnamed if self.name is None else f.named.format(self.name))

    @property
    def ssh_config(self) -> Path:
        return self.file("ssh_config")

    @property
    def known_hosts(self) -> Path:
        return self.file("known_hosts")

    @property
    def mesh_state(self) -> Path:
        return self.file("mesh_state")

    @property
    def key_name(self) -> Path:
        return self.file("key_name")

    @property
    def rotation(self) -> Path:
        return self.file("rotation")

    @property
    def lock(self) -> Path:
        return self.file("lock")

    @property
    def legacy_ssh_config(self) -> Path | None:
        """Where a named Inventory's ssh config was before it moved out of config.d (None for the unnamed one)."""
        return None if self.name is None else ssh_dir() / "config.d" / f"roster-{self.name}"

    @property
    def known_hosts_label(self) -> str:
        """known_hosts as messages name it: ~/.ssh/roster_known_hosts (or -NAME)."""
        return f"~/.ssh/{self.known_hosts.name}"

    def files(self) -> dict[str, Path]:
        return {kind: self.file(kind) for kind in FILES}


_current = Context()


def current() -> Context:
    """The Inventory this run uses."""
    return _current


def use(name: str | None, path: Path | None = None) -> Context:
    global _current
    _current = Context(name, Path(path) if path is not None else None)
    return _current


def key_created_file() -> Path:
    """When roster made or rotated each of this Box's keys (T240): a line per key file (`ISO-TIME<TAB>PATH`). One key
    file serves every Inventory that names it, so one record for the Box."""
    return user_config_dir() / "key-created"


def ssh_index_file() -> Path:
    """With named Inventories: the file ~/.ssh/config includes, which includes each one's ssh config, the active
    one's first."""
    return ssh_dir() / "config.d" / "roster.inventories"
