//! init.lua's `roster` table (decision Q132, ticket 142): read-only facts (`roster.os`,
//! `roster.version`, …), the checked option tree `roster.o` with each kind's methods, `roster.set`,
//! and the named collections `roster.packages`, `roster.folders`, `roster.keymap` and
//! `roster.themes`. Every write goes to the one [`Store`] with the line that made it; the loader
//! lays the store under the table init.lua returns.
//!
//! Checks happen at the line that writes: a name the Config doesn't have (with the name meant), a
//! value of the wrong type, a duplicate in a list that takes each item once, a second Folder or
//! Package with the same name (naming both lines), and anything removed or changed that isn't
//! there. What only the whole Config can tell (a range, a Windows path with the WSL backend) is
//! checked once init.lua has run, and still names the line that set it.
//!
//! A Plugin's `roster` is another table (plugin/runtime.rs); none of these names reaches it.

use super::locate::SourceIndex;
use super::lua::{Budget, packages_table, source_of, to_json, to_lua};
use super::schema::Location;
use super::shape::{self, Kind, Opt};
use super::store::{Names, Store};
use super::{DEPRECATED_OPTIONS, Env, check_value};
use mlua::{Function, Lua, MetaMethod, Table, UserData, UserDataMethods, Value, Variadic};
use serde_json::Value as Json;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

/// What the `roster` table's functions share: the store, the run's budget for Config data, and
/// each file's text with its line starts (read once per file, for the lines writes give).
pub(crate) struct Ctx {
    pub store: RefCell<Store>,
    pub budget: Rc<Cell<Budget>>,
    pub sources: RefCell<HashMap<String, Option<Rc<SourceIndex>>>>,
}

impl Ctx {
    pub(crate) fn new(budget: Rc<Cell<Budget>>) -> Self {
        Ctx {
            store: RefCell::new(Store::new()),
            budget,
            sources: RefCell::new(HashMap::new()),
        }
    }
}

const METHODS: &str = "roster.o.methods";

type R<T> = mlua::Result<T>;

/// The nearest caller from a `.lua` file, at the line Lua reports.
fn caller(lua: &Lua) -> Option<Location> {
    (1..64).find_map(|level| {
        lua.inspect_stack(level, |d| {
            let file = d.source().short_src.map(|s| s.to_string())?;
            if !file.ends_with(".lua") {
                return None;
            }
            let line = u32::try_from(d.current_line()?).ok()?;
            Some(Location { file, line })
        })
        .flatten()
    })
}

/// `file`'s text and line starts, read once per run.
fn source_index(lua: &Lua, file: &str) -> Option<Rc<SourceIndex>> {
    let c = ctx(lua).ok()?;
    if let Some(found) = c.sources.borrow().get(file) {
        return found.clone();
    }
    let index = source_of(lua, file).map(|text| Rc::new(SourceIndex::new(text)));
    c.sources.borrow_mut().insert(file.to_string(), index.clone());
    index
}

/// Where the statement that called is: its file, the line it starts on, and the line Lua reports
/// (its last, for a table over several lines).
fn spot(lua: &Lua) -> Option<(Location, u32)> {
    let mut at = caller(lua)?;
    let reported = at.line;
    if let Some(index) = source_index(lua, &at.file) {
        at.line = index.statement_start(reported);
    }
    Some((at, reported))
}

/// Where the Config's statement that called is: the line it starts on.
pub(crate) fn here(lua: &Lua) -> Option<Location> {
    spot(lua).map(|(at, _)| at)
}

/// The line inside the calling statement that names `key` (a name inside a table assigned over
/// several lines), else the statement's first line.
fn here_key(lua: &Lua, key: &str) -> Option<Location> {
    let (mut at, reported) = spot(lua)?;
    if !key.chars().all(|c| c.is_ascii_digit())
        && let Some(line) = source_index(lua, &at.file).and_then(|i| i.key_line(key, at.line, reported))
    {
        at.line = line;
    }
    Some(at)
}

/// An error at the line that names `key`.
fn fail_key(lua: &Lua, key: &str, message: impl std::fmt::Display) -> mlua::Error {
    match here_key(lua, key) {
        Some(at) => mlua::Error::runtime(format!("{}:{}: {message}", at.file, at.line)),
        None => mlua::Error::runtime(message.to_string()),
    }
}

/// An error at the Config's line: `lua/keys.lua:3: message`.
fn fail(lua: &Lua, message: impl std::fmt::Display) -> mlua::Error {
    match here(lua) {
        Some(at) => mlua::Error::runtime(format!("{}:{}: {message}", at.file, at.line)),
        None => mlua::Error::runtime(message.to_string()),
    }
}

/// A name error from [`check_names`], at the line that has the name.
fn name_error(lua: &Lua, (key, message): (String, String)) -> mlua::Error {
    fail_key(lua, &key, message)
}

fn shown_at(at: Option<&Location>) -> String {
    at.map_or_else(|| "an earlier line".into(), |a| format!("{}:{}", a.file, a.line))
}

fn ctx(lua: &Lua) -> R<Rc<Ctx>> {
    lua.app_data_ref::<Rc<Ctx>>()
        .map(|c| Rc::clone(&c))
        .ok_or_else(|| mlua::Error::runtime("roster: the Config's store is gone"))
}

// ---------------------------------------------------------------- paths

/// A concrete path as a person reads it: `terminal.size`, `folders[2].hosts`.
fn shown(path: &[String]) -> String {
    let mut out = String::new();
    for (i, seg) in path.iter().enumerate() {
        let in_list = i > 0 && shape::lookup(&refs(&path[..i])).is_some_and(|o| o.kind == Kind::List);
        if in_list {
            out.push_str(&format!("[{seg}]"));
        } else {
            if i > 0 {
                out.push('.');
            }
            out.push_str(seg);
        }
    }
    out
}

fn refs(path: &[String]) -> Vec<&str> {
    path.iter().map(String::as_str).collect()
}

/// `terminal.szie isn't an option (did you mean terminal.size?)`.
fn not_an_option(path: &[String]) -> String {
    let Some((name, parent)) = path.split_last() else {
        return "roster.o needs an option's name".into();
    };
    let mut m = format!("{} isn't an option", shown(path));
    if let Some(meant) = shape::suggest(&refs(parent), name) {
        let last = meant.rsplit('.').next().unwrap_or(&meant).to_string();
        let mut p = parent.to_vec();
        p.push(last);
        m.push_str(&format!(" (did you mean {}?)", shown(&p)));
    }
    m
}

