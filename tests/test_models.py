"""roster.yml loads into Pydantic models (T112, decision Q113): typed objects for new code, the same dicts as
before for the code that still reads them, roster's own errors for bad data, and never a secret in a repr or an
error."""

import subprocess
import sys

import pytest

from roster.config import load_config, load_inventory
from roster.errors import InventoryError
from roster.example import EXAMPLE_CONFIG
from roster.models import Host, Inventory, Service, WifiResource


def test_roster_yml_loads_into_models(write_config):
    inv = load_inventory(write_config(EXAMPLE_CONFIG))
    assert isinstance(inv, Inventory)
    db = inv.hosts["orion-db-01"]
    assert isinstance(db, Host)
    assert (db.ssh.user, db.ssh.port) == ("dbadmin", 2222)             # the host's own, over its group's
    assert db.group == "orion" and db.product == "orion"
    assert inv.groups["orion"].title == "Product Orion"
    assert inv.workers == 32 and isinstance(inv.workers, int)
    assert isinstance(inv.resources["office-wifi"], WifiResource)
    assert inv.resources["office-wifi"].security == "wpa2"             # the type's default
    assert list(inv.hosts) == list(load_config(write_config(EXAMPLE_CONFIG))["hosts"])   # roster.yml's order


def test_the_dict_view_is_plain_dicts(write_config):
    """load_config is load_inventory's dict view: what serve's hosts.list and --json have always returned."""
    h = load_config(write_config(EXAMPLE_CONFIG))["hosts"]["orion-web-01"]
    assert type(h) is dict and type(h["ssh"]) is dict and type(h["services"]) is dict
    assert set(h["ssh"]) == {"port", "user", "auth"}


def test_keys_roster_does_not_know_stay_on_the_host(write_config):
    cfg = load_config(write_config("groups:\n  a:\n    user: u\n    hosts:\n"
                                   "      h1: {ip: 10.0.0.1, shell_hooks: true, rack: B4}\n"))
    assert cfg["hosts"]["h1"]["shell_hooks"] is True and cfg["hosts"]["h1"]["rack"] == "B4"


def test_a_link_keeps_its_from_key(write_config):
    cfg = load_config(write_config("groups:\n  a:\n    user: u\n    hosts:\n      h1: 10.0.0.1\n      h2: 10.0.0.2\n"
                                   "links:\n  - {from: h1, to: h2}\n"))
    assert cfg["links"] == [{"from": "h1", "to": "h2", "both": False, "via": None}]


@pytest.mark.parametrize("key", ["workers", "claude_inline_limit"])
def test_a_bad_number_is_roster_s_error_naming_the_key(write_config, key):
    """Was a raw ValueError traceback; now roster's own error (code 1 in serve), with the key and not the value."""
    p = write_config(f"{key}: hunter2-not-a-number\ngroups:\n  a:\n    user: u\n    hosts:\n      h1: 10.0.0.1\n")
    with pytest.raises(InventoryError) as e:
        load_config(p)
    msg = e.value.message
    assert e.value.code == 1 and key in msg
    assert "hunter2" not in msg and "pydantic" not in msg.lower()


def test_no_reference_or_secret_in_a_repr(write_config):
    inv = load_inventory(write_config(EXAMPLE_CONFIG))
    web = inv.hosts["orion-web-01"]
    svc = next(iter(web.services.values()))
    assert isinstance(svc, Service)
    for obj in (web, web.ssh, web.login, svc, inv.resources["registrar"], inv):
        text = repr(obj)
        assert "bw:" not in text and "op:" not in text, text


def test_starting_roster_does_not_import_pydantic():
    """Pydantic costs more than the rest of roster.cli's imports together; only loading roster.yml pays for it."""
    out = subprocess.run([sys.executable, "-c", "import sys, roster.cli; print('pydantic' in sys.modules)"],
                         capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"
