//! The `network` permission (decision Q97): `roster.http`, through the host the Tauri shell uses,
//! against a small HTTP server on 127.0.0.1 that each test lists explicitly
//! (`network:http://127.0.0.1:PORT`). Nothing here reaches the internet.

mod common;

use roster_core::plugin::{Limits, Load, Permission, PluginHost, Reply, Serve, Source};
use roster_core::rpc::CallError;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex, Once};
use std::time::Duration;

struct NoServe;

impl Serve for NoServe {
    fn call(&self, method: &str, _params: Value) -> Result<Value, CallError> {
        Err(CallError::Io {
            message: format!("unknown method {method}"),
        })
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

/// A tiny HTTP/1.1 server: what each request's head was, and answers by path. `/held` answers
/// only once the test lets it go ([`Server::release`]).
struct Server {
    port: u16,
    heads: Arc<Mutex<Vec<String>>>,
    gate: Arc<Gate>,
}

/// Shut until [`Gate::open`]; then open for good.
#[derive(Default)]
struct Gate {
    open: Mutex<bool>,
    opened: std::sync::Condvar,
}

impl Gate {
    fn open(&self) {
        *self.open.lock().unwrap() = true;
        self.opened.notify_all();
    }

    fn wait(&self) {
        let open = self.open.lock().unwrap();
        drop(self.opened.wait_while(open, |open| !*open).unwrap());
    }
}

fn serve_one(mut stream: TcpStream, heads: &Mutex<Vec<String>>, gate: &Gate) {
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
        "/found" => reply("302 Found", "Location: /echo\r\n", b""),
        "/see-other" => reply("303 See Other", "Location: /echo\r\n", b""),
        "/temporary" => reply("307 Temporary Redirect", "Location: /echo\r\n", b""),
        "/no-location" => reply("302 Found", "", b"stay"),
        "/to-https" => reply("302 Found", "Location: https://api.example.com/hello\r\n", b""),
        "/moved" => reply("301 Moved Permanently", "Location: /echo\r\n", b""),
        "/permanent" => reply("308 Permanent Redirect", "Location: /echo\r\n", b""),
        // Raw UTF-8 in the Location, as some servers send it.
        "/accented" => reply("302 Found", "Location: /h\u{e9}llo\r\n", b""),
        "/h%C3%A9llo" => reply("200 OK", "", b"accented"),
        "/to-file" => reply("302 Found", "Location: file:///etc/passwd\r\n", b""),
        "/to-data" => reply("302 Found", "Location: data:text/plain,hi\r\n", b""),
        "/protocol-relative-out" => reply("302 Found", "Location: //elsewhere.example/x\r\n", b""),
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
        p if p.starts_with("/creds/") => reply(
            "302 Found",
            &format!("Location: http://someone:secret@127.0.0.1:{}/echo\r\n", &p[7..]),
            b"",
        ),
        // /hop/PORT/REST: on to http://127.0.0.1:PORT/REST.
        p if p.starts_with("/hop/") => {
            let (port, rest) = p[5..].split_once('/').unwrap_or((&p[5..], ""));
            reply(
                "302 Found",
                &format!("Location: http://127.0.0.1:{port}/{rest}\r\n"),
                b"",
            )
        }
        p if p.starts_with("/protocol-relative/") => reply(
            "302 Found",
            &format!("Location: //127.0.0.1:{}/echo\r\n", &p[19..]),
            b"",
        ),
        p if p.starts_with("/tls/") => reply(
            "302 Found",
            &format!("Location: https://127.0.0.1:{}/hello\r\n", &p[5..]),
            b"",
        ),
        "/binary" => reply("200 OK", "", &[0, 159, 146, 150, 255]),
        "/held" => {
            gate.wait();
            reply("200 OK", "", b"let go")
        }
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
        let gate = Arc::new(Gate::default());
        let (h, g) = (Arc::clone(&heads), Arc::clone(&gate));
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (h, g) = (Arc::clone(&h), Arc::clone(&g));
                std::thread::spawn(move || serve_one(stream, &h, &g));
            }
        });
        Server { port, heads, gate }
    }

    /// The heads of the requests for `path`. A test asks about the requests it made, by what they
    /// carried: on a busy machine a port can be handed out again, so a client meant for another
    /// test's server (or another process's) can reach this one.
    fn asked(&self, path: &str) -> Vec<String> {
        self.heads
            .lock()
            .unwrap()
            .iter()
            .filter(|h| h.split(' ').nth(1) == Some(path))
            .cloned()
            .collect()
    }

    /// Returns once a request for `path` has come (its head is kept before it's answered).
    fn wait_for(&self, path: &str) {
        let deadline = std::time::Instant::now() + common::CEILING;
        while self.asked(path).is_empty() {
            assert!(std::time::Instant::now() < deadline, "no request for {path} came");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Lets `/held` answer.
    fn release(&self) {
        self.gate.open();
    }

    fn site(&self) -> String {
        format!("network:http://127.0.0.1:{}", self.port)
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.release();
    }
}

/// A port on 127.0.0.1 where nothing listens, held for as long as the socket is: it's bound but
/// never listening, so a connection to it is refused and the OS can't hand the port to another
/// test's server meanwhile (as it could a port bound and let go).
fn refused_port() -> (tokio::net::TcpSocket, u16) {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let port = socket.local_addr().unwrap().port();
    (socket, port)
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
/// it sends on its own come out of the receiver. Its host has generous limits
/// ([`common::unhurried`]): the default ones are wall-clock time, which a busy machine outruns,
/// and only the test about them (the looping callback) asks [`load_within`] for tight ones.
fn load(
    test: &str,
    permissions: &[&str],
    config: Value,
    init: &str,
) -> (PluginHost, Reply, Receiver<Reply>, common::Temp) {
    load_within(test, permissions, config, init, common::unhurried())
}

/// [`load`] with the host's `limits`.
fn load_within(
    test: &str,
    permissions: &[&str],
    config: Value,
    init: &str,
    limits: Limits,
) -> (PluginHost, Reply, Receiver<Reply>, common::Temp) {
    let host = PluginHost::new(Arc::new(NoServe), limits);
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    host.set_listener(Arc::new(move |r: Reply| {
        let _ = tx.lock().unwrap().send(r);
    }));
    let grants: Vec<Permission> = permissions.iter().map(|p| Permission::parse(p).unwrap()).collect();
    let folder = plugin_dir(test, permissions, init);
    let (_, reply) = host
        .load(
            &Source::Dir(folder.to_path_buf()),
            Load::new(&grants).config(config.clone()),
        )
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
    let host = PluginHost::new(Arc::new(NoServe), common::unhurried());
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
    let e = common::read_manifest(&dir).unwrap_err();
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
    assert_eq!((server.asked("/hello").len(), server.asked("/echo").len()), (1, 1));
}

#[test]
fn an_answer_that_comes_while_init_lua_still_runs_isnt_lost() {
    let server = Server::start();
    let init = r#"
      roster.http.get(roster.plugin.config.url, function(res) roster.notify("got " .. res.status) end)
      local n = 0
      for i = 1, 20000000 do n = n + i end
    "#;
    // The loop keeps init.lua running while the answer comes. How long it takes depends on the
    // machine, and the time limits aren't what this tests: on a busy machine the loop once ran
    // past the default 1 s a load (T146), and the answer's callback, which waits for it, past the
    // default call limit (T200). [`load`]'s limits are far beyond any machine's loop.
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
    let other = format!("http://127.0.0.1:{}/not-sent", server.port + 1);
    let urls = json!([
        format!("https://127.0.0.1:{}/not-sent", server.port),
        other,
        format!("http://localhost:{}/not-sent", server.port),
        "https://elsewhere.example/",
        format!("http://user:pw@127.0.0.1:{}/not-sent", server.port),
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
    assert!(server.asked("/not-sent").is_empty());
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
    assert!(server.asked("/hello").is_empty());
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

/// A redirect changes the method and drops the body as browsers do: a POST answered with 302 or
/// 303 goes on as a GET with no body; 307 (and 308) keep both. One with no `Location` is the answer.
#[test]
fn a_redirect_keeps_or_drops_the_method_and_body_as_http_says() {
    let server = Server::start();
    let post = json!({ "method": "POST", "body": "data", "headers": { "Content-Type": "text/plain" } });
    for (path, method, kept) in [
        ("/found", "GET", false),
        ("/see-other", "GET", false),
        ("/temporary", "POST", true),
        ("/moved", "GET", false),
        ("/permanent", "POST", true),
    ] {
        let out = fetch(&format!("redir-method{}", &path[1..]), &server, path, post.clone());
        assert!(
            out.starts_with("200 ") && out.contains(&format!("{method} /echo")),
            "{path}: {out}"
        );
        let lower = out.to_ascii_lowercase();
        assert_eq!(lower.contains("content-length: 4"), kept, "{path}: {out}");
        assert_eq!(lower.contains("content-type: text/plain"), kept, "{path}: {out}");
    }
    let stay = fetch("redir-none", &server, "/no-location", json!({}));
    assert!(stay.starts_with("302 4 stay"), "{stay}");
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
    assert!(a.asked(&format!("/to/{}", b.port))[0].contains("authorization: Bearer t0ken"));
}

#[test]
fn a_user_or_password_in_a_redirect_isnt_sent() {
    let server = Server::start();
    let out = fetch("redir-creds", &server, &format!("/creds/{}", server.port), json!({}));
    assert!(out.starts_with("200 ") && out.contains("GET /echo"), "{out}");
    assert!(!out.to_ascii_lowercase().contains("authorization"), "{out}");
}

/// On to another site, none of the Plugin's own headers goes along but a few that carry no
/// credential (`Accept`, `Accept-Language`, …), and one dropped stays dropped, back at the first
/// site too (decision Q148).
#[test]
fn a_redirect_to_another_site_takes_none_of_the_plugins_own_credentials_along() {
    let (a, b) = (Server::start(), Server::start());
    let headers = json!({
        "Authorization": "Bearer t0ken",
        "X-Api-Key": "k3y",
        "Private-Token": "pr1v",
        "X-Auth-Token": "au7h",
        "Accept": "application/json",
        "Accept-Language": "en",
    });
    let first = format!("/hop/{}/hop/{}/echo", b.port, a.port);
    let (_h, _, rx, _folder) = load(
        "redir-own-headers",
        &[&a.site(), &b.site()],
        json!({ "url": a.url(&first), "req": { "headers": headers } }),
        FETCH,
    );
    let got = notices(&rx, 1, 20);
    assert!(got[0].starts_with("200 ") && got[0].contains("GET /echo"), "{got:?}");
    let seen = [
        got[0].to_ascii_lowercase(),
        b.asked(&format!("/hop/{}/echo", a.port))[0].to_ascii_lowercase(),
    ];
    for head in &seen {
        for secret in ["t0ken", "k3y", "pr1v", "au7h"] {
            assert!(!head.contains(secret), "{secret} went along: {head}");
        }
        assert!(head.contains("accept: application/json"), "{head}");
        assert!(head.contains("accept-language: en"), "{head}");
    }
    // The first site got them all.
    assert!(a.asked(&first)[0].contains("x-api-key: k3y"));
}

#[test]
fn a_location_in_utf8_is_followed() {
    let server = Server::start();
    let out = fetch("redir-utf8", &server, "/accented", json!({}));
    assert!(out.starts_with("200 8 accented"), "{out}");
}

/// A redirect to anything but the Plugin's sites is refused, and the refusal never says "null"
/// for an address with no origin.
#[test]
fn a_redirect_to_a_file_data_or_protocol_relative_address_is_judged_as_any() {
    let server = Server::start();
    let file = fetch("redir-file", &server, "/to-file", json!({}));
    assert_eq!(
        file,
        "failed: redirected to a file: URL, which the Plugin may not reach"
    );
    let data = fetch("redir-data", &server, "/to-data", json!({}));
    assert_eq!(
        data,
        "failed: redirected to a data: URL, which the Plugin may not reach"
    );
    let out = fetch("redir-pr-out", &server, "/protocol-relative-out", json!({}));
    assert!(out.contains("redirected to http://elsewhere.example,"), "{out}");
    let inside = fetch(
        "redir-pr-in",
        &server,
        &format!("/protocol-relative/{}", server.port),
        json!({}),
    );
    assert!(inside.starts_with("200 ") && inside.contains("GET /echo"), "{inside}");
}

/// Each hop is counted by its own site: sent there, and failed there when that's where it failed.
#[test]
fn each_hop_is_counted_by_its_site() {
    let (a, b) = (Server::start(), Server::start());
    let init = r#"
      local c = roster.plugin.config
      roster.http.get(c.ok, function(res, err) roster.notify("ok " .. tostring(res ~= nil)) end)
      roster.http.get(c.big, function(res, err) roster.notify("big " .. tostring(err ~= nil)) end)
    "#;
    let (host, reply, rx, _folder) = load(
        "hop-counts",
        &[&a.site(), &b.site()],
        json!({
            "ok": a.url(&format!("/hop/{}/hello", b.port)),
            "big": a.url(&format!("/hop/{}/big", b.port)),
        }),
        init,
    );
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(notices(&rx, 2, 20).len(), 2);
    let counts = host.requests_by_site("fetcher");
    let row = |port: u16| {
        let c = counts
            .iter()
            .find(|c| c.site == format!("http://127.0.0.1:{port}"))
            .unwrap_or_else(|| panic!("no row for {port}: {counts:?}"));
        (c.requests, c.failed)
    };
    assert_eq!(row(a.port), (2, 0));
    assert_eq!(row(b.port), (2, 1));
}

/// A server that keeps open only the connection `/r` came on: `/r` redirects (with a body longer
/// than one read) to `/ok`, which answers `same` on that connection and `other` on any other,
/// closed after its answer. So the client's pool can hold no connection but the redirect's. A
/// connection is known by what it carried, not by its number: on a busy machine another test's
/// client can reach this port first, having been given it after the test let it go.
fn keep_alive_server() -> u16 {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let redirected_on = Arc::new(AtomicUsize::new(0));
    std::thread::spawn(move || {
        for (n, mut stream) in (1..).zip(listener.incoming().flatten()) {
            let redirected_on = Arc::clone(&redirected_on);
            std::thread::spawn(move || {
                loop {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        match stream.read(&mut byte) {
                            Ok(1) => head.push(byte[0]),
                            _ => return,
                        }
                    }
                    if head.starts_with(b"GET /r ") {
                        redirected_on.store(n, Ordering::SeqCst);
                    }
                    let same = redirected_on.load(Ordering::SeqCst) == n;
                    let close = if same { "" } else { "Connection: close\r\n" };
                    let out = if head.starts_with(b"GET /r ") {
                        // A page saying where it moved, longer than one read.
                        let page = "moved ".repeat(5000);
                        format!(
                            "HTTP/1.1 302 Found\r\nLocation: /ok\r\nContent-Length: {}\r\n\r\n{page}",
                            page.len()
                        )
                    } else {
                        let body = if same { "same" } else { "other" };
                        format!("HTTP/1.1 200 OK\r\n{close}Content-Length: {}\r\n\r\n{body}", body.len())
                    };
                    if stream.write_all(out.as_bytes()).is_err() || !same {
                        return;
                    }
                }
            });
        }
    });
    port
}

/// A redirect's own short body is read before the next hop, so its connection can be used
/// again. Whether the next hop does use it isn't the core's to say: hyper puts a connection back
/// in its pool from a task of its own once it's idle, and a request that finds the pool empty
/// opens another, so on a busy machine the hop after a redirect can come on a second connection
/// (T184: CI failed once counting connections). So the Plugin asks for `/ok` again until an
/// answer comes on the redirect's connection, which it can only once that was read to its end.
#[test]
fn a_redirect_on_the_same_site_reuses_its_connection() {
    let port = keep_alive_server();
    let init = r#"
      local c = roster.plugin.config
      local first
      local function answered(res, err)
        if not res then return roster.notify("failed: " .. err) end
        first = first or (res.status .. " " .. res.body)
        if res.body == "same" then
          roster.notify(first .. ", then the redirect's connection")
        else
          roster.http.get(c.again, answered)
        end
      end
      roster.http.get(c.url, answered)
    "#;
    let (_host, reply, rx, _folder) = load(
        "redir-reuse",
        &[&format!("network:http://127.0.0.1:{port}")],
        json!({
            "url": format!("http://127.0.0.1:{port}/r"),
            "again": format!("http://127.0.0.1:{port}/ok"),
        }),
        init,
    );
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let got = notices(&rx, 1, common::CEILING.as_secs());
    assert_eq!(got.len(), 1, "no request came on the redirect's connection");
    // Followed to /ok, on the redirect's connection (usually) or another one.
    assert!(
        got[0].starts_with("200 same") || got[0].starts_with("200 other"),
        "{}",
        got[0]
    );
    assert!(got[0].ends_with(", then the redirect's connection"), "{}", got[0]);
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

/// The server holds its answer until the test lets it go, which is after the Plugin's answer: so
/// that answer can only be the request's own timeout. How soon it comes is
/// [`a_slow_answer_times_out_soon`].
#[test]
fn a_slow_answer_times_out() {
    let server = Server::start();
    let slow = fetch("slow", &server, "/held", json!({ "timeout": 0.5 }));
    assert_eq!(slow, "failed: no answer within 0.5 s");
    assert_eq!(server.asked("/held").len(), 1, "the request was sent");
}

/// Times the machine as much as the timeout: `cargo test -p roster-core --test network --
/// --ignored` on an idle one (and perf.yml, weekly).
#[test]
#[ignore = "times the machine: run with --ignored on an idle one"]
fn a_slow_answer_times_out_soon() {
    let server = Server::start();
    let started = std::time::Instant::now();
    let slow = fetch("slow-soon", &server, "/held", json!({ "timeout": 0.5 }));
    assert_eq!(slow, "failed: no answer within 0.5 s");
    assert!(started.elapsed() < Duration::from_secs(4), "{:?}", started.elapsed());
}

const UNBLOCKED: &str = r#"
  roster.http.get(roster.plugin.config.url, function(res, err) roster.notify(res and res.body or err) end)
  roster.commands.add("ping", { run = function() roster.notify("pong") end })
"#;

/// A command answers while the Plugin's request is held at the server, so before the request's
/// answer, and the answer still comes once the server lets it go. How soon the command answers is
/// [`the_plugin_answers_soon_while_a_request_runs`].
#[test]
fn the_plugin_isnt_blocked_while_a_request_runs() {
    let server = Server::start();
    let (host, reply, rx, _folder) = load(
        "unblocked",
        &[&server.site()],
        json!({ "url": server.url("/held") }),
        UNBLOCKED,
    );
    server.wait_for("/held");
    let handler = reply.ops[0]["run"]["handler"].as_u64().unwrap();
    let host = Arc::new(host);
    let h = Arc::clone(&host);
    let r = common::within_ceiling("the command's answer while a request runs", move || {
        h.call("fetcher", handler, json!({}))
    });
    assert_eq!(r.ops[0]["text"], "pong");
    assert!(rx.try_recv().is_err(), "the request answered while the server held it");
    server.release();
    assert_eq!(notices(&rx, 1, 60), ["let go"]);
}

/// Times the machine as much as the host: `cargo test -p roster-core --test network --
/// --ignored` on an idle one (and perf.yml, weekly).
#[test]
#[ignore = "times the machine: run with --ignored on an idle one"]
fn the_plugin_answers_soon_while_a_request_runs() {
    let server = Server::start();
    let (host, reply, _, _folder) = load(
        "unblocked-soon",
        &[&server.site()],
        json!({ "url": server.url("/held") }),
        UNBLOCKED,
    );
    server.wait_for("/held");
    let handler = reply.ops[0]["run"]["handler"].as_u64().unwrap();
    let started = std::time::Instant::now();
    let r = host.call("fetcher", handler, json!({}));
    assert_eq!(r.ops[0]["text"], "pong");
    assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
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
    let m = common::read_manifest(&dir).unwrap();
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
    // The call limit is what stops the loop: the default one, not [`load`]'s minute. The load
    // isn't what this tests, so it gets a minute.
    let limits = Limits {
        call: Limits::default().call,
        ..common::unhurried()
    };
    let (_host, reply, rx, _folder) = load_within(
        "loop",
        &[&server.site()],
        json!({ "url": server.url("/echo") }),
        init,
        limits,
    );
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
    let e = common::read_manifest(&dir).unwrap_err();
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
        let e = common::read_manifest(&dir).unwrap_err();
        assert!(e.message.contains("10.0.0.5:8443"), "{e}");
    }
    // Another port is another site.
    let dir = plugin_dir("pins-ok", &[&pinned, "network:10.0.0.5"], "");
    assert!(common::read_manifest(&dir).is_ok());
}

/// Every server name (SNI) a client asked [`tls_appliance`] for, in order.
static SNI: Mutex<Vec<String>> = Mutex::new(Vec::new());

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
        fn resolve(&self, hello: rustls::server::ClientHello<'_>) -> Option<Arc<rustls::sign::CertifiedKey>> {
            if let Some(name) = hello.server_name() {
                SNI.lock().unwrap().push(name.to_string());
            }
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
                // /self: on to its own /hello; /away/PORT: on to http://127.0.0.1:PORT/hello.
                let path = String::from_utf8_lossy(&head)
                    .split(' ')
                    .nth(1)
                    .unwrap_or("/")
                    .to_string();
                let out = if path == "/self" {
                    "HTTP/1.1 302 Found\r\nLocation: /hello\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_string()
                } else if let Some(port) = path.strip_prefix("/away/") {
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/hello\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nhi there".to_string()
                };
                let _ = tls.write_all(out.as_bytes());
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

/// A pinned site may redirect to itself, and to nowhere else.
#[test]
fn a_pinned_site_is_redirected_only_to_itself() {
    let server = Server::start();
    let port = tls_appliance("appliance.key.der");
    let pinned = format!("network:127.0.0.1:{port}#sha256:{}", appliance_pin());
    let (_h, reply, rx, _f) = load(
        "pin-self",
        &[&pinned, &server.site()],
        json!({ "url": format!("https://127.0.0.1:{port}/self") }),
        FETCH,
    );
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert!(notices(&rx, 1, 20)[0].starts_with("200 8 hi there"));
    let (_h, _, rx, _f) = load(
        "pin-away",
        &[&pinned, &server.site()],
        json!({ "url": format!("https://127.0.0.1:{port}/away/{}", server.port) }),
        FETCH,
    );
    let got = notices(&rx, 1, 20);
    assert!(got[0].contains("pinned certificate"), "{got:?}");
    assert!(server.asked("/hello").is_empty());
}

/// This computer's resolver in the proxy tests: `api.example.com` and `appliance.example` are at
/// 45.10.20.30, a public address (nothing listens there: only the proxy below knows where it
/// leads); `two.example` at 45.10.20.40 and 45.10.20.30; `v6.example` at 2a00::5;
/// `mapped.example` at ::ffff:45.10.20.31; `inside.example` at 10.0.0.5; any other name can't be
/// looked up.
fn lookup() -> roster_core::plugin::network::Lookup {
    Arc::new(|host: &str| {
        let at = |ip: &str| Ok(vec![std::net::SocketAddr::new(ip.parse().unwrap(), 0)]);
        match host {
            // nothing.invalid: no real resolver ever answers it, so without the proxy it fails here.
            "api.example.com" | "appliance.example" | "nothing.invalid" => at("45.10.20.30"),
            "inside.example" => at("10.0.0.5"),
            "two.example" => Ok(vec![
                std::net::SocketAddr::new("45.10.20.40".parse().unwrap(), 0),
                std::net::SocketAddr::new("45.10.20.30".parse().unwrap(), 0),
            ]),
            "v6.example" => at("2a00::5"),
            "mapped.example" => at("::ffff:45.10.20.31"),
            _ => Err("no such name".into()),
        }
    })
}

/// A server roster must never reach: whatever it's sent, it answers `inside`.
fn inside_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\ninside");
            });
        }
    });
    port
}

