//! Finding the line of a value in `init.lua` from its schema path, for errors and warnings. Lua
//! keeps no line numbers for table fields, so this reads the source: each path segment is looked
//! for as a key (`size =`, `["d d"] =`, `t.size =`) after the previous one. It's a best effort:
//! a value built by code (a loop, a computed key) gets no line, never a parent key's (ticket 140).

/// The 1-based line where `path` is set, when every name in it is found in `source` as a key.
pub(crate) fn line_of(source: &str, path: &[String]) -> Option<u32> {
    let mut pos = 0;
    let mut line = None;
    for seg in path {
        if seg.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let at = find_key(source, seg, pos)?;
        pos = at + seg.len();
        line = Some(line_at(source, at));
    }
    line
}

/// The line of the first `text` outside a comment.
pub(crate) fn line_of_text(source: &str, text: &str) -> Option<u32> {
    let mut from = 0;
    while let Some(i) = source[from..].find(text) {
        let at = from + i;
        if !in_comment(source, at) {
            return Some(line_at(source, at));
        }
        from = at + text.len();
    }
    None
}

fn find_key(source: &str, key: &str, from: usize) -> Option<usize> {
    let ident = key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !key.is_empty();
    let mut best: Option<usize> = None;
    let mut consider = |at: usize| best = Some(best.map_or(at, |b: usize| b.min(at)));
    for quoted in [format!("[\"{key}\"]"), format!("['{key}']")] {
        let mut start = from;
        while let Some(i) = source[start..].find(&quoted) {
            let at = start + i;
            if assigns(&source[at + quoted.len()..]) && !in_comment(source, at) {
                consider(at + 2);
                break;
            }
            start = at + quoted.len();
        }
    }
    if ident {
        let mut start = from;
        while let Some(i) = source[start..].find(key) {
            let at = start + i;
            let before = source[..at].chars().next_back();
            let boundary = before.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
            if boundary && assigns(&source[at + key.len()..]) && !in_comment(source, at) {
                consider(at);
                break;
            }
            start = at + key.len();
        }
    }
    best
}

/// `rest` starts with `=` (not `==`), after spaces.
fn assigns(rest: &str) -> bool {
    let r = rest.trim_start_matches([' ', '\t']);
    r.starts_with('=') && !r.starts_with("==")
}

fn in_comment(source: &str, at: usize) -> bool {
    let line_start = source[..at].rfind('\n').map_or(0, |i| i + 1);
    source[line_start..at].contains("--")
}

fn line_at(source: &str, at: usize) -> u32 {
    (source[..at].matches('\n').count() + 1) as u32
}

/// The line, at `line` or at most 200 lines above it, where `key` is last assigned (`key =`,
/// `["key"] =`): where a statement Lua reports at its last line (a table over several lines)
/// sets `key`, or where a name inside that table is.
pub(crate) fn key_line_before(source: &str, key: &str, line: u32) -> Option<u32> {
    let lines: Vec<&str> = source.lines().take(line as usize).collect();
    let first = lines.len().saturating_sub(201);
    (first..lines.len())
        .rev()
        .find(|&i| find_key(lines[i], key, 0).is_some())
        .map(|i| i as u32 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_found_at_or_above_a_line() {
        let src = "roster.o.fonts = {\n  ui = \"Inter\",\n  szie = 1,\n}\nroster.o.vim = false\n";
        assert_eq!(key_line_before(src, "fonts", 4), Some(1));
        assert_eq!(key_line_before(src, "szie", 4), Some(3));
        assert_eq!(key_line_before(src, "vim", 4), None);
        assert_eq!(key_line_before(src, "vim", 5), Some(5));
    }
}
