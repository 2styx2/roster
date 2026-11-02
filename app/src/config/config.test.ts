// The Config (ticket 21) on the frontend: the typed object from the core is turned into the
// app's options and pushed through the registries (ADR 0006). The defaults come from the core's
// own fixture (crates/roster-core/tests/fixtures/config-defaults.json), so the Rust and TypeScript
// defaults can't drift apart.
import { describe, expect, it } from "vitest";
import { defaultOptions, keymapOf } from "../keymap";
import { builtinRegistries } from "../registries";
import { BUILTIN, CONFIG } from "../registry";
import { defaultTerminalOptions } from "../terminal/options";
import { defaultAppearance } from "../theme/theme";
import { rosterDark } from "../theme/themes";
import { defaultLayouts } from "../view/layout";
import { deriveConfig, normalizeChord, registerConfig } from "./apply";
import { configFixture, configWith, defaultConfig } from "./fixture";


const fixture = configFixture;

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe("the Config's defaults", () => {
  it("are the app's own defaults", () => {
    const d = deriveConfig(defaultConfig);
    expect(d.options).toEqual(defaultOptions);
    expect(d.appearance).toEqual(defaultAppearance);
    expect(d.terminalOptions).toEqual(defaultTerminalOptions);
    expect(d.layouts).toEqual(defaultLayouts(defaultOptions));
  });

  it("set the UI text size the whole type scale follows (fonts.ui_size)", () => {
    expect(deriveConfig(defaultConfig).appearance.fonts.size).toBe(15); // decision Q61
    const c = configWith({ fonts: { ...defaultConfig.fonts, uiSize: 16 } });
    expect(deriveConfig(c).appearance.fonts.size).toBe(16);
  });

  it("name the same colour tokens as the Themes", () => {
    expect(fixture.themeColors.map(camel)).toEqual(Object.keys(rosterDark.colors));
    expect(fixture.themeTerminal.map(camel)).toEqual(Object.keys(rosterDark.terminal));
  });

  it("make the terminal 13 pt (decision Q61): 13 × 96/72 px", () => {
    expect(defaultTerminalOptions.fontSize).toBeCloseTo(17.333, 3);
  });

  it("make the terminal medium weight, bold at 700", () => {
    expect(defaultTerminalOptions.fontWeight).toBe(500);
    expect(defaultTerminalOptions.fontWeightBold).toBe(700);
  });
});

