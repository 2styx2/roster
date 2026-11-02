//! Where a Session's cursor is and what its line shows, as a terminal would draw the Session's
//! output (ticket 137, decision Q136): enough of a terminal for a prompt fill to check that the
//! prompt the frontend read off its screen is the one at the cursor, through ConPTY's redraws
//! (cursor addressing, column sets, erased characters, carriage-return overwrites, backspaces).
//! It keeps one screen of cells (and the main screen while an alternate one is up), never the
//! scrollback, and parses every escape sequence a terminal does, acting on the ones that move the
//! cursor or change cells and skipping the rest (colours, titles, links, DCS and APC strings).
//! A UTF-8 character takes one cell, kept as its first byte; a wide one is therefore a column
//! short, which can only make a comparison fail (a refusal), never pass.

/// A blank cell.
const BLANK: u8 = b' ';
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
    grid: Vec<Vec<u8>>,
    row: usize,
    col: usize,
    /// The cursor is past the last column: the next character wraps first.
    pending_wrap: bool,
    saved: (usize, usize),
    /// The main screen and its cursor while the alternate screen is up.
    main: Option<(Vec<Vec<u8>>, usize, usize)>,
    parse: Parse,
    csi: Vec<u8>,
    csi_long: bool,
    /// What a fill's probe draws, while it waits (ticket 154): [`Screen::watch_mask`].
    mask: Option<MaskWatch>,
}

