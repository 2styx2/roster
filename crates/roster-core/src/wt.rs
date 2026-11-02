//! `:config import-terminal` (ticket 33, decision Q55): make the roster app's terminal look like
//! the user's Windows Terminal. Reads Windows Terminal's `settings.json` (JSON with comments and
//! trailing commas), takes its default profile over `profiles.defaults`, and writes the font,
//! size, weight, cell height and cursor as `roster.o` lines (init.lua's documented style), plus a
//! Theme for the colour scheme, into init.lua between two marker lines. The Theme is defined there
//! but not pinned with `roster.o.theme = …`: the app chooses it as `:theme` does, so `:theme` can still change it
//! (decision Q69). Nothing is written without a preview: [`preview`] gives
//! the diff, and [`apply`] writes only if init.lua is still what the preview read.
//!
//! The colour schemes Windows Terminal ships (Campbell, One Half Dark, …) aren't in the user's
//! settings.json, so they come from its `defaults.json` (MIT, microsoft/terminal), copied into
//! `wt_schemes.json`.

use crate::config::{self, CursorStyle};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The first line of the block this writes into init.lua.
pub const BEGIN: &str = "-- >>> Windows Terminal >>>";
/// Its last line.
pub const END: &str = "-- <<< Windows Terminal <<<";

const BUILTIN_SCHEMES: &str = include_str!("wt_schemes.json");

/// Where Windows Terminal keeps its settings, in the order they're tried: the Store version,
/// Preview, then an unpackaged install.
pub fn settings_paths(local_app_data: &Path) -> Vec<PathBuf> {
    let packaged = |pkg: &str| {
        local_app_data
            .join("Packages")
            .join(pkg)
            .join("LocalState")
            .join("settings.json")
    };
    vec![
        packaged("Microsoft.WindowsTerminal_8wekyb3d8bbwe"),
        packaged("Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe"),
        local_app_data
            .join("Microsoft")
            .join("Windows Terminal")
            .join("settings.json"),
    ]
}

/// A colour scheme, with the profile's own colours over it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scheme {
    pub name: String,
    pub foreground: String,
    pub background: String,
    pub cursor: Option<String>,
    pub selection: Option<String>,
    /// The 16 colours by their init.lua names (`magenta`, `bright_white`).
    pub ansi: BTreeMap<String, String>,
}

/// What the default profile looks like, as far as the terminal goes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    pub font: Option<Vec<String>>,
    pub size_pt: Option<f64>,
    pub weight: Option<u32>,
    /// A multiple of the font size (`font.cellHeight`).
    pub cell_height: Option<f64>,
    pub cursor: Option<CursorStyle>,
    /// `intenseTextStyle`: "bright" (the default), "bold", "all" or "none".
    pub intense: String,
    pub scheme: Option<Scheme>,
    /// The colour scheme it names when that scheme can't be found.
    pub missing_scheme: Option<String>,
}

/// JSON with `//` and `/* */` comments and trailing commas → plain JSON.
fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut last = ' ';
                for n in chars.by_ref() {
                    if last == '*' && n == '/' {
                        break;
                    }
                    last = n;
                }
            }
            _ => out.push(c),
        }
    }
    // Trailing commas: a comma followed only by whitespace before } or ].
    let mut cleaned = String::with_capacity(out.len());
    let bytes: Vec<char> = out.chars().collect();
    let mut in_string = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            cleaned.push(c);
            if c == '\\' && i + 1 < bytes.len() {
                cleaned.push(bytes[i + 1]);
                i += 1;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            cleaned.push(c);
        } else if c == ',' {
            let next = bytes[i + 1..].iter().find(|n| !n.is_whitespace());
            if !matches!(next, Some('}') | Some(']')) {
                cleaned.push(c);
            }
        } else {
            cleaned.push(c);
        }
        i += 1;
    }
    cleaned
}

