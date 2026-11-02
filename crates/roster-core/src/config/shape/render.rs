//! What the shape is written out as: the option reference (one model, [`reference`], written as
//! docs/app/options.md and as the data `:help options` and `:options` show), and the LuaCATS stubs
//! (`:config types`). `cargo run -p roster-core --example gen_config_options` writes the committed
//! copies; tests/config_shape.rs fails when one is stale.

use super::{Allowed, ApiItem, Kind, NEOVIM_STYLE, Opt, api, children, options};
use crate::plugin::api::slug;
use serde::Serialize;
use std::fmt::Write as _;

pub const DOC_PATH: &str = "docs/app/options.md";
pub const STUBS_PATH: &str = "examples/types/roster-config.lua";
pub const JSON_PATH: &str = "crates/roster-core/tests/fixtures/config-options.json";
pub const COMMAND: &str = "cargo run -p roster-core --example gen_config_options";
/// The root class of the stubs: every option.
const ROOT: &str = "roster.config.Options";

// ---------------------------------------------------------------- the model

/// The reference: its sections in order, each with its entries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub generated: String,
    pub neovim_style: bool,
    pub sections: Vec<Section>,
    /// Other names for an entry (`roster.keymap.set()`, `roster.o.terminal.size`) → its tag.
    pub aliases: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub title: String,
    /// One paragraph under the heading; may be empty.
    pub intro: String,
    pub entries: Vec<Entry>,
}

/// One entry: an option, a name of the `roster` table, or an item type.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The help topic: the option's path (`terminal.size`), the function's path
    /// (`roster.keymap.set`), the type's name (`roster.config.Theme`).
    pub tag: String,
    /// What the heading shows: the tag, or a function's signature.
    pub heading: String,
    /// "option", "function", "value" or "type".
    pub what: &'static str,
    /// An option's kind (`leaf`, `object`, `map`, `list`); empty otherwise.
    pub kind: &'static str,
    /// How init.lua writes it, when that isn't the heading: `roster.o.terminal.size`, `themes.<id>`.
    pub written: String,
    /// LuaCATS: `number|string`; empty for a function.
    pub ty: String,
    /// In Lua, `unset` or `required`; empty when it has none (a type, a function).
    pub default: String,
    pub about: String,
    /// The values it takes, beyond its type: `6 to 72 px`.
    pub takes: String,
    /// A colour object's names.
    pub names: Vec<String>,
    /// The type each of a map's values or a list's items is: its tag.
    pub item: Option<String>,
    /// The options under it that have entries of their own: their tags.
    pub fields: Vec<String>,
    /// Its fields that don't (a spec's), or a function's parameters.
    pub rows: Vec<Row>,
    /// Lua that uses it.
    pub example: String,
    /// What `roster.o` lets init.lua do with it (see [`Kind::methods`]); empty until the
    /// Neovim-style names are in.
    pub methods: Vec<&'static str>,
    /// An option `:options` lists: it holds a value (not an object made only of other entries).
    pub listed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub name: String,
    pub ty: String,
    /// Empty for a parameter.
    pub default: String,
    pub about: String,
    /// A colour object's names.
    pub names: Vec<String>,
}

/// `themes.*.label` → `themes.<id>.label`; `folders[].name` → `folders[n].name`.
fn shown(path: &str) -> String {
    let key = if path.starts_with("keys.") { "<keys>" } else { "<id>" };
    path.replace(".*", &format!(".{key}")).replace("[]", "[n]")
}

/// An option's entry tag: its path, or an item type's class name.
fn tag(o: &Opt) -> String {
    if o.is_item() {
        o.class.unwrap_or_default().to_string()
    } else {
        o.path.clone()
    }
}

/// The line init.lua would write: `roster.o.terminal.size = "16pt"`, or `roster.set(…)`.
fn example_line(path: &str, value: &str) -> String {
    if NEOVIM_STYLE {
        format!("roster.o.{path} = {value}")
    } else {
        format!("roster.set(\"{path}\", {value})")
    }
}

/// The values beyond its type, when its type doesn't already list them.
fn takes(o: &Opt) -> String {
    match o.allowed {
        Allowed::OneOf(_) if o.ty.contains('"') => String::new(),
        _ => o.allowed.text(),
    }
}

