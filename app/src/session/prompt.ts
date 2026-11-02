// Whether a Host Session waits at a password prompt roster may fill (tickets 119 and 120,
// decisions Q129 and Q131), read off a terminal's screen of its own (xterm's, never opened, as
// committed.ts does), so what the line shows is what the user sees: colours, rewrites and redraws
// are the terminal's. It only decides whether to *offer* the fill key; the Host prints all of it.
// What makes a fill safe is checked elsewhere too: serve refuses a prompt that isn't the Host's own
// Login's, and a Host edited since, and the core types the secret only at a prompt the Session
// printed and after a probe shows it doesn't echo (crates/roster-core/src/session.rs).
//
// The rule is to refuse whenever in doubt, and the doubt is always the same: which shell is this
// prompt under? Only sudo's own prompt naming the login user is offered on the Session's Host
// (`[sudo] password for ops:`); a bare `Password:` (su's, a login's) says nothing roster can check.
//
// - **Roster's own marks** (its shell hooks, Q130, sent before anything was typed): every mark
//   carries the Session's token (`roster=…`), which no other machine ever sees, so a mark with it is
//   provably the Session's own shell's. Marks without it are another shell's: the far Host's after
//   an ssh, or forged. The outer shell's C, read off the screen after an Enter you typed, starts a
//   command; its own D ends it, however it ended. sudo is offered while that command is sudo
//   itself, has printed only sudo's lines and started no marked shell. A command that's an ssh to
//   an Inventory Host (sshTarget.ts) is shown as a breadcrumb until the outer D; its login prompt is
//   offered while it logs in (exactly `USER@HOST's password:`, no shell started there, nothing
//   typed since, nothing but ssh's own lines after its first prompt, once), and that Host's sudo at
//   the first command its own marked shell runs, never after one has ended (a deeper machine
//   reached from there could forge the far shell's marks).
// - **Marks that aren't roster's** (the user's own integration, or a hook line sent after typing):
//   roster can't tell which shell a mark is from once something that may reach another machine has
//   run, so from then on it fills nothing in this Session (fail closed) and says how to fix it.
//   Before that, Q129's checks; a marked shell starting inside a command makes roster unsure for
//   good. No breadcrumb, nothing nested.
// - **No marks**: sudo's exact prompt only, and the offer says roster can't tell whether a nested
//   shell runs. Nothing nested.
import { Terminal } from "@xterm/xterm";
import type { NestedHost, TermSize } from "../backend/types";
import type { Breadcrumb } from "./breadcrumb";
import { mayReachElsewhere, sudoOnly } from "./commandLine";
import { resolveHop, type Hop, type HopHost } from "./sshTarget";

