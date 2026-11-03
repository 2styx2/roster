// The screen the shell hooks read the prompt off (ticket 159, #296; decision Q150): a terminal
// (xterm, as the tab's own) fed the Session's output at the Session's size, so the cursor's line
// is what the tab draws, with wrapping, wide cells, scroll regions and resets as a terminal does
// them. It's the Session's, not the view's: a tab that isn't on screen has it too.
import { Terminal } from "@xterm/xterm";
import type { TermSize } from "../backend/types";
import type { CursorLine, PromptScreen } from "./shellHooks";

/** Rows kept above the screen: the prompt check reads only the cursor's line and two above it. */
const SCROLLBACK = 50;
/** The longest CSI it follows; a longer one is cancelled (CAN), as nothing real is that long. */
const CSI_MAX = 256;

/** Gives each CSI parameter as at most 9999, across writes (a sequence split between two reads is
 * held until it ends): more than any screen's rows or columns, so a move, an erase or an insert
 * draws the same, and a huge count (`ESC[99999999M`, which xterm takes over a minute on, or
 * `ESC[99999999L`) can't stall the check. Everything else passes as it came. */
export class CsiClamp {
  /** 0: text; 1: after ESC; 2: in a CSI. */
  private state = 0;
  /** The CSI so far (after `ESC [`). */
  private seq: number[] = [];
  /** Where the current parameter's digits are in `seq`. */
  private digits: number[] = [];

  clamp(data: Uint8Array): Uint8Array {
    const out: number[] = [];
    for (const c of data) {
      if (this.state === 2) {
        if (c >= 0x30 && c <= 0x39) {
          // A parameter past four digits is the cap: its digits all 9.
          if (this.digits.length < 4) {
            this.digits.push(this.seq.length);
            this.seq.push(c);
          } else for (const i of this.digits) this.seq[i] = 0x39;
        } else if (c >= 0x3a && c <= 0x3f) {
          this.digits = [];
          this.seq.push(c);
        } else if (c >= 0x40 && c <= 0x7e) {
          out.push(0x1b, 0x5b, ...this.seq, c);
          this.state = 0;
        } else if (c === 0x1b || c === 0x18 || c === 0x1a) {
          // An ESC, CAN or SUB ends it unfinished, as in a terminal.
          out.push(0x1b, 0x5b, ...this.seq);
          if (c === 0x1b) this.state = 1;
          else {
            out.push(c);
            this.state = 0;
          }
        } else this.seq.push(c); // intermediates, and controls a terminal runs inside one
        if (this.state === 2 && this.seq.length > CSI_MAX) {
          out.push(0x18);
          this.state = 0;
        }
        continue;
      }
      if (this.state === 1) {
        this.state = 0;
        if (c === 0x5b) {
          this.state = 2;
          this.seq = [];
          this.digits = [];
          continue;
        }
        out.push(0x1b);
      }
      if (c === 0x1b) this.state = 1;
      else out.push(c);
    }
    return Uint8Array.from(out);
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
