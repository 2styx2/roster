//! A Plugin's folder is its own (tickets 82 and 61, decision Q93): every file of its code
//! (manifest, `init.lua`, the modules it `require`s) must really be inside its folder, after
//! symlinks (and, on Windows, junctions), and its data folder holds only what it wrote there,
//! through `roster.storage`, with no way out. These tests use temp folders only.

mod common;

use roster_core::plugin::{Limits, PluginHost, Serve, Source, read_manifest};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

struct NoServe;

impl Serve for NoServe {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        match method {
            "host.get" if params["name"] == "esx-02" => Ok(json!({ "name": "esx-02" })),
            "host.get" => Err("no Host by that name (code 2)".into()),
            _ => Err(format!("unknown method {method}")),
        }
    }
}

fn temp(test: &str) -> common::Temp {
    common::temp(&format!("pfolder-{test}"))
}

const MANIFEST: &str = r#"return { name = "boxed", version = "1.0.0", api = 3 }"#;

fn plugin(root: &Path, init: &str) -> PathBuf {
    let dir = root.join("boxed");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("roster-plugin.lua"), MANIFEST).unwrap();
    std::fs::write(dir.join("init.lua"), init).unwrap();
    dir
}

fn host() -> PluginHost {
    PluginHost::new(Arc::new(NoServe), Limits::default())
}

/// A host whose Plugins keep their data under `data`.
fn host_with_data(data: &Path) -> PluginHost {
    host().with_data(data)
}

#[cfg(unix)]
fn link(target: &Path, at: &Path) {
    std::os::unix::fs::symlink(target, at).unwrap();
}

#[cfg(windows)]
fn link(target: &Path, at: &Path) {
    // A symlink needs Developer Mode or admin on Windows; a junction (folders) doesn't. cmd's
    // mklink reads a `/` in a path (`plugin-data/boxed`) as a switch, so it gets backslashes.
    let win = |p: &Path| p.to_string_lossy().replace('/', "\\");
    if target.is_dir() {
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(win(at))
            .arg(win(target))
            .status()
            .unwrap()
            .success();
        assert!(ok, "mklink /J");
    } else if std::os::windows::fs::symlink_file(target, at).is_err() {
        eprintln!("skipped: this Windows can't make a file symlink");
    }
}

// ------------------------------------------------------------------ T82: the code's files

#[test]
fn an_init_lua_that_links_outside_the_folder_is_refused() {
    let root = temp("init-out");
    let secret = root.join("secret.lua");
    std::fs::write(&secret, "roster.notify('outside')").unwrap();
    let dir = plugin(&root, "");
    std::fs::remove_file(dir.join("init.lua")).unwrap();
    link(&secret, &dir.join("init.lua"));
    if !dir.join("init.lua").exists() {
        return;
    }
    let e = host().load(&Source::Dir(dir), &[]).unwrap_err();
    assert_eq!(e.file.as_deref(), Some("init.lua"));
    assert!(e.message.contains("outside the Plugin's folder"), "{e}");
}

#[test]
fn a_manifest_that_links_outside_the_folder_is_refused() {
    let root = temp("manifest-out");
    let elsewhere = root.join("other.lua");
    std::fs::write(&elsewhere, MANIFEST).unwrap();
    let dir = plugin(&root, "");
    std::fs::remove_file(dir.join("roster-plugin.lua")).unwrap();
    link(&elsewhere, &dir.join("roster-plugin.lua"));
    if !dir.join("roster-plugin.lua").exists() {
        return;
    }
    let e = read_manifest(&dir).unwrap_err();
    assert_eq!(e.file.as_deref(), Some("roster-plugin.lua"));
    assert!(e.message.contains("outside the Plugin's folder"), "{e}");
}