fn names_of(o: &Opt) -> Vec<String> {
    children(o)
        .filter(|c| c.brief)
        .map(|c| c.segments().last().copied().unwrap_or_default().to_string())
        .collect()
}

/// The item type an entry's values are (a map's `*`, a list's `[]`), when it has one.
fn item_of(o: &Opt) -> Option<&'static Opt> {
    if !matches!(o.kind, Kind::Map | Kind::List) {
        return None;
    }
    children(o).find(|c| c.is_item() && c.class.is_some())
}

/// An object made only of options with entries of their own (`terminal`): it holds no value of
/// its own for `:options` to list.
fn only_entries(o: &Opt) -> bool {
    o.kind == Kind::Object && o.default == "{}" && children(o).next().is_some() && children(o).all(|c| c.is_entry())
}

fn option_entry(o: &Opt) -> Entry {
    let rows = children(o)
        .filter(|c| !c.brief && !c.is_entry() && !c.is_item())
        .map(|r| {
            let mut about = r.about.clone();
            let t = takes(r);
            if !t.is_empty() {
                let _ = write!(about, " Takes {t}.");
            }
            Row {
                name: r.segments().last().copied().unwrap_or_default().to_string(),
                ty: r.ty.clone(),
                default: r.default.clone(),
                about,
                names: names_of(r),
            }
        })
        .collect();
    let example = if o.is_item() {
        options()
            .iter()
            .find(|p| item_of(p).is_some_and(|i| i.path == o.path))
            .map(|p| example_line(&p.path, &p.example))
            .unwrap_or_default()
    } else if o.example.is_empty() {
        String::new()
    } else {
        example_line(&o.path, &o.example)
    };
    Entry {
        tag: tag(o),
        heading: tag(o),
        what: if o.is_item() { "type" } else { "option" },
        kind: o.kind.as_str(),
        written: if o.is_item() {
            shown(&o.path)
        } else if NEOVIM_STYLE {
            o.lua_name()
        } else {
            String::new()
        },
        ty: o.ty.clone(),
        default: if o.is_item() { String::new() } else { o.default.clone() },
        about: o.about.clone(),
        takes: takes(o),
        names: names_of(o),
        item: item_of(o).map(tag),
        fields: children(o).filter(|c| c.is_entry() && !c.is_item()).map(tag).collect(),
        rows,
        example,
        methods: if NEOVIM_STYLE && !o.is_item() {
            o.kind.methods().to_vec()
        } else {
            Vec::new()
        },
        listed: !o.is_item() && !only_entries(o),
    }
}

fn api_entry(a: &ApiItem) -> Entry {
    let mut about = a.about.to_string();
    if !a.more.is_empty() {
        let _ = write!(about, " {}", a.more);
    }
    Entry {
        tag: a.path.to_string(),
        heading: a.signature(),
        what: if a.is_function() { "function" } else { "value" },
        kind: "",
        written: String::new(),
        ty: a.ty.to_string(),
        default: String::new(),
        about,
        takes: String::new(),
        names: Vec::new(),
        item: None,
        fields: Vec::new(),
        rows: a
            .params
            .unwrap_or_default()
            .iter()
            .map(|p| Row {
                name: p.name.to_string(),
                ty: p.ty.to_string(),
                default: String::new(),
                about: p.about.to_string(),
                names: Vec::new(),
            })
            .collect(),
        example: a.example.to_string(),
        methods: Vec::new(),
        listed: false,
    }
}

