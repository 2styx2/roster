"""The Plugin API's types (crates/roster-core/src/plugin/api/, ticket 70, decision Q89) against what
`roster serve` really sends: a Plugin gets a Host from `hosts.list` and `host.get`, so the reference's Host,
SshLogin, Login, Service, ServiceProblem, Group, HostList and InventoryInfo must list exactly the fields serve
gives. A field added on either side fails here: change plugin/api, then run
`cargo run -p roster-core --example gen_plugin_api`."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = json.loads((ROOT / "crates" / "roster-core" / "tests" / "fixtures" / "plugin-api.json").read_text("utf-8"))

# Every field a Host can have: a service with its own Login, one roster can't use (a problem), a group.
INVENTORY = """\
groups:
  lab:
    title: Lab gear
    user: ops
    auth: bw:lab ssh
    login: {user: admin, auth: bw:lab web}
    hosts:
      esx-02:
        ip: 10.0.0.5
        title: Lab box
        mac: "00:11:22:33:44:55"
        mesh: true
        services:
          web: {url: "https://10.0.0.5", user: webadmin, auth: env:WEB}
          bad: {port: 99999}
"""


def fields(type_name):
    return {f["name"] for f in API["types"][type_name]["fields"]}


def test_a_host_from_serve_has_exactly_the_documented_fields(serve, write_config):
    write_config(INVENTORY)
    s = serve()
    listing = s.call("hosts.list")["result"]
    host = listing["hosts"][0]
    assert set(listing) == fields("HostList")
    assert set(host) == fields("Host"), "change Host in crates/roster-core/src/plugin/api/"
    assert s.call("host.get", {"name": "esx-02"})["result"] == host
    assert set(host["ssh"]) == fields("SshLogin")
    assert set(host["login"]) == fields("Login")
    assert set(host["services"]["web"]) == fields("Service")
    assert [set(p) for p in host["problems"]] == [fields("ServiceProblem")]
    assert set(listing["groups"]["lab"]) == fields("Group")
    assert set(s.call("inventory.info")["result"]) == fields("InventoryInfo")


def test_the_writes_a_plugin_has_are_serves_inventory_writes():
    """inventory.write's functions are serve's host.update/rename/move/review, each a method that writes roster.yml
    (the Rust side's own tests check the Plugin runtime calls that method)."""
    from roster import serve as rpc
    for name, method in [("update", "host.update"), ("rename", "host.rename"), ("move", "host.move"),
                         ("review", "host.review")]:
        [fn] = [f for f in API["functions"] if f["path"] == f"roster.inventory.{name}"]
        assert fn["permission"] == "inventory.write" and fn["doc"].startswith(f"serve's [`{method}`]")
        assert set(rpc.WRITES_INVENTORY) <= set(rpc.METHODS[method].locks)