describe("registering the Config", () => {
  it("binds its keys with source init.lua, and a reload brings the built-ins back", () => {
    const r = builtinRegistries();
    const config = configWith({
      keys: [
        { context: "leader", keys: "x", action: "close" },
        { context: "leader", keys: "f", action: "keys" },
        { context: "leader", keys: "d d", action: null },
      ],
      lines: {},
    });
    const { dispose, warnings } = registerConfig(r, config);
    expect(warnings).toEqual([]);
    const km = keymapOf(r.keymap.list());
    expect(km.leader.x).toEqual({ action: "close", source: CONFIG });
    expect(km.leader.f).toEqual({ action: "keys", source: CONFIG });
    expect(km.leader["d d"]).toBeUndefined();
    dispose();
    const back = keymapOf(r.keymap.list());
    expect(back.leader.f).toEqual({ action: "find", source: BUILTIN });
    expect(back.leader["d d"]).toEqual({ action: "close", source: BUILTIN });
    expect(back.leader.x).toBeUndefined();
  });

  it("skips a key bound to an unknown action, with a warning that has the line", () => {
    const r = builtinRegistries();
    const { warnings } = registerConfig(
      r,
      configWith({
        keys: [{ context: "leader", keys: "x", action: "explode" }],
        lines: { "keys.leader.x": { file: "init.lua", line: 7 } },
      }),
    );
    expect(warnings).toEqual([{ file: "init.lua", line: 7, message: 'key x (leader): no action named "explode"' }]);
    expect(keymapOf(r.keymap.list()).leader.x).toBeUndefined();
  });

  it("warns about a deprecated option, naming its replacement and its row in :help deprecated", () => {
    const { warnings } = registerConfig(
      builtinRegistries(),
      configWith({
        deprecated: [{ old: "terminal.font_size", new: "terminal.size", topic: "deprecated#terminalfont_size" }],
        lines: { "terminal.font_size": { file: "init.lua", line: 3 } },
      }),
    );
    expect(warnings).toEqual([
      { file: "init.lua", line: 3, message: "terminal.font_size is deprecated: use terminal.size (:help deprecated#terminalfont_size)" },
    ]);
  });

  it("binds the command line's and the Picker's Tab keys (keys.cmdline, ticket 34), and knows their actions", () => {
    const r = builtinRegistries();
    const { warnings } = registerConfig(
      r,
      configWith({
        keys: [
          { context: "cmdline", keys: "Ctrl+j", action: "cmdline.next" },
          { context: "cmdline", keys: "Tab", action: null },
          { context: "cmdline", keys: "Ctrl+x", action: "cmdline.explode" },
          { context: "picker", keys: "Ctrl+j", action: "picker.next" },
        ],
        lines: { "keys.cmdline.Ctrl+x": { file: "init.lua", line: 3 } },
      }),
    );
    expect(warnings).toEqual([{ file: "init.lua", line: 3, message: 'key Ctrl+x (cmdline): no action named "cmdline.explode"' }]);
    const km = keymapOf(r.keymap.list());
    expect(km.cmdline["Ctrl+j"]).toEqual({ action: "cmdline.next", source: CONFIG });
    expect(km.cmdline.Tab).toBeUndefined();
    expect(km.cmdline["Shift+Tab"]).toEqual({ action: "cmdline.prev", source: BUILTIN });
    expect(km.picker["Ctrl+j"]).toEqual({ action: "picker.next", source: CONFIG });
    expect(km.picker.Tab).toEqual({ action: "picker.next", source: BUILTIN });
  });

  it("knows every terminal action on every OS (Ctrl+V's terminal.pasteIfText is bound by default only on Windows)", () => {
    const r = builtinRegistries({ windows: false });
    const { warnings } = registerConfig(
      r,
      configWith({
        keys: [
          { context: "terminal", keys: "Ctrl+v", action: "terminal.pasteIfText" },
          { context: "terminal", keys: "Ctrl+b", action: "terminal.pasteIfTxt" },
          { context: "terminal", keys: "F2", action: "terminal.pasteIfText" },
        ],
        lines: { "keys.terminal.Ctrl+b": { file: "init.lua", line: 4 }, "keys.terminal.F2": { file: "init.lua", line: 5 } },
      }),
    );
    expect(warnings).toEqual([
      { file: "init.lua", line: 4, message: 'key Ctrl+b (terminal): no action named "terminal.pasteIfTxt"' },
      { file: "init.lua", line: 5, message: "key F2 (terminal): terminal.pasteIfText works only on Ctrl+v, the key the WebView pastes with (use terminal.paste)" },
    ]);
    expect(keymapOf(r.keymap.list()).terminal.F2).toBeUndefined();
    const km = keymapOf(r.keymap.list());
    expect(km.terminal["Ctrl+v"]).toEqual({ action: "terminal.pasteIfText", source: CONFIG });
    expect(km.terminal["Ctrl+b"]).toBeUndefined();
  });

  it("unbinds Windows' Ctrl+V paste with false (the program gets ^V)", () => {
    const r = builtinRegistries({ windows: true });
    expect(keymapOf(r.keymap.list()).terminal["Ctrl+v"]).toEqual({ action: "terminal.pasteIfText", source: BUILTIN });
    registerConfig(r, configWith({ keys: [{ context: "terminal", keys: "Ctrl+v", action: null }] }));
    expect(keymapOf(r.keymap.list()).terminal["Ctrl+v"]).toBeUndefined();
  });

  it("registers a Theme built on a bundled one, changing only the tokens it sets", () => {
    const r = builtinRegistries();
    registerConfig(
      r,
      configWith({
        theme: "mine",
        themes: { mine: { base: "nord", colors: { accent: "#ff8800" }, terminal: {}, ansi: "standard" } },
      }),
    );
    const mine = r.themes.get("mine");
    const nord = r.themes.get("nord");
    expect(mine?.source).toBe(CONFIG);
    expect(mine?.colors.accent).toBe("#ff8800");
    expect(mine?.colors.bg).toBe(nord?.colors.bg);
    expect(mine?.appearance).toBe(nord?.appearance);
    expect(mine?.ansi).toBeUndefined();
  });

  it("warns about a Theme option naming no Theme", () => {
    const { warnings } = registerConfig(builtinRegistries(), configWith({ theme: "solarized" }));
    expect(warnings[0]?.message).toMatch(/theme = "solarized": no such Theme/);
  });

  it("adds its Folders to the folders registry, read-only", () => {
    const r = builtinRegistries();
    const { dispose } = registerConfig(r, configWith({ folders: [{ name: "Lab ESXi", hosts: ["esxi-02"] }] }));
    expect(r.folders.list()).toEqual([{ id: "lab esxi", source: CONFIG, name: "Lab ESXi", hosts: ["esxi-02"] }]);
    dispose();
    expect(r.folders.list()).toEqual([]);
  });
});

describe("chords as people write them", () => {
  it.each([
    ["Ctrl+Space", "Ctrl+Space"],
    ["ctrl+space", "Ctrl+Space"],
    ["C-b", "Ctrl+b"],
    ["<C-a>", "Ctrl+a"],
    ["ctrl+B", "Ctrl+b"],
    ["alt+shift+x", "Alt+Shift+x"],
    ["F11", "F11"],
    ["x", "x"],
    ["G", "G"],
    ["esc", "Escape"],
  ])("%s → %s", (written, chord) => {
    expect(normalizeChord(written)).toBe(chord);
  });
});
