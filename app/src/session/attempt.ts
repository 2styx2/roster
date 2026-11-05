// One Session start in a tab (Tabs.start): everything that belongs to that start alone, made new
// with it, so nothing of an earlier start (its text, its window, its watch) is ever read again.
import { Osc52Stripper } from "../terminal/osc52";
import type { PromptWatch } from "./prompt";
import type { ShellHooks } from "./shellHooks";

/**
 * The pre-auth window: what a Session prints before it has logged in is ssh's (and roster
 * askpass's) own, and that's all classifyExit may read. Once logged in, the output is the Host's,
 * where a nested ssh's error or a forged `roster askpass:` line would look just like ours. ssh
 * doesn't say when the login succeeded, so the window closes after PRE_AUTH_MS (roster's ssh
 * config has ConnectTimeout 10, and askpass answers in a few seconds) or PRE_AUTH_BYTES of output
 * (ssh's own messages are short), whichever comes first. A 255 after that is a dropped Session
 * (row 20), told apart only by ssh's drop lines in the last output.
 */
const PRE_AUTH_MS = 30_000;
const PRE_AUTH_BYTES = 8 * 1024;
/** The last output after the window, for classifyDrop. */
const LATE_LIMIT = 4 * 1024;
/** How much of the output after the login is searched for the box's name. */
const SAVE_SCAN_LIMIT = 4 * 1024;

export class Attempt {
  /** Output inside the pre-auth window (decoded), for classifyExit. */
  preAuth = "";
  private preAuthBytes = 0;
  /** When it started, or null once its pre-auth window has closed. */
  private windowFrom: number | null;
  /** The last output after the window (decoded), for classifyDrop. */
  late = "";
  /** A streaming decoder holds a character split across chunks: its own, so it never ends up in
   * another tab's (or attempt's) text. */
  private readonly decoder = new TextDecoder();
  /** What a program copied (OSC 52) is never kept: a Problem's tail reaches messages and the State. */
  private readonly tailStrip = new Osc52Stripper();
  /** The last output while a save may be offered: where the box's name is read from. */
  saveScan = "";
  /** Watches for sudo's password prompt (ticket 119): only a Host's Session on a roster that can
   * fill one. */
  watch: PromptWatch | null = null;
  /** The shell hooks (ticket 121): the hook line, its echo held back, OSC 7. */
  hooks: ShellHooks | null = null;
  /** From roster's hook line going out until its first own prompt (or the hooks giving up), what
   * the Session prints is kept from Plugins: it's the echo of a line with the attempt's token.
   * `tail` is the window's last bytes, to find that prompt's mark across reads. */
  echoWindow: { tail: Uint8Array } | null = null;
  /** From a fill starting until the next line break the Session prints (sudo's own, after Enter),
   * or the fill's refusal, what it prints is kept from Plugins (ticket 154): sudo's `pwfeedback`
   * draws a `*` for the probe's letter and one per character of the password, so its stars would
   * tell a Plugin the password's length. `dropped` bounds it. */
  fillWindow: { dropped: number } | null = null;

  /** `seq`: the tab's count of starts when this one began (a later one makes this one stale). */
  constructor(
    readonly seq: number,
    private readonly now: () => number,
    started = true,
  ) {
    this.windowFrom = started ? now() : null;
  }

  /** Whether the pre-auth window is still open (it closes once its time is up). */
  windowOpen(): boolean {
    if (this.windowFrom !== null && this.now() - this.windowFrom >= PRE_AUTH_MS) this.windowFrom = null;
    return this.windowFrom !== null;
  }

  /** Keeps the output for classifyExit / classifyDrop; returns it decoded. */
  keepTail(data: Uint8Array): string {
    const text = this.decoder.decode(data, { stream: true });
    const kept = this.tailStrip.strip(text);
    if (this.windowOpen() && this.preAuthBytes + data.length <= PRE_AUTH_BYTES) {
      this.preAuth += kept;
      this.preAuthBytes += data.length;
      return text;
    }
    this.windowFrom = null;
    this.late += kept;
    if (this.late.length > LATE_LIMIT) this.late = this.late.slice(-LATE_LIMIT);
    return text;
  }

  /** Keeps `text` among the last output searched for the box's name. */
  scan(text: string) {
    if (text) this.saveScan = (this.saveScan + text).slice(-SAVE_SCAN_LIMIT);
  }

  /** The Session ended or was replaced: its watch and hooks stop. */
  stop() {
    this.watch?.dispose();
    this.watch = null;
    this.hooks?.stop();
    this.echoWindow = null;
    this.fillWindow = null;
  }
}
