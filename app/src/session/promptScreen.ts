// The screen the shell hooks read the prompt off (ticket 159, #296; decision Q150): a terminal
// (xterm, as the tab's own) fed the Session's output at the Session's size, so the cursor's line
// is what the tab draws, with wrapping, wide cells, scroll regions and resets as a terminal does
// them. It's the Session's, not the view's: a tab that isn't on screen has it too.
import { Terminal } from "@xterm/xterm";
import type { TermSize } from "../backend/types";
import type { CursorLine, PromptScreen } from "./shellHooks";

/** Rows kept above the screen: the prompt check reads only the cursor's line and two above it. */
const SCROLLBACK = 50;
/** How much of a CSI's parameters it keeps: xterm reads at most 32 parameters, which (at most
 * four digits each, with their separators) fit well inside. Past it, further parameter bytes are
 * dropped, as they change nothing xterm draws; the sequence still waits for its final byte. */
const PARAMS_MAX = 256;
/** How many intermediate bytes it keeps; past it they're dropped too, so a sequence that never
 * ends holds a bounded amount. */
const INTERMEDIATES_MAX = 16;

const enum St {
  Text,
  /** After ESC. */
  Esc,
  /** After 0xC2 in text: the first byte of a C1 control (U+0080 to U+009F) or of another character. */
  C2,
  Csi,
  /** After 0xC2 in a CSI. */
  CsiC2,
}

/** Gives each CSI parameter as at most 9999, whether the CSI begins with `ESC [` or with the C1
 * introducer U+009B (UTF-8 `C2 9B`, which xterm takes the same), across writes (a sequence split
 * between two reads is held until it ends). That's more than any screen's rows or columns, so a
 * move, an erase or an insert draws the same, and a huge count (`ESC[99999999M`, which xterm takes
 * over a minute on, or `ESC[99999999L`) can't stall the check. Leading zeros go (`0005` is 5, as
 * xterm reads it). Nothing of a CSI ever comes out as text: it comes out whole at its final byte,
 * or unfinished where an ESC, CAN, SUB or C1 control ends it, as a terminal ends it. Controls
 * inside it (a backspace, a line feed) come out where they are, as a terminal runs them there.
 * Everything else passes as it came. */
export class CsiClamp {
  private state: St = St.Text;
  /** The CSI's introducer as it came (`ESC [` or `C2 9B`). */
  private intro: number[] = [];
  /** The CSI's parameter and intermediate bytes so far, parameters capped. */
  private seq: number[] = [];
  /** Where the current parameter's digits are in `seq`. */
  private digits: number[] = [];
  private params = 0;
  private intermediates = 0;

  clamp(data: Uint8Array): Uint8Array {
    const out: number[] = [];
    const startCsi = (intro: number[]) => {
      this.state = St.Csi;
      this.intro = intro;
      this.seq = [];
      this.digits = [];
      this.params = 0;
      this.intermediates = 0;
    };
    /** The CSI as far as it got, out unfinished (the terminal drops it at what ends it). */
    const unfinished = () => out.push(...this.intro, ...this.seq);
    /** A C1 control (`C2 c`): a CSI introducer starts one; any other goes out as it came. */
    const c1 = (c: number) => {
      if (c === 0x9b) startCsi([0xc2, 0x9b]);
      else {
        out.push(0xc2, c);
        this.state = St.Text;
      }
    };
    for (let i = 0; i < data.length; i++) {
      const c = data[i] ?? 0;
      switch (this.state) {
        case St.Text:
          if (c === 0x1b) this.state = St.Esc;
          else if (c === 0xc2) this.state = St.C2;
          else out.push(c);
          break;
        case St.Esc:
          if (c === 0x5b) startCsi([0x1b, 0x5b]);
          else {
            out.push(0x1b);
            this.state = St.Text;
            i--; // look at it again as text
          }
          break;
        case St.C2:
          if (c >= 0x80 && c <= 0x9f) c1(c);
          else {
            out.push(0xc2);
            this.state = St.Text;
            i--;
          }
          break;
        case St.Csi:
          this.inCsi(c, out, unfinished);
          break;
        case St.CsiC2:
          if (c >= 0x80 && c <= 0x9f) {
            // A C1 control ends the CSI, as ESC does, and acts.
            unfinished();
            c1(c);
          } else {
            this.state = St.Csi;
            this.keep(0xc2);
            i--;
          }
          break;
      }
    }
    return Uint8Array.from(out);
  }

