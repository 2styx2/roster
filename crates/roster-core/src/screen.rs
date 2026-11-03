//! Where a Session's cursor is and what its line shows, as a terminal would draw the Session's
//! output (ticket 137, decision Q136): enough of a terminal for a prompt fill to check that the
//! prompt the frontend read off its screen is the one at the cursor, through ConPTY's redraws
//! (cursor addressing, column sets, erased characters, carriage-return overwrites, backspaces).
//! It keeps one screen of cells (and the main screen while an alternate one is up), never the
//! scrollback, and parses every escape sequence a terminal does, acting on the ones that move the
//! cursor or change cells and skipping the rest (colours, titles, links, DCS and APC strings).
//! A UTF-8 character takes one cell, kept whole with the style it was drawn with (the review of
//! #299, #5); the prompt checks read its first byte. Where it can't mirror xterm.js exactly (the
//! terminal the user sees), it doesn't guess (the review of #318): what it doesn't model (a
//! repeat, insert mode, scroll regions, the alignment test, other charsets, origin and wrap
//! modes, tab stops, a wide or zero-width character, invalid UTF-8, an SGR or a colour it can't
//! read as xterm.js does, a CSI with sub-parameters or more parameters than xterm.js keeps, a
//! palette change) it counts ([`Screen::matches`] then never holds), and a wide or zero-width
//! character on the screen means it never matches. Styles are kept as a terminal shows them
//! (ticket 155c): every form of the same SGR is one style, an erase leaves the background alone
//! (as xterm.js erases), and a space keeps only what shows on a blank, so ConPTY's repaint of
//! blanks in its own buffer's colours is the same screen.

/// One cell: its character, all of its UTF-8 bytes (at most 4), and the style it was drawn with.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Cell {
    ch: [u8; 4],
    style: Style,
}

impl Cell {
    /// Its first byte: what the prompt checks read.
    fn byte(self) -> u8 {
        self.ch[0]
    }

    /// How many columns xterm.js gives its character ([`crate::wcwidth::width`]).
    fn width(self) -> u8 {
        let len = self.ch.iter().position(|&b| b == 0).unwrap_or(4).max(1);
        std::str::from_utf8(&self.ch[..len])
            .ok()
            .and_then(|s| s.chars().next())
            .map_or(1, |c| crate::wcwidth::width(u32::from(c)))
    }
}

/// A blank cell in the default style.
const BLANK: Cell = Cell {
    ch: [b' ', 0, 0, 0],
    style: Style::DEFAULT,
};

/// A colour as SGR sets it (ticket 155c): the default, a 16-colour SGR code (`32`, `92`, `44`,
/// `104`), one of 256 (`38;5;N`) or a true colour (`38;2;R;G;B`), whichever form the parameters
/// came in. The 16 and the 256 stay apart: bold in a 16-colour green draws bright, in a
/// 256-colour one it doesn't.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Colour {
    #[default]
    Default,
    Code(u8),
    P256(u8),
    Rgb(u8, u8, u8),
}

/// A style, as SGR sets it, the attributes xterm.js keeps: the flags (`BOLD`…), the underline's
/// kind (0 none, 1 single, 2 double, 3 curly, 4 dotted, 5 dashed) and the three colours. A value,
/// so every cell and every [`Snapshot`] holds its own (the review of #318, #9 and #10).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Style {
    flags: u16,
    underline: u8,
    fg: Colour,
    bg: Colour,
    ul: Colour,
}

const BOLD: u16 = 1;
const FAINT: u16 = 1 << 1;
const ITALIC: u16 = 1 << 2;
const BLINK: u16 = 1 << 3;
const REVERSE: u16 = 1 << 4;
const HIDDEN: u16 = 1 << 5;
const STRIKE: u16 = 1 << 6;
const OVERLINE: u16 = 1 << 7;

impl Style {
    const DEFAULT: Style = Style {
        flags: 0,
        underline: 0,
        fg: Colour::Default,
        bg: Colour::Default,
        ul: Colour::Default,
    };

    /// What an erase leaves with it: the background colour alone, as xterm.js erases.
    fn erased(self) -> Style {
        Style {
            bg: self.bg,
            ..Style::DEFAULT
        }
    }

    /// What shows on a blank drawn in it: its background, unless it draws more than its
    /// background there (reversed, or a line through, under or over it), when all of it can.
    fn on_blank(self) -> Style {
        if self.underline != 0 || self.flags & (REVERSE | STRIKE | OVERLINE) != 0 {
            self
        } else {
            self.erased()
        }
    }
}

/// The most things a [`Screen`] keeps that it doesn't model, for the log ([`ScreenDiff`]).
const ODD_KEPT: usize = 16;
/// The longest CSI parameter list kept; a longer sequence is parsed through and ignored.
const CSI_MAX: usize = 64;
/// The longest OSC read for a shell mark; a longer one is parsed through and ignored (roster's own
/// marks are well under it).
const OSC_MAX: usize = 128;

/// The Session's own shell's marks, as roster's shell hooks make them (OSC 133 with the Session's
/// token, decision Q131 (a)): how many commands it has started and the last mark's kind, so a
/// nested ssh's fill goes only while that ssh runs (ticket 162). Only roster's own shell knows the
/// token, so no other machine can make one of these marks.
#[derive(Default)]
struct OwnMarks {
    /// `roster=TOKEN`, as a mark's parameter carries it; None: no marks are followed.
    param: Option<Vec<u8>>,
    /// The `C` marks seen: commands the shell started.
    runs: u64,
    /// The last mark's kind (`A`, `B`, `C`, `D`…), or 0 for a kind longer than one letter.
    last: Option<u8>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Parse {
    Ground,
    Esc,
    Csi,
    /// An OSC, DCS, APC, PM or SOS string, until BEL or ST.
    Str,
    StrEsc,
    /// After an intermediate byte (`ESC ( B`, `ESC # 8`), until its final byte.
    Inter,
}

pub(crate) struct Screen {
    rows: usize,
    cols: usize,
    grid: Vec<Vec<Cell>>,
    row: usize,
    col: usize,
    /// The cursor is past the last column: the next character wraps first.
    pending_wrap: bool,
    /// What DECSC (`ESC 7`, `CSI s`) saved on the main screen, as xterm.js keeps it per screen
    /// (the review of #318).
    saved_main: Saved,
    /// The same on the alternate screen; None until it's saved there since the alternate screen
    /// came up (xterm.js keeps the last one, which this screen doesn't follow).
    saved_alt: Option<Saved>,
    /// How often the main screen scrolled (a line feed at its foot, `ESC[3J`): xterm.js restores
    /// a saved cursor counting lines from the top of its scrollback, which this screen doesn't
    /// keep, so a restore across a scroll isn't modelled.
    scrolls: u64,
    /// The main screen while the alternate screen is up.
    main: Option<Vec<Vec<Cell>>>,
    parse: Parse,
    csi: Vec<u8>,
    csi_long: bool,
    /// The first intermediate byte of an escape sequence (`(` in `ESC ( B`).
    inter: u8,
    /// The style characters are drawn with.
    style: Style,
    /// A UTF-8 character begun: its bytes so far, how many, and how many it takes.
    utf8: Option<([u8; 4], usize, usize)>,
    /// Bytes fed so far, where the last ESC (or C1 CSI) was, and where the last `ESC[2J` ended:
    /// `ESC[3J` right after `ESC[2J` (ConPTY's `cls`) is the only one modelled (the review of #318).
    fed: u64,
    esc_at: u64,
    ed2_end: u64,
    /// The string being read: its opening byte (`]` for an OSC) and, for an OSC, its first bytes,
    /// to tell a palette change (the review of #318).
    str_open: u8,
    osc_head: Vec<u8>,
    /// Resizes so far (the review of #299, #6).
    resizes: u64,
    /// Things done that this screen doesn't model (the review of #299, #5).
    odd: u64,
    /// The last [`ODD_KEPT`] of them, each with its number (`odd` after it), for the log
    /// (ticket 155c): never text ([`Seen`]).
    odd_seen: std::collections::VecDeque<(u64, Seen)>,
    /// What a fill's probe draws, while it waits (ticket 154): [`Screen::watch_mask`].
    mask: Option<MaskWatch>,
    /// The OSC being read, while it may be a shell mark (ticket 162): only while a token is
    /// followed; None for other strings and one longer than [`OSC_MAX`].
    osc: Option<Vec<u8>>,
    /// A `0xC2` in the text or a string, not yet drawn or kept: with a byte from `0x80` to `0x9f`
    /// after it, it's a C1 control (U+0080 to U+009F), which xterm.js acts on (the review of #308,
    /// #4).
    c1: bool,
    /// The Session's own shell's marks (ticket 162): [`Screen::own_run`].
    own: OwnMarks,
}

/// A saved cursor, as xterm.js's DECSC keeps it: where, the style (xterm.js restores the colours
/// and flags, not the underline's kind or colour), and [`Screen::scrolls`] then.
#[derive(Clone, Copy, Default)]
struct Saved {
    row: usize,
    col: usize,
    style: Style,
    scrolls: u64,
}

/// The whole screen as a terminal shows it, and the cursor: what a fill notes as it checks the
/// prompt and as it types its probe, so output since can be told from a repaint of the same
/// content (ticket 155, #284, decision Q151): [`Screen::snapshot`], [`Screen::matches`].
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Snapshot {
    rows: usize,
    cols: usize,
    grid: Vec<Vec<Cell>>,
    row: usize,
    col: usize,
    pending_wrap: bool,
    /// The alternate screen is up.
    alternate: bool,
    resizes: u64,
    odd: u64,
    /// A wide or zero-width character was on the screen.
    wide: bool,
}

/// How the screen now compares with a [`Snapshot`] (the review of #299, #9: one comparison for
/// every check).
struct Compared {
    /// The same size, the same screen (main or alternate), no resize and nothing unmodelled since.
    shape: bool,
    /// Something this screen doesn't model was done since.
    odd: bool,
    /// The cursor where it was (row, column, pending wrap).
    cursor: bool,
    /// The snapshot's cursor row as it was.
    prompt_row: bool,
    /// Every other row as it was.
    others: bool,
}

/// The most changed rows a [`ScreenDiff`] names; past it, it says how many more.
const DIFF_ROWS: usize = 8;

/// What differs between the screen and a [`Snapshot`], for the app's log when a fill refuses
/// before its probe (ticket 155c, #284 item 5): the cursor, the size, resizes since, the
/// alternate screen, each changed row (at most [`DIFF_ROWS`]) with whether its characters or
/// only its styles differ, and what it did that the screen doesn't model (the last
/// [`ODD_KEPT`]). Never a character: a row says only which columns changed, and a style only its
/// SGR parameters (`fg default -> 37`); unmodelled sequences are named as [`Drawn`] names them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScreenDiff {
    /// The cursor at the snapshot and now.
    cursor: Option<(CursorAt, CursorAt)>,
    /// The size (rows, columns) at the snapshot and now.
    size: Option<((usize, usize), (usize, usize))>,
    resizes: u64,
    /// Whether the alternate screen is up now, if that changed.
    alternate: Option<bool>,
    /// A wide or zero-width character is on the screen, now or at the snapshot.
    wide: bool,
    rows: Vec<RowDiff>,
    rows_more: usize,
    odd: Vec<Seen>,
    odd_more: u64,
}

/// A cursor, for a [`ScreenDiff`]: its row and column, from 1, and whether a wrap is pending.
type CursorAt = (usize, usize, bool);

/// One changed row of a [`ScreenDiff`].
#[derive(Clone, Debug, PartialEq, Eq)]
struct RowDiff {
    /// From 1.
    row: usize,
    /// The first and last changed columns, from 1.
    cols: (usize, usize),
    /// None: a character differs; else only styles do, and how the first changed cell's did, as
    /// [`style_change`] says it.
    styles_only: Option<String>,
}

