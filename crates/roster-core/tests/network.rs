//! The `network` permission (decision Q97): `roster.http`, through the host the Tauri shell uses,
//! against a small HTTP server on 127.0.0.1 that each test lists explicitly
//! (`network:http://127.0.0.1:PORT`). Nothing here reaches the internet.

mod common;

use roster_core::plugin::{Limits, Permission, PluginHost, Reply, Serve, Source, read_manifest};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex, Once};
use std::time::Duration;

struct NoServe;

impl Serve for NoServe {
    fn call(&self, method: &str, _params: Value) -> Result<Value, String> {
        Err(format!("unknown method {method}"))
    }
}

/// A proxy in the environment that would fail every request, with credentials in it: the client
/// must use neither.
fn no_proxy_env() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // SAFETY: set once, before any test of this binary starts a request.
        unsafe {
            for k in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ] {
                std::env::set_var(k, "http://someone:secret@127.0.0.1:9");
            }
        }
    });
}

/// A tiny HTTP/1.1 server: what each request's head was, and answers by path.
struct Server {
    port: u16,
    heads: Arc<Mutex<Vec<String>>>,
}

fn serve_one(mut stream: TcpStream, heads: &Mutex<Vec<String>>) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte) {
            Ok(1) => head.push(byte[0]),
            _ => return,
        }
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    // Read the body the head announces: on Windows, closing a socket with unread data resets the
    // connection, and the client sees that (os error 10054) instead of the reply.
    let length = head
        .lines()
        .find_map(|l| {
            l.split_once(':')
                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        })
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if stream.read_exact(&mut body).is_err() {
        return;
    }
    heads.lock().unwrap().push(head.clone());
    let path = head.split(' ').nth(1).unwrap_or("/").to_string();
    let reply = |status: &str, extra: &str, body: &[u8]| {
        let mut out = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    };
    let out = match path.as_str() {
        "/hello" => reply(
            "200 OK",
            "Content-Type: text/plain\r\nSet-Cookie: session=abc\r\nX-Two: a\r\nX-Two: b\r\n",
            b"hi there",
        ),
        "/echo" => reply("200 OK", "", head.as_bytes()),
        "/missing" => reply("404 Not Found", "", b"nope"),
        "/redirect-in" => reply("302 Found", "Location: /hello\r\n", b""),
        "/redirect-out" => reply("302 Found", "Location: https://elsewhere.example/steal\r\n", b""),
        "/redirect-loopback" => reply("302 Found", "Location: http://127.0.0.2/hello\r\n", b""),
        "/redirect-loop" => reply("302 Found", "Location: /redirect-loop\r\n", b""),
        "/big" => reply("200 OK", "", &vec![b'x'; 2 * 1024 * 1024]),
        "/big-unsized" => {
            // No Content-Length: the cap must hold while reading.
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
            let chunk = vec![b'y'; 64 * 1024];
            for _ in 0..40 {
                if stream.write_all(&chunk).is_err() {
                    return;
                }
            }
            return;
        }
        p if p.starts_with("/to/") => reply(
            "302 Found",
            &format!("Location: http://127.0.0.1:{}/echo\r\n", &p[4..]),
            b"",
        ),
        p if p.starts_with("/tls/") => reply(
            "302 Found",
            &format!("Location: https://127.0.0.1:{}/hello\r\n", &p[5..]),
            b"",
        ),
        "/binary" => reply("200 OK", "", &[0, 159, 146, 150, 255]),
        "/slow" => {
            std::thread::sleep(Duration::from_secs(5));
            reply("200 OK", "", b"late")
        }
        _ => reply("404 Not Found", "", b""),
    };
    let _ = stream.write_all(&out);
}

