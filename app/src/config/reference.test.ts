// The option reference's data (generated from the core's shape table) and each option's value now
// and where it was set: what `:options` lists and `:help options` shows beside each entry.
import { describe, expect, it } from "vitest";
import { configWith, defaultConfig } from "./fixture";
import { optionRows, reference } from "./reference";

const row = (rows: ReturnType<typeof optionRows>, name: string) => rows.find((r) => r.name === name);

describe("the reference's data", () => {
  it("has every option with its type, default and description, and the roster table's names", () => {
    const entries = reference.sections.flatMap((s) => s.entries);
    const size = entries.find((e) => e.tag === "terminal.size");
    expect(size).toMatchObject({ what: "option", kind: "leaf", ty: "number|string", default: '"13pt"' });
    expect(size?.takes).toBe("6 to 72 px (4.5 to 54 pt)");
    expect(entries.find((e) => e.tag === "roster.keymap.set")?.heading).toBe("roster.keymap.set(context, keys, action)");
    expect(entries.find((e) => e.tag === "roster.config.Theme")?.what).toBe("type");
  });
});

describe("each option's value now and where it was set", () => {
  it("lists every option that holds a value, not the objects made of others", () => {
    const rows = optionRows(defaultConfig);
    expect(row(rows, "terminal.size")).toBeDefined();
    expect(row(rows, "terminal")).toBeUndefined();
    expect(row(rows, "colors")).toBeDefined();
    expect(row(rows, "modes.focus.sidebar")).toBeDefined();
  });

  it("gives the default and says default when init.lua doesn't set it", () => {
    expect(row(optionRows(defaultConfig), "leader")).toMatchObject({ value: '"Ctrl+Space"', default: '"Ctrl+Space"', where: "default" });
  });

  it("gives the file and line init.lua set it at", () => {
    const c = configWith({ leader: "Ctrl+b", set: ["leader"], lines: { leader: { file: "lua/keys.lua", line: 3 } } });
    expect(row(optionRows(c), "leader")).toMatchObject({ value: '"Ctrl+b"', where: "lua/keys.lua:3" });
    expect(row(optionRows(configWith({ set: ["vim"], vim: false })), "vim")).toMatchObject({ value: "false", where: "Config (line unknown)" });
  });

  it("says State for a choice the app keeps when init.lua leaves it", () => {
    expect(row(optionRows(defaultConfig, { hints: false }), "ui.hints")).toMatchObject({ value: "false", where: "State (:hints)" });
    expect(row(optionRows(defaultConfig, { theme: "nord" }), "theme")).toMatchObject({ value: '"nord"', where: "State (:theme)" });
  });

  it("writes a context's key bindings, and a mode's pieces, as init.lua would", () => {
    const c = configWith({ keys: [{ context: "leader", keys: "p", action: "connect esx-02" }, { context: "leader", keys: "x", action: null }] });
    expect(row(optionRows(c), "keys.leader")?.value).toBe('{ p = "connect esx-02", x = false }');
    expect(row(optionRows(defaultConfig), "keys.leader")?.value).toBe("{}");
    expect(row(optionRows(defaultConfig), "modes.focus.sidebar")?.value).toBe("false");
    expect(row(optionRows(defaultConfig), "modes.standard.sidebar")?.value).toBe('{ side = "left" }');
    expect(row(optionRows(defaultConfig), "modes.standard.statusbar")?.value).toBe("true");
    expect(row(optionRows(defaultConfig), "modes.standard.sessionbar")?.value).toBe("false");
  });
});
