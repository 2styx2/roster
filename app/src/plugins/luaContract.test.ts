// @vitest-environment node
// The first-party Plugins (plugins/) are Lua, and read serve's answers the way a Plugin someone
// writes does: by the codes and job states docs/serve-api.md lists. Their literals are checked
// here against the contract serve generates (serveContract.ts), so a Plugin can't drift from it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Code, JOB_STATES, JsonRpcCode } from "../backend/serveContract";

const PLUGINS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins");
const CODES: Record<string, number> = { ...Code, ...JsonRpcCode };
const STATES: readonly string[] = [...JOB_STATES.running, ...JOB_STATES.over];

function lua(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return lua(p);
    return name.endsWith(".lua") ? [p] : [];
  });
}

const FILES = lua(PLUGINS).map((p) => ({ file: relative(PLUGINS, p), text: readFileSync(p, "utf8") }));

describe("the first-party Plugins' serve literals", () => {
  it("finds the Plugins", () => {
    expect(FILES.map((f) => f.file)).toContain("discover/init.lua");
  });

  it("names a serve code as the contract does, with its value", () => {
    const wrong: string[] = [];
    for (const { file, text } of FILES) {
      for (const [, name, value] of text.matchAll(/^local ([A-Z][A-Z_]+) = (-?\d+)\b/gm)) {
        if (name in CODES && CODES[name] !== Number(value)) wrong.push(`${file}: ${name} = ${value}, the contract says ${CODES[name]}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("compares an error's code with a named code, never a bare number", () => {
    const bare: string[] = [];
    for (const { file, text } of FILES) {
      for (const [line] of text.matchAll(/^.*model\.code\([^)]*\)\s*[~=]=\s*-?\d+.*$/gm)) bare.push(`${file}: ${line.trim()}`);
    }
    expect(bare).toEqual([]);
  });

  it("compares a job's state only with the job states serve has", () => {
    const unknown: string[] = [];
    for (const { file, text } of FILES) {
      for (const [, state] of text.matchAll(/\.state\s*[~=]=\s*"([^"]*)"/g)) {
        if (!STATES.includes(state)) unknown.push(`${file}: "${state}"`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
