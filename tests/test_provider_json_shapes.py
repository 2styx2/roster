"""T250 (#492, NIT-3 of #488's review; as #486 item 4 for `bw status`): every reader of a vault CLI's JSON checks it
got the object or list it reads, so valid JSON of another shape is a clean SecretError (or the answer is treated as
unreadable), never an AttributeError or TypeError (a traceback). Driven through the stand-in bw and op's raw-output
switches (FAKE_BW_RAW, FAKE_OP_RAW). KeePassXC's provider reads no JSON."""

import json

import pytest

from roster import providers
from roster.providers import SecretError, get_secret

NOT_AN_OBJECT = ["[1]", "null", "42", '"x"']


@pytest.fixture
def bw(vault, monkeypatch):
    monkeypatch.setenv("BW_SESSION", "fake-session-key")
    return vault


def bw_raw(monkeypatch, **raw):
    monkeypatch.setenv("FAKE_BW_RAW", json.dumps({k.replace("_", " "): v for k, v in raw.items()}))


# ---- bw get item

@pytest.mark.parametrize("raw", NOT_AN_OBJECT + ['{"name": "x", "login": "pw"}', '{"name": "x", "fields": 5}',
                                                 '{"name": "x", "fields": [1]}'])
def test_a_bw_item_that_isnt_an_item_object_is_a_clean_error(bw, monkeypatch, raw):
    bw_raw(monkeypatch, get_item=raw)
    for ref in ("bw:Network gear", "bw:Network gear#enable"):
        with pytest.raises(SecretError, match=r"couldn't read `bw get item` output"):
            get_secret(ref, "g")


# ---- bw list organizations / collections

@pytest.mark.parametrize("what", ["organizations", "collections"])
@pytest.mark.parametrize("raw", NOT_AN_OBJECT[1:] + ['{"id": "x"}', '[1]', '[{"id": "x"}, "y"]'])
def test_a_bw_listing_that_isnt_a_list_of_objects_is_a_clean_error(bw, monkeypatch, what, raw):
    monkeypatch.setenv("FAKE_BW_ORGS", json.dumps([
        {"id": "0rg-team", "name": "My Team", "status": 2, "type": 2, "enabled": True,
         "collections": [{"id": "c0l-infra", "name": "Infra logins"}]}]))
    bw_raw(monkeypatch, **{f"list_{what}": raw})
    with pytest.raises(SecretError, match=rf"couldn't read `bw list {what}` output"):
        providers.save_targets("bw")


# ---- bw create item: its answer of another shape is unreadable, so the new item is found by its name

@pytest.mark.parametrize("raw", NOT_AN_OBJECT + ['{"id": 5}', '{"id": "x", "collectionIds": 5}'])
def test_a_bw_create_answer_that_isnt_an_item_object_finds_the_item_by_name(bw, monkeypatch, raw):
    monkeypatch.setenv("FAKE_BW_ORGS", json.dumps([
        {"id": "0rg-team", "name": "My Team", "status": 2, "type": 2, "enabled": True,
         "collections": [{"id": "c0l-infra", "name": "Infra logins"}]}]))
    bw_raw(monkeypatch, create_item=raw)
    made = providers.create_item("bw", name="box ssh", password="n3w-pw",
                                 save_to={"organization": "0rg-team", "collection": "c0l-infra"})
    saved = next(i for i in json.loads(bw.read_text()) if i["name"] == "box ssh")
    assert made["id"] == saved["id"] and made["target"]["id"] == "collection:c0l-infra"


# ---- op

@pytest.fixture
def op(fakes, isolated, monkeypatch):
    monkeypatch.setenv("OP_SESSION_test", "tok")


def op_raw(monkeypatch, **raw):
    monkeypatch.setenv("FAKE_OP_RAW", json.dumps({k.replace("_", " "): v for k, v in raw.items()}))


@pytest.mark.parametrize("raw", NOT_AN_OBJECT + ["[[1]]", "[null]"])
def test_an_op_field_that_isnt_an_object_is_a_clean_error(op, monkeypatch, raw):
    op_raw(monkeypatch, item_get=raw)
    with pytest.raises(SecretError, match=r"couldn't read `op item get` output"):
        get_secret("op:Network gear", "g")


