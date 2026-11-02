//! One Plugin's Lua: the sandbox `init.lua` runs in (config/lua.rs), with the `roster` module
//! built from what the Plugin was granted. It lives on the Plugin's own thread (mod.rs) and is
//! driven by three calls: [`Runtime::load`], [`Runtime::call`] and [`Runtime::event`]. Whatever
//! the Plugin asks of the UI during a call comes back as that call's ops (data, never HTML); a
//! Lua function inside them is kept here and sent as `{ "handler": N }`.

use super::folder::Storage;
use super::network::{self, Answer, Net};
use super::{Builtins, Event, OpenSessions, Outcome, PluginError, Serve, ServeWait, permission::Permission};
use crate::config::lua::{self, Budget, Clock};
use crate::config::{Os, ThemeDef};
use mlua::chunk::ChunkMode;
use mlua::{Function, Lua, Table, Value, Variadic};
use serde_json::{Map, Value as Json, json};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

const HANDLERS: &str = "roster.plugin.handlers";
const LISTENERS: &str = "roster.plugin.listeners";
/// The functions waiting for a `roster.http` or `roster.serve.request` answer, by request id.
const REQUESTS: &str = "roster.plugin.requests";
/// The keys `roster.http.request` takes.
const REQUEST_KEYS: &[&str] = &["url", "method", "headers", "body", "timeout"];
/// How many `roster.serve.request` calls one Plugin may have waiting at once (decision Q103).
pub(crate) const MAX_SERVE_REQUESTS: usize = 8;
/// The most times one call (a load, an event, an answer) may wait for roster serve
/// (`roster.serve.call`, `roster.inventory`), and the most it may wait in all: serve's wait isn't
/// the Plugin's time (Q103), so without these a call asking serve in a loop would never run out of
/// time and would keep serve from the app. 300 s is serve's
/// own longest deadline for one method, so one call merely queued behind a Publish still gets its
/// answer; a call that passes either gets an error.
pub(crate) const MAX_SERVE_CALLS: u32 = 100;
pub(crate) const MAX_SERVE_WAIT: Duration = Duration::from_secs(300);
/// The most UI ops one call may produce.
pub(crate) const MAX_OPS: usize = 1000;
/// The most text `roster.clipboard.copy` takes.
const MAX_COPY: usize = 64 * 1024;
/// The most Lua functions a Plugin may have handed over at once.
const MAX_HANDLERS: usize = 10_000;
/// The most timers a Plugin may have waiting at once.
pub(crate) const MAX_TIMERS: usize = 100;
/// The soonest a deferred function runs, and how often a repeating one may: a Plugin's timers
/// share its one thread with everything the user does with it, so they can't take it over.
pub(crate) const DEFER_MIN_MS: u64 = 50;
pub(crate) const EVERY_MIN_MS: u64 = 1000;
/// The longest a timer may wait (the most a browser's setTimeout takes).
const TIMER_MAX_MS: f64 = 2_147_483_647.0;

/// `pairs` for Plugins: number keys in order, then string keys in order, then the rest, so the
/// same state makes the same ops in the same order (decision Q96). A table's `__pairs` still wins.
const SORTED_PAIRS: &str = r#"
local next, type, sort, getmetatable, rawget = next, type, table.sort, getmetatable, rawget
local rank = { number = 1, string = 2, boolean = 3 }
local function before(a, b)
  local ta, tb = type(a), type(b)
  if ta == tb then
    if ta == "number" or ta == "string" then return a < b end
    if ta == "boolean" then return (not a) and b end
    return false
  end
  return (rank[ta] or 4) < (rank[tb] or 4)
end
pairs = function(t)
  local mt = getmetatable(t)
  if type(mt) == "table" and mt.__pairs then return mt.__pairs(t) end
  if type(t) ~= "table" then error("bad argument #1 to 'pairs' (table expected, got " .. type(t) .. ")", 2) end
  -- The order is fixed; the cost is kept down: a sequence (1..n, as the array part gives it) is in
  -- order already, and keys all numbers or all strings sort with Lua's own comparison.
  local keys, n, kind, ordered = {}, 0, nil, true
  for k in next, t do
    n = n + 1
    keys[n] = k
    if k ~= n then ordered = false end
    local tk = type(k)
    if kind == nil then kind = tk elseif kind ~= tk then kind = false end
  end
  if not ordered then
    if kind == "number" or kind == "string" then sort(keys) else sort(keys, before) end
  end
  local i = 0
  return function()
    while i < n do
      i = i + 1
      local k = keys[i]
      local v = rawget(t, k)
      if v ~= nil then return k, v end
    end
    return nil
  end, t, nil
end
"#;

/// The events a Plugin can subscribe to, and the permissions that let it (any one of them, as a
/// manifest writes it; none listed means every Plugin may).
pub const EVENTS: &[(&str, &[&str])] = &[
    ("lock", &[]),
    ("unlock", &[]),
    ("host_selected", &["inventory.read", "terminal.read"]),
    ("session_open", &["inventory.read", "terminal.read"]),
    ("session_exit", &["inventory.read", "terminal.read"]),
    ("inventory_changed", &["inventory.read"]),
    ("terminal_output", &["terminal.read"]),
    ("command_done", &["terminal.read"]),
    (
        "job_progress",
        &["serve:mesh.job", "serve:discover.status", "serve:host.check_job"],
    ),
];

/// The kinds of serve's jobs a `job_progress` event can be about, and the permission that lets a
/// Plugin hear one (decision Q112f): the method it would ask about that job with anyway, so the
/// event tells it nothing a poll wouldn't. A Host's check (ticket 108) is heard with the read
/// `serve:host.check_job`, not `serve:host.check`, which a listener could never call (user-call only).
pub const JOB_KINDS: &[(&str, &str)] = &[
    ("mesh", "serve:mesh.job"),
    ("discover", "serve:discover.status"),
    ("check", "serve:host.check_job"),
];

/// Whether a Plugin with `grants` may get `event`.
pub(crate) fn may_hear(event: &str, grants: &BTreeSet<Permission>) -> Result<(), String> {
    let granted = |p: &str| grants.iter().any(|g| g.to_string() == p);
    match EVENTS.iter().find(|(name, _)| *name == event) {
        None => Err(format!(
            "there's no event {event:?} (there's {})",
            EVENTS.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", ")
        )),
        Some((_, [])) => Ok(()),
        Some((_, needs)) if needs.iter().any(|p| granted(p)) => Ok(()),
        Some((_, needs)) => Err(format!("the {event} event needs the {} permission", needs.join(" or "))),
    }
}

/// The events whose payload is roster serve's own text (`job_progress` is its `job.progress`
/// notification, a failed job's error message included), cut as its answers are (Q92). The
/// others carry the app's ids and Host names, or a Session's output, which isn't serve's.
const FROM_SERVE: &[&str] = &["job_progress"];

/// `event`'s payload as a Plugin gets it: serve's text with its `cmd:`/`env:` references cut.
pub(crate) fn heard_payload(event: &str, mut payload: Json) -> Json {
    if FROM_SERVE.contains(&event) {
        redact(&mut payload);
    }
    payload
}

/// Whether a Plugin with `grants` may get this `event` with this `payload`: a `job_progress` only
/// for a kind of job it may ask about ([`JOB_KINDS`]).
pub(crate) fn may_hear_this(event: &str, payload: &Json, grants: &BTreeSet<Permission>) -> bool {
    if may_hear(event, grants).is_err() {
        return false;
    }
    if event != "job_progress" {
        return true;
    }
    let kind = payload.get("kind").and_then(Json::as_str);
    JOB_KINDS
        .iter()
        .any(|(k, p)| Some(*k) == kind && grants.iter().any(|g| g.to_string() == *p))
}

/// The Inventory write methods `inventory.write` gives, by their Lua name: every one of them
/// lands as a Pending change; Publish is never one of them.
const WRITES: &[(&str, &str, &[&str])] = &[
    ("update", "host.update", &["host", "changes"]),
    ("rename", "host.rename", &["host", "to"]),
    ("move", "host.move", &["host", "group"]),
    ("review", "host.review", &["host", "reviewed"]),
];

struct Shared {
    plugin: String,
    grants: BTreeSet<Permission>,
    serve: Arc<dyn Serve>,
    clock: Rc<Clock>,
    ops: RefCell<Vec<Json>>,
    budget: Cell<Budget>,
    handlers: RefCell<Handlers>,
    /// Whether the run is a call the user started (an action, a command, a finder item): only
    /// then may the Plugin put text on the clipboard, ask a question or run a command line.
    user_call: Cell<bool>,
    /// The commands the Plugin added (`roster.commands.add`): `roster.cmd` may run them.
    commands: RefCell<BTreeSet<String>>,
    /// The app's built-in commands ([`super::PluginHost::set_builtins`]): never the Plugin's own.
    builtins: Builtins,
    /// Its HTTP client, with a `network:` grant (network.rs).
    net: Option<Net>,
    /// Where an answer goes: to the host, which runs it on this Plugin's thread.
    post: Option<Post>,
    next_request: Cell<u64>,
    /// The `roster.serve.request` (and `roster.inventory.request`) calls waiting, by request id:
    /// what asked, as its error names it (`roster.serve.request hosts.list`), and whether it was
    /// made in a call the user started (its answer runs as part of that call, decision Q103).
    serving_requests: RefCell<HashMap<u64, (String, bool)>>,
    /// Whether the run carries the user's call one hop (a request's answer, or a command
    /// `roster.cmd` ran): a request or a command line made in it doesn't carry the call further.
    carried: Cell<bool>,
    /// The timers waiting, by their handler: whether each repeats.
    timers: RefCell<HashMap<u64, bool>>,
    /// The handlers that run as the app asks, not as the user's call: a command's `complete`, a
    /// finder's `items`, a `:check` section's `check`.
    quiet: RefCell<BTreeSet<u64>>,
    /// Its data folder (`roster.storage`, decision Q93): None when the host has no data folder.
    storage: Option<Result<Storage, String>>,
    /// How long this thread has waited for roster serve: the host doesn't count it.
    serving: Arc<ServeWait>,
    /// During a run, the handlers it let go of: gone only once it succeeds, since a failed run's
    /// ops never reach the app, which still shows (and calls) what they replaced.
    dropping: RefCell<Option<Vec<u64>>>,
    /// This run's calls into roster serve so far, and how long they waited in all.
    served: Cell<(u32, Duration)>,
    /// The Sessions open now (`roster.sessions.list`), the host's.
    sessions: Arc<OpenSessions>,
    /// This run's `hosts.list` answer, once a `roster.inventory` read has asked for it: the
    /// other reads of the run use it rather than ask again (decision Q127). A write forgets it.
    host_list: RefCell<Option<Json>>,
    /// The clock a wait for roster serve is measured on in tests, which fake it (`Instant::now`
    /// otherwise).
    #[cfg(test)]
    serve_clock: Cell<fn() -> Instant>,
}

