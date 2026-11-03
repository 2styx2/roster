// What a terminal sends the Session, and the keys it keeps back: the Leader and the keymap's
// `terminal` chords (copy, paste, find, zoom). TerminalView wires each xterm.js terminal through
// this; see docs/app/dev/xterm-setup.md. A paste goes only from the clipboard to the Session,
// never into a log, the State or a message (docs/app/security.md: it may be a password).
import type { Terminal } from "@xterm/xterm";
import { chordOf, type Action, type KeyLike } from "../keymap";
import type { Clipboard } from "../platform/types";
import { copiedText, copyIfSelected, copySelection, pasteClipboard, pasteText } from "./clipboard";
import { isLeaderKey } from "./keys";
import type { ZoomAction } from "./options";

export interface InputDeps {
  /** The Leader chord, caught before the shell sees it. */
  leader(): string;
  /** The keymap's `terminal` table. */
  keys(): Record<string, Action>;
  clipboard(): Clipboard;
  /** Keys and pastes for the Session. */
  send(data: string): void;
  openSearch(): void;
  onZoom(action: ZoomAction): void;
}

/** The one key `terminal.pasteIfText` works on: the key the WebView pastes with. */
export const PASTE_IF_TEXT_KEY = "Ctrl+v";

/** What Ctrl+V sends a program when nothing catches it. */
const CTRL_V = "\x16";

type KeyEvent = KeyLike & { code: string; type: string; repeat?: boolean; preventDefault(): void };

/** A key event's chord in the keymap's terms. With Ctrl, Alt or Meta, a letter that isn't a Latin
 * one (Ctrl+м on a Russian layout) is named by its physical key (Ctrl+v), as Windows Terminal
 * matches its keys, so the terminal's chords work on every layout. Not with AltGr (which Windows
 * reports as Ctrl+Alt): AltGr+A is the character it types (ą on a Polish layout). */
export function terminalChord(e: KeyLike & { code: string; getModifierState?(key: string): boolean }): string {
  const chord = chordOf(e);
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1];
  if (!letter || !(e.ctrlKey || e.altKey || e.metaKey) || /^[\x20-\x7e]$/.test(e.key) || e.key.length !== 1) return chord;
  if ((e.ctrlKey && e.altKey) || e.getModifierState?.("AltGraph")) return chord;
  const { ctrlKey, altKey, metaKey, shiftKey } = e;
  return chordOf({ key: letter.toLowerCase(), ctrlKey, altKey, metaKey, shiftKey });
}

/** How long a Ctrl+V with no keyup waits for the WebView's paste event before the program gets
 * ^V (the paste event normally comes before the keyup), and how long after that ^V a paste
 * event still counts as that key's, and is swallowed. */
export const PASTE_WAIT_MS = 500;
export const LATE_PASTE_MS = 1000;

/** Wires `t` (opened in `host`) to the Session; returns unwire. */
export function wireInput(t: Terminal, host: HTMLElement, deps: InputDeps): () => void {
  // Ctrl+V (`terminal.pasteIfText`): the WebView pastes, as for any text field. Its keydown isn't
  // prevented, so the WebView fires a paste event (before the keyup) with the clipboard as it is
  // at the key: with text, it's pasted through xterm's paste (line ends as Enter, bracketed-paste
  // marks when the program asked for them), control characters taken out; with none (empty, an image only),
  // the program gets ^V. Nothing reads the clipboard later, so nothing waits and a clipboard put
  // back right after the key isn't what's pasted. No paste event by the keyup (the WebView
  // refused), or by PASTE_WAIT_MS without a keyup: ^V, and a paste event that still comes for
  // that key is swallowed, so the program never gets ^V and the text.
  type Pending = { timer: ReturnType<typeof setTimeout>; sent: boolean };
  let pending: Pending | undefined;
  const settle = () => {
    if (pending) clearTimeout(pending.timer);
    pending = undefined;
  };
  const fallback = (p: Pending) => {
    if (pending !== p || p.sent) return;
    p.sent = true;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (pending === p) pending = undefined;
    }, LATE_PASTE_MS);
    deps.send(CTRL_V);
  };
  const onPaste = (e: ClipboardEvent) => {
    const p = pending;
    settle();
    if (p?.sent) {
      // Late, after this key's ^V: never paste it as well.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const text = e.clipboardData?.getData("text/plain");
    if (text) {
      // Pasted here, filtered as every paste is (clipboard.ts pasteText), rather than by xterm's
      // own listener, which would paste ESC and all. The WebView mustn't also put it in xterm's
      // hidden text field, where it would stay (it may be a password).
      e.preventDefault();
      e.stopPropagation();
      pasteText(t, text);
      return;
    }
    if (!p) return; // a paste with no text, without the key: as before
    e.preventDefault();
    e.stopPropagation();
    deps.send(CTRL_V);
  };
  host.addEventListener("paste", onPaste, true);

  // The WebView's own copy (Cmd+C, Edit > Copy): xterm's listener would copy the selection as it
  // is; here it's trimmed as every copy is (clipboard.ts copiedText).
  const onCopy = (e: ClipboardEvent) => {
    if (!t.hasSelection() || !e.clipboardData) return;
    e.preventDefault();
    e.stopPropagation();
    e.clipboardData.setData("text/plain", copiedText(t.getSelection()));
  };
  host.addEventListener("copy", onCopy, true);

  // The Leader never reaches the shell (Ctrl+Space would send NUL); App's keymap acts on it.
  // The keymap's terminal chords don't either; they act on keydown only.
  t.attachCustomKeyEventHandler((ev) => {
    const e = ev as KeyEvent;
    if (isLeaderKey(e, deps.leader())) {
      e.preventDefault();
      return false;
    }
    const chord = terminalChord(e);
    const action = deps.keys()[chord];
    if (!action?.startsWith("terminal.")) return true;
    if (action === "terminal.copyIfSelected") {
      // Only a keydown with a selection is ours; anything else (^C) goes to the shell.
      if (e.type !== "keydown" || !copyIfSelected(t, deps.clipboard())) return true;
      e.preventDefault();
      return false;
    }
    if (action === "terminal.pasteIfText") {
      // On another key the WebView wouldn't paste: the key is the program's, as if unbound.
      if (chord !== PASTE_IF_TEXT_KEY) return true;
      if (e.type === "keydown" && !e.repeat) {
        settle();
        const p: Pending = { timer: setTimeout(() => fallback(p), PASTE_WAIT_MS), sent: false };
        pending = p;
      } else if (e.type === "keyup") {
        if (pending) fallback(pending);
      } else {
        // A held key pastes once; keypress sends nothing.
        e.preventDefault();
      }
      return false;
    }
    // Ours on every event type, so the browser doesn't paste as well and xterm sends nothing.
    e.preventDefault();
    if (e.type !== "keydown") return false;
    switch (action) {
      case "terminal.copy":
        copySelection(t, deps.clipboard());
        break;
      case "terminal.paste":
        void pasteClipboard(t, deps.clipboard());
        break;
      case "terminal.search":
        deps.openSearch();
        break;
      case "terminal.zoomIn":
      case "terminal.zoomOut":
      case "terminal.zoomReset":
        deps.onZoom(action);
        break;
    }
    return false;
  });

  const data = t.onData((d) => deps.send(d));
  return () => {
    settle();
    data.dispose();
    host.removeEventListener("paste", onPaste, true);
    host.removeEventListener("copy", onCopy, true);
    t.attachCustomKeyEventHandler(() => true);
  };
}
