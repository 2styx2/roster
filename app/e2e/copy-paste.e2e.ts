// Copy and paste in a Session, end to end (T158, #294): roster's real TerminalView (xterm.js,
// input.ts, clipboard.ts) in headless Chromium, real key and mouse events, the browser's own
// paste, a fake Session that records every byte the terminal sends it and a clipboard the test
// sets and reads. Each path in #294 has a test here; docs/app/dev/copy-paste-checklist.md is what
// only the Windows build can show (WebView2, ConPTY, voice typing, real programs).
//
// Tests marked #293 are T157's (OSC 52 writes, right-click under mouse reporting, decision Q149).
import type { Browser } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALT, CTRL, launch, openHarness, type Harness } from "./browser";

let browser: Browser;
let h: Harness;
const pages: Harness[] = [];

beforeAll(async () => {
  browser = await launch();
  h = await openHarness(browser);
  pages.push(h);
});
afterAll(async () => {
  await browser?.close();
});

/** Every clipboard text a test used: none may show up in a log (a paste may be a password). */
const secrets = new Set<string>();
const clip = async (text: string) => {
  secrets.add(text);
  await h.setClipboard(text);
};
afterEach(() => {
  for (const p of pages) {
    for (const line of p.logs) for (const s of secrets) if (s.trim().length > 3) expect(line).not.toContain(s);
    p.logs.length = 0;
  }
  secrets.clear();
});

const BRACKETED = "\x1b[?2004h";
const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const ALT_SCREEN = "\x1b[?1049h";
const b = (s: string) => `\x1b[200~${s}\x1b[201~`;