/** sudo's prompt, whole; the user is checked against the Session's login user. */
const SUDO = /^\[sudo\] password for ([^\s:]+):$/;
/** What sudo itself prints while it asks: its prompt (the password isn't echoed) and a retry. */
const SUDO_OWN = /^(?:\[sudo\] password for [^\s:]+:|Sorry, try again\.|)$/;
/** OpenSSH's password prompt, whole: the user and the host it logs in to. */
const SSH = /^([^\s@']+)@([^\s@']+)'s password:$/;
/** What ssh itself prints after its first password prompt while it logs in. */
const SSH_OWN = /^(?:[^\s@']+@[^\s@']+'s password:|Permission denied, please try again\.|)$/;
/** Lines of the screen kept above it, so where `B` left the cursor survives a scroll. */
const SCROLLBACK = 200;

export { sudoOnly };
export type { Breadcrumb };

export interface PasswordPrompt {
  /** The prompt line, as the Host printed it. */
  line: string;
  /** Why roster won't fill it; null: it may. */
  elsewhere: string | null;
  /** The shell's marks told roster what runs; false: it can't tell whether you've left the Host. */
  marked: boolean;
  /** sudo's prompt, or a nested ssh's login prompt (ticket 120). */
  kind: "sudo" | "ssh";
  /** The Inventory Host a nested ssh went to, whose Login answers it, and what roster resolved it
   * to (for serve's check); null: the Session's own Host. Never a password. */
  hop: FillHop | null;
}

/** The Host a nested ssh went to, as roster resolved it from the Inventory at its `C` mark. */
export type FillHop = NestedHost;

/** What PromptWatch needs to follow a nested ssh: the Inventory, and whether roster serve fills
 * another Host's prompt (API 26). */
export interface HopSource {
  hosts(): readonly HopHost[];
  fill: boolean;
}

type Phase = "none" | "prompt" | "input" | "output" | "idle";

/** One shell's marks: the Session's own, or the one a nested ssh started. */
interface Level {
  phase: Phase;
  /** Where `B` left the cursor: a line of the buffer (scrollback included) and a column. */
  start: { line: number; col: number } | null;
  /** The running command's line, read at `C`; null when it couldn't be read. */
  command: string | null;
  /** The running command printed a line that isn't sudo's own. */
  dirty: boolean;
  /** A marked shell started inside the running command. */
  shell: boolean;
  /** The line a `C` came on before its line feed (pwsh's, and some shells'): the command line's,
   * not the command's output. */
  cLine: number | null;
}

const level = (): Level => ({ phase: "none", start: null, command: null, dirty: false, shell: false, cLine: null });

/** A nested ssh, from the outer shell's C to its D. */
interface HopState {
  hop: Hop;
  /** The shell it reached, once that marked a prompt. */
  inner: Level;
  innerMarked: boolean;
  /** A command ended there: a deeper machine reached in it could forge that shell's marks, so its
   * sudo isn't filled after. */
  innerDone: boolean;
  /** The user sent keys since the ssh started (a host-key answer, a typed password, a command). */
  typed: boolean;
  /** ssh's password prompt was committed (Enter), and since then a line that isn't ssh's own. */
  asked: boolean;
  sshDirty: boolean;
  /** A fill was tried at its login prompt. */
  filled: boolean;
}

export class PromptWatch {
  private readonly term: Terminal;
  private readonly user: string;
  private readonly hops: HopSource | null;
  /** The Session's token in roster's own marks (the hook line's), if it has one. */
  private readonly nonce: string | null;
  private readonly outer: Level = level();
  /** Roster's hook line went before anything was typed (or while the marks still told roster where
   * the shell was): marks with the token are the Session's own shell's. */
  private vouched = false;
  /** A mark with the token has come: the Session's shell is roster-hooked. */
  private hooked = false;
  /** Without roster's marks: a marked shell started inside a command, so roster can't pair the
   * marks again. */
  private nested = false;
  /** Without roster's marks: the command line that may have reached another machine, after which
   * roster fills nothing more in this Session. */
  private relayed: string | null = null;
  private hopState: HopState | null = null;
  /** You pressed Enter since the outer shell's `B`: its `C` is a line you ran. */
  private entered = false;
  /** Anything with typing in it was sent to the Session. */
  private typedAny = false;
  private marksSeen = false;
  private writes = 0;
  /** A fill was tried at the prompt as it was after this many writes: not offered again until more. */
  private spentAt = -1;

  /** A watch for a Session of `size` whose login user is `user`; with `hops`, it follows a nested
   * ssh to an Inventory Host (ticket 120); `nonce` is the token in the Session's hook line. */
  constructor(size: TermSize, user: string, hops: HopSource | null = null, nonce: string | null = null) {
    this.user = user;
    this.hops = hops;
    this.nonce = nonce;
    this.term = new Terminal({ cols: size.cols, rows: size.rows, scrollback: SCROLLBACK, allowProposedApi: false });
    this.term.onLineFeed(() => this.lineFeed());
    this.term.parser.registerOscHandler(133, (data) => {
      this.mark(data);
      return true;
    });
  }

  /** Feeds the terminal; resolves once it has taken in `data`. */
  write(data: Uint8Array | string): Promise<void> {
    this.writes++;
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  /** The user sent the Session keys with typing in them (typed, pasted, or the shell hook line): a
   * nested ssh's prompt after that may not be its login's, and an Enter at the shell's prompt is
   * what makes its next `C` a command you ran. A fill's own keys never come here. */
  typed(data: string) {
    this.typedAny = true;
    if (this.hopState) this.hopState.typed = true;
    else if (this.outer.phase === "input" && /[\r\n]/.test(data)) this.entered = true;
  }

  /** Roster's hook line (with the token) is being sent. Its marks prove the Session's own shell
   * only if it can only have gone there: nothing typed yet, or marks that show the shell at its
   * prompt with nothing run that may have reached another machine. */
  hookSent() {
    this.vouched = !this.typedAny || (this.marksSeen && this.relayed === null && !this.nested && this.outer.phase !== "output");
  }

  resize(size: TermSize) {
    if (size.cols === this.term.cols && size.rows === this.term.rows) return;
    this.term.resize(size.cols, size.rows);
    // reflowed: rows aren't where they were
    this.outer.start = null;
    if (this.hopState) this.hopState.inner.start = null;
  }

  /** A fill was tried at this prompt: it isn't offered again until the Session prints more (and a
   * nested ssh's login prompt not again in that ssh). */
  spent() {
    if (this.hopState && this.prompt()?.kind === "ssh") this.hopState.filled = true;
    this.spentAt = this.writes;
  }

  /** The fill tried at this prompt typed nothing (roster serve refused it): offer it again. */
  unspent() {
    this.spentAt = -1;
    if (this.hopState) this.hopState.filled = false;
  }

  dispose() {
    this.term.dispose();
  }

  /** Where a nested ssh has taken the Session, until it ends; null on the Session's own Host. */
  hop(): Breadcrumb | null {
    const hop = this.hopState?.hop;
    if (!hop) return null;
    return hop.known ? { to: hop.host, known: true } : { to: hop.label, known: false };
  }

  /** The password prompt at the cursor that roster might fill, and whether it may; null when
   * there's none (or the marks say it's a shell's own prompt, or a fill was just tried). */
  prompt(): PasswordPrompt | null {
    if (this.writes === this.spentAt) return null;
    const b = this.term.buffer.active;
    if (b.type !== "normal") return null;
    const row = b.getLine(b.baseY + b.cursorY);
    const line = (row?.translateToString(false, 0, b.cursorX) ?? "").trim();
    const rest = (row?.translateToString(true, b.cursorX) ?? "").trim();
    if (rest !== "") return null;
    const sudo = SUDO.exec(line);
    const ssh = sudo ? null : SSH.exec(line);
    if (!sudo && !ssh) return null;
    const kind = sudo ? "sudo" : "ssh";
    const refuse = (why: string): PasswordPrompt => ({ line, elsewhere: why, marked: this.marksSeen, kind, hop: null });
    if (!this.marksSeen) {
      if (sudo) return sudo[1] === this.user ? { line, elsewhere: null, marked: false, kind, hop: null } : null;
      return this.hops ? refuse("without the shell's marks roster can't tell where this ssh went (turn on shell integration, or :integrate)") : null;
    }
    if (!this.hooked && this.relayed !== null) {
      if (sudo && sudo[1] !== this.user) return null;
      return refuse(
        `\`${this.relayed}\` ran in this Session and may have reached another machine, and this shell's marks aren't roster's own, ` +
          "so roster can't tell which machine asks; reconnect with roster's shell hooks on (shell_hooks, or :integrate before you ssh)",
      );
    }
    const hop = this.hopState;
    if (hop) return sudo ? this.innerSudo(hop, line, sudo[1] ?? "") : this.hopLogin(hop, line, ssh?.[1] ?? "", ssh?.[2] ?? "");
    if (!sudo || sudo[1] !== this.user || this.outer.phase !== "output") return null;
    return { line, elsewhere: this.why(), marked: true, kind, hop: null };
  }

  /** Why the marks leave roster unsure this prompt is the Host's own sudo's; null when they don't. */
  private why(): string | null {
    const { command, dirty, shell } = this.outer;
    if (this.nested) return "a shell started inside a command in this Session, so roster can't tell what runs now";
    if (shell) return "a shell started inside this command, so roster can't tell what runs now";
    if (command === null) return "roster couldn't read the running command";
    if (!sudoOnly(command)) return `\`${command}\` is running, not sudo itself, so this prompt may be another machine's`;
    if (dirty) return "the command has printed more than sudo's own lines, so this prompt may be another machine's";
    return null;
  }

  /** A nested ssh's password prompt: filled only while that ssh is logging in to the Inventory
   * Host it resolved to, for exactly the user and host ssh prints. */
  private hopLogin(state: HopState, line: string, who: string, where: string): PasswordPrompt {
    const { hop } = state;
    const refuse = (why: string): PasswordPrompt => ({ line, elsewhere: why, marked: true, kind: "ssh", hop: null });
    if (!hop.known) return refuse(`roster can't tell where this ssh went: ${hop.why}`);
    if (!this.hops?.fill) return refuse(`filling ${hop.host}'s ssh prompt needs a newer roster (API 26)`);
    if (hop.sshFill) return refuse(hop.sshFill);
    if (who !== hop.user || where.toLowerCase() !== hop.target) {
      return refuse(`the prompt asks for ${who}@${where}'s password, and this ssh logs in as ${hop.user}@${hop.target}`);
    }
    if (state.innerMarked) return refuse(`a shell has started on ${hop.host}, so this isn't its ssh's login prompt`);
    if (state.typed) return refuse(`you typed into this ssh, so roster can't tell this prompt is still ${hop.host}'s login`);
    if (state.sshDirty) return refuse(`this ssh has printed more than its login's lines, so this prompt may not be ${hop.host}'s login`);
    if (state.filled) return refuse(`roster already tried ${hop.host}'s password in this ssh; type it yourself`);
    return { line, elsewhere: null, marked: true, kind: "ssh", hop: fillHop(hop) };
  }

  /** sudo's prompt while a nested ssh runs: the Host it went to's sudo, only at the first command
   * its own marked shell runs. */
  private innerSudo(state: HopState, line: string, who: string): PasswordPrompt | null {
    const { hop, inner } = state;
    const refuse = (why: string): PasswordPrompt => ({ line, elsewhere: why, marked: true, kind: "sudo", hop: null });
    if (!hop.known) {
      return who === this.user ? refuse(`\`${this.outer.command}\` is running, not sudo itself, so this prompt may be another machine's`) : null;
    }
    if (who !== hop.user) return null;
    if (!this.hops?.fill) return refuse(`filling ${hop.host}'s sudo prompt needs a newer roster (API 26)`);
    if (hop.sudoFill) return refuse(hop.sudoFill);
    if (!state.innerMarked) return refuse(`the shell on ${hop.host} doesn't mark its commands, so roster can't tell what asks`);
    if (inner.shell) return refuse(`a shell started inside a command on ${hop.host}, so roster can't tell what runs now`);
    if (state.innerDone) {
      return refuse(`a command ended on ${hop.host}, and what it ran could have reached another machine that marks like its shell`);
    }
    if (inner.phase !== "output") return null;
    if (inner.command === null) return refuse("roster couldn't read the running command");
    if (!sudoOnly(inner.command)) return refuse(`\`${inner.command}\` is running, not sudo itself, so this prompt may be another machine's`);
    if (inner.dirty) return refuse("the command has printed more than sudo's own lines, so this prompt may be another machine's");
    return { line, elsewhere: null, marked: true, kind: "sudo", hop: fillHop(hop) };
  }

  private lineFeed() {
    const state = this.hopState;
    const out = (lv: Level) => (lv.phase === "output" ? lv : null);
    const lv = state ? (state.innerMarked ? out(state.inner) : null) : out(this.outer);
    if (!state && !lv) return;
    const text = this.lineAbove(lv);
    if (text === null) return;
    if (state && !state.innerMarked) {
      if (state.asked && !SSH_OWN.test(text)) state.sshDirty = true;
      if (SSH.test(text)) state.asked = true;
    }
    if (lv && !SUDO_OWN.test(text)) lv.dirty = true;
  }

  /** The line just ended by a line feed (through its wraps), or null for the command line's own
   * row in `lv` (a `C` before its line feed). */
  private lineAbove(lv: Level | null): string | null {
    const b = this.term.buffer.active;
    const y = b.baseY + b.cursorY - 1;
    const start = this.lineStartOf(y);
    if (lv && start === lv.cLine) {
      lv.cLine = null;
      return null;
    }
    let text = "";
    for (let r = start; r <= y; r++) text += b.getLine(r)?.translateToString(true) ?? "";
    return text.trim();
  }

  private mark(data: string) {
    if (this.term.buffer.active.type !== "normal") return;
    this.marksSeen = true;
    const [kind, ...params] = data.split(";");
    const own = this.vouched && this.nonce !== null && params.includes(`roster=${this.nonce}`);
    if (own) {
      this.hooked = true;
      this.outerMark(kind ?? "", true);
    } else if (this.hooked) this.foreignMark(kind ?? "");
    else this.outerMark(kind ?? "", false);
  }

  /** A mark of the Session's own shell: provably so (`own`, roster's token), or the only shell
   * roster knows of (marks that aren't roster's). */
  private outerMark(kind: string, own: boolean) {
    const lv = this.outer;
    switch (kind) {
      case "A":
      case "N":
        // Without roster's token, an A while a command runs is a nested shell's (Q121).
        if (!own && lv.phase === "output") this.nested = true;
        lv.phase = "prompt";
        lv.start = null;
        return;
      case "B":
        this.entered = false;
        this.begin(lv);
        return;
      case "C": {
        if (lv.phase === "output") return;
        this.run(lv);
        if (!own) {
          if (mayReachElsewhere(lv.command)) this.relayed ??= lv.command ?? "a command roster couldn't read";
          return;
        }
        let hop = this.hops && lv.command !== null ? resolveHop(lv.command, this.hops.hosts()) : null;
        if (hop?.known && !this.entered) {
          hop = { known: false, label: hop.host, why: "roster didn't see you press Enter on that line, so the Host may have drawn it" };
        }
        if (hop) this.hopState = newHop(hop);
        return;
      }
      case "D":
        this.hopState = null;
        lv.phase = "idle";
        lv.command = null;
        return;
    }
  }

  /** A mark without the token in a roster-hooked Session: another shell's (the far Host's after an
   * ssh), or forged. It never moves the Session's own shell; inside a nested ssh it's that Host's. */
  private foreignMark(kind: string) {
    if (this.outer.phase !== "output") return;
    const state = this.hopState;
    if (kind === "A" || kind === "N") this.outer.shell = true;
    if (!state) return;
    const lv = state.inner;
    switch (kind) {
      case "A":
      case "N":
        if (lv.phase === "output") lv.shell = true;
        state.innerMarked = true;
        lv.phase = "prompt";
        lv.start = null;
        return;
      case "B":
        if (state.innerMarked) this.begin(lv);
        return;
      case "C":
        if (state.innerMarked && lv.phase !== "output") this.run(lv);
        return;
      case "D":
        // A D before the shell's first prompt (roster's hook, kitty and VS Code print one) ends
        // nothing; after a command, that command.
        if (lv.phase === "output") state.innerDone = true;
        lv.phase = "idle";
        lv.command = null;
        return;
    }
  }

  private begin(lv: Level) {
    const b = this.term.buffer.active;
    lv.phase = "input";
    lv.start = { line: b.baseY + b.cursorY, col: b.cursorX };
  }

  private run(lv: Level) {
    const b = this.term.buffer.active;
    lv.command = lv.phase === "input" ? this.commandLine(lv) : null;
    lv.phase = "output";
    lv.dirty = false;
    lv.shell = false;
    lv.start = null;
    lv.cLine = b.cursorX > 0 ? this.lineStartOf(b.baseY + b.cursorY) : null;
  }

  /** The buffer line where the line through buffer line `y` starts (it may have wrapped). */
  private lineStartOf(y: number): number {
    const b = this.term.buffer.active;
    while (y > 0 && b.getLine(y)?.isWrapped) y--;
    return y;
  }

  /** The command line, from where `B` left the cursor to where it is at `C`, as the screen shows
   * it; null if it scrolled away or was reflowed. */
  private commandLine(lv: Level): string | null {
    const start = lv.start;
    const b = this.term.buffer.active;
    if (!start || start.line < 0) return null;
    let end = b.baseY + b.cursorY;
    let endCol = b.cursorX;
    if (endCol === 0 && end > start.line) {
      end--;
      endCol = this.term.cols;
    }
    let text = "";
    for (let y = start.line; y <= end; y++) {
      const row = b.getLine(y);
      if (!row) return null;
      const last = y === end;
      text += row.translateToString(false, y === start.line ? start.col : 0, last ? endCol : this.term.cols);
    }
    return text.trim() || null;
  }
}

function newHop(hop: Hop): HopState {
  return { hop, inner: level(), innerMarked: false, innerDone: false, typed: false, asked: false, sshDirty: false, filled: false };
}

function fillHop(hop: Extract<Hop, { known: true }>): FillHop {
  return { host: hop.host, address: hop.address, port: hop.port, user: hop.user };
}
