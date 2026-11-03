// The core's screen (crates/roster-core/src/screen.rs) decides whether a ConPTY repaint left the
// Session's screen as it was before a sudo fill types its probe (ticket 155c, decision Q151 (k)).
// It must never take as the same a screen that xterm.js draws differently (the review of #318):
// the same table runs through both, here against a real xterm.js, and so do random repaints whose
// verdicts the core recorded (scripts/gen-repaint-cases.py).
import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import repaintFuzz from "../../../crates/roster-core/tests/fixtures/repaint-fuzz.json";
import repaints from "../../../crates/roster-core/tests/fixtures/repaints.json";

const terms: Terminal[] = [];
afterEach(() => terms.splice(0).forEach((t) => t.dispose()));
const write = (t: Terminal, data: string) => new Promise<void>((done) => t.write(data, done));

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
  it.each(repaints.cases.filter((c) => c.kind !== "refused anyway"))("$name ($kind)", async ({ before, after, kind }) => {
    const t = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
    terms.push(t);
    await write(t, before);
    const was = shown(t);
    await write(t, after);
    if (kind === "same") expect(shown(t)).toBe(was);
    else expect(shown(t)).not.toBe(was);
  });
});

describe("random repaints the core takes as the same screen", () => {
  it("are the same screen in xterm.js", async () => {
    const differ: string[] = [];
    for (const { after, same } of repaintFuzz.cases) {
      if (!same) continue;
      const t = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
      terms.push(t);
      await write(t, repaintFuzz.before);
      const was = shown(t);
      await write(t, after);
      if (shown(t) !== was) differ.push(after);
    }
    expect(repaintFuzz.cases.filter((c) => c.same).length).toBeGreaterThan(100);
    expect(differ).toEqual([]);
  });
});