/// What a run may change in the core, as it was before: put back when the run fails, as its ops
/// are dropped (the iteration 8 review: a failed call left timers that never reached the app
/// counting toward the cap, and the buttons it replaced dead).
struct Before {
    handlers: Handlers,
    timers: HashMap<u64, bool>,
    commands: BTreeSet<String>,
    quiet: BTreeSet<u64>,
}

/// Whose call a run is (decision Q98, issue #183).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum By {
    /// The user chose it: a command, a key, a row's or button's action, a finder item, a toolbar
    /// control, a question's answer.
    User,
    /// The Plugin's own command its `roster.cmd` ran from the user's call: that call carried one
    /// hop, as a `roster.serve.request`'s answer is (Q103d), so nothing made in it carries it on.
    Carried,
    /// The app's doing, never the user's call.
    App,
}

/// Hands a request's answer back to the host (request id, answer), from a network or serve thread.
pub(crate) type Post = Arc<dyn Fn(u64, Arrival) + Send + Sync>;

/// A request's answer: from the network (`roster.http`), or from roster serve
/// (`roster.serve.request`, redacted already).
pub(crate) enum Arrival {
    Http(Answer),
    Serve(Result<Json, String>),
}

/// A handler's number carries its load's generation above these bits (ticket 85), so an id
/// from before a reload (a late timer, a queued click) can't name a function of the new load.
/// 2^32 handlers a load, and the ids stay below 2^53, a whole number to JavaScript, for 2^21 loads.
const HANDLER_BITS: u32 = 32;

#[derive(Default, Clone)]
struct Handlers {
    /// The last handler's number: the load's generation in the high bits.
    next: u64,
    /// Which handlers each owner (a section, a command, a call's result) handed over, so setting
    /// the owner again drops the old ones.
    owners: HashMap<String, Vec<u64>>,
    count: usize,
}

pub(crate) struct Runtime {
    lua: Lua,
    shared: Rc<Shared>,
    budget: Duration,
}

impl Runtime {
    #[allow(clippy::too_many_arguments)] // each is one fact about the Plugin, from its own place
    pub(crate) fn new(
        plugin: &str,
        version: &str,
        dir: &Path,
        config: &Json,
        grants: BTreeSet<Permission>,
        serve: Arc<dyn Serve>,
        memory: usize,
        budget: Duration,
        post: Option<Post>,
        offline: bool,
        storage: Option<Result<Storage, String>>,
        serving: Arc<ServeWait>,
        generation: u64,
        network: network::Setup,
        sessions: Arc<OpenSessions>,
        builtins: Builtins,
    ) -> Result<Runtime, PluginError> {
        let fail = |e: mlua::Error| PluginError::new(plugin, None, None, format!("couldn't start Lua: {e}"));
        let sites: Vec<network::Site> = grants
            .iter()
            .filter_map(|p| match p {
                Permission::Network(site) => Some(site.clone()),
                _ => None,
            })
            .collect();
        let net = if sites.is_empty() {
            None
        } else if offline {
            Some(Net::offline(sites, network).map_err(|e| PluginError::new(plugin, None, None, e))?)
        } else {
            Some(Net::new(sites, network).map_err(|e| PluginError::new(plugin, None, None, e))?)
        };
        let (lua, clock) =
            lua::sandboxed(memory, (!dir.as_os_str().is_empty()).then_some(dir), plugin.to_string()).map_err(fail)?;
        let shared = Rc::new(Shared {
            plugin: plugin.to_string(),
            grants,
            serve,
            clock,
            ops: RefCell::default(),
            budget: Cell::new(Budget::default()),
            handlers: RefCell::new(Handlers {
                next: generation << HANDLER_BITS,
                ..Handlers::default()
            }),
            user_call: Cell::new(false),
            commands: RefCell::default(),
            builtins,
            net,
            post,
            next_request: Cell::new(0),
            serving_requests: RefCell::default(),
            carried: Cell::new(false),
            timers: RefCell::default(),
            quiet: RefCell::default(),
            storage,
            serving,
            dropping: RefCell::default(),
            served: Cell::default(),
            sessions,
            host_list: RefCell::default(),
            #[cfg(test)]
            serve_clock: Cell::new(Instant::now),
        });
        lua.set_named_registry_value(HANDLERS, lua.create_table().map_err(fail)?)
            .map_err(fail)?;
        lua.set_named_registry_value(LISTENERS, lua.create_table().map_err(fail)?)
            .map_err(fail)?;
        coroutines(&lua, &shared.clock).map_err(fail)?;
        lua.set_named_registry_value(REQUESTS, lua.create_table().map_err(fail)?)
            .map_err(fail)?;
        lua.load(SORTED_PAIRS)
            .set_name("=pairs")
            .set_mode(ChunkMode::Text)
            .exec()
            .map_err(fail)?;
        let roster = api(&lua, &shared, version, config).map_err(fail)?;
        lua::set_api(&lua, roster).map_err(fail)?;
        Ok(Runtime { lua, shared, budget })
    }

    /// Runs the Plugin's `init.lua`, within `budget`.
    pub(crate) fn load(&self, source: &str, budget: Duration) -> Outcome {
        self.run(budget, |lua| {
            lua.load(source)
                .set_name("@init.lua")
                .set_mode(ChunkMode::Text)
                .exec()
                .map(|()| Json::Null)
        })
    }

    /// Calls a function the Plugin handed over, with `args`; its return value comes back as data.
    /// It's the user's call only when `user` (they chose it) and the handler isn't one the app
    /// runs as it likes: a timer, a command's `complete`, a finder's `items`, a `:check` section's
    /// `check`. Carried (`By::Carried`), it's the user's call one hop on, so nothing made in it
    /// carries the call further. A deferred timer's function is gone once it has run.
    pub(crate) fn call(&self, handler: u64, args: &Json, by: By) -> Outcome {
        let shared = Rc::clone(&self.shared);
        let timer = self.shared.timers.borrow().get(&handler).copied();
        let quiet = self.shared.quiet.borrow().contains(&handler);
        let user = by != By::App && timer.is_none() && !quiet;
        self.shared.user_call.set(user);
        self.shared.carried.set(user && by == By::Carried);
        // A deferred timer is gone before it runs, so it can defer itself again; gone whether its
        // run succeeds or not, as the app has let go of it already.
        let taken = match timer {
            Some(false) => Some(take_timer(&self.lua, &self.shared, handler)),
            _ => None,
        };
        let outcome = self.run(self.budget, move |lua| {
            let f: Option<Function> = match taken {
                Some(f) => f?,
                None => lua.named_registry_value::<Table>(HANDLERS)?.raw_get(handler)?,
            };
            let Some(f) = f else {
                return Err(mlua::Error::runtime(format!(
                    "\0stale:handler {handler} is gone (the Plugin replaced it)"
                )));
            };
            let value: Value = f.call(to_lua(lua, args)?)?;
            data(
                lua,
                &shared,
                "the value it returned",
                &value,
                &format!("call:{handler}"),
            )
        });
        self.shared.user_call.set(false);
        self.shared.carried.set(false);
        outcome
    }

    /// Runs each listener for `event` (the caller has checked the Plugin may hear it).
    pub(crate) fn event(&self, event: &Event) -> Outcome {
        self.run(self.budget, |lua| {
            let listeners: Table = lua.named_registry_value(LISTENERS)?;
            let Some(list) = listeners.raw_get::<Option<Table>>(event.name.as_str())? else {
                return Ok(Json::Null);
            };
            let payload = to_lua(lua, &event.payload)?;
            for f in list.sequence_values::<Function>() {
                f?.call::<()>(payload.clone())?;
            }
            Ok(Json::Null)
        })
    }

    /// Calls the function waiting for request `id` with its answer: `(response)` or `(nil, why)`.
    /// A serve request's answer runs as part of the user's call when the request was made in one.
    pub(crate) fn answer(&self, id: u64, arrival: Arrival) -> Outcome {
        let answer = match arrival {
            Arrival::Http(answer) => answer,
            Arrival::Serve(result) => return self.served(id, result),
        };
        self.run(self.budget, move |lua| {
            let requests: Table = lua.named_registry_value(REQUESTS)?;
            let Some(done) = requests.raw_get::<Option<Function>>(id)? else {
                return Ok(Json::Null);
            };
            requests.raw_set(id, Value::Nil)?;
            match answer {
                Answer::Response {
                    status,
                    url,
                    headers,
                    body,
                } => {
                    let res = lua.create_table()?;
                    res.raw_set("status", status)?;
                    res.raw_set("url", url)?;
                    let h = lua.create_table()?;
                    for (name, value) in headers {
                        h.raw_set(name, lua.create_string(value)?)?;
                    }
                    res.raw_set("headers", h)?;
                    res.raw_set("body", lua.create_string(body)?)?;
                    done.call::<()>(res)?;
                }
                Answer::Failed(why) => done.call::<()>((Value::Nil, why))?,
            }
            Ok(Json::Null)
        })
    }

    /// Calls the function waiting for serve request `id` with `result`: `(result)` or `(nil, why)`.
    fn served(&self, id: u64, result: Result<Json, String>) -> Outcome {
        let Some((what, user)) = self.shared.serving_requests.borrow_mut().remove(&id) else {
            return self.run(self.budget, |_| Ok(Json::Null));
        };
        self.shared.user_call.set(user);
        self.shared.carried.set(user);
        let outcome = self.run(self.budget, move |lua| {
            let requests: Table = lua.named_registry_value(REQUESTS)?;
            let Some(done) = requests.raw_get::<Option<Function>>(id)? else {
                return Ok(Json::Null);
            };
            requests.raw_set(id, Value::Nil)?;
            match result {
                Ok(v) => done.call::<()>(to_lua(lua, &v)?)?,
                Err(why) => done.call::<()>((Value::Nil, format!("{what}: {why}")))?,
            }
            Ok(Json::Null)
        });
        self.shared.user_call.set(false);
        self.shared.carried.set(false);
        outcome
    }

