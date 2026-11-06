"""T229 (#443, amends Q191): every path in bitwarden.py that lists items (a `bw:` Login matching several items or
none, the duplicate check before a create, finding an item after bw's create answer, the look-up after a create timed
out) goes through Q191's filter, so roster's own process never reads `bw list items`. Each fake item carries fake
secrets: none of them may reach what roster returns, prints or raises."""

import contextlib
import json
import subprocess

import pytest

from roster import providers
from roster.common import deadline
from roster.providers import bitwarden, get_secret

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
    """The fake bw with ITEMS, unlocked; a `bw list items` whose stdout isn't the filter's stdin (roster's process
    reading it itself) fails the test."""
    f = tmp_path / "items.json"
    f.write_text(json.dumps(ITEMS))
    monkeypatch.setenv("FAKE_BW_ITEMS", str(f))
    monkeypatch.setenv("FAKE_ARGV_LOG", str(tmp_path / "argv.log"))
    real_popen, producers, itself = subprocess.Popen, [], []

    def popen(args, *a, **kw):                  # however it's started, `bw list items` must feed the filter's stdin
        if producers:
            p = producers.pop()
            if not (kw.get("stdin") is p.stdout and bitwarden.FILTER in [str(x) for x in args]):
                itself.append(p.args)
        proc = real_popen(args, *a, **kw)
        if isinstance(args, (list, tuple)) and "list" in args and "items" in args:
            producers.append(proc)
        return proc
    monkeypatch.setattr(subprocess, "Popen", popen)
    providers.unlock("bw", "hunter2")
    yield f
    itself.extend(p.args for p in producers)
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
    providers.reset()                                   # a new run: nothing cached
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


# How bw's answer to `bw create item` is lost once the item is saved: it doesn't read, or it never comes in time.

@contextlib.contextmanager
def unreadable(monkeypatch):
    monkeypatch.setenv("FAKE_BW_RAW", json.dumps({"create item": "not JSON"}))
    yield


@contextlib.contextmanager
def timed_out(monkeypatch):
    monkeypatch.setenv("FAKE_BW_CREATE_HANG", "30")
    with deadline(3):                          # bw sync and the duplicate check come first (Windows CI is slow)
        yield


@pytest.mark.parametrize("answer", [unreadable, timed_out])
def test_a_create_whose_answer_is_lost_finds_the_item_through_the_filter(vault, monkeypatch, capsys, answer):
    with answer(monkeypatch):
        made = providers.create_item("bw", name="box ssh", username="ops", password=NEW_PW, uri="ssh://10.0.0.5")
    saved = next(i for i in json.loads(vault.read_text()) if i["name"] == "box ssh")
    assert made["id"] == saved["id"] and made["name"] == "box ssh"
    clean(made, capsys.readouterr())


@pytest.mark.parametrize("answer", [unreadable, timed_out])
def test_a_lost_answer_still_finds_the_item_in_its_collection(orgs, monkeypatch, capsys, answer):
    with answer(monkeypatch):
        made = providers.create_item("bw", name="box ssh", password=NEW_PW, save_to=INFRA)
    assert made["target"]["label"] == "My Team / Infra logins" and "box ssh" in names(orgs)
    clean(made, capsys.readouterr())


def test_a_create_that_timed_out_and_saved_nothing_says_so(vault, monkeypatch, capsys):
    monkeypatch.setenv("FAKE_BW_SLOW", json.dumps({"create": 30}))          # bw is stopped before it saves
    with deadline(3), pytest.raises(providers.WriteFailed, match="nothing was saved") as e:
        providers.create_item("bw", name="box ssh", password=NEW_PW)
    assert "box ssh" not in names(vault)
    clean(str(e.value), capsys.readouterr())


# ---- the filter keeps login items only, so several matches fail closed unless every one bw found is a login row
# (#446's review, M1): bw's "More than one result" names each matching item's id, of any type.

def note(id_, name):
    return {"id": id_, "type": 2, "name": name, "notes": "notes-SECRET", "secureNote": {"type": 0},
            "fields": [{"name": "pw", "value": "field-SECRET"}]}


def use(vault, *items):
    vault.write_text(json.dumps(list(items)))


def test_a_login_with_a_notes_name_is_never_picked_over_it(vault, capsys):
    use(vault, note("ffff-6666", "db"), item("aaaa-1111", "db", "pw-SECRET-one"))
    for ref in ("bw:db", "bw:db#pw"):
        with pytest.raises(providers.SeveralItems) as e:
            get_secret(ref, "g")
        assert e.value.total == 2 and not e.value.exact
        assert "2 Bitwarden items match 'db', some of them aren't logins" in str(e.value)
        clean(str(e.value), e.value.matches, capsys.readouterr())


def test_several_matches_some_not_logins_are_counted_as_bw_found_them(vault, capsys):
    from roster import errors
    use(vault, note("ffff-6666", "db"), item("aaaa-1111", "db prod", "pw-SECRET-one", "ssh://10.0.0.6"))
    with pytest.raises(providers.SeveralItems) as e:
        get_secret("bw:db", "g")
    msg = errors.login_problem(e.value, {"name": "db-01"}).message
    assert msg == ("2 vault items match 'db' (ssh Login of db-01), some of them aren't logins: "
                   "'db prod' (edited 2026-10-01, ssh://10.0.0.6)")        # the filter's revised (owner, #430)
    use(vault, note("ffff-6666", "db"), note("ffff-7777", "db old"))
    with pytest.raises(providers.SeveralItems) as e:
        get_secret("bw:db", "g")
    assert e.value.matches == [] and e.value.total == 2
    msg = errors.login_problem(e.value, {"name": "db-01"}).message
    assert msg == "2 vault items match 'db' (ssh Login of db-01), some of them aren't logins"
    clean(msg, capsys.readouterr())


# ---- a lost create answer (#446's review, L1): exactly one row by that name, or roster says it can't tell

def test_a_lost_answer_with_two_items_by_that_name_says_so(vault, monkeypatch, capsys):
    monkeypatch.setenv("FAKE_BW_CREATE_ALSO", json.dumps([item("zzzz-9999", "box ssh", "pw-SECRET-two")]))
    with unreadable(monkeypatch), pytest.raises(providers.WriteFailed, match="2 items are named 'box ssh'") as e:
        providers.create_item("bw", name="box ssh", password=NEW_PW)
    assert names(vault).count("box ssh") == 2
    clean(str(e.value), capsys.readouterr())


@pytest.mark.parametrize("answer", [unreadable, timed_out])
def test_a_lost_answer_and_a_failed_listing_says_roster_couldnt_check(vault, tmp_path, monkeypatch, capsys, answer):
    monkeypatch.setenv("FAKE_BW_LOCK_ON_CREATE", str(tmp_path / "locked"))     # locked elsewhere once it's saved
    with answer(monkeypatch), pytest.raises(providers.WriteFailed, match="couldn't check") as e:
        providers.create_item("bw", name="box ssh", password=NEW_PW)
    assert "isn't in the vault" not in str(e.value)
    clean(str(e.value), capsys.readouterr())


@pytest.mark.parametrize("answer", [unreadable, timed_out])
def test_an_item_found_by_name_outside_the_collection_is_never_deleted(orgs, monkeypatch, capsys, answer):
    with answer(monkeypatch), pytest.raises(providers.ReadOnlyTarget, match="check it in the vault") as e:
        providers.create_item("bw", name="nas-02 ssh", password=NEW_PW, save_to=AUDIT)
    assert "nas-02 ssh" in names(orgs)          # roster can't be sure it made it: it's said, never deleted
    clean(str(e.value), capsys.readouterr())
