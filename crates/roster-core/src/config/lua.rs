//! Running `init.lua` in a sandbox (docs/app/security.md, ADR 0004). The Rust core never holds a
//! secret, and the Lua state gets even less than the core has:
//!
//! - Libraries: the base functions, `string`, `table`, `math`, `utf8`, and an `os` with only
//!   `time`, `clock`, `date` and `difftime`. No `io`, no `os.execute` / `os.getenv` /
//!   `os.remove`, no `debug`, no `package` (so no C modules), no `dofile` / `loadfile`, no
//!   `string.dump`, and `load` takes text only (no bytecode).
//! - `require(name)` loads only `<config dir>/name.lua`, `name/init.lua`, or the same under
//!   `lua/` (Neovim's layout), never a path outside the config dir (symlinks included).
//!   `require("roster")` is the API table.
//! - A time budget (an instruction-count hook checks a deadline) and a memory limit, so a loop or
//!   a runaway table can't hang or eat the app.
//!
//! The `roster` table is the start of the Lua API that Plugins get in ticket 23 (ADR 0006):
//! registrations go into the same places as the returned table's values, and from there through
//! the frontend's registries.

use super::schema::Location;
use super::{ConfigError, Env, FILE_NAME, located_message};
use mlua::chunk::ChunkMode;
use mlua::{HookTriggers, Lua, LuaOptions, StdLib, Table, Value, VmState};
use serde_json::{Map, Number, Value as Json};
use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

/// What the API calls registered, by schema path (`keys.leader.x`), with where they were made.
pub(crate) struct ApiEntry {
    pub path: Vec<String>,
    pub value: Json,
    pub at: Option<Location>,
}

pub(crate) struct RunOutput {
    /// The returned table, as JSON (an empty object if the file returned nothing).
    pub value: Json,
    pub api: Vec<ApiEntry>,
    /// Each module the run required, as (its path in the config dir, its text), in load order:
    /// where a value the file didn't set itself may have come from (ticket 140).
    pub modules: Vec<(String, String)>,
}

/// Where `require` writes down the modules a Config run reads (only a Config run sets it).
struct Modules(RefCell<Vec<(String, String)>>);

/// A Lua value that can't become Config data, with where it is in the table.
pub(crate) struct ConvertError {
    pub path: Vec<String>,
    pub message: String,
}

/// The longest text a pattern function takes, the longest pattern, and the biggest
/// `string.rep` result.
const MAX_TEXT: usize = 64 * 1024;
const MAX_PATTERN: usize = 256;
const MAX_REP: usize = 1024 * 1024;

const LOADED: &str = "roster.loaded";
const API: &str = "roster.api";
const LOADING: &str = "\0loading";

/// Runs `source` on a thread of its own, and gives up on it after `env.limits.wall`: a single
/// long C call (a pattern that backtracks) can't be interrupted, so the caller isn't made to wait
/// for it. The abandoned thread ends when the call does, and its result is dropped.
pub(crate) fn run(dir: &Path, source: &str, env: &Env) -> Result<RunOutput, ConfigError> {
    let (tx, rx) = std::sync::mpsc::channel();
    let (dir_owned, source_owned, env_owned) = (dir.to_path_buf(), source.to_string(), *env);
    std::thread::Builder::new()
        .name("init.lua".into())
        .spawn(move || {
            let _ = tx.send(run_here(&dir_owned, &source_owned, &env_owned));
        })
        .map_err(|e| ConfigError::new(None, format!("couldn't start Lua: {e}")))?;
    let wall = env.limits.wall;
    match rx.recv_timeout(wall) {
        Ok(result) => result,
        Err(_) => Err(ConfigError::new(
            None,
            format!(
                "took too long to run (over {} ms; a string pattern that backtracks?)",
                wall.as_millis()
            ),
        )),
    }
}