    /// Whether the Plugin listens for `event`.
    pub(crate) fn listens(&self, event: &str) -> bool {
        self.lua
            .named_registry_value::<Table>(LISTENERS)
            .and_then(|t| t.raw_get::<Option<Table>>(event))
            .is_ok_and(|l| l.is_some_and(|l| l.raw_len() > 0))
    }

    pub(crate) fn grants(&self) -> &BTreeSet<Permission> {
        &self.shared.grants
    }

    fn run(&self, budget: Duration, body: impl FnOnce(&Lua) -> mlua::Result<Json>) -> Outcome {
        self.shared.clock.start(budget);
        self.shared.budget.set(Budget::default());
        self.shared.served.set(Default::default());
        self.shared.ops.borrow_mut().clear();
        let s = &self.shared;
        let before = Before {
            handlers: s.handlers.borrow().clone(),
            timers: s.timers.borrow().clone(),
            commands: s.commands.borrow().clone(),
            quiet: s.quiet.borrow().clone(),
        };
        *s.dropping.borrow_mut() = Some(Vec::new());
        let result = body(&self.lua);
        let dropped = s.dropping.borrow_mut().take().unwrap_or_default();
        // The run's Inventory read is its own: the next run asks again, and nothing big is kept.
        s.host_list.borrow_mut().take();
        let settled = match &result {
            Ok(_) => dropped.into_iter().try_for_each(|id| forget(&self.lua, s, id)),
            Err(_) => self.undo(before),
        };
        let result = result.and_then(|v| settled.map(|()| v));
        let ops = std::mem::take(&mut *self.shared.ops.borrow_mut());
        match result {
            Ok(result) => Outcome {
                result,
                ops,
                error: None,
                stale: false,
            },
            Err(e) => {
                let text = e.to_string();
                let stale = text.contains("\0stale:");
                let error = if stale {
                    PluginError::new(
                        &self.shared.plugin,
                        None,
                        None,
                        "that action is gone: the Plugin replaced it".into(),
                    )
                } else {
                    plugin_error(&self.shared.plugin, &e)
                };
                // A failed call's UI changes are dropped: half an update is worse than none.
                Outcome {
                    result: Json::Null,
                    ops: Vec::new(),
                    error: Some(error),
                    stale,
                }
            }
        }
    }
}

impl Runtime {
    /// Puts the core back as it was before a failed run: the functions it handed over are let
    /// go, the ones it replaced kept, and its timers, commands and quiet handlers as they were.
    /// What Lua itself changed (a variable, a listener) stays, as a failed `init.lua`'s would.
    fn undo(&self, before: Before) -> mlua::Result<()> {
        let s = &self.shared;
        let made = (before.handlers.next + 1)..=s.handlers.borrow().next;
        let table: Table = self.lua.named_registry_value(HANDLERS)?;
        for id in made {
            table.raw_set(id, Value::Nil)?;
        }
        *s.handlers.borrow_mut() = before.handlers;
        *s.timers.borrow_mut() = before.timers;
        *s.commands.borrow_mut() = before.commands;
        *s.quiet.borrow_mut() = before.quiet;
        Ok(())
    }
}

/// Lets handler `id` go: at once outside a run, else once the run has succeeded.
fn let_go(lua: &Lua, shared: &Shared, id: u64) -> mlua::Result<()> {
    match shared.dropping.borrow_mut().as_mut() {
        Some(later) => {
            later.push(id);
            Ok(())
        }
        None => forget(lua, shared, id),
    }
}

/// Handler `id` is gone: its function, and its place among the quiet ones.
fn forget(lua: &Lua, shared: &Shared, id: u64) -> mlua::Result<()> {
    shared.quiet.borrow_mut().remove(&id);
    lua.named_registry_value::<Table>(HANDLERS)?.raw_set(id, Value::Nil)
}

/// `coroutine` (api 3), which Neovim authors expect: within the same memory limit and time budget.
/// The instruction hook follows a coroutine (Lua 5.4 threads inherit it), and `resume` and
/// `close`, which catch errors as `pcall` does, can't swallow running out of time either.
fn coroutines(lua: &Lua, clock: &Rc<Clock>) -> mlua::Result<()> {
    lua.load_std_libs(mlua::StdLib::COROUTINE)?;
    let clock = Rc::clone(clock);
    let still_in_time = lua.create_function(move |_, ()| clock.still_in_time())?;
    lua.load(
        r##"local still_in_time = ...
        local resume, close = coroutine.resume, coroutine.close
        local function after(...) still_in_time() return ... end
        coroutine.resume = function(...) return after(resume(...)) end
        coroutine.close = function(...) return after(close(...)) end"##,
    )
    .set_name("=sandbox")
    .call::<()>(still_in_time)
}

fn plugin_error(plugin: &str, e: &mlua::Error) -> PluginError {
    if matches!(root_cause(e), mlua::Error::MemoryError(_)) {
        return PluginError::new(plugin, None, None, "used too much memory".into());
    }
    let c = lua::from_lua_error(e);
    let file = if c.file.is_empty() { None } else { Some(c.file) };
    PluginError::new(plugin, file, c.line, c.message)
}

fn root_cause(e: &mlua::Error) -> &mlua::Error {
    match e {
        mlua::Error::CallbackError { cause, .. } | mlua::Error::WithContext { cause, .. } => root_cause(cause),
        other => other,
    }
}

/// A Lua value as UI data: functions become `{ "handler": N }`, owned by `owner` (handing over
/// data for the same owner again drops its earlier functions). Errors start with `what`, the
/// function it was handed to.
fn data(lua: &Lua, shared: &Shared, what: &str, value: &Value, owner: &str) -> mlua::Result<Json> {
    let handlers: Table = lua.named_registry_value(HANDLERS)?;
    let old = shared.handlers.borrow_mut().owners.remove(owner).unwrap_or_default();
    for id in &old {
        let_go(lua, shared, *id)?;
    }
    shared.handlers.borrow_mut().count -= old.len();
    let mut ids = Vec::new();
    let mut keep = |f: &Function| -> Result<Json, String> {
        let mut h = shared.handlers.borrow_mut();
        if h.count >= MAX_HANDLERS {
            return Err(format!("more than {MAX_HANDLERS} functions handed to roster at once"));
        }
        h.next += 1;
        h.count += 1;
        let id = h.next;
        handlers.raw_set(id, f.clone()).map_err(|e| e.to_string())?;
        ids.push(id);
        Ok(json!({ "handler": id }))
    };
    let out = lua::to_json_with(value, &shared.budget, &mut Some(&mut keep));
    shared.handlers.borrow_mut().owners.insert(owner.to_string(), ids);
    out.map_err(|e| convert_error(what, &e))
}

/// Drops the functions every owner `which` picks handed over (a view or a Host-details section
/// taken away).
fn drop_owners(lua: &Lua, shared: &Shared, which: impl Fn(&str) -> bool) -> mlua::Result<()> {
    let ids: Vec<u64> = {
        let mut h = shared.handlers.borrow_mut();
        let owners: Vec<String> = h.owners.keys().filter(|k| which(k)).cloned().collect();
        let ids: Vec<u64> = owners
            .iter()
            .flat_map(|o| h.owners.remove(o).unwrap_or_default())
            .collect();
        h.count -= ids.len();
        ids
    };
    ids.into_iter().try_for_each(|id| let_go(lua, shared, id))
}

/// A view's spec without its table's `actions`, and those actions (`nil` for none). The
/// Plugin's own tables are copied, not changed.
fn table_actions(lua: &Lua, spec: &Table) -> mlua::Result<(Table, Value)> {
    let Ok(Value::Table(table)) = spec.raw_get::<Value>("table") else {
        return Ok((spec.clone(), Value::Nil));
    };
    let actions: Value = table.raw_get("actions")?;
    if actions.is_nil() {
        return Ok((spec.clone(), Value::Nil));
    }
    let copy = |t: &Table, leave: &str| -> mlua::Result<Table> {
        let out = lua.create_table()?;
        for pair in t.pairs::<Value, Value>() {
            let (k, v) = pair?;
            if !matches!(&k, Value::String(k) if k.as_bytes().as_ref() == leave.as_bytes()) {
                out.raw_set(k, v)?;
            }
        }
        Ok(out)
    };
    let (out, inner) = (copy(spec, "")?, copy(&table, "actions")?);
    out.raw_set("table", inner)?;
    Ok((out, actions))
}

/// A Lua value as data for roster serve: no functions.
fn plain(shared: &Shared, what: &str, v: &Value) -> mlua::Result<Json> {
    lua::to_json(v, &shared.budget).map_err(|e| convert_error(what, &e))
}

/// `roster.sidebar.set: rows.3.label: a thread can't be a Plugin value`.
fn convert_error(what: &str, e: &lua::ConvertError) -> mlua::Error {
    let at = if e.path.is_empty() {
        String::new()
    } else {
        format!("{}: ", e.path.join("."))
    };
    let message = e
        .message
        .replace(
            "a Lua function can't be a Config value (functions come with Plugins)",
            "a Lua function can't go to roster serve",
        )
        .replace("can't be a Config value", "can't be a Plugin value");
    mlua::Error::runtime(format!("{what}: {at}{message}"))
}

/// Takes timer `id` out (and its function, returned): it won't run again.
fn take_timer(lua: &Lua, shared: &Shared, id: u64) -> mlua::Result<Option<Function>> {
    shared.timers.borrow_mut().remove(&id);
    let f: Option<Function> = lua.named_registry_value::<Table>(HANDLERS)?.raw_get(id)?;
    {
        let mut h = shared.handlers.borrow_mut();
        if h.owners.remove(&format!("timer:{id}")).is_some() {
            h.count -= 1;
        }
    }
    let_go(lua, shared, id)?;
    Ok(f)
}

/// Adds a timer that runs `f` after `ms` (again every `ms` when `every`); its id is its handler.
fn add_timer(lua: &Lua, shared: &Shared, what: &str, ms: f64, f: Function, every: bool) -> mlua::Result<u64> {
    if !ms.is_finite() || !(0.0..=TIMER_MAX_MS).contains(&ms) {
        return Err(mlua::Error::runtime(format!(
            "{what}: ms must be a number of milliseconds from 0 to {TIMER_MAX_MS}"
        )));
    }
    let ms = ms.ceil() as u64;
    if every && ms < EVERY_MIN_MS {
        return Err(mlua::Error::runtime(format!(
            "{what}: at least {EVERY_MIN_MS} ms between runs (use roster.defer for once, soon)"
        )));
    }
    if shared.timers.borrow().len() >= MAX_TIMERS {
        return Err(mlua::Error::runtime(format!(
            "{what}: more than {MAX_TIMERS} timers waiting at once (roster.cancel the ones you don't need)"
        )));
    }
    let ms = ms.max(DEFER_MIN_MS);
    let id = {
        let mut h = shared.handlers.borrow_mut();
        if h.count >= MAX_HANDLERS {
            return Err(mlua::Error::runtime(format!(
                "{what}: more than {MAX_HANDLERS} functions handed to roster at once"
            )));
        }
        h.next += 1;
        h.count += 1;
        let id = h.next;
        h.owners.insert(format!("timer:{id}"), vec![id]);
        id
    };
    lua.named_registry_value::<Table>(HANDLERS)?.raw_set(id, f)?;
    shared.timers.borrow_mut().insert(id, every);
    push(
        shared,
        json!({ "op": "timer", "id": id.to_string(), "ms": ms, "every": every, "run": { "handler": id } }),
    )?;
    Ok(id)
}

