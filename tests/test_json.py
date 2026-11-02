"""T102 (#180): `--json` on the CLI's read commands. One JSON document on stdout, `version` at the top, the Host,
group and resource objects `roster serve` answers with, and never a secret: Login references only, with `cmd:` and
`env:` ones cut to their kind as Plugins get them (Q92). Errors go to stderr as JSON, with the usual exit status."""

import json
from pathlib import Path

import pytest

from roster.cli import main
from roster.jsonout import JSON_VERSION, emit, redact, redact_error, redact_text


def run(capsys, *argv):
    rc = main([*argv, "--json"])
    out, err = capsys.readouterr()
    return rc, json.loads(out) if out else None, err


INVENTORY = """\
groups:
  lab:
    title: The lab
    user: ops
    auth: env:LAB_PW
    hosts:
      box: {ip: 10.0.0.5, title: Lab box, web: "https://10.0.0.5"}
      esx:
        ip: 10.0.0.6
        user: root
        enroll: false
        auth: "cmd:printf s3cret-in-cmd"
        services:
          admin: {url: "https://10.0.0.6:943", user: webadmin, auth: "pass:infra/orion"}
  found:
    reviewed: false
    user: CHANGE-ME
    hosts:
      server-10-0-0-9: {ip: 10.0.0.9, port: 2222}
resources:
  guest: {type: wifi, ssid: Guest, auth: env:WIFI_PW, title: Guest Wi-Fi, group: lab}
"""


# ---------------------------------------------------------------- the cut, as runtime.rs's redact_text

VECTORS = json.loads((Path(__file__).parent / "vectors" / "redaction.json").read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["note"] for c in VECTORS])
def test_the_shared_redaction_vectors(case):
    """tests/vectors/redaction.json, which runtime.rs's tests read too: the CLI and Plugins cut alike (Q92)."""
    cut = redact_error if case.get("error") else redact_text
    assert cut(case["in"]) == case["out"]


def test_the_cut_reaches_every_string_inside(capsys):
    got = redact({"a": ["cmd:x", {"b": "env:Y"}], "n": 3, "t": True, "z": None})
    assert got == {"a": ["cmd:", {"b": "env:"}], "n": 3, "t": True, "z": None}


VALUES = json.loads((Path(__file__).parent / "vectors" / "redaction.json").read_text(encoding="utf-8"))["values"]


@pytest.mark.parametrize("case", VALUES, ids=[c["note"] for c in VALUES])
def test_the_shared_redaction_vectors_for_json_values(case):
    """The cut of a whole JSON value, keys included: runtime.rs's tests read these too (Q92)."""
    assert redact(case["in"]) == case["out"]


def test_emit_cuts_what_isnt_plain_json_and_every_key(capsys):
    # iteration 9 review, item 8: a set, a Path or an object went out as json.dumps(default=str) made it, and a
    # dict's keys were never cut
    class Thing:
        def __str__(self):
            return "env:LAB_PW"
    emit({"keys": {"cmd:printf s3cret-in-key": 1}, "set": {"cmd:printf s3cret-in-set"},
          "path": Path("cmd:printf s3cret-in-path"), "thing": Thing()})
    out = capsys.readouterr().out
    assert "s3cret" not in out and "LAB_PW" not in out
    assert json.loads(out) == {"version": JSON_VERSION, "keys": {"cmd:": 1}, "set": "{'cmd:'", "path": "cmd:",
                               "thing": "env:"}


# ---------------------------------------------------------------- hosts

def test_hosts_json_gives_serves_host_objects_with_the_version(write_config, capsys):
    write_config(INVENTORY)
    rc, doc, err = run(capsys, "hosts")
    assert rc == 0 and err == ""
    assert doc["version"] == JSON_VERSION
    assert [h["name"] for h in doc["hosts"]] == ["box", "esx"]            # unreviewed hidden, as in the table
    assert doc["hidden"] == 1
    box = doc["hosts"][0]
    assert box["ip"] == "10.0.0.5" and box["ssh"] == {"port": 22, "user": "ops", "auth": "env:"}
    assert doc["hosts"][1]["ssh"]["auth"] == "cmd:"
    assert doc["hosts"][1]["services"]["admin"]["auth"] == "pass:infra/orion"
    assert doc["groups"]["lab"]["title"] == "The lab"
    assert [r["name"] for r in doc["resources"]] == ["guest"] and doc["resources"][0]["auth"] == "env:"


