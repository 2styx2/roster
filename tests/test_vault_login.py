"""vault.login: signing the vault CLI in from the app, a step at a time (ticket 31). Driven as the app drives it,
through `roster serve`, against the fake bw (tests/fakes/bw), which prompts on its PTY the way bw does (a ConPTY on
native Windows, ticket 63). Every test checks that no secret reached a command line, serve's stdout or its stderr."""

import json

import pytest
from conftest import WINDOWS

INVENTORY = """\
groups:
  lab:
    user: ops
    auth: bw:lab ssh
    hosts:
      box: {ip: 10.0.0.5}
"""

EMAIL, PASSWORD = "wes@example.com", "hunter2"
TOTP, EMAIL_CODE, YUBI_OTP, DEVICE_CODE = "246810", "975311", "cccjgjgkhcbb", "135790"
CLIENT_ID, CLIENT_SECRET = "user.0b5e-fake", "cs-sekrit-42"
SECRETS = [PASSWORD, TOTP, EMAIL_CODE, YUBI_OTP, DEVICE_CODE, CLIENT_SECRET, "wrong-pw-xyzzy", "000000",
           "fake-session-key"]


@pytest.fixture
def signin(serve, write_config, fakes, isolated, monkeypatch):
    """A logged-out bw with ACCOUNT to sign in to; returns start(account) -> (serve, files)."""
    write_config(INVENTORY)
    tmp = isolated["home"].parent
    files = {"state": tmp / "bw-state.json", "argv": tmp / "bw-argv.log", "mail": tmp / "bw-mail.log"}
    files["state"].write_text(json.dumps({"logged_in": False, "server": None}))
    monkeypatch.setenv("FAKE_BW_STATE", str(files["state"]))
    monkeypatch.setenv("FAKE_ARGV_LOG", str(files["argv"]))
    monkeypatch.setenv("FAKE_BW_MAIL", str(files["mail"]))
    monkeypatch.setenv("ROSTER_NO_BROWSER", "1")

    def start(**account):
        monkeypatch.setenv("FAKE_BW_ACCOUNT", json.dumps({"email": EMAIL, "password": PASSWORD, **account}))
        return serve(), files
    return start


def login(s, **params):
    return s.call("vault.login", params)


def answer(s, step, **params):
    return s.call("vault.login", {"action": "answer", "login": step["login"], **params})


def no_secrets(s, files, *extra):
    """Nothing secret in any bw argv, in serve's responses, or on its stderr; the email isn't in argv either."""
    code, out, err = s.close()
    assert code == 0 and out == ""
    transcript = "".join(s.responses) + out + err
    argv = files["argv"].read_text() if files["argv"].exists() else ""
    for secret in [*SECRETS, *extra]:
        assert secret not in transcript, secret
        assert secret not in argv, secret
    assert EMAIL not in argv
    return err


def mails(files):
    return files["mail"].read_text().splitlines() if files["mail"].exists() else []


# ---- vault.status says a sign-in is possible

def test_logged_out_status_offers_sign_in(signin):
    s, files = signin()
    st = s.call("vault.status")["result"]
    assert st["status"] == "not-logged-in"
    assert st["sign_in"] == {"methods": ["password", "apikey", "sso"], "server": None}
    no_secrets(s, files)


# ---- email + master password, then whatever bw asks

def test_password_only_signs_in_and_unlocks(signin):
    s, files = signin()
    r = login(s, email=EMAIL, password=PASSWORD)["result"]
    assert r == {"step": "done", "provider": "bw", "status": "unlocked", "login": r["login"]}
    assert s.call("vault.status")["result"]["status"] == "unlocked"
    calls = [json.loads(line) for line in files["argv"].read_text().splitlines()]
    assert not any(c[0] == "unlock" for c in calls)            # the key `bw login --raw` printed, on Windows too
    no_secrets(s, files)