fn run_here(dir: &Path, source: &str, env: &Env) -> Result<RunOutput, ConfigError> {
    let (lua, clock) = sandboxed(env.limits.memory, Some(dir), FILE_NAME.into()).map_err(internal)?;
    clock.start(env.limits.time);

    let api = Rc::new(RefCell::new(Vec::new()));
    // One budget for everything the run hands over as Config data: the copy is made outside
    // Lua's memory and time limits, and shared subtables are copied once per use.
    let budget = Rc::new(Cell::new(Budget::default()));
    let roster = roster_api(&lua, env, Rc::clone(&api), Rc::clone(&budget)).map_err(internal)?;
    set_api(&lua, roster).map_err(internal)?;
    lua.set_app_data(Modules(RefCell::new(Vec::new())));

    // A block, as Lua runs a file (ticket 138): `eval` would first try `return <file>`, so a
    // one-line `require("x")` would return what the module returned (`true` for nothing).
    let value: Value = lua
        .load(source)
        .set_name(format!("@{FILE_NAME}"))
        .set_mode(ChunkMode::Text)
        .call(())
        .map_err(|e| from_lua_error(&e))?;
    if let Value::Table(t) = &value {
        let packages: Value = t.raw_get("packages").map_err(|e| from_lua_error(&e))?;
        let normal = packages_table(&lua, packages).map_err(|(path, message)| ConfigError {
            file: FILE_NAME.into(),
            line: None,
            message: located_message(&path, &message),
            path,
        })?;
        t.raw_set("packages", normal).map_err(|e| from_lua_error(&e))?;
    }
    let value = match value {
        Value::Nil => Json::Object(Map::new()),
        Value::Table(_) => to_json(&value, &budget).map_err(|e| ConfigError {
            file: FILE_NAME.into(),
            line: None,
            message: located_message(&e.path, &e.message),
            path: e.path,
        })?,
        Value::Boolean(true) => {
            return Err(ConfigError::new(
                None,
                "init.lua returned true (what `require` gives for a module that returns nothing): \
                 leave out the `return`, or return a table"
                    .into(),
            ));
        }
        other => {
            return Err(ConfigError::new(
                None,
                format!("init.lua must return a table (it returned a {})", other.type_name()),
            ));
        }
    };
    let api = std::mem::take(&mut *api.borrow_mut());
    let modules = lua
        .remove_app_data::<Modules>()
        .map(|m| m.0.into_inner())
        .unwrap_or_default();
    Ok(RunOutput { value, api, modules })
}

/// The run time a sandboxed Lua has left: a deadline checked every 1000 instructions. Plugins
/// (ticket 23) start it again for each call into them; the Config starts it once.
pub(crate) struct Clock {
    deadline: Cell<Instant>,
    budget: Cell<Duration>,
    /// Set once the deadline has passed: from then on `pcall` and `xpcall` raise it again.
    timed_out: RefCell<Option<String>>,
}

impl Clock {
    /// A new run of at most `budget`.
    pub(crate) fn start(&self, budget: Duration) {
        self.budget.set(budget);
        self.deadline.set(Instant::now() + budget);
        *self.timed_out.borrow_mut() = None;
    }

    /// Raises running out of time again, once it has: for what can catch an error besides
    /// `pcall` (a Plugin's `coroutine.resume`).
    pub(crate) fn still_in_time(&self) -> mlua::Result<()> {
        match &*self.timed_out.borrow() {
            Some(message) => Err(mlua::Error::runtime(message.clone())),
            None => Ok(()),
        }
    }

    /// Gives back time the run spent waiting outside Lua (a call to roster serve).
    pub(crate) fn extend(&self, by: Duration) {
        self.deadline.set(self.deadline.get() + by);
    }
}

