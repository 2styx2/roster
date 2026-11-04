"""`roster web` against a local HTTP server: credentials arrive, never show up in output."""

import base64
import http.server
import json
import threading

import pytest
from conftest import WINDOWS

from roster.cli import main

SECRET = "hunter2-TOPSECRET"


class Handler(http.server.BaseHTTPRequestHandler):
    seen = []

    def do_GET(self):  # noqa: N802
        Handler.seen.append((self.command, self.path, self.headers.get("Authorization"), None))
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "http://elsewhere.example/steal")
            self.end_headers()
            return
        body = b"echo " + SECRET.encode() if self.path == "/echo" else b'{"ok": true}'
        self.send_response(401 if self.path == "/denied" else 200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        data = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        Handler.seen.append((self.command, self.path, self.headers.get("Authorization"), data))
        self.send_response(201)
        self.end_headers()
        self.wfile.write(b"created")

    def log_message(self, *a):
        pass


@pytest.fixture
def server():
    Handler.seen = []
    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1]
    srv.shutdown()


@pytest.fixture
def cfg(write_config, server, monkeypatch):
    monkeypatch.setenv("WEB_PW", SECRET)
    write_config(f"""\
groups:
  g:
    user: sshuser
    auth: env:NOT_USED_FOR_WEB
    hosts:
      box:
        ip: 127.0.0.1
        services:
          gui: {{url: "http://127.0.0.1:{server}", user: webadmin, auth: env:WEB_PW}}
          api: {{url: "http://127.0.0.1:{server}/api", auth: env:WEB_PW, login: bearer}}
          open: {{url: "http://127.0.0.1:{server}", login: none}}
      hidden: {{ip: 127.0.0.1, reviewed: false, services: {{gui: {{url: "http://127.0.0.1:{server}"}}}}}}
""")


def run(capsys, *argv):
    rc = main(["web", *argv])
    out = capsys.readouterr()
    return rc, out.out, out.err


def test_basic_login_sent_never_shown(capsys, cfg):
    rc, out, err = run(capsys, "box", "gui", "GET", "/status")
    assert rc == 0 and '{"ok": true}' in out and "HTTP 200" in err
    _, path, auth, _ = Handler.seen[-1]
    assert path == "/status" and auth == "Basic " + base64.b64encode(f"webadmin:{SECRET}".encode()).decode()
    assert SECRET not in out + err and "Basic" not in out + err and auth.split()[1] not in out + err


def test_default_service_is_the_web_ui(capsys, cfg):
    rc, out, _ = run(capsys, "box", "GET", "/")      # gui is the first service with a url
    assert rc == 0 and Handler.seen[-1][2].startswith("Basic ")


def test_bearer_and_base_path(capsys, cfg):
    rc, _, _ = run(capsys, "box", "api", "GET", "v1/things")
    assert rc == 0 and Handler.seen[-1][1:3] == ("/api/v1/things", f"Bearer {SECRET}")


def test_login_none_sends_nothing(capsys, cfg):
    run(capsys, "box", "open", "GET", "/")
    assert Handler.seen[-1][2] is None


def test_post_body_and_status(capsys, cfg):
    rc, out, err = run(capsys, "box", "gui", "POST", "/things", "-d", '{"a": 1}')
    assert rc == 0 and out.strip() == "created" and "HTTP 201" in err
    assert Handler.seen[-1][3] == '{"a": 1}'


def test_error_status_exits_1(capsys, cfg):
    rc, out, err = run(capsys, "box", "gui", "GET", "/denied")
    assert rc == 1 and "HTTP 401" in err


def test_secret_echoed_by_server_is_masked(capsys, cfg):
    _, out, _ = run(capsys, "box", "gui", "GET", "/echo")
    assert SECRET not in out and "echo ********" in out


def test_redirect_not_followed(capsys, cfg):
    rc, _, err = run(capsys, "box", "gui", "GET", "/redirect")
    assert rc == 0 and "302" in err and "not followed" in err
    assert len(Handler.seen) == 1                    # nothing went to the Location


@pytest.mark.parametrize("argv, err", [
    (("box", "gui", "GET", "http://evil.example/x"), "not a full URL"),
    (("box", "gui", "GET", "//evil.example/x"), "not a full URL"),
    (("box", "gui", "GET", "/", "-H", "Authorization: x"), "don't pass Authorization"),
    (("box", "gui", "FETCH", "/"), "unknown method"),
    (("box", "nope", "GET", "/"), "no service 'nope'"),
    (("hidden", "GET", "/"), "reviewed: false"),
    (("ghost", "GET", "/"), "unknown host"),
])
def test_refusals(cfg, argv, err):
    with pytest.raises(SystemExit, match=err):
        main(["web", *argv])
    assert Handler.seen == []


