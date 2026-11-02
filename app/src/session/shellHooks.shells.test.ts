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
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hookLine, type ShellKind } from "./shellHooks";

const has = (shell: string) => spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0;
const ENV = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/tmp", TERM: "xterm-256color", SHELL: "/bin/sh" };

/** Runs `argv` with `lines` piped in, one command a line; what it printed. */
function run(argv: string[], lines: string[]): string {
  const r = spawnSync(argv[0]!, argv.slice(1), {
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

/** Runs `argv` on a pty and types `lines`, each followed by Enter once the shell has been quiet
 * for a moment (as a person would: typed ahead, .NET's console can lose its cursor-position
 * answer), answering the terminal questions it asks; what it printed, once it exits (or after 20 s). */
function runPty(argv: string[], lines: string[]): Promise<string> {
  return new Promise((resolve) => {
    // A pty `script` makes from a pipe is 0 by 0, which PSReadLine divides by: give it a size.
    const command = `stty cols 120 rows 40 2>/dev/null; exec ${argv.map(quote).join(" ")}`;
    const child = spawn("script", ["-qfec", command, "/dev/null"], { env: ENV });
    let out = "";
    let answered = 0;
    const todo = [...lines];
    let idle: ReturnType<typeof setTimeout> | undefined;
    const typeSoon = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        const line = todo.shift();
        if (line === undefined) return;
        child.stdin.write(`${line}\r`);
        typeSoon();
      }, 300);
    };
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      out += d;
      const asks = out.match(ASK) ?? [];
      for (; answered < asks.length; answered++) child.stdin.write(asks[answered] === "\x1b[6n" ? "\x1b[1;1R" : "\x1b[?62;22c");
      typeSoon();
    });
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.stdin.on("error", () => {});
    child.on("close", () => {
      clearTimeout(timer);
      clearTimeout(idle);
      resolve(out);
    });
    typeSoon();
  });
}

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
  pty: boolean;
}
const SHELLS: Shell[] = [
  { name: "bash", argv: ["bash", "--norc", "--noprofile", "-i"], kind: "posix", pty: false },
  { name: "zsh", argv: ["zsh", "-f", "-i"], kind: "posix", pty: false },
  { name: "fish", argv: ["fish", "--no-config", "-i"], kind: "fish", pty: true },
  { name: "pwsh", argv: ["pwsh", "-NoProfile", "-NoLogo"], kind: "pwsh", pty: true },
];
const runIn = (s: Shell, lines: string[]) => (s.pty ? runPty(s.argv, lines) : Promise.resolve(run(s.argv, lines)));
const missing = (s: Shell) => !has(s.name) || (s.pty && !hasPty);

describe.each(SHELLS.map((s) => [s.name, s] as const))("the hook line in %s", (_, shell) => {
  it.skipIf(missing(shell))("marks prompts, commands and their exit codes, and says the folder", async () => {
    const out = await runIn(shell, [hookLine(shell.kind, N), "false", "cd /tmp", "exit"]);
    expect(out, tail(out)).toContain(own("A"));
    expect(out).toContain(own("B"));
    expect(out).toContain(own("C"));
    expect(out).toContain(own("D;1"));
    expect(out).toContain(own("D;0"));
    expect(out).toMatch(new RegExp(`${ESC}\\]7;file://[^${BEL}]*/tmp${BEL}`));
  }, 30_000);
});

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
  }, 60_000);
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
