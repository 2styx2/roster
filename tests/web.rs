//! `roster web HOST [SERVICE] METHOD PATH`: curl calls a Host's API with its
//! stored Login, which reaches curl only as a config on stdin.
mod common;
use common::Sandbox;

const PASSWORD: &str = "pw-web-5c1e-made-up";

/// box-a has an `api` service with a basic Login from env:API_PASS.
fn sandbox(name: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    s.write(
        "roster.yml",
        "defaults: {user: admin}\ngroups:\n  lab:\n    hosts:\n      box-a:\n        \
         ip: 10.0.0.5\n        services:\n          \
         api: {port: 8443, user: ops, auth: env:API_PASS}\n          \
         token: {url: \"http://10.0.0.5:8080/ui\", login: bearer, auth: env:API_TOKEN}\n          \
         open: {port: 80, login: none}\n          \
         self: {port: 9443, scheme: https, verify: false, login: none}\n          \
         ssh-only: 2222\n      \
         box-b: {ip: 10.0.0.6, web: \"https://10.0.0.6\", auth: env:API_PASS}\n      \
         box-c: 10.0.0.7\n",
    );
    s.set_env("API_PASS", PASSWORD);
    s
}

fn read(s: &Sandbox, file: &str) -> String {
    std::fs::read_to_string(s.home.join(file)).unwrap_or_default()
}

/// curl's argv, one call per entry.
fn calls(s: &Sandbox) -> Vec<Vec<String>> {
    read(s, "curl.log")
        .split_terminator("\n\n")
        .map(|c| c.lines().map(String::from).collect())
        .collect()
}

fn argv(rest: &[&str]) -> Vec<String> {
    let fixed = [
        "-q",
        "-sS",
        "--proto",
        "=http,https",
        "--max-redirs",
        "0",
        "-w",
        "%{stderr}roster-http-status:%{http_code}\\n",
        "-K",
        "-",
    ];
    fixed.iter().chain(rest).map(|a| a.to_string()).collect()
}

