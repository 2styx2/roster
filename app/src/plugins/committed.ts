// The lines a Session's terminal commits, for `terminal_output` (ticket 79, #137): its output goes
// through a terminal of its own (xterm's, never opened on screen), and a line is taken when the
// cursor moves past it, as the terminal shows it then. So escape sequences are gone, a line the
// program rewrote (a progress bar, `\r`) comes as it ended up, and one that wrapped comes whole.
//
// A line written again with the same text in the same row isn't taken again: that's a repaint (the
// screen ConPTY prints again after a resize, on Windows), not output. After a resize the rows
// above the cursor count as taken, since the reflowed screen is the same text in new places.
// What a full-screen program draws (the alternate screen: vim, top, less) is never taken.
//
// A shell with integration (ticket 94, #167; decision Q121) writes OSC 133 marks: `A` its prompt
// starts, `B` the command line starts (the prompt ended), `C` the command's output starts, `D;CODE`
// the command ended. Read only, from what the shell prints; roster never writes to the Session.
// The marks never hold back or drop a line: they only say what each one is (`kind`), and a Host
// can forge them, so that's advice. A few lines after `A` are "prompt", the line typed at the
// prompt (committed after `B`, or the row a `C` came on) is "input", lines from `C` to `D` are
// "output"; anything else has no kind. `D` makes a Done: the command line (read off the screen at
// `C`), its output and the exit code. What a command printed before `D` on the cursor's row is
// output then, and not sent again when that row is committed with the next prompt on it.
// An `A` while a command runs is a nested shell's (ssh to a Host with integration): the outer
// command gets no Done, since its end can't be told from the nested shell's. Nor does `exit` or
// `logout`: a shell that exits sends no `D` for it, so the `D` after it is another shell's.
import { Terminal } from "@xterm/xterm";

/** The most text one `terminal_output` or one Done's `output` carries: its last whole lines. */
export const OUTPUT_MAX = 16 * 1024;
/** Dones kept between takes: the last ones. */
export const DONES_MAX = 20;
/** Lines after an `A` that are "prompt" (a prompt over a few rows); later ones have no kind. */
export const PROMPT_LINES = 3;

/** The last whole lines of `text` that fit in `max` characters. */
export function lastLines(text: string, max = OUTPUT_MAX): string {
  return text.length > max ? text.slice(text.indexOf("\n", text.length - max - 1) + 1) : text;
}

/** A command a marked shell ran, from its `C` to its `D`. */
export interface Done {
  /** The command line as the shell showed it, read at `C`; null when it couldn't be read (no `B`,
   * or it scrolled away or was reflowed before `C`). */
  command: string | null;
  /** What it printed, each line ending in a newline. */
  output: string;
  /** Its exit code; null when the shell didn't say. */
  code: number | null;
}

/** What the marks say a line is; null: they say nothing (no marks, or not of a kind). */
export type LineKind = "prompt" | "input" | "output" | null;

/** Lines in a row of the same kind, each ending in a newline. */
export interface Run {
  text: string;
  kind: LineKind;
}

type Phase = "none" | "prompt" | "input" | "output" | "idle";

/** A shell's own exit: it sends no `D` for it. */
const EXIT = /^\s*(exit|logout)(\s+\S+)?\s*$/;

export class CommittedLines {
  private readonly term: Terminal;
  /** Per row of the screen: the text taken from the line that starts there. */
  private taken: (string | undefined)[];
  private runs: Run[] = [];
  /** Where the Session is between OSC 133 marks: "none" until it sends one. */
  private phase: Phase = "none";
  /** Lines committed since the last `A` (prompt) or `B` (input). */
  private count = 0;
  /** Where the command line starts (`B`), as a row of the screen and a column. */
  private start: { row: number; col: number } | null = null;
  /** The row a `C` came on before its line feed (pwsh's), and what its line is when committed:
   * written before the `C`, so never output; input after a `B`, else nothing the marks say. */
  private cRow: { row: number; kind: LineKind } | null = null;
  /** What was sent at `D` from the start of the cursor's row, not to be sent again with it. */
  private partial: { row: number; text: string } | null = null;
  private command: string | null = null;
  /** The running command's output since `C`: its lines from `outFrom` on, `outSize` characters. */
  private out: string[] = [];
  private outFrom = 0;
  private outSize = 0;
  private dones: Done[] = [];

