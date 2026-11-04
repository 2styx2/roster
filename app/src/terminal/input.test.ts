// Keys and pastes on their way from a real xterm.js terminal to the Session (ticket 152): Ctrl+V
// pastes the clipboard's text as Windows Terminal does, and goes to the program as ^V when
// there's no text; a voice-typing tool that injects Ctrl+V, or a paste event, pastes once. The
// WebView's own paste does the reading: what it found at the key is what's pasted.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { resolveKeymap, actionsOf, type KeymapOverrides } from "../keymap";
import type { Clipboard } from "../platform/types";
import { memoryPlatform } from "../platform/memory";
import { wireInput } from "./input";

beforeAll(() => {
  // xterm asks for the screen's scale; jsdom has no matchMedia.
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia;
});

const opened: (() => void)[] = [];
afterEach(() => {
  while (opened.length) opened.pop()?.();
});

/** A terminal on a page, wired as TerminalView wires it. */
function open(opts: { clipboard?: Clipboard; windows?: boolean; overrides?: KeymapOverrides; selection?: boolean } = {}) {
  const platform = memoryPlatform({ clipboard: "" });
  const clipboard = opts.clipboard ?? platform.clipboard;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const t = new Terminal({ allowProposedApi: true });
  t.open(host);
  const sent: string[] = [];
  const searches: number[] = [];
  const keys = actionsOf(resolveKeymap(opts.overrides ?? {}, { windows: opts.windows ?? true }).terminal);
  const dispose = wireInput(t, host, {
    leader: () => "Ctrl+Space",
    keys: () => keys,
    clipboard: () => clipboard,
    send: (d) => sent.push(d),
    openSearch: () => searches.push(1),
    onZoom: () => {},
  });
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  opened.push(() => {
    dispose();
    t.dispose();
    host.remove();
  });
  return { t, platform, clipboard, sent, searches, textarea, host };
}

const KEY_CODES: Record<string, number> = { v: 86, "м": 86, "ą": 65, b: 66, c: 67, a: 65, j: 74, Insert: 45 };

