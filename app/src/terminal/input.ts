// What a terminal sends the Session, and the keys it keeps back: the Leader and the keymap's
// `terminal` chords (copy, paste, find, zoom). TerminalView wires each xterm.js terminal through
// this; see docs/app/dev/xterm-setup.md. A paste goes only from the clipboard to the Session,
// never into a log, the State or a message (docs/app/security.md: it may be a password).
import type { Terminal } from "@xterm/xterm";
import { chordOf, type Action, type KeyLike } from "../keymap";
import type { Clipboard } from "../platform/types";
import { copyIfSelected, copySelection, pasteClipboard } from "./clipboard";
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
 * matches its keys, so the terminal's chords work on every layout. */
export function terminalChord(e: KeyLike & { code: string }): string {
  const chord = chordOf(e);
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1];
  if (!letter || !(e.ctrlKey || e.altKey || e.metaKey) || /^[\x20-\x7e]$/.test(e.key) || e.key.length !== 1) return chord;
  const { ctrlKey, altKey, metaKey, shiftKey } = e;
  return chordOf({ key: letter.toLowerCase(), ctrlKey, altKey, metaKey, shiftKey });
}

/** Wires `t` (opened in `host`) to the Session; returns unwire. */
export function wireInput(t: Terminal, host: HTMLElement, deps: InputDeps): () => void {
  // Ctrl+V (`terminal.pasteIfText`): the WebView pastes, as for any text field. Its keydown isn't
  // prevented, so the WebView fires a paste event at once (before the keyup) with the clipboard
  // as it is at the key: with text, xterm's own paste listener pastes it (line ends as Enter,
  // bracketed-paste marks when the program asked for them); with none (empty, an image only),
  // the program gets ^V. Nothing reads the clipboard later, so nothing waits and a clipboard put
  // back right after the key isn't what's pasted.
  let awaiting: ReturnType<typeof setTimeout> | undefined;
  const onPaste = (e: ClipboardEvent) => {
    const ours = awaiting !== undefined;
    clearTimeout(awaiting);
    awaiting = undefined;
    if (e.clipboardData?.getData("text/plain")) {
      // xterm's own listener pastes it; the WebView mustn't also put it in xterm's hidden text
      // field, where it would stay (it may be a password).
      e.preventDefault();
      return;
    }
    if (!ours) return; // a paste with no text, without the key: as before
    e.preventDefault();
    e.stopPropagation();
    deps.send(CTRL_V);
  };
  host.addEventListener("paste", onPaste, true);

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
        // Should the WebView fire no paste event (it refused), the program gets ^V just after.
        clearTimeout(awaiting);
        awaiting = setTimeout(() => {
          awaiting = undefined;
          deps.send(CTRL_V);
        }, 0);
      } else {
        // A held key pastes once; keyup and keypress send nothing.
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
    clearTimeout(awaiting);
    awaiting = undefined;
    data.dispose();
    host.removeEventListener("paste", onPaste, true);
    t.attachCustomKeyEventHandler(() => true);
  };
}
