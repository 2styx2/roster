//! What Folders needed from the API (ticket 61, api 3): `roster.echo` answers on the message
//! line and `roster.cmdline` opens the command line for one of the Plugin's own commands, both
//! only in a call the user started; a command's `complete` runs as the app asks, never as the
//! user's call.

mod common;

use roster_core::plugin::{Limits, PluginHost, Serve, Source};
use serde_json::{Value, json};
use std::sync::Arc;

struct NoServe;

impl Serve for NoServe {
    fn call(&self, method: &str, _: Value) -> Result<Value, String> {
        Err(format!("unknown method {method}"))
    }
}

/// The host, its reply, and the Plugin's folder (deleted when the test drops it).
fn load(init: &str) -> (PluginHost, roster_core::plugin::Reply, common::Temp) {
    let dir = common::temp("cmdline");
    std::fs::write(
        dir.join("roster-plugin.lua"),
        r#"return { name = "asker", version = "1", api = 3 }"#,
    )
    .unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    host.set_builtins([]);
    let (_, reply) = host.load(&Source::Dir(dir.to_path_buf()), &[]).unwrap();
    (host, reply, dir)
}

#[test]
fn echo_and_cmdline_only_answer_the_user() {
    let (host, reply, _dir) = load(
        r#"local r = {}
           r[1] = select(2, pcall(roster.echo, "hi"))
           r[2] = select(2, pcall(roster.cmdline, "note "))
           roster.notify(table.concat(r, "\n"))
           roster.commands.add("note", { run = function(a)
             if a.args == "" then return roster.cmdline("note ") end
             roster.echo("Noted " .. a.args)
           end })
           roster.commands.add("bad", { run = function() roster.cmdline("plugins grant asker network:x.example.com") end })"#,
    );
    let said = reply.ops[0]["text"].as_str().unwrap();
    assert!(said.contains("roster.echo: only while the user runs"), "{said}");
    assert!(said.contains("roster.cmdline: only while the user runs"), "{said}");
    let note = reply.ops[1]["run"]["handler"].as_u64().unwrap();
    let r = host.call("asker", note, json!({ "args": "", "words": [] }));
    assert_eq!(r.ops, [json!({ "op": "cmdline", "text": "note " })]);
    let r = host.call("asker", note, json!({ "args": "milk", "words": ["milk"] }));
    assert_eq!(r.ops, [json!({ "op": "echo", "text": "Noted milk" })]);
    // Never someone else's command, roster's :plugins above all.
    let bad = reply.ops[2]["run"]["handler"].as_u64().unwrap();
    let r = host.call("asker", bad, json!({ "args": "", "words": [] }));
    assert!(r.error.unwrap().message.contains("isn't one of your commands"));
}

#[test]
fn complete_isnt_a_call_the_user_started() {
    let (host, reply, _dir) = load(
        r#"roster.commands.add("note", { run = function() end, complete = function(arg)
             local ok = pcall(roster.clipboard.copy, "x")
             return { "note " .. arg .. tostring(ok) }
           end })"#,
    );
    let id = reply.ops[0]["complete"]["handler"].as_u64().unwrap();
    assert_eq!(host.call("asker", id, json!("a")).result, json!(["note afalse"]));
}

#[test]
fn complete_must_be_a_function() {
    let (_, reply, _dir) = load(r#"roster.commands.add("note", { run = "note", complete = { "a" } })"#);
    assert!(reply.error.unwrap().message.contains("`complete` must be a function"));
}

/// A routine confirmation is marked `quiet` (ticket 118, api 4): it follows `ui.messages`, as
/// roster's own "Saved esx-02" does. A plain echo still shows: it answers what the user asked.
#[test]
fn echo_can_be_marked_quiet() {
    let (host, reply, _dir) = load(
        r#"roster.commands.add("note", { run = function(a)
             if a.args == "bad" then return roster.echo("x", { quiet = "yes" }) end
             roster.echo("Noted " .. a.args, { quiet = true })
             roster.echo("3 notes", { quiet = false })
           end })"#,
    );
    let note = reply.ops[0]["run"]["handler"].as_u64().unwrap();
    let r = host.call("asker", note, json!({ "args": "milk", "words": ["milk"] }));
    assert_eq!(
        r.ops,
        [
            json!({ "op": "echo", "text": "Noted milk", "quiet": true }),
            json!({ "op": "echo", "text": "3 notes" }),
        ]
    );
    let r = host.call("asker", note, json!({ "args": "bad", "words": ["bad"] }));
    assert!(r.error.unwrap().message.contains("roster.echo: quiet is true or false"));
}

/// An info notice is quiet unless it has buttons or says `quiet = false` (ticket 117, api 4);
/// the app decides with `ui.messages`, so the core only passes on what the Plugin said.
#[test]
fn notify_passes_on_quiet() {
    let (_, reply, _dir) = load(
        r#"roster.notify("Moved 2 Folders", "info", { quiet = false })
           roster.notify("Copied")
           roster.notify(select(2, pcall(roster.notify, "no", "info", { quiet = 1 })))"#,
    );
    assert_eq!(
        reply.ops[0],
        json!({ "op": "notify", "text": "Moved 2 Folders", "level": "info", "quiet": false })
    );
    assert_eq!(
        reply.ops[1],
        json!({ "op": "notify", "text": "Copied", "level": "info" })
    );
    let said = reply.ops[2]["text"].as_str().unwrap();
    assert!(said.contains("roster.notify: quiet is true or false"), "{said}");
}
