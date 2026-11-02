// The catalog covers docs/app/errors.md and every code roster's docs/serve-api.md lists.
import { describe, expect, it } from "vitest";
import { BackendCallError } from "../backend/types";
import { builtinErrorRegistry, builtinErrorRows, problemFromCallError, rowFor } from "./catalog";
import type { Problem } from "./classify";

const rows = builtinErrorRegistry().list();
const ROSTER_CODES = [1, 2, 3, 11, 12, 14, 20, 21, 22, 30, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 23];
const p = (code: Problem["code"]): Problem => ({ code, host: "esx", message: "m", details: "d" });

describe("the error catalog", () => {
  it("has a row for every one of docs/app/errors.md's 21 rows", () => {
    const covered = new Set(builtinErrorRows.map((r) => r.row));
    for (let n = 1; n <= 21; n++) expect(covered.has(n), `row ${n}`).toBe(true);
  });

  it("gives every roster code and the app's own a row with a place and a fix", () => {
    for (const code of [...ROSTER_CODES, "dropped", "closed-early", "backend-lost"] as const) {
      const row = rowFor(rows, code);
      expect(row.codes, String(code)).toContain(code);
      expect(row.where.length).toBeGreaterThan(0);
      expect(row.fix(p(code))).not.toBe("");
    }
  });

  it("gives a cancelled request and a check serve doesn't have their rows (rows 114-115, ticket 108)", () => {
    expect(rowFor(rows, 5).row).toBe(114);
    expect(rowFor(rows, 49).row).toBe(115);
    expect(rowFor(rows, 5).fix(p(5))).toContain("Nothing was done");
  });

  it("gives the host key question's own refusal its row (docs/app/errors.md row 62, ticket 36)", () => {
    const row = rowFor(rows, 23);
    expect(row.row).toBe(62);
    // Only Retry, which asks again with the new key: never an action that accepts one.
    expect(row.actions.map((a) => (a.kind === "run" ? a.line(p(23)) : a.label))).toEqual(["reconnect"]);
  });

  it("gives every vault.login code its sign-in row (docs/app/errors.md rows 22-33)", () => {
    const covered = new Set(builtinErrorRows.map((r) => r.row));
    for (let n = 22; n <= 33; n++) expect(covered.has(n), `row ${n}`).toBe(true);
    for (const code of [10, 13, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59]) {
      const row = rowFor(rows, code);
      expect(row.codes, String(code)).toContain(code);
      expect(row.id).toMatch(/^sign-in-/);
      expect(row.fix(p(code))).not.toBe("");
    }
    expect(rowFor(rows, 51).fix(p(51))).toMatch(/API key/);
    expect(rowFor(rows, 53).where).toContain("the network");
  });

  it("gives vault.logout's codes their rows (docs/app/errors.md rows 71-72, ticket 42)", () => {
    expect(rowFor(rows, 15).row).toBe(71);
    expect(rowFor(rows, 16).row).toBe(72);
    expect(rowFor(rows, 54).fix(p(54))).toMatch(/Use a different account/);
  });

  it("gives every editing code its row (docs/app/errors.md rows 38-43, ticket 10)", () => {
    const covered = new Set(builtinErrorRows.map((r) => r.row));
    for (let n = 38; n <= 43; n++) expect(covered.has(n), `row ${n}`).toBe(true);
    for (const code of [70, 71, 72, 73, 74, 75]) {
      const row = rowFor(rows, code);
      expect(row.codes, String(code)).toContain(code);
      expect(row.id).toMatch(/^edit-/);
      expect(row.fix(p(code))).not.toBe("");
    }
    expect(rowFor(rows, 72).where).toContain("the infra repo");
  });

  it("gives every publishing code its row (docs/app/errors.md rows 46-52, ticket 12)", () => {
    const covered = new Set(builtinErrorRows.map((r) => r.row));
    for (let n = 46; n <= 52; n++) expect(covered.has(n), `row ${n}`).toBe(true);
    for (const code of [90, 91, 92, 93, 94, 95, 96]) {
      const row = rowFor(rows, code);
      expect(row.codes, String(code)).toContain(code);
      expect(row.id).toMatch(/^publish-/);
      expect(row.fix(p(code))).not.toMatch(/force/i);
    }
    expect(rowFor(rows, 92).where).toContain("the infra repo");
  });

  it("gives Save to vault's own codes their rows (docs/app/errors.md rows 68-70, tickets 15 and 16)", () => {
    expect(rowFor(rows, 66)).toMatchObject({ row: 68, id: "save-not-logged-in" });
    expect(rowFor(rows, 67)).toMatchObject({ row: 69, id: "save-nothing-held" });
    expect(rowFor(rows, 67).fix(p(67))).toMatch(/Save to vault/);
    expect(rowFor(rows, 39)).toMatchObject({ row: 70, id: "save-password-needed" });
  });

  it("gives every Live Inventory code its row (docs/app/errors.md rows 53-56, ticket 28)", () => {
    const covered = new Set(builtinErrorRows.map((r) => r.row));
    for (let n = 53; n <= 56; n++) expect(covered.has(n), `row ${n}`).toBe(true);
    for (const code of [100, 101, 102, 103]) {
      const row = rowFor(rows, code);
      expect(row.codes, String(code)).toContain(code);
      expect(row.id).toMatch(/^live-/);
      expect(row.where).toContain("roster.yml");
    }
  });

  it("gives the Mesh's code its row (docs/app/errors.md row 73, ticket 39)", () => {
    expect(rowFor(rows, 110)).toMatchObject({ row: 73, id: "mesh-not-a-source" });
    expect(rowFor(rows, 110).where).toContain("roster.yml");
    expect(rowFor(rows, 111)).toMatchObject({ row: 93, id: "mesh-busy" });
  });

  it("gives the prompt fill's codes their rows (docs/app/errors.md rows 143-144, ticket 119)", () => {
    expect(rowFor(rows, 130)).toMatchObject({ row: 143, id: "fill-refused" });
    expect(rowFor(rows, 131)).toMatchObject({ row: 144, id: "fill-nothing-saved" });
    expect(rowFor(rows, 131).fix(p(131))).toMatch(/sudo: \{auth/);
  });

  it("puts git's own words from roster's data.details under Details", () => {
    const e = new BackendCallError("couldn't push", 96, { fix: "publish again", details: "! [remote rejected] main" });
    const problem = problemFromCallError("", e);
    expect(problem.details).toBe("[96] couldn't push\n\n! [remote rejected] main");
    expect(problem.data).toBeUndefined();
  });

  it("gives saving to the vault and adding a Host their rows (rows 34-37, 44-45, ticket 11)", () => {
    const covered = new Set(builtinErrorRows.map((r) => r.row));
    for (const n of [34, 35, 36, 37, 44, 45]) expect(covered.has(n), `row ${n}`).toBe(true);
    for (const code of [60, 61, 62, 63, 80, 81]) {
      const row = rowFor(rows, code);
      expect(row.codes, String(code)).toContain(code);
      expect(row.fix(p(code))).not.toBe("");
    }
    expect(rowFor(rows, 60).fix(p(60))).toMatch(/existing item|another name/);
    expect(rowFor(rows, 81).where).toContain("roster.yml");
  });

  it("gives where to save its rows (rows 58-59, ticket 35)", () => {
    const covered = new Set(builtinErrorRows.map((r) => r.row));
    for (const n of [58, 59]) expect(covered.has(n), `row ${n}`).toBe(true);
    expect(rowFor(rows, 64).where).toEqual(["roster.yml", "init.lua"]);
    expect(rowFor(rows, 64).fix(p(64))).toMatch(/setting|Save to/);
    expect(rowFor(rows, 65).where).toContain("the vault");
    expect(rowFor(rows, 65).fix(p(65))).toMatch(/write/);
  });

  it("never offers to accept a host key", () => {
    for (const row of builtinErrorRows) {
      for (const a of row.actions) {
        expect(a.label).not.toMatch(/accept|trust/i);
        if (a.kind === "run") expect(a.line(p(43))).not.toMatch(/accept|trust|yes/i);
      }
    }
  });

  it("lets a later registration (the Config, a Plugin) reword a row", () => {
    const registry = builtinErrorRegistry();
    const own = { ...rowFor(registry.list(), 41), source: "init.lua", fix: () => "Ask the lab channel." };
    registry.register(own);
    expect(rowFor(registry.list(), 41).fix(p(41))).toBe("Ask the lab channel.");
  });

  it("splits roster's fix from the rest of an error's data", () => {
    const e = new BackendCallError("no vault item named 'x'", 32, { fix: "rename it", near: ["x ssh"] });
    expect(problemFromCallError("esx", e)).toEqual({
      code: 32,
      host: "esx",
      message: "no vault item named 'x'",
      fix: "rename it",
      details: "[32] no vault item named 'x'",
      data: { near: ["x ssh"] },
    });
  });

  it("reports a lost roster serve as its own row (21)", () => {
    const e = new BackendCallError("The backend exited (code 1).", null, null, true);
    expect(rowFor(rows, problemFromCallError("esx", e).code).row).toBe(21);
  });
});
