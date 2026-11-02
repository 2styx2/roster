//! Folders as a built-in Plugin on the public API (tickets 23 and 61, decision Q93): its
//! section, its `folder` command and keys, its data in its own folder, and moving folders.yml's
//! Folders in once without losing any. Driven through `PluginHost`, as the Tauri shell does,
//! with a fake `roster serve` and a temp data folder.

mod common;

use roster_core::plugin::{Event, Limits, Permission, PluginHost, Reply, Serve, Source};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;

struct FakeServe;

impl Serve for FakeServe {
    fn call(&self, method: &str, _params: Value) -> Result<Value, String> {
        match method {
            "hosts.list" => Ok(json!({
                "hosts": [{ "name": "esx-02" }, { "name": "esx-03" }, { "name": "db-01" }],
                "groups": {}
            })),
            other => Err(format!("unknown method {other}")),
        }
    }
}

fn data(test: &str) -> common::Temp {
    common::temp(&format!("folders-{test}"))
}

fn host(data: &Path) -> PluginHost {
    let host = PluginHost::new(Arc::new(FakeServe), Limits::default()).with_data(data);
    // As the app does before any Plugin loads (issue #184): Folders' `folder` is its own.
    host.set_builtins(["open".to_string(), "connect".to_string()]);
    host
}

fn read() -> Vec<Permission> {
    vec![Permission::parse("inventory.read").unwrap()]
}

fn load(h: &PluginHost, config: Value) -> Reply {
    let (_, reply) = h
        .load_with(&Source::Bundled("folders".into()), &read(), &config)
        .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    reply
}

fn op<'a>(reply: &'a Reply, kind: &str) -> Vec<&'a Value> {
    reply.ops.iter().filter(|o| o["op"] == kind).collect()
}

fn section(reply: &Reply) -> &Value {
    &op(reply, "section").last().expect("a section op")["spec"]
}

