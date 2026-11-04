// @vitest-environment node
/// <reference types="node" />
// The hook lines, and the rc-file snippets in docs/plugins.md ("Shell integration"), in real
// shells: whichever of bash, zsh, fish and pwsh this machine has (CI's Ubuntu installs zsh and fish
// and has bash and pwsh; a shell that isn't installed is skipped). Each runs interactive, reads the
// line and a few commands, and must print the marks.
//
// bash and zsh read their input piped in. fish 3 is interactive only on a terminal, whatever -i
// says, and pwsh's PSReadLine needs one, so those two run under a pty (util-linux `script`), and
// the test answers the few things they ask the terminal (the device attributes fish 4 waits for at
// each prompt, the cursor position PSReadLine waits for), as a terminal would.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { XtermPromptScreen } from "./promptScreen";
import { hookLine, promptShell, type CursorLine, type ShellKind } from "./shellHooks";

const has = (shell: string) => spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0;
const ENV = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/tmp", TERM: "xterm-256color", SHELL: "/bin/sh" };

/** Runs `argv` with `lines` piped in, one command a line; what it printed. */
function run(argv: string[], lines: string[], cwd?: string): string {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    input: lines.join("\n") + "\n",
    encoding: "utf8",
    timeout: 10_000,
    env: ENV,
  });
  return r.stdout + r.stderr;
}

