// The screen the shell hooks read the prompt off (ticket 159, #296; decision Q150): a terminal
// (xterm, as the tab's own) fed the Session's output at the Session's size, so the cursor's line
// is what the tab draws, with wrapping, wide cells, scroll regions and resets as a terminal does
// them. It's the Session's, not the view's: a tab that isn't on screen has it too.
import { Terminal } from "@xterm/xterm";
import type { TermSize } from "../backend/types";
import { CsiClamp } from "../terminal/csiClamp";
import type { CursorLine, PromptScreen } from "./shellHooks";

/** Rows kept above the screen: the prompt check reads only the cursor's line and two above it. */
const SCROLLBACK = 50;
export class XtermPromptScreen implements PromptScreen {
  private readonly term: Terminal;
  private pending = 0;
  private readonly clamp: CsiClamp;

  constructor(size: TermSize) {
    this.term = new Terminal({ cols: size.cols, rows: size.rows, scrollback: SCROLLBACK, allowProposedApi: false });
    this.clamp = new CsiClamp(this.term);
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