/// A Lua 5.4 state with the sandbox (docs/app/config.md, "The sandbox"): the safe libraries
/// only, `require` from `root` only, a memory limit, and run time kept by the [`Clock`]. `print`
/// goes to stderr after `label`. The caller adds the `roster` table with [`set_api`].
pub(crate) fn sandboxed(memory: usize, root: Option<&Path>, label: String) -> mlua::Result<(Lua, Rc<Clock>)> {
    let lua = Lua::new_with(
        StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8 | StdLib::OS,
        LuaOptions::new(),
    )?;
    lua.set_memory_limit(memory)?;
    let clock = Rc::new(Clock {
        deadline: Cell::new(Instant::now()),
        budget: Cell::new(Duration::ZERO),
        timed_out: RefCell::default(),
    });
    // Running out of time is final: once the deadline has passed, every hook call errors again,
    // and `pcall` / `xpcall` (sandbox) re-raise it, so no Lua code can catch it and carry on.
    let hook_clock = Rc::clone(&clock);
    // A global hook: a coroutine a Plugin creates inherits it (Lua 5.4 copies it to new threads).
    lua.set_global_hook(HookTriggers::new().every_nth_instruction(1000), move |lua, debug| {
        if Instant::now() < hook_clock.deadline.get() {
            return Ok(VmState::Continue);
        }
        let message = hook_clock
            .timed_out
            .borrow_mut()
            .get_or_insert_with(|| {
                let (file, line) = user_frame(lua, debug);
                format!(
                    "{file}:{line}: took longer than {} ms to run (an endless loop?)",
                    hook_clock.budget.get().as_millis()
                )
            })
            .clone();
        Err(mlua::Error::runtime(message))
    })?;
    sandbox(&lua, root, Rc::clone(&clock), label)?;
    Ok((lua, clock))
}

/// Makes `roster` the global and what `require("roster")` returns.
pub(crate) fn set_api(lua: &Lua, roster: Table) -> mlua::Result<()> {
    lua.set_named_registry_value(API, roster.clone())?;
    lua.globals().raw_set("roster", roster)
}

/// An error's own message, without mlua's wrapping and traceback.
pub(crate) fn error_text(e: &mlua::Error) -> String {
    match e {
        mlua::Error::CallbackError { cause, .. } | mlua::Error::WithContext { cause, .. } => error_text(cause),
        mlua::Error::RuntimeError(m) | mlua::Error::SyntaxError { message: m, .. } => m.clone(),
        other => other.to_string(),
    }
}

/// Where the Config's own code is: the running function if it's from a `.lua` file, else the
/// nearest caller that is (the deadline can strike inside the sandbox's own wrappers).
fn user_frame(lua: &Lua, debug: &mlua::debug::Debug) -> (String, i64) {
    let here = |d: &mlua::debug::Debug| {
        let file = d.source().short_src.map(|s| s.to_string())?;
        file.ends_with(".lua")
            .then(|| (file, d.current_line().map_or(0, |l| l as i64)))
    };
    here(debug)
        .or_else(|| (1..64).find_map(|level| lua.inspect_stack(level, here).flatten()))
        .unwrap_or_else(|| (FILE_NAME.into(), 0))
}

fn internal(e: mlua::Error) -> ConfigError {
    ConfigError::new(None, format!("couldn't start Lua: {e}"))
}

