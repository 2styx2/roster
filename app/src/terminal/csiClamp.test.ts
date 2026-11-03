// A huge CSI count can't stall an xterm (ticket 163, #305; decision Q153): CsiClamp caps each
// parameter at 9999, as a stream, and changes nothing else. Checked against a real xterm.js.
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { HUGE_CSI, HUGE_CSI_MS, splitInCount } from "../test-hugeCsi";
import { CsiClamp, CSI_PARAM_MAX } from "./csiClamp";
import { screenWriter } from "./osc52";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
/** `chunks` through one clamp, as one string. */
function clamped(...chunks: string[]): string {
  const c = new CsiClamp();
  return chunks.map((s) => dec(c.clamp(enc(s)))).join("");
}

function term(cols = 80, rows = 24) {
  return new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
}
const write = (t: Terminal, data: string | Uint8Array) => new Promise<void>((done) => t.write(data, done));
function screen(t: Terminal): string {
  const b = t.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) ?? "");
  return `${rows.join("\n").trimEnd()}\n@${b.cursorX},${b.cursorY}`;
}

describe("CsiClamp", () => {
  it("caps a count past 9999 at 9999", () => {
    expect(CSI_PARAM_MAX).toBe(9999);
    expect(clamped("\x1b[99999999L")).toBe("\x1b[9999L");
    expect(clamped("\x1b[10000;123456789H")).toBe("\x1b[9999;9999H");
    expect(clamped("\x1b[?12345;5h")).toBe("\x1b[?9999;5h");
    // sub-parameters too, and a leading zero stays
    expect(clamped("\x1b[38:2:123456:1:2m")).toBe("\x1b[38:2:9999:1:2m");
    expect(clamped("\x1b[00099999999M")).toBe("\x1b[0009999M");
  });

  it("caps the C1 CSI (U+009B) the same", () => {
    expect(clamped("\u009b99999999L")).toBe("\u009b9999L");
    expect(clamped("text\u009b99999999b")).toBe("text\u009b9999b");
  });

  it("follows a CSI across writes, split anywhere", () => {
    const whole = "ab\x1b[99999999;12345678Hcd\u009b123456789Lé\x1b[5;7H";
    const want = clamped(whole);
    expect(want).toBe("ab\x1b[9999;9999Hcd\u009b9999Lé\x1b[5;7H");
    const bytes = enc(whole);
    for (let i = 0; i <= bytes.length; i++) {
      const c = new CsiClamp();
      const out = [c.clamp(bytes.subarray(0, i)), c.clamp(bytes.subarray(i))];
      expect(dec(Uint8Array.from([...out[0]!, ...out[1]!]))).toBe(want);
    }
    // a byte at a time
    const c = new CsiClamp();
    expect(dec(Uint8Array.from([...bytes].flatMap((b) => [...c.clamp(Uint8Array.of(b))])))).toBe(want);
  });

  it("passes normal output as it came, the same array when nothing changed", () => {
    const normal = [
      "plain text, numbers 123456789 and all\r\n",
      "\x1b[1;31mERROR\x1b[0m \x1b[38;2;255;128;0mrgb\x1b[m \x1b[9999;9999H\x1b[2J\x1b[?1049h\x1b[?2004l",
      "\x1b[0000009999X", // leading zeros, and 9999 itself
      "\x1b]0;job 123456789 done\x07\x1b]52;c;MTIzNDU2Nzg5MDEyMzQ1Ng==\x07\x1b]133;D;123456\x1b\\",
      "\x1bP99999999$q12345678m\x1b\\\x1b_99999999\x1b\\",
      "‛quoted‛ ‹›, 中文, 😀 (UTF-8 with 0x9B inside a character)",
      "\x1b(B\x1b#8\x1b7\x1b8",
    ];
    for (const s of normal) {
      const c = new CsiClamp();
      const bytes = enc(s);
      expect(c.clamp(bytes)).toBe(bytes);
    }
    const c = new CsiClamp();
    expect(c.clamp("plain")).toBe("plain");
  });

  it("never touches an OSC or DCS string's digits", () => {
    expect(clamped("\x1b]52;c;OTk5OTk5OTk5OTk5\x07")).toBe("\x1b]52;c;OTk5OTk5OTk5OTk5\x07");
    expect(clamped("\x1b]2;", "123456789", "\x1b\\")).toBe("\x1b]2;123456789\x1b\\");
    expect(clamped("\u009d0;99999999\u009c")).toBe("\u009d0;99999999\u009c");
    expect(clamped("\x1bP1;99999999|x\x1b\\")).toBe("\x1bP1;99999999|x\x1b\\");
  });

  it("follows where xterm.js ends a CSI: final byte, ESC, CAN, SUB, a C1 control, past ASCII", () => {
    expect(clamped("\x1b[123456789\x1b[99999999L")).toBe("\x1b[9999\x1b[9999L");
    expect(clamped("\x1b[1\x18123456789")).toBe("\x1b[1\x18123456789");
    expect(clamped("\x1b[1\x1a123456789")).toBe("\x1b[1\x1a123456789");
    expect(clamped("\x1b[1\u0085123456789")).toBe("\x1b[1\u0085123456789");
    expect(clamped("\x1b[1é123456789")).toBe("\x1b[1é123456789");
    expect(clamped("\x1b[1m123456789")).toBe("\x1b[1m123456789");
    // controls inside a CSI run where they stand and the number goes on (so does `ESC <control> [`)
    expect(clamped("\x1b[12\r\n345678L")).toBe("\x1b[\r\n9999L");
    expect(clamped("\x1b\n[99999999L")).toBe("\x1b\n[9999L");
    // `ESC <intermediate> [` isn't a CSI
    expect(clamped("\x1b([99999999")).toBe("\x1b([99999999");
  });

  it("never cuts a long CSI: xterm.js takes it as it would unclamped, no tail shown as text", async () => {
    const long = `\x1b[${"1;".repeat(50_000)}99999999Lafter`;
    expect(clamped(long)).toBe(`\x1b[${"1;".repeat(50_000)}9999Lafter`);
    const raw = term();
    const via = term();
    const c = new CsiClamp();
    await write(raw, `\x1b[${"1;".repeat(50_000)}5Lafter`);
    await write(via, c.clamp(enc(long)));
    expect(screen(via)).toBe(screen(raw));
    expect(screen(via)).toMatch(/^after\n/);
    raw.dispose();
    via.dispose();
  });

  it("draws a capped count as the count would on a screen of any size up to 9999", async () => {
    for (const [, seq] of HUGE_CSI.filter(([n]) => n !== "REP")) {
      const fill = "line one\r\nline two two\r\n\x1b[5;5Hmiddle\x1b[3;10H";
      const capped = term();
      const via = term();
      const c = new CsiClamp();
      await write(capped, fill + seq.replace(/99999999/g, "9999"));
      await write(via, c.clamp(enc(fill + seq)));
      expect(screen(via)).toBe(screen(capped));
      capped.dispose();
      via.dispose();
    }
  });
});

describe("the tab's terminal (screenWriter) takes a huge count fast", () => {
  it.each(HUGE_CSI)("%s", async (_name, seq) => {
    const t = term();
    const w = screenWriter(t);
    const start = performance.now();
    w.write(enc(`before${seq}`), false);
    for (const part of splitInCount(seq)) w.write(enc(part), false);
    w.write(enc(`\u009b${seq.slice(2)}after`), true);
    await write(t, "");
    expect(performance.now() - start).toBeLessThan(HUGE_CSI_MS);
    t.dispose();
  });
});