describe("paste", () => {
  beforeEach(() => h.mount({ windows: true }));

  it("Ctrl+V (Windows) pastes the clipboard's text once, line ends as Enter, nothing left in the text field", async () => {
    await clip("echo one\necho two");
    await h.page.keyboard.press("Control+v");
    await h.settled();
    expect(await h.sent()).toEqual(["echo one\recho two"]);
    expect(await h.textareaValue()).toBe("");
    // The WebView's paste read it, not roster.
    expect(await h.reads()).toBe(0);
  });

  it("Ctrl+V with an empty clipboard sends ^V to the program", async () => {
    await h.setClipboard("");
    await h.page.keyboard.press("Control+v");
    expect(await h.sentCount(1)).toEqual(["\x16"]);
  });

  it("Ctrl+V with only an image on the clipboard sends ^V (the program's own image paste)", async () => {
    await h.setClipboardImage();
    await h.page.keyboard.press("Control+v");
    expect(await h.sentCount(1)).toEqual(["\x16"]);
  });

  it("a voice-typing tool's Ctrl+V pastes what it put there, though it puts the old clipboard back before the keyup", async () => {
    secrets.add("old secret");
    await clip("dictated words");
    await h.page.keyboard.down("Control");
    await h.page.keyboard.down("v");
    await h.setClipboard("old secret");
    await h.page.keyboard.up("v");
    await h.page.keyboard.up("Control");
    await h.settled();
    expect(await h.sent()).toEqual(["dictated words"]);
  });

  it("a held Ctrl+V pastes once", async () => {
    await clip("x");
    await h.page.keyboard.down("Control");
    await h.page.keyboard.down("v");
    await h.page.keyboard.down("v"); // repeat
    await h.page.keyboard.down("v"); // repeat
    await h.page.keyboard.up("v");
    await h.page.keyboard.up("Control");
    await h.settled();
    expect(await h.sent()).toEqual(["x"]);
  });

  it("Ctrl+V then a key: ^V and the key, in order (empty clipboard)", async () => {
    await h.setClipboard("");
    await h.page.keyboard.press("Control+v");
    await h.page.keyboard.press("j");
    expect(await h.sentCount(2)).toEqual(["\x16", "j"]);
  });

  it("Ctrl+Shift+V pastes once, from roster's clipboard read", async () => {
    await clip("ls -la");
    await h.page.keyboard.press("Control+Shift+v");
    expect(await h.sentCount(1)).toEqual(["ls -la"]);
    await h.settled();
    expect(await h.sent()).toEqual(["ls -la"]);
    expect(await h.reads()).toBe(1);
    expect(await h.textareaValue()).toBe("");
  });

  it("Ctrl+Shift+V with an empty clipboard sends nothing", async () => {
    await h.setClipboard("");
    await h.page.keyboard.press("Control+Shift+v");
    await h.page.keyboard.press("j");
    expect(await h.sentCount(1)).toEqual(["j"]);
  });

  it("Shift+Insert pastes once", async () => {
    await clip("uptime");
    await h.page.keyboard.press("Shift+Insert");
    expect(await h.sentCount(1)).toEqual(["uptime"]);
    await h.settled();
    expect(await h.sent()).toEqual(["uptime"]);
  });

  it("right-click with no selection pastes", async () => {
    await clip("whoami");
    await h.rightClick(2, 2);
    expect(await h.sentCount(1)).toEqual(["whoami"]);
    await h.settled();
    expect(await h.sent()).toEqual(["whoami"]);
  });

  it("right-click does nothing when terminal.right_click_paste is off", async () => {
    await h.mount({ windows: true, rightClickCopyPaste: false });
    await clip("whoami");
    await h.rightClick(2, 2);
    await h.page.keyboard.press("j");
    expect(await h.sentCount(1)).toEqual(["j"]);
    expect(await h.reads()).toBe(0);
  });

  it("a paste event with no key (the Edit menu, a tool's injected paste) pastes once", async () => {
    await h.page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "from the menu\n");
      document.querySelector(".xterm-helper-textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await h.settled();
    expect(await h.sent()).toEqual(["from the menu\r"]);
    expect(await h.textareaValue()).toBe("");
  });

  it("Ctrl+м on a Russian layout (the physical V key) pastes as Ctrl+V does", async () => {
    await clip("privet");
    await h.rawKey("keyDown", "м", "KeyV", 86, CTRL);
    await h.rawKey("keyUp", "м", "KeyV", 86, CTRL);
    await h.settled();
    expect(await h.sent()).toEqual(["privet"]);
  });

  it("AltGr (Ctrl+Alt) letters type their character, never a paste or a copy", async () => {
    await clip("not pasted");
    // AltGr+A on a Polish layout types ą; Windows reports AltGr as Ctrl+Alt.
    await h.rawKey("keyDown", "ą", "KeyA", 65, CTRL | ALT, "ą");
    await h.rawKey("keyUp", "ą", "KeyA", 65, CTRL | ALT);
    await h.settled();
    expect(await h.sent()).toEqual(["ą"]);
    expect(await h.reads()).toBe(0);
  });
});

describe("off Windows (Linux and macOS terminals' keys, decision Q138)", () => {
  let linux: Harness;
  beforeAll(async () => {
    linux = await openHarness(browser, { os: "linux" });
    pages.push(linux);
  });
  beforeEach(() => linux.mount({ windows: false }));

  it("Ctrl+V is the program's: ^V, and the clipboard isn't pasted", async () => {
    secrets.add("not pasted");
    await linux.setClipboard("not pasted");
    await linux.page.keyboard.press("Control+v");
    await linux.page.keyboard.press("j");
    expect(await linux.sentCount(2)).toEqual(["\x16", "j"]);
    expect(await linux.reads()).toBe(0);
  });

  it("Ctrl+Shift+V pastes", async () => {
    await linux.setClipboard("pasted");
    await linux.page.keyboard.press("Control+Shift+v");
    expect(await linux.sentCount(1)).toEqual(["pasted"]);
  });

  it("copies several lines joined by \\n, as Linux terminals do (#302)", async () => {
    const { cols } = await linux.size();
    await linux.output("first  \r\nsecond\r\nthird\r\n");
    await linux.drag([0, 0], [cols - 1, 2]);
    expect(await linux.copiedCount(1)).toEqual(["first\nsecond\nthird"]);
  });
});