impl Server {
    fn start() -> Server {
        no_proxy_env();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let heads = Arc::new(Mutex::new(Vec::new()));
        let h = Arc::clone(&heads);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let h = Arc::clone(&h);
                std::thread::spawn(move || serve_one(stream, &h));
            }
        });
        Server { port, heads }
    }

    fn site(&self) -> String {
        format!("network:http://127.0.0.1:{}", self.port)
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

fn plugin_dir(test: &str, permissions: &[&str], init: &str) -> common::Temp {
    let dir = common::temp(&format!("network-{test}"));
    let list: Vec<String> = permissions.iter().map(|p| format!("{p:?}")).collect();
    std::fs::write(
        dir.join("roster-plugin.lua"),
        format!(
            "return {{ name = \"fetcher\", version = \"1.0.0\", api = 2, permissions = {{ {} }} }}",
            list.join(", ")
        ),
    )
    .unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    dir
}

/// Loads a Plugin granted `permissions`, with `config` as `roster.plugin.config`; the replies
/// it sends on its own come out of the receiver.
fn load(
    test: &str,
    permissions: &[&str],
    config: Value,
    init: &str,
) -> (PluginHost, Reply, Receiver<Reply>, common::Temp) {
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    host.set_listener(Arc::new(move |r: Reply| {
        let _ = tx.lock().unwrap().send(r);
    }));
    let grants: Vec<Permission> = permissions.iter().map(|p| Permission::parse(p).unwrap()).collect();
    let folder = plugin_dir(test, permissions, init);
    let (_, reply) = host
        .load_with(&Source::Dir(folder.to_path_buf()), &grants, &config)
        .unwrap();
    (host, reply, rx, folder)
}

/// The notices in the replies that come within `secs`.
fn notices(rx: &Receiver<Reply>, want: usize, secs: u64) -> Vec<String> {
    let mut out = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    while out.len() < want {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        let Ok(r) = rx.recv_timeout(left) else { break };
        assert!(r.error.is_none(), "the callback failed: {:?}", r.error);
        for op in r.ops {
            if op["op"] == "notify" {
                out.push(op["text"].as_str().unwrap().to_string());
            }
        }
    }
    out
}

/// init.lua that fetches `config.url` (with `config.req`'s other keys) and says what came back.
const FETCH: &str = r#"
local c = roster.plugin.config
local req = c.req or {}
req.url = c.url
roster.http.request(req, function(res, err)
  if res then
    local names = {}
    for k in pairs(res.headers) do names[#names + 1] = k end
    table.sort(names)
    roster.notify(res.status .. " " .. #res.body .. " " .. res.body:sub(1, 300) .. " | " .. table.concat(names, ","))
  else
    roster.notify("failed: " .. err)
  end
end)
"#;

fn fetch(test: &str, server: &Server, path: &str, req: Value) -> String {
    let (_host, reply, rx, _folder) = load(
        test,
        &[&server.site()],
        json!({ "url": server.url(path), "req": req }),
        FETCH,
    );
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let got = notices(&rx, 1, 20);
    assert_eq!(got.len(), 1, "no answer for {path}");
    got[0].clone()
}

#[test]
fn without_a_network_grant_there_is_no_roster_http() {
    let server = Server::start();
    let init = "roster.notify(tostring(roster.http))";
    // Asked for but not granted: still nothing.
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    let dir = plugin_dir("ungranted", &[&server.site()], init);
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    assert_eq!(reply.ops[0]["text"], "nil");
    let (_, reply, _, _folder) = load("other-grant", &["inventory.read"], json!({}), init);
    assert_eq!(reply.ops[0]["text"], "nil");
    assert!(server.heads.lock().unwrap().is_empty());
}

#[test]
fn roster_has_answers_for_a_site_and_for_any_site() {
    let init = r#"
      for _, p in ipairs({ "network", "network:api.example.com", "network:other.example.com", "network:bad site" }) do
        roster.notify(p .. "=" .. tostring(roster.has(p)))
      end
    "#;
    let (_h, reply, _, _folder) = load("has", &["network:api.example.com"], json!({}), init);
    let texts: Vec<&str> = reply.ops.iter().map(|o| o["text"].as_str().unwrap()).collect();
    assert_eq!(
        texts,
        [
            "network=true",
            "network:api.example.com=true",
            "network:other.example.com=false",
            "network:bad site=false"
        ]
    );
    let (_h, reply, _, _folder) = load("has-none", &[], json!({}), init);
    assert_eq!(reply.ops[0]["text"], "network=false");
}

#[test]
fn a_bare_network_permission_names_no_site_and_doesnt_install() {
    let dir = plugin_dir("bare", &["network"], "");
    let e = read_manifest(&dir).unwrap_err();
    assert!(e.message.contains("network:api.example.com"), "{e}");
}

#[test]
fn a_granted_plugin_fetches_from_its_site_and_its_callback_reaches_the_app() {
    let server = Server::start();
    assert_eq!(
        fetch("hello", &server, "/hello", json!({})),
        "200 8 hi there | connection,content-length,content-type,set-cookie,x-two"
    );
    let echoed = fetch(
        "post",
        &server,
        "/echo",
        json!({ "method": "post", "body": "a=1", "headers": { "Authorization": "Bearer t0ken", "X-Mine": "yes" } }),
    );
    assert!(echoed.starts_with("200 "), "{echoed}");
    assert!(echoed.contains("POST /echo HTTP/1.1"), "{echoed}");
    assert!(echoed.contains("authorization: Bearer t0ken"), "{echoed}");
    assert!(echoed.contains("x-mine: yes"), "{echoed}");
    // A 404 is an answer, not a failure.
    assert!(fetch("missing", &server, "/missing", json!({})).starts_with("404 4 nope"));
}

#[test]
fn nothing_of_roster_goes_along() {
    let server = Server::start();
    // Twice: a cookie the first answer set isn't sent back.
    fetch("cookie1", &server, "/hello", json!({}));
    let echoed = fetch("cookie2", &server, "/echo", json!({}));
    let head = echoed.to_ascii_lowercase();
    for h in ["cookie:", "referer:", "proxy-authorization:", "authorization:"] {
        assert!(!head.contains(h), "{h} was sent: {echoed}");
    }
    // The proxy in the environment (port 9, with a password) wasn't used: the server saw them.
    assert_eq!(server.heads.lock().unwrap().len(), 2);
}

#[test]
fn an_answer_that_comes_while_init_lua_still_runs_isnt_lost() {
    let server = Server::start();
    let init = r#"
      roster.http.get(roster.plugin.config.url, function(res) roster.notify("got " .. res.status) end)
      local n = 0
      for i = 1, 20000000 do n = n + i end
    "#;
    let (_h, lr, rx, _folder) = load(
        "during-load",
        &[&server.site()],
        json!({ "url": server.url("/hello") }),
        init,
    );
    assert!(lr.error.is_none(), "{:?}", lr.error);
    assert_eq!(notices(&rx, 1, 20), ["got 200"]);
}

#[test]
fn a_binary_body_comes_back_as_its_bytes() {
    let server = Server::start();
    let init = r#"roster.http.get(roster.plugin.config.url, function(res)
      roster.notify(table.concat({ res.body:byte(1, -1) }, ","))
    end)"#;
    let (_h, lr, rx, _folder) = load(
        "binary",
        &[&server.site()],
        json!({ "url": server.url("/binary") }),
        init,
    );
    assert!(lr.error.is_none(), "{:?}", lr.error);
    assert_eq!(notices(&rx, 1, 20), ["0,159,146,150,255"]);
}

#[test]
fn a_site_it_wasnt_granted_is_refused_before_anything_is_sent() {
    let server = Server::start();
    let init = r#"
      local c = roster.plugin.config
      for _, url in ipairs(c.urls) do
        local ok, err = pcall(roster.http.get, url, function() end)
        roster.notify(ok and "sent" or err)
      end
    "#;
    let other = format!("http://127.0.0.1:{}/hello", server.port + 1);
    let urls = json!([
        format!("https://127.0.0.1:{}/hello", server.port),
        other,
        format!("http://localhost:{}/hello", server.port),
        "https://elsewhere.example/",
        format!("http://user:pw@127.0.0.1:{}/hello", server.port),
        "file:///etc/passwd",
        "not a url",
    ]);
    let (_h, reply, _, _folder) = load("refused", &[&server.site()], json!({ "urls": urls }), init);
    let texts: Vec<&str> = reply.ops.iter().map(|o| o["text"].as_str().unwrap()).collect();
    assert_eq!(texts.len(), 7);
    for t in &texts[..4] {
        assert!(t.contains("isn't a site this Plugin may reach"), "{t}");
    }
    assert!(texts[4].contains("user or password"), "{}", texts[4]);
    assert!(texts[5].contains("isn't a site"), "{}", texts[5]);
    assert!(texts[6].contains("isn't a URL"), "{}", texts[6]);
    assert!(server.heads.lock().unwrap().is_empty());
}

#[test]
fn headers_that_steer_the_connection_are_refused() {
    let server = Server::start();
    let init = r#"
      for _, h in ipairs({ "Host", "Proxy-Authorization", "Transfer-Encoding", "Content-Length", "Connection" }) do
        local ok, err = pcall(roster.http.request, { url = roster.plugin.config.url, headers = { [h] = "x" } }, function() end)
        roster.notify(ok and "sent" or err)
      end
      local ok, err = pcall(roster.http.request, { url = roster.plugin.config.url, headers = { ["X-Bad"] = "a\r\nInjected: 1" } }, function() end)
      roster.notify(ok and "sent" or err)
      ok, err = pcall(roster.http.request, { url = roster.plugin.config.url, method = "CONNECT" }, function() end)
      roster.notify(ok and "sent" or err)
      ok, err = pcall(roster.http.request, { url = roster.plugin.config.url, cookies = true }, function() end)
      roster.notify(ok and "sent" or err)
    "#;
    let (_h, reply, _, _folder) = load(
        "headers",
        &[&server.site()],
        json!({ "url": server.url("/hello") }),
        init,
    );
    let texts: Vec<&str> = reply.ops.iter().map(|o| o["text"].as_str().unwrap()).collect();
    for t in &texts[..5] {
        assert!(t.contains("header is roster's to set"), "{t}");
    }
    assert!(texts[5].contains("isn't one HTTP can carry"), "{}", texts[5]);
    assert!(texts[6].contains("isn't a method"), "{}", texts[6]);
    assert!(texts[7].contains("isn't a key of a request"), "{}", texts[7]);
    assert!(server.heads.lock().unwrap().is_empty());
}

#[test]
fn redirects_are_followed_only_to_its_sites() {
    let server = Server::start();
    assert!(fetch("redir-in", &server, "/redirect-in", json!({})).starts_with("200 8 hi there"));
    let out = fetch("redir-out", &server, "/redirect-out", json!({}));
    assert!(
        out.starts_with("failed: ") && out.contains("redirected to https://elsewhere.example"),
        "{out}"
    );
    let lo = fetch("redir-lo", &server, "/redirect-loopback", json!({}));
    assert!(lo.contains("redirected to http://127.0.0.2"), "{lo}");
    let looped = fetch("redir-loop", &server, "/redirect-loop", json!({}));
    assert!(looped.contains("more than 5 redirects"), "{looped}");
}

#[test]
fn a_token_isnt_carried_to_another_site_by_a_redirect() {
    let (a, b) = (Server::start(), Server::start());
    let (_h, _, rx, _folder) = load(
        "redir-token",
        &[&a.site(), &b.site()],
        json!({ "url": a.url(&format!("/to/{}", b.port)), "req": { "headers": { "Authorization": "Bearer t0ken" } } }),
        FETCH,
    );
    let got = notices(&rx, 1, 20);
    assert!(got[0].starts_with("200 ") && got[0].contains("GET /echo"), "{got:?}");
    assert!(!got[0].to_ascii_lowercase().contains("authorization"), "{got:?}");
    assert!(a.heads.lock().unwrap()[0].contains("authorization: Bearer t0ken"));
}

#[test]
fn a_response_over_the_cap_fails() {
    let server = Server::start();
    let big = fetch("big", &server, "/big", json!({}));
    assert!(big.contains("failed: the response is over 1048576 bytes"), "{big}");
    let unsized_ = fetch("big-unsized", &server, "/big-unsized", json!({}));
    assert!(
        unsized_.contains("failed: the response is over 1048576 bytes"),
        "{unsized_}"
    );
}

#[test]
fn a_slow_answer_times_out() {
    let server = Server::start();
    let started = std::time::Instant::now();
    let slow = fetch("slow", &server, "/slow", json!({ "timeout": 0.5 }));
    assert_eq!(slow, "failed: no answer within 0.5 s");
    assert!(started.elapsed() < Duration::from_secs(4));
}

#[test]
fn the_plugin_isnt_blocked_while_a_request_runs() {
    let server = Server::start();
    let init = r#"
      roster.http.get(roster.plugin.config.url, function(res, err) roster.notify("answered") end)
      roster.commands.add("ping", { run = function() roster.notify("pong") end })
    "#;
    let (host, reply, _, _folder) = load(
        "unblocked",
        &[&server.site()],
        json!({ "url": server.url("/slow") }),
        init,
    );
    let handler = reply.ops[0]["run"]["handler"].as_u64().unwrap();
    let started = std::time::Instant::now();
    let r = host.call("fetcher", handler, json!({}));
    assert_eq!(r.ops[0]["text"], "pong");
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn at_most_four_requests_go_at_once() {
    let server = Server::start();
    let init = r#"
      for i = 1, 5 do
        local ok, err = pcall(roster.http.get, roster.plugin.config.url, function() end)
        roster.notify(ok and "sent" or err)
      end
    "#;
    let (_h, reply, _, _folder) = load(
        "in-flight",
        &[&server.site()],
        json!({ "url": server.url("/slow") }),
        init,
    );
    let texts: Vec<&str> = reply.ops.iter().map(|o| o["text"].as_str().unwrap()).collect();
    assert_eq!(&texts[..4], ["sent"; 4]);
    assert!(texts[4].contains("4 requests are going already"), "{}", texts[4]);
}

#[test]
fn an_answer_for_a_plugin_that_was_unloaded_goes_nowhere() {
    let server = Server::start();
    let init = r#"roster.http.get(roster.plugin.config.url, function() roster.notify("late") end)"#;
    let (host, _, rx, _folder) = load(
        "unloaded",
        &[&server.site()],
        json!({ "url": server.url("/slow") }),
        init,
    );
    assert!(host.unload("fetcher"));
    assert!(rx.recv_timeout(Duration::from_secs(7)).is_err());
}

#[test]
fn an_error_in_the_callback_names_the_plugin_and_counts() {
    let server = Server::start();
    let init = r#"roster.http.get(roster.plugin.config.url, function() error("boom") end)"#;
    let (_h, _, rx, _folder) = load(
        "callback-error",
        &[&server.site()],
        json!({ "url": server.url("/hello") }),
        init,
    );
    let r = rx.recv_timeout(Duration::from_secs(20)).unwrap();
    let e = r.error.unwrap();
    assert_eq!(e.plugin, "fetcher");
    assert!(e.message.contains("boom"), "{}", e.message);
}

#[test]
fn the_install_prompt_shows_each_site_flagged() {
    let dir = plugin_dir(
        "prompt",
        &[
            "network:api.example.com",
            "network:http://10.0.0.5:8080",
            "network:*.example.org",
        ],
        "",
    );
    let m = read_manifest(&dir).unwrap();
    let v = serde_json::to_value(&m).unwrap();
    let ps = v["permissions"].as_array().unwrap();
    assert_eq!(ps[0]["name"], "network:api.example.com");
    assert!(
        ps[0]["risk"]
            .as_str()
            .unwrap()
            .contains("Can send data to api.example.com")
    );
    let plain = ps[1]["risk"].as_str().unwrap();
    assert!(
        plain.contains("Plain http") && plain.contains("private network"),
        "{plain}"
    );
    assert!(ps[2]["risk"].as_str().unwrap().contains("any site under example.org"));
    assert!(
        ps[2]["summary"]
            .as_str()
            .unwrap()
            .contains("any site under example.org")
    );
}

#[test]
fn nothing_listening_is_said_plainly() {
    no_proxy_env();
    let (_h, _, rx, _folder) = load(
        "refused-port",
        &["network:http://127.0.0.1:1"],
        json!({ "url": "http://127.0.0.1:1/x" }),
        FETCH,
    );
    let got = notices(&rx, 1, 20);
    assert!(
        got[0].starts_with("failed: couldn't connect to http://127.0.0.1:1: "),
        "{got:?}"
    );
}

/// Ticket 74 (decision Q92): `done` runs with a call's budget under the same global hook, so a
/// loop in it, inside a coroutine too, is stopped; and the `cmd:`/`env:` redaction is only for
/// roster serve's answers, never a web service's (`/echo`'s body has `auth: cmd:` text in it).
#[test]
fn a_done_callback_that_loops_in_a_coroutine_is_stopped_and_http_isnt_redacted() {
    let server = Server::start();
    let init = r#"
roster.http.request({ url = roster.plugin.config.url, headers = { auth = "cmd:pass show x" } }, function(res)
  roster.notify(tostring(res.body:find("cmd:pass show x", 1, true) ~= nil))
end)
roster.http.request({ url = roster.plugin.config.url }, function()
  coroutine.wrap(function() while true do end end)()
end)
"#;
    let (_host, reply, rx, _folder) = load("loop", &[&server.site()], json!({ "url": server.url("/echo") }), init);
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let mut seen_true = false;
    let mut seen_loop = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !(seen_true && seen_loop) {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        let Ok(r) = rx.recv_timeout(left) else { break };
        if let Some(e) = &r.error {
            assert!(e.to_string().contains("an endless loop?"), "{e}");
            seen_loop = true;
        }
        if r.ops.iter().any(|o| o["op"] == "notify" && o["text"] == "true") {
            seen_true = true;
        }
    }
    assert!(seen_true, "the echoed header wasn't there whole");
    assert!(seen_loop, "the looping callback wasn't stopped");
}

const PIN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn a_name_is_either_private_or_public_in_one_manifest() {
    let dir = plugin_dir(
        "both",
        &["network:nas.example.com", "network:private:http://nas.example.com:8080"],
        "",
    );
    let e = read_manifest(&dir).unwrap_err();
    assert!(
        e.message.contains("nas.example.com") && e.message.contains("private:"),
        "{e}"
    );
}

#[test]
fn one_site_has_one_pin_or_none() {
    let pinned = format!("network:10.0.0.5:8443#sha256:{PIN}");
    for other in [
        "network:10.0.0.5:8443".to_string(),
        format!("network:10.0.0.5:8443#sha256:{}", PIN.replace('0', "1")),
    ] {
        let dir = plugin_dir("pins", &[&pinned, &other], "");
        let e = read_manifest(&dir).unwrap_err();
        assert!(e.message.contains("10.0.0.5:8443"), "{e}");
    }
    // Another port is another site.
    let dir = plugin_dir("pins-ok", &[&pinned, "network:10.0.0.5"], "");
    assert!(read_manifest(&dir).is_ok());
}

/// A self-signed appliance over https on 127.0.0.1 (a made-up certificate for
/// `appliance.example`, made for these tests only, in tests/fixtures/tls). With `key`, it signs
/// the handshake with another key than its certificate's: someone showing a copied certificate.
fn tls_appliance(key: &str) -> u16 {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tls");
    let cert = CertificateDer::from(std::fs::read(fixtures.join("appliance.crt.der")).unwrap());
    let key = PrivateKeyDer::try_from(std::fs::read(fixtures.join(key)).unwrap()).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let signing = provider.key_provider.load_private_key(key).unwrap();
    #[derive(Debug)]
    struct One(Arc<rustls::sign::CertifiedKey>);
    impl rustls::server::ResolvesServerCert for One {
        fn resolve(&self, _: rustls::server::ClientHello<'_>) -> Option<Arc<rustls::sign::CertifiedKey>> {
            Some(Arc::clone(&self.0))
        }
    }
    let config = Arc::new(
        rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(One(Arc::new(rustls::sign::CertifiedKey::new(
                vec![cert],
                signing,
            ))))),
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let config = Arc::clone(&config);
            std::thread::spawn(move || {
                let conn = rustls::ServerConnection::new(config).unwrap();
                let mut tls = rustls::StreamOwned::new(conn, stream);
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    match tls.read(&mut byte) {
                        Ok(1) => head.push(byte[0]),
                        _ => return,
                    }
                }
                let _ = tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nhi there");
                let _ = tls.flush();
                tls.conn.send_close_notify();
                let _ = tls.flush();
            });
        }
    });
    port
}

