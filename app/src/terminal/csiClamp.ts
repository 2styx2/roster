// A huge CSI count can't stall an xterm (ticket 163, #305; decision Q153). xterm.js 6 works
// through a count one step at a time: `ESC[99999999M` (delete lines) takes it over a minute and
// `ESC[99999999L` (insert lines) runs out of memory, freezing the whole renderer, and anything a
// Session prints can carry one (a remote Host, `cat` of a crafted file). So every xterm roster
// feeds a Session's output to (the tab's own, PromptWatch's, CommittedLines', the shell hooks'
// prompt screen) takes it through a CsiClamp first. First written for the prompt screen (ticket
// 159, #298), shared from here.
//
// Bound to its xterm, a CsiClamp also guards it (xtermGuard.ts): a throw inside xterm.js, as on
// an ED 1 at the screen's end in 6.0.0, no longer stops it (ticket 172, #323; decision Q158).

import type { Terminal } from "@xterm/xterm";
import { guardXterm } from "./xtermGuard";

/** The largest CSI parameter an xterm is given: more than any screen's rows or columns, so a
 * move, an erase, an insert, a scroll or a tab stop draws the same as with the count sent. Only
 * REP (`ESC[Nb`) repeats fewer times, and only past 9999. */
export const CSI_PARAM_MAX = 9999;

/** How much of a CSI's parameters it keeps: xterm reads at most 32 parameters, which (at most
 * four digits each, with their separators) fit well inside. Past it, further parameter bytes are
 * dropped, as they change nothing xterm draws; the sequence still waits for its final byte. */
const PARAMS_MAX = 256;
/** How many intermediate bytes it keeps; past it they're dropped too, so a sequence that never
 * ends holds a bounded amount. */
const INTERMEDIATES_MAX = 16;

const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;
const DEL = 0x7f;
/** UTF-8's lead byte of U+0080 to U+00BF: before 0x80-0x9F, a C1 control. */
const C2 = 0xc2;
/** U+009B, the C1 form of `ESC [` (UTF-8 C2 9B), which xterm.js parses as a CSI. */
const C1_CSI = 0x9b;
const ZERO = 0x30;
const NINE = 0x39;

const enum St {
  Text,
  /** After ESC. */
  Esc,
  /** After 0xC2 in text: the first byte of a C1 control (U+0080 to U+009F) or of another character. */
  C2,
  Csi,
  /** After 0xC2 in a CSI. */
  CsiC2,
}

/** A C0 control xterm.js runs where it stands inside an escape or a CSI, the sequence going on
 * (every one but ESC, CAN and SUB, which end it). */
const runsInPlace = (c: number) => c < 0x20 && c !== ESC && c !== CAN && c !== SUB;

/** Gives each CSI parameter (and sub-parameter) as at most CSI_PARAM_MAX, whether the CSI begins
 * with `ESC [` or with the C1 introducer U+009B (UTF-8 `C2 9B`, which xterm.js takes the same,
 * anywhere, even inside an OSC or DCS string), across writes: a sequence split between two reads
 * is held until it ends. Leading zeros go (`0005` is 5, as xterm reads it). Nothing of a CSI ever
 * comes out as text: it comes out whole at its final byte, or unfinished where an ESC, CAN, SUB,
 * a C1 control or a character past ASCII ends it, as xterm.js ends it. Controls inside it (a
 * backspace, a line feed), and between `ESC` and `[`, come out where they are, as a terminal runs
 * them there. Everything else, OSC and DCS strings included, passes as it came. */
export class CsiClamp {
  private state: St = St.Text;
  /** The CSI's introducer as it came (`ESC [` or `C2 9B`). */
  private intro: number[] = [];
  /** The CSI's parameter and intermediate bytes so far, parameters capped. */
  private seq: number[] = [];
  /** Where the current parameter's digits are in `seq`. */
  private digits: number[] = [];
  private params = 0;
  private intermediates = 0;

  /** A clamp for the output fed to `term`, if given: then `term` is guarded too (xtermGuard.ts),
   * so a throw inside xterm.js (an ED 1 at the screen's end, in 6.0.0) doesn't stop its writes for
   * good (ticket 172, #323). The bytes are the same either way. */
  constructor(term?: Terminal) {
    if (term) guardXterm(term);
  }

