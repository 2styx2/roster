"""serve's params and results as Pydantic models (decision Q113, ticket T174): `hosts.list` and `host.get` so far;
the other methods move here as tickets touch them. Each result dumps to exactly the JSON serve always sent (the
app's types and Plugins read it): the Host and group objects are models.py's, and a field that's optional in the
answer (`line`) is left out when it isn't set rather than sent as null.

Every model refuses what isn't its shape (strict: no "yes" for true, no 1 for "1"), and neither a repr nor a
validation error shows a value: a Login reference stays out of reprs (models.py), and an error names the field.
Strict for the type checker (pyproject.toml)."""

from __future__ import annotations

from typing import Any, ClassVar, TypeVar

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .errors import INVALID_PARAMS, Problem
from .models import Group, Host

P = TypeVar("P", bound="Params")


class Params(BaseModel, frozen=True):
    """A method's params. Keys it doesn't know are ignored, as serve always did; a bad one is -32602 with the
    sentence `MESSAGES` gives that field, never the value."""

    model_config = ConfigDict(extra="ignore", strict=True, hide_input_in_errors=True)
    MESSAGES: ClassVar[dict[str, str]] = {}

    @classmethod
    def parse(cls: type[P], params: dict[str, Any]) -> P:
        try:
            return cls.model_validate(params)
        except ValidationError as e:
            loc = e.errors(include_url=False, include_input=False)[0]["loc"]
            field = str(loc[0]) if loc else ""
            raise Problem(INVALID_PARAMS, f"params.{field} {cls.MESSAGES.get(field, 'is not valid')}") from None


class Result(BaseModel, frozen=True):
    """A method's result (and a --json document, jsondocs.py): read-only, unknown keys refused, no value in a repr or
    a validation error."""

    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True, populate_by_name=True)


class NoParams(Params, frozen=True):
    """Params: none (whatever is sent is ignored)."""


class HostGetParams(Params, frozen=True):
    """host.get's: `{name}`, or `{name, settled: true}` (API 20)."""

    MESSAGES: ClassVar[dict[str, str]] = {"name": "must be a non-empty string", "settled": "must be true or false"}
    name: str = Field(min_length=1, description="The Host's exact name.")
    settled: bool = Field(False, description="Wait for a write to roster.yml under way first.")


class InventoryError(Result, frozen=True):
    """`hosts.list`'s `error` (API 8): why roster.yml as it is now doesn't load, while the last good Inventory is
    shown (catalog row 1)."""

    message: str = Field(description="What's wrong, with the line for a YAML error.")
    path: str | None = Field(description="The `roster.yml` that doesn't load.")
    line: int | None = Field(None, description="The line a YAML error is at; left out when there's none.")
    fix: str | None = Field(description="What to do about it.")


class HostsListResult(Result, frozen=True):
    """hosts.list's: every Host in roster.yml order, the groups, and `error` (API 8)."""

    hosts: list[Host]
    groups: dict[str, Group]
    error: InventoryError | None


def dump(result: BaseModel) -> dict[str, Any]:
    """RESULT as serve sends it: roster.yml's own key names (`from`), and the optional fields that aren't set left
    out. A Host's every field is always set, the keys roster doesn't know too, so it dumps whole."""
    return result.model_dump(by_alias=True, exclude_unset=True)