/// Takes away what a Config must not have, and adds `require`.
fn sandbox(lua: &Lua, dir: Option<&Path>, clock: Rc<Clock>, label: String) -> mlua::Result<()> {
    // init.lua's modules come from the config dir; a Plugin's from its own folder.
    let place = if label == FILE_NAME {
        "the config dir"
    } else {
        "the Plugin's folder"
    };
    let g = lua.globals();
    for name in ["dofile", "loadfile", "collectgarbage"] {
        g.raw_set(name, Value::Nil)?;
    }
    let os: Table = g.get("os")?;
    let safe_os = lua.create_table()?;
    for f in ["time", "clock", "date", "difftime"] {
        safe_os.raw_set(f, os.raw_get::<Value>(f)?)?;
    }
    g.raw_set("os", safe_os)?;
    let string: Table = g.get("string")?;
    string.raw_set("dump", Value::Nil)?;
    // `load` with text chunks only: bytecode can break out of the VM's checks.
    lua.load(
        r##"local raw = load
        load = function(chunk, name, _, ...)
          if select("#", ...) > 0 then return raw(chunk, name, "t", ...) end
          return raw(chunk, name, "t")
        end"##,
    )
    .set_name("=sandbox")
    .exec()?;
    // `pcall` and `xpcall` can't swallow running out of time: once it has, they raise it again.
    let still_in_time = lua.create_function(move |_, ()| clock.still_in_time())?;
    // An error raised by a `roster.*` function reaches `pcall` as its message, a string, like
    // any Lua error.
    let plain = lua.create_function(|lua, e: Value| match e {
        Value::Error(e) => Ok(Value::String(lua.create_string(error_text(&e))?)),
        other => Ok(other),
    })?;
    lua.load(
        r##"local raw_pcall, raw_xpcall, still_in_time, plain = pcall, xpcall, ...
        local select = select
        local function after(ok, ...)
          still_in_time()
          if ok then return ok, ... end
          return ok, plain((...)), select(2, ...)
        end
        pcall = function(...) return after(raw_pcall(...)) end
        xpcall = function(f, handler, ...)
          return after(raw_xpcall(f, function(e) still_in_time() return handler(plain(e)) end, ...))
        end"##,
    )
    .set_name("=sandbox")
    .call::<()>((still_in_time, plain))?;
    // Patterns and string.rep run as one C call each, which the instruction hook can't stop:
    // keep their sizes to what a Config needs. The watchdog (run) covers what's left.
    lua.load(
        r##"local MAX_TEXT, MAX_PATTERN, MAX_REP = ...
        local error, type, tostring = error, type, tostring
        for _, name in ipairs({ "find", "match", "gmatch", "gsub" }) do
          local raw = string[name]
          string[name] = function(s, p, ...)
            if type(s) == "string" and #s > MAX_TEXT then
              error("string." .. name .. ": the text is over " .. MAX_TEXT .. " bytes", 2)
            end
            if type(p) == "string" and #p > MAX_PATTERN then
              error("string." .. name .. ": the pattern is over " .. MAX_PATTERN .. " bytes", 2)
            end
            return raw(s, p, ...)
          end
        end
        local rep = string.rep
        string.rep = function(s, n, sep)
          if type(n) == "number" and n > 0
            and (#tostring(s) + #tostring(sep or "")) * n > MAX_REP then
            error("string.rep: the result would be over " .. MAX_REP .. " bytes", 2)
          end
          return rep(s, n, sep)
        end"##,
    )
    .set_name("=sandbox")
    .call::<()>((MAX_TEXT, MAX_PATTERN, MAX_REP))?;
    // print goes to the core's stderr (the `tauri dev` console), never to a file.
    g.raw_set(
        "print",
        lua.create_function(move |_, args: mlua::Variadic<Value>| {
            let words: Vec<String> = args
                .iter()
                .map(|v| v.to_string().unwrap_or_else(|_| "?".into()))
                .collect();
            eprintln!("{label}: {}", words.join("\t"));
            Ok(())
        })?,
    )?;

    lua.set_named_registry_value(LOADED, lua.create_table()?)?;
    // No folder (a Plugin's manifest, a built-in Plugin): only `require("roster")`.
    let root = dir.map(|d| d.canonicalize().unwrap_or_else(|_| d.to_path_buf()));
    g.raw_set(
        "require",
        lua.create_function(move |lua, name: String| match &root {
            Some(root) => require(lua, root, &name, place),
            None if name == "roster" => lua.named_registry_value(API),
            None => Err(mlua::Error::runtime(format!(
                "require {name:?}: there's no folder to load it from"
            ))),
        })?,
    )?;
    Ok(())
}

/// The `roster` table: facts about the machine, and registration functions shaped like the
/// Plugin API to come (ticket 23): `roster.keymap.set`, `roster.themes.define`, `roster.set`.
fn roster_api(lua: &Lua, env: &Env, api: Rc<RefCell<Vec<ApiEntry>>>, budget: Rc<Cell<Budget>>) -> mlua::Result<Table> {
    let roster = lua.create_table()?;
    roster.raw_set("os", env.os.as_str())?;
    roster.raw_set("api_version", super::API_VERSION)?;

    let keymap = lua.create_table()?;
    let entries = Rc::clone(&api);
    let left = Rc::clone(&budget);
    keymap.raw_set(
        "set",
        lua.create_function(move |lua, (context, keys, action): (String, String, Value)| {
            if matches!(action, Value::Function(_)) {
                return Err(mlua::Error::runtime(
                    "roster.keymap.set: the action is a command line such as \"close\" (Lua functions as actions come with Plugins)",
                ));
            }
            let value = to_json(&action, &left).map_err(|e| mlua::Error::runtime(e.message))?;
            entries.borrow_mut().push(ApiEntry {
                path: vec!["keys".into(), context, keys],
                value,
                at: caller(lua),
            });
            Ok(())
        })?,
    )?;
    roster.raw_set("keymap", keymap)?;

    let themes = lua.create_table()?;
    let entries = Rc::clone(&api);
    let theme_budget = Rc::clone(&budget);
    themes.raw_set(
        "define",
        lua.create_function(move |lua, (id, theme): (String, Table)| {
            let value = to_json(&Value::Table(theme), &theme_budget)
                .map_err(|e| mlua::Error::runtime(located_message(&e.path, &e.message)))?;
            entries.borrow_mut().push(ApiEntry {
                path: vec!["themes".into(), id],
                value,
                at: caller(lua),
            });
            Ok(())
        })?,
    )?;
    roster.raw_set("themes", themes)?;

    // `roster.set("terminal.size", "16pt")`: any option by its dotted name, under what the
    // returned table sets (`:config import-terminal` writes these, ticket 33).
    let entries = Rc::clone(&api);
    let left = Rc::clone(&budget);
    roster.raw_set(
        "set",
        lua.create_function(move |lua, (name, value): (String, Value)| {
            let path: Vec<String> = name.split('.').map(str::to_string).collect();
            if path.iter().any(|p| p.is_empty()) {
                return Err(mlua::Error::runtime(format!(
                    "roster.set: {name:?} isn't an option name like \"terminal.size\""
                )));
            }
            let value = if name == "packages" {
                packages_table(lua, value).map_err(|(p, m)| mlua::Error::runtime(located_message(&p, &m)))?
            } else {
                value
            };
            let value =
                to_json(&value, &left).map_err(|e| mlua::Error::runtime(located_message(&e.path, &e.message)))?;
            entries.borrow_mut().push(ApiEntry {
                path,
                value,
                at: caller(lua),
            });
            Ok(())
        })?,
    )?;
    Ok(roster)
}

/// `packages` as the schema takes it (ticket 24): each entry written the lazy.nvim way,
/// `{ "owner/repo", tag = … }` or a plain `"owner/repo"`, becomes `{ source = "owner/repo",
/// tag = … }`. Anything else is left for the schema to report. A `config` that's a function is
/// refused here, with a reason: init.lua and each Package run in Lua states of their own, and a
/// function can't move between them (decision Q83).
fn packages_table(lua: &Lua, packages: Value) -> Result<Value, (Vec<String>, String)> {
    let Value::Table(list) = packages else {
        return Ok(packages);
    };
    let at = |i: usize, key: Option<&str>| {
        let mut p = vec!["packages".to_string(), i.to_string()];
        p.extend(key.map(str::to_string));
        p
    };
    let internal = |e: mlua::Error| (vec!["packages".to_string()], e.to_string());
    let out = lua.create_table().map_err(internal)?;
    let len = list.raw_len();
    for i in 1..=len {
        let entry: Value = list.raw_get(i).map_err(internal)?;
        let normal = match entry {
            Value::String(source) => {
                let t = lua.create_table().map_err(internal)?;
                t.raw_set("source", source).map_err(internal)?;
                Value::Table(t)
            }
            Value::Table(spec) => {
                if matches!(spec.raw_get::<Value>("config").map_err(internal)?, Value::Function(_)) {
                    return Err((
                        at(i, Some("config")),
                        "a table of the Package's settings, not a function: a Package runs in a Lua \
                         state of its own, so a function from init.lua can't run there (it reads them \
                         as roster.plugin.config)"
                            .into(),
                    ));
                }
                let first: Value = spec.raw_get(1).map_err(internal)?;
                if first.is_nil() {
                    Value::Table(spec)
                } else {
                    if spec.raw_len() > 1 {
                        return Err((
                            at(i, None),
                            "one source per Package: { \"owner/repo\", tag = … }".into(),
                        ));
                    }
                    let t = lua.create_table().map_err(internal)?;
                    for pair in spec.pairs::<Value, Value>() {
                        let (k, v) = pair.map_err(internal)?;
                        if !matches!(k, Value::Integer(1)) {
                            t.raw_set(k, v).map_err(internal)?;
                        }
                    }
                    if !t.raw_get::<Value>("source").map_err(internal)?.is_nil() {
                        return Err((
                            at(i, Some("source")),
                            "give the source once: first, or as source =".into(),
                        ));
                    }
                    t.raw_set("source", first).map_err(internal)?;
                    Value::Table(t)
                }
            }
            other => other,
        };
        out.raw_set(i, normal).map_err(internal)?;
    }
    // Keys past the list part (a gap, a name) stay, so the schema reports them as it would.
    for pair in list.pairs::<Value, Value>() {
        let (k, v) = pair.map_err(internal)?;
        let in_list = matches!(k, Value::Integer(n) if n >= 1 && (n as usize) <= len);
        if !in_list {
            out.raw_set(k, v).map_err(internal)?;
        }
    }
    Ok(Value::Table(out))
}

/// Where the Lua code that called a Rust function is.
pub(crate) fn caller(lua: &Lua) -> Option<Location> {
    lua.inspect_stack(1, |d| {
        let file = d.source().short_src.map(|s| s.to_string())?;
        let line = u32::try_from(d.current_line()?).ok()?;
        Some(Location { file, line })
    })
    .flatten()
}

fn require(lua: &Lua, root: &Path, name: &str, place: &str) -> mlua::Result<Value> {
    if name == "roster" {
        return lua.named_registry_value(API);
    }
    let valid = !name.is_empty()
        && name
            .split('.')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    if !valid {
        return Err(mlua::Error::runtime(format!(
            "require {name:?}: a module is a name like \"keys\" or \"themes.mine\", found in {place}"
        )));
    }
    let loaded: Table = lua.named_registry_value(LOADED)?;
    match loaded.raw_get::<Value>(name)? {
        Value::Nil => {}
        Value::String(s) if s.to_str().is_ok_and(|s| s == LOADING) => {
            return Err(mlua::Error::runtime(format!(
                "require {name:?}: it requires itself (a loop)"
            )));
        }
        v => return Ok(v),
    }
    let rel = name.replace('.', "/");
    let candidates = [
        format!("{rel}.lua"),
        format!("{rel}/init.lua"),
        format!("lua/{rel}.lua"),
        format!("lua/{rel}/init.lua"),
    ];
    let Some((_, shown)) = candidates.iter().find_map(|c| {
        let p = root.join(c);
        p.is_file().then(|| (p, c.clone()))
    }) else {
        return Err(mlua::Error::runtime(format!(
            "module {name:?} not found in {place} (looked for {})",
            candidates.join(", ")
        )));
    };
    // The one rule for a Plugin's files and the Config's (ticket 82): its real path is inside.
    let real: PathBuf = crate::plugin::folder::inside(root, Path::new(&shown))
        .map_err(|_| mlua::Error::runtime(format!("require {name:?}: {shown} leads outside {place}")))?;
    let source = std::fs::read_to_string(&real)
        .map_err(|e| mlua::Error::runtime(format!("require {name:?}: can't read {shown}: {e}")))?;
    if let Some(modules) = lua.app_data_ref::<Modules>() {
        modules.0.borrow_mut().push((shown.clone(), source.clone()));
    }
    let chunk = lua
        .load(&source)
        .set_name(format!("@{shown}"))
        .set_mode(ChunkMode::Text)
        .into_function()?;
    loaded.raw_set(name, LOADING)?;
    let result = chunk.call::<Value>(name);
    let value = match result {
        Ok(Value::Nil) => Value::Boolean(true),
        Ok(v) => v,
        Err(e) => {
            loaded.raw_set(name, Value::Nil)?;
            return Err(e);
        }
    };
    loaded.raw_set(name, value.clone())?;
    Ok(value)
}

/// How much Config data one run may hand over: far more than any Config needs, and small
/// enough that copying it out of Lua is quick.
#[derive(Clone, Copy)]
pub(crate) struct Budget {
    values: usize,
    bytes: usize,
}

const MAX_VALUES: usize = 100_000;
const MAX_BYTES: usize = 16 * 1024 * 1024;

impl Default for Budget {
    fn default() -> Self {
        Budget {
            values: MAX_VALUES,
            bytes: MAX_BYTES,
        }
    }
}

const TOO_BIG: &str =
    "the Config is too big (more than 100000 values or 16 MB of text; a table shared many times over?)";

/// A Lua value as Config data. Tables become lists (keys 1..n) or objects (string keys); an
/// empty table is an empty object (the schema takes it as an empty list where it wants one).
/// A table used in several places is copied for each; the run's [`Budget`] bounds the total.
pub(crate) fn to_json(v: &Value, budget: &Cell<Budget>) -> Result<Json, ConvertError> {
    convert(v, &mut Vec::new(), &mut Vec::new(), budget, &mut None, false)
}

/// What a Lua function in the data becomes: Plugins (ticket 23) keep it and send its handle.
pub(crate) type OnFunction<'a> = Option<&'a mut dyn FnMut(&mlua::Function) -> Result<Json, String>>;

/// [`to_json`], with `functions` deciding what a Lua function becomes, for text to show: a string
/// value that isn't UTF-8 (a line cut in the middle of a character) gets U+FFFD where it breaks
/// instead of failing the whole conversion (decision Q87). A key that isn't UTF-8 is still refused.
pub(crate) fn to_json_with(v: &Value, budget: &Cell<Budget>, functions: &mut OnFunction) -> Result<Json, ConvertError> {
    convert(v, &mut Vec::new(), &mut Vec::new(), budget, functions, true)
}

fn convert(
    v: &Value,
    path: &mut Vec<String>,
    within: &mut Vec<*const std::ffi::c_void>,
    budget: &Cell<Budget>,
    functions: &mut OnFunction,
    lossy: bool,
) -> Result<Json, ConvertError> {
    let fail = |path: &[String], message: String| ConvertError {
        path: path.to_vec(),
        message,
    };
    if path.len() > 32 {
        return Err(fail(path, "nested too deeply (more than 32 levels)".into()));
    }
    let spend = |path: &[String], bytes: usize| {
        let b = budget.get();
        match (b.values.checked_sub(1), b.bytes.checked_sub(bytes)) {
            (Some(values), Some(bytes)) => {
                budget.set(Budget { values, bytes });
                Ok(())
            }
            _ => Err(fail(path, TOO_BIG.into())),
        }
    };
    let bytes = match v {
        Value::String(s) => s.as_bytes().len(),
        _ => 0,
    };
    spend(path, bytes)?;
    Ok(match v {
        Value::Nil => Json::Null,
        Value::Boolean(b) => Json::Bool(*b),
        Value::Integer(i) => Json::Number((*i).into()),
        Value::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 9.0e15 {
                Json::Number((*n as i64).into())
            } else {
                Number::from_f64(*n)
                    .map(Json::Number)
                    .ok_or_else(|| fail(path, format!("{n} isn't a usable number")))?
            }
        }
        Value::String(s) if lossy => Json::String(s.to_string_lossy()),
        Value::String(s) => Json::String(
            s.to_str()
                .map_err(|_| fail(path, "a string that isn't UTF-8".into()))?
                .to_string(),
        ),
        Value::Table(t) => {
            let ptr = t.to_pointer();
            if within.contains(&ptr) {
                return Err(fail(path, "a table that contains itself".into()));
            }
            within.push(ptr);
            let len = t.raw_len();
            let mut count = 0usize;
            let mut obj = Map::new();
            let mut ints = false;
            for pair in t.pairs::<Value, Value>() {
                let (k, val) = pair.map_err(|e| fail(path, e.to_string()))?;
                count += 1;
                match k {
                    Value::String(s) => {
                        let key = s
                            .to_str()
                            .map_err(|_| fail(path, "a key that isn't UTF-8".into()))?
                            .to_string();
                        spend(path, key.len())?;
                        path.push(key.clone());
                        let j = convert(&val, path, within, budget, functions, lossy)?;
                        path.pop();
                        obj.insert(key, j);
                    }
                    Value::Integer(_) => ints = true,
                    other => {
                        return Err(fail(
                            path,
                            format!("a table key must be a name, not a {}", other.type_name()),
                        ));
                    }
                }
            }
            if ints {
                if count != len || !obj.is_empty() {
                    return Err(fail(
                        path,
                        "a table that mixes a list with named keys (or has gaps): use one or the other".into(),
                    ));
                }
                let mut out = Vec::with_capacity(len);
                for i in 1..=len {
                    path.push(i.to_string());
                    let val: Value = t.raw_get(i).map_err(|e| fail(path, e.to_string()))?;
                    out.push(convert(&val, path, within, budget, functions, lossy)?);
                    path.pop();
                }
                within.pop();
                Json::Array(out)
            } else {
                within.pop();
                Json::Object(obj)
            }
        }
        Value::Function(f) if functions.is_some() => {
            let on = functions.as_mut().expect("checked");
            on(f).map_err(|m| fail(path, m))?
        }
        Value::Function(_) => {
            return Err(fail(
                path,
                "a Lua function can't be a Config value (functions come with Plugins)".into(),
            ));
        }
        other => return Err(fail(path, format!("a {} can't be a Config value", other.type_name()))),
    })
}

