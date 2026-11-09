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

#[test]
fn a_failed_connection_shows_curls_error_and_exits_1() {
    let mut s = sandbox("web-down");
    s.set_env("FAKE_CURL_EXIT", "7");
    let out = s.roster(&["web", "box-a", "api", "GET", "/"]);
    assert_eq!(out.code, 1);
    assert_eq!(
        out.stderr,
        "curl: (7) Failed to connect to 10.0.0.5 port 8443\n\
         roster: box-a api: no HTTP response\n"
    );
}
