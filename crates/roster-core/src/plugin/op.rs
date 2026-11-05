//! The UI changes a Plugin asks for (docs/plugins.md, "Ops"): one per `roster.*` call that
//! changes what the app shows, in a [`super::Reply`]'s `ops` as `{ "op": KIND, … }`. A spec is the
//! Plugin's own data as it gave it (a Lua function in it is `{ "handler": N }`); the app checks it
//! before drawing anything (app/src/plugins/ops.ts), as it comes from third-party code.

use serde::Serialize;
use serde_json::Value as Json;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// `roster.commands.add`: `run` a function or a command line; `complete` a function.
    Command {
        name: String,
        desc: String,
        run: Json,
        #[serde(skip_serializing_if = "Option::is_none")]
        complete: Option<Json>,
    },
    /// `roster.keymap.set` (a command line) and `del` (`false`).
    Key {
        context: String,
        keys: String,
        action: Json,
    },
    Theme {
        id: String,
        theme: Json,
    },
    Section {
        id: String,
        spec: Json,
    },
    Status {
        id: String,
        spec: Json,
    },
    Finder {
        id: String,
        spec: Json,
    },
    Help {
        id: String,
        spec: Json,
    },
    Health {
        id: String,
        spec: Json,
    },
    Tutor {
        id: String,
        spec: Json,
    },
    Toolbar {
        id: String,
        spec: Json,
    },
    Progress {
        id: String,
        spec: Json,
    },
    /// `roster.health.answer` (decision Q112h): a `:check` run's lines, later.
    HealthAnswer {
        check: u64,
        checks: Json,
    },
    /// `text` null takes the badge off.
    Badge {
        host: String,
        text: Option<String>,
    },
    /// `spec` null closes it.
    Float {
        spec: Json,
    },
    View {
        id: String,
        spec: Json,
    },
    ViewUpdate {
        id: String,
        changes: Json,
    },
    ViewOpen {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        select: Option<String>,
    },
    ViewClose {
        id: String,
    },
    /// `spec` null takes the section off that Host.
    Details {
        id: String,
        host: String,
        spec: Json,
    },
    Copy {
        text: String,
    },
    Confirm {
        spec: Json,
    },
    /// `user: false`: made in a run that carried the user's call already (issue #183).
    Cmd {
        line: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        user: Option<bool>,
    },
    Echo {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        quiet: Option<bool>,
    },
    Cmdline {
        text: String,
    },
    Notify {
        text: String,
        level: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        actions: Option<Json>,
        #[serde(skip_serializing_if = "Option::is_none")]
        quiet: Option<bool>,
    },
    SessionShow {
        session: u64,
        line: Option<String>,
    },
    Open {
        host: String,
    },
    Send {
        session: u64,
        text: String,
    },
    /// Run `run` after `ms`, again every `ms` when `every`: the app keeps the clock.
    Timer {
        id: String,
        ms: u64,
        every: bool,
        run: Json,
    },
    Remove {
        kind: Removable,
        id: String,
    },
}

/// What a `remove` op takes away.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Removable {
    Command,
    Theme,
    Section,
    Status,
    Finder,
    Help,
    Health,
    Tutor,
    View,
    Details,
    Timer,
    Toolbar,
    Progress,
}

impl Removable {
    pub const ALL: &[Removable] = &[
        Removable::Command,
        Removable::Theme,
        Removable::Section,
        Removable::Status,
        Removable::Finder,
        Removable::Help,
        Removable::Health,
        Removable::Tutor,
        Removable::View,
        Removable::Details,
        Removable::Timer,
        Removable::Toolbar,
        Removable::Progress,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Removable::Command => "command",
            Removable::Theme => "theme",
            Removable::Section => "section",
            Removable::Status => "status",
            Removable::Finder => "finder",
            Removable::Help => "help",
            Removable::Health => "health",
            Removable::Tutor => "tutor",
            Removable::View => "view",
            Removable::Details => "details",
            Removable::Timer => "timer",
            Removable::Toolbar => "toolbar",
            Removable::Progress => "progress",
        }
    }
}

/// The UI pieces a `roster.MODULE.set(id, spec)` puts up, by their op's kind.
pub(crate) fn set(kind: Removable, id: String, spec: Json) -> Op {
    match kind {
        Removable::Section => Op::Section { id, spec },
        Removable::Status => Op::Status { id, spec },
        Removable::Finder => Op::Finder { id, spec },
        Removable::Help => Op::Help { id, spec },
        Removable::Health => Op::Health { id, spec },
        Removable::Tutor => Op::Tutor { id, spec },
        Removable::Toolbar => Op::Toolbar { id, spec },
        Removable::Progress => Op::Progress { id, spec },
        other => unreachable!("{other:?} isn't set with a spec"),
    }
}

