//! `roster.terminal`: typing into a Session, with `terminal.write`.
//! Its functions as the API declares them, and their binding into a Plugin's `roster` module.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[Function {
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
}];

/// Puts this module's functions in `roster` (runtime.rs's `api`), as the Plugin's grants allow.
pub(in crate::plugin) mod binding {
    use crate::plugin::runtime::prelude::*;

    pub(in crate::plugin) fn bind(lua: &Lua, shared: &Rc<Shared>, roster: &Table) -> mlua::Result<()> {
        let g = &shared.grants;
        if g.contains(&Permission::TerminalWrite) {
            let terminal = lua.create_table()?;
            func!(
                lua,
                shared,
                terminal,
                "send",
                |_lua, s, (session, text): (u64, String)| {
                    need(s, &Permission::TerminalWrite, "roster.terminal.send")?;
                    push(s, Op::Send { session, text })
                }
            );
            roster.raw_set("terminal", terminal)?;
        }
        Ok(())
    }
}
