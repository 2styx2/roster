//! `roster.commands`: a Plugin's `:` commands.
//! Its functions as the API declares them, and their binding into a Plugin's `roster` module.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.commands.add",
        params: &[
            p(
                "name",
                "string",
                "The command: `:name ARGS`. Lower case letters, digits, `-`, `_` and `.`, at most 64.",
            ),
            p("spec", "CommandSpec", "Its description and what it runs."),
        ],
        summary: "Adds a `:` command",
        doc: "Adding it again replaces it (and the function it ran).",
        returns: ("", ""),
        errors: &[
            (
                "roster.commands.add: \"NAME\" isn't a name like \"recent-alerts\" (…)",
                "a bad `name`",
            ),
            (
                "roster.commands.add: `run` must be a function or a command line",
                "`spec.run` is missing or something else",
            ),
        ],
        refused: &[
            "`:NAME` is taken by roster, `init.lua` or another Plugin (`pinned: :pin is taken (other)`), or it's `:plugins`",
        ],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.commands.add(\"alerts\", {\n  desc = \"Recent alerts\",\n  run = function(a)\n    if a.words[1] == \"clear\" then clear() end\n  end,\n})\nroster.commands.add(\"pins\", { desc = \"Pinned Hosts\", run = \"finder pinned\" })",
    },
    Function {
        path: "roster.commands.remove",
        params: &[p("name", "string", "A command this Plugin added.")],
        summary: "Removes one of the Plugin's commands",
        doc: "Since api 5, removing one it doesn't have is an error; written for an older api, it does nothing.",
        returns: ("", ""),
        errors: &[
            (
                "roster.commands.remove: \"NAME\" isn't a name like …",
                "a bad `name` (since api 3)",
            ),
            (
                "roster.commands.remove: the Plugin has no command \"ID\" …",
                "it has none by that id (since api 5; for a Plugin written for an older api it does nothing)",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.commands.remove(\"alerts\")",
    },
    Function {
        path: "roster.commands.get",
        params: &[p("id", "string", "One of the Plugin's commands.")],
        summary: "One of the Plugin's commands, as it set it",
        doc: "A copy (see [Errors](#errors)).",
        returns: ("CommandSpec?", "`nil` if it has none by that id."),
        errors: &[("roster.commands.get: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "local s = roster.commands.get(\"alerts\")\nif s then\n  s.desc = \"Recent alerts, newest first\"\n  roster.commands.add(\"alerts\", s)\nend",
    },
    Function {
        path: "roster.commands.has",
        params: &[p("id", "string", "A command's id.")],
        summary: "Whether the Plugin has that command",
        doc: "",
        returns: ("boolean", "`true` if it has."),
        errors: &[("roster.commands.has: \"ID\" isn't a name like …", "a bad `id`")],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "if roster.commands.has(\"alerts\") then roster.commands.remove(\"alerts\") end",
    },
    Function {
        path: "roster.commands.list",
        params: &[],
        summary: "The ids of the Plugin's commands",
        doc: "Sorted.",
        returns: ("string[]", "A new list each call."),
        errors: &[],
        refused: &[],
        needs: Needs::Nothing,
        since: 5,
        example: "for _, id in ipairs(roster.commands.list()) do roster.commands.remove(id) end",
    },
];

/// Puts this module's functions in `roster` (runtime.rs's `api`), as the Plugin's grants allow.
pub(in crate::plugin) mod binding {
    use crate::plugin::runtime::prelude::*;

    pub(in crate::plugin) fn bind(lua: &Lua, shared: &Rc<Shared>, roster: &Table) -> mlua::Result<()> {
        // Commands: `:NAME ARGS` runs `run({ args = "ARGS", words = {…} })`, or a command line.
        let commands = lua.create_table()?;
        func!(lua, shared, commands, "add", |lua, s, (name, spec): (String, Table)| {
            check_id("roster.commands.add", &name)?;
            let given = Value::Table(spec.clone());
            let spec = data(
                lua,
                s,
                "roster.commands.add",
                &Value::Table(spec),
                &format!("command:{name}"),
            )?;
            let desc = spec.get("desc").and_then(Json::as_str).unwrap_or("").to_string();
            let Some(run) = spec.get("run").filter(|r| r.is_string() || r.get("handler").is_some()) else {
                return Err(mlua::Error::runtime(
                    "roster.commands.add: `run` must be a function or a command line",
                ));
            };
            // `complete` (api 3): a function the app calls as the user types, never a user's call.
            let complete = match spec.get("complete") {
                None => None,
                Some(c) => match c.get("handler").and_then(Json::as_u64) {
                    Some(id) => {
                        s.quiet.borrow_mut().insert(id);
                        Some(c.clone())
                    }
                    None => {
                        return Err(mlua::Error::runtime(
                            "roster.commands.add: `complete` must be a function: fun(arg: string): string[]",
                        ));
                    }
                },
            };
            let run = run.clone();
            s.commands.borrow_mut().insert(name.clone());
            own_put(lua, s, "command", &name, copy(lua, &given)?)?;
            push(
                s,
                Op::Command {
                    name,
                    desc,
                    run,
                    complete,
                },
            )
        });
        func!(lua, shared, commands, "remove", |lua, s, name: String| {
            let what = "roster.commands.remove";
            check_id(what, &name)?;
            must_have(lua, s, what, "commands", "command", "command", &name)?;
            s.commands.borrow_mut().remove(&name);
            own_put(lua, s, "command", &name, Value::Nil)?;
            push(
                s,
                Op::Remove {
                    kind: Removable::Command,
                    id: name,
                },
            )
        });
        reads(lua, &commands, "commands", "command")?;
        roster.raw_set("commands", commands)?;
        Ok(())
    }
}