fn labels(spec: &Value) -> Vec<String> {
    spec["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["label"].as_str().unwrap().to_string())
        .collect()
}

/// Runs `:folder ARGS` as the app does: the command's handler with its context.
fn folder(h: &PluginHost, first: &Reply, ctx: Value) -> Reply {
    let cmd = op(first, "command")
        .into_iter()
        .find(|o| o["name"] == "folder")
        .unwrap();
    let id = cmd["run"]["handler"].as_u64().unwrap();
    h.call("folders", id, ctx)
}

fn args(text: &str) -> Value {
    let words: Vec<&str> = text.split_whitespace().collect();
    json!({ "args": text, "words": words })
}

fn echoed(reply: &Reply) -> String {
    assert!(reply.error.is_none(), "{:?}", reply.error);
    op(reply, "echo")
        .iter()
        .map(|o| o["text"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n")
}

fn saved(data: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(data.join("plugin-data/folders/folders.json")).unwrap()).unwrap()
}

#[test]
fn it_adds_the_section_the_command_the_keys_and_a_finder() {
    let d = data("adds");
    let h = host(&d);
    let r = load(&h, json!({}));
    let spec = section(&r);
    assert_eq!(spec["title"], "Folders");
    assert_eq!(spec["order"], 200);
    assert!(spec["empty"].as_str().unwrap().contains("␣ a"));
    assert_eq!(spec["actions"][0]["run"], "folder new");
    let keys: Vec<_> = op(&r, "key")
        .iter()
        .map(|k| (k["keys"].clone(), k["action"].clone()))
        .collect();
    assert_eq!(
        keys,
        [(json!("a"), json!("folder add")), (json!("A"), json!("folder remove"))]
    );
    assert_eq!(op(&r, "finder")[0]["spec"]["section"], "folders");
    assert!(op(&r, "command")[0]["complete"]["handler"].is_u64());
    // Nothing to move in, so nothing is written yet.
    assert!(!d.join("plugin-data/folders").exists());
}

#[test]
fn the_folder_command_makes_changes_and_keeps_them_in_its_own_folder() {
    let d = data("command");
    let h = host(&d);
    let first = load(&h, json!({}));
    assert_eq!(
        echoed(&folder(&h, &first, args("new Lab ESXi"))),
        "Created Folder Lab ESXi"
    );
    assert_eq!(
        echoed(&folder(&h, &first, args("add esx-02 Lab ESXi"))),
        "Added esx-02 to Lab ESXi"
    );
    assert_eq!(
        echoed(&folder(&h, &first, args("add esx-03 Night"))),
        "Added esx-03 to Night"
    );
    assert_eq!(
        echoed(&folder(&h, &first, args("add esx-02 lab esxi"))),
        "esx-02 is already in Lab ESXi"
    );
    assert_eq!(
        echoed(&folder(&h, &first, args("add web-9 Lab"))),
        "No Host named web-9"
    );
    assert_eq!(
        echoed(&folder(&h, &first, args("rename \"Lab ESXi\" Lab"))),
        "Renamed Folder Lab ESXi to Lab"
    );
    let r = folder(&h, &first, args("remove esx-03 Night"));
    assert_eq!(echoed(&r), "Removed esx-03 from Night");
    assert_eq!(labels(section(&r)), ["Lab", "esx-02", "Night"]);
    assert_eq!(
        saved(&d),
        json!([{ "name": "Lab", "hosts": ["esx-02"] }, { "name": "Night", "hosts": {} }])
    );
    assert_eq!(
        echoed(&folder(&h, &first, args("delete Night"))),
        "Deleted Folder Night"
    );
    // Loaded again (a restart), the Folders are still there.
    let again = load(&h, json!({}));
    assert_eq!(labels(section(&again)), ["Lab", "esx-02"]);
    let spec = section(&again);
    assert_eq!(spec["rows"][0]["fold"], true);
    assert_eq!(spec["rows"][0]["icon"], "folder");
    assert_eq!(spec["rows"][0]["count"], 1);
    assert_eq!(spec["rows"][1]["kind"], "host");
    assert_eq!(spec["rows"][1]["host"], "esx-02");
    assert_eq!(spec["rows"][1]["drag_out"], "folder remove esx-02 Lab");
}

#[test]
fn without_a_name_it_opens_the_command_line_or_uses_the_cursor() {
    let d = data("cursor");
    let h = host(&d);
    let first = load(&h, json!({}));
    let r = folder(&h, &first, json!({ "args": "add", "words": ["add"], "host": "esx-02" }));
    assert_eq!(op(&r, "cmdline")[0]["text"], "folder add esx-02 ");
    let r = folder(&h, &first, args("new"));
    assert_eq!(op(&r, "cmdline")[0]["text"], "folder new ");
    folder(&h, &first, args("add esx-02 Lab"));
    // On the Host's row in the Folder: remove it from that Folder.
    let r = folder(
        &h,
        &first,
        json!({ "args": "remove", "words": ["remove"], "section": "folders", "row": "Lab/esx-02" }),
    );
    assert_eq!(echoed(&r), "Removed esx-02 from Lab");
    let r = folder(&h, &first, json!({ "args": "remove", "words": ["remove"] }));
    assert_eq!(
        echoed(&r),
        "Move to a Host in a Folder first, or use folder remove HOST NAME"
    );
    let r = folder(&h, &first, json!({ "args": "add", "words": ["add"] }));
    assert!(echoed(&r).starts_with("No Host selected"));
}

#[test]
fn it_completes_subcommands_hosts_and_folders() {
    let d = data("complete");
    let h = host(&d);
    let first = load(&h, json!({}));
    folder(&h, &first, args("add esx-02 Lab"));
    folder(&h, &first, args("new Night shift"));
    let id = op(&first, "command")[0]["complete"]["handler"].as_u64().unwrap();
    let complete = |arg: &str| h.call("folders", id, json!(arg)).result;
    assert_eq!(complete("re"), json!(["rename ", "remove "]));
    assert_eq!(complete("rename N"), json!(["rename \"Night shift\" "]));
    assert_eq!(complete("add esx"), json!(["add esx-02 ", "add esx-03 "]));
    assert_eq!(complete("add esx-02 "), json!(["add esx-02 Night shift"]));
    assert_eq!(complete("remove "), json!(["remove esx-02 "]));
    assert_eq!(complete("remove esx-02 "), json!(["remove esx-02 Lab"]));
}

#[test]
fn init_luas_folders_show_first_and_cant_be_changed_here() {
    let d = data("fixed");
    let h = host(&d);
    let config = json!({ "fixed": [{ "name": "Lab", "hosts": ["esx-03"], "source": "init.lua" }] });
    let first = load(&h, config.clone());
    folder(&h, &first, args("new Mine"));
    assert_eq!(
        echoed(&folder(&h, &first, args("add esx-02 lab"))),
        "Lab is defined in init.lua: change it there"
    );
    let r = folder(&h, &first, args("add esx-02 Mine"));
    let spec = section(&r);
    assert_eq!(labels(spec), ["Lab", "esx-03", "Mine", "esx-02"]);
    assert_eq!(spec["rows"][0]["note"], "from init.lua");
    assert!(spec["rows"][0]["actions"].is_null());
    assert_eq!(spec["count"], 2);
}

#[test]
fn folders_yml_is_moved_in_once_without_losing_a_host() {
    let d = data("migrate");
    let h = host(&d);
    let import = json!([
        { "name": "Lab ESXi", "hosts": ["esx-02", "esx-03", "gone-01"] },
        { "name": "Night shift", "hosts": [] },
    ]);
    let r = load(&h, json!({ "import": import, "import_from": "folders.yml" }));
    assert_eq!(
        labels(section(&r)),
        ["Lab ESXi", "esx-02", "esx-03", "gone-01", "Night shift"]
    );
    let notices: Vec<_> = op(&r, "notify")
        .iter()
        .map(|o| o["text"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(notices.len(), 1);
    assert!(
        notices[0].starts_with("Moved 2 Folders from folders.yml"),
        "{notices:?}"
    );
    assert_eq!(
        saved(&d),
        json!([{ "name": "Lab ESXi", "hosts": ["esx-02", "esx-03", "gone-01"] }, { "name": "Night shift", "hosts": {} }])
    );
    // A change after the move, then a restart that still finds folders.yml: it isn't moved again.
    folder(&h, &r, args("delete Night shift"));
    let again = load(
        &h,
        json!({ "import": [{ "name": "Old", "hosts": ["x"] }], "import_from": "folders.yml" }),
    );
    assert_eq!(labels(section(&again)), ["Lab ESXi", "esx-02", "esx-03", "gone-01"]);
    assert!(op(&again, "notify").is_empty());
    // And :check says folders.yml isn't read any more.
    let health = op(&again, "health")[0];
    let check = health["spec"]["check"]["handler"].as_u64().unwrap();
    let lines = h.call("folders", check, json!({ "health": "folders" })).result;
    assert!(
        lines.as_array().unwrap().iter().any(|l| l["level"] == "warn"
            && l["message"]
                .as_str()
                .unwrap()
                .contains("folders.yml is still in your config folder")),
        "{lines}"
    );
}

#[test]
fn a_folders_yml_that_doesnt_parse_moves_nothing_and_changes_nothing() {
    let d = data("migrate-broken");
    let h = host(&d);
    let r = load(
        &h,
        json!({ "import_error": "folders.yml:3 has an error (bad indentation)", "import_from": "folders.yml" }),
    );
    assert!(section(&r)["empty"].as_str().unwrap().contains("folders.yml:3"));
    let tried = folder(&h, &r, args("new Lab"));
    assert!(echoed(&tried).starts_with("Folders can't be changed until they can be read"));
    assert!(!d.join("plugin-data/folders/folders.json").exists());
    // Fixed, the next start moves it in.
    let r = load(
        &h,
        json!({ "import": [{ "name": "Lab", "hosts": ["esx-02"] }], "import_from": "folders.yml" }),
    );
    assert_eq!(labels(section(&r)), ["Lab", "esx-02"]);
}

#[test]
fn the_states_old_folders_are_moved_in_too() {
    let d = data("migrate-state");
    let h = host(&d);
    let r = load(
        &h,
        json!({ "import": [{ "name": "Old", "hosts": ["db-01"] }], "import_from": "the State" }),
    );
    assert_eq!(labels(section(&r)), ["Old", "db-01"]);
    assert_eq!(saved(&d), json!([{ "name": "Old", "hosts": ["db-01"] }]));
}

#[test]
fn a_dropped_host_goes_into_the_folder() {
    let d = data("drop");
    let h = host(&d);
    let first = load(&h, json!({}));
    let r = folder(&h, &first, args("new Lab"));
    let head = &section(&r)["rows"][0];
    let drop = head["drop"]["handler"].as_u64().unwrap();
    let section_drop = section(&r)["drop"]["handler"].as_u64().unwrap();
    let r = h.call(
        "folders",
        drop,
        json!({ "section": "folders", "row": "Lab", "dropped": "esx-02" }),
    );
    // Made in the user's own call (the drop), the line carries no mark (issue #183): the app
    // runs `:folder` as that call carried one hop, so it may answer on the message line.
    assert_eq!(
        op(&r, "cmd")[0],
        &json!({ "op": "cmd", "line": "folder add esx-02 Lab" })
    );
    // On the section: the command line asks which Folder.
    let drop = section_drop;
    let r = h.call("folders", drop, json!({ "section": "folders", "dropped": "esx-02" }));
    assert_eq!(op(&r, "cmdline")[0]["text"], "folder add esx-02 ");
    let folder_cmd = op(&first, "command")
        .into_iter()
        .find(|o| o["name"] == "folder")
        .unwrap()["run"]["handler"]
        .as_u64()
        .unwrap();
    let added = h.call_carried("folders", folder_cmd, args("add esx-02 Lab"));
    assert_eq!(echoed(&added), "Added esx-02 to Lab");
    assert_eq!(saved(&d), json!([{ "name": "Lab", "hosts": ["esx-02"] }]));
}

#[test]
fn revoked_it_still_works_without_checking_names() {
    let d = data("revoked");
    let h = host(&d);
    let (_, first) = h
        .load_with(&Source::Bundled("folders".into()), &[], &json!({}))
        .unwrap();
    assert!(first.error.is_none(), "{:?}", first.error);
    assert_eq!(
        echoed(&folder(&h, &first, args("add anything Lab"))),
        "Added anything to Lab"
    );
    let _ = h.event(Event {
        name: "inventory_changed".into(),
        payload: json!({}),
    });
}

#[test]
fn removing_it_isnt_possible_but_its_data_folder_is_its_own() {
    let d = data("own");
    let h = host(&d);
    let first = load(&h, json!({}));
    folder(&h, &first, args("new Lab"));
    assert!(d.join("plugin-data/folders/folders.json").is_file());
    assert!(!d.join("folders.yml").exists());
}

/// Its confirmations are quiet, as roster's own "Saved esx-02" (ticket 118): they follow
/// `ui.messages`. What went wrong and what it was asked show; so does the move from folders.yml,
/// a result that needs attention (ticket 117).
#[test]
fn its_confirmations_are_quiet_and_its_errors_are_not() {
    let d = data("quiet");
    let h = host(&d);
    let first = load(&h, json!({}));
    let quiet = |r: &Reply| {
        op(r, "echo")
            .iter()
            .map(|o| o["quiet"] == json!(true))
            .collect::<Vec<_>>()
    };
    assert_eq!(quiet(&folder(&h, &first, args("new Lab"))), [true]);
    assert_eq!(quiet(&folder(&h, &first, args("add esx-02 Lab"))), [true]);
    assert_eq!(quiet(&folder(&h, &first, args("add esx-02 Lab"))), [false]);
    assert_eq!(quiet(&folder(&h, &first, args("add nope-01 Lab"))), [false]);
    let d = data("quiet-import");
    let h = host(&d);
    let r = load(
        &h,
        json!({ "import": [{ "name": "Lab", "hosts": [] }], "import_from": "folders.yml" }),
    );
    assert_eq!(op(&r, "notify")[0]["quiet"], json!(false));
}