fn weight_of(v: &Value) -> Option<u32> {
    if let Some(n) = v.as_u64() {
        return Some(n.clamp(1, 1000) as u32);
    }
    Some(match v.as_str()? {
        "thin" => 100,
        "extra-light" => 200,
        "light" => 300,
        "semi-light" => 350,
        "normal" => 400,
        "medium" => 500,
        "semi-bold" => 600,
        "bold" => 700,
        "extra-bold" => 800,
        "black" => 900,
        "extra-black" => 950,
        _ => return None,
    })
}

fn cursor_of(v: &Value) -> Option<CursorStyle> {
    Some(match v.as_str()? {
        "bar" => CursorStyle::Bar,
        "underscore" | "doubleUnderscore" | "vintage" => CursorStyle::Underline,
        "filledBox" | "emptyBox" => CursorStyle::Block,
        _ => return None,
    })
}

/// A unitless `cellHeight` ("1.2", or a number).
fn cell_height_of(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str()?.trim().parse::<f64>().ok())
}

/// The value of `key` in the profile, else in `profiles.defaults`; `font.<key>` beats the old
/// flat key at the same level.
fn pick<'a>(levels: &[&'a Map<String, Value>], font_key: &str, flat_key: Option<&str>) -> Option<&'a Value> {
    levels.iter().find_map(|level| {
        level
            .get("font")
            .and_then(|f| f.get(font_key))
            .or_else(|| flat_key.and_then(|k| level.get(k)))
    })
}

fn scheme_from(v: &Value) -> Option<Scheme> {
    let o = v.as_object()?;
    let s = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
    let names = [
        ("black", "black"),
        ("red", "red"),
        ("green", "green"),
        ("yellow", "yellow"),
        ("blue", "blue"),
        ("purple", "magenta"),
        ("cyan", "cyan"),
        ("white", "white"),
        ("brightBlack", "bright_black"),
        ("brightRed", "bright_red"),
        ("brightGreen", "bright_green"),
        ("brightYellow", "bright_yellow"),
        ("brightBlue", "bright_blue"),
        ("brightPurple", "bright_magenta"),
        ("brightCyan", "bright_cyan"),
        ("brightWhite", "bright_white"),
    ];
    let ansi = names
        .iter()
        .filter_map(|(wt, ours)| Some((ours.to_string(), s(wt)?)))
        .collect();
    Some(Scheme {
        name: s("name")?,
        foreground: s("foreground").unwrap_or_else(|| "#CCCCCC".into()),
        background: s("background").unwrap_or_else(|| "#0C0C0C".into()),
        cursor: s("cursorColor"),
        selection: s("selectionBackground"),
        ansi,
    })
}

