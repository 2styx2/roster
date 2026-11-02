// Keys and pastes on their way from a real xterm.js terminal to the Session (ticket 152): Ctrl+V
// pastes the clipboard's text as Windows Terminal does, and goes to the program as ^V when
// there's no text; a voice-typing tool that injects Ctrl+V, or a paste event, pastes once.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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

/** A terminal on a page, wired as TerminalView wires it, with a clock the test moves. */
function open(opts: { clipboard?: Clipboard; windows?: boolean; overrides?: KeymapOverrides; selection?: boolean } = {}) {
  const platform = memoryPlatform({ clipboard: "" });
  const clipboard = opts.clipboard ?? platform.clipboard;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const t = new Terminal({ allowProposedApi: true });
  t.open(host);
  const sent: string[] = [];
  const searches: number[] = [];
  const clock = { now: 1000 };
  const keys = actionsOf(resolveKeymap(opts.overrides ?? {}, { windows: opts.windows ?? true }).terminal);
  const dispose = wireInput(t, host, {
    leader: () => "Ctrl+Space",
    keys: () => keys,
    clipboard: () => clipboard,
    send: (d) => sent.push(d),
    openSearch: () => searches.push(1),
    onZoom: () => {},
    now: () => clock.now,
  });
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  opened.push(() => {
    dispose();
    t.dispose();
    host.remove();
  });
  return { t, platform, clipboard, sent, searches, textarea, clock, host };
}

const KEY_CODES: Record<string, number> = { v: 86, c: 67, a: 65, j: 74, Insert: 45 };

