// Ticket 79 (#137): what `terminal_output` sends is the lines a Session's terminal commits, read from
// a terminal's buffer (xterm, with no screen), not the raw stream: a repaint of the same screen
// after a resize isn't output, a rewritten line (a progress bar) arrives as it ended up, and a
// full-screen program's drawing isn't sent at all.
import { afterEach, describe, expect, it } from "vitest";
import { CommittedLines, OUTPUT_MAX } from "./committed";

const screens: CommittedLines[] = [];
function screen(cols = 40, rows = 6) {
  const s = new CommittedLines({ cols, rows });
  screens.push(s);
  return s;
}
afterEach(() => screens.splice(0).forEach((s) => s.dispose()));

describe("the lines a Session commits", () => {
  it("sends each line once the Session moves past it, as plain text", async () => {
    const s = screen();
    await s.write("\x1b]0;title\x07\x1b[1;31mERROR\x1b[0m disk full\r\nesx-02$ ");
    expect(s.take()).toBe("ERROR disk full\n");
    // The prompt waits until it's finished.
    await s.write("ls\r\n");
    expect(s.take()).toBe("esx-02$ ls\n");
    expect(s.take()).toBe("");
  });

  it("keeps going past the bottom of the screen", async () => {
    const s = screen(40, 3);
    await s.write("one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n");
    expect(s.take()).toBe("one\ntwo\nthree\nfour\nfive\n");
    await s.write("five\r\n");
    expect(s.take()).toBe("five\n");
  });

  it("a rewritten line arrives as it ended up, and a wrapped one whole", async () => {
    const s = screen(20, 6);
    await s.write("copying 10%\rcopying 100%\r\n");
    await s.write("ERROR: a line longer than twenty\r\n");
    expect(s.take()).toBe("copying 100%\nERROR: a line longer than twenty\n");
  });

  it("the same screen printed again after a resize (ConPTY) isn't output; what's new is", async () => {
    const s = screen(40, 6);
    await s.write("mounting\r\nERROR: disk full\r\nesx-02$ ");
    expect(s.take()).toBe("mounting\nERROR: disk full\n");
    s.resize({ cols: 30, rows: 6 });
    // ConPTY's repaint: home, each row cleared to its end, the cursor back where it was.
    await s.write("\x1b[?25l\x1b[Hmounting\x1b[K\r\nERROR: disk full   \x1b[K\r\nesx-02$ \x1b[K\x1b[3;9H\x1b[?25h");
    expect(s.take()).toBe("");
    await s.write("\r\nERROR: new one\r\nERROR: disk full\r\n");
    expect(s.take()).toBe("esx-02$\nERROR: new one\nERROR: disk full\n");
  });

  it("after clear, the same lines are new again", async () => {
    const s = screen(40, 6);
    await s.write("ERROR: disk full\r\n");
    s.take();
    await s.write("\x1b[H\x1b[2J\x1b[3Jesx-02$ clear\r\nERROR: disk full\r\n");
    expect(s.take()).toBe("esx-02$ clear\nERROR: disk full\n");
  });

  it("what a full-screen program draws isn't sent", async () => {
    const s = screen(40, 6);
    await s.write("\x1b[?1049h\x1b[Htop - 10:00\r\nERROR in a process name\r\n\x1b[?1049l");
    await s.write("esx-02$ done\r\n");
    expect(s.take()).toBe("esx-02$ done\n");
  });

  it("takes text split in the middle of a character", async () => {
    const s = screen();
    const bytes = new TextEncoder().encode("é ERROR\r\n");
    await s.write(bytes.slice(0, 1));
    await s.write(bytes.slice(1));
    expect(s.take()).toBe("é ERROR\n");
  });
});

// Ticket 94 (#167), decision Q121: a shell that writes OSC 133 marks (A prompt, B command line,
// C output, D done) says what its lines are. Every line is still sent; the marks only annotate
// each run with its `kind`, and each command that ends is a command_done.
const A = "\x1b]133;A\x07";
const B = "\x1b]133;B\x07";
const C = "\x1b]133;C\x07";
const D = (code?: number) => `\x1b]133;D${code === undefined ? "" : `;${code}`}\x07`;