  constructor(size: ScreenSize) {
    this.term = new Terminal({ cols: size.cols, rows: size.rows, scrollback: 0, allowProposedApi: false });
    this.taken = new Array<string | undefined>(size.rows).fill(undefined);
    // A scroll moves every row up one: so does what was taken from them.
    this.term.onScroll(() => {
      if (!this.normal()) return;
      this.taken.shift();
      this.taken.push(undefined);
      if (this.start) this.start = this.start.row > 0 ? { row: this.start.row - 1, col: this.start.col } : null;
      if (this.cRow) this.cRow = this.cRow.row > 0 ? { ...this.cRow, row: this.cRow.row - 1 } : null;
      if (this.partial) this.partial = this.partial.row > 0 ? { ...this.partial, row: this.partial.row - 1 } : null;
    });
    this.term.onLineFeed(() => this.lineFeed());
    this.term.parser.registerOscHandler(133, (data) => {
      this.mark(data);
      return true;
    });
  }

  /** Feeds the terminal; resolves once it has taken in `data`. */
  write(data: Uint8Array | string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  /** The Session's terminal was resized: so is this one, and what's on screen counts as taken. */
  resize(size: ScreenSize) {
    if (size.cols === this.term.cols && size.rows === this.term.rows) return;
    this.term.resize(size.cols, size.rows);
    this.taken = new Array<string | undefined>(size.rows).fill(undefined);
    // Reflowed: rows aren't where they were.
    this.start = null;
    this.cRow = null;
    this.partial = null;
    if (!this.normal()) return;
    const cursor = this.term.buffer.active.cursorY;
    for (let y = 0; y < cursor; y++) {
      if (!this.row(y)?.isWrapped) this.taken[y] = this.lineAt(y);
    }
  }

  /** The lines committed since the last take, in runs of one kind. */
  takeRuns(): Run[] {
    const r = this.runs;
    this.runs = [];
    return r;
  }

  /** The lines committed since the last take, each ending in a newline. */
  take(): string {
    return this.takeRuns()
      .map((r) => r.text)
      .join("");
  }

  /** The commands that ended since the last take (a marked shell's), oldest first. */
  takeDone(): Done[] {
    const d = this.dones;
    this.dones = [];
    return d;
  }

  dispose() {
    this.term.dispose();
  }

  private normal() {
    return this.term.buffer.active.type === "normal";
  }

  private row(y: number) {
    const b = this.term.buffer.active;
    return b.getLine(b.baseY + y);
  }

  /** The whole line that starts at row `y`, with the rows it wrapped onto. */
  private lineAt(y: number): string {
    let text = this.row(y)?.translateToString(true) ?? "";
    for (let next = y + 1; next < this.term.rows && this.row(next)?.isWrapped; next++) {
      text = `${text.padEnd(this.term.cols)}${this.row(next)?.translateToString(true) ?? ""}`;
    }
    return text.trimEnd();
  }

  /** The row where the line through row `y` starts (it may have wrapped onto `y`). */
  private lineStart(y: number): number {
    while (y > 0 && this.row(y)?.isWrapped) y--;
    return y;
  }

  private lineFeed() {
    if (!this.normal()) return;
    const below = this.term.buffer.active.cursorY - 1;
    if (below < 0) return;
    const y = this.lineStart(below);
    let text = this.lineAt(y);
    if (this.taken[y] === text) return;
    this.taken[y] = text;
    // Its start went at `D` already (output with no line feed): the rest only.
    if (this.partial?.row === y) {
      if (text.startsWith(this.partial.text)) text = text.slice(this.partial.text.length);
      this.partial = null;
      if (!text.trim()) return;
    }
    this.push(text, this.kindOf(y));
  }

  /** What the marks say the line committed from row `y` is. */
  private kindOf(y: number): LineKind {
    if (this.cRow?.row === y) {
      const { kind } = this.cRow;
      this.cRow = null;
      return kind;
    }
    switch (this.phase) {
      case "prompt":
        return ++this.count <= PROMPT_LINES ? "prompt" : null;
      case "input":
        // One line: a shell that never says `C` doesn't make its output "input".
        return ++this.count <= 1 ? "input" : null;
      case "output":
        return "output";
      default:
        return null;
    }
  }

  private push(text: string, kind: LineKind) {
    const last = this.runs[this.runs.length - 1];
    if (last && last.kind === kind) last.text += `${text}\n`;
    else this.runs.push({ text: `${text}\n`, kind });
    if (kind === "output") this.collect(text);
  }

  /** Keeps a line of the running command's output, its last OUTPUT_MAX characters only. */
  private collect(text: string) {
    this.out.push(text);
    this.outSize += text.length + 1;
    while (this.outSize > OUTPUT_MAX && this.outFrom < this.out.length) {
      this.outSize -= (this.out[this.outFrom] ?? "").length + 1;
      this.outFrom++;
    }
    // Drop the lines gone by now and then, not each time: amortized, no shifting every line.
    if (this.outFrom > 1024 && this.outFrom * 2 > this.out.length) {
      this.out = this.out.slice(this.outFrom);
      this.outFrom = 0;
    }
  }

  private resetOutput() {
    this.out = [];
    this.outFrom = 0;
    this.outSize = 0;
  }

  /** An OSC 133 mark: `A`, `B`, `C`, or `D` with the exit code after a `;`. */
  private mark(data: string) {
    const [kind, arg] = data.split(";");
    const b = this.term.buffer.active;
    if (!this.normal()) return;
    switch (kind) {
      case "A":
      case "N":
        // While a command runs: a nested shell's prompt. The outer command gets no Done.
        if (this.phase === "output") this.resetOutput();
        if (this.phase !== "prompt") this.count = 0;
        this.phase = "prompt";
        this.start = null;
        return;
      case "B":
        if (this.phase === "output") this.resetOutput();
        if (this.phase !== "input") this.count = 0;
        this.phase = "input";
        this.start = { row: b.cursorY, col: b.cursorX };
        return;
      case "C":
        // Twice (a shell's own mark and a snippet's): the first one counts.
        if (this.phase === "output") return;
        this.command = this.phase === "input" ? this.commandLine() : null;
        // Before the line feed (pwsh's): the row it's on is the command line, sent when committed.
        if (b.cursorX > 0) this.cRow = { row: this.lineStart(b.cursorY), kind: this.phase === "input" ? "input" : null };
        this.phase = "output";
        this.start = null;
        this.resetOutput();
        return;
      case "D": {
        if (this.phase !== "output") {
          this.phase = "idle";
          return;
        }
        // What it printed with no line feed after it (`printf done`): only what's before the
        // cursor, never what comes after on that row (zsh's PROMPT_SP, the next prompt).
        if (b.cursorX > 0) {
          const y = this.lineStart(b.cursorY);
          const text = this.before(b.cursorY, b.cursorX);
          if (text && this.cRow?.row !== y) {
            this.push(text, "output");
            this.partial = { row: y, text };
          }
        }
        const code = arg !== undefined && /^-?\d+$/.test(arg) ? Number(arg) : null;
        if (!EXIT.test(this.command ?? "")) {
          const output = lastLines(
            this.out
              .slice(this.outFrom)
              .map((l) => `${l}\n`)
              .join(""),
          );
          this.dones.push({ command: this.command, output, code });
          if (this.dones.length > DONES_MAX) this.dones.shift();
        }
        this.phase = "idle";
        this.command = null;
        this.resetOutput();
        return;
      }
    }
  }

  /** The text of the line through row `y`, up to column `x` of that row. */
  private before(y: number, x: number): string {
    const from = this.lineStart(y);
    let text = "";
    for (let r = from; r < y; r++) text += this.row(r)?.translateToString(false) ?? "";
    text += this.row(y)?.translateToString(false, 0, x) ?? "";
    return text.trimEnd();
  }

  /** The command line, from where `B` left the cursor to where it is at `C`; null if it's gone. */
  private commandLine(): string | null {
    const start = this.start;
    if (!start) return null;
    const b = this.term.buffer.active;
    let endRow = b.cursorY;
    let endCol = b.cursorX;
    if (endCol === 0 && endRow > start.row) {
      endRow--;
      endCol = this.term.cols;
    }
    let text = "";
    for (let y = start.row; y <= endRow; y++) {
      const row = this.row(y);
      if (!row) break;
      const last = y === endRow;
      const next = this.row(y + 1);
      const wraps = !last && next?.isWrapped === true;
      text += row.translateToString(!wraps, y === start.row ? start.col : 0, last ? endCol : this.term.cols);
      if (!last && !wraps) text += "\n";
    }
    return text.trimEnd();
  }
}

export interface ScreenSize {
  cols: number;
  rows: number;
}
