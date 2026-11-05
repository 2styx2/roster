//! `roster.themes`: Themes a Plugin defines. Its functions as the API declares them.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.themes.define",
        params: &[
            p("id", "string", "The Theme's id, as `:theme ID` takes it."),
            p("theme", "Theme", "As `init.lua`'s `themes` takes one."),
        ],
        summary: "Adds a Theme",
        doc: "Checked as `init.lua`'s `themes` are.",
        returns: ("", ""),
        errors: &[
            ("roster.themes.define: \"ID\" isn't a name like …", "a bad `id`"),
            (
                "roster.themes.define \"ID\": …",
                "the Theme isn't one `init.lua` would take: an unknown field or token, a colour that isn't one",
            ),
        ],
        refused: &["a Theme with that id exists already"],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.themes.define(\"dusk\", { base = \"nord\", colors = { accent = \"#e0a060\" } })",
    },
    Function {
        path: "roster.themes.remove",
        params: &[p("id", "string", "One of the Plugin's Themes.")],
        summary: "Removes one of the Plugin's Themes",
        doc: "If it was the Theme in use, the app goes back to `init.lua`'s. Since api 5, removing one it doesn't have is an error, as `init.lua`'s `roster.themes.remove` is; written for an older api, it does nothing.",
        returns: ("", ""),
        errors: &[
            ("roster.themes.remove: \"ID\" isn't a name like …", "a bad `id`"),
            (
                "roster.themes.remove: the Plugin has no Theme \"ID\" …",
                "it has none by that id (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.themes.remove(\"dusk\")",
    },
    Function {
        path: "roster.themes.get",
        params: &[p("id", "string", "One of the Plugin's Themes.")],
        summary: "One of the Plugin's Themes, as it set it",
        doc: "A copy (see [Errors](#errors)).",
        returns: ("Theme?", "`nil` if it has none by that id."),
        errors: &[("roster.themes.get: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "local s = roster.themes.get(\"dusk\")\nif s then\n  s.appearance = \"light\"\n  roster.themes.define(\"dusk\", s)\nend",
    },
    Function {
        path: "roster.themes.has",
        params: &[p("id", "string", "A Theme's id.")],
        summary: "Whether the Plugin has that Theme",
        doc: "",
        returns: ("boolean", "`true` if it has."),
        errors: &[("roster.themes.has: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.themes.has(\"dusk\") then roster.themes.remove(\"dusk\") end",
    },
    Function {
        path: "roster.themes.list",
        params: &[],
        summary: "The ids of the Plugin's Themes",
        doc: "Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, id in ipairs(roster.themes.list()) do roster.themes.remove(id) end",
    },
];