fn push(shared: &Shared, op: Json) -> mlua::Result<()> {
    let mut ops = shared.ops.borrow_mut();
    if ops.len() >= MAX_OPS {
        return Err(mlua::Error::runtime(format!(
            "more than {MAX_OPS} UI changes in one go"
        )));
    }
    ops.push(op);
    Ok(())
}

fn check_id(what: &str, id: &str) -> mlua::Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(mlua::Error::runtime(format!(
            "{what}: {id:?} isn't a name like \"recent-alerts\" (lower case letters, digits, - _ .; at most 64)"
        )))
    }
}

/// Why a call refused something only the user's call may do.
const USER_ONLY: &str = "only while the user runs one of your actions, commands or finder items";

/// Errors unless the run is a call the user started (an action, a command, a finder item).
fn user_only(shared: &Shared, what: &str) -> mlua::Result<()> {
    if shared.user_call.get() {
        Ok(())
    } else {
        Err(mlua::Error::runtime(format!("{what}: {USER_ONLY}")))
    }
}

/// `opts.quiet`, when a Plugin gives it (`roster.echo`, `roster.notify`; api 4): true, false or
/// left out.
fn quiet_opt(opts: Option<&Table>, what: &str) -> mlua::Result<Option<bool>> {
    let Some(t) = opts else { return Ok(None) };
    match t.raw_get::<Value>("quiet")? {
        Value::Nil => Ok(None),
        Value::Boolean(b) => Ok(Some(b)),
        _ => Err(mlua::Error::runtime(format!("{what}: quiet is true or false"))),
    }
}

/// Whether `word` is one of the Plugin's own commands: one it added that no built-in has. Not one
/// the app says it has ([`Shared::builtins`]), one of roster's a Plugin may run
/// ([`super::api::COMMANDS`], which keep the permission they need), nor one that changes trust or
/// writes ([`super::api::ROSTER_ONLY`], refused even before the app has said).
fn own_command(s: &Shared, word: &str) -> bool {
    s.commands.borrow().contains(word)
        && !super::api::ROSTER_ONLY.contains(&word)
        && !super::api::COMMANDS.iter().any(|c| c.name == word)
        && s.builtins
            .read()
            .is_ok_and(|b| b.as_ref().is_some_and(|b| !b.contains(word)))
}

/// Why `word`, a command the Plugin added, can't run yet: the app hasn't told the core its
/// built-in commands, so it can't tell the Plugin's own from roster's (issue #184). None once it
/// has, or for a word that isn't the Plugin's or is one of roster's either way.
fn not_yet(s: &Shared, word: &str) -> Option<String> {
    let unknown = s.builtins.read().map_or(true, |b| b.is_none());
    (unknown
        && s.commands.borrow().contains(word)
        && !super::api::ROSTER_ONLY.contains(&word)
        && !super::api::COMMANDS.iter().any(|c| c.name == word))
    .then(|| format!(":{word} can't run yet: the app hasn't told roster its own commands"))
}

