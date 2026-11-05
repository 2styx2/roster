"""T229 (#443, amends Q191): every path in bitwarden.py that lists items (a `bw:` Login matching several items or
none, the duplicate check before a create, finding an item after bw's create answer, the look-up after a create timed
out) goes through Q191's filter, so roster's own process never reads `bw list items`. Each fake item carries fake
secrets: none of them may reach what roster returns, prints or raises."""

import json

import pytest

from roster import providers
from roster.providers import get_secret

SECRETS = ["pw-SECRET-one", "pw-SECRET-two", "pw-SECRET-three", "totp-SECRET", "notes-SECRET", "field-SECRET",
           "uri-pw-SECRET"]


def item(id_, name, password, uri=None, username="ops"):
    return {"id": id_, "type": 1, "name": name, "notes": "notes-SECRET", "revisionDate": "2026-10-01T00:00:00.000Z",
            "fields": [{"name": "extra", "value": "field-SECRET"}],
            "login": {"username": username, "password": password, "totp": "totp-SECRET",
                      "uris": [{"uri": uri}] if uri else []}}


ITEMS = [item("aaaa-1111", "esx ssh", "pw-SECRET-one", "ssh://root:uri-pw-SECRET@10.0.0.6"),
         item("bbbb-2222", "esx ssh", "pw-SECRET-two", "https://10.0.0.6"),
         item("cccc-3333", "esx-02 ssh", "pw-SECRET-three"),
         item("dddd-4444", "nas ssh", "pw-nas")]


@pytest.fixture
def vault(fakes, tmp_path, monkeypatch):
    """The fake bw with ITEMS, unlocked; every `bw list items` that roster's process runs itself (Ctx.run, its stdout
    read by roster) fails the test: only Ctx.run_filtered may run one."""
    f = tmp_path / "items.json"
    f.write_text(json.dumps(ITEMS))
    monkeypatch.setenv("FAKE_BW_ITEMS", str(f))
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    real, itself = providers.run, []

    def run(args, *a, **kw):
        if "list" in args and "items" in args:
            itself.append(args)
            raise AssertionError(f"roster's process ran `bw list items` itself: {args}")
        return real(args, *a, **kw)
    monkeypatch.setattr(providers, "run", run)
    providers.unlock("bw", "hunter2")
    yield f
    assert not itself, itself


def clean(*things):
    text = json.dumps([str(t) if not isinstance(t, (dict, list)) else t for t in things])
    for s in SECRETS:
        assert s not in text, s


def test_a_typo_suggests_near_names_without_listing_the_vault_in_roster(vault, capsys):
    with pytest.raises(providers.ItemNotFound) as e:
        get_secret("bw:esx shh", "g")
    assert "esx ssh" in e.value.near
    clean(str(e.value), e.value.near, e.value.args, capsys.readouterr())


def test_several_matches_are_named_from_the_filter_without_a_secret(vault, capsys):
    with pytest.raises(providers.SeveralItems) as e:
        get_secret("bw:esx ssh", "g")                   # two items are named exactly that
    assert e.value.exact and [m["name"] for m in e.value.matches] == ["esx ssh", "esx ssh"]
    assert {u for m in e.value.matches for u in m["uris"]} == {"ssh://10.0.0.6", "https://10.0.0.6"}
    clean(str(e.value), e.value.matches, capsys.readouterr())


def test_one_exact_name_among_several_matches_is_fetched_by_its_id(vault, tmp_path, capsys):
    assert get_secret("bw:nas ssh", "g") == "pw-nas"
    vault.write_text(json.dumps(ITEMS + [item("eeee-5555", "nas ssh (old)", "pw-SECRET-one")]))
    providers.PROVIDER_STATE.clear()
    providers._secrets.clear()
    providers.unlock("bw", "hunter2")
    assert get_secret("bw:nas ssh", "g") == "pw-nas"
    calls = [json.loads(x) for x in (tmp_path / "argv.log").read_text().splitlines()]
    assert ["get", "item", "dddd-4444", "--nointeraction"] in calls
    clean(capsys.readouterr())


# ---- saving a new item (the duplicate check, bw's create answer, a create that timed out)

NEW_PW = "n3w-SECRET-pw"                # the new item's own password: never in a result or error either
SECRETS.append(NEW_PW)
ORGS = [{"id": "0rg-team", "name": "My Team", "status": 2, "type": 2, "enabled": True,
         "collections": [{"id": "c0l-infra", "name": "Infra logins"},
                         {"id": "c0l-audit", "name": "Audit", "readOnly": True}]}]
