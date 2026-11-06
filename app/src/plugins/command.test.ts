import { describe, expect, it } from "vitest";
import { pluginsLabel } from "./command";

describe(":plugins' titles (round 20)", () => {
  it("titles a Plugin's command line by the Plugin and its line", () => {
    expect(pluginsLabel("run folders folder add")).toBe("folders: folder add");
    expect(pluginsLabel("run folders folder remove HOST")).toBe("folders: folder remove HOST");
  });

  it("titles its other uses as before", () => {
    expect(pluginsLabel("revoke folders")).toBe("Plugins: revoke folders");
    expect(pluginsLabel("run folders")).toBe("Plugins: run folders");
  });
});