impl std::fmt::Display for ScreenDiff {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut parts: Vec<String> = Vec::new();
        if let Some((was, now)) = self.cursor {
            let at =
                |(r, c, wrap): (usize, usize, bool)| format!("{r}:{c}{}", if wrap { " (wrap pending)" } else { "" });
            parts.push(format!("the cursor moved from {} to {}", at(was), at(now)));
        }
        if let Some(((r0, c0), (r1, c1))) = self.size {
            parts.push(format!("the size changed from {r0}x{c0} to {r1}x{c1}"));
        }
        if self.resizes > 0 {
            parts.push(format!(
                "resized {} time{}",
                self.resizes,
                if self.resizes == 1 { "" } else { "s" }
            ));
        }
        if let Some(up) = self.alternate {
            parts.push(format!(
                "the alternate screen {}",
                if up { "came up" } else { "went away" }
            ));
        }
        if self.wide {
            parts.push("a wide or zero-width character is on the screen".to_string());
        }
        for r in &self.rows {
            let cols = match r.cols {
                (a, b) if a == b => format!("column {a}"),
                (a, b) => format!("columns {a}-{b}"),
            };
            parts.push(match &r.styles_only {
                None => format!("row {} characters ({cols})", r.row),
                Some(how) => format!("row {} styles only ({cols}: {how})", r.row),
            });
        }
        if self.rows_more > 0 {
            parts.push(format!("and {} more rows changed", self.rows_more));
        }
        if !self.odd.is_empty() || self.odd_more > 0 {
            let mut s = String::from("unmodelled:");
            for seen in &self.odd {
                s.push_str(&format!(" {seen}"));
            }
            if self.odd_more > 0 {
                s.push_str(&format!(" and {} more", self.odd_more));
            }
            parts.push(s);
        }
        if parts.is_empty() {
            return f.write_str("nothing on the screen differs");
        }
        f.write_str(&parts.join("; "))
    }
}

/// How style `was` became `now`, attribute by attribute, as SGR parameters (`bold off -> 1,
/// fg default -> 37`): numbers only.
fn style_change(was: Style, now: Style) -> String {
    let mut out = Vec::new();
    for (flag, name, code) in [
        (BOLD, "bold", "1"),
        (FAINT, "faint", "2"),
        (ITALIC, "italic", "3"),
        (BLINK, "blink", "5"),
        (REVERSE, "reverse", "7"),
        (HIDDEN, "hidden", "8"),
        (STRIKE, "strike", "9"),
        (OVERLINE, "overline", "53"),
    ] {
        let say = |s: Style| if s.flags & flag != 0 { code } else { "off" };
        if say(was) != say(now) {
            out.push(format!("{name} {} -> {}", say(was), say(now)));
        }
        if flag == FAINT && was.underline != now.underline {
            let say = |u: u8| match u {
                0 => "off".to_string(),
                1 => "4".to_string(),
                2 => "21".to_string(),
                n => format!("4:{n}"),
            };
            out.push(format!("underline {} -> {}", say(was.underline), say(now.underline)));
        }
    }
    for (name, at, a, b) in [
        ("fg", 38, was.fg, now.fg),
        ("bg", 48, was.bg, now.bg),
        ("underline colour", 58, was.ul, now.ul),
    ] {
        let say = |c: Colour| match c {
            Colour::Default => "default".to_string(),
            Colour::Code(n) => n.to_string(),
            Colour::P256(n) => format!("{at};5;{n}"),
            Colour::Rgb(r, g, b) => format!("{at};2;{r};{g};{b}"),
        };
        if a != b {
            out.push(format!("{name} {} -> {}", say(a), say(b)));
        }
    }
    out.join(", ")
}

/// The screen and the cursor as they were when a fill typed its probe, and what the output has
/// done since, as this parser reads it (ticket 154, decision Q144): never bytes taken out of the
/// stream.
struct MaskWatch {
    at: Snapshot,
    /// `*`s drawn.
    stars: usize,
    /// Anything else: another character (a space aside), a line feed, a tab, a control or escape sequence that
    /// isn't a cursor move, an erase within the line or the cursor's hide and show, a resize.
    other: bool,
    /// What the parser saw, for the log when it isn't a mask (ticket 155): [`Drawn`].
    seen: Vec<Seen>,
    /// What it saw past [`SEEN_MAX`].
    more: usize,
    /// The kind of the last thing seen (kept or not), so a run of text is one.
    last: Option<Kind>,
}

/// The most things [`Drawn`] names; past it, it says how many more.
const SEEN_MAX: usize = 64;
/// The most of a CSI's parameters [`Drawn`] shows.
const SEEN_PARAMS: usize = 16;
/// The CSI commands [`Drawn`] names (ticket 155); any other shows as `?`, so a Session can't
/// spell text into the log with sequences' final bytes. They're what a terminal layer (ConPTY)
/// may redraw sudo's mask with: cursor moves (`A`-`H`, `a`, `d`, `e`, `f`, `` ` ``), erases (`J`,
/// `K`, `X`), inserts, deletes and scrolls (`@`, `P`, `L`, `M`, `S`, `T`, `r`), colours (`m`),
/// a status report (`n`), and, under narrower rules in [`csi_shown`], the DEC modes (`h`, `l`,
/// only after `?` and a number: the cursor's hide and show, the alternate screen) and the cursor's save and
/// restore (`s`, `u`, only bare). The rest (window ops, device queries, keyboard modes) isn't
/// how a redraw is done.
const CSI_SHOWN: &[u8] = b"ABCDEFGHadef`JKX@PLMSTrmnhlsu";

/// Whether [`Drawn`] names a CSI's command `fin`, with `params` as they came.
fn csi_shown(params: &[u8], fin: u8) -> bool {
    match fin {
        b'h' | b'l' => params.len() > 1 && params.first() == Some(&b'?'),
        b's' | b'u' => params.is_empty(),
        _ => CSI_SHOWN.contains(&fin),
    }
}

/// Whether [`Drawn`] shows a CSI's parameters: numbers and `;`, after an optional `?`.
fn params_shown(params: &[u8]) -> bool {
    params
        .strip_prefix(b"?")
        .unwrap_or(params)
        .iter()
        .all(|&b| b.is_ascii_digit() || b == b';')
}

/// One thing a fill's probe drew, as the core's screen parsed it (ticket 155): never the text of
/// a character other than `*` and space, nor an escape string's contents, only how many.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Seen {
    Star,
    Space,
    /// A run of this many other printed characters.
    Text(usize),
    /// A control character.
    Ctl(u8),
    /// An escape sequence that isn't a CSI or a string: the bytes after ESC.
    Esc(Vec<u8>),
    /// A CSI: its parameters (cut to [`SEEN_PARAMS`], or `None` past [`CSI_MAX`]) and its final
    /// byte, none when another ESC cut it short.
    Csi(Option<Vec<u8>>, Option<u8>),
    /// An OSC, DCS, APC, PM or SOS string (its opening byte) of this many bytes.
    Str(u8, usize),
    Resize,
    /// A UTF-8 continuation byte with no character to continue (ticket 155c, unmodelled only).
    Stray,
    /// A character xterm.js gives this many columns other than one (ticket 155c, the review of
    /// #318; unmodelled only).
    Width(u8),
    /// An OSC that changes the palette (ticket 155c, the review of #318; unmodelled only).
    Palette,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Str,
    Esc,
    Other,
}

/// What a fill's probe drew between the probe and the check, for the app's log when the mask
/// watch refused it (ticket 155, #284): each thing the core's screen parsed, in order (at most
/// [`SEEN_MAX`]), and whether the cursor or its line ended other than they began. Printed text
/// other than `*` and space shows only as how many characters (`text(3)`), an escape string only
/// as its length (`OSC(12)`); a CSI shows its parameters only when they're numbers
/// (else `params(N)`) and its command only when it's one a redraw uses ([`CSI_SHOWN`], else `?`),
/// as in `CSI[?25l`, so no sequence spells text into it. This is
/// before any password is typed, but it's kept that narrow anyway.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Drawn {
    seen: Vec<Seen>,
    more: usize,
    /// The cursor (row, column, from 1) when the probe went and at the check, if they differ.
    moved: Option<((usize, usize), (usize, usize))>,
    /// The prompt's own line changed.
    line_changed: bool,
    /// Another line of the screen changed, or its size or the alternate screen (ticket 155).
    elsewhere_changed: bool,
    /// The output did something the screen doesn't model (the review of #299, #5).
    unmodelled: bool,
    /// Bytes the Session printed between the prompt check and the probe, which only repainted the
    /// screen (the fill sets it).
    pub(crate) before: u64,
    /// Which of the fill's rules refused (the fill sets it), for the log (ticket 155).
    pub(crate) why: Why,
}

/// Which step refused a fill at sudo's prompt for the Session's own Host, for the log
/// ([`Drawn`], ticket 155).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Why {
    /// At the end: what the probe drew isn't sudo's mask as roster takes it, or the screen didn't
    /// end as it was.
    #[default]
    Probe,
    /// At the end: the cursor's line isn't sudo's prompt and nothing else.
    Line,
    /// With the probe's letter pending (before the last Ctrl+U): the watch saw something it
    /// doesn't allow, or the screen wasn't sudo's prompt and at most its one `*` with every other
    /// line as it was (Q151 (h)).
    Pending,
}

/// What [`Screen::end_mask_watch`] found.
pub(crate) struct Watched {
    /// sudo's `pwfeedback` mask and its erasure, and nothing else.
    pub(crate) masked: bool,
    /// What was drawn, for the log.
    pub(crate) drawn: Drawn,
}

/// How [`Drawn`] and [`ScreenDiff`] name a thing the screen parsed: never its text.
impl std::fmt::Display for Seen {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Seen::Star => f.write_str("'*'")?,
            Seen::Space => f.write_str("' '")?,
            Seen::Text(n) => write!(f, "text({n})")?,
            Seen::Ctl(b) => match b {
                0x00 => f.write_str("NUL")?,
                0x07 => f.write_str("BEL")?,
                0x08 => f.write_str("BS")?,
                b'\t' => f.write_str("HT")?,
                b'\n' => f.write_str("LF")?,
                0x0b => f.write_str("VT")?,
                0x0c => f.write_str("FF")?,
                b'\r' => f.write_str("CR")?,
                0x7f => f.write_str("DEL")?,
                b => write!(f, "0x{b:02x}")?,
            },
            Seen::Esc(bytes) => {
                f.write_str("ESC")?;
                for (i, &b) in bytes.iter().enumerate() {
                    // Intermediates, then a final byte only if it's a command a terminal
                    // knows (a letter could be text).
                    let shown = (0x20..=0x2f).contains(&b)
                        || (i == 0 && b"78DEHMNOZc=>\\".contains(&b))
                        || (i > 0 && b"0AB<>=".contains(&b));
                    write!(f, "{}", if shown { char::from(b) } else { '?' })?;
                }
            }
            Seen::Csi(params, fin) => {
                f.write_str("CSI[")?;
                match params {
                    // A CSI's parameters are only the bytes between `ESC [` and its final byte
                    // (0x20 to 0x3f); a string's contents (an OSC's title, palette or link) never
                    // reach them. Shown only when they're digits and `;` after an optional `?`.
                    Some(p) if params_shown(p) => {
                        for &b in &p[..p.len().min(SEEN_PARAMS)] {
                            write!(f, "{}", char::from(b))?;
                        }
                        if p.len() > SEEN_PARAMS {
                            f.write_str("…")?;
                        }
                    }
                    Some(p) => write!(f, "params({})", p.len())?,
                    None => f.write_str("…")?,
                }
                match fin {
                    Some(b) if csi_shown(params.as_deref().unwrap_or(b"x"), *b) => write!(f, "{}", char::from(*b))?,
                    Some(_) => f.write_str("?")?,
                    None => f.write_str("(cut)")?,
                }
            }
            Seen::Str(open, n) => {
                let name = match open {
                    b']' => "OSC",
                    b'P' => "DCS",
                    b'_' => "APC",
                    b'^' => "PM",
                    _ => "SOS",
                };
                write!(f, "{name}({n})")?
            }
            Seen::Resize => f.write_str("resize")?,
            Seen::Stray => f.write_str("stray UTF-8 byte")?,
            Seen::Width(0) => f.write_str("zero-width character")?,
            Seen::Width(_) => f.write_str("wide character")?,
            Seen::Palette => f.write_str("palette change")?,
        }
        Ok(())
    }
}

impl std::fmt::Display for Drawn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.seen.is_empty() {
            f.write_str("nothing")?;
        }
        for (i, seen) in self.seen.iter().enumerate() {
            if i > 0 {
                f.write_str(" ")?;
            }
            write!(f, "{seen}")?;
        }
        if self.more > 0 {
            write!(f, " and {} more", self.more)?;
        }
        if let Some(((r0, c0), (r1, c1))) = self.moved {
            write!(f, "; the cursor moved from {r0}:{c0} to {r1}:{c1}")?;
        }
        if self.line_changed {
            f.write_str("; the line changed")?;
        }
        if self.elsewhere_changed {
            f.write_str("; another line changed")?;
        }
        if self.unmodelled {
            f.write_str("; something roster's screen doesn't model")?;
        }
        Ok(())
    }
}