#[test]
fn a_module_that_links_outside_the_folder_is_refused() {
    let root = temp("module-out");
    std::fs::write(root.join("evil.lua"), "return { word = 'outside' }").unwrap();
    let dir = plugin(
        &root,
        r#"local ok, e = pcall(require, "boxed.evil") roster.notify(tostring(ok) .. " " .. tostring(e))"#,
    );
    std::fs::create_dir_all(dir.join("lua/boxed")).unwrap();
    link(&root.join("evil.lua"), &dir.join("lua/boxed/evil.lua"));
    if !dir.join("lua/boxed/evil.lua").exists() {
        return;
    }
    let (_, reply) = host().load(&Source::Dir(dir), &[]).unwrap();
    let text = reply.ops[0]["text"].as_str().unwrap();
    assert!(text.starts_with("false"), "{text}");
    assert!(text.contains("outside the Plugin's folder"), "{text}");
}

#[test]
fn a_modules_folder_that_links_outside_is_refused() {
    let root = temp("lua-dir-out");
    let outside = root.join("outside");
    std::fs::create_dir_all(outside.join("boxed")).unwrap();
    std::fs::write(outside.join("boxed/evil.lua"), "return 1").unwrap();
    let dir = plugin(
        &root,
        r#"local ok, e = pcall(require, "boxed.evil") roster.notify(tostring(e))"#,
    );
    // `lua/` itself is the link (a junction on Windows).
    link(&outside, &dir.join("lua"));
    let (_, reply) = host().load(&Source::Dir(dir), &[]).unwrap();
    let text = reply.ops[0]["text"].as_str().unwrap();
    assert!(text.contains("outside the Plugin's folder"), "{text}");
}