/// The option at a concrete path, or the error that names the one meant.
fn option(path: &[String]) -> Result<&'static Opt, String> {
    shape::lookup(&refs(path)).ok_or_else(|| not_an_option(path))
}

/// A path a write can name: an option, not inside a list's item (a list changes as a whole or
/// through its methods), or a deprecated name (the loader moves it to its new one).
fn writable(path: &[String]) -> Result<Option<&'static Opt>, String> {
    if path.iter().any(String::is_empty) {
        return Err(format!(
            "{:?} isn't an option name like \"terminal.size\"",
            path.join(".")
        ));
    }
    if DEPRECATED_OPTIONS.iter().any(|r| r.old == path.join(".")) {
        return Ok(None);
    }
    let o = option(path)?;
    if let Some(i) = (1..path.len()).find(|&i| shape::lookup(&refs(&path[..i])).is_some_and(|p| p.kind == Kind::List)) {
        return Err(format!(
            "{} is inside a list: change {} as a whole, or with its methods",
            shown(path),
            shown(&path[..i])
        ));
    }
    Ok(Some(o))
}

/// Every name in `v`, written at `path`, is one the Config has.
fn check_names(path: &mut Vec<String>, v: &Json) -> Result<(), (String, String)> {
    let o = option(path).map_err(|m| (path.last().cloned().unwrap_or_default(), m))?;
    match (o.kind, v) {
        (Kind::Object | Kind::Map, Json::Object(map)) => {
            for (k, child) in map {
                path.push(k.clone());
                check_names(path, child)?;
                path.pop();
            }
        }
        (Kind::List, Json::Array(items)) => {
            if o.unique
                && let Some(i) = (1..items.len()).find(|&i| items[..i].contains(&items[i]))
            {
                return Err((
                    path.last().cloned().unwrap_or_default(),
                    format!(
                        "{}: {} is in it already (each item once)",
                        shown(path),
                        lua_text(&items[i])
                    ),
                ));
            }
            if shape::children(o).any(Opt::is_item) {
                for (i, item) in items.iter().enumerate() {
                    path.push((i + 1).to_string());
                    check_names(path, item)?;
                    path.pop();
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// A value checked at its line: its names ([`check_names`]), then its type. A plain value of a
/// plain type is checked here; anything else by the schema, for this option alone.
fn check(lua: &Lua, path: &[String], opt: Option<&Opt>, value: &Json) -> R<()> {
    let Some(o) = opt else { return Ok(()) };
    check_names(&mut path.to_vec(), value).map_err(|e| name_error(lua, e))?;
    if plain_ok(o, value) {
        return Ok(());
    }
    check_value(path, value).map_err(|m| fail(lua, m))
}

/// A leaf's value that its type plainly takes: a boolean for `boolean`, one of a `"a"|"b"`,
/// a number for `integer` and so on. Forms and ranges are checked once the file has run, still at
/// this line.
fn plain_ok(o: &Opt, v: &Json) -> bool {
    if o.kind != Kind::Leaf {
        return false;
    }
    if let shape::Allowed::OneOf(values) = o.allowed {
        let written = match v {
            Json::String(s) => format!("{s:?}"),
            Json::Bool(b) => b.to_string(),
            _ => return false,
        };
        return values.contains(&written.as_str());
    }
    o.ty.split('|').any(|t| match (t, v) {
        ("boolean", Json::Bool(_)) | ("false", Json::Bool(false)) => true,
        ("string", Json::String(_)) => true,
        ("number", Json::Number(_)) => true,
        ("integer", Json::Number(n)) => n.is_i64() || n.is_u64(),
        _ => false,
    })
}

// ---------------------------------------------------------------- the named lists

/// `folders` and `packages`: lists whose items have names, each name once.
fn named_list(path: &[String]) -> Option<&'static str> {
    match path {
        [one] if one == "folders" => Some("folders"),
        [one] if one == "packages" => Some("packages"),
        _ => None,
    }
}

fn what(list: &str) -> &'static str {
    if list == "folders" { "Folder" } else { "Package" }
}

/// An item's name as written.
fn shown_name(list: &str, index: usize, item: &Json) -> Result<String, String> {
    let at = format!("{list}[{index}]");
    if list == "folders" {
        return match item.get("name").and_then(Json::as_str) {
            Some(n) if !n.trim().is_empty() => Ok(n.trim().to_string()),
            _ => Err(format!("{at}: a Folder needs a name")),
        };
    }
    let spec: super::PackageSpec = serde_json::from_value(item.clone()).map_err(|e| format!("{at}: {e}"))?;
    super::package_spec::name_of(&spec).map_err(|e| format!("{at}: {e}"))
}

/// The name a person gave to find an item by.
fn key_of(name: &str) -> String {
    name.trim().to_lowercase()
}

fn duplicate(lua: &Lua, list: &str, name: &str, first: Option<&Location>) -> mlua::Error {
    fail(
        lua,
        format!(
            "there's already a {} named {name:?} (from {})",
            what(list),
            shown_at(first)
        ),
    )
}

/// Writes a named list whole (assigned whole, or changed by a list method that moves items):
/// each name once, a second one naming both lines. `keep` keeps the line each item already there
/// was added at; otherwise every item is this line's.
fn write_named(lua: &Lua, list: &'static str, items: Vec<Json>, keep: bool) -> R<()> {
    let c = ctx(lua)?;
    let path = vec![list.to_string()];
    let at = here(lua);
    let value = Json::Array(items);
    check_names(&mut path.clone(), &value).map_err(|e| name_error(lua, e))?;
    let old: Names = c.store.borrow().named(list).to_vec();
    let mut names: Names = Vec::new();
    for (i, item) in value.as_array().into_iter().flatten().enumerate() {
        let name = shown_name(list, i + 1, item).map_err(|m| fail(lua, m))?;
        let key = key_of(&name);
        if let Some((_, first)) = names.iter().find(|(k, _)| *k == key) {
            return Err(duplicate(lua, list, &name, first.as_ref()));
        }
        let line = if keep {
            old.iter()
                .find(|(k, _)| *k == key)
                .map_or(at.clone(), |(_, a)| a.clone())
        } else {
            at.clone()
        };
        names.push((key, line));
    }
    check_value(&path, &value).map_err(|m| fail(lua, m))?;
    let mut store = c.store.borrow_mut();
    store.set(&path, value, at);
    *store.named_mut(list) = names;
    Ok(())
}

/// Checks one item of a named list at position `i` (from 1) on its own: its names, its lists'
/// repeats and its type. Gives its name as written.
fn check_item(lua: &Lua, list: &'static str, i: usize, item: &Json) -> R<String> {
    check_names(&mut vec![list.to_string(), i.to_string()], item).map_err(|e| name_error(lua, e))?;
    let name = shown_name(list, i, item).map_err(|m| fail(lua, m))?;
    check_value(&[list.to_string()], &Json::Array(vec![item.clone()])).map_err(|m| {
        let m = m
            .strip_prefix(&format!("{list}.1"))
            .map_or(m.clone(), |rest| format!("{list}[{i}]{rest}"));
        fail(lua, m)
    })?;
    Ok(name)
}

/// Adds items to a named list in place, checking only them: an add from anywhere stays quick
/// however long the list is.
fn add_named(lua: &Lua, list: &'static str, new: Vec<Json>) -> R<()> {
    let c = ctx(lua)?;
    let path = vec![list.to_string()];
    let at = here(lua);
    let mut count = match c.store.borrow().get(&path) {
        Some(Json::Array(items)) => items.len(),
        _ => 0,
    };
    let mut checked = Vec::new();
    for item in new {
        count += 1;
        let name = check_item(lua, list, count, &item)?;
        let key = key_of(&name);
        let store = c.store.borrow();
        let before = store
            .named(list)
            .iter()
            .chain(checked.iter().map(|(_, n)| n))
            .find(|(k, _)| *k == key);
        if let Some((_, first)) = before {
            return Err(duplicate(lua, list, &name, first.as_ref()));
        }
        drop(store);
        checked.push((item, (key, at.clone())));
    }
    let mut store = c.store.borrow_mut();
    let (items, names): (Vec<Json>, Names) = checked.into_iter().unzip();
    store.list_mut(&path).extend(items);
    store.named_mut(list).extend(names);
    store.touched(&path, at);
    Ok(())
}

/// The index of the item named `name` (letter case aside), or for `packages` with that source.
fn position_named(store: &Store, list: &'static str, name: &str) -> Option<usize> {
    let key = key_of(name);
    store.named(list).iter().position(|(k, _)| *k == key).or_else(|| {
        let items = store.get(&[list.to_string()])?.as_array()?;
        items.iter().position(|it| {
            it.get("source")
                .and_then(Json::as_str)
                .is_some_and(|s| s.trim() == name.trim())
        })
    })
}

/// The index of the item named `name`, or an error saying there's none.
fn find_named(lua: &Lua, list: &'static str, name: &str) -> R<usize> {
    let c = ctx(lua)?;
    let store = c.store.borrow();
    if let Some(i) = position_named(&store, list, name) {
        return Ok(i);
    }
    let names: Vec<String> = store
        .get(&[list.to_string()])
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, it)| shown_name(list, i + 1, it).ok())
        .collect();
    Err(fail(
        lua,
        format!(
            "there's no {} named {name:?} in the Config{}",
            what(list),
            if names.is_empty() {
                String::new()
            } else {
                format!(" (it has {})", names.join(", "))
            }
        ),
    ))
}

/// Takes item `i` out of a named list, in place.
fn remove_named(lua: &Lua, list: &'static str, i: usize) -> R<()> {
    let c = ctx(lua)?;
    let path = vec![list.to_string()];
    let at = here(lua);
    let mut store = c.store.borrow_mut();
    store.list_mut(&path).remove(i);
    let names = store.named_mut(list);
    if i < names.len() {
        names.remove(i);
    }
    store.touched(&path, at);
    Ok(())
}

/// Puts `item` in place of item `i` of a named list, checked on its own; its name stays unique.
fn replace_named(lua: &Lua, list: &'static str, i: usize, item: Json) -> R<()> {
    let c = ctx(lua)?;
    let path = vec![list.to_string()];
    let at = here(lua);
    let name = check_item(lua, list, i + 1, &item)?;
    let key = key_of(&name);
    {
        let store = c.store.borrow();
        let other = store
            .named(list)
            .iter()
            .enumerate()
            .find(|(j, (k, _))| *j != i && *k == key);
        if let Some((_, (_, first))) = other {
            return Err(duplicate(lua, list, &name, first.as_ref()));
        }
    }
    let mut store = c.store.borrow_mut();
    store.list_mut(&path)[i] = item;
    let names = store.named_mut(list);
    if i < names.len() {
        names[i] = (key, at.clone());
    }
    store.touched(&path, at);
    Ok(())
}

/// A copy of a named list's item `i`.
fn item_at(lua: &Lua, list: &str, i: usize) -> R<Json> {
    let c = ctx(lua)?;
    let store = c.store.borrow();
    Ok(store
        .get(&[list.to_string()])
        .and_then(|v| v.get(i))
        .cloned()
        .unwrap_or(Json::Null))
}

// ---------------------------------------------------------------- writing

/// What an option holds now: what the Config set, else its default (as init.lua would write
/// it), else nothing.
fn effective(lua: &Lua, path: &[String]) -> R<Option<Json>> {
    let c = ctx(lua)?;
    if let Some(v) = c.store.borrow().get(path) {
        return Ok(Some(v.clone()));
    }
    let Some(o) = shape::lookup(&refs(path)) else {
        return Ok(None);
    };
    if matches!(o.default.as_str(), "unset" | "required") {
        return Ok(None);
    }
    let v: Value = lua.load(format!("return {}", o.default)).set_name("=default").eval()?;
    to_json(&v, &c.budget).map(Some).map_err(|e| fail(lua, e.message))
}

/// A Lua value as Config data for `path`: a `roster.o` table stands for a copy of what it holds
/// (what the Config set, or its default; one that holds nothing at all is an error, so copying
/// never wipes anything); `packages` written the lazy.nvim way is normalized. None for nil.
fn data(lua: &Lua, path: &[String], value: Value) -> R<Option<Json>> {
    let c = ctx(lua)?;
    let value = match value {
        Value::UserData(ud) if ud.is::<OptProxy>() => {
            let from = ud.borrow::<OptProxy>()?.clone();
            return match effective(lua, &from.path)? {
                Some(v) => Ok(Some(v)),
                None => Err(fail(
                    lua,
                    format!(
                        "{} is unset, with no default: there's nothing to copy (to reset {}, roster.o.reset({:?}))",
                        from.name(),
                        shown(path),
                        path.join(".")
                    ),
                )),
            };
        }
        Value::Nil => return Ok(None),
        v if named_list(path) == Some("packages") => {
            packages_table(lua, v).map_err(|(p, m)| fail(lua, format!("{}: {m}", shown(&p))))?
        }
        v => v,
    };
    to_json(&value, &c.budget)
        .map(Some)
        .map_err(|e| fail(lua, located(path, &e.path, &e.message)))
}

fn located(path: &[String], within: &[String], message: &str) -> String {
    let mut p = path.to_vec();
    p.extend(within.iter().cloned());
    format!("{}: {message}", shown(&p))
}

/// The one way a value gets into the store: checked at the line that writes it.
fn write(lua: &Lua, path: &[String], value: Value) -> R<()> {
    let opt = writable(path).map_err(|m| fail(lua, m))?;
    let json = data(lua, path, value)?;
    let Some(json) = json else {
        return remove(lua, path);
    };
    if let Some(list) = named_list(path) {
        let items = match json {
            Json::Array(items) => items,
            Json::Object(m) if m.is_empty() => Vec::new(),
            other => {
                check_value(path, &other).map_err(|m| fail(lua, m))?;
                return Err(fail(lua, format!("{list}: a list of {} specs", what(list))));
            }
        };
        return write_named(lua, list, items, false);
    }
    check(lua, path, opt, &json)?;
    let at = here(lua);
    ctx(lua)?.store.borrow_mut().set(path, json, at);
    Ok(())
}

/// Takes away what the Config set at `path`.
fn remove(lua: &Lua, path: &[String]) -> R<()> {
    writable(path).map_err(|m| fail(lua, m))?;
    let c = ctx(lua)?;
    let at = here(lua);
    let mut store = c.store.borrow_mut();
    store.remove(path, at);
    if let Some(list) = named_list(path) {
        store.named_mut(list).clear();
    }
    Ok(())
}

/// A value as Lua writes it, for messages.
fn lua_text(v: &Json) -> String {
    match v {
        Json::String(s) => format!("{s:?}"),
        other => other.to_string(),
    }
}

/// A copy of what the store holds at `path`, as Lua (nil when unset).
fn read(lua: &Lua, path: &[String]) -> R<Value> {
    let c = ctx(lua)?;
    let store = c.store.borrow();
    match store.get(path) {
        Some(v) => to_lua(lua, v),
        None => Ok(Value::Nil),
    }
}

// ---------------------------------------------------------------- roster.o

/// A table of `roster.o`: an object, a map or a list at `path` (the root at `[]`).
#[derive(Clone)]
struct OptProxy {
    path: Vec<String>,
}

impl OptProxy {
    fn kind(&self) -> Kind {
        if self.path.is_empty() {
            Kind::Object
        } else {
            shape::lookup(&refs(&self.path)).map_or(Kind::Object, |o| o.kind)
        }
    }

    fn name(&self) -> String {
        if self.path.is_empty() {
            "roster.o".into()
        } else {
            format!("roster.o.{}", shown(&self.path))
        }
    }

    fn child(&self, key: &str) -> Vec<String> {
        let mut p = self.path.clone();
        p.push(key.to_string());
        p
    }
}

fn key_text(lua: &Lua, p: &OptProxy, key: &Value) -> R<String> {
    match key {
        Value::String(s) => Ok(s.to_str()?.to_string()),
        Value::Integer(_) | Value::Number(_) if p.kind() == Kind::List => Err(fail(
            lua,
            format!(
                "{}: read a list with {}:get(), change it with its methods",
                p.name(),
                p.name()
            ),
        )),
        other => Err(fail(
            lua,
            format!("{}: a name is a string, not a {}", p.name(), other.type_name()),
        )),
    }
}

fn method(lua: &Lua, name: &str) -> R<Value> {
    let methods: Table = lua.named_registry_value(METHODS)?;
    methods.raw_get(name)
}

/// `roster.o`'s own functions, by an option's dotted name: `roster.o.get("views.get")` reads even
/// a map's key named like a method, and `roster.o.reset(name)` resets any option.
const ROOT_FUNCTIONS: &[&str] = &["get", "reset"];

/// What `p.key` gives: a method, an option's value (a copy, or nil), or the table under it.
fn index(lua: &Lua, p: &OptProxy, key: Value) -> R<Value> {
    let key = key_text(lua, p, &key)?;
    let kind = p.kind();
    let at_root = p.path.is_empty() && ROOT_FUNCTIONS.contains(&key.as_str());
    let is_method = kind.methods().contains(&key.as_str()) || at_root;
    // An object's own names come first (none is a method's); a map's keys come after its methods.
    if kind == Kind::Object && shape::lookup(&refs(&p.child(&key))).is_some() {
        return child(lua, p.child(&key));
    }
    // A map's key named like a method reads as the key once it's set (roster.o.views.reset,
    // after roster.o.views.reset = { … }); until then, as the method.
    let stored = || -> R<bool> { Ok(ctx(lua)?.store.borrow().get(&p.child(&key)).is_some()) };
    if is_method && kind == Kind::Map && stored()? {
        return child(lua, p.child(&key));
    }
    if is_method {
        return method(lua, &if at_root { format!("{key}_path") } else { key });
    }
    match kind {
        Kind::Map => child(lua, p.child(&key)),
        Kind::List => Err(fail(
            lua,
            format!(
                "{}:{key} isn't a list's method (it has {})",
                p.name(),
                Kind::List.methods().join(", ")
            ),
        )),
        _ => Err(fail(lua, not_an_option(&p.child(&key)))),
    }
}

fn child(lua: &Lua, path: Vec<String>) -> R<Value> {
    let o = option(&path).map_err(|m| fail(lua, m))?;
    if o.kind == Kind::Leaf {
        read(lua, &path)
    } else {
        Ok(Value::UserData(lua.create_userdata(OptProxy { path })?))
    }
}

fn new_index(lua: &Lua, p: &OptProxy, key: Value, value: Value) -> R<()> {
    let key = key_text(lua, p, &key)?;
    if p.kind() == Kind::List {
        return Err(fail(
            lua,
            format!("{}: change a list whole, or with its methods", p.name()),
        ));
    }
    if p.path.is_empty() && ROOT_FUNCTIONS.contains(&key.as_str()) {
        return Err(fail(lua, format!("roster.o.{key} is a function, not an option")));
    }
    write(lua, &p.child(&key), value)
}

impl UserData for OptProxy {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(MetaMethod::Index, |lua, this, key: Value| index(lua, this, key));
        methods.add_meta_method(MetaMethod::NewIndex, |lua, this, (key, value): (Value, Value)| {
            new_index(lua, this, key, value)
        });
        methods.add_meta_method(MetaMethod::ToString, |_, this, ()| Ok(this.name()));
    }
}