/// The whole reference, in order: the `roster` table, the options by config.md's sections, the
/// item types.
pub fn reference() -> Reference {
    let mut sections = vec![Section {
        title: "The roster table".into(),
        intro: "A global in init.lua and its modules, and also require(\"roster\"). A Plugin gets a bigger one: the Plugin API.".into(),
        entries: api().map(api_entry).collect(),
    }];
    for o in options().iter().filter(|o| o.is_entry() && !o.is_item()) {
        if sections.last().map(|s| s.title.as_str()) != Some(o.section) {
            sections.push(Section {
                title: o.section.into(),
                intro: String::new(),
                entries: Vec::new(),
            });
        }
        if let Some(s) = sections.last_mut() {
            s.entries.push(option_entry(o));
        }
    }
    sections.push(Section {
        title: "Types".into(),
        intro: "The tables some options hold, by the names :config types gives them.".into(),
        entries: options()
            .iter()
            .filter(|o| o.is_entry() && o.is_item())
            .map(option_entry)
            .collect(),
    });
    let mut aliases = std::collections::BTreeMap::new();
    for a in api().filter(|a| a.is_function()) {
        aliases.insert(format!("{}()", a.path), a.path.to_string());
    }
    if NEOVIM_STYLE {
        for o in options().iter().filter(|o| o.is_entry() && !o.is_item()) {
            aliases.insert(o.lua_name(), o.path.clone());
        }
    }
    Reference {
        generated: format!("from crates/roster-core/src/config/shape by `{COMMAND}`"),
        neovim_style: NEOVIM_STYLE,
        sections,
        aliases,
    }
}

// ---------------------------------------------------------------- the Markdown

/// Prose for Markdown: each Lua string in it (`"16pt"`, `"<C-b>"`) as code, so it reads as Lua and
/// an angle bracket in it isn't taken for HTML.
fn prose(text: &str) -> String {
    let parts: Vec<&str> = text.split('"').collect();
    let mut out = parts[0].to_string();
    let mut i = 1;
    while i < parts.len() {
        if i + 1 < parts.len() {
            let _ = write!(out, "`\"{}\"`{}", parts[i], parts[i + 1]);
            i += 2;
        } else {
            let _ = write!(out, "\"{}", parts[i]);
            i += 1;
        }
    }
    out
}

fn cell(text: &str) -> String {
    text.replace('\n', " ").replace('|', "\\|")
}

fn default_md(d: &str) -> String {
    match d {
        "unset" | "required" | "" => d.to_string(),
        d => format!("`{d}`"),
    }
}

/// GitHub's anchor for an entry's heading.
fn md_anchor(heading: &str) -> String {
    slug(&format!("`{heading}`"))
}

