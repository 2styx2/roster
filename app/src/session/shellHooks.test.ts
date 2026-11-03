/* eslint-disable no-control-regex -- terminal output is made of control characters */
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CsiClamp, XtermPromptScreen } from "./promptScreen";
import { HOLD_MS, IDLE_MS, ShellHooks, TokenMask, WINDOW_MS, hookLine, newNonce, promptShell, shellHooksOn, type CursorLine } from "./shellHooks";

/** The Session's token in roster's own marks (ticket 120, Q131). */
const NONCE = "0123456789abcdef01234567";

/** The cursor's line once a terminal (xterm, as the tab's) of `size` has drawn `out`. */
async function at(out: string, size = { cols: 80, rows: 24 }): Promise<CursorLine> {
  const screen = new XtermPromptScreen(size);
  screen.write(out);
  await screen.flushed();
  const line = screen.line();
  screen.dispose();
  return line;
}

describe("promptShell: which shell an idle prompt is, from what it printed", () => {
  it.each([
    ["Last login: today\r\nuser@web-01:~$ ", "posix"],
    ["root@web-01:~# ", "posix"],
    ["web-01% ", "posix"],
    ["bash-5.2$ ", "posix"],
    ["[user@web-01 ~]$ ", "posix"],
    ["\x1b[01;32muser@web-01\x1b[00m:\x1b[01;34m~\x1b[00m$ ", "posix"],
    ["\x1b]0;user@web-01: ~\x07user@web-01:~$ ", "posix"],
    ["[web-01 ~]\r\n$ ", "posix"],
    ["user@web-01 ~> ", "fish"],
    ["root@web-01 /etc# ", "fish"],
    ["PS C:\\Users\\admin> ", "pwsh"],
    ["PS /home/admin> ", "pwsh"],
  ])("%j is %s", async (out, shell) => {
    expect(promptShell(await at(out))).toBe(shell);
  });

  it.each([
    ["[root@esx-02:~] ", "ESXi's busybox"],
    ["switch01#", "a network CLI with no space"],
    ["switch01>", "a network CLI"],
    ["user@router> ", "a router CLI"],
    ["[admin@appliance] > ", "an appliance CLI"],
    ["Select an option [1-4]: ", "a menu"],
    ["user@web-01's password: ", "a password prompt"],
    ["", "nothing yet"],
    ["user@web-01:~$ ls", "a prompt with something typed"],
    ["Press any key to continue", "a banner"],
    ["user@web-01:~ % ", "tcsh's default prompt"],
    ["root@web-01:~ # ", "tcsh's root prompt"],
    ["% ", "a bare %"],
    ["Choice # ", "a menu asking for a number"],
    ["Enter selection # ", "a menu"],
  ])("%j (%s) is nothing it knows", async (out) => {
    expect(promptShell(await at(out))).toBeNull();
  });
});

/** The cells `text` takes on a terminal: CJK takes two; an emoji one, as fish counts it by default
 * (`fish_emoji_width` 1) and as xterm's Unicode 6 widths, the tab's own, draw it. */
const cells = (text: string) =>
  [...text].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/u.test(ch) ? 2 : 1), 0);

/** A prompt as fish 3.x draws it (from real fish output on CI, names made up): the window title,
 * a colour reset with a charset designator (`ESC ( B`) between the parts, then `ESC[K`, a carriage
 * return and a move right to the end of the prompt, so the text after the last `\r` is empty. */
function fish3(user: string, host: string, cwd: string, vcs = "", status = "", suffix = ">"): string {
  const reset = "\x1b(B\x1b[m";
  const parts = `${user}${reset}@${host}${reset} ${cwd}${reset}${vcs}${reset}${status ? ` ${status}` : ""}${suffix} `;
  const width = cells(`${user}@${host} ${cwd}${vcs}${status ? ` ${status}` : ""}${suffix} `);
  return `\x1b]0;${cwd}\x07\x1b[30m${reset}\r${parts}\x1b[K\r\x1b[${width}C`;
}