ODD_OVERVIEW = '[{"id": "a1", "title": "nas ssh", "vault": "Infra", "urls": 5}, 7, {"id": "b2", "title": "x", ' \
               '"vault": {"name": "Infra"}, "urls": "not a list"}]'


def test_op_overviews_of_another_shape_list_what_they_can(op, monkeypatch):
    op_raw(monkeypatch, item_list=ODD_OVERVIEW)
    items = providers.vault_items("op")
    assert [(i["id"], i["name"], i["uris"]) for i in items] == [("a1", "nas ssh", []), ("b2", "x", [])]
    assert "Infra/x" in items[1]["keys"] and "Infra/nas ssh" not in items[0]["keys"]


def test_an_op_overview_with_urls_of_another_shape_has_no_address(op, monkeypatch):
    op_raw(monkeypatch, item_list=ODD_OVERVIEW)
    assert providers.login_fields("op", "nas ssh") == {"uri": None, "username": None}


# ---- T254 (#500 item 1): a listed organization or collection missing a key it's read by is skipped, never a KeyError

GOOD_ORG = {"id": "0rg-team", "name": "My Team", "status": 2, "type": 2, "enabled": True}
GOOD_COLLECTION = {"id": "c0l-infra", "organizationId": "0rg-team", "name": "Infra logins", "externalId": None}
ODD_ORGS = [{k: v for k, v in GOOD_ORG.items() if k != "id"} | {"name": "No id"},
            {k: v for k, v in GOOD_ORG.items() if k != "name"} | {"id": "0rg-noname"},
            GOOD_ORG | {"id": 7, "name": "Numeric id"}, GOOD_ORG]
ODD_COLLECTIONS = [{k: v for k, v in GOOD_COLLECTION.items() if k != "id"} | {"name": "No id"},
                   {k: v for k, v in GOOD_COLLECTION.items() if k != "name"} | {"id": "c0l-noname"},
                   {k: v for k, v in GOOD_COLLECTION.items() if k != "organizationId"} | {"id": "c0l-noorg"},
                   GOOD_COLLECTION | {"id": "c0l-noname-org", "organizationId": "0rg-noname"},
                   GOOD_COLLECTION | {"id": "c0l-numeric", "name": 5}, GOOD_COLLECTION]


def test_bw_targets_skip_organizations_and_collections_missing_a_key(bw, monkeypatch):
    bw_raw(monkeypatch, list_organizations=json.dumps(ODD_ORGS), list_collections=json.dumps(ODD_COLLECTIONS))
    targets = providers.save_targets("bw")["targets"]
    assert [t["id"] for t in targets] == ["personal", "collection:c0l-infra"]
    assert targets[1]["label"] == "My Team / Infra logins"


def test_bw_save_to_by_name_skips_rows_missing_a_key(bw, monkeypatch):
    """A row with no usable id doesn't count as a second organization or collection of that name."""
    orgs = ODD_ORGS + [{k: v for k, v in GOOD_ORG.items() if k != "id"}, GOOD_ORG | {"id": 7}]
    collections = ODD_COLLECTIONS + [{k: v for k, v in GOOD_COLLECTION.items() if k != "id"}]
    monkeypatch.setenv("FAKE_BW_ORGS", json.dumps([GOOD_ORG | {"collections": [{"id": "c0l-infra",
                                                                                 "name": "Infra logins"}]}]))
    bw_raw(monkeypatch, list_organizations=json.dumps(orgs), list_collections=json.dumps(collections))
    made = providers.create_item("bw", name="box ssh", password="n3w-pw",
                                 save_to={"organization": "My Team", "collection": "Infra logins"})
    assert made["target"]["id"] == "collection:c0l-infra"


# ---- T254 (#500 item 2): op lists an item's URLs in one order everywhere, the primary one first

def test_op_lists_an_items_urls_primary_first_in_the_listing_and_its_fields(op, monkeypatch):
    op_raw(monkeypatch, item_list=json.dumps([{"id": "a1", "title": "nas ssh", "vault": {"name": "Infra"}, "urls": [
        {"href": "https://10.0.0.6"}, {"href": "ssh://10.0.0.5", "primary": True}, {"href": "https://nas.example"}]}]))
    [item] = providers.vault_items("op")
    assert item["uris"] == ["ssh://10.0.0.5", "https://10.0.0.6", "https://nas.example"]
    assert item["uri"] == providers.login_fields("op", "nas ssh")["uri"] == "ssh://10.0.0.5"
