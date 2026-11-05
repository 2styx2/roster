//! `roster.views`: a side panel or a full view of text, facts, a table or a graph.
//! Its functions as the API declares them, and their binding into a Plugin's `roster` module.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.views.set",
        params: &[
            p(
                "id",
                "string",
                "The view's id: a name like `discover`. `:view ID` opens it.",
            ),
            p(
                "view",
                "View",
                "Where it goes, its title, text, facts, and a table or a graph.",
            ),
        ],
        summary: "Adds a view, or replaces it",
        doc: "Setting it again replaces the whole view and drops the functions its old table held; an open view stays open and keeps its selected row. It doesn't open the view: `:view ID`, a key bound to `view ID`, the `views` finder or `roster.views.open` in one of your actions does.",
        returns: ("", ""),
        errors: &[("roster.views.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a view with that id from elsewhere",
            "a field of the wrong kind (`roster.views.set discover table row 2: id must be text`): the whole view is dropped",
            "an action key the table uses itself (`j`, `k`, `g`, `G`, `s`, `S`, `/`, `?`, `q`) or one used twice",
            "a graph's action key the graph uses itself (`h` `j` `k` `l` `H` `J` `K` `L` `g` `G` `n` `N` `o` `O` `t` `f` `m` `s` `S` `/` `?` `q` `+` `-` `=` `0`), a graph action's `when` naming what a node doesn't have (`when.colour: a node has no colour`), a node or cluster id used twice, an edge id used twice, or a table and a graph in one view",
        ],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.views.set(\"discover\", {\n  title = \"Discover\",\n  place = \"panel\",\n  text = \"Scanning 10.0.0.0/24\",\n  table = {\n    columns = {\n      { id = \"address\", label = \"Address\", kind = \"data\" },\n      { id = \"ports\", label = \"Ports\", kind = \"number\" },\n    },\n    rows = {},\n    sort = \"address\",\n    empty = \"Nothing found yet.\",\n    actions = {\n      { label = \"Keep\", key = \"a\", icon = \"add\", run = function(e) keep(e.row) end },\n    },\n  },\n})",
    },
    Function {
        path: "roster.views.update",
        params: &[
            p("id", "string", "One of the Plugin's views."),
            p(
                "changes",
                "ViewUpdate",
                "What changes: rows to add or replace, rows to take away, and the text or facts.",
            ),
        ],
        summary: "Changes some of a view's rows or nodes in place, or its text or facts",
        doc: "A row whose `id` is in the table already is replaced where it stands; a new one goes at the end (the table's sort still applies). The rest stay as they are, and so does the selection, so a scan can add what it finds as it finds it. Plain data only: the table's functions stay those `roster.views.set` gave. A graph's nodes, edges and clusters work the same way, by `id`: a node that turns live, or an edge that appears, changes where it stands, and every placed node keeps its place.",
        returns: ("", ""),
        errors: &[
            ("roster.views.update: \"ID\" isn't a name like …", "a bad `id`"),
            (
                "roster.views.update \"ID\": … (an update is plain data: functions go in roster.views.set)",
                "a function in `changes`",
            ),
            (
                "roster.views.update: the Plugin has no view \"ID\" …",
                "it never set one by that id, or removed it (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[
            "a view the Plugin hasn't set",
            "rows for a view without a table",
            "more than 10,000 rows in the table after the update",
            "nodes, edges or clusters for a view without a graph",
            "more than 5,000 nodes, 10,000 edges or 500 clusters in the graph after the update",
        ],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.views.update(\"discover\", {\n  text = \"Scanning 10.0.0.0/24: 40%\",\n  rows = { { id = \"10.0.0.7\", cells = { address = \"10.0.0.7\", ports = 2 } } },\n  remove = { \"10.0.0.9\" },\n})",
    },
    Function {
        path: "roster.views.open",
        params: &[
            p("id", "string", "One of the Plugin's views."),
            opt(
                "opts",
                "ViewOpenOptions",
                "Where it opens (since api 4): `{ select = \"esx-02\" }` selects that node of its graph or row of its table.",
            ),
        ],
        summary: "Opens a view",
        doc: "Only while the user runs one of the Plugin's actions, commands or finder items, so a Plugin never takes the screen on its own. One view is open at a time: this replaces the one that is.\n\nWith `select`, it opens at that node or row: a graph opens the node's cluster if it's collapsed and centres the node, a table scrolls to the row. Asked again while the view is open, it starts afresh at the new one. An id the view doesn't have opens it as without `select`. A Host-details section's action can so open a graph at its Host's node.",
        returns: ("", ""),
        errors: &[
            ("roster.views.open: \"ID\" isn't a name like …", "a bad `id`"),
            (
                "roster.views.open: opts is a table, as { select = ID }",
                "`opts` isn't a table",
            ),
            (
                "roster.views.open: select is the id of a node or row (a string)",
                "`select` isn't a string",
            ),
            (
                "roster.views.open: only while the user runs one of your actions, commands or finder items",
                "at load or in an event listener",
            ),
            (
                "roster.views.open: the Plugin has no view \"ID\" …",
                "it never set one by that id, or removed it (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &["a view the Plugin hasn't set"],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.commands.add(\"discover\", { desc = \"Scan a network\", run = function()\n  roster.views.open(\"discover\")\nend })\n-- A Host-details section's button: the map, at that Host.\nroster.details.set(\"reach\", \"esx-02\", { title = \"Reach\", facts = {}, actions = {\n  { label = \"Show on the map\", icon = \"map\", run = function(e) roster.views.open(\"topology\", { select = e.host }) end },\n} })",
    },
    Function {
        path: "roster.views.close",
        params: &[p("id", "string", "One of the Plugin's views.")],
        summary: "Closes a view, if it's open",
        doc: "Focus goes back where it was, as with `Esc`. Another view, or one of its own that isn't open, stays as it is.",
        returns: ("", ""),
        errors: &[
            ("roster.views.close: \"ID\" isn't a name like …", "a bad `id`"),
            (
                "roster.views.close: the Plugin has no view \"ID\" …",
                "it never set one by that id, or removed it (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.views.close(\"discover\")",
    },
    Function {
        path: "roster.views.remove",
        params: &[p("id", "string", "One of the Plugin's views.")],
        summary: "Removes a view",
        doc: "It closes if it's open, and its functions are dropped.",
        returns: ("", ""),
        errors: &[
            ("roster.views.remove: \"ID\" isn't a name like …", "a bad `id`"),
            (
                "roster.views.remove: the Plugin has no view \"ID\" …",
                "it never set one by that id, or removed it (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.views.remove(\"discover\")",
    },
    Function {
        path: "roster.views.has",
        params: &[p("id", "string", "A view's id.")],
        summary: "Whether the Plugin has that view",
        doc: "Set and not removed, open or not.",
        returns: ("boolean", "`true` if it has."),
        errors: &[("roster.views.has: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if not roster.views.has(\"discover\") then roster.views.set(\"discover\", { title = \"Discover\" }) end",
    },
    Function {
        path: "roster.views.list",
        params: &[],
        summary: "The ids of the Plugin's views",
        doc: "Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, id in ipairs(roster.views.list()) do roster.views.remove(id) end",
    },
];

/// Puts this module's functions in `roster` (runtime.rs's `api`), as the Plugin's grants allow.
pub(in crate::plugin) mod binding {
    use crate::plugin::runtime::prelude::*;

    pub(in crate::plugin) fn bind(lua: &Lua, shared: &Rc<Shared>, roster: &Table) -> mlua::Result<()> {
        // Views (ticket 76): a side panel or a full view of text, facts and a table, which the app
        // draws. Rows are plain data; a table's actions are functions that get the row. Opening one
        // is the user's call (an action, a command, a finder item), never the Plugin's on its own.
        let views = lua.create_table()?;
        func!(lua, shared, views, "set", |lua, s, (id, spec): (String, Table)| {
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
            own_put(lua, s, "view", &id, Value::Boolean(true))?;
            push(s, Op::View { id, spec })
        });
        func!(
            lua,
            shared,
            views,
            "update",
            |lua, s, (id, changes): (String, Table)| {
                check_id("roster.views.update", &id)?;
                must_have(lua, s, "roster.views.update", "views", "view", "view", &id)?;
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
                let mut changes =
                    plain(s, &format!("roster.views.update {id:?}"), &Value::Table(rest)).map_err(|e| {
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
                push(s, Op::ViewUpdate { id, changes })
            }
        );
        func!(lua, shared, views, "open", |lua, s, (id, opts): (String, Value)| {
            check_id("roster.views.open", &id)?;
            must_have(lua, s, "roster.views.open", "views", "view", "view", &id)?;
            if !s.user_call.get() {
                return Err(mlua::Error::runtime(
                    "roster.views.open: only while the user runs one of your actions, commands or finder items",
                ));
            }
            let mut select = None;
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
                    Value::String(v) => select = Some(v.to_string_lossy().to_string()),
                    _ => {
                        return Err(mlua::Error::runtime(
                            "roster.views.open: select is the id of a node or row (a string)",
                        ));
                    }
                }
            }
            push(s, Op::ViewOpen { id, select })
        });
        func!(lua, shared, views, "close", |lua, s, id: String| {
            check_id("roster.views.close", &id)?;
            must_have(lua, s, "roster.views.close", "views", "view", "view", &id)?;
            push(s, Op::ViewClose { id })
        });
        func!(lua, shared, views, "remove", |lua, s, id: String| {
            check_id("roster.views.remove", &id)?;
            must_have(lua, s, "roster.views.remove", "views", "view", "view", &id)?;
            let (owner, actions) = (format!("view:{id}"), format!("view:{id}:actions"));
            drop_owners(lua, s, |k| k == owner || k == actions)?;
            own_put(lua, s, "view", &id, Value::Nil)?;
            push(
                s,
                Op::Remove {
                    kind: Removable::View,
                    id,
                },
            )
        });
        // Which views it has (api 5). A view's `get` waits for the core to keep each view as its
        // updates leave it (a follow-up of ticket 145).
        func!(lua, shared, views, "has", |lua, _s, id: String| {
            check_id("roster.views.has", &id)?;
            Ok(!own_get(lua, "view", &id)?.is_nil())
        });
        func!(lua, shared, views, "list", |lua, _s, (): ()| {
            lua.create_sequence_from(own_ids(lua, "view")?)
        });
        roster.raw_set("views", views)?;
        Ok(())
    }
}