/// A proxy on 127.0.0.1 that resolves names its own way, as a proxy may: asked for a name (`CONNECT
/// NAME:PORT`, or `GET http://NAME/…`), it leads to `inside`, a server roster must never reach;
/// asked for an address (`CONNECT IP:PORT`), it opens a tunnel to the port on 127.0.0.1 that
/// `routes` gives that address (an address it has no route for gets a 502). It keeps the head of
/// everything it was sent (not what goes through a tunnel).
struct ResolvingProxy {
    port: u16,
    heads: Arc<Mutex<Vec<String>>>,
}

impl ResolvingProxy {
    fn start(inside: u16, routes: &[(&str, u16)]) -> ResolvingProxy {
        ResolvingProxy::answering(inside, routes, None)
    }

    /// A proxy that answers every CONNECT with `say` instead (a 403, something that isn't HTTP,
    /// nothing at all), then holds the connection until roster closes it.
    fn saying(say: &[u8]) -> ResolvingProxy {
        ResolvingProxy::answering(inside_server(), &[], Some(say.to_vec()))
    }

    fn answering(inside: u16, routes: &[(&str, u16)], say: Option<Vec<u8>>) -> ResolvingProxy {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let heads = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&heads);
        let routes: Vec<(String, u16)> = routes.iter().map(|(a, p)| (a.to_string(), *p)).collect();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let (seen, routes, say) = (Arc::clone(&seen), routes.clone(), say.clone());
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
                    let Some(target) = head.strip_prefix("CONNECT ").and_then(|t| t.split(' ').next()) else {
                        // Absolute form: the proxy looks the name up itself.
                        let mut up = TcpStream::connect(("127.0.0.1", inside)).unwrap();
                        let _ = up.write_all(head.as_bytes());
                        let _ = std::io::copy(&mut up, &mut stream);
                        return;
                    };
                    if let Some(say) = say {
                        let _ = stream.write_all(&say);
                        let _ = std::io::copy(&mut stream, &mut std::io::sink());
                        return;
                    }
                    let to = match target.parse::<std::net::SocketAddr>() {
                        Ok(_) => match routes.iter().find(|(a, _)| a == target) {
                            Some((_, p)) => *p,
                            None => {
                                let _ = stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
                                return;
                            }
                        },
                        // A name: wherever this proxy's own DNS says.
                        Err(_) => inside,
                    };
                    let Ok(mut up) = TcpStream::connect(("127.0.0.1", to)) else {
                        return;
                    };
                    let _ = stream.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n");
                    let (mut down, mut back) = (stream.try_clone().unwrap(), up.try_clone().unwrap());
                    std::thread::spawn(move || {
                        let _ = std::io::copy(&mut down, &mut up);
                        let _ = up.shutdown(std::net::Shutdown::Write);
                    });
                    let _ = std::io::copy(&mut back, &mut stream);
                    let _ = stream.shutdown(std::net::Shutdown::Write);
                });
            }
        });
        ResolvingProxy { port, heads }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn heads(&self) -> Vec<String> {
        self.heads.lock().unwrap().clone()
    }
}

