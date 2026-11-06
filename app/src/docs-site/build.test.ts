// @vitest-environment node
// `npm run docs` builds the website under Node through Vite's module runner (scripts/vite-run.mjs),
// which loads modules differently from Vitest: a module the site imports that only works in a
// browser bundle (xterm.js through the PluginManager, 3158a233) breaks the website's build and no
// other check. So this runs that build itself, into a temp folder.
// Rule: docs/architecture.md, "The docs build runs under Node".
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("npm run docs", () => {
  it("builds the website under Node", () => {
    const out = mkdtempSync(join(tmpdir(), "roster-docs-"));
    try {
      try {
        execFileSync(process.execPath, ["scripts/vite-run.mjs", "scripts/gen-docs-site.ts", "--out", out, "--sha", "0000000"], {
          cwd: APP,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        const { stderr, stdout } = e as { stderr?: string; stdout?: string };
        throw new Error(
          `npm run docs failed (docs/architecture.md, "The docs build runs under Node": the docs site imports only what runs under Node):\n${stderr ?? ""}${stdout ?? ""}`,
          { cause: e },
        );
      }
      expect(existsSync(join(out, "index.html"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