/** A pty to run a shell on: util-linux `script` (its `-e` and `-f`), Linux only. */
const hasPty = process.platform === "linux" && has("script");
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
/** The terminal's questions a shell may wait for: device attributes, and the cursor position. */
// eslint-disable-next-line no-control-regex -- the questions are escape sequences
const ASK = /\x1b\[0?c|\x1b\[6n/g;

/** What a shell on a pty printed, as text: no escape sequences, no line breaks (a long line wraps). */
// eslint-disable-next-line no-control-regex -- the sequences are made of control characters
const shown = (out: string) => out.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[^[\]]|[\r\n]/g, "");

/** Runs `argv` on a pty and types `lines`, answering the terminal questions it asks; what it
 * printed, once it exits (or after 40 s). Each line goes in only once `ready` says, of what the
 * shell printed since the last Enter, that its line editor is waiting for keys: the shell takes
 * keys typed sooner badly (typed before pwsh's first prompt, the tty turns their Enter into a line
 * feed PSReadLine doesn't take, and the lines merge, `falsecd`; an Enter that comes while .NET's
 * console waits for a cursor-position answer is lost). Then Enter, on its own, once the shell has
 * drawn the line. Each step waits for a sign, never for the shell to go quiet: on a busy machine
 * a shell still starting is quiet too. */
/** The cursor's line once a terminal of the pty's size (120 by 40) has drawn `out`. */
async function screenLine(out: string): Promise<CursorLine> {
  const screen = new XtermPromptScreen({ cols: 120, rows: 40 });
  screen.write(out);
  await screen.flushed();
  const at = screen.line();
  screen.dispose();
  return at;
}

/** Has the shell drawn `line`, typed in at `mark` in what it printed (`out`)? Either the bytes
 * since hold it, or a screen of the pty's size shows it from the row it went in at (rows joined,
 * as a long line wraps; runs of spaces as one). fish draws a long line in pieces and moves the
 * cursor over cells it has drawn already, so its bytes needn't hold the line in one piece (#400);
 * pwsh draws where it's told the cursor is, and the test tells it the top row, so its line can be
 * above that row on the screen. */
async function drawnLine(out: string, mark: number, line: string): Promise<boolean> {
  if (shown(out.slice(mark)).includes(line.trim())) return true;
  const term = new Terminal({ cols: 120, rows: 40, scrollback: 1000, allowProposedApi: false });
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  await write(out.slice(0, mark));
  const b = term.buffer.active;
  const from = b.baseY + b.cursorY;
  await write(out.slice(mark));
  let text = "";
  for (let r = from; r < b.length; r++) text += b.getLine(r)?.translateToString(false) ?? "";
  term.dispose();
  return text.replace(/ +/g, " ").includes(line.trim().replace(/ +/g, " "));
}

/** What the shell printed since the last Enter, and the cursor's line on a screen it's drawn on. */
type Ready = (since: string, at: CursorLine) => boolean;

function runPty(argv: string[], lines: string[], ready: Ready, cwd?: string): Promise<string> {
  return new Promise((resolve) => {
    // A pty `script` makes from a pipe is 0 by 0, which PSReadLine divides by: give it a size.
    const command = `stty cols 120 rows 40 2>/dev/null; exec ${argv.map(quote).join(" ")}`;
    const child = spawn("script", ["-qfec", command, "/dev/null"], { env: ENV, cwd });
    let out = "";
    let answered = 0;
    // Where the last thing typed went in: what the shell printed after it is its answer.
    let mark = 0;
    let line: string | undefined;
    let checking = false;
    const next = () => {
      if (checking) return;
      if (line !== undefined) {
        // Has it drawn the line: on a screen, as a terminal would show it.
        checking = true;
        const typed = line;
        const seen = out.length;
        void drawnLine(out, mark, typed).then((drawn) => {
          checking = false;
          if (!drawn) return out.length !== seen ? next() : undefined; // more came meanwhile: look again
          line = undefined;
          child.stdin.write("\r");
          mark = out.length;
        });
        return;
      }
      if (!lines.length) return;
      // Is it ready: what it printed since the last Enter, drawn on a screen of its own.
      checking = true;
      const since = out.slice(mark);
      void screenLine(since).then((at) => {
        checking = false;
        if (out.length !== mark + since.length) return next(); // more came meanwhile: look again
        if (line !== undefined || !ready(since, at)) return;
        line = lines.shift()!;
        child.stdin.write(line);
        mark = out.length;
      });
    };
    const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      out += d;
      const asks = out.match(ASK) ?? [];
      for (; answered < asks.length; answered++) child.stdin.write(asks[answered] === "\x1b[6n" ? "\x1b[1;1R" : "\x1b[?62;22c");
      next();
    });
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.stdin.on("error", () => {});
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** PSReadLine waits for keys once it has drawn the prompt and then asked where the cursor is,
 * or at `>> `, the next line of an unfinished command (no question there). */
const pwshReady: Ready = (since, at) =>
  at.text === ">> " || (promptShell(at) === "pwsh" && since.slice(since.lastIndexOf("PS ")).includes("\x1b[6n"));
/** fish once it has drawn its prompt (`… ~> `, `… [1]> `; it then puts the cursor back with a
 * carriage return and a move right, so this looks at the text, not the last line), or, in an
 * unfinished command, once it has drawn the next line (a line feed, then it clears that line).
 * When it runs a command it prints a line feed too, then sets the window title (OSC 0): that line
 * feed isn't a sign, the next prompt is. */
const fishReady: Ready = (since) =>
  shown(since).endsWith("> ") || (!since.includes("\x1b]0;") && since.includes("\n\x1b[K"));

/** The end of what a shell printed, escaped, for a failed test's message. */
const tail = (out: string) => JSON.stringify(out.slice(-3000));

const ESC = "\x1b";
const BEL = "\x07";
/** This Session's token: every mark roster's hook line makes carries it (ticket 120, Q131). */
const N = "0123456789abcdef01234567";
const own = (mark: string) => `${ESC}]133;${mark};roster=${N}${BEL}`;

interface Shell {
  name: string;
  argv: string[];
  kind: ShellKind;
  /** On a pty (or else piped in): when it waits for the next line typed. */
  pty?: Ready;
}
const SHELLS: Shell[] = [
  { name: "bash", argv: ["bash", "--norc", "--noprofile", "-i"], kind: "posix" },
  { name: "zsh", argv: ["zsh", "-f", "-i"], kind: "posix" },
  { name: "fish", argv: ["fish", "--no-config", "-i"], kind: "fish", pty: fishReady },
  { name: "pwsh", argv: ["pwsh", "-NoProfile", "-NoLogo"], kind: "pwsh", pty: pwshReady },
];
/** A folder of its own, in no git checkout, for the shells to start in: fish's prompt shows the
 * folder and the checkout's branch, so a test run in this checkout would see a prompt as long as
 * the branch name, and the line typed in after it would wrap at another column (#400). */
const AWAY = mkdtempSync(join(tmpdir(), "roster-shells-"));
const runIn = (s: Shell, lines: string[], cwd = AWAY) =>
  s.pty ? runPty(s.argv, lines, s.pty, cwd) : Promise.resolve(run(s.argv, lines, cwd));
const missing = (s: Shell) => !has(s.name) || (!!s.pty && !hasPty);

// #400: fish draws a long line in pieces, and where a row ends on a cell it has drawn already (a
// space) it moves the cursor over it rather than print it again: the line is on the screen but not
// in the bytes, whichever column the prompt (with the branch in it) puts the wrap at.
describe("telling a shell on a pty has drawn the line typed in", () => {
  const prompt = "you@esx-02 ~/w/app (main)> ";
  const line = `${"x".repeat(120 - prompt.length - 7)} printf '%s' end`;
  // On a 120-column screen "printf" ends the first row; fish moves over the space after it.
  const head = line.slice(0, line.indexOf(" '"));
  const drawn = `${prompt}${head}\r\n${ESC}[C'%s' end`;

  it("sees a line whose row ends where fish moves the cursor over a space", async () => {
    expect(head.length + prompt.length).toBe(120);
    expect(await drawnLine(drawn, prompt.length, line)).toBe(true);
  });

  it("waits for a line drawn only in part", async () => {
    expect(await drawnLine(`${prompt}${head}`, prompt.length, line)).toBe(false);
  });
});

describe.each(SHELLS.map((s) => [s.name, s] as const))("the hook line in %s", (_, shell) => {
  it.skipIf(missing(shell))("marks prompts, commands and their exit codes, and says the folder", { repeats: shell.name === "fish" ? 20 : 0, timeout: 1_200_000 }, async () => {
    const out = await runIn(shell, [hookLine(shell.kind, N), "false", "cd /tmp", "exit"]);
    expect(out, tail(out)).toContain(own("A"));
    expect(out, tail(out)).toContain(own("B"));
    expect(out, tail(out)).toContain(own("C"));
    expect(out, tail(out)).toContain(own("D;1"));
    expect(out, tail(out)).toContain(own("D;0"));
    expect(out, tail(out)).toMatch(new RegExp(`${ESC}\\]7;file://[^${BEL}]*/tmp${BEL}`));
  });
});

// #400: in a git checkout fish's prompt shows the branch, and the hook line wraps where that puts
// it: on main's CI (`runner@<host> /h/r/w/r/r/app (main)> `) it never saw the line drawn. With
// HOME at /tmp, `<tmp>/w/r/r/apps` shows as `~/r/w/r/r/apps`, as long as CI's checkout, so `main`
// here is that prompt. Whatever the branch, it marks.
const hasGit = has("git");
describe.each(["main", "dev", "fix/t211-a-long-branch-name"])("the hook line in fish, in a git checkout on %s", (branch) => {
  const fish = SHELLS.find((s) => s.name === "fish")!;
  it.skipIf(missing(fish) || !hasGit)("marks prompts, commands and their exit codes", { repeats: 20, timeout: 1_200_000 }, async () => {
    const repo = join(mkdtempSync(join(tmpdir(), "roster-shells-git-")), "w", "r", "r", "apps");
    mkdirSync(repo, { recursive: true });
    expect(spawnSync("git", ["init", "-q", "-b", branch], { cwd: repo, env: ENV }).status).toBe(0);
    const out = await runIn(fish, [hookLine("fish", N), "false", "cd /tmp", "exit"], repo);
    expect(out, tail(out)).toContain(`(${branch})`);
    for (const mark of ["A", "B", "C", "D;1", "D;0"]) expect(out, tail(out)).toContain(own(mark));
  });
});

// Ticket 159 (#296): the auto-send must see each shell's own idle prompt as it draws it (fish
// moves the cursor back over its prompt with `\r ESC[<n>C`), in a folder with no git and in this
// repo's checkout (fish's prompt then shows the branch, or `((f5c479ed))` on CI's detached HEAD).
// Every shell runs on a pty here, as in a Session. One whose prompt it doesn't see is killed at 40 s.
const REPO = new URL("../../..", import.meta.url).pathname;
describe.each(SHELLS.flatMap((s) => [[s.name, "/tmp", s] as const, [s.name, "a git checkout", s] as const]))(
  "promptShell at %s's first prompt, in %s",
  (_, where, shell) => {
    it.skipIf(!has(shell.name) || !hasPty)("knows the shell", async () => {
      let seen = false;
      const ready: Ready = (since, at) => {
        if (promptShell(at) !== shell.kind || (shell.pty && !shell.pty(since, at))) return false;
        seen = true;
        return true;
      };
      const out = await runPty(shell.argv, ["exit"], ready, where === "/tmp" ? "/tmp" : REPO);
      expect(seen, tail(out)).toBe(true);
    }, 60_000);
  },
);

/** The rc-file snippet for `lang` in docs/plugins.md's "Shell integration": its first block. */
function snippet(lang: string): string {
  const doc = readFileSync(new URL("../../../docs/plugins.md", import.meta.url), "utf8");
  const section = doc.slice(doc.indexOf("### Shell integration"));
  const m = section.match(new RegExp("```" + lang + "\\n([\\s\\S]*?)```"));
  if (!m?.[1]) throw new Error(`no ${lang} snippet in docs/plugins.md`);
  return m[1];
}

describe.each([
  ["bash", "bash"],
  ["zsh", "zsh"],
  ["fish", "fish"],
  ["pwsh", "powershell"],
])("the %s snippet in docs/plugins.md", (name, lang) => {
  const shell = SHELLS.find((s) => s.name === name)!;
  it.skipIf(missing(shell))("marks prompts, commands and their exit codes", async () => {
    // Typed in, as the rc file would run it: one line at a time. fish 4 writes some of these
    // marks itself, so each must come more often than without the snippet.
    const commands = ["false", "cd /tmp", "exit"];
    const lines = snippet(lang).trimEnd().split("\n");
    const out = await runIn(shell, [...lines, ...commands]);
    const bare = await runIn(shell, commands);
    const count = (text: string, mark: string) => text.split(`${ESC}]133;${mark}${BEL}`).length - 1;
    for (const mark of ["A", "B", "C", "D;1", "D;0"]) {
      expect(count(out, mark), `${mark}: ${tail(out)}`).toBeGreaterThan(count(bare, mark));
    }
  }, 120_000);
});

describe("the hook line in bash, set up as people have it", () => {
  const BASH = ["bash", "--norc", "--noprofile", "-i"];
  const count = (out: string, mark: string) => out.split(`${ESC}]133;${mark}`).length - 1;

  it("keeps marking prompts when a prompt framework sets PS1 again at every prompt", () => {
    const out = run(BASH, ['PROMPT_COMMAND=\'PS1="fw-\\$ "\'', hookLine("posix", N), "true", "true", "exit"]);
    expect(count(out, "A")).toBeGreaterThanOrEqual(3);
    expect(count(out, "B")).toBeGreaterThanOrEqual(3);
    expect(out).toContain(`${own("A")}fw-$ ${own("B")}`);
  });

  it("works under set -u, with no PS0 set", () => {
    const out = run(BASH, ["set -u", "unset PS0", hookLine("posix", N), "false", "exit"]);
    expect(out).not.toMatch(/unbound variable/);
    expect(out).toContain(own("C"));
    expect(out).toContain(own("D;1"));
  });

  it("leaves out the C mark in a bash older than 4.4, which has no PS0, and marks the rest", () => {
    const out = run(BASH, ["BASH_VERSION=4.3.48", hookLine("posix", N), "false", "exit"]);
    expect(out).not.toContain(`${ESC}]133;C`);
    expect(out).toContain(own("A"));
    expect(out).toContain(own("D;1"));
  });

  it("marks again with its token when the shell's own integration already marks the prompt", () => {
    // `:integrate` in a shell whose marks aren't roster's: roster's own go round them.
    const ps1 = "PS1=\"\\[$(printf '\\e]133;A\\a')\\]u\\$ \\[$(printf '\\e]133;B\\a')\\]\"";
    const out = run(BASH, [ps1, hookLine("posix", N), "true", "exit"]);
    expect(out).toContain(`${own("A")}${ESC}]133;A${BEL}u$ ${ESC}]133;B${BEL}${own("B")}`);
  });
});

describe("the POSIX hook line in a POSIX shell that isn't bash or zsh", () => {
  // bash in POSIX mode with its version variable unset stands in for dash or busybox ash.
  it("does nothing and says nothing", () => {
    const out = run(["bash", "--norc", "--noprofile", "--posix", "-i"], ["unset BASH_VERSION", hookLine("posix", N), "echo ok"]);
    expect(out).not.toContain(`${ESC}]133;`);
    expect(out).toContain("ok");
    expect(out).not.toMatch(/syntax error|not found|unexpected/i);
  });
});
