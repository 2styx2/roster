"""T174 (#332, decision Q113): serve's `hosts.list` and `host.get` take their params and give their results as
Pydantic models (src/roster/servemodels.py), in the shape they always had: the app and Plugins read it. No value
ever shows in a repr or a validation error."""

import json

import pytest
from pydantic import ValidationError

from roster import serve as rpc
from roster.servemodels import HostGetParams, HostsListResult, InventoryError, NoParams, dump

INVENTORY = """\
groups:
  lab:
    title: Lab gear
    user: ops
    auth: "cmd:printf s3cret-in-cmd"
    hosts:
      box: {ip: 10.0.0.5, title: Lab box, web: "https://10.0.0.5", rack: B4}
      esx:
        ip: 10.0.0.6
        user: root
        enroll: false
        services:
          admin: {url: "https://10.0.0.6:943", user: webadmin, auth: env:WEB}
"""


@pytest.fixture
def state(write_config):
    return rpc.State(str(write_config(INVENTORY)))


def call(state, method, params=None):
    return rpc.respond(state, {"jsonrpc": "2.0", "id": 1, "method": method, **({} if params is None else
                                                                                {"params": params})})


def test_hosts_list_reads_as_its_result_model(state):
    model = HostsListResult.model_validate(call(state, "hosts.list")["result"])
    assert [h.name for h in model.hosts] == ["box", "esx"]
    assert model.hosts[0].model_extra == {"rack": "B4"}           # a key roster doesn't know stays on the Host
    assert model.error is None


def test_host_get_gives_the_host_as_hosts_list_does(state):
    box = call(state, "host.get", {"name": "box"})["result"]
    login = {"user": "ops", "auth": "cmd:printf s3cret-in-cmd"}
    assert box == {
        **login, "port": 22, "enroll": True, "web": "https://10.0.0.5",
        "services": {"web": {"port": 443, "url": "https://10.0.0.5", "scheme": "https", **login, "verify": True,
                             "login": "basic", "override": False}},
        "notes": "", "title": "Lab box", "description": "", "type": "", "product": "", "reviewed": True, "mac": "",
        "mesh": None, "os": None, "key_type": "ed25519", "key_file": box["key_file"], "ip": "10.0.0.5",
        "name": "box", "group": "lab", "ssh": {"port": 22, **login}, "login": login, "problems": [], "rack": "B4"}
    assert box["key_file"].endswith("roster_ed25519")
    assert box == call(state, "hosts.list")["result"]["hosts"][0]


@pytest.mark.parametrize("params, message", [
    ({}, "params.name must be a non-empty string"),
    ({"name": ""}, "params.name must be a non-empty string"),
    ({"name": 3}, "params.name must be a non-empty string"),
    ({"name": None}, "params.name must be a non-empty string"),
    ({"name": "box", "settled": "yes"}, "params.settled must be true or false"),
    ({"name": "box", "settled": 1}, "params.settled must be true or false"),
])
def test_host_get_refuses_bad_params_as_before(state, params, message):
    assert call(state, "host.get", params)["error"] == {"code": rpc.INVALID_PARAMS, "message": message}


def test_host_get_params_are_a_model():
    assert HostGetParams.parse({"name": "box"}) == HostGetParams(name="box", settled=False)
    assert HostGetParams.parse({"name": "box", "settled": True, "other": 1}).settled is True   # extra keys ignored
    assert NoParams.parse({"anything": 1}) == NoParams()


def test_a_bad_param_never_shows_its_value(state):
    err = call(state, "host.get", {"name": ["cmd:printf s3cret-in-params"]})["error"]
    assert "s3cret" not in json.dumps(err)
    with pytest.raises(ValidationError) as e:
        HostGetParams.model_validate({"name": ["cmd:printf s3cret-in-params"]})
    assert "s3cret" not in str(e.value)


def test_a_result_that_isnt_the_shape_is_refused_without_its_value(state):
    listing = call(state, "hosts.list")["result"]
    listing["hosts"][0]["port"] = "cmd:printf s3cret-in-port"
    with pytest.raises(ValidationError) as e:
        HostsListResult.model_validate(listing)
    assert "s3cret" not in str(e.value)


def test_no_login_reference_in_a_repr(state):
    text = repr(HostsListResult.model_validate(call(state, "hosts.list")["result"]))
    assert "s3cret" not in text and "cmd:" not in text and "env:WEB" not in text


def test_the_error_beside_the_last_good_inventory_keeps_its_shape(state):
    path = state.path
    path.write_text(path.read_text() + "  bad: [\n")
    call(state, "inventory.reload")
    error = call(state, "hosts.list")["result"]["error"]
    assert list(error) == ["message", "path", "line", "fix"]
    no_line = {"message": "m", "path": None, "fix": "f"}
    assert dump(InventoryError.model_validate(no_line)) == no_line      # `line` only when the error has one

