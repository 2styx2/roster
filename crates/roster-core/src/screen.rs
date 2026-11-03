//! Where a Session's cursor is and what its line shows, as a terminal would draw the Session's
//! output (ticket 137, decision Q136): enough of a terminal for a prompt fill to check that the
//! prompt the frontend read off its screen is the one at the cursor, through ConPTY's redraws
//! (cursor addressing, column sets, erased characters, carriage-return overwrites, backspaces).
//! It keeps one screen of cells (and the main screen while an alternate one is up), never the
//! scrollback, and parses every escape sequence a terminal does, acting on the ones that move the
//! cursor or change cells and skipping the rest (colours, titles, links, DCS and APC strings).
//! A UTF-8 character takes one cell, kept whole with the style it was drawn with (the review of
//! #299, #5); the prompt checks read its first byte. A wide one is therefore a column short,
//! which can only make a comparison fail (a refusal), never pass. What it doesn't model (a
//! repeat, insert mode, scroll regions, the alignment test, other charsets, origin and wrap
//! modes, tab stops, a style it can't name) it counts ([`Screen::matches`] then never holds).

/// One cell: its character, all of its UTF-8 bytes (at most 4), and the style it was drawn with
/// (an index into the screen's styles).
#[derive(Clone, Copy, PartialEq, Eq)]
struct Cell {
    ch: [u8; 4],
    style: u16,
}

impl Cell {
    /// Its first byte: what the prompt checks read.
    fn byte(self) -> u8 {
        self.ch[0]
    }
}

/// A blank cell in the default style.
const BLANK: Cell = Cell {
    ch: [b' ', 0, 0, 0],
    style: 0,
};
/// The most styles a screen names; one more counts as something it doesn't model.
const STYLES_MAX: usize = 256;

/// A style, as SGR sets it: for each attribute it models, its value as the parameters gave it,
/// sorted by attribute ([`Screen::sgr`]).
type Style = Vec<(u8, Vec<u8>)>;
/// The longest CSI parameter list kept; a longer sequence is parsed through and ignored.
const CSI_MAX: usize = 64;

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
    saved: (usize, usize),
    /// The main screen and its cursor while the alternate screen is up.
    main: Option<(Vec<Vec<Cell>>, usize, usize)>,
    parse: Parse,
    csi: Vec<u8>,
    csi_long: bool,
    /// The first intermediate byte of an escape sequence (`(` in `ESC ( B`).
    inter: u8,
    /// The style characters are drawn (and cells erased) with: an index into `styles`.
    style: u16,
    /// Every style seen, the default first.
    styles: Vec<Style>,
    /// The cell the last character went to and how many of its bytes it has, for the rest of a
    /// UTF-8 character.
    last_put: Option<(usize, usize, usize)>,
    /// Resizes so far (the review of #299, #6).
    resizes: u64,
    /// Things done that this screen doesn't model (the review of #299, #5).
    odd: u64,
    /// What a fill's probe draws, while it waits (ticket 154): [`Screen::watch_mask`].
    mask: Option<MaskWatch>,
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