#[test]
fn a_link_that_stays_inside_the_folder_is_fine() {
    let root = temp("link-in");
    let dir = plugin(&root, "");
    std::fs::write(dir.join("real.lua"), r#"roster.notify("inside")"#).unwrap();
    std::fs::remove_file(dir.join("init.lua")).unwrap();
    link(&dir.join("real.lua"), &dir.join("init.lua"));
    if !dir.join("init.lua").exists() {
        return;
    }
    let (_, reply) = host().load(&Source::Dir(dir), &[]).unwrap();
    assert_eq!(reply.ops[0]["text"], "inside");
}

#[test]
fn a_require_with_dots_or_a_path_is_refused() {
    let root = temp("require-path");
    let dir = plugin(
        &root,
        r#"local out = {}
           for _, name in ipairs({ "..secret", "../secret", "/etc/passwd", "C:\\x", "a..b" }) do
             local ok = pcall(require, name)
             out[#out + 1] = tostring(ok)
           end
           roster.notify(table.concat(out, " "))"#,
    );
    let (_, reply) = host().load(&Source::Dir(dir), &[]).unwrap();
    assert_eq!(reply.ops[0]["text"], "false false false false false");
}

#[test]
fn the_shared_rule_says_whether_a_path_stays_inside() {
    use roster_core::plugin::folder::inside;
    let root = temp("rule");
    std::fs::create_dir_all(root.join("box/sub")).unwrap();
    std::fs::write(root.join("box/sub/a.lua"), "").unwrap();
    std::fs::write(root.join("outside.lua"), "").unwrap();
    let real_box = root.join("box").canonicalize().unwrap();
    assert_eq!(
        inside(&root.join("box"), Path::new("sub/a.lua")).unwrap(),
        real_box.join("sub/a.lua")
    );
    for bad in ["../outside.lua", "sub/../../outside.lua"] {
        let e = inside(&root.join("box"), Path::new(bad)).unwrap_err();
        assert!(e.contains("outside"), "{bad}: {e}");
    }
    let abs = root.join("outside.lua");
    assert!(inside(&root.join("box"), &abs).unwrap_err().contains("outside"));
}

// ------------------------------------------------------------------ T61: the data folder

fn storage_plugin(root: &Path, init: &str) -> (PluginHost, PathBuf, PathBuf) {
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let dir = plugin(root, init);
    (host_with_data(&data), dir, data)
}

fn said(reply: &roster_core::plugin::Reply) -> Vec<String> {
    assert!(reply.error.is_none(), "{:?}", reply.error);
    reply
        .ops
        .iter()
        .filter(|o| o["op"] == "notify")
        .map(|o| o["text"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_plugin_writes_reads_lists_and_removes_its_own_files() {
    let root = temp("storage-basic");
    let (host, dir, data) = storage_plugin(
        &root,
        r#"local s = roster.storage
           roster.notify(tostring(s.read("notes.txt")))
           s.write("notes.txt", "hello")
           s.write_json("state.json", { hosts = { "esx-02" }, n = 2 })
           roster.notify(s.read("notes.txt"))
           roster.notify(table.concat(s.list(), ","))
           local st = s.read_json("state.json")
           roster.notify(st.hosts[1] .. " " .. st.n)
           roster.notify(tostring(s.remove("notes.txt")) .. " " .. tostring(s.remove("notes.txt")))
           roster.notify(table.concat(s.list(), ","))"#,
    );
    let (_, reply) = host.load(&Source::Dir(dir), &[]).unwrap();
    assert_eq!(
        said(&reply),
        [
            "nil",
            "hello",
            "notes.txt,state.json",
            "esx-02 2",
            "true false",
            "state.json"
        ]
    );
    // In its own folder under the data folder, named after the Plugin.
    let saved = std::fs::read_to_string(data.join("plugin-data/boxed/state.json")).unwrap();
    let saved: Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(saved, json!({ "hosts": ["esx-02"], "n": 2 }));
}

#[test]
fn what_a_plugin_saved_is_there_when_it_loads_again() {
    let root = temp("storage-again");
    let (host, dir, _) = storage_plugin(
        &root,
        r#"local n = tonumber(roster.storage.read("count") or "0") + 1
           roster.storage.write("count", tostring(n))
           roster.notify(tostring(n))"#,
    );
    let (_, first) = host.load(&Source::Dir(dir.clone()), &[]).unwrap();
    let (_, second) = host.load(&Source::Dir(dir), &[]).unwrap();
    assert_eq!(said(&first), ["1"]);
    assert_eq!(said(&second), ["2"]);
}

#[test]
fn a_file_name_cant_leave_the_folder() {
    let root = temp("storage-names");
    let (host, dir, data) = storage_plugin(
        &root,
        r#"local out = {}
           for _, name in ipairs({ "../x", "..", ".", "a/b", "a\\b", "/etc/passwd", "C:x", "C:\\x",
                                   ".hidden", "", "con", "NUL.txt", "a:b", "x\0y", string.rep("a", 101) }) do
             local ok, e = pcall(roster.storage.write, name, "x")
             out[#out + 1] = ok and ("wrote " .. name) or e
           end
           roster.notify(table.concat(out, "\n"))"#,
    );
    let (_, reply) = host.load(&Source::Dir(dir), &[]).unwrap();
    let text = said(&reply).join("\n");
    assert!(!text.contains("wrote"), "{text}");
    assert_eq!(text.lines().count(), 15, "{text}");
    assert!(text.lines().all(|l| l.contains("roster.storage.write: ")), "{text}");
    // Nothing was written anywhere.
    let mut found = Vec::new();
    for e in walk(&root) {
        if e.starts_with(&data) && e.is_file() {
            found.push(e);
        }
    }
    assert!(found.is_empty(), "{found:?}");
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        out.push(p.clone());
        if p.is_dir() && !p.is_symlink() {
            out.extend(walk(&p));
        }
    }
    out
}

#[test]
fn a_link_in_the_data_folder_is_never_followed() {
    let root = temp("storage-link");
    let outside = root.join("outside.txt");
    std::fs::write(&outside, "keep me").unwrap();
    let (host, dir, data) = storage_plugin(
        &root,
        r#"local r = {}
           r[#r + 1] = select(2, pcall(roster.storage.read, "leak.txt"))
           r[#r + 1] = select(2, pcall(roster.storage.write, "leak.txt", "overwritten"))
           r[#r + 1] = select(2, pcall(roster.storage.remove, "leak.txt"))
           roster.notify(table.concat(r, "\n"))"#,
    );
    let own = data.join("plugin-data/boxed");
    std::fs::create_dir_all(&own).unwrap();
    link(&outside, &own.join("leak.txt"));
    if std::fs::symlink_metadata(own.join("leak.txt")).is_err() {
        return;
    }
    let (_, reply) = host.load(&Source::Dir(dir), &[]).unwrap();
    let text = said(&reply).join("\n");
    assert_eq!(text.matches("is a link").count(), 3, "{text}");
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep me");
}

#[test]
fn a_data_folder_that_is_a_link_is_never_used() {
    let root = temp("storage-dir-link");
    let elsewhere = root.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let (host, dir, data) = storage_plugin(
        &root,
        r#"roster.notify(select(2, pcall(roster.storage.write, "a.txt", "x")))"#,
    );
    std::fs::create_dir_all(data.join("plugin-data")).unwrap();
    // The Plugin's own folder is a link (a junction on Windows) to somewhere else.
    link(&elsewhere, &data.join("plugin-data/boxed"));
    let (_, reply) = host.load(&Source::Dir(dir), &[]).unwrap();
    let text = said(&reply).join("\n");
    assert!(text.contains("is a link"), "{text}");
    assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());
}

#[test]
fn a_write_over_the_size_cap_is_refused_whole() {
    let root = temp("storage-cap");
    let (host, dir, data) = storage_plugin(
        &root,
        r#"roster.storage.write("big", "small")
           local ok, e = pcall(roster.storage.write, "big", string.rep("x", 600 * 1024) .. string.rep("y", 500 * 1024))
           roster.notify(tostring(ok) .. " " .. e)
           roster.notify(roster.storage.read("big"))"#,
    );
    let (_, reply) = host.load(&Source::Dir(dir), &[]).unwrap();
    let said = said(&reply);
    assert!(said[0].starts_with("false roster.storage.write: "), "{said:?}");
    assert!(said[0].contains("at most 1 MB"), "{said:?}");
    // The old content is still whole: a write is all or nothing.
    assert_eq!(said[1], "small");
    let names: Vec<_> = std::fs::read_dir(data.join("plugin-data/boxed"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, ["big"], "no temporary file left behind");
}

#[test]
fn a_plugins_folder_holds_at_most_ten_megabytes() {
    let root = temp("storage-total");
    let (host, dir, _) = storage_plugin(
        &root,
        r#"local chunk = string.rep("x", 1000 * 1000)
           local wrote = 0
           for i = 1, 12 do
             local ok, e = pcall(roster.storage.write, "f" .. i, chunk)
             if not ok then roster.notify(e) break end
             wrote = i
           end
           roster.notify(tostring(wrote))
           -- Replacing a file counts only its new size.
           roster.storage.write("f1", "x")
           roster.notify(tostring(pcall(roster.storage.write, "f11", chunk)))"#,
    );
    let (_, reply) = host
        .load(&Source::Dir(dir), &[])
        .map(|(m, mut r)| {
            r.error = None;
            (m, r)
        })
        .unwrap();
    let said = said(&reply);
    assert!(said[0].contains("at most 10 MB"), "{said:?}");
    assert_eq!(said[1], "10");
    assert_eq!(said[2], "true");
}

#[test]
fn json_that_isnt_data_is_an_error_naming_the_file() {
    let root = temp("storage-json");
    let (host, dir, data) = storage_plugin(
        &root,
        r#"roster.notify(select(2, pcall(roster.storage.read_json, "broken.json")))
           roster.notify(select(2, pcall(roster.storage.write_json, "f.json", { run = function() end })))
           roster.notify(tostring(roster.storage.read_json("missing.json")))"#,
    );
    std::fs::create_dir_all(data.join("plugin-data/boxed")).unwrap();
    std::fs::write(data.join("plugin-data/boxed/broken.json"), "{ nope").unwrap();
    let (_, reply) = host.load(&Source::Dir(dir), &[]).unwrap();
    let said = said(&reply);
    assert!(
        said[0].starts_with("roster.storage.read_json: broken.json isn't JSON"),
        "{said:?}"
    );
    assert!(said[1].starts_with("roster.storage.write_json: "), "{said:?}");
    assert_eq!(said[2], "nil");
}

#[test]
fn without_a_data_folder_storage_says_so() {
    let root = temp("storage-none");
    let dir = plugin(&root, r#"roster.notify(select(2, pcall(roster.storage.read, "a")))"#);
    let (_, reply) = host().load(&Source::Dir(dir), &[]).unwrap();
    assert!(said(&reply)[0].contains("no data folder"));
}

#[test]
fn forgetting_a_plugin_removes_its_data_folder_and_nothing_else() {
    let root = temp("storage-forget");
    let (host, dir, data) = storage_plugin(&root, r#"roster.storage.write("a", "x")"#);
    host.load(&Source::Dir(dir), &[]).unwrap();
    std::fs::create_dir_all(data.join("plugin-data/other")).unwrap();
    std::fs::write(data.join("plugin-data/other/keep"), "x").unwrap();
    assert!(host.forget("boxed").unwrap());
    assert!(!data.join("plugin-data/boxed").exists());
    assert!(data.join("plugin-data/other/keep").exists());
    assert!(!host.forget("boxed").unwrap(), "nothing left to remove");
    // A name that isn't a Plugin's can't reach anything else.
    for bad in ["..", "../data", "", "a/b", "."] {
        assert!(host.forget(bad).is_err(), "{bad}");
    }
    assert!(data.join("plugin-data/other/keep").exists());
}

#[test]
fn forgetting_a_data_folder_that_is_a_link_removes_only_the_link() {
    let root = temp("storage-forget-link");
    let elsewhere = root.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::write(elsewhere.join("keep"), "x").unwrap();
    let data = root.join("data");
    std::fs::create_dir_all(data.join("plugin-data")).unwrap();
    link(&elsewhere, &data.join("plugin-data/boxed"));
    let host = host_with_data(&data);
    assert!(host.forget("boxed").unwrap());
    assert!(elsewhere.join("keep").exists());
    assert!(std::fs::symlink_metadata(data.join("plugin-data/boxed")).is_err());
}

#[test]
fn the_types_file_is_never_written_through_a_link() {
    let root = temp("types-link");
    let outside = root.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let dir = plugin(&root, "");
    link(&outside, &dir.join("types"));
    let e = roster_core::plugin::api::write_stubs(&dir).unwrap_err();
    assert!(e.contains("is a link"), "{e}");
    assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
}

// ------------------------------------------------------------------ T98: how full it is

#[test]
fn a_data_folders_size_and_file_count_are_what_the_caps_count() {
    use roster_core::plugin::folder::DataUse;
    let root = temp("usage");
    let (host, dir, data) = storage_plugin(
        &root,
        r#"roster.storage.write("a.txt", "hello")
           roster.storage.write("b.json", string.rep("x", 2000))"#,
    );
    // Nothing written yet: no folder, no data.
    assert_eq!(host.data_use("boxed"), DataUse::None);
    host.load(&Source::Dir(dir), &[]).unwrap();
    assert_eq!(host.data_use("boxed"), DataUse::Used { files: 2, bytes: 2005 });
    // Another Plugin's folder, or one by no Plugin's name, is not this one's.
    assert_eq!(host.data_use("other"), DataUse::None);
    assert!(matches!(host.data_use("../data"), DataUse::Problem { .. }));
    // A link in it is never followed (nor counted as what it leads to).
    let big = root.join("big.bin");
    std::fs::write(&big, vec![0u8; 50_000]).unwrap();
    link(&big, &data.join("plugin-data/boxed/big.bin"));
    assert_eq!(host.data_use("boxed"), DataUse::Used { files: 2, bytes: 2005 });
    // The data folder itself a link: not followed, and said so.
    let elsewhere = root.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    link(&elsewhere, &data.join("plugin-data/linked"));
    match host.data_use("linked") {
        DataUse::Problem { message } => assert!(message.contains("is a link"), "{message}"),
        other => panic!("{other:?}"),
    }
    // A host with no data folder at all: no data.
    assert_eq!(
        PluginHost::new(Arc::new(NoServe), Limits::default()).data_use("boxed"),
        DataUse::None
    );
}

#[test]
fn data_use_serialises_as_the_frontend_reads_it() {
    use roster_core::plugin::folder::DataUse;
    assert_eq!(serde_json::to_value(DataUse::None).unwrap(), json!({ "state": "none" }));
    assert_eq!(
        serde_json::to_value(DataUse::Used { files: 3, bytes: 10 }).unwrap(),
        json!({ "state": "used", "files": 3, "bytes": 10 })
    );
    assert_eq!(
        serde_json::to_value(DataUse::Problem { message: "x".into() }).unwrap(),
        json!({ "state": "problem", "message": "x" })
    );
}