/// The proxy a method was called on, or an error when it was called with a dot.
fn this(lua: &Lua, name: &str, v: &Value) -> R<OptProxy> {
    match v {
        Value::UserData(ud) if ud.is::<OptProxy>() => Ok(ud.borrow::<OptProxy>()?.clone()),
        _ => Err(fail(
            lua,
            format!("{name} is a method: call it with a colon (roster.o.terminal.font:{name}(…))"),
        )),
    }
}

/// A list's items now: what the Config set, else its default when that is a list; a boolean or
/// an unset list that means "all of them" has to be assigned first.
fn list_now(lua: &Lua, p: &OptProxy) -> R<Vec<Json>> {
    let set = {
        let c = ctx(lua)?;
        let store = c.store.borrow();
        store.get(&p.path).cloned()
    };
    let opt = option(&p.path).map_err(|m| fail(lua, m))?;
    let value = match set {
        Some(v) => v,
        None if opt.default.starts_with('{') => {
            let v: Value = lua
                .load(format!("return {}", opt.default))
                .set_name("=default")
                .eval()?;
            let c = ctx(lua)?;
            to_json(&v, &c.budget).map_err(|e| fail(lua, e.message))?
        }
        None => Json::String(opt.default.clone()),
    };
    match value {
        Json::Array(items) => Ok(items),
        Json::Object(m) if m.is_empty() => Ok(Vec::new()),
        // `roster_command = "uv run roster"` is words; a font named once is one font.
        Json::String(s) if p.path == ["roster_command"] && opt.default != s => {
            Ok(s.split_whitespace().map(|w| Json::String(w.into())).collect())
        }
        Json::String(s) if opt.default != s => Ok(vec![Json::String(s)]),
        other => Err(fail(
            lua,
            format!(
                "{} is {} (not a list yet): assign a list first, such as {} = {}",
                p.name(),
                match &other {
                    Json::String(s) => s.clone(),
                    o => o.to_string(),
                },
                p.name(),
                if opt.example.starts_with('{') {
                    opt.example.as_str()
                } else {
                    "{ … }"
                }
            ),
        )),
    }
}

