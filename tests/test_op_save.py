"""T269 (#541, decision Q217): 1Password can save a Host's Login as a new item (`op item create`, the item JSON on
stdin: never the password in argv), the same one save path as Bitwarden and KeePassXC (providers.create_item,
addhost.save_item), with 1Password's vaults as the places to save to. Stand-in op only (tests/fakes/op, its items in
FAKE_OP_STORE): never a real vault."""

import json

import pytest
from test_add_save_vault import YML, Terminal, fails, forms, run

from roster.cli import main

PW = "0p-n3w-h0st-s3cret"               # never in argv, the environment, output, roster.yml or an error

VAULTS = [{"id": "v-private", "name": "Private"}, {"id": "v-infra", "name": "Infra"}]


@pytest.fixture
def op(fakes, monkeypatch, tmp_path):
    """The stand-in op, signed in, with one item in Infra; its store (FAKE_OP_STORE) and argv log."""
    store = tmp_path / "op-items.json"
    store.write_text(json.dumps([{"id": "it-esx", "title": "esx-02 ssh", "vault": "Infra",
                                  "fields": {"username": "root", "password": "pw-esx"}}]))
    monkeypatch.setenv("FAKE_OP_STORE", str(store))
    monkeypatch.setenv("FAKE_OP_VAULTS", json.dumps(VAULTS))
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    monkeypatch.setenv("FAKE_OP_ENV_LOG", str(tmp_path / "env.log"))
    monkeypatch.setenv("OP_SESSION_test", "tok")
    return store


def items(store):
    return json.loads(store.read_text())


def made(store, title):
    return [i for i in items(store) if i["title"] == title]


def argv_log(tmp_path):
    f = tmp_path / "argv.log"
    return f.read_text() if f.exists() else ""


def test_an_op_item_is_made_with_name_uri_and_user_then_auth_points_at_it(capsys, write_config, op, tmp_path,
                                                                           monkeypatch):
    yml = write_config(YML)
    Terminal(monkeypatch, PW, PW)
    rc, out = run(capsys, "nas", "--ip", "10.0.0.50", "--port", "2222", "--user", "admin", "--group", "lab",
                  "--save-to-vault", "--provider", "op")
    assert rc == 0, out
    [item] = made(op, "nas ssh")
    assert item["fields"] == {"username": "admin", "password": PW}
    assert item["urls"] == ["ssh://10.0.0.50:2222"]
    assert item["vault"] == "Private"                               # op's own default: personal
    assert "nas: {ip: 10.0.0.50, user: admin, port: 2222, auth: op:nas ssh}" in yml.read_text()
    assert "saved        vault item 'nas ssh' in op" in out
    assert PW not in out + argv_log(tmp_path) + yml.read_text()
    creates = [json.loads(line) for line in argv_log(tmp_path).splitlines() if '"create"' in line]
    assert creates and all(c[-1] == "-" for c in creates)           # the item JSON on stdin, no assignment in argv


def test_the_password_never_reaches_ops_argv_or_environment(capsys, write_config, op, tmp_path, monkeypatch):
    import subprocess
    write_config(YML)
    seen = []
    real = subprocess.Popen

    def watch(args, *a, **kw):
        seen.append(json.dumps([list(args) if not isinstance(args, str) else args, dict(kw.get("env") or {})]))
        return real(args, *a, **kw)
    monkeypatch.setattr(subprocess, "Popen", watch)
    Terminal(monkeypatch, PW, PW)
    assert run(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "op")[0] == 0
    assert any('"create"' in s for s in seen) and not any(PW in s for s in seen)


@pytest.mark.parametrize("pw", ["0p-s3cret", "two  spaces here", 'q"uote\\back', "tab\there"])
def test_an_op_refusal_that_repeats_the_password_is_withheld(capsys, write_config, op, monkeypatch, pw):
    yml = write_config(YML)
    monkeypatch.setenv("FAKE_OP_WRITE_FAIL", f"[ERROR] bad item: raw={pw} | json={json.dumps(pw)}")
    Terminal(monkeypatch, pw, pw)
    code, out = fails(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "op")
    assert "[62]" in code and "withheld" in code
    assert not [f for f in forms(pw) if f in code + out]
    assert yml.read_text() == YML and not made(op, "nas ssh")


def test_an_op_refusal_without_the_password_keeps_ops_words(capsys, write_config, op, monkeypatch):
    write_config(YML)
    monkeypatch.setenv("FAKE_OP_WRITE_FAIL", "[ERROR] You do not have permission to create items in this vault")
    Terminal(monkeypatch, PW, PW)
    code, _ = fails(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "op")
    assert "[62]" in code and "do not have permission" in code and "collection" not in code