/// The default profile in Windows Terminal's settings.json.
pub fn parse(text: &str) -> Result<Profile, String> {
    let root: Value = serde_json::from_str(&strip_jsonc(text))
        .map_err(|e| format!("Windows Terminal's settings.json isn't JSON Windows Terminal reads: {e}"))?;
    let empty = Map::new();
    let (defaults, list): (&Map<String, Value>, Vec<&Map<String, Value>>) = match root.get("profiles") {
        Some(Value::Array(a)) => (&empty, a.iter().filter_map(Value::as_object).collect()),
        Some(Value::Object(o)) => (
            o.get("defaults").and_then(Value::as_object).unwrap_or(&empty),
            o.get("list")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_object).collect())
                .unwrap_or_default(),
        ),
        _ => (&empty, Vec::new()),
    };
    let wanted = root
        .get("defaultProfile")
        .and_then(Value::as_str)
        .map(str::to_lowercase);
    let guid = |p: &Map<String, Value>| p.get("guid").and_then(Value::as_str).map(str::to_lowercase);
    let profile = wanted
        .and_then(|w| list.iter().copied().find(|p| guid(p).as_deref() == Some(w.as_str())))
        .or_else(|| list.first().copied())
        .unwrap_or(&empty);
    let levels = [profile, defaults];
    let at = |k: &str| levels.iter().find_map(|l| l.get(k));

    let font = pick(&levels, "face", Some("fontFace"))
        .and_then(Value::as_str)
        .map(|f| config::FontList::parse(f).0)
        .filter(|f| !f.is_empty());
    let size_pt = pick(&levels, "size", Some("fontSize")).and_then(Value::as_f64);
    let weight = pick(&levels, "weight", Some("fontWeight")).and_then(weight_of);
    let cell_height = pick(&levels, "cellHeight", None).and_then(cell_height_of);
    let cursor = at("cursorShape").and_then(cursor_of);
    let intense = at("intenseTextStyle")
        .and_then(Value::as_str)
        .filter(|s| ["bright", "bold", "all", "none"].contains(s))
        .unwrap_or("bright")
        .to_string();

    let scheme_name = match at("colorScheme") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) => o
            .get("dark")
            .or_else(|| o.get("light"))
            .and_then(Value::as_str)
            .unwrap_or("Campbell")
            .to_string(),
        _ => "Campbell".into(),
    };
    let builtin: Vec<Value> = serde_json::from_str(BUILTIN_SCHEMES).unwrap_or_default();
    let user = root
        .get("schemes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let found = user
        .iter()
        .chain(&builtin)
        .find(|s| s.get("name").and_then(Value::as_str) == Some(scheme_name.as_str()))
        .and_then(scheme_from);
    let missing_scheme = found.is_none().then(|| scheme_name.clone());
    let scheme = found.map(|mut s| {
        let own = |k: &str| at(k).and_then(Value::as_str).map(str::to_string);
        if let Some(v) = own("foreground") {
            s.foreground = v;
        }
        if let Some(v) = own("background") {
            s.background = v;
        }
        if let Some(v) = own("cursorColor") {
            s.cursor = Some(v);
        }
        if let Some(v) = own("selectionBackground") {
            s.selection = Some(v);
        }
        s
    });

    Ok(Profile {
        name: profile
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("(unnamed)")
            .to_string(),
        font,
        size_pt,
        weight,
        cell_height,
        cursor,
        intense,
        scheme,
        missing_scheme,
    })
}

/// A Lua string literal.
fn lua_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A number as Lua writes it: no ".0" on whole numbers.
fn lua_num(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// The Theme id for a scheme: `wt-` and its name in lowercase words.
pub fn theme_id(scheme: &str) -> String {
    let mut id = String::from("wt");
    let mut dash = true;
    for c in scheme.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            if dash {
                id.push('-');
            }
            id.push(c);
            dash = false;
        } else {
            dash = true;
        }
    }
    id
}

fn is_dark(hex: &str) -> bool {
    let h = hex.trim_start_matches('#');
    let channel = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0) as f64 / 255.0;
    if h.len() < 6 {
        return true;
    }
    0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4) < 0.5
}

fn cursor_name(c: CursorStyle) -> &'static str {
    match c {
        CursorStyle::Block => "block",
        CursorStyle::Bar => "bar",
        CursorStyle::Underline => "underline",
    }
}

/// What the import sets, as `(option name, Lua value)`. Not `theme` (decision Q69).
fn settings(p: &Profile) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(font) = &p.font {
        let names: Vec<String> = font.iter().map(|f| lua_str(f)).collect();
        out.push(("terminal.font".into(), format!("{{ {} }}", names.join(", "))));
    }
    if let Some(pt) = p.size_pt {
        out.push(("terminal.size".into(), lua_str(&format!("{}pt", lua_num(pt)))));
    }
    if let Some(w) = p.weight {
        out.push(("terminal.weight".into(), w.to_string()));
    }
    if let Some(h) = p.cell_height {
        out.push(("terminal.cell_height".into(), lua_num(h)));
    }
    if let Some(c) = p.cursor {
        out.push(("terminal.cursor_style".into(), lua_str(cursor_name(c))));
    }
    // Intense text: Windows Terminal draws it bright, bold, both or neither ("bright" by default,
    // so bold text isn't heavier there). Iosevka's Medium (500) is the app's own weight.
    let heavier = matches!(p.intense.as_str(), "bold" | "all");
    let brighter = matches!(p.intense.as_str(), "bright" | "all");
    if !heavier {
        out.push(("terminal.bold_weight".into(), p.weight.unwrap_or(500).to_string()));
    }
    out.push(("terminal.bold_is_bright".into(), brighter.to_string()));
    out
}