/// Writes a list whole, after one of its methods changed it.
fn write_list(lua: &Lua, p: &OptProxy, items: Vec<Json>) -> R<()> {
    if let Some(list) = named_list(&p.path) {
        return write_named(lua, list, items, true);
    }
    let opt = option(&p.path).map_err(|m| fail(lua, m))?;
    let value = Json::Array(items);
    check(lua, &p.path, Some(opt), &value)?;
    let at = here(lua);
    ctx(lua)?.store.borrow_mut().set(&p.path, value, at);
    Ok(())
}

/// The values a method was given, as items of the list at `p`.
fn items_given(lua: &Lua, p: &OptProxy, values: Vec<Value>) -> R<Vec<Json>> {
    let mut out = Vec::new();
    for v in values {
        let v = if named_list(&p.path) == Some("packages") {
            let one = lua.create_table()?;
            one.raw_set(1, v)?;
            let normal = packages_table(lua, Value::Table(one))
                .map_err(|(path, m)| fail(lua, format!("{}: {m}", shown(&path))))?;
            match normal {
                Value::Table(t) => t.raw_get(1)?,
                other => other,
            }
        } else {
            v
        };
        if v.is_nil() {
            return Err(fail(lua, format!("{}: an item can't be nil", p.name())));
        }
        let c = ctx(lua)?;
        out.push(to_json(&v, &c.budget).map_err(|e| fail(lua, located(&p.path, &e.path, &e.message)))?);
    }
    Ok(out)
}

