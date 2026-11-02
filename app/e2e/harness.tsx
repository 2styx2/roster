// The page the copy-and-paste end-to-end suite drives (copy-paste.e2e.ts): roster's real
// TerminalView (xterm.js, input.ts, clipboard.ts) with a fake Session that records the bytes the
// terminal sends it, and a clipboard the test controls. Nothing else of the app is on it.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { actionsOf, resolveKeymap, type KeymapOverrides } from "../src/keymap";
import type { Clipboard } from "../src/platform/types";
import { defaultTerminalOptions, standardAnsi, type TerminalOptions, type TerminalTheme } from "../src/terminal/options";
import { TerminalView, type TerminalEnv } from "../src/terminal/TerminalView";

// TerminalView keeps its Terminal to itself; the suite needs it to wait for output to be parsed
// and to read the screen, so remember each one opened.
let current: Terminal | null = null;
const open = Terminal.prototype.open;
Terminal.prototype.open = function (this: Terminal, parent: HTMLElement) {
  // eslint-disable-next-line @typescript-eslint/no-this-alias -- the one way to reach TerminalView's Terminal
  current = this;
  open.call(this, parent);
};

const theme: TerminalTheme = {
  ...standardAnsi,
  background: "#0c0c0c",
  foreground: "#cccccc",
  cursor: "#cccccc",
  cursorAccent: "#0c0c0c",
  selectionBackground: "#504945",
  searchMatch: "#c19c00",
  searchActiveMatch: "#f9f1a5",
};

export interface MountOptions {
  /** Windows' keymap (Ctrl+V pastes, decision Q138). */
  windows?: boolean;
  copyOnSelect?: boolean;
  rightClickCopyPaste?: boolean;
  /** init.lua's keymap over the built-in one. */
  overrides?: KeymapOverrides;
}

/** What the suite reads and drives, as `window.e2e`. */
export interface E2E {
  mount(opts?: MountOptions): Promise<void>;
  /** Everything the terminal sent the Session, one entry per send. */
  sent: string[];
  /** Every text roster wrote to the clipboard, in order. */
  copied: string[];
  /** How many times roster read the clipboard. */
  reads: number;
  /** Sets the clipboard: roster's and the browser's (what the WebView's own paste reads). */
  setClipboard(text: string): Promise<void>;
  /** Only an image on the clipboard: the browser's paste has no text, roster's read gives "". */
  setClipboardImage(): Promise<void>;
  /** Shows or hides the terminal, as switching tabs does. */
  setActive(active: boolean): Promise<void>;
  /** The Session's output, resolved once xterm has parsed it. */
  output(data: string): Promise<void>;
  selection(): string;
  hasSelection(): boolean;
  /** Selects `length` cells from (col, row) through xterm's API. */
  select(col: number, row: number, length: number): void;
  /** The middle of a cell, in page pixels. */
  cell(col: number, row: number): { x: number; y: number };
  /** xterm's hidden text field's value (a paste mustn't stay in it). */
  textareaValue(): string;
  size(): { cols: number; rows: number };
  /** The modes the Session's program turned on, as xterm tracks them. */
  modes(): { bracketedPaste: boolean; mouse: string; alternate: boolean };
}

let root: Root | null = null;
let render: (active: boolean) => void = () => {};
let sink: ((data: Uint8Array) => void) | null = null;
let store = "";
const encoder = new TextEncoder();

const clipboard: Clipboard = {
  async readText() {
    e2e.reads++;
    return store;
  },
  async writeText(text: string) {
    e2e.copied.push(text);
    store = text;
    await navigator.clipboard.writeText(text).catch(() => {});
  },
};

const term = (): Terminal => {
  if (!current) throw new Error("no terminal mounted");
  return current;
};

const e2e: E2E = {
  sent: [],
  copied: [],
  reads: 0,
  async mount(opts = {}) {
    root?.unmount();
    current = null;
    sink = null;
    e2e.sent.length = 0;
    e2e.copied.length = 0;
    e2e.reads = 0;
    const options: TerminalOptions = {
      ...defaultTerminalOptions,
      renderer: "dom",
      fontFamily: "monospace",
      copyOnSelect: opts.copyOnSelect ?? true,
      rightClickCopyPaste: opts.rightClickCopyPaste ?? true,
    };
    const keys = actionsOf(resolveKeymap(opts.overrides ?? {}, { windows: opts.windows ?? true }).terminal);
    root = createRoot(document.getElementById("root")!);
    const attached = new Promise<void>((done) => {
      const env: TerminalEnv = {
        options,
        theme,
        fontSize: 16,
        windowsBuild: null,
        keys,
        clipboard,
        onZoom: () => {},
        layout: "normal",
        onRenderer: () => {},
      };
      const attach = (s: (data: Uint8Array) => void) => {
        sink = s;
        done();
        return () => {
          sink = null;
        };
      };
      render = (active) =>
        root!.render(<TerminalView active={active} leader="Ctrl+Space" attach={attach} onData={(d) => e2e.sent.push(d)} onResize={() => {}} env={env} />);
      render(true);
    });
    await attached;
    term().focus();
  },
  async setActive(active) {
    flushSync(() => render(active));
  },
  async setClipboardImage() {
    store = "";
    // A 1x1 transparent PNG.
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) })]);
  },
  async setClipboard(text) {
    store = text;
    await navigator.clipboard.writeText(text);
  },
  output(data) {
    const t = term();
    if (!sink) throw new Error("no Session attached");
    sink(encoder.encode(data));
    // Writes are parsed in order: this one's callback runs once everything before it is parsed.
    return new Promise((done) => t.write("", done));
  },
  selection: () => term().getSelection(),
  hasSelection: () => term().hasSelection(),
  select: (col, row, length) => term().select(col, row, length),
  cell(col, row) {
    const t = term();
    const screen = document.querySelector(".xterm-screen")!.getBoundingClientRect();
    const w = screen.width / t.cols;
    const h = screen.height / t.rows;
    return { x: screen.left + (col + 0.5) * w, y: screen.top + (row + 0.5) * h };
  },
  size: () => ({ cols: term().cols, rows: term().rows }),
  textareaValue: () => (document.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement).value,
  modes() {
    const m = term().modes;
    return { bracketedPaste: m.bracketedPasteMode, mouse: m.mouseTrackingMode, alternate: term().buffer.active.type === "alternate" };
  },
};

(window as unknown as { e2e: E2E }).e2e = e2e;
