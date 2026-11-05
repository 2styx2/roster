"""web_login_names: a team's own name for one of roster's web login types."""

import pytest

from roster.config import load_config

HOSTS = """\
groups:
  lab:
    user: admin
    hosts:
      box1:
        ip: 10.0.0.1
        services:
          web: {url: "https://10.0.0.1", login: appliance}
"""


def test_own_name_behaves_as_the_type_it_names(write_config):
    cfg = load_config(write_config("web_login_names: {appliance: hub}\n" + HOSTS))
    assert cfg["hosts"]["box1"]["services"]["web"]["login"] == "hub"


def test_a_file_without_the_name_still_loads_with_the_service_marked_broken(write_config):
    h = load_config(write_config(HOSTS))["hosts"]["box1"]
    assert "web" not in h["services"] and h["web"] is None
    [p] = h["problems"]
    assert p["service"] == "web"
    assert p["message"] == "service 'web': login: 'appliance' isn't a login type roster knows"
    assert "basic, bearer" in p["fix"] and "web_login_names: {appliance: TYPE}" in p["fix"]


@pytest.mark.parametrize("names, err", [
    ("{hub: basic}", "'hub' is already one of roster's login types"),
    ("{appliance: hubb}", "'appliance' maps to 'hubb'"),
    ("{appliance: }", "'appliance' maps to None"),
    ("[appliance]", "web_login_names: must be a mapping"),
])
def test_bad_names_fail_the_load_naming_the_key(write_config, names, err):
    with pytest.raises(SystemExit, match=err):
        load_config(write_config(f"web_login_names: {names}\n" + HOSTS))


def test_an_unused_name_is_fine_and_builtin_types_still_work(write_config):
    cfg = load_config(write_config("web_login_names: {portal: bearer}\n" + HOSTS.replace("appliance", "hub")))
    assert cfg["hosts"]["box1"]["services"]["web"]["login"] == "hub"
    assert cfg["hosts"]["box1"]["problems"] == []


# ---------------------------------------------------------------- edits keep the file's own word

def test_an_edit_keeps_the_files_own_login_name_byte_for_byte(write_config):
    from roster import edit
    text = "web_login_names: {appliance: hub}\n" + HOSTS
    path = write_config(text)
    old, new, h = edit.edited(path, "box1", {"title": "Lab box"})
    assert h["services"]["web"]["login"] == "hub"
    assert new.replace("        title: Lab box\n", "") == old
    assert "login: appliance}" in new


def test_a_host_with_a_broken_service_can_still_be_edited_and_renamed(write_config):
    from roster import edit
    path = write_config(HOSTS)
    _, new, h = edit.edited(path, "box1", {"title": "Lab box"})
    assert [p["service"] for p in h["problems"]] == ["web"]
    path.write_text(new)
    _, new, h = edit.renamed(path, "box1", "box2")
    assert h["name"] == "box2" and [p["service"] for p in h["problems"]] == ["web"]


# ---------------------------------------------------------------- the CLI reports problems as warnings

def test_hosts_check_auth_check_and_info_report_the_problem(write_config, capsys, monkeypatch):
    from roster import cli
    write_config(HOSTS)
    monkeypatch.setattr(cli, "tcp_ok", lambda *a, **k: True)       # no network
    monkeypatch.setattr(cli, "ssh_ok", lambda *a, **k: True)
    for argv in (["hosts"], ["check"], ["check", "--auth"]):
        cli.main(argv)
        err = capsys.readouterr().err
        assert "warning: box1 service 'web': login: 'appliance' isn't a login type roster knows" in err, argv
        assert "fix: set login: to one of" in err, argv
    assert cli.main(["hosts", "box1"]) == 0
    out = capsys.readouterr().out
    assert "problems" in out and "service 'web': login: 'appliance'" in out


def test_with_the_name_mapped_nothing_is_reported(write_config, capsys):
    from roster.cli import main
    write_config("web_login_names: {appliance: hub}\n" + HOSTS)
    assert main(["hosts"]) == 0
    assert capsys.readouterr().err == ""


# ---------------------------------------------------------------- roster serve

def test_serve_lists_a_hosts_problems_beside_it(serve, write_config):
    write_config(HOSTS + "      box2: {ip: 10.0.0.2}\n")
    s = serve()
    r = s.call("hosts.list")["result"]
    assert r["error"] is None
    hosts = {h["name"]: h for h in r["hosts"]}
    [p] = hosts["box1"]["problems"]
    assert p["service"] == "web" and "login: 'appliance'" in p["message"] and "web_login_names" in p["fix"]
    assert hosts["box2"]["problems"] == []
    assert s.call("host.get", {"name": "box1"})["result"]["problems"] == [p]


def test_serve_shows_the_resolved_login_type(serve, write_config):
    write_config("web_login_names: {appliance: hub}\n" + HOSTS)
    h = serve().call("host.get", {"name": "box1"})["result"]
    assert h["services"]["web"]["login"] == "hub" and h["problems"] == []
