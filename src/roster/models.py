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

    port: int = Field(description="The port (22 unless set).")
    user: str | None = Field(description="The user.")
    auth: str | None = Field(repr=False, description="Its Login reference (`prompt` unless set).")


class Login(Model, frozen=True):
    """The Host's default Login for its services (user and auth, unresolved)."""

    user: str | None = Field(description="The user; `null` if unset.")
    auth: str | None = Field(repr=False, description="The Login reference; `null` if unset.")


class Service(Model, frozen=True):
    """One of a Host's services, merged defaults <- group <- host. `override`: it sets its own user or auth."""

    port: int = Field(description="Its port.")
    url: str | None = Field(description="Its URL, for http and https services.")
    scheme: str | None = Field(description="`http`, `https`, or `null` when roster can't tell.")
    user: str | None = Field(description="Its user: its own, else the Host's `login.user`.")
    auth: str | None = Field(repr=False, description="Its Login reference: its own, else the Host's `login.auth`.")
    verify: bool = Field(description="Whether its TLS certificate is checked.")
    login: str = Field(description="How `roster web` signs in, resolved (never a `web_login_names` alias): `basic`, "
                       "`bearer`, `vsphere`, `unifi`, `openvpnas`, `hub` or `none`.")
    override: bool = Field(description="`true` when it has a Login of its own; `false` when it uses the Host's.")


class ServiceProblem(Model, frozen=True):
    """A service entry roster left out of the Inventory, and why: the rest of the Host still loads."""

    service: str = Field(description="The service's name.")
    message: str = Field(description="What's wrong, naming the service.")
    fix: str = Field(description="What to change.")


class Host(Model, frozen=True):
    """One Host. Keys roster doesn't know (shell_hooks, a team's own) stay on it as they were written."""

    model_config = ConfigDict(extra="allow")

    # in the order the dicts had before the models (HOST_DEFAULTS', then what each Host adds), so --json reads the same
    user: str | None = Field(description="The same as `ssh.user` (kept for older code).")
    port: int = Field(description="The same as `ssh.port`.")
    enroll: bool = Field(description="Whether `roster setup` puts this Box's key on it (`false`: password Sessions).")
    auth: str | None = Field(repr=False, description="The same as `ssh.auth`.")
    web: str | None = Field(description="Its web UI's URL: the `web` service's, else the first service given a URL.")
    services: dict[str, Service] = Field(description="Its services by name (`web`, `postgres`); `{}` when none.")
    notes: Any = Field(repr=False, description="The older name for `description`, as roster.yml has it.")
    title: str = Field(description="One line; `\"\"` if unset.")
    description: str = Field(description="One line; `\"\"` if unset.")
    type: str = Field(description="What it is (`esxi`, `linux`); `\"\"` if unset.")
    product: str = Field(description="Its product; `\"\"` if unset.")
    reviewed: bool = Field(description="`false` for a Host `discover` added and no one has reviewed: it can't be "
                           "opened until it is.")
    mac: Any = Field(repr=False, description="Its MAC address; `\"\"` if unset.")
    mesh: bool | None = Field(description="`mesh:` as roster.yml sets it; `null` if nothing does.")
    os: Literal["windows", "posix"] | None = Field(description="`os:` as roster.yml sets it (defaults, group, Host): "
                                                   "`windows` (setup, revoke and check run PowerShell there) or "
                                                   "`posix`; `null` if nothing does, which is `posix`.")
    key_type: str = Field(description="The SSH key type its key Login uses (T239): `key_type:` as roster.yml sets it "
                          "(Host, group, `defaults`, top level), canonical: `ed25519` (unset), `ecdsa` (P-384), "
                          "`ecdsa-256`, `ecdsa-521`, `rsa` (3072 bits) or `rsa-BITS`. Only an `enroll: true` Host "
                          "uses it.")
    key_file: str = Field(description="This Box's private key file for `key_type`, which roster's ssh config gives "
                          "it as `IdentityFile` (a path on this Box; never the key itself).")
    ip: str = Field(description="Its address (an IP or a DNS name).")
    name: str = Field(description="Its name in the Inventory, unique.")
    group: str = Field(description="The group it's in.")
    ssh: SshLogin = Field(description="How roster logs in to it over ssh: the most specific of the Host's, its "
                          "group's and `defaults:`.")
    login: Login = Field(description="The default Login for its services.")
    problems: list[ServiceProblem] = Field(description="Service entries roster left out because it can't use them; "
                                           "`[]` when there are none.")


class Group(Model, frozen=True):
    """A group of Hosts, by its name in `hosts.list`'s `groups`."""

    title: str = Field(description="One line; `\"\"` if unset.")
    description: str = Field(description="One line; `\"\"` if unset.")


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
    key_type: str = "ed25519"       # the top-level key_type: this Box's own key's (T239)
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
    rate_limited: list[str] = Field(default_factory=list)    # networks with an SSH rate limiter (T191, Q180)
    key_max_age: int | None = 365   # days before check --box warns the Box key is due a rotation; None: off (T240)

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
