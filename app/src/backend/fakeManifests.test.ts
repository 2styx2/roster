import { describe, expect, it } from "vitest";
import mesh from "../plugins/mesh.transcript.json";
import { FIRST_PARTY, manifestOf } from "./fakeManifests";

describe("the first-party Plugins' manifests, as the fakes read them", () => {
  it("reads a manifest's fields and its permissions, past comments", () => {
    const lua = `return {\n  name = "x", -- a name\n  version = "1.2.0",\n  description = "Says \\"hi\\"",\n  author = "roster",\n  api = 6,\n  permissions = {\n    "inventory.read", -- the Hosts\n    -- "serve:host.check",\n  },\n}\n`;
    expect(manifestOf(lua)).toEqual({ name: "x", version: "1.2.0", description: 'Says "hi"', author: "roster", api: 6, permissions: ["inventory.read"] });
  });

  it("asks what the real core granted the Plugin in its recorded run", () => {
    const load = (mesh.steps as { do: string; grants?: string[] }[]).find((s) => s.do === "load");
    expect(FIRST_PARTY.mesh.permissions).toEqual(load?.grants);
  });
});