describe("promptShell reads the prompt line off the Session's screen (ticket 159, #296)", () => {
  it.each([
    [fish3("user", "web-01", "~/src/app", " ((f5c479ed))"), "fish 3 in a detached HEAD", "fish"],
    [fish3("user", "web-01", "~/src/app", " (main)"), "fish 3 on a branch", "fish"],
    [fish3("user", "web-01", "~/src/app", " (pin-deps)"), "fish 3 on a branch named like a PIN", "fish"],
    [fish3("user", "web-01", "/tmp"), "fish 3's default prompt", "fish"],
    [fish3("user", "web-01", "~/tokens"), "fish 3 in a folder named like a token", "fish"],
    [fish3("user", "web-01", "~", "", "[1]"), "fish 3 after a failed command", "fish"],
    [fish3("user", "web-01", "~", " (main)", "[1|0]"), "fish 3 after a failed pipeline", "fish"],
    [fish3("root", "web-01", "/etc", "", "", "#"), "fish 3 as root", "fish"],
    [fish3("user", "web-01", "~/文档"), "fish 3 in a folder with wide characters (finding 9)", "fish"],
    [fish3("user", "web-01", "~/🚀x", " (main)"), "fish 3 in a folder with an emoji (finding 9)", "fish"],
    ["\x1b(Buser@web-01 ~> ", "fish after a charset designator", "fish"],
    ["user@web-01:~$ ls\b\b\x1b[K", "bash after the typed-ahead text was erased", "posix"],
    ["\r\x1b[Kuser@web-01:~$ ", "bash after clearing the line", "posix"],
    ["user@web-01:~$ x\b \b", "bash after a backspace", "posix"],
    ["%" + " ".repeat(79) + "\r \r" + "web-01% ", "zsh after its end-of-line mark (PROMPT_SP)", "posix"],
    ["web-01% \x1b[K\r\x1b[8C", "zsh moving the cursor back to its prompt's end", "posix"],
    ["web-01\x1b[3D\x1b[3C% ", "a prompt drawn with moves back and forth", "posix"],
    ["\x1b[2J\x1b[H\x1b[1Guser@web-01:~$ ", "a prompt after a cleared screen", "posix"],
    ["PS /home/admin> \x1b[K\r\x1b[16C", "PowerShell moving the cursor back to its prompt's end", "pwsh"],
    ["PS C:\\Users\\admin> \x1b[?25l\x1b[?25h", "PowerShell hiding and showing the cursor", "pwsh"],
    ["PS /home/admin> \x1b[?25l\x1b[1;17H\x1b[?25h", "PowerShell putting the cursor back on its prompt by row", "pwsh"],
    ["\x1b[?25l\x1b[1;1HPS /tmp> ls\x1b[2;1H\x1b[2;10H\x1b[1;10H\x1b[K\x1b[1;10H", "PowerShell erasing a line it drew over two rows", "pwsh"],
    ["Last login: today\r\n" + "x".repeat(1100) + "\r\nuser@web-01:~$ ", "a prompt after a line longer than 1 KB", "posix"],
  ])("%j (%s) is %s", async (out, _, shell) => {
    expect(promptShell(await at(out))).toBe(shell);
  });

  it("reads PSReadLine's next line of an unfinished command, put back by row (real pwsh output on CI)", async () => {
    const line = "\x1b[?25l\x1b[1;1H\x1b[0m\x1b[92mif\x1b[0m \x1b[37m{\x1b[39;49m\x1b[0m\x1b[1;5H\x1b[?12l\x1b[?25h";
    const next = "\x1b[?25l\x1b[2;1H\x1b[0m\x1b[37m>> \x1b[39;49m\x1b[0m\x1b[2;4H\x1b[?12l\x1b[?25h";
    expect((await at("PS /home/admin> \x1b[6n" + line + next)).text).toBe(">> ");
  });

  // The hook line is a write into the user's shell, with the Session's token: never at a password
  // prompt, however it was drawn, nor anywhere but the end of an idle prompt.
  it.each([
    ["[sudo] password for user: ", "sudo's prompt"],
    ["Password: ", "su's prompt"],
    ["user@web-01's password: ", "ssh's prompt"],
    ["Enter passphrase for key '/home/user/.ssh/id_ed25519': ", "ssh's key passphrase"],
    ["user@web-01:~$ sudo -i\r\n[sudo] password for user: ", "sudo's prompt after a shell prompt"],
    ["user@web-01:~$ \rPassword: ", "a password prompt drawn over a shell prompt"],
    [fish3("user", "web-01", "~") + "\r[sudo] password for user: ", "sudo's prompt drawn over fish's"],
    ["\x1b[K[sudo] password for user: \r\x1b[26C", "sudo's prompt with the cursor moved back to its end"],
    ["Password# ", "a password prompt ending like a root prompt"],
    ["[sudo] password for user$ ", "a sudo prompt ending like a shell prompt"],
    ["user@web-01 ~/passwords> \rPassphrase> ", "a passphrase prompt drawn over fish's"],
    ["Passwort: \r\nweb-01% ", "German, the row above"],
    ["Kennwort# ", "German, ending like a root prompt"],
    ["Mot de passe : \r\nweb-01$ ", "French, the row above"],
    ["Contraseña$ ", "Spanish"],
    ["Senha$ ", "Portuguese"],
    ["密码# ", "Chinese"],
    ["パスワード$ ", "Japanese"],
    ["Enter your PIN\r\n$ ", "a PIN asked for on the row above (finding 4)"],
    ["Enter PIN:\r\n\r\nweb-01% ", "a PIN asked for two rows above"],
    ["OTP code:\r\nweb-01% ", "a one-time code"],
    ["One-time code$ ", "a one-time code ending like a prompt"],
    ["Token? \r\nweb-01% ", "a token"],
    ["Verification code$ ", "a verification code"],
    ["Passcode# ", "a passcode"],
    ["user@web-01:~$ \x1b7\r\nPassword: \x1b8", "a password prompt drawn below, the cursor restored"],
    ["user@web-01:~$ ls\x1b[2D", "a prompt with text after the cursor"],
    ["user@web-01:~$ \x1b[3D", "the cursor moved back into the prompt"],
    ["\r\nuser@web-01:~$ \x1b[1A", "the cursor moved up off the prompt"],
    ["user@web-01:~$ \x1b[5;1H", "the cursor moved to another row"],
    ["PS /home/admin> \x1b[30;17H", "the cursor moved to row 30 (finding 7)"],
    ["user@web-01:~$ \r\n\x1b[7;16H", "the cursor moved by row after a line feed"],
    ["user@web-01:~$ \r\x1b[K", "a cleared line"],
    ["user@web-01:~$ \x1b[2K", "a line erased under the cursor"],
    ["user@web-01:~$ \x1b[5;10r", "a scroll region set, which homes the cursor (finding 3)"],
    ["user@web-01:~$ \x1bc", "a terminal reset (finding 3)"],
    ["user@web-01:~$ \x1b[3S", "the screen scrolled up (finding 3)"],
    ["user@web-01:~$ \x1b[2L", "lines inserted at the cursor (finding 3)"],
    ["web-01% \x1b[2I", "a tab forward (finding 3)"],
    ["user@web-01:~$ x\x1b[5b", "a character repeated (finding 3)"],
    ["\x1b[?1049huser@web-01:~$ ", "a prompt-like line on the alternate screen"],
    ["user@web-01 ~ (main> ", "fish's prompt with a parenthesis that isn't closed"],
    ["root@db ~ (mysql db)> ", "a parenthesis with a space in it (finding 6)"],
    ["user@web-01 ~ (a>b)> ", "a parenthesis with a > in it (finding 6)"],
    ["user@web-01 ~/src (feature/x|REBASE-i 1/3)> ", "a parenthesis with a space (finding 6)"],
    ["user@web-01 ~ (main))> ", "a parenthesis closed twice (finding 6)"],
  ])("%j (%s) is nothing it sends to", async (out) => {
    expect(promptShell(await at(out))).toBeNull();
  });

  it("doesn't send at a prompt the shell redrew with a recalled command (Up, then Home) (finding 1)", async () => {
    // One row: the recalled command after the cursor.
    expect(promptShell(await at("user@web-01:~$ ls -la\x1b[6D"))).toBeNull();
    // Wrapped onto a second row, the cursor put back after the prompt with a move up.
    const recalled = "user@web-01:~$ " + "echo " + "a".repeat(40);
    expect(promptShell(await at(recalled + "\x1b[1A\r\x1b[15C", { cols: 40, rows: 10 }))).toBeNull();
  });

  it("refuses a password asked for at the start of a line longer than 1 KB (finding 8)", async () => {
    expect(promptShell(await at("Enter password for the key: " + "*".repeat(1100) + " web-01% "))).toBeNull();
  });

  it("takes huge counts in moves and repeats in bounded time (finding 2)", async () => {
    const from = performance.now();
    for (const seq of ["\x1b[99999999@", "\x1b[99999999P", "\x1b[99999999X", "\x1b[99999999L", "\x1b[99999999M", "\x1b[99999999S", "\x1b[99999999T"])
      await at("user@web-01:~$ " + seq);
    for (const seq of ["\x1b[99999999C", "\x1b[99999999D", "x\x1b[99999999b", "\x1b[99999999;99999999H", "\x1b[99999999I"]) {
      expect(promptShell(await at("user@web-01:~$ " + seq))).toBeNull();
    }
    expect(performance.now() - from).toBeLessThan(5_000);
  });
});

