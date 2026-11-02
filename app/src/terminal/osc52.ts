// OSC 52 (#293, decision Q149): a program sets the clipboard, as Windows Terminal lets it. A
// full-screen program with mouse reporting on (Claude Code, vim, tmux) draws its own selection and
// copies it this way, since the terminal never sees that selection. Write only: a read request
// (`?`) is ignored and answers nothing, so a Host can never read the clipboard. Only the Session
// on screen, only UTF-8 text up to OSC52_MAX_BYTES, and `terminal.osc52 = false` turns it off.
// What's copied goes only to the clipboard: never into a log, the State, a message or a Plugin
// (docs/app/security.md).
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { Clipboard } from "../platform/types";

/** The most a program may put on the clipboard at once, decoded: 1 MiB. Far more than anyone
 * copies from a screen (a full 10,000-line scrollback at 100 columns is about 1 MB), and small
 * enough that a Host can't push hundreds of MB through the WebView to the clipboard. */
export const OSC52_MAX_BYTES = 1024 * 1024;

/** The longest base64 that can decode to OSC52_MAX_BYTES: anything longer isn't decoded. */
const MAX_ENCODED = Math.ceil(OSC52_MAX_BYTES / 3) * 4;

/** xterm's selection names (c clipboard, p primary, q secondary, s select, 0-7 cut buffers): all
 * go to the one clipboard there is, as in Windows Terminal. */
const SELECTION = /^[cpqs0-7]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The text an OSC 52 body (`Pc;Pd`, what follows `52;`) sets, or null when it sets nothing: a
 * read request, an unknown selection, malformed base64, text that isn't UTF-8, an empty payload,
 * or more than OSC52_MAX_BYTES. */
export function osc52Text(body: string): string | null {
  const semi = body.indexOf(";");
  if (semi < 0) return null;
  const selection = body.slice(0, semi);
  const data = body.slice(semi + 1);
  if (!SELECTION.test(selection) || data === "" || data === "?") return null;
  if (data.length > MAX_ENCODED + 2 || !BASE64.test(data) || data.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return null;
  }
  if (binary.length > OSC52_MAX_BYTES) return null;
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  try {
    return utf8.decode(bytes) || null;
  } catch {
    return null;
  }
}

export interface Osc52Deps {
  /** `terminal.osc52`. */
  enabled(): boolean;
  /** Whether what's being parsed now arrived while this Session was on screen. */
  onScreen(): boolean;
  clipboard(): Clipboard;
}

/** Handles OSC 52 in `t`; returns unwire. The sequence is always used up (never printed), whether
 * or not it sets the clipboard. */
export function wireOsc52(t: Pick<Terminal, "parser">, deps: Osc52Deps): () => void {
  const handler: IDisposable = t.parser.registerOscHandler(52, (body) => {
    if (!deps.enabled() || !deps.onScreen()) return true;
    const text = osc52Text(body);
    if (text !== null) void deps.clipboard().writeText(text).catch(() => {});
    return true;
  });
  return () => handler.dispose();
}

/** Writes a Session's output to `t`, keeping, for each write, whether it was held while the tab
 * was hidden (hold.ts): xterm parses writes in order and calls each one's callback once it's
 * parsed, so the oldest write not yet called back is the one being parsed. `onScreen` is false
 * while that's held output. */
export function screenWriter(t: Pick<Terminal, "write">): { write(data: Uint8Array, held: boolean): void; onScreen(): boolean } {
  const pending: boolean[] = [];
  return {
    write(data, held) {
      pending.push(held);
      t.write(data, () => void pending.shift());
    },
    onScreen: () => pending[0] !== true,
  };
}