/// The position of `v` in a list: an equal item.
fn position(items: &[Json], v: &Json) -> Option<usize> {
    items.iter().position(|i| i == v)
}

/// For `folders` and `packages`: the item a string names (its name, or a Package's source), as
/// `:has` and `:remove` take it, before it would be read as a spec.
fn named_arg(lua: &Lua, p: &OptProxy, v: &Value) -> R<Option<Option<usize>>> {
    let (Some(list), Value::String(name)) = (named_list(&p.path), v) else {
        return Ok(None);
    };
    let name = name.to_str()?.to_string();
    let c = ctx(lua)?;
    let store = c.store.borrow();
    Ok(Some(position_named(&store, list, &name)))
}

fn add_methods(lua: &Lua) -> R<()> {
    let methods = lua.create_table()?;
    let def = |name: &'static str, f: fn(&Lua, OptProxy, Vec<Value>) -> R<Value>| -> R<()> {
        methods.raw_set(
            name,
            lua.create_function(move |lua, args: Variadic<Value>| {
                let mut args = args.into_iter();
                let me = this(lua, name, &args.next().unwrap_or(Value::Nil))?;
                let kind = me.kind();
                if !kind.methods().contains(&name) {
                    return Err(fail(
                        lua,
                        format!(
                            "{}:{name} isn't a method of a {} (it has {})",
                            me.name(),
                            kind.as_str(),
                            kind.methods().join(", ")
                        ),
                    ));
                }
                f(lua, me, args.collect())
            })?,
        )
    };
    def("get", |lua, p, _| read(lua, &p.path))?;
    def("reset", |lua, p, _| {
        if p.path.is_empty() {
            return Err(fail(
                lua,
                "roster.o.reset(name) takes an option's name: roster.o.reset(\"terminal.size\")",
            ));
        }
        remove(lua, &p.path).map(|()| Value::Nil)
    })?;
    def("has", |lua, p, args| {
        let v = args.into_iter().next().unwrap_or(Value::Nil);
        match p.kind() {
            Kind::Map => {
                let key = match &v {
                    Value::String(s) => s.to_str()?.to_string(),
                    _ => return Err(fail(lua, format!("{}:has(key): the key is a string", p.name()))),
                };
                let c = ctx(lua)?;
                let store = c.store.borrow();
                Ok(Value::Boolean(store.get(&p.child(&key)).is_some()))
            }
            _ => {
                if let Some(found) = named_arg(lua, &p, &v)? {
                    return Ok(Value::Boolean(found.is_some()));
                }
                let items = list_now(lua, &p)?;
                let v = items_given(lua, &p, vec![v])?.remove(0);
                Ok(Value::Boolean(position(&items, &v).is_some()))
            }
        }
    })?;
    def("keys", |lua, p, _| {
        let c = ctx(lua)?;
        let store = c.store.borrow();
        let keys: Vec<String> = store
            .get(&p.path)
            .and_then(Json::as_object)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        Ok(Value::Table(lua.create_sequence_from(keys)?))
    })?;
    def("append", |lua, p, args| {
        if let Some(list) = named_list(&p.path) {
            let new = items_given(lua, &p, args)?;
            return add_named(lua, list, new).map(|()| Value::Nil);
        }
        let mut items = list_now(lua, &p)?;
        items.extend(items_given(lua, &p, args)?);
        write_list(lua, &p, items).map(|()| Value::Nil)
    })?;
    def("prepend", |lua, p, args| {
        let mut items = items_given(lua, &p, args)?;
        items.extend(list_now(lua, &p)?);
        write_list(lua, &p, items).map(|()| Value::Nil)
    })?;
    def("insert", |lua, p, args| {
        let mut args = args.into_iter();
        let i = match args.next() {
            Some(Value::Integer(i)) => i,
            Some(Value::Number(n)) if n.fract() == 0.0 => n as i64,
            _ => {
                return Err(fail(
                    lua,
                    format!("{}:insert(i, value): i is a position, from 1", p.name()),
                ));
            }
        };
        let mut items = list_now(lua, &p)?;
        if i < 1 || i as usize > items.len() + 1 {
            return Err(fail(
                lua,
                format!("{}:insert({i}, …): the position is 1 to {}", p.name(), items.len() + 1),
            ));
        }
        let v = items_given(lua, &p, vec![args.next().unwrap_or(Value::Nil)])?.remove(0);
        items.insert(i as usize - 1, v);
        write_list(lua, &p, items).map(|()| Value::Nil)
    })?;
    def("remove", |lua, p, args| {
        if let Some(list) = named_list(&p.path) {
            for v in args {
                let i = match named_arg(lua, &p, &v)? {
                    Some(found) => found,
                    None => {
                        let items = list_now(lua, &p)?;
                        let v = items_given(lua, &p, vec![v])?.remove(0);
                        position(&items, &v)
                    }
                };
                match i {
                    Some(i) => remove_named(lua, list, i)?,
                    None => return Err(fail(lua, format!("{} has no such {} in it", p.name(), what(list)))),
                }
            }
            return Ok(Value::Nil);
        }
        let mut items = list_now(lua, &p)?;
        for v in items_given(lua, &p, args)? {
            match position(&items, &v) {
                Some(i) => {
                    items.remove(i);
                }
                None => return Err(fail(lua, format!("{} has no {} in it", p.name(), lua_text(&v)))),
            }
        }
        write_list(lua, &p, items).map(|()| Value::Nil)
    })?;
    def("clear", |lua, p, _| {
        write_list(lua, &p, Vec::new()).map(|()| Value::Nil)
    })?;
    // `roster.o.get("terminal.size")`; `roster.o:get()` is still the root's own method.
    methods.raw_set(
        "get_path",
        lua.create_function(|lua, name: Value| match name {
            Value::UserData(ud) if ud.is::<OptProxy>() => read(lua, &ud.borrow::<OptProxy>()?.path),
            Value::String(name) => {
                let path: Vec<String> = name.to_str()?.split('.').map(str::to_string).collect();
                if path.iter().any(String::is_empty) {
                    return Err(fail(
                        lua,
                        format!(
                            "roster.o.get: {:?} isn't an option name like \"terminal.size\"",
                            path.join(".")
                        ),
                    ));
                }
                option(&path).map_err(|m| fail(lua, m))?;
                read(lua, &path)
            }
            _ => Err(fail(
                lua,
                "roster.o.get(name) takes an option's name: roster.o.get(\"terminal.size\")",
            )),
        })?,
    )?;
    // `roster.o.reset("terminal.size")`.
    methods.raw_set(
        "reset_path",
        lua.create_function(|lua, name: Value| {
            let Value::String(name) = name else {
                return Err(fail(
                    lua,
                    "roster.o.reset(name) takes an option's name: roster.o.reset(\"terminal.size\")",
                ));
            };
            let path: Vec<String> = name.to_str()?.split('.').map(str::to_string).collect();
            remove(lua, &path)
        })?,
    )?;
    lua.set_named_registry_value(METHODS, methods)
}