  private inCsi(c: number, out: number[], unfinished: () => void) {
    if (c >= 0x30 && c <= 0x39) {
      // A parameter past four digits is the cap: its digits all 9. A leading zero changes nothing.
      if (c === 0x30 && this.digits.length === 1 && this.seq[this.digits[0] ?? -1] === 0x30) return;
      if (this.digits.length === 1 && this.seq[this.digits[0] ?? -1] === 0x30) {
        this.seq[this.digits[0] ?? 0] = c;
        return;
      }
      if (this.digits.length < 4) {
        if (this.params >= PARAMS_MAX) return;
        this.params++;
        this.digits.push(this.seq.length);
        this.seq.push(c);
      } else for (const at of this.digits) this.seq[at] = 0x39;
    } else if (c >= 0x3a && c <= 0x3f) {
      this.digits = [];
      if (this.params >= PARAMS_MAX) return;
      this.params++;
      this.seq.push(c);
    } else if (c >= 0x20 && c <= 0x2f) {
      this.digits = [];
      if (this.intermediates >= INTERMEDIATES_MAX) return;
      this.intermediates++;
      this.seq.push(c);
    } else if (c >= 0x40 && c <= 0x7e) {
      out.push(...this.intro, ...this.seq, c);
      this.state = St.Text;
    } else if (c === 0x1b) {
      unfinished();
      this.state = St.Esc;
    } else if (c === 0x18 || c === 0x1a) {
      unfinished();
      out.push(c);
      this.state = St.Text;
    } else if (c === 0xc2) this.state = St.CsiC2;
    else if (c < 0x20) out.push(c); // a control runs where it is, the CSI still going
    else if (c !== 0x7f) this.keep(c); // another character's bytes: kept with it, bounded
  }

  /** A byte that's neither parameter nor intermediate, kept in the CSI (bounded with them). */
  private keep(c: number) {
    if (this.intermediates >= INTERMEDIATES_MAX) return;
    this.intermediates++;
    this.seq.push(c);
  }
}

export class XtermPromptScreen implements PromptScreen {
  private readonly term: Terminal;
  private pending = 0;
  private readonly clamp = new CsiClamp();

  constructor(size: TermSize) {
    this.term = new Terminal({ cols: size.cols, rows: size.rows, scrollback: SCROLLBACK, allowProposedApi: false });
  }

  write(data: Uint8Array | string) {
    this.pending++;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.term.write(this.clamp.clamp(bytes), () => this.pending--);
  }

  settled(): boolean {
    return this.pending === 0;
  }

  flushed(): Promise<void> {
    return new Promise((resolve) => this.term.write("", resolve));
  }

  resize(size: TermSize) {
    if (size.cols !== this.term.cols || size.rows !== this.term.rows) this.term.resize(size.cols, size.rows);
  }

  line(): CursorLine {
    const b = this.term.buffer.active;
    const y = b.baseY + b.cursorY;
    // The cursor's line from where it starts (a long prompt wraps onto more rows).
    let start = y;
    while (start > 0 && b.getLine(start)?.isWrapped) start--;
    let text = "";
    for (let r = start; r < y; r++) text += b.getLine(r)?.translateToString(false) ?? "";
    text += b.getLine(y)?.translateToString(false, 0, b.cursorX) ?? "";
    let rest = b.getLine(y)?.translateToString(true, b.cursorX) ?? "";
    let end = y + 1;
    for (; end < b.length && b.getLine(end)?.isWrapped; end++) rest += b.getLine(end)?.translateToString(true) ?? "";
    const above: string[] = [];
    for (let r = Math.max(0, start - 2); r < start; r++) above.push(b.getLine(r)?.translateToString(true) ?? "");
    const below = end < b.length ? (b.getLine(end)?.translateToString(true) ?? "") : "";
    return { text, rest, above, below, alt: b.type !== "normal" };
  }

  dispose() {
    this.term.dispose();
  }
}
