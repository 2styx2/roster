// `:help plugin-types` is made from plugin-api.json (T213, Q189) instead of bundling roster.lua as
// well: what luaStubs writes is, to the byte, the roster.lua the Rust generator committed
// (crates/roster-core/src/plugin/api.rs `stubs`), which lua-language-server and `:plugins types` use.
import { describe, expect, it } from "vitest";
import api from "../../../crates/roster-core/tests/fixtures/plugin-api.json";
import committed from "../../../examples/plugins/types/roster.lua?raw";
import { luaStubs } from "./luaStubs";

describe("luaStubs", () => {
  it("writes the committed roster.lua from plugin-api.json", () => {
    expect(luaStubs(api)).toBe(committed);
  });
});