def test_several_methods_pick_email_wrong_code_then_right(signin):
    s, files = signin(methods=["authenticator", "email", "yubikey", "webauthn"],
                      codes={"authenticator": TOTP, "email": EMAIL_CODE, "yubikey": YUBI_OTP})
    step = login(s, email=EMAIL, password=PASSWORD)["result"]
    assert step["step"] == "two_factor_method"
    assert step["methods"] == [                                     # bw's order; FIDO2 isn't offered by the CLI
        {"index": 0, "id": 0, "kind": "authenticator", "name": "Authenticator App"},
        {"index": 1, "id": 3, "kind": "yubikey", "name": "Yubico OTP Security Key"},
        {"index": 2, "id": 1, "kind": "email", "name": "Email"}]
    step = answer(s, step, method=2)["result"]
    assert (step["step"], step["method"]["kind"], step["sent"]) == ("two_factor_code", "email", True)
    assert mails(files) == ["two-step code"]

    err = answer(s, step, code="000000")["error"]
    assert err["code"] == 50
    assert err["message"] == ("Bitwarden didn't accept that code (wrong or expired) - a new code is on its way "
                              "to your email")
    assert err["data"]["step"]["step"] == "two_factor_code" and err["data"]["login"] == step["login"]
    assert mails(files) == ["two-step code", "two-step code"]          # bw was run again: a fresh email

    done = answer(s, step, code=EMAIL_CODE)["result"]
    assert done["step"] == "done" and s.call("vault.status")["result"]["status"] == "unlocked"
    no_secrets(s, files)


def test_yubikey_from_the_list(signin):
    s, files = signin(methods=["authenticator", "yubikey"], codes={"authenticator": TOTP, "yubikey": YUBI_OTP})
    step = login(s, email=EMAIL, password=PASSWORD)["result"]
    step = answer(s, step, method=1)["result"]
    assert (step["step"], step["method"]["name"], step["sent"]) == ("two_factor_code", "Yubico OTP Security Key", False)
    assert answer(s, step, code=YUBI_OTP)["result"]["step"] == "done"
    no_secrets(s, files)


def test_one_method_goes_straight_to_the_code(signin):
    s, files = signin(methods=["authenticator"], codes={"authenticator": TOTP})
    step = login(s, email=EMAIL, password=PASSWORD)["result"]
    assert (step["step"], step["method"], step["sent"]) == ("two_factor_code", None, False)
    err = answer(s, step, code="000000")["error"]
    assert err["code"] == 50 and err["data"]["step"]["step"] == "two_factor_code"
    assert answer(s, step, code=TOTP)["result"]["step"] == "done"
    no_secrets(s, files)


def test_new_device_code(signin):
    s, files = signin(new_device=True, new_device_code=DEVICE_CODE)
    step = login(s, email=EMAIL, password=PASSWORD)["result"]
    assert step["step"] == "new_device_code" and step["email"] == EMAIL
    err = answer(s, step, code="000000")["error"]
    assert err["code"] == 50 and err["data"]["step"]["step"] == "new_device_code"
    assert "a new code is on its way" in err["message"]
    assert answer(s, step, code=DEVICE_CODE)["result"]["step"] == "done"
    assert mails(files) == ["new-device code", "new-device code"]
    no_secrets(s, files)


def test_wrong_password_ends_the_sign_in(signin):
    s, files = signin()
    err = login(s, email=EMAIL, password="wrong-pw-xyzzy")["error"]
    assert err["code"] == 10
    assert err["message"] == "Bitwarden didn't accept that email and master password (on bitwarden.com)"
    assert "step" not in err.get("data", {})
    assert answer(s, {"login": "anything"}, code="1")["error"]["code"] == 55
    no_secrets(s, files)


# ---- what the CLI can't do, and the server saying no

def test_only_fido2_or_duo_is_unsupported_with_a_way_out(signin):
    for methods in (["webauthn"], ["duo", "webauthn"]):
        s, files = signin(methods=methods)
        err = login(s, email=EMAIL, password=PASSWORD)["error"]
        assert err["code"] == 51
        assert "FIDO2 security keys and Duo aren't supported by the CLI" in err["message"]
        assert "API key" in err["message"] and err["data"]["fix"]
        no_secrets(s, files)