def test_hosts_json_filters(write_config, capsys):
    write_config(INVENTORY)
    assert [h["name"] for h in run(capsys, "hosts", "--all")[1]["hosts"]] == ["box", "esx", "server-10-0-0-9"]
    rc, doc, _ = run(capsys, "hosts", "--find", "lab box")
    assert rc == 0 and [h["name"] for h in doc["hosts"]] == ["box"] and doc["resources"] == []
    rc, doc, _ = run(capsys, "hosts", "--only", "esx")
    assert [h["name"] for h in doc["hosts"]] == ["esx"] and doc["hidden"] == 0
    rc, doc, _ = run(capsys, "hosts", "--find", "nothing-like-it")
    assert rc == 1 and doc["hosts"] == [] and doc["resources"] == []


# ---------------------------------------------------------------- info, resources

def test_info_json_is_the_host_and_its_group(write_config, capsys):
    write_config(INVENTORY)
    rc, doc, _ = run(capsys, "info", "lab", "box")             # fuzzy words, as without --json
    assert rc == 0 and doc["host"]["name"] == "box" and "resource" not in doc
    assert doc["group"] == {"name": "lab", "title": "The lab", "description": ""}
    rc, doc, _ = run(capsys, "info", "guest")
    assert rc == 0 and doc["resource"]["ssid"] == "Guest" and doc["resource"]["auth"] == "env:"
    assert doc["group"]["name"] == "lab"


def test_resources_json(write_config, capsys):
    write_config(INVENTORY)
    rc, doc, _ = run(capsys, "resources")
    assert rc == 0 and [r["name"] for r in doc["resources"]] == ["guest"]
    rc, doc, _ = run(capsys, "resources", "--find", "nothing")
    assert rc == 1 and doc["resources"] == []
    write_config("groups: {lab: {user: ops, hosts: {box: {ip: 10.0.0.5}}}}\n")
    assert run(capsys, "resources")[:2] == (0, {"version": JSON_VERSION, "resources": []})


# ---------------------------------------------------------------- errors: JSON on stderr, nothing on stdout

def test_an_unknown_host_is_a_json_error_on_stderr(write_config, capsys):
    write_config(INVENTORY)
    rc, doc, err = run(capsys, "info", "nope")
    assert rc == 1 and doc is None
    e = json.loads(err)
    assert e["version"] == JSON_VERSION and e["error"]["code"] == 2 and "unknown host" in e["error"]["message"]


def test_a_broken_inventory_is_code_1_with_its_fix_and_no_secret(write_config, capsys):
    write_config('groups:\n  lab:\n    auth: "cmd:printf s3cret-in-cmd\n    hosts: [oops\n')
    rc, doc, err = run(capsys, "hosts")
    assert rc == 1 and doc is None
    e = json.loads(err)["error"]
    assert e["code"] == 1 and e["fix"].startswith("fix ") and "s3cret" not in err


def test_no_inventory_at_all(capsys):
    rc, doc, err = run(capsys, "hosts")
    assert rc == 1 and doc is None and json.loads(err)["error"]["code"] == 1


def test_a_usage_error_is_json_with_exit_2(write_config, capsys):
    write_config(INVENTORY)
    with pytest.raises(SystemExit) as e:
        main(["hosts", "--bogus", "--json"])
    out, err = capsys.readouterr()
    assert e.value.code == 2 and out == "" and "--bogus" in json.loads(err)["error"]["message"]


def test_reveal_has_no_json(write_config, capsys):
    write_config(INVENTORY)
    with pytest.raises(SystemExit) as e:
        main(["reveal", "guest", "--json"])
    out, _ = capsys.readouterr()
    assert e.value.code == 2 and out == ""


# ---------------------------------------------------------------- check, mesh status, providers, auth-check

