//! `roster.views`: a side panel or a full view of text, facts, a table or a graph. Its functions as the API declares them.

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