fn fetch_from(test: &str, site: &str, url: &str) -> String {
    let (_host, reply, rx, _folder) = load(test, &[site], json!({ "url": url }), FETCH);
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let got = notices(&rx, 1, 20);
    assert_eq!(got.len(), 1, "no answer from {url}");
    got[0].clone()
}

fn appliance_pin() -> String {
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tls");
    roster_core::plugin::network::Pin::of(&std::fs::read(fixtures.join("appliance.crt.der")).unwrap()).to_string()
}

#[test]
fn a_pinned_site_trusts_its_one_certificate_in_place_of_the_os() {
    let port = tls_appliance("appliance.key.der");
    let url = format!("https://127.0.0.1:{port}/hello");
    let pinned = format!("network:127.0.0.1:{port}#sha256:{}", appliance_pin());
    assert!(fetch_from("pin-ok", &pinned, &url).starts_with("200 8 hi there"));
    // Without the pin, the OS's trust store decides, and a self-signed certificate fails.
    let plain = fetch_from("pin-none", &format!("network:127.0.0.1:{port}"), &url);
    assert!(plain.starts_with("failed: "), "{plain}");
    // Another pin: refused, and the error names what the site showed.
    let wrong = fetch_from("pin-wrong", &format!("network:127.0.0.1:{port}#sha256:{PIN}"), &url);
    assert!(
        wrong.starts_with("failed: ") && wrong.contains(&appliance_pin()[..16]),
        "{wrong}"
    );
}

