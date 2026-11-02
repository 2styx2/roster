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
  /** The clock, in ms (tests move their own). */
  now?: () => number;
}

/** A Ctrl+V and a paste event this close together are one paste (a tool that injects Ctrl+V
 * may have the WebView fire a paste event as well), so only the first pastes. */
export const ONE_PASTE_MS = 500;

/** What a Ctrl+letter chord sends when nothing catches it: its control character (Ctrl+V: ^V,
 * 0x16). Other chords: nothing. */
function controlCharacter(e: KeyLike): string {
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !/^[a-z]$/i.test(e.key)) return "";
  return String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64);
}

type KeyEvent = KeyLike & { code: string; type: string; repeat?: boolean; preventDefault(): void };

/** Wires `t` (opened in `host`) to the Session; returns unwire. */
export function wireInput(t: Terminal, host: HTMLElement, deps: InputDeps): () => void {
  const now = deps.now ?? (() => Date.now());

  // While Ctrl+V reads the clipboard, what the terminal sends waits behind it, so keys typed
  // after Ctrl+V (Vim's Ctrl+V, then j) reach the Session after its paste or its ^V.
  let chain: Promise<void> = Promise.resolve();
  let waiting = 0;
  let inTurn = false;
  const later = (task: () => void | Promise<void>) => {
    waiting++;
    chain = chain
      .then(task)
      .catch(() => {})
      .finally(() => {
        waiting--;
      });
  };
  const send = (data: string) => {
    if (waiting > 0 && !inTurn) later(() => deps.send(data));
    else deps.send(data);
  };

  // Ctrl+V (`terminal.pasteIfText`): the clipboard's text through xterm's paste (line ends as
  // Enter, bracketed-paste marks when the program asked for them), or, with no text (empty, an
  // image only, or refused), the key itself, as if nothing had caught it.
  let lastKey = -Infinity;
  let lastEvent = -Infinity;
  const pasteIfText = (fallback: string) => {
    if (now() - lastEvent < ONE_PASTE_MS) return;
    lastKey = now();
    later(async () => {
      let text = "";
      try {
        text = await deps.clipboard().readText();
      } catch {
        // the WebView refused the clipboard: no text
      }
      inTurn = true;
      try {
        if (text) t.paste(text);
        else if (fallback) deps.send(fallback);
      } finally {
        inTurn = false;
      }
    });
  };
  // A paste event (the Edit menu, a tool pasting without a key) is xterm's to paste, unless a
  // Ctrl+V just pasted the same thing.
  const onPaste = (e: Event) => {
    if (now() - lastKey < ONE_PASTE_MS) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    lastEvent = now();
  };
  host.addEventListener("paste", onPaste, true);

  const copy = () => copySelection(t, deps.clipboard());

  // The Leader never reaches the shell (Ctrl+Space would send NUL); App's keymap acts on it.
  // The keymap's terminal chords don't either; they act on keydown only (a repeat too, except
  // Ctrl+V's, so a held key can't flood the Session with the clipboard).
  t.attachCustomKeyEventHandler((ev) => {
    const e = ev as KeyEvent;
    if (isLeaderKey(e, deps.leader())) {
      e.preventDefault();
      return false;
    }
    const action = deps.keys()[chordOf(e)];
    if (!action?.startsWith("terminal.")) return true;
    if (action === "terminal.copyIfSelected") {
      // Only a keydown with a selection is ours; anything else (^C) goes to the shell.
      if (e.type !== "keydown" || !copyIfSelected(t, deps.clipboard())) return true;
      e.preventDefault();
      return false;
    }
    // Ours on every event type, so the browser doesn't paste as well (a paste event) and xterm
    // sends nothing.
    e.preventDefault();
    if (e.type !== "keydown") return false;
    switch (action) {
      case "terminal.copy":
        copy();
        break;
      case "terminal.paste":
        void pasteClipboard(t, deps.clipboard());
        break;
      case "terminal.pasteIfText":
        if (!e.repeat) pasteIfText(controlCharacter(e));
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

  const data = t.onData(send);
  return () => {
    data.dispose();
    host.removeEventListener("paste", onPaste, true);
    t.attachCustomKeyEventHandler(() => true);
  };
}
