//! `roster.sessions`: going to a Session, the ones open now, and opening one.
//! Its functions as the API declares them, and their binding into a Plugin's `roster` module.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.sessions.show",
        params: &[
            p("session", "integer", "The Session's id, from an event (`e.session`)."),
            opt(
                "line",
                "string",
                "Text of a line it printed: the app searches its scrollback from the bottom for the latest line with it, and shows it highlighted.",
            ),
        ],
        summary: "Goes to a Session, and to a line in its scrollback",
        doc: "It happens after the call returns, as if the user picked the Session: with two Sessions to one Host, this is the one the id names. With `line`, the terminal's search opens on it, so `Enter` and `Shift+Enter` go on up and down from there and `Esc` closes it; a line no longer in the scrollback shows \"no matches\" there. A Session that has ended is said in a notice. Only while the user runs one of your actions, commands or finder items.",
        returns: ("", ""),
        errors: &[(
            "roster.sessions.show: only while the user runs one of your actions, commands or finder items",
            "at load or in an event listener",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "-- An alert's row goes to the line in the Session that printed it.\nopen = function(e) roster.sessions.show(alerts[e.row].session, alerts[e.row].text) end",
    },
    Function {
        path: "roster.sessions.list",
        params: &[],
        summary: "The Sessions open now, in the order they opened",
        doc: "Every Session that is open, the ones that opened before the Plugin loaded too: the events only tell a Plugin what happens after it loads, so read this at load and follow `session_open` and `session_exit` from there. A Session is open from its `session_open` to its `session_exit`; one that ended but whose tab is still there isn't listed. The app keeps the list in the order it saw each Session open, and a Session that connects again (the same id) opens again, so it goes last. In a listener for either event the list already has (or no longer has) that Session. It reads what the app last said, never roster serve, so it never waits.",
        returns: (
            "Session[]",
            "Each open Session's id and Host (and, with `terminal.read`, its folder), oldest open first.",
        ),
        errors: &[],
        refused: &[],
        needs: Needs::Hears("session_open"),
        since: 4,
        example: "local live = {}\nfor _, s in ipairs(roster.sessions.list()) do\n  if s.host then live[s.host] = true end\nend\nroster.on(\"session_open\", function(e) if e.host then live[e.host] = true end end)",
    },
    Function {
        path: "roster.sessions.open",
        params: &[p("host", "string", "The Host's exact name.")],
        summary: "Opens a Session on a Host, as `:connect HOST`",
        doc: "It happens after the call returns, as if the user ran `:connect HOST`: the app's own errors (an unknown or unreviewed Host, a locked vault) show as they would then.",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Permission("sessions.open"),
        since: 2,
        example: "roster.sessions.open(\"esx-02\")",
    },
];

/// Puts this module's functions in `roster` (runtime.rs's `api`), as the Plugin's grants allow.
pub(in crate::plugin) mod binding {
    use crate::plugin::runtime::prelude::*;

    pub(in crate::plugin) fn bind(lua: &Lua, shared: &Rc<Shared>, roster: &Table) -> mlua::Result<()> {
        let g = &shared.grants;
        // Sessions: going to one (ticket 78) needs nothing but the user's call; opening one needs
        // sessions.open.
        let sessions = lua.create_table()?;
        func!(lua, shared, sessions, "show", |_lua,
                                              s,
                                              (session, line): (
            u64,
            Option<mlua::LuaString>
        )| {
            user_only(s, "roster.sessions.show")?;
            let line = line.map(|l| l.to_string_lossy());
            push(s, Op::SessionShow { session, line })
        });
        // The Sessions open now (decision Q127): the sum of what `session_open` and `session_exit`
        // say, so there for whoever may hear them (plugin/api's `Needs::Hears`).
        if may_hear("session_open", g).is_ok() {
            func!(lua, shared, sessions, "list", |lua, s, (): ()| {
                let list = lua.create_table()?;
                // The folder is what the Session printed (OSC 7): terminal.read's, as the output is.
                let reads = s.grants.contains(&Permission::TerminalRead);
                for open in s.sessions.list() {
                    let one = lua.create_table()?;
                    one.raw_set("session", open.session)?;
                    one.raw_set("host", open.host)?;
                    if reads {
                        one.raw_set("cwd", open.cwd)?;
                    }
                    list.raw_push(one)?;
                }
                Ok(list)
            });
        }
        if g.contains(&Permission::SessionsOpen) {
            func!(lua, shared, sessions, "open", |_lua, s, host: String| {
                need(s, &Permission::SessionsOpen, "roster.sessions.open")?;
                push(s, Op::Open { host })
            });
        }
        roster.raw_set("sessions", sessions)?;
        Ok(())
    }
}
