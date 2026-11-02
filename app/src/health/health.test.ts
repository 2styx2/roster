// The health sections (ticket 49): order, a section a newer roster sends, a section that throws.
import { describe, expect, it } from "vitest";
import { builtinHealthSections, healthSummary, runHealth, type HealthContext, type HealthSection } from "./health";

const ctx = (more: Partial<HealthContext> = {}): HealthContext => ({
  box: {
    checks: [
      { section: "vault", level: "ok", message: "bw: unlocked" },
      { section: "mesh", level: "warn", message: "a section this app doesn't know" },
    ],
    ok: true,
    roster_version: "0.1.0",
    api_version: 16,
  },
  boxProblem: null,
  backend: { name: "WSL: FedoraLinux-44", rosterVersion: "0.1.0", apiVersion: 16 },
  config: { path: null, error: null, warnings: [] },
  font: { families: ["Iosevka"], inUse: "Iosevka" },
  ...more,
});

describe("runHealth", () => {
  it("runs the sections in order, and puts one roster sends that nothing claims after roster's own", async () => {
    const ids = (await runHealth(builtinHealthSections, ctx())).map((r) => r.id);
    expect(ids).toEqual(["app", "roster", "inventory", "ssh", "vault", "askpass", "repo", "mesh", "config", "font"]);
  });

  it("says the WSL distro answers when serve runs in one", async () => {
    const app = (await runHealth(builtinHealthSections, ctx()))[0]!;
    expect(app.checks.map((c) => c.message)).toContain("the WSL distro answers (FedoraLinux-44)");
  });

  it("a section that throws is an error in that section only", async () => {
    const broken: HealthSection = { id: "x", source: "plug", title: "X", order: 1, checks: () => { throw new Error("boom"); } };
    const out = await runHealth([broken, ...builtinHealthSections], ctx());
    expect(out[0]!.checks).toEqual([{ section: "x", level: "error", message: "this section failed: boom" }]);
    expect(out.length).toBe(builtinHealthSections.length + 2);
  });

  it("warns when no terminal.font family is installed", async () => {
    const font = (await runHealth(builtinHealthSections, ctx({ font: { families: ["Nope Mono"], inUse: null } }))).at(-1)!;
    expect(font.checks[0]).toMatchObject({ level: "warn", topic: "terminal.font" });
  });

  it("a section that answers later is waited for, and one that doesn't answer in time is an error of its own", async () => {
    const later: HealthSection = { id: "later", source: "plug", title: "Later", order: 1, checks: async () => [{ section: "later", level: "ok", message: "fine" }] };
    const never: HealthSection = { id: "never", source: "plug", title: "Never", order: 2, checks: () => new Promise(() => undefined) };
    const out = await runHealth([later, never], ctx(), 20);
    expect(out[0]!.checks).toEqual([{ section: "later", level: "ok", message: "fine" }]);
    expect(out[1]!.checks).toEqual([{ section: "never", level: "error", message: "this section didn't answer within 0.02 seconds" }]);
  });

  it("sums up like Neovim's report", async () => {
    const results = await runHealth(builtinHealthSections, ctx());
    expect(healthSummary(results)).toBe("1 warning, no errors");
  });
});
