/* eslint-disable no-control-regex -- terminal escape sequences are made of control characters */
// Shell hooks (ticket 121, #210; decision Q130): opt-in, roster sends one line to a Session's
// shell after login that turns on OSC 133 marks (and OSC 7, its folder) in that shell process
// only. Nothing is written to the Host's files: the hook goes when the shell exits.
//
// It's careful about when: only once the login has gone quiet at a prompt it knows (a POSIX
// shell's `host$ `, `host# ` or `host% `, fish's `user@host ~> `, PowerShell's `PS …> `), never
// once the user has typed, never when the shell already marks its prompts. A login that isn't a
// plain shell (a forced command, a menu, a network CLI, ESXi's busybox prompt, tcsh's `host:~ % `)
// shows no prompt it knows, so nothing is sent. A shell that looks like bash but doesn't take the
// line (tcsh with a bash-like prompt) prints at most an error; that's cleared with the echo.

/** Which hook line fits the shell: one for bash and zsh (it checks which it's in, and does
 * nothing in another POSIX shell), one for fish, one for PowerShell. */
export type ShellKind = "posix" | "fish" | "pwsh";

/** CSI, OSC and other escape sequences, so a coloured prompt reads as its text. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[^[\]]/g;

/** The text of the line the cursor is on: what follows the last line feed or carriage return. */
export function lastLine(out: string): string {
  const plain = out.replace(ESCAPES, "");
  return plain.slice(Math.max(plain.lastIndexOf("\n"), plain.lastIndexOf("\r")) + 1);
}