INFRA = {"organization": "My Team", "collection": "Infra logins"}
AUDIT = {"organization": "My Team", "collection": "Audit"}


@pytest.fixture
def orgs(vault, monkeypatch):
    monkeypatch.setenv("FAKE_BW_ORGS", json.dumps(ORGS))
    return vault


def names(vault):
    return [i["name"] for i in json.loads(vault.read_text())]


def test_the_duplicate_check_names_the_items_without_a_secret(vault, capsys):
    before = vault.read_text()
    with pytest.raises(providers.ItemExists) as e:
        providers.create_item("bw", name="esx ssh", password=NEW_PW)
    assert [m["name"] for m in e.value.matches] == ["esx ssh", "esx ssh"]
    assert vault.read_text() == before
    clean(str(e.value), e.value.matches, capsys.readouterr())


def bw_answers(monkeypatch, create):
    """bw's `create item` runs (the item is saved), then CREATE(r) stands in for what roster gets back."""
    from roster.providers import bitwarden
    real = bitwarden._bw

    def fake(ctx, *args, **kw):
        r = real(ctx, *args, **kw)
        return create(r) if args[:2] == ("create", "item") else r
    monkeypatch.setattr(bitwarden, "_bw", fake)


def unreadable(r):
    r.stdout = "not JSON"
    return r


def timed_out(r):
    raise providers.TimedOut("`bw` timed out")


@pytest.mark.parametrize("answer", [unreadable, timed_out])
def test_a_create_whose_answer_is_lost_finds_the_item_through_the_filter(vault, monkeypatch, capsys, answer):
    bw_answers(monkeypatch, answer)
    made = providers.create_item("bw", name="box ssh", username="ops", password=NEW_PW, uri="ssh://10.0.0.5")
    saved = next(i for i in json.loads(vault.read_text()) if i["name"] == "box ssh")
    assert made["id"] == saved["id"] and made["name"] == "box ssh"
    clean(made, capsys.readouterr())


@pytest.mark.parametrize("answer", [unreadable, timed_out])
def test_a_lost_answer_still_tells_a_collection_from_a_refused_one(orgs, monkeypatch, capsys, answer):
    bw_answers(monkeypatch, answer)
    made = providers.create_item("bw", name="box ssh", password=NEW_PW, save_to=INFRA)
    assert made["target"]["label"] == "My Team / Infra logins" and "box ssh" in names(orgs)
    with pytest.raises(providers.ReadOnlyTarget, match="taken back out") as e:
        providers.create_item("bw", name="nas-02 ssh", password=NEW_PW, save_to=AUDIT)
    assert "nas-02 ssh" not in names(orgs)
    clean(made, str(e.value), capsys.readouterr())


def test_a_create_that_timed_out_and_saved_nothing_says_so(vault, monkeypatch, capsys):
    from roster.providers import bitwarden
    real = bitwarden._bw

    def fake(ctx, *args, **kw):
        if args[:2] == ("create", "item"):
            raise providers.TimedOut("`bw` timed out")
        return real(ctx, *args, **kw)
    monkeypatch.setattr(bitwarden, "_bw", fake)
    with pytest.raises(providers.WriteFailed, match="nothing was saved") as e:
        providers.create_item("bw", name="box ssh", password=NEW_PW)
    clean(str(e.value), capsys.readouterr())


# ---- structurally: the one place bitwarden.py runs `bw list items` is _bw_rows, through Ctx.run_filtered

def test_bw_list_items_runs_only_through_the_filter():
    import ast
    import inspect

    from roster.providers import bitwarden
    tree = ast.parse(inspect.getsource(bitwarden))
    where = []
    for fn in ast.walk(tree):
        if not isinstance(fn, ast.FunctionDef):
            continue
        for call in ast.walk(fn):
            if not isinstance(call, ast.Call):
                continue
            args = [x for a in call.args for x in (a.elts if isinstance(a, ast.List) else [a])]
            words = [a.value for a in args if isinstance(a, ast.Constant)]
            callee = ast.unparse(call.func)
            if "items" in words and "list" in words:
                where.append((fn.name, callee))
            if callee == "_bw_listed":                     # bw list ORGANIZATIONS / COLLECTIONS only, read by roster
                assert words[:1] in (["organizations"], ["collections"]), (fn.name, words)
            if callee in ("_bw", "ctx.run") and "list" in words[:2]:
                assert fn.name == "_bw_listed", fn.name
    assert where == [("_bw_rows", "ctx.run_filtered")]
