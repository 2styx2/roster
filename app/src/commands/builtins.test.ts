import { describe, expect, it } from "vitest";
import { defaultBindings } from "../keymap";
import { PLUGIN_COMMANDS, ROSTER_ONLY } from "../plugins/cmd";
import { builtinRegistries } from "../registries";
import { docsBuiltins, registerBuiltins } from "./builtins";

describe("the built-ins", () => {
  const r = builtinRegistries();
  registerBuiltins(r, docsBuiltins(r));

  it("every built-in key runs a built-in command", () => {
    const lines = [...Object.values(defaultBindings.leader), ...Object.values(defaultBindings.list), ...Object.values(defaultBindings.listVim), ...Object.values(defaultBindings.global)];
    expect(lines.filter((line) => !r.commands.get(line.split(" ")[0] ?? ""))).toEqual([]);
  });

  it("registers the same commands wherever they're registered (the app, the docs site, the lint)", () => {
    const ids = r.commands.list().map((c) => c.id);
    for (const id of ["help", "theme", "hints", "messages", "view", "panel", "plugins", "packages", "cancel", "tutor"]) expect(ids).toContain(id);
  });

  it("has every command the core lets a Plugin run, and every one it keeps for roster (plugin/api's COMMANDS, ROSTER_ONLY)", () => {
    // The core's tables name the app's commands by name, in Rust (plugin-api.json): one renamed or
    // dropped here leaves a rule there about nothing.
    const missing = [...PLUGIN_COMMANDS.map((c) => c.name), ...ROSTER_ONLY].filter((name) => !r.commands.get(name));
    expect(missing).toEqual([]);
  });
});
