//! The generators: what the API's tables are written out as: the reference (`docs/plugin-api.md`), the LuaCATS
//! stubs, the data (`plugin-api.json`), and the app's module of the host's own tables.

use super::*;
use serde_json::{Value as Json, json};

/// Which Lua, for authors coming from Neovim.
const LUA_DOC: &str = "roster embeds **Lua 5.4** (built into the app, nothing to install), not LuaJIT as Neovim does; [why](adr/0006-lua-plugins-and-packages.md#why-lua-54-not-luajit). Coming from Neovim:

- Integers are real 64-bit integers (`3 // 2` is `1`, `math.type(1)` is `\"integer\"`), and the bitwise operators are native (`a & b`, `a | b`, `~a`, `a << 2`): there's no `bit` library.
- `goto`, `<const>` and `<close>` locals work; there's no `jit` and no FFI.
- The API is `roster.*`, never `vim.*`: there's no `vim.api`, `vim.fn`, `vim.loop` or `vim.schedule`.
- It runs in the [sandbox](app/config.md#the-sandbox): the base functions, `string`, `table`, `math`, `utf8` and an `os` with only `time`, `clock`, `date` and `difftime`. `coroutine` too (since api 3: a coroutine runs within the same time budget and memory limit). No `io`, no `os.execute`, no `debug`, no `package` and no C modules; `load` takes text only, and `require` loads only from the Plugin's own folder (`name.lua`, `name/init.lua`, or the same under `lua/`).
- `pairs` visits a table's keys in order: numbers, then text, then the rest. So the same state always makes the same changes in the same order, on every machine; `next` is Lua's own.
- An empty table is `{}` to the app, whether you meant a list or a table of fields: the app takes `{}` as an empty list wherever it wants one (`rows = {}`, `items = {}`).
- It runs on a thread of its own with a memory limit and a time budget per call: see [Limits](plugins.md#limits).";

/// The errors any function can raise, and what a call that fails does.
const ERRORS_DOC: &str = "A function that fails raises a Lua error: `pcall` catches it, with the message as a string. The message starts with the function (`roster.inventory.host: unknown host 'web-9' (code 2)`); a roster serve error ends with its code, from [serve-api.md's tables](serve-api.md). An error you don't catch stops the call: a notice names the Plugin, file and line (`pinned: init.lua:12: …`), the UI changes that call made are dropped, and the third such error after loading stops the Plugin.

Any function can also raise:

- Lua's own `bad argument` error, for an argument of the wrong kind (a number where a table goes);
- `roster.sidebar.set: PATH: a table that mixes a list with named keys (or has gaps): use one or the other`, `roster.float.open: PATH: a thread can't be a Plugin value` and the like, for data that can't be handed over (the function, then `PATH`, where in your table: `rows.3.label`). A function's return value that can't be is `the value it returned: PATH: …`;
- `more than 1000 UI changes in one go`, when one call sets more than that;
- `more than 10000 functions handed to roster at once`.

**Refused by the app** isn't an error: the app shows a warning notice naming the Plugin (`pinned: :pin is taken (builtin)`) and leaves that one change out. The call itself goes on.

**What the Plugin added** (api 5): each collection (`roster.commands`, `roster.keymap`, `roster.themes`, `roster.sidebar`, `roster.views`, `roster.badges` by Host, …) has `get`, `has` and `list`, which give only the Plugin's own, as it set them; `get` gives a copy, so changing it changes nothing until you set it again. Taking away what the Plugin never added (or already took away) is an error at your line, as in `init.lua` (`roster.status.remove: the Plugin has no status segment \"alerts\" (roster.status.list() names its own)`), and so is a key context that isn't one. A Plugin whose manifest says `api = 4` or older keeps what it was written against: such a removal does nothing.";

// ---------------------------------------------------------------- the reference

pub const DOC_PATH: &str = "docs/plugin-api.md";
pub const STUBS_PATH: &str = "examples/plugins/types/roster.lua";
pub const JSON_PATH: &str = "crates/roster-core/tests/fixtures/plugin-api.json";
/// [`runtime`] as TypeScript, for the app and its fake Backend (`as const`, so its names are types).
pub const TS_PATH: &str = "app/src/plugins/core.gen.ts";
pub const COMMAND: &str = "cargo run -p roster-core --example gen_plugin_api";

fn functions_of(module: &str) -> impl Iterator<Item = &'static Function> + '_ {
    functions().filter(move |f| module_of(f.path) == module)
}

/// docs/plugin-api.md.
pub fn markdown() -> String {
    let mut s = String::new();
    s.push_str("# The Plugin API\n\n");
    s.push_str(&format!(
        "<!-- Generated from crates/roster-core/src/plugin/api/ by `{COMMAND}`: edit that, then run it. -->\n\n"
    ));
    s.push_str(&format!(
        "Every function, value, event and data type of the `roster` Lua module a Plugin gets, `roster.api_version` {}. How to write, install and trust a Plugin is the guide, [Writing a Plugin](plugins.md); this is the reference. Each entry is a help topic: `:help roster.inventory.host()` for a function, `:help roster-Host` for a type.\n\n",
        crate::plugin::API_VERSION
    ));
    s.push_str("Types are written as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations write them: `string?` may be `nil`, `Host[]` is a list of Hosts, `table<string, Group>` a table of Groups by name, `\"info\"|\"warn\"` one of those strings. The same declarations are [`roster.lua`](../examples/plugins/types/roster.lua), for [your editor](#editor-support).\n\n");

    s.push_str("## The Lua\n\n");
    s.push_str(LUA_DOC);
    s.push_str("\n\n");
    s.push_str("## Index\n\n| Function | What it does | Permission |\n|---|---|---|\n");
    for v in VALUES {
        s.push_str(&format!(
            "| [`{}`](#{}) | {} | none |\n",
            v.path,
            slug(&format!("`{}`", v.path)),
            cell(v.summary)
        ));
    }
    for m in MODULES {
        for func in functions_of(m.name) {
            s.push_str(&format!(
                "| [`{}`](#{}) | {} | {} |\n",
                signature(func),
                func_anchor(func),
                cell(func.summary),
                func.needs.text()
            ));
        }
    }
    s.push_str("\n| Type | What it is |\n|---|---|\n");
    for t in TYPES {
        s.push_str(&format!("| {} | {} |\n", md_type(t.name), cell(t.summary)));
    }
    s.push('\n');

    s.push_str("## Errors\n\n");
    s.push_str(ERRORS_DOC);
    s.push_str("\n\n");

    for m in MODULES {
        s.push_str(&format!("## `{}`\n\n{}.", m.name, m.summary));
        if !m.doc.is_empty() {
            s.push(' ');
            s.push_str(m.doc);
        }
        s.push_str("\n\n");
        if m.name == "roster" {
            for v in VALUES {
                s.push_str(&format!("### `{}`\n\n{}.", v.path, v.summary));
                if !v.doc.is_empty() {
                    s.push(' ');
                    s.push_str(v.doc);
                }
                s.push_str(&format!(
                    "\n\n**Type:** {}\n\n**Permission:** none · **Since:** api {}\n\n**Example**\n\n```lua\n{}\n```\n\n",
                    md_type(v.ty),
                    v.since,
                    v.example
                ));
            }
        }
        for func in functions_of(m.name) {
            function_entry(&mut s, func);
        }
    }

    s.push_str("## Events\n\n`roster.on(event, function(e) … end)` runs the function with the event's payload. Listening for an event the Plugin may not hear is an error. Each needs any one of the permissions listed.\n\n| Event | When | Payload | Needs |\n|---|---|---|---|\n");
    for e in EVENTS {
        let needs = if e.needs.is_empty() {
            "nothing".to_string()
        } else {
            e.needs
                .iter()
                .map(|p| format!("`{p}`"))
                .collect::<Vec<_>>()
                .join(" or ")
        };
        s.push_str(&format!(
            "| `{}` | {} | {} | {} |\n",
            e.name,
            cell(e.when),
            md_type(e.payload),
            needs
        ));
    }
    s.push('\n');

    s.push_str("## Command lines a Plugin may run\n\n`roster.cmd(line)`, and a `run` that's a command line (a row's, a button's, a finder item's, a toolbar control's), run the Plugin's own commands and only these of roster's, each with what it needs. Anything else is refused: `roster.cmd` raises an error, and a button that would run it says why in a notice instead.\n\n| Command | What it does | Needs |\n|---|---|---|\n");
    for c in COMMANDS {
        s.push_str(&format!("| `{}` | {} | {} |\n", c.name, cell(c.doc), c.needs.text()));
    }
    s.push('\n');

    s.push_str("## roster serve's results\n\nWhat `roster.serve.call(method)` returns, for the methods a Plugin may be granted. JSON `null` is `nil`.\n\n| Method | Result | In serve-api.md |\n|---|---|---|\n");
    for r in SERVE_RESULTS {
        let result = if r.result.is_empty() {
            "see serve-api.md".to_string()
        } else {
            md_type(r.result)
        };
        s.push_str(&format!(
            "| `{}` | {} | [{}]({}) |\n",
            r.method, result, r.method, r.link
        ));
    }
    s.push('\n');

    s.push_str("## Types\n\n");
    for t in TYPES {
        type_entry(&mut s, t);
    }

    s.push_str("## Editor support\n\n");
    s.push_str(&format!("[`{STUBS_PATH}`](../{STUBS_PATH}) declares all of the above as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations (`---@meta`), so [lua-language-server](https://luals.github.io/) completes `roster.` and checks your types, the way Neovim's `vim` annotations do. `:help plugin-types` shows it in the app. Copy it into your Plugin's folder as `types/roster.lua` (or anywhere), and point lua-language-server at it with a `.luarc.json` next to `init.lua`:\n\n```json\n{{\n  \"runtime.version\": \"Lua 5.4\",\n  \"workspace.library\": [\"types\"],\n  \"diagnostics.globals\": [\"roster\"]\n}}\n```\n\nThen annotate what you hand the app, and lua-language-server checks it:\n\n```lua\n---@type roster.Row[]\nlocal rows = {{}}\n\n---@param e roster.TerminalOutputEvent\nroster.on(\"terminal_output\", function(e) … end)\n```\n\n`lua-language-server --check .` does the same from a terminal or CI; roster's CI checks the example Plugins that way. The file is generated with this page: a copy from an older roster lacks what's new.\n\n"));
    s.push_str("## See also\n\n[Writing a Plugin](plugins.md) · [The roster serve API](serve-api.md) · [Your init.lua](app/config.md) · [How far roster bends](app/extending.md)\n");
    s
}

fn function_entry(s: &mut String, func: &Function) {
    s.push_str(&format!("### `{}`\n\n{}.", signature(func), func.summary));
    if !func.doc.is_empty() {
        s.push(' ');
        s.push_str(func.doc);
    }
    s.push_str("\n\n**Parameters**\n\n");
    if func.params.is_empty() {
        s.push_str("None.\n\n");
    } else {
        for p in func.params {
            let ty = md_type(&format!("{}{}", p.ty, if p.optional { "?" } else { "" }));
            s.push_str(&format!(
                "- `{}` ({}{}): {}\n",
                p.name,
                ty.replace("\\|", "|"),
                if p.optional { ", optional" } else { "" },
                p.doc
            ));
        }
        s.push('\n');
    }
    s.push_str("**Returns**\n\n");
    if func.returns.0.is_empty() {
        s.push_str("Nothing.\n\n");
    } else {
        s.push_str(&format!(
            "- {}: {}\n\n",
            md_type(func.returns.0).replace("\\|", "|"),
            func.returns.1
        ));
    }
    s.push_str("**Errors**\n\n");
    if func.errors.is_empty() {
        s.push_str("Only [those of every function](#errors).\n\n");
    } else {
        for (message, when) in func.errors {
            s.push_str(&format!("- `{message}`: {when}.\n"));
        }
        s.push_str("- And [those of every function](#errors).\n\n");
    }
    if !func.refused.is_empty() {
        s.push_str("**Refused by the app** (a warning notice, not an error)\n\n");
        for r in func.refused {
            s.push_str(&format!("- {r}.\n"));
        }
        s.push('\n');
    }
    s.push_str(&format!(
        "**Permission:** {} · **Since:** api {}\n\n**Example**\n\n```lua\n{}\n```\n\n",
        func.needs.text(),
        func.since,
        func.example
    ));
}

fn type_entry(s: &mut String, t: &Type) {
    s.push_str(&format!("### `{}`\n\n{}.", t.name, t.summary));
    if !t.doc.is_empty() {
        s.push_str("\n\n");
        s.push_str(t.doc);
    }
    s.push_str("\n\n");
    if !t.alias.is_empty() {
        s.push_str(&format!("One of: {}\n\n", md_type(t.alias).replace("\\|", " \\| ")));
        return;
    }
    if t.fields.is_empty() {
        s.push_str("No fields.\n\n");
        return;
    }
    s.push_str("| Field | Type | Required | Description |\n|---|---|---|---|\n");
    for fl in t.fields {
        s.push_str(&format!(
            "| `{}` | {} | {} | {} |\n",
            fl.name,
            md_type(fl.ty),
            if fl.required { "yes" } else { "no" },
            cell(fl.doc)
        ));
    }
    s.push('\n');
}

// ---------------------------------------------------------------- the stubs

fn comment_lines(text: &str) -> String {
    text.lines().map(|l| format!("--- {l}\n")).collect()
}

/// Plain text for a stub's comment: Markdown links reduced to their text.
fn plain(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let Some(mid) = rest[open..].find("](") else { break };
        let Some(close) = rest[open + mid..].find(')') else {
            break;
        };
        out.push_str(&rest[..open]);
        out.push_str(&rest[open + 1..open + mid]);
        rest = &rest[open + mid + close + 1..];
    }
    out.push_str(rest);
    out.replace('\n', " ")
}

/// examples/plugins/types/roster.lua.
pub fn stubs() -> String {
    let mut s = String::new();
    s.push_str("---@meta roster\n");
    s.push_str(&format!(
        "-- roster's Plugin API, roster.api_version {}: LuaCATS annotations for lua-language-server.\n-- Generated from crates/roster-core/src/plugin/api/ by `{COMMAND}`; don't edit.\n-- The reference: docs/plugin-api.md (`:help plugin-api`).\n\n",
        crate::plugin::API_VERSION
    ));
    for t in TYPES {
        if !t.alias.is_empty() {
            s.push_str(&comment_lines(&plain(t.summary)));
            s.push_str(&format!("---@alias roster.{} {}\n\n", t.name, lua_type(t.alias)));
            continue;
        }
        s.push_str(&comment_lines(&plain(t.summary)));
        s.push_str(&format!("---@class roster.{}\n", t.name));
        for fl in t.fields {
            let doc = plain(fl.doc);
            if fl.name.starts_with('[') {
                s.push_str(&format!("---@field {} {} {doc}\n", fl.name, lua_type(fl.ty)));
            } else {
                let q = if fl.required { "" } else { "?" };
                s.push_str(&format!("---@field {}{q} {} {doc}\n", fl.name, lua_type(fl.ty)));
            }
        }
        if t.open {
            s.push_str("---@field [string] any Any other key roster.yml gives it.\n");
        }
        s.push('\n');
    }
    s.push_str("---@class roster.module\n");
    for v in VALUES {
        let name = v.path.trim_start_matches("roster.");
        s.push_str(&format!("---@field {name} {} {}\n", lua_type(v.ty), plain(v.summary)));
    }
    s.push_str("roster = {}\n\n");
    for m in MODULES {
        if m.name != "roster" {
            s.push_str(&comment_lines(&plain(&format!("{}. {}", m.summary, m.doc))));
            s.push_str(&format!("{} = {{}}\n\n", m.name));
        }
        for func in functions_of(m.name) {
            s.push_str(&comment_lines(&plain(&format!("{}.", func.summary))));
            s.push_str(&format!(
                "--- Permission: {}. Since: api {}.\n",
                func.needs.text().replace('`', ""),
                func.since
            ));
            for p in func.params {
                let q = if p.optional { "?" } else { "" };
                s.push_str(&format!(
                    "---@param {}{q} {} {}\n",
                    p.name,
                    lua_type(p.ty),
                    plain(p.doc)
                ));
            }
            if !func.returns.0.is_empty() {
                s.push_str(&format!(
                    "---@return {} # {}\n",
                    lua_type(func.returns.0),
                    plain(func.returns.1)
                ));
            }
            if func.path == "roster.on" {
                // Each event's own payload type, for completion inside the listener.
                for e in EVENTS {
                    s.push_str(&format!(
                        "---@overload fun(event: \"{}\", listener: fun(e: {}))\n",
                        e.name,
                        lua_type(e.payload)
                    ));
                }
            }
            let names: Vec<&str> = func.params.iter().map(|p| p.name).collect();
            s.push_str(&format!("function {}({}) end\n\n", func.path, names.join(", ")));
        }
    }
    s.push_str("return roster\n");
    s
}

// ---------------------------------------------------------------- the data

/// `:plugins types PATH` (ticket 74): writes [`stubs`] for this app's API as `types/roster.lua` in
/// the Plugin folder `dir`, over an older copy, and gives where. `dir` must exist.
pub fn write_stubs(dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if !dir.is_dir() {
        return Err(format!("{} isn't a folder", dir.display()));
    }
    let types = dir.join("types");
    let file = types.join("roster.lua");
    // Never through a link out of the Plugin's folder (ticket 82): `types` or the file itself.
    for p in [&types, &file] {
        if std::fs::symlink_metadata(p).is_ok_and(|m| crate::plugin::folder::is_link(&m)) {
            return Err(format!("{} is a link: roster won't write through it", p.display()));
        }
    }
    std::fs::create_dir_all(&types).map_err(|e| format!("{}: {e}", types.display()))?;
    std::fs::write(&file, stubs()).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(file)
}

/// crates/roster-core/tests/fixtures/plugin-api.json: the API as data, and the help topics. It
/// carries what [`stubs`] and [`markdown`] read (each summary and doc, the types' order, the
/// modules, examples, errors, the events' and commands' text, serve's results, the Lua and Errors
/// sections), so the app makes `:help plugin-types` (app/src/help/luaStubs.ts, T213, decision Q189)
/// and `:help plugin-api` (app/src/help/pluginApiDoc.ts, T228) from it rather than bundling
/// roster.lua and plugin-api.md too.
pub fn json() -> Json {
    let mut tags = serde_json::Map::new();
    for v in VALUES {
        tags.insert(
            v.path.into(),
            json!(format!("plugin-api#{}", slug(&format!("`{}`", v.path)))),
        );
    }
    for func in functions() {
        tags.insert(
            format!("{}()", func.path),
            json!(format!("plugin-api#{}", func_anchor(func))),
        );
    }
    for t in TYPES {
        tags.insert(
            format!("roster-{}", t.name),
            json!(format!("plugin-api#{}", slug(&format!("`{}`", t.name)))),
        );
    }
    for m in MODULES.iter().filter(|m| m.name != "roster") {
        tags.insert(
            m.name.into(),
            json!(format!("plugin-api#{}", slug(&format!("`{}`", m.name)))),
        );
    }
    let functions: Vec<Json> = functions()
        .map(|func| {
            json!({
                "path": func.path,
                "params": func.params.iter().map(|p| json!({ "name": p.name, "type": p.ty, "optional": p.optional, "doc": p.doc })).collect::<Vec<_>>(),
                "returns": func.returns.0,
                "returns_doc": func.returns.1,
                "summary": func.summary,
                "needs_text": func.needs.text(),
                "permission": match func.needs { Needs::Nothing => Json::Null, Needs::Permission(p) => json!(p), Needs::AnyServe => json!("serve:*"), Needs::AnyNetwork => json!("network:*"), Needs::Hears(_) => json!(func.needs.any_of()) },
                "since": func.since,
                "doc": func.doc,
                "errors": func.errors.iter().map(|(message, when)| json!([message, when])).collect::<Vec<_>>(),
                "refused": func.refused,
                "example": func.example,
            })
        })
        .collect();
    let types: serde_json::Map<String, Json> = TYPES
        .iter()
        .enumerate()
        .map(|(order, t)| {
            let value = if t.alias.is_empty() {
                json!({ "fields": t.fields.iter().map(|fl| json!({ "name": fl.name, "type": fl.ty, "required": fl.required, "doc": fl.doc })).collect::<Vec<_>>(), "open": t.open, "summary": t.summary, "doc": t.doc, "order": order })
            } else {
                json!({ "alias": t.alias, "summary": t.summary, "doc": t.doc, "order": order })
            };
            (t.name.to_string(), value)
        })
        .collect();
    json!({
        "api_version": crate::plugin::API_VERSION,
        "values": VALUES.iter().map(|v| json!({ "path": v.path, "type": v.ty, "summary": v.summary, "doc": v.doc, "since": v.since, "example": v.example })).collect::<Vec<_>>(),
        "modules": MODULES.iter().map(|m| json!({ "name": m.name, "summary": m.summary, "doc": m.doc })).collect::<Vec<_>>(),
        "functions": functions,
        "events": EVENTS.iter().map(|e| json!({ "name": e.name, "needs": e.needs, "payload": e.payload, "when": e.when })).collect::<Vec<_>>(),
        "commands": COMMANDS.iter().map(|c| json!({ "name": c.name, "permission": match c.needs { Needs::Permission(p) => json!(p), _ => Json::Null }, "doc": c.doc, "needs_text": c.needs.text() })).collect::<Vec<_>>(),
        "roster_only": ROSTER_ONLY,
        "serve_results": SERVE_RESULTS.iter().map(|r| json!({ "method": r.method, "result": r.result, "link": r.link })).collect::<Vec<_>>(),
        "runtime": runtime(),
        "lua_doc": LUA_DOC,
        "errors_doc": ERRORS_DOC,
        "types": types,
        "tags": tags,
    })
}

/// The JSON file's text, as committed.
pub fn json_text() -> String {
    serde_json::to_string_pretty(&json()).expect("plain data") + "\n"
}

/// What the Plugin host itself decides, besides the API's declarations, that the app and its fake
/// Backend must agree with: the events and who hears them, the limits a Plugin meets, the
/// permissions' words, the ops and their fields ([`crate::plugin::op`]), the built-in Plugins and the
/// paths that name them.
pub fn runtime() -> Json {
    use crate::plugin::{permission, runtime as rt};
    json!({
        "events": EVENTS.iter().map(|e| json!({ "name": e.name, "needs": e.needs })).collect::<Vec<_>>(),
        "job_kinds": rt::JOB_KINDS.iter().map(|(k, p)| (k.to_string(), json!(p))).collect::<serde_json::Map<_, _>>(),
        "key_contexts": rt::KEY_CONTEXTS,
        "complete_api": rt::COMPLETE_API,
        "limits": {
            "max_serve_requests": rt::MAX_SERVE_REQUESTS,
            "max_timers": rt::MAX_TIMERS,
            "defer_min_ms": rt::DEFER_MIN_MS,
            "every_min_ms": rt::EVERY_MIN_MS,
            "timer_max_ms": rt::TIMER_MAX_MS,
            "max_copy": rt::MAX_COPY,
            "max_ops": rt::MAX_OPS,
            "strikes": crate::plugin::Limits::default().strikes,
            "storage_file": crate::plugin::folder::MAX_FILE,
            "storage_total": crate::plugin::folder::MAX_TOTAL,
            "storage_files": crate::plugin::folder::MAX_FILES,
            "storage_name": crate::plugin::folder::MAX_NAME,
        },
        "permissions": {
            "words": permission::WORDS.iter().map(|w| (w.name.to_string(), json!({ "summary": w.summary, "risk": w.risk }))).collect::<serde_json::Map<_, _>>(),
            "serve_summary": permission::SERVE_SUMMARY,
            "serve_risk": permission::SERVE_RISK,
            "serve_methods": permission::SERVE_METHODS,
            "serve_prefixes": permission::SERVE_PREFIXES,
            "serve_reads": permission::READS,
        },
        "ops": crate::plugin::op::KINDS.iter().map(|(kind, fields)| json!({ "op": kind, "fields": fields })).collect::<Vec<_>>(),
        "removable": crate::plugin::op::Removable::ALL.iter().map(|r| r.name()).collect::<Vec<_>>(),
        "bundled": crate::plugin::BUNDLED.iter().map(|b| b.name).collect::<Vec<_>>(),
        "builtin_prefix": crate::plugin::BUILTIN_PREFIX,
        "package_prefix": crate::plugin::PACKAGE_PREFIX,
    })
}

/// [`runtime`] as the TypeScript module the app imports ([`TS_PATH`]).
pub fn ts_text() -> String {
    let body = serde_json::to_string_pretty(&runtime()).expect("plain data");
    format!(
        "// What roster-core's Plugin host decides that the app and its fake Backend agree with (events,\n// limits, permissions' words, built-in Plugins). Written by `{COMMAND}`\n// from crates/roster-core/src/plugin: don't edit it here.\nexport const CORE = {body} as const;\n"
    )
}

/// Every file the generator writes, with its text: the reference, the stubs, the data and the
/// app's module.
pub fn generated() -> [(&'static str, String); 4] {
    [
        (DOC_PATH, markdown()),
        (STUBS_PATH, stubs()),
        (JSON_PATH, json_text()),
        (TS_PATH, ts_text()),
    ]
}
