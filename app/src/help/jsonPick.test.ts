// @vitest-environment node
// scripts/help-plugin.mjs's `FILE.json?pick=a,b` (T213): each key becomes `export const KEY`, so a key
// that isn't a plain JS name says so plainly rather than as a parse error (#431's review, a nit).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jsonPick } from "../../scripts/help-plugin.mjs";

type Hook = (this: { addWatchFile(f: string): void }, id: string) => string | null;
const load = (id: string) => (jsonPick.load as unknown as Hook).call({ addWatchFile: () => {} }, id);
const resolve = (src: string, importer: string) => (jsonPick.resolveId as unknown as (s: string, i: string) => string | null)(src, importer);

describe("?pick=", () => {
  const dir = mkdtempSync(join(tmpdir(), "roster-pick-"));
  writeFileSync(join(dir, "api.json"), JSON.stringify({ tags: { a: "b" }, default: 1, "2x": 2, rest: [1] }));
  const id = (keys: string) => resolve(`./api.json?pick=${keys}`, join(dir, "x.ts")) as string;

  it("exports the keys asked for, and only those", () => {
    expect(load(id("tags"))).toBe('export const tags = {"a":"b"};');
  });

  it("refuses a key that isn't a JS name, or is a reserved word", () => {
    expect(() => load(id("default"))).toThrow(/default isn't a key \?pick= can export/);
    expect(() => load(id("2x"))).toThrow(/2x isn't a key \?pick= can export/);
  });

  it("refuses a key the file doesn't have", () => {
    expect(() => load(id("nope"))).toThrow(/has no key nope/);
  });
});
