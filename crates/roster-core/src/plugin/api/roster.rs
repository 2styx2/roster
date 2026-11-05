//! The `roster` module's own functions: notices, messages, the command line, questions, timers, events and grants.
//! Its functions as the API declares them, and their binding into a Plugin's `roster` module.

use super::*;

pub(super) const FUNCTIONS: &[Function] = &[
    Function {
        path: "roster.notify",
        params: &[
            p(
                "text",
                "string",
                "What to say. It's shown after the Plugin's name (`pinned: …`).",
            ),
            opt("level", "Level", "`\"info\"` (the default), `\"warn\"` or `\"error\"`."),
            opt(
                "opts",
                "NoticeOptions",
                "Buttons on the notice (since api 3): `{ actions = { { label = \"Show the plan\", run = \"view mesh-plan\" } } }`; whether an info notice is quiet (since api 4): `{ quiet = false }`.",
            ),
        ],
        summary: "Shows a notice, naming the Plugin",
        doc: "Warnings and errors always show. An info notice is quiet by default, as roster's own routine messages are (`ui.messages`, like Neovim's): unless `ui.messages = \"all\"`, it isn't drawn, a screen reader still hears it and `:messages` keeps it. An info notice with buttons shows, and `quiet` decides either way: mark `quiet = false` on what the user asked for: the result of something they started (\"Scan done: 12 Hosts answered, 3 new\"), an answer (\"No alerts\") or a refusal (\"Keep a Host first\"), and leave it out for a routine confirmation (\"Copied the line\"). A quiet notice from a timer, an event or a request's answer, which the user didn't ask for, leaves a message line that shows something (an error, an answer) as it is. Every notice, shown or quiet, is in `:messages`.\n\nA notice's button runs a command line when the user clicks it, as [`roster.cmd`](#rostercmdline) would: the click is the user's call, so `view ID` opens your view when a job that ran in the background has finished (a Plugin can't open one on its own, from a timer or an answer). It takes a command line, not a function, so a notice never holds on to one.",
        returns: ("", ""),
        errors: &[
            (
                "roster.notify: the level is \"info\", \"warn\" or \"error\"",
                "`level` is something else",
            ),
            (
                "roster.notify: actions… (a notice's action runs a command line, not a function)",
                "a function in `opts`",
            ),
            (
                "roster.notify: quiet is true or false",
                "`opts.quiet` is something else",
            ),
        ],
        refused: &["more than 2 actions, or one whose `run` isn't a command line"],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.notify(\"Copied esx-02's address\") -- quiet unless ui.messages = \"all\"\nroster.notify(\"leader: not a key sequence, using w w\", \"warn\")\nroster.notify(\"Plan ready: 4 Hosts change\", \"info\", { actions = { { label = \"Show the plan\", run = \"view mesh-plan\" } } })\nroster.notify(\"Scan done: 12 Hosts found\", \"info\", { quiet = false })",
    },
    Function {
        path: "roster.on",
        params: &[
            p(
                "event",
                "EventName",
                "The event's name: `lock`, `unlock`, `host_selected`, `session_open`, `session_exit`, `inventory_changed`, `terminal_output`, `command_done` or `job_progress`.",
            ),
            p(
                "listener",
                "fun(e: table)",
                "Runs with the event's payload (see [Events](#events)) each time it happens. Its return value is ignored.",
            ),
        ],
        summary: "Runs a function on an event",
        doc: "Several listeners for one event run in the order they were added. There's no way to stop listening short of `:plugins reload`. Ask [`roster.has`](#rosterhaspermission) first for an event that needs a permission.",
        returns: ("", ""),
        errors: &[
            (
                "roster.on: there's no event \"NAME\" (there's lock, unlock, …)",
                "`event` isn't one of them",
            ),
            (
                "roster.on: the EVENT event needs the P permission",
                "the Plugin may not hear it (\"needs the inventory.read or terminal.read permission\")",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 2,
        example: "roster.on(\"session_open\", function(e)\n  if e.host then roster.badges.set(e.host, \"open\") end\nend)",
    },
    Function {
        path: "roster.confirm",
        params: &[p(
            "question",
            "Confirm",
            "What to ask, the button that confirms, and what runs when the user does.",
        )],
        summary: "Asks the user to confirm, then runs a function",
        doc: "The app draws the question in its own style, with your Plugin's name on it, and only the user answers it: `run` is called when they confirm, `cancel` (if any) when they don't (`Esc` or Cancel, or another Plugin's question taking its place, which isn't a call the user started). Nothing a Plugin does can answer it or draw one of its own. Only while the user runs one of your actions, commands or finder items, so a question never comes up on its own. With `danger`, it's the stronger form for what can't be undone easily (a Mesh Cut): the confirming button is the danger colour and the keys start on Cancel, so a stray `Enter` only declines; with `typed` too, the user types that word (a Host's name) before the button works. Asking again replaces the question: the earlier one's `cancel` isn't called (your Plugin asked the new one, so it knows), and its functions are dropped.",
        returns: ("", ""),
        errors: &[
            (
                "roster.confirm: only while the user runs one of your actions, commands or finder items",
                "at load or in an event listener",
            ),
            (
                "roster.confirm: `run` must be a function: what happens when the user confirms",
                "`run` is missing or a command line",
            ),
        ],
        refused: &["a field of the wrong kind (`roster.confirm: action must be text`): nothing is asked"],
        needs: Needs::Nothing,
        since: 3,
        example: "actions = { { label = \"Cut\", key = \"x\", run = function(e)\n  roster.confirm({\n    title = \"Cut \" .. e.host .. \" from the Mesh?\",\n    text = \"Its key is taken off every Host it can reach.\",\n    action = \"Cut\",\n    danger = true,\n    typed = e.host,\n    run = function() roster.serve.call(\"mesh.cut\", { host = e.host }) end,\n  })\nend } }",
    },
    Function {
        path: "roster.cmd",
        params: &[p(
            "line",
            "string",
            "A command line, as typed after `:` (`\"finder alerts\"`).",
        )],
        summary: "Runs a command line",
        doc: "It runs after the call returns, as if the user typed it. Only while the user runs one of your actions, commands or finder items, and only your own commands and the few of roster's in [Command lines a Plugin may run](#command-lines-a-plugin-may-run), each with the permission it needs there: never `:plugins`, `:packages`, `:publish` or anything else that changes what's installed, granted or written. One of your commands it runs is the user's call carried one hop, as a [`roster.serve.request`](#rosterserverequestmethod-params-done)'s answer is: it may copy, ask or answer on the message line, but a `roster.cmd` or a request made in it (or in such an answer) doesn't carry the call further, so the command that line names runs as the app's call and can't.",
        returns: ("", ""),
        errors: &[
            (
                "roster.cmd: only while the user runs one of your actions, commands or finder items",
                "at load or in an event listener",
            ),
            ("roster.cmd: which command? …", "an empty line"),
            (
                "roster.cmd: :NAME isn't one a Plugin may run (its own commands, and …)",
                "a command not in the list, another Plugin's, or one of yours named after one of roster's",
            ),
            (
                "roster.cmd: :NAME can't run yet: the app hasn't told roster its own commands",
                "one of your commands, when the app hasn't told roster which commands are its own (the app tells it with every load, call and event, so only a host it never told says this)",
            ),
            (
                "roster.cmd: :NAME needs the P permission",
                "`:open` or `:connect` without `sessions.open`",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.commands.add(\"alerts\", { run = function(a)\n  if a.words[1] == nil then roster.cmd(\"finder alerts\") end\nend })",
    },
    Function {
        path: "roster.echo",
        params: &[
            p("text", "string", "What to say, on one line."),
            opt(
                "opts",
                "EchoOptions",
                "`{ quiet = true }` for a routine confirmation (since api 4).",
            ),
        ],
        summary: "Answers on the message line, as roster's own commands do",
        doc: "For what a command did or found: the line at the bottom of the window that roster's own commands answer on, not a notice to close. Only while the user runs one of your actions, commands or finder items, so it always answers something they did. Use [`roster.notify`](#rosternotifytext-level-opts) for anything else.\n\nIt follows `ui.messages` as roster's own messages do (like Neovim's): what went wrong (\"No Host named nope-01\") and the answer to what was asked (\"3 alerts\") always show, so a plain `roster.echo` shows. Mark a routine confirmation, when nothing went wrong (\"Added esx-02 to Lab\"), with `{ quiet = true }`: unless `ui.messages = \"all\"`, it isn't drawn, a screen reader still hears it and `:messages` keeps it.",
        returns: ("", ""),
        errors: &[
            (
                "roster.echo: only while the user runs one of your actions, commands or finder items",
                "at load, in an event listener or a timer",
            ),
            ("roster.echo: quiet is true or false", "`opts.quiet` is something else"),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.commands.add(\"alerts\", { run = function(a)\n  if a.words[1] == \"clear\" then alerts = {} roster.echo(\"Cleared the alerts\", { quiet = true })\n  elseif a.words[1] == nil then roster.echo(#alerts .. \" alerts\")\n  else roster.echo(\"alerts takes clear\") end\nend })",
    },
    Function {
        path: "roster.cmdline",
        params: &[p(
            "text",
            "string",
            "The start of a line for one of your commands (`\"folder new \"`); the user finishes it.",
        )],
        summary: "Opens the command line with text typed in",
        doc: "For a command that needs one more word from the user: it opens the command line with `text` in it and the cursor at its end, and Tab completes the rest with your command's `complete`. Nothing runs until the user presses Enter. Only your own commands, and only while the user runs one of your actions, commands or finder items.",
        returns: ("", ""),
        errors: &[
            (
                "roster.cmdline: only while the user runs one of your actions, commands or finder items",
                "at load, in an event listener or a timer",
            ),
            (
                "roster.cmdline: \"WORD\" isn't one of your commands …",
                "the line starts with anything but one of the Plugin's commands",
            ),
            (
                "roster.cmdline: :NAME can't run yet: the app hasn't told roster its own commands",
                "as `roster.cmd`'s",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.commands.add(\"note\", { run = function(a)\n  if a.args == \"\" then return roster.cmdline(\"note \") end\n  roster.storage.write(\"note.txt\", a.args)\nend })",
    },
    Function {
        path: "roster.has",
        params: &[p(
            "permission",
            "string",
            "A permission's name: `\"terminal.read\"`, `\"serve:mesh.status\"`.",
        )],
        summary: "Whether the Plugin was granted a permission",
        doc: "Ask before you use what a permission gives: listening for an event the Plugin may not hear is an error, and a module it wasn't granted is `nil`. `roster.has(\"network:api.example.com\")` asks about that one site, and a bare `roster.has(\"network\")` whether any site was granted (whether `roster.http` is there). One that can't be granted here (a serve method roster doesn't allow, a site that isn't one) is `false`, so you can ask about what a newer roster has.",
        returns: ("boolean", "`true` when it's granted (and not revoked in `:plugins`)."),
        errors: &[(
            "roster.has: \"NAME\" isn't a permission (there's …)",
            "a name that's no permission at all (a typo)",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "if roster.has(\"terminal.read\") then\n  roster.on(\"terminal_output\", function(e) end)\nelse\n  roster.notify(\"allow terminal.read in :plugins to see alerts\", \"warn\")\nend",
    },
    Function {
        path: "roster.defer",
        params: &[
            p(
                "ms",
                "number",
                "How long to wait, in milliseconds: at least 50 (less waits 50), at most 2,147,483,647.",
            ),
            p(
                "fn",
                "fun()",
                "What to run then, in the Plugin, with the budget of a call.",
            ),
        ],
        summary: "Runs a function once, later",
        doc: "The app keeps the clock and runs `fn` on the Plugin's own thread when it's time, as it runs an action, except that it isn't something the user started (so `roster.clipboard.copy` refuses). An error in it counts toward stopping the Plugin. Timers end with the Plugin: unloading, reloading or disabling it cancels every one. At most 100 timers wait at once.",
        returns: ("Timer", "Its id, for `roster.cancel`."),
        errors: &[
            (
                "roster.defer: ms must be a number of milliseconds from 0 to …",
                "a negative, infinite or huge `ms`",
            ),
            (
                "roster.defer: more than 100 timers waiting at once …",
                "too many timers",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "roster.defer(5000, function()\n  roster.status.remove(\"saved\")\nend)",
    },
    Function {
        path: "roster.every",
        params: &[
            p(
                "ms",
                "number",
                "How long between runs, in milliseconds: at least 1,000.",
            ),
            p("fn", "fun()", "What to run each time, in the Plugin."),
        ],
        summary: "Runs a function again and again, until it's cancelled",
        doc: "The first run is `ms` from now. The next wait starts when a run has finished, so a slow run never piles up behind itself. Everything else is as `roster.defer`: on the Plugin's own thread, cancelled with the Plugin.",
        returns: ("Timer", "Its id, for `roster.cancel`."),
        errors: &[
            ("roster.every: at least 1000 ms between runs …", "a shorter `ms`"),
            (
                "roster.every: ms must be a number of milliseconds from 0 to …",
                "a negative, infinite or huge `ms`",
            ),
            (
                "roster.every: more than 100 timers waiting at once …",
                "too many timers",
            ),
        ],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "-- \"2 min ago\" stays true.\nroster.every(30000, show)",
    },
    Function {
        path: "roster.cancel",
        params: &[p("timer", "Timer", "What `roster.defer` or `roster.every` returned.")],
        summary: "Cancels a timer",
        doc: "A timer that already ran (a deferred one) or was cancelled is nothing to cancel: that's not an error. A repeating timer may cancel itself from its own function.",
        returns: ("", ""),
        errors: &[(
            "roster.cancel: a timer, as roster.defer or roster.every returned it",
            "something else",
        )],
        refused: &[],
        needs: Needs::Nothing,
        since: 3,
        example: "local t = roster.every(60000, refresh)\nroster.commands.add(\"stop\", { run = function() roster.cancel(t) end })",
    },
];

/// Puts this module's functions in `roster` (runtime.rs's `api`), as the Plugin's grants allow.
pub(in crate::plugin) mod binding {
    use crate::plugin::runtime::prelude::*;

    pub(in crate::plugin) fn bind(lua: &Lua, shared: &Rc<Shared>, roster: &Table) -> mlua::Result<()> {
        // A question the app draws and the user answers (ticket 78): `run` is called only when they
        // confirm, `cancel` when they don't. Only in a call the user started, so a question never
        // comes up on its own; the Plugin can't draw one itself or answer it.
        func!(lua, shared, roster, "confirm", |lua, s, spec: Table| {
            user_only(s, "roster.confirm")?;
            let spec = data(lua, s, "roster.confirm", &Value::Table(spec), "confirm")?;
            if spec.get("run").and_then(|r| r.get("handler")).is_none() {
                return Err(mlua::Error::runtime(
                    "roster.confirm: `run` must be a function: what happens when the user confirms",
                ));
            }
            push(s, Op::Confirm { spec })
        });

        // A command line, as typed after `:` (ticket 78): the Plugin's own commands and the few of
        // roster's that plugin/api's COMMANDS lists, each only with the permission it needs there. Only
        // in a call the user started.
        func!(lua, shared, roster, "cmd", |_lua, s, line: mlua::LuaString| {
            user_only(s, "roster.cmd")?;
            let line = line.to_string_lossy();
            let line = line.trim();
            let Some(word) = line.split_whitespace().next() else {
                return Err(mlua::Error::runtime(
                    "roster.cmd: which command? (a line such as \"finder alerts\")",
                ));
            };
            if line.len() > 500 {
                return Err(mlua::Error::runtime("roster.cmd: the line is over 500 characters"));
            }
            if let Some(why) = not_yet(s, word) {
                return Err(mlua::Error::runtime(format!("roster.cmd: {why}")));
            }
            if !own_command(s, word) {
                command_allowed(word, &s.grants).map_err(|m| mlua::Error::runtime(format!("roster.cmd: {m}")))?;
            }
            // Made in a run that carries the user's call already (issue #183): the app runs the
            // Plugin's own command it names as the app's call, so a chain stops after one hop.
            let user = s.carried.get().then_some(false);
            push(
                s,
                Op::Cmd {
                    line: line.into(),
                    user,
                },
            )
        });

        // A line on the message line, as roster's own commands answer (api 3): only in a call the
        // user started, so it always answers something they did. `quiet = true` (api 4) marks a
        // routine confirmation, which follows `ui.messages` as roster's own do (ticket 118).
        func!(lua, shared, roster, "echo", |_lua,
                                            s,
                                            (text, opts): (
            mlua::LuaString,
            Option<Table>
        )| {
            user_only(s, "roster.echo")?;
            let text = text.to_string_lossy();
            let quiet = (quiet_opt(opts.as_ref(), "roster.echo")? == Some(true)).then_some(true);
            push(s, Op::Echo { text, quiet })
        });

        // Opens the command line with text typed in (api 3), for the user to finish: only the
        // Plugin's own commands, and only in a call the user started.
        func!(lua, shared, roster, "cmdline", |_lua, s, text: mlua::LuaString| {
            user_only(s, "roster.cmdline")?;
            let text = text.to_string_lossy();
            if text.len() > 500 {
                return Err(mlua::Error::runtime("roster.cmdline: the line is over 500 characters"));
            }
            let word = text.split_whitespace().next().unwrap_or("");
            if let Some(why) = not_yet(s, word) {
                return Err(mlua::Error::runtime(format!("roster.cmdline: {why}")));
            }
            if !own_command(s, word) {
                return Err(mlua::Error::runtime(format!(
                    "roster.cmdline: {word:?} isn't one of your commands (a line such as \"alerts \")"
                )));
            }
            push(s, Op::Cmdline { text })
        });

        func!(lua, shared, roster, "notify", |_lua,
                                              s,
                                              (text, level, opts): (
            mlua::LuaString,
            Option<String>,
            Option<Table>
        )| {
            let text = text.to_string_lossy();
            let level = level.unwrap_or_else(|| "info".into());
            if !matches!(level.as_str(), "info" | "warn" | "error") {
                return Err(mlua::Error::runtime(
                    "roster.notify: the level is \"info\", \"warn\" or \"error\"",
                ));
            }
            // Buttons on the notice (ticket 91): plain data, each a command line the user's click
            // runs (`view mesh-plan`), so a notice holds no function that would outlive it.
            let actions = match opts {
                Some(ref t) => {
                    let v: Value = t.raw_get("actions")?;
                    if v.is_nil() {
                        None
                    } else {
                        Some(plain(s, "roster.notify: actions", &v).map_err(|e| {
                            mlua::Error::runtime(format!(
                                "{} (a notice's action runs a command line, not a function)",
                                lua::error_text(&e)
                            ))
                        })?)
                    }
                }
                None => None,
            };
            // Whether an info notice follows `ui.messages` (api 4, ticket 117): the app decides,
            // so only what the Plugin said is passed on.
            let quiet = quiet_opt(opts.as_ref(), "roster.notify")?;
            push(
                s,
                Op::Notify {
                    text,
                    level,
                    actions: actions.filter(|a| !a.is_null()),
                    quiet,
                },
            )
        });

        // Timers: the app keeps the clock and runs the function in the Plugin when it's time.
        func!(lua, shared, roster, "defer", |lua, s, (ms, f): (f64, Function)| {
            add_timer(lua, s, "roster.defer", ms, f, false)
        });
        func!(lua, shared, roster, "every", |lua, s, (ms, f): (f64, Function)| {
            add_timer(lua, s, "roster.every", ms, f, true)
        });
        func!(lua, shared, roster, "cancel", |lua, s, id: Value| {
            let id = match id {
                Value::Integer(i) if i > 0 => i as u64,
                _ => {
                    return Err(mlua::Error::runtime(
                        "roster.cancel: a timer, as roster.defer or roster.every returned it",
                    ));
                }
            };
            if !s.timers.borrow().contains_key(&id) {
                return Ok(());
            }
            take_timer(lua, s, id)?;
            push(
                s,
                Op::Remove {
                    kind: Removable::Timer,
                    id: id.to_string(),
                },
            )
        });

        // Whether a permission was granted: one that can't be (`network`, a serve method that
        // isn't allowed) is just false, so a Plugin can ask about what a newer roster has.
        func!(lua, shared, roster, "has", |_lua, s, name: String| {
            match Permission::parse(&name) {
                Ok(p) => Ok(s.grants.contains(&p)),
                // Any site: whether `roster.http` is there.
                Err(_) if name == "network" => Ok(s.grants.iter().any(|g| matches!(g, Permission::Network(_)))),
                Err(_) if name.starts_with("serve:") || name.starts_with("network:") => Ok(false),
                Err(e) => Err(mlua::Error::runtime(format!("roster.has: {e}"))),
            }
        });

        // Events: `roster.on("session_open", function(e) … end)`.
        func!(lua, shared, roster, "on", |lua, s, (event, f): (String, Function)| {
            may_hear(&event, &s.grants).map_err(|m| mlua::Error::runtime(format!("roster.on: {m}")))?;
            let listeners: Table = lua.named_registry_value(LISTENERS)?;
            let list = match listeners.raw_get::<Option<Table>>(event.as_str())? {
                Some(l) => l,
                None => {
                    let l = lua.create_table()?;
                    listeners.raw_set(event.as_str(), l.clone())?;
                    l
                }
            };
            list.raw_push(f)
        });
        Ok(())
    }
}