#[test]
fn a_pinned_certificate_without_its_key_is_refused() {
    let port = tls_appliance("other.key.der");
    let url = format!("https://127.0.0.1:{port}/hello");
    let pinned = format!("network:127.0.0.1:{port}#sha256:{}", appliance_pin());
    let got = fetch_from("pin-stolen", &pinned, &url);
    assert!(got.starts_with("failed: ") && got.contains("ignature"), "{got}");
}

#[test]
fn a_redirect_never_leads_to_a_pinned_site() {
    let server = Server::start();
    let port = tls_appliance("appliance.key.der");
    let pinned = format!("network:127.0.0.1:{port}#sha256:{}", appliance_pin());
    let (_host, reply, rx, _folder) = load(
        "pin-redirect",
        &[&server.site(), &pinned],
        json!({ "url": server.url(&format!("/tls/{port}")) }),
        FETCH,
    );
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let got = notices(&rx, 1, 20);
    assert!(got[0].contains("pinned certificate"), "{got:?}");
}

/// A proxy on 127.0.0.1: what each request's first line was; a plain-http request gets "via
/// proxy", a CONNECT a 403.
fn proxy_server() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let lines = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&lines);
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let seen = Arc::clone(&seen);
            std::thread::spawn(move || {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    match stream.read(&mut byte) {
                        Ok(1) => head.push(byte[0]),
                        _ => return,
                    }
                }
                let head = String::from_utf8_lossy(&head).into_owned();
                seen.lock().unwrap().push(head.clone());
                let out: &[u8] = if head.starts_with("CONNECT ") {
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"
                } else {
                    b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nvia proxy"
                };
                let _ = stream.write_all(out);
            });
        }
    });
    (port, lines)
}

