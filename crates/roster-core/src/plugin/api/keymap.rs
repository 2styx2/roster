//! `roster.keymap`: a Plugin's key bindings, after the Leader and in the Sidebar. Its functions as the API declares them.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.keymap.set",
        params: &[
            p(
                "context",
                "KeyContext",
                "`\"leader\"` (a key after the Leader), `\"list\"` or `\"list_vim\"` (the Sidebar, and its vim keys).",
            ),
            p("keys", "string", "The keys, space-separated: `\"w w\"`."),
            p(
                "action",
                "string|false",
                "A command line: one of the Plugin's commands or one of the app's that [`roster.cmd`](#rostercmdline) may run (`\"finder alerts\"`). `false` is deprecated: it takes the Plugin's binding off, as [`roster.keymap.del`](#rosterkeymapdelcontext-keys) does.",
            ),
        ],
        summary: "Binds keys to a command line",
        doc: "Never in the terminal. A function isn't an action: add a command and bind its name. The key runs its line as `:plugins run NAME LINE` (which `:keys` shows), checked each time as a button's line is: never `:plugins`, `:packages`, `:source` or another Plugin's command, and a command that needs a permission only while it's granted.",
        returns: ("", ""),
        errors: &[
            (
                "roster.keymap.set: the action is a command line such as \"alerts\" (add a command for a function)",
                "`action` isn't a string or `false`",
            ),
            (
                "roster.keymap.set: \"CONTEXT\" isn't a key context …",
                "not `leader`, `list` or `list_vim` (since api 5; for a Plugin written for an older api the app refuses it with a notice)",
            ),
            (
                "roster.keymap.set: the Plugin binds no \"KEYS\" in CONTEXT …",
                "`action` is `false` and the Plugin has no such binding (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[
            "a `context` other than the three (`keys go after the Leader or in the Sidebar …`), for a Plugin written for api 4 or older",
            "keys bound already, by roster, `init.lua` or another Plugin (`a` is Folders', `f` the Picker's; `:keys` lists them): the notice names what has them and up to three free ones like them (`␣ f is taken (by builtin: find). Free after the Leader: a, g, h`)",
            "keys that would hide a binding, or be hidden by one (`\"a z\"` when `a` is bound)",
            "when pressed, a line `roster.cmd` couldn't run (`:plugins grant …`, another Plugin's command): a notice says why",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.keymap.set(\"leader\", roster.plugin.config.leader or \"w w\", \"finder alerts\")",
    },
    Function {
        path: "roster.keymap.del",
        params: &[
            p("context", "KeyContext", "Where it was bound."),
            p("keys", "string", "The keys, as `set` took them."),
        ],
        summary: "Takes one of the Plugin's key bindings off",
        doc: "Keys it didn't bind stay as they are: a Plugin can't unbind roster's, `init.lua`'s or another Plugin's. Since api 5, taking off one it didn't bind is an error, as `init.lua`'s `roster.keymap.del` is; written for an older api, it does nothing.",
        returns: ("", ""),
        errors: &[
            (
                "roster.keymap.del: \"CONTEXT\" isn't a key context …",
                "not `leader`, `list` or `list_vim` (since api 5)",
            ),
            (
                "roster.keymap.del: the Plugin binds no \"KEYS\" in CONTEXT …",
                "it has no such binding (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.keymap.del(\"leader\", \"w w\")",
    },
    Function {
        path: "roster.keymap.get",
        params: &[
            p("context", "KeyContext", "`\"leader\"`, `\"list\"` or `\"list_vim\"`."),
            p("keys", "string", "The keys, as `set` took them."),
        ],
        summary: "The command line one of the Plugin's key bindings runs",
        doc: "Only the Plugin's own bindings, as it set them.",
        returns: ("string?", "`nil` if it binds no such keys there."),
        errors: &[(
            "roster.keymap.get: \"CONTEXT\" isn't a key context …",
            "not `leader`, `list` or `list_vim`",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "roster.echo(roster.keymap.get(\"leader\", \"w w\") or \"not bound\") -- \"finder alerts\"",
    },
    Function {
        path: "roster.keymap.has",
        params: &[
            p("context", "KeyContext", "`\"leader\"`, `\"list\"` or `\"list_vim\"`."),
            p("keys", "string", "The keys, as `set` took them."),
        ],
        summary: "Whether the Plugin binds those keys there",
        doc: "Only the Plugin's own bindings.",
        returns: ("boolean", "`true` if it has."),
        errors: &[(
            "roster.keymap.has: \"CONTEXT\" isn't a key context …",
            "not `leader`, `list` or `list_vim`",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.keymap.has(\"leader\", \"w w\") then roster.keymap.del(\"leader\", \"w w\") end",
    },
    Function {
        path: "roster.keymap.list",
        params: &[p(
            "context",
            "KeyContext",
            "`\"leader\"`, `\"list\"` or `\"list_vim\"`.",
        )],
        summary: "The Plugin's key bindings in a context",
        doc: "Only the Plugin's own, as `init.lua`'s `roster.keymap.list` gives the Config's. A copy: changing it binds nothing.",
        returns: ("table<string, string>", "Keys to command line."),
        errors: &[(
            "roster.keymap.list: \"CONTEXT\" isn't a key context …",
            "not `leader`, `list` or `list_vim`",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for keys, line in pairs(roster.keymap.list(\"leader\")) do roster.echo(keys .. \": \" .. line) end",
    },
];
