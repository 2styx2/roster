// The terminal looks like the user's Windows Terminal (ticket 33, decision Q55): `:info` names the
// installed font in use, and `:config import-terminal` shows what it would write into init.lua as
// a diff, writes it only on Enter, then sources it. The memory Platform stands in for the core
// (roster-core wt.rs has the settings.json parser and the diff's own tests). Fake Backend, stub
// terminal; Ctrl+Space is {Control>} {/Control}.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { configWith, defaultConfig } from "./config/fixture";
import type { Config, ConfigReport, ImportPreview } from "./config/types";
import { memoryPlatform } from "./platform/memory";
import type { Platform } from "./platform/types";
import { builtinRegistries } from "./registries";
import { StubTerminal, stubTerminalWith } from "./terminal/StubTerminal";
import type { TerminalViewComponent } from "./terminal/TerminalView";

const hosts = makeHosts(6);
const LEADER = "{Control>} {/Control}";
type User = ReturnType<typeof userEvent.setup>;

let reloads = 0;
const report = (config: Config): ConfigReport => ({ config, error: null, path: "C:\\Users\\me\\AppData\\Roaming\\roster\\init.lua", version: ++reloads });

const PREVIEW: ImportPreview = {
  settingsPath: "C:\\Users\\me\\AppData\\Local\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json",
  summary: ["Profile: Windows PowerShell", "Font: Iosevka Nerd Font, 16 pt (21.3 px)", "Colours: Imported → Theme wt-import", "Cursor: block"],
  diff: [
    { kind: "same", text: "-- mine" },
    { kind: "add", text: "-- >>> Windows Terminal >>> made by :config import-terminal" },
    { kind: "add", text: 'roster.o.terminal.size = "16pt"' },
    { kind: "add", text: "-- <<< Windows Terminal <<<" },
    { kind: "same", text: "return {" },
    { kind: "same", text: "  terminal = { size = 14 }," },
    { kind: "same", text: "}" },
  ],
  overridden: [{ option: "terminal.size", by: "returned", at: null }],
  created: false,
  base: "abc",
  result: "def",
  date: "2026-10-30",
  error: null,
  theme: "wt-import",
};

async function ready(opts: { config?: Config; platform?: Partial<Platform>; terminal?: TerminalViewComponent } = {}) {
  const user = userEvent.setup();
  const r = report(opts.config ?? defaultConfig);
  const memory = memoryPlatform({ config: r, importPreview: PREVIEW });
  const platform = Object.assign(memory, opts.platform ?? {});
  render(<App backend={fakeBackend({ hosts })} terminalView={opts.terminal ?? StubTerminal} registries={builtinRegistries()} platform={platform} config={r} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, platform: memory };
}

const command = async (user: User, line: string) => {
  await user.keyboard(`${LEADER}:`);
  await user.keyboard(`${line}{Enter}`);
};
const messageLine = () => document.querySelector(".message-line") as HTMLElement;

describe(":info and the terminal font", () => {
  it("names the first installed font of terminal.font, the size in px and the renderer", async () => {
    const { user } = await ready({
      config: configWith({ terminal: { ...defaultConfig.terminal, size: 64 / 3, renderer: "dom" } }),
      platform: { fontInstalled: (f) => f === "Iosevka Term" },
    });
    await command(user, "info");
    expect(messageLine()).toHaveTextContent("Terminal Iosevka Term 21.33 px, DOM");
  });

  it("is the bundled Iosevka when none of the installed ones is there", async () => {
    const { user } = await ready({ platform: { fontInstalled: () => false } });
    await command(user, "info");
    expect(messageLine()).toHaveTextContent("Terminal Iosevka 17.33 px, WebGL");
  });
});

// Ticket 20: on WebKitGTK, WSLg or a VM the WebGL context can fail to start or be lost. The
// terminal falls back to the DOM renderer, and `:info` says which renderer the visible one uses.
describe(":info and the renderer in use", () => {
  async function openSession(user: User) {
    await user.keyboard(`${LEADER}f`);
    await user.keyboard("{Enter}");
    await screen.findByRole("treeitem", { current: true });
  }

  it("says DOM, and why, when the terminal couldn't get a WebGL context", async () => {
    const { user } = await ready({ terminal: stubTerminalWith({ webgl: "fails" }), platform: { fontInstalled: () => false } });
    await openSession(user);
    expect(document.querySelector("[data-renderer]")).toHaveAttribute("data-renderer", "dom-unavailable");
    await command(user, "info");
    expect(messageLine()).toHaveTextContent("Terminal Iosevka 17.33 px, DOM (no WebGL here)");
  });

  it("says WebGL when the visible terminal got it", async () => {
    const { user } = await ready({ terminal: stubTerminalWith({ webgl: "works" }), platform: { fontInstalled: () => false } });
    await openSession(user);
    await command(user, "info");
    expect(messageLine()).toHaveTextContent("Terminal Iosevka 17.33 px, WebGL");
  });

  it("says DOM, and why, after the WebGL context was lost", async () => {
    const { user } = await ready({ terminal: stubTerminalWith({ webgl: "lost" }), platform: { fontInstalled: () => false } });
    await openSession(user);
    await command(user, "info");
    expect(messageLine()).toHaveTextContent("Terminal Iosevka 17.33 px, DOM (WebGL context lost)");
  });
});