/// A host whose Plugins look names up with [`lookup`], with generous limits as [`load`]'s.
fn host() -> PluginHost {
    PluginHost::new(Arc::new(NoServe), common::unhurried()).with_lookup(lookup())
}

fn load_proxied(
    test: &str,
    proxy: &str,
    permissions: &[&str],
    url: &str,
) -> (Reply, Receiver<Reply>, PluginHost, common::Temp) {
    load_proxied_with(test, proxy, permissions, url, json!({}))
}

/// [`load_proxied`] with `req`'s keys in the request ([`FETCH`]).
fn load_proxied_with(
    test: &str,
    proxy: &str,
    permissions: &[&str],
    url: &str,
    req: Value,
) -> (Reply, Receiver<Reply>, PluginHost, common::Temp) {
    let host = host();
    let proxy = Some(roster_core::plugin::network::Proxy::parse(proxy).unwrap());
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    host.set_listener(Arc::new(move |r: Reply| {
        let _ = tx.lock().unwrap().send(r);
    }));
    let grants: Vec<Permission> = permissions.iter().map(|p| Permission::parse(p).unwrap()).collect();
    let folder = plugin_dir(test, permissions, FETCH);
    let (_, reply) = host
        .load(
            &Source::Dir(folder.to_path_buf()),
            Load::new(&grants)
                .config(json!({ "url": url, "req": req }))
                .proxy(proxy),
        )
        .unwrap();
    (reply, rx, host, folder)
}

