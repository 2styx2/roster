// A huge CSI count can't stall an xterm (ticket 163, #305; decision Q153). xterm.js 6 works
// through a count one step at a time: `ESC[99999999M` (delete lines) takes it over a minute and
// `ESC[99999999L` (insert lines) runs out of memory, freezing the whole renderer, and anything a
// Session prints can carry one (a remote Host, `cat` of a crafted file). So every xterm roster
// feeds a Session's output to (the tab's own, PromptWatch's, CommittedLines', the shell hooks'
// prompt screen) takes it through a CsiClamp first.

/** The largest CSI parameter an xterm is given: more than any screen's rows or columns, so a
 * move, an erase, an insert, a scroll or a tab stop draws the same as with the count sent. Only
 * REP (`ESC[Nb`) repeats fewer times, and only past 9999. */
export const CSI_PARAM_MAX = 9999;

const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;
const DEL = 0x7f;
/** UTF-8's lead byte of U+0080 to U+00BF: before 0x80-0x9F, a C1 control. */
const C1_LEAD = 0xc2;
/** U+009B, the C1 form of `ESC [` (UTF-8 C2 9B), which xterm.js parses as a CSI. */
const C1_CSI = 0x9b;
const ZERO = 0x30;
const NINE = 0x39;
const CAPPED = [NINE, NINE, NINE, NINE];

const enum State {
  /** Not in a CSI: text, other sequences, OSC and DCS strings (passed as they came). */
  Ground,
  /** After ESC. */
  Escape,
  /** In a CSI: its parameters, intermediates, up to its final byte. */
  Csi,
}

/** Caps every CSI parameter (and sub-parameter) at CSI_PARAM_MAX, as a stream: a sequence split
 * across writes is followed from one to the next. It follows xterm.js's own parser
 * (EscapeSequenceParser.ts) for where a CSI starts and ends, so it changes nothing but a number
 * above the cap: a CSI starts at `ESC [` (controls between the two included, as xterm runs them)
 * and at U+009B, anywhere, even inside an OSC or DCS string, as xterm.js reads it there too;
 * it ends at its final byte (0x40-0x7E), at ESC, CAN or SUB, at a C1 control, or at a character
 * past ASCII. Nothing is cut or dropped, however long a sequence is: xterm.js bounds that itself.
 *
 * Output with no number above the cap comes out byte for byte as it went in, though a number's
 * digits may come out in the next write (held until the number ends: at most four), and a
 * control inside a number (which xterm runs where it stands) comes out before the digits held
 * ahead of it. A number past the cap comes out as its leading zeros and `9999`. */
export class CsiClamp {
  private state = State.Ground;
  /** The byte before was 0xC2: a C1 control may follow. */
  private c1 = false;
  /** The current number's significant digits, held back until it ends (at most four), and
   * whether it has more than four, so it's past the cap. */
  private held: number[] = [];
  private over = false;

  /** `data` with every CSI count capped; `data` itself when it's unchanged. */
  clamp(data: Uint8Array): Uint8Array;
  clamp(data: string): string | Uint8Array;
  clamp(data: Uint8Array | string): Uint8Array | string;
  clamp(data: Uint8Array | string): Uint8Array | string {
    if (typeof data === "string") {
      // Mostly text with no escape at all, or with no CSI open: as it came.
      if (this.state === State.Ground && !this.c1 && !data.includes("\x1b") && !data.includes("\x9b")) return data;
      return this.clamp(new TextEncoder().encode(data));
    }
    if (this.state === State.Ground && !this.c1 && data.indexOf(ESC) < 0 && data.indexOf(C1_CSI) < 0) {
      this.c1 = data.length > 0 && data[data.length - 1] === C1_LEAD;
      return data;
    }
    const out: number[] = [];
    for (const b of data) {
      // A C1 control (C2 80 to C2 9F) acts anywhere, as in xterm.js: U+009B starts a CSI, any
      // other ends one. Its two bytes go out as they came.
      if (this.c1) {
        this.c1 = false;
        if (b === C1_CSI) {
          out.push(b);
          this.enterCsi();
          continue;
        }
      }
      if (b === C1_LEAD) {
        // What follows is a C1 control or a character past ASCII: either ends a CSI or an escape
        // (xterm.js drops the character, or acts on the control), and U+009B starts a new CSI.
        if (this.state === State.Csi) this.endNumber(out);
        this.state = State.Ground;
        out.push(b);
        this.c1 = true;
        continue;
      }
      if (this.state === State.Ground) {
        out.push(b);
        if (b === ESC) this.state = State.Escape;
        continue;
      }
      if (this.state === State.Escape) {
        out.push(b);
        if (b === 0x5b) this.enterCsi();
        // ESC again, a control (xterm.js runs it and stays in the escape) and DEL keep it open.
        else if (b === ESC || b === DEL || (b < 0x20 && b !== CAN && b !== SUB)) this.state = State.Escape;
        else this.state = State.Ground;
        continue;
      }
      // In a CSI.
      if (b >= ZERO && b <= NINE) {
        if (this.held.length === 0 && b === ZERO && !this.over) {
          out.push(b); // a leading zero changes nothing
        } else if (this.held.length < 4 && !this.over) {
          this.held.push(b);
        } else {
          this.over = true;
        }
        continue;
      }
      if (b === DEL || (b < 0x20 && b !== ESC && b !== CAN && b !== SUB)) {
        // xterm.js runs a control (and ignores DEL) where it stands, and the number goes on.
        out.push(b);
        continue;
      }
      this.endNumber(out);
      out.push(b);
      if (b === ESC) this.state = State.Escape;
      // The final byte, CAN, SUB, or a character past ASCII ends it; separators, private
      // markers and intermediates (0x20-0x3F) don't.
      else if (b > 0x3f || b === CAN || b === SUB) this.state = State.Ground;
    }
    return same(out, data) ? data : Uint8Array.from(out);
  }

  private enterCsi() {
    this.state = State.Csi;
    this.held = [];
    this.over = false;
  }

  /** Puts out the number held so far, capped if it's past the cap. */
  private endNumber(out: number[]) {
    out.push(...(this.over ? CAPPED : this.held));
    this.held = [];
    this.over = false;
  }
}

function same(out: number[], data: Uint8Array): boolean {
  if (out.length !== data.length) return false;
  for (let i = 0; i < out.length; i++) if (out[i] !== data[i]) return false;
  return true;
}
