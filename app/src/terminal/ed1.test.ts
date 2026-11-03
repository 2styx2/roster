// xterm.js 6.0.0 throws inside `write` on ED 1 (`ESC[1J`, erase above) with the cursor at the
// last column of the bottom row while nothing has scrolled off the screen yet (in a terminal that
// keeps scrollback: the alternate screen and a terminal with none don't throw), and its write
// queue then stops for good: the rest of that write and every later one
// never reach the screen (ticket 172, #323; found by T155c, #318). Every xterm roster feeds a
// Session's output to takes it through a CsiClamp bound to that xterm (csiClamp.ts), which draws
// such an ED 1 as a correct terminal does. Checked against a real xterm.js.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { CommittedLines } from "../plugins/committed";
import { PromptWatch } from "../session/prompt";
import { XtermPromptScreen } from "../session/promptScreen";
import { CsiClamp } from "./csiClamp";
import { catchesThrows } from "./xtermGuard";
import { screenWriter } from "./osc52";

const terms: Terminal[] = [];
afterEach(() => {
  terms.splice(0).forEach((t) => t.dispose());
  vi.restoreAllMocks();
});
function term(cols = 10, rows = 3, scrollback = 100) {
  const t = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  terms.push(t);
  return t;
}
const enc = (s: string) => new TextEncoder().encode(s);
/** Resolves once `t` has taken in everything written before; "stuck" if it never does. */
function settled(t: Terminal): Promise<"ok" | "stuck"> {
  return new Promise((done) => {
    const timer = setTimeout(() => done("stuck"), 500);
    t.write("", () => {
      clearTimeout(timer);
      done("ok");
    });
  });
}
/** The whole buffer (scrollback too), each row's text as drawn, and the cursor. */
function screen(t: Terminal): string {
  const b = t.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) ?? "");
  return `${b.type} ${rows.map((r) => `|${r}`).join("\n")}\n@${b.cursorX},${b.cursorY}`;
}
/** `chunks` through the tab's own write path, then the screen. */
async function viaTab(t: Terminal, ...chunks: string[]): Promise<string> {
  const w = screenWriter(t);
  for (const c of chunks) w.write(enc(c), false);
  expect(await settled(t)).toBe("ok");
  return screen(t);
}

