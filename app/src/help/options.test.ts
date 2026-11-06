// `:help options`: each init.lua option's value in effect and where it came from.
import { describe, expect, it } from "vitest";
import { configWith, defaultConfig } from "../config/fixture";
import { reference } from "./reference";
import { leafPaths, luaValue, optionSource, optionValue } from "./options";

// The frontend's Config and the core's shape table can't drift apart: every value the core sends
// has its entry in the reference, and every option the reference lists is one the Config has.
describe("the options, from the core's shape table", () => {
  const names = reference.sections
    .flatMap((s) => s.entries)
    .filter((e) => e.what === "option")
    .map((e) => e.tag);

  it("documents every value of the frontend's Config, and nothing it doesn't have", () => {
    expect(names).toContain("terminal.size");
    const covered = (path: string) => names.some((n) => path === n || path.startsWith(`${n}.`));
    expect(leafPaths(defaultConfig).filter((p) => !covered(p))).toEqual([]);
    // The key bindings reach the frontend as one list (`keys`), not by context (`keys.leader`).
    const outside = names.filter(
      (n) => !n.includes("[]") && !n.startsWith("keys.") && optionValue(defaultConfig, n) === undefined,
    );
    expect(outside).toEqual([]);
  });
});

describe("an option's value and where it came from", () => {
  it("reads the value in effect, by its Lua name", () => {
    const c = configWith({ fonts: { ...defaultConfig.fonts, uiSize: 16 } });
    expect(optionValue(c, "fonts.ui_size")).toBe(16);
    expect(luaValue(optionValue(c, "terminal.font"))).toBe('{ "Iosevka Nerd Font", "Iosevka Term", "Iosevka" }');
    expect(luaValue(optionValue(defaultConfig, "ui.hints"))).toBe("unset");
    expect(luaValue(optionValue(defaultConfig, "terminal.size"))).toBe("17.33");
    expect(luaValue({ side: "left", shown: true })).toBe('{ side = "left", shown = true }');
  });

  it("says init.lua (and its line) for what the file set, even to the default value", () => {
    const c = configWith({ set: ["terminal.size", "vim"], lines: { vim: { file: "init.lua", line: 4 } } });
    expect(optionSource(c, "vim", {})).toEqual({ kind: "init.lua", at: { file: "init.lua", line: 4 } });
    expect(optionSource(c, "terminal.size", {})).toEqual({ kind: "init.lua" });
    expect(optionSource(c, "leader", {})).toEqual({ kind: "default" });
  });

  it("counts a table's values: modes.focus is set when modes.focus.sidebar is", () => {
    const c = configWith({ set: ["modes.focus.sidebar"] });
    expect(optionSource(c, "modes.focus").kind).toBe("init.lua");
    expect(optionSource(c, "modes.standard").kind).toBe("default");
  });

  it("says State for a choice the app keeps (:theme, :hints, :messages) when init.lua leaves it", () => {
    expect(optionSource(defaultConfig, "theme", { theme: "nord" })).toEqual({ kind: "State", value: "nord" });
    expect(optionSource(defaultConfig, "ui.hints", { hints: false })).toEqual({ kind: "State", value: false });
    expect(optionSource(defaultConfig, "ui.messages", { messages: "all" })).toEqual({ kind: "State", value: "all" });
    const set = configWith({ set: ["theme", "ui.hints", "ui.messages"], theme: "gruvbox", ui: { hints: true, messages: "quiet" } });
    expect(optionSource(set, "theme", { theme: null })).toEqual({ kind: "init.lua" });
    expect(optionSource(set, "ui.hints", { hints: false })).toEqual({ kind: "init.lua" });
    expect(optionSource(set, "ui.messages", { messages: "all" })).toEqual({ kind: "init.lua" });
  });

  it("says State for a :theme choice in effect over init.lua's theme, naming that line (decision Q69)", () => {
    const at = { file: "init.lua", line: 12 };
    const set = configWith({ set: ["theme"], theme: "gruvbox", lines: { theme: at } });
    expect(optionSource(set, "theme", { theme: "nord" })).toEqual({ kind: "State", value: "nord", over: at });
  });
});