def test_an_op_item_of_that_title_already_there_is_refused(capsys, write_config, op, monkeypatch):
    yml = write_config(YML)
    Terminal(monkeypatch, PW, PW)
    code, _ = fails(capsys, "ESX-02", "--ip", "10.0.0.52", "--save-to-vault", "--provider", "op")
    assert "[60]" in code and "--auth op:ESX-02 ssh" in code       # another case too: op finds it by either
    assert "ESX-02" not in yml.read_text() and len(items(op)) == 1


def test_save_to_names_a_1password_vault_by_name_or_id(capsys, write_config, op, monkeypatch):
    write_config(YML)
    Terminal(monkeypatch, PW, PW, PW, PW)
    rc, out = run(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "op", "--save-to", "Infra")
    assert rc == 0 and "(Infra)" in out
    assert run(capsys, "web-01", "--ip", "10.0.0.51", "--save-to-vault", "--provider", "op",
               "--save-to", "v-infra")[0] == 0
    assert [i["vault"] for i in items(op) if i["title"] in ("nas ssh", "web-01 ssh")] == ["Infra", "Infra"]


def test_ops_read_vault_is_where_it_saves_and_another_is_refused_before_the_password(capsys, write_config, op,
                                                                                      monkeypatch):
    yml = write_config("providers:\n  op:\n    vault: Infra\n" + YML)
    Terminal(monkeypatch, PW, PW)
    assert run(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "op")[0] == 0
    assert [i["vault"] for i in made(op, "nas ssh")] == ["Infra"]     # `vault:` is where its Logins are read
    for where in ("Private", "personal"):
        term = Terminal(monkeypatch, PW, PW)
        code, _ = fails(capsys, "web-01", "--ip", "10.0.0.51", "--save-to-vault", "--provider", "op",
                        "--save-to", where)
        assert "[64]" in code and "read from vault 'Infra'" in code and "--save-to" in code
        assert term.asked == [] and "web-01" not in yml.read_text()


def test_a_vault_1password_doesnt_have_is_refused_before_the_password(capsys, write_config, op, monkeypatch):
    write_config(YML)
    term = Terminal(monkeypatch, PW, PW)
    code, _ = fails(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "op", "--save-to", "Nope")
    assert "[64]" in code and "no 1Password vault 'Nope'" in code and "Private, Infra" in code
    assert term.asked == [] and len(items(op)) == 1


# ---- the app's "Save to vault" through roster serve: the same create, its targets, and Q43's undo

OP_INVENTORY = """\
groups:
  lab:
    user: ops
    auth: op:lab ssh
    hosts:
      box: {ip: 10.0.0.5}
"""


def test_serve_lists_1passwords_vaults_saves_to_one_and_takes_it_back(serve, write_config, op, tmp_path):
    write_config(OP_INVENTORY)
    s = serve()
    targets = s.call("vault.targets", {"provider": "op"})["result"]
    assert [t["id"] for t in targets["targets"]] == ["personal", "vault:v-private", "vault:v-infra"]
    assert targets["targets"][2] == {"id": "vault:v-infra", "kind": "vault", "label": "Infra",
                                     "save_to": {"vault": "v-infra"}}
    assert (targets["default"], targets["from"]) == ("personal", None)
    saved = s.call("vault.create_item", {"name": "box ssh", "password": PW, "username": "ops",
                                         "uri": "ssh://10.0.0.5", "provider": "op",
                                         "save_to": {"vault": "Infra"}})["result"]
    assert saved["provider"] == "op" and saved["target"]["label"] == "Infra"
    [there] = made(op, "box ssh")
    assert there["id"] == saved["id"] and there["fields"]["password"] == PW and there["vault"] == "Infra"
    assert s.call("vault.undo_create", {"id": saved["id"]})["result"] == {"provider": "op", "id": saved["id"]}
    assert not made(op, "box ssh")
    code, out, err = s.close()
    assert code == 0
    assert PW not in json.dumps(s.responses) + err + argv_log(tmp_path)


