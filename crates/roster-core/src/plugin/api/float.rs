//! `roster.float`: a floating window over the terminal.
//! Its functions as the API declares them, and their binding into a Plugin's `roster` module.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.float.open",
        params: &[p("float", "Float", "Its title and lines.")],
        summary: "Opens a floating window over the terminal, or replaces the Plugin's",
        doc: "It lies over the terminal, on the side away from the Sidebar, so it never resizes a Session. `Esc` closes it. Its actions are buttons at its foot (with a key each, once it has focus), and its links open in the browser, the address shown with them.",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.float.open({ title = \"esx-02\", lines = { \"ERROR disk full\", \"at 10:42\" } })",
    },
    Function {
        path: "roster.float.close",
        params: &[],
        summary: "Closes the Plugin's floating window",
        doc: "Another Plugin's stays.",
        returns: ("", ""),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.float.close()",
    },
];

/// Puts this module's functions in `roster` (runtime.rs's `api`), as the Plugin's grants allow.
pub(in crate::plugin) mod binding {
    use crate::plugin::runtime::prelude::*;

    pub(in crate::plugin) fn bind(lua: &Lua, shared: &Rc<Shared>, roster: &Table) -> mlua::Result<()> {
        // A floating window over the terminal: a title and lines of text; `close` hides it.
        let float = lua.create_table()?;
        func!(lua, shared, float, "open", |lua, s, spec: Table| {
            let spec = data(lua, s, "roster.float.open", &Value::Table(spec), "float")?;
            push(s, Op::Float { spec })
        });
        func!(lua, shared, float, "close", |_lua, s, (): ()| {
            push(s, Op::Float { spec: Json::Null })
        });
        roster.raw_set("float", float)?;
        Ok(())
    }
}
