import { describe, expect, it } from "vitest";
import { headPart, pathCuts } from "./path";

describe("the status bar's path head (round 18)", () => {
  it("keeps the first folder, so a cut path reads ~/…/roster.yml", () => {
    expect(headPart("~/team-inventory/roster.yml")).toBe("~/");
    expect(headPart("/home/someone/work/roster.yml")).toBe("/home/");
    expect(headPart("C:\\infra\\lab\\roster.yml")).toBe("C:\\");
    expect(headPart("~/roster.yml")).toBe("");
    expect(headPart("roster.yml")).toBe("");
  });
});

describe("a path's cut forms (round 20: whole folders, never inside one)", () => {
  it("drops whole folders for one …/, the folders nearest the file name last", () => {
    expect(pathCuts("/home/someone/work/infra/roster.yml")).toEqual([
      "/home/someone/work/infra/roster.yml",
      "/home/…/work/infra/roster.yml",
      "/home/…/infra/roster.yml",
      "/home/…/roster.yml",
      "…/roster.yml",
    ]);
  });

  it("reads ~/…/roster.yml, then …/roster.yml, with no gap and no cut folder", () => {
    const cuts = pathCuts("~/team-inventory/roster.yml");
    expect(cuts).toEqual(["~/team-inventory/roster.yml", "~/…/roster.yml", "…/roster.yml"]);
    for (const c of cuts.slice(1)) expect(c).not.toMatch(/…[^/\\]/);
  });

  it("keeps only forms shorter than the one before", () => {
    expect(pathCuts("~/a/roster.yml")).toEqual(["~/a/roster.yml", "…/roster.yml"]);
    expect(pathCuts("~/roster.yml")).toEqual(["~/roster.yml"]);
    expect(pathCuts("roster.yml")).toEqual(["roster.yml"]);
  });

  it("uses the path's own separator", () => {
    expect(pathCuts("C:\\infra\\lab\\roster.yml")).toEqual(["C:\\infra\\lab\\roster.yml", "C:\\…\\lab\\roster.yml", "C:\\…\\roster.yml", "…\\roster.yml"]);
  });
});
