//! The Config's shape (config/shape, decision Q132) can't drift from what init.lua really takes:
//! every option's example loads through the real loader and changes the Config, every default is
//! `Config::default()`'s, the allowed values are exactly what the checks let through,
//! config.md's option tables name the same options, the `roster` table declares what the runtime
//! builds, and the generated reference, stubs and data are up to date.

mod common;

use roster_core::config::shape::{self, Allowed, Kind, Opt};
use roster_core::config::{self, Config, ConfigError, Env};
use std::path::PathBuf;

fn load(lua: &str) -> Result<Config, ConfigError> {
    let dir = common::temp("config-shape");
    config::load_source(&dir, lua, &Env::default())
}

/// The Config without what the loader adds about the file (which values it set, and where).
fn values(mut c: Config) -> Config {
    c.lines.clear();
    c.set.clear();
    c.deprecated.clear();
    c.modes.standard.set.clear();
    c.modes.focus.set.clear();
    c
}

fn key(seg: &str) -> String {
    if seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !seg.starts_with(|c: char| c.is_ascii_digit()) {
        seg.to_string()
    } else {
        format!("[{seg:?}]")
    }
}

/// The Lua table that sets the option at `pattern` to `value`: a map's key is `x`, a list's item
/// a one-item list, and a spec gets the fields it can't do without from their examples.
fn table_for(pattern: &str, value: &str) -> String {
    let opt = shape::get(pattern).unwrap_or_else(|| panic!("no option {pattern}"));
    let segs = opt.segments();
    fn nest(segs: &[&str], done: &[&str], value: &str) -> String {
        let Some((seg, rest)) = segs.split_first() else {
            return value.to_string();
        };
        let mut here: Vec<&str> = done.to_vec();
        here.push(seg);
        let inner = nest(rest, &here, value);
        match *seg {
            "*" => format!("{{ x = {inner} }}"),
            "[]" => format!("{{ {inner} }}"),
            name => {
                let mut fields = vec![format!("{} = {inner}", key(name))];
                // The spec's required fields, when this is one of its other fields.
                let parent: Vec<&str> = done.to_vec();
                for o in shape::options() {
                    let s = o.segments();
                    if o.default == "required"
                        && s.len() == parent.len() + 1
                        && s[..parent.len()] == parent[..]
                        && s.last() != Some(seg)
                    {
                        fields.push(format!("{} = {}", key(s.last().unwrap()), o.example));
                    }
                }
                format!("{{ {} }}", fields.join(", "))
            }
        }
    }
    format!("return {}", nest(&segs, &[], value))
}

fn base() -> Config {
    values(load("return {}").unwrap())
}

fn has_value(o: &Opt) -> bool {
    !o.example.is_empty()
}

#[test]
fn every_example_loads_and_changes_the_config() {
    let base = base();
    for o in shape::options().iter().filter(|o| has_value(o)) {
        let lua = table_for(&o.path, &o.example);
        let c = load(&lua).unwrap_or_else(|e| panic!("{}: the example doesn't load: {lua}\n{e}", o.path));
        if o.example != o.default {
            assert_ne!(values(c), base, "{}: setting the example {lua} changes nothing", o.path);
        }
    }
}

#[test]
fn every_default_is_the_schemas() {
    let base = base();
    assert_eq!(base, values(Config::default()));
    // A field of an object that's also a shorthand (`sidebar = false`) sets the object too, so its
    // default is only that object's own field's.
    let shorthand_field = |o: &Opt| {
        let segs = o.segments();
        segs.len() > 1
            && shape::get(&segs[..segs.len() - 1].join("."))
                .is_some_and(|p| p.kind == Kind::Object && p.default != "{}")
    };
    for o in shape::options()
        .iter()
        .filter(|o| !o.in_item() && !shorthand_field(o) && !matches!(o.default.as_str(), "unset" | "required"))
    {
        let lua = table_for(&o.path, &o.default);
        let c = load(&lua).unwrap_or_else(|e| panic!("{}: the default doesn't load: {lua}\n{e}", o.path));
        assert_eq!(
            values(c),
            base,
            "{}: the default {} isn't Config::default()'s",
            o.path,
            o.default
        );
    }
}