describe("a shell that marks its prompts (OSC 133)", () => {
  it("sends every line, each run with what the marks say it is, and says when a command ends", async () => {
    const s = screen();
    await s.write(`${A}~/logs (main)\r\nesx-02$ ${B}`);
    await s.write("grep ERROR /var/log/syslog");
    await s.write(`\r\n${C}ERROR disk full\r\nERROR again\r\n${D(1)}${A}esx-02$ ${B}`);
    expect(s.takeRuns()).toEqual([
      { text: "~/logs (main)\n", kind: "prompt" },
      { text: "esx-02$ grep ERROR /var/log/syslog\n", kind: "input" },
      { text: "ERROR disk full\nERROR again\n", kind: "output" },
    ]);
    expect(s.takeDone()).toEqual([{ command: "grep ERROR /var/log/syslog", output: "ERROR disk full\nERROR again\n", code: 1 }]);
    expect(s.takeDone()).toEqual([]);
  });

  it("a shell with no marks is read as before, with no kind", async () => {
    const s = screen();
    await s.write("esx-02$ ls\r\nfile\r\n");
    expect(s.takeRuns()).toEqual([{ text: "esx-02$ ls\nfile\n", kind: null }]);
    expect(s.takeDone()).toEqual([]);
  });

  // Review 2 of #215: marks never hold back or drop a line, whatever a Host forges.
  it("a prompt given up (Ctrl-C) is still sent, as input, and isn't a command", async () => {
    const s = screen();
    await s.write(`${A}$ ${B}mysql -p^C\r\n${A}$ ${B}`);
    expect(s.takeRuns()).toEqual([{ text: "$ mysql -p^C\n", kind: "input" }]);
    expect(s.takeDone()).toEqual([]);
  });

  it("a shell that marks prompts but never says C loses nothing: only the line typed at each prompt is input", async () => {
    const s = screen(40, 6);
    await s.write(`${A}$ ${B}ls\r\nfile1\r\nfile2\r\n${A}$ ${B}`);
    expect(s.takeRuns()).toEqual([
      { text: "$ ls\n", kind: "input" },
      { text: "file1\nfile2\n", kind: null },
    ]);
  });

  it("A sent over and over marks only a few lines as prompt; the rest have no kind", async () => {
    const s = screen(40, 6);
    await s.write(`${A}${Array.from({ length: 6 }, (_, i) => `row ${i}\r\n`).join("")}`);
    const runs = s.takeRuns();
    expect(runs.map((r) => r.text).join("")).toBe(Array.from({ length: 6 }, (_, i) => `row ${i}\n`).join(""));
    expect(runs.at(-1)?.kind).toBeNull();
  });

  it("output with no line feed at the end is output, and a long command line comes whole", async () => {
    const s = screen(20, 6);
    await s.write(`${A}$ ${B}printf 'disk full' # a long comment\r\n${C}disk full${D()}${A}$ ${B}`);
    expect(s.takeRuns()).toEqual([
      { text: "$ printf 'disk full' # a long comment\n", kind: "input" },
      { text: "disk full\n", kind: "output" },
    ]);
    expect(s.takeDone()).toEqual([{ command: "printf 'disk full' # a long comment", output: "disk full\n", code: null }]);
  });

  // Review 2, finding 1: what was sent at D isn't sent again when its row is committed.
  it("output sent at D isn't sent again with the prompt drawn after it, nor by a prompt starting with a line feed", async () => {
    const s = screen();
    await s.write(`${A}$ ${B}printf ERROR\r\n${C}ERROR${D(0)}${A}$ ${B}ls\r\n${C}${D(0)}`);
    await s.write(`${A}$ ${B}printf ERROR\r\n${C}ERROR${D(0)}${A}\r\n$ ${B}`);
    expect(s.take()).toBe("$ printf ERROR\nERROR\n$ ls\n$ printf ERROR\nERROR\n");
  });

  it("zsh's PROMPT_SP after output with no line feed isn't output", async () => {
    const s = screen(40, 6);
    await s.write(`${A}% ${B}printf done\r\n${C}done${D(0)}\x1b[7m%\x1b[27m${" ".repeat(39)}\r${A}% ${B}ls\r\n${C}f\r\n${D(0)}`);
    expect(s.takeDone()).toEqual([
      { command: "printf done", output: "done\n", code: 0 },
      { command: "ls", output: "f\n", code: 0 },
    ]);
    const runs = s.takeRuns();
    expect(runs.filter((r) => r.kind === "output").map((r) => r.text)).toEqual(["done\n", "f\n"]);
  });

  // Review 2, finding 9: a C mid-row (pwsh's, before the line feed) never keeps that row unsent.
  it("a C written before the line feed (pwsh's): the row is still sent, as input, and isn't output", async () => {
    const s = screen();
    await s.write(`${A}PS C:\\logs> ${B}Get-Content app.log${C}\r\nERROR boot\r\n${D(0)}`);
    expect(s.takeRuns()).toEqual([
      { text: "PS C:\\logs> Get-Content app.log\n", kind: "input" },
      { text: "ERROR boot\n", kind: "output" },
    ]);
    expect(s.takeDone()).toEqual([{ command: "Get-Content app.log", output: "ERROR boot\n", code: 0 }]);
  });

  it("a C mid-row with no prompt marked before it still sends the row", async () => {
    const s = screen();
    await s.write(`$ ls${C}\r\nfile\r\n${D(0)}`);
    expect(s.take()).toBe("$ ls\nfile\n");
    expect(s.takeDone()).toEqual([{ command: null, output: "file\n", code: 0 }]);
  });

  it("a mark it doesn't know, or a D with no C (an empty line), isn't a command", async () => {
    const s = screen();
    await s.write(`${A}$ ${B}\r\n\x1b]133;P;k=i\x07${D(0)}${A}$ ${B}`);
    expect(s.takeDone()).toEqual([]);
  });

  it("marks sent twice (a shell's own and a snippet's) count once", async () => {
    const s = screen();
    await s.write(`${A}${A}$ ${B}${B}ls\r\n${C}${C}file\r\n${D(0)}${D(0)}`);
    expect(s.takeDone()).toEqual([{ command: "ls", output: "file\n", code: 0 }]);
  });

  it("a nested marked shell's prompt drops the outer command's command_done; its own commands come", async () => {
    const s = screen();
    await s.write(`${A}$ ${B}ssh esx-02\r\n${C}Welcome\r\n`);
    await s.write(`${A}esx-02$ ${B}ls\r\n${C}file\r\n${D(0)}`);
    expect(s.takeDone()).toEqual([{ command: "ls", output: "file\n", code: 0 }]);
  });

  // Review 2, finding 4: a shell that exits sends no D for `exit`: the D after it is another's.
  it("exit or logout gets no command_done: the D after it is the outer shell's", async () => {
    const s = screen();
    await s.write(`${A}$ ${B}ssh esx-02\r\n${C}${A}esx-02$ ${B}exit\r\n${C}logout\r\n${D(255)}`);
    await s.write(`${A}$ ${B}logout\r\n${C}${D(0)}`);
    expect(s.takeDone()).toEqual([]);
  });

  it("keeps each command's last 16 KB of output", async () => {
    const s = screen(80, 6);
    const line = "x".repeat(99);
    await s.write(`${A}$ ${B}yes\r\n${C}${`${line}\r\n`.repeat(400)}tail\r\n${D(130)}`);
    const [done] = s.takeDone();
    expect(done?.output.endsWith(`${line}\ntail\n`)).toBe(true);
    expect(done?.output.length).toBeLessThanOrEqual(OUTPUT_MAX);
    expect(done?.output.length).toBeGreaterThan(OUTPUT_MAX - 200);
    expect(done?.code).toBe(130);
  });

  it("reads what bash 5 with the snippet in docs/plugins.md prints (recorded)", async () => {
    // Typed: `echo ERROR disk full`, a line given up with Ctrl-C, an empty line, `false`,
    // `printf done`, `exit`.
    const s = screen(80, 24);
    await s.write("\x1b]133;D;0\x07\x1b[?2004h\x1b]133;A\x07esx-02$ \x1b]133;B\x07echo ERROR disk full\r\n\x1b[?2004l\r\x1b]133;C\x07ERROR disk full\r\n\x1b]133;D;0\x07\x1b[?2004h\x1b]133;A\x07esx-02$ \x1b]133;B\x07\x1b[K^C\x1b[?2004l\r\x1b[?2004h\x1b[?2004l\r\r\n\x1b]133;D;130\x07\x1b[?2004h\x1b]133;A\x07esx-02$ \x1b]133;B\x07\r\n\x1b[?2004l\r\x1b]133;D;130\x07\x1b[?2004h\x1b]133;A\x07esx-02$ \x1b]133;B\x07false\r\n\x1b[?2004l\r\x1b]133;C\x07\x1b]133;D;1\x07\x1b[?2004h\x1b]133;A\x07esx-02$ \x1b]133;B\x07printf done\r\n\x1b[?2004l\r\x1b]133;C\x07done\x1b]133;D;0\x07\x1b[?2004h\x1b]133;A\x07esx-02$ \x1b]133;B\x07exit\r\n\x1b[?2004l\r\x1b]133;C\x07exit\r\n");
    expect(s.takeRuns()).toEqual([
      { text: "esx-02$ echo ERROR disk full\n", kind: "input" },
      { text: "ERROR disk full\n", kind: "output" },
      { text: "esx-02$ ^C\nesx-02$\nesx-02$ false\nesx-02$ printf done\n", kind: "input" },
      { text: "done\n", kind: "output" },
      { text: "esx-02$ exit\n", kind: "input" },
      { text: "exit\n", kind: "output" },
    ]);
    expect(s.takeDone()).toEqual([
      { command: "echo ERROR disk full", output: "ERROR disk full\n", code: 0 },
      { command: "false", output: "", code: 1 },
      { command: "printf done", output: "done\n", code: 0 },
    ]);
  });
});