impl Screen {
    pub(crate) fn new(rows: u16, cols: u16) -> Self {
        let (rows, cols) = (usize::from(rows.max(1)), usize::from(cols.max(1)));
        Screen {
            rows,
            cols,
            grid: vec![vec![BLANK; cols]; rows],
            row: 0,
            col: 0,
            pending_wrap: false,
            saved_main: Saved::default(),
            saved_alt: None,
            scrolls: 0,
            main: None,
            parse: Parse::Ground,
            csi: Vec::new(),
            csi_long: false,
            inter: 0,
            style: Style::DEFAULT,
            utf8: None,
            fed: 0,
            esc_at: u64::MAX,
            ed2_end: u64::MAX - 1,
            str_open: 0,
            osc_head: Vec::new(),
            resizes: 0,
            odd: 0,
            odd_seen: std::collections::VecDeque::new(),
            mask: None,
            osc: None,
            c1: false,
            own: OwnMarks::default(),
        }
    }

    /// Follows the shell marks that carry `token` (roster's hooks' `roster=TOKEN`, decision Q131
    /// (a)) from here on: [`Screen::own_run`] (ticket 162).
    pub(crate) fn follow_marks(&mut self, token: &str) {
        self.own = OwnMarks {
            param: Some(format!("roster={token}").into_bytes()),
            ..OwnMarks::default()
        };
    }

    /// While the last of the Session's own shell's marks is a `C` (a command it started still
    /// runs), which of its commands that is: 1 for the first. None otherwise, or with no token to
    /// follow (ticket 162).
    pub(crate) fn own_run(&self) -> Option<u64> {
        let own = &self.own;
        (own.param.is_some() && own.last == Some(b'C')).then_some(own.runs)
    }

    /// An OSC ended (BEL, ST, or an ESC, as xterm.js ends one): a shell mark with the Session's
    /// token counts (ticket 162). Its id is read as xterm.js reads it: digits up to the first `;`
    /// (`0133` is 133), anything else and it's no OSC at all.
    fn osc_end(&mut self) {
        let Some(body) = self.osc.take() else { return };
        let Some(param) = &self.own.param else { return };
        let (id, payload) = match body.iter().position(|&b| b == b';') {
            Some(at) => (&body[..at], &body[at + 1..]),
            None => (&body[..], &[][..]),
        };
        if id.is_empty() || !id.iter().all(u8::is_ascii_digit) {
            return;
        }
        let id = id
            .iter()
            .fold(0u32, |n, &d| n.saturating_mul(10).saturating_add(u32::from(d - b'0')));
        if id != 133 {
            return;
        }
        let mut fields = payload.split(|&b| b == b';');
        let kind = fields.next().unwrap_or_default();
        if fields.any(|f| f == param.as_slice()) {
            if kind == b"C" {
                self.own.runs += 1;
            }
            self.own.last = Some(if kind.len() == 1 { kind[0] } else { 0 });
        }
    }

    /// A C1 control (U+0080 to U+009F, `0xC2` then `b`), in the text or a string, as xterm.js
    /// takes it anywhere: ST ends a string (an OSC as a whole one), the CSI, OSC, DCS and SOS, PM
    /// and APC introducers start one (ending any string unfinished), IND and NEL move the cursor,
    /// and the rest end any sequence (the review of #308, #4).
    fn c1_control(&mut self, b: u8) {
        self.not_mask();
        self.saw(Seen::Ctl(b));
        if self.parse == Parse::Str && b == 0x9c {
            self.str_end();
        }
        self.osc = None;
        self.parse = Parse::Ground;
        match b {
            0x9b => {
                self.parse = Parse::Csi;
                self.csi.clear();
                self.csi_long = false;
            }
            0x9d => self.str_start(b']'),
            0x90 => self.str_start(b'P'),
            0x98 => self.str_start(b'X'),
            0x9e => self.str_start(b'^'),
            0x9f => self.str_start(b'_'),
            0x84 => {
                self.pending_wrap = false;
                self.line_feed();
            }
            0x85 => {
                self.pending_wrap = false;
                self.col = 0;
                self.line_feed();
            }
            0x9c => {}
            // Tab sets and the rest: not modelled.
            _ => self.odd(Seen::Ctl(b)),
        }
    }

    /// An OSC, DCS, SOS, PM or APC string starts (`open` is its letter after ESC).
    fn str_start(&mut self, open: u8) {
        self.parse = Parse::Str;
        self.str_open = open;
        self.osc_head.clear();
        self.osc = (open == b']' && self.own.param.is_some()).then(Vec::new);
    }

    /// A string ended as xterm.js ends one (an OSC at BEL, any at ST or ESC): a shell mark
    /// counts (ticket 162), and an OSC that changes the palette (OSC 4, 5, 10 to 19, 104, 105,
    /// 110 to 119), which changes what every cell in those colours looks like, isn't modelled
    /// (the review of #318).
    fn str_end(&mut self) {
        self.osc_end();
        if self.str_open != b']' {
            return;
        }
        let head = std::mem::take(&mut self.osc_head);
        let id = head.split(|&b| b == b';').next().unwrap_or_default();
        let palette = !id.is_empty()
            && id.iter().all(u8::is_ascii_digit)
            && id
                .iter()
                .try_fold(0u32, |n, &d| n.checked_mul(10)?.checked_add(u32::from(d - b'0')))
                .is_none_or(|n| matches!(n, 4 | 5 | 10..=19 | 104 | 105 | 110..=119));
        if palette {
            self.odd(Seen::Palette);
        }
    }

    /// Notes something this screen doesn't model (the review of #299, #5), keeping the last
    /// [`ODD_KEPT`] for the log (ticket 155c).
    fn odd(&mut self, seen: Seen) {
        self.odd += 1;
        if self.odd_seen.len() == ODD_KEPT {
            self.odd_seen.pop_front();
        }
        self.odd_seen.push_back((self.odd, seen));
    }

    /// The whole screen and the cursor as they are now (ticket 155).
    pub(crate) fn snapshot(&self) -> Snapshot {
        Snapshot {
            rows: self.rows,
            cols: self.cols,
            grid: self.grid.clone(),
            row: self.row,
            col: self.col,
            pending_wrap: self.pending_wrap,
            alternate: self.main.is_some(),
            resizes: self.resizes,
            odd: self.odd,
            wide: self.wide(),
        }
    }

    /// Whether a character xterm.js gives other than one column is on the screen: this screen
    /// gives each one cell, so where it is, columns after it don't line up with xterm.js's (the
    /// review of #318).
    fn wide(&self) -> bool {
        self.grid.iter().flatten().any(|c| c.byte() >= 0x80 && c.width() != 1)
    }

    fn compare(&self, at: &Snapshot) -> Compared {
        let dims = (self.rows, self.cols, self.main.is_some()) == (at.rows, at.cols, at.alternate);
        let odd = self.odd != at.odd;
        Compared {
            shape: dims && !odd && self.resizes == at.resizes && !at.wide && !self.wide(),
            odd,
            cursor: (self.row, self.col, self.pending_wrap) == (at.row, at.col, at.pending_wrap),
            prompt_row: dims && self.grid.get(at.row) == at.grid.get(at.row),
            others: dims
                && self
                    .grid
                    .iter()
                    .zip(&at.grid)
                    .enumerate()
                    .all(|(i, (now, was))| i == at.row || now == was),
        }
    }

    /// Whether the screen shows exactly what it did at `shot`, every cell's whole character and
    /// style, with the cursor (row, column, pending wrap) where it was, on the same screen (main
    /// or alternate) of the same size, with no resize (even one put back) and nothing this screen
    /// doesn't model since (ticket 155; the review of #299, #5 and #6): output since was at most a
    /// repaint of the same content.
    pub(crate) fn matches(&self, shot: &Snapshot) -> bool {
        let c = self.compare(shot);
        c.shape && c.cursor && c.prompt_row && c.others
    }

    /// What differs between the screen now and `shot`, for the log (ticket 155c): never text.
    pub(crate) fn diff(&self, shot: &Snapshot) -> ScreenDiff {
        let at = |r: usize, c: usize, w: bool| (r + 1, c + 1, w);
        let was = at(shot.row, shot.col, shot.pending_wrap);
        let now = at(self.row, self.col, self.pending_wrap);
        let size = ((shot.rows, shot.cols), (self.rows, self.cols));
        let mut d = ScreenDiff {
            cursor: (was != now).then_some((was, now)),
            size: (size.0 != size.1).then_some(size),
            resizes: self.resizes - shot.resizes,
            alternate: (self.main.is_some() != shot.alternate).then_some(self.main.is_some()),
            wide: shot.wide || self.wide(),
            ..ScreenDiff::default()
        };
        // Rows only on the same screen of the same size.
        if d.size.is_none() && d.alternate.is_none() {
            for (i, (now, was)) in self.grid.iter().zip(&shot.grid).enumerate() {
                let changed: Vec<usize> = (0..now.len()).filter(|&c| now[c] != was[c]).collect();
                let (Some(&first), Some(&last)) = (changed.first(), changed.last()) else {
                    continue;
                };
                if d.rows.len() == DIFF_ROWS {
                    d.rows_more += 1;
                    continue;
                }
                let styles_only = changed
                    .iter()
                    .all(|&c| now[c].ch == was[c].ch)
                    .then(|| style_change(was[first].style, now[first].style));
                d.rows.push(RowDiff {
                    row: i + 1,
                    cols: (first + 1, last + 1),
                    styles_only,
                });
            }
        }
        d.odd = self
            .odd_seen
            .iter()
            .filter(|(n, _)| *n > shot.odd)
            .map(|(_, seen)| seen.clone())
            .collect();
        d.odd_more = (self.odd - shot.odd).saturating_sub(d.odd.len() as u64);
        d
    }

    /// Whether the screen was resized since `shot`, even back to its size (the review of #299, #6).
    pub(crate) fn resized_since(&self, shot: &Snapshot) -> bool {
        self.resizes != shot.resizes
    }

    /// Whether a mask watch is on (tests: a fill leaves none behind, ticket 162).
    #[cfg(test)]
    pub(crate) fn watching_mask(&self) -> bool {
        self.mask.is_some()
    }

    /// Stops the mask watch, if one is on, noting nothing (the review of #299, #8: a fill that
    /// ends any way ends its watch).
    pub(crate) fn stop_mask_watch(&mut self) {
        self.mask = None;
    }

    /// Starts noting what the output draws from here on, with the screen and the cursor as they
    /// are now: a fill does this as it types its probe (ticket 154).
    pub(crate) fn watch_mask(&mut self) {
        self.mask = Some(MaskWatch {
            at: self.snapshot(),
            stars: 0,
            other: false,
            seen: Vec::new(),
            more: 0,
            last: None,
        });
    }

    /// Stops noting, and says whether everything since [`Screen::watch_mask`] was at most `stars`
    /// `*`s and any spaces drawn, cursor moves (`BS`, `CR`, CSI `A`-`H`, `a`, `d`, `e`, `f` and the backtick), erases within the
    /// line (CSI `K`, `X`) and the cursor's hide and show (CSI `?25l`, `?25h`), with nothing else
    /// at all, and left the cursor where it was on a screen that's exactly as it was, every line
    /// of it (ticket 155: not only the cursor's): sudo's `pwfeedback` mask for the probe and its
    /// erasure, however a terminal (ConPTY) redraws it. [`Watched::drawn`] says what it saw, for
    /// the log.
    pub(crate) fn end_mask_watch(&mut self, stars: usize) -> Watched {
        let Some(w) = self.mask.take() else {
            return Watched {
                masked: false,
                drawn: Drawn::default(),
            };
        };
        let at = &w.at;
        let c = self.compare(at);
        Watched {
            masked: !w.other && w.stars <= stars && c.shape && c.cursor && c.prompt_row && c.others,
            drawn: Drawn {
                moved: (!c.cursor).then_some(((at.row + 1, at.col + 1), (self.row + 1, self.col + 1))),
                // The prompt's own line, wherever the cursor went.
                line_changed: !c.prompt_row,
                elsewhere_changed: !c.others,
                unmodelled: c.odd,
                seen: w.seen,
                more: w.more,
                before: 0,
                why: Why::Probe,
            },
        }
    }

    /// Whether, so far, the mask watch has seen at most `stars` `*`s and otherwise only what it
    /// allows, on a screen of the same size with every line but the prompt's as it was and the
    /// cursor on the prompt's line: sudo's mask for the probe's letter, before it's taken back
    /// (ticket 155, decision Q151 (h)). The caller checks the prompt's line itself.
    pub(crate) fn mask_pending(&self, stars: usize) -> bool {
        let Some(w) = &self.mask else { return false };
        let c = self.compare(&w.at);
        !w.other && w.stars <= stars && c.shape && c.others && self.row == w.at.row
    }