#[test]
fn unset_means_the_config_holds_nothing_there() {
    // An option that defaults to unset is an Option in the schema: its JSON is null or absent.
    let json = serde_json::to_value(Config::default()).unwrap();
    let camel = |s: &str| {
        let mut out = String::new();
        let mut up = false;
        for c in s.chars() {
            if c == '_' {
                up = true;
            } else if up {
                out.push(c.to_ascii_uppercase());
                up = false;
            } else {
                out.push(c);
            }
        }
        out
    };
    for o in shape::options()
        .iter()
        .filter(|o| !o.in_item() && o.default == "unset" && !o.path.contains(".sidebar."))
    {
        let mut v = &json;
        for seg in o.segments() {
            v = v.get(camel(seg)).unwrap_or(&serde_json::Value::Null);
        }
        assert!(
            v.is_null(),
            "{}: defaults to unset, but Config::default() has {v}",
            o.path
        );
    }
}

#[test]
fn allowed_values_are_what_the_checks_let_through() {
    for o in shape::options().iter().filter(|o| o.is_leaf()) {
        match o.allowed {
            Allowed::Range { min, max, .. } => {
                let step = if o.ty == "integer" { 1.0 } else { 0.01 };
                for (v, ok) in [(min, true), (max, true), (min - step, false), (max + step, false)] {
                    let lua = table_for(&o.path, &format!("{v}"));
                    assert_eq!(
                        load(&lua).is_ok(),
                        ok,
                        "{}: {v} should be {}",
                        o.path,
                        if ok { "taken" } else { "refused" }
                    );
                }
            }
            Allowed::OneOf(values) => {
                for v in values {
                    let lua = table_for(&o.path, v);
                    assert!(load(&lua).is_ok(), "{}: {v} should be taken: {lua}", o.path);
                }
                let lua = table_for(&o.path, "\"not-one-of-them\"");
                assert!(load(&lua).is_err(), "{}: any other text should be refused", o.path);
            }
            _ => {}
        }
    }
}

#[test]
fn a_misspelled_name_is_refused_at_every_level() {
    // The shape's fixed names are all of them: one it doesn't declare is an error in the schema.
    for o in shape::options()
        .iter()
        .filter(|o| o.kind == Kind::Object && !o.in_item() && !o.is_item())
    {
        let lua = table_for(&o.path, "{ not_an_option = 1 }");
        assert!(load(&lua).is_err(), "{} takes a name the shape doesn't declare", o.path);
    }
}

/// config.md's option tables: the names in each row's first cell, and the pieces of each mode.
fn config_md_names() -> Vec<String> {
    let text =
        std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/app/config.md")).unwrap();
    let mut out = Vec::new();
    let mut in_options = false;
    let mut pieces = false;
    for line in text.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            in_options = h == "Options";
            continue;
        }
        if !in_options || !line.starts_with('|') {
            pieces = pieces && line.starts_with('|');
            continue;
        }
        let first = line.split('|').nth(1).unwrap_or_default().trim();
        if first == "Piece" {
            pieces = true;
            continue;
        }
        let names: Vec<&str> = first.split('`').skip(1).step_by(2).collect();
        for n in names {
            if pieces {
                out.push(format!("modes.standard.{n}"));
                out.push(format!("modes.focus.{n}"));
            } else {
                out.push(n.to_string());
            }
        }
    }
    out
}

#[test]
fn config_md_documents_the_same_options() {
    let names = config_md_names();
    assert!(names.contains(&"terminal.size".to_string()) && names.contains(&"modes.focus.toolbar".to_string()));
    for n in &names {
        let o = shape::get(n).unwrap_or_else(|| panic!("config.md documents {n}, which the shape doesn't declare"));
        assert!(!o.in_item(), "{n}");
    }
    let covered = |path: &str| {
        names
            .iter()
            .any(|n| path == n || path.starts_with(&format!("{n}.")) || path.starts_with(&format!("{n}[")))
    };
    for o in shape::options()
        .iter()
        .filter(|o| !o.in_item() && o.kind != Kind::Object)
    {
        assert!(covered(&o.path), "{} isn't in config.md's option tables", o.path);
    }
}