LOCAL = """\
groups:
  lab:
    user: ops
    enroll: false
    auth: "cmd:printf s3cret-in-cmd"
    hosts:
      open: {{ip: 127.0.0.1, port: {open}}}
      closed: {{ip: 127.0.0.1, port: {closed}}}
      keyed: {{ip: 127.0.0.1, enroll: true, auth: env:LAB_PW}}
"""


@pytest.fixture
def local(write_config, fakes, monkeypatch):
    """Hosts on 127.0.0.1: one port that answers, one that doesn't, and a key Host the stand-in ssh logs in to."""
    import socket
    listener = socket.create_server(("127.0.0.1", 0))
    gone = socket.create_server(("127.0.0.1", 0))
    closed = gone.getsockname()[1]
    gone.close()
    write_config(LOCAL.format(open=listener.getsockname()[1], closed=closed))
    monkeypatch.setenv("FAKE_SSH_EXIT", "0")
    monkeypatch.setenv("LAB_PW", "s3cret-in-env")
    assert main(["sync"]) == 0                   # roster's ssh config, which `check HOST` looks at first
    yield
    listener.close()


def test_check_json_is_each_hosts_results(local, capsys):
    rc, doc, err = run(capsys, "check")
    assert rc == 1 and err == ""
    by_name = {h["name"]: h for h in doc["hosts"]}
    assert by_name["open"] == {"name": "open", "ok": True, "ssh": "port", "checks": {"ssh": True}}
    assert by_name["closed"]["ok"] is False and by_name["closed"]["checks"] == {"ssh": False}
    assert by_name["keyed"]["ssh"] == "login" and by_name["keyed"]["ok"] is True
    assert doc["ok"] is False and doc["mesh"] is None
    rc, doc, _ = run(capsys, "check", "--only", "open")
    assert rc == 0 and doc["ok"] is True and [h["name"] for h in doc["hosts"]] == ["open"]


def test_check_host_json_is_the_steps(local, capsys):
    rc, doc, _ = run(capsys, "check", "closed")
    assert rc == 1 and doc["host"] == "closed" and doc["ok"] is False
    steps = {s["step"]: s for s in doc["steps"]}
    assert steps["inventory"]["status"] == "ok" and steps["tcp"]["status"] == "fail" and steps["tcp"]["code"] == 41
    rc, doc, _ = run(capsys, "check", "nope")
    assert rc == 1 and doc["steps"][0]["code"] == 2


def test_check_box_json(local, capsys):
    rc, doc, _ = run(capsys, "check", "--box")
    assert rc in (0, 1) and doc["ok"] is (rc == 0)
    assert {c["section"] for c in doc["checks"]} >= {"roster", "inventory"}
    assert all(c["level"] in ("ok", "warn", "error") for c in doc["checks"])


def test_mesh_status_json(local, capsys):
    rc, doc, _ = run(capsys, "mesh", "status")
    assert rc == 0 and doc["links"] == [] and doc["out_of_date"] is False and "members" in doc
    with pytest.raises(SystemExit) as e:
        main(["mesh", "--json"])
    assert e.value.code == 2 and capsys.readouterr().out == ""


def test_providers_json(local, capsys):
    rc, doc, _ = run(capsys, "providers")
    assert rc == 0 and doc["unknown"] == [] and doc["ok"] is True
    by_name = {p["name"]: p for p in doc["providers"]}
    assert by_name["cmd"]["used_by"] == ["lab"] and by_name["env"]["used_by"] == ["lab"]
    assert by_name["bw"]["tool"] == "bw" and by_name["bw"]["installed"] is True           # the stand-in
    assert by_name["env"]["tool"] is None and by_name["env"]["installed"] is None
    assert by_name["agent"]["kind"] == "built-in"


def test_auth_check_json(local, capsys):
    rc, doc, _ = run(capsys, "auth-check")
    assert rc == 0 and doc["ok"] is True
    assert {(x["group"], x["auth"], x["status"]) for x in doc["logins"]} == {("lab", "cmd:", "ok"),
                                                                            ("lab", "env:", "ok")}
    cmd = next(x for x in doc["logins"] if x["auth"] == "cmd:")
    assert cmd["users"] == ["ops"] and cmd["used_for"] == [{"service": "ssh", "hosts": ["open", "closed"]}]


