//! `roster.storage`: the Plugin's own data folder (decision Q93). Its functions as the API declares them.

use super::*;

/// What `roster.storage`'s functions raise (decision Q93).
const STORAGE_ERRORS: &[(&str, &str)] = &[
    (
        "roster.storage.FN: \"NAME\" isn't a file name: letters, digits, - _ and . only, …",
        "a path (`a/b`, `../x`, `C:\\x`), a name starting with `.`, or other characters",
    ),
    (
        "roster.storage.FN: NAME is a link: roster won't follow it",
        "the file was made a link (a symlink, a junction): it's never followed",
    ),
    (
        "roster.storage.FN: the Plugin's data folder is a link …",
        "its folder was made a link: it's never followed",
    ),
    (
        "roster.storage.FN: there's no data folder for Plugins here",
        "the app has no data folder (a test, say)",
    ),
];

/// What `roster.storage.write` raises.
const STORAGE_WRITE_ERRORS: &[(&str, &str)] = &[
    (
        "roster.storage.write: NAME would be N bytes: a file holds at most 1 MB (1048576 bytes)",
        "the text is longer",
    ),
    (
        "roster.storage.write: the Plugin's data folder holds at most 10 MB …",
        "the folder would hold more (a file replaced counts only its new size)",
    ),
    (
        "roster.storage.write: the Plugin's data folder holds at most 1000 files",
        "a new file past the thousandth",
    ),
    (
        "roster.storage.write: \"NAME\" isn't a file name: …",
        "as `roster.storage.read`",
    ),
    (
        "roster.storage.write: NAME is a link: roster won't follow it",
        "as `roster.storage.read`",
    ),
];

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.storage.read",
        params: &[p("name", "string", "The file's name (`\"folders.json\"`).")],
        summary: "Reads one of the Plugin's files",
        doc: "",
        returns: ("string?", "What the file holds, or `nil` when there's no such file."),
        errors: STORAGE_ERRORS,
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "local seen = roster.storage.read(\"seen.txt\") or \"\"",
    },
    Function {
        path: "roster.storage.write",
        params: &[
            p("name", "string", "The file's name."),
            p("text", "string", "What it holds from now on, at most 1 MB (any bytes)."),
        ],
        summary: "Writes one of the Plugin's files, whole",
        doc: "Makes the file, or replaces what it held, all at once: a crash leaves the old content or the new, never half.",
        returns: ("", ""),
        errors: STORAGE_WRITE_ERRORS,
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.storage.write(\"seen.txt\", table.concat(lines, \"\\n\"))",
    },
    Function {
        path: "roster.storage.list",
        params: &[],
        summary: "The names of the Plugin's files",
        doc: "",
        returns: ("string[]", "In name order; `{}` before the first write."),
        errors: &[(
            "roster.storage.list: the Plugin's data folder is a link …",
            "its folder was made a link: it's never followed",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "for _, name in ipairs(roster.storage.list()) do roster.notify(name) end",
    },
    Function {
        path: "roster.storage.remove",
        params: &[p("name", "string", "The file's name.")],
        summary: "Removes one of the Plugin's files",
        doc: "",
        returns: ("boolean", "`true` if it was there."),
        errors: STORAGE_ERRORS,
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.storage.remove(\"cache.json\")",
    },
    Function {
        path: "roster.storage.read_json",
        params: &[p("name", "string", "The file's name.")],
        summary: "Reads one of the Plugin's files as JSON",
        doc: "Objects and arrays become tables, `null` becomes `nil`.",
        returns: ("any", "The value, or `nil` when there's no such file."),
        errors: &[
            (
                "roster.storage.read_json: NAME isn't JSON (…)",
                "the file holds something else",
            ),
            ("roster.storage.read_json: …", "as `roster.storage.read`"),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "local state = roster.storage.read_json(\"state.json\") or { hosts = {} }",
    },
    Function {
        path: "roster.storage.write_json",
        params: &[
            p("name", "string", "The file's name."),
            p(
                "value",
                "any",
                "Plain data: tables, text, numbers and booleans (no functions).",
            ),
        ],
        summary: "Writes one of the Plugin's files as JSON, whole",
        doc: "As `roster.storage.write`, with the value as indented JSON. An empty table is written as `{}` (Lua can't tell an empty list from an empty table).",
        returns: ("", ""),
        errors: &[
            (
                "roster.storage.write_json: a Lua function can't go to roster serve",
                "the value holds a function (or another value that isn't data)",
            ),
            ("roster.storage.write_json: …", "as `roster.storage.write`"),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.storage.write_json(\"state.json\", { hosts = { \"esx-02\" } })",
    },
];
