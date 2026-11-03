// OSC 52 (#293, decision Q149): a program sets the clipboard, as Windows Terminal lets it. A
// full-screen program with mouse reporting on (Claude Code, vim, tmux) draws its own selection and
// copies it this way, since the terminal never sees that selection. Write only: a read request
// (`?`) is ignored and answers nothing, so a Host can never read the clipboard. Only the Session
// on screen, only UTF-8 text up to OSC52_MAX_BYTES, and `terminal.osc52 = false` turns it off.
// What's copied goes only to the clipboard: never into a log, the State, a message or a Plugin
// (docs/app/security.md).
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { Clipboard } from "../platform/types";
import { CsiClamp } from "./csiClamp";

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
  // Too long to be within the cap: never decoded.
  if (data.length > MAX_ENCODED || data.length % 4 === 1 || !BASE64.test(data)) return null;
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return null;
  }
  if (binary.length > OSC52_MAX_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
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

/** Drops, from a Session's output bytes, every OSC 52 that starts in output held while its tab
 * was hidden (hold.ts), up to its end, wherever that comes: on screen or not is decided where a
 * sequence starts, not where xterm.js calls the handler, at its end (#295 review). OSC 52 draws
 * nothing, so the screen is as it would be (decision Q37 holds). xterm ends an OSC at BEL, at
 * C1 ST (U+009C) and at any ESC (with `\`, that's ST; else it starts the next sequence); CAN
 * and SUB abort it; any other C1 control leaves it and is acted on. Output that wasn't held passes untouched, except to finish one begun held. */
export class HeldOsc52Filter {
  private state: "text" | "start" | "drop" | "dropEsc" | "dropC2" = "text";
  /** The bytes of a possible start read so far, and how many of `ESC ] 5 2 ;` they make. */
  private pending: number[] = [];
  private matched = 0;

  filter(data: Uint8Array, held: boolean): Uint8Array {
    if (!held && this.state === "text") return data;
    const out: number[] = [];
    let i = 0;
    for (; i < data.length; i++) {
      const b = data[i] as number;
      if (this.state === "text") {
        // Output that wasn't held goes as it is from here.
        if (!held) break;
        if (b === 0x1b || b === 0xc2) {
          this.state = "start";
          this.pending = [b];
          this.matched = b === 0x1b ? 1 : 0;
        } else {
          out.push(b);
        }
      } else if (this.state === "start") {
        if (this.matched === 0) {
          // After 0xC2: 0x9D is U+009D, the C1 form of `ESC ]`.
          if (b === 0x9d) {
            this.pending.push(b);
            this.matched = 2;
            continue;
          }
        } else if (b === OSC52_BYTES[this.matched]) {
          this.pending.push(b);
          if (++this.matched === OSC52_BYTES.length) {
            this.state = "drop";
            this.pending = [];
          }
          continue;
        }
        // Not OSC 52: what was held back goes out as it came, and this byte is read again.
        out.push(...this.pending);
        this.pending = [];
        this.state = "text";
        i--;
      } else if (this.state === "drop") {
        if (b === 0x07 || b === 0x18 || b === 0x1a) this.state = "text";
        else if (b === 0x1b) this.state = "dropEsc";
        else if (b === 0xc2) this.state = "dropC2";
      } else if (this.state === "dropEsc") {
        this.state = "text";
        if (b !== 0x5c) {
          // That ESC ended it and starts what comes next: keep both.
          out.push(0x1b);
          i--;
        }
      } else {
        // dropC2: a C1 control (C2 80 to C2 9F) ends it, as in xterm.js. ST (C2 9C) is used up;
        // any other is acted on, so it goes out, and a C1 OSC (C2 9D) in held output may be
        // another OSC 52 to drop.
        if (b === 0x9c) {
          this.state = "text";
        } else if (b >= 0x80 && b <= 0x9f) {
          if (held && b === 0x9d) {
            this.state = "start";
            this.pending = [0xc2, 0x9d];
            this.matched = 2;
          } else {
            this.state = "text";
            out.push(0xc2);
            i--;
          }
        } else {
          this.state = "drop";
          i--;
        }
      }
    }
    if (out.length === 0 && i >= data.length) return new Uint8Array(0);
    const rest = data.subarray(i);
    if (out.length === 0) return rest;
    const all = new Uint8Array(out.length + rest.length);
    all.set(out);
    all.set(rest, out.length);
    return all;
  }
}

const OSC52_BYTES = [0x1b, 0x5d, 0x35, 0x32, 0x3b];

/** Writes a Session's output to `t`, from the output gate (hold.ts: `held` is output that came
 * while the tab was hidden), with every OSC 52 begun in held output taken out (HeldOsc52Filter)
 * and every CSI count capped and ED 1 made safe (csiClamp.ts: a huge count would freeze the tab,
 * an ED 1 at the screen's end stop it). Nothing is kept per write, so a write that throws leaves
 * nothing behind; a throw out of xterm.js's `write` itself (it refuses a write past 50 MB queued)
 * is logged once, without the output, and the next write goes on (ticket 172). */
export function screenWriter(t: Terminal): { write(data: Uint8Array, held: boolean): void } {
  const filter = new HeldOsc52Filter();
  const clamp = new CsiClamp(t);
  let logged = false;
  return {
    write(data, held) {
      const bytes = clamp.clamp(filter.filter(data, held));
      if (bytes.length === 0) return;
      try {
        t.write(bytes);
      } catch (e) {
        if (logged) return;
        logged = true;
        const kind = e instanceof Error ? e.name : typeof e;
        console.warn(`roster: the terminal refused a Session's output (${kind}); it was dropped`);
      }
    },
  };
}

const OSC52_START = "\x1b]52;";

/** Takes OSC 52 sequences out of a Session's decoded output as it streams, for what roster keeps
 * of it to explain a failure (tabs.ts `preAuth` and `late`, read by terminalTail into a Problem,
 * which reaches the message line, `:messages` and the State). Copied text must never get there,
 * so it goes at capture, a sequence split across chunks too, and never by a regex at read time
 * over a tail that may have cut the sequence's start off (#295 review). The C1 forms (U+009D
 * for `ESC ]`, U+009C for ST) count too, as xterm.js parses them. */
export class Osc52Stripper {
  private state: "text" | "start" | "drop" | "dropEsc" = "text";
  /** What's been read of a possible start, as it came, and as `ESC ]` forms it. */
  private raw = "";
  private norm = "";

  strip(text: string): string {
    if (this.state === "text" && !text.includes("\x1b") && !text.includes("\x9d")) return text;
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;
      switch (this.state) {
        case "text":
          if (ch === "\x1b" || ch === "\x9d") {
            this.state = "start";
            this.raw = ch;
            this.norm = ch === "\x9d" ? "\x1b]" : ch;
          } else {
            out += ch;
          }
          break;
        case "start": {
          const norm = this.norm + ch;
          if (OSC52_START.startsWith(norm)) {
            this.raw += ch;
            this.norm = norm;
            if (norm === OSC52_START) {
              this.state = "drop";
              this.raw = this.norm = "";
            }
          } else {
            // Not OSC 52: what was held goes out as it came, and this character is read again.
            out += this.raw;
            this.raw = this.norm = "";
            this.state = "text";
            i--;
          }
          break;
        }
        case "drop":
          // Where xterm.js ends an OSC (EscapeSequenceParser.ts): BEL, ST, CAN and SUB end it and
          // are used up; ESC ends it and starts what follows; any other C1 control leaves it and
          // is acted on, so it's kept.
          if (ch === "\x07" || ch === "\x9c" || ch === "\x18" || ch === "\x1a") this.state = "text";
          else if (ch === "\x1b") this.state = "dropEsc";
          else if (ch >= "\x80" && ch <= "\x9f") {
            this.state = "text";
            i--;
          }
          break;
        case "dropEsc":
          // ST ends it; any other ESC cuts it off and starts a sequence of its own.
          if (ch === "\\") {
            this.state = "text";
          } else {
            this.state = "start";
            this.raw = this.norm = "\x1b";
            i--;
          }
          break;
      }
    }
    return out;
  }
}
