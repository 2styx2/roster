//! The one store init.lua's calls write to (decision Q132, ticket 142): `roster.o`, `roster.set`,
//! `roster.keymap`, `roster.themes`, `roster.packages` and `roster.folders` all land here. Each
//! write is kept with where it was made, in order, and the last write at a path wins (ticket
//! 139); what has been written so far can be read back. The loader lays the result under the
//! table init.lua returns, which still wins value by value.
//!
//! The named lists (`folders`, `packages`) also keep, for each item, the line that added it, so a
//! second item with the same name is an error naming both lines.

use super::schema::Location;
use serde_json::{Map, Value as Json};

/// One write, by schema path (`keys.leader.x`), with where it was made. `None` removes what
/// earlier writes put there.
#[derive(Debug, Clone)]
pub(crate) struct ApiEntry {
    pub path: Vec<String>,
    pub value: Option<Json>,
    pub at: Option<Location>,
}

/// An item of a named list, by its name as compared (lower case), with where it was added.
#[derive(Debug, Clone)]
struct Named {
    key: String,
    at: Option<Location>,
}

#[derive(Debug, Default)]
pub(crate) struct Store {
    log: Vec<ApiEntry>,
    /// What the writes so far add up to.
    tree: Json,
    /// For `folders` and `packages`: their items' names and lines, in list order.
    named: Vec<(String, Vec<Named>)>,
}

impl Store {
    pub fn new() -> Self {
        Store {
            log: Vec::new(),
            tree: Json::Object(Map::new()),
            named: Vec::new(),
        }
    }

    /// Sets `path` to `value`, replacing what earlier writes put there or under it.
    pub fn set(&mut self, path: &[String], value: Json, at: Option<Location>) {
        set_replacing(&mut self.tree, path, value.clone());
        self.log.push(ApiEntry {
            path: path.to_vec(),
            value: Some(value),
            at,
        });
    }

    /// Takes away what earlier writes put at `path`: the option is back to its default (or to
    /// what the returned table gives it).
    pub fn remove(&mut self, path: &[String], at: Option<Location>) {
        remove(&mut self.tree, path);
        self.log.push(ApiEntry {
            path: path.to_vec(),
            value: None,
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

    /// Where what's at `path` now came from: the last write at it or above it, if that set it.
    pub fn last_at(&self, path: &[String]) -> Option<Location> {
        self.log
            .iter()
            .rev()
            .find(|e| path.starts_with(&e.path))
            .filter(|e| e.value.is_some())
            .and_then(|e| e.at.clone())
    }

    /// The named list `list`'s items' names and lines, in order, as [`Store::set_named`] left them.
    pub fn named(&self, list: &str) -> Vec<(String, Option<Location>)> {
        self.named
            .iter()
            .find(|(l, _)| l == list)
            .map(|(_, items)| items.iter().map(|n| (n.key.clone(), n.at.clone())).collect())
            .unwrap_or_default()
    }

    /// Records the named list `list`'s items' names, in order, with where each was added.
    pub fn set_named(&mut self, list: &str, items: Vec<(String, Option<Location>)>) {
        let items = items.into_iter().map(|(key, at)| Named { key, at }).collect();
        match self.named.iter_mut().find(|(l, _)| l == list) {
            Some((_, old)) => *old = items,
            None => self.named.push((list.to_string(), items)),
        }
    }

    /// The writes, in order, for the loader.
    pub fn into_entries(self) -> Vec<ApiEntry> {
        self.log
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

    #[test]
    fn the_last_write_wins_and_reads_back() {
        let mut s = Store::new();
        s.set(&p("terminal.size"), json!("13pt"), None);
        s.set(&p("terminal"), json!({ "font": "Hack" }), None);
        assert_eq!(s.get(&p("terminal.size")), None);
        s.set(&p("terminal.size"), json!("16pt"), None);
        assert_eq!(
            s.get(&[]).unwrap(),
            &json!({ "terminal": { "font": "Hack", "size": "16pt" } })
        );
        s.remove(&p("terminal.font"), None);
        assert_eq!(s.get(&p("terminal")), Some(&json!({ "size": "16pt" })));
        assert_eq!(s.into_entries().len(), 4);
    }
}