    /// Notes something the watch saw (ticket 155), unless it has seen [`SEEN_MAX`] things.
    fn saw(&mut self, seen: Seen) {
        let Some(w) = &mut self.mask else { return };
        w.last = Some(match seen {
            Seen::Text(_) => Kind::Text,
            Seen::Str(..) => Kind::Str,
            Seen::Esc(_) => Kind::Esc,
            _ => Kind::Other,
        });
        if w.seen.len() < SEEN_MAX {
            w.seen.push(seen);
        } else {
            w.more += 1;
        }
    }

    /// Adds to the last thing seen when it's a `kind` (a run of text, a string's length, an escape
    /// sequence's bytes); returns whether it was. Past [`SEEN_MAX`] there's nothing to add to.
    fn saw_more(&mut self, kind: Kind, b: u8) -> bool {
        let Some(w) = &mut self.mask else { return true };
        if w.last != Some(kind) {
            return false;
        }
        if w.more == 0 {
            match w.seen.last_mut() {
                Some(Seen::Text(n) | Seen::Str(_, n)) => *n += 1,
                Some(Seen::Esc(bytes)) if bytes.len() < 4 => bytes.push(b),
                _ => {}
            }
        }
        true
    }

    /// Notes a printed byte other than `*` and space: a character, or the rest of one (UTF-8).
    fn saw_text(&mut self, b: u8) {
        if (0x80..0xc0).contains(&b) {
            if self.mask.as_ref().is_some_and(|w| w.last == Some(Kind::Text)) {
                return;
            }
        } else if self.saw_more(Kind::Text, b) {
            return;
        }
        self.saw(Seen::Text(1));
    }

    /// Notes something the mask watch doesn't allow.
    fn not_mask(&mut self) {
        if let Some(w) = &mut self.mask {
            w.other = true;
        }
    }

    /// Whether the cursor's whole line, read as [`Screen::cursor_after`] reads it, is `text`
    /// and nothing else (ticket 154).
    pub(crate) fn line_is(&self, text: &str) -> bool {
        let needle = squash(text.bytes().filter(|b| !(0x80..0xc0).contains(b)));
        let needle = needle.trim_ascii();
        !needle.is_empty() && squash(self.grid[self.row].iter().map(|c| c.byte())).trim_ascii() == needle
    }

    /// The terminal was resized: the cursor's row stays on screen, cells beyond the new width go.
    pub(crate) fn resize(&mut self, rows: u16, cols: u16) {
        self.not_mask();
        self.saw(Seen::Resize);
        self.resizes += 1;
        let (rows, cols) = (usize::from(rows.max(1)), usize::from(cols.max(1)));
        let fit = |grid: &mut Vec<Vec<Cell>>, row: &mut usize| {
            if *row >= rows {
                grid.drain(..*row + 1 - rows);
                *row = rows - 1;
            }
            grid.truncate(rows);
            grid.resize(rows, vec![BLANK; cols]);
            for line in grid.iter_mut() {
                line.resize(cols, BLANK);
            }
        };
        fit(&mut self.grid, &mut self.row);
        if let Some(grid) = &mut self.main {
            // Its own cursor isn't kept; a resize never matches anyway.
            let mut row = self.row;
            fit(grid, &mut row);
        }
        self.rows = rows;
        self.cols = cols;
        self.col = self.col.min(cols - 1);
        self.pending_wrap = false;
    }