/// The block for init.lua: a Theme for the profile's colour scheme, and a `roster.o` line per option.
pub fn lua_block(p: &Profile, settings_path: &str, date: &str) -> String {
    let one_line = |s: &str| s.replace(['\n', '\r'], " ");
    let mut b = format!(
        "{BEGIN} made by :config import-terminal; run it again to refresh, delete it to undo\n\
         -- From the default profile {} in {}, {}.\n\
         -- A later line that sets the same option, or this file's returned table, wins over these.\n",
        lua_str(&one_line(&p.name)),
        one_line(settings_path),
        one_line(date),
    );
    if let Some(s) = &p.scheme {
        let dark = is_dark(&s.background);
        let mut terminal = vec![
            format!("background = {}", lua_str(&s.background)),
            format!("foreground = {}", lua_str(&s.foreground)),
        ];
        if let Some(c) = &s.cursor {
            terminal.push(format!("cursor = {}", lua_str(c)));
        }
        if let Some(c) = &s.selection {
            terminal.push(format!("selection_background = {}", lua_str(c)));
        }
        b.push_str(&format!("roster.themes.define({}, {{\n", lua_str(&theme_id(&s.name))));
        b.push_str(&format!(
            "  label = {},\n",
            lua_str(&format!("{} (Windows Terminal)", s.name))
        ));
        b.push_str(&format!(
            "  appearance = \"{}\",\n",
            if dark { "dark" } else { "light" }
        ));
        b.push_str(&format!(
            "  base = \"{}\",\n",
            if dark { "roster-dark" } else { "roster-light" }
        ));
        b.push_str(&format!("  terminal = {{ {} }},\n", terminal.join(", ")));
        if !s.ansi.is_empty() {
            b.push_str("  ansi = {\n");
            for name in config::Ansi::NAMES {
                if let Some(v) = s.ansi.get(*name) {
                    b.push_str(&format!("    {name} = {},\n", lua_str(v)));
                }
            }
            b.push_str("  },\n");
        }
        b.push_str("})\n");
        b.push_str("-- Chosen as :theme chooses it (kept in the app's State), so :theme can change it.\n");
    }
    if let Some(name) = &p.missing_scheme {
        b.push_str(&format!(
            "-- Its colour scheme {} isn't in settings.json or Windows Terminal's own, so the colours stay.\n",
            lua_str(&one_line(name))
        ));
    }
    for (name, value) in settings(p) {
        // Every name is a plain dotted path (terminal.size), so it's a valid Lua field chain.
        b.push_str(&format!("roster.o.{name} = {value}\n"));
    }
    b.push_str(END);
    b.push('\n');
    b
}

/// init.lua with `block` in it: in place of an earlier import, else before the file's last
/// top-level `return`, else at the end.
pub fn insert_block(init: &str, block: &str) -> String {
    let lines: Vec<&str> = init.split_inclusive('\n').collect();
    let begin = lines.iter().position(|l| l.starts_with(BEGIN));
    let end = begin.and_then(|b| lines[b..].iter().position(|l| l.starts_with(END)).map(|e| b + e));
    if let (Some(b), Some(e)) = (begin, end) {
        return [lines[..b].concat(), block.to_string(), lines[e + 1..].concat()].concat();
    }
    let is_return = |l: &&str| {
        l.strip_prefix("return")
            .is_some_and(|rest| rest.is_empty() || rest.starts_with([' ', '{', '\n', '\r', '\t']))
    };
    if let Some(r) = lines.iter().rposition(is_return) {
        return [lines[..r].concat(), block.to_string(), "\n".into(), lines[r..].concat()].concat();
    }
    let mut out = init.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push('\n');
    out.push_str(block);
    out
}