/// docs/app/options.md.
pub fn markdown() -> String {
    let r = reference();
    let headings: std::collections::HashMap<&str, &str> = r
        .sections
        .iter()
        .flat_map(|s| &s.entries)
        .map(|e| (e.tag.as_str(), e.heading.as_str()))
        .collect();
    let link =
        |tag: &str, label: &str| format!("[`{label}`](#{})", md_anchor(headings.get(tag).copied().unwrap_or(tag)));
    let mut s = String::new();
    s.push_str("# Option reference\n\n");
    let _ = writeln!(s, "<!-- Generated {}: edit that, then run it. -->\n", r.generated);
    s.push_str(
        "Every option `init.lua` takes, and every name of its `roster` table, one entry each, the way Neovim's `:help 'option'` lists its options: how it's written, its type, its default, the values it can have, what it does and an example. Each entry is a help topic: `:help terminal.size`, `:help roster.keymap.set`, `:help roster.config.Theme`. In the app, `:help options` shows them with the value each option has now and where it was set, and `:options` finds one. [The Config guide](config.md) says how `init.lua` works, and more about each option. `:config types` writes all of this as types for your editor ([Editor support](#editor-support)).\n\n",
    );
    s.push_str(
        "Types are written as [LuaCATS](https://luals.github.io/wiki/annotations/) writes them: `string[]` is a list of strings, `table<string, X>` a table of X by name, `\"webgl\"|\"dom\"` one of those strings, `roster.config.Theme` a table described under [Types](#types). An object (a table of named options, such as `terminal`) needs no setup: give only the options you change. A default of unset means nothing is set and the app, or a choice it keeps, decides; required is a field a spec can't leave out.\n\n",
    );
    for section in &r.sections {
        let title = if section.title == "The roster table" {
            "The `roster` table".to_string()
        } else {
            section.title.clone()
        };
        let _ = writeln!(s, "## {title}\n");
        if !section.intro.is_empty() {
            let intro = prose(&section.intro)
                .replace("the Plugin API", "[the Plugin API](../plugin-api.md)")
                .replace("init.lua", "`init.lua`")
                .replace(":config types", "`:config types`");
            let _ = writeln!(s, "{intro}\n");
        }
        for e in &section.entries {
            let _ = writeln!(s, "### `{}`\n", e.heading);
            let mut line = Vec::new();
            if !e.written.is_empty() {
                line.push(format!("`{}`", e.written));
            }
            if !e.ty.is_empty() && e.what != "function" {
                line.push(format!("`{}`", e.ty));
            }
            if !e.default.is_empty() {
                line.push(format!("default {}", default_md(&e.default)));
            }
            if !line.is_empty() {
                let _ = writeln!(s, "{}\n", line.join(" · "));
            }
            let _ = writeln!(s, "{}\n", prose(&e.about));
            if !e.takes.is_empty() {
                let _ = writeln!(s, "Takes {}.\n", prose(&e.takes));
            }
            if !e.names.is_empty() {
                let names: Vec<String> = e.names.iter().map(|n| format!("`{n}`")).collect();
                let _ = writeln!(s, "Names: {}.\n", names.join(", "));
            }
            if let Some(item) = &e.item {
                let what = if e.kind == "map" { "Each value" } else { "Each item" };
                let _ = writeln!(s, "{what} is a {}.\n", link(item, item));
            }
            if !e.fields.is_empty() {
                let fields: Vec<String> = e
                    .fields
                    .iter()
                    .map(|f| link(f, f.rsplit('.').next().unwrap_or(f)))
                    .collect();
                let _ = writeln!(s, "Options in it: {}.\n", fields.join(", "));
            }
            if !e.methods.is_empty() {
                let methods: Vec<String> = e.methods.iter().map(|m| format!("`{m}`")).collect();
                let _ = writeln!(s, "Methods: {}.\n", methods.join(", "));
            }
            if !e.rows.is_empty() {
                if e.what == "function" {
                    s.push_str("| Parameter | Type | |\n|---|---|---|\n");
                    for row in &e.rows {
                        let _ = writeln!(
                            s,
                            "| `{}` | `{}` | {} |",
                            row.name,
                            cell(&row.ty),
                            cell(&prose(&row.about))
                        );
                    }
                } else {
                    s.push_str("| Field | Type | Default | |\n|---|---|---|---|\n");
                    for row in &e.rows {
                        let mut about = prose(&row.about);
                        if !row.names.is_empty() {
                            let names: Vec<String> = row.names.iter().map(|n| format!("`{n}`")).collect();
                            let _ = write!(about, " Names: {}.", names.join(", "));
                        }
                        let _ = writeln!(
                            s,
                            "| `{}` | `{}` | {} | {} |",
                            row.name,
                            cell(&row.ty),
                            cell(&default_md(&row.default)),
                            cell(&about)
                        );
                    }
                }
                s.push('\n');
            }
            if !e.example.is_empty() {
                let _ = writeln!(s, "```lua\n{}\n```\n", e.example);
            }
        }
    }
    s.push_str("## Editor support\n\n");
    let _ = writeln!(
        s,
        "`:config types` writes all of the above as [LuaCATS](https://luals.github.io/wiki/annotations/) annotations into `types/roster-config.lua` in the config folder ([`{STUBS_PATH}`](../../{STUBS_PATH}) is the same file), so [lua-language-server](https://luals.github.io/) completes option names and shows these descriptions as you type. Point it at the folder with a `.luarc.json` next to `init.lua`:\n"
    );
    s.push_str("```json\n{\n  \"runtime.version\": \"Lua 5.4\",\n  \"workspace.library\": [\"types\"],\n  \"diagnostics.globals\": [\"roster\"]\n}\n```\n\n");
    let _ = writeln!(
        s,
        "Then `---@type {ROOT}` on the table `init.lua` returns checks every name and value in it. The file is the copy this app was built with; run `:config types` again after an update.\n"
    );
    s
}

// ---------------------------------------------------------------- the data

/// crates/roster-core/tests/fixtures/config-options.json: [`reference`] as data, for
/// `:help options` and `:options`.
pub fn json_text() -> String {
    let mut text = serde_json::to_string_pretty(&reference()).expect("JSON");
    text.push('\n');
    text
}

// ---------------------------------------------------------------- the stubs

/// One line of a doc comment: the description, then the default.
fn hover(o: &Opt) -> String {
    let mut out = o.about.clone();
    if !matches!(o.default.as_str(), "unset" | "required" | "{}") {
        let _ = write!(out, " Default: `{}`.", o.default);
    }
    let allowed = o.allowed.text();
    if !allowed.is_empty() && !matches!(o.allowed, super::Allowed::OneOf(_)) {
        let _ = write!(out, " Takes {allowed}.");
    }
    out.replace('\n', " ")
}