/** A key event as the WebView delivers it (keyCode too: xterm reads it). */
function press(
  target: HTMLElement,
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; altGraph?: boolean } = {},
  type: "keydown" | "keypress" | "keyup" = "keydown",
  repeat = false,
  code = key.length === 1 ? `Key${key.toUpperCase()}` : key,
) {
  const e = new KeyboardEvent(type, {
    key,
    code,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    repeat,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(e, "keyCode", { value: KEY_CODES[key] ?? 0 });
  if (mods.altGraph) Object.defineProperty(e, "getModifierState", { value: (m: string) => m === "AltGraph" });
  target.dispatchEvent(e);
  return e;
}

/** A paste event, as the WebView fires one for the Edit menu or an injected paste. */
function pasteEvent(target: HTMLElement, text: string) {
  const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  e.clipboardData = { getData: (type: string) => (type === "text/plain" ? text : "") };
  target.dispatchEvent(e);
  return e;
}

/** Lets the clipboard read finish. */
const settle = () => new Promise((done) => setTimeout(done, 0));

const brackets = (t: Terminal) => new Promise<void>((done) => t.write("\x1b[?2004h", done));

/** Ctrl+V as the WebView delivers it: the keydown, then (unless the keydown was prevented) the
 * paste event it fires at once with the clipboard as it is then, then the keyup. Checked in
 * headless Chromium: the paste event comes before the keyup and before a 0 ms timer. */
function ctrlV(target: HTMLElement, clipboard: string | null, key = "v") {
  const down = press(target, key, { ctrl: true }, "keydown", false, "KeyV");
  if (!down.defaultPrevented && clipboard !== null) pasteEvent(target, clipboard);
  press(target, key, { ctrl: true }, "keyup", false, "KeyV");
  return down;
}

describe("Ctrl+V with text on the clipboard (Windows)", () => {
  it("lets the WebView paste: the keydown isn't prevented and xterm sends no ^V", () => {
    const { sent, textarea } = open();
    const down = press(textarea, "v", { ctrl: true });
    expect(down.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
  });

  it("pastes the paste event's text through the terminal: line ends as Enter, no ^V", async () => {
    const { sent, textarea } = open();
    ctrlV(textarea, "echo one\necho two");
    await settle();
    expect(sent).toEqual(["echo one\recho two"]);
  });

  it("pastes several lines as one bracketed paste when the program asked for it", async () => {
    const { t, sent, textarea } = open();
    await brackets(t);
    ctrlV(textarea, "echo one\necho two\n");
    await settle();
    expect(sent).toEqual(["\x1b[200~echo one\recho two\r\x1b[201~"]);
  });

  it("pastes what the injected Ctrl+V found, once, though the tool puts the old clipboard back right after", async () => {
    const { sent, textarea, platform } = open();
    await platform.clipboard.writeText("old secret");
    ctrlV(textarea, "new dictated words");
    await platform.clipboard.writeText("old secret");
    await settle();
    await settle();
    expect(sent).toEqual(["new dictated words"]);
  });

  it("a held Ctrl+V pastes once: a repeat is kept from the WebView", async () => {
    const { sent, textarea } = open();
    ctrlV(textarea, "uptime");
    const repeat = press(textarea, "v", { ctrl: true }, "keydown", true);
    expect(repeat.defaultPrevented).toBe(true);
    await settle();
    expect(sent).toEqual(["uptime"]);
  });

  it("two presses paste twice", async () => {
    const { sent, textarea } = open();
    ctrlV(textarea, "ls");
    ctrlV(textarea, "ls");
    await settle();
    expect(sent).toEqual(["ls", "ls"]);
  });

  it("pastes on a non-Latin layout too, by the physical key (Ctrl+м is Ctrl+V)", async () => {
    const { sent, textarea } = open();
    const down = ctrlV(textarea, "привет", "м");
    expect(down.defaultPrevented).toBe(false);
    await settle();
    expect(sent).toEqual(["привет"]);
  });
});

describe("Ctrl+V with no text on the clipboard", () => {
  it.each([
    ["empty", ""],
    ["an image only", ""],
  ])("%s: goes to the program as ^V, once", async (_, text) => {
    const { sent, textarea } = open();
    ctrlV(textarea, text);
    await settle();
    expect(sent).toEqual(["\x16"]);
  });

  it("when the WebView fires no paste event (refused): ^V, once, at the keyup", async () => {
    const { sent, textarea } = open();
    ctrlV(textarea, null);
    expect(sent).toEqual(["\x16"]);
    await settle();
    expect(sent).toEqual(["\x16"]);
  });

  it("a paste event coming late, after that ^V, is swallowed: never ^V and the text", async () => {
    const { sent, textarea } = open();
    ctrlV(textarea, null);
    const late = pasteEvent(textarea, "dictated");
    await settle();
    expect(sent).toEqual(["\x16"]);
    expect(late.defaultPrevented).toBe(true);
  });

  it("with no keyup and no paste event, ^V comes after a moment; a paste event after it is swallowed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { sent, textarea } = open();
      press(textarea, "v", { ctrl: true });
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(sent).toEqual(["\x16"]);
      pasteEvent(textarea, "dictated");
      expect(sent).toEqual(["\x16"]);
      // Long after, a paste event is a paste of its own.
      vi.advanceTimersByTime(5000);
      pasteEvent(textarea, "later");
      expect(sent).toEqual(["\x16", "later"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the order of keys typed after it (Vim's Ctrl+V, then j)", async () => {
    const { sent, textarea } = open();
    ctrlV(textarea, "");
    press(textarea, "j");
    await settle();
    expect(sent.join("")).toBe("\x16j");
  });

  it("a paste with text right after it still pastes (dictation after an image paste)", async () => {
    const { sent, textarea } = open();
    ctrlV(textarea, "");
    pasteEvent(textarea, "dictated");
    await settle();
    expect(sent).toEqual(["\x16", "dictated"]);
  });

  it("never reads the clipboard itself (no permission prompt, never a stale clipboard)", async () => {
    let reads = 0;
    const clipboard: Clipboard = {
      readText: async () => {
        reads++;
        return "password";
      },
      writeText: async () => {},
    };
    const { sent, textarea } = open({ clipboard });
    ctrlV(textarea, "");
    await settle();
    expect(reads).toBe(0);
    expect(sent).toEqual(["\x16"]);
  });
});

describe("A paste event (the Edit menu, or a tool pasting without a key)", () => {
  it("pastes once, and the text isn't left in xterm's hidden text field", async () => {
    const { sent, textarea } = open();
    const e = pasteEvent(textarea, "whoami");
    await settle();
    expect(sent).toEqual(["whoami"]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("with no text sends nothing (no ^V without the key)", async () => {
    const { sent, textarea } = open();
    pasteEvent(textarea, "");
    await settle();
    expect(sent.join("")).not.toContain("\x16");
  });
});

// Windows Terminal takes every control character but tab, CR and LF out of a paste
// (ControlCore::PasteText, FilterStringForPaste with ControlCodes), so a paste holding the
// bracketed-paste end mark can't end the paste early and run what follows as typed.
describe("A paste can't carry control characters to the program", () => {
  const evil = "safe\x1b[201~rm -rf /tmp/x\n";
  const once = (s: string) => s.split("\x1b[201~").length - 1;

  it("Ctrl+V's paste event: ESC is taken out, so only roster's own end mark ends the paste", async () => {
    const { t, sent, textarea } = open();
    await brackets(t);
    ctrlV(textarea, evil);
    await settle();
    expect(sent).toEqual(["\x1b[200~safe[201~rm -rf /tmp/x\r\x1b[201~"]);
    expect(once(sent.join(""))).toBe(1);
  });

  it.each([
    ["Ctrl+Shift+V", "v", { ctrl: true, shift: true }, "KeyV"],
    ["Shift+Insert", "Insert", { shift: true }, "Insert"],
  ] as const)("%s: the same", async (_, key, mods, code) => {
    const { t, sent, textarea, platform } = open();
    await brackets(t);
    await platform.clipboard.writeText(evil);
    press(textarea, key, mods, "keydown", false, code);
    await settle();
    await settle();
    expect(sent).toEqual(["\x1b[200~safe[201~rm -rf /tmp/x\r\x1b[201~"]);
  });

  it("without bracketed paste too, as Windows Terminal: NUL, ^C, DEL and C1 go, tab and line ends stay", async () => {
    const { sent, textarea } = open();
    pasteEvent(textarea, "a\tb\x00\x03\x7f\x9b31m\r\nc\u00e9\u65e5");
    await settle();
    expect(sent).toEqual(["a\tb31m\rc\u00e9\u65e5"]);
  });

  it("a paste of nothing but control characters sends nothing", async () => {
    const { sent, textarea } = open();
    pasteEvent(textarea, "\x1b\x1b");
    await settle();
    expect(sent).toEqual([]);
  });
});

// #295 review: the WebView's own copy (Cmd+C, Edit > Copy) goes through xterm's copy listener,
// which copies the selection as it is; roster's trims it as every copy route does.
describe("The WebView's own copy event", () => {
  function copyEvent(target: HTMLElement) {
    const data: Record<string, string> = {};
    const e = new Event("copy", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    e.clipboardData = { setData: (type: string, value: string) => void (data[type] = value), getData: (type: string) => data[type] ?? "" };
    target.dispatchEvent(e);
    return { e, data };
  }

  it("copies the selection without the spaces at its lines' ends", async () => {
    const { t, textarea } = open();
    await new Promise<void>((done) => t.write("ab      \r\ncd   \r\n", done));
    t.selectLines(0, 1);
    const { e, data } = copyEvent(textarea);
    expect(e.defaultPrevented).toBe(true);
    expect(data["text/plain"]?.split(/\r?\n/)).toEqual(["ab", "cd"]);
  });

  it("with nothing selected leaves the event alone", () => {
    const { textarea } = open();
    const { e, data } = copyEvent(textarea);
    expect(e.defaultPrevented).toBe(false);
    expect(data).toEqual({});
  });
});

describe("AltGr (Ctrl+Alt on Windows) types its character", () => {
  it("AltGr+A (ą on a Polish layout) isn't taken for a Ctrl+Alt+a binding by its physical key", async () => {
    const { searches, textarea } = open({ overrides: { terminal: { "Ctrl+Alt+a": "terminal.search" } } });
    press(textarea, "ą", { ctrl: true, alt: true, altGraph: true }, "keydown", false, "KeyA");
    press(textarea, "ą", { ctrl: true, alt: true }, "keydown", false, "KeyA");
    expect(searches).toEqual([]);
  });
});

describe("terminal.pasteIfText on another key", () => {
  it("leaves that key to the program: it is Ctrl+V's (the key the WebView pastes with)", async () => {
    const { sent, textarea } = open({ overrides: { terminal: { "Ctrl+b": "terminal.pasteIfText" } } });
    press(textarea, "b", { ctrl: true });
    await settle();
    await settle();
    expect(sent).toEqual(["\x02"]);
  });
});

describe("The other copy and paste keys are unchanged", () => {
  it.each([
    ["Ctrl+Shift+V", "v", { ctrl: true, shift: true }],
    ["Shift+Insert", "Insert", { shift: true }],
  ])("%s pastes the text", async (_, key, mods) => {
    const { sent, textarea, platform } = open();
    await platform.clipboard.writeText("df -h");
    press(textarea, key, mods);
    await settle();
    expect(sent).toEqual(["df -h"]);
  });

  it("Ctrl+Shift+V with nothing on the clipboard does nothing", async () => {
    const { sent, textarea } = open();
    press(textarea, "v", { ctrl: true, shift: true });
    await settle();
    expect(sent).toEqual([]);
  });

  it("Ctrl+C copies a selection, else it's the shell's interrupt", async () => {
    const { t, sent, textarea, platform } = open();
    await new Promise<void>((done) => t.write("hello", done));
    t.selectAll();
    press(textarea, "c", { ctrl: true });
    await settle();
    expect(platform.clipboardText()).toContain("hello");
    expect(sent).toEqual([]);
    press(textarea, "c", { ctrl: true });
    expect(sent).toEqual(["\x03"]);
  });
});

describe("Off Windows, or unbound", () => {
  it("Ctrl+V is the program's ^V, clipboard or not", async () => {
    const { sent, textarea } = open({ windows: false });
    const down = press(textarea, "v", { ctrl: true });
    expect(down.defaultPrevented).toBe(true);
    await settle();
    expect(sent).toEqual(["\x16"]);
  });

  it("unbinding Ctrl+V in init.lua gives the raw ^V back on Windows", async () => {
    const { sent, textarea } = open({ overrides: { terminal: { "Ctrl+v": null } } });
    press(textarea, "v", { ctrl: true });
    await settle();
    expect(sent).toEqual(["\x16"]);
  });

  it("binding it off Windows pastes as on Windows", async () => {
    const { sent, textarea } = open({ windows: false, overrides: { terminal: { "Ctrl+v": "terminal.pasteIfText" } } });
    ctrlV(textarea, "text");
    await settle();
    expect(sent).toEqual(["text"]);
  });
});