describe("CsiClamp: the prompt screen's bound on CSI counts", () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  it("caps each parameter at 9999 and passes the rest as it came, split across reads or not", () => {
    const clamp = new CsiClamp();
    expect(dec.decode(clamp.clamp(enc.encode("a\x1b[99999999;5;123456M\x1b[?2004h\x1b[38;5;1mb")))).toBe(
      "a\x1b[9999;5;9999M\x1b[?2004h\x1b[38;5;1mb",
    );
    expect(dec.decode(clamp.clamp(enc.encode("\x1b[123")))).toBe("");
    expect(dec.decode(clamp.clamp(enc.encode("45678L\x1b")))).toBe("\x1b[9999L");
    expect(dec.decode(clamp.clamp(enc.encode("]0;t\x07")))).toBe("\x1b]0;t\x07");
    // A control inside a CSI runs where it is, the CSI still going, as in a terminal; ESC, CAN
    // and SUB end it.
    expect(dec.decode(clamp.clamp(enc.encode("\x1b[99\b999999C\x1b[5\x18x")))).toBe("\b\x1b[9999C\x1b[5\x18x");
    // Leading zeros change nothing: 0005 is 5.
    expect(dec.decode(clamp.clamp(enc.encode("\x1b[" + "0".repeat(20) + "5;00D")))).toBe("\x1b[5;0D");
  });
});

describe("CsiClamp: what the prompt screen draws is what the tab's terminal draws (security pass on #298)", () => {
  /** The cursor's line once a plain xterm, with no clamp, has drawn `out`: the tab's own. */
  async function plain(out: string): Promise<{ text: string; rest: string }> {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 50, allowProposedApi: false });
    await new Promise<void>((resolve) => term.write(out, resolve));
    const b = term.buffer.active;
    const row = b.getLine(b.baseY + b.cursorY);
    const line = { text: row?.translateToString(false, 0, b.cursorX) ?? "", rest: row?.translateToString(true, b.cursorX) ?? "" };
    term.dispose();
    return line;
  }

  it("clamps a CSI begun with the C1 introducer (U+009B) as one begun with ESC [", () => {
    const clamp = new CsiClamp();
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    expect(dec.decode(clamp.clamp(enc.encode("a\u009b99999999M\u009b5;123456Hb")))).toBe("a\u009b9999M\u009b5;9999Hb");
    // Split between reads, between the introducer's two bytes too.
    const bytes = enc.encode("\u009b99999999L");
    const out = [...clamp.clamp(bytes.subarray(0, 1)), ...clamp.clamp(bytes.subarray(1, 4)), ...clamp.clamp(bytes.subarray(4))];
    expect(dec.decode(Uint8Array.from(out))).toBe("\u009b9999L");
  });

  it("takes huge counts after the C1 introducer in bounded time", async () => {
    const from = performance.now();
    for (const seq of ["\u009b99999999M", "\u009b99999999L", "\u009b99999999@"]) await at("user@web-01:~$ " + seq);
    expect(performance.now() - from).toBeLessThan(5_000);
  });

  // A CSI past 256 bytes: the tab draws nothing of it until its final byte, so nor may the screen.
  it.each([
    ["\x1b[" + ";".repeat(300) + "1$ ", "ESC ["],
    ["\u009b" + ";".repeat(300) + "1$ ", "the C1 introducer"],
    ["\x1b[" + "1;".repeat(150) + "1$ ", "parameters, then intermediates that look like a prompt"],
  ])("reads no prompt from the tail of a CSI longer than 256 bytes (%#, %s)", async (out) => {
    expect(promptShell(await at(out))).toBeNull();
  });

  it.each([
    "\x1b[" + ";".repeat(300) + "1$ ",
    "\x1b[" + ";".repeat(300) + "user@web-01 ~> ",
    "user@web-01:~$ \x1b[" + "0".repeat(300) + "5D",
    "user@web-01:~$ \x1b[" + "1;".repeat(200) + "5D",
    "user@web-01:~$ \u009b" + "0".repeat(300) + "3D",
    "user@web-01:~$ \x1b[12\b345678D",
    "user@web-01:~$ \x1b[" + ";".repeat(300),
    "user@web-01:~$ \x1b[1\x1b[2Dx",
    "user@web-01:~$ \u009b1\u009b2Dx",
    "user@web-01:~$ \x1b[3\x18Dx",
    fish3("user", "web-01", "~") + "\x1b[" + ";".repeat(300) + " ",
  ])("draws %j as a plain xterm does", async (out) => {
    const at1 = await at(out);
    expect({ text: at1.text, rest: at1.rest.trimEnd() }).toEqual(await plain(out).then((p) => ({ text: p.text, rest: p.rest.trimEnd() })));
  });
});

