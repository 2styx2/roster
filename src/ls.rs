//! `roster ls`: one line per Host, or one JSON document with `--json`.

use crate::inventory::Host;

/// `{"v": 1, "hosts": [...]}`. Fields are only ever added within `v`, and
/// never a vault reference: `auth` is left out.
pub fn json(hosts: &[Host]) -> String {
    let hosts: Vec<_> = hosts
        .iter()
        .map(|h| {
            serde_json::json!({
                "name": h.name, "group": h.group, "ip": h.ip, "user": h.user,
                "port": h.port, "access": h.access(), "title": h.title,
            })
        })
        .collect();
    serde_json::json!({ "v": 1, "hosts": hosts }).to_string() + "\n"
}

/// Columns: name, group, address, access, title; padded, two spaces apart.
pub fn text(hosts: &[Host]) -> String {
    let rows: Vec<[&str; 5]> = hosts
        .iter()
        .map(|h| [&*h.name, &*h.group, &*h.ip, h.access(), &*h.title])
        .collect();
    let mut width = [0; 5];
    for row in &rows {
        for (w, cell) in width.iter_mut().zip(row) {
            *w = (*w).max(cell.chars().count());
        }
    }
    let mut out = String::new();
    for row in &rows {
        let mut line = String::new();
        for (cell, w) in row.iter().zip(width) {
            line.push_str(&format!("{cell:w$}  "));
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}