def test_auth_check_json_says_which_failed(local, capsys, monkeypatch):
    monkeypatch.delenv("LAB_PW")
    rc, doc, _ = run(capsys, "auth-check")
    failed = [x for x in doc["logins"] if x["status"] == "fail"]
    assert rc == 1 and doc["ok"] is False and [x["auth"] for x in failed] == ["env:"] and failed[0]["error"]


# ---------------------------------------------------------------- never a secret, whatever the command

SECRETS = {"pw-deploy", "pw-netops", "hunter2", "s3cret-in-env", "s3cret-in-cmd", "tok-s3cret", "s3cret-wifi",
           "s3cret-in-key", "s3cret-in-set"}
EVERY_PROVIDER = """\
groups:
  lab:
    user: ops
    enroll: false
    mesh: true
    port: {closed}
    hosts:
      by-bw: {{ip: 127.0.0.1, auth: "bw:Orion servers"}}
      by-op: {{ip: 127.0.0.1, auth: "op:Infra/Network gear"}}
      by-env: {{ip: 127.0.0.1, auth: env:LAB_PW}}
      by-cmd:
        ip: 127.0.0.1
        auth: "cmd:printf s3cret-in-cmd"
        vars: {{"cmd:printf s3cret-in-key": 1}}
        tags: !!set {{"cmd:printf s3cret-in-set"}}
        services:
          admin: {{url: "https://127.0.0.1:{closed}", user: webadmin, auth: "cmd:echo s3cret-in-cmd"}}
resources:
  guest: {{type: wifi, ssid: Guest, auth: "cmd:printf s3cret-wifi"}}
  portal: {{type: account, url: "https://portal.example.com", user: you@example.com, auth: env:LAB_PW}}
"""


def test_no_secret_value_ever_appears_in_json_output(write_config, fakes, monkeypatch, capsys, tmp_path):
    import socket
    gone = socket.create_server(("127.0.0.1", 0))
    closed = gone.getsockname()[1]
    gone.close()
    write_config(EVERY_PROVIDER.format(closed=closed))
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    monkeypatch.setenv("OP_SERVICE_ACCOUNT_TOKEN", "tok-s3cret")
    monkeypatch.setenv("LAB_PW", "s3cret-in-env")
    page = tmp_path / "found" / "page"                  # what the stand-in nmap finds: a web page that names one
    page.mkdir(parents=True)
    (page / "address").write_text("10.0.0.7")
    (page / "ports").write_text("443 https\n")
    (page / "title").write_text("sign in with cmd:printf s3cret-in-cmd")
    monkeypatch.setenv("FAKE_HOSTS", str(tmp_path / "found"))
    assert main(["sync"]) == 0
    capsys.readouterr()
    commands = [["hosts", "--all"], ["hosts", "--long"], ["resources"], ["providers"], ["auth-check"], ["check"],
                ["check", "--box"], ["mesh", "status"], ["mesh", "--dry-run"], ["info", "nope"], ["check", "nope"],
                ["discover", "10.0.0.0/29", "--ports", "443"], ["discover", "10.0.0.0/8"]]
    for name in ["by-bw", "by-op", "by-env", "by-cmd", "guest", "portal"]:
        commands.append(["info", name])
    for name in ["by-bw", "by-op", "by-env", "by-cmd"]:
        commands.append(["check", name])
    seen = []
    for argv in commands:
        main([*argv, "--json"])
        out, err = capsys.readouterr()
        if out:
            json.loads(out)                     # one JSON document, nothing else on stdout
        seen.append((argv, out + err))
    assert [(argv, s) for argv, text in seen for s in SECRETS if s in text] == []
    everything = "".join(text for _, text in seen)
    assert "cmd:" in everything and "env:" in everything and "bw:Orion servers" in everything
    by_command = {" ".join(argv): text for argv, text in seen}
    assert '"title": "sign in with cmd:"' in by_command["discover 10.0.0.0/29 --ports 443"]
    assert '"applied": false' in by_command["mesh --dry-run"]
    vault = next(text for argv, text in seen if argv == ["check", "by-bw"])
    assert '"vault-item", "status": "ok"' in vault       # the secret was really fetched, and still isn't shown
