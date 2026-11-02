from pathlib import Path

import pytest

from roster.common import user_config_dir
from roster.config import find_config, load_config, matches, selected
from roster.example import EXAMPLE_CONFIG


def test_example_config_loads_and_cascades(write_config):
    cfg = load_config(write_config(EXAMPLE_CONFIG))
    hosts = cfg["hosts"]
    assert set(hosts) == {"orion-dev-01", "orion-web-01", "orion-db-01", "net-sw-core-01", "net-rtr-edge-01"}
    assert hosts["orion-dev-01"]["user"] == "deploy"                 # from the group
    assert hosts["orion-db-01"]["user"] == "dbadmin"                 # host overrides group
    assert hosts["orion-db-01"]["port"] == 2222
    assert hosts["orion-dev-01"]["product"] == "orion"              # product cascades
    assert hosts["net-sw-core-01"]["enroll"] is False
    assert hosts["net-rtr-edge-01"]["title"] == "Edge router / internet gateway"
    # a group's own title describes the group and is not copied onto hosts
    assert cfg["groups"]["orion"]["title"] == "Product Orion"
    assert hosts["orion-web-01"]["title"] == "Orion - production web"
    assert hosts["orion-dev-01"]["reviewed"] is True


def test_duplicate_host_is_an_error(write_config):
    p = write_config("groups:\n  a: {user: u, hosts: {h1: 10.0.0.1}}\n  b: {user: u, hosts: {h1: 10.0.0.2}}\n")
    with pytest.raises(SystemExit, match="listed twice"):
        load_config(p)


def test_missing_user_is_an_error(write_config):
    with pytest.raises(SystemExit, match="no user"):
        load_config(write_config("groups:\n  a:\n    hosts:\n      h1: 10.0.0.1\n"))


def test_multiline_description_becomes_one_line(write_config):
    cfg = load_config(write_config("groups:\n  a:\n    user: u\n    hosts:\n      h1:\n        ip: 10.0.0.1\n"
                                   "        description: |\n          line one\n          line two\n"))
    assert cfg["hosts"]["h1"]["description"] == "line one line two"


def test_selected_by_name_group_type_product(write_config):
    cfg = load_config(write_config(EXAMPLE_CONFIG))
    names = lambda only: sorted(h["name"] for h in selected(cfg, only))  # noqa: E731
    assert names("switch,router") == ["net-rtr-edge-01", "net-sw-core-01"]
    assert names("orion") == ["orion-db-01", "orion-dev-01", "orion-web-01"]
    assert names("orion-db-01,network") == ["net-rtr-edge-01", "net-sw-core-01", "orion-db-01"]
    with pytest.raises(SystemExit):
        selected(cfg, "nothing-like-this")


def test_matches_every_word(write_config):
    cfg = load_config(write_config(EXAMPLE_CONFIG))
    hit = lambda text: sorted(h["name"] for h in cfg["hosts"].values() if matches(h, text))  # noqa: E731
    assert hit("orion prod") == ["orion-web-01"]
    assert hit("core-switch") == ["net-sw-core-01"]
    assert hit("postgres") == ["orion-db-01"]


def test_key_tag_pattern_includes_old_fleet_tag(write_config):
    cfg = load_config(write_config("box_name: ws1\ngroups:\n  a: {user: u, hosts: {h: 1.2.3.4}}\n"))
    assert cfg["tag"] == "roster-managed:ws1"
    assert "fleet-managed" in cfg["tag_re"] and cfg["tag_re"].endswith(":ws1$")


def test_find_config_order(isolated, monkeypatch):
    user_cfg = user_config_dir() / "roster.yml"        # ~/.config/roster, %APPDATA%\\roster on Windows
    user_cfg.parent.mkdir(parents=True)
    user_cfg.write_text("x")
    assert find_config(None) == user_cfg
    (isolated["work"] / "roster.yml").write_text("x")
    assert find_config(None) == isolated["work"] / "roster.yml"
    monkeypatch.setenv("ROSTER_CONFIG", "/somewhere/else.yml")
    assert find_config(None) == Path("/somewhere/else.yml")


# ---------------------------------------------------------------- shell_hooks (ticket 121)

def test_shell_hooks_is_passed_through_as_set_on_a_host_group_or_defaults(write_config):
    cfg = load_config(write_config(
        "defaults: {user: u, shell_hooks: true}\n"
        "groups:\n  lab: {hosts: {a1: 10.0.0.1, a2: {ip: 10.0.0.2, shell_hooks: false}}}\n"
        "  net: {shell_hooks: false, hosts: {sw1: 10.0.0.3}}\n"))
    assert [cfg["hosts"][h]["shell_hooks"] for h in ("a1", "a2", "sw1")] == [True, False, False]


def test_shell_hooks_must_be_true_or_false(write_config):
    with pytest.raises(SystemExit) as e:
        load_config(write_config("groups:\n  lab: {shell_hooks: yes-please, user: u, hosts: {a1: 10.0.0.1}}\n"))
    assert "shell_hooks: must be true or false" in str(e.value)