#[test]
fn the_roster_table_has_what_the_shape_declares() {
    let lua = r#"
        local names = {}
        for k, v in pairs(roster) do
          if type(v) == "table" then
            for k2 in pairs(v) do names[#names + 1] = "roster." .. k .. "." .. k2 end
          else
            names[#names + 1] = "roster." .. k
          end
        end
        table.sort(names)
        return { theme = table.concat(names, ",") }
    "#;
    let runtime = load(lua).unwrap().theme;
    let mut declared: Vec<&str> = shape::api().map(|a| a.path).collect();
    declared.sort();
    assert_eq!(runtime, declared.join(","));
}

#[test]
fn the_committed_reference_stubs_and_data_are_what_the_generator_writes() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    for (path, text) in [
        (shape::DOC_PATH, shape::markdown()),
        (shape::STUBS_PATH, shape::stubs()),
        (shape::JSON_PATH, shape::json_text()),
    ] {
        let committed = std::fs::read_to_string(root.join(path)).unwrap_or_default();
        assert!(
            committed == text,
            "{path} is out of date with crates/roster-core/src/config/shape: run  {}",
            shape::COMMAND
        );
    }
}

#[test]
fn the_reference_has_an_entry_for_every_option_and_roster_name() {
    let md = shape::markdown();
    for o in shape::options().iter().filter(|o| o.is_entry()) {
        let heading = if o.is_item() {
            o.class.unwrap().to_string()
        } else {
            o.path.clone()
        };
        assert!(md.contains(&format!("### `{heading}`\n")), "no entry for {heading}");
    }
    for a in shape::api() {
        assert!(
            md.contains(&format!("### `{}`\n", a.signature())),
            "no entry for {}",
            a.path
        );
    }
    // A colour token is listed in its object's entry.
    assert!(md.contains("`accent`, `accent_text`"));
}

#[test]
fn the_stubs_are_lua_and_declare_every_option() {
    let stubs = shape::stubs();
    mlua::Lua::new().load(&stubs).exec().expect("the stubs run as Lua");
    assert!(stubs.contains("---@class roster.config.Terminal\n"));
    assert!(stubs.contains("---@field size? number|string "));
    assert!(stubs.contains("---| \"terminal.size\"\n"));
    assert!(stubs.contains("function roster.keymap.set(context, keys, action) end"));
}

#[test]
fn config_types_writes_the_stubs_into_the_config_folder() {
    let dir = common::temp("config-types");
    let file = shape::write_types(&dir).unwrap();
    assert_eq!(file, dir.join("types").join("roster-config.lua"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), shape::stubs());
    assert!(shape::write_types(&dir.join("missing")).is_err());
}

#[cfg(unix)]
#[test]
fn config_types_never_writes_through_a_link() {
    let dir = common::temp("config-types-link");
    let elsewhere = common::temp("config-types-elsewhere");
    std::os::unix::fs::symlink(&*elsewhere, dir.join("types")).unwrap();
    assert!(shape::write_types(&dir).unwrap_err().contains("is a link"));
    assert!(!elsewhere.join("roster-config.lua").exists());
}

// ---------------------------------------------------------------- coverage

/// How the schema nests at a path, found by asking it.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Found {
    Object,
    /// A map of tables (`themes`): its `*` holds the fields.
    Map,
    /// A list of tables (`folders`): its `[]` holds the fields.
    List,
    /// Anything else: a value, or a map or list of values.
    Value,
}

const PROBE: &str = "zz_probe";

/// JSON that puts `value` at `segs` (`*` a map key, `[]` a list's one item).
fn json_at(segs: &[String], value: serde_json::Value) -> serde_json::Value {
    let Some((seg, rest)) = segs.split_first() else {
        return value;
    };
    let inner = json_at(rest, value);
    match seg.as_str() {
        "*" => serde_json::json!({ PROBE: inner }),
        "[]" => serde_json::json!([inner]),
        name => serde_json::json!({ name: inner }),
    }
}

/// The struct's field names when `value` at `segs` is an unknown name in one: serde lists them in
/// its error ("unknown field `zz_probe`, expected one of `a`, `b`").
fn fields_named_by(segs: &[String], value: serde_json::Value) -> Option<Vec<String>> {
    let err = serde_json::from_value::<Config>(json_at(segs, value))
        .err()?
        .to_string();
    let rest = err.split_once(&format!("unknown field `{PROBE}`"))?.1;
    if rest.contains("there are no fields") {
        return Some(Vec::new());
    }
    let list = rest.split_once("expected")?.1;
    Some(list.split('`').skip(1).step_by(2).map(str::to_string).collect())
}

/// Every path in the schema, by asking `Config`'s own Deserialize what it takes at each one: the
/// real field names of each struct, and the maps and lists of structs between them.
fn discover(segs: Vec<String>, out: &mut Vec<(String, Found)>) {
    let probe = || serde_json::json!({ PROBE: 1 });
    let path = |segs: &[String]| segs.join(".").replace(".[]", "[]");
    let (found, fields, next) = if let Some(f) = fields_named_by(&segs, probe()) {
        (Found::Object, f, segs.clone())
    } else if let Some(f) = fields_named_by(&[segs.clone(), vec!["*".into()]].concat(), probe()) {
        (Found::Map, f, [segs.clone(), vec!["*".into()]].concat())
    } else if let Some(f) = fields_named_by(&[segs.clone(), vec!["[]".into()]].concat(), probe()) {
        (Found::List, f, [segs.clone(), vec!["[]".into()]].concat())
    } else {
        (Found::Value, Vec::new(), segs.clone())
    };
    if !segs.is_empty() {
        out.push((path(&segs), found));
    }
    if found == Found::Map || found == Found::List {
        out.push((path(&next), Found::Object));
    }
    for f in fields {
        discover([next.clone(), vec![f]].concat(), out);
    }
}

