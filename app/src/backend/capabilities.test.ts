import { describe, expect, it } from "vitest";
import { capabilities, sinceOf } from "./capabilities";

describe("capabilities", () => {
  it("has a feature from its first API version on", () => {
    expect(capabilities({ api_version: sinceOf("edit") - 1 }).has("edit")).toBe(false);
    expect(capabilities({ api_version: sinceOf("edit") }).has("edit")).toBe(true);
  });

  it("knows nothing before serve is up", () => {
    const caps = capabilities(null);
    expect(caps.api).toBe(0);
    expect(caps.has("check")).toBe(false);
  });

  it("says what needs a newer roster, by its own name or the one given", () => {
    const caps = capabilities({ api_version: 3 });
    expect(caps.needsNewer("quickConnect")).toBe(`Quick Connect needs a newer roster (API version ${sinceOf("quickConnect")}; this one speaks 3)`);
    expect(caps.needsNewer("review", ":unreview")).toMatch(/^:unreview needs a newer roster/);
  });
});
