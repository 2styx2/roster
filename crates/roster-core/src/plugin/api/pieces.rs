//! The UI pieces the app draws for a Plugin, each set and taken away by id: `roster.sidebar`, `roster.status`, `roster.finders`, `roster.help`, `roster.health`, `roster.tutor`, `roster.toolbar` and `roster.progress`.
//! Its functions as the API declares them, and their binding into a Plugin's `roster` module.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.sidebar.set",
        params: &[
            p("id", "string", "The section's id: a name like `recent-alerts`."),
            p("section", "Section", "Its title, place, empty text and rows."),
        ],
        summary: "Adds a Sidebar section, or replaces it",
        doc: "Setting it again replaces the whole section, and drops the functions its old rows held.",
        returns: ("", ""),
        errors: &[("roster.sidebar.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a section with that id from elsewhere",
            "a field of the wrong kind (`roster.sidebar.set pinned row 2: label must be text`): the whole section is dropped",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.sidebar.set(\"pinned\", {\n  title = \"Pinned\",\n  order = 150,\n  empty = \"Nothing pinned. :pin HOST\",\n  rows = { { id = \"esx-02\", label = \"esx-02\", host = \"esx-02\", detail = \"10.0.0.5\" } },\n})",
    },
    Function {
        path: "roster.sidebar.remove",
        params: &[p("id", "string", "One of the Plugin's sections.")],
        summary: "Removes a Sidebar section",
        doc: "",
        returns: ("", ""),
        errors: &[
            (
                "roster.sidebar.remove: \"ID\" isn't a name like …",
                "a bad `id` (since api 3)",
            ),
            (
                "roster.sidebar.remove: the Plugin has no Sidebar section \"ID\" …",
                "it has none by that id (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.sidebar.remove(\"pinned\")",
    },
    Function {
        path: "roster.sidebar.get",
        params: &[p("id", "string", "One of the Plugin's Sidebar sections.")],
        summary: "One of the Plugin's Sidebar sections, as it set it",
        doc: "A copy (see [Errors](#errors)).",
        returns: ("Section?", "`nil` if it has none by that id."),
        errors: &[("roster.sidebar.get: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "local s = roster.sidebar.get(\"pinned\")\nif s then\n  s.title = \"Pinned Hosts\"\n  roster.sidebar.set(\"pinned\", s)\nend",
    },
    Function {
        path: "roster.sidebar.has",
        params: &[p("id", "string", "A Sidebar section's id.")],
        summary: "Whether the Plugin has that Sidebar section",
        doc: "",
        returns: ("boolean", "`true` if it has."),
        errors: &[("roster.sidebar.has: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.sidebar.has(\"pinned\") then roster.sidebar.remove(\"pinned\") end",
    },
    Function {
        path: "roster.sidebar.list",
        params: &[],
        summary: "The ids of the Plugin's Sidebar sections",
        doc: "Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, id in ipairs(roster.sidebar.list()) do roster.sidebar.remove(id) end",
    },
    Function {
        path: "roster.status.set",
        params: &[
            p("id", "string", "The segment's id."),
            p(
                "segment",
                "StatusSegment",
                "Its text, tooltip and what clicking it runs.",
            ),
        ],
        summary: "Adds a status bar segment, or replaces it",
        doc: "It comes after the app's own segments; a layout can place it (`modes.standard.statusbar`).",
        returns: ("", ""),
        errors: &[("roster.status.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &["a segment with that id from elsewhere", "no `text`"],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.status.set(\"alerts\", { text = \"⚠ \" .. #alerts, title = \"Recent alerts\", run = \"finder alerts\" })",
    },
    Function {
        path: "roster.status.remove",
        params: &[p("id", "string", "One of the Plugin's segments.")],
        summary: "Removes a status bar segment",
        doc: "",
        returns: ("", ""),
        errors: &[
            (
                "roster.status.remove: \"ID\" isn't a name like …",
                "a bad `id` (since api 3)",
            ),
            (
                "roster.status.remove: the Plugin has no status segment \"ID\" …",
                "it has none by that id (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.status.remove(\"alerts\")",
    },
    Function {
        path: "roster.status.get",
        params: &[p("id", "string", "One of the Plugin's status segments.")],
        summary: "One of the Plugin's status segments, as it set it",
        doc: "A copy (see [Errors](#errors)).",
        returns: ("StatusSegment?", "`nil` if it has none by that id."),
        errors: &[("roster.status.get: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "local s = roster.status.get(\"alerts\")\nif s then\n  s.text = \"4 alerts\"\n  roster.status.set(\"alerts\", s)\nend",
    },
    Function {
        path: "roster.status.has",
        params: &[p("id", "string", "A status segment's id.")],
        summary: "Whether the Plugin has that status segment",
        doc: "",
        returns: ("boolean", "`true` if it has."),
        errors: &[("roster.status.has: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.status.has(\"alerts\") then roster.status.remove(\"alerts\") end",
    },
    Function {
        path: "roster.status.list",
        params: &[],
        summary: "The ids of the Plugin's status segments",
        doc: "Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, id in ipairs(roster.status.list()) do roster.status.remove(id) end",
    },
    Function {
        path: "roster.finders.set",
        params: &[
            p("id", "string", "The finder's id: `:finder ID` opens it."),
            p("finder", "Finder", "Its title and items."),
        ],
        summary: "Adds a finder, or replaces it",
        doc: "",
        returns: ("", ""),
        errors: &[("roster.finders.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a finder with that id from elsewhere",
            "an item without a `label` or a `run`: the whole finder is dropped",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.finders.set(\"pinned\", {\n  title = \"Pinned Hosts\",\n  items = { { label = \"esx-02\", detail = \"10.0.0.5\", run = \"open esx-02\" } },\n})",
    },
    Function {
        path: "roster.finders.remove",
        params: &[p("id", "string", "One of the Plugin's finders.")],
        summary: "Removes a finder",
        doc: "",
        returns: ("", ""),
        errors: &[
            (
                "roster.finders.remove: \"ID\" isn't a name like …",
                "a bad `id` (since api 3)",
            ),
            (
                "roster.finders.remove: the Plugin has no finder \"ID\" …",
                "it has none by that id (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.finders.remove(\"pinned\")",
    },
    Function {
        path: "roster.finders.get",
        params: &[p("id", "string", "One of the Plugin's finders.")],
        summary: "One of the Plugin's finders, as it set it",
        doc: "A copy (see [Errors](#errors)).",
        returns: ("Finder?", "`nil` if it has none by that id."),
        errors: &[("roster.finders.get: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "local s = roster.finders.get(\"pinned\")\nif s then\n  s.title = \"Pinned Hosts\"\n  roster.finders.set(\"pinned\", s)\nend",
    },
    Function {
        path: "roster.finders.has",
        params: &[p("id", "string", "A finder's id.")],
        summary: "Whether the Plugin has that finder",
        doc: "",
        returns: ("boolean", "`true` if it has."),
        errors: &[("roster.finders.has: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.finders.has(\"pinned\") then roster.finders.remove(\"pinned\") end",
    },
    Function {
        path: "roster.finders.list",
        params: &[],
        summary: "The ids of the Plugin's finders",
        doc: "Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, id in ipairs(roster.finders.list()) do roster.finders.remove(id) end",
    },
    Function {
        path: "roster.help.set",
        params: &[
            p("topic", "string", "The page's topic: `:help TOPIC`."),
            p("page", "HelpPage", "Its title, summary and Markdown."),
        ],
        summary: "Adds a help page, or replaces it",
        doc: "It's listed in the help index under the Plugin's name.",
        returns: ("", ""),
        errors: &[("roster.help.set: \"TOPIC\" isn't a name like …", "a bad `topic`")],
        refused: &["a page with that topic from elsewhere", "no `markdown`"],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.help.set(\"pinned\", {\n  title = \"Pinned Hosts\",\n  summary = \"A Sidebar section of the Hosts you pin\",\n  markdown = \"# Pinned Hosts\\n\\n`:pin HOST` adds a Host.\",\n})",
    },
    Function {
        path: "roster.help.remove",
        params: &[p("topic", "string", "One of the Plugin's pages.")],
        summary: "Removes a help page",
        doc: "",
        returns: ("", ""),
        errors: &[
            (
                "roster.help.remove: \"TOPIC\" isn't a name like …",
                "a bad `topic` (since api 3)",
            ),
            (
                "roster.help.remove: the Plugin has no help page \"ID\" …",
                "it has none by that id (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.help.remove(\"pinned\")",
    },
    Function {
        path: "roster.help.get",
        params: &[p("id", "string", "One of the Plugin's help pages.")],
        summary: "One of the Plugin's help pages, as it set it",
        doc: "A copy (see [Errors](#errors)).",
        returns: ("HelpPage?", "`nil` if it has none by that id."),
        errors: &[("roster.help.get: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "local s = roster.help.get(\"pinned\")\nif s then\n  s.title = \"Pinned Hosts\"\n  roster.help.set(\"pinned\", s)\nend",
    },
    Function {
        path: "roster.help.has",
        params: &[p("id", "string", "A help page's id.")],
        summary: "Whether the Plugin has that help page",
        doc: "",
        returns: ("boolean", "`true` if it has."),
        errors: &[("roster.help.has: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.help.has(\"pinned\") then roster.help.remove(\"pinned\") end",
    },
    Function {
        path: "roster.help.list",
        params: &[],
        summary: "The ids of the Plugin's help pages",
        doc: "Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, id in ipairs(roster.help.list()) do roster.help.remove(id) end",
    },
    Function {
        path: "roster.health.set",
        params: &[
            p("id", "string", "The section's id."),
            p(
                "section",
                "HealthSection",
                "Its title, and its checks or the function that makes them.",
            ),
        ],
        summary: "Adds a section to `:check` (this Box's health), or replaces it",
        doc: "Like Neovim's `vim.health`: with `check`, each `:check` calls it and shows the lines it returns, under the Plugin's name on `:help health`. It runs with the Plugin's permissions and the time budget of any call (a quarter of a second), but it isn't a call the user started (no clipboard, questions, command lines or flagged serve methods in it); one that fails or doesn't answer in time is an `ERROR` line of its section, and `:check` goes on without it. With `checks` and no `check`, `:check` shows them as the Plugin last set them.",
        returns: ("", ""),
        errors: &[("roster.health.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a section with that id from elsewhere",
            "a check whose `level` isn't `ok`, `warn` or `error`, or without a `message`",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.health.set(\"recent-alerts\", {\n  title = \"Recent alerts\",\n  check = function()\n    if not granted(\"terminal.read\") then\n      return { { level = \"warn\", message = \"terminal.read isn't granted\", fix = \"Allow it in :plugins\" } }\n    end\n    return { { level = \"ok\", message = #alerts .. \" alerts so far\" } }\n  end,\n})",
    },
    Function {
        path: "roster.health.answer",
        params: &[
            p(
                "check",
                "integer",
                "The `check` field of what the section's `check` was called with.",
            ),
            p("lines", "HealthCheck[]", "The section's lines for that run."),
        ],
        summary: "Answers a `:check` section's check that returned `\"later\"`",
        doc: "A `check` that needs roster serve returns `\"later\"` at once and answers with this from the request's `done`, so it never waits for serve on the Plugin's thread. The app shows the section once it answers, or an `ERROR` line if it hasn't within 30 seconds; an answer for a run that's over (answered, or timed out) is dropped. Any run of the Plugin may answer, not only a call the user started.",
        returns: ("", ""),
        errors: &[("roster.health.answer: lines: …", "lines that aren't plain data")],
        refused: &["lines whose `level` isn't `ok`, `warn` or `error`, or without a `message`"],
        needs: Needs::Nothing,
        since: 3,
        example: "check = function(e)\n  roster.serve.request(\"discover.plan\", { targets = { \"10.0.0.0/30\" } }, function(plan, err)\n    roster.health.answer(e.check, plan and { { level = \"ok\", message = \"scans with \" .. plan.scanner } }\n      or { { level = \"error\", message = err } })\n  end)\n  return \"later\"\nend",
    },
    Function {
        path: "roster.health.remove",
        params: &[p("id", "string", "One of the Plugin's sections.")],
        summary: "Removes a `:check` section",
        doc: "",
        returns: ("", ""),
        errors: &[
            (
                "roster.health.remove: \"ID\" isn't a name like …",
                "a bad `id` (since api 3)",
            ),
            (
                "roster.health.remove: the Plugin has no `:check` section \"ID\" …",
                "it has none by that id (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.health.remove(\"recent-alerts\")",
    },
    Function {
        path: "roster.health.get",
        params: &[p("id", "string", "One of the Plugin's `:check` sections.")],
        summary: "One of the Plugin's `:check` sections, as it set it",
        doc: "A copy (see [Errors](#errors)).",
        returns: ("HealthSection?", "`nil` if it has none by that id."),
        errors: &[("roster.health.get: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "local s = roster.health.get(\"recent-alerts\")\nif s then\n  s.title = \"Recent alerts\"\n  roster.health.set(\"recent-alerts\", s)\nend",
    },
    Function {
        path: "roster.health.has",
        params: &[p("id", "string", "A `:check` section's id.")],
        summary: "Whether the Plugin has that `:check` section",
        doc: "",
        returns: ("boolean", "`true` if it has."),
        errors: &[("roster.health.has: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.health.has(\"recent-alerts\") then roster.health.remove(\"recent-alerts\") end",
    },
    Function {
        path: "roster.health.list",
        params: &[],
        summary: "The ids of the Plugin's `:check` sections",
        doc: "Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, id in ipairs(roster.health.list()) do roster.health.remove(id) end",
    },
    Function {
        path: "roster.tutor.set",
        params: &[
            p(
                "id",
                "string",
                "The tutorial's id: `:tutor ID` runs it, `:help tutor-ID` is its page.",
            ),
            p("tutorial", "Tutorial", "Its text and lessons."),
        ],
        summary: "Adds a tutorial, or replaces it",
        doc: "`:tutor ID` runs it on the demo Inventory, where the Plugin is loaded too, with the permissions the user granted it, so a step can wait for the Plugin's own command and the command works there. On the demo, `roster.inventory` sees the demo's Hosts, roster serve answers only `hosts.list`, `host.get` and `mesh.status` (a small, made-up Mesh), `roster.http` requests are never sent (their function hears why), and `roster.storage` is a throwaway folder that starts empty.",
        returns: ("", ""),
        errors: &[("roster.tutor.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a tutorial with that id, or a help page `tutor-ID`, from elsewhere",
            "no lessons, a lesson without a `title`, a step without an `id` or `text`, an `id` used twice, or an `on` that names no tutor event",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.tutor.set(\"pinned\", {\n  title = \"Pinned Hosts\",\n  lessons = {\n    { title = \"Find them\", text = \"Your pinned Hosts have their own finder.\",\n      steps = { { id = \"open\", text = \"Open it with `:finder pinned`\",\n                  on = { event = \"command\", id = \"finder\", arg = \"pinned\" } } } },\n  },\n})",
    },
    Function {
        path: "roster.tutor.remove",
        params: &[p("id", "string", "One of the Plugin's tutorials.")],
        summary: "Removes a tutorial",
        doc: "",
        returns: ("", ""),
        errors: &[
            (
                "roster.tutor.remove: \"ID\" isn't a name like …",
                "a bad `id` (since api 3)",
            ),
            (
                "roster.tutor.remove: the Plugin has no tutorial \"ID\" …",
                "it has none by that id (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.tutor.remove(\"pinned\")",
    },
    Function {
        path: "roster.tutor.get",
        params: &[p("id", "string", "One of the Plugin's tutorials.")],
        summary: "One of the Plugin's tutorials, as it set it",
        doc: "A copy (see [Errors](#errors)).",
        returns: ("Tutorial?", "`nil` if it has none by that id."),
        errors: &[("roster.tutor.get: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "local s = roster.tutor.get(\"pinned\")\nif s then\n  s.title = \"Pinning Hosts\"\n  roster.tutor.set(\"pinned\", s)\nend",
    },
    Function {
        path: "roster.tutor.has",
        params: &[p("id", "string", "A tutorial's id.")],
        summary: "Whether the Plugin has that tutorial",
        doc: "",
        returns: ("boolean", "`true` if it has."),
        errors: &[("roster.tutor.has: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.tutor.has(\"pinned\") then roster.tutor.remove(\"pinned\") end",
    },
    Function {
        path: "roster.tutor.list",
        params: &[],
        summary: "The ids of the Plugin's tutorials",
        doc: "Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, id in ipairs(roster.tutor.list()) do roster.tutor.remove(id) end",
    },
    Function {
        path: "roster.toolbar.set",
        params: &[
            p(
                "id",
                "string",
                "The control's id: a name like `scan`, which `modes.<mode>.toolbar` can list.",
            ),
            p(
                "control",
                "ToolbarControl",
                "Its label, icon or word, and what it runs.",
            ),
        ],
        summary: "Adds a control to the toolbar, or replaces it",
        doc: "",
        returns: ("", ""),
        errors: &[("roster.toolbar.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a control with that id from elsewhere (roster's own: `find`, `add`, …)",
            "a field of the wrong kind",
        ],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.toolbar.set(\"scan\", { label = \"Scan a network\", text = \"Scan\", icon = \"map\", run = \"discover\" })",
    },
    Function {
        path: "roster.toolbar.remove",
        params: &[p("id", "string", "One of the Plugin's controls.")],
        summary: "Removes a toolbar control",
        doc: "",
        returns: ("", ""),
        errors: &[(
            "roster.toolbar.remove: the Plugin has no toolbar control \"ID\" …",
            "it has none by that id (since api 5; for a Plugin written for an older api it does nothing)",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.toolbar.remove(\"scan\")",
    },
    Function {
        path: "roster.toolbar.get",
        params: &[p("id", "string", "One of the Plugin's toolbar controls.")],
        summary: "One of the Plugin's toolbar controls, as it set it",
        doc: "A copy (see [Errors](#errors)).",
        returns: ("ToolbarControl?", "`nil` if it has none by that id."),
        errors: &[("roster.toolbar.get: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "local s = roster.toolbar.get(\"scan\")\nif s then\n  s.label = \"Scan again\"\n  roster.toolbar.set(\"scan\", s)\nend",
    },
    Function {
        path: "roster.toolbar.has",
        params: &[p("id", "string", "A toolbar control's id.")],
        summary: "Whether the Plugin has that toolbar control",
        doc: "",
        returns: ("boolean", "`true` if it has."),
        errors: &[("roster.toolbar.has: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.toolbar.has(\"scan\") then roster.toolbar.remove(\"scan\") end",
    },
    Function {
        path: "roster.toolbar.list",
        params: &[],
        summary: "The ids of the Plugin's toolbar controls",
        doc: "Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, id in ipairs(roster.toolbar.list()) do roster.toolbar.remove(id) end",
    },
    Function {
        path: "roster.progress.set",
        params: &[
            p("id", "string", "A name like `scan`: `:cancel scan` cancels it."),
            p(
                "progress",
                "Progress",
                "What's going on, how far it has got, and how to stop it.",
            ),
        ],
        summary: "Shows or updates the progress of something long",
        doc: "With `done` and `total` it shows how far it has got; without, only that it's going. Set it again as it moves on, and `roster.progress.remove` it when it's over. With `cancel`, the user can stop it: the app calls the function once and shows \"Stopping…\" until you set or remove it again.",
        returns: ("", ""),
        errors: &[("roster.progress.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a progress with that id from another Plugin",
            "a field of the wrong kind",
        ],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.progress.set(\"scan\", {\n  title = \"Scanning 10.0.0.0/24\",\n  done = 40, total = 256,\n  cancel = function() roster.serve.call(\"discover.stop\") end,\n})",
    },
    Function {
        path: "roster.progress.remove",
        params: &[p("id", "string", "One of the Plugin's progresses.")],
        summary: "Takes a progress away: it's over",
        doc: "Say how it ended with `roster.notify` or in your view.",
        returns: ("", ""),
        errors: &[(
            "roster.progress.remove: the Plugin has no progress \"ID\" …",
            "it has none by that id (since api 5; for a Plugin written for an older api it does nothing)",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.progress.remove(\"scan\")\nroster.notify(\"Scan done: 12 Hosts found\")",
    },
    Function {
        path: "roster.progress.get",
        params: &[p("id", "string", "One of the Plugin's progresses.")],
        summary: "One of the Plugin's progresses, as it set it",
        doc: "A copy (see [Errors](#errors)).",
        returns: ("Progress?", "`nil` if it has none by that id."),
        errors: &[("roster.progress.get: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "local s = roster.progress.get(\"scan\")\nif s then\n  s.text = \"Scanning 10.0.0.0/24\"\n  roster.progress.set(\"scan\", s)\nend",
    },
    Function {
        path: "roster.progress.has",
        params: &[p("id", "string", "A progress's id.")],
        summary: "Whether the Plugin has that progress",
        doc: "",
        returns: ("boolean", "`true` if it has."),
        errors: &[("roster.progress.has: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.progress.has(\"scan\") then roster.progress.remove(\"scan\") end",
    },
    Function {
        path: "roster.progress.list",
        params: &[],
        summary: "The ids of the Plugin's progresses",
        doc: "Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, id in ipairs(roster.progress.list()) do roster.progress.remove(id) end",
    },
];

/// Puts this module's functions in `roster` (runtime.rs's `api`), as the Plugin's grants allow.
pub(in crate::plugin) mod binding {
    use crate::plugin::runtime::prelude::*;

    pub(in crate::plugin) fn bind(lua: &Lua, shared: &Rc<Shared>, roster: &Table) -> mlua::Result<()> {
        // UI pieces the core draws: a Sidebar section, a status segment, a finder source, a help
        // page, a `:check` section, a tutorial (`:tutor`), a toolbar control, a progress (ticket 78). `set` adds or replaces one; `remove` takes it away.
        for (module, piece, noun) in [
            ("sidebar", Removable::Section, "Sidebar section"),
            ("status", Removable::Status, "status segment"),
            ("finders", Removable::Finder, "finder"),
            ("help", Removable::Help, "help page"),
            ("health", Removable::Health, "`:check` section"),
            ("tutor", Removable::Tutor, "tutorial"),
            ("toolbar", Removable::Toolbar, "toolbar control"),
            ("progress", Removable::Progress, "progress"),
        ] {
            let kind = piece.name();
            let t = lua.create_table()?;
            let what = format!("roster.{module}.set");
            func!(lua, shared, t, "set", |lua, s, (id, spec): (String, Table)| {
                check_id(&what, &id)?;
                let given = Value::Table(spec.clone());
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
                own_put(lua, s, kind, &id, copy(lua, &given)?)?;
                push(s, op::set(piece, id, spec))
            });
            let removing = format!("roster.{module}.remove");
            func!(lua, shared, t, "remove", |lua, s, id: String| {
                check_id(&removing, &id)?;
                must_have(lua, s, &removing, module, noun, kind, &id)?;
                own_put(lua, s, kind, &id, Value::Nil)?;
                push(s, Op::Remove { kind: piece, id })
            });
            reads(lua, &t, module, kind)?;
            roster.raw_set(module, t)?;
        }

        // A `:check` section's lines for a run whose `check` returned "later" (decision Q112h): from a
        // request's answer, so the check never waits for serve on the Plugin's thread.
        {
            let health: Table = roster.raw_get("health")?;
            func!(
                lua,
                shared,
                health,
                "answer",
                |_lua, s, (check, lines): (u64, Value)| {
                    let checks = plain(s, "roster.health.answer: lines", &lines)?;
                    push(s, Op::HealthAnswer { check, checks })
                }
            );
        }
        Ok(())
    }
}