impl std::fmt::Display for Drawn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.seen.is_empty() {
            f.write_str("nothing")?;
        }
        for (i, seen) in self.seen.iter().enumerate() {
            if i > 0 {
                f.write_str(" ")?;
            }
            match seen {
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
                        Some(p) if params_shown(p) => {
                            f.write_str(&String::from_utf8_lossy(&p[..p.len().min(SEEN_PARAMS)]))?;
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
            }
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
            saved: (0, 0),
            main: None,
            parse: Parse::Ground,
            csi: Vec::new(),
            csi_long: false,
            inter: 0,
            style: 0,
            styles: vec![Vec::new()],
            last_put: None,
            resizes: 0,
            odd: 0,
            mask: None,
        }
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
        }
    }

    fn compare(&self, at: &Snapshot) -> Compared {
        let dims = (self.rows, self.cols, self.main.is_some()) == (at.rows, at.cols, at.alternate);
        let odd = self.odd != at.odd;
        Compared {
            shape: dims && !odd && self.resizes == at.resizes,
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

    /// Whether the screen was resized since `shot`, even back to its size (the review of #299, #6).
    pub(crate) fn resized_since(&self, shot: &Snapshot) -> bool {
        self.resizes != shot.resizes
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
        if let Some((grid, row, _)) = &mut self.main {
            fit(grid, row);
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
        if !(self.parse == Parse::Ground && (0x80..0xc0).contains(&b)) {
            self.last_put = None;
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
                        self.not_mask();
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
                } else {
                    // A control inside the sequence, which a terminal would act on.
                    self.not_mask();
                    self.saw(Seen::Ctl(b));
                }
            }
            Parse::Str => {
                if b == 0x07 {
                    self.parse = Parse::Ground;
                } else if b == 0x1b {
                    self.parse = Parse::StrEsc;
                } else {
                    self.saw_more(Kind::Str, b);
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
                    // The alignment test and double-size lines (`ESC #`), and any charset but
                    // ASCII: not modelled.
                    if self.inter == b'#' || (b"()*+-./".contains(&self.inter) && b != b'B') {
                        self.odd += 1;
                    }
                }
            }
        }
    }

    fn ground(&mut self, b: u8) {
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
                0x1b => {}
                b'\r' | 0x08 => self.saw(Seen::Ctl(b)),
                0x00..=0x1f | 0x7f => {
                    self.not_mask();
                    self.saw(Seen::Ctl(b));
                }
                _ => {
                    self.not_mask();
                    self.saw_text(b);
                }
            }
        }
        match b {
            0x1b => self.parse = Parse::Esc,
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
            b'\t' => {
                self.pending_wrap = false;
                self.col = ((self.col / 8 + 1) * 8).min(self.cols - 1);
            }
            // Shift Out and In switch charsets: not modelled.
            0x0e | 0x0f => self.odd += 1,
            0x00..=0x1f | 0x7f => {}
            // A UTF-8 continuation byte: the rest of the character in the last cell drawn.
            0x80..=0xbf => self.put_more(b),
            _ => self.put(b),
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
            b']' | b'P' | b'_' | b'^' | b'X' => self.parse = Parse::Str,
            0x20..=0x2f => {
                self.parse = Parse::Inter;
                self.inter = b;
            }
            0x1b => self.parse = Parse::Esc,
            b'7' => self.saved = (self.row, self.col),
            b'8' => self.restore(),
            b'D' => self.line_feed(),
            b'E' => {
                self.col = 0;
                self.line_feed();
            }
            b'M' => {
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
                *self = Screen::new(self.rows as u16, self.cols as u16);
                (self.resizes, self.odd) = (resizes, odd + 1);
            }
            // The keypad modes and a string's end draw nothing.
            b'=' | b'>' | b'\\' => {}
            // Tab sets, single shifts and the rest: not modelled.
            _ => self.odd += 1,
        }
        if b != b'[' {
            self.pending_wrap = false;
        }
    }

    fn put(&mut self, b: u8) {
        if self.pending_wrap {
            self.pending_wrap = false;
            self.col = 0;
            self.line_feed();
        }
        self.grid[self.row][self.col] = Cell {
            ch: [b, 0, 0, 0],
            style: self.style,
        };
        self.last_put = Some((self.row, self.col, 1));
        if self.col + 1 == self.cols {
            self.pending_wrap = true;
        } else {
            self.col += 1;
        }
    }

    /// The rest of a UTF-8 character, into the cell its first byte went to; a stray one isn't
    /// modelled.
    fn put_more(&mut self, b: u8) {
        match self.last_put {
            Some((row, col, n)) if n < 4 => {
                self.grid[row][col].ch[n] = b;
                self.last_put = Some((row, col, n + 1));
            }
            _ => self.odd += 1,
        }
    }

    /// A cell an erase leaves: blank, in the current style (as a terminal erases with its
    /// background).
    fn blank(&self) -> Cell {
        Cell {
            ch: [b' ', 0, 0, 0],
            style: self.style,
        }
    }

    /// SGR: the style from here on (the review of #299, #5). Each attribute it models is set or
    /// cleared by its parameters; one it doesn't, or a style past [`STYLES_MAX`], isn't modelled.
    fn sgr(&mut self) {
        let mut style = self.styles[usize::from(self.style)].clone();
        let params: Vec<&[u8]> = self.csi.split(|&c| c == b';').collect();
        let mut i = 0;
        while i < params.len() {
            let p = params[i];
            let code = p.split(|&c| c == b':').next().unwrap_or_default();
            let n: Option<u16> = std::str::from_utf8(code)
                .ok()
                .and_then(|c| if c.is_empty() { Some(0) } else { c.parse().ok() });
            let mut value = p.to_vec();
            // 38, 48 and 58 take their colour from the next parameters (unless given with `:`).
            if matches!(n, Some(38 | 48 | 58)) && !p.contains(&b':') {
                let take = match params.get(i + 1) {
                    Some(&b"5") => 2,
                    Some(&b"2") => 4,
                    _ => 0,
                };
                for q in params.iter().skip(i + 1).take(take) {
                    value.push(b';');
                    value.extend_from_slice(q);
                }
                i += take;
            }
            let set = |style: &mut Style, slot: u8, value: Option<Vec<u8>>| {
                style.retain(|(s, _)| *s != slot);
                if let Some(v) = value {
                    style.push((slot, v));
                    style.sort();
                }
            };
            match n {
                Some(0) => style.clear(),
                Some(1) => set(&mut style, 1, Some(value)),
                Some(2) => set(&mut style, 2, Some(value)),
                Some(22) => {
                    set(&mut style, 1, None);
                    set(&mut style, 2, None);
                }
                Some(3) => set(&mut style, 3, Some(value)),
                Some(23) => set(&mut style, 3, None),
                Some(4 | 21) => set(&mut style, 4, Some(value)),
                Some(24) => set(&mut style, 4, None),
                Some(5 | 6) => set(&mut style, 5, Some(value)),
                Some(25) => set(&mut style, 5, None),
                Some(7) => set(&mut style, 7, Some(value)),
                Some(27) => set(&mut style, 7, None),
                Some(8) => set(&mut style, 8, Some(value)),
                Some(28) => set(&mut style, 8, None),
                Some(9) => set(&mut style, 9, Some(value)),
                Some(29) => set(&mut style, 9, None),
                Some(53) => set(&mut style, 53, Some(value)),
                Some(55) => set(&mut style, 53, None),
                Some(30..=38 | 90..=97) => set(&mut style, 30, Some(value)),
                Some(39) => set(&mut style, 30, None),
                Some(40..=48 | 100..=107) => set(&mut style, 40, Some(value)),
                Some(49) => set(&mut style, 40, None),
                Some(58) => set(&mut style, 58, Some(value)),
                Some(59) => set(&mut style, 58, None),
                _ => self.odd += 1,
            }
            i += 1;
        }
        match self.styles.iter().position(|s| *s == style) {
            Some(at) => self.style = at as u16,
            None if self.styles.len() < STYLES_MAX => {
                self.styles.push(style);
                self.style = (self.styles.len() - 1) as u16;
            }
            None => self.odd += 1,
        }
    }

    fn line_feed(&mut self) {
        if self.row + 1 == self.rows {
            let blank = self.blank();
            self.grid.remove(0);
            self.grid.push(vec![blank; self.cols]);
        } else {
            self.row += 1;
        }
    }

    fn restore(&mut self) {
        (self.row, self.col) = (self.saved.0.min(self.rows - 1), self.saved.1.min(self.cols - 1));
    }

    fn csi_exec(&mut self, fin: u8) {
        if self.mask.is_some() && !self.csi_draws_nothing(fin) {
            self.not_mask();
        }
        let private = self.csi.first() == Some(&b'?');
        // `<`, `=`, `>` and `?` mark a private sequence; intermediates (` q`) another command.
        let marked = self.csi.first().is_some_and(|b| b"<=>?".contains(b));
        let plain = !marked && !self.csi.iter().any(|b| (0x20..=0x2f).contains(b));
        let blank = self.blank();
        let params: Vec<usize> = self
            .csi
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
        self.pending_wrap = false;
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
            b'J' if !private => match arg(0) {
                0 => {
                    self.grid[self.row][self.col..].fill(blank);
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
                _ => {
                    for line in &mut self.grid {
                        line.fill(blank);
                    }
                }
            },
            b'K' if !private => {
                let line = &mut self.grid[self.row];
                match arg(0) {
                    0 => line[self.col..].fill(blank),
                    1 => line[..=self.col].fill(blank),
                    _ => line.fill(blank),
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
            b'L' => {
                for _ in 0..n.min(rows - self.row) {
                    self.grid.pop();
                    self.grid.insert(self.row, vec![blank; cols]);
                }
            }
            b'M' => {
                for _ in 0..n.min(rows - self.row) {
                    self.grid.remove(self.row);
                    self.grid.push(vec![blank; cols]);
                }
            }
            b'S' => {
                for _ in 0..n.min(rows) {
                    self.grid.remove(0);
                    self.grid.push(vec![blank; cols]);
                }
            }
            b'T' => {
                for _ in 0..n.min(rows) {
                    self.grid.pop();
                    self.grid.insert(0, vec![blank; cols]);
                }
            }
            b's' if !private => self.saved = (self.row, self.col),
            b'u' if !private => self.restore(),
            b'h' | b'l' if private => {
                let alt = params.iter().any(|&p| p == 1049 || p == 1047 || p == 47);
                if alt {
                    self.alternate(fin == b'h');
                }
                // 132 columns, reverse video, origin and wrap modes, side margins: not modelled.
                if params.iter().any(|p| [3, 5, 6, 7, 69].contains(p)) {
                    self.odd += 1;
                }
            }
            b'm' if plain => self.sgr(),
            // Reports, device attributes, window ops and the cursor's shape draw nothing.
            b'n' | b'c' | b't' | b'q' => {}
            // Insert and newline modes, scroll regions, repeats, tab stops and the rest: not
            // modelled.
            _ => self.odd += 1,
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

    /// Into the alternate screen (a blank one, the main one kept) or back to the main one.
    fn alternate(&mut self, on: bool) {
        if on && self.main.is_none() {
            let blank = vec![vec![BLANK; self.cols]; self.rows];
            let grid = std::mem::replace(&mut self.grid, blank);
            self.main = Some((grid, self.row, self.col));
        } else if !on && let Some((grid, row, col)) = self.main.take() {
            self.grid = grid;
            (self.row, self.col) = (row.min(self.rows - 1), col.min(self.cols - 1));
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
        assert_eq!(said(b"\x1b[?h\x1b[?1049l"), "CSI[?? CSI[?1049l");
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