describe(":info and the Picker's open time (decision Q86)", () => {
  it("says nothing about it until the Picker has opened, then gives the last time in ms", async () => {
    const { user } = await ready();
    await command(user, "info");
    expect(messageLine()).not.toHaveTextContent("Picker");
    await user.keyboard(`${LEADER}f`);
    await screen.findByRole("dialog", { name: /find a host/i });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await user.keyboard("{Escape}");
    await command(user, "info");
    expect(messageLine()).toHaveTextContent(/ · Picker opened in \d+ ms$/);
  });
});

describe(":config import-terminal", () => {
  it("shows the diff and what init.lua overrides, and writes nothing until Enter", async () => {
    const { user, platform } = await ready();
    await command(user, "config import-terminal");
    const dialog = await screen.findByRole("dialog", { name: "Import from Windows Terminal" });
    expect(dialog).toHaveTextContent("Font: Iosevka Nerd Font, 16 pt (21.3 px)");
    expect(within(dialog).getByText('roster.o.terminal.size = "16pt"').closest("[data-kind]")).toHaveAttribute("data-kind", "add");
    expect(dialog).toHaveTextContent("init.lua's returned table sets terminal.size, and it wins over the import");
    expect(platform.imported()).toEqual([]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Import from Windows Terminal" })).toBeNull();
    expect(platform.imported()).toEqual([]);
  });

  it("writes on Enter, against the file the preview read, sources it and chooses its Theme as :theme does", async () => {
    const { user, platform } = await ready();
    const imported = { base: "roster-dark", colors: {}, terminal: { background: "#0c0c0c" }, ansi: "inherit" as const };
    platform.writeConfig(report(configWith({ themes: { "wt-import": imported } })));
    await command(user, "config import-terminal");
    await screen.findByRole("dialog", { name: "Import from Windows Terminal" });
    await user.keyboard("{Enter}");
    expect(platform.imported()).toEqual([{ base: "abc", result: "def", date: "2026-10-30" }]);
    await screen.findByText("Wrote Windows Terminal's profile into init.lua, and applied it");
    expect(document.documentElement.dataset.theme).toBe("wt-import");
    expect(screen.queryByRole("dialog", { name: "Import from Windows Terminal" })).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(platform.saved()).toMatchObject({ theme: "wt-import", themeOver: null });
    // Not pinned: :theme still changes it.
    await command(user, "theme nord");
    expect(document.documentElement.dataset.theme).toBe("nord");
  });

  it("chooses its Theme over init.lua's own theme line, and says which line that is", async () => {
    const { user, platform } = await ready();
    const imported = { base: "roster-dark", colors: {}, terminal: { background: "#0c0c0c" }, ansi: "inherit" as const };
    platform.writeConfig(
      report(configWith({ theme: "nord", set: ["theme"], lines: { theme: { file: "init.lua", line: 2 } }, themes: { "wt-import": imported } })),
    );
    await command(user, "config import-terminal");
    await screen.findByRole("dialog", { name: "Import from Windows Terminal" });
    await user.keyboard("{Enter}");
    await screen.findByText(
      'Wrote Windows Terminal\'s profile into init.lua, and applied it. Theme wt-import. init.lua:2 also sets theme = "nord": this choice stays until that line changes. Delete the line to unpin it.',
    );
    expect(document.documentElement.dataset.theme).toBe("wt-import");
    await new Promise((r) => setTimeout(r, 0));
    expect(platform.saved()).toMatchObject({ theme: "wt-import", themeOver: "nord" });
  });

  it("says why when there's nothing to import", async () => {
    const { user, platform } = await ready();
    platform.failImport("import-terminal reads Windows Terminal's settings, so it works on Windows only");
    await command(user, "config import-terminal");
    await screen.findByText(/Can't import: import-terminal reads Windows Terminal's settings/);
  });
});