    /// Takes in a chunk of the Session's output.
    pub(crate) fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.byte(b);
        }
    }

    /// Whether the cursor's line, up to the cursor, ends with `text` (both read with every run of
    /// whitespace as one space, trailing whitespace not counting) and nothing is drawn after the
    /// cursor on it: the cursor sits right after `text`, as at a prompt. An empty `text` never does.
    pub(crate) fn cursor_after(&self, text: &str) -> bool {
        let needle = squash(text.bytes().filter(|b| !(0x80..0xc0).contains(b)));
        let needle = needle.trim_ascii();
        if needle.is_empty() {
            return false;
        }
        let line = &self.grid[self.row];
        let end = if self.pending_wrap { self.cols } else { self.col };
        if line[end..].iter().any(|c| c.byte() != b' ') {
            return false;
        }
        squash(line[..end].iter().map(|c| c.byte()))
            .trim_ascii_end()
            .ends_with(needle)
    }

    fn byte(&mut self, b: u8) {
        self.fed += 1;
        if self.c1 {
            self.c1 = false;
            if (0x80..=0x9f).contains(&b) {
                if self.utf8.take().is_some() {
                    self.odd(Seen::Stray);
                }
                self.c1_control(b);
                return;
            }
            // The first byte of a character: drawn, or kept in the string, as it would have been.
            match self.parse {
                Parse::Ground => self.ground_char(0xc2),
                Parse::Str => self.str_char(0xc2),
                _ => {}
            }
        }
        // A UTF-8 character cut short isn't modelled (the review of #318, #7).
        if self.utf8.is_some() && !(self.parse == Parse::Ground && (0x80..0xc0).contains(&b)) {
            self.utf8 = None;
            self.odd(Seen::Stray);
        }
        match self.parse {
            Parse::Ground => self.ground(b),
            Parse::Esc => self.esc(b),
            Parse::Csi => {
                if (0x40..=0x7e).contains(&b) {
                    self.parse = Parse::Ground;
                    if self.mask.is_some() {
                        let params = (!self.csi_long).then(|| self.csi.clone());
                        self.saw(Seen::Csi(params, Some(b)));
                    }
                    if !self.csi_long {
                        self.csi_exec(b);
                    } else {
                        // A terminal acts on it: not modelled (ticket 155c).
                        self.not_mask();
                        self.odd(Seen::Csi(None, Some(b)));
                    }
                } else if b == 0x1b {
                    self.not_mask();
                    if self.mask.is_some() {
                        let params = (!self.csi_long).then(|| self.csi.clone());
                        self.saw(Seen::Csi(params, None));
                    }
                    self.parse = Parse::Esc;
                } else if (0x20..=0x3f).contains(&b) {
                    if self.csi.len() < CSI_MAX {
                        self.csi.push(b);
                    } else {
                        self.csi_long = true;
                    }
                } else if b == 0x18 || b == 0x1a {
                    // CAN and SUB abort it (xterm.js).
                    self.not_mask();
                    self.saw(Seen::Ctl(b));
                    self.parse = Parse::Ground;
                } else if b < 0x20 {
                    // A control inside the sequence: xterm.js acts on it there.
                    self.control(b);
                } else if b != 0x7f {
                    // Past ASCII inside a sequence: not modelled.
                    self.not_mask();
                    self.saw(Seen::Ctl(b));
                    self.odd(Seen::Ctl(b));
                }
            }
            Parse::Str => {
                if b == 0x07 && self.str_open == b']' {
                    // BEL ends an OSC; xterm.js ignores it in the other strings.
                    self.parse = Parse::Ground;
                    self.str_end();
                } else if b == 0x1b {
                    // A terminal (xterm.js) ends the string here, whatever follows the ESC.
                    self.parse = Parse::StrEsc;
                    self.str_end();
                } else if b == 0x18 || b == 0x1a {
                    // CAN and SUB abort it, and what follows is text again (xterm.js).
                    self.osc = None;
                    self.parse = Parse::Ground;
                    self.saw_more(Kind::Str, b);
                } else if b == 0xc2 {
                    self.c1 = true;
                } else {
                    self.str_char(b);
                }
            }
            Parse::StrEsc => {
                if b == b'\\' {
                    self.parse = Parse::Ground;
                } else {
                    self.esc(b);
                }
            }
            Parse::Inter => {
                if b != 0x1b {
                    self.saw_more(Kind::Esc, b);
                }
                if !(0x20..=0x2f).contains(&b) {
                    self.parse = if b == 0x1b { Parse::Esc } else { Parse::Ground };
                    // The alignment test and double-size lines (`ESC #`), any charset but ASCII,
                    // and a control inside (xterm.js acts on it and goes on): not modelled.
                    if self.inter == b'#' || (b"()*+-./".contains(&self.inter) && b != b'B') || (b < 0x20 && b != 0x1b)
                    {
                        self.odd(Seen::Esc(vec![self.inter, b]));
                    }
                }
            }
        }
    }

    /// A byte of a string's contents: an OSC that may be a mark keeps it, but the C0 controls
    /// xterm.js ignores there; an OSC's first bytes are kept for its id.
    fn str_char(&mut self, b: u8) {
        if let Some(osc) = &mut self.osc {
            if osc.len() >= OSC_MAX {
                self.osc = None;
            } else if b >= 0x20 {
                osc.push(b);
            }
        }
        if self.str_open == b']' && b >= 0x20 && self.osc_head.len() < 16 {
            self.osc_head.push(b);
        }
        self.saw_more(Kind::Str, b);
    }

    fn ground(&mut self, b: u8) {
        if b == 0xc2 {
            // Maybe a C1 control: the next byte says.
            self.c1 = true;
            return;
        }
        self.ground_char(b);
    }

    fn ground_char(&mut self, b: u8) {
        if self.mask.is_some() {
            match b {
                b'*' => {
                    if let Some(w) = &mut self.mask {
                        w.stars += 1;
                    }
                    self.saw(Seen::Star);
                }
                // A space draws a blank: how sudo takes a `*` back.
                b' ' => self.saw(Seen::Space),
                // Controls note themselves.
                0x00..=0x1f | 0x7f => {}
                _ => {
                    self.not_mask();
                    self.saw_text(b);
                }
            }
        }
        match b {
            0x1b => {
                self.parse = Parse::Esc;
                self.esc_at = self.fed - 1;
            }
            0x00..=0x1f | 0x7f => self.control(b),
            0x80..=0xbf => self.utf8_more(b),
            0xc2..=0xf4 => {
                let need = if b < 0xe0 {
                    2
                } else if b < 0xf0 {
                    3
                } else {
                    4
                };
                self.utf8 = Some(([b, 0, 0, 0], 1, need));
            }
            // Never in UTF-8: not modelled.
            0xc0 | 0xc1 | 0xf5..=0xff => self.odd(Seen::Stray),
            _ => self.put([b, 0, 0, 0], u32::from(b)),
        }
    }

    /// A C0 control, as xterm.js acts on it, in the text or inside a CSI.
    fn control(&mut self, b: u8) {
        if self.mask.is_some() {
            if !(b == b'\r' || b == 0x08) {
                self.not_mask();
            }
            self.saw(Seen::Ctl(b));
        }
        match b {
            b'\r' => {
                self.col = 0;
                self.pending_wrap = false;
            }
            b'\n' | 0x0b | 0x0c => {
                self.pending_wrap = false;
                self.line_feed();
            }
            0x08 => {
                self.pending_wrap = false;
                self.col = self.col.saturating_sub(1);
            }
            // Past the last column (a wrap pending), xterm.js's tab does nothing.
            b'\t' if !self.pending_wrap => self.col = ((self.col / 8 + 1) * 8).min(self.cols - 1),
            // Shift Out and In switch charsets: not modelled.
            0x0e | 0x0f => self.odd(Seen::Ctl(b)),
            _ => {}
        }
    }

    /// The next byte of a UTF-8 character; when it's whole, it's drawn. A stray byte, or a
    /// character UTF-8 doesn't allow (overlong, a surrogate, past U+10FFFF), isn't modelled.
    fn utf8_more(&mut self, b: u8) {
        let Some((mut ch, n, need)) = self.utf8.take() else {
            self.odd(Seen::Stray);
            return;
        };
        ch[n] = b;
        if n + 1 < need {
            self.utf8 = Some((ch, n + 1, need));
            return;
        }
        match std::str::from_utf8(&ch[..need]).ok().and_then(|s| s.chars().next()) {
            Some(c) => self.put(ch, u32::from(c)),
            None => self.odd(Seen::Stray),
        }
    }

    fn esc(&mut self, b: u8) {
        self.parse = Parse::Ground;
        if b != b'[' {
            self.not_mask();
        }
        if self.mask.is_some() {
            match b {
                // Its CSI is noted whole, at its end.
                b'[' => {}
                b']' | b'P' | b'_' | b'^' | b'X' => self.saw(Seen::Str(b, 0)),
                0x1b => self.saw(Seen::Esc(Vec::new())),
                _ => self.saw(Seen::Esc(vec![b])),
            }
        }
        match b {
            b'[' => {
                self.parse = Parse::Csi;
                self.csi.clear();
                self.csi_long = false;
            }
            b']' | b'P' | b'_' | b'^' | b'X' => self.str_start(b),
            0x20..=0x2f => {
                self.parse = Parse::Inter;
                self.inter = b;
            }
            0x1b => self.parse = Parse::Esc,
            b'7' => self.save(),
            b'8' => self.restore(),
            b'D' => {
                self.pending_wrap = false;
                self.line_feed();
            }
            b'E' => {
                self.pending_wrap = false;
                self.col = 0;
                self.line_feed();
            }
            b'M' => {
                self.pending_wrap = false;
                if self.row == 0 {
                    let blank = self.blank();
                    self.grid.pop();
                    self.grid.insert(0, vec![blank; self.cols]);
                } else {
                    self.row -= 1;
                }
            }
            b'c' => {
                let (resizes, odd) = (self.resizes, self.odd);
                let own = std::mem::take(&mut self.own);
                let odd_seen = std::mem::take(&mut self.odd_seen);
                let fed = self.fed;
                *self = Screen::new(self.rows as u16, self.cols as u16);
                (self.resizes, self.odd, self.own, self.odd_seen, self.fed) = (resizes, odd, own, odd_seen, fed);
                self.odd(Seen::Esc(vec![b'c']));
            }
            // The keypad modes and a string's end draw nothing.
            b'=' | b'>' | b'\\' => {}
            // Tab sets, single shifts and the rest: not modelled.
            _ => self.odd(Seen::Esc(vec![b])),
        }
    }

    /// Draws a whole character (`ch`, its UTF-8 bytes; `c`, its code point) at the cursor.
    /// xterm.js gives a few characters other than one column; this screen gives each one cell, so
    /// such a character isn't modelled (the review of #318).
    fn put(&mut self, ch: [u8; 4], c: u32) {
        let width = crate::wcwidth::width(c);
        if width != 1 {
            self.odd(Seen::Width(width));
        }
        if self.pending_wrap {
            self.pending_wrap = false;
            self.col = 0;
            self.line_feed();
        }
        // A space shows only what a blank does (ticket 155c).
        let style = if ch == [b' ', 0, 0, 0] {
            self.style.on_blank()
        } else {
            self.style
        };
        self.grid[self.row][self.col] = Cell { ch, style };
        if self.col + 1 == self.cols {
            self.pending_wrap = true;
        } else {
            self.col += 1;
        }
    }

    /// A cell an erase leaves: blank, in the current background alone (as xterm.js erases;
    /// ticket 155c).
    fn blank(&self) -> Cell {
        Cell {
            ch: [b' ', 0, 0, 0],
            style: self.style.erased(),
        }
    }

    /// SGR: the style from here on (the review of #299, #5), read as xterm.js reads it
    /// (`charAttributes`, ticket 155c and the review of #318): a parameter's sub-parameters
    /// (after `:`) count only for an underline (`4:3`, an empty or unknown kind single) and the
    /// colours. What xterm.js reads otherwise or ignores (an unknown attribute, sub-parameters
    /// elsewhere, a colour's form it reads otherwise, out of range or cut short) isn't modelled.
    fn sgr(&mut self) {
        // Each parameter's sub-parameters: None when empty.
        let mut bad = false;
        let params: Vec<Vec<Option<u32>>> = self
            .csi
            .split(|&c| c == b';')
            .map(|p| {
                p.split(|&c| c == b':')
                    .map(|q| {
                        if q.is_empty() {
                            return None;
                        }
                        let n = std::str::from_utf8(q).ok().and_then(|q| q.parse::<u32>().ok());
                        bad |= n.is_none();
                        n
                    })
                    .collect()
            })
            .collect();
        let mut style = self.style;
        let mut i = 0;
        while i < params.len() && !bad {
            let p = &params[i];
            let code = p[0].unwrap_or(0);
            let subs = &p[1..];
            if !subs.is_empty() && !matches!(code, 4 | 38 | 48 | 58) {
                bad = true;
                break;
            }
            let flag = |style: &mut Style, f: u16, on: bool| {
                if on {
                    style.flags |= f;
                } else {
                    style.flags &= !f;
                }
            };
            match code {
                0 => style = Style::DEFAULT,
                1 => flag(&mut style, BOLD, true),
                2 => flag(&mut style, FAINT, true),
                3 => flag(&mut style, ITALIC, true),
                4 => {
                    style.underline = match subs.first() {
                        None | Some(None) => 1,
                        Some(Some(n)) if *n > 5 => 1,
                        Some(Some(n)) => *n as u8,
                    }
                }
                5 => flag(&mut style, BLINK, true),
                7 => flag(&mut style, REVERSE, true),
                8 => flag(&mut style, HIDDEN, true),
                9 => flag(&mut style, STRIKE, true),
                21 => style.underline = 2,
                22 => flag(&mut style, BOLD | FAINT, false),
                23 => flag(&mut style, ITALIC, false),
                24 => style.underline = 0,
                25 => flag(&mut style, BLINK, false),
                27 => flag(&mut style, REVERSE, false),
                28 => flag(&mut style, HIDDEN, false),
                29 => flag(&mut style, STRIKE, false),
                53 => flag(&mut style, OVERLINE, true),
                55 => flag(&mut style, OVERLINE, false),
                30..=37 | 90..=97 => style.fg = Colour::Code(code as u8),
                40..=47 | 100..=107 => style.bg = Colour::Code(code as u8),
                39 => style.fg = Colour::Default,
                49 => style.bg = Colour::Default,
                59 => style.ul = Colour::Default,
                38 | 48 | 58 => {
                    // xterm.js's `_extractColor`, only where its reading is plain: `38;5;N`,
                    // `38;2;R;G;B`, `38:5:N` and `38:2:CS:R:G:B` (the colour space ignored, empty
                    // or not). `38:2:R:G:B` it reads as R the colour space: not modelled.
                    let byte = |n: Option<u32>| n.and_then(|n| u8::try_from(n).ok());
                    let colour = if subs.is_empty() {
                        let next = |k: usize| match params.get(i + k).map(Vec::as_slice) {
                            Some([n]) => byte(*n),
                            _ => None,
                        };
                        match params.get(i + 1).map(Vec::as_slice) {
                            Some([Some(5)]) => next(2).map(|n| (Colour::P256(n), 2)),
                            Some([Some(2)]) => match (next(2), next(3), next(4)) {
                                (Some(r), Some(g), Some(b)) => Some((Colour::Rgb(r, g, b), 4)),
                                _ => None,
                            },
                            _ => None,
                        }
                    } else {
                        match subs {
                            [Some(5), n] => byte(*n).map(|n| (Colour::P256(n), 0)),
                            [Some(2), _, r, g, b] => match (byte(*r), byte(*g), byte(*b)) {
                                (Some(r), Some(g), Some(b)) => Some((Colour::Rgb(r, g, b), 0)),
                                _ => None,
                            },
                            _ => None,
                        }
                    };
                    match colour {
                        Some((colour, take)) => {
                            match code {
                                38 => style.fg = colour,
                                48 => style.bg = colour,
                                _ => style.ul = colour,
                            }
                            i += take;
                        }
                        None => bad = true,
                    }
                }
                _ => bad = true,
            }
            i += 1;
        }
        if bad {
            let params = self.csi.clone();
            self.odd(Seen::Csi(Some(params), Some(b'm')));
        }
        self.style = style;
    }

    fn line_feed(&mut self) {
        if self.row + 1 == self.rows {
            let blank = self.blank();
            self.grid.remove(0);
            self.grid.push(vec![blank; self.cols]);
            if self.main.is_none() {
                self.scrolls += 1;
            }
        } else {
            self.row += 1;
        }
    }

    /// DECSC (`ESC 7`, `CSI s`): the cursor and the style, saved for the screen that's up.
    fn save(&mut self) {
        let saved = Saved {
            row: self.row,
            col: self.col,
            style: self.style,
            scrolls: self.scrolls,
        };
        if self.main.is_some() {
            self.saved_alt = Some(saved);
        } else {
            self.saved_main = saved;
        }
    }

    /// DECRC (`ESC 8`, `CSI u`), as xterm.js restores: the cursor (back in the last column) and
    /// the colours and flags. Not modelled: a restore on the main screen after it scrolled (xterm.js
    /// counts from its scrollback's top), one on the alternate screen of what this screen didn't
    /// see saved there, and an underline or its colour in either style (xterm.js keeps the kind
    /// and colour set now).
    fn restore(&mut self) {
        self.pending_wrap = false;
        let saved = match self.main {
            Some(_) => self.saved_alt,
            None => Some(self.saved_main).filter(|s| s.scrolls == self.scrolls),
        };
        let lined = |s: Style| s.underline != 0 || s.ul != Colour::Default;
        match saved {
            Some(s) if !lined(s.style) && !lined(self.style) => {
                self.row = s.row.min(self.rows - 1);
                self.col = s.col.min(self.cols - 1);
                self.style = s.style;
            }
            _ => self.odd(Seen::Esc(vec![b'8'])),
        }
    }

    fn csi_exec(&mut self, fin: u8) {
        if self.mask.is_some() && !self.csi_draws_nothing(fin) {
            self.not_mask();
        }
        // Reports, device attributes, window ops and the cursor's shape and protection draw
        // nothing, in any form.
        if matches!(fin, b'n' | b'c' | b't' | b'q') {
            return;
        }
        let (marker, body) = match self.csi.split_first() {
            Some((&m, rest)) if b"<=>?".contains(&m) => (Some(m), rest),
            _ => (None, &self.csi[..]),
        };
        // Parameters as xterm.js keeps them: at most 32, and 32 sub-parameters; sub-parameters
        // (`:`) only in an SGR; numbers and `;` only, after a `?` only for a DEC mode. Anything
        // else xterm.js reads otherwise or not at all: not modelled (the review of #318, #2, #5).
        let digits = |extra: u8| body.iter().all(|&c| c.is_ascii_digit() || c == b';' || c == extra);
        let plain = if fin == b'm' && marker.is_none() {
            digits(b':')
        } else {
            digits(b';')
        };
        let many = self.csi.split(|&c| c == b';').count() > 32 || self.csi.iter().filter(|&&c| c == b':').count() > 32;
        let marked_ok = marker.is_none() || (marker == Some(b'?') && matches!(fin, b'h' | b'l'));
        if !plain || many || !marked_ok {
            self.odd(Seen::Csi(Some(self.csi.clone()), Some(fin)));
            return;
        }
        let pending = self.pending_wrap;
        let blank = self.blank();
        let params: Vec<usize> = body
            .split(|&c| c == b';')
            .map(|p| {
                p.iter().filter(|c| c.is_ascii_digit()).fold(0usize, |n, &c| {
                    n.saturating_mul(10).saturating_add(usize::from(c - b'0'))
                })
            })
            .collect();
        let arg = |i: usize| params.get(i).copied().unwrap_or(0);
        let n = arg(0).max(1);
        let (rows, cols) = (self.rows, self.cols);
        // A cursor move, an insert or delete and DECRC put the cursor back in the last column;
        // an erase, SGR, a scroll, a mode and DECSC leave a pending wrap as it is (xterm.js).
        if b"ABCDEFGHadef`LMPX@u".contains(&fin) {
            self.pending_wrap = false;
        }
        // An erase to the end from past the last column (a wrap pending) erases nothing there.
        let from = if pending { cols } else { self.col };
        match fin {
            b'A' => self.row = self.row.saturating_sub(n),
            b'B' | b'e' => self.row = (self.row + n).min(rows - 1),
            b'C' | b'a' => self.col = (self.col + n).min(cols - 1),
            b'D' => self.col = self.col.saturating_sub(n),
            b'E' => (self.row, self.col) = ((self.row + n).min(rows - 1), 0),
            b'F' => (self.row, self.col) = (self.row.saturating_sub(n), 0),
            b'G' | b'`' => self.col = (n - 1).min(cols - 1),
            b'd' => self.row = (n - 1).min(rows - 1),
            b'H' | b'f' => {
                self.row = (arg(0).max(1) - 1).min(rows - 1);
                self.col = (arg(1).max(1) - 1).min(cols - 1);
            }
            b'J' => match arg(0) {
                0 => {
                    self.grid[self.row][from..].fill(blank);
                    for line in &mut self.grid[self.row + 1..] {
                        line.fill(blank);
                    }
                }
                1 => {
                    for line in &mut self.grid[..self.row] {
                        line.fill(blank);
                    }
                    self.grid[self.row][..=self.col].fill(blank);
                }
                2 => {
                    for line in &mut self.grid {
                        line.fill(blank);
                    }
                    self.ed2_end = self.fed;
                }
                // The scrollback cleared: right after `ESC[2J` (ConPTY's `cls`), the screen shows
                // what it did; anywhere else xterm.js may move what's shown: not modelled (the
                // review of #318, #6).
                3 if self.esc_at == self.ed2_end && self.main.is_none() => self.scrolls += 1,
                3 if self.esc_at == self.ed2_end => {}
                3 => self.odd(Seen::Csi(Some(self.csi.clone()), Some(fin))),
                // xterm.js does nothing for the rest.
                _ => {}
            },
            b'K' => {
                let line = &mut self.grid[self.row];
                match arg(0) {
                    0 => line[from..].fill(blank),
                    1 => line[..=self.col].fill(blank),
                    2 => line.fill(blank),
                    // xterm.js does nothing for the rest (the review of #318, #1).
                    _ => {}
                }
            }
            b'X' => {
                let end = (self.col + n).min(cols);
                self.grid[self.row][self.col..end].fill(blank);
            }
            b'P' => {
                let line = &mut self.grid[self.row];
                let n = n.min(cols - self.col);
                line.drain(self.col..self.col + n);
                line.resize(cols, blank);
            }
            b'@' => {
                let line = &mut self.grid[self.row];
                let n = n.min(cols - self.col);
                for _ in 0..n {
                    line.insert(self.col, blank);
                }
                line.truncate(cols);
            }
            // Lines inserted or deleted put the cursor at the line's start (xterm.js).
            b'L' => {
                for _ in 0..n.min(rows - self.row) {
                    self.grid.pop();
                    self.grid.insert(self.row, vec![blank; cols]);
                }
                self.col = 0;
            }
            b'M' => {
                for _ in 0..n.min(rows - self.row) {
                    self.grid.remove(self.row);
                    self.grid.push(vec![blank; cols]);
                }
                self.col = 0;
            }
            b'S' => {
                for _ in 0..n.min(rows) {
                    self.grid.remove(0);
                    self.grid.push(vec![blank; cols]);
                }
            }
            // xterm.js scrolls down in blank lines of the default style.
            b'T' => {
                for _ in 0..n.min(rows) {
                    self.grid.pop();
                    self.grid.insert(0, vec![BLANK; cols]);
                }
            }
            b's' if marker.is_none() => self.save(),
            b'u' if marker.is_none() => self.restore(),
            b'h' | b'l' if marker.is_some() => {
                let on = fin == b'h';
                for p in params {
                    match p {
                        // The alternate screen, as xterm.js does it: DECSC and in (filled with
                        // the erase's background), or out (the cursor where it was there) and
                        // DECRC.
                        1049 if on => {
                            self.save();
                            if self.main.is_none() {
                                let fill = vec![vec![self.blank(); cols]; rows];
                                self.main = Some(std::mem::replace(&mut self.grid, fill));
                                self.saved_alt = None;
                            }
                        }
                        1049 => {
                            if let Some(grid) = self.main.take() {
                                self.grid = grid;
                            }
                            self.restore();
                        }
                        // The other alternate screens and DECSC with them, 132 columns, reverse
                        // video, origin, wrap and reverse-wrap modes, side margins: not modelled.
                        3 | 5 | 6 | 7 | 45 | 47 | 69 | 1047 | 1048 => {
                            self.odd(Seen::Csi(Some(self.csi.clone()), Some(fin)));
                        }
                        _ => {}
                    }
                }
            }
            b'm' if marker.is_none() => self.sgr(),
            // Insert and newline modes, scroll regions, repeats, tab stops and the rest: not
            // modelled.
            _ => self.odd(Seen::Csi(Some(self.csi.clone()), Some(fin))),
        }
    }

    /// Whether a CSI is one sudo's mask may be redrawn with (ticket 154): a cursor move or an
    /// erase within the line with plain numeric parameters, or the cursor's hide or show.
    fn csi_draws_nothing(&self, fin: u8) -> bool {
        let plain = self.csi.iter().all(|&c| c.is_ascii_digit() || c == b';');
        match fin {
            b'A' | b'B' | b'C' | b'D' | b'E' | b'F' | b'G' | b'H' | b'a' | b'd' | b'e' | b'f' | b'`' | b'K' | b'X' => {
                plain
            }
            b'h' | b'l' => self.csi == b"?25",
            _ => false,
        }
    }
}