describe("the Session's token in roster's marks (ticket 120)", () => {
  it("is in every mark of every hook line, and differs from Session to Session", () => {
    for (const kind of ["posix", "fish", "pwsh"] as const) {
      const line = hookLine(kind, NONCE);
      expect(line).not.toContain("@N@");
      expect(line).not.toMatch(/133;[ABC](?!;roster=0123456789abcdef01234567)/);
      expect(line).toContain(`roster=${NONCE}`);
    }
    expect(newNonce()).toMatch(/^[0-9a-f]{24}$/);
    expect(newNonce()).not.toBe(newNonce());
  });
});

describe("ShellHooks: when roster sends the hook line, and what the screen shows", () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const PROMPT = "Last login: today\r\nuser@web-01:~$ ";
  const A = "\x1b]133;A\x07";
  const B = "\x1b]133;B\x07";

  function setup({ enabled = true, session = true } = {}) {
    vi.useFakeTimers();
    const sent: string[] = [];
    const shown: string[] = [];
    const folders: string[] = [];
    let on = enabled;
    let open = session;
    const hooks = new ShellHooks({
      write: (line) => (open ? (sent.push(line), true) : false),
      show: (data) => shown.push(dec.decode(data)),
      cwd: (path) => folders.push(path),
      enabled: () => on,
    }, NONCE, new XtermPromptScreen({ cols: 80, rows: 24 }));
    const print = (s: string) => {
      const data = enc.encode(s);
      const now = hooks.output(data, s);
      if (now) shown.push(dec.decode(now));
    };
    return {
      hooks, sent, shown, folders, print,
      screen: () => shown.join(""),
      enable: (v: boolean) => (on = v),
      openSession: () => (open = true),
    };
  }

  afterEach(() => vi.useRealTimers());

  it("sends the line for the shell once the login is quiet at a prompt", () => {
    const { sent, print, screen } = setup();
    print(PROMPT);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(IDLE_MS);
    expect(sent).toEqual([hookLine("posix", NONCE) + "\r"]);
    expect(screen()).toBe(PROMPT);
  });

  it("sends fish's line at a prompt fish 3 drew, with its carriage return and move right (#296)", () => {
    const { sent, print } = setup();
    print(fish3("user", "web-01", "~/src/app", " ((f5c479ed))"));
    vi.advanceTimersByTime(IDLE_MS);
    expect(sent).toEqual([hookLine("fish", NONCE) + "\r"]);
  });

  it("sends nothing at sudo's prompt after a fish prompt", () => {
    const { sent, print } = setup();
    print(fish3("user", "web-01", "~") + "sudo -v\r\n[sudo] password for user: ");
    vi.advanceTimersByTime(IDLE_MS);
    expect(sent).toEqual([]);
  });

  it("sends nothing when it's off, or the user has typed, or the shell marks its prompts already", () => {
    const off = setup({ enabled: false });
    off.print(PROMPT);
    vi.advanceTimersByTime(IDLE_MS);
    expect(off.sent).toEqual([]);
    vi.useRealTimers();

    const typed = setup();
    typed.print("Last login: today\r\n");
    typed.hooks.typed("l");
    typed.print("user@web-01:~$ ");
    vi.advanceTimersByTime(IDLE_MS);
    expect(typed.sent).toEqual([]);
    vi.useRealTimers();

    const marked = setup();
    marked.print(`${A}user@web-01:~$ ${B}`);
    vi.advanceTimersByTime(IDLE_MS);
    expect(marked.sent).toEqual([]);
  });

  it("doesn't count the terminal's own answers (reports, focus, mouse, keyboard modes) as typing", () => {
    const { hooks, sent, print } = setup();
    for (const reply of [
      "\x1b[24;1R", "\x1b[I", "\x1b[O", "\x1b[?62;22c", "\x1b[>0;276;0c", "\x1b[?2004;2$y", "\x1bP1$r0m\x1b\\",
      "\x1b[?1u", "\x1b[<0;10;5M", "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\", "\x1bOA",
    ]) hooks.typed(reply);
    print(PROMPT);
    vi.advanceTimersByTime(IDLE_MS);
    expect(sent).toHaveLength(1);
  });

  it.each(["a", "\r", "\x03", "\t", "ls\x1b[D"])("counts %j as typing", (keys) => {
    const { hooks, sent, print } = setup();
    hooks.typed(keys);
    print(PROMPT);
    vi.advanceTimersByTime(IDLE_MS);
    expect(sent).toEqual([]);
  });

  it("waits through a login that isn't at a prompt it knows, and gives up after a while", () => {
    const { sent, print } = setup();
    print("Select an option [1-4]: ");
    vi.advanceTimersByTime(IDLE_MS * 3);
    expect(sent).toEqual([]);
    print("\r\nuser@web-01:~$ ");
    vi.advanceTimersByTime(IDLE_MS);
    expect(sent).toHaveLength(1);

    const late = setup();
    vi.advanceTimersByTime(WINDOW_MS);
    late.print(PROMPT);
    vi.advanceTimersByTime(IDLE_MS);
    expect(late.sent).toEqual([]);
  });

  it("waits for the Session to open before it writes", () => {
    const s = setup({ session: false });
    s.print(PROMPT);
    vi.advanceTimersByTime(IDLE_MS);
    expect(s.sent).toEqual([]);
    s.openSession();
    vi.advanceTimersByTime(IDLE_MS);
    expect(s.sent).toHaveLength(1);
  });

  it("keeps the echo off the screen and draws the new prompt where the old one was", () => {
    const { sent, print, screen } = setup();
    print(PROMPT);
    vi.advanceTimersByTime(IDLE_MS);
    const line = sent[0]!.slice(0, -1);
    // readline echoes the line (wrapped with a space and CR at the edge), then the new prompt.
    print(line.slice(0, 50) + " \r" + line.slice(50) + "\r\n");
    print("\x1b]133;D;0\x07\x1b]7;file://web-01/home/user\x07" + A + "user@web-01:~$ " + B);
    expect(screen()).toBe(PROMPT + "\r\x1b[J" + A + "user@web-01:~$ " + B);
  });

  it("keeps the terminal modes the shell set while the echo was held (bracketed paste)", () => {
    const { sent, print, screen } = setup();
    print(PROMPT);
    vi.advanceTimersByTime(IDLE_MS);
    print(sent[0]!.slice(0, -1) + "\r\n\x1b[?2004l\r\x1b]133;D;0\x07\x1b[?2004h" + A + "$ " + B);
    expect(screen()).toBe(PROMPT + "\x1b[?2004l\x1b[?2004h\r\x1b[J" + A + "$ " + B);
  });

  it("moves up over a prompt of several lines before drawing it again", () => {
    const { sent, print, screen } = setup();
    print("[web-01 ~]\r\n$ ");
    vi.advanceTimersByTime(IDLE_MS);
    print(sent[0]!.slice(0, -1) + "\r\n" + A + "[web-01 ~]\r\n$ " + B);
    expect(screen()).toBe("[web-01 ~]\r\n$ " + "\r\x1b[1A\x1b[J" + A + "[web-01 ~]\r\n$ " + B);
  });

  it("shows everything as it came when the shell said something else or the user typed, and clears a silent no-op", () => {
    const error = setup();
    error.print(PROMPT);
    vi.advanceTimersByTime(IDLE_MS);
    const echo = error.sent[0]!.slice(0, -1) + "\r\n";
    error.print(echo + "fish: Unknown command\r\n" + A + "$ " + B);
    expect(error.screen()).toBe(PROMPT + echo + "fish: Unknown command\r\n" + A + "$ " + B);
    vi.useRealTimers();

    const silent = setup();
    silent.print(PROMPT);
    vi.advanceTimersByTime(IDLE_MS);
    silent.print(echo + "user@web-01:~$ ");
    expect(silent.screen()).toBe(PROMPT);
    vi.advanceTimersByTime(HOLD_MS);
    // A shell that ran the line and printed no marks (dash): its echo is cleared, the prompt stays.
    expect(silent.screen()).toBe(PROMPT + "\r\x1b[Juser@web-01:~$ ");
    vi.useRealTimers();

    const typing = setup();
    typing.print(PROMPT);
    vi.advanceTimersByTime(IDLE_MS);
    typing.print(echo);
    typing.hooks.typed("l");
    expect(typing.screen()).toBe(PROMPT + echo);
    typing.print("l");
    expect(typing.screen()).toBe(PROMPT + echo + "l");
  });

  it("says the folder a shell reports with OSC 7, split across reads or not", () => {
    const { print, folders } = setup({ enabled: false });
    print("\x1b]7;file://web-01/home/user/my%20src\x07$ ");
    print("\x1b]7;file://web-01/e");
    print("tc\x1b\\$ ");
    print("\x1b]7;file://web-01/bad%zz\x07");
    expect(folders).toEqual(["/home/user/my src", "/etc", "/bad%zz"]);
  });

  it("sends the line when asked (:integrate), and says whether the marks came back, or why not", async () => {
    const now = setup({ enabled: false });
    now.print(PROMPT);
    vi.advanceTimersByTime(IDLE_MS);
    const on = now.hooks.integrate();
    expect(now.sent).toEqual([hookLine("posix", NONCE) + "\r"]);
    now.print(now.sent[0]!.slice(0, -1) + "\r\n" + A + "user@web-01:~$ " + B);
    expect(await on).toBe("on");
    expect(await now.hooks.integrate()).toBe("on");
    vi.useRealTimers();

    const never = setup({ enabled: false });
    never.print(PROMPT);
    vi.advanceTimersByTime(0);
    const off = never.hooks.integrate();
    never.print(never.sent[0]!.slice(0, -1) + "\r\nuser@web-01:~$ ");
    vi.advanceTimersByTime(HOLD_MS);
    expect(await off).toBe("no-marks");
    expect(await never.hooks.integrate()).toBe("no-marks");
    vi.useRealTimers();

    const busy = setup({ enabled: false });
    busy.print("user@web-01:~$ ls");
    vi.advanceTimersByTime(0);
    expect(await busy.hooks.integrate()).toBe("no-prompt");
    vi.useRealTimers();

    const marked = setup({ enabled: false });
    marked.print(`\x1b]133;A;roster=${NONCE}\x07$ \x1b]133;B;roster=${NONCE}\x07`);
    expect(await marked.hooks.integrate()).toBe("marked");
    vi.useRealTimers();

    // The shell's own integration marks it, not roster: :integrate still sends roster's line.
    const theirs = setup({ enabled: false });
    theirs.print(`${A}user@web-01:~$ ${B}`);
    vi.advanceTimersByTime(0);
    void theirs.hooks.integrate();
    expect(theirs.sent).toEqual([hookLine("posix", NONCE) + "\r"]);
    vi.useRealTimers();

    const closed = setup({ enabled: false, session: false });
    closed.print(PROMPT);
    vi.advanceTimersByTime(0);
    expect(await closed.hooks.integrate()).toBe("not-open");
  });

  it("clears the echo and the error of a shell that doesn't take the line (tcsh), leaving the prompt as it was", () => {
    const { sent, print, screen } = setup();
    print("[user@web-01 ~]$ ");
    vi.advanceTimersByTime(IDLE_MS);
    print(sent[0]!.slice(0, -1) + "\r\nBASH_VERSION: Undefined variable.\r\n[user@web-01 ~]$ ");
    expect(screen()).toBe("[user@web-01 ~]$ ");
    vi.advanceTimersByTime(HOLD_MS);
    expect(screen()).toBe("[user@web-01 ~]$ " + "\r\x1b[J[user@web-01 ~]$ ");
  });

  it("shows what a shell that didn't take the line printed when it isn't just an error and the same prompt", () => {
    const { sent, print, screen } = setup();
    print(PROMPT);
    vi.advanceTimersByTime(IDLE_MS);
    const rest = sent[0]!.slice(0, -1) + "\r\nsomething\r\nelse > ";
    print(rest);
    vi.advanceTimersByTime(HOLD_MS);
    expect(screen()).toBe(PROMPT + rest);
  });

  it("takes zsh's end-of-line mark (PROMPT_SP) before the new prompt as part of the echo", () => {
    const { sent, print, screen } = setup();
    print("web-01% ");
    vi.advanceTimersByTime(IDLE_MS);
    const sp = "\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m" + " ".repeat(79) + "\r \r";
    print(sent[0]!.slice(0, -1) + "\r\n\x1b]133;D;0\x07" + sp + A + "web-01% " + B);
    expect(screen()).toBe("web-01% " + "\r\x1b[J" + A + "web-01% " + B);
  });

  it("notices marks a shell already writes even when one comes split across two reads", () => {
    const { sent, print } = setup();
    print("\x1b]13");
    print("3;A\x07user@web-01:~$ ");
    vi.advanceTimersByTime(IDLE_MS);
    expect(sent).toEqual([]);
  });

  it("puts the bytes back as they came, so a character split across reads stays whole", () => {
    vi.useFakeTimers();
    const shown: number[] = [];
    const sent: string[] = [];
    const hooks = new ShellHooks({ write: (l) => (sent.push(l), true), show: (d) => shown.push(...d), cwd: () => {}, enabled: () => true }, NONCE, new XtermPromptScreen({ cols: 80, rows: 24 }));
    const decoder = new TextDecoder();
    const feed = (bytes: Uint8Array) => {
      const now = hooks.output(bytes, decoder.decode(bytes, { stream: true }));
      if (now) shown.push(...now);
    };
    feed(enc.encode("user@web-01:~$ "));
    vi.advanceTimersByTime(IDLE_MS);
    const all = enc.encode(sent[0]!.slice(0, -1) + "\r\n" + A + "user@web-01:~$ " + B + "café");
    feed(all.subarray(0, all.length - 1));
    feed(all.subarray(all.length - 1));
    expect(dec.decode(new Uint8Array(shown))).toBe("user@web-01:~$ \r\x1b[J" + A + "user@web-01:~$ " + B + "café");
  });
});