@pytest.mark.parametrize("account, code, words", [
    ({"rate_limited": True}, 52, "too many sign-in attempts"),
    ({"unreachable": True}, 53, "can't reach the Bitwarden server bitwarden.com"),
])
def test_server_refuses_or_is_unreachable(signin, account, code, words):
    s, files = signin(**account)
    err = login(s, email=EMAIL, password=PASSWORD)["error"]
    assert err["code"] == code and words in err["message"]
    no_secrets(s, files)


def test_already_logged_in(signin, isolated):
    s, files = signin()
    files["state"].write_text(json.dumps({"logged_in": True, "server": None, "email": EMAIL}))
    err = login(s, email=EMAIL, password=PASSWORD)["error"]
    assert err["code"] == 54 and f"already logged in on this box as {EMAIL}" in err["message"]
    no_secrets(s, files)


# ---- servers

def test_eu_server_is_set_before_signing_in(signin):
    s, files = signin()
    assert login(s, server="eu", email=EMAIL, password=PASSWORD)["result"]["step"] == "done"
    calls = [json.loads(line) for line in files["argv"].read_text().splitlines()]
    assert ["config", "server", "https://vault.bitwarden.eu", "--nointeraction"] in calls
    assert json.loads(files["state"].read_text())["server"] == "https://vault.bitwarden.eu"
    no_secrets(s, files)


def test_server_already_set_is_left_alone_and_a_bad_one_refused(signin):
    s, files = signin()
    files["state"].write_text(json.dumps({"logged_in": False, "server": "https://vault.example.com"}))
    assert s.call("vault.status")["result"]["sign_in"]["server"] == "https://vault.example.com"
    assert login(s, server="https://vault.example.com/", email=EMAIL, password=PASSWORD)["result"]["step"] == "done"
    assert not any('"config"' in line for line in files["argv"].read_text().splitlines())
    s.call("vault.lock")
    files["state"].write_text(json.dumps({"logged_in": False, "server": None}))
    err = login(s, server="vault example com", email=EMAIL, password=PASSWORD)["error"]
    assert err["code"] == 57 and "isn't a server address" in err["message"]
    no_secrets(s, files)


# ---- API key and SSO: log in, then unlock with the master password

def test_api_key_then_master_password(signin):
    s, files = signin(client_id=CLIENT_ID, client_secret=CLIENT_SECRET)
    step = login(s, method="apikey", client_id=CLIENT_ID, client_secret=CLIENT_SECRET)["result"]
    assert step["step"] == "master_password"
    err = answer(s, step, password="wrong-pw-xyzzy")["error"]
    assert err["code"] == 10 and err["data"]["step"]["step"] == "master_password"
    assert answer(s, step, password=PASSWORD)["result"]["step"] == "done"
    assert s.call("vault.status")["result"]["status"] == "unlocked"
    no_secrets(s, files, CLIENT_ID, "throwaway-key")


@pytest.mark.parametrize("client_id, words", [
    (CLIENT_ID, "didn't accept that API key"),
    ("organization.1234", "organization API key"),
])
def test_api_key_rejected(signin, client_id, words):
    s, files = signin(client_id=CLIENT_ID, client_secret=CLIENT_SECRET)
    err = login(s, method="apikey", client_id=client_id, client_secret="not-the-secret-7")["error"]
    assert err["code"] == 58 and words in err["message"]
    no_secrets(s, files, "not-the-secret-7")


def test_sso_hands_over_the_link_then_unlocks(signin):
    s, files = signin(sso="ok")
    step = login(s, method="sso", identifier="yourorg")["result"]
    if WINDOWS:     # bw opens the page itself (PowerShell's Start, which no PATH can stand in for): there's no link
        assert step["step"] == "sso" and step["url"] is None
    else:
        assert step["step"] == "sso" and step["url"].startswith("https://vault.bitwarden.com/#/sso?")
    assert 0 < step["expires_in"] <= 300
    step = answer(s, step)["result"]
    assert step["step"] == "master_password"
    assert answer(s, step, password=PASSWORD)["result"]["step"] == "done"
    assert ["login", "--sso", "yourorg"] in [json.loads(line) for line in files["argv"].read_text().splitlines()]
    no_secrets(s, files)


