//! Ticket 56 (#90): `examples/plugins/recent-alerts`, the example third-party Plugin, end to end, the
//! way an outside author ships it. The test makes a git repo from the example's folder (a local bare
//! repo, so nothing touches the network), installs it as a Package (ticket 24), and drives it through
//! the Plugin host the Tauri shell uses (ticket 23): install and cancel, every slot it fills, what
//! it can't reach, revoking, an update that asks for more, removal, and a version that misbehaves.
//!
//! It also records what the real Lua does in one scripted run (`recent-alerts.transcript.json` in
//! `app/src/plugins/`): the frontend's tests replay the same steps against the fake Backend's
//! stand-in for this Plugin and check it does the same, so the UI tests test this Plugin's
//! behaviour, not a guess at it. `ROSTER_UPDATE_TRANSCRIPT=1 cargo test` rewrites the file.

mod common;

use roster_core::config::PackageSpec;
use roster_core::package::Packages;
use roster_core::plugin::{Event, Limits, Permission, PluginHost, Reply, Serve, Source, read_manifest};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

const NAME: &str = "recent-alerts";

fn example() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins/recent-alerts")
}

fn temp(test: &str) -> common::Temp {
    common::temp(&format!("recent-alerts-{test}"))
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=A. N. Author",
            "-c",
            "user.email=author@example.com",
            "-c",
            "commit.gpgsign=false",
        ])
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// The author's repo: a bare "remote" and a work tree made from the example's folder.
struct Repo {
    bare: PathBuf,
    work: PathBuf,
}

impl Repo {
    fn new(root: &Path) -> Repo {
        let bare = root.join("remote").join("recent-alerts.git");
        let work = root.join("author");
        std::fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--quiet", "--bare", "--initial-branch=main"]);
        copy_dir(&example(), &work);
        git(&work, &["init", "--quiet", "--initial-branch=main"]);
        git(&work, &["remote", "add", "origin", bare.to_str().unwrap()]);
        let repo = Repo { bare, work };
        repo.publish("v1.0.0");
        repo
    }

    fn publish(&self, message: &str) -> String {
        git(&self.work, &["add", "."]);
        git(&self.work, &["commit", "--quiet", "-m", message]);
        git(&self.work, &["push", "--quiet", "origin", "main"]);
        git(&self.work, &["rev-parse", "HEAD"])
    }

    /// Edits a file of the next version (the text `from` becomes `to`).
    fn edit(&self, file: &str, from: &str, to: &str) {
        let path = self.work.join(file);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(from), "{file} has no {from:?}");
        std::fs::write(&path, text.replacen(from, to, 1)).unwrap();
    }

    fn url(&self) -> String {
        self.bare.to_str().unwrap().to_string()
    }
}

/// A `roster serve` that answers nothing: recent-alerts never needs it, and this records that it
/// never asked.
#[derive(Default)]
struct Serve0 {
    calls: Mutex<Vec<String>>,
}

impl Serve for Serve0 {
    fn call(&self, method: &str, _params: Value) -> Result<Value, String> {
        self.calls.lock().unwrap().push(method.to_string());
        Err(format!("unknown method {method}"))
    }
}

fn config() -> Map<String, Value> {
    json!({ "patterns": ["ERROR", "panic"], "leader": "w a" })
        .as_object()
        .unwrap()
        .clone()
}

fn spec(url: &str, config: Map<String, Value>) -> PackageSpec {
    PackageSpec {
        source: url.into(),
        name: None,
        tag: None,
        branch: None,
        commit: None,
        dir: None,
        config,
    }
}

fn perms(names: &[&str]) -> Vec<Permission> {
    names.iter().map(|n| Permission::parse(n).unwrap()).collect()
}

/// An installed recent-alerts: the author's repo, the Packages, and the host it runs in.
struct World {
    repo: Repo,
    packages: Packages,
    specs: Vec<PackageSpec>,
    host: PluginHost,
    serve: Arc<Serve0>,
    /// Last, so it's deleted after the host above has stopped.
    root: common::Temp,
}

impl World {
    fn new(test: &str) -> World {
        let root = temp(test);
        let repo = Repo::new(&root);
        let packages = Packages::new(&root.join("data"), &root.join("config"));
        let specs = vec![spec(&repo.url(), config())];
        let serve = Arc::new(Serve0::default());
        let host = PluginHost::new(serve.clone(), Limits::default());
        World {
            repo,
            packages,
            specs,
            host,
            serve,
            root,
        }
    }

    /// Clones it and allows the install prompt: pins it and loads it with `grants`.
    fn install(&self, grants: &[&str]) -> Reply {
        let status = self.packages.sync(&self.specs);
        assert_eq!(status[0].error, None);
        self.packages.pin(&self.specs, NAME).unwrap();
        self.load(grants)
    }

    fn load(&self, grants: &[&str]) -> Reply {
        let (dir, config) = self.packages.loadable(&self.specs, NAME).unwrap();
        let (_, reply) = self.host.load_with(&Source::Dir(dir), &perms(grants), &config).unwrap();
        reply
    }

    fn output(&self, session: u64, host: &str, text: &str) -> Vec<Reply> {
        self.host.event(Event {
            name: "terminal_output".into(),
            payload: json!({ "session": session, "host": host, "text": text }),
        })
    }
}