// ---------------------------------------------------------------- the table

/// A table the Config reads from but can't write to: `roster.version = …` is an error.
fn read_only(lua: &Lua, name: &'static str, fields: Table) -> R<Table> {
    let t = lua.create_table()?;
    let meta = lua.create_table()?;
    meta.raw_set("__index", fields.clone())?;
    meta.raw_set(
        "__newindex",
        lua.create_function(move |lua, (_, key): (Value, Value)| -> R<()> {
            let key = key.to_string().unwrap_or_else(|_| "?".into());
            Err(fail(lua, format!("{name}.{key} is read-only")))
        })?,
    )?;
    let next: Function = lua.globals().raw_get("next")?;
    meta.raw_set(
        "__pairs",
        lua.create_function(move |_, _: Value| Ok((next.clone(), fields.clone(), Value::Nil)))?,
    )?;
    meta.raw_set("__metatable", false)?;
    t.set_metatable(Some(meta))?;
    Ok(t)
}

/// init.lua's `roster` table.
pub(crate) fn roster_table(lua: &Lua, env: &Env, dir: &Path, ctx: Rc<Ctx>) -> R<Table> {
    lua.set_app_data(ctx);
    add_methods(lua)?;
    let roster = lua.create_table()?;
    roster.raw_set("os", env.os.as_str())?;
    roster.raw_set("api_version", crate::API_VERSION)?;
    roster.raw_set("config_version", super::CONFIG_VERSION)?;
    roster.raw_set("version", env!("CARGO_PKG_VERSION"))?;
    let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    roster.raw_set("config_dir", dir.display().to_string())?;
    roster.raw_set("o", lua.create_userdata(OptProxy { path: Vec::new() })?)?;

    // `roster.set("terminal.size", "16pt")`: any option by its dotted name (`:config
    // import-terminal` writes these, ticket 33). The same store as roster.o.
    roster.raw_set(
        "set",
        lua.create_function(|lua, (name, value): (String, Value)| {
            let path: Vec<String> = name.split('.').map(str::to_string).collect();
            if path.iter().any(String::is_empty) {
                return Err(fail(
                    lua,
                    format!("roster.set: {name:?} isn't an option name like \"terminal.size\""),
                ));
            }
            write(lua, &path, value)
        })?,
    )?;
    roster.raw_set("keymap", read_only(lua, "roster.keymap", keymap(lua)?)?)?;
    roster.raw_set("themes", read_only(lua, "roster.themes", themes(lua)?)?)?;
    roster.raw_set(
        "packages",
        read_only(lua, "roster.packages", collection(lua, "packages")?)?,
    )?;
    roster.raw_set(
        "folders",
        read_only(lua, "roster.folders", collection(lua, "folders")?)?,
    )?;
    read_only(lua, "roster", roster)
}