/// #225 item 5: the proxy may resolve a name to another address than roster checked. roster asks
/// it for a tunnel to the address it checked, never the name, and speaks HTTP through the tunnel
/// itself with the name only in `Host`, so the request reaches that address and nothing else.
#[test]
fn through_the_proxy_a_request_reaches_only_the_address_roster_checked() {
    let server = Server::start();
    let proxy = ResolvingProxy::start(inside_server(), &[("45.10.20.30:80", server.port)]);
    let (reply, rx, _h, _f) = load_proxied(
        "connect-http",
        &proxy.url(),
        &["network:http://api.example.com"],
        "http://api.example.com/echo",
    );
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let got = notices(&rx, 1, 20);
    assert!(got[0].starts_with("200 "), "{got:?}");
    let echoed = got[0].to_ascii_lowercase();
    assert!(echoed.contains("get /echo http/1.1"), "{got:?}");
    assert!(echoed.contains("host: api.example.com\r\n"), "{got:?}");
    assert!(!echoed.contains("inside"), "{got:?}");
    let heads = proxy.heads();
    assert_eq!(heads.len(), 1, "{heads:?}");
    assert!(heads[0].starts_with("CONNECT 45.10.20.30:80 HTTP/1.1\r\n"), "{heads:?}");
    assert!(!heads[0].contains("api.example.com"), "{heads:?}");
    assert!(
        !heads[0].to_ascii_lowercase().contains("proxy-authorization"),
        "{heads:?}"
    );
}

