//! The Plugin API's one source (`roster_core::plugin::api`, ticket 70, decision Q89) against what
//! a Plugin really gets: for every set of grants, the `roster` module has exactly the functions
//! and values api.rs declares for them, `roster.plugin` exactly the Plugin type's fields, and
//! the committed reference, stubs and data are what the generator writes.

mod common;

use roster_core::plugin::api::{self, Needs};
use roster_core::plugin::{Limits, Permission, PluginHost, Serve, Source};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

struct NoServe;

impl Serve for NoServe {
    fn call(&self, method: &str, _params: Value) -> Result<Value, String> {
        match method {
            "host.get" => Err("unknown host 'web-9' (code 2)".into()),
            _ => Ok(json!({})),
        }
    }
}

/// Lists every function and value in the `roster` module (one level into each module table),
/// and `roster.plugin`'s keys, and how an error reaches `pcall`.
const WALK: &str = r#"
local found, plugin = {}, {}
for k, v in pairs(roster) do
  if type(v) == "table" and k ~= "plugin" then
    for k2, v2 in pairs(v) do
      found[#found + 1] = "roster." .. k .. "." .. k2 .. (type(v2) == "function" and "()" or "")
    end
  else
    found[#found + 1] = "roster." .. k .. (type(v) == "function" and "()" or "")
  end
end
for k in pairs(roster.plugin) do plugin[#plugin + 1] = k end
table.sort(found)
table.sort(plugin)
local lua = table.concat({ _VERSION, tostring(3 // 2), math.type(1), tostring(5 & 3), type(coroutine), type(io),
  type(debug), type(package), type(bit), type(jit), type(os.execute), type(vim) }, " ")
local ok, err = pcall(roster.notify, "x", "loud")
local errors = (ok and "no error" or type(err)) .. " " .. tostring(err)
if roster.inventory and roster.inventory.host then
  local ok2, err2 = pcall(roster.inventory.host, "web-9")
  errors = errors .. "\n" .. tostring(ok2) .. " " .. tostring(err2)
end
roster.help.set("walk", { markdown = table.concat(found, "\n") .. "\n--\n" .. table.concat(plugin, "\n") .. "\n--\n" .. errors .. "\n--\n" .. lua })
"#;

fn plugin_dir(test: &str, permissions: &[&str]) -> common::Temp {
    let dir = common::temp(&format!("plugin-api-{test}"));
    let list: Vec<String> = permissions.iter().map(|p| format!("{p:?}")).collect();
    std::fs::write(
        dir.join("roster-plugin.lua"),
        format!(
            "return {{ name = \"walk\", version = \"1\", api = 2, permissions = {{ {} }} }}",
            list.join(", ")
        ),
    )
    .unwrap();
    std::fs::write(dir.join("init.lua"), WALK).unwrap();
    dir
}

/// What the runtime gives a Plugin granted `permissions`: (module entries, plugin keys, errors,
/// the Lua it runs).
fn walk(test: &str, permissions: &[&str]) -> (BTreeSet<String>, Vec<String>, String, String) {
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    let grants: Vec<Permission> = permissions.iter().map(|p| Permission::parse(p).unwrap()).collect();
    let folder = plugin_dir(test, permissions);
    let (_, reply) = host.load(&Source::Dir(folder.to_path_buf()), &grants).unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let text = reply.ops[0]["spec"]["markdown"].as_str().unwrap().to_string();
    let mut parts = text.split("\n--\n");
    let found = parts.next().unwrap().lines().map(String::from).collect();
    let plugin = parts.next().unwrap().lines().map(String::from).collect();
    let errors = parts.next().unwrap().to_string();
    (found, plugin, errors, parts.next().unwrap().to_string())
}

/// What api.rs says a Plugin granted `permissions` has.
fn declared(permissions: &[&str]) -> BTreeSet<String> {
    let serve = permissions.iter().any(|p| p.starts_with("serve:"));
    let network = permissions.iter().any(|p| p.starts_with("network:"));
    let mut out: BTreeSet<String> = api::VALUES.iter().map(|v| v.path.to_string()).collect();
    for f in api::FUNCTIONS {
        let has = match f.needs {
            Needs::Nothing => true,
            Needs::Permission(p) => permissions.contains(&p),
            Needs::AnyServe => serve,
            Needs::AnyNetwork => network,
            Needs::Hears(_) => f.needs.any_of().iter().any(|p| permissions.contains(p)),
        };
        if has {
            out.insert(format!("{}()", f.path));
        }
    }
    out
}

#[test]
fn the_runtime_exposes_exactly_what_the_api_declares_for_every_grant() {
    let sets: &[&[&str]] = &[
        &[],
        &["inventory.read"],
        &["inventory.write"],
        &["sessions.open"],
        &["terminal.read"],
        &["terminal.write"],
        &["serve:inventory.info"],
        &["network:api.example.com"],
        &[
            "inventory.read",
            "inventory.write",
            "sessions.open",
            "terminal.read",
            "terminal.write",
            "serve:hosts.list",
            "network:*.example.com",
        ],
    ];
    for (i, set) in sets.iter().enumerate() {
        let (found, _, _, _) = walk(&format!("grants{i}"), set);
        let want = declared(set);
        let extra: Vec<_> = found.difference(&want).collect();
        let missing: Vec<_> = want.difference(&found).collect();
        assert!(
            extra.is_empty() && missing.is_empty(),
            "with {set:?}, the runtime has {extra:?} that crates/roster-core/src/plugin/api.rs doesn't declare, and lacks {missing:?} that it does: add or remove them in api.rs, then run  {}",
            api::COMMAND
        );
    }
}

#[test]
fn roster_plugin_has_the_plugin_types_fields_and_errors_reach_pcall_as_strings() {
    let (_, plugin, errors, lua) = walk("plugin", &["inventory.read"]);
    // The reference's "The Lua": 5.4, integers, native bitwise operators, `coroutine` (api 3),
    // and the sandbox.
    assert_eq!(lua, "Lua 5.4 1 integer 1 table nil nil nil nil nil nil nil");
    let ty = api::TYPES.iter().find(|t| t.name == "Plugin").unwrap();
    let mut want: Vec<String> = ty.fields.iter().map(|f| f.name.to_string()).collect();
    want.sort();
    assert_eq!(plugin, want);
    // As the reference's Errors section says: a string, starting with the function.
    let mut lines = errors.lines();
    assert_eq!(
        lines.next().unwrap(),
        "string roster.notify: the level is \"info\", \"warn\" or \"error\""
    );
    // An unknown Host is `nil`, not an error (api 3).
    assert_eq!(lines.next().unwrap(), "true nil");
}

#[test]
fn the_committed_reference_stubs_and_data_are_what_the_generator_writes() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    for (path, text) in [
        (api::DOC_PATH, api::markdown()),
        (api::STUBS_PATH, api::stubs()),
        (api::JSON_PATH, api::json_text()),
    ] {
        let committed = std::fs::read_to_string(root.join(path)).unwrap_or_default();
        assert!(
            committed == text,
            "{path} is out of date with crates/roster-core/src/plugin/api.rs: run  {}",
            api::COMMAND
        );
    }
}

/// `roster.inventory.host` gives `nil` for an unknown name (as the reference says): the pinned
/// example's `:pin web-9` is a notice, not an error that counts against it.
#[test]
fn the_pinned_example_answers_an_unknown_host_with_a_notice() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins/pinned");
    let host = PluginHost::new(Arc::new(NoServe), Limits::default());
    let (_, reply) = host
        .load(&Source::Dir(dir), &[Permission::parse("inventory.read").unwrap()])
        .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    let pin = reply.ops.iter().find(|o| o["op"] == "command").unwrap();
    let r = host.call(
        "pinned",
        pin["run"]["handler"].as_u64().unwrap(),
        json!({ "args": "web-9", "words": ["web-9"] }),
    );
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(
        r.ops,
        [json!({ "op": "notify", "text": "pin: which Host? :pin HOST", "level": "warn" })]
    );
}