fn field(o: &Opt) -> String {
    let name = o.segments().last().copied().unwrap_or_default().to_string();
    let optional = if o.default == "required" { "" } else { "?" };
    format!("---@field {name}{optional} {} {}\n", o.ty, hover(o))
}

/// examples/types/roster-config.lua: init.lua's options and `roster` table, for lua-language-server.
pub fn stubs() -> String {
    let mut s = String::new();
    s.push_str("---@meta\n");
    let _ = writeln!(
        s,
        "-- Generated from crates/roster-core/src/config/shape by `{COMMAND}`.\n-- The types of init.lua's options and its `roster` table, for lua-language-server: `:config types`\n-- writes this file as types/roster-config.lua in the config folder. `:help options` has the same text.\n"
    );

    let _ = writeln!(
        s,
        "--- Every option init.lua takes. `---@type {ROOT}` on the table it returns checks it."
    );
    let _ = writeln!(s, "---@class {ROOT}");
    for o in options().iter().filter(|o| o.segments().len() == 1) {
        s.push_str(&field(o));
    }
    s.push('\n');

    let mut done: Vec<&str> = Vec::new();
    for o in options() {
        let Some(class) = o.class else { continue };
        if done.contains(&class) {
            continue;
        }
        done.push(class);
        let _ = writeln!(s, "--- {}", o.about);
        if o.kind == Kind::Leaf {
            let _ = writeln!(s, "---@alias {class} {}\n", o.ty);
            continue;
        }
        let _ = writeln!(s, "---@class {class}");
        for c in children(o).filter(|c| !c.is_item()) {
            s.push_str(&field(c));
        }
        s.push('\n');
    }

    s.push_str("--- An option's dotted name, for roster.set.\n---@alias roster.config.OptionName\n");
    for o in options().iter().filter(|o| !o.in_item()) {
        let _ = writeln!(s, "---| \"{}\"", o.path);
    }
    s.push('\n');

    s.push_str("--- init.lua's `roster` table. A Plugin's is another one (types/roster.lua).\nroster = {}\n\n");
    let mut tables: Vec<String> = Vec::new();
    for a in api() {
        let parts: Vec<&str> = a.path.split('.').collect();
        for depth in 2..parts.len() {
            let t = parts[..depth].join(".");
            if !tables.contains(&t) {
                let _ = writeln!(s, "{t} = {{}}\n");
                tables.push(t);
            }
        }
        let _ = writeln!(s, "--- {}", a.about);
        if !a.more.is_empty() {
            let _ = writeln!(s, "--- {}", a.more);
        }
        s.push_str("---\n--- ```lua\n");
        for line in a.example.lines() {
            let _ = writeln!(s, "--- {line}");
        }
        s.push_str("--- ```\n");
        match a.params {
            Some(params) => {
                for p in params {
                    let _ = writeln!(s, "---@param {} {} {}", p.name, p.ty, p.about);
                }
                let names: Vec<&str> = params.iter().map(|p| p.name).collect();
                let _ = writeln!(s, "function {}({}) end\n", a.path, names.join(", "));
            }
            None => {
                let _ = writeln!(s, "---@type {}\n{} = nil\n", a.ty, a.path);
            }
        }
    }
    s.push_str("return roster\n");
    s
}

/// `:config types`: writes [`stubs`] as `types/roster-config.lua` in the config folder `dir`,
/// over an older copy, and gives where. `dir` must exist; never writes through a link.
pub fn write_types(dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if !dir.is_dir() {
        return Err(format!("{} isn't a folder", dir.display()));
    }
    let types = dir.join("types");
    let file = types.join("roster-config.lua");
    for p in [&types, &file] {
        if std::fs::symlink_metadata(p).is_ok_and(|m| crate::plugin::folder::is_link(&m)) {
            return Err(format!("{} is a link: roster won't write through it", p.display()));
        }
    }
    std::fs::create_dir_all(&types).map_err(|e| format!("{}: {e}", types.display()))?;
    std::fs::write(&file, stubs()).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(file)
}