/// Every op's kind and its fields (`?` after an optional one), in [`Op`]'s order: the wire format
/// the app parses, in plugin-api.json's `runtime.ops`.
pub const KINDS: &[(&str, &[&str])] = &[
    ("command", &["name", "desc", "run", "complete?"]),
    ("key", &["context", "keys", "action"]),
    ("theme", &["id", "theme"]),
    ("section", &["id", "spec"]),
    ("status", &["id", "spec"]),
    ("finder", &["id", "spec"]),
    ("help", &["id", "spec"]),
    ("health", &["id", "spec"]),
    ("tutor", &["id", "spec"]),
    ("toolbar", &["id", "spec"]),
    ("progress", &["id", "spec"]),
    ("health_answer", &["check", "checks"]),
    ("badge", &["host", "text"]),
    ("float", &["spec"]),
    ("view", &["id", "spec"]),
    ("view_update", &["id", "changes"]),
    ("view_open", &["id", "select?"]),
    ("view_close", &["id"]),
    ("details", &["id", "host", "spec"]),
    ("copy", &["text"]),
    ("confirm", &["spec"]),
    ("cmd", &["line", "user?"]),
    ("echo", &["text", "quiet?"]),
    ("cmdline", &["text"]),
    ("notify", &["text", "level", "actions?", "quiet?"]),
    ("session_show", &["session", "line"]),
    ("open", &["host"]),
    ("send", &["session", "text"]),
    ("timer", &["id", "ms", "every", "run"]),
    ("remove", &["kind", "id"]),
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One of each, with every optional field: what [`KINDS`] says of each must be what it sends.
    fn every() -> Vec<Op> {
        let (j, s) = (|| json!({}), || String::from("x"));
        let mut ops = vec![
            Op::Command {
                name: s(),
                desc: s(),
                run: j(),
                complete: Some(j()),
            },
            Op::Key {
                context: s(),
                keys: s(),
                action: j(),
            },
            Op::Theme { id: s(), theme: j() },
        ];
        ops.extend(
            [
                Removable::Section,
                Removable::Status,
                Removable::Finder,
                Removable::Help,
                Removable::Health,
                Removable::Tutor,
                Removable::Toolbar,
                Removable::Progress,
            ]
            .map(|k| set(k, s(), j())),
        );
        ops.extend([
            Op::HealthAnswer { check: 1, checks: j() },
            Op::Badge { host: s(), text: None },
            Op::Float { spec: j() },
            Op::View { id: s(), spec: j() },
            Op::ViewUpdate { id: s(), changes: j() },
            Op::ViewOpen {
                id: s(),
                select: Some(s()),
            },
            Op::ViewClose { id: s() },
            Op::Details {
                id: s(),
                host: s(),
                spec: j(),
            },
            Op::Copy { text: s() },
            Op::Confirm { spec: j() },
            Op::Cmd {
                line: s(),
                user: Some(false),
            },
            Op::Echo {
                text: s(),
                quiet: Some(true),
            },
            Op::Cmdline { text: s() },
            Op::Notify {
                text: s(),
                level: s(),
                actions: Some(j()),
                quiet: Some(true),
            },
            Op::SessionShow { session: 1, line: None },
            Op::Open { host: s() },
            Op::Send { session: 1, text: s() },
            Op::Timer {
                id: s(),
                ms: 1,
                every: true,
                run: j(),
            },
            Op::Remove {
                kind: Removable::View,
                id: s(),
            },
        ]);
        ops
    }

    #[test]
    fn the_kinds_table_is_what_each_op_sends() {
        let sent: Vec<(String, Vec<String>)> = every()
            .iter()
            .map(|op| {
                let Json::Object(mut m) = serde_json::to_value(op).unwrap() else {
                    panic!()
                };
                let kind = m.remove("op").unwrap().as_str().unwrap().to_string();
                let mut keys: Vec<String> = m.keys().cloned().collect();
                keys.sort();
                (kind, keys)
            })
            .collect();
        let table: Vec<(String, Vec<String>)> = KINDS
            .iter()
            .map(|(k, fields)| {
                let mut keys: Vec<String> = fields.iter().map(|f| f.trim_end_matches('?').to_string()).collect();
                keys.sort();
                (k.to_string(), keys)
            })
            .collect();
        assert_eq!(sent, table);
    }

    #[test]
    fn a_removable_is_named_as_it_is_sent() {
        for r in Removable::ALL {
            assert_eq!(json!(r), json!(r.name()));
        }
    }
}
