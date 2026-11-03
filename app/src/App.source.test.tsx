// Neovim-style reloading (decision Q58): saving init.lua doesn't reload it unless the Config says
// `auto_reload = true`; `:source` (`:so`, `␣ S`, `:config reload`) reloads it now. A save that
// isn't applied shows a quiet hint in the status bar. A broken file keeps the last good Config.
// The memory Platform's `fileSaved` acts as the core's watcher (roster-core Loader::on_save, which
// has its own tests). Fake Backend, stub terminal; Ctrl+Space is {Control>} {/Control}.
import { describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { configWith, defaultConfig } from "./config/fixture";
import type { Config, ConfigError, ConfigReport } from "./config/types";
import { memoryPlatform, type MemoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(6);
const LEADER = "{Control>} {/Control}";
type User = ReturnType<typeof userEvent.setup>;

let reloads = 0;
const report = (config: Config, error: ConfigError | null = null): ConfigReport => ({
  config,
  error,
  path: "/home/me/.config/roster/init.lua",
  version: ++reloads,
});

async function ready(config: Config = defaultConfig) {
  const user = userEvent.setup();
  const r = report(config);
  const platform = memoryPlatform({ config: r });
  render(
    <App backend={fakeBackend({ hosts })} terminalView={StubTerminal} registries={builtinRegistries()} platform={platform} config={r} />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, platform };
}

const save = (platform: MemoryPlatform, r: ConfigReport) => act(() => platform.fileSaved(r));
const command = async (user: User, line: string) => {
  await user.keyboard(`${LEADER}:`);
  await user.keyboard(`${line}{Enter}`);
};
const theme = () => document.documentElement.dataset.theme;
const statusbar = () => document.querySelector(".statusbar") as HTMLElement;
const messageLine = () => document.querySelector(".message-line") as HTMLElement;

describe(":source", () => {
  it("a save doesn't reload by default; the status bar says so, and :source applies it", async () => {
    const { user, platform } = await ready();
    expect(theme()).toBe("roster-dark");
    await save(platform, report(configWith({ theme: "nord" })));
    expect(theme()).toBe("roster-dark");
    expect(within(statusbar()).getByText(/init\.lua changed/)).toBeInTheDocument();
    await command(user, "source");
    await screen.findByText("Reloaded init.lua");
    expect(theme()).toBe("nord");
    expect(within(statusbar()).queryByText(/init\.lua changed/)).toBeNull();
  });

  it("has the alias :so, :config reload, and the key ␣ S", async () => {
    const { user, platform } = await ready();
    await save(platform, report(configWith({ theme: "nord" })));
    await command(user, "so");
    await screen.findByText("Reloaded init.lua");
    expect(theme()).toBe("nord");
    await save(platform, report(configWith({ theme: "gruvbox" })));
    await command(user, "config reload");
    await screen.findByText(/Reloaded init\.lua/);
    expect(theme()).toBe("gruvbox");
    await save(platform, report(configWith({ theme: "tokyo-night" })));
    await user.keyboard(`${LEADER}S`);
    await screen.findByText(/Reloaded init\.lua/);
    expect(theme()).toBe("tokyo-night");
  });

  it("with auto_reload = true a save applies at once", async () => {
    const { platform } = await ready(configWith({ autoReload: true }));
    await save(platform, report(configWith({ autoReload: true, theme: "nord" })));
    expect(theme()).toBe("nord");
    expect(within(statusbar()).queryByText(/init\.lua changed/)).toBeNull();
  });

  it("an automatic reload leaves an error on the message line (#349): it says nothing there", async () => {
    const { user, platform } = await ready(configWith({ autoReload: true }));
    await command(user, "connect nope");
    expect(messageLine()).toHaveTextContent("No Host named nope");
    await save(platform, report(configWith({ autoReload: true, theme: "nord" })));
    expect(theme()).toBe("nord");
    expect(messageLine()).toHaveTextContent("No Host named nope");
  });

  it("a broken file keeps the last good Config and shows where", async () => {
    const { user, platform } = await ready(configWith({ theme: "nord" }));
    await save(
      platform,
      report(configWith({ theme: "nord" }), { file: "init.lua", line: 3, message: "unexpected symbol near '}'" }),
    );
    await command(user, "source");
    expect(await screen.findByRole("alert", { name: "Config problem" })).toHaveTextContent("init.lua:3");
    expect(theme()).toBe("nord");
  });

  it("takes a file: init.lua or one of its Lua modules, completes them, and refuses others", async () => {
    const { user, platform } = await ready();
    await save(platform, report(configWith({ theme: "nord" })));
    await command(user, "source lua/keys.lua");
    await screen.findByText("Reloaded init.lua");
    expect(theme()).toBe("nord");
    await command(user, "source notes.txt");
    expect(messageLine()).toHaveTextContent("Not a Config file: notes.txt (init.lua and its .lua modules)");
    await user.keyboard(`${LEADER}:`);
    await user.keyboard("source i{Tab}");
    expect(screen.getByRole("combobox")).toHaveValue("source init.lua");
  });
});