const PWSH = /^PS \S.*> $/;
const FISH = /^[^\s@[\]:]+@[^\s@[\]:]+ [~/]\S*(?: \([^)]*\))?[>#] $/;
/** `$`, `#` or `%` right after the prompt's text (`user@web-01:~$ `, `web-01% `), or a `$` on
 * its own (a two-line prompt's second line). Not after a space, which is tcsh's (`web-01:~ % `)
 * and a menu's (`Choice # `). */
const POSIX = /(?:[^\s$#%][$#%]|^\$) $/;

// The hook lines: the snippets in docs/plugins.md ("Shell integration"), squeezed to one line,
// plus OSC 7 (the folder) at each prompt. Each starts with a space, so a shell set to leave such
// lines out of its history (bash's HISTCONTROL=ignorespace or ignoreboth, zsh's
// HIST_IGNORE_SPACE, fish always) does. docs/plugins.md shows them as sent; keep it in step.
//
// The POSIX one runs in bash and zsh: each half is a single-quoted string, eval'd only behind a
// test of $BASH_VERSION or $ZSH_VERSION, so another POSIX shell (dash, busybox ash, ksh) parses
// it and runs neither. Both work under `set -u`. The marks go on from a hook that runs last at
// each prompt and wraps PS1 again whenever it has lost them, so a prompt framework that builds
// PS1 at every prompt (starship, oh-my-zsh, oh-my-bash) keeps them; the exit code comes from a
// hook that runs first. bash before 4.4 has no PS0, so it gets no C mark (the rest still work).
// The PowerShell one uses [char]27, not `e, so Windows PowerShell 5.1 gets marks and not stray
// letters, and calls the history handler that was there (PSReadLine's default, or the user's)
// rather than replacing it.
const BASH =
  "[ -n \"${BASH_VERSION-}\" ] && eval '" +
  '__roster_d(){ local c=$?; printf "\\e]133;D;%s;roster=@N@\\a\\e]7;file://%s%s\\a" "$c" "${HOSTNAME-}" "$PWD"; return $c; }; ' +
  '__roster_w(){ case $PS1 in *"roster=@N@"*) ;; *) PS1="\\[\\e]133;A;roster=@N@\\a\\]$PS1\\[\\e]133;B;roster=@N@\\a\\]";; esac; }; ' +
  'case $BASH_VERSION in [1-4].*|5.0.*) PROMPT_COMMAND="__roster_d${PROMPT_COMMAND:+;$PROMPT_COMMAND};__roster_w";; ' +
  '*) PROMPT_COMMAND=(__roster_d ${PROMPT_COMMAND[@]+"${PROMPT_COMMAND[@]}"} __roster_w);; esac; ' +
  'case $BASH_VERSION in [1-3].*|4.[0-3].*) ;; *) PS0="\\e]133;C;roster=@N@\\a${PS0-}";; esac' +
  "'";
const ZSH =
  "[ -n \"${ZSH_VERSION-}\" ] && eval '" +
  "typeset -ga precmd_functions preexec_functions; " +
  '__roster_d(){ printf "\\e]133;D;%s;roster=@N@\\a\\e]7;file://%s%s\\a" $? "${HOST-}" "$PWD"; }; ' +
  '__roster_c(){ printf "\\e]133;C;roster=@N@\\a"; }; ' +
  '__roster_w(){ [[ $PS1 == *"roster=@N@"* ]] || PS1="%{$(printf "\\e]133;A;roster=@N@\\a")%}$PS1%{$(printf "\\e]133;B;roster=@N@\\a")%}"; }; ' +
  "precmd_functions=(__roster_d $precmd_functions __roster_w); preexec_functions+=(__roster_c)" +
  "'";
const FISH_HOOK =
  "function __roster_a --on-event fish_prompt; printf '\\e]7;file://%s%s\\a\\e]133;A;roster=@N@\\a' $hostname $PWD; end; " +
  "functions -c fish_prompt __roster_p; function fish_prompt; __roster_p; printf '\\e]133;B;roster=@N@\\a'; end; " +
  "function __roster_c --on-event fish_preexec; printf '\\e]133;C;roster=@N@\\a'; end; " +
  "function __roster_d --on-event fish_postexec; printf '\\e]133;D;%s;roster=@N@\\a' $status; end";
const PWSH_HOOK =
  "$Global:__roster_p=$function:prompt; function Global:prompt { $c=if($?){0}elseif($LASTEXITCODE){$LASTEXITCODE}else{1}; " +
  "$e=[char]27; $b=[char]7; $d='/'+($PWD.ProviderPath -replace '\\\\','/').TrimStart('/'); " +
  '"$e]133;D;$c;roster=@N@$b$e]7;file://$([Environment]::MachineName)$d$b$e]133;A;roster=@N@$b$(& $Global:__roster_p)$e]133;B;roster=@N@$b" }; ' +
  "try { $h=(Get-PSReadLineOption).AddToHistoryHandler; Set-PSReadLineOption -AddToHistoryHandler ({ param($l) " +
  '[Console]::Write("$([char]27)]133;C;roster=@N@$([char]7)"); if ($h) { $h.Invoke($l) } else { $true } }.GetNewClosure()) } catch {}';

/** The one line roster sends (without the Enter) to turn the marks on in a `kind` shell, every
 * mark carrying the Session's token `nonce` (`roster=NONCE`, ticket 120, decision Q131): only a
 * mark with it is the Session's own shell's, since no other machine ever sees it. */
export function hookLine(kind: ShellKind, nonce: string): string {
  if (!/^[0-9a-f]{8,64}$/.test(nonce)) throw new Error("a shell hook token is hex");
  const line = kind === "fish" ? FISH_HOOK : kind === "pwsh" ? PWSH_HOOK : `${BASH}; ${ZSH}`;
  return ` ${line.replaceAll("@N@", nonce)}`;
}

/** A new Session token for roster's marks: 96 random bits, in hex. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The shell whose idle prompt ends `out`, or null when it isn't a prompt roster knows. */
export function promptShell(out: string): ShellKind | null {
  const line = lastLine(out);
  if (PWSH.test(line)) return "pwsh";
  if (FISH.test(line)) return "fish";
  if (POSIX.test(line)) return "posix";
  return null;
}

/** How long the login must stay quiet at a prompt before roster sends the line. */
export const IDLE_MS = 400;
/** How long after the Session starts roster may send it: a prompt after that isn't the login's. */
export const WINDOW_MS = 20_000;
/** How long the echo is held off the screen waiting for the new prompt; then it all shows. */
export const HOLD_MS = 2_000;
/** The most output held; more, and it all shows. */
const HOLD_MAX = 16 * 1024;
const TAIL_MAX = 1024;

/** What `:integrate` found: the marks are on (`on`), the line went but no marked prompt came
 * back (`no-marks`), or why nothing was sent. */
export type IntegrateResult = "on" | "no-marks" | "marked" | "no-prompt" | "not-open";

export interface ShellHooksIo {
  /** Writes `line` to the Session; false when it isn't open (yet). */
  write(line: string): boolean;
  /** Puts output on the screen (and in its replay), after it was held. */
  show(data: Uint8Array): void;
  /** The shell said its folder (OSC 7). */
  cwd(path: string): void;
  /** Whether roster may send the line by itself (`shell_hooks`). */
  enabled(): boolean;
  /** What came of the line, once it's known (ticket 120: the echo window for Plugins closes). */
  settled?(outcome: "on" | "no-marks"): void;
}

/** Escape sequences in what's typed: CSI (keys, and the terminal's reports: cursor, attributes,
 * modes, keyboard protocol, mouse, focus), OSC and DCS answers, SS3 keys. What's left after them is
 * typing. */
const SEQUENCES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P_^][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bO.|\x1b[ -~]/g;

/** Whether what the terminal sent has typing in it, once its escape sequences (reports, mouse,
 * focus, cursor keys) are taken out. */
export function hasTyping(data: string): boolean {
  return data.replace(SEQUENCES, "") !== "";
}
const MARK = "\x1b]133;";
const MARK_A = /\x1b\]133;A[^\x07\x1b]*(?:\x07|\x1b\\)/;
const MARK_B = /\x1b\]133;B[^\x07\x1b]*(?:\x07|\x1b\\)/;
const OSC7 = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC7_START = "\x1b]7;";

const squash = (s: string) => s.replace(ESCAPES, "").replace(/\s+/g, "");
const encoder = new TextEncoder();

/** The folder in an OSC 7 `file://host/path`, decoded where it can be; null for anything else. */
function folderOf(url: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(url);
  if (!m?.[1]) return null;
  let path = m[1];
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not percent-encoded (the hook sends $PWD as it is): keep it.
  }
  return path.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 1024);
}