fn load_proxied(
    test: &str,
    proxy: &str,
    permissions: &[&str],
    url: &str,
) -> (Reply, Receiver<Reply>, PluginHost, common::Temp) {
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    let proxy = Some(roster_core::plugin::network::Proxy::parse(proxy).unwrap());
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    host.set_listener(Arc::new(move |r: Reply| {
        let _ = tx.lock().unwrap().send(r);
    }));
    let grants: Vec<Permission> = permissions.iter().map(|p| Permission::parse(p).unwrap()).collect();
    let folder = plugin_dir(test, permissions, FETCH);
    let (_, reply) = host
        .load_with_proxy(
            &Source::Dir(folder.to_path_buf()),
            &grants,
            &json!({ "url": url }),
            proxy,
        )
        .unwrap();
    (reply, rx, host, folder)
}

#[test]
fn a_public_site_goes_through_the_users_proxy_with_nothing_of_theirs_added() {
    let (port, lines) = proxy_server();
    // By name: the proxy's own name may lead anywhere the user's setting says.
    let proxy = format!("http://localhost:{port}");
    let (reply, rx, _h, _f) = load_proxied(
        "proxy-http",
        &proxy,
        &["network:http://api.example.com"],
        "http://api.example.com/hello?q=1",
    );
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(notices(&rx, 1, 20), ["200 9 via proxy | connection,content-length"]);
    let seen = lines.lock().unwrap().clone();
    assert!(
        seen[0].starts_with("GET http://api.example.com/hello?q=1 HTTP/1.1"),
        "{seen:?}"
    );
    assert!(
        !seen[0].to_ascii_lowercase().contains("proxy-authorization"),
        "{seen:?}"
    );
    // https is a tunnel: the proxy sees only where to.
    let (_r, rx, _h, _f) = load_proxied(
        "proxy-https",
        &proxy,
        &["network:api.example.com"],
        "https://api.example.com/hello",
    );
    let got = notices(&rx, 1, 20);
    assert!(got[0].starts_with("failed: "), "{got:?}");
    assert!(
        lines
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.starts_with("CONNECT api.example.com:443 "))
    );
}