/// [`insert_block`], in the file's own line endings: a file written with CRLF stays CRLF.
fn with_block(init: &str, block: &str) -> String {
    let new = insert_block(init, block);
    if init.contains("\r\n") {
        new.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        new
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffKind {
    Same,
    Add,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
}

/// A line diff (longest common subsequence; init.lua is small).
pub fn diff(old: &str, new: &str) -> Vec<DiffLine> {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let mut lcs = vec![vec![0u32; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::new();
    let line = |kind, text: &str| DiffLine {
        kind,
        text: text.to_string(),
    };
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            out.push(line(DiffKind::Same, a[i]));
            i += 1;
            j += 1;
        } else if j < b.len() && (i == a.len() || lcs[i][j + 1] >= lcs[i + 1][j]) {
            out.push(line(DiffKind::Add, b[j]));
            j += 1;
        } else {
            out.push(line(DiffKind::Remove, a[i]));
            i += 1;
        }
    }
    out
}

/// What `:config import-terminal` would do, before it does it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub settings_path: String,
    pub profile: Profile,
    /// One line per thing it takes ("Font: Iosevka Nerd Font, 16 pt (21.3 px)").
    pub summary: Vec<String>,
    pub diff: Vec<DiffLine>,
    /// The Theme it defines for the profile's colour scheme, which the app then chooses as
    /// `:theme` does (decision Q69); none without a scheme.
    pub theme: Option<String>,
    /// Options it sets that init.lua sets again where it wins: in its returned table, or in a
    /// line after the block (an older block is replaced in place, so a line below it stays later).
    pub overridden: Vec<Overridden>,
    /// There's no init.lua yet: it would be made from the commented-out example.
    pub created: bool,
    /// What [`apply`] checks init.lua against, so a file changed since isn't overwritten.
    pub base: String,
    /// The fingerprint of init.lua as this preview would leave it: [`apply`] writes only that.
    pub result: String,
    /// The date in the block's comment, so applying it another day writes the same block.
    pub date: String,
    /// The Config error the new file would have, if any.
    pub error: Option<String>,
}

/// What wins over the import for an option it sets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Wins {
    /// init.lua's returned table sets it: that wins over every `roster.*` line.
    Returned,
    /// A line after the block sets it (in init.lua, or a module it requires there): the last
    /// write wins.
    Later,
}

/// An option the import sets that init.lua sets again where it wins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Overridden {
    pub option: String,
    pub by: Wins,
    /// The later line; none for the returned table.
    pub at: Option<config::Location>,
}

/// The 1-based lines of `text`'s import block, first and last.
fn block_lines(text: &str) -> Option<(u32, u32)> {
    let lines: Vec<&str> = text.lines().collect();
    let begin = lines.iter().position(|l| l.starts_with(BEGIN))?;
    let end = begin + lines[begin..].iter().position(|l| l.starts_with(END))?;
    Some((begin as u32 + 1, end as u32 + 1))
}

/// What the app hands back to [`apply`] from the [`Preview`] the user confirmed.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Previewed {
    pub base: String,
    pub result: String,
    pub date: String,
}

impl Preview {
    pub fn applied(&self) -> Previewed {
        Previewed {
            base: self.base.clone(),
            result: self.result.clone(),
            date: self.date.clone(),
        }
    }
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// FNV-1a of the file (or "absent"): enough to notice it changed.
fn fingerprint(text: Option<&str>) -> String {
    let Some(text) = text else { return "absent".into() };
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn read_init(dir: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(dir.join(config::FILE_NAME)) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("can't read init.lua: {e}")),
    }
}

fn has_path(v: &Value, path: &str) -> bool {
    let mut node = v;
    for key in path.split('.') {
        match node.get(key) {
            Some(n) => node = n,
            None => return false,
        }
    }
    true
}