/// https the same way: the tunnel goes to the address checked, and TLS asks for the name (SNI) and
/// checks the certificate against the name, never the address.
#[test]
fn through_the_proxy_https_goes_to_the_address_checked_with_the_name_as_sni() {
    let appliance = tls_appliance("appliance.key.der");
    let proxy = ResolvingProxy::start(inside_server(), &[("45.10.20.30:443", appliance)]);
    let site = format!("network:appliance.example#sha256:{}", appliance_pin());
    let (reply, rx, _h, _f) = load_proxied(
        "connect-https",
        &proxy.url(),
        &[&site],
        "https://appliance.example/hello",
    );
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(notices(&rx, 1, 20), ["200 8 hi there | connection,content-length"]);
    let heads = proxy.heads();
    assert_eq!(heads.len(), 1, "{heads:?}");
    assert!(
        heads[0].starts_with("CONNECT 45.10.20.30:443 HTTP/1.1\r\n"),
        "{heads:?}"
    );
    assert!(SNI.lock().unwrap().iter().any(|n| n == "appliance.example"));
}

/// Through the tunnel, a request is what it is without the proxy: its body and headers go, the
/// 1 MB cap holds while reading, and its timeout ends it.
#[test]
fn through_the_tunnel_the_body_the_cap_and_the_timeout_hold() {
    let server = Server::start();
    let proxy = ResolvingProxy::start(inside_server(), &[("45.10.20.30:80", server.port)]);
    let site = "network:http://api.example.com";
    let post = json!({ "method": "POST", "body": "hello", "headers": { "X-Api-Key": "k3y" } });
    let (_r, rx, _h, _f) = load_proxied_with(
        "tunnel-post",
        &proxy.url(),
        &[site],
        "http://api.example.com/echo",
        post,
    );
    let got = notices(&rx, 1, 20)[0].to_ascii_lowercase();
    assert!(got.starts_with("200 ") && got.contains("post /echo http/1.1"), "{got}");
    assert!(
        got.contains("content-length: 5\r\n") && got.contains("x-api-key: k3y\r\n"),
        "{got}"
    );
    assert!(got.contains("user-agent: roster/"), "{got}");
    for (test, path, req, want) in [
        ("tunnel-big", "/big", json!({}), "failed: the response is over"),
        (
            "tunnel-unsized",
            "/big-unsized",
            json!({}),
            "failed: the response is over",
        ),
        (
            "tunnel-slow",
            "/slow",
            json!({ "timeout": 0.5 }),
            "failed: no answer within 0.5 s",
        ),
    ] {
        let url = format!("http://api.example.com{path}");
        let (_r, rx, _h, _f) = load_proxied_with(test, &proxy.url(), &[site], &url, req);
        let got = notices(&rx, 1, 20);
        assert!(got[0].starts_with(want), "{path}: {got:?}");
    }
}