def test_unreachable_names_reference_not_value(write_config, monkeypatch):
    monkeypatch.setenv("WEB_PW", SECRET)
    write_config("groups:\n  g:\n    user: u\n    hosts:\n      box:\n        ip: 127.0.0.1\n"
                 "        services: {gui: {url: 'http://127.0.0.1:1', user: w, auth: env:WEB_PW}}\n")
    with pytest.raises(SystemExit) as e:
        main(["web", "box", "GET", "/"])
    assert "can't reach" in str(e.value) and SECRET not in str(e.value)


def test_a_bad_login_setting_warns_and_only_that_service_refuses(write_config, capsys):
    write_config("groups:\n  g:\n    user: u\n    hosts:\n      box:\n        ip: 127.0.0.1\n"
                 "        services: {gui: {port: 443, login: form}}\n")
    assert main(["hosts"]) == 0
    out, err = capsys.readouterr()
    assert "box" in out
    assert "warning: box service 'gui': login: 'form' isn't a login type" in err and "fix:" in err
    with pytest.raises(SystemExit, match="box service 'gui': login: 'form'") as e:
        main(["web", "box", "gui", "GET", "/"])
    assert "web_login_names" in str(e.value)


def test_the_default_web_service_broken_says_why(write_config):
    write_config("groups:\n  g:\n    user: u\n    hosts:\n      box:\n        ip: 127.0.0.1\n"
                 "        services: {web: {url: 'https://127.0.0.1', login: form}}\n")
    with pytest.raises(SystemExit, match="box service 'web': login: 'form'"):
        main(["web", "box", "GET", "/"])


class FakeVsphere(http.server.BaseHTTPRequestHandler):
    """Just enough of the ESXi SOAP API: versions, service content, Login/Logout, one call."""
    calls = []
    COOKIE = 'vmware_soap_session="sess-abc123"'

    def do_GET(self):  # noqa: N802
        self.reply(200, "<namespaces><namespace><name>urn:vim25</name><version>8.0.3.0</version></namespace>"
                        "</namespaces>")

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        op = next((o for o in ("RetrieveServiceContent", "Login", "Logout", "RetrieveProperties")
                   if f"<urn:{o}" in body), "?")
        FakeVsphere.calls.append((op, self.headers.get("SOAPAction"), self.headers.get("Cookie"), body))
        if op == "RetrieveServiceContent":
            return self.reply(200, '<returnval><sessionManager type="SessionManager">ha-sessionmgr</sessionManager>'
                                   "</returnval>")
        if op == "Login":
            if f"<urn:password>{SECRET}</urn:password>" not in body or "<urn:userName>root</urn:userName>" not in body:
                return self.reply(500, "<faultstring>Cannot complete login due to an incorrect user name or "
                                       "password.</faultstring>")
            return self.reply(200, "<returnval><userName>root</userName></returnval>",
                              {"Set-Cookie": self.COOKIE + "; Path=/; HttpOnly; Secure"})
        if self.headers.get("Cookie") != self.COOKIE:
            return self.reply(500, "<faultstring>The session is not authenticated.</faultstring>")
        self.reply(200, f"<returnval>{op} ok, echo {SECRET} sess-abc123</returnval>")

    def reply(self, code, text, headers=None):
        self.send_response(code)
        self.send_header("Content-Type", "text/xml")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(text.encode())

    def log_message(self, *a):
        pass


@pytest.fixture
def esxi(write_config, monkeypatch):
    FakeVsphere.calls = []
    srv = http.server.HTTPServer(("127.0.0.1", 0), FakeVsphere)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv("ESXI_PW", SECRET)
    write_config("groups:\n  g:\n    user: root\n    auth: env:ESXI_PW\n    hosts:\n      esxi:\n        ip: 127.0.0.1\n"
                 f"        services: {{https: {{url: 'http://127.0.0.1:{srv.server_address[1]}', login: vsphere}}}}\n")
    yield
    srv.shutdown()