/// Whether a Plugin with `grants` may run roster's command `word` (api.rs's COMMANDS). Its own
/// commands are the caller's to allow.
pub(crate) fn command_allowed(word: &str, grants: &BTreeSet<Permission>) -> Result<(), String> {
    let Some(rule) = super::api::COMMANDS.iter().find(|c| c.name == word) else {
        return Err(format!(
            ":{word} isn't one a Plugin may run (its own commands, and {})",
            super::api::COMMANDS
                .iter()
                .map(|c| c.name)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    };
    match rule.needs {
        super::api::Needs::Permission(p) if !Permission::parse(p).is_ok_and(|p| grants.contains(&p)) => {
            Err(format!(":{word} needs the {p} permission"))
        }
        super::api::Needs::AnyServe | super::api::Needs::Hears(_) => Err(format!(":{word} isn't one a Plugin may run")),
        _ => Ok(()),
    }
}

fn need(shared: &Shared, p: &Permission, what: &str) -> mlua::Result<()> {
    if shared.grants.contains(p) {
        Ok(())
    } else {
        Err(mlua::Error::runtime(format!("{what}: not granted ({p})")))
    }
}

/// Calls roster serve, giving the time spent waiting back to the Plugin's run.
fn serve(lua: &Lua, shared: &Shared, what: &str, method: &str, params: Json) -> mlua::Result<Value> {
    answer(lua, what, ask_serve(shared, method, params))
}

/// roster serve's answer, before it's Lua. A method that acts on the network or the Inventory
/// (`roster.serve.call`'s and `inventory.write`'s alike) is asked only in the user's call (Q100).
fn ask_serve(shared: &Shared, method: &str, params: Json) -> Result<Json, String> {
    if super::permission::serve_user_only(method) && !shared.user_call.get() {
        return Err(USER_ONLY.into());
    }
    let (calls, waited) = shared.served.get();
    if calls >= MAX_SERVE_CALLS {
        return Err(format!(
            "more than {MAX_SERVE_CALLS} calls into roster serve in one go (roster.serve.request doesn't wait)"
        ));
    }
    if waited >= MAX_SERVE_WAIT {
        return Err(format!(
            "waited {} s or more for roster serve in one go (roster.serve.request doesn't wait)",
            MAX_SERVE_WAIT.as_secs()
        ));
    }
    // A method that can change things (a write, a Mesh run) may change the Inventory: what the
    // run read before it is out of date (decision Q127).
    if super::permission::serve_user_only(method) {
        shared.host_list.borrow_mut().take();
    }
    #[cfg(test)]
    let now = shared.serve_clock.get();
    #[cfg(not(test))]
    let now = Instant::now;
    let started = now();
    shared.serving.begin();
    let result = shared.serve.call(method, params);
    shared.serving.end();
    let took = now() - started;
    shared.clock.extend(took);
    shared.served.set((calls + 1, waited + took));
    redacted(result)
}

/// serve's answer as a Plugin gets it: `cmd:`/`env:` references cut in the answer and in an
/// error's message alike (Q92), since serve's messages echo what they were given.
fn redacted(result: Result<Json, String>) -> Result<Json, String> {
    match result {
        Ok(mut v) => {
            redact(&mut v);
            Ok(v)
        }
        Err(message) => Err(redact_error(&message)),
    }
}

/// An error's message with its references cut. serve's `(code N)` at the end stays, even after a
/// `cmd:` reference that runs to the end of the line: a Plugin tells errors apart by it.
fn redact_error(message: &str) -> String {
    // ` (code N)` last: one optional `-`, then at least one digit
    let is_code = |n: &str| {
        let digits = n.strip_prefix('-').unwrap_or(n);
        !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
    };
    let (text, code) = match message.rfind(" (code ") {
        Some(at) if message.ends_with(')') && is_code(&message[at + 7..message.len() - 1]) => message.split_at(at),
        _ => (message, ""),
    };
    match redact_text(text) {
        Some(cut) => format!("{cut}{code}"),
        None => message.to_string(),
    }
}

/// The Login references that say how a secret is fetched, `cmd:COMMAND` and `env:VAR`, cut to
/// their kind (`cmd:`, `env:`) in every text of serve's answer, not only an `auth` (decision Q92,
/// ticket 86): a command line can carry a secret pasted into it, a Plugin never needs either to
/// do its work, and raw text (`changes.diff`'s diff, `host.check`'s messages) shows them as
/// written. The app's own UI gets serve's answers whole; only a Plugin's are cut.
fn redact(v: &mut Json) {
    match v {
        Json::String(text) => {
            if let Some(cut) = redact_text(text) {
                *text = cut;
            }
        }
        Json::Object(map) => {
            // keys too: serve's `data` can be keyed by what it was given
            *map = std::mem::take(map)
                .into_iter()
                .map(|(key, mut value)| {
                    redact(&mut value);
                    (redact_text(&key).unwrap_or(key), value)
                })
                .collect();
        }
        Json::Array(items) => items.iter_mut().for_each(redact),
        _ => {}
    }
}

/// `text` with each `cmd:`/`env:` reference cut to its kind, or `None` when it has none. A
/// reference starts a text or follows a space, a quote or one of `=:,({[`, in any case. A
/// `cmd:` one runs to the end of its line (a command can hold anything; a closing quote is put
/// back), an `env:` one is the variable's name. `cmd: is ready` is the kind alone, kept.
fn redact_text(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let starts = |i: usize| -> Option<&'static str> {
        let word = bytes.get(i..i + 4)?;
        let before = i.checked_sub(1).map(|j| bytes[j]);
        let boundary = before.is_none_or(|b| b.is_ascii_whitespace() || b"\"'=:,({[".contains(&b));
        if !boundary {
            return None;
        }
        ["cmd:", "env:"]
            .into_iter()
            .find(|k| word.eq_ignore_ascii_case(k.as_bytes()))
    };
    let mut out = String::new();
    let (mut copied, mut i, mut cut) = (0, 0, false);
    while i < bytes.len() {
        let Some(kind) = starts(i) else {
            i += 1;
            continue;
        };
        let from = i + 4;
        let to = if kind == "cmd:" {
            if bytes.get(from).is_none_or(|b| b.is_ascii_whitespace()) {
                from
            } else {
                text[from..].find(['\n', '\r']).map_or(bytes.len(), |n| from + n)
            }
        } else {
            from + bytes[from..]
                .iter()
                .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_')
                .count()
        };
        if to > from || !text[i..from].eq(kind) {
            out.push_str(&text[copied..i]);
            out.push_str(kind);
            let quote = i.checked_sub(1).map(|j| bytes[j]).filter(|b| *b == b'"' || *b == b'\'');
            if kind == "cmd:"
                && to > from
                && let Some(q) = quote
            {
                out.push(q as char);
            }
            copied = to;
            cut = true;
        }
        i = to.max(from);
    }
    cut.then(|| {
        out.push_str(&text[copied..]);
        out
    })
}

/// `read` of serve's `hosts.list`, asked once a run: `roster.inventory.hosts()` and `.groups()` in
/// one call are one read (decision Q127). An error names `what`.
fn with_host_list<T>(shared: &Shared, what: &str, read: impl FnOnce(&Json) -> mlua::Result<T>) -> mlua::Result<T> {
    if shared.host_list.borrow().is_none() {
        let list =
            ask_serve(shared, "hosts.list", json!({})).map_err(|m| mlua::Error::runtime(format!("{what}: {m}")))?;
        if !list.is_object() {
            return Err(mlua::Error::runtime(format!("{what}: roster sent no list")));
        }
        *shared.host_list.borrow_mut() = Some(list);
    }
    let list = shared.host_list.borrow();
    read(list.as_ref().expect("asked above"))
}

/// roster serve's answer as Lua, or an error naming `what` called it.
fn answer(lua: &Lua, what: &str, result: Result<Json, String>) -> mlua::Result<Value> {
    match result {
        Ok(v) => to_lua(lua, &v),
        Err(message) => Err(mlua::Error::runtime(format!("{what}: {message}"))),
    }
}

/// Runs `work` on the Plugin's data folder, giving the time the disk took back to its run (like
/// waiting for roster serve); an error names `what`.
fn on_disk<T>(shared: &Shared, what: &str, work: impl FnOnce(&Storage) -> Result<T, String>) -> mlua::Result<T> {
    let storage = match &shared.storage {
        None => {
            return Err(mlua::Error::runtime(format!(
                "{what}: there's no data folder for Plugins here"
            )));
        }
        Some(Err(e)) => return Err(mlua::Error::runtime(format!("{what}: {e}"))),
        Some(Ok(st)) => st,
    };
    let started = Instant::now();
    let result = work(storage);
    shared.clock.extend(started.elapsed());
    result.map_err(|e| mlua::Error::runtime(format!("{what}: {e}")))
}

/// Checks and starts a request for `roster.http`; `done` gets the answer later.
#[allow(clippy::too_many_arguments)] // the request's parts, as Lua gave them
fn request(
    lua: &Lua,
    s: &Shared,
    what: &str,
    method: &str,
    url: &str,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    timeout: Option<f64>,
    done: Function,
) -> mlua::Result<()> {
    let fail = |m: String| mlua::Error::runtime(format!("{what}: {m}"));
    let (Some(net), Some(post)) = (&s.net, &s.post) else {
        return Err(fail("not granted (network:<site>)".into()));
    };
    let req = net.check(method, url, headers, body, timeout).map_err(fail)?;
    // Again against the sites granted, by the same rule (a private: name only through its
    // private: site): the client holds exactly those, built from the grants at load.
    if !network::allowed(net.sites(), &req.url) {
        return Err(fail("not granted (network:<site>)".into()));
    }
    let id = s.next_request.get() + 1;
    s.next_request.set(id);
    let requests: Table = lua.named_registry_value(REQUESTS)?;
    let post = Arc::clone(post);
    net.start(req, move |answer| post(id, Arrival::Http(answer)))
        .map_err(fail)?;
    s.serving.requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    requests.raw_set(id, done)
}

/// Checks and starts `roster.serve.request`: roster serve is asked on a thread of its own, and
/// `done` gets the answer later on the Plugin's thread. The same rules as `roster.serve.call`.
fn serve_request(lua: &Lua, s: &Shared, method: String, params: Option<Value>, done: Function) -> mlua::Result<()> {
    let what = format!("roster.serve.request {method}");
    need(s, &Permission::Serve(method.clone()), "roster.serve.request")?;
    if super::permission::serve_user_only(&method) {
        user_only(s, &what)?;
    }
    let params = match params {
        Some(Value::Nil) | None => json!({}),
        Some(v) => plain(s, "roster.serve.request", &v)?,
    };
    if super::permission::serve_user_only(&method) {
        // It may change the Inventory while the run goes on: read it again after.
        s.host_list.borrow_mut().take();
    }
    ask_later(lua, s, what, method, params, done)
}

/// Asks roster serve `method` on a thread of its own; `done` gets the answer later on the Plugin's
/// thread, `(result)` or `(nil, "WHAT: why")`. At most [`MAX_SERVE_REQUESTS`] wait at once.
fn ask_later(lua: &Lua, s: &Shared, what: String, method: String, params: Json, done: Function) -> mlua::Result<()> {
    let Some(post) = &s.post else {
        return Err(mlua::Error::runtime(format!("{what}: not granted (serve:{method})")));
    };
    if s.serving_requests.borrow().len() >= MAX_SERVE_REQUESTS {
        return Err(mlua::Error::runtime(format!(
            "{what}: {MAX_SERVE_REQUESTS} requests are waiting for roster serve already: wait for one to answer"
        )));
    }
    let id = s.next_request.get() + 1;
    s.next_request.set(id);
    let (serve, post) = (Arc::clone(&s.serve), Arc::clone(post));
    s.serving.requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    std::thread::Builder::new()
        .name(format!("plugin:{} serve", s.plugin))
        .spawn(move || {
            let result = redacted(serve.call(&method, params));
            post(id, Arrival::Serve(result));
        })
        .map_err(|e| {
            s.serving.requests.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            mlua::Error::runtime(format!("{what}: couldn't start: {e}"))
        })?;
    let user = s.user_call.get() && !s.carried.get();
    s.serving_requests.borrow_mut().insert(id, (what, user));
    lua.named_registry_value::<Table>(REQUESTS)?.raw_set(id, done)
}

/// The `roster` module for one Plugin: everything every Plugin gets, then what its grants add.
fn api(lua: &Lua, shared: &Rc<Shared>, version: &str, config: &Json) -> mlua::Result<Table> {
    let roster = lua.create_table()?;
    roster.raw_set("api_version", super::API_VERSION)?;
    roster.raw_set("os", Os::current().as_str())?;
    let me = lua.create_table()?;
    me.raw_set("name", shared.plugin.as_str())?;
    me.raw_set("version", version)?;
    let granted = lua.create_table()?;
    for (i, p) in shared.grants.iter().enumerate() {
        granted.raw_set(i + 1, p.to_string())?;
    }
    me.raw_set("permissions", granted)?;
    // A Package's settings from init.lua (ticket 24): always a table.
    let config = match config {
        Json::Object(_) => to_lua(lua, config)?,
        _ => Value::Table(lua.create_table()?),
    };
    me.raw_set("config", config)?;
    roster.raw_set("plugin", me)?;

    // A function `f(lua, shared, args)` in the module.
    macro_rules! func {
        ($table:expr, $name:expr, |$lua:ident, $s:ident, $args:tt : $ty:ty| $body:block) => {{
            let $s = Rc::clone(shared);
            $table.raw_set(
                $name,
                lua.create_function(move |$lua, $args: $ty| {
                    let $s: &Shared = &$s;
                    $body
                })?,
            )?;
        }};
    }

    // Commands: `:NAME ARGS` runs `run({ args = "ARGS", words = {…} })`, or a command line.
    let commands = lua.create_table()?;
    func!(commands, "add", |lua, s, (name, spec): (String, Table)| {
        check_id("roster.commands.add", &name)?;
        let spec = data(
            lua,
            s,
            "roster.commands.add",
            &Value::Table(spec),
            &format!("command:{name}"),
        )?;
        let desc = spec.get("desc").and_then(Json::as_str).unwrap_or("").to_string();
        let Some(run) = spec.get("run").filter(|r| r.is_string() || r.get("handler").is_some()) else {
            return Err(mlua::Error::runtime(
                "roster.commands.add: `run` must be a function or a command line",
            ));
        };
        let mut op = json!({ "op": "command", "name": name, "desc": desc, "run": run });
        // `complete` (api 3): a function the app calls as the user types, never a user's call.
        match spec.get("complete") {
            None => {}
            Some(c) => match c.get("handler").and_then(Json::as_u64) {
                Some(id) => {
                    s.quiet.borrow_mut().insert(id);
                    op["complete"] = c.clone();
                }
                None => {
                    return Err(mlua::Error::runtime(
                        "roster.commands.add: `complete` must be a function: fun(arg: string): string[]",
                    ));
                }
            },
        }
        s.commands.borrow_mut().insert(name.clone());
        push(s, op)
    });
    func!(commands, "remove", |_lua, s, name: String| {
        check_id("roster.commands.remove", &name)?;
        s.commands.borrow_mut().remove(&name);
        push(s, json!({ "op": "remove", "kind": "command", "id": name }))
    });
    roster.raw_set("commands", commands)?;

    // Key bindings, as init.lua's: the action is a command line (one of the Plugin's commands).
    let keymap = lua.create_table()?;
    func!(
        keymap,
        "set",
        |_lua, s, (context, keys, action): (String, String, Value)| {
            let action = match action {
                Value::String(a) => Json::String(a.to_str()?.to_string()),
                Value::Boolean(false) => Json::Bool(false),
                _ => {
                    return Err(mlua::Error::runtime(
                        "roster.keymap.set: the action is a command line such as \"alerts\" (add a command for a function)",
                    ));
                }
            };
            push(
                s,
                json!({ "op": "key", "context": context, "keys": keys, "action": action }),
            )
        }
    );
    // Takes the Plugin's own binding off (api 3); `set(…, false)` did the same before it.
    func!(keymap, "del", |_lua, s, (context, keys): (String, String)| {
        push(
            s,
            json!({ "op": "key", "context": context, "keys": keys, "action": false }),
        )
    });
    roster.raw_set("keymap", keymap)?;

    // Themes, checked as init.lua's `themes` are.
    let themes = lua.create_table()?;
    func!(themes, "define", |lua, s, (id, theme): (String, Table)| {
        check_id("roster.themes.define", &id)?;
        let value = data(lua, s, "roster.themes.define", &Value::Table(theme), "theme")?;
        let def: ThemeDef = serde_json::from_value(value)
            .map_err(|e| mlua::Error::runtime(format!("roster.themes.define {id:?}: {e}")))?;
        let def = serde_json::to_value(def).map_err(mlua::Error::external)?;
        push(s, json!({ "op": "theme", "id": id, "theme": def }))
    });
    func!(themes, "remove", |_lua, s, id: String| {
        check_id("roster.themes.remove", &id)?;
        push(s, json!({ "op": "remove", "kind": "theme", "id": id }))
    });
    roster.raw_set("themes", themes)?;

    // UI pieces the core draws: a Sidebar section, a status segment, a finder source, a help
    // page, a `:check` section, a tutorial (`:tutor`), a toolbar control, a progress (ticket 78). `set` adds or replaces one; `remove` takes it away.
    for (module, kind) in [
        ("sidebar", "section"),
        ("status", "status"),
        ("finders", "finder"),
        ("help", "help"),
        ("health", "health"),
        ("tutor", "tutor"),
        ("toolbar", "toolbar"),
        ("progress", "progress"),
    ] {
        let t = lua.create_table()?;
        let what = format!("roster.{module}.set");
        func!(t, "set", |lua, s, (id, spec): (String, Table)| {
            check_id(&what, &id)?;
            let spec = data(lua, s, &what, &Value::Table(spec), &format!("{kind}:{id}"))?;
            // What the app runs on its own, never the user's choice: a finder's `items` as it
            // opens (whoever opened it, another Plugin's `roster.cmd` included) and a `:check`
            // section's `check`.
            let unasked = match kind {
                "finder" => spec.get("items"),
                "health" => spec.get("check"),
                _ => None,
            };
            if let Some(id) = unasked.and_then(|f| f.get("handler")).and_then(Json::as_u64) {
                s.quiet.borrow_mut().insert(id);
            }
            let mut op = Map::new();
            op.insert("op".into(), kind.into());
            op.insert("id".into(), id.into());
            op.insert("spec".into(), spec);
            push(s, Json::Object(op))
        });
        let removing = format!("roster.{module}.remove");
        func!(t, "remove", |_lua, s, id: String| {
            check_id(&removing, &id)?;
            push(s, json!({ "op": "remove", "kind": kind, "id": id }))
        });
        roster.raw_set(module, t)?;
    }

    // A `:check` section's lines for a run whose `check` returned "later" (decision Q112h): from a
    // request's answer, so the check never waits for serve on the Plugin's thread.
    {
        let health: Table = roster.raw_get("health")?;
        func!(health, "answer", |_lua, s, (check, lines): (u64, Value)| {
            let checks = plain(s, "roster.health.answer: lines", &lines)?;
            push(s, json!({ "op": "health_answer", "check": check, "checks": checks }))
        });
    }

    // A badge on a Host's rows ("2 alerts"); nil takes it off.
    let badges = lua.create_table()?;
    func!(
        badges,
        "set",
        |_lua, s, (host, text): (String, Option<mlua::LuaString>)| {
            let text = text.map(|t| t.to_string_lossy());
            push(s, json!({ "op": "badge", "host": host, "text": text }))
        }
    );
    roster.raw_set("badges", badges)?;

    // A floating window over the terminal: a title and lines of text; `close` hides it.
    let float = lua.create_table()?;
    func!(float, "open", |lua, s, spec: Table| {
        let spec = data(lua, s, "roster.float.open", &Value::Table(spec), "float")?;
        push(s, json!({ "op": "float", "spec": spec }))
    });
    func!(float, "close", |_lua, s, (): ()| {
        push(s, json!({ "op": "float", "spec": null }))
    });
    roster.raw_set("float", float)?;

    // Views (ticket 76): a side panel or a full view of text, facts and a table, which the app
    // draws. Rows are plain data; a table's actions are functions that get the row. Opening one
    // is the user's call (an action, a command, a finder item), never the Plugin's on its own.
    let views = lua.create_table()?;
    func!(views, "set", |lua, s, (id, spec): (String, Table)| {
        check_id("roster.views.set", &id)?;
        // A table's actions are owned apart from the rest (its `open`), as an update's are, so an
        // update that replaces them drops their functions at once (ticket 85).
        let (spec, actions) = table_actions(lua, &spec)?;
        let mut spec = data(lua, s, "roster.views.set", &Value::Table(spec), &format!("view:{id}"))?;
        let actions = data(
            lua,
            s,
            "roster.views.set: table.actions",
            &actions,
            &format!("view:{id}:actions"),
        )?;
        if !actions.is_null()
            && let Some(table) = spec.get_mut("table").and_then(Json::as_object_mut)
        {
            table.insert("actions".into(), actions);
        }
        push(s, json!({ "op": "view", "id": id, "spec": spec }))
    });
    func!(views, "update", |lua, s, (id, changes): (String, Table)| {
        check_id("roster.views.update", &id)?;
        // Plain data, but for the table's `actions` (ticket 78), whose functions replace the ones
        // the set or an earlier update gave; `open` stays the set's.
        let rest = lua.create_table()?;
        let mut actions = None;
        for pair in changes.pairs::<Value, Value>() {
            let (k, v) = pair?;
            if matches!(&k, Value::String(k) if k.as_bytes().as_ref() == b"actions") {
                actions = Some(v);
            } else {
                rest.raw_set(k, v)?;
            }
        }
        let mut changes = plain(s, &format!("roster.views.update {id:?}"), &Value::Table(rest)).map_err(|e| {
            mlua::Error::runtime(format!(
                "{} (an update is plain data: functions go in roster.views.set, or a table's actions)",
                lua::error_text(&e)
            ))
        })?;
        if let Some(actions) = actions {
            let actions = data(lua, s, "roster.views.update", &actions, &format!("view:{id}:actions"))?;
            if let Json::Object(m) = &mut changes {
                m.insert("actions".into(), actions);
            } else {
                changes = json!({ "actions": actions });
            }
        }
        push(s, json!({ "op": "view_update", "id": id, "changes": changes }))
    });
    func!(views, "open", |_lua, s, (id, opts): (String, Value)| {
        check_id("roster.views.open", &id)?;
        if !s.user_call.get() {
            return Err(mlua::Error::runtime(
                "roster.views.open: only while the user runs one of your actions, commands or finder items",
            ));
        }
        let mut op = json!({ "op": "view_open", "id": id });
        // At a node of its graph or a row of its table (T99, api 4).
        let opts = match opts {
            Value::Nil => None,
            Value::Table(t) => Some(t),
            _ => {
                return Err(mlua::Error::runtime(
                    "roster.views.open: opts is a table, as { select = ID }",
                ));
            }
        };
        if let Some(opts) = opts {
            match opts.raw_get::<Value>("select")? {
                Value::Nil => {}
                Value::String(v) => op["select"] = Json::String(v.to_string_lossy().to_string()),
                _ => {
                    return Err(mlua::Error::runtime(
                        "roster.views.open: select is the id of a node or row (a string)",
                    ));
                }
            }
        }
        push(s, op)
    });
    func!(views, "close", |_lua, s, id: String| {
        check_id("roster.views.close", &id)?;
        push(s, json!({ "op": "view_close", "id": id }))
    });
    func!(views, "remove", |lua, s, id: String| {
        check_id("roster.views.remove", &id)?;
        let (owner, actions) = (format!("view:{id}"), format!("view:{id}:actions"));
        drop_owners(lua, s, |k| k == owner || k == actions)?;
        push(s, json!({ "op": "remove", "kind": "view", "id": id }))
    });
    roster.raw_set("views", views)?;

    // Sections of a Host's details (ticket 76), set per Host; nil takes one Host's away.
    let details = lua.create_table()?;
    func!(
        details,
        "set",
        |lua, s, (id, host, spec): (String, String, Option<Table>)| {
            check_id("roster.details.set", &id)?;
            let owner = format!("details:{id}@{host}");
            let spec = match spec {
                Some(t) => data(lua, s, "roster.details.set", &Value::Table(t), &owner)?,
                None => {
                    drop_owners(lua, s, |k| k == owner)?;
                    Json::Null
                }
            };
            push(s, json!({ "op": "details", "id": id, "host": host, "spec": spec }))
        }
    );
    func!(details, "remove", |lua, s, id: String| {
        check_id("roster.details.remove", &id)?;
        let prefix = format!("details:{id}@");
        drop_owners(lua, s, |k| k.starts_with(&prefix))?;
        push(s, json!({ "op": "remove", "kind": "details", "id": id }))
    });
    roster.raw_set("details", details)?;

    // The clipboard: only while the user runs one of the Plugin's actions, commands or finder
    // items, never on its own (at load, on an event), so it can't swap what you copied.
    let clipboard = lua.create_table()?;
    func!(clipboard, "copy", |_lua, s, text: mlua::LuaString| {
        let text = text.to_string_lossy();
        if !s.user_call.get() {
            return Err(mlua::Error::runtime(
                "roster.clipboard.copy: only while the user runs one of your actions, commands or finder items",
            ));
        }
        if text.len() > MAX_COPY {
            return Err(mlua::Error::runtime(format!(
                "roster.clipboard.copy: the text is over {MAX_COPY} bytes"
            )));
        }
        push(s, json!({ "op": "copy", "text": text }))
    });
    roster.raw_set("clipboard", clipboard)?;

    // A question the app draws and the user answers (ticket 78): `run` is called only when they
    // confirm, `cancel` when they don't. Only in a call the user started, so a question never
    // comes up on its own; the Plugin can't draw one itself or answer it.
    func!(roster, "confirm", |lua, s, spec: Table| {
        user_only(s, "roster.confirm")?;
        let spec = data(lua, s, "roster.confirm", &Value::Table(spec), "confirm")?;
        if spec.get("run").and_then(|r| r.get("handler")).is_none() {
            return Err(mlua::Error::runtime(
                "roster.confirm: `run` must be a function: what happens when the user confirms",
            ));
        }
        push(s, json!({ "op": "confirm", "spec": spec }))
    });

    // A command line, as typed after `:` (ticket 78): the Plugin's own commands and the few of
    // roster's that api.rs's COMMANDS lists, each only with the permission it needs there. Only
    // in a call the user started.
    func!(roster, "cmd", |_lua, s, line: mlua::LuaString| {
        user_only(s, "roster.cmd")?;
        let line = line.to_string_lossy();
        let line = line.trim();
        let Some(word) = line.split_whitespace().next() else {
            return Err(mlua::Error::runtime(
                "roster.cmd: which command? (a line such as \"finder alerts\")",
            ));
        };
        if line.len() > 500 {
            return Err(mlua::Error::runtime("roster.cmd: the line is over 500 characters"));
        }
        if let Some(why) = not_yet(s, word) {
            return Err(mlua::Error::runtime(format!("roster.cmd: {why}")));
        }
        if !own_command(s, word) {
            command_allowed(word, &s.grants).map_err(|m| mlua::Error::runtime(format!("roster.cmd: {m}")))?;
        }
        // Made in a run that carries the user's call already (issue #183): the app runs the
        // Plugin's own command it names as the app's call, so a chain stops after one hop.
        if s.carried.get() {
            return push(s, json!({ "op": "cmd", "line": line, "user": false }));
        }
        push(s, json!({ "op": "cmd", "line": line }))
    });

    // A line on the message line, as roster's own commands answer (api 3): only in a call the
    // user started, so it always answers something they did. `quiet = true` (api 4) marks a
    // routine confirmation, which follows `ui.messages` as roster's own do (ticket 118).
    func!(
        roster,
        "echo",
        |_lua, s, (text, opts): (mlua::LuaString, Option<Table>)| {
            user_only(s, "roster.echo")?;
            let text = text.to_string_lossy();
            let mut op = json!({ "op": "echo", "text": text });
            if quiet_opt(opts.as_ref(), "roster.echo")? == Some(true) {
                op["quiet"] = Json::Bool(true);
            }
            push(s, op)
        }
    );

    // Opens the command line with text typed in (api 3), for the user to finish: only the
    // Plugin's own commands, and only in a call the user started.
    func!(roster, "cmdline", |_lua, s, text: mlua::LuaString| {
        user_only(s, "roster.cmdline")?;
        let text = text.to_string_lossy();
        if text.len() > 500 {
            return Err(mlua::Error::runtime("roster.cmdline: the line is over 500 characters"));
        }
        let word = text.split_whitespace().next().unwrap_or("");
        if let Some(why) = not_yet(s, word) {
            return Err(mlua::Error::runtime(format!("roster.cmdline: {why}")));
        }
        if !own_command(s, word) {
            return Err(mlua::Error::runtime(format!(
                "roster.cmdline: {word:?} isn't one of your commands (a line such as \"alerts \")"
            )));
        }
        push(s, json!({ "op": "cmdline", "text": text }))
    });

    func!(roster, "notify", |_lua,
                             s,
                             (text, level, opts): (
        mlua::LuaString,
        Option<String>,
        Option<Table>
    )| {
        let text = text.to_string_lossy();
        let level = level.unwrap_or_else(|| "info".into());
        if !matches!(level.as_str(), "info" | "warn" | "error") {
            return Err(mlua::Error::runtime(
                "roster.notify: the level is \"info\", \"warn\" or \"error\"",
            ));
        }
        // Buttons on the notice (ticket 91): plain data, each a command line the user's click
        // runs (`view mesh-plan`), so a notice holds no function that would outlive it.
        let actions = match opts {
            Some(ref t) => {
                let v: Value = t.raw_get("actions")?;
                if v.is_nil() {
                    Json::Null
                } else {
                    plain(s, "roster.notify: actions", &v).map_err(|e| {
                        mlua::Error::runtime(format!(
                            "{} (a notice's action runs a command line, not a function)",
                            lua::error_text(&e)
                        ))
                    })?
                }
            }
            None => Json::Null,
        };
        let mut op = json!({ "op": "notify", "text": text, "level": level });
        if !actions.is_null() {
            op["actions"] = actions;
        }
        // Whether an info notice follows `ui.messages` (api 4, ticket 117): the app decides,
        // so only what the Plugin said is passed on.
        if let Some(q) = quiet_opt(opts.as_ref(), "roster.notify")? {
            op["quiet"] = Json::Bool(q);
        }
        push(s, op)
    });

    // Timers: the app keeps the clock and runs the function in the Plugin when it's time.
    func!(roster, "defer", |lua, s, (ms, f): (f64, Function)| {
        add_timer(lua, s, "roster.defer", ms, f, false)
    });
    func!(roster, "every", |lua, s, (ms, f): (f64, Function)| {
        add_timer(lua, s, "roster.every", ms, f, true)
    });
    func!(roster, "cancel", |lua, s, id: Value| {
        let id = match id {
            Value::Integer(i) if i > 0 => i as u64,
            _ => {
                return Err(mlua::Error::runtime(
                    "roster.cancel: a timer, as roster.defer or roster.every returned it",
                ));
            }
        };
        if !s.timers.borrow().contains_key(&id) {
            return Ok(());
        }
        take_timer(lua, s, id)?;
        push(s, json!({ "op": "remove", "kind": "timer", "id": id.to_string() }))
    });

    // Whether a permission was granted: one that can't be (`network`, a serve method that
    // isn't allowed) is just false, so a Plugin can ask about what a newer roster has.
    func!(roster, "has", |_lua, s, name: String| {
        match Permission::parse(&name) {
            Ok(p) => Ok(s.grants.contains(&p)),
            // Any site: whether `roster.http` is there.
            Err(_) if name == "network" => Ok(s.grants.iter().any(|g| matches!(g, Permission::Network(_)))),
            Err(_) if name.starts_with("serve:") || name.starts_with("network:") => Ok(false),
            Err(e) => Err(mlua::Error::runtime(format!("roster.has: {e}"))),
        }
    });

    // Events: `roster.on("session_open", function(e) … end)`.
    func!(roster, "on", |lua, s, (event, f): (String, Function)| {
        may_hear(&event, &s.grants).map_err(|m| mlua::Error::runtime(format!("roster.on: {m}")))?;
        let listeners: Table = lua.named_registry_value(LISTENERS)?;
        let list = match listeners.raw_get::<Option<Table>>(event.as_str())? {
            Some(l) => l,
            None => {
                let l = lua.create_table()?;
                listeners.raw_set(event.as_str(), l.clone())?;
                l
            }
        };
        list.raw_push(f)
    });

    // The Plugin's own data folder (decision Q93): files by plain name, never a path. Every
    // Plugin has it; nothing outside its folder is reachable through it.
    let storage = lua.create_table()?;
    func!(storage, "read", |lua, s, name: String| {
        let bytes = on_disk(s, "roster.storage.read", |st| st.read(&name))?;
        match bytes {
            Some(b) => Ok(Value::String(lua.create_string(b)?)),
            None => Ok(Value::Nil),
        }
    });
    func!(storage, "write", |_lua, s, (name, text): (String, mlua::LuaString)| {
        let bytes = text.as_bytes().to_vec();
        on_disk(s, "roster.storage.write", |st| st.write(&name, &bytes))
    });
    func!(storage, "list", |lua, s, (): ()| {
        let names = on_disk(s, "roster.storage.list", Storage::list)?;
        lua.create_sequence_from(names)
    });
    func!(storage, "remove", |_lua, s, name: String| {
        on_disk(s, "roster.storage.remove", |st| st.remove(&name))
    });
    func!(storage, "read_json", |lua, s, name: String| {
        let what = "roster.storage.read_json";
        let Some(bytes) = on_disk(s, what, |st| st.read(&name))? else {
            return Ok(Value::Nil);
        };
        let value: Json = serde_json::from_slice(&bytes)
            .map_err(|e| mlua::Error::runtime(format!("{what}: {name} isn't JSON ({e})")))?;
        to_lua(lua, &value)
    });
    func!(storage, "write_json", |_lua, s, (name, value): (String, Value)| {
        let what = "roster.storage.write_json";
        let value = plain(s, what, &value)?;
        let mut text =
            serde_json::to_string_pretty(&value).map_err(|e| mlua::Error::runtime(format!("{what}: {e}")))?;
        text.push('\n');
        on_disk(s, what, |st| st.write(&name, text.as_bytes()))
    });
    roster.raw_set("storage", storage)?;

    // What the grants add. Without a grant the function isn't there at all (decision Q81).
    let g = &shared.grants;
    if g.contains(&Permission::InventoryRead) || g.contains(&Permission::InventoryWrite) {
        let inventory = lua.create_table()?;
        if g.contains(&Permission::InventoryRead) {
            func!(inventory, "hosts", |lua, s, (): ()| {
                need(s, &Permission::InventoryRead, "roster.inventory.hosts")?;
                with_host_list(s, "roster.inventory.hosts", |list| to_lua(lua, &list["hosts"]))
            });
            func!(inventory, "groups", |lua, s, (): ()| {
                need(s, &Permission::InventoryRead, "roster.inventory.groups")?;
                with_host_list(s, "roster.inventory.groups", |list| match &list["groups"] {
                    groups @ Json::Object(_) => to_lua(lua, groups),
                    _ => Ok(Value::Table(lua.create_table()?)),
                })
            });
            // The whole Inventory without waiting (decision Q127): serve's `hosts.list`, as
            // `roster.serve.request` asks.
            func!(inventory, "request", |lua, s, done: Function| {
                need(s, &Permission::InventoryRead, "roster.inventory.request")?;
                ask_later(
                    lua,
                    s,
                    "roster.inventory.request".into(),
                    "hosts.list".into(),
                    json!({}),
                    done,
                )
            });
            // An unknown name is `nil` (api 3): serve's code 2 for host.get.
            func!(inventory, "host", |lua, s, name: String| {
                need(s, &Permission::InventoryRead, "roster.inventory.host")?;
                match ask_serve(s, "host.get", json!({ "name": name })) {
                    Err(message) if message.ends_with("(code 2)") => Ok(Value::Nil),
                    result => answer(lua, "roster.inventory.host", result),
                }
            });
        }
        if g.contains(&Permission::InventoryWrite) {
            for (name, method, params) in WRITES {
                let what = format!("roster.inventory.{name}");
                func!(inventory, *name, |lua, s, args: Variadic<Value>| {
                    need(s, &Permission::InventoryWrite, &what)?;
                    let mut p = Map::new();
                    for (key, v) in params.iter().zip(args.iter()) {
                        p.insert((*key).into(), plain(s, &what, v)?);
                    }
                    serve(lua, s, &what, method, Json::Object(p))
                });
            }
        }
        roster.raw_set("inventory", inventory)?;
    }
    // Sessions: going to one (ticket 78) needs nothing but the user's call; opening one needs
    // sessions.open.
    let sessions = lua.create_table()?;
    func!(
        sessions,
        "show",
        |_lua, s, (session, line): (u64, Option<mlua::LuaString>)| {
            user_only(s, "roster.sessions.show")?;
            let line = line.map(|l| l.to_string_lossy());
            push(s, json!({ "op": "session_show", "session": session, "line": line }))
        }
    );
    // The Sessions open now (decision Q127): the sum of what `session_open` and `session_exit`
    // say, so there for whoever may hear them (api.rs's `Needs::Hears`).
    if may_hear("session_open", g).is_ok() {
        func!(sessions, "list", |lua, s, (): ()| {
            let list = lua.create_table()?;
            for (id, host) in s.sessions.list() {
                let one = lua.create_table()?;
                one.raw_set("session", id)?;
                one.raw_set("host", host)?;
                list.raw_push(one)?;
            }
            Ok(list)
        });
    }
    if g.contains(&Permission::SessionsOpen) {
        func!(sessions, "open", |_lua, s, host: String| {
            need(s, &Permission::SessionsOpen, "roster.sessions.open")?;
            push(s, json!({ "op": "open", "host": host }))
        });
    }
    roster.raw_set("sessions", sessions)?;
    if g.contains(&Permission::TerminalWrite) {
        let terminal = lua.create_table()?;
        func!(terminal, "send", |_lua, s, (session, text): (u64, String)| {
            need(s, &Permission::TerminalWrite, "roster.terminal.send")?;
            push(s, json!({ "op": "send", "session": session, "text": text }))
        });
        roster.raw_set("terminal", terminal)?;
    }
    if g.iter().any(|p| matches!(p, Permission::Serve(_))) {
        let t = lua.create_table()?;
        func!(t, "call", |lua, s, (method, params): (String, Option<Value>)| {
            need(s, &Permission::Serve(method.clone()), "roster.serve.call")?;
            let params = match params {
                Some(v) => plain(s, "roster.serve.call", &v)?,
                None => json!({}),
            };
            serve(lua, s, &format!("roster.serve.call {method}"), &method, params)
        });
        // The same call, without waiting (decision Q103): `done(result)` or `done(nil, why)`.
        func!(t, "request", |lua,
                             s,
                             (method, params, done): (
            String,
            Option<Value>,
            Function
        )| { serve_request(lua, s, method, params, done) });
        roster.raw_set("serve", t)?;
    }
    if g.iter().any(|p| matches!(p, Permission::Network(_))) {
        let http = lua.create_table()?;
        func!(http, "request", |lua, s, (req, done): (Table, Function)| {
            let what = "roster.http.request";
            for pair in req.pairs::<Value, Value>() {
                let (k, _) = pair?;
                let key = match &k {
                    Value::String(k) => k.to_string_lossy(),
                    _ => String::new(),
                };
                if !REQUEST_KEYS.contains(&key.as_str()) {
                    return Err(mlua::Error::runtime(format!(
                        "{what}: {key:?} isn't a key of a request (there's {})",
                        REQUEST_KEYS.join(", ")
                    )));
                }
            }
            let url: String = req
                .raw_get::<Option<String>>("url")?
                .ok_or_else(|| mlua::Error::runtime(format!("{what}: `url` is missing")))?;
            let method = req.raw_get::<Option<String>>("method")?.unwrap_or_else(|| "GET".into());
            let mut headers = Vec::new();
            if let Some(h) = req.raw_get::<Option<Table>>("headers")? {
                for pair in h.pairs::<String, mlua::LuaString>() {
                    let (k, v) = pair.map_err(|_| {
                        mlua::Error::runtime(format!("{what}: `headers` is a table of names to strings"))
                    })?;
                    headers.push((k, v.to_str()?.to_string()));
                }
            }
            let body = req
                .raw_get::<Option<mlua::LuaString>>("body")?
                .map(|b| b.as_bytes().to_vec());
            let timeout = req.raw_get::<Option<f64>>("timeout")?;
            request(lua, s, what, &method, &url, headers, body, timeout, done)
        });
        func!(http, "get", |lua, s, (url, done): (String, Function)| {
            request(lua, s, "roster.http.get", "GET", &url, Vec::new(), None, None, done)
        });
        roster.raw_set("http", http)?;
    }
    Ok(roster)
}

/// JSON as a Lua value: objects and arrays become tables, null becomes nil.
pub(crate) fn to_lua(lua: &Lua, v: &Json) -> mlua::Result<Value> {
    Ok(match v {
        Json::Null => Value::Nil,
        Json::Bool(b) => Value::Boolean(*b),
        Json::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Number(n.as_f64().unwrap_or(0.0)),
        },
        Json::String(s) => Value::String(lua.create_string(s)?),
        Json::Array(items) => {
            let t = lua.create_table_with_capacity(items.len(), 0)?;
            for (i, item) in items.iter().enumerate() {
                t.raw_set(i + 1, to_lua(lua, item)?)?;
            }
            Value::Table(t)
        }
        Json::Object(map) => {
            let t = lua.create_table_with_capacity(0, map.len())?;
            for (k, item) in map {
                t.raw_set(k.as_str(), to_lua(lua, item)?)?;
            }
            Value::Table(t)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoServe;

    impl Serve for NoServe {
        fn call(&self, method: &str, _params: Json) -> Result<Json, String> {
            Err(format!("unknown method {method}"))
        }
    }

    fn runtime() -> Runtime {
        Runtime::new(
            "quiet",
            "1.0.0",
            Path::new(""),
            &Json::Null,
            BTreeSet::new(),
            Arc::new(NoServe),
            8 * 1024 * 1024,
            Duration::from_millis(250),
            None,
            false,
            None,
            Arc::new(ServeWait::default()),
            1,
            network::Setup::default(),
            Arc::default(),
            Builtins::default(),
        )
        .unwrap()
    }

    thread_local! {
        /// Fake time for how long roster serve takes: each call moves it on, nothing waits.
        static SERVE_START: Instant = Instant::now();
        static SERVE_TIME: Cell<Duration> = const { Cell::new(Duration::ZERO) };
    }

    fn fake_now() -> Instant {
        SERVE_START.with(|s| *s) + SERVE_TIME.with(Cell::get)
    }

    /// roster serve taking 150 s of fake time for every call, counting them.
    struct Calls(std::sync::atomic::AtomicU32);

    impl Serve for Calls {
        fn call(&self, _method: &str, _params: Json) -> Result<Json, String> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            SERVE_TIME.with(|t| t.set(t.get() + Duration::from_secs(150)));
            Ok(json!({ "ok": true }))
        }
    }

    /// One call (a load, an event, an answer) may wait for roster serve 300 s in all, serve's own
    /// longest deadline for one method (Q103): the call that's waited that long gets an error on
    /// its next call into serve, and the next call starts again from none. On fake time.
    #[test]
    fn one_call_may_wait_for_roster_serve_300_s_in_all() {
        let serve = Arc::new(Calls(Default::default()));
        let rt = Runtime::new(
            "slow",
            "1.0.0",
            Path::new(""),
            &Json::Null,
            BTreeSet::from([Permission::Serve("mesh.status".into())]),
            serve.clone(),
            8 * 1024 * 1024,
            Duration::from_millis(250),
            None,
            false,
            None,
            Arc::new(ServeWait::default()),
            1,
            network::Setup::default(),
            Arc::default(),
            Builtins::default(),
        )
        .unwrap();
        rt.shared.serve_clock.set(fake_now);
        let loaded = rt.load(
            r#"
            roster.commands.add("poll", { run = function()
              local n = 0
              local ok, err = pcall(function()
                while true do roster.serve.call("mesh.status"); n = n + 1 end
              end)
              return n .. " " .. tostring(err)
            end })
            "#,
            Duration::from_secs(1),
        );
        assert!(loaded.error.is_none(), "{:?}", loaded.error);
        let poll = loaded
            .ops
            .iter()
            .find(|o| o["op"] == "command" && o["name"] == "poll")
            .and_then(|o| o["run"]["handler"].as_u64())
            .unwrap();
        let said = |r: Outcome| {
            assert!(r.error.is_none(), "{:?}", r.error);
            r.result.as_str().unwrap().to_string()
        };
        // 0 and 150 s waited: asked; 300 s, the limit itself: refused before serve is asked.
        let first = said(rt.call(poll, &json!({}), By::User));
        assert!(first.starts_with("2 "), "{first}");
        assert!(
            first.contains("roster.serve.call mesh.status: waited 300 s or more for roster serve in one go"),
            "{first}"
        );
        assert_eq!(serve.0.load(std::sync::atomic::Ordering::SeqCst), 2);
        // The next call has its own 300 s.
        let again = said(rt.call(poll, &json!({}), By::User));
        assert!(again.starts_with("2 "), "{again}");
        assert_eq!(serve.0.load(std::sync::atomic::Ordering::SeqCst), 4);
    }

    /// The set of quiet handlers (a command's `complete`, a finder's `items`) holds only the ones
    /// still there: a Plugin adding a command again and again, from a timer say, doesn't grow it
    /// outside Lua's memory limit (the iteration 8 review).
    #[test]
    fn replaced_quiet_handlers_are_let_go() {
        let rt = runtime();
        let loaded = rt.load(
            r#"
            local function again()
              roster.commands.add("pick", { run = function() end, complete = function() return {} end })
              roster.finders.set("picks", { title = "Picks", items = function() return {} end })
              roster.health.set("lab", { title = "Lab", check = function() return {} end })
            end
            again()
            roster.commands.add("again", { run = again })
            "#,
            Duration::from_secs(1),
        );
        assert!(loaded.error.is_none(), "{:?}", loaded.error);
        let again = loaded
            .ops
            .iter()
            .find(|o| o["op"] == "command" && o["name"] == "again")
            .and_then(|o| o["run"]["handler"].as_u64())
            .unwrap();
        for _ in 0..50 {
            let r = rt.call(again, &json!({}), By::User);
            assert!(r.error.is_none(), "{:?}", r.error);
        }
        assert_eq!(rt.shared.quiet.borrow().len(), 3);
    }

    /// tests/vectors/redaction.json, which the CLI's tests (tests/test_json.py) read too, so the
    /// Q92 cut is one rule in both languages: a change to one fails the other's tests.
    #[test]
    fn the_shared_redaction_vectors() {
        let vectors: Json = serde_json::from_str(include_str!("../../../../tests/vectors/redaction.json")).unwrap();
        let cases = vectors["cases"].as_array().unwrap();
        assert!(cases.len() > 20);
        let wrong: Vec<String> = cases
            .iter()
            .filter_map(|case| {
                let input = case["in"].as_str().unwrap();
                let got = if case["error"] == true {
                    redact_error(input)
                } else {
                    redact_text(input).unwrap_or_else(|| input.to_string())
                };
                (got != case["out"].as_str().unwrap()).then(|| format!("{}: {input:?} gave {got:?}", case["note"]))
            })
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    /// The same file's whole JSON values: every string cut, a key as much as a value.
    #[test]
    fn the_shared_redaction_vectors_for_json_values() {
        let vectors: Json = serde_json::from_str(include_str!("../../../../tests/vectors/redaction.json")).unwrap();
        let cases = vectors["values"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let mut got = case["in"].clone();
            redact(&mut got);
            assert_eq!(got, case["out"], "{}", case["note"]);
        }
    }
}