/// `bytes` with every run of whitespace (and control character) as one space.
fn squash(bytes: impl Iterator<Item = u8>) -> Vec<u8> {
    let mut out = Vec::new();
    for b in bytes {
        if b <= b' ' || b == 0x7f {
            if out.last() != Some(&b' ') {
                out.push(b' ');
            }
        } else {
            out.push(b);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(bytes: &[u8]) -> Screen {
        let mut s = Screen::new(24, 80);
        s.feed(bytes);
        s
    }

    /// The review of #308 (#4): the core takes as a mark exactly what xterm.js does, so its count
    /// and PromptWatch's agree: the same cases as prompt.test.ts, through both.
    #[test]
    fn own_marks_match_the_shared_cases() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/own-marks.json")).unwrap();
        let token = fixture["token"].as_str().unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let mut s = Screen::new(24, 80);
            s.follow_marks(token);
            for chunk in case["chunks"].as_array().unwrap() {
                s.feed(chunk.as_str().unwrap().as_bytes());
            }
            assert_eq!(s.own_run(), case["run"].as_u64(), "{}", case["name"]);
        }
    }

    /// Ticket 155c, the review of #318: the core's screen takes a repaint as the same screen only
    /// where xterm.js draws the same, on one shared table that repaints.test.ts runs through a
    /// real xterm.js.
    #[test]
    fn repaints_match_the_shared_cases() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/repaints.json")).unwrap();
        let mut wrong = Vec::new();
        for case in fixture["cases"].as_array().unwrap() {
            let mut s = Screen::new(24, 80);
            s.feed(case["before"].as_str().unwrap().as_bytes());
            let shot = s.snapshot();
            s.feed(case["after"].as_str().unwrap().as_bytes());
            if s.matches(&shot) != (case["kind"] == "same") {
                wrong.push(format!("{} ({})", case["name"], case["kind"]));
            }
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    /// Ticket 155c, the review of #318: the core's verdicts on random repaints are the ones
    /// recorded, which repaints.test.ts checks against a real xterm.js (wherever the core says
    /// "the same", xterm.js must show the same). After a change to this screen, regenerate them:
    /// `ROSTER_WRITE_REPAINT_FUZZ=1 cargo test -p roster-core --lib repaint_fuzz`.
    #[test]
    fn repaint_fuzz_verdicts_are_the_recorded_ones() {
        const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/repaint-fuzz.json");
        let mut fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(PATH).unwrap()).unwrap();
        let before = fixture["before"].as_str().unwrap().to_string();
        let mut differ = Vec::new();
        for case in fixture["cases"].as_array_mut().unwrap() {
            let mut s = Screen::new(24, 80);
            s.feed(before.as_bytes());
            let shot = s.snapshot();
            s.feed(case["after"].as_str().unwrap().as_bytes());
            let same = s.matches(&shot);
            if case["same"].as_bool() != Some(same) {
                differ.push(case["after"].clone());
                case["same"] = same.into();
            }
        }
        if std::env::var_os("ROSTER_WRITE_REPAINT_FUZZ").is_some() {
            std::fs::write(PATH, serde_json::to_string_pretty(&fixture).unwrap() + "\n").unwrap();
        } else {
            assert!(
                differ.is_empty(),
                "{} verdicts differ, first {:?}",
                differ.len(),
                differ.first()
            );
        }
    }

    /// The review of #318 (#9): styles are values, with no table to fill: a long true-colour
    /// session (more colours than any table roster kept) still compares a repaint as the same.
    #[test]
    fn a_long_true_colour_session_still_matches() {
        let mut s = Screen::new(24, 80);
        for i in 0..20_000u32 {
            s.feed(format!("\x1b[38;2;{};{};{}mx", i % 256, (i / 256) % 256, i % 7).as_bytes());
            if i % 80 == 79 {
                s.feed(b"\r\n");
            }
        }
        s.feed(b"\x1b[m\r\n[sudo] password for ops: ");
        let shot = s.snapshot();
        s.feed(b"\x1b[?25l\x1b[38;2;9;9;9m\x1b[30X\x1b[m\x1b[24;26H\x1b[?25h");
        assert!(s.matches(&shot), "{}", s.diff(&shot));
    }

    /// The review of #318 (#10): the log describes the styles the snapshot's cells had, after a
    /// full reset too.
    #[test]
    fn a_diff_names_the_snapshots_own_styles() {
        let mut s = screen(b"\x1b[H\x1b[92mx\x1b[m\x1b[1;2H");
        let shot = s.snapshot();
        s.feed(b"\x1bc\x1b[31mx\x1b[m\x1b[1;2H");
        assert_eq!(
            s.diff(&shot).to_string(),
            "row 1 styles only (column 1: fg 92 -> 31); unmodelled: ESCc"
        );
        let mut s = screen(b"\x1b[2;1H");
        let shot = s.snapshot();
        s.feed("\u{4e2d}\x1b[2;1H".as_bytes());
        assert_eq!(
            s.diff(&shot).to_string(),
            "a wide or zero-width character is on the screen; row 2 characters (column 1); unmodelled: wide character"
        );
    }

    /// The review of #308 (#4): a string CAN or SUB aborts is over, and what follows is drawn.
    #[test]
    fn can_and_sub_end_a_string_and_the_text_after_is_drawn() {
        for abort in ["\x18", "\x1a"] {
            let s = screen(format!("\x1b]0;title{abort}$ ").as_bytes());
            assert!(s.cursor_after("$"), "{abort:?}");
        }
    }

    /// Ticket 162: the Session's own shell's marks (its token) say which of its commands runs,
    /// ended however a terminal ends an OSC; marks with another token, or none, don't count.
    #[test]
    fn own_marks_say_which_command_still_runs() {
        const T: &str = "0123456789abcdef01234567";
        let run = |bytes: &[u8]| {
            let mut s = Screen::new(24, 80);
            s.follow_marks(T);
            s.feed(bytes);
            s.own_run()
        };
        let c = format!("\x1b]133;C;roster={T}\x07");
        let d = format!("\x1b]133;D;0;roster={T}\x07");
        assert_eq!(run(c.as_bytes()), Some(1));
        assert_eq!(run(format!("{c}{d}").as_bytes()), None);
        assert_eq!(run(format!("{c}{d}{c}").as_bytes()), Some(2));
        // Ended by ST, or by an ESC that starts something else.
        assert_eq!(run(format!("\x1b]133;C;roster={T}\x1b\\").as_bytes()), Some(1));
        assert_eq!(run(format!("{c}\x1b]133;D;0;roster={T}\x1b[0m").as_bytes()), None);
        // Another shell's or a forged token, a mark without one, a mark CAN aborts, the token
        // only in another OSC: none counts.
        assert_eq!(
            run(format!("{c}\x1b]133;D;0;roster=fedcba9876543210fedcba98\x07").as_bytes()),
            Some(1)
        );
        assert_eq!(run(format!("{c}\x1b]133;D;0\x07").as_bytes()), Some(1));
        assert_eq!(run(format!("{c}\x1b]133;D;0;rost\x18er={T}\x07").as_bytes()), Some(1));
        assert_eq!(run(format!("\x1b]2;133;C;roster={T}\x07").as_bytes()), None);
        // A screen reset doesn't forget them.
        assert_eq!(run(format!("{c}\x1bc").as_bytes()), Some(1));
        // With no token to follow, nothing counts.
        let mut s = Screen::new(24, 80);
        s.feed(c.as_bytes());
        assert_eq!(s.own_run(), None);
    }

    #[test]
    fn a_full_screen_program_leaves_the_main_screen_as_it_was() {
        let s = screen(b"$ sudo ls\r\n[sudo] password for ops: \x1b[?1049h\x1b[Hvim\x1b[?1049l");
        assert!(s.cursor_after("[sudo] password for ops:"));
        let s = screen(b"[sudo] password for ops: \x1b[?1049h\x1b[Hvim");
        assert!(!s.cursor_after("[sudo] password for ops:"));
    }

    #[test]
    fn a_long_line_wraps_and_the_cursor_follows() {
        let mut s = Screen::new(24, 10);
        s.feed(b"0123456789[sudo] pw:");
        assert!(s.cursor_after("[sudo] pw:"));
        let mut s = Screen::new(24, 10);
        s.feed(b"0123456789pw: ");
        assert!(!s.cursor_after("0123456789pw:"));
        assert!(s.cursor_after("pw:"));
        s.resize(5, 40);
        assert!(s.cursor_after("pw:"));
    }

    #[test]
    fn escape_strings_and_designators_draw_nothing() {
        let s = screen(b"\x1bP+q544e\x1b\\\x1b_Gf=24\x1b\\\x1b]8;;https://example.com/\x1b\\[sudo]\x1b(B password\x1b]0;t\x07 for ops: ");
        assert!(s.cursor_after("[sudo] password for ops:"));
    }

    #[test]
    fn an_empty_prompt_never_matches() {
        assert!(!screen(b"$ ").cursor_after("  "));
    }

    /// Ticket 154: what a fill's probe may draw at sudo's `pwfeedback` prompt and still count as
    /// no echo, read as a terminal reads it.
    #[test]
    fn a_mask_watch_takes_only_a_star_taken_back_however_its_drawn() {
        const PROMPT: &[u8] = b"$ sudo -v\r\n[sudo] password for ops: ";
        let watched = |out: &[u8]| {
            let mut s = screen(PROMPT);
            s.watch_mask();
            s.feed(out);
            s.end_mask_watch(1).masked
        };
        let yes: &[&[u8]] = &[
            b"",
            b"*\x08 \x08",
            b"\x1b[K*\x08 \x08\x1b[K",
            b"\x1b[?25l*\x1b[?25h\x1b[?25l\x08 \x08\x1b[?25h",
            b"*\x1b[?25l\x1b[26G\x1b[K\x1b[?25h",
            b"*\x1b[D\x1b[K",
            b"*\x08\x1b[X",
            b"*\x1b[1D \x1b[1D",
            b"*\r\x1b[25C \x1b[D",
            b"*\x1b[2;26H\x1b[K",
        ];
        for out in yes {
            assert!(watched(out), "{:?}", String::from_utf8_lossy(out));
        }
        let no: &[&[u8]] = &[
            b"x\x08 \x08",
            b"*",
            b"**\x08 \x08\x08 \x08",
            b"#\x08 \x08",
            b"*\x08 \x08\r\n",
            b"*\x08 \x08\t",
            b"*\x08 \x08\x07",
            b"*\x08 \x08\x1b[1m",
            b"*\x08 \x08\x1b[2K",
            b"*\x08 \x08\x1b[J",
            b"*\x08 \x08\x1b]0;title\x07",
            b"*\x08 \x08\x1b7\x1b8",
            b"*\x08 \x08\x1b[?1049h\x1b[?1049l",
            b"*\x08 \x08\x1b[?2\x1b[?25l5h",
            b"\x1b[\x1b[?25lK*\x08 \x08",
            b"*\x1b[\x08D \x08",
            b"*\x1b[>1D \x08",
            b"*\x08 \x08\x1b[1;1H",
            b"*\x08 \x08\x1b[A",
            b"\x08\x08 \x1b[25G",
        ];
        for out in no {
            assert!(!watched(out), "{:?}", String::from_utf8_lossy(out));
        }
        // A resize while it watches, or no watch at all, is never a mask.
        let mut s = screen(PROMPT);
        s.watch_mask();
        s.resize(24, 100);
        assert!(!s.end_mask_watch(1).masked);
        assert!(!s.end_mask_watch(1).masked);
    }

    /// Ticket 155 (#284, item 1): the mask watch compares the whole screen, not only the cursor's
    /// row, so a `*` drawn on another row and the cursor put back isn't a mask.
    #[test]
    fn a_mask_watch_takes_nothing_drawn_on_another_row() {
        const PROMPT: &[u8] = b"$ sudo -v\r\n[sudo] password for ops: ";
        for out in [
            &b"\x1b[1;1H*\x1b[2;26H"[..],
            b"\x1b[A*\x1b[B\x1b[26G",
            b"\x1b[1;3H*\x08 \x08\x1b[2;26H",
        ] {
            let mut s = screen(PROMPT);
            s.watch_mask();
            s.feed(out);
            let watched = s.end_mask_watch(1);
            assert!(!watched.masked, "{:?}", String::from_utf8_lossy(out));
        }
        let mut s = screen(PROMPT);
        s.watch_mask();
        s.feed(b"\x1b[1;1H*\x1b[2;26H");
        assert_eq!(
            s.end_mask_watch(1).drawn.to_string(),
            "CSI[1;1H '*' CSI[2;26H; another line changed"
        );
    }

    /// Ticket 155 (#284): ConPTY repaints regions of the screen it already drew. What a fill
    /// notes at its start is the whole screen and the cursor; a repaint that draws the same
    /// content leaves it as it was, anything else doesn't.
    #[test]
    fn a_repaint_of_the_same_screen_leaves_it_as_it_was() {
        const PROMPT: &[u8] = b"\x1b[2J\x1b[H$ sudo -v\r\n[sudo] password for ops: ";
        let same: &[&[u8]] = &[
            b"",
            b"\x1b[?25l\x1b[H$ sudo -v\x1b[K\r\n[sudo] password for ops: \x1b[K\r\n\x1b[K\x1b[2;26H\x1b[?25h",
            b"\x1b[?25l\x1b[1;1H$\x1b[1X\x1b[1Csudo -v\x1b[2;1H[sudo]\x1b[1X\x1b[1Cpassword for ops:\x1b[1X\x1b[2;26H\x1b[?25h",
            b"\x1b[?25l\x1b[2;1H[sudo] password for ops: \x1b[K\x1b[?25h",
            b"\x1b[m\x1b[2;26H",
        ];
        for out in same {
            let mut s = screen(PROMPT);
            let shot = s.snapshot();
            s.feed(out);
            assert!(s.matches(&shot), "{:?}", String::from_utf8_lossy(out));
        }
        let changed: &[&[u8]] = &[
            b"\r\nSorry, try again.\r\n[sudo] password for ops: ",
            b"\x1b[H$ sudo -k\x1b[2;26H",
            b"\x1b[24;1Hmotd\x1b[2;26H",
            b"\x1b[2;1H[sudo] password for ops: \x1b[K\x1b[1;1H",
            b"\x1b[?1049h",
            b"\x1b[2;80Hx\x1b[2;26H",
        ];
        for out in changed {
            let mut s = screen(PROMPT);
            let shot = s.snapshot();
            s.feed(out);
            assert!(!s.matches(&shot), "{:?}", String::from_utf8_lossy(out));
        }
        // A resize is never the same screen.
        let mut s = screen(PROMPT);
        let shot = s.snapshot();
        s.resize(24, 100);
        assert!(!s.matches(&shot));
    }

    /// The review of #299 (#5): the snapshot keeps every cell's whole character and the colours
    /// and styles it was drawn with, and anything this screen doesn't model (a repeat, insert
    /// mode, a scroll region, the alignment test, another charset, origin or wrap mode) counts as
    /// a change.
    #[test]
    fn a_repaint_must_draw_the_same_characters_with_the_same_style() {
        const PROMPT: &[u8] = "\x1b[2J\x1b[H$ caf\u{e9}\r\n\x1b[1m[sudo]\x1b[m password for ops: ".as_bytes();
        let same: &[&[u8]] = &[
            "\x1b[1;1H$ caf\u{e9}\x1b[2;26H".as_bytes(),
            b"\x1b[2;1H\x1b[1m[sudo]\x1b[0m password for ops: ",
            b"\x1b[2;1H\x1b[0;1m[sudo]\x1b[m password for ops: \x1b[K",
        ];
        for out in same {
            let mut s = screen(PROMPT);
            let shot = s.snapshot();
            s.feed(out);
            assert!(s.matches(&shot), "{:?}", String::from_utf8_lossy(out));
        }
        let changed: &[&[u8]] = &[
            // Another character with the same first byte.
            "\x1b[1;1H$ caf\u{e8}\x1b[2;26H".as_bytes(),
            // The same text, another style.
            b"\x1b[2;1H[sudo] password for ops: ",
            b"\x1b[2;1H\x1b[1;31m[sudo]\x1b[m password for ops: ",
            b"\x1b[1;1H\x1b[7m$\x1b[m\x1b[2;26H",
            // What this screen doesn't model.
            b"\x1b[1;3H \x1b[1b\x1b[2;26H",
            b"\x1b[4h\x1b[4l",
            b"\x1b[1;10r\x1b[r\x1b[2;26H",
            b"\x1b#8\x1b[2J\x1b[H",
            b"\x1b(0\x1b(B",
            b"\x0e\x0f",
            b"\x1b[?6h\x1b[?6l\x1b[2;26H",
            b"\x1b[?7l\x1b[?7h",
            b"\x1b[3g",
            b"\x1bH",
        ];
        for out in changed {
            let mut s = screen(PROMPT);
            let shot = s.snapshot();
            s.feed(out);
            assert!(!s.matches(&shot), "{:?}", String::from_utf8_lossy(out));
        }
    }

    /// Ticket 155c (#284 item 5): what Windows' ConPTY sends when it repaints what it already
    /// drew, in the forms its renderer writes (microsoft/terminal, `src/renderer/vt/`: the cursor
    /// hidden and shown, `CSI H`, `CR LF`, `CUF`, `BS`, `ECH`, `EL`, `SGR` as `ESC[m`, `ESC[3Xm`,
    /// `ESC[9Xm`, `ESC[38;5;Nm`, `ESC[38;2;R;G;Bm`, `ESC[39m`, `ESC[49m`, `ESC[22m`, curly
    /// underlines and their colour as `4:3` and `58:5:N`, the window title, hyperlinks, the
    /// cursor's blink and shape), leaves the screen as it was; the same forms drawing
    /// something else don't.
    #[test]
    fn a_conpty_repaint_of_the_same_screen_leaves_it_as_it_was() {
        // A coloured shell prompt, then sudo's, drawn as ConPTY first drew them; the rows below
        // were never drawn.
        const PROMPT: &[u8] = b"\x1b[2J\x1b[H\x1b[92m\x1b[1mops@esx-02\x1b[m:~$ sudo -v\r\n[sudo] password for ops: ";
        let same: &[&[u8]] = &[
            // Every row: trailing blanks erased (ECH, then EL past the edge) with whatever colour
            // conhost's buffer gave them: a terminal erases with the background only.
            b"\x1b[?25l\x1b[H\x1b[92m\x1b[1mops@esx-02\x1b[m:~$ sudo -v\x1b[37m\x1b[60X\r\n\x1b[m[sudo] password for ops:\x1b[1m\x1b[55X\x1b[22m\r\n\x1b[37m\x1b[K\r\n\x1b[K\x1b[m\x1b[2;26H\x1b[?25h",
            // A few trailing blanks written as spaces, in a colour, bold or italic: still blank.
            b"\x1b[?25l\x1b[2;1H\x1b[39m[sudo] password for ops:\x1b[93m\x1b[3m    \x1b[23m\x1b[39m\x1b[2;26H\x1b[?25h",
            // The same colours in other forms of the same SGR.
            b"\x1b[?25l\x1b[1;1H\x1b[01;92mops@esx-02\x1b[0m:~$ sudo -v\x1b[2;26H\x1b[?25h",
            b"\x1b[H\x1b[92;1mops@esx-02\x1b[39;49;22m:~$\x1b[2;26H",
            // A title, a hyperlink's end, the cursor's blink and shape, the cursor moved back by
            // BS and CUF.
            b"\x1b]0;sudo\x07\x1b]8;;\x1b\\\x1b[?12l\x1b[?12h\x1b[2 q\x1b[2;27H\x08",
            b"\x1b[2;1H\x1b[25C",
            // 256 colours and true colour, set and back.
            b"\x1b[38;5;196m\x1b[48;2;1;2;3m\x1b[58:5:4m\x1b[4:3m\x1b[m\x1b[2;26H",
        ];
        for out in same {
            let mut s = screen(PROMPT);
            let shot = s.snapshot();
            s.feed(out);
            assert!(s.matches(&shot), "{:?}", String::from_utf8_lossy(out));
        }
        // The same forms drawing something that shows.
        let changed: &[&[u8]] = &[
            // Blanks erased with a background colour.
            b"\x1b[2;26H\x1b[44m\x1b[55X\x1b[m",
            b"\x1b[3;1H\x1b[48;5;4m\x1b[K\x1b[m\x1b[2;26H",
            // Blanks underlined, reversed, struck through, overlined.
            b"\x1b[2;26H\x1b[4m   \x1b[24m\x1b[2;26H",
            b"\x1b[2;26H\x1b[7m \x1b[27m\x1b[2;26H",
            b"\x1b[2;26H\x1b[9m \x1b[29m\x1b[2;26H",
            b"\x1b[2;26H\x1b[53m \x1b[55m\x1b[2;26H",
            // Text in another colour, or another form that draws differently (bold in a
            // 16-colour green is drawn bright, in 256-colour green it isn't).
            b"\x1b[H\x1b[32m\x1b[1mops@esx-02\x1b[m\x1b[2;26H",
            b"\x1b[H\x1b[38;5;10m\x1b[1mops@esx-02\x1b[m\x1b[2;26H",
            b"\x1b[H\x1b[38;2;0;255;0m\x1b[1mops@esx-02\x1b[m\x1b[2;26H",
            b"\x1b[2;1H\x1b[4:3m[sudo]\x1b[m\x1b[2;26H",
            // The screen cleared.
            b"\x1b[2J\x1b[2;26H",
        ];
        for out in changed {
            let mut s = screen(PROMPT);
            let shot = s.snapshot();
            s.feed(out);
            assert!(!s.matches(&shot), "{:?}", String::from_utf8_lossy(out));
        }
    }

    /// Ticket 155c (#284 item 5): what differs from a snapshot, for the log when a fill refuses
    /// before its probe: the cursor, the size, resizes, the alternate screen, each changed row
    /// with whether its characters or only its styles differ (the styles as SGR parameters), and
    /// each unmodelled sequence, named as [`Drawn`] names them.
    #[test]
    fn a_diff_says_what_changed_without_text() {
        const PROMPT: &[u8] = b"\x1b[2J\x1b[H$ sudo -v\r\n[sudo] password for ops: ";
        let diff = |out: &[u8]| {
            let mut s = screen(PROMPT);
            let shot = s.snapshot();
            s.feed(out);
            s.diff(&shot).to_string()
        };
        assert_eq!(diff(b"\x1b[2;26H"), "nothing on the screen differs");
        assert_eq!(
            diff(b"\x1b[2;1H\x1b[37;1m[sudo]\x1b[m\x1b[4;1Hmotd"),
            "the cursor moved from 2:26 to 4:5; row 2 styles only (columns 1-6: bold off -> 1, fg default -> 37); row 4 characters (columns 1-4)"
        );
        assert_eq!(
            diff(
                b"\x1b[2;30H\x1b[48;2;1;2;3m\x1b[K\x1b[m\x1b[2;3H\x1b[38;5;9m\x1b[58:5:4m\x1b[4:3mudo\x1b[m\x1b[2;26H"
            ),
            "row 2 styles only (columns 3-80: underline off -> 4:3, fg default -> 38;5;9, underline colour default -> 58;5;4)"
        );
        assert_eq!(
            diff(b"\x1b[3g\x1b[1;2;3;4;5;6;7;8;9;10;11b\x1bH\x1b(0\x1b(B\x1b[2;26H"),
            "unmodelled: CSI[3? CSI[1;2;3;4;5;6;7;8;…? ESCH ESC(0"
        );
        assert_eq!(diff(b"\x1b[?1049h"), "the alternate screen came up");
        let mut s = screen(PROMPT);
        let shot = s.snapshot();
        s.resize(30, 100);
        s.resize(24, 80);
        s.resize(24, 100);
        assert_eq!(
            s.diff(&shot).to_string(),
            "the size changed from 24x80 to 24x100; resized 3 times"
        );
        // At most 8 rows, and the last 16 unmodelled things, then how many more.
        let many = diff(&[&b"\x1b[3g".repeat(20)[..], b"\x1b[3;1H", &b"x\r\n".repeat(12)].concat());
        assert!(many.contains("; and 4 more rows changed; unmodelled: CSI[3?"), "{many}");
        assert!(many.ends_with("CSI[3? and 4 more"), "{many}");
        assert_eq!(many.matches("CSI[3?").count(), 16, "{many}");
        // No printed text, wherever it went.
        for out in [
            &b"\x1b[2;1Hhunter2"[..],
            b"\x1b[5;1H\x1b[1mhunter2\x1b[m\x1b[2;26H",
            b"\x1b]0;hunter2\x07\x1b[3;1Hhunter2",
            b"\x1b[hunter2",
            b"\x1b[1;hunter2",
            b"\x1b#hunter2",
            b"\x1b(hunter2",
            b"\x1b[?2025hunter2",
            "\x1b[3;1Hh\u{e9}llo w\u{f6}rld\u{80}".as_bytes(),
        ] {
            let said = diff(out);
            for word in ["hunter", "unter", "llo", "rld"] {
                assert!(!said.contains(word), "{:?} -> {said}", String::from_utf8_lossy(out));
            }
            // Every word is one of its own, or a command letter a CSI or ESC may show.
            let own = "the cursor moved from to wrap pending size changed resized time times alternate screen came up went away row rows characters column columns styles only and more unmodelled nothing on differs CSI ESC params cut bold faint italic underline blink reverse hidden strike overline fg bg colour default off stray UTF byte too many x OSC DCS APC PM SOS NUL BEL BS HT LF VT FF CR DEL";
            for word in said.split(|c: char| !c.is_ascii_alphabetic()).filter(|w| !w.is_empty()) {
                let letter = word.len() == 1
                    && (CSI_SHOWN.contains(&word.as_bytes()[0]) || b"78DEHMNOZcAB".contains(&word.as_bytes()[0]));
                assert!(own.split(' ').any(|w| w == word) || letter, "{word:?} in {said}");
            }
        }
    }

    /// The review of #299 (#6): a resize and back is still a resize.
    #[test]
    fn a_resize_and_back_is_never_the_same_screen() {
        let mut s = screen(b"[sudo] password for ops: ");
        let shot = s.snapshot();
        s.resize(24, 100);
        s.resize(24, 80);
        assert!(!s.matches(&shot));
    }

    #[test]
    fn the_whole_line_must_be_the_prompt() {
        let s = screen(b"Enter vault PIN for [sudo] password for ops: ");
        assert!(s.cursor_after("[sudo] password for ops:"));
        assert!(!s.line_is("[sudo] password for ops:"));
        let s = screen(b"\x1b[1m[sudo]  password for ops:\x1b[m ");
        assert!(s.line_is("[sudo] password for ops:"));
    }

    /// Ticket 155 (#284): what the probe drew, for the log, when the mask watch refuses it: each
    /// thing the parser saw, in order, with printed text other than `*` and space as a count.
    #[test]
    fn a_mask_watch_says_what_it_saw() {
        const PROMPT: &[u8] = b"$ sudo -v\r\n[sudo] password for ops: ";
        let drawn = |out: &[u8]| {
            let mut s = screen(PROMPT);
            s.watch_mask();
            s.feed(out);
            s.end_mask_watch(1).drawn.to_string()
        };
        assert_eq!(
            drawn(b"\x1b[1m*\x1b[0m\x1b[?25l\x1b[26G\x1b[K\x1b[?25h"),
            "CSI[1m '*' CSI[0m CSI[?25l CSI[26G CSI[K CSI[?25h"
        );
        assert_eq!(
            drawn(b"*\x08 \x08\r\n"),
            "'*' BS ' ' BS CR LF; the cursor moved from 2:26 to 3:1"
        );
        assert_eq!(drawn(b"x\x08 \x08"), "text(1) BS ' ' BS");
        assert_eq!(drawn(b"**\x08\x08"), "'*' '*' BS BS; the line changed");
        assert_eq!(
            drawn(b"\x1b]0;my title\x07\x1b(B\x1b7\x07\t\x1b[2;3H"),
            "OSC(10) ESC(B ESC7 BEL HT CSI[2;3H; the cursor moved from 2:26 to 2:3"
        );
        assert_eq!(drawn(b""), "nothing");
        let mut s = screen(PROMPT);
        s.watch_mask();
        s.resize(24, 100);
        assert_eq!(
            s.end_mask_watch(1).drawn.to_string(),
            "resize; the line changed; another line changed"
        );
        // At most 64 things, then how many more.
        let many = drawn(&b"\x1b[K".repeat(70));
        assert!(many.ends_with("CSI[K and 6 more"), "{many}");
        assert_eq!(many.matches("CSI[K").count(), 64, "{many}");
    }

    /// Ticket 155: printed text other than `*` and space never reaches the description, only how
    /// many characters there were, whatever wraps it.
    #[test]
    fn a_mask_watch_never_says_the_text_it_saw() {
        const PROMPT: &[u8] = b"[sudo] password for ops: ";
        for out in [
            &b"hunter2"[..],
            b"*\x1b[1mhunter2\x1b[0m",
            b"\x1b]0;hunter2\x07",
            b"\x1bP+qhunter2\x1b\\",
            b"\x1b_hunter2\x1b\\",
            b"h\x1b[Ku\x1b[Kn\x1b[Kt",
            "h\u{e9}llo w\u{f6}rld".as_bytes(),
            b"\x1b[\x1bhunter2",
            b"\x1b[1;hunter2",
            b"\x1b[2025s3cret",
            b"\x1b[?hunter",
            b"\x1b[1;2hunter",
        ] {
            let mut s = screen(PROMPT);
            s.watch_mask();
            s.feed(out);
            let said = s.end_mask_watch(1).drawn.to_string();
            for word in ["hunter", "unter", "llo", "rld", "ello", "2025s", "cret"] {
                assert!(!said.contains(word), "{:?} -> {said}", String::from_utf8_lossy(out));
            }
            assert!(only_known(&said), "{:?} -> {said}", String::from_utf8_lossy(out));
        }
        // A CSI's command shows only when it's one a terminal draws with (and `h`, `l` only as DEC
        // modes, `s`, `u` only bare); its parameters only when they're numbers.
        let said = |out: &[u8]| {
            let mut s = screen(PROMPT);
            s.watch_mask();
            s.feed(out);
            s.end_mask_watch(1).drawn.to_string()
        };
        assert_eq!(
            said(b"\x1b[1;hunter2"),
            "CSI[1;? text(6); the cursor moved from 1:26 to 1:32; the line changed; something roster's screen doesn't model"
        );
        assert_eq!(
            said(b"\x1b[2025s3cret"),
            "CSI[2025? text(5); the cursor moved from 1:26 to 1:31; the line changed"
        );
        assert_eq!(said(b"\x1b[s\x1b[u\x1b[?25l\x1b[?25h"), "CSI[s CSI[u CSI[?25l CSI[?25h");
        assert_eq!(
            said(b"\x1b[2 q\x1b[>1x"),
            "CSI[params(2)? CSI[params(2)?; something roster's screen doesn't model"
        );
        // DECRC as xterm.js does it, the alternate screen up or not.
        assert_eq!(
            said(b"\x1b[?h\x1b[?1049l"),
            "CSI[?? CSI[?1049l; the cursor moved from 1:26 to 1:1"
        );
    }

    /// Whether every word of a [`Drawn`] is one of its own: a thing it names (`'*'`, a control's
    /// name, `text(N)`, `OSC(N)`, `ESC` with what it may show, a CSI as [`CSI_SHOWN`] allows) or
    /// its fixed words, so no letter or digit the Session printed can be in it.
    fn only_known(said: &str) -> bool {
        let mut parts = said.split("; ");
        let things = parts.next().unwrap_or("");
        let counted = |w: &str, name: &str| {
            w.strip_prefix(name)
                .and_then(|r| r.strip_prefix('('))
                .and_then(|r| r.strip_suffix(')'))
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        };
        let words: Vec<&str> = things.split(' ').collect();
        let ok_thing = |i: usize, w: &str| {
            if [
                "'*'", "nothing", "resize", "NUL", "BEL", "BS", "HT", "LF", "VT", "FF", "CR", "DEL",
            ]
            .contains(&w)
                || ["text", "OSC", "DCS", "APC", "PM", "SOS"].iter().any(|n| counted(w, n))
            {
                return true;
            }
            // ' ' splits into two empty words.
            if w == "'" {
                return true;
            }
            if w == "and" || w == "more" || (i > 0 && words[i - 1] == "and" && w.bytes().all(|b| b.is_ascii_digit())) {
                return true;
            }
            if let Some(hex) = w.strip_prefix("0x") {
                return hex.len() == 2 && hex.bytes().all(|b| b.is_ascii_hexdigit());
            }
            if let Some(rest) = w.strip_prefix("ESC") {
                return rest
                    .bytes()
                    .all(|b| b == b'?' || (0x20..=0x2f).contains(&b) || b"78DEHMNOZc=>\\0AB<".contains(&b));
            }
            if let Some(rest) = w.strip_prefix("CSI[") {
                let (params, fin) = match rest.strip_suffix("(cut)") {
                    Some(p) => (p, None),
                    None => (&rest[..rest.len().saturating_sub(1)], rest.bytes().last()),
                };
                let params_ok = params.is_empty()
                    || params == "…"
                    || counted(params, "params")
                    || params
                        .trim_end_matches('…')
                        .trim_start_matches('?')
                        .bytes()
                        .all(|b| b.is_ascii_digit() || b == b';');
                return params_ok && fin.is_none_or(|b| b == b'?' || CSI_SHOWN.contains(&b));
            }
            false
        };
        words.iter().enumerate().all(|(i, w)| ok_thing(i, w))
            && parts.all(|p| {
                p == "the line changed"
                    || p == "another line changed"
                    || p == "something roster's screen doesn't model"
                    || p.strip_suffix(" bytes printed before the probe")
                        .is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()))
                    || p.strip_prefix("the cursor moved from ").is_some_and(|r| {
                        r.bytes()
                            .all(|b| b.is_ascii_digit() || b == b':' || b == b' ' || b == b't' || b == b'o')
                    })
            })
    }
}