fn schema_paths() -> Vec<(String, Found)> {
    let mut out = Vec::new();
    discover(Vec::new(), &mut out);
    out
}

#[test]
fn discovery_finds_the_whole_schema() {
    let paths = schema_paths();
    let has = |p: &str, f: Found| paths.iter().any(|(path, found)| path == p && *found == f);
    assert!(has("terminal", Found::Object));
    assert!(has("terminal.size", Found::Value));
    assert!(has("themes", Found::Map) && has("themes.*.ansi.bright_white", Found::Value));
    assert!(has("folders", Found::List) && has("folders[].hosts", Found::Value));
    assert!(has("packages[].config", Found::Value));
    assert!(has("modes.focus.sidebar.sections", Found::Value));
    assert!(has("keys.picker_vim", Found::Value));
    assert!(has("colors.syntax_command", Found::Value));
    assert!(
        !paths
            .iter()
            .any(|(p, _)| p == "lines" || p == "set" || p == "deprecated")
    );
}

/// The acceptance check: a field added to the schema fails here until the shape declares it,
/// with everything its entry needs, and the reference shows it.
#[test]
fn every_path_in_the_schema_is_declared_and_documented() {
    let r = shape::reference();
    let entries: Vec<&shape::Entry> = r.sections.iter().flat_map(|s| &s.entries).collect();
    let documented = |o: &Opt| -> bool {
        let segs = o.segments();
        let last = segs.last().copied().unwrap_or_default();
        let parent = segs[..segs.len() - 1].join(".").replace(".[]", "[]");
        let parent_tag = shape::get(&parent).map(|p| {
            if p.is_item() {
                p.class.unwrap_or_default().to_string()
            } else {
                p.path.clone()
            }
        });
        entries.iter().any(|e| e.tag == o.path || (o.is_item() && Some(e.tag.as_str()) == o.class))
            || entries.iter().any(|e| {
                Some(&e.tag) == parent_tag.as_ref()
                    && (e.names.iter().any(|n| n == last) || e.rows.iter().any(|row| row.name == last))
            })
            || entries.iter().flat_map(|e| &e.rows).any(|row| row.name == shape::get(&parent).and_then(|p| p.segments().last().map(|s| s.to_string())).unwrap_or_default() && row.names.iter().any(|n| n == last))
            // A map's keys or a list's items are described by their type's entry.
            || (o.is_item() && entries.iter().any(|e| e.item.as_deref() == o.class))
    };
    let mut missing = Vec::new();
    for (path, found) in schema_paths() {
        let Some(o) = shape::get(&path) else {
            missing.push(format!("{path}: in the schema, not declared in config/shape"));
            continue;
        };
        let kind_ok = match found {
            Found::Object => o.kind == Kind::Object,
            Found::Map => o.kind == Kind::Map,
            Found::List => o.kind == Kind::List,
            Found::Value => o.kind != Kind::Object,
        };
        if !kind_ok {
            missing.push(format!(
                "{path}: the schema has a {found:?}, the shape says {:?}",
                o.kind
            ));
        }
        for (what, empty) in [
            ("type", o.ty.is_empty()),
            ("default", o.default.is_empty()),
            ("summary", o.about.is_empty()),
            ("example", o.example.is_empty()),
        ] {
            if empty {
                missing.push(format!("{path}: no {what}"));
            }
        }
        if !documented(o) {
            missing.push(format!("{path}: no entry, row or name in the reference"));
        }
    }
    assert!(missing.is_empty(), "{}", missing.join("\n"));
}

#[test]
fn the_shape_declares_nothing_the_schema_lacks() {
    let paths: Vec<String> = schema_paths().into_iter().map(|(p, _)| p).collect();
    for o in shape::options() {
        // A map's or list's plain items (a key binding) aren't structs to discover.
        let segs = o.segments();
        let under_collection = o.is_item() && !paths.contains(&o.path);
        let parent_found = segs.len() > 1 && paths.contains(&segs[..segs.len() - 1].join(".").replace(".[]", "[]"));
        assert!(
            paths.contains(&o.path) || (under_collection && parent_found),
            "{} isn't in the schema",
            o.path
        );
    }
}
