//! The Config's shape (decision Q132): every `init.lua` option path, and every name of init.lua's
//! `roster` table, declared once. Each option is an object (`terminal`), an open map (`themes`,
//! `keys.leader`), a list (`packages`) or a leaf (`terminal.size`), with its type, default,
//! allowed values, a one-line description and an example.
//!
//! Everything that describes the Config to a person or a program reads it from here: the option
//! reference (`docs/app/options.md`, `:help terminal.size`), the frontend's data for `:options`,
//! the LuaCATS stubs `:config types` writes, and the checked `roster.o` table. A drift test
//! (`tests/config_shape.rs`) checks it against the schema (`Config` deserialization and
//! `Config::default()`), against config.md's option tables, and against the `roster` table the
//! Lua runtime really builds, so none of them can go stale.
//!
//! Paths are dotted Lua names. In a pattern, `*` stands for any key of an open map
//! (`themes.*.label`) and `[]` for any item of a list (`folders[].name`).

mod render;
mod table;

pub use render::{
    COMMAND, DOC_PATH, Entry, JSON_PATH, Reference, Row, STUBS_PATH, Section, json_text, markdown, reference, stubs,
    write_types,
};

use std::sync::LazyLock;

/// Whether init.lua's Neovim-style names (`roster.o`, `roster.packages.add`,
/// `roster.folders.add`) are in this version's runtime. Their declarations are below already;
/// while this is false, the reference, the topics and the stubs leave them out and show
/// `roster.set` in examples instead of `roster.o`. Flip it with the runtime and regenerate.
pub const NEOVIM_STYLE: bool = false;

/// What sits at a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A table with fixed names (`terminal`): each child is declared.
    Object,
    /// A table keyed by names the user picks (`themes`, `keys.leader`): its one child is `P.*`.
    Map,
    /// A list (`packages`, `terminal.font`). A list of tables has its item declared as `P[]`.
    List,
    /// A value.
    Leaf,
}

impl Kind {
    /// What `roster.o` lets init.lua do with a value of this kind, besides assigning it: a map's
    /// keys, a list's items, any value's reset to its default. The reference lists them once the
    /// Neovim-style names are in.
    pub fn methods(self) -> &'static [&'static str] {
        match self {
            Kind::Object => &["get", "set", "reset"],
            Kind::Map => &["get", "set", "remove", "has", "keys", "reset"],
            Kind::List => &["append", "prepend", "insert", "remove", "has", "clear", "reset"],
            Kind::Leaf => &["get", "set", "reset"],
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Object => "object",
            Kind::Map => "map",
            Kind::List => "list",
            Kind::Leaf => "leaf",
        }
    }
}