#[test]
fn an_address_site_never_goes_through_the_proxy() {
    let server = Server::start();
    let (port, lines) = proxy_server();
    let (_r, rx, _h, _f) = load_proxied(
        "proxy-ip",
        &format!("http://127.0.0.1:{port}"),
        &[&server.site()],
        &server.url("/hello"),
    );
    assert!(notices(&rx, 1, 20)[0].starts_with("200 8 hi there"));
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn each_sites_requests_are_counted_with_nothing_of_what_they_carried() {
    let server = Server::start();
    let init = r#"
      local c = roster.plugin.config
      roster.http.get(c.base .. "/hello?token=s3cret", function(res) roster.notify("a " .. res.status) end)
      roster.http.get(c.base .. "/big", function(res, err) roster.notify("b " .. tostring(err ~= nil)) end)
    "#;
    let (host, reply, rx, _folder) = load(
        "counts",
        &[&server.site(), "network:api.example.com"],
        json!({ "base": server.url("") }),
        init,
    );
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(notices(&rx, 2, 20).len(), 2);
    let counts = host.requests_by_site("fetcher");
    let shown = serde_json::to_value(&counts).unwrap();
    assert_eq!(shown.as_array().unwrap().len(), 1, "{shown}");
    let row = &shown[0];
    assert_eq!(row["site"], format!("http://127.0.0.1:{}", server.port));
    assert_eq!(row["requests"], 2);
    assert_eq!(row["failed"], 1);
    assert!(row["last"].as_u64().unwrap() > 1_700_000_000_000, "{row}");
    assert!(
        !shown.to_string().contains("s3cret") && !shown.to_string().contains("hello"),
        "{shown}"
    );
    // In :plugins' list too.
    let listed = serde_json::to_value(host.list()).unwrap();
    assert_eq!(listed[0]["requests"][0]["requests"], 2);
    // Nothing for a Plugin that isn't there.
    assert!(host.requests_by_site("nobody").is_empty());
}

/// Loads a Plugin that fetches `url` each time the app locks, so a test can ask again later.
fn load_on_lock(test: &str, host: &PluginHost, permissions: &[&str], url: &str, proxy: Option<&str>) -> common::Temp {
    let init = r#"
      roster.on("lock", function()
        roster.http.get(roster.plugin.config.url, function(res, err)
          roster.notify(res and (res.status .. " " .. res.body) or ("failed: " .. err))
        end)
      end)
    "#;
    let grants: Vec<Permission> = permissions.iter().map(|p| Permission::parse(p).unwrap()).collect();
    let folder = plugin_dir(test, permissions, init);
    let proxy = proxy.map(|p| roster_core::plugin::network::Proxy::parse(p).unwrap());
    let (_, reply) = host
        .load_with_proxy(
            &Source::Dir(folder.to_path_buf()),
            &grants,
            &json!({ "url": url }),
            proxy,
        )
        .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    folder
}

fn listening() -> (PluginHost, Receiver<Reply>) {
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    host.set_listener(Arc::new(move |r: Reply| {
        let _ = tx.lock().unwrap().send(r);
    }));
    (host, rx)
}

fn lock(host: &PluginHost) {
    host.event(roster_core::plugin::Event {
        name: "lock".into(),
        payload: json!({}),
    });
}

#[test]
fn a_new_proxy_setting_reaches_a_plugin_that_runs_already() {
    let (one, one_saw) = proxy_server();
    let (two, two_saw) = proxy_server();
    let (host, rx) = listening();
    let url = "http://nothing.invalid/hello";
    let _f = load_on_lock(
        "proxy-change",
        &host,
        &["network:http://nothing.invalid"],
        url,
        Some(&format!("http://127.0.0.1:{one}")),
    );
    lock(&host);
    assert_eq!(notices(&rx, 1, 20), ["200 via proxy"]);
    host.set_proxy(Some(
        roster_core::plugin::network::Proxy::parse(&format!("http://127.0.0.1:{two}")).unwrap(),
    ));
    lock(&host);
    assert_eq!(notices(&rx, 1, 20), ["200 via proxy"]);
    assert_eq!((one_saw.lock().unwrap().len(), two_saw.lock().unwrap().len()), (1, 1));
    // Taken away: direct again, and a name that doesn't resolve fails here.
    host.set_proxy(None);
    lock(&host);
    let got = notices(&rx, 1, 20);
    assert!(
        got[0].starts_with("failed: ") && got[0].contains("couldn't look up nothing.invalid"),
        "{got:?}"
    );
    assert_eq!(two_saw.lock().unwrap().len(), 1);
}

#[test]
fn a_public_name_that_points_inside_isnt_reached_through_the_proxy() {
    use std::net::ToSocketAddrs;
    // A name this computer resolves to itself, where it does (systemd's resolver, most Linux).
    let inside = ("roster-test.localhost", 0)
        .to_socket_addrs()
        .map(|a| a.collect::<Vec<_>>())
        .unwrap_or_default();
    if inside.is_empty() {
        eprintln!("skipped: roster-test.localhost doesn't resolve here (the unit test covers the rule)");
        return;
    }
    let (port, lines) = proxy_server();
    let (host, rx) = listening();
    let _f = load_on_lock(
        "proxy-inside",
        &host,
        &["network:http://roster-test.localhost"],
        "http://roster-test.localhost/hello",
        Some(&format!("http://127.0.0.1:{port}")),
    );
    lock(&host);
    let got = notices(&rx, 1, 20);
    assert!(got[0].contains("roster-test.localhost is at"), "{got:?}");
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn removing_a_plugin_forgets_its_counts() {
    let server = Server::start();
    let (host, rx) = listening();
    let _f = load_on_lock("forget", &host, &[&server.site()], &server.url("/hello"), None);
    lock(&host);
    assert_eq!(notices(&rx, 1, 20).len(), 1);
    assert_eq!(host.requests_by_site("fetcher")[0].requests, 1);
    host.unload("fetcher");
    host.forget("fetcher").unwrap();
    assert!(host.requests_by_site("fetcher").is_empty());
}

#[test]
fn a_request_stopped_by_an_unload_counts_as_one_with_no_answer() {
    let server = Server::start();
    let (host, _rx) = listening();
    let _f = load_on_lock("aborted", &host, &[&server.site()], &server.url("/slow"), None);
    lock(&host);
    std::thread::sleep(Duration::from_millis(300));
    host.unload("fetcher");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while host.requests_by_site("fetcher").first().is_none_or(|c| c.failed == 0) && std::time::Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    let counts = host.requests_by_site("fetcher");
    assert_eq!((counts[0].requests, counts[0].failed), (1, 1));
}