/// The diff and what it means, without writing anything.
pub fn preview(dir: &Path, settings_text: &str, settings_path: &str, date: &str) -> Result<Preview, String> {
    let current = read_init(dir)?;
    let old = current.clone().unwrap_or_else(config::starter);
    let profile = parse(settings_text)?;
    let new = with_block(&old, &lua_block(&profile, settings_path, date));
    let (overridden, error) = match config::returned_table(dir, &new) {
        Ok(table) => {
            let loaded = config::load_source(dir, &new, &config::Env::default());
            let block = block_lines(&new);
            let in_block = |at: &config::Location| {
                at.file == config::FILE_NAME && block.is_some_and(|(b, e)| (b..=e).contains(&at.line))
            };
            let overridden = settings(&profile)
                .into_iter()
                .filter_map(|(option, _)| {
                    if has_path(&table, &option) {
                        return Some(Overridden {
                            option,
                            by: Wins::Returned,
                            at: None,
                        });
                    }
                    let at = loaded.as_ref().ok()?.lines.get(&option)?;
                    (!in_block(at)).then(|| Overridden {
                        option,
                        by: Wins::Later,
                        at: Some(at.clone()),
                    })
                })
                .collect();
            (overridden, loaded.err().map(|e| e.to_string()))
        }
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    let mut summary = vec![format!("Profile: {}", profile.name)];
    if let Some(f) = &profile.font {
        let size = profile
            .size_pt
            .map(|pt| format!(", {} pt ({:.1} px)", lua_num(pt), config::FontSize::Pt(pt).px()))
            .unwrap_or_default();
        summary.push(format!("Font: {}{size}", f.join(", ")));
    }
    if let Some(w) = profile.weight {
        summary.push(format!("Weight: {w}"));
    }
    if let Some(h) = profile.cell_height {
        summary.push(format!("Cell height: {} × the font size", lua_num(h)));
    }
    if let Some(s) = &profile.scheme {
        summary.push(format!(
            "Colours: {} → Theme {}, chosen as :theme does",
            s.name,
            theme_id(&s.name)
        ));
    }
    if let Some(c) = profile.cursor {
        summary.push(format!("Cursor: {}", cursor_name(c)));
    }
    summary.push(format!("Intense (bold) text: {}", profile.intense));
    let theme = profile.scheme.as_ref().map(|s| theme_id(&s.name));
    Ok(Preview {
        settings_path: settings_path.into(),
        profile,
        summary,
        diff: diff(&old, &new),
        theme,
        overridden,
        created: current.is_none(),
        base: fingerprint(current.as_deref()),
        result: fingerprint(Some(&new)),
        date: date.into(),
        error,
    })
}

/// Writes exactly what [`preview`] showed, or nothing: only if init.lua is still what it read
/// (`base`) and Windows Terminal's settings (read again now) still make the same file (`result`).
pub fn apply(dir: &Path, settings_text: &str, settings_path: &str, previewed: &Previewed) -> Result<(), String> {
    if !is_date(&previewed.date) {
        return Err("the preview's date isn't a date; nothing was written".into());
    }
    let current = read_init(dir)?;
    if fingerprint(current.as_deref()) != previewed.base {
        return Err(
            "init.lua changed since the preview; nothing was written. Run :config import-terminal again".into(),
        );
    }
    let old = current.unwrap_or_else(config::starter);
    let new = with_block(&old, &lua_block(&parse(settings_text)?, settings_path, &previewed.date));
    if fingerprint(Some(&new)) != previewed.result {
        return Err(
            "Windows Terminal's settings changed since the preview; nothing was written. \
             Run :config import-terminal again to see what it would write now"
                .into(),
        );
    }
    config::write_atomic(&dir.join(config::FILE_NAME), &new).map_err(|e| format!("can't write init.lua: {e}"))
}

/// Today as YYYY-MM-DD (UTC), for the block's comment.
pub fn today() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}