/// The values a leaf may have, beyond its type.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Allowed {
    /// Anything of its type.
    Any,
    /// One of these, written in Lua (`"webgl"`, `false`).
    OneOf(&'static [&'static str]),
    /// A number from `min` to `max`, both included. `unit` is shown after them.
    Range { min: f64, max: f64, unit: &'static str },
    /// Text in a form a sentence describes (`a chord such as "Ctrl+Space"`).
    Form(&'static str),
}

impl Allowed {
    /// One line for a person: `"webgl" or "dom"`, `6 to 72 px`.
    pub fn text(&self) -> String {
        match self {
            Allowed::Any => String::new(),
            Allowed::OneOf(values) => match values {
                [] => String::new(),
                [one] => (*one).to_string(),
                [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
            },
            Allowed::Range { min, max, unit } => {
                let n = |v: f64| {
                    if v.fract() == 0.0 {
                        format!("{}", v as i64)
                    } else {
                        format!("{v}")
                    }
                };
                format!(
                    "{} to {}{}{unit}",
                    n(*min),
                    n(*max),
                    if unit.is_empty() { "" } else { " " }
                )
            }
            Allowed::Form(text) => (*text).to_string(),
        }
    }
}

/// One option path.
#[derive(Debug, Clone, PartialEq)]
pub struct Opt {
    /// The path pattern: `terminal.size`, `themes.*.label`, `folders[].name`.
    pub path: String,
    pub kind: Kind,
    /// Its type as LuaCATS writes it: `number|string`, `"webgl"|"dom"`, `roster.config.Theme`.
    pub ty: String,
    /// The default, written in Lua (`"13pt"`, `true`, `{}`), or `unset` (nothing, and the app or
    /// a State choice decides) or `required` (a list item's field it can't do without).
    pub default: String,
    pub allowed: Allowed,
    /// One line: what it does.
    pub about: String,
    /// A value it could have, in Lua. Empty for an object (its children have theirs).
    pub example: String,
    /// config.md's `###` section it's documented under ("Fonts and the terminal").
    pub section: &'static str,
    /// The LuaCATS class (an object) or alias (a map's leaf item) its value is, when it has a name
    /// of its own: `roster.config.Theme`. Several paths can share one (`colors` and
    /// `themes.*.colors`).
    pub class: Option<&'static str>,
    /// One of many names of the same kind (a colour token): listed in its parent's entry instead
    /// of having one of its own.
    pub brief: bool,
}

impl Opt {
    /// The path's segments, a list's `[]` as a segment of its own: `folders[].name` →
    /// `folders`, `[]`, `name`.
    pub fn segments(&self) -> Vec<&str> {
        segments(&self.path)
    }

    pub fn is_leaf(&self) -> bool {
        self.kind == Kind::Leaf
    }

    /// Under a map's key or a list's item: a field of a Theme, a Folder, a key binding.
    pub fn in_item(&self) -> bool {
        self.segments().iter().any(|s| *s == "*" || *s == "[]")
    }

    /// The map key or list item itself (`themes.*`, `folders[]`).
    pub fn is_item(&self) -> bool {
        matches!(self.segments().last(), Some(&"*") | Some(&"[]"))
    }

    /// It has an entry of its own in the reference, and so a help topic: every option outside a
    /// map's or list's items (but a colour token), and each named item type once (the
    /// `roster.config.Theme` entry).
    pub fn is_entry(&self) -> bool {
        if self.brief {
            return false;
        }
        if self.is_item() {
            let class = self.class;
            return class.is_some()
                && options()
                    .iter()
                    .find(|o| o.is_item() && o.class == class)
                    .map(|o| &o.path)
                    == Some(&self.path);
        }
        !self.in_item()
    }

    /// How init.lua writes it: `roster.o.terminal.size` (or the dotted name, while the
    /// Neovim-style names aren't in the runtime).
    pub fn lua_name(&self) -> String {
        if NEOVIM_STYLE {
            format!("roster.o.{}", self.path)
        } else {
            self.path.clone()
        }
    }
}

fn segments(path: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for s in path.split('.') {
        match s.strip_suffix("[]") {
            Some(name) => {
                out.push(name);
                out.push("[]");
            }
            None => out.push(s),
        }
    }
    out
}

/// Every option path, parents before children, in the reference's order.
pub fn options() -> &'static [Opt] {
    static OPTIONS: LazyLock<Vec<Opt>> = LazyLock::new(table::options);
    &OPTIONS
}

/// The option at a concrete path (`["themes", "paper", "label"]`, `["folders", "1", "name"]`):
/// a map's key matches its `*`, a list's index (from 1) its `[]`. None for a name the Config
/// doesn't have.
pub fn lookup(path: &[&str]) -> Option<&'static Opt> {
    options().iter().find(|o| {
        let segs = o.segments();
        segs.len() == path.len()
            && segs.iter().zip(path).all(|(pattern, name)| match *pattern {
                "*" => !name.is_empty(),
                "[]" => name.parse::<u32>().is_ok_and(|i| i >= 1),
                fixed => fixed == *name,
            })
    })
}

/// The option at a dotted pattern exactly as declared (`themes.*.label`).
pub fn get(pattern: &str) -> Option<&'static Opt> {
    options().iter().find(|o| o.path == pattern)
}

/// The options one level under `opt`: an object's fields, a map's `*`, a list's `[]`.
pub fn children(opt: &Opt) -> impl Iterator<Item = &'static Opt> + '_ {
    let depth = opt.segments().len();
    let prefix = opt.segments();
    options().iter().filter(move |o| {
        let s = o.segments();
        s.len() == depth + 1 && s[..depth] == prefix[..]
    })
}

/// For a name that isn't there, the one meant: `suggest(&["terminal"], "szie")` is
/// `terminal.size`. Looks at the fixed names under `parent` (the top level when it's empty)
/// within two edits, closest first. None when nothing is that close.
pub fn suggest(parent: &[&str], name: &str) -> Option<String> {
    let names: Vec<&'static Opt> = if parent.is_empty() {
        options().iter().filter(|o| o.segments().len() == 1).collect()
    } else {
        children(lookup(parent)?).collect()
    };
    names
        .into_iter()
        .filter(|o| !o.is_item())
        .map(|o| (distance(o.segments().last().copied().unwrap_or_default(), name), o))
        .filter(|(d, _)| *d <= 2)
        .min_by_key(|(d, _)| *d)
        .map(|(_, o)| o.path.clone())
}

/// Levenshtein distance, ignoring case.
fn distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.to_lowercase().chars().collect();
    let b: Vec<char> = b.to_lowercase().chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let here = row[j + 1];
            row[j + 1] = (prev + usize::from(ca != cb)).min(row[j] + 1).min(row[j + 1] + 1);
            prev = here;
        }
    }
    row[b.len()]
}

// ---------------------------------------------------------------- the `roster` table