/// The cursor and its line as they were when a fill typed its probe, and what the output has done
/// since, as this parser reads it (ticket 154, decision Q144): never bytes taken out of the stream.
struct MaskWatch {
    row: usize,
    col: usize,
    pending_wrap: bool,
    line: Vec<u8>,
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
/// as its length (`OSC(12)`); a sequence's own parameters and command show (`CSI[?25l`). This is
/// before any password is typed, but it's kept that narrow anyway.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Drawn {
    seen: Vec<Seen>,
    more: usize,
    /// The cursor (row, column, from 1) when the probe went and at the check, if they differ.
    moved: Option<((usize, usize), (usize, usize))>,
    line_changed: bool,
    /// Bytes the Session printed after the prompt check and before the probe (the fill sets it).
    pub(crate) before: u64,
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
                        Some(p) => f.write_str(&String::from_utf8_lossy(&p[..p.len().min(SEEN_PARAMS)]))?,
                        None => f.write_str("…")?,
                    }
                    if params.as_ref().is_some_and(|p| p.len() > SEEN_PARAMS) {
                        f.write_str("…")?;
                    }
                    match fin {
                        Some(b) => write!(f, "{}", char::from(*b))?,
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
        if self.before > 0 {
            write!(f, "; {} bytes printed before the probe", self.before)?;
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
            mask: None,
        }
    }

    /// Starts noting what the output draws from here on, with the cursor and its line as they are
    /// now: a fill does this as it types its probe (ticket 154).
    pub(crate) fn watch_mask(&mut self) {
        self.mask = Some(MaskWatch {
            row: self.row,
            col: self.col,
            pending_wrap: self.pending_wrap,
            line: self.grid[self.row].clone(),
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
    /// at all, and left the cursor where it was on a line that's exactly as it was: sudo's
    /// `pwfeedback` mask for the probe and its erasure, however a terminal (ConPTY) redraws it.
    /// [`Watched::drawn`] says what it saw, for the log.
    pub(crate) fn end_mask_watch(&mut self, stars: usize) -> Watched {
        let Some(w) = self.mask.take() else {
            return Watched {
                masked: false,
                drawn: Drawn::default(),
            };
        };
        let stayed = (w.row, w.col, w.pending_wrap) == (self.row, self.col, self.pending_wrap);
        let line_same = self.grid[self.row] == w.line;
        Watched {
            masked: !w.other && w.stars <= stars && stayed && line_same,
            drawn: Drawn {
                moved: (!stayed).then_some(((w.row + 1, w.col + 1), (self.row + 1, self.col + 1))),
                // The prompt's own line, wherever the cursor went.
                line_changed: self.grid.get(w.row) != Some(&w.line),
                seen: w.seen,
                more: w.more,
                before: 0,
            },
        }
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
        !needle.is_empty() && squash(self.grid[self.row].iter().copied()).trim_ascii() == needle
    }

    /// The terminal was resized: the cursor's row stays on screen, cells beyond the new width go.
    pub(crate) fn resize(&mut self, rows: u16, cols: u16) {
        self.not_mask();
        self.saw(Seen::Resize);
        let (rows, cols) = (usize::from(rows.max(1)), usize::from(cols.max(1)));
        let fit = |grid: &mut Vec<Vec<u8>>, row: &mut usize| {
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
        if line[end..].iter().any(|&c| c != BLANK) {
            return false;
        }
        squash(line[..end].iter().copied()).trim_ascii_end().ends_with(needle)
    }

    fn byte(&mut self, b: u8) {
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
            0x00..=0x1f | 0x7f => {}
            // A UTF-8 continuation byte: its character already took its cell.
            0x80..=0xbf => {}
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
            0x20..=0x2f => self.parse = Parse::Inter,
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
                    self.grid.pop();
                    self.grid.insert(0, vec![BLANK; self.cols]);
                } else {
                    self.row -= 1;
                }
            }
            b'c' => *self = Screen::new(self.rows as u16, self.cols as u16),
            _ => {}
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
        self.grid[self.row][self.col] = b;
        if self.col + 1 == self.cols {
            self.pending_wrap = true;
        } else {
            self.col += 1;
        }
    }

    fn line_feed(&mut self) {
        if self.row + 1 == self.rows {
            self.grid.remove(0);
            self.grid.push(vec![BLANK; self.cols]);
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
                    self.grid[self.row][self.col..].fill(BLANK);
                    for line in &mut self.grid[self.row + 1..] {
                        line.fill(BLANK);
                    }
                }
                1 => {
                    for line in &mut self.grid[..self.row] {
                        line.fill(BLANK);
                    }
                    self.grid[self.row][..=self.col].fill(BLANK);
                }
                _ => {
                    for line in &mut self.grid {
                        line.fill(BLANK);
                    }
                }
            },
            b'K' if !private => {
                let line = &mut self.grid[self.row];
                match arg(0) {
                    0 => line[self.col..].fill(BLANK),
                    1 => line[..=self.col].fill(BLANK),
                    _ => line.fill(BLANK),
                }
            }
            b'X' => {
                let end = (self.col + n).min(cols);
                self.grid[self.row][self.col..end].fill(BLANK);
            }
            b'P' => {
                let line = &mut self.grid[self.row];
                let n = n.min(cols - self.col);
                line.drain(self.col..self.col + n);
                line.resize(cols, BLANK);
            }
            b'@' => {
                let line = &mut self.grid[self.row];
                let n = n.min(cols - self.col);
                for _ in 0..n {
                    line.insert(self.col, BLANK);
                }
                line.truncate(cols);
            }
            b'L' => {
                for _ in 0..n.min(rows - self.row) {
                    self.grid.pop();
                    self.grid.insert(self.row, vec![BLANK; cols]);
                }
            }
            b'M' => {
                for _ in 0..n.min(rows - self.row) {
                    self.grid.remove(self.row);
                    self.grid.push(vec![BLANK; cols]);
                }
            }
            b'S' => {
                for _ in 0..n.min(rows) {
                    self.grid.remove(0);
                    self.grid.push(vec![BLANK; cols]);
                }
            }
            b'T' => {
                for _ in 0..n.min(rows) {
                    self.grid.pop();
                    self.grid.insert(0, vec![BLANK; cols]);
                }
            }
            b's' if !private => self.saved = (self.row, self.col),
            b'u' if !private => self.restore(),
            b'h' | b'l' if private => {
                let alt = params.iter().any(|&p| p == 1049 || p == 1047 || p == 47);
                if alt {
                    self.alternate(fin == b'h');
                }
            }
            _ => {}
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
        assert_eq!(s.end_mask_watch(1).drawn.to_string(), "resize; the line changed");
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
        ] {
            let mut s = screen(PROMPT);
            s.watch_mask();
            s.feed(out);
            let said = s.end_mask_watch(1).drawn.to_string();
            for word in ["hunter", "unter", "llo", "rld", "ello"] {
                assert!(!said.contains(word), "{:?} -> {said}", String::from_utf8_lossy(out));
            }
        }
    }
}
