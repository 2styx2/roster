//! Finding the line of a value in `init.lua` from its schema path, for errors and warnings. Lua
//! keeps no line numbers for table fields, so this reads the source: each path segment is looked
//! for as a key (`size =`, `["d d"] =`, `t.size =`) after the previous one. It's a best effort:
//! a value built by code (a loop, a computed key) gets no line, never a parent key's (ticket 140).

/// The 1-based line where `path` is set, when every name in it is found in `source` as a key.
pub(crate) fn line_of(source: &str, path: &[String]) -> Option<u32> {
    line_of_skipping(source, path, &|_| false)
}

/// [`line_of`], not counting keys inside a `roster.*` statement (`roster.o.terminal.size = 20`,
/// a Theme's `terminal = { … }` in `roster.themes.define`): where a value the file's own tables
/// set is, when a `roster.*` call that set the same option lost to them (ticket 148).
pub(crate) fn line_of_outside_calls(source: &str, path: &[String]) -> Option<u32> {
    let calls = call_lines(source);
    line_of_skipping(source, path, &|at| {
        calls.get(line_at(source, at) as usize - 1).copied().unwrap_or(false)
    })
}

fn line_of_skipping(source: &str, path: &[String], skip: &dyn Fn(usize) -> bool) -> Option<u32> {
    let mut pos = 0;
    let mut line = None;
    for seg in path {
        if seg.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let at = find_key(source, seg, pos, skip)?;
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

/// For each line of `source`, whether it's part of a statement that starts with `roster.`: a
/// line outside brackets starts a statement, and the lines its brackets span belong to it.
fn call_lines(source: &str) -> Vec<bool> {
    let mut out = Vec::new();
    let mut open = 0;
    let mut in_call = false;
    for line in source.lines() {
        if open <= 0 {
            open = 0;
            in_call = line.trim_start().starts_with("roster.");
        }
        out.push(in_call);
        open += brackets(line);
    }
    out
}

fn find_key(source: &str, key: &str, from: usize, skip: &dyn Fn(usize) -> bool) -> Option<usize> {
    let ident = key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !key.is_empty();
    let mut best: Option<usize> = None;
    let mut consider = |at: usize| best = Some(best.map_or(at, |b: usize| b.min(at)));
    for quoted in [format!("[\"{key}\"]"), format!("['{key}']")] {
        let mut start = from;
        while let Some(i) = source[start..].find(&quoted) {
            let at = start + i;
            if assigns(&source[at + quoted.len()..]) && !in_comment(source, at) && !skip(at) {
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
            if boundary && assigns(&source[at + key.len()..]) && !in_comment(source, at) && !skip(at) {
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

/// A file's text with where each line starts, kept once per file for a run: the `roster.*`
/// writes ask it where the statement they come from starts.
pub(crate) struct SourceIndex {
    text: String,
    starts: Vec<usize>,
}

impl SourceIndex {
    pub(crate) fn new(text: String) -> Self {
        let starts = std::iter::once(0)
            .chain(text.match_indices('\n').map(|(i, _)| i + 1))
            .collect();
        SourceIndex { text, starts }
    }

    /// Line `n` (from 1), without its newline; empty past the end.
    fn line(&self, n: u32) -> &str {
        let i = n as usize;
        if i == 0 || i > self.starts.len() {
            return "";
        }
        let start = self.starts[i - 1];
        let end = self.starts.get(i).map_or(self.text.len(), |e| e - 1);
        &self.text[start..end]
    }

    /// The line the statement Lua reports at `line` starts on. Lua gives an assignment of a
    /// table over several lines its last line: when that line closes brackets opened above it,
    /// this walks up to the line that opened them (at most 200 lines). Any other line is its own
    /// statement's: a later write never moves to an earlier one.
    pub(crate) fn statement_start(&self, line: u32) -> u32 {
        let mut open = -brackets(self.line(line));
        if open <= 0 {
            return line;
        }
        let first = line.saturating_sub(200).max(1);
        for n in (first..line).rev() {
            open -= brackets(self.line(n));
            if open <= 0 {
                return n;
            }
        }
        line
    }

    /// The last line from `from` to `to` that assigns `key` (`key =`, `["key"] =`): where a name
    /// inside a table assigned over several lines is.
    pub(crate) fn key_line(&self, key: &str, from: u32, to: u32) -> Option<u32> {
        (from..=to)
            .rev()
            .find(|&n| find_key(self.line(n), key, 0, &|_| false).is_some())
    }
}

/// Brackets a line opens (`{`, `(`, `[`) less those it closes, outside strings and comments.
fn brackets(line: &str) -> i32 {
    let mut n = 0;
    let mut quote: Option<char> = None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some(q) => {
                if c == '\\' {
                    chars.next();
                } else if c == q {
                    quote = None;
                }
            }
            None => match c {
                '"' | '\'' => quote = Some(c),
                '-' if chars.peek() == Some(&'-') => break,
                '{' | '(' | '[' => n += 1,
                '}' | ')' | ']' => n -= 1,
                _ => {}
            },
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_statement_starts_where_its_brackets_open() {
        let src = "roster.o.fonts = {\n  ui = \"Inter\", -- }\n  szie = 1,\n}\nroster.o.vim = false\nlocal t = { a = \"}\" }\n";
        let s = SourceIndex::new(src.to_string());
        assert_eq!(s.statement_start(4), 1);
        assert_eq!(s.statement_start(5), 5);
        assert_eq!(s.statement_start(6), 6);
        assert_eq!(s.key_line("szie", 1, 4), Some(3));
        assert_eq!(s.key_line("vim", 1, 4), None);
    }
}