  /** `data` with every CSI count capped; `data` itself when it comes out as it came. */
  clamp(data: Uint8Array): Uint8Array;
  clamp(data: string): string | Uint8Array;
  clamp(data: Uint8Array | string): Uint8Array | string;
  clamp(data: Uint8Array | string): Uint8Array | string {
    if (typeof data === "string") {
      // Mostly text with no escape at all, outside any sequence: as it came.
      if (this.state === St.Text && !data.includes("\x1b") && !data.includes("\x9b")) return data;
      return this.clamp(new TextEncoder().encode(data));
    }
    if (this.state === St.Text && data.indexOf(ESC) < 0 && data.indexOf(C2) < 0) return data;
    const out: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const c = data[i] ?? 0;
      switch (this.state) {
        case St.Text:
          if (c === ESC) this.state = St.Esc;
          else if (c === C2) this.state = St.C2;
          else out.push(c);
          break;
        case St.Esc:
          if (c === 0x5b) this.startCsi([ESC, 0x5b]);
          else if (runsInPlace(c) || c === DEL) out.push(c); // run (DEL ignored), still after ESC
          else {
            out.push(ESC);
            this.state = St.Text;
            i--; // look at it again as text
          }
          break;
        case St.C2:
          if (c >= 0x80 && c <= 0x9f) this.c1(c, out);
          else {
            out.push(C2);
            this.state = St.Text;
            i--;
          }
          break;
        case St.Csi:
          this.inCsi(c, out);
          break;
        case St.CsiC2:
          // A C1 control or a character past ASCII ends the CSI, as in xterm.js (which drops
          // the character and acts on the control).
          this.unfinished(out);
          if (c >= 0x80 && c <= 0x9f) this.c1(c, out);
          else {
            out.push(C2);
            this.state = St.Text;
            i--;
          }
          break;
      }
    }
    return same(out, data) ? data : Uint8Array.from(out);
  }

  private startCsi(intro: number[]) {
    this.state = St.Csi;
    this.intro = intro;
    this.seq = [];
    this.digits = [];
    this.params = 0;
    this.intermediates = 0;
  }

  /** The CSI as far as it got, out unfinished (the terminal drops it at what ends it). */
  private unfinished(out: number[]) {
    out.push(...this.intro, ...this.seq);
  }

  /** A C1 control (`C2 c`): a CSI introducer starts one; any other goes out as it came. */
  private c1(c: number, out: number[]) {
    if (c === C1_CSI) this.startCsi([C2, C1_CSI]);
    else {
      out.push(C2, c);
      this.state = St.Text;
    }
  }

  private inCsi(c: number, out: number[]) {
    if (c >= ZERO && c <= NINE) {
      // A parameter past four digits is the cap: its digits all 9. A leading zero changes nothing.
      const lone = this.digits.length === 1 && this.seq[this.digits[0] ?? -1] === ZERO;
      if (c === ZERO && lone) return;
      if (lone) {
        this.seq[this.digits[0] ?? 0] = c;
        return;
      }
      if (this.digits.length < 4) {
        if (this.params >= PARAMS_MAX) return;
        this.params++;
        this.digits.push(this.seq.length);
        this.seq.push(c);
      } else for (const at of this.digits) this.seq[at] = NINE;
    } else if (c >= 0x3a && c <= 0x3f) {
      this.digits = [];
      if (this.params >= PARAMS_MAX) return;
      this.params++;
      this.seq.push(c);
    } else if (c >= 0x20 && c <= 0x2f) {
      this.digits = [];
      if (this.intermediates >= INTERMEDIATES_MAX) return;
      this.intermediates++;
      this.seq.push(c);
    } else if (c >= 0x40 && c <= 0x7e) {
      out.push(...this.intro, ...this.seq, c);
      this.state = St.Text;
    } else if (c === ESC) {
      this.unfinished(out);
      this.state = St.Esc;
    } else if (c === CAN || c === SUB) {
      this.unfinished(out);
      out.push(c);
      this.state = St.Text;
    } else if (c === C2) this.state = St.CsiC2;
    else if (c < 0x20) out.push(c); // a control runs where it is, the CSI still going
    else if (c !== DEL) {
      // Another character's bytes: xterm.js drops the character and leaves the CSI.
      this.unfinished(out);
      out.push(c);
      this.state = St.Text;
    }
  }
}

function same(out: number[], data: Uint8Array): boolean {
  if (out.length !== data.length) return false;
  for (let i = 0; i < out.length; i++) if (out[i] !== data[i]) return false;
  return true;
}