fn context(lua: &Lua, context: &str) -> R<()> {
    let path = ["keys".to_string(), context.to_string()];
    if shape::lookup(&refs(&path)).is_some() {
        return Ok(());
    }
    let mut m = format!("{context:?} isn't a key context");
    if let Some(meant) = shape::suggest(&["keys"], context) {
        m.push_str(&format!(" (did you mean {:?}?)", meant.trim_start_matches("keys.")));
    }
    Err(fail(lua, m))
}

fn keymap(lua: &Lua) -> R<Table> {
    let t = lua.create_table()?;
    t.raw_set(
        "set",
        lua.create_function(|lua, (cx, keys, action): (String, String, Value)| {
            context(lua, &cx)?;
            if matches!(action, Value::Function(_)) {
                return Err(fail(
                    lua,
                    "roster.keymap.set: the action is a command line such as \"close\" (Lua functions as actions come with Plugins)",
                ));
            }
            if action.is_nil() {
                return Err(fail(lua, "roster.keymap.set: give an action, or false to unbind; roster.keymap.del takes a binding off"));
            }
            write(lua, &["keys".into(), cx, keys], action)
        })?,
    )?;
    t.raw_set(
        "del",
        lua.create_function(|lua, (cx, keys): (String, String)| {
            context(lua, &cx)?;
            let path = vec!["keys".to_string(), cx.clone(), keys.clone()];
            let bound = ctx(lua)?.store.borrow().get(&path).is_some();
            if !bound {
                return Err(fail(
                    lua,
                    format!(
                        "the Config binds no {keys:?} in {cx} (to unbind one of roster's own, roster.keymap.set({cx:?}, {keys:?}, false))"
                    ),
                ));
            }
            remove(lua, &path)
        })?,
    )?;
    t.raw_set(
        "get",
        lua.create_function(|lua, (cx, keys): (String, String)| {
            context(lua, &cx)?;
            read(lua, &["keys".into(), cx, keys])
        })?,
    )?;
    t.raw_set(
        "has",
        lua.create_function(|lua, (cx, keys): (String, String)| {
            context(lua, &cx)?;
            let path = vec!["keys".to_string(), cx, keys];
            Ok(ctx(lua)?.store.borrow().get(&path).is_some())
        })?,
    )?;
    t.raw_set(
        "list",
        lua.create_function(|lua, cx: String| {
            context(lua, &cx)?;
            match read(lua, &["keys".into(), cx])? {
                Value::Nil => Ok(Value::Table(lua.create_table()?)),
                v => Ok(v),
            }
        })?,
    )?;
    Ok(t)
}

/// A Theme's id as roster.themes takes it.
fn theme_id(lua: &Lua, id: &str) -> R<()> {
    if id.trim().is_empty() || id == "auto" {
        return Err(fail(lua, format!("{id:?}: a Theme needs an id other than \"auto\"")));
    }
    Ok(())
}

/// Where the store got what it has at `path`: the last write at it or above it.
fn written_at(lua: &Lua, path: &[String]) -> R<Option<Location>> {
    let c = ctx(lua)?;
    let store = c.store.borrow();
    Ok(store.last_at(path))
}

/// `b` over `a`: tables merge key by key, anything else replaces.
fn merge(a: &mut Json, b: Json) {
    match (a, b) {
        (Json::Object(a), Json::Object(b)) => {
            for (k, v) in b {
                match a.get_mut(&k) {
                    Some(old) if old.is_object() && v.is_object() => merge(old, v),
                    _ => {
                        a.insert(k, v);
                    }
                }
            }
        }
        (a, b) => *a = b,
    }
}

fn themes(lua: &Lua) -> R<Table> {
    let t = lua.create_table()?;
    let path = |id: &str| vec!["themes".to_string(), id.to_string()];
    t.raw_set(
        "define",
        lua.create_function(move |lua, (id, theme): (String, Table)| {
            theme_id(lua, &id)?;
            if shape::BUNDLED_THEMES.contains(&id.as_str()) {
                return Err(fail(
                    lua,
                    format!("{id:?} is a bundled Theme: change it with roster.themes.update({id:?}, {{ … }})"),
                ));
            }
            if ctx(lua)?.store.borrow().get(&path(&id)).is_some() {
                let first = written_at(lua, &path(&id))?;
                return Err(fail(
                    lua,
                    format!(
                        "there's already a Theme {id:?} (from {}): a Theme is defined once; change it with roster.themes.update({id:?}, {{ … }})",
                        shown_at(first.as_ref())
                    ),
                ));
            }
            write(lua, &path(&id), Value::Table(theme))
        })?,
    )?;
    t.raw_set(
        "update",
        lua.create_function(move |lua, (id, fields): (String, Table)| {
            theme_id(lua, &id)?;
            let c = ctx(lua)?;
            let now = c.store.borrow().get(&path(&id)).cloned();
            let mut spec = match now {
                Some(v) => v,
                None if shape::BUNDLED_THEMES.contains(&id.as_str()) => serde_json::json!({ "base": id }),
                None => return Err(fail(lua, no_theme(&id))),
            };
            let fields = to_json(&Value::Table(fields), &c.budget)
                .map_err(|e| fail(lua, located(&path(&id), &e.path, &e.message)))?;
            merge(&mut spec, fields);
            write(lua, &path(&id), to_lua(lua, &spec)?)
        })?,
    )?;
    t.raw_set(
        "remove",
        lua.create_function(move |lua, id: String| {
            if ctx(lua)?.store.borrow().get(&path(&id)).is_none() {
                if shape::BUNDLED_THEMES.contains(&id.as_str()) {
                    return Err(fail(
                        lua,
                        format!("{id:?} is a bundled Theme: only your own can be removed"),
                    ));
                }
                return Err(fail(lua, no_theme(&id)));
            }
            remove(lua, &path(&id))
        })?,
    )?;
    t.raw_set(
        "get",
        lua.create_function(move |lua, id: String| read(lua, &path(&id)))?,
    )?;
    // Whether there's a Theme by that id, as list names them: a bundled one or init.lua's.
    t.raw_set(
        "has",
        lua.create_function(move |lua, id: String| {
            Ok(shape::BUNDLED_THEMES.contains(&id.as_str()) || ctx(lua)?.store.borrow().get(&path(&id)).is_some())
        })?,
    )?;
    t.raw_set(
        "list",
        lua.create_function(|lua, ()| {
            let c = ctx(lua)?;
            let store = c.store.borrow();
            let mut ids: Vec<String> = shape::BUNDLED_THEMES.iter().map(|s| s.to_string()).collect();
            if let Some(own) = store.get(&["themes".to_string()]).and_then(Json::as_object) {
                ids.extend(
                    own.keys()
                        .filter(|k| !shape::BUNDLED_THEMES.contains(&k.as_str()))
                        .cloned(),
                );
            }
            lua.create_sequence_from(ids)
        })?,
    )?;
    Ok(t)
}

