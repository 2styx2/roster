//! `roster.clipboard`: copying, only in the user's call.
//! Its functions as the API declares them, and their binding into a Plugin's `roster` module.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[Function {
    path: "roster.clipboard.copy",
    params: &[p("text", "string", "What to put on the clipboard, at most 64 KB.")],
    summary: "Puts text on the clipboard",
    doc: "Only while the user runs one of the Plugin's actions, commands or finder items, so a Plugin can't change what you copied behind your back. If the clipboard can't be written, the app says so, and the notices the call gave after the copy aren't shown.",
    returns: ("", ""),
    errors: &[
        (
            "roster.clipboard.copy: only while the user runs one of your actions, commands or finder items",
            "at load or in an event listener",
        ),
        (
            "roster.clipboard.copy: the text is over 65536 bytes",
            "the text is longer",
        ),
    ],
    refused: &[],
    needs: Needs::Nothing,
    since: 2,
    example: "actions = { { label = \"Copy\", icon = \"copy\", run = function() roster.clipboard.copy(line) end } }",
}];

/// Puts this module's functions in `roster` (runtime.rs's `api`), as the Plugin's grants allow.
pub(in crate::plugin) mod binding {
    use crate::plugin::runtime::prelude::*;

    pub(in crate::plugin) fn bind(lua: &Lua, shared: &Rc<Shared>, roster: &Table) -> mlua::Result<()> {
        // The clipboard: only while the user runs one of the Plugin's actions, commands or finder
        // items, never on its own (at load, on an event), so it can't swap what you copied.
        let clipboard = lua.create_table()?;
        func!(lua, shared, clipboard, "copy", |_lua, s, text: mlua::LuaString| {
            let text = text.to_string_lossy();
            if !s.user_call.get() {
                return Err(mlua::Error::runtime(
                    "roster.clipboard.copy: only while the user runs one of your actions, commands or finder items",
                ));
            }
            if text.len() > MAX_COPY {
                return Err(mlua::Error::runtime(format!(
                    "roster.clipboard.copy: the text is over {MAX_COPY} bytes"
                )));
            }
            push(s, Op::Copy { text })
        });
        roster.raw_set("clipboard", clipboard)?;
        Ok(())
    }
}