def test_vsphere_session_login_call_logout(capsys, esxi):
    rc, out, err = run(capsys, "esxi", "POST", "/sdk", "-d", "<urn:RetrieveProperties>x</urn:RetrieveProperties>")
    assert rc == 0 and "RetrieveProperties ok" in out
    assert [c[0] for c in FakeVsphere.calls] == ["RetrieveServiceContent", "Login", "RetrieveProperties", "Logout"]
    call = FakeVsphere.calls[2]
    assert call[1] == "urn:vim25/8.0.3.0" and call[2] == FakeVsphere.COOKIE    # SOAPAction added, session sent
    assert call[3].count(":Envelope") == 2 and 'xmlns:urn="urn:vim25"' in call[3]   # bare body wrapped once
    assert SECRET not in out + err and "sess-abc123" not in out + err and out.count("********") == 2


class FakeUnifi(http.server.BaseHTTPRequestHandler):
    """Just enough of UniFi OS: JSON login -> TOKEN cookie + CSRF header, API calls with that session."""
    calls = []
    TOKEN, CSRF = "tok-xyz789", "csrf-456"

    def do_GET(self):  # noqa: N802
        self.handle_call("GET", b"")

    def do_POST(self):  # noqa: N802
        self.handle_call("POST", self.rfile.read(int(self.headers.get("Content-Length", 0))))

    def handle_call(self, method, body):
        FakeUnifi.calls.append((method, self.path, self.headers.get("Cookie"), self.headers.get("X-CSRF-Token")))
        if self.path == "/api/auth/login":
            creds = json.loads(body)
            if creds != {"username": "admin", "password": SECRET, "rememberMe": False}:
                return self.reply(403, '{"code":"AUTHENTICATION_FAILED_INVALID_CREDENTIALS",'
                                       '"message":"Invalid username or password"}')
            return self.reply(200, '{"username":"admin"}', {"Set-Cookie": f"TOKEN={self.TOKEN}; path=/; secure",
                                                             "X-CSRF-Token": self.CSRF})
        if self.headers.get("Cookie") != f"TOKEN={self.TOKEN}":
            return self.reply(401, '{"error":{"code":401,"message":"Unauthorized"}}')
        self.reply(200, f'{{"data":"{method} {self.path} ok, echo {SECRET} {self.TOKEN}"}}')

    def reply(self, code, text, headers=None):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(text.encode())

    def log_message(self, *a):
        pass


@pytest.fixture
def unifi(write_config, monkeypatch):
    FakeUnifi.calls = []
    srv = http.server.HTTPServer(("127.0.0.1", 0), FakeUnifi)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv("UNIFI_PW", SECRET)
    write_config("groups:\n  g:\n    user: admin\n    auth: env:UNIFI_PW\n    hosts:\n      udm:\n        ip: 127.0.0.1\n"
                 f"        services: {{web: {{url: 'http://127.0.0.1:{srv.server_address[1]}', login: unifi}}}}\n")
    yield
    srv.shutdown()


def unifi_logins():
    return sum(c[1] == "/api/auth/login" for c in FakeUnifi.calls)


def unifi_cache(isolated):
    files = list((isolated["home"].parent / "run" / "roster" / "sessions").glob("udm-web-*.json"))
    assert len(files) == 1
    return files[0]


def test_unifi_session_login_then_call(capsys, unifi):
    rc, out, err = run(capsys, "udm", "POST", "/proxy/network/api/s/default/stat/health", "-d", "{}")
    assert rc == 0 and "POST /proxy/network/api/s/default/stat/health ok" in out
    assert [c[1] for c in FakeUnifi.calls] == ["/api/auth/login", "/proxy/network/api/s/default/stat/health"]
    call = FakeUnifi.calls[1]
    assert call[2] == f"TOKEN={FakeUnifi.TOKEN}" and call[3] == FakeUnifi.CSRF
    assert SECRET not in out + err and FakeUnifi.TOKEN not in out + err and out.count("********") == 2


def test_unifi_session_reused_across_calls(capsys, unifi, isolated):
    for _ in range(5):
        rc, out, err = run(capsys, "udm", "GET", "/proxy/network/api/s/default/rest/networkconf")
        assert rc == 0 and FakeUnifi.TOKEN not in out + err
    assert unifi_logins() == 1 and len(FakeUnifi.calls) == 6           # one login, no logouts
    cache = unifi_cache(isolated)
    if not WINDOWS:                     # Windows: private by the profile folder's ACL, not a mode
        assert cache.stat().st_mode & 0o777 == 0o600 and cache.parent.stat().st_mode & 0o777 == 0o700
    assert SECRET not in cache.read_text()                              # the session, never the password


