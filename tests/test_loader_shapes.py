"""roster.yml keys of the wrong shape (#537): an InventoryError naming the file, the key and its line, never a
traceback."""

import pytest

from roster.config import load_config
from roster.errors import INVENTORY_ERROR, InventoryError


@pytest.mark.parametrize("value", ["3", "lab", "[a, b]"])
def test_a_group_that_isnt_a_mapping_names_the_group_and_its_line(write_config, value):
    p = write_config(f"groups:\n  ok:\n    user: u\n    hosts: {{h1: 10.0.0.1}}\n  lab: {value}\n")
    with pytest.raises(InventoryError) as e:
        load_config(p)
    assert e.value.message.startswith(f"{p.resolve()} at line 5: groups.lab: must be ")
    assert e.value.line == 5
    assert e.value.path == str(p.resolve())
    assert e.value.code == INVENTORY_ERROR


BASE = "groups:\n  ok:\n    user: u\n    hosts: {h1: 10.0.0.1}\n"
WRONG = {"a number": "3", "text": "lab", "a list": "[a, b]"}


@pytest.mark.parametrize("shape", WRONG)
@pytest.mark.parametrize(("text", "key", "line"), [
    ("defaults: {}\n" + BASE, "defaults", 1),
    (BASE + "links: {}\n", "links", 5),
    (BASE + "resources: {}\n", "resources", 5),
    (BASE + "providers: {}\n", "providers", 5),
    (BASE + "providers:\n  bw: {}\n", "providers.bw", 6),
    (BASE + "provider_dirs: {}\n", "provider_dirs", 5),
    ("groups:\n  lab:\n    user: u\n    hosts: {}\n", "groups.lab.hosts", 4),
    ("groups:\n  lab:\n    user: u\n    hosts:\n      h1: {}\n", "groups.lab.hosts.h1", 5),
])
def test_each_key_of_the_wrong_shape_is_named_with_its_line(write_config, text, key, line, shape):
    leaf = key.rsplit(".", 1)[-1]
    value = WRONG[shape]
    if key in ("links", "provider_dirs") and shape == "a list":
        value = "{a: 1}"                     # these want a list: a mapping is their wrong shape
    elif shape == "text" and key == "groups.lab.hosts.h1":
        value = "3"                          # a Host's text is its address
    text = text.replace(f"{leaf}: {{}}", f"{leaf}: {value}")
    with pytest.raises(InventoryError) as e:
        load_config(write_config(text))
    assert f" at line {line}: {key}: must be " in e.value.message, e.value.message
    assert e.value.line == line


@pytest.mark.parametrize("text", [
    BASE + "  lab:\n",                       # an empty group
    "defaults:\n" + BASE,
    BASE + "links:\nresources:\nproviders:\n  bw:\n",
])
def test_a_null_is_an_empty_one_as_before(write_config, text):
    assert "h1" in load_config(write_config(text))["hosts"]


def test_a_null_host_has_no_ip(write_config):
    with pytest.raises(InventoryError, match="'h2' has no ip"):
        load_config(write_config(BASE.replace("{h1: 10.0.0.1}", "{h1: 10.0.0.1, h2: }")))


def test_the_message_says_what_goes_there(write_config):
    p = write_config(BASE + "  lab: 3\n")
    with pytest.raises(InventoryError) as e:
        load_config(p)
    assert e.value.message == (f"{p.resolve()} at line 5: groups.lab: must be a mapping of the group's settings and hosts (user: deploy, "
                               "hosts: {web-01: 10.0.0.5}), not a number (3)")
    assert "at line 5" in e.value.fix

# ---------------------------------------------------------------- fuzz: every key of a full roster.yml, reshaped

FULL = {
    "box_name": "box-01", "key_type": "ed25519", "key_max_age": "365d", "workers": 8, "claude_inline_limit": 40,
    "rate_limited": ["10.0.0.0/8"], "provider_dirs": ["plugins"], "web_login_names": {"portal": "basic"},
    "providers": {"bw": {"sync": True}}, "bitwarden": {"sync": True},
    "defaults": {"user": "admin", "port": 22, "services": {"http": 80}, "ssh": {"port": 22}},
    "groups": {
        "lab": {"title": "Lab", "user": "deploy", "key_type": "ed25519",
                "hosts": {"web-01": "10.0.0.5",
                          "esx-02": {"ip": "10.0.0.6", "ssh": {"user": "root", "auth": "prompt"},
                                     "services": {"https": {"port": 443, "login": "portal"}, "db": 5432},
                                     "sudo": {"auth": "bw:esx-02 sudo"}, "seen_as": ["10.0.9.1"],
                                     "mesh": True, "os": "posix", "mesh_dir": "/opt/mesh", "tags": ["a"]}}},
        "net": {"hosts": {"sw-01": {"ip": "10.0.0.7", "user": "admin"}}},
    },
    "links": [{"from": "lab", "to": "net", "both": True}, {"from": "web-01", "to": "sw-01", "via": "esx-02"}],
    "resources": {"guest-wifi": {"type": "wifi", "ssid": "Guest", "auth": "bw:guest"},
                  "portal": {"type": "account", "url": "https://portal.example.com", "auth": "bw:portal"}},
}
SHAPES = [3, "x", [1, "two"], None, {"a": {"b": [1]}}, True, 1.5, [{"a": 1}], {}]


def key_paths(node, path=()):
    """Every key path in NODE (dict keys and list indexes), parents before children."""
    items = node.items() if isinstance(node, dict) else enumerate(node) if isinstance(node, list) else ()
    for k, v in items:
        yield (*path, k)
        yield from key_paths(v, (*path, k))


def reshaped(path, value):
    import copy
    doc = copy.deepcopy(FULL)
    node = doc
    for k in path[:-1]:
        node = node[k]
    node[path[-1]] = value
    return doc


def test_the_full_document_loads(write_config):
    import yaml
    load_config(write_config(yaml.safe_dump(FULL)))


@pytest.mark.parametrize("path", list(key_paths(FULL)), ids=lambda p: ".".join(map(str, p)))
def test_no_shape_of_any_key_escapes_as_a_traceback(write_config, path):
    import yaml

    from roster import providers
    for value in SHAPES:
        p = write_config(yaml.safe_dump(reshaped(path, value)))
        try:
            cfg = load_config(p)
            providers.setup_providers(cfg)
        except InventoryError as e:
            assert e.code == INVENTORY_ERROR and e.message, (path, value)
        finally:
            providers.reset()


@pytest.mark.parametrize("value", [s for s in SHAPES if s is not None and s != {}])
def test_a_whole_file_of_the_wrong_shape_is_an_inventory_error(write_config, value):
    import yaml
    with pytest.raises(InventoryError) as e:
        load_config(write_config(yaml.safe_dump(value)))
    assert e.value.code == INVENTORY_ERROR


def test_a_hidden_roster_yml_isnt_named(write_config, isolated):
    folder = isolated["work"] / ("A" * 32)
    folder.mkdir()
    p = folder / "roster.yml"
    p.write_text(BASE + "  lab: 3\n")
    with pytest.raises(InventoryError) as e:
        load_config(p)
    assert "A" * 32 not in e.value.message + e.value.fix
    assert e.value.message.startswith("the roster.yml at that path (not repeated) at line 5: groups.lab: ")