def test_a_failed_write_takes_back_only_the_op_item_this_run_made_by_its_id(capsys, write_config, op, monkeypatch,
                                                                             tmp_path):
    from test_add_save_vault import broken_write
    yml = write_config(YML)
    Terminal(monkeypatch, PW, PW)
    broken_write(monkeypatch, yml)
    code, out = fails(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "op")
    assert "'nas ssh' was taken back out" in code and "[225]" not in code
    assert [i["title"] for i in items(op)] == ["esx-02 ssh"]
    deletes = [json.loads(line) for line in argv_log(tmp_path).splitlines() if '"delete"' in line]
    assert [d[-1] for d in deletes] == ["it-0002"]                  # the id op's create answered, nothing else
    monkeypatch.setenv("FAKE_OP_DELETE_FAIL", "[ERROR] connection reset")
    Terminal(monkeypatch, PW, PW)
    code, out = fails(capsys, "nas", "--ip", "10.0.0.50", "--save-to-vault", "--provider", "op")
    assert "[225]" in code and "'nas ssh'" in code and "connection reset" in code
    assert [i["title"] for i in items(op)] == ["esx-02 ssh", "nas ssh"] and PW not in code + out


# ---- `roster vault targets`: where Save to vault can put an item, as --save-to takes it (names only)

def test_vault_targets_lists_what_save_to_takes_and_the_default(capsys, write_config, op):
    write_config("providers:\n  op:\n    save_to: {vault: Infra}\n" + OP_INVENTORY)
    assert main(["vault", "targets"]) == 0                          # the vault roster.yml's Logins use
    out = capsys.readouterr().out
    assert "roster add NAME --save-to-vault --save-to TARGET" in out
    lines = [line.split() for line in out.splitlines() if line.startswith("  ")]
    assert [line[0] for line in lines] == ["personal", "Private", "Infra"]
    assert lines[2][-3:] == ["(default,", "from", "roster.yml)"] and "(default," not in lines[0] + lines[1]
    assert "v-infra" not in out                                     # names, not ids
    assert main(["vault", "targets", "op", "--json"]) == 0
    doc = json.loads(capsys.readouterr().out)
    assert doc["provider"] == "op" and doc["default"] == "Infra" and doc["from"] == "roster.yml"
    assert doc["targets"] == [
        {"save_to": "personal", "label": "Private vault (1Password's default)", "kind": "personal", "default": False},
        {"save_to": "Private", "label": "Private", "kind": "vault", "default": False},
        {"save_to": "Infra", "label": "Infra", "kind": "vault", "default": True}]
    assert doc["problem"] is None


def test_vault_targets_of_bitwarden_name_organization_and_collection(capsys, write_config, fakes, monkeypatch,
                                                                    tmp_path):
    from test_add_save_vault import ORGS
    items = tmp_path / "items.json"
    items.write_text("[]")
    monkeypatch.setenv("FAKE_BW_ITEMS", str(items))
    monkeypatch.setenv("BW_SESSION", "fake-session-key")
    monkeypatch.setenv("FAKE_BW_ORGS", json.dumps(ORGS))
    write_config(YML.replace("auth: env:LAB_PW", "auth: bw:lab ssh"))
    assert main(["vault", "targets", "--json"]) == 0
    doc = json.loads(capsys.readouterr().out)
    assert [t["save_to"] for t in doc["targets"]] == ["personal", "My Team/Infra logins"]
    assert doc["default"] == "personal" and doc["from"] is None


def test_vault_targets_of_a_provider_that_cant_save_is_61(capsys, write_config, fakes):
    write_config(YML)
    with pytest.raises(SystemExit) as e:
        main(["vault", "targets", "env"])
    assert "[61]" in str(e.value.code)


def test_a_default_that_isnt_there_is_said_not_failed(capsys, write_config, op):
    write_config("providers:\n  op:\n    save_to: {vault: Gone}\n" + OP_INVENTORY)
    assert main(["vault", "targets"]) == 1
    out = capsys.readouterr().out
    assert "[64]" in out and "no 1Password vault 'Gone'" in out and "personal" in out


# ---- op's answer to `op item create` lost once the item is saved: it doesn't read, or it never comes in time

def test_a_lost_answer_finds_the_op_item_by_its_title(op, monkeypatch, capsys):
    from roster import providers
    from roster.common import deadline
    monkeypatch.setenv("FAKE_OP_CREATE_ANSWER", "not JSON")
    made_now = providers.create_item("op", name="box ssh", username="ops", password=PW, uri="ssh://10.0.0.5")
    assert made_now["id"] == made(op, "box ssh")[0]["id"]
    monkeypatch.delenv("FAKE_OP_CREATE_ANSWER")
    monkeypatch.setenv("FAKE_OP_CREATE_HANG", "30")
    with deadline(3):
        late = providers.create_item("op", name="web ssh", password=PW, save_to={"vault": "Infra"})
    assert late["id"] == made(op, "web ssh")[0]["id"] and late["target"]["label"] == "Infra"
    assert PW not in json.dumps([made_now, late]) + "".join(capsys.readouterr())
