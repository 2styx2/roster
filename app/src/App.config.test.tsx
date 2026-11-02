// The Config (init.lua, ticket 21) through the App: the core's typed Config object arrives at
// start and again after every save (here, the memory Platform's saveConfig stands in for the
// core's `config-changed` event), and applies live through the registries and the options. A
// broken save shows its file and line, and the last good Config stays. Fake Backend, stub
// terminal; user-event writes Ctrl+Space as {Control>} {/Control}.
import { describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import type { FakePlugin } from "./backend/fakePlugins";
import { configWith, defaultConfig } from "./config/fixture";
import type { Config, ConfigError, ConfigReport } from "./config/types";
import { memoryPlatform, type MemoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(12);
const reviewed = hosts.hosts.filter((h) => h.reviewed).map((h) => h.name);
const [h0, h1] = reviewed as [string, string];
const LEADER = "{Control>} {/Control}";
const CTRL_B = "{Control>}b{/Control}";

type User = ReturnType<typeof userEvent.setup>;

/** The core numbers its reports, newest highest (each reload is one). */
let reloads = 0;
const report = (config: Config, error: ConfigError | null = null): ConfigReport => ({
  config,
  error,
  path: "/home/me/.config/roster/init.lua",
  version: ++reloads,
});

async function ready(config: Config = defaultConfig) {
  const user = userEvent.setup();
  const platform = memoryPlatform({ config: report(config) });
  render(
    <App
      backend={fakeBackend({ hosts })}
      terminalView={StubTerminal}
      registries={builtinRegistries()}
      platform={platform}
      config={report(config)}
    />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, platform };
}

/** What saving init.lua does: the core reloads it and the app gets the result. */
const save = (platform: MemoryPlatform, r: ConfigReport) => act(() => platform.saveConfig(r));

async function connect(user: User, name: string, leader = LEADER) {
  await user.keyboard(`${leader}f`);
  await user.keyboard(name);
  await user.keyboard("{Enter}");
  await within(output()).findByText(new RegExp(`Connected to ${name}`));
}

const output = () => screen.getByLabelText("terminal output", { selector: ":not([hidden]) > pre" });
const terminal = () => output().parentElement as HTMLElement;
const sessionList = () => screen.getByRole("group", { name: "Sessions" });
const row = (name: string) => within(sessionList()).getByRole("treeitem", { name: new RegExp(`^${name}`) });
const current = () => within(sessionList()).getByRole("treeitem", { current: true });
const root = () => document.documentElement;
const problem = () => screen.queryByRole("alert", { name: "Config problem" });

describe("Saving init.lua applies it live", () => {
  it("rebinds the Leader and a key, swaps the font and the Theme, and turns vim off", async () => {
    const { user, platform } = await ready();
    await connect(user, h0);
    await connect(user, h1);
    expect(terminal().dataset.font).toMatch(/^"Iosevka Nerd Font", "Iosevka Term", "Iosevka"/);
    expect(terminal().dataset.weight).toBe("500");
    expect(terminal().dataset.weightBold).toBe("700");
    // vim keys on: k moves up the list.
    await user.keyboard(`${LEADER}k`);
    expect(row(h0).closest("li")).toHaveClass("cursor");
    await user.keyboard("{Escape}");

    await save(
      platform,
      report(
        configWith({
          leader: "ctrl+b",
          vim: false,
          theme: "nord",
          keys: [{ context: "leader", keys: "t", action: "prev" }],
          terminal: { ...defaultConfig.terminal, font: ["JetBrains Mono"], size: 16, weight: 400 },
        }),
      ),
    );

    expect(terminal().dataset.font).toMatch(/^"JetBrains Mono", "Cascadia Mono"/);
    expect(terminal().dataset.weight).toBe("400");
    expect(terminal().dataset.size).toBe("16");
    expect(root().dataset.theme).toBe("nord");
    // The new Leader works, the old one goes to the terminal, and `t` is bound.
    expect(current()).toHaveAccessibleName(new RegExp(`^${h1}`));
    await user.keyboard(`${CTRL_B}t`);
    expect(current()).toHaveAccessibleName(new RegExp(`^${h0}`));
    await user.keyboard(LEADER);
    expect(screen.queryByText("APP")).toBeNull();
    // vim off: k is just a key.
    await user.keyboard(`${CTRL_B}j`);
    expect(row(h0).closest("li")).toHaveClass("cursor");
    await user.keyboard("{ArrowDown}");
    expect(row(h1).closest("li")).toHaveClass("cursor");
    expect(problem()).toBeNull();
  });

  it("shows init.lua's bindings in the Key bindings panel as coming from init.lua", async () => {
    const { user } = await ready(configWith({ keys: [{ context: "leader", keys: "t", action: "next" }] }));
    await user.keyboard(`${LEADER}K`);
    const panel = screen.getByRole("complementary", { name: "Key bindings" });
    const next = within(panel)
      .getAllByRole("row")
      .filter((r) => r.textContent?.includes("Next Session"));
    expect(next.map((r) => r.textContent)).toContainEqual(expect.stringMatching(/Next Session.*t.*init\.lua/));
  });

  it("defines a Theme as a table and overrides single tokens", async () => {
    const { platform } = await ready();
    await save(
      platform,
      report(
        configWith({
          theme: "mine",
          themes: { mine: { base: "roster-dark", colors: { accent: "#ff8800" }, terminal: { background: "#101010" }, ansi: "inherit" } },
          colors: { warn: "#ffcc00" },
        }),
      ),
    );
    expect(root().dataset.theme).toBe("mine");
    expect(root().style.getPropertyValue("--accent")).toBe("#ff8800");
    expect(root().style.getPropertyValue("--warn")).toBe("#ffcc00");
  });
});

describe("A broken init.lua", () => {
  it("shows the file and line, keeps the last good Config, and clears once fixed", async () => {
    const good = configWith({ leader: "Ctrl+b" });
    const { user, platform } = await ready(good);
    await connect(user, h0, CTRL_B);

    await save(platform, report(good, { file: "init.lua", line: 3, message: "unexpected symbol near ','" }));
    expect(problem()).toHaveTextContent("init.lua:3: unexpected symbol near ','");
    expect(problem()).toHaveTextContent(/last good Config is still in use/);
    await connect(user, h1, CTRL_B);

    await save(platform, report(good));
    expect(problem()).toBeNull();
  });

  it("can be closed until the next save", async () => {
    const { user, platform } = await ready();
    await save(platform, report(defaultConfig, { file: "init.lua", line: 1, message: "boom" }));
    await user.click(within(problem() as HTMLElement).getByRole("button", { name: "Close" }));
    expect(problem()).toBeNull();
    await save(platform, report(defaultConfig, { file: "init.lua", line: 2, message: "boom again" }));
    expect(problem()).toHaveTextContent("init.lua:2: boom again");
  });

  it("warns, with the line, about a key bound to an action that doesn't exist, and applies the rest", async () => {
    await ready(
      configWith({
        vim: false,
        keys: [{ context: "leader", keys: "x", action: "explode" }],
        lines: { "keys.leader.x": { file: "init.lua", line: 12 } },
      }),
    );
    expect(problem()).toHaveTextContent('init.lua:12: key x (leader): no action named "explode"');
  });
});

describe("Layout from init.lua (decision Q39)", () => {
  it("puts the Sidebar on the right, picks status segments, and shows Focus's session bar", async () => {
    const modes = structuredClone(defaultConfig.modes);
    modes.standard.sidebar = { shown: true, side: "right", sections: ["folders", "sessions"] };
    modes.standard.statusbar = { shown: true, segments: ["hosts"] };
    modes.focus.sessionbar = { shown: true, at: "bottom" };
    const { user } = await ready(configWith({ modes }));
    await connect(user, h0);
    expect(screen.getByRole("navigation", { name: "Sidebar" })).toHaveClass("side-right");
    const sections = within(screen.getByRole("navigation", { name: "Sidebar" }))
      .getAllByRole("group")
      .map((r) => r.getAttribute("aria-label"));
    expect(sections).toEqual(["Folders", "Sessions"]);
    expect(screen.getByText("12 Hosts")).toBeInTheDocument();
    expect(document.querySelector(".statusbar .backend")).toBeNull();
    await user.keyboard(`${LEADER}m`);
    expect(screen.getByRole("navigation", { name: "Session bar" })).toBeInTheDocument();
  });

  it("starts in the default_mode", async () => {
    await ready(configWith({ defaultMode: "focus" }));
    expect(document.querySelector(".screen.app")?.getAttribute("data-view")).toBe("focus");
  });
});

describe("Folders from init.lua (decision Q46)", () => {
  it("show first, marked, and can only be changed in init.lua", async () => {
    const { user } = await ready(configWith({ folders: [{ name: "Lab ESXi", hosts: [h0] }] }));
    const folders = screen.getByRole("group", { name: "Folders" });
    const head = within(folders).getByRole("treeitem", { name: /^Lab ESXi/ });
    expect(head).toHaveTextContent(/from init\.lua/);
    expect(within(folders).getByRole("treeitem", { name: new RegExp(`^${h0}`) })).toBeInTheDocument();
    expect(within(folders).queryByRole("button", { name: "Delete Folder Lab ESXi" })).toBeNull();
    await user.keyboard(`${LEADER}:folder delete Lab ESXi{Enter}`);
    expect(screen.getByRole("status")).toHaveTextContent("Lab ESXi is defined in init.lua: change it there");
    expect(within(folders).getByRole("treeitem", { name: /^Lab ESXi/ })).toBeInTheDocument();
  });
});

describe("A save while the app starts (review 2)", () => {
  it("isn't lost between the first config_load and the App listening for changes", async () => {
    const platform = memoryPlatform({ config: report(defaultConfig) });
    // main.tsx: load, then wait for fonts, then render: a save lands in between.
    const atStart = await platform.config?.load();
    platform.saveConfig(report(configWith({ theme: "nord" })));
    render(
      <App
        backend={fakeBackend({ hosts })}
        terminalView={StubTerminal}
        registries={builtinRegistries()}
        platform={platform}
        config={atStart ?? null}
      />,
    );
    await screen.findByLabelText(/master password/i);
    expect(root().dataset.theme).toBe("nord");
  });

  it("keeps the newest report when an older one arrives late", async () => {
    const platform = memoryPlatform({ config: report(defaultConfig) });
    const newer = report(configWith({ theme: "nord" }));
    render(
      <App
        backend={fakeBackend({ hosts })}
        terminalView={StubTerminal}
        registries={builtinRegistries()}
        platform={platform}
        config={newer}
      />,
    );
    await screen.findByLabelText(/master password/i);
    expect(root().dataset.theme).toBe("nord");
  });
});

// Ticket 79 (#137): Plugins load after the Config, so a layout naming a Plugin's section or
// segment was warned about as unknown. The names are judged once the Plugins have loaded.
describe("a layout that names a Plugin's pieces", () => {
  it("isn't warned about; a name nothing has still is", async () => {
    const modes = structuredClone(defaultConfig.modes);
    modes.standard.sidebar = { shown: true, side: "left", sections: ["sessions", "pins", "nosuch"] };
    modes.standard.statusbar = { shown: true, segments: ["hosts", "pin-count"] };
    const config = configWith({ modes });
    const user = userEvent.setup();
    const pins: FakePlugin = {
      manifest: { name: "pins", version: "1", description: "", author: null, api: 2, permissions: [] },
      load(roster) {
        roster.sidebar.set("pins", { title: "Pins", rows: [] });
        roster.status.set("pin-count", { text: "0 pins" });
      },
    };
    const platform = memoryPlatform({ config: report(config), state: { plugins: [{ path: "/p/pins", name: "pins", granted: [], asked: [] }] } });
    render(
      <App backend={fakeBackend({ hosts, plugins: { "/p/pins": pins } })} terminalView={StubTerminal} registries={builtinRegistries()} platform={platform} config={report(config)} />,
    );
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByText(/no section named "nosuch"/);
    expect(screen.queryByText(/no section named "pins"/)).toBeNull();
    expect(screen.queryByText(/no segment named "pin-count"/)).toBeNull();
  });
});
