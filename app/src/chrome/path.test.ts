import { describe, expect, it } from "vitest";
import { headPart } from "./path";

describe("the status bar's path head (round 18)", () => {
  it("keeps the first folder, so a cut path reads ~/…/roster.yml", () => {
    expect(headPart("~/team-inventory/roster.yml")).toBe("~/");
    expect(headPart("/home/someone/work/roster.yml")).toBe("/home/");
    expect(headPart("C:\\infra\\lab\\roster.yml")).toBe("C:\\");
    expect(headPart("~/roster.yml")).toBe("");
    expect(headPart("roster.yml")).toBe("");
  });
});