fn find<'a>(ops: &'a [Value], op: &str) -> Vec<&'a Value> {
    ops.iter().filter(|o| o["op"] == op).collect()
}

fn one<'a>(ops: &'a [Value], op: &str) -> &'a Value {
    let found = find(ops, op);
    assert_eq!(found.len(), 1, "one {op} op in {ops:#?}");
    found[0]
}

fn handler(v: &Value) -> u64 {
    v["handler"].as_u64().unwrap_or_else(|| panic!("no handler in {v}"))
}

/// The handler of the row action labelled `label` in the section op.
fn action(section: &Value, label: &str) -> u64 {
    section["spec"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|r| r["actions"].as_array().unwrap().iter())
        .find(|a| a["label"] == label)
        .map(|a| handler(&a["run"]))
        .unwrap_or_else(|| panic!("no action {label:?} in {section:#}"))
}

fn rows(section: &Value) -> Vec<String> {
    section["spec"]["rows"]
        .as_array()
        .map(|r| r.iter().map(|r| r["label"].as_str().unwrap().to_string()).collect())
        .unwrap_or_default()
}

fn ok(reply: &Reply) {
    assert!(reply.error.is_none(), "{:?}", reply.error);
}

// ------------------------------------------------------------------- install

#[test]
fn it_installs_from_a_git_url_showing_its_author_and_what_it_asks_and_cancel_leaves_nothing() {
    let w = World::new("install");
    let status = w.packages.sync(&w.specs);
    assert_eq!(status[0].name, NAME);
    assert_eq!(status[0].url, w.repo.url());
    assert!(!status[0].pinned, "not installed until the prompt is allowed");

    // The install prompt: read from the clone before any of its code runs.
    let (dir, _) = w.packages.loadable(&w.specs, NAME).unwrap();
    let m = read_manifest(&dir).unwrap();
    assert_eq!((m.name.as_str(), m.version.as_str()), (NAME, "1.0.0"));
    assert_eq!(m.author.as_deref(), Some("A. N. Author"));
    assert_eq!(m.permissions, perms(&["terminal.read"]));
    let shown = serde_json::to_value(&m).unwrap();
    assert_eq!(shown["permissions"][0]["name"], "terminal.read");
    assert!(
        shown["permissions"][0]["risk"]
            .as_str()
            .unwrap()
            .contains("A password you type at a prompt that echoes it would be visible too")
    );

    // Cancel: no clone, no lock, nothing loaded.
    w.packages.discard(NAME).unwrap();
    assert!(!w.root.join("data/packages/recent-alerts").exists());
    assert!(!w.root.join("config/roster.lock").exists());
    assert!(w.host.list().is_empty());
}

#[test]
fn allowed_it_adds_its_section_command_key_finder_and_help_page_and_pins_the_commit() {
    let w = World::new("allow");
    let reply = w.install(&["terminal.read"]);
    ok(&reply);
    let lock: Value =
        serde_json::from_str(&std::fs::read_to_string(w.root.join("config/roster.lock")).unwrap()).unwrap();
    assert_eq!(lock[NAME]["commit"], git(&w.repo.work, &["rev-parse", "HEAD"]).as_str());

    let ops = &reply.ops;
    let section = one(ops, "section");
    assert_eq!(section["id"], NAME);
    assert_eq!(section["spec"]["title"], "Recent alerts");
    assert_eq!(
        section["spec"]["empty"],
        "No alerts. Lines with ERROR or panic show here."
    );
    assert_eq!(one(ops, "command")["name"], "alerts");
    // The Leader key comes from its settings in init.lua.
    assert_eq!(
        one(ops, "key"),
        &json!({ "op": "key", "context": "leader", "keys": "w a", "action": "finder alerts" })
    );
    assert_eq!(one(ops, "finder")["spec"]["title"], "Recent alerts");
    let help = one(ops, "help");
    assert_eq!(help["id"], NAME);
    assert!(
        help["spec"]["markdown"]
            .as_str()
            .unwrap()
            .contains("lists the lines with ERROR or panic")
    );
    // No alerts yet: no status segment and no badges.
    assert_eq!(
        one(ops, "remove"),
        &json!({ "op": "remove", "kind": "status", "id": "alerts" })
    );
    assert!(find(ops, "badge").is_empty());
    // It reached roster serve for nothing.
    assert!(w.serve.calls.lock().unwrap().is_empty());
}

// ------------------------------------------------------------------- alerts