def test_unifi_expired_session_logs_in_again(capsys, unifi, isolated):
    run(capsys, "udm", "GET", "/api/users/self")
    cache = unifi_cache(isolated)
    cache.write_text(json.dumps({**json.loads(cache.read_text()), "expires": 0}))
    rc, *_ = run(capsys, "udm", "GET", "/api/users/self")
    assert rc == 0 and unifi_logins() == 2


def test_an_expired_kept_session_is_deleted_when_found(tmp_path):
    from roster import web
    path = tmp_path / "udm-unifi.json"
    path.write_text(json.dumps({"cookie": "TOKEN=old", "expires": 0}))
    assert web.load_session(path) is None and not path.exists()


def test_unifi_rejected_session_logs_in_again_once(capsys, unifi, isolated):
    run(capsys, "udm", "GET", "/api/users/self")
    cache = unifi_cache(isolated)
    cache.write_text(json.dumps({**json.loads(cache.read_text()), "cookie": "TOKEN=logged-out"}))
    rc, out, _ = run(capsys, "udm", "POST", "/proxy/network/api/s/default/rest/networkconf", "-d", "{}")
    assert rc == 0 and "POST /proxy/network/api/s/default/rest/networkconf ok" in out
    assert [c[1] for c in FakeUnifi.calls[1:]] == ["/api/users/self", "/proxy/network/api/s/default/rest/networkconf",
                                                   "/api/auth/login", "/proxy/network/api/s/default/rest/networkconf"]
    assert json.loads(cache.read_text())["cookie"] == f"TOKEN={FakeUnifi.TOKEN}"


def test_unifi_session_ends_before_the_token_does(capsys, unifi, isolated, monkeypatch):
    exp = int(__import__("time").time()) + 120
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    monkeypatch.setattr(FakeUnifi, "TOKEN", f"eyJhbGciOiJIUzI1NiJ9.{payload}.sig")
    run(capsys, "udm", "GET", "/api/users/self")
    assert json.loads(unifi_cache(isolated).read_text())["expires"] == exp - 30


def test_unifi_wrong_password_names_reason_not_value(unifi, monkeypatch, isolated):
    monkeypatch.setenv("UNIFI_PW", "wrong-" + SECRET)
    with pytest.raises(SystemExit, match=r"UniFi login refused \(HTTP 403\): Invalid username or password") as e:
        main(["web", "udm", "GET", "/api/users/self"])
    assert SECRET not in str(e.value)
    assert [c[1] for c in FakeUnifi.calls] == ["/api/auth/login"]
    assert not (isolated["home"].parent / "run" / "roster").exists()   # nothing cached for a refused login


class FakeOpenvpnAs(http.server.BaseHTTPRequestHandler):
    """Just enough of OpenVPN Access Server's admin API: token login, one call that needs the token."""
    calls = []
    TOKEN = "astok-123456"

    def do_GET(self):  # noqa: N802
        self.handle_call("GET", b"")

    def do_POST(self):  # noqa: N802
        self.handle_call("POST", self.rfile.read(int(self.headers.get("Content-Length", 0))))

    def handle_call(self, method, body):
        FakeOpenvpnAs.calls.append((method, self.path, self.headers.get("X-OpenVPN-As-AuthToken")))
        if self.path == "/api/auth/login/userpassword":
            creds = json.loads(body)
            if (creds.get("username"), creds.get("password")) != ("openvpn", SECRET):
                return self.reply(401, '{"detail":"Invalid credentials"}')
            return self.reply(200, f'{{"auth_token":"{self.TOKEN}","expires_after":"2026-10-13T00:00:00Z"}}')
        if self.headers.get("X-OpenVPN-As-AuthToken") != self.TOKEN:
            return self.reply(400, '{"detail":"Missing auth token"}')
        self.reply(200, f'{{"version":"3.2.2","echo":"{SECRET} {self.TOKEN}"}}')

    def reply(self, code, text):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(text.encode())

    def log_message(self, *a):
        pass


@pytest.fixture
def openvpnas(write_config, monkeypatch):
    FakeOpenvpnAs.calls = []
    srv = http.server.HTTPServer(("127.0.0.1", 0), FakeOpenvpnAs)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv("OVPN_PW", SECRET)
    write_config("groups:\n  g:\n    user: openvpn\n    auth: env:OVPN_PW\n    hosts:\n      vpn:\n        ip: 127.0.0.1\n"
                 f"        services: {{admin: {{url: 'http://127.0.0.1:{srv.server_address[1]}', login: openvpnas}}}}\n")
    yield
    srv.shutdown()


