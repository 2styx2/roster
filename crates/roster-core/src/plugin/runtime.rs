//! One Plugin's Lua: the sandbox `init.lua` runs in (config/lua.rs), with the `roster` module
//! built from what the Plugin was granted. It lives on the Plugin's own thread (mod.rs) and is
//! driven by three calls: [`Runtime::load`], [`Runtime::call`] and [`Runtime::event`]. Whatever
//! the Plugin asks of the UI during a call comes back as that call's ops (data, never HTML); a
//! Lua function inside them is kept here and sent as `{ "handler": N }`.

use super::api::EVENTS;
use super::folder::Storage;
use super::network::{self, Answer, Net};
use super::op::Op;
use super::{Builtins, Event, OpenSessions, Outcome, PluginError, Serve, ServeWait, permission::Permission};
use crate::config::Os;
use crate::config::lua::{self, Budget, Clock};
use mlua::chunk::ChunkMode;
use mlua::{Function, Lua, Table, Value};
use serde_json::{Value as Json, json};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

const HANDLERS: &str = "roster.plugin.handlers";
pub(super) const LISTENERS: &str = "roster.plugin.listeners";
/// The functions waiting for a `roster.http` or `roster.serve.request` answer, by request id.
const REQUESTS: &str = "roster.plugin.requests";
/// What the Plugin has added, by kind and id, as copies of what it gave (ticket 145): what the
/// collections' `get`, `has` and `list` read, and what a removal checks.
const OWN: &str = "roster.plugin.own";
/// The `roster.api_version` from which taking away what the Plugin never added, or naming a key
/// context that isn't one, is an error (ticket 145, decision Q134): a Plugin written for an older
/// one keeps the quiet removals it was written against.
pub(crate) const COMPLETE_API: u32 = 5;
/// Where a Plugin's key bindings work (`KeyContext`).
pub(crate) const KEY_CONTEXTS: &[&str] = &["leader", "list", "list_vim"];
/// How deep a copy of a Plugin's table goes: past this it's a loop, or nothing a UI needs.
const MAX_COPY_DEPTH: usize = 64;
/// The keys `roster.http.request` takes.
pub(super) const REQUEST_KEYS: &[&str] = &["url", "method", "headers", "body", "timeout"];
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
pub(crate) const MAX_COPY: usize = 64 * 1024;
/// The most Lua functions a Plugin may have handed over at once.
const MAX_HANDLERS: usize = 10_000;
/// The most timers a Plugin may have waiting at once.
pub(crate) const MAX_TIMERS: usize = 100;
/// The soonest a deferred function runs, and how often a repeating one may: a Plugin's timers
/// share its one thread with everything the user does with it, so they can't take it over.
pub(crate) const DEFER_MIN_MS: u64 = 50;
pub(crate) const EVERY_MIN_MS: u64 = 1000;
/// The longest a timer may wait (the most a browser's setTimeout takes).
pub(crate) const TIMER_MAX_MS: f64 = 2_147_483_647.0;

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
    match EVENTS.iter().find(|e| e.name == event).map(|e| e.needs) {
        None => Err(format!(
            "there's no event {event:?} (there's {})",
            EVENTS.iter().map(|e| e.name).collect::<Vec<_>>().join(", ")
        )),
        Some([]) => Ok(()),
        Some(needs) if needs.iter().any(|p| granted(p)) => Ok(()),
        Some(needs) => Err(format!("the {event} event needs the {} permission", needs.join(" or "))),
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
pub(super) const WRITES: &[(&str, &str, &[&str])] = &[
    ("update", "host.update", &["host", "changes"]),
    ("rename", "host.rename", &["host", "to"]),
    ("move", "host.move", &["host", "group"]),
    ("review", "host.review", &["host", "reviewed"]),
];

pub(super) struct Shared {
    plugin: String,
    /// The `roster.api_version` its manifest says it was written for.
    api: u32,
    /// During a run, what each change to [`OWN`] replaced (kind, id, what was there), so a failed
    /// run puts it back, as its ops never reach the app.
    own_journal: RefCell<Option<Vec<(String, String, Value)>>>,
    pub(super) grants: BTreeSet<Permission>,
    serve: Arc<dyn Serve>,
    clock: Rc<Clock>,
    ops: RefCell<Vec<Json>>,
    budget: Cell<Budget>,
    handlers: RefCell<Handlers>,
    /// Whether the run is a call the user started (an action, a command, a finder item): only
    /// then may the Plugin put text on the clipboard, ask a question or run a command line.
    pub(super) user_call: Cell<bool>,
    /// The commands the Plugin added (`roster.commands.add`): `roster.cmd` may run them.
    pub(super) commands: RefCell<BTreeSet<String>>,
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
    pub(super) carried: Cell<bool>,
    /// The timers waiting, by their handler: whether each repeats.
    pub(super) timers: RefCell<HashMap<u64, bool>>,
    /// The handlers that run as the app asks, not as the user's call: a command's `complete`, a
    /// finder's `items`, a `:check` section's `check`.
    pub(super) quiet: RefCell<BTreeSet<u64>>,
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
    pub(super) sessions: Arc<OpenSessions>,
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
        api: u32,
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
            api,
            own_journal: RefCell::default(),
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
        lua.set_named_registry_value(OWN, lua.create_table().map_err(fail)?)
            .map_err(fail)?;
        coroutines(&lua, &shared.clock).map_err(fail)?;
        lua.set_named_registry_value(REQUESTS, lua.create_table().map_err(fail)?)
            .map_err(fail)?;
        lua.load(SORTED_PAIRS)
            .set_name("=pairs")
            .set_mode(ChunkMode::Text)
            .exec()
            .map_err(fail)?;
        let roster = self::api(&lua, &shared, version, config).map_err(fail)?;
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
        *s.own_journal.borrow_mut() = Some(Vec::new());
        let result = body(&self.lua);
        let dropped = s.dropping.borrow_mut().take().unwrap_or_default();
        let journal = s.own_journal.borrow_mut().take().unwrap_or_default();
        // The run's Inventory read is its own: the next run asks again, and nothing big is kept.
        s.host_list.borrow_mut().take();
        let settled = match &result {
            Ok(_) => dropped.into_iter().try_for_each(|id| forget(&self.lua, s, id)),
            Err(_) => self.undo(before).and_then(|()| unjournal(&self.lua, journal)),
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
pub(super) fn data(lua: &Lua, shared: &Shared, what: &str, value: &Value, owner: &str) -> mlua::Result<Json> {
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
pub(super) fn drop_owners(lua: &Lua, shared: &Shared, which: impl Fn(&str) -> bool) -> mlua::Result<()> {
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
pub(super) fn table_actions(lua: &Lua, spec: &Table) -> mlua::Result<(Table, Value)> {
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
pub(super) fn plain(shared: &Shared, what: &str, v: &Value) -> mlua::Result<Json> {
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
pub(super) fn take_timer(lua: &Lua, shared: &Shared, id: u64) -> mlua::Result<Option<Function>> {
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
pub(super) fn add_timer(
    lua: &Lua,
    shared: &Shared,
    what: &str,
    ms: f64,
    f: Function,
    every: bool,
) -> mlua::Result<u64> {
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
        Op::Timer {
            id: id.to_string(),
            ms,
            every,
            run: json!({ "handler": id }),
        },
    )?;
    Ok(id)
}

pub(super) fn push(shared: &Shared, op: Op) -> mlua::Result<()> {
    let mut ops = shared.ops.borrow_mut();
    if ops.len() >= MAX_OPS {
        return Err(mlua::Error::runtime(format!(
            "more than {MAX_OPS} UI changes in one go"
        )));
    }
    ops.push(serde_json::to_value(op).map_err(mlua::Error::external)?);
    Ok(())
}

pub(super) fn check_id(what: &str, id: &str) -> mlua::Result<()> {
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

/// The table of what the Plugin has of one kind (`"status"`, `"key:leader"`, `"details:reach"`).
pub(super) fn own_kind(lua: &Lua, kind: &str) -> mlua::Result<Table> {
    let own: Table = lua.named_registry_value(OWN)?;
    if let Some(t) = own.raw_get::<Option<Table>>(kind)? {
        return Ok(t);
    }
    let t = lua.create_table()?;
    own.raw_set(kind, t.clone())?;
    Ok(t)
}

/// Records that the Plugin has `value` as `kind` `id` (nil: it has none now), undone if the run fails.
pub(super) fn own_put(lua: &Lua, s: &Shared, kind: &str, id: &str, value: Value) -> mlua::Result<()> {
    let t = own_kind(lua, kind)?;
    let before: Value = t.raw_get(id)?;
    if let Some(j) = s.own_journal.borrow_mut().as_mut() {
        j.push((kind.to_string(), id.to_string(), before));
    }
    t.raw_set(id, value)
}

/// What the Plugin has as `kind` `id`, as it was recorded (nil: none).
pub(super) fn own_get(lua: &Lua, kind: &str, id: &str) -> mlua::Result<Value> {
    own_kind(lua, kind)?.raw_get(id)
}

/// The ids the Plugin has of `kind`, sorted.
pub(super) fn own_ids(lua: &Lua, kind: &str) -> mlua::Result<Vec<String>> {
    let mut ids = Vec::new();
    for pair in own_kind(lua, kind)?.pairs::<String, Value>() {
        ids.push(pair?.0);
    }
    ids.sort();
    Ok(ids)
}

/// Puts back what a failed run's changes to [`OWN`] replaced, latest first.
fn unjournal(lua: &Lua, journal: Vec<(String, String, Value)>) -> mlua::Result<()> {
    for (kind, id, before) in journal.into_iter().rev() {
        own_kind(lua, &kind)?.raw_set(id, before)?;
    }
    Ok(())
}

/// A copy of a Plugin's value: tables copied all the way down (without metatables), so neither
/// what it changes later in the one it gave nor in one a read gave back reaches the other.
/// Functions stay the same functions.
pub(super) fn copy(lua: &Lua, v: &Value) -> mlua::Result<Value> {
    fn go(lua: &Lua, v: &Value, depth: usize) -> mlua::Result<Value> {
        let Value::Table(t) = v else { return Ok(v.clone()) };
        if depth > MAX_COPY_DEPTH {
            return Err(mlua::Error::runtime(format!(
                "a table nested more than {MAX_COPY_DEPTH} deep"
            )));
        }
        let out = lua.create_table()?;
        for pair in t.pairs::<Value, Value>() {
            let (k, v) = pair?;
            out.raw_set(go(lua, &k, depth + 1)?, go(lua, &v, depth + 1)?)?;
        }
        Ok(Value::Table(out))
    }
    go(lua, v, 0)
}

/// For something the Plugin never added: an error at the caller's line from api 5 on; for a
/// Plugin written for an older one, nothing (its removal goes on and does nothing, as it did).
pub(super) fn not_had(s: &Shared, what: &str, why: String) -> mlua::Result<()> {
    if s.api >= COMPLETE_API {
        Err(mlua::Error::runtime(format!("{what}: {why}")))
    } else {
        Ok(())
    }
}

/// Whether the Plugin has `kind` `id`; if not, [`not_had`] says so, naming the collection.
pub(super) fn must_have(
    lua: &Lua,
    s: &Shared,
    what: &str,
    module: &str,
    noun: &str,
    kind: &str,
    id: &str,
) -> mlua::Result<()> {
    if own_get(lua, kind, id)?.is_nil() {
        not_had(
            s,
            what,
            format!("the Plugin has no {noun} {id:?} (roster.{module}.list() names its own)"),
        )?;
    }
    Ok(())
}

/// Takes the Plugin's binding of `keys` in `context` off its record; one it never set is
/// [`not_had`].
pub(super) fn unbind(lua: &Lua, s: &Shared, what: &str, context: &str, keys: &str) -> mlua::Result<()> {
    let kind = format!("key:{context}");
    if own_get(lua, &kind, keys)?.is_nil() {
        not_had(
            s,
            what,
            format!("the Plugin binds no {keys:?} in {context} (a Plugin takes off only its own bindings)"),
        )?;
    }
    own_put(lua, s, &kind, keys, Value::Nil)
}

/// Takes the Plugin's badge on `host` off its record; one it never put on is [`not_had`].
pub(super) fn unbadge(lua: &Lua, s: &Shared, what: &str, host: &str) -> mlua::Result<()> {
    if own_get(lua, "badge", host)?.is_nil() {
        not_had(
            s,
            what,
            format!("the Plugin has no badge on {host:?} (roster.badges.list() names its Hosts)"),
        )?;
    }
    own_put(lua, s, "badge", host, Value::Nil)
}

/// The ids of the Host-details sections the Plugin has on at least one Host, sorted.
pub(super) fn details_ids(lua: &Lua) -> mlua::Result<Vec<String>> {
    let own: Table = lua.named_registry_value(OWN)?;
    let mut ids = Vec::new();
    for pair in own.pairs::<String, Table>() {
        let (kind, hosts) = pair?;
        if let Some(id) = kind.strip_prefix("details:")
            && hosts.pairs::<Value, Value>().next().is_some()
        {
            ids.push(id.to_string());
        }
    }
    ids.sort();
    Ok(ids)
}

/// A key context: always checked by the reads, and by `set` and `del` from api 5 (for an older
/// Plugin the app refuses one with a notice, as it did). False: not one, and not an error.
pub(super) fn key_context(s: &Shared, what: &str, context: &str, always: bool) -> mlua::Result<bool> {
    if KEY_CONTEXTS.contains(&context) {
        return Ok(true);
    }
    if always || s.api >= COMPLETE_API {
        return Err(mlua::Error::runtime(format!(
            "{what}: {context:?} isn't a key context (a Plugin binds keys in leader, list or list_vim)"
        )));
    }
    Ok(false)
}

/// Why a call refused something only the user's call may do.
const USER_ONLY: &str = "only while the user runs one of your actions, commands or finder items";

/// Errors unless the run is a call the user started (an action, a command, a finder item).
pub(super) fn user_only(shared: &Shared, what: &str) -> mlua::Result<()> {
    if shared.user_call.get() {
        Ok(())
    } else {
        Err(mlua::Error::runtime(format!("{what}: {USER_ONLY}")))
    }
}

/// `opts.quiet`, when a Plugin gives it (`roster.echo`, `roster.notify`; api 4): true, false or
/// left out.
pub(super) fn quiet_opt(opts: Option<&Table>, what: &str) -> mlua::Result<Option<bool>> {
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
pub(super) fn own_command(s: &Shared, word: &str) -> bool {
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
pub(super) fn not_yet(s: &Shared, word: &str) -> Option<String> {
    let unknown = s.builtins.read().map_or(true, |b| b.is_none());
    (unknown
        && s.commands.borrow().contains(word)
        && !super::api::ROSTER_ONLY.contains(&word)
        && !super::api::COMMANDS.iter().any(|c| c.name == word))
    .then(|| format!(":{word} can't run yet: the app hasn't told roster its own commands"))
}

/// Whether a Plugin with `grants` may run roster's command `word` (plugin/api's COMMANDS). Its own
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

pub(super) fn need(shared: &Shared, p: &Permission, what: &str) -> mlua::Result<()> {
    if shared.grants.contains(p) {
        Ok(())
    } else {
        Err(mlua::Error::runtime(format!("{what}: not granted ({p})")))
    }
}

/// Calls roster serve, giving the time spent waiting back to the Plugin's run.
pub(super) fn serve(lua: &Lua, shared: &Shared, what: &str, method: &str, params: Json) -> mlua::Result<Value> {
    answer(lua, what, ask_serve(shared, method, params))
}

/// roster serve's answer, before it's Lua. A method that acts on the network or the Inventory
/// (`roster.serve.call`'s and `inventory.write`'s alike) is asked only in the user's call (Q100).
pub(super) fn ask_serve(shared: &Shared, method: &str, params: Json) -> Result<Json, String> {
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
pub(super) fn with_host_list<T>(
    shared: &Shared,
    what: &str,
    read: impl FnOnce(&Json) -> mlua::Result<T>,
) -> mlua::Result<T> {
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
pub(super) fn answer(lua: &Lua, what: &str, result: Result<Json, String>) -> mlua::Result<Value> {
    match result {
        Ok(v) => to_lua(lua, &v),
        Err(message) => Err(mlua::Error::runtime(format!("{what}: {message}"))),
    }
}

/// Runs `work` on the Plugin's data folder, giving the time the disk took back to its run (like
/// waiting for roster serve); an error names `what`.
pub(super) fn on_disk<T>(
    shared: &Shared,
    what: &str,
    work: impl FnOnce(&Storage) -> Result<T, String>,
) -> mlua::Result<T> {
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
pub(super) fn request(
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
pub(super) fn serve_request(
    lua: &Lua,
    s: &Shared,
    method: String,
    params: Option<Value>,
    done: Function,
) -> mlua::Result<()> {
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
pub(super) fn ask_later(
    lua: &Lua,
    s: &Shared,
    what: String,
    method: String,
    params: Json,
    done: Function,
) -> mlua::Result<()> {
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

/// A collection's reads (api 5): `get(id)`, a copy of what the Plugin gave as `kind` `id` (nil:
/// none); `has(id)`; `list()`, its ids, sorted.
pub(super) fn reads(lua: &Lua, t: &Table, module: &str, kind: &str) -> mlua::Result<()> {
    let (getting, having) = (format!("roster.{module}.get"), format!("roster.{module}.has"));
    let k = kind.to_string();
    t.raw_set(
        "get",
        lua.create_function(move |lua, id: String| {
            check_id(&getting, &id)?;
            copy(lua, &own_get(lua, &k, &id)?)
        })?,
    )?;
    let k = kind.to_string();
    t.raw_set(
        "has",
        lua.create_function(move |lua, id: String| {
            check_id(&having, &id)?;
            Ok(!own_get(lua, &k, &id)?.is_nil())
        })?,
    )?;
    let k = kind.to_string();
    t.raw_set(
        "list",
        lua.create_function(move |lua, ()| lua.create_sequence_from(own_ids(lua, &k)?))?,
    )?;
    Ok(())
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

    crate::plugin::api::commands::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::keymap::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::themes::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::pieces::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::badges::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::float::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::views::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::details::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::clipboard::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::roster::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::storage::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::inventory::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::sessions::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::terminal::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::serve::binding::bind(lua, shared, &roster)?;
    crate::plugin::api::http::binding::bind(lua, shared, &roster)?;
    Ok(roster)
}

pub(crate) use crate::config::lua::to_lua;

/// What the modules' bindings (plugin/api/MODULE.rs) use of the runtime, in one import.
pub(super) mod prelude {
    pub(in crate::plugin) use super::{
        LISTENERS, MAX_COPY, REQUEST_KEYS, Shared, WRITES, add_timer, answer, ask_later, ask_serve, check_id,
        command_allowed, copy, data, details_ids, drop_owners, key_context, may_hear, must_have, need, not_had,
        not_yet, on_disk, own_command, own_get, own_ids, own_kind, own_put, plain, push, quiet_opt, reads, request,
        serve, serve_request, table_actions, take_timer, to_lua, unbadge, unbind, user_only, with_host_list,
    };
    pub(in crate::plugin) use crate::config::ThemeDef;
    pub(in crate::plugin) use crate::config::lua;
    pub(in crate::plugin) use crate::plugin::folder::Storage;
    pub(in crate::plugin) use crate::plugin::op::{self, Op, Removable};
    pub(in crate::plugin) use crate::plugin::permission::Permission;
    pub(in crate::plugin) use mlua::{Function, Lua, Table, Value, Variadic};
    pub(in crate::plugin) use serde_json::{Map, Value as Json, json};
    pub(in crate::plugin) use std::rc::Rc;
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
            crate::plugin::API_VERSION,
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
            crate::plugin::API_VERSION,
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
