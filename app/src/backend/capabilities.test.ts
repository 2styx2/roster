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
    // Calm, in the app's words; serve's API numbers only in what `:messages` keeps (round 20).
    expect(caps.needsNewer("quickConnect")).toEqual({
      kind: "slip",
      text: "Quick Connect needs a newer roster. Update roster on this Box.",
      logged: `Quick Connect needs a newer roster (API version ${sinceOf("quickConnect")}; this one speaks 3). Update roster on this Box.`,
    });
    expect(caps.needsNewer("review", ":unreview").text).toMatch(/^:unreview needs a newer roster/);
  });
});