describe("copy", () => {
  beforeEach(async () => {
    await h.mount({ windows: true });
    await h.output("hello world\r\nsecond line\r\n$ ");
  });

  it("dragging selects, and the selection is copied (terminal.copy_on_select)", async () => {
    await h.drag([0, 0], [4, 0]);
    expect(await h.selection()).toBe("hello");
    expect(await h.copiedCount(1)).toEqual(["hello"]);
  });

  it("with terminal.copy_on_select off, selecting copies nothing until a copy key", async () => {
    await h.mount({ windows: true, copyOnSelect: false });
    await h.output("hello world\r\n");
    await h.drag([0, 0], [4, 0]);
    expect(await h.selection()).toBe("hello");
    // Past copy-on-select's 120 ms, on the page's clock.
    await h.page.clock.runFor(1000);
    expect(await h.copied()).toEqual([]);
    await h.page.keyboard.press("Control+Shift+c");
    expect(await h.copiedCount(1)).toEqual(["hello"]);
  });

  it("Ctrl+C with a selection copies it, clears it, and sends nothing", async () => {
    await h.mount({ windows: true, copyOnSelect: false });
    await h.output("hello world\r\n");
    await h.drag([6, 0], [10, 0]);
    await h.page.keyboard.press("Control+c");
    expect(await h.copiedCount(1)).toEqual(["world"]);
    expect(await h.hasSelection()).toBe(false);
    await h.page.keyboard.press("j");
    expect(await h.sentCount(1)).toEqual(["j"]);
  });

  it("Ctrl+C without a selection is the interrupt (^C), and copies nothing", async () => {
    await h.page.keyboard.press("Control+c");
    expect(await h.sentCount(1)).toEqual(["\x03"]);
    expect(await h.copied()).toEqual([]);
  });

  it("a second Ctrl+C after a copy interrupts (the copy cleared the selection)", async () => {
    await h.mount({ windows: true, copyOnSelect: false });
    await h.output("hello world\r\n");
    await h.drag([0, 0], [4, 0]);
    await h.page.keyboard.press("Control+c");
    await h.page.keyboard.press("Control+c");
    expect(await h.sentCount(1)).toEqual(["\x03"]);
    expect(await h.copied()).toEqual(["hello"]);
  });

  it("Ctrl+с on a Russian layout (the physical C key) copies a selection", async () => {
    await h.mount({ windows: true, copyOnSelect: false });
    await h.output("hello world\r\n");
    await h.select(0, 0, 5);
    await h.rawKey("keyDown", "с", "KeyC", 67, CTRL);
    await h.rawKey("keyUp", "с", "KeyC", 67, CTRL);
    expect(await h.copiedCount(1)).toEqual(["hello"]);
    await h.settled();
    expect(await h.sent()).toEqual([]);
  });

  it("Ctrl+Shift+C copies the selection and keeps it; without one it does nothing", async () => {
    await h.mount({ windows: true, copyOnSelect: false });
    await h.output("hello world\r\n");
    await h.page.keyboard.press("Control+Shift+c");
    await h.select(0, 0, 5);
    await h.page.keyboard.press("Control+Shift+c");
    expect(await h.copiedCount(1)).toEqual(["hello"]);
    expect(await h.hasSelection()).toBe(true);
    await h.settled();
    expect(await h.sent()).toEqual([]);
  });

  it("Ctrl+Insert copies the selection", async () => {
    await h.mount({ windows: true, copyOnSelect: false });
    await h.output("hello world\r\n");
    await h.select(6, 0, 5);
    await h.page.keyboard.press("Control+Insert");
    expect(await h.copiedCount(1)).toEqual(["world"]);
    await h.settled();
    expect(await h.sent()).toEqual([]);
  });

  it("right-click with a selection copies it, clears it, and pastes nothing", async () => {
    await h.mount({ windows: true, copyOnSelect: false });
    await h.output("hello world\r\n");
    await clip("on the clipboard before");
    await h.drag([0, 0], [4, 0]);
    await h.rightClick(2, 0);
    expect(await h.copiedCount(1)).toEqual(["hello"]);
    expect(await h.hasSelection()).toBe(false);
    await h.settled();
    expect(await h.sent()).toEqual([]);
    expect(await h.reads()).toBe(0);
  });

  // T160 (#302): Windows Terminal ends copied lines with \r\n (TextBuffer::GetPlainText), so
  // every copy route does on Windows: copy-on-select, Ctrl+C, right-click and the WebView's copy.
  it("on Windows, several lines copy with \\r\\n line ends, by every copy route (#302)", async () => {
    const { cols } = await h.size();
    await h.mount({ windows: true, copyOnSelect: true });
    await h.output("first  \r\nsecond\r\nthird\r\n");
    const lines = "first\r\nsecond\r\nthird";
    await h.drag([0, 0], [cols - 1, 2]);
    expect(await h.copiedCount(1)).toEqual([lines]);
    await h.page.keyboard.press("Control+c");
    expect(await h.copiedCount(2)).toEqual([lines, lines]);
    await h.drag([0, 0], [cols - 1, 2]);
    await h.copiedCount(3);
    await h.rightClick(1, 0);
    expect(await h.copiedCount(4)).toEqual([lines, lines, lines, lines]);
    await h.drag([0, 0], [cols - 1, 2]);
    await h.copiedCount(5);
    const viaCopyEvent = await h.page.evaluate(() => {
      let text = "";
      const e = new Event("copy", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      e.clipboardData = { setData: (_: string, v: string) => void (text = v), getData: () => "" };
      document.querySelector(".xterm-helper-textarea")!.dispatchEvent(e);
      return text;
    });
    expect(viaCopyEvent).toBe(lines);
  });

  it("copy then Ctrl+V pastes what was copied", async () => {
    await h.drag([0, 1], [5, 1]);
    await h.copiedCount(1);
    await h.page.keyboard.press("Control+v");
    expect(await h.sentCount(1)).toEqual(["second"]);
  });
});

describe("content", () => {
  beforeEach(() => h.mount({ windows: true }));

  it("several lines go in as one bracketed paste when the program asked for it", async () => {
    await h.output(BRACKETED);
    await clip("echo one\necho two\n");
    await h.page.keyboard.press("Control+v");
    await h.settled();
    expect(await h.sent()).toEqual([b("echo one\recho two\r")]);
  });

  it("the same through Ctrl+Shift+V and right-click", async () => {
    await h.output(BRACKETED);
    await clip("a\nb");
    await h.page.keyboard.press("Control+Shift+v");
    await h.sentCount(1);
    await h.rightClick(1, 1);
    expect(await h.sentCount(2)).toEqual([b("a\rb"), b("a\rb")]);
  });

  it("CRLF line ends (Windows apps) become one Enter each, not two", async () => {
    await clip("one\r\ntwo\r\nthree\r\n");
    await h.page.keyboard.press("Control+v");
    await h.settled();
    expect(await h.sent()).toEqual(["one\rtwo\rthree\r"]);
  });

  // xterm.js 6 puts the text between the marks as it is, so text holding the end mark would end
  // the bracketed paste early and run what follows as typed (a paste "injection"). Every paste
  // goes through clipboard.ts pasteFilter, which takes control characters out as Windows
  // Terminal does (ControlCore::PasteText, FilterStringForPaste).
  it("a bracketed paste can't be ended early by an end mark inside the text", async () => {
    await h.output(BRACKETED);
    await clip("safe\x1b[201~rm -rf /tmp/x\n");
    await h.page.keyboard.press("Control+Shift+v");
    const [sent] = await h.sentCount(1);
    // Only the closing mark: the text's own one is taken out.
    expect(sent!.split("\x1b[201~").length - 1).toBe(1);
    expect(sent!.endsWith("\x1b[201~")).toBe(true);
  });

  it("a large paste (200 KB) arrives whole and in order, through Ctrl+V and Ctrl+Shift+V", async () => {
    const line = (i: number) => `${String(i).padStart(6, "0")} ${"abcdefghij".repeat(7)}`;
    const text = Array.from({ length: 2600 }, (_, i) => line(i)).join("\n");
    expect(text.length).toBeGreaterThan(200_000);
    await clip(text);
    await h.page.keyboard.press("Control+v");
    await h.settled();
    expect((await h.sent()).join("")).toBe(text.replace(/\n/g, "\r"));
    await h.mount({ windows: true });
    await h.output(BRACKETED);
    await clip(text);
    await h.page.keyboard.press("Control+Shift+v");
    await h.sentCount(1);
    await h.settled();
    expect((await h.sent()).join("")).toBe(b(text.replace(/\n/g, "\r")));
  });

  const unicode = {
    CJK: "日本語のテキスト 中文 한국어",
    "combining marks": "é ñ ǟ",
    emoji: "ok 👍🏽 👨‍👩‍👧 🇳🇿",
    RTL: "שלום עולם مرحبا",
    tabs: "a\tb\t\tc",
  };
  for (const [name, text] of Object.entries(unicode)) {
    it(`pastes ${name} unchanged`, async () => {
      await clip(text);
      await h.page.keyboard.press("Control+v");
      await h.settled();
      expect(await h.sent()).toEqual([text]);
    });
  }

  for (const name of ["CJK", "combining marks", "emoji", "RTL"] as const) {
    it(`copies ${name} as it was printed`, async () => {
      const text = unicode[name];
      await h.output(`${text}\r\n`);
      await h.select(0, 0, 40);
      await h.page.keyboard.press("Control+Shift+c");
      const [copied] = await h.copiedCount(1);
      expect(copied!.trimEnd()).toBe(text);
    });
  }

  it("copies full-width (CJK) cells without a space for the second half of each", async () => {
    await h.output("日本語x\r\n");
    // 日本語 is six cells; x is the seventh.
    await h.drag([0, 0], [6, 0]);
    expect(await h.copiedCount(1)).toEqual(["日本語x"]);
  });

  it("copies a line that wrapped as one line, with no line end where it wrapped", async () => {
    const { cols } = await h.size();
    const long = Array.from({ length: cols + 10 }, (_, i) => "0123456789"[i % 10]).join("");
    await h.output(`${long}\r\nnext\r\n`);
    // Rows 0 and 1 are the one wrapped line; row 2 is "next".
    await h.drag([0, 0], [9, 1]);
    expect(await h.copiedCount(1)).toEqual([long]);
  });

  it("copies several lines without the empty cells after them, joined by line ends", async () => {
    const { cols } = await h.size();
    await h.output("first\r\nsecond\r\nthird\r\n");
    await h.drag([0, 0], [cols - 1, 2]);
    const [copied] = await h.copiedCount(1);
    expect(copied!.split(/\r?\n/)).toEqual(["first", "second", "third"]);
  });

  // xterm.js keeps spaces a program printed at the end of a line (it drops only cells nothing
  // was written to); clipboard.ts copiedText trims them off each line, as Windows Terminal does
  // (TextBuffer CopyRequest, trimTrailingWhitespace).
  it("copies several lines without the spaces printed at their ends, as Windows Terminal does", async () => {
    const { cols } = await h.size();
    await h.output("first   \r\nsecond\r\nthird\r\n");
    await h.drag([0, 0], [cols - 1, 2]);
    const [copied] = await h.copiedCount(1);
    expect(copied!.split(/\r?\n/)).toEqual(["first", "second", "third"]);
  });

  it("a selection past the end of the last line copies no trailing line ends", async () => {
    const { cols } = await h.size();
    await h.output("only line\r\n");
    await h.drag([0, 0], [cols - 1, 4]);
    const [copied] = await h.copiedCount(1);
    expect(copied!.replace(/[\r\n]+$/, "")).toBe("only line");
  });

  it("copies a tab as the spaces it was drawn as", async () => {
    await h.output("a\tb\r\n");
    await h.select(0, 0, 9);
    await h.page.keyboard.press("Control+Shift+c");
    const [copied] = await h.copiedCount(1);
    expect(copied!.trimEnd()).toMatch(/^a\s+b$/);
  });
});

describe("programs", () => {
  beforeEach(() => h.mount({ windows: true }));

  it("with mouse reporting on, a drag goes to the program and selects nothing", async () => {
    await h.output(`${ALT_SCREEN}${MOUSE_ON}some text here\r\n`);
    expect((await h.modes()).mouse).not.toBe("none");
    await h.drag([0, 0], [4, 0]);
    await h.settled();
    // SGR mouse reports: a press on the first cell, motion with the button held, a release.
    const sent = await h.sent();
    expect(sent[0]).toBe("\x1b[<0;1;1M");
    expect(sent.slice(1, -1).every((r) => r.startsWith("\x1b[<32;"))).toBe(true);
    expect(sent.at(-1)).toMatch(/;1m$/);
    expect(await h.hasSelection()).toBe(false);
    expect(await h.copied()).toEqual([]);
  });

  it("with mouse reporting on, Shift+drag selects (and copies), and the program hears nothing", async () => {
    await h.output(`${ALT_SCREEN}${MOUSE_ON}some text here\r\n`);
    await h.drag([0, 0], [3, 0], { shift: true });
    expect(await h.selection()).toBe("some");
    expect(await h.copiedCount(1)).toEqual(["some"]);
    await h.settled();
    expect(await h.sent()).toEqual([]);
  });

  it("with mouse reporting on, Shift+drag then Ctrl+C copies, and right-click with that selection copies", async () => {
    await h.mount({ windows: true, copyOnSelect: false });
    await h.output(`${ALT_SCREEN}${MOUSE_ON}some text here\r\n`);
    await h.drag([5, 0], [8, 0], { shift: true });
    await h.page.keyboard.press("Control+c");
    expect(await h.copiedCount(1)).toEqual(["text"]);
    await h.drag([0, 0], [3, 0], { shift: true });
    await h.rightClick(1, 0, { shift: true });
    expect(await h.copiedCount(2)).toEqual(["text", "some"]);
    expect(await h.hasSelection()).toBe(false);
  });

  // #293: right-click with no selection while the program reports the mouse goes to the program,
  // as in Windows Terminal (ControlInteractivity.cpp PointerPressed: _canSendVTMouseInput comes
  // before its copy-or-paste rule); Shift+right-click still pastes.
  it("with mouse reporting on and no selection, right-click goes to the program, not a paste (#293)", async () => {
    await h.output(`${ALT_SCREEN}${MOUSE_ON}`);
    await clip("not pasted");
    await h.rightClick(2, 0);
    const sent = await h.sentCount(2);
    expect(sent.join("")).toBe("\x1b[<2;3;1M\x1b[<2;3;1m");
    expect(await h.reads()).toBe(0);
  });

  it("with mouse reporting on, Shift+right-click with no selection pastes (stays so with #293)", async () => {
    await h.output(`${ALT_SCREEN}${MOUSE_ON}`);
    await clip("pasted");
    await h.rightClick(2, 0, { shift: true });
    expect(await h.sentCount(1)).toEqual(["pasted"]);
  });

  it("in the alternate screen (a full-screen program), paste and copy work as in the shell", async () => {
    await h.mount({ windows: true, copyOnSelect: false });
    await h.output(`${ALT_SCREEN}${BRACKETED}\x1b[Hfull screen\r\n`);
    expect((await h.modes()).alternate).toBe(true);
    await clip("i\n");
    await h.page.keyboard.press("Control+v");
    await h.select(0, 0, 4);
    await h.page.keyboard.press("Control+c");
    expect(await h.copiedCount(1)).toEqual(["full"]);
    expect(await h.sent()).toEqual([b("i\r")]);
  });

  it("at a password prompt, a paste goes to the Session only: not on screen, not in the text field, not in a log", async () => {
    const password = "correct-horse-battery-staple";
    // The PTY has echo off: the Session prints nothing back.
    await h.output("[sudo] password for you: ");
    await clip(password);
    await h.page.keyboard.press("Control+v");
    await h.page.keyboard.press("Enter");
    expect(await h.sentCount(2)).toEqual([password, "\r"]);
    expect(await h.textareaValue()).toBe("");
    const page = await h.page.evaluate(() => ({
      text: document.body.innerText,
      html: document.documentElement.outerHTML,
      storage: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    }));
    expect(page.text).not.toContain(password);
    expect(page.html).not.toContain(password);
    expect(page.storage).not.toContain(password);
  });
});

describe("OSC 52", () => {
  beforeEach(() => h.mount({ windows: true }));
  const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;

  it("a read request (?) is never answered: nothing reaches the Session, the clipboard isn't read", async () => {
    await clip("clipboard secret");
    await h.output("\x1b]52;c;?\x07\x1b]52;;?\x1b\\");
    await h.page.keyboard.press("j");
    expect(await h.sentCount(1)).toEqual(["j"]);
    expect(await h.reads()).toBe(0);
  });

  // Its text is set as the program sent it, line ends too (\n stays \n on Windows), as Windows
  // Terminal's OSC 52 (Terminal::CopyToClipboard passes it on unchanged; #302).
  it("a program's write (Claude Code, tmux, vim) sets the clipboard (#293)", async () => {
    await h.output(osc52("copied by the program\n日本語"));
    expect(await h.copiedCount(1)).toEqual(["copied by the program\n日本語"]);
    await h.settled();
    expect(await h.sent()).toEqual([]);
  });

  it("a write from a Session that isn't on screen doesn't set the clipboard (#293)", async () => {
    await h.setActive(false);
    await h.output(osc52("from a hidden tab"));
    await h.setActive(true);
    await h.output(osc52("from the tab on screen"));
    expect(await h.copiedCount(1)).toEqual(["from the tab on screen"]);
  });

  it("a write and then a read request: the write lands, the read is still not answered (#293)", async () => {
    await h.output(osc52("written") + "\x1b]52;c;?\x07");
    expect(await h.copiedCount(1)).toEqual(["written"]);
    await h.page.keyboard.press("j");
    expect(await h.sentCount(1)).toEqual(["j"]);
    expect(await h.reads()).toBe(0);
  });
});

// T160 (#302): on macOS, Option takes the mouse back from a program, as Shift does elsewhere
// (xterm's macOptionClickForcesSelection, on in roster; iTerm2 and Terminal.app use Option too).
describe("macOS: Option takes the mouse back from a program (#302)", () => {
  let mac: Harness;
  beforeAll(async () => {
    mac = await openHarness(browser, { os: "mac" });
    pages.push(mac);
  });
  beforeEach(() => mac.mount({ windows: false }));

  it("with mouse reporting on, Option+drag selects (and copies), and the program hears nothing", async () => {
    await mac.output(`${ALT_SCREEN}${MOUSE_ON}some text here\r\n`);
    await mac.drag([0, 0], [3, 0], { alt: true });
    expect(await mac.selection()).toBe("some");
    expect(await mac.copiedCount(1)).toEqual(["some"]);
    await mac.settled();
    expect(await mac.sent()).toEqual([]);
  });

  it("with mouse reporting on, Option+right-click with no selection pastes", async () => {
    await mac.output(`${ALT_SCREEN}${MOUSE_ON}`);
    secrets.add("pasted on a mac");
    await mac.setClipboard("pasted on a mac");
    await mac.rightClick(2, 0, { alt: true });
    expect(await mac.sentCount(1)).toEqual(["pasted on a mac"]);
  });

  it("with mouse reporting on and no selection, a plain right-click is still the program's", async () => {
    await mac.output(`${ALT_SCREEN}${MOUSE_ON}`);
    secrets.add("not pasted on a mac");
    await mac.setClipboard("not pasted on a mac");
    await mac.rightClick(2, 0);
    expect((await mac.sentCount(2)).join("")).toBe("\x1b[<2;3;1M\x1b[<2;3;1m");
    expect(await mac.reads()).toBe(0);
  });

  it("copies several lines joined by \\n, as macOS terminals do", async () => {
    const { cols } = await mac.size();
    await mac.output("first\r\nsecond\r\nthird\r\n");
    await mac.drag([0, 0], [cols - 1, 2]);
    expect(await mac.copiedCount(1)).toEqual(["first\nsecond\nthird"]);
  });
});
