//! The one store init.lua's calls write to (decision Q132, ticket 142): `roster.o`, `roster.set`,
//! `roster.keymap`, `roster.themes`, `roster.packages` and `roster.folders` all land here. The
//! store holds what the writes so far add up to (the last write at a path wins, ticket 139), and
//! a log of where each write was made, in order, so the loader can give every value its line and
//! lay the whole under the table init.lua returns, which still wins value by value.
//!
//! The log keeps paths and lines, never values: a list changed in place five thousand times
//! (`roster.folders.add_hosts`) costs one entry each, not a copy of the list each.
//!
//! The named lists (`folders`, `packages`) also keep, for each item, its name as compared and the
//! line that added it, so a second item with the same name is an error naming both lines.

use super::schema::Location;
use serde_json::{Map, Value as Json};

/// One write: the schema path it changed (`keys.leader.x`), whether it took the value away
/// (`roster.o.views.x = nil`, `reset`), and where it was made.
#[derive(Debug, Clone)]
pub(crate) struct Write {
    pub path: Vec<String>,
    pub removed: bool,
    pub at: Option<Location>,
}

/// A named list's items: each one's name as compared (lower case) and the line that added it, in
/// list order.
pub(crate) type Names = Vec<(String, Option<Location>)>;

#[derive(Debug)]
pub(crate) struct Store {
    log: Vec<Write>,
    tree: Json,
    named: Vec<(&'static str, Names)>,
}

impl Default for Store {
    fn default() -> Self {
        Store {
            log: Vec::new(),
            tree: Json::Object(Map::new()),
            named: Vec::new(),
        }
    }
}

impl Store {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets `path` to `value`, replacing what earlier writes put there or under it.
    pub fn set(&mut self, path: &[String], value: Json, at: Option<Location>) {
        set_replacing(&mut self.tree, path, value);
        self.touched(path, at);
    }

    /// Takes away what earlier writes put at `path`: the option is back to its default (or to
    /// what the returned table gives it).
    pub fn remove(&mut self, path: &[String], at: Option<Location>) {
        remove(&mut self.tree, path);
        self.log.push(Write {
            path: path.to_vec(),
            removed: true,
            at,
        });
    }

    /// Records a write made in place, through [`Store::list_mut`].
    pub fn touched(&mut self, path: &[String], at: Option<Location>) {
        self.log.push(Write {
            path: path.to_vec(),
            removed: false,
            at,
        });
    }

    /// What the writes so far put at `path`, if anything.
    pub fn get(&self, path: &[String]) -> Option<&Json> {
        let mut node = &self.tree;
        for key in path {
            node = node.as_object()?.get(key)?;
        }
        Some(node)
    }

    /// The list at `path`, made one (empty) when it isn't, to change in place; then
    /// [`Store::touched`].
    pub fn list_mut(&mut self, path: &[String]) -> &mut Vec<Json> {
        let is_list = matches!(self.get(path), Some(Json::Array(_)));
        if !is_list {
            set_replacing(&mut self.tree, path, Json::Array(Vec::new()));
        }
        let mut node = &mut self.tree;
        for key in path {
            node = node.as_object_mut().and_then(|m| m.get_mut(key)).expect("just made");
        }
        match node {
            Json::Array(items) => items,
            _ => unreachable!("just made a list"),
        }
    }

    /// Where what's at `path` was last changed: the latest write at it, above it or under it.
    pub fn last_at(&self, path: &[String]) -> Option<Location> {
        self.log
            .iter()
            .rev()
            .find(|w| path.starts_with(&w.path) || w.path.starts_with(path))
            .and_then(|w| w.at.clone())
    }

    /// The named list `list`'s items' names and lines.
    pub fn named(&self, list: &str) -> &[(String, Option<Location>)] {
        self.named
            .iter()
            .find(|(l, _)| *l == list)
            .map(|(_, n)| n.as_slice())
            .unwrap_or_default()
    }

    /// The named list `list`'s names, to change with its items.
    pub fn named_mut(&mut self, list: &'static str) -> &mut Names {
        let i = match self.named.iter().position(|(l, _)| *l == list) {
            Some(i) => i,
            None => {
                self.named.push((list, Vec::new()));
                self.named.len() - 1
            }
        };
        &mut self.named[i].1
    }

    /// What the writes add up to, and where each was made, in order.
    pub fn into_parts(self) -> (Json, Vec<Write>) {
        (self.tree, self.log)
    }
}

/// Sets `path` to `value`, replacing what's there (and anything in the way that isn't a table).
pub(crate) fn set_replacing(root: &mut Json, path: &[String], value: Json) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut node = root;
    for key in parents {
        let Json::Object(map) = node else { return };
        let child = map.entry(key.clone()).or_insert_with(|| Json::Object(Map::new()));
        if !child.is_object() {
            *child = Json::Object(Map::new());
        }
        node = child;
    }
    if let Json::Object(map) = node {
        map.insert(last.clone(), value);
    }
}

/// Takes `path` out of `root`, if it's there.
pub(crate) fn remove(root: &mut Json, path: &[String]) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut node = root;
    for key in parents {
        match node.as_object_mut().and_then(|m| m.get_mut(key)) {
            Some(child) => node = child,
            None => return,
        }
    }
    if let Some(map) = node.as_object_mut() {
        map.remove(last);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(s: &str) -> Vec<String> {
        s.split('.').map(str::to_string).collect()
    }

    fn at(line: u32) -> Option<Location> {
        Some(Location {
            file: "init.lua".into(),
            line,
        })
    }

    #[test]
    fn the_last_write_wins_and_reads_back() {
        let mut s = Store::new();
        s.set(&p("terminal.size"), json!("13pt"), at(1));
        s.set(&p("terminal"), json!({ "font": "Hack" }), at(2));
        assert_eq!(s.get(&p("terminal.size")), None);
        s.set(&p("terminal.size"), json!("16pt"), at(3));
        assert_eq!(
            s.get(&[]).unwrap(),
            &json!({ "terminal": { "font": "Hack", "size": "16pt" } })
        );
        s.remove(&p("terminal.font"), at(4));
        assert_eq!(s.get(&p("terminal")), Some(&json!({ "size": "16pt" })));
        // The latest write at, above or under a path.
        assert_eq!(s.last_at(&p("terminal")).map(|a| a.line), Some(4));
        assert_eq!(s.last_at(&p("terminal.size")).map(|a| a.line), Some(3));
        s.list_mut(&p("folders")).push(json!({ "name": "Lab" }));
        s.touched(&p("folders"), at(5));
        assert_eq!(s.get(&p("folders")), Some(&json!([{ "name": "Lab" }])));
        let (_, log) = s.into_parts();
        assert_eq!(log.len(), 5);
        assert!(log[3].removed);
    }
}
