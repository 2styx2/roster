//! `roster.badges`: a badge on a Host's rows. Its functions as the API declares them.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.badges.set",
        params: &[
            p("host", "string", "The Host's name in the Inventory."),
            opt(
                "text",
                "string",
                "The badge: keep it short, a count (`\"2\"`) or a word (at most 40 characters); `nil` takes it off.",
            ),
        ],
        summary: "Puts a badge on a Host's Inventory row, or takes it off",
        doc: "One badge per Host per Plugin; setting it again replaces it. A name that isn't a Host shows nowhere. The app draws it as a small chip right after the Host's name, in the text colour (never the accent, which means live), and cuts it after 12 characters; its tooltip and the row's accessible name have it whole, after your Plugin's name (`recent-alerts: 2`). So say the count, not what's counted: your Plugin's name says that. `nil` is [`roster.badges.remove`](#rosterbadgesremovehost)'s old spelling, checked as it is.",
        returns: ("", ""),
        errors: &[(
            "roster.badges.set: the Plugin has no badge on \"HOST\" …",
            "`text` is `nil` and it has no badge on that Host (since api 5; for a Plugin written for an older api it does nothing)",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.badges.set(\"esx-02\", tostring(2))",
    },
    Function {
        path: "roster.badges.remove",
        params: &[p("host", "string", "A Host the Plugin put a badge on.")],
        summary: "Takes the Plugin's badge off a Host's row",
        doc: "Only its own: another Plugin's badge on the same Host stays.",
        returns: ("", ""),
        errors: &[(
            "roster.badges.remove: the Plugin has no badge on \"HOST\" …",
            "it has no badge on that Host (since api 5; for a Plugin written for an older api it does nothing)",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.badges.has(\"esx-02\") then roster.badges.remove(\"esx-02\") end",
    },
    Function {
        path: "roster.badges.get",
        params: &[p("host", "string", "A Host's name.")],
        summary: "The text of the Plugin's badge on a Host",
        doc: "As the Plugin set it, before the app cuts it to fit.",
        returns: ("string?", "`nil` if it has none on that Host."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "local n = tonumber(roster.badges.get(\"esx-02\") or \"0\") or 0\nroster.badges.set(\"esx-02\", tostring(n + 1))",
    },
    Function {
        path: "roster.badges.has",
        params: &[p("host", "string", "A Host's name.")],
        summary: "Whether the Plugin has a badge on a Host",
        doc: "",
        returns: ("boolean", "`true` if it has."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.badges.has(\"esx-02\") then roster.badges.remove(\"esx-02\") end",
    },
    Function {
        path: "roster.badges.list",
        params: &[],
        summary: "The Hosts the Plugin has a badge on",
        doc: "Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, host in ipairs(roster.badges.list()) do roster.badges.remove(host) end",
    },
];