/// A Lua error as file, line and message.
pub(crate) fn from_lua_error(e: &mlua::Error) -> ConfigError {
    match e {
        mlua::Error::SyntaxError { message, .. } => parse_message(message),
        mlua::Error::RuntimeError(m) => parse_message(m),
        mlua::Error::CallbackError { traceback, cause } => {
            let mut inner = from_lua_error(cause);
            if inner.line.is_none()
                && let Some((file, line, _)) = traceback.lines().find_map(find_location)
            {
                inner.file = file;
                inner.line = Some(line);
            }
            inner
        }
        mlua::Error::WithContext { cause, .. } => from_lua_error(cause),
        mlua::Error::MemoryError(_) => ConfigError::new(None, "init.lua used too much memory".into()),
        other => parse_message(&other.to_string()),
    }
}

fn parse_message(message: &str) -> ConfigError {
    let text = message.split("\nstack traceback:").next().unwrap_or(message).trim();
    // mlua prefixes some messages ("runtime error: init.lua:3: …").
    match find_location(text) {
        Some((file, line, rest)) => ConfigError {
            file,
            line: Some(line),
            message: rest.trim().to_string(),
            path: Vec::new(),
        },
        None => ConfigError::new(None, text.to_string()),
    }
}

/// The first `name.lua:N:` in `text`: the file, the line, and what follows.
fn find_location(text: &str) -> Option<(String, u32, &str)> {
    let mut from = 0;
    while let Some(i) = text[from..].find(".lua:") {
        let end_name = from + i + 4;
        let start = text[..end_name]
            .rfind(|c: char| c.is_whitespace() || c == '[' || c == '"' || c == '\'')
            .map(|j| j + 1)
            .unwrap_or(0);
        let after = &text[end_name + 1..];
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() && after[digits.len()..].starts_with(':') {
            let file = text[start..end_name].trim_start_matches('@').to_string();
            let rest = &after[digits.len() + 1..];
            return Some((file, digits.parse().ok()?, rest));
        }
        from = end_name;
    }
    None
}