describe("shellHooksOn: init.lua's terminal.shell_hooks and the Host's shell_hooks", () => {
  it.each([
    [null, undefined, false, "both unset: off"],
    [null, true, true, "the Host turns it on"],
    [null, false, false, "the Host keeps it off"],
    [true, undefined, true, "init.lua turns it on for every Session"],
    [true, false, false, "a Host's false wins over init.lua's true"],
    [false, true, false, "init.lua's false turns it off everywhere"],
  ] as [boolean | null, boolean | undefined, boolean, string][])("init.lua %s, Host %s: %s (%s)", (init, host, on) => {
    expect(shellHooksOn(init, host)).toBe(on);
  });
});

describe("TokenMask: Plugins never see the Session's token (ticket 120)", () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const through = (chunks: string[]) => {
    const mask = new TokenMask(NONCE);
    return chunks.map((c) => dec.decode(mask.mask(enc.encode(c)))).join("") + dec.decode(mask.flush());
  };
  const hidden = (out: string) => out.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\r|\n/g, "");

  it("hides it however the reads split it", () => {
    const text = `$ echo $PS1\r\n\\[\\e]133;A;roster=${NONCE}\\a\\]\\u$ \r\n$ `;
    for (let cut = 0; cut <= text.length; cut += 3) {
      const out = through([text.slice(0, cut), text.slice(cut)]);
      expect(hidden(out)).not.toContain(NONCE.slice(0, 8));
      expect(out.length).toBe(text.length);
    }
  });

  it("hides it when ConPTY wraps it at 80 columns, with a line break or cursor moves inside", () => {
    for (const brk of ["\r\n", "\x1b[K\r\n", "\x1b[?25l\x1b[2;1H", "\x1b[1C"]) {
      const at = 80 - "history | tail -1: roster=".length;
      const text = `history | tail -1: roster=${NONCE.slice(0, at % 24)}${brk}${NONCE.slice(at % 24)} done\r\n`;
      const out = through([text]);
      expect(hidden(out)).not.toMatch(/[0-9a-f]{6,}/);
      expect(out).toContain(" done");
    }
  });

  it("never lets a held part of it out unmasked, even when the Session ends there", () => {
    const out = through([`token roster=${NONCE.slice(0, 5)}`]);
    expect(out).not.toContain(NONCE.slice(0, 5));
  });

  // Ticket 137 (#243 f, decision Q136): output that stopped part-way into the token for the 50 ms
  // hold went out with up to 5 of its characters as they were, and the rest of the token, in the
  // next read, wasn't recognised at all. Every split point, with the hold timing out (flush) after
  // every read, and byte by byte.
  //
  // The residual, stated: after `roster=` (every place roster's hook line puts the token, so every
  // way a shell prints it), no character ever goes out. Anywhere else, a held start of the token
  // shorter than 4 characters goes out as it was when the hold times out (it looks like ordinary
  // output then: an echoed key, a counter, a hex id), so at most its first 3 hex characters, 12 of
  // its 96 bits, and only when the output pauses for 50 ms right after them; the rest is dashed.
  // That pause is the only case: a hold that passes its 4 KB bound dashes every start it holds.
  describe("every way a read can split it, the hold timing out between reads", () => {
    const run = (nonce: string, chunks: Uint8Array[], timeOut: boolean) => {
      const mask = new TokenMask(nonce);
      const out: number[] = [];
      for (const c of chunks) {
        out.push(...mask.mask(c));
        if (timeOut && mask.holding()) out.push(...mask.flush());
      }
      out.push(...mask.flush());
      return Uint8Array.from(out);
    };
    /** The token's bytes at `at` in `out`, with at most `clear` of its first ones as they were. */
    const expectMasked = (text: Uint8Array, at: number, out: Uint8Array, clear: number, why: string) => {
      expect(out.length, why).toBe(text.length);
      for (let k = at; k < at + 24; k++) {
        const ch = String.fromCharCode(out[k] ?? 0);
        if (k < at + clear && ch === String.fromCharCode(text[k] ?? 0)) continue;
        expect(ch, `${why}: byte ${k}`).toBe("-");
      }
    };
    const RESIDUAL = 3;
    /** [name, before, after, how many of its first characters may go out as they were]. */
    const cases = (nonce: string): [string, string, string, number][] => [
      ["roster mark", "\x1b]133;A;roster=", "\x07user$ ", 0],
      ["printed by echo $PS1", "$ echo $PS1\r\n\\[\\e]133;A;roster=", "\\a\\]\\u$ \r\n$ ", 0],
      ["wrapped right after roster=", "history | tail -1: roster=\x1b[K\r\n", " done\r\n", 0],
      ["wrapped inside roster=", "declare -- PS1=ros\r\nter=", "\r\n", 0],
      ["without roster= before it", "  12  printf x ", " done\r\n$ ", RESIDUAL],
      ["after a near miss of its own start", `x ${nonce.slice(0, 3)}Z ${nonce.slice(0, 2)}`, "\r\n", RESIDUAL],
    ];
    const NONCES = [NONCE, "aaaaaaaaaaaaaaaaaaaaaaab", "abababababababababababac", newNonce(), newNonce()];

    it.each(NONCES)("with one cut anywhere and two cuts across the token (%s)", (nonce) => {
      for (const [name, before, after, clear] of cases(nonce)) {
        const text = enc.encode(before + nonce + after);
        const at = before.length;
        for (let i = 0; i <= text.length; i++) {
          for (const timeOut of [true, false]) {
            const out = run(nonce, [text.slice(0, i), text.slice(i)], timeOut);
            expectMasked(text, at, out, timeOut ? clear : 0, `${name}, cut at ${i}, timeOut ${timeOut}`);
          }
        }
        for (let i = at; i <= at + nonce.length; i++) {
          for (let j = i; j <= at + nonce.length; j++) {
            const out = run(nonce, [text.slice(0, i), text.slice(i, j), text.slice(j)], true);
            expectMasked(text, at, out, clear, `${name}, cuts at ${i} and ${j}`);
          }
        }
      }
    });

    it.each(NONCES)("byte by byte (%s)", (nonce) => {
      for (const [name, before, after, clear] of cases(nonce)) {
        const text = enc.encode(before + nonce + after);
        const bytes = Array.from(text, (b) => Uint8Array.of(b));
        for (const timeOut of [true, false]) {
          expectMasked(text, before.length, run(nonce, bytes, timeOut), timeOut ? clear : 0, `${name}, timeOut ${timeOut}`);
        }
      }
    });

    // Escape sequences a terminal or multiplexer draws inside a wrapped token (#5, #6 of the review).
    it.each([
      ["a line break and erase", "\x1b[K\r\n"],
      ["ConPTY's cursor moves", "\x1b[?25l\x1b[2;1H"],
      ["tmux's sgr0 (a charset designator)", "\x1b(B\x1b[m"],
      ["an OSC 8 link", "\x1b]8;;https://example.com/a\x1b\\"],
      ["a long title", `\x1b]0;${"t".repeat(3000)}\x07`],
      ["a long SGR", `\x1b[${"1;".repeat(60)}0m`],
      ["a DCS string", "\x1bP+q544e\x1b\\"],
      ["an APC string", "\x1b_Gf=24;AAAA\x1b\\"],
      ["a two-byte escape and a line feed", "\x1b7\n\x1b8"],
    ])("through %s inside it, however it's split", (_, brk) => {
      const before = "history: roster=";
      const text = enc.encode(`${before}${NONCE.slice(0, 9)}${brk}${NONCE.slice(9)} done\r\n`);
      for (const timeOut of [true, false]) {
        const bytes = Array.from(text, (b) => Uint8Array.of(b));
        expect(dec.decode(run(NONCE, bytes, timeOut)).replace(brk, "")).toContain(`${before}${"-".repeat(24)} done`);
        for (let i = 0; i <= text.length; i += 7) {
          const out = dec.decode(run(NONCE, [text.slice(0, i), text.slice(i)], timeOut));
          expect(out.length).toBe(text.length);
          expect(out).toContain(" done");
          expect(out.replace(brk, "")).toContain(`${before}${"-".repeat(24)} done`);
        }
      }
    });

    it("leaves ordinary output as it came, a pause after every read", () => {
      for (const ordinary of [
        "echo 012 hello\r\n", // typed keys echoed one at a time, a few of them the token's start
        "commit 0129ab5f0 (HEAD)\r\n",
        "1000 1001 1002 1009 1010\r\n",
        "\x1b[32m0\x1b[m12\r\nok 0\x1b[1C1\r\n",
        "100%\r 0%\r 01%\r 012%\r",
      ]) {
        const text = enc.encode(ordinary);
        const bytes = Array.from(text, (b) => Uint8Array.of(b));
        expect(dec.decode(run(NONCE, bytes, true))).toBe(ordinary);
        for (let i = 0; i <= text.length; i++) {
          expect(dec.decode(run(NONCE, [text.slice(0, i), text.slice(i)], true))).toBe(ordinary);
        }
      }
    });

    it("holds nothing back from output that can't be the token", () => {
      const mask = new TokenMask(NONCE);
      const data = enc.encode("ls\r\nfile-9 a\r\n$ ");
      expect(mask.mask(data)).toBe(data);
      expect(mask.holding()).toBe(false);
    });

    it("holds once at most through a stream of cursor moves after what may be its start, in bounded memory", () => {
      const mask = new TokenMask(NONCE);
      let sent = mask.mask(enc.encode("roster=0123")).length;
      expect(mask.holding()).toBe(true);
      sent += mask.flush().length;
      const move = enc.encode("\x1b[1C\x1b[?25l\r");
      for (let n = 0; n < 2000; n++) {
        const out = mask.mask(move);
        expect(out.length).toBe(move.length);
        expect(mask.holding()).toBe(false);
        sent += out.length;
      }
      expect(sent).toBe(11 + 2000 * move.length);
    });

    // Re-review of #266: hitting the 4 KB bound fails toward masking, for a short start too, and
    // the start is still followed, so none of the token goes out however long the string inside it.
    it.each([
      ["an OSC", "\x1b]0;", "\x07"],
      ["a DCS", "\x1bP", "\x1b\\"],
      ["an APC", "\x1b_", "\x1b\\"],
    ])("dashes a short start when %s string inside it passes the bound", (_, open, close) => {
      for (const n of [1, 2, 3]) {
        const text = `x ${NONCE.slice(0, n)}${open}${"t".repeat(5000)}${close}${NONCE.slice(n)} done`;
        for (const step of [text.length, 700, 1]) {
          const mask = new TokenMask(NONCE);
          let out = "";
          for (let i = 0; i < text.length; i += step) out += dec.decode(mask.mask(enc.encode(text.slice(i, i + step))));
          out += dec.decode(mask.flush());
          expect(out.length).toBe(text.length);
          expect(out.startsWith(`x ${"-".repeat(n)}`), `${n} chars, step ${step}`).toBe(true);
          expect(out.endsWith(`${"-".repeat(24 - n)} done`), `${n} chars, step ${step}`).toBe(true);
        }
      }
    });

    it("bounds a hold that never resolves: a sequence that never ends goes out, the token's part dashed", () => {
      const mask = new TokenMask(NONCE);
      const head = dec.decode(mask.mask(enc.encode(`roster=${NONCE.slice(0, 4)}\x1b]0;`)));
      expect(mask.holding()).toBe(true);
      let rest = "";
      for (let n = 0; n < 10; n++) rest += dec.decode(mask.mask(enc.encode("t".repeat(1000))));
      expect(mask.holding()).toBe(false);
      expect(head + rest).toBe(`roster=----\x1b]0;${"t".repeat(10000)}`);
    });
  });

  it("passes everything else as it came, without copying it", () => {
    const mask = new TokenMask(NONCE);
    const data = enc.encode("ls\r\nfile-0123 a\r\n$ ");
    expect(mask.mask(data)).toBe(data);
  });
});
