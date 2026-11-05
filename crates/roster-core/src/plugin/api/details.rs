//! `roster.details`: sections of a Host's details, per Host. Its functions as the API declares them.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.details.set",
        params: &[
            p("id", "string", "The section's id: a name like `mesh`."),
            p("host", "string", "The Host's name in the Inventory."),
            opt(
                "section",
                "DetailsSection",
                "Its title, text, facts and table; `nil` takes this Host's away.",
            ),
        ],
        summary: "Adds a section to a Host's details, or replaces it",
        doc: "One section per id per Host; setting it again for the Host replaces it and drops the functions its old table held (other Hosts' stay). A name that isn't a Host shows nowhere. A table's action gets the Host too (`e.host`).",
        returns: ("", ""),
        errors: &[("roster.details.set: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[
            "a section with that id from another Plugin",
            "a field of the wrong kind: that Host's section is dropped",
        ],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.details.set(\"mesh\", \"esx-02\", {\n  title = \"Mesh\",\n  facts = { { label = \"reach\", value = \"can reach 7 Hosts\" } },\n})",
    },
    Function {
        path: "roster.details.remove",
        params: &[p("id", "string", "One of the Plugin's sections.")],
        summary: "Removes a section from every Host's details",
        doc: "",
        returns: ("", ""),
        errors: &[
            ("roster.details.remove: \"ID\" isn't a name like …", "a bad `id`"),
            (
                "roster.details.remove: the Plugin has no Host-details section \"ID\" …",
                "it has that section on no Host (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.details.remove(\"mesh\")",
    },
    Function {
        path: "roster.details.get",
        params: &[
            p("id", "string", "The section's id."),
            p("host", "string", "A Host's name."),
        ],
        summary: "One of the Plugin's Host-details sections, as it set it for a Host",
        doc: "A copy (see [Errors](#errors)).",
        returns: ("DetailsSection?", "`nil` if it has none by that id on that Host."),
        errors: &[("roster.details.get: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "local reach = roster.details.get(\"reach\", \"esx-02\")",
    },
    Function {
        path: "roster.details.has",
        params: &[
            p("id", "string", "The section's id."),
            opt("host", "string", "A Host's name; left out, any Host."),
        ],
        summary: "Whether the Plugin has that section, on a Host or on any",
        doc: "",
        returns: ("boolean", "`true` if it has."),
        errors: &[("roster.details.has: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.details.has(\"reach\") then roster.details.remove(\"reach\") end",
    },
    Function {
        path: "roster.details.list",
        params: &[opt("id", "string", "A section's id.")],
        summary: "The ids of the Plugin's Host-details sections, or the Hosts one is on",
        doc: "Without `id`, the sections it has on at least one Host; with it, the Hosts that section is on. Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[("roster.details.list: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, host in ipairs(roster.details.list(\"reach\")) do roster.details.set(\"reach\", host, nil) end",
    },
];