#[test]
fn basic_login_goes_to_curl_as_a_config_on_stdin() {
    let mut s = sandbox("web-basic");
    s.set_env("FAKE_CURL_BODY", "{\"ok\": true}\n");
    let out = s.roster(&["web", "box-a", "api", "GET", "/v1/status"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "{\"ok\": true}\n");
    assert_eq!(out.stderr, "");
    assert_eq!(
        calls(&s),
        [argv(&["-X", "GET", "https://10.0.0.5:8443/v1/status"])]
    );
    assert_eq!(
        read(&s, "curl.stdin"),
        format!("user = \"ops:{PASSWORD}\"\n")
    );
}

#[test]
fn bearer_login_is_an_authorization_header_in_the_config() {
    let mut s = sandbox("web-bearer");
    s.set_env("API_TOKEN", "tok-9d2b-made-up");
    let out = s.roster(&["web", "box-a", "token", "POST", "/api/v2/jobs?x=1"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        calls(&s),
        [argv(&[
            "-X",
            "POST",
            "http://10.0.0.5:8080/api/v2/jobs?x=1"
        ])],
        "the service URL's own path is dropped: PATH starts at the origin"
    );
    assert_eq!(
        read(&s, "curl.stdin"),
        "header = \"Authorization: Bearer tok-9d2b-made-up\"\n"
    );
}

#[test]
fn quotes_backslashes_and_newlines_are_escaped_in_the_config() {
    let mut s = sandbox("web-quote");
    s.set_env("API_PASS", "a\"b\\c\nuser = x");
    let out = s.roster(&["web", "box-a", "api", "GET", "/"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        read(&s, "curl.stdin"),
        "user = \"ops:a\\\"b\\\\c\\nuser = x\"\n"
    );
}

#[test]
fn an_http_error_status_exits_1() {
    let mut s = sandbox("web-404");
    s.set_env("FAKE_CURL_STATUS", "404");
    s.set_env("FAKE_CURL_BODY", "not found\n");
    let out = s.roster(&["web", "box-a", "api", "GET", "/nope"]);
    assert_eq!(out.code, 1);
    assert_eq!(out.stdout, "not found\n", "the body still shows");
    assert_eq!(out.stderr, "roster: box-a api: HTTP 404\n");
    s.set_env("FAKE_CURL_STATUS", "403");
    let out = s.roster(&["web", "box-a", "api", "GET", "/nope"]);
    assert_eq!(
        out.stderr,
        "roster: box-a api: login refused (HTTP 403)\n  \
         hint: check the service's user: and auth: in roster.yml\n"
    );
    s.set_env("FAKE_CURL_STATUS", "399");
    assert_eq!(s.roster(&["web", "box-a", "api", "GET", "/"]).code, 0);
}

#[test]
fn a_path_that_could_leave_the_origin_is_refused() {
    let s = sandbox("web-path");
    for path in [
        "v1/status",
        "//10.0.0.66/x",
        "/a/../b",
        "/..",
        "/x?next=http://10.0.0.66/",
        "/a b",
        "/a\\b",
        "/a\nb",
    ] {
        let out = s.roster(&["web", "box-a", "api", "GET", path]);
        assert_eq!(out.code, 2, "{path:?}: {}", out.stderr);
        assert!(out.stderr.contains("PATH"), "{path:?}: {}", out.stderr);
    }
    assert_eq!(read(&s, "curl.log"), "", "curl never ran");
}

#[test]
fn without_service_the_web_service_is_used() {
    let s = sandbox("web-default");
    let out = s.roster(&["web", "box-b", "GET", "/"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(calls(&s), [argv(&["-X", "GET", "https://10.0.0.6/"])]);
    assert_eq!(
        read(&s, "curl.stdin"),
        format!("user = \"admin:{PASSWORD}\"\n"),
        "the legacy web: field takes the Host's user and auth"
    );
}

#[test]
fn login_none_sends_no_credential() {
    let s = sandbox("web-none");
    let out = s.roster(&["web", "box-a", "open", "DELETE", "/x"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(calls(&s), [argv(&["-X", "DELETE", "http://10.0.0.5/x"])]);
    assert_eq!(read(&s, "curl.stdin"), "");
}

#[test]
fn unknown_hosts_services_and_bad_words_stop_before_curl() {
    let s = sandbox("web-unknown");
    let cases: [(&[&str], i32, &str); 7] = [
        (&["web", "box-z", "GET", "/"], 1, "no Host named 'box-z'"),
        (
            &["web", "box-a", "nope", "GET", "/"],
            1,
            "box-a has no service 'nope'",
        ),
        (
            &["web", "box-a", "ssh-only", "GET", "/"],
            1,
            "box-a ssh-only has no http(s) URL",
        ),
        (
            &["web", "box-c", "GET", "/"],
            1,
            "box-c has no web service: name one",
        ),
        (&["web", "box-a", "api", "get", "/"], 2, "METHOD"),
        (&["web", "box-a", "api", "-X", "/"], 2, "-X"),
        (&["web", "box-a"], 2, "web needs HOST [SERVICE] METHOD PATH"),
    ];
    for (args, code, msg) in cases {
        let out = s.roster(args);
        assert_eq!(out.code, code, "{args:?}: {}", out.stderr);
        assert!(out.stderr.contains(msg), "{args:?}: {}", out.stderr);
    }
    assert_eq!(read(&s, "curl.log"), "", "curl never ran");
}

#[test]
fn a_body_headers_and_insecure_tls_reach_curl() {
    let s = sandbox("web-body");
    let out = s.roster(&[
        "web",
        "-H",
        "Accept: application/json",
        "box-a",
        "api",
        "PUT",
        "/v1/x",
        "-d",
        "{\"name\": \"a\\\"b\"}",
        "-k",
        "-H",
        "X-Trace: 1",
    ]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        calls(&s),
        [argv(&[
            "-k",
            "-H",
            "Accept: application/json",
            "-H",
            "X-Trace: 1",
            "-X",
            "PUT",
            "https://10.0.0.5:8443/v1/x"
        ])]
    );
    assert_eq!(
        read(&s, "curl.stdin"),
        format!("user = \"ops:{PASSWORD}\"\ndata-raw = \"{{\\\"name\\\": \\\"a\\\\\\\"b\\\"}}\"\n"),
        "a literal body goes in the config, so @ in it is never a file"
    );
}

#[test]
fn a_body_from_a_file_and_verify_false() {
    let s = sandbox("web-file");
    let out = s.roster(&["web", "box-a", "self", "POST", "/", "-d", "@body.json"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        calls(&s),
        [argv(&[
            "-k",
            "--data-binary",
            "@body.json",
            "-X",
            "POST",
            "https://10.0.0.5:9443/"
        ])]
    );
    let out = s.roster(&["web", "box-a", "self", "POST", "/", "-d", "@-"]);
    assert_eq!(out.code, 2, "stdin carries the config: {}", out.stderr);
}

/// Every file under `dir`, recursively.
fn files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut all = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            all.extend(files(&path));
        } else {
            all.push(path);
        }
    }
    all
}

#[test]
fn the_credential_never_leaks() {
    let mut s = sandbox("web-secrets");
    let token = "tok-31f7-made-up";
    s.set_env("API_TOKEN", token);
    s.set_env("FAKE_CURL_STATUS", "500");
    for service in ["api", "token"] {
        let out = s.roster(&["web", "box-a", service, "POST", "/x", "-d", "{}"]);
        assert_eq!(out.code, 1, "{}", out.stderr);
        for secret in [PASSWORD, token] {
            assert!(!out.stdout.contains(secret) && !out.stderr.contains(secret));
        }
    }
    let stdin = read(&s, "curl.stdin");
    assert!(stdin.contains(token), "the fake got the last one: {stdin}");
    let env = read(&s, "curl.env");
    assert!(env.contains("HOME="), "the fake saved its environment");
    for secret in [PASSWORD, token] {
        assert!(!read(&s, "curl.log").contains(secret), "argv");
        assert!(!env.contains(secret), "curl's environment");
        for file in files(&s.home) {
            if file.ends_with("curl.stdin") {
                continue;
            }
            let bytes = std::fs::read(&file).unwrap();
            let hit = bytes.windows(secret.len()).any(|w| w == secret.as_bytes());
            assert!(!hit, "a credential is in {}", file.display());
        }
    }
}

/// curl's own words never show: each failure is one line of roster's.
#[test]
fn a_failed_connection_is_said_plainly_and_exits_1() {
    let verify = "  hint: if you trust it, give the service `verify: false` in roster.yml, \
                  or pass -k\n";
    for (exit, curl_says, want) in [
        (
            "7",
            "curl: (7) Failed to connect to 10.0.0.5 port 8443 after 0 ms: Connection refused",
            "nothing is listening on 10.0.0.5:8443\n".to_string(),
        ),
        (
            "28",
            "curl: (28) Connection timed out after 10002 milliseconds",
            "can't reach 10.0.0.5:8443 (timed out)\n".into(),
        ),
        (
            "7",
            "curl: (7) Failed to connect to 10.0.0.5 port 8443 after 3 ms: No route to host",
            "can't reach 10.0.0.5:8443 (no route)\n".into(),
        ),
        (
            "6",
            "curl: (6) Could not resolve host: 10.0.0.5",
            "can't resolve 10.0.0.5\n  hint: check the service's url: in roster.yml\n".into(),
        ),
        (
            "60",
            "curl: (60) SSL certificate problem: self-signed certificate\n\
             More details here: https://curl.se/docs/sslcerts.html\n\n\
             curl failed to verify the legitimacy of the server and therefore could not\n\
             establish a secure connection to it.",
            format!(
                "the certificate of https://10.0.0.5:8443 isn't trusted (self-signed certificate)\n{verify}"
            ),
        ),
        (
            "52",
            "curl: (52) Empty reply from server",
            "10.0.0.5:8443 closed the connection without a reply\n".into(),
        ),
        (
            "35",
            "\x1b[1mcurl: (35) TLS connect error: error:0A00010B:SSL routines::wrong version number\x1b[0m",
            "curl: TLS connect error: error:0A00010B:SSL routines::wrong version number\n".into(),
        ),
    ] {
        let mut s = sandbox("web-down");
        s.set_env("FAKE_CURL_EXIT", exit);
        s.set_env("FAKE_CURL_ERROR", curl_says);
        let out = s.roster(&["web", "box-a", "api", "GET", "/"]);
        assert_eq!(out.code, 1);
        assert_eq!(
            out.stderr,
            format!("roster: box-a api: {want}"),
            "{curl_says}"
        );
    }
}

const TOKEN: &str = "tok-7a3e-made-up";

/// box-t has a `web` service with a Login from env:API_PASS and FIELDS
/// added to its entry; `acme` is `hub` (a token login with the default
/// fields) through `web_login_names`.
fn token_sandbox(name: &str, fields: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    s.write(
        "roster.yml",
        &format!(
            "web_login_names: {{acme: hub}}\ndefaults: {{user: admin}}\ngroups:\n  lab:\n    \
             hosts:\n      box-t:\n        ip: 10.0.0.9\n        services:\n          \
             web: {{url: \"https://10.0.0.9\", verify: false, user: ops, auth: env:API_PASS{fields}}}\n"
        ),
    );
    s.set_env("API_PASS", PASSWORD);
    s.set_env(
        "FAKE_CURL_TOKEN_BODY",
        &format!("{{\"access_token\": \"{TOKEN}\"}}"),
    );
    s
}

/// The JSON body of the token login, from its curl config.
fn login_body(s: &Sandbox) -> serde_json::Value {
    let config = read(s, "curl.login.stdin");
    let body = config
        .strip_prefix("data-raw = \"")
        .and_then(|b| b.strip_suffix("\"\n"))
        .unwrap_or_else(|| panic!("{config}"))
        .replace("\\\"", "\"");
    serde_json::from_str(&body).unwrap()
}

#[test]
fn a_hub_login_named_by_web_login_names_posts_json_then_sends_the_token() {
    let mut s = token_sandbox("web-hub", ", login: acme");
    s.set_env("FAKE_CURL_BODY", "[]\n");
    let out = s.roster(&["web", "box-t", "GET", "/api/v1/things"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "[]\n", "the login reply isn't printed");
    assert_eq!(out.stderr, "");
    assert_eq!(
        calls(&s),
        [
            argv(&[
                "-k",
                "-H",
                "Content-Type: application/json",
                "-X",
                "POST",
                "https://10.0.0.9/api/auth/login"
            ]),
            argv(&["-k", "-X", "GET", "https://10.0.0.9/api/v1/things"]),
        ]
    );
    assert_eq!(
        login_body(&s),
        serde_json::json!({"username": "ops", "password": PASSWORD})
    );
    assert_eq!(
        read(&s, "curl.stdin"),
        format!("header = \"Authorization: Bearer {TOKEN}\"\n")
    );
}

#[test]
fn a_token_login_takes_its_path_fields_and_header_from_the_service() {
    let mut s = token_sandbox(
        "web-token-fields",
        ", login: token, login_path: /v2/session, token_field: data.token, \
         user_field: login, password_field: secret, token_header: X-Auth-Token",
    );
    s.set_env("FAKE_CURL_LOGIN_PATH", "/v2/session");
    s.set_env(
        "FAKE_CURL_TOKEN_BODY",
        &format!("{{\"data\": {{\"token\": \"{TOKEN}\", \"ttl\": 600}}}}"),
    );
    let out = s.roster(&["web", "box-t", "web", "-k", "DELETE", "/v2/x"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(calls(&s)[0].last().unwrap(), "https://10.0.0.9/v2/session");
    assert_eq!(
        login_body(&s),
        serde_json::json!({"login": "ops", "secret": PASSWORD})
    );
    assert_eq!(
        read(&s, "curl.stdin"),
        format!("header = \"X-Auth-Token: {TOKEN}\"\n"),
        "a header other than Authorization gets the bare token"
    );
}

#[test]
fn login_hub_is_a_token_login_and_an_unknown_login_drops_the_service() {
    let s = token_sandbox("web-hub-plain", ", login: hub");
    let out = s.roster(&["web", "box-t", "GET", "/"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        read(&s, "curl.stdin"),
        format!("header = \"Authorization: Bearer {TOKEN}\"\n")
    );
    let s = token_sandbox("web-login-unknown", ", login: sso");
    let out = s.roster(&["web", "box-t", "web", "GET", "/"]);
    assert_eq!(out.code, 1);
    assert!(
        out.stderr.contains("box-t has no service 'web'"),
        "{}",
        out.stderr
    );
}

#[test]
fn a_refused_login_or_a_reply_without_a_token_stops_before_the_request() {
    let mut s = token_sandbox("web-token-refused", ", login: acme");
    s.set_env("FAKE_CURL_LOGIN_STATUS", "401");
    let out = s.roster(&["web", "box-t", "GET", "/x"]);
    assert_eq!(out.code, 1);
    assert_eq!(
        out.stderr,
        "roster: box-t web: token login to /api/auth/login: login refused (HTTP 401)\n  \
         hint: check the service's user: and auth: in roster.yml\n"
    );
    assert_eq!(out.stdout, "", "the login reply isn't printed");
    assert_eq!(calls(&s).len(), 1, "only the login ran");
    s.set_env("FAKE_CURL_LOGIN_STATUS", "200");
    s.set_env("FAKE_CURL_TOKEN_BODY", "{\"error\": \"nope\"}");
    let out = s.roster(&["web", "box-t", "GET", "/x"]);
    assert_eq!(out.code, 1);
    assert_eq!(
        out.stderr,
        "roster: box-t web: token login to /api/auth/login: no access_token in the reply\n"
    );
    s.set_env("FAKE_CURL_TOKEN_BODY", "<html>login</html>");
    let out = s.roster(&["web", "box-t", "GET", "/x"]);
    assert!(
        out.stderr.contains("the reply isn't JSON"),
        "{}",
        out.stderr
    );
    assert_eq!(calls(&s).len(), 3, "never the request");
}

#[test]
fn the_password_and_the_token_never_leak() {
    let mut s = token_sandbox("web-token-secrets", ", login: acme");
    // A server that echoes the password back in its reply.
    s.set_env(
        "FAKE_CURL_TOKEN_BODY",
        &format!("{{\"access_token\": \"{TOKEN}\", \"echo\": \"{PASSWORD}\"}}"),
    );
    s.set_env("FAKE_CURL_STATUS", "500");
    let out = s.roster(&["web", "box-t", "GET", "/x"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    s.set_env("FAKE_CURL_LOGIN_STATUS", "403");
    let refused = s.roster(&["web", "box-t", "GET", "/x"]);
    assert_eq!(refused.code, 1, "{}", refused.stderr);
    for out in [out, refused] {
        for secret in [PASSWORD, TOKEN] {
            assert!(!out.stdout.contains(secret) && !out.stderr.contains(secret));
        }
    }
    assert!(read(&s, "curl.login.stdin").contains(PASSWORD));
    assert!(read(&s, "curl.stdin").contains(TOKEN));
    // The scripted reply is the test's own variable, not roster's doing.
    let env = read(&s, "curl.env");
    let env: Vec<_> = env.lines().filter(|l| !l.starts_with("FAKE_")).collect();
    for secret in [PASSWORD, TOKEN] {
        assert!(!read(&s, "curl.log").contains(secret), "argv");
        assert!(
            !env.iter().any(|l| l.contains(secret)),
            "curl's environment"
        );
        for file in files(&s.home) {
            let own = ["curl.stdin", "curl.login.stdin", "curl.env"];
            if own.iter().any(|f| file.ends_with(f)) {
                continue;
            }
            let bytes = std::fs::read(&file).unwrap();
            let hit = bytes.windows(secret.len()).any(|w| w == secret.as_bytes());
            assert!(!hit, "a credential is in {}", file.display());
        }
    }
}