describe("ED 1 at the last column of a screen with no scrollback", () => {
  it("throws inside plain xterm.js 6.0.0 and stops its writes (the bug this works around)", async () => {
    const errors: unknown[] = [];
    const onError = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onError);
    try {
      const t = term();
      t.write("ab\x1b[3;10H\x1b[1Jafter");
      expect(await settled(t)).toBe("stuck");
      expect(String(errors[0])).toContain("isWrapped");
    } finally {
      process.off("uncaughtException", onError);
    }
  });

  it("erases the whole screen in the tab's terminal, and what comes after it is drawn", async () => {
    // Text on the bottom row's last column leaves the cursor past it (wrap pending): ED 1 erases
    // the screen, and `after` wraps onto a new line, scrolling the screen up one.
    expect(await viaTab(term(), "top\r\nmid\x1b[3;10HX\x1b[1Jafter", "more")).toBe(
      "normal |\n|\n|\n|aftermore\n@9,2",
    );
    // At the last column without a pending wrap: the same erase, `after` from that column.
    expect(await viaTab(term(), "top\x1b[3;10H\x1b[1Jafter")).toBe("normal |\n|\n|         a\n|fter\n@4,2");
  });

  it("draws the same for DECSED (`ESC[?1J`), the C1 introducer, extra parameters, and split anywhere", async () => {
    const want = "normal |\n|\n|         a\n|fter\n@4,2";
    for (const ed of ["\x1b[?1J", "\u009b1J", "\x1b[01;5J", "\x1b[1:2J"]) {
      expect(await viaTab(term(), `top\x1b[3;10H${ed}after`), JSON.stringify(ed)).toBe(want);
    }
    const whole = "top\x1b[3;10H\x1b[1Jafter";
    for (let i = 0; i <= whole.length; i++) {
      expect(await viaTab(term(), whole.slice(0, i), whole.slice(i)), `split at ${i}`).toBe(want);
    }
  });

  it("draws the same on the alternate screen (which doesn't throw)", async () => {
    expect(await viaTab(term(10, 3), "keep\x1b[?1049hvim\x1b[3;10HX\x1b[1J\x1b[1;1Hok")).toBe("alternate |ok\n|\n|\n@2,0");
  });

  it("draws exactly as plain xterm.js wherever plain xterm.js doesn't throw", async () => {
    // Every cursor position, with and without scrollback, with and without a pending wrap, both
    // screens, ED 1 and DECSED 1: the tab's terminal against a plain one.
    const cols = 6;
    const rows = 4;
    let compared = 0;
    let thrown = 0;
    for (const before of ["ab\r\ncd", "1\r\n2\r\n3\r\n4\r\n5\r\n6", "\x1b[?1049hxy"]) {
      for (let y = 1; y <= rows; y++) {
        for (let x = 1; x <= cols; x++) {
          for (const wrap of ["", "W"]) {
            for (const ed of ["\x1b[1J", "\x1b[?1J"]) {
              const bytes = `${before}\x1b[${y};${x}H${wrap}${ed}tail`;
              const plain = term(cols, rows);
              const errors: unknown[] = [];
              const onError = (e: unknown) => errors.push(e);
              process.on("uncaughtException", onError);
              plain.write(bytes);
              const ok = await settled(plain);
              process.off("uncaughtException", onError);
              const got = await viaTab(term(cols, rows), bytes);
              if (ok === "ok") {
                expect(got, JSON.stringify(bytes)).toBe(screen(plain));
                compared++;
              } else {
                // Where plain xterm.js throws, a correct terminal has erased every row (the
                // cursor is on the bottom one, at its end, with nothing above the screen).
                expect(errors.length).toBe(1);
                const reference = term(cols, rows);
                reference.write(`${before}\x1b[${y};${x}H${wrap}`);
                await settled(reference);
                const blank = Array.from({ length: rows }, () => "|").join("\n");
                const cursor = `@${reference.buffer.active.cursorX},${reference.buffer.active.cursorY}`;
                const erased = term(cols, rows);
                const w = screenWriter(erased);
                w.write(enc(`${before}\x1b[${y};${x}H${wrap}${ed}`), false);
                await settled(erased);
                expect(screen(erased)).toBe(`${reference.buffer.active.type} ${blank}\n${cursor}`);
                expect(got.replaceAll("\n|", "")).toContain("tail");
                thrown++;
              }
              terms.splice(0).forEach((t) => t.dispose());
            }
          }
        }
      }
    }
    expect(compared).toBe(282);
    // the bottom row's last column, with and without a pending wrap, and the column before it
    // with a character that leaves the cursor there; both EDs; only before anything scrolled off
    expect(thrown).toBe(6);
  }, 60_000);
});

describe("every xterm a Session's output reaches keeps going after such an ED 1", () => {
  const ED1 = "\x1b[24;80H\x1b[1J";
  const within = <T>(p: Promise<T>) =>
    Promise.race([p.then(() => "ok"), new Promise((done) => setTimeout(() => done("stuck"), 500))]);

  it("PromptWatch (the fill's prompt check)", async () => {
    const w = new PromptWatch({ cols: 80, rows: 24 }, "ops");
    expect(await within(w.write(`${ED1}\x1b[1;1H[sudo] password for ops: `))).toBe("ok");
    expect(await within(w.write("more"))).toBe("ok");
  });

  it("CommittedLines (Plugins' terminal_output; with no scrollback it never threw)", async () => {
    const c = new CommittedLines({ cols: 80, rows: 24 });
    expect(await within(c.write(`one\r\n${ED1}two\r\n`))).toBe("ok");
    expect(await within(c.write("three\r\n"))).toBe("ok");
  });

  it("the shell hooks' prompt screen", async () => {
    const s = new XtermPromptScreen({ cols: 80, rows: 24 });
    s.write(`${ED1}\x1b[1;1H$ `);
    expect(await within(s.flushed())).toBe("ok");
    expect(s.line().text).toBe("$ ");
  });
});

describe("a CsiClamp bound to an xterm", () => {
  it("keeps the xterm going when xterm.js throws on a sequence, and logs once without the output", async () => {
    const t = term();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new CsiClamp(t);
    // Written past the clamp, so the ED 1 reaches xterm.js as it came and throws inside it.
    t.write("secret-ish\x1b[3;10H\x1b[1Jafter");
    t.write("\x1b[1;1H\x1b[3;10H\x1b[1Jmore");
    expect(await settled(t)).toBe("ok");
    expect(screen(t).replaceAll("\n|", "")).toContain("more");
    expect(catchesThrows(t)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    for (const text of ["secret", "after", "more"]) expect(logged).not.toContain(text);
  });

  it("leaves an unbound clamp's output as it was", () => {
    const c = new CsiClamp();
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(dec(c.clamp(enc("a\x1b[1Jb")))).toBe("a\x1b[1Jb");
  });
});
