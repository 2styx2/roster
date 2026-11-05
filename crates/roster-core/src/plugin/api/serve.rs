//! `roster.serve`: roster serve's methods a Plugin was granted.
//! Its functions as the API declares them, and their binding into a Plugin's `roster` module.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.serve.call",
        params: &[
            p(
                "method",
                "string",
                "A roster serve method the Plugin was granted, by name (`serve:inventory.info` grants `inventory.info`).",
            ),
            opt(
                "params",
                "table",
                "The method's params; `{}` if left out. Data only: no functions.",
            ),
        ],
        summary: "Calls a roster serve method the Plugin was granted",
        doc: "Waits for the answer, however long roster serve takes (a call behind the app's Publish waits for it); that time doesn't count against the Plugin's budget, nor toward it being given up on, but the Plugin does nothing else meanwhile. [`roster.serve.request`](#rosterserverequestmethod-params-done) asks without waiting. A Plugin may be granted `inventory.info`, `hosts.list`, `host.get`, `host.check`, `host.check_job`, `changes.diff` and the `mesh.*` and `discover.*` methods; never one that reaches a secret. Every method the install prompt flags, the ones that act on the network or the Inventory (all but `inventory.info`, `hosts.list`, `host.get`, `host.check_job`, `changes.diff`, `mesh.status`, `mesh.plan`, `mesh.job`, `mesh.stop`, `discover.plan`, `discover.status` and `discover.stop`; `mesh.apply`, `mesh.cut`, `host.check`, `discover.start` and `discover.add` among them), only while the user runs one of your actions, commands or finder items, or answers your question: never at load, on an event, from a timer, or in a finder's `items` or a `:check` section's `check`. One call may ask roster serve this way (and through `roster.inventory`) at most 100 times, waiting 300 s in all. What each returns is under [roster serve's results](#roster-serves-results); in it, as in `roster.inventory`'s, a `cmd:` or `env:` Login reference is cut to its kind ([`LoginRef`](#loginref)), in any text of it: a diff's line or a step's message too.",
        returns: ("any", "The method's result, as Lua tables (JSON `null` is `nil`)."),
        errors: &[
            (
                "roster.serve.call: not granted (serve:METHOD)",
                "the Plugin wasn't granted that method",
            ),
            (
                "roster.serve.call METHOD: only while the user runs one of your actions, commands or finder items",
                "a flagged method (`mesh.apply`, `host.check`, `discover.start`, …) at load, in an event listener, a timer, a finder's `items` or a `:check`",
            ),
            (
                "roster.serve.call METHOD: more than 100 calls into roster serve in one go (roster.serve.request doesn't wait)",
                "the call asked roster serve 100 times already (or waited 300 s in all: `waited 300 s or more for roster serve in one go`)",
            ),
            (
                "roster.serve.call METHOD: MESSAGE (code N)",
                "the method failed (its codes are in [serve-api.md](serve-api.md))",
            ),
        ],
        refused: &[],
        needs: Needs::AnyServe,
        since: 2,
        example: "local info = roster.serve.call(\"inventory.info\")\nroster.status.set(\"box\", { text = info.box .. \": \" .. info.host_count .. \" Hosts\" })",
    },
    Function {
        path: "roster.serve.request",
        params: &[
            p(
                "method",
                "string",
                "A roster serve method the Plugin was granted, as [`roster.serve.call`](#rosterservecallmethod-params)'s.",
            ),
            opt(
                "params",
                "table",
                "The method's params; `nil` or `{}` for none. Data only: no functions.",
            ),
            p(
                "done",
                "fun(result: any, err: string?)",
                "Runs once with the answer: the method's `result` (as `roster.serve.call` returns it), or `nil` and why (`roster.serve.request METHOD: MESSAGE (code N)`). Its return value is ignored; an error in it counts like an action's.",
            ),
        ],
        summary: "Asks roster serve without waiting: `done` gets the answer",
        doc: "Returns at once; `done` runs later on the Plugin's thread, as a call of its own, so the Plugin keeps answering the user while roster serve is busy (a Publish holds `roster.yml` for a minute or two). The same rules as [`roster.serve.call`](#rosterservecallmethod-params): the method must be granted, a flagged one (`mesh.apply`, `discover.start`, …) only in a call the user started, and a `cmd:` or `env:` Login reference in the result is cut to its kind. **The answer to a request made in a call the user started is part of that call:** `done` may open a view, ask a question, copy or run a command line, as the call could, and may ask for a flagged method. A request made in that `done` doesn't carry it further, and one made at load, on an event or from a timer never has it. An answer for a Plugin unloaded or reloaded since is dropped. At most 8 wait at once.",
        returns: ("", ""),
        errors: &[
            (
                "roster.serve.request: not granted (serve:METHOD)",
                "the Plugin wasn't granted that method",
            ),
            (
                "roster.serve.request METHOD: only while the user runs one of your actions, commands or finder items",
                "a flagged method (`mesh.apply`, `host.check`, `discover.start`, …) at load, in an event listener, a timer, a finder's `items` or a `:check`",
            ),
            (
                "roster.serve.request METHOD: 8 requests are waiting for roster serve already: wait for one to answer",
                "8 haven't answered yet",
            ),
        ],
        refused: &[],
        needs: Needs::AnyServe,
        since: 3,
        example: "roster.commands.add(\"count\", { run = function()\n  roster.serve.request(\"hosts.list\", {}, function(r, err)\n    if not r then return roster.notify(err, \"warn\") end\n    roster.echo(#r.hosts .. \" Hosts\")\n  end)\nend })",
    },
];

/// Puts this module's functions in `roster` (runtime.rs's `api`), as the Plugin's grants allow.
pub(in crate::plugin) mod binding {
    use crate::plugin::runtime::prelude::*;

    pub(in crate::plugin) fn bind(lua: &Lua, shared: &Rc<Shared>, roster: &Table) -> mlua::Result<()> {
        let g = &shared.grants;
        if g.iter().any(|p| matches!(p, Permission::Serve(_))) {
            let t = lua.create_table()?;
            func!(
                lua,
                shared,
                t,
                "call",
                |lua, s, (method, params): (String, Option<Value>)| {
                    need(s, &Permission::Serve(method.clone()), "roster.serve.call")?;
                    let params = match params {
                        Some(v) => plain(s, "roster.serve.call", &v)?,
                        None => json!({}),
                    };
                    serve(lua, s, &format!("roster.serve.call {method}"), &method, params)
                }
            );
            // The same call, without waiting (decision Q103): `done(result)` or `done(nil, why)`.
            func!(lua, shared, t, "request", |lua,
                                              s,
                                              (method, params, done): (
                String,
                Option<Value>,
                Function
            )| {
                serve_request(lua, s, method, params, done)
            });
            roster.raw_set("serve", t)?;
        }
        Ok(())
    }
}
