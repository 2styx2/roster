"""T176 (#334, decision Q113): each `--json` document is a Pydantic model (src/roster/jsondocs.py), so its shape is
checked before it's printed, and the output is what it always was (test_json.py; the redaction is jsonout's, run on
the dumped model). No value shows in a repr or a validation error."""

import json
import subprocess
import sys

import pytest
from pydantic import ValidationError

from roster import jsondocs
from roster.cli import main
from roster.jsonout import emit

INVENTORY = """\
groups:
  lab:
    title: The lab
    user: ops
    auth: "cmd:printf s3cret-in-cmd"
    hosts:
      box: {ip: 10.0.0.5, title: Lab box, web: "https://10.0.0.5"}
resources:
  guest: {type: wifi, ssid: Guest, auth: env:WIFI_PW, title: Guest Wi-Fi, group: lab}
"""


def doc_of(capsys, *argv):
    main([*argv, "--json"])
    return capsys.readouterr().out


@pytest.mark.parametrize("argv, model", [
    (("hosts",), jsondocs.HostsDoc),
    (("info", "box"), jsondocs.HostInfoDoc),
    (("info", "guest"), jsondocs.ResourceInfoDoc),
    (("resources",), jsondocs.ResourcesDoc),
    (("inv", "list"), jsondocs.InventoriesDoc),
    (("inv", "which"), jsondocs.WhichDoc),
])
def test_each_document_is_its_model(write_config, capsys, argv, model):
    write_config(INVENTORY)
    out = doc_of(capsys, *argv)
    sent = json.loads(out)
    assert sent.pop("version") == 1
    assert json.dumps(jsondocs.plain(model.model_validate(sent))) == json.dumps(sent)    # same keys, same order


def test_emit_takes_a_document_model():
    with pytest.raises(TypeError):
        emit({"hosts": []})


def test_a_document_that_isnt_its_shape_is_refused_without_the_value():
    with pytest.raises(ValidationError) as e:
        jsondocs.ResourcesDoc.model_validate({"resources": [{"name": "cmd:printf s3cret-in-name"}]})
    assert "s3cret" not in str(e.value)
    with pytest.raises(ValidationError) as e:
        jsondocs.LoginsDoc.model_validate({"logins": [], "ok": "cmd:printf s3cret-in-ok"})
    assert "s3cret" not in str(e.value)


def test_no_login_reference_in_a_documents_repr(write_config, capsys):
    write_config(INVENTORY)
    doc = jsondocs.HostsDoc.model_validate({k: v for k, v in json.loads(doc_of(capsys, "hosts")).items()
                                            if k != "version"})
    login = jsondocs.LoginRow(group="lab", auth="cmd:printf s3cret-in-cmd", users=["ops"], used_for=[], status="ok")
    for obj in (doc, login, jsondocs.LoginsDoc(logins=[login], ok=True)):
        assert "s3cret" not in repr(obj) and "cmd:" not in repr(obj) and "WIFI_PW" not in repr(obj)


def test_the_error_document():
    doc = jsondocs.ErrorDoc(error=jsondocs.Error(code=2, message="unknown host 'nope'", fix=None))
    assert jsondocs.plain(doc) == {"error": {"code": 2, "message": "unknown host 'nope'", "fix": None}}


def test_starting_roster_imports_neither_pydantic_nor_the_documents():
    """The documents load when a --json command prints one, never at start (Pydantic costs ~75 ms; Q113)."""
    out = subprocess.run([sys.executable, "-c", "import sys, roster.cli, roster.jsonout; "
                          "print('pydantic' in sys.modules, 'roster.jsondocs' in sys.modules)"],
                         capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False False"
