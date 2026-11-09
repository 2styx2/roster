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
         box-b: {ip: 10.0.0.6, web: \"https://10.0.0.6\", auth: env:API_PASS}\n",
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
