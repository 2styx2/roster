"""roster.yml's Inventory as Pydantic models (decision Q113, ticket T112): Hosts with their ssh and service
Logins, groups, Links and resources. config.py builds them when it loads roster.yml; `Inventory.as_config()` is the
dict view the older code, serve's results and `--json` still read, in the shape they always had.

Pydantic is imported only when roster.yml is loaded (config.py imports this module lazily), so `roster --help` and
the like don't pay for it. An `auth:` is a vault reference, never a value, but no repr shows one anyway, nor a key
roster doesn't know (it could hold anything); `problem()` words a ValidationError without the value that failed.
Strict for the type checker (pyproject.toml)."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class Model(BaseModel, frozen=True):
    """A part of the Inventory, read-only: unknown keys refused, and the repr shows only declared fields that aren't
    hidden."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    def __repr_args__(self) -> Any:
        return ((k, v) for k, v in super().__repr_args__() if k in type(self).model_fields)


class SshLogin(Model, frozen=True):
    """How `ssh NAME` logs in: the most specific of the Host's, its group's and the defaults' ssh: block or plain
    user/port/auth."""

    port: int
    user: str | None
    auth: str | None = Field(repr=False)


class Login(Model, frozen=True):
    """The Host's default Login for its services (user and auth, unresolved)."""

    user: str | None
    auth: str | None = Field(repr=False)


class Service(Model, frozen=True):
    """One of a Host's services, merged defaults <- group <- host. `override`: it sets its own user or auth."""

    port: int
    url: str | None
    scheme: str | None
    user: str | None
    auth: str | None = Field(repr=False)
    verify: bool
    login: str
    override: bool


class ServiceProblem(Model, frozen=True):
    """A service entry roster left out of the Inventory, and why: the rest of the Host still loads."""

    service: str
    message: str
    fix: str


class Host(Model, frozen=True):
    """One Host. Keys roster doesn't know (shell_hooks, a team's own) stay on it as they were written."""

    model_config = ConfigDict(extra="allow")

    # in the order the dicts had before the models (HOST_DEFAULTS', then what each Host adds), so --json reads the same
    user: str | None
    port: int
    enroll: bool
    auth: str | None = Field(repr=False)
    web: str | None
    services: dict[str, Service]
    notes: Any = Field(repr=False)
    title: str
    description: str
    type: str
    product: str
    reviewed: bool
    mac: Any = Field(repr=False)
    mesh: bool | None
    ip: str
    name: str
    group: str
    ssh: SshLogin
    login: Login
    problems: list[ServiceProblem]


class Group(Model, frozen=True):
    title: str
    description: str


class Link(Model, frozen=True):
    """A Mesh Link from roster.yml's links: (decision Q63): one-way unless both, through `via` when set."""

    from_: str = Field(alias="from")
    to: str
    both: bool
    via: str | None


class ResourceBase(Model, frozen=True):
    """The fields every resource has (resources.COMMON), in the order every view shows them."""

    name: str
    type: str
    title: str
    description: str
    group: str
    user: str
    auth: str = Field(repr=False)


class WifiResource(ResourceBase, frozen=True):
    type: Literal["wifi"]
    ssid: str
    security: str
    hidden: bool


class AccountResource(ResourceBase, frozen=True):
    type: Literal["account"]
    url: str


class SecretResource(ResourceBase, frozen=True):
    type: Literal["secret"]


Resource = Annotated[WifiResource | AccountResource | SecretResource, Field(discriminator="type")]


class Inventory(Model, frozen=True):
    """roster.yml, loaded and checked, with what this box derives from it (its name, key, key tag)."""

    path: Path
    box: str
    tag: str
    tag_re: str
    key: Path
    pub: Path
    workers: int = Field(ge=1)
    inline_limit: int = Field(ge=1)
    hosts: dict[str, Host]
    groups: dict[str, Group]
    mesh_dirs: dict[str, str]
    seen_as: dict[str, list[str]]
    sudo: dict[str, str] = Field(repr=False)
    resources: dict[str, Resource]
    links: list[Link]
    providers: dict[str, Any] = Field(repr=False)
    provider_dirs: list[str]

    def as_config(self) -> dict[str, Any]:
        """The dict the older code reads (`cfg["hosts"][name]["ssh"]["user"]`), the same keys as before T112."""
        return self.model_dump(by_alias=True)


# roster.yml's own names for fields the Inventory keeps under another
FILE_KEYS = {"inline_limit": "claude_inline_limit"}


def problem(e: ValidationError) -> str:
    """What's wrong, by where it is in roster.yml, in one line per error: never the value that failed (it could be
    a secret written in the wrong place), never Pydantic's own text around it."""
    lines: list[str] = []
    for err in e.errors(include_url=False, include_input=False, include_context=False):
        loc = [str(x) for x in err["loc"]]
        if len(loc) >= 2 and loc[0] in ("hosts", "groups", "resources"):
            where = f"{loc[0].rstrip('s')} {loc[1]!r}" + (f": {'.'.join(loc[2:])}" if loc[2:] else "")
        else:
            where = ".".join([FILE_KEYS.get(loc[0], loc[0]), *loc[1:]]) if loc else "roster.yml"
        lines.append(f"{where}: {err['msg'][0].lower()}{err['msg'][1:]}")
    return "; ".join(lines)