/// A name in init.lua's `roster` table (config/lua.rs `roster_api`). A Plugin's `roster` is
/// another table, declared in plugin/api.rs.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiItem {
    /// `roster.keymap.set`.
    pub path: &'static str,
    /// None for a value.
    pub params: Option<&'static [Param]>,
    /// A value's type (`"windows"|"linux"|"macos"`); a function's return type, or empty.
    pub ty: &'static str,
    /// One line: what it is or does.
    pub about: &'static str,
    /// More, when one line doesn't say what it expects.
    pub more: &'static str,
    /// Lua that uses it.
    pub example: &'static str,
    /// It comes with the Neovim-style names ([`NEOVIM_STYLE`]).
    pub neovim_style: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Param {
    pub name: &'static str,
    pub ty: &'static str,
    pub about: &'static str,
}

impl ApiItem {
    /// `roster.keymap.set(context, keys, action)`, or the path of a value.
    pub fn signature(&self) -> String {
        match self.params {
            Some(params) => {
                let names: Vec<&str> = params.iter().map(|p| p.name).collect();
                format!("{}({})", self.path, names.join(", "))
            }
            None => self.path.to_string(),
        }
    }

    pub fn is_function(&self) -> bool {
        self.params.is_some()
    }
}

/// Every name of init.lua's `roster` table, those this version has (see [`NEOVIM_STYLE`]).
pub fn api() -> impl Iterator<Item = &'static ApiItem> {
    api_all().iter().filter(|a| NEOVIM_STYLE || !a.neovim_style)
}

/// Every name, with the Neovim-style ones this version may not have yet.
pub fn api_all() -> &'static [ApiItem] {
    table::API
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_concrete_path_finds_its_pattern() {
        assert_eq!(
            lookup(&["terminal", "size"]).map(|o| o.path.as_str()),
            Some("terminal.size")
        );
        assert_eq!(
            lookup(&["themes", "paper", "label"]).map(|o| o.path.as_str()),
            Some("themes.*.label")
        );
        assert_eq!(
            lookup(&["folders", "2", "name"]).map(|o| o.path.as_str()),
            Some("folders[].name")
        );
        assert_eq!(
            lookup(&["keys", "leader", "d d"]).map(|o| o.path.as_str()),
            Some("keys.leader.*")
        );
        assert_eq!(lookup(&["terminal", "szie"]), None);
        assert_eq!(lookup(&["folders", "x", "name"]), None);
        assert_eq!(lookup(&["folders", "0", "name"]), None);
    }

    #[test]
    fn kinds_say_how_each_path_nests() {
        let kind = |p: &[&str]| lookup(p).map(|o| o.kind);
        assert_eq!(kind(&["terminal"]), Some(Kind::Object));
        assert_eq!(kind(&["themes"]), Some(Kind::Map));
        assert_eq!(kind(&["keys", "leader"]), Some(Kind::Map));
        assert_eq!(kind(&["packages"]), Some(Kind::List));
        assert_eq!(kind(&["terminal", "font"]), Some(Kind::List));
        assert_eq!(kind(&["terminal", "size"]), Some(Kind::Leaf));
        assert_eq!(kind(&["themes", "x"]), Some(Kind::Object));
    }

    #[test]
    fn children_are_one_level_down() {
        let terminal = get("terminal").unwrap();
        let names: Vec<&str> = children(terminal).map(|o| o.path.as_str()).collect();
        assert!(names.contains(&"terminal.size") && names.contains(&"terminal.colors"));
        assert!(!names.contains(&"terminal.colors.background"));
        let themes: Vec<&str> = children(get("themes").unwrap()).map(|o| o.path.as_str()).collect();
        assert_eq!(themes, ["themes.*"]);
    }

    #[test]
    fn a_typo_gets_the_name_meant() {
        assert_eq!(suggest(&["terminal"], "szie").as_deref(), Some("terminal.size"));
        assert_eq!(suggest(&[], "thmee").as_deref(), Some("theme"));
        assert_eq!(
            suggest(&["modes", "focus"], "sidebr").as_deref(),
            Some("modes.focus.sidebar")
        );
        assert_eq!(suggest(&["terminal"], "completely_else"), None);
    }

    #[test]
    fn paths_are_unique_and_parents_come_first() {
        let mut seen = std::collections::HashSet::new();
        for o in options() {
            assert!(seen.insert(o.path.clone()), "{} twice", o.path);
            let segs = o.segments();
            if segs.len() > 1 {
                let parent = &segs[..segs.len() - 1];
                assert!(
                    options()
                        .iter()
                        .any(|p| p.segments() == parent && seen.contains(&p.path)),
                    "{}'s parent isn't declared before it",
                    o.path
                );
            }
        }
    }

    #[test]
    fn allowed_values_read_as_a_sentence() {
        assert_eq!(
            Allowed::OneOf(&["\"a\"", "\"b\"", "\"c\""]).text(),
            "\"a\", \"b\" or \"c\""
        );
        assert_eq!(
            Allowed::Range {
                min: 0.5,
                max: 3.0,
                unit: ""
            }
            .text(),
            "0.5 to 3"
        );
        assert_eq!(
            Allowed::Range {
                min: 10.0,
                max: 95.0,
                unit: "percent"
            }
            .text(),
            "10 to 95 percent"
        );
    }
}
