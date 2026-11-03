// The core's screen (crates/roster-core/src/screen.rs) decides whether a ConPTY repaint left the
// Session's screen as it was before a sudo fill types its probe (ticket 155c, decision Q151 (k)).
// It must never take as the same a screen that xterm.js draws differently (the review of #318):
// the same table runs through both, here against a real xterm.js, and so do random repaints whose
// verdicts the core recorded (scripts/gen-repaint-cases.py).
import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import repaintFuzz from "../../../crates/roster-core/tests/fixtures/repaint-fuzz.json";
import repaints from "../../../crates/roster-core/tests/fixtures/repaints.json";
import { screenWriter } from "./osc52";

const terms: Terminal[] = [];
afterEach(() => terms.splice(0).forEach((t) => t.dispose()));
const write = (t: Terminal, data: string) => new Promise<void>((done) => t.write(data, done));
const unhex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

/** A terminal fed as the app feeds a Session's tab: each chunk of bytes through its own output
 * pipeline (screenWriter: HeldOsc52Filter and CsiClamp, osc52.ts), then into xterm.js. */
function tab() {
  const t = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
  terms.push(t);
  const pipe = screenWriter(t);
  return {
    t,
    async feed(...chunks: Uint8Array[]) {
      for (const c of chunks) pipe.write(c, false);
      await write(t, "");
    },
  };
}
const enc = (s: string) => new TextEncoder().encode(s);

/** Whether the cursor sits right after `text` with nothing after it on its line, as the core's
 * `Screen::cursor_after` reads it: whitespace runs as one space, trailing whitespace not counting. */
function cursorAfter(t: Terminal, text: string): boolean {
  const b = t.buffer.active;
  const line = b.getLine(b.baseY + b.cursorY);
  if (!line) return false;
  const chars: string[] = [];
  for (let x = 0; x < t.cols; x++) chars.push(line.getCell(x)?.getChars() || " ");
  const squash = (s: string) =>
    [...s].reduce((out, c) => (c <= " " || c === "\x7f" ? (out.endsWith(" ") ? out : `${out} `) : out + c), "");
  const end = Math.min(b.cursorX, t.cols);
  if (chars.slice(end).some((c) => c !== " ")) return false;
  const needle = squash(text).trim();
  return needle !== "" && squash(chars.slice(0, end).join("")).trimEnd().endsWith(needle);
}

/** What xterm.js shows: each cell's text and attributes, a blank's only as far as they show on a
 * blank (its background, unless it's reversed or has a line through, under or over it), the
 * cursor, and which buffer is up. */
function shown(t: Terminal): string {
  const b = t.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < t.rows; y++) {
    const line = b.getLine(b.viewportY + y);
    const cells: string[] = [];
    for (let x = 0; x < t.cols; x++) {
      const c = line?.getCell(x);
      if (!c) continue;
      const bg = `${c.getBgColorMode()}:${c.getBgColor()}`;
      const lines = c.isInverse() || c.isUnderline() || c.isStrikethrough() || c.isOverline();
      const all = [
        c.getChars(),
        c.getWidth(),
        `${c.getFgColorMode()}:${c.getFgColor()}`,
        bg,
        c.isBold(),
        c.isDim(),
        c.isItalic(),
        c.isUnderline(),
        c.isBlink(),
        c.isInverse(),
        c.isInvisible(),
        c.isStrikethrough(),
        c.isOverline(),
      ];
      const blank = c.getChars() === "" || c.getChars() === " ";
      cells.push(JSON.stringify(blank && !lines ? [" ", bg] : all));
    }
    rows.push(cells.join(""));
  }
  return `${b.type} ${b.cursorX},${b.cursorY}\n${rows.join("\n")}`;
}

describe("a repaint, as xterm.js draws it, agrees with the core's screen", () => {
  type Case = { name: string; before: string; after?: string; after_hex?: string[]; kind: string };
  it.each((repaints.cases as Case[]).filter((c) => c.kind !== "refused anyway"))("$name ($kind)", async (c) => {
    const { t, feed } = tab();
    await feed(enc(c.before));
    const was = shown(t);
    await feed(...(c.after_hex ? c.after_hex.map(unhex) : [enc(c.after ?? "")]));
    const kind = c.kind;
    if (kind === "same") expect(shown(t)).toBe(was);
    else expect(shown(t)).not.toBe(was);
  });
});

describe("random repaints the core takes as the same screen", () => {
  it("are the same screen in xterm.js, with the prompt where the core reads it", async () => {
    const differ: string[] = [];
    const prompt: string[] = [];
    for (const { after_hex, same, at_prompt, diverged } of repaintFuzz.cases) {
      // Nothing to check where the core refuses and has lost track (some of those, ED 1 from the
      // last column with no scrollback, throw inside xterm.js 6.0.0).
      if (!same && diverged) continue;
      const { t, feed } = tab();
      await feed(enc(repaintFuzz.before));
      const was = shown(t);
      await feed(unhex(after_hex));
      if (same && shown(t) !== was) differ.push(after_hex);
      // Where the core hasn't lost track, it reads the prompt where xterm.js shows it.
      if (!diverged && cursorAfter(t, "[sudo] password for ops:") !== at_prompt) prompt.push(after_hex);
      t.dispose();
      terms.pop();
    }
    expect(repaintFuzz.cases.filter((c) => c.same).length).toBeGreaterThan(100);
    expect(differ).toEqual([]);
    expect(prompt).toEqual([]);
  }, 120_000);
});
