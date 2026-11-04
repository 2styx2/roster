// The suite's side of e2e/harness.tsx: one headless Chromium per test file, one page on the
// harness, and typed calls into `window.e2e`. Every wait is for something the page does (a byte
// sent, a write parsed, a clipboard write), never for a while (docs/app/dev/testing.md, T146).
import { chromium, type Browser, type Page } from "playwright-core";
import { inject } from "vitest";
import type { E2E, MountOptions } from "./harness";

type Win = Window & { e2e: E2E };

export interface Harness {
  page: Page;
  /** Every console message and page error so far (none may hold clipboard text). */
  logs: string[];
  mount(opts?: MountOptions): Promise<void>;
  sent(): Promise<string[]>;
  copied(): Promise<string[]>;
  reads(): Promise<number>;
  setClipboard(text: string): Promise<void>;
  /** Only an image on the browser's clipboard (and roster's reads give ""). */
  setClipboardImage(): Promise<void>;
  output(data: string): Promise<void>;
  /** Shows or hides the terminal, as switching tabs does. */
  setActive(active: boolean): Promise<void>;
  selection(): Promise<string>;
  hasSelection(): Promise<boolean>;
  select(col: number, row: number, length: number): Promise<void>;
  textareaValue(): Promise<string>;
  /** The terminal's size in cells. */
  size(): Promise<{ cols: number; rows: number }>;
  modes(): Promise<ReturnType<E2E["modes"]>>;
  /** Drags the mouse from one cell to another (holding Shift, or Alt (Option), when asked). */
  drag(from: [number, number], to: [number, number], opts?: Mods): Promise<void>;
  /** A right-click on a cell. */
  rightClick(col: number, row: number, opts?: Mods): Promise<void>;
  /** Lets every event, microtask and 0 ms timer the last action queued run (not a wait for time). */
  settled(): Promise<void>;
  /** Waits until the Session has been sent `n` chunks. */
  sentCount(n: number): Promise<string[]>;
  /** Waits until roster has written the clipboard `n` times. */
  copiedCount(n: number): Promise<string[]>;
  /** A key as the OS delivers it, through the DevTools protocol (for layouts Playwright can't type). */
  rawKey(type: "keyDown" | "keyUp", key: string, code: string, keyCode: number, modifiers: number, text?: string): Promise<void>;
}

/** Keys held through a mouse action. */
export interface Mods {
  shift?: boolean;
  alt?: boolean;
}

export async function launch(): Promise<Browser> {
  // The Chromium playwright-core 1.64.1 pins (npx playwright-core install chromium-headless-shell),
  // or $CHROME.
  return chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME, args: ["--no-sandbox"] } : {});
}

/** A Chrome on Windows, as WebView2 reports itself. */
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0";

/** WKWebView on macOS, as Tauri's reports itself. */
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/** A page on the harness. `os: "windows"` (the default) makes the page look like WebView2 on
 * Windows to xterm.js and roster (navigator.platform and the user agent), so xterm's Windows
 * handling (AltGr as Ctrl+Alt) is what runs; "mac" like the WebView on macOS (xterm's isMac, so
 * Option is the key that takes the mouse back); "linux" is the headless Chromium as it is. */
export async function openHarness(browser: Browser, opts: { os?: "windows" | "mac" | "linux" } = {}): Promise<Harness> {
  const os = opts.os ?? "windows";
  const platform = os === "windows" ? "Win32" : os === "mac" ? "MacIntel" : null;
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
    viewport: { width: 900, height: 500 },
    ...(os === "windows" ? { userAgent: WINDOWS_UA } : os === "mac" ? { userAgent: MAC_UA } : {}),
  });
  if (platform) await context.addInitScript((p) => Object.defineProperty(Navigator.prototype, "platform", { get: () => p }), platform);
  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  // The page's timers on Playwright's clock: time still passes as usual, and a test that must get
  // past one of the code's own timers moves it on (`page.clock.runFor`) instead of waiting.
  await page.clock.install();
  await page.goto(inject("url"));
  await page.waitForFunction(() => "e2e" in window);
  const cell = (col: number, row: number) => page.evaluate(([c, r]) => (window as unknown as Win).e2e.cell(c, r), [col, row] as const);
  const cdp = await context.newCDPSession(page);
  const hold = async (mods: Mods, dir: "down" | "up") => {
    for (const [on, key] of [[mods.shift, "Shift"], [mods.alt, "Alt"]] as const) if (on) await page.keyboard[dir](key);
  };
  const h: Harness = {
    page,
    logs,
    mount: (opts = {}) => page.evaluate((o) => (window as unknown as Win).e2e.mount(o), opts),
    sent: () => page.evaluate(() => [...(window as unknown as Win).e2e.sent]),
    copied: () => page.evaluate(() => [...(window as unknown as Win).e2e.copied]),
    reads: () => page.evaluate(() => (window as unknown as Win).e2e.reads),
    setClipboard: (text) => page.evaluate((t) => (window as unknown as Win).e2e.setClipboard(t), text),
    setClipboardImage: () => page.evaluate(() => (window as unknown as Win).e2e.setClipboardImage()),
    setActive: (active) => page.evaluate((a) => (window as unknown as Win).e2e.setActive(a), active),
    output: (data) => page.evaluate((d) => (window as unknown as Win).e2e.output(d), data),
    selection: () => page.evaluate(() => (window as unknown as Win).e2e.selection()),
    hasSelection: () => page.evaluate(() => (window as unknown as Win).e2e.hasSelection()),
    select: (col, row, length) => page.evaluate(([c, r, l]) => (window as unknown as Win).e2e.select(c, r, l), [col, row, length] as const),
    size: () => page.evaluate(() => (window as unknown as Win).e2e.size()),
    textareaValue: () => page.evaluate(() => (window as unknown as Win).e2e.textareaValue()),
    modes: () => page.evaluate(() => (window as unknown as Win).e2e.modes()),
    async drag(from, to, opts = {}) {
      const a = await cell(...from);
      const b = await cell(...to);
      await hold(opts, "down");
      // From the left edge of the first cell to the right edge of the last, so both are in.
      const half = (b.x - a.x) / Math.max(1, Math.abs(to[0] - from[0])) / 2 || 4;
      await page.mouse.move(a.x - half + 1, a.y);
      await page.mouse.down();
      // One move: the selection changes once, to the whole of it, so copy-on-select (120 ms after
      // the last change) can't copy half a selection however slowly a busy machine drags.
      await page.mouse.move(b.x + half - 1, b.y);
      await page.mouse.up();
      await hold(opts, "up");
    },
    async rightClick(col, row, opts = {}) {
      const a = await cell(col, row);
      await hold(opts, "down");
      await page.mouse.click(a.x, a.y, { button: "right" });
      await hold(opts, "up");
    },
    settled: () => page.evaluate(() => new Promise<void>((done) => setTimeout(done, 0))),
    async sentCount(n) {
      await page.waitForFunction((k) => (window as unknown as Win).e2e.sent.length >= k, n);
      return h.sent();
    },
    async copiedCount(n) {
      await page.waitForFunction((k) => (window as unknown as Win).e2e.copied.length >= k, n);
      return h.copied();
    },
    async rawKey(type, key, code, keyCode, modifiers, text) {
      await cdp.send("Input.dispatchKeyEvent", {
        type: type === "keyDown" && text ? "keyDown" : type === "keyDown" ? "rawKeyDown" : "keyUp",
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers,
        ...(text ? { text, unmodifiedText: text } : {}),
      });
    },
  };
  return h;
}

/** CDP modifier bits. */
export const ALT = 1;
export const CTRL = 2;
export const SHIFT = 8;
