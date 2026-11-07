"""The CLI's `--json` documents as Pydantic models (decision Q113, ticket T176): one per command (docs/cli-reference.md,
"Machine-readable output"), so a document's shape is checked before it's printed. jsonout.emit dumps one, puts
`version` first and cuts every `cmd:`/`env:` reference, as before.

Each dumps to exactly what the command always printed: fields in the order the dicts had them, and a field that's
optional in the document (`code?`, `fix?`, `error?`) left out when it isn't set rather than printed as null. The
Host, group and resource objects are models.py's, the same ones serve's `hosts.list` sends (servemodels.py).

Strict: a document refuses what isn't its shape (no "yes" for true, no 1 for "1"), unknown keys too. Neither a
repr nor a validation error shows a value: Login references and the messages that may quote one are left out of
reprs. Imported only when a --json command prints (Pydantic costs ~75 ms). Strict for the type checker
(pyproject.toml)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .models import Group, Host, Resource
from .servemodels import Result as Part  # a document or a part of one: serve's results' rules
from .servemodels import dump


def plain(doc: object) -> dict[str, Any]:
    """DOC as the command prints it (before `version` and the cut), as serve sends a result (servemodels.dump)."""
    if not isinstance(doc, BaseModel):
        raise TypeError(f"a --json document is a model in roster.jsondocs, not {type(doc).__name__}")
    return dump(doc)


# ---------------------------------------------------------------- the Inventory: hosts, info, resources

class HostsDoc(Part, frozen=True):
    """`roster hosts --json`: serve's hosts.list for the same filters, the resources, and how many unreviewed Hosts
    were left out."""

    hosts: list[Host]
    resources: list[Resource]
    groups: dict[str, Group]
    hidden: int


class GroupRef(Part, frozen=True):
    name: str
    title: str
    description: str


class HostInfoDoc(Part, frozen=True):
    """`roster hosts HOST --json`."""

    host: Host
    group: GroupRef | None


class ResourceInfoDoc(Part, frozen=True):
    """`roster hosts RESOURCE --json`."""

    resource: Resource
    group: GroupRef | None


class ResourcesDoc(Part, frozen=True):
    """`roster hosts --resources --json`."""

    resources: list[Resource]


# ---------------------------------------------------------------- checks

class MeshLink(Part, frozen=True):
    """A Link of the Mesh (mesh.graph's), with what a plan found (`status`, `why`) once it has looked."""

    from_: str = Field(alias="from")
    to: str
    kind: str
    via: str | None = None
    skip: str | None = None
    status: str | None = None
    why: str | None = None


class MeshHost(Part, frozen=True):
    """A Host a plan visited: what it would change, and the error when it didn't answer."""

    host: str
    changes: list[str]
    status: str
    error: str | None = Field(None, repr=False)


class MeshPlanDoc(Part, frozen=True):
    """`roster mesh --dry-run --json` (mesh.plan), and `check --json`'s `mesh`."""

    applied: bool
    links: list[MeshLink]
    hosts: list[MeshHost]
    excluded: dict[str, str]
    reach: dict[str, int]
    pending: dict[str, str] = Field(repr=False)
    already: bool
    warnings: list[str]
    cut_pending: dict[str, list[str]]


class MeshStatusDoc(Part, frozen=True):
    """`roster mesh status --json` (mesh.status): no connections."""

    links: list[MeshLink]
    excluded: dict[str, str]
    reach: dict[str, int]
    members: list[str]
    pending: dict[str, str] = Field(repr=False)
    cut_pending: dict[str, list[str]]
    out_of_date: bool
    warnings: list[str]


class LoginProblem(Part, frozen=True):
    """Why a key login failed, and its one fix (T243: catchup.explain; codes as errors.py's). Never a value."""

    code: int
    message: str = Field(repr=False)
    fix: str | None = None


class HostCheck(Part, frozen=True):
    name: str
    ok: bool
    ssh: Literal["login", "port"]
    checks: dict[str, bool]
    problem: LoginProblem | None = None     # T243: the failed key login's cause and fix


class CheckDoc(Part, frozen=True):
    """`roster check --json`: each Host's ports or login, and the Mesh's drift (null with no Mesh or --only)."""

    hosts: list[HostCheck]
    mesh: MeshPlanDoc | None
    rotation_pending: dict[str, str] = Field(default_factory=dict)    # the Box key rotation: host: why
    rotation_problems: list[str] = Field(default_factory=list)        # the rotation's record or key files, each said
    key_type_drift: dict[str, str] = Field(default_factory=dict)      # a key line of another type: host: why
    ok: bool


class Step(Part, frozen=True):
    """A step of `roster check HOST` (host.check's)."""

    step: str
    status: Literal["ok", "fail", "skipped"]
    code: int | None = None
    message: str = Field(repr=False)
    fix: str | None = None
    details: str | None = Field(None, repr=False)
    data: dict[str, Any] | None = Field(None, repr=False)


class CheckHostDoc(Part, frozen=True):
    """`roster check HOST --json`."""

    host: str
    ok: bool
    steps: list[Step]


class BoxCheck(Part, frozen=True):
    """A check of `roster check --box` (box.check's)."""

    section: str
    level: Literal["ok", "warn", "error"]
    message: str = Field(repr=False)
    fix: str | None = None
    topic: str | None = None
    code: int | None = None                     # the check's own code (the CLI shows it as `[CODE] `)
    saved_session: Literal["none", "working", "expired", "ignored", "unknown"] | None = None   # a vault's saved session


class BoxCheckDoc(Part, frozen=True):
    """`roster check --box --json`."""

    checks: list[BoxCheck]
    ok: bool


# ---------------------------------------------------------------- discover

class FoundPort(Part, frozen=True):
    port: int
    name: str
    product: str
    title: str


class Found(Part, frozen=True):
    """A Host the scan found (discover.status's Found)."""

    address: str
    name: str | None
    type: str
    hostname: str
    title: str
    web: str | None
    known: str | None
    added: str | None
    vendor: str
    os: str
    mac: str
    ports: list[FoundPort]


class DiscoverDoc(Part, frozen=True):
    """`roster discover CIDR... --json`: the preview, after the scan."""

    targets: list[str]
    addresses: int
    ports: int
    scanner: Literal["nmap", "built-in"]
    count: int
    quiet: int
    found: list[Found]
    group: str


# ---------------------------------------------------------------- Logins and providers

class Provider(Part, frozen=True):
    name: str
    kind: str
    help: str
    tool: str | None
    installed: bool | None
    used_by: list[str]


class ProvidersDoc(Part, frozen=True):
    """`roster vault status --json` (was `roster providers --json`): the providers, then each vault's state as
    `roster check --box` says it and when `roster vault sync` last synced each one that syncs (null: never)."""

    providers: list[Provider]
    unknown: list[str]
    ok: bool
    vault: list[BoxCheck] = []
    last_sync: dict[str, str | None] = {}


class UsedFor(Part, frozen=True):
    service: str
    hosts: list[str]


class LoginRow(Part, frozen=True):
    """A Login reference of `roster check --auth --json`, and whether a value was found (never the value)."""

    group: str
    auth: str | None = Field(repr=False)
    users: list[str]
    used_for: list[UsedFor]
    status: Literal["ok", "fail", "ask"]
    error: str | None = Field(None, repr=False)


class LoginsDoc(Part, frozen=True):
    """`roster check --auth --json`."""

    logins: list[LoginRow]
    ok: bool


class VaultItem(Part, frozen=True):
    """A vault item no Login in roster.yml names (fromvault.row), and the Host it suggests. Never a value."""

    provider: str
    id: str
    name: str
    auth: str
    new: bool
    host: str | None = None
    address: str | None = None
    port: int | None = None
    user: str | None = None
    note: str | None = None


class VaultItemsDoc(Part, frozen=True):
    """`roster add --from-vault --json` (no NAME): the items (new ones, or every one with --all), how many no Login
    names, and how many of those are new."""

    items: list[VaultItem]
    unmapped: int
    new: int


# ---------------------------------------------------------------- named Inventories

class NamedInventory(Part, frozen=True):
    name: str
    path: str
    active: bool
    exists: bool


class InventoriesDoc(Part, frozen=True):
    """`roster inv list --json` (inventories.list's)."""

    active: str | None
    inventories: list[NamedInventory]


class WhichDoc(Part, frozen=True):
    """`roster inv which --json`: the roster.yml roster uses, and its name among the named Inventories."""

    path: str
    name: str | None
    exists: bool


# ---------------------------------------------------------------- Agents (herdr, ADR 0011)

class AgentMachine(Part, frozen=True):
    """A machine added on the Hub, as herdr-core says: connected, connecting or unavailable."""

    name: str
    state: str


class Agent(Part, frozen=True):
    """A terminal that reports an agent status to herdr (OSC 7501). `address` is HOST/TERMINAL, the Hub's too, so
    one address means one terminal wherever the directory is read. Never its screen text."""

    address: str
    host: str
    terminal: str
    app: str
    status: str                         # herdr's word: working, blocked, idle or done
    label: str                          # the terminal's `roster.label`, "" without one
    folder: str
    parent: str | None
    started: str                        # ISO-8601, UTC


class AgentDirectoryDoc(Part, frozen=True):
    """`roster agents --json`: the Agent directory (version 1, the herdr-roster spec), built on the Hub from
    `hc ls --json` and each Agent's `hc get`. `you` is the machine this copy was written to, null on the Hub. No
    secret, no screen text."""

    hub: str
    you: str | None
    updated: str                        # ISO-8601, UTC
    machines: list[AgentMachine]
    agents: list[Agent]


# ---------------------------------------------------------------- errors

class Error(Part, frozen=True):
    code: int
    message: str = Field(repr=False)
    fix: str | None


class ErrorDoc(Part, frozen=True):
    """An error, on stderr: the code is serve's (errors.py)."""

    error: Error