#[test]
fn lines_that_match_become_alerts_with_their_host_badge_count_and_a_notice() {
    let w = World::new("alerts");
    ok(&w.install(&["terminal.read"]));
    let replies = w.output(1, "esx-02", "booting\nERROR: disk /dev/sda1 full\nok\n");
    assert_eq!(replies.len(), 1);
    let ops = &replies[0].ops;
    let section = one(ops, "section");
    assert_eq!(rows(section), ["ERROR: disk /dev/sda1 full"]);
    let row = &section["spec"]["rows"][0];
    assert_eq!(row["detail"], "esx-02");
    assert_eq!(row["host"], "esx-02");
    assert!(row["note"].as_str().unwrap().len() == 8, "a time: {}", row["note"]);
    assert_eq!(one(ops, "status")["spec"]["text"], "⚠ 1");
    assert_eq!(one(ops, "status")["spec"]["run"], "finder alerts");
    assert_eq!(
        one(ops, "badge"),
        &json!({ "op": "badge", "host": "esx-02", "text": "1" })
    );
    assert_eq!(
        one(ops, "notify"),
        &json!({ "op": "notify", "text": "esx-02: ERROR: disk /dev/sda1 full", "level": "warn" })
    );
    assert!(
        one(ops, "finder")["spec"]["items"][0]["detail"]
            .as_str()
            .unwrap()
            .starts_with("esx-02 · ")
    );

    // A line split across two batches is matched once it's whole.
    assert!(w.output(2, "appliance", "kernel panic - not syncing\nER").len() == 1);
    let replies = w.output(2, "appliance", "ROR again\nfine\nERROR twice\n");
    let ops = &replies[0].ops;
    assert_eq!(
        rows(one(ops, "section")),
        [
            "ERROR twice",
            "ERROR again",
            "kernel panic - not syncing",
            "ERROR: disk /dev/sda1 full"
        ]
    );
    assert_eq!(one(ops, "status")["spec"]["text"], "⚠ 4");
    assert_eq!(
        find(ops, "badge"),
        [
            &json!({ "op": "badge", "host": "appliance", "text": "3" }),
            &json!({ "op": "badge", "host": "esx-02", "text": "1" })
        ]
    );
    // appliance had its notice a moment ago (kernel panic): these wait for its next one.
    assert!(find(ops, "notify").is_empty());
    // Output with nothing that matches changes nothing.
    assert!(w.output(1, "esx-02", "all good\n").is_empty());
    // Several at once from a Host, one notice.
    let replies = w.output(3, "esx-03", "ERROR a\nERROR b\n");
    assert_eq!(
        one(&replies[0].ops, "notify")["text"],
        "2 new alerts on esx-03, the last: ERROR b"
    );
}

#[test]
fn a_long_unfinished_line_cut_in_the_middle_of_a_character_still_shows_and_never_disables_it() {
    let w = World::new("utf8");
    ok(&w.install(&["terminal.read"]));
    // A line with no end yet, over 2000 bytes: what's kept is its last 2000, which would start
    // 287 bytes before the end of the "é"s, inside one.
    let long = format!("x{} ERROR here {}", "é".repeat(1500), "y".repeat(1701));
    for _ in 0..4 {
        for r in w.output(1, "esx-02", &long) {
            ok(&r);
        }
        let replies = w.output(1, "esx-02", "\n");
        assert_eq!(replies.len(), 1);
        ok(&replies[0]);
        assert!(replies[0].disabled.is_none());
        let label = rows(one(&replies[0].ops, "section"))[0].clone();
        assert!(label.starts_with('é'), "cut on a character: {label:?}");
        assert!(label.contains(" ERROR here "), "{label:?}");
        assert!(!label.contains('\u{fffd}'), "{label:?}");
    }
}

#[test]
fn a_long_line_matches_past_what_a_row_shows() {
    let w = World::new("long");
    ok(&w.install(&["terminal.read"]));
    let replies = w.output(1, "esx-02", &format!("{} ERROR at the end\n", "y".repeat(400)));
    assert_eq!(replies.len(), 1, "matched");
    let label = rows(one(&replies[0].ops, "section"))[0].clone();
    assert_eq!(label.chars().count(), 300, "cut to show: {label:?}");
    assert!(label.ends_with('…'));
}