@pytest.mark.parametrize("how, code, words", [
    ("fail", 56, "failed in the browser"),
    ("tde", 51, "trusted device encryption"),
])
def test_sso_failures(signin, how, code, words):
    s, files = signin(sso=how)
    step = login(s, method="sso")["result"]
    err = answer(s, step)["error"]
    assert err["code"] == code and words in err["message"]
    no_secrets(s, files)


def test_sso_not_finished_in_time(signin, monkeypatch):
    monkeypatch.setenv("ROSTER_SSO_TIMEOUT", "1")
    s, files = signin(sso="hang")
    step = login(s, method="sso")["result"]
    err = answer(s, step)["error"]
    assert err["code"] == 56 and "wasn't finished in the browser" in err["message"]
    no_secrets(s, files)


# ---- the protocol

def test_cancel_and_lock_end_a_sign_in(signin):
    s, files = signin(new_device=True, new_device_code=DEVICE_CODE)
    step = login(s, email=EMAIL, password=PASSWORD)["result"]
    assert s.call("vault.login", {"action": "cancel"})["result"] == {"cancelled": True}
    assert answer(s, step, code=DEVICE_CODE)["error"]["code"] == 55
    step = login(s, email=EMAIL, password=PASSWORD)["result"]
    s.call("vault.lock")
    assert answer(s, step, code=DEVICE_CODE)["error"]["code"] == 55
    assert s.call("vault.login", {"action": "cancel"})["result"] == {"cancelled": False}
    no_secrets(s, files)


def test_a_new_start_replaces_the_old_one(signin):
    s, files = signin(new_device=True, new_device_code=DEVICE_CODE)
    old = login(s, email=EMAIL, password=PASSWORD)["result"]
    new = login(s, email=EMAIL, password=PASSWORD)["result"]
    assert old["login"] != new["login"]
    assert answer(s, old, code=DEVICE_CODE)["error"]["code"] == 55
    assert answer(s, new, code=DEVICE_CODE)["result"]["step"] == "done"
    no_secrets(s, files)


def test_bad_params(signin):
    s, files = signin(methods=["authenticator", "email"], codes={"authenticator": TOTP, "email": EMAIL_CODE})
    assert login(s, email=EMAIL)["error"]["code"] == -32602
    assert login(s, method="carrier-pigeon")["error"]["code"] == -32602
    assert s.call("vault.login", {"action": "dance"})["error"]["code"] == -32602
    step = login(s, email=EMAIL, password=PASSWORD)["result"]
    assert answer(s, step, method=7)["error"]["code"] == -32602        # the step stays: pick again
    step = answer(s, step, method=0)["result"]
    assert answer(s, step)["error"]["code"] == -32602                  # no code
    assert answer(s, step, code=TOTP)["result"]["step"] == "done"
    no_secrets(s, files)


def test_providers_without_a_sign_in_say_how_they_sign_in(signin):
    s, files = signin()
    err = login(s, provider="op", email=EMAIL, password=PASSWORD)["error"]
    assert err["code"] == 13 and "1Password signs in through its desktop app" in err["message"]
    assert "OP_SERVICE_ACCOUNT_TOKEN" in err["message"]
    err = login(s, provider="env", email=EMAIL, password=PASSWORD)["error"]
    assert err["code"] == 13
    no_secrets(s, files)


def test_missing_cli(signin, monkeypatch, tmp_path):
    s, files = signin()
    s.close()
    monkeypatch.setenv("PATH", str(tmp_path))
    from conftest import Serve
    s = Serve()
    err = login(s, email=EMAIL, password=PASSWORD)["error"]
    assert err["code"] == 12 and "`bw` is not installed" in err["message"]
    no_secrets(s, files)
