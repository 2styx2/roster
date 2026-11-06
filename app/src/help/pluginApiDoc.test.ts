// `:help plugin-api` is written from plugin-api.json (T228, #438), so the help chunk carries the
// Plugin API once, as data, rather than as data and as plugin-api.md: what pluginApiDoc writes is, to
// the byte, the docs/plugin-api.md the Rust generator committed (crates/roster-core/src/plugin/api/
// `markdown`), which GitHub shows.
import { describe, expect, it } from "vitest";
import api from "../../../crates/roster-core/tests/fixtures/plugin-api.json";
import committed from "../../../docs/plugin-api.md?raw";
import { pluginApiDoc } from "./pluginApiDoc";

describe("pluginApiDoc", () => {
  it("writes the committed plugin-api.md from plugin-api.json", () => {
    expect(pluginApiDoc(api)).toBe(committed);
  });
});
