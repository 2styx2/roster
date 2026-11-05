//! `roster.inventory`: the Hosts, with `inventory.read`, and their edits as Pending changes, with `inventory.write`. Its functions as the API declares them.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.inventory.hosts",
        params: &[],
        summary: "Every Host, in `roster.yml` order",
        doc: "From serve's [`hosts.list`](serve-api.md): while `roster.yml` doesn't load (an outside edit), the last good Hosts. The groups are [`roster.inventory.groups()`](#rosterinventorygroups), from the same answer when it's called in the same call (since api 4). [`roster.inventory.request`](#rosterinventoryrequestdone) asks without waiting.",
        returns: (
            "Host[]",
            "The Hosts, each with its Login references (a vault item's name, never a password; a `cmd:` or `env:` one cut to its kind).",
        ),
        errors: &[(
            "roster.inventory.hosts: MESSAGE (code N)",
            "roster serve failed (see [Errors](#errors))",
        )],
        refused: &[],
        needs: Needs::Permission("inventory.read"),
        since: 2,
        example: "for _, h in ipairs(roster.inventory.hosts()) do\n  if not h.reviewed then roster.badges.set(h.name, \"review\") end\nend",
    },
    Function {
        path: "roster.inventory.host",
        params: &[p("name", "string", "The Host's exact name.")],
        summary: "One Host, by its exact name",
        doc: "From serve's [`host.get`](serve-api.md). An unknown name is `nil` (since api 3; it was an error in api 2).",
        returns: ("Host?", "The Host, or `nil` when no Host has that name."),
        errors: &[(
            "roster.inventory.host: MESSAGE (code N)",
            "roster serve failed otherwise",
        )],
        refused: &[],
        needs: Needs::Permission("inventory.read"),
        since: 2,
        example: "local h = roster.inventory.host(name)\nif h then roster.notify(name .. \" is \" .. h.ip) end",
    },
    Function {
        path: "roster.inventory.groups",
        params: &[],
        summary: "Every group, by name",
        doc: "From serve's [`hosts.list`](serve-api.md), as `roster.inventory.hosts()` is: called in the same call as `hosts()`, it uses that answer rather than read the Inventory again (since api 4; a call into serve that can change something in between, a write or `mesh.cut`, reads it again). A Host's `group` names one of them.",
        returns: ("table<string, Group>", "The groups, by name."),
        errors: &[(
            "roster.inventory.groups: MESSAGE (code N)",
            "roster serve failed (see [Errors](#errors))",
        )],
        refused: &[],
        needs: Needs::Permission("inventory.read"),
        since: 3,
        example: "local groups = roster.inventory.groups()\nfor _, h in ipairs(roster.inventory.hosts()) do\n  local g = groups[h.group]\n  roster.notify(h.name .. \" is in \" .. (g and g.title ~= \"\" and g.title or h.group))\nend",
    },
    Function {
        path: "roster.inventory.request",
        params: &[p(
            "done",
            "fun(list: HostList?, err: string?)",
            "Runs once with the answer: every Host and group (`list.hosts`, `list.groups`), or `nil` and why (`roster.inventory.request: MESSAGE (code N)`). Its return value is ignored; an error in it counts like an action's.",
        )],
        summary: "Reads every Host and group without waiting: `done` gets them",
        doc: "Serve's [`hosts.list`](serve-api.md), asked as [`roster.serve.request`](#rosterserverequestmethod-params-done) asks: it returns at once and `done` runs later on the Plugin's thread, as a call of its own, so the Plugin keeps answering the user while roster serve is busy (a Publish holds `roster.yml` for a minute or two). Its answer carries the user's call as a `roster.serve.request`'s does. It counts toward the 8 requests a Plugin may have waiting, and needs no `serve:` permission. A `cmd:` or `env:` Login reference is cut to its kind, as in every read.",
        returns: ("", ""),
        errors: &[(
            "roster.inventory.request: 8 requests are waiting for roster serve already: wait for one to answer",
            "8 `roster.serve.request` and `roster.inventory.request` calls haven't answered yet",
        )],
        refused: &[],
        needs: Needs::Permission("inventory.read"),
        since: 4,
        example: "roster.inventory.request(function(list, err)\n  if not list then return roster.notify(err, \"warn\") end\n  roster.status.set(\"hosts\", { text = #list.hosts .. \" Hosts\" })\nend)",
    },
    Function {
        path: "roster.inventory.update",
        params: &[
            p("host", "string", "The Host's exact name."),
            p("changes", "Change", "The fields to change, and their new values."),
        ],
        summary: "Changes a Host's fields, as a Pending change",
        doc: "serve's [`host.update`](serve-api.md#editing-pending-changes): `roster.yml` is edited as text (comments and every other entry stay) and the change waits for you to review and Publish it. A change to `ip`, `user`, `port` or `auth` needs a test login of exactly those values first (`host.verify_login`), which a Plugin can't make: from a Plugin those fail with code 75. Only `title`, `description` and `type` go through. Only while the user runs one of your actions, commands or finder items (decision Q100).",
        returns: ("UpdateResult", "What was written."),
        errors: &[
            (
                "roster.inventory.update: only while the user runs one of your actions, commands or finder items",
                "at load, in an event listener, a timer, a finder's `items` or a `:check`: it changes the Inventory",
            ),
            (
                "roster.inventory.update: params.changes: … (code -32602)",
                "a field that can't be edited here, or a value of the wrong kind",
            ),
            (
                "roster.inventory.update: unknown host 'NAME' (code 2)",
                "no Host has that name",
            ),
            (
                "roster.inventory.update: … (code 75)",
                "a change to `ip`, `user`, `port` or `auth`",
            ),
            (
                "roster.inventory.update: … (code 70 or 74)",
                "no git repo for Pending changes, or the edit wouldn't load as asked (nothing written)",
            ),
        ],
        refused: &[],
        needs: Needs::Permission("inventory.write"),
        since: 2,
        example: "roster.inventory.update(\"esx-02\", { description = \"lab box, rack 3\" })",
    },
    Function {
        path: "roster.inventory.rename",
        params: &[
            p("host", "string", "The Host's exact name."),
            p("to", "string", "Its new name."),
        ],
        summary: "Renames a Host, as a Pending change",
        doc: "serve's [`host.rename`](serve-api.md#the-live-inventory-hosts-and-groups-and-outside-edits): only its key in `roster.yml` and its name in `links:` change. Its vault item keeps its name. Only while the user runs one of your actions, commands or finder items (decision Q100).",
        returns: ("RenameResult", "What was written."),
        errors: &[
            (
                "roster.inventory.rename: only while the user runs one of your actions, commands or finder items",
                "at load, in an event listener, a timer, a finder's `items` or a `:check`: it changes the Inventory",
            ),
            ("roster.inventory.rename: … (code 2)", "no Host has that name"),
            (
                "roster.inventory.rename: … (code 80 or 100)",
                "`to` isn't a valid name, or a Host or group has it",
            ),
            (
                "roster.inventory.rename: … (code 1, 70 or 74)",
                "`roster.yml` doesn't load now, no git repo, or the edit wouldn't load as asked",
            ),
        ],
        refused: &[],
        needs: Needs::Permission("inventory.write"),
        since: 2,
        example: "roster.inventory.rename(\"esx-02\", \"esx-02-old\")",
    },
    Function {
        path: "roster.inventory.move",
        params: &[
            p("host", "string", "The Host's exact name."),
            p("group", "string", "The group to move it to (at its end)."),
        ],
        summary: "Moves a Host to another group, as a Pending change",
        doc: "serve's [`host.move`](serve-api.md#the-live-inventory-hosts-and-groups-and-outside-edits): what it inherited from its old group and wouldn't from the new one is written on the Host, so it stays the same Host. Only while the user runs one of your actions, commands or finder items (decision Q100).",
        returns: (
            "MoveResult",
            "What was written, and which fields were pinned on the Host.",
        ),
        errors: &[
            (
                "roster.inventory.move: only while the user runs one of your actions, commands or finder items",
                "at load, in an event listener, a timer, a finder's `items` or a `:check`: it changes the Inventory",
            ),
            ("roster.inventory.move: … (code 2)", "no Host has that name"),
            ("roster.inventory.move: … (code 101)", "no such group"),
            (
                "roster.inventory.move: … (code 103)",
                "it would still come out different in the new group",
            ),
            (
                "roster.inventory.move: … (code 1, 70 or 74)",
                "`roster.yml` doesn't load now, no git repo, or the edit wouldn't load as asked",
            ),
        ],
        refused: &[],
        needs: Needs::Permission("inventory.write"),
        since: 2,
        example: "local r = roster.inventory.move(\"esx-02\", \"lab\")\nif #r.pinned > 0 then roster.notify(\"kept \" .. table.concat(r.pinned, \", \")) end",
    },
    Function {
        path: "roster.inventory.review",
        params: &[
            p("host", "string", "The Host's exact name."),
            opt(
                "reviewed",
                "boolean",
                "`true` (the default) marks it reviewed; `false` un-reviews it.",
            ),
        ],
        summary: "Marks a Host reviewed (or not), as a Pending change",
        doc: "serve's [`host.review`](serve-api.md#adding-a-host-hostadd). Only while the user runs one of your actions, commands or finder items (decision Q100).",
        returns: ("ReviewResult", "What was written."),
        errors: &[
            (
                "roster.inventory.review: only while the user runs one of your actions, commands or finder items",
                "at load, in an event listener, a timer, a finder's `items` or a `:check`: it changes the Inventory",
            ),
            ("roster.inventory.review: … (code 2)", "no Host has that name"),
            (
                "roster.inventory.review: params.reviewed must be true or false (code -32602)",
                "`reviewed` isn't a boolean",
            ),
            (
                "roster.inventory.review: … (code 70 or 74)",
                "no git repo, or the edit wouldn't load as asked",
            ),
        ],
        refused: &[],
        needs: Needs::Permission("inventory.write"),
        since: 2,
        example: "roster.inventory.review(\"esx-02\")",
    },
];