/** A key event as the WebView delivers it (keyCode too: xterm reads it). */
function press(
  target: HTMLElement,
  key: string,
  mods: { ctrl?: boolean; shift?: boolean } = {},
  type: "keydown" | "keypress" | "keyup" = "keydown",
  repeat = false,
) {
  const e = new KeyboardEvent(type, {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    repeat,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(e, "keyCode", { value: KEY_CODES[key] ?? 0 });
  target.dispatchEvent(e);
  return e;
}

/** A paste event, as the WebView fires one for the Edit menu or an injected paste. */
function pasteEvent(target: HTMLElement, text: string) {
  const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  e.clipboardData = { getData: (type: string) => (type === "text/plain" ? text : "") };
  target.dispatchEvent(e);
}

/** Lets the clipboard read finish. */
const settle = () => new Promise((done) => setTimeout(done, 0));

const brackets = (t: Terminal) => new Promise<void>((done) => t.write("\x1b[?2004h", done));

describe("Ctrl+V with text on the clipboard (Windows)", () => {
  it("pastes it through the terminal: line ends as Enter, no ^V", async () => {
    const { sent, textarea, platform } = open();
    await platform.clipboard.writeText("echo one\necho two");
    press(textarea, "v", { ctrl: true });
    await settle();
    expect(sent).toEqual(["echo one\recho two"]);
    expect(sent.join("")).not.toContain("\x16");
  });

  it("pastes several lines as one bracketed paste when the program asked for it", async () => {
    const { t, sent, textarea, platform } = open();
    await brackets(t);
    await platform.clipboard.writeText("echo one\necho two\n");
    press(textarea, "v", { ctrl: true });
    await settle();
    expect(sent).toEqual(["\x1b[200~echo one\recho two\r\x1b[201~"]);
  });

  it("pastes the text just put there, once, when a tool injects Ctrl+V right after (no keyup)", async () => {
    const { sent, textarea, platform } = open();
    await platform.clipboard.writeText("old words");
    await platform.clipboard.writeText("new dictated words");
    press(textarea, "v", { ctrl: true });
    await settle();
    await settle();
    expect(sent).toEqual(["new dictated words"]);
  });

  it("keypress, keyup and key repeat send nothing more", async () => {
    const { sent, textarea, platform } = open();
    await platform.clipboard.writeText("uptime");
    press(textarea, "v", { ctrl: true });
    press(textarea, "v", { ctrl: true }, "keypress");
    press(textarea, "v", { ctrl: true }, "keydown", true);
    press(textarea, "v", { ctrl: true }, "keyup");
    await settle();
    expect(sent).toEqual(["uptime"]);
  });

  it("two presses paste twice", async () => {
    const { sent, textarea, platform, clock } = open();
    await platform.clipboard.writeText("ls");
    press(textarea, "v", { ctrl: true });
    await settle();
    clock.now += 2000;
    press(textarea, "v", { ctrl: true });
    await settle();
    expect(sent).toEqual(["ls", "ls"]);
  });

  it("keys typed while the clipboard is read reach the Session after the paste", async () => {
    const { sent, textarea, platform } = open();
    await platform.clipboard.writeText("cd /tmp");
    press(textarea, "v", { ctrl: true });
    press(textarea, "a");
    await settle();
    await settle();
    expect(sent.join("")).toBe("cd /tmpa");
  });
});

describe("Ctrl+V with no text on the clipboard", () => {
  it.each([
    ["empty (or an image only)", { readText: async () => "", writeText: async () => {} }],
    ["refused", { readText: () => Promise.reject(new Error("denied")), writeText: async () => {} }],
  ])("%s: goes to the program as ^V, once", async (_, clipboard: Clipboard) => {
    const { sent, textarea } = open({ clipboard });
    press(textarea, "v", { ctrl: true });
    press(textarea, "v", { ctrl: true }, "keyup");
    await settle();
    expect(sent).toEqual(["\x16"]);
  });

  it("keeps the order of keys typed after it (Vim's Ctrl+V, then j)", async () => {
    const { sent, textarea } = open();
    press(textarea, "v", { ctrl: true });
    press(textarea, "j");
    await settle();
    await settle();
    expect(sent.join("")).toBe("\x16j");
  });
});

describe("A paste event (the Edit menu, or a tool pasting without a key)", () => {
  it("pastes once", async () => {
    const { sent, textarea } = open();
    pasteEvent(textarea, "whoami");
    await settle();
    expect(sent).toEqual(["whoami"]);
  });

  it("right after an injected Ctrl+V pastes nothing more: one paste in all", async () => {
    const { sent, textarea, platform } = open();
    await platform.clipboard.writeText("dictated");
    press(textarea, "v", { ctrl: true });
    pasteEvent(textarea, "dictated");
    await settle();
    expect(sent).toEqual(["dictated"]);
  });

  it("just before the injected Ctrl+V leaves that key nothing to do: one paste in all", async () => {
    const { sent, textarea, platform } = open();
    await platform.clipboard.writeText("dictated");
    pasteEvent(textarea, "dictated");
    press(textarea, "v", { ctrl: true });
    await settle();
    expect(sent).toEqual(["dictated"]);
  });

  it("a while later is a paste of its own", async () => {
    const { sent, textarea, platform, clock } = open();
    await platform.clipboard.writeText("one");
    press(textarea, "v", { ctrl: true });
    await settle();
    clock.now += 2000;
    pasteEvent(textarea, "two");
    expect(sent).toEqual(["one", "two"]);
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
    const { sent, textarea, platform } = open({ windows: false });
    await platform.clipboard.writeText("text");
    press(textarea, "v", { ctrl: true });
    await settle();
    expect(sent).toEqual(["\x16"]);
  });

  it("unbinding Ctrl+V in init.lua gives the raw ^V back on Windows", async () => {
    const { sent, textarea, platform } = open({ overrides: { terminal: { "Ctrl+v": null } } });
    await platform.clipboard.writeText("text");
    press(textarea, "v", { ctrl: true });
    await settle();
    expect(sent).toEqual(["\x16"]);
  });

  it("binding it off Windows pastes as on Windows", async () => {
    const { sent, textarea, platform } = open({ windows: false, overrides: { terminal: { "Ctrl+v": "terminal.pasteIfText" } } });
    await platform.clipboard.writeText("text");
    press(textarea, "v", { ctrl: true });
    await settle();
    expect(sent).toEqual(["text"]);
  });
});
