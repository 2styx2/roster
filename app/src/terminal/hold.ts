// Output for a terminal that isn't on screen (docs/app/performance.md). xterm.js 6 redraws every
// row of a DOM-rendered terminal on each scroll, even while it's hidden (the selection refresh skips
// its pause), and measures each character against a display:none box, which always reads 0 and so
// is never cached: 11 busy hidden Sessions kept the webview busy on every frame. So a hidden
// terminal holds what its Session prints and takes it in one write when it's shown again.
//
// Except a question: ConPTY asks for the cursor position before it starts anything, and programs
// ask for the terminal's colours, version or modes and wait for the answer, which xterm gives only
// once it reads the question. So output that asks something goes through at once, with what was
// held before it. (A question split across two chunks waits for the next one, or the limit.)

/** Where a terminal's output goes, shown or hidden. */
export interface OutputGate {
  /** The Session printed this. */
  write(data: Uint8Array): void;
  /** The terminal is on screen: what was held goes in first, in one write. */
  show(): void;
  /** The terminal is off screen: hold output from now on. */
  hide(): void;
}

/** What a hidden terminal holds at most before it takes it anyway (one write, one redraw). */
const LIMIT = 256 * 1024;

const ESC = 0x1b;
const BEL = 0x07;
const at = (c: string) => c.charCodeAt(0);

/** Whether `data` asks the terminal something it answers (to the Session, through onData): a CSI
 * device status (`n`), device attributes (`c`), mode (`$p`), version (`>q`), keyboard flags (`?u`) or
 * window report (`t`); an OSC whose value is `?` (a colour query); or any DCS (DECRQSS, XTGETTCAP). */
export function asksForAnswer(data: Uint8Array): boolean {
  for (let i = 0; i < data.length - 1; i++) {
    if (data[i] !== ESC) continue;
    const kind = data[i + 1];
    if (kind === at("P")) return true;
    if (kind === at("[")) {
      // parameters and intermediates (0x20-0x3f), then the final byte
      let j = i + 2;
      while (j < data.length && (data[j] as number) >= 0x20 && (data[j] as number) <= 0x3f) j++;
      const final = data[j];
      const first = data[i + 2];
      const before = data[j - 1];
      if (final === at("n") || final === at("c") || final === at("t")) return true;
      if (final === at("p") && before === at("$")) return true;
      if (final === at("q") && first === at(">")) return true;
      if (final === at("u") && first === at("?")) return true;
      i = j;
    } else if (kind === at("]")) {
      // up to BEL or ST (ESC \)
      let j = i + 2;
      while (j < data.length && data[j] !== BEL && data[j] !== ESC) j++;
      if (j < data.length && data[j - 1] === at("?")) return true;
      i = j - 1;
    }
  }
  return false;
}

/** `write` hears whether the output was held: it arrived while the terminal was off screen (OSC 52
 * from a background tab sets nothing, osc52.ts). */
export function holdWhileHidden(write: (data: Uint8Array, held: boolean) => void, { limit = LIMIT }: { limit?: number } = {}): OutputGate {
  let hidden = false;
  let held: Uint8Array[] = [];
  let heldBytes = 0;

  const flush = () => {
    if (held.length === 0) return;
    const all = new Uint8Array(heldBytes);
    let offset = 0;
    for (const chunk of held) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    held = [];
    heldBytes = 0;
    write(all, true);
  };

  return {
    write(data) {
      if (!hidden) return write(data, false);
      held.push(data);
      heldBytes += data.length;
      if (heldBytes >= limit || asksForAnswer(data)) flush();
    },
    show() {
      hidden = false;
      flush();
    },
    hide() {
      hidden = true;
    },
  };
}
