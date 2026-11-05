//! `roster.terminal`: typing into a Session, with `terminal.write`. Its functions as the API declares them.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.terminal.send",
        params: &[
            p("session", "integer", "The Session's id, from an event (`e.session`)."),
            p(
                "text",
                "string",
                "What to type, as if the user typed it: `\"uptime\\n\"` runs `uptime`.",
            ),
        ],
        summary: "Types into an open Session",
        doc: "A Session that has ended, or an id that's no Session's, takes nothing.",
        returns: ("", ""),
        errors: &[],
        refused: &["`text` over 64 KB is cut"],
        needs: Needs::Permission("terminal.write"),
        since: 2,
        example: "roster.on(\"session_open\", function(e) roster.terminal.send(e.session, \"uptime\\n\") end)",
    },
];