#[test]
fn a_hosts_notices_come_at_most_once_per_quiet_spell_and_then_count_what_was_held() {
    let mut w = World::new("quiet");
    w.specs[0].config.insert("quiet".into(), json!(1));
    ok(&w.install(&["terminal.read"]));
    let notices = |replies: &[Reply]| -> Vec<String> {
        replies
            .iter()
            .flat_map(|r| find(&r.ops, "notify"))
            .map(|n| n["text"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(notices(&w.output(1, "esx-02", "ERROR one\n")), ["esx-02: ERROR one"]);
    // `tail -f` on a noisy log: the section keeps up, the notices don't pile up.
    let replies = w.output(1, "esx-02", "ERROR two\nERROR three\n");
    assert!(notices(&replies).is_empty());
    assert_eq!(rows(one(&replies[0].ops, "section")).len(), 3);
    // Another Host has its own spell.
    assert_eq!(notices(&w.output(2, "appliance", "panic\n")), ["appliance: panic"]);
    std::thread::sleep(std::time::Duration::from_millis(2100));
    assert_eq!(
        notices(&w.output(1, "esx-02", "ERROR four\n")),
        ["3 new alerts on esx-02, the last: ERROR four"]
    );
}

#[test]
fn what_you_type_echoed_after_a_shell_prompt_isnt_an_alert() {
    let w = World::new("echo");
    ok(&w.install(&["terminal.read"]));
    for typed in [
        "esx-02$ grep ERROR /var/log/syslog",
        "root@esx-02:~# grep ERROR /var/log/syslog",
        "[admin@appliance logs]$ grep -c panic kern.log",
        "$ grep ERROR app.log",
        "PS C:\\logs> Select-String ERROR app.log",
    ] {
        assert!(w.output(1, "esx-02", &format!("{typed}\n")).is_empty(), "{typed:?}");
    }
    // What the command prints is still watched.
    let replies = w.output(1, "esx-02", "Oct 31 10:00:00 esx-02 app: ERROR: disk full\n");
    assert_eq!(
        rows(one(&replies[0].ops, "section")),
        ["Oct 31 10:00:00 esx-02 app: ERROR: disk full"]
    );
}

/// Ticket 94 (#167): a shell's OSC 133 marks say what each run of lines is (`kind`). recent-alerts
/// skips the prompt and the line typed at it whatever they look like (a prompt its guess doesn't
/// know), and keeps its guess for the rest: a command's output may be an `ssh` echoing you.
#[test]
fn lines_the_marks_call_prompt_or_input_are_never_alerts_and_the_rest_keep_the_guess() {
    let w = World::new("marks");
    ok(&w.install(&["terminal.read"]));
    let say = |kind: &str, text: &str| {
        w.host.event(Event {
            name: "terminal_output".into(),
            payload: json!({ "session": 1, "host": "esx-02", "text": text, "kind": kind }),
        })
    };
    assert!(say("input", "esx-02 % grep ERROR app.log\n").is_empty());
    assert!(say("prompt", "ERROR count: 3 (main)\n").is_empty());
    assert!(say("output", "esx-03$ grep ERROR x\n").is_empty());
    let replies = say("output", "ERROR: disk full\n");
    assert_eq!(rows(one(&replies[0].ops, "section")), ["ERROR: disk full"]);
}

#[test]
fn a_quick_connect_session_has_no_host_so_its_alerts_have_no_badge_and_no_goto() {
    let w = World::new("quick");
    ok(&w.install(&["terminal.read"]));
    let replies = w.host.event(Event {
        name: "terminal_output".into(),
        payload: json!({ "session": 7, "host": null, "text": "ERROR on a box\n" }),
    });
    ok(&replies[0]);
    let ops = &replies[0].ops;
    let row = &one(ops, "section")["spec"]["rows"][0];
    assert_eq!(row["detail"], "Quick Connect");
    assert!(row.get("host").is_none(), "no Host to go to: {row}");
    assert!(find(ops, "badge").is_empty());
    assert_eq!(one(ops, "notify")["text"], "Quick Connect: ERROR on a box");
    let section = one(ops, "section").clone();
    let r = w
        .host
        .call(NAME, action(&section, "Details of ERROR on a box"), json!({}));
    ok(&r);
    assert_eq!(
        one(&r.ops, "float")["spec"]["title"],
        "Alert in a Quick Connect Session"
    );
    assert_eq!(
        one(&r.ops, "float")["spec"]["lines"][0],
        "Host     none (Quick Connect)"
    );
}

#[test]
fn its_actions_show_the_details_copy_the_line_and_dismiss_it_and_alerts_clear_dismisses_all() {
    let w = World::new("actions");
    let loaded = w.install(&["terminal.read"]);
    let command = handler(&one(&loaded.ops, "command")["run"]);
    w.output(1, "esx-02", "mounting\nERROR: disk /dev/sda1 full\n");
    let replies = w.output(2, "appliance", "kernel panic - not syncing\n");
    let section = one(&replies[0].ops, "section").clone();

    let r = w.host.call(
        NAME,
        action(&section, "Details of ERROR: disk /dev/sda1 full"),
        json!({}),
    );
    ok(&r);
    let float = one(&r.ops, "float");
    assert_eq!(float["spec"]["title"], "Alert on esx-02");
    let lines: Vec<&str> = float["spec"]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap())
        .collect();
    assert_eq!(lines[0], "Host     esx-02");
    assert_eq!(lines[1], "Session  1");
    assert_eq!(lines[3], "Matched  ERROR");
    // The lines before it, then the line itself.
    assert_eq!(lines[5..], ["  mounting", "› ERROR: disk /dev/sda1 full"]);

    let r = w
        .host
        .call(NAME, action(&section, "Copy kernel panic - not syncing"), json!({}));
    ok(&r);
    assert_eq!(
        one(&r.ops, "copy"),
        &json!({ "op": "copy", "text": "kernel panic - not syncing" })
    );

    let r = w
        .host
        .call(NAME, action(&section, "Dismiss kernel panic - not syncing"), json!({}));
    ok(&r);
    assert_eq!(rows(one(&r.ops, "section")), ["ERROR: disk /dev/sda1 full"]);
    assert_eq!(
        find(&r.ops, "badge"),
        [
            &json!({ "op": "badge", "host": "appliance", "text": null }),
            &json!({ "op": "badge", "host": "esx-02", "text": "1" })
        ]
    );

    // :alerts shows them all in a float; :alerts clear dismisses them all.
    let r = w.host.call(NAME, command, json!({ "args": "", "words": [] }));
    ok(&r);
    assert_eq!(one(&r.ops, "float")["spec"]["title"], "Recent alerts");
    let r = w
        .host
        .call(NAME, command, json!({ "args": "clear", "words": ["clear"] }));
    ok(&r);
    assert!(rows(one(&r.ops, "section")).is_empty());
    // The status segment goes, and so does the timer that kept "2 min ago" true.
    let removed: Vec<&Value> = find(&r.ops, "remove");
    assert_eq!(removed[0], &json!({ "op": "remove", "kind": "status", "id": "alerts" }));
    assert_eq!(removed[1]["kind"], "timer");
    assert_eq!(one(&r.ops, "notify")["text"], "Dismissed 1 alert");
}

#[test]
fn bad_settings_are_named_in_a_notice_and_the_defaults_used() {
    let mut w = World::new("settings");
    w.specs[0].config = json!({ "patterns": "ERROR", "max": 0, "notify": "yes", "quiet": -1 })
        .as_object()
        .unwrap()
        .clone();
    let reply = w.install(&["terminal.read"]);
    ok(&reply);
    let notices: Vec<&str> = find(&reply.ops, "notify")
        .iter()
        .map(|n| n["text"].as_str().unwrap())
        .collect();
    assert_eq!(
        notices,
        [
            "config.patterns must be a list of text, such as { \"ERROR\", \"panic\" }; using the default",
            "config.max must be a whole number from 1 to 1000; using the default",
            "config.notify must be true or false; using the default",
            "config.quiet must be a whole number of seconds from 0 to 3600; using the default"
        ]
    );
    assert_eq!(one(&reply.ops, "key")["keys"], "w w");
    assert!(w.output(1, "esx-02", "disk full on /var\n").len() == 1);
}

// ------------------------------------------------------------------- trust

#[test]
fn revoked_it_still_loads_hears_no_output_and_says_what_it_needs() {
    let w = World::new("revoke");
    ok(&w.install(&["terminal.read"]));
    assert_eq!(w.output(1, "esx-02", "ERROR one\n").len(), 1);
    // `:plugins` turns terminal.read off: the host loads it again without it.
    let reply = w.load(&[]);
    ok(&reply);
    let section = one(&reply.ops, "section");
    assert!(rows(section).is_empty(), "the alerts it had went with it");
    assert_eq!(
        section["spec"]["empty"],
        "Allow terminal.read in :plugins to see alerts."
    );
    assert!(w.output(1, "esx-02", "ERROR two\n").is_empty(), "no output reaches it");
    assert_eq!(w.host.list()[0].granted, Vec::<Permission>::new());
}

/// The test version of the Plugin: the same code, plus a probe that tries every function it
/// wasn't granted, and the secrets, and reports what it found in its status segment.
#[test]
fn what_it_wasnt_granted_isnt_in_its_sandbox() {
    let w = World::new("enforce");
    w.repo.edit(
        "init.lua",
        "\nshow()\n",
        r#"
show()
local found = {}
local function try(name, f)
  local ok, err = pcall(f)
  found[#found + 1] = name .. "=" .. (ok and "ok" or tostring(err):gsub("^.-:%d+: ", ""))
end
try("terminal.send", function() roster.terminal.send(1, "rm -rf /\r") end)
try("sessions.open", function() roster.sessions.open("esx-02") end)
try("inventory", function() return roster.inventory.hosts() end)
try("serve", function() return roster.serve.call("vault.unlock", { password = "x" }) end)
try("network", function() return roster.network.get("https://example.com") end)
try("http", function() return roster.http.get("https://example.com") end)
try("vault", function() return roster.vault.get("esx-02 root") end)
try("secrets", function() return roster.secrets end)
try("io", function() return io.open("/etc/passwd") end)
try("os.getenv", function() return os.getenv("HOME") end)
try("package", function() return package.loadlib end)
try("debug", function() return debug.getregistry() end)
roster.status.set("probe", { text = table.concat(found, " | ") })
"#,
    );
    w.repo.publish("a probe");
    // Granted everything there is: it still runs with only what its manifest asks for.
    let all = [
        "terminal.read",
        "terminal.write",
        "sessions.open",
        "inventory.read",
        "inventory.write",
        "serve:hosts.list",
    ];
    let reply = w.install(&all);
    ok(&reply);
    assert_eq!(w.host.list()[0].granted, perms(&["terminal.read"]));
    let probe = find(&reply.ops, "status")
        .into_iter()
        .find(|s| s["id"] == "probe")
        .unwrap()["spec"]["text"]
        .as_str()
        .unwrap()
        .to_string();
    for (name, says) in [
        ("terminal.send", "attempt to index a nil value (field 'terminal')"),
        ("sessions.open", "attempt to call a nil value (field 'open')"),
        ("inventory", "attempt to index a nil value (field 'inventory')"),
        ("serve", "attempt to index a nil value (field 'serve')"),
        ("network", "attempt to index a nil value (field 'network')"),
        ("http", "attempt to index a nil value (field 'http')"),
        ("vault", "attempt to index a nil value (field 'vault')"),
        ("secrets", "ok"),
        ("io", "attempt to index a nil value (global 'io')"),
        ("os.getenv", "attempt to call a nil value (field 'getenv')"),
        ("package", "attempt to index a nil value (global 'package')"),
        ("debug", "attempt to index a nil value (global 'debug')"),
    ] {
        assert!(probe.contains(&format!("{name}={says}")), "{name}: {probe}");
    }
    // `roster.secrets` is nil too: reading it is fine, there's just nothing there.
    assert!(!probe.contains("table:"), "{probe}");
    assert!(w.serve.calls.lock().unwrap().is_empty());
}

#[test]
fn a_version_that_asks_for_network_without_a_site_or_a_secret_doesnt_install() {
    for (permission, says) in [
        ("network", "names the site it may reach"),
        ("serve:vault.unlock", "never one that reaches a secret"),
        ("serve:session.prepare", "never one that reaches a secret"),
    ] {
        let w = World::new("greedy");
        w.repo.edit(
            "roster-plugin.lua",
            "permissions = { \"terminal.read\" }",
            &format!("permissions = {{ \"terminal.read\", {permission:?} }}"),
        );
        w.repo.publish("ask for more");
        w.packages.sync(&w.specs);
        let (dir, _) = w.packages.loadable(&w.specs, NAME).unwrap();
        let e = read_manifest(&dir).unwrap_err();
        assert!(e.message.contains(says), "{permission}: {e}");
        assert_eq!(e.file.as_deref(), Some("roster-plugin.lua"));
    }
}

/// T56's gap 1 (#105): an update that asks for `network` shows each site it names, flagged,
/// and declining keeps the version it has; a later one that adds a site asks again for it.
#[test]
fn an_update_that_asks_for_network_shows_its_sites_flagged_and_a_new_site_asks_again() {
    let w = World::new("update-network");
    ok(&w.install(&["terminal.read"]));
    let old = git(&w.repo.work, &["rev-parse", "HEAD"]);
    w.repo.edit("roster-plugin.lua", "\"1.0.0\"", "\"2.0.0\"");
    w.repo.edit(
        "roster-plugin.lua",
        "permissions = { \"terminal.read\" }",
        "permissions = { \"terminal.read\", \"network:hooks.example.com\" }",
    );
    let v2 = w.repo.publish("v2: post alerts to a webhook");

    let checked = w.packages.check(&w.specs);
    let update = checked[0].update.as_ref().expect("an update");
    let m = update.manifest.as_ref().expect("a usable manifest");
    assert_eq!(m.permissions, perms(&["terminal.read", "network:hooks.example.com"]));
    let shown = serde_json::to_value(m).unwrap();
    let risk = shown["permissions"][1]["risk"].as_str().expect("flagged");
    assert!(risk.contains("hooks.example.com"), "{risk}");
    // Declined (Esc): nothing moved, and it runs as it did, with no roster.http.
    let status = w.packages.sync(&w.specs);
    assert_eq!(status[0].commit.as_deref(), Some(old.as_str()));
    assert_eq!(w.host.list()[0].manifest.version, "1.0.0");
    assert_eq!(w.output(1, "esx-02", "ERROR still here\n").len(), 1);
    // Allowed: it moves and runs with the site granted.
    w.packages.apply(&w.specs, NAME, &v2).unwrap();
    ok(&w.load(&["terminal.read", "network:hooks.example.com"]));
    assert_eq!(
        w.host.list()[0].granted,
        perms(&["terminal.read", "network:hooks.example.com"])
    );

    // v3 adds a site: that one is a new permission, so the prompt asks for it.
    w.repo.edit(
        "roster-plugin.lua",
        "\"network:hooks.example.com\" }",
        "\"network:hooks.example.com\", \"network:*.chat.example\" }",
    );
    w.repo.publish("v3: and to chat");
    let checked = w.packages.check(&w.specs);
    let m = checked[0].update.as_ref().unwrap().manifest.as_ref().unwrap();
    let granted = &w.host.list()[0].granted;
    let new: Vec<String> = m
        .permissions
        .iter()
        .filter(|p| !granted.contains(p))
        .map(|p| p.to_string())
        .collect();
    assert_eq!(new, ["network:*.chat.example"]);
}

#[test]
fn an_update_that_asks_for_a_new_permission_shows_it_and_declining_keeps_the_old_version() {
    let w = World::new("update-more");
    ok(&w.install(&["terminal.read"]));
    let old = git(&w.repo.work, &["rev-parse", "HEAD"]);
    w.repo.edit("roster-plugin.lua", "\"1.0.0\"", "\"2.0.0\"");
    w.repo.edit(
        "roster-plugin.lua",
        "permissions = { \"terminal.read\" }",
        "permissions = { \"terminal.read\", \"sessions.open\" }",
    );
    let new = w.repo.publish("v2: open the Host of an alert");
    let checked = w.packages.check(&w.specs);
    let update = checked[0].update.as_ref().expect("an update");
    assert_eq!(update.to, new);
    let m = update.manifest.as_ref().unwrap();
    assert_eq!(m.permissions, perms(&["terminal.read", "sessions.open"]));
    assert!(
        update
            .diff
            .contains("+  permissions = { \"terminal.read\", \"sessions.open\" }")
    );
    // Declined (Esc): nothing is applied.
    assert_eq!(w.packages.sync(&w.specs)[0].commit.as_deref(), Some(old.as_str()));
    // Allowed: it moves, and runs with what it was granted.
    w.packages.apply(&w.specs, NAME, &new).unwrap();
    ok(&w.load(&["terminal.read", "sessions.open"]));
    assert_eq!(w.host.list()[0].manifest.version, "2.0.0");
}

#[test]
fn removing_it_leaves_nothing_behind() {
    let w = World::new("remove");
    ok(&w.install(&["terminal.read"]));
    w.packages.remove(NAME).unwrap();
    assert!(w.host.unload(NAME));
    assert!(!w.root.join("data/packages/recent-alerts").exists());
    let lock = std::fs::read_to_string(w.root.join("config/roster.lock")).unwrap();
    assert_eq!(lock.trim(), "{}");
    assert!(w.host.list().is_empty());
    assert!(w.output(1, "esx-02", "ERROR gone\n").is_empty());
}

// ------------------------------------------------------------------- isolation

#[test]
fn a_version_that_throws_loops_or_allocates_is_stopped_with_its_name_and_the_rest_carries_on() {
    for (what, code, says) in [
        ("throws", "error(\"boom\")", "init.lua:"),
        ("loops", "while true do end", "ms"),
        (
            "allocates",
            "local t = {} for i = 1, 1e9 do t[i] = string.rep(\"x\", 1000000) .. i end",
            "used too much memory",
        ),
    ] {
        let w = World::new(&format!("isolation-{what}"));
        w.repo.edit(
            "init.lua",
            "  roster.on(\"terminal_output\", function(e)\n",
            &format!(
                "  roster.on(\"terminal_output\", function(e)\n    if e.text:find(\"BAD\", 1, true) then {code} end\n"
            ),
        );
        w.repo.publish(what);
        ok(&w.install(&["terminal.read"]));
        // Another Plugin, to show the app keeps working.
        let pinned = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins/pinned");
        ok(&w
            .host
            .load(&Source::Dir(pinned), &perms(&["inventory.read"]))
            .unwrap()
            .1);

        let mut disabled = None;
        for i in 0..3 {
            let replies = w.output(1, "esx-02", &format!("BAD {i}\n"));
            let r = replies.iter().find(|r| r.plugin == NAME).expect("it answers");
            let e = r.error.as_ref().expect("an error");
            assert_eq!(e.plugin, NAME);
            assert!(e.to_string().starts_with("recent-alerts: "), "{e}");
            assert!(e.to_string().contains(says), "{what}: {e}");
            assert!(r.ops.is_empty(), "a failed call changes nothing");
            disabled = r.disabled.clone();
        }
        assert_eq!(disabled.as_deref(), Some("it failed 3 times"), "{what}");
        let status = w.host.list();
        let me = status.iter().find(|s| s.manifest.name == NAME).unwrap();
        assert!(me.disabled.is_some());
        assert!(w.output(1, "esx-02", "ERROR after\n").is_empty());
        // pinned still answers.
        assert!(
            status
                .iter()
                .find(|s| s.manifest.name == "pinned")
                .unwrap()
                .disabled
                .is_none()
        );
        let pin = w.host.event(Event {
            name: "lock".into(),
            payload: json!({}),
        });
        assert!(pin.iter().all(|r| r.error.is_none()));
    }
}

// ------------------------------------------------------------------- transcript

/// One step of the scripted run the frontend's stand-in replays.
fn steps() -> Value {
    json!([
        { "do": "load", "grants": ["terminal.read"], "config": { "patterns": ["ERROR", "panic"], "leader": "w a" } },
        { "do": "event", "name": "terminal_output", "payload": { "session": 1, "host": "esx-02", "text": "booting\nERROR: disk /dev/sda1 full\nok\n" } },
        { "do": "event", "name": "terminal_output", "payload": { "session": 2, "host": "appliance", "text": "kernel panic - not syncing\nER" } },
        { "do": "event", "name": "terminal_output", "payload": { "session": 2, "host": "appliance", "text": "ROR again\n" } },
        { "do": "event", "name": "terminal_output", "payload": { "session": 1, "host": "esx-02", "text": "all good\n" } },
        { "do": "event", "name": "terminal_output", "payload": { "session": 1, "host": "esx-02", "text": "esx-02$ grep ERROR /var/log/syslog\n" } },
        { "do": "event", "name": "terminal_output", "payload": { "session": 3, "host": null, "text": "ERROR on a box\n" } },
        { "do": "event", "name": "terminal_output", "payload": { "session": 4, "host": "esx-02", "text": "esx-02 % grep ERROR app.log\n", "kind": "input" } },
        { "do": "timer" },
        { "do": "action", "label": "Details of ERROR on a box" },
        { "do": "action", "label": "Details of ERROR: disk /dev/sda1 full" },
        { "do": "action", "label": "Copy ERROR again" },
        { "do": "action", "label": "Dismiss kernel panic - not syncing" },
        { "do": "command", "name": "alerts", "args": "" },
        { "do": "finder", "id": "alerts", "label": "ERROR again" },
        { "do": "command", "name": "alerts", "args": "nonsense" },
        { "do": "command", "name": "alerts", "args": "clear" },
        { "do": "event", "name": "session_exit", "payload": { "session": 2, "host": "appliance", "code": 0 } },
        { "do": "load", "grants": [], "config": { "patterns": ["ERROR", "panic"], "leader": "w a" } }
    ])
}

/// An op as the transcript keeps it: as [`normal`], with a timer's id as `"N"` (it's a handler's
/// number, which the stand-in counts its own way).
fn normal_op(op: &Value) -> Value {
    let mut op = normal(op);
    if op["op"] == "timer" || (op["op"] == "remove" && op["kind"] == "timer") {
        op["id"] = json!("N");
    }
    op
}

/// Ops as the transcript keeps them: each function as `"fn"`, each time as `HH:MM:SS`, each date
/// as `YYYY-MM-DD`, and an empty table as an empty list (Lua can't tell them apart).
fn normal(v: &Value) -> Value {
    match v {
        Value::Object(m) if m.len() == 1 && m.contains_key("handler") => json!("fn"),
        Value::Object(m) if m.is_empty() => json!([]),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), normal(v))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(normal).collect()),
        Value::String(s) => Value::String(times(s)),
        other => other.clone(),
    }
}

