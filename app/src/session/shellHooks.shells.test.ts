// @vitest-environment node
/// <reference types="node" />
// The hook lines in real shells: whichever of bash, zsh, fish and pwsh this machine has (CI's
// Ubuntu has bash; the others are skipped where they aren't installed). Each runs interactive,
// reads the hook line and a few commands on stdin, and must print the marks.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { hookLine } from "./shellHooks";

const has = (shell: string) => spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0;

function run(argv: string[], lines: string[]): string {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    input: lines.join("\n") + "\n",
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/tmp", TERM: "xterm-256color" },
  });
  return r.stdout + r.stderr;
}

const ESC = "\x1b";
const BEL = "\x07";
/** This Session's token: every mark roster's hook line makes carries it (ticket 120, Q131). */
const N = "0123456789abcdef01234567";
const own = (mark: string) => `${ESC}]133;${mark};roster=${N}${BEL}`;

describe.each([
  ["bash", ["bash", "--norc", "--noprofile", "-i"], "posix" as const],
  ["zsh", ["zsh", "-f", "-i"], "posix" as const],
  ["fish", ["fish", "--no-config", "-i"], "fish" as const],
])("the hook line in %s", (shell, argv, kind) => {
  it.skipIf(!has(shell))("marks prompts, commands and their exit codes, and says the folder", () => {
    const out = run(argv, [hookLine(kind, N), "false", "cd /tmp", "exit"]);
    expect(out).toContain(own("A"));
    expect(out).toContain(own("B"));
    expect(out).toContain(own("C"));
    expect(out).toContain(own("D;1"));
    expect(out).toContain(own("D;0"));
    expect(out).toMatch(new RegExp(`${ESC}\\]7;file://[^${BEL}]*/tmp${BEL}`));
  });
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