/// A proxy that won't open a tunnel to an address (some allow only names, or only port 443) fails
/// the request: roster never falls back to handing it the name.
#[test]
fn a_proxy_that_wont_tunnel_to_the_address_fails_the_request_closed() {
    let proxy = ResolvingProxy::saying(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    for (test, site, url) in [
        (
            "refused-http",
            "network:http://api.example.com",
            "http://api.example.com/hello",
        ),
        (
            "refused-https",
            "network:api.example.com",
            "https://api.example.com/hello",
        ),
    ] {
        let (_r, rx, _h, _f) = load_proxied(test, &proxy.url(), &[site], url);
        let got = notices(&rx, 1, 20);
        assert!(
            got[0].starts_with("failed: your plugin_proxy wouldn't open a tunnel to 45.10.20.30:")
                && got[0].contains("403"),
            "{got:?}"
        );
        // The Plugin never learns where the user's proxy is (Q116: it can't set or see it).
        assert!(!got[0].contains(&proxy.port.to_string()), "{got:?}");
    }
    let heads = proxy.heads();
    assert_eq!(heads.len(), 2, "{heads:?}");
    assert!(heads.iter().all(|h| h.starts_with("CONNECT 45.10.20.30:")), "{heads:?}");
}

/// The answer a Plugin gets for a request through a proxy that answers the CONNECT with `say`.
fn through_a_proxy_saying(test: &str, say: &[u8], url: &str) -> (String, ResolvingProxy) {
    let proxy = ResolvingProxy::saying(say);
    let site = if url.starts_with("http:") {
        "network:http://api.example.com"
    } else {
        "network:api.example.com"
    };
    let (_r, rx, _h, _f) = load_proxied(test, &proxy.url(), &[site], url);
    let got = notices(&rx, 1, 30);
    assert_eq!(got.len(), 1, "no answer for {test}");
    (got[0].clone(), proxy)
}

/// Whatever else a proxy answers the CONNECT with fails the request, and never names the proxy.
#[test]
fn a_proxy_that_answers_the_connect_wrongly_fails_the_request() {
    let mut long = b"HTTP/1.1 200 OK\r\nX-Padding: ".to_vec();
    long.extend(std::iter::repeat_n(b'a', 9000));
    for (test, say, want) in [
        (
            "not-http",
            &b"SSH-2.0-OpenSSH_9.6\r\n\r\n"[..],
            "its answer wasn't HTTP",
        ),
        ("too-long", &long[..], "its answer wasn't HTTP"),
    ] {
        let (got, proxy) = through_a_proxy_saying(test, say, "http://api.example.com/hello");
        assert!(
            got.starts_with("failed: your plugin_proxy wouldn't open a tunnel to 45.10.20.30:80") && got.contains(want),
            "{test}: {got}"
        );
        assert!(!got.contains(&proxy.port.to_string()), "{got}");
    }
}

/// A proxy that says nothing after the CONNECT is given up on after 10 s, the time to connect.
#[test]
fn a_proxy_that_never_answers_the_connect_is_given_up_on() {
    let started = std::time::Instant::now();
    let (got, _proxy) = through_a_proxy_saying("silent", b"", "http://api.example.com/hello");
    assert!(
        got.starts_with("failed: your plugin_proxy wouldn't open a tunnel to 45.10.20.30:80")
            && got.contains("no answer within 10 s"),
        "{got}"
    );
    assert!(started.elapsed() < Duration::from_secs(20));
}

/// Bytes a proxy sends after its 200 aren't the site's: over https they fail TLS, so a proxy can't
/// answer for a site that way.
#[test]
fn bytes_a_proxy_sends_after_its_200_dont_pass_for_the_site() {
    let (got, _proxy) = through_a_proxy_saying(
        "after-200",
        b"HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nforged",
        "https://api.example.com/hello",
    );
    assert!(
        got.starts_with("failed: couldn't connect to https://api.example.com"),
        "{got}"
    );
    assert!(!got.contains("forged"), "{got}");
}

/// [`refused_port`]'s port stays refused while it's held: the OS can't give it to a server, as it
/// could a port bound and let go.
#[test]
fn a_refused_port_is_held_while_the_test_runs() {
    let (_held, port) = refused_port();
    assert!(
        TcpListener::bind(("127.0.0.1", port)).is_err(),
        "port {port} was handed out again"
    );
    assert_eq!(
        TcpStream::connect(("127.0.0.1", port)).unwrap_err().kind(),
        std::io::ErrorKind::ConnectionRefused
    );
}

/// A proxy that can't be reached is said plainly, without its address.
#[test]
fn a_proxy_that_cant_be_reached_isnt_named_to_the_plugin() {
    let (_held, port) = refused_port();
    let (_r, rx, _h, _f) = load_proxied(
        "unreachable",
        &format!("http://127.0.0.1:{port}"),
        &["network:http://api.example.com"],
        "http://api.example.com/hello",
    );
    let got = notices(&rx, 1, 20);
    assert!(
        got[0].starts_with("failed: couldn't connect to your plugin_proxy: "),
        "{got:?}"
    );
    assert!(!got[0].contains(&port.to_string()), "{got:?}");
}

/// Through the tunnel the certificate is checked as without a proxy: a self-signed one without a
/// pin, another pin, or the pinned certificate shown with another key, each fails.
#[test]
fn a_bad_certificate_through_the_tunnel_fails() {
    let pin = appliance_pin();
    for (test, key, site, want) in [
        (
            "tunnel-unpinned",
            "appliance.key.der",
            "network:appliance.example".to_string(),
            "certificate",
        ),
        (
            "tunnel-wrong-pin",
            "appliance.key.der",
            format!("network:appliance.example#sha256:{PIN}"),
            "isn't the one pinned",
        ),
        (
            "tunnel-wrong-key",
            "other.key.der",
            format!("network:appliance.example#sha256:{pin}"),
            "ignature",
        ),
    ] {
        let appliance = tls_appliance(key);
        let proxy = ResolvingProxy::start(inside_server(), &[("45.10.20.30:443", appliance)]);
        let (_r, rx, _h, _f) = load_proxied(test, &proxy.url(), &[&site], "https://appliance.example/hello");
        let got = notices(&rx, 1, 20);
        assert!(
            got[0].starts_with("failed: couldn't connect to https://appliance.example") && got[0].contains(want),
            "{test}: {got:?}"
        );
        assert!(proxy.heads()[0].starts_with("CONNECT 45.10.20.30:443 "), "{test}");
    }
}

/// HEAD (and any answer with no body) through the tunnel is judged by the body that comes, not
/// by the size its Content-Length announces.
#[test]
fn a_head_through_the_tunnel_isnt_judged_by_its_content_length() {
    let server = Server::start();
    let proxy = ResolvingProxy::start(inside_server(), &[("45.10.20.30:80", server.port)]);
    let (_r, rx, _h, _f) = load_proxied_with(
        "tunnel-head",
        &proxy.url(),
        &["network:http://api.example.com"],
        "http://api.example.com/big",
        json!({ "method": "HEAD" }),
    );
    let got = notices(&rx, 1, 20);
    assert!(got[0].starts_with("200 0 "), "{got:?}");
}

/// With several addresses, each is tried in turn until the proxy opens a tunnel to one; an IPv6
/// one is written in brackets, and an IPv4 one the resolver gave as IPv6 is written as IPv4.
#[test]
fn every_address_is_tried_and_written_as_a_proxy_reads_it() {
    let server = Server::start();
    let proxy = ResolvingProxy::start(
        inside_server(),
        &[
            ("45.10.20.30:80", server.port),
            ("[2a00::5]:80", server.port),
            ("45.10.20.31:80", server.port),
        ],
    );
    for (test, name) in [
        ("two", "two.example"),
        ("v6", "v6.example"),
        ("mapped", "mapped.example"),
    ] {
        let (_r, rx, _h, _f) = load_proxied(
            test,
            &proxy.url(),
            &[&format!("network:http://{name}")],
            &format!("http://{name}/hello"),
        );
        assert_eq!(
            notices(&rx, 1, 20),
            ["200 8 hi there | connection,content-length,content-type,set-cookie,x-two"],
            "{test}"
        );
    }
    let firsts: Vec<String> = proxy
        .heads()
        .iter()
        .map(|h| h.lines().next().unwrap().to_string())
        .collect();
    assert_eq!(
        firsts,
        [
            "CONNECT 45.10.20.40:80 HTTP/1.1",
            "CONNECT 45.10.20.30:80 HTTP/1.1",
            "CONNECT [2a00::5]:80 HTTP/1.1",
            "CONNECT 45.10.20.31:80 HTTP/1.1",
        ]
    );
}

/// A redirect from http to https through the proxy is a new tunnel, to port 443 of the address
/// checked, with TLS for the name; a redirect to a site that's an address goes direct.
#[test]
fn a_redirect_through_the_proxy_takes_a_tunnel_of_its_own_or_goes_direct() {
    let server = Server::start();
    let appliance = tls_appliance("appliance.key.der");
    let proxy = ResolvingProxy::start(
        inside_server(),
        &[("45.10.20.30:80", server.port), ("45.10.20.30:443", appliance)],
    );
    let sites = ["network:http://api.example.com", "network:api.example.com"];
    let (_r, rx, _h, _f) = load_proxied("to-https", &proxy.url(), &sites, "http://api.example.com/to-https");
    let got = notices(&rx, 1, 20);
    // The appliance's certificate is for another name and no OS trusts it: the TLS check ran.
    assert!(
        got[0].starts_with("failed: couldn't connect to https://api.example.com"),
        "{got:?}"
    );
    assert!(SNI.lock().unwrap().iter().any(|n| n == "api.example.com"));
    let firsts: Vec<String> = proxy
        .heads()
        .iter()
        .map(|h| h.lines().next().unwrap().to_string())
        .collect();
    assert_eq!(
        firsts,
        ["CONNECT 45.10.20.30:80 HTTP/1.1", "CONNECT 45.10.20.30:443 HTTP/1.1"]
    );

    let sites = ["network:http://api.example.com", &server.site()];
    let url = format!("http://api.example.com/hop/{}/hello", server.port);
    let (_r, rx, _h, _f) = load_proxied("to-address", &proxy.url(), &sites, &url);
    assert!(notices(&rx, 1, 20)[0].starts_with("200 8 hi there"));
    assert_eq!(proxy.heads().len(), 3, "the address was reached through the proxy");
}

/// Through the tunnel, `Accept: */*` goes unless the Plugin says otherwise, as without a proxy.
#[test]
fn through_the_tunnel_accept_is_any_unless_the_plugin_says() {
    let server = Server::start();
    let proxy = ResolvingProxy::start(inside_server(), &[("45.10.20.30:80", server.port)]);
    for (test, req, want) in [
        ("accept-default", json!({}), "accept: */*\r\n"),
        (
            "accept-own",
            json!({ "headers": { "Accept": "application/json" } }),
            "accept: application/json\r\n",
        ),
    ] {
        let (_r, rx, _h, _f) = load_proxied_with(
            test,
            &proxy.url(),
            &["network:http://api.example.com"],
            "http://api.example.com/echo",
            req,
        );
        let got = notices(&rx, 1, 20)[0].to_ascii_lowercase();
        assert!(got.contains(want), "{test}: {got}");
        assert_eq!(got.matches("accept:").count(), 1, "{test}: {got}");
    }
}

/// A name this computer can't look up has no address roster checked, so nothing goes to the proxy
/// for it; and a name this computer finds inside is refused as without a proxy.
#[test]
fn a_name_roster_cant_check_never_reaches_the_proxy() {
    let proxy = ResolvingProxy::start(inside_server(), &[]);
    let (_r, rx, _h, _f) = load_proxied(
        "unknown",
        &proxy.url(),
        &["network:http://unknown.example"],
        "http://unknown.example/hello",
    );
    let got = notices(&rx, 1, 20);
    assert!(
        got[0].starts_with("failed: couldn't look up unknown.example on this computer"),
        "{got:?}"
    );
    let (_r, rx, _h, _f) = load_proxied(
        "inside",
        &proxy.url(),
        &["network:http://inside.example"],
        "http://inside.example/hello",
    );
    let got = notices(&rx, 1, 20);
    assert!(got[0].starts_with("failed: inside.example is at 10.0.0.5"), "{got:?}");
    assert!(proxy.heads().is_empty(), "{:?}", proxy.heads());
}

#[test]
fn an_address_site_never_goes_through_the_proxy() {
    let server = Server::start();
    let proxy = ResolvingProxy::start(inside_server(), &[]);
    let (_r, rx, _h, _f) = load_proxied("proxy-ip", &proxy.url(), &[&server.site()], &server.url("/hello"));
    assert!(notices(&rx, 1, 20)[0].starts_with("200 8 hi there"));
    assert!(proxy.heads().is_empty());
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
        .load(
            &Source::Dir(folder.to_path_buf()),
            Load::new(&grants).config(json!({ "url": url })).proxy(proxy),
        )
        .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    folder
}

fn listening() -> (PluginHost, Receiver<Reply>) {
    let host = host();
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
    let server = Server::start();
    let one = ResolvingProxy::start(inside_server(), &[("45.10.20.30:80", server.port)]);
    let two = ResolvingProxy::start(inside_server(), &[("45.10.20.30:80", server.port)]);
    let (host, rx) = listening();
    let _f = load_on_lock(
        "proxy-change",
        &host,
        &["network:http://nothing.invalid"],
        "http://nothing.invalid/hello",
        Some(&one.url()),
    );
    lock(&host);
    assert_eq!(notices(&rx, 1, 20), ["200 hi there"]);
    host.set_proxy(Some(roster_core::plugin::network::Proxy::parse(&two.url()).unwrap()));
    lock(&host);
    assert_eq!(notices(&rx, 1, 20), ["200 hi there"]);
    assert_eq!((one.heads().len(), two.heads().len()), (1, 1));
    // Taken away: direct again, and a name that doesn't resolve fails here.
    host.set_proxy(None);
    lock(&host);
    let got = notices(&rx, 1, 20);
    assert!(
        got[0].starts_with("failed: ") && got[0].contains("couldn't look up nothing.invalid"),
        "{got:?}"
    );
    assert_eq!(two.heads().len(), 1);
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