fn times(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    let digits = |at: usize, n: usize| at + n <= b.len() && b[at..at + n].iter().all(u8::is_ascii_digit);
    while i < b.len() {
        if digits(i, 4)
            && b.get(i + 4) == Some(&b'-')
            && digits(i + 5, 2)
            && b.get(i + 7) == Some(&b'-')
            && digits(i + 8, 2)
        {
            out.push_str("YYYY-MM-DD");
            i += 10;
        } else if digits(i, 2)
            && b.get(i + 2) == Some(&b':')
            && digits(i + 3, 2)
            && b.get(i + 5) == Some(&b':')
            && digits(i + 6, 2)
        {
            out.push_str("HH:MM:SS");
            i += 8;
        } else {
            let c = s[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

#[test]
fn the_transcript_the_frontend_replays_is_what_the_real_lua_does() {
    let w = World::new("transcript");
    w.packages.sync(&w.specs);
    w.packages.pin(&w.specs, NAME).unwrap();
    let (dir, _) = w.packages.loadable(&w.specs, NAME).unwrap();
    // What each step can reach: the latest section, commands and finders it set.
    let mut sections: BTreeMap<String, Value> = BTreeMap::new();
    let mut commands: BTreeMap<String, u64> = BTreeMap::new();
    let mut finders: BTreeMap<String, Value> = BTreeMap::new();
    let mut timer: Option<u64> = None;
    let mut out = Vec::new();
    for step in steps().as_array().unwrap() {
        let replies: Vec<Reply> = match step["do"].as_str().unwrap() {
            "load" => {
                let grants: Vec<&str> = step["grants"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|g| g.as_str().unwrap())
                    .collect();
                vec![
                    w.host
                        .load_with(&Source::Dir(dir.clone()), &perms(&grants), &step["config"])
                        .unwrap()
                        .1,
                ]
            }
            "event" => w.host.event(Event {
                name: step["name"].as_str().unwrap().into(),
                payload: step["payload"].clone(),
            }),
            "action" => {
                let label = step["label"].as_str().unwrap();
                vec![w.host.call(NAME, action(&sections[NAME], label), json!({}))]
            }
            "command" => {
                let args = step["args"].as_str().unwrap();
                let words: Vec<&str> = args.split_whitespace().collect();
                let h = commands[step["name"].as_str().unwrap()];
                vec![w.host.call(NAME, h, json!({ "args": args, "words": words }))]
            }
            "finder" => {
                let items = finders[step["id"].as_str().unwrap()]["spec"]["items"].clone();
                let item = items
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|i| i["label"] == step["label"])
                    .unwrap()
                    .clone();
                vec![w.host.call(NAME, handler(&item["run"]), json!({}))]
            }
            // The app's clock: the timer the Plugin set last fires.
            "timer" => vec![w.host.call(NAME, timer.expect("a timer"), json!({}))],
            other => panic!("no step {other}"),
        };
        let mut ops = Vec::new();
        for r in &replies {
            ok(r);
            for op in &r.ops {
                match op["op"].as_str().unwrap() {
                    "section" => {
                        sections.insert(op["id"].as_str().unwrap().into(), op.clone());
                    }
                    "command" => {
                        commands.insert(op["name"].as_str().unwrap().into(), handler(&op["run"]));
                    }
                    "finder" => {
                        finders.insert(op["id"].as_str().unwrap().into(), op.clone());
                    }
                    "timer" => timer = Some(handler(&op["run"])),
                    _ => {}
                }
                ops.push(normal_op(op));
            }
        }
        let mut step = step.clone();
        step["ops"] = Value::Array(ops);
        out.push(step);
    }
    let transcript = serde_json::to_string_pretty(&json!({
        "about": "What examples/plugins/recent-alerts does in a scripted run, recorded by crates/roster-core/tests/recent_alerts.rs (ROSTER_UPDATE_TRANSCRIPT=1 cargo test rewrites it). The fake Backend's stand-in replays it (recentAlerts.test.ts).",
        "steps": out,
    }))
    .unwrap()
        + "\n";
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/src/plugins/recent-alerts.transcript.json");
    if std::env::var_os("ROSTER_UPDATE_TRANSCRIPT").is_some() {
        std::fs::write(&path, &transcript).unwrap();
    }
    let recorded = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        recorded == transcript,
        "{} is out of date: run ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p roster-core --test recent_alerts, and update the fake Backend's stand-in to match",
        path.display()
    );
}