def test_openvpnas_token_login_then_call(capsys, openvpnas):
    rc, out, err = run(capsys, "vpn", "admin", "GET", "/api/server/info")
    assert rc == 0 and '"version":"3.2.2"' in out
    assert [c[:2] for c in FakeOpenvpnAs.calls] == [("POST", "/api/auth/login/userpassword"),
                                                    ("GET", "/api/server/info")]
    assert FakeOpenvpnAs.calls[1][2] == FakeOpenvpnAs.TOKEN                     # token sent on the call
    assert SECRET not in out + err and FakeOpenvpnAs.TOKEN not in out + err and out.count("********") == 2


def test_openvpnas_wrong_password_names_reason_not_value(openvpnas, monkeypatch):
    monkeypatch.setenv("OVPN_PW", "wrong-" + SECRET)
    with pytest.raises(SystemExit, match=r"Access Server login refused \(HTTP 401\): Invalid credentials") as e:
        main(["web", "vpn", "admin", "GET", "/api/server/info"])
    assert SECRET not in str(e.value)
    assert [c[1] for c in FakeOpenvpnAs.calls] == ["/api/auth/login/userpassword"]


class FakeHub(http.server.BaseHTTPRequestHandler):
    """Just enough of the HUB web API: JSON login returning a bearer token, one call that needs it."""
    calls = []
    TOKEN = "hubtok-123456"

    def do_GET(self):  # noqa: N802
        self.handle_call("GET", b"")

    def do_POST(self):  # noqa: N802
        self.handle_call("POST", self.rfile.read(int(self.headers.get("Content-Length", 0))))

    def handle_call(self, method, body):
        FakeHub.calls.append((method, self.path, self.headers.get("Authorization"), self.headers.get("Content-Type")))
        if self.path == "/api/auth/login":
            creds = json.loads(body)
            if (creds.get("username"), creds.get("password")) != ("admin", SECRET):
                return self.reply(401, '{"detail":"Incorrect username or password"}')
            return self.reply(200, f'{{"access_token":"{self.TOKEN}","token_type":"bearer","expires_in":3600}}')
        if self.headers.get("Authorization") != f"Bearer {self.TOKEN}":
            return self.reply(401, '{"detail":"Not authenticated"}')
        self.reply(200, f'{{"username":"admin","role":"ADMIN","echo":"{SECRET} {self.TOKEN}"}}')

    def reply(self, code, text):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(text.encode())

    def log_message(self, *a):
        pass


@pytest.fixture
def hub(write_config, monkeypatch):
    FakeHub.calls = []
    srv = http.server.HTTPServer(("127.0.0.1", 0), FakeHub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv("HUB_PW", SECRET)
    write_config("groups:\n  g:\n    user: ops\n    auth: env:NOT_USED_FOR_WEB\n    hosts:\n      mini:\n"
                 "        ip: 127.0.0.1\n        services:\n"
                 f"          web: {{url: 'http://127.0.0.1:{srv.server_address[1]}', login: hub, user: admin,"
                 " auth: env:HUB_PW}\n")
    yield
    srv.shutdown()


def test_hub_json_login_then_bearer_call(capsys, hub):
    rc, out, err = run(capsys, "mini", "GET", "/api/auth/me")
    assert rc == 0 and '"role":"ADMIN"' in out
    assert [c[:2] for c in FakeHub.calls] == [("POST", "/api/auth/login"), ("GET", "/api/auth/me")]
    assert FakeHub.calls[0][3] == "application/json"                           # never a form body
    assert FakeHub.calls[1][2] == f"Bearer {FakeHub.TOKEN}"
    assert SECRET not in out + err and FakeHub.TOKEN not in out + err and out.count("********") == 2


def test_hub_wrong_password_names_reason_not_value(hub, monkeypatch):
    monkeypatch.setenv("HUB_PW", "wrong-" + SECRET)
    with pytest.raises(SystemExit, match=r"HUB login refused \(HTTP 401\): Incorrect username or password") as e:
        main(["web", "mini", "GET", "/api/auth/me"])
    assert SECRET not in str(e.value)
    assert [c[1] for c in FakeHub.calls] == ["/api/auth/login"]


def test_vsphere_wrong_password_names_fault_not_value(esxi, monkeypatch):
    monkeypatch.setenv("ESXI_PW", "wrong-" + SECRET)
    with pytest.raises(SystemExit, match="vSphere login refused: Cannot complete login") as e:
        main(["web", "esxi", "POST", "/sdk", "-d", "<x/>"])
    assert SECRET not in str(e.value)
    assert [c[0] for c in FakeVsphere.calls] == ["RetrieveServiceContent", "Login"]