/** The bytes as one array. */
function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}

/** Where `needle` (ASCII) first starts in `bytes`, or -1. */
function indexOf(bytes: Uint8Array, needle: string, from = 0): number {
  const n = encoder.encode(needle);
  outer: for (let i = from; i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

/** One Session attempt's shell hooks: watches its output for an idle prompt, sends the hook line
 * once, holds the echo back until the new prompt comes, and reads OSC 7. */
export class ShellHooks {
  private readonly io: ShellHooksIo;
  /** The Session's token in roster's marks. */
  private readonly nonce: string;
  /** The shell prints roster's own marks (with this Session's token). */
  private ours = false;
  private tail = "";
  private armed = true;
  private typedYet = false;
  private marked = false;
  private sentLine: string | null = null;
  /** The prompt line the line was sent at, as text. */
  private sentAt = "";
  /** What came of the line: null while it's out (or before it went). */
  private outcome: "on" | "no-marks" | null = null;
  private waiting: ((r: IntegrateResult) => void)[] = [];
  private held: Uint8Array[] | null = null;
  private heldText = "";
  private oscCarry = "";
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly windowTimer: ReturnType<typeof setTimeout>;

  constructor(io: ShellHooksIo, nonce: string) {
    this.io = io;
    this.nonce = nonce;
    this.windowTimer = setTimeout(() => {
      this.armed = false;
      clearTimeout(this.idleTimer);
    }, WINDOW_MS);
  }

  /** The Session printed `data` (`text`, decoded by a streaming decoder). Returns what to show
   * now, or null: held. */
  output(data: Uint8Array, text: string): Uint8Array | null {
    this.scanFolder(text);
    if (this.held) {
      this.held.push(data);
      this.heldText += text;
      this.release();
      return null;
    }
    this.tail = (this.tail + text).slice(-TAIL_MAX);
    if (this.tail.includes(MARK)) this.marked = true;
    if (this.tail.includes(`roster=${this.nonce}`)) this.ours = true;
    if (this.armed && this.sentLine === null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.idle(), IDLE_MS);
    }
    return data;
  }

  /** The user's terminal sent `data` to the Session: typing, unless it's only the terminal's own
   * answers or keys that move the cursor (whose effect the prompt check sees). */
  typed(data: string) {
    if (!hasTyping(data)) return;
    this.typedYet = true;
    clearTimeout(this.idleTimer);
    this.giveUp();
  }

  /** `:integrate`: sends the line now if the shell is at a prompt roster knows, and answers once
   * a marked prompt came back, or didn't. */
  integrate(): Promise<IntegrateResult> {
    if (this.outcome) return Promise.resolve(this.outcome);
    if (this.sentLine !== null) return new Promise((resolve) => this.waiting.push(resolve));
    // Marks that aren't roster's (the shell's own integration) don't stop it: the user asked, and
    // roster's marks, with the token, go round them.
    if (this.ours) return Promise.resolve("marked");
    const kind = promptShell(this.tail);
    if (!kind) return Promise.resolve("no-prompt");
    if (!this.send(kind)) return Promise.resolve("not-open");
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** The Session ended or its tab closed: what's held shows, and nothing more is sent. */
  stop() {
    clearTimeout(this.windowTimer);
    clearTimeout(this.idleTimer);
    this.armed = false;
    this.giveUp();
  }

  private idle() {
    if (!this.armed || this.typedYet || this.marked || this.sentLine !== null || !this.io.enabled()) return;
    const kind = promptShell(this.tail);
    if (kind && !this.send(kind)) this.idleTimer = setTimeout(() => this.idle(), IDLE_MS);
  }

  private send(kind: ShellKind): boolean {
    const line = hookLine(kind, this.nonce);
    if (!this.io.write(line + "\r")) return false;
    this.sentLine = line;
    this.sentAt = lastLine(this.tail);
    this.armed = false;
    clearTimeout(this.idleTimer);
    this.held = [];
    this.heldText = "";
    this.holdTimer = setTimeout(() => this.timedOut(), HOLD_MS);
    return true;
  }

  private settle(outcome: "on" | "no-marks") {
    this.outcome = outcome;
    this.io.settled?.(outcome);
    for (const resolve of this.waiting.splice(0)) resolve(outcome);
  }

  /** The new prompt is in (its `A` and `B` marks) after nothing but the echo: the old prompt is
   * cleared and the new one drawn in its place. Anything else shows as it came. */
  private release() {
    const a = MARK_A.exec(this.heldText);
    const b = a ? MARK_B.exec(this.heldText.slice(a.index)) : null;
    if (!a || !b) {
      if (this.heldText.length > HOLD_MAX) this.giveUp();
      return;
    }
    const before = this.heldText.slice(0, a.index);
    if (!this.onlyEcho(before)) return this.giveUp("on");
    // The echo goes; a mode the shell set or reset meanwhile (bracketed paste) stays.
    const modes = (before.match(/\x1b\[\?[\d;]*[hl]/g) ?? []).join("");
    const up = (this.heldText.slice(a.index, a.index + b.index).match(/\n/g) ?? []).length;
    const bytes = joined(this.held ?? []);
    this.endHold();
    // From the A mark on, the bytes as they came: a character cut at the end stays whole.
    this.io.show(encoder.encode(modes + "\r" + (up ? `\x1b[${up}A` : "") + "\x1b[J"));
    this.io.show(bytes.subarray(indexOf(bytes, MARK + "A")));
    this.settle("on");
  }

  /** Whether `text` is only the echo of the line, with zsh's end-of-line mark (PROMPT_SP: `%` or
   * `#` and padding) after it, and escape sequences anywhere. */
  private onlyEcho(text: string): boolean {
    const echo = squash(this.sentLine ?? "");
    const got = squash(text);
    return got === echo || ((got === echo + "%" || got === echo + "#") && /\r/.test(text.slice(text.lastIndexOf("%"))));
  }

  /** No marked prompt in time. A shell that didn't take the line and printed only the echo, a
   * short error and the same prompt again (tcsh with a bash-like prompt, dash) gets that cleared,
   * so its prompt is as it was; anything else shows as it came. */
  private timedOut() {
    const text = this.heldText;
    const bytes = joined(this.held ?? []);
    const lf = bytes.lastIndexOf(10);
    const between = text.slice(0, text.lastIndexOf("\n") + 1);
    const clean =
      lf >= 0 &&
      squash(between).startsWith(squash(this.sentLine ?? "")) &&
      lastLine(text) === this.sentAt &&
      (between.match(/\n/g) ?? []).length <= 4 &&
      squash(between).length - squash(this.sentLine ?? "").length <= 240;
    if (!clean) return this.giveUp();
    this.endHold();
    this.io.show(encoder.encode("\r\x1b[J"));
    this.io.show(bytes.subarray(lf + 1));
    this.settle("no-marks");
  }

  /** Shows what's held as it came; `outcome` says what came of the line (no marks, by default). */
  private giveUp(outcome: "on" | "no-marks" = "no-marks") {
    const held = this.held;
    if (!held) return;
    this.endHold();
    for (const chunk of held) this.io.show(chunk);
    this.settle(outcome);
  }

  private endHold() {
    clearTimeout(this.holdTimer);
    this.held = null;
    this.heldText = "";
  }

  private scanFolder(text: string) {
    const s = this.oscCarry + text;
    this.oscCarry = "";
    if (!s.includes("\x1b")) return;
    let end = 0;
    for (const m of s.matchAll(OSC7)) {
      end = m.index + m[0].length;
      const folder = folderOf(m[1] ?? "");
      if (folder) this.io.cwd(folder);
    }
    // An OSC 7 cut off at the end of this read: the rest comes in the next.
    const open = s.lastIndexOf(OSC7_START);
    if (open >= end && s.length - open < 2048) this.oscCarry = s.slice(open);
    else {
      for (let n = OSC7_START.length - 1; n > 0; n--) {
        if (s.endsWith(OSC7_START.slice(0, n))) {
          this.oscCarry = s.slice(-n);
          break;
        }
      }
    }
  }
}

/** Whether roster sends the hook line by itself: init.lua's `terminal.shell_hooks` (`init`) and
 * the Host's `shell_hooks` in roster.yml (`host`; undefined for a Quick Connect). init.lua's
 * false is off everywhere; else the Host's own value wins, then init.lua's; off when neither says. */
export function shellHooksOn(init: boolean | null, host: boolean | null | undefined): boolean {
  if (init === false) return false;
  return host ?? init ?? false;
}

/** Takes a Session's token out of its output before Plugins get it (ticket 120, decision Q131):
 * the marks carry it, and anything that prints the shell's prompt settings or history shows it.
 * Each token character becomes a dash, found even when a terminal wraps it (a line break, or
 * cursor moves and erases, inside it, as ConPTY draws a long line). Output ending part-way into
 * what may be the token waits for the next read (`holding`); `flush` lets it out with that part
 * dashed when it's long enough to be the token's (6 characters) or follows `roster=`, so a held
 * part never goes out as it was. Output with nothing of it passes as the same bytes, uncopied. */
export class TokenMask {
  private readonly token: Uint8Array;
  private carry: Uint8Array | null = null;
  /** The held part follows `roster=`. */
  private carryAfterLead = false;

  constructor(nonce: string) {
    this.token = encoder.encode(nonce);
  }

  /** Whether output is held back, waiting for the read that tells whether it's the token. */
  holding(): boolean {
    return this.carry !== null;
  }

  mask(data: Uint8Array): Uint8Array {
    const buf = this.carry ? joined([this.carry, data]) : data;
    this.carry = null;
    let out: Uint8Array | null = null;
    const first = this.token[0] ?? 0;
    for (let i = buf.indexOf(first); i >= 0; i = buf.indexOf(first, i + 1)) {
      const m = this.matchAt(buf, i);
      if (m.complete) {
        out ??= buf === data ? buf.slice() : buf;
        for (const at of m.at) out[at] = 45;
      } else if (m.atEnd) {
        const kept = out ?? buf;
        this.carry = kept.slice(i);
        this.carryAfterLead = indexOf(kept.subarray(Math.max(0, i - 7), i), "roster=") === 0;
        return kept.subarray(0, i);
      }
    }
    return out ?? buf;
  }

  /** What's held back, with any part of the token in it dashed when it may be the token's. */
  flush(): Uint8Array {
    const rest = this.carry;
    this.carry = null;
    if (!rest) return new Uint8Array(0);
    const m = this.matchAt(rest, 0);
    if (m.at.length >= 6 || this.carryAfterLead) for (const at of m.at) rest[at] = 45;
    return rest;
  }

  /** The token's characters from `i` on, skipping line breaks and escape sequences between them:
   * where each was, whether it's all there, and whether `buf` ended part-way. */
  private matchAt(buf: Uint8Array, i: number): { at: number[]; complete: boolean; atEnd: boolean } {
    const t = this.token;
    const at: number[] = [];
    let k = i;
    while (at.length < t.length) {
      if (k >= buf.length) return { at, complete: false, atEnd: true };
      const b = buf[k];
      if (b === t[at.length]) {
        at.push(k++);
        continue;
      }
      if (at.length === 0) break;
      const skip = ignorable(buf, k);
      if (skip === 0) break;
      if (skip < 0) return { at, complete: false, atEnd: true };
      k += skip;
    }
    return { at, complete: at.length === t.length, atEnd: false };
  }
}

/** How long the line break or escape sequence at `k` is (0: neither; -1: cut off at the end). */
function ignorable(buf: Uint8Array, k: number): number {
  const b = buf[k];
  if (b === 13 || b === 10) return 1;
  if (b !== 27) return 0;
  const next = buf[k + 1];
  if (next === undefined) return -1;
  if (next === 91) {
    for (let j = k + 2; j < buf.length; j++) if ((buf[j] ?? 0) >= 0x40 && (buf[j] ?? 0) <= 0x7e) return j - k + 1;
    return -1;
  }
  if (next === 93) {
    for (let j = k + 2; j < buf.length; j++) {
      if (buf[j] === 7) return j - k + 1;
      if (buf[j] === 27 && buf[j + 1] === 92) return j - k + 2;
    }
    return -1;
  }
  return 2;
}