fn no_theme(id: &str) -> String {
    format!(
        "there's no Theme {id:?} to change (the bundled ones are {}; roster.themes.define adds one)",
        shape::BUNDLED_THEMES.join(", ")
    )
}

/// `roster.packages` and `roster.folders`.
fn collection(lua: &Lua, list: &'static str) -> R<Table> {
    let t = lua.create_table()?;
    t.raw_set(
        "add",
        lua.create_function(move |lua, specs: Variadic<Value>| {
            if specs.is_empty() {
                return Err(fail(
                    lua,
                    format!("roster.{list}.add: give one {} spec or more", what(list)),
                ));
            }
            let p = OptProxy {
                path: vec![list.to_string()],
            };
            let new = items_given(lua, &p, specs.into_iter().collect())?;
            add_named(lua, list, new)
        })?,
    )?;
    t.raw_set(
        "remove",
        lua.create_function(move |lua, name: String| {
            let i = find_named(lua, list, &name)?;
            remove_named(lua, list, i)
        })?,
    )?;
    t.raw_set(
        "update",
        lua.create_function(move |lua, (name, fields): (String, Value)| {
            let i = find_named(lua, list, &name)?;
            if !matches!(fields, Value::Table(_)) {
                return Err(fail(lua, format!("roster.{list}.update: the fields are a table")));
            }
            // The fields as add takes a spec: a Package's lazy.nvim form, and no function as config.
            let p = OptProxy {
                path: vec![list.to_string()],
            };
            let fields = items_given(lua, &p, vec![fields])?.remove(0);
            let mut item = item_at(lua, list, i)?;
            // A pin replaces the others: at most one of tag, branch and commit.
            if list == "packages"
                && let (Some(item), Some(f)) = (item.as_object_mut(), fields.as_object())
                && ["tag", "branch", "commit"].iter().any(|k| f.contains_key(*k))
            {
                for k in ["tag", "branch", "commit"] {
                    item.remove(k);
                }
            }
            if let (Some(obj), Json::Object(f)) = (item.as_object_mut(), fields) {
                for (k, v) in f {
                    obj.insert(k, v);
                }
            }
            replace_named(lua, list, i, item)
        })?,
    )?;
    t.raw_set(
        "get",
        lua.create_function(move |lua, name: String| {
            let found = {
                let c = ctx(lua)?;
                let store = c.store.borrow();
                position_named(&store, list, &name)
            };
            match found {
                Some(i) => to_lua(lua, &item_at(lua, list, i)?),
                None => Ok(Value::Nil),
            }
        })?,
    )?;
    t.raw_set(
        "list",
        lua.create_function(move |lua, ()| {
            let c = ctx(lua)?;
            let store = c.store.borrow();
            match store.get(&[list.to_string()]) {
                Some(v @ Json::Array(_)) => to_lua(lua, v),
                _ => Ok(Value::Table(lua.create_table()?)),
            }
        })?,
    )?;
    t.raw_set(
        "has",
        lua.create_function(move |lua, name: String| {
            let c = ctx(lua)?;
            let store = c.store.borrow();
            Ok(position_named(&store, list, &name).is_some())
        })?,
    )?;
    if list == "folders" {
        for (fname, adding) in [("add_hosts", true), ("remove_hosts", false)] {
            t.raw_set(
                fname,
                lua.create_function(move |lua, (name, hosts): (String, Value)| {
                    let i = find_named(lua, list, &name)?;
                    let given: Vec<String> = match hosts {
                        Value::String(s) => vec![s.to_str()?.to_string()],
                        Value::Table(t) => {
                            let mut out = Vec::new();
                            for v in t.sequence_values::<Value>() {
                                match v? {
                                    Value::String(s) => out.push(s.to_str()?.to_string()),
                                    _ => {
                                        return Err(fail(
                                            lua,
                                            format!("roster.folders.{fname}: hosts is a list of Host names"),
                                        ));
                                    }
                                }
                            }
                            out
                        }
                        _ => {
                            return Err(fail(
                                lua,
                                format!("roster.folders.{fname}: hosts is a Host name or a list of them"),
                            ));
                        }
                    };
                    let c = ctx(lua)?;
                    let at = here(lua);
                    let path = vec![list.to_string()];
                    // Worked out on a copy and checked whole; the Folder changes only when it all holds.
                    let mut next: Vec<Json> = match c
                        .store
                        .borrow()
                        .get(&path)
                        .and_then(|l| l.get(i))
                        .and_then(|f| f.get("hosts"))
                    {
                        Some(Json::Array(a)) => a.clone(),
                        _ => Vec::new(),
                    };
                    for h in given {
                        let h = Json::String(h);
                        let at = next.iter().position(|x| *x == h);
                        match (adding, at) {
                            (true, None) => next.push(h),
                            (true, Some(_)) => {
                                return Err(fail(lua, format!("Folder {name:?} has {} already", lua_text(&h))));
                            }
                            (false, Some(j)) => {
                                next.remove(j);
                            }
                            (false, None) => {
                                return Err(fail(lua, format!("Folder {name:?} has no {}", lua_text(&h))));
                            }
                        }
                    }
                    let mut store = c.store.borrow_mut();
                    let folder = store.list_mut(&path)[i]
                        .as_object_mut()
                        .ok_or_else(|| fail(lua, "a Folder is a table"))?;
                    folder.insert("hosts".into(), Json::Array(next));
                    store.touched(&path, at);
                    Ok(())
                })?,
            )?;
        }
    }
    Ok(t)
}
